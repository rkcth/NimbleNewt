import { redactText } from "../security/redact.js";

/**
 * The pure rules of a facilitated meeting (card M05): how a prompt is built, what a member is shown of earlier statements, how replies are read, how a chair's question or excerpt is checked and how a turn's tokens are counted.
 * Nothing here reads storage, the clock or a model; the floor service (`floor.ts`) calls these and the tests call them directly.
 */

// ---- tokens --------------------------------------------------------------------------------------------------------------------------------

/** A rough count of tokens in text, for when the model route did not report one (four characters to a token, at least one for any text). */
export const estimateTokens = (text: string): number => (text.length === 0 ? 0 : Math.max(1, Math.ceil(text.length / 4)));

/** What a turn used, as the model route reported it. Visible tokens are the words the member said; hidden tokens are reasoning that is never shown. */
export interface TurnUsage {
  readonly visibleTokens: number;
  readonly hiddenTokens: number;
  readonly inputTokens?: number;
  readonly cachedTokens?: number;
}

export interface TurnAccount {
  readonly text: string;
  readonly visibleTokens: number;
  readonly hiddenTokens: number;
  /** The visible text went over the turn limit and was cut at a word. */
  readonly truncated: boolean;
  /** The hidden reasoning went over its own budget (recorded; the visible limit is unaffected). */
  readonly hiddenOver: boolean;
}

/**
 * Counts a turn against its limits (proposed change 6 of the M00 record). The LIMIT is on visible output tokens only: hidden reasoning is budgeted separately and never makes the visible text count as too long (a model that
 * spends 600 hidden tokens on a 150-token statement is within a 220-token limit). A statement over the limit is cut at a word to the limit, and says so.
 */
export function accountTurn(text: string, usage: TurnUsage | undefined, limits: { readonly visible: number; readonly hidden: number }): TurnAccount {
  const visible = usage?.visibleTokens ?? estimateTokens(text);
  const hidden = usage?.hiddenTokens ?? 0;
  if (visible <= limits.visible) return { text, visibleTokens: visible, hiddenTokens: hidden, truncated: false, hiddenOver: hidden > limits.hidden };
  // Cut by the same ratio the route reported (visible tokens per character), at a word boundary.
  const keep = Math.max(1, Math.floor(text.length * (limits.visible / visible)));
  const cut = text.slice(0, keep);
  const at = cut.lastIndexOf(" ");
  const clipped = (at > keep / 2 ? cut.slice(0, at) : cut).trimEnd();
  return { text: clipped, visibleTokens: limits.visible, hiddenTokens: hidden, truncated: true, hiddenOver: hidden > limits.hidden };
}

// ---- text kept in the record ---------------------------------------------------------------------------------------------------------------

// Control, bidirectional and zero-width characters model text could carry, built from a string so no literal separator sits in the source.
const STRIP = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2069\\ufeff]", "g");

