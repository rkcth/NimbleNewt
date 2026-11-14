import assert from "node:assert/strict";
import { connect as netConnect, createServer, type Server, type Socket } from "node:net";
import { after, test } from "node:test";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { MAINTENANCE_PRINCIPAL } from "../environments/index.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { AGENT_SITE_LIMITS, AgentSiteAllowances, NetworkGrantService, NetworkRefused, NetworkRelay, type TunnelEvents } from "./index.js";

// Card A09, network application: the sites an agent's environment holds through approved maintenance requests are read by the relay and the web tool like a grant, at every connection, with the request ID as the grant.

after(stopServer);

let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const REQ = (k: number): string => `mnt-${B32[(k >> 5) % 32]}${B32[k % 32]}${"a".repeat(18)}`;
const ANN = "agent:agt-ann";
const BOB = "agent:agt-bob";
const PUBLIC = "93.184.216.34";
async function until(label: string, check: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) { if (Date.now() > end) assert.fail(`timed out waiting for ${label}`); await new Promise((r) => setTimeout(r, 10)); }
}
async function echo(): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); s.on("error", () => undefined); s.on("data", (d) => s.write(d)); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as { port: number }).port, close: async () => { for (const s of sockets) s.destroy(); await new Promise<void>((r) => server.close(() => r())); } };
}

