import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld, workGrants, type DispatchWorld } from "./testing/world.js";
import type { DispatcherDeps } from "./dispatcher.js";

after(stopServer);

// Card L04c: the dispatcher calls the checked resume for an attempt that brings earlier work back, and does not start work whose prerequisite tasks are not complete.
const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

for (const backend of backends) {
  const suite = (name: string, body: (c: DispatchWorld) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const store = await backend.open();
      try { await body(await buildWorld(store.storage)); } finally { await store.close(); }
    });

  suite("work whose prerequisite tasks are not complete waits with the reason recorded, and starts once they are", async (c) => {
    const ann = await c.agent("ann", workGrants(c.project, []));
    const { taskId, attemptId } = await c.task("needs the base", ann);
    let open: readonly string[] = ["tsk-base (in_progress)"];
    const asked: string[] = [];
    const d = c.restart({ prerequisites: async (id) => { asked.push(id); return open; } });
    const first = await d.tick();
    await d.idle();
    assert.deepEqual(first.started, []);
    assert.deepEqual(first.failures, [], "a wait is not a failure");
    assert.equal(first.skipped.length, 1);
    assert.deepEqual([first.skipped[0]!.taskId, first.skipped[0]!.attemptId, first.skipped[0]!.check], [taskId, attemptId, "dependency"]);
    assert.match(first.skipped[0]!.reason, /tsk-base \(in_progress\)/);
    assert.equal(c.worker.starts.length, 0);
    assert.ok(asked.includes(taskId));
    open = [];
    c.worker.script = async () => ({ status: "completed", text: "done" });
    const second = await d.tick();
    await d.idle();
    assert.deepEqual(second.started, [attemptId]);
    assert.equal(c.worker.starts.length, 1);
  });

  suite("an attempt that brings earlier work back is started only after the checked resume is done: blocked waits with the reason, ready is committed, a fresh attempt is not checked", async (c) => {
    const ann = await c.agent("ann", workGrants(c.project, []));
    const { taskId, attemptId } = await c.task("long job", ann);
    const calls: string[] = [];
    let phase: "blocked" | "ready" | "reviewing" = "blocked";
    const resumes: NonNullable<DispatcherDeps["resumes"]> = {
      start: async (_by, command) => { calls.push(`start:${command.taskId}:${command.after}`); return { id: "rck-1", revision: 1, body: undefined, phase, ...(phase === "blocked" ? { blocked: { type: "missing_context", reason: "no continuation" } } : {}) } as never; },
      commit: async (_by, command) => { calls.push(`commit:${command.checkId}`); return { id: "rck-1", phase: "done" } as never; },
      advance: async () => { throw new Error("not used"); },
    };
    // A fresh attempt has nothing to resume: the check is not asked.
    const gate = deferred<void>();
    c.worker.script = async () => { await gate.promise; return { status: "completed", text: "late" }; };
    let d = c.restart({ resumes });
    assert.deepEqual((await d.tick()).started, [attemptId]);
    assert.equal(calls.length, 0, "no resume check for a first start");
    assert.deepEqual(await d.shutdown(), { closed: 1, errors: [] });
    gate.resolve(undefined);
    await d.idle();
    assert.ok((await d.get(c.owner, attemptId!))!.resumeFrom !== undefined);
    // It now resumes: blocked check, so it waits and says why.
    c.worker.script = async () => ({ status: "completed", text: "done" });
    d = c.restart({ resumes });
    const blocked = await d.tick();
    await d.idle();
    assert.deepEqual(blocked.started, []);
    assert.deepEqual(blocked.failures, []);
    assert.deepEqual([blocked.skipped[0]!.taskId, blocked.skipped[0]!.check], [taskId, "resume"]);
    assert.match(blocked.skipped[0]!.reason, /blocked: no continuation/);
    assert.equal(c.worker.starts.length, 1, "only the first start so far");
    // Another phase still open: waits too.
    phase = "reviewing";
    assert.match((await d.tick()).skipped[0]!.reason, /is reviewing/);
    // Ready: the dispatcher commits and the attempt goes on from its checkpoint.
    phase = "ready";
    const go = await d.tick();
    await d.idle();
    assert.deepEqual(go.started, [attemptId]);
    assert.ok(calls.includes("commit:rck-1"));
    assert.ok(calls.some((x) => x.startsWith(`start:${taskId}:`)));
    assert.equal(c.worker.starts.length, 2);
    assert.ok(c.worker.starts[1]!.resumeFrom !== undefined);
  });
}
