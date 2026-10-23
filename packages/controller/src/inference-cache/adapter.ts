import { createHmac } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { redactText } from "../security/redact.js";
import type { CacheContext, CacheHit, CacheProfile, WireRequest } from "./profile.js";

/** Cache keys are derived, never chosen: HMAC-SHA-256 of the purpose and parts under an installation secret, 160 bits, as `nn-` and base64url. A provider or another project sees only this text, and without the secret cannot compute or guess another scope's key. */
export function deriveKey(secret: string, purpose: "scope" | "share", ...parts: readonly string[]): string {
  if (typeof secret !== "string" || secret.length < 16) throw new DomainError("invalid_command", "secret: the installation's cache-key secret must be at least 16 characters", { field: "secret" });
  if (parts.length < 1 || parts.some((p) => typeof p !== "string" || p.length < 1 || p.length > 200)) throw new DomainError("invalid_command", "parts: name the scope with one to several non-empty parts of at most 200 characters", { field: "parts" });
  return `nn-${createHmac("sha256", secret).update(JSON.stringify([purpose, ...parts])).digest("base64url").slice(0, 27)}`;
}

/**
 * Slot affinity for backends that keep one prompt per slot (llama.cpp, Strata): a sharing group keeps the slot it had, new groups take a free slot, and when none is free a group of the **same project**
 * that has the least recent use loses its slot. A project never takes another project's slot: with no free slot and none of its own to give up, the answer is a refusal (the call runs without a slot
 * choice and the dispatcher records it). In memory and bounded by the slot count; after a restart groups are assigned again and the first call of each reads its prompt again (a latency cost only).
 */
