import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ResumeCheckService, type ResumePorts } from "../continuation/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld, workGrants, type DispatchWorld } from "./testing/world.js";
import type { DispatcherDeps } from "./dispatcher.js";

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
  dependencies = { check: async () => [{ id: "dep-1", kind: "file" as const, key: "/src/a.ts", status: "changed" as never, detail: "now changed" }] as never };
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
    const d = go();
    for (let n = 0; n < 2; n++) {
      const t = await d.tick();
      assert.deepEqual(t.started, []);
      assert.deepEqual(t.failures, []);
      assert.equal(t.skipped[0]!.check, "resume");
      assert.match(t.skipped[0]!.reason, /ready but holds 1 change\(s\) judged to matter \(file \/src\/a\.ts \(changed\)\)/);
    }
    const held = (await real.forTask(c.dispatcherPrincipal, a.taskId))!;
    assert.equal(held.phase, "ready", "the stored check is exactly as the owner is told: ready and uncommitted");
    assert.deepEqual(f.resumeCalls, []);
    assert.equal(new Set(f.told.map((x) => x.commandId)).size, 1, "one notification identity however many ticks");
    assert.equal(f.told[0]!.level, "needs-you");
    assert.match(f.told[0]!.detail, /1 change\(s\) since it stopped matter to it: file \/src\/a\.ts \(changed\)/);
    // The dispatcher (a service) and the agent cannot get past the hold by committing the check themselves.
    await assert.rejects(real.commit(c.dispatcherPrincipal, { commandId: "bypass", checkId: held.id }), /only the owner commits/);
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
  });

  suite("approving a task with no resume check, or a check that is not ready, is refused with where it stands", async (c, f, real, a) => {
    await assert.rejects(real.approve(c.owner, { commandId: "none", taskId: a.taskId }), /no resume check/);
    const check = await real.start(c.dispatcherPrincipal, { commandId: "k", taskId: a.taskId, model: { provider: "x", id: "y" }, after: "continue" });
    assert.equal(check.phase, "ready");
    await real.cancel(c.dispatcherPrincipal, { checkId: check.id });
    await assert.rejects(real.approve(c.owner, { commandId: "cancelled", taskId: a.taskId }), /is cancelled; only a ready one can be approved/);
    void f;
  });
}
