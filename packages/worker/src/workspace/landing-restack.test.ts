import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitBridge, LocalWorkspaces, type HostWorkspaceCall } from "./index.js";

// Card P10, mechanical re-apply: when the landing branch moved after a submission was approved, the integrator's host moves the approved change onto the branch's head only when none of its files changed there
// (exactly the approved change, proven entry by entry), and lands it only after proving that again. Overlapping files (the same path, or a folder of one and a file inside it) re-apply nothing.
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = hasGit ? false : "git is not installed";
const sh = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "core.hooksPath=/nonexistent-hooks", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
let counter = 0;
const rid = (): string => { const n = counter++; return `wsr-abcdefghijklmnop${"abcdefghijklmnopqrstuvwxyz"[Math.floor(n / 26) % 26]}${"abcdefghijklmnopqrstuvwxyz"[n % 26]}aa`; };
const call = (operation: HostWorkspaceCall["operation"], taskId: string, more: Partial<HostWorkspaceCall> = {}): HostWorkspaceCall => ({ requestId: rid(), operation, taskId, projectId: "prj-one", reason: "test", quietAttempts: [], ...more });
const S = "sbm-aaaaaaaaaaaaaaaaaaaa";

async function rig(): Promise<{ dir: string; shared: string; base: string; ws: LocalWorkspaces; git: GitBridge; commitShared: (files: Record<string, string | null>, message: string) => string; work: (taskId: string, files: Record<string, string | null>) => Promise<{ gitDir: string; checkout: string; tree: string; g: string[] }> }> {
  const dir = await mkdtemp(join(tmpdir(), "nn-p10r-"));
  const shared = join(dir, "shared");
  await mkdir(join(shared, "src"), { recursive: true });
  await mkdir(join(shared, "docs"), { recursive: true });
  sh(dir, "init", "-q", "-b", "main", shared);
  await writeFile(join(shared, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(join(shared, "src", "b.ts"), "export const b = 1;\n");
  await writeFile(join(shared, "docs", "c.md"), "# c\n");
  sh(shared, "add", "-A"); sh(shared, "commit", "-q", "-m", "first");
  const base = sh(shared, "rev-parse", "HEAD");
  const git = await GitBridge.create({ scratch: join(dir, "scratch") });
  const ws = new LocalWorkspaces({ root: join(dir, "work"), git, shared: (p) => (p === "prj-one" ? shared : undefined), busy: () => [], landing: () => ({ branch: "main", requirePermit: false }), clock: () => "2026-11-20T10:00:00.000Z" });
  const apply = async (root: string, files: Record<string, string | null>): Promise<void> => {
    for (const [path, content] of Object.entries(files)) {
      if (content === null) await rm(join(root, path), { force: true });
      else { await mkdir(join(root, path, ".."), { recursive: true }); await writeFile(join(root, path), content); }
    }
  };
  return {
    dir, shared, base, ws, git,
    commitShared: (files, message) => {
      for (const [path, content] of Object.entries(files)) {
        if (content === null) rmSync(join(shared, path), { force: true });
        else { mkdirSync(join(shared, path, ".."), { recursive: true }); writeFileSync(join(shared, path), content); }
      }
      sh(shared, "add", "-A"); sh(shared, "commit", "-q", "-m", message);
      return sh(shared, "rev-parse", "HEAD");
    },
    work: async (taskId, files) => {
      const made = await ws.ensure({ taskId, projectId: "prj-one" });
      const g = ["--git-dir", made.gitDir, "--work-tree", made.checkout];
      await apply(made.checkout, files);
      sh(made.checkout, ...g, "add", "-A"); sh(made.checkout, ...g, "commit", "-q", "-m", "approved work");
      return { gitDir: made.gitDir, checkout: made.checkout, tree: sh(made.checkout, ...g, "rev-parse", "HEAD^{tree}"), g };
    },
  };
}
const done = async (dir: string): Promise<void> => {
  try { execFileSync("chmod", ["-R", "u+rwX", dir]); } catch { /* nothing */ }
  await rm(dir, { recursive: true, force: true });
};

test("a submission whose files did not change on the moved landing branch is re-applied unchanged onto its head and lands; the proof is made again at landing (card P10)", { skip }, async () => {
  const r = await rig();
  try {
    const w = await r.work("tsk-one", { "src/a.ts": "export const a = 2;\n", "src/b.ts": null, "src/new.ts": "export const n = 1;\n" });
    // On the approved base nothing needs re-applying.
    assert.deepEqual(await r.ws.port.restack({ requestId: rid(), taskId: "tsk-one", projectId: "prj-one", submission: { id: S, base: r.base, tree: w.tree } }), { ok: true, state: "current" });
    // The landing branch moves: another file only.
    const head = r.commitShared({ "docs/c.md": "# c, newer\n", "docs/d.md": "# d\n" }, "other work landed");
    // A landing of the approved base and tree is refused as before (the base is not the head).
    const stale = await r.ws.port.run(call("landing", "tsk-one", { submission: { id: S, base: r.base, tree: w.tree } }));
    assert.equal(stale.ok, false);
    const out = await r.ws.port.restack({ requestId: rid(), taskId: "tsk-one", projectId: "prj-one", submission: { id: S, base: r.base, tree: w.tree } });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal((out as { state: string }).state, "reapplied");
    const re = out as { base: string; tree: string; previous: string; recovered: boolean; taken: number };
    assert.deepEqual([re.base, re.previous, re.recovered, re.taken], [head, r.base, false, 2]);
    // The checkout now holds exactly the approved change on the head: the head's files are in it, its own changes are kept, and git agrees on the base and tree.
    assert.equal(sh(w.checkout, ...w.g, "rev-parse", "refs/nn/base"), head);
    assert.equal(sh(w.checkout, ...w.g, "rev-parse", "HEAD^{tree}"), re.tree);
    assert.equal(sh(w.checkout, ...w.g, "rev-parse", "HEAD^"), head);
    assert.equal(await readFile(join(w.checkout, "docs", "c.md"), "utf8"), "# c, newer\n");
    assert.equal(await readFile(join(w.checkout, "docs", "d.md"), "utf8"), "# d\n");
    assert.equal(await readFile(join(w.checkout, "src", "a.ts"), "utf8"), "export const a = 2;\n");
    assert.equal(sh(w.checkout, ...w.g, "status", "--porcelain=v1"), "", "the checkout is at rest after the re-apply");
    assert.deepEqual(sh(w.checkout, ...w.g, "diff", "--name-status", "--no-renames", head, "HEAD").split("\n").sort(), ["A\tsrc/new.ts", "D\tsrc/b.ts", "M\tsrc/a.ts"], "the change from the head is exactly the approved one");
    // The landing gate's review check (card P09) compares patch IDs: the re-applied change keeps the approved one's, so the approval carries over to it there too.
    const approvedPatch = await r.git.patchId({ gitDir: w.gitDir, base: r.base, to: w.tree });
    assert.ok(approvedPatch !== undefined);
    assert.equal(await r.git.patchId({ gitDir: w.gitDir, base: head, to: re.tree }), approvedPatch);
    assert.equal((await r.git.committedChange({ gitDir: w.gitDir })).patchId, approvedPatch);
    // Asked again on the same head: the re-apply already made is answered, nothing moves.
    const again = await r.ws.port.restack({ requestId: rid(), taskId: "tsk-one", projectId: "prj-one", submission: { id: S, base: r.base, tree: w.tree } });
    assert.deepEqual(again, { ok: true, state: "reapplied", base: head, tree: re.tree, previous: r.base, recovered: true, taken: 0 });
    // A landing that names a re-applied base and tree the host cannot prove to be the approved change is refused, nothing written.
    const forged = await r.ws.port.run(call("landing", "tsk-one", { submission: { id: S, base: head, tree: re.tree }, reappliedFrom: { base: r.base, tree: sh(r.shared, "rev-parse", `${r.base}^{tree}`) } }));
    assert.equal(forged.ok, false);
    assert.match((forged as { reason: string }).reason, /is not exactly the change approved on/);
    assert.equal(sh(r.shared, "status", "--porcelain=v1"), "");
    // The re-applied landing: exactly the approved change lands on the head.
    const landed = await r.ws.port.run(call("landing", "tsk-one", { submission: { id: S, base: head, tree: re.tree }, reappliedFrom: { base: r.base, tree: w.tree } }));
    assert.equal(landed.ok, true, JSON.stringify(landed));
    const d = (landed as { detail: Record<string, unknown> }).detail;
    assert.deepEqual([d["landed"], d["submission"], d["base"], d["tree"], d["reappliedFrom"]], [true, S, head, re.tree, { base: r.base, tree: w.tree }]);
    assert.equal(await readFile(join(r.shared, "src", "a.ts"), "utf8"), "export const a = 2;\n");
    assert.equal(await readFile(join(r.shared, "docs", "c.md"), "utf8"), "# c, newer\n", "the landing branch's own change stays");
    assert.deepEqual(sh(r.shared, "status", "--porcelain=v1").split("\n").map((l) => l.trim()).sort(), ["?? src/new.ts", "D src/b.ts", "M src/a.ts"], "only the approved change waits in the shared tree");
  } finally { await done(r.dir); }
});

test("overlapping files re-apply nothing: the same path, and a folder of one with a file inside it; a dirty checkout, a rewritten branch and a checkout that is not the submission are refused (card P10)", { skip }, async () => {
  const r = await rig();
  try {
    const one = await r.work("tsk-one", { "src/a.ts": "export const a = 2;\n", "src/new.ts": "export const n = 1;\n" });
    const two = await r.work("tsk-two", { "lib/x.ts": "export const x = 1;\n" });
    const three = await r.work("tsk-three", { "docs/e.md": "# e\n" });
    const head = r.commitShared({ "src/a.ts": "export const a = 3;\n", "lib": "a file where task two makes a folder\n" }, "overlapping work landed");
    const before = sh(one.checkout, ...one.g, "rev-parse", "HEAD");
    const o1 = await r.ws.port.restack({ requestId: rid(), taskId: "tsk-one", projectId: "prj-one", submission: { id: S, base: r.base, tree: one.tree } });
    assert.deepEqual(o1, { ok: true, state: "overlap", paths: ["src/a.ts"], head });
    assert.equal(sh(one.checkout, ...one.g, "rev-parse", "HEAD"), before, "nothing moved");
    assert.equal(sh(one.checkout, ...one.g, "rev-parse", "refs/nn/base"), r.base);
    assert.equal(await readFile(join(one.checkout, "src", "a.ts"), "utf8"), "export const a = 2;\n");
    const o2 = await r.ws.port.restack({ requestId: rid(), taskId: "tsk-two", projectId: "prj-one", submission: { id: S, base: r.base, tree: two.tree } });
    assert.deepEqual(o2, { ok: true, state: "overlap", paths: ["lib/x.ts"], head });
    // Not the approved tree: refused.
    const wrong = await r.ws.port.restack({ requestId: rid(), taskId: "tsk-three", projectId: "prj-one", submission: { id: S, base: r.base, tree: one.tree } });
    assert.equal(wrong.ok, false);
    assert.match((wrong as { reason: string }).reason, /is not submission .*'s approved tree/);
    // A file written and not committed: refused.
    await writeFile(join(three.checkout, "docs", "loose.md"), "loose\n");
    const dirty = await r.ws.port.restack({ requestId: rid(), taskId: "tsk-three", projectId: "prj-one", submission: { id: S, base: r.base, tree: three.tree } });
    assert.equal(dirty.ok, false);
    assert.match((dirty as { reason: string }).reason, /not committed; nothing was re-applied/);
    await rm(join(three.checkout, "docs", "loose.md"));
    // The landing branch rewritten to a commit that does not descend from the base: refused.
    const orphan = sh(r.shared, "commit-tree", sh(r.shared, "rev-parse", "HEAD^{tree}"), "-m", "rewritten");
    sh(r.shared, "update-ref", "refs/heads/main", orphan);
    const rewritten = await r.ws.port.restack({ requestId: rid(), taskId: "tsk-three", projectId: "prj-one", submission: { id: S, base: r.base, tree: three.tree } });
    assert.equal(rewritten.ok, false);
    assert.match((rewritten as { reason: string }).reason, /does not descend from the checkout's base/);
    assert.equal(sh(three.checkout, ...three.g, "rev-parse", "refs/nn/base"), r.base);
    // A malformed submission: refused.
    assert.equal((await r.ws.port.restack({ requestId: rid(), taskId: "tsk-three", projectId: "prj-one", submission: { id: S, base: r.base, tree: "x" } })).ok, false);
  } finally { await done(r.dir); }
});

test("the disjoint test folds names and follows renames and attribute files: a case-only or normalisation-only spelling, a rename's source and a Git attribute file over the work all overlap; a failed ref move puts the checkout back (card P10 review)", { skip }, async () => {
  const r = await rig();
  try {
    const nfc = "lib/café.ts";
    const nfd = "lib/café.ts";
    const tCase = await r.work("tsk-case", { "docs/c.md": "# c, task\n" });
    const tNorm = await r.work("tsk-norm", { [nfc]: "export const c = 1;\n" });
    const tRename = await r.work("tsk-rename", { "src/b.ts": "export const b = 2;\n" });
    const tAttr = await r.work("tsk-attr", { "pkg/deep/q.ts": "export const q = 1;\n" });
    const tFree = await r.work("tsk-free", { "other/z.ts": "export const z = 1;\n" });
    // The branch: a file whose name differs from task one's only by case, the other Unicode spelling of task two's new file, a rename whose source task three changes, and an attribute file over task four's folder.
    sh(r.shared, "mv", "src/b.ts", "src/b-moved.ts");
    const head = r.commitShared({ "docs/C.md": "# C\n", [nfd]: "export const c = 2;\n", "pkg/.gitattributes": "* text eol=crlf\n" }, "other work landed");
    const ask = (taskId: string, tree: string) => r.ws.port.restack({ requestId: rid(), taskId, projectId: "prj-one", submission: { id: S, base: r.base, tree } });
    assert.deepEqual(await ask("tsk-case", tCase.tree), { ok: true, state: "overlap", paths: ["docs/c.md"], head });
    const norm = await ask("tsk-norm", tNorm.tree);
    assert.equal((norm as { state?: string }).state, "overlap", JSON.stringify(norm));
    assert.deepEqual(await ask("tsk-rename", tRename.tree), { ok: true, state: "overlap", paths: ["src/b.ts"], head });
    assert.deepEqual(await ask("tsk-attr", tAttr.tree), { ok: true, state: "overlap", paths: ["pkg/deep/q.ts"], head });
    // A ref transaction that fails (the base ref is locked): the checkout's files, index and refs are as they were, and the re-apply succeeds once the lock is gone.
    const before = sh(tFree.checkout, ...tFree.g, "rev-parse", "HEAD");
    const lock = join(tFree.gitDir, "refs", "nn", "base.lock");
    await writeFile(lock, "");
    await assert.rejects(ask("tsk-free", tFree.tree));
    assert.equal(sh(tFree.checkout, ...tFree.g, "rev-parse", "HEAD"), before);
    assert.equal(sh(tFree.checkout, ...tFree.g, "rev-parse", "refs/nn/base"), r.base);
    assert.equal(sh(tFree.checkout, ...tFree.g, "status", "--porcelain=v1", "--untracked-files=all"), "", "the branch's files were taken out of the checkout again");
    await rm(lock);
    const ok = await ask("tsk-free", tFree.tree);
    assert.equal((ok as { state?: string }).state, "reapplied", JSON.stringify(ok));
    assert.equal(sh(tFree.checkout, ...tFree.g, "rev-parse", "refs/nn/base"), head);
  } finally { await done(r.dir); }
});

test("second review: an executable-bit change is re-applied exactly, a link in the work is refused, a branch ignore file over the work's new file overlaps, no hook of the checkout's git directory runs, and a branch that moves again is re-applied from the earlier re-apply and lands only after the proof against the approved change (card P10)", { skip }, async () => {
  const r = await rig();
  try {
    const mode = await r.work("tsk-mode", { "src/new.ts": "export const n = 1;\n" });
    execFileSync("chmod", ["+x", join(mode.checkout, "src", "a.ts")]);
    sh(mode.checkout, ...mode.g, "add", "-A"); sh(mode.checkout, ...mode.g, "commit", "-q", "-m", "executable");
    const modeTree = sh(mode.checkout, ...mode.g, "rev-parse", "HEAD^{tree}");
    const link = await r.work("tsk-link", { "src/l.ts": "export const l = 1;\n" });
    const blob = execFileSync("git", ["--git-dir", link.gitDir, "hash-object", "-w", "--stdin"], { input: "src/a.ts", encoding: "utf8" }).trim();
    sh(link.checkout, ...link.g, "update-index", "--add", "--cacheinfo", `120000,${blob},src/link`);
    await writeFile(join(link.checkout, "src", "link"), "src/a.ts");
    sh(link.checkout, ...link.g, "commit", "-q", "-m", "a link");
    const linkTree = sh(link.checkout, ...link.g, "rev-parse", "HEAD^{tree}");
    const ignored = await r.work("tsk-ignored", { "gen/x.out": "generated\n" });
    // Hooks planted in the checkout's git directory: none may run during the re-apply (read-tree, commit-tree, update-ref) or the landing.
    const marker = join(r.dir, "hook-ran");
    for (const name of ["reference-transaction", "post-checkout", "post-index-change", "post-commit", "pre-commit"]) {
      await mkdir(join(mode.gitDir, "hooks"), { recursive: true });
      await writeFile(join(mode.gitDir, "hooks", name), `#!/bin/sh\necho ${name} >> ${JSON.stringify(marker)}\n`, { mode: 0o755 });
    }
    const head = r.commitShared({ "docs/c.md": "# c, newer\n", "gen/.gitignore": "*.out\n" }, "other work landed");
    const ask = (taskId: string, base: string, tree: string) => r.ws.port.restack({ requestId: rid(), taskId, projectId: "prj-one", submission: { id: S, base, tree } });
    // The ignore file the branch added hides the work's new file: overlap, nothing moved.
    assert.deepEqual(await ask("tsk-ignored", r.base, ignored.tree), { ok: true, state: "overlap", paths: ["gen/x.out"], head });
    // A link entry in the work is never re-applied.
    const l = await ask("tsk-link", r.base, linkTree);
    assert.equal(l.ok, false, JSON.stringify(l));
    assert.match((l as { reason: string }).reason, /link or a submodule entry/);
    assert.equal(sh(link.checkout, ...link.g, "rev-parse", "refs/nn/base"), r.base);
    // The executable bit is part of the change: re-applied exactly (old and new mode), and no hook ran.
    const m = await ask("tsk-mode", r.base, modeTree);
    assert.equal((m as { state?: string }).state, "reapplied", JSON.stringify(m));
    const first = m as { base: string; tree: string };
    assert.match(sh(mode.checkout, ...mode.g, "diff", "--raw", "--no-renames", head, "HEAD"), /^:100644 100755 [0-9a-f]+ [0-9a-f]+ M\tsrc\/a\.ts$/m);
    assert.equal(await readFile(marker, "utf8").catch(() => ""), "", "no hook of the checkout's git directory ran");
    // The branch moves again: the earlier re-apply no longer lands (its base is not the head) ...
    const head2 = r.commitShared({ "docs/d.md": "# d\n" }, "more work landed");
    const late = await r.ws.port.run(call("landing", "tsk-mode", { submission: { id: S, base: first.base, tree: first.tree }, reappliedFrom: { base: r.base, tree: modeTree } }));
    assert.equal(late.ok, false);
    // ... it is re-applied again from the earlier re-apply, proven against the approved change, and lands; a proof against anything but the approved change is refused.
    const m2 = await ask("tsk-mode", r.base, modeTree);
    assert.equal((m2 as { state?: string }).state, "reapplied", JSON.stringify(m2));
    const second = m2 as { base: string; tree: string; previous: string; recovered: boolean };
    assert.deepEqual([second.base, second.previous, second.recovered], [head2, head, false]);
    const wrongFrom = await r.ws.port.run(call("landing", "tsk-mode", { submission: { id: S, base: second.base, tree: second.tree }, reappliedFrom: { base: first.base, tree: modeTree } }));
    assert.equal(wrongFrom.ok, false, "the approved tree on a base it was not approved on is not the approved change");
    const landed = await r.ws.port.run(call("landing", "tsk-mode", { submission: { id: S, base: second.base, tree: second.tree }, reappliedFrom: { base: r.base, tree: modeTree } }));
    assert.equal(landed.ok, true, JSON.stringify(landed));
    assert.equal(await readFile(join(r.shared, "src", "new.ts"), "utf8"), "export const n = 1;\n");
    assert.equal(await readFile(marker, "utf8").catch(() => ""), "", "no hook ran during the landing either");
  } finally { await done(r.dir); }
});
