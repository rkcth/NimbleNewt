import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { DomainError } from "../domain/errors.js";
import type { Principal } from "../security/principals.js";
import { buildWorld } from "../dispatch/testing/world.js";
import { SubmitRefused, WorkEndService, overlapOf, type EndingAttempt, type Landed, type SettleReport } from "./index.js";

after(stopServer);

test("overlapOf: a stale base with overlapping files is the only refusal", () => {
  const l = (base: string, mine: string[], landed: string[]): Landed => ({ base, head: "h2", mine, landed });
  assert.deepEqual(overlapOf(l("h1", ["b", "a", "c"], ["c", "a", "z"])), ["a", "c"]);
  assert.deepEqual(overlapOf(l("h1", ["a"], ["z"])), [], "stale but unrelated files");
  assert.deepEqual(overlapOf(l("h2", ["a"], ["a"])), [], "current base");
  assert.deepEqual(overlapOf(l("h1", ["a", "a"], ["a"])), ["a"]);
});

for (const backend of backends) {
  const rig = async (opts: { landed?: Landed; settle?: SettleReport; submitFails?: boolean; noSubmit?: boolean } = {}) => {
    const store = await backend.open();
    const w = await buildWorld(store.storage);
    await w.principals.enroll(w.owner, { commandId: "en-ann", kind: "agent", name: "ann", grants: [] });
    const ann: Principal = await w.principals.authenticate((await w.principals.issueCredential(w.owner, "agent:ann")).token);
    await w.principals.enroll(w.owner, { commandId: "en-bob", kind: "agent", name: "bob", grants: [] });
    const bob: Principal = await w.principals.authenticate((await w.principals.issueCredential(w.owner, "agent:bob")).token);
    const { taskId } = await w.task("t", { aid: "ann" });
    const state: { attempt: EndingAttempt; frozen: string[]; finished: unknown[]; settled: number; submits: number; told: string[] } = {
      attempt: { attemptId: "att-1", taskId, projectId: w.project, agentId: "agent:ann", live: true }, frozen: [], finished: [], settled: 0, submits: 0, told: [],
    };
    const landed: Landed = opts.landed ?? { base: "h1", head: "h1", mine: ["a.ts"], landed: [] };
    const service = WorkEndService.withEpoch(w.storage, w.epoch, {
      attempts: {
        get: async (id) => (id === "att-1" ? state.attempt : undefined),
        freeze: async (_id, reason) => { state.frozen.push(reason); },
        settle: async () => { state.settled++; return opts.settle ?? { killed: [] }; },
        finish: async (id, result) => { state.finished.push({ id, ...result }); state.attempt = { ...state.attempt, live: false }; },
      },
      landing: async () => landed,
      ...(opts.noSubmit ? {} : { submit: async () => { state.submits++; if (opts.submitFails) throw new Error("git said no"); return { submissionId: "sub-1" }; } }),
      blockers: w.blockers,
      tell: async (_a, m) => { state.told.push(m); },
    }, { clock: w.clock.now });
    return { store, w, ann, bob, state, service };
  };
  const refuses = (code: string, run: () => Promise<unknown>) => assert.rejects(run, (e: unknown) => { assert.ok(e instanceof DomainError, String(e)); assert.equal(e.code, code, e.message); return true; });

  test(`${backend.name}: a submit on a current base is recorded, the attempt frozen, and one completion stages, submits and finishes once (H12n)`, async () => {
    const r = await rig();
    try {
      const asked = await r.service.request(r.ann, { commandId: "e1", attemptId: "att-1", submit: true, result: "done", note: "all done", message: "please review" });
      assert.equal(asked.state, "requested"); assert.equal(asked.replayed, false);
      assert.equal(r.state.frozen.length, 1);
      // A repeat, even under another command ID, is the same ending.
      const again = await r.service.request(r.ann, { commandId: "e2", attemptId: "att-1", submit: true });
      assert.equal(again.replayed, true); assert.equal(again.note, "all done");
      const [one, two] = await Promise.all([r.service.complete("att-1"), r.service.complete("att-1")]);
      assert.equal(one.outcome, "submitted"); assert.equal(one.submissionId, "sub-1"); assert.equal(two.outcome, "submitted");
      const later = await r.service.complete("att-1");
      assert.equal(later.replayed, true);
      assert.equal(r.state.submits, 1); assert.equal(r.state.finished.length, 1); assert.equal(r.state.settled, 1);
      assert.deepEqual(r.state.told, ["please review"]);
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: a stale overlapping submit is refused with the head and the files; a plain end is never refused (H12n)`, async () => {
    const r = await rig({ landed: { base: "h1", head: "h9", mine: ["a.ts", "b.ts"], landed: ["b.ts", "c.ts"] } });
    try {
      await assert.rejects(() => r.service.request(r.ann, { commandId: "e1", attemptId: "att-1", submit: true }), (e: unknown) => {
        assert.ok(e instanceof SubmitRefused); assert.equal(e.head, "h9"); assert.deepEqual(e.overlapping, ["b.ts"]); assert.match(e.message, /h9/); return true;
      });
      assert.equal(await r.service.get("att-1"), undefined, "nothing was recorded");
      assert.equal(r.state.frozen.length, 0);
      const plain = await r.service.request(r.ann, { commandId: "e2", attemptId: "att-1", result: "partial" });
      assert.equal(plain.submit, false);
      const done = await r.service.complete("att-1");
      assert.equal(done.outcome, "ended"); assert.equal(r.state.submits, 0);
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: a stale base with unrelated files may submit (H12n)`, async () => {
    const r = await rig({ landed: { base: "h1", head: "h9", mine: ["a.ts"], landed: ["z.ts"] } });
    try {
      await r.service.request(r.ann, { commandId: "e1", attemptId: "att-1", submit: true });
      assert.equal((await r.service.complete("att-1")).outcome, "submitted");
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: only the attempt's own agent may end it, and bad input is refused (H12n)`, async () => {
    const r = await rig();
    try {
      await refuses("not_found", () => r.service.request(r.bob, { commandId: "e1", attemptId: "att-1" }));
      await refuses("not_found", () => r.service.request(r.ann, { commandId: "e1", attemptId: "nope" }));
      await refuses("forbidden", () => r.service.request(r.w.owner, { commandId: "e1", attemptId: "att-1" }));
      await refuses("invalid_command", () => r.service.request(r.ann, { commandId: "e1", attemptId: "att-1", result: "great" }));
      await refuses("invalid_command", () => r.service.request(r.ann, { commandId: "e1", attemptId: "att-1", submit: "yes" as never }));
      await refuses("invalid_command", () => r.service.request(r.ann, { commandId: "e1", attemptId: "att-1", note: "x".repeat(2000) }));
      await refuses("invalid_command", () => r.service.request(r.ann, { commandId: "e1", attemptId: "att-1", extra: 1 } as never));
      assert.equal(await r.service.get("att-1"), undefined);
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: an owner stop wins and an emergency stop drops the intent; nothing is staged (H12n)`, async () => {
    const r = await rig();
    try {
      await r.service.request(r.ann, { commandId: "e1", attemptId: "att-1", submit: true });
      r.state.attempt = { ...r.state.attempt, live: false, stopped: { by: "owner", reason: "owner stopped it" } };
      const done = await r.service.complete("att-1");
      assert.equal(done.state, "dropped"); assert.equal(done.typed, "owner_stop");
      assert.equal(r.state.submits, 0); assert.equal(r.state.finished.length, 0); assert.equal(r.state.settled, 0);
    } finally { await r.store.close(); }
    const q = await rig();
    try {
      await q.service.request(q.ann, { commandId: "e1", attemptId: "att-1", submit: true });
      const dropped = await q.service.drop("att-1");
      assert.equal(dropped?.state, "dropped"); assert.equal(dropped?.typed, "emergency_stop");
      assert.equal((await q.service.complete("att-1")).state, "dropped");
      assert.equal(q.state.submits, 0);
    } finally { await q.store.close(); }
  });

  test(`${backend.name}: a killed write call turns a submit into a plain end with a release_failed blocker (H12n)`, async () => {
    const r = await rig({ settle: { killed: [{ callId: "c1", write: true, reason: "hung past the settle time" }, { callId: "c2", write: false, reason: "hung" }] } });
    try {
      await r.service.request(r.ann, { commandId: "e1", attemptId: "att-1", submit: true });
      const done = await r.service.complete("att-1");
      assert.equal(done.outcome, "ended"); assert.equal(done.typed, "release_failed"); assert.ok(done.blocker !== undefined);
      assert.match(done.summary ?? "", /c1/); assert.equal(r.state.submits, 0); assert.equal(r.state.finished.length, 1);
    } finally { await r.store.close(); }
    // A killed read-only call does not change a submit.
    const q = await rig({ settle: { killed: [{ callId: "c2", write: false, reason: "hung" }] } });
    try {
      await q.service.request(q.ann, { commandId: "e1", attemptId: "att-1", submit: true });
      assert.equal((await q.service.complete("att-1")).outcome, "submitted");
    } finally { await q.store.close(); }
  });

  test(`${backend.name}: a failing or missing submission becomes a plain end with a blocker, never a lost ending (H12n)`, async () => {
    for (const opts of [{ submitFails: true }, { noSubmit: true }]) {
      const r = await rig(opts);
      try {
        await r.service.request(r.ann, { commandId: "e1", attemptId: "att-1", submit: true });
        const done = await r.service.complete("att-1");
        assert.equal(done.outcome, "ended"); assert.ok(done.blocker !== undefined); assert.equal(r.state.finished.length, 1);
      } finally { await r.store.close(); }
    }
  });

  test(`${backend.name}: a restart completes an open ending once (H12n)`, async () => {
    const r = await rig();
    try {
      await r.service.request(r.ann, { commandId: "e1", attemptId: "att-1", submit: true });
      const first = await r.service.recover();
      assert.equal(first.length, 1); assert.equal(first[0]!.outcome, "submitted");
      assert.equal((await r.service.recover()).length, 0);
      assert.equal(r.state.submits, 1); assert.equal(r.state.finished.length, 1);
    } finally { await r.store.close(); }
  });
}
