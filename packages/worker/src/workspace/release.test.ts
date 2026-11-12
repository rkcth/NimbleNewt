import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitBridge, LocalWorkspaces, WorkspaceHost, releaseLedgerPath, permitLedgerPath, type HostWorkspaceCall, type LandingPolicy } from "./index.js";
import { PLAN_FILE } from "@nimblenewt/contracts";

// Card H12o: the platform commits a verified done in the task's own checkout (the `release` operation), so a landing finds a commit and not loose files.
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = hasGit ? false : "git is not installed";
const sh = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "core.hooksPath=/nonexistent-hooks", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
let counter = 0;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const rid = (): string => { const n = ++counter; return `wsr-${"aaaaaaaaaaaaaaaaaa"}${ALPHABET[(n >> 5) & 31]}${ALPHABET[n & 31]}`; };
const call = (operation: HostWorkspaceCall["operation"], more: Partial<HostWorkspaceCall> = {}): HostWorkspaceCall => ({ requestId: rid(), operation, taskId: "tsk-one", projectId: "prj-one", reason: "test", quietAttempts: [], ...more });
const detailOf = (r: { ok: boolean }): Record<string, any> => ((r as unknown as { detail?: Record<string, any> }).detail ?? {});
const reasonOf = (r: { ok: boolean }): string => (r as unknown as { reason: string }).reason;

