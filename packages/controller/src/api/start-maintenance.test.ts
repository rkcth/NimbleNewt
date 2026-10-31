import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ScriptedInterpreter } from "../chat/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { FakeApplier, MAINTENANCE_LIMITS } from "../maintenance/index.js";
import { PolicyService } from "../policy/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
type Reply = { ok: boolean; result?: any; error?: { code: string; message: string } };
const D = (c: string): string => `sha256:${c.repeat(64)}`;
const pkg = (name: string, extra: Record<string, unknown> = {}) => ({ name, version: "1.2.3", digest: D("a"), source: "https://registry.example.org/pkg", installScripts: false, ...extra });

async function boot(d: string, applier: FakeApplier | undefined, say: Record<string, unknown[]> = {}, again?: string) {
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [],
    chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) },
    ...(applier === undefined ? {} : { maintenance: { applier } }),
  } as never);
  const owner = again === undefined ? await c.services.principals.bootstrapOwner({ name: "rob" }) : { token: again };
  const rob = await c.services.principals.authenticate(owner.token);
  let n = 0;
  const cid = (l: string): string => `${l}-${n++}`;
  const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<Reply>;
  const agent = async (name: string, supervisor?: string) => {
    const id = (await c.services.agents.create(rob, { commandId: cid("ag"), friendlyName: name, roles: ["author"], ...(supervisor === undefined ? {} : { supervisorId: supervisor }) } as never)).id;
    return { id, principal: `agent:${id}`, token: (await c.services.principals.issueCredential(rob, `agent:${id}`)).token };
  };
  return { c, owner: owner.token, rob, call, cid, agent };
}

