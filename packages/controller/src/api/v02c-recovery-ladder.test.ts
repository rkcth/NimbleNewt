import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ManualTimer } from "../dispatch/testing/timer.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { CHAT_OPS } from "../chat/commands.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("the owner sets which recovery actions are allowed at which level, and switches agents' recovery steps on and off: owner only, bounded, race-safe, replay-safe; chat shows changes first (card V02c)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-recovery-"));
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [],
    dispatch: { timer: new ManualTimer(), manual: true },
  } as never);
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "agt-abcdefghijklmnopqrst", grants: [] });
    const ann = (await c.services.principals.issueCredential(rob, "agent:agt-abcdefghijklmnopqrst")).token;
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string } }>;
    const first = (await call(boot.token, "recovery.ladder.get", {})).result.item;
    assert.deepEqual([first.revision, first.enabled, first.levels], [0, true, []]);
    assert.deepEqual(first.defaults.first, ["nudge", "rebrief", "hand-to-owner"]);
    for (const op of ["recovery.ladder.get"]) assert.equal((await call(ann, op, {})).error?.code, "forbidden");
    for (const [i, op] of ["recovery.ladder.set", "recovery.ladder.enable", "recovery.ladder.disable"].entries()) assert.equal((await call(ann, op, op.endsWith("set") ? { enabled: false } : {}, `a${i}`)).error?.code, "forbidden", op);
    assert.equal((await call(ann, "recovery.step", { concernId: "stl-x", expectedRevision: 1, action: "nudge", text: "hi" }, "s0")).error?.code, "not_found", "a concern nobody can see reads like a missing one");
    const bad: Record<string, unknown>[] = [{}, { levels: "nudge" }, { levels: [["fly"]] }, { levels: [["nudge"], "x"] }, { levels: Array.from({ length: 17 }, () => []) }, { owner: [3] }, { enabled: "yes" }, { levels: [], extra: 1 }];
    for (const [i, args] of bad.entries()) assert.equal((await call(boot.token, "recovery.ladder.set", args, `b${i}`)).error?.code, "invalid_command", JSON.stringify(args));
    assert.equal((await call(boot.token, "recovery.ladder.get", {})).result.item.revision, 0, "refused sets change nothing");
    const set = await call(boot.token, "recovery.ladder.set", { levels: [["nudge"], ["nudge", "pause", "pause"]], owner: ["stop"] }, "r1");
    assert.ok(set.ok, JSON.stringify(set));
    const got = (await call(boot.token, "recovery.ladder.get", {})).result.item;
    assert.deepEqual([got.levels, got.owner, got.enabled], [[["nudge"], ["nudge", "pause"]], ["stop"], true]);
    assert.equal((await call(boot.token, "recovery.ladder.set", { levels: [["nudge"], ["nudge", "pause", "pause"]], owner: ["stop"] }, "r1")).result.revision, set.result.revision, "the same command ID is the same change");
    assert.equal((await call(boot.token, "recovery.ladder.set", { levels: [] }, "r1")).error?.code, "command_conflict");
    assert.equal((await call(boot.token, "recovery.ladder.disable", { expectedRevision: 0 }, "r2")).error?.code, "stale_revision");
    assert.ok((await call(boot.token, "recovery.ladder.disable", { expectedRevision: set.result.revision }, "r3")).ok);
    const off = (await call(boot.token, "recovery.ladder.get", {})).result.item;
    assert.deepEqual([off.enabled, off.levels], [false, got.levels], "disabling keeps the levels");
    assert.ok((await call(boot.token, "recovery.ladder.enable", {}, "r4")).ok);
    assert.equal((await call(boot.token, "recovery.ladder.get", {})).result.item.enabled, true);
    assert.ok((await call(boot.token, "recovery.ladder.set", { levels: [] }, "r5")).ok);
    const cleared = (await call(boot.token, "recovery.ladder.get", {})).result.item;
    assert.deepEqual([cleared.levels, cleared.owner], [[], ["stop"]], "an empty list clears the levels and leaves the other fields");
    assert.equal(CHAT_OPS["recovery.ladder.set"]?.mode, "propose");
    assert.equal(CHAT_OPS["recovery.ladder.enable"]?.mode, "propose", "widening is shown first");
    assert.ok(CHAT_OPS["recovery.ladder.disable"], "chat can switch it off");
  } finally {
    await c.close();
    rmSync(d, { recursive: true, force: true });
  }
});

