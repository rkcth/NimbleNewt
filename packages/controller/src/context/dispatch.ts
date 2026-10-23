import { redactText } from "../security/redact.js";
import { buildStartup, tokensOf, type ContextBudget, type StartupItem, type StartupResult } from "./budget.js";

// Card C07b: what the dispatcher (H12) calls at the moments where the C07 budgets must be enforced. Everything here is a pure function; the durable parts are in enforcement.ts.

// ---- admission of the first call -----------------------------------------------------------------------------------------

/** What the first call of an attempt is made of. Sizes are in characters (estimated at the budget's characters per token) unless the name says tokens. */
export interface FirstCall {
  /** The runtime's system prompt (Pi's), as it will be sent. */
  readonly systemPromptChars: number;
  /** Every tool's name, description and parameter schema, as offered to the model (Pi's tools and MCP tools). */
  readonly toolSchemaChars: number;
  /** What the startup builder adds (its `tokens`), or the size of the prompt otherwise. */
  readonly startupTokens: number;
  /** Room kept free for the model's answer. */
  readonly replyReserveTokens: number;
  /** Tool output the first rounds are likely to bring; default one result at the per-tool limit. */
  readonly likelyToolOutputTokens?: number;
  /** The input size a provider reported for this same prompt (a token-count probe, or an earlier call of the same prefix). It wins over the estimate when larger. */
  readonly reportedInputTokens?: number;
}
export interface FirstCallDecision {
  readonly admit: boolean;
  /** The first call's size in tokens: the larger of the estimate and the provider's report. */
  readonly startupTokens: number;
  readonly estimatedTokens: number;
  readonly basis: "estimated" | "reported";
  readonly workingTokens: number;
  readonly limits: { readonly startup: number; readonly working: number };
  /** Why the call is refused; empty when admitted. */
  readonly reasons: readonly string[];
}
const whole = (v: unknown, name: string): number => { if (!Number.isSafeInteger(v) || (v as number) < 0) throw new RangeError(`${name} must be a whole number from 0`); return v as number; };

/**
 * The admission check of the first call (card C07b). The fixed part (Pi's system prompt and tool schemas) counts, the provider's reported size wins when it is larger than the estimate, and two limits
 * apply: the first call at most the startup share, and the first call plus likely tool output plus the reply reserve at most the working share. A refused call is never sent.
 */
export function admitFirstCall(call: FirstCall, budget: ContextBudget): FirstCallDecision {
  const fixed = tokensOf(whole(call.systemPromptChars, "systemPromptChars") + whole(call.toolSchemaChars, "toolSchemaChars"), budget);
  const estimated = fixed + whole(call.startupTokens, "startupTokens");
  const reported = call.reportedInputTokens === undefined ? undefined : whole(call.reportedInputTokens, "reportedInputTokens");
  const basis = reported !== undefined && reported > estimated ? "reported" : "estimated";
  const startup = basis === "reported" ? reported! : estimated;
  const reserve = whole(call.replyReserveTokens, "replyReserveTokens");
  const toolOutput = call.likelyToolOutputTokens === undefined ? tokensOf(budget.toolOutputChars, budget) : whole(call.likelyToolOutputTokens, "likelyToolOutputTokens");
  const working = startup + toolOutput + reserve;
  const reasons: string[] = [];
  if (startup > budget.startupTokens) reasons.push(`the first call is ${startup} tokens (${basis}; Pi's system prompt and tool schemas are ${fixed}), over the startup limit of ${budget.startupTokens} for a ${budget.window}-token window`);
  if (working > budget.workingTokens) reasons.push(`the first call (${startup}) plus likely tool output (${toolOutput}) plus the reply reserve (${reserve}) is ${working} tokens, over the working limit of ${budget.workingTokens}`);
  return { admit: reasons.length === 0, startupTokens: startup, estimatedTokens: estimated, basis, workingTokens: working, limits: { startup: budget.startupTokens, working: budget.workingTokens }, reasons };
}

/** Characters per token the provider's own count implies for a prompt of `chars` characters (feed it back as the `charsPerToken` override when the estimate was off). */
export function calibratedCharsPerToken(chars: number, reportedInputTokens: number): number {
  if (!Number.isSafeInteger(chars) || chars < 1 || !Number.isSafeInteger(reportedInputTokens) || reportedInputTokens < 1) throw new RangeError("chars and reportedInputTokens must be whole numbers from 1");
  return Math.round((chars / reportedInputTokens) * 100) / 100;
}

