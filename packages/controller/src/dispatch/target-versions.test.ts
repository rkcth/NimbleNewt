import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { redactText } from "../security/redact.js";
import { createTargetVersions, TargetVersionError, type TargetVersionOptions } from "./target-versions.js";
import { buildWorld } from "./testing/world.js";

after(stopServer);

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@+=/-]*$/;
const sha = (text: string | Buffer): string => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const scratch: string[] = [];
const temp = (): string => { const d = mkdtempSync(join(tmpdir(), "nn-tv-")); scratch.push(d); return d; };
after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", HOME: tmpdir(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
const repo = (): string => { const d = temp(); git(d, "init", "-q"); return d; };
const commit = (d: string, name = "a.txt", content = `${Math.random()}`): string => { writeFileSync(join(d, name), content); git(d, "add", "-A"); git(d, "commit", "-q", "-m", "c"); return git(d, "rev-parse", "HEAD"); };

/** A hook over a fixed checkout (the rest of the world is not needed for git and file readings). */
const over = (root: string | undefined, paths: readonly string[] = [], options?: TargetVersionOptions) => {
  let located = 0;
  const read = createTargetVersions({ storage: { getAggregate: async () => undefined }, location: async () => { located++; return root === undefined ? undefined : { root, paths }; }, ...(options === undefined ? {} : { options }) });
  return { read, located: () => located };
};
/** The stand-in git programs below are POSIX shell scripts, which Windows cannot start (spawn EFTYPE): the tests that need one run where a script is a program. */
const SHELL_SCRIPTS = process.platform === "win32" && "the stand-in git programs are POSIX shell scripts, which Windows cannot run";

const refused = async (promise: Promise<unknown>, code?: TargetVersionError["code"]): Promise<void> => {
  await assert.rejects(promise, (e: unknown) => e instanceof TargetVersionError && (code === undefined || e.code === code));
};

test("card A05b follow-up: a branch or ref reads as the commit it points to, from the shared repository, and moves with it", async () => {
  const d = repo();
  const first = commit(d);
  const { read } = over(d);
  assert.equal(await read({ kind: "branch", id: "main" }, "t"), first);
  assert.equal(await read({ kind: "ref", id: "HEAD" }, "t"), first);
  const second = commit(d);
  assert.equal(await read({ kind: "branch", id: "main" }, "t"), second);
  assert.notEqual(first, second);
  assert.match(first, /^[0-9a-f]{40}$/);
  assert.ok(TOKEN.test(first) && redactText(first) === first, "a commit ID is a token the review accepts");
  git(d, "branch", "feat/odd-name_1.x");
  assert.equal(await read({ kind: "branch", id: "feat/odd-name_1.x" }, "t"), second);
  git(d, "tag", "-a", "-m", "m", "v1");
  assert.equal(await read({ kind: "ref", id: "refs/tags/v1" }, "t"), second, "an annotated tag reads as the commit under it");
  assert.equal(await read({ kind: "branch", id: "nope" }, "t"), "absent");
  assert.equal(await read({ kind: "ref", id: "refs/heads/nope" }, "t"), "absent");
});

test("card A05b follow-up: a detached HEAD reads as its commit; an empty repository reads as absent, not as an error", async () => {
  const d = repo();
  assert.equal(await over(d).read({ kind: "ref", id: "HEAD" }, "t"), "absent", "a repository without a commit");
  assert.equal(await over(d).read({ kind: "branch", id: "main" }, "t"), "absent");
  const first = commit(d);
  commit(d);
  git(d, "checkout", "-q", "--detach", first);
  assert.equal(await over(d).read({ kind: "ref", id: "HEAD" }, "t"), first);
  assert.equal(await over(d).read({ kind: "branch", id: "main" }, "t") !== first, true);
});

