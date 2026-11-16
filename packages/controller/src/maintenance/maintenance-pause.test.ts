import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AgentService } from "../agents/index.js";
import { DomainError } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PauseService } from "../lifecycle/index.js";
import { NotificationService } from "../notifications/index.js";
import { PrincipalService, type Principal } from "../security/index.js";
import type { ControllerStorage } from "../storage/types.js";
import { FakeApplier, MaintenanceService, type MaintenanceBody, type MaintenanceNotice, type MaintenanceOptions } from "./index.js";

after(stopServer);

// A09 follow-up T6b: a pause placed on the one who decides, and the decision, are put in one order (exactly one of them goes first), and the notice for an administrator is anchored in a project.

const D = (c: string): string => `sha256:${c.repeat(64)}`;
const pkg = (name: string) => ({ name, version: "1.2.3", digest: D("a"), source: "https://registry.example.org/pkg", installScripts: false });
let n = 0;
const cid = (l: string): string => `${l}-${n++}`;

interface World {
  readonly owner: Principal; readonly agents: AgentService; readonly storage: ControllerStorage; readonly applier: FakeApplier; readonly pauses: PauseService; readonly m: MaintenanceService;
  /** A service on another view of the same storage, with the pause fence on that same view (so a read through a spying view is seen by it). */
  on(storage: ControllerStorage, extra?: Partial<MaintenanceOptions>): MaintenanceService;
  make(name: string, supervisorId?: string): Promise<{ id: string; principal: Principal }>;
  body(id: string): Promise<MaintenanceBody & { revision: number }>;
  pause(agentId: string): Promise<void>;
  resume(agentId: string): Promise<void>;
  gate(agentId: string): Promise<{ intent: string | undefined; revision: number } | undefined>;
}
async function world(index: number, run: (w: World) => Promise<void>): Promise<void> {
  const open = await backends[index]!.open();
  try {
    const time = { ms: Date.parse("2026-11-16T10:00:00.000Z") };
    const options = { clock: () => new Date(time.ms).toISOString(), pause: async () => undefined };
    const projects = await ProjectService.open(open.storage, { holder: "c1", ...options });
    const epoch = projects.epoch;
    const principals = PrincipalService.withEpoch(open.storage, epoch, options);
    const agents = AgentService.withEpoch(open.storage, epoch, options);
    const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
    const applier = new FakeApplier();
    const pausesOn = (storage: ControllerStorage) => PauseService.withEpoch(storage, epoch, {}, options);
    const pauses = pausesOn(open.storage);
    const on: World["on"] = (storage, extra = {}) => MaintenanceService.withEpoch(storage, epoch, { applier, heartbeatMs: 0, fence: (id) => pausesOn(storage).agentFence(id), ...extra }, options);
    const m = on(open.storage);
    await run({
      owner, agents, storage: open.storage, applier, pauses, m, on,
      make: async (friendlyName, supervisorId) => {
        const created = await agents.create(owner, { commandId: cid("a"), friendlyName, ...(supervisorId === undefined ? {} : { supervisorId }) });
        return { id: created.id, principal: await principals.authenticate((await principals.issueCredential(owner, `agent:${created.id}`)).token) };
      },
      body: async (id) => { const a = (await open.storage.getAggregate({ kind: "maintenance", id }))!; return { ...(a.body as unknown as MaintenanceBody), revision: a.revision }; },
      pause: async (agentId) => { await pauses.pause(owner, { commandId: cid("pz"), scope: { kind: "agent", id: agentId }, reason: "hold" }); },
      resume: async (agentId) => { await pauses.resume(owner, { commandId: cid("rs"), scope: { kind: "agent", id: agentId }, reason: "go on" }); },
      gate: async (agentId) => { const g = await open.storage.getAggregate({ kind: "pause-gate", id: PauseService.gateIdOf({ kind: "agent", id: agentId }) }); return g === undefined ? undefined : { intent: (g.body as { intent?: string }).intent, revision: g.revision }; },
    });
    await m.idle();
  } finally { await open.close(); }
}

