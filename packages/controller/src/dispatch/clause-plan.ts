// Card W09 second slice: whether the agent's PLAN.md maps every clause of the task contract to a test of its change.
//
// The W09 bench's false dones each missed one contract clause while the agent's own tests passed. A contract that opts in (a check with `changedTests`, and `acceptanceCriteria`) asks for one ticked step per clause, in the
// clause's order of the contract: `- [x] C<n>: ...`, naming a test file the change adds or changes and one of that file's tests by name, in quotes. The host reads the files (the plan, the change's test files and the
// test names they declare); this module only judges what it reported. Everything is bounded: the plan's lines, the steps looked at per clause, the names compared, and the text of the answer.

import type { ChangedTestsReport } from "./ports.js";
import { quoted } from "../status/explain.js";

export const CLAUSE_PLAN_LIMITS = { lines: 2_000, line: 2_000, stepsPerClause: 5, filesPerStep: 3, quotesPerStep: 40, quote: 400, shown: 6, criterion: 100, message: 880 } as const;

/** A checkbox line of PLAN.md: a list marker (`-`, `*`, `+` or `1.`), the box, then the step's text. */
const STEP = /^[ \t]{0,12}(?:[-*+]|\d{1,4}[.)])[ \t]+\[([ xX])\][ \t]+(.*)$/;
/** The clause a step is for: `C<n>` at its start, after optional emphasis or brackets (`**C3**`, `(C3)`, `` `C3` ``). */
const CLAUSE_AT_START = /^[\s*_`([]{0,6}[Cc](\d{1,3})(?!\d)/;
/** Quoted text in a step: straight double, single or back quotes, or typographic double quotes. Linear: each body excludes its own closing quote and line ends. */
const QUOTED = /"([^"\r\n]{1,400})"|'([^'\r\n]{1,400})'|`([^`\r\n]{1,400})`|\u201c([^\u201d\r\n]{1,400})\u201d/g;

interface Step { readonly ticked: boolean; readonly text: string; readonly quotes: ReadonlySet<string> }

/** The steps of a plan, by the clause number they start with (at most `stepsPerClause` each), from at most `lines` lines. */
function stepsOf(text: string): Map<number, Step[]> {
  const out = new Map<number, Step[]>();
  const lines = text.split(/\r\n|\n|\r/, CLAUSE_PLAN_LIMITS.lines);
  for (const raw of lines) {
    const line = raw.length > CLAUSE_PLAN_LIMITS.line ? raw.slice(0, CLAUSE_PLAN_LIMITS.line) : raw;
    const m = STEP.exec(line);
    if (m === null) continue;
    const body = m[2]!;
    const c = CLAUSE_AT_START.exec(body);
    if (c === null) continue;
    const n = Number.parseInt(c[1]!, 10);
    const list = out.get(n) ?? [];
    if (list.length >= CLAUSE_PLAN_LIMITS.stepsPerClause) continue;
    const quotes = new Set<string>();
    for (const q of body.matchAll(QUOTED)) {
      if (quotes.size >= CLAUSE_PLAN_LIMITS.quotesPerStep) break;
      quotes.add((q[1] ?? q[2] ?? q[3] ?? q[4])!);
    }
    list.push({ ticked: m[1] !== " ", text: body, quotes });
    out.set(n, list);
  }
  return out;
}

/** A test name as written in its file, and the same with its escapes undone (`\"` as `"`), either of which the step may quote. */
const spellings = (title: string): string[] => {
  const t = title.slice(0, CLAUSE_PLAN_LIMITS.quote);
  const plain = t.replace(/\\(.)/g, "$1");
  return plain === t ? [t] : [t, plain];
};

type Verdict = { kind: "ok" } | { kind: "missing" } | { kind: "unticked" } | { kind: "no-file" } | { kind: "no-name"; file: string; titles: readonly string[] };

function judgeClause(steps: readonly Step[] | undefined, files: ChangedTestsReport["files"]): Verdict {
  if (steps === undefined || steps.length === 0) return { kind: "missing" };
  let best: Verdict = { kind: "unticked" };
  for (const step of steps) {
    if (!step.ticked) continue;
    const named = files.filter((f) => step.text.includes(f.path)).slice(0, CLAUSE_PLAN_LIMITS.filesPerStep);
    if (named.length === 0) { if (best.kind === "unticked") best = { kind: "no-file" }; continue; }
    for (const f of named) if (f.titles.some((t) => spellings(t).some((s) => step.quotes.has(s)))) return { kind: "ok" };
    best = { kind: "no-name", file: named[0]!.path, titles: named[0]!.titles };
  }
  return best;
}

/**
 * The problems of the plan against the contract's clauses, as one line for the done's refusal (bounded), or `undefined` when every clause has its step. No clauses: nothing to judge (the done check is as before).
 * A plan the host could not read is one problem; so is a change with no test file (the check itself already refuses that done, and the line then says the clauses could not be matched).
 */
export function clausePlanProblem(criteria: readonly string[], report: ChangedTestsReport): string | undefined {
  if (criteria.length === 0) return undefined;
  const form = "Each needs a ticked step that starts with its number, in the contract's order, and names a test file your change adds or changes and one of its tests by name, in quotes: - [x] C1: ... path/to/x.test.ts \"its test name\".";
  if ("why" in report.plan) return clip(`The contract has ${criteria.length} clause(s) (C1 to C${criteria.length}) and your PLAN.md could not be read (${quoted(report.plan.why, 160)}), so no clause could be matched to a test. ${form}`);
  if (report.files.length === 0) return clip(`The contract has ${criteria.length} clause(s) (C1 to C${criteria.length}) and your change adds or changes no test file, so no clause could be matched to a test. ${form}`);
  const steps = stepsOf(report.plan.text);
  const problems: string[] = [];
  let failing = 0;
  for (const [i, criterion] of criteria.entries()) {
    const v = judgeClause(steps.get(i + 1), report.files);
    if (v.kind === "ok") continue;
    failing++;
    if (problems.length >= CLAUSE_PLAN_LIMITS.shown) continue;
    const c = `C${i + 1} (${quoted(criterion, CLAUSE_PLAN_LIMITS.criterion)})`;
    if (v.kind === "missing") problems.push(`${c} has no step`);
    else if (v.kind === "unticked") problems.push(`${c}: its step is not ticked`);
    else if (v.kind === "no-file") problems.push(`${c}: its step names no test file of your change (they are ${report.files.slice(0, 4).map((f) => quoted(f.path, 120)).join(", ")}${report.files.length > 4 ? ` and ${report.files.length - 4} more` : ""})`);
    else problems.push(`${c}: its step names ${quoted(v.file, 120)} but none of its tests by name in quotes${v.titles.length === 0 ? " (no test name was found in that file; a skipped or todo test does not count)" : ` (it declares ${v.titles.slice(0, 3).map((t) => quoted(t, 80)).join(", ")}${v.titles.length > 3 ? ` and ${v.titles.length - 3} more` : ""})`}`);
  }
  if (failing === 0) return undefined;
  // Whole problems are dropped (and counted) until the line fits, so a cut never falls inside one; the cut below is the last resort for a single long one.
  const line = (shown: readonly string[]): string => `PLAN.md does not map ${failing} of the contract's ${criteria.length} clause(s) to a test of your change: ${shown.join("; ")}${failing > shown.length ? `; and ${failing - shown.length} more` : ""}. ${form}`;
  while (problems.length > 1 && line(problems).length > CLAUSE_PLAN_LIMITS.message) problems.pop();
  return clip(line(problems));
}

/** The line cut to its bound at a whole character (each part was already quoted, so a cut leaves no raw text). */
function clip(text: string): string {
  if (text.length <= CLAUSE_PLAN_LIMITS.message) return text;
  const chars = Array.from(text);
  let out = "";
  for (const c of chars) { if (out.length + c.length > CLAUSE_PLAN_LIMITS.message - 3) break; out += c; }
  return `${out}...`;
}

/** Bounds of what a host may report for the changed tests: what the worker host sends at most (`CLAUSE_TEST_LIMITS` in the worker package). A report over them is not used (the check then could not be made). */
export const CHANGED_TESTS_REPORT_LIMITS = { files: 50, path: 1_000, titles: 400, title: 300, plan: 64 * 1024 } as const;

/** The host's report of the changed tests, checked for shape and bounds; `undefined` when it is absent or not usable (fail closed: the controller then says the check could not be made). */
export function changedTestsOf(value: unknown): ChangedTestsReport | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const L = CHANGED_TESTS_REPORT_LIMITS;
  if (typeof v["count"] !== "number" || !Number.isSafeInteger(v["count"]) || v["count"] < 0) return undefined;
  const files = v["files"];
  if (!Array.isArray(files) || files.length > L.files || files.length > v["count"]) return undefined;
  const out: ChangedTestsReport["files"][number][] = [];
  for (const f of files as unknown[]) {
    if (f === null || typeof f !== "object") return undefined;
    const o = f as Record<string, unknown>;
    if (typeof o["path"] !== "string" || o["path"] === "" || o["path"].length > L.path) return undefined;
    if (o["built"] !== null && (typeof o["built"] !== "string" || o["built"] === "" || o["built"].length > L.path)) return undefined;
    const titles = o["titles"];
    if (!Array.isArray(titles) || titles.length > L.titles || titles.some((t) => typeof t !== "string" || t.length > L.title)) return undefined;
    out.push({ path: o["path"], built: o["built"] as string | null, titles: [...(titles as string[])] });
  }
  const plan = v["plan"];
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) return undefined;
  const p = plan as Record<string, unknown>;
  const shapedPlan = typeof p["text"] === "string" && p["text"].length <= L.plan ? { text: p["text"] } : typeof p["why"] === "string" ? { why: p["why"].slice(0, 300) } : undefined;
  if (shapedPlan === undefined) return undefined;
  return { count: v["count"], files: out, plan: shapedPlan };
}
