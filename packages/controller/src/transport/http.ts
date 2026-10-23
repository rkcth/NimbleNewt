import { createServer as createHttp, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttps } from "node:https";
import { isIP } from "node:net";
import type { ConversationService } from "../conversations/index.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import type { Principal, PrincipalService } from "../security/index.js";
import { redactText } from "../security/redact.js";

export interface TransportLimits {
  /** The largest request body, in bytes. */
  readonly bodyBytes: number;
  /** Requests one authenticated principal may make per minute. */
  readonly perPrincipalPerMinute: number;
  /** Requests one network address may make per minute before it is authenticated (blunts guessing). The address is the connection's own: X-Forwarded-For is never trusted, so behind a reverse proxy every client shares the proxy's allowance. */
  readonly perAddressPerMinute: number;
  /** Long-polls one principal may hold open at once, and all principals together. */
  readonly pollsPerPrincipal: number;
  readonly pollsTotal: number;
  /** The longest a long-poll may wait, in milliseconds. */
  readonly maxWaitMs: number;
  /** Open connections the listener accepts at once; more are refused by the operating system's accept queue. */
  readonly connections: number;
}

/** Provisional limits, adjustable (decision record, 2026-10-20). */
export const DEFAULT_TRANSPORT_LIMITS: TransportLimits = { bodyBytes: 64 * 1024, perPrincipalPerMinute: 600, perAddressPerMinute: 120, pollsPerPrincipal: 4, pollsTotal: 200, maxWaitMs: 25_000, connections: 1000 };

export interface TransportOptions {
  readonly conversations: ConversationService;
  readonly principals: PrincipalService;
  /** The address to bind. Default 127.0.0.1: local only. */
  readonly host?: string;
  /** Default 0: any free port. */
  readonly port?: number;
  /** PEM certificate and key. With them the listener speaks HTTPS. */
  readonly tls?: { readonly cert: string | Buffer; readonly key: string | Buffer };
  /** Remote exposure is opt-in: without this, only loopback addresses can be bound. With it, TLS and `publicHosts` are required. */
  readonly allowRemote?: boolean;
  /** The host names clients use to reach this listener (for example `newt.example.org`). Requests addressed to any other host name are refused, which defeats DNS rebinding. */
  readonly publicHosts?: readonly string[];
  readonly limits?: Partial<TransportLimits>;
  readonly clock?: () => number;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const isLoopback = (host: string): boolean => LOOPBACK.has(host) || /^127(\.\d{1,3}){3}$/.test(host);
const STATUS: Record<DomainErrorCode, number> = {
  invalid_command: 400, command_conflict: 409, stale_revision: 409, not_found: 404, invalid_transition: 409, stale_epoch: 503, integrity: 500, fenced: 409, payload_changed: 409,
  effect_uncertain: 409, effect_busy: 409, wait_closed: 409, unauthenticated: 401, forbidden: 403, unavailable: 503, review_invalid: 409, checkout_changed: 409,
};

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly headers: Record<string, string> = {}, readonly field?: string) { super(message); }
}

/**
 * The conversation transport (card U02b): authenticated HTTPS requests with cursor-based long-polling over the conversation service. The service is the record; this only carries it, so
 * a dropped connection loses nothing and a client resumes from its cursor. Local by default; a remote listener has to be asked for, needs TLS and the host names clients use, and is
 * checked on every request: the credential is authenticated afresh each time (a revoked or disabled client is refused on its very next request), the host name must be one of the
 * listener's own, bodies and rates are bounded, and long-polls are capped per client and overall. Errors never carry the credential or anything that looks like one.
 */
export class ConversationTransport {
  readonly #server: Server;
  readonly #options: TransportOptions;
  readonly #limits: TransportLimits;
  readonly #hosts: Set<string>;
  readonly #windows = new Map<string, { start: number; count: number }>();
  readonly #polls = new Map<string, number>();
  readonly #aborts = new Set<AbortController>();
  readonly #now: () => number;
  #total = 0;
  readonly url: string;
  readonly port: number;

