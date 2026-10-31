import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { AgentService } from "../agents/index.js";
import { GrantService, PrincipalService, type Principal } from "../security/index.js";
import { scopedCommandId } from "../security/credentials.js";
import { FakeApplier, MAINTENANCE_LIMITS, MaintenanceService, checkSpec, siteRule, type MaintenanceBody } from "./index.js";

after(stopServer);

const D = (c: string): string => `sha256:${c.repeat(64)}`;
const SRC = "https://registry.example.org/pkg";
const pkg = (name: string, extra: Record<string, unknown> = {}) => ({ name, version: "1.2.3", digest: D("a"), source: SRC, installScripts: false, ...extra });
let n = 0;
const cid = (l: string): string => `${l}-${n++}`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface World {
  readonly m: MaintenanceService; readonly applier: FakeApplier; readonly owner: Principal; readonly agents: AgentService; readonly grants: GrantService; readonly principals: PrincipalService;
  readonly time: { ms: number };
  service(extra?: { heartbeatMs?: number }): MaintenanceService;
  make(name: string, by?: Principal, supervisorId?: string): Promise<{ id: string; principal: Principal }>;
  body(id: string): Promise<MaintenanceBody & { revision: number }>;
  until(id: string, want: string): Promise<void>;
  storage: import("../storage/types.js").ControllerStorage;
}
async function world(backendIndex: number, body: (w: World) => Promise<void>, heartbeatMs = 0): Promise<void> {
  const backend = backends[backendIndex]!;
  const open = await backend.open();
  try {
    const time = { ms: Date.parse("2026-10-31T10:00:00.000Z") };
    const options = { clock: () => new Date(time.ms).toISOString(), pause: async () => undefined };
    const projects = await ProjectService.open(open.storage, { holder: "c1", ...options });
    const principals = PrincipalService.withEpoch(open.storage, projects.epoch, options);
    const agents = AgentService.withEpoch(open.storage, projects.epoch, options);
    const grants = GrantService.withEpoch(open.storage, projects.epoch, options);
    const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
    const applier = new FakeApplier();
    const service = (extra: { heartbeatMs?: number } = {}) => MaintenanceService.withEpoch(open.storage, projects.epoch, { applier, heartbeatMs, ...extra }, options);
    const m = service();
    const make: World["make"] = async (friendlyName, by = owner, supervisorId) => {
      const created = await agents.create(by, { commandId: cid("a"), friendlyName, ...(supervisorId === undefined ? {} : { supervisorId }) });
      return { id: created.id, principal: await principals.authenticate((await principals.issueCredential(owner, `agent:${created.id}`)).token) };
    };
    const getBody = async (id: string) => { const a = (await open.storage.getAggregate({ kind: "maintenance", id }))!; return { ...(a.body as unknown as MaintenanceBody), revision: a.revision }; };
    const until = async (id: string, want: string): Promise<void> => { for (let i = 0; i < 200 && (await getBody(id)).status !== want; i++) await sleep(10); assert.equal((await getBody(id)).status, want); };
    await body({ m, applier, owner, agents, grants, principals, time, service, make, body: getBody, until, storage: open.storage });
    await m.idle();
  } finally { await open.close(); }
}
const settle = async (w: World): Promise<void> => { await w.m.idle(); };
const request = (w: World, p: Principal, kind: string, spec: unknown, label = cid("r")) => w.m.request(p, { commandId: label, kind, spec, reason: "needed", rollbackPlan: "undo it" });
const refuses = async (code: string, run: () => Promise<unknown>): Promise<void> => { await assert.rejects(run, (e: unknown) => { assert.ok(e instanceof DomainError, String(e)); assert.equal(e.code, code, (e as Error).message); return true; }); };
const specOf = (w: World, id: string) => w.body(id).then((b) => b.specDigest);
const approve = async (w: World, id: string) => w.m.decide(w.owner, { commandId: cid("d"), maintenanceId: id, verdict: "approve", specDigest: await specOf(w, id) });

