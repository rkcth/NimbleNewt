import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AgentService } from "../agents/index.js";
import { ConfigurationService } from "../configuration/index.js";
import { ConversationService } from "../conversations/index.js";
import { AssignmentService } from "../domain/assignments.js";
import { assignmentEventId } from "../domain/assignments.js";
import { BlockerService } from "../domain/blockers.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { EffectService, type EffectBridge, type EffectRequest } from "../domain/effects.js";
import { InboxService } from "../domain/inbox.js";
import { Reconciler } from "../domain/reconcile.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { WaitService } from "../domain/waits.js";
import { GenerationRefused, GenerationService, type RefusalReason } from "../generation/index.js";
import { StallService } from "../health/index.js";
import { derivedId } from "../domain/ids.js";
import { scopedCommandId } from "../security/credentials.js";
import { PolicyService } from "../policy/index.js";
import { GrantService, PrincipalService, type Grant, type Principal } from "../security/index.js";
import type { JsonObject } from "../storage/types.js";
import { PauseRefused, PauseService, type PauseScope } from "./index.js";

after(stopServer);

let now = Date.parse("2026-10-22T10:00:00.000Z");
const options = { clock: () => new Date(now).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};
const refusedFor = async (reason: RefusalReason, run: () => Promise<unknown>): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof GenerationRefused, String(error)); assert.equal(error.reason, reason, (error as Error).message); return true; });
};

class Outside {
  executions: string[] = [];
  bridge(): EffectBridge {
    return { idempotent: true, execute: async (r: EffectRequest): Promise<JsonObject> => { this.executions.push(r.key); return { receipt: `r-${this.executions.length}` }; } };
  }
}

