import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Launcher, PointerSwitcher, SimulatedCrash, UpdaterError, announceRelease, installRelease, stageRelease, verifyReleaseDirectory, type StageReleaseOptions, type UpdaterErrorCode } from "./index.js";
import { sha256 } from "./start-fixture.js";

/**
 * The updater (card K02 follow-up) in temporary directories: a release is installed from a verified source directory, never over an existing one, atomically, with links and unmanifested files refused, and
 * announced through the launcher's own API. No network, no database, no controller.
 */
const POSIX = process.platform !== "win32";
const ID = `rcn-${sha256("updater-fixture").slice(0, 24)}`;
interface Source { readonly dir: string; readonly digest: string; readonly id: string; readonly manifest: string }

function unlock(dir: string): void {
  if (!POSIX || !existsSync(dir)) return;
  try { chmodSync(dir, 0o700); } catch { return; }
  for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) unlock(join(dir, e.name));
}
async function scratch(run: (t: { base: string; root: string; src: (files?: Record<string, string>, id?: string) => Source }) => Promise<void>): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), "nn-upd-"));
  const root = join(base, "root");
  mkdirSync(root);
  let n = 0;
  const src = (files: Record<string, string> = { "controller.js": "console.log('controller');\n", "lib/util.js": "export const x = 1;\n", "compat.json": JSON.stringify({ protocol: { min: 1, max: 1 } }) }, id = ID): Source => {
    const dir = join(base, `source-${n++}`);
    mkdirSync(dir, { recursive: true });
    const listed: Record<string, { sha256: string; size: number }> = {};
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(join(dir, ...name.split("/").slice(0, -1)), { recursive: true });
      writeFileSync(join(dir, ...name.split("/")), body);
      listed[name] = { sha256: sha256(body), size: Buffer.byteLength(body) };
    }
    const manifest = JSON.stringify({ candidateId: id, sourceCommit: "a".repeat(40), files: listed });
    writeFileSync(join(dir, "MANIFEST.json"), manifest);
    return { dir, digest: sha256(manifest), id, manifest };
  };
  try { await run({ base, root, src }); } finally { unlock(base); rmSync(base, { recursive: true, force: true }); }
}
const opts = (root: string, s: Source, more: Partial<StageReleaseOptions> = {}): StageReleaseOptions => ({ root, source: s.dir, digest: s.digest, ...more });
async function refused(code: UpdaterErrorCode, p: Promise<unknown>, match?: RegExp): Promise<void> {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof UpdaterError, `${String(e)}`); assert.equal(e.code, code, e.message); if (match !== undefined) assert.match(e.message, match); return true; });
}
const releasesOf = (root: string): string[] => (existsSync(join(root, "releases")) ? readdirSync(join(root, "releases")).sort() : []);

test("stage installs the verified source as releases/<id>: exact files, the manifest bytes, read-only, verifiable (K02 updater)", async () => {
  await scratch(async ({ root, src }) => {
    const s = src();
    const r = await stageRelease(opts(root, s));
    assert.deepEqual({ id: r.id, digest: r.digest, files: r.files, reused: r.reused, protocol: r.protocol }, { id: ID, digest: s.digest, files: 3, reused: false, protocol: { min: 1, max: 1 } });
    assert.equal(r.dir, join(root, "releases", ID));
    assert.deepEqual(releasesOf(root), [ID], "nothing else is left under releases");
    assert.deepEqual(await verifyReleaseDirectory(r.dir, s.digest), []);
    assert.equal(readFileSync(join(r.dir, "MANIFEST.json"), "utf8"), s.manifest, "the manifest is copied byte for byte");
    assert.equal(readFileSync(join(r.dir, "lib", "util.js"), "utf8"), "export const x = 1;\n");
    if (POSIX) {
      assert.equal(statSync(join(r.dir, "controller.js")).mode & 0o777, 0o444);
      assert.equal(statSync(join(r.dir, "lib")).mode & 0o222, 0, "folders are read-only");
      assert.equal(statSync(r.dir).mode & 0o222, 0);
    }
    assert.equal(existsSync(join(root, "current.json")), false, "staging alone moves no pointer");
    assert.equal(existsSync(join(root, "launcher-state.json")), false, "staging alone announces nothing");
  });
});

