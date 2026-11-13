import assert from "node:assert/strict";
import { connect as netConnect, createServer, type Server, type Socket } from "node:net";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService } from "../security/index.js";
import { keyLikeName } from "./grants.js";
import { neverReachable, NetworkGrantService, NetworkRefused, NetworkRelay, type GrantSource, type GrantView, type TunnelEvents } from "./index.js";

// Card H12i review: embedded IPv4 forms of the never-reachable addresses, the secret-name check, the sweep of records a stopped controller left open, and the relay's
// connection cap and attempt close while a connection is still being made.

after(stopServer);

let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
async function until(label: string, check: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) assert.fail(`timed out waiting for ${label}`); await new Promise((r) => setTimeout(r, 10)); }
}

test("an IPv6 address that carries a never-reachable IPv4 address is never reachable in every embedding; ordinary and loopback IPv6 addresses are not caught by it", () => {
  // 169.254.169.254 (a9fe:a9fe) and 0.0.0.0 written inside IPv6 forms a translating gateway would carry to IPv4.
  for (const a of ["::a9fe:a9fe", "::169.254.169.254", "64:ff9b::a9fe:a9fe", "64:ff9b::169.254.169.254", "64:ff9b:1::a9fe:a9fe", "2002:a9fe:a9fe::", "2002:a9fe:a9fe:1::1", "::ffff:0:a9fe:a9fe", "::ffff:a9fe:a9fe", "[64:FF9B::A9FE:A9FE]", "64:ff9b::e000:1"]) assert.equal(neverReachable(a), true, a);
  for (const a of ["::1", "2606:4700::1111", "64:ff9b::808:808", "2002:808:808::", "::ffff:808:808", "fd12::1", "2001:db8::1"]) assert.equal(neverReachable(a), false, a);
});

test("a secret NAME that reads like a secret is refused: known key shapes, what the secret scanner finds, a long random run of letters and digits; ordinary names pass", () => {
  const scanned = ["gh", "p_"].join("") + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
  for (const ref of [scanned, ["s", "k", "-"].join("") + "abcd1234".repeat(4), "Zx9Qw3Er7Ty1Ui5Op2As", "vendor.Zx9Qw3Er7Ty1Ui5Op2As8D"]) assert.equal(keyLikeName(ref), true, ref);
  for (const ref of ["vendor-api-key", "GITHUB_TOKEN", "prod.db.password", "research_site_cookie", "openai", "backup-signing-key", "a2024-token"]) assert.equal(keyLikeName(ref), false, ref);
});

for (const backend of backends) {
  test(`${backend.name}: records a stopped controller left open are ended by the sweep; a record opened after the cut-off is not touched; a grant to an embedded metadata address is refused`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1" });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, {});
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const projectId = (await projects.createProject({ commandId: cid("p"), actor: "owner:rob", name: "A" })).id;
      const taskId = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId, title: "T" })).id;
      const other = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId, title: "U" })).id;
      let now = "2026-01-01T00:00:00.000Z";
      const grants = NetworkGrantService.withEpoch(world.storage, projects.epoch, { clock: () => now } as never);
      await assert.rejects(() => grants.grant(owner, { commandId: cid("g"), taskId, host: "64:ff9b::a9fe:a9fe", port: 80, allowPrivate: true } as never), (e: unknown) => e instanceof DomainError && e.code === "forbidden");
      await assert.rejects(() => grants.grant(owner, { commandId: cid("g"), taskId, host: "x.example.com", port: 80, credential: { header: "x-api-key", ref: "Zx9Qw3Er7Ty1Ui5Op2As" } } as never), (e: unknown) => e instanceof DomainError && e.code === "invalid_command");
      const g = await grants.grant(owner, { commandId: cid("g"), taskId, host: "research.example.com", port: 443 } as never);
      await grants.grant(owner, { commandId: cid("g"), taskId: other, host: "research.example.com", port: 443 } as never);
      const stale = await grants.logOpen({ taskId, projectId, attemptId: "att-1", host: "research.example.com", port: 443, address: "93.184.216.34", grantId: g.id, via: "relay", outcome: "open" });
      const staleOther = await grants.logOpen({ taskId: other, projectId, attemptId: "att-2", host: "research.example.com", port: 443, address: "93.184.216.34", via: "relay", outcome: "open" });
      const refused = await grants.logOpen({ taskId, projectId, attemptId: "att-1", host: "evil.example.net", port: 25, via: "relay", outcome: "refused", reason: "no grant" });
      now = "2026-01-01T00:00:05.000Z";
      const cutoff = now;
      now = "2026-01-01T00:00:06.000Z";
      const fresh = await grants.logOpen({ taskId, projectId, attemptId: "att-3", host: "research.example.com", port: 443, address: "93.184.216.34", grantId: g.id, via: "relay", outcome: "open" });
      assert.equal(await grants.sweepOpen(cutoff), 2);
      const log = await grants.connections(owner, taskId);
      const byId = new Map(log.map((x) => [x.id, x]));
      assert.equal(byId.get(stale)!.outcome, "failed"); assert.equal(byId.get(stale)!.endedBy, "error"); assert.match(byId.get(stale)!.reason ?? "", /controller stopped/);
      assert.equal(byId.get(refused)!.outcome, "refused", "a refused record is left as it is");
      assert.equal(byId.get(fresh)!.outcome, "open", "a connection opened after the cut-off is not ended on paper");
      assert.equal((await grants.connections(owner, other)).find((x) => x.id === staleOther)!.outcome, "failed", "every task with a grant is swept");
      assert.equal(await grants.sweepOpen(cutoff), 0, "a second sweep finds nothing");
    } finally { await world.close(); }
  });
}

