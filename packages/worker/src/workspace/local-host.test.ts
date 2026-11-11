import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitBridge, LocalWorkspaces, type HostWorkspaceCall } from "./index.js";
import { PLAN_FILE } from "@nimblenewt/contracts";

// Card H12q: the production workspace port of a local host: one layout for the attempt's checkout and the operations on it.
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = hasGit ? false : "git is not installed";
const sh = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "core.hooksPath=/nonexistent-hooks", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
let counter = 0;
const rid = (): string => `wsr-${"abcdefghijklmnop"}${"abcdefghijklmnopqrstuvwxyz".slice(counter, counter++ + 4)}`;
const call = (operation: HostWorkspaceCall["operation"], more: Partial<HostWorkspaceCall> = {}): HostWorkspaceCall => ({ requestId: rid(), operation, taskId: "tsk-one", projectId: "prj-one", reason: "test", quietAttempts: [], ...more });

async function world(busy: () => readonly string[] = () => []) {
  const dir = await mkdtemp(join(tmpdir(), "nn-lws-"));
  const shared = join(dir, "shared");
  await mkdir(join(shared, "src"), { recursive: true });
  sh(dir, "init", "-q", "-b", "main", shared);
  await writeFile(join(shared, "src", "a.ts"), "export const a = 1;\n");
  sh(shared, "add", "-A"); sh(shared, "commit", "-q", "-m", "first");
  const git = await GitBridge.create({ scratch: join(dir, "scratch") });
  const root = join(dir, "work");
  const ws = new LocalWorkspaces({ root, git, shared: (p) => (p === "prj-one" ? shared : undefined), busy, landing: () => ({ branch: "main", requirePermit: false }), clock: () => "2026-10-31T10:00:00.000Z" });
  return { dir, shared, root, git, ws, done: async () => { try { execFileSync("chmod", ["-R", "u+rwX", dir]); } catch { /* nothing */ } await rm(dir, { recursive: true, force: true }); } };
}

test("the checkout an attempt works in is the one the operations find: one layout, made once, never over a kept git directory", { skip }, async () => {
  const w = await world();
  try {
    assert.equal(w.ws.locate({ taskId: "tsk-one", projectId: "prj-one" }), undefined, "nothing made yet");
    const made = await w.ws.ensure({ taskId: "tsk-one", projectId: "prj-one" });
    assert.equal(made.checkout, join(w.root, "prj-one", "tsk-one", "checkout"));
    assert.equal(await readFile(join(made.checkout, "src", "a.ts"), "utf8"), "export const a = 1;\n");
    assert.equal(existsSync(join(made.checkout, ".git")), false, "the checkout has no .git of its own");
    const where = w.ws.locate({ taskId: "tsk-one", projectId: "prj-one" })!;
    assert.deepEqual([where.checkout, where.gitDir, where.shared], [made.checkout, made.gitDir, w.shared]);
    // A second attempt of the task gets the same checkout, with the first one's work in it.
    await writeFile(join(made.checkout, "src", "a.ts"), "export const a = 2;\n");
    assert.deepEqual(await w.ws.ensure({ taskId: "tsk-one", projectId: "prj-one" }), made);
    assert.equal(await readFile(join(made.checkout, "src", "a.ts"), "utf8"), "export const a = 2;\n");
    // No shared repository for the project, and names that could reach a path: nothing is made.
    await assert.rejects(w.ws.ensure({ taskId: "tsk-one", projectId: "prj-two" }), /no shared repository/);
    for (const bad of [{ taskId: "../x", projectId: "prj-one" }, { taskId: "a..b", projectId: "prj-one" }, { taskId: "tsk-one", projectId: "a/b" }, { taskId: "..", projectId: "prj-one" }]) {
      await assert.rejects(w.ws.ensure(bad), /plain name/, JSON.stringify(bad));
      assert.equal(w.ws.locate(bad), undefined);
    }
    assert.deepEqual((await readdir(w.root)).sort(), [".making", "prj-one"]);
    assert.deepEqual(await readdir(join(w.root, ".making")), [], "nothing is left over from the making");
  } finally { await w.done(); }
});

