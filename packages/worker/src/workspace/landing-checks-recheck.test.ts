import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitBridge, LocalWorkspaces } from "./index.js";

// Card P08 landing re-check, the host side: what the landing gate is given (the landed change's base, tree and patch ID, and the patch ID the host computes from the reviewed base and tree) is enough to tell two different
// trees on the same base apart, and git's patch ID alone is not. The controller's gate (controller/landing/landing-gate-recheck.test.ts) compares the trees whenever the bases are the same.
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = hasGit ? false : "git is not installed";
const sh = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "core.hooksPath=/nonexistent-hooks", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
const scope = { taskId: "tsk-one", projectId: "prj-one" };
const block = (mark: string) => `p\np\np\np\na\nb\nc\n${mark}\nd\ne\nf\np\np\np\np\n`;

test("the same edit in either of two identical blocks has the same patch ID on the same base but another tree; the host reports both trees and base, so the gate can compare them (card P08 landing re-check)", { skip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "nn-p08-"));
  try {
    const shared = join(dir, "shared");
    await mkdir(join(shared, "src"), { recursive: true });
    sh(dir, "init", "-q", "-b", "main", shared);
    await writeFile(join(shared, "src", "a.txt"), block("y") + block("y"));
    sh(shared, "add", "-A"); sh(shared, "commit", "-q", "-m", "first");
    const git = await GitBridge.create({ scratch: join(dir, "scratch") });
    const ws = new LocalWorkspaces({ root: join(dir, "work"), git, shared: (p) => (p === "prj-one" ? shared : undefined), busy: () => [], landing: () => ({ branch: "main", requirePermit: false }), clock: () => "2026-11-26T10:00:00.000Z", checks: { launcher: { launch: async () => { throw new Error("no command is run here"); } } as never } });
    const made = await ws.ensure(scope);
    const g = (...args: string[]) => sh(made.checkout, "--git-dir", made.gitDir, "--work-tree", made.checkout, ...args);
    const base = g("rev-parse", "HEAD");
    // What was reviewed: the edit in the first block.
    await writeFile(join(made.checkout, "src", "a.txt"), block("Y") + block("y"));
    const reviewed = await ws.stageWork(scope);
    // What lands: the same edit in the second block instead, committed on the same base.
    await writeFile(join(made.checkout, "src", "a.txt"), block("y") + block("Y"));
    const later = await ws.stageWork(scope);
    g("commit", "-q", "-m", "work");
    assert.notEqual(later.tree, reviewed.tree, "two different trees");
    assert.equal(later.patchId, reviewed.patchId, "git's patch ID leaves out line numbers: the same ID on the same base");
    const report = await ws.port.landingChecks!({ ...scope, checks: [], maxOutputBytes: 1000, reviewed: { base, tree: reviewed.tree } });
    assert.equal(report.reviewedPatchId, report.change?.patchId, "the patch IDs agree, so a patch ID comparison alone would accept it");
    assert.deepEqual([report.change?.base, report.change?.tree], [base, later.tree], "the landed base is the reviewed base and the landed tree is not the reviewed one: the gate refuses on that");
  } finally {
    try { execFileSync("chmod", ["-R", "u+rwX", dir]); } catch { /* nothing */ }
    await rm(dir, { recursive: true, force: true });
  }
});
