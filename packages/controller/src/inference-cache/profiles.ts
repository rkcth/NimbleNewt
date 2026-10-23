import { DomainError } from "../domain/errors.js";
import { checkEndpoint, type BackendKind, type CacheContext, type CacheHit, type CacheProfile, type CacheCapabilities, type EndpointConfig, type EndpointOptions, type Prepared, type Retention, type Support, type Tuning, type WireRequest } from "./profile.js";

const UNSUPPORTED = (why: string): Support => ({ level: "unsupported", via: why });
const AVAILABLE = (how: string): Support => ({ level: "available", via: how });
const NO_DECODER_RESUME = UNSUPPORTED("no inference server offers resuming a stopped generation in mid-decode (backend-protocol-audit.md; unproven, would need a scoped engine patch)");
const EMPTY_HIT = (source: string, caveat?: string): CacheHit => ({ known: false, source, promptTokens: 0, cachedTokens: 0, computedTokens: 0, writtenTokens: 0, ...(caveat === undefined ? {} : { caveat }) });

// ---- reading responses: defensive, because a response is data from a server we do not control ----------------------------------------------------------------------------------------
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown): number | undefined => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 1e12 ? v : undefined);
const at = (root: unknown, ...path: string[]): unknown => { let cur: unknown = root; for (const k of path) { if (!isObject(cur)) return undefined; cur = cur[k]; } return cur; };

/** OpenAI-style: usage.prompt_tokens (total) with usage.prompt_tokens_details.cached_tokens, or the Responses shape input_tokens with input_tokens_details.cached_tokens. */
function readOpenAi(response: unknown, caveat?: string): CacheHit {
  const chat = at(response, "usage", "prompt_tokens_details", "cached_tokens");
  const resp = at(response, "usage", "input_tokens_details", "cached_tokens");
  const cached = count(chat) ?? count(resp);
  const total = count(chat !== undefined ? at(response, "usage", "prompt_tokens") : at(response, "usage", "input_tokens"));
  const source = count(chat) !== undefined ? "usage.prompt_tokens_details.cached_tokens" : "usage.input_tokens_details.cached_tokens";
  if (cached === undefined || total === undefined || cached > total) return EMPTY_HIT(source, caveat);
  return { known: true, source, promptTokens: total, cachedTokens: cached, computedTokens: total - cached, writtenTokens: 0, ...(caveat === undefined ? {} : { caveat }) };
}

/** llama.cpp-style timings: cache_n tokens served from cache, prompt_n tokens computed. Falls back to the OpenAI usage field when a server sends only that. */
function readTimings(response: unknown, caveat?: string): CacheHit {
  const cacheN = count(at(response, "timings", "cache_n"));
  const promptN = count(at(response, "timings", "prompt_n"));
  if (cacheN !== undefined && promptN !== undefined) return { known: true, source: "timings.cache_n + timings.prompt_n", promptTokens: cacheN + promptN, cachedTokens: cacheN, computedTokens: promptN, writtenTokens: 0, ...(caveat === undefined ? {} : { caveat }) };
  const fallback = readOpenAi(response, caveat);
  return fallback.known ? fallback : EMPTY_HIT("timings.cache_n + timings.prompt_n", caveat);
}

function readClaude(response: unknown): CacheHit {
  const u = at(response, "usage");
  const input = count(at(u, "input_tokens"));
  const read = count(at(u, "cache_read_input_tokens"));
  const created = count(at(u, "cache_creation_input_tokens"));
  if (input === undefined || (read === undefined && created === undefined)) return EMPTY_HIT("usage.cache_read_input_tokens");
  const r = read ?? 0, w = created ?? 0;
  const five = count(at(u, "cache_creation", "ephemeral_5m_input_tokens")), hour = count(at(u, "cache_creation", "ephemeral_1h_input_tokens"));
  return {
    known: true, source: "usage.cache_read_input_tokens", promptTokens: input + r + w, cachedTokens: r, computedTokens: input + w, writtenTokens: w,
    ...(five === undefined && hour === undefined ? {} : { writtenByTtl: { fiveMinute: five ?? 0, oneHour: hour ?? 0 } }),
  };
}

const copy = (r: WireRequest): WireRequest => structuredClone(r);
const prepared = (body: WireRequest, applied: string[], skipped: string[], expects: Prepared["expects"], headers: Record<string, string> = {}): Prepared => ({ body, headers, applied, skipped, expects });
const messageOf = (f: { message: string }): string => f.message.toLowerCase();
/** A refusal names a field we sent, as a whole word: a 400, or a 422 whose body lists the field (FastAPI-style `loc` / `extra_forbidden`, which the adapter folds into the message). */
const refusedBy = (words: RegExp) => (f: { status: number; message: string }): boolean => (f.status === 400 || f.status === 422) && words.test(messageOf(f));
/** A key is only ever the derived text: letters, digits, '-' and '_', at most 128 characters. A raw project name or ID, or anything with other characters, is refused. */
function safeKey(key: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(key)) throw new DomainError("invalid_command", "cache key: use the derived key (letters, digits, '-' and '_', at most 128 characters)", { field: "scopeKey" });
  return key;
}

