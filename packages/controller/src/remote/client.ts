import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { DispatchContract, RecipeSummary, ToolCallRequest, ToolExecutor, ToolGateway, ToolResult, TurnUsage, WorkOrder, WorkerTurnResult } from "../dispatch/ports.js";
import { ModelStreamRefused, type ModelStreamCall, type ModelStreamEvent, type ModelStreamTap } from "../dispatch/model-stream.js";
import { contractProblems, enforcementFor, recipeChanged, restartDigest, type WorkerAbilities } from "./contract-wire.js";
import { DIGEST_HEADER, PROTOCOL_HEADER, SESSION_HEADER, WORKER_PROTOCOL, WAITING_FOR_OWNER, REMOTE_LIMITS, type ThinkingAnswer, type ThinkingWire, type ArtifactListing, type ControlMessage, type ProcessReport, type Offer, type SequencedControl, type SessionInfo, type StoredResult, type VersionRange, type RemoteWorkspaceAnswer, type WorkspaceAsk, type ToolBridgeAnswer, type ToolBridgeRequest } from "./protocol.js";

/** One stream-events message carries at most this many events and about this many bytes of JSON (the controller refuses more; its body limit is 1 MB). */
const STREAM_MESSAGE_EVENTS = 400;
const STREAM_MESSAGE_BYTES = 700_000;
/** A longer string is cut into slices of this many characters (an escaped slice stays under the message size). */
const STREAM_SLICE_CHARS = 100_000;
const safeCut = (value: string, n: number): string => (n < value.length && n > 0 && value.charCodeAt(n - 1) >= 0xd800 && value.charCodeAt(n - 1) <= 0xdbff ? value.slice(0, n - 1) : value.slice(0, n));

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

/** A refusal from the controller, with the code it gave (`fenced`, `protocol_unsupported`, `unauthenticated`, ...). `supported` is what the controller speaks, when the refusal is about the protocol. */
export class WorkerRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly supported?: VersionRange) { super(message); this.name = "WorkerRequestError"; }
  /** The controller no longer accepts this attempt, session or placement from this worker: stop work on it. */
  get fenced(): boolean { return this.code === "fenced"; }
  /** The attempt is not lost or ended: the controller waits for the owner to decide on taking it up again (card H09b). Wait and ask again; do not treat it as a failure. */
  get waitingForOwner(): boolean { return this.status === 503 && this.code === "unavailable" && this.message.includes(WAITING_FOR_OWNER); }
}