test("announce tells the launcher through Launcher.expect; the pointer moves only when asked, and then the launcher runs it (K02 updater)", async () => {
  await scratch(async ({ root, src }) => {
    const s = src();
    const staged = await stageRelease(opts(root, s));
    const launcher = new Launcher({ root, switcher: new PointerSwitcher(root) });
    assert.equal((await launcher.prepare()).action, "none", "before the announcement there is nothing to run");
    const a = await announceRelease({ root, release: staged });
    assert.deepEqual(a, { announced: true, switched: false });
    const state = await launcher.read();
    assert.deepEqual(state.expected, { id: ID, digest: s.digest, protocol: { min: 1, max: 1 } });
    assert.equal(existsSync(join(root, "current.json")), false, "announce alone leaves the pointer");
    assert.equal((await launcher.prepare()).action, "none");
    const b = await announceRelease({ root, release: staged, switchPointer: true });
    assert.equal(b.switched, true);
    assert.equal(JSON.parse(readFileSync(join(root, "current.json"), "utf8")).release, ID);
    const d = await launcher.prepare();
    assert.equal(d.action, "run");
    assert.equal(d.action === "run" ? d.releaseId : "", ID);
  });
});

test("installRelease stages and announces in one call, and a repeat after success is harmless (K02 updater)", async () => {
  await scratch(async ({ root, src }) => {
    const s = src();
    const first = await installRelease({ ...opts(root, s), switchPointer: true });
    assert.equal(first.reused, false);
    const again = await installRelease({ ...opts(root, s), switchPointer: true });
    assert.equal(again.reused, true);
    assert.equal(again.announced, true);
    assert.deepEqual(releasesOf(root), [ID]);
  });
});

test("an existing release is never overwritten; the same release counts as installed, a different one is refused and untouched (K02 updater)", async () => {
  await scratch(async ({ root, src }) => {
    const s = src();
    const r = await stageRelease(opts(root, s));
    const before = lstatSync(r.dir).mtimeMs;
    const same = await stageRelease(opts(root, s));
    assert.equal(same.reused, true);
    assert.equal(lstatSync(r.dir).mtimeMs, before, "a reused release is not touched");
    // The same candidate ID with other contents (another manifest digest) is refused.
    const other = src({ "controller.js": "different\n" });
    await refused("exists", stageRelease(opts(root, other)), /never overwritten/);
    assert.equal(readFileSync(join(r.dir, "controller.js"), "utf8"), "console.log('controller');\n");
    assert.deepEqual(releasesOf(root), [ID]);
    // A release directory that was damaged afterwards is not "installed" either, and is not repaired over.
    if (POSIX) {
      chmodSync(r.dir, 0o755); chmodSync(join(r.dir, "controller.js"), 0o644);
      writeFileSync(join(r.dir, "controller.js"), "tampered\n");
      await refused("exists", stageRelease(opts(root, s)));
      assert.equal(readFileSync(join(r.dir, "controller.js"), "utf8"), "tampered\n", "the updater does not overwrite even a damaged release");
    }
    // An empty directory or a file at the place is also left alone.
    await scratch(async ({ root: root2, src: src2 }) => {
      const s2 = src2();
      mkdirSync(join(root2, "releases", ID), { recursive: true });
      await refused("exists", stageRelease(opts(root2, s2)));
      assert.deepEqual(readdirSync(join(root2, "releases", ID)), []);
    });
  });
});