// ---- a smaller-window route ----------------------------------------------------------------------------------------------

export type RouteReview = { readonly kind: "rebuilt"; readonly startup: StartupResult } | { readonly kind: "blocked"; readonly startup: StartupResult; readonly reason: string };
/**
 * Falling back to a route with a smaller window: the context view is built again for that window (and that route's own fixed part), never reused. If the human's words, permissions, goal and newest
 * items do not fit, the result is blocked with the numbers: nothing is sent.
 */
export function reviewRouteChange(items: readonly StartupItem[], target: ContextBudget, fixedTokens: number): RouteReview {
  const startup = buildStartup(items, target, fixedTokens);
  if (startup.blocked !== undefined) return { kind: "blocked", startup, reason: `essential constraints do not fit the ${target.window}-token route: ${startup.blocked.reason} (need ${startup.blocked.needTokens} tokens, have ${startup.blocked.haveTokens})` };
  return { kind: "rebuilt", startup };
}

// ---- tool output limits for the runtime ------------------------------------------------------------------------------------

/** The per-tool limits for Pi's tools (its `outputLimits`: bytes, lines, which end is kept) at this window. Bytes are never fewer than characters, so the byte limit is the character limit. */
export function piOutputLimits(budget: ContextBudget, retain: "head" | "tail" = "head"): { readonly maxBytes: number; readonly maxLines: number; readonly retain: "head" | "tail" } {
  return { maxBytes: budget.toolOutputChars, maxLines: Math.max(50, Math.floor(budget.toolOutputChars / 20)), retain };
}

// ---- the bounded summariser ---------------------------------------------------------------------------------------------

export interface Summariser {
  /** Names the route in records ("local-llama", "cloud-large"). */
  readonly route: string;
  /** Writes the summary of `text` in at most `maxChars` characters. Must stop when `signal` aborts; if it does not, the caller stops waiting anyway. */
  summarise(input: { readonly text: string; readonly maxChars: number; readonly signal: AbortSignal }): Promise<string>;
}
export interface SummariseAttempt { readonly route: string; readonly outcome: "ok" | "timeout" | "error" | "unusable"; readonly ms: number; readonly note?: string }
export type Summarised =
  | { readonly kind: "aborted"; readonly attempts: readonly SummariseAttempt[] }
  | { readonly kind: "summary"; readonly summary: string; readonly route: string; readonly degraded: boolean; readonly attempts: readonly SummariseAttempt[] }
  | { readonly kind: "overflow"; readonly reason: string; readonly attempts: readonly SummariseAttempt[] };
export interface SummariseLimits {
  /** Each summariser's own hard time limit. */
  readonly timeoutMs: number;
  /** The whole chain's limit (the next route is not started after it). */
  readonly totalMs: number;
  /** The short summary limit, in characters. */
  readonly maxChars: number;
  /** A summary must be at most this share of the text it replaces, or it did not reduce anything. */
  readonly maxShare: number;
}
/**
 * The whole chain (including the extractive fallback, which takes no time) must finish before the Pi adapter's own ceiling on the `beforeCompact` hook (150 s by default) passes, or the adapter declines
 * first: 100 s in all leaves a 50 s margin, and 45 s per route allows two routes before the fallback.
 */
export const SUMMARY_DEFAULTS: SummariseLimits = { timeoutMs: 45_000, totalMs: 100_000, maxChars: 2000, maxShare: 0.5 };
export const EXTRACTIVE_ROUTE = "controller-extractive";

/** The fallback that cannot hang and needs no model: what must survive (pinned lines) plus the start and the end of the text, with credentials removed. */
export function extractiveSummary(text: string, maxChars: number, pinned: readonly string[] = []): string {
  const keep = pinned.map((p) => `Kept: ${p}`).join("\n");
  const room = Math.max(0, maxChars - keep.length - 120);
  const head = Math.floor(room * 0.4), tail = Math.floor(room * 0.6);
  const body = text.length <= room ? text : `${text.slice(0, head)}\n[… ${text.length - head - tail} characters left out; the originals are linked …]\n${text.slice(text.length - tail)}`;
  return redactText(`[Extractive summary, made without a model: the controller kept the start and the end.]\n${keep}${keep === "" ? "" : "\n"}${body}`).slice(0, maxChars);
}

