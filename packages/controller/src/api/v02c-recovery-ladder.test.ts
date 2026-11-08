import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { CHAT_OPS, acceptedArgs } from "../chat/commands.js";
import { ScriptedInterpreter } from "../chat/index.js";
import { ModelInterpreter } from "../chat/model-interpreter.js";
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

test("end to end with the real effects: a supervisor's steps nudge, pause and reassign the concern's task (not the agent), the effect is keyed by the step so a retry under a new command does it once, and a repeat is answered as recorded (card V02c review)", async () => {
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
    // The stalled agent can see its task, so a nudge can reach it (a nudge to an agent that cannot be told is refused as forbidden, not passed).
    await c.services.grants.grant(rob, { commandId: "g-ann-read", grantee: `agent:${names.ann}`, action: "task.read", project, source: "direct", basis: "test" } as never);
    const boss = (await c.services.principals.issueCredential(rob, `agent:${names.boss}`)).token;
    const generation = (await c.services.assignments.getAssignment(task))!.generation;
    const id = `stl-${task.slice(5)}-${String(generation).padStart(10, "0")}-silent`;
    const now = new Date().toISOString();
    const body = { taskId: task, projectId: project, generation, kind: "silent", state: "suspected", detail: "no news", difficulty: "medium", route: { to: { kind: "agent", id: names.boss }, via: "supervisor", reason: "supervisor" }, firstSeenAt: now, lastChangedAt: now, reopened: 0, stalledAgent: names.ann };
    await c.storage.applyOperation({ operationId: "mk", epoch: c.epoch, actor: "owner:rob", correlationId: "mk", at: now, changes: [{ type: "create", ref: { kind: "stall-concern", id }, body }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string; message?: string } }>;
    const revision = async (): Promise<number> => (await c.storage.getAggregate({ kind: "stall-concern", id }))!.revision;
    const step = async (action: string, commandId: string, more: Record<string, unknown> = {}) => call(boss, "recovery.step", { concernId: id, expectedRevision: await revision(), action, text: "please look", ...more }, commandId);
    assert.ok((await call(boot.token, "recovery.ladder.set", { levels: [["nudge", "pause", "reassign", "hand-to-owner"]] }, "lad")).ok);
    // Nudge: a real notice to the stalled agent.
    const nudge = await step("nudge", "n1");
    assert.ok(nudge.ok, JSON.stringify(nudge));
    // Reassign cannot come before pause: the ladder's order is nudge, rebrief, pause, reassign.
    assert.equal((await step("reassign", "m0", { to: `agent:${names.bob}` })).error?.code, "invalid_transition");
    // Pause: the TASK is paused (pause acts on the task, so while the stalled agent still holds it), not the agent's other work, and the supervisor's own rights are what the pause service checked.
    const pause = await step("pause", "p1");
    assert.ok(pause.ok, JSON.stringify(pause));
    assert.equal((await c.services.pauses.gate(rob, { kind: "task", id: task }))?.intent, "pause");
    assert.equal((await c.services.pauses.gate(rob, { kind: "agent", id: names.ann }))?.intent ?? "run", "run", "the agent's other work is not paused");
    // Reassign by a supervisor after the pause (no hand-off needed: no attempt runs), recorded as a recovery step, not a meeting.
    const move = await step("reassign", "m1", { to: `agent:${names.bob}` });
    assert.ok(move.ok, JSON.stringify(move));
    const after = (await c.services.assignments.getAssignment(task))!;
    assert.equal(after.owner?.id, names.bob);
    assert.match(String((await c.services.assignments.history(task)).at(-1)!.reason), /recovery step/);
    const record = (await c.storage.getAggregate({ kind: "stall-concern", id }))!.body as any;
    assert.deepEqual(record.recoverySteps.map((x: any) => x.action), ["nudge", "pause", "reassign"]);
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

test("the owner reaches stuck agents' concerns in free-form chat: lists them, takes a recovery step and answers one, with the revision read for it; supervisors see only theirs (card V02c review)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-recovery-chat-"));
  const say: Record<string, unknown[]> = {};
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [],
    chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) },
    dispatch: { timer: new ManualTimer(), manual: true },
  } as never);
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const names = { ann: "agt-aaaaaaaaaaaaaaaaaaaa", boss: "agt-cccccccccccccccccccc", other: "agt-dddddddddddddddddddd" };
    for (const [k, n] of Object.entries(names)) await c.services.principals.enroll(rob, { commandId: `e-${k}`, kind: "agent", name: n, grants: [] });
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const task = (await c.services.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Build" })).id;
    await c.services.projects.transitionTask({ commandId: "r1", actor: rob.id, taskId: task, expectedRevision: 1, to: "ready" });
    await c.services.assignments.assignTask({ commandId: "as", actor: rob.id, taskId: task, owner: { kind: "agent", id: names.ann } });
    await c.services.grants.grant(rob, { commandId: "g-ann-read", grantee: `agent:${names.ann}`, action: "task.read", project, source: "direct", basis: "test" } as never);
    await c.services.grants.grant(rob, { commandId: "g-boss-read", grantee: `agent:${names.boss}`, action: "assignment.read", project, source: "direct", basis: "test" } as never);
    const generation = (await c.services.assignments.getAssignment(task))!.generation;
    const id = `stl-${task.slice(5)}-${String(generation).padStart(10, "0")}-silent`;
    const now = new Date().toISOString();
    const body = { taskId: task, projectId: project, generation, kind: "silent", state: "suspected", detail: "no news", difficulty: "medium", route: { to: { kind: "agent", id: names.boss }, via: "supervisor", reason: "supervisor" }, firstSeenAt: now, lastChangedAt: now, reopened: 0, stalledAgent: names.ann };
    await c.storage.applyOperation({ operationId: "mk", epoch: c.epoch, actor: "owner:rob", correlationId: "mk", at: now, changes: [{ type: "create", ref: { kind: "stall-concern", id }, body }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string; message?: string } }>;
    // Read: the owner sees it; an agent who may read the task's assignment too; an agent with no part in it does not.
    const listed = await call(boot.token, "stall.concerns", {});
    assert.deepEqual(listed.result.items.map((x: any) => [x.id, x.state]), [[id, "suspected"]], JSON.stringify(listed));
    const boss = (await c.services.principals.issueCredential(rob, `agent:${names.boss}`)).token;
    const other = (await c.services.principals.issueCredential(rob, `agent:${names.other}`)).token;
    assert.equal((await call(boss, "stall.concerns", { taskId: task })).result.items.length, 1);
    assert.deepEqual((await call(other, "stall.concerns", {})).result.items, []);
    assert.equal((await call(other, "stall.concern.get", { concernId: id })).error?.code, "not_found");
    assert.equal((await call(boot.token, "stall.concerns", { state: "stuck" })).error?.code, "invalid_command");
    // The owner says it in their own words; the revision is read for them; a step on work is shown first and made on the owner's word.
    const turn = async (mid: string, text: string, intents: unknown[]) => { say[text] = intents; return (await c.chat!.submit(boot.token, { messageId: mid, text })).outcomes as any[]; };
    const nudgeText = "give Ann a nudge about that stuck build: How is the build going? Tell me what blocks you.";
    const shown = await turn("m1", nudgeText, [{ kind: "command", op: "recovery.step", args: { concernId: id, action: "nudge", text: "How is the build going? Tell me what blocks you." }, evidence: nudgeText, basis: "owner" }]);
    assert.equal(shown[0]!.status, "proposed", JSON.stringify(shown));
    // A rung named by its fixed choice (hand-to-owner) needs no text and is shown first like any step.
    const handText = "I will take that stuck concern over myself";
    assert.equal((await turn("m00", handText, [{ kind: "command", op: "recovery.step", args: { concernId: id, action: "hand-to-owner" }, evidence: handText, basis: "owner" }]))[0]!.status, "proposed");
    // Words the owner never said are not sent in the owner's name.
    const madeUp = await turn("m0", "nudge Ann", [{ kind: "command", op: "recovery.step", args: { concernId: id, action: "nudge", text: "You are fired." }, evidence: "nudge Ann", basis: "owner" }]);
    assert.equal(madeUp[0]!.status, "refused", JSON.stringify(madeUp));
    assert.equal(((await call(boot.token, "stall.concern.get", { concernId: id })).result.item.recoverySteps ?? []).length, 0, "nothing until the owner says so");
    const applied = await turn("m2", "yes, send it", [{ kind: "apply_proposal", proposalId: shown[0]!.proposalId, evidence: "send it", basis: "owner" }]);
    assert.equal(applied[0]!.status, "applied", JSON.stringify(applied));
    const stepped = (await call(boot.token, "stall.concern.get", { concernId: id })).result.item;
    assert.deepEqual(stepped.recoverySteps.map((x: any) => [x.action, x.by]), [["nudge", rob.id]]);
    // The owner answers it: dismissed (shown first where the profile asks for it).
    const dismissText = "Ann is fine, dismiss that stuck-agent concern";
    let answer = await turn("m3", dismissText, [{ kind: "command", op: "stall.decide", args: { concernId: id, decision: "dismiss", reason: "Ann is fine" }, evidence: dismissText, basis: "owner" }]);
    if (answer[0]!.status === "proposed") answer = await turn("m4", "yes, dismiss it", [{ kind: "apply_proposal", proposalId: answer[0]!.proposalId, evidence: "dismiss it", basis: "owner" }]);
    assert.equal(answer[0]!.status, "applied", JSON.stringify(answer));
    assert.equal((await call(boot.token, "stall.concern.get", { concernId: id })).result.item.state, "dismissed");
    assert.equal((await call(boot.token, "stall.concerns", { state: "dismissed" })).result.items.length, 1);
    // The interpreter is told about both, with their arguments.
    let system = "";
    const m = new ModelInterpreter({ complete: async (_route, r) => { system = r.system; return "[]"; } }, () => ["a/primary"]);
    await m.interpret({ text: "hello", quoted: [], focus: {}, proposals: [] } as never);
    assert.match(system, /recovery\.step\([^)]*concernId[^)]*action[^)]*\)/);
    assert.match(system, /stall\.decide\([^)]*concernId[^)]*decision[^)]*\)/);
    assert.equal(CHAT_OPS["recovery.step"]?.mode, "propose");
  } finally {
    await c.close();
    rmSync(d, { recursive: true, force: true });
  }
});

