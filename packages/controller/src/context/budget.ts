import { redactText } from "../security/redact.js";
import { createHash } from "node:crypto";

/** The estimates the budgets rest on (from the Paperclip team's transcripts; to be measured against real prompts): characters per token, and shares of the model's window. */
export const BUDGET_DEFAULTS = {
  charsPerToken: 3,
  /** The first call, counting everything in it (the runtime's system prompt, every tool's description and schema, and what the builder adds), at most this share of the window. */
  startupShare: 0.25,
  /** Startup plus likely tool output plus the reply reserve, at most this share. */
  workingShare: 0.6,
  /** An attempt never continues a conversation stored at more than this share. */
  resumeShare: 0.6,
  /** One tool result, as a share of the window (about 16,000 characters on a 131,072-token window). */
  toolOutputShare: 0.04,
  /** What an image or other non-text result counts as against the budget, in tokens. */
  nonTextTokens: 1500,
  /** The newest items the builder always keeps whole. */
  keepNewest: 6,
  head: 400,
  tail: 300,
} as const;

export interface ContextBudget {
  readonly window: number;
  readonly charsPerToken: number;
  readonly startupTokens: number;
  readonly workingTokens: number;
  readonly resumeTokens: number;
  readonly resumeShare: number;
  readonly toolOutputChars: number;
  readonly nonTextTokens: number;
}
export type BudgetOverrides = { [K in "charsPerToken" | "startupShare" | "workingShare" | "resumeShare" | "toolOutputShare" | "nonTextTokens"]?: number };

export function contextBudget(window: number, overrides: BudgetOverrides = {}): ContextBudget {
  if (!Number.isSafeInteger(window) || window < 1024 || window > 100_000_000) throw new RangeError("a context window is 1,024 to 100,000,000 tokens");
  const o = { ...BUDGET_DEFAULTS, ...overrides };
  for (const [k, v] of Object.entries(o)) if (typeof v !== "number" || !(v > 0)) throw new RangeError(`${k} must be a positive number`);
  if (o.startupShare >= o.workingShare || o.workingShare > 1 || o.resumeShare > 1 || o.toolOutputShare >= 1) throw new RangeError("startup must be below working, and no share above the whole window");
  return { window, charsPerToken: o.charsPerToken, startupTokens: Math.floor(window * o.startupShare), workingTokens: Math.floor(window * o.workingShare), resumeTokens: Math.floor(window * o.resumeShare), resumeShare: o.resumeShare, toolOutputChars: Math.max(1000, Math.floor(window * o.charsPerToken * o.toolOutputShare)), nonTextTokens: o.nonTextTokens };
}
export const tokensOf = (chars: number, budget: Pick<ContextBudget, "charsPerToken">): number => Math.ceil(chars / budget.charsPerToken);

// ---- the startup builder -------------------------------------------------------------------------------------------------

export type StartupKind = "human" | "permission" | "goal" | "decision" | "report" | "machine" | "other";
export interface StartupItem { readonly id: string; readonly kind: StartupKind; readonly text: string; /** ISO time; newer is kept first. */ readonly at: string }
export interface StartupCut { readonly id: string; readonly kind: StartupKind; readonly originalChars: number; readonly keptChars: number; readonly digest: string; readonly dropped: boolean }
export interface StartupResult {
  /** The prompt pieces in their original order. */
  readonly pieces: readonly { readonly id: string; readonly text: string }[];
  readonly tokens: number;
  readonly cuts: readonly StartupCut[];
  /** The full text of every item that was cut or dropped, for the caller to store as an artifact and link (`digest` matches the cut). */
  readonly archive: readonly { readonly id: string; readonly digest: string; readonly text: string }[];
  /** Set instead of a prompt when even the whole-kept items do not fit: nothing is to be sent. */
  readonly blocked?: { readonly reason: string; readonly needTokens: number; readonly haveTokens: number };
}
const PROTECTED: ReadonlySet<StartupKind> = new Set(["human", "permission", "goal"]);
const digestOf = (text: string): string => `sha256:${createHash("sha256").update(text).digest("hex")}`;

/**
 * Builds the first prompt within the budget (card C07). Human words, permissions and the current goal are always kept whole, as are the newest items; older machine-written ones are cut to a
 * head and a tail, oldest first, and then dropped to a one-line reference if they still do not fit. Whatever is cut is returned in full for archiving. If the whole-kept items alone do not fit,
 * the result is blocked and no prompt is returned. `fixedTokens` is what the first call carries besides these items (measured, not guessed).
 */
