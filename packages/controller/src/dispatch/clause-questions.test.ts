import assert from "node:assert/strict";
import { test } from "node:test";
import { CLAUSE_QUESTION_LIMITS, askedIn, clauseNames, clauseQuestion, clausesLeft, setAsideFileNames, shownTested, withClauseRule } from "./clause-questions.js";
import { WORK_REPORT_LIMITS } from "./model.js";

// Card W09 third slice: for a task with contract clauses, a supported is taken only once every clause is shown tested in the report or was asked about.

const CRITERIA = ["a long name is cut between whole characters", "an empty input gives an empty list", "the count is bounded at 50"];
const sorted = (s: Set<number>): number[] => [...s].sort((a, b) => a - b);

test("W09 third slice: a report line shows a clause tested when it names C<n>, a test name in double, typographic or back quotes and a passing result, with no failing one", () => {
  const shown = (line: string, n = 3): number[] => sorted(shownTested(line, n));
  assert.deepEqual(shown('C1: src/cut.test.ts "cuts between whole characters" passed'), [1]);
  assert.deepEqual(shown('- C2 \u201cempty input\u201d ok 4'), [2]);
  assert.deepEqual(shown("C3 `bounds the count` # pass 12 # fail 0"), [3], "a failing count of 0 is not a failure");
  assert.deepEqual(shown('C1, C3: "cuts" and "bounds" pass'), [1, 3], "one line may show several clauses");
  assert.deepEqual(shown('C1 "cuts" passed\nC2 "empty" ok\nC3 "bounds" failures: 0, passing'), [1, 2, 3]);
  assert.deepEqual(shown('c2 "empty" PASSED'), [2], "letter case of the name and the result does not matter");
  // Not shown: no clause name, no quoted name, no passing result, a failing result, the result only inside the quotes, the clause name only inside the quotes, a clause out of range, a longer number.
  for (const line of [
    '"cuts between whole characters" passed', "C1 cuts between whole characters, passed", 'C1 "cuts between whole characters"', 'C1 "cuts" not ok 3', 'C1 "cuts" failed', 'C1 "cuts" pass 3 fail 1', 'C1 "cuts" passing, 2 failing',
    'C1 "passes every offset"', 'see "C1" ok', 'C4 "x" passed', 'C0 "x" passed', 'C10 "x" passed', 'C1x "x" passed', 'AC1 "x" passed', "C1 'cuts' passed", 'C1 "cuts" bypassed', 'C1 "cuts" tokens',
  ]) assert.deepEqual(shown(line), [], line);
  assert.deepEqual(sorted(shownTested('C1 "x" passed', 0)), [], "a task without clauses has none");
});

test("W09 third slice, first review: a count of 0 or a negation next to a failing word, a file name that holds a result word or a clause name, and check marks are read as a reader would", () => {
  const shown = (line: string, n = 3): number[] => sorted(shownTested(line, n));
  // Shown tested: the usual summaries with no failure, a failing word only in a file name, a check mark.
  for (const line of [
    'C1: src/quote.test.ts "cuts" 3 passed, 0 failed', 'C1 "cuts" passed, no failures', 'C1 "cuts" ok (0 failures)', 'C1 "cuts" ok, tests: 4 pass / 0 fail', 'C1 "cuts" pass; none failed', 'C1 "cuts" pass; nothing failed', 'C1 "cuts" passed, zero failing',
    'C1 | src/fail-safe.test.ts | "cuts" | pass |', 'C1: test/fail_closed.test.mjs "cuts" ok', 'C1: lib\\fail.test.js "cuts" ok', 'C1: ✔ "cuts" (1.2ms)', '| C1 | `cuts` | ✓ |',
  ]) assert.deepEqual(shown(line), [1], line);
  // Still failing: a count other than 0, a 0 that is part of a number, a cross mark, a negation that is part of a word.
  for (const line of ['C1 "cuts" ok, 10 failed', 'C1 "cuts" ok, 2 failed', 'C1 "cuts" ok, 1.0 failed', 'C1 "cuts" ok ✖ 1', 'C1 "cuts" ok ✗', 'C1 "cuts" ok; piano failed', 'C1 "cuts" failed.', 'C1 "cuts" ok, fail 1']) assert.deepEqual(shown(line), [], line);
  // A clause name inside a file name is not a clause name; one written with a slash between clause names is.
  assert.deepEqual(shown('C1: src/c2.test.ts "cuts" ok'), [1]);
  assert.deepEqual(shown('src/c2.test.ts "cuts" ok'), []);
  assert.deepEqual(shown('C1/C3: "cuts" ok'), [1, 3]);
  assert.deepEqual(shown('C1. "cuts" passed.'), [1], "a full stop after the name or the result is not a file name");
});

