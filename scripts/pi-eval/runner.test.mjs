// End-to-end tests of the bench runner on a tiny repository, with stub agents in place of Pi. The deliberately broken
// agent (one that stops after its first turn) must be scored stopped early, never finished.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { git, prepareCheckout, runOne, calibrateOne, foreignPaths, killProcessesInSync } from "./lib/runner.mjs";
import { spawn } from "node:child_process";
import { symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { COMPLETION_RULES_PLACEHOLDER, loadCompletionRules, loadTaskset, renderPrompt } from "./lib/taskset.mjs";
import { createHash } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(tmpdir(), "pi-eval-test-"));
const repo = join(root, "repo");
const g = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
let set, base, solution;

before(() => {
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  g("config", "user.name", "t"); g("config", "user.email", "t@t");
  writeFileSync(join(repo, "lib.mjs"), "export const add = (a, b) => 0;\n");
  g("add", "-A"); g("commit", "-q", "-m", "base");
  base = g("rev-parse", "HEAD");
  writeFileSync(join(repo, "lib.mjs"), "export const add = (a, b) => a + b;\n");
  writeFileSync(join(repo, "lib.test.mjs"), "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { add } from './lib.mjs';\ntest('adds', () => assert.equal(add(2, 3), 5));\n");
  g("add", "-A"); g("commit", "-q", "-m", "solution");
  solution = g("rev-parse", "HEAD");
  g("checkout", "-q", "-b", "later"); // the solution is on a branch the checkout must not carry
  const bench = join(root, "bench");
  mkdirSync(join(bench, "tasks"), { recursive: true });
  mkdirSync(join(bench, "prompts"), { recursive: true });
  writeFileSync(join(bench, "tasks", "tiny.md"), "Make add() add.\n");
  writeFileSync(join(bench, "prompts", "a.md"), "Task {{TASK_ID}}:\n{{TASK}}\n");
  writeFileSync(join(bench, "taskset.json"), JSON.stringify({
    agent: { provider: "stub", model: "stub" },
    defaults: { repeats: 1, timeoutMinutes: { S: 1 }, copy: [], setup: null, test: { argv: ["node", "--test", "{{TEST_FILES}}"] } },
    variants: { A: { prompt: "prompts/a.md" }, C: { needs: "W04" } },
    tasks: [{ id: "tiny", size: "S", base, solution, prompt: "tasks/tiny.md", hiddenFiles: ["lib.test.mjs"], testFiles: ["lib.test.mjs"] }],
  }));
  set = loadTaskset(join(bench, "taskset.json"));
  // The honest agent's answer: the fixed file only (never the hidden test).
  mkdirSync(join(root, "answer"));
  writeFileSync(join(root, "answer", "lib.mjs"), "export const add = (a, b) => a + b;\n");
});
after(() => rmSync(root, { recursive: true, force: true }));

const ctx = (mode, extra = {}) => ({
  set, repo, referenceDirs: [repo], depsFrom: repo, workRoot: join(root, "work"), resultsDir: join(root, "results"),
  agent: ["node", join(here, "stub-agent.mjs")], agentLabel: "stub", batchId: "t", benchCommit: "test",
  agentEnv: { STUB_AGENT_MODE: mode, STUB_AGENT_SOLUTION_DIR: join(root, "answer") }, ...extra,
});

test("the agent's checkout holds the base only: no hidden test file and no way to reach the solution commit", async () => {
  const dir = join(root, "probe");
  await prepareCheckout({ repo, commit: base, dir, forbidden: [solution] });
  assert.equal(existsSync(join(dir, "lib.test.mjs")), false);
  assert.notEqual((await git(["-C", dir, "cat-file", "-e", `${solution}^{commit}`])).code, 0);
  assert.equal((await git(["-C", dir, "log", "--all", "--oneline"])).stdout.trim().split("\n").length, 1);
  assert.equal(readFileSync(join(dir, "lib.mjs"), "utf8"), "export const add = (a, b) => 0;\n");
});

