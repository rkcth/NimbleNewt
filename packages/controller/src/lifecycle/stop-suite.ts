import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AgentService } from "../agents/index.js";
import { AssignmentService } from "../domain/assignments.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { CommandRunner } from "../domain/runner.js";
import { ProjectService } from "../domain/service.js";
import { backendsNamed, stopServer } from "../domain/testing/backends.js";
import { GrantService, PrincipalService, type Grant, type Principal } from "../security/index.js";
import { PauseService, STOP_LIMITS, StopService, addCapped, type InventoryItem, type StopPorts } from "./index.js";
import { dispatchStopPorts } from "./dispatch-ports.js";
import type { PauseScope } from "./pause.js";

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
  duringTerminate: (() => Promise<void>) | undefined;
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
  async terminate(_s: unknown, o: { force: boolean }) { this.calls.push(o.force ? "terminate-force" : "terminate"); const during = this.duringTerminate; this.duringTerminate = undefined; if (during !== undefined) await during(); if (this.crashOnTerminate) await new Promise(() => undefined); if (this.throwOnTerminate) throw new Error("cannot reach the host"); return { ended: this.ended, unresolved: this.unresolved, ...(this.terminateCosts === undefined ? {} : { costs: this.terminateCosts }) }; }
  count(call: string): number { return this.calls.filter((c) => c === call).length; }
}

/** Says a task is a child of another in the swarm, the way the spawn service records it, so a stop of the parent reaches the child's work (card L02e). */
const swarmLink = async (runner: CommandRunner, child: string, parent: string, projectId: string): Promise<void> => {
  const ref = { kind: "swarm-link", id: child };
  await runner.command("test.link", { commandId: cid("link"), actor: "system" }, async () => ({
    payload: { child, parent },
    build: async () => ({ ref, creates: true, changes: [{ type: "create" as const, ref, body: { parentTaskId: parent, projectId, createdBy: "user:rob", createdAt: "2026-10-28T10:00:00.000Z" } } as never], detail: {} }),
  }));
};