test("W09 third slice: a question asks about a clause it names or whose own words it holds; only answered questions count; the clauses left keep the contract's order", () => {
  assert.deepEqual(askedIn("C2: what does an empty input give?", CRITERIA), [2]);
  assert.deepEqual(askedIn("Which test shows that An  Empty input gives an empty list?", CRITERIA), [2], "white space and letter case folded");
  assert.deepEqual(askedIn("Where is it shown that the count is bounded at 50, and C1?", CRITERIA), [1, 3]);
  assert.deepEqual(askedIn("Is the code clean?", CRITERIA), []);
  assert.deepEqual(askedIn("C9 and C0", CRITERIA), [], "out of range");
  assert.deepEqual(askedIn("abc", ["", "ab", "abc"]), [], "a clause of fewer than 4 characters is matched only by its name");
  assert.deepEqual(askedIn("abc C3", ["", "ab", "abc"]), [3]);
  const long = "x".repeat(400);
  assert.deepEqual(askedIn(`about ${long.slice(0, CLAUSE_QUESTION_LIMITS.match)}`, ["y", long]), [2], "a long clause by its first words");
  assert.deepEqual(clausesLeft(CRITERIA, "", []), [1, 2, 3]);
  assert.deepEqual(clausesLeft(CRITERIA, 'C2 "empty" passed', []), [1, 3]);
  assert.deepEqual(clausesLeft(CRITERIA, "", [{ questions: ["C1?", "C3?"] }]), [1, 2, 3], "an unanswered round asks nothing yet");
  assert.deepEqual(clausesLeft(CRITERIA, "", [{ questions: ["C1?", "C3?"], answers: ["a", "b"] }]), [2]);
  assert.deepEqual(clausesLeft(CRITERIA, 'C2 "e" ok', [{ questions: ["C1?", "other"], answers: ["a", "b"] }, { questions: ["C3?"], answers: ["c"] }]), []);
  assert.deepEqual(clausesLeft([], "", []), []);
});

test("W09 third slice: the controller's question about a clause names it, quotes it once and stays within the bound of a question at every length", () => {
  assert.equal(clauseQuestion(2, "an empty input gives an empty list"), 'C2 "an empty input gives an empty list": your report does not show this clause tested. Name its test (file, and the name in double quotes) and quote its run\'s result line.');
  for (let n = 0; n <= 520; n++) {
    const q = clauseQuestion(50, "\u2028\"\u202e".repeat(n).slice(0, n) + "y".repeat(Math.max(0, n - 3)));
    assert.ok(q.length <= WORK_REPORT_LIMITS.question, `${n}: ${q.length}`);
    assert.ok(q.startsWith("C50 "));
    assert.ok(!/[\u2028\u202e]/.test(q), "controls escaped");
  }
  assert.equal(clauseNames([1, 2]), "C1, C2");
  assert.equal(clauseNames(Array.from({ length: 20 }, (_, i) => i + 1)), `${Array.from({ length: 12 }, (_, i) => `C${i + 1}`).join(", ")} and 8 more`);
});

