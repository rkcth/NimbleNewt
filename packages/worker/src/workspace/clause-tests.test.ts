import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitBridge, LocalWorkspaces } from "./index.js";
import { CLAUSE_TEST_LIMITS, builtCandidate, cutWhole, isTestFile, runnableName, testTitles } from "./clause-tests.js";

// Card W09 second slice: the host side of the done check of the tests an agent's change adds or changes.
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = hasGit ? false : "git is not installed";
const sh = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "core.hooksPath=/nonexistent-hooks", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

test("which paths are test files: *.test.* and *.spec.* with a JavaScript or TypeScript extension, never a declaration file or a near name", () => {
  for (const yes of ["a.test.ts", "src/a.test.ts", "pkg/src/deep/x.spec.mts", "x.test.js", "x.test.mjs", "x.test.cjs", "x.test.cts", "x.spec.tsx", "x.test.jsx"]) assert.equal(isTestFile(yes), true, yes);
  for (const no of ["a.ts", "test.ts", "a.test.d.ts", "a.test.d.mts", "a.tests.ts", "a.test.json", "a.test.ts.bak", "a.test.py", "dir.test.ts/x.ts", "a.testts", `${"d/".repeat(600)}a.test.ts`]) assert.equal(isTestFile(no), false, no);
});

test("the built file a test runs from: a JavaScript test itself, a TypeScript one under the nearest src/ from dist/, none without src/", () => {
  assert.equal(builtCandidate("packages/controller/src/chat/x.test.ts"), "packages/controller/dist/chat/x.test.js");
  assert.equal(builtCandidate("src/x.test.mts"), "dist/x.test.mjs");
  assert.equal(builtCandidate("a/src/b/src/c.test.cts"), "a/src/b/dist/c.test.cjs", "the nearest src/");
  assert.equal(builtCandidate("src/x.spec.tsx"), "dist/x.spec.js");
  assert.equal(builtCandidate("scripts/x.test.mjs"), "scripts/x.test.mjs");
  assert.equal(builtCandidate("lib/x.test.ts"), undefined, "no src/: no rule says where it is built");
  assert.equal(builtCandidate("src"), undefined);
  assert.equal(builtCandidate("x.test.py"), undefined);
});

test("first review: a path a test runner would read as an option or a pattern has no built file, so it is never appended to the check's command", () => {
  for (const no of ["--test-name-pattern=zzz.test.js", "-x.test.js", "--x/src/a.test.ts", "-/a.test.mjs", "g/[x].test.js", "g/*.test.js", "g/?.test.js", "g/{a,b}.test.js", "g/!(a).test.js", "g/@(a).test.js", "g/a\\b.test.js", "src/{a}.test.ts"]) {
    assert.equal(builtCandidate(no), undefined, no);
    assert.equal(runnableName(no), false, no);
  }
  for (const yes of ["a/--b.test.js", "a/-b.test.js", "a b/c d.test.js", "a/b-c.test.js", "src/x.test.ts", "a/b=c.test.js", "a/b,c.test.js", "a/'q'.test.js", "a/b+c.test.js"]) assert.equal(runnableName(yes), true, yes);
  assert.equal(builtCandidate("a/--b.test.js"), "a/--b.test.js", "a dash after a folder is a path to node --test, not an option");
});

