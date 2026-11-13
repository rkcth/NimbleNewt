import assert from "node:assert/strict";
import { connect as netConnect, createServer, type Server, type Socket } from "node:net";
import { after, test } from "node:test";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { NetworkGrantService, NetworkRefused, NetworkRelay, type NetworkOpener, type TunnelEvents } from "./index.js";

after(stopServer);

let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
/** Waits for a condition (never a fixed pause), failing with the label when it does not come. */
async function until(label: string, check: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) { if (Date.now() > end) assert.fail(`timed out waiting for ${label}`); await new Promise((r) => setTimeout(r, 10)); }
}
const PUBLIC = "93.184.216.34";

/** A loopback server that echoes what it gets, and counts what it was sent. */
async function echo(): Promise<{ port: number; server: Server; sockets: Set<Socket>; received: () => number; close(): Promise<void> }> {
  let received = 0; const sockets = new Set<Socket>();
  const server = createServer((s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); s.on("error", () => undefined); s.on("data", (d) => { received += d.length; s.write(d); }); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { port, server, sockets, received: () => received, close: async () => { for (const s of sockets) s.destroy(); await new Promise<void>((r) => server.close(() => r())); } };
}

for (const backend of backends) {
  interface Ctx { grants: NetworkGrantService; owner: Principal; ctx: { taskId: string; projectId: string; attemptId: string }; end: () => Promise<void>; server: Awaited<ReturnType<typeof echo>>; names: Map<string, string[]>; lookups: string[]; dials: Array<{ address: string; port: number }>; relay: (extra?: Record<string, unknown>) => NetworkRelay; grant: (host: string, extra?: Record<string, unknown>) => Promise<string>; connect: (opener: NetworkOpener, host: string) => Promise<{ tunnel: Awaited<ReturnType<NetworkOpener["open"]>>; got: Buffer[]; closed: Promise<string> }> }
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
        const grants = NetworkGrantService.withEpoch(world.storage, projects.epoch);
        const names = new Map<string, string[]>(); const lookups: string[] = []; const dials: Array<{ address: string; port: number }> = [];
        const relay = (extra: Record<string, unknown> = {}): NetworkRelay => {
          const r = new NetworkRelay({ grants, resolve: async (h: string) => { lookups.push(h); return names.get(h) ?? []; }, dial: (address: string, port: number) => { dials.push({ address, port }); return netConnect({ host: "127.0.0.1", port: server.port }); }, recheckMs: 20, ...extra } as never);
          relays.push(r); return r;
        };
        const grant = async (host: string, extra: Record<string, unknown> = {}): Promise<string> => (await grants.grant(owner, { commandId: cid("g"), taskId, host, port: 443, ...extra } as never)).id;
        const connect: Ctx["connect"] = async (opener, host) => {
          const got: Buffer[] = []; let done!: (why: string) => void; const closed = new Promise<string>((r) => { done = r; });
          const events: TunnelEvents = { data: (chunk) => { got.push(Buffer.from(chunk)); }, closed: (why) => done(why) };
          return { tunnel: await opener.open({ host, port: 443 }, events), got, closed };
        };
        const end = async (): Promise<void> => { const t = await projects.getTask(taskId); await projects.transitionTask({ commandId: cid("end"), actor: "owner:rob", taskId, expectedRevision: t!.revision, to: "cancelled" }); };
        await body({ grants, owner, ctx: { taskId, projectId, attemptId: "att-1" }, end, server, names, lookups, dials, relay, grant, connect });
      } finally { for (const r of relays) r.close(); await server.close(); await world.close(); }
    });
  const logOf = (c: Ctx) => c.grants.connections(c.owner, c.ctx.taskId);

  suite("a granted destination carries bytes both ways, goes to the one checked address, and the log keeps the counts", async (c) => {
    c.names.set("docs.example.com", [PUBLIC]);
    await c.grant("docs.example.com");
    const opener = c.relay().forAttempt(c.ctx);
    const { tunnel, got, closed } = await c.connect(opener, "DOCS.example.com.");
    await tunnel.write(Buffer.from("hello world"));
    await until("the echo", () => Buffer.concat(got).toString() === "hello world");
    assert.deepEqual(c.dials, [{ address: PUBLIC, port: 443 }], "the connection went to the address that was checked, not to the name");
    assert.equal(c.lookups.length, 1, "the name was looked up once");
    tunnel.close();
    assert.match(await closed, /client/);
    await until("the log's close", async () => (await logOf(c)).every((x) => x.outcome !== "open"));
    const [rec] = await logOf(c);
    assert.equal(rec!.outcome, "closed"); assert.equal(rec!.endedBy, "client"); assert.equal(rec!.bytesToTarget, 11); assert.equal(rec!.bytesFromTarget, 11);
    assert.equal(rec!.host, "docs.example.com"); assert.equal(rec!.address, PUBLIC); assert.equal(rec!.attemptId, "att-1"); assert.equal(rec!.via, "relay");
  });

  suite("a task with no grant reaches nothing, and the refusal is logged without any lookup or connection", async (c) => {
    c.names.set("evil.example.net", [PUBLIC]);
    const opener = c.relay().forAttempt(c.ctx);
    await assert.rejects(() => c.connect(opener, "evil.example.net"), (e: unknown) => e instanceof NetworkRefused && /no grant/i.test(e.message));
    await assert.rejects(() => opener.open({ host: "127.0.0.1", port: 22 }, { data() {}, closed() {} }), NetworkRefused);
    await assert.rejects(() => opener.open({ host: "http://x", port: 80 }, { data() {}, closed() {} }), NetworkRefused);
    await assert.rejects(() => opener.open({ host: "x.example.com", port: 0 }, { data() {}, closed() {} }), NetworkRefused);
    assert.equal(c.dials.length, 0); assert.equal(c.lookups.length, 0);
    const log = await logOf(c);
    assert.equal(log.length, 4); assert.ok(log.every((x) => x.outcome === "refused" && x.reason !== undefined));
    // A grant for another port does not carry over.
    await c.grant("evil.example.net", { port: 8443 });
    await assert.rejects(() => c.connect(opener, "evil.example.net"), NetworkRefused);
  });

  suite("a name that resolves to a private, internal or mixed answer is refused; a name that changes its answer is looked up once and cannot be redirected", async (c) => {
    await c.grant("mixed.example.com"); await c.grant("inside.example.com"); await c.grant("meta.example.com", { allowPrivate: true }); await c.grant("rebind.example.com");
    c.names.set("mixed.example.com", [PUBLIC, "10.0.0.5"]);
    c.names.set("inside.example.com", ["192.168.1.10"]);
    c.names.set("meta.example.com", ["169.254.169.254"]);
    const opener = c.relay().forAttempt(c.ctx);
    for (const host of ["mixed.example.com", "inside.example.com", "meta.example.com"]) await assert.rejects(() => c.connect(opener, host), NetworkRefused, host);
    // The resolver gives a public address the first time and a private one after: only the first answer is ever used.
    const answers = [[PUBLIC], ["127.0.0.1"]]; let asked = 0;
    const r2 = new NetworkRelay({ grants: c.grants, resolve: async () => answers[Math.min(asked++, 1)]!, dial: (address: string, port: number) => { c.dials.push({ address, port }); return netConnect({ host: "127.0.0.1", port: c.server.port }); }, recheckMs: 20 });
    try {
      const { tunnel } = await c.connect(r2.forAttempt(c.ctx), "rebind.example.com");
      assert.equal(asked, 1); assert.deepEqual(c.dials.at(-1), { address: PUBLIC, port: 443 });
      tunnel.close();
    } finally { r2.close(); }
    assert.equal(c.dials.length, 1, "nothing was dialled for the refused ones");
    const text = JSON.stringify(await logOf(c));
    assert.doesNotMatch(text, /192\.168\.1\.10/, "the refusal does not hand the internal address back");
  });

  suite("a private destination needs a grant that names it, and then connects to that address", async (c) => {
    await c.grant("127.0.0.1", { allowPrivate: true });
    const opener = c.relay().forAttempt(c.ctx);
    const { tunnel, got } = await c.connect(opener, "127.0.0.1");
    await tunnel.write(Buffer.from("x"));
    await until("echo", () => got.length > 0);
    assert.deepEqual(c.dials, [{ address: "127.0.0.1", port: 443 }]);
    tunnel.close();
    // The same address granted without allowPrivate is refused when the connection is made.
    await c.grants.grant(c.owner, { commandId: cid("g"), taskId: c.ctx.taskId, host: "127.0.0.2", port: 443 });
    await assert.rejects(() => c.connect(opener, "127.0.0.2"), NetworkRefused);
  });

  suite("a revoke ends an open connection at once, without a restart; the log says why", async (c) => {
    c.names.set("live.example.com", [PUBLIC]);
    const g = await c.grant("live.example.com");
    const relay = c.relay({ recheckMs: 60_000 }); // only the revoke push can end it here
    const { tunnel, got, closed } = await c.connect(relay.forAttempt(c.ctx), "live.example.com");
    await tunnel.write(Buffer.from("a")); await until("echo", () => got.length > 0);
    await c.grants.revoke(c.owner, { commandId: cid("r"), grantId: g });
    assert.match(await closed, /revoked/);
    await until("close logged", async () => (await logOf(c)).some((x) => x.outcome === "closed"));
    assert.equal((await logOf(c))[0]!.endedBy, "revoked");
    await assert.rejects(() => tunnel.write(Buffer.from("b")));
    await assert.rejects(() => c.connect(relay.forAttempt(c.ctx), "live.example.com"), NetworkRefused, "and a new one is refused");
    assert.equal(relay.open, 0);
  });

  suite("the end of the task ends an open connection (found by the recheck, as in another process)", async (c) => {
    c.names.set("live.example.com", [PUBLIC]);
    await c.grant("live.example.com");
    const { closed } = await c.connect(c.relay().forAttempt(c.ctx), "live.example.com");
    await c.end();
    assert.match(await closed, /ended|revoked|grant/);
    await until("close logged", async () => (await logOf(c)).some((x) => x.outcome === "closed"));
  });

  suite("a connection that cannot be made is a refusal with a reason and a failed record; closeAll ends the attempt's connections; the caps hold", async (c) => {
    c.names.set("down.example.com", [PUBLIC]); c.names.set("up.example.com", [PUBLIC]);
    await c.grant("down.example.com"); await c.grant("up.example.com");
    const failing = new NetworkRelay({ grants: c.grants, resolve: async () => [PUBLIC], dial: () => netConnect({ host: "127.0.0.1", port: 1 }), recheckMs: 20 });
    try { await assert.rejects(() => c.connect(failing.forAttempt(c.ctx), "down.example.com"), (e: unknown) => e instanceof NetworkRefused && /could not connect/.test(e.message)); } finally { failing.close(); }
    await until("failed logged", async () => (await logOf(c)).some((x) => x.outcome === "failed"));
    const relay = c.relay({ maxOpen: 2, maxLogged: 6 });
    const opener = relay.forAttempt(c.ctx);
    const a = await c.connect(opener, "up.example.com"); const b = await c.connect(opener, "up.example.com");
    await assert.rejects(() => c.connect(opener, "up.example.com"), /too many connections/);
    opener.closeAll();
    assert.match(await a.closed, /./); assert.match(await b.closed, /./);
    assert.equal(relay.open, 0);
    // The log is bounded: past the cap nothing more is connected, and nothing more is written.
    await until("all closes logged", async () => (await logOf(c)).every((x) => x.outcome !== "open"));
    for (let i = 0; i < 10; i++) await c.connect(opener, "nogrant.example.com").catch(() => undefined);
    const total = (await logOf(c)).length;
    assert.ok(total <= 7, `the log held ${total}`);
    await assert.rejects(() => c.connect(opener, "up.example.com"), /as many connections/);
  });
}