type Within<T> = { ok: true; value: T } | { ok: false; timeout: boolean; aborted?: true; error?: unknown };
async function within<T>(ms: number, run: (signal: AbortSignal) => Promise<T>, outer?: AbortSignal): Promise<Within<T>> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let onOuter: (() => void) | undefined;
  const clock = new Promise<Within<T>>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve({ ok: false, timeout: true }); }, ms);
    // The caller stopped waiting: the summariser is told to stop too, and nothing is waited for.
    if (outer !== undefined) { onOuter = () => { controller.abort(); resolve({ ok: false, timeout: false, aborted: true }); }; if (outer.aborted) onOuter(); else outer.addEventListener("abort", onOuter, { once: true }); }
  });
  try {
    return await Promise.race([run(controller.signal).then((value): Within<T> => ({ ok: true, value })), clock]);
  } catch (error) {
    return { ok: false, timeout: false, error };
  } finally { clearTimeout(timer); if (onOuter !== undefined) outer?.removeEventListener("abort", onOuter); }
}

/**
 * Summarises with a chain of routes, each under its own short timeout, then (unless switched off) the extractive fallback. A hung or failing route moves to the next; if nothing produces a summary that
 * is within the limit and smaller than the text, the result is `overflow` (the attempt ends as `context_overflow`) instead of waiting. Never waits longer than `timeoutMs` per route. If `options.signal` aborts
 * (the caller gave up), every summariser is told to stop and the result is `aborted`: nothing is produced. Timers are real ones (not the services' injected clock), so tests use short real timeouts.
 */
export async function boundedSummarise(text: string, routes: readonly Summariser[], limits: Partial<SummariseLimits> = {}, options: { pinned?: readonly string[]; extractive?: boolean; signal?: AbortSignal } = {}): Promise<Summarised> {
  const l = { ...SUMMARY_DEFAULTS, ...limits };
  for (const [k, v] of Object.entries(l)) if (typeof v !== "number" || !(v > 0)) throw new RangeError(`${k} must be a positive number`);
  const attempts: SummariseAttempt[] = [];
  const started = Date.now();
  const target = Math.min(l.maxChars, Math.floor(text.length * l.maxShare));
  const usable = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0 && s.length <= target;
  if (target < 1) return { kind: "overflow", reason: "there is nothing to reduce: the text to summarise is too short for a summary to be smaller", attempts };
  for (const route of routes) {
    const remaining = l.totalMs - (Date.now() - started);
    if (remaining <= 0) break;
    const t0 = Date.now();
    const r = await within(Math.min(l.timeoutMs, remaining), (signal) => route.summarise({ text, maxChars: target, signal }), options.signal);
    const ms = Date.now() - t0;
    if (!r.ok && r.aborted === true) return { kind: "aborted", attempts };
    if (r.ok && usable(r.value)) { attempts.push({ route: route.route, outcome: "ok", ms }); return { kind: "summary", summary: redactText(r.value), route: route.route, degraded: attempts.length > 1, attempts }; }
    if (r.ok) attempts.push({ route: route.route, outcome: "unusable", ms, note: typeof r.value !== "string" || r.value.trim() === "" ? "empty summary" : `summary of ${r.value.length} characters is over the ${target} allowed` });
    else attempts.push({ route: route.route, outcome: r.timeout ? "timeout" : "error", ms, ...(r.timeout ? {} : { note: redactText(r.error instanceof Error ? r.error.message : String(r.error)).slice(0, 200) }) });
  }
  if (options.extractive !== false) {
    const summary = extractiveSummary(text, target, options.pinned ?? []);
    if (usable(summary) && summary.length < text.length) { attempts.push({ route: EXTRACTIVE_ROUTE, outcome: "ok", ms: 0 }); return { kind: "summary", summary, route: EXTRACTIVE_ROUTE, degraded: true, attempts }; }
    attempts.push({ route: EXTRACTIVE_ROUTE, outcome: "unusable", ms: 0, note: "did not reduce the text" });
  }
  return { kind: "overflow", reason: `no summariser produced a summary within ${l.timeoutMs} ms and ${target} characters (${attempts.map((a) => `${a.route}: ${a.outcome}`).join(", ") || "none configured"}); context_overflow`, attempts };
}