test("a maintenance request is recorded at once, decided by the owner in the strict profile, applied with a recorded effect, revoked and reverted; skill drafts, the catalogue and sites follow the owner's rules (card A09)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-a09-"));
  const applier = new FakeApplier();
  const w = await boot(d, applier);
  const { c, call, cid } = w;
  try {
    const boss = await w.agent("Bea");
    const ann = await w.agent("Ann", boss.id);
    const ben = await w.agent("Ben");
    // ---- the request returns an ID at once; it waits for the owner (strict); the reviewer sees the exact request
    const asked = await call(ann.token, "maintenance.request", { kind: "package", spec: pkg("ripgrep"), reason: "search the repository faster", rollbackPlan: "remove the package" }, "r1");
    assert.ok(asked.ok, JSON.stringify(asked));
    assert.match(asked.result.maintenanceId, /^mnt-/);
    assert.equal(asked.result.status, "pending");
    assert.equal(applier.calls.length, 0, "nothing is applied before a decision");
    assert.equal((await call(ann.token, "maintenance.request", { kind: "package", spec: pkg("ripgrep"), reason: "search the repository faster", rollbackPlan: "remove the package" }, "r1")).result.maintenanceId, asked.result.maintenanceId, "a replay is the same request");
    const id = asked.result.maintenanceId as string;
    const item = (await call(ann.token, "maintenance.get", { maintenanceId: id })).result.item;
    assert.deepEqual([item.kind, item.class, item.spec.version, item.spec.source, item.spec.installScripts, item.rollbackPlan], ["package", "dependency", "1.2.3", "https://registry.example.org/pkg", false, "remove the package"]);
    assert.equal((await call(ben.token, "maintenance.get", { maintenanceId: id })).error?.code, "not_found", "another agent sees nothing");
    assert.equal((await call(boss.token, "maintenance.get", { maintenanceId: id })).ok, true, "the supervisor may read");
    assert.deepEqual((await call(ben.token, "maintenance.list", {})).result.items, []);
    assert.equal((await call(w.owner, "maintenance.list", { status: "pending" })).result.items.length, 1);
    // ---- who may not decide: the requester, another agent, the supervisor in the strict profile
    for (const t of [ann.token, ben.token, boss.token]) assert.equal((await call(t, "maintenance.decide", { maintenanceId: id, verdict: "approve", specDigest: item.specDigest }, cid("d"))).error?.code, t === ben.token ? "not_found" : "forbidden");
    // ---- the owner: the digest must be the one read, a stale revision is refused
    assert.equal((await call(w.owner, "maintenance.decide", { maintenanceId: id, verdict: "approve", specDigest: D("f") }, cid("d"))).error?.code, "invalid_command");
    assert.equal((await call(w.owner, "maintenance.decide", { maintenanceId: id, verdict: "approve", specDigest: item.specDigest, expectedRevision: 9 }, cid("d"))).error?.code, "stale_revision");
    const dec = await call(w.owner, "maintenance.decide", { maintenanceId: id, verdict: "approve", specDigest: item.specDigest, expectedRevision: item.revision }, "dec1");
    assert.ok(dec.ok, JSON.stringify(dec));
    assert.equal(dec.result.status, "applied");
    assert.equal(applier.calls.filter((x) => x.op === "apply").length, 1);
    const applied = (await call(w.owner, "maintenance.get", { maintenanceId: id })).result.item;
    assert.equal(applied.effect.applied, id, "the effect is recorded");
    assert.equal(applied.decision.via, "owner");
    assert.equal((await call(w.owner, "maintenance.decide", { maintenanceId: id, verdict: "reject", specDigest: item.specDigest }, cid("d"))).error?.code, "invalid_transition", "decided once");
    // ---- revoke: only the owner (strict), the applier reverts, the record keeps both effects
    assert.equal((await call(ann.token, "maintenance.revoke", { maintenanceId: id, reason: "no" }, cid("rv"))).error?.code, "forbidden", "an applied change is not the requester's to take back");
    const rev = await call(w.owner, "maintenance.revoke", { maintenanceId: id, reason: "not needed any more" }, cid("rv"));
    assert.deepEqual([rev.ok, rev.result.status], [true, "revoked"]);
    assert.ok(applier.reverted.has(id));
    assert.equal((await call(w.owner, "maintenance.get", { maintenanceId: id })).result.item.revertEffect.reverted, id);

    // ---- a skill draft is allowed and recorded, no one decides; its spec cannot carry a capability
    const skill = await call(ann.token, "maintenance.request", { kind: "skill", spec: { name: "my-skill", digest: D("1") }, reason: "keep notes" }, "r2");
    assert.equal(skill.result.status, "approved");
    await c.services.maintenance.idle();
    const sk = (await call(ann.token, "maintenance.get", { maintenanceId: skill.result.maintenanceId })).result.item;
    assert.deepEqual([sk.status, sk.decision.rule, sk.decision.via], ["applied", "skill-draft", "rule"]);
    assert.equal((await call(ann.token, "maintenance.request", { kind: "skill", spec: { name: "my-skill", digest: D("1"), capabilities: ["shell.*"] }, reason: "x" }, "r3")).error?.code, "invalid_command", "a skill cannot grant itself anything");

    // ---- network sites: the profile (owner) by default, the owner's per-site rules over it
    const net = (site: string, l: string) => call(ann.token, "maintenance.request", { kind: "network", spec: { site }, reason: "fetch docs", rollbackPlan: "close the site" }, l);
    assert.equal((await net("pypi.org", "n1")).result.status, "pending");
    assert.equal((await call(ann.token, "maintenance.settings.get", {})).error?.code, "forbidden");
    assert.ok((await call(w.owner, "maintenance.site.set", { site: "pypi.org", rule: "allow", expectedRevision: 0 }, cid("s"))).ok);
    assert.equal((await call(w.owner, "maintenance.site.set", { site: "pypi.org", rule: "deny", expectedRevision: 0 }, cid("s"))).error?.code, "stale_revision");
    const allowed = await net("pypi.org", "n2");
    assert.equal(allowed.result.status, "approved");
    await c.services.maintenance.idle();
    assert.equal((await call(ann.token, "maintenance.get", { maintenanceId: allowed.result.maintenanceId })).result.item.status, "applied");
    // denying the site narrows at once: the applied change is reverted, a new request is rejected, a pending one cannot be approved
    const pendingEvil = await call(ann.token, "maintenance.request", { kind: "network", spec: { site: "evil.example.com" }, reason: "fetch", rollbackPlan: "close" }, "n3");
    assert.equal(pendingEvil.result.status, "pending");
    assert.ok((await call(w.owner, "maintenance.site.set", { site: "pypi.org", rule: "deny" }, cid("s"))).ok);
    assert.ok((await call(w.owner, "maintenance.site.set", { site: "evil.example.com", rule: "deny" }, cid("s"))).ok);
    await c.services.maintenance.idle();
    assert.equal((await call(ann.token, "maintenance.get", { maintenanceId: allowed.result.maintenanceId })).result.item.status, "revoked", "a denied site reverts an applied change");
    assert.equal((await net("pypi.org", "n4")).result.status, "rejected");
    const evilItem = (await call(w.owner, "maintenance.get", { maintenanceId: pendingEvil.result.maintenanceId })).result.item;
    assert.equal((await call(w.owner, "maintenance.decide", { maintenanceId: pendingEvil.result.maintenanceId, verdict: "approve", specDigest: evilItem.specDigest }, cid("d"))).error?.code, "forbidden", "not even the owner approves a denied site without clearing the rule");
    for (const bad of ["Not A Site", "10.0.0.1", "a_b.com", "localhost", "https://x.com"]) assert.equal((await call(w.owner, "maintenance.site.set", { site: bad, rule: "allow" }, cid("s"))).error?.code, "invalid_command", bad);

    // ---- preapproved catalogue: exact name, version and digest; install scripts need their own preapproval
    assert.ok((await call(w.owner, "maintenance.catalogue.add", { name: "jq", version: "1.7.1", digest: D("a"), source: "https://registry.example.org/pkg" }, cid("c"))).ok);
    assert.equal((await call(ann.token, "maintenance.request", { kind: "package", spec: pkg("jq", { version: "1.7.1" }), reason: "json", rollbackPlan: "remove" }, "c1")).result.status, "approved");
    assert.equal((await call(ann.token, "maintenance.request", { kind: "package", spec: pkg("jq", { version: "1.7.2" }), reason: "json", rollbackPlan: "remove" }, "c2")).result.status, "pending", "another version is not preapproved");
    assert.equal((await call(ann.token, "maintenance.request", { kind: "package", spec: pkg("jq", { version: "1.7.1", digest: D("b") }), reason: "json", rollbackPlan: "remove" }, "c3")).result.status, "pending", "another digest is not preapproved");
    assert.equal((await call(ann.token, "maintenance.request", { kind: "package", spec: pkg("jq", { version: "1.7.1", installScripts: true }), reason: "json", rollbackPlan: "remove" }, "c4")).result.status, "pending", "install scripts are not covered by a plain entry");
    await c.services.maintenance.idle();
    assert.ok((await call(w.owner, "maintenance.settings.disable", { what: "rules" }, cid("c"))).ok);
    assert.equal((await call(ann.token, "maintenance.request", { kind: "package", spec: pkg("jq", { version: "1.7.1" }), reason: "again", rollbackPlan: "remove" }, "c5")).result.status, "pending", "with rules off a person decides");

    // ---- protected: a supervisor can never decide, whatever the setting
    assert.ok((await call(w.owner, "maintenance.settings.enable", { what: "bosses" }, cid("c"))).ok);
    assert.ok((await call(w.owner, "maintenance.settings.set", { bossKinds: ["mount", "network", "package"] }, cid("c"))).ok, "supervisors decide only the kinds the owner handed over");
    const base = await call(ann.token, "maintenance.request", { kind: "base", spec: { change: "add a shared tool" }, reason: "everyone needs it", rollbackPlan: "remove" }, "b1");
    const baseItem = (await call(w.owner, "maintenance.get", { maintenanceId: base.result.maintenanceId })).result.item;
    assert.equal((await call(boss.token, "maintenance.decide", { maintenanceId: base.result.maintenanceId, verdict: "approve", specDigest: baseItem.specDigest }, cid("d"))).error?.code, "forbidden");
    // ---- a supervisor (bosses on) decides an access request of its report, not its own, not another's
    const mount = await call(ann.token, "maintenance.request", { kind: "mount", spec: { mountPath: "/data/docs", resource: `${ann.id}.docs`, mode: "read" }, reason: "read docs", rollbackPlan: "unmount" }, "m1");
    const mountItem = (await call(boss.token, "maintenance.get", { maintenanceId: mount.result.maintenanceId })).result.item;
    const bossDec = await call(boss.token, "maintenance.decide", { maintenanceId: mount.result.maintenanceId, verdict: "approve", specDigest: mountItem.specDigest }, cid("d"));
    assert.ok(bossDec.ok, JSON.stringify(bossDec));
    assert.equal(bossDec.result.status, "applied");
    assert.equal((await call(w.owner, "maintenance.get", { maintenanceId: mount.result.maintenanceId })).result.item.decision.via, "supervisor");
    // the supervisor's right ends when the owner switches it off: the next approval is refused, and revoking is the owner's again
    assert.ok((await call(w.owner, "maintenance.settings.disable", { what: "bosses" }, cid("c"))).ok);
    assert.equal((await call(boss.token, "maintenance.revoke", { maintenanceId: mount.result.maintenanceId, reason: "x" }, cid("rv"))).error?.code, "forbidden");
    assert.equal((await call(w.owner, "maintenance.settings.get", {})).result.item.effective.bosses, false);
  } finally {
    await c.close();
    rmSync(d, { recursive: true, force: true });
  }
});

