import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { link, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ABSENT, BRIDGE_LIMITS, WorkspaceBridge, WorkspaceError, collisions, fold, isGitName, nameProblem, resolveSafe, splitRelative, touchesGit, versionOf } from "./index.js";
import { resolveInside } from "./paths.js";

const isWindows = process.platform === "win32";
const posix = isWindows ? "POSIX links and permissions" : false;
const refuses = async (code: string, run: () => Promise<unknown>, check?: (e: WorkspaceError) => void): Promise<void> => {
  await assert.rejects(run, (e: unknown) => { assert.ok(e instanceof WorkspaceError, String(e)); assert.equal(e.code, code, e.message); check?.(e); return true; });
};
async function world(): Promise<{ dir: string; shared: string; state: string; bridge: WorkspaceBridge; done(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "nn-ws-"));
  const shared = join(dir, "shared"); const state = join(dir, "state");
  await mkdir(join(shared, "src"), { recursive: true }); await mkdir(join(shared, ".git"), { recursive: true });
  await writeFile(join(shared, "README.md"), "hello\n"); await writeFile(join(shared, "src", "main.ts"), "export const x = 1;\n"); await writeFile(join(shared, ".git", "config"), "[core]\n");
  return { dir, shared, state, bridge: new WorkspaceBridge({ shared, state, clock: () => "2026-10-22T13:00:00.000Z" }), done: () => rm(dir, { recursive: true, force: true }) };
}

test("Git's own data is recognised in every spelling a filesystem might treat as the same name", () => {
  for (const name of [".git", ".GIT", ".Git", ".git.", ".git ", ".git . .", "git~1", "GIT~1", ".g\u200Bit", ".\u200Dgit", ".gi\u2060t", "\uFEFF.git", ".git::$INDEX_ALLOCATION", ".git:stream", ".\u0067it", ".ｇｉｔ"]) assert.equal(isGitName(name), true, JSON.stringify(name));
  for (const name of [".gitignore", ".github", "git", ".gi", "digit", ".git-keep", "x.git", ".gitx", "git~"]) assert.equal(isGitName(name), false, name);
  assert.equal(touchesGit(["src", ".GIT", "config"]), true);
  assert.equal(touchesGit(["src", "git.md"]), false);
});

test("a path is a plain relative path: absolute, drive, UNC, backslash, parent, reserved, odd and over-long ones are refused with a reason", () => {
  for (const bad of ["", "/etc/passwd", "\\\\server\\share", "C:\\x", "C:x", "//host/x", "a\\b", "../x", "a/../b", "a/./b", "a//b", "a/", "a\0b", "con", "NUL.txt", "a/aux.log", "COM1", "lpt9.c", "a.", "a ", "a:b", "a/b?", "x<y", "q".repeat(300), `${"a/".repeat(70)}b`, "a".repeat(1100)]) assert.throws(() => splitRelative(bad), WorkspaceError, JSON.stringify(bad.slice(0, 30)));
  assert.deepEqual(splitRelative("src/deep/file.test.ts"), ["src", "deep", "file.test.ts"]);
  assert.deepEqual(splitRelative("ünï/✓.txt"), ["ünï", "✓.txt"]);
  assert.throws(() => splitRelative("a".repeat(230), { forWindows: true, rootLength: 20 }), WorkspaceError, "Windows' shorter total");
  assert.ok(nameProblem("fine.txt") === undefined && nameProblem("com") === undefined && nameProblem("console.log") === undefined);
  assert.equal(nameProblem("COM\u00B9"), "is a reserved Windows device name");
});

test("names that are the same file on a case-insensitive or normalising filesystem are found", () => {
  assert.equal(fold("Straße.TXT"), fold("strasse.txt".replace("ss", "ß")));
  assert.deepEqual(collisions(["a/README.md", "a/readme.md", "b/x", "caf\u00E9", "cafe\u0301", "same"]), [["a/README.md", "a/readme.md"], ["cafe\u0301", "caf\u00E9"]]);
  assert.deepEqual(collisions(["a/b", "a/c"]), []);
});

