import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loaderChange, lookAtLoaderConfig } from "./loader-watch.js";

// Card U11d: the protected loader configuration is fingerprinted by content; a difference is a change however it was made.
const root = realpathSync(mkdtempSync(join(tmpdir(), "nn loader ")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = (): { dir: string; file: string; sub: string } => {
  const dir = join(root, `ext-${++n}`);
  mkdirSync(join(dir, "tools"), { recursive: true });
  writeFileSync(join(dir, "loader.json"), '{"extensions":["tools"]}');
  writeFileSync(join(dir, "tools", "index.js"), "export const a = 1;");
  return { dir, file: join(dir, "loader.json"), sub: join(dir, "tools", "index.js") };
};
const look = async (...paths: string[]) => (await lookAtLoaderConfig(paths))!;
/** A link to a directory that also works without a privilege on Windows (a junction); a file link may be refused there, and the case is then skipped. */
const link = (target: string, path: string, directory: boolean): boolean => {
  try { symlinkSync(target, path, directory ? (process.platform === "win32" ? "junction" : "dir") : "file"); return true; } catch { return false; }
};

test("no difference between two looks at an untouched folder; a write to a file, to a file in a nested folder, a new file and a deletion are each seen", async () => {
  const x = fresh();
  const first = await look(x.dir);
  assert.equal(loaderChange(first, await look(x.dir)), undefined);
  writeFileSync(x.file, '{"extensions":["tools","evil"]}');
  assert.equal(loaderChange(first, await look(x.dir))?.change, "changed");
  const second = await look(x.dir);
  writeFileSync(x.sub, "export const a = 2;");
  assert.equal(loaderChange(second, await look(x.dir))?.change, "changed", "a nested file");
  const third = await look(x.dir);
  writeFileSync(join(x.dir, "extra.js"), "1");
  assert.equal(loaderChange(third, await look(x.dir))?.change, "changed", "a new entry inside the folder is a change of the folder");
  const fourth = await look(x.dir);
  unlinkSync(x.sub);
  assert.equal(loaderChange(fourth, await look(x.dir))?.change, "changed");
});

test("a single protected file: written, removed and added again are named as such; the same bytes written again are not a change", async () => {
  const x = fresh();
  const first = await look(x.file);
  writeFileSync(x.file, '{"extensions":["tools"]}');
  assert.equal(loaderChange(first, await look(x.file)), undefined, "the same bytes: nothing the loader would read differs");
  unlinkSync(x.file);
  const gone = await look(x.file);
  assert.equal(loaderChange(first, gone)?.change, "removed");
  writeFileSync(x.file, "{}");
  assert.equal(loaderChange(gone, await look(x.file))?.change, "added");
});

test("a protected folder replaced by a link is seen as a link, and so is a file inside it; a link whose target changes is a change", async (t) => {
  const x = fresh();
  const elsewhere = join(root, `elsewhere-${n}`);
  mkdirSync(elsewhere);
  const before = await look(x.dir);
  const moved = `${x.dir}-moved`;
  renameSync(x.dir, moved);
  if (!link(elsewhere, x.dir, true)) return t.skip("this system refuses to make a link here");
  const after = await look(x.dir);
  assert.equal(after[0]!.type, "link");
  assert.equal(loaderChange(before, after)?.change, "linked");
  const other = join(root, `elsewhere-b-${n}`);
  mkdirSync(other);
  rmSync(x.dir, { recursive: false, force: true });
  link(other, x.dir, true);
  assert.equal(loaderChange(after, await look(x.dir))?.change, "changed", "the same kind of entry pointing elsewhere");
});

test("a file inside the folder replaced by a link is a change of the folder", async (t) => {
  const x = fresh();
  const before = await look(x.dir);
  unlinkSync(x.sub);
  if (!link(x.file, x.sub, false)) return t.skip("this system refuses to make a file link here");
  assert.equal(loaderChange(before, await look(x.dir))?.change, "changed");
});

test("a look that cannot be made in full says nothing: beyond the bounds, and a path that cannot be read as a plain entry is not guessed; paths given in another number are not compared", async () => {
  const x = fresh();
  assert.equal(await lookAtLoaderConfig([x.dir], { entries: 2, bytes: 1_000_000 }), undefined, "too many entries");
  assert.equal(await lookAtLoaderConfig([x.dir], { entries: 100, bytes: 5 }), undefined, "too many bytes");
  const one = await look(x.dir);
  assert.equal(loaderChange(one, [...one, ...one]), undefined);
  const missing = await look(join(root, "no-such-folder"));
  assert.equal(missing[0]!.type, "absent");
});

test("the key is the same for the same change, differs for another, and holds no path or content", async () => {
  const x = fresh();
  const base = await look(x.dir);
  writeFileSync(x.file, "SECRET-CONTENT-1");
  const a = loaderChange(base, await look(x.dir))!;
  const again = loaderChange(base, await look(x.dir))!;
  assert.equal(a.key, again.key);
  writeFileSync(x.file, "SECRET-CONTENT-2");
  assert.notEqual(loaderChange(base, await look(x.dir))!.key, a.key);
  assert.match(a.key, /^loader:changed:[0-9a-f]{24}$/);
  assert.ok(!a.key.includes(root) && !a.key.includes("SECRET"));
});

test("when several paths differ, the most serious kind is named (a removal over a write)", async () => {
  const x = fresh();
  const second = join(root, `second-${n}.json`);
  writeFileSync(second, "1");
  const before = await look(x.file, second);
  writeFileSync(x.file, "changed");
  unlinkSync(second);
  assert.equal(loaderChange(before, await look(x.file, second))?.change, "removed");
});
