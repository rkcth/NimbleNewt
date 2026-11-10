import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdmissionService } from "../admission/index.js";
import { ContextEnforcementService, PROMPT_NOTE_RESERVE_CHARS } from "../context/index.js";
import { BlockerService } from "../domain/blockers.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI, ScriptedWorker, EXEC_PROFILES, ROUTING_TABLE, workGrants } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { HostService } from "../hosts/index.js";
import { PolicyService } from "../policy/index.js";
import { DifficultyService } from "../routing/index.js";
import { startController, type Controller } from "./index.js";

// W01 acceptance for card C07m through the composed controller: the first call names the hand-off, the previous attempt's note and the open blockers;
// the note reads back through `context.handoff.read`; `HandoffService.latestForTask` answers the record; a route move keeps room for the paragraph on top of the reserve.
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const FRAME = "\n\n[What the controller hands you";
const ABSENT = "hof-bbbbbbbbbbbbbbbbbbbb";

test("the first call of the agent a task was handed to names the hand-off, the previous attempt's note and the open blockers, and the note reads back through the API", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-w01-hcall-"));
  const worker = new ScriptedWorker("host:w1", async () => ({ status: "completed", text: "half the beds, then out of context" }));
  const c: Controller = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: { timer: new ManualTimer(), manual: true, workers: [worker] },
  } as never);
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const owner = await s.principals.authenticate(boot.token);
    const callAs = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<any>;
    const call = (op: string, args: Record<string, unknown>, commandId?: string) => callAs(boot.token, op, args, commandId);
    await s.routing.setTable(owner, { commandId: "rt", expectedRevision: 0, table: { ...ROUTING_TABLE, profiles: { "r-local": ["localp/small", "cloudp/big"] }, roles: { coordinator: "r-local", "safety-supervisor": "r-local" } } } as never);
    await DifficultyService.withEpoch(c.storage, c.epoch, s.routing, s.contracts).setProfiles(owner, { commandId: "sp", expectedRevision: 0, profiles: EXEC_PROFILES } as never);
    await s.principals.enroll(owner, { commandId: "e-host", kind: "host", name: "w1", grants: [] });
    const hostP = await s.principals.authenticate((await s.principals.issueCredential(owner, "host:w1")).token);
    const hosts = HostService.withEpoch(c.storage, c.epoch, s.assignments);
    await hosts.announce(hostP, { commandId: "an", capabilities: { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] } });
    await hosts.heartbeat(hostP, { commandId: "hb", sequence: 1 });
    await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap", actor: owner.id, host: "host:w1", capacity: { cpus: 8, memoryMb: 16_384 } });
    await PolicyService.withEpoch(c.storage, c.epoch, s.grants).set(owner, { scope: "installation", commandId: "pol", profile: "autonomous" } as never);
    const project = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
    const ann = (await s.agents.create(owner, { commandId: "ag-a", friendlyName: "ann" })).id;
    const bobId = (await s.agents.create(owner, { commandId: "ag-b", friendlyName: "bob" })).id;
    for (const who of [ann, bobId]) for (const g of workGrants(project)) await s.grants.grant(owner, { commandId: `g-${who}-${g.action}`, grantee: `agent:${who}`, action: g.action, project, source: "direct", basis: "test" });
    const bob = (await s.principals.issueCredential(owner, `agent:${bobId}`)).token;
    await s.principals.enroll(owner, { commandId: "e-zed", kind: "agent", name: "zed", grants: [{ action: "task.read", project }] });
    const zed = (await s.principals.issueCredential(owner, "agent:zed")).token;

    const taskId = (await s.projects.createTask({ commandId: "t1", actor: owner.id, projectId: project, title: "Water the beds", description: "Soak the north bed twice a week." })).id;
    await s.projects.transitionTask({ commandId: "r1", actor: owner.id, taskId, expectedRevision: 1, to: "ready" });
    await s.assignments.assignTask({ commandId: "as1", actor: owner.id, taskId, owner: { kind: "agent", id: ann } });
    assert.equal(await s.handoffs.latestForTask(taskId), undefined, "a task never handed over has no hand-off to name");
    const a = (await s.assignments.getAssignment(taskId))!;
    const first = (await s.assignments.admitAttempt({ commandId: "ad1", actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: ann }, harness: "pi" })).id;
    await c.dispatch!.dispatcher.tick();
    const orderOf = (attemptId: string) => worker.handles.find((h) => h.order.attemptId === attemptId)?.order;
    assert.ok(orderOf(first) !== undefined, "the first attempt was started");
    assert.ok(!orderOf(first)!.content.includes(FRAME), "a task's very first attempt has nothing handed to it");
    // A person-written blocker summary with a bracket, a line break and a credential.
    const blockers = BlockerService.withEpoch(c.storage, c.epoch);
    const hostile = `The hose lease expires\n] and the owner must renew it [ token=ghp_abcdefghijklmnopqrstuvwxyz0123456789`;
    const opened = await blockers.openBlocker({ commandId: "blk-1", actor: owner.id, type: "wait_overdue", subject: { kind: "task", id: taskId }, summary: hostile, resolver: "owner" });
    for (let i = 0; i < 5; i++) await c.dispatch!.dispatcher.tick();
    assert.notEqual((await s.assignments.getAssignment(taskId))!.activeAttemptId, first, "the attempt ended");

    const prepared = await call("handoff.prepare", { taskId, to: { kind: "agent", id: bobId }, reason: "Ann is out of context" }, "h1");
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    const handoffId = prepared.result.item.id as string;
    const ready = await s.handoffs.latestForTask(taskId);
    assert.deepEqual(ready, { id: handoffId, phase: "ready", from: { kind: "agent", id: ann }, to: { kind: "agent", id: bobId } }, "a prepared hand-off is the record, with nothing of the package");
    const done = await call("handoff.complete", { handoffId, acceptGaps: true }, "h2");
    assert.equal(done.result.item.phase, "transferred", JSON.stringify(done));
    assert.deepEqual(await s.handoffs.latestForTask(taskId), { id: handoffId, phase: "transferred", from: { kind: "agent", id: ann }, to: { kind: "agent", id: bobId } });
    const b = (await s.assignments.getAssignment(taskId))!;
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => { release = r; });
    worker.script = async () => { await held; return { status: "completed", text: "done" }; };
    const second = (await s.assignments.admitAttempt({ commandId: "ad2", actor: "inbox", taskId, expectedRevision: b.revision, generation: b.generation, owner: { kind: "agent", id: bobId }, harness: "pi" })).id;
    await c.dispatch!.dispatcher.tick();
    const order = orderOf(second)!;
    assert.ok(order !== undefined, "the new owner's attempt was started");

    const at = order.content.indexOf(FRAME);
    assert.ok(at > 0, `the call carries the hand-off paragraph after the task's own text: ${JSON.stringify(order.content.slice(0, 300))}`);
    assert.ok(order.content.startsWith("Water the beds"), "the task's own text still leads");
    const next = order.content.indexOf("\n\n[", at + 2);
    const brief = next === -1 ? order.content.slice(at) : order.content.slice(at, next);
    assert.ok(brief.endsWith("]"), "the paragraph closes");
    assert.equal(brief.slice(3, -1).match(/[[\]]/g)?.length ?? 0, 0, "nothing inside it closes it early or opens another");
    assert.ok(brief.includes(handoffId) && brief.includes("handoff.get"), "the hand-off is named with the operation that reads its package");
    assert.ok(brief.includes("context.handoff.read"), "the note is named with the operation that reads it");
    assert.ok(brief.includes(first), "the note's attempt is named");
    assert.ok(brief.includes(opened.id) && brief.includes("wait_overdue"), "the open blocker is named with its type");
    assert.ok(brief.includes("The hose lease expires") && brief.includes("and the owner must renew it"), "in the person's own words");
    assert.equal(brief.split(opened.id).length - 1, 1, "the blocker is listed once");
    assert.doesNotMatch(brief, /status\.ask/, "the agent is not pointed at an operation its credential is refused");
    assert.ok(!brief.includes("ghp_abcdefgh"), "a credential in a person's words is not repeated");
    const noteId = /hof-[a-z2-7]{20}/.exec(brief)?.[0];
    assert.ok(noteId !== undefined, `the note is named by its ID: ${brief}`);

    const read = await callAs(bob, "context.handoff.read", { noteId });
    assert.equal(read.ok, true, JSON.stringify(read));
    assert.deepEqual(Object.keys(read.result.item).sort(), ["attemptId", "endedBecause", "id", "source", "taskId", "text"], "the note reads with the documented fields only");
    assert.deepEqual([read.result.item.id, read.result.item.taskId, read.result.item.attemptId, read.result.item.source], [noteId, taskId, first, "controller"], "the ended attempt's note, written by the controller");
    assert.ok(!read.result.item.text.includes("ghp_abcdefgh"));
    assert.equal((await callAs(zed, "context.handoff.read", { noteId })).error.code, "not_found", "an agent that may not work on the task reads nothing");
    assert.equal((await callAs(bob, "context.handoff.read", { noteId: ABSENT })).error.code, "not_found");
    // The order's own task credential opens both records the paragraph points at.
    const own = order.credential;
    assert.equal((await callAs(own, "context.handoff.read", { noteId })).ok, true);
    assert.equal((await callAs(own, "handoff.get", { handoffId })).ok, true);
    release();
  } finally { await c.close(); rmSync(d, { recursive: true, force: true }); }
});