test("card A05b follow-up review: a branch or ref is matched by its full name exactly, never by Git's short-name rules, so a decoy ref cannot stand in for one that is gone", async () => {
  const d = repo();
  const c = commit(d);
  const { read } = over(d);
  // Each of these is what `rev-parse refs/heads/x` would fall back to when refs/heads/x is not there.
  for (const decoy of ["refs/tags/refs/heads/x", "refs/refs/heads/x", "refs/heads/refs/heads/x", "refs/remotes/refs/heads/x"]) {
    git(d, "update-ref", decoy, c);
    assert.equal(await read({ kind: "branch", id: "x" }, "t"), "absent", decoy);
    assert.equal(await read({ kind: "ref", id: "refs/heads/x" }, "t"), "absent", decoy);
    git(d, "update-ref", "-d", decoy);
  }
  git(d, "update-ref", "refs/heads/x/y", c);
  assert.equal(await read({ kind: "branch", id: "x" }, "t"), "absent", "a longer name below it is not the branch");
  assert.equal(await read({ kind: "branch", id: "x/y" }, "t"), c);
  // An unborn HEAD is absent even beside a branch called HEAD (short-name rules would read refs/heads/HEAD).
  git(d, "symbolic-ref", "HEAD", "refs/heads/unborn");
  git(d, "update-ref", "refs/heads/HEAD", c);
  assert.equal(await read({ kind: "ref", id: "HEAD" }, "t"), "absent");
  git(d, "symbolic-ref", "HEAD", "refs/heads/main");
  assert.equal(await read({ kind: "ref", id: "HEAD" }, "t"), c);
  git(d, "pack-refs", "--all");
  assert.equal(await read({ kind: "branch", id: "main" }, "t"), c, "a packed ref reads the same");
  assert.equal(await read({ kind: "branch", id: "x" }, "t"), "absent");
});

test("card A05b follow-up review: a ref to an object that is not there is an error, not absent", async () => {
  const d = repo();
  const c = commit(d);
  const missing = "1".repeat(40);
  writeFileSync(join(d, ".git", "refs", "heads", "bad"), `${missing}\n`);
  await refused(over(d).read({ kind: "branch", id: "bad" }, "t"), "unreadable");
  await refused(over(d).read({ kind: "ref", id: "refs/heads/bad" }, "t"), "unreadable");
  writeFileSync(join(d, ".git", "HEAD"), `${missing}\n`);
  await refused(over(d).read({ kind: "ref", id: "HEAD" }, "t"), "unreadable");
  writeFileSync(join(d, ".git", "HEAD"), "ref: refs/heads/bad\n");
  await refused(over(d).read({ kind: "ref", id: "HEAD" }, "t"), "unreadable");
  writeFileSync(join(d, ".git", "HEAD"), `${c}\n`);
  assert.equal(await over(d).read({ kind: "ref", id: "HEAD" }, "t"), c);
});

test("card A05b follow-up review: no more git processes run at once than the cap, and a reading waiting its turn still ends in time", { skip: SHELL_SCRIPTS }, async () => {
  const d = repo();
  commit(d);
  const box = temp();
  const counter = join(temp(), "count.sh");
  writeFileSync(counter, `#!/bin/sh\nmkdir ${box}/$$\nls ${box} | wc -l >> ${box}.log\nsleep 0.3\nrmdir ${box}/$$\n`);
  chmodSync(counter, 0o755);
  scratch.push(`${box}.log`);
  const { read } = over(d, [], { git: counter, gitProcesses: 2 });
  const all = await Promise.all(Array.from({ length: 8 }, () => read({ kind: "branch", id: "main" }, "t")));
  assert.deepEqual(all, Array(8).fill("absent"), "an empty answer of git is 'not there'");
  const seen = readFileSync(`${box}.log`, "utf8").trim().split("\n").map(Number);
  assert.equal(seen.length, 8);
  assert.ok(Math.max(...seen) <= 2, `at most two at once, saw ${seen.join(",")}`);
  const slow = join(temp(), "slow.sh");
  writeFileSync(slow, "#!/bin/sh\nsleep 5\n");
  chmodSync(slow, 0o755);
  const queued = over(d, [], { git: slow, gitProcesses: 1, totalMs: 400, gitMs: 60_000 });
  const t0 = Date.now();
  const results = await Promise.allSettled(Array.from({ length: 3 }, () => queued.read({ kind: "branch", id: "main" }, "t")));
  assert.ok(results.every((r) => r.status === "rejected" && r.reason instanceof TargetVersionError && r.reason.code === "timeout"));
  assert.ok(Date.now() - t0 < 3_000, "waiting for a turn is bounded by the reading's own time");
});

test("card A05b follow-up: a bare repository is read the same way", async () => {
  const d = repo();
  const c = commit(d);
  const bare = temp();
  git(bare, "clone", "-q", "--bare", d, join(bare, "b.git"));
  assert.equal(await over(join(bare, "b.git")).read({ kind: "branch", id: "main" }, "t"), c);
});

