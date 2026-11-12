import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { SandboxLauncher } from "../sandbox/launcher.js";
import { METADATA_FILE } from "./archive.js";
import type { InstallScriptPort } from "./agent-environments.js";
import { encodeName } from "./agent-environments.js";
import { localEnvironmentHost } from "./host.js";
import { LocalEnvironmentRuntime, hostEnvironmentsBase, type RuntimeManifest, type WorkerHooks } from "./runtime.js";
import { sandboxInstallScripts } from "./scripts.js";
import { directoryArtifactSource, httpsArtifactSource, SourceError, type ArtifactSource } from "./sources.js";
import { fixture } from "./testing/tar.js";
import { realIo, scanTree, type FileIo } from "./tree.js";

/** The tests below that build real revisions run where the runtime does: it is Linux only (host.ts), and on Windows its store's links, locks and renames behave otherwise. */
const POSIX_STORE = process.platform === "win32" && "the environment runtime is Linux only (host.ts refuses it elsewhere); its store's links, locks and renames are POSIX";

const required = process.env["NIMBLENEWT_REQUIRE_SANDBOX"] === "1";
const top = realpathSync(mkdtempSync(join(tmpdir(), "nn-a09r-")));
after(() => { try { chmodSync(top, 0o700); } catch { /* gone */ } rmSync(top, { recursive: true, force: true }); });
let n = 0;
const fresh = (label: string): string => { const d = join(top, `${label}-${n++}`); mkdirSync(d, { recursive: true }); return d; };

const BASE = { name: "nimblenewt-base", version: "1.0.0", digest: `sha256:${"1".repeat(64)}` };
const manifest = (packages: { name: string; version: string; digest: string }[], extra: Partial<RuntimeManifest> = {}): RuntimeManifest => ({ base: BASE, packages, limits: { cpus: 1, memoryMb: 1024, diskMb: 500, processes: 100 }, protectedExtensions: [], ...extra });
const AGENT = "agent:ann";

class Source implements ArtifactSource {
  readonly files = new Map<string, Uint8Array>(); fetched: string[] = [];
  async fetch(source: string, maxBytes: number): Promise<Uint8Array> { this.fetched.push(source); const f = this.files.get(source); if (f === undefined) throw new Error("not in the fake registry"); if (f.length > maxBytes) throw new Error("too big"); return f; }
}
class Worker {
  restarts: { revision: number; directory: string; checkpointId: string }[] = []; failRestart: string | undefined; session = { sessionIntact: true, compactionIntact: true };
  async restart(e: { revision: number; directory: string; checkpointId: string }): Promise<void> { if (this.failRestart !== undefined) throw new Error(this.failRestart); this.restarts.push(e); }
}
const hooks = (w: Worker): WorkerHooks => ({ restart: (e) => w.restart(e), session: async () => w.session });
const url = (name: string): string => `https://registry.example.org/${name}.tgz`;

function world(options: { scripts?: InstallScriptPort; io?: FileIo; failpoint?: (name: string) => void; root?: string } = {}) {
  const root = options.root ?? join(fresh("env"), "environments");
  const source = new Source(); const worker = new Worker();
  const runtime = new LocalEnvironmentRuntime({ root, worker: hooks(worker), source, ...(options.scripts === undefined ? {} : { scripts: options.scripts }), ...(options.failpoint === undefined ? {} : { failpoint: options.failpoint }), ...(options.io === undefined ? {} : { io: options.io }) });
  const add = (name: string, version = "1.0.0", extra: Partial<Parameters<typeof fixture>[0]> = {}) => { const f = fixture({ name, version, ...extra }); source.files.set(url(name), f.bytes); return { ...f, source: url(name) }; };
  return { root: runtime.root, source, worker, runtime, add };
}
const spec = (f: { name: string; version: string; digest: string; source: string }, installScripts = false) => ({ ...f, installScripts });
const trialOf = (w: ReturnType<typeof world>, f: ReturnType<ReturnType<typeof world>["add"]>, installScripts = false, current: { name: string; version: string; digest: string }[] = []) =>
  w.runtime.trial({ requestId: "m1", agentId: AGENT, kind: "package", artifact: spec(f), installScripts, candidate: manifest([...current, { name: f.name, version: f.version, digest: f.digest }]) });
const reloadOf = (w: ReturnType<typeof world>, revision: number, packages: { name: string; version: string; digest: string }[], change?: ReturnType<typeof spec>, extra: Partial<RuntimeManifest> = {}) =>
  w.runtime.reload({ requestId: "m1", agentId: AGENT, revision, manifest: manifest(packages, extra), checkpointId: `cp-${revision}`, ...(change === undefined ? {} : { change }) });
const ref = (f: { name: string; version: string; digest: string }) => ({ name: f.name, version: f.version, digest: f.digest });
const noTemp = (root: string): void => { for (const d of ["tmp", "trials"]) assert.deepEqual(existsSync(join(root, d)) ? readdirSync(join(root, d)) : [], [], `${d} holds no leftovers`); };

