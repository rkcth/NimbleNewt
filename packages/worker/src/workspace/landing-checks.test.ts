import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { SandboxLauncher, type LaunchRequest, type RunResult } from "../sandbox/index.js";
import { GitBridge, LocalWorkspaces, type HostWorkspaceCall, type LandingChecksOptions } from "./index.js";

// Card P09, the host side of the landing gate: the change a landing would carry (base, head, tree, patch ID of the committed change) and the project's test commands run in the sandbox on a fresh copy of exactly that tree.
// A landing told which tree its checks ran on lands only that tree.
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = hasGit ? false : "git is not installed";
const sh = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "core.hooksPath=/nonexistent-hooks", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
let counter = 0;
const rid = (): string => `wsr-${"bcdefghijklmnopq"}${"abcdefghijklmnopqrstuvwxyz".slice(counter, counter++ + 4)}`;
const call = (operation: HostWorkspaceCall["operation"], more: Partial<HostWorkspaceCall> = {}): HostWorkspaceCall => ({ requestId: rid(), operation, taskId: "tsk-one", projectId: "prj-one", reason: "test", quietAttempts: [], ...more });
const scope = { taskId: "tsk-one", projectId: "prj-one" };

/** A launcher that runs nothing: it records each request, reads the copy it was given, and ends as `end` says. */
const fakeLauncher = (end: (req: LaunchRequest, files: Record<string, string>) => Partial<RunResult> | Error) => {
  const seen: { req: LaunchRequest; files: Record<string, string>; workExisted: boolean }[] = [];
  const launcher = {
    async launch(req: LaunchRequest) {
      const files: Record<string, string> = {};
      const walk = async (d: string, prefix: string): Promise<void> => { for (const e of await readdir(d, { withFileTypes: true })) { if (e.isDirectory()) await walk(join(d, e.name), `${prefix}${e.name}/`); else files[`${prefix}${e.name}`] = await readFile(join(d, e.name), "utf8"); } };
      await walk(req.recipe.workdir, "");
      seen.push({ req, files, workExisted: existsSync(req.recipe.workdir) });
      const out = end(req, files);
      if (out instanceof Error) throw out;
      return { result: Promise.resolve({ exitCode: 0, signal: null, timedOut: false, killed: false, stdout: "", stderr: "", truncated: false, stdoutTruncated: false, durationMs: 3, ...out } as RunResult) } as never;
    },
  };
  return { launcher, seen };
};

async function world(checks?: Omit<LandingChecksOptions, "git" | "locate">) {
  const dir = await mkdtemp(join(tmpdir(), "nn-p09-"));
  const shared = join(dir, "shared");
  await mkdir(join(shared, "src"), { recursive: true });
  sh(dir, "init", "-q", "-b", "main", shared);
  await writeFile(join(shared, "src", "a.ts"), "export const a = 1;\n");
  sh(shared, "add", "-A"); sh(shared, "commit", "-q", "-m", "first");
  const git = await GitBridge.create({ scratch: join(dir, "scratch") });
  const ws = new LocalWorkspaces({ root: join(dir, "work"), git, shared: (p) => (p === "prj-one" ? shared : undefined), busy: () => [], landing: () => ({ branch: "main", requirePermit: false }), clock: () => "2026-11-18T10:00:00.000Z", ...(checks === undefined ? {} : { checks }) });
  const made = await ws.ensure(scope);
  const g = (...args: string[]) => sh(made.checkout, "--git-dir", made.gitDir, "--work-tree", made.checkout, ...args);
  return { dir, shared, git, ws, made, g, done: async () => { try { execFileSync("chmod", ["-R", "u+rwX", dir]); } catch { /* nothing */ } await rm(dir, { recursive: true, force: true }); } };
}

