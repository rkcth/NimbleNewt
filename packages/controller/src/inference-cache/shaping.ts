import type { Breakpoint, CacheContext, CacheProfile, WireRequest } from "./profile.js";

/**
 * What the dispatcher hands the Pi adapter's `cache` option for one model (card C06b): the key of the shared prefix, the retention the backend honours and a function that puts the backend's own request settings into the
 * body Pi is about to send. The settings come from the C06 profile, so there is one place that knows what each backend needs; the Pi adapter only applies them. The result is shaped, never guessed: a profile that assumes
 * nothing (generic) yields no key, no retention and an unchanged body.
 */
export interface PiCachePolicy {
  readonly key?: string;
  readonly retention?: "none" | "short" | "long";
  readonly payload: (payload: unknown) => unknown;
  /** Set when the policy gives less than the context asked for, and why (an isolation requirement, or a slotted server). */
  readonly degraded?: string;
  /** Set by the dispatcher (card H12e) when Pi's HTTP calls for this model go through the endpoint's cache state: wraps the fetch the provider SDK uses. See `ModelCachePolicy.fetch`. */
  readonly fetch?: (inner: typeof globalThis.fetch) => typeof globalThis.fetch;
}

/**
 * The breakpoints that let agents of one project share a cached prefix on Claude: the end of the tools, the end of the shared system block (preamble and project context), the end of the whole system prompt
 * (the agent's own instructions) and the last message. Four is the most the API takes. The longer lifetime goes to the three head breakpoints, the growing tail gets five minutes.
 */
export function sharedPrefixBreakpoints(retention: "short" | "long" | undefined): Breakpoint[] {
  const head = retention === "long" ? "1h" as const : "5m" as const;
  return [{ at: "tools-end", ttl: head }, { at: { systemBlock: 0 }, ttl: head }, { at: "system-end", ttl: head }, { at: "last-message", ttl: "5m" }];
}

/**
 * The cache policy for a call: `context.shareKey` (a project, a meeting) is the key every agent that can share a prefix uses, falling back to the project's scope key. It is never a task or session ID.
 * `splitSystem` says the Pi adapter sends the shared system text as a block of its own (it does when `promptLayout` is set), which is what lets Claude put a breakpoint between the shared and the agent-specific text.
 */
export function piCachePolicy(profile: CacheProfile, context: CacheContext, options: { readonly splitSystem?: boolean; /** The call goes through `CacheAdapter` (slot turns, holder checks, `prepare`), which then does everything this policy would do to the body of a slotted server. */ readonly routed?: boolean } = {}): PiCachePolicy {
  // A project that requires isolation, on a backend that cannot keep projects' entries apart, gets no cache setting at all: no key, no retention, and the body is stripped of any the SDK wrote (OpenAI's prompt_cache_key and retention).
  const isolated = context.isolationRequired === true && profile.capabilities.isolation === "none";
  const plain = context.plain === true || isolated;
  // A slotted server (llama.cpp with slots) needs C06's slot partitioning: one turn per slot, the last holder checked and cleared, the holder recorded after the call. That happens around the HTTP call, which
  // Pi makes itself, so it cannot be done in a payload edit. When the dispatcher sends Pi's calls through `CacheAdapter` (`routed`) the adapter does it and prepares the body; the body is left alone here. Otherwise (the
  // adapter's state is not available) the call names no slot and runs with reuse off, so it can never read another project's KV.
  const routed = options.routed === true && profile.slotted;
  const slotted = profile.slotted && !plain && !routed;
  const { slot: _slot, ...withoutSlot } = context;
  const withContext: CacheContext = slotted ? { ...withoutSlot, reuseOff: true } : context;
  const effective: CacheContext = options.splitSystem === true && profile.kind === "claude" && withContext.breakpoints === undefined && !plain
    ? { ...withContext, breakpoints: sharedPrefixBreakpoints(withContext.retention) }
    : isolated ? { ...withContext, plain: true } : withContext;
  const shapes = profile.kind !== "generic";
  const controllable = profile.capabilities.retention.control === "request";
  return {
    ...(shapes && !plain ? { key: context.shareKey ?? context.scopeKey } : {}),
    ...(plain ? (shapes ? { retention: "none" as const } : {}) : controllable && context.retention !== undefined ? { retention: context.retention } : {}),
    payload: (payload) => {
      if (routed) return payload;
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return payload;
      const body = profile.prepare(payload as WireRequest, effective).body;
      if (!plain) return body;
      const { prompt_cache_key: _key, prompt_cache_retention: _retention, ...rest } = body as Record<string, unknown>;
      return rest;
    },
    ...(isolated ? { degraded: "the project requires isolation and this backend cannot keep projects apart: no cache settings" } : slotted ? { degraded: "slotted server: the cache adapter's state is not available, so reuse is off" } : {}),
  };
}