// ---- A09 review fixes -------------------------------------------------------------------------------------------------------------------

test("a flood of auto-approved skill drafts cannot push an applied network change out of the scan, and a later denial still reverts it; every request counts toward a per-agent daily cap (the owner is exempt)", async () => {
  await world(0, async (w) => {
    const ann = await w.make("Ann");
    await w.m.change(w.owner, { commandId: cid("s"), requestsPerDay: 10_000, sites: { "docs.example.com": "allow" } });
    await settle(w);
    // The drafts first; then a network request whose ID sorts after every draft (the hash order puts it beyond the first 1000 rows).
    const drafts: string[] = [];
    for (let i = 0; i < MAINTENANCE_LIMITS.scan + 60; i++) drafts.push(derivedId("mnt", scopedCommandId(ann.principal.id, `fl-${i}`)));
    const top = drafts.reduce((a, b) => (a > b ? a : b));
    let k = 0;
    while (derivedId("mnt", scopedCommandId(ann.principal.id, `net-${k}`)) <= top) k++;
    for (let i = 0; i < drafts.length; i++) await w.m.request(ann.principal, { commandId: `fl-${i}`, kind: "skill", spec: { name: `s-${i}`, digest: D("1") }, reason: "x" });
    const net = await w.m.request(ann.principal, { commandId: `net-${k}`, kind: "network", spec: { site: "docs.example.com" }, reason: "docs", rollbackPlan: "close" });
    assert.equal(net.status, "approved");
    await settle(w);
    assert.equal((await w.body(net.maintenanceId)).status, "applied");
    await w.m.site(w.owner, { commandId: cid("s"), site: "docs.example.com", rule: "deny" });
    await settle(w);
    assert.equal((await w.body(net.maintenanceId)).status, "revoked", "the denial reverts the applied change however many other requests exist");
    assert.ok(w.applier.reverted.has(net.maintenanceId));
  });
});

test("the per-agent daily cap counts every request however it is decided, is settable, resets with the window, and does not apply to the owner", async () => {
  await world(0, async (w) => {
    const ann = await w.make("Ann");
    await w.m.change(w.owner, { commandId: cid("s"), requestsPerDay: 3 });
    for (let i = 0; i < 3; i++) await w.m.request(ann.principal, { commandId: cid("k"), kind: "skill", spec: { name: `s-${i}`, digest: D("1") }, reason: "x" });
    await refuses("forbidden", () => w.m.request(ann.principal, { commandId: cid("k"), kind: "skill", spec: { name: "s-over", digest: D("1") }, reason: "x" }));
    assert.ok((await w.m.request(w.owner, { commandId: cid("k"), agentId: ann.principal.id, kind: "skill", spec: { name: "s-own", digest: D("1") }, reason: "x" })).maintenanceId, "the owner is exempt");
    w.time.ms += MAINTENANCE_LIMITS.windowMs + 1000;
    assert.ok((await w.m.request(ann.principal, { commandId: cid("k"), kind: "skill", spec: { name: "s-next-day", digest: D("1") }, reason: "x" })).maintenanceId, "a new window starts");
    assert.equal((await w.m.settings(w.owner)).effective.requestsPerDay, 3);
    await w.m.change(w.owner, { commandId: cid("s"), requestsPerDay: null });
    assert.equal((await w.m.settings(w.owner)).effective.requestsPerDay, MAINTENANCE_LIMITS.requestsPerDay, "the default is bounded");
  });
});