test("card A05b follow-up: names that are not branches are refused before git is asked, whatever they look like", async () => {
  const d = repo();
  commit(d);
  const { read } = over(d);
  for (const id of ["-x", "--upload-pack=evil", "a..b", "a b", "a\nb", "a\tb", "x.lock", "a/.hidden", "a@{1}", "@", "a~1", "a^", "a:b", "a?b", "a*b", "a[b", "a\\b", "/a", "a/", "a//b", "a.", "", "x".repeat(201), "\u0000"]) {
    await refused(read({ kind: "branch", id }, "t"), "refused");
  }
  for (const id of ["main", "--output=x", "heads/main", "refs/../x", "refs/heads/a b", "HEAD~1", "HEAD^", "origin/main"]) await refused(read({ kind: "ref", id }, "t"), "refused");
});

test("card A05b follow-up: a checkout that is not a readable repository is an error (fail closed), never absent", async () => {
  const plain = temp();
  await refused(over(plain).read({ kind: "branch", id: "main" }, "t"), "unreadable");
  assert.equal(await over(undefined).read({ kind: "branch", id: "main" }, "t"), undefined, "no bound repository: nothing on this host to read, bound by name as before");
  assert.equal(await over(undefined).read({ kind: "ref", id: "HEAD" }, "t"), undefined);
  assert.equal(await over(undefined).read({ kind: "file", id: "a.txt" }, "t"), undefined);
  await refused(over(join(plain, "missing")).read({ kind: "branch", id: "main" }, "t"), "unreadable");
  await refused(over("relative/dir").read({ kind: "branch", id: "main" }, "t"), "unreadable");
  const here = repo();
  commit(here);
  // A location that exists but only relative to the process is not a checkout. (On Windows a folder on another drive than the current directory has no relative spelling: relative() gives its absolute path.)
  const onlyRelative = relative(process.cwd(), here);
  if (!isAbsolute(onlyRelative)) await refused(over(onlyRelative).read({ kind: "branch", id: "main" }, "t"), "unreadable");
  const worktreeFile = temp();
  writeFileSync(join(worktreeFile, ".git"), "gitdir: /elsewhere\n");
  await refused(over(worktreeFile).read({ kind: "branch", id: "main" }, "t"), "unreadable");
  const broken = temp();
  mkdirSync(join(broken, ".git"));
  await refused(over(broken).read({ kind: "branch", id: "main" }, "t"), "unreadable");
});

test("card A05b follow-up: the repository's own configuration cannot make the reading run a program, and git that is missing or slow fails closed", async () => {
  const d = repo();
  const c = commit(d);
  const marker = join(temp(), "ran");
  const program = join(temp(), "evil.sh");
  writeFileSync(program, `#!/bin/sh\ntouch ${marker}\n`);
  chmodSync(program, 0o755);
  // Git reads a backslash in a configuration value as an escape, so a Windows path is written with forward slashes (which Git takes there too).
  const named = program.replaceAll("\\", "/");
  writeFileSync(join(d, ".git", "config"), `[core]\n\trepositoryformatversion = 0\n\tfsmonitor = ${named}\n\thooksPath = ${named}\n\tpager = ${named}\n[alias]\n\trev-parse = !${named}\n`, { flag: "a" });
  assert.equal(await over(d).read({ kind: "branch", id: "main" }, "t"), c);
  assert.equal(existsSync(marker), false, "no program named by the repository ran");
  await refused(over(d, [], { git: join(temp(), "no-such-git") }).read({ kind: "branch", id: "main" }, "t"), "unreadable");
  // A git that cannot be started at all (here a name Node refuses before starting anything; on Windows also a file that is not a program) is unreadable, never a plain error.
  await refused(over(d, [], { git: "git\u0000x" }).read({ kind: "branch", id: "main" }, "t"), "unreadable");
  if (SHELL_SCRIPTS) return;
  const slow = join(temp(), "slow.sh");
  writeFileSync(slow, "#!/bin/sh\nsleep 30\n");
  chmodSync(slow, 0o755);
  const started = Date.now();
  await refused(over(d, [], { git: slow, gitMs: 200, totalMs: 60_000 }).read({ kind: "branch", id: "main" }, "t"), "timeout");
  assert.ok(Date.now() - started < 5_000, "git itself is stopped at its own limit");
  const noisy = join(temp(), "noisy.sh");
  writeFileSync(noisy, "#!/bin/sh\necho 'not a commit'\n");
  chmodSync(noisy, 0o755);
  await refused(over(d, [], { git: noisy }).read({ kind: "branch", id: "main" }, "t"), "unreadable");
  const failing = join(temp(), "failing.sh");
  writeFileSync(failing, "#!/bin/sh\nexit 128\n");
  chmodSync(failing, 0o755);
  await refused(over(d, [], { git: failing }).read({ kind: "branch", id: "main" }, "t"), "unreadable");
  const hangs = join(temp(), "hangs.sh");
  writeFileSync(hangs, "#!/bin/sh\nsleep 30\n");
  chmodSync(hangs, 0o755);
  const t0 = Date.now();
  await refused(over(d, [], { git: hangs, gitMs: 60_000, totalMs: 300 }).read({ kind: "branch", id: "main" }, "t"), "timeout");
  assert.ok(Date.now() - t0 < 10_000, "the whole reading is bounded too");
});

