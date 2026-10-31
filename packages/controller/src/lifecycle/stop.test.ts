import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AgentService } from "../agents/index.js";
import { AssignmentService } from "../domain/assignments.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { GrantService, PrincipalService, type Grant, type Principal } from "../security/index.js";
import { PauseService, StopService, type InventoryItem, type StopPorts } from "./index.js";

after(stopServer);

let now = Date.parse("2026-10-28T10:00:00.000Z");
const options = { clock: () => new Date(now).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); return true; });
};

let mayHoldHook: (requestedBy: string, taskId: string) => Promise<boolean> = async () => true;

/** A runtime whose behaviour each test scripts; every call is recorded. */
class Runtime implements StopPorts {
  calls: string[] = [];
  items: InventoryItem[] = [];
  /** What each cleanup call answers, in order (the last repeats). */
  cleanups: Array<Awaited<ReturnType<StopPorts["cleanup"]>>> = [{ remaining: [] }];
  backups: boolean[] = [];
  checkpointDurable = true;
  artifactsDurable = true;
  unresolved: string[] = [];
  ended = true;
  crashOnTerminate = false;
  throwOnTerminate = false;
  unsupportedWith: string | undefined;
  unsupported(): string | undefined { return this.unsupportedWith; }
  /** The attempts this runtime says it has seen, and what the controller gave back to it (a restart empties the runtime's memory). */
  seenAttempts: string[] = [];
  remembered: string[] = [];
  attempts(): string[] { return this.seenAttempts; }
  remember(_s: unknown, a: readonly string[]): void { this.remembered.push(...a); }
  throwOnCheckpoint = false;
  /** Runs inside cleanup, so a test can make something else happen while preparation is in progress. */
  duringCleanup: (() => Promise<void>) | undefined;
  begins = 0;
  async begin(): Promise<void> { this.begins++; }
  async release(): Promise<void> { this.calls.push("release"); }
  async inventory(): Promise<InventoryItem[]> { this.calls.push("inventory"); return this.items; }
  async cleanup(_s: unknown, o: { backup: boolean }) { this.calls.push("cleanup"); const hook = this.duringCleanup; this.duringCleanup = undefined; if (hook !== undefined) await hook(); this.backups.push(o.backup); return this.cleanups.length > 1 ? this.cleanups.shift()! : this.cleanups[0]!; }
  async checkpoint() { this.calls.push("checkpoint"); if (this.throwOnCheckpoint) throw new Error("no runtime to checkpoint"); return { checkpointId: "cp-1", durable: this.checkpointDurable, artifactsDurable: this.artifactsDurable }; }
  /** The cleanup costs terminate reports, and the charges made (a charge fails while `failCharges` is above zero). */
  terminateCosts: Array<{ attemptId: string; costMicros?: number; computeMs?: number }> | undefined;
  charges: Array<{ commandId: string; attemptId: string; costMicros: number; computeMs: number }> = [];
  failCharges = 0;
  /** The next charges are made and then the caller is told they failed (a crash between the charge and the note of it). */
  crashAfterCharge = 0;
  async charge(c: { commandId: string; attemptId: string; costMicros: number; computeMs: number }): Promise<void> {
    if (this.crashAfterCharge > 0) { this.crashAfterCharge--; if (!this.charges.some((x) => x.commandId === c.commandId)) this.charges.push(c); throw new Error("the process died after the charge"); }
    if (this.failCharges > 0) { this.failCharges--; throw new Error("the budget could not be reached"); }
    // A repeated command ID is the same charge (as the budget ledger answers it).
    if (!this.charges.some((x) => x.commandId === c.commandId)) this.charges.push(c);
  }
  async terminate(_s: unknown, o: { force: boolean }) { this.calls.push(o.force ? "terminate-force" : "terminate"); if (this.crashOnTerminate) await new Promise(() => undefined); if (this.throwOnTerminate) throw new Error("cannot reach the host"); return { ended: this.ended, unresolved: this.unresolved, ...(this.terminateCosts === undefined ? {} : { costs: this.terminateCosts }) }; }
  count(call: string): number { return this.calls.filter((c) => c === call).length; }
}