test("a claim is a fence: when the lease runs out a second driver may take over, and the first applier's late result is discarded, recorded as a stale apply result and not allowed to overwrite", async () => {
  await world(0, async (w) => {
    const ann = await w.make("Ann");
    const r = await request(w, ann.principal, "package", pkg("tool-a"));
    let release1!: () => void, release2!: () => void;
    w.applier.gates = [new Promise<void>((res) => { release1 = res; }), new Promise<void>((res) => { release2 = res; })];
    const first = approve(w, r.maintenanceId);
    await w.until(r.maintenanceId, "applying");
    const token1 = (await w.body(r.maintenanceId)).applying!.token;
    assert.equal(await w.m.drive(r.maintenanceId), "applying", "a live lease is left alone");
    w.time.ms += MAINTENANCE_LIMITS.leaseMs + 1000;
    // the lease has run out and nothing renewed it: a second driver claims with its own token (its application is still running)
    const second = w.m.drive(r.maintenanceId);
    for (let i = 0; i < 200 && (await w.body(r.maintenanceId)).applying?.token === token1; i++) await sleep(10);
    const token2 = (await w.body(r.maintenanceId)).applying!.token;
    assert.notEqual(token1, token2);
    // the first applier answers late, while the second claim holds the request in the same status
    release1();
    await first;
    const mid = await w.body(r.maintenanceId);
    assert.equal(mid.status, "applying", "the stale result did not complete the second claim");
    assert.equal(mid.applying!.token, token2);
    assert.equal(mid.effect, undefined, "and wrote no effect");
    assert.equal(mid.stale?.length, 1);
    assert.equal(mid.stale![0]!.note, "stale apply result");
    release2();
    assert.equal(await second, "applied");
    const done = await w.body(r.maintenanceId);
    assert.equal(done.status, "applied");
    assert.equal(done.stale?.length, 1);
    assert.equal(w.applier.calls.filter((c) => c.op === "apply").length, 2, "the applier saw the request twice, by the same ID");
  });
});

test("a stale result for a request that is no longer live is reverted; a stale uncertain result is reverted too", async () => {
  await world(0, async (w) => {
    const ann = await w.make("Ann");
    const r = await request(w, ann.principal, "package", pkg("tool-b"));
    let release!: () => void;
    w.applier.gates = [new Promise<void>((res) => { release = res; })];
    const first = approve(w, r.maintenanceId);
    await w.until(r.maintenanceId, "applying");
    w.time.ms += MAINTENANCE_LIMITS.leaseMs + 1000;
    // the owner denies the site... for a package: switch the rules off and revoke while the first application still runs and the lease is gone
    await w.m.revoke(w.owner, { commandId: cid("v"), maintenanceId: r.maintenanceId, reason: "changed my mind" });
    release();
    await first;
    const b = await w.body(r.maintenanceId);
    assert.ok(["revoked", "revoking"].includes(b.status));
    assert.ok(w.applier.reverted.has(r.maintenanceId), "the effect of the application is undone");
  });
});

test("a heartbeat keeps the lease while the applier runs: a second driver does not take over a live application", async () => {
  await world(0, async (w) => {
    const ann = await w.make("Ann");
    const m = w.service({ heartbeatMs: 15 });
    const r = await request(w, ann.principal, "package", pkg("tool-c"));
    let release!: () => void;
    w.applier.gates = [new Promise<void>((res) => { release = res; })];
    const first = m.decide(w.owner, { commandId: cid("d"), maintenanceId: r.maintenanceId, verdict: "approve", specDigest: await specOf(w, r.maintenanceId) });
    await w.until(r.maintenanceId, "applying");
    for (let step = 0; step < 4; step++) { w.time.ms += MAINTENANCE_LIMITS.leaseMs * 0.6; await sleep(80); }
    assert.equal(await m.drive(r.maintenanceId), "applying", "the renewed lease holds");
    assert.equal(w.applier.calls.filter((c) => c.op === "apply").length, 1);
    release();
    assert.equal((await first).status, "applied");
    assert.equal((await w.body(r.maintenanceId)).stale, undefined);
  });
});