test("the committed change a landing would carry: base, head, the head's tree, and the same patch ID the staged submission had (card P09)", { skip }, async () => {
  const w = await world();
  try {
    const base = w.g("rev-parse", "HEAD");
    const none = await w.git.committedChange({ gitDir: w.made.gitDir });
    assert.deepEqual([none.base, none.head, none.patchId], [base, base, undefined], "nothing to land yet");
    await writeFile(join(w.made.checkout, "src", "a.ts"), "export const a = 2;\n");
    await writeFile(join(w.made.checkout, "bin.dat"), Buffer.from([0, 1, 2, 255]));
    const staged = await w.ws.stageWork(scope);
    w.g("commit", "-q", "-m", "work");
    const change = await w.git.committedChange({ gitDir: w.made.gitDir });
    assert.deepEqual([change.base, change.head, change.tree], [base, w.g("rev-parse", "HEAD"), w.g("rev-parse", "HEAD^{tree}")]);
    assert.equal(change.tree, staged.tree);
    assert.equal(change.patchId, staged.patchId, "the committed change has the patch ID of the submission that staged it");
    await assert.rejects(w.git.patchId({ gitDir: w.made.gitDir, base, to: "HEAD" }), /full object ID/);
  } finally { await w.done(); }
});

test("the patch ID of the reviewed base and tree is computed by the host from its own objects, not taken from the submission; one it cannot read is a problem, not an ID (card P09)", { skip }, async () => {
  const { launcher } = fakeLauncher(() => ({ exitCode: 0 }));
  const w = await world({ launcher });
  try {
    const base = w.g("rev-parse", "HEAD");
    await writeFile(join(w.made.checkout, "src", "a.ts"), "export const a = 2;\n");
    const staged = await w.ws.stageWork(scope);
    w.g("commit", "-q", "-m", "work");
    const port = w.ws.port.landingChecks!;
    const same = await port({ ...scope, checks: [], maxOutputBytes: 1000, reviewed: { base, tree: staged.tree } });
    assert.deepEqual([same.reviewedPatchId, same.reviewedProblem, same.change?.patchId], [staged.patchId, undefined, staged.patchId]);
    // Another reviewed tree (the work as it was before a later change): its own patch ID, which differs from the landed one.
    await writeFile(join(w.made.checkout, "src", "a.ts"), "export const a = 3;\n");
    const later = await w.ws.stageWork(scope);
    w.g("commit", "-q", "-m", "more");
    const old = await port({ ...scope, checks: [], maxOutputBytes: 1000, reviewed: { base, tree: staged.tree } });
    assert.equal(old.reviewedPatchId, staged.patchId);
    assert.notEqual(old.change?.patchId, staged.patchId);
    assert.equal(old.change?.patchId, (await port({ ...scope, checks: [], maxOutputBytes: 1000, reviewed: { base, tree: later.tree } })).reviewedPatchId);
    const missing = await port({ ...scope, checks: [], maxOutputBytes: 1000, reviewed: { base, tree: "9".repeat(40) } });
    assert.equal(missing.reviewedPatchId, undefined);
    assert.match(String(missing.reviewedProblem), /could not be read/);
    const empty = await port({ ...scope, checks: [], maxOutputBytes: 1000, reviewed: { base, tree: w.g("rev-parse", `${base}^{tree}`) } });
    assert.match(String(empty.reviewedProblem), /hold no change/);
    assert.equal((await port({ ...scope, checks: [], maxOutputBytes: 1000 })).reviewedPatchId, undefined, "not asked: not computed");
  } finally { await w.done(); }
});