test("a supervisor who hands a stuck agent's concern to the owner by hand is named in the owner's notice; nothing says it waited too long for its supervisor (card V02c review)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-recovery-hand-"));
  let clock = Date.parse("2026-11-02T08:00:00.000Z");
  const say: Record<string, unknown[]> = {};
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) },
    dispatch: { timer: new ManualTimer(), manual: true, clock: () => new Date(clock).toISOString() },
  } as never);
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string; message?: string } }>;
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    // Ann works the task; Boss supervises her and may see and manage the task (so may pause it); a host reports Ann's progress.
    const boss = (await c.services.agents.create(rob, { commandId: "a-boss", friendlyName: "Boss" } as never)).id;
    const ann = (await c.services.agents.create(rob, { commandId: "a-ann", friendlyName: "Ann", supervisorId: boss } as never)).id;
    for (const a of ["task.read", "assignment.read", "assignment.manage"]) await c.services.grants.grant(rob, { commandId: `g-${a}`, grantee: `agent:${boss}`, action: a, project, source: "direct", basis: "test" } as never);
    await c.services.grants.grant(rob, { commandId: "g-ann", grantee: `agent:${ann}`, action: "task.read", project, source: "direct", basis: "test" } as never);
    await c.services.principals.enroll(rob, { commandId: "e-pc", kind: "host", name: "pc", grants: [{ action: "attempt.work", project }] });
    const host = await c.services.principals.authenticate((await c.services.principals.issueCredential(rob, "host:pc")).token);
    const task = (await c.services.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Build" })).id;
    await c.services.projects.transitionTask({ commandId: "r1", actor: rob.id, taskId: task, expectedRevision: 1, to: "ready" });
    await c.services.assignments.assignTask({ commandId: "as", actor: rob.id, taskId: task, owner: { kind: "agent", id: ann } });
    const a0 = (await c.services.assignments.getAssignment(task))!;
    await c.services.assignments.admitAttempt({ commandId: "ad", actor: rob.id, taskId: task, expectedRevision: a0.revision, generation: a0.generation, owner: { kind: "agent", id: ann }, harness: "pi" } as never);
    await c.services.projects.transitionTask({ commandId: "ip", actor: rob.id, taskId: task, expectedRevision: (await c.services.projects.getTask(task))!.revision, to: "in_progress" });
    let k = 0;
    // The same action over and over, reported as it happens: a loop, never silence.
    const busy = async (): Promise<void> => { for (let i = 0; i < 6; i++) await c.services.stall.report(host, { commandId: `rep-${k++}`, taskId: task, generation: a0.generation, event: { type: "step", label: "run tests", actionKey: "tests" } }); };
    await busy();
    // Stall detection needs its right; the automatic steps run in the same loop family.
    await c.services.grants.grant(rob, { commandId: "g-scan", grantee: "service:dispatcher", action: "recovery.stall-scan", project: "*", source: "direct", basis: "test" } as never);
    await call(boot.token, "recovery.ladder.set", { levels: [["nudge", "hand-to-owner"]] }, "lad");
    await c.dispatch.dispatcher.tick();
    const concern = async () => (await c.services.stall.list(rob, { taskId: task })).items.find((x) => x.kind === "loop")!;
    assert.equal((await concern()).route.to.id, boss);
    const bossToken = (await c.services.principals.issueCredential(rob, `agent:${boss}`)).token;
    const revision = async (): Promise<number> => (await concern()).revision;
    const id = (await concern()).id;
    assert.ok((await call(bossToken, "recovery.step", { concernId: id, expectedRevision: await revision(), action: "nudge", text: "how is it going?" }, "n1")).ok);
    const handed = await call(bossToken, "recovery.step", { concernId: id, expectedRevision: await revision(), action: "hand-to-owner" }, "h1");
    assert.ok(handed.ok, JSON.stringify(handed));
    assert.equal((await concern()).escalatedTo, "owner");
    await c.dispatch.dispatcher.tick();
    assert.ok((await concern()).notifiedAt !== undefined, "the owner was told");
    const told = (await c.storage.listAggregates("notification-item", { limit: 100 })).map((n) => n.body as unknown as { ref: { kind: string; id: string }; detail?: string }).filter((n) => n.ref.kind === "task" && n.ref.id === task);
    assert.equal(told.length, 1, JSON.stringify(told));
    assert.match(told[0]!.detail!, new RegExp(`was handed to you by agent:${boss}: `));
    assert.doesNotMatch(told[0]!.detail!, /waited too long|automatic/);
  } finally {
    await c.close();
    rmSync(d, { recursive: true, force: true });
  }
});