describe("the local environment runtime: a package goes in through a trial, a staged revision and an atomic switch", () => {
  test("the full cycle: trial, reload on a new revision, validate, a second package, a rollback reload; digests, links and files are what they should be", { skip: POSIX_STORE }, async () => {
    const w = world();
    const ext = join(fresh("ext"), "exts"); mkdirSync(ext); writeFileSync(join(ext, "guard"), "protected extension v1");
    const runtime = new LocalEnvironmentRuntime({ root: w.root, worker: hooks(w.worker), source: w.source, extensions: { directory: ext } });
    const a = w.add("ripgrep", "1.2.3", { files: { "README": "hello" }, extra: [{ path: "bin/rg", data: "#!/bin/sh\n", mode: 0o755 }] });
    const t = await runtime.trial({ requestId: "m1", agentId: AGENT, kind: "package", artifact: spec(a), installScripts: false, candidate: manifest([ref(a)]) });
    assert.deepEqual(t, { ok: true, digestVerified: true, scriptsDeclared: false, scriptsRan: false });
    assert.equal(await runtime.environments.active(AGENT), undefined, "a trial installs nothing live");
    assert.deepEqual(readdirSync(join(w.root, "trials")), [], "the disposable environment is gone");

    const r = await runtime.reload({ requestId: "m1", agentId: AGENT, revision: 2, manifest: manifest([ref(a)], { protectedExtensions: [{ name: "guard", digest: "x" }, { name: "missing", digest: "y" }] }), checkpointId: "cp-2", change: spec(a) });
    assert.equal(r.ok, true, JSON.stringify(r));
    if (r.ok) assert.deepEqual(Object.keys(r.observed), ["guard"], "an extension that is not where it loads is not reported");
    assert.equal(await runtime.environments.active(AGENT), 2);
    assert.equal(readlinkSync(join(runtime.environments.agentDir(AGENT), "active")), "revisions/2", "a relative link inside the agent's own directory");
    const pkg = join(runtime.environments.revisionDir(AGENT, 2), "packages", "ripgrep");
    assert.equal(readFileSync(join(pkg, "bin/rg"), "utf8"), "#!/bin/sh\n");
    assert.equal(lstatSync(join(pkg, "bin/rg")).mode & 0o777, 0o755);
    assert.equal(lstatSync(join(pkg, "README")).mode & 0o777, 0o644);
    assert.equal(w.worker.restarts.at(-1)!.revision, 2); assert.equal(w.worker.restarts.at(-1)!.checkpointId, "cp-2");
    assert.deepEqual(await runtime.validate({ requestId: "m1", agentId: AGENT, revision: 2, manifest: manifest([ref(a)]), checkpointId: "cp-2" }), { ok: true, sessionIntact: true, compactionIntact: true });
    assert.deepEqual(w.source.fetched, [url("ripgrep")], "fetched once: the trial's verified copy is what the reload installs");

    const b = w.add("jq", "2.0.0");
    assert.equal((await reloadOf(w, 3, [ref(a), ref(b)], spec(b))).ok, true);
    assert.equal(await w.runtime.environments.active(AGENT), 3); assert.equal(await w.runtime.environments.active(AGENT, "previous"), 2);
    // The rollback: a revision made from the old manifest, no change, nothing fetched.
    const before = w.source.fetched.length;
    assert.equal((await reloadOf(w, 4, [ref(a)])).ok, true);
    assert.equal(w.source.fetched.length, before);
    assert.deepEqual(readdirSync(join(w.runtime.environments.revisionDir(AGENT, 4), "packages")), ["ripgrep"]);
    noTemp(w.root);
  });

  test("a digest mismatch installs nothing, whatever the bytes are", async () => {
    const w = world();
    const good = w.add("tool"); const evil = fixture({ name: "tool", version: "1.0.0", files: { "index.js": "steal()" } });
    w.source.files.set(url("tool"), evil.bytes);
    const t = await trialOf(w, good);
    assert.equal(t.ok, false); assert.match((t as { reason: string }).reason, /digest mismatch/);
    const r = await reloadOf(w, 2, [ref(good)], spec(good));
    assert.equal(r.ok, false); assert.match((r as { reason: string }).reason, /digest mismatch/);
    assert.deepEqual(await w.runtime.store.list(), [], "nothing was stored");
    assert.equal(await w.runtime.environments.active(AGENT), undefined);
    noTemp(w.root);
  });

  test("the archive must be the package that was approved, and an archive that is unsafe is refused before anything is written", async () => {
    const w = world();
    const other = fixture({ name: "other", version: "1.0.0" });
    w.source.files.set(url("tool"), other.bytes);
    const claim = { name: "tool", version: "1.0.0", digest: other.digest, source: url("tool") };
    const t = await w.runtime.trial({ requestId: "m", agentId: AGENT, kind: "package", artifact: { ...claim }, installScripts: false, candidate: manifest([ref(claim)]) });
    assert.equal(t.ok, false); assert.match((t as { reason: string }).reason, /not the approved tool@1.0.0/);
    for (const [label, extra] of [["symlink", { path: "evil", type: "2", linkname: "/etc/passwd" }], ["setuid", { path: "su", data: "x", mode: 0o4755 }], ["traversal", { path: "../../escape", data: "x" }]] as const) {
      const f = w.add(`bad-${label}`, "1.0.0", { extra: [extra] });
      const r = await trialOf(w, f);
      assert.equal(r.ok, false, label);
      assert.ok(!existsSync(join(w.root, "store", f.digest.slice(7))), `${label}: nothing stored`);
    }
    assert.equal(existsSync(join(dirname(w.root), "escape")), false);
    noTemp(w.root);
  });

  test("an oversized archive from the source is refused", async () => {
    const root = join(fresh("env"), "environments");
    const source = new Source(); const worker = new Worker();
    const runtime = new LocalEnvironmentRuntime({ root, worker: hooks(worker), source, limits: { maxArchiveBytes: 4000, maxUnpackedBytes: 5000, maxFiles: 50, maxDepth: 10, maxPathBytes: 200 } });
    const big = fixture({ name: "big", version: "1.0.0", files: { "blob.bin": "x".repeat(200_000) } });
    source.files.set(url("big"), big.bytes);
    const tooBigToUnpack = fixture({ name: "huge", version: "1.0.0", files: { "blob.bin": "ab".repeat(400_000) } });
    source.files.set(url("huge"), tooBigToUnpack.bytes);
    for (const f of [big, tooBigToUnpack]) {
      const claim = { name: f.name, version: f.version, digest: f.digest, source: url(f.name) };
      const t = await runtime.trial({ requestId: "m", agentId: AGENT, kind: "package", artifact: claim, installScripts: false, candidate: manifest([ref(claim)]) });
      assert.equal(t.ok, false, f.name);
    }
    assert.deepEqual(await runtime.store.list(), []);
  });

  test("no source and no stored copy: the request fails and says so; a stored copy needs no source", async () => {
    const root = join(fresh("env"), "environments"); const worker = new Worker();
    const bare = new LocalEnvironmentRuntime({ root, worker: hooks(worker) });
    const f = fixture({ name: "tool", version: "1.0.0" });
    const claim = { name: "tool", version: "1.0.0", digest: f.digest, source: url("tool") };
    const t = await bare.trial({ requestId: "m", agentId: AGENT, kind: "package", artifact: claim, installScripts: false, candidate: manifest([ref(claim)]) });
    assert.equal(t.ok, false); assert.match((t as { reason: string }).reason, /no way to fetch/);
    await bare.store.put(f.bytes, f); // seeded by the operator
    const again = await bare.trial({ requestId: "m", agentId: AGENT, kind: "package", artifact: claim, installScripts: false, candidate: manifest([ref(claim)]) });
    assert.equal(again.ok, true);
  });

  test("the candidate must list the approved artifact exactly", async () => {
    const w = world(); const a = w.add("tool");
    const t = await w.runtime.trial({ requestId: "m", agentId: AGENT, kind: "package", artifact: spec(a), installScripts: false, candidate: manifest([{ name: "tool", version: "9.9.9", digest: a.digest }]) });
    assert.equal(t.ok, false);
    const r = await reloadOf(w, 2, [{ name: "other", version: "1.0.0", digest: a.digest }], spec(a));
    assert.equal(r.ok, false); assert.match((r as { reason: string }).reason, /does not list/);
  });
});

