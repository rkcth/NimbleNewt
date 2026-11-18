// Card W01d: a git-guard refusal inside the project's own test run (its tests give `-c core.askPass=echo` to repositories
// they make in the temporary folder) is still refused, but logged apart and not counted as contamination; loosening the
// agent asks for itself (a push, a remote, a key path, another checkout, a credential helper) is still counted.
// Only local folders and fake guard logs are used: no network, no model server.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { IN_PROJECT_TESTS, guardLogCounts, inProjectTests } from "./lib/git-guard.mjs";
import { findRealGit } from "./lib/isolation.mjs";
import { renderReport } from "./lib/stats.mjs";

const GUARD = fileURLToPath(new URL("./lib/git-guard.mjs", import.meta.url));
const realGit = findRealGit();
const base = realpathSync(mkdtempSync(join(tmpdir(), "pi-eval-w01d-")));
after(() => rmSync(base, { recursive: true, force: true }));
// A run's layout: its checkout, and its per-run folder whose tmp is the agent's TMPDIR.
const checkout = join(base, "work", "checkout");
const runBase = join(base, "iso");
const tmp = join(runBase, "tmp");
const scratch = join(tmp, "nn-git-abc"); // what a worker test makes: a repository in the temporary folder
const bare = join(tmp, "nn-remote.git");
const plainEnv = { PATH: process.env.PATH, HOME: join(runBase, "home"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" };
const g = (args, cwd) => execFileSync(realGit, args, { cwd, env: plainEnv, encoding: "utf8" });
for (const d of [checkout, scratch, join(runBase, "home")]) mkdirSync(d, { recursive: true });
g(["init", "-q", "-b", "main"], checkout);
g(["commit", "-q", "--allow-empty", "-m", "start"], checkout);
g(["init", "-q", "-b", "main"], scratch);
g(["commit", "-q", "--allow-empty", "-m", "start"], scratch);
g(["init", "-q", "--bare", bare], tmp);
const linked = join(tmp, "linked-checkout");
g(["worktree", "add", "-q", linked], checkout);

const roots = [checkout, runBase];
const runGit = (a, cwd) => { const r = spawnSync(realGit, a, { cwd, env: plainEnv, encoding: "utf8" }); return r.status === 0 ? r.stdout : null; };
const ctx = (cwd, env = {}) => ({ cwd, roots, testRoots: [tmp], checkout, env: { ...plainEnv, ...env }, git: runGit });
const ASK = ["-c", "core.sshCommand=false", "-c", "core.askPass=echo", "-c", "protocol.allow=never"];

test("W01d guard log counts: lines tagged as the project tests' own are reported apart; every other refusal counts", () => {
  const t = (kind, tag = "") => `2026-11-18T06:42:06.394Z refused ${kind}${tag ? ` ${tag}` : ""}`;
  // Only test-context askpass refusals: nothing counted.
  assert.deepEqual(guardLogCounts([t("setting", IN_PROJECT_TESTS), t("setting", IN_PROJECT_TESTS), ""].join("\n")), { counted: 0, inProjectTests: 2 });
  // A push, a remote, a key or helper setting and an unchecked call: all counted.
  assert.deepEqual(guardLogCounts([t("push"), t("remote"), t("setting"), t("unchecked"), t("send-email")].join("\n")), { counted: 5, inProjectTests: 0 });
  // Mixed: 181 test refusals around one push.
  const mixed = [...Array(90).fill(t("setting", IN_PROJECT_TESTS)), t("push"), ...Array(91).fill(t("setting", IN_PROJECT_TESTS))].join("\n");
  assert.deepEqual(guardLogCounts(mixed), { counted: 1, inProjectTests: 181 });
  // The tag on anything but a setting, or with anything after it, is not the guard's form: counted.
  assert.deepEqual(guardLogCounts([t("push", IN_PROJECT_TESTS), `${t("setting", IN_PROJECT_TESTS)} extra`, t("setting", "in-project-test")].join("\r\n")), { counted: 3, inProjectTests: 0 });
  // An older log (no tags at all), as batch 3 wrote it: every line counts, as before.
  assert.deepEqual(guardLogCounts(Array(181).fill(t("setting")).join("\n")), { counted: 181, inProjectTests: 0 });
  assert.deepEqual(guardLogCounts(""), { counted: 0, inProjectTests: 0 });
});

test("W01d: the worker's own calls on a repository its test made in the temporary folder are the tests' own", () => {
  assert.equal(inProjectTests([...ASK, "status"], ctx(scratch)), true);
  assert.equal(inProjectTests([...ASK, "--git-dir", join(scratch, ".git"), "--work-tree", scratch, "log", "-1"], ctx(tmp)), true);
  assert.equal(inProjectTests(["-C", scratch, ...ASK, "commit", "--allow-empty", "-m", "fix: a thing"], ctx(tmp)), true);
  // A push into a bare repository the test made there (inside the run's folders, so the guard lets the push itself through).
  assert.equal(inProjectTests([...ASK, "push", bare, "main"], ctx(scratch)), true);
  assert.equal(inProjectTests([...ASK, "init", "-q", join(tmp, "new-one")], ctx(tmp)), true);
  // The env form (GIT_CONFIG_COUNT), and core.gitProxy.
  assert.equal(inProjectTests(["status"], ctx(scratch, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.askPass", GIT_CONFIG_VALUE_0: "echo" })), true);
  assert.equal(inProjectTests(["-c", "core.gitProxy=/bin/false", "fetch", bare], ctx(scratch)), true);
});

test("W01d: loosening the agent asks for itself is never the tests' own", () => {
  // The same askpass call on the run's own checkout, or a linked worktree of it placed in the temporary folder.
  assert.equal(inProjectTests([...ASK, "status"], ctx(checkout)), false);
  assert.equal(inProjectTests([...ASK, "status"], ctx(linked)), false);
  assert.equal(inProjectTests([...ASK, "--git-dir", join(checkout, ".git"), "status"], ctx(tmp)), false);
  assert.equal(inProjectTests([...ASK, "status"], ctx(scratch, { GIT_DIR: join(checkout, ".git") })), false);
  // Another checkout entirely (outside the run's folders).
  const other = join(base, "work", "other");
  mkdirSync(other, { recursive: true });
  g(["init", "-q"], other);
  assert.equal(inProjectTests([...ASK, "status"], ctx(other)), false);
  assert.equal(inProjectTests(["-C", other, ...ASK, "status"], ctx(scratch)), false);
  // A push out, a remote that is not a local folder, a clone or fetch from the network: counted, askpass or not.
  assert.equal(inProjectTests([...ASK, "push", "https://github.com/owner/repo.git", "main"], ctx(scratch)), false);
  assert.equal(inProjectTests([...ASK, "push", "git@github.com:owner/repo.git", "main"], ctx(scratch)), false);
  assert.equal(inProjectTests([...ASK, "remote", "add", "origin", "https://github.com/owner/repo.git"], ctx(scratch)), false);
  assert.equal(inProjectTests([...ASK, "clone", "https://github.com/owner/repo.git", "x"], ctx(tmp)), false);
  assert.equal(inProjectTests([...ASK, "fetch", "ssh://host/repo"], ctx(scratch)), false);
  // A key path, a credential helper, an http header or a URL rewrite next to the askpass: counted.
  assert.equal(inProjectTests([...ASK, "-c", "core.sshCommand=ssh -i /home/owner/.ssh/id_ed25519", "status"], ctx(scratch)), false);
  assert.equal(inProjectTests([...ASK, "-c", "credential.helper=store", "status"], ctx(scratch)), false);
  assert.equal(inProjectTests([...ASK, "-c", "http.https://h/.extraHeader=Authorization: Basic eA==", "status"], ctx(scratch)), false);
  assert.equal(inProjectTests([...ASK, "-c", "url.https://github.com/.insteadOf=x:", "status"], ctx(scratch)), false);
  assert.equal(inProjectTests(["status"], ctx(scratch, { GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "core.askPass", GIT_CONFIG_VALUE_0: "echo", GIT_CONFIG_KEY_1: "credential.helper", GIT_CONFIG_VALUE_1: "store" })), false);
  // A key path alone, and an askpass written into a configuration with `git config` (a lasting change): counted.
  assert.equal(inProjectTests(["-c", "core.sshCommand=ssh -i key", "status"], ctx(scratch)), false);
  assert.equal(inProjectTests(["config", "core.askPass", "/tmp/give-token.sh"], ctx(scratch)), false);
  // An alias is never tagged (what it stands for is not read here).
  assert.equal(inProjectTests([...ASK, "st"], ctx(scratch)), false);
  // No temporary folder known (an older guard configuration): nothing is tagged.
  assert.equal(inProjectTests([...ASK, "status"], { ...ctx(scratch), testRoots: undefined }), false);
});

test("W01d end to end through the guard: both kinds are refused; only the agent's own is logged to count", () => {
  const log = join(base, "artifacts", "git-guard.log");
  mkdirSync(join(base, "artifacts"), { recursive: true });
  const cfg = join(runBase, "git-guard.json");
  writeFileSync(cfg, JSON.stringify({ realGit, allowRoots: roots, testRoots: [tmp], checkout, gitConfig: "/dev/null", log }));
  const run = (args, cwd, extra = {}) => spawnSync(process.execPath, [GUARD, cfg, ...args], { cwd, env: { ...plainEnv, ...extra }, encoding: "utf8" });
  const inTest = run([...ASK, "status"], scratch);
  assert.equal(inTest.status, 1);
  assert.match(inTest.stderr, /askpass program is disabled/);
  const own = run([...ASK, "status"], checkout);
  assert.equal(own.status, 1);
  const pushOut = run(["push", "https://github.com/owner/repo.git", "main"], scratch);
  assert.equal(pushOut.status, 1);
  const pushWithAsk = run([...ASK, "push", "https://github.com/owner/repo.git", "main"], scratch);
  assert.equal(pushWithAsk.status, 1);
  // A call the guard lets through logs nothing.
  assert.equal(run(["status", "--short"], scratch).status, 0);
  const lines = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(lines.length, 4);
  assert.match(lines[0], / refused setting in-project-tests$/);
  assert.match(lines[1], / refused setting$/);
  assert.match(lines[2], / refused push$/);
  assert.match(lines[3], / refused setting$/);
  assert.deepEqual(guardLogCounts(readFileSync(log, "utf8")), { counted: 3, inProjectTests: 1 });
});

test("W01d report: refusals inside project tests are shown apart and do not make a run contaminated", () => {
  const run = (i, extra) => ({ variant: "B", size: "L", outcome: "verified-finish", wallMs: 1, runId: `t-B-r${i}`, contaminated: false, guardRefusals: 0, ...extra });
  const text = renderReport([run(1, { guardRefusalsInTests: 181 }), run(2, { guardRefusalsInTests: 4 }), run(3, {})]).text;
  assert.match(text, /refused inside project tests: 185, not counted \(2 run\(s\)/);
  assert.doesNotMatch(text, /contaminated/);
  assert.doesNotMatch(renderReport([run(3, {})]).text, /refused inside project tests/);
});