for (const backend of backends) {
  interface Ctx {
    sites: AgentSiteAllowances; grants: NetworkGrantService; owner: Principal; denied: Set<string>; deniedThrows: { on: boolean };
    ctx: { taskId: string; projectId: string; attemptId: string; agentId?: string }; end(): Promise<void>;
    relay(extra?: Record<string, unknown>): NetworkRelay; dials: Array<{ address: string; port: number }>;
    connect(opener: ReturnType<NetworkRelay["forAttempt"]>, host: string): Promise<{ tunnel: Awaited<ReturnType<ReturnType<NetworkRelay["forAttempt"]>["open"]>>; got: Buffer[]; closed: Promise<string> }>;
  }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      const server = await echo();
      const relays: NetworkRelay[] = [];
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1" });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, {});
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const projectId = (await projects.createProject({ commandId: cid("p"), actor: "owner:rob", name: "A" })).id;
        const taskId = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId, title: "T" })).id;
        const denied = new Set<string>(); const deniedThrows = { on: false };
        const sites = AgentSiteAllowances.withEpoch(world.storage, projects.epoch, MAINTENANCE_PRINCIPAL, { denied: async (h, p) => { if (deniedThrows.on) throw new Error("rules unreadable"); return denied.has(`${h}:${p}`); } });
        const grants = NetworkGrantService.withEpoch(world.storage, projects.epoch, { agentSites: sites });
        const dials: Array<{ address: string; port: number }> = [];
        const relay = (extra: Record<string, unknown> = {}): NetworkRelay => {
          const r = new NetworkRelay({ grants, resolve: async (h: string) => (h === "inside.example.com" ? ["10.1.2.3"] : [PUBLIC]), dial: (address: string, port: number) => { dials.push({ address, port }); return netConnect({ host: "127.0.0.1", port: server.port }); }, recheckMs: 20, ...extra } as never);
          relays.push(r); return r;
        };
        const connect: Ctx["connect"] = async (opener, host) => {
          const got: Buffer[] = []; let done!: (why: string) => void; const closed = new Promise<string>((r) => { done = r; });
          const events: TunnelEvents = { data: (chunk) => { got.push(Buffer.from(chunk)); }, closed: (why) => done(why) };
          return { tunnel: await opener.open({ host, port: 443 }, events), got, closed };
        };
        const end = async (): Promise<void> => { const t = await projects.getTask(taskId); await projects.transitionTask({ commandId: cid("end"), actor: "owner:rob", taskId, expectedRevision: t!.revision, to: "cancelled" }); };
        await body({ sites, grants, owner, denied, deniedThrows, ctx: { taskId, projectId, attemptId: "att-1", agentId: ANN }, end, relay, dials, connect });
      } finally { for (const r of relays) r.close(); await server.close(); await world.close(); }
    });

  suite("an approved site is allowed for the agent's attempts only, for exactly that host and port, and the connection log names the request", async (c) => {
    await c.sites.allow(REQ(1), ANN, "Docs.Example.com", 443);
    const relay = c.relay();
    const { tunnel, got, closed } = await c.connect(relay.forAttempt(c.ctx), "docs.example.com");
    await tunnel.write(Buffer.from("hello"));
    await until("the echo", () => Buffer.concat(got).toString() === "hello");
    assert.deepEqual(c.dials, [{ address: PUBLIC, port: 443 }], "the one checked address");
    tunnel.close(); await closed;
    await until("close logged", async () => (await c.grants.connections(c.owner, c.ctx.taskId)).every((x) => x.outcome !== "open"));
    const [rec] = await c.grants.connections(c.owner, c.ctx.taskId);
    assert.equal(rec!.grantId, REQ(1), "the request that allowed it is in the log");
    assert.equal(rec!.host, "docs.example.com");
    // Another host, another port, another agent, an attempt with no agent: refused.
    const opener = relay.forAttempt(c.ctx);
    await assert.rejects(() => c.connect(opener, "other.example.com"), NetworkRefused);
    await assert.rejects(() => opener.open({ host: "docs.example.com", port: 8443 }, { data() {}, closed() {} }), NetworkRefused);
    await assert.rejects(() => c.connect(relay.forAttempt({ ...c.ctx, agentId: BOB }), "docs.example.com"), NetworkRefused);
    const { agentId: _a, ...noAgent } = c.ctx;
    await assert.rejects(() => c.connect(relay.forAttempt(noAgent), "docs.example.com"), NetworkRefused);
    assert.equal(c.dials.length, 1, "nothing else was dialled");
  });

  suite("an approved site that resolves to a private address is refused, as for a task's grant without allowPrivate; a task's own grant still works beside it", async (c) => {
    await c.sites.allow(REQ(2), ANN, "inside.example.com", 443);
    const relay = c.relay();
    await assert.rejects(() => c.connect(relay.forAttempt(c.ctx), "inside.example.com"), (e: unknown) => e instanceof NetworkRefused && /private or internal/.test(e.message));
    assert.equal(c.dials.length, 0);
    await c.grants.grant(c.owner, { commandId: cid("g"), taskId: c.ctx.taskId, host: "task.example.com", port: 443 });
    const { tunnel } = await c.connect(relay.forAttempt(c.ctx), "task.example.com");
    tunnel.close();
    assert.equal((await c.grants.connections(c.owner, c.ctx.taskId)).at(-1)?.grantId?.startsWith("ngr-"), true, "a task's own grant is named as before");
  });

  suite("ending the request closes the connections it allowed at once and refuses new ones; another request for the same site keeps it open", async (c) => {
    await c.sites.allow(REQ(3), ANN, "docs.example.com", 443);
    const relay = c.relay({ recheckMs: 60_000 }); // only the push can end it here
    const { tunnel, got, closed } = await c.connect(relay.forAttempt(c.ctx), "docs.example.com");
    await tunnel.write(Buffer.from("a")); await until("echo", () => got.length > 0);
    assert.deepEqual(await c.sites.end(REQ(3), ANN, "docs.example.com", 443), { stillAllowed: false });
    assert.match(await closed, /revoked/);
    await until("close logged", async () => (await c.grants.connections(c.owner, c.ctx.taskId)).some((x) => x.outcome === "closed"));
    assert.equal((await c.grants.connections(c.owner, c.ctx.taskId))[0]!.endedBy, "revoked");
    await assert.rejects(() => c.connect(relay.forAttempt(c.ctx), "docs.example.com"), NetworkRefused);
    assert.equal(relay.open, 0);
    // Two requests stand behind a site: the earlier one's end leaves it allowed.
    await c.sites.allow(REQ(4), ANN, "docs.example.com", 443);
    await c.sites.allow(REQ(5), ANN, "docs.example.com", 443);
    assert.deepEqual(await c.sites.end(REQ(4), ANN, "docs.example.com", 443), { stillAllowed: true });
    const again = await c.connect(relay.forAttempt(c.ctx), "docs.example.com");
    again.tunnel.close();
    assert.deepEqual(await c.sites.end(REQ(5), ANN, "docs.example.com", 443), { stillAllowed: false });
    // Ending twice, or a request that never allowed anything, changes nothing.
    assert.deepEqual(await c.sites.end(REQ(5), ANN, "docs.example.com", 443), { stillAllowed: false });
    assert.deepEqual(await c.sites.end(REQ(9), ANN, "never.example.com", 443), { stillAllowed: false });
  });

  suite("the owner's deny rule wins at once: it ends an open connection by the recheck and refuses a new one before any revert; a rule that cannot be read counts as a denial", async (c) => {
    await c.sites.allow(REQ(6), ANN, "docs.example.com", 443);
    const relay = c.relay();
    const { got, tunnel, closed } = await c.connect(relay.forAttempt(c.ctx), "docs.example.com");
    await tunnel.write(Buffer.from("x")); await until("echo", () => got.length > 0);
    c.denied.add("docs.example.com:443");
    assert.match(await closed, /revoked/);
    await assert.rejects(() => c.connect(relay.forAttempt(c.ctx), "docs.example.com"), (e: unknown) => e instanceof NetworkRefused && /rule denies/.test(e.message));
    await assert.rejects(() => c.sites.allow(REQ(7), ANN, "docs.example.com", 443), /denied this site/, "and it cannot be allowed again until the rule is cleared");
    c.denied.clear();
    const back = await c.connect(relay.forAttempt(c.ctx), "docs.example.com"); back.tunnel.close();
    c.deniedThrows.on = true;
    await assert.rejects(() => c.connect(relay.forAttempt(c.ctx), "docs.example.com"), NetworkRefused);
    await assert.rejects(() => c.sites.allow(REQ(8), ANN, "other.example.com", 443), /denied/);
  });

  suite("the end of the task ends the connection and a finished task reaches nothing through the agent's sites either", async (c) => {
    await c.sites.allow(REQ(10), ANN, "docs.example.com", 443);
    const relay = c.relay();
    const { closed } = await c.connect(relay.forAttempt(c.ctx), "docs.example.com");
    await c.end();
    assert.match(await closed, /ended|revoked|grant/);
    await assert.rejects(() => c.connect(relay.forAttempt(c.ctx), "docs.example.com"), NetworkRefused);
  });

  suite("what a site may name: no wildcard, scheme, path, number-spelled, private, loopback or never-reachable address; bad request or agent IDs; bounds; owner-only listing", async (c) => {
    for (const bad of ["*.example.com", "https://docs.example.com", "docs.example.com/x", "docs.example.com:443", "2130706433", "0x7f.1", "", "a b.example.com"]) await assert.rejects(() => c.sites.allow(REQ(1), ANN, bad, 443), bad);
    for (const priv of ["127.0.0.1", "10.0.0.5", "192.168.1.1", "localhost", "::1"]) await assert.rejects(() => c.sites.allow(REQ(1), ANN, priv, 443), /private|local|internal|reach/i, priv);
    for (const never of ["169.254.169.254", "0.0.0.0", "224.0.0.1", "::ffff:169.254.169.254", "64:ff9b::a9fe:a9fe"]) await assert.rejects(() => c.sites.allow(REQ(1), ANN, never, 443), /no network approval can reach|no grant/i, never);
    for (const port of [0, 65536, 1.5, "443", null]) await assert.rejects(() => c.sites.allow(REQ(1), ANN, "docs.example.com", port), String(port));
    await assert.rejects(() => c.sites.allow("req-1", ANN, "docs.example.com", 443), /maintenance request ID/);
    await assert.rejects(() => c.sites.allow(REQ(1), "owner:rob", "docs.example.com", 443), /agent's principal ID/);
    await c.sites.allow(REQ(1), ANN, "docs.example.com", 443);
    assert.equal((await c.sites.list(c.owner, ANN)).length, 1);
    assert.deepEqual((await c.sites.list(c.owner, BOB)), []);
    await assert.rejects(() => c.sites.list({ ...c.owner, kind: "agent", id: ANN } as never, ANN), /only the owner/);
    // Bounded: an agent holds at most so many sites, and one site only so many requests.
    for (let i = 0; i < AGENT_SITE_LIMITS.requestsPerSite - 1; i++) await c.sites.allow(REQ(100 + i), ANN, "docs.example.com", 443);
    await assert.rejects(() => c.sites.allow(REQ(11), ANN, "docs.example.com", 443), /too many approved requests/);
  });

  suite("a repeat of the same request changes nothing, written another way it is the same record, and after an end nothing is allowed", async (c) => {
    await c.sites.allow(REQ(1), ANN, "docs.example.com", 443);
    const again = await c.sites.allow(REQ(1), ANN, "DOCS.example.com.", 443);
    assert.equal(again.created, false, "the same request written another way is the same allowance");
    assert.equal((await c.sites.list(c.owner, ANN))[0]!.requests.length, 1);
    await c.sites.end(REQ(1), ANN, "docs.example.com", 443);
    assert.equal((await c.sites.list(c.owner, ANN)).length, 0);
    const check = await c.grants.check(c.ctx.taskId, "docs.example.com", 443, ANN);
    assert.equal(check.live, false);
  });
}
