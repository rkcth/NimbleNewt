import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdmissionService } from "../admission/index.js";
import { findAnchors } from "../context/anchor.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI, ScriptedWorker, EXEC_PROFILES, ROUTING_TABLE, workGrants } from "../dispatch/testing/world.js";
import type { WorkOrder } from "../dispatch/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { HostService } from "../hosts/index.js";
import { PolicyService } from "../policy/index.js";
import { DifficultyService } from "../routing/index.js";
import { startController } from "./index.js";

// W12 second review: the owner's switch and cap for the goal anchor, through the composed controller (the plan `dispatch-compose.ts` gives the dispatcher reads the stored settings). The dispatcher's own tests give it a plan of their
// own, so nothing else showed that the owner's "off" and "at most N characters", set through the API the chat uses, reach the next start; or that a damaged settings record leaves the attempt starting without a block.
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("the owner's cap and off switch, set through the API, reach the next start's anchor; a damaged settings record starts the attempt without one (W12 second review)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-w12-start-"));
  const orders: WorkOrder[] = [];
  const worker = new ScriptedWorker("host:w1", async (ctx) => { orders.push((ctx as { order: WorkOrder }).order); return { status: "completed", text: "the worker stopped" }; });
  const errors: string[] = [];
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], onInternalError: (e: unknown) => { errors.push(String((e as Error)?.message ?? e)); },
    dispatch: { timer: new ManualTimer(), manual: true, local: { window: () => 32768, acceptUnenforcedLimits: true, build: () => worker } },
  } as never);
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    const call = (op: string, args: Record<string, unknown>, commandId: string) => c.api.handle(boot.token, { v: 1, op, commandId, args } as never) as Promise<any>;
    await s.routing.setTable(rob, { commandId: "rt", expectedRevision: 0, table: { ...ROUTING_TABLE, roles: { coordinator: "r-cloud", "safety-supervisor": "r-cloud" } } } as never);
    await DifficultyService.withEpoch(c.storage, c.epoch, s.routing, s.contracts).setProfiles(rob, { commandId: "sp", expectedRevision: 0, profiles: EXEC_PROFILES } as never);
    await s.principals.enroll(rob, { commandId: "e-host", kind: "host", name: "w1", grants: [] });
    const hostP = await s.principals.authenticate((await s.principals.issueCredential(rob, "host:w1")).token);
    const hosts = HostService.withEpoch(c.storage, c.epoch, s.assignments);
    await hosts.announce(hostP, { commandId: "an", capabilities: { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] } });
    await hosts.heartbeat(hostP, { commandId: "hb", sequence: 1 });
    await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap", actor: rob.id, host: "host:w1", capacity: { cpus: 8, memoryMb: 16_384 } });
    await PolicyService.withEpoch(c.storage, c.epoch, s.grants).set(rob, { scope: "installation", commandId: "pol", profile: "autonomous" } as never);
    const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const annId = (await s.agents.create(rob, { commandId: "ag-a", friendlyName: "ann" })).id;
    for (const g of workGrants(project)) await s.grants.grant(rob, { commandId: `g-${g.action}`, grantee: `agent:${annId}`, action: g.action, project, source: "direct", basis: "test" });
    // A long criteria list, so the owner's smaller cap visibly shortens the block.
    const taskId = (await s.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Water the beds" })).id;
    await s.contracts.setContract(rob, { commandId: "ct", taskId, expectedVersion: 0, expectedResult: "Every bed is wet.", acceptanceCriteria: Array.from({ length: 12 }, (_, i) => `bed ${i + 1} is wet to ${"a finger's depth ".repeat(8)}`) } as never);
    await s.projects.transitionTask({ commandId: "r1", actor: rob.id, taskId, expectedRevision: 1, to: "ready" });
    await s.assignments.assignTask({ commandId: "as1", actor: rob.id, taskId, owner: { kind: "agent", id: annId } });
    let n = 0;
    const start = async (): Promise<WorkOrder> => {
      const a = (await s.assignments.getAssignment(taskId))!;
      await s.assignments.admitAttempt({ commandId: `ad-${++n}`, actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: annId }, harness: "pi" });
      const before = orders.length;
      for (let i = 0; i < 6; i++) { await c.dispatch!.dispatcher.tick(); await c.dispatch!.dispatcher.idle(); }
      assert.equal(orders.length, before + 1, "the attempt started");
      return orders.at(-1)!;
    };

    // Default: on, at most 2,400 characters (the route's 4 percent of 32,768 tokens is more).
    const first = await start();
    const one = findAnchors(first.content);
    assert.equal(one.length, 1);
    assert.ok(first.content.startsWith(one[0]!.text));
    assert.equal(first.contract?.anchorDigest, one[0]!.digest);
    assert.ok(one[0]!.text.length > 1000 && one[0]!.text.length <= 2400, `${one[0]!.text.length}`);

    // The owner's cap, through the API the chat uses: the next start's block is within it.
    assert.equal((await call("context.route.change", { set: { anchorChars: 1000 } }, "cap-1000")).ok, true);
    const second = await start();
    const two = findAnchors(second.content);
    assert.equal(two.length, 1);
    assert.equal(second.contract?.anchorDigest, two[0]!.digest);
    assert.ok(two[0]!.text.length <= 1000, `${two[0]!.text.length} characters under a cap of 1,000`);
    assert.equal((await c.dispatch!.dispatcher.get(rob, second.attemptId))?.anchors?.at(-1)?.maxChars, 1000);

    // The owner's off switch: the next start has no block and its contract names none.
    assert.equal((await call("context.route.change", { disable: ["anchor"] }, "off")).ok, true);
    const third = await start();
    assert.deepEqual(findAnchors(third.content), []);
    assert.equal(third.contract?.anchorDigest, undefined);
    assert.ok(third.content.startsWith("Water the beds"), "it starts as before the card: the task's own text first");

    // Back on, then the stored record is damaged: the attempt still starts, without a block, and the failure is reported.
    assert.equal((await call("context.route.change", { unset: ["anchor", "anchorChars"] }, "on")).ok, true);
    const ref = { kind: "ctx-route-settings", id: "main" };
    const rec = (await c.storage.getAggregate(ref))!;
    await c.storage.applyOperation({ operationId: "dmg", epoch: c.epoch, actor: "owner:rob", correlationId: "dmg", at: new Date().toISOString(), changes: [{ type: "update", ref, expectedRevision: rec.revision, body: { anchor: "yes" } }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
    errors.length = 0;
    const fourth = await start();
    assert.deepEqual(findAnchors(fourth.content), []);
    assert.equal(fourth.contract?.anchorDigest, undefined);
    assert.ok(errors.some((e) => /context route setting is damaged/.test(e)), JSON.stringify(errors));
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
