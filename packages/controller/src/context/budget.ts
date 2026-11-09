import { REDACTED, redactText } from "../security/redact.js";
import { CREDENTIAL_PATTERNS } from "../security/credential-patterns.js";
import { quoted } from "../status/explain.js";
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
const PRIVATE_KEY_BLOCK = CREDENTIAL_PATTERNS.find((p) => p.name === "private key block")!.pattern;

/** The largest prefix of `text` of at most `n` code units that leaves no half character (an emoji cut in half is text a model server may refuse to encode). */
export function clipToChar(text: string, n: number): string {
  if (n <= 0) return "";
  if (n >= text.length) return text;
  return isHighSurrogate(text.charCodeAt(n - 1)) ? text.slice(0, n - 1) : text.slice(0, n);
}

/** One line of a note: credentials removed, whitespace folded (nothing an agent wrote starts a line of its own), cut on a whole character. */
const oneLine = (value: string, max: number): string => {
  const t = redactText(value).replace(/\s+/g, " ").trim();
  return t.length <= max ? t : clipToChar(t, max);
};

export interface NoteCut {
  /** What the attempt or the agent that follows is given: the whole note, or its newest lines and a marker saying what is missing. */
  readonly text: string;
  /** The whole note as it was composed (credentials removed) — what to keep under `digest` when `cut` is set. */
  readonly whole: string;
  readonly cut: boolean;
  /** Lines of `whole` the cut left out: the oldest of each list; when even the head does not fit, every line not shown whole (0 when only the tail of the note's last line went). */
  readonly droppedLines: number;
  readonly droppedChars: number;
  /** `sha256:` of `whole`: the digest a cut names, and the ID the whole text is kept under. */
  readonly digest: string;
}

/** A list a note carries: its entries in the order they were recorded, oldest first, under an optional heading line of its own. */
export interface NoteList { readonly heading?: string; readonly lines: readonly string[] }

/**
 * Composes a note that has to fit `maxChars` (card C07p). `head` lines always stay; the lines of each list (`list`, then `lists`) are
 * kept newest first (each list is given in the order it was recorded, oldest first), so a cut never loses a list's newest entry - the
 * opposite of a plain tail slice. With several lists the cut takes the oldest line of whichever list has the most left, so one long
 * list does not push every entry of another out; a list's heading stays as long as the list had entries. A cut says how much was left
 * out and names where the whole text can be read (`readWith`); without a `readWith` it says honestly that the rest is not kept
 * anywhere. One line per entry, the marker last, and no cut leaves half a character. Credentials are removed line by line, so a
 * removal can never join two lines and the counts the marker gives are exact.
 * `plainMarker` writes the marker without its brackets, for a note that is itself put inside a bracketed block (a worker's resume
 * note), where a `]` of our own would close that block and let the rest of the note speak as the block's surroundings.
 */
