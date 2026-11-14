import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { connect as netConnect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ScriptedInterpreter } from "../chat/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI, ScriptedWorker } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { mountGuestPath, type MountResources } from "../maintenance/index.js";
import { NetworkRefused, type NetworkOpener, type TunnelEvents } from "../network/index.js";
import { startController } from "./index.js";
import type { DispatchStartOptions } from "./dispatch-compose.js";

// Card A09, network and mount application, composed through the started controller: an agent asks for a site and a resource through the state API; the owner decides; the relay lets the agent's attempts reach exactly that site; the owner's deny rule
// and a revoke (by API and by chat) end it; the mount is recorded for the agent's next attempts; the owner can see both with one query. No real network: the "site" is a loopback server the test remaps one checked address to.
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const PUBLIC = "93.184.216.34";
type Reply = { ok: boolean; result?: any; error?: { code: string; message: string } };
type BuildServices = Parameters<NonNullable<DispatchStartOptions["local"]>["build"]>[0];
async function until(label: string, check: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) { if (Date.now() > end) assert.fail(`timed out waiting for ${label}`); await new Promise((r) => setTimeout(r, 10)); }
}

test("approved network sites and mounts take effect for the agent's attempts, are listed to the owner, end on a revoke by API or chat, and the owner's deny rule wins at once (card A09)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-a09-access-"));
  const sockets = new Set<Socket>();
  const echo = createServer((s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); s.on("error", () => undefined); s.on("data", (x) => s.write(x)); });
  await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
  const echoPort = (echo.address() as { port: number }).port;
  const held = new Set<string>();
  const mountResources: MountResources = { check: async (r) => (held.has(r) ? { ok: true } : { ok: false, reason: "the host holds no resource of that name" }) };
  let services: BuildServices | undefined;
  const say: Record<string, unknown[]> = {};
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) },
    dispatch: {
      timer: new ManualTimer(), manual: true,
      local: { window: () => 32768, acceptUnenforcedLimits: true, build: (s: BuildServices) => { services = s; return new ScriptedWorker("host:w1", async () => ({ status: "completed", text: "done" })); } },
      network: { resolve: async () => [PUBLIC], dial: () => netConnect({ host: "127.0.0.1", port: echoPort }), recheckMs: 20 },
    },
    maintenance: { mountResources },
  } as never);
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const s = c.services;
    const owner = await s.principals.authenticate((await s.principals.bootstrapOwner({ name: "rob" })).token);
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<Reply>;
    const ownerToken = (await s.principals.issueCredential(owner, owner.id)).token;
    const ann = (await s.agents.create(owner, { commandId: "ag-ann", friendlyName: "Ann" } as never)).id;
    const annToken = (await s.principals.issueCredential(owner, `agent:${ann}`)).token;
    const project = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
    const task = (await s.projects.createTask({ commandId: "t-1", actor: owner.id, projectId: project, title: "Read the docs" })).id;
    const ctx = { taskId: task, projectId: project, attemptId: "att-1", agentId: `agent:${ann}` };
    const open = async (opener: NetworkOpener, host: string): Promise<{ tunnel: Awaited<ReturnType<NetworkOpener["open"]>>; got: Buffer[]; closed: Promise<string> }> => {
      const got: Buffer[] = []; let done!: (why: string) => void; const closed = new Promise<string>((r) => { done = r; });
      const events: TunnelEvents = { data: (chunk) => { got.push(Buffer.from(chunk)); }, closed: (why) => done(why) };
      return { tunnel: await opener.open({ host, port: 443 }, events), got, closed };
    };
    assert.ok(services?.network !== undefined, "the relay is composed");
    const relay = (agent = ctx.agentId): NetworkOpener => services!.network!.forAttempt({ ...ctx, agentId: agent } as never) as NetworkOpener;
    assert.ok(s.agentSites !== undefined && s.agentMounts !== undefined);

    // ---- the agent asks; nothing is reachable before the decision
    const asked = await call(annToken, "maintenance.request", { kind: "network", spec: { site: "docs.example.com", port: 443 }, reason: "read the library's documentation", rollbackPlan: "revoke it" }, "r-net");
    assert.ok(asked.ok, JSON.stringify(asked));
    const id = asked.result.maintenanceId as string;
    assert.equal(asked.result.status, "pending");
    await assert.rejects(() => open(relay(), "docs.example.com"), NetworkRefused);
    // ---- the owner decides: the site is the agent's from the next connection
    const item = (await call(annToken, "maintenance.get", { maintenanceId: id })).result.item;
    const dec = await call(ownerToken, "maintenance.decide", { maintenanceId: id, verdict: "approve", specDigest: item.specDigest }, "d-net");
    assert.equal(dec.result.status, "applied", JSON.stringify(dec));
    const live = await open(relay(), "docs.example.com");
    await live.tunnel.write(Buffer.from("ping"));
    await until("the echo", () => Buffer.concat(live.got).toString() === "ping");
    await assert.rejects(() => open(relay(), "other.example.com"), NetworkRefused, "another site stays closed");
    await assert.rejects(() => open(relay(`agent:${ann}-other`), "docs.example.com"), NetworkRefused, "another agent stays closed");
    // ---- the owner sees what the agent holds with one query; the agent may not ask
    const access = await call(ownerToken, "maintenance.access", { agentId: `agent:${ann}` });
    assert.deepEqual(access.result.sites.map((x: any) => [x.host, x.port, x.requests]), [["docs.example.com", 443, [id]]]);
    assert.deepEqual(access.result.mounts, []);
    assert.equal((await call(annToken, "maintenance.access", { agentId: `agent:${ann}` })).error?.code, "forbidden");
    // ---- the connection log names the request
    await until("log", async () => (await call(ownerToken, "network.connections", { taskId: task })).result.items.some((x: any) => x.grantId === id));
    // ---- the owner's deny rule wins at once: the open connection ends and a new one is refused before anything is reverted
    const denied = await call(ownerToken, "maintenance.site.set", { site: "docs.example.com", rule: "deny" }, "s-deny");
    assert.ok(denied.ok, JSON.stringify(denied));
    assert.match(await live.closed, /revoked/);
    await assert.rejects(() => open(relay(), "docs.example.com"), NetworkRefused); // whether the rule or the already finished revert says no, it is refused
    await c.services.maintenance.tick(); await c.services.maintenance.idle();
    assert.equal((await call(ownerToken, "maintenance.get", { maintenanceId: id })).result.item.status, "revoked", "the loop then took the change back");
    assert.deepEqual((await call(ownerToken, "maintenance.access", { agentId: `agent:${ann}` })).result.sites, []);
    await call(ownerToken, "maintenance.site.set", { site: "docs.example.com", rule: "clear" }, "s-clear").catch(() => undefined);

    // ---- a second site, ended by the owner in chat words (the verb and the ID)
    const again = await call(annToken, "maintenance.request", { kind: "network", spec: { site: "api.example.com", port: 443 }, reason: "call the library's API", rollbackPlan: "revoke it" }, "r-net2");
    const id2 = again.result.maintenanceId as string;
    const item2 = (await call(annToken, "maintenance.get", { maintenanceId: id2 })).result.item;
    assert.equal((await call(ownerToken, "maintenance.decide", { maintenanceId: id2, verdict: "approve", specDigest: item2.specDigest }, "d-net2")).result.status, "applied");
    const open2 = await open(relay(), "api.example.com");
    const words = `revoke ${id2}, the research is finished`;
    say[words] = [{ kind: "command", op: "maintenance.revoke", args: { maintenanceId: id2, reason: "the research is finished" }, evidence: words, basis: "owner" }];
    const outcome = (await c.chat!.submit(ownerToken, { messageId: "chat-1", text: words })).outcomes[0]!;
    assert.equal(outcome.status, "applied", JSON.stringify(outcome));
    assert.match(await open2.closed, /revoked/, "revoking by chat ended the open connection");
    await assert.rejects(() => open(relay(), "api.example.com"), NetworkRefused);

    // ---- a mount: the agent's own resource, read-only, recorded for its next attempts
    const own = `${ann}.data`; held.add(own);
    const m = await call(annToken, "maintenance.request", { kind: "mount", spec: { mountPath: mountGuestPath(own), resource: own, mode: "read" }, reason: "read my dataset", rollbackPlan: "revoke it" }, "r-mnt");
    assert.ok(m.ok, JSON.stringify(m));
    const mid = m.result.maintenanceId as string;
    const mitem = (await call(annToken, "maintenance.get", { maintenanceId: mid })).result.item;
    assert.equal((await call(ownerToken, "maintenance.decide", { maintenanceId: mid, verdict: "approve", specDigest: mitem.specDigest }, "d-mnt")).result.status, "applied");
    assert.deepEqual(await s.agentMounts!.reachNames(`agent:${ann}`), [`mount:${own}`]);
    assert.deepEqual((await call(ownerToken, "maintenance.access", { agentId: `agent:${ann}` })).result.mounts.map((x: any) => [x.resource, x.mountPath, x.mode, x.request]), [[own, mountGuestPath(own), "read", mid]]);
    // the owner asks in free words, by the agent's name: the mount and the (now empty) sites are told apart from "not enforced"
    const q = "what can Ann reach and mount";
    say[q] = [{ kind: "status", request: { kind: "access", agentName: "Ann" }, evidence: q, basis: "owner" }];
    const told = (await c.chat!.submit(ownerToken, { messageId: "chat-2", text: q })).outcomes[0]!;
    assert.equal(told.status, "answered", JSON.stringify(told));
    assert.match(JSON.stringify(told), /may reach no network site/);
    assert.match(JSON.stringify(told), new RegExp(`gets ${own.replace(/\./g, "\\.")} read-only at /inputs/mounts/`));
    // a write mount is approved by the owner but refused when applied: the request fails and leaves nothing
    const w = await call(annToken, "maintenance.request", { kind: "mount", spec: { mountPath: mountGuestPath(own), resource: own, mode: "write" }, reason: "write my dataset", rollbackPlan: "revoke it" }, "r-mnt-w");
    const witem = (await call(annToken, "maintenance.get", { maintenanceId: w.result.maintenanceId })).result.item;
    assert.equal((await call(ownerToken, "maintenance.decide", { maintenanceId: w.result.maintenanceId, verdict: "approve", specDigest: witem.specDigest }, "d-mnt-w")).result.status, "failed");
    assert.equal((await s.agentMounts!.of(`agent:${ann}`)).length, 1);
    assert.equal((await call(ownerToken, "maintenance.revoke", { maintenanceId: mid, reason: "not needed" }, "v-mnt")).result.status, "revoked");
    assert.deepEqual(await s.agentMounts!.reachNames(`agent:${ann}`), []);
  } finally {
    await c.close();
    for (const x of sockets) x.destroy();
    await new Promise<void>((r) => echo.close(() => r()));
    rmSync(d, { recursive: true, force: true });
  }
});

