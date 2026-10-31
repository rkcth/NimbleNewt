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
function fakeBrew(overrides: { otoolFails?: string; missing?: string[]; links?: Record<string, string>; files?: string[]; out?: Record<string, { L: string; l?: string }>; magic?: Record<string, string> } = {}): LibraryProbe & { calls: string[] } {
  const links: Record<string, string> = {
    "/opt/homebrew/opt/libuv": "../Cellar/libuv/1.51.0",
    "/opt/homebrew/opt/icu4c@77": "../Cellar/icu4c@77/77.1",
    "/opt/homebrew/Cellar/libuv/1.51.0/lib/libuv.1.dylib": "libuv.1.0.0.dylib",
    ...overrides.links,
  };
  const files = new Set([
    NODE, "/opt/homebrew/Cellar/libuv/1.51.0/lib/libuv.1.0.0.dylib", "/opt/homebrew/Cellar/icu4c@77/77.1/lib/libicuuc.77.dylib", "/opt/homebrew/Cellar/icu4c@77/77.1/lib/libicudata.77.dylib",
    ...(overrides.files ?? []),
  ].filter((f) => !(overrides.missing ?? []).includes(f)));
  const out: Record<string, { L: string; l: string }> = {
    [NODE]: {
      L: header(NODE) + dep("/opt/homebrew/opt/libuv/lib/libuv.1.dylib") + dep("@rpath/libicuuc.77.dylib") + dep("/usr/lib/libSystem.B.dylib") + dep("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation"),
      l: "Load command 20\n          cmd LC_RPATH\n      cmdsize 48\n         path /opt/homebrew/opt/icu4c@77/lib (offset 12)\n",
    },
    "/opt/homebrew/Cellar/libuv/1.51.0/lib/libuv.1.0.0.dylib": { L: header("x") + dep("/usr/lib/libSystem.B.dylib"), l: header("x") },
    "/opt/homebrew/Cellar/icu4c@77/77.1/lib/libicuuc.77.dylib": { L: header("x") + dep("@loader_path/libicudata.77.dylib") + dep("/usr/lib/libc++.1.dylib"), l: "" },
    "/opt/homebrew/Cellar/icu4c@77/77.1/lib/libicudata.77.dylib": { L: header("x"), l: "" },
  };
  for (const [f, v] of Object.entries(overrides.out ?? {})) out[f] = { L: v.L, l: v.l ?? header(f) };
  const calls: string[] = [];
  const isSymlink = (p: string): boolean => p in links;
  const readlink = (p: string): string => links[p]!;
  return {
    calls,
    otool: (flag, file) => { calls.push(`${flag} ${file}`); if (overrides.otoolFails !== undefined) throw new Error(overrides.otoolFails); const e = out[file]; if (e === undefined) throw new Error(`no such file ${file}`); const t = flag === "-L" ? e.L : e.l; return t.startsWith("x:\n") ? header(file) + t.slice(3) : flag === "-l" && !t.startsWith(header(file)) ? header(file) + t : t; },
    isSymlink, readlink,
    exists: (p) => files.has(symlinkChain(p, { isSymlink, readlink }).real),
    stamp: () => "1:1",
    magic: (p) => overrides.magic?.[p] ?? (files.has(symlinkChain(p, { isSymlink, readlink }).real) ? "cffaedfe" : ""),
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
    assert.throws(() => dependentLibraryReads(NODE, fakeBrew({ otoolFails: "otool: not found" })), (e: unknown) => e instanceof SandboxError && e.code === "invalid_recipe" && e.message.includes("node") && e.message.includes("otool") && !e.message.includes("/opt/homebrew"));
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

const refused = (re: RegExp) => (e: unknown): boolean => e instanceof SandboxError && e.code === "invalid_recipe" && re.test(e.message);
const SECRET = "/Users/owner/.ssh/id_rsa";
const nodeWith = (extraDeps: string, l = ""): { L: string; l: string } => ({ L: header(NODE) + dep("/usr/lib/libSystem.B.dylib") + extraDeps, l: header(NODE) + l });

describe("security: the read set can only name real libraries in the allowed places (review of 89ac770)", () => {
  test("a dependency naming a secret file is refused, directly or through a link", () => {
    assert.throws(() => dependentLibraryReads(NODE, fakeBrew({ files: [SECRET], out: { [NODE]: nodeWith(dep(SECRET)) } })), refused(/id_rsa.*outside the places/));
    const probe = fakeBrew({ files: [SECRET], links: { "/opt/homebrew/opt/evil": SECRET }, out: { [NODE]: nodeWith(dep("/opt/homebrew/opt/evil")) } });
    assert.throws(() => dependentLibraryReads(NODE, probe), refused(/outside the places/));
  });

  test("a library without a Mach-O signature is refused even inside Homebrew", () => {
    const f = "/opt/homebrew/opt/libfake.dylib";
    const probe = fakeBrew({ files: [f], magic: { [f]: "2321202f" }, out: { [NODE]: nodeWith(dep(f)), [f]: { L: header(f) } } });
    assert.throws(() => dependentLibraryReads(NODE, probe), refused(/not a Mach-O/));
  });

  test("otool saying 'is not an object file', or a report on another file, is refused (and exit 0 is no excuse)", () => {
    const f = "/opt/homebrew/opt/libfake.dylib";
    for (const L of [`${f}: is not an object file\n\t${SECRET} (compatibility version 1.0.0, current 1.0.0)\n`, `something else:\n\t${SECRET} (compatibility version 1.0.0, current 1.0.0)\n`, ""]) {
      const probe = fakeBrew({ files: [f, SECRET], out: { [NODE]: nodeWith(dep(f)), [f]: { L } } });
      assert.throws(() => dependentLibraryReads(NODE, probe), refused(/not a Mach-O|expected form/));
    }
  });

  test("a report that has the right first line but says 'is not an object file' is refused; so is a library inside a writable directory even under an allowed prefix", () => {
    const f = "/opt/homebrew/opt/libfake.dylib";
    const probe = fakeBrew({ files: [f], out: { [NODE]: nodeWith(dep(f)), [f]: { L: header(f) + `${f}: is not an object file\n` } } });
    assert.throws(() => dependentLibraryReads(NODE, probe), refused(/not a Mach-O/));
    const ok = fakeBrew({ files: [f], out: { [NODE]: nodeWith(dep(f)), [f]: { L: header(f) } } });
    assert.throws(() => dependentLibraryReads(NODE, ok, [], { writable: ["/opt/homebrew/opt"] }), refused(/outside the places/));
  });

  test("a program in the agent's writable directory (directly or through a link) is not inspected", () => {
    const own = "/Users/svc/work/bin/node";
    const probe = fakeBrew({ files: [own], out: { [own]: { L: header(own) + dep(SECRET) } } });
    assert.throws(() => dependentLibraryReads(own, probe, [], { writable: ["/Users/svc/work"] }), refused(/writable/));
    assert.equal(probe.calls.length, 0);
    const linked = fakeBrew({ files: [own], links: { "/opt/homebrew/bin/node": own } });
    assert.throws(() => dependentLibraryReads("/opt/homebrew/bin/node", linked, [], { writable: ["/Users/svc/work"] }), refused(/writable/));
    assert.throws(() => cachedLibraryReads(probe)(own, [], ["/Users/svc/work"]), refused(/writable/));
  });

  test("a library outside Homebrew and the program's install root is refused; a configured prefix or the install root admits it", () => {
    const f = "/opt/custom/lib/libx.dylib";
    const probe = (): ReturnType<typeof fakeBrew> => fakeBrew({ files: [f], out: { [NODE]: nodeWith(dep(f)), [f]: { L: header(f) } } });
    assert.throws(() => dependentLibraryReads(NODE, probe()), refused(/libx\.dylib.*outside the places/));
    assert.ok(dependentLibraryReads(NODE, probe(), [], { extraPrefixes: ["/opt/custom"] }).includes(f));
    const own = "/srv/tools/node-v22/bin/node", lib = "/srv/tools/node-v22/lib/libz.dylib";
    const p2 = fakeBrew({ files: [own, lib], out: { [own]: { L: header(own) + dep(lib) }, [lib]: { L: header(lib) } } });
    assert.deepEqual(dependentLibraryReads(own, p2), [lib]);
  });

  test("error messages name the program and library but no directories", () => {
    const f = "/opt/homebrew/opt/libgone.dylib";
    assert.throws(() => dependentLibraryReads(NODE, fakeBrew({ out: { [NODE]: nodeWith(dep(f)) } })), (e: unknown) => e instanceof Error && e.message.includes("libgone.dylib") && !e.message.includes("/opt/homebrew") && !e.message.includes("/Users"));
  });

  test("resolution gives up after its time allowance", () => {
    let t = 0;
    assert.throws(() => dependentLibraryReads(NODE, fakeBrew(), [], { now: () => (t += 20_000), timeoutMs: 30_000 }), refused(/too long/));
  });
});

describe("correctness of the walk (review of 89ac770)", () => {
  test("a dylib's own install name, printed first by otool -L, is not a dependency", () => {
    const lib = "/opt/homebrew/opt/libself.dylib";
    const l = `Load command 3\n          cmd LC_ID_DYLIB\n      cmdsize 48\n         name ${lib} (offset 24)\n`;
    // The id names a path that does not exist as such (the real file is in the Cellar): if it were followed the walk would refuse.
    const probe = fakeBrew({ files: [lib], out: { [NODE]: nodeWith(dep(lib)), [lib]: { L: header(lib) + dep("/opt/homebrew/opt/libgone.dylib") + dep("/usr/lib/libSystem.B.dylib"), l } } });
    assert.throws(() => dependentLibraryReads(NODE, probe), /libgone/);
    const ok = fakeBrew({ files: [lib], out: { [NODE]: nodeWith(dep(lib)), [lib]: { L: header(lib) + dep("@rpath/libself.dylib") + dep("/usr/lib/libSystem.B.dylib"), l: l.replace(lib, "@rpath/libself.dylib") } } });
    assert.deepEqual(dependentLibraryReads(NODE, ok), [lib]);
  });

  test("a weak dependency that is absent is tolerated; a strong one is not", () => {
    const f = "/opt/homebrew/opt/libopt.dylib";
    const weakL = "Load command 9\n          cmd LC_LOAD_WEAK_DYLIB\n      cmdsize 56\n         name " + f + " (offset 24)\n";
    assert.deepEqual(dependentLibraryReads(NODE, fakeBrew({ out: { [NODE]: nodeWith(dep(f), weakL) } }), []), []);
    assert.throws(() => dependentLibraryReads(NODE, fakeBrew({ out: { [NODE]: nodeWith(dep(f)) } })), /libopt/);
  });

  test("@rpath is searched along the whole chain: the executable's run paths serve a library's own @rpath dependency", () => {
    const lib = "/opt/homebrew/Cellar/a/1/lib/liba.dylib", dd = "/opt/homebrew/Cellar/b/1/lib/libb.dylib";
    const exeL = "cmd LC_RPATH\n cmdsize 32\n path /opt/homebrew/Cellar/b/1/lib (offset 12)\ncmd LC_RPATH\n cmdsize 32\n path @loader_path/../../../a/1/lib (offset 12)\n";
    const probe = fakeBrew({ files: [lib, dd], out: { [NODE]: nodeWith(dep("@rpath/liba.dylib"), exeL), [lib]: { L: header(lib) + dep("@rpath/libb.dylib") }, [dd]: { L: header(dd) } } });
    assert.deepEqual(dependentLibraryReads(NODE, probe), [dd, lib].sort());
    // Without the chain (the library has no run paths of its own) the old code could not find libb.
  });

  test("universal binaries: only the host architecture's slice counts", () => {
    const f = "/opt/homebrew/opt/libu.dylib", other = "/opt/homebrew/opt/libx86only.dylib";
    const L = `${NODE} (architecture x86_64):\n${dep(other)}${NODE} (architecture arm64):\n${dep(f)}`;
    const mk = (): ReturnType<typeof fakeBrew> => fakeBrew({ files: [f], out: { [NODE]: { L, l: header(NODE) }, [f]: { L: header(f) } } });
    assert.deepEqual(dependentLibraryReads(NODE, mk(), [], { arch: "arm64" }), [f]);
    assert.throws(() => dependentLibraryReads(NODE, mk(), [], { arch: "ppc" }), refused(/no part for this machine/));
    assert.throws(() => dependentLibraryReads(NODE, mk(), [], { arch: "x64" }), /libx86only/);
  });
});

describe("the remembered answer (review of 89ac770)", () => {
  test("a listed library that has gone is noticed and the answer recomputed", () => {
    const stamps = new Map<string, string>();
    const base = fakeBrew();
    const probe: LibraryProbe = { ...base, stamp: (p) => { const s = stamps.get(p) ?? "1"; if (s === "gone") { stamps.delete(p); throw new Error("ENOENT"); } return s; } };
    const reads = cachedLibraryReads(probe);
    reads(NODE, []); const n = base.calls.length; reads(NODE, []);
    assert.equal(base.calls.length, n);
    stamps.set("/opt/homebrew/opt/libuv", "gone");
    reads(NODE, []);
    assert.ok(base.calls.length > n);
  });

  test("per-run directories do not create new entries or recomputation; they are still applied each time", () => {
    const probe = fakeBrew();
    const reads = cachedLibraryReads(probe);
    reads(NODE, ["/tmp/run1"], ["/tmp/run1"]); const n = probe.calls.length;
    reads(NODE, ["/tmp/run2"], ["/tmp/run2"]);
    assert.equal(probe.calls.length, n);
    assert.deepEqual(reads(NODE, ["/opt/homebrew/Cellar"], []).every((p) => !p.startsWith("/opt/homebrew/Cellar")), true);
    assert.throws(() => reads(NODE, [], ["/opt/homebrew/opt/libuv"]), refused(/writable/));
  });

  test("the cache is bounded to 64 programs, least recently used first", () => {
    const probe = fakeBrew({ files: Array.from({ length: 66 }, (_, i) => `/opt/homebrew/bin/p${i}`), out: Object.fromEntries(Array.from({ length: 66 }, (_, i) => [`/opt/homebrew/bin/p${i}`, { L: header(`/opt/homebrew/bin/p${i}`) }])) });
    const reads = cachedLibraryReads(probe);
    for (let i = 0; i < 66; i++) reads(`/opt/homebrew/bin/p${i}`, []);
    const n = probe.calls.length;
    reads("/opt/homebrew/bin/p65", []); assert.equal(probe.calls.length, n);
    reads("/opt/homebrew/bin/p0", []); assert.ok(probe.calls.length > n);
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
