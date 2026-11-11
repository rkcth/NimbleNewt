import { timingSafeEqual } from "node:crypto";
import { createServer as createHttp, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttps } from "node:https";
import { isIP } from "node:net";
import type { ApplyResult, CallOptions, TurnResult } from "../chat/index.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import type { Principal } from "../security/index.js";
import { redactText } from "../security/redact.js";
import { checkBinding, remoteAllowed, type WebNetwork } from "./binding.js";
import { bucketOfAddress, checkTrustedProxy, clientAddress, type ResolvedProxy, type TrustedProxy } from "./proxy.js";
import { DEFAULT_SESSION_LIMITS, WebSessionStore, type WebSession, type WebSessionLimits } from "./sessions.js";

/** A file the door serves without a session: the page and its script and style. */
export interface WebAsset { readonly type: string; readonly body: string }
/** The served files by path. `/` is required. The UI package supplies them (`webChatAssets()` in `@nimblenewt/ui`); the controller does not depend on it. */
export type WebAssets = Readonly<Record<string, WebAsset>>;

/** What the door needs of the controller: the same services the in-process chat uses, nothing wider. */
export interface WebChatBackend {
  authenticate(token: string): Promise<Principal>;
  submit(token: string, message: { messageId: string; text: string }, options?: CallOptions): Promise<TurnResult>;
  applyProposal(token: string, request: { commandId: string; proposalId: string }, options?: CallOptions): Promise<ApplyResult>;
  discardProposal(token: string, request: { commandId: string; proposalId: string }, options?: CallOptions): Promise<{ proposalId: string; replayed: boolean }>;
  /** The state API's read operations only; the door sends nothing but the fixed view queries below. */
  query(token: string, op: string, args: Record<string, unknown>): Promise<{ ok: true; result: unknown } | { ok: false; error: { code: string; message: string } }>;
}

export interface WebChatLimits {
  readonly bodyBytes: number;
  /** Requests one session may make per minute. */
  readonly perSessionPerMinute: number;
  /** Failed sign-ins from one client address per minute (an IPv6 client counts as its /64). */
  readonly failedLoginsPerAddressPerMinute: number;
  /** Failed sign-ins from ALL addresses together per minute: the ceiling that stops a flood from many addresses (or from behind a proxy that hides them). Generous, so a few strangers cannot reach it. */
  readonly failedLoginsGlobalPerMinute: number;
  /** Sign-in bodies being read at once, from one client address and in all. */
  readonly loginsReadingPerAddress: number;
  readonly loginsReadingGlobal: number;
}
export const DEFAULT_WEB_LIMITS: WebChatLimits = { bodyBytes: 16 * 1024, perSessionPerMinute: 300, failedLoginsPerAddressPerMinute: 10, failedLoginsGlobalPerMinute: 100, loginsReadingPerAddress: 8, loginsReadingGlobal: 64 };

export interface WebChatOptions {
  readonly backend: WebChatBackend;
  readonly assets: WebAssets;
  /** The address to listen on: an IP literal. Required; there is no default. */
  readonly host: string;
  /** Where the listener may be reached from. Required: `loopback` (this machine; a TLS proxy on it may front it) or `private` (an address on a private network, with TLS). Never public. */
  readonly network: WebNetwork;
  readonly port?: number;
  readonly tls?: { readonly cert: string | Buffer; readonly key: string | Buffer };
  /** TLS is ended by a proxy on this machine in front of a loopback listener (`tailscale serve`): cookies are Secure and HSTS is sent. */
  readonly behindTlsProxy?: boolean;
  /** The host names clients use (`newt.tailnet-name.ts.net`). A request for any other host name is refused, which defeats DNS rebinding. */
  readonly publicHosts?: readonly string[];
  /** OFF unless given. A proxy in front of the listener (`tailscale serve`, Caddy, nginx) makes every client look like the proxy; naming it here lets the door take the client's address from ONE forwarded header, but only on connections that come from the proxy itself. */
  readonly trustedProxy?: TrustedProxy;
  readonly limits?: Partial<WebChatLimits>;
  readonly session?: Partial<WebSessionLimits>;
  /** Milliseconds; for tests. */
  readonly clock?: () => number;
}