function slotChoice(options: EndpointOptions, ctx: CacheContext, skipped: string[]): number | undefined {
  if (ctx.slot === undefined) return undefined;
  const slots = options.slots;
  if (slots === undefined) { skipped.push("id_slot: the number of slots is not configured"); return undefined; }
  if (!Number.isSafeInteger(ctx.slot) || ctx.slot < 0 || ctx.slot >= slots) { skipped.push(`id_slot: slot ${String(ctx.slot)} is outside the ${slots} configured`); return undefined; }
  return ctx.slot;
}
const SLOT_FILE = /^nn-[a-z0-9]{8,40}\.bin$/;
const slotRequest = (base: string, action: "save" | "restore", slot: number, filename: string | undefined) => {
  if (!Number.isSafeInteger(slot) || slot < 0) throw new DomainError("invalid_command", "slot: must be a whole number from 0", { field: "slot" });
  if (filename === undefined || !SLOT_FILE.test(filename)) throw new DomainError("invalid_command", "filename: must be nn- followed by 8 to 40 lower-case letters or digits and .bin (a name the controller generated, never a path)", { field: "filename" });
  return { method: "POST" as const, path: `${base}/${slot}?action=${action}`, body: { filename } };
};

// ---- llama.cpp ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
function llamaCpp(model: string, o: EndpointOptions): CacheProfile {
  const capabilities: CacheCapabilities = {
    prefixReuse: "automatic",
    retention: { control: "server", via: "an idle slot keeps its prompt until another prompt takes the slot; a saved slot file keeps it until erased" },
    isolation: "none",
    pin: o.slotSave === true ? AVAILABLE("a slot file saved with /slots/{id}?action=save is kept until erased and can be restored into any idle slot") : UNSUPPORTED("slots are overwritten by later prompts and no slot save path is configured"),
    fork: o.slotSave === true ? AVAILABLE("restore one saved slot file into a second idle slot") : AVAILABLE("a second conversation that starts with the same tokens reuses them when its slot is chosen by similarity (needs the prefix to still be in a slot)"),
    decoderResume: NO_DECODER_RESUME,
    slotSaveRestore: o.slotSave === true ? AVAILABLE("POST /slots/{id}?action=save|restore|erase; the server queues the task until the slot is idle, so it cannot snapshot a running decode") : UNSUPPORTED("no --slot-save-path is configured"),
  };
  const tuning: Tuning[] = [
    { where: "request", setting: "cache_prompt", value: "true", why: "reuse the longest common prefix of the slot (the documented default, sent explicitly)" },
    { where: "request", setting: "id_slot", why: "one slot per agent or shared-prefix group, so alternating agents do not overwrite each other's prompt" },
    { where: "server", setting: "--parallel", value: "at least the number of agents that alternate", why: "each concurrently kept conversation needs its own slot; every slot divides the context" },
    { where: "server", setting: "--cache-reuse", value: "256", why: "reuse chunks of the prompt by shifting the KV cache when only a middle part changed" },
    { where: "server", setting: "--slot-prompt-similarity", value: "0.5", why: "when no slot is named, choose a slot whose prompt matches at least this share" },
    { where: "server", setting: "--slot-save-path", why: "needed for save and restore of named slot files" },
  ];
  return {
    kind: "llama-cpp", label: "llama.cpp (llama-server)", model, wire: "openai-chat", capabilities, tuning, minPrefixTokens: 1, defaultLifetimeMs: 3_600_000,
    basis: "llama.cpp tools/server README and source as audited in backend-protocol-audit.md (2026-10-16); not measured here",
    hitFields: ["timings.cache_n", "timings.prompt_n"],
    caveats: ["Slot save and restore wait for an idle slot; they cannot snapshot a running decode.", "Slot files are specific to the model and build that wrote them.", "A short unrelated request may take a slot another agent's prompt was kept in; leave a spare slot for one-shot calls."],
    neverCall: [],
    prepare(request, ctx): Prepared {
      const body = copy(request); const applied: string[] = []; const skipped: string[] = [];
      // The plain request of a server with slots still says "do not reuse": without id_slot llama.cpp places the call by prompt similarity and defaults to reuse, possibly in another project's slot.
      if (ctx.plain === true) { if (o.slots !== undefined) body["cache_prompt"] = false; return prepared(body, applied, skipped, "no"); }
      const slot = slotChoice(o, ctx, skipped);
      // With slots configured, a call that names no slot (none given, or refused) would be placed by prompt similarity and could land in another project's slot: reuse is off for it. The same when the adapter could not clear a slot another project used.
      const off = ctx.reuseOff === true || (o.slots !== undefined && slot === undefined);
      body["cache_prompt"] = !off; applied.push(off ? "cache_prompt=false" : "cache_prompt");
      if (slot !== undefined) { body["id_slot"] = slot; applied.push("id_slot"); }
      if (off) skipped.push("cache reuse is off for this call: no slot of its own is available" + (ctx.reuseOff === true ? " or the slot may hold another project's prompt" : ""));
      return prepared(body, applied, skipped, off ? "no" : "yes");
    },
    read: (response) => readTimings(response),
    refusedCacheSetting: refusedBy(/\b(id_slot|cache_prompt)\b/),
    slotted: o.slots !== undefined,
    slotRequest: (action, slot, filename) => {
      if (o.slotSave !== true) throw new DomainError("invalid_command", "slot save and restore are not configured for this endpoint", { field: "slotSave" });
      return slotRequest("/slots", action, slot, filename);
    },
    clearSlotRequest: (slot) => {
      if (!Number.isSafeInteger(slot) || slot < 0) throw new DomainError("invalid_command", "slot: must be a whole number from 0", { field: "slot" });
      return { method: "POST" as const, path: `/slots/${slot}?action=erase`, body: {} };
    },
  };
}

