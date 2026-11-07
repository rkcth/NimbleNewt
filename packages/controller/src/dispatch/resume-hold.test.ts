import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ResumeCheckService, type ResumePorts } from "../continuation/index.js";
import { DomainError } from "../domain/errors.js";
import { NotificationService } from "../notifications/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld, workGrants, type DispatchWorld } from "./testing/world.js";
import type { DispatcherDeps, RouteResolver } from "./dispatcher.js";

after(stopServer);

// Card L04c: the resume commit comes last, just before the start; a check that holds changes judged to matter waits for the owner; the commit is recorded once across a crash and a retry.
const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

class Fakes {
  relevant = false;
  failResumeOnce = false;
  resumeCalls: string[] = [];
  resumeRecorded = new Set<string>();
  seen = new Map<string, string>();
  told: { commandId: string; detail: string; level?: string }[] = [];
  continuations = {
    latest: async () => ({ id: "cnt-aaaaaaaaaaaaaaaaaaaa" } as never),
    resume: async (_by: unknown, c: { commandId: string }) => {
      this.resumeCalls.push(c.commandId);
      if (this.failResumeOnce) { this.failResumeOnce = false; throw new Error("disk hiccup during the resume"); }
      this.resumeRecorded.add(c.commandId);
      return { identity: "conv", continuation: { id: "cnt-aaaaaaaaaaaaaaaaaaaa" } as never, modelChanged: false, replayed: false };
    },
  };
  detail = "now changed";
  /** Runs once, inside the next dependency check (to move the inputs while something else is in progress). */
  during: (() => Promise<void>) | undefined;
  dependencies = { check: async () => { const run = this.during; this.during = undefined; await run?.(); return [{ id: "dep-1", kind: "file" as const, key: "/src/a.ts", status: "changed" as never, detail: this.detail }] as never; } };
  blockers = { getBlocker: async (id: string) => ({ id, state: "open" }) as never, openBlocker: async (c: { commandId: string }) => { const id = this.seen.get(c.commandId) ?? `blk-${this.seen.size + 1}`; this.seen.set(c.commandId, id); return { id } as never; } };
  ports: ResumePorts = {
    observe: async () => ({}), missingContext: async () => [], uncertainEffects: async () => [],
    review: async ({ changes }) => Object.fromEntries(changes.map((x) => [x.id, { relevant: this.relevant, rationale: this.relevant ? "the file is the one being edited" : "unrelated to the task" }])),
  };
  notifications = { emitFromController: async (c: { commandId: string; detail: string; level?: string }) => { this.told.push(c); return { itemId: "ntf-1", coalesced: false, immediate: false }; } };
}