test("a change that cannot be applied safely stays pending, a failed one is rolled back, a restart picks up an unfinished one, a racing second driver applies nothing twice, install scripts wait for the exact approval (card A09)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-a09b-"));
  const applier = new FakeApplier();
  let w = await boot(d, applier);
  try {
    const ann = await w.agent("Ann");
    const ask = async (label: string, extra: Record<string, unknown> = {}) => {
      const r = await w.call(ann.token, "maintenance.request", { kind: "package", spec: pkg(`tool-${label}`, { installScripts: true }), reason: "need it", rollbackPlan: "remove", ...extra }, `q-${label}`);
      return r.result.maintenanceId as string;
    };
    const decide = async (id: string, verdict = "approve") => w.call(w.owner, "maintenance.decide", { maintenanceId: id, verdict, specDigest: (await w.call(w.owner, "maintenance.get", { maintenanceId: id })).result.item.specDigest }, w.cid("d"));
    const status = async (id: string) => (await w.call(w.owner, "maintenance.get", { maintenanceId: id })).result.item;
    const until = async (id: string, want: string): Promise<void> => { for (let i = 0; i < 100 && (await status(id)).status !== want; i++) await new Promise((r) => setTimeout(r, 50)); assert.equal((await status(id)).status, want); };

    // install scripts: nothing runs before the approval, and a rejection never runs them
    const a = await ask("a");
    const b = await ask("b");
    assert.equal(applier.calls.length, 0);
    assert.equal((await decide(b, "reject")).result.status, "rejected");
    assert.equal(applier.calls.length, 0, "a rejected request never reaches the applier");
    // the applier is offline: the change is approved, stays pending with a reason, the environment is untouched
    applier.nextApply = ["throw"];
    const first = await decide(a);
    assert.equal(first.result.status, "approved");
    assert.match((await status(a)).pendingReason, /ended unclearly/, "a throw is an unknown state: the applier is asked to restore, then the request waits");
    assert.ok(applier.calls.some((x) => x.op === "revert" && x.id === a), "a verify/revert pass ran before the request moved on");
    // unsupported safe restoration leaves it pending; a failed activation rolls back and is recorded
    applier.nextApply = [{ outcome: "unsupported", reason: "the agent holds a Suspend that cannot be restored" }];
    assert.equal((await w.call(w.owner, "maintenance.apply", { maintenanceId: a }, w.cid("ap"))).result.status, "approved");
    assert.match((await status(a)).pendingReason, /Suspend/);
    applier.nextApply = [{ outcome: "failed", reason: "validation failed after the restart", rollback: { rolledBackTo: 3 } }];
    assert.equal((await w.call(w.owner, "maintenance.apply", { maintenanceId: a }, w.cid("ap"))).result.status, "failed");
    const failed = await status(a);
    assert.deepEqual([failed.status, failed.failure.rollback.rolledBackTo], ["failed", 3]);
    assert.equal((await w.call(w.owner, "maintenance.apply", { maintenanceId: a }, w.cid("ap"))).result.status, "failed", "a failed change is not applied again");
    assert.equal(applier.calls.filter((x) => x.op === "apply" && x.id === a).length, 3);

    // two drivers at once: the claim is taken by one, the applier is called once
    const c1 = await ask("c");
    let release!: () => void;
    applier.gate = new Promise<void>((r) => { release = r; });
    const before = applier.calls.length;
    const pending = decide(c1);
    await until(c1, "applying");
    const second = await w.call(w.owner, "maintenance.apply", { maintenanceId: c1 }, w.cid("ap"));
    assert.equal(second.result.status, "applying", "the other driver leaves a held claim alone");
    release();
    assert.equal((await pending).result.status, "applied");
    applier.gate = undefined;
    assert.equal(applier.calls.length - before, 1, "applied once");

    // revoke while the application is running: it is reverted as soon as the application ends
    const e1 = await ask("e");
    release = () => undefined;
    applier.gate = new Promise<void>((r) => { release = r; });
    const pendingE = decide(e1);
    await until(e1, "applying");
    const rv = await w.call(w.owner, "maintenance.revoke", { maintenanceId: e1, reason: "changed my mind" }, w.cid("rv"));
    assert.equal(rv.result.status, "applying");
    release();
    await pendingE;
    applier.gate = undefined;
    assert.equal((await status(e1)).status, "revoked");
    assert.ok(applier.reverted.has(e1));

    // a revert that the applier cannot do yet stays "revoking" and is finished by the next resume
    const f1 = await ask("f");
    assert.equal((await decide(f1)).result.status, "applied");
    applier.nextRevert = [{ outcome: "unsupported", reason: "environment is suspended" }];
    assert.equal((await w.call(w.owner, "maintenance.revoke", { maintenanceId: f1, reason: "gone" }, w.cid("rv"))).result.status, "revoking");

    // a site denied after the approval and before the application: the denial wins, nothing is applied
    const net = await w.call(ann.token, "maintenance.request", { kind: "network", spec: { site: "late.example.com" }, reason: "x", rollbackPlan: "y" }, "late1");
    applier.nextApply = ["throw"];
    assert.equal((await decide(net.result.maintenanceId)).result.status, "approved");
    const applies = (): number => applier.calls.filter((x) => x.op === "apply").length;
    const applyCalls = applies();
    assert.ok((await w.call(w.owner, "maintenance.site.set", { site: "late.example.com", rule: "deny" }, w.cid("s"))).ok);
    await w.c.services.maintenance.idle();
    assert.equal((await status(net.result.maintenanceId)).status, "rejected");
    assert.equal((await w.call(w.owner, "maintenance.apply", { maintenanceId: net.result.maintenanceId }, w.cid("ap"))).result.status, "rejected");
    assert.equal(applies(), applyCalls, "the applier was not called to apply a denied site");

    // an approval lapses with the supervisor's standing: the owner switches supervisor decisions on, the supervisor approves while the applier is offline, the owner switches it off, nothing is applied and the request waits for a new decision
    const sup = await w.agent("Sue");
    const rep = await w.agent("Rae", sup.id);
    assert.ok((await w.call(w.owner, "maintenance.settings.enable", { what: "bosses" }, w.cid("c"))).ok);
    assert.ok((await w.call(w.owner, "maintenance.settings.set", { bossKinds: ["mount"] }, w.cid("c"))).ok);
    const lapse = await w.call(rep.token, "maintenance.request", { kind: "mount", spec: { mountPath: "/data/y", resource: `${rep.id}.y`, mode: "read" }, reason: "x", rollbackPlan: "y" }, "lapse1");
    const lid = lapse.result.maintenanceId as string;
    applier.nextApply = ["throw"];
    assert.equal((await w.call(sup.token, "maintenance.decide", { maintenanceId: lid, verdict: "approve", specDigest: (await status(lid)).specDigest }, w.cid("d"))).result.status, "approved");
    const lapseCalls = applies();
    assert.ok((await w.call(w.owner, "maintenance.settings.disable", { what: "bosses" }, w.cid("c"))).ok);
    await w.c.services.maintenance.idle();
    assert.equal((await status(lid)).status, "pending", "the approval no longer stands");
    assert.equal(applies(), lapseCalls);
    assert.equal((await w.call(w.owner, "maintenance.apply", { maintenanceId: lid }, w.cid("ap"))).result.status, "pending");

    // an approved change waiting for the applier, and one whose application was cut off by the end of the controller, are both finished by the next controller (the applier is keyed by request ID)
    const g1 = await ask("g");
    applier.nextApply = ["throw"];
    assert.equal((await decide(g1)).result.status, "approved");
    const h1 = await ask("h");
    applier.gate = new Promise<void>(() => undefined);
    void decide(h1);
    await until(h1, "applying");
    const ownerToken = w.owner;
    await w.c.close();
    applier.gate = undefined;
    w = await boot(d, applier, {}, ownerToken);
    await w.c.services.maintenance.idle();
    assert.equal((await status(g1)).status, "applied", "the waiting change is applied after the restart");
    assert.equal((await status(h1)).status, "applied", "the cut-off application is finished");
    assert.equal(applier.effects.size > 0, true);
    assert.equal((await status(f1)).status, "revoked", "the revert that had to wait is finished");
    assert.equal(applier.calls.filter((x) => x.op === "apply" && x.id === h1).length, 2, "the applier saw the cut-off request again, by the same ID");
  } catch (e) { throw e; } finally {
    await w.c.close().catch(() => undefined);
    rmSync(d, { recursive: true, force: true });
  }
});

