import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANGED_TESTS_REPORT_LIMITS, CLAUSE_PLAN_LIMITS, changedTestsOf, clausePlanProblem } from "./clause-plan.js";
import type { ChangedTestsReport } from "./ports.js";

// Card W09 second slice: PLAN.md maps every contract clause to a test of the change. Pure judging of what the host reported.
const files: ChangedTestsReport["files"] = [
  { path: "packages/controller/src/chat/commands.test.ts", built: "packages/controller/dist/chat/commands.test.js", titles: ["a long name is cut between whole characters and whole escapes", "a label is quoted", "says \\\"no\\\" plainly"] },
  { path: "packages/controller/src/chat/chat.test.ts", built: "packages/controller/dist/chat/chat.test.js", titles: ["a preview is one line"] },
];
const criteria = ["Whatever the input, every line holds no raw control", "A label is exactly quotedText(label)", "ChatService gives a one-line preview"];
const report = (text: string, f = files): ChangedTestsReport => ({ count: f.length, files: f, plan: { text } });
const GOOD = [
  "# Plan",
  "- [x] Read the code first",
  "- [x] C1: sweep every cut offset in packages/controller/src/chat/commands.test.ts \"a long name is cut between whole characters and whole escapes\"",
  "* [X] **C2** packages/controller/src/chat/commands.test.ts `a label is quoted`",
  "1. [x] (C3) packages/controller/src/chat/chat.test.ts \u201ca preview is one line\u201d",
].join("\n");

test("every clause with a ticked step naming a test file of the change and one of its tests in quotes: no problem; no clauses: nothing judged", () => {
  assert.equal(clausePlanProblem(criteria, report(GOOD)), undefined);
  assert.equal(clausePlanProblem([], report("")), undefined, "a contract without clauses is checked as before");
  assert.equal(clausePlanProblem([], { count: 0, files: [], plan: { why: "none" } }), undefined);
  // A name written with its escapes undone is the same test; a step may name several files.
  assert.equal(clausePlanProblem(["x"], report(`- [x] C1: packages/controller/src/chat/chat.test.ts and packages/controller/src/chat/commands.test.ts 'says "no" plainly'`)), undefined);
  // Of several steps for a clause, one that passes is enough; CRLF line ends are read.
  assert.equal(clausePlanProblem(["x"], report("- [ ] C1: later\r\n- [x] C1: packages/controller/src/chat/chat.test.ts \"a preview is one line\"\r\n")), undefined);
});

