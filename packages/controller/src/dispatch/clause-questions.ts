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
/** A passing run result outside the quotes: `ok`, `pass`, `passed`, `passes`, `passing` as whole words (not `pass-through`), or a check mark (node's spec reporter prints `✔`). */
const PASSING = /(?<![A-Za-z])(?:ok|pass(?:ed|es|ing)?)(?![A-Za-z_-])|[\u2713\u2714\u2705]/i;
/** A count of 0, not part of a longer number (`10`, `1.0`, `1,0`) and not followed by more digits (`05`, `0.5`). */
const ZERO = String.raw`(?<![0-9.,])0(?![0-9]|[.,][0-9])`;
/**
 * A failing one (each pattern bounded, so the reading stays linear in the line):
 * - `not ok`, or a cross mark (`✖`, `✗`, `✘`, `❌`, jest's `✕`, vitest's `×`, `⨯`);
 * - `fail` (failed, fails, failing, failure) with no count of 0 or negation next to it: `fail 0`, `failed: 0`, `0 failed`, `4 pass / 0 fail`, `no failures`, `none failed`, `nothing failed`, `0 tests failed` and `no tests
 *   failed` are not failures (first review: the common "3 passed, 0 failed" and "no failures" were read as failing and the clause asked about again);
 * - second review, results that are not a pass although a passing word is on the line: none passed (`0 passed`, `pass 0`, `passed: 0`, `ran 0 tests`, `tests 0`, but not `passed: 0 failed`); a pass that is denied or only expected (`not`, `never`,
 *   `cannot`, `did not`, `can't`, `won't`, `should`, `would`, `will`, `to` before it); a test not run (`not run`, `not tested`, `untested`, `timed out`, a TAP `# SKIP` or `# TODO`); and a count above 0 of skipped,
 *   cancelled or errored tests (`1 error`, `skipped 2`, `cancelled 1`).
 */
