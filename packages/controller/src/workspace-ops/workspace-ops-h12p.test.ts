import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { DomainError } from "../domain/errors.js";
import type { Principal } from "../security/principals.js";
import { WorkspaceOpService, type WorkspaceCall, type WorkspaceOutcome, type WorkspacePort } from "./index.js";
import { buildWorld } from "../dispatch/testing/world.js";

after(stopServer);

// Card H12p: the author's own refresh (`reapply`) as a controller operation: only the live attempt's own agent asks, there is no quiesce, the request is recorded, a repeat of the call returns the
// recorded answer, one operation runs per task at a time, and a refresh that moved the checkout is one round counted with the record.
for (const backend of backends) {
  const rig = async (opts: { live?: boolean; stopped?: boolean; frozen?: string; paused?: boolean; port?: (call: WorkspaceCall) => Promise<WorkspaceOutcome> } = {}) => {
    const store = await backend.open();
    const w = await buildWorld(store.storage);
    const ann = await w.agent("ann");
    const bob = await w.agent("bob");
    const { taskId } = await w.task("t", ann);
    const other = (await w.task("t2", bob)).taskId;
    const state = { live: opts.live ?? true, stopped: opts.stopped ?? false, frozen: opts.frozen as string | undefined, asked: [] as WorkspaceCall[], quiesced: 0 };
    const attempts = new Map<string, { taskId: string; agentId: string }>([["att-ann", { taskId, agentId: ann.id }], ["att-ann-2", { taskId, agentId: ann.id }], ["att-bob", { taskId: other, agentId: bob.id }]]);
    const port: WorkspacePort = { run: async (call) => { state.asked.push(call); return opts.port === undefined ? { ok: true, summary: "moved", detail: { changed: true, base: "b".repeat(40), kept: 1, taken: 1, merged: 0, conflictCount: 0, conflicts: [] } } : opts.port(call); } };
    const svc = WorkspaceOpService.withEpoch(w.storage, w.epoch, {
      quiesce: { around: async () => { state.quiesced++; throw new Error("a reapply must not be quiesced"); } },
      portOf: async () => port,
      attemptOf: async (id) => { const a = attempts.get(id); return a === undefined ? undefined : { ...a, live: state.live, stopped: state.stopped }; },
      attempts: { live: async () => [], frozenReason: async () => state.frozen, release: async () => undefined },
      paused: async (t) => opts.paused === true && t === taskId,
    }, { clock: w.clock.now });
    const as = (agent: { id: string; aid: string }, scope?: string, projectId = w.project): Principal => ({ id: agent.id, kind: "agent", name: agent.aid, grants: [], ...(scope === undefined ? {} : { taskScope: { taskId: scope, projectId } }) }) as unknown as Principal;
    // A second controller over the same storage (as after a restart): its own in-memory state, the same records.
    const restarted = (run: (call: WorkspaceCall) => Promise<WorkspaceOutcome>) => WorkspaceOpService.withEpoch(w.storage, w.epoch, {
      quiesce: { around: async () => { throw new Error("a reapply must not be quiesced"); } },
      portOf: async () => ({ run }),
      attemptOf: async (id) => { const a = attempts.get(id); return a === undefined ? undefined : { ...a, live: true }; },
      attempts: { live: async () => [], frozenReason: async () => undefined, release: async () => undefined },
    }, { clock: w.clock.now });
    return { store, w, ann, bob, taskId, other, svc, state, as, restarted };
  };
  const refuses = async (code: string, run: () => Promise<unknown>) => assert.rejects(run, (e: unknown) => { assert.ok(e instanceof DomainError, String(e)); assert.equal(e.code, code, e.message); return true; });

  test(`${backend.name}: the attempt's own agent refreshes without a quiesce; the request is recorded with the host's lists, and the first moving refresh is round 1 (card H12p)`, async () => {
    const r = await rig();
    try {
      assert.equal(await r.svc.refreshRounds(r.taskId), 0);
      const a = await r.svc.reapply(r.as(r.ann, r.taskId), { commandId: "ra-1", attemptId: "att-ann" });
      assert.deepEqual([a.state, a.operation, a.summary, a.round, a.replayed], ["done", "reapply", "moved", 1, false]);
      assert.deepEqual(a.detail, { changed: true, base: "b".repeat(40), kept: 1, taken: 1, merged: 0, conflictCount: 0, conflicts: [] });
      assert.equal(r.state.quiesced, 0, "no quiesce");
      assert.deepEqual(r.state.asked.map((c) => [c.operation, c.taskId, c.quietAttempts.length]), [["reapply", r.taskId, 0]]);
      assert.equal(await r.svc.refreshRounds(r.taskId), 1);
      const read = await r.svc.get(r.w.owner, a.id);
      assert.deepEqual([read?.operation, read?.state, read?.round, read?.requestedBy], ["reapply", "done", 1, r.ann.id], "readable by the owner in the workspace record");
      assert.equal(await r.svc.openFor(r.taskId), undefined, "nothing is left open");
      // A second moving refresh is round 2.
      const b = await r.svc.reapply(r.as(r.ann, r.taskId), { commandId: "ra-2", attemptId: "att-ann" });
      assert.equal(b.round, 2);
      assert.equal(await r.svc.refreshRounds(r.taskId), 2);
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: asking again with the same command returns the recorded answer, asks the host once and counts the round once (card H12p)`, async () => {
    const r = await rig();
    try {
      const me = r.as(r.ann, r.taskId);
      const first = await r.svc.reapply(me, { commandId: "ra-same", attemptId: "att-ann" });
      const again = await r.svc.reapply(me, { commandId: "ra-same", attemptId: "att-ann" });
      assert.deepEqual([again.id, again.state, again.round, again.replayed], [first.id, "done", 1, true]);
      assert.equal(r.state.asked.length, 1);
      assert.equal(await r.svc.refreshRounds(r.taskId), 1);
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: a refresh at the head already, a refusal and a failure are recorded but are not rounds; conflicts stay listed and a key-like path is withheld alone (card H12p)`, async () => {
    const plan: WorkspaceOutcome[] = [
      { ok: true, summary: "already", detail: { changed: false, base: "b".repeat(40) } },
      { ok: false, reason: "the shared workspace's head could not be read" },
      { ok: true, summary: "conflicts", detail: { changed: true, base: "c".repeat(40), kept: 0, taken: 0, merged: 0, conflictCount: 2, conflicts: [{ path: "src/a.ts", kind: "overlap" }, { path: "keys/sk-" + "a1b2c3d4".repeat(5) + ".txt", kind: "overlap" }] } },
    ];
    let i = 0;
    const r = await rig({ port: async () => { if (i === 3) throw new Error("the host went away"); return plan[i++]!; } });
    try {
      const me = r.as(r.ann, r.taskId);
      const a = await r.svc.reapply(me, { commandId: "p-1", attemptId: "att-ann" });
      const b = await r.svc.reapply(me, { commandId: "p-2", attemptId: "att-ann" });
      assert.deepEqual([a.state, a.round, b.state, b.round], ["done", undefined, "refused", undefined]);
      assert.match(b.summary!, /the host did not do it/);
      const c = await r.svc.reapply(me, { commandId: "p-3", attemptId: "att-ann" });
      assert.equal(c.round, 1);
      const paths = ((c.detail as { conflicts: { path: string }[] }).conflicts).map((x) => x.path);
      assert.equal(paths[0], "src/a.ts");
      assert.match(paths[1]!, /^\(a name that looks like a key/, "the detail was kept and only that name was withheld");
      const d = await r.svc.reapply(me, { commandId: "p-4", attemptId: "att-ann" });
      assert.deepEqual([d.state, d.round], ["failed", undefined]);
      assert.equal(await r.svc.refreshRounds(r.taskId), 1, "only the moving refresh counts");
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: only the live attempt's own agent may ask: another agent, another task's credential, an owner, an ended or stopped attempt and a held attempt are refused before the host is asked (card H12p)`, async () => {
    const r = await rig();
    try {
      await refuses("not_found", () => r.svc.reapply(r.as(r.bob, r.other), { commandId: "x-1", attemptId: "att-ann" }));
      await refuses("not_found", () => r.svc.reapply(r.as(r.ann, r.other), { commandId: "x-2", attemptId: "att-ann" }));
      await refuses("not_found", () => r.svc.reapply(r.as(r.ann), { commandId: "x-3", attemptId: "att-nope" }));
      await refuses("forbidden", () => r.svc.reapply(r.w.owner, { commandId: "x-4", attemptId: "att-ann" }));
      await refuses("invalid_command", () => r.svc.request(r.w.owner, { commandId: "x-4r", operation: "reapply", taskId: r.taskId, reason: "refresh it" }));
      await refuses("invalid_command", () => r.svc.reapply(r.as(r.ann, r.taskId), { commandId: "x-5", attemptId: "att-ann", extra: 1 } as never));
      // H12p review: another agent with its full (not task) credential, a viewer (any principal that is not an agent), and a key-like attempt ID, which is never shown back.
      await refuses("not_found", () => r.svc.reapply(r.as(r.bob), { commandId: "x-6", attemptId: "att-ann" }));
      await refuses("forbidden", () => r.svc.reapply({ ...r.w.owner, id: "client:viewer", kind: "client", grants: [] } as unknown as Principal, { commandId: "x-7", attemptId: "att-ann" }));
      const key = "sk-" + "Zq9".repeat(12);
      await assert.rejects(() => r.svc.reapply(r.as(r.ann, r.taskId), { commandId: "x-8", attemptId: key }), (e: unknown) => { assert.ok(e instanceof DomainError); assert.equal(e.code, "not_found"); assert.ok(!e.message.includes(key.slice(3)), e.message); return true; });
      // Bob's own attempt cannot be pointed at Ann's task: the attempt names its task, the caller never does.
      await refuses("invalid_command", () => r.svc.reapply(r.as(r.bob, r.other), { commandId: "x-9", attemptId: "att-bob", taskId: r.taskId } as never));
      assert.equal(r.state.asked.length, 0);
    } finally { await r.store.close(); }
    for (const [name, o, code] of [["ended", { live: false }, "invalid_transition"], ["stopped", { stopped: true }, "invalid_transition"], ["held", { frozen: "ending: the agent called work.end" }, "unavailable"], ["paused", { paused: true }, "unavailable"]] as const) {
      const q = await rig(o);
      try {
        await refuses(code, () => q.svc.reapply(q.as(q.ann, q.taskId), { commandId: `y-${name}`, attemptId: "att-ann" }));
        assert.equal(q.state.asked.length, 0, name);
        assert.equal(await q.svc.refreshRounds(q.taskId), 0, name);
      } finally { await q.store.close(); }
    }
  });

  test(`${backend.name}: the owner's workspace.request refuses reapply (it is the author's own tool), and one operation per task: a refresh while another runs is unavailable (card H12p)`, async () => {
    let release!: () => void;
    const gate = new Promise<void>((ok) => { release = ok; });
    let entered!: () => void;
    const inside = new Promise<void>((ok) => { entered = ok; });
    const r = await rig({ port: async () => { entered(); await gate; return { ok: true, summary: "slow", detail: { changed: true, base: "d".repeat(40) } }; } });
    try {
      await refuses("invalid_command", () => r.svc.request(r.w.owner, { commandId: "o-1", operation: "reapply", taskId: r.taskId, reason: "refresh it" }));
      const me = r.as(r.ann, r.taskId);
      const running = r.svc.reapply(me, { commandId: "b-1", attemptId: "att-ann" });
      await inside;
      assert.equal((await r.svc.openFor(r.taskId))?.operation, "reapply");
      await refuses("unavailable", () => r.svc.reapply(me, { commandId: "b-2", attemptId: "att-ann" }));
      // A repeat of the running call is told it is not known yet (never a second host call), and the first call still records its real outcome.
      const repeat = await r.svc.reapply(me, { commandId: "b-1", attemptId: "att-ann" });
      assert.equal(repeat.state, "uncertain");
      release();
      const done = await running;
      assert.deepEqual([done.state, done.round], ["done", 1]);
      assert.equal(r.state.asked.length, 1);
    } finally { release(); await r.store.close(); }
  });

  test(`${backend.name}: a controller that stopped after the host moved the checkout but before the record was written counts that refresh as no round (at most one too few, never too many); the rounds are the task's, across its attempts (H12p review)`, async () => {
    const r = await rig({ port: () => new Promise<WorkspaceOutcome>(() => undefined) });
    try {
      const me = r.as(r.ann, r.taskId);
      // The host does the work, but the answer never reaches this controller (it stops): the record stays `started`.
      let hostDid = 0;
      void r.svc.reapply(me, { commandId: "cr-1", attemptId: "att-ann" }).catch(() => undefined);
      while (r.state.asked.length === 0) await new Promise((ok) => setImmediate(ok));
      const moved = { ok: true as const, summary: "moved", detail: { changed: true, base: "e".repeat(40), kept: 0, taken: 1, merged: 0, conflictCount: 0, conflicts: [] } };
      const next = r.restarted(async () => { hostDid++; return moved; });
      // The next refresh, on the restarted controller, resolves the leftover as uncertain (not a round) and is itself round 1.
      const after = await next.reapply(me, { commandId: "cr-2", attemptId: "att-ann" });
      assert.deepEqual([after.state, after.round], ["done", 1]);
      const left = await next.reapply(me, { commandId: "cr-1", attemptId: "att-ann" });
      assert.deepEqual([left.state, left.round, left.replayed], ["uncertain", undefined, true], "the stopped one is uncertain and was not run again");
      assert.equal(hostDid, 1);
      assert.equal(await next.refreshRounds(r.taskId), 1, "one too few at most, never one too many");
      // A later attempt of the same task goes on counting; another task's count is its own.
      const later = await next.reapply(me, { commandId: "cr-3", attemptId: "att-ann-2" });
      assert.equal(later.round, 2);
      assert.equal(await next.refreshRounds(r.other), 0);
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: without the attempt lookup the operation is unavailable (card H12p)`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      const ann = await w.agent("ann");
      const { taskId } = await w.task("t", ann);
      const svc = WorkspaceOpService.withEpoch(w.storage, w.epoch, { quiesce: { around: async () => { throw new Error("no"); } }, portOf: async () => undefined }, { clock: w.clock.now });
      await refuses("unavailable", () => svc.reapply({ id: ann.id, kind: "agent", name: "ann", grants: [], taskScope: { taskId, projectId: w.project } } as never, { commandId: "n-1", attemptId: "att-ann" }));
    } finally { await store.close(); }
  });
}