/** A view of the storage that runs `act` once, right after the first read of the record `kind`/`id`: what a write that lands between the check and the commit looks like. */
const afterRead = (storage: ControllerStorage, kind: string, id: string, act: () => Promise<void>): { view: ControllerStorage; fired: () => boolean } => {
  let done = false;
  const view = new Proxy(storage, { get: (t, k) => k === "getAggregate" ? async (ref: { kind: string; id: string }) => {
    const found = await t.getAggregate(ref as never);
    if (!done && ref.kind === kind && ref.id === id) { done = true; await act(); }
    return found;
  } : (typeof (t as never)[k] === "function" ? ((t as never)[k] as (...a: unknown[]) => unknown).bind(t) : (t as never)[k]) });
  return { view: view as ControllerStorage, fired: () => done };
};
const refuses = async (code: string, run: () => Promise<unknown>, text?: RegExp): Promise<void> => { await assert.rejects(run, (e: unknown) => { assert.ok(e instanceof DomainError, String(e)); assert.equal(e.code, code, (e as Error).message); if (text !== undefined) assert.match(e.message, text); return true; }); };
const gateId = (agentId: string): string => PauseService.gateIdOf({ kind: "agent", id: agentId });
const ask = (w: World, p: Principal, kind: string, spec: unknown) => w.m.request(p, { commandId: cid("r"), kind, spec, reason: "needed", rollbackPlan: "undo it" });
const decide = async (w: World, m: MaintenanceService, by: Principal, id: string, verdict: "approve" | "reject" = "approve") => m.decide(by, { commandId: cid("d"), maintenanceId: id, verdict, specDigest: (await w.body(id)).specDigest });