describe("install scripts: off unless approved, and only inside the sandbox port", () => {
  class Scripts implements InstallScriptPort {
    runs: { dir: string; entry: string; phase: string }[] = []; behave: (dir: string) => void = (dir) => writeFileSync(join(dir, "built.txt"), "built");
    async run(r: { dir: string; entry: string; phase: string }): Promise<void> { this.runs.push(r); this.behave(r.dir); }
  }
  const scripted = { scripts: { install: "setup.js", postinstall: "post.js" }, files: { "setup.js": "1", "post.js": "2" } };

  test("a package that declares scripts but was approved without them: the trial reports it, nothing runs, and a reload does not run them either", async () => {
    const port = new Scripts(); const w = world({ scripts: port }); const a = w.add("native", "1.0.0", scripted);
    const t = await trialOf(w, a, false);
    assert.deepEqual(t, { ok: true, digestVerified: true, scriptsDeclared: true, scriptsRan: false });
    const r = await reloadOf(w, 2, [ref(a)], spec(a, false));
    assert.equal(r.ok, true);
    assert.deepEqual(port.runs, [], "no script ran in the trial or in the reload");
    assert.equal(existsSync(join(w.runtime.environments.revisionDir(AGENT, 2), "packages", "native", "built.txt")), false);
  });

  test("approved with scripts: they run in the trial and in the reload (in order), the result is part of the revision, and a later revision keeps it without running them again", { skip: POSIX_STORE }, async () => {
    const port = new Scripts(); const w = world({ scripts: port }); const a = w.add("native", "1.0.0", scripted);
    const t = await trialOf(w, a, true);
    assert.deepEqual(t, { ok: true, digestVerified: true, scriptsDeclared: true, scriptsRan: true, notes: "install scripts ran in the sandbox" });
    assert.deepEqual(port.runs.map((r) => r.phase), ["install", "postinstall"]);
    assert.ok(!port.runs[0]!.dir.startsWith(join(w.root, "agents")), "the trial ran in a disposable directory");
    port.runs.length = 0;
    assert.equal((await reloadOf(w, 2, [ref(a)], spec(a, true))).ok, true);
    assert.deepEqual(port.runs.map((r) => r.phase), ["install", "postinstall"]);
    const dir = join(w.runtime.environments.revisionDir(AGENT, 2), "packages", "native");
    assert.equal(readFileSync(join(dir, "built.txt"), "utf8"), "built");
    const rec = await w.runtime.environments.record(AGENT, 2);
    assert.equal(rec!.packages[0]!.scriptsRan, true);
    port.runs.length = 0;
    const b = w.add("plain");
    assert.equal((await reloadOf(w, 3, [ref(a), ref(b)], spec(b, false))).ok, true);
    assert.deepEqual(port.runs, [], "a package built earlier is not built again");
    assert.equal(readFileSync(join(w.runtime.environments.revisionDir(AGENT, 3), "packages", "native", "built.txt"), "utf8"), "built", "its built tree is carried into the new revision");
    // Tampering with the installed result is found.
    writeFileSync(join(dir, "built.txt"), "tampered");
    const v = await w.runtime.validate({ requestId: "m", agentId: AGENT, revision: 3, manifest: manifest([ref(a), ref(b)]), checkpointId: "c" });
    assert.equal(v.ok, true, "revision 3 has its own copy");
    writeFileSync(join(w.runtime.environments.revisionDir(AGENT, 3), "packages", "native", "built.txt"), "tampered");
    const v2 = await w.runtime.validate({ requestId: "m", agentId: AGENT, revision: 3, manifest: manifest([ref(a), ref(b)]), checkpointId: "c" });
    assert.equal(v2.ok, false); assert.match((v2 as { reason: string }).reason, /changed after it was installed/);
  });

  test("approved with scripts on a host with no sandbox port: refused in the trial and in the reload, nothing installed", async () => {
    const w = world(); const a = w.add("native", "1.0.0", scripted);
    const t = await trialOf(w, a, true);
    assert.equal(t.ok, false); assert.match((t as { reason: string }).reason, /no sandbox/);
    const r = await reloadOf(w, 2, [ref(a)], spec(a, true));
    assert.equal(r.ok, false); assert.match((r as { reason: string }).reason, /no sandbox/);
    assert.equal(await w.runtime.environments.active(AGENT), undefined);
    assert.equal(existsSync(w.runtime.environments.revisionDir(AGENT, 2)), false);
    noTemp(w.root);
  });

  test("a failing script, and a script that leaves a link, a set-user-ID file or too much behind, fail the change with the environment untouched", { skip: POSIX_STORE }, async () => {
    for (const [label, behave] of [
      ["fails", () => { throw new Error("boom"); }],
      ["symlink", (dir: string) => symlinkSync("/etc/passwd", join(dir, "link"))],
      ["setuid", (dir: string) => { writeFileSync(join(dir, "su"), "x"); chmodSync(join(dir, "su"), 0o4755); }],
      ["too big", (dir: string) => writeFileSync(join(dir, "fill"), "x".repeat(2 * 1024 * 1024))],
    ] as const) {
      const port = new Scripts(); port.behave = behave; const w = world({ scripts: port }); const a = w.add("native", "1.0.0", scripted);
      const base = await reloadOf(w, 1, []);
      assert.equal(base.ok, true);
      const m = manifest([ref(a)], { limits: { cpus: 1, memoryMb: 100, diskMb: 1, processes: 10 } });
      const r = await w.runtime.reload({ requestId: "m", agentId: AGENT, revision: 2, manifest: m, checkpointId: "cp", change: spec(a, true) });
      assert.equal(r.ok, false, label);
      assert.equal(await w.runtime.environments.active(AGENT), 1, `${label}: the earlier revision is still active`);
      assert.equal(existsSync(w.runtime.environments.revisionDir(AGENT, 2)), false, `${label}: no half-built revision`);
      noTemp(w.root);
    }
  });
});

