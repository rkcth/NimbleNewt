import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BlobError, FileBlobStore } from "./blobs.js";

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const scratch = () => mkdtempSync(join(tmpdir(), "nn blobs-"));
const remove = (dir: string) => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
async function* pieces(...parts: string[]): AsyncGenerator<Uint8Array> { for (const p of parts) yield Buffer.from(p); }
const withStore = async (run: (store: FileBlobStore, dir: string) => Promise<void>, options: { maxBlobBytes?: number } = {}) => {
  const dir = scratch();
  try { await run(await FileBlobStore.open({ directory: join(dir, "store"), ...options }), dir); } finally { remove(dir); }
};
const breaks = (code: BlobError["code"], run: () => Promise<unknown>) => assert.rejects(run, (e: unknown) => e instanceof BlobError && e.code === code, code);

test("a blob is named by the SHA-256 of its content and reads back verified, whatever its size or how it arrives", () => withStore(async (store) => {
  const cases: [string, Uint8Array | AsyncIterable<Uint8Array>, Buffer][] = [
    ["empty", new Uint8Array(0), Buffer.alloc(0)],
    ["text", Buffer.from("hello"), Buffer.from("hello")],
    ["chunks", pieces("he", "", "llo"), Buffer.from("hello")],
    ["more than one write chunk", Buffer.alloc(2_500_000, 7), Buffer.alloc(2_500_000, 7)],
  ];
  for (const [label, input, expected] of cases) {
    const stored = await store.put(input);
    assert.deepEqual([stored.digest, stored.size], [sha(expected), expected.length], label);
    assert.deepEqual(Buffer.from(await store.read(stored.digest)), expected, label);
    assert.equal(await store.verify(stored.digest, expected.length), "ok", label);
    assert.equal(statSync(store.pathOf(stored.digest)).size, expected.length);
  }
  assert.equal((await store.list()).length, 3, "hello is stored once");
}));

test("putting content that is already stored keeps the one file, refreshes its age, and says so", () => withStore(async (store) => {
  const first = await store.put(Buffer.from("same"));
  assert.equal(first.existed, false);
  const old = new Date(Date.now() - 3 * 24 * 3600 * 1000);
  utimesSync(store.pathOf(first.digest), old, old);
  const again = await store.put(pieces("sa", "me"));
  assert.deepEqual([again.digest, again.existed], [first.digest, true]);
  assert.ok(statSync(store.pathOf(first.digest)).mtimeMs > Date.now() - 60_000, "the blob is young again, so cleanup will not take it before its manifest is recorded");
  assert.equal((await store.list()).length, 1);
  assert.deepEqual(readdirSync(join(store.directory, "tmp")), [], "no temporary file is left");
}));

test("a stored file that no longer matches its name is never trusted: put replaces it, verify and read refuse it", () => withStore(async (store) => {
  const { digest } = await store.put(Buffer.from("precious"));
  const path = store.pathOf(digest);
  chmodSync(path, 0o666);
  writeFileSync(path, "tampered"); // same length, different bytes
  assert.equal(await store.verify(digest, 8), "corrupt");
  await breaks("corrupt", () => store.read(digest));
  writeFileSync(path, "short");
  assert.equal(await store.verify(digest, 8), "size_mismatch");
  assert.equal(await store.verify(digest), "corrupt");
  await breaks("corrupt", () => store.read(digest));
  const again = await store.put(Buffer.from("precious"));
  assert.equal(again.existed, false, "the damaged file was not mistaken for the content");
  assert.equal(readFileSync(path, "utf8"), "precious");
  assert.equal(await store.verify(digest, 8), "ok");
}));

test("a missing blob is reported as missing, and names that are not digests are refused before touching the disk", () => withStore(async (store) => {
  const digest = sha("never stored");
  assert.equal(await store.verify(digest), "missing");
  assert.equal(await store.has(digest), false);
  await breaks("missing", () => store.read(digest));
  assert.equal(await store.remove(digest), false);
  for (const bad of ["", "abc", "../../etc/passwd", `${digest}/..`, digest.toUpperCase(), `${digest}0`, "g".repeat(64)]) {
    await breaks("invalid", () => store.read(bad));
    assert.throws(() => store.pathOf(bad), BlobError);
  }
}));

test("a blob larger than the limit is refused, mid-stream, and leaves nothing behind", () => withStore(async (store) => {
  async function* endless(): AsyncGenerator<Uint8Array> { for (let i = 0; i < 1000; i++) yield Buffer.alloc(1000, 1); }
  await breaks("too_large", () => store.put(endless()));
  await breaks("too_large", () => store.put(Buffer.alloc(5001)));
  assert.deepEqual(readdirSync(join(store.directory, "tmp")), []);
  assert.deepEqual(await store.list(), []);
  assert.equal((await store.put(Buffer.alloc(5000, 2))).size, 5000);
}, { maxBlobBytes: 5000 }));

