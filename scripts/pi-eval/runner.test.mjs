// End-to-end tests of the bench runner on a tiny repository, with stub agents in place of Pi. The deliberately broken
// agent (one that stops after its first turn) must be scored stopped early, never finished.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { git, prepareCheckout, runOne, calibrateOne } from "./lib/runner.mjs";
import { loadTaskset } from "./lib/taskset.mjs";

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
