import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DeskService, HistoryService, RetrievalService } from "../context/index.js";
import { ContextEnforcementService } from "../context/enforcement.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld, workGrants } from "./testing/world.js";

after(stopServer);

// Card C07b: what the dispatcher does with the context budget when an attempt ends. An attempt that failed for want of context is counted, and the second in a row ends in a visible blocker; one that ran
// within budget starts the count again; whatever the way it ended, the controller writes the hand-off if the attempt left none.
for (const backend of backends) {
  test(`${backend.name}: an ended attempt gets a hand-off from the controller; repeated context overflow ends in a visible blocker; a good attempt resets the count`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      const desks = DeskService.withEpoch(w.storage, w.epoch, { clock: w.clock.now });
      const histories = HistoryService.withEpoch(w.storage, w.epoch, { clock: w.clock.now });
      const retrieval = RetrievalService.withEpoch(w.storage, w.epoch, desks, histories, { clock: w.clock.now });
      const context = ContextEnforcementService.withEpoch(w.storage, w.epoch, { blockers: w.blockers, retrieval }, { clock: w.clock.now });
      const errors: unknown[] = [];
      const dispatcher = w.restart({ context }, { onError: (e) => errors.push(e) });
      const ann = await w.agent("ann", workGrants(w.project, []));
      const attempt = async (title: string, result: { status: "completed" | "failed"; error?: string }, taskId?: string): Promise<{ taskId: string; attemptId: string }> => {
        w.worker.script = async () => result;
        let t = taskId;
        let attemptId: string;
        if (t === undefined) { const made = await w.task(title, ann); t = made.taskId; attemptId = made.attemptId!; }
        else {
          const a = (await w.assignments.getAssignment(t))!;
          attemptId = (await w.assignments.admitAttempt({ commandId: `again-${title.replace(/ /g, "-")}-${Math.random().toString(36).slice(2)}`, actor: "inbox", taskId: t, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: "ann" }, harness: "pi" })).id;
        }
        await w.heartbeatHost();
        await dispatcher.tick();
        await dispatcher.idle();
        return { taskId: t, attemptId };
      };
      const overflow = "Context compression timed out after 150000 ms in the beforeCompact hook";
      // 1. A completed attempt with no hand-off of its own: the controller writes one.
      const done = await attempt("Order seeds", { status: "completed" });
      const kept = await context.handoffsOf(w.owner, done.taskId, done.attemptId);
      assert.equal(kept.attempt, undefined);
      assert.match(kept.controller ?? "", /Order seeds/, `errors=${JSON.stringify(errors.map(String))} state=${(await w.assignments.getAttempt(done.attemptId))?.state}`);
      // 2. First overflow: counted, no blocker yet. Second: the visible blocker.
      const first = await attempt("Prune roses", { status: "failed", error: overflow });
      assert.equal(await w.blockers.openFor("context_overflow", { kind: "task", id: first.taskId }), undefined, "one overflow restarts fresh");
      assert.match((await context.handoffsOf(w.owner, first.taskId, first.attemptId)).controller ?? "", /beforeCompact/);
      await attempt("Prune roses", { status: "failed", error: overflow }, first.taskId);
      const blocker = await w.blockers.openFor("context_overflow", { kind: "task", id: first.taskId });
      assert.ok(blocker !== undefined, "the second overflow in a row opens a visible blocker");
      // 3. A failure that is not about context is not counted; a completed attempt resets the count.
      const other = await attempt("Water beds", { status: "failed", error: "the model refused" });
      assert.equal(await w.blockers.openFor("context_overflow", { kind: "task", id: other.taskId }), undefined);
      await attempt("Water beds", { status: "failed", error: overflow }, other.taskId);
      await attempt("Water beds", { status: "completed" }, other.taskId);
      await attempt("Water beds", { status: "failed", error: overflow }, other.taskId);
      assert.equal(await w.blockers.openFor("context_overflow", { kind: "task", id: other.taskId }), undefined, "a good attempt in between started the count again");
      // A reason with a tab, a carriage return and an escape is still counted and still gets its hand-off.
      const messy = await attempt("Mow lawn", { status: "failed", error: "Context window exceeded\r\n\tat \u001b[31mmodel\u001b[0m" });
      assert.match((await context.handoffsOf(w.owner, messy.taskId, messy.attemptId)).controller ?? "", /Context window exceeded/, JSON.stringify([errors.map(String), (await w.assignments.getAttempt(messy.attemptId))?.state, await w.blockers.openFor("dispatch_blocked", { kind: "task", id: messy.taskId })]));
      await attempt("Mow lawn", { status: "failed", error: "Context window exceeded\r\n" }, messy.taskId);
      assert.ok((await w.blockers.openFor("context_overflow", { kind: "task", id: messy.taskId })) !== undefined, "counted despite the control characters");
      assert.deepEqual(errors, [], "no bookkeeping failure was swallowed");
    } finally { await store.close(); }
  });
}