test("the port answers refresh, landing and quarantine of that checkout, and a quarantined checkout is not made again (card H12q)", { skip }, async () => {
  const w = await world();
  try {
    const made = await w.ws.ensure({ taskId: "tsk-one", projectId: "prj-one" });
    const git = ["--git-dir", made.gitDir, "--work-tree", made.checkout];
    await writeFile(join(made.checkout, "src", "a.ts"), "export const a = 2;\n");
    sh(made.checkout, ...git, "add", "-A"); sh(made.checkout, ...git, "commit", "-q", "-m", "work");
    const landed = await w.ws.port.run(call("landing"));
    assert.equal(landed.ok, true, JSON.stringify(landed));
    assert.equal(await readFile(join(w.shared, "src", "a.ts"), "utf8"), "export const a = 2;\n");
    await writeFile(join(made.checkout, "src", "a.ts"), "export const a = 3; // unsaved\n");
    const quarantined = await w.ws.port.run(call("quarantine"));
    assert.equal(quarantined.ok, true, JSON.stringify(quarantined));
    assert.equal(existsSync(made.checkout), false);
    assert.equal(existsSync(made.gitDir), true);
    await assert.rejects(w.ws.ensure({ taskId: "tsk-one", projectId: "prj-one" }), /quarantined; it is not made again/);
    const gone = await w.ws.port.run(call("refresh"));
    assert.equal(gone.ok, false);
    // A task this host never made, and a project it holds nothing for.
    assert.match((await w.ws.port.run(call("refresh", { taskId: "tsk-two" }) )as { reason: string }).reason, /not on this host/);
    assert.match((await w.ws.port.run(call("refresh", { projectId: "prj-two" })) as { reason: string }).reason, /not on this host/);
  } finally { await w.done(); }
});

test("a request is not carried out while an attempt it names has a call in flight on this host, and nothing is journaled for it (card H12q)", { skip }, async () => {
  let busy: string[] = ["att-1"];
  const w = await world(() => busy);
  try {
    const made = await w.ws.ensure({ taskId: "tsk-one", projectId: "prj-one" });
    await writeFile(join(made.checkout, "src", "new.ts"), "export const n = 1;\n");
    const before = sh(w.shared, "status", "--porcelain=v1");
    const refused = await w.ws.port.run(call("integration", { quietAttempts: ["att-1", "att-2"] }));
    assert.equal(refused.ok, false);
    assert.match((refused as { reason: string }).reason, /an attempt of the task is running on this host/);
    assert.equal(sh(w.shared, "status", "--porcelain=v1"), before);
    assert.equal(existsSync(join(w.root, "journal")), false, "refused before it began: no journal");
    // Another attempt being busy does not matter; the named ones are quiet now.
    busy = ["att-9"];
    assert.equal((await w.ws.port.run(call("integration", { quietAttempts: ["att-1", "att-2"] }))).ok, true);
    // A host that cannot tell which attempts are busy does not guess.
    const failing = new LocalWorkspaces({ root: w.root, git: w.git, shared: () => w.shared, busy: () => { throw new Error("cannot tell"); } });
    assert.equal((await failing.port.run(call("integration", { quietAttempts: ["att-1"] }))).ok, false);
  } finally { await w.done(); }
});

test("the workspace root must be an absolute, normalised path", () => {
  assert.throws(() => new LocalWorkspaces({ root: "relative/work", git: undefined as never, shared: () => undefined, busy: () => [] }), /absolute/);
});

