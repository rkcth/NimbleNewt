import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AgentService } from "../agents/index.js";
import { AssignmentService } from "../domain/assignments.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { GrantService, PrincipalService, type Grant, type Principal } from "../security/index.js";
import { HandoffService, PauseService, StopService, type HandoffSources, type InventoryItem, type StopPorts } from "./index.js";

after(stopServer);

let now = Date.parse("2026-10-28T10:00:00.000Z");
const options = { clock: () => new Date(now).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); return true; });
};

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
  throwOnCheckpoint = false;
  /** Runs inside cleanup, so a test can make something else happen while preparation is in progress. */
  duringCleanup: (() => Promise<void>) | undefined;
  async release(): Promise<void> { this.calls.push("release"); }
  async inventory(): Promise<InventoryItem[]> { this.calls.push("inventory"); return this.items; }
  async cleanup(_s: unknown, o: { backup: boolean }) { this.calls.push("cleanup"); const hook = this.duringCleanup; this.duringCleanup = undefined; if (hook !== undefined) await hook(); this.backups.push(o.backup); return this.cleanups.length > 1 ? this.cleanups.shift()! : this.cleanups[0]!; }
  async checkpoint() { this.calls.push("checkpoint"); if (this.throwOnCheckpoint) throw new Error("no runtime to checkpoint"); return { checkpointId: "cp-1", durable: this.checkpointDurable, artifactsDurable: this.artifactsDurable }; }
  async terminate(_s: unknown, o: { force: boolean }) { this.calls.push(o.force ? "terminate-force" : "terminate"); if (this.crashOnTerminate) await new Promise(() => undefined); if (this.throwOnTerminate) throw new Error("cannot reach the host"); return { ended: this.ended, unresolved: this.unresolved }; }
  count(call: string): number { return this.calls.filter((c) => c === call).length; }
}


/** What the package sources answer; each test sets what it needs. */
class Sources implements HandoffSources {
  sections: Record<string, string> = { brief: "Ship the importer.", acceptanceCriteria: "All fixtures import.", unfinishedWork: "The CSV path.", nextAction: "Run the fixtures.", risks: "Fixtures are small." };
  ineligibleWith: string | undefined;
  async collect() { return { sections: this.sections }; }
  async ineligible() { return this.ineligibleWith; }
}