test("without a relay or a resource store the access kinds stay pending and the owner's query says so instead of showing nothing (card A09)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-a09-access2-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], chat: { interpreter: new ScriptedInterpreter(() => []) } } as never);
  try {
    const s = c.services;
    const owner = await s.principals.authenticate((await s.principals.bootstrapOwner({ name: "rob" })).token);
    const ownerToken = (await s.principals.issueCredential(owner, owner.id)).token;
    const call = (op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(ownerToken, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<Reply>;
    const ann = (await s.agents.create(owner, { commandId: "ag-ann", friendlyName: "Ann" } as never)).id;
    const r = await call("maintenance.request", { agentId: `agent:${ann}`, kind: "network", spec: { site: "docs.example.com", port: 443 }, reason: "docs", rollbackPlan: "revoke" }, "r1");
    const item = (await call("maintenance.get", { maintenanceId: r.result.maintenanceId })).result.item;
    const dec = await call("maintenance.decide", { maintenanceId: r.result.maintenanceId, verdict: "approve", specDigest: item.specDigest }, "d1");
    assert.equal(dec.result.status, "approved", "approved, not applied: nothing claims a site that nothing enforces");
    const access = await call("maintenance.access", { agentId: `agent:${ann}` });
    assert.match(access.result.sites.unavailable, /no network relay/);
    assert.match(access.result.mounts.unavailable, /no host resource store/);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true }); }
});
