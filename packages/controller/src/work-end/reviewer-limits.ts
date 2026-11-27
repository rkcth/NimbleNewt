/**
 * The reply limit and time limit of one call of the second agent that questions a done (card W10; W09 fixes, 2026-11-27). Before, every call had a fixed 1,500-token reply and a 60 s time limit. A reasoning model (a Radiance
 * or other local reasoning server) can spend all of 1,500 tokens thinking and answer with no text, or need longer than 60 s, so the questioning did not run and the done failed closed (W09 first reading, run 1).
 *
 * The rule, per route, read at each call:
 * - A route whose budget declares a reply limit (`routing.budget.set` `maxTokens`, card W07) uses it, at most `hardReplyTokens`. Its declared reasoning cap (`reasoningTokens`) is sent in the field the endpoint's kind names
 *   (the same table as the worker relay's, `applyRouteBudget`). A declared reply limit is also the ceiling: a cut reply is never asked again with more than the owner allowed.
 * - Otherwise the default depends on the endpoint's kind: kinds that serve reasoning models with a known reasoning field (`radiance`, `vllm`, `llama-cpp`) get `reasoningReplyTokens`; every other kind keeps `replyTokens` (1,500,
 *   as before). The ceiling for a cut reply is `hardReplyTokens` for a reasoning kind and `cutCeilingTokens` otherwise.
 * - The time limit follows the reply limit (for a reasoning kind, its ceiling): `msPerToken` per token, at least the old 60 s, at most `hardTimeoutMs`. It covers the whole call, the one retry after a cut reply included.
 *
 * ASSUMPTION: 40 ms a token (25 tokens a second) is a slow local server's pace; a faster one answers well within it, and a hung one is given up at the limit. The time limit only bounds waiting, it costs nothing.
 * ASSUMPTION: no owner setting is added for these figures; the existing route budget (`routing.budget.set`, reachable in chat) is the owner's control, and it now applies to the second agent too.
 */
import { REVIEWER_LIMITS } from "./reviewer-model.js";

export const REVIEWER_CALL_LIMITS = {
  replyTokens: 1500, timeoutMs: 60_000,
  reasoningReplyTokens: 8192,
  cutCeilingTokens: 6000,
  hardReplyTokens: 32_768, hardTimeoutMs: 480_000,
  msPerToken: 40,
  /** The most the second agent's request can hold, in tokens (its system and user texts at their bounds, a token for every 3 characters: more than they hold), and a margin, for the window check below. */
  promptTokens: Math.ceil((REVIEWER_LIMITS.system + REVIEWER_LIMITS.user) / 3), windowMarginTokens: 256,
} as const;

/** Endpoint kinds whose servers commonly run reasoning models and whose reasoning field is known (route-budget.ts). */
export const REASONING_KINDS: readonly string[] = ["radiance", "vllm", "llama-cpp"];

export interface ReviewerCallLimits {
  /** `max_tokens` of the first call. */
  readonly replyTokens: number;
  /** The most a call cut at its limit with no text may be asked again with (equal to `replyTokens`: no second call). */
  readonly ceilingTokens: number;
  /** The whole call's time limit, the retry included. */
  readonly timeoutMs: number;
  /** The route's declared reasoning cap, sent in the kind's field. */
  readonly reasoningTokens?: number;
  readonly kind?: string;
}

const whole = (v: unknown): number | undefined => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : undefined);

/** The limits of a call on a route of `kind` with the route's declared budget (either may be absent). */
export function reviewerCallLimits(route: { readonly kind?: string; readonly maxTokens?: number; readonly reasoningTokens?: number; readonly contextTokens?: number }): ReviewerCallLimits {
  const L = REVIEWER_CALL_LIMITS;
  const kind = typeof route.kind === "string" && route.kind !== "" ? route.kind.slice(0, 40) : undefined;
  const reasons = kind !== undefined && REASONING_KINDS.includes(kind);
  const declared = whole(route.maxTokens);
  // The defaults (not an owner's declared limit) also fit the route's window with the largest request: a reviewer route may be as small as REVIEWER_LIMITS.contextTokens (12,000), where 8,192 tokens of reply and a full prompt,
  // or a retry at 32,768, would be refused by the server as too large. Never below the old 1,500 (what such a route was asked for before).
  const window = whole(route.contextTokens);
  const room = window === undefined ? Number.POSITIVE_INFINITY : Math.max(L.replyTokens, window - L.promptTokens - L.windowMarginTokens);
  const replyTokens = Math.min(declared ?? Math.min(reasons ? L.reasoningReplyTokens : L.replyTokens, room), L.hardReplyTokens);
  const ceilingTokens = declared !== undefined ? replyTokens : Math.max(replyTokens, Math.min(reasons ? L.hardReplyTokens : L.cutCeilingTokens, room));
  // A reasoning kind's time follows its ceiling (the retry may need it); any other kind's its first reply limit, so the default stays the old 60 s.
  const timeoutMs = Math.min(L.hardTimeoutMs, Math.max(L.timeoutMs, (reasons ? ceilingTokens : replyTokens) * L.msPerToken));
  const cap = whole(route.reasoningTokens);
  return { replyTokens, ceilingTokens, timeoutMs, ...(cap === undefined ? {} : { reasoningTokens: Math.min(cap, replyTokens - 1) }), ...(kind === undefined ? {} : { kind }) };
}