// ---- vLLM --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
function vllm(model: string, o: EndpointOptions): CacheProfile {
  const on = o.prefixCaching !== false;
  const capabilities: CacheCapabilities = {
    prefixReuse: on ? "automatic" : "none",
    retention: { control: "server", via: "blocks stay until the block pool needs them (least recently used); the request cannot extend it" },
    isolation: on ? "request-salt" : "none",
    pin: UNSUPPORTED("no per-request pin; vLLM's keep/pause options act on the whole engine and are not a per-agent pin"),
    fork: on ? AVAILABLE("requests with the same cache_salt and the same token prefix share blocks (copy-on-write inside the engine)") : UNSUPPORTED("automatic prefix caching is off"),
    decoderResume: NO_DECODER_RESUME,
    slotSaveRestore: UNSUPPORTED("no named-slot snapshot API in the inspected routes"),
  };
  return {
    kind: "vllm", label: "vLLM", model, wire: "openai-chat", capabilities, minPrefixTokens: 16, defaultLifetimeMs: 3_600_000,
    basis: "vLLM entrypoint routes and docs as audited in backend-protocol-audit.md (2026-10-16); not measured here",
    hitFields: ["usage.prompt_tokens_details.cached_tokens"],
    tuning: [
      { where: "request", setting: "cache_salt", why: "partitions prefix reuse by project, so one project cannot probe another's cache by timing" },
      { where: "server", setting: "--enable-prefix-caching", value: "on", why: "automatic prefix caching (the default in current versions)" },
      { where: "server", setting: "--enable-prompt-tokens-details", why: "without it the usage carries no cached_tokens and hits cannot be read" },
      { where: "server", setting: "--block-size", why: "reuse is by whole blocks; a smaller block wastes less of a short tail" },
    ],
    caveats: ["Without --enable-prompt-tokens-details a response reports no cached_tokens: hits are then unknown, not zero.", "Do not use the engine's keep/pause or cache-reset options as a per-agent feature."],
    neverCall: ["/reset_prefix_cache", "/pause", "/resume"],
    prepare(request, ctx): Prepared {
      const body = copy(request); const applied: string[] = []; const skipped: string[] = [];
      if (ctx.plain === true) return prepared(body, applied, skipped, "no");
      if (!on) { skipped.push("cache_salt: automatic prefix caching is off for this endpoint"); return prepared(body, applied, skipped, "no"); }
      body["cache_salt"] = safeKey(ctx.scopeKey); applied.push("cache_salt");
      return prepared(body, applied, skipped, "yes");
    },
    read: (response) => (o.promptDetails === false ? EMPTY_HIT("usage.prompt_tokens_details.cached_tokens", "the server is configured without --enable-prompt-tokens-details") : readOpenAi(response)),
    refusedCacheSetting: refusedBy(/\bcache_salt\b/),
    slotted: false,
  };
}

