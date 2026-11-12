import assert from "node:assert/strict";
import { after } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { workGrants } from "../dispatch/testing/world.js";
import { RemoteWorkerService } from "./service.js";
import { wireRefuses, remoteSuite, type Ctx } from "./testing/suite.js";

after(stopServer);

/** What the placement policy of these tests says now. */
const policy: { hosts: string[]; fail: boolean } = { hosts: ["host:a"], fail: false };
/** The base world's own host, which is always on record. */
const W1 = "host:w1";
const req = { data: "local-only" as const, harness: "pi" };
const query = { taskId: "task-aaaaaaaaaaaaaaaaaaaa", projectId: "", agentId: "agent:ann", requirements: req };
const disable = async (c: Ctx, id: string): Promise<void> => {
  const found = await c.storage.getAggregate({ kind: "principal", id });
  await c.principals.disable(c.owner, { commandId: `dis-${id}`, principalId: id, expectedRevision: found!.revision });
};
/** A second service over the same storage and hosts, as a controller that restarted would have: nothing indexed, nothing offered. */
const restarted = (c: Ctx): RemoteWorkerService => RemoteWorkerService.withEpoch(c.storage, c.epoch, {
  principal: c.dispatcherPrincipal, hosts: c.hosts, artifacts: c.artifacts,
  dispatch: { gateway: (id: string) => c.current.gateway(id), get: (by: never, id: string) => c.current.get(by, id), relocate: (...a: never[]) => (c.current.relocate as (...x: unknown[]) => unknown)(...a), quiesce: (...a: never[]) => (c.current.quiesce as (...x: unknown[]) => unknown)(...a), release: (by: never, id: string) => c.current.release(by, id) },
  placementPolicy: async () => ({ dataHosts: ["host:a", "host:b", "host:c"] }),
} as never, c.options);

