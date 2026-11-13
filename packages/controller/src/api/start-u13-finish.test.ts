import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { EventService } from "../events/index.js";
import { startController } from "./index.js";
import { COMMAND_STATES, jobCommandState, stopCommandState } from "./command-state.js";
import { JOB_STATES } from "../jobs/jobs.js";
import { PI } from "../dispatch/testing/world.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const open = (file: string) => startController({ storage: { kind: "sqlite", path: file }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [] });

test("an event subscription made through the state API keeps its cursor across a restart of the controller, and pulls go on from the last acknowledged event (card U13)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-u13ev-"));
  const file = join(d, "c.sqlite");
  let c = await open(file);
  let token = "";
  let project = "";
  let sub = "";
  const publish = (events: EventService, owner: never, stream: string, n: number) => events.publish(owner, { commandId: `pb${n}`, stream, kind: "task.updated", ref: { kind: "task", id: `task-aaaaaaaaaaaaaaaaaaa${"abcdefgh"[n]!}` } } as never);
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    token = boot.token;
    const owner = await c.services.principals.authenticate(token);
    project = (await c.services.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
    const stream = `project:${project}`;
    const call = async (tok: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(tok, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const events = EventService.withEpoch(c.storage, c.epoch);
    for (let i = 0; i < 3; i++) await publish(events, owner as never, stream, i);
    const made = await call(token, "events.subscribe", { stream, fromStart: true, batch: 2 }, "sub1");
    assert.equal(made.ok, true, JSON.stringify(made));
    sub = made.result.id;
    assert.equal((await call(token, "events.subscribe", { stream, fromStart: true, batch: 2 }, "sub1")).result.id, sub, "a repeat answers as recorded");
    const first = await call(token, "events.pull", { subscriptionId: sub });
    assert.deepEqual(first.result.item.events.map((e: { seq: number }) => e.seq), [1, 2], JSON.stringify(first));
    assert.equal(first.result.item.through, 2);
    // Pulling changes nothing: the same batch again until it is acknowledged.
    assert.deepEqual((await call(token, "events.pull", { subscriptionId: sub })).result.item.events.map((e: { seq: number }) => e.seq), [1, 2]);
    assert.deepEqual((await call(token, "events.acknowledge", { subscriptionId: sub, through: 2 }, "ack1")).result, { cursor: 2 });
    assert.deepEqual((await call(token, "events.acknowledge", { subscriptionId: sub, through: 1 }, "ack0")).result, { cursor: 2 }, "an old acknowledgement never moves the cursor back");
    assert.equal((await call(token, "events.acknowledge", { subscriptionId: sub, through: 99 }, "ack-far")).error.code, "invalid_command");
    assert.equal((await call(token, "events.heartbeat", { subscriptionId: sub }, "hb1")).result.ok, true);
    const trace = await call(token, "events.trace", { stream, from: 2, limit: 5 });
    assert.deepEqual(trace.result.items.map((e: { seq: number }) => e.seq), [2, 3]);
    // Another agent may neither read nor move the owner's subscription, nor subscribe to a project it cannot read.
    await c.services.principals.enroll(owner, { commandId: "e-ann", kind: "agent", name: "ann", grants: [] });
    const ann = (await c.services.principals.issueCredential(owner, "agent:ann")).token;
    assert.equal((await call(ann, "events.pull", { subscriptionId: sub })).error.code, "forbidden");
    assert.equal((await call(ann, "events.acknowledge", { subscriptionId: sub, through: 3 }, "ann-ack")).error.code, "forbidden");
    assert.equal((await call(ann, "events.status", { subscriptionId: sub })).error.code, "forbidden");
    assert.equal((await call(ann, "events.subscribe", { stream }, "ann-sub")).error.code, "forbidden");
    for (const bad of [{ stream: "nope" }, { stream, batch: 0 }, { stream, kinds: "x" }, { stream, extra: 1 }]) assert.equal((await call(token, "events.subscribe", bad, "bad")).error.code, "invalid_command", JSON.stringify(bad));
  } finally { await c.close(); }
  try {
    c = await open(file);
    const call = async (tok: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(tok, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const owner = await c.services.principals.authenticate(token);
    const events = EventService.withEpoch(c.storage, c.epoch);
    const status = await call(token, "events.status", { subscriptionId: sub });
    assert.deepEqual([status.result.item.state, status.result.item.cursor], ["active", 2], "the cursor survived the restart");
    const after = await call(token, "events.pull", { subscriptionId: sub });
    assert.deepEqual(after.result.item.events.map((e: { seq: number }) => e.seq), [3], "it goes on from the last acknowledged event, not from the start");
    await publish(events, owner as never, `project:${project}`, 3);
    assert.deepEqual((await call(token, "events.pull", { subscriptionId: sub })).result.item.events.map((e: { seq: number }) => e.seq), [3, 4], "an event published after the restart is served too");
    assert.deepEqual((await call(token, "events.acknowledge", { subscriptionId: sub, through: 4 }, "ack2")).result, { cursor: 4 });
    // Cancelling is the subscriber's or the owner's, and ends pulls.
    assert.equal((await call(token, "events.cancel", { subscriptionId: sub }, "cancel1")).result.ok, true);
    assert.equal((await call(token, "events.pull", { subscriptionId: sub })).error.code, "forbidden");
    assert.equal((await call(token, "events.resume", { subscriptionId: sub }, "res1")).error.code, "forbidden", "a cancelled subscription stays cancelled");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a task credential uses only its own task's event stream, and a paused task's stream says its events wait (card U13)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-u13ev-"));
  const c = await open(join(d, "c.sqlite"));
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const owner = await c.services.principals.authenticate(boot.token);
    const call = async (tok: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(tok, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
    const t1 = (await c.services.projects.createTask({ commandId: "t1", actor: owner.id, projectId: project, title: "weed" })).id;
    const events = EventService.withEpoch(c.storage, c.epoch);
    const sub = (await call(boot.token, "events.subscribe", { stream: `task:${t1}` }, "s1")).result.id as string;
    await events.publish(owner, { commandId: "pb", stream: `task:${t1}`, kind: "task.updated", ref: { kind: "task", id: t1 } } as never);
    assert.deepEqual([(await call(boot.token, "events.pull", { subscriptionId: sub })).result.item.wake, (await call(boot.token, "events.pull", { subscriptionId: sub })).result.item.held], [true, false]);
    await c.services.pauses.pause(owner, { commandId: "pz", scope: { kind: "task", id: t1 }, reason: "look first" });
    const held = (await call(boot.token, "events.pull", { subscriptionId: sub })).result.item;
    assert.deepEqual([held.wake, held.held, held.events.length], [false, true, 1], "an event never lifts a hold: it waits");
    // The stream guard of a task credential, through the operation itself.
    const { OPERATION_BY_NAME } = await import("./operations.js");
    const ctx = { principal: { id: "agent:ann", kind: "agent", name: "ann", grants: [], taskScope: { taskId: t1, projectId: project } }, events: { subscribe: async () => ({ id: "sub-x" }), trace: async () => [] } } as never;
    await assert.rejects(() => OPERATION_BY_NAME.get("events.subscribe")!.run(ctx, { stream: `project:${project}` }, "c1"), (e: { code?: string }) => e.code === "forbidden");
    await assert.rejects(() => OPERATION_BY_NAME.get("events.trace")!.run(ctx, { stream: `project:${project}` }, undefined), (e: { code?: string }) => e.code === "forbidden");
    assert.deepEqual(await OPERATION_BY_NAME.get("events.subscribe")!.run(ctx, { stream: `task:${t1}` }, "c2"), { id: "sub-x" });
    assert.deepEqual(await OPERATION_BY_NAME.get("events.trace")!.run(ctx, { stream: `task:${t1}` }, undefined), { items: [] });
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("long-running commands use one vocabulary: the envelope says accepted or completed, and jobs and stops translate their own states without calling an unfinished or unknown one completed (card U13)", async () => {
  assert.deepEqual([...COMMAND_STATES], ["accepted", "queued", "running", "completed", "blocked", "failed", "outcome_unknown"]);
  const jobs = Object.fromEntries(JOB_STATES.map((s) => [s, jobCommandState(s)]));
  assert.deepEqual(jobs, { admitted: "queued", dispatched: "queued", running: "running", completed: "completed", failed: "failed", cancellation_requested: "running", cancelled: "failed", outcome_unknown: "outcome_unknown" });
  assert.equal(stopCommandState("preparing", 0), "running");
  assert.equal(stopCommandState("blocked", 0), "blocked");
  assert.equal(stopCommandState("recovery-required", 0), "blocked");
  assert.equal(stopCommandState("recovery-required", 1), "outcome_unknown", "a stop that ended with unresolved work (how the stop service records it) is not merely blocked: what it left is of unknown outcome");
  assert.equal(stopCommandState("done", 0), "completed");
  assert.equal(stopCommandState("done", 2), "outcome_unknown", "a stop that left an effect of unknown outcome is not completed");
  assert.equal(stopCommandState("cancelled", 0), "failed");
  assert.equal(jobCommandState("nope" as never), "outcome_unknown", "an unknown state is never read as success");
  const d = mkdtempSync(join(tmpdir(), "nn-u13cs-"));
  const c = await open(join(d, "c.sqlite"));
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const call = async (op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await call("project.create", { name: "Garden" }, "p1")).result.id as string;
    const done = await call("task.create", { projectId: project, title: "weed" }, "t1");
    assert.deepEqual([done.accepted, done.completed, done.state], [true, true, "completed"]);
    const task = done.result.id as string;
    await call("task.transition", { taskId: task, to: "ready", expectedRevision: 1 }, "t1r");
    const assigned = await call("task.assign", { taskId: task, owner: { kind: "agent", id: "ann" } }, "as1");
    assert.deepEqual([assigned.ok, assigned.accepted, assigned.completed, assigned.state], [true, true, false, "accepted"], JSON.stringify(assigned));
    assert.ok(typeof assigned.awaits === "string" && assigned.awaits.length > 0);
    assert.equal((await call("task.get", { taskId: task })).state, undefined, "reads carry no command state");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("tool activity, message references and checkpoint lists are readable through the state API with revision and provenance, and a task credential reads its own task only (card U13)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-u13rd-"));
  const c = await open(join(d, "c.sqlite"));
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (tok: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(tok, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await call(boot.token, "project.create", { name: "Garden" }, "p1")).result.id as string;
    const task = (await call(boot.token, "task.create", { projectId: project, title: "weed" }, "t1")).result.id as string;
    const other = (await call(boot.token, "task.create", { projectId: project, title: "water" }, "t2")).result.id as string;
    const agent = (await c.services.agents.create(rob, { commandId: "ag-a", friendlyName: "A" })).id;
    const pid = `agent:${agent}`;
    const f = await c.storage.getAggregate({ kind: "principal", id: pid });
    await c.services.principals.setGrants(rob, { commandId: "g1", principalId: pid, expectedRevision: f!.revision, grants: [{ action: "task.read", project }, { action: "message.read", project }] as never });
    const tok = (await c.services.principals.issueCredential(rob, pid)).token;

    // Messages: references without words, newest page by ID; the recipient sees its own, a stranger none, and a task credential of another task nothing.
    const m1 = (await call(boot.token, "message.send", { taskId: task, to: pid, class: "informational", purpose: "weather", text: "frost tonight" }, "m1")).result.id as string;
    const m2 = (await call(boot.token, "message.send", { taskId: task, to: pid, class: "informational", purpose: "soil", text: "dry soil" }, "m2")).result.id as string;
    await call(boot.token, "message.send", { taskId: other, to: pid, class: "informational", purpose: "other", text: "elsewhere" }, "m3");
    const refs = await call(boot.token, "message.references", { taskId: task });
    assert.equal(refs.ok, true, JSON.stringify(refs));
    assert.deepEqual(refs.result.items.map((i: { id: string }) => i.id).sort(), [m1, m2].sort());
    for (const i of refs.result.items) { assert.equal(i.taskId, task); assert.equal(i.to, pid); assert.ok(i.revision >= 1 && typeof i.sender === "string" && i.state === "accepted"); assert.equal(i.text, undefined, "no words in a reference"); assert.equal(i.purpose, undefined); }
    const p1 = await call(boot.token, "message.references", { taskId: task, limit: 1 });
    assert.equal(p1.result.items.length, 1); assert.ok(p1.result.next);
    const p2 = await call(boot.token, "message.references", { taskId: task, limit: 1, after: p1.result.next });
    assert.deepEqual([...p1.result.items, ...p2.result.items].map((i: { id: string }) => i.id).sort(), [m1, m2].sort());
    assert.equal((await call(tok, "message.references", { taskId: task })).result.items.length, 2, "the recipient sees what it received");
    await c.services.principals.enroll(rob, { commandId: "e-bob", kind: "agent", name: "bob", grants: [{ action: "task.read", project }] });
    const bob = (await c.services.principals.issueCredential(rob, "agent:bob")).token;
    assert.equal((await call(bob, "message.references", { taskId: task })).result.items.length, 0, "a stranger sees none");
    for (const bad of [{ taskId: "x" }, { taskId: task, limit: 0 }, { taskId: task, after: "m" }, { taskId: task, extra: 1 }]) assert.equal((await call(boot.token, "message.references", bad)).error.code, "invalid_command", JSON.stringify(bad));

    // Checkpoints: the owner captures one; the list shows identity, revision and who captured it, not what the run was doing.
    const DIGEST = `v1:sha256:${"b".repeat(64)}`;
    const capture = (verified: boolean) => ({ identity: "conv-1", agent: pid, boundary: { kind: "turn-complete" }, checkpoint: { format: 2, conversationId: 3, at: 12, digest: DIGEST, runtime: { name: "pi-durable", version: "1.3.0" } }, durable: { verified }, continuation: { artifacts: [], decisions: [], pendingEffects: [], budget: { spent: 2, remaining: 8, unit: "k-tokens" }, nextStep: "send the order" }, manifest: { summaryLineage: [], sourceRanges: [{ source: "history", from: 1, to: 12 }], compression: { state: "none", compactions: 0 }, branches: [], messageCursor: 12, routingRevision: 1, environmentRevision: 1, adapter: { name: "pi-durable", version: "1.3.0" } }, nonCheckpointableTools: [], scratchRecords: [], credentialRefs: [] });
    const k1 = await call(boot.token, "continuation.capture", { taskId: task, ...capture(true) }, "k1");
    const k2 = await call(boot.token, "continuation.capture", { taskId: task, ...capture(false) }, "k2");
    assert.deepEqual([k1.result.status, k2.result.status], ["complete", "incomplete"], JSON.stringify([k1, k2]));
    const ks = await call(boot.token, "continuation.list", { taskId: task });
    assert.equal(ks.ok, true, JSON.stringify(ks));
    assert.deepEqual(ks.result.items.map((i: { id: string }) => i.id).sort(), [k1.result.id, k2.result.id].sort());
    const one = ks.result.items.find((i: { id: string }) => i.id === k1.result.id);
    assert.deepEqual([one.seq, one.status, one.capturedBy, one.checkpoint.digest, one.taskId], [1, "complete", rob.id, DIGEST, task]);
    assert.ok(one.revision >= 1 && typeof one.capturedAt === "string");
    assert.equal(one.continuation, undefined, "what the run was doing is read with continuation.latest");
    assert.equal(ks.result.items.find((i: { id: string }) => i.id === k2.result.id).status, "incomplete");
    assert.equal(ks.result.items.find((i: { id: string }) => i.id === k2.result.id).problem !== undefined, true);
    const kp = await call(boot.token, "continuation.list", { taskId: task, limit: 1 });
    assert.ok(kp.result.next); assert.equal(kp.result.items.length, 1);
    assert.equal((await call(bob, "continuation.list", { taskId: task })).result.items.length, 0, "a reader without the right sees none");
    assert.deepEqual((await call(boot.token, "continuation.list", { taskId: other })).result.items, []);
    assert.equal((await call(boot.token, "continuation.list", { taskId: task, limit: 101 })).error.code, "invalid_command");

    // Tool activity: the operation answers like the status view; a task you may not read for tools reads as missing.
    assert.deepEqual((await call(boot.token, "activity.tools", { taskId: task })).result.items, []);
    assert.equal((await call(bob, "activity.tools", { taskId: task })).error.code, "not_found");
    assert.equal((await call(boot.token, "activity.tools", { taskId: task, state: "done" })).error.code, "invalid_command");
    assert.equal((await call(boot.token, "activity.tools", { taskId: "task-aaaaaaaaaaaaaaaaaaaa" })).error.code, "not_found");
    // A task credential reads its own task only.
    const { OPERATION_BY_NAME } = await import("./operations.js");
    const scoped = { principal: { id: pid, kind: "agent", name: "a", grants: [], taskScope: { taskId: task, projectId: project } }, status: { toolActivity: async () => ({ observedAt: "x", items: [] }) }, messages: { referencesFor: async () => ({ items: [] }) }, continuations: { history: async () => ({ items: [] }), hostHolds: async () => false } } as never;
    for (const op of ["activity.tools", "message.references", "continuation.list"]) {
      await assert.rejects(() => OPERATION_BY_NAME.get(op)!.run(scoped, { taskId: other }, undefined), (e: { code?: string }) => e.code === "not_found" || e.code === "forbidden", op);
      assert.ok(await OPERATION_BY_NAME.get(op)!.run(scoped, { taskId: task }, undefined), op);
    }
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("command.state follows task.assign and task.transfer through the shared words from the stored records, replays safely, and keeps to the caller's rights (card U13 finish)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-u13cmd-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI] });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (tok: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(tok, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await call(boot.token, "project.create", { name: "Garden" }, "p1")).result.id as string;
    const task = (await call(boot.token, "task.create", { projectId: project, title: "weed" }, "t1")).result.id as string;
    const other = (await call(boot.token, "task.create", { projectId: project, title: "water" }, "t2")).result.id as string;
    await call(boot.token, "task.transition", { taskId: task, to: "ready", expectedRevision: 1 }, "t1r");
    await call(boot.token, "task.transition", { taskId: other, to: "ready", expectedRevision: 1 }, "t2r");
    const assigned = await call(boot.token, "task.assign", { taskId: task, owner: { kind: "agent", id: "ann" } }, "as1");
    assert.match(assigned.awaits, /command\.state/, "the envelope points at the read");
    const first = await call(boot.token, "command.state", { command: "as1" });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.deepEqual([first.result.item.state, first.result.item.op, first.result.item.taskId, first.result.item.generation, first.result.item.assignment.state], ["accepted", "task.assign", task, 1, "assigned"]);
    assert.ok(typeof first.result.item.reason === "string" && first.result.item.reason.length > 0);
    assert.equal(first.accepted, undefined, "a read carries no command envelope fields");
    // A replay answers as recorded and changes nothing.
    const again = await call(boot.token, "task.assign", { taskId: task, owner: { kind: "agent", id: "ann" } }, "as1");
    assert.equal(again.result.replayed, true);
    assert.deepEqual((await call(boot.token, "command.state", { command: "as1" })).result, first.result);
    // The owner's attempt runs, then ends: running, completed.
    const a = (await c.services.assignments.getAssignment(task))!;
    const att = await c.services.assignments.admitAttempt({ commandId: "ad1", actor: rob.id, taskId: task, expectedRevision: a.revision, generation: 1, owner: { kind: "agent", id: "ann" }, harness: "pi" } as never);
    assert.equal((await call(boot.token, "command.state", { command: "as1" })).result.item.state, "running");
    assert.equal((await call(boot.token, "command.state", { command: "as1" })).result.item.attempt.state, "active");
    await c.services.assignments.finishAttempt({ commandId: "fn1", actor: rob.id, taskId: task, expectedRevision: a.revision + 1, fence: { generation: 1, attemptId: att.id }, outcome: "succeeded" });
    assert.equal((await call(boot.token, "command.state", { command: "as1" })).result.item.state, "completed");
    // A transfer is followed the same way.
    const tr = await call(boot.token, "task.transfer", { taskId: task, expectedRevision: a.revision + 2, to: { kind: "agent", id: "bob" } }, "tr1");
    assert.equal(tr.ok, true, JSON.stringify(tr));
    assert.deepEqual([(await call(boot.token, "command.state", { command: "tr1" })).result.item.state, (await call(boot.token, "command.state", { command: "tr1" })).result.item.op], ["accepted", "task.transfer"]);
    // Not found: unknown IDs, commands that are not deferred, and bad arguments.
    assert.equal((await call(boot.token, "command.state", { command: "nope" })).error.code, "not_found");
    assert.equal((await call(boot.token, "command.state", { command: "t1r" })).error.code, "not_found", "a command that finished when accepted is not read here");
    assert.equal((await call(boot.token, "command.state", { command: "as1", extra: 1 })).error.code, "invalid_command");
    assert.equal((await call(boot.token, "command.state", {})).error.code, "invalid_command");
    // Rights. Command IDs are kept per sender: another principal naming the owner's ID finds nothing, and a command's sender keeps to its rights.
    await c.services.principals.enroll(rob, { commandId: "e-zed", kind: "agent", name: "zed", grants: [] });
    const zed = (await c.services.principals.issueCredential(rob, "agent:zed")).token;
    assert.equal((await call(zed, "command.state", { command: "as1" })).error.code, "forbidden", "an agent with no rights at all is refused at the door");
    await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "ann", grants: [{ action: "assignment.manage", project }, { action: "assignment.read", project }, { action: "task.read", project }] });
    const ann = (await c.services.principals.issueCredential(rob, "agent:ann")).token;
    assert.equal((await call(ann, "command.state", { command: "as1" })).error.code, "forbidden", "the owner's command is the owner's; a refusal reads the same as a missing record");
    const mineOther = await call(ann, "task.assign", { taskId: other, owner: { kind: "agent", id: "ann" } }, "ann-as");
    assert.equal(mineOther.ok, true, JSON.stringify(mineOther));
    assert.equal((await call(ann, "command.state", { command: "ann-as" })).result.item.state, "accepted");
    assert.equal((await call(ann, "command.state", { command: "ann-as" }, "no-id")).error.code, "invalid_command", "a read takes no command ID");
    // A task credential of ann for the first task reads nothing about ann's command on the other task.
    const mine = (await c.services.taskCredentials.issue(rob, { commandId: "tc1", taskId: task, agentId: "agent:ann" })).token;
    assert.equal((await call(mine, "command.state", { command: "ann-as" })).error.code, "forbidden", "a task credential reads its own task only");
    const tcTask = await c.services.taskCredentials.issue(rob, { commandId: "tc2", taskId: other, agentId: "agent:ann" });
    assert.equal((await call(tcTask.token, "command.state", { command: "ann-as" })).result.item.taskId, other, "the credential for that task follows it");
    // A sender whose right was withdrawn is told nothing more.
    const f = await c.storage.getAggregate({ kind: "principal", id: "agent:ann" });
    await c.services.principals.setGrants(rob, { commandId: "g-none", principalId: "agent:ann", expectedRevision: f!.revision, grants: [] as never });
    assert.equal((await call(ann, "command.state", { command: "ann-as" })).error.code, "forbidden");
    // Nothing secret or long in the text.
    const text = JSON.stringify((await call(boot.token, "command.state", { command: "as1" })).result);
    assert.ok(text.length < 1200 && !/token|secret|password/i.test(text));
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
