import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitBridge, LocalWorkspaces } from "@nimblenewt/worker";
import { createWipScanner } from "@nimblenewt/controller";

// Card P05, first slice, across the packages: an ordinary open-source style checkout (cloned from a disposable bare "upstream" repository on the local disk; nothing is pushed anywhere, there is no network) with no
// NimbleNewt files; the host finds the project's own guidance at the task's base and checks the contribution's diff with the controller's own scan (credential shapes plus the secret values the installation uses).
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = hasGit ? false : "git is not installed";
const sh = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "core.hooksPath=/nonexistent-hooks", "-c", "core.autocrlf=false", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always", ...args], { cwd, encoding: "utf8" }).trim();
const scope = { taskId: "tsk-fix", projectId: "prj-oss" };
// A value the secret store holds (made at run time, never a real one).
const STORED = ["orchard", "blue", "kettle", "twenty", "nine"].join("-");

test("an ordinary checkout from an upstream with its own guidance: the guidance is found as it is, the controller's scan blocks a stored secret written in another encoding, the fix alone passes, and nothing NimbleNewt reaches the tree (card P05)", { skip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "nn-p05i-"));
  try {
    const seed = join(dir, "seed");
    await mkdir(join(seed, "lib"), { recursive: true });
    sh(dir, "init", "-q", "-b", "main", seed);
    await writeFile(join(seed, "lib", "parse.js"), "export const parse = (s) => s.split(',');\n");
    await writeFile(join(seed, "CONTRIBUTING.md"), "Add a test with every fix. Sign off each commit (DCO).\n");
    await writeFile(join(seed, ".gitignore"), "node_modules/\n");
    sh(seed, "add", "-A"); sh(seed, "commit", "-q", "-m", "upstream");
    const upstream = join(dir, "upstream.git");
    sh(dir, "clone", "-q", "--bare", seed, upstream);
    const upstreamRefs = sh(upstream, "for-each-ref");
    const shared = join(dir, "checkout");
    sh(dir, "clone", "-q", upstream, shared);
    await writeFile(join(shared, "scratch-of-mine.txt"), "the owner's own\n");
    const ownerState = sh(shared, "status", "--porcelain=v1", "--untracked-files=all");
    const git = await GitBridge.create({ scratch: join(dir, "scratch") });
    const ws = new LocalWorkspaces({ root: join(dir, "work"), git, shared: (p) => (p === "prj-oss" ? shared : undefined), busy: () => [], landing: () => ({ branch: "main", requirePermit: false }), clock: () => "2026-11-27T10:00:00.000Z" });
    const scan = createWipScanner({ secrets: () => [{ name: "provider-key", value: STORED }] });

    const made = await ws.ensure({ ...scope, attemptId: "att-1" });
    const guidance = (await ws.instructions(scope, scan))!;
    assert.deepEqual(guidance.files.map((f) => [f.path, f.text]), [["CONTRIBUTING.md", "Add a test with every fix. Sign off each commit (DCO).\n"]]);
    assert.equal(guidance.signOff, true);

    await writeFile(join(made.checkout, "lib", "parse.js"), "export const parse = (s) => s.split(',').map((x) => x.trim());\n");
    await mkdir(join(made.checkout, "test"));
    await writeFile(join(made.checkout, "test", "parse.test.js"), "// trims\n");
    await writeFile(join(made.checkout, "test", "fixture.txt"), Buffer.from(`value: ${STORED}\n`, "utf16le"));
    await writeFile(join(made.checkout, "PLAN.md"), "- [x] fix\n");
    const staged = await ws.stageWork(scope);
    const blocked = (await ws.contributionCheck({ ...scope, base: staged.base, tree: staged.tree, intended: ["lib/parse.js", "test/"] }, scan))!;
    assert.equal(blocked.ok, false);
    assert.deepEqual(blocked.blocked.map((b) => [b.path, b.kinds, b.reasons]), [
      ["PLAN.md", ["nimblenewt-state", "unrelated"], ["NimbleNewt's own state (a plan, a state folder or Git's data), which never goes into a contribution", "not among the files the task intends to change"]],
      ["test/fixture.txt", ["secret"], ["holds the value of the secret provider-key"]],
    ]);
    assert.ok(!JSON.stringify(blocked).includes(STORED));

    // The agent takes the fixture and its plan out; the fix alone passes.
    await rm(join(made.checkout, "test", "fixture.txt"));
    await rm(join(made.checkout, "PLAN.md"));
    const again = await ws.stageWork(scope);
    const clean = (await ws.contributionCheck({ ...scope, base: again.base, tree: again.tree, intended: ["lib/parse.js", "test/"] }, scan))!;
    assert.equal(clean.ok, true);
    assert.deepEqual(clean.files.map((f) => f.path).sort(), ["lib/parse.js", "test/parse.test.js"]);

    // Nothing left the machine or changed upstream, and the owner's checkout is as it was.
    assert.equal(sh(upstream, "for-each-ref"), upstreamRefs);
    assert.equal(sh(shared, "status", "--porcelain=v1", "--untracked-files=all"), ownerState);
    assert.equal(await readFile(join(shared, "scratch-of-mine.txt"), "utf8"), "the owner's own\n");
    assert.equal(sh(shared, "ls-files").split("\n").some((p) => /nimblenewt|^PLAN\.md$/i.test(p)), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
