import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { DomainError } from "../domain/errors.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { selfSigned } from "../transport/testing/selfsigned.js";
import { RemoteWorkerClient, WorkerRequestError } from "./client.js";
import { PROTOCOL_HEADER, ProtocolMismatch, SESSION_HEADER, WORKER_PROTOCOL, checkRange, negotiateProtocol } from "./protocol.js";
import { RemoteWorkerService } from "./service.js";
import { WorkerTransport } from "./server.js";
import { remoteSuite, wireRefuses } from "./testing/suite.js";
import { REMOTE_CAPS, rawRequest } from "./testing/world.js";

after(stopServer);

test("protocol versions: the highest common one is chosen; no common version is a reason that says which side is too old", () => {
  assert.deepEqual(negotiateProtocol({ min: 1, max: 1 }, { min: 1, max: 1 }), { ok: true, version: 1 });
  assert.deepEqual(negotiateProtocol({ min: 1, max: 3 }, { min: 2, max: 5 }), { ok: true, version: 3 });
  assert.deepEqual(negotiateProtocol({ min: 2, max: 4 }, { min: 1, max: 2 }), { ok: true, version: 2 });
  const old = negotiateProtocol({ min: 3, max: 4 }, { min: 1, max: 2 });
  assert.equal(old.ok, false);
  assert.match((old as { reason: string }).reason, /worker is too old/);
  const young = negotiateProtocol({ min: 1, max: 2 }, { min: 3, max: 3 });
  assert.equal(young.ok, false);
  assert.match((young as { reason: string }).reason, /controller is too old/);
  assert.deepEqual(checkRange({ min: 1, max: 2 }, "p"), { min: 1, max: 2 });
  for (const bad of [null, [], { min: 0, max: 1 }, { min: 2, max: 1 }, { min: 1 }, { min: 1.5, max: 2 }, { min: 1, max: 2, extra: 1 }, "1", { min: "1", max: "2" }, { min: 1, max: 1e9 }]) {
    assert.throws(() => checkRange(bad, "p"), (e: unknown) => e instanceof DomainError && e.code === "invalid_command", JSON.stringify(bad));
  }
});

test("the worker client holds a URL and a credential and nothing else: it imports no storage, no service and no file of the controller", () => {
  const source = readFileSync(fileURLToPath(new URL("../../src/remote/client.ts", import.meta.url)), "utf8");
  const imports = [...source.matchAll(/^import (?:type )?[^;]*? fr[o]m "([^"]+)";/gm)].map((m) => m[1]);
  // Node's network modules, the protocol constants and the dispatch contract's types are everything it reaches.
  assert.deepEqual(imports.filter((i) => !i!.startsWith("node:http") && !i!.startsWith("node:https") && i !== "node:crypto").sort(), ["../dispatch/ports.js", "./protocol.js"]);
  assert.doesNotMatch(source, /\b(?:readFile|writeFile|createReadStream|openSync|sqlite|postgres|Storage)\b/);
  const client = new RemoteWorkerClient({ url: "http://127.0.0.1:1", token: "t".repeat(30), workerVersion: "w" });
  assert.deepEqual(Object.keys(client), []);
});