test("the deliberately broken agent (stops after its first turn) is scored stopped early, never finished", async () => {
  const r = await runOne(ctx("first-turn"), set.tasks[0], "A", 1);
  assert.equal(r.outcome, "stopped-early", r.reason);
  assert.equal(r.endKind, "announced-step");
  assert.equal(r.hidden.passed, false);
  assert.equal(r.changed, false);
  assert.ok(r.startedAt && r.endedAt && r.wallMs >= 0);
  assert.equal(existsSync(join(root, "work", `eval-${r.runId}`)), false, "the throwaway checkout is removed");
  assert.ok(existsSync(join(r.artifacts, "agent.jsonl")) && existsSync(join(r.artifacts, "hidden-tests.log")));
});

test("a thinking-only ending mid-work is stopped early too", async () => {
  const r = await runOne(ctx("thinking-only"), set.tasks[0], "A", 1);
  assert.equal(r.outcome, "stopped-early", r.reason);
});

test("an agent that says done without doing it is a false done", async () => {
  const r = await runOne(ctx("claims-done"), set.tasks[0], "A", 1);
  assert.equal(r.outcome, "wrong", r.reason);
});

test("an agent that crashes is an error, and one that never ends is stopped at its limit as a timeout", async () => {
  assert.equal((await runOne(ctx("crash"), set.tasks[0], "A", 1)).outcome, "error");
  const r = await runOne(ctx("hang", { timeoutMinutes: 0.02 }), set.tasks[0], "A", 1);
  assert.equal(r.outcome, "timeout", r.reason);
  assert.equal(r.timedOut, true);
});

test("an agent that makes the change and commits it is a verified finish: the hidden tests run on its work and pass", async () => {
  const r = await runOne(ctx("solve"), set.tasks[0], "A", 1);
  assert.equal(r.outcome, "verified-finish", r.reason);
  assert.equal(r.hidden.passed, true);
  assert.equal(r.hidden.tests, 1);
  assert.equal(r.commitsAhead, 1);
  assert.equal(r.contaminated, false);
});

test("calibration: the hidden tests fail at the base and pass at the solution", async () => {
  const c = await calibrateOne(ctx("first-turn"), set.tasks[0]);
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.equal(c.base.passed, false);
  assert.equal(c.solution.passed, true);
});

test("variants that need W04 are refused by the command, not run", () => {
  let code = 0;
  try { execFileSync(process.execPath, [join(here, "run.mjs"), "--taskset", set.file, "--repo", repo, "--variants", "C", "--results", join(root, "r2")], { stdio: "pipe" }); } catch (e) { code = e.status; }
  assert.equal(code, 2);
});

test("a solution that passes the hidden tests but does not build is not a finish", async () => {
  const broken = { ...set.tasks[0], setup: { argv: ["node", "-e", "process.exit(2)"] } };
  const r = await runOne(ctx("solve"), broken, "A", 1);
  assert.equal(r.hidden.built, false);
  assert.equal(r.hidden.passed, false);
  assert.notEqual(r.outcome, "verified-finish");
  assert.equal(r.outcome, "wrong", r.reason);
});

test("a process the agent left running in its checkout is stopped when the agent ends", { skip: process.platform !== "linux" }, async () => {
  const pidFile = join(root, "straggler.pid");
  const r = await runOne(ctx("straggler", { agentEnv: { STUB_AGENT_MODE: "straggler", STUB_AGENT_PID_FILE: pidFile } }), set.tasks[0], "A", 1);
  assert.ok(r.stragglersKilled >= 1, JSON.stringify(r));
  const pid = Number(readFileSync(pidFile, "utf8"));
  let alive = true;
  for (let i = 0; i < 50 && alive; i++) { try { process.kill(pid, 0); await new Promise((res) => setTimeout(res, 20)); } catch { alive = false; } }
  assert.equal(alive, false, "the straggler is gone");
});

