import { createServer as createHttp, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttps } from "node:https";
import { isIP, type Socket } from "node:net";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import type { Principal, PrincipalService } from "../security/index.js";
import { redactText } from "../security/redact.js";
import type { JsonObject } from "../storage/types.js";
import { DIGEST_HEADER, PROTOCOL_HEADER, REMOTE_LIMITS, ProtocolMismatch, SESSION_HEADER } from "./protocol.js";
import type { RemoteWorkerService } from "./service.js";

export interface WorkerTransportLimits {
  /** The largest JSON request body, and the largest artifact publication, in bytes. */
  readonly bodyBytes: number;
  readonly publishBytes: number;
  /** Requests one authenticated host may make per minute, and one network address before it is authenticated (the connection's own address; X-Forwarded-For is never trusted). */
  readonly perPrincipalPerMinute: number;
  readonly perAddressPerMinute: number;
  /**
   * Connections that have not yet made an authenticated request (card H07d): at once from one network address, and in all. A connection that is refused here has not logged in, so a flood of slow or silent
   * connections from a few addresses can fill only this pool and never the room of enrolled hosts. An address shared by a whole site is not limited once its hosts have logged in.
   */
  readonly connectionsPerAddress: number;
  readonly connections: number;
  /** Open connections one enrolled host may hold (a worker needs a few and holds one poll open). The listener's room for logged-in hosts is this times the hosts enrolled, so it grows with them. */
  readonly connectionsPerHost: number;
}

/** Provisional limits, adjustable. A busy worker makes several requests a second, so the per-host allowance is higher than a person's. */
export const DEFAULT_WORKER_TRANSPORT_LIMITS: WorkerTransportLimits = { bodyBytes: REMOTE_LIMITS.bodyBytes, publishBytes: REMOTE_LIMITS.publishBytes, perPrincipalPerMinute: 6000, perAddressPerMinute: 3000, connections: 400, connectionsPerAddress: 100, connectionsPerHost: 8 };

export interface WorkerTransportOptions {
  readonly remote: RemoteWorkerService;
  readonly principals: PrincipalService;
  /** The address to bind. Default 127.0.0.1: local only. */
  readonly host?: string;
  /** Default 0: any free port. */
  readonly port?: number;
  /** PEM certificate and key. With them the listener speaks HTTPS. */
  readonly tls?: { readonly cert: string | Buffer; readonly key: string | Buffer };
  /** Remote exposure is opt-in: without this only loopback can be bound; with it TLS and `publicHosts` are required (a worker's credential must never cross a network in the clear). */
  readonly allowRemote?: boolean;
  /** The host names workers use to reach this listener. Requests addressed to any other name are refused (DNS rebinding). */
  readonly publicHosts?: readonly string[];
  readonly limits?: Partial<WorkerTransportLimits>;
  /** Milliseconds, for the rate windows. Default `Date.now`. */
  readonly clock?: () => number;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const isLoopback = (host: string): boolean => LOOPBACK.has(host) || /^127(\.\d{1,3}){3}$/.test(host);
const STATUS: Record<DomainErrorCode, number> = {
  invalid_command: 400, command_conflict: 409, stale_revision: 409, not_found: 404, invalid_transition: 409, stale_epoch: 503, integrity: 500, fenced: 409, payload_changed: 409,
  effect_uncertain: 409, effect_busy: 409, wait_closed: 409, unauthenticated: 401, forbidden: 403, unavailable: 503, review_invalid: 409, checkout_changed: 409,
};

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly headers: Record<string, string> = {}, readonly field?: string, readonly extra: Record<string, unknown> = {}) { super(message); }
}

interface Reply { readonly status: number; readonly body?: unknown; readonly raw?: { readonly bytes: Uint8Array; readonly headers: Record<string, string> } }