for (const backend of backends) {
  const suite = (name: string, body: (c: {
    owner: Principal; mgr: Principal; ann: Principal; task: string; agentA: string; rt: Runtime; stops: StopService; pauses: PauseService; reopen(): StopService;
    assignments: AssignmentService; projects: ProjectService;
  }) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      now = Date.parse("2026-10-28T10:00:00.000Z");
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const epoch = projects.epoch;
        const principals = PrincipalService.withEpoch(world.storage, epoch, options);
        GrantService.withEpoch(world.storage, epoch, options);
        const agents = AgentService.withEpoch(world.storage, epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const plain = async (nm: string, g: Grant[]) => { await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: g }); return principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token); };
        const project = (await projects.createProject({ commandId: cid("pa"), actor: owner.id, name: "A" })).id;
        const agentA = (await agents.create(owner, { commandId: cid("ag"), friendlyName: "A" })).id;
        const assignments = AssignmentService.withEpoch(world.storage, epoch, projects, options);
        const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "one" })).id;
        await projects.transitionTask({ commandId: cid("r"), actor: owner.id, taskId: task, expectedRevision: 1, to: "ready" });
        await assignments.assignTask({ commandId: cid("as"), actor: owner.id, taskId: task, owner: { kind: "agent", id: agentA } });
        const mgr = await plain("mgr", [{ action: "assignment.manage", project }, { action: "assignment.read", project }]);
        const ann = await plain("ann", [{ action: "attempt.work", project }]);
        const pauses = PauseService.withEpoch(world.storage, epoch, {}, options);
        const rt = new Runtime();
        mayHoldHook = async () => true;
        const make = (): StopService => StopService.withEpoch(world.storage, epoch, PauseService.withEpoch(world.storage, epoch, {}, options), rt, { ...options, mayHold: (by, t) => mayHoldHook(by, t) });
        await body({ owner, mgr, ann, task, agentA, rt, stops: make(), pauses, reopen: make, assignments, projects });
      } finally { await world.close(); }
    });
  const scopeOf = (task: string) => ({ kind: "task", id: task }) as const;
  const observed = async (c: { pauses: PauseService; owner: Principal; task: string }) => (await c.pauses.gate(c.owner, scopeOf(c.task)))?.observed?.state;

  suite("suspend: the scope is paused at once, prepared inside its deadline, and called suspended only after a durable checkpoint; assignments are untouched and nothing resumes", async (c) => {
    const before = JSON.stringify(await c.assignments.getAssignment(c.task));
    const { intentId } = await c.stops.request(c.mgr, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "maintenance window" });
    assert.equal((await c.pauses.gate(c.owner, scopeOf(c.task)))?.intent, "pause", "ordinary work stopped as the request landed");
    const done = await c.stops.advance(c.mgr, { intentId });
    assert.deepEqual([done.phase, done.outcome?.state, done.outcome?.graceful], ["done", "suspended", true]);
    assert.equal(await observed(c), "suspended");
    assert.deepEqual(c.rt.calls, ["inventory", "cleanup", "checkpoint"], "only scoped cleanup and the checkpoint; nothing is ended");
    assert.equal(c.rt.count("terminate"), 0);
    assert.equal((await c.pauses.gate(c.owner, scopeOf(c.task)))?.intent, "pause", "suspend does not resume anything");
    assert.equal(JSON.stringify(await c.assignments.getAssignment(c.task)), before, "the assignment is unchanged");
    const again = await c.stops.advance(c.mgr, { intentId });
    assert.equal(again.revision, done.revision, "advancing a finished request changes nothing");
  });

  suite("a retried old stop request (same command) does not begin again: it would drop the endings of newer attempts (card H12n review fix 3)", async (c) => {
    const command = { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "shutting down" } as const;
    const first = await c.stops.request(c.owner, command);
    assert.equal(c.rt.begins, 1);
    await c.stops.advance(c.owner, { intentId: first.intentId });
    const again = await c.stops.request(c.owner, command);
    assert.equal(again.replayed, true);
    assert.equal(c.rt.begins, 1, "a replay does not begin, the stop being over or not");
  });

  suite("stop: pause, prepare, then end execution; graceful only after preparation, and the task and its owner stay as they were", async (c) => {
    const { intentId } = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "shutting down for the night" });
    const done = await c.stops.advance(c.owner, { intentId });
    assert.deepEqual([done.outcome?.state, done.outcome?.graceful], ["stopped", true]);
    assert.deepEqual(c.rt.calls, ["inventory", "cleanup", "checkpoint", "terminate"]);
    assert.equal(await observed(c), "stopped");
    assert.equal((await c.projects.getTask(c.task))?.state, "ready", "stop never cancels the task's goal");
    assert.equal((await c.pauses.gate(c.owner, scopeOf(c.task)))?.intent, "pause", "stop never resumes execution to shut it down");
  });

  suite("a Stop that takes over an ordinary pause drops the time the owner recorded for it, so that time never reverses the Stop (card L06b)", async (c) => {
    const scope = scopeOf(c.task);
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope, reason: "for the weekend" });
    await c.pauses.setResumeCondition(c.owner, { commandId: cid("rc"), scope, at: "2026-01-01T00:00:00Z" });
    assert.ok((await c.pauses.gate(c.owner, scope))?.resumeAt !== undefined, "the owner's time is recorded");
    const { intentId } = await c.stops.request(c.owner, { commandId: cid("s"), scope, mode: "stop", reason: "shutting down" });
    assert.equal((await c.pauses.gate(c.owner, scope))?.resumeAt, undefined, "the stop took the pause over");
    await assert.rejects(() => c.pauses.setResumeCondition(c.owner, { commandId: cid("rc"), scope, at: "2026-01-01T00:00:00Z" }), /being stopped or suspended/, "and no time can be recorded for it afterwards");
    await c.stops.advance(c.owner, { intentId });
    assert.deepEqual(await c.pauses.liftDue(c.owner), [], "a time that was set for the earlier pause lifts nothing");
    assert.equal((await c.pauses.gate(c.owner, scope))?.intent, "pause");
  });

  suite("Force Stop also takes an ordinary pause over, and a pause whose runtime says suspended or stopped is not lifted by an old time (card L06b)", async (c) => {
    const scope = scopeOf(c.task);
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope, reason: "for the weekend" });
    await c.pauses.setResumeCondition(c.owner, { commandId: cid("rc"), scope, at: "2026-01-01T00:00:00Z" });
    await c.stops.force(c.owner, { commandId: cid("f"), scope, reason: "it is on fire" });
    const gate = (await c.pauses.gate(c.owner, scope))!;
    assert.deepEqual([gate.intent, gate.resumeAt, gate.takenOver], ["pause", undefined, true], "force dropped the time and marked the pause taken over");
    assert.deepEqual(await c.pauses.liftDue(c.owner), []);
    // A pause nobody took over, but whose runtime reports it stopped, is not lifted either.
    const other = { kind: "agent", id: c.agentA } as const;
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: other, reason: "for the weekend" });
    await c.pauses.setResumeCondition(c.owner, { commandId: cid("rc"), scope: other, at: "2026-01-01T00:00:00Z" });
    await c.pauses.observe(c.owner, { commandId: cid("ob"), scope: other, state: "stopped" as never });
    assert.deepEqual(await c.pauses.liftDue(c.owner), [], "a stopped runtime is not lifted by a time");
  });

  suite("a kill in the middle resumes the intent after a restart and reuses the finished preparation", async (c) => {
    c.rt.crashOnTerminate = true;
    const { intentId } = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "stop" });
    // The process dies inside terminate: the call never returns (the test walks away from it).
    void c.stops.advance(c.owner, { intentId }).catch(() => undefined);
    for (let i = 0; i < 400 && c.rt.count("terminate") === 0; i++) await new Promise((r) => setTimeout(r, 25)); // until the call is inside terminate
    assert.equal((await c.stops.get(c.owner, intentId))?.phase, "terminating", "the intent survives the crash in the phase it reached");
    c.rt.crashOnTerminate = false;
    const reopened = c.reopen();
    assert.deepEqual((await reopened.sweep(c.owner)).advanced, [intentId]);
    assert.equal((await reopened.get(c.owner, intentId))?.outcome?.state, "stopped");
    assert.equal(c.rt.count("cleanup"), 1, "preparation was not done again");
    assert.equal(c.rt.count("checkpoint"), 1);
    assert.deepEqual((await reopened.sweep(c.owner)).advanced, [], "nothing is left to do");
  });

  suite("the attempts the runtime saw while preparing are recorded on the request, so after a restart the runtime is told them again (the in-memory seen map is not lost)", async (c) => {
    c.rt.crashOnTerminate = true;
    c.rt.seenAttempts = ["att-1", "att-2"];
    const { intentId } = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "stop" });
    void c.stops.advance(c.owner, { intentId }).catch(() => undefined);
    for (let i = 0; i < 400 && c.rt.count("terminate") === 0; i++) await new Promise((r) => setTimeout(r, 25));
    assert.deepEqual((await c.stops.get(c.owner, intentId) as unknown as { attempts?: string[] }).attempts, ["att-1", "att-2"], "recorded on the request");
    // The controller restarts: the runtime's memory is empty and the new service gives it back what the request recorded.
    c.rt.crashOnTerminate = false; c.rt.seenAttempts = []; c.rt.remembered = [];
    const reopened = c.reopen();
    assert.deepEqual((await reopened.sweep(c.owner)).advanced, [intentId]);
    assert.deepEqual([...new Set(c.rt.remembered)], ["att-1", "att-2"]);
    assert.equal((await reopened.get(c.owner, intentId))?.outcome?.state, "stopped");
  });

  suite("when more attempts are seen than the record can hold, the newest are kept", async (c) => {
    c.rt.crashOnTerminate = true;
    c.rt.seenAttempts = Array.from({ length: 105 }, (_, i) => `att-${String(i).padStart(3, "0")}`);
    const { intentId } = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "stop" });
    void c.stops.advance(c.owner, { intentId }).catch(() => undefined);
    for (let i = 0; i < 400 && c.rt.count("terminate") === 0; i++) await new Promise((r) => setTimeout(r, 25));
    const kept = (await c.stops.get(c.owner, intentId) as unknown as { attempts?: string[] }).attempts!;
    assert.equal(kept.length, 100);
    assert.deepEqual([kept[0], kept.at(-1)], ["att-005", "att-104"], "the oldest five were dropped, not the newest");
  });

  suite("work that will not settle blocks the request and is never called suspended; the owner may wait, restart from an earlier boundary or force stop", async (c) => {
    c.rt.items = [{ kind: "process", ref: "pid-7", state: "uncooperative" }];
    c.rt.cleanups = [{ remaining: [{ kind: "process", ref: "pid-7", state: "uncooperative" }] }];
    const { intentId } = await c.stops.request(c.mgr, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "r" });
    const blocked = await c.stops.advance(c.mgr, { intentId });
    assert.deepEqual([blocked.phase, blocked.blocked?.choices], ["blocked", ["wait", "restart-earlier-boundary", "force-stop"]]);
    assert.match(blocked.blocked!.reason, /uncooperative/);
    assert.notEqual(await observed(c), "suspended");
    assert.equal(c.rt.count("checkpoint"), 0, "no checkpoint is taken over running work");
    // Waiting more with the work now settled finishes it.
    c.rt.cleanups = [{ remaining: [] }];
    await c.stops.choose(c.mgr, { commandId: cid("c"), intentId, choice: "wait" });
    assert.equal((await c.stops.advance(c.mgr, { intentId })).outcome?.state, "suspended");
  });

  suite("the deadline passing with work running blocks it; restart from an earlier boundary reports recovery-required, never suspended", async (c) => {
    c.rt.cleanups = [{ remaining: [{ kind: "job", ref: "job-1", state: "running" }] }];
    const { intentId } = await c.stops.request(c.mgr, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "r", deadlineMs: 1000 });
    assert.equal((await c.stops.advance(c.mgr, { intentId })).phase, "preparing", "still settling inside the deadline");
    now += 2000;
    const blocked = await c.stops.advance(c.mgr, { intentId });
    assert.deepEqual([blocked.phase, blocked.blocked?.reason], ["blocked", "the deadline passed with work still running"]);
    await refuses("not_found", () => c.stops.choose(c.mgr, { commandId: cid("c"), intentId: "stp-nope", choice: "wait" }));
    const r = await c.stops.choose(c.mgr, { commandId: cid("c"), intentId, choice: "restart-earlier-boundary" });
    assert.equal(r.phase, "recovery-required");
    const done = (await c.stops.get(c.mgr, intentId))!;
    assert.deepEqual([done.outcome?.state, done.outcome?.graceful, done.outcome?.unresolved], ["recovery-required", false, ["job-1"]]);
    await refuses("invalid_command", () => c.stops.choose(c.mgr, { commandId: cid("c"), intentId, choice: "wait" }));
  });

  suite("a checkpoint or artifacts that are not durable block the suspension", async (c) => {
    c.rt.checkpointDurable = false;
    const a = await c.stops.request(c.mgr, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "r" });
    const b1 = await c.stops.advance(c.mgr, { intentId: a.intentId });
    assert.deepEqual([b1.phase, b1.blocked?.reason], ["blocked", "the checkpoint is not durable"]);
    c.rt.checkpointDurable = true; c.rt.artifactsDurable = false;
    await c.stops.choose(c.mgr, { commandId: cid("c"), intentId: a.intentId, choice: "wait" });
    const b2 = await c.stops.advance(c.mgr, { intentId: a.intentId });
    assert.equal(b2.blocked?.reason, "the artifacts the checkpoint names are not durable");
    assert.notEqual(await observed(c), "suspended");
  });

  suite("model loss during cleanup uses the backup model once; losing that too blocks; a spent cleanup budget blocks", async (c) => {
    c.rt.cleanups = [{ remaining: [], modelLost: true }, { remaining: [] }];
    const a = await c.stops.request(c.mgr, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "r" });
    const done = await c.stops.advance(c.mgr, { intentId: a.intentId });
    assert.deepEqual([done.outcome?.state, done.backupUsed, c.rt.backups], ["suspended", true, [false, true]]);
    await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: scopeOf(c.task), reason: "back" });
    c.rt.cleanups = [{ remaining: [], modelLost: true }]; c.rt.calls = []; c.rt.backups = [];
    const b = await c.stops.request(c.mgr, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "again" });
    assert.match((await c.stops.advance(c.mgr, { intentId: b.intentId })).blocked?.reason ?? "", /backup model could not finish/);
    await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: scopeOf(c.task), reason: "back" });
    c.rt.cleanups = [{ remaining: [{ kind: "job", ref: "j", state: "running" }], spent: 5 }];
    const d = await c.stops.request(c.mgr, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "budget", spendBudget: 3 });
    assert.equal((await c.stops.advance(c.mgr, { intentId: d.intentId })).blocked?.reason, "the cleanup budget is used up with work still running");
  });

  suite("losing the last model while the whole installation is being prepared leaves the pause held and a recoverable request, names what is missing, and the owner can still Force Stop (card L06)", async (c) => {
    const whole = { kind: "installation", id: "installation" } as const;
    c.rt.cleanups = [{ remaining: [], modelLost: true }, { remaining: [], modelLost: true }];
    const r = await c.stops.request(c.owner, { commandId: cid("wi"), scope: whole, mode: "suspend", reason: "reboot tonight" });
    const stuck = await c.stops.advance(c.owner, { intentId: r.intentId });
    assert.equal(stuck.phase, "blocked");
    assert.match(stuck.blocked?.reason ?? "", /cleanup model was lost and the backup model could not finish/);
    assert.equal((await c.pauses.gate(c.owner, whole))?.intent, "pause", "the pause still holds");
    assert.equal(stuck.outcome, undefined, "nothing is claimed as done");
    const forced = await c.stops.force(c.owner, { commandId: cid("wf"), scope: whole, reason: "the models are down" });
    assert.equal(forced.outcome.graceful, false);
  });

  suite("who may ask: an agent without the grant is refused, a second request is refused, stop after suspend reuses the preparation, and the request is recorded once", async (c) => {
    await refuses("forbidden", () => c.stops.request(c.ann, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "r" }));
    assert.notEqual((await c.pauses.gate(c.owner, scopeOf(c.task)))?.intent, "pause", "a refused request paused nothing");
    const id = cid("s");
    const a = await c.stops.request(c.mgr, { commandId: id, scope: scopeOf(c.task), mode: "suspend", reason: "r" });
    assert.equal((await c.stops.request(c.mgr, { commandId: id, scope: scopeOf(c.task), mode: "suspend", reason: "r" })).replayed, true);
    await refuses("invalid_command", () => c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "again" }));
    await c.stops.advance(c.mgr, { intentId: a.intentId });
    assert.equal((await c.stops.get(c.mgr, a.intentId))?.outcome?.state, "suspended");
    const upgraded = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "now stop" });
    assert.notEqual(upgraded.intentId, "");
    const stopped = await c.stops.advance(c.owner, { intentId: upgraded.intentId });
    assert.equal(stopped.outcome?.state, "stopped");
    assert.equal(c.rt.count("checkpoint"), 1, "the earlier preparation was reused");
  });

  suite("force stop is explicit and recorded as forced; unresolved work makes it recovery-required, and a clean one is still not graceful", async (c) => {
    c.rt.unresolved = ["effect-9"]; c.rt.ended = true;
    const r = await c.stops.force(c.mgr, { commandId: cid("f"), scope: scopeOf(c.task), reason: "it is on fire" });
    assert.deepEqual([r.outcome.state, r.outcome.graceful, r.outcome.unresolved], ["recovery-required", false, ["effect-9"]]);
    assert.deepEqual(c.rt.calls, ["terminate-force"], "no cleanup, no checkpoint");
    const got = (await c.stops.get(c.mgr, r.intentId))!;
    assert.deepEqual([got.mode, got.forced?.by, got.forced?.reason], ["force-stop", c.mgr.id, "it is on fire"]);
    assert.equal(await observed(c), "recovery-required");
    await refuses("forbidden", () => c.stops.force(c.ann, { commandId: cid("f"), scope: scopeOf(c.task), reason: "x" }));
  });

  suite("choosing force stop after a block ends it forced", async (c) => {
    c.rt.cleanups = [{ remaining: [{ kind: "process", ref: "p", state: "uncooperative" }] }];
    const a = await c.stops.request(c.mgr, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "r" });
    assert.equal((await c.stops.advance(c.mgr, { intentId: a.intentId })).phase, "blocked");
    assert.equal(c.rt.count("terminate"), 0, "a stop does not end execution while preparation is blocked");
    await c.stops.choose(c.mgr, { commandId: cid("c"), intentId: a.intentId, choice: "force-stop", reason: "chosen" });
    const done = (await c.stops.get(c.mgr, a.intentId))!;
    assert.deepEqual([done.outcome?.state, done.outcome?.graceful, done.mode], ["stopped", false, "force-stop"]);
  });
  suite("a scope resumed before the request finished cancels it, and nothing more is done for it; an agent without the grant cannot move it along", async (c) => {
    c.rt.cleanups = [{ remaining: [{ kind: "job", ref: "j", state: "running" }] }];
    const a = await c.stops.request(c.mgr, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "r" });
    await refuses("not_found", () => c.stops.advance(c.ann, { intentId: a.intentId }));
    await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: scopeOf(c.task), reason: "never mind" });
    const gone = await c.stops.advance(c.mgr, { intentId: a.intentId });
    assert.equal(gone.phase, "cancelled");
    assert.equal(c.rt.count("terminate"), 0);
    assert.equal(c.rt.count("checkpoint"), 0);
    // The next request is not blocked by the abandoned one.
    c.rt.cleanups = [{ remaining: [] }];
    const b = await c.stops.request(c.mgr, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "later" });
    assert.equal((await c.stops.advance(c.mgr, { intentId: b.intentId })).outcome?.state, "suspended");
  });
  suite("a force sent again after the owner resumed does not end running work a second time", async (c) => {
    const id = cid("f");
    const first = await c.stops.force(c.mgr, { commandId: id, scope: scopeOf(c.task), reason: "on fire" });
    await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: scopeOf(c.task), reason: "fixed" });
    const again = await c.stops.force(c.mgr, { commandId: id, scope: scopeOf(c.task), reason: "on fire" });
    assert.deepEqual(again, first, "the recorded outcome");
    assert.equal(c.rt.count("terminate-force"), 1);
    assert.notEqual((await c.pauses.gate(c.owner, scopeOf(c.task)))?.intent, "pause", "the retry did not pause it again");
  });

  suite("a force that lands while preparation is running wins, and the preparation that finishes afterwards does not bring the request back to life", async (c) => {
    const a = await c.stops.request(c.mgr, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "r" });
    c.rt.duringCleanup = async () => { await c.stops.force(c.owner, { commandId: cid("f"), scope: scopeOf(c.task), reason: "now" }); };
    const done = await c.stops.advance(c.mgr, { intentId: a.intentId });
    assert.equal(done.phase, "done");
    assert.deepEqual([done.outcome?.graceful, done.mode], [false, "force-stop"], "the force is not lost or overwritten");
    assert.equal(c.rt.count("terminate-force"), 1);
    assert.equal(c.rt.count("terminate"), 0, "no graceful end afterwards");
    assert.equal(c.rt.count("checkpoint"), 0);
  });

  suite("a stop after a suspension that was resumed in between prepares again; a retried upgrade names the request it upgraded", async (c) => {
    const a = await c.stops.request(c.mgr, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "r" });
    await c.stops.advance(c.mgr, { intentId: a.intentId });
    await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: scopeOf(c.task), reason: "back to work" });
    const b = await c.stops.request(c.mgr, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "night" });
    await c.stops.advance(c.mgr, { intentId: b.intentId });
    assert.equal(c.rt.count("checkpoint"), 2, "the old checkpoint is not reused after the hold was lifted");
    // An upgrade of a suspend that is still preparing, sent twice.
    await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: scopeOf(c.task), reason: "again" });
    c.rt.cleanups = [{ remaining: [{ kind: "job", ref: "j", state: "running" }] }];
    const first = await c.stops.request(c.mgr, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "r" });
    const upId = cid("up");
    const up = await c.stops.request(c.mgr, { commandId: upId, scope: scopeOf(c.task), mode: "stop", reason: "stop instead" });
    const retried = await c.stops.request(c.mgr, { commandId: upId, scope: scopeOf(c.task), mode: "stop", reason: "stop instead" });
    assert.deepEqual([up.intentId, retried.intentId, retried.replayed], [first.intentId, first.intentId, true]);
    assert.equal((await c.stops.get(c.mgr, retried.intentId))?.mode, "stop");
  });

  suite("a runtime that cannot be reached blocks the request instead of killing it, and a sweep goes on past a request it cannot move", async (c) => {
    c.rt.throwOnCheckpoint = true;
    const a = await c.stops.request(c.mgr, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "r" });
    const blocked = await c.stops.advance(c.mgr, { intentId: a.intentId });
    assert.deepEqual([blocked.phase, /could not be taken/.test(blocked.blocked?.reason ?? "")], ["blocked", true]);
    c.rt.throwOnCheckpoint = false;
    await c.stops.choose(c.mgr, { commandId: cid("c"), intentId: a.intentId, choice: "wait" });
    assert.equal((await c.stops.advance(c.mgr, { intentId: a.intentId })).outcome?.state, "suspended");
    await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: scopeOf(c.task), reason: "back" });
    c.rt.throwOnTerminate = true;
    const b = await c.stops.request(c.mgr, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "r" });
    const stuck = await c.stops.advance(c.mgr, { intentId: b.intentId });
    assert.deepEqual([stuck.phase, stuck.blocked?.resume], ["blocked", "terminating"]);
    c.rt.throwOnTerminate = false;
    assert.equal((await c.stops.choose(c.mgr, { commandId: cid("c"), intentId: b.intentId, choice: "wait" })).phase, "terminating");
    assert.equal((await c.stops.advance(c.mgr, { intentId: b.intentId })).outcome?.state, "stopped");
    assert.deepEqual((await c.stops.sweep(c.owner)).failed, []);
  });

  suite("a request cancelled by a resume lets go of what preparation froze", async (c) => {
    c.rt.cleanups = [{ remaining: [{ kind: "job", ref: "j", state: "running" }] }];
    const a = await c.stops.request(c.mgr, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "r" });
    await c.stops.advance(c.mgr, { intentId: a.intentId });
    await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: scopeOf(c.task), reason: "never mind" });
    await c.stops.advance(c.mgr, { intentId: a.intentId });
    assert.equal(c.rt.count("release"), 1);
  });
  suite("a force that took over a blocked request, sent again after a resume, answers as recorded; a blocked request on a resumed scope is cancelled and released", async (c) => {
    c.rt.throwOnCheckpoint = true;
    const a = await c.stops.request(c.mgr, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "r" });
    assert.equal((await c.stops.advance(c.mgr, { intentId: a.intentId })).phase, "blocked");
    const fid = cid("f");
    const first = await c.stops.force(c.mgr, { commandId: fid, scope: scopeOf(c.task), reason: "now" });
    await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: scopeOf(c.task), reason: "fixed" });
    const again = await c.stops.force(c.mgr, { commandId: fid, scope: scopeOf(c.task), reason: "now" });
    assert.deepEqual(again, first);
    assert.equal(c.rt.count("terminate-force"), 1);
    assert.notEqual((await c.pauses.gate(c.owner, scopeOf(c.task)))?.intent, "pause");
    // blocked, then resumed: the next look cancels and lets go
    const b = await c.stops.request(c.mgr, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "r" });
    assert.equal((await c.stops.advance(c.mgr, { intentId: b.intentId })).phase, "blocked");
    await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: scopeOf(c.task), reason: "never mind" });
    const before = c.rt.count("release");
    assert.equal((await c.stops.advance(c.mgr, { intentId: b.intentId })).phase, "cancelled");
    assert.equal(c.rt.count("release"), before + 1);
  });
  suite("the cleanup cost is charged as it grows, once, and what could not be charged is kept for the next try; the part counted against the budget is what was charged (card L02d)", async (c) => {
    c.rt.items = [{ kind: "foreground", ref: "att-a/c1", state: "running" }];
    c.rt.cleanups = [
      { remaining: [{ kind: "foreground", ref: "att-a/c1", state: "running" }], costs: [{ attemptId: "att-a", costMicros: 1000, computeMs: 100 }] },
      { remaining: [{ kind: "foreground", ref: "att-a/c1", state: "running" }], costs: [{ attemptId: "att-a", costMicros: 1800, computeMs: 100 }] },
      { remaining: [{ kind: "foreground", ref: "att-a/c1", state: "running" }], costs: [{ attemptId: "att-a", costMicros: 1800, computeMs: 100 }] },
      { remaining: [], costs: [{ attemptId: "att-a", costMicros: 1500, computeMs: 100 }, { attemptId: "att-b", costMicros: -5 }, { attemptId: "att-c", costMicros: 1.5 }] },
    ];
    const { intentId } = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "x", spendBudget: 5000 });
    await c.stops.advance(c.owner, { intentId });
    assert.deepEqual(c.rt.charges.map((x) => [x.attemptId, x.costMicros, x.computeMs]), [["att-a", 1000, 100]]);
    c.rt.failCharges = 1;
    await c.stops.advance(c.owner, { intentId });
    assert.equal(c.rt.charges.length, 1, "the second charge failed and was not recorded as charged");
    await c.stops.advance(c.owner, { intentId });
    assert.deepEqual(c.rt.charges.map((x) => [x.attemptId, x.costMicros, x.computeMs]), [["att-a", 1000, 100], ["att-a", 800, 0]], "the missed part is charged by the next pass, nothing twice");
    const done = await c.stops.advance(c.owner, { intentId });
    assert.equal(c.rt.charges.length, 2, "a lower total (a restarted counter) and figures that are not whole numbers of zero or more charge nothing");
    assert.equal(done.outcome?.state, "suspended");
    assert.equal(done.spent, 1800, "the spend counted against the cleanup budget is what was charged");
    assert.equal(new Set(c.rt.charges.map((x) => x.commandId)).size, 2, "each charge has its own command ID");
    await c.stops.advance(c.owner, { intentId });
    assert.equal(c.rt.charges.length, 2, "a finished request charges nothing more");
  });

  suite("what the ending cost is charged too, and a charge that cannot be made is named in the result instead of dropped (card L02d)", async (c) => {
    c.rt.terminateCosts = [{ attemptId: "att-a", costMicros: 400, computeMs: 5 }];
    const ok = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x" });
    const done = await c.stops.advance(c.owner, { intentId: ok.intentId });
    assert.equal(done.outcome?.state, "stopped");
    assert.deepEqual(c.rt.charges.map((x) => [x.attemptId, x.costMicros, x.computeMs]), [["att-a", 400, 5]]);
  });

  suite("a charge that fails while the ending is charged makes the result recovery-required and names it", async (c) => {
    c.rt.terminateCosts = [{ attemptId: "att-a", costMicros: 400 }];
    c.rt.failCharges = 5;
    const r = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x" });
    const done = await c.stops.advance(c.owner, { intentId: r.intentId });
    assert.equal(done.outcome?.state, "recovery-required");
    assert.deepEqual(done.outcome?.unresolved, ["cleanup spend not charged"]);
  });

  suite("what was charged is kept per attempt: Suspend then Stop, a stop after a resume and an overlapping stop never charge the same cost again, only what has grown (card L02d)", async (c) => {
    c.rt.items = [{ kind: "foreground", ref: "att-a/c1", state: "running" }];
    c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-a", costMicros: 1000, computeMs: 10 }] }];
    const sus = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "x" });
    assert.equal((await c.stops.advance(c.owner, { intentId: sus.intentId })).outcome?.state, "suspended");
    assert.deepEqual(c.rt.charges.map((x) => [x.costMicros, x.computeMs]), [[1000, 10]]);
    // A Stop after the Suspend (a request of its own, the preparation reused) reports the same total, then a larger one: only the growth is charged.
    c.rt.terminateCosts = [{ attemptId: "att-a", costMicros: 1000, computeMs: 10 }];
    const stop = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x" });
    assert.equal((await c.stops.advance(c.owner, { intentId: stop.intentId })).outcome?.state, "stopped");
    assert.equal(c.rt.charges.length, 1, "the same total is not charged again by another request");
    // Resumed, then stopped once more with a larger total.
    await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: scopeOf(c.task), reason: "again" });
    c.rt.terminateCosts = [{ attemptId: "att-a", costMicros: 1400, computeMs: 10 }];
    const again = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x" });
    assert.equal((await c.stops.advance(c.owner, { intentId: again.intentId })).outcome?.state, "stopped");
    assert.deepEqual(c.rt.charges.map((x) => [x.costMicros, x.computeMs]), [[1000, 10], [400, 0]]);
  });

  suite("a crash after a charge was made, followed by a larger total, charges the part already paid once and only the rest as new (card L02d)", async (c) => {
    c.rt.items = [{ kind: "foreground", ref: "att-a/c1", state: "running" }];
    c.rt.cleanups = [
      { remaining: [{ kind: "foreground", ref: "att-a/c1", state: "running" }], costs: [{ attemptId: "att-a", costMicros: 1000 }] },
      { remaining: [], costs: [{ attemptId: "att-a", costMicros: 1700 }] },
    ];
    c.rt.crashAfterCharge = 1;
    const { intentId } = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "x" });
    await c.stops.advance(c.owner, { intentId });
    assert.deepEqual(c.rt.charges.map((x) => x.costMicros), [1000], "the first charge was made, and the process died before noting it");
    await c.stops.advance(c.owner, { intentId });
    assert.equal(c.rt.charges.reduce((sum, x) => sum + x.costMicros, 0), 1700, "the 1,000 already paid is not paid again; the rest is the new charge");
    assert.deepEqual(c.rt.charges.map((x) => x.costMicros), [1000, 700]);
  });

  suite("a host's figure is cut to the cap, and a charge that failed is retried by a later sweep, which takes the mark off the result (card L02d)", async (c) => {
    c.rt.terminateCosts = [{ attemptId: "att-a", costMicros: 5_000_000_000_000 }];
    c.rt.failCharges = 1;
    const r = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x" });
    const done = await c.stops.advance(c.owner, { intentId: r.intentId });
    assert.deepEqual(done.outcome?.unresolved, ["cleanup spend not charged"]);
    assert.equal(c.rt.charges.length, 0);
    await c.stops.sweep(c.owner);
    assert.deepEqual(c.rt.charges.map((x) => x.costMicros), [1_000_000_000_000], "charged at the cap");
    assert.deepEqual((await c.stops.get(c.owner, r.intentId))?.outcome?.unresolved, []);
    await c.stops.sweep(c.owner);
    assert.equal(c.rt.charges.length, 1, "once");
  });

  suite("a Stop does not wait in preparation for processes, child work or jobs (it ends them itself), a Suspend does; an uncooperative one blocks either (card L02d)", async (c) => {
    const items: InventoryItem[] = [{ kind: "process", ref: "node", state: "running" }, { kind: "child", ref: "att-child", state: "running" }, { kind: "job", ref: "job-1", state: "running" }];
    c.rt.items = items;
    c.rt.cleanups = [{ remaining: items }];
    const stop = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x" });
    const done = await c.stops.advance(c.owner, { intentId: stop.intentId });
    assert.equal(done.outcome?.state, "stopped", "the stop went on to end them");
    assert.equal(c.rt.count("terminate"), 1);
  });

  suite("a Suspend waits for a running process; an uncooperative job blocks a Stop with Force Stop offered", async (c) => {
    const proc: InventoryItem = { kind: "process", ref: "node", state: "running" };
    c.rt.items = [proc];
    c.rt.cleanups = [{ remaining: [proc] }];
    const sus = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "x" });
    const waiting = await c.stops.advance(c.owner, { intentId: sus.intentId });
    assert.equal(waiting.phase, "preparing", "still settling");
    const job: InventoryItem = { kind: "job", ref: "job-1", state: "uncooperative" };
    c.rt.cleanups = [{ remaining: [job] }];
    const up = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x" });
    const blocked = await c.stops.advance(c.owner, { intentId: up.intentId });
    assert.equal(blocked.phase, "blocked");
    assert.ok(blocked.blocked?.choices.includes("force-stop"));
  });

  suite("a Suspend is not held by a placeholder (a remote placement, an attempt a restarted worker forgot) once the attempt is quiesced, and records it as unverified; a real unknown process still holds it (card L02d review)", async (c) => {
    const placeholder: InventoryItem = { kind: "process", ref: "remote:att-a", state: "unknown" };
    c.rt.items = [placeholder];
    c.rt.cleanups = [{ remaining: [placeholder, { kind: "process", ref: "attempt:att-b", state: "unknown" }] }];
    const sus = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "x" });
    const done = await c.stops.advance(c.owner, { intentId: sus.intentId });
    assert.equal(done.outcome?.state, "suspended");
    assert.ok(done.history.some((h) => h.note.includes("unverified") && h.note.includes("remote:att-a")), "the unverified items are recorded");
  });

  suite("a Suspend still waits for an unknown process that is not a placeholder", async (c) => {
    const unknown: InventoryItem = { kind: "process", ref: "node", state: "unknown" };
    c.rt.items = [unknown];
    c.rt.cleanups = [{ remaining: [unknown] }];
    const sus = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "x" });
    assert.equal((await c.stops.advance(c.owner, { intentId: sus.intentId })).phase, "preparing");
  });

  suite("a finished Stop does not keep holding after a resume: a later plain Pause of the parent holds nothing (card L02d review)", async (c) => {
    const stop = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x" });
    await c.stops.advance(c.owner, { intentId: stop.intentId });
    assert.equal((await c.stops.holding(c.task))?.intentId, stop.intentId, "held while the stop's own pause stands");
    await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: scopeOf(c.task), reason: "again" });
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: scopeOf(c.task), reason: "just a pause" });
    assert.equal(await c.stops.holding(c.task), undefined, "the finished stop is not the cause of this pause");
  });

  suite("a stop does not hold a child its requester may not control (card L02d review)", async (c) => {
    const stop = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x" });
    await c.stops.advance(c.owner, { intentId: stop.intentId });
    mayHoldHook = async (_by, child) => child !== "child-x";
    assert.ok(await c.stops.holding(c.task, "child-y"));
    assert.equal(await c.stops.holding(c.task, "child-x"), undefined);
  });

  suite("two stops of the same attempt at once: neither loses the race into a permanent unpaid mark, and the cost is charged once (card L02d review)", async (c) => {
    c.rt.terminateCosts = [{ attemptId: "att-a", costMicros: 700, computeMs: 5 }];
    const a = await c.stops.request(c.owner, { commandId: cid("s1"), scope: scopeOf(c.task), mode: "stop", reason: "x" });
    const b = await c.stops.request(c.owner, { commandId: cid("s2"), scope: { kind: "agent", id: c.agentA }, mode: "stop", reason: "x" });
    const [ra, rb] = await Promise.all([c.stops.advance(c.owner, { intentId: a.intentId }), c.stops.advance(c.owner, { intentId: b.intentId })]);
    for (const r of [ra, rb]) assert.ok(!(r.outcome?.unresolved ?? []).includes("cleanup spend not charged"), "a lost race is not a failure");
    assert.deepEqual(c.rt.charges.map((x) => x.costMicros), [700], "charged once");
  });

  suite("a scope that cannot be stopped yet is refused before anything is paused or recorded", async (c) => {
    c.rt.unsupportedWith = "stopping a whole team is not supported yet";
    await refuses("unavailable", () => c.stops.request(c.mgr, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "r" }));
    await refuses("unavailable", () => c.stops.force(c.mgr, { commandId: cid("f"), scope: scopeOf(c.task), reason: "r" }));
    assert.notEqual((await c.pauses.gate(c.owner, scopeOf(c.task)))?.intent, "pause", "not paused");
    assert.equal(c.rt.count("terminate-force"), 0);
  });
}

