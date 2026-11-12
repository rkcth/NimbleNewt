import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { AgentEnvironments, processStart, type InstallScriptPort } from "./agent-environments.js";
import { localEnvironmentHost } from "./host.js";
import { LocalEnvironmentRuntime, type RuntimeManifest, type WorkerHooks } from "./runtime.js";
import type { ArtifactSource } from "./sources.js";
import { ContentStore } from "./store.js";
import { fixture } from "./testing/tar.js";

/** The tests below that build real revisions run where the runtime does: it is Linux only (host.ts), and on Windows its store's links, locks and renames behave otherwise. */
const POSIX_STORE = process.platform === "win32" && "the environment runtime is Linux only (host.ts refuses it elsewhere); its store's links, locks and renames are POSIX";

// Clean-context review of the A09 fourth slice: each test here failed on the reviewed code.
const top = realpathSync(mkdtempSync(join(tmpdir(), "nn-a09rv-")));
after(() => rmSync(top, { recursive: true, force: true }));
let n = 0;
const fresh = (label: string): string => { const d = join(top, `${label}-${n++}`); mkdirSync(d, { recursive: true }); return d; };
const AGENT = "agent:ann";
const manifest = (packages: { name: string; version: string; digest: string }[]): RuntimeManifest => ({ base: { name: "b", version: "1.0.0", digest: `sha256:${"1".repeat(64)}` }, packages, limits: { cpus: 1, memoryMb: 1024, diskMb: 500, processes: 100 }, protectedExtensions: [] });
const ref = (f: { name: string; version: string; digest: string }) => ({ name: f.name, version: f.version, digest: f.digest });
const url = (name: string): string => `https://registry.example.org/${name}.tgz`;

class Scripts implements InstallScriptPort {
  runs: string[] = [];
  async run(r: { dir: string; phase: string; packageName: string }): Promise<void> { this.runs.push(`${r.packageName}:${r.phase}`); writeFileSync(join(r.dir, "built.txt"), "built"); }
}

function world(scripts?: InstallScriptPort) {
  const files = new Map<string, Uint8Array>();
  const source: ArtifactSource = { async fetch(s) { const f = files.get(s); if (f === undefined) throw new Error("not in the fake registry"); return f; } };
  const worker = { fail: undefined as string | undefined };
  const hooks: WorkerHooks = { restart: async () => { if (worker.fail !== undefined) throw new Error(worker.fail); }, session: async () => ({ sessionIntact: true, compactionIntact: true }) };
  const runtime = new LocalEnvironmentRuntime({ root: join(fresh("env"), "environments"), worker: hooks, source, ...(scripts === undefined ? {} : { scripts }) });
  const add = (name: string, extra: { scripts?: Record<string, string>; files?: Record<string, string> } = {}, installScripts = false) => { const f = fixture({ name, version: "1.0.0", ...extra }); files.set(url(name), f.bytes); return { ...f, source: url(name), installScripts }; };
  const reload = (revision: number, packages: { name: string; version: string; digest: string }[], change?: ReturnType<typeof add>) =>
    runtime.reload({ requestId: "m", agentId: AGENT, revision, manifest: manifest(packages), checkpointId: "c", ...(change === undefined ? {} : { change }) });
  return { runtime, worker, add, reload };
}

describe("review: a worker that cannot take a revision leaves the links exactly as they were", () => {
  test("on the agent's first revision the switch is undone too (no revision stays active)", async () => {
    const w = world(); const a = w.add("a");
    w.worker.fail = "no memory";
    const r = await w.reload(1, [ref(a)], a);
    assert.equal(r.ok, false);
    assert.equal(await w.runtime.environments.active(AGENT), undefined, "the revision the worker refused is not left active");
    assert.equal(await w.runtime.activePackages(AGENT), undefined, "and no agent is given its packages");
  });

  test("the previous revision is put back even when it no longer verifies, and `previous` keeps what it named", { skip: POSIX_STORE }, async () => {
    const w = world(); const a = w.add("a"); const b = w.add("b"); const c = w.add("c");
    assert.equal((await w.reload(1, [ref(a)], a)).ok, true);
    assert.equal((await w.reload(2, [ref(a), ref(b)], b)).ok, true);
    // Revision 2 is damaged on disk after it was activated; the change to revision 3 is refused by the worker.
    writeFileSync(join(w.runtime.environments.revisionDir(AGENT, 2), "packages", "a", "index.js"), "changed");
    w.worker.fail = "no memory";
    const r = await w.reload(3, [ref(a), ref(b), ref(c)], c);
    assert.equal(r.ok, false);
    assert.equal(await w.runtime.environments.active(AGENT), 2, "the link names what was active before the reload, not the refused revision");
    assert.equal(await w.runtime.environments.active(AGENT, "previous"), 1, "previous is what it was");
  });
});

