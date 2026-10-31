import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { ToolCallRequest, ToolExecutor, ToolGateway, ToolResult, TurnUsage, WorkerTurnResult } from "../dispatch/ports.js";
import { DIGEST_HEADER, PROTOCOL_HEADER, SESSION_HEADER, WORKER_PROTOCOL, type ArtifactListing, type ControlMessage, type Offer, type SequencedControl, type SessionInfo, type StoredResult, type VersionRange } from "./protocol.js";

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

/** A refusal from the controller, with the code it gave (`fenced`, `protocol_unsupported`, `unauthenticated`, ...). `supported` is what the controller speaks, when the refusal is about the protocol. */
export class WorkerRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly supported?: VersionRange) { super(message); this.name = "WorkerRequestError"; }
  /** The controller no longer accepts this attempt, session or placement from this worker: stop work on it. */
  get fenced(): boolean { return this.code === "fenced"; }
}

export interface RemoteWorkerClientOptions {
  /** The controller's worker address (`https://...`). */
  readonly url: string;
  /** The host's credential. The client holds nothing else: no database, no file path of the controller. */
  readonly token: string;
  /** PEM certificate authority to trust, for a controller with a private certificate. */
  readonly ca?: string;
  /** The protocol versions this worker speaks. Default what this build speaks. */
  readonly protocol?: VersionRange;
  readonly workerVersion: string;
  /** How many times a request that got no answer (the connection broke) is sent again with the same idempotency key. Default 2. */
  readonly retries?: number;
  /** The `Host` header to send, when the controller is reached through another name. */
  readonly hostHeader?: string;
  /** A request that gets no answer for this long is given up (and sent again with its key, as any request with no answer). Default 30 seconds. */
  readonly timeoutMs?: number;
  /** The largest response taken, in bytes; a larger one is refused. Default 32 MiB. */
  readonly maxResponseBytes?: number;
}

const isLoopbackHost = (host: string): boolean => host === "localhost" || host === "[::1]" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);

interface Call { readonly body?: Json; readonly key?: string; readonly session?: boolean; readonly timeoutMs?: number }

/**
 * The worker's side of the controller-worker protocol (card H02): plain JSON over HTTP, the dispatch contract of card H12 carried unchanged. It is given a URL and a credential and nothing else, so a
 * remote worker has no way to open the controller's database or files; everything it can do is what the controller's routes allow. A request that changes state carries an idempotency key, and one whose
 * answer is lost is sent again with the same key, so it applies once.
 */
export class RemoteWorkerClient {
  readonly #options: RemoteWorkerClientOptions;
  #session: SessionInfo | undefined;