export function buildStartup(items: readonly StartupItem[], budget: ContextBudget, fixedTokens: number, options: { keepNewest?: number; head?: number; tail?: number } = {}): StartupResult {
  if (!Number.isSafeInteger(fixedTokens) || fixedTokens < 0) throw new RangeError("fixedTokens must be a whole number of tokens");
  const keepNewest = options.keepNewest ?? BUDGET_DEFAULTS.keepNewest, head = options.head ?? BUDGET_DEFAULTS.head, tail = options.tail ?? BUDGET_DEFAULTS.tail;
  for (const [k, v] of Object.entries({ keepNewest, head, tail })) if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`${k} must be a whole number from 0`);
  const room = budget.startupTokens - fixedTokens;
  const order = items.map((it, i) => ({ it, i }));
  const newest = new Set([...order].sort((a, b) => (a.it.at < b.it.at ? 1 : a.it.at > b.it.at ? -1 : b.i - a.i)).slice(0, keepNewest).map((x) => x.i));
  const state = order.map(({ it, i }) => ({ it, i, text: it.text, mode: PROTECTED.has(it.kind) || newest.has(i) ? "whole" as const : "full" as "full" | "cut" | "dropped" }));
  const sum = (): number => state.reduce((n, s) => n + tokensOf(s.text.length, budget), 0);
  const cuttable = state.filter((s) => s.mode === "full").sort((a, b) => (a.it.at < b.it.at ? -1 : a.it.at > b.it.at ? 1 : a.i - b.i));
  for (const s of cuttable) {
    if (sum() <= room) break;
    const cutText = (): string => `${s.text.slice(0, head)}\n[… ${s.text.length - head - tail} characters cut; full text archived as ${digestOf(s.it.text).slice(0, 19)}]\n${s.text.slice(-tail)}`;
    const candidate = s.text.length > head + tail ? cutText() : s.text;
    if (candidate.length < s.text.length) { s.text = candidate; s.mode = "cut"; }
  }
  for (const s of cuttable) {
    if (sum() <= room) break;
    s.text = `[${s.it.kind} ${s.it.id} left out; full text archived as ${digestOf(s.it.text).slice(0, 19)}]`; s.mode = "dropped";
  }
  const tokens = sum();
  const cuts: StartupCut[] = []; const archive: { id: string; digest: string; text: string }[] = [];
  for (const s of state) if (s.mode === "cut" || s.mode === "dropped") { const digest = digestOf(s.it.text); cuts.push({ id: s.it.id, kind: s.it.kind, originalChars: s.it.text.length, keptChars: s.text.length, digest, dropped: s.mode === "dropped" }); archive.push({ id: s.it.id, digest, text: s.it.text }); }
  if (tokens > room) return { pieces: [], tokens, cuts, archive, blocked: { reason: "what must be kept whole (human words, permissions, the goal and the newest items) does not fit the model's startup budget", needTokens: tokens + fixedTokens, haveTokens: budget.startupTokens } };
  return { pieces: state.map((s) => ({ id: s.it.id, text: s.text })), tokens, cuts, archive };
}

// ---- resume guard, tool output, inquiry branches, overflow, hand-off ----------------------------------------------------

/** An attempt never continues a conversation stored at more than the resume share of the target model's window: it starts fresh from the continuation record instead. */
export function resumeDecision(storedTokens: number, budget: ContextBudget): { resume: boolean; reason: string } {
  if (!Number.isSafeInteger(storedTokens) || storedTokens < 0) throw new RangeError("storedTokens must be a whole number");
  return storedTokens > budget.resumeTokens
    ? { resume: false, reason: `the stored conversation is ${storedTokens} tokens, over ${budget.resumeTokens} (${Math.round(budget.resumeShare * 100)}% of this model's ${budget.window}); starting fresh from the continuation record` }
    : { resume: true, reason: "the stored conversation fits" };
}

