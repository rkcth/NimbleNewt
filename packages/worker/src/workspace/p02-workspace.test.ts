import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { LaunchRequest, RunResult } from "../sandbox/index.js";
import { GitBridge, LocalWorkspaces, type HostWorkspaceCall, type LandingChecksOptions, type WorkspaceAdmissionAnswer } from "./index.js";

// Card P02: isolated coding workspaces. The workspace admits only a repository in the task's access scope; each attempt's initial working state is recorded; dirty and untracked work survives a killed host; a
// re-applied (restacked) submission has its landing checks run again on the re-applied tree; and a task leaves the shared checkout's own Git metadata (config, hooks, info, worktrees) as it was.
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = hasGit ? false : "git is not installed";
const sh = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "core.hooksPath=/nonexistent-hooks", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
let counter = 0;
const rid = (): string => { const n = counter++; return `wsr-pzzzzzzzzzzzzzzz${"abcdefghijklmnopqrstuvwxyz"[Math.floor(n / 26) % 26]}${"abcdefghijklmnopqrstuvwxyz"[n % 26]}aa`; };
const call = (operation: HostWorkspaceCall["operation"], more: Partial<HostWorkspaceCall> = {}): HostWorkspaceCall => ({ requestId: rid(), operation, taskId: "tsk-one", projectId: "prj-one", reason: "test", quietAttempts: [], ...more });
const scope = { taskId: "tsk-one", projectId: "prj-one" };
const S = "sbm-pppppppppppppppppppp";
const BINDING = { resourceId: "rsc-aaaaaaaaaaaaaaaaaaaa", repositoryId: "garden", locatorEpoch: 1 };

/** A launcher that runs nothing: it records the files of the copy each check was given and passes. */
const fakeLauncher = () => {
  const seen: Record<string, string>[] = [];
  const launcher = {
    async launch(req: LaunchRequest) {
      const files: Record<string, string> = {};
      const walk = async (d: string, prefix: string): Promise<void> => { for (const e of await readdir(d, { withFileTypes: true })) { if (e.isDirectory()) await walk(join(d, e.name), `${prefix}${e.name}/`); else files[`${prefix}${e.name}`] = await readFile(join(d, e.name), "utf8"); } };
      await walk(req.recipe.workdir, "");
      seen.push(files);
      return { result: Promise.resolve({ exitCode: 0, signal: null, timedOut: false, killed: false, stdout: "", stderr: "", truncated: false, stdoutTruncated: false, durationMs: 1 } as RunResult) } as never;
    },
  };
  return { launcher, seen };
};

