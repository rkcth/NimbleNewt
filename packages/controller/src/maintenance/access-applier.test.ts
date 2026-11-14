import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AgentService } from "../agents/index.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { AgentSiteAllowances } from "../network/index.js";
import { GrantService, PrincipalService, type Principal } from "../security/index.js";
import type { ControllerStorage } from "../storage/types.js";
import { AccessChangeApplier, AgentMounts, FakeApplier, MAINTENANCE_PRINCIPAL, MaintenanceService, mountGuestPath, mountReachName, type MaintenanceBody, type MountResources } from "./index.js";

// Card A09, network and mount application: an approved request for a network site or a host resource is carried out by the access applier (not by the environment sequence), is idempotent, is taken back by a revoke, and every
// refusal names what to change. The other kinds go to the inner applier untouched.

after(stopServer);

let n = 0;
const cid = (l: string): string => `${l}-${n++}`;
const D = (c: string): string => `sha256:${c.repeat(64)}`;

interface W {
  m: MaintenanceService; sites: AgentSiteAllowances; mounts: AgentMounts; inner: FakeApplier; owner: Principal; held: Set<string>; storage: ControllerStorage;
  ann: { id: string; key: string; principal: Principal }; bob: { id: string; key: string; principal: Principal };
  statusOf(id: string): Promise<MaintenanceBody>;
}
async function world(backendIndex: number, wiring: { sites?: boolean; resources?: boolean }, body: (w: W) => Promise<void>): Promise<void> {
  const open = await backends[backendIndex]!.open();
  try {
    const options = { pause: async () => undefined };
    const projects = await ProjectService.open(open.storage, { holder: "c1", ...options });
    const principals = PrincipalService.withEpoch(open.storage, projects.epoch, options);
    const agents = AgentService.withEpoch(open.storage, projects.epoch, options);
    void GrantService;
    const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
    const inner = new FakeApplier();
    const held = new Set<string>();
    const resources: MountResources = { check: async (r) => (held.has(r) ? { ok: true } : { ok: false, reason: "the host holds no resource of that name" }) };
    const mounts = AgentMounts.withEpoch(open.storage, projects.epoch, MAINTENANCE_PRINCIPAL, options);
    let live: MaintenanceService | undefined;
    const sites = AgentSiteAllowances.withEpoch(open.storage, projects.epoch, MAINTENANCE_PRINCIPAL, { ...options, denied: async (h, p) => live === undefined ? true : live.siteDenied(h, p) });
    const applier = new AccessChangeApplier({ inner, ...(wiring.sites === false ? {} : { sites }), ...(wiring.resources === false ? {} : { mounts, resources }) });
    const m = MaintenanceService.withEpoch(open.storage, projects.epoch, { applier, heartbeatMs: 0 }, options);
    live = m;
    const make = async (name: string) => { const created = await agents.create(owner, { commandId: cid("a"), friendlyName: name }); return { id: `agent:${created.id}`, key: created.id, principal: await principals.authenticate((await principals.issueCredential(owner, `agent:${created.id}`)).token) }; };
    const ann = await make("Ann"); const bob = await make("Bob");
    const statusOf = async (id: string) => (await open.storage.getAggregate({ kind: "maintenance", id }))!.body as unknown as MaintenanceBody;
    await body({ m, sites, mounts, inner, owner, held, storage: open.storage, ann, bob, statusOf });
    await m.idle();
  } finally { await open.close(); }
}
const ask = async (w: W, who: W["ann"], kind: string, spec: unknown): Promise<string> => (await w.m.request(who.principal, { commandId: cid("r"), kind, spec, reason: "needed", rollbackPlan: "take it back" })).maintenanceId;
const approve = async (w: W, id: string) => { const r = await w.m.decide(w.owner, { commandId: cid("d"), maintenanceId: id, verdict: "approve", specDigest: (await w.statusOf(id)).specDigest }); await w.m.idle(); return r; };
const revoke = async (w: W, id: string) => { const r = await w.m.revoke(w.owner, { commandId: cid("v"), maintenanceId: id, reason: "not needed" }); await w.m.idle(); return r; };
const net = (site = "docs.example.com", port = 443) => ({ site, port });
const mnt = (resource: string, extra: Record<string, unknown> = {}) => ({ mountPath: mountGuestPath(resource), resource, mode: "read", ...extra });