/** The stop and suspend tests (cards L02, L02d, L06) on the backend of this name. The four test files lifecycle/stop*.test.ts run one backend each, so that no file nears the per-file time limit on a slow CI machine (the whole set took about 930 s on a Windows runner against the 600 s limit). */
export function defineStopTests(backendName: string): void {
  after(stopServer);
  for (const backend of backendsNamed(backendName)) {
    const suite = (name: string, body: (c: {
      owner: Principal; mgr: Principal; ann: Principal; task: string; agentA: string; project: string; rt: Runtime; stops: StopService; pauses: PauseService; reopen(): StopService;
      assignments: AssignmentService; projects: ProjectService; agents: AgentService; runner: CommandRunner; storage: unknown; edit(intentId: string, change: (body: Record<string, unknown>) => Record<string, unknown>): Promise<void>;
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
          // Rewrites a stored request as an older build wrote it (a field that did not exist yet is absent).
          const edit = async (intentId: string, change: (body: Record<string, unknown>) => Record<string, unknown>): Promise<void> => {
            const ref = { kind: "stop-intent", id: intentId };
            const found = (await world.storage.getAggregate(ref))!;
            await new CommandRunner(world.storage, epoch, options).command("test.edit-stop", { commandId: cid("edit"), actor: "system" }, async () => ({ payload: { intentId }, build: async () => ({ ref, creates: false, changes: [{ type: "update" as const, ref, expectedRevision: found.revision, body: change({ ...(found.body as Record<string, unknown>) }) as never }], detail: {} }) }));
          };
          mayHoldHook = async () => true;
          const make = (): StopService => StopService.withEpoch(world.storage, epoch, PauseService.withEpoch(world.storage, epoch, {}, options), rt, { ...options, mayHold: (by, t) => mayHoldHook(by, t) });
          await body({ owner, mgr, ann, task, agentA, project, rt, stops: make(), pauses, reopen: make, assignments, projects, agents, edit, runner: new CommandRunner(world.storage, epoch, options), storage: world.storage });
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

    // The cleanup is the dispatcher port's own, over a dispatcher whose quiesce says the worker was still starting (card H12q) until `up` is set.
    const startingPorts = (c: { rt: Runtime; owner: Principal }) => {
      const state = { starting: true };
      const dispatcher = {
        liveAttemptsOf: async () => ["att-1"], get: async () => undefined, operations: async () => [], release: async () => undefined, stop: async () => undefined,
        quiesce: async (_by: Principal, id: string) => { if (state.starting) throw new DomainError("unavailable", `the worker of attempt ${id} was still starting after 1 ms`, { field: "starting" }); return { checkpoint: { id: "cp" } }; },
      };
      const ports = dispatchStopPorts(() => ({ dispatcher: dispatcher as never, principal: c.owner }));
      c.rt.cleanup = async (s: PauseScope, o: { deadlineAt: string; backup: boolean; by: Principal }) => { c.rt.calls.push("cleanup"); return ports.cleanup(s, o); };
      return state;
    };

    suite("a worker still coming up when the cleanup's wait runs out does not block a Stop: it goes on, and its ending stops the worker (card H12q review)", async (c) => {
      startingPorts(c);
      const { intentId } = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "shutting down" });
      const stopped = await c.stops.advance(c.owner, { intentId });
      assert.deepEqual([stopped.phase, stopped.outcome?.state], ["done", "stopped"], "the Stop is not blocked");
      assert.deepEqual(c.rt.calls, ["inventory", "cleanup", "checkpoint", "terminate"]);
    });

    suite("a worker still coming up when the cleanup's wait runs out keeps a Suspend preparing (it waits for it like running work), not blocked; once it is up the Suspend finishes (card H12q review)", async (c) => {
      const state = startingPorts(c);
      const { intentId } = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "maintenance", deadlineMs: 60_000 });
      const waiting = await c.stops.advance(c.owner, { intentId });
      assert.equal(waiting.phase, "preparing", "still preparing, not blocked");
      assert.deepEqual(waiting.inventory, [{ kind: "process", ref: "att-1/starting", state: "running" }], "the worker coming up is listed as running work");
      assert.equal(c.rt.count("checkpoint"), 0, "no checkpoint is taken while it comes up");
      state.starting = false;
      const done = await c.stops.advance(c.owner, { intentId });
      assert.deepEqual([done.phase, done.outcome?.state], ["done", "suspended"], "once it is up it is made quiet and the Suspend finishes");
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

    suite("cleanupSpend tells the owner what the latest request spent and what was charged per attempt; a scope never stopped reads as nothing (card L02d)", async (c) => {
      assert.equal(await c.stops.cleanupSpend(c.owner, scopeOf(c.task)), undefined, "never suspended or stopped");
      c.rt.seenAttempts = ["att-a", "att-quiet"];
      c.rt.items = [{ kind: "foreground", ref: "att-a/c1", state: "running" }];
      c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-a", costMicros: 1250, computeMs: 40 }] }];
      c.rt.terminateCosts = [{ attemptId: "att-a", costMicros: 1750, computeMs: 40 }];
      const { intentId } = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x", spendBudget: 9000 });
      const mid = await c.stops.cleanupSpend(c.owner, scopeOf(c.task));
      assert.equal(mid?.intentId, intentId);
      assert.equal(mid?.spent, 0, "nothing is charged before a pass has run");
      await c.stops.advance(c.owner, { intentId });
      const after = await c.stops.cleanupSpend(c.mgr, scopeOf(c.task));
      assert.deepEqual([after?.mode, after?.phase, after?.spent, after?.spendBudget, after?.unpaid], ["stop", "done", 1250, 9000, false]);
      assert.deepEqual(after?.attempts, [{ attemptId: "att-a", costMicros: 1750, computeMs: 40, pending: false }], "the attempt total includes the ending (more than the preparation figure); an attempt with no reported cost is not listed");
      await refuses("forbidden", () => c.stops.cleanupSpend(c.ann, scopeOf(c.task)));
    });

    suite("cleanupSpend refuses an asker who may not control the scope, and a scope that does not exist, instead of saying nothing happened (card L02d review)", async (c) => {
      const r = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x" });
      await c.stops.advance(c.owner, { intentId: r.intentId });
      await refuses("forbidden", () => c.stops.cleanupSpend(c.ann, scopeOf(c.task)));
      await refuses("not_found", () => c.stops.cleanupSpend(c.owner, scopeOf("task-aaaaaaaaaaaaaaaaaaaa")));
    });

    suite("a task that was never stopped itself is answered by the stop that covers it: its agent's, and after that its own (card L02e)", async (c) => {
      c.rt.seenAttempts = ["att-agent"];
      c.rt.items = [{ kind: "foreground", ref: "att-agent/c1", state: "running" }];
      c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-agent", costMicros: 40, computeMs: 3 }] }];
      const byAgent = await c.stops.request(c.owner, { commandId: cid("s"), scope: agentScope(c), mode: "stop", reason: "the agent is stopped" });
      await c.stops.advance(c.owner, { intentId: byAgent.intentId });
      const seen = await c.stops.cleanupSpend(c.owner, scopeOf(c.task));
      assert.deepEqual([seen?.intentId, seen?.through, seen?.spent], [byAgent.intentId, { kind: "agent", id: c.agentA }, 40], "the task's view finds the stop made through its agent and names the scope it came through");
      assert.deepEqual(seen?.attempts, [{ attemptId: "att-agent", costMicros: 40, computeMs: 3, pending: false }], "and the attempts that stop charged");
      assert.equal(await c.stops.cleanupSpend(c.mgr, scopeOf(c.task)), undefined, "whoever may control the task but not the agent is told nothing of the agent's stop");
      // Once the task has a request of its own, that is the answer, wider or not.
      const own = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "the task itself" });
      await c.stops.advance(c.owner, { intentId: own.intentId });
      const after = await c.stops.cleanupSpend(c.owner, scopeOf(c.task));
      assert.deepEqual([after?.intentId, after?.through], [own.intentId, undefined], "the task's own request is the answer, not the agent's");
    });

    suite("a stop of the whole installation, of the team above the agent or of a swarm parent of the task answers for the task too, the newest of them first (card L02e)", async (c) => {
      assert.equal(await c.stops.cleanupSpend(c.owner, scopeOf(c.task)), undefined, "nothing has been asked for any scope yet");
      // The whole installation is stopped: every task and agent without a request of its own is answered from it.
      c.rt.seenAttempts = ["att-inst"];
      c.rt.items = [{ kind: "foreground", ref: "att-inst/c1", state: "running" }];
      c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-inst", costMicros: 80, computeMs: 2 }] }];
      const byInstallation = await c.stops.request(c.owner, { commandId: cid("s"), scope: { kind: "installation", id: "installation" }, mode: "stop", reason: "shutting down" });
      await c.stops.advance(c.owner, { intentId: byInstallation.intentId });
      const inst = await c.stops.cleanupSpend(c.owner, scopeOf(c.task));
      assert.deepEqual([inst?.intentId, inst?.through, inst?.spent, inst?.requestedAt], [byInstallation.intentId, { kind: "installation", id: "installation" }, 80, inst?.requestedAt], "the task's view finds the stop of the installation and names it");
      const ofAgent = await c.stops.cleanupSpend(c.owner, agentScope(c));
      assert.deepEqual([ofAgent?.intentId, ofAgent?.through?.kind], [byInstallation.intentId, "installation"], "an agent the installation stopped says so; the figures are the installation's, not the agent's alone");
      // The agent joins a team, and the team is stopped later: the newer request that reaches the task answers.
      now += 60_000;
      const team = (await c.agents.createTeam(c.owner, { commandId: cid("team"), name: "Team One" })).id;
      const agent = await c.agents.get(c.owner, c.agentA);
      await c.agents.update(c.owner, { commandId: cid("mv"), agentId: c.agentA, expectedRevision: agent!.revision, teamId: team });
      c.rt.seenAttempts = ["att-team"];
      c.rt.items = [{ kind: "foreground", ref: "att-team/c1", state: "running" }];
      c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-team", costMicros: 30, computeMs: 2 }] }];
      const byTeam = await c.stops.request(c.owner, { commandId: cid("s"), scope: { kind: "team", id: team }, mode: "stop", reason: "the team is stopped" });
      await c.stops.advance(c.owner, { intentId: byTeam.intentId });
      const byTeamSeen = await c.stops.cleanupSpend(c.owner, scopeOf(c.task));
      assert.deepEqual([byTeamSeen?.intentId, byTeamSeen?.through, byTeamSeen?.spent], [byTeam.intentId, { kind: "team", id: team }, 30], "the stop of the team its agent joined answers, not the older one of the installation");
      // A swarm parent stopped later still: the parent's Stop ends the child's work, so its cleanup is the child's answer.
      now += 60_000;
      const parent = (await c.projects.createTask({ commandId: cid("t"), actor: c.owner.id, projectId: c.project, title: "parent" })).id;
      await swarmLink(c.runner, c.task, parent, c.project);
      assert.equal(((await c.runner.get("swarm-link", c.task))?.body as unknown as { parentTaskId?: string }).parentTaskId, parent, "the task is recorded as the parent's child");
      c.rt.seenAttempts = ["att-parent"];
      c.rt.items = [{ kind: "foreground", ref: "att-parent/c1", state: "running" }];
      c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-parent", costMicros: 60, computeMs: 2 }] }];
      const byParent = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(parent), mode: "stop", reason: "the parent is stopped" });
      await c.stops.advance(c.owner, { intentId: byParent.intentId });
      const byParentSeen = await c.stops.cleanupSpend(c.owner, scopeOf(c.task));
      assert.deepEqual([byParentSeen?.intentId, byParentSeen?.through], [byParent.intentId, { kind: "task", id: parent }], "the newest request that reaches the task is the answer");
    });

    suite("a Stop of the agent or team that runs a swarm PARENT answers for the child too, since it ends the child's work (the walk), and the parent's own assignment date is what counts, not the child's (card L02e)", async (c) => {
      const agentB = (await c.agents.create(c.owner, { commandId: cid("agb"), friendlyName: "B" })).id;
      const parent = (await c.projects.createTask({ commandId: cid("t"), actor: c.owner.id, projectId: c.project, title: "parent of the child" })).id;
      await swarmLink(c.runner, c.task, parent, c.project);
      // A Stop of B made before the parent was given to B did not reach it, nor therefore the child.
      c.rt.seenAttempts = ["att-early"];
      c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-early", costMicros: 5, computeMs: 1 }] }];
      const early = await c.stops.request(c.owner, { commandId: cid("s"), scope: { kind: "agent", id: agentB }, mode: "stop", reason: "before" });
      await c.stops.advance(c.owner, { intentId: early.intentId });
      await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: { kind: "agent", id: agentB }, reason: "back" });
      now += 60_000;
      await c.projects.transitionTask({ commandId: cid("r"), actor: c.owner.id, taskId: parent, expectedRevision: 1, to: "ready" });
      await c.assignments.assignTask({ commandId: cid("as"), actor: c.owner.id, taskId: parent, owner: { kind: "agent", id: agentB } });
      assert.equal(await c.stops.cleanupSpend(c.owner, scopeOf(c.task)), undefined, "the child's own agent was never stopped, and B's old Stop did not reach the parent");
      now += 60_000;
      c.rt.seenAttempts = ["att-b"];
      c.rt.items = [{ kind: "foreground", ref: "att-b/c1", state: "running" }];
      c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-b", costMicros: 70, computeMs: 3 }] }];
      const byB = await c.stops.request(c.owner, { commandId: cid("s"), scope: { kind: "agent", id: agentB }, mode: "stop", reason: "the parent's agent" });
      await c.stops.advance(c.owner, { intentId: byB.intentId });
      const seen = await c.stops.cleanupSpend(c.owner, scopeOf(c.task));
      assert.deepEqual([seen?.intentId, seen?.through, seen?.spent], [byB.intentId, { kind: "agent", id: agentB }, 70], "the child's view finds the Stop of its swarm parent's agent");
      // A team above the parent's agent, stopped later, answers instead.
      now += 60_000;
      const team = (await c.agents.createTeam(c.owner, { commandId: cid("team"), name: "Team B" })).id;
      const b = await c.agents.get(c.owner, agentB);
      await c.agents.update(c.owner, { commandId: cid("mv"), agentId: agentB, expectedRevision: b!.revision, teamId: team });
      c.rt.seenAttempts = ["att-tb"];
      c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-tb", costMicros: 9, computeMs: 1 }] }];
      const byTeam = await c.stops.request(c.owner, { commandId: cid("s"), scope: { kind: "team", id: team }, mode: "stop", reason: "team B" });
      await c.stops.advance(c.owner, { intentId: byTeam.intentId });
      assert.deepEqual([(await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))?.through], [{ kind: "team", id: team }]);
      // Someone who may control the child but not the parent's agent is told nothing of those Stops, exactly as if they did not exist.
      assert.equal(await c.stops.cleanupSpend(c.mgr, scopeOf(c.task)), undefined);
    });

    suite("a wider scope's stop made before the task existed, or before the task was given to that agent, is not the task's answer (review of card L02e)", async (c) => {
      c.rt.seenAttempts = ["att-old"];
      c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-old", costMicros: 10, computeMs: 1 }] }];
      const byInstallation = await c.stops.request(c.owner, { commandId: cid("s"), scope: { kind: "installation", id: "installation" }, mode: "stop", reason: "shutting down" });
      await c.stops.advance(c.owner, { intentId: byInstallation.intentId });
      await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: { kind: "installation", id: "installation" }, reason: "back" });
      assert.equal((await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))?.intentId, byInstallation.intentId, "the task that existed then was reached");
      now += 60_000;
      const later = (await c.projects.createTask({ commandId: cid("t"), actor: c.owner.id, projectId: c.project, title: "later" })).id;
      assert.equal(await c.stops.cleanupSpend(c.owner, scopeOf(later)), undefined, "a task created after that stop was never reached by it");
      // The agent is stopped and resumed; a task given to the agent afterwards was not reached by that stop.
      now += 60_000;
      const byAgent = await c.stops.request(c.owner, { commandId: cid("s"), scope: agentScope(c), mode: "stop", reason: "agent" });
      await c.stops.advance(c.owner, { intentId: byAgent.intentId });
      await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: agentScope(c), reason: "back" });
      assert.equal((await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))?.intentId, byAgent.intentId, "the agent's task then is answered by the agent's stop");
      now += 60_000;
      await c.projects.transitionTask({ commandId: cid("r"), actor: c.owner.id, taskId: later, expectedRevision: 1, to: "ready" });
      await c.assignments.assignTask({ commandId: cid("as"), actor: c.owner.id, taskId: later, owner: { kind: "agent", id: c.agentA } });
      assert.equal(await c.stops.cleanupSpend(c.owner, scopeOf(later)), undefined, "a task given to the agent after its stop was not reached by it");
    });

    suite("a Stop of the agent holds the swarm children of its tasks for the dispatcher (wider), not for swarm.cancel's own-task look; a resume lets go (review of card L02e)", async (c) => {
      const byAgent = await c.stops.request(c.owner, { commandId: cid("s"), scope: agentScope(c), mode: "stop", reason: "agent" });
      await c.stops.advance(c.owner, { intentId: byAgent.intentId });
      assert.equal(await c.stops.holding(c.task, "child-y"), undefined, "the task has no Stop of its own");
      assert.equal((await c.stops.holding(c.task, "child-y", { wider: true }))?.intentId, byAgent.intentId, "the agent's Stop ended the children's work, so it holds them");
      mayHoldHook = async (_by, child) => child !== "child-x";
      assert.equal(await c.stops.holding(c.task, "child-x", { wider: true }), undefined, "not a child the one who stopped may not control");
      await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: agentScope(c), reason: "back" });
      assert.equal(await c.stops.holding(c.task, "child-y", { wider: true }), undefined, "the resume lets go");
    });

    suite("cleanupSpend lists the attempts the ending charged when preparation never saw them: a Force Stop, and a Stop that reuses a finished Suspend's checkpoint (card L02d review)", async (c) => {
      // A Force Stop goes straight to the ending.
      c.rt.terminateCosts = [{ attemptId: "att-f", costMicros: 900, computeMs: 3 }];
      await c.stops.force(c.owner, { commandId: cid("f"), scope: scopeOf(c.task), reason: "now" });
      const forced = await c.stops.cleanupSpend(c.owner, scopeOf(c.task));
      assert.deepEqual(forced?.attempts, [{ attemptId: "att-f", costMicros: 900, computeMs: 3, pending: false }]);
      // Suspend, then Stop reusing the checkpoint: the attempt the Suspend saw stays listed, one only the ending charged is added.
      await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: scopeOf(c.task), reason: "again" });
      c.rt.seenAttempts = ["att-a"];
      c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-a", costMicros: 100, computeMs: 1 }] }];
      const sus = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "x" });
      assert.equal((await c.stops.advance(c.owner, { intentId: sus.intentId })).outcome?.state, "suspended");
      c.rt.terminateCosts = [{ attemptId: "att-b", costMicros: 50, computeMs: 0 }];
      const stop = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x" });
      assert.equal((await c.stops.advance(c.owner, { intentId: stop.intentId })).outcome?.state, "stopped");
      const reused = await c.stops.cleanupSpend(c.owner, scopeOf(c.task));
      assert.equal(reused?.intentId, stop.intentId);
      assert.deepEqual(reused?.attempts.map((x) => [x.attemptId, x.costMicros]).sort(), [["att-a", 100], ["att-b", 50]]);
    });

    suite("cleanupSpend after a Force Stop over a blocked request keeps the preparation's figures and says the force came after it (card L02d review)", async (c) => {
      c.rt.seenAttempts = ["att-a"];
      c.rt.items = [{ kind: "process", ref: "pid-7", state: "uncooperative" }];
      c.rt.cleanups = [{ remaining: [{ kind: "process", ref: "pid-7", state: "uncooperative" }], costs: [{ attemptId: "att-a", costMicros: 5000, computeMs: 0 }] }];
      const { intentId } = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x", spendBudget: 100 });
      assert.equal((await c.stops.advance(c.owner, { intentId })).phase, "blocked");
      await c.stops.force(c.owner, { commandId: cid("f"), scope: scopeOf(c.task), reason: "enough" });
      const seen = await c.stops.cleanupSpend(c.owner, scopeOf(c.task));
      assert.deepEqual([seen?.intentId, seen?.mode, seen?.spent, seen?.spendBudget, seen?.forcedAfterPreparation, seen?.reusedCheckpoint], [intentId, "force-stop", 5000, 100, true, false]);
      // A Force Stop with nothing before it is not "after preparation"; a Stop that reused a checkpoint says so.
      await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: scopeOf(c.task), reason: "again" });
      c.rt.items = []; c.rt.cleanups = [{ remaining: [] }];
      await c.stops.force(c.owner, { commandId: cid("f"), scope: scopeOf(c.task), reason: "plain" });
      const plain = await c.stops.cleanupSpend(c.owner, scopeOf(c.task));
      assert.deepEqual([plain?.mode, plain?.forcedAfterPreparation, plain?.reusedCheckpoint], ["force-stop", false, false]);
      await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: scopeOf(c.task), reason: "again" });
      const sus = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "x" });
      await c.stops.advance(c.owner, { intentId: sus.intentId });
      const stop = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x" });
      await c.stops.advance(c.owner, { intentId: stop.intentId });
      const reused = await c.stops.cleanupSpend(c.owner, scopeOf(c.task));
      assert.deepEqual([reused?.intentId, reused?.mode, reused?.reusedCheckpoint, reused?.forcedAfterPreparation], [stop.intentId, "stop", true, false]);
    });

    /** Walks away from an advance that dies inside terminate (the call never returns), as the kill test does. */
    const dieInTerminate = async (c: { rt: Runtime; stops: StopService; owner: Principal }, intentId: string): Promise<void> => {
      const before = c.rt.count("terminate");
      c.rt.crashOnTerminate = true;
      void c.stops.advance(c.owner, { intentId }).catch(() => undefined);
      for (let i = 0; i < 400 && c.rt.count("terminate") === before; i++) await new Promise((r) => setTimeout(r, 25));
      assert.equal(c.rt.count("terminate"), before + 1, "the call is inside terminate");
      c.rt.crashOnTerminate = false;
    };

    suite("a Force Stop over a Stop that already reached its ending still has that Stop's preparation behind it, and one over a reused checkpoint says so (card L02d review)", async (c) => {
      c.rt.seenAttempts = ["att-a"];
      c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-a", costMicros: 1250, computeMs: 0 }] }];
      const first = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x", spendBudget: 9000 });
      await dieInTerminate(c, first.intentId);
      assert.equal((await c.stops.get(c.owner, first.intentId))?.phase, "terminating");
      const reopened = c.reopen();
      await reopened.force(c.owner, { commandId: cid("f"), scope: scopeOf(c.task), reason: "give up waiting" });
      const a = await reopened.cleanupSpend(c.owner, scopeOf(c.task));
      assert.deepEqual([a?.mode, a?.spent, a?.spendBudget, a?.forcedAfterPreparation, a?.reusedCheckpoint, a?.endingRan], ["force-stop", 1250, 9000, true, false, true]);
      // Suspend, Stop that reuses the checkpoint, a crash inside the ending, then Force Stop.
      await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: scopeOf(c.task), reason: "again" });
      const sus = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "x" });
      assert.equal((await c.stops.advance(c.owner, { intentId: sus.intentId })).outcome?.state, "suspended");
      const reuse = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x" });
      await dieInTerminate(c, reuse.intentId);
      const again = c.reopen();
      await again.force(c.owner, { commandId: cid("f"), scope: scopeOf(c.task), reason: "give up waiting" });
      const b = await again.cleanupSpend(c.owner, scopeOf(c.task));
      assert.deepEqual([b?.intentId, b?.mode, b?.forcedAfterPreparation, b?.reusedCheckpoint], [reuse.intentId, "force-stop", true, true]);
    });

    suite("a second Force Stop keeps the first one's link to the earlier preparation, and a Force Stop over a request that is only prepared knows its reused checkpoint (card L02d review)", async (c) => {
      c.rt.seenAttempts = ["att-a"];
      c.rt.items = [{ kind: "process", ref: "pid-7", state: "uncooperative" }];
      c.rt.cleanups = [{ remaining: [{ kind: "process", ref: "pid-7", state: "uncooperative" }], costs: [{ attemptId: "att-a", costMicros: 5000, computeMs: 0 }] }];
      const { intentId } = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x", spendBudget: 100 });
      assert.equal((await c.stops.advance(c.owner, { intentId })).phase, "blocked");
      c.rt.throwOnTerminate = true;
      await c.stops.force(c.owner, { commandId: cid("f"), scope: scopeOf(c.task), reason: "first" });
      assert.equal((await c.stops.get(c.owner, intentId))?.phase, "blocked", "the ending failed, so the Force Stop is blocked");
      assert.equal((await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))?.endingRan, false);
      c.rt.throwOnTerminate = false;
      await c.stops.force(c.owner, { commandId: cid("f"), scope: scopeOf(c.task), reason: "second" });
      const seen = await c.stops.cleanupSpend(c.owner, scopeOf(c.task));
      assert.deepEqual([seen?.intentId, seen?.mode, seen?.forcedAfterPreparation, seen?.spent, seen?.spendBudget, seen?.endingRan], [intentId, "force-stop", true, 5000, 100, true]);
      assert.equal((await c.stops.get(c.owner, intentId))?.forced?.afterPreparation, true, "the flag itself is written (the inference for older records must not be what passes this)");
      // Prepared only: Suspend, then a reusing Stop, forced before anything advanced it.
      await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: scopeOf(c.task), reason: "again" });
      c.rt.items = []; c.rt.cleanups = [{ remaining: [] }];
      const sus = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "x" });
      await c.stops.advance(c.owner, { intentId: sus.intentId });
      const reuse = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x" });
      assert.equal((await c.stops.get(c.owner, reuse.intentId))?.phase, "prepared");
      await c.stops.force(c.owner, { commandId: cid("f"), scope: scopeOf(c.task), reason: "now" });
      const b = await c.stops.cleanupSpend(c.owner, scopeOf(c.task));
      assert.deepEqual([b?.intentId, b?.forcedAfterPreparation, b?.reusedCheckpoint], [reuse.intentId, true, true]);
      assert.equal((await c.stops.get(c.owner, reuse.intentId))?.forced?.afterPreparation, true);
    });

    suite("a request written by an older build reads without false statements: a Force Stop with no flag but a limit or a figure still counts as after a preparation (card L02d review)", async (c) => {
      c.rt.seenAttempts = ["att-a"];
      c.rt.items = [{ kind: "process", ref: "pid-7", state: "uncooperative" }];
      c.rt.cleanups = [{ remaining: [{ kind: "process", ref: "pid-7", state: "uncooperative" }], costs: [{ attemptId: "att-a", costMicros: 5000, computeMs: 0 }] }];
      const { intentId } = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x", spendBudget: 100 });
      await c.stops.advance(c.owner, { intentId });
      await c.stops.force(c.owner, { commandId: cid("f"), scope: scopeOf(c.task), reason: "enough" });
      await c.edit(intentId, (b) => { const { afterPreparation: _a, ...forced } = b["forced"] as Record<string, unknown>; const { ended: _e, reusedFrom: _r, ...rest } = b; return { ...rest, forced }; });
      const old = await c.stops.cleanupSpend(c.owner, scopeOf(c.task));
      assert.deepEqual([old?.forcedAfterPreparation, old?.spent, old?.spendBudget, old?.endingRan, old?.reusedCheckpoint, old?.phase], [true, 5000, 100, false, false, "done"], "the figure and the limit are not hidden; a flag that was never written reads as not ended (the view still treats a done stop as ended)");
    });

    suite("an unpaid mark that another request's charge has already paid reads as mark only, and a sweep clears it (card L02d review)", async (c) => {
      c.rt.seenAttempts = ["att-a"];
      c.rt.terminateCosts = [{ attemptId: "att-a", costMicros: 500, computeMs: 0 }];
      c.rt.failCharges = 5;
      const first = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x" });
      await c.stops.advance(c.owner, { intentId: first.intentId });
      const before = await c.stops.cleanupSpend(c.owner, scopeOf(c.task));
      assert.deepEqual([before?.unpaid, before?.markOnly, before?.attempts[0]?.pending], [true, false, true]);
      // The charges work again; a Stop of the agent (a different scope, the same attempt) pays the task's pending note.
      c.rt.failCharges = 0;
      const second = await c.stops.request(c.owner, { commandId: cid("s"), scope: { kind: "agent", id: c.agentA }, mode: "stop", reason: "x" });
      await c.stops.advance(c.owner, { intentId: second.intentId });
      const mid = await c.stops.cleanupSpend(c.owner, scopeOf(c.task));
      assert.deepEqual([mid?.unpaid, mid?.markOnly, mid?.attempts[0]?.pending, mid?.attempts[0]?.costMicros], [true, true, false, 500]);
      await c.stops.sweep(c.owner);
      const after = await c.stops.cleanupSpend(c.owner, scopeOf(c.task));
      assert.deepEqual([after?.unpaid, after?.markOnly], [false, false], "the sweep takes the mark off");
    });

    suite("a wait after a failed ending keeps the preparation's figure; only a wait on a blocked preparation restarts the window (card L02d review)", async (c) => {
      c.rt.seenAttempts = ["att-a"];
      c.rt.items = [{ kind: "process", ref: "pid-7", state: "uncooperative" }];
      c.rt.cleanups = [{ remaining: [{ kind: "process", ref: "pid-7", state: "uncooperative" }], costs: [{ attemptId: "att-a", costMicros: 5000, computeMs: 0 }] }];
      const { intentId } = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x", spendBudget: 100 });
      assert.equal((await c.stops.advance(c.owner, { intentId })).phase, "blocked");
      c.rt.throwOnTerminate = true;
      await c.stops.force(c.owner, { commandId: cid("f"), scope: scopeOf(c.task), reason: "now" });
      assert.equal((await c.stops.get(c.owner, intentId))?.blocked?.resume, "terminating");
      await c.stops.choose(c.owner, { commandId: cid("c"), intentId, choice: "wait" });
      assert.equal((await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))?.spent, 5000, "the window that used 5000 came before the Force Stop; the wait did not restart it");
      // A graceful Stop blocked at its ending, then waited on, keeps its preparation figure too.
      await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: scopeOf(c.task), reason: "again" });
      c.rt.throwOnTerminate = true; c.rt.items = []; c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-a", costMicros: 7000, computeMs: 0 }] }];
      const g = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x" });
      assert.equal((await c.stops.advance(c.owner, { intentId: g.intentId })).phase, "blocked");
      const spentBefore = (await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))?.spent;
      assert.ok(spentBefore !== undefined && spentBefore > 0);
      await c.stops.choose(c.owner, { commandId: cid("c"), intentId: g.intentId, choice: "wait" });
      assert.equal((await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))?.spent, spentBefore);
    });

    suite("the cumulative cleanup total keeps what earlier cleanup budget windows counted: each wait on a blocked preparation restarts the window, the total adds them up, and it is never below the window's figure (card L02e)", async (c) => {
      c.rt.seenAttempts = ["att-a", "att-b"];
      const stuck = { kind: "process" as const, ref: "pid-7", state: "uncooperative" as const };
      c.rt.items = [stuck];
      c.rt.cleanups = [{ remaining: [stuck], costs: [{ attemptId: "att-a", costMicros: 5000, computeMs: 0 }] }];
      const { intentId } = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x" });
      assert.equal((await c.stops.advance(c.owner, { intentId })).phase, "blocked");
      const first = (await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))!;
      assert.deepEqual([first.spent, first.cumulativeSpent], [5000, 5000], "one window: the total is the window's figure");
      // Wait: the window starts again from nothing, and the total keeps the 5000.
      await c.stops.choose(c.owner, { commandId: cid("c1"), intentId, choice: "wait" });
      const restarted = (await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))!;
      assert.deepEqual([restarted.spent, restarted.cumulativeSpent], [0, 5000], "the window restarted; the total did not lose the earlier window");
      // The second window blocks again after spending 3000; a third wait adds that too.
      c.rt.cleanups = [{ remaining: [stuck], costs: [{ attemptId: "att-b", costMicros: 3000, computeMs: 0 }] }];
      assert.equal((await c.stops.advance(c.owner, { intentId })).phase, "blocked");
      const second = (await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))!;
      assert.deepEqual([second.spent, second.cumulativeSpent], [3000, 8000]);
      await c.stops.choose(c.owner, { commandId: cid("c2"), intentId, choice: "wait" });
      const third = (await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))!;
      assert.deepEqual([third.spent, third.cumulativeSpent], [0, 8000]);
      // The last window settles the work: the total is the earlier windows plus this one.
      c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-a", costMicros: 6000, computeMs: 0 }] }];
      const done = await c.stops.advance(c.owner, { intentId });
      assert.notEqual(done.phase, "blocked");
      const end = (await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))!;
      assert.equal(end.cumulativeSpent, end.spent + 8000, "the earlier windows plus this one");
      assert.ok(end.cumulativeSpent >= end.spent);
    });

    suite("the cumulative total reads sound from a record written before it was kept, from damaged figures and from a Force Stop that took the request over (card L02e)", async (c) => {
      assert.equal(addCapped(0, 0), 0);
      assert.equal(addCapped(5000, 3000), 8000);
      assert.equal(addCapped(Number.MAX_SAFE_INTEGER, 5), Number.MAX_SAFE_INTEGER, "a sum that would pass the safe range is held at it");
      assert.equal(addCapped(-4, 7), 7, "a negative figure counts as nothing");
      assert.equal(addCapped(Number.NaN, 7), 7);
      assert.equal(addCapped(1.5, 7), 7, "a figure that is not a whole number counts as nothing");
      c.rt.seenAttempts = ["att-a"];
      const stuck = { kind: "process" as const, ref: "pid-7", state: "uncooperative" as const };
      c.rt.items = [stuck];
      c.rt.cleanups = [{ remaining: [stuck], costs: [{ attemptId: "att-a", costMicros: 4000, computeMs: 0 }] }];
      const { intentId } = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x" });
      await c.stops.advance(c.owner, { intentId });
      await c.stops.choose(c.owner, { commandId: cid("c1"), intentId, choice: "wait" });
      // A Force Stop over the request keeps the earlier windows in the total.
      await c.stops.force(c.owner, { commandId: cid("f"), scope: scopeOf(c.task), reason: "now" });
      const forced = (await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))!;
      assert.ok(forced.cumulativeSpent >= forced.spent);
      assert.equal(forced.cumulativeSpent, 4000 + forced.spent, "the window before the wait is still counted after the Force Stop");
      // A record from a build that did not keep the field (no earlier-window figure) reads as a total equal to the window.
      const old = await c.stops.get(c.owner, intentId);
      assert.equal(old?.spentBefore, 4000);
    });

    suite("an older request that took over earlier work reads as having a preparation by each sign it can carry, and a pure Force Stop by none (card L02d review)", async (c) => {
      // A Force Stop over a request that was still preparing, with no limit, no figure and no checkpoint: only its history shows it.
      c.rt.items = [{ kind: "foreground", ref: "att-a/c1", state: "running" }];
      c.rt.cleanups = [{ remaining: [{ kind: "foreground", ref: "att-a/c1", state: "running" }] }];
      const { intentId } = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "x" });
      assert.equal((await c.stops.advance(c.owner, { intentId })).phase, "preparing");
      await c.stops.force(c.owner, { commandId: cid("f"), scope: scopeOf(c.task), reason: "now" });
      assert.equal((await c.stops.get(c.owner, intentId))?.forced?.afterPreparation, true);
      const strip = (keep: "history" | "spendBudget" | "spent" | "prepared" | "none") => c.edit(intentId, (b) => {
        const { afterPreparation: _a, ...forced } = b["forced"] as Record<string, unknown>;
        const { spendBudget: _sb, prepared: _p, ...rest } = b;
        const at = { at: "2026-10-28T10:00:00.000Z", by: "x" };
        return { ...rest, forced, spent: keep === "spent" ? 123 : 0, ...(keep === "spendBudget" ? { spendBudget: 50 } : {}), ...(keep === "prepared" ? { prepared: { at: "2026-10-28T10:00:00.000Z", checkpointId: "cp-1" } } : {}),
          history: keep === "history" ? [{ phase: "preparing", note: "suspend requested", ...at }, { phase: "terminating", note: "force stop: now", ...at }] : [{ phase: "terminating", note: "force stop: now", ...at }] };
      });
      for (const [keep, expected] of [["history", true], ["spendBudget", true], ["spent", true], ["prepared", true], ["none", false]] as const) {
        await strip(keep);
        assert.equal((await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))?.forcedAfterPreparation, expected, `only ${keep} is left of the signs`);
      }
      // An old Force Stop whose ending ran and left work unresolved: the settle's note shows the ending ran, though `ended` was never written.
      await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: scopeOf(c.task), reason: "again" });
      c.rt.unresolved = ["pid-9"]; c.rt.terminateCosts = [{ attemptId: "att-a", costMicros: 900, computeMs: 0 }];
      await c.stops.force(c.owner, { commandId: cid("f"), scope: scopeOf(c.task), reason: "again" });
      const fresh = (await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))!;
      assert.deepEqual([fresh.mode, fresh.phase, fresh.endingRan, fresh.forcedAfterPreparation, fresh.attempts.map((a) => a.costMicros)], ["force-stop", "recovery-required", true, false, [900]]);
      await c.edit(fresh.intentId, (b) => { const { ended: _e, attempts: _t, ...rest } = b; return rest; });
      const old = (await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))!;
      assert.deepEqual([old.endingRan, old.forcedAfterPreparation, old.attempts], [true, false, []], "the ending is known to have run from the history; no attempt is listed, which the view words neutrally");
    });

    suite("an unpaid note written by another request on the same attempt is not this request's debt (card L02d review)", async (c) => {
      c.rt.seenAttempts = ["att-a"];
      c.rt.terminateCosts = [{ attemptId: "att-a", costMicros: 500, computeMs: 0 }];
      const first = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x" });
      await c.stops.advance(c.owner, { intentId: first.intentId });
      assert.equal((await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))?.unpaid, false);
      // A later Stop of the agent charges more on the same attempt and that charge fails.
      c.rt.terminateCosts = [{ attemptId: "att-a", costMicros: 900, computeMs: 0 }];
      c.rt.failCharges = 5;
      const second = await c.stops.request(c.owner, { commandId: cid("s"), scope: { kind: "agent", id: c.agentA }, mode: "stop", reason: "x" });
      await c.stops.advance(c.owner, { intentId: second.intentId });
      const mine = (await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))!;
      assert.deepEqual([mine.unpaid, mine.markOnly, mine.attempts[0]?.pending], [false, false, true], "the attempt shows a charge being made; this request owes nothing");
      const theirs = (await c.stops.cleanupSpend(c.owner, { kind: "agent", id: c.agentA }))!;
      assert.equal(theirs.unpaid, true);
    });

    suite("a Force Stop that came after a preparation is still told so when a long history has pushed every preparing step out; only the flag says it (card L02d review)", async (c) => {
      c.rt.items = [{ kind: "foreground", ref: "att-a/c1", state: "running" }];
      c.rt.cleanups = [{ remaining: [{ kind: "foreground", ref: "att-a/c1", state: "running" }] }];
      const { intentId } = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "x" });
      assert.equal((await c.stops.advance(c.owner, { intentId })).phase, "preparing");
      c.rt.throwOnTerminate = true;
      await c.stops.force(c.owner, { commandId: cid("f"), scope: scopeOf(c.task), reason: "now" });
      for (let i = 0; i < 35; i++) {
        await c.stops.choose(c.owner, { commandId: cid("c"), intentId, choice: "wait" });
        assert.equal((await c.stops.advance(c.owner, { intentId })).phase, "blocked");
      }
      const got = (await c.stops.get(c.owner, intentId))!;
      assert.equal(got.history.length, 60);
      assert.ok(!got.history.some((h) => h.phase === "preparing" || h.phase === "prepared"), "no preparing or prepared step is left in the history");
      const seen = await c.stops.cleanupSpend(c.owner, scopeOf(c.task));
      assert.deepEqual([seen?.spent, seen?.spendBudget, seen?.forcedAfterPreparation], [0, undefined, true]);
    });

    suite("a request whose charge failed on another request's unpaid note is indexed too, so a sweep clears its mark once the note is paid (card L02d review)", async (c) => {
      c.rt.seenAttempts = ["att-a"];
      c.rt.terminateCosts = [{ attemptId: "att-a", costMicros: 500, computeMs: 0 }, { attemptId: "att-b", costMicros: 300, computeMs: 0 }];
      c.rt.failCharges = 100;
      const f1 = await c.stops.force(c.owner, { commandId: cid("f"), scope: scopeOf(c.task), reason: "first" });
      assert.equal((await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))?.unpaid, true);
      await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: scopeOf(c.task), reason: "again" });
      c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-a", costMicros: 600, computeMs: 0 }] }];
      const s = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x" });
      assert.notEqual(s.intentId, f1.intentId);
      await c.stops.force(c.owner, { commandId: cid("f"), scope: scopeOf(c.task), reason: "second" });
      const before = (await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))!;
      assert.deepEqual([before.intentId, before.unpaid, before.markOnly], [s.intentId, true, false], "its own figure (600) is above what was charged: it is owed, not mark only");
      c.rt.failCharges = 0;
      await c.stops.sweep(c.owner);
      const after = (await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))!;
      assert.deepEqual([after.unpaid, after.markOnly], [false, false], "the sweep paid the other request's note and cleared this request's mark too");
    });

    const sumOf = (c: { rt: { charges: Array<{ attemptId: string; costMicros: number }> } }, a: string): number => c.rt.charges.filter((x) => x.attemptId === a).reduce((s, x) => s + x.costMicros, 0);

    suite("a higher figure the ending reports while the request's own earlier note cannot be paid is charged by the sweep, and the view does not say paid before (card L02d review)", async (c) => {
      c.rt.seenAttempts = [];
      c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-b", costMicros: 20, computeMs: 0 }] }];
      c.rt.terminateCosts = [{ attemptId: "att-b", costMicros: 111, computeMs: 0 }];
      c.rt.failCharges = 100;
      const { intentId } = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x" });
      await c.stops.advance(c.owner, { intentId });
      assert.equal(sumOf(c, "att-b"), 0);
      assert.equal((await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))?.unpaid, true);
      c.rt.failCharges = 0;
      await c.stops.sweep(c.owner);
      assert.equal(sumOf(c, "att-b"), 111, "the whole reported figure is charged");
      const seen = (await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))!;
      assert.deepEqual([seen.unpaid, seen.attempts.map((a) => [a.attemptId, a.costMicros, a.pending])], [false, [["att-b", 111, false]]]);
      assert.equal((await c.runner.list("stop-charge-open", { limit: 10 })).length, 0, "the entry is taken off the index once everything is charged");
    });

    suite("a Force Stop's higher figure behind an earlier request's unpaid note is charged by the sweep (card L02d review)", async (c) => {
      c.rt.seenAttempts = [];
      c.rt.terminateCosts = [{ attemptId: "att-c", costMicros: 20, computeMs: 0 }];
      c.rt.failCharges = 100;
      await c.stops.force(c.owner, { commandId: cid("f"), scope: scopeOf(c.task), reason: "first" });
      await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: scopeOf(c.task), reason: "again" });
      c.rt.terminateCosts = [{ attemptId: "att-c", costMicros: 56, computeMs: 0 }];
      const second = await c.stops.force(c.owner, { commandId: cid("f"), scope: scopeOf(c.task), reason: "second" });
      assert.equal(sumOf(c, "att-c"), 0);
      const mid = (await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))!;
      assert.deepEqual([mid.intentId, mid.unpaid, mid.markOnly], [second.intentId, true, false], "its own figure above the note is owed: not mark only");
      c.rt.failCharges = 0;
      await c.stops.sweep(c.owner);
      assert.equal(sumOf(c, "att-c"), 56, "20 of the first request and the 36 more the second one reported");
      assert.equal((await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))?.unpaid, false);
    });

    suite("the sweep does not clear a request while its higher figure still cannot be charged (card L02d review)", async (c) => {
      c.rt.seenAttempts = [];
      c.rt.terminateCosts = [{ attemptId: "att-c", costMicros: 20, computeMs: 0 }];
      c.rt.failCharges = 100;
      await c.stops.force(c.owner, { commandId: cid("f"), scope: scopeOf(c.task), reason: "first" });
      await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: scopeOf(c.task), reason: "again" });
      c.rt.terminateCosts = [{ attemptId: "att-c", costMicros: 56, computeMs: 0 }];
      const second = await c.stops.force(c.owner, { commandId: cid("f"), scope: scopeOf(c.task), reason: "second" });
      // The first note's charge goes through, then the budget is unreachable again for the rest.
      c.rt.failCharges = 0;
      const real = c.rt.charge.bind(c.rt);
      let calls = 0;
      c.rt.charge = async (x) => { if (++calls > 1) throw new Error("the budget could not be reached"); await real(x); };
      await c.stops.sweep(c.owner);
      assert.equal(sumOf(c, "att-c"), 20);
      assert.equal((await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))?.unpaid, true, "36 are still owed");
      assert.equal(await outcomeMarked(c, second.intentId), true, "and the request keeps its mark while they are");
      c.rt.charge = real;
      await c.stops.sweep(c.owner);
      assert.equal(sumOf(c, "att-c"), 56);
      assert.equal((await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))?.unpaid, false);
    });

    /** Runs `hook` before every storage write (the hook may throw to fail it, or run other work); returns the function that puts the storage back. */
    const tap = (c: { storage: unknown }, hook: (input: { changes: Array<{ ref: { kind: string; id: string }; body?: Record<string, any> }> }) => Promise<void>): (() => void) => {
      const s = c.storage as { applyOperation: (input: never) => Promise<unknown> };
      const had = Object.prototype.hasOwnProperty.call(s, "applyOperation");
      const orig = s.applyOperation;
      s.applyOperation = function (this: unknown, input: never) { return hook(input as never).then(() => orig.call(s, input)); };
      return () => { if (had) s.applyOperation = orig; else delete (s as Partial<typeof s>).applyOperation; };
    };
    const sleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));
    /** A promise that fails instead of hanging when the thing it waits for never happens. */
    const within = <T,>(p: Promise<T>, what: string, ms = 10000): Promise<T> => new Promise<T>((res, rej) => { const t = setTimeout(() => rej(new Error(`timed out waiting for ${what}`)), ms); p.then((v) => { clearTimeout(t); res(v); }, (e: unknown) => { clearTimeout(t); rej(e); }); });
    const MARK = "cleanup spend not charged";
    const outcomeMarked = async (c: { runner: CommandRunner }, id: string): Promise<boolean> => (((await c.runner.get("stop-intent", id))!.body as { outcome?: { unresolved: string[] } }).outcome?.unresolved ?? []).includes(MARK);
    const agentScope = (c: { agentA: string }) => ({ kind: "agent", id: c.agentA }) as const;
    const openEntries = async (c: { runner: CommandRunner }) => c.runner.list("stop-charge-open", { limit: 50 });
    const loseAll = (c: { storage: unknown }, attemptId: string): (() => void) => tap(c, async (input) => {
      if (input.changes.some((z) => z.ref.id === attemptId && (z.ref.kind === "stop-charge" || z.ref.kind === "stop-charge-open"))) throw new DomainError("stale_revision", "someone else wrote it");
    });
    const owedOf = async (c: { runner: CommandRunner }, id: string): Promise<unknown> => (await c.runner.get("stop-intent", id))!.body["owed"];


    suite("two passes of one request that wait at once with different figures: the higher figure is charged, not dropped as a replay (card L02d review 6, F1)", async (c) => {
      c.rt.seenAttempts = [];
      c.rt.failCharges = 1000;
      c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-a", costMicros: 10, computeMs: 0 }] }];
      const y = await c.stops.request(c.owner, { commandId: cid("s"), scope: agentScope(c), mode: "suspend", reason: "y" });
      await c.stops.advance(c.owner, { intentId: y.intentId });
      c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-a", costMicros: 20, computeMs: 0 }] }, { remaining: [], costs: [{ attemptId: "att-a", costMicros: 30, computeMs: 0 }] }];
      const x = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "x" });
      // Both passes are inside the runtime's cleanup before either goes on; the pass that reports 20 then goes first and records its wait, and the one that reports 30 is held until the open entry carries 20,
      // so the 30 is raised over a LOWER figure that is already there (without the order, the pass reporting 30 can write its wait first and the test never checks raising).
      let entered = 0;
      let both!: () => void;
      const ready = new Promise<void>((r) => { both = r; });
      const cleanup = c.rt.cleanup.bind(c.rt);
      let sawLower = false;
      c.rt.cleanup = async (s, o) => {
        const mine = ++entered;
        if (mine === 2) both();
        await within(ready, "the second pass to reach cleanup");
        if (mine === 2) {
          for (let i = 0; i < 1000 && !sawLower; i++) { sawLower = ((await c.runner.get("stop-charge-open", "att-a"))?.body as { want?: { costMicros: number } } | undefined)?.want?.costMicros === 20; if (!sawLower) await sleep(10); }
        }
        return cleanup(s, o);
      };
      const results = await Promise.allSettled([c.stops.advance(c.owner, { intentId: x.intentId }), c.stops.advance(c.owner, { intentId: x.intentId })]);
      assert.equal(entered, 2, "both passes reached the runtime");
      assert.equal(sawLower, true, "the lower figure was on the entry before the higher one was recorded");
      // A pass may lose six races in a row under load and fail with the retryable error; nothing else is acceptable.
      for (const r of results) if (r.status === "rejected") { assert.ok(r.reason instanceof DomainError, String(r.reason)); assert.equal(r.reason.code, "stale_revision"); }
      c.rt.failCharges = 0;
      for (let i = 0; i < 3; i++) await c.stops.sweep(c.owner);
      assert.equal(sumOf(c, "att-a"), 30, "the highest figure either pass reported");
      assert.equal((await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))?.unpaid, false);
      assert.equal((await openEntries(c)).length, 0);
    });

    suite("a lower figure reported later does not replace a higher one that is waiting to be charged (card L02d review 6, G)", async (c) => {
      c.rt.seenAttempts = [];
      c.rt.failCharges = 1000;
      c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-a", costMicros: 10, computeMs: 0 }] }];
      const y = await c.stops.request(c.owner, { commandId: cid("s"), scope: agentScope(c), mode: "suspend", reason: "y" });
      await c.stops.advance(c.owner, { intentId: y.intentId });
      c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-a", costMicros: 30, computeMs: 0 }] }];
      const x = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "x" });
      await c.stops.advance(c.owner, { intentId: x.intentId });
      await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: scopeOf(c.task), reason: "again" });
      c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-a", costMicros: 20, computeMs: 0 }] }];
      const z = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "z" });
      await c.stops.advance(c.owner, { intentId: z.intentId });
      c.rt.failCharges = 0;
      for (let i = 0; i < 3; i++) await c.stops.sweep(c.owner);
      assert.equal(sumOf(c, "att-a"), 30);
    });

    suite("a failed write that clears a request's mark leaves the entry on the index, and a later sweep clears it (card L02d review 6, F2a)", async (c) => {
      c.rt.seenAttempts = [];
      c.rt.terminateCosts = [{ attemptId: "att-c", costMicros: 20, computeMs: 0 }];
      c.rt.failCharges = 1000;
      const { intentId } = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x" });
      await c.stops.advance(c.owner, { intentId });
      assert.equal(await outcomeMarked(c, intentId), true);
      c.rt.failCharges = 0;
      let failed = 0;
      const put = tap(c, async (input) => { if (failed === 0 && input.changes.some((x) => x.ref.kind === "stop-intent")) { failed++; throw new Error("storage went away"); } });
      await c.stops.sweep(c.owner);
      put();
      assert.equal(failed, 1);
      assert.equal(await outcomeMarked(c, intentId), true, "the clear did not happen");
      assert.equal((await openEntries(c)).length, 1, "so the entry stays for the next sweep");
      await c.stops.sweep(c.owner);
      assert.equal(await outcomeMarked(c, intentId), false);
      assert.equal((await openEntries(c)).length, 0);
      assert.equal((await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))?.unpaid, false);
    });

    suite("a sweep that runs between the ending's failed charge and the request's settling does not strand the mark (card L02d review 6, F2b)", async (c) => {
      c.rt.seenAttempts = [];
      c.rt.terminateCosts = [{ attemptId: "att-c", costMicros: 20, computeMs: 0 }];
      c.rt.failCharges = 1000;
      const { intentId } = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x" });
      let ran = false;
      const put = tap(c, async (input) => {
        const ending = input.changes.find((x) => x.ref.kind === "stop-intent" && x.body?.["ended"] === true && x.body?.["outcome"] === undefined);
        if (ran || ending === undefined) return;
        ran = true;
        c.rt.failCharges = 0;
        // The sweep runs now: the charge is paid and the request is not settled yet.
        const s = c.storage as { listAggregates: (kind: string, page: never) => Promise<Array<{ id: string }>> };
        const list = s.listAggregates;
        s.listAggregates = async (kind, page) => (await list.call(s, kind, page)).filter((x) => !(kind === "stop-intent" && x.id === intentId));
        try { await c.stops.sweep(c.owner); } finally { s.listAggregates = list; }
      });
      await c.stops.advance(c.owner, { intentId });
      put();
      assert.equal(ran, true);
      for (let i = 0; i < 3; i++) await c.stops.sweep(c.owner);
      assert.equal(sumOf(c, "att-c"), 20);
      assert.equal(await outcomeMarked(c, intentId), false, "the mark written after the sweep was cleared by a later one");
      assert.equal((await openEntries(c)).length, 0);
      assert.equal((await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))?.unpaid, false);
    });

    suite("an entry keeps a request that has not finished, the one whose note is pending and the one whose figure is wanted, past the cap (card L02d review 6, F3)", async (c) => {
      c.rt.seenAttempts = [];
      c.rt.items = [{ kind: "process", ref: "pid-7", state: "uncooperative" }];
      c.rt.cleanups = [{ remaining: [{ kind: "process", ref: "pid-7", state: "uncooperative" }], costs: [{ attemptId: "att-c", costMicros: 20, computeMs: 0 }] }];
      c.rt.failCharges = 1000;
      const x = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x" });
      assert.equal((await c.stops.advance(c.owner, { intentId: x.intentId })).phase, "blocked");
      // A second request, of the agent, is blocked too and waits on the first one's note: unfinished, unmarked, and not the note's owner.
      const w = await c.stops.request(c.owner, { commandId: cid("s"), scope: agentScope(c), mode: "stop", reason: "w" });
      assert.equal((await c.stops.advance(c.owner, { intentId: w.intentId })).phase, "blocked");
      const entry = (await openEntries(c))[0]!;
      assert.deepEqual([...(entry.body as { intents: string[] }).intents].sort(), [x.intentId, w.intentId].sort());
      // Twenty-five other requests (long gone) are on the entry too.
      const junk = Array.from({ length: 25 }, (_, i) => `stp-junk${i}`);
      await c.runner.command("test.seed-open", { commandId: cid("seed"), actor: "system" }, async () => ({ payload: {}, build: async () => ({ ref: { kind: "stop-charge-open", id: "att-c" }, creates: false, changes: [{ type: "update" as const, ref: { kind: "stop-charge-open", id: "att-c" }, expectedRevision: entry.revision, body: { intents: [x.intentId, w.intentId, ...junk], settled: false } as never }], detail: {} }) }));
      c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-c", costMicros: 30, computeMs: 0 }] }];
      c.rt.items = [];
      const y = await c.stops.request(c.owner, { commandId: cid("s"), scope: { kind: "installation", id: "installation" }, mode: "suspend", reason: "y" });
      await c.stops.advance(c.owner, { intentId: y.intentId });
      const after = (await openEntries(c))[0]!.body as { intents: string[]; want?: { intentId: string } };
      assert.deepEqual([...after.intents].sort(), [x.intentId, w.intentId, y.intentId].sort(), "the note's owner, the unfinished request and the joining one stay; the gone ones go");
      assert.equal(after.want?.intentId, y.intentId);
    });

    suite("an attempt a pass charged is listed even when another pass finished the request first (card L02d review 6, F4)", async (c) => {
      c.rt.seenAttempts = [];
      c.rt.cleanups = [{ remaining: [] }, { remaining: [], costs: [{ attemptId: "att-z", costMicros: 40, computeMs: 0 }] }];
      const { intentId } = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "x" });
      // The first pass is inside its cleanup while a second pass finishes the whole request.
      c.rt.duringCleanup = async () => { await c.stops.advance(c.owner, { intentId }); };
      const done = await c.stops.advance(c.owner, { intentId });
      assert.equal(done.phase, "done");
      assert.equal(sumOf(c, "att-z"), 40);
      const seen = (await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))!;
      assert.deepEqual(seen.attempts.map((a) => [a.attemptId, a.costMicros]), [["att-z", 40]]);
    });

    suite("a figure that cannot be charged because the note could not be written six times is not lost: the sweep charges it (card L02d review 6, C)", async (c) => {
      c.rt.seenAttempts = [];
      c.rt.terminateCosts = [{ attemptId: "att-c", costMicros: 20, computeMs: 0 }];
      const lose = tap(c, async (input) => {
        if (input.changes.some((x) => x.ref.kind === "stop-charge" && x.body?.["pending"] !== undefined)) throw new DomainError("stale_revision", "someone else wrote it");
      });
      const { intentId } = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x" });
      await c.stops.advance(c.owner, { intentId });
      lose();
      assert.equal(sumOf(c, "att-c"), 0);
      assert.equal(await outcomeMarked(c, intentId), true);
      for (let i = 0; i < 2; i++) await c.stops.sweep(c.owner);
      assert.equal(sumOf(c, "att-c"), 20);
      assert.equal(await outcomeMarked(c, intentId), false);
      assert.equal((await openEntries(c)).length, 0);
    });

    suite("an entry the sweep dropped between a pass's read and its write is a lost race, not a failure of the pass (card L02d review 6)", async (c) => {
      c.rt.seenAttempts = [];
      c.rt.terminateCosts = [{ attemptId: "att-c", costMicros: 20, computeMs: 0 }];
      c.rt.failCharges = 1000;
      await c.stops.force(c.owner, { commandId: cid("f"), scope: scopeOf(c.task), reason: "first" });
      await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: scopeOf(c.task), reason: "again" });
      c.rt.terminateCosts = [{ attemptId: "att-c", costMicros: 56, computeMs: 0 }];
      let dropped = false;
      const put = tap(c, async (input) => {
        if (dropped || !input.changes.some((x) => x.ref.kind === "stop-charge-open")) return;
        dropped = true;
        const entry = (await openEntries(c))[0]!;
        await c.runner.command("test.drop-open", { commandId: cid("drop"), actor: "system" }, async () => ({ payload: {}, build: async () => ({ ref: { kind: "stop-charge-open", id: "att-c" }, creates: false, changes: [{ type: "delete" as const, ref: { kind: "stop-charge-open", id: "att-c" }, expectedRevision: entry.revision }], detail: {} }) }));
      });
      await c.stops.force(c.owner, { commandId: cid("f"), scope: scopeOf(c.task), reason: "second" });
      put();
      assert.equal(dropped, true);
      c.rt.failCharges = 0;
      for (let i = 0; i < 3; i++) await c.stops.sweep(c.owner);
      assert.equal(sumOf(c, "att-c"), 56);
      assert.equal((await openEntries(c)).length, 0);
    });

    suite("an entry dropped between the read and the write of a note is a lost race too (card L02d review 6)", async (c) => {
      c.rt.seenAttempts = [];
      c.rt.terminateCosts = [{ attemptId: "att-c", costMicros: 20, computeMs: 0 }];
      await c.stops.force(c.owner, { commandId: cid("f"), scope: scopeOf(c.task), reason: "first" });
      assert.equal((await openEntries(c)).length, 1, "the settled entry is still on the index");
      await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: scopeOf(c.task), reason: "again" });
      c.rt.terminateCosts = [{ attemptId: "att-c", costMicros: 56, computeMs: 0 }];
      let dropped = false;
      // The sweep drops the settled entry after the second request has read it and before its note is written.
      const put = tap(c, async (input) => {
        if (dropped || !input.changes.some((x) => x.ref.kind === "stop-charge" && x.body?.["pending"] !== undefined) || !input.changes.some((x) => x.ref.kind === "stop-charge-open")) return;
        dropped = true;
        const entry = (await openEntries(c))[0]!;
        await c.runner.command("test.drop-open", { commandId: cid("drop"), actor: "system" }, async () => ({ payload: {}, build: async () => ({ ref: { kind: "stop-charge-open", id: "att-c" }, creates: false, changes: [{ type: "delete" as const, ref: { kind: "stop-charge-open", id: "att-c" }, expectedRevision: entry.revision }], detail: {} }) }));
      });
      const second = await c.stops.force(c.owner, { commandId: cid("f"), scope: scopeOf(c.task), reason: "second" });
      put();
      assert.equal(dropped, true);
      assert.equal(sumOf(c, "att-c"), 56, "the second request's note was written on the next try and paid");
      assert.equal(await outcomeMarked(c, second.intentId), false);
    });

    suite("a note another request writes right after the one a pass paid is paid first, never written over: nothing is charged twice (card L02d review 6)", async (c) => {
      c.rt.seenAttempts = [];
      c.rt.terminateCosts = [{ attemptId: "att-c", costMicros: 20, computeMs: 0 }];
      c.rt.failCharges = 1000;
      await c.stops.force(c.owner, { commandId: cid("f"), scope: scopeOf(c.task), reason: "first" });
      await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: scopeOf(c.task), reason: "again" });
      c.rt.failCharges = 0;
      c.rt.terminateCosts = [{ attemptId: "att-c", costMicros: 56, computeMs: 0 }];
      c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-c", costMicros: 41, computeMs: 0 }] }];
      const a = await c.stops.request(c.owner, { commandId: cid("s"), scope: agentScope(c), mode: "suspend", reason: "a" });
      // The pass of the second Force Stop pays the first request's note. Right after that is written, the agent's pass notes and pays a new charge (20 to 41) and is held just before it clears its note.
      let started = false, holding = false, aPass: Promise<unknown> | undefined;
      let release!: () => void, reached!: () => void;
      const gate = new Promise<void>((r) => { release = r; }), atSettle = new Promise<void>((r) => { reached = r; });
      const settles = (input: { changes: Array<{ ref: { kind: string }; body?: Record<string, any> }> }) => input.changes.some((x) => x.ref.kind === "stop-charge" && x.body?.["pending"] === undefined && x.body?.["costMicros"] > 0);
      const s = c.storage as { applyOperation: (input: never) => Promise<unknown> };
      const orig = s.applyOperation;
      s.applyOperation = async function (this: unknown, input: never) {
        if (holding && settles(input)) { reached(); await gate; }
        const result = await orig.call(s, input);
        if (!started && settles(input)) { started = true; holding = true; aPass = c.stops.advance(c.owner, { intentId: a.intentId }); await atSettle; holding = false; }
        return result;
      } as never;
      try { await c.stops.force(c.owner, { commandId: cid("f"), scope: scopeOf(c.task), reason: "second" }); } finally { release(); await aPass; s.applyOperation = orig; }
      for (let i = 0; i < 3; i++) await c.stops.sweep(c.owner);
      assert.equal(started, true);
      assert.equal(sumOf(c, "att-c"), 56, "the highest figure, once");
    });

    suite("a request that joins the entry between the sweep's page read and its drop keeps the entry (card L02d review 7, 1)", async (c) => {
      c.rt.seenAttempts = [];
      c.rt.terminateCosts = [{ attemptId: "att-c", costMicros: 20, computeMs: 0 }];
      c.rt.failCharges = 1000;
      const x = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x" });
      await c.stops.advance(c.owner, { intentId: x.intentId });
      const w = await c.stops.request(c.owner, { commandId: cid("s"), scope: agentScope(c), mode: "stop", reason: "w" });
      c.rt.failCharges = 0;
      let joined = false;
      // While the sweep clears the first request's mark, the second one (not finished) is listed on the entry, as if it had just waited on the note.
      const put = tap(c, async (input) => {
        if (joined || !input.changes.some((y) => y.ref.kind === "stop-intent" && y.ref.id === x.intentId)) return;
        joined = true;
        const entry = (await openEntries(c))[0]!;
        await c.runner.command("test.join-open", { commandId: cid("join"), actor: "system" }, async () => ({ payload: {}, build: async () => ({ ref: { kind: "stop-charge-open", id: "att-c" }, creates: false, changes: [{ type: "update" as const, ref: { kind: "stop-charge-open", id: "att-c" }, expectedRevision: entry.revision, body: { ...(entry.body as object), intents: [...(entry.body as { intents: string[] }).intents, w.intentId] } as never }], detail: {} }) }));
      });
      await c.stops.sweep(c.owner);
      put();
      assert.equal(joined, true);
      assert.equal(await outcomeMarked(c, x.intentId), false);
      assert.deepEqual(((await openEntries(c))[0]?.body as { intents: string[] } | undefined)?.intents.includes(w.intentId), true, "the entry stays for the request that joined");
    });

    suite("a request that the scope's resume moved on while the ending ran still records the ending and the attempts it charged (card L02d review 7, 2)", async (c) => {
      c.rt.seenAttempts = [];
      c.rt.terminateCosts = [{ attemptId: "att-c", costMicros: 20, computeMs: 0 }];
      const { intentId } = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x" });
      c.rt.duringTerminate = async () => {
        await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: scopeOf(c.task), reason: "again" });
        await c.stops.advance(c.owner, { intentId });
      };
      await c.stops.advance(c.owner, { intentId });
      const seen = (await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))!;
      assert.equal(seen.phase, "recovery-required", "the resume moved it while terminate was running");
      assert.equal(sumOf(c, "att-c"), 20);
      assert.deepEqual([seen.endingRan, seen.attempts.map((a) => a.attemptId)], [true, ["att-c"]]);
    });

    suite("a note whose wait loses six races in a row fails the pass, which stays retryable: a later sweep charges the figure (card L02d review 7, 3)", async (c) => {
      c.rt.seenAttempts = [];
      c.rt.failCharges = 1000;
      c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-a", costMicros: 10, computeMs: 0 }] }];
      const y = await c.stops.request(c.owner, { commandId: cid("s"), scope: agentScope(c), mode: "suspend", reason: "y" });
      await c.stops.advance(c.owner, { intentId: y.intentId });
      c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-a", costMicros: 30, computeMs: 0 }] }];
      const x = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "x" });
      const lose = tap(c, async (input) => {
        if (input.changes.some((z) => z.ref.kind === "stop-charge-open") && !input.changes.some((z) => z.ref.kind === "stop-charge")) throw new DomainError("stale_revision", "someone else wrote it");
      });
      // The wait that cannot be recorded in the entry is recorded on the request itself (card L02d review 9): the pass does not throw, and the figure is owed until the sweep charges it.
      await c.stops.advance(c.owner, { intentId: x.intentId });
      lose();
      assert.deepEqual(await owedOf(c, x.intentId), [{ attemptId: "att-a", costMicros: 30, computeMs: 0 }]);
      assert.equal((await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))?.unpaid, true);
      c.rt.failCharges = 0;
      for (let i = 0; i < 3; i++) await c.stops.sweep(c.owner);
      assert.equal(sumOf(c, "att-a"), 30);
      assert.equal(((await c.runner.get("stop-intent", x.intentId))!.body as { phase: string }).phase, "done");
      assert.equal(await owedOf(c, x.intentId), undefined);
    });

    suite("an entry whose wanted figure cannot be charged because its wait keeps losing races holds back only itself: the sweep still pays and clears the others (card L02d review 8)", async (c) => {
      c.rt.seenAttempts = [];
      c.rt.failCharges = 1000;
      c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-a", costMicros: 10, computeMs: 0 }] }];
      const y = await c.stops.request(c.owner, { commandId: cid("s"), scope: agentScope(c), mode: "suspend", reason: "y" });
      await c.stops.advance(c.owner, { intentId: y.intentId });
      // The contended entry: a Stop wanted 30 on att-a behind the agent's unpaid note.
      c.rt.terminateCosts = [{ attemptId: "att-a", costMicros: 30, computeMs: 0 }];
      const r = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "r" });
      await c.stops.advance(c.owner, { intentId: r.intentId });
      await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: scopeOf(c.task), reason: "again" });
      // The unrelated entry: a Force Stop's own unpaid note on att-b.
      c.rt.terminateCosts = [{ attemptId: "att-b", costMicros: 40, computeMs: 0 }];
      const rb = await c.stops.force(c.owner, { commandId: cid("f"), scope: scopeOf(c.task), reason: "rb" });
      assert.equal(await outcomeMarked(c, r.intentId), true);
      assert.equal(await outcomeMarked(c, rb.intentId), true);
      c.rt.failCharges = 0;
      const lose = tap(c, async (input) => {
        const lost = input.changes.some((z) => z.ref.kind === "stop-charge" && z.body?.["pending"] !== undefined) || (input.changes.some((z) => z.ref.kind === "stop-charge-open") && !input.changes.some((z) => z.ref.kind === "stop-charge"));
        if (lost) throw new DomainError("stale_revision", "someone else wrote it");
      });
      await c.stops.sweep(c.owner);
      lose();
      assert.equal(sumOf(c, "att-b"), 40, "the unrelated entry was paid in the same sweep");
      assert.equal(await outcomeMarked(c, rb.intentId), false, "and its request cleared");
      assert.equal(await outcomeMarked(c, r.intentId), true, "the contended one waits");
      await c.stops.sweep(c.owner);
      assert.equal(sumOf(c, "att-a"), 30);
      assert.equal(await outcomeMarked(c, r.intentId), false);
      assert.equal((await openEntries(c)).length, 0);
    });

    suite("a pass whose note and wait both lose every race records the figure on its own request, and the sweep charges it, once (card L02d review 9, single pass)", async (c) => {
      c.rt.seenAttempts = [];
      c.rt.terminateCosts = [{ attemptId: "att-b", costMicros: 20, computeMs: 0 }];
      const lose = loseAll(c, "att-b");
      const f = await c.stops.force(c.owner, { commandId: cid("f"), scope: scopeOf(c.task), reason: "f" });
      lose();
      assert.equal(sumOf(c, "att-b"), 0, "nothing could be written");
      assert.deepEqual(await owedOf(c, f.intentId), [{ attemptId: "att-b", costMicros: 20, computeMs: 0 }], "but the figure is not lost");
      const owing = await c.stops.cleanupSpend(c.owner, scopeOf(c.task));
      assert.equal(owing?.unpaid, true);
      assert.equal(owing?.markOnly, false, "this request still has charging to do");
      for (let i = 0; i < 3; i++) await c.stops.sweep(c.owner);
      assert.equal(sumOf(c, "att-b"), 20, "charged by the sweep, once");
      assert.equal(await owedOf(c, f.intentId), undefined);
      assert.equal(await outcomeMarked(c, f.intentId), false, "and the mark is taken off");
      assert.equal((await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))?.unpaid, false);
      assert.equal((await openEntries(c)).length, 0);
    });

    suite("two passes of one Suspend, the one that saw an extra attempt loses every race on it and the other settles the request: the extra attempt is still charged (card L02d review 9)", async (c) => {
      c.rt.seenAttempts = [];
      c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-a", costMicros: 57, computeMs: 0 }] }, { remaining: [], costs: [{ attemptId: "att-a", costMicros: 57, computeMs: 0 }, { attemptId: "att-c", costMicros: 60, computeMs: 0 }] }];
      const x = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "x" });
      let entered = 0;
      let both!: () => void;
      const ready = new Promise<void>((r) => { both = r; });
      const cleanup = c.rt.cleanup.bind(c.rt);
      c.rt.cleanup = async (s, o) => { if (++entered === 2) both(); await within(ready, "the second pass to reach cleanup"); return cleanup(s, o); };
      const lose = loseAll(c, "att-c");
      const results = await Promise.allSettled([c.stops.advance(c.owner, { intentId: x.intentId }), c.stops.advance(c.owner, { intentId: x.intentId })]);
      lose();
      assert.equal(entered, 2, "both passes reached the runtime");
      for (const r of results) assert.equal(r.status, "fulfilled", r.status === "rejected" ? String(r.reason) : "");
      assert.equal(((await c.runner.get("stop-intent", x.intentId))!.body as { phase: string }).phase, "done");
      assert.equal(sumOf(c, "att-c"), 0);
      assert.equal((await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))?.unpaid, true, "the view does not say nothing is unpaid");
      for (let i = 0; i < 3; i++) await c.stops.sweep(c.owner);
      assert.equal(sumOf(c, "att-c"), 60, "the extra attempt is charged what was reported");
      assert.equal(sumOf(c, "att-a"), 57);
      assert.equal(await owedOf(c, x.intentId), undefined);
      assert.equal((await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))?.unpaid, false);
      assert.equal((await openEntries(c)).length, 0);
    });

    suite("a higher figure added to what a request owes while the lower one is being charged is kept, and charging what is owed again pays nothing twice (card L02d review 9)", async (c) => {
      c.rt.seenAttempts = [];
      c.rt.terminateCosts = [{ attemptId: "att-b", costMicros: 20, computeMs: 0 }];
      const lose = loseAll(c, "att-b");
      const f = await c.stops.force(c.owner, { commandId: cid("f"), scope: scopeOf(c.task), reason: "f" });
      lose();
      assert.equal((await owedOf(c, f.intentId) as unknown[]).length, 1);
      // While the sweep charges the 20, the request is told of a higher figure (a concurrent pass owes 35).
      const charge = c.rt.charge.bind(c.rt);
      let raised = false;
      c.rt.charge = async (input) => {
        if (!raised) {
          raised = true;
          const rec = (await c.runner.get("stop-intent", f.intentId))!;
          await c.runner.command("test.owe", { commandId: cid("owe"), actor: "system" }, async () => ({
            payload: { n: 1 },
            build: async () => ({ ref: { kind: "stop-intent", id: f.intentId }, creates: false, changes: [{ type: "update", ref: { kind: "stop-intent", id: f.intentId }, expectedRevision: rec.revision, body: { ...rec.body, owed: [{ attemptId: "att-b", costMicros: 35, computeMs: 0 }] } }], detail: {} }),
          }));
        }
        return charge(input);
      };
      for (let i = 0; i < 4; i++) await c.stops.sweep(c.owner);
      assert.equal(raised, true);
      assert.equal(sumOf(c, "att-b"), 35, "the higher figure is charged too");
      assert.equal(c.rt.charges.filter((z) => z.attemptId === "att-b").length, 2, "20, then the 15 above it, nothing twice");
      assert.equal(await owedOf(c, f.intentId), undefined);
      assert.equal(await outcomeMarked(c, f.intentId), false);
    });

    type World = Parameters<Parameters<typeof suite>[1]>[0];
    const computeOf = (c: { rt: { charges: Array<{ attemptId: string; computeMs: number }> } }, a: string): number => c.rt.charges.filter((x) => x.attemptId === a).reduce((s, x) => s + x.computeMs, 0);
    const historyNotes = async (c: { runner: CommandRunner }, id: string): Promise<string[]> => (((await c.runner.get("stop-intent", id))!.body as { history: Array<{ note: string }> }).history).map((h) => h.note);
    /** A Stop whose ending reports att-a 50 and att-b 30 while every write on att-a loses its race (att-a's 50 is owed on the request) and att-b's charge fails (its own note, on att-b's open entry). `failing` names the attempts whose charge still fails. */
    const owesAndWaits = async (c: World): Promise<{ intentId: string; failing: Set<string> }> => {
      c.rt.seenAttempts = [];
      c.rt.terminateCosts = [{ attemptId: "att-a", costMicros: 50, computeMs: 0 }, { attemptId: "att-b", costMicros: 30, computeMs: 0 }];
      const failing = new Set(["att-b"]);
      const real = c.rt.charge.bind(c.rt);
      c.rt.charge = async (x) => { if (failing.has(x.attemptId)) throw new Error("the budget could not be reached"); return real(x); };
      const lose = loseAll(c, "att-a");
      const { intentId } = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x" });
      await c.stops.advance(c.owner, { intentId });
      lose();
      assert.deepEqual(await owedOf(c, intentId), [{ attemptId: "att-a", costMicros: 50, computeMs: 0 }]);
      assert.equal(await outcomeMarked(c, intentId), true);
      assert.equal((await openEntries(c)).map((e) => e.id).join(), "att-b");
      return { intentId, failing };
    };

    suite("the sweep does not take the mark off a request that still owes a figure of its own, even when every entry that lists it is paid (card L02d review 14, 1)", async (c) => {
      const { intentId, failing } = await owesAndWaits(c);
      failing.clear();
      // att-b's note is paid in this sweep, while att-a is still contended, so what the request owes cannot be charged yet.
      const lose = loseAll(c, "att-a");
      await c.stops.sweep(c.owner);
      lose();
      assert.equal(sumOf(c, "att-b"), 30);
      assert.equal(sumOf(c, "att-a"), 0);
      assert.deepEqual(await owedOf(c, intentId), [{ attemptId: "att-a", costMicros: 50, computeMs: 0 }]);
      assert.equal(await outcomeMarked(c, intentId), true, "the request still owes att-a's 50");
      assert.equal((await historyNotes(c, intentId)).includes("the cleanup spend was charged later"), false, "and its history does not say otherwise");
      const view = await c.stops.cleanupSpend(c.owner, scopeOf(c.task));
      assert.deepEqual([view?.unpaid, view?.markOnly], [true, false]);
      for (let i = 0; i < 2; i++) await c.stops.sweep(c.owner);
      assert.equal(sumOf(c, "att-a"), 50);
      assert.equal(sumOf(c, "att-b"), 30);
      assert.equal(await owedOf(c, intentId), undefined);
      assert.equal(await outcomeMarked(c, intentId), false);
      assert.equal((await openEntries(c)).length, 0);
      assert.equal((await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))?.unpaid, false);
    });

    suite("charging what a request owes does not take its mark off while an open entry still lists it with an unpaid note (card L02d review 14)", async (c) => {
      const { intentId, failing } = await owesAndWaits(c);
      // att-a can be written now, but att-b's charge still fails.
      await c.stops.sweep(c.owner);
      assert.equal(sumOf(c, "att-a"), 50, "what was owed is charged");
      assert.equal(await owedOf(c, intentId), undefined);
      assert.equal(sumOf(c, "att-b"), 0);
      assert.equal(await outcomeMarked(c, intentId), true, "att-b's note is still unpaid");
      const view = await c.stops.cleanupSpend(c.owner, scopeOf(c.task));
      assert.deepEqual([view?.unpaid, view?.markOnly], [true, false]);
      failing.clear();
      await c.stops.sweep(c.owner);
      assert.equal(sumOf(c, "att-b"), 30);
      assert.equal(await outcomeMarked(c, intentId), false);
      assert.equal((await openEntries(c)).length, 0);
    });

    suite("a request whose only debt was owed, already covered by another request's charge, has its mark taken off by a later sweep when the first clear crashed after the owed figure was taken off (card L02d review 14, 2)", async (c) => {
      c.rt.seenAttempts = [];
      c.rt.terminateCosts = [{ attemptId: "att-a", costMicros: 50, computeMs: 0 }];
      const lose = loseAll(c, "att-a");
      const x = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x" });
      await c.stops.advance(c.owner, { intentId: x.intentId });
      lose();
      assert.deepEqual(await owedOf(c, x.intentId), [{ attemptId: "att-a", costMicros: 50, computeMs: 0 }]);
      assert.equal(await outcomeMarked(c, x.intentId), true);
      // A Stop of the agent charges the same attempt to a higher figure, so paying what x owes writes no note and x is on no open entry.
      c.rt.terminateCosts = [{ attemptId: "att-a", costMicros: 60, computeMs: 0 }];
      const y = await c.stops.request(c.owner, { commandId: cid("s"), scope: agentScope(c), mode: "stop", reason: "y" });
      await c.stops.advance(c.owner, { intentId: y.intentId });
      assert.equal(sumOf(c, "att-a"), 60);
      assert.equal((await openEntries(c)).some((e) => (e.body as { intents: string[] }).intents.includes(x.intentId)), false, "x is on no open entry");
      let crashed = 0;
      const put = tap(c, async (input) => {
        if (crashed === 0 && input.changes.some((z) => z.ref.kind === "stop-intent" && ((z.body?.["history"] ?? []) as Array<{ note: string }>).some((h) => h.note === "the cleanup spend was charged later"))) { crashed++; throw new Error("the process died"); }
      });
      await c.stops.sweep(c.owner);
      put();
      assert.equal(crashed, 1, "the owed figure was taken off, then the write clearing the mark failed");
      assert.equal(await owedOf(c, x.intentId), undefined);
      assert.equal(await outcomeMarked(c, x.intentId), true);
      await c.stops.sweep(c.owner);
      assert.equal(await outcomeMarked(c, x.intentId), false, "the next sweep clears it");
      assert.equal((await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))?.unpaid, false);
      assert.equal(sumOf(c, "att-a"), 60, "and nothing more is charged");
    });

    suite("a mark on a record an older build wrote (no `ended`) and on no open entry is left for the owner: the sweep does not say it was charged later (card L02d review 14)", async (c) => {
      c.rt.seenAttempts = [];
      const x = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x" });
      await c.stops.advance(c.owner, { intentId: x.intentId });
      await c.edit(x.intentId, (b) => { const { ended: _e, ...rest } = b; const outcome = b["outcome"] as { unresolved: string[] }; return { ...rest, phase: "recovery-required", outcome: { ...outcome, state: "recovery-required", unresolved: [MARK] } }; });
      for (let i = 0; i < 2; i++) await c.stops.sweep(c.owner);
      assert.equal(await outcomeMarked(c, x.intentId), true);
      assert.equal((await historyNotes(c, x.intentId)).includes("the cleanup spend was charged later"), false);
      // The view does not promise a clear no sweep will make (card L02d review 15).
      const v = (await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))!;
      assert.deepEqual([v.unpaid, v.markOnly, v.markKept, v.scanCut], [true, false, true, false]);
      // Listed on an open entry (behind another request's note), the same record's mark is cleared there once the entry is paid: the view says so.
      const changes = [
        { type: "create" as const, ref: { kind: "stop-charge", id: "att-l" }, body: { costMicros: 0, computeMs: 0, pending: { costMicros: 5, computeMs: 0, commandId: "stopcl-other", intentId: "stp-other", counted: true } } },
        { type: "create" as const, ref: { kind: "stop-charge-open", id: "att-l" }, body: { intents: ["stp-other", x.intentId], settled: false } },
      ];
      await c.runner.command("test.list", { commandId: cid("list"), actor: "system" }, async () => ({ payload: {}, build: async () => ({ ref: changes[0]!.ref, creates: true, changes: changes as never, detail: {} }) }));
      const listed = (await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))!;
      assert.deepEqual([listed.unpaid, listed.markOnly, listed.markKept, listed.scanCut], [true, true, false, false]);
    });

    suite("an owed figure whose charge is lost again stays owed, and a later sweep charges it (card L02d review 14)", async (c) => {
      c.rt.seenAttempts = [];
      c.rt.terminateCosts = [{ attemptId: "att-b", costMicros: 20, computeMs: 0 }];
      const lose = loseAll(c, "att-b");
      const f = await c.stops.force(c.owner, { commandId: cid("f"), scope: scopeOf(c.task), reason: "f" });
      await c.stops.sweep(c.owner);
      lose();
      assert.equal(sumOf(c, "att-b"), 0);
      assert.deepEqual(await owedOf(c, f.intentId), [{ attemptId: "att-b", costMicros: 20, computeMs: 0 }], "the failed charge did not take the figure off");
      assert.equal(await outcomeMarked(c, f.intentId), true);
      for (let i = 0; i < 2; i++) await c.stops.sweep(c.owner);
      assert.equal(sumOf(c, "att-b"), 20);
      assert.equal(await owedOf(c, f.intentId), undefined);
      assert.equal(await outcomeMarked(c, f.intentId), false);
    });

    suite("a lower figure owed later keeps the higher one in each dimension: cost and compute moving in different directions are both kept (card L02d review 14)", async (c) => {
      c.rt.seenAttempts = [];
      const x = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "x" });
      await c.edit(x.intentId, (b) => ({ ...b, owed: [{ attemptId: "att-b", costMicros: 35, computeMs: 1 }] }));
      c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-b", costMicros: 20, computeMs: 5 }] }];
      const lose = loseAll(c, "att-b");
      await c.stops.advance(c.owner, { intentId: x.intentId });
      lose();
      assert.deepEqual(await owedOf(c, x.intentId), [{ attemptId: "att-b", costMicros: 35, computeMs: 5 }]);
      for (let i = 0; i < 2; i++) await c.stops.sweep(c.owner);
      assert.deepEqual([sumOf(c, "att-b"), computeOf(c, "att-b")], [35, 5]);
      assert.equal(await owedOf(c, x.intentId), undefined);
    });

    suite("a wanted figure is raised in each dimension: a later report with more compute and less cost keeps the higher cost (card L02d review 14)", async (c) => {
      c.rt.seenAttempts = [];
      c.rt.failCharges = 1000;
      c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-a", costMicros: 10, computeMs: 0 }] }];
      const y = await c.stops.request(c.owner, { commandId: cid("s"), scope: agentScope(c), mode: "suspend", reason: "y" });
      await c.stops.advance(c.owner, { intentId: y.intentId });
      c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-a", costMicros: 70, computeMs: 1 }] }];
      const x = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "x" });
      await c.stops.advance(c.owner, { intentId: x.intentId });
      await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: scopeOf(c.task), reason: "again" });
      c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-a", costMicros: 50, computeMs: 5 }] }];
      const z = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "z" });
      await c.stops.advance(c.owner, { intentId: z.intentId });
      const want = ((await c.runner.get("stop-charge-open", "att-a"))!.body as { want?: { costMicros: number; computeMs: number } }).want;
      assert.deepEqual([want?.costMicros, want?.computeMs], [70, 5]);
      c.rt.failCharges = 0;
      for (let i = 0; i < 3; i++) await c.stops.sweep(c.owner);
      assert.deepEqual([sumOf(c, "att-a"), computeOf(c, "att-a")], [70, 5]);
      assert.equal((await openEntries(c)).length, 0);
    });

    suite("a paid note that covers the wanted cost but not the wanted compute keeps the want, so a sweep stopped right after it still charges the compute later (card L02d review 14)", async (c) => {
      c.rt.seenAttempts = [];
      c.rt.failCharges = 1000;
      c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-a", costMicros: 70, computeMs: 1 }] }];
      const y = await c.stops.request(c.owner, { commandId: cid("s"), scope: agentScope(c), mode: "suspend", reason: "y" });
      await c.stops.advance(c.owner, { intentId: y.intentId });
      c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-a", costMicros: 50, computeMs: 5 }] }];
      const x = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "x" });
      await c.stops.advance(c.owner, { intentId: x.intentId });
      c.rt.failCharges = 0;
      let writes = 0;
      const put = tap(c, async (input) => { if (input.changes.some((z) => z.ref.kind === "stop-charge") && ++writes > 1) throw new Error("storage went away"); });
      await c.stops.sweep(c.owner);
      put();
      assert.deepEqual([sumOf(c, "att-a"), computeOf(c, "att-a")], [70, 1], "only the note was paid");
      const want = ((await c.runner.get("stop-charge-open", "att-a"))!.body as { want?: { computeMs: number } }).want;
      assert.equal(want?.computeMs, 5, "the uncharged compute is still wanted");
      await c.stops.sweep(c.owner);
      assert.deepEqual([sumOf(c, "att-a"), computeOf(c, "att-a")], [70, 5]);
      assert.equal((await openEntries(c)).length, 0);
    });

    suite("an entry whose want is raised after the sweep read its page, by a request it lists and clears, is kept, and the next sweep charges the want (card L02d review 14)", async (c) => {
      c.rt.seenAttempts = [];
      c.rt.terminateCosts = [{ attemptId: "att-c", costMicros: 20, computeMs: 0 }];
      c.rt.failCharges = 1000;
      const f = await c.stops.force(c.owner, { commandId: cid("f"), scope: scopeOf(c.task), reason: "f" });
      assert.equal(await outcomeMarked(c, f.intentId), true);
      c.rt.failCharges = 0;
      const real = c.rt.charge.bind(c.rt);
      let raised = false;
      c.rt.charge = async (x) => {
        if (!raised) {
          raised = true;
          // While the sweep pays the note, the same request raises the wanted figure (as a concurrent sweep charging what it owes would, behind the note): it is listed on the entry already.
          const open = (await c.runner.get("stop-charge-open", "att-c"))!;
          await c.runner.command("test.raise", { commandId: cid("raise"), actor: "system" }, async () => ({
            payload: { n: 1 },
            build: async () => ({ ref: { kind: "stop-charge-open", id: "att-c" }, creates: false, changes: [{ type: "update", ref: { kind: "stop-charge-open", id: "att-c" }, expectedRevision: open.revision, body: { ...open.body, want: { costMicros: 90, computeMs: 0, intentId: f.intentId } } }], detail: {} }),
          }));
        }
        return real(x);
      };
      await c.stops.sweep(c.owner);
      assert.equal(raised, true);
      assert.equal(sumOf(c, "att-c"), 20);
      assert.equal((await openEntries(c)).length, 1, "the entry stays: 70 more are wanted");
      c.rt.charge = real;
      await c.stops.sweep(c.owner);
      assert.equal(sumOf(c, "att-c"), 90);
      assert.equal((await openEntries(c)).length, 0);
    });

    suite("a wanted figure whose charge cannot be recorded anywhere (note, entry and the request's own record all lose every race) keeps the requests on that entry marked (card L02d review 14)", async (c) => {
      c.rt.seenAttempts = [];
      c.rt.failCharges = 1000;
      c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-a", costMicros: 10, computeMs: 0 }] }];
      const y = await c.stops.request(c.owner, { commandId: cid("s"), scope: agentScope(c), mode: "suspend", reason: "y" });
      await c.stops.advance(c.owner, { intentId: y.intentId });
      c.rt.terminateCosts = [{ attemptId: "att-a", costMicros: 30, computeMs: 0 }];
      const r = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "r" });
      await c.stops.advance(c.owner, { intentId: r.intentId });
      await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: scopeOf(c.task), reason: "again" });
      c.rt.terminateCosts = [{ attemptId: "att-b", costMicros: 40, computeMs: 0 }];
      const rb = await c.stops.force(c.owner, { commandId: cid("f"), scope: scopeOf(c.task), reason: "rb" });
      assert.equal(await outcomeMarked(c, r.intentId), true);
      c.rt.failCharges = 0;
      const lose = tap(c, async (input) => {
        const lost = input.changes.some((z) => z.ref.kind === "stop-charge" && z.body?.["pending"] !== undefined) || (input.changes.some((z) => z.ref.kind === "stop-charge-open") && !input.changes.some((z) => z.ref.kind === "stop-charge"))
          || input.changes.some((z) => z.ref.kind === "stop-intent" && z.body?.["owed"] !== undefined);
        if (lost) throw new DomainError("stale_revision", "someone else wrote it");
      });
      await c.stops.sweep(c.owner);
      lose();
      assert.equal(sumOf(c, "att-b"), 40);
      assert.equal(await outcomeMarked(c, rb.intentId), false);
      assert.equal(sumOf(c, "att-a"), 10);
      assert.equal(await owedOf(c, r.intentId), undefined, "the figure could not be owed either");
      assert.equal(await outcomeMarked(c, r.intentId), true, "so the request on the contended entry keeps its mark");
      assert.equal(((await c.runner.get("stop-charge-open", "att-a"))!.body as { want?: { costMicros: number } }).want?.costMicros, 30, "and the want stays on the entry");
      await c.stops.sweep(c.owner);
      assert.equal(sumOf(c, "att-a"), 30);
      assert.equal(await outcomeMarked(c, r.intentId), false);
      assert.equal((await openEntries(c)).length, 0);
    });

    suite("a figure above the cap that waits (behind another request's unpaid note, or after its note lost every race) is waited for at the cap, so the entry is covered and dropped (card L02d review 14)", async (c) => {
      const CAP = 1_000_000_000_000;
      c.rt.seenAttempts = [];
      c.rt.failCharges = 1000;
      c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-a", costMicros: 10, computeMs: 0 }] }];
      const y = await c.stops.request(c.owner, { commandId: cid("s"), scope: agentScope(c), mode: "suspend", reason: "y" });
      await c.stops.advance(c.owner, { intentId: y.intentId });
      c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-a", costMicros: 2 * CAP, computeMs: 3 * CAP }, { attemptId: "att-b", costMicros: 3 * CAP, computeMs: 2 * CAP }] }];
      const x = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "x" });
      const lose = tap(c, async (input) => { if (input.changes.some((z) => z.ref.kind === "stop-charge" && z.ref.id === "att-b" && z.body?.["pending"] !== undefined)) throw new DomainError("stale_revision", "someone else wrote it"); });
      await c.stops.advance(c.owner, { intentId: x.intentId });
      lose();
      for (const a of ["att-a", "att-b"]) {
        const want = ((await c.runner.get("stop-charge-open", a))!.body as { want?: { costMicros: number; computeMs: number } }).want;
        assert.deepEqual([want?.costMicros, want?.computeMs], [CAP, CAP], `${a} waits at the cap`);
      }
      c.rt.failCharges = 0;
      for (let i = 0; i < 3; i++) await c.stops.sweep(c.owner);
      assert.deepEqual([sumOf(c, "att-a"), computeOf(c, "att-a"), sumOf(c, "att-b"), computeOf(c, "att-b")], [CAP, CAP, CAP, CAP]);
      assert.equal((await openEntries(c)).length, 0, "both entries are covered and dropped");
      assert.equal((await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))?.unpaid, false);
    });

    suite("a request that already owes figures for the inventory limit of attempts refuses one more: the pass is left unfinished, no older figure is dropped, and a later pass charges it (card L02d review 14)", async (c) => {
      c.rt.seenAttempts = [];
      c.rt.terminateCosts = [{ attemptId: "att-z", costMicros: 20, computeMs: 0 }];
      const x = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x" });
      const old = Array.from({ length: STOP_LIMITS.inventory }, (_, i) => ({ attemptId: `old-${i}`, costMicros: 1, computeMs: 0 }));
      await c.edit(x.intentId, (b) => ({ ...b, owed: old }));
      const lose = loseAll(c, "att-z");
      await refuses("stale_revision", () => c.stops.advance(c.owner, { intentId: x.intentId }));
      lose();
      assert.deepEqual(await owedOf(c, x.intentId), old, "the owed list is unchanged");
      assert.equal(((await c.runner.get("stop-intent", x.intentId))!.body as { phase: string }).phase, "terminating", "the request is still live");
      for (let i = 0; i < 2; i++) await c.stops.sweep(c.owner);
      assert.equal(sumOf(c, "att-z"), 20);
      assert.equal(sumOf(c, "old-0"), 1);
      assert.equal(sumOf(c, `old-${STOP_LIMITS.inventory - 1}`), 1);
      assert.equal(await owedOf(c, x.intentId), undefined);
      assert.equal(await outcomeMarked(c, x.intentId), false);
    });

    suite("an open index longer than one sweep reads: a mark is never cleared on a scan that did not reach the end, and the view says the scan was cut (card L02d review 15)", async (c) => {
      c.rt.seenAttempts = [];
      c.rt.failCharges = 1_000_000;
      // R1 waits only on an entry past the cut; R2 on one before it (paid) and one past it.
      c.rt.terminateCosts = [{ attemptId: "zzone", costMicros: 50, computeMs: 0 }];
      const r1 = await c.stops.force(c.owner, { commandId: cid("f"), scope: agentScope(c), reason: "r1" });
      await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: agentScope(c), reason: "again" });
      c.rt.terminateCosts = [{ attemptId: "aaok", costMicros: 10, computeMs: 0 }, { attemptId: "zztwo", costMicros: 20, computeMs: 0 }];
      const r2 = await c.stops.force(c.owner, { commandId: cid("f"), scope: scopeOf(c.task), reason: "r2" });
      for (const r of [r1, r2]) assert.equal(await outcomeMarked(c, r.intentId), true);
      // R1's record does not list its attempt (only the index does).
      await c.edit(r1.intentId, (b) => ({ ...b, attempts: [] }));
      // 2001 other unpaid entries sort between them: one sweep reads 2000 entries.
      for (let start = 0; start <= 2000; start += 50) {
        const changes: Array<{ type: "create"; ref: { kind: string; id: string }; body: Record<string, unknown> }> = [];
        for (let i = start; i < Math.min(start + 50, 2001); i++) {
          const a = "b" + String(i).padStart(5, "0");
          changes.push({ type: "create" as const, ref: { kind: "stop-charge", id: a }, body: { costMicros: 0, computeMs: 0, pending: { costMicros: 1, computeMs: 0, commandId: `stopcl-fill${i}`, intentId: "stp-other", counted: true } } });
          changes.push({ type: "create" as const, ref: { kind: "stop-charge-open", id: a }, body: { intents: ["stp-other"], settled: false } });
        }
        await c.runner.command("test.fill", { commandId: cid("fill"), actor: "system" }, async () => ({ payload: { start }, build: async () => ({ ref: changes[0]!.ref, creates: true, changes: changes as never, detail: {} }) }));
      }
      c.rt.failCharges = 0;
      const real = c.rt.charge.bind(c.rt);
      c.rt.charge = async (x) => { if (x.attemptId !== "aaok") throw new Error("the budget could not be reached"); return real(x); };
      await c.stops.sweep(c.owner);
      c.rt.charge = real;
      assert.deepEqual([sumOf(c, "aaok"), sumOf(c, "zzone"), sumOf(c, "zztwo")], [10, 0, 0]);
      for (const r of [r1, r2]) {
        assert.equal(await outcomeMarked(c, r.intentId), true, "the mark stays: an entry past the cut still waits");
        assert.equal((await historyNotes(c, r.intentId)).includes("the cleanup spend was charged later"), false);
      }
      const v1 = (await c.stops.cleanupSpend(c.owner, agentScope(c)))!;
      assert.deepEqual([v1.intentId, v1.unpaid, v1.markOnly, v1.markKept, v1.scanCut], [r1.intentId, true, false, false, true], "the view does not say nothing of its own is left");
      const v2 = (await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))!;
      assert.deepEqual([v2.unpaid, v2.markOnly, v2.scanCut], [true, false, false], "its own note on a listed attempt is found without the index");
    });

    suite("a sweep run while the charge port is absent takes nothing owed off and keeps the mark; a sweep with the port charges it (card L02d review 15)", async (c) => {
      c.rt.seenAttempts = [];
      const x = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x" });
      await c.stops.advance(c.owner, { intentId: x.intentId });
      await c.edit(x.intentId, (b) => { const outcome = b["outcome"] as { unresolved: string[] }; return { ...b, ended: true, owed: [{ attemptId: "att-o", costMicros: 30, computeMs: 2 }], outcome: { ...outcome, unresolved: [MARK] } }; });
      (c.rt as { charge?: unknown }).charge = undefined;
      for (let i = 0; i < 2; i++) await c.reopen().sweep(c.owner);
      delete (c.rt as { charge?: unknown }).charge;
      assert.deepEqual(await owedOf(c, x.intentId), [{ attemptId: "att-o", costMicros: 30, computeMs: 2 }], "nothing was charged, so nothing is taken off");
      assert.equal(await outcomeMarked(c, x.intentId), true);
      assert.equal(sumOf(c, "att-o"), 0);
      await c.reopen().sweep(c.owner);
      assert.deepEqual([sumOf(c, "att-o"), computeOf(c, "att-o")], [30, 2]);
      assert.equal(await owedOf(c, x.intentId), undefined);
      assert.equal(await outcomeMarked(c, x.intentId), false);
    });

    suite("a later owed figure with less compute does not lower the owed compute (card L02d review 15)", async (c) => {
      c.rt.seenAttempts = [];
      const x = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "x" });
      await c.edit(x.intentId, (b) => ({ ...b, owed: [{ attemptId: "att-b", costMicros: 20, computeMs: 5 }] }));
      c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-b", costMicros: 35, computeMs: 1 }] }];
      const lose = loseAll(c, "att-b");
      await c.stops.advance(c.owner, { intentId: x.intentId });
      lose();
      assert.deepEqual(await owedOf(c, x.intentId), [{ attemptId: "att-b", costMicros: 35, computeMs: 5 }]);
      for (let i = 0; i < 2; i++) await c.stops.sweep(c.owner);
      assert.deepEqual([sumOf(c, "att-b"), computeOf(c, "att-b")], [35, 5]);
    });

    suite("a higher compute figure owed while the lower one is being charged is kept, and charged later (card L02d review 15)", async (c) => {
      c.rt.seenAttempts = [];
      const x = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x" });
      await c.stops.advance(c.owner, { intentId: x.intentId });
      await c.edit(x.intentId, (b) => ({ ...b, ended: true, owed: [{ attemptId: "att-o", costMicros: 30, computeMs: 1 }] }));
      const real = c.rt.charge.bind(c.rt);
      let raised = false;
      c.rt.charge = async (y) => {
        if (!raised && y.attemptId === "att-o") { raised = true; await c.edit(x.intentId, (b) => ({ ...b, owed: [{ attemptId: "att-o", costMicros: 30, computeMs: 5 }] })); }
        return real(y);
      };
      await c.stops.sweep(c.owner);
      c.rt.charge = real;
      assert.equal(raised, true);
      assert.deepEqual([sumOf(c, "att-o"), computeOf(c, "att-o")], [30, 1]);
      assert.deepEqual(await owedOf(c, x.intentId), [{ attemptId: "att-o", costMicros: 30, computeMs: 5 }], "the higher compute is not taken off with the lower");
      await c.stops.sweep(c.owner);
      assert.deepEqual([sumOf(c, "att-o"), computeOf(c, "att-o")], [30, 5]);
      assert.equal(await owedOf(c, x.intentId), undefined);
    });

    suite("an entry whose wanted compute is raised after the sweep read its page is kept, and the next sweep charges the compute (card L02d review 15)", async (c) => {
      c.rt.seenAttempts = [];
      c.rt.terminateCosts = [{ attemptId: "att-c", costMicros: 20, computeMs: 0 }];
      c.rt.failCharges = 1000;
      const f = await c.stops.force(c.owner, { commandId: cid("f"), scope: scopeOf(c.task), reason: "f" });
      c.rt.failCharges = 0;
      const real = c.rt.charge.bind(c.rt);
      let raised = false;
      c.rt.charge = async (x) => {
        if (!raised) {
          raised = true;
          const open = (await c.runner.get("stop-charge-open", "att-c"))!;
          await c.runner.command("test.raise", { commandId: cid("raise"), actor: "system" }, async () => ({
            payload: { n: 1 },
            build: async () => ({ ref: { kind: "stop-charge-open", id: "att-c" }, creates: false, changes: [{ type: "update", ref: { kind: "stop-charge-open", id: "att-c" }, expectedRevision: open.revision, body: { ...open.body, want: { costMicros: 20, computeMs: 5, intentId: f.intentId } } }], detail: {} }),
          }));
        }
        return real(x);
      };
      await c.stops.sweep(c.owner);
      c.rt.charge = real;
      assert.equal(raised, true);
      assert.deepEqual([sumOf(c, "att-c"), computeOf(c, "att-c")], [20, 0]);
      assert.equal((await openEntries(c)).length, 1, "the entry stays: 5 ms of compute are wanted");
      await c.stops.sweep(c.owner);
      assert.deepEqual([sumOf(c, "att-c"), computeOf(c, "att-c")], [20, 5]);
      assert.equal((await openEntries(c)).length, 0);
    });

    suite("a wanted figure is raised in each dimension when cost and compute move in opposite directions: 50/5 then 70/1 gives 70/5 (card L02d review 15)", async (c) => {
      c.rt.seenAttempts = [];
      c.rt.failCharges = 1000;
      c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-a", costMicros: 10, computeMs: 0 }] }];
      const y = await c.stops.request(c.owner, { commandId: cid("s"), scope: agentScope(c), mode: "suspend", reason: "y" });
      await c.stops.advance(c.owner, { intentId: y.intentId });
      c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-a", costMicros: 50, computeMs: 5 }] }];
      const x = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "x" });
      await c.stops.advance(c.owner, { intentId: x.intentId });
      await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: scopeOf(c.task), reason: "again" });
      c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-a", costMicros: 70, computeMs: 1 }] }];
      const z = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "z" });
      await c.stops.advance(c.owner, { intentId: z.intentId });
      const want = ((await c.runner.get("stop-charge-open", "att-a"))!.body as { want?: { costMicros: number; computeMs: number } }).want;
      assert.deepEqual([want?.costMicros, want?.computeMs], [70, 5]);
      c.rt.failCharges = 0;
      for (let i = 0; i < 3; i++) await c.stops.sweep(c.owner);
      assert.deepEqual([sumOf(c, "att-a"), computeOf(c, "att-a")], [70, 5]);
    });

    suite("a request that owes figures for the inventory limit of attempts merges a higher figure for one of them instead of refusing it (card L02d review 15)", async (c) => {
      c.rt.seenAttempts = [];
      c.rt.terminateCosts = [{ attemptId: "old-5", costMicros: 20, computeMs: 0 }];
      const x = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x" });
      const old = Array.from({ length: STOP_LIMITS.inventory }, (_, i) => ({ attemptId: `old-${i}`, costMicros: 1, computeMs: 0 }));
      await c.edit(x.intentId, (b) => ({ ...b, owed: old }));
      const lose = loseAll(c, "old-5");
      await c.stops.advance(c.owner, { intentId: x.intentId });
      lose();
      const owed = await owedOf(c, x.intentId) as Array<{ attemptId: string; costMicros: number }>;
      assert.equal(owed.length, STOP_LIMITS.inventory);
      assert.equal(owed.find((o) => o.attemptId === "old-5")?.costMicros, 20);
      for (let i = 0; i < 2; i++) await c.stops.sweep(c.owner);
      assert.equal(sumOf(c, "old-5"), 20);
      assert.equal(await owedOf(c, x.intentId), undefined);
    });

    /** Writes `owed` onto the request right before the write that would take its mark off (as a concurrent pass recording a figure it could not charge would), once. */
    const oweBeforeClear = (c: { storage: unknown; edit(intentId: string, change: (body: Record<string, unknown>) => Record<string, unknown>): Promise<void> }, id: string): { done: () => boolean; restore: () => void } => {
      let fired = false, busy = false;
      const restore = tap(c, async (input) => {
        if (fired || busy) return;
        const w = input.changes.find((z) => z.ref.kind === "stop-intent" && z.ref.id === id);
        const history = w?.body?.["history"] as Array<{ note: string }> | undefined;
        if (w === undefined || history?.at(-1)?.note !== "the cleanup spend was charged later") return;
        busy = true;
        try { await c.edit(id, (b) => ({ ...b, owed: [{ attemptId: "att-q", costMicros: 15, computeMs: 0 }] })); } finally { busy = false; fired = true; }
      });
      return { done: () => fired, restore };
    };

    suite("a figure owed between the read and the write of #payOwed's clear keeps the mark, and is charged later (card L02d review 15)", async (c) => {
      c.rt.seenAttempts = [];
      const x = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x" });
      await c.stops.advance(c.owner, { intentId: x.intentId });
      await c.edit(x.intentId, (b) => { const outcome = b["outcome"] as { unresolved: string[] }; return { ...b, ended: true, outcome: { ...outcome, unresolved: [MARK] } }; });
      const race = oweBeforeClear(c, x.intentId);
      await c.stops.sweep(c.owner);
      race.restore();
      assert.equal(race.done(), true);
      assert.equal(await outcomeMarked(c, x.intentId), true, "the request owes again: the mark stays");
      assert.equal((await historyNotes(c, x.intentId)).includes("the cleanup spend was charged later"), false);
      for (let i = 0; i < 2; i++) await c.stops.sweep(c.owner);
      assert.equal(sumOf(c, "att-q"), 15);
      assert.equal(await owedOf(c, x.intentId), undefined);
      assert.equal(await outcomeMarked(c, x.intentId), false);
    });

    suite("a figure owed between the read and the write of the sweep's clear of a paid entry keeps the mark, and is charged later (card L02d review 15)", async (c) => {
      c.rt.seenAttempts = [];
      c.rt.terminateCosts = [{ attemptId: "att-c", costMicros: 20, computeMs: 0 }];
      c.rt.failCharges = 1000;
      const f = await c.stops.force(c.owner, { commandId: cid("f"), scope: scopeOf(c.task), reason: "f" });
      assert.equal(await outcomeMarked(c, f.intentId), true);
      c.rt.failCharges = 0;
      const race = oweBeforeClear(c, f.intentId);
      await c.stops.sweep(c.owner);
      race.restore();
      assert.equal(race.done(), true);
      assert.equal(sumOf(c, "att-c"), 20);
      assert.equal(await outcomeMarked(c, f.intentId), true, "the request owes again: the mark stays");
      assert.equal((await historyNotes(c, f.intentId)).includes("the cleanup spend was charged later"), false);
      for (let i = 0; i < 2; i++) await c.stops.sweep(c.owner);
      assert.equal(sumOf(c, "att-q"), 15);
      assert.equal(await owedOf(c, f.intentId), undefined);
      assert.equal(await outcomeMarked(c, f.intentId), false);
    });

    suite("a wanted figure survives a sweep that stops after the note was paid and before the rest was charged (card L02d review 6, G)", async (c) => {
      c.rt.seenAttempts = [];
      c.rt.terminateCosts = [{ attemptId: "att-c", costMicros: 20, computeMs: 0 }];
      c.rt.failCharges = 1000;
      await c.stops.force(c.owner, { commandId: cid("f"), scope: scopeOf(c.task), reason: "first" });
      await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: scopeOf(c.task), reason: "again" });
      c.rt.terminateCosts = [{ attemptId: "att-c", costMicros: 56, computeMs: 0 }];
      await c.stops.force(c.owner, { commandId: cid("f"), scope: scopeOf(c.task), reason: "second" });
      c.rt.failCharges = 0;
      let writes = 0;
      const put = tap(c, async (input) => { if (input.changes.some((x) => x.ref.kind === "stop-charge") && ++writes > 1) throw new Error("storage went away"); });
      await c.stops.sweep(c.owner);
      put();
      assert.equal(sumOf(c, "att-c"), 20, "only the note was paid");
      await c.stops.sweep(c.owner);
      assert.equal(sumOf(c, "att-c"), 56, "the wanted figure was still on the entry");
    });

    suite("the sweep keeps an entry when a request raised its figure while the note was being paid (card L02d review 6, G)", async (c) => {
      c.rt.seenAttempts = [];
      c.rt.terminateCosts = [{ attemptId: "att-c", costMicros: 20, computeMs: 0 }];
      c.rt.failCharges = 1000;
      await c.stops.force(c.owner, { commandId: cid("f"), scope: scopeOf(c.task), reason: "first" });
      c.rt.failCharges = 0;
      const real = c.rt.charge.bind(c.rt);
      let armed = true, inside = false;
      c.rt.charge = async (x) => {
        if (inside) throw new Error("the budget could not be reached");
        if (armed) {
          armed = false; inside = true;
          // while the note is being paid another request (of the agent) reports a higher figure and cannot charge it
          c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-c", costMicros: 90, computeMs: 0 }] }];
          const y = await c.stops.request(c.owner, { commandId: cid("s"), scope: agentScope(c), mode: "suspend", reason: "y" });
          await c.stops.advance(c.owner, { intentId: y.intentId });
          inside = false;
        }
        await real(x);
      };
      await c.stops.sweep(c.owner);
      assert.equal(sumOf(c, "att-c"), 20);
      assert.equal((await openEntries(c)).length, 1, "the entry stays: 70 more are wanted");
      await c.stops.sweep(c.owner);
      assert.equal(sumOf(c, "att-c"), 90);
      assert.equal((await openEntries(c)).length, 0);
    });

    suite("more than twenty requests waiting on one unpaid note are all kept on the index and all cleared by the sweep (card L02d review)", async (c) => {
      c.rt.seenAttempts = [];
      c.rt.terminateCosts = [{ attemptId: "att-c", costMicros: 20, computeMs: 0 }];
      c.rt.failCharges = 1000;
      const ids: string[] = [];
      for (let i = 0; i < 23; i++) {
        ids.push((await c.stops.force(c.owner, { commandId: cid("f"), scope: scopeOf(c.task), reason: `r${i}` })).intentId);
        await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: scopeOf(c.task), reason: "again" });
      }
      const open = await c.runner.list("stop-charge-open", { limit: 10 });
      assert.equal(open.length, 1);
      assert.deepEqual([...(open[0]!.body as { intents: string[] }).intents].sort(), [...ids].sort(), "none of the 23 waiting requests was dropped");
      c.rt.failCharges = 0;
      await c.stops.sweep(c.owner);
      for (const id of ids) {
        const marked = ((await c.runner.get("stop-intent", id))!.body as { outcome?: { unresolved: string[] } }).outcome?.unresolved.includes("cleanup spend not charged");
        assert.equal(marked, false, `request ${id} was cleared`);
      }
      assert.equal(sumOf(c, "att-c"), 20);
    });

    suite("a request's own pending note on an attempt its record does not list still reads as unpaid (card L02d review)", async (c) => {
      c.rt.seenAttempts = [];
      c.rt.cleanups = [{ remaining: [], costs: [{ attemptId: "att-b", costMicros: 20, computeMs: 0 }] }];
      c.rt.terminateCosts = [];
      c.rt.failCharges = 100;
      const { intentId } = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x" });
      await c.stops.advance(c.owner, { intentId });
      await c.edit(intentId, (b) => { delete b["attempts"]; return b; });
      const seen = (await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))!;
      assert.deepEqual([seen.attempts.length, seen.unpaid, seen.markOnly], [0, true, false]);
    });

    suite("an attempt that reported a cleanup cost is listed even when the runtime does not list it among its attempts (card L02d review)", async (c) => {
      c.rt.seenAttempts = [];
      c.rt.items = [{ kind: "process", ref: "pid-7", state: "uncooperative" }];
      c.rt.cleanups = [{ remaining: [{ kind: "process", ref: "pid-7", state: "uncooperative" }], costs: [{ attemptId: "att-z", costMicros: 800, computeMs: 0 }] }];
      c.rt.failCharges = 5;
      const { intentId } = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x" });
      assert.equal((await c.stops.advance(c.owner, { intentId })).phase, "blocked");
      const seen = (await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))!;
      assert.deepEqual(seen.attempts.map((a) => [a.attemptId, a.pending]), [["att-z", true]]);
      assert.equal(seen.unpaid, true, "its own pending note is open");
    });

    suite("a Force Stop after a wait keeps the limit and a spent figure of 0 (the window restarted) while the attempt shows what was charged; the view's wording carries that caveat (card L02d review)", async (c) => {
      c.rt.seenAttempts = ["att-a"];
      c.rt.items = [{ kind: "process", ref: "pid-7", state: "uncooperative" }];
      c.rt.cleanups = [{ remaining: [{ kind: "process", ref: "pid-7", state: "uncooperative" }], costs: [{ attemptId: "att-a", costMicros: 5000, computeMs: 0 }] }];
      const { intentId } = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x", spendBudget: 100 });
      assert.equal((await c.stops.advance(c.owner, { intentId })).phase, "blocked");
      await c.stops.choose(c.owner, { commandId: cid("c"), intentId, choice: "wait" });
      c.rt.items = [{ kind: "process", ref: "pid-7", state: "uncooperative" }];
      await c.stops.force(c.owner, { commandId: cid("f"), scope: scopeOf(c.task), reason: "enough" });
      const seen = await c.stops.cleanupSpend(c.owner, scopeOf(c.task));
      assert.deepEqual([seen?.spent, seen?.spendBudget, seen?.forcedAfterPreparation, seen?.attempts[0]?.costMicros], [0, 100, true, 5000]);
    });

    suite("reusedCheckpoint is a marker written at creation: a long history that drops the first entries does not change it (card L02d review)", async (c) => {
      const sus = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "x" });
      await c.stops.advance(c.owner, { intentId: sus.intentId });
      const stop = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x" });
      c.rt.throwOnTerminate = true;
      for (let i = 0; i < 40; i++) {
        const v = await c.stops.advance(c.owner, { intentId: stop.intentId });
        assert.equal(v.phase, "blocked");
        await c.stops.choose(c.owner, { commandId: cid("c"), intentId: stop.intentId, choice: "wait" });
      }
      const got = (await c.stops.get(c.owner, stop.intentId))!;
      assert.equal(got.history.length, 60, "the history is at its cap, the first entry is gone");
      assert.notEqual(got.history[0]!.phase, "prepared");
      assert.equal((await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))?.reusedCheckpoint, true);
    });

    suite("endingRan is true only once terminate has run: a restart from an earlier boundary never ends anything, and a suspend has no ending (card L02d review)", async (c) => {
      c.rt.items = [{ kind: "process", ref: "pid-7", state: "uncooperative" }];
      c.rt.cleanups = [{ remaining: [{ kind: "process", ref: "pid-7", state: "uncooperative" }] }];
      const { intentId } = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x" });
      assert.equal((await c.stops.advance(c.owner, { intentId })).phase, "blocked");
      assert.equal((await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))?.endingRan, false);
      await c.stops.choose(c.owner, { commandId: cid("c"), intentId, choice: "restart-earlier-boundary" });
      const seen = await c.stops.cleanupSpend(c.owner, scopeOf(c.task));
      assert.deepEqual([seen?.phase, seen?.endingRan, c.rt.count("terminate")], ["recovery-required", false, 0]);
      // A stop that does end says so.
      await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: scopeOf(c.task), reason: "again" });
      c.rt.items = []; c.rt.cleanups = [{ remaining: [] }];
      const next = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x" });
      await c.stops.advance(c.owner, { intentId: next.intentId });
      assert.equal((await c.stops.cleanupSpend(c.owner, scopeOf(c.task)))?.endingRan, true);
    });

    suite("cleanupSpend is unpaid while a charge failed during the preparation of a request that is still going (a pending note, no outcome yet) (card L02d review)", async (c) => {
      c.rt.seenAttempts = ["att-a"];
      c.rt.items = [{ kind: "foreground", ref: "att-a/c1", state: "running" }];
      c.rt.cleanups = [{ remaining: [{ kind: "foreground", ref: "att-a/c1", state: "running" }], costs: [{ attemptId: "att-a", costMicros: 700, computeMs: 0 }] }];
      c.rt.failCharges = 1;
      const { intentId } = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "suspend", reason: "x" });
      const live = await c.stops.advance(c.owner, { intentId });
      assert.deepEqual([live.phase, live.outcome], ["preparing", undefined]);
      const seen = await c.stops.cleanupSpend(c.owner, scopeOf(c.task));
      assert.deepEqual([seen?.unpaid, seen?.attempts[0]?.pending], [true, true]);
    });

    suite("cleanupSpend says a charge is still unpaid while one failed", async (c) => {
      c.rt.seenAttempts = ["att-a"];
      c.rt.terminateCosts = [{ attemptId: "att-a", costMicros: 400 }];
      c.rt.failCharges = 5;
      const r = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "x" });
      await c.stops.advance(c.owner, { intentId: r.intentId });
      const seen = await c.stops.cleanupSpend(c.owner, scopeOf(c.task));
      assert.equal(seen?.unpaid, true);
      assert.equal(seen?.phase, "recovery-required");
      assert.deepEqual(seen?.attempts.map((a) => [a.attemptId, a.pending]), [["att-a", true]]);
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

    suite("a Force Stop that was resumed does not hold when its scope is merely paused again: its own, or an agent's through a wider look (second review of card L02e)", async (c) => {
      const agent = { kind: "agent", id: c.agentA } as const;
      const forced = await c.stops.force(c.owner, { commandId: cid("f"), scope: agent, reason: "on fire" });
      assert.equal((await c.stops.holding(c.task, "child-y", { wider: true }))?.intentId, forced.intentId, "held while the force stop's own pause stands");
      await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: agent, reason: "back" });
      await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: agent, reason: "just a pause" });
      assert.equal(await c.stops.holding(c.task, "child-y", { wider: true }), undefined, "the finished force stop is not the cause of this pause");
      const own = await c.stops.force(c.owner, { commandId: cid("f2"), scope: scopeOf(c.task), reason: "on fire" });
      assert.equal((await c.stops.holding(c.task))?.intentId, own.intentId);
      await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: scopeOf(c.task), reason: "back" });
      await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: scopeOf(c.task), reason: "just a pause" });
      assert.equal(await c.stops.holding(c.task), undefined, "nor is the task's own finished force stop");
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

    /** Writes `count` open entries named `prefix` + a five-digit number; `body(i)` gives each entry's index body and, optionally, its charge record. */
    const fillIndex = async (c: { runner: CommandRunner }, prefix: string, count: number, body: (i: number) => { open: Record<string, unknown>; charge?: Record<string, unknown> }): Promise<void> => {
      for (let start = 0; start < count; start += 50) {
        const changes: Array<{ type: "create"; ref: { kind: string; id: string }; body: Record<string, unknown> }> = [];
        for (let i = start; i < Math.min(start + 50, count); i++) {
          const a = prefix + String(i).padStart(5, "0");
          const b = body(i);
          if (b.charge !== undefined) changes.push({ type: "create", ref: { kind: "stop-charge", id: a }, body: b.charge });
          changes.push({ type: "create", ref: { kind: "stop-charge-open", id: a }, body: b.open });
        }
        await c.runner.command("test.fill", { commandId: cid("fill"), actor: "system" }, async () => ({ payload: { start }, build: async () => ({ ref: changes[0]!.ref, creates: true, changes: changes as never, detail: {} }) }));
      }
    };
    const openCount = async (c: { runner: CommandRunner }): Promise<number> => {
      let total = 0;
      for (let after: string | undefined; ;) {
        const page = await c.runner.list("stop-charge-open", { ...(after === undefined ? {} : { afterId: after }), limit: 100 });
        total += page.length;
        if (page.length < 100) return total;
        after = page[page.length - 1]!.id;
      }
    };
    /** A finished Stop on the scope whose outcome carries the mark: `ended` as this build writes it, or absent as an older build wrote it. */
    const markedStop = async (c: Parameters<Parameters<typeof suite>[1]>[0], scope: { kind: "task" | "agent"; id: string }, ended: boolean): Promise<string> => {
      const x = await c.stops.request(c.owner, { commandId: cid("s"), scope, mode: "stop", reason: "x" });
      await c.stops.advance(c.owner, { intentId: x.intentId });
      await c.edit(x.intentId, (b) => { const { ended: _e, ...rest } = b; const outcome = b["outcome"] as { unresolved: string[] }; return { ...rest, ...(ended ? { ended: true } : {}), phase: "recovery-required", outcome: { ...outcome, state: "recovery-required", unresolved: [MARK] } }; });
      return x.intentId;
    };
    const flags = (v: { unpaid: boolean; markOnly: boolean; markKept: boolean; scanCut: boolean } | undefined) => [v?.unpaid, v?.markOnly, v?.markKept, v?.scanCut];

    suite("one request listed on more paid entries than a sweep reads: the paid ones in the window are taken off so the rest are paid by the next sweep, and the mark is cleared only then (card L02d review 16, 1)", async (c) => {
      c.rt.seenAttempts = [];
      c.rt.terminateCosts = [{ attemptId: "aaa", costMicros: 5, computeMs: 0 }];
      c.rt.failCharges = 1000;
      const r = await c.stops.force(c.owner, { commandId: cid("f"), scope: scopeOf(c.task), reason: "r" });
      c.rt.failCharges = 0;
      assert.equal(await outcomeMarked(c, r.intentId), true);
      // 2100 entries, each with the request's own pending note of 1: one sweep reads "aaa" and the first 1999 of them.
      await fillIndex(c, "e", 2100, (i) => ({ open: { intents: [r.intentId], settled: false }, charge: { costMicros: 0, computeMs: 0, pending: { costMicros: 1, computeMs: 0, commandId: `stopcl-w${i}`, intentId: r.intentId, counted: true } } }));
      const paid = (): number => { let s = 0; for (let i = 0; i < 2100; i++) s += sumOf(c, "e" + String(i).padStart(5, "0")); return s; };
      await c.stops.sweep(c.owner);
      assert.deepEqual([sumOf(c, "aaa"), paid()], [5, 1999]);
      assert.equal(await outcomeMarked(c, r.intentId), true, "the mark stays: 101 entries past the cut still wait");
      assert.equal(await openCount(c), 101, "the paid entries in the window are taken off");
      await c.stops.sweep(c.owner);
      assert.equal(paid(), 2100, "the next sweep pays the rest");
      assert.equal(c.rt.charges.length, 2101, "each charge once");
      assert.equal(await outcomeMarked(c, r.intentId), false);
      assert.equal(await openCount(c), 0);
      assert.deepEqual(flags(await c.stops.cleanupSpend(c.owner, scopeOf(c.task))), [false, false, false, false]);
    });

    suite("a request listed only on an entry more than a page past the cut keeps its mark, and an older record's mark on a cut scan is reported as cut, not kept (card L02d review 16)", async (c) => {
      c.rt.seenAttempts = [];
      const old = await markedStop(c, agentScope(c), false);
      await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: agentScope(c), reason: "again" });
      c.rt.terminateCosts = [{ attemptId: "aaa", costMicros: 5, computeMs: 0 }, { attemptId: "zzz", costMicros: 7, computeMs: 0 }];
      c.rt.failCharges = 1000;
      const r = await c.stops.force(c.owner, { commandId: cid("f"), scope: scopeOf(c.task), reason: "r" });
      c.rt.failCharges = 0;
      // The window holds "aaa" and b00000..b01998; 121 entries and then "zzz" follow, so "zzz" is on the second page past the cut.
      await fillIndex(c, "b", 2120, () => ({ open: { intents: [], settled: true } }));
      assert.deepEqual(flags(await c.stops.cleanupSpend(c.owner, agentScope(c))), [true, false, false, true], "the older record's mark is not called kept: the scan was cut");
      await c.stops.sweep(c.owner);
      assert.deepEqual([sumOf(c, "aaa"), sumOf(c, "zzz")], [5, 0]);
      assert.equal(await outcomeMarked(c, r.intentId), true, "the entry past the cut still waits");
      await c.stops.sweep(c.owner);
      assert.deepEqual([sumOf(c, "aaa"), sumOf(c, "zzz")], [5, 7]);
      assert.equal(await outcomeMarked(c, r.intentId), false);
      assert.equal(await outcomeMarked(c, old), true, "no sweep clears the older record's mark");
      assert.deepEqual(flags(await c.stops.cleanupSpend(c.owner, agentScope(c))), [true, false, true, false]);
    });

    suite("an open index of more than one page is read to its end: by the view (a request's own note on page 2 is its own, a marked request on no entry is mark only) and by the sweep's clear (card L02d review 16)", async (c) => {
      c.rt.seenAttempts = [];
      // Own: its pending note is on an attempt its record does not list, behind 150 other entries.
      c.rt.terminateCosts = [{ attemptId: "zzown", costMicros: 9, computeMs: 0 }];
      c.rt.failCharges = 1000;
      const own = await c.stops.force(c.owner, { commandId: cid("f"), scope: agentScope(c), reason: "own" });
      c.rt.failCharges = 0;
      await c.edit(own.intentId, (b) => ({ ...b, attempts: [] }));
      await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: agentScope(c), reason: "again" });
      c.rt.terminateCosts = undefined;
      const x = await markedStop(c, scopeOf(c.task), true);
      await fillIndex(c, "b", 150, () => ({ open: { intents: [], settled: true } }));
      const vo = (await c.stops.cleanupSpend(c.owner, agentScope(c)))!;
      assert.equal(vo.intentId, own.intentId);
      assert.deepEqual(flags(vo), [true, false, false, false], "its own note is found on page 2: the charge is retried, the scan is not cut");
      assert.deepEqual(flags(await c.stops.cleanupSpend(c.owner, scopeOf(c.task))), [true, true, false, false], "an ended request on no entry: mark only");
      await c.stops.sweep(c.owner);
      assert.equal(await outcomeMarked(c, x), false, "one sweep reads the whole index and clears it");
      assert.equal(sumOf(c, "zzown"), 9);
    });

    suite("an open index of exactly the entries a scan reads is read to its end: the view does not say cut, and the sweep clears a mark (card L02d review 16, 2)", async (c) => {
      c.rt.seenAttempts = [];
      const x = await markedStop(c, scopeOf(c.task), true);
      await fillIndex(c, "b", 2000, () => ({ open: { intents: [], settled: true } }));
      assert.deepEqual(flags(await c.stops.cleanupSpend(c.owner, scopeOf(c.task))), [true, true, false, false]);
      await c.stops.sweep(c.owner);
      assert.equal(await outcomeMarked(c, x), false);
      assert.deepEqual(flags(await c.stops.cleanupSpend(c.owner, scopeOf(c.task))), [false, false, false, false]);
    });

    suite("an open index of the entries a scan reads and ONE more: the scan is cut, and the sweep keeps the mark of a request only that entry lists until it is paid (card L02d review 16, 3)", async (c) => {
      c.rt.seenAttempts = [];
      const x = await markedStop(c, scopeOf(c.task), true);
      await fillIndex(c, "b", 2000, () => ({ open: { intents: [], settled: true } }));
      // The 2001st entry lists the request and has a pending note whose charge fails.
      await fillIndex(c, "z", 1, () => ({ open: { intents: [x], settled: false }, charge: { costMicros: 0, computeMs: 0, pending: { costMicros: 5, computeMs: 0, commandId: "stopcl-one-more", intentId: x, counted: true } } }));
      c.rt.failCharges = 1000;
      assert.deepEqual(flags(await c.stops.cleanupSpend(c.owner, scopeOf(c.task))), [true, false, false, true], "one entry follows the full pages: the scan is cut");
      await c.stops.sweep(c.owner);
      assert.equal(sumOf(c, "z00000"), 0);
      assert.equal(await outcomeMarked(c, x), true, "the entry past the cut still lists it unpaid");
      c.rt.failCharges = 0;
      await c.stops.sweep(c.owner);
      assert.equal(sumOf(c, "z00000"), 5, "a later sweep pays it");
      assert.equal(await outcomeMarked(c, x), false);
    });

    suite("2000 settled entries that list nothing but an unfinished request are taken off the index by one sweep, so a later unpaid charge behind them is paid and not starved (card L02e)", async (c) => {
      c.rt.seenAttempts = [];
      // A Stop that blocks on an uncooperative process and reports no cleanup cost: it stays unfinished and leaves no entry of its own.
      c.rt.items = [{ kind: "process", ref: "pid-7", state: "uncooperative" }];
      c.rt.cleanups = [{ remaining: [{ kind: "process", ref: "pid-7", state: "uncooperative" }] }];
      const blocked = await c.stops.request(c.owner, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "will not settle" });
      assert.equal((await c.stops.advance(c.owner, { intentId: blocked.intentId })).phase, "blocked");
      // 2000 entries whose charge is made and whose wanted figure is nothing, each listing only that unfinished request, sorting before every other attempt: one sweep reads exactly these.
      await fillIndex(c, "b", 2000, () => ({ open: { intents: [blocked.intentId], settled: false }, charge: { costMicros: 5, computeMs: 0 } }));
      assert.equal(await openCount(c), 2000);
      // A later Stop of the agent, whose ending's charge fails once, leaves its note on an attempt that sorts after them all.
      c.rt.items = [];
      c.rt.cleanups = [{ remaining: [] }];
      c.rt.terminateCosts = [{ attemptId: "zzlate", costMicros: 30, computeMs: 0 }];
      c.rt.failCharges = 1;
      const later = await c.stops.request(c.owner, { commandId: cid("s"), scope: agentScope(c), mode: "stop", reason: "later" });
      await c.stops.advance(c.owner, { intentId: later.intentId });
      assert.equal(await outcomeMarked(c, later.intentId), true, "its charge is still to be made");
      c.rt.failCharges = 0;
      await c.stops.sweep(c.owner);
      assert.equal(await openCount(c), 1, "an entry with nothing left to pay is not kept by a request that has not finished: the window is cleared");
      assert.equal(((await c.runner.get("stop-intent", blocked.intentId))!.body as { phase: string }).phase, "blocked", "the unfinished request is left as it was, blocked");
      await c.stops.sweep(c.owner);
      assert.equal(sumOf(c, "zzlate"), 30, "so the next sweep reaches the charge that was past the cut");
      assert.equal(await outcomeMarked(c, later.intentId), false, "and clears its mark");
      assert.equal(await openCount(c), 0);
    });

    suite("a scope that cannot be stopped yet is refused before anything is paused or recorded", async (c) => {
      c.rt.unsupportedWith = "stopping a whole team is not supported yet";
      await refuses("unavailable", () => c.stops.request(c.mgr, { commandId: cid("s"), scope: scopeOf(c.task), mode: "stop", reason: "r" }));
      await refuses("unavailable", () => c.stops.force(c.mgr, { commandId: cid("f"), scope: scopeOf(c.task), reason: "r" }));
      assert.notEqual((await c.pauses.gate(c.owner, scopeOf(c.task)))?.intent, "pause", "not paused");
      assert.equal(c.rt.count("terminate-force"), 0);
    });
  }

  for (const backend of backendsNamed(backendName)) {
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
}
