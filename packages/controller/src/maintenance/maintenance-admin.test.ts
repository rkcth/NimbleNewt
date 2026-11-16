import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { AgentService } from "../agents/index.js";
import { GrantService, PrincipalService, type Principal } from "../security/index.js";
import { scopedCommandId } from "../security/credentials.js";
import { FakeApplier, MaintenanceService, type ArtifactInspection, type MaintenanceBody, type MaintenanceOptions } from "./index.js";

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
  service(extra?: { heartbeatMs?: number; applyTimeoutMs?: number; held?: (agentId: string) => Promise<boolean>; inspector?: NonNullable<MaintenanceOptions["inspector"]>; inspectTimeoutMs?: number; inspectQueue?: number }): MaintenanceService;
  make(name: string, by?: Principal, supervisorId?: string): Promise<{ id: string; principal: Principal }>;
  body(id: string): Promise<MaintenanceBody & { revision: number }>;
  until(id: string, want: string): Promise<void>;
  storage: import("../storage/types.js").ControllerStorage;
  /** A service on another view of the same storage (to step into the middle of a command). */
  serviceOn(storage: import("../storage/types.js").ControllerStorage): MaintenanceService;
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
    const service = (extra: { heartbeatMs?: number; applyTimeoutMs?: number; held?: (agentId: string) => Promise<boolean>; inspector?: NonNullable<MaintenanceOptions["inspector"]>; inspectTimeoutMs?: number; inspectQueue?: number } = {}) => MaintenanceService.withEpoch(open.storage, projects.epoch, { applier, heartbeatMs, ...extra }, options);
    const m = service();
    const make: World["make"] = async (friendlyName, by = owner, supervisorId) => {
      const created = await agents.create(by, { commandId: cid("a"), friendlyName, ...(supervisorId === undefined ? {} : { supervisorId }) });
      return { id: created.id, principal: await principals.authenticate((await principals.issueCredential(owner, `agent:${created.id}`)).token) };
    };
    const getBody = async (id: string) => { const a = (await open.storage.getAggregate({ kind: "maintenance", id }))!; return { ...(a.body as unknown as MaintenanceBody), revision: a.revision }; };
    const until = async (id: string, want: string): Promise<void> => { for (let i = 0; i < 200 && (await getBody(id)).status !== want; i++) await sleep(10); assert.equal((await getBody(id)).status, want); };
    const serviceOn = (storage: import("../storage/types.js").ControllerStorage) => MaintenanceService.withEpoch(storage, projects.epoch, { applier, heartbeatMs }, options);
    await body({ m, applier, owner, agents, grants, principals, time, service, make, body: getBody, until, storage: open.storage, serviceOn });
    await m.idle();
  } finally { await open.close(); }
}
const settle = async (w: World): Promise<void> => { await w.m.idle(); };
const request = (w: World, p: Principal, kind: string, spec: unknown, label = cid("r")) => w.m.request(p, { commandId: label, kind, spec, reason: "needed", rollbackPlan: "undo it" });
const refuses = async (code: string, run: () => Promise<unknown>): Promise<void> => { await assert.rejects(run, (e: unknown) => { assert.ok(e instanceof DomainError, String(e)); assert.equal(e.code, code, (e as Error).message); return true; }); };
const specOf = (w: World, id: string) => w.body(id).then((b) => b.specDigest);
const approve = async (w: World, id: string) => w.m.decide(w.owner, { commandId: cid("d"), maintenanceId: id, verdict: "approve", specDigest: await specOf(w, id) });

// ---- A09 follow-up: an administrator for host policy and the base, and a review that is down while the approved environment works (2026-11-15) ----

