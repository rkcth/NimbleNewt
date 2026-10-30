import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { LocalWorker, type BoundCall } from "../dispatch/local-worker.js";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import type { Principal } from "../security/principals.js";
import { WorkspaceOpService, type WorkspaceCall, type WorkspaceOutcome, type WorkspacePort } from "./index.js";
import { QuiesceCoordinator } from "../dispatch/quiesce.js";
import { buildWorld, workGrants } from "../dispatch/testing/world.js";

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
  const service = (r: { w: Awaited<ReturnType<typeof buildWorld>>; coordinator: QuiesceCoordinator }, port: WorkspacePort | undefined) =>
    WorkspaceOpService.withEpoch(r.w.storage, r.w.epoch, { quiesce: r.coordinator, portOf: async () => port }, { clock: r.w.clock.now });
  const manager = async (w: Awaited<ReturnType<typeof buildWorld>>, name: string, grants: { action: string; project: string }[]): Promise<Principal> => {
    await w.principals.enroll(w.owner, { commandId: `en-${name}`, kind: "agent", name, grants });
    return w.principals.authenticate((await w.principals.issueCredential(w.owner, `agent:${name}`)).token);
  };
  const refuses = async (code: string, run: () => Promise<unknown>) => assert.rejects(run, (e: unknown) => { assert.ok(e instanceof DomainError, String(e)); assert.equal(e.code, code, e.message); return true; });

  test(`${backend.name}: the host is asked only while the attempt is quiet (frozen, nothing in flight, checkpointed), and the attempt goes on afterwards (card H12d)`, async () => {
    const r = await rig(async () => ({}));
    try {
      const seen: { call: WorkspaceCall; frozen: boolean; inFlight: number }[] = [];
      let release!: () => void;
      const later = new Promise<void>((ok) => { release = ok; });
      let secondState = "";
      r.turn.second = async () => { await later; secondState = (await r.turn.call!({ callId: "c2", tool: { name: "read-file", version: "1" }, args: {} }, { kind: "local", run: async () => ({ text: "later" }) })).state; return secondState; };
      await r.d.tick();
      await r.inCall;
      const host: WorkspacePort = { run: async (call) => {
        const a = (await r.d.get(r.w.owner, r.attemptId))!;
        seen.push({ call, frozen: a.frozen !== undefined, inFlight: a.inFlight.length });
        return { ok: true, summary: "refreshed", detail: { files: 3 } };
      } };
      const answer = await service(r, host).request(r.w.owner, { commandId: "ws1", operation: "refresh", taskId: r.taskId, reason: "the base moved" });
      release();
      assert.deepEqual([answer.state, answer.summary, answer.detail, answer.quietAttempts], ["done", "refreshed", { files: 3 }, [r.attemptId]]);
      assert.deepEqual(seen.map((s) => [s.frozen, s.inFlight, s.call.quietAttempts.length, s.call.operation, s.call.taskId]), [[true, 0, 1, "refresh", r.taskId]], "the call in flight settled before the host was asked");
      assert.equal((await r.d.get(r.w.owner, r.attemptId))!.frozen, undefined, "the attempt is released");
      await r.d.idle();
      assert.equal(secondState, "confirmed", "the attempt went on");
      assert.ok(r.checkpoints() >= 1, "a checkpoint was taken");
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: an attempt that cannot be made quiet blocks the operation: the host is not asked, a typed blocker is named, nothing stays frozen (card H12d)`, async () => {
    const r = await rig(async () => { throw new Error("the checkpoint could not be taken"); });
    try {
      r.turn.second = async () => "x";
      await r.d.tick();
      await r.inCall;
      let asked = 0;
      const answer = await service(r, { run: async () => { asked++; return { ok: true, summary: "x" }; } }).request(r.w.owner, { commandId: "ws2", operation: "quarantine", taskId: r.taskId, reason: "suspicious file" });
      assert.equal(asked, 0);
      assert.equal(answer.state, "refused");
      assert.match(answer.summary!, /quarantine did not run.*checkpoint could not be taken/);
      assert.ok(answer.blocker !== undefined && (await r.w.blockers.openFor("runtime_hold", { kind: "task", id: r.taskId })) !== undefined, "the owner sees why");
      assert.equal((await r.d.get(r.w.owner, r.attemptId))!.frozen, undefined);
      r.turn.release?.();
      await r.d.idle();
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: an attempt that cannot be made quiet also blocks the release of reviewed work (the A06 release path): the host is not asked and nothing stays frozen (card H12d)`, async () => {
    const r = await rig(async () => { throw new Error("the checkpoint could not be taken"); });
    try {
      r.turn.second = async () => "x";
      await r.d.tick();
      await r.inCall;
      let asked = 0;
      const answer = await service(r, { run: async () => { asked++; return { ok: true, summary: "x" }; } }).request(r.w.owner, { commandId: "ws2r", operation: "release", taskId: r.taskId, reason: "commit the reviewed tree" });
      assert.equal(asked, 0);
      assert.equal(answer.state, "refused");
      assert.match(answer.summary!, /release did not run.*checkpoint could not be taken/);
      assert.ok(answer.blocker !== undefined && (await r.w.blockers.openFor("runtime_hold", { kind: "task", id: r.taskId })) !== undefined, "the owner sees why");
      assert.equal((await r.d.get(r.w.owner, r.attemptId))!.frozen, undefined);
      r.turn.release?.();
      await r.d.idle();
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: who may ask, what is checked, and what is recorded (card H12l)`, async () => {
    const r = await rig(async () => ({}));
    try {
      const calls: WorkspaceCall[] = [];
      const svc = service(r, { run: async (c) => { calls.push(c); return { ok: true, summary: "integrated 2 files" }; } });
      const ask = (by: Principal, extra: Record<string, unknown> = {}, commandId = "w-a") => svc.request(by, { commandId, operation: "integration", taskId: r.taskId, reason: "ready", ...extra } as never);
      const nobody = await manager(r.w, "nobody", [{ action: "task.read", project: r.w.project }]);
      const boss = await manager(r.w, "boss", [{ action: "workspace.manage", project: r.w.project }]);
      const other = (await r.w.projects.createProject({ commandId: "other-project", actor: r.w.owner.id, name: "Other" })).id;
      const elsewhere = await manager(r.w, "elsewhere", [{ action: "workspace.manage", project: other }]);
      await refuses("not_found", () => ask(nobody, {}, "w-n"));
      await refuses("not_found", () => ask(elsewhere, {}, "w-e"));
      await refuses("not_found", () => ask(boss, { taskId: derivedId("task", "no-such-task") }, "w-m"));
      await refuses("invalid_command", () => ask(boss, { operation: "landing" }, "w-o"));
      await refuses("invalid_command", () => ask(boss, { reason: "token sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD" }, "w-r"));
      await refuses("invalid_command", () => ask(boss, { extra: 1 }, "w-x"));
      assert.equal(calls.length, 0, "nothing ran for a refused caller or a malformed request");
      // A task credential never manages the workspace, even with the grant.
      const scoped = { ...boss, taskScope: { taskId: r.taskId, projectId: r.w.project } } as Principal;
      await refuses("not_found", () => ask(scoped, {}, "w-s"));
      const first = await ask(boss);
      assert.deepEqual([first.state, first.requestedBy, first.operation, first.replayed], ["done", boss.id, "integration", false]);
      const again = await ask(boss);
      assert.deepEqual([again.id, again.state, again.replayed], [first.id, "done", true]);
      assert.equal(calls.length, 1, "a repeat of the command asks the host once");
      assert.equal((await svc.get(boss, first.id))!.summary, "integrated 2 files");
      assert.equal(await svc.get(nobody, first.id), undefined, "someone who could not ask cannot read it");
      assert.equal((await ask(r.w.owner, {}, "w-owner")).state, "done");
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: no host, a refusing host, a failing host, and a repeat while the host works are answered and recorded (card H12l)`, async () => {
    const r = await rig(async () => ({}));
    try {
      const o = r.w.owner;
      const none = await service(r, undefined).request(o, { commandId: "h1", operation: "refresh", taskId: r.taskId, reason: "base moved" });
      assert.deepEqual([none.state, /no host that can do this/.test(none.summary ?? "")], ["refused", true]);
      const said: WorkspaceOutcome = { ok: false, reason: "the checkout has uncommitted changes" };
      const no = await service(r, { run: async () => said }).request(o, { commandId: "h2", operation: "refresh", taskId: r.taskId, reason: "base moved" });
      assert.deepEqual([no.state, /uncommitted/.test(no.summary ?? "")], ["refused", true]);
      const broke = await service(r, { run: async () => { throw new Error("the host went away"); } }).request(o, { commandId: "h3", operation: "integration", taskId: r.taskId, reason: "merge" });
      assert.deepEqual([broke.state, /went away/.test(broke.summary ?? "")], ["failed", true]);
      // The same command again while the host is still working: it may have acted, so the repeat is `uncertain`, the host is not asked twice, and the record stands.
      let finish!: () => void;
      const hold = new Promise<void>((ok) => { finish = ok; });
      let asked = 0;
      const slow = service(r, { run: async () => { asked++; await hold; return { ok: true, summary: "done late" }; } });
      const first = slow.request(o, { commandId: "h4", operation: "quarantine", taskId: r.taskId, reason: "bad file" });
      while (asked === 0) await new Promise((ok) => setTimeout(ok, 5));
      const repeat = await slow.request(o, { commandId: "h4", operation: "quarantine", taskId: r.taskId, reason: "bad file" });
      assert.deepEqual([repeat.state, repeat.replayed], ["uncertain", true]);
      finish();
      const late = await first;
      assert.deepEqual([late.state, late.summary, late.id], ["done", "done late", repeat.id], "the first call writes what really happened over the repeat's uncertain");
      assert.equal(asked, 1);
      assert.equal((await slow.request(o, { commandId: "h4", operation: "quarantine", taskId: r.taskId, reason: "bad file" })).state, "done", "and a later repeat is told the real outcome");
      // Another command is a new request.
      assert.equal((await slow.request(o, { commandId: "h5", operation: "quarantine", taskId: r.taskId, reason: "bad file" }).then((a) => a.state)), "done");
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: one operation runs per task at a time, and a host's text and detail are bounded and redacted (card H12l)`, async () => {
    const r = await rig(async () => ({}));
    try {
      const o = r.w.owner;
      let finish!: () => void;
      const hold = new Promise<void>((ok) => { finish = ok; });
      let asked = 0;
      const svc = service(r, { run: async () => { asked++; await hold; return { ok: true, summary: "ok" }; } });
      const first = svc.request(o, { commandId: "c1", operation: "refresh", taskId: r.taskId, reason: "base moved" });
      while (asked === 0) await new Promise((ok) => setTimeout(ok, 5));
      await refuses("unavailable", () => svc.request(o, { commandId: "c2", operation: "integration", taskId: r.taskId, reason: "merge" }));
      finish();
      assert.equal((await first).state, "done");
      assert.equal((await svc.request(o, { commandId: "c3", operation: "integration", taskId: r.taskId, reason: "merge" }).then((a) => a.state)), "done", "after the first ended another may run");
      const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD";
      const leaky = service(r, { run: async () => ({ ok: true, summary: `fatal: could not read from https://x-access-token:${secret}@github.com/x`, detail: { note: `token ${secret}` } }) });
      const a = await leaky.request(o, { commandId: "c4", operation: "refresh", taskId: r.taskId, reason: "base moved" });
      assert.equal(a.state, "done");
      assert.ok(!JSON.stringify(a).includes(secret), JSON.stringify(a));
      assert.equal(a.detail, undefined, "a detail with a credential in it is dropped");
      const huge = service(r, { run: async () => ({ ok: true, summary: "x".repeat(5000), detail: { blob: "y".repeat(10_000) } }) });
      const b = await huge.request(o, { commandId: "c5", operation: "refresh", taskId: r.taskId, reason: "base moved" });
      assert.deepEqual([b.state, b.summary!.length, b.detail], ["done", 1000, undefined], "text is cut and an oversized detail is dropped; the outcome is still recorded");
      const odd = service(r, { run: async () => ({ ok: true, summary: 5 as never }) });
      assert.equal((await odd.request(o, { commandId: "c6", operation: "refresh", taskId: r.taskId, reason: "base moved" })).state, "done");
    } finally { await r.store.close(); }
  });

  const control = (r: Awaited<ReturnType<typeof rig>>) => ({ live: (taskId: string) => r.d.liveAttemptsOf(r.w.owner, { taskId }), frozenReason: async (id: string) => (await r.d.get(r.w.owner, id))?.frozen?.reason, release: async (id: string) => { await r.d.release(r.w.owner, id); } });
  const records = async (r: Awaited<ReturnType<typeof rig>>) => (await r.w.storage.listAggregates("workspace-request", { limit: 10 })).map((a) => ({ id: a.id, ...(a.body as unknown as { state: string; held?: string[] }) }));
  const keepAlive = (r: Awaited<ReturnType<typeof rig>>) => { let stay!: () => void; const alive = new Promise<void>((ok) => { stay = ok; }); r.turn.second = async () => { await alive; return "x"; }; return stay; };

  test(`${backend.name}: a release that was running when the controller stopped is recovered like the others: its freeze is lifted (card H12d)`, async () => {
    const r = await rig(async () => ({}));
    try {
      const stay = keepAlive(r);
      await r.d.tick();
      await r.inCall;
      let finish!: () => void;
      const hold = new Promise<void>((ok) => { finish = ok; });
      let asked = 0;
      const port: WorkspacePort = { run: async () => { asked++; await hold; return { ok: true, summary: "late" }; } };
      const make = () => WorkspaceOpService.withEpoch(r.w.storage, r.w.epoch, { quiesce: r.coordinator, portOf: async () => port, attempts: control(r) }, { clock: r.w.clock.now });
      const pending = make().request(r.w.owner, { commandId: "rel1", operation: "release", taskId: r.taskId, reason: "free the slot" });
      while (asked === 0) await new Promise((ok) => setTimeout(ok, 5));
      assert.ok((await r.d.get(r.w.owner, r.attemptId))!.frozen !== undefined, "the attempt is frozen while the release runs");
      const [only] = await records(r);
      assert.deepEqual(await make().recover(r.w.owner), [only!.id]);
      assert.equal((await r.d.get(r.w.owner, r.attemptId))!.frozen, undefined, "the freeze left by a release was lifted");
      finish();
      await pending;
      await r.d.release(r.w.owner, r.attemptId);
      stay();
      await r.d.idle();
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: a controller that stopped while the host worked leaves the request uncertain, the attempt it froze is released, and the freeze of anything else is not (card H12l)`, async () => {
    const r = await rig(async () => ({}));
    try {
      const stay = keepAlive(r);
      await r.d.tick();
      await r.inCall;
      let finish!: () => void;
      const hold = new Promise<void>((ok) => { finish = ok; });
      let asked = 0;
      const port: WorkspacePort = { run: async () => { asked++; await hold; return { ok: true, summary: "late" }; } };
      const make = () => WorkspaceOpService.withEpoch(r.w.storage, r.w.epoch, { quiesce: r.coordinator, portOf: async () => port, attempts: control(r) }, { clock: r.w.clock.now });
      const pending = make().request(r.w.owner, { commandId: "k1", operation: "integration", taskId: r.taskId, reason: "merge" });
      while (asked === 0) await new Promise((ok) => setTimeout(ok, 5));
      const frozen = (await r.d.get(r.w.owner, r.attemptId))!.frozen;
      assert.ok(frozen !== undefined && frozen.reason.endsWith(`(${(await records(r))[0]!.id})`), "the freeze names the request");
      // A new controller process over the same records: it resolves the open request and lifts that freeze.
      const after = make();
      const [only] = await records(r);
      assert.deepEqual(await after.recover(r.w.owner), [only!.id]);
      assert.equal((await r.d.get(r.w.owner, r.attemptId))!.frozen, undefined, "the freeze was lifted");
      assert.equal((await records(r))[0]!.state, "uncertain");
      assert.deepEqual(await after.recover(r.w.owner), [], "and it is resolved once");
      finish();
      await pending;
      // Somebody else's freeze on the attempt of a request that is still open is not lifted by a recovery.
      const open = make();
      let hold2!: () => void;
      const gate = new Promise<void>((ok) => { hold2 = ok; });
      let asked2 = 0;
      const second = WorkspaceOpService.withEpoch(r.w.storage, r.w.epoch, { quiesce: r.coordinator, portOf: async () => ({ run: async () => { asked2++; await gate; return { ok: true, summary: "x" }; } }), attempts: control(r) }, { clock: r.w.clock.now });
      const running = second.request(r.w.owner, { commandId: "k2", operation: "refresh", taskId: r.taskId, reason: "base moved" });
      while (asked2 === 0) await new Promise((ok) => setTimeout(ok, 5));
      // The process that is running it neither recovers it nor lifts its freeze for a repeat of the command.
      assert.deepEqual(await second.recover(r.w.owner), []);
      const repeat = await second.request(r.w.owner, { commandId: "k2", operation: "refresh", taskId: r.taskId, reason: "base moved" });
      assert.deepEqual([repeat.state, repeat.replayed], ["uncertain", true]);
      assert.ok((await r.d.get(r.w.owner, r.attemptId))!.frozen !== undefined, "the first call still holds its freeze");
      assert.deepEqual(await second.recover(r.w.owner), [], "marking it uncertain did not make it recoverable here");
      await r.d.release(r.w.owner, r.attemptId);
      await r.d.freeze(r.w.owner, r.attemptId, "the owner stopped it");
      // After a restart the open index still names the request (the repeat did not clear it), so it is found and resolved.
      const openId = (await records(r)).find((x) => x.id !== only!.id)!.id;
      assert.deepEqual(await open.recover(r.w.owner), [openId]);
      assert.equal((await r.d.get(r.w.owner, r.attemptId))!.frozen?.reason, "the owner stopped it", "a freeze that is not the request's stays");
      hold2();
      await running;
      await r.d.release(r.w.owner, r.attemptId);
      stay();
      await r.d.idle();
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: a stop while the attempt is still being made quiet (the host not yet asked) leaves the freeze findable and released, and a new request resolves what was left before it freezes (card H12l)`, async () => {
    let gate!: () => void;
    const wait = new Promise<void>((ok) => { gate = ok; });
    let entered = 0;
    const r = await rig(async () => { entered++; if (entered === 1) await wait; return {}; });
    try {
      const stay = keepAlive(r);
      await r.d.tick();
      await r.inCall;
      let asked = 0;
      const port: WorkspacePort = { run: async () => { asked++; return { ok: true, summary: "x" }; } };
      const make = () => WorkspaceOpService.withEpoch(r.w.storage, r.w.epoch, { quiesce: r.coordinator, portOf: async () => port, attempts: control(r) }, { clock: r.w.clock.now });
      const first = make().request(r.w.owner, { commandId: "q1", operation: "integration", taskId: r.taskId, reason: "merge" });
      while (entered === 0) await new Promise((ok) => setTimeout(ok, 5));
      const [rec] = await records(r);
      assert.deepEqual([rec!.state, rec!.held], ["started", [r.attemptId]], "the attempt it may freeze is recorded before the quiesce");
      assert.ok((await r.d.get(r.w.owner, r.attemptId))!.frozen !== undefined);
      // The next controller: a new request on the task resolves the leftover (lifting its freeze) before it does anything of its own.
      const next = await make().request(r.w.owner, { commandId: "q2", operation: "refresh", taskId: r.taskId, reason: "base moved" });
      assert.equal((await records(r)).find((x) => x.id === rec!.id)!.state, "uncertain");
      gate();
      const answered = await first;
      assert.equal(asked >= 1, true);
      assert.ok(["done", "uncertain"].includes(answered.state), answered.state);
      assert.ok(["done", "refused", "failed"].includes(next.state), next.state);
      assert.equal((await r.d.get(r.w.owner, r.attemptId))!.frozen, undefined, "nothing stays frozen");
      stay();
      await r.d.idle();
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: an attempt that started after the record's list was read is still released by recovery (card H12l)`, async () => {
    const r = await rig(async () => ({}));
    try {
      const stay = keepAlive(r);
      await r.d.tick();
      await r.inCall;
      let asked = 0;
      let finish!: () => void;
      const hold = new Promise<void>((ok) => { finish = ok; });
      const blind = { ...control(r), live: async (taskId: string) => (asked === 0 ? [] : control(r).live(taskId)) };
      const port: WorkspacePort = { run: async () => { asked++; await hold; return { ok: true, summary: "x" }; } };
      const make = () => WorkspaceOpService.withEpoch(r.w.storage, r.w.epoch, { quiesce: r.coordinator, portOf: async () => port, attempts: blind }, { clock: r.w.clock.now });
      const pending = make().request(r.w.owner, { commandId: "z1", operation: "integration", taskId: r.taskId, reason: "merge" });
      while (asked === 0) await new Promise((ok) => setTimeout(ok, 5));
      assert.deepEqual((await records(r))[0]!.held ?? [], [], "the list read before did not have it");
      assert.equal((await make().recover(r.w.owner)).length, 1);
      assert.equal((await r.d.get(r.w.owner, r.attemptId))!.frozen, undefined);
      finish();
      await pending;
      stay();
      await r.d.idle();
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: a call that ignores the stop signal is not taken as settled: the host is not asked (card H12d)`, async () => {
    const r = await rig(async () => ({}), true);
    try {
      r.turn.second = async () => "x";
      await r.d.tick();
      await r.inCall;
      let asked = 0;
      const quick = WorkspaceOpService.withEpoch(r.w.storage, r.w.epoch, { quiesce: new QuiesceCoordinator({ dispatcher: r.d, blockers: r.w.blockers, principal: r.w.owner, settleMs: 100 }), portOf: async () => ({ run: async () => { asked++; return { ok: true, summary: "x" }; } }) }, { clock: r.w.clock.now });
      const answer = await quick.request(r.w.owner, { commandId: "s1", operation: "integration", taskId: r.taskId, reason: "merge" });
      assert.equal(asked, 0);
      assert.equal(answer.state, "refused");
      assert.ok(answer.blocker !== undefined);
      assert.equal((await r.d.get(r.w.owner, r.attemptId))!.frozen, undefined, "nothing stays frozen");
      r.turn.release?.();
      await r.d.idle();
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: a wildcard grant does not manage workspaces (card H12l)`, async () => {
    const r = await rig(async () => ({}));
    try {
      const wild = await manager(r.w, "wild", [{ action: "*", project: r.w.project }]);
      const svc = service(r, { run: async () => ({ ok: true, summary: "x" }) });
      await refuses("not_found", () => svc.request(wild, { commandId: "wd1", operation: "refresh", taskId: r.taskId, reason: "x" }));
    } finally { await r.store.close(); }
  });
}