async function world(policy: () => LandingPolicy | undefined | Promise<LandingPolicy | undefined> = () => ({ branch: "main", requirePermit: true })) {
  const dir = await mkdtemp(join(tmpdir(), "nn-rel-"));
  const shared = join(dir, "shared");
  await mkdir(join(shared, "src"), { recursive: true });
  sh(dir, "init", "-q", "-b", "main", shared);
  await writeFile(join(shared, "src", "a.ts"), "export const a = 1;\n");
  sh(shared, "add", "-A"); sh(shared, "commit", "-q", "-m", "first");
  const git = await GitBridge.create({ scratch: join(dir, "scratch") });
  const root = join(dir, "work");
  const ws = new LocalWorkspaces({ root, git, shared: (p) => (p === "prj-one" ? shared : undefined), busy: () => [], landing: () => policy(), clock: () => "2026-11-12T10:00:00.000Z" });
  const made = await ws.ensure({ taskId: "tsk-one", projectId: "prj-one", attemptId: "att-first.1" });
  const head = (): string => execFileSync("git", ["--git-dir", made.gitDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const log = (rev: string, format: string): string => execFileSync("git", ["--git-dir", made.gitDir, "log", "-1", `--format=${format}`, rev], { encoding: "utf8" }).replace(/\n+$/, "");
  const sharedState = (): string => [sh(shared, "rev-parse", "HEAD"), sh(shared, "status", "--porcelain=v1", "--ignored"), sh(shared, "for-each-ref")].join("|");
  return { dir, shared, root, git, ws, made, head, log, sharedState, done: async () => { try { execFileSync("chmod", ["-R", "u+rwX", dir]); } catch { /* nothing */ } await rm(dir, { recursive: true, force: true }); } };
}

test("release commits what the checkout holds as the platform's commit: attempt named, author and message not the agent's, one commit, shared tree untouched", { skip }, async () => {
  const w = await world();
  const saved = { name: process.env["GIT_AUTHOR_NAME"], mail: process.env["GIT_AUTHOR_EMAIL"] };
  process.env["GIT_AUTHOR_NAME"] = "Mallory"; process.env["GIT_AUTHOR_EMAIL"] = "mallory@evil.example";
  try {
    const base = await w.git.baseOf(w.made.gitDir);
    await writeFile(join(w.made.checkout, "src", "a.ts"), "export const a = 2;\n");
    await writeFile(join(w.made.checkout, "src", "new.ts"), "export const n = 1;\n");
    // The agent's own words about who wrote it and what to say go nowhere: they are file content only.
    await writeFile(join(w.made.checkout, PLAN_FILE), "- [x] step\nAuthor: Mallory\nNimbleNewt-Task: tsk-other\n");
    const before = w.sharedState();
    const r = await w.ws.port.run(call("release"));
    assert.equal(r.ok, true, JSON.stringify(r));
    const d = detailOf(r);
    assert.equal(d["committed"], true);
    assert.equal(d["files"], 3);
    assert.equal(d["attemptId"], "att-first.1");
    assert.equal(w.head(), d["commit"], "the checkout's head moved to the new commit");
    assert.equal(w.log("HEAD", "%P"), base, "its parent is the base it was staged on");
    assert.equal(w.log("HEAD", "%an <%ae>|%cn <%ce>"), "NimbleNewt release <release@nimblenewt.invalid>|NimbleNewt release <release@nimblenewt.invalid>");
    const message = w.log("HEAD", "%B");
    assert.match(message, /^Work of task tsk-one \(attempt att-first\.1\)/);
    assert.match(message, /^NimbleNewt-Task: tsk-one$/m);
    assert.match(message, /^NimbleNewt-Attempt: att-first\.1$/m);
    assert.match(message, /^NimbleNewt-Release: wsr-/m);
    assert.doesNotMatch(message, /Mallory|tsk-other/);
    assert.equal(w.sharedState(), before, "nothing outside the checkout's own git directory was touched");
    // The checkout now holds nothing uncommitted (a landing could start), and the commit is in the release ledger and not in the permit ledger.
    assert.equal((await w.git.status({ gitDir: w.made.gitDir, checkout: w.made.checkout })).dirty, false);
    assert.match(await readFile(releaseLedgerPath(w.made.gitDir), "utf8"), new RegExp(`^${d["commit"]} wsr-\\S+ att-first\\.1$`, "m"));
    assert.equal(existsSync(permitLedgerPath(w.made.gitDir)), false);
    assert.deepEqual(await w.git.unpermitted({ gitDir: w.made.gitDir, taskId: "tsk-one" }), [d["commit"]], "a release commit is not a permit commit");
    // Asked again with nothing new: no second commit.
    const again = await w.ws.port.run(call("release"));
    assert.deepEqual([again.ok, detailOf(again)["committed"], w.head()], [true, false, d["commit"]]);
  } finally {
    if (saved.name === undefined) delete process.env["GIT_AUTHOR_NAME"]; else process.env["GIT_AUTHOR_NAME"] = saved.name;
    if (saved.mail === undefined) delete process.env["GIT_AUTHOR_EMAIL"]; else process.env["GIT_AUTHOR_EMAIL"] = saved.mail;
    await w.done();
  }
});

test("a request ID is carried out once: a repeat answers the recorded outcome and makes no second commit", { skip }, async () => {
  const w = await world();
  try {
    await writeFile(join(w.made.checkout, "src", "a.ts"), "export const a = 2;\n");
    const first = call("release");
    const a = await w.ws.port.run(first);
    await writeFile(join(w.made.checkout, "src", "late.ts"), "late\n");
    const b = await w.ws.port.run(first);
    assert.deepEqual(b, a);
    assert.equal(detailOf(b)["commit"], w.head());
    assert.equal((await w.git.status({ gitDir: w.made.gitDir, checkout: w.made.checkout })).dirty, true, "the late file was not committed by the repeat");
  } finally { await w.done(); }
});

test("nothing in the agent-writable checkout or the host's repository settings runs: no hook, no filter, no file-system monitor, no configuration from the environment", { skip }, async () => {
  const w = await world();
  const marker = join(w.dir, "RAN");
  const hookDir = join(w.dir, "evil-hooks");
  const saved = { c: process.env["GIT_CONFIG_COUNT"], k: process.env["GIT_CONFIG_KEY_0"], v: process.env["GIT_CONFIG_VALUE_0"], e: process.env["GIT_EXTERNAL_DIFF"], i: process.env["GIT_INDEX_FILE"] };
  try {
    const script = `#!/bin/sh\ntouch ${marker}\n`;
    await mkdir(hookDir);
    for (const name of ["reference-transaction", "pre-commit", "commit-msg", "post-commit", "pre-auto-gc"]) { await writeFile(join(hookDir, name), script); await chmod(join(hookDir, name), 0o755); }
    await mkdir(join(w.made.gitDir, "hooks"), { recursive: true });
    await writeFile(join(w.made.gitDir, "hooks", "reference-transaction"), script); await chmod(join(w.made.gitDir, "hooks", "reference-transaction"), 0o755);
    await writeFile(join(w.dir, "fsmon"), script); await chmod(join(w.dir, "fsmon"), 0o755);
    await writeFile(join(w.dir, "clean"), script); await chmod(join(w.dir, "clean"), 0o755);
    // The repository's own configuration, made hostile (a compromised or mistaken setting): a hooks path, a monitor, a filter and an alias.
    sh(w.dir, "config", "--file", join(w.made.gitDir, "config"), "core.hooksPath", hookDir);
    sh(w.dir, "config", "--file", join(w.made.gitDir, "config"), "core.fsmonitor", join(w.dir, "fsmon"));
    sh(w.dir, "config", "--file", join(w.made.gitDir, "config"), "filter.evil.clean", join(w.dir, "clean"));
    sh(w.dir, "config", "--file", join(w.made.gitDir, "config"), "alias.commit-tree", `!touch ${marker}`);
    // The process environment carries more of the same.
    process.env["GIT_CONFIG_COUNT"] = "1"; process.env["GIT_CONFIG_KEY_0"] = "core.hooksPath"; process.env["GIT_CONFIG_VALUE_0"] = hookDir; process.env["GIT_EXTERNAL_DIFF"] = join(w.dir, "clean"); process.env["GIT_INDEX_FILE"] = join(w.dir, "evil-index");
    // And the checkout names the filter for every file.
    await writeFile(join(w.made.checkout, ".gitattributes"), "* filter=evil\n");
    await writeFile(join(w.made.checkout, "src", "a.ts"), "export const a = 2;\n");
    const r = await w.ws.port.run(call("release"));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(detailOf(r)["committed"], true);
    assert.equal(existsSync(marker), false, "no hook, filter, monitor or alias ran");
    assert.equal(existsSync(join(w.dir, "evil-index")), false, "the index named by the environment was not used");
    assert.equal(sh(w.dir, "--git-dir", w.made.gitDir, "show", "HEAD:src/a.ts"), "export const a = 2;");
  } finally {
    for (const [name, v] of [["GIT_CONFIG_COUNT", saved.c], ["GIT_CONFIG_KEY_0", saved.k], ["GIT_CONFIG_VALUE_0", saved.v], ["GIT_EXTERNAL_DIFF", saved.e], ["GIT_INDEX_FILE", saved.i]] as const) { if (v === undefined) delete process.env[name]; else process.env[name] = v; }
    await w.done();
  }
});

test("a Git-named entry, a link or a submodule entry in the checkout refuses the whole release: nothing is committed", { skip }, async () => {
  const w = await world();
  try {
    const head = w.head();
    await writeFile(join(w.made.checkout, "src", "a.ts"), "export const a = 2;\n");
    await mkdir(join(w.made.checkout, "nested", ".git"), { recursive: true });
    await writeFile(join(w.made.checkout, "nested", ".git", "config"), "[core]\n\thooksPath = /tmp\n");
    const gitData = await w.ws.port.run(call("release"));
    assert.equal(gitData.ok, false);
    assert.equal(w.head(), head, "no commit for a checkout that holds Git data");
    await rm(join(w.made.checkout, "nested"), { recursive: true, force: true });
    await symlink("/etc/passwd", join(w.made.checkout, "link"));
    const link = await w.ws.port.run(call("release"));
    assert.equal(link.ok, false);
    assert.match(reasonOf(link), /link|submodule/);
    assert.equal(w.head(), head, "no commit for a checkout that holds a link");
    assert.equal(existsSync(releaseLedgerPath(w.made.gitDir)), false);
  } finally { await w.done(); }
});

test("protected paths of the owner's policy are named in the answer and kept for review by the landing; the permit rule of the policy decides whether a release commit lands", { skip }, async () => {
  let policy: LandingPolicy = { branch: "main", requirePermit: true, protectedPaths: ["secrets/"] };
  const w = await world(() => policy);
  try {
    await mkdir(join(w.made.checkout, ".github", "workflows"), { recursive: true });
    await mkdir(join(w.made.checkout, "secrets"), { recursive: true });
    await writeFile(join(w.made.checkout, ".github", "workflows", "ci.yml"), "name: ci\n");
    await writeFile(join(w.made.checkout, "secrets", "k.txt"), "x\n");
    await writeFile(join(w.made.checkout, "src", "a.ts"), "export const a = 2;\n");
    const r = await w.ws.port.run(call("release"));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual([...detailOf(r)["protectedHeld"]].sort(), [".github/workflows/ci.yml", "secrets/k.txt"]);
    assert.equal(detailOf(r)["permitRequiredToLand"], true);
    assert.match((r as { summary: string }).summary, /not a review-gate permit commit/);
    // The policy requires the permit: the release commit is refused by the landing, and nothing is written.
    const refused = await w.ws.port.run(call("landing"));
    assert.equal(refused.ok, false);
    assert.match(reasonOf(refused), /commit permit/);
    assert.equal(sh(w.shared, "status", "--porcelain=v1"), "");
    // The owner lets work land without the permit: the commit lands, but the protected paths wait for review (all or nothing, so nothing is written).
    policy = { branch: "main", requirePermit: false, protectedPaths: ["secrets/"] };
    const held = await w.ws.port.run(call("landing"));
    assert.equal(held.ok, true, JSON.stringify(held));
    assert.equal(detailOf(held)["written"], 0);
    assert.equal(detailOf(held)["kept"], 2);
    assert.equal(sh(w.shared, "status", "--porcelain=v1"), "");
  } finally { await w.done(); }
});

test("a release commit lands as a commit when the policy does not require the permit", { skip }, async () => {
  const w = await world(() => ({ branch: "main", requirePermit: false }));
  try {
    await writeFile(join(w.made.checkout, "src", "a.ts"), "export const a = 2;\n");
    // Loose files do not land.
    const loose = await w.ws.port.run(call("landing"));
    assert.equal(loose.ok, false);
    assert.match(reasonOf(loose), /not committed/);
    const r = await w.ws.port.run(call("release"));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(detailOf(r)["permitRequiredToLand"], false);
    const landed = await w.ws.port.run(call("landing"));
    assert.equal(landed.ok, true, JSON.stringify(landed));
    assert.equal(detailOf(landed)["landed"], true);
    assert.equal(await readFile(join(w.shared, "src", "a.ts"), "utf8"), "export const a = 2;\n");
  } finally { await w.done(); }
});

test("a policy that cannot be read, or that refuses, stops the release before anything is committed", { skip }, async () => {
  let mode: "throws" | "refuses" | "ok" = "throws";
  const w = await world(() => { if (mode === "throws") throw new Error("settings unreadable"); return mode === "refuses" ? { refuse: "not this host's branch" } : { branch: "main" }; });
  try {
    await writeFile(join(w.made.checkout, "src", "a.ts"), "export const a = 2;\n");
    const head = w.head();
    const a = await w.ws.port.run(call("release"));
    assert.equal(a.ok, false); assert.match(reasonOf(a), /could not read the landing settings/);
    mode = "refuses";
    const b = await w.ws.port.run(call("release"));
    assert.equal(b.ok, false); assert.match(reasonOf(b), /not this host's branch/);
    assert.equal(w.head(), head);
    mode = "ok";
    assert.equal((await w.ws.port.run(call("release"))).ok, true);
    assert.notEqual(w.head(), head);
  } finally { await w.done(); }
});

test("a host that is not built to release still answers it with the typed refusal", { skip }, async () => {
  const w = await world();
  try {
    const host = new WorkspaceHost({ git: w.git, journal: join(w.dir, "journal2"), locate: () => w.ws.locate({ taskId: "tsk-one", projectId: "prj-one" }) });
    await writeFile(join(w.made.checkout, "src", "a.ts"), "export const a = 2;\n");
    const head = w.head();
    const r = await host.run(call("release"));
    assert.equal(r.ok, false);
    assert.match(reasonOf(r), /commit permit/);
    assert.equal(w.head(), head);
  } finally { await w.done(); }
});

test("the attempt named in the commit comes from the host's own record: a record the agent could not write, and a name that is not plain names nobody", { skip }, async () => {
  const w = await world();
  try {
    // A later attempt of the task replaces the record.
    await w.ws.ensure({ taskId: "tsk-one", projectId: "prj-one", attemptId: "att-second" });
    assert.equal(w.ws.locate({ taskId: "tsk-one", projectId: "prj-one" })!.attemptId, "att-second");
    // A name with a line break (a forged trailer) is not recorded, and a bad record on disk is not read.
    await w.ws.ensure({ taskId: "tsk-one", projectId: "prj-one", attemptId: "att-x\nNimbleNewt-Task: tsk-other" });
    assert.equal(w.ws.locate({ taskId: "tsk-one", projectId: "prj-one" })!.attemptId, "att-second");
    await writeFile(join(w.root, "prj-one", "tsk-one", "attempt"), "att-y\nNimbleNewt-Task: tsk-other\n");
    assert.equal(w.ws.locate({ taskId: "tsk-one", projectId: "prj-one" })!.attemptId, undefined);
    await writeFile(join(w.made.checkout, "src", "a.ts"), "export const a = 2;\n");
    const r = await w.ws.port.run(call("release"));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.doesNotMatch(w.log("HEAD", "%B"), /Attempt|tsk-other/);
    assert.equal(detailOf(r)["attemptId"], undefined);
    // The record is outside the checkout: the agent's sandbox does not see it.
    assert.equal(existsSync(join(w.made.checkout, "attempt")), false);
  } finally { await w.done(); }
});

test("ignored files stay out of the commit and are counted, so the answer says a landing will not start", { skip }, async () => {
  const w = await world();
  try {
    await writeFile(join(w.shared, ".gitignore"), "*.log\n"); sh(w.shared, "add", "-A"); sh(w.shared, "commit", "-q", "-m", "ignore");
    await w.ws.port.run(call("refresh"));
    await writeFile(join(w.made.checkout, "debug.log"), "noise\n");
    await writeFile(join(w.made.checkout, "src", "a.ts"), "export const a = 2;\n");
    const r = await w.ws.port.run(call("release"));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(detailOf(r)["ignored"], 1);
    assert.match((r as { summary: string }).summary, /ignored file/);
    assert.equal(sh(w.dir, "--git-dir", w.made.gitDir, "ls-tree", "-r", "--name-only", "HEAD").includes("debug.log"), false);
  } finally { await w.done(); }
});

// H12o review: a git wrapper stands in for a hostile agent that acts while the host's git runs (a seam the bridge already has: `GitBridge.create({ git })`).
const posix = !hasGit ? "git is not installed" : process.platform === "win32" ? "POSIX shell wrapper" : false;
const realGit = (): string => execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
async function wrapped(w: Awaited<ReturnType<typeof world>>, script: string): Promise<LocalWorkspaces> {
  const file = join(w.dir, "git-wrapper");
  await writeFile(file, `#!/bin/sh\n${script}\nexec '${realGit()}' "$@"\n`); await chmod(file, 0o755);
  const git = await GitBridge.create({ scratch: join(w.dir, "scratch2"), git: file });
  return new LocalWorkspaces({ root: w.root, git, shared: (p) => (p === "prj-one" ? w.shared : undefined), busy: () => [], landing: () => ({ branch: "main", requirePermit: true }), clock: () => "2026-11-12T10:00:00.000Z" });
}

test("a file swapped for a link while git stages it cannot carry a file from outside the checkout into the commit: the staged content is checked against a no-follow read", { skip: posix }, async () => {
  const w = await world();
  try {
    // What the race leaves behind (shown deterministically): git read the outside file through the swapped name, and the agent then put its own file back.
    const outside = join(w.dir, "host-secret");
    await writeFile(outside, "HOST-ONLY-CONTENT\n");
    const target = join(w.made.checkout, "src", "a.ts");
    await writeFile(target, "export const a = 2;\n");
    const keep = join(w.dir, "agent-keep");
    const ws = await wrapped(w, `case " $* " in *" add -A"*) cp '${target}' '${keep}'; cp '${outside}' '${target}'; '${realGit()}' "$@" || exit 1; mv '${keep}' '${target}'; exit 0;; esac`);
    const head = w.head();
    const r = await ws.port.run(call("release"));
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.match(reasonOf(r), /^"src\/a\.ts" changed or was replaced by a link while it was being staged/);
    assert.equal(w.head(), head, "nothing was committed");
    assert.equal(existsSync(releaseLedgerPath(w.made.gitDir)), false);
    // An honest release afterwards commits the agent's own file.
    const ok = await w.ws.port.run(call("release"));
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(sh(w.dir, "--git-dir", w.made.gitDir, "show", "HEAD:src/a.ts"), "export const a = 2;");
  } finally { await w.done(); }
});

test("the head moves only from the head the release staged on: a head that moved meanwhile is not overwritten (compare-and-swap)", { skip: posix }, async () => {
  const w = await world();
  try {
    const base = w.head();
    const tree = execFileSync("git", ["--git-dir", w.made.gitDir, "rev-parse", `${base}^{tree}`], { encoding: "utf8" }).trim();
    const other = execFileSync("git", ["--git-dir", w.made.gitDir, "-c", "user.name=t", "-c", "user.email=t@t", "commit-tree", tree, "-p", base, "-m", "moved meanwhile"], { encoding: "utf8" }).trim();
    await writeFile(join(w.made.checkout, "src", "a.ts"), "export const a = 2;\n");
    const ws = await wrapped(w, `case " $* " in *" commit-tree "*) '${realGit()}' --git-dir '${w.made.gitDir}' update-ref HEAD ${other} || exit 1;; esac`);
    await assert.rejects(ws.port.run(call("release")), /update-ref/);
    assert.equal(w.head(), other, "the head that moved meanwhile was kept");
  } finally { await w.done(); }
});

test("a FIFO or a socket in the checkout does not hang or enter the release, and line endings are committed as written whatever the checkout's attributes say", { skip: posix }, async () => {
  const w = await world();
  try {
    execFileSync("mkfifo", [join(w.made.checkout, "pipe")]);
    await writeFile(join(w.made.checkout, ".gitattributes"), "* text=auto eol=lf ident\n");
    await writeFile(join(w.made.checkout, "src", "crlf.txt"), "one\r\n$Id$\r\n");
    const r = await w.ws.port.run(call("release"));
    assert.equal(r.ok, true, JSON.stringify(r));
    const names = sh(w.dir, "--git-dir", w.made.gitDir, "ls-tree", "-r", "--name-only", "HEAD").split("\n");
    assert.equal(names.includes("pipe"), false);
    assert.equal(execFileSync("git", ["--git-dir", w.made.gitDir, "cat-file", "blob", "HEAD:src/crlf.txt"], { encoding: "utf8" }), "one\r\n$Id$\r\n");
  } finally { await w.done(); }
});