describe("failure injection", () => {
  test("a worker that cannot take the revision puts the switch back", async () => {
    const w = world(); const a = w.add("a"); const b = w.add("b");
    assert.equal((await reloadOf(w, 2, [ref(a)], spec(a))).ok, true);
    w.worker.failRestart = "no memory";
    const r = await reloadOf(w, 3, [ref(a), ref(b)], spec(b));
    assert.equal(r.ok, false); assert.match((r as { reason: string }).reason, /could not be restarted/);
    assert.equal(await w.runtime.environments.active(AGENT), 2, "back on the previous revision");
    w.worker.failRestart = undefined;
    assert.equal((await reloadOf(w, 3, [ref(a), ref(b)], spec(b))).ok, true, "the same revision can be tried again");
  });

  test("a failure at every named point leaves the store whole and the active revision as it was; a retry succeeds", async () => {
    for (const point of ["store:written", "store:before-rename", "env:built", "env:before-switch"]) {
      let armed = false;
      const w = world({ failpoint: (name) => { if (armed && name === point) throw new Error(`injected at ${name}`); } });
      const base = w.add("base-pkg"); const a = w.add("a");
      assert.equal((await reloadOf(w, 1, [ref(base)], spec(base))).ok, true);
      armed = true;
      const r = await reloadOf(w, 2, [ref(base), ref(a)], spec(a));
      assert.equal(r.ok, false, point);
      assert.equal(await w.runtime.environments.active(AGENT), 1, `${point}: still revision 1`);
      assert.equal((await w.runtime.environments.verify(AGENT, 1)).revision, 1);
      for (const digest of await w.runtime.store.list()) await w.runtime.store.get(digest);
      armed = false;
      assert.equal((await reloadOf(w, 2, [ref(base), ref(a)], spec(a))).ok, true, `${point}: retried`);
      assert.equal(await w.runtime.environments.active(AGENT), 2);
      noTemp(w.root);
    }
  });

  test("a disk that fills up (a failed write, or too little room) fails the change cleanly", async () => {
    let writes = 0; let limit = Infinity; let free: number | undefined;
    const io = { writeFile: async (p: string, d: Uint8Array, m: number) => { if (++writes > limit) { const e = new Error("no space left on device") as NodeJS.ErrnoException; e.code = "ENOSPC"; throw e; } return realIo.writeFile(p, d, m); }, freeBytes: async () => free };
    const w = world({ io }); const a = w.add("a", "1.0.0", { files: { "one": "1", "two": "2", "three": "3" } });
    limit = 3; // the metadata file, one file, then the disk is full
    const r = await reloadOf(w, 2, [ref(a)], spec(a));
    assert.equal(r.ok, false); assert.match((r as { reason: string }).reason, /disk (is full|filled up)/);
    assert.deepEqual(await w.runtime.store.list(), []);
    assert.equal(await w.runtime.environments.active(AGENT), undefined);
    noTemp(w.root);
    limit = Infinity; free = 100; // a pre-check refuses before writing
    const t = await trialOf(w, a);
    assert.equal(t.ok, false); assert.match((t as { reason: string }).reason, /not enough free disk space/);
    free = undefined; writes = 0; limit = 7; // the store succeeds (5 writes), the environment write runs out
    const r2 = await reloadOf(w, 2, [ref(a)], spec(a));
    limit = Infinity;
    assert.equal(r2.ok, false); assert.match((r2 as { reason: string }).reason, /disk (is full|filled up)/);
    assert.equal(await w.runtime.environments.active(AGENT), undefined);
    noTemp(w.root);
    assert.equal((await reloadOf(w, 2, [ref(a)], spec(a))).ok, true, "and it works once there is room");
  });

  test("the environment's own disk limit is enforced", async () => {
    const w = world(); const a = w.add("heavy", "1.0.0", { files: { "blob": "x".repeat(1_500_000) } });
    const r = await w.runtime.reload({ requestId: "m", agentId: AGENT, revision: 2, manifest: manifest([ref(a)], { limits: { cpus: 1, memoryMb: 100, diskMb: 1, processes: 10 } }), checkpointId: "c", change: spec(a) });
    assert.equal(r.ok, false); assert.match((r as { reason: string }).reason, /disk limit of 1 MB/);
    assert.equal(existsSync(w.runtime.environments.revisionDir(AGENT, 2)), false);
  });

  test("two changes at once to one agent run one after the other, and the link is never dangling or mixed", async () => {
    const w = world(); const a = w.add("a"); const b = w.add("b"); const c = w.add("c");
    assert.equal((await reloadOf(w, 1, [ref(a)], spec(a))).ok, true);
    // A second runtime on the same directory stands for a second process of the host.
    const other = new LocalEnvironmentRuntime({ root: w.root, worker: hooks(new Worker()), source: w.source });
    const seen = new Set<number>(); let stop = false;
    const watcher = (async () => { while (!stop) { const rev = await w.runtime.environments.active(AGENT); assert.ok(rev !== undefined); seen.add(rev); await w.runtime.environments.verify(AGENT, rev); await new Promise((r) => setImmediate(r)); } })();
    const results = await Promise.all([reloadOf(w, 2, [ref(a), ref(b)], spec(b)), other.reload({ requestId: "m", agentId: AGENT, revision: 3, manifest: manifest([ref(a), ref(c)]), checkpointId: "c", change: spec(c) }), reloadOf(w, 4, [ref(a), ref(b), ref(c)], spec(c))]);
    stop = true; await watcher;
    assert.ok(results.every((r) => r.ok), JSON.stringify(results));
    const active = await w.runtime.environments.active(AGENT);
    assert.ok([2, 3, 4].includes(active!), `a real revision is active: ${String(active)}`);
    await w.runtime.environments.verify(AGENT, active!);
    assert.ok([...seen].every((r) => [1, 2, 3, 4].includes(r)));
    assert.equal(existsSync(join(w.runtime.environments.agentDir(AGENT), "lock")), false, "the lock is released");
    noTemp(w.root);
  });

  test("a lock left by a dead process is taken over; one held by a live process makes the second writer give up", async () => {
    const w = world(); const a = w.add("a");
    const lock = join(w.runtime.environments.agentDir(AGENT), "lock");
    mkdirSync(lock, { recursive: true }); writeFileSync(join(lock, "owner"), "2147483646-lock");
    assert.equal((await reloadOf(w, 1, [ref(a)], spec(a))).ok, true);
    mkdirSync(lock); writeFileSync(join(lock, "owner"), `${process.ppid}-lock`);
    const impatient = new LocalEnvironmentRuntime({ root: w.root, worker: hooks(new Worker()), source: w.source, lockWaitMs: 150 });
    const r = await impatient.reload({ requestId: "m", agentId: AGENT, revision: 2, manifest: manifest([ref(a)]), checkpointId: "c" });
    assert.equal(r.ok, false); assert.match((r as { reason: string }).reason, /still running/);
    rmSync(lock, { recursive: true });
  });

  test("a revision number names one manifest: an active one is not rebuilt for other packages, an inactive one is replaced", async () => {
    const w = world(); const a = w.add("a"); const b = w.add("b");
    assert.equal((await reloadOf(w, 1, [ref(a)], spec(a))).ok, true);
    const r = await reloadOf(w, 1, [ref(b)], spec(b));
    assert.equal(r.ok, false); assert.match((r as { reason: string }).reason, /active one/);
    assert.equal((await reloadOf(w, 2, [ref(a)], spec(a))).ok, true);
    assert.equal((await reloadOf(w, 1, [ref(b)], spec(b))).ok, true, "revision 1 is no longer active, so it may be rebuilt");
    assert.deepEqual(readdirSync(join(w.runtime.environments.revisionDir(AGENT, 1), "packages")), ["b"]);
  });
});