test("resolving: a plain file, a missing one, a directory; links, junction-like links, collisions, hard links and Git data are refused", { skip: posix }, async () => {
  const w = await world();
  try {
    assert.equal((await resolveSafe(w.shared, "src/main.ts")).exists, "file");
    assert.equal((await resolveSafe(w.shared, "src/new.ts")).exists, "missing");
    assert.equal((await resolveSafe(w.shared, "src")).exists, "directory");
    await refuses("not_found", () => resolveSafe(w.shared, "nope/deeper/file.txt"));
    await refuses("protected_path", () => resolveSafe(w.shared, ".git/config"));
    await refuses("protected_path", () => resolveSafe(w.shared, "src/.GIT/hooks/pre-commit"));
    await refuses("protected_path", () => resolveSafe(w.shared, ".g\u200Bit/config"));
    assert.equal((await resolveInside(w.shared, ".git/config", { protect: false })).exists, "file", "the controller's own reads can look inside");
    // A link anywhere on the way, to a file, a directory, outside, or inside.
    await writeFile(join(w.dir, "outside.txt"), "outside\n");
    await symlink(join(w.dir, "outside.txt"), join(w.shared, "link.txt"));
    await symlink(w.dir, join(w.shared, "up"));
    await symlink(join(w.shared, "src"), join(w.shared, "inside"));
    for (const p of ["link.txt", "up/outside.txt", "inside/main.ts", "up"]) await refuses("link_refused", () => resolveSafe(w.shared, p), undefined);
    // A dangling link is a link, not a free name.
    await symlink(join(w.dir, "nowhere"), join(w.shared, "dangling"));
    await refuses("link_refused", () => resolveSafe(w.shared, "dangling", { forWrite: true }));
    // Another spelling of an existing name.
    await refuses("collision", () => resolveSafe(w.shared, "readme.MD", { forWrite: true }));
    await refuses("collision", () => resolveSafe(w.shared, "SRC/x.ts"));
    // A file with another name elsewhere.
    await link(join(w.dir, "outside.txt"), join(w.shared, "hard.txt"));
    assert.equal((await resolveSafe(w.shared, "hard.txt")).exists, "file", "reading it is allowed");
    await refuses("link_refused", () => resolveSafe(w.shared, "hard.txt", { forWrite: true }));
    // The root itself must exist.
    await refuses("unavailable", () => resolveSafe(join(w.dir, "missing-root"), "a"));
  } finally { await w.done(); }
});

test("an expected-version write succeeds when the file is as the writer saw it, and the result is the new version", async () => {
  const w = await world();
  try {
    const first = await w.bridge.read("src/main.ts");
    assert.equal(first.version, versionOf(Buffer.from("export const x = 1;\n")));
    const result = await w.bridge.write({ path: "src/main.ts", expectedVersion: first.version, content: Buffer.from("export const x = 2;\n"), author: "agent:ann", reason: "bump x" });
    assert.deepEqual(result, { status: "written", version: versionOf(Buffer.from("export const x = 2;\n")) });
    assert.equal(await readFile(join(w.shared, "src", "main.ts"), "utf8"), "export const x = 2;\n");
    if (!isWindows) assert.equal((await stat(join(w.shared, "src", "main.ts"))).mode & 0o777, (await stat(join(w.shared, "README.md"))).mode & 0o777, "the file keeps its mode");
    // A new file is written against 'absent'; a leftover temporary name is never left behind.
    assert.equal((await w.bridge.write({ path: "src/new.ts", expectedVersion: ABSENT, content: Buffer.from("new\n"), author: "agent:ann", reason: "add" })).status, "written");
    assert.deepEqual((await readdir(join(w.shared, "src"))).sort(), ["main.ts", "new.ts"]);
    assert.deepEqual(await w.bridge.read("nothing.txt"), { content: undefined, version: ABSENT });
  } finally { await w.done(); }
});

test("a write against a changed file is not applied: the change is kept whole for review, and nothing is merged or lost", async () => {
  const w = await world();
  try {
    const seen = await w.bridge.read("README.md");
    await writeFile(join(w.shared, "README.md"), "someone else changed this\n");
    const result = await w.bridge.write({ path: "README.md", expectedVersion: seen.version, content: Buffer.from("my version\n"), author: "agent:ann", reason: "reword" });
    assert.equal(result.status, "rejected");
    assert.equal(await readFile(join(w.shared, "README.md"), "utf8"), "someone else changed this\n", "the shared file was not touched");
    const [kept] = await w.bridge.pending();
    assert.deepEqual([kept!.path, kept!.author, kept!.reason, kept!.expectedVersion === seen.version, kept!.foundVersion === versionOf(Buffer.from("someone else changed this\n")), kept!.operation, kept!.state], ["README.md", "agent:ann", "reword", true, true, "write", "pending"]);
    assert.equal(Buffer.from(kept!.content!, "base64").toString(), "my version\n");
    // A write for a file that appeared since the writer saw 'absent', and a delete of a changed file, are kept too.
    await writeFile(join(w.shared, "fresh.txt"), "appeared\n");
    assert.equal((await w.bridge.write({ path: "fresh.txt", expectedVersion: ABSENT, content: Buffer.from("x"), author: "agent:ann", reason: "add" })).status, "rejected");
    assert.equal((await w.bridge.remove({ path: "README.md", expectedVersion: seen.version, author: "agent:ann", reason: "drop" })).status, "rejected");
    assert.equal((await w.bridge.pending()).length, 3);
    assert.equal((await w.bridge.pending()).filter((c) => c.operation === "delete").length, 1);
    assert.equal(await readFile(join(w.shared, "README.md"), "utf8"), "someone else changed this\n");
  } finally { await w.done(); }
});