test("a change in whitespace alone (a re-indented line, the spacing inside a string) is a different patch, so a review does not carry over to it (card P09 second review)", { skip }, async () => {
  const { launcher } = fakeLauncher(() => ({ exitCode: 0 }));
  const w = await world({ launcher });
  try {
    const base = w.g("rev-parse", "HEAD");
    await writeFile(join(w.made.checkout, "src", "b.py"), "for i in r:\n    a()\n    b()\nrun(\"-x\", \"a b\")\n");
    const reviewed = await w.ws.stageWork(scope);
    // After the review the author moves b() out of the loop and joins "a b": git's plain --stable patch ID strips all whitespace, so it would call these the same patch.
    await writeFile(join(w.made.checkout, "src", "b.py"), "for i in r:\n    a()\nb()\nrun(\"-x\", \"ab\")\n");
    const later = await w.ws.stageWork(scope);
    w.g("commit", "-q", "-m", "work");
    const stripped = (tree: string) => execFileSync("git", ["patch-id", "--stable"], { input: sh(w.made.checkout, "--git-dir", w.made.gitDir, "diff", "--binary", "--full-index", "--no-renames", base, tree) + "\n", encoding: "utf8" }).trim().split(/\s+/)[0];
    assert.equal(stripped(reviewed.tree), stripped(later.tree), "the whitespace-stripping ID would not tell them apart");
    assert.notEqual(later.patchId, reviewed.patchId);
    const report = await w.ws.port.landingChecks!({ ...scope, checks: [], maxOutputBytes: 1000, reviewed: { base, tree: reviewed.tree } });
    assert.equal(report.reviewedPatchId, reviewed.patchId);
    assert.equal(report.change?.patchId, later.patchId);
    assert.notEqual(report.change?.patchId, report.reviewedPatchId, "the landed change is not the reviewed patch");
  } finally { await w.done(); }
});

test("each test command runs in the sandbox on a fresh copy of the integrated tree, never the checkout: uncommitted files are not in it, the git directory is not mounted, the copy is removed; endings map to passed, failed and not run (card P09)", { skip }, async () => {
  const base = await mkdtemp(join(tmpdir(), "nn-p09-copies-"));
  const { launcher, seen } = fakeLauncher((req, files) => {
    const cmd = req.command.join(" ");
    if (cmd === "refuse") return new Error("a limit cannot be enforced");
    if (cmd === "missing") return { exitCode: null, stderr: "could not start: no such program" };
    if (cmd === "slow") return { exitCode: null, signal: "SIGKILL", timedOut: true, stdout: "still going" };
    return { exitCode: cmd !== "fail" && files["src/a.ts"]?.includes("2") === true ? 0 : 1, stdout: `read ${Object.keys(files).sort().join(",")}`, stderr: cmd === "fail" ? "boom" : "" };
  });
  const w = await world({ launcher, base, readOnly: [{ host: "/usr", guest: "/opt/tools" }], env: { CI: "1" }, limits: () => ({ wallTimeMs: 5000, memoryMb: 256 }) });
  try {
    await writeFile(join(w.made.checkout, "src", "a.ts"), "export const a = 2;\n");
    w.g("add", "-A"); w.g("commit", "-q", "-m", "work");
    // Written after the commit: not part of what lands, so not part of what the checks see.
    await writeFile(join(w.made.checkout, "src", "stray.ts"), "export const s = 1;\n");
    const checks = [{ name: "unit", run: ["node", "--test"], timeoutMs: 60_000 }, { name: "fail", run: ["fail"], timeoutMs: 1000 }, { name: "refused", run: ["refuse"], timeoutMs: 1000 }, { name: "missing", run: ["missing"], timeoutMs: 1000 }, { name: "slow", run: ["slow"], timeoutMs: 1000 }, { name: "empty", run: [], timeoutMs: 1000 }];
    const report = await w.ws.port.landingChecks!({ ...scope, checks, maxOutputBytes: 4096 });
    assert.equal(report.checkout, true);
    assert.deepEqual([report.change?.tree, report.change?.head], [w.g("rev-parse", "HEAD^{tree}"), w.g("rev-parse", "HEAD")]);
    assert.deepEqual(report.checks.map((c) => [c.name, c.state]), [["unit", "passed"], ["fail", "failed"], ["refused", "not-run"], ["missing", "not-run"], ["slow", "failed"], ["empty", "not-run"]]);
    assert.equal(report.checks[0]!.output, "read src/a.ts");
    assert.match(report.checks[1]!.output!, /boom/);
    assert.match(report.checks[2]!.reason!, /the sandbox refused the check: a limit cannot be enforced/);
    assert.match(report.checks[3]!.reason!, /could not be started: no such program/);
    assert.equal(report.checks[4]!.timedOut, true);
    // What the sandbox was given: a copy of the tree (no stray file, no .git), its own home and scratch, only the named read-only inputs, the environment, the time limit (the owner's wall time when smaller), the limits.
    const first = seen[0]!;
    assert.deepEqual(first.files, { "src/a.ts": "export const a = 2;\n" });
    assert.notEqual(first.req.recipe.workdir, w.made.checkout);
    assert.ok(first.req.recipe.workdir.startsWith(realpathSync.native(base)), first.req.recipe.workdir);
    assert.deepEqual(first.req.recipe.readOnly, [{ host: "/usr", guest: "/opt/tools" }]);
    assert.deepEqual([first.req.recipe.env, first.req.recipe.network, first.req.timeoutMs, first.req.maxOutputBytes, first.req.limits, first.req.requireEnforced], [{ CI: "1" }, "none", 5000, 4096, { memoryMb: 256 }, true]);
    assert.ok(![first.req.recipe.workdir, first.req.recipe.home, first.req.recipe.scratch].some((p) => p.startsWith(w.made.gitDir)));
    assert.equal(new Set(seen.map((s) => s.req.recipe.workdir)).size, seen.length, "each command gets a fresh copy");
    assert.deepEqual(await readdir(base), [], "every copy is removed");
    assert.equal(existsSync(join(w.made.checkout, "src", "stray.ts")), true, "the checkout is left as it was");
    // No checkout: nothing run; limits that cannot be read: not run.
    const elsewhere = await w.ws.port.landingChecks!({ taskId: "tsk-two", projectId: "prj-one", checks: checks.slice(0, 1), maxOutputBytes: 10 });
    assert.deepEqual([elsewhere.checkout, elsewhere.checks.map((c) => c.state)], [false, ["not-run"]]);
  } finally { await w.done(); await rm(base, { recursive: true, force: true }); }
});