describe("a crash of the process itself (SIGKILL at a named point)", () => {
  const dist = new URL("./index.js", import.meta.url).href;
  const child = async (point: string, root: string, bytesFile: string, meta: string): Promise<number | null> => {
    const { spawnSync } = await import("node:child_process");
    const code = `
      import { readFileSync } from "node:fs";
      import { LocalEnvironmentRuntime } from ${JSON.stringify(dist)};
      const f = JSON.parse(process.argv[1]); const bytes = readFileSync(process.argv[2]);
      const w = { restart: async () => {}, session: async () => ({ sessionIntact: true, compactionIntact: true }) };
      const rt = new LocalEnvironmentRuntime({ root: process.argv[3], worker: w, source: { fetch: async () => bytes }, failpoint: (n) => { if (n === ${JSON.stringify(point)}) process.kill(process.pid, "SIGKILL"); } });
      const m = { base: f.base, packages: [{ name: f.name, version: f.version, digest: f.digest }], limits: { cpus: 1, memoryMb: 1, diskMb: 100, processes: 1 }, protectedExtensions: [] };
      await rt.reload({ requestId: "m", agentId: "agent:ann", revision: 2, manifest: m, checkpointId: "c", change: { name: f.name, version: f.version, digest: f.digest, source: "https://registry.example.org/x.tgz", installScripts: false } });
    `;
    return spawnSync(process.execPath, ["--input-type=module", "-e", code, meta, bytesFile, root], { timeout: 60_000 }).signal === "SIGKILL" ? 9 : null;
  };
  for (const point of ["store:before-rename", "env:built", "env:before-switch"]) {
    test(`killed at ${point}: the next start finds a whole store and the old revision active, cleans up, and the change can be made`, async () => {
      const w = world(); const base = w.add("base-pkg"); const a = w.add("tool");
      assert.equal((await reloadOf(w, 1, [ref(base)], spec(base))).ok, true);
      const file = join(fresh("bytes"), "tool.tgz"); writeFileSync(file, w.source.files.get(url("tool"))!);
      assert.equal(await child(point, w.root, file, JSON.stringify({ base: BASE, name: a.name, version: a.version, digest: a.digest })), 9, "the child was killed");
      assert.ok(readdirSync(join(w.root, "tmp")).length > 0 || point === "env:before-switch", "a crash leaves working directories behind");
      const again = new LocalEnvironmentRuntime({ root: w.root, worker: hooks(new Worker()), source: w.source });
      assert.ok(await again.recover() >= 0);
      noTemp(w.root);
      assert.equal(await again.environments.active(AGENT), 1);
      await again.environments.verify(AGENT, 1);
      for (const d of await again.store.list()) await again.store.get(d);
      const r = await again.reload({ requestId: "m", agentId: AGENT, revision: 2, manifest: manifest([ref(base), ref(a)]), checkpointId: "c", change: spec(a) });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(await again.environments.active(AGENT), 2);
    });
  }
});