test("end to end with the real effects: a supervisor's steps nudge, reassign and pause the concern's task (not the agent), the effect is keyed by the step so a retry under a new command does it once, and a repeat is answered as recorded (card V02c review)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-recovery-e2e-"));
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [],
    dispatch: { timer: new ManualTimer(), manual: true },
  } as never);
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const names = { ann: "agt-aaaaaaaaaaaaaaaaaaaa", bob: "agt-bbbbbbbbbbbbbbbbbbbb", boss: "agt-cccccccccccccccccccc" };
    for (const [k, n] of Object.entries(names)) await c.services.principals.enroll(rob, { commandId: `e-${k}`, kind: "agent", name: n, grants: [] });
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const task = (await c.services.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Build" })).id;
    await c.services.projects.transitionTask({ commandId: "r1", actor: rob.id, taskId: task, expectedRevision: 1, to: "ready" });
    await c.services.assignments.assignTask({ commandId: "as", actor: rob.id, taskId: task, owner: { kind: "agent", id: names.ann } });
    // The supervisor can see and manage the task; it is not the task's owner.
    for (const a of ["task.read", "assignment.read", "assignment.manage"]) await c.services.grants.grant(rob, { commandId: `g-${a}`, grantee: `agent:${names.boss}`, action: a, project, source: "direct", basis: "test" } as never);
    const boss = (await c.services.principals.issueCredential(rob, `agent:${names.boss}`)).token;
    const generation = (await c.services.assignments.getAssignment(task))!.generation;
    const id = `stl-${task.slice(5)}-${String(generation).padStart(10, "0")}-silent`;
    const now = new Date().toISOString();
    const body = { taskId: task, projectId: project, generation, kind: "silent", state: "suspected", detail: "no news", difficulty: "medium", route: { to: { kind: "agent", id: names.boss }, via: "supervisor", reason: "supervisor" }, firstSeenAt: now, lastChangedAt: now, reopened: 0, stalledAgent: names.ann };
    await c.storage.applyOperation({ operationId: "mk", epoch: c.epoch, actor: "owner:rob", correlationId: "mk", at: now, changes: [{ type: "create", ref: { kind: "stall-concern", id }, body }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string; message?: string } }>;
    const revision = async (): Promise<number> => (await c.storage.getAggregate({ kind: "stall-concern", id }))!.revision;
    const step = async (action: string, commandId: string, more: Record<string, unknown> = {}) => call(boss, "recovery.step", { concernId: id, expectedRevision: await revision(), action, text: "please look", ...more }, commandId);
    assert.ok((await call(boot.token, "recovery.ladder.set", { levels: [["nudge", "reassign", "pause", "hand-to-owner"]] }, "lad")).ok);
    // Nudge: a real notice to the stalled agent.
    const nudge = await step("nudge", "n1");
    assert.ok(nudge.ok, JSON.stringify(nudge));
    // Reassign by a supervisor (no hand-off needed: no attempt runs), recorded as a recovery step, not a meeting.
    const move = await step("reassign", "m1", { to: `agent:${names.bob}` });
    assert.ok(move.ok, JSON.stringify(move));
    const after = (await c.services.assignments.getAssignment(task))!;
    assert.equal(after.owner?.id, names.bob);
    assert.match(String((await c.services.assignments.history(task)).at(-1)!.reason), /recovery step/);
    // Pause: the TASK is paused, not the agent's other work, and the supervisor's own rights are what the pause service checked.
    const pause = await step("pause", "p1");
    assert.ok(pause.ok, JSON.stringify(pause));
    assert.equal((await c.services.pauses.gate(rob, { kind: "task", id: task }))?.intent, "pause");
    assert.equal((await c.services.pauses.gate(rob, { kind: "agent", id: names.ann }))?.intent ?? "run", "run", "the agent's other work is not paused");
    const record = (await c.storage.getAggregate({ kind: "stall-concern", id }))!.body as any;
    assert.deepEqual(record.recoverySteps.map((x: any) => x.action), ["nudge", "reassign", "pause"]);
    assert.equal(record.stalledAgent, names.ann, "the concern still names the agent it is about, not the new holder");
    assert.equal(record.recoveryPending, undefined);
    // A repeat is answered as recorded, even after the supervisor's recovery rights are switched off.
    assert.ok((await call(boot.token, "recovery.ladder.disable", {}, "off")).ok);
    const again = await call(boss, "recovery.step", { concernId: id, expectedRevision: 1, action: "pause", text: "please look" }, "p1");
    assert.ok(again.ok, JSON.stringify(again));
    assert.equal(again.result.replayed, true);
    // The pause request was made once.
    const requests = (await c.storage.listAggregates("pause-request", { limit: 50 })).filter((r) => (r.body as any).scope.kind === "task");
    assert.equal(requests.length, 1);
  } finally {
    await c.close();
    rmSync(d, { recursive: true, force: true });
  }
});