for (const backend of backends) {
  interface Ctx {
    owner: Principal; project: string; other: string;
    t1: string; t2: string; t3: string; t4: string; /** t1 and t2: agent A (team child), t3: agent B (no team), t4: agent C (team parent) */
    agentA: string; agentB: string; agentC: string; teamParent: string; teamChild: string;
    pauses: PauseService; reopen(): { pauses: PauseService; gen: GenerationService };
    gen: GenerationService; hooked(hooks: { afterGuardRead?: () => Promise<void>; afterPauseRead?: () => Promise<void> }): GenerationService; hookedPauses(hooks: { afterBackgroundRead?: () => Promise<void>; beforeLift?: (scope: PauseScope) => Promise<void> }): PauseService; effects: EffectService; assignments: AssignmentService; projects: ProjectService; waits: WaitService; inbox: InboxService; blockers: BlockerService;
    conv: ConversationService; config: ConfigurationService; policy: PolicyService; stall: StallService; reconciler(): Reconciler;
    ann: Principal; mgr: Principal; amgr: Principal; pat: Principal; eve: Principal; asA: Principal; asB: Principal;
    pauseTask(taskId: string, extra?: { background?: "permit" | "deny" }): Promise<{ gateId: string; requestId: string; replayed: boolean }>;
    task(title: string, agent?: string): Promise<string>;
    grantAgent(agentId: string, grants: Grant[]): Promise<Principal>;
    storage: Parameters<typeof PauseService.withEpoch>[0]; epoch: number;
  }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      now = Date.parse("2026-10-22T10:00:00.000Z");
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const epoch = projects.epoch;
        const principals = PrincipalService.withEpoch(world.storage, epoch, options);
        const grants = GrantService.withEpoch(world.storage, epoch, options);
        const agents = AgentService.withEpoch(world.storage, epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const plain = async (nm: string, g: Grant[]) => {
          await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: g });
          return principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
        };
        const project = (await projects.createProject({ commandId: cid("pa"), actor: owner.id, name: "A" })).id;
        const other = (await projects.createProject({ commandId: cid("pb"), actor: owner.id, name: "B" })).id;
        const teamParent = (await agents.createTeam(owner, { commandId: cid("tm"), name: "builders" })).id;
        const teamChild = (await agents.createTeam(owner, { commandId: cid("tm"), name: "frontend", parentTeamId: teamParent })).id;
        const agentA = (await agents.create(owner, { commandId: cid("ag"), friendlyName: "A", teamId: teamChild })).id;
        const agentB = (await agents.create(owner, { commandId: cid("ag"), friendlyName: "B" })).id;
        const agentC = (await agents.create(owner, { commandId: cid("ag"), friendlyName: "C", teamId: teamParent })).id;
        const assignments = AssignmentService.withEpoch(world.storage, epoch, projects, options);
        const effects = EffectService.withEpoch(world.storage, epoch, assignments, { holder: "exec-1", ...options });
        const waits = WaitService.withEpoch(world.storage, epoch, assignments, options);
        const inbox = InboxService.withEpoch(world.storage, epoch, assignments, options);
        const blockers = BlockerService.withEpoch(world.storage, epoch, options);
        const policy = PolicyService.withEpoch(world.storage, epoch, grants, options);
        const pauses = PauseService.withEpoch(world.storage, epoch, { waits }, options);
        const makeGen = (p: PauseService, hooks?: { afterGuardRead?: () => Promise<void> }) => GenerationService.withEpoch(world.storage, epoch, { assignments, effects, pauses: p }, { ...options, ...(hooks === undefined ? {} : { testHooks: hooks }) });
        const config = ConfigurationService.withEpoch(world.storage, epoch, options);
        const stall = StallService.withEpoch(world.storage, epoch, assignments, waits, { ...options, isPaused: (t) => pauses.isPaused(t) });
        const conv = ConversationService.withEpoch(world.storage, epoch, { ...options, availability: pauses.availability });
        const reconciler = () => new Reconciler(world.storage, epoch, { projects, inbox, effects, blockers, bridges: {}, destinations: [], pauses }, options);
        const task = async (title: string, agent?: string): Promise<string> => {
          const id = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title })).id;
          await projects.transitionTask({ commandId: cid("r"), actor: owner.id, taskId: id, expectedRevision: 1, to: "ready" });
          if (agent !== undefined) await assignments.assignTask({ commandId: cid("as"), actor: owner.id, taskId: id, owner: { kind: "agent", id: agent } });
          return id;
        };
        const grantAgent = async (agentId: string, g: Grant[]): Promise<Principal> => {
          const f = await world.storage.getAggregate({ kind: "principal", id: `agent:${agentId}` });
          await principals.setGrants(owner, { commandId: cid("sg"), principalId: `agent:${agentId}`, expectedRevision: f!.revision, grants: g });
          return principals.authenticate((await principals.issueCredential(owner, `agent:${agentId}`)).token);
        };
        const mgr = await plain("mgr", [{ action: "assignment.manage", project }, { action: "assignment.read", project }, { action: "attempt.work", project }]);
        const t1 = await task("one", agentA), t2 = await task("two", agentA), t3 = await task("three", agentB), t4 = await task("four", agentC);
        const gen = makeGen(pauses);
        await body({
          owner, project, other, t1, t2, t3, t4, agentA, agentB, agentC, teamParent, teamChild, pauses, gen, effects, assignments, projects, waits, inbox, blockers, conv, config, policy, stall, reconciler,
          hooked: (hooks) => makeGen(pauses, hooks),
          hookedPauses: (hooks) => PauseService.withEpoch(world.storage, epoch, { waits }, { ...options, testHooks: hooks }),
          reopen: () => { const p = PauseService.withEpoch(world.storage, epoch, { waits }, options); return { pauses: p, gen: makeGen(p) }; },
          ann: await plain("ann", [{ action: "attempt.work", project }, { action: "effect.perform", project }]), mgr,
          amgr: await plain("amgr", [{ action: "agent.manage", project: "*" }, { action: "agent.read", project: "*" }]),
          pat: await plain("pat", [{ action: "attempt.work", project }]),
          eve: await plain("eve", [{ action: "assignment.manage", project: other }, { action: "attempt.work", project: other }]),
          asA: await grantAgent(agentA, []), asB: await grantAgent(agentB, []),
          pauseTask: (taskId, extra = {}) => pauses.pause(mgr, { commandId: cid("pz"), scope: { kind: "task", id: taskId }, reason: "hold for the owner", ...extra }),
          task, grantAgent, storage: world.storage, epoch,
        });
      } finally { await world.close(); }
    });

  const begin = async (gen: GenerationService, p: Principal, taskId: string) => (await gen.begin(p, { commandId: cid("begin"), taskId, contextRevision: 1 })).id;
  const finishedWithCall = async (gen: GenerationService, p: Principal, taskId: string) => {
    const run = await begin(gen, p, taskId);
    await gen.record(p, { commandId: cid("c"), runId: run, seq: 1, toolCall: { id: "c1", name: "push", argumentsDelta: '{"ref":"main"}', done: true } });
    await gen.complete(p, { commandId: cid("done"), runId: run });
    return run;
  };
  const admit = (gen: GenerationService, p: Principal, runId: string) => gen.admitEffect(p, { commandId: cid("admit"), runId, toolCallId: "c1", kind: "git-push", target: "repo:main" });
  const derivedBg = (principalId: string, commandId: string): string => derivedId("pbg", scopedCommandId(principalId, commandId));
  const agentScope = (id: string): PauseScope => ({ kind: "agent", id });
  const blocked = async (c: Ctx, taskId: string): Promise<boolean> => (await c.pauses.guard(taskId)).blockedBy.length > 0;

  suite("pause retains the owner and blocks new foreground work, across a restart; resume lifts it", async (c) => {
    const outside = new Outside();
    const run = await finishedWithCall(c.gen, c.ann, c.t1);
    const before = (await c.assignments.getAssignment(c.t1))!;
    const paused = await c.pauseTask(c.t1);
    // The request records actor, scope, mode, operation ID and the policy revision in force.
    const request = (await c.pauses.requests(c.owner, { kind: "task", id: c.t1 }))[0]!;
    assert.deepEqual([request.actor, request.scope, request.mode, request.action, request.seq, request.id], ["agent:mgr", { kind: "task", id: c.t1 }, "pause", "pause", 1, paused.requestId]);
    assert.match(request.operationId, /^pz-\d+$/);
    assert.deepEqual(request.policyRevision, { installation: 0 });
    const gate = (await c.pauses.gate(c.mgr, { kind: "task", id: c.t1 }))!;
    assert.deepEqual([gate.intent, gate.owner, gate.mode, gate.observed?.state], ["pause", "agent:mgr", "pause", "pausing"]);
    // The assignment is untouched: the pause retains the owner.
    assert.deepEqual(await c.assignments.getAssignment(c.t1), before);
    // New foreground work is refused: a new generation, an admission, the start of an effect, an effect started any other way.
    await refusedFor("paused", () => begin(c.gen, c.ann, c.t1));
    await refusedFor("paused", () => admit(c.gen, c.ann, run));
    await assert.rejects(() => c.effects.intend({ commandId: cid("i"), actor: c.owner.id, kind: "git-push", target: "x", input: {}, taskId: c.t1 }).then((e) => c.effects.run(e.id, outside.bridge(), { beforeStart: c.pauses.guardFor(c.t1) })), PauseRefused);
    await refusedFor("paused", async () => { const g = c.gen.guardFor(c.t1); await g(); });
    assert.equal(outside.executions.length, 0);
    // Another task of the same agent is not touched by a task-level pause.
    await begin(c.gen, c.ann, c.t2);
    // A restart (new service objects over the same store) changes nothing.
    const again = c.reopen();
    assert.equal((await again.pauses.status(c.mgr, c.t1))!.paused, true);
    await refusedFor("paused", () => begin(again.gen, c.ann, c.t1));
    // Repeating the request is answered by the first one; asking again afresh is refused.
    const repeat = await c.pauses.pause(c.mgr, { commandId: "same", scope: { kind: "task", id: c.t3 }, reason: "x" });
    const repeat2 = await again.pauses.pause(c.mgr, { commandId: "same", scope: { kind: "task", id: c.t3 }, reason: "x" });
    assert.deepEqual([repeat2.replayed, repeat2.requestId], [true, repeat.requestId]);
    await refuses("invalid_command", () => c.pauseTask(c.t1), (e) => assert.match(e.message, /already paused/));
    // Resume lifts it, and only then: the call admitted nothing while paused, so it is admitted now.
    const resumed = await c.pauses.resume(c.mgr, { commandId: cid("rs"), scope: { kind: "task", id: c.t1 }, reason: "go" });
    assert.deepEqual(resumed.stillPausedBy, []);
    await refuses("invalid_command", () => c.gen.execute(c.ann, { runId: run, toolCallId: "c1" }, outside.bridge()), (e) => assert.match(e.message, /not an admitted tool call/));
    await admit(c.gen, c.ann, run);
    assert.equal((await c.gen.execute(c.ann, { runId: run, toolCallId: "c1" }, outside.bridge())).status, "confirmed");
    assert.equal((await c.pauses.requests(c.owner, { kind: "task", id: c.t1 })).length, 2);
    await refuses("invalid_command", () => c.pauses.resume(c.mgr, { commandId: cid("rs"), scope: { kind: "task", id: c.t1 }, reason: "again" }), (e) => assert.match(e.message, /not paused/));
  });

  suite("a pause is lifted by the owner's recorded time and by nothing else, and only that scope (card L06b)", async (c) => {
    const task = { kind: "task", id: c.t1 } as const;
    const sibling = { kind: "task", id: c.t2 } as const;
    await c.pauseTask(c.t1);
    await c.pauseTask(c.t2);
    const dispatcher = c.owner;
    // No recorded condition: time passing lifts nothing.
    now += 3 * 86_400_000;
    assert.deepEqual(await c.pauses.liftDue(dispatcher), []);
    assert.equal(await c.pauses.isPaused(c.t1), true);
    // Only the owner records one; it is a UTC time; the pause must be in force.
    await refuses("forbidden", () => c.pauses.setResumeCondition(c.mgr, { commandId: cid("rc"), scope: task, at: new Date(now + 3_600_000).toISOString() }));
    await refuses("invalid_command", () => c.pauses.setResumeCondition(c.owner, { commandId: cid("rc"), scope: task, at: "tomorrow morning" }));
    await refuses("invalid_command", () => c.pauses.setResumeCondition(c.owner, { commandId: cid("rc"), scope: task, at: "2030-01-01T08:00:00" }), (e) => assert.match(e.message, /zone/));
    await refuses("invalid_command", () => c.pauses.setResumeCondition(c.owner, { commandId: cid("rc"), scope: { kind: "task", id: c.t3 }, at: new Date(now + 3_600_000).toISOString() }));
    const at = new Date(now + 3_600_000).toISOString();
    const set = await c.pauses.setResumeCondition(c.owner, { commandId: "rc-fixed", scope: task, at });
    assert.equal((await c.pauses.setResumeCondition(c.owner, { commandId: "rc-fixed", scope: task, at })).replayed, true);
    assert.equal(set.replayed, false);
    // Before the time: nothing. The agent cannot lift it either, nor can the tick be run by anyone but the dispatcher.
    assert.deepEqual(await c.pauses.liftDue(dispatcher), []);
    await refuses("forbidden", () => c.pauses.liftDue(c.mgr));
    now += 3_600_001;
    assert.deepEqual(await c.pauses.liftDue(dispatcher), [task], "the scope that has a condition is lifted");
    assert.equal(await c.pauses.isPaused(c.t1), false);
    assert.equal(await c.pauses.isPaused(c.t2), true, "a sibling with no condition stays paused");
    assert.deepEqual(await c.pauses.liftDue(dispatcher), [], "a repeat of the tick lifts nothing twice");
    const lift = (await c.pauses.requests(c.owner, task)).at(-1)!;
    assert.deepEqual([lift.action, lift.actor], ["resume", dispatcher.id]);
    assert.match(lift.reason, /recorded condition/);
    // A pause again starts without the old condition; one resumed by hand loses it too.
    await c.pauseTask(c.t1);
    now += 86_400_000;
    assert.deepEqual(await c.pauses.liftDue(dispatcher), []);
    await c.pauses.setResumeCondition(c.owner, { commandId: cid("rc"), scope: sibling, at: new Date(now + 1000).toISOString() });
    await c.pauses.resume(c.mgr, { commandId: cid("rs"), scope: sibling, reason: "by hand" });
    await c.pauseTask(c.t2);
    now += 5000;
    assert.deepEqual(await c.pauses.liftDue(dispatcher), [], "a condition belongs to the pause it was set for");
    assert.equal(await c.pauses.isPaused(c.t2), true);
    await c.pauses.resume(c.mgr, { commandId: cid("rs"), scope: sibling, reason: "done" });
    await c.pauses.resume(c.mgr, { commandId: cid("rs"), scope: task, reason: "done" });
  });

  suite("a lift loses to a pause changed after the tick read it, and one gate failing does not stop the others (card L06b)", async (c) => {
    const task = { kind: "task", id: c.t1 } as const;
    const other = { kind: "task", id: c.t2 } as const;
    const due = () => new Date(now + 1000).toISOString();
    const at = (t: typeof task) => c.pauses.setResumeCondition(c.owner, { commandId: cid("rc"), scope: t, at: due() });
    // The gate is read as due, then resumed by hand and paused again (a new request, no time): the tick must leave the new pause alone.
    await c.pauseTask(c.t1);
    await at(task);
    now += 5000;
    let fired = false;
    const again = c.hookedPauses({ beforeLift: async () => { if (!fired) { fired = true; await c.pauses.resume(c.mgr, { commandId: cid("rs"), scope: task, reason: "by hand" }); await c.pauseTask(c.t1); } } });
    assert.deepEqual(await again.liftDue(c.owner), [], "a pause made again is not lifted by the old condition");
    assert.equal(fired, true);
    assert.equal(await c.pauses.isPaused(c.t1), true);
    // The same when the owner gave the same pause a later time meanwhile.
    await at(task);
    now += 5000;
    fired = false;
    const later = c.hookedPauses({ beforeLift: async () => { if (!fired) { fired = true; await c.pauses.setResumeCondition(c.owner, { commandId: cid("rc"), scope: task, at: new Date(now + 3_600_000).toISOString() }); } } });
    assert.deepEqual(await later.liftDue(c.owner), [], "a later time is not this condition's to lift");
    assert.equal(await c.pauses.isPaused(c.t1), true);
    // One gate that cannot be lifted does not hold up the other; the first failure is raised after the scan, and the lifted scopes come through the callback.
    await c.pauseTask(c.t2);
    await at(task);
    await at(other);
    now += 5000;
    const broken = c.hookedPauses({ beforeLift: async (scope) => { if (scope.id === c.t1) throw new Error("lift broke"); } });
    const got: PauseScope[] = [];
    await assert.rejects(() => broken.liftDue(c.owner, (s) => got.push(s)), /lift broke/);
    assert.deepEqual(got, [other], "the other gate was lifted");
    assert.equal(await c.pauses.isPaused(c.t2), false);
    assert.equal(await c.pauses.isPaused(c.t1), true, "the failing gate stays paused");
    await c.pauses.resume(c.mgr, { commandId: cid("rs"), scope: task, reason: "done" });
  });

  suite("the policy revision in force is recorded with the request", async (c) => {
    await c.policy.set(c.owner, { commandId: cid("pol"), scope: "installation", profile: "derived" });
    await c.pauseTask(c.t1);
    assert.deepEqual((await c.pauses.requests(c.owner, { kind: "task", id: c.t1 }))[0]!.policyRevision, { installation: 1 });
  });

  suite("observed execution is recorded apart from intent: pausing until a safe boundary is stated, never promoted by time", async (c) => {
    const run = await begin(c.gen, c.ann, c.t1);
    await c.pauseTask(c.t1);
    const obs = (state: string, extra: Record<string, unknown> = {}, who: Principal = c.mgr, scope: PauseScope = { kind: "task", id: c.t1 }) =>
      c.pauses.observe(who, { commandId: cid("ob"), scope, state: state as never, ...extra });
    const state = async () => { const g = (await c.pauses.gate(c.mgr, { kind: "task", id: c.t1 }))!; return [g.intent, g.observed?.state]; };
    assert.deepEqual(await state(), ["pause", "pausing"]);
    // A day passes: still pausing.
    now += 24 * 3_600_000;
    assert.deepEqual(await state(), ["pause", "pausing"]);
    // Paused needs a safe-boundary statement, and an uncooperative tool cannot give one; a streaming generation is not a boundary.
    await refuses("invalid_command", () => obs("paused"), (e) => assert.match(e.message, /safe-boundary/));
    await refuses("invalid_command", () => obs("paused", { boundary: "uncooperative" }), (e) => assert.match(e.message, /uncooperative/));
    await refuses("invalid_command", () => obs("paused", { boundary: "finished" }), (e) => assert.match(e.message, /streaming/));
    await c.gen.complete(c.ann, { commandId: cid("done"), runId: run });
    await obs("paused", { boundary: "finished", evidence: "step done, result recorded" });
    assert.deepEqual(await state(), ["pause", "paused"]);
    // Other observations are recorded as reported, while the intent stays.
    for (const s of ["recovery-required", "unreachable", "stopping"]) { await obs(s, { evidence: "reported by the host" }); assert.deepEqual(await state(), ["pause", s]); }
    await refuses("invalid_command", () => obs("zombie"));
    // The assigned agent's own runtime may report; a stranger may not.
    await obs("pausing", {}, c.asA);
    await refuses("forbidden", () => obs("pausing", {}, c.asB));
    await refuses("forbidden", () => obs("pausing", {}, c.pat));
    // Resume clears the observation with the intent; there is nothing to observe afterwards.
    await c.pauses.resume(c.mgr, { commandId: cid("rs"), scope: { kind: "task", id: c.t1 }, reason: "go" });
    const g = (await c.pauses.gate(c.mgr, { kind: "task", id: c.t1 }))!;
    assert.deepEqual([g.intent, g.observed, g.owner], ["active", undefined, undefined]);
    await refuses("invalid_command", () => obs("running"), (e) => assert.match(e.message, /not paused/));
  });

  suite("an agent-level pause spans all its tasks; a task-level pause leaves a separately authorized response task free and does not restart the paused one", async (c) => {
    await c.pauses.pause(c.amgr, { commandId: cid("pz"), scope: agentScope(c.agentA), reason: "agent A rests" });
    for (const t of [c.t1, c.t2]) { assert.equal(await blocked(c, t), true); await refusedFor("paused", () => begin(c.gen, c.ann, t)); }
    await begin(c.gen, c.ann, c.t3);
    await begin(c.gen, c.ann, c.t4);
    assert.deepEqual((await c.pauses.status(c.mgr, c.t2))!.gates.map((g) => g.scope), [agentScope(c.agentA)]);
    await c.pauses.resume(c.amgr, { commandId: cid("rs"), scope: agentScope(c.agentA), reason: "back" });
    // Task-level: t1 is paused, t2 (a response or meeting task of the same agent) is not.
    await c.pauseTask(c.t1);
    await begin(c.gen, c.ann, c.t2);
    const meeting = await c.gen.begin(c.ann, { commandId: cid("b"), taskId: c.t2, contextRevision: 1 });
    await c.gen.complete(c.ann, { commandId: cid("done"), runId: meeting.id });
    assert.equal(await blocked(c, c.t1), true, "the response task finishing does not restart the paused task");
    await refusedFor("paused", () => begin(c.gen, c.ann, c.t1));
    // Resuming the task while its agent is paused leaves it blocked, and says why.
    await c.pauses.pause(c.amgr, { commandId: cid("pz"), scope: agentScope(c.agentA), reason: "agent A rests" });
    const r = await c.pauses.resume(c.mgr, { commandId: cid("rs"), scope: { kind: "task", id: c.t1 }, reason: "task ok" });
    assert.deepEqual(r.stillPausedBy, [agentScope(c.agentA)]);
    assert.equal(await blocked(c, c.t1), true);
    const r2 = await c.pauses.resume(c.amgr, { commandId: cid("rs"), scope: agentScope(c.agentA), reason: "back" });
    assert.deepEqual(r2.stillPausedBy, []);
    assert.equal(await blocked(c, c.t1), false);
  });

  suite("team and installation pauses reach down the chain; resuming a lower gate lifts only that gate", async (c) => {
    const team: PauseScope = { kind: "team", id: c.teamParent };
    await c.pauses.pause(c.amgr, { commandId: cid("pz"), scope: team, reason: "team freeze" });
    // t1 (agent A in the child team) and t4 (agent C in the parent team) are blocked; t3 (agent B, no team) is not.
    assert.deepEqual([await blocked(c, c.t1), await blocked(c, c.t4), await blocked(c, c.t3)], [true, true, false]);
    assert.equal(await c.pauses.availability(`agent:${c.agentA}`), "paused");
    assert.equal(await c.pauses.availability(`agent:${c.agentB}`), "available");
    await c.pauses.pause(c.amgr, { commandId: cid("pz"), scope: agentScope(c.agentA), reason: "also A" });
    const lifted = await c.pauses.resume(c.amgr, { commandId: cid("rs"), scope: agentScope(c.agentA), reason: "A ok" });
    assert.deepEqual(lifted.stillPausedBy, [team]);
    assert.equal(await blocked(c, c.t1), true, "the team gate still holds");
    // Installation: owner only; everything stops.
    await refuses("forbidden", () => c.pauses.pause(c.amgr, { commandId: cid("pz"), scope: { kind: "installation", id: "installation" }, reason: "all" }));
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "installation", id: "installation" }, reason: "all" });
    assert.deepEqual([await blocked(c, c.t3), await c.pauses.isPaused(c.t3)], [true, true]);
    const res = await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: { kind: "installation", id: "installation" }, reason: "ok" });
    assert.deepEqual(res.stillPausedBy, []);
    assert.deepEqual([await blocked(c, c.t3), await blocked(c, c.t1)], [false, true]);
    await c.pauses.resume(c.amgr, { commandId: cid("rs"), scope: team, reason: "thaw" });
    assert.equal(await blocked(c, c.t1), false);
  });

  suite("a manual pause never gains a return: no condition exists, and time, a meeting, messages and applied configuration leave it in place", async (c) => {
    await c.pauses.pause(c.amgr, { commandId: cid("pz"), scope: agentScope(c.agentA), reason: "manual" });
    await refuses("invalid_command", () => c.pauses.pause(c.amgr, { commandId: cid("pz"), scope: agentScope(c.agentB), reason: "x", returnAt: "2026-10-23T00:00:00.000Z" } as never), (e) => assert.match(e.message, /returnAt/));
    const frozen = (await c.pauses.gate(c.owner, agentScope(c.agentA)))!;
    assert.equal("returnAt" in frozen || "returnCondition" in frozen, false);
    // A "meeting": the agent's other task is met by another agent's task of the same project; time passes; a message arrives.
    now += 72 * 3_600_000;
    const asC = await c.grantAgent(c.agentC, [{ action: "conversation.start", project: c.project }, { action: "conversation.send", project: c.project }, { action: "conversation.receive", project: c.project }]);
    const asA = await c.grantAgent(c.agentA, [{ action: "conversation.start", project: c.project }, { action: "conversation.send", project: c.project }, { action: "conversation.receive", project: c.project }]);
    const thread = await c.conv.start(asC, { commandId: cid("s"), projectId: c.project, subject: "meeting", to: [`agent:${c.agentA}`], kind: "question", text: "can we meet?" });
    await c.conv.send(asC, { commandId: cid("m"), threadId: thread.threadId, text: "urgent", priority: "urgent" } as never).catch(() => undefined);
    await c.conv.send(asA, { commandId: cid("m"), threadId: thread.threadId, text: "I am paused, but I read this" }).catch(() => undefined);
    // Configuration applied or reloaded (U10) leaves the pause alone.
    const staged = await c.config.stage(c.owner, { commandId: cid("st"), layer: "installation", set: { "workClass.pcFloor": 10 } });
    assert.equal((await c.config.apply(c.owner, { commandId: cid("ap"), layer: "installation", expectedRevision: staged.revision })).applied, true);
    const staged2 = await c.config.stage(c.owner, { commandId: cid("st"), layer: "agent", scopeId: c.agentA, set: { "workClass.pcFloor": 20 } });
    assert.equal((await c.config.apply(c.owner, { commandId: cid("ap"), layer: "agent", scopeId: c.agentA, expectedRevision: staged2.revision })).applied, true);
    await c.config.effective(c.owner, { agentId: c.agentA });
    const after_ = (await c.pauses.gate(c.owner, agentScope(c.agentA)))!;
    assert.deepEqual([after_.revision, after_.intent, after_.owner, after_.requestId], [frozen.revision, "pause", "agent:amgr", frozen.requestId], "not one write to the gate");
    assert.equal(await blocked(c, c.t1), true);
    // Only a resume lifts it; the task kept its assignment throughout.
    assert.equal((await c.assignments.getAssignment(c.t1))!.owner!.id, c.agentA);
    await c.pauses.resume(c.amgr, { commandId: cid("rs"), scope: agentScope(c.agentA), reason: "done" });
    assert.equal(await blocked(c, c.t1), false);
  });

  suite("a background result is recorded without unpausing, and answers the typed wait it resolves", async (c) => {
    const t = await c.task("waits for a build", c.agentA);
    await c.projects.transitionTask({ commandId: cid("ip"), actor: c.owner.id, taskId: t, expectedRevision: (await c.projects.getTask(t))!.revision, to: "in_progress" });
    const opened = await c.waits.openWait({ commandId: cid("w"), actor: c.owner.id, taskId: t, reason: "external", resolver: `agent:${c.agentA}`, summary: "build job 7", nextAction: "continue", indefinite: { owner: "rob" } });
    await c.pauseTask(t);
    const wait = (await c.waits.openFor(t))!;
    assert.equal(wait.id, opened.id);
    const command = { commandId: "bg-1", taskId: t, jobRef: "build-7", outcome: "succeeded" as const, summary: "built and uploaded", answerWait: { waitId: wait.id, expectedRevision: wait.revision, answer: "build 7 passed" } };
    // Recording a result does not let anyone answer a wait meant for someone else: a manager is not its resolver, a plain worker may not record at all.
    await refuses("forbidden", () => c.pauses.recordBackground(c.mgr, { ...command, commandId: "bg-no" }), (e) => assert.match(e.message, /not the resolver/));
    await refuses("forbidden", () => c.pauses.recordBackground(c.ann, { ...command, commandId: "bg-no2" }));
    assert.equal((await c.waits.getWait(wait.id))!.state, "open");
    // The actual resolver (here also the assigned agent) records and answers.
    const result = await c.pauses.recordBackground(c.asA, command);
    assert.deepEqual([result.pausedBy, result.answeredWaitId, result.replayed], [[{ kind: "task", id: t }], wait.id, false]);
    // The dependency is resolved; the task is no longer blocked by the wait; it is still paused and cannot start.
    assert.equal((await c.waits.getWait(wait.id))!.state, "answered");
    assert.notEqual((await c.projects.getTask(t))!.state, "blocked");
    assert.equal((await c.pauses.gate(c.owner, { kind: "task", id: t }))!.intent, "pause");
    await refusedFor("paused", () => begin(c.gen, c.ann, t));
    const record = (await c.pauses.background(c.mgr, result.id))!;
    assert.deepEqual([record.jobRef, record.outcome, record.recordedBy, record.pausedBy, record.answeredWaitId], ["build-7", "succeeded", c.asA.id, [{ kind: "task", id: t }], wait.id]);
    // The same command again is answered by the record; the wait is not answered twice.
    const again = await c.pauses.recordBackground(c.asA, command);
    assert.deepEqual([again.replayed, again.id], [true, result.id]);
    // The assigned agent may record too; a stranger may not; another task's wait may not be answered; credentials are not recorded.
    await refuses("forbidden", () => c.pauses.recordBackground(c.eve, { commandId: cid("bg"), taskId: t, jobRef: "j", outcome: "failed", summary: "x" }));
    await c.pauses.recordBackground(c.mgr, { commandId: cid("bg"), taskId: t, jobRef: "j2", outcome: "failed", summary: "lint failed" });
    await refuses("invalid_command", () => c.pauses.recordBackground(c.mgr, { commandId: cid("bg"), taskId: c.t1, jobRef: "j", outcome: "succeeded", summary: "x", answerWait: { waitId: wait.id, expectedRevision: 1, answer: "no" } }), (e) => assert.match(e.message, /not a wait of this task/));
    await refuses("invalid_command", () => c.pauses.recordBackground(c.mgr, { commandId: cid("bg"), taskId: t, jobRef: "j", outcome: "succeeded", summary: "token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" }));
    // A pause that denies background work refuses results until resumed (the owner may also answer a wait on its resolver's behalf: see the next test).
    await c.pauses.resume(c.mgr, { commandId: cid("rs"), scope: { kind: "task", id: t }, reason: "ok" });
    await c.pauseTask(t, { background: "deny" });
    await refuses("invalid_command", () => c.pauses.recordBackground(c.mgr, { commandId: cid("bg"), taskId: t, jobRef: "j3", outcome: "succeeded", summary: "x" }), (e) => assert.match(e.message, /background work denied/));
  });

  suite("messages to a paused agent are queued and reach its inbox without resuming it; task-level pause leaves the agent available", async (c) => {
    const grantsAll: Grant[] = ["conversation.start", "conversation.send", "conversation.receive"].map((action) => ({ action, project: c.project }));
    const asA = await c.grantAgent(c.agentA, grantsAll);
    const asB = await c.grantAgent(c.agentB, grantsAll);
    await c.pauseTask(c.t1);
    const first = await c.conv.start(asB, { commandId: cid("s"), projectId: c.project, subject: "hello", to: [`agent:${c.agentA}`], kind: "question", text: "ready?" });
    assert.equal((await c.conv.read(asA, { threadId: first.threadId }))!.items[0]!.availability, "ready", "a task-level pause does not make the agent unavailable");
    await c.pauses.pause(c.amgr, { commandId: cid("pz"), scope: agentScope(c.agentA), reason: "rest" });
    const gate = (await c.pauses.gate(c.owner, agentScope(c.agentA)))!;
    const sent = await c.conv.send(asB, { commandId: cid("m"), threadId: first.threadId, text: "are you there?", kind: "question" });
    void sent;
    const view = (await c.conv.read(asA, { threadId: first.threadId }))!;
    assert.equal(view.items.at(-1)!.availability, "queued", "kept and reported as queued");
    assert.equal((await c.conv.unread(asA)).threads[0]!.count, 2, "it reaches the inbox");
    await refuses("unavailable", () => c.conv.send(asA, { commandId: cid("m"), threadId: first.threadId, text: "replying while paused" }), (e) => assert.match(e.message, /paused/));
    const same = (await c.pauses.gate(c.owner, agentScope(c.agentA)))!;
    assert.deepEqual([same.revision, same.intent], [gate.revision, "pause"], "no message lifted the hold");
    // A paused agent cannot send; after the resume new messages to it are ready again.
    await c.pauses.resume(c.amgr, { commandId: cid("rs"), scope: agentScope(c.agentA), reason: "back" });
    await c.conv.send(asB, { commandId: cid("m"), threadId: first.threadId, text: "welcome back", kind: "question" });
    assert.equal((await c.conv.read(asA, { threadId: first.threadId }))!.items.at(-1)!.availability, "ready");
  });

  suite("the reconciler leaves a paused task's inbox message received and admits it after the resume", async (c) => {
    const assignment = (await c.assignments.getAssignment(c.t1))!;
    const message = await c.inbox.receive({ source: "worker-1", deliveryId: assignmentEventId(c.t1, assignment.revision), sequence: assignment.revision, payload: { taskId: c.t1, revision: assignment.revision, generation: assignment.generation, state: "assigned", owner: assignment.owner as unknown as JsonObject, change: "assigned" } });
    await c.pauses.pause(c.amgr, { commandId: cid("pz"), scope: agentScope(c.agentA), reason: "rest" });
    for (let i = 0; i < 2; i++) {
      const report = await c.reconciler().runPass();
      assert.equal(report.inboxHeld, 1);
      assert.equal(report.inboxAdmitted, 0);
    }
    assert.equal((await c.inbox.getByDelivery("worker-1", assignmentEventId(c.t1, assignment.revision)))!.state, "received", "the message is held, not lost");
    assert.equal((await c.assignments.getAssignment(c.t1))!.attempts, 0);
    await c.pauses.resume(c.amgr, { commandId: cid("rs"), scope: agentScope(c.agentA), reason: "back" });
    const report = await c.reconciler().runPass();
    assert.equal(report.inboxAdmitted, 1);
    assert.equal((await c.assignments.getAssignment(c.t1))!.attempts, 1);
    // What is guaranteed about the race: the reconciler's check is a plain read, so an attempt may be admitted just as a pause lands; no foreground work starts from it, because begin, admit and execute are guarded in their own commits.
    await c.pauses.pause(c.amgr, { commandId: cid("pz"), scope: agentScope(c.agentA), reason: "rest again" });
    await refusedFor("paused", () => begin(c.gen, c.ann, c.t1));
    await c.pauses.resume(c.amgr, { commandId: cid("rs"), scope: agentScope(c.agentA), reason: "back" });
    // The pause and a manual_hold blocker are independent: resolving one does not lift the other.
    await c.pauseTask(c.t3);
    const hold = await c.blockers.openBlocker({ commandId: cid("hold"), actor: c.owner.id, type: "manual_hold", subject: { kind: "task", id: c.t3 }, summary: "owner hold", resolver: "rob" });
    await c.blockers.resolveBlocker({ commandId: cid("res"), actor: c.owner.id, blockerId: hold.id, expectedRevision: hold.revision, resolution: "ok" });
    assert.equal(await c.pauses.isPaused(c.t3), true);
  });

  suite("a paused agent keeps its tasks despite an idle replacement, an urgent deadline or elapsed time; the stall detector does not call it stalled", async (c) => {
    await c.pauses.assertRetained(c.t1, "idle_replacement");
    const before = (await c.assignments.getAssignment(c.t1))!;
    await c.pauses.pause(c.amgr, { commandId: cid("pz"), scope: agentScope(c.agentA), reason: "rest" });
    now += 30 * 24 * 3_600_000;
    for (const trigger of ["idle_replacement", "urgent_deadline", "elapsed_time"] as const) await refuses("invalid_command", () => c.pauses.assertRetained(c.t1, trigger), (e) => assert.match(e.message, /assignment is kept/));
    await refuses("invalid_command", () => c.pauses.assertRetained(c.t1, "bored" as never));
    await c.pauses.assertRetained(c.t3, "idle_replacement");
    assert.deepEqual(await c.assignments.getAssignment(c.t1), before);
    const a = (await c.stall.assess(c.owner, c.t1))!;
    assert.deepEqual([a.status, a.concerns], ["paused", []]);
    await c.pauses.resume(c.amgr, { commandId: cid("rs"), scope: agentScope(c.agentA), reason: "back" });
    assert.notEqual((await c.stall.assess(c.owner, c.t1))!.status, "paused");
  });

  suite("authority: pause and resume need the scope's authority; unreadable targets read like missing ones; input is bounded", async (c) => {
    await refuses("forbidden", () => c.pauses.pause(c.pat, { commandId: cid("pz"), scope: { kind: "task", id: c.t1 }, reason: "x" }));
    await refuses("forbidden", () => c.pauses.pause(c.eve, { commandId: cid("pz"), scope: { kind: "task", id: c.t1 }, reason: "x" }));
    await refuses("forbidden", () => c.pauses.pause(c.mgr, { commandId: cid("pz"), scope: agentScope(c.agentA), reason: "x" }));
    await refuses("forbidden", () => c.pauses.pause(c.asA, { commandId: cid("pz"), scope: agentScope(c.agentA), reason: "self" }));
    await refuses("not_found", () => c.pauses.pause(c.amgr, { commandId: cid("pz"), scope: agentScope("agt-aaaaaaaaaaaaaaaaaaaa"), reason: "x" }));
    await refuses("not_found", () => c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "task", id: "task-aaaaaaaaaaaaaaaaaaaa" }, reason: "x" }));
    await refuses("invalid_command", () => c.pauses.pause(c.mgr, { commandId: cid("pz"), scope: { kind: "task", id: c.t1 }, reason: "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" }));
    await refuses("invalid_command", () => c.pauses.pause(c.mgr, { commandId: cid("pz"), scope: { kind: "task", id: c.t1 }, reason: "x".repeat(501) }));
    await refuses("invalid_command", () => c.pauses.pause(c.mgr, { commandId: cid("pz"), scope: { kind: "planet", id: "x" } as never, reason: "x" }));
    await refuses("invalid_command", () => c.pauses.pause(c.mgr, { commandId: cid("pz"), scope: { kind: "task", id: c.t1 }, reason: "x", background: "maybe" as never }));
    await c.pauseTask(c.t1);
    // A resumer needs the same authority; a stranger sees nothing of the gate.
    await refuses("forbidden", () => c.pauses.resume(c.pat, { commandId: cid("rs"), scope: { kind: "task", id: c.t1 }, reason: "x" }));
    await refuses("forbidden", () => c.pauses.resume(c.asA, { commandId: cid("rs"), scope: { kind: "task", id: c.t1 }, reason: "self-resume" }));
    assert.equal(await c.pauses.gate(c.eve, { kind: "task", id: c.t1 }), undefined);
    assert.equal(await c.pauses.status(c.eve, c.t1), undefined);
    assert.equal((await c.pauses.status(c.asA, c.t1))!.paused, true, "the assigned agent can see that it is paused");
    assert.deepEqual(await c.pauses.requests(c.eve, { kind: "task", id: c.t1 }), []);
    // A done task cannot be paused.
    const done = await c.task("finished");
    await c.projects.transitionTask({ commandId: cid("c"), actor: c.owner.id, taskId: done, expectedRevision: 2, to: "cancelled" });
    await refuses("invalid_command", () => c.pauses.pause(c.mgr, { commandId: cid("pz"), scope: { kind: "task", id: done }, reason: "x" }));
  });

  suite("a pause landing between the check and the start of an effect still stops it", async (c) => {
    const outside = new Outside();
    const run = await finishedWithCall(c.gen, c.ann, c.t1);
    await admit(c.gen, c.ann, run);
    let fired = false;
    const hooked = c.hooked({ afterGuardRead: async () => { if (!fired) { fired = true; await c.pauses.pause(c.amgr, { commandId: cid("pz"), scope: agentScope(c.agentA), reason: "rest" }); } } });
    await refusedFor("paused", () => hooked.execute(c.ann, { runId: run, toolCallId: "c1" }, outside.bridge()));
    assert.equal(fired, true);
    assert.equal(outside.executions.length, 0, "the effect never started");
  });

  suite("racing pauses and admissions: each admission is strictly before or after the pause", async (c) => {
    const outside = new Outside();
    for (let round = 0; round < 6; round++) {
      const t = await c.task(`race ${round}`, c.agentB);
      const run = await finishedWithCall(c.gen, c.ann, t);
      const [admitted, paused] = await Promise.allSettled([admit(c.gen, c.ann, run), c.pauses.pause(c.mgr, { commandId: cid("pz"), scope: { kind: "task", id: t }, reason: "race" })]);
      assert.equal(paused.status, "fulfilled");
      if (admitted.status === "rejected") assert.ok(admitted.reason instanceof GenerationRefused && admitted.reason.reason === "paused", String(admitted.reason));
      // Whatever happened, nothing starts now.
      await refusedFor("paused", () => c.gen.execute(c.ann, { runId: run, toolCallId: "c1" }, outside.bridge()).catch((e) => { if (e instanceof DomainError && e.field === "toolCallId") throw new GenerationRefused("paused", "never admitted"); throw e; }));
    }
    assert.equal(outside.executions.length, 0);
    const t = await c.task("begin race", c.agentB);
    const [b, p] = await Promise.allSettled([begin(c.gen, c.ann, t), c.pauses.pause(c.mgr, { commandId: cid("pz"), scope: { kind: "task", id: t }, reason: "race" })]);
    assert.equal(p.status, "fulfilled");
    void b;
    await refusedFor("paused", () => begin(c.gen, c.ann, t));
  });
  suite("a pause landing between the pause read and the commit of begin or admitEffect refuses it, also when no gate existed before; nothing is recorded", async (c) => {
    // begin: t3 (agent B) has never been checked, so none of its gates exist yet.
    let fired = false;
    const hookedBegin = c.hooked({ afterPauseRead: async () => { if (!fired) { fired = true; await c.pauses.pause(c.amgr, { commandId: cid("pz"), scope: agentScope(c.agentB), reason: "rest" }); } } });
    await refusedFor("paused", () => hookedBegin.begin(c.ann, { commandId: cid("b"), taskId: c.t3, contextRevision: 1 }));
    assert.equal(fired, true);
    assert.equal(await c.storage.getAggregate({ kind: "generation-run", id: GenerationService.runIdOf(c.t3, 1) }), undefined, "no generation was recorded");
    // admitEffect: the generation is finished and its gates exist; a pause lands before the commit.
    const run = await finishedWithCall(c.gen, c.ann, c.t1);
    let fired2 = false;
    const hookedAdmit = c.hooked({ afterPauseRead: async () => { if (!fired2) { fired2 = true; await c.pauseTask(c.t1); } } });
    await refusedFor("paused", () => admit(hookedAdmit, c.ann, run));
    assert.equal(fired2, true);
    assert.equal((await c.gen.view(c.ann, run))!.run.toolCalls[0]!.state, "complete");
    assert.equal((await c.storage.listAggregates("effect", { limit: 10 })).length, 0, "no effect intent was recorded");
  });

  suite("a reassignment or a move between teams racing a check cannot slip past a pause", async (c) => {
    await c.pauses.pause(c.amgr, { commandId: cid("pz"), scope: agentScope(c.agentB), reason: "B rests" });
    // t4 belongs to agent C (unpaused). Between the read and the commit it is transferred to the paused agent B.
    let fired = false;
    const hooked = c.hooked({ afterPauseRead: async () => {
      if (fired) return;
      fired = true;
      const a = (await c.assignments.getAssignment(c.t4))!;
      await c.assignments.transferTask({ commandId: cid("tr"), actor: c.owner.id, taskId: c.t4, expectedRevision: a.revision, to: { kind: "agent", id: c.agentB } });
    } });
    await refusedFor("paused", () => hooked.begin(c.ann, { commandId: cid("b"), taskId: c.t4, contextRevision: 1 }));
    assert.equal(fired, true);
    assert.equal(await c.storage.getAggregate({ kind: "generation-run", id: GenerationService.runIdOf(c.t4, 1) }), undefined);
    // A team move: agent C joins a paused team between the read and the commit.
    await c.pauses.resume(c.amgr, { commandId: cid("rs"), scope: agentScope(c.agentB), reason: "ok" });
    const t5 = await c.task("five", c.agentC);
    await c.pauses.pause(c.amgr, { commandId: cid("pz"), scope: { kind: "team", id: c.teamChild }, reason: "frontend rests" });
    let moved = false;
    const hooked2 = c.hooked({ afterPauseRead: async () => {
      if (moved) return;
      moved = true;
      const amgrAgents = AgentService.withEpoch(c.storage, c.epoch, options);
      const agent = (await c.storage.getAggregate({ kind: "agent", id: c.agentC }))!;
      await amgrAgents.update(c.owner, { agentId: c.agentC, commandId: cid("up"), expectedRevision: agent.revision, teamId: c.teamChild });
    } });
    await refusedFor("paused", () => hooked2.begin(c.ann, { commandId: cid("b"), taskId: t5, contextRevision: 1 }));
    assert.equal(moved, true);
  });

  suite("a pause that denies background work racing a background result wins, also when no gate existed before", async (c) => {
    let fired = false;
    const racing = c.hookedPauses({ afterBackgroundRead: async () => { if (!fired) { fired = true; await c.pauses.pause(c.amgr, { commandId: cid("pz"), scope: agentScope(c.agentB), reason: "rest", background: "deny" }); } } });
    await refuses("invalid_command", () => racing.recordBackground(c.mgr, { commandId: "bg-race", taskId: c.t3, jobRef: "j", outcome: "succeeded", summary: "done" }), (e) => assert.match(e.message, /background work denied/));
    assert.equal(fired, true);
    assert.equal(await c.storage.getAggregate({ kind: "pause-background", id: derivedBg(c.mgr.id, "bg-race") }), undefined, "no result was recorded");
    // The owner may answer a wait on its resolver's behalf.
    await c.pauses.resume(c.amgr, { commandId: cid("rs"), scope: agentScope(c.agentB), reason: "ok" });
    await c.projects.transitionTask({ commandId: cid("ip"), actor: c.owner.id, taskId: c.t3, expectedRevision: (await c.projects.getTask(c.t3))!.revision, to: "in_progress" });
    await c.waits.openWait({ commandId: cid("w"), actor: c.owner.id, taskId: c.t3, reason: "external", resolver: "someone-else", summary: "job", nextAction: "go", indefinite: { owner: "rob" } });
    const wait = (await c.waits.openFor(c.t3))!;
    const done = await c.pauses.recordBackground(c.owner, { commandId: cid("bg"), taskId: c.t3, jobRef: "j", outcome: "succeeded", summary: "done", answerWait: { waitId: wait.id, expectedRevision: wait.revision, answer: "ok" } });
    assert.equal(done.answeredWaitId, wait.id);
    assert.equal((await c.waits.getWait(wait.id))!.state, "answered");
  });
  suite("fenced calls work with pauses wired: allowed when not paused, refused with paused when paused", async (c) => {
    const outside = new Outside();
    const fenceOf = async (taskId: string, agent: string) => {
      const a = (await c.assignments.getAssignment(taskId))!;
      const att = await c.assignments.admitAttempt({ commandId: cid("adm"), actor: c.owner.id, taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: agent } });
      return { generation: a.generation, attemptId: att.id };
    };
    const fenced = async (taskId: string, fence: { generation: number; attemptId: string }) => {
      const run = (await c.gen.begin(c.ann, { commandId: cid("b"), taskId, contextRevision: 1, fence })).id;
      await c.gen.record(c.ann, { commandId: cid("c"), runId: run, seq: 1, toolCall: { id: "c1", name: "push", argumentsDelta: '{"ref":"main"}', done: true } });
      await c.gen.complete(c.ann, { commandId: cid("done"), runId: run });
      return run;
    };
    // Not paused: fenced begin, admitEffect and execute all succeed.
    const f2 = await fenceOf(c.t2, c.agentA);
    const run2 = await fenced(c.t2, f2);
    await admit(c.gen, c.ann, run2);
    assert.equal((await c.gen.execute(c.ann, { runId: run2, toolCallId: "c1" }, outside.bridge())).status, "confirmed");
    // Paused: a fenced generation begun earlier cannot be admitted or started, and a new fenced begin is refused.
    const f1 = await fenceOf(c.t1, c.agentA);
    const run1 = await fenced(c.t1, f1);
    await c.pauseTask(c.t1);
    await refusedFor("paused", () => admit(c.gen, c.ann, run1));
    await refusedFor("paused", () => c.gen.begin(c.ann, { commandId: cid("b"), taskId: c.t1, contextRevision: 1, fence: f1 }));
    await refusedFor("paused", async () => { const g = c.gen.guardFor(c.t1); await g(); });
    await c.pauses.resume(c.mgr, { commandId: cid("rs"), scope: { kind: "task", id: c.t1 }, reason: "go" });
    await admit(c.gen, c.ann, run1);
    await c.pauseTask(c.t1);
    await refusedFor("paused", () => c.gen.execute(c.ann, { runId: run1, toolCallId: "c1" }, outside.bridge()));
    assert.equal(outside.executions.length, 1);
    await c.pauses.resume(c.mgr, { commandId: cid("rs"), scope: { kind: "task", id: c.t1 }, reason: "go" });
  });
}
