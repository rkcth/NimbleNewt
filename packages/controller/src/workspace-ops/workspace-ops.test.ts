import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { LocalWorker, type BoundCall } from "../dispatch/local-worker.js";
import { TERMINAL } from "../dispatch/model.js";
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
      await refuses("invalid_command", () => ask(boss, { operation: "release" }, "w-o"));
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
      assert.deepEqual([none.state, /no host holds/.test(none.summary ?? "")], ["refused", true]);
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
      assert.deepEqual([late.state, late.id], ["uncertain", repeat.id], "the first caller is told what the record says");
      assert.equal(asked, 1);
      assert.equal((await slow.request(o, { commandId: "h4", operation: "quarantine", taskId: r.taskId, reason: "bad file" })).state, "uncertain", "and it stays so");
      // Another command is a new request.
      assert.equal((await slow.request(o, { commandId: "h5", operation: "quarantine", taskId: r.taskId, reason: "bad file" }).then((a) => a.state)), "done");
      assert.ok(TERMINAL.size > 0);
    } finally { await r.store.close(); }
  });
}
