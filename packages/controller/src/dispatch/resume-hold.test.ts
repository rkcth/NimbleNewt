import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ContinuationService, ResumeCheckService, type ResumePorts } from "../continuation/index.js";
import { DomainError } from "../domain/errors.js";
import { NotificationService } from "../notifications/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld, workGrants, type DispatchWorld } from "./testing/world.js";
import type { DispatcherDeps, RouteResolver } from "./dispatcher.js";

after(stopServer);
const CAPTURE = {
  identity: "conv-1", agent: "agent:ann", boundary: { kind: "turn-complete" as const }, checkpoint: { format: 2, conversationId: 7, at: 41, digest: `v1:sha256:${"a".repeat(64)}`, runtime: { name: "pi-durable", version: "1.3.0" } }, durable: { verified: true },
  continuation: { artifacts: [], decisions: [], pendingEffects: [], budget: { spent: 1, remaining: 9, unit: "k-tokens" }, nextStep: "run the tests" },
  manifest: { summaryLineage: [], sourceRanges: [{ source: "history", from: 1, to: 41 }], compression: { state: "none" as const, compactions: 0 }, branches: [], messageCursor: 41, routingRevision: 1, environmentRevision: 1, adapter: { name: "pi-durable", version: "1.3.0" } },
  nonCheckpointableTools: [], scratchRecords: [], credentialRefs: [],
};

// Card L04c: the resume commit comes last, just before the start; a check that holds changes judged to matter waits for the owner; the commit is recorded once across a crash and a retry.
const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