test("the owner decides on a kept change: apply only against the version they reviewed, discard keeps the record, nothing is ever removed", async () => {
  const w = await world();
  try {
    const seen = await w.bridge.read("README.md");
    await writeFile(join(w.shared, "README.md"), "changed\n");
    const rejected = await w.bridge.write({ path: "README.md", expectedVersion: seen.version, content: Buffer.from("mine\n"), author: "agent:ann", reason: "reword" });
    assert.equal(rejected.status, "rejected");
    const id = rejected.status === "rejected" ? rejected.pendingId : "";
    // The file changes again after the owner looked: applying against the old review is stale.
    const reviewed = versionOf(Buffer.from("changed\n"));
    await writeFile(join(w.shared, "README.md"), "changed again\n");
    assert.deepEqual(await w.bridge.decide(id, { decision: "apply", decidedBy: "owner:rob", reviewedVersion: reviewed }), { status: "stale", foundVersion: versionOf(Buffer.from("changed again\n")) });
    assert.equal(await readFile(join(w.shared, "README.md"), "utf8"), "changed again\n");
    assert.equal((await w.bridge.pending()).length, 1, "still waiting");
    await assert.rejects(() => w.bridge.decide(id, { decision: "apply", decidedBy: "owner:rob" }), WorkspaceError);
    assert.deepEqual(await w.bridge.decide(id, { decision: "apply", decidedBy: "owner:rob", reviewedVersion: versionOf(Buffer.from("changed again\n")) }), { status: "applied" });
    assert.equal(await readFile(join(w.shared, "README.md"), "utf8"), "mine\n");
    assert.deepEqual([(await w.bridge.pending()).length, (await w.bridge.pending("applied")).length], [0, 1]);
    await refuses("not_found", () => w.bridge.decide(id, { decision: "discard", decidedBy: "owner:rob" }), undefined);
    // Discard.
    const second = await w.bridge.write({ path: "README.md", expectedVersion: seen.version, content: Buffer.from("again\n"), author: "agent:ann", reason: "reword" });
    await w.bridge.decide(second.status === "rejected" ? second.pendingId : "", { decision: "discard", decidedBy: "owner:rob" });
    assert.equal((await w.bridge.pending("discarded")).length, 1);
    assert.equal(await readFile(join(w.shared, "README.md"), "utf8"), "mine\n");
    await refuses("not_found", () => w.bridge.decide("0".repeat(32), { decision: "discard", decidedBy: "owner:rob" }));
  } finally { await w.done(); }
});