for (const backend of backends) {
  const suite = remoteSuite(backend);

  suite("a revoked host is refused once with its reason and then leaves the platform index, so candidates stops listing it (card H07b)", async (c) => {
    const a = await c.host("a"), b = await c.host("b");
    assert.deepEqual(c.remote.platformIndex(c.dispatcherPrincipal), { "linux/x64": [a.id, b.id] });
    await disable(c, b.id);
    const first = await c.remote.candidates(c.dispatcherPrincipal, { ...query, projectId: c.project });
    assert.deepEqual([first.eligible, first.considered], [[a.id], 2]);
    assert.match(first.refused.find((r) => r.hostId === b.id)?.reasons.join(";") ?? "", /host:b is revoked/);
    assert.deepEqual(c.remote.platformIndex(c.dispatcherPrincipal), { "linux/x64": [a.id] }, "dropped from the index");
    const second = await c.remote.candidates(c.dispatcherPrincipal, { ...query, projectId: c.project });
    assert.deepEqual([second.eligible, second.considered, second.refused], [[a.id], 1, []], "not looked at again");
    // The only host of the platform revoked: the index has no platform left and the attempt waits with the plain words.
    await disable(c, a.id);
    await c.remote.candidates(c.dispatcherPrincipal, { ...query, projectId: c.project });
    assert.deepEqual(c.remote.platformIndex(c.dispatcherPrincipal), {});
    assert.match((await c.remote.candidates(c.dispatcherPrincipal, { ...query, projectId: c.project })).waiting ?? "", /no connected host runs/);
  });

  suite("a controller that restarted fills the platform index from the hosts on record without waiting for them to connect; revoked hosts are left out; a repeat changes nothing (card H07b)", async (c) => {
    const a = await c.host("a"), b = await c.host("b"), gone = await c.host("gone");
    await disable(c, gone.id);
    const fresh = restarted(c);
    try {
      assert.deepEqual(fresh.platformIndex(c.dispatcherPrincipal), {}, "nothing is known before the rebuild");
      const before = await fresh.candidates(c.dispatcherPrincipal, { ...query, projectId: c.project });
      assert.deepEqual([before.eligible, before.considered], [[], 0]);
      assert.match(before.waiting ?? "", /no connected host runs/);
      assert.equal(await fresh.rebuildIndex(c.dispatcherPrincipal), 3);
      assert.deepEqual(fresh.platformIndex(c.dispatcherPrincipal), { "linux/x64": [a.id, b.id, W1] });
      const after = await fresh.candidates(c.dispatcherPrincipal, { ...query, projectId: c.project });
      assert.deepEqual([after.eligible, after.considered], [[a.id, b.id], 3], JSON.stringify(after));
      assert.match(after.refused.find((r) => r.hostId === W1)?.reasons.join(";") ?? "", /host:w1 has not connected/, "indexed is not connected: the host that never connected is refused for that");
      assert.equal(await fresh.rebuildIndex(c.dispatcherPrincipal), 0, "a repeat adds nothing");
      // A host revoked after the rebuild is dropped by the next rebuild too.
      await disable(c, b.id);
      assert.equal(await fresh.rebuildIndex(c.dispatcherPrincipal), 0);
      assert.deepEqual(fresh.platformIndex(c.dispatcherPrincipal), { "linux/x64": [a.id, W1] });
      // Only the dispatcher's service principal may ask.
      assert.throws(() => fresh.platformIndex(a.principal));
      await assert.rejects(fresh.rebuildIndex(a.principal));
    } finally { fresh.close(); }
  });

  suite("an index of more hosts than one page holds is filled completely (card H07b)", async (c) => {
    const names = Array.from({ length: 7 }, (_, i) => `n${i}`);
    for (const n of names) await c.host(n, { dispatcher: false });
    const fresh = restarted(c);
    try {
      assert.equal(await fresh.rebuildIndex(c.dispatcherPrincipal, 3), 8);
      assert.equal(Object.values(fresh.platformIndex(c.dispatcherPrincipal)).flat().length, 8);
    } finally { fresh.close(); }
  });

  suite("an offer the policy has since refused for a lasting reason is not delivered: it is withdrawn, the placement ends with the reasons, and the dispatcher ends that attempt with the same words (card H07b)", async (c) => {
    policy.hosts = ["host:a"]; policy.fail = false;
    const a = await c.host("a");
    a.worker.requirements = () => req;
    const ann = await c.agent("ann", workGrants(c.project, ["read-file", "write-file"]));
    c.prefer(a);
    const { taskId, attemptId } = await c.task("Order seeds", ann);
    const report = await c.tick();
    assert.ok(report.started.includes(attemptId!), JSON.stringify(report.skipped));
    assert.equal(c.remote.offerLoad(c.dispatcherPrincipal, a.id), 1);
    // The owner removes the host from the data-location policy after the offer was made, before the host read it.
    policy.hosts = [];
    assert.deepEqual(await a.client.offers(), [], "nothing is delivered");
    const placement = (await c.remote.placement(c.owner, attemptId!))!;
    assert.equal(placement.state, "ended");
    assert.match(placement.history.at(-1)!.reason, /withdrawn before it was delivered, host:a would now refuse it: .*data-location policy does not list host:a/);
    // A turn that begins to wait only now still learns that the offer was put back, not that "the placement ended".
    const late = await c.remote.waitForResult(c.dispatcherPrincipal, attemptId!, placement.placement);
    assert.deepEqual([late.status, late.withdrawn], ["cancelled", true]);
    assert.match(late.error ?? "", /withdrawn before it was delivered/);
    assert.equal(c.remote.offerLoad(c.dispatcherPrincipal, a.id), 0, "the offer and its credential are gone");
    assert.equal(c.remote.pollStats(c.dispatcherPrincipal).withdrawn, 1);
    assert.deepEqual(await a.client.offers(), [], "and stays gone");
    // The dispatcher's turn on that placement ends at once with the reasons, so the attempt is not left running on nothing.
    for (let i = 0; i < 100 && (await c.current.get(c.owner, attemptId!))?.state === "running"; i++) await new Promise((r) => setTimeout(r, 20));
    const rec = (await c.current.get(c.owner, attemptId!))!;
    assert.notEqual(rec.state, "running");
    assert.match(rec.outcome?.summary ?? JSON.stringify(rec), /withdrawn before it was delivered/);
    // Put back: the task is not lost. Once the policy lists the host again, the task has a new attempt, placed afresh by the policy as it stands, and the host is delivered that one.
    policy.hosts = ["host:a"];
    let next: string | undefined;
    for (let i = 0; i < 150 && next === undefined; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 20));
      const r = await c.tick();
      next = r.started.find((id) => id !== attemptId);
    }
    assert.ok(next !== undefined, "a new attempt of the task started");
    assert.equal((await c.remote.placement(c.owner, next))!.hostId, a.id);
    assert.deepEqual((await a.client.offers()).map((o) => o.order.attemptId), [next]);
    assert.equal((await c.assignments.getAssignment(taskId))?.activeAttemptId, next);
  }, { placement: async () => ({ dataHosts: policy.hosts }) });

  suite("an offer is still delivered when the policy still lists the host, when it cannot be read, or when the only reasons pass (card H07b)", async (c) => {
    policy.hosts = ["host:a"]; policy.fail = false;
    const a = await c.host("a");
    a.worker.requirements = () => req;
    const ann = await c.agent("ann", workGrants(c.project, ["read-file", "write-file"]));
    c.prefer(a);
    const { attemptId } = await c.task("Order seeds", ann);
    assert.ok((await c.tick()).started.includes(attemptId!));
    assert.equal((await a.client.offers()).length, 1, "listed: delivered");
    policy.fail = true;
    assert.equal((await a.client.offers()).length, 1, "a policy that cannot be read withdraws nothing");
    policy.fail = false;
    assert.equal(c.remote.pollStats(c.dispatcherPrincipal).withdrawn, 0);
    assert.equal((await c.remote.placement(c.owner, attemptId!))!.state, "offered");
  }, { placement: async () => { if (policy.fail) throw new Error("the policy store is down"); return { dataHosts: policy.hosts }; } });

  suite("a worker cannot mark its own result as withdrawn: the field is refused on the wire (card H07b)", async (c) => {
    const a = await c.host("a");
    const run = await c.started(a);
    await wireRefuses("invalid_command", () => (run.attempt as unknown as { complete(r: unknown): Promise<unknown> }).complete({ status: "cancelled", withdrawn: true }), 400);
  });
}