/** The counter key of the ceiling over all addresses. */
const GLOBAL_LOGIN = "global:login";
/** The counter key of pairing-code attempts over all addresses: a valid code skips GLOBAL_LOGIN, but no code is ever tried past this one. */
const GLOBAL_CODE = "global:code";

export interface WebBrowser { readonly handle: string; readonly label: string; readonly current: boolean; readonly createdAt: string; readonly lastSeen: string }
export interface WebSettings {
  readonly url: string; readonly host: string; readonly port: number; readonly network: WebNetwork; readonly tls: boolean; readonly behindTlsProxy: boolean; readonly publicHosts: readonly string[];
  readonly trustedProxy: { readonly enabled: false } | { readonly enabled: true; readonly addresses: readonly string[]; readonly header: string };
  readonly limits: WebChatLimits; readonly session: WebSessionLimits;
}

/** A short name for a browser from its User-Agent ("Safari on iPhone"), so the owner can name it in words. Nothing else of the header is kept. */
export function deviceLabel(userAgent: string): string {
  const ua = userAgent.slice(0, 400);
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Macintosh|Mac OS X/.test(ua) ? "Mac" : /CrOS/.test(ua) ? "Chromebook" : /Linux|X11/.test(ua) ? "Linux" : undefined;
  const app = /Edg(?:e|A|iOS)?\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox\/|FxiOS\//.test(ua) ? "Firefox" : /Chrome\/|CriOS\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : undefined;
  if (app === undefined && os === undefined) return "browser";
  return app === undefined ? `browser on ${os}` : os === undefined ? app : `${app} on ${os}`;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly headers: Record<string, string> = {}) { super(message); }
}

const STATUS: Partial<Record<DomainErrorCode, number>> = { invalid_command: 400, command_conflict: 409, stale_revision: 409, not_found: 404, invalid_transition: 409, unauthenticated: 401, forbidden: 403, unavailable: 503, payload_changed: 409, effect_uncertain: 409, effect_busy: 409 };

const VIEWS: Readonly<Record<string, readonly { readonly key: string; readonly op: string; readonly args: Record<string, unknown> }[]>> = {
  status: [{ key: "overview", op: "status.ask", args: { request: { kind: "overview", limit: 20 } } }],
  "needs-you": [{ key: "needsYou", op: "status.ask", args: { request: { kind: "needs_you", limit: 20 } } }],
  blockers: [{ key: "needsYou", op: "status.ask", args: { request: { kind: "needs_you", limit: 20 } } }, { key: "attention", op: "status.attention", args: { limit: 20 } }],
  cost: [{ key: "usage", op: "budget.usage", args: {} }, { key: "pending", op: "budget.pending", args: {} }],
  recovery: [{ key: "attention", op: "status.attention", args: { limit: 20 } }, { key: "jobs", op: "status.ask", args: { request: { kind: "jobs", limit: 20 } } }, { key: "reconnect", op: "status.ask", args: { request: { kind: "reconnect", limit: 20 } } }],
};
export const WEB_VIEWS: readonly string[] = Object.keys(VIEWS);

const MESSAGE_ID = /^[A-Za-z0-9._-]{1,100}$/;
const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY", "cross-origin-opener-policy": "same-origin", "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

/**
 * The web chat door (card U07): the responsive browser page and the small authenticated API behind it. It is a second listener, apart from the conversation transport, with its own explicit binding.
 *
 * - Binding: `host` and `network` are required; the address has to agree with the stated network and is never public (see `checkBinding`). Every request is also refused when its remote address
 *   is outside that network, and when its Host header is not one of the listener's own names.
 * - Sign-in: the owner's credential, or a one-time pairing code made from a signed-in browser. The cookie is HttpOnly and SameSite=Strict (Secure over TLS or behind a TLS proxy); the page
 *   never sees the credential after the sign-in. A change needs the session's CSRF header and a same-origin Origin, and JSON.
 * - Sessions end by idle time, by an absolute limit, by sign-out, by the owner revoking one or all from another browser, and at once when the credential is rotated or disabled (it is checked on every request).
 * - Resume: a message carries the browser's own `messageId`; the chat records the turn under it, so the browser sends it again after a dropped connection and the second send returns the first
 *   turn instead of running the commands again. Two requests with the same id at the same moment share one run.
 */
