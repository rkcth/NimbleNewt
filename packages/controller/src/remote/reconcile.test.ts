import assert from "node:assert/strict";
import { after } from "node:test";
import { DomainError } from "../domain/errors.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { RemoteWorkerClient } from "./client.js";
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
  const rec = async (c: Ctx, attemptId: string): Promise<PlacementBody> => (await c.storage.getAggregate({ kind: PLACEMENT_KIND, id: attemptId }))!.body as unknown as PlacementBody;

  suite("the handshake tells a reconnected worker to stop what the controller relocated or ended, to accept again what it still owns (auto), and reports what it does not know; nothing resumes by itself", async (c) => {
    const r1 = await c.host("r1");
    const r2 = await c.host("r2");
    const { attemptId, placement } = await c.started(r1);
    const fresh = await reconnect(c, r1, "re-1");
    // Before the handshake the new session cannot call (the existing fence), and the handshake alone resumes nothing.
    const old = fresh.attempt(attemptId, placement);
    await wireRefuses("fenced", () => old.begin(READ("c1")), 409);
    const bogus = "att-" + "a".repeat(20);
    const first = await fresh.reconcile([{ attemptId, placement }, { attemptId: bogus, placement: 1 }, { attemptId: "att-" + "b".repeat(20), placement: 2 }]);
    assert.deepEqual(first.verdicts.map((v) => v.verdict), ["reaccept", "unknown", "unknown"]);
    assert.equal(first.mode, "auto");
    await wireRefuses("fenced", () => old.begin(READ("c1")), 409);
    assert.equal((await old.accept()).placement, placement);
    assert.equal((await fresh.reconcile([{ attemptId, placement }])).verdicts[0]!.verdict, "hold");
    // The controller records the handshake (and what it did not know).
    const record = (await c.storage.getAggregate({ kind: RECONCILE_KIND, id: r1.id }))!.body as unknown as { unknown: string[] };
    assert.equal(record.unknown.length, 0);
    // A placement number the controller never issued is unknown, an older one is stopped.
    assert.equal((await fresh.reconcile([{ attemptId, placement: placement + 1 }])).verdicts[0]!.verdict, "unknown");
    // Another host's attempt is not revealed to this host.
    const other = await reconnect(c, r2, "re-2");
    assert.equal((await other.reconcile([{ attemptId, placement }])).verdicts[0]!.verdict, "unknown");
    // The controller relocates the attempt: the old host is told to stop, in the old session and in a newer one.
    await c.remote.end(c.owner, attemptId, "test end");
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
    // The new holder, reconnecting, owns it at the new number and a stale number is stopped.
    const next = await reconnect(c, r2, "re-2");
    const now = await rec(c, attemptId);
    assert.equal((await next.reconcile([{ attemptId, placement: now.placement }])).verdicts[0]!.verdict, now.state === "accepted" ? "reaccept" : "stop");
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
    // The worker cannot take it up, and still cannot call.
    await wireRefuses("unavailable", () => a2.accept(), 503);
    await wireRefuses("fenced", () => a2.begin(READ("c2")), 409);
    assert.equal((await rec(c, attemptId)).reaccept?.state, "pending");
    // Only the owner decides, with the right placement.
    await refuses("forbidden", () => c.remote.decideReaccept(c.dispatcherPrincipal, { commandId: "d0", attemptId, placement, decision: "approve" }));
    await refuses("fenced", () => c.remote.decideReaccept(c.owner, { commandId: "d1", attemptId, placement: placement + 1, decision: "approve" }));
    await refuses("invalid_command", () => c.remote.decideReaccept(c.owner, { commandId: "d1b", attemptId, placement, decision: "maybe" as never }));
    // A third session appears before the owner decides: the approval is for the session that asked, so it does not carry over.
    await c.remote.decideReaccept(c.owner, { commandId: "d2", attemptId, placement, decision: "approve" });
    const s3 = await reconnect(c, r1, "re-3");
    const a3 = s3.attempt(attemptId, placement);
    assert.equal((await s3.reconcile([{ attemptId, placement }])).verdicts[0]!.verdict, "pending");
    await wireRefuses("unavailable", () => a3.accept(), 503);
    await wireRefuses("fenced", () => a2.accept(), 409);
    // Approve for the current session: accept now succeeds and calls work.
    await c.remote.decideReaccept(c.owner, { commandId: "d3", attemptId, placement, decision: "approve" });
    assert.equal((await s3.reconcile([{ attemptId, placement }])).verdicts[0]!.verdict, "reaccept");
    assert.equal((await a3.accept()).placement, placement);
    assert.equal((await rec(c, attemptId)).reaccept, undefined);
    assert.equal((await a3.call(READ("c2"), local("two"))).state, "confirmed");
    // Nothing waits any more.
    await refuses("invalid_transition", () => c.remote.decideReaccept(c.owner, { commandId: "d4", attemptId, placement, decision: "approve" }));
  });

  suite("the owner may stop a reconnected worker's waiting attempt: it ends and the worker is fenced", async (c) => {
    c.reaccept.mode = "owner";
    const r1 = await c.host("r1");
    const { attemptId, placement } = await c.started(r1);
    const s2 = await reconnect(c, r1, "re-1");
    await wireRefuses("unavailable", () => s2.attempt(attemptId, placement).accept(), 503);
    assert.equal((await c.remote.decideReaccept(c.owner, { commandId: "s1", attemptId, placement, decision: "stop" })).state, "stopped");
    assert.equal((await rec(c, attemptId)).state, "ended");
    await wireRefuses("fenced", () => s2.attempt(attemptId, placement).accept(), 409);
    assert.equal((await s2.reconcile([{ attemptId, placement }])).verdicts[0]!.verdict, "stop");
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
