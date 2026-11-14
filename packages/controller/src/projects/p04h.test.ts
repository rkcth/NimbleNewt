import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import type { ControllerStorage } from "../storage/types.js";
import { ResponsibilityChecks, INDEX_MAX } from "./checks.js";
import { gapAppliesTo } from "./coverage-gaps.js";
import { IncidentService } from "./incidents.js";
import { MaintenanceLeaseService, LEASE_WAIT_MINUTES } from "./leases.js";
import { noteSuspendedResponsibilities } from "./suspend-notes.js";
import { ProjectResourceService, ResponsibilityService } from "./index.js";

after(stopServer);

let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const T0 = "2026-11-14T10:00:00.000Z";
const at = (minutes: number): string => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

interface World { owner: Principal; project: string; leases: MaintenanceLeaseService; duties: ResponsibilityService; checks: ResponsibilityChecks; resource: string; ann: Principal; bob: Principal; carl: Principal; scans: { count: number }; setNow(iso: string): void; storage: ControllerStorage; epoch: number }

for (const backend of backends) {
  const suite = (name: string, body: (c: World) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      let now = T0;
      const options = { clock: () => now, pause: async () => undefined };
      // Counts the scans of check records, to show what a read of the owed checks costs.
      const scans = { count: 0 };
      const counted = new Proxy(world.storage, { get: (t, p) => { const v = Reflect.get(t, p, t); if (p !== "listAggregates" || typeof v !== "function") return typeof v === "function" ? v.bind(t) : v; return (kind: string, page: unknown) => { if (kind === "responsibility-check") scans.count++; return (v as (k: string, q: unknown) => unknown).call(t, kind, page); }; } }) as ControllerStorage;
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const resources = ProjectResourceService.withEpoch(world.storage, projects.epoch, options);
        const duties = ResponsibilityService.withEpoch(world.storage, projects.epoch, options);
        const inc = IncidentService.withEpoch(world.storage, projects.epoch, duties, options);
        const leases = MaintenanceLeaseService.withEpoch(world.storage, projects.epoch, duties, inc, options);
        const checks = ResponsibilityChecks.withEpoch(counted, projects.epoch, duties, options);
        const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "Ops" })).id;
        const agent = async (grants: { action: string; project: string }[]): Promise<Principal> => {
          await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: `g${n++}`, grants: grants as never });
          return principals.authenticate((await principals.issueCredential(owner, `agent:g${n - 1}`)).token);
        };
        const rights = [{ action: "responsibility.read", project }, { action: "responsibility.write", project }];
        const ann = await agent(rights); const bob = await agent(rights); const carl = await agent([]);
        const res = await resources.bindResource(owner, { commandId: cid("b"), projectId: project, kind: "service", label: "Web", locator: "https://example.test/health" } as never);
        await duties.create(owner, { commandId: cid("r"), projectId: project, title: "Keep the server healthy", objective: "Up", everyMinutes: 60, ownerId: ann.id, managed: [res.id] } as never);
        await body({ owner, project, leases, duties, checks, resource: res.id, ann, bob, carl, scans, setNow: (iso) => { now = iso; }, storage: world.storage, epoch: projects.epoch });
      } finally { await world.close(); }
    });

  suite("a lease still in time that keeps another agent waiting is listed once per holding, only after the wait is long, only for the owner, and its blocks of an earlier holding do not count (card P04h)", async ({ owner, leases, resource, ann, bob, carl, setNow }) => {
    await leases.acquire(ann, { commandId: cid("a"), resourceId: resource, purpose: "upgrade", minutes: 240 });
    assert.deepEqual(await leases.untold(owner), { expired: [], waiting: [] }, "nobody has waited yet");
    setNow(at(5));
    assert.equal((await leases.acquire(bob, { commandId: cid("b"), resourceId: resource, purpose: "patch" })).status, "blocked");
    setNow(at(5 + LEASE_WAIT_MINUTES - 1));
    assert.deepEqual((await leases.untold(owner)).waiting, [], "a short wait is not told");
    setNow(at(5 + LEASE_WAIT_MINUTES));
    const [w] = (await leases.untold(owner)).waiting;
    assert.deepEqual([w!.holderId, w!.generation, w!.blockedCount, w!.waitingSince, w!.rivals], [ann.id, 1, 1, at(5), [bob.id]]);
    await assert.rejects(leases.untold(ann), /may not/, "an agent does not read what the owner was not told");
    await assert.rejects(leases.markWaitTold(bob, resource, 1), /may not/, "nor mark it as told");
    assert.equal(await leases.markWaitTold(owner, resource, 2), false, "another holding's mark changes nothing");
    assert.deepEqual((await leases.untold(owner)).waiting.length, 1);
    assert.equal(await leases.markWaitTold(owner, resource, 1), true);
    assert.deepEqual((await leases.untold(owner)).waiting, [], "told once");
    assert.equal(await leases.markWaitTold(owner, resource, 1), false, "a repeat marks nothing");
    assert.deepEqual([(await leases.standing(owner, w!.leaseId))!.status, (await leases.standing(owner, w!.leaseId))!.waitTold], ["held", true]);
    await assert.rejects(leases.standing(carl, w!.leaseId), /may not/);
    // The holder renews: still the same holding, still told. Released and taken again: a new holding with no blocks of the old one.
    await leases.release(ann, { commandId: cid("r"), resourceId: resource, validation: "passed", evidence: "done" });
    setNow(at(300));
    await leases.acquire(bob, { commandId: cid("b2"), resourceId: resource, purpose: "patch", minutes: 240 });
    setNow(at(400));
    assert.deepEqual((await leases.untold(owner)).waiting, [], "the old holding's block is not this holding's wait");
    assert.equal((await leases.acquire(ann, { commandId: cid("a3"), resourceId: resource, purpose: "again" })).status, "blocked");
    setNow(at(400 + LEASE_WAIT_MINUTES));
    const [again] = (await leases.untold(owner)).waiting;
    assert.deepEqual([again!.holderId, again!.generation, again!.rivals], [bob.id, 2, [ann.id]], "a new holding is told again");
  });

  suite("one pass finds the expired and the waiting leases of every project, and a lease that moved on is not told or listed (card P04h)", async ({ owner, leases, resource, ann, bob, setNow, storage, epoch }) => {
    await leases.acquire(ann, { commandId: cid("a"), resourceId: resource, purpose: "upgrade", minutes: 20 });
    await leases.acquire(bob, { commandId: cid("b"), resourceId: resource, purpose: "patch" });
    setNow(at(25));
    const found = await leases.untold(owner);
    assert.deepEqual([found.expired.map((l) => [l.holderId, l.blockedCount]), found.waiting], [[[ann.id, 1]], []], "expired, and not also waiting");
    assert.equal((await leases.standing(owner, found.expired[0]!.leaseId))!.status, "expired");
    await leases.acquire(bob, { commandId: cid("b2"), resourceId: resource, purpose: "patch" });
    assert.deepEqual(await leases.untold(owner), { expired: [], waiting: [] }, "taken over: nothing ran out any more");
    await leases.release(bob, { commandId: cid("r"), resourceId: resource, validation: "passed", evidence: "ok" });
    assert.equal((await leases.standing(owner, found.expired[0]!.leaseId))!.status, "free");
    void storage; void epoch;
  });

  suite("a gap is about a responsibility only when it concerns what that responsibility depends on (card P04h)", async () => {
    const watcher = { id: "resp-1", ownerId: "agent:ann", eventSources: ["files", "deploy:finished"] };
    const quiet = { id: "resp-2", eventSources: [] as string[] };
    const g = (reason: "controller-down" | "provider-outage" | "event-source-outage" | "events-missed", key: string) => ({ reason, key });
    assert.equal(gapAppliesTo(g("controller-down", "controller"), quiet), true, "downtime is about all");
    assert.deepEqual([gapAppliesTo(g("provider-outage", "provider:model:m1"), watcher), gapAppliesTo(g("provider-outage", "provider:model:m1"), quiet)], [true, false], "no answering agent: no model is asked, so a provider outage changes nothing");
    assert.deepEqual([gapAppliesTo(g("event-source-outage", "source:files"), watcher), gapAppliesTo(g("event-source-outage", "source:deploy"), watcher), gapAppliesTo(g("event-source-outage", "source:git"), watcher), gapAppliesTo(g("event-source-outage", "source:files"), quiet)], [true, true, false, false], "a source id, or source:kind, names the source; one that names none is not affected");
    assert.deepEqual([gapAppliesTo(g("events-missed", "source:fil"), watcher), gapAppliesTo(g("events-missed", "source:files"), watcher)], [false, true], "a prefix of a name is not the name");
    assert.deepEqual([gapAppliesTo(g("events-missed", "events:resp-1:7"), watcher), gapAppliesTo(g("events-missed", "events:resp-1:7"), quiet)], [true, false], "a retention cut is about the responsibility whose look it was");
    assert.equal(gapAppliesTo(g("events-missed", "something-else"), quiet), true, "a gap that cannot be narrowed is not hidden");
  });

  suite("the owed checks of a project come from an index after one scan, every check made after that is in it, a finished one drops out, and a reader never changes it (card P04h)", async ({ owner, project, duties, checks, scans, setNow, carl, storage, epoch }) => {
    const [r] = (await duties.list(owner, project))!;
    setNow(at(60));
    assert.equal((await checks.generate(owner, project)).length, 1);
    scans.count = 0;
    const a = (await checks.pending(carl, project)) ?? null;
    assert.equal(a, null, "a reader of nothing sees nothing");
    assert.deepEqual((await checks.pending(owner, project))!.map((c) => c.slotStart), [at(60)]);
    assert.ok(scans.count > 0, "the first read scans (the index had not been completed)");
    scans.count = 0;
    setNow(at(61));
    const second = (await duties.create(owner, { commandId: cid("r2"), projectId: project, title: "Second", objective: "Up", everyMinutes: 60 } as never)).id;
    setNow(at(121));
    assert.equal((await checks.generate(owner, project)).length, 1);
    assert.deepEqual((await checks.pending(owner, project))!.map((c) => [c.responsibilityId === second, c.slotStart]), [[false, at(60)], [true, at(121)]]);
    assert.equal(scans.count, 0, "from then on no scan of check records is needed");
    // A check recorded by the responsibility ends what was owed before it; the next read drops it from the index.
    await duties.record(owner, { commandId: cid("c"), responsibilityId: r!.id, kind: "check", summary: "fine", outcome: "ok" });
    assert.deepEqual((await checks.pending(owner, project))!.map((c) => c.responsibilityId === second), [true]);
    const index = (await storage.listAggregates("responsibility-check-index", { limit: 10 }))[0]!;
    assert.deepEqual([(index.body as { complete: boolean }).complete, (index.body as { ids: string[] }).ids.length], [true, 1], "only the owed check is kept");
    assert.equal(scans.count, 0);
    // An installation that had checks before the index existed (no index record at all) is found by a scan and then indexed.
    await storage.applyOperation({ operationId: cid("drop"), epoch, actor: "t", correlationId: cid("drop"), at: at(181), changes: [{ type: "delete", ref: { kind: "responsibility-check-index", id: index.id }, expectedRevision: index.revision }], audit: [{ type: "test.drop", subject: { kind: "responsibility-check-index", id: index.id }, detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
    assert.deepEqual((await checks.pending(owner, project))!.map((c) => c.slotStart), [at(121)], "found without an index");
    assert.ok(scans.count > 0);
    scans.count = 0;
    assert.deepEqual((await checks.pending(owner, project))!.map((c) => c.slotStart), [at(121)]);
    assert.equal(scans.count, 0, "and indexed again");
    assert.ok(INDEX_MAX >= 1000);
  });
}

test("noteSuspendedResponsibilities writes one note per responsibility of the suspended agent, once, and none for other scopes (card P04h)", async () => {
  const notes: string[] = [];
  const duties = {
    answeredBy: async (_by: Principal, agent?: string) => [{ id: "r1", title: "Web", ownerId: "agent:ann" }, { id: "r2", title: "Db", ownerId: "agent:ann" }].filter(() => agent === undefined || agent === "ann"),
    record: async (_by: Principal, c: { commandId: string; responsibilityId: string; summary: string }) => { if (c.responsibilityId === "r1" && notes.length === 0) throw new Error("busy"); notes.push(`${c.commandId}|${c.summary}`); return {} as never; },
  };
  const by = { id: "service:x", kind: "owner", name: "x", grants: [] } as unknown as Principal;
  await assert.rejects(noteSuspendedResponsibilities(duties as never, by, { intentId: "i1", scope: { kind: "agent", id: "ann" }, mode: "suspend", outcome: { state: "suspended" } }), /busy/);
  assert.equal(notes.length, 1, "one failing note does not skip the other");
  assert.match(notes[0]!, /^stop-note-i1-r2\|agent:ann was suspended\. .*"Db".*does not stop the service it maintains.*Suspend and Release.*new monitor/);
  assert.deepEqual((await noteSuspendedResponsibilities(duties as never, by, { intentId: "i2", scope: { kind: "task", id: "t" }, mode: "suspend", outcome: { state: "suspended" } })).noted, []);
  assert.deepEqual((await noteSuspendedResponsibilities(duties as never, by, { intentId: "i3", scope: { kind: "agent", id: "ann" }, mode: "stop", outcome: { state: "recovery-required" } })).noted, [], "a stop that did not finish says nothing");
  assert.equal((await noteSuspendedResponsibilities(duties as never, by, { intentId: "i4", scope: { kind: "installation", id: "x" }, mode: "stop", outcome: { state: "stopped" } })).noted.length, 2);
  assert.match(notes.at(-1)!, /was stopped with the whole installation/);
});