test("a throw from the applier is an unknown state: the request becomes apply-uncertain, a revert pass runs before anything else, and a revoke always calls revert", async () => {
  await world(0, async (w) => {
    const ann = await w.make("Ann");
    const r = await request(w, ann.principal, "package", pkg("tool-d"));
    w.applier.nextApply = ["throw"];
    w.applier.nextRevert = ["throw"];
    await approve(w, r.maintenanceId);
    let b = await w.body(r.maintenanceId);
    assert.equal(b.status, "apply-uncertain", "the revert pass could not run, so the request does not move on");
    assert.match(b.uncertain!.reason, /unknown/);
    assert.equal(w.applier.calls.filter((c) => c.op === "apply").length, 1);
    w.applier.nextRevert = ["throw"];
    const rv = await w.m.revoke(w.owner, { commandId: cid("v"), maintenanceId: r.maintenanceId, reason: "no" });
    assert.equal(rv.status, "revoking", "a revoke of an uncertain application reverts before it is revoked");
    assert.equal((await w.m.drive(r.maintenanceId)), "revoked");
    assert.ok(w.applier.reverted.has(r.maintenanceId));
    // a request that was claimed once and is back to approved also reverts on revoke
    const r2 = await request(w, ann.principal, "package", pkg("tool-e"));
    w.applier.nextApply = [{ outcome: "unsupported", reason: "later" }];
    await approve(w, r2.maintenanceId);
    assert.equal((await w.body(r2.maintenanceId)).status, "approved");
    const before = w.applier.calls.filter((c) => c.op === "revert").length;
    assert.equal((await w.m.revoke(w.owner, { commandId: cid("v"), maintenanceId: r2.maintenanceId, reason: "no" })).status, "revoked");
    assert.equal(w.applier.calls.filter((c) => c.op === "revert").length, before, "unsupported means nothing was changed: no revert needed");
  });
});

test("the application is checked against the package digest: the applier refuses a mismatch, and sources must be https without credentials, and match the catalogue entry to be approved by itself", async () => {
  await world(0, async (w) => {
    const ann = await w.make("Ann");
    w.applier.artifacts = { [SRC]: D("b") };
    const r = await request(w, ann.principal, "package", pkg("tool-f"));
    await approve(w, r.maintenanceId);
    const b = await w.body(r.maintenanceId);
    assert.equal(b.status, "failed");
    assert.match(b.failure!.reason, /digest mismatch/);
    assert.equal(w.applier.effects.size, 0, "nothing was installed");
    w.applier.artifacts = { [SRC]: D("a") };
    const ok = await request(w, ann.principal, "package", pkg("tool-g"));
    await approve(w, ok.maintenanceId);
    assert.equal((await w.body(ok.maintenanceId)).status, "applied");
    for (const source of ["http://registry.example.org/pkg", "https://user:secret-token@registry.example.org/pkg", "https://tok@registry.example.org/pkg", "registry", "file:///etc/passwd", "ftp://x.org/a"]) {
      await assert.rejects(request(w, ann.principal, "package", pkg("tool-h", { source })), (e: unknown) => { assert.ok(e instanceof DomainError); assert.equal(e.code, "invalid_command"); assert.ok(!e.message.includes("secret-token"), "the message does not repeat the credential"); return true; }, source);
    }
    await w.m.catalogue(w.owner, { commandId: cid("c"), add: true, name: "tool-i", version: "1.2.3", digest: D("a"), source: SRC });
    assert.equal((await request(w, ann.principal, "package", pkg("tool-i"))).status, "approved");
    assert.equal((await request(w, ann.principal, "package", pkg("tool-i", { source: "https://other.example.org/pkg" }))).status, "pending", "another source is not preapproved");
  });
});

test("specs are closed-form: names, exact versions", () => {
  const bad = (kind: "package" | "extension" | "skill" | "host-policy", spec: unknown): void => assert.throws(() => checkSpec(kind, spec), (e: unknown) => e instanceof DomainError && e.code === "invalid_command", JSON.stringify(spec));
  for (const name of ["a/b", "../x", "a..b", ".hidden", "@scope/a/b", "x@y", "@", "@/x", "@scope/", "UPPER"]) bad("package", pkg(name));
  bad("extension", pkg("@scope/name"));
  for (const version of ["latest", "^1.2.3", "~1.2", ">=1", "1.x", "1", "1.2", "v1.2.3", "1.2.3 - 2", "*", ""]) bad("package", pkg("ok", { version }));
  bad("skill", { name: "@scope/x", digest: D("1") });
  bad("skill", { name: "a/b", digest: D("1") });
  bad("host-policy", { setting: "../x", change: "c" });
  assert.equal((checkSpec("package", pkg("@scope/name", { version: "1.2.3-rc.1+build.5" })) as { name: string }).name, "@scope/name");
  assert.equal((checkSpec("package", pkg("ripgrep")) as { version: string }).version, "1.2.3");
});

