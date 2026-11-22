import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitBridge, LocalWorkspaces, filesDigest, permitLedgerPath, type HostWorkspaceCall } from "./index.js";

// Card P10 (seventh slice): under the default landing policy (requirePermit true) a re-applied submission lands, because the re-apply commit is a review-gate permit commit when the work it replaces was one.
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = hasGit ? false : "git is not installed";
const sh = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "core.hooksPath=/nonexistent-hooks", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
let counter = 0;
const rid = (): string => { const n = counter++; return `wsr-abcdefghijklmnop${"abcdefghijklmnopqrstuvwxyz"[Math.floor(n / 26) % 26]}${"abcdefghijklmnopqrstuvwxyz"[n % 26]}bb`; };
const call = (operation: HostWorkspaceCall["operation"], more: Partial<HostWorkspaceCall> = {}): HostWorkspaceCall => ({ requestId: rid(), operation, taskId: "tsk-one", projectId: "prj-one", reason: "test", quietAttempts: [], ...more });
const S = "sbm-aaaaaaaaaaaaaaaaaaaa";
const sub = (base: string, tree: string) => ({ id: S, base, tree });

async function rig(requirePermit = true, task = "tsk-one") {
  const dir = await mkdtemp(join(tmpdir(), "nn-p10p-"));
  const shared = join(dir, "shared");
  await mkdir(join(shared, "src"), { recursive: true });
  sh(dir, "init", "-q", "-b", "main", shared);
  await writeFile(join(shared, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(join(shared, "src", "b.ts"), "export const b = 1;\n");
  sh(shared, "add", "-A"); sh(shared, "commit", "-q", "-m", "first");
  const base = sh(shared, "rev-parse", "HEAD");
  const git = await GitBridge.create({ scratch: join(dir, "scratch") });
  const ws = new LocalWorkspaces({ root: join(dir, "work"), git, shared: (p) => (p === "prj-one" ? shared : undefined), busy: () => [], landing: () => ({ branch: "main", requirePermit }), clock: () => "2026-11-22T10:00:00.000Z" });
  const made = await ws.ensure({ taskId: task, projectId: "prj-one" });
  const g = ["--git-dir", made.gitDir, "--work-tree", made.checkout];
  const edit = async (files: Record<string, string>) => { for (const [p, c] of Object.entries(files)) { await mkdir(join(made.checkout, p, ".."), { recursive: true }); await writeFile(join(made.checkout, p), c); } };
  const permitCommit = async (trailers = ["Reviewed-by: owner", "NimbleNewt-Request: cgr-abc", `NimbleNewt-Task: ${task}`]) => {
    const s = await git.stage({ gitDir: made.gitDir, checkout: made.checkout });
    await git.commit({ gitDir: made.gitDir, checkout: made.checkout, permit: { base: s.base, tree: s.tree, filesDigest: filesDigest(s.files), message: "reviewed work", author: { name: "ann", email: "ann@agents.invalid" }, committer: { name: "NimbleNewt", email: "c@nimblenewt.invalid" }, trailers } });
    return s.tree;
  };
  const plainCommit = (): string => { sh(made.checkout, ...g, "add", "-A"); sh(made.checkout, ...g, "commit", "-q", "-m", "agent's own commit"); return sh(made.checkout, ...g, "rev-parse", "HEAD^{tree}"); };
  const moveShared = async (files: Record<string, string>): Promise<string> => { for (const [p, c] of Object.entries(files)) { await mkdir(join(shared, p, ".."), { recursive: true }); await writeFile(join(shared, p), c); } sh(shared, "add", "-A"); sh(shared, "commit", "-q", "-m", "other work"); return sh(shared, "rev-parse", "HEAD"); };
  const head = (): string => sh(made.checkout, ...g, "rev-parse", "HEAD");
  return { dir, shared, base, git, ws, made, g, edit, permitCommit, plainCommit, moveShared, head, done: async () => { try { execFileSync("chmod", ["-R", "u+rwX", dir]); } catch { /* nothing */ } await rm(dir, { recursive: true, force: true }); } };
}

test("under requirePermit true a permitted submission re-applied onto a moved branch is itself a permit commit and lands; the re-apply is listed in the permit ledger with the request and task marks", { skip }, async () => {
  const r = await rig();
  try {
    await r.edit({ "src/a.ts": "export const a = 2;\n" });
    const tree = await r.permitCommit();
    const next = await r.moveShared({ "docs/c.md": "# c\n" });
    const request = rid();
    const out = await r.ws.port.restack({ requestId: request, taskId: "tsk-one", projectId: "prj-one", submission: sub(r.base, tree) });
    assert.equal(out.ok && out.state, "reapplied", JSON.stringify(out));
    const commit = r.head();
    const message = sh(r.made.checkout, ...r.g, "log", "-1", "--format=%B");
    assert.match(message, new RegExp(`^NimbleNewt-Request: ${request}$`, "m"));
    assert.match(message, /^NimbleNewt-Task: tsk-one$/m);
    assert.match(await readFile(permitLedgerPath(r.made.gitDir), "utf8"), new RegExp(`^${commit} ${request}$`, "m"));
    assert.deepEqual(await r.git.unpermitted({ gitDir: r.made.gitDir, taskId: "tsk-one" }), []);
    // Asked again on the same head: the answer is recorded and the permit stays.
    const again = await r.ws.port.restack({ requestId: rid(), taskId: "tsk-one", projectId: "prj-one", submission: sub(r.base, tree) });
    assert.equal(again.ok && (again as { recovered?: boolean }).recovered, true);
    const reTree = (out as { tree: string }).tree;
    const landed = await r.ws.port.run(call("landing", { submission: sub(next, reTree), reappliedFrom: { base: r.base, tree } }));
    assert.equal(landed.ok, true, JSON.stringify(landed));
    assert.equal(await readFile(join(r.shared, "src", "a.ts"), "utf8"), "export const a = 2;\n");
  } finally { await r.done(); }
});

test("the permit passes on only from permitted work: an agent's own commit, a forged trailer commit and a commit on top of a permit commit all re-apply as before (not permit commits) and a landing under the default is refused", { skip }, async () => {
  for (const kind of ["plain", "forged", "extra"] as const) {
    const r = await rig();
    try {
      await r.edit({ "src/a.ts": "export const a = 2;\n" });
      let tree: string;
      if (kind === "plain") tree = r.plainCommit();
      else if (kind === "forged") {
        // The marks are only text: nothing lists this commit in the ledger.
        await r.edit({ "src/a.ts": "export const a = 2;\n" });
        const s = r.plainCommit();
        sh(r.made.checkout, ...r.g, "commit", "-q", "--amend", "-m", "x\n\nNimbleNewt-Request: cgr-fake\nNimbleNewt-Task: tsk-one");
        tree = s;
      } else {
        tree = await r.permitCommit();
        await r.edit({ "src/b.ts": "export const b = 2;\n" });
        tree = r.plainCommit();
      }
      const next = await r.moveShared({ "docs/c.md": "# c\n" });
      const out = await r.ws.port.restack({ requestId: rid(), taskId: "tsk-one", projectId: "prj-one", submission: sub(r.base, tree) });
      assert.equal(out.ok && out.state, "reapplied", `${kind}: ${JSON.stringify(out)}`);
      assert.doesNotMatch(sh(r.made.checkout, ...r.g, "log", "-1", "--format=%B"), /NimbleNewt-Request/, kind);
      assert.equal((await r.git.unpermitted({ gitDir: r.made.gitDir, taskId: "tsk-one" })).length, 1, kind);
      const landed = await r.ws.port.run(call("landing", { submission: sub(next, (out as { tree: string }).tree), reappliedFrom: { base: r.base, tree } }));
      assert.equal(landed.ok, false, kind);
      assert.match((landed as { reason: string }).reason, /commit permit/, kind);
      assert.equal(sh(r.shared, "status", "--porcelain=v1"), "", `${kind}: nothing written`);
    } finally { await r.done(); }
  }
});

test("a permit commit of another task does not pass its permit on, and a branch that moves twice keeps the permit through both re-applies", { skip }, async () => {
  const r = await rig();
  try {
    await r.edit({ "src/a.ts": "export const a = 2;\n" });
    const tree = await r.permitCommit(["Reviewed-by: owner", "NimbleNewt-Request: cgr-abc", "NimbleNewt-Task: tsk-other"]);
    await r.moveShared({ "docs/c.md": "# c\n" });
    const wrong = await r.ws.port.restack({ requestId: rid(), taskId: "tsk-one", projectId: "prj-one", submission: sub(r.base, tree) });
    assert.equal(wrong.ok && wrong.state, "reapplied");
    assert.equal((await r.git.unpermitted({ gitDir: r.made.gitDir, taskId: "tsk-one" })).length, 1, "marks of another task do not make a permit for this one");
  } finally { await r.done(); }
  // Another task than the one the other tests use, so the re-apply's task mark is shown to be the task's own.
  const s = await rig(true, "tsk-two");
  try {
    await s.edit({ "src/a.ts": "export const a = 2;\n" });
    const tree = await s.permitCommit();
    await s.moveShared({ "docs/c.md": "# c\n" });
    const first = await s.ws.port.restack({ requestId: rid(), taskId: "tsk-two", projectId: "prj-one", submission: sub(s.base, tree) });
    assert.equal(first.ok && first.state, "reapplied");
    const head2 = await s.moveShared({ "docs/d.md": "# d\n" });
    const second = await s.ws.port.restack({ requestId: rid(), taskId: "tsk-two", projectId: "prj-one", submission: sub(s.base, tree) });
    assert.equal(second.ok && second.state, "reapplied", JSON.stringify(second));
    assert.deepEqual(await s.git.unpermitted({ gitDir: s.made.gitDir, taskId: "tsk-two" }), []);
    assert.match(sh(s.made.checkout, ...s.g, "log", "-1", "--format=%B"), /^NimbleNewt-Task: tsk-two$/m);
    const landed = await s.ws.port.run(call("landing", { taskId: "tsk-two", submission: sub(head2, (second as { tree: string }).tree), reappliedFrom: { base: s.base, tree } }));
    assert.equal(landed.ok, true, JSON.stringify(landed));
  } finally { await s.done(); }
});

test("with requirePermit false an agent's own commit is still re-applied and lands as before (the permit rule is the landing policy's)", { skip }, async () => {
  const r = await rig(false);
  try {
    await r.edit({ "src/a.ts": "export const a = 2;\n" });
    const tree = r.plainCommit();
    const next = await r.moveShared({ "docs/c.md": "# c\n" });
    const out = await r.ws.port.restack({ requestId: rid(), taskId: "tsk-one", projectId: "prj-one", submission: sub(r.base, tree) });
    assert.equal(out.ok && out.state, "reapplied");
    assert.equal(sh(r.made.checkout, ...r.g, "diff", "--name-status", next, "HEAD"), "M\tsrc/a.ts");
    const landed = await r.ws.port.run(call("landing", { submission: sub(next, (out as { tree: string }).tree), reappliedFrom: { base: r.base, tree } }));
    assert.equal(landed.ok, true, JSON.stringify(landed));
  } finally { await r.done(); }
});

// A read-only file is still written by an administrator account, so the check needs an ordinary one.
const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
test("the re-apply is listed in the permit ledger before the head moves: when the ledger line cannot be written nothing moves, and a later re-apply lands", { skip: skip || (asRoot ? "running as root: a read-only file is still writable" : false) }, async () => {
  const r = await rig();
  try {
    await r.edit({ "src/a.ts": "export const a = 2;\n" });
    const tree = await r.permitCommit();
    const before = r.head();
    const baseBefore = sh(r.made.checkout, ...r.g, "rev-parse", "refs/nn/base");
    const onto = await r.moveShared({ "docs/c.md": "# c\n" });
    // A read-only ledger is still read (the permit commit is listed) but the new line cannot be appended (as with a full disk or a crash at that point).
    const ledger = permitLedgerPath(r.made.gitDir);
    const lines = await readFile(ledger, "utf8");
    await chmod(ledger, 0o444);
    await assert.rejects(r.git.restack({ shared: r.shared, onto, gitDir: r.made.gitDir, checkout: r.made.checkout, submission: sub(r.base, tree), permit: { taskId: "tsk-one", requestId: rid() } }));
    assert.equal(r.head(), before, "the head did not move to a commit the ledger does not list");
    assert.equal(sh(r.made.checkout, ...r.g, "rev-parse", "refs/nn/base"), baseBefore, "the base did not move");
    assert.equal(sh(r.made.checkout, ...r.g, "status", "--porcelain=v1"), "", "the checkout is unchanged");
    await chmod(ledger, 0o600);
    assert.equal(await readFile(ledger, "utf8"), lines, "nothing was listed");
    const out = await r.ws.port.restack({ requestId: rid(), taskId: "tsk-one", projectId: "prj-one", submission: sub(r.base, tree) });
    assert.equal(out.ok && out.state, "reapplied", JSON.stringify(out));
    const landed = await r.ws.port.run(call("landing", { submission: sub(onto, (out as { tree: string }).tree), reappliedFrom: { base: r.base, tree } }));
    assert.equal(landed.ok, true, JSON.stringify(landed));
  } finally { await r.done(); }
});

test("the permit check of a re-apply reads exactly the commits it replaces (a range), not whatever the head is by then", { skip }, async () => {
  const r = await rig();
  try {
    await r.edit({ "src/a.ts": "export const a = 2;\n" });
    await r.permitCommit();
    const permitted = r.head();
    await r.edit({ "src/b.ts": "export const b = 2;\n" });
    r.plainCommit();
    const own = r.head();
    const base = sh(r.made.checkout, ...r.g, "rev-parse", "refs/nn/base");
    // HEAD is the agent's own commit; the range up to the permit commit alone is permitted, the range up to HEAD is not.
    assert.deepEqual(await r.git.unpermitted({ gitDir: r.made.gitDir, taskId: "tsk-one", range: { base, head: permitted } }), []);
    assert.deepEqual(await r.git.unpermitted({ gitDir: r.made.gitDir, taskId: "tsk-one", range: { base, head: own } }), [own]);
    assert.deepEqual(await r.git.unpermitted({ gitDir: r.made.gitDir, taskId: "tsk-one" }), [own]);
    sh(r.made.checkout, ...r.g, "reset", "-q", "--hard", permitted);
    assert.deepEqual(await r.git.unpermitted({ gitDir: r.made.gitDir, taskId: "tsk-one", range: { base, head: own } }), [own], "a range does not follow HEAD");
    await assert.rejects(r.git.unpermitted({ gitDir: r.made.gitDir, taskId: "tsk-one", range: { base: "HEAD", head: own } }), /full commit IDs/);
  } finally { await r.done(); }
});