// ---- Radiance ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
function radiance(model: string, o: EndpointOptions): CacheProfile {
  const hybrid = o.hybrid !== false;
  const capabilities: CacheCapabilities = {
    prefixReuse: "automatic",
    retention: { control: "server", via: o.hostTier === true ? "VRAM blocks move to the host tier (--prefix-cache-mib) and are dropped after --prefix-cache-ttl idle seconds; not per request" : "VRAM blocks only, dropped by pool pressure or --prefix-cache-ttl; no host tier is configured" },
    isolation: "none",
    pin: UNSUPPORTED("no per-request pin; --prefix-cache-ttl 0 keeps conversations until memory is wanted, for the whole server"),
    fork: AVAILABLE("a conversation that starts with another's tokens (a shared system prompt) reuses them; a shared head stays while any conversation using it is used"),
    decoderResume: NO_DECODER_RESUME,
    slotSaveRestore: UNSUPPORTED("conversations are keyed by their tokens; there are no named slot files"),
  };
  return {
    kind: "radiance", label: "Radiance", model, wire: "openai-chat", capabilities, minPrefixTokens: 1, defaultLifetimeMs: 3_600_000,
    basis: "Radiance source (codeberg StillDeadcode/radiance, commit 123c439, 2026-10-22) and RADIANCE-R9700-SETUP-READ-ME; nothing was run",
    hitFields: ["timings.cache_n", "timings.prompt_n", "usage.prompt_tokens_details.cached_tokens"],
    tuning: [
      { where: "request", setting: "session_id", why: "a label only (shown in /sessions); it does not select a cache entry" },
      { where: "server", setting: "--prefix-cache-mib", value: "at least one full conversation (about 1.43 GiB per 200K tokens on Flash-Next, 7.32 KiB a token)", why: "host tier for idle conversations; smaller than one conversation means the tail is prefilled again" },
      { where: "server", setting: "--prefix-cache-ttl", value: "3600", why: "seconds an unused conversation is kept; 0 keeps it until the memory is wanted" },
      { where: "server", setting: "--checkpoint-slots", value: "auto", why: "linear-state snapshots of a hybrid model; without the snapshot under the next prompt nothing is reused" },
      { where: "server", setting: "--max-num-seqs", value: "8 on Flash-Next", why: "each sequence holds recurrent state; the pool must hold the live sessions or the next turn re-prefills everything (the cache cliff)" },
    ],
    caveats: [
      "cache_prompt, id_slot and prompt_cache_key are accepted and ignored by this server; the profile does not send them.",
      ...(hybrid ? ["On a hybrid model cache_n can count attention blocks restored while every linear layer was re-run, so a high hit figure can still be a slow turn; check /sessions or the prompt time."] : []),
      "Conversations computed with a control vector or LoRA adapter are partitioned from those without; switching modes recomputes.",
      "Never call POST /reset_prefix_cache: it empties every agent's cache.",
    ],
    neverCall: ["/reset_prefix_cache"],
    prepare(request, ctx): Prepared {
      const body = copy(request); const applied: string[] = []; const skipped: string[] = [];
      if (ctx.plain === true) return prepared(body, applied, skipped, "no");
      body["session_id"] = safeKey(ctx.shareKey ?? ctx.scopeKey).slice(0, 128); applied.push("session_id");
      return prepared(body, applied, skipped, "yes");
    },
    read: (response) => readTimings(response, hybrid ? "hybrid model: a hit may not include the linear-state snapshot" : undefined),
    refusedCacheSetting: refusedBy(/\bsession_id\b/),
    slotted: false,
  };
}

// ---- Strata ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
function strata(model: string, o: EndpointOptions): CacheProfile {
  const capabilities: CacheCapabilities = {
    prefixReuse: "automatic",
    retention: { control: "server", via: "up to 6 RAM checkpoints (the system-prompt root is kept for good); with --conversation-cache-mib parked conversations are kept oldest-evicted-first" },
    isolation: "none",
    pin: o.pinPrefix === true ? AVAILABLE("strata_prefix pins the checkpoint at the end of a shared document or preamble; one pinned prefix per engine, a new one replaces it") : UNSUPPORTED("strata_prefix needs --prompt-cache 3 or more, which this endpoint is not configured with"),
    fork: AVAILABLE("a conversation that starts with a checkpoint inside a parked one borrows that prefix and leaves the parked conversation in place"),
    decoderResume: NO_DECODER_RESUME,
    slotSaveRestore: o.slotSave === true ? AVAILABLE("POST /slots/0?action=save|restore (session files; Host and API-key checks; JSON from no Origin)") : UNSUPPORTED("session files are not configured"),
  };
  return {
    kind: "strata", label: "Strata", model, wire: "openai-chat", capabilities, minPrefixTokens: 1, defaultLifetimeMs: 3_600_000,
    basis: "Strata main 011c9e6 (CMakeLists reports 0.1.47, 2026-10-21) read as source and docs; the installed server is 0.1.43. Settings marked 'since' do not exist in 0.1.43. Nothing was run",
    hitFields: ["timings.cache_n", "timings.prompt_n", "usage.prompt_tokens_details.cached_tokens"],
    tuning: [
      { where: "request", setting: "strata_prefix", value: '{"messages": N}', why: "pin the shared document or common preamble so many questions cost one read of it" },
      { where: "request", setting: "strata_checkpoint", value: "false", why: "a one-shot call saves no checkpoints and does not evict a long conversation's" },
      { where: "server", setting: "--prompt-cache", value: "3 or more", why: "checkpoints in RAM; strata_prefix needs at least 3" },
      { where: "server", setting: "--conversation-cache-mib / --conversation-cache-slots", value: "8192 / 4", why: "park conversations in RAM so alternating agents restore instead of re-reading" },
      { where: "server", setting: "--conversation-cache-min-tokens", why: "park only long conversations so short side requests do not evict them" },
      { where: "server", setting: "--conversation-cache-park-gain", why: "do not rewrite a whole snapshot for a few hundred new tokens", since: "after 0.1.43 (present in main, 0.1.47)" },
      { where: "server", setting: "--prompt-cache-spread", why: "thin checkpoints geometrically so an edit a few thousand tokens back does not re-read the whole conversation", since: "after 0.1.43 (present in main, 0.1.47)" },
      { where: "server", setting: "STRATA_CACHE_MESSAGE_BOUNDARY=1", why: "checkpoint the previous turn boundary so editing the last user message re-reads little" },
    ],
    caveats: ["Switching conversations does not run requests concurrently; it only avoids re-reading.", "Prompt-cache options and the conversation cache are off or limited by default and layer-split runs exclude some of them.", "Strata is being replaced by Radiance on the owner's hardware; nothing may depend on a Strata-only feature."],
    neverCall: [],
    prepare(request, ctx): Prepared {
      const body = copy(request); const applied: string[] = []; const skipped: string[] = [];
      if (ctx.plain === true) return prepared(body, applied, skipped, "no");
      if (ctx.oneShot === true) { body["strata_checkpoint"] = false; applied.push("strata_checkpoint"); }
      if (ctx.pinMessages !== undefined) {
        const messages = body["messages"];
        if (o.pinPrefix !== true) skipped.push("strata_prefix: this endpoint is not configured for pinning");
        else if (ctx.pinAuthorized !== true) skipped.push("strata_prefix: this project holds no pin marker for the route (the route has one pin, held by one project; register a pin marker first)");
        else if (!Number.isSafeInteger(ctx.pinMessages) || ctx.pinMessages < 1 || !Array.isArray(messages) || ctx.pinMessages >= messages.length) skipped.push("strata_prefix: the pinned part must be at least one message and leave a message after it");
        else { body["strata_prefix"] = { messages: ctx.pinMessages }; applied.push("strata_prefix"); }
      }
      return prepared(body, applied, skipped, "yes");
    },
    read: (response) => readTimings(response),
    refusedCacheSetting: refusedBy(/\bstrata_(prefix|checkpoint)\b/),
    slotted: false,
    slotRequest: (action, slot, filename) => {
      if (o.slotSave !== true) throw new DomainError("invalid_command", "session files are not configured for this endpoint", { field: "slotSave" });
      if (slot !== 0) throw new DomainError("invalid_command", "slot: Strata saves and restores slot 0 only", { field: "slot" });
      return slotRequest("/slots", action, slot, filename);
    },
  };
}