/** Model or agent text as the record keeps it: no control or direction characters, no credential or key (redacted), blank runs collapsed, cut to `max` characters. Never throws. */
export function recordText(text: string, max = 3900): string {
  const clean = redactText(String(text ?? "").replace(STRIP, "")).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

// ---- prompts -------------------------------------------------------------------------------------------------------------------------------

export interface Prompt {
  /** The whole text the member's model sees. */
  readonly text: string;
  /** The part that is the same for every member asked at this step; with shared-first order `text` starts with exactly these characters. */
  readonly shared: string;
  /** The part specific to the member (its persona, its own desk notes, the instruction). */
  readonly specific: string;
  readonly order: "shared-first" | "agent-first";
}

export const PREAMBLE = [
  "You are a participant in a short, orderly team meeting. Only one person speaks at a time.",
  "Be concise and concrete. Use only what you actually know from your own background and notes;",
  "do not invent facts, numbers or experiences. Follow the requested output format exactly.",
].join(" ");

/**
 * One prompt. Shared-first (the default, proposed change 7): the preamble, the motion and the transcript come first and are byte-identical for every member asked at the same step, then the member's own part, so a hosted
 * prompt cache can reuse the prefix (the experiments measured 55 to 77 percent cached input against 21 to 31 percent in the ordinary order). Agent-first puts the member's part first.
 */
export function buildPrompt(input: { readonly order: "shared-first" | "agent-first"; readonly motion: { readonly version: number; readonly text: string } | undefined; readonly context?: string; readonly transcript: string; readonly persona: string; readonly extra?: string; readonly instruction: string }): Prompt {
  const motion = input.motion === undefined ? "(No motion has been moved yet.)" : `MOTION (version ${input.motion.version}): ${input.motion.text}`;
  const common = `${PREAMBLE}\n\n${motion}${input.context === undefined || input.context === "" ? "" : `\n\n${input.context}`}`;
  const shared = `${common}\n\nMEETING SO FAR:\n${input.transcript}\n\n`;
  const specific = `${input.persona}\n${input.extra === undefined || input.extra === "" ? "" : `${input.extra}\n`}${input.instruction}`;
  if (input.order === "agent-first") return { text: `${input.persona}\n\n${common}\n\nMEETING SO FAR:\n${input.transcript}\n\n${input.extra === undefined || input.extra === "" ? "" : `${input.extra}\n`}${input.instruction}`, shared, specific, order: "agent-first" };
  return { text: shared + specific, shared, specific, order: "shared-first" };
}

// ---- what a member is shown of earlier statements ------------------------------------------------------------------------------------------

export interface ShownEntry { readonly seq: number; readonly who: string; readonly label?: string; readonly text: string; readonly summary?: string }

/** Statements of at most this many words pass through whole in a facts-style transcript. */
export const SHORT_STATEMENT_WORDS = 70;
const wordCount = (text: string): number => (text.trim() === "" ? 0 : text.trim().split(/\s+/).length);

/** Whether a meeting of this many present members shows facts-style summaries (proposed change 3). */
export const usesFacts = (mode: "auto" | "full" | "facts", present: number, above: number): boolean => mode === "facts" || (mode === "auto" && present > above);

/**
 * The transcript a member is given. `full`: every entry whole. `facts`: a short statement passes through verbatim; a longer one is shown as its author's own facts-style summary when it wrote one (and whole when it did not), and says
 * so; the full text stays readable in the meeting record. Never reorders, drops or rewrites an entry.
 */
export function transcriptView(entries: readonly ShownEntry[], mode: "full" | "facts"): string {
  if (entries.length === 0) return "(Nothing has been said yet.)";
  return entries.map((e) => {
    const head = `[#${e.seq} ${e.who}${e.label === undefined ? "" : ` — ${e.label}`}]`;
    if (mode === "facts" && e.summary !== undefined && wordCount(e.text) > SHORT_STATEMENT_WORDS) return `${head} (summary; the full text is kept) ${e.summary}`;
    return `${head} ${e.text}`;
  }).join("\n");
}

// ---- reading replies -----------------------------------------------------------------------------------------------------------------------

const pick = (re: RegExp, text: string): string | undefined => re.exec(text)?.[1]?.trim();

export interface ParsedStatement { readonly stance: "for" | "against" | "undecided" | "unknown"; readonly text: string; readonly summary?: string; readonly ask?: { readonly to: string; readonly text: string }; readonly amend?: string }

/** `STANCE:` / `STATEMENT:` / `TLDR:` / `ASK:` / `AMEND:` as the instruction asks for them; a reply that follows none of them is the statement itself. */
export function parseStatement(reply: string): ParsedStatement {
  const stance = (pick(/STANCE:\s*(for|against|undecided)/i, reply) ?? "unknown").toLowerCase() as ParsedStatement["stance"];
  const text = pick(/STATEMENT:\s*([\s\S]*?)(?:\n\s*(?:TLDR|ASK|AMEND):|$)/i, reply) ?? reply.replace(/^\s*STANCE:.*$/im, "").trim();
  const tldr = pick(/TLDR:\s*([\s\S]*?)(?:\n\s*(?:ASK|AMEND):|$)/i, reply)?.replace(/\s+/g, " ");
  const askLine = pick(/^\s*ASK:\s*(.*)$/im, reply);
  const ask = askLine === undefined ? undefined : /^\s*(?:\|\s*)?([\w:-]+)\s*:\s*([\s\S]+)$/.exec(askLine);
  const amend = pick(/^\s*AMEND:\s*([\s\S]*?)(?:\n\s*(?:TLDR|ASK|STANCE):|$)/im, reply);
  return {
    stance, text,
    ...(tldr === undefined || /^none\.?$/i.test(tldr) ? {} : { summary: tldr }),
    ...(ask === null || ask === undefined || /^none/i.test(askLine ?? "") ? {} : { ask: { to: ask[1]!, text: ask[2]!.trim() } }),
    ...(amend === undefined || /^none\.?$/i.test(amend) ? {} : { amend }),
  };
}

export function parseVote(reply: string): { value: "yes" | "no" | "abstain" | undefined; reason: string } {
  const v = pick(/(?:VOTE|CASTING):\s*(yes|no|abstain)/i, reply)?.toLowerCase();
  return { value: v as "yes" | "no" | "abstain" | undefined, reason: pick(/REASON:\s*([\s\S]*)$/i, reply)?.replace(/\s+/g, " ") ?? "" };
}

export function parseObjection(reply: string, tabling: boolean): { answer: "no" | "yes" | "research" | undefined; reason: string } {
  const v = pick(/OBJECT:\s*(yes|no|research)/i, reply)?.toLowerCase() as "no" | "yes" | "research" | undefined;
  const answer = v === "research" && !tabling ? "yes" : v;
  return { answer, reason: pick(/REASON:\s*([\s\S]*)$/i, reply)?.replace(/\s+/g, " ") ?? "" };
}

/** The first JSON object in a reply (a model may wrap it in words or a fence); undefined when there is none that parses. */
export function parseJsonObject(reply: string): Record<string, unknown> | undefined {
  const at = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (at < 0 || end <= at) return undefined;
  try {
    const value: unknown = JSON.parse(reply.slice(at, end + 1));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

// ---- the chair's questions and quotes ------------------------------------------------------------------------------------------------------

/** The fields a chair's fact-finding question may have, and no others: a field for a position or a vote is refused. */
export const QUESTION_FIELDS: ReadonlySet<string> = new Set(["to", "topic", "experience_sought"]);

const POSITION_ASK = /\b(how (will|would|do) (you|they|she|he) vote|(do|would|will) you (support|oppose|back|favou?r)|are you (for|against|in favou?r)|your (vote|position|stance)|vote (yes|no)|for or against)\b/i;

export interface ChairQuestion { readonly to: string; readonly topic: string; readonly experience_sought: string }

/**
 * The structural check of a chair's question (proposed change 4): it is refused when it has any field beyond the three allowed (a position or vote field), when a field is missing, or when it asks how someone will vote or whether
 * they are for or against. Nothing else is judged by words: the word filter of the first design refused 8 of 157 legitimate questions on the word "support". Anything else is left to a member's challenge and the chair's ruling.
 */
export function chairQuestionRefusal(q: unknown): string | undefined {
  if (q === null || typeof q !== "object" || Array.isArray(q)) return "a question is an object with to, topic and experience_sought";
  const fields = q as Record<string, unknown>;
  const extra = Object.keys(fields).find((k) => !QUESTION_FIELDS.has(k));
  if (extra !== undefined) return `a question has no ${extra} field (only to, topic and experience_sought)`;
  for (const k of QUESTION_FIELDS) if (typeof fields[k] !== "string" || (fields[k] as string).trim() === "") return `${k} is missing`;
  if (POSITION_ASK.test(`${fields["topic"] as string} ${fields["experience_sought"] as string}`)) return "a question may not ask how anyone will vote or whether they are for or against";
  return undefined;
}

const norm = (t: string): string => t.toLowerCase().replace(/[^a-z0-9% ]+/g, " ").replace(/\s+/g, " ").trim();

/** Whether a quote really occurs in the text (case, punctuation and spacing aside) and is long enough to mean something. */
export function quoteOccurs(quote: unknown, text: string): boolean {
  if (typeof quote !== "string") return false;
  const q = norm(quote);
  return q.length >= 8 && norm(text).includes(q);
}

// ---- checkpoints ---------------------------------------------------------------------------------------------------------------------------

/**
 * A checkpoint answer as the controller wraps it (proposed change 12): stamped with the checkpoint's time and as not live, read-only and carrying no actions. The model's own words follow; the stamp is the controller's and
 * cannot be left out by the model.
 */
export function wrapCheckpointAnswer(agent: string, savedAt: string, answer: string): string {
  return `[From ${agent}'s checkpoint of ${savedAt}, not live: this answer comes from saved notes, may be out of date, is read-only and starts no action.] ${answer}`;
}
