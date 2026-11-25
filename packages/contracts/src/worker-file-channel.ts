import { closeSync, fstatSync, openSync, readSync, writeSync } from "node:fs";
import { ChannelError, MAX_CHANNEL_LINE_BYTES } from "./worker-channel.js";

/**
 * The worker channel carried over two files (card A03b, slice 4), for a worker that runs inside the native Windows container, where a pipe made inside the container hangs and standard handles are files.
 *
 * The controller's host keeps talking JSON lines over the pipes it gave the supervisor (the program outside the container). The supervisor copies those lines, one frame each, into an INBOX file the
 * worker reads, and copies the frames the worker appends to an OUTBOX file back onto the controller's pipe. Each file is append-only in practice (one writer: the supervisor for the inbox, the worker for
 * the outbox) and read with offsets by the other side; nothing but bytes crosses.
 *
 * A frame is one line: `<seq> <kind> <length>:<payload>\n`. `seq` counts the frames of one file from 1 without gaps; `length` is the payload's byte length, which makes a half-written frame (a reader that
 * got ahead of the writer, a writer that died) tell itself apart from a finished one. Kinds: `m` a worker-channel message (the payload is one JSON object, no line break), `a` an acknowledgement (outbox only: the
 * inbox frame number of the last message the worker has taken, which is the supervisor's flow control), `h` a heartbeat (inbox only: the supervisor is alive), `e` the end (no frame follows). Everything in
 * the outbox is untrusted data: the decoder bounds the size and count and fails on anything that does not fit, and nobody acts on a name or a handle in a payload here.
 */

export const FILE_CHANNEL_VERSION = 1;
export const FILE_CHANNEL_DEFAULTS = Object.freeze({
  /** The longest payload: a channel line. */
  maxPayload: MAX_CHANNEL_LINE_BYTES,
  /** Frames in one file, over the whole run. */
  maxFrames: 2_000_000,
  /** Bytes in one file, over the whole run (the hard cap; the disk limits of card A08c are separate). */
  maxBytes: 256 * 1024 * 1024,
  /** Bytes the supervisor lets the worker leave unread before it stops taking the controller's input. At least two lines, so one maximal line never waits on itself. */
  windowBytes: 2 * MAX_CHANNEL_LINE_BYTES,
  /** The supervisor writes a heartbeat after this long without another frame. */
  heartbeatMs: 5000,
  /** The worker ends its input with an error after this long without any frame (a supervisor that died stops its heartbeats). */
  stallMs: 60_000,
  pollMinMs: 2,
  pollMaxMs: 25,
});
export type FrameKind = "m" | "a" | "h" | "e";
export interface Frame { readonly seq: number; readonly kind: FrameKind; readonly payload: string }

export class FileChannelError extends ChannelError {
  constructor(message: string) { super(message); this.name = "FileChannelError"; }
}

/** The bytes of one frame. The payload may not contain a line break; `m` frames carry a JSON object; `a` a decimal number. */
export function encodeFrame(seq: number, kind: FrameKind, payload = ""): Buffer {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new FileChannelError("a frame number is a whole number from 1");
  if (/[\r\n]/.test(payload)) throw new FileChannelError("a frame payload is one line");
  const body = Buffer.from(payload, "utf8");
  return Buffer.concat([Buffer.from(`${seq} ${kind} ${body.length}:`, "ascii"), body, Buffer.from("\n", "ascii")]);
}

const HEADER = /^([1-9]\d{0,9}) ([maeh]) (0|[1-9]\d{0,7}):$/;
const MAX_HEADER_BYTES = 24;
const ACK = /^[1-9]\d{0,9}$/;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

export interface DecoderOptions {
  readonly maxPayload?: number;
  readonly maxFrames?: number;
  /** The kinds this side accepts (the supervisor reads `m`, `a`, `e` from the worker; the worker reads `m`, `h`, `e` from the supervisor). */
  readonly kinds: readonly FrameKind[];
}

/**
 * Reads frames from bytes in any chunking. Throws `FileChannelError` (and stays failed) on the first thing that is not a frame: a bad header, a number that is not the next one, a payload longer than the
 * bound or not valid UTF-8, a kind this side does not accept, a payload that does not fit its kind, a frame after the end, or more frames than the bound.
 */
