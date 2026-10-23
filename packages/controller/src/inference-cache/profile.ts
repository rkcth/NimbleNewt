import { DomainError } from "../domain/errors.js";

/**
 * Inference-cache profiles (card C06). A profile says, for one configured endpoint and model, what its cache can do (each capability stated separately and honestly), the request fields that make
 * the cache work for it, how to read its cache hits from a response, and which of its own server settings matter. The profile is chosen **only** from the endpoint's configured `kind`: the owner states
 * what the endpoint is, and nothing here looks at a model name, a URL or a response to guess. An endpoint with no kind, or with a kind this code does not know, gets the generic profile, which assumes nothing.
 */

export const BACKEND_KINDS = ["llama-cpp", "vllm", "radiance", "strata", "openai", "openai-compatible", "claude", "generic"] as const;
export type BackendKind = (typeof BACKEND_KINDS)[number];

/** `unsupported`: not offered. `available`: offered by the backend as read from its source or documentation, not yet measured here. `qualified`: measured by G10 on this installation (nothing is qualified until G10 has run). */
export type SupportLevel = "unsupported" | "available" | "qualified";
export interface Support { readonly level: SupportLevel; /** How, or why not. */ readonly via: string }

/** What a cache can do. Pin, fork and decoder resume are separate answers: a backend that can share a prefix cannot necessarily keep it, and none of them can resume a decoder in mid-generation. */
export interface CacheCapabilities {
  /** Whether an unchanged prompt prefix is reused: by the server on its own, by markers the request places, or not at all. */
  readonly prefixReuse: "automatic" | "markers" | "none";
  /** Whether the request can influence how long an entry is kept. */
  readonly retention: { readonly control: "none" | "request" | "server"; readonly via: string; readonly maxMs?: number };
  /** How requests of different projects are kept from sharing entries. `request-salt`: a salt or key the request carries. `none`: the backend cannot separate them, so a shared backend is shared. */
  readonly isolation: "request-salt" | "request-key" | "none";
  /** Keep a prefix until released, whatever other requests do. */
  readonly pin: Support;
  /** Start a second conversation from a retained prefix without disturbing the first. */
  readonly fork: Support;
  /** Continue a generation that was stopped in the middle. No backend offers it; it stays unsupported until proven. */
  readonly decoderResume: Support;
  /** Save a conversation's state to a named file and restore it later (idle slots only). */
  readonly slotSaveRestore: Support;
}

export interface Tuning {
  readonly where: "request" | "server";
  readonly setting: string;
  readonly value?: string;
  readonly why: string;
  /** Present when a setting exists only from a later version than the one installed. */
  readonly since?: string;
}

/** Cache figures from one response. `known: false` means the response carried no cache field, which is not the same as zero hits. */
export interface CacheHit {
  readonly known: boolean;
  /** The field that was read, so a reader can check it against the raw response. */
  readonly source: string;
  readonly promptTokens: number;
  readonly cachedTokens: number;
  readonly computedTokens: number;
  readonly writtenTokens: number;
  readonly writtenByTtl?: { readonly fiveMinute: number; readonly oneHour: number };
  /** A reason the figure may overstate or understate real reuse. */
  readonly caveat?: string;
}

export type WireRequest = Record<string, unknown>;
export type Retention = "short" | "long";
export interface Breakpoint { readonly at: "tools-end" | "system-end" | "last-message" | { readonly message: number }; readonly ttl: "5m" | "1h" }

/** What the dispatcher knows about this call. Keys are opaque and derived per scope (see `deriveKey`), never project or task IDs: a cloud provider sees only the derived text. */
export interface CacheContext {
  /** Isolation boundary (a project): requests with different scope keys never share a cache entry where the backend can separate them. */
  readonly scopeKey: string;
  /** Sharing group inside a scope (a meeting, the project's common preamble): requests that share a prefix share this key. Falls back to the scope key. */
  readonly shareKey?: string;
  /** Estimated tokens of the stable prefix the call shares with earlier calls. */
  readonly prefixTokens?: number;
  /** Nobody continues this prompt (a classification call, a probe). */
  readonly oneShot?: boolean;
  /** The slot this call should run in (llama.cpp and Strata). */
  readonly slot?: number;
  readonly retention?: Retention;
  /** Claude: where to put breakpoints. Default: the end of the system prompt (or the tools) and the last message. */
  readonly breakpoints?: readonly Breakpoint[];
  /** Strata: the first N messages are a shared document or preamble to keep pinned. */
  readonly pinMessages?: number;
  /** The dispatcher holds a live pin marker for this project on this route (`MarkerService.register` with kind `pin` succeeded, which is what makes the project the route's only pin holder). Without it no pin is sent. */
  readonly pinAuthorized?: boolean;
  /** Do not reuse whatever the slot holds (llama.cpp sends `cache_prompt: false`). The adapter sets it when the slot may hold another project's prompt and could not be cleared. */
  readonly reuseOff?: boolean;
  /** Leave every cache setting out (the fallback after a refusal). */
  readonly plain?: boolean;
  /** The project requires that its prompts share no cache with other projects. A backend that cannot keep projects apart then gets no cache settings (llama.cpp is told not to reuse); the result says so. */
  readonly isolationRequired?: boolean;
}