test("a checkout half made by a crash is never used, and two callers asking at once get one checkout (card H12q review)", { skip }, async () => {
  const w = await world();
  try {
    // A crash between the making of the git directory and the filling of the checkout: the git bridge does the first step and then fails.
    const crashing = { head: (shared: string) => w.git.head(shared), createCheckout: async (o: { gitDir: string; checkout: string }) => { await mkdir(o.gitDir, { recursive: true }); await mkdir(o.checkout, { recursive: true }); throw new Error("power cut"); } } as unknown as GitBridge;
    const broken = new LocalWorkspaces({ root: w.root, git: crashing, shared: () => w.shared, busy: () => [] });
    await assert.rejects(broken.ensure({ taskId: "tsk-one", projectId: "prj-one" }), /power cut/);
    assert.equal(broken.locate({ taskId: "tsk-one", projectId: "prj-one" }), undefined, "nothing that looks like a checkout was left");
    assert.equal(existsSync(join(w.root, "prj-one", "tsk-one")), false);
    // A folder without the completion mark (made by an older crash) is refused, not adopted.
    await mkdir(join(w.root, "prj-one", "tsk-half", "task.git"), { recursive: true });
    await assert.rejects(w.ws.ensure({ taskId: "tsk-half", projectId: "prj-one" }), /never finished/);
    assert.equal(w.ws.locate({ taskId: "tsk-half", projectId: "prj-one" }), undefined);
    // Concurrent asks (the same process, and a second host object over the same folders) end with one complete checkout.
    const other = new LocalWorkspaces({ root: w.root, git: w.git, shared: () => w.shared, busy: () => [] });
    const made = await Promise.all([w.ws.ensure({ taskId: "tsk-one", projectId: "prj-one" }), w.ws.ensure({ taskId: "tsk-one", projectId: "prj-one" }), other.ensure({ taskId: "tsk-one", projectId: "prj-one" })]);
    assert.deepEqual([made[1], made[2]], [made[0], made[0]]);
    assert.equal(await readFile(join(made[0]!.checkout, "src", "a.ts"), "utf8"), "export const a = 1;\n");
    assert.equal(existsSync(join(w.root, "prj-one", "tsk-one", "complete")), true);
  } finally { await w.done(); }
});

test("two tasks of a project share the bridge's state, and names that differ only in case or form are not two tasks (card H12q review)", { skip }, async () => {
  const w = await world();
  try {
    await w.ws.ensure({ taskId: "tsk-one", projectId: "prj-one" });
    await w.ws.ensure({ taskId: "tsk-two", projectId: "prj-one" });
    assert.equal(w.ws.locate({ taskId: "tsk-one", projectId: "prj-one" })!.bridgeState, w.ws.locate({ taskId: "tsk-two", projectId: "prj-one" })!.bridgeState, "one state per shared tree");
    await assert.rejects(w.ws.ensure({ taskId: "TSK-ONE", projectId: "prj-one" }), /differs only in case/);
    assert.equal(w.ws.locate({ taskId: "TSK-ONE", projectId: "prj-one" }), undefined);
    for (const bad of ["tsk:one", "tsk-one.", "CON"]) await assert.rejects(w.ws.ensure({ taskId: bad, projectId: "prj-one" }), /plain name/, bad);
    await assert.rejects(w.ws.ensure({ taskId: "tsk-x", projectId: "journal" }), /plain name/, "a project cannot take the name of the host's own folders");
  } finally { await w.done(); }
});

