import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AssignmentService } from "../domain/assignments.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { EffectService, type EffectBridge, type EffectRequest } from "../domain/effects.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Grant, type Principal } from "../security/index.js";
import type { JsonObject } from "../storage/types.js";
import { GenerationRefused, GenerationService, type RefusalReason } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-10-22T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};
const refusedFor = async (reason: RefusalReason, run: () => Promise<unknown>): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof GenerationRefused, String(error)); assert.equal(error.reason, reason, error.message); return true; });
};
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

/** The outside world: every execution, so "never executed" can be counted. */
class Outside {
  executions: string[] = [];
  gate: Promise<void> | undefined;
  entered = deferred<void>();
  bridge(): EffectBridge {
    return {
      idempotent: true,
      execute: async (r: EffectRequest): Promise<JsonObject> => {
        this.executions.push(r.key);
        this.entered.resolve();
        if (this.gate !== undefined) await this.gate;
        return { receipt: `r-${this.executions.length}` };
      },
    };
  }
}

for (const backend of backends) {
  interface Ctx {
    owner: Principal; a: string; task: string; other: string; gen: GenerationService; reopen(hooks?: { afterGuardRead?: () => Promise<void> }): GenerationService; effects: EffectService;
    assignments: AssignmentService; projects: ProjectService; ann: Principal; ben: Principal; mgr: Principal; eve: Principal;
  }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const agent = async (nm: string, grants: Grant[]) => {
          await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants });
          return principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
        };
        const a = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "A" })).id;
        const b = (await projects.createProject({ commandId: cid("pb"), actor: "owner:rob", name: "B" })).id;
        const task = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: a, title: "the task" })).id;
        const other = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: a, title: "another task" })).id;
        const assignments = AssignmentService.withEpoch(world.storage, projects.epoch, projects, options);
        const effects = EffectService.withEpoch(world.storage, projects.epoch, assignments, { holder: "exec-1", ...options });
        const make = (hooks?: { afterGuardRead?: () => Promise<void> }) => GenerationService.withEpoch(world.storage, projects.epoch, { assignments, effects }, { ...options, ...(hooks === undefined ? {} : { testHooks: hooks }) });
        const ann = await agent("ann", [{ action: "attempt.work", project: a }, { action: "effect.perform", project: a }]);
        const ben = await agent("ben", [{ action: "attempt.work", project: a }, { action: "effect.perform", project: a }]);
        const mgr = await agent("mgr", [{ action: "assignment.manage", project: a }, { action: "assignment.read", project: a }, { action: "attempt.work", project: a }]);
        const eve = await agent("eve", [{ action: "attempt.work", project: b }, { action: "assignment.manage", project: b }]);
        await body({ owner, a, task, other, gen: make(), reopen: make, effects, assignments, projects, ann, ben, mgr, eve });
      } finally { await world.close(); }
    });

  const begin = async (gen: GenerationService, p: Principal, taskId: string, contextRevision = 1) => (await gen.begin(p, { commandId: cid("begin"), taskId, contextRevision })).id;
  const text = (gen: GenerationService, p: Principal, runId: string, seq: number, t: string) => gen.record(p, { commandId: cid("txt"), runId, seq, text: t });
  const call = (gen: GenerationService, p: Principal, runId: string, seq: number, id: string, extra: { name?: string; argumentsDelta?: string; done?: boolean }) => gen.record(p, { commandId: cid("call"), runId, seq, toolCall: { id, ...extra } });
  /** A finished generation with one complete tool call. */
  const finishedWithCall = async (gen: GenerationService, p: Principal, taskId: string, contextRevision = 1) => {
    const run = await begin(gen, p, taskId, contextRevision);
    await call(gen, p, run, 1, "c1", { name: "push", argumentsDelta: '{"ref":"main"' });
    await call(gen, p, run, 2, "c1", { argumentsDelta: ',"commit":"abc"}', done: true });
    await gen.complete(p, { commandId: cid("done"), runId: run });
    return run;
  };
  const admit = (gen: GenerationService, p: Principal, runId: string, extra: Record<string, unknown> = {}) => gen.admitEffect(p, { commandId: cid("admit"), runId, toolCallId: "c1", kind: "git-push", target: "repo:main", ...extra });
  const callOf = async (gen: GenerationService, p: Principal, runId: string, id = "c1") => (await gen.view(p, runId))!.run.toolCalls.find((c) => c.id === id)!;

  suite("a generation streams text and tool calls in order and is shown as it is", async ({ gen, ann, task, owner, mgr, ben }) => {
    const run = await begin(gen, ann, task);
    await text(gen, ann, run, 1, "I will push ");
    await text(gen, ann, run, 2, "the branch.");
    await refuses("invalid_command", () => text(gen, ann, run, 4, "gap"), (e) => assert.match(e.message, /next chunk is 3/));
    await call(gen, ann, run, 3, "c1", { name: "push", argumentsDelta: '{"ref":' });
    const mid = (await gen.view(ann, run))!;
    assert.deepEqual([mid.run.state, mid.run.text, mid.run.chunks, mid.run.toolCalls[0]!.state, mid.current], ["streaming", "I will push the branch.", 3, "partial", true]);
    await call(gen, ann, run, 4, "c1", { argumentsDelta: '"main"}', done: true });
    assert.equal((await gen.complete(ann, { commandId: cid("done"), runId: run })).state, "finished");
    const done = (await gen.view(ann, run))!;
    assert.deepEqual([done.run.state, done.run.toolCalls[0]!.state, done.run.toolCalls[0]!.args], ["finished", "complete", '{"ref":"main"}']);
    await refusedFor("stale", () => text(gen, ann, run, 5, "more"));
    // Readers: the streamer, the owner and an assignment reader; others see nothing.
    assert.ok(await gen.view(owner, run));
    assert.ok(await gen.view(mgr, run));
    assert.equal(await gen.view(ben, run), undefined);
    assert.equal((await gen.view(owner, "grun-aaaaaaaaaaaaaaaaaaaa-0000000001")), undefined);
    await refuses("forbidden", () => text(gen, ben, run, 5, "x"));
  });

  suite("partial tool calls never execute: not when the stream ends, not when it is cut, not when the arguments are malformed", async ({ gen, effects, ann, mgr, task, other }) => {
    const outside = new Outside();
    // (a) the stream ends with the arguments unfinished.
    const r1 = await begin(gen, ann, task);
    await call(gen, ann, r1, 1, "c1", { name: "push", argumentsDelta: '{"ref":"ma' });
    await refusedFor("incomplete", () => admit(gen, ann, r1));
    await gen.complete(ann, { commandId: cid("done"), runId: r1 });
    assert.equal((await callOf(gen, ann, r1)).state, "dropped");
    await refusedFor("incomplete", () => admit(gen, ann, r1));
    // (b) cut while the arguments are arriving.
    const r2 = await begin(gen, ann, task);
    await call(gen, ann, r2, 1, "c1", { name: "push", argumentsDelta: '{"ref":"main","commit":' });
    await gen.interrupt(mgr, { commandId: cid("int"), taskId: task, mode: "cancel", reason: "stop" });
    const cut = await callOf(gen, ann, r2);
    assert.deepEqual([cut.state, cut.args], ["dropped", '{"ref":"main","commit":']);
    await gen.release(mgr, { commandId: cid("rel"), taskId: task, reason: "ok" });
    await refusedFor("interrupted", () => admit(gen, ann, r2));
    // (c) a call that says it is done but whose arguments are not a JSON object.
    const r3 = await begin(gen, ann, other);
    await call(gen, ann, r3, 1, "c1", { name: "push", argumentsDelta: '{"ref":', done: true });
    await call(gen, ann, r3, 2, "c2", { name: "push", argumentsDelta: "[1]", done: true });
    await gen.complete(ann, { commandId: cid("done"), runId: r3 });
    assert.deepEqual([(await callOf(gen, ann, r3)).state, (await callOf(gen, ann, r3, "c2")).state], ["dropped", "dropped"]);
    await refusedFor("incomplete", () => admit(gen, ann, r3));
    // Nothing was ever recorded in the ledger or executed.
    assert.equal(outside.executions.length, 0);
    for (const r of [r1, r2, r3]) for (const c of (await gen.view(ann, r))!.run.toolCalls) assert.equal(c.effectId, undefined);
    void effects;
  });

  suite("cancel cuts the generation now and what arrives afterwards is recorded as late and never applied", async ({ gen, ann, mgr, task, owner }) => {
    const run = await begin(gen, ann, task);
    await text(gen, ann, run, 1, "partial answer");
    const cut = await gen.interrupt(mgr, { commandId: cid("int"), taskId: task, mode: "cancel", reason: "owner said stop" });
    assert.deepEqual([cut.cut, cut.runId], [true, run]);
    const v = (await gen.view(ann, run))!;
    assert.deepEqual([v.run.state, v.run.interrupted?.kind, v.run.interrupted?.atChunk, v.current], ["interrupted", "cancelled", 1, false]);
    // Late chunks, a late tool call and a late completion: recorded, not applied.
    const l1 = await text(gen, ann, run, 2, "…and then deploy to production");
    assert.deepEqual([l1.applied, l1.late], [false, true]);
    await call(gen, ann, run, 3, "c1", { name: "deploy", argumentsDelta: '{"to":"prod"}', done: true });
    const c = await gen.complete(ann, { commandId: cid("done"), runId: run });
    assert.deepEqual([c.state, c.late], ["interrupted", true]);
    const after = (await gen.view(owner, run))!.run;
    assert.equal(after.text, "partial answer", "the late text was not applied");
    assert.equal(after.toolCalls.length, 0, "the late tool call was not applied");
    assert.equal(after.chunks, 1);
    assert.deepEqual(after.late.map((l) => [l.kind, l.seq]), [["text", 2], ["tool_call", 3], ["completion", undefined]]);
    assert.equal(after.late[0]!.preview, "…and then deploy to production");
    assert.match(after.late[0]!.digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(after.lateCount, 3);
    await refusedFor("held", () => begin(gen, ann, task));
  });

  suite("a late result is recorded once, however often it is sent, and a late result cannot be mistaken for a current one after a restart", async ({ gen, reopen, ann, mgr, task }) => {
    const run = await begin(gen, ann, task);
    await gen.interrupt(mgr, { commandId: cid("int"), taskId: task, mode: "cancel", reason: "stop" });
    const command = { commandId: cid("late"), runId: run, seq: 1, text: "late words" };
    const first = await gen.record(ann, command);
    const again = await reopen().record(ann, command);
    assert.deepEqual([first.late, first.replayed, again.late, again.applied, again.replayed], [true, false, true, false, true]);
    const v = (await reopen().view(ann, run))!.run;
    assert.deepEqual([v.lateCount, v.text, v.state], [1, "", "interrupted"]);
    await refuses("command_conflict", () => gen.record(ann, { ...command, text: "different" }));
  });

  suite("finish-and-hold lets the response end, then admits nothing from it until it is released and readmitted", async ({ gen, effects, ann, mgr, task }) => {
    const outside = new Outside();
    const run = await begin(gen, ann, task);
    await call(gen, ann, run, 1, "c1", { name: "push", argumentsDelta: '{"ref":"main"}', done: true });
    const held = await gen.interrupt(mgr, { commandId: cid("int"), taskId: task, mode: "finish_and_hold", reason: "pause for review" });
    assert.equal(held.cut, false);
    // The generation keeps streaming and ends normally, into `held`.
    await text(gen, ann, run, 2, "pushing now");
    assert.equal((await gen.complete(ann, { commandId: cid("done"), runId: run })).state, "held");
    const v = (await gen.view(ann, run))!.run;
    assert.deepEqual([v.text, v.toolCalls[0]!.state], ["pushing now", "held"]);
    await refusedFor("held", () => admit(gen, ann, run));
    await refusedFor("held", () => begin(gen, ann, task));
    assert.equal(outside.executions.length, 0);
    // Release; readmission is an explicit admit.
    await gen.release(mgr, { commandId: cid("rel"), taskId: task, reason: "reviewed" });
    assert.equal((await callOf(gen, ann, run)).state, "held", "release does not admit anything by itself");
    const { effectId } = await admit(gen, ann, run);
    assert.equal((await gen.execute(ann, { runId: run, toolCallId: "c1" }, outside.bridge())).status, "confirmed");
    assert.equal(outside.executions.length, 1);
    assert.equal((await effects.get(effectId))!.input["commit"], undefined);
    assert.deepEqual((await effects.get(effectId))!.input, { ref: "main" });
  });

  suite("a pause that lands after the response finished holds its calls too", async ({ gen, ann, mgr, task }) => {
    const run = await finishedWithCall(gen, ann, task);
    assert.equal((await callOf(gen, ann, run)).state, "complete");
    await gen.interrupt(mgr, { commandId: cid("int"), taskId: task, mode: "finish_and_hold", reason: "pause" });
    assert.deepEqual([(await gen.view(ann, run))!.run.state, (await callOf(gen, ann, run)).state], ["held", "held"]);
    // A finish-and-hold may be upgraded to a cancel, but the same mode twice is refused.
    await refuses("invalid_command", () => gen.interrupt(mgr, { commandId: cid("int"), taskId: task, mode: "finish_and_hold", reason: "again" }), (e) => assert.match(e.message, /already held/));
    const upgraded = await gen.interrupt(mgr, { commandId: cid("int"), taskId: task, mode: "cancel", reason: "stop it" });
    assert.equal(upgraded.cut, true);
    assert.equal((await callOf(gen, ann, run)).state, "withdrawn");
    await refuses("invalid_command", () => gen.interrupt(mgr, { commandId: cid("int"), taskId: task, mode: "cancel", reason: "twice" }));
    assert.equal((await gen.gate(mgr, task))!.gate.hold?.mode, "cancel");
  });

  suite("a correction supersedes the running generation: its late result cannot override it", async ({ gen, ann, mgr, task }) => {
    const run = await begin(gen, ann, task);
    await text(gen, ann, run, 1, "old plan: drop the table");
    const fixed = await gen.correct(mgr, { commandId: cid("fix"), taskId: task, expectedContextRevision: 1, reason: "owner: do not drop the table" });
    assert.equal(fixed.contextRevision, 2);
    const old = (await gen.view(ann, run))!;
    assert.deepEqual([old.run.state, old.run.interrupted?.kind, old.current], ["interrupted", "corrected", false]);
    // The old stream's tail and completion arrive late.
    assert.equal((await text(gen, ann, run, 2, " then drop it")).late, true);
    await call(gen, ann, run, 3, "c1", { name: "sql", argumentsDelta: '{"q":"drop"}', done: true });
    assert.equal((await gen.complete(ann, { commandId: cid("done"), runId: run })).late, true);
    assert.deepEqual([(await gen.view(ann, run))!.run.toolCalls.length, (await gen.view(ann, run))!.run.lateCount], [0, 3]);
    await refuses("invalid_command", () => admit(gen, ann, run), (e) => assert.match(e.message, /not a tool call/));
    // The old revision cannot begin a new generation; the new one can, and only it counts.
    await refusedFor("stale", () => begin(gen, ann, task, 1));
    const fresh = await finishedWithCall(gen, ann, task, 2);
    assert.equal((await gen.view(ann, fresh))!.current, true);
    assert.equal((await gen.view(ann, run))!.run.text, "old plan: drop the table");
    // A second correction made against the old revision is refused (it would have been a lost update).
    await refuses("stale_revision", () => gen.correct(mgr, { commandId: cid("fix"), taskId: task, expectedContextRevision: 1, reason: "again" }), (e) => assert.equal(e.currentRevision, 2));
    // A correction also withdraws the finished generation's unadmitted call.
    await gen.correct(mgr, { commandId: cid("fix"), taskId: task, expectedContextRevision: 2, reason: "changed again" });
    assert.equal((await callOf(gen, ann, fresh)).state, "withdrawn");
    await refusedFor("interrupted", () => admit(gen, ann, fresh));
  });

  suite("two corrections of the same revision at once: exactly one applies", async ({ gen, mgr, task }) => {
    for (let i = 0; i < 4; i++) {
      const t = (await gen.gate(mgr, task))?.gate.contextRevision ?? 1;
      const results = await Promise.allSettled([1, 2].map((k) => gen.correct(mgr, { commandId: cid(`fix${k}`), taskId: task, expectedContextRevision: t, reason: `fix ${k}` })));
      assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
      assert.equal((await gen.gate(mgr, task))!.gate.contextRevision, t + 1);
    }
  });

  suite("a new generation supersedes the previous one, whose results then arrive as late", async ({ gen, ann, mgr, task }) => {
    const first = await begin(gen, ann, task);
    await text(gen, ann, first, 1, "first");
    const second = await begin(gen, ann, task);
    assert.notEqual(second, first);
    const v = (await gen.view(ann, first))!;
    assert.deepEqual([v.run.state, v.run.interrupted?.kind, v.current, (await gen.view(ann, second))!.current], ["interrupted", "superseded", false, true]);
    assert.equal((await text(gen, ann, first, 2, "stray")).late, true);
    assert.equal((await text(gen, ann, second, 1, "second")).applied, true);
    assert.equal((await gen.gate(mgr, task))!.gate.current, 2);
  });

  suite("pause blocks effects that have not started, immediately; release lets them run once", async ({ gen, ann, mgr, task }) => {
    const outside = new Outside();
    const run = await finishedWithCall(gen, ann, task);
    const { effectId } = await admit(gen, ann, run);
    await gen.interrupt(mgr, { commandId: cid("int"), taskId: task, mode: "finish_and_hold", reason: "pause" });
    await refusedFor("held", () => gen.execute(ann, { runId: run, toolCallId: "c1" }, outside.bridge()));
    assert.equal(outside.executions.length, 0);
    await gen.release(mgr, { commandId: cid("rel"), taskId: task, reason: "go" });
    assert.equal((await gen.execute(ann, { runId: run, toolCallId: "c1" }, outside.bridge())).status, "confirmed");
    assert.equal((await gen.execute(ann, { runId: run, toolCallId: "c1" }, outside.bridge())).status, "confirmed");
    assert.deepEqual(outside.executions, [effectId], "once");
  });

  suite("a pause that lands between the check and the start of an effect still stops it", async ({ gen: g0, reopen, ann, mgr, task }) => {
    const outside = new Outside();
    const run = await finishedWithCall(g0, ann, task);
    await admit(g0, ann, run);
    let fired = false;
    const gen = reopen({ afterGuardRead: async () => { if (!fired) { fired = true; await g0.interrupt(mgr, { commandId: cid("int"), taskId: task, mode: "finish_and_hold", reason: "pause now" }); } } });
    await refusedFor("held", () => gen.execute(ann, { runId: run, toolCallId: "c1" }, outside.bridge()));
    assert.equal(fired, true);
    assert.equal(outside.executions.length, 0, "the effect never started");
  });

  suite("cancel and correction withdraw admitted effects that have not started: the ledger says failed and nothing runs", async ({ gen, effects, ann, mgr, task }) => {
    const outside = new Outside();
    const r1 = await finishedWithCall(gen, ann, task);
    const e1 = (await admit(gen, ann, r1)).effectId;
    await gen.interrupt(mgr, { commandId: cid("int"), taskId: task, mode: "cancel", reason: "stop" });
    const w = await callOf(gen, ann, r1);
    assert.deepEqual([w.state, w.effect?.status, w.effect?.afterInterruption], ["withdrawn", "failed", true]);
    const ledger = (await effects.get(e1))!;
    assert.deepEqual([ledger.status, ledger.evidence?.["runId"]], ["failed", r1]);
    await gen.release(mgr, { commandId: cid("rel"), taskId: task, reason: "ok" });
    assert.equal((await gen.execute(ann, { runId: r1, toolCallId: "c1" }, outside.bridge())).status, "failed");
    assert.equal(outside.executions.length, 0);
    // Correction does the same.
    const r2 = await finishedWithCall(gen, ann, task);
    const e2 = (await admit(gen, ann, r2)).effectId;
    await gen.correct(mgr, { commandId: cid("fix"), taskId: task, expectedContextRevision: 1, reason: "changed" });
    assert.equal((await effects.get(e2))!.status, "failed");
    assert.equal((await gen.execute(ann, { runId: r2, toolCallId: "c1" }, outside.bridge())).status, "failed");
    assert.equal(outside.executions.length, 0);
  });

  suite("an effect already started is not cut by an interruption: it settles in the ledger and reconciles as late", async ({ gen, effects, ann, mgr, task }) => {
    const outside = new Outside();
    const hold = deferred<void>();
    outside.gate = hold.promise;
    const run = await finishedWithCall(gen, ann, task);
    const { effectId } = await admit(gen, ann, run);
    const running = gen.execute(ann, { runId: run, toolCallId: "c1" }, outside.bridge());
    await outside.entered.promise;
    // The task is cancelled while the target is still working.
    await gen.interrupt(mgr, { commandId: cid("int"), taskId: task, mode: "cancel", reason: "stop" });
    const during = await callOf(gen, ann, run);
    assert.equal(during.state, "admitted", "a started effect is not withdrawn");
    hold.resolve();
    assert.equal((await running).status, "confirmed");
    assert.equal((await effects.get(effectId))!.status, "confirmed");
    // The run's own view learns of it only through reconcile, and says it came after the interruption.
    assert.equal((await callOf(gen, ann, run)).effect, undefined);
    await gen.reconcile(ann, { commandId: cid("rec"), runId: run });
    const after = await callOf(gen, ann, run);
    assert.deepEqual([after.effect?.status, after.effect?.afterInterruption], ["confirmed", true]);
    assert.deepEqual([(await gen.view(ann, run))!.run.state, outside.executions.length], ["interrupted", 1]);
  });

  suite("an unsupported target that was started and then lost is uncertain; reconcile shows it and a person resolves it", async ({ gen, effects, ann, mgr, task }) => {
    const run = await finishedWithCall(gen, ann, task);
    const { effectId } = await admit(gen, ann, run);
    const opaque: EffectBridge = { idempotent: false, execute: async () => { throw new Error("connection lost after sending"); } };
    // The target may have received the request: the effect is uncertain and the call reports it instead of executing again.
    assert.equal((await gen.execute(ann, { runId: run, toolCallId: "c1" }, opaque)).status, "uncertain");
    assert.equal((await effects.get(effectId))!.status, "uncertain");
    await gen.interrupt(mgr, { commandId: cid("int"), taskId: task, mode: "cancel", reason: "stop" });
    await gen.release(mgr, { commandId: cid("rel"), taskId: task, reason: "ok" });
    // Started: the interruption did not withdraw it, and it is never run blindly again.
    await refuses("effect_uncertain", () => gen.execute(ann, { runId: run, toolCallId: "c1" }, opaque));
    await gen.reconcile(ann, { commandId: cid("rec"), runId: run });
    assert.deepEqual([(await callOf(gen, ann, run)).state, (await callOf(gen, ann, run)).effect?.status, (await callOf(gen, ann, run)).effect?.afterInterruption], ["admitted", "uncertain", true]);
    await effects.resolve({ commandId: cid("res"), actor: "owner:rob", effectId, outcome: "failed", evidence: { checked: "target log" } });
    await gen.reconcile(ann, { commandId: cid("rec"), runId: run });
    assert.equal((await callOf(gen, ann, run)).effect?.status, "failed");
  });

  suite("admission racing an interruption orders strictly: an admitted effect is never left startable", async ({ gen, effects, ann, mgr, task, reopen }) => {
    for (let i = 0; i < 6; i++) {
      const outside = new Outside();
      const run = await finishedWithCall(gen, ann, task, (await gen.gate(mgr, task))?.gate.contextRevision ?? 1);
      const racing = reopen();
      const [admitted] = await Promise.allSettled([
        admit(gen, ann, run),
        racing.interrupt(mgr, { commandId: cid("int"), taskId: task, mode: "cancel", reason: "race" }),
      ]);
      const v = (await gen.view(ann, run))!.run;
      assert.equal(v.state, "interrupted");
      if (admitted.status === "fulfilled") {
        assert.equal((await gen.execute(ann, { runId: run, toolCallId: "c1" }, outside.bridge())).status, "failed");
        assert.equal(outside.executions.length, 0);
        // Admitted first: then the cancel withdrew it (or it is simply still not started and held).
        assert.equal((await effects.get(admitted.value.effectId))!.status, "failed");
      } else {
        assert.ok(admitted.reason instanceof GenerationRefused, String(admitted.reason));
        assert.equal(v.toolCalls.some((c) => c.effectId !== undefined), false);
      }
      await gen.release(mgr, { commandId: cid("rel"), taskId: task, reason: "next" });
      assert.equal(outside.executions.length, 0);
    }
  });

  suite("effects are admitted atomically with their checks, once, and only from a finished current generation", async ({ gen, effects, ann, ben, task }) => {
    const run = await begin(gen, ann, task);
    await call(gen, ann, run, 1, "c1", { name: "push", argumentsDelta: '{"ref":"main"}', done: true });
    await refusedFor("streaming", () => admit(gen, ann, run));
    await gen.complete(ann, { commandId: cid("done"), runId: run });
    const command = { commandId: cid("adm"), runId: run, toolCallId: "c1", kind: "git-push", target: "repo:main" };
    const first = await gen.admitEffect(ann, command);
    const again = await gen.admitEffect(ann, command);
    assert.deepEqual([again.effectId, again.replayed], [first.effectId, true]);
    const ledger = (await effects.get(first.effectId))!;
    assert.deepEqual([ledger.status, ledger.kind, ledger.target, ledger.createdBy, ledger.input], ["intended", "git-push", "repo:main", "agent:ann", { ref: "main" }]);
    assert.equal(ledger.key, first.effectId);
    await refusedFor("admitted", () => admit(gen, ann, run));
    await refuses("invalid_command", () => admit(gen, ann, run, { toolCallId: "nope" }));
    await refuses("invalid_command", () => admit(gen, ann, run, { kind: "Bad Kind" }));
    await refuses("forbidden", () => admit(gen, ben, run));
    const fresh = await begin(gen, ann, task);
    void fresh;
    await refusedFor("interrupted", () => admit(gen, ann, run));
    // Restart: the repeated command still names the same effect.
    assert.equal((await gen.admitEffect(ann, command)).effectId, first.effectId);
  });

  suite("a fenced generation loses its effects when the assignment moves on", async ({ gen, effects, assignments, projects, ann, task }) => {
    await projects.transitionTask({ commandId: cid("r"), actor: "owner:rob", taskId: task, expectedRevision: 1, to: "ready" });
    await assignments.assignTask({ commandId: cid("a"), actor: "owner:rob", taskId: task, owner: { kind: "agent", id: "ann" } });
    const att = await assignments.admitAttempt({ commandId: cid("adm"), actor: "owner:rob", taskId: task, expectedRevision: 1, generation: 1, owner: { kind: "agent", id: "ann" } });
    const fence = { generation: 1, attemptId: att.id };
    const run = (await gen.begin(ann, { commandId: cid("begin"), taskId: task, contextRevision: 1, fence })).id;
    await call(gen, ann, run, 1, "c1", { name: "push", argumentsDelta: '{"ref":"main"}', done: true });
    await gen.complete(ann, { commandId: cid("done"), runId: run });
    const { effectId } = await admit(gen, ann, run);
    assert.deepEqual((await effects.get(effectId))!.fence, fence);
    const a = (await assignments.getAssignment(task))!;
    await assignments.transferTask({ commandId: cid("tr"), actor: "owner:rob", taskId: task, expectedRevision: a.revision, to: { kind: "agent", id: "bob" } });
    const outside = new Outside();
    assert.equal((await gen.execute(ann, { runId: run, toolCallId: "c1" }, outside.bridge())).status, "failed", "superseded before it started");
    assert.equal(outside.executions.length, 0);
    // A stale fence cannot begin a generation either.
    await refuses("fenced", () => gen.begin(ann, { commandId: cid("begin"), taskId: task, contextRevision: 1, fence }));
  });

  suite("who may do what: controls need assignment.manage, streaming needs the streamer, outsiders see nothing", async ({ gen, ann, ben, mgr, eve, owner, task }) => {
    const run = await begin(gen, ann, task);
    await refuses("forbidden", () => gen.interrupt(ann, { commandId: cid("int"), taskId: task, mode: "cancel", reason: "x" }));
    await refuses("forbidden", () => gen.interrupt(eve, { commandId: cid("int"), taskId: task, mode: "cancel", reason: "x" }));
    await refuses("forbidden", () => gen.correct(ben, { commandId: cid("fix"), taskId: task, expectedContextRevision: 1, reason: "x" }));
    await refuses("forbidden", () => gen.begin(eve, { commandId: cid("b"), taskId: task, contextRevision: 1 }));
    await refuses("forbidden", () => gen.complete(ben, { commandId: cid("c"), runId: run }));
    await refuses("forbidden", () => gen.release(ann, { commandId: cid("r"), taskId: task, reason: "x" }));
    assert.equal(await gen.view(eve, run), undefined);
    assert.equal(await gen.gate(eve, task), undefined);
    assert.ok(await gen.gate(mgr, task));
    // The owner may do everything; a restricted agent's task-level grant is revoked: no more work.
    const lowered: Principal = { ...ann, grants: ann.grants.filter((g) => g.action !== "attempt.work") };
    await refuses("forbidden", () => text(gen, lowered, run, 1, "x"));
    await gen.interrupt(owner, { commandId: cid("int"), taskId: task, mode: "finish_and_hold", reason: "by the owner" });
    await refuses("invalid_command", () => gen.interrupt(mgr, { commandId: cid("int"), taskId: task, mode: "bogus" as never, reason: "x" }));
    await refuses("invalid_command", () => gen.release(owner, { commandId: cid("r"), taskId: task, reason: "" }));
  });

  suite("inputs are bounded and credential-shaped text is refused; unknown fields are refused", async ({ gen, ann, mgr, task }) => {
    const run = await begin(gen, ann, task);
    await refuses("invalid_command", () => text(gen, ann, run, 1, "x".repeat(9000)));
    await refuses("invalid_command", () => text(gen, ann, run, 1, "the key is sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"));
    await refuses("invalid_command", () => call(gen, ann, run, 1, "c1", { name: "push", argumentsDelta: '{"token":"ghp_abcdefghijklmnopqrstuvwxyz0123456789"}' }));
    await refuses("invalid_command", () => gen.record(ann, { commandId: cid("x"), runId: run, seq: 1 } as never));
    await refuses("invalid_command", () => gen.record(ann, { commandId: cid("x"), runId: run, seq: 1, text: "a", toolCall: { id: "c" } } as never));
    await refuses("invalid_command", () => gen.record(ann, { commandId: cid("x"), runId: run, seq: 1, text: "a", extra: 1 } as never));
    await refuses("invalid_command", () => gen.interrupt(mgr, { commandId: cid("int"), taskId: task, mode: "cancel", reason: "the key is sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }));
    // A call's arguments are bounded in total, and so is the number of calls.
    await call(gen, ann, run, 1, "big", { name: "x", argumentsDelta: "a".repeat(8000) });
    await call(gen, ann, run, 2, "big", { argumentsDelta: "a".repeat(8000) });
    await refuses("invalid_command", () => call(gen, ann, run, 3, "big", { argumentsDelta: "a".repeat(1000) }));
    for (let i = 0; i < 31; i++) await call(gen, ann, run, 3 + i, `k${i}`, { name: "x" });
    await refuses("unavailable", () => call(gen, ann, run, 34, "one-too-many", { name: "x" }));
    // The refused chunks changed nothing.
    assert.equal((await gen.view(ann, run))!.run.chunks, 33);
  });

  suite("everything survives a restart: the hold, the revision, the late list and the admitted effect", async ({ gen, reopen, ann, mgr, task, effects }) => {
    const run = await finishedWithCall(gen, ann, task);
    const { effectId } = await admit(gen, ann, run);
    await gen.interrupt(mgr, { commandId: cid("int"), taskId: task, mode: "finish_and_hold", reason: "pause" });
    const again = reopen();
    assert.equal((await again.gate(mgr, task))!.gate.hold?.mode, "finish_and_hold");
    await refusedFor("held", () => again.begin(ann, { commandId: cid("b"), taskId: task, contextRevision: 1 }));
    await refusedFor("held", () => again.execute(ann, { runId: run, toolCallId: "c1" }, new Outside().bridge()));
    await again.release(mgr, { commandId: cid("rel"), taskId: task, reason: "resume" });
    assert.equal((await again.execute(ann, { runId: run, toolCallId: "c1" }, new Outside().bridge())).status, "confirmed");
    assert.equal((await effects.get(effectId))!.status, "confirmed");
    await again.reconcile(ann, { commandId: cid("rec"), runId: run });
    assert.deepEqual([(await again.view(ann, run))!.run.toolCalls[0]!.effect?.status, (await again.view(ann, run))!.run.toolCalls[0]!.effect?.afterInterruption], ["confirmed", false]);
  });

  suite("controls are idempotent by command ID and a reused ID for another command is refused", async ({ gen, reopen, ann, mgr, task }) => {
    const run = await begin(gen, ann, task);
    const command = { commandId: cid("int"), taskId: task, mode: "cancel" as const, reason: "stop" };
    const first = await gen.interrupt(mgr, command);
    const again = await reopen().interrupt(mgr, command);
    assert.deepEqual([first.replayed, again.replayed, again.cut, again.runId], [false, true, true, run]);
    await refuses("command_conflict", () => gen.interrupt(mgr, { ...command, reason: "other" }));
    const rel = { commandId: cid("rel"), taskId: task, reason: "ok" };
    assert.equal((await gen.release(mgr, rel)).replayed, false);
    assert.equal((await reopen().release(mgr, rel)).replayed, true);
    const b = { commandId: cid("b"), taskId: task, contextRevision: 1 };
    const one = await gen.begin(ann, b);
    assert.deepEqual([(await reopen().begin(ann, b)).id, (await reopen().begin(ann, b)).replayed], [one.id, true]);
    assert.equal(GenerationService.runIdOf(task, one.number), one.id);
  });

  suite("another agent cannot supersede a running generation (and so cannot fail its effects); the owner and assignment.manage can", async ({ gen, effects, ann, ben, mgr, owner, task }) => {
    const run = await finishedWithCall(gen, ann, task);
    const { effectId } = await admit(gen, ann, run);
    await refuses("forbidden", () => gen.begin(ben, { commandId: cid("b"), taskId: task, contextRevision: 1 }));
    assert.deepEqual([(await gen.view(ann, run))!.run.state, (await effects.get(effectId))!.status, (await callOf(gen, ann, run)).state], ["finished", "intended", "admitted"]);
    // The same agent may begin again; a manager may supersede.
    const again = await begin(gen, ann, task);
    assert.equal((await gen.view(ann, run))!.run.state, "interrupted");
    const mine = await begin(gen, ann, task);
    void again;
    const taken = await gen.begin(mgr, { commandId: cid("b"), taskId: task, contextRevision: 1 });
    assert.equal((await gen.view(mgr, mine))!.run.interrupted?.kind, "superseded");
    const o = await gen.begin(owner, { commandId: cid("b"), taskId: task, contextRevision: 1 });
    assert.equal(o.number, taken.number + 1);
  });

  suite("a wrong expected revision in a correction is refused at once, not retried", async ({ gen, mgr, task }) => {
    await refuses("stale_revision", () => gen.correct(mgr, { commandId: cid("fix"), taskId: task, expectedContextRevision: 5, reason: "x" }), (e) => assert.equal(e.currentRevision, 1));
  });

  suite("guardFor: wiring it into EffectService.run blocks an effect of a held task, and an effect already started is still recovered", async ({ gen, effects, mgr, ann, task }) => {
    const outside = new Outside();
    const intent = async () => (await effects.intend({ commandId: cid("ef"), actor: "owner:rob", kind: "git-push", target: "repo:main", input: { ref: "main" }, taskId: task })).id;
    const e1 = await intent();
    assert.equal((await effects.run(e1, outside.bridge(), { beforeStart: gen.guardFor(task) })).status, "confirmed", "no hold: runs");
    const e2 = await intent();
    await gen.interrupt(mgr, { commandId: cid("int"), taskId: task, mode: "finish_and_hold", reason: "pause" });
    await refusedFor("held", () => effects.run(e2, outside.bridge(), { beforeStart: gen.guardFor(task) }));
    assert.equal(outside.executions.length, 1);
    await gen.release(mgr, { commandId: cid("rel"), taskId: task, reason: "go" });
    assert.equal((await effects.run(e2, outside.bridge(), { beforeStart: gen.guardFor(task) })).status, "confirmed");
    // Started with an unanswered request (idempotent target unreachable), then the task is held: recovery still proceeds.
    const e3 = await intent();
    const flaky: EffectBridge = { idempotent: true, execute: async () => { throw new Error("unreachable"); } };
    assert.equal((await effects.run(e3, flaky, { beforeStart: gen.guardFor(task) })).status, "pending");
    await gen.interrupt(mgr, { commandId: cid("int"), taskId: task, mode: "cancel", reason: "stop" });
    const before = outside.executions.length;
    assert.equal((await effects.run(e3, outside.bridge(), { beforeStart: gen.guardFor(task) })).status, "confirmed");
    assert.equal(outside.executions.length, before + 1);
    void ann;
  });
}