for (const backend of backends) {
  const suite = remoteSuite(backend);

  suite("a worker connects with its credential: the protocol is negotiated, its capabilities come from its own registration, and every connection has a higher epoch", async (c) => {
    const r1 = await c.host("r1", { connect: false });
    const first = await r1.client.connect({ ...REMOTE_CAPS }, "k-1");
    assert.deepEqual([first.sessionEpoch, first.protocol, first.controller], [1, 1, WORKER_PROTOCOL]);
    const status = (await c.hosts.status(c.owner, r1.id))!;
    assert.deepEqual(status.capabilities, REMOTE_CAPS, "the controller knows what the host announced itself");
    // The same command ID is the same session.
    assert.deepEqual(await r1.client.connect({ ...REMOTE_CAPS }, "k-1"), first);
    const second = await r1.client.connect({ ...REMOTE_CAPS }, "k-2");
    assert.ok(second.sessionEpoch > first.sessionEpoch);
    assert.notEqual(second.sessionId, first.sessionId);
    // A packet of the first session that arrives late is fenced, not obeyed.
    const stale = new RemoteWorkerClient({ url: c.transport.url, token: r1.token, workerVersion: "w" });
    await stale.connect({ ...REMOTE_CAPS }, "k-3");
    await wireRefuses("fenced", () => r1.client.heartbeat(1), 409);
    // Facts that are not capabilities, a stranger's name, or text shaped like a secret are refused; so is a field that is not part of the message.
    await wireRefuses("invalid_command", () => stale.connect({ ...REMOTE_CAPS, os: "linux sk-ant-api03-abcdefghijklmnopqrstuvwx" }, "k-4"), 400);
    await wireRefuses("invalid_command", () => stale.connect({ ...REMOTE_CAPS, hostId: "host:other" } as never, "k-5"), 400);
    const raw = await rawRequest(c.transport.url, "POST", "/worker/connect", { token: r1.token, body: { protocol: { min: 1, max: 1 }, workerVersion: "w", capabilities: REMOTE_CAPS, hostId: "host:other" }, headers: { "idempotency-key": "k-6" } });
    assert.equal(raw.status, 400);
    assert.equal(raw.body.error.field, "hostId");
    assert.equal((await rawRequest(c.transport.url, "POST", "/worker/connect", { token: r1.token, body: { protocol: { min: 1, max: 1 }, workerVersion: "w", capabilities: REMOTE_CAPS } })).status, 400, "a change needs an idempotency key");
  });

  suite("only an enrolled, active host on its current credential is admitted; a revoked or rotated host is refused on its very next request", async (c) => {
    const r1 = await c.host("r1");
    const url = c.transport.url;
    assert.equal((await rawRequest(url, "GET", "/worker/session/offers")).status, 401);
    assert.equal((await rawRequest(url, "GET", "/worker/session/offers", { token: "nonsense" })).status, 401);
    assert.equal((await rawRequest(url, "GET", "/worker/session/offers", { token: `host:r1.${"x".repeat(40)}` })).status, 401);
    // Credentials of other kinds do not open this door.
    const ann = await c.agent("ann");
    const agentToken = (await c.principals.issueCredential(c.owner, ann.id)).token;
    const ownerToken = (await c.principals.issueCredential(c.owner, c.owner.id)).token;
    const serviceToken = (await c.principals.issueCredential(c.owner, c.dispatcherPrincipal.id)).token;
    for (const token of [agentToken, ownerToken, serviceToken]) assert.equal((await rawRequest(url, "POST", "/worker/connect", { token, body: {}, headers: { "idempotency-key": "x" } })).status, 403);
    // The wrong host name is refused before anything else (DNS rebinding).
    assert.equal((await rawRequest(url, "GET", "/worker/session/offers", { token: r1.token, headers: { host: "evil.example" } })).status, 421);
    // Rotation: the old token is refused at once; the new credential must connect for itself, with a higher epoch.
    const before = r1.client.session!;
    const rotated = (await c.principals.issueCredential(c.owner, r1.id)).token;
    await wireRefuses("unauthenticated", () => r1.client.offers(), 401);
    const fresh = new RemoteWorkerClient({ url, token: rotated, workerVersion: "w" });
    assert.ok((await fresh.connect({ ...REMOTE_CAPS })).sessionEpoch > before.sessionEpoch);
    assert.deepEqual(await fresh.offers(), []);
    // Revocation: refused on the next request, session or not.
    const record = (await c.storage.getAggregate({ kind: "principal", id: r1.id }))!;
    await c.principals.disable(c.owner, { commandId: "dis-1", principalId: r1.id, expectedRevision: record.revision });
    await wireRefuses("unauthenticated", () => fresh.offers(), 401);
    await wireRefuses("unauthenticated", () => fresh.heartbeat(5), 401);
    // A principal object kept from before the change is refused by the service as well, with no transport in between.
    await assert.rejects(() => c.remote.connect(r1.principal, { commandId: "c-1", protocol: { min: 1, max: 1 }, workerVersion: "w", capabilities: REMOTE_CAPS }), (e: unknown) => e instanceof DomainError && e.code === "unauthenticated");
  });

  suite("a worker whose protocol the controller cannot speak is refused visibly, and a worker that names the wrong version in a session is told so", async (c) => {
    const r1 = await c.host("r1", { connect: false, protocol: { min: 2, max: 3 } });
    await wireRefuses("protocol_unsupported", () => r1.client.connect({ ...REMOTE_CAPS }), 426, (e) => {
      assert.deepEqual(e.supported, WORKER_PROTOCOL);
      assert.match(e.message, /controller is too old/);
    });
    // The refusal is a record the owner can read, and the worker has no session.
    const session = (await c.remote.session(c.owner, r1.id))!;
    assert.equal(session.sessionEpoch, 0);
    assert.equal(session.refusal!.worker.min, 2);
    assert.deepEqual(session.refusal!.controller, WORKER_PROTOCOL);
    assert.deepEqual((await c.remote.refused(c.owner)).items.map((s) => s.hostId), [r1.id]);
    await wireRefuses("not_connected", () => r1.client.heartbeat(1));
    // The host stays unknown to scheduling: it never announced, so the dispatcher has no host to start the attempt on.
    await c.task("t", await c.agent("ann"));
    const report = await c.tick();
    assert.deepEqual(report.started, []);
    assert.equal(report.skipped.length + report.blocked.length, 1);
    // An agreeable range connects and clears the refusal.
    const ok = new RemoteWorkerClient({ url: c.transport.url, token: r1.token, workerVersion: "w", protocol: { min: 1, max: 5 } });
    const info = await ok.connect({ ...REMOTE_CAPS });
    assert.equal(info.protocol, 1, "the highest version both speak");
    assert.equal((await c.remote.session(c.owner, r1.id))!.refusal, undefined);
    // Every message of a session names the version it negotiated; another one is a refusal that says what is spoken.
    const bad = await rawRequest(c.transport.url, "GET", "/worker/session/offers", { token: r1.token, headers: { [SESSION_HEADER]: info.sessionId, [PROTOCOL_HEADER]: "2" } });
    assert.equal(bad.status, 426);
    assert.equal(bad.body.error.code, "protocol_mismatch");
    assert.deepEqual(bad.body.error.supported, WORKER_PROTOCOL);
    assert.equal((await rawRequest(c.transport.url, "GET", "/worker/session/offers", { token: r1.token, headers: { [SESSION_HEADER]: info.sessionId } })).status, 426, "a message that names no version is refused");
    assert.equal((await rawRequest(c.transport.url, "GET", "/worker/session/offers", { token: r1.token, headers: { [PROTOCOL_HEADER]: "1" } })).status, 409, "and one that names no session");
  });

  suite("a controller that has dropped an old protocol refuses the old worker with the reason; a controller range that is nonsense is refused when it is built", async (c) => {
    const r1 = await c.host("r1", { connect: false });
    const deps = { principal: c.dispatcherPrincipal, hosts: c.hosts, artifacts: c.artifacts, dispatch: c.current as never };
    assert.throws(() => RemoteWorkerService.withEpoch(c.storage, c.epoch, deps, { ...c.options, protocol: { min: 3, max: 2 } }), (e: unknown) => e instanceof DomainError && e.code === "invalid_command");
    const v2 = RemoteWorkerService.withEpoch(c.storage, c.epoch, deps, { ...c.options, protocol: { min: 2, max: 3 } });
    await assert.rejects(() => v2.connect(r1.principal, { commandId: "c-old", protocol: { min: 1, max: 1 }, workerVersion: "w", capabilities: REMOTE_CAPS }), (e: unknown) => {
      assert.ok(e instanceof ProtocolMismatch);
      assert.deepEqual(e.supported, { min: 2, max: 3 });
      assert.match(e.message, /worker is too old/);
      return true;
    });
    assert.match((await v2.session(c.owner, r1.id))!.refusal!.reason, /too old/);
    // The service that speaks 2 and 3 admits a worker that speaks 3 and 4, and uses 3.
    assert.equal((await v2.connect(r1.principal, { commandId: "c-new", protocol: { min: 3, max: 4 }, workerVersion: "w", capabilities: REMOTE_CAPS })).protocol, 3);
  });

  suite("requests are bounded: body size, content type, JSON, and a rate per host and per address, all from the injected clock", async (c) => {
    const r1 = await c.host("r1");
    const url = c.transport.url;
    const big = await rawRequest(url, "POST", "/worker/connect", { token: r1.token, rawBody: JSON.stringify({ pad: "x".repeat(1024 * 1024 + 10) }), headers: { "idempotency-key": "x" } });
    assert.equal(big.status, 413);
    assert.equal((await rawRequest(url, "POST", "/worker/connect", { token: r1.token, rawBody: "{", headers: { "idempotency-key": "x" } })).status, 400);
    assert.equal((await rawRequest(url, "POST", "/worker/connect", { token: r1.token, rawBody: "[]", headers: { "idempotency-key": "x" } })).status, 400);
    assert.equal((await rawRequest(url, "POST", "/worker/connect", { token: r1.token, rawBody: "{}", headers: { "idempotency-key": "x", "content-type": "text/plain" } })).status, 415);
    // Rates: a host past its allowance waits for the next window of the clock, not of the wall.
    let now = 1_000_000;
    const limited = await c.listen({ limits: { perPrincipalPerMinute: 3, perAddressPerMinute: 100 }, clock: () => now });
    const hit = () => rawRequest(limited.url, "GET", "/worker/session/offers", { token: r1.token });
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await hit()).status);
    assert.deepEqual(statuses, [409, 409, 409, 429, 429], "409: no session named; the point is the count");
    const throttled = await hit();
    assert.ok(Number(throttled.headers["retry-after"]) >= 1);
    now += 60_000;
    assert.equal((await hit()).status, 409);
    // The address allowance counts requests before they are authenticated, so guessing a credential is throttled too.
    const guarded = await c.listen({ limits: { perAddressPerMinute: 2 }, clock: () => now });
    const guess = () => rawRequest(guarded.url, "GET", "/worker/session/offers", { token: "guess" });
    assert.deepEqual([(await guess()).status, (await guess()).status, (await guess()).status], [401, 401, 429]);
  });

  suite("remote exposure has to be asked for and needs TLS and the host names; with TLS a worker connects and an unknown host name is refused", async (c) => {
    const common = { remote: c.remote, principals: c.principals };
    await assert.rejects(() => WorkerTransport.listen({ ...common, host: "0.0.0.0" }), (e: unknown) => e instanceof DomainError && e.field === "host");
    await assert.rejects(() => WorkerTransport.listen({ ...common, host: "0.0.0.0", allowRemote: true }), (e: unknown) => e instanceof DomainError && e.field === "tls");
    const tls = selfSigned();
    await assert.rejects(() => WorkerTransport.listen({ ...common, host: "0.0.0.0", allowRemote: true, tls }), (e: unknown) => e instanceof DomainError && e.field === "publicHosts");
    await assert.rejects(() => WorkerTransport.listen({ ...common, publicHosts: ["bad host!"], allowRemote: true, tls, host: "0.0.0.0" }), (e: unknown) => e instanceof DomainError && e.field === "publicHosts");
    const secure = await c.listen({ tls });
    assert.match(secure.url, /^https:/);
    const r1 = await c.host("r1", { connect: false, clientOptions: { url: secure.url, ca: tls.cert } });
    assert.equal((await r1.client.connect({ ...REMOTE_CAPS })).protocol, 1);
    assert.equal((await rawRequest(secure.url, "GET", "/worker/session/offers", { token: r1.token, ca: tls.cert, headers: { host: "evil.example" } })).status, 421);
    // A client that does not trust the certificate cannot talk to it.
    const untrusting = new RemoteWorkerClient({ url: secure.url, token: r1.token, workerVersion: "w", retries: 0 });
    await assert.rejects(() => untrusting.connect({ ...REMOTE_CAPS }));
  });

  suite("the client checks the certificate against the host in the URL: a certificate for another name is refused even when the CA is trusted, one for the right name is accepted, and plain http goes only to this machine", async (c) => {
    const other = selfSigned(new Date(), { dns: "controller.example", ip: false });
    const localOnly = selfSigned(new Date(), { dns: "localhost", ip: false });
    const ipOnly = selfSigned(new Date(), { dns: "controller.example", ip: true });
    const r1 = await c.host("r1", { connect: false });
    const connect = async (tls: { cert: string; key: string }): Promise<void> => {
      const listener = await c.listen({ tls });
      const client = new RemoteWorkerClient({ url: listener.url, token: r1.token, workerVersion: "w", ca: tls.cert, retries: 0 });
      await client.connect({ ...REMOTE_CAPS });
    };
    // The URL names 127.0.0.1: a certificate that does not cover it is a different server, whatever it is signed by.
    await assert.rejects(() => connect(other));
    await assert.rejects(() => connect(localOnly));
    await connect(ipOnly);
    assert.throws(() => new RemoteWorkerClient({ url: "http://controller.example:8080", token: "t".repeat(30), workerVersion: "w" }), /https/);
    assert.throws(() => new RemoteWorkerClient({ url: "http://192.0.2.7:8080", token: "t".repeat(30), workerVersion: "w" }), /https/);
    assert.doesNotThrow(() => new RemoteWorkerClient({ url: "http://localhost:8080", token: "t".repeat(30), workerVersion: "w" }));
    assert.doesNotThrow(() => new RemoteWorkerClient({ url: "https://controller.example", token: "t".repeat(30), workerVersion: "w" }));
  });

  suite("one network address cannot take all the connections of the listener", async (c) => {
    const capped = await c.listen({ limits: { connectionsPerAddress: 2 } });
    const { connect } = await import("node:net");
    const open = (): Promise<import("node:net").Socket> => new Promise((resolve) => { const s = connect(capped.port, "127.0.0.1"); s.once("connect", () => resolve(s)); });
    const sockets = [await open(), await open()];
    // The third connection from the same address is dropped by the listener (the test waits for that, not for a time).
    const third = await open();
    await new Promise<void>((resolve) => third.once("close", () => resolve()));
    assert.equal(sockets.every((x) => !x.destroyed), true);
    sockets.push(third);
    for (const s of sockets) s.destroy();
  });

  suite("connections are limited per address only before login: many logged-in hosts behind one address hold their polls, strangers cannot take their room, and a host has its own allowance (card H07d)", async (c) => {
    const capped = await c.listen({ limits: { connectionsPerAddress: 2, connections: 3, connectionsPerHost: 2 } });
    const hosts = [await c.host("a1"), await c.host("a2"), await c.host("a3"), await c.host("a4"), await c.host("a5")];
    const clients = hosts.map((h) => { const x = new RemoteWorkerClient({ url: capped.url, token: h.token, workerVersion: "worker-9.1.0" }); return x; });
    for (const x of clients) await x.connect({ ...REMOTE_CAPS } as never);
    // Five logged-in hosts from one address hold a poll each, though the address may have only two connections before login.
    // (One at a time: a connection is a stranger's until its first request is authenticated, and the address allows two of those at once.)
    const polls: Promise<unknown>[] = [];
    for (const x of clients) { polls.push(x.offers({ waitMs: 3000 })); const want = polls.length; for (let i = 0; i < 300 && capped.connectionCounts().loggedIn < want; i++) await new Promise((r) => setTimeout(r, 20)); }
    assert.deepEqual(capped.connectionCounts(), { beforeLogin: 0, loggedIn: 5 });
    // Strangers fill only the pool before login: two from the address, then the address is full, and the held polls are untouched.
    const { connect } = await import("node:net");
    const open = (): Promise<import("node:net").Socket> => new Promise((resolve) => { const s = connect(capped.port, "127.0.0.1"); s.once("connect", () => resolve(s)); });
    const strangers = [await open(), await open()];
    const dropped = await open();
    await new Promise<void>((resolve) => dropped.once("close", () => resolve()));
    assert.equal(capped.connectionCounts().beforeLogin, 2);
    assert.equal(capped.connectionCounts().loggedIn, 5);
    for (const s of strangers) s.destroy();
    for (const p of polls) assert.deepEqual(await p, []);
    // A host has its own allowance: past two open connections the third is answered rate_limited.
    const host = hosts[0]!;
    const many = await Promise.allSettled([1, 2, 3, 4].map(() => new RemoteWorkerClient({ url: capped.url, token: host.token, workerVersion: "worker-9.1.0" }).connect({ ...REMOTE_CAPS } as never)));
    assert.ok(many.some((r) => r.status === "rejected" && r.reason instanceof WorkerRequestError && r.reason.code === "rate_limited"), JSON.stringify(many.map((r) => r.status)));
  });

  suite("a worker's whole surface is its own session, offers and attempts: there is no route that admits work, creates an attempt, reads the controller's records or opens its storage", async (c) => {
    const r1 = await c.host("r1");
    const s = r1.client.session!;
    const headers = { [SESSION_HEADER]: s.sessionId, [PROTOCOL_HEADER]: String(s.protocol), "idempotency-key": "k" };
    const attempt = "att-aaaaaaaaaaaaaaaaaaaa";
    for (const [method, path] of [
      ["GET", "/v1/threads"], ["GET", "/worker"], ["POST", "/worker/admit"], ["POST", "/worker/tasks"], ["GET", "/worker/storage"], ["POST", `/worker/attempts/${attempt}/admit`], ["POST", `/worker/attempts/${attempt}/promote`], ["POST", `/worker/attempts/${attempt}/relocate`],
      ["POST", `/worker/attempts/${attempt}/place`], ["GET", "/worker/hosts"], ["GET", "/worker/session/placements"], ["GET", "/../../etc/passwd"], ["DELETE", `/worker/attempts/${attempt}`],
    ] as const) {
      const r = await rawRequest(c.transport.url, method, path, { token: r1.token, headers, body: method === "POST" ? {} : undefined });
      assert.ok(r.status === 404 || r.status === 405, `${method} ${path} -> ${r.status}`);
    }
    // A method the route does not take.
    assert.equal((await rawRequest(c.transport.url, "GET", "/worker/connect", { token: r1.token })).status, 405);
    assert.equal((await rawRequest(c.transport.url, "POST", `/worker/attempts/${attempt}/control`, { token: r1.token, headers, body: {} })).status, 405);
    // An attempt nobody placed on this host looks exactly like one that does not exist.
    const unknown = await rawRequest(c.transport.url, "POST", `/worker/attempts/${attempt}/heartbeat`, { token: r1.token, headers, body: { placement: 1 } });
    assert.equal(unknown.status, 404);
  });

  test(`${backend.name}: the client checks a file against the digest the controller names, and a lie is not returned as data`, async () => {
    const server = createServer((req, res) => {
      if (req.url!.startsWith("/worker/connect")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ sessionId: "ses-1", sessionEpoch: 1, protocol: 1, controller: { min: 1, max: 1 } })); return; }
      res.writeHead(200, { "content-type": "application/octet-stream", "x-newt-digest": "0".repeat(64) });
      res.end("some bytes");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const client = new RemoteWorkerClient({ url, token: "t".repeat(30), workerVersion: "w" });
      await client.connect({});
      await wireRefuses("integrity", () => client.attempt("att-aaaaaaaaaaaaaaaaaaaa", 1).fetchFile("art-aaaaaaaaaaaaaaaaaaaa", "a.txt"));
      assert.ok(client.session !== undefined && WorkerRequestError.name === "WorkerRequestError");
      const small = new RemoteWorkerClient({ url, token: "t".repeat(30), workerVersion: "w", maxResponseBytes: 5, retries: 0 });
      await wireRefuses("too_large", () => small.connect({}));
    } finally { await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); }
  });
}