/**
 * The HTTP carrier of the controller-worker protocol (card H02). It authenticates every request afresh (a revoked or rotated worker is refused on its next request), accepts only host principals, checks the
 * host name and rates, bounds bodies, and hands the authenticated host principal to `RemoteWorkerService`, which decides everything else. There is no route that admits work, creates an attempt, changes a
 * task or reads the controller's records: a worker's whole surface is its own session, its offers and the attempts placed on it. Local by default; a remote listener has to be asked for and needs TLS.
 *
 * Routes (all JSON unless noted; `Idempotency-Key` on those that change state, so a retry applies once; every request after `connect` names the session and the negotiated protocol version):
 * `POST /worker/connect`, `POST /worker/session/heartbeat`, `GET /worker/session/offers`, `POST /worker/attempts/{id}/{accept|begin|report|usage|heartbeat|acknowledge|complete}`,
 * `PUT /worker/attempts/{id}/checkpoint`, `GET /worker/attempts/{id}/control`, `GET /worker/attempts/{id}/artifacts`, `GET /worker/attempts/{id}/artifacts/{artifact}/file` (bytes), `POST /worker/attempts/{id}/artifacts`.
 */
export class WorkerTransport {
  readonly #server: Server;
  readonly #options: WorkerTransportOptions;
  readonly #limits: WorkerTransportLimits;
  readonly #hosts: Set<string>;
  readonly #conns: ConnectionBook;
  readonly #windows = new Map<string, { start: number; count: number }>();
  readonly #now: () => number;
  readonly url: string;
  readonly port: number;

  private constructor(server: Server, options: WorkerTransportOptions, limits: WorkerTransportLimits, hosts: Set<string>, url: string, port: number, conns: ConnectionBook) {
    this.#conns = conns; this.#server = server; this.#options = options; this.#limits = limits; this.#hosts = hosts; this.url = url; this.port = port; this.#now = options.clock ?? Date.now;
  }