for (const [index, backend] of backends.entries()) {
  for (const existing of [false, true]) {
    test(`a pause that lands while an administrator's decision is being written goes first: the decision is refused with a plain answer, the request keeps waiting and the pause stands (${existing ? "the gate already existed" : "no gate existed yet"}, ${backend.name})`, async () => {
      await world(index, async (w) => {
        const adm = await w.make("Admin");
        const ann = await w.make("Ann");
        await w.m.change(w.owner, { commandId: cid("adm"), administrators: [adm.id] });
        if (existing) { await w.pause(adm.id); await w.resume(adm.id); }
        assert.equal((await w.gate(adm.id)) !== undefined, existing);
        const id = (await ask(w, ann.principal, "base", { change: "newer interpreter" })).maintenanceId;
        const race = afterRead(w.storage, "pause-gate", gateId(adm.id), async () => { await w.pause(adm.id); });
        await refuses("forbidden", () => decide(w, w.on(race.view), adm.principal, id), /paused at the same moment.*decision was not recorded.*request is unchanged.*one order/s);
        assert.equal(race.fired(), true, "the pause was placed in the window");
        assert.equal((await w.body(id)).status, "pending");
        assert.equal((await w.gate(adm.id))?.intent, "pause", "the pause stands");
        assert.equal(w.applier.calls.length, 0, "nothing was applied");
        // While it is paused it does not decide, and is told that this is why (not a general refusal).
        await refuses("forbidden", () => decide(w, w.m, adm.principal, id), /is paused, and a paused agent does not decide.*left as it is/s);
        // The owner is not held by it; resumed, the administrator decides.
        await w.resume(adm.id);
        assert.equal((await decide(w, w.m, adm.principal, id)).status, "applied");
      });
    });

    test(`a decision written first stands, and a pause placed after it lands after it (${existing ? "the gate already existed" : "no gate existed yet"}, ${backend.name})`, async () => {
      await world(index, async (w) => {
        const adm = await w.make("Admin");
        const ann = await w.make("Ann");
        await w.m.change(w.owner, { commandId: cid("adm"), administrators: [adm.id] });
        if (existing) { await w.pause(adm.id); await w.resume(adm.id); }
        const id = (await ask(w, ann.principal, "base", { change: "newer interpreter" })).maintenanceId;
        w.applier.nextApply.push({ outcome: "unsupported", reason: "the host cannot take it now" });
        assert.equal((await decide(w, w.m, adm.principal, id)).status, "approved");
        const gate = await w.gate(adm.id);
        assert.equal(gate?.intent, "active", "the decision left the gate as it was (active)");
        await w.pause(adm.id);
        assert.equal((await w.gate(adm.id))?.intent, "pause", "a pause after the decision is accepted as before");
        assert.equal((await w.body(id)).decision?.by, adm.principal.id, "the decision stands");
      });
    });
  }

  test(`a pause placed between the check and the claim goes first: the claim fails, the approval is judged again and lapses, and the applier is never asked (${backend.name})`, async () => {
    await world(index, async (w) => {
      const adm = await w.make("Admin");
      const ann = await w.make("Ann");
      await w.m.change(w.owner, { commandId: cid("adm"), administrators: [adm.id] });
      const id = (await ask(w, ann.principal, "base", { change: "newer interpreter" })).maintenanceId;
      w.applier.nextApply.push({ outcome: "unsupported", reason: "the host cannot take it now" });
      assert.equal((await decide(w, w.m, adm.principal, id)).status, "approved");
      await w.m.idle();
      const asked = w.applier.calls.length;
      const race = afterRead(w.storage, "pause-gate", gateId(adm.id), async () => { await w.pause(adm.id); });
      assert.equal(await w.on(race.view).drive(id), "pending");
      assert.equal(race.fired(), true);
      assert.equal(w.applier.calls.length, asked, "the applier was not asked");
      const b = await w.body(id);
      assert.equal(b.status, "pending");
      assert.match(b.pendingReason ?? "", /no longer stands/);
      // Nothing in the window: an ordinary claim still applies.
      await w.resume(adm.id);
      assert.equal((await decide(w, w.m, adm.principal, id)).status, "applied");
    });
  });

  test(`a supervisor's decision and a revocation by an administrator are fenced the same way (${backend.name})`, async () => {
    await world(index, async (w) => {
      const boss = await w.make("Boss");
      const bob = await w.make("Bob", boss.id);
      await w.m.toggle(w.owner, { commandId: cid("t"), what: "bosses", enabled: true });
      await w.m.change(w.owner, { commandId: cid("s"), bossKinds: ["package"] });
      const one = (await ask(w, bob.principal, "package", pkg("fence-one"))).maintenanceId;
      const race = afterRead(w.storage, "pause-gate", gateId(boss.id), async () => { await w.pause(boss.id); });
      await refuses("forbidden", () => decide(w, w.on(race.view), boss.principal, one), /paused at the same moment/);
      assert.equal(race.fired(), true);
      assert.equal((await w.body(one)).status, "pending");
      await w.resume(boss.id);
      // A revocation by an administrator racing a pause.
      const adm = await w.make("Admin");
      const ann = await w.make("Ann");
      await w.m.change(w.owner, { commandId: cid("adm"), administrators: [adm.id] });
      const two = (await ask(w, ann.principal, "host-policy", { setting: "worker-limits", change: "more memory" })).maintenanceId;
      const race2 = afterRead(w.storage, "pause-gate", gateId(adm.id), async () => { await w.pause(adm.id); });
      await refuses("forbidden", () => w.on(race2.view).revoke(adm.principal, { commandId: cid("v"), maintenanceId: two, reason: "not now" }), /paused at the same moment, so its revocation was not recorded/);
      assert.equal((await w.body(two)).status, "pending");
      await w.resume(adm.id);
      assert.equal((await w.m.revoke(adm.principal, { commandId: cid("v"), maintenanceId: two, reason: "not now" })).status, "withdrawn");
    });
  });

  test(`two requests decided at once by different administrators both stand: the one that meets the other's first write of a shared gate is built again, not refused (${backend.name})`, async () => {
    await world(index, async (w) => {
      const a1 = await w.make("AdminOne"); const a2 = await w.make("AdminTwo");
      const ann = await w.make("Ann");
      await w.m.change(w.owner, { commandId: cid("adm"), administrators: [a1.id, a2.id] });
      const x = (await ask(w, ann.principal, "base", { change: "one" })).maintenanceId;
      const y = (await ask(w, ann.principal, "host-policy", { setting: "worker-limits", change: "two" })).maintenanceId;
      const installation = PauseService.gateIdOf({ kind: "installation", id: "installation" });
      assert.equal(await w.storage.getAggregate({ kind: "pause-gate", id: installation }), undefined, "no gate exists yet: both decisions create the installation's");
      // The second decision is written entirely inside the first one's window: after the first read the installation's gate as absent (so it meant to create it).
      const race = afterRead(w.storage, "pause-gate", installation, async () => { assert.equal((await decide(w, w.m, a2.principal, y, "reject")).status, "rejected"); });
      assert.equal((await decide(w, w.on(race.view), a1.principal, x, "reject")).status, "rejected");
      assert.equal(race.fired(), true);
      assert.deepEqual([(await w.body(x)).status, (await w.body(y)).status], ["rejected", "rejected"]);
      assert.deepEqual([(await w.body(x)).decision?.by, (await w.body(y)).decision?.by], [a1.principal.id, a2.principal.id]);
    });
  });

  test(`a change to the deciding administrator's own record at the same moment does not refuse the decision with a false answer: it is built again and stands; a move into a paused team is refused as paused (${backend.name})`, async () => {
    await world(index, async (w) => {
      const adm = await w.make("Admin"); const ann = await w.make("Ann");
      await w.m.change(w.owner, { commandId: cid("adm"), administrators: [adm.id] });
      const x = (await ask(w, ann.principal, "base", { change: "one" })).maintenanceId;
      const rename = afterRead(w.storage, "pause-gate", gateId(adm.id), async () => {
        const rec = (await w.storage.getAggregate({ kind: "agent", id: adm.id }))!;
        await w.agents.update(w.owner, { commandId: cid("u"), agentId: adm.id, expectedRevision: rec.revision, friendlyName: "Admin Renamed" });
      });
      assert.equal((await decide(w, w.on(rename.view), adm.principal, x, "reject")).status, "rejected");
      assert.equal(rename.fired(), true);
      // Moved into a team that is paused, in the window: the decision is refused, and the answer says it is paused.
      const y = (await ask(w, ann.principal, "host-policy", { setting: "worker-limits", change: "two" })).maintenanceId;
      const team = (await w.agents.createTeam(w.owner, { commandId: cid("tm"), name: "Night" })).id;
      await w.pauses.pause(w.owner, { commandId: cid("pz"), scope: { kind: "team", id: team }, reason: "hold" });
      const move = afterRead(w.storage, "pause-gate", gateId(adm.id), async () => {
        const rec = (await w.storage.getAggregate({ kind: "agent", id: adm.id }))!;
        await w.agents.update(w.owner, { commandId: cid("u"), agentId: adm.id, expectedRevision: rec.revision, teamId: team });
      });
      await refuses("forbidden", () => decide(w, w.on(move.view), adm.principal, y, "reject"), /paused/);
      assert.equal(move.fired(), true);
      assert.equal((await w.body(y)).status, "pending");
    });
  });

  test(`a paused agent that may not decide a request for another reason is given the ordinary refusal, not told to be resumed (${backend.name})`, async () => {
    await world(index, async (w) => {
      const boss = await w.make("Boss");
      const bob = await w.make("Bob", boss.id);
      await w.m.toggle(w.owner, { commandId: cid("t"), what: "bosses", enabled: true });
      await w.m.change(w.owner, { commandId: cid("s"), bossKinds: ["package"] });
      const id = (await ask(w, bob.principal, "network", { site: "example.org", port: 443 })).maintenanceId;
      await w.pause(boss.id);
      await refuses("forbidden", () => decide(w, w.m, boss.principal, id, "reject"), /may not decide this maintenance request/);
      const pk = (await ask(w, bob.principal, "package", pkg("paused-boss"))).maintenanceId;
      await refuses("forbidden", () => decide(w, w.m, boss.principal, pk, "reject"), /is paused/);
    });
  });

  test(`the notice for an administrator is anchored in the project the administrator works in; none without one, and a failing lookup leaves the notice without a project (${backend.name})`, async () => {
    await world(index, async (w) => {
      const told: MaintenanceNotice[] = [];
      const a1 = await w.make("AdminOne"); const a2 = await w.make("AdminTwo"); const a3 = await w.make("AdminThree");
      const ann = await w.make("Ann");
      const anchors: Record<string, string | undefined> = { [a1.principal.id]: "proj-aaaaaaaaaaaaaaaaaaaa", [a2.principal.id]: undefined };
      const m = w.on(w.storage, { notify: async (x) => { told.push(x); }, anchor: async (id) => { if (id === a3.principal.id) throw new Error("grants cannot be read"); return anchors[id]; } });
      await m.change(w.owner, { commandId: cid("adm"), administrators: [a1.id, a2.id, a3.id] });
      const r = await m.request(ann.principal, { commandId: cid("r"), kind: "base", spec: { change: "x" }, reason: "needed", rollbackPlan: "undo it" });
      const forAdmins = told.filter((t) => t.to === "administrator" && t.maintenanceId === r.maintenanceId);
      assert.deepEqual(forAdmins.map((t) => [t.administratorId, t.projectId]).sort(), [[a1.principal.id, "proj-aaaaaaaaaaaaaaaaaaaa"], [a2.principal.id, undefined], [a3.principal.id, undefined]].sort());
      assert.equal(told.filter((t) => t.to === "owner" && t.maintenanceId === r.maintenanceId).length, 1, "the owner's notice has no project");
      assert.equal(told.find((t) => t.to === "owner")?.projectId, undefined);
    });
  });

  test(`the notices of a protected request are closed once, after it is decided or revoked, never for a replay or another class (${backend.name})`, async () => {
    await world(index, async (w) => {
      const closed: string[] = [];
      const adm = await w.make("Admin"); const ann = await w.make("Ann");
      const m = w.on(w.storage, { closed: async (id) => { closed.push(id); } });
      await m.change(w.owner, { commandId: cid("adm"), administrators: [adm.id] });
      const one = (await m.request(ann.principal, { commandId: cid("r"), kind: "base", spec: { change: "x" }, reason: "needed", rollbackPlan: "undo it" })).maintenanceId;
      const two = (await m.request(ann.principal, { commandId: cid("r"), kind: "host-policy", spec: { setting: "worker-limits", change: "y" }, reason: "needed", rollbackPlan: "undo it" })).maintenanceId;
      const other = (await m.request(ann.principal, { commandId: cid("r"), kind: "package", spec: pkg("closed-other"), reason: "needed", rollbackPlan: "undo it" })).maintenanceId;
      assert.deepEqual(closed, [], "nothing closed while they wait");
      const same = cid("same");
      const dec = { commandId: same, maintenanceId: one, verdict: "reject", specDigest: (await w.body(one)).specDigest };
      await m.decide(adm.principal, dec);
      await m.decide(adm.principal, dec);
      assert.deepEqual(closed, [one], "once, and not for the replay");
      await m.revoke(adm.principal, { commandId: cid("v"), maintenanceId: two, reason: "withdrawn" });
      assert.deepEqual(closed, [one, two]);
      await m.decide(w.owner, { commandId: cid("d"), maintenanceId: other, verdict: "reject", specDigest: (await w.body(other)).specDigest });
      assert.deepEqual(closed, [one, two], "an ordinary request has no administrator notice to close");
    });
  });

  test(`the controller closes the administrators' notices of one request in every project they were raised in, and nothing else (${backend.name})`, async () => {
    await world(index, async (w) => {
      const svc = NotificationService.withEpoch(w.storage, (await ProjectService.open(w.storage, { holder: "c1", clock: () => "2026-11-16T10:00:00.000Z", pause: async () => undefined })).epoch, { clock: () => "2026-11-16T10:00:00.000Z" });
      const one = "mnt-aaaaaaaaaaaaaaaaaaaa"; const other = "mnt-bbbbbbbbbbbbbbbbbbbb";
      const emit = (id: string, projectId: string, refKind = "maintenance-admin") => svc.emitFromController({ commandId: cid("e"), kind: "maintenance", level: "notice", ref: { kind: refKind, id }, projectId, detail: "an administrator may decide it" });
      await emit(`${one}-11111111`, "proj-garden"); await emit(`${one}-22222222`, "proj-orchard");
      await emit(`${other}-11111111`, "proj-garden"); await emit(one, "proj-garden", "maintenance");
      assert.deepEqual(await svc.settleRefsFromController({ kind: "maintenance", refKind: "maintenance-admin", idPrefix: one }), { closed: 2 });
      const open = (await svc.inbox(w.owner)).items.filter((i) => i.state !== "answered" && i.state !== "settled").map((i) => `${i.ref.kind}:${i.ref.id}`).sort();
      assert.deepEqual(open, [`maintenance-admin:${other}-11111111`, `maintenance:${one}`]);
      assert.deepEqual(await svc.settleRefsFromController({ kind: "maintenance", refKind: "maintenance-admin", idPrefix: one }), { closed: 0 }, "a second close finds nothing");
      await refuses("invalid_command", () => svc.settleRefsFromController({ kind: "maintenance", refKind: "maintenance-admin", idPrefix: "mnt-" }));
    });
  });
}
