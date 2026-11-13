import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { EventService } from "../events/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
type Reply = { ok: boolean; result?: any; error?: { code: string } };

test("through the running controller: an event wakes a responsibility, its check becomes one bounded task for the answerable agent, a restart after a long absence records a gap, and what happened while it was down is read on return (card P04f)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-p04f-"));
  const open = () => startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], dispatch: { timer: new ManualTimer(), intervalMs: 1000 } });
  let c = await open();
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const owner = await c.services.principals.authenticate(boot.token);
    await c.services.principals.enroll(owner, { commandId: "e-ann", kind: "agent", name: "ann", grants: [{ action: "task.read", project: "*" }] });
    const call = (op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<Reply>;
    const project = (await call("project.create", { name: "Ops" }, "p1")).result.id as string;
    const duty = (await call("responsibility.create", { projectId: project, title: "Keep web up", objective: "Up", desiredCondition: "web answers", everyMinutes: 1440, ownerId: "agent:ann", eventSources: ["svc-health"], permittedActions: ["service.restart"], escalation: { to: "owner" } }, "r1")).result.id as string;
    const publish = async (seq: number): Promise<void> => { await EventService.withEpoch(c.storage, c.epoch).publish(owner, { commandId: `ev-${seq}-${Math.random()}`, stream: `project:${project}`, kind: "service.failed", ref: { kind: "service", id: "web" }, key: `k${seq}`, source: { id: "svc-health", seq } } as never); };
    const tickN = async (n = 3): Promise<void> => { for (let i = 0; i < n; i++) await c.dispatch!.dispatcher.tick(); };

    await tickN(2);
    assert.deepEqual((await call("responsibility.checks", { projectId: project })).result.items, [], "nothing is owed before anything happened");
    await publish(1);
    await tickN();
    const owed = (await call("responsibility.checks", { projectId: project })).result.items as any[];
    assert.equal(owed.length, 1);
    assert.deepEqual([owed[0].trigger.source, owed[0].trigger.events, owed[0].run.how], ["svc-health", 1, "task"]);
    const tasks = await c.storage.listAggregates("task", { limit: 20 });
    assert.deepEqual(tasks.map((t) => [(t.body as any).title, t.id === owed[0].run.taskId]), [["Check: Keep web up", true]]);
    const assignment = (await c.storage.listAggregates("assignment", { limit: 20 })).map((a) => (a.body as any).owner);
    assert.deepEqual(assignment, [{ kind: "agent", id: "ann" }]);
    await tickN();
    assert.equal((await c.storage.listAggregates("task", { limit: 20 })).length, 1, "more ticks make no more tasks");
    const history = (await call("responsibility.history", { responsibilityId: duty })).result.items as any[];
    assert.deepEqual(history.map((h) => [h.kind, h.taskId === owed[0].run.taskId]), [["note", true]]);
    assert.equal((await call("responsibility.observed", { responsibilityId: duty })).result.item.observed, "unknown", "no check entry yet: not healthy");

    // The owner's choice, over the API.
    assert.equal((await call("check.settings.set", { enabled: false }, "s1")).ok, true);
    assert.deepEqual((await call("check.settings.get", {})).result.item.effective, { enabled: false, maxOpen: 5 });
    assert.equal((await call("check.settings.set", { enabled: true, maxOpen: 0 }, "s2")).error?.code, "invalid_command");
    // Review: bad values are refused whatever their type, and the queries refuse readers without the right.
    for (const [i, bad] of ([{ maxOpen: Number.NaN }, { maxOpen: "5" }, { maxOpen: 51 }, { maxOpen: 2.5 }, { enabled: "true" }, { enabled: true, expectedRevision: "1" }, { enabled: true, extra: 1 }] as Record<string, unknown>[]).entries()) assert.equal((await call("check.settings.set", bad, `bad-${i}`)).error?.code, "invalid_command", JSON.stringify(bad));
    for (const bad of [{ limit: "abc" }, { limit: 0 }, { limit: 201 }, { limit: Number.NaN }, { open: "yes" }]) assert.equal((await call("responsibility.gaps", { projectId: project, ...bad })).error?.code, "invalid_command", JSON.stringify(bad));
    assert.equal((await call("responsibility.gaps", { projectId: project, limit: 1, open: false })).ok, true);
    const annToken = (await c.services.principals.issueCredential(owner, "agent:ann")).token;
    const asAnn = (op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(annToken, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<Reply>;
    assert.equal((await asAnn("check.settings.get", {})).error?.code, "forbidden");
    assert.equal((await asAnn("check.settings.set", { enabled: true }, "ann-s")).error?.code, "forbidden");
    assert.equal((await asAnn("responsibility.gaps", { projectId: project })).error?.code, "not_found", "no responsibility.read in the project: hidden");

    // An event arrives, then the controller stops before it looks; the saved "last seen" is moved back to a quarter of an hour ago.
    await publish(2);
    await c.close();
    c = await open();
    const rec = await c.storage.getAggregate({ kind: "coverage-liveness", id: "installation" });
    assert.ok(rec !== undefined, "the controller kept when it was last seen");
    await c.storage.applyOperation({ operationId: "age", epoch: c.epoch, actor: "owner:rob", correlationId: "age", at: new Date().toISOString(), changes: [{ type: "update", ref: { kind: "coverage-liveness", id: "installation" }, expectedRevision: rec!.revision, body: { lastSeenAt: new Date(Date.now() - 15 * 60_000).toISOString() } }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
    await c.close();
    c = await open();
    await tickN();
    const gaps = (await call("responsibility.gaps", { projectId: project })).result.items as any[];
    assert.deepEqual(gaps.map((g) => [g.reason, g.open, Date.parse(g.end) - Date.parse(g.start) > 14 * 60_000]), [["controller-down", false, true]]);
    const pending = (await call("responsibility.checks", { projectId: project })).result.items as any[];
    assert.equal(pending.length, 2, "the event that came in while it was down was read on return and owes its check");
    assert.deepEqual(pending.map((p) => p.run?.how).sort(), ["coalesced", "task"], "the new check rides on the task that is still open (that starts no agent work, so the setting being off does not matter)");
    assert.equal((await c.storage.listAggregates("task", { limit: 20 })).length, 1);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
