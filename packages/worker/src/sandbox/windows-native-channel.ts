import { FILE_CHANNEL_DEFAULTS, FileChannelError, FrameDecoder, encodeFrame, type Frame } from "@nimblenewt/contracts";

/*
 * Card A03b, slice 4: the controller's channel across the container boundary on the native Windows backend.
 *
 * The worker process speaks JSON lines to the controller's host (card H12b). A program inside the container cannot be given a pipe (a pipe made inside it hangs), so the supervisor (the runner, outside the
 * container, holding the pipes the controller gave it) relays: the controller's lines go to the worker as frames appended to an INBOX file the worker polls, and the worker's frames, appended to an OUTBOX file,
 * are tailed here and written to the controller's pipe as lines. The framing, the size and count bounds and the worker's end are in `@nimblenewt/contracts` (worker-file-channel.ts).
 *
 * What the supervisor trusts: nothing the container writes. It creates both files itself BEFORE the program starts and keeps the handles it made, so a name the container later swaps for a link or another file
 * is never followed (it reads and writes the files it created, and a name that stopped leading to its file is a fault). It reads the outbox only at offsets it has chosen, within a hard size bound, through a
 * decoder that fails on the first frame that is not well formed, and it forwards only the payload of a well-formed `m` frame to the controller; it never opens, runs or acts on anything a frame names.
 */

/** One file of the channel, held open by the supervisor. */
export interface ChannelFile {
  size(): number;
  /** At most `max` bytes from `offset`. */
  read(offset: number, max: number): Buffer;
  /** Adds to the end of what this side has written. */
  append(data: Buffer): void;
  /** The name still leads to this very file, and it is a plain file with one name (not a link, not another file put in its place). */
  stillNamed(): boolean;
  close(): void;
}
export interface ChannelFs {
  /** Creates the file (it must not exist yet) and keeps it open; undefined when the name is taken. Throws when it cannot be made. */
  create(path: string): ChannelFile | undefined;
}

/** What the job file says about the channel (paths are the container's view, the same as the host's). Numbers are bounds, never trusted from the container. */
export interface ChannelJob {
  readonly dir: string;
  readonly inbox: string;
  readonly outbox: string;
  readonly maxBytes: number;
  readonly maxFrames: number;
  readonly maxPayload: number;
  readonly windowBytes: number;
  readonly heartbeatMs: number;
  readonly stallMs: number;
}

/** The runner's own ends: the controller's pipes. */
export interface ChannelPorts {
  readonly input: NodeJS.ReadableStream;
  /** Writes one line to the controller; resolves when it was taken (backpressure). Rejects when the controller's pipe is gone. */
  readonly output: { write(text: string): Promise<void> };
}

export interface ChannelStats {
  readonly framesToWorker: number;
  readonly framesFromWorker: number;
  readonly bytesToWorker: number;
  readonly bytesFromWorker: number;
  readonly workerEnded: boolean;
}
export interface ChannelEnd { readonly fault?: string; readonly note?: string; readonly stats: ChannelStats }

export interface RelayDeps {
  readonly inbox: ChannelFile;
  readonly outbox: ChannelFile;
  readonly ports: ChannelPorts;
  readonly limits: Pick<ChannelJob, "maxBytes" | "maxFrames" | "maxPayload" | "windowBytes" | "heartbeatMs">;
  /** Called once, with the reason, when the channel cannot go on: the caller ends the program. */
  readonly onFault: (reason: string) => void;
  readonly pollMinMs?: number;
  readonly pollMaxMs?: number;
}

const READ_CHUNK = 1024 * 1024;

export class ChannelRelay {
  readonly #d: RelayDeps;
  readonly #decoder: FrameDecoder;
  readonly #pollMin: number;
  readonly #pollMax: number;
  #offset = 0;
  #inSeq = 1;
  #inBytes = 0;
  #lastInboxWrite = Date.now();
  #inEnded = false;
  #unacked: { seq: number; bytes: number }[] = [];
  #unackedBytes = 0;
  #lastAck = 0;
  #paused = false;
  #line: Buffer = Buffer.alloc(0);
  #faulted: string | undefined;
  #stopping = false;
  #workerEnded = false;
  #framesFromWorker = 0;
  #bytesFromWorker = 0;
  #pump: Promise<void> | undefined;
  #wake: (() => void) | undefined;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #listeners: { event: string; fn: (...args: never[]) => void }[] = [];