test("W09 third slice: the rule: a supported becomes the controller's questions for the clauses left; the second agent's questions get them in the room left; on the round that may not ask it is unsupported; without clauses or once all are covered nothing changes", () => {
  const at = (round: number, report = "", rounds: { questions: string[]; answers?: string[] }[] = [], criteria = CRITERIA) => ({ criteria, report, rounds, round, maxRounds: WORK_REPORT_LIMITS.rounds });
  const supported = { verdict: "supported" as const, route: "r" };
  // No clauses: the old behaviour.
  assert.deepEqual(withClauseRule(supported, at(1, "", [], [])), supported);
  // All shown tested in the report: taken at once.
  assert.deepEqual(withClauseRule(supported, at(1, 'C1 "a" ok\nC2 "b" ok\nC3 "c" ok')), supported);
  // Round 1, nothing shown: one controller question per clause.
  const r1 = withClauseRule(supported, at(1));
  assert.equal(r1.verdict, "questions");
  assert.deepEqual((r1 as { readonly questions: readonly string[] }).questions.map((q) => q.slice(0, 3)), ["C1 ", "C2 ", "C3 "]);
  assert.equal(r1.route, "r");
  // The second agent's own questions come first; a clause one of them already asks about is not asked again; the rest fill the room.
  const own = withClauseRule({ verdict: "questions", questions: ["Which test shows the count is bounded at 50?"], route: "r" }, at(1));
  assert.deepEqual((own as { readonly questions: readonly string[] }).questions.map((q) => q.slice(0, 12)), ["Which test s", "C1 \"a long n", "C2 \"an empty"]);
  // An own question about the first clause: the controller asks about the second and third, not the first again (first review of the breakages: the case above alone could not tell).
  const first = withClauseRule({ verdict: "questions", questions: ["Which test shows a long name is cut between whole characters?"], route: "r" }, at(1));
  assert.deepEqual((first as { readonly questions: readonly string[] }).questions.map((q) => q.slice(0, 3)), ["Whi", "C2 ", "C3 "]);
  const full = withClauseRule({ verdict: "questions", questions: ["q1", "q2", "q3"], route: "r" }, at(1));
  assert.deepEqual((full as { readonly questions: readonly string[] }).questions, ["q1", "q2", "q3"], "no room: the clauses wait for a later round");
  // Round 2, after round 1 asked C1 to C3 and they were answered: supported is taken.
  assert.deepEqual(withClauseRule(supported, at(2, "", [{ questions: ["C1?", "C2?", "C3?"], answers: ["a", "b", "c"] }])), supported);
  // The round that may not ask (3): the clauses left make it unsupported, named.
  const last = withClauseRule(supported, at(3, 'C2 "b" ok', [{ questions: ["q"], answers: ["a"] }, { questions: ["q"], answers: ["a"] }]));
  assert.equal(last.verdict, "unsupported");
  assert.equal((last as { reason: string }).reason, "the report does not show C1, C3 of the task contract tested, and no question about them was answered");
  assert.equal((last as { readonly questions: readonly string[] }).questions.length, 1);
  assert.ok((last as { readonly questions: readonly string[] }).questions[0]!.length <= WORK_REPORT_LIMITS.question);
  assert.match((withClauseRule(supported, at(3, 'C1 "a" ok\nC2 "b" ok')) as { reason: string }).reason, /does not show C3 of the task contract tested, and no question about it was answered/);
  // Unsupported stands; anything that is not a verdict is passed on as it is (the dispatcher reads it as unsupported).
  const no = { verdict: "unsupported" as const, reason: "x", questions: [], route: "r" };
  assert.equal(withClauseRule(no, at(1)), no);
  const odd = { verdict: "maybe", route: "r" } as never;
  assert.equal(withClauseRule(odd, at(1)), odd);
  // Questions on the last round stay what they are (the dispatcher makes them unsupported).
  const q3 = { verdict: "questions" as const, questions: ["q"], route: "r" };
  assert.equal(withClauseRule(q3, at(3)), q3);
});

