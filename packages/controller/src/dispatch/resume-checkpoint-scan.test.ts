import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld, workGrants, type DispatchWorld } from "./testing/world.js";
import type { DispatcherDeps } from "./dispatcher.js";

after(stopServer);

// Card L04d (finish): one tick shares one scan of the dependency records, and a resume says when the checkpoint it restores is not the one its check was made against.
const PI = (digest: string, at: number): Record<string, unknown> => ({ pi: { conversationId: 1, at, digest, runtime: { name: "pi", version: "1" }, format: 1 } });
const D1 = `sha256:${"a".repeat(64)}`;
const D2 = `sha256:${"b".repeat(64)}`;

for (const backend of backends) {
  const suite = (name: string, body: (c: DispatchWorld) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const store = await backend.open();
      try { await body(await buildWorld(store.storage)); } finally { await store.close(); }
    });

  suite("the dispatcher gives every task of one tick the same scan, and a new one for the next tick", async (c) => {
    const ann = await c.agent("ann", workGrants(c.project, []));
    await c.task("first", ann);
    await c.task("second", ann);
    const seen: (Map<string, unknown> | undefined)[] = [];
    const d = c.restart({ prerequisites: async (_id, scan) => { seen.push(scan); return []; } });
    c.worker.script = async () => ({ status: "completed", text: "done" });
    await d.tick();
    await d.idle();
    assert.ok(seen.length >= 2, "both tasks were asked about");
    assert.ok(seen[0] instanceof Map);
    assert.ok(seen.every((s) => s === seen[0]), "one scan for the whole tick");
    const first = seen[0];
    seen.length = 0;
    await d.tick();
    await d.idle();
    if (seen.length > 0) assert.notEqual(seen[0], first, "the next tick starts a fresh scan");
  });

  suite("prerequisitesOf with a scan reads the project's dependency records once, and the prerequisite states fresh", async (c) => {
    const ann = await c.agent("ann", workGrants(c.project, []));
    const a = await c.task("needs", ann);
    const b = await c.task("base", ann);
    const e = await c.task("extra", ann);
    const owner = c.owner;
    await c.contracts.addDependency(owner, { commandId: "dep-1", taskId: a.taskId, prerequisiteId: b.taskId });
    const scan = new Map<string, unknown>();
    const first = await c.contracts.prerequisitesOf(a.taskId, scan);
    assert.deepEqual(first?.dependsOn.map((x) => x.taskId), [b.taskId]);
    assert.equal(scan.size, 1);
    // A dependency added after the scan is not in the shared scan (it is in the next tick's), but is read without one.
    await c.contracts.addDependency(owner, { commandId: "dep-2", taskId: a.taskId, prerequisiteId: e.taskId });
    assert.deepEqual((await c.contracts.prerequisitesOf(a.taskId, scan))?.dependsOn.map((x) => x.taskId), [b.taskId]);
    assert.deepEqual((await c.contracts.prerequisitesOf(a.taskId))?.dependsOn.map((x) => x.taskId).sort(), [b.taskId, e.taskId].sort());
    // The state of a prerequisite is never taken from the scan.
    const before = (await c.contracts.prerequisitesOf(a.taskId, scan))!.dependsOn[0]!.state;
    assert.ok(before !== undefined);
    assert.equal((await c.contracts.prerequisitesOf(`task-${"a".repeat(20)}`, scan)), undefined);
  });

  suite("a resume from a checkpoint other than the one the check is made against says so in the task's activity, once", async (c) => {
    const ann = await c.agent("ann", workGrants(c.project, []));
    const { attemptId } = await c.task("long job", ann);
    const told: string[] = [];
    const ids = new Set<string>();
    const activity: NonNullable<DispatcherDeps["activity"]> = async (s) => { if (!ids.has(s.commandId)) { ids.add(s.commandId); told.push(s.summary); } };
    let latest: { conversationId: number; at: number; digest: string } | undefined = { conversationId: 1, at: 5, digest: D1 };
    const resumes: NonNullable<DispatcherDeps["resumes"]> = {
      start: async () => ({ id: "rck-1", revision: 1, body: undefined, phase: "reviewing" }) as never,
      commit: async () => ({ id: "rck-1", phase: "done" }) as never,
      advance: async () => { throw new Error("not used"); }, forTask: async () => undefined, get: async () => undefined, checkIdFor: (_by, k) => `rck-${k}`, retryable: async () => false, exhausted: () => false, cancelledAsStale: () => false,
      retry: async () => { throw new Error("not used"); }, cancel: async () => { throw new Error("not used"); },
      hasContinuation: async () => true,
      latestCheckpoint: async () => latest,
    };
    let release!: () => void;
    const gate = { promise: new Promise<void>((r) => { release = r; }) };
    c.worker.script = async ({ worker }) => { worker.checkpoint = async () => PI(D2, 9) as never; await gate.promise; return { status: "completed", text: "late" }; };
    let d = c.restart({ resumes, activity });
    await d.tick();
    await d.shutdown();
    release();
    await d.idle();
    d = c.restart({ resumes, activity });
    await d.tick();
    await d.tick();
    await d.idle();
    const said = told.filter((t) => /has no complete capture/.test(t));
    assert.equal(said.length, 1, `one step (one command ID), however many ticks: ${JSON.stringify(told)}`);
    assert.match(said[0]!, new RegExp(`${attemptId}`));
    assert.match(said[0]!, /taken at 9 in conversation 1/);
    assert.match(said[0]!, /taken at 5 in conversation 1/);
    // The same checkpoint: nothing is said.
    told.length = 0;
    ids.clear();
    latest = { conversationId: 1, at: 9, digest: D2 };
    d = c.restart({ resumes, activity });
    await d.tick();
    await d.idle();
    assert.equal(told.filter((t) => /has no complete capture/.test(t)).length, 0);
  });
}