  constructor(deps: RelayDeps) {
    this.#d = deps;
    this.#decoder = new FrameDecoder({ kinds: ["m", "a", "e"], maxPayload: deps.limits.maxPayload, maxFrames: deps.limits.maxFrames });
    this.#pollMin = deps.pollMinMs ?? FILE_CHANNEL_DEFAULTS.pollMinMs;
    this.#pollMax = deps.pollMaxMs ?? FILE_CHANNEL_DEFAULTS.pollMaxMs;
  }

  /** Begins relaying. */
  start(): void {
    const input = this.#d.ports.input;
    const on = (event: string, fn: (...args: never[]) => void): void => { input.on(event, fn as (...args: unknown[]) => void); this.#listeners.push({ event, fn }); };
    on("data", ((chunk: Buffer | string) => { this.#onData(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk); }) as (...args: never[]) => void);
    on("end", (() => { this.#endInput(); }) as (...args: never[]) => void);
    on("close", (() => { this.#endInput(); }) as (...args: never[]) => void);
    on("error", (() => { this.#endInput(); }) as (...args: never[]) => void);
    this.#heartbeat = setInterval(() => {
      if (this.#inEnded || this.#faulted !== undefined) return;
      if (Date.now() - this.#lastInboxWrite >= this.#d.limits.heartbeatMs) this.#writeInbox("h", "", 0);
    }, Math.max(1, Math.floor(this.#d.limits.heartbeatMs / 2)));
    this.#heartbeat.unref();
    this.#pump = this.#run();
  }

  /**
   * Ends the relay once the program has ended: the outbox is read to its end (nothing the worker managed to write is lost), then the files are let go. `orderly` is true when the program ended by itself with
   * exit code 0: a frame left half written then is a fault; after a kill, a timeout or a crash it is only dropped (the process died mid-write, which the exit already reports).
   */
  async finish(orderly: boolean): Promise<ChannelEnd> {
    this.#stopping = true;
    this.#wake?.();
    await this.#pump;
    this.#release();
    let note: string | undefined;
    if (this.#faulted === undefined) {
      if (this.#decoder.pendingBytes > 0) {
        if (orderly) this.#fault("the worker's output ends inside a frame");
        else note = "the worker's output ended inside a frame, which was dropped";
      } else if (!this.#workerEnded && orderly) note = "the worker ended without a closing frame";
    }
    return { ...(this.#faulted === undefined ? {} : { fault: this.#faulted }), ...(note === undefined ? {} : { note }), stats: { framesToWorker: this.#inSeq - 1, framesFromWorker: this.#framesFromWorker, bytesToWorker: this.#inBytes, bytesFromWorker: this.#bytesFromWorker, workerEnded: this.#workerEnded } };
  }

  #release(): void {
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    const input = this.#d.ports.input;
    for (const l of this.#listeners.splice(0)) input.removeListener(l.event, l.fn as (...args: unknown[]) => void);
    // Errors after the relay let go are no one's business here, but an unhandled one would end the runner.
    input.on("error", () => undefined);
    input.pause();
    const destroy = (input as { destroy?: () => void }).destroy;
    if (typeof destroy === "function") { try { destroy.call(input); } catch { /* already gone */ } }
  }

  #fault(reason: string): void {
    if (this.#faulted !== undefined) return;
    this.#faulted = reason;
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    this.#wake?.();
    try { this.#d.onFault(reason); } catch { /* the caller's end of the abort */ }
  }

  // ---- the controller's lines into the inbox ----

  #writeInbox(kind: "m" | "h" | "e", payload: string, bytesCounted: number): void {
    if (this.#inSeq > this.#d.limits.maxFrames) return this.#fault("the controller sent more frames than the channel allows");
    const frame = encodeFrame(this.#inSeq, kind, payload);
    if (this.#inBytes + frame.length > this.#d.limits.maxBytes) return this.#fault("the controller sent more than the channel's file may hold");
    try { this.#d.inbox.append(frame); } catch (error) { return this.#fault(`the worker's input file could not be written: ${(error as Error).message}`); }
    this.#inBytes += frame.length;
    this.#lastInboxWrite = Date.now();
    if (kind === "m") {
      this.#unacked.push({ seq: this.#inSeq, bytes: bytesCounted });
      this.#unackedBytes += bytesCounted;
      if (this.#unackedBytes >= this.#d.limits.windowBytes && !this.#paused) { this.#paused = true; this.#d.ports.input.pause(); }
    }
    this.#inSeq++;
  }

  #onData(chunk: Buffer): void {
    if (this.#faulted !== undefined || this.#inEnded) return;
    let buffer = this.#line.length === 0 ? chunk : Buffer.concat([this.#line, chunk]);
    for (let end = buffer.indexOf(10); end !== -1; end = buffer.indexOf(10)) {
      const line = buffer.subarray(0, end);
      buffer = buffer.subarray(end + 1);
      if (line.length === 0) continue;
      if (line.length > this.#d.limits.maxPayload) return this.#fault("the controller sent a line longer than the channel allows");
      try { this.#writeInbox("m", line.toString("utf8"), line.length + 1); } catch (error) { return this.#fault(`the controller sent a line the channel cannot carry: ${(error as Error).message}`); }
      if (this.#faulted !== undefined) return;
    }
    if (buffer.length > this.#d.limits.maxPayload) return this.#fault("the controller sent a line longer than the channel allows");
    this.#line = Buffer.from(buffer);
  }

  #endInput(): void {
    if (this.#inEnded || this.#faulted !== undefined) return;
    this.#writeInbox("e", "", 0);
    this.#inEnded = true;
  }

  // ---- the worker's frames from the outbox ----

  #sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.#wake = undefined; resolve(); }, ms);
      this.#wake = () => { clearTimeout(timer); this.#wake = undefined; resolve(); };
    });
  }

  async #run(): Promise<void> {
    let delay = this.#pollMin;
    for (;;) {
      if (this.#faulted !== undefined) return;
      const stopping = this.#stopping; // read before the pass: a pass that starts after the program ended reads to the end
      let progressed = false;
      try {
        const outbox = this.#d.outbox;
        if (!stopping && !outbox.stillNamed()) return this.#fault("the worker's output file was replaced or removed");
        const size = outbox.size();
        if (size < this.#offset) return this.#fault("the worker's output file was cut short");
        if (size > this.#d.limits.maxBytes) return this.#fault("the worker's output file is larger than the channel allows");
        if (size > this.#offset) {
          const chunk = outbox.read(this.#offset, Math.min(size - this.#offset, READ_CHUNK));
          this.#offset += chunk.length;
          this.#bytesFromWorker += chunk.length;
          progressed = chunk.length > 0;
          for (const f of this.#decoder.push(chunk)) { await this.#frame(f); if (this.#faulted !== undefined) return; }
        }
      } catch (error) {
        if (error instanceof FileChannelError) return this.#fault(`the worker broke the channel: ${error.message}`);
        return this.#fault(`the worker's output could not be relayed: ${(error as Error).message}`);
      }
      if (progressed) { delay = this.#pollMin; continue; }
      if (stopping) return;
      await this.#sleep(delay);
      delay = Math.min(this.#pollMax, delay * 2);
    }
  }

  async #frame(f: Frame): Promise<void> {
    this.#framesFromWorker++;
    if (f.kind === "m") { await this.#d.ports.output.write(`${f.payload}\n`); return; }
    if (f.kind === "e") { this.#workerEnded = true; return; }
    const ack = Number(f.payload);
    const at = this.#unacked.findIndex((u) => u.seq === ack);
    if (ack <= this.#lastAck || at === -1) throw new FileChannelError("an acknowledgement names a message that is not waiting");
    for (const u of this.#unacked.splice(0, at + 1)) this.#unackedBytes -= u.bytes;
    this.#lastAck = ack;
    if (this.#paused && this.#unackedBytes < this.#d.limits.windowBytes) { this.#paused = false; this.#d.ports.input.resume(); }
  }
}
