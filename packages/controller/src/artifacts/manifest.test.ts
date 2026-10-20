import assert from "node:assert/strict";
import { test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { MANIFEST_LIMITS, checkEntries, checkPath, manifestDigest, type ManifestEntry } from "./manifest.js";

const D = "a".repeat(64);
const E = (path: string, digest = D, size = 1): ManifestEntry => ({ path, digest, size });
const rejects = (run: () => unknown, pattern?: RegExp) => assert.throws(run, (e: unknown) => e instanceof DomainError && e.code === "invalid_command" && (pattern === undefined || pattern.test(e.message)));

test("portable paths are accepted", () => {
  for (const ok of ["a", "a.txt", "dir/sub/file.tar.gz", "Ünï/cödé.md", "日本語/ファイル", ".hidden", "a b/c d", "name-with_chars+and(parens)[1]", "x".repeat(255)]) assert.equal(checkPath(ok, "p"), ok);
});

test("paths that are unsafe or not portable across Linux, macOS and Windows are refused", () => {
  const bad: [string, RegExp][] = [
    ["", /non-empty/], ["/etc/passwd", /empty segment/], ["a/", /empty segment/], ["a//b", /empty segment/], ["./a", /\. or \.\./], ["a/./b", /\. or \.\./], ["../a", /\. or \.\./], ["a/../b", /\. or \.\./],
    ["a\\b", /backslash/], ["C:/x", /colon/], ["a:b", /colon/], ["a<b", /< >/], ["a?b", /< >/], ["a*b", /< >/], ["a|b", /< >/], ['a"b', /< >/],
    ["a\nb", /control/], ["a\u0000b", /control/], ["a\u007fb", /control/], ["trailing.", /space or a dot/], ["trailing ", /space or a dot/], ["dir./file", /space or a dot/],
    ["CON", /device name/], ["con.txt", /device name/], ["dir/NUL", /device name/], ["lpt1.log", /device name/], ["COM9", /device name/],
    ["e\u0301", /NFC/], ["bad\ud800", /well-formed/], ["x".repeat(256), /at most 255/], [`${"d".repeat(200)}/${"e".repeat(200)}/${"f".repeat(200)}`, /at most 512 bytes/],
  ];
  for (const [path, why] of bad) rejects(() => checkPath(path, "p"), why);
  for (const notText of [undefined, null, 5, {}, ["a"]]) rejects(() => checkPath(notText, "p"));
});

test("a set of files is checked as a set: case-insensitive duplicates and files inside files are refused", () => {
  assert.deepEqual(checkEntries([E("b"), E("a"), E("dir/x")]).map((e) => e.path), ["a", "b", "dir/x"]);
  rejects(() => checkEntries([E("a.txt"), E("a.txt")]), /same path/);
  rejects(() => checkEntries([E("A.txt"), E("a.TXT")]), /case-insensitive/);
  rejects(() => checkEntries([E("a"), E("a/b")]), /is a file/);
  rejects(() => checkEntries([E("Dir"), E("dir/file")]), /is a file/);
  rejects(() => checkEntries([E("Straße.txt"), E("STRASSE.txt")]), /case-insensitive/);
  rejects(() => checkEntries([E("ıx"), E("ix")]), /case-insensitive/);
  rejects(() => checkEntries([]), /at least one/);
  rejects(() => checkEntries(Array.from({ length: MANIFEST_LIMITS.entries + 1 }, (_, i) => E(`f${i}`))), /at most 1000/);
  assert.equal(checkEntries(Array.from({ length: MANIFEST_LIMITS.entries }, (_, i) => E(`f${i}`))).length, 1000);
});

test("the manifest digest depends on every path, content and size, and not on the order given", () => {
  const base = [E("a", "1".repeat(64), 5), E("b", "2".repeat(64), 6)];
  const digest = manifestDigest(base);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(manifestDigest([...base].reverse()), digest);
  assert.notEqual(manifestDigest([E("a", "1".repeat(64), 5), E("c", "2".repeat(64), 6)]), digest, "a path");
  assert.notEqual(manifestDigest([E("a", "1".repeat(64), 5), E("b", "3".repeat(64), 6)]), digest, "a content digest");
  assert.notEqual(manifestDigest([E("a", "1".repeat(64), 5), E("b", "2".repeat(64), 7)]), digest, "a size");
  assert.notEqual(manifestDigest(base.slice(0, 1)), digest, "a missing file");
});