export class SlotAffinity {
  readonly #slots: number;
  readonly #order = new Map<string, { project: string; group: string; slot: number }>(); // most recently used last, keyed by project and group
  constructor(slots: number) {
    if (!Number.isSafeInteger(slots) || slots < 1 || slots > 256) throw new DomainError("invalid_command", "slots: must be a whole number from 1 to 256", { field: "slots" });
    this.#slots = slots;
  }
  /** The slot for a group of a project, and the group of that project that lost it (if any); or a refusal. */
  assign(project: string, group: string): { readonly slot: number; readonly evicted?: string } | { readonly refused: string } {
    const key = JSON.stringify([project, group]);
    const had = this.#order.get(key);
    if (had !== undefined) { this.#order.delete(key); this.#order.set(key, had); return { slot: had.slot }; }
    if (this.#order.size < this.#slots) {
      const used = new Set([...this.#order.values()].map((v) => v.slot));
      let slot = 0; while (used.has(slot)) slot++;
      this.#order.set(key, { project, group, slot });
      return { slot };
    }
    for (const [k, v] of this.#order) {
      if (v.project !== project) continue;
      this.#order.delete(k); this.#order.set(key, { project, group, slot: v.slot });
      return { slot: v.slot, evicted: v.group };
    }
    return { refused: "every slot belongs to another project; a project does not take another's slot" };
  }
  release(project: string, group: string): void { this.#order.delete(JSON.stringify([project, group])); }
}

/**
 * What several adapters (and several callers) of **one server** must agree on: which project last held each slot, the slot affinity, and a per-slot turn so that clearing a slot and sending into it
 * cannot interleave with another project's call. The controller owns one `CacheEndpoints` and hands each adapter the state for its endpoint URL; an adapter given no state has a private one and is only
 * correct when it is the sole user of its server.
 */
export class EndpointState {
  /** Which project (scope key) last held each slot. Unknown slots are absent. */
  readonly holder = new Map<number, string>();
  /** Bumped whenever what is known about the slots is wiped, so a call that started earlier does not record a stale holder. */
  epoch = 0;
  readonly #affinities = new Map<number, SlotAffinity>();
  readonly #tails = new Map<number, Promise<void>>();
  #gate: Promise<void> = Promise.resolve();

  /** The shared slot affinity for a server with this many slots. */
  affinity(slots: number): SlotAffinity {
    let a = this.#affinities.get(slots);
    if (a === undefined) { a = new SlotAffinity(slots); this.#affinities.set(slots, a); }
    return a;
  }

  /** Forgets every slot's holder (a call went somewhere unknown). */
  forget(): void { this.holder.clear(); this.epoch++; }

  /** Runs `work` as the only thing happening in this slot (calls of different slots run side by side). */
  slot<T>(slot: number, work: () => Promise<T>): Promise<T> {
    const run = Promise.all([this.#gate, this.#tails.get(slot) ?? Promise.resolve()]).then(work);
    this.#tails.set(slot, run.then(() => undefined, () => undefined));
    return run;
  }

  /** Runs `work` as the only thing happening on the server: after every slot's current work, and before any later work. */
  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const before = [this.#gate, ...this.#tails.values()];
    let release: () => void = () => undefined;
    const mine = new Promise<void>((resolve) => { release = resolve; });
    this.#gate = Promise.all([this.#gate, mine]).then(() => undefined);
    await Promise.all(before);
    try { return await work(); } finally { release(); }
  }
}

/** One `EndpointState` per server, keyed by the normalised endpoint URL (scheme, host and port, path without a trailing slash; case-insensitive host). */
export class CacheEndpoints {
  readonly #states = new Map<string, EndpointState>();
  static readonly MAX = 64;

  state(url: string): EndpointState {
    let key: string;
    try { const u = new URL(url); key = `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`.toLowerCase(); } catch { throw new DomainError("invalid_command", "url: must be the endpoint's URL", { field: "url" }); }
    let s = this.#states.get(key);
    if (s === undefined) {
      if (this.#states.size >= CacheEndpoints.MAX) throw new DomainError("invalid_command", `url: at most ${CacheEndpoints.MAX} endpoints are tracked`, { field: "url" });
      s = new EndpointState(); this.#states.set(key, s);
    }
    return s;
  }
}

export interface HttpRequest { readonly method: "GET" | "POST"; readonly path: string; readonly headers: Readonly<Record<string, string>>; readonly body: WireRequest }
export interface HttpResponse { readonly status: number; readonly body: unknown }
/** How the adapter reaches the endpoint. The dispatcher supplies it (real HTTP with the route's credentials); tests supply simulated servers. */
export interface Transport { send(request: HttpRequest): Promise<HttpResponse> }

export type CacheOutcome =
  /** Served from cache as far as was expected. */
  | "hit"
  /** Some of the expected prefix was served. */
  | "partial"
  /** A hit was expected (the prefix had been seen) and nothing was served: evicted, expired, or the prefix changed. */
  | "miss"
  /** Nothing was expected yet (the first call with this prefix, or a prefix too short to cache). */
  | "cold"
  /** The response carried no cache figure. */
  | "unknown";

export interface CallResult {
  readonly status: number;
  readonly body: unknown;
  readonly hit: CacheHit;
  readonly outcome: CacheOutcome;
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
  /** The slot was cleared before the call because its last holder was another project or unknown. */
  readonly slotCleared?: boolean;
  /** Present when the endpoint refused a cache setting and the call was repeated with none: the same messages went again, so no context was lost. */
  readonly fallback?: { readonly reason: string; readonly refusedStatus: number; readonly removed: readonly string[] };
}

/** The part of a resolved marker a slot operation needs. */
export interface SlotMarker { readonly kind: string; readonly handle?: string }
export interface SlotOutcome { readonly ok: boolean; readonly tokens?: number; readonly ms?: number; readonly reason?: string }

/** The error text of a response: its message, plus a FastAPI-style `detail` (field location and type) so a 422 that names the field we sent is recognised. */
const failureMessage = (body: unknown, max = 300): string => {
  const o = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : undefined;
  const e = o?.["error"];
  const m = typeof e === "string" ? e : e !== null && typeof e === "object" ? (e as Record<string, unknown>)["message"] : o?.["message"];
  const detail = o?.["detail"] === undefined ? "" : typeof o["detail"] === "string" ? o["detail"] : JSON.stringify(o["detail"]);
  return redactText(`${typeof m === "string" ? m : ""} ${detail}`.trim()).slice(0, max);
};

/**
 * Judges a response against what was expected. `expectedCachedTokens` is what the dispatcher knows was cached before (from a marker); `expects` is the profile's own expectation for this request.
 * Under the minimum, or on the first use, a zero is `cold`; a zero where reuse was expected is a `miss`.
 */
export function judge(hit: CacheHit, expects: "yes" | "maybe" | "no", expectedCachedTokens: number): CacheOutcome {
  if (!hit.known) return "unknown";
  if (expects === "no" || expectedCachedTokens <= 0) return hit.cachedTokens > 0 ? "hit" : "cold";
  if (hit.cachedTokens >= expectedCachedTokens) return "hit";
  if (hit.cachedTokens > 0) return "partial";
  return expects === "yes" ? "miss" : "cold";
}

/** What the usage ledger (R05) records for a call's cache figures, or undefined when the response did not say. */
export function ledgerCache(hit: CacheHit, backend: string, route: string): { readonly backend: string; readonly route: string; readonly cachedTokens: number; readonly computedTokens: number; readonly writtenTokens: number } | undefined {
  return hit.known ? { backend, route, cachedTokens: hit.cachedTokens, computedTokens: hit.computedTokens, writtenTokens: hit.writtenTokens } : undefined;
}

/**
 * One endpoint's cache adapter: prepares a request with the profile's settings, sends it, reads the hit, and **falls back without losing context**. If the endpoint refuses a cache setting (an
 * unknown field, a refused marker or lifetime), the same request is sent again with every cache setting removed; the messages are in every request, so nothing the model needs depends on server state,
 * and an evicted or incompatible cache costs time only. Calls to paths the profile forbids (cache resets, engine pause) are refused here, whatever the caller asks.
 */
export class CacheAdapter {
  readonly #profile: CacheProfile;
  readonly #transport: Transport;
  readonly #path: string;
  readonly #state: EndpointState;
  readonly #freshSlot: "erase" | "off";

  constructor(profile: CacheProfile, transport: Transport, options: { readonly path?: string; /** What to do when a slot may hold another project's prompt: clear it first (default, where the backend can) or run the call with reuse off. */ readonly freshSlot?: "erase" | "off"; /** Shared state of the server (`CacheEndpoints.state(url)`), so adapters on one server agree on slot holders. */ readonly state?: EndpointState } = {}) {
    this.#state = options.state ?? new EndpointState();
    this.#freshSlot = options.freshSlot ?? "erase";
    this.#profile = profile;
    this.#transport = transport;
    this.#path = options.path ?? (profile.wire === "anthropic-messages" ? "/v1/messages" : "/v1/chat/completions");
  }

  get profile(): CacheProfile { return this.#profile; }

  async call(request: WireRequest, context: CacheContext, expectedCachedTokens = 0): Promise<CallResult> {
    if (!Number.isSafeInteger(expectedCachedTokens) || expectedCachedTokens < 0) throw new DomainError("invalid_command", "expectedCachedTokens: must be a whole number from 0", { field: "expectedCachedTokens" });
    if (!this.#profile.slotted) return this.#call(request, context, expectedCachedTokens);
    // A plain call names no slot whatever the context says (its body has no id_slot), so it is placed by the server and takes the whole server's turn like any call without a slot.
    const slot = context.plain === true ? undefined : context.slot;
    // A call into a slot takes that slot's turn; a call that names no slot (it may land anywhere) takes the whole server's turn.
    return slot !== undefined && Number.isSafeInteger(slot) && slot >= 0
      ? this.#state.slot(slot, () => this.#call(request, context, expectedCachedTokens))
      : this.#state.exclusive(() => this.#call(request, context, expectedCachedTokens));
  }

  async #call(request: WireRequest, context: CacheContext, expectedCachedTokens: number): Promise<CallResult> {
    let ctxUsed = context;
    let slotCleared = false;
    const epoch = this.#state.epoch;
    const slotted = this.#profile.slotted;
    const slot = context.plain !== true && context.slot !== undefined && Number.isSafeInteger(context.slot) && context.slot >= 0 ? context.slot : undefined;
    if (slotted) {
      if (slot === undefined) {
        // The server will place this call by prompt similarity, possibly in another project's slot, and the slot it lands in now holds this prompt: nothing is known about any slot afterwards.
        this.#state.forget();
      } else if (this.#state.holder.get(slot) !== context.scopeKey) {
        // The slot's last holder was another project, or is unknown (a start, a release, a call without a slot): its KV may still be there.
        let cleared = false;
        if (this.#freshSlot === "erase" && this.#profile.clearSlotRequest !== undefined) {
          const r = this.#profile.clearSlotRequest(slot);
          const res = await this.#send(r.body, {}, r.path, r.method);
          cleared = res.status < 400;
          slotCleared = cleared;
        }
        if (!cleared) ctxUsed = { ...context, reuseOff: true };
      }
    }
    const first = this.#profile.prepare(request, ctxUsed);
    let sent = await this.#send(first.body, first.headers);
    let fallback: CallResult["fallback"];
    let used = first;
    let placed = true;
    const refusal = sent.status >= 400 && first.applied.length > 0 ? failureMessage(sent.body, 2000) : undefined;
    // When the refusal names cache_prompt on a slotted server there is no safe way to say "do not reuse", so the error is returned instead of a retry that would reuse by similarity.
    if (refusal !== undefined && this.#profile.refusedCacheSetting({ status: sent.status, message: refusal }) && !(this.#profile.slotted && /\bcache_prompt\b/.test(refusal.toLowerCase()))) {
      const plain = this.#profile.prepare(request, { ...context, plain: true });
      const again = await this.#send(plain.body, plain.headers);
      fallback = { reason: failureMessage(sent.body) || "the endpoint refused a cache setting", refusedStatus: sent.status, removed: first.applied };
      sent = again; used = plain;
      // The plain retry names no slot, so the server placed it wherever it liked: no slot's holder is known any more.
      if (this.#profile.slotted) { this.#state.forget(); placed = false; }
    }
    if (slotted && slot !== undefined && placed && sent.status < 400 && this.#state.epoch === epoch) this.#state.holder.set(slot, context.scopeKey);
    const hit = sent.status < 400 ? this.#profile.read(sent.body) : this.#profile.read(undefined);
    const outcome = sent.status < 400 ? judge(hit, used.expects, expectedCachedTokens) : "unknown";
    return { status: sent.status, body: sent.body, hit, outcome, applied: used.applied, skipped: used.skipped, ...(slotCleared ? { slotCleared } : {}), ...(fallback === undefined ? {} : { fallback }) };
  }

  /**
   * Saves or restores a slot's state to or from a file on the server. Both take the slot-file **marker the dispatcher has just resolved for this project** (`MarkerService.resolve`): the file name comes
   * from the marker, never from a caller, so a project can only reach files its own markers name. The adapter cannot check that itself; resolving first is the dispatcher's duty. Never throws on a server
   * refusal: the outcome says why, and the caller carries on with its stored context.
   */
  async slot(action: "save" | "restore", slot: number, marker: SlotMarker, scopeKey: string): Promise<SlotOutcome> {
    if (this.#profile.slotRequest === undefined || this.#profile.capabilities.slotSaveRestore.level === "unsupported") return { ok: false, reason: `unsupported: ${this.#profile.capabilities.slotSaveRestore.via}` };
    if (marker === undefined || marker.kind !== "slot-file" || marker.handle === undefined) throw new DomainError("invalid_command", "marker: save and restore need a resolved slot-file marker", { field: "marker" });
    const r = this.#profile.slotRequest(action, slot, marker.handle);
    // The holder is recorded inside the slot's turn (and only if nothing wiped what is known meanwhile): after a restore the slot holds this project's state, the marker having been resolved for it.
    const res = await this.#state.slot(slot, async () => {
      const epoch = this.#state.epoch;
      const out = await this.#send(r.body, {}, r.path, r.method);
      if (action === "restore" && this.#profile.slotted && out.status < 400 && this.#state.epoch === epoch) this.#state.holder.set(slot, scopeKey);
      return out;
    });
    if (res.status >= 400) return { ok: false, reason: `status ${res.status}: ${failureMessage(res.body) || "refused"}` };
    const b = (res.body !== null && typeof res.body === "object" ? res.body : {}) as Record<string, unknown>;
    const n = action === "save" ? b["n_saved"] : b["n_restored"];
    const t = (b["timings"] !== null && typeof b["timings"] === "object" ? b["timings"] : {}) as Record<string, unknown>;
    const ms = action === "save" ? t["save_ms"] : t["restore_ms"];
    return { ok: true, ...(typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? { tokens: n } : {}), ...(typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? { ms } : {}) };
  }

  /**
   * Clears one slot's in-memory KV cache. This is **not** file deletion: llama.cpp (and Strata) have no API to delete a saved slot file, so the files named by `MarkerService.pendingErase` are removed by a
   * host-side job on the server's `--slot-save-path` (Strata: its session-file directory), by exact file name, after which the marker is released.
   */
  async clearSlot(slot: number): Promise<SlotOutcome> {
    if (this.#profile.clearSlotRequest === undefined) return { ok: false, reason: `unsupported: ${this.#profile.label} has no slot clear` };
    const r = this.#profile.clearSlotRequest(slot);
    const res = await this.#state.slot(slot, () => this.#send(r.body, {}, r.path, r.method));
    if (res.status >= 400) return { ok: false, reason: `status ${res.status}: ${failureMessage(res.body) || "refused"}` };
    this.#state.holder.delete(slot);
    return { ok: true };
  }

  #send(body: WireRequest, headers: Readonly<Record<string, string>>, path: string = this.#path, method: "GET" | "POST" = "POST"): Promise<HttpResponse> {
    const bare = path.split("?")[0]!;
    if (this.#profile.neverCall.some((p) => bare === p || bare.startsWith(`${p}/`))) throw new DomainError("forbidden", `${bare} is never called through a cache adapter: it changes or empties the server's cache for every agent`);
    return this.#transport.send({ method, path, headers, body });
  }
}