test("card A05b follow-up: a workspace file reads as the bridge's own token: sha256 of its bytes, absent when there is none", async () => {
  const d = temp();
  mkdirSync(join(d, "src", "deep"), { recursive: true });
  writeFileSync(join(d, "src", "deep", "a.txt"), "hello");
  writeFileSync(join(d, "empty"), "");
  const { read } = over(d);
  assert.equal(await read({ kind: "file", id: "src/deep/a.txt" }, "t"), sha("hello"));
  assert.equal(await read({ kind: "file", id: "empty" }, "t"), sha(""));
  assert.equal(await read({ kind: "file", id: "src/deep/none.txt" }, "t"), "absent");
  assert.equal(await read({ kind: "file", id: "nodir/a.txt" }, "t"), "absent");
  assert.equal(await read({ kind: "file", id: "src/deep/a.txt/under" }, "t"), "absent", "a file where a directory is expected");
  writeFileSync(join(d, "src", "deep", "a.txt"), "hello!");
  assert.equal(await read({ kind: "file", id: "src/deep/a.txt" }, "t"), sha("hello!"));
  const token = await read({ kind: "file", id: "empty" }, "t");
  assert.ok(TOKEN.test(token!) && token!.length <= 200 && redactText(token!) === token);
  assert.ok(TOKEN.test("absent"));
});

test("card A05b follow-up: a path that leaves the checkout, names Git's data or is not a plain relative path is refused", async () => {
  const outer = temp();
  const d = join(outer, "ws");
  mkdirSync(join(d, ".git"), { recursive: true });
  writeFileSync(join(d, ".git", "config"), "x");
  writeFileSync(join(outer, "secret"), "outside");
  writeFileSync(join(d, "a.txt"), "a");
  const { read } = over(d);
  for (const id of ["../secret", "a/../../secret", "/etc/passwd", "./a.txt", "a//b", "a/./b", "", "a\\b", "C:\\x", "C:x", ".git/config", ".GIT/config", ".Git./config", "sub/.git/config", "git~1/config", ".git ", "a\u0000b", "a\nb", `${"d/".repeat(41)}x`, "x".repeat(201)]) {
    await refused(read({ kind: "file", id }, "t"), "refused");
  }
  assert.equal(await read({ kind: "file", id: "a.txt" }, "t"), sha("a"));
});

test("card A05b follow-up: links are never followed: a symlink to a file, a directory or a path outside is refused", async () => {
  const outer = temp();
  const d = join(outer, "ws");
  mkdirSync(join(d, "real"), { recursive: true });
  writeFileSync(join(outer, "secret"), "outside");
  writeFileSync(join(d, "real", "f"), "in");
  symlinkSync(join(outer, "secret"), join(d, "out-file"));
  symlinkSync(outer, join(d, "out-dir"));
  symlinkSync("real", join(d, "in-dir"));
  symlinkSync("real/f", join(d, "in-file"));
  symlinkSync("missing-target", join(d, "dangling"));
  symlinkSync("../secret", join(d, "real", "up"));
  const { read } = over(d);
  for (const id of ["out-file", "out-dir/secret", "in-dir/f", "in-file", "dangling", "real/up"]) await refused(read({ kind: "file", id }, "t"), "refused");
  assert.equal(await read({ kind: "file", id: "real/f" }, "t"), sha("in"));
  // A checkout location that is itself a link is resolved once, at the top, as the bridge does for its shared root.
  const viaLink = join(outer, "link-to-ws");
  symlinkSync(d, viaLink);
  assert.equal(await over(viaLink).read({ kind: "file", id: "real/f" }, "t"), sha("in"));
});

