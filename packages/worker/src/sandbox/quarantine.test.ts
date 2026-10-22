import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SandboxError } from "./errors.js";
import { listQuarantined, quarantine, readQuarantined } from "./quarantine.js";

/** Quarantined trees are read-only on purpose, so the test's own cleanup has to give write permission back first. */
async function cleanup(dir: string): Promise<void> {
  if (!isWindows) { try { execFileSync("chmod", ["-R", "u+w", dir]); } catch { /* best effort */ } }
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
const root0 = async () => mkdtemp(join(tmpdir(), "nn-quarantine-"));
const isWindows = process.platform === "win32";
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const at = { clock: () => "2026-10-22T10:00:00.000Z" };

async function tree(base: string): Promise<void> {
  await mkdir(join(base, "src", "deep"), { recursive: true });
  await writeFile(join(base, "README.md"), "hello\n");
  await writeFile(join(base, "src", "main.ts"), "export const x = 1;\n");
  await writeFile(join(base, "src", "deep", "notes.txt"), "unfinished work\n");
}

test("a lost workspace is moved, not deleted: contents intact, original place empty, manifest says where from, why, by whom and when", async () => {
  const dir = await root0();
  try {
    await tree(join(dir, "ws"));
    const record = await quarantine({ root: join(dir, "q"), path: join(dir, "ws"), reason: "the agent's grant for this project was revoked", by: "owner:rob", ...at });
    await assert.rejects(() => lstat(join(dir, "ws")), { code: "ENOENT" }, "nothing is left at the old place");
    assert.deepEqual([record.files, record.directories, record.symlinks, record.copied, record.at], [3, 3, 0, false, "2026-10-22T10:00:00.000Z"]);
    assert.equal(record.bytes, "hello\n".length + "export const x = 1;\n".length + "unfinished work\n".length);
    assert.equal((await readFile(join(dir, "q", record.id, "content", "src", "deep", "notes.txt"), "utf8")), "unfinished work\n");
    const listed = await listQuarantined(join(dir, "q"));
    assert.deepEqual(listed.map((r) => [r.id, r.reason, r.by]), [[record.id, "the agent's grant for this project was revoked", "owner:rob"]]);
    assert.ok(listed[0]!.originalPath.endsWith("ws"));
    const read = await readQuarantined(join(dir, "q"), record.id, "src/main.ts");
    assert.deepEqual([read.kind, read.kind === "file" ? read.content.toString() : ""], ["file", "export const x = 1;\n"]);
    const listing = await readQuarantined(join(dir, "q"), record.id);
    assert.deepEqual(listing.kind === "directory" ? listing.entries : [], ["README.md", "src"]);
  } finally { await cleanup(dir); }
});

test("what was quarantined is read-only", { skip: isRoot || isWindows ? "needs POSIX permissions and a non-root user" : false }, async () => {
  const dir = await root0();
  try {
    await tree(join(dir, "ws"));
    const record = await quarantine({ root: join(dir, "q"), path: join(dir, "ws"), reason: "lost", by: "owner:rob", ...at });
    const file = join(dir, "q", record.id, "content", "src", "main.ts");
    assert.equal((await stat(file)).mode & 0o222, 0, "no write bits on files");
    assert.equal((await stat(join(dir, "q", record.id, "content", "src"))).mode & 0o222, 0, "no write bits on directories");
    await assert.rejects(() => writeFile(file, "changed"), { code: "EACCES" });
    await assert.rejects(() => writeFile(join(dir, "q", record.id, "content", "new.txt"), "x"), { code: "EACCES" }, "nothing can be added either");
    assert.equal((await stat(join(dir, "q"))).mode & 0o077, 0, "the quarantine root is the owner's alone");
    // Make it removable again for the cleanup of the test directory only.
    await chmod(join(dir, "q", record.id, "content"), 0o755);
  } finally { await cleanup(dir); }
});

test("links are kept as links and never followed: the target outside is untouched and unreadable through the quarantine", { skip: isWindows ? "symbolic links need privileges on Windows" : false }, async () => {
  const dir = await root0();
  try {
    await tree(join(dir, "ws"));
    await writeFile(join(dir, "outside.txt"), "not part of the workspace\n", { mode: 0o644 });
    await symlink(join(dir, "outside.txt"), join(dir, "ws", "link.txt"));
    const record = await quarantine({ root: join(dir, "q"), path: join(dir, "ws"), reason: "lost", by: "owner:rob", ...at });
    assert.equal(record.symlinks, 1);
    if (!isWindows) assert.equal((await stat(join(dir, "outside.txt"))).mode & 0o777, 0o644, "the target's permissions were not touched");
    assert.equal(await readFile(join(dir, "outside.txt"), "utf8"), "not part of the workspace\n");
    await assert.rejects(() => readQuarantined(join(dir, "q"), record.id, "link.txt"), SandboxError);
    await chmod(join(dir, "q", record.id, "content"), 0o755).catch(() => undefined);
  } finally { await cleanup(dir); }
});

test("the owner's read cannot leave the quarantined directory", async () => {
  const dir = await root0();
  try {
    await tree(join(dir, "ws"));
    await writeFile(join(dir, "secret.txt"), "elsewhere");
    const record = await quarantine({ root: join(dir, "q"), path: join(dir, "ws"), reason: "lost", by: "owner:rob", ...at });
    for (const bad of ["../manifest.json", "../../secret.txt", "src/../../manifest.json", join(dir, "secret.txt")]) await assert.rejects(() => readQuarantined(join(dir, "q"), record.id, bad), SandboxError, bad);
    for (const bad of ["../x", "q-zz", "", "q-0123456789abcdef0123/../.."]) await assert.rejects(() => readQuarantined(join(dir, "q"), bad), SandboxError, bad);
    await assert.rejects(() => readQuarantined(join(dir, "q"), record.id, "nope.txt"), SandboxError);
  } finally { await cleanup(dir); }
});

test("it refuses what it cannot do safely, and a refusal leaves the directory where it was", async () => {
  const dir = await root0();
  try {
    await tree(join(dir, "ws"));
    const q = join(dir, "q");
    for (const reason of ["", "x".repeat(501)]) await assert.rejects(() => quarantine({ root: q, path: join(dir, "ws"), reason, by: "owner:rob" }), SandboxError);
    await assert.rejects(() => quarantine({ root: q, path: join(dir, "missing"), reason: "lost", by: "owner:rob" }), SandboxError);
    await assert.rejects(() => quarantine({ root: q, path: join(dir, "ws", "README.md"), reason: "lost", by: "owner:rob" }), SandboxError, "a file is not a workspace");
    await assert.rejects(() => quarantine({ root: join(dir, "ws", "inside"), path: join(dir, "ws"), reason: "lost", by: "owner:rob" }), SandboxError, "the root cannot be inside what is moved");
    await assert.rejects(() => quarantine({ root: dir, path: join(dir, "ws"), reason: "lost", by: "owner:rob" }), SandboxError, "the directory cannot be the root's parent either way round");
    assert.equal(await readFile(join(dir, "ws", "src", "main.ts"), "utf8"), "export const x = 1;\n");
    if (!isWindows) {
      await symlink(join(dir, "ws"), join(dir, "ws-link"));
      await assert.rejects(() => quarantine({ root: q, path: join(dir, "ws-link"), reason: "lost", by: "owner:rob" }), SandboxError, "a link is not a directory");
    }
    assert.deepEqual(await listQuarantined(q), []);
  } finally { await cleanup(dir); }
});

test("a failure at any point never deletes the work: before the move it stays where it was, after it the quarantine keeps it and says where", async () => {
  const dir = await root0();
  try {
    const q = join(dir, "q");
    await tree(join(dir, "ws"));
    // Before anything moves: a throwing clock leaves the directory untouched and no empty quarantine behind.
    await assert.rejects(() => quarantine({ root: q, path: join(dir, "ws"), reason: "lost", by: "owner:rob", clock: () => { throw new Error("clock broke"); } }));
    assert.equal(await readFile(join(dir, "ws", "src", "main.ts"), "utf8"), "export const x = 1;\n");
    assert.deepEqual(await listQuarantined(q), []);
    // After the move: the work is in the quarantine, the error says where, and the manifest says the record is unfinished.
    await assert.rejects(() => quarantine({ root: q, path: join(dir, "ws"), reason: "lost", by: "owner:rob", ...at, hooks: { afterMove: async () => { throw new Error("disk full"); } } }), (e) => e instanceof SandboxError && /nothing was deleted/.test(e.message) && /content/.test(e.message));
    await assert.rejects(() => lstat(join(dir, "ws")), { code: "ENOENT" });
    const [name] = (await readdir(q));
    assert.equal(await readFile(join(q, name!, "content", "src", "deep", "notes.txt"), "utf8"), "unfinished work\n");
    assert.equal(JSON.parse(await readFile(join(q, name!, "manifest.json"), "utf8")).incomplete, true);
  } finally { await cleanup(dir); }
});

test("across filesystems the tree is copied and verified by content before the original goes; if the original cannot be removed, both are kept", async () => {
  const dir = await root0();
  const exdev = async () => { throw Object.assign(new Error("cross-device"), { code: "EXDEV" }); };
  try {
    const q = join(dir, "q");
    await tree(join(dir, "ws"));
    const ok = await quarantine({ root: q, path: join(dir, "ws"), reason: "lost", by: "owner:rob", ...at, hooks: { rename: exdev } });
    assert.equal(ok.copied, true);
    await assert.rejects(() => lstat(join(dir, "ws")), { code: "ENOENT" });
    assert.equal(await readFile(join(q, ok.id, "content", "src", "main.ts"), "utf8"), "export const x = 1;\n");
    // The original cannot be removed: both copies stay, and the error names both.
    await tree(join(dir, "ws2"));
    await assert.rejects(() => quarantine({ root: q, path: join(dir, "ws2"), reason: "lost", by: "owner:rob", ...at, hooks: { rename: exdev, removeOriginal: async () => { throw new Error("busy"); } } }), (e) => e instanceof SandboxError && /both are kept/.test(e.message));
    assert.equal(await readFile(join(dir, "ws2", "README.md"), "utf8"), "hello\n");
    const [, second] = (await readdir(q)).sort();
    assert.ok(second !== undefined);
    // A copy that does not match (the original changed while it was copied) is not trusted, and the original stays.
    await tree(join(dir, "ws3"));
    await assert.rejects(() => quarantine({ root: q, path: join(dir, "ws3"), reason: "lost", by: "owner:rob", ...at, hooks: { rename: exdev, afterCopy: async () => { await writeFile(join(dir, "ws3", "README.md"), "hellO\n"); } } }), (e) => e instanceof SandboxError && /does not match/.test(e.message));
    assert.equal(await readFile(join(dir, "ws3", "README.md"), "utf8"), "hellO\n", "the original is still there");
    assert.ok(await lstat(join(dir, "ws3")));
  } finally { await cleanup(dir); }
});

test("the root is tightened if others could enter it, and a hard-linked file outside is not changed", { skip: isWindows ? "POSIX permissions" : false }, async () => {
  const dir = await root0();
  try {
    const q = join(dir, "q");
    await mkdir(q, { mode: 0o755 }); await chmod(q, 0o755);
    await tree(join(dir, "ws"));
    await writeFile(join(dir, "shared.txt"), "also elsewhere\n", { mode: 0o644 });
    await link(join(dir, "shared.txt"), join(dir, "ws", "shared-link.txt"));
    const record = await quarantine({ root: q, path: join(dir, "ws"), reason: "lost", by: "owner:rob", ...at });
    assert.equal((await stat(q)).mode & 0o077, 0);
    assert.equal((await stat(join(dir, "shared.txt"))).mode & 0o777, 0o644, "a file with another name outside is left as it was");
    assert.equal(record.files, 4);
  } finally { await cleanup(dir); }
});

test("quarantining the same place twice keeps both, and nothing is ever merged", async () => {
  const dir = await root0();
  try {
    const q = join(dir, "q");
    await tree(join(dir, "ws"));
    const first = await quarantine({ root: q, path: join(dir, "ws"), reason: "first", by: "owner:rob", clock: () => "2026-10-22T10:00:00.000Z" });
    await mkdir(join(dir, "ws")); await writeFile(join(dir, "ws", "new.txt"), "second round\n");
    const second = await quarantine({ root: q, path: join(dir, "ws"), reason: "second", by: "owner:rob", clock: () => "2026-10-22T11:00:00.000Z" });
    assert.notEqual(first.id, second.id);
    assert.deepEqual((await listQuarantined(q)).map((r) => r.reason), ["first", "second"]);
    const one = await readQuarantined(q, first.id); const two = await readQuarantined(q, second.id);
    assert.deepEqual([one.kind === "directory" ? one.entries : [], two.kind === "directory" ? two.entries : []], [["README.md", "src"], ["new.txt"]]);
    for (const r of [first, second]) await chmod(join(q, r.id, "content"), 0o755).catch(() => undefined);
  } finally { await cleanup(dir); }
});