  constructor(options: RemoteWorkerClientOptions) {
    const url = new URL(options.url);
    // The credential is a bearer token: it is never sent in the clear to another machine.
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) throw new Error("the controller's URL must be https (plain http only to this machine)");
    this.#options = options;
  }

  get session(): SessionInfo | undefined { return this.#session; }

  /** Drops the session the controller no longer accepts, so the next call has to connect again. */
  forgetSession(): void { this.#session = undefined; }

  /** Opens a session. Throws a `WorkerRequestError` with code `protocol_unsupported` (and what the controller speaks) when no protocol version is shared. */
  async connect(capabilities: Json, key: string = randomUUID()): Promise<SessionInfo> {
    const { body } = await this.#send("POST", "/worker/connect", { body: { protocol: { ...(this.#options.protocol ?? WORKER_PROTOCOL) }, workerVersion: this.#options.workerVersion, capabilities }, key });
    this.#session = body as unknown as SessionInfo;
    return this.#session;
  }

  async heartbeat(sequence: number, key: string = randomUUID()): Promise<void> {
    await this.#send("POST", "/worker/session/heartbeat", { body: { sequence }, key, session: true });
  }

  /** The recovery handshake after a reconnect (card H09b): lists the attempts this worker still holds and learns, per attempt, whether to stop, hold, accept again or wait. Nothing resumes by itself. */
  async reconcile(held: readonly { readonly attemptId: string; readonly placement: number }[], key: string = randomUUID()): Promise<{ sessionId: string; mode: "auto" | "owner"; verdicts: { attemptId: string; placement: number; verdict: "stop" | "hold" | "reaccept" | "pending" | "unknown"; reason: string }[] }> {
    return (await this.#send("POST", "/worker/session/reconcile", { body: { held: held as unknown as Json }, key, session: true })).body as never;
  }

  /** The attempts offered to this host and not yet accepted, with their work orders. */
  async offers(options: { readonly waitMs?: number } = {}): Promise<Offer[]> {
    const wait = options.waitMs ?? 0;
    // A held poll must not be given up before the controller ends it: the request may take the whole wait and a margin.
    const path = wait > 0 ? `/worker/session/offers?wait=${wait}` : "/worker/session/offers";
    return ((await this.#send("GET", path, { session: true, timeoutMs: Math.max(this.#options.timeoutMs ?? 30_000, wait + 10_000) })).body as unknown as { offers: Offer[] }).offers;
  }

  /** One attempt as the worker sees it, under the placement number it was offered. */
  attempt(attemptId: string, placement: number, watchdog?: AttemptWatchdog): RemoteAttempt { return new RemoteAttempt(this, attemptId, placement, watchdog); }

  /** @internal */
  async send(method: string, path: string, call: Call = {}): Promise<{ status: number; body: unknown; raw: Buffer; headers: IncomingMessage["headers"] }> { return this.#send(method, path, call); }

  async #send(method: string, path: string, call: Call): Promise<{ status: number; body: unknown; raw: Buffer; headers: IncomingMessage["headers"] }> {
    const retries = this.#options.retries ?? 2;
    const key = call.key ?? (method === "GET" ? undefined : randomUUID());
    for (let attempt = 0; ; attempt++) {
      try { return await this.#once(method, path, call, key); } catch (error) {
        // Only a request that got no answer at all is sent again.
        if (error instanceof WorkerRequestError || attempt >= retries) throw error;
      }
    }
  }

  #once(method: string, path: string, call: Call, key: string | undefined): Promise<{ status: number; body: unknown; raw: Buffer; headers: IncomingMessage["headers"] }> {
    const url = new URL(path, this.#options.url);
    const data = call.body === undefined ? undefined : JSON.stringify(call.body);
    const session = this.#session;
    if (call.session === true && session === undefined) return Promise.reject(new WorkerRequestError(0, "not_connected", "connect first"));
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#options.token}`,
      ...(data === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(data)) }),
      ...(key === undefined ? {} : { "idempotency-key": key }),
      ...(call.session === true ? { [SESSION_HEADER]: session!.sessionId, [PROTOCOL_HEADER]: String(session!.protocol) } : {}),
      ...(this.#options.hostHeader === undefined ? {} : { host: this.#options.hostHeader }),
    };
    return new Promise((resolve, reject) => {
      const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, { method, headers, ...(url.protocol === "https:" && this.#options.ca !== undefined ? { ca: this.#options.ca } : {}) }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const cap = this.#options.maxResponseBytes ?? 32 * 1024 * 1024;
        res.on("data", (d: Buffer) => {
          size += d.length;
          if (size > cap) { reject(new WorkerRequestError(res.statusCode ?? 0, "too_large", `the controller's response is larger than ${cap} bytes`)); req.destroy(); return; }
          chunks.push(d);
        });
        res.on("error", reject);
        res.on("end", () => {
          const raw = Buffer.concat(chunks);
          const isJson = String(res.headers["content-type"] ?? "").startsWith("application/json");
          let body: unknown;
          if (isJson && raw.length > 0) { try { body = JSON.parse(raw.toString("utf8")); } catch { body = undefined; } }
          const status = res.statusCode ?? 0;
          if (status >= 400) {
            const e = (body as { error?: { code?: string; message?: string; supported?: VersionRange } } | undefined)?.error;
            reject(new WorkerRequestError(status, e?.code ?? "error", e?.message ?? `the controller answered ${status}`, e?.supported));
            return;
          }
          resolve({ status, body, raw, headers: res.headers });
        });
      });
      req.on("error", reject);
      req.setTimeout(call.timeoutMs ?? this.#options.timeoutMs ?? 30_000, () => req.destroy(new Error("the controller did not answer in time")));
      if (data !== undefined) req.write(data);
      req.end();
    });
  }
}

/** The worker's own check that its authority is alive (card H08, `LeaseWatchdog` in the worker package). Kept structural so this package does not depend on the worker's. */
export interface AttemptWatchdog {
  /** Throws once productive work has stopped (lease ended, fenced, machine slept, supervisor gone). */
  assertProductive(): Promise<void>;
  /** The time to put on a renewal before sending it. */
  sending(): number;
  renewed(sentAt: number, leaseMs: number): void;
  lost(): Promise<void>;
}

/** One attempt on this worker. It is a `ToolGateway`, so a worker written for the dispatch contract runs unchanged over the wire; a call that needs the controller's ledger cannot be split and is refused (`call` runs local executors only). */
export class RemoteAttempt implements ToolGateway {
  constructor(private readonly client: RemoteWorkerClient, readonly attemptId: string, readonly placement: number, private readonly watchdog?: AttemptWatchdog) {}

  #path(action: string): string { return `/worker/attempts/${this.attemptId}/${action}`; }
  async #post(action: string, body: Record<string, Json>, key?: string): Promise<unknown> {
    try {
      return (await this.client.send("POST", this.#path(action), { body: { placement: this.placement, ...body }, session: true, ...(key === undefined ? {} : { key }) })).body;
    } catch (error) {
      // The controller says the attempt is no longer this worker's: productive work stops at once, whatever the lease says.
      if (error instanceof WorkerRequestError && error.fenced) await this.watchdog?.lost();
      throw error;
    }
  }

  /** Takes the offer (or takes the attempt up again after a reconnect). `fenced` means the attempt was moved or ended: drop it. */
  async accept(): Promise<{ placement: number; expiresAt?: string; controlSeq: number; checkpoint?: { artifactId: string; sequence: number } }> {
    return await this.#post("accept", {}) as never;
  }
  async begin(request: ToolCallRequest): ReturnType<ToolGateway["begin"]> { await this.watchdog?.assertProductive(); return await this.#post("begin", { request: request as unknown as Json }) as never; }
  async report(operationId: string, outcome: Parameters<ToolGateway["report"]>[1]): Promise<ToolResult> { return await this.#post("report", { operationId, outcome: outcome as unknown as Json }) as never; }
  async usage(usage: TurnUsage): Promise<void> { await this.#post("usage", { usage: usage as unknown as Json }); }
  async heartbeat(): Promise<{ readonly until: string }> {
    const sentAt = this.watchdog?.sending();
    const answer = await this.#post("heartbeat", {}) as { readonly until: string };
    // The lease counts from the moment the renewal was sent, so a reply that took long does not stretch it. The controller's `until` is read against this machine's clock; skew only shortens or lengthens by the skew, and the cap in the watchdog bounds it.
    if (sentAt !== undefined) this.watchdog?.renewed(sentAt, Math.max(0, Date.parse(answer.until) - Date.now()));
    return answer;
  }
  async acknowledgeDecisions(): Promise<void> { await this.#post("acknowledge", {}); }

  /** The split form run for a local executor: the controller decides and records, this runs it, the controller records how it ended. */
  async call(request: ToolCallRequest, executor: ToolExecutor): Promise<ToolResult> {
    if (executor.kind !== "local") throw new Error("a call that goes through the controller's effect ledger cannot be run from a remote worker");
    const begun = await this.begin(request);
    if (!begun.run) return begun.result;
    const controller = new AbortController();
    try {
      const out = await executor.run(controller.signal);
      return await this.report(begun.operationId, { state: "confirmed", text: out.text, ...(out.cpuMs === undefined ? {} : { cpuMs: out.cpuMs }), ...(out.memoryMb === undefined ? {} : { memoryMb: out.memoryMb }) });
    } catch (error) {
      return await this.report(begun.operationId, { state: "failed", error: error instanceof Error ? error.message.slice(0, 300) : "the call failed" });
    }
  }

  /** The turn is over. */
  async complete(result: WorkerTurnResult, key?: string): Promise<StoredResult> { return await this.#post("complete", { result: result as unknown as Json }, key) as never; }

  /** Sends a checkpoint; `sequence` must rise with each one. */
  async putCheckpoint(sequence: number, checkpoint: Json, key?: string): Promise<{ sequence: number; artifactId: string; digest: string }> {
    return (await this.client.send("PUT", this.#path("checkpoint"), { body: { placement: this.placement, sequence, checkpoint }, session: true, ...(key === undefined ? {} : { key }) })).body as never;
  }

  async pollControl(after = 0): Promise<SequencedControl[]> {
    return ((await this.client.send("GET", `${this.#path("control")}?placement=${this.placement}&after=${after}`, { session: true })).body as { messages: SequencedControl[] }).messages;
  }

  async artifacts(): Promise<ArtifactListing[]> {
    return ((await this.client.send("GET", `${this.#path("artifacts")}?placement=${this.placement}`, { session: true })).body as { artifacts: ArtifactListing[] }).artifacts;
  }

  /** One file, checked here as well: its bytes must hash to the digest the controller names. */
  async fetchFile(artifactId: string, path: string): Promise<Uint8Array> {
    const r = await this.client.send("GET", `${this.#path(`artifacts/${artifactId}/file`)}?placement=${this.placement}&path=${encodeURIComponent(path)}`, { session: true });
    const said = r.headers[DIGEST_HEADER];
    const actual = createHash("sha256").update(r.raw).digest("hex");
    if (said !== actual) throw new WorkerRequestError(r.status, "integrity", `${path} does not match the digest the controller gave; it is not used`);
    return new Uint8Array(r.raw);
  }

  async publish(name: string, files: readonly { path: string; content: Uint8Array }[], key?: string): Promise<{ artifactId: string }> {
    const r = await this.client.send("POST", this.#path("artifacts"), { body: { placement: this.placement, name, files: files.map((f) => ({ path: f.path, content: Buffer.from(f.content).toString("base64") })) }, session: true, ...(key === undefined ? {} : { key }) });
    return r.body as never;
  }
}

export type { ControlMessage };
