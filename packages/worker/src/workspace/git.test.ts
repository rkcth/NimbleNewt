import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ABSENT, GitBridge, WorkspaceBridge, WorkspaceError, versionOf } from "./index.js";

const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = hasGit ? false : "git is not installed";
const refuses = async (code: string, run: () => Promise<unknown>): Promise<void> => {
  await assert.rejects(run, (e: unknown) => { assert.ok(e instanceof WorkspaceError, String(e)); assert.equal(e.code, code, e.message); return true; });
};
const sh = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "core.hooksPath=/nonexistent-hooks", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();

async function world() {
  const dir = await mkdtemp(join(tmpdir(), "nn-git-"));
  const shared = join(dir, "shared");
  await mkdir(join(shared, "src"), { recursive: true });
  sh(dir, "init", "-q", "-b", "main", shared);
  await writeFile(join(shared, "README.md"), "hello\n"); await writeFile(join(shared, "src", "a.ts"), "export const a = 1;\n"); await writeFile(join(shared, "src", "b.ts"), "export const b = 1;\n");
  sh(shared, "add", "-A"); sh(shared, "commit", "-q", "-m", "first");
  const git = await GitBridge.create({ scratch: join(dir, "scratch") });
  const bridge = new WorkspaceBridge({ shared, state: join(dir, "state"), clock: () => "2026-10-22T14:00:00.000Z" });
  const gitDir = join(dir, "task.git"); const checkout = join(dir, "checkout");
  const commit = await git.head(shared);
  await git.createCheckout({ shared, commit, gitDir, checkout });
  return { dir, shared, git, bridge, gitDir, checkout, commit, done: () => rm(dir, { recursive: true, force: true }) };
}

test("a checkout has the files and no .git; its repository is elsewhere", { skip }, async () => {
  const w = await world();
  try {
    assert.deepEqual((await readdir(w.checkout)).sort(), ["README.md", "src"]);
    assert.equal(existsSync(join(w.checkout, ".git")), false);
    assert.equal(await readFile(join(w.checkout, "src", "a.ts"), "utf8"), "export const a = 1;\n");
    assert.deepEqual(await w.git.status({ gitDir: w.gitDir, checkout: w.checkout }), { dirty: false, entries: [] });
    await refuses("invalid_path", () => w.git.createCheckout({ shared: w.shared, commit: "main", gitDir: join(w.dir, "x.git"), checkout: join(w.dir, "y") }));
    await refuses("invalid_path", () => w.git.createCheckout({ shared: w.shared, commit: w.commit, gitDir: join(w.dir, "z.git"), checkout: w.checkout }));
  } finally { await w.done(); }
});

test("the agent's changes reach the shared workspace only through expected-version writes: modified, new and deleted files", { skip }, async () => {
  const w = await world();
  try {
    await writeFile(join(w.checkout, "src", "a.ts"), "export const a = 2;\n");
    await writeFile(join(w.checkout, "src", "new.ts"), "export const n = 1;\n");
    await rm(join(w.checkout, "src", "b.ts"));
    const changes = await w.git.changes({ gitDir: w.gitDir, checkout: w.checkout });
    assert.deepEqual(changes.map((c) => [c.path, c.op]).sort(), [["src/a.ts", "write"], ["src/b.ts", "delete"], ["src/new.ts", "write"]]);
    const results = await w.git.integrate({ gitDir: w.gitDir, checkout: w.checkout, bridge: w.bridge, author: "agent:ann", reason: "task work" });
    assert.deepEqual(results.map((r) => r.result.status), ["written", "written", "written"]);
    assert.equal(await readFile(join(w.shared, "src", "a.ts"), "utf8"), "export const a = 2;\n");
    assert.equal(existsSync(join(w.shared, "src", "b.ts")), false);
    assert.equal(await readFile(join(w.shared, "src", "new.ts"), "utf8"), "export const n = 1;\n");
  } finally { await w.done(); }
});

