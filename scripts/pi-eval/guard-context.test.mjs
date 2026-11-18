// Card W01d: a git-guard refusal inside the project's own test run (its tests give `-c core.askPass=echo` to repositories
// they make in the temporary folder) is still refused, but logged apart and not counted as contamination; loosening the
// agent asks for itself (a push, a remote, a key path, another checkout, a credential helper) is still counted.
// Only local folders and fake guard logs are used: no network, no model server.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { GONE_FOLDER, IN_PROJECT_TESTS, decide, envConfigs, goneFolderTests, guardLogCounts, inProjectTests, lastKnownFolder } from "./lib/git-guard.mjs";
import { REFUSED_ADDRESS, findRealGit, gitConfigText } from "./lib/isolation.mjs";
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
// An askpass program other than `echo` (which the guard lets through since the W01d review): still refused, and tagged.
const ASK = ["-c", "core.sshCommand=false", "-c", "core.askPass=./no-prompt.sh", "-c", "protocol.allow=never"];

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
  assert.equal(inProjectTests(["status"], ctx(scratch, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.askPass", GIT_CONFIG_VALUE_0: "./no-prompt.sh" })), true);
  assert.equal(inProjectTests(["-c", "core.gitProxy=/bin/false", "fetch", "--no-recurse-submodules", bare], ctx(scratch)), true);
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
  assert.equal(inProjectTests(["status"], ctx(scratch, { GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "core.askPass", GIT_CONFIG_VALUE_0: "./no-prompt.sh", GIT_CONFIG_KEY_1: "credential.helper", GIT_CONFIG_VALUE_1: "store" })), false);
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

test("W01d review: core.askPass=echo exactly is let through (the worker's own setting); any other askpass is still refused", () => {
  const c = { cwd: scratch, roots, env: plainEnv, git: (a) => runGit(a, scratch) };
  assert.equal(decide(["-c", "core.askPass=echo", "status"], c).refuse, null);
  assert.equal(decide(["-c", "core.askpass=echo", "-c", "core.sshCommand=false", "-c", "protocol.allow=never", "log", "-1"], c).refuse, null);
  assert.equal(decide(["status"], { ...c, env: { ...plainEnv, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.askPass", GIT_CONFIG_VALUE_0: "echo" } }).refuse, null);
  for (const v of ["/bin/echo", "echo token", "ECHO", " echo", "echo ", "", "./echo", "sh -c echo"]) {
    assert.match(decide(["-c", `core.askPass=${v}`, "status"], c).refuse ?? "", /askpass program is disabled/, v);
  }
  // A proxy program is still refused, echo or not; askpass=echo next to a credential helper is still refused.
  assert.match(decide(["-c", "core.gitProxy=echo", "status"], c).refuse ?? "", /disabled/);
  assert.match(decide(["-c", "core.askPass=echo", "-c", "credential.helper=store", "status"], c).refuse ?? "", /credential/);
  // Through the wrapper itself: the worker's whole flag set on a scratch repository runs and logs nothing.
  const log = join(base, "artifacts-echo", "git-guard.log");
  mkdirSync(join(base, "artifacts-echo"), { recursive: true });
  const cfg = join(runBase, "git-guard-echo.json");
  writeFileSync(cfg, JSON.stringify({ realGit, allowRoots: roots, testRoots: [tmp], checkout, gitConfig: "/dev/null", log }));
  const worker = ["-c", "core.hooksPath=/nonexistent", "-c", "core.sshCommand=false", "-c", "core.askPass=echo", "-c", "protocol.allow=never", "-c", "protocol.file.allow=never", "-c", "safe.directory=*"];
  const r = spawnSync(process.execPath, [GUARD, cfg, ...worker, "log", "-1", "--format=%s"], { cwd: scratch, env: plainEnv, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "start");
  assert.throws(() => readFileSync(log, "utf8"));
});

test("W01d review: a call that can reach a network address through the repository or an scp-style argument is never tagged", () => {
  const net = join(tmp, "nn-net");
  mkdirSync(net, { recursive: true });
  g(["init", "-q", "-b", "main"], net);
  // A network remote written into the configuration file directly (no `git remote add`, so the guard never saw it).
  writeFileSync(join(net, ".git", "config"), readFileSync(join(net, ".git", "config"), "utf8") + '[remote "origin"]\n\turl = https://github.com/owner/repo.git\n');
  for (const sub of [["fetch", "origin"], ["fetch"], ["pull"], ["ls-remote", "origin"], ["remote", "update"], ["status"]]) {
    assert.equal(inProjectTests([...ASK, ...sub], ctx(net)), false, sub.join(" "));
  }
  // A branch whose remote is an address of its own, and a URL rewrite in the configuration.
  const br = join(tmp, "nn-branch");
  mkdirSync(br, { recursive: true });
  g(["init", "-q", "-b", "main"], br);
  writeFileSync(join(br, ".git", "config"), readFileSync(join(br, ".git", "config"), "utf8") + '[branch "main"]\n\tremote = git@github.com:owner/repo.git\n');
  assert.equal(inProjectTests([...ASK, "fetch"], ctx(br)), false);
  assert.equal(inProjectTests([...ASK, "-c", "branch.main.remote=https://github.com/o/r", "status"], ctx(scratch)), false);
  const rw = join(tmp, "nn-rewrite");
  mkdirSync(rw, { recursive: true });
  g(["init", "-q", "-b", "main"], rw);
  writeFileSync(join(rw, ".git", "config"), readFileSync(join(rw, ".git", "config"), "utf8") + '[url "https://github.com/"]\n\tinsteadOf = local/\n');
  assert.equal(inProjectTests([...ASK, "fetch", "local/repo"], ctx(rw)), false);
  // An ssh address without a user (`host:path`), an address after an option's `=`, archive --remote and submodules.
  assert.equal(inProjectTests([...ASK, "clone", "github.com:owner/repo.git", "x"], ctx(tmp)), false);
  assert.equal(inProjectTests([...ASK, "fetch", "github.com:owner/repo.git"], ctx(scratch)), false);
  assert.equal(inProjectTests([...ASK, "clone", "--reference=https://h/r", bare, "y"], ctx(tmp)), false);
  assert.equal(inProjectTests([...ASK, "archive", "--remote=" + bare, "HEAD"], ctx(scratch)), false);
  assert.equal(inProjectTests([...ASK, "submodule", "update", "--init"], ctx(scratch)), false);
  // Local remotes and local arguments stay tagged: a repository with a remote that is a bare repository in the temporary folder.
  const loc = join(tmp, "nn-local");
  mkdirSync(loc, { recursive: true });
  g(["init", "-q", "-b", "main"], loc);
  g(["remote", "add", "origin", bare], loc);
  g(["config", "branch.main.remote", "origin"], loc);
  assert.equal(inProjectTests([...ASK, "-c", "submodule.recurse=false", "fetch", "origin"], ctx(loc)), true);
  assert.equal(inProjectTests([...ASK, "fetch", "--no-recurse-submodules"], ctx(loc)), true);
  assert.equal(inProjectTests([...ASK, "clone", "-q", bare, join(tmp, "nn-clone")], ctx(tmp)), true);
  assert.equal(inProjectTests([...ASK, "commit", "-m", "fix: a thing"], ctx(loc)), true);
});

test("W01d review: GIT_CONFIG_PARAMETERS is read as git reads it, quotes included", () => {
  assert.deepEqual(envConfigs({ GIT_CONFIG_PARAMETERS: "'core.editor'='x'\\''y' 'credential.helper'='store'" }), [["core.editor", "x'y"], ["credential.helper", "store"]]);
  assert.deepEqual(envConfigs({ GIT_CONFIG_PARAMETERS: "'a.b'='c'\\!'d' 'credential.helper=store'  'x.y'=" }), [["a.b", "c!d"], ["credential.helper", "store"], ["x.y", "true"]]);
  assert.deepEqual(envConfigs({ GIT_CONFIG_PARAMETERS: "'protocol.https.allow'='always'" }), [["protocol.https.allow", "always"]]);
  assert.deepEqual(envConfigs({ GIT_CONFIG_PARAMETERS: "" }), []);
  // A setting after a quoted quote is now seen, and refused.
  const c = { cwd: scratch, roots, env: { ...plainEnv, GIT_CONFIG_PARAMETERS: "'core.editor'='x'\\''y' 'credential.helper'='store'" }, git: (a) => runGit(a, scratch) };
  assert.match(decide(["status"], c).refuse ?? "", /credential/);
  // What the real git reads from the same text (so the reading above is git's own).
  const r = spawnSync(realGit, ["config", "--get", "credential.helper"], { cwd: scratch, env: c.env, encoding: "utf8" });
  assert.equal(r.stdout.trim(), "store");
});

test("W01d review: the worker's local clone (-c protocol.allow=user with protocol.file.allow=always) is refused and tagged; elsewhere or with a network address it counts", () => {
  const LOCAL = ["-c", "core.sshCommand=false", "-c", "core.askPass=echo", "-c", "protocol.allow=user", "-c", "protocol.file.allow=always"];
  const c = { cwd: tmp, roots, env: plainEnv, git: (a) => runGit(a, tmp) };
  assert.match(decide([...LOCAL, "clone", "-q", "--bare", bare, join(tmp, "nn-c1")], c).refuse ?? "", /allowed protocols/);
  assert.equal(inProjectTests([...LOCAL, "clone", "-q", "--bare", bare, join(tmp, "nn-c1")], ctx(tmp)), true);
  assert.equal(inProjectTests([...LOCAL, "--git-dir", join(scratch, ".git"), "fetch", "--no-recurse-submodules", bare, "main"], ctx(tmp)), true);
  // A network address, the run's checkout, another protocol key next to it: counted.
  assert.equal(inProjectTests([...LOCAL, "clone", "https://github.com/owner/repo.git", join(tmp, "nn-c2")], ctx(tmp)), false);
  assert.equal(inProjectTests([...LOCAL, "clone", "github.com:owner/repo.git", join(tmp, "nn-c3")], ctx(tmp)), false);
  assert.equal(inProjectTests([...LOCAL, "fetch", bare], ctx(checkout)), false);
  assert.equal(inProjectTests([...LOCAL, "-c", "protocol.https.allow=always", "fetch", bare], ctx(scratch)), false);
  assert.equal(inProjectTests(["-c", "protocol.allow=always", "-c", "credential.helper=store", "fetch", bare], ctx(scratch)), false);
});

test("W01d second review: --config-env is split at its last `=` as git splits it, so a network remote given that way is refused", () => {
  const c = { cwd: scratch, roots, env: { ...plainEnv, V: "https://example.invalid/r.git" }, git: (a) => runGit(a, scratch) };
  assert.match(decide(["--config-env=remote.a=b.url=V", "fetch", "a=b"], c).refuse ?? "", /not a local folder/);
  assert.match(decide(["--config-env", "remote.a=b.url=V", "fetch", "a=b"], c).refuse ?? "", /not a local folder/);
  // What the real git reads from the same option (so the split above is git's own).
  const r = spawnSync(realGit, ["--config-env=remote.a=b.url=V", "config", "--get-regexp", "^remote\\."], { cwd: scratch, env: c.env, encoding: "utf8" });
  assert.equal(r.stdout.trim(), "remote.a=b.url https://example.invalid/r.git");
  // The plain form still works, and an askpass given this way is still tagged.
  assert.equal(decide(["--config-env=core.editor=V", "status"], c).refuse, null);
  assert.equal(inProjectTests(["--config-env=core.askPass=V", "status"], ctx(scratch, { V: "./no-prompt.sh" })), true);
});

test("W01d second review: a call that may reach submodules, the run's checkout or another checkout is never tagged", () => {
  const other = join(base, "work", "other2");
  mkdirSync(other, { recursive: true });
  g(["init", "-q", "-b", "main"], other);
  g(["commit", "-q", "--allow-empty", "-m", "o"], other);
  const s2 = join(tmp, "nn-s2");
  mkdirSync(s2, { recursive: true });
  g(["init", "-q", "-b", "main"], s2);
  // A local source or destination that is the checkout or another checkout (outside the temporary folder).
  assert.equal(inProjectTests([...ASK, "fetch", checkout], ctx(s2)), false);
  assert.equal(inProjectTests([...ASK, "fetch", other], ctx(s2)), false);
  assert.equal(inProjectTests([...ASK, "clone", other, join(tmp, "nn-o")], ctx(tmp)), false);
  assert.equal(inProjectTests([...ASK, "clone", bare, join(base, "elsewhere")], ctx(tmp)), false);
  assert.equal(inProjectTests([...ASK, "clone", "--reference=" + checkout, bare, join(tmp, "nn-r")], ctx(tmp)), false);
  g(["remote", "add", "up", other], s2);
  assert.equal(inProjectTests([...ASK, "fetch", "up"], ctx(s2)), false);
  assert.equal(inProjectTests([...ASK, "-c", "remote.x.url=" + checkout, "fetch", "x"], ctx(scratch)), false);
  // Submodules: their addresses are not read, so a recursing option, a submodule setting or checked-out modules count.
  assert.equal(inProjectTests([...ASK, "clone", "--recurse-submodules", bare, join(tmp, "nn-rs")], ctx(tmp)), false);
  assert.equal(inProjectTests([...ASK, "-c", "submodule.recurse=true", "fetch", bare], ctx(scratch)), false);
  assert.equal(inProjectTests([...ASK, "-c", "fetch.recurseSubmodules=on-demand", "fetch", bare], ctx(scratch)), false);
  const sm = join(tmp, "nn-sm");
  mkdirSync(sm, { recursive: true });
  g(["init", "-q", "-b", "main"], sm);
  writeFileSync(join(sm, ".git", "config"), readFileSync(join(sm, ".git", "config"), "utf8") + '[submodule "m"]\n\turl = https://example.invalid/m.git\n\tactive = true\n');
  assert.equal(inProjectTests([...ASK, "fetch", bare], ctx(sm)), false);
  const mods = join(tmp, "nn-mods");
  mkdirSync(join(mods), { recursive: true });
  g(["init", "-q", "-b", "main"], mods);
  mkdirSync(join(mods, ".git", "modules", "m"), { recursive: true });
  assert.equal(inProjectTests([...ASK, "fetch", bare], ctx(mods)), false);
  // The worker's own form stays tagged: --no-recurse-submodules, a local repository and a commit in the temporary folder.
  assert.equal(inProjectTests([...ASK, "fetch", "--no-tags", "--no-recurse-submodules", bare, "main"], ctx(scratch)), true);
  assert.equal(inProjectTests([...ASK, "fetch", "--no-tags", "--no-recurse-submodules", "--", bare, "main"], ctx(scratch)), true);
});

test("W01d second review: the worker's -c submodule.recurse=false does not stop the tag; turned on, it does", () => {
  assert.equal(inProjectTests([...ASK, "-c", "submodule.recurse=false", "fetch", "--no-recurse-submodules", bare, "main"], ctx(scratch)), true);
  assert.equal(inProjectTests([...ASK, "-c", "fetch.recurseSubmodules=no", "status"], ctx(scratch)), true);
  assert.equal(inProjectTests([...ASK, "-c", "submodule.recurse=1", "status"], ctx(scratch)), false);
  assert.equal(inProjectTests([...ASK, "-c", "submodule.m.url=" + bare, "status"], ctx(scratch)), false);
});

test("W01d final check: an abbreviated recursing option, or a fetch or pull that may recurse on demand, is not tagged", () => {
  // git takes any unambiguous abbreviation of a long option; a later one overrides --no-recurse-submodules.
  assert.equal(inProjectTests([...ASK, "fetch", "--no-recurse-submodules", "--recurse-sub", bare, "main"], ctx(scratch)), false);
  assert.equal(inProjectTests([...ASK, "clone", "--recurs", bare, join(tmp, "nn-ab")], ctx(tmp)), false);
  // fetch and pull default to on-demand recursion (a populated submodule with its own .git folder leaves no modules/ folder).
  assert.equal(inProjectTests([...ASK, "fetch", bare, "main"], ctx(scratch)), false);
  assert.equal(inProjectTests([...ASK, "pull", bare, "main"], ctx(scratch)), false);
  assert.equal(inProjectTests([...ASK, "-c", "push.recurseSubmodules=no", "fetch", bare, "main"], ctx(scratch)), false);
  // Turned off, as the worker does (either form), they stay tagged; the worker's exact flag set too.
  assert.equal(inProjectTests([...ASK, "-c", "submodule.recurse=false", "fetch", bare, "main"], ctx(scratch)), true);
  assert.equal(inProjectTests([...ASK, "-c", "fetch.recurseSubmodules=false", "pull", bare, "main"], ctx(scratch)), true);
  assert.equal(inProjectTests([...ASK, "fetch", "--no-recurse-submodules", bare, "main"], ctx(scratch)), true);
  const WORKER = ["-c", "core.sshCommand=false", "-c", "core.askPass=echo", "-c", "protocol.allow=user", "-c", "protocol.file.allow=always", "-c", "submodule.recurse=false"];
  assert.equal(inProjectTests([...WORKER, "--git-dir", join(scratch, ".git"), "fetch", "--no-tags", "--no-recurse-submodules", bare, "main"], ctx(tmp)), true);
  // --config-env split at its last =: a key holding = in its subsection is read whole (and a network remote there is refused).
  const ce = { cwd: scratch, roots, env: { ...plainEnv, NNU: "https://example.invalid/r.git" }, git: (a) => runGit(a, scratch) };
  assert.match(decide(["--config-env=remote.a=b.url=NNU", "status"], ce).refuse ?? "", /remote address/);
  assert.match(decide(["--config-env", "remote.a=b.url=NNU", "status"], ce).refuse ?? "", /remote address/);
});

test("W01d final re-check: --no-recurse-submodules taken as another option's value, or after --, does not turn recursion off", () => {
  // -o/--server-option and pull's -X take the next argument as their value; after -- it is a refspec.
  assert.equal(inProjectTests([...ASK, "fetch", "-o", "--no-recurse-submodules", bare, "main"], ctx(scratch)), false);
  assert.equal(inProjectTests([...ASK, "fetch", "--server-option", "--no-recurse-submodules", bare, "main"], ctx(scratch)), false);
  assert.equal(inProjectTests([...ASK, "pull", "-X", "--no-recurse-submodules", bare, "main"], ctx(scratch)), false);
  assert.equal(inProjectTests([...ASK, "fetch", bare, "--", "--no-recurse-submodules"], ctx(scratch)), false);
  // As its own option: after a positional or a known valueless option, and before -- (the worker's restore form).
  assert.equal(inProjectTests([...ASK, "fetch", "-q", "--no-recurse-submodules", bare, "main"], ctx(scratch)), true);
  assert.equal(inProjectTests([...ASK, "fetch", bare, "--no-recurse-submodules", "main"], ctx(scratch)), true);
  assert.equal(inProjectTests([...ASK, "fetch", "--no-tags", "--no-recurse-submodules", "--", bare, "main"], ctx(scratch)), true);
});

test("W01d final re-check: under the bench's own git settings (a GitHub rewrite to the refused address) the worker's calls stay tagged", () => {
  // The guard sets GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM to these settings on every call of a real run.
  const benchCfg = join(base, "bench-gitconfig");
  writeFileSync(benchCfg, gitConfigText());
  const benchEnv = { ...plainEnv, GIT_CONFIG_GLOBAL: benchCfg, GIT_CONFIG_SYSTEM: benchCfg };
  delete benchEnv.GIT_CONFIG_NOSYSTEM;
  const bc = (cwd) => ({ cwd, roots, testRoots: [tmp], checkout, env: benchEnv, git: (a, c) => { const r = spawnSync(realGit, a, { cwd: c, env: benchEnv, encoding: "utf8" }); return r.status === 0 ? r.stdout : null; } });
  assert.match(runGit(["--version"], tmp) ?? "", /git version/);
  assert.match(spawnSync(realGit, ["config", "--get-regexp", "^url\\."], { cwd: scratch, env: benchEnv, encoding: "utf8" }).stdout, /pushing-is-disabled/);
  const WORKER = ["-c", "core.sshCommand=false", "-c", "core.askPass=echo", "-c", "protocol.allow=user", "-c", "protocol.file.allow=always", "-c", "submodule.recurse=false"];
  assert.equal(inProjectTests([...WORKER, "--git-dir", join(scratch, ".git"), "fetch", "--no-tags", "--no-recurse-submodules", bare, "main"], bc(tmp)), true);
  assert.equal(inProjectTests([...ASK, "fetch", "--no-recurse-submodules", bare, "main"], bc(scratch)), true);
  assert.equal(inProjectTests([...ASK, "status"], bc(scratch)), true);
  // Any other rewrite, or another setting under the refused address's section, is still not tagged.
  assert.equal(inProjectTests([...ASK, "-c", `url.https://example.invalid/.insteadOf=${bare}`, "fetch", "--no-recurse-submodules", bare, "main"], bc(scratch)), false);
  assert.equal(inProjectTests([...ASK, "-c", `url.${REFUSED_ADDRESS}.other=x`, "status"], bc(scratch)), false);
});

// W01d follow-up: a worker test removes its temporary folder while one of its git calls starts; process.cwd() then throws.
// The call is refused (kind gone-folder); it is tagged only when PWD and every folder it names are gone, in the temporary
// folder, outside the checkout, and the rest of the tag conditions hold. Any other call from a gone folder is counted.
test("W01d follow-up: a call from a folder that no longer exists is refused; tagged only inside the temporary folder", () => {
  const log = join(base, "artifacts-gone", "git-guard.log");
  mkdirSync(join(base, "artifacts-gone"), { recursive: true });
  const cfg = join(runBase, "git-guard-gone.json");
  writeFileSync(cfg, JSON.stringify({ realGit, allowRoots: roots, testRoots: [tmp], checkout, gitConfig: "/dev/null", log }));
  // The shell enters the folder, removes it, then runs the guard there (PWD is the shell's, unless `pwd` overrides it).
  let n = 0;
  const fromGone = (parent, args, { pwd, make = true } = {}) => {
    const dir = join(parent, `gone-${n++}`);
    if (make) mkdirSync(dir, { recursive: true });
    const setPwd = pwd === undefined ? "" : pwd === null ? "unset PWD; " : `export PWD='${pwd}'; `;
    const r = spawnSync("/bin/sh", ["-c", `cd "$1" && rmdir "$1" && shift && ${setPwd}exec "$0" "$@"`, process.execPath, dir, GUARD, cfg, ...args], { cwd: base, env: plainEnv, encoding: "utf8" });
    const lines = readFileSync(log, "utf8").trim().split("\n");
    return { ...r, line: lines[lines.length - 1], lines: lines.length };
  };
  const WORKER = ["-c", "core.sshCommand=false", "-c", "core.askPass=echo", "-c", "protocol.allow=never", "-c", "submodule.recurse=false"];
  const goneRepo = join(tmp, "nn-lws-gone", "shared", ".git");
  // The replayed case: the worker's flags, a git folder that was removed with the test's folder.
  let r = fromGone(tmp, ["--git-dir", goneRepo, ...WORKER, "rev-parse", "--verify", "HEAD^{commit}"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /folder no longer exists/);
  assert.match(r.line, / refused gone-folder in-project-tests$/);
  // A refused askpass program from a gone folder in the temporary folder: tagged the same way.
  assert.match(fromGone(tmp, [...ASK, "status"]).line, / refused gone-folder in-project-tests$/);
  // Outside the temporary folder (the run's own folder, the checkout): counted.
  assert.match(fromGone(runBase, ["--git-dir", goneRepo, ...WORKER, "status"]).line, / refused gone-folder$/);
  assert.match(fromGone(checkout, [...WORKER, "status"]).line, / refused gone-folder$/);
  // A folder it names that still exists (a repository is there to act on): counted.
  assert.match(fromGone(tmp, ["--git-dir", join(scratch, ".git"), ...WORKER, "status"]).line, / refused gone-folder$/);
  assert.match(fromGone(tmp, ["-C", scratch, ...WORKER, "status"]).line, / refused gone-folder$/);
  if (existsSync("/proc/self/cwd")) {
    // Linux: the system's record of the folder decides, whatever PWD says (unset, or a gone folder in the temporary folder).
    assert.match(fromGone(tmp, [...WORKER, "status"], { pwd: null }).line, / refused gone-folder in-project-tests$/);
    assert.match(fromGone(runBase, [...WORKER, "status"], { pwd: join(tmp, "gone-elsewhere") }).line, / refused gone-folder$/);
  } else {
    // Without /proc, PWD unset, relative, still existing, or naming a gone folder outside the temporary folder: counted.
    assert.match(fromGone(tmp, [...WORKER, "status"], { pwd: null }).line, / refused gone-folder$/);
    assert.match(fromGone(tmp, [...WORKER, "status"], { pwd: "tmp/x" }).line, / refused gone-folder$/);
    assert.match(fromGone(tmp, [...WORKER, "status"], { pwd: scratch }).line, / refused gone-folder$/);
    assert.match(fromGone(tmp, [...WORKER, "status"], { pwd: join(runBase, "gone-elsewhere") }).line, / refused gone-folder$/);
  }
  // Any other tag condition failing: a network address, another refused setting, an alias, recursion: counted.
  assert.match(fromGone(tmp, [...WORKER, "push", "https://github.com/owner/repo.git", "main"]).line, / refused gone-folder$/);
  assert.match(fromGone(tmp, [...WORKER, "-c", "credential.helper=store", "status"]).line, / refused gone-folder$/);
  assert.match(fromGone(tmp, [...WORKER, "st"]).line, / refused gone-folder$/);
  assert.match(fromGone(tmp, [...WORKER, "fetch", "--recurse-submodules", bare]).line, / refused gone-folder$/);
  assert.match(fromGone(tmp, [...WORKER, "submodule", "update"]).line, / refused gone-folder$/);
  r = fromGone(tmp, [...WORKER, "fetch", "--no-recurse-submodules", join(runBase, "gone-remote.git")]);
  assert.match(r.line, / refused gone-folder$/);
  const text = readFileSync(log, "utf8");
  const tagged = existsSync("/proc/self/cwd") ? 3 : 2;
  assert.deepEqual(guardLogCounts(text), { counted: r.lines - tagged, inProjectTests: tagged });
});

test("W01d follow-up: goneFolderTests and the log form of a gone-folder refusal", () => {
  const c = { roots, testRoots: [tmp], checkout, env: plainEnv, git: runGit };
  const gonePwd = join(tmp, "nn-gone-unit");
  assert.equal(goneFolderTests(["status"], { ...c, pwd: gonePwd }), true);
  assert.equal(goneFolderTests(["status"], { ...c, pwd: gonePwd, testRoots: undefined }), false);
  assert.equal(goneFolderTests(["status"], { ...c, pwd: undefined }), false);
  assert.equal(goneFolderTests(["status"], { ...c, pwd: scratch }), false); // still exists
  assert.equal(goneFolderTests(["status"], { ...c, pwd: join(checkout, "gone") }), false); // the checkout
  assert.equal(goneFolderTests(["-C", "..", "status"], { ...c, pwd: gonePwd }), false); // -C leads to the existing tmp
  assert.equal(goneFolderTests(["status"], { ...c, pwd: gonePwd, env: { ...plainEnv, GIT_DIR: join(scratch, ".git") } }), false);
  // A `..` after a link into the checkout: resolve() reads a gone folder in tmp, the system the checkout (follow-up check).
  mkdirSync(join(checkout, "w01d-sub"), { recursive: true });
  const intoCheckout = join(tmp, "nn-link-into-checkout");
  symlinkSync(join(checkout, "w01d-sub"), intoCheckout);
  assert.equal(goneFolderTests(["-C", `${intoCheckout}/../nn-not-in-tmp`, "push"], { ...c, pwd: gonePwd }), false);
  assert.equal(goneFolderTests(["fetch", "--no-recurse-submodules", `${intoCheckout}/..`], { ...c, pwd: gonePwd }), false);
  assert.equal(goneFolderTests(["fetch", "--no-recurse-submodules", `file://${intoCheckout}/%2e%2e`], { ...c, pwd: gonePwd }), false);
  assert.equal(goneFolderTests(["status"], { ...c, pwd: `${tmp}/x/../nn-gone-unit` }), false);
  assert.equal(goneFolderTests(["status"], { ...c, pwd: gonePwd, env: { ...plainEnv, GIT_DIR: `${intoCheckout}/../.git` } }), false);
  assert.equal(goneFolderTests(["log", "HEAD..main"], { ...c, pwd: gonePwd }), true); // a revision range is not a path
  assert.equal(GONE_FOLDER, "gone-folder");
  // The last known folder: the system's record when it names a removed folder; PWD only where there is no record.
  const links = join(base, "proc-links");
  mkdirSync(links, { recursive: true });
  symlinkSync(`${gonePwd} (deleted)`, join(links, "deleted"));
  symlinkSync(scratch, join(links, "present"));
  assert.equal(lastKnownFolder({ PWD: "/elsewhere" }, join(links, "deleted")), gonePwd);
  assert.equal(lastKnownFolder({ PWD: "/elsewhere" }, join(links, "present")), null);
  assert.equal(lastKnownFolder({ PWD: "/elsewhere" }, join(links, "none")), "/elsewhere");
  assert.equal(lastKnownFolder({}, join(links, "none")), null);
  const t = (kind, tag = "") => `2026-11-18T06:42:06.394Z refused ${kind}${tag ? ` ${tag}` : ""}`;
  assert.deepEqual(guardLogCounts([t(GONE_FOLDER, IN_PROJECT_TESTS), t(GONE_FOLDER), t("unchecked"), t("gone-folders", IN_PROJECT_TESTS)].join("\n")), { counted: 3, inProjectTests: 1 });
});