describe("security", () => {
  test("agent ids, package names, versions and digests that could name a path are refused", async () => {
    const w = world(); const a = w.add("a");
    for (const agentId of ["../x", "a/b", "..", "", "agent:../../x", "a\0b", "x".repeat(200)]) {
      const r = await w.runtime.reload({ requestId: "m", agentId, revision: 1, manifest: manifest([]), checkpointId: "c" });
      assert.equal(r.ok, false, JSON.stringify(agentId));
    }
    for (const bad of [{ name: "../evil", version: "1.0.0" }, { name: "a/b", version: "1.0.0" }, { name: "@scope/../x", version: "1.0.0" }, { name: "ok", version: "../1" }, { name: "ok", version: "1.0.0", digest: "sha256:../../../x" }]) {
      const claim = { ...a, ...bad };
      const r = await reloadOf(w, 1, [{ name: claim.name, version: claim.version, digest: claim.digest }], { ...claim, installScripts: false });
      assert.equal(r.ok, false, JSON.stringify(bad));
    }
    for (const revision of [-1, 1.5, Number.NaN, 2 ** 40]) assert.equal((await reloadOf(w, revision, [])).ok, false);
    assert.deepEqual(readdirSync(w.runtime.root).sort(), ["agents", "store", "tmp", "trials"].filter((d) => existsSync(join(w.runtime.root, d))).sort());
    assert.equal(existsSync(join(dirname(w.root), "x")), false);
    assert.equal(encodeName("@scope/pkg"), "@scope%2Fpkg".replace("@", "%40"));
  });

  test("a scoped package name is a single directory", async () => {
    const w = world(); const a = w.add("@acme/tool");
    assert.equal((await reloadOf(w, 1, [ref(a)], spec(a))).ok, true);
    assert.deepEqual(readdirSync(join(w.runtime.environments.revisionDir(AGENT, 1), "packages")), ["%40acme%2Ftool"]);
  });

  test("a stored package changed on disk (a file edited, a link planted, a bit set) is never used", async () => {
    for (const [label, tamper] of [
      ["edited", (dir: string) => writeFileSync(join(dir, "index.js"), "evil()")],
      ["link", (dir: string) => symlinkSync("/etc/passwd", join(dir, "planted"))],
      ["setuid", (dir: string) => { chmodSync(join(dir, "index.js"), 0o4755); }],
    ] as const) {
      const w = world(); const a = w.add("a");
      assert.equal((await trialOf(w, a)).ok, true);
      const tree = join(w.root, "store", a.digest.slice(7), "tree");
      chmodSync(tree, 0o755); chmodSync(join(tree, "index.js"), 0o644);
      tamper(tree);
      const r = await reloadOf(w, 1, [ref(a)], spec(a));
      // The damaged copy is replaced by a freshly verified one from the source, or refused when there is none: either way the tampering is not installed.
      if (r.ok) { assert.equal(readFileSync(join(w.runtime.environments.revisionDir(AGENT, 1), "packages", "a", "index.js"), "utf8"), "module.exports = 1;\n", label); assert.equal(existsSync(join(w.runtime.environments.revisionDir(AGENT, 1), "packages", "a", "planted")), false); }
      else assert.match(r.reason, /changed after|safe tree|corrupt/);
      const bare = new LocalEnvironmentRuntime({ root: w.root, worker: hooks(new Worker()) });
      tamper(tree); 
      const again = await bare.reload({ requestId: "m", agentId: "agent:bob", revision: 1, manifest: manifest([ref(a)]), checkpointId: "c" });
      assert.equal(again.ok, false, label);
    }
  });

  test("an environment changed on disk after it was built is found by validate, and a forged active link is refused", async () => {
    const w = world(); const a = w.add("a");
    assert.equal((await reloadOf(w, 1, [ref(a)], spec(a))).ok, true);
    const dir = join(w.runtime.environments.revisionDir(AGENT, 1), "packages", "a");
    symlinkSync("/etc", join(dir, "etc-link"));
    const v = await w.runtime.validate({ requestId: "m", agentId: AGENT, revision: 1, manifest: manifest([ref(a)]), checkpointId: "c" });
    assert.equal(v.ok, false);
    rmSync(join(dir, "etc-link"));
    mkdirSync(join(w.runtime.environments.revisionDir(AGENT, 1), "packages", "smuggled"));
    assert.equal((await w.runtime.validate({ requestId: "m", agentId: AGENT, revision: 1, manifest: manifest([ref(a)]), checkpointId: "c" })).ok, false, "an extra package directory is not in the record");
    rmSync(join(w.runtime.environments.revisionDir(AGENT, 1), "packages", "smuggled"), { recursive: true });
    const link = join(w.runtime.environments.agentDir(AGENT), "active");
    rmSync(link); symlinkSync("/etc", link);
    await assert.rejects(() => w.runtime.environments.active(AGENT), /points somewhere it should not/);
    assert.equal((await w.runtime.validate({ requestId: "m", agentId: AGENT, revision: 1, manifest: manifest([ref(a)]), checkpointId: "c" })).ok, false);
    await assert.rejects(() => w.runtime.activePackages(AGENT));
  });

  test("validate reports a revision other than the active one and a worker that cannot say", async () => {
    const w = world(); const a = w.add("a");
    assert.equal((await reloadOf(w, 1, [ref(a)], spec(a))).ok, true);
    assert.equal((await w.runtime.validate({ requestId: "m", agentId: AGENT, revision: 2, manifest: manifest([ref(a)]), checkpointId: "c" })).ok, false);
    w.worker.session = { sessionIntact: false, compactionIntact: true };
    assert.deepEqual(await w.runtime.validate({ requestId: "m", agentId: AGENT, revision: 1, manifest: manifest([ref(a)]), checkpointId: "c" }), { ok: true, sessionIntact: false, compactionIntact: true });
    const throwing = new LocalEnvironmentRuntime({ root: w.root, worker: { session: async () => { throw new Error("worker gone"); } }, source: w.source });
    assert.equal((await throwing.validate({ requestId: "m", agentId: AGENT, revision: 1, manifest: manifest([ref(a)]), checkpointId: "c" })).ok, false);
  });

  test("the offline mirror refuses paths out of the mirror, links and oversized files", async () => {
    const mirror = fresh("mirror"); const secret = join(fresh("secret"), "secret.tgz"); writeFileSync(secret, "top secret");
    mkdirSync(join(mirror, "registry.example.org", "pkg"), { recursive: true });
    writeFileSync(join(mirror, "registry.example.org", "pkg", "a.tgz"), "abc");
    symlinkSync(secret, join(mirror, "registry.example.org", "pkg", "link.tgz"));
    symlinkSync(dirname(secret), join(mirror, "registry.example.org", "dir"));
    const src = directoryArtifactSource(mirror);
    assert.equal(Buffer.from(await src.fetch("https://registry.example.org/pkg/a.tgz?x=1#y", 100)).toString(), "abc");
    for (const bad of ["https://registry.example.org/pkg/../../../../etc/passwd", "https://registry.example.org/%2e%2e/%2e%2e/x", "https://registry.example.org/pkg/link.tgz", "https://registry.example.org/dir/secret.tgz", "https://registry.example.org/pkg/a%2F..%2Fa.tgz", "https://registry.example.org/pkg/%5Ca.tgz", "http://registry.example.org/pkg/a.tgz", "https://u:p@registry.example.org/pkg/a.tgz", "file:///etc/passwd", "not a url", "https://registry.example.org//pkg/a.tgz", "https://registry.example.org/pkg/"]) {
      await assert.rejects(() => src.fetch(bad, 100), SourceError, bad);
    }
    await assert.rejects(() => src.fetch("https://registry.example.org/pkg/a.tgz", 2), /most accepted/);
  });

  test("the https source fetches only allowed hosts, follows no redirect, and stops reading at the limit", async () => {
    const calls: { url: string; redirect: string | undefined }[] = [];
    const body = (chunks: string[], headers: Record<string, string> = {}): Response => new Response(new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(Buffer.from(x)); c.close(); } }), { headers });
    const f = (async (u: URL, init: RequestInit) => { calls.push({ url: String(u), redirect: init.redirect }); return String(u).includes("big") ? body(["aaaa", "bbbb", "cccc"]) : String(u).includes("declared") ? body(["x"], { "content-length": "9999" }) : String(u).includes("gone") ? new Response("no", { status: 404 }) : body(["ok"]); }) as unknown as typeof fetch;
    const src = httpsArtifactSource({ fetch: f, hosts: ["registry.example.org"] });
    assert.equal(Buffer.from(await src.fetch("https://registry.example.org/a.tgz", 10)).toString(), "ok");
    assert.equal(calls[0]!.redirect, "error");
    await assert.rejects(() => src.fetch("https://evil.example.com/a.tgz", 10), /not a host/);
    await assert.rejects(() => src.fetch("https://registry.example.org/big.tgz", 6), /larger than/);
    await assert.rejects(() => src.fetch("https://registry.example.org/declared.tgz", 10), /9999 bytes/);
    await assert.rejects(() => src.fetch("https://registry.example.org/gone.tgz", 10), /404/);
    assert.equal(calls.length, 4, "the refused host never reached the network");
    // In the offline test run the platform fetch is blocked, so a source that was given none cannot reach anything.
    await assert.rejects(() => httpsArtifactSource({ hosts: ["registry.example.org"] }).fetch("https://registry.example.org/a.tgz", 10));
  });
});