// ---- OpenAI and compatible services --------------------------------------------------------------------------------------------------------------------------------------------------
function openai(model: string, o: EndpointOptions, compatible: boolean): CacheProfile {
  const min = o.minPrefixTokens ?? 1024;
  const extended = !compatible && o.extendedRetention === true;
  const keyed = !compatible || o.promptCacheKey === true;
  const capabilities: CacheCapabilities = {
    prefixReuse: "automatic",
    retention: extended ? { control: "request", via: "prompt_cache_retention: in_memory (default, minutes) or 24h", maxMs: 86_400_000 } : { control: "none", via: compatible ? "the service decides; no retention field is sent" : "in-memory retention only for this model (minutes of inactivity)" },
    // prompt_cache_key steers routing so that requests with one key tend to meet the same cache; it is a hint, not a partition, so isolation is none.
    isolation: "none",
    pin: UNSUPPORTED("retention is bounded (minutes, or 24h on supporting models) and no pin exists"),
    fork: AVAILABLE("requests with the same prefix and the same prompt_cache_key are routed together and share the cached prefix"),
    decoderResume: NO_DECODER_RESUME,
    slotSaveRestore: UNSUPPORTED("hosted API; no slot files"),
  };
  return {
    kind: compatible ? "openai-compatible" : "openai", label: compatible ? "OpenAI-compatible service" : "OpenAI", model, wire: "openai-chat", capabilities, minPrefixTokens: min, defaultLifetimeMs: extended ? 86_400_000 : 300_000,
    basis: compatible ? "OpenAI prompt-caching guidance applied conservatively: a compatible service may ignore or reject these fields, so only fields the owner confirmed are sent" : "OpenAI prompt-caching guidance (automatic caching from 1,024 tokens in 128-token steps, prompt_cache_key, prompt_cache_retention); not measured here",
    hitFields: ["usage.prompt_tokens_details.cached_tokens", "usage.input_tokens_details.cached_tokens"],
    tuning: [
      { where: "request", setting: "prompt_cache_key", why: "groups requests that share a prefix (per project or meeting, not per session) so they are routed to the same cache" },
      ...(extended ? [{ where: "request" as const, setting: "prompt_cache_retention", value: "24h", why: "keeps a long shared prefix across idle gaps" }] : []),
      { where: "request", setting: "prefix order", why: "stable content first; only whole 128-token steps after the first 1,024 tokens are cached" },
    ],
    caveats: ["Nothing under the minimum prefix is cached, so a short prompt with zero cached tokens is expected, not a miss.", "Many requests a minute on one key and prefix can overflow to other machines and lower hits (OpenAI guidance; verify in G10).", ...(compatible ? ["A compatible service may report cached_tokens differently or not at all; a missing figure is unknown, not zero."] : [])],
    neverCall: [],
    prepare(request, ctx): Prepared {
      const body = copy(request); const applied: string[] = []; const skipped: string[] = [];
      if (ctx.plain === true) return prepared(body, applied, skipped, "no");
      if (keyed) { body["prompt_cache_key"] = safeKey(ctx.shareKey ?? ctx.scopeKey).slice(0, 64); applied.push("prompt_cache_key"); }
      else skipped.push("prompt_cache_key: this service is not confirmed to accept it");
      if (ctx.retention === "long") {
        if (extended) { body["prompt_cache_retention"] = "24h"; applied.push("prompt_cache_retention"); }
        else skipped.push("prompt_cache_retention: not available for this endpoint");
      }
      const small = ctx.prefixTokens !== undefined && ctx.prefixTokens < min;
      if (small) skipped.push(`caching: the shared prefix (about ${ctx.prefixTokens} tokens) is under the ${min}-token minimum`);
      return prepared(body, applied, skipped, small ? "no" : compatible ? "maybe" : "yes");
    },
    read: (response) => (compatible ? (readOpenAi(response).known ? readOpenAi(response) : readTimings(response)) : readOpenAi(response)),
    refusedCacheSetting: refusedBy(/\b(prompt_cache_key|prompt_cache_retention)\b/),
    slotted: false,
  };
}

