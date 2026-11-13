import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { workGrants } from "../dispatch/testing/world.js";
import { RemoteWorkerService, lastingReasons } from "./service.js";
import { wireRefuses, remoteSuite, type Ctx } from "./testing/suite.js";
import { buildRemoteWorld, rawRequest } from "./testing/world.js";

after(stopServer);

/** What the placement policy of these tests says now. */
const policy: { hosts: string[]; fail: boolean } = { hosts: ["host:a"], fail: false };
/** A step run inside the next policy read (the review's race between a poll and an accept). */
const race: { armed: (() => Promise<void>) | undefined } = { armed: undefined };
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

  test(`${backend.name}: a withdrawal whose write fails hands nothing out and loses nothing: the offer is held, the next poll withdraws it and the task is readmitted (card H07b, review)`, async () => {
    const store = await backend.open();
    // Every write fails while `down` is set (the storage is unreachable at the moment of the withdrawal).
    const fault = { down: false };
    const storage = new Proxy(store.storage, { get: (t, k) => {
      const v = (t as unknown as Record<string | symbol, unknown>)[k];
      if (k === "applyOperation") return async (...a: unknown[]) => { if (fault.down) throw new Error("injected: storage unreachable"); return (v as (...x: unknown[]) => unknown).apply(t, a); };
      return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
    } });
    let w: Awaited<ReturnType<typeof buildRemoteWorld>> | undefined;
    try {
      policy.hosts = ["host:a"]; policy.fail = false;
      w = await buildRemoteWorld(storage, { placement: async () => ({ dataHosts: policy.hosts }) });
      const a = await w.host("a");
      a.worker.requirements = () => req;
      const ann = await w.agent("ann", workGrants(w.project, ["read-file", "write-file"]));
      w.prefer(a);
      const { attemptId } = await w.task("Order seeds", ann);
      assert.ok((await w.tick()).started.includes(attemptId!));
      policy.hosts = [];
      fault.down = true;
      assert.deepEqual(await a.client.offers(), [], "not handed out while the withdrawal cannot be written");
      fault.down = false;
      assert.equal((await w.remote.placement(w.owner, attemptId!))!.state, "offered", "nothing half-written");
      assert.equal(w.remote.pollStats(w.dispatcherPrincipal).withdrawn, 0);
      assert.equal(w.remote.offerLoad(w.dispatcherPrincipal, a.id), 1, "the offer is kept for the next poll");
      assert.deepEqual(await a.client.offers(), []);
      assert.equal((await w.remote.placement(w.owner, attemptId!))!.state, "ended");
      assert.equal(w.remote.pollStats(w.dispatcherPrincipal).withdrawn, 1);
      for (let i = 0; i < 100 && (await w.current.get(w.owner, attemptId!))?.state === "running"; i++) await new Promise((r) => setTimeout(r, 20));
      assert.match((await w.current.get(w.owner, attemptId!))!.outcome?.summary ?? "", /withdrawn before it was delivered/);
      policy.hosts = ["host:a"];
      let next: string | undefined;
      for (let i = 0; i < 150 && next === undefined; i++) { if (i > 0) await new Promise((r) => setTimeout(r, 20)); next = (await w.tick()).started.find((id) => id !== attemptId); }
      assert.ok(next !== undefined, "readmitted");
    } finally { await w?.done(); await store.close(); }
  });

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

  suite("an offer is delivered when the policy still lists the host; a policy that cannot be read holds it back (neither delivered nor withdrawn, nor taken up) and the next poll delivers it (card H07b, review)", async (c) => {
    policy.hosts = ["host:a"]; policy.fail = false;
    const a = await c.host("a");
    a.worker.requirements = () => req;
    const ann = await c.agent("ann", workGrants(c.project, ["read-file", "write-file"]));
    c.prefer(a);
    const { attemptId } = await c.task("Order seeds", ann);
    assert.ok((await c.tick()).started.includes(attemptId!));
    assert.equal((await a.client.offers()).length, 1, "listed: delivered");
    policy.fail = true;
    // The policy says who may be given the credential and local-only data, and `place` refuses on the same failure: a read error does not hand the offer out.
    assert.deepEqual(await a.client.offers(), [], "a policy that cannot be read holds the offer back");
    const placement = (await c.remote.placement(c.owner, attemptId!))!;
    await wireRefuses("unavailable", () => a.client.attempt(attemptId!, placement.placement).accept(), 503);
    assert.equal(c.remote.pollStats(c.dispatcherPrincipal).withdrawn, 0);
    assert.equal((await c.remote.placement(c.owner, attemptId!))!.state, "offered", "held, not withdrawn");
    assert.equal(c.remote.offerLoad(c.dispatcherPrincipal, a.id), 1, "the offer is kept for the next poll");
    policy.fail = false;
    assert.equal((await a.client.offers()).length, 1, "read again: delivered");
    await a.client.attempt(attemptId!, placement.placement).accept();
    assert.equal((await c.remote.placement(c.owner, attemptId!))!.state, "accepted");
  }, { placement: async () => { if (policy.fail) throw new Error("the policy store is down"); return { dataHosts: policy.hosts }; } });

  suite("a host that read its offer before the policy changed cannot take it up afterwards: the accept judges it again, withdraws it and the task is readmitted (card H07b, review)", async (c) => {
    policy.hosts = ["host:a"]; policy.fail = false;
    const a = await c.host("a");
    a.worker.requirements = () => req;
    const ann = await c.agent("ann", workGrants(c.project, ["read-file", "write-file"]));
    c.prefer(a);
    const { attemptId } = await c.task("Order seeds", ann);
    assert.ok((await c.tick()).started.includes(attemptId!));
    const [offer] = await a.client.offers();
    assert.ok(offer);
    policy.hosts = [];
    // No poll in between: the host goes straight to accepting what it read earlier.
    await wireRefuses("fenced", () => a.client.attempt(attemptId!, offer.placement).accept(), 409);
    const p = (await c.remote.placement(c.owner, attemptId!))!;
    assert.equal(p.state, "ended");
    assert.match(p.history.at(-1)!.reason, /withdrawn before it was taken up, host:a would now refuse it: .*data-location policy/);
    assert.equal(c.remote.pollStats(c.dispatcherPrincipal).withdrawn, 1);
    for (let i = 0; i < 100 && (await c.current.get(c.owner, attemptId!))?.state === "running"; i++) await new Promise((r) => setTimeout(r, 20));
    assert.match((await c.current.get(c.owner, attemptId!))!.outcome?.summary ?? "", /withdrawn before it was taken up/);
  }, { placement: async () => ({ dataHosts: policy.hosts }) });

  suite("an offer the host takes up while its poll is reading the policy is not ended as withdrawn: the run is the host's, the poll does not hand it out again (card H07b, review)", async (c) => {
    policy.hosts = ["host:a"]; policy.fail = false;
    const a = await c.host("a");
    a.worker.requirements = () => req;
    const ann = await c.agent("ann", workGrants(c.project, ["read-file", "write-file"]));
    c.prefer(a);
    const { attemptId } = await c.task("Order seeds", ann);
    assert.ok((await c.tick()).started.includes(attemptId!));
    const placement = (await c.remote.placement(c.owner, attemptId!))!.placement;
    // The poll's policy read takes the host's accept in between (the accept's own read still sees the host listed), and then answers that the host is no longer listed.
    race.armed = async () => { race.armed = undefined; await a.client.attempt(attemptId!, placement).accept(); policy.hosts = []; };
    assert.deepEqual(await a.client.offers(), [], "not handed out again");
    const p = (await c.remote.placement(c.owner, attemptId!))!;
    assert.equal(p.state, "accepted", JSON.stringify(p.history));
    assert.equal(p.withdrawn, undefined);
    assert.equal(c.remote.pollStats(c.dispatcherPrincipal).withdrawn, 0);
    assert.equal((await c.current.get(c.owner, attemptId!))?.state, "running");
  }, { placement: async () => { const hook = race.armed; if (hook !== undefined) await hook(); return { dataHosts: policy.hosts }; } });

  suite("two polls of one host that read a refused offer at once withdraw it once (card H07b, review)", async (c) => {
    policy.hosts = ["host:a"]; policy.fail = false;
    const a = await c.host("a");
    a.worker.requirements = () => req;
    const ann = await c.agent("ann", workGrants(c.project, ["read-file", "write-file"]));
    c.prefer(a);
    const { attemptId } = await c.task("Order seeds", ann);
    assert.ok((await c.tick()).started.includes(attemptId!));
    policy.hosts = [];
    const both = await Promise.all([a.client.offers(), a.client.offers()]);
    assert.deepEqual(both, [[], []]);
    assert.equal(c.remote.pollStats(c.dispatcherPrincipal).withdrawn, 1, "counted once");
    assert.equal((await c.remote.placement(c.owner, attemptId!))!.state, "ended");
  }, { placement: async () => { await new Promise((r) => setTimeout(r, 20)); return { dataHosts: policy.hosts }; } });

  suite("a hostile worker's completion carrying withdrawn, or a look-alike of it, is refused on the raw wire and the attempt is not readmitted (card H07b, review)", async (c) => {
    const a = await c.host("a");
    const run = await c.started(a);
    const session = a.client.session!;
    const headers = (n: number): Record<string, string> => ({ "x-newt-session": session.sessionId, "x-newt-protocol": String(session.protocol), "idempotency-key": `hostile-${n}` });
    const bodies = [
      `{"placement":${run.placement},"result":{"status":"cancelled","withdrawn":true}}`,
      `{"placement":${run.placement},"result":{"status":"cancelled","Withdrawn":true}}`,
      `{"placement":${run.placement},"result":{"status":"cancelled","\\u0077ithdrawn":true}}`,
      `{"placement":${run.placement},"result":{"status":"cancelled","ｗithdrawn":true}}`,
      `{"placement":${run.placement},"result":{"status":"cancelled","__proto__":{"withdrawn":true}}}`,
      `{"placement":${run.placement},"result":{"status":"cancelled","usage":{"withdrawn":true}},"withdrawn":true}`,
    ];
    for (const [n, rawBody] of bodies.entries()) {
      const r = await rawRequest(c.transport.url, "POST", `/worker/attempts/${run.attemptId}/complete`, { token: a.token, rawBody, headers: headers(n) });
      assert.equal(r.status, 400, `${rawBody} -> ${r.status} ${r.raw.toString("utf8")}`);
    }
    const p = (await c.remote.placement(c.owner, run.attemptId))!;
    assert.equal(p.state, "accepted", "nothing was recorded");
    assert.equal(p.withdrawn, undefined);
    assert.equal((await c.current.get(c.owner, run.attemptId))?.state, "running");
  });

  suite("an offer withdrawn before any host took it up leaves the agent's store unclaimed: the readmitted attempt starts on another listed host; once a host took the store up it stays pinned there (card H07b)", async (c) => {
    policy.hosts = ["host:a", "host:b"]; policy.fail = false;
    const a = await c.host("a"), b = await c.host("b");
    a.worker.requirements = () => req; b.worker.requirements = () => req;
    const ann = await c.agent("ann", workGrants(c.project, ["read-file", "write-file"]));
    c.prefer(a);
    const first = await c.task("Order seeds", ann);
    assert.ok((await c.tick()).started.includes(first.attemptId!));
    const store = async (): Promise<{ ownerHostId: string; unused?: boolean; liveAttempt?: string }> => (await c.storage.getAggregate({ kind: "remote-store", id: ann.id }))!.body as never;
    assert.deepEqual([(await store()).ownerHostId, (await store()).unused], [a.id, true], "an offer claims the store, marked as not taken up");
    // While that offer is live the claim is not up for grabs: a second attempt of the same agent is not started anywhere (not on b, which is listed and idle), and the claim stays a's.
    const rival = await c.task("Water beans", ann);
    const report = await c.tick();
    assert.equal(report.started.includes(rival.attemptId!), false, JSON.stringify(report.skipped));
    assert.equal(await c.remote.placement(c.owner, rival.attemptId!), undefined, "nothing was offered to b for the rival");
    assert.deepEqual([(await store()).ownerHostId, (await store()).liveAttempt], [a.id, first.attemptId], "still a's, held by the first attempt");
    // The owner takes host:a out of the policy before it reads the offer: the offer is withdrawn, and the claim pins nothing.
    policy.hosts = ["host:b"];
    assert.deepEqual(await a.client.offers(), []);
    assert.equal((await c.remote.placement(c.owner, first.attemptId!))!.state, "ended");
    assert.equal(await c.remote.storeOwner(c.dispatcherPrincipal, ann.id, "att-zzzzzzzzzzzzzzzzzzzz"), undefined, "an unused claim pins the agent nowhere");
    let next: string | undefined;
    for (let i = 0; i < 150 && next === undefined; i++) { if (i > 0) await new Promise((r) => setTimeout(r, 20)); next = (await c.tick()).started.find((id) => id !== first.attemptId); }
    assert.ok(next !== undefined, "readmitted and started on the other listed host");
    assert.equal((await c.remote.placement(c.owner, next!))!.hostId, b.id);
    assert.deepEqual([(await store()).ownerHostId, (await store()).unused], [b.id, true], "the claim moved with the placement");
    // B takes the offer up: the store is now real there and no longer unused.
    const offers = await b.client.offers();
    assert.equal(offers.length, 1);
    await b.client.attempt(next!, offers[0]!.placement).accept();
    assert.equal((await store()).unused, undefined);
    assert.deepEqual(await c.remote.storeOwner(c.dispatcherPrincipal, ann.id, "att-zzzzzzzzzzzzzzzzzzzz"), { hostId: b.id, busy: true }, "taken up, it pins the agent to b while that attempt lives");
  }, { placement: async () => ({ dataHosts: policy.hosts }) });

  suite("forced race: an accept on A that began before the lease of its offer ran out is fenced once another attempt of the agent took the unused claim on B, so the agent never runs on two hosts at once (card H07b, review)", async (c) => {
    policy.hosts = ["host:a", "host:b"]; policy.fail = false;
    const a = await c.host("a"), b = await c.host("b");
    a.worker.requirements = () => req; b.worker.requirements = () => req;
    const ann = await c.agent("ann", workGrants(c.project, ["read-file", "write-file"]));
    c.prefer(a);
    const first = await c.task("Order seeds", ann);
    assert.ok((await c.tick()).started.includes(first.attemptId!));
    const offers = await a.client.offers();
    assert.equal(offers.length, 1);
    // The offer carries a lease (as an attempt with a time limit has): one minute from now.
    const ref = { kind: "remote-placement", id: first.attemptId! };
    const found = (await c.storage.getAggregate(ref))!;
    const expiresAt = new Date(Date.parse(c.clock.now()) + 60_000).toISOString();
    await c.storage.applyOperation({ operationId: "op-lease", epoch: c.epoch, actor: "owner:rob", correlationId: "co-lease", at: c.clock.now(), changes: [{ type: "update", ref, expectedRevision: found.revision, body: { ...found.body, expiresAt } }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
    const store = async (): Promise<{ ownerHostId: string; unused?: boolean; liveAttempt?: string }> => (await c.storage.getAggregate({ kind: "remote-store", id: ann.id }))!.body as never;
    let rival: string | undefined;
    // A has passed the lease check of its accept and the policy is being read when the lease runs out; meanwhile another attempt of the agent is started, on B, and takes the claim nobody used.
    race.armed = async () => {
      race.armed = undefined;
      c.clock.advance(61_000);
      c.prefer(b);
      await c.task("Water beans", ann);
      // The dispatcher's stop of the first attempt does not reach the storage (it is told again later; here it never lands before the rival starts).
      const service = c.remote as unknown as { end: unknown };
      const realEnd = service.end;
      service.end = async () => { throw new Error("injected: the stop did not reach the storage"); };
      try {
        for (let i = 0; i < 150 && rival === undefined; i++) { if (i > 0) await new Promise((r) => setTimeout(r, 20)); await c.tick(); const held = await store(); if (held.ownerHostId === b.id && held.liveAttempt !== undefined && held.liveAttempt !== first.attemptId) rival = held.liveAttempt; }
      } finally { service.end = realEnd; }
    };
    await wireRefuses("fenced", () => a.client.attempt(first.attemptId!, offers[0]!.placement).accept());
    assert.ok(rival !== undefined, "the rival was started meanwhile");
    assert.equal((await c.remote.placement(c.owner, rival!))!.hostId, b.id);
    assert.equal((await c.remote.placement(c.owner, first.attemptId!))!.state, "offered", "the late accept did not take the attempt up on A");
    assert.deepEqual([(await store()).ownerHostId, (await store()).unused, (await store()).liveAttempt], [b.id, true, rival], "the claim is B's and still unused: A's accept did not mark it as taken up");
  }, { placement: async () => { const hook = race.armed; if (hook !== undefined) await hook(); return { dataHosts: policy.hosts }; } });

  test(`${backend.name}: forced race on the storage: a controller whose clock runs ahead places another attempt of the agent on B while A's accept is being written; the accept loses on the store's revision, is decided again and fenced by the claim, not by its own clock (card H07b, review)`, async () => {
    const store = await backend.open();
    // The barrier: the first time A's accept is about to be written, the step runs first (a second writer that commits in between).
    const barrier: { attemptId?: string; step?: (() => Promise<void>) | undefined } = {};
    const storage = new Proxy(store.storage, { get: (t, k) => {
      const v = (t as unknown as Record<string | symbol, unknown>)[k];
      if (k === "applyOperation") return async (...a: unknown[]) => {
        const op = a[0] as { changes?: readonly { ref: { kind: string; id: string }; body?: { state?: string } }[] };
        const step = barrier.step;
        if (step !== undefined && op.changes?.some((ch) => ch.ref.kind === "remote-placement" && ch.ref.id === barrier.attemptId && ch.body?.state === "accepted") === true) { barrier.step = undefined; await step(); }
        return (v as (...x: unknown[]) => unknown).apply(t, a);
      };
      return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
    } });
    let w: Awaited<ReturnType<typeof buildRemoteWorld>> | undefined;
    try {
      policy.hosts = ["host:a", "host:b"]; policy.fail = false;
      w = await buildRemoteWorld(storage, { placement: async () => ({ dataHosts: policy.hosts }) });
      const world = w;
      const a = await world.host("a"), b = await world.host("b");
      a.worker.requirements = () => req; b.worker.requirements = () => req;
      const ann = await world.agent("ann", workGrants(world.project, ["read-file", "write-file"]));
      world.prefer(a);
      const first = await world.task("Order seeds", ann);
      assert.ok((await world.tick()).started.includes(first.attemptId!));
      const offers = await a.client.offers();
      assert.equal(offers.length, 1);
      const ref = { kind: "remote-placement", id: first.attemptId! };
      const found = (await storage.getAggregate(ref))!;
      await storage.applyOperation({ operationId: "op-lease", epoch: world.epoch, actor: "owner:rob", correlationId: "co-lease", at: world.clock.now(), changes: [{ type: "update", ref, expectedRevision: found.revision, body: { ...found.body, expiresAt: new Date(Date.parse(world.clock.now()) + 60_000).toISOString() } }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
      const held = async (): Promise<{ ownerHostId: string; unused?: boolean; liveAttempt?: string }> => (await storage.getAggregate({ kind: "remote-store", id: ann.id }))!.body as never;
      let rival: string | undefined;
      barrier.attemptId = first.attemptId!;
      barrier.step = async () => {
        // The other writer's clock is ahead: to it the lease has run out (and its stop of the first attempt does not land); then the clocks agree again, so to A's controller the lease still runs.
        world.clock.advance(61_000);
        world.prefer(b);
        await world.task("Water beans", ann);
        const service = world.remote as unknown as { end: unknown };
        const realEnd = service.end;
        service.end = async () => { throw new Error("injected: the stop did not reach the storage"); };
        try {
          for (let i = 0; i < 150 && rival === undefined; i++) { if (i > 0) await new Promise((r) => setTimeout(r, 20)); await world.tick(); const h = await held(); if (h.ownerHostId === b.id && h.liveAttempt !== undefined && h.liveAttempt !== first.attemptId) rival = h.liveAttempt; }
        } finally { service.end = realEnd; world.clock.advance(-61_000); }
      };
      await wireRefuses("fenced", () => a.client.attempt(first.attemptId!, offers[0]!.placement).accept());
      assert.equal(barrier.step, undefined, "the accept reached the storage while the rival was placed");
      assert.ok(rival !== undefined, "the rival was placed on B in between");
      assert.equal((await world.remote.placement(world.owner, first.attemptId!))!.state, "offered", "not taken up on A");
      assert.deepEqual([(await held()).ownerHostId, (await held()).unused, (await held()).liveAttempt], [b.id, true, rival]);
    } finally { await w?.done(); await store.close(); }
  });

  suite("a worker cannot mark its own result as withdrawn: the field is refused on the wire (card H07b)", async (c) => {
    const a = await c.host("a");
    const run = await c.started(a);
    await wireRefuses("invalid_command", () => (run.attempt as unknown as { complete(r: unknown): Promise<unknown> }).complete({ status: "cancelled", withdrawn: true }), 400);
  });
}

test("a reason lasts unless it is exactly one of the passing sentences: a lasting reason that merely quotes one inside a name is still lasting (card H07b)", () => {
  for (const passing of ["host:a has not connected to the controller", "host:a has not been heard from recently (stale)", "host:a has not announced its capabilities", "host:a already has 32 offers that are not accepted", "host:a has not received the restored conversation store of att-aaaaaaaaaaaaaaaaaaaa yet"]) {
    assert.equal(lastingReasons([passing]), false, passing);
  }
  // A harness or workspace named after a passing sentence, text after it, or text before it.
  for (const lasting of ["host:a does not have the has not connected to the controller harness", "host:a has not connected to the controller, and is revoked", "the attempt's credential may not be given to host:a (host:b has not connected to the controller)", "host:a is revoked", "the workspace bound to host:b has not connected to the controller", "a repository named x already has 3 offers that are not accepted"]) {
    assert.equal(lastingReasons([lasting]), true, lasting);
  }
  assert.equal(lastingReasons(["host:a has not connected to the controller", "host:a is revoked"]), true, "one lasting reason among passing ones lasts");
  assert.equal(lastingReasons([]), false);
});
