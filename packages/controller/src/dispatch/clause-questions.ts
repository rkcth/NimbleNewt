// Card W09 third slice: a stricter second agent for a task whose contract has clauses (`acceptanceCriteria`).
//
// The W09 bench's false dones (12 of 12) each missed a contract clause the agent's own tests did not cover, and the second agent (the same model) took the report as supported, once after no question at all. For a task with
// clauses, the controller now holds a `supported` back until every clause is either shown tested in the report (a line that names the clause as `C<n>`, a test name in double, typographic or back quotes, and a passing
// run result) or was asked about in an answered question of this questioning (a question that names `C<n>` or holds the clause's own words). A clause neither shown nor asked is asked about by the controller itself, one
// question per clause, in the rounds that may still ask; once no round may ask, the report is unsupported. A task without clauses keeps the old behaviour. Everything is bounded: the clauses looked at, the lines of the
// report, the quotes per line and the text of every question.

import { quoted } from "../status/explain.js";
import { WORK_REPORT_LIMITS } from "./model.js";

export const CLAUSE_QUESTION_LIMITS = { clauses: 50, lines: 400, line: 1_000, quotesPerLine: 20, quote: 200, clauseShown: 120, match: 80, named: 12 } as const;

/** A clause named in a line or a question: `C<n>` not inside a word or a longer number (`AC1`, `C1x` and `C10` are not C1). */
const CLAUSE_NAME = /(?<![A-Za-z0-9_])[Cc](\d{1,3})(?![A-Za-z0-9_])/g;
/** Quoted text that can be a test name: straight double, typographic double or back quotes (single quotes are left out: an apostrophe cannot be told from a quote). Each style is read on its own; each body excludes its closing quote. */
const QUOTES: readonly RegExp[] = [/"([^"\r\n]{1,200})"/g, /\u201c([^\u201d\r\n]{1,200})\u201d/g, /`([^`\r\n]{1,200})`/g];
/** A passing run result outside the quotes: `ok`, `pass`, `passed`, `passes`, `passing` as whole words, or a check mark (node's spec reporter prints `✔`). */
const PASSING = /(?<![A-Za-z])(?:ok|pass(?:ed|es|ing)?)(?![A-Za-z])|[\u2713\u2714\u2705]/i;
/**
 * A failing one: `not ok`, a cross mark (`✖`, `✗`), or `fail` (failed, fails, failing, failure) with no count of 0 or negation next to it: `fail 0`, `failed: 0`, `0 failed`, `4 pass / 0 fail`, `no failures`, `none failed` and
 * `nothing failed` are not failures (first review: the common "3 passed, 0 failed" and "no failures" were read as failing and the clause asked about again).
 */
const FAILING = /(?<![A-Za-z])not[ \t]+ok(?![A-Za-z])|[\u2716\u2717\u2718\u274c]|(?<!(?:(?<![0-9.])0|(?<![A-Za-z])(?:no|zero|none|nothing))[ \t]{1,3})(?<![A-Za-z])fail(?:ed|s|ing|ures?)?(?![A-Za-z])(?![ \t]{0,3}[:=]?[ \t]{0,3}0(?![0-9]))/i;
/**
 * A file name outside the quotes (`src/fail-safe.test.ts`, `c2.test.mjs`, `lib\ok.js`): a word with a path separator or an extension. It is set aside before the result and the clause names are read, so a file named `fail-safe`
 * is not a failing result and `src/c2.test.ts` does not name C2 (first review). A word of clause names only (`C1/C2`) is kept.
 */
const FILE_NAME = /[A-Za-z0-9_.\\/-]*(?:[\\/][A-Za-z0-9_.\\/-]*|\.[A-Za-z][A-Za-z0-9]{0,7}(?![A-Za-z0-9]))/g;
const CLAUSES_ONLY = /^(?:[Cc]\d{1,3}[\\/-]?)+$/;

/** The words of a text as compared: lower case, white space folded, at most `match` characters. */
const words = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim().slice(0, CLAUSE_QUESTION_LIMITS.match);

/** The clause numbers (1-based) a line shows tested: it names them, outside quotes, and holds a quoted name and a passing result with no failing one. */
function testedOn(raw: string, count: number): number[] {
  const line = raw.length > CLAUSE_QUESTION_LIMITS.line ? raw.slice(0, CLAUSE_QUESTION_LIMITS.line) : raw;
  let rest = line;
  let names = 0;
  for (const style of QUOTES) {
    let taken = 0;
    rest = rest.replace(style, () => { if (taken >= CLAUSE_QUESTION_LIMITS.quotesPerLine) return " "; taken++; names++; return " "; });
  }
  rest = rest.replace(FILE_NAME, (w) => (CLAUSES_ONLY.test(w) ? w : " "));
  if (names === 0 || !PASSING.test(rest) || FAILING.test(rest)) return [];
  const out: number[] = [];
  for (const m of rest.matchAll(CLAUSE_NAME)) {
    const n = Number.parseInt(m[1]!, 10);
    if (n >= 1 && n <= count && !out.includes(n)) out.push(n);
    if (out.length >= CLAUSE_QUESTION_LIMITS.clauses) break;
  }
  return out;
}

