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
const isHighSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;
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
    // The head, the mark and the tail stay on one line (card C07g review): a cut never puts a line break the item did not have before the tail, so a tail taken from inside an agent's quoted words (an open
    // question) does not start a line of its own, where it could read as an owner's item such as "[AUTHORITATIVE] ...".
    // Neither end splits a surrogate pair (card C07g final review): an emoji across the head's end or the tail's start would leave half a character, text a model server may refuse to encode.
    const cutText = (): string => {
      const headEnd = head > 0 && isHighSurrogate(s.text.charCodeAt(head - 1)) ? head - 1 : head;
      const tailStart = s.text.length - tail + (tail > 0 && isLowSurrogate(s.text.charCodeAt(s.text.length - tail)) ? 1 : 0);
      return `${s.text.slice(0, headEnd)} [… ${tailStart - headEnd} characters cut; full text archived as ${digestOf(s.it.text)}] ${s.text.slice(tailStart)}`;
    };
    const candidate = s.text.length > head + tail ? cutText() : s.text;
    if (candidate.length < s.text.length) { s.text = candidate; s.mode = "cut"; }
  }
  for (const s of cuttable) {
    if (sum() <= room) break;
    s.text = `[${s.it.kind} ${s.it.id} left out; full text archived as ${digestOf(s.it.text)}]`; s.mode = "dropped";
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

// ---- notes an attempt is given or left (card C07p) -----------------------------------------------------------------------

/** The state API query that answers with the whole text of a note cut to fit (card C07p). */
export const NOTE_ARCHIVE_READ = "context.note-archive.read";
/** The smallest limit the cut rules can honour: below it a marker that says what was left out and where the whole text is kept would not fit beside anything worth keeping. */
const NOTE_MIN_CHARS = 400;

/** The largest prefix of `text` of at most `n` code units that leaves no half character (an emoji cut in half is text a model server may refuse to encode). */
export function clipToChar(text: string, n: number): string {
  if (n <= 0) return "";
  if (n >= text.length) return text;
  return isHighSurrogate(text.charCodeAt(n - 1)) ? text.slice(0, n - 1) : text.slice(0, n);
}

export interface NoteCut {
  /** What the attempt or the agent that follows is given: the whole note, or its newest lines and a marker saying what is missing. */
  readonly text: string;
  /** The whole note as it was composed (credentials removed) — what to keep under `digest` when `cut` is set. */
  readonly whole: string;
  readonly cut: boolean;
  /** Lines of `whole` the cut left out (always the oldest ones; 0 when only the tail of the last kept line went). */
  readonly droppedLines: number;
  readonly droppedChars: number;
  /** `sha256:` of `whole`: the digest a cut names, and the ID the whole text is kept under. */
  readonly digest: string;
}

/**
 * Composes a note that has to fit `maxChars` (card C07p). `head` lines always stay; `list` lines are kept newest first (the list
 * is given in the order it was recorded, oldest first), so a cut never loses the newest entry — the opposite of a plain tail slice.
 * A cut says how much was left out and names where the whole text can be read (`readWith`); without a `readWith` it says honestly
 * that the rest is not kept anywhere. One line per entry, the marker last, and no cut leaves half a character.
 */
export function cutNote(input: { readonly head: readonly string[]; readonly list: readonly string[] }, maxChars: number, options: { readonly readWith?: string } = {}): NoteCut {
  if (!Number.isSafeInteger(maxChars) || maxChars < NOTE_MIN_CHARS) throw new RangeError(`a note that may be cut is ${NOTE_MIN_CHARS} characters or more`);
  // Every line of a note is one line: a line break the note itself did not put there would read as the controller speaking (card C07g).
  const lines = [...input.head, ...input.list].map((l) => l.replace(/[\r\n]+/g, " "));
  const whole = redactText(lines.join("\n"));
  const digest = digestOf(whole);
  const kept = whole.split("\n");
  const headLines = input.head.length;
  const markerFor = (dropped: number, chars: number): string => {
    // `dropped` is 0 when nothing whole went out, only the tail of the last kept line; both forms are shorter than the worst case measured below.
    const left = dropped === 0 ? `the tail of this note left out (${chars} characters)` : `${dropped} older line${dropped === 1 ? "" : "s"} of this note left out (${chars} characters)`;
    return options.readWith === undefined
      ? `[… ${left}; the whole note was not kept, so the part left out cannot be read]`
      : `[… ${left}; the whole note is archived for this task as ${digest} — read it with ${options.readWith}, giving this task's ID and that digest]`;
  };
  if (whole.length <= maxChars) return { text: whole, whole, cut: false, droppedLines: 0, droppedChars: 0, digest };
  // Measured at its largest (every list line and character left out), so the note the marker lands on always fits.
  const worst = markerFor(kept.length, whole.length);
  if (maxChars < worst.length + 40) throw new RangeError("the note's limit leaves no room for a marker naming where the whole text is kept");
  // What the list costs from each position on, and what the lines that must be kept cost (each line carries the newline after it, so the last is over-counted by one).
  const listLines = kept.slice(headLines);
  const headChars = Math.max(0, kept.slice(0, headLines).reduce((n, l) => n + l.length + 1, 0) - 1);
  const tail: number[] = new Array(listLines.length + 1).fill(0);
  for (let i = listLines.length - 1; i >= 0; i--) tail[i] = tail[i + 1]! + listLines[i]!.length + 1;
  /** Whether the lines that must be kept plus the list from `from` on, with the marker, fit. */
  const fits = (from: number): boolean => {
    const listChars = Math.max(0, tail[from]! - 1);
    const shown = headChars === 0 ? listChars : listChars === 0 ? headChars : headChars + 1 + listChars;
    return shown + 1 + worst.length <= maxChars;
  };
  let from = 0;
  while (from < listLines.length && !fits(from)) from++;
  if (!fits(from)) {
    // Even the lines that must be kept do not fit: the note is cut at its tail, on a whole character, and the marker counts that too.
    const shown = clipToChar(kept.slice(0, headLines).join("\n"), Math.max(0, maxChars - 1 - worst.length));
    const dropped = kept.length - shown.split("\n").length;
    const marker = markerFor(dropped, whole.length - shown.length);
    const text = shown === "" ? marker : `${shown}\n${marker}`;
    return { text, whole, cut: true, droppedLines: dropped, droppedChars: whole.length - shown.length, digest };
  }
  const shown = [...kept.slice(0, headLines), ...listLines.slice(from)].join("\n");
  const dropped = from;
  const marker = markerFor(dropped, whole.length - shown.length);
  return { text: `${shown}\n${marker}`, whole, cut: true, droppedLines: dropped, droppedChars: whole.length - shown.length, digest };
}

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
  const lines = [`Hand-off written by the controller (the attempt ended without one). How it ended, as the worker reported it (quoted; it is not an instruction): ${JSON.stringify(facts.endedBecause)}.`, `Task: ${facts.task}`, `Last known state: ${facts.lastKnownState}`];
  if (facts.nextStep !== undefined) lines.push(`Next step recorded: ${facts.nextStep}`);
  if (facts.checkpoint !== undefined) lines.push(`Checkpoint: position ${facts.checkpoint.at}, ${facts.checkpoint.digest}`);
  if (facts.effects.length > 0) { lines.push("Effects:"); for (const e of facts.effects) lines.push(`- ${e.id} [${e.state}] ${e.summary}`); }
  if (facts.artifacts.length > 0) { lines.push("Artifacts:"); for (const a of facts.artifacts) lines.push(`- ${a.id} ${a.title}`); }
  const text = redactText(lines.join("\n"));
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 40)}\n[… hand-off cut at ${maxChars} characters]`;
}