/** The controller's answer to the recovery handshake (card H09b): a verdict per listed attempt, and the attempts it has accepted on this host that were not listed. */
export interface ReconcileAnswer {
  readonly sessionId: string;
  readonly mode: "auto" | "owner";
  readonly verdicts: readonly { readonly attemptId: string; readonly placement: number; readonly verdict: "stop" | "hold" | "reaccept" | "pending" | "unknown"; readonly reason: string }[];
  readonly missing?: readonly { readonly attemptId: string; readonly placement: number }[];
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
  async reconcile(held: readonly { readonly attemptId: string; readonly placement: number }[], key: string = randomUUID()): Promise<ReconcileAnswer> {
    return (await this.#send("POST", "/worker/session/reconcile", { body: { held: held as unknown as Json }, key, session: true })).body as never;
  }

  /** The attempts offered to this host and not yet accepted, with their work orders. */
  async offers(options: { readonly waitMs?: number } = {}): Promise<Offer[]> {
    const wait = options.waitMs ?? 0;
    // A held poll must not be given up before the controller ends it: the request may take the whole wait and a margin.
    const path = wait > 0 ? `/worker/session/offers?wait=${wait}` : "/worker/session/offers";
    return ((await this.#send("GET", path, { session: true, timeoutMs: Math.max(this.#options.timeoutMs ?? 30_000, wait + 10_000) })).body as unknown as { offers: Offer[] }).offers;
  }

  /** The release-test jobs issued to this host, with their payloads (card X09b). */
  async releaseJobs(): Promise<{ readonly attemptId: string; readonly payload: { readonly [key: string]: Json }; readonly pickedUpAt?: string }[]> {
    return (await this.releaseWork()).jobs;
  }

  /** The jobs and the attempts to stop: ones this host picked up that the controller ended without a result (cancelled, timed out, authorization withdrawn). Stopping is idempotent; the instruction is repeated for a day. */
  async releaseWork(): Promise<{ readonly jobs: { readonly attemptId: string; readonly payload: { readonly [key: string]: Json }; readonly pickedUpAt?: string }[]; readonly cancel: string[] }> {
    return (await this.#send("GET", "/worker/release/jobs", { session: true })).body as unknown as { jobs: { attemptId: string; payload: { [key: string]: Json }; pickedUpAt?: string }[]; cancel: string[] };
  }

  /** Tells the controller the job was fetched and is starting. */
  async releasePickUp(attemptId: string, key: string = randomUUID()): Promise<{ readonly pickedUpAt: string }> {
    return (await this.#send("POST", `/worker/release/jobs/${encodeURIComponent(attemptId)}/pickup`, { body: {}, key, session: true })).body as unknown as { pickedUpAt: string };
  }

  /** The result of a job: what ran, against what, and how it went. The controller takes it only if it matches the candidate exactly. */
  async releaseReport(attemptId: string, result: { readonly [key: string]: Json }, key: string = randomUUID()): Promise<void> {
    await this.#send("POST", `/worker/release/jobs/${encodeURIComponent(attemptId)}/report`, { body: result, key, session: true });
  }

  /** The workspace requests (integration, landing, refresh, quarantine) the controller has for this host and has not had an answer to (card H12m). */
  async workspaceRequests(): Promise<WorkspaceAsk[]> {
    return (await this.workspaceList()).requests;
  }

  /** The requests, and the IDs of those the controller withdrew (it stopped waiting): a host drops a withdrawn request it has not started. */
  async workspaceList(): Promise<{ readonly requests: WorkspaceAsk[]; readonly withdrawn: string[] }> {
    const body = (await this.#send("GET", "/worker/session/workspace", { session: true })).body as unknown as { requests: WorkspaceAsk[]; withdrawn?: string[] };
    return { requests: body.requests, withdrawn: body.withdrawn ?? [] };
  }

  /** Answers one workspace request. The same answer sent again is accepted as a repeat; the key is derived from the request, so a retry applies once. */
  async answerWorkspace(requestId: string, outcome: RemoteWorkspaceAnswer): Promise<void> {
    await this.#send("POST", `/worker/session/workspace/${encodeURIComponent(requestId)}`, { body: { outcome: outcome as unknown as Json }, key: `workspace-answer:${requestId}`, session: true });
  }

  /** One chunk of a file of a conversation-store transfer the controller asked for (card K01i). The same chunk sent again (a lost answer) is accepted once; a chunk out of order is refused. */
  async piStatePut(transferId: string, chunk: { readonly name: string; readonly offset: number; readonly data: Buffer; readonly last?: { readonly sha256: string } }): Promise<void> {
    await this.#send("POST", `/worker/session/pi-state/${encodeURIComponent(transferId)}/put`, { body: { name: chunk.name, offset: chunk.offset, data: chunk.data.toString("base64"), ...(chunk.last === undefined ? {} : { last: true, sha256: chunk.last.sha256 }) } as unknown as Json, key: `pi-put:${transferId}:${chunk.name}:${chunk.offset}`, session: true });
  }

  /** One chunk of a file the controller holds for a restore (card K01i): `eof` and, at the end, the digest of the whole file. */
  async piStateGet(transferId: string, name: string, offset: number): Promise<{ readonly data: Buffer; readonly offset: number; readonly size: number; readonly eof: boolean; readonly sha256?: string }> {
    const body = (await this.#send("GET", `/worker/session/pi-state/${encodeURIComponent(transferId)}/get?name=${encodeURIComponent(name)}&offset=${offset}`, { session: true })).body as unknown as { data: string; offset: number; size: number; eof: boolean; sha256?: string };
    return { data: Buffer.from(body.data, "base64"), offset: body.offset, size: body.size, eof: body.eof, ...(body.sha256 === undefined ? {} : { sha256: body.sha256 }) };
  }

  /**
   * Tells the controller of a security event this host detected (card U11d): a sandbox escape attempt, a credential used from the wrong task or host, a protected path touched, a failed integrity check. The key
   * is the same for the same event (the controller tells the owner once); it is never a secret. Returns the owner's item; `held` is true when this host's hourly allowance was used.
   */
  async reportSecurity(event: { readonly kind: string; readonly key: string; readonly projectId?: string }, key: string = randomUUID()): Promise<{ readonly itemId: string; readonly held: boolean }> {
    return (await this.#send("POST", "/worker/session/security", { body: { event: event as unknown as Json }, key, session: true })).body as { itemId: string; held: boolean };
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
    return (await this.#send("POST", this.#path(action), { body: { placement: this.placement, ...body }, session: true, ...(key === undefined ? {} : { key }) })).body;
  }
  /** Every request about the attempt goes through here (card H08b): a fenced answer to any of them (a call, a control poll, a checkpoint, a publish, a file) tells the watchdog, so productive work stops at once, whatever the lease says. */
  async #send(...args: Parameters<RemoteWorkerClient["send"]>): ReturnType<RemoteWorkerClient["send"]> {
    try { return await this.client.send(...args); } catch (error) {
      if (error instanceof WorkerRequestError && error.fenced) await this.watchdog?.lost();
      throw error;
    }
  }

  /** Takes the offer (or takes the attempt up again after a reconnect). `fenced` means the attempt was moved or ended: drop it. */
  async accept(): Promise<{ placement: number; expiresAt?: string; controlSeq: number; checkpoint?: { artifactId: string; sequence: number } }> {
    return await this.#post("accept", {}) as never;
  }
  async begin(request: ToolCallRequest): ReturnType<ToolGateway["begin"]> { await this.watchdog?.assertProductive(); return await this.#post("begin", { request: request as unknown as Json }) as never; }
  /**
   * An effect call the controller runs for this worker (card H12a): the call and what it wants done go over the wire, the controller judges and records the call, applies the effect through its own bridge for `kind` and
   * answers with the result. The call ID makes a message sent again (after a lost answer) the same call. Nothing here runs the effect or holds a credential for it.
   */
  async effect(request: ToolCallRequest, effect: { readonly kind: string; readonly target: string; readonly input: { readonly [key: string]: Json } }): Promise<ToolResult> {
    await this.watchdog?.assertProductive();
    return await this.#post("effect", { request: request as unknown as Json, effect: effect as unknown as Json }) as never;
  }
  /**
   * A tool request of the agent's process, carried to the controller's tool bridge (card L05e): `token` is the task credential the process presented to this machine's bridge and `request` what its tool extension asked. The call ID makes a
   * request sent again (a lost answer) the same request: the controller answers it from its ledger and never runs a write twice. The answer is the bridge's own (`ok: false` with a code for a refusal). A request the controller refuses
   * outright (a stale placement or session: `fenced`) throws `WorkerRequestError`. The credential is sent only in the body of this one request and is not kept.
   */
  async toolBridge(token: string, request: ToolBridgeRequest, key?: string): Promise<ToolBridgeAnswer> {
    await this.watchdog?.assertProductive();
    return await this.#post("tool", { token, request: request as unknown as Json }, key ?? `tool:${request.callId}:${createHash("sha256").update(JSON.stringify([request.op, request.args ?? {}])).digest("hex").slice(0, 16)}`) as never;
  }
  /**
   * The model's thinking the machine's agent process reported (card U09c), carried to the controller's thinking store. The text is untrusted and goes as it came (the controller cleans and bounds it); a message too large for the route is sent in
   * parts, each part its own message with a key made from its content, so a part sent again is kept once. Throws `WorkerRequestError` (an older controller refuses the body with 400 "blocks is not a field of this message"); the caller drops it.
   */
  async thinking(given: readonly ThinkingWire[], key?: string): Promise<ThinkingAnswer> {
    await this.watchdog?.assertProductive();
    // The worker channel lets a process report up to 20,000 characters a block (the local path keeps them, cut by the store); the route takes 8000, so a longer text is cut here (at a character boundary) rather than refused.
    const cutText = (t: string): string => { if (t.length <= REMOTE_LIMITS.thinkingChars) return t; let end: number = REMOTE_LIMITS.thinkingChars; const c = t.charCodeAt(end - 1); if (c >= 0xd800 && c <= 0xdbff) end -= 1; return t.slice(0, end); };
    const blocks = given.map((b) => (typeof b.text === "string" && b.text.length > REMOTE_LIMITS.thinkingChars ? { ...b, text: cutText(b.text) } : b));
    const size = (part: readonly ThinkingWire[]): number => Buffer.byteLength(JSON.stringify(part), "utf8");
    if (blocks.length > 1 && size(blocks) > REMOTE_LIMITS.thinkingBytes - 4096) {
      const half = Math.ceil(blocks.length / 2);
      const a = await this.thinking(blocks.slice(0, half), key === undefined ? undefined : `${key}:a`);
      const b = await this.thinking(blocks.slice(half), key === undefined ? undefined : `${key}:b`);
      return { kept: a.kept + b.kept, ...(b.reason === undefined ? {} : { reason: b.reason }) };
    }
    return await this.#post("thinking", { blocks: blocks as unknown as Json }, key ?? `thinking:${createHash("sha256").update(JSON.stringify(blocks)).digest("hex").slice(0, 32)}`) as never;
  }
  async report(operationId: string, outcome: Parameters<ToolGateway["report"]>[1]): Promise<ToolResult> { return await this.#post("report", { operationId, outcome: outcome as unknown as Json }) as never; }
  async usage(usage: TurnUsage): Promise<void> { await this.#post("usage", { usage: usage as unknown as Json }); }
  async heartbeat(): Promise<{ readonly until: string; readonly leaseMs?: number }> {
    const sentAt = this.watchdog?.sending();
    const answer = await this.#post("heartbeat", {}) as { readonly until: string; readonly leaseMs?: unknown };
    // The lease counts from the moment the renewal was sent, so a reply that took long does not stretch it. It is the duration the controller says (card H08b), so a wrong clock on this machine changes nothing; only a controller that
    // does not say it has its `until` read against this machine's clock (skew then shortens or lengthens it, and the cap in the watchdog bounds it).
    const leaseMs = typeof answer.leaseMs === "number" && Number.isFinite(answer.leaseMs) && answer.leaseMs >= 0 ? answer.leaseMs : undefined;
    if (sentAt !== undefined) this.watchdog?.renewed(sentAt, leaseMs ?? Math.max(0, Date.parse(answer.until) - Date.now()));
    return { until: answer.until, ...(leaseMs === undefined ? {} : { leaseMs }) };
  }
  async acknowledgeDecisions(): Promise<void> { await this.#post("acknowledge", {}); }
  /** Tells the controller what this worker holds for the attempt (card L02e); `final` when the sandbox was stopped and looked at again. `kept: false`: the controller already has a newer report (or a final one) and ignored this. */
  async reportProcesses(report: ProcessReport): Promise<{ readonly kept: boolean }> { return await this.#post("processes", { seq: report.seq, final: report.final, ...(report.canLook === true ? { canLook: true } : {}), ...(report.computeMs === undefined ? {} : { computeMs: report.computeMs }), processes: report.processes as unknown as Json }) as { kept: boolean }; }

  /**
   * The recorder of this worker's own model calls (card L05c), for the worker's `ModelRelay` (`stream:`). Each call begins a generation on the controller under the task's current context revision and this attempt's fence; the decoded events
   * of the reply are sent in order (numbered, so a message sent again is recorded once) and the answer says whether the reply must be held back. A call the controller refuses (the task is held, the attempt is fenced) throws
   * `ModelStreamRefused`, so the request is not sent. If the controller cannot be reached the call is refused, and a reply being read is held back with the reason: nothing is passed on that was not recorded as applied.
   */
  streamTap(options: { readonly batchMs?: number; readonly batchChars?: number; readonly now?: () => number } = {}): ModelStreamTap {
    const failure = (error: unknown): string => (error instanceof WorkerRequestError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : "the controller could not be reached").slice(0, 200);
    const batchMs = options.batchMs ?? 250;
    const batchChars = options.batchChars ?? 4000;
    const now = options.now ?? ((): number => Date.now());
    return {
      started: async (call): Promise<ModelStreamCall | undefined> => {
        let answer: { recorded?: false; refused?: string; streamId?: string; amend?: string; heldBufferBytes?: number };
        try { answer = await this.#post("stream-start", { call: { requestChars: call.requestChars, ...(call.requestDigest === undefined ? {} : { requestDigest: call.requestDigest }) } }) as typeof answer; } catch (error) {
          throw new ModelStreamRefused(`the controller could not be asked to record the model call (${failure(error)}); the call is not sent`);
        }
        if (answer.refused !== undefined) throw new ModelStreamRefused(answer.refused);
        if (answer.streamId === undefined) return undefined;
        const streamId = answer.streamId;
        let n = 0;
        // Events wait here and go out in few messages (a stream of single tokens would otherwise be one request each, past the transport's rate limits): when `batchChars` are waiting, when `batchMs` have passed since the last send (a timer
        // sends what waits when the model pauses), and always before a completed tool call or the end of the reply is passed on. Whether the reply must be held back is the answer to the latest message; a piece that was sent in the background
        // and found late holds the reply at the next piece.
        let pending: ModelStreamEvent[] = [];
        let chars = 0;
        let lastSent = now();
        let heldWhy: string | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let chain: Promise<unknown> = Promise.resolve();
        const serial = <T>(fn: () => Promise<T>): Promise<T> => { const r = chain.then(fn, fn); chain = r.then(() => undefined, () => undefined); return r; };
        const add = (e: ModelStreamEvent): void => {
          const last = pending[pending.length - 1];
          if (e.kind === "text") { chars += e.text.length; if (last?.kind === "text") { pending[pending.length - 1] = { kind: "text", text: last.text + e.text }; return; } }
          else if (e.kind === "tool") {
            chars += e.argumentsDelta.length;
            if (last?.kind === "tool" && last.id === e.id && !last.done) { pending[pending.length - 1] = { kind: "tool", id: last.id, ...(last.name !== undefined ? { name: last.name } : e.name !== undefined ? { name: e.name } : {}), ...(last.alias !== undefined ? { alias: last.alias } : e.alias !== undefined ? { alias: e.alias } : {}), argumentsDelta: last.argumentsDelta + e.argumentsDelta, done: e.done }; return; }
          }
          pending.push(e);
        };
        /** The next message: at most STREAM_MESSAGE_EVENTS events and STREAM_MESSAGE_BYTES of JSON; a longer string is cut into slices (the controller joins them as it does the network's own pieces). */
        const take = (): ModelStreamEvent[] => {
          const out: ModelStreamEvent[] = [];
          let bytes = 0;
          while (pending.length > 0 && out.length < STREAM_MESSAGE_EVENTS) {
            let e = pending[0]!;
            const text = e.kind === "text" || e.kind === "note" ? e.text : e.kind === "tool" ? e.argumentsDelta : "";
            if (text.length > STREAM_SLICE_CHARS) {
              const head = safeCut(text, STREAM_SLICE_CHARS);
              const rest = text.slice(head.length);
              const part = e.kind === "tool" ? { ...e, argumentsDelta: head, done: false } : e.kind === "text" ? { ...e, text: head } : { kind: "note" as const, text: head };
              pending[0] = e.kind === "tool" ? { kind: "tool", id: e.id, argumentsDelta: rest, done: e.done } : e.kind === "text" ? { kind: "text", text: rest } : { kind: "note", text: rest };
              e = part;
            } else pending.shift();
            const size = Buffer.byteLength(JSON.stringify(e));
            if (out.length > 0 && bytes + size > STREAM_MESSAGE_BYTES) { pending.unshift(e); break; }
            out.push(e); bytes += size;
          }
          return out;
        };
        const flush = (): Promise<void> => serial(async () => {
          if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
          while (pending.length > 0 && heldWhy === undefined) {
            const message = take();
            lastSent = now();
            try {
              const r = await this.#post("stream-events", { streamId, n: ++n, events: message as unknown as Json }) as { held?: string };
              if (r.held !== undefined) heldWhy = r.held;
            } catch (error) { heldWhy = `the controller could not record this part of the reply (${failure(error)})`; }
          }
          chars = 0;
        });
        const arm = (): void => {
          if (timer !== undefined || batchMs <= 0 || pending.length === 0) return;
          timer = setTimeout(() => { timer = undefined; void flush().catch(() => undefined); }, batchMs);
          timer.unref?.();
        };
        return {
          ...(answer.amend === undefined ? {} : { amend: answer.amend }),
          ...(answer.heldBufferBytes === undefined ? {} : { heldBufferBytes: answer.heldBufferBytes }),
          events: async (events: readonly ModelStreamEvent[]): Promise<{ readonly held?: string }> => {
            if (heldWhy !== undefined) return { held: heldWhy };
            let dangerous = false;
            for (const e of events) { add(e); if (e.kind === "end" || (e.kind === "tool" && e.done)) dangerous = true; }
            if (dangerous || batchMs <= 0 || chars >= batchChars || now() - lastSent >= batchMs) await flush(); else arm();
            return heldWhy === undefined ? {} : { held: heldWhy };
          },
          ended: async (outcome): Promise<void> => {
            try { if (heldWhy === undefined) await flush(); } catch { /* the controller ends a call left open */ }
            try { await this.#post("stream-end", { streamId, ok: outcome.ok }); } catch { /* a call left open is ended as failed by the controller when the attempt ends or opens its next calls (at most 4 stay open) */ }
          },
        };
      },
    };
  }

  /** The split form run for a local executor: the controller decides and records, this runs it, the controller records how it ended. */
  async call(request: ToolCallRequest, executor: ToolExecutor): Promise<ToolResult> {
    // An effect goes through the controller's ledger and bridge; the worker names the kind, target and input and never holds the bridge (the executor's own `bridge` stays here, unused).
    if (executor.kind === "effect") return await this.effect(request, { kind: executor.effectKind, target: executor.target, input: executor.input as { readonly [key: string]: Json } });
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

  /**
   * Checks the order's dispatch contract against what this worker can hold and either confirms it to the controller with the figures it really enforces (`ok`) or refuses the order with the reasons (`ok: false`).
   * Call it before any tool call: the controller decides no call until the confirmation of this placement is on record. A confirmation the controller itself finds short (a limit not enforced in full without best
   * effort) comes back as `ok: false` too.
   */
  async honorContract(order: WorkOrder, abilities: WorkerAbilities, now: string = new Date().toISOString(), key?: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly reasons: readonly string[] }> {
    const problems = contractProblems(order, abilities, now);
    const digest = order.contract?.digest;
    if (problems.length > 0 || order.contract === undefined || digest === undefined) {
      const reasons = problems.map((p) => p.slice(0, 300)).slice(0, 10);
      // An order with no contract has no digest to name: the run is ended with a failed result instead.
      if (digest !== undefined) await this.#post("refuse", { digest, reasons: reasons as unknown as Json });
      else await this.complete({ status: "failed", error: `the worker refused the order: ${reasons.join("; ")}` });
      return { ok: false, reasons: problems };
    }
    const answer = await this.#post("launched", { digest, enforcement: enforcementFor(order.contract, abilities) as unknown as Json }, key) as { confirmed: boolean; reasons?: string[] };
    return answer.confirmed ? { ok: true } : { ok: false, reasons: answer.reasons ?? ["the controller did not accept the confirmation"] };
  }

  /**
   * After a `restart` control message that changed the recipe the controller cleared the confirmation: this confirms the new launch (the digest bound to the new recipe, the figures the sandbox really
   * enforces now). Until it is accepted the controller decides no further call. `currentDigest` is the digest the worker confirmed before.
   */
  async confirmRestart(currentDigest: string, restart: { readonly recipe: RecipeSummary }, contract: DispatchContract, abilities: WorkerAbilities, key?: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly reasons: readonly string[] }> {
    const digest = restartDigest(currentDigest, restart.recipe);
    const answer = await this.#post("launched", { digest, enforcement: enforcementFor(contract, abilities) as unknown as Json }, key) as { confirmed: boolean; reasons?: string[] };
    return answer.confirmed ? { ok: true } : { ok: false, reasons: answer.reasons ?? ["the controller did not accept the confirmation"] };
  }

  /**
   * The worker's loop calls this with the control messages it just read: every `restart` that changes what the sandbox reaches or the limits it runs under is confirmed again (`confirmRestart`), in order, and the digest and
   * recipe it now holds are returned for the next call. A restart into the same recipe asks for nothing. Stops at the first confirmation the controller refuses (then the attempt is over) and says why.
   */
  async confirmRestarts(messages: readonly SequencedControl[], held: { readonly digest: string; readonly recipe: RecipeSummary }, contract: DispatchContract, abilities: WorkerAbilities): Promise<{ readonly digest: string; readonly recipe: RecipeSummary; readonly refused?: readonly string[] }> {
    let { digest, recipe } = held;
    for (const msg of messages) {
      if (msg.kind !== "restart" || !recipeChanged(recipe, msg.recipe)) continue;
      const answer = await this.confirmRestart(digest, { recipe: msg.recipe }, contract, abilities, `restart-${msg.seq}`);
      if (!answer.ok) return { digest, recipe, refused: answer.reasons };
      digest = restartDigest(digest, msg.recipe);
      recipe = msg.recipe;
    }
    return { digest, recipe };
  }

  /** The turn is over. */
  async complete(result: WorkerTurnResult, key?: string): Promise<StoredResult> { return await this.#post("complete", { result: result as unknown as Json }, key) as never; }

  /** Sends a checkpoint; `sequence` must rise with each one. */
  async putCheckpoint(sequence: number, checkpoint: Json, key?: string): Promise<{ sequence: number; artifactId: string; digest: string }> {
    return (await this.#send("PUT", this.#path("checkpoint"), { body: { placement: this.placement, sequence, checkpoint }, session: true, ...(key === undefined ? {} : { key }) })).body as never;
  }

  async pollControl(after = 0): Promise<SequencedControl[]> {
    return ((await this.#send("GET", `${this.#path("control")}?placement=${this.placement}&after=${after}`, { session: true })).body as { messages: SequencedControl[] }).messages;
  }

  async artifacts(): Promise<ArtifactListing[]> {
    return ((await this.#send("GET", `${this.#path("artifacts")}?placement=${this.placement}`, { session: true })).body as { artifacts: ArtifactListing[] }).artifacts;
  }

  /** One file, checked here as well: its bytes must hash to the digest the controller names. */
  async fetchFile(artifactId: string, path: string): Promise<Uint8Array> {
    const r = await this.#send("GET", `${this.#path(`artifacts/${artifactId}/file`)}?placement=${this.placement}&path=${encodeURIComponent(path)}`, { session: true });
    const said = r.headers[DIGEST_HEADER];
    const actual = createHash("sha256").update(r.raw).digest("hex");
    if (said !== actual) {
      // The worker-side hook for a failed integrity check (card U11d, A08): the controller is told once per artifact and file (a digest of the path, never the path or the bytes), without waiting and without changing the refusal.
      try { void this.client.reportSecurity({ kind: "integrity-check-failed", key: `fetch:${artifactId.slice(0, 80)}:${createHash("sha256").update(path).digest("hex").slice(0, 24)}` }, `integrity:${artifactId}:${createHash("sha256").update(path).digest("hex").slice(0, 16)}`).catch(() => undefined); } catch { /* reporting never changes the refusal */ }
      throw new WorkerRequestError(r.status, "integrity", `${path} does not match the digest the controller gave; it is not used`);
    }
    return new Uint8Array(r.raw);
  }

  async publish(name: string, files: readonly { path: string; content: Uint8Array }[], key?: string): Promise<{ artifactId: string }> {
    const r = await this.#send("POST", this.#path("artifacts"), { body: { placement: this.placement, name, files: files.map((f) => ({ path: f.path, content: Buffer.from(f.content).toString("base64") })) }, session: true, ...(key === undefined ? {} : { key }) });
    return r.body as never;
  }
}

export type { ControlMessage };