// ---- Claude ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
/** Smallest cacheable prefix by model (tokens), from the Claude API guidance as of 2026-10-06. The 512 figures are marked 'check the docs' there, so they are the least certain. An unlisted model gets the highest figure so no breakpoint is placed that would silently not cache. */
export const CLAUDE_MIN_TOKENS: Readonly<Record<string, number>> = {
  "claude-opus-5-5": 512, "claude-opus-5": 512, "claude-fable-5": 512, "claude-fable-5-1": 512, "claude-mythos-5": 512, "claude-mythos-5-1": 512, "claude-sonnet-5-5": 512, "claude-haiku-5-5": 512,
  "claude-opus-4-8": 1024, "claude-sonnet-5": 1024, "claude-sonnet-4-6": 1024, "claude-sonnet-4-5": 1024, "claude-opus-4-1": 1024, "claude-opus-4": 1024, "claude-sonnet-4": 1024,
  "claude-opus-4-7": 2048, "claude-haiku-3-5": 2048,
  "claude-opus-4-6": 4096, "claude-opus-4-5": 4096, "claude-haiku-4-5": 4096,
};
const CLAUDE_MAX_BREAKPOINTS = 4;
const CHARS_PER_TOKEN = 3;
const blocksOf = (content: unknown): Record<string, unknown>[] | undefined => {
  if (typeof content === "string") return content.length === 0 ? undefined : [{ type: "text", text: content }];
  return Array.isArray(content) && content.every(isObject) ? (content as Record<string, unknown>[]) : undefined;
};
/**
 * Removes `cache_control` only where the Messages API takes it: each tool, each system block, each top-level content block of a message and each content block inside a tool_result.
 * Everything else (a tool's input_schema, a tool_use input, any text) is the model's data and is never touched, even when it holds a key of that name.
 */
function strip(body: WireRequest): void {
  const clear = (v: unknown): void => { if (isObject(v)) delete v["cache_control"]; };
  if (Array.isArray(body["tools"])) body["tools"].forEach(clear);
  if (Array.isArray(body["system"])) body["system"].forEach(clear);
  if (Array.isArray(body["messages"])) {
    for (const m of body["messages"]) {
      if (!isObject(m) || !Array.isArray(m["content"])) continue;
      for (const block of m["content"]) {
        clear(block);
        if (isObject(block) && block["type"] === "tool_result" && Array.isArray(block["content"])) block["content"].forEach(clear);
      }
    }
  }
}
const tokensOf = (v: unknown): number => Math.ceil(JSON.stringify(v ?? null).length / CHARS_PER_TOKEN);
const CANNOT_MARK = new Set(["thinking", "redacted_thinking"]);

