import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { EnvironmentService } from "../environments/index.js";
import { buildWorld, workGrants, type DispatchWorld } from "./testing/world.js";

after(stopServer);

// Card A08d: the limits of the agent's environment manifest, cut by the installation's, are the limits of each launch. They travel in the dispatch contract, are recorded on the attempt, and a figure that cannot be
// worked out refuses the attempt instead of letting it run without a limit.

const D = (ch: string): string => `sha256:${ch.repeat(64)}`;
const manifest = (limits: Record<string, number>) => ({
  base: { name: "nimblenewt-base", version: "1.0.0", digest: D("a") }, packages: [], skills: [], capabilities: [], configuration: { installation: 1, agent: 1 }, limits,
  protectedExtensions: [{ name: "nimblenewt.desk", digest: D("c") }],
});
const FULL = { cpus: 2, memoryMb: 2048, diskMb: 10_000, processes: 200 };

for (const backend of backends) {
  interface Ctx extends DispatchWorld { run(): Promise<Awaited<ReturnType<DispatchWorld["dispatcher"]["tick"]>>>; env: EnvironmentService }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const store = await backend.open();
      try {
        const w = await buildWorld(store.storage);
        const env = EnvironmentService.withEpoch(w.storage, w.epoch, { ...w.options, reservedDigest: async (n) => (n === "nimblenewt.desk" ? D("c") : undefined), skillUsable: async () => false });
        const c: Ctx = Object.assign(w, { env, run: async () => { const r = await c.dispatcher.tick(); await c.dispatcher.idle(); return r; } });
        await body(c);
      } finally { await store.close(); }
    });
  const give = async (c: Ctx, agent: string, limits: Record<string, number>): Promise<void> => {
    await c.env.change(c.owner, { commandId: `ec-${agent}`, agentId: `agent:${agent}`, manifest: manifest(limits), reason: "first" });
    await c.env.activate(c.owner, { commandId: `ea-${agent}`, agentId: `agent:${agent}`, revision: 1, observed: { "nimblenewt.desk": D("c") } });
  };
  const started = (c: Ctx) => c.worker.starts.at(-1)!;

  suite("the environment's figures reach the worker in the dispatch contract and the attempt records whose each is", async (c) => {
    const ann = await c.agent("ann", workGrants(c.project, []));
    await give(c, "ann", { ...FULL, wallTimeMs: 600_000 });
    c.dispatcher = c.restart({ environments: c.env });
    const { attemptId } = await c.task("a", ann);
    await c.run();
    assert.deepEqual(started(c).contract!.limits, { ...FULL, wallTimeMs: 600_000 });
    const body = (await c.dispatcher.get(c.owner, attemptId!))!;
    assert.deepEqual(body.launchLimits!.limits, { ...FULL, wallTimeMs: 600_000 });
    assert.deepEqual(Object.values(body.launchLimits!.sources), ["environment", "environment", "environment", "environment", "environment"]);
    assert.equal(body.launchLimits!.environmentRevision, 1);
    assert.equal(body.launchLimits!.capped, undefined);
  });

  suite("the installation's figures cut an environment that asks for more and fill what it does not state; an environment never raises a limit", async (c) => {
    const ann = await c.agent("ann", workGrants(c.project, []));
    await give(c, "ann", FULL); // a manifest made before wallTimeMs existed: no time limit of its own
    c.dispatcher = c.restart({ environments: c.env, launchDefaults: async () => ({ cpus: 1, memoryMb: 4096, wallTimeMs: 3_600_000 }) });
    const { attemptId } = await c.task("a", ann);
    await c.run();
    // cpus: the installation's 1 is smaller than the environment's 2; memory: the environment's 2048 is smaller than 4096; wall time: only the installation states one.
    assert.deepEqual(started(c).contract!.limits, { cpus: 1, memoryMb: 2048, diskMb: 10_000, processes: 200, wallTimeMs: 3_600_000 });
    const rec = (await c.dispatcher.get(c.owner, attemptId!))!.launchLimits!;
    assert.deepEqual(rec.sources, { cpus: "installation", memoryMb: "environment", diskMb: "environment", processes: "environment", wallTimeMs: "installation" });
    assert.deepEqual(rec.capped, [{ limit: "cpus", asked: 2, applied: 1 }]);
  });

  suite("an agent with no environment gets the installation's limits; with neither, the contract carries no limits as before", async (c) => {
    const ann = await c.agent("ann", workGrants(c.project, []));
    const bob = await c.agent("bob", workGrants(c.project, []));
    c.dispatcher = c.restart({ environments: c.env, launchDefaults: async () => ({ memoryMb: 1024 }) });
    const a = await c.task("a", ann);
    await c.run();
    assert.deepEqual(started(c).contract!.limits, { memoryMb: 1024 });
    assert.deepEqual((await c.dispatcher.get(c.owner, a.attemptId!))!.launchLimits!.sources, { memoryMb: "installation" });
    c.dispatcher = c.restart({ environments: c.env });
    const b = await c.task("b", bob);
    await c.run();
    assert.equal(started(c).contract!.limits, undefined);
    assert.equal((await c.dispatcher.get(c.owner, b.attemptId!))!.launchLimits, undefined);
  });

  suite("a figure of the installation that is not valid, or a setting that cannot be read, refuses the attempt with a blocker and starts nothing", async (c) => {
    for (const [i, bad] of [{ memoryMb: Number.NaN }, { cpus: 1.5 }, { processes: 0 }, { diskMb: Number.MAX_SAFE_INTEGER }, { wallTimeMs: 5 }, { nope: 1 } as never, "x" as never].entries()) {
      const agent = await c.agent(`ag${i}`, workGrants(c.project, []));
      c.dispatcher = c.restart({ launchDefaults: async () => bad });
      const before = c.worker.starts.length;
      const { taskId, attemptId } = await c.task(`t${i}`, agent);
      const report = await c.run();
      assert.equal(c.worker.starts.length, before, `${JSON.stringify(bad)}: no worker was started`);
      assert.deepEqual(report.started, [], JSON.stringify(bad));
      assert.equal((await c.dispatcher.get(c.owner, attemptId!))!.state, "finished");
      const blocker = await c.blockers.openFor("dispatch_blocked", { kind: "task", id: taskId });
      assert.match(blocker?.summary ?? "", /limits of this launch could not be worked out/, JSON.stringify(bad));
    }
    const dan = await c.agent("dan", workGrants(c.project, []));
    c.dispatcher = c.restart({ launchDefaults: async () => { throw new Error("the setting is damaged"); } });
    const before = c.worker.starts.length;
    const t = await c.task("unreadable", dan);
    await c.run();
    assert.equal(c.worker.starts.length, before);
    const blocker = await c.blockers.openFor("dispatch_blocked", { kind: "task", id: t.taskId });
    assert.match(blocker?.summary ?? "", /the setting is damaged/);
    // The refusal does not loop: later passes start nothing for the refused task and open no second blocker (no further attempt starts by itself).
    for (let i = 0; i < 3; i++) assert.deepEqual((await c.run()).started, []);
    assert.equal(c.worker.starts.length, before);
    assert.equal((await c.blockers.openFor("dispatch_blocked", { kind: "task", id: t.taskId }))?.id, blocker?.id);
    assert.equal((await c.dispatcher.get(c.owner, t.attemptId!))!.state, "finished");
  });

  suite("a manifest figure outside what a launch can carry refuses the attempt", async (c) => {
    const ann = await c.agent("ann", workGrants(c.project, []));
    await give(c, "ann", { ...FULL, cpus: 300 }); // valid in a manifest (up to 4096), more than any launch can be given (256)
    c.dispatcher = c.restart({ environments: c.env });
    const before = c.worker.starts.length;
    const { taskId } = await c.task("a", ann);
    await c.run();
    assert.equal(c.worker.starts.length, before);
    assert.match((await c.blockers.openFor("dispatch_blocked", { kind: "task", id: taskId }))?.summary ?? "", /cpus must be a whole number from 1 to 256 \(cores\)/);
  });

  suite("the host's launch report is kept on the attempt: which limits were enforced in full, in part or not at all", async (c) => {
    const ann = await c.agent("ann", workGrants(c.project, []));
    await give(c, "ann", FULL);
    c.dispatcher = c.restart({ environments: c.env });
    const { attemptId } = await c.task("a", ann);
    await c.run();
    await c.dispatcher.noteLaunch({ attemptId: attemptId!, outcome: "started", bestEffort: true, enforcement: [{ limit: "memoryMb", value: 2048, enforced: "full", by: "cgroup", detail: "MemoryMax" }, { limit: "diskMb", value: 10_000, enforced: "partial", detail: "per-file cap" }, { limit: "processes", value: 200, enforced: "none", detail: "no scope" }] });
    const rec = (await c.dispatcher.get(c.owner, attemptId!))!.launchLimits!;
    assert.deepEqual(rec.enforcement!.map((e) => `${e.limit}:${e.enforced}`), ["memoryMb:full", "diskMb:partial", "processes:none"]);
    assert.equal(rec.outcome, "started");
    assert.equal(rec.bestEffort, true);
    assert.deepEqual(rec.limits, FULL, "the figures given stay beside the report");
    assert.equal(rec.environmentRevision, 1);
    // A report of an attempt nobody knows changes nothing.
    await c.dispatcher.noteLaunch({ attemptId: "att-aaaaaaaaaaaaaaaaaaaa", outcome: "refused", bestEffort: false, enforcement: [] });
  });
}