test("limits that cannot be read and a best-effort owner: the check is not run, or runs without requiring full enforcement (card P09)", { skip }, async () => {
  const { launcher, seen } = fakeLauncher(() => ({}));
  let effort = false;
  let broken = false;
  const w = await world({ launcher, limits: () => { if (broken) throw new Error("settings unreadable"); return undefined; }, bestEffort: () => effort });
  try {
    const one = [{ name: "unit", run: ["t"], timeoutMs: 1000 }];
    assert.equal((await w.ws.port.landingChecks!({ ...scope, checks: one, maxOutputBytes: 10 })).checks[0]!.state, "passed");
    effort = true;
    await w.ws.port.landingChecks!({ ...scope, checks: one, maxOutputBytes: 10 });
    assert.deepEqual(seen.map((s) => s.req.requireEnforced), [true, false]);
    broken = true;
    const r = await w.ws.port.landingChecks!({ ...scope, checks: one, maxOutputBytes: 10 });
    assert.deepEqual([r.checks[0]!.state, r.checks[0]!.reason], ["not-run", "the owner's limits could not be read: settings unreadable"]);
    assert.equal(seen.length, 2);
    assert.equal(new LocalWorkspaces({ root: join(w.dir, "w2"), git: w.git, shared: () => undefined, busy: () => [] }).port.landingChecks, undefined, "no checks configured: the port cannot run them");
  } finally { await w.done(); }
});