/** The file-reading checks to test here: the platform's own, and on Linux also the walk check that macOS and Windows use (`readCheck`), so it is exercised on every run. */
// Windows keeps the path check (the walk check refused quiet folders there; see target-versions.ts).
const READ_CHECKS: readonly ("kernel" | "walk" | "path")[] = process.platform === "linux" ? ["kernel", "walk"] : process.platform === "win32" ? ["path"] : ["walk"];

for (const check of READ_CHECKS) test(`card A05b follow-up review: a directory on the way swapped for a link while the file is read never yields a file outside the checkout (${check} check)`, { skip: check === "path" && "the path check (Windows) cannot see a swap undone before it asks: a known gap while no agent sandbox runs on Windows" }, async () => {
  const outer = temp();
  const d = join(outer, "ws");
  mkdirSync(join(d, "sub"), { recursive: true });
  mkdirSync(join(outer, "elsewhere"));
  writeFileSync(join(d, "sub", "f"), "inside");
  writeFileSync(join(outer, "elsewhere", "f"), "outside");
  symlinkSync(join(outer, "elsewhere"), join(d, "link"));
  // Another process swaps sub and the link back and forth as fast as it can.
  const swapper = spawn(process.execPath, ["-e", `const fs=require("node:fs");const p=require("node:path");const d=${JSON.stringify(d)};const end=Date.now()+20000;for(;Date.now()<end;){try{fs.renameSync(p.join(d,"sub"),p.join(d,"sub.real"));fs.renameSync(p.join(d,"link"),p.join(d,"sub"));fs.renameSync(p.join(d,"sub"),p.join(d,"link"));fs.renameSync(p.join(d,"sub.real"),p.join(d,"sub"));}catch{}}`], { stdio: "ignore" });
  const { read } = over(d, [], { readCheck: check });
  const outside = sha("outside");
  let inside = 0;
  try {
    const end = Date.now() + 4_000;
    while (Date.now() < end) {
      const got = await read({ kind: "file", id: "sub/f" }, "t").catch(() => "error");
      assert.notEqual(got, outside, "the file outside was read through a swapped directory");
      if (got === sha("inside")) inside++;
    }
  } finally { swapper.kill("SIGKILL"); await new Promise((r) => { if (swapper.exitCode !== null || swapper.signalCode !== null) r(undefined); else swapper.once("exit", r); }); }
  // The kernel's answer is exact, so readings succeed whenever the open itself was not swapped. The walk check refuses any reading during which the root changed, and the swapper changes it all the time:
  // there the proof that it still reads is a reading once the directory is put back and left alone.
  if (check !== "walk") assert.ok(inside > 0, "the file inside is read when nothing is swapped at that moment");
  for (const n of ["sub", "sub.real", "link"]) rmSync(join(d, n), { recursive: true, force: true });
  mkdirSync(join(d, "sub"));
  writeFileSync(join(d, "sub", "f"), "inside");
  assert.equal(await read({ kind: "file", id: "sub/f" }, "t"), sha("inside"), "with nothing changing, the file inside is read");
});

