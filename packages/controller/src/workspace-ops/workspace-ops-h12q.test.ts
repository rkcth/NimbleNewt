import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { LocalWorker, type BoundCall } from "../dispatch/local-worker.js";
import { QuiesceCoordinator } from "../dispatch/quiesce.js";
import { buildWorld, workGrants } from "../dispatch/testing/world.js";
import { WorkspaceOpService, type WorkspacePort } from "./index.js";
import { dispatchStopPorts } from "../lifecycle/dispatch-ports.js";
import { StopService } from "../lifecycle/index.js";

after(stopServer);

// Card H12q: "an attempt cannot start during a landing", at the two moments the dispatcher's own check (H12m's `workspaceBusy`, read once early in the start) does not cover:
// (1) the attempt passed that check and the landing begins before the attempt is marked running; (2) the attempt is already marked running and its worker is still coming up when the landing begins.
const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] };
const later = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

for (const backend of backends) {
  const rig = async (hooks: { busy: (taskId: string) => Promise<boolean>; opening?: () => Promise<void>; settleMs?: number; budget?: boolean; budgetMs?: number }) => {
    const store = await backend.open();
    const w = await buildWorld(store.storage);
    await w.principals.enroll(w.owner, { commandId: "eh", kind: "host", name: "local", grants: [] });
    const self = await w.principals.authenticate((await w.principals.issueCredential(w.owner, "host:local")).token);
    await w.admission.setCapacity({ commandId: "cap2", actor: w.owner.id, host: "host:local", capacity: { cpus: 4, memoryMb: 8192 } });
    const log: string[] = [];
    const turn: { end?: () => void } = {};
    const over = new Promise<void>((ok) => { turn.end = ok; });
    let checkpoints = 0;
    const mk = () => new LocalWorker({
      hostId: "host:local", resources: { cpus: 1, memoryMb: 1024 }, version: "v", capabilities: () => CAPS,
      sandbox: { open: async (r) => ({ revision: r.revision, close: async () => undefined }) },
      runtimes: { open: async (_o, _call: BoundCall) => {
        log.push("worker:opening");
        await hooks.opening?.();
        log.push("worker:up");
        return { run: async () => { log.push("worker:running"); await over; return { status: "completed", text: "done" }; }, checkpoint: async () => { checkpoints++; return {}; }, tell: async () => undefined, close: async () => undefined };
      } },
    });
    const local = mk();
    await local.register(w.hosts, self);
    const d = w.restart({ workers: [local], workspaceBusy: hooks.busy });
    const ann = await w.agent("ann", workGrants(w.project, ["read-file"]));
    const { attemptId, taskId } = await w.task("t", ann);
    if (hooks.budget === true) await w.budgets.open(w.owner, { commandId: "bo", taskId, currency: "USD", costMicros: 10_000, computeMs: hooks.budgetMs ?? 3_600_000 });
    const coordinator = new QuiesceCoordinator({ dispatcher: d, blockers: w.blockers, principal: w.owner, ...(hooks.settleMs === undefined ? {} : { settleMs: hooks.settleMs }) });
    const service = (port: WorkspacePort) => WorkspaceOpService.withEpoch(w.storage, w.epoch, {
      quiesce: coordinator, portOf: async () => port, assignee: async () => "agent:ann",
      attempts: { live: (t: string) => d.liveAttemptsOf(w.owner, { taskId: t }), frozenReason: async (id: string) => (await d.get(w.owner, id))?.frozen?.reason, release: (id: string) => d.release(w.owner, id), tell: (id: string, text: string) => d.tell(w.owner, id, text), stop: (id: string, reason: string) => d.stop(w.owner, id, { reason }) },
    } as never, { clock: w.clock.now });
    // A second worker over the same host, registered: for a dispatcher started again after a shutdown.
    const another = async () => { const l = mk(); await l.register(w.hosts, self); return l; };
    return { store, w, d, log, turn, attemptId: attemptId!, taskId, service, checkpoints: () => checkpoints, local, another };
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

  // The places admission still holds (running or queued): the rig has one attempt and nothing else asks for a place.
  const places = async (r: Awaited<ReturnType<typeof rig>>) => { const s = await r.w.admission.snapshot(); return s.running.length + s.queue.length; };
  // The late give-backs asked for (admission and budget releases under the `dpa-late-` command IDs).
  const lateReleases = (r: Awaited<ReturnType<typeof rig>>) => {
    const seen: string[] = [];
    const spy = (target: object, name: string, label: string, pick: (a: unknown[]) => string) => { const t = target as Record<string, (...a: unknown[]) => Promise<unknown>>; const real = t[name]!.bind(target); t[name] = (...a: unknown[]) => { if (pick(a).startsWith("dpa-late-")) seen.push(label); return real(...a); }; };
    spy(r.w.admission, "release", "place", (a) => (a[0] as { commandId: string }).commandId);
    spy(r.w.budgets, "release", "hold", (a) => (a[1] as { commandId: string }).commandId);
    return seen;
  };
  // Makes a service method fail for the late give-backs: `mode` "fail" throws before anything is done; "lost" does the release under another command ID (someone else let it go) and then throws (the reply was lost).
  const faulty = (target: object, name: string, at: 0 | 1, state: { left: number; mode: "fail" | "lost" }) => {
    const t = target as Record<string, (...a: unknown[]) => Promise<unknown>>; const real = t[name]!.bind(target);
    t[name] = async (...a: unknown[]) => {
      const c = a[at] as { commandId: string };
      if (state.left > 0 && c.commandId.startsWith("dpa-late-")) {
        state.left--;
        if (state.mode === "lost") { const other = [...a]; other[at] = { ...c, commandId: `other-${c.commandId}`.slice(0, 120) }; await real(...other); }
        throw new Error("the store did not answer");
      }
      return real(...a);
    };
  };

  test(`${backend.name}: a stop that ends a waiting attempt after the dispatcher found the task free leaves no place or allowance held for it (card H12q review)`, async () => {
    let first = true;
    const r = await rig({ budget: true, busy: async () => { if (first) { first = false; await r.d.stop(r.w.owner, r.attemptId, { reason: "owner says stop" }); } return false; } });
    try {
      const late = lateReleases(r);
      const tick = await r.d.tick();
      assert.deepEqual(tick.started, []);
      assert.deepEqual(tick.failures, []);
      assert.deepEqual(tick.skipped.map((s) => s.reason), ["the attempt has ended"]);
      const body = (await r.d.get(r.w.owner, r.attemptId))!;
      assert.equal(body.state, "finished");
      assert.deepEqual(late.sort(), ["hold", "place"], "the advance took a place and a hold after the stop ended the attempt, and both were given back");
      assert.equal(body.lateHeld, undefined, "nothing is left marked");
      assert.equal(await places(r), 0, "the place was given back");
      assert.equal((await holds(r)).open, 0, "the hold was given back");
      assert.deepEqual(r.log, [], "no worker was opened");
      assert.deepEqual((await r.d.tick()).failures, [], "and a later tick has nothing to do for it");
      await r.d.idle();
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: an attempt that ran before (it used compute, then the controller shut down) and is stopped inside its next advance leaves no place or hold behind; what it used is settled (card H12q review)`, async () => {
    let stopNow = false;
    const r = await rig({ budget: true, busy: async () => false });
    let d2: typeof r.d | undefined;
    try {
      assert.deepEqual((await r.d.tick()).started, [r.attemptId]);
      await r.d.gateway(r.attemptId).usage({ computeMs: 1000 });
      assert.equal((await r.d.shutdown()).closed, 1);
      assert.equal((await r.d.get(r.w.owner, r.attemptId))!.state, "waiting");
      const local2 = await r.another();
      d2 = r.w.restart({ workers: [local2], workspaceBusy: async () => { if (stopNow) { stopNow = false; await d2!.stop(r.w.owner, r.attemptId, { reason: "owner says stop" }); } return false; } });
      stopNow = true;
      const tick = await d2.tick();
      assert.deepEqual(tick.failures, []);
      assert.deepEqual(tick.skipped.map((s) => s.reason), ["the attempt has ended"]);
      const body = (await d2.get(r.w.owner, r.attemptId))!;
      assert.equal(body.state, "finished");
      assert.equal(body.used?.computeMs, 1000);
      assert.equal(await places(r), 0, "the place the advance took after the end was given back, though the attempt had used compute before");
      const report = (await r.w.budgets.report(r.w.owner, r.taskId))!;
      assert.equal(report.reservations.length, 0, "no hold is open");
      assert.equal(report.spent.computeMs, 1000, "what the attempt used was settled by its end");
      await d2.idle();
    } finally { r.turn.end!(); await r.d.idle(); await d2?.idle(); await r.store.close(); }
  });

  test(`${backend.name}: a place or hold taken after the end that cannot be given back at once is given back by a later tick, each on its own, and by a restarted controller (card H12q review)`, async () => {
    let first = true;
    const r = await rig({ budget: true, busy: async () => { if (first) { first = false; await r.d.stop(r.w.owner, r.attemptId, { reason: "owner says stop" }); } return false; } });
    try {
      const place = { left: 1, mode: "fail" as "fail" | "lost" }, hold = { left: 0, mode: "fail" as "fail" | "lost" };
      faulty(r.w.admission, "release", 0, place); faulty(r.w.budgets, "release", 1, hold);
      const tick = await r.d.tick();
      assert.deepEqual(tick.failures, [], "a give-back that fails is told, not a failure of the tick");
      assert.deepEqual(tick.skipped.map((s) => s.reason), ["the attempt has ended"]);
      assert.deepEqual((await r.d.get(r.w.owner, r.attemptId))!.lateHeld !== undefined, true, "what is still held stays marked");
      assert.equal(await places(r), 1, "the place is still held");
      assert.equal((await holds(r)).open, 0, "the hold was given back on its own although the place could not be");
      assert.deepEqual((await r.d.tick()).failures, []);
      assert.equal(await places(r), 0, "the next tick gave the place back");
      assert.equal((await r.d.get(r.w.owner, r.attemptId))!.lateHeld, undefined, "and took the mark off");
    } finally { await r.d.idle(); await r.store.close(); }
  });

  test(`${backend.name}: a controller that stops before it could give back a place and hold taken after the end leaves them marked, and the next controller gives them back (card H12q review)`, async () => {
    let first = true;
    const r = await rig({ budget: true, busy: async () => { if (first) { first = false; await r.d.stop(r.w.owner, r.attemptId, { reason: "owner says stop" }); } return false; } });
    try {
      const place = { left: 1_000, mode: "fail" as "fail" | "lost" }, hold = { left: 1_000, mode: "fail" as "fail" | "lost" };
      faulty(r.w.admission, "release", 0, place); faulty(r.w.budgets, "release", 1, hold);
      await r.d.tick();
      const again = await r.d.tick();
      assert.equal(again.failures.length, 1, "a later tick that still cannot give them back says so");
      const marked = (await r.d.get(r.w.owner, r.attemptId))!.lateHeld;
      assert.ok(marked?.requestId !== undefined && marked.reservationId !== undefined, "both are marked on the finished record");
      assert.equal(await places(r), 1);
      assert.equal((await holds(r)).open, 1);
      await r.d.idle();
      // The controller stops here; the next one runs over the same records with the services answering again.
      place.left = 0; hold.left = 0;
      const d2 = r.w.restart({ workers: [r.local] });
      assert.deepEqual((await d2.tick()).failures, []);
      assert.equal(await places(r), 0);
      assert.equal((await holds(r)).open, 0);
      assert.equal((await d2.get(r.w.owner, r.attemptId))!.lateHeld, undefined);
      await d2.idle();
    } finally { await r.store.close(); }
  });

  for (const what of ["place", "hold"] as const) {
    test(`${backend.name}: a late ${what} that someone else let go meanwhile is taken as given back: the tick does not fail on it again (card H12q review)`, async () => {
      let first = true;
      const r = await rig({ budget: true, busy: async () => { if (first) { first = false; await r.d.stop(r.w.owner, r.attemptId, { reason: "owner says stop" }); } return false; } });
      try {
        const fault = { left: 1, mode: "lost" as "fail" | "lost" };
        if (what === "place") faulty(r.w.admission, "release", 0, fault); else faulty(r.w.budgets, "release", 1, fault);
        assert.deepEqual((await r.d.tick()).failures, []);
        assert.notEqual((await r.d.get(r.w.owner, r.attemptId))!.lateHeld, undefined, "the lost answer leaves it marked");
        const next = await r.d.tick();
        assert.deepEqual(next.failures, [], `a ${what} already let go (${what === "place" ? "not_found" : "invalid_transition"}) is nothing left to give back`);
        assert.equal((await r.d.get(r.w.owner, r.attemptId))!.lateHeld, undefined);
        assert.equal(await places(r), 0);
        assert.equal((await holds(r)).open, 0);
      } finally { await r.d.idle(); await r.store.close(); }
    });
  }

  test(`${backend.name}: a place and hold an advance records while a stop is ending the attempt (after the end read the record) are marked by the end and given back (card H12q review)`, async () => {
    let first = true;
    let stopping: Promise<unknown> | undefined;
    let inEnd!: () => void; const reached = new Promise<void>((ok) => { inEnd = ok; });
    let go!: () => void; const gate = new Promise<void>((ok) => { go = ok; });
    const r = await rig({ budget: true, busy: async () => { if (first) { first = false; stopping = r.d.stop(r.w.owner, r.attemptId, { reason: "owner says stop" }); await reached; } return false; } });
    try {
      const creds = r.w.credentials as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>; const realEnd = creds["endForAttempt"]!.bind(creds);
      let hold = true;
      // The end has read the record (no place, no hold yet) and waits here, so the advance records its place and hold on the record before the end writes it finished.
      creds["endForAttempt"] = async (...a: unknown[]) => { if (hold) { hold = false; inEnd(); await gate; } return realEnd(...a); };
      const res = r.w.resources as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>; const realPin = res["dispatchCheckout"]!.bind(res);
      res["dispatchCheckout"] = async (...a: unknown[]) => { if ((a[0] as { pin?: boolean }).pin === true && stopping !== undefined) { go(); await stopping; } return realPin(...a); };
      const late = lateReleases(r);
      const tick = await r.d.tick();
      assert.deepEqual(tick.failures, []);
      assert.deepEqual(tick.skipped.map((s) => s.reason), ["the attempt has ended"]);
      assert.deepEqual(late.sort(), ["hold", "place"], "the end marked both as taken late");
      assert.equal(await places(r), 0);
      assert.equal((await holds(r)).open, 0);
      assert.equal((await r.d.get(r.w.owner, r.attemptId))!.lateHeld, undefined);
    } finally { await r.d.idle(); await r.store.close(); }
  });

  for (const at of ["pin", "reserve"] as const) {
    test(`${backend.name}: a stop that ends a waiting attempt ${at === "pin" ? "while its checkout is being pinned" : "just after its allowance was held"} ends it cleanly: no tick failure, "the attempt has ended", no place or hold left (card H12q review)`, async () => {
      const r = await rig({ budget: true, busy: async () => false });
      try {
        let armed = true;
        const target = (at === "pin" ? r.w.resources : r.w.budgets) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
        const name = at === "pin" ? "dispatchCheckout" : "reserve";
        const real = target[name]!.bind(target);
        target[name] = async (...a: unknown[]) => {
          if (at === "pin" && (a[0] as { pin?: boolean }).pin !== true) return real(...a);
          const out = await real(...a);
          if (armed) { armed = false; await r.d.stop(r.w.owner, r.attemptId, { reason: "owner says stop" }); }
          return out;
        };
        const tick = await r.d.tick();
        assert.deepEqual(tick.failures, []);
        assert.deepEqual(tick.started, []);
        assert.deepEqual(tick.skipped.map((s) => s.reason), ["the attempt has ended"]);
        assert.equal(await places(r), 0);
        assert.equal((await holds(r)).open, 0);
        assert.equal((await r.d.get(r.w.owner, r.attemptId))!.lateHeld, undefined);
        assert.deepEqual(r.log, []);
      } finally { await r.d.idle(); await r.store.close(); }
    });
  }

  for (const room of [true, false]) {
    test(`${backend.name}: a second dispatcher that starts the attempt while the first is inside its advance keeps its place and hold (${room ? "the first finds the same hold and says another caller started it" : "the first finds no allowance left and gives back nothing"}) (card H12q review)`, async () => {
      let first = true;
      // With room, the first dispatcher's own look at the allowance still finds enough free and asks for the same hold (same command) as the second; without, the second's hold took all of it.
      const r = await rig({ budget: true, ...(room ? { budgetMs: 100 * 3_600_000 } : {}), busy: async () => { if (first) { first = false; assert.deepEqual((await d2.tick()).started, [r.attemptId]); } return false; } });
      const d2 = r.w.restart({ workers: [r.local] });
      try {
        const tick = await r.d.tick();
        assert.deepEqual(tick.failures, []);
        assert.deepEqual(tick.skipped.map((s) => s.reason), [room ? "another caller started the attempt" : "none of the task's allowance is free to hold for the attempt"]);
        const body = (await r.d.get(r.w.owner, r.attemptId))!;
        assert.equal(body.state, "running");
        assert.equal(body.lateHeld, undefined);
        assert.equal((await r.w.admission.where(body.requestId!)).state, "running", "the running attempt keeps its place");
        assert.equal((await holds(r)).open, 1, "and its hold");
        assert.notEqual(body.reservationId, undefined);
      } finally { r.turn.end!(); await r.d.idle(); await d2.idle(); await r.store.close(); }
    });
  }

  for (const at of ["reserve", "request"] as const) test(`${backend.name}: a second dispatcher whose copy is older than the start, and that repeats the ${at === "reserve" ? "hold" : "place request"} after the attempt was stopped with its settle failing, does not mark or release the attempt's own ${at === "reserve" ? "hold" : "place or hold"} (card H12q review)`, async () => {
    let first = true;
    const r = await rig({ budget: true, budgetMs: 100 * 3_600_000, busy: async () => false });
    const budgets = r.w.budgets as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const realReserve = budgets["reserve"]!.bind(budgets), realSettle = budgets["settle"]!.bind(budgets);
    let armed = false, settleFails = 0;
    budgets["settle"] = async (...a: unknown[]) => { if (settleFails > 0) { settleFails--; throw new Error("the ledger did not answer"); } return realSettle(...a); };
    // The second dispatcher read the waiting record; the first starts the attempt (its place and hold), the attempt uses compute, and inside the second's repeat of the hold the first stops it with the settle failing.
    const d2 = r.w.restart({ workers: [r.local], workspaceBusy: async () => { if (first) { first = false; assert.deepEqual((await r.d.tick()).started, [r.attemptId]); await r.d.gateway(r.attemptId).usage({ computeMs: 1000 }); armed = true; } return false; } });
    const stopFirst = async () => { if (armed) { armed = false; settleFails = 1; await r.d.stop(r.w.owner, r.attemptId, { reason: "owner says stop" }); } };
    if (at === "reserve") budgets["reserve"] = async (...a: unknown[]) => { await stopFirst(); return realReserve(...a); };
    else { const adm = r.w.admission as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>; const realRequest = adm["request"]!.bind(adm); adm["request"] = async (...a: unknown[]) => { await stopFirst(); return realRequest(...a); }; }
    try {
      const own = (await r.d.get(r.w.owner, r.attemptId))?.reservationId;
      assert.equal(own, undefined);
      const late = lateReleases(r);
      const tick = await d2.tick();
      assert.deepEqual(tick.failures, []);
      assert.deepEqual(tick.skipped.map((s) => s.reason), [at === "reserve" ? "the attempt has ended" : "the request for a place is gone"]);
      const body = (await r.d.get(r.w.owner, r.attemptId))!;
      assert.equal(body.state, "finished");
      assert.equal(body.lateHeld, undefined, "the attempt's own hold (and place) is not marked as taken late");
      assert.deepEqual(late, [], "nothing was given back as late");
      assert.deepEqual((await d2.tick()).failures, []);
      assert.deepEqual(late, [], "nor by a later tick");
      const report = (await r.w.budgets.report(r.w.owner, r.taskId))!;
      assert.deepEqual(report.reservations.map((h) => h.id), [body.reservationId], "the hold that carries what the attempt used stays open for its settle, not released");
    } finally { r.turn.end!(); await r.d.idle(); await d2.idle(); await r.store.close(); }
  });

  // The stop is made by this controller (whose end also marks what the advance may yet take) or by another controller over the same records (whose end knows nothing of this advance: the advance marks it).
  for (const by of ["this", "another"] as const) test(`${backend.name}: a place taken after the end (no allowance to hold; stopped by ${by} controller) whose give-back fails once is given back by the next tick, which takes the mark off (card H12q review)`, async () => {
    let first = true;
    const r = await rig({ busy: async () => { if (first) { first = false; await (by === "this" ? r.d : r.w.restart({ workers: [r.local] })).stop(r.w.owner, r.attemptId, { reason: "owner says stop" }); } return false; } });
    try {
      faulty(r.w.admission, "release", 0, { left: 1, mode: "fail" });
      const tick = await r.d.tick();
      assert.deepEqual(tick.failures, []);
      assert.deepEqual(tick.skipped.map((s) => s.reason), ["the attempt has ended"]);
      assert.notEqual((await r.d.get(r.w.owner, r.attemptId))!.lateHeld?.requestId, undefined, "the place stays marked");
      assert.equal(await places(r), 1);
      assert.deepEqual((await r.d.tick()).failures, []);
      assert.equal(await places(r), 0, "the next tick gave the place back");
      assert.equal((await r.d.get(r.w.owner, r.attemptId))!.lateHeld, undefined, "and took the mark off");
    } finally { await r.d.idle(); await r.store.close(); }
  });

  for (const by of ["this", "another"] as const) test(`${backend.name}: a hold taken after the end (the stop came once the place was recorded; stopped by ${by} controller) whose give-back fails once is given back by the next tick, which takes the mark off (card H12q review)`, async () => {
    const r = await rig({ budget: true, busy: async () => false });
    const stopper = by === "this" ? r.d : r.w.restart({ workers: [r.local] });
    try {
      const budgets = r.w.budgets as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>; const real = budgets["reserve"]!.bind(budgets);
      let armed = true;
      budgets["reserve"] = async (...a: unknown[]) => { const out = await real(...a); if (armed) { armed = false; await stopper.stop(r.w.owner, r.attemptId, { reason: "owner says stop" }); } return out; };
      faulty(r.w.budgets, "release", 1, { left: 1, mode: "fail" });
      const tick = await r.d.tick();
      assert.deepEqual(tick.failures, []);
      assert.deepEqual(tick.skipped.map((s) => s.reason), ["the attempt has ended"]);
      const marked = (await r.d.get(r.w.owner, r.attemptId))!.lateHeld;
      assert.ok(marked?.reservationId !== undefined, "the hold is marked");
      // Another controller's end gave back the place it found and marks nothing; this controller's end also marked the place of the next request number, which was never taken and is let go as `not_found`.
      if (by === "another") assert.equal(marked.requestId, undefined, "only the hold is marked: the end gave back the place it found");
      assert.equal(await places(r), 0);
      assert.equal((await holds(r)).open, 1);
      assert.deepEqual((await r.d.tick()).failures, []);
      assert.equal((await holds(r)).open, 0, "the next tick gave the hold back");
      assert.equal((await r.d.get(r.w.owner, r.attemptId))!.lateHeld, undefined, "and took the mark off");
    } finally { await r.d.idle(); await r.store.close(); }
  });

  test(`${backend.name}: an attempt that used compute, shut down and is stopped while its next advance pins the checkout, with the settle failing, keeps its own hold for the settle: the end's mark of what the advance may yet take never names it (card H12q review)`, async () => {
    const r = await rig({ budget: true, busy: async () => false });
    let d2: typeof r.d | undefined;
    try {
      assert.deepEqual((await r.d.tick()).started, [r.attemptId]);
      await r.d.gateway(r.attemptId).usage({ computeMs: 1000 });
      assert.equal((await r.d.shutdown()).closed, 1);
      const own = (await r.d.get(r.w.owner, r.attemptId))!.reservationId;
      assert.notEqual(own, undefined, "the attempt kept the hold that carries what it used");
      const local2 = await r.another();
      d2 = r.w.restart({ workers: [local2], workspaceBusy: async () => false });
      const budgets = r.w.budgets as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>; const realSettle = budgets["settle"]!.bind(budgets);
      let settleFails = 0;
      budgets["settle"] = async (...a: unknown[]) => { if (settleFails > 0) { settleFails--; throw new Error("the ledger did not answer"); } return realSettle(...a); };
      const res = r.w.resources as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>; const realPin = res["dispatchCheckout"]!.bind(res);
      let armed = true;
      res["dispatchCheckout"] = async (...a: unknown[]) => { if ((a[0] as { pin?: boolean }).pin === true && armed) { armed = false; settleFails = 1; await d2!.stop(r.w.owner, r.attemptId, { reason: "owner says stop" }); } return realPin(...a); };
      const tick = await d2.tick();
      assert.deepEqual(tick.failures, []);
      assert.deepEqual(tick.skipped.map((s) => s.reason), ["the attempt has ended"]);
      assert.deepEqual((await d2.tick()).failures, []);
      const body = (await d2.get(r.w.owner, r.attemptId))!;
      assert.equal(body.state, "finished");
      assert.equal(body.lateHeld, undefined);
      assert.deepEqual((await r.w.budgets.report(r.w.owner, r.taskId))!.reservations.map((h) => h.id), [own], "the hold that carries the 1000 ms used stays open for its settle");
      assert.equal(await places(r), 0, "the place the advance took was given back");
      await d2.idle();
    } finally { r.turn.end!(); await r.d.idle(); await d2?.idle(); await r.store.close(); }
  });

  test(`${backend.name}: a controller that dies just after any one storage write of a stop inside the advance (place and hold taken after the end) leaves nothing held once the next controller has run and the owner's stop is repeated (card H12q review)`, async () => {
    // Every write (records, admission, budget) goes through `applyOperation`; `after` runs once the write is committed and may throw to stand for the process dying there.
    const tapAfter = (storage: unknown, after: () => void): (() => void) => {
      const s = storage as { applyOperation: (input: never) => Promise<unknown> };
      const had = Object.prototype.hasOwnProperty.call(s, "applyOperation"); const orig = s.applyOperation;
      s.applyOperation = function (this: unknown, input: never) { return orig.call(s, input).then((out) => { after(); return out; }); };
      return () => { if (had) s.applyOperation = orig; else delete (s as Partial<typeof s>).applyOperation; };
    };
    const run = async (dieAt: number): Promise<number> => {
      let first = true;
      const r = await rig({ budget: true, busy: async () => { if (first) { first = false; await r.d.stop(r.w.owner, r.attemptId, { reason: "owner says stop" }); } return false; } });
      let writes = 0, dead = false;
      const put = tapAfter(r.w.storage, () => { writes++; if (writes === dieAt) { dead = true; throw new Error("the process died after this write"); } if (dead) throw new Error("the process is gone"); });
      try {
        await r.d.tick().catch(() => undefined);
        await r.d.idle().catch(() => undefined);
        put();
        if (dieAt === 0) return writes;
        // The next controller over the same records; the owner repeats a stop that did not finish.
        const d2 = r.w.restart({ workers: [r.local], workspaceBusy: async () => false });
        // Died before the attempt was claimed: the next controller claims it (and may start it) and the owner's stop ends it.
        if ((await d2.get(r.w.owner, r.attemptId)) === undefined) await d2.tick();
        if ((await d2.get(r.w.owner, r.attemptId))!.state !== "finished") await d2.stop(r.w.owner, r.attemptId, { reason: "owner says stop" });
        for (let i = 0; i < 2; i++) assert.deepEqual((await d2.tick()).failures, [], `write ${dieAt}: the next controller's ticks do not fail`);
        const body = (await d2.get(r.w.owner, r.attemptId))!;
        assert.equal(body.state, "finished", `write ${dieAt}`);
        assert.equal(body.lateHeld, undefined, `write ${dieAt}: nothing is left marked`);
        assert.equal(await places(r), 0, `write ${dieAt}: no place is held`);
        assert.equal((await holds(r)).open, 0, `write ${dieAt}: no hold is open`);
        await d2.idle();
        return writes;
      } finally { put(); r.turn.end!(); await r.store.close(); }
    };
    const total = await run(0);
    assert.ok(total > 5, `the clean run made ${total} writes`);
    const bad: string[] = [];
    for (let at = 1; at <= total; at++) await run(at).catch((e: unknown) => { bad.push(e instanceof Error ? e.message.split("\n")[0]! : String(e)); });
    assert.deepEqual(bad, [], `of ${total} writes`);
  });

  test(`${backend.name}: a queued attempt that is then frozen gives back its queued place at the next tick (card H12q review)`, async () => {
    const r = await rig({ busy: async () => false });
    try {
      // Another request takes the host's whole capacity, so the attempt's request queues.
      await r.w.admission.request({ commandId: "fill", actor: r.w.owner.id, class: "productive", host: "host:local", cpus: 4, memoryMb: 8192 });
      assert.ok((await r.d.tick()).waiting.includes(r.attemptId));
      const queued = (await r.d.get(r.w.owner, r.attemptId))!.requestId!;
      assert.equal((await r.w.admission.where(queued)).state, "waiting");
      await r.d.freeze(r.w.owner, r.attemptId, "owner hold");
      assert.ok((await r.d.tick()).waiting.includes(r.attemptId));
      assert.equal((await r.d.get(r.w.owner, r.attemptId))!.requestId, undefined);
      const where = (await r.w.admission.where(queued)).state;
      assert.ok(where !== "running" && where !== "waiting", `the queued place was given back (${where})`);
    } finally { await r.d.idle(); await r.store.close(); }
  });

  test(`${backend.name}: an attempt shut down with nothing used and then frozen gives back the hold it kept at the next tick (card H12q review)`, async () => {
    const r = await rig({ budget: true, busy: async () => false });
    let d2: typeof r.d | undefined;
    try {
      assert.deepEqual((await r.d.tick()).started, [r.attemptId]);
      assert.equal((await r.d.shutdown()).closed, 1);
      assert.equal((await holds(r)).open, 1, "the attempt keeps its hold over the shutdown");
      await r.d.freeze(r.w.owner, r.attemptId, "owner hold");
      d2 = r.w.restart({ workers: [await r.another()], workspaceBusy: async () => false });
      assert.ok((await d2.tick()).waiting.includes(r.attemptId));
      const after = await holds(r);
      assert.equal(after.open, 0, "the hold was given back");
      assert.equal(after.reservationId, undefined);
    } finally { r.turn.end!(); await r.d.idle(); await d2?.idle(); await r.store.close(); }
  });

  test(`${backend.name}: a Stop through the real stop service and ports, asked while a worker is still coming up, ends "stopped" without waiting out the checkpoint's wait; the worker is stopped once it is up (card H12q review)`, async () => {
    let letUp!: () => void; const up = new Promise<void>((ok) => { letUp = ok; });
    let opening!: () => void; const inOpening = new Promise<void>((ok) => { opening = ok; });
    const r = await rig({ budget: true, busy: async () => false, opening: async () => { opening(); await up; } });
    try {
      const ports = dispatchStopPorts(() => ({ dispatcher: r.d, principal: r.w.owner }));
      const stops = StopService.withEpoch(r.w.storage, r.w.epoch, r.w.pauses, ports, r.w.options);
      const tick = r.d.tick();
      await inOpening;
      const t0 = Date.now();
      const { intentId } = await stops.request(r.w.owner, { commandId: "stop-1", scope: { kind: "task", id: r.taskId }, mode: "stop", reason: "owner says stop" });
      const done = await stops.advance(r.w.owner, { intentId });
      assert.deepEqual([done.phase, done.outcome?.state], ["done", "stopped"], `the Stop is not blocked (${JSON.stringify(done.blocked ?? done.history?.at(-1))})`);
      assert.ok(Date.now() - t0 < 5_000, `the checkpoint step waited no longer than the request's deadline (${Date.now() - t0} ms)`);
      letUp();
      await tick;
      await r.d.idle();
      assert.equal((await r.d.get(r.w.owner, r.attemptId))!.state, "finished");
      assert.deepEqual(r.log, ["worker:opening", "worker:up"], "the worker that came up was let go and never ran");
      assert.equal((await holds(r)).open, 0);
    } finally { letUp(); await r.d.idle(); await r.store.close(); }
  });
}