const asAdmin = (w: World, id: string) => w.m.change(w.owner, { commandId: cid("adm"), administrators: [id] });
const decideBy = async (w: World, by: Principal, id: string, verdict: "approve" | "reject" = "approve", m: MaintenanceService = w.m) => m.decide(by, { commandId: cid("d"), maintenanceId: id, verdict, specDigest: await specOf(w, id) });
const plant = async (w: World, agentId: string, patch: Record<string, unknown>): Promise<void> => {
  const rec = (await w.storage.getAggregate({ kind: "agent", id: agentId }))!;
  await w.storage.applyOperation({ operationId: cid("plant"), epoch: await w.storage.currentEpoch(), actor: "owner:test", correlationId: cid("co"), at: "2026-10-31T10:00:00.000Z", changes: [{ type: "update", ref: { kind: "agent", id: agentId }, expectedRevision: rec.revision, body: { ...(rec.body as Record<string, unknown>), ...patch } as never }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeTimers: [], settleEffects: [], completeDeliveries: [] } as never);
};
const PROTECTED = [["base", { change: "use the newer shared interpreter" }], ["host-policy", { setting: "worker-limits", change: "raise the memory limit" }]] as const;

for (const [index, backend] of backends.entries()) {
  test(`an administrator the owner named decides host policy and the shared base and nothing else; a supervisor role alone still cannot (${backend.name})`, async () => {
    await world(index, async (w) => {
      const ann = await w.make("Ann");
      const boss = await w.make("Boss");
      const bob = await w.make("Bob", w.owner, boss.id);
      const adm = await w.make("Admin");
      await w.m.toggle(w.owner, { commandId: cid("t"), what: "bosses", enabled: true });
      await w.m.change(w.owner, { commandId: cid("s"), bossKinds: ["package", "extension", "mount", "network"] });
      for (const [kind, spec] of PROTECTED) {
        // Before anyone is named: an agent that is not the requester's supervisor reads nothing, and the requester's supervisor (everything handed over) still cannot decide.
        const mine = await request(w, bob.principal, kind, spec);
        assert.equal(mine.status, "pending", kind);
        await refuses("not_found", () => decideBy(w, adm.principal, mine.maintenanceId));
        await refuses("forbidden", () => decideBy(w, boss.principal, mine.maintenanceId));
        // The owner names the administrator (in the form the chat's IDs are written, with or without the prefix).
        await asAdmin(w, adm.id);
        assert.deepEqual((await w.m.settings(w.owner)).effective.administrators, [adm.principal.id]);
        assert.equal((await w.m.get(adm.principal, mine.maintenanceId)).status, "pending", "an administrator reads protected requests");
        assert.ok((await w.m.list(adm.principal, { status: "pending" })).items.some((i) => i["id"] === mine.maintenanceId));
        // The supervisor role gains nothing from it.
        await refuses("forbidden", () => decideBy(w, boss.principal, mine.maintenanceId));
        assert.equal(w.applier.calls.filter((c) => c.id === mine.maintenanceId).length, 0, "nothing applied yet");
        const done = await decideBy(w, adm.principal, mine.maintenanceId);
        assert.equal(done.status, "applied");
        assert.equal((await w.body(mine.maintenanceId)).decision?.via, "administrator");
        assert.equal((await w.body(mine.maintenanceId)).decision?.by, adm.principal.id);
        await w.m.change(w.owner, { commandId: cid("adm"), administrators: null });
        assert.deepEqual((await w.m.settings(w.owner)).effective.administrators, []);
      }
      // An administrator decides nothing but the protected kinds: it does not even read the others, and cannot decide them.
      await asAdmin(w, adm.id);
      const other = await request(w, ann.principal, "network", { site: "docs.example.net" });
      assert.equal(other.status, "pending");
      await refuses("not_found", () => decideBy(w, adm.principal, other.maintenanceId));
      assert.ok(!(await w.m.list(adm.principal, {})).items.some((i) => i["id"] === other.maintenanceId));
      assert.equal((await w.body(other.maintenanceId)).status, "pending");
    });
  });

  test(`an administrator is not the requester's own hand, not held, not on a task credential and not an agent that is gone; the owner's word is needed to name one (${backend.name})`, async () => {
    const held = new Set<string>(); let broken = false;
    await world(index, async (w) => {
      const m = w.service({ held: async (id) => { if (broken) throw new Error("the gates cannot be read"); return held.has(id); } });
      const ann = await w.make("Ann");
      const adm = await w.make("Admin");
      const owned = await w.make("Owned");
      await m.change(w.owner, { commandId: cid("adm"), administrators: [adm.id, owned.id] });
      const ask = async (by: Principal = ann.principal) => (await m.request(by, { commandId: cid("r"), kind: "base", spec: { change: `change ${cid("x")}` }, reason: "needed", rollbackPlan: "undo it" })).maintenanceId;
      // The requester that is itself an administrator does not decide its own request, and an administrator does not decide for the agent it was created by.
      const own = await ask(adm.principal);
      await refuses("forbidden", () => decideBy(w, adm.principal, own, "approve", m));
      await plant(w, owned.id, { createdBy: ann.principal.id });
      const one = await ask();
      await refuses("forbidden", () => decideBy(w, owned.principal, one, "approve", m));
      // Someone the requester controls made it: also the requester's hand.
      const mid = await w.make("Mid", w.owner, ann.id);
      await plant(w, adm.id, { createdBy: mid.principal.id });
      await refuses("forbidden", () => decideBy(w, adm.principal, one, "approve", m));
      await plant(w, adm.id, { createdBy: "owner:rob" });
      // A task credential never decides; a held administrator does not; a gate that cannot be read counts as held.
      const onTask = { ...adm.principal, taskScope: { taskId: "tsk-anything", projectId: "prj-anything" } } as Principal;
      await refuses("not_found", () => decideBy(w, onTask, one, "approve", m));
      held.add(adm.principal.id.slice("agent:".length));
      await refuses("forbidden", () => decideBy(w, adm.principal, one, "approve", m));
      held.clear(); broken = true;
      await refuses("forbidden", () => decideBy(w, adm.principal, one, "approve", m));
      broken = false;
      assert.equal((await w.body(one)).status, "pending");
      assert.equal(w.applier.calls.length, 0);
      // An agent that is not active does not decide.
      await plant(w, adm.id, { state: "disabled" });
      await refuses("forbidden", () => decideBy(w, adm.principal, one, "approve", m));
      await plant(w, adm.id, { state: "active" });
      assert.equal((await decideBy(w, adm.principal, one, "approve", m)).status, "applied");
      // Naming is the owner's alone, bounded, and made of agent IDs.
      await refuses("forbidden", () => m.change(adm.principal, { commandId: cid("adm"), administrators: [adm.id] }));
      await refuses("forbidden", () => m.change(ann.principal, { commandId: cid("adm"), administrators: [ann.id] }));
      await refuses("invalid_command", () => m.change(w.owner, { commandId: cid("adm"), administrators: ["not an id"] }));
      await refuses("invalid_command", () => m.change(w.owner, { commandId: cid("adm"), administrators: "agent:agt-x" }));
      await refuses("invalid_command", () => m.change(w.owner, { commandId: cid("adm"), administrators: ["a1", "a2", "a3", "a4", "a5", "a6"] }));
      await m.change(w.owner, { commandId: cid("adm"), administrators: [adm.id, `agent:${adm.id}`] });
      assert.deepEqual((await m.settings(w.owner)).effective.administrators, [adm.principal.id], "a repeat collapses");
      await m.change(w.owner, { commandId: cid("adm"), administrators: [] });
      assert.deepEqual((await m.settings(w.owner)).effective.administrators, []);
    });
  });

  test(`an administrator's approval is judged again when the application starts (the owner took the role back, or it is held), and an administrator may revoke only a protected change (${backend.name})`, async () => {
    const held = new Set<string>();
    await world(index, async (w) => {
      const m = w.service({ held: async (id) => held.has(id) });
      const ann = await w.make("Ann");
      const adm = await w.make("Admin");
      await m.change(w.owner, { commandId: cid("adm"), administrators: [adm.id] });
      const ask = async (kind: string, spec: unknown) => (await m.request(ann.principal, { commandId: cid("r"), kind, spec, reason: "needed", rollbackPlan: "undo it" })).maintenanceId;
      // Approved while named, but the host cannot take it yet; the role is taken back before the next try: it goes back to waiting and is never applied.
      const one = await ask("base", { change: "first change" });
      w.applier.nextApply.push({ outcome: "unsupported", reason: "the host cannot take it now" });
      assert.equal((await decideBy(w, adm.principal, one, "approve", m)).status, "approved");
      const asked = w.applier.calls.filter((c) => c.id === one).length;
      await m.change(w.owner, { commandId: cid("adm"), administrators: null });
      for (let i = 0; i < 2; i++) { await m.tick(); await m.resume(); }
      await m.idle();
      assert.equal((await w.body(one)).status, "pending");
      assert.equal(w.applier.calls.filter((c) => c.id === one).length, asked, "the applier was not asked again");
      // Named again and free: it is decided again and applied once.
      await m.change(w.owner, { commandId: cid("adm"), administrators: [adm.id] });
      assert.equal((await decideBy(w, adm.principal, one, "approve", m)).status, "applied");
      // The same with a held administrator.
      const two = await ask("host-policy", { setting: "worker-limits", change: "second" });
      w.applier.nextApply.push({ outcome: "unsupported", reason: "the host cannot take it now" });
      assert.equal((await decideBy(w, adm.principal, two, "approve", m)).status, "approved");
      held.add(adm.principal.id.slice("agent:".length));
      for (let i = 0; i < 2; i++) { await m.tick(); await m.resume(); }
      await m.idle();
      assert.equal((await w.body(two)).status, "pending");
      held.clear();
      // An administrator takes back a protected change, and only that kind.
      const reverted = await m.revoke(adm.principal, { commandId: cid("v"), maintenanceId: one, reason: "no longer wanted" });
      assert.equal(reverted.status, "revoked");
      const pk = await ask("package", { name: "other-pkg", version: "1.0.0", digest: D("c"), source: SRC, installScripts: false });
      await refuses("not_found", () => m.revoke(adm.principal, { commandId: cid("v"), maintenanceId: pk, reason: "x" }));
      assert.equal((await w.body(pk)).status, "pending");
    });
  });

  test(`an administrator does not decide for its own team: not for an agent it supervises directly or further up, not for one above it, not for one made by an agent it made; a peer it may decide for, and a team formed after the approval stops it at the claim (${backend.name})`, async () => {
    await world(index, async (w) => {
      const adm = await w.make("Admin");
      await w.m.change(w.owner, { commandId: cid("adm"), administrators: [adm.id] });
      const ask = async (p: Principal) => (await request(w, p, "base", { change: `change ${cid("x")}` })).maintenanceId;
      // The administrator is the requester's supervisor, or its supervisor's supervisor.
      const direct = await w.make("Direct", w.owner, adm.id);
      { const id = await ask(direct.principal); await refuses("forbidden", () => decideBy(w, adm.principal, id)); }
      const under = await w.make("Under", w.owner, direct.id);
      { const id = await ask(under.principal); await refuses("forbidden", () => decideBy(w, adm.principal, id)); }
      // The requester is the administrator's supervisor.
      const lead = await w.make("Lead");
      await plant(w, adm.id, { supervisorId: lead.id });
      { const id = await ask(lead.principal); await refuses("forbidden", () => decideBy(w, adm.principal, id)); }
      // The requester was made by an agent the administrator made.
      const made = await w.make("Made"); await plant(w, made.id, { createdBy: adm.principal.id });
      const grand = await w.make("Grand"); await plant(w, grand.id, { createdBy: made.principal.id });
      { const id = await ask(grand.principal); await refuses("forbidden", () => decideBy(w, adm.principal, id)); }
      // A peer under the same supervisor is not its team in this sense: it decides.
      const boss = await w.make("Boss");
      await plant(w, adm.id, { supervisorId: boss.id });
      const peer = await w.make("Peer", w.owner, boss.id);
      const ok = await ask(peer.principal);
      assert.equal((await decideBy(w, adm.principal, ok)).status, "applied");
      // Approved while unrelated, then the administrator is made the requester's supervisor before the host takes it: back to waiting, never applied.
      const later = await w.make("Later");
      const one = await ask(later.principal);
      w.applier.nextApply.push({ outcome: "unsupported", reason: "the host cannot take it now" });
      assert.equal((await decideBy(w, adm.principal, one)).status, "approved");
      const asked = w.applier.calls.filter((c) => c.id === one).length;
      await plant(w, later.id, { supervisorId: adm.id });
      for (let i = 0; i < 2; i++) { await w.m.tick(); await w.m.resume(); }
      await w.m.idle();
      assert.equal((await w.body(one)).status, "pending");
      assert.equal(w.applier.calls.filter((c) => c.id === one).length, asked, "the applier was not asked again");
    });
  });

  test(`a review service that is down leaves every change pending while the approved environment keeps working; when it returns it decides each once, and a repeat of its decision applies nothing twice (${backend.name})`, async () => {
    // The in-process review service: it reads what waits as its supervisor principal and decides. Its outage is a stop, a crash between reading and deciding, a pause gate that holds it, and a gate that cannot be read.
    const held = new Set<string>(); let gateBroken = false;
    await world(index, async (w) => {
      const m = w.service({ held: async (id) => { if (gateBroken) throw new Error("gates unreadable"); return held.has(id); } });
      const boss = await w.make("Reviewer");
      const ann = await w.make("Ann", w.owner, boss.id);
      await m.toggle(w.owner, { commandId: cid("t"), what: "bosses", enabled: true });
      await m.change(w.owner, { commandId: cid("s"), bossKinds: ["package", "network"] });
      const review = {
        up: true, crashBetween: false, decided: [] as string[],
        async pass(): Promise<number> {
          if (!this.up) return 0;
          let n = 0;
          for (const item of (await m.list(boss.principal, { status: "pending" })).items) {
            const id = String(item["id"]);
            if (this.crashBetween) throw new Error("the review service crashed after reading the request");
            await m.decide(boss.principal, { commandId: `review:${id}`, maintenanceId: id, verdict: "approve", specDigest: String(item["specDigest"]) });
            this.decided.push(id); n++;
          }
          return n;
        },
      };
      const ask = async (name: string) => (await m.request(ann.principal, { commandId: cid("r"), kind: "package", spec: pkg(name, { digest: D("d") }), reason: "needed", rollbackPlan: "undo it" })).maintenanceId;
      // The approved environment: a site the owner approved earlier is in force.
      const site = (await m.request(w.owner, { commandId: cid("r"), agentId: ann.id, kind: "network", spec: { site: "docs.example.net" }, reason: "docs", rollbackPlan: "remove it" })).maintenanceId;
      await m.idle();
      if ((await w.body(site)).status === "pending") await decideBy(w, w.owner, site, "approve", m);
      await m.idle();
      assert.equal((await w.body(site)).status, "applied");
      const inForce = (): string[] => w.applier.calls.filter((c) => c.kind === "network" && c.op === "apply" && c.id === site).map((c) => c.id);
      const applied = inForce().length;
      const first = await ask("waits-1"), second = await ask("waits-2");
      // 1. The service is stopped: many passes of the controller's own loops change nothing.
      review.up = false;
      assert.equal(await review.pass(), 0);
      for (let i = 0; i < 3; i++) { await m.tick(); await m.enforce(); await m.resume(); }
      await m.idle();
      for (const id of [first, second]) assert.equal((await w.body(id)).status, "pending");
      assert.equal(w.applier.calls.filter((c) => c.id === first || c.id === second).length, 0, "the applier was never asked");
      // 2. It crashes after reading: nothing is half decided.
      review.up = true; review.crashBetween = true;
      await assert.rejects(() => review.pass(), /crashed/);
      for (const id of [first, second]) assert.equal((await w.body(id)).status, "pending");
      review.crashBetween = false;
      // 3. It is held by a pause gate, then the gate cannot be read: its decisions are refused, and nothing changes.
      held.add(boss.id);
      await assert.rejects(() => review.pass(), (e: unknown) => e instanceof DomainError && e.code === "forbidden");
      held.clear(); gateBroken = true;
      await assert.rejects(() => review.pass(), (e: unknown) => e instanceof DomainError && e.code === "forbidden");
      gateBroken = false;
      for (const id of [first, second]) assert.equal((await w.body(id)).status, "pending");
      // Through all of it the approved environment kept working: its request is applied, was not reverted or applied again, and the site stays judged as allowed.
      assert.equal((await w.body(site)).status, "applied");
      assert.equal(inForce().length, applied);
      assert.equal(w.applier.calls.filter((c) => c.op === "revert").length, 0);
      assert.equal(await m.siteDenied("docs.example.net", 443), false);
      // 4. The service returns: each request is decided once and applied once; a restarted service repeating its decisions (the same command IDs) applies nothing twice.
      assert.equal(await review.pass(), 2);
      await m.idle();
      for (const id of [first, second]) { assert.equal((await w.body(id)).status, "applied"); assert.equal(w.applier.calls.filter((c) => c.id === id && c.op === "apply").length, 1); }
      for (const id of [first, second]) await m.decide(boss.principal, { commandId: `review:${id}`, maintenanceId: id, verdict: "approve", specDigest: await specOf(w, id) });
      await m.idle();
      for (const id of [first, second]) assert.equal(w.applier.calls.filter((c) => c.id === id && c.op === "apply").length, 1, "a repeated decision applies nothing again");
    });
  });
}