test("card A05b follow-up (CI platform repair): a directory swapped for a link just before the file is looked at and swapped back just after it is opened is caught by either check, never read through", { skip: process.platform === "win32" && "Windows keeps the path check, which this interleaving defeats (a known gap while no agent sandbox runs on Windows)" }, async () => {
  const outer = temp();
  const d = join(outer, "ws");
  mkdirSync(join(d, "sub"), { recursive: true });
  mkdirSync(join(outer, "elsewhere"));
  writeFileSync(join(d, "sub", "f"), "inside");
  writeFileSync(join(outer, "elsewhere", "f"), "outside");
  symlinkSync(join(outer, "elsewhere"), join(d, "link"));
  // The walk check does not trust a directory changed in the last moment: let the tree be older than that, as a checkout usually is.
  await new Promise((r) => setTimeout(r, 120));
  for (const check of READ_CHECKS) {
    let swaps = 0;
    // The interleaving a fast swapper found on macOS: `sub` is the walk's real directory, then the link while the file is looked at and opened (the outside file), then real again before any later look.
    const toLink = (): void => { if (swaps === 0) { renameSync(join(d, "sub"), join(d, "sub.real")); renameSync(join(d, "link"), join(d, "sub")); swaps++; } };
    const back = (): void => { if (swaps === 1) { renameSync(join(d, "sub"), join(d, "link")); renameSync(join(d, "sub.real"), join(d, "sub")); swaps++; } };
    const { read } = over(d, [], { readCheck: check, readHooks: { beforeLastName: toLink, afterOpen: back } });
    const got = await read({ kind: "file", id: "sub/f" }, "t").catch((e: unknown) => (e instanceof TargetVersionError ? `refused: ${e.message}` : `other: ${String(e)}`));
    assert.equal(swaps, 2, `${check}: the swap happened`);
    assert.notEqual(got, sha("outside"), `${check}: the file outside was read through a directory swapped for a link`);
    // The kernel check sees where the open file is and refuses; the walk check sees the root changed and reads again, now with nothing swapped.
    if (check === "kernel") assert.match(got!, /refused: a directory on the way changed/);
    else assert.equal(got, sha("inside"), "the walk check read again and got the file inside");
    await new Promise((r) => setTimeout(r, 120));
  }
});

test("card A05b follow-up (CI platform repair): the walk check reads what the kernel check reads, and a directory that keeps changing under a reading is refused after a few tries, never read through", async () => {
  const outer = temp();
  const d = join(outer, "ws");
  mkdirSync(join(d, "a", "b"), { recursive: true });
  writeFileSync(join(d, "a", "b", "f"), "deep");
  writeFileSync(join(d, "top"), "top");
  writeFileSync(join(outer, "secret"), "outside");
  symlinkSync(join(outer, "secret"), join(d, "a", "out"));
  symlinkSync(outer, join(d, "up"));
  const kernelOrWalk = READ_CHECKS.map((check) => over(d, [], { readCheck: check }).read);
  for (const read of kernelOrWalk) {
    assert.equal(await read({ kind: "file", id: "a/b/f" }, "t"), sha("deep"));
    assert.equal(await read({ kind: "file", id: "top" }, "t"), sha("top"));
    assert.equal(await read({ kind: "file", id: "a/b/none" }, "t"), "absent");
    for (const id of ["a/out", "up/secret", "a"]) await refused(read({ kind: "file", id }, "t"), "refused");
  }
  if (!READ_CHECKS.includes("walk")) return; // the walk check is not this platform's (Windows)
  // A directory on the way that changes during every reading (a name made and removed in it while the file is read): three tries, then refused. The file is large, so the reading is still going on when
  // the change lands.
  const big = Buffer.alloc(4 * 1024 * 1024, 1);
  writeFileSync(join(d, "a", "b", "big"), big);
  const walk = over(d, [], { readCheck: "walk" }).read;
  const churn = spawn(process.execPath, ["-e", `const fs=require("node:fs");const p=${JSON.stringify(join(d, "a", "churn"))};const end=Date.now()+20000;for(;Date.now()<end;){try{fs.mkdirSync(p);fs.rmdirSync(p);}catch{}}`], { stdio: "ignore" });
  try {
    let refusedSeen = 0;
    const end = Date.now() + 3_000;
    while (Date.now() < end && refusedSeen === 0) {
      const got = await walk({ kind: "file", id: "a/b/big" }, "t").catch((e: unknown) => (e instanceof TargetVersionError && e.code === "refused" && /changed while the file was being read/.test(e.message) ? "refused" : `other: ${String(e)}`));
      assert.ok(got === "refused" || got === sha(big), got);
      if (got === "refused") refusedSeen++;
    }
    assert.ok(refusedSeen > 0, "a reading while a directory on the way keeps changing is refused");
  } finally { churn.kill("SIGKILL"); await new Promise((r) => { if (churn.exitCode !== null || churn.signalCode !== null) r(undefined); else churn.once("exit", r); }); }
  rmSync(join(d, "a", "churn"), { recursive: true, force: true });
  assert.equal(await walk({ kind: "file", id: "a/b/big" }, "t"), sha(big), "once it stops changing, it is read");
});

