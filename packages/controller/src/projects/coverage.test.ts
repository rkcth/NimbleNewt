import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { CoverageService, CoverageSettingsService } from "./coverage.js";
import { ResponsibilityService } from "./index.js";

after(stopServer);

let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const T0 = "2026-10-22T10:00:00.000Z";

for (const backend of backends) {
  const suite = (name: string, body: (c: { owner: Principal; project: string; duties: ResponsibilityService; settings: CoverageSettingsService; coverage: CoverageService; principals: PrincipalService; setNow(iso: string): void; make(extra?: Record<string, unknown>): Promise<string>; agent(grants: unknown[]): Promise<Principal> }) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      let now = T0;
      const options = { clock: () => now, pause: async () => undefined };
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const duties = ResponsibilityService.withEpoch(world.storage, projects.epoch, options);
        const settings = CoverageSettingsService.withEpoch(world.storage, projects.epoch, options);
        const coverage = CoverageService.withEpoch(world.storage, projects.epoch, settings, options);
        const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "Ops" })).id;
        await body({
          owner, project, duties, settings, coverage, principals,
          setNow: (iso) => { now = iso; },
          make: async (extra = {}) => (await duties.create(owner, { commandId: cid("r"), projectId: project, title: "Keep the server healthy", objective: "Up", everyMinutes: 60, ...extra } as never)).id,
          agent: async (grants) => { await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: `a${n++}`, grants: grants as never }); return principals.authenticate((await principals.issueCredential(owner, `agent:a${n - 1}`)).token); },
        });
      } finally { await world.close(); }
    });

  suite("the alert is off by default and only the owner reads or sets it, with a revision check and replay safety", async ({ owner, settings, agent }) => {
    assert.deepEqual(await settings.effective(), { enabled: false, afterMinutes: 1440 });
    const g0 = await settings.get(owner);
    assert.deepEqual([g0.revision, g0.enabled, g0.afterMinutes], [0, false, null]);
    const ann = await agent([]);
    await assert.rejects(settings.get(ann), (e) => e instanceof DomainError && e.code === "forbidden");
    await assert.rejects(settings.set(ann, { commandId: cid("s"), enabled: true }), (e) => e instanceof DomainError && e.code === "forbidden");
    for (const bad of [{}, { enabled: "yes" }, { afterMinutes: 0 }, { afterMinutes: 525_601 }, { afterMinutes: 1.5 }, { enabled: true, extra: 1 }]) await assert.rejects(settings.set(owner, { commandId: cid("s"), ...bad } as never), (e) => e instanceof DomainError && e.code === "invalid_command", JSON.stringify(bad));
    const a = await settings.set(owner, { commandId: "same", enabled: true, afterMinutes: 30 });
    assert.equal((await settings.set(owner, { commandId: "same", enabled: true, afterMinutes: 30 })).revision, a.revision, "a replay does not apply twice");
    await assert.rejects(settings.set(owner, { commandId: cid("s"), enabled: false, expectedRevision: 0 }), (e) => e instanceof DomainError && e.code === "stale_revision");
    assert.deepEqual(await settings.effective(), { enabled: true, afterMinutes: 30 });
    await settings.set(owner, { commandId: cid("s"), enabled: false, expectedRevision: a.revision });
    assert.deepEqual(await settings.effective(), { enabled: false, afterMinutes: 30 }, "disabling keeps the period");
    await settings.set(owner, { commandId: cid("s"), afterMinutes: null });
    assert.deepEqual(await settings.effective(), { enabled: false, afterMinutes: 1440 }, "null goes back to the default");
  });

  suite("a responsibility with no holder, a stale or missing check, or no schedule is a gap; a held, freshly checked one is not; paused ones are not listed", async ({ owner, project, duties, coverage, principals, setNow, make, agent }) => {
    const ann = await agent([]);
    const covered = await make({ title: "covered", ownerId: ann.id });
    const noHolder = await make({ title: "no holder" });
    const unscheduled = await make({ title: "unscheduled", everyMinutes: undefined, ownerId: ann.id });
    const paused = await make({ title: "paused" });
    await duties.update(owner, { commandId: cid("u"), responsibilityId: paused, expectedRevision: (await duties.get(owner, paused))!.revision, state: "paused" } as never);
    setNow("2026-10-22T10:30:00.000Z");
    await duties.record(owner, { commandId: cid("c"), responsibilityId: covered, kind: "check", summary: "fine", outcome: "ok" });
    const first = (await coverage.report(owner, project))!;
    const by = new Map(first.items.map((g) => [g.responsibilityId, g]));
    assert.deepEqual([...by.keys()].sort(), [noHolder, unscheduled].sort(), "covered and paused are not listed");
    assert.deepEqual(by.get(noHolder)!.reasons, ["no-holder"]);
    assert.deepEqual(by.get(unscheduled)!.reasons, ["unscheduled"]);
    // The check goes stale after twice its period: never counted as covered for lack of news.
    setNow("2026-10-22T12:31:00.000Z");
    const stale = (await coverage.report(owner, project))!.items.find((g) => g.responsibilityId === covered)!;
    assert.deepEqual([stale.reasons, stale.since, stale.lapsedMinutes, stale.lastCheckAt], [["no-recent-check"], "2026-10-22T12:30:00.000Z", 1, "2026-10-22T10:30:00.000Z"]);
    // A holder who was disabled stops covering.
    setNow("2026-10-22T12:35:00.000Z");
    await duties.record(owner, { commandId: cid("c"), responsibilityId: covered, kind: "check", summary: "fine", outcome: "ok" });
    assert.ok(!(await coverage.report(owner, project))!.items.some((g) => g.responsibilityId === covered));
    await principals.disable(owner, { commandId: cid("d"), principalId: ann.id, expectedRevision: (await principals.get(ann.id))!.revision });
    const lost = (await coverage.report(owner, project))!.items.find((g) => g.responsibilityId === covered)!;
    assert.deepEqual(lost.reasons, ["no-holder"]);
    assert.equal(lost.holder, ann.id);
  });

  suite("the report is paged by ID with no overlap and a bound, and is readable only with responsibility.read", async ({ owner, project, coverage, make, agent }) => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await make({ title: `r${i}` }));
    const seen: string[] = [];
    let after: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = (await coverage.report(owner, project, { limit: 2, ...(after === undefined ? {} : { afterId: after }) }))!;
      assert.ok(page.items.length <= 2);
      seen.push(...page.items.map((g) => g.responsibilityId));
      if (page.next === undefined) break;
      after = page.next;
    }
    assert.deepEqual(seen, [...ids].sort());
    for (const limit of [0, 101, 1.5]) await assert.rejects(coverage.report(owner, project, { limit }), (e) => e instanceof DomainError && e.code === "invalid_command");
    assert.equal(await coverage.report(await agent([]), project), undefined, "an agent without responsibility.read learns nothing");
    assert.equal(await coverage.report(owner, "proj-aaaaaaaaaaaaaaaaaaaa"), undefined);
  });

  suite("lapsed lists only gaps beyond the period, only while the alert is on, with a stable ID per lapse; only owner, service or responsibility.write may ask", async ({ owner, project, settings, coverage, setNow, make, agent }) => {
    const r = await make({ title: "no holder" });
    setNow("2026-10-22T10:40:00.000Z");
    assert.deepEqual(await coverage.lapsed(owner, project), [], "off: nothing, whatever the gap");
    await settings.set(owner, { commandId: cid("s"), enabled: true, afterMinutes: 60 });
    assert.deepEqual(await coverage.lapsed(owner, project), [], "a lapse shorter than the period is not told");
    setNow("2026-10-22T11:05:00.000Z");
    const [g] = await coverage.lapsed(owner, project);
    assert.deepEqual([g!.responsibilityId, g!.reasons, g!.since], [r, ["no-holder"], T0]);
    setNow("2026-10-22T14:00:00.000Z");
    assert.equal((await coverage.lapsed(owner, project))[0]!.alertId, g!.alertId, "the same lapse keeps its ID however long it goes on");
    await assert.rejects(coverage.lapsed(await agent([]), project), (e) => e instanceof DomainError && e.code === "forbidden");
    await settings.set(owner, { commandId: cid("s"), enabled: false });
    assert.deepEqual(await coverage.lapsed(owner, project), [], "turned off again");
  });

}