test("a crash in the middle of the copy leaves no release the launcher could run; the next run sweeps the leftover and installs (K02 updater)", async () => {
  for (const point of ["afterCheck", "afterCopy", "afterVerify"] as const) {
    await scratch(async ({ root, src }) => {
      const s = src();
      await assert.rejects(stageRelease(opts(root, s, { hook: (p) => { if (p === point) throw new SimulatedCrash(p); } })), SimulatedCrash);
      const left = releasesOf(root);
      assert.ok(!left.includes(ID), `${point}: releases/<id> must not exist`);
      if (point !== "afterCheck") assert.equal(left.length, 1, "a temporary folder is left, as a dead process would leave it");
      assert.ok(left.every((n) => n.startsWith(".tmp-")));
      assert.equal(existsSync(join(root, "launcher-state.json")), false);
      const launcher = new Launcher({ root, switcher: new PointerSwitcher(root) });
      assert.equal((await launcher.prepare()).action, "none");
      // A recent leftover could belong to a running updater and stays; an old one is swept.
      const fresh = await stageRelease(opts(root, s));
      assert.equal(fresh.reused, false);
      assert.deepEqual(releasesOf(root).filter((n) => !n.startsWith(".tmp-")), [ID]);
      if (point !== "afterCheck") assert.equal(releasesOf(root).filter((n) => n.startsWith(".tmp-")).length, 1, "a recent leftover is kept (it may be a running updater's)");
    });
    await scratch(async ({ root, src }) => {
      const s = src();
      await assert.rejects(stageRelease(opts(root, s, { hook: (p) => { if (p === point) throw new SimulatedCrash(p); } })), SimulatedCrash);
      const tmp = releasesOf(root).find((n) => n.startsWith(".tmp-"));
      if (tmp !== undefined) { const old = new Date(Date.now() - 2 * 3_600_000); unlock(join(root, "releases", tmp)); utimesSync(join(root, "releases", tmp), old, old); }
      await stageRelease(opts(root, s));
      assert.deepEqual(releasesOf(root), [ID], `${point}: the old leftover is swept`);
    });
  }
});

test("a crash after the rename leaves a complete release; the repeat reuses it and announces (K02 updater)", async () => {
  await scratch(async ({ root, src }) => {
    const s = src();
    await assert.rejects(stageRelease(opts(root, s, { hook: (p) => { if (p === "afterRename") throw new SimulatedCrash(p); } })), SimulatedCrash);
    assert.deepEqual(releasesOf(root), [ID]);
    assert.deepEqual(await verifyReleaseDirectory(join(root, "releases", ID), s.digest), []);
    const r = await installRelease({ ...opts(root, s) });
    assert.equal(r.reused, true);
    assert.equal(r.announced, true);
  });
});

test("the release appears in one step: at no point before the rename does releases/<id> exist (K02 updater)", async () => {
  await scratch(async ({ root, src }) => {
    const s = src();
    const seen: string[] = [];
    await stageRelease(opts(root, s, { hook: (p) => { seen.push(`${p}:${existsSync(join(root, "releases", ID))}`); } }));
    assert.deepEqual(seen, ["afterCheck:false", "afterCopy:false", "afterVerify:false", "afterRename:true"]);
  });
});

test("a source that changes after the check, or loses a file while it is copied, installs nothing and leaves nothing (K02 updater)", async () => {
  await scratch(async ({ root, src }) => {
    const s = src();
    await assert.rejects(stageRelease(opts(root, s, { hook: (p) => { if (p === "afterCheck") rmSync(join(s.dir, "lib", "util.js")); } })), (e: unknown) => e instanceof UpdaterError && e.code === "source_invalid");
    assert.deepEqual(releasesOf(root), [], "the temporary folder is removed on an ordinary failure");
  });
  await scratch(async ({ root, src }) => {
    const s = src();
    // Same size, other bytes, swapped in after the check: the copy hashes what it reads.
    await refused("source_invalid", stageRelease(opts(root, s, { hook: (p) => { if (p === "afterCheck") writeFileSync(join(s.dir, "controller.js"), "console.log('CONTROLLER');\n"); } })), /controller\.js/);
    assert.deepEqual(releasesOf(root), []);
  });
  if (!POSIX) return;
  await scratch(async ({ root, src, base }) => {
    const s = src();
    const evil = join(base, "evil.js");
    writeFileSync(evil, "console.log('controller');\n");
    // A file replaced by a link to a same-sized file after the check is not followed.
    await refused("source_invalid", stageRelease(opts(root, s, { hook: (p) => { if (p === "afterCheck") { rmSync(join(s.dir, "controller.js")); symlinkSync(evil, join(s.dir, "controller.js")); } } })));
    assert.deepEqual(releasesOf(root), []);
  });
});

