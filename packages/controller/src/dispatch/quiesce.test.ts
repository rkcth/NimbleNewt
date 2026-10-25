import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { LocalWorker, type BoundCall } from "./local-worker.js";
import { TERMINAL, operationKind, type ToolOperationBody } from "./model.js";
import { QuiesceCoordinator, QuiesceRefused } from "./quiesce.js";
import { buildWorld, workGrants } from "./testing/world.js";

after(stopServer);

const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] };

for (const backend of backends) {
  const rig = async (checkpoint: () => Promise<Record<string, never>>, ignoreStop = false) => {
    const store = await backend.open();
    const w = await buildWorld(store.storage);
    await w.principals.enroll(w.owner, { commandId: "eh", kind: "host", name: "local", grants: [] });
    const self = await w.principals.authenticate((await w.principals.issueCredential(w.owner, "host:local")).token);
    await w.admission.setCapacity({ commandId: "cap2", actor: w.owner.id, host: "host:local", capacity: { cpus: 4, memoryMb: 8192 } });
    const turn: { call?: BoundCall; release?: () => void; started?: () => void; second?: () => Promise<string> } = {};
    const inCall = new Promise<void>((ok) => { turn.started = ok; });
    const hold = new Promise<void>((ok) => { turn.release = ok; });
    let checkpoints = 0;
    const local = new LocalWorker({
      hostId: "host:local", resources: { cpus: 1, memoryMb: 1024 }, version: "v", capabilities: () => CAPS,
      sandbox: { open: async (r) => ({ revision: r.revision, close: async () => undefined }) },
      runtimes: { open: async (_o, call) => {
        turn.call = call;
        return {
          run: async () => {
            // One call that is in flight until it is told to stop or released; it ends with the signal.
            await call({ callId: "c1", tool: { name: "read-file", version: "1" }, args: {} }, { kind: "local", run: (signal) => new Promise((resolve) => { turn.started!(); if (!ignoreStop) signal.addEventListener("abort", () => resolve({ text: "stopped" })); void hold.then(() => resolve({ text: "x" })); }) });
            await turn.second!().catch(() => undefined);
            return { status: "completed", text: "done" };
          },
          checkpoint: async () => { checkpoints++; return checkpoint(); }, close: async () => undefined,
        };
      } },
    });
    await local.register(w.hosts, self);
    const d = w.restart({ workers: [local] });
    const ann = await w.agent("ann", workGrants(w.project, ["read-file"]));
    const { attemptId, taskId } = await w.task("t", ann);
    const coordinator = new QuiesceCoordinator({ dispatcher: d, blockers: w.blockers, principal: w.owner });
    return { store, w, d, turn, inCall, attemptId: attemptId!, taskId, coordinator, checkpoints: () => checkpoints };
  };
  const ops = async (r: Awaited<ReturnType<typeof rig>>) => (await r.w.storage.listAggregates(operationKind(r.attemptId), { limit: 50 })).map((a) => a.body as unknown as ToolOperationBody);

  test(`${backend.name}: the operation runs only once the attempt has no call in flight, is frozen with a checkpoint, and the attempt goes on afterwards`, async () => {
    const r = await rig(async () => ({}));
    try {
      const seen: { inFlight: readonly string[]; frozen: boolean; refusedDuring: string; checkpoints: number }[] = [];
      let secondResult = "";
      let afterOperation!: () => void;
      const operationDone = new Promise<void>((ok) => { afterOperation = ok; });
      r.turn.second = async () => {
        // The second call comes after the operation: it must run.
        await operationDone;
        const res = await r.turn.call!({ callId: "c2", tool: { name: "read-file", version: "1" }, args: {} }, { kind: "local", run: async () => ({ text: "later" }) });
        secondResult = res.state;
        return res.state;
      };
      await r.d.tick();
      await r.inCall;
      const told: string[] = [];
      const result = await r.coordinator.around({ taskId: r.taskId }, "integration", async (quiet) => {
        const attempt = (await r.d.get(r.w.owner, r.attemptId))!;
        // A call made while the work is being changed is refused.
        const during = await r.turn.call!({ callId: "cx", tool: { name: "read-file", version: "1" }, args: {} }, { kind: "local", run: async () => ({ text: "no" }) }).then((x) => x.state, (e: Error) => `threw: ${e.message}`);
        seen.push({ inFlight: attempt.inFlight, frozen: attempt.frozen !== undefined, refusedDuring: during, checkpoints: quiet.attempts.length });
        return "integrated";
      }, async (id) => { told.push(id); });
      afterOperation();
      assert.equal(result, "integrated");
      assert.deepEqual(seen.map((s) => [s.inFlight.length, s.frozen, s.checkpoints]), [[0, true, 1]], "nothing was in flight and the attempt was frozen while the operation ran");
      assert.notEqual(seen[0]!.refusedDuring, "confirmed", seen[0]!.refusedDuring);
      assert.deepEqual(told, [r.attemptId]);
      assert.equal(r.checkpoints() >= 1, true, "a checkpoint was taken");
      assert.equal((await r.d.get(r.w.owner, r.attemptId))!.frozen, undefined, "the attempt is released");
      await r.d.idle();
      assert.equal(secondResult, "confirmed", "the attempt went on after the operation");
      assert.ok((await ops(r)).every((o) => TERMINAL.has(o.state)), JSON.stringify((await ops(r)).map((o) => o.state)));
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: an attempt that cannot be made quiet blocks the operation with a typed blocker and nothing stays frozen`, async () => {
    const r = await rig(async () => { throw new Error("the checkpoint could not be taken"); });
    try {
      r.turn.second = async () => "x";
      await r.d.tick();
      await r.inCall;
      let ran = false;
      await assert.rejects(r.coordinator.around({ taskId: r.taskId }, "refresh", async () => { ran = true; }), (e: unknown) => {
        assert.ok(e instanceof QuiesceRefused, String(e));
        assert.equal(e.attemptId, r.attemptId);
        assert.match(e.message, /refresh did not run.*checkpoint could not be taken/);
        assert.ok(e.blockerId !== undefined);
        return true;
      });
      assert.equal(ran, false, "the operation did not run");
      const open = await r.w.blockers.openFor("runtime_hold", { kind: "task", id: r.taskId });
      assert.ok(open !== undefined, "the owner sees why");
      assert.equal((await r.d.get(r.w.owner, r.attemptId))!.frozen, undefined, "the attempt is not left frozen");
      r.turn.release?.();
      await r.d.idle();
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: a call that ignores the stop signal blocks the operation: it is not taken as settled`, async () => {
    const r = await rig(async () => ({}), true);
    try {
      r.turn.second = async () => "x";
      await r.d.tick();
      await r.inCall;
      const strict = new QuiesceCoordinator({ dispatcher: r.d, blockers: r.w.blockers, principal: r.w.owner, settleMs: 50 });
      let ran = false;
      await assert.rejects(strict.around({ taskId: r.taskId }, "integration", async () => { ran = true; }), (e: unknown) => { assert.ok(e instanceof QuiesceRefused, String(e)); assert.match(e.message, /did not stop/); return true; });
      assert.equal(ran, false);
      assert.equal((await r.d.get(r.w.owner, r.attemptId))!.frozen, undefined);
      r.turn.release?.();
      await r.d.idle();
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: a freeze somebody else set is not lifted`, async () => {
    const r = await rig(async () => ({}));
    try {
      r.turn.second = async () => "x";
      await r.d.tick();
      await r.inCall;
      await r.d.freeze(r.w.owner, r.attemptId, "owner hold");
      await r.coordinator.around({ taskId: r.taskId }, "refresh", async () => undefined);
      assert.equal((await r.d.get(r.w.owner, r.attemptId))!.frozen?.reason, "owner hold");
      r.turn.release?.();
      await r.d.release(r.w.owner, r.attemptId);
      await r.d.idle();
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: an operation that fails still releases the attempt, and an agent with no live attempt is not held up`, async () => {
    const r = await rig(async () => ({}));
    try {
      r.turn.second = async () => "x";
      assert.equal(await r.coordinator.around({ taskId: r.taskId }, "quarantine", async (q) => q.attempts.length), 0, "no live attempt yet: the operation just runs");
      await r.d.tick();
      await r.inCall;
      await assert.rejects(r.coordinator.around({ agentId: "agent:ann" }, "release", async () => { throw new Error("the commit failed"); }), /the commit failed/);
      assert.equal((await r.d.get(r.w.owner, r.attemptId))!.frozen, undefined);
      r.turn.release?.();
      await r.d.idle();
    } finally { await r.store.close(); }
  });
}
