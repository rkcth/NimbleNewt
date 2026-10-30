import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { ResponsibilityChecks } from "./checks.js";
import { ResponsibilityService } from "./index.js";

after(stopServer);

let n = 0;
const cid = (label: string): string => `${label}-${n++}`;

for (const backend of backends) {
  const suite = (name: string, body: (c: { owner: Principal; project: string; duties: ResponsibilityService; checks: ResponsibilityChecks; again(): ResponsibilityChecks; setNow(iso: string): void; make(extra?: Record<string, unknown>): Promise<string>; agent(grants: { action: string; project: string }[]): Promise<Principal> }) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      let now = "2026-10-22T10:00:00.000Z";
      const options = { clock: () => now, pause: async () => undefined };
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const duties = ResponsibilityService.withEpoch(world.storage, projects.epoch, options);
        const checks = ResponsibilityChecks.withEpoch(world.storage, projects.epoch, duties, options);
        const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "Ops" })).id;
        await body({
          owner, project, duties, checks,
          again: () => ResponsibilityChecks.withEpoch(world.storage, projects.epoch, ResponsibilityService.withEpoch(world.storage, projects.epoch, options), options),
          setNow: (iso) => { now = iso; },
          make: async (extra = {}) => (await duties.create(owner, { commandId: cid("r"), projectId: project, title: "Keep the server healthy", objective: "Up", everyMinutes: 60, ...extra } as never)).id,
          agent: async (grants) => { await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: `a${n++}`, grants }); return principals.authenticate((await principals.issueCredential(owner, `agent:a${n - 1}`)).token); },
        });
      } finally { await world.close(); }
    });

  suite("a check comes due once per slot, however often or from whichever instance it is generated, and is finished by a check observation", async ({ owner, project, duties, checks, again, setNow, make }) => {
    const r = await make();
    assert.deepEqual(await checks.generate(owner, project), [], "nothing is due before the first period has passed");
    setNow("2026-10-22T11:00:00.000Z");
    const first = await checks.generate(owner, project);
    assert.equal(first.length, 1);
    assert.deepEqual(await checks.generate(owner, project), [], "the same slot is not recorded twice");
    assert.deepEqual(await again().generate(owner, project), [], "nor by another instance on the same store (after a restart)");
    const pending = (await again().pending(owner, project))!;
    assert.deepEqual(pending.map((c) => [c.responsibilityId, c.slotStart, c.gap, c.inMaintenanceWindow]), [[r, "2026-10-22T11:00:00.000Z", undefined, false]]);
    setNow("2026-10-22T11:05:00.000Z");
    await duties.record(owner, { commandId: cid("c"), responsibilityId: r, kind: "check", summary: "all well", outcome: "ok" });
    assert.deepEqual(await checks.pending(owner, project), [], "the check observation finishes it");
    assert.deepEqual(await checks.generate(owner, project), [], "and the next one is not due yet");
    setNow("2026-10-22T12:05:00.000Z");
    assert.equal((await checks.generate(owner, project)).length, 1, "an hour after the last check the next one is due");
  });

  suite("after downtime one catch-up check is owed with the gap named, not one per missed slot", async ({ owner, project, checks, setNow, make }) => {
    await make();
    setNow("2026-10-22T15:30:00.000Z");
    assert.equal((await checks.generate(owner, project)).length, 1);
    const [c] = (await checks.pending(owner, project))!;
    assert.equal(c!.slotStart, "2026-10-22T11:00:00.000Z");
    assert.deepEqual(c!.gap, { start: "2026-10-22T12:00:00.000Z", end: "2026-10-22T16:00:00.000Z", missedChecks: 4, reason: "not-generated" });
  });

  suite("paused and retired responsibilities and ones with no schedule produce no check; a check inside a maintenance window is owed and says so", async ({ owner, project, duties, checks, setNow, make }) => {
    const paused = await make({ title: "paused" });
    const retired = await make({ title: "retired" });
    await make({ title: "unscheduled", everyMinutes: undefined });
    await make({ title: "plain" });
    const windowed = await make({ title: "windowed", maintenanceWindows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "11:00", end: "12:00" }] });
    await duties.update(owner, { commandId: cid("u"), responsibilityId: paused, expectedRevision: (await duties.get(owner, paused))!.revision, state: "paused" });
    await duties.update(owner, { commandId: cid("u"), responsibilityId: retired, expectedRevision: (await duties.get(owner, retired))!.revision, state: "retired" });
    setNow("2026-10-22T11:10:00.000Z");
    assert.equal((await checks.generate(owner, project)).length, 2, "the unpaused, scheduled ones only (the plain one and the windowed one)");
    const got = (await checks.pending(owner, project))!;
    assert.ok(!got.some((c) => c.responsibilityId === paused || c.responsibilityId === retired));
    assert.deepEqual(got.filter((c) => c.responsibilityId === windowed).map((c) => c.inMaintenanceWindow), [true]);
  });

  suite("who may generate and read checks: the owner, a service, or a holder of responsibility.write; an unrelated agent is refused and cannot read them", async ({ owner, project, checks, setNow, make, agent }) => {
    await make();
    setNow("2026-10-22T11:00:00.000Z");
    const stranger = await agent([{ action: "task.read", project }]);
    await assert.rejects(checks.generate(stranger, project), (e: unknown) => e instanceof DomainError && ["forbidden", "not_found"].includes(e.code));
    assert.equal(await checks.pending(stranger, project), undefined, "it reads like a project they cannot see");
    const writer = await agent([{ action: "responsibility.write", project }, { action: "responsibility.read", project }]);
    assert.equal((await checks.generate(writer, project)).length, 1);
    assert.equal((await checks.pending(writer, project))!.length, 1);
  });
}