test("a supervisor cannot approve for a puppet: not for an agent it created, nor one whose supervisor it set; sandbox-widening kinds are the owner's unless the owner hands the kind over; a mount is scoped to the requester", async () => {
  await world(0, async (w) => {
    const boss = await w.make("Bea");
    await w.grants.grant(w.owner, { commandId: cid("g"), grantee: boss.principal.id, action: "agent.manage", project: "*", source: "direct", basis: "test" });
    const bossP = await w.principals.authenticate((await w.principals.issueCredential(w.owner, boss.principal.id)).token);
    // puppet created by the boss, supervised by the boss
    const puppet = await w.make("Pup", bossP, boss.id);
    // an agent made by the owner whose supervisor the boss set afterwards
    const other = await w.make("Oth");
    await w.agents.update(bossP, { commandId: cid("u"), agentId: other.id, expectedRevision: (await w.agents.get(w.owner, other.id))!.revision, supervisorId: boss.id });
    // a real report: made by the owner with the boss as supervisor
    const real = await w.make("Rea", w.owner, boss.id);
    await w.m.toggle(w.owner, { commandId: cid("t"), what: "bosses", enabled: true });
    const decideAs = async (who: Principal, id: string) => w.m.decide(who, { commandId: cid("d"), maintenanceId: id, verdict: "approve", specDigest: await specOf(w, id) });
    const net = (p: Principal) => request(w, p, "network", { site: "reach.example.net" });
    // bosses on but no kind handed over: even a legitimate supervisor does not decide a network request
    const n0 = await net(real.principal);
    await refuses("forbidden", () => decideAs(boss.principal, n0.maintenanceId));
    await w.m.change(w.owner, { commandId: cid("s"), bossKinds: ["network", "mount", "package"] });
    await settle(w);
    const n1 = await net(real.principal);
    assert.equal((await decideAs(boss.principal, n1.maintenanceId)).status, "applied", "a real report's supervisor decides a handed-over kind");
    const n2 = await net(puppet.principal);
    await refuses("forbidden", () => decideAs(bossP, n2.maintenanceId));
    await refuses("forbidden", () => decideAs(boss.principal, n2.maintenanceId));
    const n3 = await net(other.principal);
    await refuses("forbidden", () => decideAs(boss.principal, n3.maintenanceId));
    assert.equal((await approve(w, n2.maintenanceId)).status, "applied", "the owner decides for the puppet");
    // protected kinds stay with the owner whatever the setting
    await assert.rejects(w.m.change(w.owner, { commandId: cid("s"), bossKinds: ["base"] }), (e: unknown) => e instanceof DomainError && e.code === "invalid_command");
    // mounts: the requester's own resource (read or write) and a shared read-only one; not another agent's, not the owner's, not a shared write
    const mount = (p: Principal, resource: string, mode: string) => request(w, p, "mount", { mountPath: "/data/x", resource, mode });
    const own = await mount(real.principal, `${real.id}.notes`, "write");
    assert.equal((await decideAs(boss.principal, own.maintenanceId)).status, "applied");
    const shared = await mount(real.principal, "shared.docs", "read");
    assert.equal((await decideAs(boss.principal, shared.maintenanceId)).status, "applied");
    for (const [resource, mode] of [[`${puppet.id}.notes`, "read"], ["owner.secrets", "read"], ["shared.docs", "write"]] as const) {
      const bad = await mount(real.principal, resource, mode);
      await refuses("forbidden", () => decideAs(boss.principal, bad.maintenanceId));
    }
  });
});