test("tool calls that name another checkout, the results or the home directory are flagged; the run's own checkout is not", () => {
  const own = "/srv/code/worktrees-pi/eval-work/eval-x";
  const watched = ["/srv/code/repos/nimblenewt", "/srv/code/repos", "/srv/code/worktrees-pi"];
  const cmd = (command) => JSON.stringify({ command });
  assert.deepEqual(foreignPaths([cmd(`cd ${own} && npx tsc --build`), cmd(`node --import file://${own}/scripts/offline-guard.mjs --test dist/a.test.js`), JSON.stringify({ path: `${own}/packages/x.ts`, content: "import a from '../b/c.js';" })], { ownDir: own, watched }), []);
  assert.deepEqual(foreignPaths([cmd("cat /srv/code/worktrees-pi/c07m/packages/controller/src/x.test.ts")], { ownDir: own, watched }), ["/srv/code/worktrees-pi/c07m/packages/controller/src/x.test.ts"]);
  assert.deepEqual(foreignPaths([JSON.stringify({ path: "/srv/code/repos/nimblenewt/README.md" })], { ownDir: own, watched }), ["/srv/code/repos/nimblenewt/README.md"]);
  assert.deepEqual(foreignPaths([cmd("ls ~/.claude/projects")], { ownDir: own, watched }), [join(homedir(), ".claude/projects")]);
  assert.deepEqual(foreignPaths([cmd("ls /srv")], { ownDir: own, watched }), ["/srv"]);
  assert.deepEqual(foreignPaths([cmd("ls /usr/bin /tmp/x")], { ownDir: own, watched }), []);
});

test("only processes inside the checkout are stopped: not a sibling whose name starts the same, matched through a symlinked root", { skip: process.platform !== "linux" }, async () => {
  const realWork = join(root, "real-work");
  const a = join(realWork, "eval-a"), ab = join(realWork, "eval-ab");
  mkdirSync(join(a, "sub"), { recursive: true }); mkdirSync(ab, { recursive: true });
  const link = join(root, "link-work");
  symlinkSync(realWork, link);
  const sleeper = (cwd) => { const c = spawn("sleep", ["30"], { cwd, stdio: "ignore", detached: true }); c.unref(); return c; };
  const inA = sleeper(join(a, "sub")), inAb = sleeper(ab);
  await new Promise((res) => setTimeout(res, 100));
  try {
    const killed = killProcessesInSync(join(link, "eval-a")); // named through the symlink, as a --work-root may be
    assert.deepEqual(killed, [inA.pid]);
    assert.doesNotThrow(() => process.kill(inAb.pid, 0), "the sibling's process is untouched");
    assert.deepEqual(killProcessesInSync("/"), [], "the filesystem root is never a checkout");
  } finally { try { process.kill(inAb.pid, "SIGKILL"); } catch { /* gone */ } try { process.kill(inA.pid, "SIGKILL"); } catch { /* gone */ } }
});

test("a sibling checkout whose name starts like the run's own is foreign; a variant name that is not a plain name is refused", () => {
  const own = "/srv/code/worktrees-pi/eval-work/eval-x";
  assert.deepEqual(foreignPaths([JSON.stringify({ command: "cat /srv/code/worktrees-pi/eval-work/eval-xy/a.ts" })], { ownDir: own, watched: ["/srv/code/worktrees-pi"] }), ["/srv/code/worktrees-pi/eval-work/eval-xy/a.ts"]);
  const bad = join(root, "bad-taskset.json");
  writeFileSync(bad, readFileSync(set.file, "utf8").replace('"A":', '"../../x":'));
  assert.throws(() => loadTaskset(bad), /variant "..\/..\/x": name must be/);
});

test("leftovers outside the checkout are stopped too: a server a test started in /tmp (it carries the run's mark) and its helper with an emptied environment", { skip: process.platform !== "linux" }, async () => {
  const pidFile = join(root, "outside.pid");
  const r = await runOne(ctx("straggler-outside", { agentEnv: { STUB_AGENT_MODE: "straggler-outside", STUB_AGENT_PID_FILE: pidFile } }), set.tasks[0], "A", 1);
  const pids = readFileSync(pidFile, "utf8").trim().split(" ").map(Number);
  assert.equal(pids.length, 2);
  assert.ok(r.stragglersKilled >= 2, JSON.stringify(r));
  for (const pid of pids) {
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) { try { process.kill(pid, 0); await new Promise((res) => setTimeout(res, 20)); } catch { alive = false; } }
    assert.equal(alive, false, `process ${pid} is gone`);
  }
});

