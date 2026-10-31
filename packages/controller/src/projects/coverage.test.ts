import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { commitOperation } from "../storage/commit.js";
import { CoverageService, CoverageSettingsService } from "./coverage.js";
import { ResponsibilityService } from "./index.js";

after(stopServer);

let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const T0 = "2026-10-22T10:00:00.000Z";

for (const backend of backends) {
  const suite = (name: string, body: (c: { owner: Principal; project: string; duties: ResponsibilityService; settings: CoverageSettingsService; coverage: CoverageService; principals: PrincipalService; setNow(iso: string): void; make(extra?: Record<string, unknown>): Promise<string>; agent(grants: unknown[]): Promise<Principal>; storage: any; projects: ProjectService; sweepWith(slice: number, reportExamine?: number): CoverageService }) => Promise<void>) =>
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
          setNow: (iso) => { now = iso; }, storage: world.storage, projects, sweepWith: (slice, reportExamine) => CoverageService.withEpoch(world.storage, projects.epoch, settings, { ...options, slice, ...(reportExamine === undefined ? {} : { reportExamine }) }),
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

  const dispatcher = { id: "service:dispatcher", kind: "service", name: "dispatcher", grants: [] } as unknown as Principal;

  suite("the start of a lapse is kept when first seen: an unrelated edit does not move it, the alert ID and the notice stay, a closed gap starts a new episode", async ({ owner, project, settings, coverage, duties, setNow, make, agent }) => {
    const r = await make({ title: "no holder", everyMinutes: 100_000 });
    setNow("2026-10-22T10:10:00.000Z");
    assert.deepEqual(await coverage.sweep(dispatcher), [], "off: nobody is told");
    // Edited later (the stored update time moves), the lapse still began when it was first seen.
    setNow("2026-10-22T10:50:00.000Z");
    await duties.update(owner, { commandId: cid("u"), responsibilityId: r, expectedRevision: (await duties.get(owner, r))!.revision, title: "no holder, renamed" } as never);
    const g = (await coverage.report(owner, project))!.items[0]!;
    assert.deepEqual([g.since, g.lapsedMinutes], [T0, 50], "the edit did not hide the lapse");
    await settings.set(owner, { commandId: cid("s"), enabled: true, afterMinutes: 60 });
    assert.deepEqual(await coverage.sweep(dispatcher), [], "50 minutes is shorter than the period");
    setNow("2026-10-22T11:05:00.000Z");
    const [n] = await coverage.sweep(dispatcher);
    assert.deepEqual([n!.count, n!.items.map((x) => x.responsibilityId), n!.covered], [1, [r], [r]]);
    // Not told yet (no markTold): the same notice comes again with the same ID, even after another edit.
    setNow("2026-10-22T13:00:00.000Z");
    await duties.update(owner, { commandId: cid("u"), responsibilityId: r, expectedRevision: (await duties.get(owner, r))!.revision, title: "renamed again" } as never);
    const [again] = await coverage.sweep(dispatcher);
    assert.equal(again!.alertId, n!.alertId);
    await coverage.markTold(dispatcher, again!);
    assert.deepEqual(await coverage.sweep(dispatcher), [], "told once");
    // The gap closes: a holder is given. Later it opens again: a new episode, told again.
    const ann = await agent([]);
    await duties.update(owner, { commandId: cid("u"), responsibilityId: r, expectedRevision: (await duties.get(owner, r))!.revision, ownerId: ann.id, everyMinutes: 100_000 } as never);
    assert.deepEqual(await coverage.sweep(dispatcher), []);
    assert.equal((await coverage.report(owner, project))!.items.length, 0);
    setNow("2026-10-23T09:00:00.000Z");
    await duties.update(owner, { commandId: cid("u"), responsibilityId: r, expectedRevision: (await duties.get(owner, r))!.revision, ownerId: null } as never);
    assert.deepEqual(await coverage.sweep(dispatcher), []);
    setNow("2026-10-23T10:30:00.000Z");
    const [second] = await coverage.sweep(dispatcher);
    assert.notEqual(second!.alertId, n!.alertId);
    assert.equal((await coverage.report(owner, project))!.items[0]!.since, "2026-10-23T09:00:00.000Z");
    // Only the dispatcher sweeps.
    await assert.rejects(coverage.sweep(owner), (e) => e instanceof DomainError && e.code === "forbidden");
    await assert.rejects(coverage.sweep(await agent([])), (e) => e instanceof DomainError && e.code === "forbidden");
    await assert.rejects(coverage.markTold(owner, second!), (e) => e instanceof DomainError && e.code === "forbidden");
  });

  suite("many lapses make one notice per project per period (a few named, the count of all), event-driven responsibilities are not unscheduled, and a project told within the period waits", async ({ owner, project, projects, settings, coverage, setNow, make, agent }) => {
    const ann = await agent([]);
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) ids.push(await make({ title: `duty ${i}`, everyMinutes: 100_000 }));
    const driven = await make({ title: "event driven", everyMinutes: undefined, eventSources: ["alerts"], ownerId: ann.id });
    const plain = await make({ title: "no schedule", everyMinutes: undefined, ownerId: ann.id });
    const late = await make({ title: "late", everyMinutes: 30, ownerId: ann.id });
    const other = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "Other" })).id;
    await settings.set(owner, { commandId: cid("s"), enabled: true, afterMinutes: 60 });
    setNow("2026-10-22T10:01:00.000Z");
    await coverage.sweep(dispatcher);
    setNow("2026-10-22T11:30:00.000Z");
    const first = await coverage.sweep(dispatcher);
    assert.equal(first.length, 1, "one notice for the project");
    assert.equal(first[0]!.count, 26, "25 without a holder and the one without a schedule; the one checked every 30 minutes is not late enough yet");
    assert.equal(first[0]!.items.length, 10, "a few named");
    assert.ok(!first[0]!.covered.includes(driven), "an event-driven responsibility has no schedule to miss");
    const rep = (await coverage.report(owner, project, { limit: 100 }))!;
    assert.ok(rep.items.some((g) => g.responsibilityId === plain), "the one without a schedule is a lapse the report shows");
    assert.ok(!rep.items.some((g) => g.responsibilityId === driven));
    await coverage.markTold(dispatcher, first[0]!);
    // A lapse that grows past the period inside the project's own period waits; after it, it is told.
    setNow("2026-10-22T12:00:00.000Z");
    assert.deepEqual(await coverage.sweep(dispatcher), [], "the project was told 30 minutes ago");
    setNow("2026-10-22T12:31:00.000Z");
    const next = await coverage.sweep(dispatcher);
    assert.deepEqual(next.map((x) => [x.projectId, x.count, x.covered[0]]), [[project, 27, late]], "the new lapse is named first and the count is the true total of the project's lapses");
    void other; void ids;
  });

  suite("the work per tick is bounded: the sweep takes one slice and a kept cursor goes round; a report stops at its bound and says where, however many records there are", async ({ owner, project, storage, settings, make, sweepWith }) => {
    for (let i = 0; i < 7; i++) await make({ title: `d${i}` });
    await settings.set(owner, { commandId: cid("s"), enabled: false });
    const sliced = sweepWith(3, 4);
    const kept = async (): Promise<number> => (await storage.listAggregates("coverage-lapse", { limit: 100 })).length;
    await sliced.sweep(dispatcher);
    assert.equal(await kept(), 3, "one slice per tick");
    await sliced.sweep(dispatcher);
    assert.equal(await kept(), 6);
    await sliced.sweep(dispatcher);
    assert.equal(await kept(), 7, "the third tick reaches the end");
    await sliced.sweep(dispatcher);
    assert.equal(await kept(), 7, "and then it starts over");
    // The report examines at most 4 records a call; the rest is asked for with next.
    const seen: string[] = [];
    let after: string | undefined;
    let partials = 0;
    for (let guard = 0; guard < 10; guard++) {
      const page = (await sliced.report(owner, project, { limit: 100, ...(after === undefined ? {} : { afterId: after }) }))!;
      seen.push(...page.items.map((g) => g.responsibilityId));
      if (page.partial) partials++;
      if (page.next === undefined) break;
      after = page.next;
    }
    assert.equal(seen.length, 7);
    assert.equal(new Set(seen).size, 7);
    assert.ok(partials >= 1, "a call that stopped at its bound said so");
  });

  suite("C1: a project whose lapses sit in several slices gets ONE notice with the true total when the lap completes, not one per slice per period", async ({ owner, project, settings, make, sweepWith, setNow }) => {
    for (let i = 0; i < 7; i++) await make({ title: `d${i}`, everyMinutes: 100_000 });
    await settings.set(owner, { commandId: cid("s"), enabled: true, afterMinutes: 60 });
    const sliced = sweepWith(3);
    setNow("2026-10-22T10:01:00.000Z");
    for (let i = 0; i < 3; i++) await sliced.sweep(dispatcher);
    setNow("2026-10-22T11:30:00.000Z");
    assert.deepEqual(await sliced.sweep(dispatcher), [], "the first slice of the lap: nothing yet, the rest of the project is still to be seen");
    assert.deepEqual(await sliced.sweep(dispatcher), []);
    const [n, ...more] = await sliced.sweep(dispatcher);
    assert.equal(more.length, 0);
    assert.equal(n!.count, 7, "the true total across all slices, not the 1 of the last slice");
    assert.equal(n!.items.length, 7);
    await sliced.markTold(dispatcher, n!);
    // The next laps find nothing new: no second notice within the period.
    for (let i = 0; i < 3; i++) assert.deepEqual(await sliced.sweep(dispatcher), []);
  });

  suite("C2: a new lapse after a notice is told at once (not before the hour is up), and a changed set of reasons is a new lapse", async ({ owner, project, settings, make, coverage, setNow, duties }) => {
    await make({ title: "old", everyMinutes: 100_000 });
    await settings.set(owner, { commandId: cid("s"), enabled: true, afterMinutes: 600 });
    setNow("2026-10-22T10:01:00.000Z");
    await coverage.sweep(dispatcher);
    setNow("2026-10-22T11:00:00.000Z");
    await make({ title: "new", everyMinutes: 100_000 });
    setNow("2026-10-22T20:30:00.000Z");
    const [first] = await coverage.sweep(dispatcher);
    assert.equal(first!.count, 1, "the new one is not beyond the 10-hour period yet");
    await coverage.markTold(dispatcher, first!);
    // The new one passes the period 40 minutes after the notice: it is not part of that notice, so it is told without waiting for the period to run out, but not inside the hour.
    setNow("2026-10-22T21:10:00.000Z");
    assert.deepEqual(await coverage.sweep(dispatcher), [], "40 minutes after the last notice: the hour has not passed");
    setNow("2026-10-22T21:35:00.000Z");
    const [second] = await coverage.sweep(dispatcher);
    assert.deepEqual([second!.count, second!.items[0]!.title], [2, "new"], "the new lapse is named first and the count is the total");
    await coverage.markTold(dispatcher, second!);
  });

  suite("C2: a told lapse whose set of reasons changes is a different lapse and is told again, not held by the project's period", async ({ owner, project, settings, make, coverage, setNow }) => {
    const r = await make({ title: "changing", everyMinutes: 330 });
    await settings.set(owner, { commandId: cid("s"), enabled: true, afterMinutes: 600 });
    setNow("2026-10-22T10:01:00.000Z");
    await coverage.sweep(dispatcher);
    setNow("2026-10-22T20:30:00.000Z");
    const [first] = await coverage.sweep(dispatcher);
    assert.equal(first!.count, 1);
    await coverage.markTold(dispatcher, first!);
    assert.deepEqual(await coverage.sweep(dispatcher), [], "told once");
    // At 21:00 the check schedule also lapsed (two periods of 330 minutes after the start): the lapse now has two reasons.
    setNow("2026-10-22T21:35:00.000Z");
    const [second] = await coverage.sweep(dispatcher);
    assert.deepEqual(second!.items.map((x) => [x.responsibilityId, x.reasons]), [[r, ["no-holder", "no-recent-check"]]]);
    assert.notEqual(second!.alertId, first!.alertId);
    assert.equal((await coverage.report(owner, project))!.items[0]!.since, "2026-10-22T10:00:00.000Z", "the lapse still began when it was first seen");
  });

  suite("C3: a check recorded between two visits closes the gap: the lapse that is open again starts after that check", async ({ owner, project, duties, coverage, setNow, make, agent }) => {
    const ann = await agent([]);
    const r = await make({ title: "checked", ownerId: ann.id, everyMinutes: 60 });
    setNow("2026-10-22T12:30:00.000Z");
    await coverage.sweep(dispatcher);
    assert.equal((await coverage.report(owner, project))!.items[0]!.since, "2026-10-22T12:00:00.000Z");
    // Checked at 13:00 (the gap closed), stale again from 15:00; the sweep did not visit in between.
    setNow("2026-10-22T13:00:00.000Z");
    await duties.record(owner, { commandId: cid("c"), responsibilityId: r, kind: "check", summary: "fine", outcome: "ok" });
    setNow("2026-10-22T16:00:00.000Z");
    await coverage.sweep(dispatcher);
    const g = (await coverage.report(owner, project))!.items[0]!;
    assert.deepEqual([g.since, g.lapsedMinutes], ["2026-10-22T15:00:00.000Z", 60], "the old first-seen time did not hide the closure");
  });

  suite("C4: bookkeeping of paused, retired and deleted responsibilities and of archived projects is removed, a bounded number a tick", async ({ owner, project, projects, storage, duties, setNow, make, settings, coverage }) => {
    await settings.set(owner, { commandId: cid("s"), enabled: true, afterMinutes: 60 });
    const a = await make({ title: "a", everyMinutes: 100_000 });
    const b = await make({ title: "b", everyMinutes: 100_000 });
    setNow("2026-10-22T11:30:00.000Z");
    await coverage.sweep(dispatcher);
    const kept = async (): Promise<string[]> => (await storage.listAggregates("coverage-lapse", { limit: 100 })).map((x: { id: string }) => x.id).sort();
    assert.deepEqual(await kept(), [a, b].sort());
    await duties.update(owner, { commandId: cid("u"), responsibilityId: a, expectedRevision: (await duties.get(owner, a))!.revision, state: "paused" } as never);
    await coverage.sweep(dispatcher);
    assert.deepEqual(await kept(), [b], "a paused responsibility is not expected to be covered: its record goes");
    // An orphan record (the responsibility is gone) is removed by the tidy-up, and so is the record of a project that is gone.
    const write = async (kind: string, id: string, body: object): Promise<void> => { await commitOperation(storage, { operationId: `cmd:fx-${kind}-${id}`, epoch: projects.epoch, actor: "fixture", correlationId: `fx-${id}`, at: "2026-10-22T11:30:00.000Z", changes: [{ type: "create", ref: { kind, id }, body: body as never }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] }, { attempts: 3, pause: async () => undefined }); };
    await write("coverage-lapse", "rsp-zzzzzzzzzzzzzzzzzzzz", { projectId: project, seen: { "no-holder": "2026-10-22T10:00:00.000Z" } });
    await write("coverage-project", "proj-zzzzzzzzzzzzzzzzzzzz", { lap: { startedAt: "2026-10-22T10:00:00.000Z", count: 0, untold: 0, items: [] } });
    await coverage.sweep(dispatcher);
    assert.deepEqual(await kept(), [b], "the orphan lapse record is gone");
    assert.equal(await storage.getAggregate({ kind: "coverage-project", id: "proj-zzzzzzzzzzzzzzzzzzzz" }), undefined, "the record of a project that is gone is removed");
    assert.ok(await storage.getAggregate({ kind: "coverage-project", id: project }) !== undefined, "the project that exists keeps its record");
  });

  suite("C5: a report that stops exactly at its bound with nothing left does not say partial; a partial page may have no items and the caller goes on from next", async ({ owner, project, make, sweepWith }) => {
    for (let i = 0; i < 4; i++) await make({ title: `d${i}` });
    const exact = sweepWith(200, 4);
    const page = (await exact.report(owner, project, { limit: 100 }))!;
    assert.equal(page.items.length, 4);
    assert.equal(page.partial, undefined, "the bound was reached exactly at the end: nothing is left, so not partial");
    assert.equal(page.next, undefined);
    await make({ title: "fifth" });
    const cut = (await exact.report(owner, project, { limit: 100 }))!;
    assert.equal(cut.partial, true);
    const rest = (await exact.report(owner, project, { limit: 100, afterId: cut.next! }))!;
    assert.equal(rest.items.length, 1);
    assert.equal(rest.partial, undefined);
  });

  suite("a damaged setting is reported as damaged, not off", async ({ owner, project, storage, make, coverage }) => {
    await make({ title: "x" });
    assert.equal((await coverage.report(owner, project))!.alert.status, "off");
    const rec = await storage.getAggregate({ kind: "coverage-settings", id: "main" });
    assert.equal(rec, undefined);
    const real = storage.getAggregate.bind(storage);
    storage.getAggregate = async (ref: { kind: string; id: string }) => { const a = await real(ref); return ref.kind === "coverage-settings" ? { kind: ref.kind, id: ref.id, revision: 1, body: { enabled: "maybe" }, createdAt: T0, updatedAt: T0 } : a; };
    try {
      assert.equal((await coverage.report(owner, project))!.alert.status, "damaged");
      await assert.rejects(coverage.sweep(dispatcher), (e) => e instanceof DomainError && e.code === "unavailable");
    } finally { storage.getAggregate = real; }
  });

}
