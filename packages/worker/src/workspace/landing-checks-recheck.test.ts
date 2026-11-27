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
    // First review: the host also says whether the landed tree is exactly the judged change (here: on the same base, only the same tree is).
    assert.equal(report.reviewedReplays, false);
    const own = await ws.port.landingChecks!({ ...scope, checks: [], maxOutputBytes: 1000, reviewed: { base, tree: later.tree }, carried: [{ base, tree: reviewed.tree }, { base, tree: later.tree }, { base: "f".repeat(40), tree: later.tree }] });
    assert.equal(own.reviewedReplays, true, "the landed tree itself, on its own base");
    assert.deepEqual(own.carriedReplays, [false, true, false], "per earlier submission, in order: another tree, the same tree, a base this checkout does not hold (not a later commit of it: not shown)");
  } finally {
    try { execFileSync("chmod", ["-R", "u+rwX", dir]); } catch { /* nothing */ }
    await rm(dir, { recursive: true, force: true });
  }
});

test("GitBridge.replays: on another base a judgement holds only for the judged change carried onto it, never for the same edit placed elsewhere with the same patch ID (card P08 landing re-check, first review)", { skip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "nn-p08r-"));
  try {
    const repo = join(dir, "repo");
    sh(dir, "init", "-q", "-b", "main", repo);
    const put = async (name: string, text: string) => { await writeFile(join(repo, name), text); };
    // A tree of the working files as they would be with `text` in a.txt, without committing; the files are put back afterwards.
    const treeWith = async (text: string): Promise<string> => { await put("a.txt", text); sh(repo, "add", "-A"); const t = sh(repo, "write-tree"); sh(repo, "reset", "-q", "--hard"); return t; };
    const commit = async (files: Record<string, string>, message: string): Promise<string> => { for (const [n, t] of Object.entries(files)) await put(n, t); sh(repo, "add", "-A"); sh(repo, "commit", "-q", "-m", message); return sh(repo, "rev-parse", "HEAD"); };
    const pid = (from: string, to: string): string => execFileSync("git", ["patch-id", "--verbatim"], { input: execFileSync("git", ["diff", "--binary", "--full-index", "--no-renames", from, to], { cwd: repo }), cwd: repo, encoding: "utf8" }).split(" ")[0]!;
    const b1 = await commit({ "a.txt": block("y") + block("y"), "o.txt": "one\n" }, "base");
    const judged = { base: b1, tree: await treeWith(block("Y") + block("y")) };
    const git = await GitBridge.create({ scratch: join(dir, "scratch") });
    const gitDir = join(repo, ".git");
    const replays = (landed: { base: string; tree: string }) => git.replays({ gitDir, judged, landed });
    // The same base: only the same tree.
    assert.equal(await replays(judged), true);
    const placedHere = await treeWith(block("y") + block("Y"));
    assert.equal(pid(b1, placedHere), pid(b1, judged.tree));
    assert.equal(await replays({ base: b1, tree: placedHere }), false);
    // The landing branch moved on another file: the refreshed tree with the edit where it was reviewed is the judged change; the same edit in the other block (the same patch ID) is not.
    const b2 = await commit({ "o.txt": "two\n" }, "main moves");
    const refreshed = await treeWith(block("Y") + block("y"));
    const elsewhere = await treeWith(block("y") + block("Y"));
    assert.equal(pid(b2, elsewhere), pid(b1, judged.tree), "the patch ID cannot tell the two placements apart on another base either");
    assert.equal(await replays({ base: b2, tree: refreshed }), true);
    assert.equal(await replays({ base: b2, tree: elsewhere }), false);
    // The landing branch changed the same file away from the edit: a clean three-way re-apply, accepted; the same edit placed elsewhere still is not.
    const b3 = await commit({ "a.txt": "q\n" + (block("y") + block("y")).slice(2) }, "main changes the file elsewhere");
    const head = "q\n" + (block("Y") + block("y")).slice(2), other = "q\n" + (block("y") + block("Y")).slice(2);
    assert.equal(await replays({ base: b3, tree: await treeWith(head) }), true);
    assert.equal(await replays({ base: b3, tree: await treeWith(other) }), false);
    // The landing branch changed the very line: the re-apply conflicts, so whatever the author resolved is not shown to be the judged change.
    const b4 = await commit({ "a.txt": "q\n" + (block("Z") + block("y")).slice(2) }, "main changes the same line");
    assert.equal(await replays({ base: b4, tree: await treeWith(head) }), false);
    // A landed base that is not a later commit of the judged base's history (a branch that was rewritten) is never shown.
    sh(repo, "checkout", "-q", "--orphan", "side"); sh(repo, "rm", "-q", "-rf", ".");
    const side = await commit({ "a.txt": block("y") + block("y"), "o.txt": "two\n" }, "unrelated");
    assert.equal(await replays({ base: side, tree: await treeWith(block("Y") + block("y")) }), false);
    // Names that are not full object IDs are refused, not looked up.
    await assert.rejects(git.replays({ gitDir, judged: { base: "HEAD", tree: judged.tree }, landed: { base: b2, tree: refreshed } }), /full object IDs/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