test("a landing told which tree its checks ran on lands only that tree: work committed after the checks refuses it and writes nothing (card P09)", { skip }, async () => {
  const w = await world();
  try {
    await writeFile(join(w.made.checkout, "src", "a.ts"), "export const a = 2;\n");
    w.g("add", "-A"); w.g("commit", "-q", "-m", "work");
    const checked = w.g("rev-parse", "HEAD^{tree}");
    await writeFile(join(w.made.checkout, "src", "a.ts"), "export const a = 3;\n");
    w.g("add", "-A"); w.g("commit", "-q", "-m", "more after the checks");
    const refused = await w.ws.port.run(call("landing", { checkedTree: checked }));
    assert.equal(refused.ok, false);
    assert.match((refused as { reason: string }).reason, /is not the tree the landing's checks ran on/);
    assert.equal(await readFile(join(w.shared, "src", "a.ts"), "utf8"), "export const a = 1;\n", "nothing was written");
    assert.equal(sh(w.shared, "status", "--porcelain=v1"), "");
    assert.match(((await w.ws.port.run(call("refresh", { checkedTree: checked }))) as { reason: string }).reason, /only a landing names the tree its checks ran on/);
    assert.match(((await w.ws.port.run(call("landing", { checkedTree: "HEAD" }))) as { reason: string }).reason, /not a full object ID/);
    const landed = await w.ws.port.run(call("landing", { checkedTree: w.g("rev-parse", "HEAD^{tree}") }));
    assert.equal(landed.ok, true, JSON.stringify(landed));
    assert.equal(await readFile(join(w.shared, "src", "a.ts"), "utf8"), "export const a = 3;\n");
  } finally { await w.done(); }
});

test("in the real sandbox: a test command reads the integrated tree at /work and its exit decides; nothing of it is left (card P09)", { skip }, async (t) => {
  const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
  const launcher = await SandboxLauncher.create({ protectedPaths: [], audit: () => undefined });
  const usable = launcher.capacity.available && launcher.capacity.backend === "bubblewrap" && !["/usr", "/bin", "/lib"].includes(nodeRoot);
  if (!usable) {
    if (process.env["NIMBLENEWT_REQUIRE_SANDBOX"] === "1" && process.platform === "linux") assert.fail(`NIMBLENEWT_REQUIRE_SANDBOX=1 but the sandbox is unusable: ${launcher.capacity.reason ?? "?"}`);
    t.skip("bubblewrap or a node install it can mount is unusable"); await launcher.stop().catch(() => undefined); return;
  }
  const base = await mkdtemp(join(tmpdir(), "nn-p09-real-"));
  const w = await world({ launcher, base, readOnly: [{ host: nodeRoot, guest: "/opt/node" }] });
  try {
    await writeFile(join(w.made.checkout, "src", "a.ts"), "export const a = 2;\n");
    w.g("add", "-A"); w.g("commit", "-q", "-m", "work");
    await writeFile(join(w.made.checkout, "src", "a.ts"), "export const a = 99; // not committed\n");
    const read = "const s = require('node:fs').readFileSync('src/a.ts', 'utf8'); console.log(process.cwd() + ' ' + s.trim()); require('node:fs').writeFileSync('built.txt', 'x'); process.exit(s.includes('a = 2') ? 0 : 1);";
    const report = await w.ws.port.landingChecks!({ ...scope, checks: [{ name: "reads", run: ["/opt/node/bin/node", "-e", read], timeoutMs: 60_000 }, { name: "fails", run: ["/opt/node/bin/node", "-e", "process.exit(3)"], timeoutMs: 60_000 }], maxOutputBytes: 4096 });
    assert.deepEqual(report.checks.map((c) => [c.name, c.state, c.exitCode]), [["reads", "passed", 0], ["fails", "failed", 3]], JSON.stringify(report.checks));
    assert.match(report.checks[0]!.output!, /^\/work export const a = 2;/);
    assert.equal(existsSync(join(w.made.checkout, "built.txt")), false, "a file a check writes stays in its copy");
    assert.deepEqual(await readdir(base), []);
  } finally { await w.done(); await launcher.stop().catch(() => undefined); await rm(base, { recursive: true, force: true }); }
});