test("first review: a skipped or todo test declares no name a clause can be mapped to (.skip, .todo, an options object that skips it) or a call on a line that starts as a comment; one whose option is off counts", () => {
  const text = [
    `test.skip("skipped", () => {}); it.todo("later"); describe.skip("whole group", () => {});`,
    `test("opt skip", { skip: true }, () => {}); test('opt todo', { todo: "soon" }, () => {}); it("opt quoted", { "skip": 1 }, () => {});`,
    `test("skip reason", { timeout: 10, skip: "not on this host" }, () => {});`,
    `test("off", { skip: false }, () => {}); test("off too", { todo: 0, skip: undefined }, () => {}); test("empty reason", { skip: "" }, () => {});`,
    `test("only kept", { only: true }, () => {}); test("a timeout", { timeout: 5 }, () => {}); test("named skipper", { skipper: true }, () => {});`,
    `test("skipped", () => {});`,
    `// test("commented out", () => {});`,
    `  /* it("in a block comment", () => {}); */`,
    `   * test("in a doc comment", () => {});`,
    `\r// test("after a carriage return", () => {});`,
    `const u = "a"; test("after code on the line", () => {});`,
  ].join("\n");
  assert.deepEqual(testTitles(text), ["off", "off too", "empty reason", "only kept", "a timeout", "named skipper", "skipped", "after code on the line"]);
  assert.deepEqual(testTitles(`// test("first line, commented", () => {});\ntest("kept", () => {});`), ["kept"], "a comment on the first line");
  assert.deepEqual(testTitles(`${"x".repeat(300)} // test("far along a long line", () => {});`), ["far along a long line"], "a long line's start is not looked at (bounded)");
  // Bounded on hostile text: many calls with long option objects, none closed; and many calls on one long line.
  for (const hostile of [`test("a", {${" skip".repeat(60)}`.repeat(Math.ceil((1024 * 1024) / 320)), `${" ".repeat(150)}test("a")`.repeat(Math.ceil((1024 * 1024) / 160))]) {
    const t0 = performance.now();
    testTitles(hostile);
    assert.ok(performance.now() - t0 < 2000, `${Math.round(performance.now() - t0)} ms`);
  }
});

test("test names as written: test, it, describe, suite (and .only; not .skip or .todo), in three quote styles, no repeats, in order; not a method or a near name", () => {
  const text = [
    `test("a long name is cut between whole characters and whole escapes", () => {});`,
    `  it('says \\'no\\' plainly', async () => {});`,
    "describe(`a template ${x} name`, () => {});",
    `suite.only("only one", () => {}); test.skip("skipped", () => {}); test.todo("later");`,
    `test("a long name is cut between whole characters and whole escapes", () => {});`,
    `obj.test("not a test call"); contest("no"); attest("no"); $test("no"); testing("no");`,
    `test(name, () => {}); test(\`\`, () => {});`,
  ].join("\n");
  assert.deepEqual(testTitles(text), ["a long name is cut between whole characters and whole escapes", "says \\'no\\' plainly", "a template ${x} name", "only one"]);
});

test("test names are bounded: at most the limit, each cut between whole characters (a surrogate pair is never split)", () => {
  const many = Array.from({ length: CLAUSE_TEST_LIMITS.titles + 50 }, (_, i) => `test("t${i}", () => {});`).join("\n");
  assert.equal(testTitles(many).length, CLAUSE_TEST_LIMITS.titles);
  for (let pad = 0; pad < 4; pad++) {
    const long = `${"a".repeat(CLAUSE_TEST_LIMITS.title - 2 + pad)}${"\u{1F600}".repeat(10)}`;
    const [t] = testTitles(`test("${long}", () => {});`);
    assert.ok(t!.length <= CLAUSE_TEST_LIMITS.title, `${t!.length}`);
    assert.ok(!/[\uD800-\uDBFF]$/.test(t!), "no half pair at the end");
    assert.ok(long.startsWith(t!));
  }
  // Every cut offset across the limit, for a run of pairs.
  for (let max = 1; max < 12; max++) {
    const c = cutWhole("\u{1F600}".repeat(5), max);
    assert.ok(c.length <= max && c.length % 2 === 0, `${max}: ${c.length}`);
  }
  assert.equal(cutWhole("abc", 3), "abc");
});

test("test names from hostile text stay fast: a megabyte of unclosed quotes, escapes and open calls", () => {
  for (const unit of ['test("', "test('\\", "test(`", 'it("\\\\', "describe(`\\`"]) {
    const text = unit.repeat(Math.floor(CLAUSE_TEST_LIMITS.fileBytes / unit.length));
    const t0 = process.hrtime.bigint();
    testTitles(text);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 3000, `${JSON.stringify(unit)}: ${ms} ms`);
  }
});