  private constructor(server: Server, options: TransportOptions, limits: TransportLimits, hosts: Set<string>, url: string, port: number) {
    this.#server = server; this.#options = options; this.#limits = limits; this.#hosts = hosts; this.url = url; this.port = port; this.#now = options.clock ?? Date.now;
  }

  static async listen(options: TransportOptions): Promise<ConversationTransport> {
    const host = options.host ?? "127.0.0.1";
    const limits = { ...DEFAULT_TRANSPORT_LIMITS, ...(options.limits ?? {}) };
    const remote = !isLoopback(host);
    if (remote && options.allowRemote !== true) throw new DomainError("invalid_command", `${host} is not a loopback address; remote exposure is off unless it is asked for (allowRemote)`, { field: "host" });
    if (options.allowRemote === true && options.tls === undefined) throw new DomainError("invalid_command", "remote exposure needs TLS (tls.cert and tls.key)", { field: "tls" });
    if (options.allowRemote === true && (options.publicHosts ?? []).length === 0) throw new DomainError("invalid_command", "remote exposure needs publicHosts: the host names clients use", { field: "publicHosts" });
    for (const h of options.publicHosts ?? []) if (typeof h !== "string" || !/^[A-Za-z0-9.-]{1,253}$/.test(h)) throw new DomainError("invalid_command", `publicHosts: ${String(h)} is not a host name`, { field: "publicHosts" });
    const hosts = new Set<string>();
    let transport: ConversationTransport | undefined;
    const handler = (req: IncomingMessage, res: ServerResponse): void => { void transport!.#handle(req, res); };
    const common = { maxHeaderSize: 16 * 1024 };
    const server = options.tls === undefined ? createHttp(common, handler) : createHttps({ ...common, cert: options.tls.cert, key: options.tls.key, minVersion: "TLSv1.2" }, handler);
    server.maxConnections = limits.connections;
    server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5_000;
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? 0, host, () => { server.off("error", reject); resolve(); }); });
    const port = (server.address() as { port: number }).port;
    // The names a request may be addressed to: the loopback names when bound locally, plus any public host names given.
    if (!remote) for (const h of ["127.0.0.1", "localhost", "[::1]"]) hosts.add(`${h}:${port}`);
    // Clients leave the port out of the Host header when it is the default one for the scheme (80 or 443), so the plain name stands for that port.
    for (const h of options.publicHosts ?? []) { hosts.add(`${h.toLowerCase()}:${port}`); if (port === (options.tls === undefined ? 80 : 443)) hosts.add(h.toLowerCase()); }
    const url = `${options.tls === undefined ? "http" : "https"}://${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
    transport = new ConversationTransport(server, options, limits, hosts, url, port);
    return transport;
  }

  /** Stops listening and ends every waiting long-poll. */
  async close(): Promise<void> {
    for (const a of this.#aborts) a.abort();
    await new Promise<void>((resolve) => { this.#server.close(() => resolve()); this.#server.closeAllConnections(); });
  }

  // ---- request handling ----------------------------------------------------------------------------------------------------

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const aborter = new AbortController();
    res.on("close", () => aborter.abort());
    try {
      this.#checkHost(req);
      this.#limit(`addr:${req.socket.remoteAddress ?? "?"}`, this.#limits.perAddressPerMinute);
      const principal = await this.#authenticate(req);
      this.#limit(`principal:${principal.id}`, this.#limits.perPrincipalPerMinute);
      const result = await this.#route(req, principal, aborter);
      this.#send(res, result.status, result.body);
    } catch (error) {
      if (aborter.signal.aborted && res.destroyed) return;
      this.#fail(res, error);
    }
  }

  #checkHost(req: IncomingMessage): void {
    const host = req.headers.host;
    if (host === undefined || !this.#hosts.has(host.toLowerCase())) throw new HttpError(421, "misdirected", "this host name is not one of the listener's own");
  }

  /** Fixed one-minute windows, kept in memory: a restart forgets them, which only ever errs towards allowing a fresh minute. */
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
    // Hosts are workers and services are the controller's own; neither has any business here.
    if (principal.kind === "host" || principal.kind === "service") throw new HttpError(403, "forbidden", "this credential cannot use the conversation API");
    return principal;
  }

  async #body(req: IncomingMessage): Promise<Record<string, unknown>> {
    const type = req.headers["content-type"];
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > this.#limits.bodyBytes) throw new HttpError(413, "too_large", `a request body is at most ${this.#limits.bodyBytes} bytes`);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > this.#limits.bodyBytes) throw new HttpError(413, "too_large", `a request body is at most ${this.#limits.bodyBytes} bytes`);
      chunks.push(chunk as Buffer);
    }
    if (size === 0) return {};
    if (typeof type !== "string" || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type)) throw new HttpError(415, "unsupported_media_type", "send application/json");
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new HttpError(400, "invalid_json", "the body is not valid JSON"); }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "invalid_json", "the body must be a JSON object");
    return parsed as Record<string, unknown>;
  }

  #key(req: IncomingMessage): string {
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || key.length === 0) throw new HttpError(400, "idempotency_key_required", "a request that changes anything needs an Idempotency-Key header, so a retry applies once", {}, "Idempotency-Key");
    return key;
  }

  async #route(req: IncomingMessage, who: Principal, aborter: AbortController): Promise<{ status: number; body?: unknown }> {
    const url = new URL(req.url ?? "/", "http://listener");
    const method = req.method ?? "GET";
    const parts = url.pathname.split("/").filter(Boolean);
    const c = this.#options.conversations;
    const allowed = (...methods: string[]): void => { if (!methods.includes(method)) throw new HttpError(405, "method_not_allowed", `use ${methods.join(" or ")}`, { allow: methods.join(", ") }); };
    if (parts[0] !== "v1") throw new HttpError(404, "not_found", "no such route");
    const [, a, b, d] = parts;
    if (a === "unread" && parts.length === 2) { allowed("GET"); return { status: 200, body: await c.unread(who) }; }
    if (a === "threads" && b === undefined) {
      if (method === "GET") return { status: 200, body: await c.threads(who, { ...this.#page(url) }) };
      allowed("GET", "POST");
      const body = await this.#body(req);
      const r = await c.start(who, { ...body, commandId: this.#key(req) } as never);
      return { status: r.replayed ? 200 : 201, body: r };
    }
    if (a === "threads" && b !== undefined && d === undefined && parts.length === 3) {
      allowed("GET");
      const t = await c.thread(who, b);
      if (t === undefined) throw new HttpError(404, "not_found", "no such thread");
      return { status: 200, body: t };
    }
    if (a === "threads" && b !== undefined && d === "messages" && parts.length === 4) {
      if (method === "GET") return { status: 200, body: await this.#read(who, b, url, aborter) };
      allowed("GET", "POST");
      const body = await this.#body(req);
      const r = await c.send(who, { ...body, commandId: this.#key(req), threadId: b } as never);
      return { status: r.replayed ? 200 : 201, body: r };
    }
    if (a === "threads" && b !== undefined && d === "ack" && parts.length === 4) {
      allowed("POST");
      const body = await this.#body(req);
      return { status: 200, body: await c.acknowledge(who, { commandId: this.#key(req), threadId: b, upToSeq: body["upToSeq"] as number }) };
    }
    if (a === "threads" && b !== undefined && d === "close" && parts.length === 4) {
      allowed("POST");
      const body = await this.#body(req);
      await c.close(who, { commandId: this.#key(req), threadId: b, expectedRevision: body["expectedRevision"] as number });
      return { status: 204 };
    }
    if (a === "messages" && b !== undefined && d === "handled" && parts.length === 4) {
      allowed("POST");
      await this.#body(req);
      await c.markHandled(who, { commandId: this.#key(req), messageId: b });
      return { status: 204 };
    }
    throw new HttpError(404, "not_found", "no such route");
  }

  #page(url: URL): { afterId?: string; limit?: number } {
    const after = url.searchParams.get("after");
    const limit = url.searchParams.get("limit");
    return { ...(after === null ? {} : { afterId: after }), ...(limit === null ? {} : { limit: this.#int(limit, "limit") }) };
  }

  #int(value: string, field: string): number {
    if (!/^\d{1,9}$/.test(value)) throw new HttpError(400, "invalid_command", `${field} must be a whole number`, {}, field);
    return Number(value);
  }

  /** Reads a thread after a cursor; with `wait`, holds the request open (up to the limit) until something new arrives. Capped per client and overall. */
  async #read(who: Principal, threadId: string, url: URL, aborter: AbortController) {
    const c = this.#options.conversations;
    const after = url.searchParams.get("after");
    const limit = url.searchParams.get("limit");
    const wait = url.searchParams.get("wait") === null ? 0 : Math.min(this.#int(url.searchParams.get("wait")!, "wait"), this.#limits.maxWaitMs);
    const query = { threadId, ...(after === null ? {} : { afterSeq: this.#int(after, "after") }), ...(limit === null ? {} : { limit: this.#int(limit, "limit") }) };
    let result = await c.read(who, query);
    if (result === undefined) throw new HttpError(404, "not_found", "no such thread");
    if (result.items.length > 0 || wait === 0) return result;
    const mine = this.#polls.get(who.id) ?? 0;
    if (mine >= this.#limits.pollsPerPrincipal || this.#total >= this.#limits.pollsTotal) throw new HttpError(503, "too_many_polls", "too many long-polls are open; try again shortly", { "retry-after": "5" });
    this.#polls.set(who.id, mine + 1); this.#total += 1; this.#aborts.add(aborter);
    try {
      const deadline = this.#now() + wait;
      while (!aborter.signal.aborted && this.#now() < deadline && result !== undefined && result.items.length === 0) {
        await new Promise<void>((resolve) => { const t = setTimeout(resolve, Math.min(250, Math.max(1, deadline - this.#now()))); aborter.signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true }); });
        if (aborter.signal.aborted) break;
        result = await c.read(who, query);
      }
      if (result === undefined) throw new HttpError(404, "not_found", "no such thread");
      return result;
    } finally {
      const left = (this.#polls.get(who.id) ?? 1) - 1; if (left <= 0) this.#polls.delete(who.id); else this.#polls.set(who.id, left); this.#total -= 1; this.#aborts.delete(aborter);
    }
  }

  // ---- responses -----------------------------------------------------------------------------------------------------------

  #send(res: ServerResponse, status: number, body?: unknown, extra: Record<string, string> = {}): void {
    const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra };
    if (status === 204 || body === undefined) { res.writeHead(status, headers); res.end(); return; }
    const text = JSON.stringify(body);
    res.writeHead(status, { ...headers, "content-type": "application/json; charset=utf-8", "content-length": String(Buffer.byteLength(text)) });
    res.end(text);
  }

  #fail(res: ServerResponse, error: unknown): void {
    if (res.headersSent) { res.destroy(); return; }
    if (error instanceof HttpError) return this.#send(res, error.status, { error: { code: error.code, message: error.message, ...(error.field === undefined ? {} : { field: error.field }) } }, error.headers);
    if (error instanceof DomainError) {
      const status = STATUS[error.code] ?? 500;
      // A fault of ours (storage integrity, a lost epoch) is described without detail: its message can name internal records.
      if (status >= 500 && error.code !== "unavailable") return this.#send(res, status, { error: { code: error.code, message: "the request could not be completed" } }, status === 503 ? { "retry-after": "5" } : {});
      return this.#send(res, status, { error: { code: error.code, message: redactText(error.message), ...(error.field === undefined ? {} : { field: error.field }), ...(error.currentRevision === undefined ? {} : { currentRevision: error.currentRevision }) } }, status === 503 ? { "retry-after": "5" } : {});
    }
    // Anything else is a fault of ours: say so without detail.
    return this.#send(res, 500, { error: { code: "internal", message: "the request could not be completed" } });
  }
}
