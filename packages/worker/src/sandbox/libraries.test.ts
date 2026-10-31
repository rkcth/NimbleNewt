import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { SandboxError } from "./errors.js";
import { cachedLibraryReads, dependentLibraryReads, parseDependents, parseRpaths, symlinkChain, type LibraryProbe } from "./libraries.js";
import { normalizeRecipe } from "./recipe.js";
import { profileFor, seatbeltBackend } from "./seatbelt.js";

const NODE = "/opt/homebrew/Cellar/node@22/22.23.3_3/bin/node";
const header = (file: string): string => `${file}:\n`;
const dep = (p: string): string => `\t${p} (compatibility version 1.0.0, current 1.0.0)\n`;

/** A fake Homebrew: opt/<formula> are links into the Cellar; node links libuv by its opt path and icu through @rpath. */
function fakeBrew(overrides: { otoolFails?: string; missing?: string[] } = {}): LibraryProbe & { calls: string[] } {
  const links: Record<string, string> = {
    "/opt/homebrew/opt/libuv": "../Cellar/libuv/1.51.0",
    "/opt/homebrew/opt/icu4c@77": "../Cellar/icu4c@77/77.1",
    "/opt/homebrew/Cellar/libuv/1.51.0/lib/libuv.1.dylib": "libuv.1.0.0.dylib",
  };
  const files = new Set([
    NODE, "/opt/homebrew/Cellar/libuv/1.51.0/lib/libuv.1.0.0.dylib", "/opt/homebrew/Cellar/icu4c@77/77.1/lib/libicuuc.77.dylib", "/opt/homebrew/Cellar/icu4c@77/77.1/lib/libicudata.77.dylib",
  ].filter((f) => !(overrides.missing ?? []).includes(f)));
  const out: Record<string, { L: string; l: string }> = {
    [NODE]: {
      L: header(NODE) + dep("/opt/homebrew/opt/libuv/lib/libuv.1.dylib") + dep("@rpath/libicuuc.77.dylib") + dep("/usr/lib/libSystem.B.dylib") + dep("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation"),
      l: "Load command 20\n          cmd LC_RPATH\n      cmdsize 48\n         path /opt/homebrew/opt/icu4c@77/lib (offset 12)\n",
    },
    "/opt/homebrew/Cellar/libuv/1.51.0/lib/libuv.1.0.0.dylib": { L: header("x") + dep("/usr/lib/libSystem.B.dylib"), l: "" },
    "/opt/homebrew/Cellar/icu4c@77/77.1/lib/libicuuc.77.dylib": { L: header("x") + dep("@loader_path/libicudata.77.dylib") + dep("/usr/lib/libc++.1.dylib"), l: "" },
    "/opt/homebrew/Cellar/icu4c@77/77.1/lib/libicudata.77.dylib": { L: header("x"), l: "" },
  };
  const calls: string[] = [];
  const isSymlink = (p: string): boolean => p in links;
  const readlink = (p: string): string => links[p]!;
  return {
    calls,
    otool: (flag, file) => { calls.push(`${flag} ${file}`); if (overrides.otoolFails !== undefined) throw new Error(overrides.otoolFails); const e = out[file]; if (e === undefined) throw new Error(`no such file ${file}`); return flag === "-L" ? e.L : e.l; },
    isSymlink, readlink,
    exists: (p) => files.has(symlinkChain(p, { isSymlink, readlink }).real),
    stamp: () => "1:1",
  };
}