async function world() {
  const dir = await mkdtemp(join(tmpdir(), "nn-clause-"));
  const shared = join(dir, "shared");
  await mkdir(join(shared, "src"), { recursive: true });
  sh(dir, "init", "-q", "-b", "main", shared);
  await writeFile(join(shared, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(join(shared, "src", "old.test.ts"), `test("old one", () => {});\n`);
  await writeFile(join(shared, "src", "gone.test.ts"), `test("gone", () => {});\n`);
  await writeFile(join(shared, ".gitignore"), "dist/\n");
  sh(shared, "add", "-A"); sh(shared, "commit", "-q", "-m", "first");
  const git = await GitBridge.create({ scratch: join(dir, "scratch") });
  const ws = new LocalWorkspaces({ root: join(dir, "work"), git, shared: (p) => (p === "prj-one" ? shared : undefined), busy: () => [], landing: () => ({ branch: "main", requirePermit: false }), clock: () => "2026-10-31T10:00:00.000Z" });
  return { dir, ws, done: async () => { try { execFileSync("chmod", ["-R", "u+rwX", dir]); } catch { /* nothing */ } await rm(dir, { recursive: true, force: true }); } };
}

test("changedTests lists the test files the change adds or changes (not deleted, not unchanged, not ignored), their names, the built file found in the checkout, and PLAN.md", { skip }, async () => {
  const w = await world();
  try {
    const scope = { taskId: "tsk-one", projectId: "prj-one" };
    assert.equal(await w.ws.changedTests(scope), undefined, "no checkout: nothing to say");
    const made = await w.ws.ensure(scope);
    assert.deepEqual(await w.ws.changedTests(scope), { count: 0, files: [], plan: { why: "there is no PLAN.md at the top of your checkout (or an ignore rule hides it)" } });
    const c = made.checkout;
    await writeFile(join(c, "src", "new.test.ts"), `test("a new one", () => {});\nit("and another", () => {});\n`);
    await writeFile(join(c, "src", "old.test.ts"), `test("old one", () => {});\ntest("old one, wider", () => {});\n`);
    await rm(join(c, "src", "gone.test.ts"));
    await writeFile(join(c, "src", "a.ts"), "export const a = 2;\n");
    await mkdir(join(c, "scripts"));
    await writeFile(join(c, "scripts", "x.test.mjs"), `test("plain js", () => {});\n`);
    await writeFile(join(c, "PLAN.md"), "- [x] C1: src/new.test.ts \"a new one\"\n");
    // Only the new test is built so far; the old one's built file is a link, which does not count.
    await mkdir(join(c, "dist"));
    await writeFile(join(c, "dist", "new.test.js"), "built\n");
    await symlink(join(c, "dist", "new.test.js"), join(c, "dist", "old.test.js"));
    const got = await w.ws.changedTests(scope);
    assert.deepEqual(got, {
      count: 3,
      files: [
        { path: "scripts/x.test.mjs", built: "scripts/x.test.mjs", titles: ["plain js"] },
        { path: "src/new.test.ts", built: "dist/new.test.js", titles: ["a new one", "and another"] },
        { path: "src/old.test.ts", built: null, titles: ["old one", "old one, wider"] },
      ],
      plan: { text: "- [x] C1: src/new.test.ts \"a new one\"\n" },
    });
    // A plan in another letter case is the same file; two of them, a folder or a large one is not read.
    await rm(join(c, "PLAN.md"));
    await writeFile(join(c, "plan.md"), "lower\n");
    assert.deepEqual((await w.ws.changedTests(scope))?.plan, { text: "lower\n" });
    await writeFile(join(c, "Plan.MD"), "other\n");
    const two = (await w.ws.changedTests(scope))?.plan;
    // A case-insensitive disk keeps one file; a case-sensitive one has two.
    assert.ok("why" in two! ? /more than one/.test(two.why) : true, JSON.stringify(two));
    await rm(join(c, "Plan.MD"), { force: true });
    await rm(join(c, "plan.md"), { force: true });
    await writeFile(join(c, "PLAN.md"), "x".repeat(CLAUSE_TEST_LIMITS.planBytes + 1));
    assert.deepEqual((await w.ws.changedTests(scope))?.plan, { why: `PLAN.md is larger than ${CLAUSE_TEST_LIMITS.planBytes} bytes` });
    await rm(join(c, "PLAN.md"));
    await mkdir(join(c, "PLAN.md"));
    await writeFile(join(c, "PLAN.md", "x"), "y");
    assert.deepEqual((await w.ws.changedTests(scope))?.plan, { why: "PLAN.md is not a plain file" });
    // A test file that is a link gives no names (its target is never read) and a large one gives none either.
    await symlink("/etc/hostname", join(c, "src", "link.test.ts"));
    await writeFile(join(c, "src", "big.test.ts"), `test("too big", () => {});\n${" ".repeat(CLAUSE_TEST_LIMITS.fileBytes)}`);
    const odd = await w.ws.changedTests(scope);
    assert.deepEqual(odd?.files.filter((f) => f.path === "src/link.test.ts" || f.path === "src/big.test.ts"), [{ path: "src/big.test.ts", built: null, titles: [] }, { path: "src/link.test.ts", built: null, titles: [] }]);
    // First review: a link whose target text reads as a test call gives no names either (the link's blob is its target, never read as a file).
    await symlink(`test("named in a link target", () => {})`, join(c, "src", "target.test.ts"));
    assert.deepEqual((await w.ws.changedTests(scope))?.files.find((f) => f.path === "src/target.test.ts"), { path: "src/target.test.ts", built: null, titles: [] });
    // First review: a test file whose name a runner reads as an option or a pattern is listed but has no built file (it is never appended), and a passing file the pattern would pick is not run in its place.
    await writeFile(join(c, "--test-name-pattern=zzz.test.js"), `test("hides the rest", () => {});\n`);
    await mkdir(join(c, "g"));
    await writeFile(join(c, "g", "[x].test.js"), `test("the real one", () => {});\n`);
    await writeFile(join(c, "g", "x.test.js"), `test("a stand-in", () => {});\n`);
    const named = await w.ws.changedTests(scope);
    assert.deepEqual(named?.files.filter((f) => !f.path.startsWith("src/") && !f.path.startsWith("scripts/")), [
      { path: "--test-name-pattern=zzz.test.js", built: null, titles: ["hides the rest"] },
      { path: "g/[x].test.js", built: null, titles: ["the real one"] },
      { path: "g/x.test.js", built: "g/x.test.js", titles: ["a stand-in"] },
    ]);
    // Reading changes nothing in the checkout.
    assert.equal(execFileSync("git", ["--git-dir", made.gitDir, "--work-tree", c, "status", "--porcelain", "--", "src/a.ts"], { encoding: "utf8" }).trim(), "M src/a.ts");
  } finally { await w.done(); }
});

test("changedTests lists a test file the change moves as added at its new path (second review: read as a rename, it would be neither added nor modified and never run)", { skip }, async () => {
  const w = await world();
  try {
    const scope = { taskId: "tsk-moved", projectId: "prj-one" };
    const made = await w.ws.ensure(scope);
    const c = made.checkout;
    await rename(join(c, "src", "gone.test.ts"), join(c, "src", "moved.test.ts"));
    const got = await w.ws.changedTests(scope);
    assert.deepEqual(got?.files.map((f) => ({ path: f.path, titles: f.titles })), [{ path: "src/moved.test.ts", titles: ["gone"] }]);
    assert.equal(got?.count, 1);
  } finally { await w.done(); }
});

test("changedTests lists at most the limit, in path order, and counts all of them", { skip }, async () => {
  const w = await world();
  try {
    const scope = { taskId: "tsk-many", projectId: "prj-one" };
    const made = await w.ws.ensure(scope);
    const n = CLAUSE_TEST_LIMITS.files + 3;
    for (let i = 0; i < n; i++) await writeFile(join(made.checkout, "src", `t${String(i).padStart(3, "0")}.test.ts`), `test("t${i}", () => {});\n`);
    const got = await w.ws.changedTests(scope);
    assert.equal(got?.count, n);
    assert.equal(got?.files.length, CLAUSE_TEST_LIMITS.files);
    assert.equal(got?.files[0]?.path, "src/t000.test.ts");
  } finally { await w.done(); }
});