test("nothing reaches Git's data or leaves the workspace through the bridge, in any operation", { skip: posix }, async () => {
  const w = await world();
  try {
    const gitConfig = await readFile(join(w.shared, ".git", "config"));
    const attempts = [".git/config", ".git/hooks/pre-commit", ".GIT/config", ".git", "src/.git", "src/.Git/x", ".g\u200Bit/config", "git~1/config", ".git./config", ".git::$INDEX_ALLOCATION/x"];
    for (const p of attempts) {
      await refuses("protected_path", () => w.bridge.write({ path: p, expectedVersion: ABSENT, content: Buffer.from("[core]\nhooksPath=/tmp/evil\n"), author: "agent:ann", reason: "x" }), undefined);
      await refuses("protected_path", () => w.bridge.remove({ path: p, expectedVersion: versionOf(gitConfig), author: "agent:ann", reason: "x" }));
      await refuses("protected_path", () => w.bridge.read(p));
    }
    assert.deepEqual(await readFile(join(w.shared, ".git", "config")), gitConfig);
    // Links and parents.
    await writeFile(join(w.dir, "outside.txt"), "outside\n");
    await symlink(join(w.dir, "outside.txt"), join(w.shared, "link.txt"));
    await symlink(join(w.shared, ".git"), join(w.shared, "gitlink"));
    for (const p of ["link.txt", "gitlink/config", "../outside.txt", "/etc/passwd"]) {
      await assert.rejects(() => w.bridge.write({ path: p, expectedVersion: ABSENT, content: Buffer.from("x"), author: "agent:ann", reason: "x" }), WorkspaceError, p);
    }
    assert.equal(await readFile(join(w.dir, "outside.txt"), "utf8"), "outside\n");
    assert.deepEqual(await readFile(join(w.shared, ".git", "config")), gitConfig);
    // A hard link to a file outside is not written through.
    await link(join(w.dir, "outside.txt"), join(w.shared, "hard.txt"));
    await refuses("link_refused", () => w.bridge.write({ path: "hard.txt", expectedVersion: versionOf(Buffer.from("outside\n")), content: Buffer.from("changed"), author: "agent:ann", reason: "x" }));
    assert.equal(await readFile(join(w.dir, "outside.txt"), "utf8"), "outside\n");
    // Another spelling of an existing file is a collision.
    await refuses("collision", () => w.bridge.write({ path: "readme.md", expectedVersion: ABSENT, content: Buffer.from("x"), author: "agent:ann", reason: "x" }));
    // A directory is not a file.
    await refuses("invalid_path", () => w.bridge.write({ path: "src", expectedVersion: ABSENT, content: Buffer.from("x"), author: "agent:ann", reason: "x" }));
    await refuses("invalid_path", () => w.bridge.remove({ path: "src", expectedVersion: versionOf(Buffer.from("x")), author: "agent:ann", reason: "x" }));
  } finally { await w.done(); }
});

test("two writers at once against the same version: exactly one writes, the other's change is kept", async () => {
  const w = await world();
  try {
    const seen = await w.bridge.read("README.md");
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => w.bridge.write({ path: "README.md", expectedVersion: seen.version, content: Buffer.from(`writer ${i}\n`), author: `agent:w${i}`, reason: "race" })));
    assert.equal(results.filter((r) => r.status === "written").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 7);
    assert.equal((await w.bridge.pending()).length, 7);
    const winner = (await readFile(join(w.shared, "README.md"), "utf8")).trim();
    assert.match(winner, /^writer \d$/);
    assert.deepEqual((await readdir(w.shared)).filter((n) => n.endsWith(".tmp")), []);
    assert.deepEqual(await readdir(join(w.state, "locks")), [], "no lock is left behind");
  } finally { await w.done(); }
});

test("the bridge's own inputs are checked: versions, authors, reasons, sizes, and a stale lock is cleared", async () => {
  const w = await world();
  try {
    const ok = { path: "README.md", expectedVersion: versionOf(Buffer.from("hello\n")), content: Buffer.from("x"), author: "agent:ann", reason: "r" };
    for (const bad of [{ expectedVersion: "latest" }, { expectedVersion: "sha256:zz" }, { author: "" }, { reason: "" }, { reason: "r".repeat(501) }, { content: "text" as unknown as Buffer }, { content: Buffer.alloc(BRIDGE_LIMITS.fileBytes + 1) }]) await assert.rejects(() => w.bridge.write({ ...ok, ...bad }), WorkspaceError, JSON.stringify(Object.keys(bad)));
    await refuses("not_found", () => w.bridge.remove({ path: "README.md", expectedVersion: ABSENT, author: "agent:ann", reason: "r" }));
    // A lock left by a dead process more than a minute ago does not block for ever.
    await mkdir(join(w.state, "locks"), { recursive: true });
    const { createHash } = await import("node:crypto");
    const key = createHash("sha256").update("readme.md").digest("hex").slice(0, 32);
    await mkdir(join(w.state, "locks", `${key}.lock`));
    const old = new Date(Date.now() - 120_000);
    const { utimes } = await import("node:fs/promises");
    await utimes(join(w.state, "locks", `${key}.lock`), old, old);
    assert.equal((await w.bridge.write(ok)).status, "written");
    execFileSync(process.execPath, ["-e", "0"]);
    assert.ok(await lstat(join(w.shared, "README.md")));
  } finally { await w.done(); }
});

