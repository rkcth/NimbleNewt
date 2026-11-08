import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, constants as fsConstants, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { test, type TestContext } from "node:test";
import { DomainError } from "../domain/errors.js";
import { checkDefinition, definedSource, fileSnapshot, gitDirFromPointer, httpHealth, insideName, readSmall, repositoryRefs, type SourceDefinition } from "./defined-sources.js";

const NOW = "2026-11-08T10:00:00.000Z";
/** Makes a symbolic link. Windows refuses one without the privilege (or developer mode): there, and only there, that refusal is reported and the caller leaves out what needs the link. */
const linked = (target: string, link: string, t: TestContext): boolean => {
  try { symlinkSync(target, link); return true; } catch (error) {
    if (process.platform === "win32" && ((error as NodeJS.ErrnoException).code === "EPERM" || (error as NodeJS.ErrnoException).code === "EACCES")) { t.diagnostic(`symbolic links cannot be made here (${(error as NodeJS.ErrnoException).code}); the link checks are left out`); return false; }
    throw error;
  }
};
const refused = (raw: Record<string, unknown>, field: string): void => {
  assert.throws(() => checkDefinition(raw, NOW, "owner:rob"), (e: unknown) => e instanceof DomainError && e.code === "invalid_command" && e.field === field, `${JSON.stringify(raw)} should be refused on ${field}`);
};
const base = { sourceId: "s1", projectId: "prj-aaaaaaaaaaaaaaaaaaaa" };

test("a definition is checked field by field: the type's own fields only, bounded numbers, absolute paths, http(s) addresses without credentials, a single time not already past (card H13f)", () => {
  assert.deepEqual(checkDefinition({ ...base, type: "timer", everyMinutes: 15 }, NOW, "owner:rob"), { id: "s1", type: "timer", projectId: base.projectId, everyMinutes: 15, definedAt: NOW, definedBy: "owner:rob" });
  assert.equal(checkDefinition({ ...base, type: "timer", at: "2026-11-09T09:00:00+01:00" }, NOW, "o").at, "2026-11-09T08:00:00.000Z");
  // The path is kept as the owner wrote it (not re-resolved, so it reads the same on every platform); it must be absolute for the controller's own machine.
  const absolute = process.platform === "win32" ? "C:\\srv\\data\\..\\data\\in" : "/srv/data/../data/in";
  assert.equal(checkDefinition({ ...base, type: "file", path: absolute, taskId: "tsk-1" }, NOW, "o").path, absolute);
  assert.equal(checkDefinition({ ...base, type: "service", url: "http://127.0.0.1:8080/health", checkSeconds: 30 }, NOW, "o").url, "http://127.0.0.1:8080/health");
  refused({ ...base, sourceId: "bad id", type: "timer", everyMinutes: 1 }, "sourceId");
  refused({ ...base, type: "cron", everyMinutes: 1 }, "type");
  refused({ ...base, projectId: "", type: "timer", everyMinutes: 1 }, "projectId");
  refused({ ...base, type: "timer" }, "everyMinutes");
  refused({ ...base, type: "timer", everyMinutes: 5, at: "2026-11-09T09:00:00Z" }, "everyMinutes");
  refused({ ...base, type: "timer", everyMinutes: 0 }, "everyMinutes");
  refused({ ...base, type: "timer", everyMinutes: 1.5 }, "everyMinutes");
  refused({ ...base, type: "timer", at: "2026-11-08T09:59:00Z" }, "at");
  refused({ ...base, type: "timer", at: "tomorrow" }, "at");
  refused({ ...base, type: "timer", everyMinutes: 5, path: "/x" }, "path");
  refused({ ...base, type: "file", path: "relative/dir" }, "path");
  refused({ ...base, type: "file", path: "/a\0b" }, "path");
  refused({ ...base, type: "file", path: "/x", url: "http://a" }, "url");
  refused({ ...base, type: "repository", path: "/x", checkSeconds: 5 }, "checkSeconds");
  refused({ ...base, type: "service", url: "ftp://host/x" }, "url");
  refused({ ...base, type: "service", url: "not a url" }, "url");
  refused({ ...base, type: "service", url: "https://user:secret@host/health" }, "url");
});