describe("the host's support check and the agent's view of its environment", () => {
  test("a host that cannot have a runtime says why and gets none", () => {
    const data = fresh("data");
    assert.match(localEnvironmentHost({ root: join(fresh("e"), "x"), worker: hooks(new Worker()), platform: "darwin" }).problem ?? "", /only on Linux/);
    assert.match(localEnvironmentHost({ root: join(data, "environments"), worker: hooks(new Worker()), protectedPaths: [data], platform: "linux" }).problem ?? "", /overlaps the protected path/);
    assert.match(localEnvironmentHost({ root: dirname(data), worker: hooks(new Worker()), protectedPaths: [data], platform: "linux" }).problem ?? "", /overlaps/);
    const file = join(fresh("f"), "file"); writeFileSync(file, "x");
    assert.match(localEnvironmentHost({ root: file, worker: hooks(new Worker()), platform: "linux" }).problem ?? "", /could not be prepared/);
    const real = fresh("real"); const link = join(fresh("l"), "link"); symlinkSync(real, link);
    assert.match(localEnvironmentHost({ root: link, worker: hooks(new Worker()), platform: "linux" }).problem ?? "", /could not be prepared/);
    assert.equal(hostEnvironmentsBase("/srv/nn/data"), "/srv/nn/data.environments");
    assert.equal(hostEnvironmentsBase("/srv/nn/data/"), "/srv/nn/data.environments");
  });

  // A real host on this machine: the product refuses one off Linux ("supported only on Linux so far", host.ts), so this runs on Linux only (the refusal itself is checked above).
  test("the agent's sandbox gets its verified active packages read-only under /opt/environment, and nothing else", { skip: process.platform !== "linux" && "the local environment host is Linux only (environment/host.ts)" }, async () => {
    const data = fresh("data"); const root = hostEnvironmentsBase(data);
    const worker = new Worker(); const source = new Source();
    const host = localEnvironmentHost({ root, worker: hooks(worker), source, protectedPaths: [data] });
    assert.equal(host.problem, undefined);
    const rt = host.runtime!; const a = fixture({ name: "tool", version: "1.0.0" }); source.files.set(url("tool"), a.bytes);
    assert.deepEqual(await host.reach("environment", { agentId: AGENT }), {}, "no active revision: an empty grant");
    assert.equal(await host.reach("other", { agentId: AGENT }), undefined, "other names are not answered here");
    assert.equal((await rt.reload({ requestId: "m", agentId: AGENT, revision: 1, manifest: manifest([ref(a)]), checkpointId: "c", change: spec({ ...a, source: url("tool") }) })).ok, true);
    const grant = await host.reach("environment", { agentId: AGENT });
    assert.equal(grant!.readOnly!.length, 1);
    assert.equal(grant!.readOnly![0]!.guest, "/opt/environment");
    assert.equal(grant!.readOnly![0]!.host, realpathSync(join(rt.environments.revisionDir(AGENT, 1), "packages")));
    assert.ok(grant!.readOnly![0]!.host.startsWith(rt.root));
    assert.deepEqual(grant!.env, { NN_ENVIRONMENT: "/opt/environment" });
    // An environment changed on disk is not handed to an agent.
    writeFileSync(join(grant!.readOnly![0]!.host, "tool", "index.js"), "evil()");
    await assert.rejects(() => host.reach("environment", { agentId: AGENT }));
    assert.equal(existsSync(join(data, "environments")), false, "nothing was made inside the data directory");
    assert.deepEqual(readdirSync(data), []);
  });
});