function claude(model: string, o: EndpointOptions): CacheProfile {
  const min = o.minPrefixTokens ?? CLAUDE_MIN_TOKENS[model] ?? 4096;
  const listed = Object.hasOwn(CLAUDE_MIN_TOKENS, model);
  const capabilities: CacheCapabilities = {
    prefixReuse: "markers",
    retention: { control: "request", via: "cache_control ttl: 5m (default, refreshed by each read) or 1h (write costs 2x instead of 1.25x); the 1h entries must come before the 5m ones", maxMs: 3_600_000 },
    isolation: "none",
    pin: UNSUPPORTED("retention is bounded to 5 minutes or 1 hour and refreshed only by use; there is no pin"),
    fork: AVAILABLE("requests with an identical prefix up to a breakpoint read the same entry (cache is per organization and model)"),
    decoderResume: NO_DECODER_RESUME,
    slotSaveRestore: UNSUPPORTED("hosted API; no slot files"),
  };
  return {
    kind: "claude", label: "Claude (Messages API prompt caching)", model, wire: "anthropic-messages", capabilities, minPrefixTokens: min, defaultLifetimeMs: 300_000,
    basis: `Claude API prompt-caching guidance (claude-api skill, cached 2026-10-06): at most ${CLAUDE_MAX_BREAKPOINTS} breakpoints, ttl 5m or 1h, per-model minimum prefix${listed ? "" : `; model ${model} is not in the minimum table, so the highest minimum (4096) is assumed`}`,
    hitFields: ["usage.cache_read_input_tokens", "usage.cache_creation_input_tokens", "usage.cache_creation.ephemeral_5m_input_tokens", "usage.cache_creation.ephemeral_1h_input_tokens"],
    tuning: [
      { where: "request", setting: "cache_control", value: '{"type":"ephemeral","ttl":"5m"|"1h"}', why: "breakpoints at stability boundaries: end of tools or system (stable), end of shared project context, last message (growing history)" },
      { where: "request", setting: "ttl", value: "1h for the stable head, 5m for the tail", why: "a head reused across gaps longer than 5 minutes is cheaper at 1h; the longer TTL must come first" },
    ],
    caveats: [
      "A prefix shorter than the model's minimum silently does not cache (no error).",
      "Any byte change before a breakpoint invalidates that breakpoint and everything after it; render order is tools, system, messages.",
      "A breakpoint looks back at most 20 blocks for an earlier entry; a turn that adds more than 20 blocks needs an intermediate breakpoint.",
      "Cache writes cost 1.25x (5m) or 2x (1h) the input price and reads about 0.1x or less; input_tokens counts only what follows the last breakpoint.",
      ...(listed ? [] : [`The minimum for ${model} is assumed to be 4096 tokens because the model is not in the table.`]),
    ],
    neverCall: [],
    prepare(request, ctx): Prepared {
      const body = copy(request); const applied: string[] = []; const skipped: string[] = [];
      strip(body);
      if (ctx.plain === true) return prepared(body, applied, skipped, "no");
      const messages = Array.isArray(body["messages"]) ? (body["messages"] as Record<string, unknown>[]) : [];
      const tools = Array.isArray(body["tools"]) ? (body["tools"] as Record<string, unknown>[]) : [];
      const plan = ctx.breakpoints ?? defaultPlan(body, ctx.retention);
      if (plan.length > CLAUDE_MAX_BREAKPOINTS) throw new DomainError("invalid_command", `breakpoints: at most ${CLAUDE_MAX_BREAKPOINTS} per request`, { field: "breakpoints" });
      // Render order is tools, system, then messages by index; entries with the longer lifetime must come first, so a 1h after a 5m is lowered to 5m.
      const rank = (p: (typeof plan)[number]): number => (p.at === "tools-end" ? -1_000_000 : p.at === "system-end" ? -1000 : p.at === "last-message" ? messages.length - 1 : "message" in p.at ? p.at.message : -100_000 + p.at.systemBlock);
      const ordered = [...plan].sort((a, b) => rank(a) - rank(b));
      let seenShort = false;
      const placed = new Set<unknown>();
      for (const p of ordered) {
        if (p.ttl !== "5m" && p.ttl !== "1h") throw new DomainError("invalid_command", "breakpoints: ttl must be 5m or 1h", { field: "breakpoints" });
        let ttl = p.ttl;
        if (ttl === "1h" && seenShort) { ttl = "5m"; skipped.push("ttl 1h lowered to 5m: a 1h entry cannot follow a 5m entry"); }
        const block = markable(p.at, body, tools, messages, skipped);
        if (block === undefined) continue;
        const upTo = prefixTokens(p.at, body, tools, messages);
        if (upTo < min) { skipped.push(`breakpoint ${describe(p.at)}: about ${upTo} tokens, under the ${min}-token minimum for ${model}`); continue; }
        if (placed.has(block)) { skipped.push(`breakpoint ${describe(p.at)}: same block as another breakpoint`); continue; }
        placed.add(block);
        block["cache_control"] = { type: "ephemeral", ttl };
        if (ttl === "5m") seenShort = true;
        applied.push(`cache_control ${describe(p.at)} ${ttl}`);
      }
      return prepared(body, applied, skipped, applied.length > 0 ? "yes" : "no");
    },
    read: readClaude,
    refusedCacheSetting: refusedBy(/\bcache_control\b|\bttl\b/),
    slotted: false,
  };
}
type At = "tools-end" | "system-end" | "last-message" | { readonly message: number } | { readonly systemBlock: number };
const describe = (a: At): string => (typeof a === "string" ? a : "message" in a ? `message ${a.message}` : `system block ${a.systemBlock}`);

function defaultPlan(body: WireRequest, retention: Retention | undefined) {
  const head = retention === "long" ? "1h" as const : "5m" as const;
  const plan: { at: "tools-end" | "system-end" | "last-message"; ttl: "5m" | "1h" }[] = [];
  if (body["system"] !== undefined && body["system"] !== "") plan.push({ at: "system-end", ttl: head });
  else if (Array.isArray(body["tools"]) && body["tools"].length > 0) plan.push({ at: "tools-end", ttl: head });
  plan.push({ at: "last-message", ttl: "5m" });
  return plan;
}

