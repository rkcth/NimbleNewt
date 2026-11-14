import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { IncidentService } from "./incidents.js";
import { MaintenanceLeaseService } from "./leases.js";
import { ProjectResourceService, ResponsibilityService } from "./index.js";

after(stopServer);

let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const T0 = "2026-11-14T10:00:00.000Z";

for (const backend of backends) {
  const suite = (name: string, body: (c: { owner: Principal; project: string; leases: MaintenanceLeaseService; resource: string; ann: Principal; bob: Principal; carl: Principal; setNow(iso: string): void }) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      let now = T0;
      const options = { clock: () => now, pause: async () => undefined };
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const resources = ProjectResourceService.withEpoch(world.storage, projects.epoch, options);
        const duties = ResponsibilityService.withEpoch(world.storage, projects.epoch, options);
        const inc = IncidentService.withEpoch(world.storage, projects.epoch, duties, options);
        const leases = MaintenanceLeaseService.withEpoch(world.storage, projects.epoch, duties, inc, options);
        const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "Ops" })).id;
        const agent = async (grants: { action: string; project: string }[]): Promise<Principal> => {
          await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: `g${n++}`, grants: grants as never });
          return principals.authenticate((await principals.issueCredential(owner, `agent:g${n - 1}`)).token);
        };
        const rights = [{ action: "responsibility.read", project }, { action: "responsibility.write", project }];
        const ann = await agent(rights); const bob = await agent(rights); const carl = await agent([]);
        const res = await resources.bindResource(owner, { commandId: cid("b"), projectId: project, kind: "service", label: "Web", locator: "https://example.test/health" } as never);
        await duties.create(owner, { commandId: cid("r"), projectId: project, title: "Keep the server healthy", objective: "Up", everyMinutes: 60, ownerId: ann.id, managed: [res.id] } as never);
        await body({ owner, project, leases, resource: res.id, ann, bob, carl, setNow: (iso) => { now = iso; } });
      } finally { await world.close(); }
    });

  suite("a lease that ran out unreleased is listed once as untold, and told only when marked; a live one is not listed (card P04g)", async ({ owner, project, leases, resource, ann, setNow }) => {
    await leases.acquire(ann, { commandId: cid("a"), resourceId: resource, purpose: "upgrade", minutes: 30 });
    setNow("2026-11-14T10:29:00.000Z");
    assert.deepEqual(await leases.expiredUntold(owner, project), [], "still live: nothing to tell");
    setNow("2026-11-14T10:31:00.000Z");
    const listed = (await leases.expiredUntold(owner, project))!;
    assert.deepEqual(listed.map((l) => [l.resourceId, l.holderId, l.expiredAt, l.generation, l.blockedCount]), [[resource, ann.id, "2026-11-14T10:30:00.000Z", 1, 0]]);
    assert.equal(await leases.markExpiryTold(owner, resource, 1), true);
    assert.deepEqual(await leases.expiredUntold(owner, project), [], "told once: not listed again");
    assert.equal(await leases.markExpiryTold(owner, resource, 1), false, "a repeat changes nothing");
    // The lease is still shown as expired (the notice does not release it).
    assert.deepEqual((await leases.list(owner, project))!.map((l) => l.status), ["expired"]);
  });

  suite("a released lease, a taken-over lease and a stale mark are not told; a new holding that also runs out is told again; rivals that met it are counted (card P04g)", async ({ owner, project, leases, resource, ann, bob, setNow }) => {
    await leases.acquire(ann, { commandId: cid("a"), resourceId: resource, purpose: "one", minutes: 10 });
    await leases.release(ann, { commandId: cid("x"), resourceId: resource, validation: "passed", evidence: "fine" });
    setNow("2026-11-14T11:00:00.000Z");
    assert.deepEqual(await leases.expiredUntold(owner, project), [], "released in time: nothing ran out");
    assert.equal(await leases.markExpiryTold(owner, resource, 1), false, "a free lease is not marked");

    await leases.acquire(ann, { commandId: cid("a"), resourceId: resource, purpose: "two", minutes: 10 });
    setNow("2026-11-14T11:05:00.000Z");
    assert.equal((await leases.acquire(bob, { commandId: cid("a"), resourceId: resource, purpose: "restart" })).status, "blocked");
    setNow("2026-11-14T11:20:00.000Z");
    const [first] = (await leases.expiredUntold(owner, project))!;
    assert.deepEqual([first!.generation, first!.blockedCount, first!.holderId], [2, 1, ann.id]);
    // Bob takes it over before the notice was marked: that holding is over, so the mark is refused and it is not listed.
    await leases.acquire(bob, { commandId: cid("a"), resourceId: resource, purpose: "restart", minutes: 10 });
    assert.equal(await leases.markExpiryTold(owner, resource, 2), false);
    assert.deepEqual(await leases.expiredUntold(owner, project), []);
    // Bob's holding runs out too: a new notice, for generation 3.
    setNow("2026-11-14T11:40:00.000Z");
    assert.deepEqual((await leases.expiredUntold(owner, project))!.map((l) => [l.holderId, l.generation]), [[bob.id, 3]]);
    assert.equal(await leases.markExpiryTold(owner, resource, 3), true);
    assert.deepEqual(await leases.expiredUntold(owner, project), []);
  });

  suite("a reader without the right to the project learns nothing about its leases (card P04g)", async ({ project, leases, carl, resource, ann, setNow }) => {
    await leases.acquire(ann, { commandId: cid("a"), resourceId: resource, purpose: "upgrade", minutes: 5 });
    setNow("2026-11-14T12:00:00.000Z");
    assert.equal(await leases.expiredUntold(carl, project), undefined);
  });
}