for (const backend of backends) {
  interface Ctx {
    owner: Principal; mgr: Principal; ann: Principal; task: string; a: { kind: string; id: string }; b: { kind: string; id: string }; rt: Runtime; src: Sources; stops: StopService; pauses: PauseService;
    handoffs: HandoffService; assignments: AssignmentService; failTransfer: { times: number }; reopen(asker?: (id: string) => Promise<Principal | undefined>, given?: { handoffId: string; taskId: string; reason: string }[]): HandoffService;
  }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
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
        const a = { kind: "agent", id: (await agents.create(owner, { commandId: cid("ag"), friendlyName: "A" })).id };
        const b = { kind: "agent", id: (await agents.create(owner, { commandId: cid("ag"), friendlyName: "B" })).id };
        const real = AssignmentService.withEpoch(world.storage, epoch, projects, options);
        const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "one" })).id;
        await projects.transitionTask({ commandId: cid("r"), actor: owner.id, taskId: task, expectedRevision: 1, to: "ready" });
        await real.assignTask({ commandId: cid("as"), actor: owner.id, taskId: task, owner: a });
        const mgr = await plain("mgr", [{ action: "assignment.manage", project }, { action: "assignment.read", project }]);
        const ann = await plain("ann", [{ action: "attempt.work", project }]);
        const rt = new Runtime(); const src = new Sources();
        const failTransfer = { times: 0 };
        // The transfer can be made to fail once or more before it reaches the store, as a crash before it would.
        const assignments = { getAssignment: (t: string) => real.getAssignment(t), transferTask: async (cmd: Parameters<AssignmentService["transferTask"]>[0]) => { if (failTransfer.times > 0) { failTransfer.times--; throw new Error("process died before the transfer"); } return real.transferTask(cmd); } } as unknown as AssignmentService;
        const mk = (asker?: (id: string) => Promise<Principal | undefined>, given?: { handoffId: string; taskId: string; reason: string }[]): HandoffService => {
          const pauses = PauseService.withEpoch(world.storage, epoch, {}, options);
          const stops = StopService.withEpoch(world.storage, epoch, pauses, rt, options);
          return HandoffService.withEpoch(world.storage, epoch, { pauses, stops, assignments, sources: src, ...(asker === undefined ? {} : { asker }), ...(given === undefined ? {} : { onReturnGivenUp: async (_by: Principal, e: { handoffId: string; taskId: string; reason: string }) => { given.push(e); } }) }, options);
        };
        const pauses = PauseService.withEpoch(world.storage, epoch, {}, options);
        const stops = StopService.withEpoch(world.storage, epoch, pauses, rt, options);
        await body({ owner, mgr, ann, task, a, b, rt, src, stops, pauses, handoffs: mk(), assignments: real, failTransfer, reopen: mk });
      } finally { await world.close(); }
    });
  const scopeOf = (task: string) => ({ kind: "task", id: task }) as const;
  const paused = async (c: Ctx) => (await c.pauses.gate(c.owner, scopeOf(c.task)))?.intent === "pause";
  const ownerOf = async (c: Ctx) => { const x = await c.assignments.getAssignment(c.task); return `${x?.owner?.id}@${x?.generation}`; };

  suite("a prepared hand-off suspends, collects the package, moves the task in one step and lets the new owner run", async (c) => {
    const started = await c.handoffs.prepare(c.mgr, { commandId: cid("h"), taskId: c.task, to: c.b, reason: "A is going on leave" });
    assert.equal(started.phase, "ready");
    assert.deepEqual(started.package?.missing, []);
    assert.equal(await paused(c), true, "held until the new owner has it");
    assert.equal(c.rt.count("checkpoint"), 1);
    assert.equal(await ownerOf(c), `${c.a.id}@1`, "nothing moves before the caller completes it");
    const done = await c.handoffs.complete(c.mgr, { commandId: cid("c"), handoffId: started.id });
    assert.equal(done.phase, "transferred");
    assert.equal(await ownerOf(c), `${c.b.id}@2`);
    assert.equal(await paused(c), false, "the hold the hand-off added is lifted");
    assert.ok(done.package?.sections["brief"]);
    // A second hand-off may start once the first ended.
    const back = await c.handoffs.prepare(c.mgr, { commandId: cid("h"), taskId: c.task, to: c.a, reason: "back again" });
    assert.equal(back.phase, "ready");
  });

  suite("a hand-off carried on after a restart is dropped when its asker no longer holds the right, and finished when it still does (owner decision 2026-10-29)", async (c) => {
    const h = await c.handoffs.prepare(c.mgr, { commandId: cid("h"), taskId: c.task, to: c.b, reason: "move it" });
    c.failTransfer.times = 1;
    await assert.rejects(c.handoffs.complete(c.mgr, { commandId: cid("c"), handoffId: h.id }), /process died/);
    // The asker is gone: the sweep does not finish the hand-off, says why, and the task stays with its owner.
    const gone = await c.reopen(async () => undefined).sweep(c.owner);
    assert.deepEqual(gone, { advanced: [], failed: [h.id] });
    const failed = await c.handoffs.get(c.owner, h.id);
    assert.equal(failed?.phase, "failed");
    assert.match(failed?.failure ?? "", /no longer holds the right/);
    assert.equal(await ownerOf(c), `${c.a.id}@1`);
    // An asker who still holds the right: the hand-off is finished after the restart.
    const h2 = await c.handoffs.prepare(c.mgr, { commandId: cid("h"), taskId: c.task, to: c.b, reason: "again" });
    c.failTransfer.times = 1;
    await assert.rejects(c.handoffs.complete(c.mgr, { commandId: cid("c"), handoffId: h2.id }), /process died/);
    const kept = await c.reopen(async (id) => (id === c.mgr.id ? c.mgr : undefined)).sweep(c.owner);
    assert.deepEqual(kept.advanced, [h2.id]);
    assert.equal(await ownerOf(c), `${c.b.id}@2`);
  });

  suite("a temporary reassignment goes back when its time is up, for the one who asked, only while they still hold the right and the task is still with the temporary owner (card L03e)", async (c) => {
    const hour = 3_600_000;
    await refuses("invalid_command", () => c.handoffs.prepare(c.mgr, { commandId: cid("h"), taskId: c.task, to: c.b, reason: "cover", returnAt: new Date(now - hour).toISOString() }));
    await refuses("invalid_command", () => c.handoffs.prepare(c.mgr, { commandId: cid("h"), taskId: c.task, to: c.b, reason: "cover", returnAt: new Date(now + 31 * 24 * hour).toISOString() }));
    await refuses("invalid_command", () => c.handoffs.prepare(c.mgr, { commandId: cid("h"), taskId: c.task, to: c.b, reason: "cover", returnAt: "soon" }));
    const asker = async (id: string) => (id === c.mgr.id ? c.mgr : undefined);
    const given: { handoffId: string; taskId: string; reason: string }[] = [];
    const sweeper = c.reopen(asker, given);
    const h = await c.handoffs.prepare(c.mgr, { commandId: cid("h"), taskId: c.task, to: c.b, reason: "cover for two hours", returnAt: new Date(now + 2 * hour).toISOString() });
    await c.handoffs.complete(c.mgr, { commandId: cid("c"), handoffId: h.id });
    assert.equal(await ownerOf(c), `${c.b.id}@2`);
    // Not yet: nothing is done.
    assert.deepEqual(await sweeper.sweep(c.owner), { advanced: [], failed: [] });
    assert.equal(await ownerOf(c), `${c.b.id}@2`);
    // Time is up: the hand-off back is made, then completed on the next pass, and the task is with its first owner again.
    now += 3 * hour;
    const first = await sweeper.sweep(c.owner);
    assert.ok(first.advanced.includes(h.id) && first.failed.length === 0, JSON.stringify(first));
    const marked = (await c.handoffs.get(c.owner, h.id))!;
    assert.ok(marked.returned?.handoffId !== undefined && marked.returned.skipped === undefined);
    await sweeper.sweep(c.owner);
    assert.equal(await ownerOf(c), `${c.a.id}@3`);
    const back = (await c.handoffs.get(c.owner, marked.returned!.handoffId!))!;
    assert.deepEqual([back.phase, back.autoComplete, back.requestedBy], ["transferred", true, c.mgr.id]);
    assert.deepEqual(await sweeper.sweep(c.owner), { advanced: [], failed: [] }, "nothing is returned twice");
    // The asker no longer holds the right: the task stays with the temporary owner and says why.
    const h2 = await c.handoffs.prepare(c.mgr, { commandId: cid("h"), taskId: c.task, to: c.b, reason: "cover again", returnAt: new Date(now + hour).toISOString() });
    await c.handoffs.complete(c.mgr, { commandId: cid("c"), handoffId: h2.id });
    now += 2 * hour;
    await c.reopen(async () => undefined, given).sweep(c.owner);
    const gone = (await c.handoffs.get(c.owner, h2.id))!;
    assert.match(gone.returned?.skipped ?? "", /gone or no longer active/);
    assert.equal(await ownerOf(c), `${c.b.id}@4`);
    assert.equal(given.length, 1);
    assert.equal(given[0]!.handoffId, h2.id);
    // The task was moved on by someone else meanwhile: there is nothing to return.
    await c.assignments.transferTask({ commandId: cid("tt"), actor: c.owner.id, taskId: c.task, expectedRevision: (await c.assignments.getAssignment(c.task))!.revision, to: c.a, reason: "moved by hand" });
    const h3 = await c.handoffs.prepare(c.mgr, { commandId: cid("h"), taskId: c.task, to: c.b, reason: "cover a third time", returnAt: new Date(now + hour).toISOString() });
    await c.handoffs.complete(c.mgr, { commandId: cid("c"), handoffId: h3.id });
    await c.assignments.transferTask({ commandId: cid("tt"), actor: c.owner.id, taskId: c.task, expectedRevision: (await c.assignments.getAssignment(c.task))!.revision, to: c.a, reason: "moved by hand" });
    now += 2 * hour;
    await sweeper.sweep(c.owner);
    assert.match((await c.handoffs.get(c.owner, h3.id))!.returned?.skipped ?? "", /no longer with the temporary owner/);
  });

  suite("the package holds only the named sections, without credentials; a missing required section is reported and needs the gap accepted", async (c) => {
    c.src.sections = { brief: "Ship it. token sk-live-ABCDEFGHIJKLMNOPQRSTUVWX1234", privateScratch: "my secret plan", acceptanceCriteria: "Fixtures pass.", unfinishedWork: "CSV." };
    const h = await c.handoffs.prepare(c.mgr, { commandId: cid("h"), taskId: c.task, to: c.b, reason: "move it" });
    assert.equal(h.phase, "ready");
    assert.deepEqual(h.package?.missing, ["nextAction"]);
    assert.equal(h.package?.ready, false);
    assert.equal(h.package?.sections["privateScratch"], undefined, "no section outside the list travels");
    assert.doesNotMatch(h.package?.sections["brief"] ?? "", /sk-live/);
    await refuses("invalid_command", () => c.handoffs.complete(c.mgr, { commandId: cid("c"), handoffId: h.id }));
    assert.equal(await ownerOf(c), `${c.a.id}@1`);
    const done = await c.handoffs.complete(c.mgr, { commandId: cid("c"), handoffId: h.id, acceptGaps: true });
    assert.deepEqual([done.phase, done.acceptedGaps?.missing], ["transferred", ["nextAction"]]);
  });

  suite("a crash before the transfer leaves the old owner and a restart finishes it; a crash after leaves the new owner and nothing is done twice", async (c) => {
    const h = await c.handoffs.prepare(c.mgr, { commandId: cid("h"), taskId: c.task, to: c.b, reason: "move it" });
    c.failTransfer.times = 1;
    await assert.rejects(c.handoffs.complete(c.mgr, { commandId: cid("c"), handoffId: h.id }), /process died/);
    assert.equal(await ownerOf(c), `${c.a.id}@1`, "one owner: the old one");
    assert.equal((await c.handoffs.get(c.mgr, h.id))?.phase, "transferring");
    const reopened = c.reopen();
    assert.deepEqual((await reopened.sweep(c.owner)).advanced, [h.id]);
    assert.equal(await ownerOf(c), `${c.b.id}@2`, "one owner: the new one");
    assert.equal((await reopened.get(c.mgr, h.id))?.phase, "transferred");
    // The transfer made, the record not yet updated: a restart sees the new owner and only finishes the record.
    const h2 = await reopened.prepare(c.mgr, { commandId: cid("h"), taskId: c.task, to: c.a, reason: "and back" });
    await c.assignments.transferTask({ commandId: `${h2.id}-transfer`, actor: c.owner.id, taskId: c.task, expectedRevision: (await c.assignments.getAssignment(c.task))!.revision, to: c.a });
    const gen = (await c.assignments.getAssignment(c.task))!.generation;
    await reopened.complete(c.mgr, { commandId: cid("c"), handoffId: h2.id });
    assert.equal((await reopened.get(c.mgr, h2.id))?.phase, "transferred");
    assert.equal((await c.assignments.getAssignment(c.task))!.generation, gen, "not transferred a second time");
  });

  suite("a task whose ownership changed since the hand-off began is not moved; a blocked preparation can be cancelled and the old owner keeps the task", async (c) => {
    const h = await c.handoffs.prepare(c.mgr, { commandId: cid("h"), taskId: c.task, to: c.b, reason: "move it" });
    await c.assignments.transferTask({ commandId: cid("x"), actor: c.owner.id, taskId: c.task, expectedRevision: (await c.assignments.getAssignment(c.task))!.revision, to: c.b });
    await c.assignments.transferTask({ commandId: cid("x"), actor: c.owner.id, taskId: c.task, expectedRevision: (await c.assignments.getAssignment(c.task))!.revision, to: c.a });
    const failed = await c.handoffs.complete(c.mgr, { commandId: cid("c"), handoffId: h.id });
    assert.equal(failed.phase, "failed", "same owner again but a newer generation: not the task that was prepared");
    assert.equal(await ownerOf(c), `${c.a.id}@3`);
    assert.equal(await paused(c), false);
    // Blocked: work will not settle by the deadline.
    c.rt.cleanups = [{ remaining: [{ kind: "job", ref: "j", state: "running" }] }];
    const stuck = await c.handoffs.prepare(c.mgr, { commandId: cid("h"), taskId: c.task, to: c.b, reason: "again", deadlineMs: 1000 });
    assert.equal(stuck.phase, "preparing");
    now += 5000;
    const blocked = await c.handoffs.advance(c.mgr, { handoffId: stuck.id });
    assert.deepEqual([blocked.phase, blocked.blocked?.choices], ["blocked", ["wait", "force-takeover", "cancel"]]);
    assert.equal(await ownerOf(c), `${c.a.id}@3`, "the old owner still owns it");
    const cancelled = await c.handoffs.choose(c.mgr, { commandId: cid("ch"), handoffId: stuck.id, choice: "cancel" });
    assert.equal(cancelled.phase, "cancelled");
    assert.equal(await paused(c), false, "the hold is lifted");
  });

  suite("a takeover force-stops, takes what exists and records the exception; the same takeover sent again answers as recorded", async (c) => {
    c.src.sections = { brief: "Ship it." };
    c.rt.unresolved = ["effect:push-1"];
    const id = cid("tk");
    const t = await c.handoffs.takeover(c.owner, { commandId: id, taskId: c.task, to: c.b, reason: "A is unreachable" });
    assert.equal(t.phase, "transferred");
    assert.equal(t.mode, "forced");
    assert.deepEqual(t.exception?.missingCleanup, ["acceptanceCriteria", "unfinishedWork", "nextAction"]);
    assert.deepEqual(t.exception?.uncertainEffects, ["effect:push-1"]);
    assert.equal(await ownerOf(c), `${c.b.id}@2`);
    assert.equal(c.rt.count("terminate-force"), 1);
    const again = await c.handoffs.takeover(c.owner, { commandId: id, taskId: c.task, to: c.b, reason: "A is unreachable" });
    assert.equal(again.id, t.id);
    assert.equal(c.rt.count("terminate-force"), 1);
  });

  suite("a takeover that replaces a blocked hand-off lets the new owner run, and one that crashes before the stop moves nothing", async (c) => {
    c.rt.cleanups = [{ remaining: [{ kind: "job", ref: "j", state: "running" }] }];
    const stuck = await c.handoffs.prepare(c.mgr, { commandId: cid("h"), taskId: c.task, to: c.b, reason: "again", deadlineMs: 1000 });
    now += 5000;
    assert.equal((await c.handoffs.advance(c.mgr, { handoffId: stuck.id })).phase, "blocked");
    const t = await c.handoffs.choose(c.mgr, { commandId: cid("ch"), handoffId: stuck.id, choice: "force-takeover", reason: "stuck" });
    assert.equal(t.phase, "transferred");
    assert.equal(await paused(c), false, "the hold the replaced hand-off added is lifted");
    // A forced takeover whose stop fails leaves the old owner in place.
    await c.assignments.transferTask({ commandId: cid("x"), actor: c.owner.id, taskId: c.task, expectedRevision: (await c.assignments.getAssignment(c.task))!.revision, to: c.a });
    const gen = await ownerOf(c);
    c.rt.throwOnTerminate = true;
    await assert.rejects(c.handoffs.takeover(c.owner, { commandId: cid("tk"), taskId: c.task, to: c.b, reason: "gone" }));
    assert.equal(await ownerOf(c), gen, "not moved without the stop");
    const pending = (await c.reopen().sweep(c.owner));
    assert.deepEqual(pending.advanced.length + pending.failed.length, 1);
    assert.equal(await ownerOf(c), gen, "a sweep does not move it either while the stop keeps failing");
  });

  suite("refusals: the same owner, an ineligible recipient, a second hand-off at once, and a caller without authority learns nothing", async (c) => {
    await refuses("invalid_command", () => c.handoffs.prepare(c.mgr, { commandId: cid("h"), taskId: c.task, to: c.a, reason: "x" }));
    c.src.ineligibleWith = "B is retired";
    await refuses("invalid_command", () => c.handoffs.prepare(c.mgr, { commandId: cid("h"), taskId: c.task, to: c.b, reason: "x" }));
    c.src.ineligibleWith = undefined;
    const h = await c.handoffs.prepare(c.mgr, { commandId: cid("h"), taskId: c.task, to: c.b, reason: "x" });
    await refuses("invalid_command", () => c.handoffs.prepare(c.mgr, { commandId: cid("h"), taskId: c.task, to: c.b, reason: "y" }));
    await refuses("forbidden", () => c.handoffs.prepare(c.ann, { commandId: cid("h"), taskId: c.task, to: c.b, reason: "z" }));
    await refuses("not_found", () => c.handoffs.advance(c.ann, { handoffId: h.id }));
    assert.equal(await c.handoffs.get(c.ann, h.id), undefined);
    await refuses("forbidden", () => c.handoffs.sweep(c.mgr));
  });

  suite("a manual hold that was there before stays after the hand-off", async (c) => {
    await c.pauses.pause(c.owner, { commandId: cid("p"), scope: scopeOf(c.task), reason: "owner hold" });
    const h = await c.handoffs.prepare(c.mgr, { commandId: cid("h"), taskId: c.task, to: c.b, reason: "x" });
    await c.handoffs.complete(c.mgr, { commandId: cid("c"), handoffId: h.id });
    assert.equal(await paused(c), true, "the owner's hold is never lifted by a hand-off");
    assert.equal(await ownerOf(c), `${c.b.id}@2`);
  });
}