test("links are refused: a linked file, a linked folder, a linked manifest, a linked source and a linked releases folder (K02 updater)", { skip: !POSIX }, async () => {
  await scratch(async ({ root, src, base }) => {
    const outside = join(base, "outside.js");
    writeFileSync(outside, "console.log('controller');\n");
    // A listed file that is a link to a file with the right contents.
    const a = src();
    rmSync(join(a.dir, "controller.js")); symlinkSync(outside, join(a.dir, "controller.js"));
    await refused("source_invalid", stageRelease(opts(root, a)), /controller\.js/);
    // A link that is not listed at all.
    const b = src();
    symlinkSync(outside, join(b.dir, "extra.js"));
    await refused("source_invalid", stageRelease(opts(root, b)), /extra\.js was added/);
    // A folder that is a link.
    const c = src();
    mkdirSync(join(base, "elsewhere"));
    writeFileSync(join(base, "elsewhere", "util.js"), "export const x = 1;\n");
    rmSync(join(c.dir, "lib"), { recursive: true }); symlinkSync(join(base, "elsewhere"), join(c.dir, "lib"));
    await refused("source_invalid", stageRelease(opts(root, c)));
    // A manifest that is a link.
    const d = src();
    const realManifest = join(base, "real-manifest.json");
    writeFileSync(realManifest, d.manifest);
    rmSync(join(d.dir, "MANIFEST.json")); symlinkSync(realManifest, join(d.dir, "MANIFEST.json"));
    await refused("source_invalid", stageRelease(opts(root, d)), /MANIFEST\.json is not a plain file/);
    // The source itself a link.
    const e = src();
    symlinkSync(e.dir, join(base, "source-link"));
    await refused("source_invalid", stageRelease({ root, source: join(base, "source-link"), digest: e.digest }));
    // A link inside a listed folder that points out.
    const f = src();
    symlinkSync(outside, join(f.dir, "lib", "sneaky.js"));
    await refused("source_invalid", stageRelease(opts(root, f)), /sneaky\.js was added/);
    assert.deepEqual(releasesOf(root), []);
    // releases/ itself a link: nothing is written through it.
    const g = src();
    mkdirSync(join(base, "elsewhere2"));
    symlinkSync(join(base, "elsewhere2"), join(root, "releases"));
    await refused("unsafe", stageRelease(opts(root, g)));
    assert.deepEqual(readdirSync(join(base, "elsewhere2")), []);
    // The root a link.
    const h = src();
    symlinkSync(root, join(base, "root-link"));
    await refused("invalid_input", stageRelease({ root: join(base, "root-link"), source: h.dir, digest: h.digest }));
  });
});

test("unmanifested files and special files are refused before anything is copied (K02 updater)", async () => {
  await scratch(async ({ root, src }) => {
    const a = src();
    writeFileSync(join(a.dir, "extra.js"), "console.log('added');\n");
    await refused("source_invalid", stageRelease(opts(root, a)), /extra\.js was added/);
    const b = src();
    mkdirSync(join(b.dir, "node_modules"));
    writeFileSync(join(b.dir, "node_modules", "x.js"), "x");
    await refused("source_invalid", stageRelease(opts(root, b)), /node_modules\/x\.js was added/);
    if (POSIX) {
      const c = src();
      try { execFileSync("mkfifo", [join(c.dir, "pipe")]); } catch { return; }
      await refused("source_invalid", stageRelease(opts(root, c)), /pipe was added/);
    }
    assert.deepEqual(releasesOf(root), []);
  });
});