test("card A05b follow-up: a pipe, a directory and a too large file are refused, not read; a file at the cap is read; a huge sparse file is refused without being read", async () => {
  const d = temp();
  mkdirSync(join(d, "dir"));
  // Windows has no named pipes in the file system (a tool that says it makes one there makes a plain file), so the pipe is POSIX only.
  const fifo = process.platform !== "win32";
  if (fifo) execFileSync("mkfifo", [join(d, "pipe")]);
  writeFileSync(join(d, "ten"), "0123456789");
  writeFileSync(join(d, "eleven"), "0123456789A");
  const { read } = over(d, [], { fileBytes: 10 });
  const started = Date.now();
  if (fifo) await refused(read({ kind: "file", id: "pipe" }, "t"), "refused");
  await refused(read({ kind: "file", id: "dir" }, "t"), "refused");
  assert.ok(Date.now() - started < 5_000, "a pipe does not hold the reading");
  await refused(read({ kind: "file", id: "eleven" }, "t"), "too_large");
  assert.equal(await read({ kind: "file", id: "ten" }, "t"), sha("0123456789"));
  writeFileSync(join(d, "sparse"), "");
  // NTFS does not make a file sparse when it is extended (it reserves the space: 50 GiB was ENOSPC on the Windows runner), so there the huge file is 2 GiB; still far above the cap, and never read.
  truncateSync(join(d, "sparse"), (process.platform === "win32" ? 2 : 50) * 1024 * 1024 * 1024);
  await refused(over(d).read({ kind: "file", id: "sparse" }, "t"), "too_large");
  writeFileSync(join(d, "limit"), Buffer.alloc(8 * 1024 * 1024, 7));
  assert.equal(await over(d).read({ kind: "file", id: "limit" }, "t"), sha(Buffer.alloc(8 * 1024 * 1024, 7)), "the bridge's own limit is the default cap");
  writeFileSync(join(d, "over"), Buffer.alloc(8 * 1024 * 1024 + 1, 7));
  await refused(over(d).read({ kind: "file", id: "over" }, "t"), "too_large");
});

test("card A05b follow-up: a name that collides with another spelling in its directory is refused, as the bridge refuses it", async () => {
  const d = temp();
  writeFileSync(join(d, "Readme.md"), "x");
  const { read } = over(d);
  await refused(read({ kind: "file", id: "README.md" }, "t"), "refused");
  assert.equal(await read({ kind: "file", id: "Readme.md" }, "t"), sha("x"));
  mkdirSync(join(d, "Docs"));
  await refused(read({ kind: "file", id: "docs/a" }, "t"), "refused");
});

test("card A05b follow-up: the project's access scope bounds which files are read", async () => {
  const d = temp();
  mkdirSync(join(d, "src"));
  mkdirSync(join(d, "private"));
  writeFileSync(join(d, "src", "a"), "a");
  writeFileSync(join(d, "private", "b"), "b");
  writeFileSync(join(d, "top"), "t");
  const { read } = over(d, ["src"]);
  assert.equal(await read({ kind: "file", id: "src/a" }, "t"), sha("a"));
  await refused(read({ kind: "file", id: "private/b" }, "t"), "refused");
  await refused(read({ kind: "file", id: "top" }, "t"), "refused");
  await refused(read({ kind: "file", id: "srcx" }, "t"), "refused");
  assert.equal(await over(d, []).read({ kind: "file", id: "top" }, "t"), sha("t"), "no paths: all of the checkout");
});

test("card A05b follow-up: a hard link is read as the file it is (the bridge refuses writes through it, not reads)", async () => {
  const d = temp();
  writeFileSync(join(d, "a"), "same");
  linkSync(join(d, "a"), join(d, "b"));
  assert.equal(await over(d).read({ kind: "file", id: "b" }, "t"), sha("same"));
});

