import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { LocalWorker, type BoundCall } from "../dispatch/local-worker.js";
import { QuiesceCoordinator } from "../dispatch/quiesce.js";
import { buildWorld, workGrants } from "../dispatch/testing/world.js";
import { WorkspaceOpService, type WorkspacePort } from "./index.js";

after(stopServer);

// Card H12q: "an attempt cannot start during a landing", at the two moments the dispatcher's own check (H12m's `workspaceBusy`, read once early in the start) does not cover:
// (1) the attempt passed that check and the landing begins before the attempt is marked running; (2) the attempt is already marked running and its worker is still coming up when the landing begins.
const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] };
const later = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

for (const backend of backends) {
  const rig = async (hooks: { busy: (taskId: string) => Promise<boolean>; opening?: () => Promise<void>; settleMs?: number; budget?: boolean }) => {
    const store = await backend.open();
    const w = await buildWorld(store.storage);
    await w.principals.enroll(w.owner, { commandId: "eh", kind: "host", name: "local", grants: [] });
    const self = await w.principals.authenticate((await w.principals.issueCredential(w.owner, "host:local")).token);
    await w.admission.setCapacity({ commandId: "cap2", actor: w.owner.id, host: "host:local", capacity: { cpus: 4, memoryMb: 8192 } });
    const log: string[] = [];
    const turn: { end?: () => void } = {};
    const over = new Promise<void>((ok) => { turn.end = ok; });
    let checkpoints = 0;
    const local = new LocalWorker({
      hostId: "host:local", resources: { cpus: 1, memoryMb: 1024 }, version: "v", capabilities: () => CAPS,
      sandbox: { open: async (r) => ({ revision: r.revision, close: async () => undefined }) },
      runtimes: { open: async (_o, _call: BoundCall) => {
        log.push("worker:opening");
        await hooks.opening?.();
        log.push("worker:up");
        return { run: async () => { log.push("worker:running"); await over; return { status: "completed", text: "done" }; }, checkpoint: async () => { checkpoints++; return {}; }, tell: async () => undefined, close: async () => undefined };
      } },
    });
    await local.register(w.hosts, self);
    const d = w.restart({ workers: [local], workspaceBusy: hooks.busy });
    const ann = await w.agent("ann", workGrants(w.project, ["read-file"]));
    const { attemptId, taskId } = await w.task("t", ann);
    if (hooks.budget === true) await w.budgets.open(w.owner, { commandId: "bo", taskId, currency: "USD", costMicros: 10_000, computeMs: 3_600_000 });
    const coordinator = new QuiesceCoordinator({ dispatcher: d, blockers: w.blockers, principal: w.owner, ...(hooks.settleMs === undefined ? {} : { settleMs: hooks.settleMs }) });
    const service = (port: WorkspacePort) => WorkspaceOpService.withEpoch(w.storage, w.epoch, {
      quiesce: coordinator, portOf: async () => port, assignee: async () => "agent:ann",
      attempts: { live: (t: string) => d.liveAttemptsOf(w.owner, { taskId: t }), frozenReason: async (id: string) => (await d.get(w.owner, id))?.frozen?.reason, release: (id: string) => d.release(w.owner, id), tell: (id: string, text: string) => d.tell(w.owner, id, text), stop: (id: string, reason: string) => d.stop(w.owner, id, { reason }) },
    } as never, { clock: w.clock.now });
    return { store, w, d, log, turn, attemptId: attemptId!, taskId, service, checkpoints: () => checkpoints };
  };

  test(`${backend.name}: a landing that begins after the dispatcher found the task free, but before the attempt was marked running, keeps the attempt from starting until it has ended (card H12q)`, async () => {
    let svc: WorkspaceOpService | undefined;
    let landing: Promise<unknown> | undefined;
    let inHost!: () => void; const entered = new Promise<void>((ok) => { inHost = ok; });
    let leave!: () => void; const hold = new Promise<void>((ok) => { leave = ok; });
    let first = true;
    const r = await rig({ busy: async (t) => {
      const busy = await svc!.isBusy(t);
      if (first) {
        // The dispatcher has read "not busy"; the landing now begins and reaches the host before the dispatcher goes on with the start.
        first = false;
        landing = svc!.request(r.w.owner, { commandId: "l1", operation: "landing", taskId: r.taskId, reason: "reviewed" });
        await entered;
      }
      return busy;
    } });
    try {
      svc = r.service({ run: async () => { r.log.push("host:landing"); inHost(); await hold; r.log.push("host:landed"); return { ok: true, summary: "landed", detail: { landed: true, changed: true } }; } });
      const tick = await r.d.tick();
      assert.deepEqual(tick.started, [], "the attempt is not started while the landing runs");
      assert.ok(tick.waiting.includes(r.attemptId));
      assert.deepEqual(r.log, ["host:landing"], "no worker was opened during the landing");
      assert.equal((await r.d.get(r.w.owner, r.attemptId))!.state, "waiting");
      leave();
      const answer = await landing as { state: string; quietAttempts?: string[] };
      assert.equal(answer.state, "done");
      assert.equal((await r.d.get(r.w.owner, r.attemptId))!.frozen, undefined, "the landing's freeze is lifted");
      assert.deepEqual((await r.d.tick()).started, [r.attemptId], "and the attempt starts once the landing has ended");
      assert.deepEqual(r.log, ["host:landing", "host:landed", "worker:opening", "worker:up", "worker:running"]);
      r.turn.end!(); await r.d.idle();
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: a landing that begins while an attempt's worker is coming up waits for it to be up, makes it quiet with a checkpoint, and only then asks the host (card H12q)`, async () => {
    let svc: WorkspaceOpService | undefined;
    let landing: Promise<unknown> | undefined;
    let inHost!: () => void; const entered = new Promise<void>((ok) => { inHost = ok; });
    let frozenAtHost: boolean | undefined;
    const r = await rig({
      busy: async (t) => svc!.isBusy(t),
      opening: async () => {
        // The attempt is marked running and its worker is opening: the landing begins now. The worker comes up after the host was entered, or after a while if the host waits for it.
        landing = svc!.request(r.w.owner, { commandId: "l2", operation: "landing", taskId: r.taskId, reason: "reviewed" });
        await Promise.race([entered, later(300)]);
      },
    });
    try {
      svc = r.service({ run: async () => { r.log.push("host:landing"); frozenAtHost = (await r.d.get(r.w.owner, r.attemptId))!.frozen !== undefined; inHost(); return { ok: true, summary: "landed", detail: { landed: true, changed: true } }; } });
      assert.deepEqual((await r.d.tick()).started, [r.attemptId]);
      const answer = await landing as { state: string; quietAttempts?: string[] };
      assert.equal(answer.state, "done");
      // The worker's turn may begin before the host is asked (it is frozen: every call it makes is refused); the host is never asked before the worker is up.
      assert.deepEqual(r.log.filter((l) => l !== "worker:running"), ["worker:opening", "worker:up", "host:landing"], "the host was asked only once the worker was up");
      assert.equal(frozenAtHost, true, "the attempt was frozen while the host worked");
      assert.deepEqual(answer.quietAttempts, [r.attemptId]);
      assert.equal(r.checkpoints(), 1, "a checkpoint was taken from the worker before the landing");
      assert.equal((await r.d.get(r.w.owner, r.attemptId))!.frozen, undefined, "and the attempt goes on afterwards");
      r.turn.end!(); await r.d.idle();
    } finally { await r.store.close(); }
  });

  // What the attempt holds: the place (its request on the record, and whether admission still has it running or waiting) and the allowance (the reservation on the record, and the task's open holds).
  const holds = async (r: Awaited<ReturnType<typeof rig>>) => {
    const body = (await r.d.get(r.w.owner, r.attemptId))!;
    const report = await r.w.budgets.report(r.w.owner, r.taskId);
    return { requestId: body.requestId, reservationId: body.reservationId, releasingId: body.releasingId, open: report?.reservations.length ?? 0 };
  };

  test(`${backend.name}: a landing that begins while a worker is coming up and the worker is not up within the settle time is refused with a blocker; the host is not asked, nothing stays frozen, and the next landing goes (card H12q review)`, async () => {
    let svc: WorkspaceOpService | undefined;
    let letUp!: () => void; const up = new Promise<void>((ok) => { letUp = ok; });
    let opening!: () => void; const inOpening = new Promise<void>((ok) => { opening = ok; });
    let ran = 0;
    const r = await rig({ settleMs: 200, busy: async (t) => svc!.isBusy(t), opening: async () => { opening(); await up; } });
    try {
      svc = r.service({ run: async () => { ran++; r.log.push("host:landing"); return { ok: true, summary: "landed", detail: { landed: true, changed: true } }; } });
      const tick = r.d.tick();
      await inOpening;
      // The dispatcher says so in a form a caller that can wait (a stop's cleanup) can tell from a failure.
      await assert.rejects(r.d.quiesce(r.w.owner, r.attemptId, "a look", { strictMs: 50 }), (e: unknown) => (e as { code?: string; field?: string }).code === "unavailable" && (e as { field?: string }).field === "starting");
      await r.d.release(r.w.owner, r.attemptId);
      const answer = await svc.request(r.w.owner, { commandId: "l1", operation: "landing", taskId: r.taskId, reason: "reviewed" }) as { state: string; summary?: string };
      assert.notEqual(answer.state, "done", "the landing did not run beside a worker that is still starting");
      assert.match(answer.summary ?? "", /still starting/);
      assert.equal(ran, 0, "the host was never asked");
      assert.ok((await r.w.blockers.openFor("runtime_hold", { kind: "task", id: r.taskId })) !== undefined, "the owner sees why");
      assert.equal((await r.d.get(r.w.owner, r.attemptId))!.frozen, undefined, "the landing's freeze is lifted");
      letUp();
      assert.deepEqual((await tick).started, [r.attemptId], "the worker comes up and runs");
      const second = await svc.request(r.w.owner, { commandId: "l2", operation: "landing", taskId: r.taskId, reason: "again" }) as { state: string };
      assert.equal(second.state, "done");
      assert.equal(ran, 1);
      assert.deepEqual(r.log.filter((l) => l !== "worker:running"), ["worker:opening", "worker:up", "host:landing"]);
      r.turn.end!(); await r.d.idle();
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: an attempt frozen after the dispatcher found the task free is not started and gives back its place and its held allowance; ticks while it stays frozen hold nothing, and it starts once released (card H12q review)`, async () => {
    let first = true;
    let mid: Awaited<ReturnType<typeof holds>> | undefined;
    const r = await rig({ budget: true, busy: async () => { if (first) { first = false; await r.d.freeze(r.w.owner, r.attemptId, "owner hold"); } return false; } });
    try {
      const tick = await r.d.tick();
      assert.deepEqual(tick.started, []);
      assert.ok(tick.waiting.includes(r.attemptId));
      mid = await holds(r);
      assert.deepEqual(mid, { requestId: undefined, reservationId: undefined, releasingId: undefined, open: 0 }, "the place and the hold taken for the start were given back");
      assert.deepEqual((await r.d.tick()).started, []);
      assert.deepEqual(await holds(r), mid, "a later tick leaks nothing");
      assert.deepEqual(r.log, [], "no worker was opened");
      await r.d.release(r.w.owner, r.attemptId);
      assert.deepEqual((await r.d.tick()).started, [r.attemptId]);
      r.turn.end!(); await r.d.idle();
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: an attempt left waiting and frozen asks for no place, holds no allowance and pins nothing at each tick (card H12q review)`, async () => {
    let busy = true;
    const r = await rig({ budget: true, busy: async () => busy });
    try {
      // The first tick claims the attempt and leaves it waiting (the checkout is busy), holding nothing; then it is frozen and the checkout is free.
      assert.ok((await r.d.tick()).waiting.includes(r.attemptId));
      busy = false;
      const asked: string[] = [];
      const spy = (target: object, name: string, counts: (...a: unknown[]) => boolean = () => true) => { const t = target as Record<string, (...a: unknown[]) => unknown>; const real = t[name]!.bind(target); t[name] = (...a: unknown[]) => { if (counts(...a)) asked.push(name); return real(...a); }; };
      // The checkout is looked at (not pinned) by the checks every tick; only a pin counts.
      spy(r.w.admission, "request"); spy(r.w.admission, "release"); spy(r.w.budgets, "reserve"); spy(r.w.budgets, "release"); spy(r.w.resources, "dispatchCheckout", (c) => (c as { pin: boolean }).pin);
      await r.d.freeze(r.w.owner, r.attemptId, "owner hold");
      for (let i = 0; i < 3; i++) assert.ok((await r.d.tick()).waiting.includes(r.attemptId));
      assert.deepEqual(asked, [], "nothing was asked for, held or pinned");
      assert.deepEqual(await holds(r), { requestId: undefined, reservationId: undefined, releasingId: undefined, open: 0 });
      await r.d.release(r.w.owner, r.attemptId);
      assert.deepEqual((await r.d.tick()).started, [r.attemptId]);
      const afterRelease = asked as string[];
      assert.ok(afterRelease.includes("request") && afterRelease.includes("reserve"), "once released it asks for its place and holds its allowance");
      r.turn.end!(); await r.d.idle();
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: an ending freeze (a stop that is ending the attempt) does not keep a waiting attempt from starting; the stop then ends it (card H12q review)`, async () => {
    let busy = true;
    const r = await rig({ busy: async () => busy });
    try {
      assert.ok((await r.d.tick()).waiting.includes(r.attemptId));
      busy = false;
      await r.d.freeze(r.w.owner, r.attemptId, "ending", { ending: true });
      assert.deepEqual((await r.d.tick()).started, [r.attemptId], "the start goes on");
      await r.d.stop(r.w.owner, r.attemptId, { reason: "owner says stop" });
      assert.equal((await r.d.get(r.w.owner, r.attemptId))!.state, "finished", "and the stop ends it");
      r.turn.end!(); await r.d.idle();
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: a stop that ends a waiting attempt after the dispatcher found the task free leaves no place or allowance held for it (card H12q review)`, async () => {
    let first = true;
    const r = await rig({ budget: true, busy: async () => { if (first) { first = false; await r.d.stop(r.w.owner, r.attemptId, { reason: "owner says stop" }); } return false; } });
    try {
      const tick = await r.d.tick();
      assert.deepEqual(tick.started, []);
      const body = (await r.d.get(r.w.owner, r.attemptId))!;
      assert.equal(body.state, "finished");
      assert.ok(body.requestId !== undefined && body.reservationId !== undefined, "the advance took a place and a hold after the stop ended the attempt");
      const where = await r.w.admission.where(body.requestId);
      assert.ok(where.state !== "running" && where.state !== "waiting", `the place was given back (${where.state})`);
      assert.equal((await holds(r)).open, 0, "the hold was given back");
      assert.deepEqual(r.log, [], "no worker was opened");
      await r.d.idle();
    } finally { await r.store.close(); }
  });
}