test("a manifest or file that does not match its digest is refused: wrong authorisation digest, changed file, changed size, missing file (K02 updater)", async () => {
  await scratch(async ({ root, src }) => {
    const s = src();
    await refused("digest_mismatch", stageRelease({ root, source: s.dir, digest: sha256("something else") }));
    await refused("invalid_input", stageRelease({ root, source: s.dir, digest: s.digest.toUpperCase() }));
    await refused("invalid_input", stageRelease({ root, source: s.dir, digest: "abc" }));
    writeFileSync(join(s.dir, "controller.js"), "console.log('CONTROLLER');\n");
    await refused("source_invalid", stageRelease(opts(root, s)), /controller\.js has a different digest/);
    writeFileSync(join(s.dir, "controller.js"), "short\n");
    await refused("source_invalid", stageRelease(opts(root, s)), /controller\.js has a different size/);
    rmSync(join(s.dir, "controller.js"));
    await refused("source_invalid", stageRelease(opts(root, s)), /controller\.js is missing/);
    // A manifest altered after the digest was given out.
    const t = src();
    writeFileSync(join(t.dir, "MANIFEST.json"), t.manifest.replace("a".repeat(40), "b".repeat(40)));
    await refused("digest_mismatch", stageRelease(opts(root, t)));
    // No manifest at all, and a directory that is not there.
    const u = src();
    rmSync(join(u.dir, "MANIFEST.json"));
    await refused("source_invalid", stageRelease(opts(root, u)), /MANIFEST\.json is missing/);
    await refused("source_invalid", stageRelease({ root, source: join(root, "nope"), digest: u.digest }));
    assert.deepEqual(releasesOf(root), []);
  });
});

test("a manifest with unsafe or malformed contents is refused even when its digest was authorised (K02 updater)", async () => {
  const cases: [string, (m: any, files: Record<string, any>) => string | void, RegExp][] = [
    ["candidate ID", (m) => { m.candidateId = "../evil"; }, /candidateId/],
    ["short candidate ID", (m) => { m.candidateId = "rcn-abc"; }, /candidateId/],
    ["unknown field", (m) => { m.extra = 1; }, /unknown field/],
    ["no commit", (m) => { delete m.sourceCommit; }, /sourceCommit/],
    ["no files", (m) => { m.files = {}; }, /lists no files/],
    ["dot-dot name", (_m, f) => { f["../escape.js"] = f["controller.js"]; }, /not a safe file name/],
    ["absolute-ish name", (_m, f) => { f["/etc/passwd"] = f["controller.js"]; }, /not a safe file name/],
    ["backslash name", (_m, f) => { f["a\\b.js"] = f["controller.js"]; }, /not a safe file name/],
    ["empty part", (_m, f) => { f["a//b.js"] = f["controller.js"]; }, /not a safe file name/],
    ["the manifest's own name", (_m, f) => { f["manifest.JSON"] = f["controller.js"]; }, /reserved/],
    ["a launcher file", (_m, f) => { f["launcher.js"] = f["controller.js"]; }, /launcher and the updater/],
    ["an updater folder", (_m, f) => { f["updater.d/x.js"] = f["controller.js"]; }, /launcher and the updater/],
    ["case collision", (_m, f) => { f["Controller.js"] = f["controller.js"]; }, /case-insensitive/],
    ["file and folder", (_m, f) => { f["controller.js/x"] = f["controller.js"]; }, /both a file and a folder/],
    ["bad entry", (_m, f) => { f["x.js"] = { sha256: "zz", size: 1 }; }, /damaged entry/],
    ["negative size", (_m, f) => { f["x.js"] = { sha256: "a".repeat(64), size: -1 }; }, /damaged entry/],
    ["extra entry field", (_m, f) => { f["x.js"] = { ...f["controller.js"], mode: 511 }; }, /damaged entry/],
    ["not JSON", () => "{not json", /damaged/],
    ["an array", () => "[]", /not an object/],
  ];
  for (const [label, mutate, match] of cases) {
    await scratch(async ({ root, src }) => {
      const s = src();
      const m = JSON.parse(s.manifest);
      const custom = mutate(m, m.files);
      const text = typeof custom === "string" ? custom : JSON.stringify(m);
      writeFileSync(join(s.dir, "MANIFEST.json"), text);
      await refused("source_invalid", stageRelease({ root, source: s.dir, digest: sha256(text) }), match);
      assert.deepEqual(releasesOf(root), [], label);
    });
  }
  await scratch(async ({ root, src }) => {
    const s = src();
    await refused("source_invalid", stageRelease(opts(root, s, { maxFiles: 2 })), /more than 2 files/);
    await refused("source_invalid", stageRelease(opts(root, s, { maxFileBytes: 5 })), /larger than 5 bytes/);
  });
});