test("paths read the same on every platform: a watched path is checked with the controller's own path rules and kept as written, names inside a folder use '/', and a worktree's gitdir pointer resolves with either separator (card H13f, Windows)", () => {
  const def = (path: string, p: typeof posix) => checkDefinition({ ...base, type: "repository", path }, NOW, "o", p);
  const refusedOn = (path: string, p: typeof posix): void => { assert.throws(() => def(path, p), (e: unknown) => e instanceof DomainError && e.field === "path", `${path} should be refused`); };
  // Windows: a drive path, a UNC share and a root-relative path are absolute; a drive-relative or relative one is not. Each is kept exactly as written.
  for (const p of ["C:\\data\\in", "C:/data/in", "\\\\server\\share\\repo", "/srv/data"]) assert.equal(def(p, win32).path, p);
  for (const p of ["C:data", "data\\in", "..\\in"]) refusedOn(p, win32);
  // POSIX: a Windows drive path could never be opened there, so it is refused when defined, not watched as missing for ever.
  assert.equal(def("/srv/data/in", posix).path, "/srv/data/in");
  for (const p of ["C:\\data", "C:/data", "data/in"]) refusedOn(p, posix);
  // Names inside a folder.
  assert.equal(insideName("C:\\w", "C:\\w\\sub\\b.txt", win32), "sub/b.txt");
  assert.equal(insideName("C:\\w", "C:\\w\\a.txt", win32), "a.txt");
  assert.equal(insideName("/w", "/w/sub/b.txt", posix), "sub/b.txt");
  // The `.git` file of a linked worktree: git on Windows writes `C:/...` or a relative path, possibly with CRLF; a byte-order mark is dropped; anything else names nothing.
  assert.equal(gitDirFromPointer("C:\\work\\wt", "gitdir: C:/work/repo/.git/worktrees/wt\r\n", win32), "C:\\work\\repo\\.git\\worktrees\\wt");
  assert.equal(gitDirFromPointer("C:\\work\\wt", "\uFEFFgitdir: ..\\repo\\.git\\worktrees\\wt", win32), "C:\\work\\repo\\.git\\worktrees\\wt");
  assert.equal(gitDirFromPointer("/work/wt", "gitdir: /work/repo/.git/worktrees/wt\n", posix), "/work/repo/.git/worktrees/wt");
  assert.equal(gitDirFromPointer("/work/wt", "gitdir: ../repo/.git/worktrees/wt\nextra line\n", posix), "/work/repo/.git/worktrees/wt");
  assert.equal(gitDirFromPointer("/work/wt", "not a pointer", posix), undefined);
  assert.equal(gitDirFromPointer("/work/wt", "gitdir:   \n", posix), undefined);
});

