import { createHash, randomBytes } from "node:crypto";

export interface WebSessionLimits {
  /** A session with no request for this long ends (milliseconds). */
  readonly idleMs: number;
  /** A session ends this long after the sign-in whatever it does. */
  readonly maxMs: number;
  /** Sessions kept at once; a new sign-in over the limit ends the least recently used. */
  readonly sessions: number;
  /** A pairing code is good for this long (milliseconds) and once. */
  readonly pairingMs: number;
}

/** Provisional (card U07): a phone left in a pocket stays signed in for a day, a week at most; a pairing code lives five minutes. */
export const DEFAULT_SESSION_LIMITS: WebSessionLimits = { idleMs: 24 * 3600_000, maxMs: 7 * 24 * 3600_000, sessions: 20, pairingMs: 5 * 60_000 };

export interface WebSession {
  /** The public name of the session, safe to show in a list and to quote in a revoke. It is not the cookie. */
  readonly handle: string;
  readonly principalId: string;
  /** The credential the session acts with. It lives in memory only: it is in no record, log, list or reply, and a restart ends every session. */
  readonly token: string;
  readonly csrf: string;
  readonly label: string;
  readonly createdAt: number;
  lastSeen: number;
}

const digest = (secret: string): string => createHash("sha256").update(secret).digest("hex");
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * The browser sessions of the web chat (card U07): in memory, keyed by a hash of the cookie value (a read of the map never yields a usable cookie), sliding idle expiry under an absolute one.
 * A session is only a handle on the owner's credential: the door authenticates that credential again on every request, so rotating or disabling it ends every session at once, and
 * revoking a session here ends that browser on its very next request.
 */
export class WebSessionStore {
  readonly #byKey = new Map<string, WebSession>();
  readonly #pairings = new Map<string, { principalId: string; token: string; until: number }>();
  readonly #limits: WebSessionLimits;
  readonly #now: () => number;

  constructor(limits: Partial<WebSessionLimits> = {}, now: () => number = Date.now) {
    this.#limits = { ...DEFAULT_SESSION_LIMITS, ...limits };
    this.#now = now;
  }

  /** Starts a session. Returns the cookie value (shown once) and the session. */
  create(principalId: string, token: string, label: string): { cookie: string; session: WebSession } {
    this.#sweep();
    const cookie = randomBytes(32).toString("base64url");
    const now = this.#now();
    const session: WebSession = { handle: `ws-${randomBytes(6).toString("hex")}`, principalId, token, csrf: randomBytes(24).toString("base64url"), label, createdAt: now, lastSeen: now };
    this.#byKey.set(digest(cookie), session);
    while (this.#byKey.size > this.#limits.sessions) {
      let oldest: [string, WebSession] | undefined;
      for (const entry of this.#byKey) if (entry[1] !== session && (oldest === undefined || entry[1].lastSeen < oldest[1].lastSeen)) oldest = entry;
      if (oldest === undefined) break;
      this.#byKey.delete(oldest[0]);
    }
    return { cookie, session };
  }

  /** The live session behind a cookie value (and slides its idle time), or undefined when unknown, idle too long or past its absolute end. */
  lookup(cookie: string | undefined): WebSession | undefined {
    if (cookie === undefined || cookie.length === 0 || cookie.length > 200) return undefined;
    const key = digest(cookie);
    const s = this.#byKey.get(key);
    if (s === undefined) return undefined;
    const now = this.#now();
    if (now - s.lastSeen >= this.#limits.idleMs || now - s.createdAt >= this.#limits.maxMs) { this.#byKey.delete(key); return undefined; }
    s.lastSeen = now;
    return s;
  }

  expiresAt(s: WebSession): number { return Math.min(s.lastSeen + this.#limits.idleMs, s.createdAt + this.#limits.maxMs); }

  /** Ends the session with this handle; whether there was one. */
  revokeHandle(principalId: string, handle: string): boolean {
    for (const [key, s] of this.#byKey) if (s.handle === handle && s.principalId === principalId) { this.#byKey.delete(key); return true; }
    return false;
  }

  /** Ends the session behind this cookie value. */
  revokeCookie(cookie: string | undefined): void { if (cookie !== undefined) this.#byKey.delete(digest(cookie)); }

  /** Ends every session of the principal except (optionally) one handle; how many ended. */
  revokeAll(principalId: string, exceptHandle?: string): number {
    let n = 0;
    for (const [key, s] of this.#byKey) if (s.principalId === principalId && s.handle !== exceptHandle) { this.#byKey.delete(key); n += 1; }
    return n;
  }

  list(principalId: string): readonly WebSession[] {
    this.#sweep();
    return [...this.#byKey.values()].filter((s) => s.principalId === principalId).sort((a, b) => b.lastSeen - a.lastSeen);
  }

  /** A one-time code that signs a second browser in as the same principal (the phone types a short code instead of the credential). */
  pair(principalId: string, token: string): { code: string; expiresAt: number } {
    const now = this.#now();
    for (const [k, p] of this.#pairings) if (p.until <= now) this.#pairings.delete(k);
    while (this.#pairings.size >= 20) this.#pairings.delete(this.#pairings.keys().next().value as string);
    const bytes = randomBytes(10);
    const code = Array.from(bytes, (b) => ALPHABET[b % 32]).join("");
    const until = now + this.#limits.pairingMs;
    this.#pairings.set(digest(code), { principalId, token, until });
    return { code, expiresAt: until };
  }

  /** Takes a pairing code (it works once, even if the sign-in that follows fails). */
  redeem(code: string): { principalId: string; token: string } | undefined {
    const key = digest(code.toUpperCase().replace(/[\s-]/g, ""));
    const p = this.#pairings.get(key);
    this.#pairings.delete(key);
    return p === undefined || p.until <= this.#now() ? undefined : { principalId: p.principalId, token: p.token };
  }

  get size(): number { return this.#byKey.size; }

  #sweep(): void {
    const now = this.#now();
    for (const [key, s] of this.#byKey) if (now - s.lastSeen >= this.#limits.idleMs || now - s.createdAt >= this.#limits.maxMs) this.#byKey.delete(key);
  }
}