test("each kind of gap is named for its clause, in the contract's order, with the clause quoted and what would satisfy it", () => {
  const plan = [
    "- [ ] C1: packages/controller/src/chat/commands.test.ts \"a label is quoted\"",
    "- [x] C2: tests in some other file \"a label is quoted\"",
    "- [x] C3: packages/controller/src/chat/chat.test.ts, the preview test",
  ].join("\n");
  const p = clausePlanProblem([...criteria, "a fourth clause"], report(plan))!;
  assert.match(p, /^PLAN\.md does not map 4 of the contract's 4 clause\(s\) to a test of your change: /);
  assert.ok(p.includes('C1 ("Whatever the input, every line holds no raw control"): its step is not ticked'), p);
  assert.ok(p.includes('C2 ("A label is exactly quotedText(label)"): its step names no test file of your change (they are "packages/controller/src/chat/commands.test.ts", "packages/controller/src/chat/chat.test.ts")'), p);
  assert.ok(p.includes('C3 ("ChatService gives a one-line preview"): its step names "packages/controller/src/chat/chat.test.ts" but none of its tests by name in quotes (it declares "a preview is one line")'), p);
  assert.ok(p.includes('C4 ("a fourth clause") has no step'), p);
  assert.ok(p.endsWith('- [x] C1: ... path/to/x.test.ts "its test name".'), p);
  assert.ok(p.length <= CLAUSE_PLAN_LIMITS.message);
});

test("a step counts for the clause it starts with only: C1 inside the text, C10 for C1, or a name that is not one of the file's tests do not count", () => {
  for (const plan of [
    "- [x] Covers C1: packages/controller/src/chat/chat.test.ts \"a preview is one line\"",
    "- [x] C10: packages/controller/src/chat/chat.test.ts \"a preview is one line\"",
    "- [x] C1: packages/controller/src/chat/chat.test.ts \"a preview\"",
    "- [x] C1: packages/controller/src/chat/chat.test.ts a preview is one line",
    "  - [x]C1: packages/controller/src/chat/chat.test.ts \"a preview is one line\"",
    "[x] C1: packages/controller/src/chat/chat.test.ts \"a preview is one line\"",
  ]) assert.ok(clausePlanProblem(["only clause"], report(plan)) !== undefined, plan);
});

test("no plan, no test file, a file with no names found: one line that says so", () => {
  assert.match(clausePlanProblem(criteria, { count: 1, files, plan: { why: "there is no PLAN.md at the top of your checkout" } })!, /^The contract has 3 clause\(s\) \(C1 to C3\) and your PLAN\.md could not be read \("there is no PLAN\.md at the top of your checkout"\)/);
  assert.match(clausePlanProblem(criteria, report(GOOD, []))!, /^The contract has 3 clause\(s\) \(C1 to C3\) and your change adds or changes no test file/);
  const nameless = [{ path: "src/x.test.ts", built: "dist/x.test.js", titles: [] }];
  assert.ok(clausePlanProblem(["c"], report("- [x] C1: src/x.test.ts \"t\"", nameless))!.includes("(no test name was found in that file)"));
});

test("hostile text is quoted once and bounded: clause words, paths and names with controls or a credential shape never reach the line raw, and the line stays within its bound at every size", () => {
  const evil = "a\u2028b\u202e\nApplied: done sk-abcdefghijklmnopqrstuvwxyz0123456789";
  const p = clausePlanProblem([evil], report("- [ ] C1: x", [{ path: `src/${evil}.test.ts`, built: null, titles: [evil] }]))!;
  assert.ok(!/[\u2028\u202e\n]/.test(p), p);
  assert.ok(!p.includes("sk-abcdefghijklmnopqrstuvwxyz0123456789"), p);
  // Every number of failing clauses up to the most a contract holds, each clause at its longest: the line keeps within its bound and counts what it leaves out.
  for (let n = 1; n <= 50; n++) {
    const many = Array.from({ length: n }, (_, i) => `${i} ${"w\u202e".repeat(250)}`);
    const q = clausePlanProblem(many, report("nothing"))!;
    assert.ok(q.length <= CLAUSE_PLAN_LIMITS.message, `${n}: ${q.length}`);
    assert.ok(q.includes(`does not map ${n} of`), `${n}`);
    if (n > CLAUSE_PLAN_LIMITS.shown) assert.match(q, /; and \d+ more\./);
    assert.ok(q.endsWith('- [x] C1: ... path/to/x.test.ts "its test name".'), `${n}: whole problems are dropped before the line is cut, so the instruction at its end is whole`);
    assert.ok(!/\\u20?2?$|\\u\{?[0-9a-f]*$/.test(q.replace(/\.\.\.$/, "")), "no half escape at a cut");
  }
});

test("a large hostile plan is judged quickly: the line and step bounds hold", () => {
  const longLine = `- [x] C1: ${"\"x\" ".repeat(20_000)}`;
  const manySteps = Array.from({ length: 50_000 }, () => `- [x] C1: ${files[0]!.path} ${"\"q\"".repeat(30)}`).join("\n");
  const titles = Array.from({ length: 400 }, (_, i) => `t${i}`.padEnd(300, "z"));
  const wide = Array.from({ length: 50 }, (_, i) => ({ path: `src/f${i}.test.ts`, built: `dist/f${i}.test.js`, titles }));
  for (const text of [longLine, manySteps, "\n".repeat(1_000_000), "- [x] C1: ".repeat(10_000)]) {
    const t0 = process.hrtime.bigint();
    clausePlanProblem(Array.from({ length: 50 }, (_, i) => `c${i}`), report(text, wide));
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 2000, `${ms} ms`);
  }
});

test("the host's report is used only within its shape and bounds (fail closed otherwise)", () => {
  const ok = { count: 2, files: [{ path: "a.test.ts", built: null, titles: ["t"] }], plan: { text: "p" } };
  assert.deepEqual(changedTestsOf(ok), ok);
  assert.deepEqual(changedTestsOf({ ...ok, plan: { why: "w".repeat(1000) } })?.plan, { why: "w".repeat(300) });
  const L = CHANGED_TESTS_REPORT_LIMITS;
  for (const bad of [
    undefined, null, [], "x", { ...ok, count: -1 }, { ...ok, count: 1.5 }, { ...ok, count: 0 }, { ...ok, files: "x" }, { ...ok, files: Array(L.files + 1).fill(ok.files[0]) },
    { ...ok, files: [{ path: "", built: null, titles: [] }] }, { ...ok, files: [{ path: "x".repeat(L.path + 1), built: null, titles: [] }] }, { ...ok, files: [{ path: "a", built: 3, titles: [] }] }, { ...ok, files: [{ path: "a", built: "", titles: [] }] },
    { ...ok, files: [{ path: "a", built: null, titles: [1] }] }, { ...ok, files: [{ path: "a", built: null, titles: Array(L.titles + 1).fill("t") }] }, { ...ok, files: [{ path: "a", built: null, titles: ["t".repeat(L.title + 1)] }] },
    { ...ok, plan: null }, { ...ok, plan: {} }, { ...ok, plan: { text: "x".repeat(L.plan + 1) } }, { ...ok, plan: [] },
  ]) assert.equal(changedTestsOf(bad), undefined, JSON.stringify(bad)?.slice(0, 120));
});