test("W09 third slice: seven clauses over the rounds: three, three, then unsupported naming the seventh; the most clauses (50) at the bounds", () => {
  const seven = Array.from({ length: 7 }, (_, i) => `clause number ${i + 1} holds`);
  const supported = { verdict: "supported" as const, route: "r" };
  const a = withClauseRule(supported, { criteria: seven, report: "", rounds: [], round: 1, maxRounds: 2 }) as { readonly questions: readonly string[] };
  assert.deepEqual(a.questions.map((q) => q.split(" ")[0]), ["C1", "C2", "C3"]);
  const b = withClauseRule(supported, { criteria: seven, report: "", rounds: [{ questions: a.questions, answers: ["x", "y", "z"] }], round: 2, maxRounds: 2 }) as { readonly questions: readonly string[] };
  assert.deepEqual(b.questions.map((q) => q.split(" ")[0]), ["C4", "C5", "C6"]);
  const c = withClauseRule(supported, { criteria: seven, report: "", rounds: [{ questions: a.questions, answers: ["x", "y", "z"] }, { questions: b.questions, answers: ["x", "y", "z"] }], round: 3, maxRounds: 2 }) as { verdict: string; reason: string };
  assert.equal(c.verdict, "unsupported");
  assert.match(c.reason, /does not show C7 of/);
  // 50 clauses of 500 characters, a 4,000-character report of hostile text: bounded and fast.
  const fifty = Array.from({ length: 50 }, (_, i) => `${i} ${"z".repeat(497)}`);
  const hostile = ['C1 "'.repeat(1000), `${"C1 ".repeat(1300)}`, `"${"x".repeat(3998)}"`, `${'C1 "a" fail '.repeat(330)}`, `${"C1C1C1".repeat(660)}`, `${'C50 "a" ok\n'.repeat(400)}`];
  const started = performance.now();
  for (const report of hostile) {
    const left = clausesLeft(fifty, report, [{ questions: Array(3).fill("C".repeat(300)), answers: ["a", "b", "c"] }]);
    assert.ok(left.length >= 49);
    const r = withClauseRule(supported, { criteria: fifty, report, rounds: [], round: 3, maxRounds: 2 }) as { readonly reason: string; readonly questions: readonly string[] };
    assert.ok(r.reason.length <= WORK_REPORT_LIMITS.reason && r.questions[0]!.length <= WORK_REPORT_LIMITS.question, r.reason);
  }
  assert.ok(performance.now() - started < 1000, "linear on hostile text");
  // More lines than the bound: the lines after it are not read.
  const many = `${"filler\n".repeat(CLAUSE_QUESTION_LIMITS.lines)}C1 "a" ok`;
  assert.deepEqual([...shownTested(many, 1)], []);
  assert.deepEqual([...shownTested(`${"filler\n".repeat(CLAUSE_QUESTION_LIMITS.lines - 1)}C1 "a" ok`, 1)], [1]);
});