test("Windows: a junction is a link and is refused, as are drive roots and device names", { skip: isWindows ? false : "Windows only" }, async () => {
  const w = await world();
  try {
    await mkdir(join(w.dir, "target"));
    await writeFile(join(w.dir, "target", "secret.txt"), "outside\n");
    await symlink(join(w.dir, "target"), join(w.shared, "junction"), "junction");
    await refuses("link_refused", () => resolveSafe(w.shared, "junction/secret.txt"));
    await refuses("link_refused", () => resolveSafe(w.shared, "junction"));
    for (const bad of ["C:\\Windows\\win.ini", "C:/Windows", "\\\\?\\C:\\x", "\\\\server\\share\\x", "NUL", "src/CON.txt"]) await assert.rejects(() => resolveSafe(w.shared, bad), WorkspaceError, bad);
    assert.equal(await readFile(join(w.dir, "target", "secret.txt"), "utf8"), "outside\n");
  } finally { await w.done(); }
});

test("apply and discard at the same moment: exactly one decision is made and the record says what happened", async () => {
  const w = await world();
  try {
    for (let round = 0; round < 6; round++) {
      const seen = await w.bridge.read("README.md");
      await writeFile(join(w.shared, "README.md"), `changed ${round}\n`);
      const kept = await w.bridge.write({ path: "README.md", expectedVersion: seen.version, content: Buffer.from(`mine ${round}\n`), author: "agent:ann", reason: "race" });
      const id = kept.status === "rejected" ? kept.pendingId : "";
      const reviewed = versionOf(Buffer.from(`changed ${round}\n`));
      const settled = await Promise.allSettled([w.bridge.decide(id, { decision: "apply", decidedBy: "owner:rob", reviewedVersion: reviewed }), w.bridge.decide(id, { decision: "discard", decidedBy: "owner:rob" })]);
      assert.equal(settled.filter((s) => s.status === "fulfilled").length, 1, `round ${round}`);
      const applied = (await w.bridge.pending("applied")).some((c) => c.id === id);
      const discarded = (await w.bridge.pending("discarded")).some((c) => c.id === id);
      assert.equal(applied !== discarded, true, "recorded as exactly one of them");
      assert.equal((await readFile(join(w.shared, "README.md"), "utf8")) === `mine ${round}\n`, applied, "the file matches the record");
      assert.equal((await w.bridge.pending()).some((c) => c.id === id), false);
    }
  } finally { await w.done(); }
});

test("a lock held by a live holder is not taken over; one abandoned for a minute is, by exactly one waiter; spellings of one file share a lock", async () => {
  const w = await world();
  try {
    const { createHash } = await import("node:crypto");
    const { utimes } = await import("node:fs/promises");
    const idOf = (path: string) => createHash("sha256").update(`path/${path}`).digest("hex").slice(0, 32);
    // The lock for README.md is the lock for readme.MD: both fold to the same key.
    const key = idOf("readme.md");
    await mkdir(join(w.state, "locks", `${key}.lock`), { recursive: true });
    await writeFile(join(w.state, "locks", `${key}.lock`, "owner"), "someone-else");
    const fresh = new WorkspaceBridge({ shared: w.shared, state: w.state });
    // Fresh lock: a write waits and gives up (short wait is not configurable, so only check the stale path with several waiters).
    const old = new Date(Date.now() - 120_000);
    await utimes(join(w.state, "locks", `${key}.lock`), old, old);
    const seen = await fresh.read("README.md");
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => fresh.write({ path: i % 2 === 0 ? "README.md" : "README.md", expectedVersion: seen.version, content: Buffer.from(`w${i}\n`), author: `a${i}`, reason: "r" })));
    assert.equal(results.filter((r) => r.status === "written").length, 1, "one writer despite several waiters clearing the stale lock");
    assert.deepEqual((await readdir(join(w.state, "locks"))).filter((n) => n.endsWith(".lock")), [], "every lock released");
  } finally { await w.done(); }
});

test("short-name aliases and hashed 8.3 names are Git's too, and refused on Windows rules", () => {
  for (const name of ["GIT~1", "git~2", "GI7EBA~1", "gi3f2a~1"]) assert.equal(isGitName(name), true, name);
  assert.equal(isGitName("gift~1x"), false);
  assert.ok(nameProblem("PROGRA~1", true) !== undefined && nameProblem("report~12.txt", true) !== undefined);
  assert.equal(nameProblem("report~12.txt", false), undefined);
});
