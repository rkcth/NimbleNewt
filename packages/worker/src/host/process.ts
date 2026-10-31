import { ChannelError, LineDecoder, WORKER_CHANNEL_VERSION, encodeMessage, parseFromChild, type BridgeReplyMessage, type ChannelStart, type FromChild, type HeaderList, type ToChild } from "@nimblenewt/contracts";
import type { LimitEnforcement } from "../sandbox/limits.js";
import type { LaunchRequest, RunResult, SandboxLauncher, SandboxRun } from "../sandbox/launcher.js";

/**
 * The host's end of the channel to one worker process (card H12b). It reads the process's lines, answers its bridge requests and model calls through the functions the composer gave it, and turns the process's replies into promises. Nothing the process
 * sends is trusted: a line that does not parse ends the process; a request over the in-flight limits is refused; the credential the process presents is passed on for the controller to check, never replaced or vouched for here.
 */

export interface RelayRequest { readonly url: string; readonly method: string; readonly headers: HeaderList; readonly body: Uint8Array | undefined; readonly signal: AbortSignal }
export interface RelayResponse { readonly status: number; readonly statusText: string; readonly headers: HeaderList; readonly body: AsyncIterable<Uint8Array> | null }

export interface ProcessHandlers {
  /** Answers one bridge request of the process (the controller's execution service, bound to the attempt). */
  bridge(token: string, request: { readonly op: string; readonly callId: string; readonly args?: { readonly [key: string]: unknown } }): Promise<BridgeReplyMessage>;
  /** Makes one model call for the process. It may refuse by throwing; the message goes to the process as the failure of its call. */
  relay(request: RelayRequest): Promise<RelayResponse>;
}

export const PROCESS_LIMITS = { bridgeInFlight: 16, fetchInFlight: 8, pendingWriteBytes: 4 * 1024 * 1024, refusals: 64, chunkBytes: 256 * 1024, readyMs: 60_000, closeGraceMs: 3000 } as const;

interface Waiter<T> { readonly resolve: (value: T) => void; readonly reject: (error: Error) => void }
type Result = Extract<FromChild, { t: "result" }>;
const message = (error: unknown): string => String((error as Error)?.message ?? error).slice(0, 1000);

export class WorkerProcess {
  #run!: SandboxRun;
  readonly #handlers: ProcessHandlers;
  readonly #decoder = new LineDecoder();
  readonly #readyWaiters: Waiter<void>[] = [];
  #isReady = false;
  #info: { toolSchemaChars?: number; systemPromptChars?: number } = {};
  #resultWaiter: Waiter<Result> | undefined;
  readonly #asked = new Map<number, Waiter<FromChild>>();
  readonly #fetches = new Map<number, AbortController>();
  #bridges = 0;
  #pendingBytes = 0;
  #refused = 0;
  #next = 0;
  #endedWith: Error | undefined;
  #exit: RunResult | undefined;
  #leaseLost: string | undefined;
  readonly #leaseWaiters: ((reason: string) => void)[] = [];