test("the bridge state of a shared tree is the same whichever spelling of its path names it (a link to it, a trailing slash), so one tree has one lock (card H12q re-review)", { skip: process.platform === "win32" ? "POSIX links" : skip }, async () => {
  const w = await world();
  try {
    const { symlink } = await import("node:fs/promises");
    const link = join(w.dir, "shared-link");
    await symlink(w.shared, link);
    const root = join(w.dir, "work2");
    const viaLink = new LocalWorkspaces({ root, git: w.git, shared: (p) => (p === "prj-one" ? link : undefined), busy: () => [], landing: () => ({ branch: "main", requirePermit: false }) });
    const direct = new LocalWorkspaces({ root, git: w.git, shared: (p) => (p === "prj-one" ? `${w.shared}/` : undefined), busy: () => [], landing: () => ({ branch: "main", requirePermit: false }) });
    await viaLink.ensure({ taskId: "tsk-one", projectId: "prj-one" });
    await direct.ensure({ taskId: "tsk-two", projectId: "prj-one" });
    const a = viaLink.locate({ taskId: "tsk-one", projectId: "prj-one" })!;
    const b = direct.locate({ taskId: "tsk-two", projectId: "prj-one" })!;
    assert.equal(a.bridgeState, b.bridgeState);
  } finally { await w.done(); }
});