/** A grant source in memory: one live grant for research.example.com:443; resolving waits for the test to let it go. */
function memorySource() {
  const grant = { id: "ngr-aaaaaaaaaaaaaaaaaaaa", taskId: "task-x", projectId: "proj-x", host: "research.example.com", port: 443, allowPrivate: false, state: "granted", requestedBy: "owner:rob", requestedAt: "t", revision: 1 } as unknown as GrantView;
  const opened: string[] = []; const closed: Array<{ id: string; endedBy: string; outcome: string }> = [];
  const source: GrantSource = {
    check: async (_t, host, port) => (host === grant.host && port === grant.port ? { grant, live: true } : { live: false, why: "no grant" }),
    logOpen: async (entry) => { const id = `ncn-${opened.length}`; opened.push(`${entry.outcome}:${entry.host}`); return id; },
    logClose: async (_t, id, ended) => { closed.push({ id, endedBy: ended.endedBy, outcome: ended.outcome }); },
    loggedFor: async () => 0,
  };
  let release!: () => void; let gate = new Promise<void>((r) => { release = r; });
  let lookups = 0;
  const resolve = async (): Promise<string[]> => { lookups++; await gate; return ["93.184.216.34"]; };
  return { source, resolve, opened, closed, lookups: () => lookups, release: () => release(), regate: () => { gate = new Promise<void>((r) => { release = r; }); } };
}
async function listener(): Promise<{ port: number; accepted: () => number; close(): Promise<void> }> {
  let accepted = 0; const sockets = new Set<Socket>();
  const server: Server = createServer((s) => { accepted++; sockets.add(s); s.on("error", () => undefined); s.on("close", () => sockets.delete(s)); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as { port: number }).port, accepted: () => accepted, close: async () => { for (const s of sockets) s.destroy(); await new Promise<void>((r) => server.close(() => r())); } };
}
const quiet: TunnelEvents = { data: () => undefined, closed: () => undefined };

test("the relay's cap counts connections still being admitted: opens made at the same moment cannot all pass it", async () => {
  const m = memorySource(); const server = await listener();
  const relay = new NetworkRelay({ grants: m.source, resolve: m.resolve, dial: () => netConnect({ host: "127.0.0.1", port: server.port }), maxOpen: 2 });
  try {
    const opener = relay.forAttempt({ taskId: "task-x", projectId: "proj-x", attemptId: "att-1" });
    const tries = Array.from({ length: 6 }, () => opener.open({ host: "research.example.com", port: 443 }, quiet).then((t) => ({ t }), (e: unknown) => ({ e })));
    await until("the admitted ones to reach the lookup", () => m.lookups() === 2);
    m.release();
    const results = await Promise.all(tries);
    const opened = results.filter((r): r is { t: Awaited<ReturnType<typeof opener.open>> } => "t" in r);
    const refused = results.filter((r): r is { e: unknown } => "e" in r);
    assert.equal(opened.length, 2, "only as many as the cap");
    assert.ok(refused.every((r) => r.e instanceof NetworkRefused && /too many/.test((r.e as Error).message)));
    assert.equal(relay.open, 2);
    for (const r of opened) r.t.close();
    // Room again once they are closed.
    const again = await opener.open({ host: "research.example.com", port: 443 }, quiet);
    again.close();
  } finally { relay.close(); await server.close(); }
});

test("a connection still being admitted when the attempt's connections are all closed is refused and never dialled; a later open (a restarted process) works", async () => {
  const m = memorySource(); const server = await listener();
  let dials = 0;
  const relay = new NetworkRelay({ grants: m.source, resolve: m.resolve, dial: () => { dials++; return netConnect({ host: "127.0.0.1", port: server.port }); } });
  try {
    const opener = relay.forAttempt({ taskId: "task-x", projectId: "proj-x", attemptId: "att-1" });
    const pending = opener.open({ host: "research.example.com", port: 443 }, quiet).then(() => "opened", (e: unknown) => e);
    await until("the lookup", () => m.lookups() === 1);
    opener.closeAll("the worker process ended");
    m.release();
    const outcome = await pending;
    assert.ok(outcome instanceof NetworkRefused, String(outcome));
    assert.equal(dials, 0, "nothing was dialled");
    assert.deepEqual(m.closed.map((c) => [c.endedBy, c.outcome]), [["attempt", "failed"]], "the record is completed");
    assert.equal(relay.open, 0);
    const later = await opener.open({ host: "research.example.com", port: 443 }, quiet);
    await until("the server saw the later connection", () => server.accepted() === 1);
    later.close();
  } finally { relay.close(); await server.close(); }
});