  private constructor(handlers: ProcessHandlers) { this.#handlers = handlers; }

  /** Starts the process in the sandbox. `request` is the launch without its stream, which is this class's. */
  static async launch(launcher: Pick<SandboxLauncher, "launch">, request: Omit<LaunchRequest, "stream" | "stdin">, handlers: ProcessHandlers): Promise<WorkerProcess> {
    const process = new WorkerProcess(handlers);
    process.#run = await launcher.launch({ ...request, stream: { onStdout: (chunk) => process.#onStdout(chunk) } });
    void process.#run.result.then((result) => {
      process.#exit = result;
      const tail = result.stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 400);
      process.#end(new Error(`the worker process ended (${result.timedOut ? "time limit" : result.killed ? "stopped" : result.exitCode === null ? `signal ${String(result.signal)}` : `exit code ${result.exitCode}`})${tail === "" ? "" : `: ${tail}`}`));
    });
    return process;
  }

  /** How each limit was applied to this process (empty when none was asked for). */
  get enforcement(): readonly LimitEnforcement[] { return this.#run.enforcement ?? []; }

  get exited(): Promise<RunResult> { return this.#run.result; }
  get stderrTail(): string { return this.#exit?.stderr.trim().split("\n").slice(-5).join(" | ").slice(0, 500) ?? ""; }

  /** Ends the channel: everything waiting fails with `why`, and the process is stopped if it is still there. */
  #end(why: Error): void {
    if (this.#endedWith !== undefined) return;
    this.#endedWith = why;
    for (const w of this.#readyWaiters.splice(0)) w.reject(why);
    this.#resultWaiter?.reject(why);
    this.#resultWaiter = undefined;
    for (const w of this.#asked.values()) w.reject(why);
    this.#asked.clear();
    for (const c of this.#fetches.values()) c.abort();
    this.#fetches.clear();
  }

  /** Kills the process now (a protocol breach, a stop). */
  kill(why: string): void { this.#end(new Error(why)); this.#run.kill(); }

  async #send(m: ToChild): Promise<void> {
    if (this.#endedWith !== undefined) return;
    const text = encodeMessage(m);
    // A process that does not read what it is sent must not make the host hold it all: past the bound it is stopped.
    if (this.#pendingBytes + text.length > PROCESS_LIMITS.pendingWriteBytes) return this.kill("the worker process is not reading the channel");
    this.#pendingBytes += text.length;
    try { await this.#run.write(text); } catch (error) { this.#end(new Error(`the worker process cannot be written to: ${message(error)}`)); } finally { this.#pendingBytes -= text.length; }
  }

  #onStdout(chunk: Buffer): void {
    if (this.#endedWith !== undefined) return;
    try {
      for (const raw of this.#decoder.push(chunk)) this.#onMessage(parseFromChild(raw));
    } catch (error) {
      if (error instanceof ChannelError) this.kill(`the worker process broke the channel: ${error.message}`);
      else throw error;
    }
  }

  #onMessage(m: FromChild): void {
    switch (m.t) {
      case "ready":
        if (m.v !== WORKER_CHANNEL_VERSION) return this.kill(`the worker process speaks channel version ${m.v}, not ${WORKER_CHANNEL_VERSION}`);
        this.#isReady = true;
        this.#info = { ...(m.toolSchemaChars === undefined ? {} : { toolSchemaChars: m.toolSchemaChars }), ...(m.systemPromptChars === undefined ? {} : { systemPromptChars: m.systemPromptChars }) };
        for (const w of this.#readyWaiters.splice(0)) w.resolve();
        return;
      case "result": { const w = this.#resultWaiter; this.#resultWaiter = undefined; w?.resolve(m); return; }
      case "lease.lost": if (this.#leaseLost === undefined) { this.#leaseLost = m.reason; for (const w of this.#leaseWaiters.splice(0)) w(m.reason); } return;
      case "checkpoint.ok": case "tell.ok": case "compact.ok": { const w = this.#asked.get(m.id); this.#asked.delete(m.id); w?.resolve(m); return; }
      case "fault": {
        if (m.id !== undefined) { const w = this.#asked.get(m.id); this.#asked.delete(m.id); w?.reject(new Error(m.message)); return; }
        // A fault with no request is the process saying it cannot start or go on; the start waits on it, a running turn fails with it.
        const why = new Error(m.message);
        for (const w of this.#readyWaiters.splice(0)) w.reject(why);
        if (this.#resultWaiter !== undefined) { const w = this.#resultWaiter; this.#resultWaiter = undefined; w.reject(why); }
        return;
      }
      case "bridge": void this.#bridge(m); return;
      case "fetch": void this.#fetch(m); return;
      case "fetch.abort": this.#fetches.get(m.id)?.abort(); return;
    }
  }

  /** A process that keeps asking past its limits is broken or hostile. */
  #refuse(): void { if (++this.#refused > PROCESS_LIMITS.refusals) this.kill("the worker process keeps sending more requests than it may"); }

  async #bridge(m: Extract<FromChild, { t: "bridge" }>): Promise<void> {
    let reply: BridgeReplyMessage;
    if (this.#bridges >= PROCESS_LIMITS.bridgeInFlight) this.#refuse();
    if (this.#bridges >= PROCESS_LIMITS.bridgeInFlight) reply = { ok: false, code: "unavailable", message: "too many requests are waiting; try again" };
    else {
      this.#bridges++;
      try { reply = await this.#handlers.bridge(m.token, m.request); } catch { reply = { ok: false, code: "internal", message: "the request could not be handled" }; } finally { this.#bridges--; }
    }
    await this.#send({ t: "bridge.reply", id: m.id, reply });
  }

  async #fetch(m: Extract<FromChild, { t: "fetch" }>): Promise<void> {
    if (this.#fetches.size >= PROCESS_LIMITS.fetchInFlight || this.#fetches.has(m.id)) this.#refuse();
    if (this.#fetches.size >= PROCESS_LIMITS.fetchInFlight || this.#fetches.has(m.id)) return void (await this.#send({ t: "fetch.error", id: m.id, message: "too many model calls are in flight" }));
    const abort = new AbortController();
    this.#fetches.set(m.id, abort);
    try {
      const response = await this.#handlers.relay({ url: m.url, method: m.method, headers: m.headers, body: m.body === undefined ? undefined : new Uint8Array(Buffer.from(m.body, "base64")), signal: abort.signal });
      if (abort.signal.aborted) return;
      await this.#send({ t: "fetch.head", id: m.id, status: response.status, statusText: response.statusText.slice(0, 100), headers: response.headers.slice(0, 40).map(([k, v]) => [k.slice(0, 100), v.slice(0, 1000)] as const) });
      if (response.body !== null) {
        for await (const piece of response.body) {
          if (abort.signal.aborted) return;
          for (let at = 0; at < piece.length; at += PROCESS_LIMITS.chunkBytes) await this.#send({ t: "fetch.chunk", id: m.id, data: Buffer.from(piece.subarray(at, at + PROCESS_LIMITS.chunkBytes)).toString("base64") });
        }
      }
      if (!abort.signal.aborted) await this.#send({ t: "fetch.end", id: m.id });
    } catch (error) {
      if (!abort.signal.aborted) await this.#send({ t: "fetch.error", id: m.id, message: message(error) });
    } finally { this.#fetches.delete(m.id); }
  }

  // ---- what the host asks of the process ---------------------------------------------------------------------------------------

  /** Starts the conversation and waits until the process says it is ready. */
  async start(start: ChannelStart, timeoutMs: number = PROCESS_LIMITS.readyMs): Promise<void> {
    if (this.#endedWith !== undefined) throw this.#endedWith;
    const ready = new Promise<void>((resolve, reject) => { this.#readyWaiters.push({ resolve, reject }); });
    ready.catch(() => undefined);
    const timer = setTimeout(() => this.kill(`the worker process was not ready after ${Math.round(timeoutMs / 1000)} seconds`), timeoutMs);
    try {
      // Not awaited: a process that does not read must not hold the caller; the wait below ends with the process.
      void this.#send({ t: "start", v: WORKER_CHANNEL_VERSION, start });
      await ready;
    } finally { clearTimeout(timer); }
  }

  /** The reason the process told the host its lease ended (H08b3), or undefined. Observable whether or not a turn is open. */
  get leaseLost(): string | undefined { return this.#leaseLost; }
  /** Resolves with the reason when the process says its lease ended (at once if it already has). Never rejects; it stays pending if the process ends without saying so. */
  whenLeaseLost(): Promise<string> { return this.#leaseLost !== undefined ? Promise.resolve(this.#leaseLost) : new Promise((resolve) => { this.#leaseWaiters.push(resolve); }); }

  get ready(): boolean { return this.#isReady; }
  /** Model calls the process has open through the relay right now. */
  get modelCallsInFlight(): number { return this.#fetches.size; }
  /** What the process said about itself when it was ready. */
  get info(): { readonly toolSchemaChars?: number; readonly systemPromptChars?: number } { return this.#info; }

  /** Runs the turn and waits for its result. */
  async run(requestId: string, content: string): Promise<Result> {
    if (this.#endedWith !== undefined) throw this.#endedWith;
    if (this.#resultWaiter !== undefined) throw new Error("a turn is already running");
    const result = new Promise<Result>((resolve, reject) => { this.#resultWaiter = { resolve, reject }; });
    result.catch(() => undefined);
    void this.#send({ t: "run", requestId, content });
    return result;
  }

  async #ask<T extends FromChild>(make: (id: number) => ToChild): Promise<T> {
    if (this.#endedWith !== undefined) throw this.#endedWith;
    const id = ++this.#next;
    const answer = new Promise<FromChild>((resolve, reject) => { this.#asked.set(id, { resolve, reject }); });
    answer.catch(() => undefined);
    void this.#send(make(id));
    return (await answer) as T;
  }

  /** Asks the process to compact its stored conversation; resolves with the new size estimate when it says. */
  async compact(): Promise<{ readonly contextTokens?: number }> {
    const ok = await this.#ask<Extract<FromChild, { t: "compact.ok" }>>((id) => ({ t: "compact", id }));
    return ok.contextTokens === undefined ? {} : { contextTokens: ok.contextTokens };
  }

  async checkpoint(): Promise<{ readonly checkpoint: { readonly [key: string]: never }; readonly contextTokens?: number }> {
    const ok = await this.#ask<Extract<FromChild, { t: "checkpoint.ok" }>>((id) => ({ t: "checkpoint", id }));
    return { checkpoint: ok.checkpoint as never, ...(ok.contextTokens === undefined ? {} : { contextTokens: ok.contextTokens }) };
  }
  async tell(text: string): Promise<void> { await this.#ask((id) => ({ t: "tell", id, text })); }

  /** Asks the process to finish, waits a moment for it to go, then ends it. Safe to repeat. */
  async close(): Promise<RunResult> {
    if (this.#endedWith === undefined) await this.#send({ t: "close" });
    this.#run.endInput();
    const timer = setTimeout(() => this.#run.kill(), PROCESS_LIMITS.closeGraceMs);
    try { return await this.#run.result; } finally { clearTimeout(timer); this.#end(new Error("the worker process was closed")); }
  }
}