for (const backend of backends) {
  const suite = (name: string, body: (c: DispatchWorld, f: Fakes, real: ResumeCheckService, a: { taskId: string; attemptId: string }, go: (extra?: Partial<DispatcherDeps>) => ReturnType<DispatchWorld["restart"]>) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const store = await backend.open();
      try {
        const c = await buildWorld(store.storage);
        const f = new Fakes();
        const real = ResumeCheckService.withEpoch(store.storage, c.epoch, { continuations: f.continuations as never, dependencies: f.dependencies as never, blockers: f.blockers as never, ports: f.ports }, { clock: c.options.clock! });
        const ann = await c.agent("ann", workGrants(c.project, []));
        const { taskId, attemptId } = await c.task("long job", ann);
        const gate = deferred<void>();
        c.worker.script = async () => { await gate.promise; return { status: "completed", text: "late" }; };
        const first = c.restart();
        assert.deepEqual((await first.tick()).started, [attemptId]);
        await first.shutdown();
        gate.resolve(undefined);
        await first.idle();
        assert.ok((await first.get(c.owner, attemptId!))!.resumeFrom !== undefined, "the attempt has a checkpoint to resume from");
        c.worker.script = async () => ({ status: "completed", text: "done" });
        await body(c, f, real, { taskId, attemptId: attemptId! }, (extra = {}) => c.restart({ resumes: real, notifications: f.notifications as never, ...extra }));
      } finally { await store.close(); }
    });

  suite("the resume is committed last: while the attempt waits for the checkout nothing is recorded, and it is recorded once when the attempt starts", async (c, f, real, a, go) => {
    let busy = true;
    const d = go({ workspaceBusy: async () => busy });
    const t1 = await d.tick();
    assert.deepEqual(t1.started, []);
    assert.deepEqual(t1.failures, []);
    const waiting = (await real.forTask(c.dispatcherPrincipal, a.taskId))!;
    assert.equal(waiting.phase, "ready", "checked and ready, but not committed while the attempt still waits");
    assert.deepEqual(f.resumeCalls, [], "no resume is recorded before the start");
    assert.deepEqual((await real.held(c.owner, 10)).items, [], "a ready check with no change judged to matter is not held for the owner: the attempt only waits for its checkout");
    busy = false;
    const t2 = await d.tick();
    await d.idle();
    assert.deepEqual(t2.started, [a.attemptId], t2.skipped.map((s) => s.reason).join("; "));
    assert.equal((await real.get(c.dispatcherPrincipal, waiting.id))!.phase, "done");
    assert.equal(f.resumeRecorded.size, 1, "exactly one resume recorded");
  });

  suite("a commit that fails is a wait that is tried again; the resume is recorded once under one command ID", async (c, f, real, a, go) => {
    f.failResumeOnce = true;
    const d = go();
    const t1 = await d.tick();
    assert.deepEqual(t1.started, []);
    assert.deepEqual(t1.failures, [], "a fault in the commit is a wait, not a failure of the attempt");
    assert.equal(t1.skipped[0]!.check, "resume");
    assert.equal(f.resumeRecorded.size, 0, "nothing was recorded by the failed commit");
    const waiting = (await d.get(c.owner, a.attemptId))!;
    assert.equal(waiting.requestId, undefined, "the place is given back while the attempt waits");
    assert.equal(waiting.reservationId, undefined, "and so is the allowance");
    const t2 = await d.tick();
    await d.idle();
    assert.deepEqual(t2.started, [a.attemptId], t2.skipped.map((s) => s.reason).join("; "));
    assert.equal(f.resumeRecorded.size, 1);
    assert.equal(new Set(f.resumeCalls).size, 1, "both tries used the same command ID");
  });

  suite("a crash after the commit and before the start does not record a second resume", async (c, f, real, a, go) => {
    // The check is committed (as if the controller died right after), then a new controller starts the attempt.
    const warm = go({ workspaceBusy: async () => true });
    await warm.tick();
    const ready = (await real.forTask(c.dispatcherPrincipal, a.taskId))!;
    assert.equal(ready.phase, "ready");
    await real.commit(c.dispatcherPrincipal, { commandId: "crashed-commit", checkId: ready.id });
    assert.equal(f.resumeRecorded.size, 1);
    const d = go();
    const t = await d.tick();
    await d.idle();
    assert.deepEqual(t.started, [a.attemptId], t.skipped.map((s) => s.reason).join("; "));
    assert.equal(f.resumeRecorded.size, 1, "the earlier commit stands; none is added");
  });

  suite("changes judged to matter hold the attempt for the owner: not committed by the dispatcher, the owner told once, started after the owner approves", async (c, f, real, a, go) => {
    f.relevant = true;
    const notifications = NotificationService.withEpoch(c.storage, c.epoch);
    const held = async () => (await notifications.inbox(c.owner)).items.filter((i) => i.ref.kind === "resume-check");
    let d = go({ notifications });
    for (let n = 0; n < 3; n++) {
      // A restarted dispatcher tells the owner no second time either.
      if (n === 2) d = go({ notifications });
      const t = await d.tick();
      assert.deepEqual(t.started, []);
      assert.deepEqual(t.failures, []);
      assert.equal(t.skipped[0]!.check, "resume");
      assert.match(t.skipped[0]!.reason, /ready but holds 1 change\(s\) judged to matter \(file \/src\/a\.ts \(changed\)\); attempt \S+ waits until the owner approves the resume \(resume\.approve\) or declines it, which releases the task \(resume\.decline\)$/);
    }
    const check = (await real.forTask(c.dispatcherPrincipal, a.taskId))!;
    assert.equal(check.phase, "ready", "the stored check is exactly as the owner is told: ready and uncommitted");
    assert.deepEqual(f.resumeCalls, []);
    // The held list is the owner's: the needs-you answer reads it, nobody else does.
    assert.deepEqual((await real.held(c.owner, 10)).items.map((h) => [h.checkId, h.changes.map((x) => x.key)]), [[check.id, ["/src/a.ts"]]]);
    assert.deepEqual((await real.held(c.dispatcherPrincipal, 10)).items, []);
    const told = await held();
    assert.equal(told.length, 1, "one notification however many ticks");
    assert.deepEqual([told[0]!.level, told[0]!.ref.id, told[0]!.count], ["needs-you", check.id, 1]);
    assert.match(told[0]!.detail ?? "", new RegExp(`Task ${a.taskId} is held before it resumes: 1 change\\(s\\) since it stopped matter to it: file /src/a\\.ts \\(changed\\)\\. Approve to let it go on, or decline to release it\\.$`));
    // The dispatcher (a service) and the agent cannot get past the hold by committing the check themselves.
    // Refused before anything is looked at again, even when the inputs moved meanwhile: a refused commit does not start the check over.
    f.detail = "moved meanwhile";
    await assert.rejects(real.commit(c.dispatcherPrincipal, { commandId: "bypass", checkId: check.id }), /only the owner commits/);
    assert.equal((await real.get(c.owner, check.id))!.round, check.round, "the refused commit changed nothing");
    f.detail = "now changed";
    // Only the owner approves; a repeat is safe.
    await assert.rejects(real.approve(c.dispatcherPrincipal, { commandId: "no", taskId: a.taskId }), /only the owner approves/);
    const approved = await real.approve(c.owner, { commandId: "ok", taskId: a.taskId });
    assert.equal(approved.phase, "done");
    assert.equal((await real.approve(c.owner, { commandId: "ok2", taskId: a.taskId })).phase, "done", "approving again answers as it is");
    assert.equal(f.resumeRecorded.size, 1);
    const t = await d.tick();
    await d.idle();
    assert.deepEqual(t.started, [a.attemptId], t.skipped.map((s) => s.reason).join("; "));
    assert.equal(f.resumeRecorded.size, 1, "starting after the approval records no second resume");
    assert.deepEqual(await held(), [], "once approved, the inbox no longer says the task is held");
    assert.deepEqual((await real.held(c.owner, 10)).items, [], "nor does the needs-you list");
  });

  suite("an approval while the inputs move is refused and commits nothing; a crash while recording the approved resume is finished by approving again", async (c, f, real, a, go) => {
    f.relevant = true;
    await go().tick();
    const check = (await real.forTask(c.dispatcherPrincipal, a.taskId))!;
    assert.equal(check.phase, "ready");
    // The file changes again after the owner was told: what the owner approves is not what would run, so nothing is committed and the owner is told so.
    f.detail = "changed again";
    await assert.rejects(real.approve(c.owner, { commandId: "a1", taskId: a.taskId }), (e: unknown) => e instanceof DomainError && e.code === "invalid_transition" && /not approved: .*started over and is ready; 1 change\(s\) judged to matter are held/.test(e.message));
    assert.equal((await real.get(c.owner, check.id))!.phase, "ready");
    assert.deepEqual(f.resumeCalls, [], "nothing was committed");
    // The controller fails while recording the approved resume: the check is left executing; approving again finishes it, once.
    f.failResumeOnce = true;
    await assert.rejects(real.approve(c.owner, { commandId: "a2", taskId: a.taskId }), /disk hiccup/);
    assert.equal((await real.get(c.owner, check.id))!.phase, "executing");
    assert.equal((await real.approve(c.owner, { commandId: "a3", taskId: a.taskId })).phase, "done");
    assert.equal(f.resumeRecorded.size, 1);
    assert.equal(new Set(f.resumeCalls).size, 1, "one command ID for the resume, whoever carries the check on");
  });

  suite("a commit by anyone but the owner is refused when the check was reviewed again while it was being committed", async (c, f, real, a, go) => {
    await go({ workspaceBusy: async () => true }).tick();
    const check = (await real.forTask(c.dispatcherPrincipal, a.taskId))!;
    assert.equal(check.phase, "ready");
    assert.deepEqual(Object.values(check.verdicts).map((v) => v.relevant), [false]);
    // While the dispatcher's commit looks at the inputs, they move, the owner's commit starts the check over and the reviewer now judges the change to matter; then the inputs move back.
    f.during = async () => {
      f.detail = "moved"; f.relevant = true;
      assert.equal((await real.commit(c.owner, { commandId: "o", checkId: check.id })).phase, "ready");
      f.detail = "now changed";
    };
    await assert.rejects(real.commit(c.dispatcherPrincipal, { commandId: "d", checkId: check.id }), (e: unknown) => e instanceof DomainError && (e.code === "invalid_transition" || e.code === "forbidden"));
    const after = (await real.get(c.owner, check.id))!;
    assert.equal(after.phase, "ready", "not committed over a verdict that matters");
    assert.deepEqual(f.resumeCalls, []);
  });

  suite("approving a task with no resume check, or a check that is not ready, is refused with where it stands", async (c, f, real, a) => {
    await assert.rejects(real.approve(c.owner, { commandId: "none", taskId: a.taskId }), /no resume check/);
    const check = await real.start(c.dispatcherPrincipal, { commandId: "k", taskId: a.taskId, model: { provider: "x", id: "y" }, after: "continue" });
    assert.equal(check.phase, "ready");
    await real.cancel(c.dispatcherPrincipal, { checkId: check.id });
    await assert.rejects(real.approve(c.owner, { commandId: "cancelled", taskId: a.taskId }), /is cancelled; only a ready one can be approved/);
    void f;
  });

  suite("the dispatcher's commit that finds the inputs moved does not start the attempt: nothing is recorded and the place and allowance are given back", async (c, f, real, a, go) => {
    let busy = true;
    const d = go({ workspaceBusy: async () => busy });
    await d.tick();
    const check = (await real.forTask(c.dispatcherPrincipal, a.taskId))!;
    assert.equal(check.phase, "ready");
    // The inputs move while the dispatcher's commit looks at them: the check starts over and is reviewed again (still not relevant), so it comes back ready, not done.
    busy = false;
    f.during = async () => { f.detail = "moved during the commit"; };
    const t = await d.tick();
    assert.deepEqual(t.started, [], "not started on a check that was not committed");
    assert.deepEqual(t.failures, []);
    assert.equal(t.skipped[0]!.check, "resume");
    assert.match(t.skipped[0]!.reason, /is ready after the commit/);
    assert.deepEqual(f.resumeCalls, [], "no resume recorded");
    assert.equal((await real.get(c.owner, check.id))!.phase, "ready");
    const waiting = (await d.get(c.owner, a.attemptId))!;
    assert.equal(waiting.requestId, undefined, "the place is given back");
    assert.equal(waiting.reservationId, undefined, "and so is the allowance");
    const t2 = await d.tick();
    await d.idle();
    assert.deepEqual(t2.started, [a.attemptId], t2.skipped.map((x) => x.reason).join("; "));
    assert.equal(f.resumeRecorded.size, 1);
  });

  // Card L04c review F1: a held check whose attempt ends before it starts is not left behind.
  const heldThen = async (c: DispatchWorld, f: Fakes, real: ResumeCheckService, a: { taskId: string; attemptId: string }, go: (extra?: Partial<DispatcherDeps>) => ReturnType<DispatchWorld["restart"]>, end: () => Promise<void>) => {
    f.relevant = true;
    const notifications = NotificationService.withEpoch(c.storage, c.epoch);
    const d = go({ notifications });
    await d.tick();
    const check = (await real.forTask(c.dispatcherPrincipal, a.taskId))!;
    assert.equal(check.phase, "ready");
    assert.equal(check.attemptId, a.attemptId, "the check names the attempt it is for");
    assert.equal((await real.held(c.owner, 10)).items.length, 1);
    await end();
    // Without the dispatcher, the stored check already reads as not held and cannot be approved.
    assert.deepEqual((await real.held(c.owner, 10)).items, [], "the needs-you list no longer says the task is held");
    await assert.rejects(real.approve(c.owner, { commandId: "late", taskId: a.taskId }), (e: unknown) => e instanceof DomainError && e.code === "invalid_transition" && /not approved: the attempt this resume check was for is no longer the task's active attempt/.test(e.message));
    await assert.rejects(real.commit(c.owner, { commandId: "late-commit", checkId: check.id }), (e: unknown) => e instanceof DomainError && e.code === "invalid_transition" && /no longer the task's active attempt/.test(e.message));
    for (let i = 0; i < 2; i++) { await d.tick(); await d.idle(); }
    assert.equal((await real.get(c.owner, check.id))!.phase, "cancelled", "the dispatcher cancelled the ended attempt's check");
    assert.deepEqual((await notifications.inbox(c.owner)).items.filter((i) => i.ref.kind === "resume-check"), [], "the owner's notice is closed");
    assert.deepEqual(f.resumeCalls, [], "no resume was recorded for an attempt that will not run");
    await assert.rejects(real.approve(c.owner, { commandId: "later", taskId: a.taskId }), /is cancelled/);
  };

  suite("a held check is cancelled, its notice closed and its approval refused when the task is released", async (c, f, real, a, go) => {
    await heldThen(c, f, real, a, go, async () => {
      const asg = (await c.assignments.getAssignment(a.taskId))!;
      await c.assignments.releaseTask({ commandId: "rel", actor: c.owner.id, taskId: a.taskId, expectedRevision: asg.revision });
    });
  });

  suite("a held check is cancelled, its notice closed and its approval refused when the task is transferred (a new generation)", async (c, f, real, a, go) => {
    const bob = await c.agent("bob", workGrants(c.project, []));
    await heldThen(c, f, real, a, go, async () => {
      const asg = (await c.assignments.getAssignment(a.taskId))!;
      await c.assignments.transferTask({ commandId: "tr", actor: c.owner.id, taskId: a.taskId, expectedRevision: asg.revision, to: { kind: "agent", id: bob.id } });
    });
  });

  suite("a held check cancelled as stale when the route is chosen again has its notice closed", async (c, f, real, a, go) => {
    f.relevant = true;
    const notifications = NotificationService.withEpoch(c.storage, c.epoch);
    let route = "localp/small";
    const d = go({ notifications, route: (async (cmd) => { const r = await c.deps.route(cmd); return "none" in r ? r : { ...r, route }; }) as RouteResolver });
    await d.tick();
    const first = (await real.forTask(c.dispatcherPrincipal, a.taskId))!;
    assert.equal(first.phase, "ready");
    route = "cloudp/big";
    await d.tick();
    assert.equal((await real.get(c.owner, first.id))!.phase, "cancelled", "the other route's check is stale");
    const open = (await notifications.inbox(c.owner)).items.filter((i) => i.ref.kind === "resume-check");
    assert.ok(!open.some((i) => i.ref.id === first.id), "the stale check's notice is closed");
    const second = (await real.forTask(c.dispatcherPrincipal, a.taskId))!;
    assert.notEqual(second.id, first.id);
    assert.deepEqual(open.map((i) => i.ref.id), [second.id], "only the new route's check is said to be held");
  });

  suite("an attempt that ends leaves the check of the task's newer attempt alone", async (c, f, real, a, go) => {
    f.relevant = true;
    const d = go();
    await d.tick();
    const old = (await real.forTask(c.dispatcherPrincipal, a.taskId))!;
    await real.cancel(c.owner, { checkId: old.id });
    // The task is released and given a new attempt, whose own check is started before the dispatcher sees the old attempt again.
    const asg = (await c.assignments.getAssignment(a.taskId))!;
    await c.assignments.releaseTask({ commandId: "rel", actor: c.owner.id, taskId: a.taskId, expectedRevision: asg.revision });
    const again = (await c.assignments.getAssignment(a.taskId))!;
    await c.assignments.assignTask({ commandId: "as2", actor: c.owner.id, taskId: a.taskId, expectedRevision: again.revision, owner: { kind: "agent", id: "ann" } });
    const now = (await c.assignments.getAssignment(a.taskId))!;
    const next = (await c.assignments.admitAttempt({ commandId: "ad2", actor: "inbox", taskId: a.taskId, expectedRevision: now.revision, generation: now.generation, owner: { kind: "agent", id: "ann" }, harness: "pi" })).id;
    const newer = await real.start(c.dispatcherPrincipal, { commandId: "newer", taskId: a.taskId, attemptId: next, model: { provider: "x", id: "y" }, after: "continue" });
    assert.equal(newer.phase, "ready");
    await d.tick();
    await d.idle();
    assert.equal((await d.get(c.owner, a.attemptId))!.state, "finished", "the old attempt ended");
    assert.equal((await real.get(c.owner, newer.id))!.phase, "ready", "the newer attempt's check is not cancelled by the old attempt's end");
  });

  suite("an approval closes the owner's notice at once, before any tick", async (c, f, real, a, go) => {
    f.relevant = true;
    const notifications = NotificationService.withEpoch(c.storage, c.epoch);
    const open = async () => (await notifications.inbox(c.owner)).items.filter((i) => i.ref.kind === "resume-check");
    await go({ notifications }).tick();
    assert.equal((await open()).length, 1);
    const svc = ResumeCheckService.withEpoch(c.storage, c.epoch, {
      continuations: f.continuations as never, dependencies: f.dependencies as never, blockers: f.blockers as never, ports: f.ports,
      settle: async (checkId, projectId) => { await notifications.settleFromController({ commandId: `s-${checkId}`, kind: "maintenance", ref: { kind: "resume-check", id: checkId }, projectId }); },
    }, { clock: c.options.clock! });
    assert.equal((await svc.approve(c.owner, { commandId: "ok", taskId: a.taskId })).phase, "done");
    assert.deepEqual(await open(), []);
    void real;
  });

  suite("an approved check whose attempt ends before a tick sees it has its notice closed", async (c, f, real, a, go) => {
    f.relevant = true;
    const notifications = NotificationService.withEpoch(c.storage, c.epoch);
    const d = go({ notifications });
    await d.tick();
    const check = (await real.forTask(c.dispatcherPrincipal, a.taskId))!;
    // Approved through a service that cannot close the notice itself.
    assert.equal((await real.approve(c.owner, { commandId: "ok", taskId: a.taskId })).phase, "done");
    assert.equal((await notifications.inbox(c.owner)).items.filter((i) => i.ref.kind === "resume-check").length, 1);
    const asg = (await c.assignments.getAssignment(a.taskId))!;
    await c.assignments.releaseTask({ commandId: "rel", actor: c.owner.id, taskId: a.taskId, expectedRevision: asg.revision });
    await d.tick();
    await d.idle();
    assert.equal((await real.get(c.owner, check.id))!.phase, "done", "an approved check stays done");
    assert.deepEqual((await notifications.inbox(c.owner)).items.filter((i) => i.ref.kind === "resume-check"), []);
  });

  suite("a held check the owner cancels has its notice closed when the dispatcher looks again", async (c, f, real, a, go) => {
    f.relevant = true;
    const notifications = NotificationService.withEpoch(c.storage, c.epoch);
    const d = go({ notifications });
    await d.tick();
    const first = (await real.forTask(c.dispatcherPrincipal, a.taskId))!;
    await real.cancel(c.owner, { checkId: first.id });
    await d.tick();
    const open = (await notifications.inbox(c.owner)).items.filter((i) => i.ref.kind === "resume-check");
    assert.ok(!open.some((i) => i.ref.id === first.id), "the cancelled check's notice is closed");
  });

  suite("the owner declines a held resume: the check is cancelled, the task released, the notice closed, and nothing starts or is held again", async (c, f, real, a, go) => {
    f.relevant = true;
    const notifications = NotificationService.withEpoch(c.storage, c.epoch);
    const d = go({ notifications });
    await d.tick();
    const check = (await real.forTask(c.dispatcherPrincipal, a.taskId))!;
    assert.equal(check.phase, "ready");
    // Without the release wired, a dispatcher's check cannot be declined, and nothing is written.
    await assert.rejects(real.decline(c.owner, { commandId: "no-release", taskId: a.taskId }), (e: unknown) => e instanceof DomainError && e.code === "unavailable");
    assert.equal((await real.get(c.owner, check.id))!.phase, "ready");
    const released: string[] = [];
    const svc = ResumeCheckService.withEpoch(c.storage, c.epoch, {
      continuations: f.continuations as never, dependencies: f.dependencies as never, blockers: f.blockers as never, ports: f.ports,
      release: async (by, taskId, attemptId) => {
        released.push(attemptId);
        const asg = (await c.assignments.getAssignment(taskId))!;
        if (asg.state === "assigned" && asg.activeAttemptId === attemptId) await c.assignments.releaseTask({ commandId: `rel-${attemptId}`, actor: by.id, taskId, expectedRevision: asg.revision });
      },
      settle: async (checkId, projectId) => { await notifications.settleFromController({ commandId: `s-${checkId}`, kind: "maintenance", ref: { kind: "resume-check", id: checkId }, projectId }); },
    }, { clock: c.options.clock! });
    await assert.rejects(svc.decline(c.dispatcherPrincipal, { commandId: "d0", taskId: a.taskId }), /only the owner declines/);
    const declined = await svc.decline(c.owner, { commandId: "d1", taskId: a.taskId });
    assert.equal(declined.phase, "cancelled");
    assert.deepEqual(released, [a.attemptId]);
    assert.equal((await c.assignments.getAssignment(a.taskId))!.state, "released", "the task is released");
    assert.deepEqual((await notifications.inbox(c.owner)).items.filter((i) => i.ref.kind === "resume-check"), [], "the notice is closed at once");
    assert.deepEqual((await svc.held(c.owner, 10)).items, []);
    assert.equal((await svc.decline(c.owner, { commandId: "d2", taskId: a.taskId })).phase, "cancelled", "a repeat answers as it is");
    await assert.rejects(svc.approve(c.owner, { commandId: "after", taskId: a.taskId }), /is cancelled/);
    for (let i = 0; i < 2; i++) { const t = await d.tick(); await d.idle(); assert.deepEqual(t.started, []); }
    assert.equal((await real.forTask(c.dispatcherPrincipal, a.taskId))!.id, check.id, "no new check was started and held again");
    assert.deepEqual((await notifications.inbox(c.owner)).items.filter((i) => i.ref.kind === "resume-check"), []);
    assert.deepEqual(f.resumeCalls, []);
  });

  suite("a resume that is not held for the owner cannot be declined", async (c, f, real, a, go) => {
    await go({ workspaceBusy: async () => true }).tick();
    const check = (await real.forTask(c.dispatcherPrincipal, a.taskId))!;
    assert.equal(check.phase, "ready");
    const svc = ResumeCheckService.withEpoch(c.storage, c.epoch, { continuations: f.continuations as never, dependencies: f.dependencies as never, blockers: f.blockers as never, ports: f.ports, release: async () => { throw new Error("must not release"); } }, { clock: c.options.clock! });
    await assert.rejects(svc.decline(c.owner, { commandId: "d", taskId: a.taskId }), /is ready and holds no change judged to matter/);
    assert.equal((await real.get(c.owner, check.id))!.phase, "ready");
    assert.equal((await c.assignments.getAssignment(a.taskId))!.state, "assigned");
  });
}