describe("install scripts in the real sandbox", () => {
  let launcher: SandboxLauncher; let usable = false;
  const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
  before(async () => {
    launcher = await SandboxLauncher.create({ protectedPaths: [], audit: () => undefined });
    usable = launcher.capacity.available && launcher.capacity.backend === "bubblewrap" && !["/usr", "/bin", "/lib"].includes(nodeRoot);
    if (!usable && required && process.platform === "linux") assert.fail(`the sandbox is required but unusable: ${launcher.capacity.reason}`);
  });
  const ifUsable = (name: string, fn: () => Promise<void>): void => { test(name, async (t) => { if (!usable) return t.skip(`bubblewrap or a node install it can mount is unusable: ${launcher.capacity.reason ?? nodeRoot}`); await fn(); }); };

  ifUsable("an approved script builds inside its package directory and sees nothing else: no network, no host files, an empty environment", async () => {
    process.env["NN_A09_SECRET"] = "must-not-leak";
    try {
      const host = fresh("host"); writeFileSync(join(host, "host-secret.txt"), "secret");
      const base = fresh("scratch");
      const scripts = sandboxInstallScripts({ launcher, interpreter: { root: nodeRoot, executable: "bin/node" }, base, requireEnforced: false, timeoutMs: 30_000 });
      const w = world({ scripts });
      const setup = `
        const fs = process.getBuiltinModule("fs"); const net = process.getBuiltinModule("net");
        const seen = { env: Object.keys(process.env).sort(), cwd: process.cwd(), host: fs.existsSync(${JSON.stringify(join(host, "host-secret.txt"))}), listing: fs.readdirSync("/").sort() };
        fs.writeFileSync("built.json", JSON.stringify(seen));
        fs.writeFileSync("generated.txt", "made by the script");
        const c = net.connect(80, "192.0.2.1"); c.on("error", (e) => { fs.writeFileSync("net.txt", String(e.code)); }); c.on("connect", () => fs.writeFileSync("net.txt", "connected"));
        setTimeout(() => process.exit(0), 600);
      `;
      const a = w.add("native", "1.0.0", { scripts: { install: "setup.js" }, files: { "setup.js": setup } });
      const t = await trialOf(w, a, true);
      assert.equal(t.ok, true, JSON.stringify(t)); assert.equal((t as { scriptsRan: boolean }).scriptsRan, true);
      const r = await reloadOf(w, 1, [ref(a)], spec(a, true));
      assert.equal(r.ok, true, JSON.stringify(r));
      const dir = join(w.runtime.environments.revisionDir(AGENT, 1), "packages", "native");
      const seen = JSON.parse(readFileSync(join(dir, "built.json"), "utf8")) as { env: string[]; cwd: string; host: boolean; listing: string[] };
      assert.equal(readFileSync(join(dir, "generated.txt"), "utf8"), "made by the script");
      assert.equal(seen.cwd, "/work"); assert.equal(seen.host, false);
      assert.ok(!seen.env.includes("NN_A09_SECRET"), "the service's environment is not inherited");
      assert.ok(!seen.listing.includes("srv"), "the host's directories are not visible");
      assert.notEqual(readFileSync(join(dir, "net.txt"), "utf8"), "connected", "no network");
      assert.deepEqual(readdirSync(base), [], "the script's home and scratch are removed");
      assert.equal((await scanTree(dir)).entries.length >= 4, true);
      assert.equal((await w.runtime.validate({ requestId: "m", agentId: AGENT, revision: 1, manifest: manifest([ref(a)]), checkpointId: "c" })).ok, true);
      assert.equal(lstatSync(host).isDirectory(), true);
    } finally { delete process.env["NN_A09_SECRET"]; }
  });

  ifUsable("a script that fails, runs too long, writes a link or tries to change something outside its directory fails the change", async () => {
    const outside = fresh("outside");
    for (const [label, code] of [
      ["fails", `process.exit(3)`],
      ["slow", `setTimeout(()=>{}, 60000)`],
      ["link", `process.getBuiltinModule("fs").symlinkSync("/etc/passwd", "evil")`],
      ["setuid", `const fs=process.getBuiltinModule("fs"); fs.writeFileSync("su","x"); fs.chmodSync("su", 0o4755)`],
      ["outside", `process.getBuiltinModule("fs").writeFileSync(${JSON.stringify(join(outside, "pwned"))}, "x")`],
    ] as const) {
      const base = fresh("scratch");
      const scripts = sandboxInstallScripts({ launcher, interpreter: { root: nodeRoot, executable: "bin/node" }, base, requireEnforced: false, timeoutMs: label === "slow" ? 1500 : 30_000 });
      const w = world({ scripts }); const a = w.add("native", "1.0.0", { scripts: { install: "setup.js" }, files: { "setup.js": code } });
      const r = await reloadOf(w, 1, [ref(a)], spec(a, true));
      assert.equal(r.ok, false, `${label}: ${JSON.stringify(r)}`);
      assert.equal(await w.runtime.environments.active(AGENT), undefined, label);
      assert.equal(existsSync(join(outside, "pwned")), false, label);
      assert.deepEqual(readdirSync(base), [], `${label}: scratch removed`);
      noTemp(w.root);
    }
  });
});