test("a file someone else changed meanwhile is not overwritten: the agent's change is kept for review, the others go through", { skip }, async () => {
  const w = await world();
  try {
    await writeFile(join(w.checkout, "src", "a.ts"), "export const a = 'agent';\n");
    await writeFile(join(w.checkout, "README.md"), "agent readme\n");
    await writeFile(join(w.shared, "src", "a.ts"), "export const a = 'someone else';\n");
    const results = await w.git.integrate({ gitDir: w.gitDir, checkout: w.checkout, bridge: w.bridge, author: "agent:ann", reason: "task work" });
    const byPath = Object.fromEntries(results.map((r) => [r.path, r.result.status]));
    assert.deepEqual(byPath, { "README.md": "written", "src/a.ts": "rejected" });
    assert.equal(await readFile(join(w.shared, "src", "a.ts"), "utf8"), "export const a = 'someone else';\n");
    const [kept] = await w.bridge.pending();
    assert.equal(Buffer.from(kept!.content!, "base64").toString(), "export const a = 'agent';\n");
    assert.equal(kept!.expectedVersion, versionOf(Buffer.from("export const a = 1;\n")));
    // The checkout still holds the agent's work.
    assert.equal(await readFile(join(w.checkout, "src", "a.ts"), "utf8"), "export const a = 'agent';\n");
  } finally { await w.done(); }
});

test("a .git the agent creates in the checkout, in any spelling or place, refuses the whole change and nothing is written", { skip }, async () => {
  for (const make of [
    async (c: string) => { await mkdir(join(c, ".git", "hooks"), { recursive: true }); await writeFile(join(c, ".git", "config"), "[core]\n"); },
    async (c: string) => { await writeFile(join(c, "src", ".git"), "gitdir: /tmp/elsewhere\n"); },
    async (c: string) => { await mkdir(join(c, "src", ".GIT"), { recursive: true }); await writeFile(join(c, "src", ".GIT", "HEAD"), "ref: refs/heads/x\n"); },
    async (c: string) => { await mkdir(join(c, "src", ".g​it")); await writeFile(join(c, "src", ".g​it", "x"), "x"); },
  ]) {
    const w = await world();
    try {
      await writeFile(join(w.checkout, "README.md"), "an honest change\n");
      await make(w.checkout);
      await refuses("protected_path", () => w.git.changes({ gitDir: w.gitDir, checkout: w.checkout }));
      await refuses("protected_path", () => w.git.integrate({ gitDir: w.gitDir, checkout: w.checkout, bridge: w.bridge, author: "agent:ann", reason: "x" }));
      assert.equal(await readFile(join(w.shared, "README.md"), "utf8"), "hello\n", "not even the honest change was written");
      assert.deepEqual(await w.bridge.pending(), []);
    } finally { await w.done(); }
  }
});

test("hooks, filters and configuration the agent or a repository names never run", { skip: skip || (process.platform === "win32" ? "POSIX shell scripts" : false) }, async () => {
  const w = await world();
  try {
    const marker = join(w.dir, "RAN");
    const script = `#!/bin/sh\ntouch ${marker}\n`;
    // Hooks in the shared repository, in the checkout's own repository, and a hooks path set in its configuration: none may run.
    await mkdir(join(w.shared, ".git", "hooks"), { recursive: true });
    for (const hook of ["pre-commit", "post-checkout", "post-merge", "pre-push", "fsmonitor-watchman", "post-index-change"]) {
      await writeFile(join(w.shared, ".git", "hooks", hook), script, { mode: 0o755 });
      await mkdir(join(w.gitDir, "hooks"), { recursive: true });
      await writeFile(join(w.gitDir, "hooks", hook), script, { mode: 0o755 });
    }
    await mkdir(join(w.dir, "evil-hooks"));
    for (const hook of ["post-checkout", "pre-commit", "post-index-change"]) await writeFile(join(w.dir, "evil-hooks", hook), script, { mode: 0o755 });
    sh(w.dir, "--git-dir", w.gitDir, "config", "core.hooksPath", join(w.dir, "evil-hooks"));
    sh(w.dir, "--git-dir", w.gitDir, "config", "core.fsmonitor", script.replace(/\n/g, " ").slice(0, 0) + join(w.dir, "evil-hooks", "pre-commit"));
    sh(w.dir, "--git-dir", w.gitDir, "config", "diff.external", join(w.dir, "evil-hooks", "pre-commit"));
    // The agent's own files: attributes naming a filter, a submodule file, a config-looking file.
    await writeFile(join(w.checkout, ".gitattributes"), "* filter=evil\n*.ts diff=evil\n");
    await writeFile(join(w.checkout, ".gitmodules"), `[submodule "x"]\n\tpath = x\n\turl = file://${w.dir}/evil\n`);
    await writeFile(join(w.checkout, "src", "a.ts"), "export const a = 99;\n");
    await w.git.status({ gitDir: w.gitDir, checkout: w.checkout });
    await w.git.changes({ gitDir: w.gitDir, checkout: w.checkout });
    await w.git.integrate({ gitDir: w.gitDir, checkout: w.checkout, bridge: w.bridge, author: "agent:ann", reason: "x" });
    await writeFile(join(w.shared, "README.md"), "moved on\n"); sh(w.shared, "add", "-A"); sh(w.shared, "commit", "-q", "-m", "second");
    await rm(join(w.checkout, ".gitattributes")); await rm(join(w.checkout, ".gitmodules")); await writeFile(join(w.checkout, "src", "a.ts"), "export const a = 1;\n");
    await w.git.refresh({ shared: w.shared, commit: await w.git.head(w.shared), gitDir: w.gitDir, checkout: w.checkout });
    assert.equal(existsSync(marker), false, "no hook, filter or external program ran");
    assert.equal(existsSync(join(w.dir, "evil")), false);
  } finally { await w.done(); }
});

