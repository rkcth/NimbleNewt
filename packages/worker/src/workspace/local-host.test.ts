import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitBridge, LocalWorkspaces, type HostWorkspaceCall } from "./index.js";

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