test("the settings are the owner's alone, race-safe and replay-safe, and the chat shows widening first and applies narrowing at once; deciding by chat is bound to the request as it is (card A09)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-a09c-"));
  const say: Record<string, unknown[]> = {};
  const applier = new FakeApplier();
  const w = await boot(d, applier, say);
  const { c, call, cid } = w;
  try {
    const ann = await w.agent("Ann");
    const get = async () => (await call(w.owner, "maintenance.settings.get", {})).result.item;
    assert.deepEqual([(await get()).revision, (await get()).profile, (await get()).effective], [0, "strict", { requests: true, bosses: false, rules: true, bossKinds: [], leaseMs: 1_800_000, requestsPerDay: 200 }]);
    assert.equal((await call(ann.token, "maintenance.settings.get", {})).error?.code, "forbidden");
    for (const [op, args] of [["maintenance.settings.set", { rules: false }], ["maintenance.settings.enable", { what: "all" }], ["maintenance.settings.disable", { what: "all" }], ["maintenance.site.set", { site: "a.org", rule: "allow" }], ["maintenance.catalogue.add", { name: "x", version: "1", digest: D("a") }], ["maintenance.catalogue.remove", { name: "x", version: "1", digest: D("a") }], ["maintenance.apply", { maintenanceId: "mnt-x" }]] as const) {
      assert.equal((await call(ann.token, op, args as never, cid("o"))).error?.code, "forbidden", `${op}: owner only`);
    }
    for (const [i, bad] of ([{ requests: "yes" }, { sites: {} }, { sites: { "a.org": "maybe" } }, { catalogueAdd: [{ name: "x" }] }, {}, { expectedRevision: -1, rules: true }, { unknown: 1 }] as Record<string, unknown>[]).entries()) {
      assert.equal((await call(w.owner, "maintenance.settings.set", bad, `bad${i}`)).error?.code, "invalid_command", JSON.stringify(bad));
    }
    const set = await call(w.owner, "maintenance.settings.set", { rules: false, bosses: true, expectedRevision: 0 }, "s1");
    assert.ok(set.ok, JSON.stringify(set));
    assert.equal((await call(w.owner, "maintenance.settings.set", { rules: false, bosses: true, expectedRevision: 0 }, "s1")).result.revision, set.result.revision, "a replay is the same change");
    assert.equal((await call(w.owner, "maintenance.settings.set", { rules: true, expectedRevision: 0 }, "s2")).error?.code, "stale_revision");
    // two owner sessions racing on the same revision: exactly one wins
    const [r1, r2] = await Promise.all([call(w.owner, "maintenance.settings.set", { requests: false, expectedRevision: set.result.revision }, "s3"), call(w.owner, "maintenance.settings.set", { requests: true, expectedRevision: set.result.revision }, "s4")]);
    assert.deepEqual([r1.ok, r2.ok].sort(), [false, true]);
    assert.equal([r1, r2].find((r) => !r.ok)!.error!.code, "stale_revision");
    assert.ok((await call(w.owner, "maintenance.settings.set", { requests: null, bosses: null, rules: null }, "s5")).ok);
    assert.deepEqual((await get()).effective, { requests: true, bosses: false, rules: true, bossKinds: [], leaseMs: 1_800_000, requestsPerDay: 200 }, "null returns a field to the profile's default");
    // requests off: agents cannot ask, the owner still can for them
    assert.ok((await call(w.owner, "maintenance.settings.disable", { what: "requests" }, cid("c"))).ok);
    assert.equal((await call(ann.token, "maintenance.request", { kind: "skill", spec: { name: "s1", digest: D("1") }, reason: "x" }, "x1")).error?.code, "forbidden");
    assert.equal((await call(w.owner, "maintenance.request", { agentId: ann.principal, kind: "skill", spec: { name: "s1", digest: D("1") }, reason: "x" }, "x2")).result.status, "approved");
    assert.ok((await call(w.owner, "maintenance.settings.enable", { what: "requests" }, cid("c"))).ok);
    // an agent asks only for itself; the pending cap per agent
    const ben = await w.agent("Ben");
    assert.equal((await call(ann.token, "maintenance.request", { agentId: ben.principal, kind: "skill", spec: { name: "s1", digest: D("1") }, reason: "x" }, "x3")).error?.code, "forbidden");
    assert.equal((await call(ann.token, "maintenance.request", { agentId: "agent:agt-nobody", kind: "skill", spec: { name: "s1", digest: D("1") }, reason: "x" }, "x4")).error?.code, "forbidden");
    for (const [i, spec] of ([{ name: "../x", version: "1", digest: D("a"), source: "x", installScripts: false }, { name: "x", version: "1", digest: "abc", source: "x", installScripts: false }, { name: "x", version: "1", digest: D("a"), source: "x" }, { name: "x", version: "1", digest: D("a"), source: "x", installScripts: false, command: "rm -rf /" }, { name: "x", version: "1", digest: D("a"), source: "file:///etc/passwd", installScripts: false }] as Record<string, unknown>[]).entries()) {
      assert.equal((await call(ann.token, "maintenance.request", { kind: "package", spec, reason: "x", rollbackPlan: "y" }, `v${i}`)).error?.code, "invalid_command", JSON.stringify(spec));
    }
    assert.equal((await call(ann.token, "maintenance.request", { kind: "mount", spec: { mountPath: "/data/../etc", resource: "r", mode: "write" }, reason: "x", rollbackPlan: "y" }, "v9")).error?.code, "invalid_command");
    assert.equal((await call(ann.token, "maintenance.request", { kind: "package", spec: pkg("nopan"), reason: "x" }, "v10")).error?.code, "invalid_command", "a rollback plan is required");
    for (let i = 0; i < MAINTENANCE_LIMITS.pendingPerAgent; i++) assert.ok((await call(ann.token, "maintenance.request", { kind: "package", spec: pkg(`cap-${i}`), reason: "x", rollbackPlan: "y" }, `cap${i}`)).ok);
    assert.equal((await call(ann.token, "maintenance.request", { kind: "package", spec: pkg("cap-over"), reason: "x", rollbackPlan: "y" }, "capover")).error?.code, "invalid_command", "at most 20 wait");
    // a decision frees a place as a withdrawal does
    const waiting = (await call(w.owner, "maintenance.list", { agentId: ann.principal, status: "pending", limit: 1 })).result.items[0];
    assert.ok((await call(w.owner, "maintenance.decide", { maintenanceId: waiting.id, verdict: "reject", specDigest: waiting.specDigest }, cid("d"))).ok);
    assert.ok((await call(ann.token, "maintenance.request", { kind: "package", spec: pkg("cap-after-decide"), reason: "x", rollbackPlan: "y" }, "capdec")).ok, "a decision frees a place");
    assert.equal((await call(ann.token, "maintenance.request", { kind: "package", spec: pkg("cap-full-again"), reason: "x", rollbackPlan: "y" }, "capfull")).error?.code, "invalid_command");
    const one = (await call(ann.token, "maintenance.list", { status: "pending", limit: 5 })).result;
    assert.equal(one.items.length, 5);
    assert.ok(one.next !== undefined);
    assert.equal((await call(ann.token, "maintenance.revoke", { maintenanceId: one.items[0].id, reason: "withdraw" }, cid("w"))).result.status, "revoked" in {} ? "x" : "withdrawn", "the requester withdraws its own waiting request");
    assert.ok((await call(ann.token, "maintenance.request", { kind: "package", spec: pkg("cap-over"), reason: "x", rollbackPlan: "y" }, "capover2")).ok, "a withdrawal frees a place");

    // ---- chat
    const turn = async (id: string, text: string, intents: unknown[]) => { say[text] = intents; return (await c.chat!.submit(w.owner, { messageId: id, text })).outcomes; };
    const e1 = "turn on supervisor decisions for environment changes";
    const shown = await turn("m1", e1, [{ kind: "command", op: "maintenance.settings.enable", args: { what: "bosses" }, evidence: e1, basis: "owner" }]);
    assert.equal(shown[0]!.status, "proposed", "widening is shown first");
    assert.equal((await get()).effective.bosses, false);
    assert.equal((await turn("m2", "yes, do that", [{ kind: "apply_proposal", proposalId: shown[0]!.proposalId, evidence: "do that", basis: "owner" }]))[0]!.status, "applied");
    assert.equal((await get()).effective.bosses, true);
    const e2 = "turn off supervisor decisions for environment changes";
    assert.equal((await turn("m3", e2, [{ kind: "command", op: "maintenance.settings.disable", args: { what: "bosses" }, evidence: e2, basis: "owner" }]))[0]!.status, "applied", "narrowing applies at once");
    assert.equal((await get()).effective.bosses, false);
    // a site: allow is shown first, deny applies at once only when the owner's words say deny and name the site
    const a1 = "allow pypi.org for environment changes";
    const allowShown = await turn("m4", a1, [{ kind: "command", op: "maintenance.site.set", args: { site: "pypi.org", rule: "allow" }, evidence: a1, basis: "owner" }]);
    assert.equal(allowShown[0]!.status, "proposed");
    assert.equal((await get()).set.sites, undefined);
    const wrong = "look at pypi.org";
    assert.equal((await turn("m5", wrong, [{ kind: "command", op: "maintenance.site.set", args: { site: "pypi.org", rule: "deny" }, evidence: wrong, basis: "owner" }]))[0]!.status, "proposed", "a deny the words do not say is shown first");
    const dn = "block evil.example.com for environment changes";
    { const o = (await turn("m6", dn, [{ kind: "command", op: "maintenance.site.set", args: { site: "evil.example.com", rule: "deny" }, evidence: dn, basis: "owner" }]))[0]!; assert.equal(o.status, "applied", JSON.stringify(o)); }
    assert.equal((await get()).set.sites["evil.example.com"], "deny");
    const invented = "block example.org for environment changes";
    assert.equal((await turn("m7", invented, [{ kind: "command", op: "maintenance.site.set", args: { site: "evil.example.com", rule: "deny" }, evidence: invented, basis: "owner" }]))[0]!.status, "refused", "a site that is not in the words is refused");
    // a package preapproval is shown first; removing one applies at once
    const cat = `preapprove tool-z version 1.0 digest ${D("c")}`;
    assert.equal((await turn("m8", cat, [{ kind: "command", op: "maintenance.catalogue.add", args: { name: "tool-z", version: "1.0", digest: D("c") }, evidence: cat, basis: "owner" }]))[0]!.status, "proposed");
    // deciding a request by chat: shown first, bound to the digest and revision read from the record, the ID must be the owner's word
    const req = await call(ben.token, "maintenance.request", { kind: "mount", spec: { mountPath: "/data/x", resource: "x", mode: "write" }, reason: "x", rollbackPlan: "y" }, "chatreq");
    const mid = req.result.maintenanceId as string;
    const item = (await call(w.owner, "maintenance.get", { maintenanceId: mid })).result.item;
    const dw = `approve ${mid}`;
    const forged = await turn("m9", dw, [{ kind: "command", op: "maintenance.decide", args: { maintenanceId: mid, verdict: "approve", specDigest: D("e") }, evidence: dw, basis: "owner" }]);
    assert.equal(forged[0]!.status, "proposed");
    assert.equal((await call(w.owner, "maintenance.get", { maintenanceId: mid })).result.item.status, "pending");
    assert.match(JSON.stringify(forged[0]), /asks: mount/, "the owner sees the request");
    { const o = (await turn("m10", "yes, go ahead", [{ kind: "apply_proposal", proposalId: forged[0]!.proposalId, evidence: "go ahead", basis: "owner" }]))[0]!; assert.equal(o.status, "applied", JSON.stringify(o)); }
    const after = (await call(w.owner, "maintenance.get", { maintenanceId: mid })).result.item;
    assert.deepEqual([after.status, after.decision.specDigest], ["applied", item.specDigest], "the decision is for the digest of the record, not the one the interpreter wrote");
    const other = "approve it";
    assert.equal((await turn("m11", other, [{ kind: "command", op: "maintenance.decide", args: { maintenanceId: "mnt-guess", verdict: "approve" }, evidence: other, basis: "owner" }]))[0]!.status, "refused", "an ID not in the words is refused");
    // the preview of a package always shows the source, the short digest and the install scripts, however long the name and the reason are
    const long = await call(ben.token, "maintenance.request", { kind: "package", spec: pkg("tool-with-a-quite-long-name-for-the-preview", { installScripts: true, source: `https://registry.example.org/${"p".repeat(120)}/pkg`, version: "9.9.9" }), reason: "r".repeat(400), rollbackPlan: "y".repeat(400) }, "chatlong");
    const lid = long.result.maintenanceId as string;
    const lw = `approve ${lid}`;
    const lshown = await turn("m9b", lw, [{ kind: "command", op: "maintenance.decide", args: { maintenanceId: lid, verdict: "approve" }, evidence: lw, basis: "owner" }]);
    const lt = JSON.stringify(lshown[0]);
    assert.match(lt, /source=https:\/\/registry\.example\.org\/p{20}/, "the source is shown");
    assert.match(lt, /installScripts=true/);
    assert.match(lt, /digest=sha256:aaaaaaaa/);
    assert.match(lt, /version=9\.9\.9/);
    // revoking by chat needs the owner's verb and the ID
    const rw = `revoke ${mid}, not needed any more`;
    { const o = (await turn("m12", rw, [{ kind: "command", op: "maintenance.revoke", args: { maintenanceId: mid, reason: "not needed any more" }, evidence: rw, basis: "owner" }]))[0]!; assert.equal(o.status, "applied", JSON.stringify(o)); }
    assert.equal((await call(w.owner, "maintenance.get", { maintenanceId: mid })).result.item.status, "revoked");
  } finally {
    await c.close();
    rmSync(d, { recursive: true, force: true });
  }
});