test("dirty work is never replaced: a refresh over changed or new files refuses and leaves everything; a clean checkout moves to the new base", { skip }, async () => {
  const w = await world();
  try {
    await writeFile(join(w.shared, "README.md"), "moved on\n"); sh(w.shared, "add", "-A"); sh(w.shared, "commit", "-q", "-m", "second");
    const next = await w.git.head(w.shared);
    await writeFile(join(w.checkout, "README.md"), "my edit\n");
    await refuses("stale", () => w.git.refresh({ shared: w.shared, commit: next, gitDir: w.gitDir, checkout: w.checkout }));
    assert.equal(await readFile(join(w.checkout, "README.md"), "utf8"), "my edit\n");
    await rm(join(w.checkout, "README.md")); sh(w.dir, "--git-dir", w.gitDir, "--work-tree", w.checkout, "checkout", "-q", "--", "README.md");
    await writeFile(join(w.checkout, "untracked.txt"), "new work\n");
    await refuses("stale", () => w.git.refresh({ shared: w.shared, commit: next, gitDir: w.gitDir, checkout: w.checkout }));
    await rm(join(w.checkout, "untracked.txt"));
    assert.deepEqual(await w.git.refresh({ shared: w.shared, commit: next, gitDir: w.gitDir, checkout: w.checkout }), { base: next });
    assert.equal(await readFile(join(w.checkout, "README.md"), "utf8"), "moved on\n");
  } finally { await w.done(); }
});

test("a link the agent makes in the checkout is refused before anything is written", { skip: skip || (process.platform === "win32" ? "POSIX links" : false) }, async () => {
  const w = await world();
  try {
    await writeFile(join(w.checkout, "README.md"), "an honest change\n");
    await symlink("/etc/passwd", join(w.checkout, "passwd-link"));
    await refuses("link_refused", () => w.git.integrate({ gitDir: w.gitDir, checkout: w.checkout, bridge: w.bridge, author: "agent:ann", reason: "x" }));
    assert.equal(await readFile(join(w.shared, "README.md"), "utf8"), "hello\n");
    assert.equal(existsSync(join(w.shared, "passwd-link")), false);
  } finally { await w.done(); }
});

test("a commit ID that is not a full ID, and a missing shared repository, are refused", { skip }, async () => {
  const w = await world();
  try {
    await refuses("invalid_path", () => w.git.createCheckout({ shared: w.shared, commit: "HEAD", gitDir: join(w.dir, "q.git"), checkout: join(w.dir, "q") }));
    await assert.rejects(() => w.git.head(join(w.dir, "missing")));
    void ABSENT;
  } finally { await w.done(); }
});