// Card W03: what an attempt's checkout holds, for the blocker of an agent that kept stopping early: its plan's checked and unchecked steps and the diff stat against the base. Read only; what cannot be read is left out.
test("progress reads the plan's checkbox steps and the diff stat of the checkout, and leaves out what it cannot read (card W03)", { skip }, async () => {
  const w = await world();
  try {
    assert.equal(await w.ws.progress({ taskId: "tsk-one", projectId: "prj-one" }), undefined, "no checkout yet: nothing to say");
    const made = await w.ws.ensure({ taskId: "tsk-one", projectId: "prj-one" });
    assert.deepEqual(await w.ws.progress({ taskId: "tsk-one", projectId: "prj-one" }), { diffStat: "no changes against the task's base; 0 commit(s) ahead of the base" }, "no PLAN.md: the plan is left out");
    await writeFile(join(made.checkout, "PLAN.md"), "# Plan\r\n\n- [x] read the code\n- [ ] fix the parser\n  * [X] nested and done\n1. [ ] run the tests\n- plain line\n- [] not a box\n");
    await writeFile(join(made.checkout, "src", "a.ts"), "export const a = 1;\nexport const b = 2;\n");
    const before = execFileSync("git", ["--git-dir", made.gitDir, "--work-tree", made.checkout, "status", "--porcelain"], { encoding: "utf8" });
    const got = await w.ws.progress({ taskId: "tsk-one", projectId: "prj-one" });
    assert.deepEqual(got?.plan, { done: ["read the code", "nested and done"], open: ["fix the parser", "run the tests"] });
    assert.equal(got?.diffStat, "2 files changed, 9 insertions(+) against the task's base; 0 commit(s) ahead of the base");
    // Card W08: asked for the plan alone (at every completed turn), it makes no diff stat.
    assert.deepEqual(await w.ws.progress({ taskId: "tsk-one", projectId: "prj-one", planOnly: true }), { plan: got?.plan });
    assert.equal(execFileSync("git", ["--git-dir", made.gitDir, "--work-tree", made.checkout, "status", "--porcelain"], { encoding: "utf8" }), before, "reading changes nothing in the checkout's index");
    // A commit in the checkout counts as ahead.
    execFileSync("git", ["--git-dir", made.gitDir, "--work-tree", made.checkout, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=/nonexistent-hooks", "-c", "commit.gpgsign=false", "add", "-A"]);
    execFileSync("git", ["--git-dir", made.gitDir, "--work-tree", made.checkout, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=/nonexistent-hooks", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "step"]);
    assert.match((await w.ws.progress({ taskId: "tsk-one", projectId: "prj-one" }))?.diffStat ?? "", /; 1 commit\(s\) ahead of the base$/);
    // A plan that is too big, or a directory by that name, is not read.
    await writeFile(join(made.checkout, "PLAN.md"), `- [ ] x\n${"a".repeat(256 * 1024)}`);
    assert.equal((await w.ws.progress({ taskId: "tsk-one", projectId: "prj-one" }))?.plan, undefined);
    await rm(join(made.checkout, "PLAN.md"));
    await mkdir(join(made.checkout, "PLAN.md"));
    assert.equal((await w.ws.progress({ taskId: "tsk-one", projectId: "prj-one" }))?.plan, undefined);
  } finally { await w.done(); }
});

test("a plan that is a link is not followed (card W03)", { skip: skip !== false ? skip : process.platform === "win32" ? "links need privileges on Windows" : false }, async () => {
  const w = await world();
  try {
    const made = await w.ws.ensure({ taskId: "tsk-one", projectId: "prj-one" });
    await writeFile(join(w.dir, "outside.md"), "- [ ] secret step\n");
    execFileSync("ln", ["-s", join(w.dir, "outside.md"), join(made.checkout, "PLAN.md")]);
    assert.equal((await w.ws.progress({ taskId: "tsk-one", projectId: "prj-one" }))?.plan, undefined);
  } finally { await w.done(); }
});

test("a plan swapped for a pipe or a device is not read and does not hang the read (card W03 review)", { skip: skip !== false ? skip : process.platform === "win32" ? "no named pipes in the file system on Windows" : false }, async () => {
  const { readPlan } = await import("./index.js");
  const dir = await mkdtemp(join(tmpdir(), "nn-plan-"));
  try {
    execFileSync("mkfifo", [join(dir, "PLAN.md")]);
    const started = Date.now();
    assert.equal(await readPlan(join(dir, "PLAN.md")), undefined);
    assert.ok(Date.now() - started < 5000, "the pipe was not waited on");
    assert.equal(await readPlan("/dev/null"), undefined, "not a plain file");
    await writeFile(join(dir, "ok.md"), "- [ ] one\n- [x] two\n");
    assert.deepEqual(await readPlan(join(dir, "ok.md")), { done: ["two"], open: ["one"] });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the diff stat runs no filter, diff driver or hook the agent's checkout names (card W03 review)", { skip }, async () => {
  const w = await world();
  try {
    const made = await w.ws.ensure({ taskId: "tsk-one", projectId: "prj-one" });
    const marker = join(w.dir, "ran");
    // The checkout is the agent's: it can name drivers in .gitattributes and plant a .git of its own with their commands, which is never read (the repository is outside the checkout and named explicitly).
    await writeFile(join(made.checkout, ".gitattributes"), "* filter=evil diff=evil\n");
    await mkdir(join(made.checkout, ".git", "hooks"), { recursive: true });
    const touch = `touch ${JSON.stringify(marker)}; cat`;
    await writeFile(join(made.checkout, ".git", "config"), `[core]\n\tfsmonitor = ${touch}\n\thooksPath = .git/hooks\n[filter "evil"]\n\tclean = ${touch}\n[diff "evil"]\n\ttextconv = ${touch}\n\tcommand = ${touch}\n`);
    await writeFile(join(made.checkout, "src", "a.ts"), "export const a = 3;\n");
    const got = await w.ws.progress({ taskId: "tsk-one", projectId: "prj-one" });
    assert.match(got?.diffStat ?? "", /files? changed/);
    assert.equal(existsSync(marker), false);
  } finally { await w.done(); }
});

test("doneState says what is not committed, the commits and changes ahead of the base, and whether each evidence path is a plain, non-empty file of the checkout as it stands (card W05)", { skip }, async () => {
  const w = await world();
  try {
    const scope = { taskId: "tsk-one", projectId: "prj-one" };
    assert.equal(await w.ws.doneState(scope, []), undefined, "no checkout: nothing to say");
    const made = await w.ws.ensure(scope);
    const g = (...args: string[]): string => execFileSync("git", ["--git-dir", made.gitDir, "--work-tree", made.checkout, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=/nonexistent-hooks", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
    assert.deepEqual(await w.ws.doneState(scope, []), { uncommitted: [], uncommittedCount: 0, ahead: 0, changed: 0, evidence: [], agentCommits: false }, "a fresh checkout: clean, nothing ahead; the agent cannot commit in this layout");
    await writeFile(join(made.checkout, "src", "a.ts"), "export const a = 2;\n");
    await mkdir(join(made.checkout, "logs"));
    await writeFile(join(made.checkout, "logs", "test.txt"), "12 passed\n");
    await writeFile(join(made.checkout, ".gitignore"), "build/\n");
    await mkdir(join(made.checkout, "build"));
    await writeFile(join(made.checkout, "build", "out.js"), "ignored\n");
    await symlink("/etc/hostname", join(made.checkout, "logs", "link.txt"));
    const before = g("status", "--porcelain");
    const dirty = await w.ws.doneState(scope, ["logs/test.txt", "build/out.js", "logs/link.txt"]);
    assert.deepEqual(dirty?.uncommitted.slice().sort(), [".gitignore", "logs/link.txt", "logs/test.txt", "src/a.ts"], "changed and new files count; an ignored one does not");
    assert.deepEqual([dirty?.uncommittedCount, dirty?.ahead, dirty?.changed], [4, 0, 4]);
    // The agent cannot commit here: what its checkout holds (not ignored) is its work, and its evidence. A link (even to a file outside the checkout) is not a file.
    assert.deepEqual(dirty?.evidence, [{ path: "logs/test.txt", present: true }, { path: "build/out.js", present: false, why: "not in the checkout (or ignored)" }, { path: "logs/link.txt", present: false, why: "not a plain file" }]);
    await rm(join(made.checkout, "logs", "link.txt"));
    assert.equal(g("status", "--porcelain"), before, "reading changes nothing in the checkout's index");
    await writeFile(join(made.checkout, "empty.txt"), "");
    await writeFile(join(made.checkout, "*"), "a star\n");
    g("add", "-A"); g("commit", "-q", "-m", "work");
    const clean = await w.ws.doneState(scope, ["logs/test.txt", "empty.txt", "logs", "missing.txt", "*", "src/*.ts"]);
    assert.deepEqual([clean?.uncommittedCount, clean?.ahead, clean?.changed], [0, 1, 5]);
    assert.deepEqual(clean?.evidence, [
      { path: "logs/test.txt", present: true },
      { path: "empty.txt", present: false, why: "empty" },
      { path: "logs", present: false, why: "a folder, not a file" },
      { path: "missing.txt", present: false, why: "not in the checkout (or ignored)" },
      { path: "*", present: true },
      { path: "src/*.ts", present: false, why: "not in the checkout (or ignored)" },
    ], "paths are taken literally: a pattern matches no other file");
  } finally { await w.done(); }
});

test("doneState does not count the agent's plan file as a change: a checkout that holds only PLAN.md has no work, a nested PLAN.md or a plan beside real work counts as usual, and the plan can still be named as evidence (card W06 second review)", { skip }, async () => {
  const w = await world();
  try {
    const scope = { taskId: "tsk-plan", projectId: "prj-one" };
    const made = await w.ws.ensure(scope);
    assert.equal(PLAN_FILE, "PLAN.md");
    await writeFile(join(made.checkout, PLAN_FILE), "- [x] write the plan\n- [ ] do the work\n");
    const only = await w.ws.doneState(scope, [PLAN_FILE]);
    assert.deepEqual([only?.uncommittedCount, only?.changed], [1, 0], "the plan alone is not committed, and it is no change");
    assert.deepEqual(only?.evidence, [{ path: PLAN_FILE, present: true }], "it is still a file of the checkout");
    await mkdir(join(made.checkout, "docs"));
    await writeFile(join(made.checkout, "docs", PLAN_FILE), "a document that happens to have the name\n");
    assert.equal((await w.ws.doneState(scope, []))?.changed, 1, "only the plan file at the top is left out");
    await writeFile(join(made.checkout, "src", "a.ts"), "export const a = 2;\n");
    assert.equal((await w.ws.doneState(scope, []))?.changed, 2);
    // Third review: the plan in another letter case is the same note (an agent's "plan.md", or a case-insensitive disk keeping that name).
    const other = { taskId: "tsk-plan-case", projectId: "prj-one" };
    const made2 = await w.ws.ensure(other);
    await writeFile(join(made2.checkout, "plan.md"), "- [x] write the plan\n");
    assert.equal((await w.ws.doneState(other, []))?.changed, 0, "a lower-case plan alone is no change");
  } finally { await w.done(); }
});

test("doneState runs no filter, diff driver, hook or fsmonitor the agent's checkout names, even in a repository it nests, and takes odd evidence paths literally (card W05 second review)", { skip }, async () => {
  const w = await world();
  try {
    const scope = { taskId: "tsk-one", projectId: "prj-one" };
    const made = await w.ws.ensure(scope);
    const marker = join(w.dir, "ran");
    const touch = `touch ${JSON.stringify(marker)}; cat`;
    const evil = `[core]\n\tfsmonitor = ${touch}\n\thooksPath = .git/hooks\n[filter "evil"]\n\tclean = ${touch}\n\tprocess = ${touch}\n[diff "evil"]\n\ttextconv = ${touch}\n\tcommand = ${touch}\n`;
    // A .git of its own at the top, and a repository nested in a folder (git takes it for a submodule entry and reads its head), each with commands in its configuration.
    await writeFile(join(made.checkout, ".gitattributes"), "* filter=evil diff=evil\n");
    await mkdir(join(made.checkout, ".git", "hooks"), { recursive: true });
    await writeFile(join(made.checkout, ".git", "config"), evil);
    const nested = join(made.checkout, "vendor", "lib");
    await mkdir(nested, { recursive: true });
    sh(nested, "init", "-q", "-b", "main");
    await writeFile(join(nested, "x.txt"), "x\n");
    sh(nested, "add", "-A"); sh(nested, "commit", "-q", "-m", "x");
    await writeFile(join(nested, ".git", "config"), evil);
    await writeFile(join(nested, ".gitattributes"), "* filter=evil\n");
    // Paths an option parser or a pattern could misread, a folder behind a link, and the evidence the agent wrote.
    await writeFile(join(made.checkout, "-n"), "dash\n");
    await writeFile(join(made.checkout, "--all"), "dashes\n");
    await writeFile(join(made.checkout, "src", "[ab].ts"), "brackets\n");
    await mkdir(join(w.dir, "outside"));
    await writeFile(join(w.dir, "outside", "secret.txt"), "outside the checkout\n");
    await symlink(join(w.dir, "outside"), join(made.checkout, "out"));
    await writeFile(join(made.checkout, "src", "a.ts"), "export const a = 3;\n");
    const got = await w.ws.doneState(scope, ["-n", "--all", "src/[ab].ts", "src/a.ts", "out/secret.txt", "out", "vendor/lib", "vendor/lib/x.txt", ".git/config"]);
    assert.equal(existsSync(marker), false, "nothing the checkout names was run");
    assert.deepEqual(got?.evidence, [
      { path: "-n", present: true },
      { path: "--all", present: true },
      { path: "src/[ab].ts", present: true },
      { path: "src/a.ts", present: true },
      { path: "out/secret.txt", present: false, why: "not in the checkout (or ignored)" },
      { path: "out", present: false, why: "not a plain file" },
      { path: "vendor/lib", present: false, why: "not a plain file" },
      { path: "vendor/lib/x.txt", present: false, why: "not in the checkout (or ignored)" },
      { path: ".git/config", present: false, why: "not in the checkout (or ignored)" },
    ], "a dash is a path, a pattern is a path, nothing behind a link or inside a nested repository or git's own data is evidence");
    assert.ok((got?.changed ?? 0) >= 6, "the change is seen");
    assert.deepEqual((await readdir(made.gitDir)).filter((f) => f.startsWith("nn-index-")), [], "the throwaway index is removed");
  } finally { await w.done(); }
});
