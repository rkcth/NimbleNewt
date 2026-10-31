import assert from "node:assert/strict";
import { after } from "node:test";
import { DomainError } from "../domain/errors.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { RemoteWorkerClient, WorkerRequestError } from "./client.js";
import { PLACEMENT_KIND, RECONCILE_KIND, type PlacementBody } from "./service.js";
import { READ, local, refuses, remoteSuite, wireRefuses, type Ctx } from "./testing/suite.js";
import { REMOTE_CAPS, type RemoteHost } from "./testing/world.js";

after(stopServer);

for (const backend of backends) {
  const suite = remoteSuite(backend);
  const reconnect = async (c: Ctx, r1: RemoteHost, key: string): Promise<RemoteWorkerClient> => {
    const fresh = new RemoteWorkerClient({ url: c.transport.url, token: r1.token, workerVersion: "w" });
    await fresh.connect({ ...REMOTE_CAPS }, key);
    return fresh;
  };
  // The worker's accept while the owner has not decided: an answer that says wait, not a failure and not the end of the attempt.
  const waits = async (fn: () => Promise<unknown>): Promise<void> => {
    try { await fn(); } catch (error) { assert.ok(error instanceof WorkerRequestError && error.waitingForOwner && !error.fenced, String(error)); return; }
    assert.fail("the accept should have been told to wait for the owner");
  };
  const marker = async (c: Ctx, attemptId: string): Promise<NonNullable<PlacementBody["reaccept"]>> => (await rec(c, attemptId)).reaccept!;
  const rec = async (c: Ctx, attemptId: string): Promise<PlacementBody> => (await c.storage.getAggregate({ kind: PLACEMENT_KIND, id: attemptId }))!.body as unknown as PlacementBody;

  suite("the handshake tells a reconnected worker to stop what the controller ended, to accept again what it still owns (auto), and reports what it does not know; nothing resumes by itself, and one session is answered once every 5 seconds", async (c) => {
    const r1 = await c.host("r1");
    const r2 = await c.host("r2");
    const { attemptId, placement } = await c.started(r1);
    const fresh = await reconnect(c, r1, "re-1");
    // Before the handshake the new session cannot call (the existing fence), and the handshake alone resumes nothing.
    const old = fresh.attempt(attemptId, placement);
    await wireRefuses("fenced", () => old.begin(READ("c1")), 409);
    const bogus = "att-" + "a".repeat(20);
    const list = [{ attemptId, placement }, { attemptId: bogus, placement: 1 }, { attemptId: "att-" + "b".repeat(20), placement: 2 }];
    const first = await fresh.reconcile(list);
    assert.deepEqual(first.verdicts.map((v) => v.verdict), ["reaccept", "unknown", "unknown"]);
    assert.equal(first.mode, "auto");
    await wireRefuses("fenced", () => old.begin(READ("c1")), 409);
    assert.equal((await old.accept()).placement, placement);
    // Within 5 seconds the same list is answered with the last answer (not read again), a different list waits.
    assert.deepEqual(await fresh.reconcile(list), first);
    await wireRefuses("unavailable", () => fresh.reconcile([{ attemptId, placement }]), 503);
    c.clock.advance(6000);
    assert.equal((await fresh.reconcile([{ attemptId, placement }])).verdicts[0]!.verdict, "hold");
    // The same list with the same outcome from the same session is not recorded again.
    const revision = async (): Promise<number> => (await c.storage.getAggregate({ kind: RECONCILE_KIND, id: r1.id }))!.revision;
    const written = await revision();
    c.clock.advance(6000);
    assert.equal((await fresh.reconcile([{ attemptId, placement }])).verdicts[0]!.verdict, "hold");
    assert.equal(await revision(), written);
    // The controller records the handshake (and what it did not know).
    const record = (await c.storage.getAggregate({ kind: RECONCILE_KIND, id: r1.id }))!.body as unknown as { unknown: string[] };
    assert.equal(record.unknown.length, 0);
    // A placement number the controller never issued is unknown, an older one is stopped.
    c.clock.advance(6000);
    assert.equal((await fresh.reconcile([{ attemptId, placement: placement + 1 }])).verdicts[0]!.verdict, "unknown");
    // Another host's attempt is not revealed to this host.
    const other = await reconnect(c, r2, "re-2");
    assert.equal((await other.reconcile([{ attemptId, placement }])).verdicts[0]!.verdict, "unknown");
    // The controller ends the attempt: the old host is told to stop, in the old session and in a newer one.
    await c.remote.end(c.owner, attemptId, "test end");
    c.clock.advance(6000);
    const after1 = await fresh.reconcile([{ attemptId, placement }]);
    assert.equal(after1.verdicts[0]!.verdict, "stop");
    await wireRefuses("fenced", () => old.accept(), 409);
  });

  suite("a moved attempt: the old host's handshake says stop and the new holder's says it owns it; the placement number decides", async (c) => {
    const r1 = await c.host("r1");
    const r2 = await c.host("r2");
    const { attemptId, placement } = await c.started(r1);
    await c.remote.relocate(c.owner, { commandId: "mv-1", attemptId, toHostId: r2.id, reason: "r1 retired" });
    assert.equal((await rec(c, attemptId)).hostId, r2.id);
    const fresh = await reconnect(c, r1, "re-1");
    assert.equal((await fresh.reconcile([{ attemptId, placement }])).verdicts[0]!.verdict, "stop");
    await wireRefuses("fenced", () => fresh.attempt(attemptId, placement).accept(), 409);
    // The new holder, reconnecting before it took the moved attempt up, is told to stop: it holds nothing yet (a placement that is not accepted is no holding).
    const next = await reconnect(c, r2, "re-2");
    const now = await rec(c, attemptId);
    assert.equal(now.state, "relocating");
    const verdict = (await next.reconcile([{ attemptId, placement: now.placement }])).verdicts[0]!;
    assert.deepEqual([verdict.verdict, verdict.reason], ["stop", "the placement is relocating"]);
  }, { policy: async () => ({ dataHosts: ["host:r1", "host:r2"] }) });

  suite("under the owner setting a reconnected worker's accept waits for the owner: pending, then approved for that session only, or stopped; a newer session asks again", async (c) => {
    c.reaccept.mode = "owner";
    const r1 = await c.host("r1");
    const { attemptId, placement, attempt } = await c.started(r1);
    assert.equal((await attempt.call(READ("c1"), local("one"))).state, "confirmed");
    const s2 = await reconnect(c, r1, "re-1");
    const a2 = s2.attempt(attemptId, placement);
    const h = await s2.reconcile([{ attemptId, placement }]);
    assert.deepEqual([h.mode, h.verdicts[0]!.verdict], ["owner", "pending"]);
    // The worker is told to wait (not that it failed), and still cannot call.
    await waits(() => a2.accept());
    await wireRefuses("fenced", () => a2.begin(READ("c2")), 409);
    const m2 = await marker(c, attemptId);
    assert.deepEqual([m2.state, m2.sessionId], ["pending", h.sessionId]);
    const decide = (commandId: string, extra: Record<string, unknown> = {}) => ({ commandId, attemptId, placement, sessionId: h.sessionId, decision: "approve", ...extra }) as never;
    // Only the owner decides, with the right placement, for a session, and a valid decision.
    await refuses("forbidden", () => c.remote.decideReaccept(c.dispatcherPrincipal, decide("d0")));
    await refuses("fenced", () => c.remote.decideReaccept(c.owner, decide("d1", { placement: placement + 1 })));
    await refuses("invalid_command", () => c.remote.decideReaccept(c.owner, decide("d1b", { decision: "maybe" })));
    await refuses("invalid_command", () => c.remote.decideReaccept(c.owner, decide("d1c", { sessionId: undefined })));
    // A newer session asks before the owner decides: the owner's approval for the older session is fenced, nothing is approved, and the newer session is the one that waits.
    c.clock.advance(1000);
    const s3 = await reconnect(c, r1, "re-3");
    const a3 = s3.attempt(attemptId, placement);
    const h3 = await s3.reconcile([{ attemptId, placement }]);
    assert.equal(h3.verdicts[0]!.verdict, "pending");
    await refuses("fenced", () => c.remote.decideReaccept(c.owner, decide("d2")));
    assert.equal((await marker(c, attemptId)).state, "pending");
    await waits(() => a3.accept());
    await wireRefuses("fenced", () => a2.accept(), 409);
    // The waiting recorded again (another moment) is fenced as well when the owner names the earlier moment.
    await refuses("fenced", () => c.remote.decideReaccept(c.owner, decide("d2b", { sessionId: h3.sessionId, waitingSince: "2000-01-01T00:00:00.000Z" })));
    // Approve for the session that waits: accept now succeeds and calls work.
    await c.remote.decideReaccept(c.owner, decide("d3", { sessionId: h3.sessionId, waitingSince: (await marker(c, attemptId)).at }));
    c.clock.advance(6000);
    assert.equal((await s3.reconcile([{ attemptId, placement }])).verdicts[0]!.verdict, "reaccept");
    assert.equal((await a3.accept()).placement, placement);
    assert.equal((await rec(c, attemptId)).reaccept, undefined);
    assert.equal((await a3.call(READ("c2"), local("two"))).state, "confirmed");
    // Nothing waits any more.
    await refuses("invalid_transition", () => c.remote.decideReaccept(c.owner, decide("d4", { sessionId: h3.sessionId })));
  });

  suite("the owner may stop a reconnected worker's waiting attempt: it ends and the worker is fenced; a retry of the same command returns the recorded result; a session that is no longer the waiting one cannot stop it", async (c) => {
    c.reaccept.mode = "owner";
    const r1 = await c.host("r1");
    const { attemptId, placement } = await c.started(r1);
    const s2 = await reconnect(c, r1, "re-1");
    await waits(() => s2.attempt(attemptId, placement).accept());
    const sessionId = (await marker(c, attemptId)).sessionId;
    // A stop that names another session does nothing.
    await refuses("fenced", () => c.remote.decideReaccept(c.owner, { commandId: "s0", attemptId, placement, sessionId: "wrk-other", decision: "stop" } as never));
    assert.equal((await rec(c, attemptId)).state, "accepted");
    const stop = { commandId: "s1", attemptId, placement, sessionId, decision: "stop" } as never;
    assert.equal((await c.remote.decideReaccept(c.owner, stop)).state, "stopped");
    assert.equal((await rec(c, attemptId)).state, "ended");
    // The retry (the first answer was lost) gets the same answer, not an error about nothing waiting.
    assert.equal((await c.remote.decideReaccept(c.owner, stop)).state, "stopped");
    await refuses("invalid_transition", () => c.remote.decideReaccept(c.owner, { commandId: "s2", attemptId, placement, sessionId, decision: "stop" } as never));
    await wireRefuses("fenced", () => s2.attempt(attemptId, placement).accept(), 409);
    c.clock.advance(6000);
    assert.equal((await s2.reconcile([{ attemptId, placement }])).verdicts[0]!.verdict, "stop");
  });

  suite("the owner is told once when a worker starts to wait, can list what waits (owner only, paged), and a newer session is told again", async (c) => {
    c.reaccept.mode = "owner";
    const r1 = await c.host("r1");
    const first = await c.started(r1, "one");
    const second = await c.started(r1, "two", { agent: "bob" });
    const s2 = await reconnect(c, r1, "re-1");
    await s2.reconcile([{ attemptId: first.attemptId, placement: first.placement }, { attemptId: second.attemptId, placement: second.placement }]);
    assert.deepEqual(c.notices.map((n) => n.attemptId).sort(), [first.attemptId, second.attemptId].sort());
    assert.ok(c.notices.every((n) => n.hostId === r1.id && /reconnect\.reaccept/.test(n.detail)));
    // Polling again (accept, a later handshake) does not tell again.
    await waits(() => s2.attempt(first.attemptId, first.placement).accept());
    c.clock.advance(6000);
    await s2.reconcile([{ attemptId: first.attemptId, placement: first.placement }]);
    assert.equal(c.notices.length, 2);
    // The list is for the owner only and is paged.
    await refuses("forbidden", () => c.remote.pending(c.dispatcherPrincipal));
    const all = await c.remote.pending(c.owner);
    assert.deepEqual(all.items.map((x) => x.attemptId).sort(), [first.attemptId, second.attemptId].sort());
    assert.ok(all.items.every((x) => x.sessionId === s2.session!.sessionId && x.hostId === r1.id));
    const one = await c.remote.pending(c.owner, { limit: 1 });
    assert.equal(one.items.length, 1);
    assert.ok(one.next !== undefined);
    assert.equal((await c.remote.pending(c.owner, { limit: 1, after: one.next! })).items.length, 1);
    await refuses("invalid_command", () => c.remote.pending(c.owner, { limit: 0 }));
    // A newer session is a new question: the owner is told again, and the list names that session.
    const s3 = await reconnect(c, r1, "re-3");
    await s3.reconcile([{ attemptId: first.attemptId, placement: first.placement }]);
    assert.equal(c.notices.length, 3);
    assert.equal((await c.remote.pending(c.owner)).items.find((x) => x.attemptId === first.attemptId)!.sessionId, s3.session!.sessionId);
    // Decided attempts leave the list.
    await c.remote.decideReaccept(c.owner, { commandId: "n1", attemptId: second.attemptId, placement: second.placement, sessionId: s2.session!.sessionId, decision: "stop" } as never);
    assert.deepEqual((await c.remote.pending(c.owner)).items.map((x) => x.attemptId), [first.attemptId]);
  });

  suite("an approval written by the setting (auto) does not outlive a switch to owner: the next accept waits", async (c) => {
    const r1 = await c.host("r1");
    const { attemptId, placement } = await c.started(r1);
    const s2 = await reconnect(c, r1, "re-1");
    const h = await s2.reconcile([{ attemptId, placement }]);
    assert.equal(h.verdicts[0]!.verdict, "reaccept");
    const m = await marker(c, attemptId);
    assert.deepEqual([m.state, m.sessionId], ["auto", h.sessionId]);
    // The owner switches the setting before the worker's accept: the standing marker is not an approval.
    c.reaccept.mode = "owner";
    await waits(() => s2.attempt(attemptId, placement).accept());
    assert.equal((await marker(c, attemptId)).state, "pending");
    assert.equal(c.notices.length, 1);
    // And a handshake under owner does not report the old marker as an approval either.
    c.reaccept.mode = "auto";
    const s3 = await reconnect(c, r1, "re-3");
    assert.equal((await s3.reconcile([{ attemptId, placement }])).verdicts[0]!.verdict, "reaccept");
    c.reaccept.mode = "owner";
    c.clock.advance(6000);
    assert.equal((await s3.reconcile([{ attemptId, placement }])).verdicts[0]!.verdict, "pending");
    assert.equal(c.notices.length, 2);
  });

  suite("while the owner has not decided, the controller keeps the attempt's lease alive as long as the worker keeps asking, for the patience; with the patience off the lease runs out as usual", async (c) => {
    c.reaccept.mode = "owner";
    const r1 = await c.host("r1");
    const held = await c.started(r1, "keep");
    const s2 = await reconnect(c, r1, "re-1");
    await waits(() => s2.attempt(held.attemptId, held.placement).accept());
    // Well past the lease the attempt had (60 s), the worker asking every 30 s keeps it.
    for (let i = 0; i < 6; i++) { c.clock.advance(30_000); await s2.heartbeat(100 + i); await waits(() => s2.attempt(held.attemptId, held.placement).accept()); }
    const kept = await c.tick();
    assert.ok(!kept.lost.includes(held.attemptId), JSON.stringify(kept));
    // The patience off: asking does not keep it, the lease runs out and the dispatcher takes the attempt back.
    c.patience.ms = undefined;
    for (let i = 0; i < 6; i++) { c.clock.advance(30_000); await s2.heartbeat(200 + i); await waits(() => s2.attempt(held.attemptId, held.placement).accept()); }
    const gone = await c.tick();
    assert.ok(gone.lost.includes(held.attemptId), JSON.stringify(gone));
  });

  suite("the handshake is bounded and validated, and a controller that lost the epoch answers no verdicts", async (c) => {
    const r1 = await c.host("r1");
    const { attemptId, placement } = await c.started(r1);
    const s2 = await reconnect(c, r1, "re-1");
    await wireRefuses("invalid_command", () => s2.reconcile(Array.from({ length: 65 }, (_, i) => ({ attemptId: `att-${"c".repeat(19)}${String.fromCharCode(97 + (i % 26))}`, placement: 1 }))), 400);
    await wireRefuses("invalid_command", () => s2.reconcile([{ attemptId, placement }, { attemptId, placement }]), 400);
    await wireRefuses("invalid_command", () => s2.reconcile([{ attemptId: "nope", placement: 1 }]), 400);
    await wireRefuses("invalid_command", () => s2.reconcile([{ attemptId, placement: 0 }]), 400);
    // A stale session cannot reconcile.
    const s3 = await reconnect(c, r1, "re-3");
    await wireRefuses("fenced", () => s2.reconcile([{ attemptId, placement }]), 409);
    void s3;
    // An old primary: another controller took the epoch; its handshake gets stale_epoch, no verdicts, and the stored placement is unchanged.
    const before = await rec(c, attemptId);
    c.reaccept.mode = "owner";
    await c.storage.acquireEpoch({ holder: "controller-2", at: c.clock.now() });
    await wireRefuses("stale_epoch", () => s3.reconcile([{ attemptId, placement }]), 503);
    assert.deepEqual(await rec(c, attemptId), before);
    void DomainError;
  });
}