test("files the agent's own ignore rules match are still its work: they are listed, integrated, and a refresh will not overwrite them", { skip }, async () => {
  const w = await world();
  try {
    await writeFile(join(w.checkout, ".gitignore"), "*\n!.gitignore\n");
    await writeFile(join(w.checkout, "report.txt"), "hidden by the agent's own rule\n");
    await mkdir(join(w.checkout, "out", "deep"), { recursive: true });
    await writeFile(join(w.checkout, "out", "deep", "data.bin"), "more work\n");
    const status = await w.git.status({ gitDir: w.gitDir, checkout: w.checkout });
    assert.equal(status.dirty, true);
    const paths = (await w.git.changes({ gitDir: w.gitDir, checkout: w.checkout })).map((c) => c.path).sort();
    assert.deepEqual(paths, [".gitignore", "out/deep/data.bin", "report.txt"]);
    const results = await w.git.integrate({ gitDir: w.gitDir, checkout: w.checkout, bridge: w.bridge, author: "agent:ann", reason: "x" });
    assert.ok(results.every((r) => r.result.status === "written"), JSON.stringify(results));
    assert.equal(await readFile(join(w.shared, "report.txt"), "utf8"), "hidden by the agent's own rule\n");
    assert.equal(await readFile(join(w.shared, "out", "deep", "data.bin"), "utf8"), "more work\n");
    // A refresh over ignored work refuses, even when the next commit adds a file at that very path.
    sh(w.shared, "rm", "-q", "--cached", "-r", ".", "--ignore-unmatch"); sh(w.shared, "add", "-A"); sh(w.shared, "commit", "-q", "-m", "second");
    await rm(join(w.checkout, ".gitignore")); await rm(join(w.checkout, "out"), { recursive: true });
    await writeFile(join(w.checkout, ".gitignore"), "report.txt\n");
    const second = await w.git.head(w.shared);
    await refuses("stale", () => w.git.refresh({ shared: w.shared, commit: second, gitDir: w.gitDir, checkout: w.checkout }));
    assert.equal(await readFile(join(w.checkout, "report.txt"), "utf8"), "hidden by the agent's own rule\n");
  } finally { await w.done(); }
});

test("a file whose only change is its mode is reported and skipped, not rewritten; binary files get the right base version; an oversize change names the file", { skip: skip || (process.platform === "win32" ? "POSIX modes" : false) }, async () => {
  const w = await world();
  try {
    const { chmod } = await import("node:fs/promises");
    await chmod(join(w.checkout, "src", "a.ts"), 0o755);
    const binary = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x81, 0xc3, 0x28]);
    await writeFile(join(w.shared, "blob.bin"), binary); sh(w.shared, "add", "-A"); sh(w.shared, "commit", "-q", "-m", "binary");
    const head = await w.git.head(w.shared);
    await w.git.refresh({ shared: w.shared, commit: head, gitDir: w.gitDir, checkout: w.checkout }).catch(async () => { await chmod(join(w.checkout, "src", "a.ts"), 0o644); await w.git.refresh({ shared: w.shared, commit: head, gitDir: w.gitDir, checkout: w.checkout }); });
    await chmod(join(w.checkout, "src", "a.ts"), 0o755);
    await writeFile(join(w.checkout, "blob.bin"), Buffer.concat([binary, Buffer.from([1])]));
    const changes = await w.git.changes({ gitDir: w.gitDir, checkout: w.checkout });
    const byPath = Object.fromEntries(changes.map((c) => [c.path, c]));
    assert.equal(byPath["src/a.ts"]!.modeOnly, true);
    assert.equal(byPath["blob.bin"]!.baseVersion, versionOf(binary), "the version of a non-UTF-8 file is of its real bytes");
    const results = await w.git.integrate({ gitDir: w.gitDir, checkout: w.checkout, bridge: w.bridge, author: "agent:ann", reason: "x" });
    const out = Object.fromEntries(results.map((r) => [r.path, r.result.status]));
    assert.deepEqual(out, { "blob.bin": "written", "src/a.ts": "skipped" });
    assert.deepEqual(await readFile(join(w.shared, "blob.bin")), Buffer.concat([binary, Buffer.from([1])]));
    // Too big a change names the file.
    await writeFile(join(w.checkout, "big.dat"), Buffer.alloc(9 * 1024 * 1024));
    await assert.rejects(() => w.git.integrate({ gitDir: w.gitDir, checkout: w.checkout, bridge: w.bridge, author: "agent:ann", reason: "x" }), (e: unknown) => e instanceof WorkspaceError && /big\.dat/.test(e.message));
  } finally { await w.done(); }
});