test("killProcessesInSync never stops this process or its parents, even when they carry the run's mark", { skip: process.platform !== "linux" }, async () => {
  const dir = join(root, "marked");
  mkdirSync(dir, { recursive: true });
  // A child started with the mark, from a cwd outside `dir`: it is stopped; this test process (not marked) is not.
  const c = spawn("sleep", ["30"], { cwd: tmpdir(), env: { ...process.env, PI_EVAL_RUN_DIR: dir }, stdio: "ignore", detached: true });
  c.unref();
  await new Promise((res) => setTimeout(res, 100));
  const killed = killProcessesInSync(dir);
  assert.deepEqual(killed, [c.pid]);
  assert.ok(!killed.includes(process.pid) && !killed.includes(process.ppid));
  // A process that itself carries the mark (a bench started from a marked shell) stops its marked child, never itself.
  const runner = new URL("./lib/runner.mjs", import.meta.url).href;
  const script = `import { spawn } from "node:child_process"; import { killProcessesInSync } from ${JSON.stringify(runner)};
const c = spawn("sleep", ["30"], { stdio: "ignore", detached: true }); c.unref();
await new Promise((r) => setTimeout(r, 100));
process.stdout.write(JSON.stringify({ child: c.pid, killed: killProcessesInSync(${JSON.stringify(dir)}) }));`;
  const r = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: tmpdir(), env: { ...process.env, PI_EVAL_RUN_DIR: dir }, encoding: "utf8" }));
  assert.deepEqual(r.killed, [r.child], "the marked process stops its marked child and survives to report it");
});