test("card A05b follow-up: any other kind has no version and does not even look for the checkout (unversioned behaviour is unchanged)", async () => {
  const { read, located } = over(undefined);
  for (const kind of ["repository", "workspace", "service", "branch-x", "files", "Task", "run-script", ""]) assert.equal(await read({ kind, id: "main" }, "t"), undefined, kind);
  assert.equal(located(), 0);
  // Names an object has of its own are not record kinds: nothing is looked up for them.
  let looked = 0;
  const records = createTargetVersions({ storage: { getAggregate: async () => { looked++; return undefined; } }, location: async () => undefined });
  for (const kind of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf", "isPrototypeOf", "__defineGetter__"]) assert.equal(await records({ kind, id: "x" }, "t"), undefined, kind);
  assert.equal(looked, 0);
});

for (const backend of backends) {
  const suite = (name: string, body: (c: Awaited<ReturnType<typeof buildWorld>>) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const store = await backend.open();
      try { await body(await buildWorld(store.storage)); } finally { await store.close(); }
    });
  const hook = (c: Awaited<ReturnType<typeof buildWorld>>) => createTargetVersions({ storage: c.storage, location: async () => undefined });

  suite("card A05b follow-up: a record reads as its storage revision, which moves with every change, and as absent when it is not there", async (c) => {
    const ann = await c.agent("ann");
    const { taskId } = await c.task("mine", ann);
    const other = (await c.task("other", ann)).taskId;
    const read = hook(c);
    const rev = async (id: string): Promise<number> => (await c.storage.getAggregate({ kind: "task", id }))!.revision;
    const before = await read({ kind: "task", id: other }, taskId);
    assert.equal(before, `rev:${await rev(other)}`);
    assert.ok(TOKEN.test(before!) && redactText(before!) === before);
    await c.projects.updateTask({ commandId: "u1", actor: c.owner.id, taskId: other, expectedRevision: await rev(other), title: "renamed" });
    const after = await read({ kind: "task", id: other }, taskId);
    assert.equal(after, `rev:${await rev(other)}`);
    assert.notEqual(after, before);
    assert.equal(await read({ kind: "task", id: other }, taskId), after, "the same record at the same revision reads the same");
    assert.equal(await read({ kind: "task", id: "tsk-aaaaaaaaaaaaaaaaaaaa" }, taskId), "absent");
    assert.equal(await read({ kind: "project", id: c.project }, taskId), `rev:${(await c.storage.getAggregate({ kind: "project", id: c.project }))!.revision}`);
    assert.equal(await read({ kind: "task-contract", id: other }, taskId), "absent", "a task with no contract");
  });

  suite("card A05b follow-up: the calling task's own record is the implicit target of a call with none, so it is not versioned; another project's records read as absent", async (c) => {
    const ann = await c.agent("ann");
    const { taskId } = await c.task("mine", ann);
    const read = hook(c);
    assert.equal(await read({ kind: "task", id: taskId }, taskId), undefined, "its revision moves with every status change; binding to it would void approvals for nothing");
    const elsewhere = (await c.projects.createProject({ commandId: "p2", actor: c.owner.id, name: "Elsewhere" })).id;
    const foreign = (await c.task("foreign", ann, { project: elsewhere })).taskId;
    assert.equal(await read({ kind: "task", id: foreign }, taskId), "absent", "a record of another project shows nothing about itself");
    assert.equal(await read({ kind: "project", id: elsewhere }, taskId), "absent");
    assert.match((await read({ kind: "project", id: c.project }, taskId))!, /^rev:\d+$/);
  });

  suite("card A05b follow-up: a calling task that is gone cannot read records (error, fail closed)", async (c) => {
    await refused(hook(c)({ kind: "project", id: c.project }, "tsk-aaaaaaaaaaaaaaaaaaaa"), "unreadable");
  });

  suite("card A05b follow-up: the checkout comes from the project's bound repository, so a branch and a file are read from where the task works", async (c) => {
    const ann = await c.agent("ann");
    const d = repo();
    const head = commit(d, "a.txt", "one");
    await c.resources.bindResource(c.owner, { commandId: "b1", projectId: c.project, kind: "repository", label: "main", locator: d, repositoryId: "repo1", access: "read", paths: ["a.txt", ".github"] } as never);
    const { taskId } = await c.task("t", ann, { repositoryId: "repo1" });
    const read = createTargetVersions({ storage: c.storage, location: (id) => c.resources.checkoutLocation(id) });
    assert.equal(await read({ kind: "branch", id: "main" }, taskId), head);
    assert.equal(await read({ kind: "file", id: "a.txt" }, taskId), sha("one"));
    await refused(read({ kind: "file", id: "b.txt" }, taskId), "refused");
    const noRepo = (await c.task("t2", ann)).taskId;
    assert.equal(await read({ kind: "branch", id: "main" }, noRepo), undefined, "a task with no bound repository is bound by name, as before");
    assert.equal(await read({ kind: "file", id: "a.txt" }, noRepo), undefined);
  });
}