test("site rules consider the port and the subdomains: a deny on a domain denies its subdomains and every port; an allow is for its host and port", async () => {
  const sites = { "evil.com": "deny", "api.good.com": "allow", "api.good.com:8443": "allow", "*.cdn.good.com": "allow", "slow.com:25": "deny" } as const;
  assert.equal(siteRule(sites, "evil.com", 443), "deny");
  assert.equal(siteRule(sites, "a.b.evil.com", 8080), "deny");
  assert.equal(siteRule(sites, "notevil.com", 443), undefined, "a suffix of the name is not a subdomain");
  assert.equal(siteRule(sites, "api.good.com", 443), "allow");
  assert.equal(siteRule(sites, "api.good.com", 8443), "allow");
  assert.equal(siteRule(sites, "api.good.com", 22), undefined, "an allow does not cover other ports");
  assert.equal(siteRule(sites, "x.api.good.com", 443), undefined, "an allow does not cover subdomains");
  assert.equal(siteRule(sites, "x.cdn.good.com", 443), "allow");
  assert.equal(siteRule(sites, "slow.com", 25), "deny");
  assert.equal(siteRule(sites, "slow.com", 443), undefined);
  await world(0, async (w) => {
    const ann = await w.make("Ann");
    await w.m.change(w.owner, { commandId: cid("s"), sites: { "evil.com": "deny", "ok.org": "allow" } });
    await settle(w);
    assert.equal((await request(w, ann.principal, "network", { site: "sub.evil.com", port: 8080 })).status, "rejected");
    assert.equal((await request(w, ann.principal, "network", { site: "ok.org", port: 443 })).status, "approved");
    assert.equal((await request(w, ann.principal, "network", { site: "ok.org", port: 22 })).status, "pending", "an allowed site is not allowed on every port");
    assert.equal((await request(w, ann.principal, "network", { site: "deeper.ok.org" })).status, "pending", "an allow is not for subdomains");
    await assert.rejects(w.m.change(w.owner, { commandId: cid("s"), sites: { "*.evil.com": "deny" } }), (e: unknown) => e instanceof DomainError);
    await assert.rejects(w.m.change(w.owner, { commandId: cid("s"), sites: { "ok.org:70000": "allow" } }), (e: unknown) => e instanceof DomainError);
  });
});

test("writing settings never drives the applier inside the call; a site denied while an application runs is reverted once it ends", async () => {
  await world(0, async (w) => {
    const ann = await w.make("Ann");
    await w.m.change(w.owner, { commandId: cid("s"), sites: { "slow.example.com": "allow", "other.example.com": "allow" } });
    await settle(w);
    const a = await request(w, ann.principal, "network", { site: "other.example.com" });
    await settle(w);
    assert.equal((await w.body(a.maintenanceId)).status, "applied");
    let release!: () => void;
    w.applier.revertGate = new Promise<void>((r) => { release = r; });
    // the write returns although the revert it causes is blocked: it only marks the work
    const done = await Promise.race([w.m.site(w.owner, { commandId: cid("s"), site: "other.example.com", rule: "deny" }).then(() => "returned"), sleep(1500).then(() => "blocked")]);
    assert.equal(done, "returned", "settings writes do not wait for the applier");
    release();
    await settle(w);
    assert.equal((await w.body(a.maintenanceId)).status, "revoked");
    w.applier.revertGate = undefined;
    // a denial that arrives while the application runs
    let hold!: () => void;
    w.applier.gates = [new Promise<void>((r) => { hold = r; })];
    const b = await request(w, ann.principal, "network", { site: "slow.example.com" });
    await w.until(b.maintenanceId, "applying");
    await w.m.site(w.owner, { commandId: cid("s"), site: "slow.example.com", rule: "deny" });
    hold();
    await settle(w);
    await w.m.tick();
    assert.equal((await w.body(b.maintenanceId)).status, "revoked", "the denial written during the application counts once it has ended");
    assert.ok(w.applier.reverted.has(b.maintenanceId));
  });
});