test("content that is not bytes is refused and a failing source leaves nothing behind", () => withStore(async (store) => {
  async function* wrong(): AsyncGenerator<unknown> { yield "text, not bytes"; }
  await breaks("invalid", () => store.put(wrong() as AsyncIterable<Uint8Array>));
  async function* breaksHalfway(): AsyncGenerator<Uint8Array> { yield Buffer.from("half"); throw new Error("source failed"); }
  await assert.rejects(store.put(breaksHalfway()), /source failed/);
  assert.deepEqual(readdirSync(join(store.directory, "tmp")), []);
  assert.deepEqual(await store.list(), []);
}));

test("many puts of the same and of different content at once store each blob once, intact", () => withStore(async (store) => {
  const contents = Array.from({ length: 6 }, (_, i) => Buffer.alloc(300_000, i % 3));
  const results = await Promise.all(Array.from({ length: 24 }, (_, i) => store.put(contents[i % 6]!)));
  assert.equal(new Set(results.map((r) => r.digest)).size, 3);
  for (const r of results) assert.equal(await store.verify(r.digest, 300_000), "ok");
  assert.equal((await store.list()).length, 3);
  assert.deepEqual(readdirSync(join(store.directory, "tmp")), []);
}));

test("cleanup helpers: list ignores junk, sweepTemp removes only old temporary files, remove deletes a blob", () => withStore(async (store) => {
  const { digest } = await store.put(Buffer.from("x"));
  mkdirSync(join(store.directory, "blobs", "zz"), { recursive: true });
  writeFileSync(join(store.directory, "blobs", "zz", "not-a-blob"), "junk");
  writeFileSync(join(store.directory, "blobs", digest.slice(0, 2), "stray.txt"), "junk");
  assert.deepEqual((await store.list()).map((b) => b.digest), [digest]);
  const tmp = join(store.directory, "tmp");
  writeFileSync(join(tmp, "old"), "a");
  writeFileSync(join(tmp, "new"), "b");
  const old = new Date(Date.now() - 2 * 3600 * 1000);
  utimesSync(join(tmp, "old"), old, old);
  assert.equal(await store.sweepTemp(Date.now() - 3600 * 1000), 1);
  assert.deepEqual(readdirSync(tmp), ["new"]);
  assert.equal(await store.remove(digest), true);
  assert.equal(existsSync(store.pathOf(digest)), false);
  assert.deepEqual(await store.list(), []);
}));

test("anything in the store that is not a regular file is refused, not followed", { skip: process.platform === "win32" ? "symlinks need privileges on Windows" : false }, () => withStore(async (store, dir) => {
  const outside = join(dir, "outside.txt");
  writeFileSync(outside, "secret");
  const digest = sha("secret");
  mkdirSync(join(store.directory, "blobs", digest.slice(0, 2)), { recursive: true });
  symlinkSync(outside, store.pathOf(digest));
  await breaks("unusable", () => store.read(digest));
  await breaks("unusable", () => store.verify(digest));
  await breaks("unusable", () => store.put(Buffer.from("secret")));
  assert.deepEqual(await store.list(), [], "a link is not listed");
  assert.equal(readFileSync(outside, "utf8"), "secret", "the target was not touched");
}));

test("options are checked", async () => {
  await breaks("invalid", () => FileBlobStore.open({ directory: "" }));
  await breaks("invalid", () => FileBlobStore.open({ directory: scratch(), maxBlobBytes: 0 }));
});

test("a two-character folder that is a link to somewhere else is refused by every operation", { skip: process.platform === "win32" ? "symlinks need privileges on Windows" : false }, () => withStore(async (store, dir) => {
  const elsewhere = join(dir, "elsewhere");
  mkdirSync(elsewhere);
  const digest = sha("content");
  symlinkSync(elsewhere, join(store.directory, "blobs", digest.slice(0, 2)));
  await breaks("unusable", () => store.put(Buffer.from("content")));
  await breaks("unusable", () => store.read(digest));
  await breaks("unusable", () => store.verify(digest));
  await breaks("unusable", () => store.has(digest));
  await breaks("unusable", () => store.remove(digest));
  assert.deepEqual(readdirSync(elsewhere), [], "nothing was written through the link");
  assert.deepEqual(await store.list(), []);
}));

test("every store object over one directory shares one lock", async () => {
  const dir = scratch();
  try {
    const a = await FileBlobStore.open({ directory: join(dir, "s") });
    const b = await FileBlobStore.open({ directory: join(dir, "s", "..", "s") });
    const c = await FileBlobStore.open({ directory: join(dir, "other") });
    assert.equal(a.lock, b.lock);
    assert.notEqual(a.lock, c.lock);
  } finally { remove(dir); }
});