test("a git file that is a link is not read even where the open cannot refuse links (Windows has no O_NOFOLLOW), and a non-regular file is never read (card H13f, Windows)", async (t) => {
  const d = mkdtempSync(join(tmpdir(), "nn-defsrc-read-"));
  try {
    writeFileSync(join(d, "ref"), `${"a".repeat(40)}\n`);
    mkdirSync(join(d, "dir"));
    assert.equal(await readSmall(join(d, "ref"), 100, fsConstants.O_RDONLY), `${"a".repeat(40)}\n`);
    assert.equal(await readSmall(join(d, "ref"), 10, fsConstants.O_RDONLY), undefined, "larger than allowed");
    assert.equal(await readSmall(join(d, "dir"), 100, fsConstants.O_RDONLY), undefined, "a directory");
    await assert.rejects(() => readSmall(join(d, "missing"), 100, fsConstants.O_RDONLY), (e: NodeJS.ErrnoException) => e.code === "ENOENT");
    if (!linked(join(d, "ref"), join(d, "link"), t)) return;
    assert.equal(await readSmall(join(d, "link"), 100, fsConstants.O_RDONLY), undefined, "a link to a regular file, opened without O_NOFOLLOW");
    assert.equal(await readSmall(join(d, "link"), 100), undefined, "and with the platform's flags");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a folder snapshot lists the files under it by their path inside it, skips .git and node_modules, does not follow symbolic links, and a missing path is empty (card H13f)", async (t) => {
  const d = mkdtempSync(join(tmpdir(), "nn-defsrc-"));
  try {
    mkdirSync(join(d, "w", "sub"), { recursive: true });
    mkdirSync(join(d, "w", ".git")); mkdirSync(join(d, "w", "node_modules"));
    mkdirSync(join(d, "outside"));
    writeFileSync(join(d, "w", "a.txt"), "one");
    writeFileSync(join(d, "w", "sub", "b.txt"), "two");
    writeFileSync(join(d, "w", ".git", "HEAD"), "ref");
    writeFileSync(join(d, "w", "node_modules", "x.js"), "x");
    writeFileSync(join(d, "outside", "secret.txt"), "s");
    linked(join(d, "outside"), join(d, "w", "link"), t);
    const first = await fileSnapshot(join(d, "w"));
    assert.deepEqual(first.map((e) => e.name), ["a.txt", "sub/b.txt"]);
    assert.match(first[0]!.version, /^3:\d+$/);
    utimesSync(join(d, "w", "a.txt"), new Date(2020, 1, 1), new Date(2020, 1, 1));
    assert.notEqual((await fileSnapshot(join(d, "w")))[0]!.version, first[0]!.version, "a new modification time is a new version");
    assert.deepEqual((await fileSnapshot(join(d, "w", "a.txt"))).map((e) => e.name), ["a.txt"], "a single file is one entry");
    assert.deepEqual(await fileSnapshot(join(d, "missing")), []);
    // At most 1000 files: one more and the folder is refused (watch a smaller one), not listed in part.
    const many = join(d, "many"); mkdirSync(many);
    for (let i = 0; i < 1000; i++) writeFileSync(join(many, `f${i}`), "");
    assert.equal((await fileSnapshot(many)).length, 1000);
    writeFileSync(join(many, "one-more"), "");
    await assert.rejects(() => fileSnapshot(many), /more than 1000 files under the watched folder/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a repository's branches and tags are read from its files for a working copy, a linked worktree and a bare repository, and they match what git itself reports (card H13f)", async (t) => {
  const d = mkdtempSync(join(tmpdir(), "nn-defsrc-"));
  try {
    try { execFileSync("git", ["--version"], { stdio: "ignore" }); } catch { t.skip("git is not installed"); return; }
    const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: d } }).trim();
    const repo = join(d, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q");
    writeFileSync(join(repo, "f"), "1");
    git(repo, "add", "f"); git(repo, "commit", "-qm", "one");
    git(repo, "tag", "v1");
    git(repo, "branch", "feature/x");
    git(repo, "pack-refs", "--all");
    writeFileSync(join(repo, "f"), "2");
    git(repo, "commit", "-qam", "two");
    const truth = git(repo, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags").split("\n").map((l) => l.split(" ") as [string, string]).sort();
    const read = async (p: string) => (await repositoryRefs(p)).map((e) => [e.name, e.version] as [string, string]).sort();
    assert.deepEqual(await read(repo), truth, "packed refs and a loose ref that overrides one");
    git(repo, "worktree", "add", "-q", "-b", "wt-branch", join(d, "wt"));
    assert.deepEqual(await read(join(d, "wt")), (await read(repo)), "a linked worktree reads the common branches");
    assert.ok((await read(repo)).some(([n]) => n === "refs/heads/wt-branch"));
    git(d, "clone", "-q", "--bare", repo, join(d, "bare.git"));
    assert.deepEqual((await read(join(d, "bare.git"))).map(([n]) => n).filter((n) => n.startsWith("refs/heads/")).sort(), ["refs/heads/feature/x", "refs/heads/main", "refs/heads/wt-branch"]);
    await assert.rejects(() => repositoryRefs(join(d, "wt", "..", "nothing")), /not a git repository/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a hostile repository cannot hold or flood the source: a pipe, a link or an oversized file among git's own files is refused or left out, never read (card H13f review)", async (t) => {
  const d = mkdtempSync(join(tmpdir(), "nn-defsrc-hostile-"));
  try {
    const repo = join(d, "repo"); const git = join(repo, ".git");
    mkdirSync(join(git, "refs", "heads"), { recursive: true });
    writeFileSync(join(git, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(git, "refs", "heads", "main"), `${"a".repeat(40)}\n`);
    // A loose ref far larger than a commit name is left out (it is not read whole).
    writeFileSync(join(git, "refs", "heads", "huge"), `${"b".repeat(40)}\n${" ".repeat(100_000)}`);
    assert.deepEqual((await repositoryRefs(repo)).map((e) => e.name), ["refs/heads/main"]);
    // packed-refs as a directory is refused (everywhere).
    mkdirSync(join(git, "packed-refs"));
    await assert.rejects(() => repositoryRefs(repo), /packed-refs is not a regular file/);
    rmSync(join(git, "packed-refs"), { recursive: true });
    if (process.platform === "win32") { t.diagnostic("named pipes made with mkfifo and /dev/zero are POSIX: the pipe and device checks are left out"); return; }
    // packed-refs as a pipe: reading it would wait for ever and hold every event source; it is refused at once.
    execFileSync("mkfifo", [join(git, "packed-refs")]);
    const outcome = await Promise.race([repositoryRefs(repo).then(() => "returned", (e: Error) => `refused: ${e.message}`), new Promise<string>((r) => setTimeout(() => r("hung"), 5000).unref())]);
    // A reader left waiting on the pipe is let go (so a failure here fails, not hangs).
    if (outcome === "hung") closeSync(openSync(join(git, "packed-refs"), fsConstants.O_WRONLY | fsConstants.O_NONBLOCK));
    assert.match(outcome, /^refused: .*packed-refs is not a regular file/);
    rmSync(join(git, "packed-refs"));
    // packed-refs as a link to something else (a device that never ends, here) is not followed.
    symlinkSync("/dev/zero", join(git, "packed-refs"));
    await assert.rejects(() => repositoryRefs(repo), /packed-refs is not a regular file/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a health address is healthy on 2xx or 3xx, a failure or no answer is not, a redirect is not followed and the answer's body is not read into the detail (card H13f)", async () => {
  let status = 200;
  let followed = 0;
  const server = createServer((req, res) => {
    if (req.url === "/elsewhere") { followed++; res.writeHead(500); res.end(); return; }
    if (status === 302) { res.writeHead(302, { location: "/elsewhere" }); res.end(); return; }
    res.writeHead(status, { "content-type": "text/plain" }); res.end("ignore this: secret body");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/health`;
  try {
    assert.deepEqual(await httpHealth(url), { healthy: true, detail: "answered HTTP 200" });
    status = 503;
    assert.deepEqual(await httpHealth(url), { healthy: false, detail: "answered HTTP 503" });
    status = 302;
    assert.deepEqual(await httpHealth(url), { healthy: true, detail: "answered HTTP 302" });
    assert.equal(followed, 0, "the redirect was not followed");
  } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
  const down = await httpHealth(url);
  assert.equal(down.healthy, false);
  assert.match(down.detail, /^could not be reached \(/);
  assert.doesNotMatch(down.detail, /secret/);
});

test("a defined source starts from a baseline, is looked at no more often than checkSeconds, keeps going when it had more, and starts again from a baseline when it is redefined (card H13f)", async () => {
  let entries = [{ name: "a", version: "1" }];
  let looks = 0;
  const def = (over: Partial<SourceDefinition> = {}): SourceDefinition => ({ id: "inbox", type: "file", projectId: "prj-1", taskId: "tsk-1", path: "/watched", checkSeconds: 60, definedAt: NOW, definedBy: "owner:rob", ...over });
  const probes = { files: async () => { looks++; return entries; } };
  const at = (s: number): string => new Date(Date.parse(NOW) + s * 1000).toISOString();
  const src = definedSource(def(), probes);
  assert.equal(src.type, "file");
  const p1 = await src.poll({ state: undefined, now: at(0), limit: 10 });
  assert.deepEqual([p1.signals, looks], [[], 1], "the first look is a baseline");
  entries = [{ name: "a", version: "2" }, { name: "b", version: "1" }];
  const p2 = await src.poll({ state: p1.state, now: at(30), limit: 10 });
  assert.deepEqual([p2.signals, looks], [[], 1], "not looked at again before checkSeconds");
  const p3 = await src.poll({ state: p2.state, now: at(61), limit: 1 });
  assert.deepEqual(p3.signals.map((s) => [s.kind, s.stream, s.ref.kind]), [["file.changed", "task:tsk-1", "file"]]);
  assert.equal(p3.more, true);
  const p4 = await src.poll({ state: p3.state, now: at(62), limit: 1 });
  assert.equal(p4.signals.length, 1, "more waiting: looked at again at once, not after checkSeconds");
  assert.equal(looks, 3);
  // Redefined to another place under the same ID: what is there now is a baseline, not a difference from the old place.
  entries = [{ name: "z", version: "9" }];
  const moved = definedSource(def({ path: "/elsewhere" }), probes);
  assert.equal(looks, 3);
  assert.deepEqual((await moved.poll({ state: p4.state, now: at(63), limit: 10 })).signals, [], "looked at at once (a new definition), and what is there is a baseline");
  assert.equal(looks, 4);
  // Timers: a repeating one fires once for the latest slot (not once per slot missed); a single one fires once.
  const timer = definedSource({ id: "tick", type: "timer", projectId: "prj-1", everyMinutes: 10, definedAt: NOW, definedBy: "owner:rob" });
  const t0 = await timer.poll({ state: undefined, now: at(5 * 60), limit: 10 });
  assert.deepEqual(t0.signals, []);
  const t1 = await timer.poll({ state: t0.state, now: at(10 * 60), limit: 10 });
  assert.deepEqual(t1.signals.map((s) => [s.kind, s.stream, s.dedup]), [["timer.fired", "project:prj-1", `tick@${at(600)}`]]);
  assert.deepEqual((await timer.poll({ state: t1.state, now: at(15 * 60), limit: 10 })).signals, [], "the same slot does not fire twice");
  const late = await timer.poll({ state: t1.state, now: at(95 * 60), limit: 10 });
  assert.deepEqual(late.signals.map((s) => s.dedup), [`tick@${at(90 * 60)}`], "after a long pause only the latest slot fires");
  const once = definedSource({ id: "once", type: "timer", projectId: "prj-1", at: at(120), definedAt: NOW, definedBy: "owner:rob" });
  const o1 = await once.poll({ state: undefined, now: at(60), limit: 10 });
  const o2 = await once.poll({ state: o1.state, now: at(121), limit: 10 });
  assert.deepEqual([o1.signals.length, o2.signals.length, (await once.poll({ state: o2.state, now: at(500), limit: 10 })).signals.length], [0, 1, 0]);
  // A service: a failure is told once, its recovery once.
  let healthy = true;
  const svc = definedSource({ id: "api", type: "service", projectId: "prj-1", url: "http://127.0.0.1:1/", checkSeconds: 10, definedAt: NOW, definedBy: "owner:rob" }, { health: async () => ({ healthy, detail: healthy ? "answered HTTP 200" : "answered HTTP 503" }) });
  assert.equal(svc.type, "service-failure");
  const s0 = await svc.poll({ state: undefined, now: at(0), limit: 10 });
  healthy = false;
  const s1 = await svc.poll({ state: s0.state, now: at(11), limit: 10 });
  const s2 = await svc.poll({ state: s1.state, now: at(22), limit: 10 });
  healthy = true;
  const s3 = await svc.poll({ state: s2.state, now: at(33), limit: 10 });
  assert.deepEqual([s0, s1, s2, s3].map((p) => p.signals.map((s) => `${s.kind}:${s.text ?? ""}`)), [[], ["service.failed:answered HTTP 503"], [], ["service.recovered:answered HTTP 200"]]);
});
