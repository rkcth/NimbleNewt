import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { workGrants } from "../dispatch/testing/world.js";
import { WorkerRequestError } from "./client.js";
import { HostPoller, type PollerOptions } from "./poller.js";
import { DEFAULT_WORKER_TRANSPORT_LIMITS } from "./server.js";
import { REMOTE_LIMITS, type Offer } from "./protocol.js";
import { REMOTE_CAPS } from "./testing/world.js";
import { remoteSuite, refuses, wireRefuses, type Ctx } from "./testing/suite.js";
import type { RemoteHost } from "./testing/world.js";

after(stopServer);

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const seeded = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const never = new AbortController().signal;

/** A new task for agent ann, ticked until the dispatcher starts it on `host` and has offered it (the worker has not accepted yet). */
const offered = async (c: Ctx, host: RemoteHost, title = "Order seeds"): Promise<string> => {
  const ann = await c.agent(`ann${title.length}${Math.floor(Math.random() * 1e6)}`, workGrants(c.project, ["read-file", "write-file"]));
  c.prefer(host);
  const { attemptId } = await c.task(title, ann);
  const report = await c.tick();
  assert.ok(report.started.includes(attemptId!), JSON.stringify(report));
  return attemptId!;
};

for (const backend of backends) {
  const suite = remoteSuite(backend);

  suite("an offers poll is held until an offer is made to the host, then answered at once; it times out empty; the wait is bounded (card H07)", async (c) => {
    const h = await c.host("h1");
    const quiet = Date.now();
    assert.deepEqual(await h.client.offers({ waitMs: 150 }), []);
    assert.ok(Date.now() - quiet >= 130, "held for the wait");
    assert.equal(c.remote.pollStats(c.dispatcherPrincipal).timedOut, 1);
    // A held poll is answered when the dispatcher offers the host an attempt.
    const poll = h.client.offers({ waitMs: 20_000 });
    let early = false; void poll.then(() => { early = true; });
    await sleepMs(100);
    assert.equal(early, false);
    assert.equal(c.remote.pollStats(c.dispatcherPrincipal).open, 1);
    const attemptId = await offered(c, h);
    const started = Date.now();
    const got = await poll;
    assert.ok(Date.now() - started < 3000, "answered by the offer, not by the clock");
    assert.deepEqual(got.map((o) => o.order.attemptId), [attemptId]);
    assert.equal(c.remote.pollStats(c.dispatcherPrincipal).open, 0);
    // With an offer waiting, a poll answers at once.
    const again = Date.now();
    assert.equal((await h.client.offers({ waitMs: 20_000 })).length, 1);
    assert.ok(Date.now() - again < 1000);
    // The wait is a whole number of milliseconds up to the limit; nothing else is a parameter.
    await wireRefuses("invalid_command", () => h.client.send("GET", `/worker/session/offers?wait=${REMOTE_LIMITS.pollMs + 1}`, { session: true }), 400);
    await wireRefuses("invalid_command", () => h.client.send("GET", "/worker/session/offers?wait=-5", { session: true }), 400);
    await wireRefuses("invalid_command", () => h.client.send("GET", "/worker/session/offers?wait=abc", { session: true }), 400);
    await wireRefuses("invalid_command", () => h.client.send("GET", "/worker/session/offers?after=1", { session: true }), 400);
  });

  suite("a host has one held poll: a newer poll takes over and the earlier one ends empty; a new session ends the old one as fenced; stopping ends them all (card H07)", async (c) => {
    const h = await c.host("h1");
    const first = h.client.offers({ waitMs: 20_000 });
    await sleepMs(50);
    const second = h.client.offers({ waitMs: 20_000 });
    assert.deepEqual(await first, [], "the earlier poll is ended by the newer one");
    await sleepMs(30);
    const stats = c.remote.pollStats(c.dispatcherPrincipal);
    assert.deepEqual([stats.open, stats.superseded], [1, 1]);
    // The same credential connecting again is a new session: the poll of the old one is fenced.
    const other = new (h.client.constructor as new (o: never) => typeof h.client)({ url: c.transport.url, token: h.token, workerVersion: "worker-9.1.0" } as never);
    await other.connect({ ...REMOTE_CAPS } as never);
    await assert.rejects(second, (e: unknown) => e instanceof WorkerRequestError && e.fenced);
    // Stopping the service ends a held poll without error (the transport is closing too).
    const third = other.offers({ waitMs: 20_000 });
    await sleepMs(50);
    c.remote.close();
    assert.deepEqual(await third, []);
  });

  suite("a poller connects, heartbeats and hands the offers over as they are made, with one held request at a time and no per-attempt polling (card H07)", async (c) => {
    const h = await c.host("h1", { connect: false });
    const seen: Offer[] = [];
    const stop = new AbortController();
    const poller = new HostPoller({ client: h.client, capabilities: REMOTE_CAPS, waitMs: 2000, heartbeatMs: 400, minGapMs: 0, spreadMs: 0, onOffers: async (o) => { seen.push(...o); } });
    const running = poller.run(stop.signal);
    await sleepMs(300);
    assert.ok(h.client.session !== undefined, "connected");
    assert.equal((await c.hosts.status(c.dispatcherPrincipal, h.id))?.freshness, "fresh", "heartbeats went");
    const attemptId = await offered(c, h);
    for (let i = 0; i < 100 && seen.length === 0; i++) await sleepMs(20);
    assert.deepEqual(seen.map((o) => o.order.attemptId), [attemptId]);
    // Accepted, the offer is not offered again; the poller keeps one poll open.
    await h.client.attempt(attemptId, seen[0]!.placement).accept();
    await sleepMs(300);
    assert.equal(seen.length >= 1 && seen.every((o) => o.order.attemptId === attemptId), true);
    assert.ok(c.remote.pollStats(c.dispatcherPrincipal).open <= 1);
    stop.abort();
    await running;
  });

  suite("a poller reconnects after its session is replaced, and waits the longest when the controller refuses its credential (card H07)", async (c) => {
    const h = await c.host("h1");
    const delays: number[] = []; const troubles: string[] = [];
    const stop = new AbortController();
    const poller = new HostPoller({
      client: h.client, capabilities: REMOTE_CAPS, waitMs: 5000, heartbeatMs: 60_000, minGapMs: 0, spreadMs: 0, random: seeded(7), baseBackoffMs: 10, maxBackoffMs: 40,
      sleep: async (ms, signal) => { delays.push(ms); await Promise.race([sleepMs(Math.min(ms, 20)), new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }))]); },
      onOffers: async () => undefined, onTrouble: (e) => { troubles.push(`${e.kind}:${e.error instanceof WorkerRequestError ? e.error.code : "other"}`); },
    });
    const running = poller.run(stop.signal);
    await sleepMs(200);
    const before = h.client.session!.sessionId;
    // Another process connects with the same credential: the poller's session is gone.
    const other = new (h.client.constructor as new (o: never) => typeof h.client)({ url: c.transport.url, token: h.token, workerVersion: "worker-9.1.0" } as never);
    await other.connect({ ...REMOTE_CAPS } as never);
    for (let i = 0; i < 100 && (h.client.session === undefined || h.client.session.sessionId === before); i++) await sleepMs(20);
    assert.notEqual(h.client.session?.sessionId, before, "it connected again");
    assert.ok(troubles.some((t) => t === "poll:fenced"), JSON.stringify(troubles));
    // A revoked credential is not hammered: the delay is the longest backoff.
    await c.principals.disable(c.owner, { commandId: "dis-h1", principalId: h.id, expectedRevision: (await c.principals.get(h.id))!.revision });
    const mark = delays.length;
    for (let i = 0; i < 100 && delays.length === mark; i++) await sleepMs(20);
    await sleepMs(50);
    assert.ok(delays.slice(mark).every((d) => d >= 30 && d <= 40) && delays.length > mark, JSON.stringify(delays.slice(mark)));
    stop.abort();
    await running;
  });

  suite("placement looks only at hosts of the platform an attempt needs and says plainly why the others cannot take it, and what a platform nobody has means (card H07)", async (c) => {
    const l1 = await c.host("lin1"), l2 = await c.host("lin2"), l3 = await c.host("lin3");
    const d1 = await c.host("mac1", { caps: { ...REMOTE_CAPS, os: "darwin", arch: "arm64" } }), d2 = await c.host("mac2", { caps: { ...REMOTE_CAPS, os: "darwin", arch: "arm64" } });
    const noPi = await c.host("lin-nopi", { caps: { ...REMOTE_CAPS, harnesses: [{ name: "other", version: "1" }] } });
    const query = (requirements: Record<string, unknown>) => ({ taskId: "task-aaaaaaaaaaaaaaaaaaaa", projectId: c.project, agentId: "agent:ann", requirements: { data: "cloud-allowed", ...requirements } as never });
    const linux = await c.remote.candidates(c.dispatcherPrincipal, query({ os: "linux", arch: "x64", harness: "pi" }));
    assert.deepEqual([...linux.eligible].sort(), [l1.id, l2.id, l3.id]);
    assert.equal(linux.considered, 4, "the four linux hosts only; the two Macs were not looked at");
    assert.deepEqual(linux.refused.map((r) => r.hostId), [noPi.id]);
    assert.match(linux.refused[0]!.reasons.join(";"), /does not have the pi harness/);
    assert.equal(linux.waiting, undefined);
    // A platform nobody has: nothing eligible, and the answer says what is connected.
    const win = await c.remote.candidates(c.dispatcherPrincipal, query({ os: "win32", arch: "x64" }));
    assert.deepEqual([win.eligible.length, win.considered], [0, 0]);
    assert.match(win.waiting!, /no connected host runs win32\/x64 \(connected: darwin\/arm64 x2, linux\/x64 x4\); the attempt waits until one connects/);
    // Hosts of the right platform that cannot take it now: the reasons are listed.
    const inactive = await c.remote.candidates(c.dispatcherPrincipal, query({ os: "darwin", arch: "arm64", isolation: ["landlock"] }));
    assert.equal(inactive.eligible.length, 0);
    assert.match(inactive.waiting!, /2 host\(s\) run darwin\/arm64 but none can take the attempt now \(.*does not offer landlock isolation/);
    // A host that has stopped being heard from, or was revoked, drops out; the load orders the rest.
    await c.principals.disable(c.owner, { commandId: "dis-d1", principalId: d1.id, expectedRevision: (await c.principals.get(d1.id))!.revision });
    const mac = await c.remote.candidates(c.dispatcherPrincipal, query({ os: "darwin" }));
    assert.deepEqual(mac.eligible, [d2.id]);
    assert.match(mac.refused[0]!.reasons.join(";"), /is revoked/);
    await refuses("forbidden", () => c.remote.candidates(l1.principal, query({})) as never);
  });

  suite("with no placement policy at all local-only data is never placed on a remote host, and other data goes to any capable host (card H07)", async (c) => {
    const [h1, h2, h3] = [await c.host("h1"), await c.host("h2"), await c.host("h3")];
    const query = (data: "local-only" | "cloud-allowed") => ({ taskId: "task-aaaaaaaaaaaaaaaaaaaa", projectId: c.project, agentId: "agent:ann", requirements: { data, harness: "pi" } });
    const closed = await c.remote.candidates(c.dispatcherPrincipal, query("local-only"));
    assert.equal(closed.eligible.length, 0);
    assert.equal(closed.refused.length, 3);
    assert.match(closed.refused[0]!.reasons.join(";"), /data is local-only and the data-location policy does not list/);
    assert.equal((await c.remote.candidates(c.dispatcherPrincipal, query("cloud-allowed"))).eligible.length, 3);
    void h1; void h2; void h3;
  }, { placement: null });

  suite("candidates order the eligible hosts by their waiting offers, fewest first (card H07)", async (c) => {
    const [h1, h2] = [await c.host("h1"), await c.host("h2")];
    await offered(c, h1);
    const q = { taskId: "task-aaaaaaaaaaaaaaaaaaaa", projectId: c.project, agentId: "agent:ann", requirements: { data: "cloud-allowed" as const, harness: "pi" } };
    assert.deepEqual((await c.remote.candidates(c.dispatcherPrincipal, q)).eligible, [h2.id, h1.id]);
  });

  for (const delay of [0, 1, 3, 6, 12, 25]) {
    suite(`a poll started ${delay} ms into the making of an offer is answered by it, not after the whole wait (card H07)`, async (c) => {
      const h = await c.host("h1");
      const made = offered(c, h);
      await sleepMs(delay);
      const t = Date.now();
      const got = await h.client.offers({ waitMs: 4000 });
      await made;
      assert.ok(got.length > 0 || (await h.client.offers()).length > 0, "the offer is there");
      assert.ok(Date.now() - t < 2500, `${Date.now() - t} ms`);
    });
  }

  suite("a stopped service answers polls at once and holds none (card H07)", async (c) => {
    const h = await c.host("h1");
    const held = h.client.offers({ waitMs: 20_000 });
    await sleepMs(50);
    c.remote.close();
    assert.deepEqual(await held, []);
    const t = Date.now();
    assert.deepEqual(await h.client.offers({ waitMs: 20_000 }), []);
    assert.ok(Date.now() - t < 2000);
    assert.equal(c.remote.pollStats(c.dispatcherPrincipal).open, 0);
  });

  suite("with a policy in force local-only data goes only to listed hosts, and the dispatcher's start on another host is refused with the reasons and offers nothing (card H07)", async (c) => {
    const a = await c.host("a"), b = await c.host("b"), d = await c.host("d");
    const req = { data: "local-only" as const, harness: "pi" };
    const query = { taskId: "task-aaaaaaaaaaaaaaaaaaaa", projectId: c.project, agentId: "agent:ann", requirements: req };
    const result = await c.remote.candidates(c.dispatcherPrincipal, query);
    assert.deepEqual(result.eligible, [b.id], JSON.stringify(result));
    const reasons = Object.fromEntries(result.refused.map((r) => [r.hostId, r.reasons.join(";")]));
    assert.match(reasons[a.id]!, /credential may not be given to host:a/);
    assert.match(reasons[a.id]!, /data is local-only and the data-location policy does not list host:a/);
    assert.match(reasons[d.id]!, /has no access to the project's repository/);
    assert.doesNotMatch(reasons[d.id]!, /credential/);
    // The dispatcher is made to try host a first: its placement is refused, nothing is offered to a, and the reason is on the skipped attempt.
    a.worker.requirements = () => req; b.worker.requirements = () => req;
    const ann = await c.agent("ann", workGrants(c.project, ["read-file", "write-file"]));
    c.prefer(a);
    const { attemptId } = await c.task("Order seeds", ann);
    const report = await c.tick();
    assert.equal(report.started.includes(attemptId!), false);
    assert.match(report.skipped.find((x) => x.attemptId === attemptId)?.reason ?? "", /host:a cannot take attempt .*credential may not be given to host:a; .*data is local-only/);
    assert.deepEqual(await a.client.offers(), [], "the credential was not put in an offer for a host the policy does not allow");
  }, { placement: async () => ({ credentialHosts: ["host:b", "host:d"], dataHosts: ["host:b"], repositoryHosts: ["host:a", "host:b"] }) });

  if (backend === backends[0]) {
    suite("one hundred idle hosts cost the controller about one held request each, in no more requests than the wait allows, however many agents there are (card H07)", async (c) => {
      const hosts: RemoteHost[] = [];
      for (let i = 0; i < 100; i++) hosts.push(await c.host(`h${i}`, { connect: false, dispatcher: false }));
      const stop = new AbortController();
      const troubles: string[] = [];
      const waitMs = 6000;
      const runs = hosts.map((h, i) => new HostPoller({ client: h.client, capabilities: REMOTE_CAPS, waitMs, heartbeatMs: 30_000, minGapMs: 0, spreadMs: 100, random: seeded(i + 1), onOffers: async () => undefined, onTrouble: (e) => { troubles.push(String((e.error as Error).message ?? e.error)); } }).run(stop.signal));
      // Connecting a hundred hosts is a few hundred commands on one store; wait until they all hold a poll, then look at a window.
      for (let i = 0; i < 1200 && c.remote.pollStats(c.dispatcherPrincipal).open < 95; i++) await sleepMs(50);
      const mid = c.remote.pollStats(c.dispatcherPrincipal);
      if (mid.open < 95) { stop.abort(); await Promise.all(runs); }
      assert.ok(troubles.length === 0, `trouble: ${troubles.length} first: ${troubles[0]}`);
      assert.ok(mid.open >= 95 && mid.open <= 100, `one held poll per host: ${mid.open}`);
      const windowMs = 12_000;
      await sleepMs(windowMs);
      const end = c.remote.pollStats(c.dispatcherPrincipal);
      // A reconnect burst: every host's session is replaced at once (as after a network blip), each poll ends fenced, and the pollers connect again on their own jitter, inside the default limits.
      const before = troubles.length;
      const Client = hosts[0]!.client.constructor as new (o: never) => typeof hosts[0]['client'];
      await Promise.all(hosts.map((h) => new Client({ url: c.transport.url, token: h.token, workerVersion: "worker-9.1.0" } as never).connect({ ...REMOTE_CAPS } as never)));
      for (let i = 0; i < 1200 && hosts.some((h) => h.client.session === undefined); i++) await sleepMs(50);
      for (let i = 0; i < 1200 && c.remote.pollStats(c.dispatcherPrincipal).open < 95; i++) await sleepMs(50);
      assert.ok(c.remote.pollStats(c.dispatcherPrincipal).open >= 95, "hosts hold polls again after the burst");
      assert.ok(troubles.slice(before).every((t) => !/too many requests/.test(t)), "the burst was not refused by the limits");
      assert.ok(troubles.length - before >= 50, "the burst really fenced the pollers");
      stop.abort();
      await Promise.all(runs);
      // 6 s at 3 s a poll is 2 or 3 polls a host, not hundreds: no loop of requests and no one-per-agent polling.
      const used = end.polls - mid.polls;
      assert.ok(used <= 100 * (windowMs / waitMs + 2), `${used} polls from 100 idle hosts in ${windowMs} ms`);
      assert.ok(used >= 100 * 1.5, `${used}`);
      assert.equal(end.superseded, 0, "no host ever had two polls at once");
      assert.equal((await Promise.all(hosts.slice(0, 5).map((h) => c.hosts.status(c.dispatcherPrincipal, h.id)))).every((s) => s?.freshness === "fresh"), true);
      // A reconnect burst: every host's session is replaced at once; each poll ends fenced, and the pollers connect again spread by their own jitter.
    });
  }
}

// ---- the poller's schedule, with no network ------------------------------------------------------------------------------------------

interface FakeClient { session: unknown; connects: number; forgets: number; offerCalls: number; connect(c: never): Promise<unknown>; heartbeat(n: number): Promise<void>; offers(o: { waitMs?: number }): Promise<Offer[]>; forgetSession(): void }
const fake = (script: { connect?: (n: number) => unknown; offers?: (n: number) => unknown }): FakeClient => {
  const f: FakeClient = {
    session: undefined, connects: 0, forgets: 0, offerCalls: 0,
    connect: async () => { f.connects++; const r = script.connect?.(f.connects); if (r instanceof Error) throw r; f.session = { sessionId: `s${f.connects}` }; return f.session; },
    heartbeat: async () => undefined,
    offers: async () => { f.offerCalls++; const r = script.offers?.(f.offerCalls); if (r instanceof Error) throw r; return (r as Offer[] | undefined) ?? []; },
    forgetSession: () => { f.forgets++; f.session = undefined; },
  };
  return f;
};
const poller = (client: FakeClient, extra: Partial<PollerOptions> = {}): HostPoller => new HostPoller({ client: client as never, capabilities: REMOTE_CAPS, onOffers: async () => undefined, ...extra });

test("the backoff is a random part of a ceiling that doubles to a maximum, never less than the controller's retry-after (card H07)", () => {
  const p = poller(fake({}), { baseBackoffMs: 1000, maxBackoffMs: 60_000, random: () => 0.999999 });
  assert.deepEqual([1, 2, 3, 4, 7, 8, 50].map((n) => p.backoff(n)), [999, 1999, 3999, 7999, 59_999, 59_999, 59_999]);
  assert.equal(poller(fake({}), { random: () => 0 }).backoff(5), 0, "full jitter reaches zero");
  assert.equal(poller(fake({}), { random: () => 0 }).backoff(5, 3000), 3000);
  const r = seeded(1); const q = poller(fake({}), { baseBackoffMs: 1000, maxBackoffMs: 8000, random: r });
  for (let n = 1; n < 10; n++) for (let i = 0; i < 50; i++) { const d = q.backoff(n); assert.ok(d >= 0 && d < Math.min(8000, 1000 * 2 ** (n - 1)), `${n}: ${d}`); }
  assert.throws(() => poller(fake({}), { waitMs: REMOTE_LIMITS.pollMs + 1 }), /waitMs/);
});

test("failures back off with growing ceilings and reset after a success; a refused protocol or credential waits the longest; a fenced session is dropped and connected again (card H07)", async () => {
  const delays: number[] = [];
  const stop = new AbortController();
  let calls = 0;
  const client = fake({
    connect: (n) => (n <= 3 ? new WorkerRequestError(503, "unavailable", "down") : n === 4 ? undefined : n === 5 ? new WorkerRequestError(426, "protocol_unsupported", "too old") : undefined),
    offers: (n) => { calls++; return n === 2 ? new WorkerRequestError(409, "fenced", "not the current session") : n >= 4 ? (stop.abort(), undefined) : undefined; },
  });
  const p = poller(client, { random: () => 0.999999, baseBackoffMs: 100, maxBackoffMs: 1000, minGapMs: 0, spreadMs: 0, sleep: async (ms) => { delays.push(ms); } });
  await p.run(stop.signal);
  // Three failed connects: ceilings 100, 200, 400. Then a session, a poll, a fenced poll (session dropped, a first-failure ceiling again), a reconnect.
  assert.deepEqual(delays.slice(0, 4), [0, 99, 199, 399]);
  assert.equal(client.forgets, 1);
  assert.equal(delays[4], 99, "the failure count started again after the successful poll");
  assert.ok(client.connects >= 5 && calls >= 4);
  // A refused protocol is not retried quickly.
  const stop2 = new AbortController(); const delays2: number[] = [];
  const c2 = fake({ connect: () => new WorkerRequestError(426, "protocol_unsupported", "too old") });
  await poller(c2, { random: () => 0, baseBackoffMs: 100, maxBackoffMs: 777, spreadMs: 0, sleep: async (ms) => { delays2.push(ms); if (delays2.length >= 3) stop2.abort(); } }).run(stop2.signal);
  assert.equal(delays2[0], 0); assert.ok(delays2.slice(1).every((d) => d >= 582 && d <= 777), JSON.stringify(delays2));
  const stop3 = new AbortController(); const delays3: number[] = [];
  await poller(fake({ connect: () => new WorkerRequestError(401, "unauthenticated", "no") }), { random: () => 0, maxBackoffMs: 555, spreadMs: 0, sleep: async (ms) => { delays3.push(ms); if (delays3.length >= 2) stop3.abort(); } }).run(stop3.signal);
  assert.equal(delays3[0], 0); assert.ok(delays3[1]! >= 416 && delays3[1]! <= 555, JSON.stringify(delays3));
});

test("a controller that answers a poll at once cannot make a loop of requests: polls are at least minGap apart, and heartbeats shorten a hold instead of going late (card H07)", async () => {
  const slept: number[] = []; let clock = 0; const holds: number[] = []; const stop = new AbortController();
  const client = fake({ offers: () => { if (holds.length >= 4) stop.abort(); return undefined; } });
  const originalOffers = client.offers.bind(client);
  client.offers = async (o) => { holds.push(o.waitMs ?? -1); return originalOffers(o); };
  await poller(client, { waitMs: 20_000, heartbeatMs: 15_000, minGapMs: 1000, spreadMs: 0, now: () => clock, sleep: async (ms) => { slept.push(ms); clock += ms; } }).run(stop.signal);
  assert.ok(slept.filter((m) => m > 0).length >= 3 && slept.filter((m) => m > 0).every((m) => m === 1000), JSON.stringify(slept));
  assert.equal(holds[0], 15_000, "never held past the next heartbeat");
  assert.ok(holds.every((h) => h <= 15_000));
});

test("a hundred hosts starting or coming back together are spread over the window, not a burst (card H07)", async () => {
  const hosts = 100; const spread = 10_000;
  const first: number[] = []; const retry: number[] = [];
  await Promise.all(Array.from({ length: hosts }, async (_, i) => {
    const stop = new AbortController(); const random = seeded(1000 + i * 7919); let n = 0;
    const client = fake({ connect: (k) => (k === 1 ? new WorkerRequestError(503, "unavailable", "restarting") : undefined) });
    await poller(client, { random, spreadMs: spread, baseBackoffMs: 1000, maxBackoffMs: 60_000, minGapMs: 1000, sleep: async (ms) => { n++; if (n === 1) first.push(ms); else if (n === 2) retry.push(ms); else stop.abort(); } }).run(stop.signal);
  }));
  const bucket = (xs: number[], width: number, count: number): number[] => { const b = new Array<number>(count).fill(0); for (const x of xs) b[Math.min(count - 1, Math.floor(x / width))]!++; return b; };
  const a = bucket(first, spread / 10, 10);
  assert.ok(first.every((x) => x >= 0 && x < spread));
  assert.ok(a.every((n) => n <= 25) && a.filter((n) => n > 0).length >= 9, `first connection: ${a}`);
  const b = bucket(retry, 200, 5);
  assert.ok(retry.every((x) => x < 1000) && b.every((n) => n <= 40), `first retry: ${b}`);
});

test("at the default poll and heartbeat intervals a hundred idle hosts behind one address stay well inside the transport's limits (card H07)", () => {
  const perHostPerMinute = 60_000 / 20_000 + 60_000 / 15_000;
  assert.equal(perHostPerMinute, 7);
  assert.ok(100 * perHostPerMinute * 2 <= DEFAULT_WORKER_TRANSPORT_LIMITS.perAddressPerMinute, "twice the idle rate of 100 hosts fits the per-address allowance");
  assert.ok(perHostPerMinute * 10 <= DEFAULT_WORKER_TRANSPORT_LIMITS.perPrincipalPerMinute);
  assert.ok(100 + 10 <= DEFAULT_WORKER_TRANSPORT_LIMITS.connectionsPerAddress, "one held poll each plus a few other connections");
});

test("when handing over offers keeps failing the poller backs off instead of polling again at once (card H07)", async () => {
  const delays: number[] = []; const stop = new AbortController(); let tries = 0;
  const client = fake({ offers: () => [{ placement: 1, order: {} } as never] });
  await poller(client, { random: () => 0.999999, baseBackoffMs: 100, maxBackoffMs: 1000, minGapMs: 0, spreadMs: 0, onOffers: async () => { if (++tries > 5) stop.abort(); throw new Error("out of resources"); }, sleep: async (ms) => { delays.push(ms); } }).run(stop.signal);
  assert.deepEqual(delays.slice(0, 5), [0, 99, 199, 399, 799], "the failures count up across polls");
});

test("hosts refused outright do not all return at the same instant (card H07)", async () => {
  const delays = new Set<number>();
  for (let i = 0; i < 20; i++) {
    const stop = new AbortController(); let n = 0;
    await poller(fake({ connect: () => new WorkerRequestError(426, "protocol_unsupported", "too old") }), { random: seeded(i + 3), maxBackoffMs: 60_000, spreadMs: 0, sleep: async (ms) => { if (++n === 2) delays.add(ms); if (n >= 2) stop.abort(); } }).run(stop.signal);
  }
  assert.ok(delays.size >= 15 && [...delays].every((d) => d >= 45_000 && d <= 60_000), JSON.stringify([...delays]));
});