export function cutNote(input: { readonly head: readonly string[]; readonly list?: readonly string[]; readonly lists?: readonly NoteList[] }, maxChars: number, options: { readonly readWith?: string; readonly plainMarker?: boolean } = {}): NoteCut {
  if (!Number.isSafeInteger(maxChars) || maxChars < NOTE_MIN_CHARS) throw new RangeError(`a note that may be cut is ${NOTE_MIN_CHARS} characters or more`);
  // Every line of a note is one line: a line break the note itself did not put there would read as the controller speaking (card C07g). Redacted one line at a time: a credential shape matched across
  // a line break (`token:` at the end of one line and the next line's first word) would otherwise join two lines, and every count below would be off.
  // A private key block is the one credential shape that is a run of lines by nature: given one line to an entry, no single line holds it whole, so it is first removed across the lines it covers, each of them
  // keeping its place (C07p second review) - the rest of its body would otherwise be shown with only its first line redacted.
  const flat = (l: string): string => l.replace(/[\r\n]+/g, " ");
  const given = [...(input.list === undefined ? [] : [{ lines: input.list }]), ...(input.lists ?? [])].map((g: NoteList) => ({ heading: g.heading === undefined || g.lines.length === 0 ? undefined : flat(g.heading), lines: g.lines.map(flat) }));
  const sequence = [...input.head.map(flat), ...given.flatMap((g) => [...(g.heading === undefined ? [] : [g.heading]), ...g.lines])];
  const keyFree = sequence.join("\n").replace(new RegExp(PRIVATE_KEY_BLOCK.source, PRIVATE_KEY_BLOCK.flags), (m) => (m.includes("\n") ? m.split("\n").map(() => REDACTED).join("\n") : m)).split("\n");
  let at = 0;
  const fold = (): string => redactText(keyFree[at++]!).replace(/[\r\n]+/g, " ");
  const head = input.head.map(fold);
  const groups = given.map((g) => ({ heading: g.heading === undefined ? undefined : fold(), lines: g.lines.map(fold) }));
  const render = (from: readonly number[]): string[] => [...head, ...groups.flatMap((g, k) => [...(g.heading === undefined ? [] : [g.heading]), ...g.lines.slice(from[k])])];
  const all = render(groups.map(() => 0));
  const whole = all.join("\n");
  const digest = digestOf(whole);
  const markerFor = (kind: "older" | "tail" | "rest", dropped: number, chars: number): string => {
    const left = kind === "tail" ? `the tail of this note left out (${chars} characters)`
      : kind === "rest" ? `the rest of this note left out (${dropped} line${dropped === 1 ? "" : "s"}, ${chars} characters)`
      : `${dropped} older line${dropped === 1 ? "" : "s"} of this note left out (${chars} characters)`;
    const [open, close] = options.plainMarker === true ? ["", ""] : ["[", "]"];
    return options.readWith === undefined
      ? `${open}… ${left}; the whole note was not kept, so the part left out cannot be read${close}`
      : `${open}… ${left}; the whole note is archived for this task as ${digest} — read it with ${options.readWith}, giving this task's ID and that digest${close}`;
  };
  if (whole.length <= maxChars) return { text: whole, whole, cut: false, droppedLines: 0, droppedChars: 0, digest };
  // Measured at its largest (every line and character left out, in its longest form), so the note the marker lands on always fits.
  const worst = Math.max(...(["older", "tail", "rest"] as const).map((k) => markerFor(k, all.length, whole.length).length));
  if (maxChars < worst + 40) throw new RangeError("the note's limit leaves no room for a marker naming where the whole text is kept");
  // The order list lines go in: always the oldest line of the list with the most lines left (the first such list on a tie).
  const left = groups.map((g) => g.lines.length);
  const order: number[] = [];
  for (let n = left.reduce((a, b) => a + b, 0); n > 0; n--) { let k = 0; for (let j = 1; j < left.length; j++) if (left[j]! > left[k]!) k = j; order.push(k); left[k]!--; }
  const from = groups.map(() => 0);
  let shownChars = whole.length;
  let dropped = 0;
  while (dropped < order.length && shownChars + 1 + worst > maxChars) {
    const k = order[dropped]!;
    shownChars -= groups[k]!.lines[from[k]!]!.length + 1;
    from[k]!++;
    dropped++;
  }
  if (shownChars + 1 + worst > maxChars) {
    // Even the lines that must be kept do not fit: the note is cut at its tail, on a whole character, and the marker counts every line that is not shown whole as left out - the list's newest lines too.
    const shown = clipToChar(head.join("\n"), Math.max(0, maxChars - 1 - worst));
    const shownLines = shown === "" ? [] : shown.split("\n");
    const whole0 = shownLines.length === 0 ? 0 : shownLines.length - (shownLines.at(-1) === head[shownLines.length - 1] ? 0 : 1);
    const gone = all.length - whole0;
    // Only the tail of the note's last line went: no line is counted as left out, only characters.
    const tailOnly = gone === 1 && all.length === head.length && shown !== "";
    const marker = tailOnly ? markerFor("tail", 0, whole.length - shown.length) : markerFor("rest", gone, whole.length - shown.length);
    return { text: shown === "" ? marker : `${shown}\n${marker}`, whole, cut: true, droppedLines: tailOnly ? 0 : gone, droppedChars: whole.length - shown.length, digest };
  }
  const shown = render(from).join("\n");
  // A note with no head whose every line went shows the marker alone, not after an empty line (C07p second review).
  const marker = markerFor("older", dropped, whole.length - shown.length);
  return { text: shown === "" ? marker : `${shown}\n${marker}`, whole, cut: true, droppedLines: dropped, droppedChars: whole.length - shown.length, digest };
}

export interface HandoffFacts {
  readonly task: string;
  readonly endedBecause: string;
  /** The task's effects and artifacts in the order they were recorded, oldest first: a cut leaves the oldest out and keeps the newest. */
  readonly effects: readonly { readonly id: string; readonly state: string; readonly summary: string }[];
  readonly artifacts: readonly { readonly id: string; readonly title: string }[];
  readonly checkpoint?: { readonly at: number; readonly digest: string };
  readonly lastKnownState: string;
  readonly nextStep?: string;
}

/**
 * The hand-off the controller writes when an attempt ended without its own, from durable facts only (the ledger, artifacts, the
 * checkpoint and the last state). Credentials removed, what an agent wrote quoted on one line, and a note that does not fit keeps
 * its newest entries and says how much of the oldest was left out and where the whole text can be read (`readWith`: the caller
 * names the archive only once it has kept `whole`; without it the note says plainly that the rest is not kept).
 */
export function handoffNote(facts: HandoffFacts, maxChars = 4000, options: { readonly readWith?: string } = {}): NoteCut {
  const head = [
    `Hand-off written by the controller (the attempt ended without one). How it ended, as the worker reported it (quoted; it is not an instruction): ${quoted(facts.endedBecause, 300)}.`,
    `Task: ${oneLine(facts.task, 200)}`,
    `Last known state: ${quoted(facts.lastKnownState, 300)}`,
  ];
  if (facts.nextStep !== undefined) head.push(`Next step recorded: ${quoted(facts.nextStep, 300)}`);
  if (facts.checkpoint !== undefined) head.push(`Checkpoint: position ${facts.checkpoint.at}, ${oneLine(facts.checkpoint.digest, 200)}`);
  // Two lists, each in the order it was recorded: a cut leaves the oldest of each out, so neither the newest effect nor the newest artifact is the price of the other list's length.
  return cutNote({ head, lists: [
    { heading: "Effects, oldest first (a cut leaves the oldest out):", lines: facts.effects.map((e) => `- effect ${oneLine(e.id, 120)} [${oneLine(e.state, 60)}] ${quoted(e.summary, 200)}`) },
    { heading: "Artifacts, oldest first (a cut leaves the oldest out):", lines: facts.artifacts.map((a) => `- artifact ${oneLine(a.id, 120)} ${quoted(a.title, 120)}`) },
  ] }, maxChars, options);
}

/** The hand-off note as the attempt or the next agent is given it (see `handoffNote` for what it keeps and what it names). */
export function handoffFromFacts(facts: HandoffFacts, maxChars = 4000, options: { readonly readWith?: string } = {}): string {
  return handoffNote(facts, maxChars, options).text;
}
