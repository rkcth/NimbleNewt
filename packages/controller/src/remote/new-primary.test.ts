import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { HostService } from "../hosts/index.js";
import { RemoteWorkerClient, type ReconcileAnswer } from "./client.js";
import { adoptable } from "./host.js";
import { HostPoller } from "./poller.js";
import { PROTOCOL_HEADER, SESSION_HEADER } from "./protocol.js";
import { WorkerTransport } from "./server.js";
import { RECONCILE_KIND, RemoteWorkerService } from "./service.js";
import { refuses, remoteSuite } from "./testing/suite.js";
import { REMOTE_CAPS, rawRequest } from "./testing/world.js";

after(stopServer);

test("a new primary takes over only a run the asked host holds: accepted, or completed with its result; an offer, a run that ended or moved, or another host's run is not taken (card H09b)", async () => {
  const by = { id: "service:dispatcher", kind: "service" } as never;
  const at = (p: object | undefined) => ({ placement: async () => p as never });
  const id = "att-abcdefghijklmnopqrst";
  assert.equal(await adoptable(at({ hostId: "host:r1", placement: 3, state: "accepted" }), by, "host:r1", id), 3);
  assert.equal(await adoptable(at({ hostId: "host:r1", placement: 4, state: "completed", result: { status: "completed" } }), by, "host:r1", id), 4);
  assert.equal(await adoptable(at({ hostId: "host:r2", placement: 3, state: "accepted" }), by, "host:r1", id), undefined, "another host's run");
  for (const state of ["offered", "ended", "relocating"]) assert.equal(await adoptable(at({ hostId: "host:r1", placement: 3, state }), by, "host:r1", id), undefined, state);
  assert.equal(await adoptable(at({ hostId: "host:r1", placement: 3, state: "completed" }), by, "host:r1", id), undefined, "completed with no stored result");
  assert.equal(await adoptable(at(undefined), by, "host:r1", id), undefined);
});

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Waits (up to 15 s) until the condition holds. */
const until = async (cond: () => boolean | Promise<boolean>): Promise<void> => { for (let i = 0; i < 750 && !(await cond()); i++) await sleepMs(20); };

