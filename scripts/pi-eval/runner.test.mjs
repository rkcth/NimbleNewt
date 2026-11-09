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