/** The clauses (1-based) the report shows tested, each on a line of its own. */
export function shownTested(report: string, clauses: number): Set<number> {
  const count = Math.min(clauses, CLAUSE_QUESTION_LIMITS.clauses);
  const shown = new Set<number>();
  if (count === 0) return shown;
  for (const line of String(report).split(/\r\n|\n|\r/, CLAUSE_QUESTION_LIMITS.lines)) for (const n of testedOn(line, count)) shown.add(n);
  return shown;
}

/** The clauses (1-based) a question asks about: those it names as `C<n>` and those whose own words (their first `match` characters) it holds. */
export function askedIn(question: string, criteria: readonly string[]): number[] {
  const count = Math.min(criteria.length, CLAUSE_QUESTION_LIMITS.clauses);
  const q = String(question).slice(0, WORK_REPORT_LIMITS.question + 100);
  const out = new Set<number>();
  for (const m of q.matchAll(CLAUSE_NAME)) { const n = Number.parseInt(m[1]!, 10); if (n >= 1 && n <= count) out.add(n); }
  // The question whole (it is bounded above), the clause by its first words.
  const text = q.toLowerCase().replace(/\s+/g, " ");
  for (let i = 0; i < count; i++) { const c = words(criteria[i] ?? ""); if (c.length >= 4 && text.includes(c)) out.add(i + 1); }
  return [...out].sort((a, b) => a - b);
}

/** The clauses (1-based) neither shown tested in the report nor asked about in an answered question of the rounds so far, in the contract's order. */
export function clausesLeft(criteria: readonly string[], report: string, rounds: readonly { readonly questions: readonly string[]; readonly answers?: readonly string[] }[]): number[] {
  const count = Math.min(criteria.length, CLAUSE_QUESTION_LIMITS.clauses);
  if (count === 0) return [];
  const covered = shownTested(report, count);
  for (const r of rounds) r.questions.forEach((q, i) => { if (r.answers?.[i] !== undefined) for (const n of askedIn(q, criteria)) covered.add(n); });
  const left: number[] = [];
  for (let n = 1; n <= count; n++) if (!covered.has(n)) left.push(n);
  return left;
}

/** The controller's own question about clause `n` (1-based), within the bound of one question. */
export function clauseQuestion(n: number, criterion: string): string {
  const q = `C${n} ${quoted(criterion, CLAUSE_QUESTION_LIMITS.clauseShown)}: your report does not show this clause tested. Name its test (file, and the name in double quotes) and quote its run's result line.`;
  return q.length > WORK_REPORT_LIMITS.question ? `${q.slice(0, WORK_REPORT_LIMITS.question - 3)}...` : q;
}

/** The clause numbers as the owner and the agent read them (`C2, C5`), at most `named`, the rest counted. */
export function clauseNames(left: readonly number[]): string {
  const shown = left.slice(0, CLAUSE_QUESTION_LIMITS.named).map((n) => `C${n}`).join(", ");
  return left.length > CLAUSE_QUESTION_LIMITS.named ? `${shown} and ${left.length - CLAUSE_QUESTION_LIMITS.named} more` : shown;
}

type Answer = { readonly verdict: "supported"; readonly route: string } | { readonly verdict: "questions"; readonly questions: readonly string[]; readonly route: string } | { readonly verdict: "unsupported"; readonly reason: string; readonly questions: readonly string[]; readonly route: string };

/**
 * The second agent's answer after the clause rule. Unsupported stands. With no clause left, the answer stands. Otherwise, on a round that may still ask (`round <= maxRounds`): a `supported` becomes the controller's questions
 * about the clauses left (as many as a round holds), and a round of the second agent's own questions gets them added in the room it leaves. On a round that may not ask, a `supported` becomes unsupported, naming the clauses.
 */
export function withClauseRule(answer: Answer, input: { readonly criteria: readonly string[]; readonly report: string; readonly rounds: readonly { readonly questions: readonly string[]; readonly answers?: readonly string[] }[]; readonly round: number; readonly maxRounds: number }): Answer {
  // Unsupported stands, and so does anything that is not a verdict (the dispatcher reads that as unsupported).
  if (answer.verdict !== "supported" && answer.verdict !== "questions") return answer;
  const left = clausesLeft(input.criteria, input.report, input.rounds);
  if (left.length === 0) return answer;
  const own = answer.verdict === "questions" ? answer.questions.slice(0, WORK_REPORT_LIMITS.questions) : [];
  // The second agent's own questions may already ask about some of the clauses left.
  const asking = new Set(own.flatMap((q) => askedIn(q, input.criteria)));
  const ask = left.filter((n) => !asking.has(n));
  if (input.round <= input.maxRounds) {
    const added = ask.slice(0, Math.max(0, WORK_REPORT_LIMITS.questions - own.length)).map((n) => clauseQuestion(n, input.criteria[n - 1] ?? ""));
    if (answer.verdict === "questions" || added.length > 0) return { verdict: "questions", questions: [...own, ...added], route: answer.route };
    return answer;
  }
  if (answer.verdict === "questions") return answer;
  return {
    verdict: "unsupported", route: answer.route,
    reason: `the report does not show ${clauseNames(left)} of the task contract tested, and no question about ${left.length === 1 ? "it" : "them"} was answered`,
    questions: [`For each of ${clauseNames(left)}, add a line to your report naming the clause (C<n>), its test (file, and the name in double quotes) and its run's passing result line.`.slice(0, WORK_REPORT_LIMITS.question)],
  };
}
