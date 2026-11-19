import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NAME_LIMITS, WorkspaceError, resolveSafe, splitRelative } from "./index.js";

// Card G06: paths over 260 characters (Windows' classic MAX_PATH). The workspace refuses, on Windows, any path whose full form (root, separator and relative path) is longer than
// NAME_LIMITS.windowsTotal (240), so an agent never creates a file that Windows tools without long-path support (Explorer, older Git, cmd) cannot open, and the 20 characters left
// below 260 cover a short file Git or an editor puts next to it. The pure part runs everywhere; the part that makes real paths over 260 characters runs on Windows only (CI's hosted
// Windows cells and the owner's machine through own-hardware.yml), where it shows the refusal is a clean `invalid_path`, never a crash, and that such a tree is still cleaned up.

const isWindows = process.platform === "win32";
const MAX_PATH = 260;
const refuses = async (code: string, run: () => Promise<unknown>): Promise<void> => {
  await assert.rejects(run, (e: unknown) => { assert.ok(e instanceof WorkspaceError, String(e)); assert.equal(e.code, code, e.message); return true; });
};
/** A relative path of `length` characters made of 50-character names (the last one shorter), so no single name is near the 255-byte limit. */
const relOf = (length: number): string => {
  const parts: string[] = [];
  let used = 0;
  while (used < length) {
    const sep = parts.length === 0 ? 0 : 1;
    const n = Math.min(50, length - used - sep);
    // One character left after a separator: lengthen the last name instead of leaving an empty one.
    if (n < 1) { parts[parts.length - 1] += "e"; used += 1; continue; }
    parts.push(`${String(parts.length % 100).padStart(2, "0")}${"d".repeat(Math.max(0, n - 2))}`.slice(0, n));
    used += sep + n;
  }
  return parts.join("/");
};

test("G06 (all platforms): the Windows total-length rule is exact at its boundary and keeps every full path under 260 characters", () => {
  assert.equal(NAME_LIMITS.windowsTotal, 240);
  assert.ok(NAME_LIMITS.windowsTotal < MAX_PATH);
  for (const root of [3, 20, 100, 200]) {
    const fits = NAME_LIMITS.windowsTotal - root - 1;
    const ok = relOf(fits);
    assert.equal(ok.length, fits);
    assert.doesNotThrow(() => splitRelative(ok, { forWindows: true, rootLength: root }), `root ${root}: ${fits} characters fit`);
    assert.throws(() => splitRelative(relOf(fits + 1), { forWindows: true, rootLength: root }), (e: unknown) => e instanceof WorkspaceError && e.code === "invalid_path" && /longer than 240/.test(e.message), `root ${root}: one more does not`);
  }
  // A path that would be over 260 in full is refused for Windows and allowed by the POSIX rule (1024).
  const rel = relOf(200);
  assert.ok(100 + 1 + rel.length > MAX_PATH);
  assert.throws(() => splitRelative(rel, { forWindows: true, rootLength: 100 }), WorkspaceError);
  assert.doesNotThrow(() => splitRelative(rel, { forWindows: false, rootLength: 100 }));
  // The root alone over the limit leaves no room at all.
  assert.throws(() => splitRelative("a", { forWindows: true, rootLength: 239 }), WorkspaceError);
});

test("G06 (all platforms): resolving a too-long Windows path refuses before touching the disk; nothing is created on the way", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "nn-g06-")));
  try {
    const rel = relOf(NAME_LIMITS.windowsTotal);
    await refuses("invalid_path", () => resolveSafe(dir, rel, { forWindows: true, forWrite: true, createParents: true }));
    assert.deepEqual(await readdir(dir), [], "no directory was made for a refused path");
    // Just inside the limit, the same call makes the parents and resolves.
    const fits = relOf(NAME_LIMITS.windowsTotal - dir.length - 1);
    if (fits.length > 0) {
      const r = await resolveSafe(dir, fits, { forWindows: true, forWrite: true, createParents: true });
      assert.equal(r.exists, "missing");
      assert.ok(r.absolute.length <= NAME_LIMITS.windowsTotal);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("G06 (Windows only): a real tree deeper than 260 characters is refused cleanly by the workspace, files in it stay intact, and it is removed", { skip: isWindows ? false : "Windows only: real paths over 260 characters (the pure rules above run everywhere)" }, async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "nn-g06-")));
  try {
    // Made the way another tool (git, an unpacker) could make it: Node's file calls take long paths on Windows.
    const rel = relOf(MAX_PATH + 40 - dir.length);
    const absolute = join(dir, ...rel.split("/"));
    assert.ok(absolute.length > MAX_PATH, `${absolute.length} characters`);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, "deep\n");
    assert.equal(await readFile(absolute, "utf8"), "deep\n");
    // The workspace refuses to read or write it, with its own error (not ENAMETOOLONG or a crash), and changes nothing.
    await refuses("invalid_path", () => resolveSafe(dir, rel));
    await refuses("invalid_path", () => resolveSafe(dir, rel, { forWrite: true }));
    assert.equal(await readFile(absolute, "utf8"), "deep\n");
    // A Unicode name of the same length counts characters, not bytes: still refused (the 255-byte rule per name is separate).
    const wide = rel.replace(/d/g, "ü");
    await refuses("invalid_path", () => resolveSafe(dir, wide));
    // A path inside the limit in the same tree still works.
    const near = rel.slice(0, NAME_LIMITS.windowsTotal - dir.length - 1).replace(/\/[^/]*$/, "");
    if (near.length > 0) assert.equal((await resolveSafe(dir, near)).exists, "directory");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
    assert.equal(existsSync(dir), false, "a tree with paths over 260 characters is removed");
  }
});
