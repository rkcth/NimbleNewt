import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { ArchiveError, DEFAULT_ARCHIVE_LIMITS, METADATA_FILE, checkPackagePath, unpack } from "./archive.js";
import { fixture, gz, tar, type TarEntry } from "./testing/tar.js";

const meta = (extra: object = {}): TarEntry => ({ path: METADATA_FILE, data: JSON.stringify({ name: "demo", version: "1.0.0", ...extra }) });
const refuses = (bytes: Buffer, code: ArchiveError["code"], limits = DEFAULT_ARCHIVE_LIMITS): void => assert.throws(() => unpack(bytes, limits), (e: unknown) => e instanceof ArchiveError && e.code === code, `expected ${code}`);

describe("the package archive reader", () => {
  test("reads a well-formed archive, plain or gzip, with long paths, directories and a script declaration", () => {
    const long = `${"d".repeat(60)}/${"e".repeat(60)}/file.txt`;
    const entries: TarEntry[] = [{ path: "./", type: "5" }, meta({ scripts: { install: "scripts/setup.js" } }), { path: "scripts", type: "5" }, { path: "scripts/setup.js", data: "1" }, { path: "bin/tool", data: "#!/bin/sh\n", mode: 0o750 }, { path: long, data: "x" }];
    for (const bytes of [tar(entries), gz(tar(entries))]) {
      const u = unpack(bytes);
      assert.deepEqual(u.files.map((f) => f.path), ["bin/tool", long, METADATA_FILE, "scripts/setup.js"].sort());
      assert.equal(u.files.find((f) => f.path === "bin/tool")!.mode, 0o755, "an executable keeps only the executable bit");
      assert.equal(u.files.find((f) => f.path === "scripts/setup.js")!.mode, 0o644);
      assert.deepEqual(u.metadata.scripts, [{ phase: "install", entry: "scripts/setup.js" }]);
      assert.equal(u.metadata.name, "demo");
    }
  });

  test("path traversal, absolute and odd names are refused", () => {
    for (const path of ["../evil", "a/../../evil", "/etc/passwd", "a//b", "a/./b", "a\\b", "C:/x", "a/b/..", "x\u0001y", "bad\ufffdname"]) {
      refuses(tar([meta(), { path, data: "x" }]), "unsafe_path");
    }
    refuses(tar([meta(), { path: "a/" + "b/".repeat(30) + "c", data: "x" }]), "unsafe_path");
    refuses(tar([meta(), { path: "n".repeat(300) + "/x", data: "x" }, ]), "unsafe_path");
    assert.throws(() => checkPackagePath("a/\0b"), ArchiveError);
  });

  test("links of every kind, devices and extended headers are refused", () => {
    refuses(tar([meta(), { path: "link", type: "2", linkname: "/etc/passwd" }]), "unsafe_entry");
    refuses(tar([meta(), { path: "hard", type: "1", linkname: "index.js" }]), "unsafe_entry");
    refuses(tar([meta(), { path: "dev", type: "3" }]), "unsafe_entry");
    refuses(tar([meta(), { path: "fifo", type: "6" }]), "unsafe_entry");
    refuses(tar([meta(), { path: "pax", type: "x", data: "30 path=../../evil\n" }]), "unsupported");
  });

  test("set-user-ID, set-group-ID and sticky bits are refused, not stripped", () => {
    for (const mode of [0o4755, 0o2755, 0o1755, 0o6755]) refuses(tar([meta(), { path: "bin/su", data: "x", mode }]), "unsafe_mode");
    refuses(tar([meta(), { path: "d", type: "5", mode: 0o2755 }]), "unsafe_mode");
  });

  test("names that collide (also by letter case), a file inside a file and a file that is also a directory are refused", () => {
    refuses(tar([meta(), { path: "a", data: "1" }, { path: "a", data: "2" }]), "unsafe_path");
    refuses(tar([meta(), { path: "Readme", data: "1" }, { path: "README", data: "2" }]), "unsafe_path");
    refuses(tar([meta(), { path: "f", data: "1" }, { path: "f/g", data: "2" }]), "unsafe_path");
    refuses(tar([meta(), { path: "d/x", data: "1" }, { path: "d", data: "2" }]), "unsafe_path");
    refuses(tar([meta(), { path: "d", data: "2" }, { path: "d", type: "5" }]), "unsafe_path");
  });

  test("oversized archives are refused: the archive, the unpacked size, the file count, and a gzip bomb is cut off while it is read", () => {
    const small = { ...DEFAULT_ARCHIVE_LIMITS, maxArchiveBytes: 2000, maxUnpackedBytes: 1000, maxFiles: 5 };
    refuses(Buffer.alloc(2001, 1), "too_large", small);
    refuses(tar([meta(), { path: "big", data: "x".repeat(1001) }]), "too_large", small);
    refuses(tar([meta(), ...[1, 2, 3, 4, 5, 6].map((n) => ({ path: `f${n}`, data: "x" }))]), "too_large", small);
    const bomb = gz(Buffer.alloc(8 * 1024 * 1024)); // 8 MiB of zeros compresses to a few KiB
    assert.ok(bomb.length < 20_000);
    refuses(bomb, "too_large", { ...DEFAULT_ARCHIVE_LIMITS, maxUnpackedBytes: 100_000, maxFiles: 10 });
    // A header that claims a size larger than the data it has.
    refuses(tar([meta(), { path: "liar", data: "abc", size: 100_000 }]), "malformed");
    refuses(tar([meta(), { path: "liar", data: "abc", size: 4_000_000_000 }]), "too_large", { ...DEFAULT_ARCHIVE_LIMITS });
  });

  test("a damaged archive is refused: checksum, truncation, no end, data after the end, not gzip", () => {
    refuses(tar([meta(), { path: "a", data: "1", corruptChecksum: true }]), "malformed");
    refuses(tar([meta(), { path: "a", data: "x".repeat(2000) }]).subarray(0, 1200), "malformed");
    refuses(tar([meta(), { path: "a", data: "1" }], { noEnd: true }), "malformed");
    refuses(tar([meta(), { path: "a", data: "1" }], { trailing: Buffer.from("evil trailing data") }), "malformed");
    refuses(Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.from("not really gzip")]), "malformed");
  });

  test("the metadata is required, exact, and its scripts name files of the package", () => {
    refuses(tar([{ path: "index.js", data: "1" }]), "metadata");
    refuses(tar([{ path: METADATA_FILE, data: "not json" }]), "metadata");
    refuses(tar([{ path: METADATA_FILE, data: JSON.stringify({ name: "Bad Name", version: "1.0.0" }) }]), "metadata");
    refuses(tar([{ path: METADATA_FILE, data: JSON.stringify({ name: "demo", version: "^1.0.0" }) }]), "metadata");
    refuses(tar([meta({ scripts: { prepare: "x.js" } })]), "metadata");
    refuses(tar([meta({ scripts: { install: "missing.js" } })]), "metadata");
    refuses(tar([meta({ scripts: { install: "../x.js" } })]), "unsafe_path");
    refuses(tar([meta({ scripts: { install: "run.sh" } }), { path: "run.sh", data: "x" }]), "metadata");
    assert.equal(unpack(fixture({ name: "demo", version: "2.0.0" }).bytes).metadata.version, "2.0.0");
  });
});