class Fakes {
  relevant = false;
  failResumeOnce = false;
  /** Whether the fake record asks the check's guard first (the real one writes it with the record). Off: the record is written whatever the attempt's state, so a test sees what the commit alone prevents. */
  guarded = false;
  resumeCalls: string[] = [];
  resumeRecorded = new Set<string>();
  seen = new Map<string, string>();
  told: { commandId: string; detail: string; level?: string }[] = [];
  continuations = {
    latest: async () => ({ id: "cnt-aaaaaaaaaaaaaaaaaaaa" } as never),
    resume: async (_by: unknown, c: { commandId: string }, o?: { guard?: () => Promise<unknown> }) => {
      this.resumeCalls.push(c.commandId);
      if (this.failResumeOnce) { this.failResumeOnce = false; throw new Error("disk hiccup during the resume"); }
      if (this.guarded) await o?.guard?.();
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
    assert.deepEqual((await real.held(c.owner, 10)).items.map((h) => [h.checkId, h.title, h.changes.map((x) => x.key)]), [[check.id, "long job", ["/src/a.ts"]]]);
    assert.deepEqual((await real.held(c.dispatcherPrincipal, 10)).items, []);
    const told = await held();
    assert.equal(told.length, 1, "one notification however many ticks");
    assert.deepEqual([told[0]!.level, told[0]!.ref.id, told[0]!.count], ["needs-you", check.id, 1]);
    assert.ok(!(told[0]!.detail ?? "").includes(a.taskId), "the owner is shown the task's title, not its ID");
    assert.match(told[0]!.detail ?? "", new RegExp(`^"long job" is held before it resumes: 1 change\\(s\\) since it stopped matter to it: file /src/a\\.ts \\(changed\\)\\. Approve to let it go on, or decline to release it\\.$`));
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

  // Card L04c review F1-F3: the decline releases first, then cancels; each crash point and race leaves the attempt unstarted and the answer true.
  const releaseOf = (c: DispatchWorld) => async (by: { id: string }, taskId: string, attemptId: string): Promise<void> => {
    const asg = (await c.assignments.getAssignment(taskId))!;
    if (asg.state === "assigned" && asg.activeAttemptId === attemptId) await c.assignments.releaseTask({ commandId: `rel-${attemptId}`, actor: by.id, taskId, expectedRevision: asg.revision });
  };
  const declining = (c: DispatchWorld, f: Fakes, release: (by: { id: string }, taskId: string, attemptId: string) => Promise<void>, notifications?: NotificationService) => ResumeCheckService.withEpoch(c.storage, c.epoch, {
    continuations: f.continuations as never, dependencies: f.dependencies as never, blockers: f.blockers as never, ports: f.ports, release,
    ...(notifications === undefined ? {} : { settle: async (checkId: string, projectId: string) => { await notifications.settleFromController({ commandId: `s-${checkId}`, kind: "maintenance", ref: { kind: "resume-check", id: checkId }, projectId }); } }),
  }, { clock: c.options.clock! });
  const isCode = (code: string, pattern?: RegExp) => (e: unknown) => e instanceof DomainError && e.code === code && (pattern === undefined || pattern.test(e.message));

  suite("a decline that fails before its release starts nothing, even when a tick then finds nothing that matters; declining again releases the task", async (c, f, real, a, go) => {
    f.relevant = true;
    const d = go();
    await d.tick();
    const check = (await real.forTask(c.dispatcherPrincipal, a.taskId))!;
    let crash = true;
    const svc = declining(c, f, async (by, taskId, attemptId) => { if (crash) { crash = false; throw new Error("controller died in the release"); } await releaseOf(c)(by, taskId, attemptId); });
    await assert.rejects(svc.decline(c.owner, { commandId: "d1", taskId: a.taskId }), /died in the release/);
    assert.equal((await real.get(c.owner, check.id))!.phase, "ready", "nothing was cancelled before the release");
    f.relevant = false;
    for (let i = 0; i < 2; i++) { const t = await d.tick(); await d.idle(); assert.deepEqual(t.started, [], t.skipped.map((s) => s.reason).join("; ")); }
    assert.deepEqual(f.resumeCalls, [], "no resume recorded");
    assert.equal((await real.forTask(c.dispatcherPrincipal, a.taskId))!.id, check.id, "no new check was started");
    const done = await svc.decline(c.owner, { commandId: "d1", taskId: a.taskId });
    assert.deepEqual([done.id, done.phase, done.history.at(-1)!.note], [check.id, "cancelled", "declined by the owner"]);
    assert.equal((await c.assignments.getAssignment(a.taskId))!.state, "released");
  });

  suite("a decline that fails after its release starts nothing; declining again finishes it truthfully, and the same command again answers the same", async (c, f, real, a, go) => {
    f.relevant = true;
    const notifications = NotificationService.withEpoch(c.storage, c.epoch);
    const d = go({ notifications });
    await d.tick();
    const check = (await real.forTask(c.dispatcherPrincipal, a.taskId))!;
    let crash = true;
    const svc = declining(c, f, async (by, taskId, attemptId) => { await releaseOf(c)(by, taskId, attemptId); if (crash) { crash = false; throw new Error("controller died after the release"); } }, notifications);
    await assert.rejects(svc.decline(c.owner, { commandId: "d1", taskId: a.taskId }), /died after the release/);
    assert.equal((await c.assignments.getAssignment(a.taskId))!.state, "released");
    f.relevant = false;
    for (let i = 0; i < 2; i++) { const t = await d.tick(); await d.idle(); assert.deepEqual(t.started, [], t.skipped.map((s) => s.reason).join("; ")); }
    assert.deepEqual(f.resumeCalls, [], "no resume recorded");
    // The dispatcher dropped the ended attempt's check meanwhile; the retried decline still finishes, and says what is true.
    const done = await svc.decline(c.owner, { commandId: "d1", taskId: a.taskId });
    assert.deepEqual([done.id, done.phase], [check.id, "cancelled"]);
    assert.equal((await c.assignments.getAssignment(a.taskId))!.state, "released");
    assert.deepEqual((await notifications.inbox(c.owner)).items.filter((i) => i.ref.kind === "resume-check"), []);
    assert.equal((await svc.decline(c.owner, { commandId: "d1", taskId: a.taskId })).id, check.id, "the same command answers as before");
  });

  for (const when of ["before", "after"] as const) {
    suite(`a tick ${when} the decline's release starts nothing and holds nothing again`, async (c, f, real, a, go) => {
      f.relevant = true;
      const notifications = NotificationService.withEpoch(c.storage, c.epoch);
      const d = go({ notifications });
      await d.tick();
      const check = (await real.forTask(c.dispatcherPrincipal, a.taskId))!;
      const inner: (readonly string[])[] = [];
      const tick = async () => { const t = await d.tick(); await d.idle(); inner.push(t.started); };
      const svc = declining(c, f, async (by, taskId, attemptId) => { f.relevant = false; if (when === "before") await tick(); await releaseOf(c)(by, taskId, attemptId); if (when === "after") await tick(); }, notifications);
      const declined = await svc.decline(c.owner, { commandId: "d1", taskId: a.taskId });
      assert.deepEqual(inner, [[]], "the tick inside the decline started nothing");
      assert.deepEqual([declined.id, declined.phase], [check.id, "cancelled"]);
      assert.equal((await c.assignments.getAssignment(a.taskId))!.state, "released", "the task is released, as the owner is told");
      for (let i = 0; i < 2; i++) { const t = await d.tick(); await d.idle(); assert.deepEqual(t.started, []); }
      assert.deepEqual(f.resumeCalls, [], "no resume recorded");
      assert.equal((await real.forTask(c.dispatcherPrincipal, a.taskId))!.id, check.id, "no new check was started");
      assert.deepEqual((await notifications.inbox(c.owner)).items.filter((i) => i.ref.kind === "resume-check"), []);
    });
  }

  suite("a check the owner declined is never checked again by the dispatcher while its attempt waits", async (c, f, real, a, go) => {
    f.relevant = true;
    const d = go();
    await d.tick();
    const check = (await real.forTask(c.dispatcherPrincipal, a.taskId))!;
    // As an older build left it: cancelled as declined while the attempt is still the active one.
    await real.cancel(c.owner, { checkId: check.id, reason: "declined by the owner" as never });
    f.relevant = false;
    const t = await d.tick();
    await d.idle();
    assert.deepEqual(t.started, []);
    assert.match(t.skipped[0]!.reason, /^the owner declined this resume; the task is being released$/);
    assert.equal((await real.forTask(c.dispatcherPrincipal, a.taskId))!.id, check.id, "no new check was started");
    assert.deepEqual(f.resumeCalls, []);
  });

  suite("a decline after the task was transferred is refused and changes nothing", async (c, f, real, a, go) => {
    f.relevant = true;
    await go().tick();
    const check = (await real.forTask(c.dispatcherPrincipal, a.taskId))!;
    const bob = await c.agent("bob", workGrants(c.project, []));
    const asg = (await c.assignments.getAssignment(a.taskId))!;
    await c.assignments.transferTask({ commandId: "tr", actor: c.owner.id, taskId: a.taskId, expectedRevision: asg.revision, to: { kind: "agent", id: bob.id } });
    const svc = declining(c, f, async () => { throw new Error("must not release"); });
    await assert.rejects(svc.decline(c.owner, { commandId: "d1", taskId: a.taskId }), isCode("invalid_transition", /^not declined: the attempt this resume check was for is no longer the task's active attempt/));
    assert.equal((await real.get(c.owner, check.id))!.phase, "ready", "the check is untouched");
    const now = (await c.assignments.getAssignment(a.taskId))!;
    assert.deepEqual([now.state, now.owner?.id], ["assigned", bob.id], "still bob's");
  });

  suite("a task transferred while the decline releases it is not said to be released, and its check is left held", async (c, f, real, a, go) => {
    f.relevant = true;
    await go().tick();
    const check = (await real.forTask(c.dispatcherPrincipal, a.taskId))!;
    const bob = await c.agent("bob", workGrants(c.project, []));
    // The task moves just before the release looks at it, so the release finds nothing of this attempt to release.
    const svc = declining(c, f, async (by, taskId, attemptId) => {
      const asg = (await c.assignments.getAssignment(taskId))!;
      await c.assignments.transferTask({ commandId: "tr", actor: c.owner.id, taskId, expectedRevision: asg.revision, to: { kind: "agent", id: bob.id } });
      await releaseOf(c)(by, taskId, attemptId);
    });
    await assert.rejects(svc.decline(c.owner, { commandId: "d1", taskId: a.taskId }), isCode("invalid_transition", /^not declined: /));
    assert.equal((await real.get(c.owner, check.id))!.phase, "ready", "not cancelled as declined");
    assert.equal((await c.assignments.getAssignment(a.taskId))!.owner?.id, bob.id);
  });

  suite("a check not tied to an attempt cannot be declined: nothing would be released", async (c, f, real, a) => {
    f.relevant = true;
    const check = await real.start(c.owner, { commandId: "k", taskId: a.taskId, model: { provider: "x", id: "y" }, after: "continue" });
    assert.deepEqual([check.phase, check.attemptId], ["ready", undefined]);
    const svc = declining(c, f, async () => { throw new Error("must not release"); });
    await assert.rejects(svc.decline(c.owner, { commandId: "d1", taskId: a.taskId }), isCode("invalid_command", /not tied to an attempt.*resume\.cancel or release the task/));
    assert.equal((await real.get(c.owner, check.id))!.phase, "ready");
    assert.equal((await c.assignments.getAssignment(a.taskId))!.state, "assigned");
  });

  suite("a held check the owner cancelled cannot be declined, and the task stays assigned", async (c, f, real, a, go) => {
    f.relevant = true;
    await go().tick();
    const check = (await real.forTask(c.dispatcherPrincipal, a.taskId))!;
    await real.cancel(c.owner, { checkId: check.id });
    const svc = declining(c, f, releaseOf(c));
    await assert.rejects(svc.decline(c.owner, { commandId: "d1", taskId: a.taskId }), isCode("invalid_command", /is cancelled; only a resume held/));
    assert.equal((await c.assignments.getAssignment(a.taskId))!.state, "assigned");
  });

  suite("a decline's command ID retried after the task was assigned again answers as before and leaves the newer check alone", async (c, f, real, a, go) => {
    f.relevant = true;
    await go().tick();
    const old = (await real.forTask(c.dispatcherPrincipal, a.taskId))!;
    const svc = declining(c, f, releaseOf(c));
    assert.equal((await svc.decline(c.owner, { commandId: "d1", taskId: a.taskId })).id, old.id);
    const again = (await c.assignments.getAssignment(a.taskId))!;
    await c.assignments.assignTask({ commandId: "as2", actor: c.owner.id, taskId: a.taskId, expectedRevision: again.revision, owner: { kind: "agent", id: "ann" } });
    const now = (await c.assignments.getAssignment(a.taskId))!;
    const next = (await c.assignments.admitAttempt({ commandId: "ad2", actor: "inbox", taskId: a.taskId, expectedRevision: now.revision, generation: now.generation, owner: { kind: "agent", id: "ann" }, harness: "pi" })).id;
    // A new decline of the old check now would release nothing: refused, not answered as released.
    await assert.rejects(svc.decline(c.owner, { commandId: "d2", taskId: a.taskId }), isCode("invalid_transition", /^not declined: the attempt this resume check was for is no longer/));
    assert.equal((await c.assignments.getAssignment(a.taskId))!.activeAttemptId, next);
    const newer = await real.start(c.dispatcherPrincipal, { commandId: "newer", taskId: a.taskId, attemptId: next, model: { provider: "x", id: "y" }, after: "continue" });
    assert.equal(newer.phase, "ready");
    const replay = await svc.decline(c.owner, { commandId: "d1", taskId: a.taskId });
    assert.deepEqual([replay.id, replay.phase], [old.id, "cancelled"], "the retried command answers with the check it declined");
    assert.equal((await real.get(c.owner, newer.id))!.phase, "ready", "the newer check is not declined");
    assert.equal((await c.assignments.getAssignment(a.taskId))!.activeAttemptId, next, "the newer attempt is not released");
  });

  suite("an approval of a check already done closes the notice another approval left open", async (c, f, real, a, go) => {
    f.relevant = true;
    const notifications = NotificationService.withEpoch(c.storage, c.epoch);
    await go({ notifications }).tick();
    const open = async () => (await notifications.inbox(c.owner)).items.filter((i) => i.ref.kind === "resume-check");
    assert.equal((await real.approve(c.owner, { commandId: "ok", taskId: a.taskId })).phase, "done");
    assert.equal((await open()).length, 1, "approved through a service that cannot close the notice");
    assert.equal((await declining(c, f, releaseOf(c), notifications).approve(c.owner, { commandId: "ok2", taskId: a.taskId })).phase, "done");
    assert.deepEqual(await open(), []);
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

  // Card L04c review F1/F2: an approval and a release (the owner's decline, or any other) never both win: no resume is recorded for an attempt that has ended, and the owner is told what happened.
  const ORPHANED_APPROVE = "not approved: the attempt this resume check was for is no longer the task's active attempt (the task was released, transferred or given another attempt), so there is nothing to let go on";
  const until = async (what: () => Promise<boolean>) => { for (let i = 0; i < 500 && !(await what()); i++) await new Promise((r) => setTimeout(r, 2)); assert.ok(await what(), "the awaited state was reached"); };

  suite("a decline whose release lands while an approval looks at the inputs again: the approval is refused, the decline stands, no resume is recorded", async (c, f, real, a, go) => {
    f.relevant = true;
    const d = go();
    await d.tick();
    const check = (await real.forTask(c.dispatcherPrincipal, a.taskId))!;
    const released = deferred<void>(); const approved = deferred<void>();
    const svc = declining(c, f, async (by, taskId, attemptId) => { await releaseOf(c)(by, taskId, attemptId); released.resolve(undefined); await approved.promise; });
    let declining_: Promise<unknown> | undefined;
    // Inside the approval's own look at the inputs (after it saw the attempt active): the decline runs up to and through its release, and finishes only after the approval.
    f.during = async () => { declining_ = svc.decline(c.owner, { commandId: "d1", taskId: a.taskId }); await released.promise; };
    await assert.rejects(svc.approve(c.owner, { commandId: "o1", taskId: a.taskId }), (e: unknown) => e instanceof DomainError && e.code === "invalid_transition" && e.message === ORPHANED_APPROVE);
    approved.resolve(undefined);
    const declined = (await declining_) as Awaited<ReturnType<ResumeCheckService["decline"]>>;
    assert.deepEqual([declined.id, declined.phase, declined.history.at(-1)!.note], [check.id, "cancelled", "declined by the owner"]);
    assert.deepEqual(f.resumeCalls, [], "no resume recorded for the released attempt");
    assert.equal((await c.assignments.getAssignment(a.taskId))!.state, "released");
    for (let i = 0; i < 2; i++) { const t = await d.tick(); await d.idle(); assert.deepEqual(t.started, []); }
    assert.deepEqual(f.resumeCalls, []);
  });

  suite("a decline that completes while an approval looks at the inputs again: the approval says it was declined meanwhile", async (c, f, real, a, go) => {
    f.relevant = true;
    await go().tick();
    const svc = declining(c, f, releaseOf(c));
    f.during = async () => { assert.equal((await svc.decline(c.owner, { commandId: "d1", taskId: a.taskId })).phase, "cancelled"); };
    await assert.rejects(svc.approve(c.owner, { commandId: "o1", taskId: a.taskId }), (e: unknown) => e instanceof DomainError && e.code === "invalid_transition" && e.message === "not approved: the resume was declined meanwhile (the task is released), so nothing is resumed");
    assert.deepEqual(f.resumeCalls, []);
    void real;
  });

  suite("a plain release while an approval looks at the inputs again: the approval is refused and nothing is recorded", async (c, f, real, a, go) => {
    f.relevant = true;
    const d = go();
    await d.tick();
    const check = (await real.forTask(c.dispatcherPrincipal, a.taskId))!;
    f.during = async () => { const asg = (await c.assignments.getAssignment(a.taskId))!; await c.assignments.releaseTask({ commandId: "rel", actor: c.owner.id, taskId: a.taskId, expectedRevision: asg.revision }); };
    await assert.rejects(real.approve(c.owner, { commandId: "o1", taskId: a.taskId }), (e: unknown) => e instanceof DomainError && e.code === "invalid_transition" && e.message === ORPHANED_APPROVE);
    assert.equal((await real.get(c.owner, check.id))!.phase, "ready", "not committed");
    assert.deepEqual(f.resumeCalls, []);
    for (let i = 0; i < 2; i++) { await d.tick(); await d.idle(); }
    assert.equal((await real.get(c.owner, check.id))!.phase, "cancelled");
    assert.deepEqual(f.resumeCalls, []);
  });

  suite("a release while the dispatcher's own commit looks at the inputs again: nothing is committed or recorded and nothing starts", async (c, f, real, a, go) => {
    let busy = true;
    const d = go({ workspaceBusy: async () => busy });
    await d.tick();
    const check = (await real.forTask(c.dispatcherPrincipal, a.taskId))!;
    assert.equal(check.phase, "ready");
    busy = false;
    f.during = async () => { const asg = (await c.assignments.getAssignment(a.taskId))!; await c.assignments.releaseTask({ commandId: "rel", actor: c.owner.id, taskId: a.taskId, expectedRevision: asg.revision }); };
    const t = await d.tick();
    await d.idle();
    assert.deepEqual(t.started, []);
    assert.match(t.skipped[0]!.reason, /could not be committed: not committed: the attempt this resume check was for is no longer the task's active attempt/);
    assert.deepEqual(f.resumeCalls, [], "no resume recorded");
    assert.notEqual((await real.get(c.owner, check.id))!.phase, "done");
  });

  suite("a release landing after the commit but before the resume is recorded: the record's own write refuses it, the check ends cancelled, the approval is refused", async (c, f, real, a, go) => {
    f.relevant = true;
    const continuations = ContinuationService.withEpoch(c.storage, c.epoch, { clock: c.options.clock! });
    await continuations.capture(c.owner, { commandId: "cap", taskId: a.taskId, ...CAPTURE });
    f.continuations.latest = ((by: never, taskId: string) => continuations.latest(by, taskId)) as never;
    const d = go();
    await d.tick();
    const check = (await real.forTask(c.dispatcherPrincipal, a.taskId))!;
    assert.equal(check.phase, "ready");
    // The release lands after the guard read the attempt as active and before the record is written: the write's own check of the attempt refuses it.
    let raced = false;
    f.continuations.resume = (async (by: never, cmd: never, o: { guard: () => Promise<never> }) => continuations.resume(by, cmd, { guard: async () => {
      const g = await o.guard();
      if (!raced) { raced = true; const asg = (await c.assignments.getAssignment(a.taskId))!; await c.assignments.releaseTask({ commandId: "rel", actor: c.owner.id, taskId: a.taskId, expectedRevision: asg.revision }); }
      return g;
    } })) as never;
    await assert.rejects(real.approve(c.owner, { commandId: "o1", taskId: a.taskId }), (e: unknown) => e instanceof DomainError && e.code === "invalid_transition" && e.message === ORPHANED_APPROVE);
    assert.ok(raced);
    assert.deepEqual(await c.storage.listAggregates("continuation-resume", { limit: 10 }), [], "no resume recorded for the released attempt");
    const after = (await real.get(c.owner, check.id))!;
    assert.deepEqual([after.phase, after.history.at(-1)!.note], ["cancelled", "attempt-ended"]);
    for (let i = 0; i < 2; i++) { const t = await d.tick(); await d.idle(); assert.deepEqual(t.started, []); }
    assert.deepEqual(await c.storage.listAggregates("continuation-resume", { limit: 10 }), []);
  });

  suite("an approval committed just before the decline's release cannot record its resume: the decline carries it on and answers cancelled", async (c, f, real, a, go) => {
    f.relevant = true;
    f.guarded = true;
    await go().tick();
    const check = (await real.forTask(c.dispatcherPrincipal, a.taskId))!;
    // The approval commits (the attempt still active) and stops before recording; the decline's release then ends the attempt.
    const hold = deferred<void>();
    const record = f.continuations.resume;
    let first = true;
    f.continuations.resume = (async (...args: Parameters<typeof record>) => { if (first) { first = false; await hold.promise; } return record(...args); }) as never;
    let approving: Promise<unknown> | undefined;
    const svc = declining(c, f, async (by, taskId, attemptId) => {
      approving = svc.approve(c.owner, { commandId: "o1", taskId: a.taskId }).catch((e: unknown) => e);
      await until(async () => (await real.get(c.owner, check.id))!.phase === "executing");
      await releaseOf(c)(by, taskId, attemptId);
    });
    const declined = await svc.decline(c.owner, { commandId: "d1", taskId: a.taskId });
    assert.deepEqual([declined.id, declined.phase], [check.id, "cancelled"], "the decline answers where the check ends, not executing");
    hold.resolve(undefined);
    const approval = await approving;
    assert.ok(approval instanceof DomainError && approval.code === "invalid_transition" && approval.message === ORPHANED_APPROVE, String(approval));
    assert.deepEqual([...f.resumeRecorded], [], "no resume recorded");
    assert.equal((await c.assignments.getAssignment(a.taskId))!.state, "released");
  });

  suite("a decline of a check left committing when its attempt was released (a crash, then a release) ends it cancelled and finishes the decline", async (c, f, real, a, go) => {
    f.relevant = true;
    f.guarded = true;
    await go().tick();
    const check = (await real.forTask(c.dispatcherPrincipal, a.taskId))!;
    f.failResumeOnce = true;
    await assert.rejects(real.approve(c.owner, { commandId: "o1", taskId: a.taskId }), /disk hiccup/);
    assert.equal((await real.get(c.owner, check.id))!.phase, "executing");
    const asg = (await c.assignments.getAssignment(a.taskId))!;
    await c.assignments.releaseTask({ commandId: "rel", actor: c.owner.id, taskId: a.taskId, expectedRevision: asg.revision });
    const declined = await declining(c, f, async () => { throw new Error("must not release"); }).decline(c.owner, { commandId: "d1", taskId: a.taskId });
    assert.deepEqual([declined.id, declined.phase], [check.id, "cancelled"]);
    assert.deepEqual([...f.resumeRecorded], [], "no resume recorded");
  });

  suite("a decline command ID used again for another task is refused as a conflict", async (c, f, real, a, go) => {
    f.relevant = true;
    await go().tick();
    const svc = declining(c, f, releaseOf(c));
    assert.equal((await svc.decline(c.owner, { commandId: "d1", taskId: a.taskId })).phase, "cancelled");
    const other = await c.task("another job", { aid: "ann" });
    await assert.rejects(svc.decline(c.owner, { commandId: "d1", taskId: other.taskId }), isCode("command_conflict", /already used to decline another task's resume/));
    assert.equal((await c.assignments.getAssignment(other.taskId))!.state, "assigned");
    void real;
  });

  suite("a resume not held for the owner whose task was released another way cannot be declined", async (c, f, real, a, go) => {
    await go({ workspaceBusy: async () => true }).tick();
    const check = (await real.forTask(c.dispatcherPrincipal, a.taskId))!;
    assert.deepEqual([check.phase, check.attemptId], ["ready", a.attemptId]);
    const asg = (await c.assignments.getAssignment(a.taskId))!;
    await c.assignments.releaseTask({ commandId: "rel", actor: c.owner.id, taskId: a.taskId, expectedRevision: asg.revision });
    const svc = declining(c, f, async () => { throw new Error("must not release"); });
    await assert.rejects(svc.decline(c.owner, { commandId: "d1", taskId: a.taskId }), isCode("invalid_command", /is ready and holds no change judged to matter/));
    assert.equal((await real.get(c.owner, check.id))!.phase, "ready", "not cancelled as declined");
  });

  suite("a decline cancels a check an approval started over during the release (it is verifying, not ready)", async (c, f, real, a, go) => {
    f.relevant = true;
    await go().tick();
    const check = (await real.forTask(c.dispatcherPrincipal, a.taskId))!;
    const gate = deferred<void>();
    let stall = false;
    const effects = f.ports.uncertainEffects;
    f.ports.uncertainEffects = async (taskId, cont) => { if (stall) { stall = false; await gate.promise; } return effects(taskId, cont); };
    let approving: Promise<unknown> | undefined;
    const svc = declining(c, f, async (by, taskId, attemptId) => {
      // The inputs move and the owner approves: the approval starts the check over and stops while it is verifying again.
      f.detail = "changed again"; stall = true;
      approving = svc.approve(c.owner, { commandId: "o1", taskId: a.taskId }).catch((e: unknown) => e);
      await until(async () => (await real.get(c.owner, check.id))!.phase === "verifying" && !stall);
      await releaseOf(c)(by, taskId, attemptId);
    });
    const declined = await svc.decline(c.owner, { commandId: "d1", taskId: a.taskId });
    assert.deepEqual([declined.phase, declined.history.at(-1)!.note], ["cancelled", "declined by the owner"]);
    gate.resolve(undefined);
    const approval = await approving;
    assert.ok(approval instanceof DomainError && approval.message === "not approved: the resume was declined meanwhile (the task is released), so nothing is resumed", String(approval));
    assert.equal((await real.get(c.owner, check.id))!.phase, "cancelled");
    assert.deepEqual(f.resumeCalls, []);
  });

  suite("a decline after the task was transferred and the new owner released it is refused: the declined attempt was not released", async (c, f, real, a, go) => {
    f.relevant = true;
    await go().tick();
    const check = (await real.forTask(c.dispatcherPrincipal, a.taskId))!;
    const bob = await c.agent("bob", workGrants(c.project, []));
    const asg = (await c.assignments.getAssignment(a.taskId))!;
    await c.assignments.transferTask({ commandId: "tr", actor: c.owner.id, taskId: a.taskId, expectedRevision: asg.revision, to: { kind: "agent", id: bob.aid } });
    const moved = (await c.assignments.getAssignment(a.taskId))!;
    await c.assignments.releaseTask({ commandId: "rel", actor: c.owner.id, taskId: a.taskId, expectedRevision: moved.revision });
    assert.equal((await real.forTask(c.dispatcherPrincipal, a.taskId))!.id, check.id, "the old check is still the task's current one");
    const svc = declining(c, f, async () => { throw new Error("must not release"); });
    await assert.rejects(svc.decline(c.owner, { commandId: "d1", taskId: a.taskId }), isCode("invalid_transition", /^not declined: the attempt this resume check was for is no longer the task's active attempt/));
    assert.equal((await real.get(c.owner, check.id))!.phase, "ready", "not cancelled as declined");
  });
}