const FAILING: readonly RegExp[] = [
  /(?<![A-Za-z])not[ \t]{1,8}ok(?![A-Za-z])|[\u2716\u2717\u2718\u274c\u2715\u00d7\u2a2f]/i,
  new RegExp(String.raw`(?<!(?:${ZERO}|(?<![A-Za-z])(?:no|zero|none|nothing))(?:[ \t]{1,3}tests?)?[ \t]{1,3})(?<![A-Za-z])fail(?:ed|s|ing|ures?)?(?![A-Za-z])(?![ \t]{0,3}[:=]?[ \t]{0,3}${ZERO})`, "i"),
  new RegExp(String.raw`${ZERO}[ \t]{1,3}(?:tests?[ \t]{1,3})?(?:ok|pass(?:ed|es|ing)?)(?![A-Za-z])|(?<![A-Za-z])(?:pass(?:ed|es|ing)?|ran|tests?)[ \t]{0,3}[:=]?[ \t]{0,3}${ZERO}(?![A-Za-z])(?![ \t]{1,3}(?:tests?[ \t]{1,3})?fail)`, "i"),
  /(?:(?<![A-Za-z])(?:not|never|cannot|should|would|will|to)|n['\u2019]t)(?:[ \t]{1,3}(?:yet|all|be|been))?[ \t]{1,3}(?:ok|pass(?:ed|es|ing)?|run|ran|tested|executed)(?![A-Za-z])/i,
  /(?<![A-Za-z])(?:untested|unverified|timed[ \t]{1,3}out)(?![A-Za-z])/i,
  // Re-check of the second review (an independent table of 137 report lines found these read as passing): a result word that is not a pass, with no count of 0 or negation next to it, as for `fail` above (`1 pending`,
  // `skip`, `# todo`, `1 ignored`, `1 xfailed`, `1 deselected`, `crashed`, `panic`, `flaky`; `todo 0`, `0 skipped` and `no errors` stay passes: node's TAP summary prints `# todo 0`, which the second review read as failing).
  new RegExp(String.raw`(?<!(?:${ZERO}|(?<![A-Za-z])(?:no|zero|none|nothing))(?:[ \t]{1,3}tests?)?[ \t]{1,3})(?<![A-Za-z])(?:skip(?:s|ped)?|pending|todo|ignored|x(?:fail|pass)(?:ed|es)?|deselected|cancell?ed|errors?|errored|crash(?:ed|es)?|panic(?:s|ked)?|broken|flaky|retr(?:y|ied|ies)|regressions?)(?![A-Za-z])(?![ \t]{0,3}[:=]?[ \t]{0,3}${ZERO})`, "i"),
  // A run that exited other than 0 (`exit code 1`, `exited with 2`), no test run (`no test files`, `no tests ran`), a pass word denied without an apostrophe (`doesnt pass`) or only possible (`might pass`).
  /(?<![A-Za-z])exit(?:s|ed)?(?:[ \t]{1,3}with)?(?:[ \t]{1,3}(?:code|status))?[ \t]{0,3}[:=]?[ \t]{0,3}-?[1-9]|(?<![A-Za-z])no[ \t]{1,3}tests?[ \t]{1,3}(?:files?|found|ran|run|executed|collected)(?![A-Za-z])/i,
  /(?<![A-Za-z])(?:(?:does|do|did|is|was|wo|ca|has|have|are|were|could|would|should)nt|might|may|could|must|can)(?:[ \t]{1,3}(?:yet|all|be|been))?[ \t]{1,3}(?:ok|pass(?:ed|es|ing)?|run|ran|tested|executed)(?![A-Za-z])/i,
  // A warning or a red mark (`⚠`, `⛔`, `🔴`, `🚫`, `🛑`).
  /[\u26a0\u26d4\u{1F534}\u{1F6AB}\u{1F6D1}]/u,
];
/**
 * A count of passes out of a total, failing unless all passed (`0/0 passed` is already read as none passed): `2/5 passed`, `2 of 5 passing`, `3 out of 4 passed`, jest's `3 passed, 4 total`, vitest's `3 passed (4)`, and a
 * share under 100 % (`75% passed`, `pass rate 50%`), also with the pass word first (`passed 3 of 4`).
 */
const PASS_TOTALS: readonly RegExp[] = [
  /(?<![0-9.,])([0-9]{1,9})(?:[ \t]{0,3}[\\/][ \t]{0,3}|[ \t]{1,3}(?:out[ \t]{1,3})?of[ \t]{1,3})([0-9]{1,9})(?![0-9.,])[ \t]{1,3}(?:tests?[ \t]{1,3})?(?:ok|pass(?:ed|es|ing)?)(?![A-Za-z])/gi,
  /(?<![0-9.,])([0-9]{1,9})[ \t]{1,3}(?:tests?[ \t]{1,3})?pass(?:ed|es|ing)?(?:[ \t]{0,3},[ \t]{0,3}([0-9]{1,9})[ \t]{1,3}total(?![A-Za-z])|[ \t]{1,3}\([ \t]{0,3}([0-9]{1,9})[ \t]{0,3}\))/gi,
  /(?<![A-Za-z])pass(?:ed|es|ing)?[ \t]{1,3}([0-9]{1,9})(?:[ \t]{0,3}[\\/][ \t]{0,3}|[ \t]{1,3}(?:out[ \t]{1,3})?of[ \t]{1,3})([0-9]{1,9})(?![0-9.,])/gi,
  /(?<![0-9.,])([0-9]{1,3}(?:\.[0-9]{1,3})?)[ \t]{0,3}%[ \t]{1,3}(?:of[ \t]{1,3}(?:the[ \t]{1,3})?tests?[ \t]{1,3})?(?:ok|pass(?:ed|es|ing)?)(?![A-Za-z])|(?<![A-Za-z])pass(?:ed|ing)?[ \t]{1,3}rate[ \t]{0,3}[:=]?[ \t]{0,3}([0-9]{1,3}(?:\.[0-9]{1,3})?)[ \t]{0,3}%/gi,
];
/** Whether a total's match counts fewer passes than its total (a share is out of 100). */
const fewerPassed = (m: RegExpMatchArray, share: boolean): boolean => (share ? Number(m[1] ?? m[2]) < 100 : Number(m[1]) < Number(m[2] ?? m[3]));
const failing = (line: string): boolean => FAILING.some((f) => f.test(line)) || PASS_TOTALS.some((r, i) => [...line.matchAll(r)].some((m) => fewerPassed(m, i === 3)));
/** The test name the first prompt's sample line holds (`dispatcher.ts` `reportClauseNote`): a copied sample shows nothing tested. */
const SAMPLE_NAME = "its test name";
/** A run of characters a file name may hold, matched in one pass (each run is maximal, so the scan is linear). */
const NAME_RUN = /[A-Za-z0-9_.\\/-]+/g;
/** A file extension in a run: a dot, a letter and at most 7 more letters or digits, not followed by a letter or digit. */
const EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,7}(?![A-Za-z0-9])/g;
const CLAUSES_ONLY = /^(?:[Cc]\d{1,3}[\\/-]?)+$/;
const FRACTION = /^[0-9]+(?:[\\/][0-9]+)+$/;
/** A run of path separators only (the `/` of `0 / 1 ok`): not a file name, kept so a spaced count is read (re-check of the second review). */
const SEPARATORS = /^[\\/]+$/;

/**
 * File names outside the quotes (`src/fail-safe.test.ts`, `c2.test.mjs`, `lib\ok.js`) set aside: in a run of name characters, the part up to the end of the run when its last path separator comes after its last extension, or
 * else up to the end of its last extension. They are set aside before the result and the clause names are read, so a file named `fail-safe` is not a failing result and `src/c2.test.ts` does not name C2 (first review). A
 * part of clause names only (`C1/C2`), a count such as `2/5` or a run of separators only (the `/` of `0 / 1 ok`) is kept. Second review: this was one regular expression whose leading `[...]*` was retried from every character of a long run (quadratic: about 2 ms for 1,000
 * characters, 15 s for 100 KB); it is now one pass over each run, setting aside the same parts (a test compares the two).
 */
export function setAsideFileNames(text: string): string {
  return text.replace(NAME_RUN, (run) => {
    if (SEPARATORS.test(run)) return run;
    const slash = Math.max(run.lastIndexOf("/"), run.lastIndexOf("\\"));
    let extStart = -1, extEnd = -1;
    for (const m of run.matchAll(EXTENSION)) { extStart = m.index; extEnd = m.index + m[0].length; }
    const end = extStart > slash ? extEnd : slash >= 0 ? run.length : -1;
    if (end < 0) return run;
    const name = run.slice(0, end);
    return (CLAUSES_ONLY.test(name) || FRACTION.test(name) ? name : " ") + run.slice(end);
  });
}

/** The words of a text as compared: lower case, white space folded, at most `match` characters. */
const words = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim().slice(0, CLAUSE_QUESTION_LIMITS.match);

/** The clause numbers (1-based) a line shows tested: it names them, outside quotes, and holds a quoted name and a passing result with no failing one. */
function testedOn(raw: string, count: number): number[] {
  const cut = raw.length > CLAUSE_QUESTION_LIMITS.line ? raw.slice(0, CLAUSE_QUESTION_LIMITS.line) : raw;
  // Re-check of the second review: compatibility forms are read as their plain letters and digits (`０ passed`, `ｆａｉｌ`) and invisible format characters are dropped (`fa\u200bil`), then the line is cut again (one
  // compatibility form can stand for several characters).
  const line = cut.normalize("NFKC").replace(/\p{Cf}/gu, "").slice(0, CLAUSE_QUESTION_LIMITS.line);
  let rest = line;
  let names = 0;
  for (const style of QUOTES) {
    let taken = 0;
    rest = rest.replace(style, (_, body: string) => {
      if (taken >= CLAUSE_QUESTION_LIMITS.quotesPerLine) return " ";
      taken++;
      // The sample line's placeholder name is not a test name (re-check of the second review: a copied sample showed C1 tested).
      if (words(body) !== SAMPLE_NAME) names++;
      return " ";
    });
  }
  rest = setAsideFileNames(rest);
  if (names === 0 || !PASSING.test(rest) || failing(rest)) return [];
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
 * about the clauses left (as many as a round holds), and a round of the second agent's own questions gets them added in the room it leaves, except that the clause questions the later rounds could not hold come before its
 * questions that ask about no clause left (second review). On a round that may not ask, a `supported` becomes unsupported, naming the clauses.
 */
export function withClauseRule(answer: Answer, input: { readonly criteria: readonly string[]; readonly report: string; readonly rounds: readonly { readonly questions: readonly string[]; readonly answers?: readonly string[] }[]; readonly round: number; readonly maxRounds: number }): Answer {
  // Unsupported stands, and so does anything that is not a verdict (the dispatcher reads that as unsupported).
  if (answer.verdict !== "supported" && answer.verdict !== "questions") return answer;
  const left = clausesLeft(input.criteria, input.report, input.rounds);
  if (left.length === 0) return answer;
  const room = WORK_REPORT_LIMITS.questions;
  // A blank question of the second agent's own takes no room (the dispatcher drops it).
  const own = answer.verdict === "questions" ? answer.questions.filter((q) => String(q).trim() !== "").slice(0, room) : [];
  if (input.round <= input.maxRounds) {
    // Second review: who gets the room. An own question that already asks about a clause left keeps its place (it serves both). The clause questions that the rounds after this one could not hold come next, then the
    // second agent's other questions, then the rest of the clause questions. Before, its own questions always came first, so three of them on the last round that may ask left a clause for the round that may not, which
    // turned a supported into an unsupported (a go-on).
    const leftSet = new Set(left);
    const asks = own.map((q) => askedIn(q, input.criteria).filter((n) => leftSet.has(n)));
    // Re-check: only an own question that asks about a clause left that no earlier one asks about keeps its place this way (two questions about the same clause took two places, leaving a clause for the round that
    // may not ask); a repeat is one of its other questions.
    const keep = new Set<number>();
    const asking = new Set<number>();
    own.forEach((_, i) => { if (asks[i]!.some((n) => !asking.has(n))) { keep.add(i); for (const n of asks[i]!) asking.add(n); } });
    const ask = left.filter((n) => !asking.has(n));
    const later = Math.max(0, input.maxRounds - input.round) * room;
    const first = Math.min(room - keep.size, Math.max(0, ask.length - later));
    own.forEach((_, i) => { if (!keep.has(i) && keep.size + first < room) keep.add(i); });
    const kept = own.filter((_, i) => keep.has(i));
    const added = ask.slice(0, room - kept.length).map((n) => clauseQuestion(n, input.criteria[n - 1] ?? ""));
    if (answer.verdict === "questions" || added.length > 0) return { verdict: "questions", questions: [...kept, ...added], route: answer.route };
    return answer;
  }
  if (answer.verdict === "questions") return answer;
  return {
    verdict: "unsupported", route: answer.route,
    reason: `the report does not show ${clauseNames(left)} of the task contract tested, and no question about ${left.length === 1 ? "it" : "them"} was answered`,
    questions: [`For each of ${clauseNames(left)}, add a line to your report naming the clause (C<n>), its test (file, and the name in double quotes) and its run's passing result line.`.slice(0, WORK_REPORT_LIMITS.question)],
  };
}