test("a damaged compat.json is refused, and the protocol range reaches the announcement (K02 updater)", async () => {
  await scratch(async ({ root, src }) => {
    const s = src({ "controller.js": "x\n", "compat.json": "{\"protocol\":{\"min\":3,\"max\":1}}" });
    await refused("source_invalid", stageRelease(opts(root, s)));
    const ok = src({ "controller.js": "x\n", "compat.json": JSON.stringify({ protocol: { min: 1, max: 2 } }) }, `rcn-${sha256("c2").slice(0, 24)}`);
    const r = await installRelease(opts(root, ok));
    assert.deepEqual(r.protocol, { min: 1, max: 2 });
    assert.deepEqual((await new Launcher({ root, switcher: new PointerSwitcher(root) }).read()).expected?.protocol, { min: 1, max: 2 });
  });
});

test("announce re-verifies: a release changed after staging, missing, or not a release ID is not announced (K02 updater)", async () => {
  await scratch(async ({ root, src }) => {
    const s = src();
    const r = await stageRelease(opts(root, s));
    await refused("invalid_input", announceRelease({ root, release: { id: "../x", digest: s.digest } }));
    await refused("invalid_input", announceRelease({ root, release: { id: ID, digest: "nope" } }));
    await refused("source_invalid", announceRelease({ root, release: { id: `rcn-${sha256("none").slice(0, 24)}`, digest: s.digest } }));
    await refused("source_invalid", announceRelease({ root, release: { id: ID, digest: sha256("other") } }));
    if (POSIX) {
      chmodSync(r.dir, 0o755);
      writeFileSync(join(r.dir, "added.js"), "x");
      await refused("source_invalid", announceRelease({ root, release: r }), /added\.js was added/);
    }
    assert.equal(existsSync(join(root, "launcher-state.json")), false, "nothing was announced");
    await refused("invalid_input", announceRelease({ root: "relative/root", release: r }));
  });
});

test("inputs: relative or control-character paths, a missing root and an oversized manifest are refused (K02 updater)", async () => {
  await scratch(async ({ root, src, base }) => {
    const s = src();
    await refused("invalid_input", stageRelease({ root: "root", source: s.dir, digest: s.digest }));
    await refused("invalid_input", stageRelease({ root, source: "source", digest: s.digest }));
    await refused("invalid_input", stageRelease({ root: `${root}\nx`, source: s.dir, digest: s.digest }));
    await refused("invalid_input", stageRelease({ root: join(base, "missing"), source: s.dir, digest: s.digest }));
    writeFileSync(join(s.dir, "MANIFEST.json"), "x".repeat(2 * 1024 * 1024));
    await refused("source_invalid", stageRelease(opts(root, s)), /larger than/);
  });
});