export class WebChatDoor {
  readonly #server: Server;
  readonly #o: WebChatOptions;
  readonly #limits: WebChatLimits;
  readonly #hosts = new Set<string>();
  readonly #sessions: WebSessionStore;
  readonly #windows = new Map<string, { start: number; count: number }>();
  readonly #inflight = new Map<string, Promise<TurnResult>>();
  readonly #proxy: ResolvedProxy | undefined;
  readonly #reading = new Map<string, number>();
  readonly #revoked = new Map<string, { payload: string; result: { readonly revoked: number; readonly labels: readonly string[] } }>();
  #readingAll = 0;
  readonly #secure: boolean;
  readonly #cookieName: string;
  readonly #now: () => number;
  readonly url: string;
  readonly port: number;

  private constructor(server: Server, o: WebChatOptions, limits: WebChatLimits, secure: boolean, url: string, port: number) {
    this.#server = server; this.#o = o; this.#limits = limits; this.#secure = secure; this.url = url; this.port = port;
    this.#now = o.clock ?? Date.now;
    this.#proxy = checkTrustedProxy(o.trustedProxy, o.network);
    this.#sessions = new WebSessionStore({ ...DEFAULT_SESSION_LIMITS, ...(o.session ?? {}) }, this.#now);
    this.#cookieName = secure ? "__Host-nn_session" : "nn_session";
  }