async function world(options: { admit?: (call: { taskId: string; projectId: string; shared: string }) => Promise<WorkspaceAdmissionAnswer>; checks?: Omit<LandingChecksOptions, "git" | "locate"> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "nn-p02-"));
  const shared = join(dir, "shared");
  await mkdir(join(shared, "src"), { recursive: true });
  await mkdir(join(shared, "docs"), { recursive: true });
  sh(dir, "init", "-q", "-b", "main", shared);
  await writeFile(join(shared, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(join(shared, "docs", "c.md"), "# c\n");
  sh(shared, "add", "-A"); sh(shared, "commit", "-q", "-m", "first");
  const git = await GitBridge.create({ scratch: join(dir, "scratch") });
  const root = join(dir, "work");
  const make = () => new LocalWorkspaces({ root, git, shared: (p) => (p === "prj-one" ? shared : undefined), busy: () => [], landing: () => ({ branch: "main", requirePermit: false }), clock: () => "2026-11-26T10:00:00.000Z", ...(options.admit === undefined ? {} : { admit: options.admit }), ...(options.checks === undefined ? {} : { checks: options.checks }) });
  return { dir, shared, root, git, ws: make(), make, done: async () => { try { execFileSync("chmod", ["-R", "u+rwX", dir]); } catch { /* nothing */ } await rm(dir, { recursive: true, force: true }); } };
}
const gitOf = (made: { checkout: string; gitDir: string }) => (...args: string[]): string => sh(made.checkout, "--git-dir", made.gitDir, "--work-tree", made.checkout, ...args);

test("the workspace opens only when the admission says so: a refusal or a failing check makes nothing and says why; a binding narrowed later refuses the next hand-out and keeps the work (card P02)", { skip }, async () => {
  let answer: WorkspaceAdmissionAnswer | Error = { admitted: false, reason: "the repository folder this host would use is not bound to the project; bind it to the project with write access first (resource.bind)" };
  const asked: { taskId: string; projectId: string; shared: string }[] = [];
  const w = await world({ admit: async (c) => { asked.push(c); if (answer instanceof Error) throw answer; return answer; } });
  try {
    await assert.rejects(w.ws.ensure({ ...scope, attemptId: "att-1" }), /the workspace was not opened: the repository folder this host would use is not bound to the project/);
    assert.deepEqual(asked, [{ taskId: "tsk-one", projectId: "prj-one", shared: w.shared }], "asked with the folder the host would use");
    assert.equal(existsSync(w.root), false, "nothing was made");
    answer = new Error("the store is down");
    await assert.rejects(w.ws.ensure({ ...scope, attemptId: "att-1" }), /whether the task may use this repository could not be checked \(the store is down\)/);
    answer = { admitted: false } as never;
    await assert.rejects(w.ws.ensure({ ...scope, attemptId: "att-1" }), /the task's access scope does not admit this repository/, "an answer without a reason is still a refusal");
    assert.equal(existsSync(w.root), false);
    answer = { admitted: true, binding: BINDING };
    const made = await w.ws.ensure({ ...scope, attemptId: "att-1" });
    await writeFile(join(made.checkout, "src", "a.ts"), "export const a = 2; // work\n");
    // Narrowed (read only) between attempts: refused, and the checkout with its work is still there for when it is admitted again.
    answer = { admitted: false, reason: "the project has read access only to repository \"garden\", and an agent's workspace is written in; give the project write access to it first" };
    await assert.rejects(w.ws.ensure({ ...scope, attemptId: "att-2" }), /has read access only to repository "garden"/);
    assert.equal(await readFile(join(made.checkout, "src", "a.ts"), "utf8"), "export const a = 2; // work\n");
    assert.equal(w.ws.locate(scope)?.checkout, made.checkout, "the operations still find the checkout (landing, refresh and quarantine are judged by the controller)");
    answer = { admitted: true, binding: BINDING };
    assert.deepEqual(await w.ws.ensure({ ...scope, attemptId: "att-2" }), made);
    // A host without an admission check opens as before (tests, and a remote host configured by its operator).
    const open = new LocalWorkspaces({ root: join(w.dir, "w2"), git: w.git, shared: () => w.shared, busy: () => [] });
    assert.ok((await open.ensure(scope)).checkout);
  } finally { await w.done(); }
});

test("each attempt records the state it starts from once: base, HEAD, the checkout's tree, the changed and untracked files, a digest and the binding; the checkout's own index is not touched (card P02)", { skip }, async () => {
  const w = await world({ admit: async () => ({ admitted: true, binding: { ...BINDING, label: "garden", pinned: true } }) });
  try {
    const made = await w.ws.ensure({ ...scope, attemptId: "att-1" });
    const g = gitOf(made);
    const base = g("rev-parse", "refs/nn/base");
    const first = (await w.ws.startState({ ...scope, attemptId: "att-1" }))!;
    assert.deepEqual([first.attemptId, first.taskId, first.projectId, first.recordedAt, first.base, first.head, first.fileCount, first.files], ["att-1", "tsk-one", "prj-one", "2026-11-26T10:00:00.000Z", base, base, 0, []]);
    assert.equal(first.tree, g("rev-parse", "HEAD^{tree}"), "a clean checkout's tree is its HEAD's");
    assert.deepEqual(first.binding, BINDING, "the binding that admitted it (only its identity is kept)");
    // The agent works: a changed file, a new file, a removed file, and an ignored one (not part of the state).
    await writeFile(join(made.checkout, "src", "a.ts"), "export const a = 2;\n");
    await mkdir(join(made.checkout, "notes"));
    await writeFile(join(made.checkout, "notes", "draft.md"), "draft\n");
    await rm(join(made.checkout, "docs", "c.md"));
    await writeFile(join(made.checkout, ".gitignore"), "*.log\n");
    await writeFile(join(made.checkout, "build.log"), "noise\n");
    const indexBefore = createHash("sha256").update(readFileSync(join(made.gitDir, "index"))).digest("hex");
    // A second hand-out of the same attempt (a resume) keeps the first record.
    await w.ws.ensure({ ...scope, attemptId: "att-1" });
    assert.deepEqual(await w.ws.startState({ ...scope, attemptId: "att-1" }), first);
    const second = (await w.ws.ensure({ ...scope, attemptId: "att-2" }), (await w.ws.startState({ ...scope, attemptId: "att-2" }))!);
    assert.deepEqual(second.files, [{ code: "??", path: ".gitignore" }, { code: " D", path: "docs/c.md" }, { code: "??", path: "notes/draft.md" }, { code: " M", path: "src/a.ts" }]);
    assert.equal(second.fileCount, 4);
    assert.notEqual(second.digest, first.digest);
    assert.notEqual(second.tree, first.tree);
    // The tree is the checkout's content as it stood: the new file is in it with its content, the ignored one is not.
    assert.equal(sh(made.checkout, "--git-dir", made.gitDir, "cat-file", "-p", `${second.tree}:notes/draft.md`), "draft");
    assert.throws(() => sh(made.checkout, "--git-dir", made.gitDir, "cat-file", "-e", `${second.tree}:build.log`));
    assert.equal(createHash("sha256").update(readFileSync(join(made.gitDir, "index"))).digest("hex"), indexBefore, "the checkout's own index is not touched");
    // The same state gives the same digest; a change in content alone (same file list) gives another.
    const third = (await w.ws.ensure({ ...scope, attemptId: "att-3" }), (await w.ws.startState({ ...scope, attemptId: "att-3" }))!);
    assert.equal(third.digest, second.digest);
    await writeFile(join(made.checkout, "notes", "draft.md"), "draft, edited\n");
    const fourth = (await w.ws.ensure({ ...scope, attemptId: "att-4" }), (await w.ws.startState({ ...scope, attemptId: "att-4" }))!);
    assert.deepEqual(fourth.files, second.files);
    assert.notEqual(fourth.digest, second.digest);
    // Kept beside the checkout, never inside it (the sandbox mounts only the checkout).
    assert.deepEqual(readdirSync(join(w.root, "prj-one", "tsk-one", "starts")).sort(), ["att-1.json", "att-2.json", "att-3.json", "att-4.json"]);
    assert.equal(existsSync(join(made.checkout, "starts")), false);
    // No attempt named, no record; an unknown or malformed attempt reads as none.
    await w.ws.ensure(scope);
    assert.equal(readdirSync(join(w.root, "prj-one", "tsk-one", "starts")).length, 4);
    assert.equal(await w.ws.startState({ ...scope, attemptId: "att-9" }), undefined);
    assert.equal(await w.ws.startState({ ...scope, attemptId: "../x" }), undefined);
  } finally { await w.done(); }
});

test("a start record that cannot be written refuses the workspace: no attempt starts without a record of what it started from (card P02)", { skip }, async () => {
  const w = await world();
  try {
    const made = await w.ws.ensure(scope);
    // The place of the records is taken by a file.
    await writeFile(join(w.root, "prj-one", "tsk-one", "starts"), "in the way\n");
    await assert.rejects(w.ws.ensure({ ...scope, attemptId: "att-1" }), /the state the attempt starts from could not be recorded/);
    await rm(join(w.root, "prj-one", "tsk-one", "starts"));
    assert.deepEqual(await w.ws.ensure({ ...scope, attemptId: "att-1" }), made);
    assert.equal((await w.ws.startState({ ...scope, attemptId: "att-1" }))?.binding, undefined, "a host that asks no admission records no binding");
  } finally { await w.done(); }
});

test("dirty and untracked work survives a host that is killed: the next attempt, on a restarted host, works in the same checkout and its start record lists that work (card P02)", { skip }, async () => {
  const w = await world();
  try {
    const made = await w.ws.ensure({ ...scope, attemptId: "att-1" });
    await writeFile(join(made.checkout, "src", "a.ts"), "export const a = 2; // unsaved\n");
    await writeFile(join(made.checkout, "src", "new.ts"), "export const n = 1;\n");
    // A second host process takes the next attempt, writes more untracked work, and is killed with nothing shut down.
    const child = join(w.dir, "child.mjs");
    await writeFile(child, [
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "const [indexUrl, root, shared, scratch] = process.argv.slice(2);",
      "const { GitBridge, LocalWorkspaces } = await import(indexUrl);",
      "const git = await GitBridge.create({ scratch });",
      "const ws = new LocalWorkspaces({ root, git, shared: () => shared, busy: () => [] });",
      "const made = await ws.ensure({ taskId: 'tsk-one', projectId: 'prj-one', attemptId: 'att-2' });",
      "mkdirSync(join(made.checkout, 'notes'), { recursive: true });",
      "writeFileSync(join(made.checkout, 'notes', 'half.md'), 'half written\\n');",
      "process.stdout.write('ready\\n');",
      "setInterval(() => {}, 1000);",
    ].join("\n"));
    const indexUrl = new URL("./index.js", import.meta.url).href;
    const proc = spawn(process.execPath, [child, indexUrl, w.root, w.shared, join(w.dir, "scratch2")], { stdio: ["ignore", "pipe", "pipe"] });
    let errors = "";
    proc.stderr.on("data", (d: Buffer) => { errors += d.toString(); });
    await new Promise<void>((resolve, reject) => {
      proc.stdout.on("data", (d: Buffer) => { if (d.toString().includes("ready")) resolve(); });
      proc.on("exit", (code) => reject(new Error(`the child ended (${code}) before it was ready: ${errors}`)));
    });
    const ended = new Promise((resolve) => proc.on("exit", resolve));
    proc.kill("SIGKILL");
    await ended;
    // The host starts again (a new process: a new LocalWorkspaces over the same folders) and the next attempt starts.
    const restarted = w.make();
    const again = await restarted.ensure({ ...scope, attemptId: "att-3" });
    assert.deepEqual(again, made, "the same checkout, not a fresh one");
    assert.equal(await readFile(join(again.checkout, "src", "a.ts"), "utf8"), "export const a = 2; // unsaved\n");
    assert.equal(await readFile(join(again.checkout, "src", "new.ts"), "utf8"), "export const n = 1;\n");
    assert.equal(await readFile(join(again.checkout, "notes", "half.md"), "utf8"), "half written\n", "the killed host's untracked file is there");
    const start = (await restarted.startState({ ...scope, attemptId: "att-3" }))!;
    assert.deepEqual(start.files, [{ code: "??", path: "notes/half.md" }, { code: " M", path: "src/a.ts" }, { code: "??", path: "src/new.ts" }]);
    assert.ok((await restarted.startState({ ...scope, attemptId: "att-2" }))?.digest, "the killed attempt's own start record is whole");
    const done = (await restarted.doneState(scope, []))!;
    assert.deepEqual(done.uncommitted.sort(), ["notes/half.md", "src/a.ts", "src/new.ts"]);
    assert.equal(sh(w.shared, "status", "--porcelain=v1"), "", "none of it reached the shared repository");
  } finally { await w.done(); }
});

test("a restacked submission's landing checks run again on the re-applied tree: checks of the approved tree do not cover the re-applied landing, checks of the re-applied tree do (card P02 with P09 and P10)", { skip }, async () => {
  const { launcher, seen } = fakeLauncher();
  const base = await mkdtemp(join(tmpdir(), "nn-p02-copies-"));
  const w = await world({ checks: { launcher, base, readOnly: [], limits: () => undefined } });
  try {
    const made = await w.ws.ensure(scope);
    const g = gitOf(made);
    const approvedBase = g("rev-parse", "refs/nn/base");
    await writeFile(join(made.checkout, "src", "a.ts"), "export const a = 2;\n");
    g("add", "-A"); g("commit", "-q", "-m", "approved work");
    const approvedTree = g("rev-parse", "HEAD^{tree}");
    const checks = [{ name: "unit", run: ["node", "--test"], timeoutMs: 60_000 }];
    const before = await w.ws.port.landingChecks!({ ...scope, checks, maxOutputBytes: 1024 });
    assert.deepEqual([before.change?.tree, before.checks[0]!.state], [approvedTree, "passed"]);
    assert.deepEqual(Object.keys(seen[0]!).sort(), ["docs/c.md", "src/a.ts"]);
    // The landing branch moves on (another file only), so the approved change is re-applied onto its head.
    await writeFile(join(w.shared, "docs", "d.md"), "# d\n");
    sh(w.shared, "add", "-A"); sh(w.shared, "commit", "-q", "-m", "other work landed");
    const head = sh(w.shared, "rev-parse", "HEAD");
    const out = await w.ws.port.restack({ requestId: rid(), ...scope, submission: { id: S, base: approvedBase, tree: approvedTree } });
    assert.equal((out as { state: string }).state, "reapplied", JSON.stringify(out));
    const re = out as { base: string; tree: string };
    assert.equal(re.base, head);
    assert.notEqual(re.tree, approvedTree);
    // The checks that ran on the approved tree do not let the re-applied change land.
    const stale = await w.ws.port.run(call("landing", { submission: { id: S, base: head, tree: re.tree }, reappliedFrom: { base: approvedBase, tree: approvedTree }, checkedTree: approvedTree }));
    assert.equal(stale.ok, false);
    assert.match((stale as { reason: string }).reason, /is not the tree the landing's checks ran on/);
    assert.equal(sh(w.shared, "status", "--porcelain=v1"), "", "nothing was written");
    // Run again: they see the re-applied tree (the head's new file and the approved change together).
    const after = await w.ws.port.landingChecks!({ ...scope, checks, maxOutputBytes: 1024 });
    assert.deepEqual([after.change?.tree, after.change?.base, after.checks[0]!.state], [re.tree, head, "passed"]);
    assert.deepEqual(seen[1], { "docs/c.md": "# c\n", "docs/d.md": "# d\n", "src/a.ts": "export const a = 2;\n" });
    const landed = await w.ws.port.run(call("landing", { submission: { id: S, base: head, tree: re.tree }, reappliedFrom: { base: approvedBase, tree: approvedTree }, checkedTree: after.change!.tree }));
    assert.equal(landed.ok, true, JSON.stringify(landed));
    assert.equal(await readFile(join(w.shared, "src", "a.ts"), "utf8"), "export const a = 2;\n");
    assert.equal(await readFile(join(w.shared, "docs", "d.md"), "utf8"), "# d\n");
  } finally { await w.done(); await rm(base, { recursive: true, force: true }); }
});

/** The shared checkout's own Git metadata: every file of `.git/config`, `.git/hooks`, `.git/info` and `.git/worktrees`, by path, with its content's hash (a missing part is listed as missing). */
function metadata(shared: string): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (rel: string): void => {
    const abs = join(shared, ".git", rel);
    if (!existsSync(abs)) { out[rel] = "missing"; return; }
    if (statSync(abs).isDirectory()) { const names = readdirSync(abs).sort(); if (names.length === 0) out[`${rel}/`] = "empty"; for (const n of names) add(`${rel}/${n}`); return; }
    out[rel] = createHash("sha256").update(readFileSync(abs)).digest("hex");
  };
  for (const part of ["config", "hooks", "info", "worktrees"]) add(part);
  return out;
}

test("a task leaves the shared checkout's Git metadata as it was: .git/config, hooks, info and worktrees are byte for byte unchanged after every workspace operation, and no hook of it runs (card P02)", { skip }, async () => {
  const { launcher } = fakeLauncher();
  const w = await world({ checks: { launcher, readOnly: [], limits: () => undefined } });
  try {
    // A shared checkout with things of its own in each place: a setting, a hook that would leave a mark if run, an exclude line.
    sh(w.shared, "config", "nn.test", "kept");
    const mark = join(w.dir, "hook-ran");
    for (const hook of ["post-commit", "pre-commit", "post-checkout", "post-merge", "reference-transaction"]) await writeFile(join(w.shared, ".git", "hooks", hook), `#!/bin/sh\necho ${hook} >> '${mark}'\n`, { mode: 0o755 });
    await mkdir(join(w.shared, ".git", "info"), { recursive: true });
    await writeFile(join(w.shared, ".git", "info", "exclude"), "local-only/\n");
    const before = metadata(w.shared);
    assert.equal(before["worktrees"], "missing");

    const made = await w.ws.ensure({ ...scope, attemptId: "att-1" });
    const g = gitOf(made);
    await writeFile(join(made.checkout, "src", "a.ts"), "export const a = 2;\n");
    await writeFile(join(made.checkout, "src", "new.ts"), "export const n = 1;\n");
    await w.ws.progress(scope);
    await w.ws.doneState(scope, ["src/new.ts"]);
    await w.ws.submitView(scope);
    await w.ws.stageWork(scope);
    assert.equal((await w.ws.port.run(call("integration"))).ok, true);
    g("add", "-A"); g("commit", "-q", "-m", "work");
    await w.ws.port.landingChecks!({ ...scope, checks: [{ name: "unit", run: ["t"], timeoutMs: 1000 }], maxOutputBytes: 10 });
    sh(w.shared, "checkout", "-q", "--", ".");
    sh(w.shared, "clean", "-qfd");
    const landed = await w.ws.port.run(call("landing"));
    assert.equal(landed.ok, true, JSON.stringify(landed));
    sh(w.shared, "add", "-A"); sh(w.shared, "commit", "-q", "--no-verify", "-m", "landed");
    assert.equal((await w.ws.port.run(call("refresh"))).ok, true);
    await w.ws.ensure({ ...scope, attemptId: "att-2" });
    assert.equal((await w.ws.port.run(call("quarantine"))).ok, true);

    assert.deepEqual(metadata(w.shared), before, "config, hooks, info and worktrees unchanged");
    assert.equal(sh(w.shared, "config", "nn.test"), "kept");
    assert.equal(sh(w.shared, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length, 1, "no worktree was added to the shared repository");
    assert.equal(existsSync(mark), false, `no hook of the shared checkout ran: ${existsSync(mark) ? readFileSync(mark, "utf8") : ""}`);
    assert.equal(existsSync(join(w.shared, ".git", "nn")), false, "nothing of the platform's own under the shared .git");
  } finally { await w.done(); }
});