test("W09 third slice, second review: a confusion table of report lines as test runners and agents write them: a pass is read only where nothing on the line says a test failed, did not run, or did not all pass", () => {
  const T = true, F = false;
  const rows: [string, boolean][] = [
  ['C1: src/a.test.ts "rejects empty" ok', T], ['C1 "rejects empty" passed', T], ['C1: "x" - 3 passed, 0 failed', T], ['C1 "x" ✔ (no failures)', T],
  ['C1: tests/a.test.mjs "x": pass 4, fail 0', T], ['C1 "x" ok 1 - x', T], ['C1 `x` passes', T], ['C1 “x” passing', T], ['C1: "x" passed (none failed)', T],
  ['C1: src/fail-safe.test.ts "x" ok', T], ['C1 "x" ✓ 12 tests passed, 0 failures', T], ['C1: "x" - # pass 1 # fail 0', T], ['C1 "x" PASS', T],
  ['C1: "x" passed: 0 failed, 0 skipped', T], ['C1: "x" ok; failed: 0', T], ['C1 "x" passed in 0.3s', T], ['C1 "x" passed (2 of 2)', T], ['C1 "x" 5/5 passed', T],
  ['C1 "x" ok (0 tests failed)', T], ['C1 "x" passed, no errors', T], ['C1 "x" passed, 0 errors', T], ['C1 "x" ok (3.1ms)', T], ['C1: "x" passed; skipped 0, cancelled 0, todo 0', T],
  ['C1 "x" passed, fail 0.', T], ['C1 (rejects 0 bytes): "x" passed', T], ['C1 "x" ok, no tests failed', T], ['C1 "x" 3 of 3 passed', T], ['C1 "x" passed: 0.4 s', T], ['C1 "x" ok, not  ok', F],
  ['C1: x.test.ts "name" ok, but 2 failed', F], ['C1 "x" 0 passed 5 failed', F], ['C1 "x" not ok', F], ['C1 "x" ok (flaky: fail 3)', F], ['C1 "x" ✖ 1 failing', F],
  ['C1 "x" ✓ but "y" ✕', F], ['C1 "x" × 1 test', F], ['C1 "x" ✓, C2 "y" ×', F], ['C1 "x" 0 passed', F], ['C1 "x" pass 0', F], ['C1 "x" passed: 0', F],
  ['C1 "x" 2/5 passed', F], ['C1 "x" 2 of 5 passed', F], ['C1 "x" 0/0 passed', F], ['C1 "x" not run yet, ok?', F], ['C1 "x" should pass once the fix lands', F],
  ['C1 "x" ok # SKIP', F], ['C1 "x" ok # TODO not implemented', F], ['C1 "x": 3 passed, 1 error', F], ['C1 "x" passed: 0; failed: 1', F], ['C1 "x" did not pass', F],
  ['C1 "x" never passed', F], ['C1 "x" written, not tested (pass-through)', F], ['C1 "x" ok, 10 failed', F], ['C1 "x" ok; cancelled 1', F], ['C1 "x" timed out, setup ok', F],
  ['C1 "x" untested, looks ok', F], ["C1 \"x\" can't pass on CI", F], ['C1 "x" won’t pass', F], ['C1 "x" ok - no, it failed', F], ['C1 "x" ok, Ran 0 tests', F],
  ['C1 "x" ok; tests 0', F], ['C1 "x" pass-through only', F], ['C1 "x" passed, src/b.test.ts failed', F], ['C1 "x" FAILED', F], ['C1 "x" ❌', F],
  ['C1 "x" ok (skipped 2)', F], ['C1 "x" ok, 1,0 failed', F], ['C1 "x" passes, fails 1', F], ['C1 "x" ok, failed: 05', F], ['C1 "x" ok, 2 errors', F], ['C1 "x" passed, cannot pass on Windows', F],
  ['C1 "x" failed before the fix, passes after', F], ['C1 (fail-closed): "x" ok', F], ['C1 "x" ok, not failing', F],
];
  assert.ok(rows.length >= 70 && rows.filter((r) => r[1]).length >= 25 && rows.filter((r) => !r[1]).length >= 40);
  const wrong = rows.filter(([line, want]) => shownTested(line, 3).has(1) !== want).map(([line, want]) => `${want ? "refused" : "accepted"}: ${line}`);
  assert.deepEqual(wrong, []);
});

test("W09 third slice, second review: file names are set aside in one pass over each run, with the same parts set aside as the first review's expression (a count such as 2/5 now kept), and the reading stays linear on 100 KB", () => {
  // The first review's expression, for comparison on short text (it is quadratic in a long run), with the one change made on purpose: a count such as 2/5 is kept.
  const OLD = /[A-Za-z0-9_.\\/-]*(?:[\\/][A-Za-z0-9_.\\/-]*|\.[A-Za-z][A-Za-z0-9]{0,7}(?![A-Za-z0-9]))/g;
  const CLAUSES = /^(?:[Cc]\d{1,3}[\\/-]?)+$/;
  const FRACTION = /^[0-9]+(?:[\\/][0-9]+)+$/;
  const old = (t: string): string => t.replace(OLD, (w) => (CLAUSES.test(w) || FRACTION.test(w) ? w : " "));
  const alphabet = ["a", "Z", "C", "c", "1", "0", ".", "/", "\\", "-", "_", " ", "ts", "x", "\"", "!", "\u00e9"];
  let seed = 7;
  const rand = (n: number): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let i = 0; i < 20_000; i++) {
    const t = Array.from({ length: 1 + rand(24) }, () => alphabet[rand(alphabet.length)]).join("");
    assert.equal(setAsideFileNames(t), old(t), JSON.stringify(t));
  }
  for (const t of ["src/a.test.ts ok", "a/b.c_d", "x.ts-failed", "C1/C3", "2/5 passed", "lib\\ok.js", "a.b.c.d", "fail-safe", ".hidden", "v1.2.3", "C1.", "path/to/"]) assert.equal(setAsideFileNames(t), old(t), t);
  for (const unit of ["a", ".", "a.", "a.1", "_", "1", "C1C", "a/", "a.bbbbbbbbbb", "fail", "0 ", "no   ", "not   ", "C1 \"x\" ok "]) {
    const big = unit.repeat(Math.ceil(100_000 / unit.length));
    const started = performance.now();
    setAsideFileNames(big);
    shownTested(big, 50);
    shownTested(Array.from({ length: CLAUSE_QUESTION_LIMITS.lines }, () => big.slice(0, CLAUSE_QUESTION_LIMITS.line)).join("\n"), 50);
    assert.ok(performance.now() - started < 1500, `${JSON.stringify(unit)}: ${performance.now() - started} ms`);
  }
});

