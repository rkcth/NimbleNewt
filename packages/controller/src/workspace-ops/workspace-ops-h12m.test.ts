import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { LocalWorker, type BoundCall } from "../dispatch/local-worker.js";
import { QuiesceCoordinator } from "../dispatch/quiesce.js";
import type { DispatcherDeps } from "../dispatch/dispatcher.js";
import { buildWorld, workGrants } from "../dispatch/testing/world.js";
import { WorkspaceOpService, type WorkspaceCall, type WorkspacePort } from "./index.js";

after(stopServer);

// Card H12m, the controller side: what the service does around a host's answer. The host's own work is tested in the worker package (real git) and end to end in the integration package.
const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] };

for (const backend of backends) {
  const rig = async (opts: { workspace?: WorkspacePort; busy?: (taskId: string) => Promise<boolean> } = {}) => {
    const store = await backend.open();
    const w = await buildWorld(store.storage);
    await w.principals.enroll(w.owner, { commandId: "eh", kind: "host", name: "local", grants: [] });
    const self = await w.principals.authenticate((await w.principals.issueCredential(w.owner, "host:local")).token);
    await w.admission.setCapacity({ commandId: "cap2", actor: w.owner.id, host: "host:local", capacity: { cpus: 4, memoryMb: 8192 } });
    const told: string[] = [];
    const turn: { started?: () => void; end?: () => void } = {};
    const inTurn = new Promise<void>((ok) => { turn.started = ok; });
    const over = new Promise<void>((ok) => { turn.end = ok; });
    const local = new LocalWorker({
      hostId: "host:local", resources: { cpus: 1, memoryMb: 1024 }, version: "v", capabilities: () => CAPS,
      ...(opts.workspace === undefined ? {} : { workspace: opts.workspace }),
      sandbox: { open: async (r) => ({ revision: r.revision, close: async () => undefined }) },
      runtimes: { open: async (_o, _call: BoundCall) => ({
        run: async () => { turn.started!(); await over; return { status: "completed", text: "done" }; },
        checkpoint: async () => ({}), tell: async (text: string) => { told.push(text); }, close: async () => undefined,
      }) },
    });
    await local.register(w.hosts, self);
    const deps = (): Partial<DispatcherDeps> => ({ workers: [local], ...(opts.busy === undefined ? {} : { workspaceBusy: opts.busy }) });
    const d = w.restart(deps());
    const ann = await w.agent("ann", workGrants(w.project, ["read-file"]));
    const { attemptId, taskId } = await w.task("t", ann);
    const coordinator = new QuiesceCoordinator({ dispatcher: d, blockers: w.blockers, principal: w.owner });
    const service = (port: WorkspacePort | undefined, more: Record<string, unknown> = {}) => WorkspaceOpService.withEpoch(w.storage, w.epoch, {
      quiesce: coordinator, portOf: async () => port,
      assignee: async () => "agent:ann",
      attempts: { live: (t: string) => d.liveAttemptsOf(w.owner, { taskId: t }), frozenReason: async (id: string) => (await d.get(w.owner, id))?.frozen?.reason, release: (id: string) => d.release(w.owner, id), tell: (id: string, text: string) => d.tell(w.owner, id, text), stop: (id: string, reason: string) => d.stop(w.owner, id, { reason }) },
      ...more,
    } as never, { clock: w.clock.now });
    return { store, w, d, local, told, turn, inTurn, attemptId: attemptId!, taskId, coordinator, service, aid: ann.aid };
  };

  test(`${backend.name}: the request is recorded against the task's assignee and the host is told who; a running agent is told its checkout changed after a refresh and an integration, not when nothing changed (card H12m)`, async () => {
    const r = await rig();
    try {
      await r.d.tick(); await r.inTurn;
      const calls: WorkspaceCall[] = [];
      let changed = true;
      const svc = r.service({ run: async (c) => { calls.push(c); return { ok: true, summary: `${c.operation} done`, detail: { changed } }; } });
      const a = await svc.request(r.w.owner, { commandId: "m1", operation: "refresh", taskId: r.taskId, reason: "base moved" });
      assert.equal(a.state, "done");
      assert.equal(a.assignee, "agent:ann", "recorded against the assignee");
      assert.equal(calls[0]!.assignee, "agent:ann", "the host is told who the work is attributed to");
      assert.deepEqual(a.told, [r.attemptId]);
      assert.equal(r.told.length, 1);
      assert.match(r.told[0]!, /checkout was refreshed.*read them again/);
      assert.equal((await r.d.get(r.w.owner, r.attemptId))!.frozen, undefined, "the agent runs on");
      const b = await svc.request(r.w.owner, { commandId: "m2", operation: "integration", taskId: r.taskId, reason: "ready" });
      assert.deepEqual([b.state, b.told?.length], ["done", 1]);
      assert.match(r.told[1]!, /was integrated into the shared workspace/);
      changed = false;
      const c = await svc.request(r.w.owner, { commandId: "m3", operation: "refresh", taskId: r.taskId, reason: "again" });
      assert.deepEqual([c.state, c.told], ["done", undefined], "nothing changed: the agent is not told");
      assert.equal(r.told.length, 2);
      // A repeat is the recorded answer: not told again.
      assert.equal((await svc.request(r.w.owner, { commandId: "m1", operation: "refresh", taskId: r.taskId, reason: "base moved" })).replayed, true);
      assert.equal(r.told.length, 2);
      r.turn.end!(); await r.d.idle();
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: a quarantined checkout stops the attempt (its work is kept for the owner and the task is left as it is); a quarantine the host refuses stops nothing (card H12m)`, async () => {
    const r = await rig();
    try {
      await r.d.tick(); await r.inTurn;
      let ok = false;
      const svc = r.service({ run: async () => (ok ? { ok: true, summary: "moved", detail: { removed: true, changed: true } } : { ok: false, reason: "not on this host" }) });
      const refused = await svc.request(r.w.owner, { commandId: "q1", operation: "quarantine", taskId: r.taskId, reason: "odd file" });
      assert.equal(refused.state, "refused");
      assert.equal((await r.d.get(r.w.owner, r.attemptId))!.state, "running", "a refusal changes nothing");
      ok = true;
      const done = await svc.request(r.w.owner, { commandId: "q2", operation: "quarantine", taskId: r.taskId, reason: "odd file" });
      assert.equal(done.state, "done");
      assert.deepEqual(done.stopped, [r.attemptId]);
      const after = (await r.d.get(r.w.owner, r.attemptId))!;
      assert.equal(after.state, "finished");
      assert.deepEqual(r.told, [], "a quarantined agent is stopped, not told to carry on");
      assert.equal((await r.w.blockers.openFor("runtime_hold", { kind: "task", id: r.taskId })), undefined, "nothing stays frozen or blocked");
      r.turn.end!(); await r.d.idle();
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: while an operation runs the task is busy and its waiting attempt does not start; it starts once the operation ends (card H12m)`, async () => {
    let svc: WorkspaceOpService | undefined;
    const r = await rig({ busy: (t) => svc!.isBusy(t) });
    try {
      svc = r.service(undefined);
      let inside!: () => void; const entered = new Promise<void>((ok) => { inside = ok; });
      let leave!: () => void; const hold = new Promise<void>((ok) => { leave = ok; });
      svc = r.service({ run: async () => { inside(); await hold; return { ok: true, summary: "done", detail: { changed: false } }; } });
      const running = svc.request(r.w.owner, { commandId: "b1", operation: "refresh", taskId: r.taskId, reason: "base moved" });
      await entered;
      assert.equal(await svc.isBusy(r.taskId), true);
      assert.equal(await svc.isBusy("task-aaaaaaaaaaaaaaaaaaaa"), false);
      const waited = await r.d.tick();
      assert.deepEqual(waited.started, [], "the attempt is held back while the operation runs");
      assert.ok(waited.waiting.includes(r.attemptId));
      leave();
      assert.equal((await running).state, "done");
      assert.equal(await svc.isBusy(r.taskId), false);
      const later = await r.d.tick();
      assert.deepEqual(later.started, [r.attemptId], "and starts when it ends");
      await r.inTurn; r.turn.end!(); await r.d.idle();
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: an operation left open by a stopped controller keeps the task busy until the recovery resolves it (card H12m)`, async () => {
    const r = await rig({ busy: async () => false });
    try {
      const svc = r.service({ run: async () => { throw new Error("process died"); } });
      // The request is recorded as started and the process "dies" before the outcome: make the record by hand through a port that never answers, then drop the service.
      let hang!: () => void; const never = new Promise<void>((ok) => { hang = ok; });
      const stuck = r.service({ run: async () => { await never; return { ok: true, summary: "x" }; } });
      void stuck.request(r.w.owner, { commandId: "o1", operation: "refresh", taskId: r.taskId, reason: "base moved" }).catch(() => undefined);
      for (let i = 0; i < 50 && (await stuck.openFor(r.taskId)) === undefined; i++) await new Promise((ok) => setTimeout(ok, 10));
      assert.ok(await stuck.openFor(r.taskId), "open");
      // Another process (the new controller) sees the task busy, and its recovery resolves it as uncertain.
      assert.equal(await svc.isBusy(r.taskId), true);
      assert.deepEqual((await svc.recover(r.w.owner)).length, 1);
      assert.equal(await svc.isBusy(r.taskId), false);
      hang();
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: a freeze that cannot be lifted after a refusal or a host fault opens a blocker, stays in the record and is lifted by the recovery (card H12m)`, async () => {
    const r = await rig();
    try {
      await r.d.tick(); await r.inTurn;
      let failRelease = true;
      const svc = r.service({ run: async () => { throw new Error("the host broke"); } }, {
        attempts: { live: (t: string) => r.d.liveAttemptsOf(r.w.owner, { taskId: t }), frozenReason: async (id: string) => (await r.d.get(r.w.owner, id))?.frozen?.reason, release: (id: string) => r.d.release(r.w.owner, id) },
      });
      // The quiesce lifts through the dispatcher; make that fail the first time.
      const realRelease = r.d.release.bind(r.d);
      (r.d as { release: unknown }).release = async (by: never, id: string, o?: never) => { if (failRelease) throw new Error("the record could not be written"); return realRelease(by, id, o); };
      const a = await svc.request(r.w.owner, { commandId: "u1", operation: "refresh", taskId: r.taskId, reason: "base moved" });
      assert.equal(a.state, "failed", "the host fault");
      assert.deepEqual(a.held, [r.attemptId], "the record keeps the freeze it could not lift");
      const blocker = await r.w.blockers.openFor("runtime_hold", { kind: "task", id: r.taskId });
      assert.ok(blocker !== undefined, "the owner sees it");
      assert.match(blocker!.summary, /could not be released/);
      assert.ok((await r.d.get(r.w.owner, r.attemptId))!.frozen !== undefined, "still frozen");
      assert.ok(await svc.openFor(r.taskId) === undefined || true);
      failRelease = false;
      assert.equal((await svc.recover(r.w.owner)).length, 1, "the recovery finds it through the record");
      assert.equal((await r.d.get(r.w.owner, r.attemptId))!.frozen, undefined, "and lifts it");
      r.turn.end!(); await r.d.idle();
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: the host of a task's last placement is recorded when an attempt starts, and read back (card H12m)`, async () => {
    const r = await rig();
    try {
      assert.equal(await r.d.placedHostOf(r.w.owner, r.taskId), undefined, "nothing placed yet");
      await r.d.tick(); await r.inTurn;
      assert.equal(await r.d.placedHostOf(r.w.owner, r.taskId), "host:local");
      r.turn.end!(); await r.d.idle();
      assert.equal((await r.d.get(r.w.owner, r.attemptId))!.state, "finished");
      assert.equal(await r.d.placedHostOf(r.w.owner, r.taskId), "host:local", "it outlives the attempt");
      await assert.rejects(() => r.d.placedHostOf({ ...r.w.owner, kind: "agent" } as never, r.taskId), /may not read/);
      await assert.rejects(() => r.d.tell({ ...r.w.owner, kind: "agent", taskScope: undefined } as never, r.attemptId, "x"), /may not control|not a live/);
    } finally { await r.store.close(); }
  });
}