describe("a confined program's libraries outside the system (card H12b remainder)", () => {
  test("otool output is parsed: dependents and run-path entries", () => {
    assert.deepEqual(parseDependents(header("f") + dep("/a/b.dylib") + dep("@rpath/c.dylib")), ["/a/b.dylib", "@rpath/c.dylib"]);
    assert.deepEqual(parseRpaths("cmd LC_RPATH\n cmdsize 32\n path @loader_path/../lib (offset 12)\ncmd LC_MAIN\n"), ["@loader_path/../lib"]);
  });

  test("symbolic link components are all found, and the real path ends the chain", () => {
    const { links, real } = symlinkChain("/opt/homebrew/opt/libuv/lib/libuv.1.dylib", fakeBrew());
    assert.deepEqual(links, ["/opt/homebrew/opt/libuv", "/opt/homebrew/Cellar/libuv/1.51.0/lib/libuv.1.dylib"]);
    assert.equal(real, "/opt/homebrew/Cellar/libuv/1.51.0/lib/libuv.1.0.0.dylib");
  });

  test("(a, c) libraries outside the allowed set are added, with their link chain and through @rpath and @loader_path; system libraries add nothing", () => {
    const reads = dependentLibraryReads(NODE, fakeBrew(), []);
    assert.deepEqual(reads, [
      "/opt/homebrew/Cellar/icu4c@77/77.1/lib/libicudata.77.dylib",
      "/opt/homebrew/Cellar/icu4c@77/77.1/lib/libicuuc.77.dylib",
      "/opt/homebrew/Cellar/libuv/1.51.0/lib/libuv.1.0.0.dylib",
      "/opt/homebrew/Cellar/libuv/1.51.0/lib/libuv.1.dylib",
      "/opt/homebrew/opt/icu4c@77",
      "/opt/homebrew/opt/icu4c@77/lib/libicuuc.77.dylib",
      "/opt/homebrew/opt/libuv",
      "/opt/homebrew/opt/libuv/lib/libuv.1.dylib",
    ].sort());
    assert.ok(reads.every((p) => !p.startsWith("/usr") && !p.startsWith("/System")));
  });

  test("what is already readable (a mount holding the Cellar) is not added again", () => {
    const reads = dependentLibraryReads(NODE, fakeBrew(), ["/opt/homebrew/Cellar"]);
    assert.deepEqual(reads, ["/opt/homebrew/opt/icu4c@77", "/opt/homebrew/opt/icu4c@77/lib/libicuuc.77.dylib", "/opt/homebrew/opt/libuv", "/opt/homebrew/opt/libuv/lib/libuv.1.dylib"]);
  });

  test("(b) the profile gets read-only literal allowances for exactly these files, as parameters, and nothing writable", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "nn-lib-")));
    try {
      for (const d of ["w", "h", "s"]) mkdirSync(join(root, d));
      const r = normalizeRecipe({ mode: "sandboxed", workdir: join(root, "w"), home: join(root, "h"), scratch: join(root, "s"), readOnly: [], network: "none", env: {}, protectedSubpaths: [] }, []);
      const base = profileFor(r);
      const reads = dependentLibraryReads(NODE, fakeBrew(), []);
      const withLibs = profileFor(r, reads);
      const added = withLibs.split("\n").filter((l) => !base.split("\n").includes(l));
      assert.equal(added.length, reads.length);
      added.forEach((l, i) => assert.equal(l, `(allow file-read* (literal (param "LIB${i}")))`));
      assert.ok(!withLibs.includes("/opt/homebrew") && !added.some((l) => /write|subpath/.test(l)));
      const plan = seatbeltBackend({ libraryReads: () => reads }).plan(r, [NODE, "worker.js"]);
      const defined = plan.args.filter((_, i) => plan.args[i - 1] === "-D").filter((d) => d.startsWith("LIB"));
      assert.deepEqual(defined, reads.map((p, i) => `LIB${i}=${p}`));
      assert.deepEqual(plan.args.slice(-2), [NODE, "worker.js"]);
      // A program in the system adds nothing; a relative one is left to the system search path.
      assert.ok(seatbeltBackend({ libraryReads: () => { throw new Error("must not be asked"); } }).plan(r, ["bin/true"]).args.length > 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("(d) an otool failure refuses with a clear error naming the file, never an abort at start", () => {
    assert.throws(() => dependentLibraryReads(NODE, fakeBrew({ otoolFails: "otool: not found" })), (e: unknown) => e instanceof SandboxError && e.code === "invalid_recipe" && e.message.includes(NODE) && e.message.includes("otool"));
  });

  test("(d) a library that cannot be found refuses naming it", () => {
    assert.throws(() => dependentLibraryReads(NODE, fakeBrew({ missing: ["/opt/homebrew/Cellar/icu4c@77/77.1/lib/libicudata.77.dylib"] })), (e: unknown) => e instanceof SandboxError && e.message.includes("libicudata.77.dylib"));
    assert.throws(() => dependentLibraryReads(NODE, { ...fakeBrew(), exists: () => false }), /libuv\.1\.dylib/);
  });

  test("the answer is kept per program path and modification time", () => {
    const probe = fakeBrew();
    let stamp = "1";
    const reads = cachedLibraryReads({ ...probe, stamp: () => stamp });
    reads(NODE, []); const first = probe.calls.length; reads(NODE, []);
    assert.equal(probe.calls.length, first);
    stamp = "2"; reads(NODE, []);
    assert.ok(probe.calls.length > first);
  });
});

describe("the real otool (macOS only)", { skip: process.platform === "darwin" ? false : "needs macOS and /usr/bin/otool" }, () => {
  test("this machine's own node resolves, and a confined node runs with exactly those reads", async () => {
    const { realProbe, SYSTEM_READABLE } = await import("./libraries.js");
    const reads = dependentLibraryReads(process.execPath, realProbe, []);
    assert.ok(reads.every((p) => p.startsWith("/") && !SYSTEM_READABLE.some((r) => p.startsWith(`${r}/`))));
    const root = realpathSync(mkdtempSync(join(tmpdir(), "nn-lib-live-")));
    try {
      for (const d of ["w", "h", "s"]) mkdirSync(join(root, d));
      const r = normalizeRecipe({ mode: "sandboxed", workdir: join(root, "w"), home: join(root, "h"), scratch: join(root, "s"), readOnly: [{ host: join(process.execPath, "..", ".."), guest: "/inputs/node" }], network: "none", env: {}, protectedSubpaths: [] }, []);
      const plan = seatbeltBackend().plan(r, [process.execPath, "-e", "console.log('ran')"]);
      const { execFileSync } = await import("node:child_process");
      assert.equal(execFileSync(plan.file, [...plan.args], { env: { ...plan.env }, cwd: plan.cwd, encoding: "utf8" }).trim(), "ran");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