export class FrameDecoder {
  #pending: Buffer = Buffer.alloc(0);
  #next = 1;
  #ended = false;
  #failed: FileChannelError | undefined;
  readonly #maxPayload: number;
  readonly #maxFrames: number;
  readonly #kinds: readonly FrameKind[];
  constructor(options: DecoderOptions) {
    this.#maxPayload = options.maxPayload ?? FILE_CHANNEL_DEFAULTS.maxPayload;
    this.#maxFrames = options.maxFrames ?? FILE_CHANNEL_DEFAULTS.maxFrames;
    this.#kinds = options.kinds;
  }
  /** Bytes of a frame that has begun and is not complete. */
  get pendingBytes(): number { return this.#pending.length; }
  /** Frames read so far. */
  get frames(): number { return this.#next - 1; }
  get ended(): boolean { return this.#ended; }

  #fail(message: string): never { this.#failed = new FileChannelError(message); throw this.#failed; }

  push(chunk: Buffer): Frame[] {
    if (this.#failed !== undefined) throw this.#failed;
    const out: Frame[] = [];
    let buffer = this.#pending.length === 0 ? chunk : Buffer.concat([this.#pending, chunk]);
    for (;;) {
      if (buffer.length === 0) break;
      const colon = buffer.subarray(0, MAX_HEADER_BYTES).indexOf(58);
      if (colon === -1) {
        if (buffer.length >= MAX_HEADER_BYTES) this.#fail("a frame does not begin with a header");
        break;
      }
      const m = HEADER.exec(buffer.subarray(0, colon + 1).toString("latin1"));
      if (m === null) this.#fail("a frame header is malformed");
      const seq = Number(m![1]);
      const kind = m![2] as FrameKind;
      const length = Number(m![3]);
      if (this.#ended) this.#fail("a frame follows the closing frame");
      if (seq !== this.#next) this.#fail(`frame number ${seq} where ${this.#next} was expected`);
      if (!this.#kinds.includes(kind)) this.#fail(`a frame of kind "${kind}" is not accepted from this side`);
      if (length > this.#maxPayload) this.#fail("a frame is longer than the channel allows");
      if (seq > this.#maxFrames) this.#fail("the channel carried more frames than it allows");
      const total = colon + 1 + length + 1;
      if (buffer.length < total) break;
      if (buffer[total - 1] !== 10) this.#fail("a frame does not end where its length says");
      let payload: string;
      try { payload = UTF8.decode(buffer.subarray(colon + 1, total - 1)); } catch { return this.#fail("a frame payload is not valid text"); }
      if (/[\r\n]/.test(payload)) this.#fail("a frame payload spans lines");
      if (kind === "m") {
        let value: unknown;
        try { value = JSON.parse(payload); } catch { return this.#fail("a message frame is not JSON"); }
        if (typeof value !== "object" || value === null || Array.isArray(value)) this.#fail("a message frame is not a JSON object");
      } else if (kind === "a") {
        if (!ACK.test(payload)) this.#fail("an acknowledgement is not a frame number");
      } else if (payload !== "") this.#fail("a frame of this kind carries no payload");
      out.push({ seq, kind, payload });
      this.#next++;
      if (kind === "e") this.#ended = true;
      buffer = buffer.subarray(total);
    }
    this.#pending = Buffer.from(buffer);
    if (this.#pending.length > this.#maxPayload + MAX_HEADER_BYTES + 1) this.#fail("a frame is longer than the channel allows");
    return out;
  }
}

/** The file calls the worker's end uses (the real ones are node's; tests give others). */
export interface WorkerFileOps {
  openRead(path: string): number;
  openAppend(path: string): number;
  /** Reads at most `buffer.length` bytes at `position`; 0 at the end. */
  read(fd: number, buffer: Buffer, position: number): number;
  write(fd: number, data: Buffer): void;
  size(fd: number): number;
  close(fd: number): void;
}
export const nodeWorkerFileOps: WorkerFileOps = {
  openRead: (path) => openSync(path, "r"),
  // Append mode: on Windows node asks for FILE_APPEND_DATA only, which is all the container's access to this file is meant to allow.
  openAppend: (path) => openSync(path, "a"),
  read: (fd, buffer, position) => readSync(fd, buffer, 0, buffer.length, position),
  write: (fd, data) => { let done = 0; while (done < data.length) done += writeSync(fd, data, done, data.length - done); },
  size: (fd) => fstatSync(fd).size,
  close: (fd) => { try { closeSync(fd); } catch { /* already closed */ } },
};

export interface WorkerFileChannelOptions {
  readonly inbox: string;
  readonly outbox: string;
  readonly maxPayload?: number;
  readonly maxBytes?: number;
  readonly pollMinMs?: number;
  readonly pollMaxMs?: number;
  readonly stallMs?: number;
  readonly ops?: WorkerFileOps;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface WorkerFileChannel {
  /** The controller's lines (the payload of each `m` frame, then a line break), in order, until the end frame. Throws `FileChannelError` when the supervisor's file is damaged or goes quiet for longer than the stall time. */
  readonly input: AsyncIterable<Buffer>;
  /** Sends one channel line (as `encodeMessage` makes it, with its closing line break). Throws when it does not fit. */
  write(text: string): void;
  /** Writes the end frame and closes both files. Safe to call more than once. */
  close(): void;
}

/** What the worker process uses in place of standard input and output (the in-container end). */
export function openWorkerFileChannel(options: WorkerFileChannelOptions): WorkerFileChannel {
  const ops = options.ops ?? nodeWorkerFileOps;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const maxPayload = options.maxPayload ?? FILE_CHANNEL_DEFAULTS.maxPayload;
  const maxBytes = options.maxBytes ?? FILE_CHANNEL_DEFAULTS.maxBytes;
  const pollMin = options.pollMinMs ?? FILE_CHANNEL_DEFAULTS.pollMinMs;
  const pollMax = options.pollMaxMs ?? FILE_CHANNEL_DEFAULTS.pollMaxMs;
  const stallMs = options.stallMs ?? FILE_CHANNEL_DEFAULTS.stallMs;
  let outFd: number | undefined;
  let inFd: number | undefined;
  let outSeq = 1;
  let written = 0;
  let closed = false;
  const append = (kind: FrameKind, payload: string): void => {
    outFd ??= ops.openAppend(options.outbox);
    const frame = encodeFrame(outSeq, kind, payload);
    if (written + frame.length > maxBytes) throw new FileChannelError("the channel's file is at its size limit");
    ops.write(outFd, frame);
    written += frame.length;
    outSeq++;
  };
  async function* lines(): AsyncGenerator<Buffer> {
    inFd = ops.openRead(options.inbox);
    const decoder = new FrameDecoder({ kinds: ["m", "h", "e"], maxPayload });
    const chunk = Buffer.alloc(256 * 1024);
    let position = 0;
    let delay = pollMin;
    let last = now();
    while (!closed) {
      const n = ops.read(inFd, chunk, position);
      if (n > 0) {
        position += n;
        delay = pollMin;
        last = now();
        let taken = 0;
        for (const f of decoder.push(Buffer.from(chunk.subarray(0, n)))) {
          if (f.kind === "e") { if (taken > 0) append("a", String(taken)); return; }
          if (f.kind === "m") { yield Buffer.from(`${f.payload}\n`, "utf8"); taken = f.seq; }
        }
        // The lines of this batch have been taken by the reader: the supervisor may send more.
        if (taken > 0) append("a", String(taken));
        continue;
      }
      if (ops.size(inFd) < position) throw new FileChannelError("the supervisor's file was cut short");
      if (now() - last > stallMs) throw new FileChannelError("the supervisor stopped writing to the channel");
      await sleep(delay);
      delay = Math.min(pollMax, delay * 2);
    }
  }
  return {
    input: lines(),
    write(text: string): void {
      if (closed) return;
      const line = text.endsWith("\n") ? text.slice(0, -1) : text;
      if (Buffer.byteLength(line, "utf8") > maxPayload) throw new FileChannelError("a message is longer than the channel allows");
      append("m", line);
    },
    close(): void {
      if (closed) return;
      try { append("e", ""); } catch { /* the supervisor treats a missing end as the worker ending */ }
      closed = true;
      if (outFd !== undefined) ops.close(outFd);
      if (inFd !== undefined) ops.close(inFd);
    },
  };
}

/** The environment variables that tell the worker process to use the files (set by the native backend for a streamed run; never by a recipe). */
export const FILE_CHANNEL_ENV = Object.freeze({
  inbox: "NIMBLENEWT_CHANNEL_INBOX",
  outbox: "NIMBLENEWT_CHANNEL_OUTBOX",
  maxBytes: "NIMBLENEWT_CHANNEL_MAX_BYTES",
  maxPayload: "NIMBLENEWT_CHANNEL_MAX_PAYLOAD",
  stallMs: "NIMBLENEWT_CHANNEL_STALL_MS",
});

const whole = (value: string | undefined): number | undefined => { const n = value === undefined ? Number.NaN : Number(value); return Number.isSafeInteger(n) && n >= 1 ? n : undefined; };

/** The channel the environment asks for, or undefined when it names none (the worker then uses standard input and output). Throws when it names an inbox without an outbox. */
export function workerFileChannelFromEnv(env: { readonly [name: string]: string | undefined }, ops?: WorkerFileOps): WorkerFileChannel | undefined {
  const inbox = env[FILE_CHANNEL_ENV.inbox];
  const outbox = env[FILE_CHANNEL_ENV.outbox];
  if (inbox === undefined && outbox === undefined) return undefined;
  if (inbox === undefined || inbox === "" || outbox === undefined || outbox === "") throw new FileChannelError("the environment names one file of the channel but not the other");
  const maxBytes = whole(env[FILE_CHANNEL_ENV.maxBytes]);
  const maxPayload = whole(env[FILE_CHANNEL_ENV.maxPayload]);
  const stallMs = whole(env[FILE_CHANNEL_ENV.stallMs]);
  return openWorkerFileChannel({ inbox, outbox, ...(maxBytes === undefined ? {} : { maxBytes }), ...(maxPayload === undefined ? {} : { maxPayload }), ...(stallMs === undefined ? {} : { stallMs }), ...(ops === undefined ? {} : { ops }) });
}