export interface Prepared {
  readonly body: WireRequest;
  readonly headers: Readonly<Record<string, string>>;
  /** Cache settings that were put in the request. */
  readonly applied: readonly string[];
  /** Settings that were wanted and left out, with the reason. */
  readonly skipped: readonly string[];
  /** `yes`: a hit is expected once the prefix has been seen, so a zero is a miss worth reporting. `maybe`: it may cache; a zero is not a finding. `no`: not expected. */
  readonly expects: "yes" | "maybe" | "no";
}

export interface EndpointOptions {
  /** Parallel slots the server runs (llama.cpp `--parallel`, Strata `--batch`). */
  readonly slots?: number;
  /** The server can save and restore slot files (llama.cpp `--slot-save-path`; Strata session files). */
  readonly slotSave?: boolean;
  /** vLLM started with `--enable-prompt-tokens-details`, which is what puts cached_tokens in the usage. */
  readonly promptDetails?: boolean;
  /** vLLM automatic prefix caching is on (it is by default). */
  readonly prefixCaching?: boolean;
  /** An OpenAI-compatible service accepts `prompt_cache_key`. */
  readonly promptCacheKey?: boolean;
  /** The OpenAI model supports `prompt_cache_retention: "24h"`. */
  readonly extendedRetention?: boolean;
  /** Strata runs with `--prompt-cache 3` or more, which `strata_prefix` needs. */
  readonly pinPrefix?: boolean;
  /** Radiance runs with `--prefix-cache-mib` above 0. */
  readonly hostTier?: boolean;
  /** The model keeps recurrent (linear-layer) state, as the Qwen3.8 hybrids do. A prefix-cache hit then also needs the state snapshot. */
  readonly hybrid?: boolean;
  /** Overrides the smallest prefix that caches. */
  readonly minPrefixTokens?: number;
}
export interface EndpointConfig {
  readonly kind?: string;
  readonly model: string;
  /** The R01 route (`provider/model`) this endpoint serves. When given, `MarkerService.register` refuses a different route. */
  readonly route?: string;
  readonly options?: EndpointOptions;
}

export interface CacheProfile {
  readonly kind: BackendKind;
  readonly label: string;
  readonly model: string;
  /** What this profile was derived from, so a reader knows how far to trust it. */
  readonly basis: string;
  readonly wire: "openai-chat" | "anthropic-messages";
  readonly capabilities: CacheCapabilities;
  /** The response fields hits are read from. */
  readonly hitFields: readonly string[];
  readonly tuning: readonly Tuning[];
  readonly caveats: readonly string[];
  /** Paths that must never be called through this profile's transport (they change or destroy server state). */
  readonly neverCall: readonly string[];
  /** The smallest prefix (tokens) that is cached at all, where the backend has one. */
  readonly minPrefixTokens?: number;
  /** How long a cached prefix can be expected to last when nothing says otherwise (milliseconds): minutes for an in-memory hosted cache, an hour for a server's idle timeout. */
  readonly defaultLifetimeMs?: number;
  prepare(request: WireRequest, context: CacheContext): Prepared;
  read(response: unknown): CacheHit;
  /** Whether an error response means a cache setting was refused (so the call may be repeated without it). */
  refusedCacheSetting(failure: { readonly status: number; readonly message: string }): boolean;
  /** The server runs a known number of slots and a call must name one: a call with no slot is sent with reuse off. */
  readonly slotted: boolean;
  /** Request pieces for slot save and restore (files on the server), where the backend has them. */
  slotRequest?(action: "save" | "restore", slot: number, filename?: string): { readonly method: "POST"; readonly path: string; readonly body: WireRequest };
  /** Clears one slot's in-memory KV cache (llama.cpp `?action=erase`). It does **not** delete any saved file: llama.cpp has no API for that. Present only where the backend can do it. */
  clearSlotRequest?(slot: number): { readonly method: "POST"; readonly path: string; readonly body: WireRequest };
}

export const CACHE_LIMITS = { model: 200, slots: 256, minPrefix: 100_000, tokens: 10_000_000, key: 128 } as const;
const OPTION_KEYS = ["slots", "slotSave", "promptDetails", "prefixCaching", "promptCacheKey", "extendedRetention", "pinPrefix", "hostTier", "hybrid", "minPrefixTokens"] as const;
const BOOLEAN_OPTIONS = ["slotSave", "promptDetails", "prefixCaching", "promptCacheKey", "extendedRetention", "pinPrefix", "hostTier", "hybrid"] as const;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };

/** Checks an endpoint's configuration. An unknown option name is refused (a misspelt setting must not silently do nothing). The kind is not checked here: an unrecognised kind is the generic profile. */
export function checkEndpoint(value: unknown): { readonly kind: BackendKind; readonly model: string; readonly route?: string; readonly options: EndpointOptions; readonly unrecognisedKind?: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid("endpoint", "must be an object");
  const e = value as Record<string, unknown>;
  for (const k of Object.keys(e)) if (!["kind", "model", "route", "options"].includes(k)) invalid(`endpoint.${k}`, "is not a field here");
  const model = e["model"];
  if (typeof model !== "string" || model.length < 1 || model.length > CACHE_LIMITS.model || /[\u0000-\u001f]/.test(model)) invalid("endpoint.model", `must be a model name of 1 to ${CACHE_LIMITS.model} characters`);
  if (e["route"] !== undefined && (typeof e["route"] !== "string" || !/^[A-Za-z][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/.test(e["route"]))) invalid("endpoint.route", "must be provider/model");
  const raw = e["options"] ?? {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return invalid("endpoint.options", "must be an object");
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!(OPTION_KEYS as readonly string[]).includes(k)) invalid(`endpoint.options.${k}`, "is not a known option");
  const options: Record<string, unknown> = {};
  for (const k of BOOLEAN_OPTIONS) if (o[k] !== undefined) options[k] = typeof o[k] === "boolean" ? o[k] : invalid(`endpoint.options.${k}`, "must be true or false");
  if (o["slots"] !== undefined) options["slots"] = Number.isSafeInteger(o["slots"]) && (o["slots"] as number) >= 1 && (o["slots"] as number) <= CACHE_LIMITS.slots ? o["slots"] : invalid("endpoint.options.slots", `must be a whole number from 1 to ${CACHE_LIMITS.slots}`);
  if (o["minPrefixTokens"] !== undefined) options["minPrefixTokens"] = Number.isSafeInteger(o["minPrefixTokens"]) && (o["minPrefixTokens"] as number) >= 1 && (o["minPrefixTokens"] as number) <= CACHE_LIMITS.minPrefix ? o["minPrefixTokens"] : invalid("endpoint.options.minPrefixTokens", `must be a whole number from 1 to ${CACHE_LIMITS.minPrefix}`);
  const kind = e["kind"];
  const known = typeof kind === "string" && (BACKEND_KINDS as readonly string[]).includes(kind);
  return { kind: known ? (kind as BackendKind) : "generic", model: model as string, ...(e["route"] === undefined ? {} : { route: e["route"] as string }), options: options as EndpointOptions, ...(kind !== undefined && !known ? { unrecognisedKind: String(kind).slice(0, 60) } : {}) };
}

export type Want = "prefix-reuse" | "retention-control" | "isolation" | "pin" | "fork" | "slot-save-restore" | "decoder-resume";
export interface Negotiation {
  /** What the backend offers, with how. */
  readonly granted: Readonly<Record<string, string>>;
  /** What it does not, with what happens instead. Never an error: a cache that is missing costs time, not correctness. */
  readonly fallbacks: Readonly<Record<string, string>>;
  /** Wants whose support is only read from source, not measured (G10). */
  readonly unqualified: readonly Want[];
}
const INSTEAD = "the call carries its full context and runs without the cache (slower, never different)";

/** Capability negotiation: what of the wanted cache behaviour this endpoint's profile offers. */
export function negotiate(profile: CacheProfile, wants: readonly Want[]): Negotiation {
  const c = profile.capabilities;
  const granted: Record<string, string> = {};
  const fallbacks: Record<string, string> = {};
  const unqualified: Want[] = [];
  const give = (w: Want, ok: boolean, via: string, qualified: boolean): void => {
    if (ok) { granted[w] = via; if (!qualified) unqualified.push(w); } else fallbacks[w] = `${via}; ${INSTEAD}`;
  };
  for (const w of wants) {
    switch (w) {
      case "prefix-reuse": give(w, c.prefixReuse !== "none", c.prefixReuse === "none" ? "no prefix reuse" : `prefix reuse by ${c.prefixReuse === "automatic" ? "the server's own cache" : "request markers"}`, false); break;
      case "retention-control": give(w, c.retention.control !== "none", c.retention.via, false); break;
      case "isolation": give(w, c.isolation !== "none", c.isolation === "none" ? "this backend cannot keep projects' entries apart" : `isolation by a ${c.isolation}`, false); break;
      case "pin": give(w, c.pin.level !== "unsupported", c.pin.via, c.pin.level === "qualified"); break;
      case "fork": give(w, c.fork.level !== "unsupported", c.fork.via, c.fork.level === "qualified"); break;
      case "slot-save-restore": give(w, c.slotSaveRestore.level !== "unsupported", c.slotSaveRestore.via, c.slotSaveRestore.level === "qualified"); break;
      case "decoder-resume": give(w, c.decoderResume.level !== "unsupported", c.decoderResume.via, c.decoderResume.level === "qualified"); break;
      default: invalid("wants", `${String(w)} is not a capability`);
    }
  }
  return { granted, fallbacks, unqualified };
}