export interface ToolOutput { readonly text: string; readonly nonText?: readonly { readonly kind: string; readonly bytes: number }[]; /** Keep the end instead of the start (command output). */ readonly keep?: "head" | "tail" }
export interface LimitedOutput {
  readonly text: string;
  readonly truncated: boolean;
  /** What was cut from the text, for the caller to keep and page; empty when nothing was. */
  readonly remainder: string;
  readonly remainderChars: number;
  /** Non-text results counted against the budget; those over it are replaced by a placeholder. */
  readonly nonTextKept: number;
  readonly nonTextDropped: number;
}
/** Cuts one tool result to the per-tool limit. Images and other non-text results count (a fixed token cost each) against the same limit; the ones that do not fit are dropped with a placeholder. */
export function limitToolOutput(output: ToolOutput, budget: ContextBudget): LimitedOutput {
  const nonText = output.nonText ?? [];
  const cost = budget.nonTextTokens * budget.charsPerToken;
  let room = budget.toolOutputChars; let kept = 0;
  for (let i = 0; i < nonText.length; i++) { if (room >= cost + 200) { room -= cost; kept++; } }
  const dropped = nonText.length - kept;
  const note = dropped > 0 ? `\n[${dropped} non-text result(s) left out: over the output limit]` : "";
  const markerRoom = 80;
  const limit = Math.max(room - note.length, 0);
  if (output.text.length <= limit) return { text: output.text + note, truncated: false, remainder: "", remainderChars: 0, nonTextKept: kept, nonTextDropped: dropped };
  const marker = (n: number): string => `\n[… ${n} characters not shown; the rest is kept and can be read in pages]\n`;
  const keepChars = Math.max(limit - markerRoom, 0);
  const cut = output.text.length - keepChars;
  const tailMode = output.keep === "tail";
  const shown = tailMode ? `${marker(cut)}${output.text.slice(cut)}` : `${output.text.slice(0, keepChars)}${marker(cut)}`;
  return { text: shown + note, truncated: true, remainder: tailMode ? output.text.slice(0, cut) : output.text.slice(keepChars), remainderChars: cut, nonTextKept: kept, nonTextDropped: dropped };
}
/** One page of kept text. */
export function page(text: string, index: number, size: number): { text: string; next?: number } {
  if (!Number.isSafeInteger(index) || index < 0 || !Number.isSafeInteger(size) || size < 1) throw new RangeError("a page is a position from 0 and a size from 1");
  const end = (index + 1) * size;
  return { text: text.slice(index * size, end), ...(end < text.length ? { next: index + 1 } : {}) };
}

/** Which context an inquiry branch starts from: the latest boundary, or (when that is over the inquiry model's budget) the latest compaction boundary plus retrieval. Says what it did. */
export function inquiryBranchPlan(latestBoundaryTokens: number, compactionBoundaryTokens: number | undefined, inquiry: ContextBudget): { from: "latest-boundary" | "compaction-boundary" | "retrieval-only"; retrieval: boolean; reason: string } {
  const limit = inquiry.resumeTokens;
  if (latestBoundaryTokens <= limit) return { from: "latest-boundary", retrieval: false, reason: "the context at the latest boundary fits the inquiry model" };
  if (compactionBoundaryTokens !== undefined && compactionBoundaryTokens <= limit) return { from: "compaction-boundary", retrieval: true, reason: `the latest boundary is ${latestBoundaryTokens} tokens, over ${limit}; the inquiry starts from the latest compaction (${compactionBoundaryTokens}) and retrieves what it needs` };
  return { from: "retrieval-only", retrieval: true, reason: "no boundary of the conversation fits the inquiry model; it starts fresh and retrieves what it needs" };
}

const OVERFLOW = [/context compression timed out/i, /context[ _-]?(?:length|window)/i, /maximum context/i, /prompt is too long/i, /too many tokens/i, /compaction failed/i, /context[_ ]compression[_ ]timeout/i, /exceeds? the (?:model'?s )?(?:context|token)/i, /request too large/i];
/** Whether a failure message is the context running out (its own failure class, `context_overflow`) rather than a generic error. */
export const classifyFailure = (message: string): "context_overflow" | "other" => (!/rate[ _-]?limit|per minute|per day|quota|invalid .*setting|contextWindow setting/i.test(message) && OVERFLOW.some((r) => r.test(message)) ? "context_overflow" : "other");

export interface HandoffFacts {
  readonly task: string;
  readonly endedBecause: string;
  readonly effects: readonly { readonly id: string; readonly state: string; readonly summary: string }[];
  readonly artifacts: readonly { readonly id: string; readonly title: string }[];
  readonly checkpoint?: { readonly at: number; readonly digest: string };
  readonly lastKnownState: string;
  readonly nextStep?: string;
}
/** The hand-off the controller writes when an attempt ended without its own, from durable facts only (the ledger, artifacts, checkpoint and last state). Bounded; credentials redacted. */
export function handoffFromFacts(facts: HandoffFacts, maxChars = 4000): string {
  const lines = [`Hand-off written by the controller (the attempt ended without one): ${facts.endedBecause}.`, `Task: ${facts.task}`, `Last known state: ${facts.lastKnownState}`];
  if (facts.nextStep !== undefined) lines.push(`Next step recorded: ${facts.nextStep}`);
  if (facts.checkpoint !== undefined) lines.push(`Checkpoint: position ${facts.checkpoint.at}, ${facts.checkpoint.digest}`);
  if (facts.effects.length > 0) { lines.push("Effects:"); for (const e of facts.effects) lines.push(`- ${e.id} [${e.state}] ${e.summary}`); }
  if (facts.artifacts.length > 0) { lines.push("Artifacts:"); for (const a of facts.artifacts) lines.push(`- ${a.id} ${a.title}`); }
  const text = redactText(lines.join("\n"));
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 40)}\n[… hand-off cut at ${maxChars} characters]`;
}