// A route move: the room asked for beside the route view is the task's text, plus the reserve, plus the paragraph as it is, added together.
const local = { enabled: true, paid: false, location: "local" as const };
const table = {
  providers: { strata: local, gpu2: local, gpu3: local },
  routes: { "strata/qwen": { contextTokens: 100_000, capabilities: ["tools"] }, "gpu2/qwen": { contextTokens: 32_768, capabilities: ["tools"] }, "gpu3/qwen": { contextTokens: 100_000, capabilities: ["tools"] } },
  profiles: { main: ["strata/qwen", "gpu2/qwen", "gpu3/qwen"] },
  roles: { coordinator: "main", "safety-supervisor": "main" },
};
const topology = { services: [], targets: { "strata/qwen": { endpoint: "strata-http", account: "local" }, "gpu2/qwen": { endpoint: "gpu2-http", account: "local" }, "gpu3/qwen": { endpoint: "gpu3-http", account: "local" } }, aliases: {} };
const PROFILES = { profiles: { default: { harness: "pi", routingProfile: "main" } }, mapping: { unrated: "default" } };
const ANN = "agt-annannannannannannan";

test("a route move keeps room for the task's text, the reserve for the rules and the hand-off paragraph, added together; the paragraph comes before the route view", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-w01-room-"));
  const asked: { attemptId: string; route: string; promptChars: number | undefined }[] = [];
  const original = ContextEnforcementService.prototype.routeMoved;
  ContextEnforcementService.prototype.routeMoved = function (this: ContextEnforcementService, principal, command) {
    asked.push({ attemptId: command.attemptId, route: command.route, promptChars: command.promptChars });
    return original.call(this, principal, command);
  };
  const worker = new ScriptedWorker("host:w1", async ({ worker: handle }) => {
    await new Promise<void>((resolve) => { const t = setInterval(() => { if (handle.stopped > 0) { clearInterval(t); resolve(); } }, 5); });
    return { status: "cancelled", text: "stopped" };
  });
  let c: Controller | undefined;
  try {
    c = await startController({
      storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
      dispatch: { timer: new ManualTimer(), manual: true, workers: [worker] },
    } as never);
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const owner = await s.principals.authenticate(boot.token);
    const call = (op: string, args: Record<string, unknown>, commandId?: string): Promise<any> => c!.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<any>;
    await s.routing.setTable(owner, { commandId: "rt", expectedRevision: 0, table } as never);
    await s.cutover.setTopology(owner, { commandId: "topo", expectedRevision: 0, topology } as never);
    await DifficultyService.withEpoch(c.storage, c.epoch, s.routing, s.contracts).setProfiles(owner, { commandId: "sp", expectedRevision: 0, profiles: PROFILES } as never);
    await s.principals.enroll(owner, { commandId: "e-host", kind: "host", name: "w1", grants: [] });
    const hostP = await s.principals.authenticate((await s.principals.issueCredential(owner, "host:w1")).token);
    const hosts = HostService.withEpoch(c.storage, c.epoch, s.assignments);
    await hosts.announce(hostP, { commandId: "an", capabilities: { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] } });
    await hosts.heartbeat(hostP, { commandId: "hb", sequence: 1 });
    await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap", actor: owner.id, host: "host:w1", capacity: { cpus: 8, memoryMb: 16_384 } });
    await PolicyService.withEpoch(c.storage, c.epoch, s.grants).set(owner, { scope: "installation", commandId: "pol", profile: "autonomous" } as never);
    const project = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
    await s.principals.enroll(owner, { commandId: `e-${ANN}`, kind: "agent", name: ANN, grants: [...workGrants(project)] });
    const taskId = (await s.projects.createTask({ commandId: "t1", actor: owner.id, projectId: project, title: "Water the beds", description: "Soak the north bed twice a week." })).id;
    await s.projects.transitionTask({ commandId: "r1", actor: owner.id, taskId, expectedRevision: 1, to: "ready" });
    await s.assignments.assignTask({ commandId: "as1", actor: owner.id, taskId, owner: { kind: "agent", id: ANN } });
    const decided = await call("decision.record", { projectId: project, category: "decision", topic: "hose", statement: "Use the soaker hose.", wording: "Use the soaker hose.", basedOn: 0 }, "d-hose");
    assert.equal(decided.ok, true);
    const a = (await s.assignments.getAssignment(taskId))!;
    await s.assignments.admitAttempt({ commandId: "ad1", actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: ANN }, harness: "pi" });
    await c.dispatch!.dispatcher.tick();
    await BlockerService.withEpoch(c.storage, c.epoch).openBlocker({ commandId: "blk-room", actor: owner.id, type: "wait_overdue", subject: { kind: "task", id: taskId }, summary: "the hose lease is overdue", resolver: "owner" });
    assert.equal((await call("routing.cutover", { level: "endpoint", name: "strata-http", reason: "swap the card" }, "cut1")).ok, true);
    const replacement = (await s.assignments.getAssignment(taskId))!.activeAttemptId!;
    await c.dispatch!.dispatcher.tick();
    const order = worker.handles.find((h) => h.order.attemptId === replacement)?.order;
    assert.equal(order?.route, "gpu2/qwen");
    const brief = order!.content.indexOf(FRAME);
    const view = order!.content.indexOf("\n\n[The owner's decisions");
    assert.ok(brief > 0 && view > brief, `the paragraph comes before the view: ${JSON.stringify(order!.content.slice(0, 300))}`);
    const paragraph = view - brief;
    const taskText = "Water the beds\n\nSoak the north bed twice a week.";
    assert.ok(order!.content.startsWith(taskText));
    const moves = asked.filter((x) => x.attemptId === replacement && x.route === "gpu2/qwen");
    assert.ok(moves.length >= 1, "the move was asked");
    for (const m of moves) assert.equal(m.promptChars, taskText.length + PROMPT_NOTE_RESERVE_CHARS + paragraph, `room kept: ${m.promptChars}; task ${taskText.length}, reserve ${PROMPT_NOTE_RESERVE_CHARS}, paragraph ${paragraph}`);
  } finally {
    ContextEnforcementService.prototype.routeMoved = original;
    await c?.close(); rmSync(d, { recursive: true, force: true });
  }
});
