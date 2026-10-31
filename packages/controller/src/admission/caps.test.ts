import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService } from "../security/index.js";
import type { ControllerStorage } from "../storage/types.js";
import type { Principal } from "../security/principals.js";
import { AdmissionService, CapacityLimitsService, type RequestAdmission } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-10-30T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); return true; });
};

for (const backend of backends) {
  const suite = (name: string, body: (c: {
    admission: AdmissionService; caps: CapacityLimitsService; owner: Principal; stranger: Principal;
    ask(extra?: Partial<RequestAdmission>): Promise<{ id: string; state: string }>;
    release(id: string): Promise<unknown>;
    running(): Promise<string[]>;
    store: ControllerStorage; epoch: number;
  }) => Promise<void>) =>
    test(`${backend.name}: capacity caps: ${name}`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        await principals.enroll(owner, { commandId: cid("e"), kind: "host", name: "h1", grants: [] });
        await principals.enroll(owner, { commandId: cid("e"), kind: "host", name: "h2", grants: [] });
        const stranger = { ...owner, kind: "agent", id: "agent:bob" } as unknown as Principal;
        const admission = AdmissionService.withEpoch(world.storage, projects.epoch, options);
        const caps = CapacityLimitsService.withEpoch(world.storage, projects.epoch, { ...options, onChanged: async (r) => { await admission.sweep({ commandId: `sw-${r}-${n++}`, actor: "owner:rob" }); } });
        for (const h of ["host:h1", "host:h2"]) await admission.setCapacity({ commandId: cid("c"), actor: "owner:rob", host: h, capacity: { cpus: 64, memoryMb: 262_144 } });
        // Room enough that only the caps hold anything back.
        await admission.setLimits({ commandId: cid("l"), actor: "owner:rob", limits: { productive: 64, perHost: 16, control: 2, queue: 100, depth: 3, children: 4, patience: 5 } });
        const ask = (extra: Partial<RequestAdmission> = {}) => admission.request({ commandId: cid("r"), actor: "controller", class: "productive", host: "host:h1", cpus: 1, memoryMb: 1024, ...extra } as RequestAdmission);
        await body({ admission, caps, owner, stranger, ask, release: (id) => admission.release({ commandId: cid("rel"), actor: "controller", requestId: id, reason: "done" }), running: async () => (await admission.snapshot()).running.map((e) => e.id), store: world.storage, epoch: projects.epoch });
      } finally { await world.close(); }
    });

  suite("everything is off by default: no cap holds work back", async ({ ask, running }) => {
    for (let i = 0; i < 6; i++) assert.equal((await ask({ project: "project:a", agent: "agent:x", reportsTo: "agent:boss" })).state, "running");
    assert.equal((await running()).length, 6);
  });

  suite("a per-project cap makes the next wait with a reason, not fail; other projects carry on; a freed place is taken in order", async ({ ask, admission, caps, owner, release }) => {
    await caps.change(owner, { commandId: cid("c"), set: { perProject: 2 } });
    const a = await ask({ project: "project:a" }), b = await ask({ project: "project:a" });
    const c = await ask({ project: "project:a" });
    assert.deepEqual([a.state, b.state, c.state], ["running", "running", "waiting"]);
    const w = await admission.where(c.id);
    assert.equal(w.state, "waiting");
    assert.match((w as { reason?: string }).reason ?? "", /^waiting for capacity: project project:a already has 2 attempts running/);
    assert.equal((await ask({ project: "project:other" })).state, "running", "another project is not held back");
    await release(a.id);
    assert.equal((await admission.where(c.id)).state, "running");
  });

  suite("a per-agent cap and a fan-in cap hold work and say why", async ({ ask, admission, caps, owner }) => {
    await caps.change(owner, { commandId: cid("c"), set: { perAgent: 1, fanIn: 2 } });
    assert.equal((await ask({ agent: "agent:x" })).state, "running");
    const second = await ask({ agent: "agent:x" });
    assert.equal(second.state, "waiting");
    assert.match(((await admission.where(second.id)) as { reason?: string }).reason ?? "", /agent agent:x already has 1 attempts running/);
    assert.equal((await ask({ agent: "agent:y", reportsTo: "agent:boss" })).state, "running");
    assert.equal((await ask({ agent: "agent:z", reportsTo: "agent:boss" })).state, "running");
    const third = await ask({ agent: "agent:w", reportsTo: "agent:boss" });
    assert.equal(third.state, "waiting");
    assert.match(((await admission.where(third.id)) as { reason?: string }).reason ?? "", /agent:boss already receives reports from 2 running attempts/);
    assert.equal((await ask({ agent: "agent:v", reportsTo: "agent:other-boss" })).state, "running");
  });

  suite("fair queueing: a low-priority waiter is not starved by later high-priority work for the same agent", async ({ ask, admission, caps, owner, release }) => {
    await caps.change(owner, { commandId: cid("c"), set: { perAgent: 1 } });
    const first = await ask({ agent: "agent:x", priority: 5 });
    const low = await ask({ agent: "agent:x", priority: 0 });
    const later: string[] = [];
    for (let i = 0; i < 8; i++) later.push((await ask({ agent: "agent:x", priority: 9 })).id);
    let current = first.id;
    let lowRanAfter = -1;
    for (let i = 0; i < 9; i++) {
      await release(current);
      const snap = await admission.snapshot();
      current = snap.running.find((e) => e.agent === "agent:x")!.id;
      if (current === low.id) { lowRanAfter = i; break; }
    }
    assert.ok(lowRanAfter >= 0 && lowRanAfter <= 5, `the low-priority request ran after ${lowRanAfter} releases (patience is 5)`);
  });

  suite("a lower cap stops nothing that runs; raising or removing a cap lets waiting work in at once", async ({ ask, admission, caps, owner }) => {
    const a = await ask({ project: "project:a" }), b = await ask({ project: "project:a" });
    await caps.change(owner, { commandId: cid("c"), set: { perProject: 1 } });
    assert.equal((await admission.where(a.id)).state, "running");
    assert.equal((await admission.where(b.id)).state, "running");
    const c = await ask({ project: "project:a" });
    assert.equal(c.state, "waiting");
    await caps.change(owner, { commandId: cid("c"), set: { perProject: 4 } });
    assert.equal((await admission.where(c.id)).state, "running", "the raised cap admitted it without another request");
    const d = await ask({ project: "project:a" });
    assert.equal(d.state, "running");
    await caps.change(owner, { commandId: cid("c"), set: { perProject: 1 } });
    const e = await ask({ project: "project:a" });
    assert.equal(e.state, "waiting");
    await caps.change(owner, { commandId: cid("c"), disable: ["perProject"] });
    assert.equal((await admission.where(e.id)).state, "running", "turning the cap off lets it in");
    await caps.change(owner, { commandId: cid("c"), enable: ["perProject"] });
    assert.deepEqual((await caps.get(owner)).effective, { perProject: 1 }, "the figure was kept while off");
  });

  suite("the setting is owner-only, race-safe, replay-safe and validated", async ({ caps, owner, stranger }) => {
    await refuses("forbidden", () => caps.change(stranger, { commandId: cid("c"), set: { perProject: 1 } }));
    await refuses("forbidden", () => caps.get(stranger));
    await refuses("invalid_command", () => caps.change(owner, { commandId: cid("c"), set: { perProject: 0 } }));
    await refuses("invalid_command", () => caps.change(owner, { commandId: cid("c"), set: { nonsense: 1 } }));
    await refuses("invalid_command", () => caps.change(owner, { commandId: cid("c"), set: { fanIn: 1 }, disable: ["fanIn"] }));
    await refuses("invalid_command", () => caps.change(owner, { commandId: cid("c"), enable: ["fanIn"] }));
    const id = cid("c");
    const first = await caps.change(owner, { commandId: id, set: { fanIn: 2 }, expectedRevision: 0 });
    assert.deepEqual(await caps.change(owner, { commandId: id, set: { fanIn: 2 }, expectedRevision: 0 }), first, "a repeat does nothing twice");
    await refuses("stale_revision", () => caps.change(owner, { commandId: cid("c"), set: { fanIn: 3 }, expectedRevision: 0 }));
    assert.equal((await caps.get(owner)).revision, first.revision);
  });

  suite("a damaged setting admits nothing new, says so, and release still works", async ({ ask, admission, release, store, epoch, caps, owner }) => {
    await caps.change(owner, { commandId: cid("c"), set: { perProject: 5 } });
    const a = await ask({ project: "project:a" });
    const ref = { kind: "capacity-limits-settings", id: "main" };
    const rec = (await store.getAggregate(ref))!;
    await store.applyOperation({ operationId: cid("dmg"), epoch, actor: "owner:rob", correlationId: "dmg", at: "2026-10-30T10:00:00.000Z", changes: [{ type: "update", ref, expectedRevision: rec.revision, body: { perProject: { enabled: true, value: "x" } } }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
    await refuses("integrity", () => ask({ project: "project:a" }));
    await refuses("integrity", () => caps.get(owner));
    await release(a.id);
    assert.equal((await admission.where(a.id)).state, "absent");
    await caps.change(owner, { commandId: cid("c"), unset: ["perProject"] });
    assert.equal((await ask({ project: "project:a" })).state, "running", "repaired");
  });
}