// An acceptance suite: bench-owned tests at a fresh path, scored instead of the shipped tests, which still run for information.
const accept = (extra = {}) => {
  const bench = join(root, `bench-acc-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(join(bench, "tasks"), { recursive: true });
  mkdirSync(join(bench, "prompts"), { recursive: true });
  mkdirSync(join(bench, "acceptance", "tiny"), { recursive: true });
  writeFileSync(join(bench, "tasks", "tiny.md"), `Make add() add.\n${extra.prompt ?? ""}`);
  writeFileSync(join(bench, "prompts", "a.md"), "Task {{TASK_ID}}:\n{{TASK}}\n");
  writeFileSync(join(bench, "acceptance", "tiny", "w01-acceptance-tiny.test.mjs"), extra.test ?? "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { add } from './lib.mjs';\ntest('adds', () => assert.equal(add(2, 3), 5));\n");
  writeFileSync(join(bench, "acceptance", "tiny", "acceptance.json"), JSON.stringify({ files: { "w01-acceptance-tiny.test.mjs": "w01-acceptance-tiny.test.mjs" }, testFiles: ["w01-acceptance-tiny.test.mjs"], allow: extra.allow ?? {} }));
  writeFileSync(join(bench, "taskset.json"), JSON.stringify({
    agent: { provider: "stub", model: "stub" },
    defaults: { repeats: 1, timeoutMinutes: { S: 1 }, copy: [], setup: extra.setup ?? null, test: { argv: ["node", "--test", "{{TEST_FILES}}"] } },
    variants: { A: { prompt: "prompts/a.md" } },
    tasks: [{ id: "tiny", size: "S", base, solution, prompt: "tasks/tiny.md", hiddenFiles: ["lib.test.mjs"], testFiles: ["lib.test.mjs"] }],
  }));
  return loadTaskset(join(bench, "taskset.json"));
};

test("with an acceptance suite, the run is scored on it and the shipped tests are an informational score beside it", async () => {
  const s = accept();
  assert.equal(s.tasks[0].acceptance.files[0].dest, "w01-acceptance-tiny.test.mjs");
  const r = await runOne(ctx("solve", { set: s }), s.tasks[0], "A", 1);
  assert.equal(r.outcome, "verified-finish", r.reason);
  assert.equal(r.hidden.tests, 1);
  assert.deepEqual({ passed: r.shipped.passed, tests: r.shipped.tests }, { passed: true, tests: 1 });
  assert.ok(existsSync(join(r.artifacts, "hidden-tests.log")) && existsSync(join(r.artifacts, "shipped-tests.log")));
  const stopped = await runOne(ctx("first-turn", { set: s }), s.tasks[0], "A", 1);
  assert.equal(stopped.outcome, "stopped-early");
  assert.equal(stopped.shipped.passed, false);
});

test("calibration of an acceptance suite: base fails, solution passes, and spec fit flags a demand the prompt never states until it is justified", async () => {
  const ok = await calibrateOne(ctx("first-turn", { set: accept() }), accept().tasks[0]);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.suite, "acceptance");
  assert.equal(ok.specFit.ok, true);
  assert.equal(ok.shipped.passed, true);
  const wording = "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { add } from './lib.mjs';\nconst said = 'the sum is ready';\ntest('adds', () => { assert.equal(add(2, 3), 5); assert.match(String(add(1, 1)), /^2$/); assert.doesNotMatch(said, /a sentence nobody wrote down/); });\n";
  const flagged = await calibrateOne(ctx("first-turn"), accept({ test: wording }).tasks[0]);
  assert.equal(flagged.ok, false);
  assert.deepEqual(flagged.specFit.unjustified.map((u) => u.key), ["/a sentence nobody wrote down/"]);
  assert.equal(flagged.base.passed, false);
  assert.equal(flagged.solution.passed, true, "the tests themselves are calibrated: only the spec fit fails");
  const allowed = await calibrateOne(ctx("first-turn"), accept({ test: wording, allow: { "/a sentence nobody wrote down/": "asserted absent, not present" } }).tasks[0]);
  assert.equal(allowed.ok, true, JSON.stringify(allowed.specFit));
  const stated = await calibrateOne(ctx("first-turn"), accept({ test: wording, prompt: "CONTRACT: nothing says a sentence nobody wrote down.\n" }).tasks[0]);
  assert.equal(stated.specFit.flagged, 0);
});

test("an acceptance file must have a fresh w01-acceptance-* name", () => {
  const s = accept();
  const file = s.file;
  const raw = JSON.parse(readFileSync(file, "utf8"));
  raw.tasks[0].acceptance = { files: { "lib.test.mjs": "w01-acceptance-tiny.test.mjs" }, testFiles: ["lib.test.mjs"] };
  raw.tasks[0].acceptance.dir = "acceptance/tiny";
  writeFileSync(file, JSON.stringify(raw));
  assert.throws(() => loadTaskset(file), /must be named w01-acceptance-\*/);
});

test("acceptance tests that do not type-check against the agent's code score a done claim as interface-mismatch, not a false done", async () => {
  // A stand-in for tsc: it reports a type error in the acceptance file only, and exits non-zero.
  const setup = { argv: ["node", "-e", "console.log('w01-acceptance-tiny.test.mjs(3,10): error TS2305: Module has no exported member add.'); process.exit(2)"] };
  const s = accept({ setup });
  const r = await runOne(ctx("claims-done", { set: s }), s.tasks[0], "A", 1);
  assert.equal(r.hidden.interfaceMismatch, true);
  assert.equal(r.outcome, "interface-mismatch", r.reason);
  // An error in the agent's own file is its build failing: a false done.
  const own = accept({ setup: { argv: ["node", "-e", "console.log('lib.mjs(1,1): error TS1005: x'); console.log('w01-acceptance-tiny.test.mjs(3,10): error TS2305: y'); process.exit(2)"] } });
  const w = await runOne(ctx("claims-done", { set: own }), own.tasks[0], "A", 1);
  assert.equal(w.hidden.interfaceMismatch, false);
  assert.equal(w.outcome, "wrong", w.reason);
});

test("a control run: one repeat per task with another agent (--agent, --label) is recorded beside the first and compared per task", async () => {
  const s = accept();
  const results = join(root, "control-results");
  const runCli = (label, mode) => execFileSync(process.execPath, [join(here, "run.mjs"), "--taskset", s.file, "--repo", repo, "--variants", "A", "--repeats", "1", "--agent", join(here, "stub-agent.mjs"), "--label", label, "--results", results, "--work-root", join(root, "control-work"), "--no-report"], { env: { ...process.env, STUB_AGENT_MODE: mode, STUB_AGENT_SOLUTION_DIR: join(root, "answer") }, stdio: "pipe" });
  runCli("pi-stand-in", "first-turn");
  runCli("control-stand-in", "solve");
  const recs = readFileSync(join(results, "results.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(recs.map((r) => [r.agent, r.outcome]), [["pi-stand-in", "stopped-early"], ["control-stand-in", "verified-finish"]]);
  assert.ok(recs.every((r) => r.agentPath.endsWith("stub-agent.mjs")));
  const out = execFileSync(process.execPath, [join(here, "compare.mjs"), "--results", results], { encoding: "utf8" });
  assert.match(out, /\| tiny\s+\| S\s+\| A\s+\| 0\/1 S\s+\| 1\/1 F\s+\|/);
  assert.match(out, /control-stand-in: 1\/1 verified finish, 0 false done, 0 interface mismatch, 0 other; shipped wording \(informational\) 1\/1/);
});

test("W06: a variant whose prompt carries the completion rules gets the worker's words from the built pi-adapter, and the run records which text it was", async () => {
  const { COMPLETION_RULES } = await import(new URL("../../packages/pi-adapter/dist/prompt-layout.js", import.meta.url).href);
  assert.equal(await loadCompletionRules(), COMPLETION_RULES);
  const shipped = loadTaskset(join(here, "taskset.json"));
  for (const v of ["B", "C", "D"]) assert.ok(readFileSync(shipped.variants[v].promptPath, "utf8").includes(COMPLETION_RULES_PLACEHOLDER), `variant ${v} uses the completion rules`);
  assert.ok(!readFileSync(shipped.variants.A.promptPath, "utf8").includes(COMPLETION_RULES_PLACEHOLDER), "variant A stays the plain prompt");
  const task = { id: "t1" };
  const text = renderPrompt(readFileSync(shipped.variants.B.promptPath, "utf8"), { task, taskText: "Do {{COMPLETION_RULES}} nothing.", worktreeUrl: "file:///w", completionRules: COMPLETION_RULES });
  assert.ok(text.includes(COMPLETION_RULES) && text.includes("Do {{COMPLETION_RULES}} nothing."), "the rules go where the template says; the task text is inserted as it is");
  assert.throws(() => renderPrompt("{{COMPLETION_RULES}}", { task, taskText: "x", worktreeUrl: "file:///w" }), /completion rules/);
  // A run of such a variant in the tiny repository records the digest of the rules it was given.
  const bench = dirname(set.variants.A.promptPath);
  writeFileSync(join(bench, "b.md"), "Task {{TASK_ID}}:\n{{TASK}}\n\n{{COMPLETION_RULES}}\n");
  const withB = { ...set, variants: { ...set.variants, B: { prompt: "prompts/b.md", promptPath: join(bench, "b.md") } } };
  const r = await runOne({ ...ctx("solve"), set: withB, completionRules: "RULES TEXT" }, set.tasks[0], "B", 1);
  assert.deepEqual(r.completionRules, { sha256: createHash("sha256").update("RULES TEXT").digest("hex").slice(0, 16), chars: 10 });
  assert.ok(readFileSync(join(r.artifacts, "prompt.md"), "utf8").includes("RULES TEXT"));
  const plain = await runOne(ctx("solve"), set.tasks[0], "A", 1);
  assert.equal(plain.completionRules, undefined, "variant A records none");
});
