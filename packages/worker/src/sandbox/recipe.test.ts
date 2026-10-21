import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SandboxError } from "./errors.js";
import { normalizeRecipe, type SandboxRecipe } from "./recipe.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "nn-recipe-")));
const dir = (name: string): string => { const p = join(root, name); mkdirSync(p, { recursive: true }); return p; };
const base = (): SandboxRecipe => ({ mode: "sandboxed", workdir: dir("work"), home: dir("home"), scratch: dir("scratch"), readOnly: [], network: "none", env: {}, protectedSubpaths: [".git"] });
const refused = (recipe: unknown, protectedPaths: readonly string[] = [], pattern?: RegExp): void => {
  assert.throws(() => normalizeRecipe(recipe as SandboxRecipe, protectedPaths), (error: unknown) => error instanceof SandboxError && error.code === "invalid_recipe" && (pattern === undefined || pattern.test(error.message)));
};

test("a valid recipe is accepted and has a revision that ignores key order and changes with every field", () => {
  const a = normalizeRecipe({ ...base(), env: { B: "2", A: "1" } }, []);
  const b = normalizeRecipe({ ...base(), env: { A: "1", B: "2" } }, []);
  assert.equal(a.revision, b.revision);
  assert.match(a.revision, /^[0-9a-f]{64}$/);
  const seen = new Set([a.revision]);
  for (const changed of [{ env: { A: "1" } }, { mode: "trusted-host" as const }, { protectedSubpaths: [".git", ".hg"] }, { readOnly: [{ host: dir("tools"), guest: "/inputs/tools" }] }, { workdir: dir("work2") }]) {
    const revision = normalizeRecipe({ ...base(), ...changed }, []).revision;
    assert.ok(!seen.has(revision), `revision did not change for ${JSON.stringify(changed)}`);
    seen.add(revision);
  }
});

test("paths that are not plain, real, existing locations are refused", () => {
  refused({ ...base(), workdir: "relative/path" }, [], /absolute/);
  refused({ ...base(), workdir: root + "/work/../work" }, [], /normalised/);
  refused({ ...base(), workdir: join(root, "work") + "/" }, [], /normalised/);
  refused({ ...base(), workdir: join(root, "missing") }, [], /does not exist/);
  refused({ ...base(), workdir: 7 }, [], /must be a path/);
  const file = join(root, "afile"); writeFileSync(file, "x");
  refused({ ...base(), workdir: file }, [], /directory/);
  const link = join(root, "link"); symlinkSync(dir("target"), link, process.platform === "win32" ? "junction" : "dir");
  refused({ ...base(), workdir: link }, [], /symbolic link/);
  refused({ ...base(), workdir: join(link, "inner") }, [], /does not exist|symbolic link/);
  refused({ ...base(), mode: "other" }, [], /mode/);
  refused(null);
});

test("system directories, the service user's home and credential places cannot be mounted", () => {
  for (const system of ["/", "/usr", "/etc", "/proc", "/dev", "/tmp", "/home"]) refused({ ...base(), workdir: system }, [], /system directory|home|does not exist|symbolic link|normalised/);
  refused({ ...base(), scratch: homedir() }, [], /home/);
});

test("a mount may not contain or sit inside a protected path", () => {
  const secret = dir("controller-data"); const inner = dir("controller-data/db");
  refused({ ...base(), workdir: secret }, [secret], /protected/);
  refused({ ...base(), workdir: inner }, [secret], /protected/);
  refused({ ...base(), workdir: root }, [secret], /protected/);
  assert.ok(normalizeRecipe(base(), [secret]).revision);
});

test("nothing inside kernel or runtime state, the superuser's files or another user's home can be mounted", { skip: process.platform === "win32" }, () => {
  for (const inner of ["/proc/self/environ", "/proc/1/environ", "/sys/kernel", "/run/user", "/root/.bashrc"]) {
    try { realpathSync(inner); } catch { continue; }
    refused({ ...base(), readOnly: [{ host: inner, guest: "/inputs/x" }] }, [], /inside|symbolic link|another user/);
  }
  const elsewhere = process.platform === "darwin" ? "/Users/someone-else" : "/home/someone-else";
  refused({ ...base(), workdir: elsewhere }, [], /another user's home|does not exist/);
});

test("guest paths are POSIX paths on every host OS", () => {
  const t = dir("posix-tools");
  assert.ok(normalizeRecipe({ ...base(), readOnly: [{ host: t, guest: "/inputs/tools" }, { host: dir("posix-tools2"), guest: "/opt/more/tools" }] }, []));
  refused({ ...base(), readOnly: [{ host: t, guest: "\\inputs\\tools" }] }, [], /guest/);
});

test("mounts may not overlap each other, and guest paths are confined to /inputs and /opt", () => {
  const w = dir("work");
  refused({ ...base(), home: join(w, "inside") }, [], /does not exist|overlap/);
  mkdirSync(join(w, "inside"), { recursive: true });
  refused({ ...base(), home: join(w, "inside") }, [], /overlap/);
  const t = dir("tools");
  refused({ ...base(), readOnly: [{ host: t, guest: "/inputs/a" }, { host: dir("tools2"), guest: "/inputs/a" }] }, [], /overlap/);
  refused({ ...base(), readOnly: [{ host: t, guest: "/inputs/a" }, { host: dir("tools3"), guest: "/inputs/a/b" }] }, [], /overlap/);
  for (const guest of ["/etc/x", "/work/x", "/usr/lib/x", "relative", "/inputs/../etc", "/inputs//x", "/inputs/"]) refused({ ...base(), readOnly: [{ host: t, guest }] }, [], /guest/);
  assert.ok(normalizeRecipe({ ...base(), readOnly: [{ host: t, guest: "/opt/tools" }] }, []));
});

test("only the none network is accepted, and the environment is a plain bounded set of names", () => {
  refused({ ...base(), network: "host" }, [], /network/);
  refused({ ...base(), network: undefined }, [], /network/);
  for (const name of ["1BAD", "has space", "A=B", "", "HOME", "PATH", "TMPDIR", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH"]) refused({ ...base(), env: { [name]: "x" } }, [], /env/);
  refused({ ...base(), env: { A: 5 } }, [], /env/);
  refused({ ...base(), env: { A: "x".repeat(5000) } }, [], /env/);
  refused({ ...base(), env: { A: "a\0b" } }, [], /env/);
  refused({ ...base(), env: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`V${i}`, "x"])) }, [], /at most/);
  refused({ ...base(), env: [] }, [], /env/);
});

test("protected subpath names are plain names; a symbolic link in their place is refused; missing ones are reported", () => {
  for (const name of ["", ".", "..", "a/b", "/abs", "with space"]) refused({ ...base(), protectedSubpaths: [name] }, [], /protectedSubpaths/);
  const w = dir("pw"); const r = { ...base(), workdir: w };
  assert.deepEqual(normalizeRecipe(r, []).unprotectedSubpaths, [".git"]);
  mkdirSync(join(w, ".git"));
  assert.deepEqual(normalizeRecipe(r, []).unprotectedSubpaths, []);
  const w2 = dir("pw2"); symlinkSync(dir("elsewhere"), join(w2, ".git"), process.platform === "win32" ? "junction" : "dir");
  refused({ ...base(), workdir: w2 }, [], /symbolic link/);
});