test("automatic recovery steps through the composed controller: off by default; the owner switches them on in free-form chat (shown first); the dispatcher's tick, on the controller's clock, takes one rung per interval in the supervisor's name with the real effects, records each, passes reassign and stops at the owner (card V02c)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-recovery-auto-"));
  let clock = Date.parse("2026-11-02T08:00:00.000Z");
  const say: Record<string, unknown[]> = {};
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) },
    dispatch: { timer: new ManualTimer(), manual: true, clock: () => new Date(clock).toISOString() },
  } as never);
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string; message?: string } }>;
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    // Ann works the task; Boss supervises her and may see and manage the task (so may pause it); a host reports Ann's progress.
    const boss = (await c.services.agents.create(rob, { commandId: "a-boss", friendlyName: "Boss" } as never)).id;
    const ann = (await c.services.agents.create(rob, { commandId: "a-ann", friendlyName: "Ann", supervisorId: boss } as never)).id;
    for (const a of ["task.read", "assignment.read", "assignment.manage"]) await c.services.grants.grant(rob, { commandId: `g-${a}`, grantee: `agent:${boss}`, action: a, project, source: "direct", basis: "test" } as never);
    await c.services.grants.grant(rob, { commandId: "g-ann", grantee: `agent:${ann}`, action: "task.read", project, source: "direct", basis: "test" } as never);
    await c.services.principals.enroll(rob, { commandId: "e-pc", kind: "host", name: "pc", grants: [{ action: "attempt.work", project }] });
    const host = await c.services.principals.authenticate((await c.services.principals.issueCredential(rob, "host:pc")).token);
    const task = (await c.services.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Build" })).id;
    await c.services.projects.transitionTask({ commandId: "r1", actor: rob.id, taskId: task, expectedRevision: 1, to: "ready" });
    await c.services.assignments.assignTask({ commandId: "as", actor: rob.id, taskId: task, owner: { kind: "agent", id: ann } });
    const a0 = (await c.services.assignments.getAssignment(task))!;
    await c.services.assignments.admitAttempt({ commandId: "ad", actor: rob.id, taskId: task, expectedRevision: a0.revision, generation: a0.generation, owner: { kind: "agent", id: ann }, harness: "pi" } as never);
    await c.services.projects.transitionTask({ commandId: "ip", actor: rob.id, taskId: task, expectedRevision: (await c.services.projects.getTask(task))!.revision, to: "in_progress" });
    let k = 0;
    // The same action over and over, reported as it happens: a loop, never silence.
    const busy = async (): Promise<void> => { for (let i = 0; i < 6; i++) await c.services.stall.report(host, { commandId: `rep-${k++}`, taskId: task, generation: a0.generation, event: { type: "step", label: "run tests", actionKey: "tests" } }); };
    await busy();
    // Stall detection needs its right; the automatic steps run in the same loop family.
    await c.services.grants.grant(rob, { commandId: "g-scan", grantee: "service:dispatcher", action: "recovery.stall-scan", project: "*", source: "direct", basis: "test" } as never);
    await call(boot.token, "recovery.ladder.set", { levels: [["nudge", "pause", "reassign", "hand-to-owner"]] }, "lad");
    await c.dispatch.dispatcher.tick();
    const concern = async () => (await c.services.stall.list(rob, { taskId: task })).items.find((x) => x.kind === "loop")!;
    assert.equal((await concern()).route.to.id, boss);
    // Off by default: an hour and more with no answer takes nothing.
    clock += 2 * 3_600_000; await busy();
    await c.dispatch.dispatcher.tick();
    assert.equal((await concern()).recoverySteps, undefined);
    assert.equal((await call(boot.token, "recovery.ladder.get", {})).result.item.autoStep, false);
    // The owner says it in their own words; the chat shows it first, and applies it on the owner's word.
    const turn = async (id: string, text: string, intents: unknown[]) => { say[text] = intents; return (await c.chat!.submit(boot.token, { messageId: id, text })).outcomes as any[]; };
    const text = "when nobody answers a stuck agent for an hour, let the controller take the next recovery step by itself";
    const shown = await turn("m1", text, [{ kind: "command", op: "recovery.ladder.set", args: { autoStep: true, autoStepMinutes: 60 }, evidence: text, basis: "owner" }]);
    assert.equal(shown[0]!.status, "proposed", JSON.stringify(shown));
    await c.dispatch.dispatcher.tick();
    assert.equal((await concern()).recoverySteps, undefined, "nothing while it waits for the owner");
    const applied = await turn("m2", "yes, do that", [{ kind: "apply_proposal", proposalId: shown[0]!.proposalId, evidence: "do that", basis: "owner" }]);
    assert.equal(applied[0]!.status, "applied", JSON.stringify(applied));
    const setting = (await call(boot.token, "recovery.ladder.get", {})).result.item;
    assert.deepEqual([setting.autoStep, setting.autoStepMinutes, setting.levels], [true, 60, [["nudge", "pause", "reassign", "hand-to-owner"]]], "the other fields are kept");
    // The concern has waited past the hour: the first rung, the nudge, a real notice to Ann in Boss's name.
    await c.dispatch.dispatcher.tick();
    let held = await concern();
    assert.deepEqual(held.recoverySteps!.map((x) => [x.action, x.by, x.auto]), [["nudge", `agent:${boss}`, true]]);
    await c.dispatch.dispatcher.tick();
    assert.equal((await concern()).recoverySteps!.length, 1, "one rung per interval");
    clock += 59 * 60_000; await busy();
    await c.dispatch.dispatcher.tick();
    assert.equal((await concern()).recoverySteps!.length, 1, "the next rung waits its full hour");
    clock += 60_000; await busy();
    await c.dispatch.dispatcher.tick();
    held = await concern();
    assert.deepEqual(held.recoverySteps!.map((x) => x.action), ["nudge", "pause"]);
    assert.equal((await c.services.pauses.gate(rob, { kind: "task", id: task }))?.intent, "pause", "the task is paused, with Boss's own right to");
    // Reassign is passed (the controller never chooses who takes over) and the concern goes to the owner, who is told.
    clock += 60 * 60_000;
    await c.dispatch.dispatcher.tick();
    held = await concern();
    assert.deepEqual(held.recoverySteps!.map((x) => [x.action, x.skipped === true]), [["nudge", false], ["pause", false], ["reassign", true], ["hand-to-owner", false]]);
    assert.equal(held.escalatedTo, "owner");
    await c.dispatch.dispatcher.tick();
    assert.ok((await concern()).notifiedAt !== undefined, "the owner was told");
    // Truthfully: the automatic steps handed it over, the supervisor did not answer; it did not "wait too long for its supervisor to decide".
    const told = (await c.storage.listAggregates("notification-item", { limit: 100 })).map((n) => n.body as unknown as { ref: { kind: string; id: string }; detail?: string; level?: string }).filter((n) => n.ref.kind === "task" && n.ref.id === task);
    assert.equal(told.length, 1, JSON.stringify(told));
    assert.match(told[0]!.detail!, new RegExp(`handed to you by the automatic recovery steps \\(agent:${boss} did not answer in time\\)`));
    assert.doesNotMatch(told[0]!.detail!, /waited too long/);
    // Nothing more: the owner holds it.
    clock += 24 * 3_600_000;
    await c.dispatch.dispatcher.tick();
    assert.equal((await concern()).recoverySteps!.length, 4);
    assert.equal((await c.storage.listAggregates("pause-request", { limit: 50 })).filter((r) => (r.body as any).scope.kind === "task").length, 1, "paused once");
  } finally {
    await c.close();
    rmSync(d, { recursive: true, force: true });
  }
});

test("the chat interpreter is told about automatic recovery steps: recovery.ladder.set lists autoStep and autoStepMinutes and says what they do (card V02c)", async () => {
  assert.ok(acceptedArgs("recovery.ladder.set")!.includes("autoStep"));
  assert.ok(acceptedArgs("recovery.ladder.set")!.includes("autoStepMinutes"));
  let system = "";
  const m = new ModelInterpreter({ complete: async (_route, r) => { system = r.system; return "[]"; } }, () => ["a/primary"]);
  await m.interpret({ text: "hello", quoted: [], focus: {}, proposals: [] } as never);
  assert.match(system, /recovery\.ladder\.set\([^)]*autoStep, autoStepMinutes[^)]*\) - [^;]*whether the controller takes the next one by itself after a time with no answer/);
  assert.equal(CHAT_OPS["recovery.ladder.set"]?.mode, "propose", "switching it on is shown first");
});