describe("review: the agent lock across processes", () => {
  test("two writers that both find a dead owner's lock never both hold it", { skip: POSIX_STORE }, async () => {
    for (let round = 0; round < 40; round++) {
      const root = fresh("lock");
      const store = new ContentStore({ root });
      const writers = [0, 1, 2, 3].map(() => new AgentEnvironments({ root, store, lockWaitMs: 5000 }));
      const lock = join(writers[0]!.agentDir(AGENT), "lock");
      mkdirSync(lock, { recursive: true }); writeFileSync(join(lock, "owner"), "2147483646-lock");
      let inside = 0; let most = 0;
      const work = async (): Promise<void> => { inside++; most = Math.max(most, inside); await new Promise((r) => setTimeout(r, 30)); inside--; };
      await Promise.all(writers.map((e) => e.withLock(AGENT, work)));
      assert.equal(most, 1, `round ${round}: at most one writer holds the lock`);
      assert.equal(existsSync(lock), false, "released");
    }
  });

  test("a lock directory whose owner was never written (a crash right after making it) does not block the agent for ever", { skip: POSIX_STORE }, async () => {
    const root = fresh("lock");
    const envs = new AgentEnvironments({ root, store: new ContentStore({ root }), lockWaitMs: 300 });
    const lock = join(envs.agentDir(AGENT), "lock");
    mkdirSync(lock, { recursive: true });
    const old = new Date(Date.now() - 60_000); utimesSync(lock, old, old);
    assert.equal(await envs.withLock(AGENT, async () => "ran"), "ran");
  });
});

describe("review: what an install script built is carried into later revisions and trials", () => {
  test("from any earlier revision of the agent, not only the active and previous ones; and the trial builds the other packages as the agent has them", { skip: POSIX_STORE }, async () => {
    const port = new Scripts(); const w = world(port);
    const a = w.add("native", { scripts: { install: "setup.js" }, files: { "setup.js": "1" } }, true); const b = w.add("b"); const c = w.add("c"); const d = w.add("d");
    assert.equal((await w.reload(1, [ref(a)], a)).ok, true);
    assert.deepEqual(port.runs, ["native:install"]); port.runs.length = 0;
    assert.equal((await w.reload(2, [ref(b)], b)).ok, true, "a revision without the package");
    assert.equal((await w.reload(3, [ref(c)], c)).ok, true, "and another: revision 1 is neither active nor previous now");
    assert.equal((await w.reload(4, [ref(a), ref(c)])).ok, true, "the package comes back (an owner's rollback of the manifest)");
    assert.deepEqual(port.runs, [], "no script ran again");
    const built = join(w.runtime.environments.revisionDir(AGENT, 4), "packages", "native", "built.txt");
    assert.equal(existsSync(built), true, "what the script built is in the new revision");
    assert.equal((await w.runtime.environments.record(AGENT, 4))!.packages.find((p) => p.name === "native")!.scriptsRan, true);
    // A trial for another package builds the agent's scripted package with its built files (the disposable copy is checked through the disk limit: the trial would otherwise build a different environment than the reload).
    const t = await w.runtime.trial({ requestId: "t", agentId: AGENT, kind: "package", artifact: d, installScripts: false, candidate: manifest([ref(a), ref(c), ref(d)]) });
    assert.equal(t.ok, true, JSON.stringify(t));
    assert.deepEqual(port.runs, [], "the trial ran no script of a package it did not change");
  });
});

describe("review: a tree with a second name for a file", () => {
  test("an install script that leaves a hard link fails the change, and the agent keeps what it had", { skip: POSIX_STORE }, async () => {
    const port: InstallScriptPort = { async run(r) { linkSync(join(r.dir, "setup.js"), join(r.dir, "alias.js")); } };
    const w = world(port); const plain = w.add("plain");
    assert.equal((await w.reload(1, [ref(plain)], plain)).ok, true);
    const a = w.add("native", { scripts: { install: "setup.js" }, files: { "setup.js": "1" } }, true);
    const r = await w.reload(2, [ref(plain), ref(a)], a);
    assert.equal(r.ok, false); assert.match((r as { reason: string }).reason, /more than one name/);
    assert.equal(await w.runtime.environments.active(AGENT), 1);
  });
});

describe("review: a lock whose owner's pid now names another process", () => {
  test("is taken over (the start time differs), also when the pid is this process's own (a restarted host in a container)", async () => {
    const root = fresh("lock");
    const envs = new AgentEnvironments({ root, store: new ContentStore({ root }), lockWaitMs: 300 });
    const lock = join(envs.agentDir(AGENT), "lock");
    const parentStart = processStart(process.ppid);
    if (parentStart !== undefined) {
      mkdirSync(lock, { recursive: true }); writeFileSync(join(lock, "owner"), `${process.ppid}-lock-${Number(parentStart) + 1}-${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}`);
      assert.equal(await envs.withLock(AGENT, async () => "ran"), "ran", "a live pid started at another time does not hold the lock");
      mkdirSync(lock, { recursive: true }); writeFileSync(join(lock, "owner"), `${process.ppid}-lock-${parentStart}-${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}`);
      await assert.rejects(() => envs.withLock(AGENT, async () => "ran"), /still running/, "the same process still holds it");
      rmSync(lock, { recursive: true });
    }
    const ownStart = processStart(process.pid);
    if (ownStart !== undefined) {
      mkdirSync(lock, { recursive: true }); writeFileSync(join(lock, "owner"), `${process.pid}-lock-${Number(ownStart) + 1}-${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}`);
      assert.equal(await envs.withLock(AGENT, async () => "ran"), "ran", "this pid's lock from an earlier process is not this process's");
    }
  });
});

describe("review: the host's environments directory", () => {
  test("a root reached through a link into the data directory is refused before anything is made there", () => {
    const data = fresh("data");
    const parent = fresh("p"); const link = join(parent, "via"); symlinkSync(data, link);
    const host = localEnvironmentHost({ root: join(link, "environments"), worker: { session: async () => ({ sessionIntact: true, compactionIntact: true }) }, protectedPaths: [data], platform: "linux" });
    assert.match(host.problem ?? "", /overlaps the protected path/);
    assert.equal(host.runtime, undefined);
    assert.deepEqual(readdirSync(data), [], "nothing was made inside the data directory");
  });
});