for (const backend of backends) {
  test(`${backend.name}: readiness says whether a stop could finish now without starting one, and a failed look is never ready (card L06)`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const epoch = projects.epoch;
      const principals = PrincipalService.withEpoch(world.storage, epoch, options);
      GrantService.withEpoch(world.storage, epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "bob", grants: [] });
      const bob = await principals.authenticate((await principals.issueCredential(owner, "agent:bob")).token);
      const rt = new Runtime();
      const stops = StopService.withEpoch(world.storage, epoch, PauseService.withEpoch(world.storage, epoch, {}, options), rt, options);
      const scope = { kind: "installation", id: "installation" } as const;
      assert.deepEqual(await stops.readiness(owner, scope), { scope, ready: true, paused: false, unsettled: [], tracked: [], truncated: false });
      // A permitted remote job that is tracked is named but does not stop the scope from being ready.
      rt.items = [{ kind: "job", ref: "job-remote", state: "tracked" }];
      const exception = await stops.readiness(owner, scope);
      assert.deepEqual([exception.ready, exception.unsettled, exception.tracked], [true, [], [{ kind: "job", ref: "job-remote", state: "tracked" }]]);
      rt.items = [{ kind: "job", ref: "job-1", state: "running" }, { kind: "process", ref: "pid-2", state: "settled" }];
      const busy = await stops.readiness(owner, scope);
      assert.equal(busy.ready, false);
      assert.deepEqual(busy.unsettled, [{ kind: "job", ref: "job-1", state: "running" }], "settled items are not listed");
      rt.inventory = async () => { throw new Error("worker unreachable"); };
      const failed = await stops.readiness(owner, scope);
      assert.equal(failed.ready, false);
      assert.deepEqual(failed.unsettled, [{ kind: "process", ref: "runtime:inventory", state: "unknown" }]);
      await refuses("forbidden", () => stops.readiness(bob, scope));
      rt.unsupportedWith = "not here";
      await refuses("unavailable", () => stops.readiness(owner, scope));
      assert.equal(rt.count("cleanup"), 0, "nothing was started");
    } finally { await world.close(); }
  });
}