for (let i = 0; i < backends.length; i++) {
  const name = backends[i]!.name;

  test(`${name}: an approved network request allows the agent's site through the relay, is idempotent, and a revoke takes it back; the other kinds still reach the inner applier`, async () => {
    await world(i, {}, async (w) => {
      const id = await ask(w, w.ann, "network", net());
      assert.equal((await w.statusOf(id)).status, "pending");
      assert.equal((await w.sites.check(w.ann.id, "docs.example.com", 443)).live, false, "nothing is allowed before the decision");
      assert.equal((await approve(w, id)).status, "applied");
      const body = await w.statusOf(id);
      assert.deepEqual([body.effect?.["allowed"], body.effect?.["via"], body.effect?.["site"], body.effect?.["port"]], [true, "relay", "docs.example.com", 443]);
      const live = await w.sites.check(w.ann.id, "docs.example.com", 443);
      assert.equal(live.live, true); assert.equal(live.grant?.id, id, "the request is the grant");
      assert.equal((await w.sites.check(w.bob.id, "docs.example.com", 443)).live, false, "another agent gets nothing");
      assert.equal((await w.sites.check(w.ann.id, "docs.example.com", 80)).live, false, "another port gets nothing");
      assert.equal(w.inner.calls.length, 0, "the environment applier was never asked");
      // The same application again changes nothing (a crash and a retry).
      const view = { id, agentId: w.ann.id, kind: "network" as const, class: "access" as const, spec: net(), specDigest: body.specDigest };
      const again = await new AccessChangeApplier({ inner: w.inner, sites: w.sites }).apply(view);
      assert.equal(again.outcome, "applied");
      assert.equal((await w.sites.list(w.owner, w.ann.id))[0]!.requests.length, 1);
      assert.equal((await revoke(w, id)).status, "revoked");
      assert.equal((await w.sites.check(w.ann.id, "docs.example.com", 443)).live, false);
      assert.equal((await w.statusOf(id)).revertEffect?.["allowed"], false);
      // A package goes to the inner applier, as before.
      const p = await ask(w, w.ann, "package", { name: "ripgrep", version: "1.2.3", digest: D("a"), source: "https://registry.example.org/pkg", installScripts: false });
      await approve(w, p);
      assert.deepEqual(w.inner.calls.map((c) => [c.op, c.kind]), [["apply", "package"]]);
    });
  });

  test(`${name}: the owner's rules: an allowed site applies by itself, a site denied after it was applied is taken back and refused at once, a denied site is never applied`, async () => {
    await world(i, {}, async (w) => {
      await w.m.change(w.owner, { commandId: cid("s"), sites: { "docs.example.com": "allow" } });
      const id = await ask(w, w.ann, "network", net());
      await w.m.idle();
      assert.equal((await w.statusOf(id)).status, "applied", "the owner's allow rule needs no person");
      assert.equal((await w.sites.check(w.ann.id, "docs.example.com", 443)).live, true);
      await w.m.site(w.owner, { commandId: cid("s"), site: "docs.example.com", rule: "deny" });
      // At once, before the loop has reverted anything: the relay's own check says no.
      assert.equal((await w.sites.check(w.ann.id, "docs.example.com", 443)).live, false);
      await w.m.tick(); await w.m.idle();
      assert.equal((await w.statusOf(id)).status, "revoked", "the loop took the change back");
      assert.equal((await w.sites.list(w.owner, w.ann.id)).length, 0);
      const again = await ask(w, w.bob, "network", net());
      await w.m.idle();
      assert.equal((await w.statusOf(again)).status, "rejected");
      assert.equal((await w.sites.check(w.bob.id, "docs.example.com", 443)).live, false);
    });
  });

  test(`${name}: with no relay wired an approved network request waits (never claimed), and a site no approval can reach is refused with nothing recorded`, async () => {
    await world(i, { sites: false }, async (w) => {
      const id = await ask(w, w.ann, "network", net());
      assert.equal((await approve(w, id)).status, "approved");
      const body = await w.statusOf(id);
      assert.match(body.pendingReason ?? "", /no network relay is wired/);
      assert.equal(body.effect, undefined);
    });
    await world(i, {}, async (w) => {
      // A request whose site is a private-looking or unreachable name cannot even be written; one that passes the request checks but not the allowance's (a private name) fails with its reason.
      const id = await ask(w, w.ann, "network", net("localhost.example.com"));
      assert.equal((await approve(w, id)).status, "applied", "a public-looking name is allowed; where it resolves is judged at every connection");
      const private1 = await new AccessChangeApplier({ inner: w.inner, sites: w.sites }).apply({ id: "mnt-bbbbbbbbbbbbbbbbbbbb", agentId: w.ann.id, kind: "network", class: "access", spec: { site: "10.0.0.5", port: 443 }, specDigest: D("a") });
      assert.equal(private1.outcome, "failed");
      assert.equal((await w.sites.list(w.owner, w.ann.id)).length, 1, "nothing was recorded for the refused one");
    });
  });

  test(`${name}: an approved mount of the agent's own resource is recorded, read-only, at the one place the host puts it; a revoke ends it; refusals leave nothing behind`, async () => {
    await world(i, {}, async (w) => {
      const own = `${w.ann.key}.data`;
      w.held.add(own); w.held.add("shared.docs");
      const id = await ask(w, w.ann, "mount", mnt(own));
      assert.equal((await approve(w, id)).status, "applied");
      assert.deepEqual((await w.mounts.of(w.ann.id)).map((e) => [e.resource, e.mountPath, e.mode, e.requestId]), [[own, mountGuestPath(own), "read", id]]);
      assert.deepEqual(await w.mounts.reachNames(w.ann.id), [mountReachName(own)]);
      assert.deepEqual(await w.mounts.reachNames(w.bob.id), [], "another agent has none");
      assert.equal((await w.statusOf(id)).effect?.["mounted"], true);
      const shared = await ask(w, w.ann, "mount", mnt("shared.docs"));
      assert.equal((await approve(w, shared)).status, "applied");
      assert.equal((await w.mounts.of(w.ann.id)).length, 2);
      assert.equal((await revoke(w, id)).status, "revoked");
      assert.deepEqual(await w.mounts.reachNames(w.ann.id), [mountReachName("shared.docs")]);
      assert.equal((await w.statusOf(id)).revertEffect?.["mounted"], false);
      // Refusals: write access, another agent's resource, a path other than the one the host uses, a resource the host does not hold, a shared one for write.
      const refusals: [string, Record<string, unknown>, RegExp][] = [
        ["write", mnt(own, { mode: "write" }), /only read access/],
        ["other agent's", mnt(`${w.bob.key}.data`), /own resource or a shared one/],
        ["path", mnt(own, { mountPath: "/data/mine" }), /ask for exactly that path/],
        ["absent", mnt(`${w.ann.key}.gone`, { mountPath: mountGuestPath(`${w.ann.key}.gone`) }), /holds no resource/],
        ["shared write", mnt("shared.docs", { mode: "write" }), /only read access/],
      ];
      for (const [label, spec, why] of refusals) {
        const r = await ask(w, w.ann, "mount", spec);
        await approve(w, r);
        const b = await w.statusOf(r);
        assert.equal(b.status, "failed", label);
        assert.match(b.failure?.reason ?? "", why, label);
      }
      assert.equal((await w.mounts.of(w.ann.id)).length, 1, "none of the refused left a mount behind");
    });
  });

  test(`${name}: with no resource store an approved mount waits; a repeat of the same request records one mount; the per-agent bound holds`, async () => {
    await world(i, { resources: false }, async (w) => {
      const id = await ask(w, w.ann, "mount", mnt(`${w.ann.key}.data`));
      assert.equal((await approve(w, id)).status, "approved");
      assert.match((await w.statusOf(id)).pendingReason ?? "", /no store of resources/);
    });
    await world(i, {}, async (w) => {
      const own = `${w.ann.key}.data`; w.held.add(own);
      const id = await ask(w, w.ann, "mount", mnt(own));
      await approve(w, id);
      assert.equal((await w.mounts.add(id, w.ann.id, own, mountGuestPath(own))).added, false, "the same request is not recorded twice");
      assert.equal((await w.mounts.of(w.ann.id)).length, 1);
      await assert.rejects(() => w.mounts.list({ ...w.owner, kind: "agent", id: w.ann.id } as never, w.ann.id), /only the owner/);
      await w.mounts.end(id, w.ann.id); await w.mounts.end(id, w.ann.id);
      assert.equal((await w.mounts.of(w.ann.id)).length, 0);
    });
  });
}