test("W09 third slice, second review: the clause questions the later rounds could not hold take the room before the second agent's questions that ask about no clause left; one that asks about a clause keeps its place", () => {
  const at = (round: number, report = "", rounds: { questions: string[]; answers?: string[] }[] = [], criteria = CRITERIA) => ({ criteria, report, rounds, round, maxRounds: WORK_REPORT_LIMITS.rounds });
  const qs = (a: unknown): string[] => (a as { readonly questions: readonly string[] }).questions.map((q) => q.split(" ")[0]!);
  const own = (...questions: string[]) => ({ verdict: "questions" as const, questions, route: "r" });
  // Round 1, three clauses left: round 2 can hold them, so the second agent's three questions stand (the old behaviour).
  assert.deepEqual(qs(withClauseRule(own("q1", "q2", "q3"), at(1))), ["q1", "q2", "q3"]);
  // Round 2, the last that may ask: the clauses left come first and the second agent's questions keep the rest (before: q1, q2, q3, then an unsupported on round 3).
  const r1 = [{ questions: ["q1", "q2", "q3"], answers: ["a", "b", "c"] }];
  assert.deepEqual(qs(withClauseRule(own("q4", "q5", "q6"), at(2, 'C2 "b" ok', r1))), ["q4", "C1", "C3"]);
  assert.deepEqual(qs(withClauseRule(own("q4", "q5", "q6"), at(2, 'C1 "a" ok\nC2 "b" ok', r1))), ["q4", "q5", "C3"]);
  assert.deepEqual(qs(withClauseRule(own("q4", "q5", "q6"), at(2, "", r1))), ["C1", "C2", "C3"]);
  // An own question that asks about a clause left keeps its place and that clause is not asked again.
  assert.deepEqual(qs(withClauseRule(own("q4", "Is C3 tested?", "q6"), at(2, "", r1))), ["Is", "C1", "C2"]);
  // Round 1, five clauses: round 2 holds three, so two are asked now, before the second agent's other questions.
  const five = ["one rule here", "two rule here", "three rule here", "four rule here", "five rule here"];
  const a = withClauseRule(own("q1", "q2", "q3"), at(1, "", [], five));
  assert.deepEqual(qs(a), ["q1", "C1", "C2"]);
  const b = withClauseRule(own("q4", "q5", "q6"), at(2, "", [{ questions: [...(a as unknown as { questions: string[] }).questions], answers: ["x", "y", "z"] }], five));
  assert.deepEqual(qs(b), ["C3", "C4", "C5"]);
  assert.deepEqual(withClauseRule({ verdict: "supported", route: "r" }, at(3, "", [{ questions: [...(a as unknown as { questions: string[] }).questions], answers: ["x", "y", "z"] }, { questions: [...(b as unknown as { questions: string[] }).questions], answers: ["x", "y", "z"] }], five)), { verdict: "supported", route: "r" });
  // Blank questions of the second agent's own take no room.
  assert.deepEqual(qs(withClauseRule(own("", "  ", "q"), at(1))), ["q", "C1", "C2"]);
  // Without clauses, or with every clause shown, its questions are passed on as they are.
  const plain = own("q1", "q2", "q3");
  assert.equal(withClauseRule(plain, at(2, "", r1, [])), plain);
  assert.equal(withClauseRule(plain, at(2, 'C1 "a" ok\nC2 "b" ok\nC3 "c" ok', r1)), plain);
});