/** The block a breakpoint marks. Text content given as a plain string becomes one text block so it can carry a marker. */
function markable(where: At, body: WireRequest, tools: Record<string, unknown>[], messages: Record<string, unknown>[], skipped: string[]): Record<string, unknown> | undefined {
  if (where === "tools-end") { const t = tools[tools.length - 1]; if (t === undefined) skipped.push("breakpoint tools-end: there are no tools"); return t; }
  if (where === "system-end") {
    const blocks = blocksOf(body["system"]);
    if (blocks === undefined) { skipped.push("breakpoint system-end: there is no system prompt"); return undefined; }
    if (typeof body["system"] === "string") body["system"] = blocks;
    return pickLast(blocks, skipped, "system-end");
  }
  if (typeof where === "object" && "systemBlock" in where) {
    const blocks = blocksOf(body["system"]);
    const target = blocks?.[where.systemBlock];
    if (blocks === undefined || target === undefined || !Number.isSafeInteger(where.systemBlock) || where.systemBlock < 0) { skipped.push(`breakpoint ${describe(where)}: there is no such system block`); return undefined; }
    if (typeof body["system"] === "string") body["system"] = blocks;
    if (CANNOT_MARK.has(String(target["type"]))) { skipped.push(`breakpoint ${describe(where)}: thinking blocks cannot carry a marker`); return undefined; }
    return target;
  }
  const index = where === "last-message" ? messages.length - 1 : where.message;
  const m = messages[index];
  if (m === undefined || !Number.isSafeInteger(index) || index < 0) { skipped.push(`breakpoint ${describe(where)}: there is no such message`); return undefined; }
  const blocks = blocksOf(m["content"]);
  if (blocks === undefined) { skipped.push(`breakpoint ${describe(where)}: the message has no content to mark`); return undefined; }
  if (typeof m["content"] === "string") m["content"] = blocks;
  return pickLast(blocks, skipped, describe(where));
}
function pickLast(blocks: Record<string, unknown>[], skipped: string[], label: string): Record<string, unknown> | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) if (!CANNOT_MARK.has(String(blocks[i]!["type"]))) return blocks[i];
  skipped.push(`breakpoint ${label}: only thinking blocks, which cannot carry a marker`);
  return undefined;
}
/** Tokens (estimated from characters) of everything the breakpoint's prefix covers: tools, system and messages up to and including its message. */
function prefixTokens(where: At, body: WireRequest, tools: Record<string, unknown>[], messages: Record<string, unknown>[]): number {
  if (where === "tools-end") return tokensOf(tools);
  const head = tokensOf(tools) + tokensOf(body["system"]);
  if (where === "system-end") return head;
  if (typeof where === "object" && "systemBlock" in where) return tokensOf(tools) + tokensOf(Array.isArray(body["system"]) ? body["system"].slice(0, where.systemBlock + 1) : body["system"]);
  const index = where === "last-message" ? messages.length - 1 : where.message;
  return head + tokensOf(messages.slice(0, index + 1));
}

// ---- generic -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
function generic(model: string): CacheProfile {
  return {
    kind: "generic", label: "Generic (nothing assumed)", model, wire: "openai-chat",
    capabilities: { prefixReuse: "none", retention: { control: "none", via: "unknown" }, isolation: "none", pin: UNSUPPORTED("unknown backend"), fork: UNSUPPORTED("unknown backend"), decoderResume: NO_DECODER_RESUME, slotSaveRestore: UNSUPPORTED("unknown backend") },
    basis: "no backend kind was configured, or it is not one this code knows; no cache behaviour is assumed", hitFields: ["usage.prompt_tokens_details.cached_tokens (read if present)"],
    tuning: [], caveats: ["Set the endpoint's kind in the configuration to get a tuned profile; it is never guessed from a name or address."], neverCall: [],
    prepare: (request) => prepared(copy(request), [], [], "no"),
    read: (response) => readOpenAi(response),
    refusedCacheSetting: () => false,
    slotted: false,
  };
}

/** The profile for a configured endpoint. Only `kind` decides; `model` is carried into the profile but never interpreted except to look up Claude's minimum prefix length once the kind says Claude. */
export function profileFor(config: EndpointConfig): CacheProfile {
  const inner = bareProfile(config);
  if (inner.capabilities.isolation !== "none") return inner;
  // A project that requires isolation gets no cache settings on a backend that cannot keep projects apart; llama.cpp is told explicitly not to reuse the slot's prompt.
  return {
    ...inner,
    prepare(request, ctx): Prepared {
      if (ctx.isolationRequired !== true) return inner.prepare(request, ctx);
      const plain = inner.prepare(request, { ...ctx, plain: true });
      const body = plain.body;
      const applied: string[] = [];
      if (inner.kind === "llama-cpp") { body["cache_prompt"] = false; applied.push("cache_prompt=false"); }
      // Strata cannot switch reuse off per request; the most we can do is not leave checkpoints or a pin of this project's prompt behind. Only a route of its own isolates on Strata.
      if (inner.kind === "strata") { body["strata_checkpoint"] = false; applied.push("strata_checkpoint=false"); }
      return { body, headers: plain.headers, applied, skipped: [...plain.skipped, `no cache settings: this project requires isolation and ${inner.label} cannot keep projects apart${inner.kind === "llama-cpp" ? "" : " (its own cache may still run; only a route of its own isolates)"}`], expects: "no" };
    },
  };
}

function bareProfile(config: EndpointConfig): CacheProfile {
  const e = checkEndpoint(config);
  const kind: BackendKind = e.kind;
  switch (kind) {
    case "llama-cpp": return llamaCpp(e.model, e.options);
    case "vllm": return vllm(e.model, e.options);
    case "radiance": return radiance(e.model, e.options);
    case "strata": return strata(e.model, e.options);
    case "openai": return openai(e.model, e.options, false);
    case "openai-compatible": return openai(e.model, e.options, true);
    case "claude": return claude(e.model, e.options);
    case "generic": return generic(e.model);
  }
}