for (const backend of backends) {
  const suite = remoteSuite(backend);

  suite("a session names the primary it was opened with; a controller that took the store over does not accept it (connect again), and the old primary does not accept a session of the new one (card H09b)", async (c) => {
    const r1 = await c.host("r1");
    const first = r1.client.session!;
    assert.equal(first.primaryEpoch, c.epoch);
    // A second controller takes the epoch and listens with its own remote service over the same store.
    const { epoch } = await c.storage.acquireEpoch({ holder: "controller-2", at: c.clock.now() });
    assert.ok(epoch > c.epoch);
    const hosts = HostService.withEpoch(c.storage, epoch, c.assignments, c.options);
    const second = RemoteWorkerService.withEpoch(c.storage, epoch, { principal: c.dispatcherPrincipal, hosts, artifacts: c.artifacts, dispatch: c.current as never }, c.options);
    const transport = await WorkerTransport.listen({ remote: second, principals: c.principals });
    try {
      // The worker's session from the earlier primary is refused there as fenced (over the wire too): it connects again.
      await refuses("fenced", () => second.sessionInfo(r1.principal, first.sessionId));
      const wire = await rawRequest(transport.url, "GET", "/worker/session/offers", { token: r1.token, headers: { [SESSION_HEADER]: first.sessionId, [PROTOCOL_HEADER]: String(first.protocol) } });
      assert.deepEqual([wire.status, wire.body?.error?.code], [409, "fenced"]);
      const moved = new RemoteWorkerClient({ url: transport.url, token: r1.token, workerVersion: "worker-9.1.0" });
      const s2 = await moved.connect({ ...REMOTE_CAPS } as never);
      assert.equal(s2.primaryEpoch, epoch);
      assert.equal((await second.sessionInfo(r1.principal, s2.sessionId)).primaryEpoch, epoch);
      assert.deepEqual(await moved.offers(), []);
      // The deposed controller does not take the new session either (and its own writes fail on the epoch).
      await refuses("fenced", () => c.remote.sessionInfo(r1.principal, s2.sessionId));
    } finally { second.close(); await transport.close(); }
  });

  suite("the recovery handshake reports the attempts the controller has accepted on the host that the worker did not list, and records them (card H09b)", async (c) => {
    const r1 = await c.host("r1");
    const one = await c.started(r1, "one");
    const two = await c.started(r1, "two", { agent: "bob" });
    const fresh = new RemoteWorkerClient({ url: c.transport.url, token: r1.token, workerVersion: "w" });
    await fresh.connect({ ...REMOTE_CAPS } as never);
    const answer = await fresh.reconcile([{ attemptId: one.attemptId, placement: one.placement }]);
    assert.deepEqual(answer.verdicts.map((v) => [v.attemptId, v.verdict]), [[one.attemptId, "reaccept"]]);
    assert.deepEqual(answer.missing, [{ attemptId: two.attemptId, placement: two.placement }]);
    const record = (await c.storage.getAggregate({ kind: RECONCILE_KIND, id: r1.id }))!.body as unknown as { missing: string[] };
    assert.deepEqual(record.missing, [two.attemptId]);
    // Another host has nothing of this host's reported to it.
    const r2 = await c.host("r2");
    const other = new RemoteWorkerClient({ url: c.transport.url, token: r2.token, workerVersion: "w" });
    await other.connect({ ...REMOTE_CAPS } as never);
    assert.deepEqual((await other.reconcile([])).missing, []);
    // An attempt that ended is not missing.
    await c.remote.end(c.owner, two.attemptId, "test end");
    c.clock.advance(6000);
    assert.deepEqual((await fresh.reconcile([{ attemptId: one.attemptId, placement: one.placement }])).missing, []);
  });

  suite("a poller given what its host holds makes the recovery handshake first in every new session, before any offer is read, and hands the answer over (card H09b)", async (c) => {
    const r1 = await c.host("r1");
    const held = await c.started(r1);
    const answers: ReconcileAnswer[] = [];
    const order: string[] = [];
    const stop = new AbortController();
    const client = new RemoteWorkerClient({ url: c.transport.url, token: r1.token, workerVersion: "w" });
    const tracked = {
      connect: async (caps: never) => { order.push("connect"); return client.connect(caps); },
      reconcile: async (list: readonly { attemptId: string; placement: number }[]) => { order.push("reconcile"); return client.reconcile(list); },
      offers: async (o: { waitMs?: number }) => { order.push("offers"); return client.offers(o); },
      heartbeat: async (n: number) => client.heartbeat(n),
      forgetSession: () => client.forgetSession(),
      get session() { return client.session; },
    };
    const poller = new HostPoller({ client: tracked, capabilities: REMOTE_CAPS, waitMs: 200, heartbeatMs: 60_000, minGapMs: 20, spreadMs: 0, baseBackoffMs: 10, maxBackoffMs: 40, held: () => [{ attemptId: held.attemptId, placement: held.placement }], onReconciled: (a) => { answers.push(a); }, onOffers: async () => undefined });
    const running = poller.run(stop.signal);
    try {
      await until(() => answers.length === 1);
      assert.deepEqual(answers[0]!.verdicts.map((v) => v.verdict), ["reaccept"]);
      assert.deepEqual(order.slice(0, 2), ["connect", "reconcile"], "the handshake is the first thing the new session does");
      assert.equal(order.filter((x) => x === "reconcile").length, 1, "once per session");
      // Another process takes the session: the poller connects again and makes the handshake again in the new session.
      const before = client.session!.sessionId;
      const other = new RemoteWorkerClient({ url: c.transport.url, token: r1.token, workerVersion: "w" });
      await other.connect({ ...REMOTE_CAPS } as never);
      await until(() => answers.length === 2);
      assert.equal(answers.length, 2);
      assert.notEqual(answers[1]!.sessionId, before);
      const second = order.lastIndexOf("connect");
      assert.equal(order[second + 1], "reconcile");
    } finally { stop.abort(); await running; }
  });
}