  static async listen(o: WebChatOptions): Promise<WebChatDoor> {
    const publicHosts = o.publicHosts ?? [];
    checkBinding({ host: o.host, network: o.network, tls: o.tls !== undefined, behindTlsProxy: o.behindTlsProxy === true, publicHosts });
    checkTrustedProxy(o.trustedProxy, o.network);
    if (o.assets["/"] === undefined) throw new DomainError("invalid_command", "assets must include the page at \"/\"", { field: "assets" });
    const limits = { ...DEFAULT_WEB_LIMITS, ...(o.limits ?? {}) };
    const secure = o.tls !== undefined || o.behindTlsProxy === true;
    let door: WebChatDoor | undefined;
    const handler = (req: IncomingMessage, res: ServerResponse): void => { void door!.#handle(req, res); };
    const common = { maxHeaderSize: 16 * 1024 };
    const bindHost = o.host === "localhost" ? "127.0.0.1" : o.host;
    const server = o.tls === undefined ? createHttp(common, handler) : createHttps({ ...common, cert: o.tls.cert, key: o.tls.key, minVersion: "TLSv1.2" }, handler);
    server.maxConnections = 200;
    server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5_000;
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(o.port ?? 0, bindHost, () => { server.off("error", reject); resolve(); }); });
    const port = (server.address() as { port: number }).port;
    const url = `${o.tls === undefined ? "http" : "https"}://${isIP(bindHost) === 6 ? `[${bindHost}]` : bindHost}:${port}`;
    door = new WebChatDoor(server, o, limits, secure, url, port);
    if (o.network === "loopback") for (const h of ["127.0.0.1", "localhost", "[::1]"]) door.#hosts.add(`${h}:${port}`);
    else door.#hosts.add(`${isIP(bindHost) === 6 ? `[${bindHost}]` : bindHost}:${port}`);
    // A proxy forwards the client's own Host header, and clients leave the default port out of it.
    for (const h of publicHosts) { door.#hosts.add(`${h.toLowerCase()}:${port}`); door.#hosts.add(h.toLowerCase()); }
    return door;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => { this.#server.close(() => resolve()); this.#server.closeAllConnections(); });
  }

  /** For the host's own start-up script: a pairing code for a given owner credential, to show on the terminal (the phone types it instead of the credential). */
  async createPairing(ownerToken: string): Promise<{ code: string; expiresAt: string }> {
    const who = await this.#o.backend.authenticate(ownerToken);
    if (who.kind !== "owner") throw new DomainError("forbidden", "only the owner pairs a browser");
    const p = this.#sessions.pair(who.id, ownerToken);
    return { code: p.code, expiresAt: new Date(p.expiresAt).toISOString() };
  }

  /** Ends every browser session of the owner (the host's emergency stop; the same as revoking all from the page). */
  revokeAll(ownerId: string): number { return this.#sessions.revokeAll(ownerId); }

  // ---- requests ------------------------------------------------------------------------------------------------------------

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const host = req.headers.host;
      if (host === undefined || !this.#hosts.has(host.toLowerCase())) throw new HttpError(421, "misdirected", "this host name is not one of the listener's own");
      if (!remoteAllowed(this.#o.network, req.socket.remoteAddress)) throw new HttpError(403, "forbidden", "this address is outside the network the web chat serves");
      const url = new URL(req.url ?? "/", "http://listener");
      const method = req.method ?? "GET";
      if (url.pathname.startsWith("/web/")) return await this.#api(req, res, url, method);
      if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "method_not_allowed", "use GET", { allow: "GET, HEAD" });
      const asset = this.#o.assets[url.pathname];
      if (asset === undefined) throw new HttpError(404, "not_found", "no such page");
      const body = Buffer.from(asset.body, "utf8");
      res.writeHead(200, { ...this.#headers(), "content-type": asset.type, "content-length": String(body.length), "cache-control": "no-cache" });
      res.end(method === "HEAD" ? undefined : body);
    } catch (error) { this.#fail(res, error); }
  }

  async #api(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<void> {
    const parts = url.pathname.split("/").filter(Boolean).slice(1);
    const [a, b, c] = parts;
    const allowed = (...m: string[]): void => { if (!m.includes(method)) throw new HttpError(405, "method_not_allowed", `use ${m.join(" or ")}`, { allow: m.join(", ") }); };
    if (method !== "GET") this.#sameOrigin(req);

    if (a === "login" && parts.length === 1) {
      allowed("POST");
      return this.#login(req, res);
    }

    const cookie = this.#cookie(req);
    const session = this.#sessions.lookup(cookie);
    if (session === undefined) throw new HttpError(401, "unauthenticated", "sign in first", { "set-cookie": this.#setCookie("", 0) });
    this.#limit(`session:${session.handle}`, this.#limits.perSessionPerMinute);
    // The credential behind the session is checked again every time: a rotated, disabled or removed owner ends the session here.
    let who: Principal;
    try { who = await this.#authenticate(session.token); } catch (error) {
      if (error instanceof HttpError && error.status === 401) { this.#sessions.revokeHandle(session.principalId, session.handle); throw new HttpError(401, "unauthenticated", "the session ended; sign in again", { "set-cookie": this.#setCookie("", 0) }); }
      throw error;
    }
    if (who.kind !== "owner") { this.#sessions.revokeHandle(session.principalId, session.handle); throw new HttpError(403, "forbidden", "the web chat is the owner's"); }
    if (method !== "GET" && !this.#csrfOk(req, session)) throw new HttpError(403, "csrf", "the request did not carry this session's CSRF header");

    if (a === "session" && parts.length === 1) { allowed("GET"); return this.#reply(res, 200, this.#sessionBody(session, who)); }
    if (a === "logout" && parts.length === 1) { allowed("POST"); this.#sessions.revokeHandle(session.principalId, session.handle); return this.#reply(res, 200, { ok: true }, { "set-cookie": this.#setCookie("", 0) }); }
    if (a === "sessions" && b === undefined) {
      allowed("GET");
      return this.#reply(res, 200, { sessions: this.browsers(who.id, session.handle) });
    }
    if (a === "settings" && parts.length === 1) {
      allowed("GET");
      const mine = this.#client(req);
      return this.#reply(res, 200, { ...this.settings(), yourAddress: mine.address, addressFromProxy: mine.viaProxy, browsers: this.#sessions.list(who.id).length });
    }
    if (a === "sessions" && b === "revoke" && c === undefined) {
      allowed("POST");
      const body = await this.#body(req);
      if (body["all"] === true) return this.#reply(res, 200, { revoked: this.#sessions.revokeAll(who.id, session.handle) });
      if (typeof body["handle"] !== "string") throw new HttpError(400, "invalid_command", "name a session handle, or all: true");
      const own = body["handle"] === session.handle;
      const ended = this.#sessions.revokeHandle(who.id, body["handle"]);
      if (!ended) throw new HttpError(404, "not_found", "no such session");
      return this.#reply(res, 200, { revoked: 1 }, own ? { "set-cookie": this.#setCookie("", 0) } : {});
    }
    if (a === "pairings" && b === undefined) {
      allowed("POST");
      const p = this.#sessions.pair(who.id, session.token, session.handle);
      return this.#reply(res, 201, { code: p.code, expiresAt: new Date(p.expiresAt).toISOString() });
    }
    if (a === "chat" && b === undefined) {
      allowed("POST");
      const body = await this.#body(req);
      const messageId = body["messageId"], text = body["text"];
      if (typeof messageId !== "string" || !MESSAGE_ID.test(messageId)) throw new HttpError(400, "invalid_command", "messageId must be 1 to 100 letters, digits, dots, dashes or underscores");
      if (typeof text !== "string") throw new HttpError(400, "invalid_command", "text must be text");
      // The same message sent twice at once (a retry while the first is still running) is one run.
      const key = `${who.id}\u0000${messageId}`;
      let run = this.#inflight.get(key);
      if (run === undefined) { run = this.#o.backend.submit(session.token, { messageId, text }, { stillAllowed: this.#stillLive(session) }).finally(() => { this.#inflight.delete(key); }); this.#inflight.set(key, run); }
      const turn = await run;
      return this.#reply(res, turn.replayed ? 200 : 201, { turnId: turn.turnId, replayed: turn.replayed, reply: turn.reply, outcomes: turn.outcomes });
    }
    if (a === "proposals" && b !== undefined && (c === "apply" || c === "discard") && parts.length === 3) {
      allowed("POST");
      const commandId = req.headers["idempotency-key"];
      if (typeof commandId !== "string" || !MESSAGE_ID.test(commandId)) throw new HttpError(400, "idempotency_key_required", "an approval needs an Idempotency-Key header (1 to 100 letters, digits, dots, dashes or underscores), so a retry applies once");
      await this.#body(req);
      const options = { stillAllowed: this.#stillLive(session) };
      const result = c === "apply" ? await this.#o.backend.applyProposal(session.token, { commandId, proposalId: b }, options) : await this.#o.backend.discardProposal(session.token, { commandId, proposalId: b }, options);
      return this.#reply(res, 200, result);
    }
    if (a === "views" && b !== undefined && c === undefined) {
      allowed("GET");
      const spec = Object.hasOwn(VIEWS, b) ? VIEWS[b] : undefined;
      if (spec === undefined) throw new HttpError(404, "not_found", "no such view");
      const parts2: Record<string, unknown> = {};
      for (const p of spec) {
        const r = await this.#o.backend.query(session.token, p.op, p.args);
        parts2[p.key] = r.ok ? r.result : { error: { code: r.error.code, message: redactText(r.error.message) } };
      }
      return this.#reply(res, 200, { view: b, observedAt: new Date(this.#now()).toISOString(), parts: parts2 });
    }
    throw new HttpError(404, "not_found", "no such route");
  }

  /**
   * Sign-in (card U07, U07b). The limiter is two-level: failures count against the client's own address (an IPv6 client against its /64) AND against a generous ceiling over all addresses, so one peer
   * cannot hold the owner out and a flood from many addresses (or from behind a proxy that hides them) still cannot guess without bound. A pairing code (50 bits, once, five minutes) is only looked at
   * while its sender is inside its own allowance and code attempts over all addresses are under ten times the ceiling; inside those, a valid one signs in although wrong credentials have filled the
   * ordinary ceiling: the owner's way in survives a flood of wrong credentials. The owner's credential is the path that a full ceiling closes; the terminal chat is a different door and is never affected.
   */
  async #login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const client = this.#client(req);
    const addr = `addr:${bucketOfAddress(client.address)}`;
    // Reading a body is bounded per address and overall, so a flood (or a slow sender) cannot hold every reader.
    if ((this.#reading.get(addr) ?? 0) >= this.#limits.loginsReadingPerAddress || this.#readingAll >= this.#limits.loginsReadingGlobal) throw new HttpError(429, "rate_limited", "too many sign-in attempts at once; wait a minute", { "retry-after": "5" });
    this.#reading.set(addr, (this.#reading.get(addr) ?? 0) + 1); this.#readingAll += 1;
    let body: Record<string, unknown>;
    try { body = await this.#body(req); } finally {
      this.#readingAll -= 1;
      const left = (this.#reading.get(addr) ?? 1) - 1;
      if (left <= 0) this.#reading.delete(addr); else this.#reading.set(addr, left);
    }
    // From here to the credential check nothing is awaited between the check and the count: attempts sent all at once cannot pass the limit together.
    let token: string | undefined;
    let free = false;
    if (typeof body["code"] === "string") {
      // A code is looked at only inside the limits: the client's own allowance, and a hard ceiling on code attempts over all addresses (ten times the failure ceiling). Without this a client past
      // every limit still had each guess tried (a wrong one answered 429, the right one signed in), so the limiter did nothing against guessing. A valid code skips only the ordinary ceiling, which
      // a flood of wrong credentials fills; a code that is checked here is never used up by the refusal, so the owner can use it once the minute has passed.
      const codeCeiling = this.#limits.failedLoginsGlobalPerMinute * 10;
      this.#over(addr, this.#limits.failedLoginsPerAddressPerMinute);
      this.#over(GLOBAL_CODE, codeCeiling);
      this.#count(addr); this.#count(GLOBAL_CODE);
      const paired = this.#sessions.redeem(body["code"]);
      if (paired !== undefined) { token = paired.token; free = true; this.#refund(addr); this.#refund(GLOBAL_CODE); }
      else {
        // A wrong code is a failed sign-in like any other: it stays counted against the address and the code ceiling, and against the ordinary ceiling too.
        this.#over(GLOBAL_LOGIN, this.#limits.failedLoginsGlobalPerMinute);
        this.#count(GLOBAL_LOGIN);
        throw new HttpError(401, "unauthenticated", "the code was not accepted");
      }
    }
    if (!free) {
      this.#over(addr, this.#limits.failedLoginsPerAddressPerMinute);
      this.#over(GLOBAL_LOGIN, this.#limits.failedLoginsGlobalPerMinute);
      // The attempt is counted before anything is awaited and given back only when it succeeds.
      this.#count(addr); this.#count(GLOBAL_LOGIN);
      if (typeof body["token"] === "string") token = body["token"];
      else throw new HttpError(400, "invalid_command", "send a token or a pairing code");
    }
    let who: Principal;
    try { who = await this.#authenticate(token!); } catch (error) {
      if (free) { this.#count(addr); this.#count(GLOBAL_LOGIN); }
      throw error;
    }
    // Only the owner signs in: any other credential gets no session and no CSRF token, and the attempt stays counted.
    if (who.kind !== "owner") { if (free) { this.#count(addr); this.#count(GLOBAL_LOGIN); } throw new HttpError(403, "forbidden", "the web chat is the owner's"); }
    if (!free) { this.#refund(addr); this.#refund(GLOBAL_LOGIN); }
    // A browser that signs in again does not leave its old session behind.
    this.#sessions.revokeCookie(this.#cookie(req));
    const { cookie, session } = this.#sessions.create(who.id, token!, deviceLabel(String(req.headers["user-agent"] ?? "")));
    return this.#reply(res, 200, this.#sessionBody(session, who), { "set-cookie": this.#setCookie(cookie, Math.floor((this.#sessions.endsAt(session) - this.#now()) / 1000)) });
  }

  /** The client address of a request: the peer, or (only from a trusted proxy's own address) the one forwarded header's rightmost untrusted entry. */
  #client(req: IncomingMessage): { readonly address: string; readonly viaProxy: boolean } { return clientAddress(req.socket.remoteAddress, req.headers, this.#proxy); }

  /** Whether a long request's browser session is still the owner's: asked again before the state-changing steps of a chat request. */
  #stillLive(session: WebSession): () => Promise<void> {
    return async () => {
      const ended = (): HttpError => new HttpError(401, "unauthenticated", "the session ended while the request ran; nothing further was applied", { "set-cookie": this.#setCookie("", 0) });
      if (!this.#sessions.isLive(session.handle)) throw ended();
      let who: Principal;
      try { who = await this.#authenticate(session.token); } catch (error) { if (error instanceof HttpError && error.status === 401) throw ended(); throw error; }
      if (who.kind !== "owner" || !this.#sessions.isLive(session.handle)) throw ended();
    };
  }

  // ---- for the owner's chat and the settings view ----------------------------------------------------------------------------------

  /** What the web chat is set to (nothing secret): the owner reads it on the Settings view and in chat. */
  settings(): WebSettings {
    const o = this.#o;
    return {
      url: this.url, host: o.host, port: this.port, network: o.network, tls: o.tls !== undefined, behindTlsProxy: o.behindTlsProxy === true, publicHosts: [...(o.publicHosts ?? [])],
      trustedProxy: this.#proxy === undefined ? { enabled: false } : { enabled: true, addresses: [...this.#proxy.addresses], header: this.#proxy.header },
      limits: { ...this.#limits }, session: { ...DEFAULT_SESSION_LIMITS, ...(o.session ?? {}) },
    };
  }

  /** The signed-in browsers of the owner, newest first. */
  browsers(ownerId: string, currentHandle?: string): readonly WebBrowser[] {
    return this.#sessions.list(ownerId).map((s) => ({ handle: s.handle, label: s.label, current: s.handle === currentHandle, createdAt: new Date(s.createdAt).toISOString(), lastSeen: new Date(s.lastSeen).toISOString() }));
  }

  /**
   * Signs browsers out in the owner's own words: `all` (every one, and the unused pairing codes), or the one whose label or handle holds `browser` (case does not matter). No match is not_found; several matches are
   * refused with their labels and last use, so the owner says which. `exceptHandle` keeps the browser that asked (the page's "all other browsers").
   */
  revokeBrowsers(ownerId: string, want: { readonly browser?: string; readonly all?: boolean }, exceptHandle?: string, commandId?: string): { readonly revoked: number; readonly labels: readonly string[]; readonly replayed?: boolean } {
    // The same command ID again returns the first answer and signs nobody else out (a browser that signed in since must not be ended by a repeat).
    const memoKey = commandId === undefined ? undefined : `${ownerId}\u0000${commandId}`;
    const payload = JSON.stringify([want.browser ?? null, want.all === true]);
    if (memoKey !== undefined) {
      const seen = this.#revoked.get(memoKey);
      if (seen !== undefined) {
        if (seen.payload !== payload) throw new DomainError("command_conflict", "that command ID was used for a different sign-out");
        return { ...seen.result, replayed: true };
      }
    }
    const result = this.#revokeBrowsers(ownerId, want, exceptHandle);
    if (memoKey !== undefined) { this.#revoked.set(memoKey, { payload, result }); if (this.#revoked.size > 200) this.#revoked.delete(this.#revoked.keys().next().value as string); }
    return result;
  }

  #revokeBrowsers(ownerId: string, want: { readonly browser?: string; readonly all?: boolean }, exceptHandle?: string): { readonly revoked: number; readonly labels: readonly string[] } {
    const all = this.browsers(ownerId, exceptHandle);
    if (want.all === true) { const labels = all.filter((b) => !b.current).map((b) => b.label); return { revoked: this.#sessions.revokeAll(ownerId, exceptHandle), labels }; }
    const words = typeof want.browser === "string" ? want.browser.trim().toLowerCase() : "";
    if (words.length === 0) throw new DomainError("invalid_command", "say which browser to sign out (a word from its name, such as iPhone), or all of them", { field: "browser" });
    const found = all.filter((b) => b.handle === want.browser!.trim() || b.label.toLowerCase().includes(words));
    if (found.length === 0) throw new DomainError("not_found", `no signed-in browser matches "${words.slice(0, 60)}"`, { field: "browser" });
    if (found.length > 1) throw new DomainError("invalid_command", `${found.length} browsers match "${words.slice(0, 60)}": ${found.slice(0, 6).map((b) => `${b.label} ${b.handle} (last used ${b.lastSeen})`).join("; ")}. Say which one (its ws- name), or sign them all out`, { field: "browser" });
    this.#sessions.revokeHandle(ownerId, found[0]!.handle);
    return { revoked: 1, labels: [found[0]!.label] };
  }

  // ---- pieces --------------------------------------------------------------------------------------------------------------

  async #authenticate(token: string): Promise<Principal> {
    try { return await this.#o.backend.authenticate(token); } catch (error) {
      if (error instanceof DomainError && error.code === "unauthenticated") throw new HttpError(401, "unauthenticated", "the credential was not accepted");
      throw error;
    }
  }

  #sessionBody(s: WebSession, who: Principal): Record<string, unknown> {
    return { authenticated: true, owner: who.name, handle: s.handle, csrf: s.csrf, expiresAt: new Date(this.#sessions.expiresAt(s)).toISOString(), views: WEB_VIEWS };
  }

  #cookie(req: IncomingMessage): string | undefined {
    const header = req.headers.cookie;
    if (typeof header !== "string") return undefined;
    for (const part of header.split(";")) {
      const i = part.indexOf("=");
      if (i > 0 && part.slice(0, i).trim() === this.#cookieName) return part.slice(i + 1).trim();
    }
    return undefined;
  }

  #setCookie(value: string, maxAgeSeconds: number): string {
    return `${this.#cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, maxAgeSeconds)}${this.#secure ? "; Secure" : ""}`;
  }

  /** A change must come from a page of this listener: the Origin (when sent) is one of its own names, and a cross-site fetch is refused. */
  #sameOrigin(req: IncomingMessage): void {
    const origin = req.headers.origin;
    const scheme = this.#secure ? "https" : "http";
    if (origin !== undefined && ![...this.#hosts].some((h) => origin.toLowerCase() === `${scheme}://${h}`)) throw new HttpError(403, "forbidden", "this origin is not one of the listener's own");
    const site = req.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin" && site !== "none") throw new HttpError(403, "forbidden", "a cross-site request is refused");
  }

  #csrfOk(req: IncomingMessage, s: WebSession): boolean {
    const given = req.headers["x-nn-csrf"];
    if (typeof given !== "string") return false;
    const a = Buffer.from(given), b = Buffer.from(s.csrf);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async #body(req: IncomingMessage): Promise<Record<string, unknown>> {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > this.#limits.bodyBytes) throw new HttpError(413, "too_large", `a request body is at most ${this.#limits.bodyBytes} bytes`);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > this.#limits.bodyBytes) throw new HttpError(413, "too_large", `a request body is at most ${this.#limits.bodyBytes} bytes`);
      chunks.push(chunk as Buffer);
    }
    const type = req.headers["content-type"];
    if (typeof type !== "string" || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type)) throw new HttpError(415, "unsupported_media_type", "send application/json");
    if (size === 0) return {};
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new HttpError(400, "invalid_json", "the body is not valid JSON"); }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "invalid_json", "the body must be a JSON object");
    return parsed as Record<string, unknown>;
  }

  #over(key: string, max: number): void {
    const w = this.#windows.get(key);
    if (w !== undefined && this.#now() - w.start < 60_000 && w.count >= max) throw new HttpError(429, "rate_limited", "too many attempts; wait a minute", { "retry-after": String(Math.max(1, Math.ceil((60_000 - (this.#now() - w.start)) / 1000))) });
  }

  /** Counts one event in the key's current one-minute window; the new count. */
  #count(key: string): number {
    const now = this.#now();
    const w = this.#windows.get(key);
    if (w === undefined || now - w.start >= 60_000) {
      this.#windows.set(key, { start: now, count: 1 });
      if (this.#windows.size > 5000) for (const [k, v] of this.#windows) if (now - v.start >= 60_000) this.#windows.delete(k);
      return 1;
    }
    w.count += 1;
    return w.count;
  }

  /** Gives back one counted event (a sign-in that succeeded). */
  #refund(key: string): void { const w = this.#windows.get(key); if (w !== undefined && w.count > 0) w.count -= 1; }

  #limit(key: string, max: number): void { if (this.#count(key) > max) throw new HttpError(429, "rate_limited", "too many requests; slow down", { "retry-after": "5" }); }

  #headers(): Record<string, string> { return { ...SECURITY_HEADERS, ...(this.#secure ? { "strict-transport-security": "max-age=31536000" } : {}) }; }

  #reply(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { ...this.#headers(), "cache-control": "no-store", "content-type": "application/json; charset=utf-8", "content-length": String(Buffer.byteLength(text)), ...extra });
    res.end(text);
  }

  #fail(res: ServerResponse, error: unknown): void {
    if (res.headersSent) { res.destroy(); return; }
    if (error instanceof HttpError) return this.#reply(res, error.status, { error: { code: error.code, message: error.message } }, error.headers);
    if (error instanceof DomainError) {
      const status = STATUS[error.code] ?? 500;
      if (status >= 500 && error.code !== "unavailable") return this.#reply(res, status, { error: { code: error.code, message: "the request could not be completed" } });
      return this.#reply(res, status, { error: { code: error.code, message: redactText(error.message), ...(error.field === undefined ? {} : { field: error.field }) } }, status === 503 ? { "retry-after": "5" } : {});
    }
    return this.#reply(res, 500, { error: { code: "internal", message: "the request could not be completed" } });
  }
}
