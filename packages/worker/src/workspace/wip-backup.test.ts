import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitBridge, WipBackupHost, WorkspaceError, type CheckoutLocation } from "./index.js";

// Card P02b: the work-in-progress backup, against real git, a real checkout and a disposable bare repository on the local disk (never a real remote).
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = hasGit ? false : "git is not installed";
const sh = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "core.hooksPath=/nonexistent-hooks", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
const REF = "refs/heads/nn-wip/prj-one/tsk-one";
const SECRET_WORD = "TOPSECRETVALUE";
/** The test's own scan: a file that holds the planted word may not leave the machine. */
const scan = (file: { path: string; bytes: Buffer }): string | undefined => (file.bytes.toString("utf8").includes(SECRET_WORD) ? "holds a credential" : undefined);

async function world() {
  const dir = await mkdtemp(join(tmpdir(), "nn-wip-"));
  const shared = join(dir, "shared");
  await mkdir(join(shared, "src"), { recursive: true });
  sh(dir, "init", "-q", "-b", "main", shared);
  await writeFile(join(shared, "README.md"), "hello\n"); await writeFile(join(shared, "src", "a.ts"), "export const a = 1;\n"); await writeFile(join(shared, "src", "b.ts"), "export const b = 1;\n");
  sh(shared, "add", "-A"); sh(shared, "commit", "-q", "-m", "first");
  const remote = join(dir, "remote.git");
  sh(dir, "init", "-q", "--bare", "-b", "main", remote);
  const git = await GitBridge.create({ scratch: join(dir, "scratch") });
  const where: CheckoutLocation = { shared, checkout: join(dir, "checkout"), gitDir: join(dir, "task.git"), bridgeState: join(dir, "state"), quarantineRoot: join(dir, "quarantine") };
  await git.createCheckout({ shared, commit: await git.head(shared), gitDir: where.gitDir, checkout: where.checkout });
  const ask = (more: Partial<Parameters<GitBridge["backupWip"]>[0]> = {}) => git.backupWip({ gitDir: where.gitDir, checkout: where.checkout, remote, ref: REF, taskId: "tsk-one", projectId: "prj-one", developer: "agent:ann", executor: "host:one", scan, ...more });
  /** Everything about the agent's own repository that a backup must leave exactly as it was. */
  const agentState = async (): Promise<string> => [sh(where.gitDir, "rev-parse", "HEAD"), sh(where.gitDir, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/nn/base"), (await readFile(join(where.gitDir, "index"))).toString("hex"), sh(where.gitDir, "config", "--local", "--list").replace(/\n/g, "|")].join("#");
  return { dir, shared, git, where, remote, ask, agentState, done: () => rm(dir, { recursive: true, force: true }) };
}

test("a backup pushes the work in progress as one unreviewed commit under the platform's name and leaves the agent's repository exactly as it was", { skip }, async () => {
  const w = await world();
  try {
    await writeFile(join(w.where.checkout, "src", "a.ts"), "export const a = 2;\r\n"); // changed, with a Windows line ending
    await writeFile(join(w.where.checkout, "src", "new file é.ts"), "export const n = 1;\n"); // new, with a space and a non-ASCII letter
    await rm(join(w.where.checkout, "src", "b.ts")); // deleted
    await writeFile(join(w.where.checkout, ".gitignore"), "build/\n"); await mkdir(join(w.where.checkout, "build")); await writeFile(join(w.where.checkout, "build", "out.js"), "x");
    const before = await w.agentState();
    const r = await w.ask();
    assert.equal(r.unchanged, false);
    assert.equal(r.blocked.length, 0);
    assert.ok(r.ignored >= 1, "an ignored folder is counted, not carried");
    assert.equal(await w.agentState(), before, "HEAD, branches, the base, the index and the configuration of the agent's repository are untouched");
    assert.deepEqual(await readdir(w.where.gitDir).then((l) => l.filter((n) => n.startsWith("nn-wip-index"))), [], "the temporary index is removed");
    // The remote has the branch and nothing else.
    assert.equal(sh(w.remote, "for-each-ref", "--format=%(refname) %(objectname)"), `${REF} ${r.commitId}`);
    const message = sh(w.remote, "log", "-1", "--format=%B", REF);
    for (const line of ["Developer: agent:ann", "Executor: host:one", "NimbleNewt-Task: tsk-one", "NimbleNewt-WIP: unreviewed"]) assert.ok(message.split("\n").includes(line), line);
    assert.ok(!/Reviewed-by|Reviewed-via/.test(message), "never a review trailer");
    assert.equal(sh(w.remote, "log", "-1", "--format=%an <%ae> | %cn <%ce>", REF), "NimbleNewt <controller@nimblenewt.invalid> | NimbleNewt <controller@nimblenewt.invalid>");
    const files = sh(w.remote, "ls-tree", "-r", "--name-only", "-z", REF).split("\0").filter(Boolean).sort();
    assert.deepEqual(files, [".gitignore", "README.md", "src/a.ts", "src/new file é.ts"].sort());
    assert.equal(execFileSync("git", ["--git-dir", w.remote, "cat-file", "blob", `${REF}:src/a.ts`]).toString("utf8"), "export const a = 2;\r\n", "bytes, line endings included, are exact");
  } finally { await w.done(); }
});

test("a file the scan names is left out and reported, the rest is backed up, and a link and an oversized file are left out too", { skip }, async () => {
  const w = await world();
  try {
    await writeFile(join(w.where.checkout, "notes.txt"), `token ${SECRET_WORD}\n`);
    await writeFile(join(w.where.checkout, "ok.txt"), "fine\n");
    await writeFile(join(w.where.checkout, "big.bin"), Buffer.alloc(8 * 1024 * 1024 + 10, 1));
    let linked = true;
    await symlink("README.md", join(w.where.checkout, "ln")).catch(() => { linked = false; }); // a link needs a privilege on Windows
    const r = await w.ask();
    const byPath = new Map(r.blocked.map((b) => [b.path, b.reason]));
    assert.equal(byPath.get("notes.txt"), "holds a credential");
    assert.match(byPath.get("big.bin") ?? "", /larger than/);
    if (linked) assert.match(byPath.get("ln") ?? "", /link/);
    const files = sh(w.remote, "ls-tree", "-r", "--name-only", REF).split("\n");
    assert.ok(files.includes("ok.txt"));
    for (const left of ["notes.txt", "big.bin", "ln"]) assert.ok(!files.includes(left), `${left} did not leave the machine`);
    // The secret is in none of the remote's objects (a blob that was never pushed is not there).
    const objects = sh(w.remote, "cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)").split("\n").filter((l) => l.endsWith(" blob")).map((l) => l.split(" ")[0]!);
    for (const id of objects) assert.ok(!execFileSync("git", ["--git-dir", w.remote, "cat-file", "blob", id]).toString("utf8").includes(SECRET_WORD), "no blob on the remote holds the secret");
  } finally { await w.done(); }
});

test("a scan that throws, or a missing scan, blocks: a file whose scan failed is left out and no scan means no backup", { skip }, async () => {
  const w = await world();
  try {
    await writeFile(join(w.where.checkout, "x.txt"), "x\n");
    const r = await w.ask({ scan: () => { throw new Error("scan broke"); } });
    assert.ok(r.blocked.some((b) => b.path === "x.txt"), "the file whose scan failed is left out");
    assert.equal(r.files, 0, "every file's scan failed, so none was carried");
    await assert.rejects(w.ask({ scan: undefined as never }), /needs a scan/);
    assert.throws(() => new WipBackupHost({ git: w.git, locate: () => w.where, scan: undefined as never }), /needs a scan/);
  } finally { await w.done(); }
});

test("successive backups are fast-forwards, an unchanged workspace is confirmed without a new commit, and a file that changes while it is read is left out", { skip }, async () => {
  const w = await world();
  try {
    await writeFile(join(w.where.checkout, "one.txt"), "1\n");
    const first = await w.ask();
    const again = await w.ask();
    assert.equal(again.unchanged, true);
    assert.equal(again.commitId, first.commitId);
    await writeFile(join(w.where.checkout, "two.txt"), "2\n");
    const second = await w.ask();
    assert.notEqual(second.commitId, first.commitId);
    assert.equal(sh(w.remote, "rev-parse", `${REF}^`), first.commitId, "the second backup builds on the first");
    assert.equal(sh(w.remote, "rev-parse", REF), second.commitId);
    // A file replaced between git's look and the read (the test seam) is not carried.
    const racing = await GitBridge.create({ scratch: join(w.dir, "scratch2"), hooks: { beforeOpen: async (absolute) => { if (absolute.endsWith("race.txt")) await writeFile(absolute, "changed after git looked\n"); } } });
    await writeFile(join(w.where.checkout, "race.txt"), "as git saw it\n");
    const r = await racing.backupWip({ gitDir: w.where.gitDir, checkout: w.where.checkout, remote: w.remote, ref: REF, taskId: "tsk-one", projectId: "prj-one", developer: "agent:ann", executor: "host:one", scan });
    assert.match(r.blocked.find((b) => b.path === "race.txt")?.reason ?? "", /changed/);
    assert.ok(!sh(w.remote, "ls-tree", "-r", "--name-only", REF).split("\n").includes("race.txt"));
  } finally { await w.done(); }
});

test("a failed push is reported and never counted, and the remote's own branch is never forced", { skip }, async () => {
  const w = await world();
  try {
    await writeFile(join(w.where.checkout, "one.txt"), "1\n");
    const missing = join(w.dir, "no-such-remote.git");
    await assert.rejects(w.ask({ remote: missing }), (e: unknown) => e instanceof WorkspaceError && /push to the backup remote failed/.test(e.message));
    const counted = (): string => sh(w.where.gitDir, "for-each-ref", "refs/nn/wip-last");
    assert.equal(counted(), "", "a failed push left nothing counted");
    const first = await w.ask();
    assert.notEqual(counted(), "");
    // Someone else moves the remote branch to an unrelated commit: our next push would not be a fast-forward and must fail, leaving theirs.
    const other = sh(w.remote, "commit-tree", "-m", "someone else", sh(w.remote, "rev-parse", `${first.commitId}^{tree}`));
    sh(w.remote, "update-ref", REF, other);
    await writeFile(join(w.where.checkout, "two.txt"), "2\n");
    await assert.rejects(w.ask(), /push to the backup remote failed/);
    assert.equal(sh(w.remote, "rev-parse", REF), other, "the remote branch was not forced");
    assert.equal(sh(w.where.gitDir, "for-each-ref", "--format=%(objectname)", "refs/nn/wip-last"), first.commitId, "the last counted backup is still the first");
  } finally { await w.done(); }
});

test("only a work-in-progress branch may be pushed to: a protected or target branch, a prefix lookalike and an option as a remote are refused before git runs", { skip }, async () => {
  const w = await world();
  try {
    await writeFile(join(w.where.checkout, "one.txt"), "1\n");
    for (const ref of ["refs/heads/main", "main", "refs/heads/nn-wip/x", "refs/heads/nn-wip/../main", "refs/heads/nn-wipe/a/b", "refs/heads/nn-wip/a/b/c", "refs/tags/nn-wip/a/b", "+refs/heads/nn-wip/a/b", "refs/heads/nn-wip/a/b.lock", "refs/heads/nn-wip/a/.b"]) await assert.rejects(w.ask({ ref }), (e: unknown) => e instanceof WorkspaceError && /not a work-in-progress branch/.test(e.message), ref);
    for (const remote of ["--upload-pack=touch /tmp/x", "-o", "ext::sh -c touch", "a b", "", "x\ny"]) await assert.rejects(w.ask({ remote }), (e: unknown) => e instanceof WorkspaceError, remote);
    assert.equal(sh(w.remote, "for-each-ref"), "", "nothing reached the remote");
  } finally { await w.done(); }
});

test("a restore from the branch matches what the last successful push held, with the work showing as changes against the base", { skip }, async () => {
  const w = await world();
  try {
    await writeFile(join(w.where.checkout, "src", "a.ts"), "export const a = 2;\r\n");
    await writeFile(join(w.where.checkout, "added.txt"), "new\n");
    await rm(join(w.where.checkout, "src", "b.ts"));
    await writeFile(join(w.where.checkout, "secret.txt"), SECRET_WORD);
    const pushed = await w.ask();
    // Work done after the last push is not in the branch: the restore matches the push, not the later state.
    await writeFile(join(w.where.checkout, "later.txt"), "after the push\n");
    const restored = join(w.dir, "restored");
    const r = await w.git.restoreWip({ remote: w.remote, ref: REF, gitDir: join(w.dir, "restored.git"), checkout: restored, baseFrom: w.shared });
    assert.equal(r.commitId, pushed.commitId);
    assert.equal(r.base, await w.git.baseOf(w.where.gitDir));
    assert.equal(r.baseFound, true);
    const list = async (dir: string): Promise<string[]> => (await readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name).slice(dir.length + 1).split("\\").join("/")).sort();
    assert.deepEqual(await list(restored), ["README.md", "added.txt", "src/a.ts"]);
    assert.equal(await readFile(join(restored, "src", "a.ts"), "utf8"), "export const a = 2;\r\n");
    const status = await w.git.status({ gitDir: join(w.dir, "restored.git"), checkout: restored });
    assert.deepEqual(status.entries.map((e) => e.path).sort(), ["added.txt", "src/a.ts", "src/b.ts"], "the work is the difference from the base, as it was");
    // A restore into a used folder, and of a branch that is not a work-in-progress commit, refuse.
    await assert.rejects(w.git.restoreWip({ remote: w.remote, ref: REF, gitDir: join(w.dir, "again.git"), checkout: restored }), /must be empty/);
    sh(w.remote, "update-ref", "refs/heads/nn-wip/prj-one/plain", sh(w.remote, "commit-tree", "-m", "a plain commit", sh(w.remote, "rev-parse", `${pushed.commitId}^{tree}`)));
    await assert.rejects(w.git.restoreWip({ remote: w.remote, ref: "refs/heads/nn-wip/prj-one/plain", gitDir: join(w.dir, "plain.git"), checkout: join(w.dir, "plain") }), /does not hold a NimbleNewt work-in-progress commit|could not be fetched/);
  } finally { await w.done(); }
});

test("the host asks for a backup by task: a task it does not hold, a refused branch and a failed push are plain refusals, and a good one says what it carried", { skip }, async () => {
  const w = await world();
  try {
    const host = new WipBackupHost({ git: w.git, scan, locate: ({ taskId }) => (taskId === "tsk-one" ? w.where : undefined) });
    const call = { projectId: "prj-one", taskId: "tsk-one", remote: w.remote, ref: REF, developer: "agent:ann", executor: "host:one" };
    assert.deepEqual(await host.backup({ ...call, taskId: "tsk-other" }), { ok: false, reason: "this host does not hold the task's checkout" });
    const bad = await host.backup({ ...call, ref: "refs/heads/main" });
    assert.equal(bad.ok, false);
    await writeFile(join(w.where.checkout, "n.txt"), `has ${SECRET_WORD}\n`); await writeFile(join(w.where.checkout, "m.txt"), "m\n");
    const [a, b] = await Promise.all([host.backup(call), host.backup(call)]); // two asks at once run one after the other
    assert.equal(a.ok && b.ok, true);
    const detail = (a as { detail: Record<string, unknown> }).detail;
    assert.equal(detail["files"], 4, "the three files of the base and m.txt; n.txt was left out");
    assert.deepEqual(detail["blocked"], [{ path: "n.txt", reason: "holds a credential" }]);
    assert.equal((b as { detail: Record<string, unknown> }).detail["unchanged"], true);
    const down = await host.backup({ ...call, remote: join(w.dir, "gone.git") });
    assert.equal(down.ok, false);
  } finally { await w.done(); }
});

test("the branch carries only scanned snapshots: the first backup has no parent, so a committed file the scan names never reaches the remote through the project's history (P02b review)", { skip }, async () => {
  const w = await world();
  try {
    // A file holding the secret is in the project's own committed history (the base), and the agent leaves it as it is.
    await writeFile(join(w.shared, "committed-secret.txt"), `key ${SECRET_WORD}\n`);
    sh(w.shared, "add", "-A"); sh(w.shared, "commit", "-q", "-m", "second");
    const dir2 = join(w.dir, "c2");
    const where = { gitDir: join(dir2, "task.git"), checkout: join(dir2, "checkout") };
    await w.git.createCheckout({ shared: w.shared, commit: await w.git.head(w.shared), gitDir: where.gitDir, checkout: where.checkout });
    await writeFile(join(where.checkout, "work.txt"), "w\n");
    const r = await w.ask({ gitDir: where.gitDir, checkout: where.checkout });
    assert.deepEqual(r.blocked.map((b) => b.path), ["committed-secret.txt"]);
    assert.equal(sh(w.remote, "rev-list", "--count", REF), "1", "one commit, with no parent: the project's history was not pushed");
    const objects = sh(w.remote, "cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)").split("\n");
    assert.ok(!objects.some((l) => l.endsWith(" commit") && l.split(" ")[0] !== r.commitId), "no commit but the backup is on the remote");
    for (const id of objects.filter((l) => l.endsWith(" blob")).map((l) => l.split(" ")[0]!)) assert.ok(!execFileSync("git", ["--git-dir", w.remote, "cat-file", "blob", id]).toString("utf8").includes(SECRET_WORD), "no blob on the remote holds the secret");
    // The next backup builds on the first, never on the project's head.
    await writeFile(join(where.checkout, "work2.txt"), "w2\n");
    const second = await w.ask({ gitDir: where.gitDir, checkout: where.checkout });
    assert.equal(sh(w.remote, "rev-parse", `${REF}^`), r.commitId);
    assert.equal(sh(w.remote, "rev-list", "--count", REF), "2");
    // A restore without the project's repository still brings every file back; the snapshot is then its own base.
    const bare = await w.git.restoreWip({ remote: w.remote, ref: REF, gitDir: join(w.dir, "nobase.git"), checkout: join(w.dir, "nobase") });
    assert.equal(bare.commitId, second.commitId);
    assert.equal(bare.baseFound, false);
    assert.equal(bare.base, second.commitId);
    assert.equal(await readFile(join(w.dir, "nobase", "work2.txt"), "utf8"), "w2\n");
    assert.deepEqual((await w.git.status({ gitDir: join(w.dir, "nobase.git"), checkout: join(w.dir, "nobase") })).entries, []);
  } finally { await w.done(); }
});

test("a restore refuses a branch whose tree holds a link entry, which a backup never makes (P02b review)", { skip }, async () => {
  const w = await world();
  try {
    const link = execFileSync("git", ["--git-dir", w.remote, "hash-object", "-w", "--stdin"], { input: "/etc/passwd" }).toString().trim();
    const tree = execFileSync("git", ["--git-dir", w.remote, "mktree"], { input: `120000 blob ${link}\tpointer\n` }).toString().trim();
    const base = "0".repeat(39) + "1";
    const commit = execFileSync("git", ["--git-dir", w.remote, "-c", "user.name=t", "-c", "user.email=t@t", "commit-tree", tree, "-m", `x\n\nNimbleNewt-Base: ${base}\nNimbleNewt-WIP: unreviewed\n`]).toString().trim();
    sh(w.remote, "update-ref", REF, commit);
    const target = join(w.dir, "linked");
    await assert.rejects(w.git.restoreWip({ remote: w.remote, ref: REF, gitDir: join(w.dir, "linked.git"), checkout: target }), /link or a submodule/);
    assert.deepEqual(await readdir(target), [], "nothing was written into the checkout");
  } finally { await w.done(); }
});
