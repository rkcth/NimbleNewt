import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitBridge, LocalWorkspaces, type HostWorkspaceCall } from "./index.js";

// Card P10: a landing of a queued submission, on the real local host with real git. It lands only on the submission's base (the landing branch has not moved since the approval) and only when the checkout's
// committed work is exactly the approved tree: a commit added after the approval is a diff beyond the submission and refuses the whole landing, with nothing written.
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = hasGit ? false : "git is not installed";
const sh = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "core.hooksPath=/nonexistent-hooks", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
let counter = 0;
const rid = (): string => `wsr-${"abcdefghijklmnop"}${"abcdefghijklmnopqrstuvwxyz".slice(counter, counter++ + 4)}`;
const call = (operation: HostWorkspaceCall["operation"], more: Partial<HostWorkspaceCall> = {}): HostWorkspaceCall => ({ requestId: rid(), operation, taskId: "tsk-one", projectId: "prj-one", reason: "test", quietAttempts: [], ...more });
const S = "sbm-aaaaaaaaaaaaaaaaaaaa";

test("a queued submission lands only as exactly its approved tree on its approved base; a commit beyond it or a moved base refuses the landing and writes nothing (card P10)", { skip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "nn-p10q-"));
  try {
    const shared = join(dir, "shared");
    await mkdir(join(shared, "src"), { recursive: true });
    sh(dir, "init", "-q", "-b", "main", shared);
    await writeFile(join(shared, "src", "a.ts"), "export const a = 1;\n");
    sh(shared, "add", "-A"); sh(shared, "commit", "-q", "-m", "first");
    const base = sh(shared, "rev-parse", "HEAD");
    const git = await GitBridge.create({ scratch: join(dir, "scratch") });
    const ws = new LocalWorkspaces({ root: join(dir, "work"), git, shared: (p) => (p === "prj-one" ? shared : undefined), busy: () => [], landing: () => ({ branch: "main", requirePermit: false }), clock: () => "2026-11-18T10:00:00.000Z" });
    const made = await ws.ensure({ taskId: "tsk-one", projectId: "prj-one" });
    const g = ["--git-dir", made.gitDir, "--work-tree", made.checkout];
    // The approved work: one commit.
    await writeFile(join(made.checkout, "src", "a.ts"), "export const a = 2;\n");
    sh(made.checkout, ...g, "add", "-A"); sh(made.checkout, ...g, "commit", "-q", "-m", "approved work");
    const approved = sh(made.checkout, ...g, "rev-parse", "HEAD^{tree}");
    // Something written after the approval (by the integrator or anyone): a second commit.
    await writeFile(join(made.checkout, "src", "extra.ts"), "export const extra = true;\n");
    sh(made.checkout, ...g, "add", "-A"); sh(made.checkout, ...g, "commit", "-q", "-m", "beyond the submission");
    const beyond = sh(made.checkout, ...g, "rev-parse", "HEAD^{tree}");

    const clean = () => assert.equal(sh(shared, "status", "--porcelain=v1"), "", "nothing was written to the shared workspace");
    const r1 = await ws.port.run(call("landing", { submission: { id: S, base, tree: approved } }));
    assert.equal(r1.ok, false);
    assert.match((r1 as { reason: string }).reason, /is not submission sbm-a+'s approved tree .* nothing beyond it; nothing was landed/);
    clean();
    // A submission approved on another base: the landing branch is not where the review saw it.
    const r2 = await ws.port.run(call("landing", { submission: { id: S, base: "f".repeat(40), tree: beyond } }));
    assert.equal(r2.ok, false);
    assert.match((r2 as { reason: string }).reason, /was approved on ffffffffffff but the landing branch is at/);
    clean();
    // A submission names nothing on an operation that neither commits nor lands one; a malformed one is refused too.
    assert.match((await ws.port.run(call("refresh", { submission: { id: S, base, tree: beyond } })) as { reason: string }).reason, /only a release commits a submission, and a landing lands one/);
    assert.match((await ws.port.run(call("landing", { submission: { id: S, base, tree: "x" } as never })) as { reason: string }).reason, /not of the controller's form/);
    clean();
    // Exactly the approved tree on the approved base: it lands, and the answer names the submission, base and tree.
    const landed = await ws.port.run(call("landing", { submission: { id: S, base, tree: beyond } }));
    assert.equal(landed.ok, true, JSON.stringify(landed));
    const d = (landed as { detail: Record<string, unknown> }).detail;
    assert.deepEqual([d["landed"], d["submission"], d["base"], d["tree"]], [true, S, base, beyond]);
    assert.equal(await readFile(join(shared, "src", "extra.ts"), "utf8"), "export const extra = true;\n");
    assert.equal(sh(shared, "rev-parse", "HEAD"), base, "the landing made no commit in the shared repository");
  } finally {
    try { execFileSync("chmod", ["-R", "u+rwX", dir]); } catch { /* nothing */ }
    await rm(dir, { recursive: true, force: true });
  }
});