  static async listen(options: WorkerTransportOptions): Promise<WorkerTransport> {
    const host = options.host ?? "127.0.0.1";
    const limits = { ...DEFAULT_WORKER_TRANSPORT_LIMITS, ...(options.limits ?? {}) };
    const remote = !isLoopback(host);
    if (remote && options.allowRemote !== true) throw new DomainError("invalid_command", `${host} is not a loopback address; remote exposure is off unless it is asked for (allowRemote)`, { field: "host" });
    if (options.allowRemote === true && options.tls === undefined) throw new DomainError("invalid_command", "remote exposure needs TLS (tls.cert and tls.key): a worker's credential must not cross a network in the clear", { field: "tls" });
    if (options.allowRemote === true && (options.publicHosts ?? []).length === 0) throw new DomainError("invalid_command", "remote exposure needs publicHosts: the host names workers use", { field: "publicHosts" });
    for (const h of options.publicHosts ?? []) if (typeof h !== "string" || !/^[A-Za-z0-9.-]{1,253}$/.test(h)) throw new DomainError("invalid_command", `publicHosts: ${String(h)} is not a host name`, { field: "publicHosts" });
    const hosts = new Set<string>();
    let transport: WorkerTransport | undefined;
    const handler = (req: IncomingMessage, res: ServerResponse): void => { void transport!.#handle(req, res); };
    const common = { maxHeaderSize: 16 * 1024 };
    const server = options.tls === undefined ? createHttp(common, handler) : createHttps({ ...common, cert: options.tls.cert, key: options.tls.key, minVersion: "TLSv1.2" }, handler);
    const conns = new ConnectionBook(limits);
    server.on("connection", (socket) => { conns.accept(socket); });
    server.requestTimeout = 60_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5_000;
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? 0, host, () => { server.off("error", reject); resolve(); }); });
    const port = (server.address() as { port: number }).port;
    if (!remote) for (const h of ["127.0.0.1", "localhost", "[::1]"]) hosts.add(`${h}:${port}`);
    for (const h of options.publicHosts ?? []) { hosts.add(`${h.toLowerCase()}:${port}`); if (port === (options.tls === undefined ? 80 : 443)) hosts.add(h.toLowerCase()); }
    const url = `${options.tls === undefined ? "http" : "https"}://${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
    transport = new WorkerTransport(server, options, limits, hosts, url, port, conns);
    return transport;
  }

  /** Connections open now, before and after login (for the owner's checks and tests). */
  connectionCounts(): { readonly beforeLogin: number; readonly loggedIn: number } { return this.#conns.counts(); }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => { this.#server.close(() => resolve()); this.#server.closeAllConnections(); });
  }

  // ---- request handling ------------------------------------------------------------------------------------------------------

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      this.#checkHost(req);
      this.#limit(`addr:${req.socket.remoteAddress ?? "?"}`, this.#limits.perAddressPerMinute);
      const host = await this.#authenticate(req);
      this.#limit(`principal:${host.id}`, this.#limits.perPrincipalPerMinute);
      this.#conns.login(req.socket, host.id);
      this.#send(res, await this.#route(req, host));
    } catch (error) {
      this.#fail(res, error);
    }
  }

  #checkHost(req: IncomingMessage): void {
    const host = req.headers.host;
    if (host === undefined || !this.#hosts.has(host.toLowerCase())) throw new HttpError(421, "misdirected", "this host name is not one of the listener's own");
  }

  #limit(key: string, max: number): void {
    const now = this.#now();
    const w = this.#windows.get(key);
    if (w === undefined || now - w.start >= 60_000) {
      this.#windows.set(key, { start: now, count: 1 });
      if (this.#windows.size > 10_000) for (const [k, v] of this.#windows) if (now - v.start >= 60_000) this.#windows.delete(k);
      return;
    }
    w.count += 1;
    if (w.count > max) throw new HttpError(429, "rate_limited", "too many requests; slow down", { "retry-after": String(Math.max(1, Math.ceil((60_000 - (now - w.start)) / 1000))) });
  }

  async #authenticate(req: IncomingMessage): Promise<Principal> {
    const header = req.headers.authorization;
    const match = typeof header === "string" ? /^Bearer ([^\s]{20,400})$/.exec(header) : null;
    const unauthenticated = new HttpError(401, "unauthenticated", "the credential was not accepted", { "www-authenticate": "Bearer" });
    if (match === null) throw unauthenticated;
    let principal: Principal;
    try { principal = await this.#options.principals.authenticate(match[1]!); } catch (error) {
      if (error instanceof DomainError && error.code === "unauthenticated") throw unauthenticated;
      throw error;
    }
    // Only enrolled worker hosts: an owner's, an agent's, a client's or a service's credential does not open this door.
    if (principal.kind !== "host") throw new HttpError(403, "forbidden", "this credential is not a worker host's");
    return principal;
  }

  async #read(req: IncomingMessage, max: number): Promise<Buffer> {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > max) throw new HttpError(413, "too_large", `a request body is at most ${max} bytes here`);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > max) throw new HttpError(413, "too_large", `a request body is at most ${max} bytes here`);
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  async #body(req: IncomingMessage, max = this.#limits.bodyBytes): Promise<Record<string, unknown>> {
    const raw = await this.#read(req, max);
    if (raw.length === 0) return {};
    const type = req.headers["content-type"];
    if (typeof type !== "string" || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type)) throw new HttpError(415, "unsupported_media_type", "send application/json");
    let parsed: unknown;
    try { parsed = JSON.parse(raw.toString("utf8")); } catch { throw new HttpError(400, "invalid_json", "the body is not valid JSON"); }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "invalid_json", "the body must be a JSON object");
    return parsed as Record<string, unknown>;
  }

  /** A body may carry only the fields its route defines: a misspelt field, or one that tries to name a project, task or creator, is refused and not ignored. */
  #only(body: Record<string, unknown>, known: readonly string[]): Record<string, unknown> {
    for (const key of Object.keys(body)) if (!known.includes(key)) throw new HttpError(400, "invalid_command", `${key} is not a field of this message`, {}, key);
    return body;
  }

  #key(req: IncomingMessage): string {
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || key.length === 0) throw new HttpError(400, "idempotency_key_required", "a request that changes anything needs an Idempotency-Key header, so a retry applies once", {}, "Idempotency-Key");
    return key;
  }

  /** The session the request names and the protocol version it speaks: both must be the session's own, or the request is refused before anything else is looked at. */
  async #session(req: IncomingMessage, host: Principal): Promise<string> {
    const id = req.headers[SESSION_HEADER];
    if (typeof id !== "string" || id.length === 0 || id.length > 80) throw new HttpError(409, "fenced", `name your session in the ${SESSION_HEADER} header (connect first)`, {}, SESSION_HEADER);
    const info = await this.#options.remote.sessionInfo(host, id);
    const said = req.headers[PROTOCOL_HEADER];
    if (said !== String(info.protocol)) throw new HttpError(426, "protocol_mismatch", `this session speaks protocol ${info.protocol}; the request named ${typeof said === "string" ? said.slice(0, 20) : "none"}`, { upgrade: "newt-worker" }, PROTOCOL_HEADER, { protocol: info.protocol, supported: info.controller });
    return id;
  }

  #int(value: string | null, field: string): number {
    if (value === null || !/^\d{1,9}$/.test(value)) throw new HttpError(400, "invalid_command", `${field} must be a whole number`, {}, field);
    return Number(value);
  }

  async #route(req: IncomingMessage, host: Principal): Promise<Reply> {
    const url = new URL(req.url ?? "/", "http://listener");
    const method = req.method ?? "GET";
    const parts = url.pathname.split("/").filter(Boolean);
    const svc = this.#options.remote;
    const allowed = (...methods: string[]): void => { if (!methods.includes(method)) throw new HttpError(405, "method_not_allowed", `use ${methods.join(" or ")}`, { allow: methods.join(", ") }); };
    if (parts[0] !== "worker") throw new HttpError(404, "not_found", "no such route");
    const [, a, b, c, d, e] = parts;
    if (a === "connect" && parts.length === 2) {
      allowed("POST");
      const body = await this.#body(req);
      return { status: 200, body: await svc.connect(host, { ...body, commandId: this.#key(req) } as never) };
    }
    if (a === "session" && b === "heartbeat" && parts.length === 3) {
      allowed("POST");
      const session = await this.#session(req, host);
      const body = this.#only(await this.#body(req), ["sequence"]);
      const r = await svc.heartbeat(host, session, { ...body, commandId: this.#key(req) } as never);
      return { status: 200, body: r };
    }
    if (a === "session" && b === "offers" && parts.length === 3) {
      allowed("GET");
      const wait = url.searchParams.get("wait");
      for (const key of url.searchParams.keys()) if (key !== "wait") throw new HttpError(400, "invalid_command", `${key}: is not a parameter of this route`);
      const waitMs = wait === null ? 0 : /^\d{1,6}$/.test(wait) ? Number(wait) : -1;
      return { status: 200, body: { offers: await svc.offers(host, await this.#session(req, host), waitMs) } };
    }
    if (a !== "attempts" || b === undefined || c === undefined) throw new HttpError(404, "not_found", "no such route");
    const session = await this.#session(req, host);
    const attempt = b;
    const placementOf = (body: Record<string, unknown>): unknown => body["placement"];
    if (parts.length === 4 && c !== "checkpoint" && c !== "control" && c !== "artifacts") {
      allowed("POST");
      const body = await this.#body(req);
      const p = placementOf(body);
      this.#only(body, { accept: ["placement"], begin: ["placement", "request"], report: ["placement", "operationId", "outcome"], usage: ["placement", "usage"], heartbeat: ["placement"], acknowledge: ["placement"], complete: ["placement", "result"] }[c] ?? ["placement"]);
      switch (c) {
        case "accept": return { status: 200, body: await svc.accept(host, session, attempt, p) };
        case "begin": return { status: 200, body: await svc.begin(host, session, attempt, p, body["request"] as never) };
        case "report": return { status: 200, body: await svc.report(host, session, attempt, p, body["operationId"] as string, body["outcome"] as never) };
        case "usage": await svc.usage(host, session, attempt, p, body["usage"] as never, this.#key(req)); return { status: 204 };
        case "heartbeat": return { status: 200, body: await svc.attemptHeartbeat(host, session, attempt, p) };
        case "acknowledge": await svc.acknowledgeDecisions(host, session, attempt, p); return { status: 204 };
        case "complete": return { status: 200, body: await svc.complete(host, session, attempt, p, { commandId: this.#key(req), result: body["result"] as never }) };
        default: throw new HttpError(404, "not_found", "no such route");
      }
    }
    if (c === "checkpoint" && parts.length === 4) {
      allowed("PUT");
      const body = this.#only(await this.#body(req), ["placement", "sequence", "checkpoint"]);
      return { status: 200, body: await svc.putCheckpoint(host, session, attempt, placementOf(body), { commandId: this.#key(req), sequence: body["sequence"] as number, checkpoint: body["checkpoint"] as JsonObject }) };
    }
    if (c === "control" && parts.length === 4) {
      allowed("GET");
      return { status: 200, body: { messages: await svc.pollControl(host, session, attempt, this.#int(url.searchParams.get("placement"), "placement"), url.searchParams.get("after") === null ? 0 : this.#int(url.searchParams.get("after"), "after")) } };
    }
    if (c === "artifacts" && parts.length === 4) {
      if (method === "GET") return { status: 200, body: { artifacts: await svc.listArtifacts(host, session, attempt, this.#int(url.searchParams.get("placement"), "placement")) } };
      allowed("GET", "POST");
      const body = this.#only(await this.#body(req, this.#limits.publishBytes), ["placement", "name", "files"]);
      const files = decodeFiles(body["files"], this.#limits.publishBytes);
      return { status: 201, body: await svc.publishArtifact(host, session, attempt, placementOf(body), { commandId: this.#key(req), name: body["name"] as string, files }) };
    }
    if (c === "artifacts" && d !== undefined && e === "file" && parts.length === 6) {
      allowed("GET");
      const path = url.searchParams.get("path");
      if (path === null) throw new HttpError(400, "invalid_command", "path is required", {}, "path");
      const r = await svc.fetchFile(host, session, attempt, this.#int(url.searchParams.get("placement"), "placement"), d, path);
      return { status: 200, raw: { bytes: r.bytes, headers: { [DIGEST_HEADER]: r.digest, "content-type": "application/octet-stream" } } };
    }
    throw new HttpError(404, "not_found", "no such route");
  }

  // ---- responses -------------------------------------------------------------------------------------------------------------

  #send(res: ServerResponse, reply: Reply): void {
    const base = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
    if (reply.raw !== undefined) {
      res.writeHead(reply.status, { ...base, ...reply.raw.headers, "content-length": String(reply.raw.bytes.byteLength) });
      res.end(Buffer.from(reply.raw.bytes));
      return;
    }
    if (reply.status === 204 || reply.body === undefined) { res.writeHead(reply.status, base); res.end(); return; }
    const out = JSON.stringify(reply.body);
    res.writeHead(reply.status, { ...base, "content-type": "application/json; charset=utf-8", "content-length": String(Buffer.byteLength(out)) });
    res.end(out);
  }

  #json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    if (res.headersSent) { res.destroy(); return; }
    const out = JSON.stringify(body);
    res.writeHead(status, { "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers, "content-type": "application/json; charset=utf-8", "content-length": String(Buffer.byteLength(out)) });
    res.end(out);
  }

  #fail(res: ServerResponse, error: unknown): void {
    if (error instanceof HttpError) return this.#json(res, error.status, { error: { code: error.code, message: error.message, ...(error.field === undefined ? {} : { field: error.field }), ...error.extra } }, error.headers);
    // A worker the controller cannot speak to is told so, and what the controller speaks.
    if (error instanceof ProtocolMismatch) return this.#json(res, 426, { error: { code: "protocol_unsupported", message: redactText(error.message), supported: error.supported } }, { upgrade: "newt-worker" });
    if (error instanceof DomainError) {
      const status = STATUS[error.code] ?? 500;
      if (status >= 500 && error.code !== "unavailable") return this.#json(res, status, { error: { code: error.code, message: "the request could not be completed" } }, status === 503 ? { "retry-after": "5" } : {});
      return this.#json(res, status, { error: { code: error.code, message: redactText(error.message), ...(error.field === undefined ? {} : { field: error.field }), ...(error.currentRevision === undefined ? {} : { currentRevision: error.currentRevision }) } }, status === 503 ? { "retry-after": "5" } : {});
    }
    return this.#json(res, 500, { error: { code: "internal", message: "the request could not be completed" } });
  }
}

/** Files arrive as base64 inside the JSON body; the decoded total is bounded by the same limit, so a body cannot expand beyond it. */
function decodeFiles(value: unknown, max: number): { path: string; content: Uint8Array }[] {
  if (!Array.isArray(value) || value.length > 1000) throw new HttpError(400, "invalid_command", "files must be a list of at most 1000", {}, "files");
  let total = 0;
  return value.map((f, i) => {
    if (f === null || typeof f !== "object" || Array.isArray(f)) throw new HttpError(400, "invalid_command", `files[${i}] must be an object`, {}, "files");
    const o = f as Record<string, unknown>;
    for (const key of Object.keys(o)) if (key !== "path" && key !== "content") throw new HttpError(400, "invalid_command", `files[${i}].${key} is not a file field`, {}, "files");
    if (typeof o["path"] !== "string" || typeof o["content"] !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(o["content"]) || o["content"].length % 4 !== 0) throw new HttpError(400, "invalid_command", `files[${i}] needs a path and base64 content`, {}, "files");
    const bytes = Buffer.from(o["content"], "base64");
    total += bytes.length;
    if (total > max) throw new HttpError(413, "too_large", `the files total more than ${max} bytes`);
    return { path: o["path"], content: bytes };
  });
}

/**
 * Which connections are still unauthenticated and which belong to which enrolled host (card H07d). A connection counts against the per-address and total pre-login pools until its first authenticated request, then against
 * its host's own allowance; so many logged-in hosts behind one address are not limited as strangers are, and strangers cannot take the logged-in hosts' room.
 */
class ConnectionBook {
  readonly #byAddress = new Map<string, number>();
  readonly #byHost = new Map<string, number>();
  readonly #state = new WeakMap<Socket, { addr: string; host?: string }>();
  #pre = 0;
  constructor(private readonly limits: WorkerTransportLimits) {}

  accept(socket: Socket): void {
    const addr = socket.remoteAddress ?? "?";
    const n = (this.#byAddress.get(addr) ?? 0) + 1;
    if (n > this.limits.connectionsPerAddress || this.#pre + 1 > this.limits.connections) { socket.destroy(); return; }
    this.#byAddress.set(addr, n); this.#pre++;
    this.#state.set(socket, { addr });
    socket.once("close", () => this.#close(socket));
  }

  /** The connection has made an authenticated request as this host. A host past its allowance is told so and the connection is closed after the answer. */
  login(socket: Socket, host: string): void {
    const state = this.#state.get(socket);
    if (state === undefined || state.host === host) return;
    if (state.host === undefined) this.#leavePre(state.addr); else this.#leaveHost(state.host);
    state.host = host;
    const n = (this.#byHost.get(host) ?? 0) + 1;
    this.#byHost.set(host, n);
    if (n > this.limits.connectionsPerHost) throw new HttpError(429, "rate_limited", "too many connections for this host", { "retry-after": "1", connection: "close" });
  }

  #leavePre(addr: string): void { this.#pre--; const left = (this.#byAddress.get(addr) ?? 1) - 1; if (left <= 0) this.#byAddress.delete(addr); else this.#byAddress.set(addr, left); }
  #leaveHost(host: string): void { const left = (this.#byHost.get(host) ?? 1) - 1; if (left <= 0) this.#byHost.delete(host); else this.#byHost.set(host, left); }
  #close(socket: Socket): void {
    const state = this.#state.get(socket);
    if (state === undefined) return;
    this.#state.delete(socket);
    if (state.host === undefined) this.#leavePre(state.addr); else this.#leaveHost(state.host);
  }

  /** For tests: connections in each pool. */
  counts(): { readonly beforeLogin: number; readonly loggedIn: number } { let loggedIn = 0; for (const n of this.#byHost.values()) loggedIn += n; return { beforeLogin: this.#pre, loggedIn }; }
}
