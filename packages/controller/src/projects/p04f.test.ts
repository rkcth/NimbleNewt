import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AssignmentService } from "../domain/assignments.js";
import { DomainError } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { EventService } from "../events/index.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { CheckRunService, CheckRunSettingsService, CoverageGapService, IncidentService, ResponsibilityChecks, ResponsibilityEventChecks, ResponsibilityService, type CheckProbe, type EventCheckDeps } from "./index.js";

after(stopServer);

let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const T0 = "2026-11-12T10:00:00.000Z";
const code = async (p: Promise<unknown>): Promise<string> => p.then(() => "ok", (e: unknown) => (e instanceof DomainError ? e.code : String(e)));
const iso = (base: string, minutes: number): string => new Date(Date.parse(base) + minutes * 60_000).toISOString();

for (const backend of backends) {
  interface World {
    owner: Principal; ann: Principal; project: string; setNow(iso: string): void;
    projects: ProjectService; duties: ResponsibilityService; checks: ResponsibilityChecks; inc: IncidentService; events: EventService; gaps: CoverageGapService; settings: CheckRunSettingsService;
    store: { readonly storage: { listAggregates(kind: string, o: { limit: number }): Promise<{ id: string; body: any }[]> } };
    runner(extra?: { probe?: CheckProbe; checks?: Partial<Pick<ResponsibilityChecks, "noteRun">> }): CheckRunService;
    eventChecks(batch?: number): ResponsibilityEventChecks;
    eventChecksWith(over: Partial<EventCheckDeps>): ResponsibilityEventChecks;
    again(): { gaps: CoverageGapService; eventChecks: ResponsibilityEventChecks; runner: CheckRunService };
    make(extra?: Record<string, unknown>): Promise<string>;
    publish(kind: string, source?: { id: string; seq: number }): Promise<void>;
    taskCount(): Promise<number>;
  }
  const suite = (name: string, body: (c: World) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      let now = T0;
      const options = { clock: () => now, pause: async () => undefined };
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const epoch = projects.epoch;
        const principals = PrincipalService.withEpoch(world.storage, epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const assignments = AssignmentService.withEpoch(world.storage, epoch, projects, options);
        const duties = ResponsibilityService.withEpoch(world.storage, epoch, options);
        const checks = ResponsibilityChecks.withEpoch(world.storage, epoch, duties, options);
        const inc = IncidentService.withEpoch(world.storage, epoch, duties, options);
        const events = EventService.withEpoch(world.storage, epoch, options);
        const gaps = CoverageGapService.withEpoch(world.storage, epoch, options);
        const settings = CheckRunSettingsService.withEpoch(world.storage, epoch, options);
        const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "Ops" })).id;
        await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "ann", grants: [{ action: "responsibility.read", project }] as never });
        const ann = await principals.authenticate((await principals.issueCredential(owner, "agent:ann")).token);
        const mkRunner = (probe?: CheckProbe, noteRun?: ResponsibilityChecks["noteRun"]): CheckRunService => CheckRunService.withEpoch(world.storage, epoch, { responsibilities: duties, checks: noteRun === undefined ? checks : { pending: (b: Principal, p: string) => checks.pending(b, p), noteRun } as never, incidents: inc, settings, projects, assignments, ...(probe === undefined ? {} : { probe }) }, options);
        const mkEvents = (batch?: number, g: CoverageGapService = gaps): ResponsibilityEventChecks => ResponsibilityEventChecks.withEpoch(world.storage, epoch, { responsibilities: duties, checks, events, gaps: g, ...(batch === undefined ? {} : { batch }) }, options);
        let ev = 0;
        await body({
          owner, ann, project, projects, duties, checks, inc, events, gaps, settings, store: { storage: world.storage as never },
          setNow: (t) => { now = t; },
          runner: (extra = {}) => mkRunner(extra.probe, extra.checks?.noteRun as never),
          eventChecks: (batch) => mkEvents(batch),
          eventChecksWith: (over) => ResponsibilityEventChecks.withEpoch(world.storage, epoch, { responsibilities: duties, checks, events, gaps, ...over }, options),
          again: () => { const d = ResponsibilityService.withEpoch(world.storage, epoch, options); const c = ResponsibilityChecks.withEpoch(world.storage, epoch, d, options); const g = CoverageGapService.withEpoch(world.storage, epoch, options); return { gaps: g, eventChecks: ResponsibilityEventChecks.withEpoch(world.storage, epoch, { responsibilities: d, checks: c, events: EventService.withEpoch(world.storage, epoch, options), gaps: g }, options), runner: CheckRunService.withEpoch(world.storage, epoch, { responsibilities: d, checks: c, incidents: IncidentService.withEpoch(world.storage, epoch, d, options), settings: CheckRunSettingsService.withEpoch(world.storage, epoch, options), projects, assignments }, options) }; },
          make: async (extra = {}) => (await duties.create(owner, { commandId: cid("r"), projectId: project, title: "Keep the server healthy", objective: "Up", desiredCondition: "answers on /health", everyMinutes: 60, ownerId: ann.id, permittedActions: ["service.restart"], ...extra } as never)).id,
          publish: async (kind, source) => { await events.publish(owner, { commandId: cid("ev"), stream: `project:${project}`, kind, ref: { kind: "service", id: "web" }, key: cid("k"), ...(source === undefined ? {} : { source }) } as never); },
          taskCount: async () => (await world.storage.listAggregates("task", { limit: 500 })).length,
        });
      } finally { await world.close(); }
    });

  // ---- coverage gaps ---------------------------------------------------------------------------------------------------------

  suite("a gap opens once, lasts until closed, and a new one opens when the same thing stops again; readers see installation gaps and their own project's only", async (c) => {
    assert.equal(await c.gaps.open(c.owner, { key: "provider:model:m1", reason: "provider-outage", start: T0, detail: "model m1 was unavailable" }), true);
    assert.equal(await c.gaps.open(c.owner, { key: "provider:model:m1", reason: "provider-outage", start: iso(T0, 5), detail: "again" }), false, "still the same gap");
    c.setNow(iso(T0, 30));
    const open = (await c.gaps.list(c.owner, c.project, { open: true }))!;
    assert.deepEqual(open.items.map((g) => [g.reason, g.start, g.end, g.open, g.scope]), [["provider-outage", T0, undefined, true, "installation"]]);
    assert.equal(await c.gaps.close(c.owner, { key: "provider:model:m1", end: iso(T0, 30) }), true);
    assert.equal(await c.gaps.close(c.owner, { key: "provider:model:m1", end: iso(T0, 31) }), false, "nothing open to close");
    assert.equal(await c.gaps.close(c.owner, { key: "never-opened", end: iso(T0, 31) }), false);
    assert.equal(await c.gaps.open(c.owner, { key: "provider:model:m1", reason: "provider-outage", start: iso(T0, 60), detail: "down again" }), true);
    const all = (await c.gaps.list(c.owner, c.project))!.items;
    assert.deepEqual(all.map((g) => [g.start, g.end ?? null]), [[iso(T0, 60), null], [T0, iso(T0, 30)]], "open first, then newest");
    // Project-scoped gaps are only that project's.
    const other = (await c.projects.createProject({ commandId: cid("p"), actor: c.owner.id, name: "Other" })).id;
    await c.gaps.record(c.owner, { key: "events:x", reason: "events-missed", start: T0, end: iso(T0, 10), scope: c.project, detail: "cut" });
    assert.equal((await c.gaps.list(c.owner, c.project))!.items.length, 3);
    assert.equal((await c.gaps.list(c.owner, other))!.items.length, 2, "the other project sees the installation gaps, not this project's");
    // An agent without the right to read the project's responsibilities sees nothing; one with it sees them; nobody but the controller writes.
    assert.equal(await c.gaps.list(c.ann, other), undefined);
    assert.equal((await c.gaps.list(c.ann, c.project))!.items.length, 3);
    assert.equal(await code(c.gaps.open(c.ann, { key: "k", reason: "provider-outage", start: T0, detail: "x" })), "forbidden");
    assert.equal(await code(c.gaps.open(c.owner, { key: "k", reason: "nonsense" as never, start: T0, detail: "x" })), "invalid_command");
    assert.equal(await code(c.gaps.record(c.owner, { key: "k", reason: "events-missed", start: iso(T0, 5), end: T0, detail: "x" })), "invalid_command", "an end before the start");
  });

  suite("a restart after a long absence records a controller-down gap from the last time it was seen, once; a short one records none; old closed gaps are removed", async (c) => {
    assert.deepEqual(await c.gaps.heartbeat(c.owner, { startup: true }), {}, "the very first start has no earlier time to compare with");
    c.setNow(iso(T0, 3));
    assert.deepEqual(await c.again().gaps.heartbeat(c.owner, { startup: true }), {}, "back within five minutes: not a gap");
    c.setNow(iso(T0, 3 + 90));
    const back = await c.again().gaps.heartbeat(c.owner, { startup: true });
    assert.deepEqual(back, { downtime: { start: iso(T0, 3), end: iso(T0, 93) } });
    assert.deepEqual(await c.again().gaps.heartbeat(c.owner, { startup: true }), {}, "the time was moved on, so the same absence is not recorded twice");
    const listed = (await c.gaps.list(c.owner, c.project))!.items;
    assert.deepEqual(listed.map((g) => [g.reason, g.start, g.end, g.open]), [["controller-down", iso(T0, 3), iso(T0, 93), false]]);
    // A tick without startup only keeps the time (once a minute) and never makes a gap.
    c.setNow(iso(T0, 93 + 600));
    assert.deepEqual(await c.gaps.heartbeat(c.owner), {});
    assert.equal((await c.gaps.list(c.owner, c.project))!.items.length, 1);
    // Closed gaps past 180 days go; an open one stays however old.
    await c.gaps.open(c.owner, { key: "source:files", reason: "event-source-outage", start: T0, detail: "unreadable" });
    c.setNow(iso(T0, 181 * 24 * 60));
    await c.gaps.heartbeat(c.owner);
    assert.deepEqual((await c.gaps.list(c.owner, c.project))!.items.map((g) => g.reason), ["event-source-outage"]);
    assert.deepEqual((await c.gaps.covering(c.owner, c.project, T0, iso(T0, 10))).map((g) => g.reason), ["event-source-outage"], "an open gap covers any later time");
  });

  // ---- event-driven checks ---------------------------------------------------------------------------------------------------

  suite("events that name a responsibility's source wake it: one check for the events of one look, none for others, none twice", async (c) => {
    const r = await c.make({ eventSources: ["svc-health", "disk.full"], everyMinutes: undefined });
    const other = await c.make({ title: "Backups", eventSources: ["backup-runner"], everyMinutes: undefined });
    await c.publish("service.failed", { id: "svc-health", seq: 1 });
    await c.publish("service.failed", { id: "svc-health", seq: 2 });
    await c.publish("disk.full");
    await c.publish("unrelated.thing", { id: "other-source", seq: 1 });
    c.setNow(iso(T0, 2));
    assert.deepEqual(await c.eventChecks().sweep(c.owner, c.project), { recorded: 1, more: false });
    const pending = (await c.checks.pending(c.owner, c.project))!;
    assert.deepEqual(pending.map((p) => [p.responsibilityId, p.trigger?.source, p.trigger?.events, p.trigger?.firstSeq, p.trigger?.lastSeq, p.trigger?.kinds]), [[r, "svc-health", 3, 1, 3, ["service.failed", "disk.full"]]]);
    assert.ok(!pending.some((p) => p.responsibilityId === other));
    assert.deepEqual(await c.eventChecks().sweep(c.owner, c.project), { recorded: 0, more: false }, "the same events are not looked at again");
    assert.equal(await c.again().eventChecks.sweep(c.owner, c.project).then((x) => x.recorded), 0, "nor after a restart");
    assert.equal(await c.eventChecks().position(c.owner, r), 5);
    await c.publish("service.failed", { id: "svc-health", seq: 3 });
    assert.equal((await c.eventChecks().sweep(c.owner, c.project)).recorded, 1, "a later event owes a later check");
    assert.equal((await c.checks.pending(c.owner, c.project))!.length, 2);
    // Events from before the responsibility existed are not owed to it.
    c.setNow(iso(T0, 10));
    const late = await c.make({ title: "Late", eventSources: ["svc-health"], everyMinutes: undefined });
    await c.eventChecks().sweep(c.owner, c.project);
    assert.ok(!(await c.checks.pending(c.owner, c.project))!.some((p) => p.responsibilityId === late));
  });

  suite("events recorded while the controller was down are read on return and give their one check; a pause keeps them queued; a cut by retention is recorded as a gap", async (c) => {
    const r = await c.make({ eventSources: ["svc-health"], everyMinutes: undefined });
    await c.eventChecks().sweep(c.owner, c.project);
    // The controller is down: events arrive, nobody sweeps. On return one look reads them all.
    for (let i = 1; i <= 3; i++) await c.publish("service.failed", { id: "svc-health", seq: i });
    c.setNow(iso(T0, 240));
    const back = c.again();
    assert.equal((await back.eventChecks.sweep(c.owner, c.project)).recorded, 1);
    assert.deepEqual((await c.checks.pending(c.owner, c.project))!.map((p) => [p.trigger?.events, p.slotStart]), [[3, T0]]);
    assert.equal((await back.eventChecks.sweep(c.owner, c.project)).recorded, 0);
    // Paused: the position does not move, so what arrives meanwhile is looked at when it is active again.
    const rev = (await c.duties.get(c.owner, r))!.revision;
    await c.duties.update(c.owner, { commandId: cid("u"), responsibilityId: r, expectedRevision: rev, state: "paused" } as never);
    await c.publish("service.failed", { id: "svc-health", seq: 4 });
    const held = await c.eventChecks().position(c.owner, r);
    await c.eventChecks().sweep(c.owner, c.project);
    assert.equal(await c.eventChecks().position(c.owner, r), held, "a paused responsibility's position stays");
    await c.duties.update(c.owner, { commandId: cid("u"), responsibilityId: r, expectedRevision: (await c.duties.get(c.owner, r))!.revision, state: "active" } as never);
    assert.equal((await c.eventChecks().sweep(c.owner, c.project)).recorded, 1, "after the pause the queued event owes its check");
    // Retention cuts events the position had not reached: a closed gap says so, and the look goes on from what is kept.
    await c.publish("service.failed", { id: "svc-health", seq: 5 });
    await c.publish("service.failed", { id: "svc-health", seq: 6 });
    await c.events.setFloor(c.owner, { commandId: cid("f"), stream: `project:${c.project}`, floor: 7 } as never);
    c.setNow(iso(T0, 300));
    await c.eventChecks().sweep(c.owner, c.project);
    const gap = (await c.gaps.list(c.owner, c.project))!.items.filter((g) => g.reason === "events-missed");
    assert.equal(gap.length, 1);
    assert.equal(gap[0]!.end, iso(T0, 300));
    assert.equal(gap[0]!.scope, c.project);
    assert.equal(await c.eventChecks().position(c.owner, r), 7, "it went on from the kept events");
  });

  suite("a look reads a bounded batch and says more is waiting; nothing is skipped", async (c) => {
    const r = await c.make({ eventSources: ["svc-health"], everyMinutes: undefined });
    await c.eventChecks().sweep(c.owner, c.project);
    for (let i = 1; i <= 5; i++) await c.publish("service.failed", { id: "svc-health", seq: i });
    c.setNow(iso(T0, 1));
    assert.deepEqual(await c.eventChecks(2).sweep(c.owner, c.project), { recorded: 1, more: true });
    assert.deepEqual(await c.eventChecks(2).sweep(c.owner, c.project), { recorded: 1, more: true });
    assert.deepEqual(await c.eventChecks(2).sweep(c.owner, c.project), { recorded: 1, more: false });
    assert.deepEqual((await c.checks.pending(c.owner, c.project))!.map((p) => [p.trigger!.firstSeq, p.trigger!.lastSeq]).sort((a, b) => a[0]! - b[0]!), [[1, 2], [3, 4], [5, 5]]);
    assert.equal(await c.eventChecks().position(c.owner, r), 6);
    assert.equal(await code(c.eventChecks().sweep(c.ann, c.project)), "forbidden", "an agent without the write right may not sweep");
  });

  // ---- taking a due check ----------------------------------------------------------------------------------------------------

  suite("a due check with no probe becomes one bounded task for the answerable agent, once; it stays owed until the agent records a check entry", async (c) => {
    const r = await c.make({ maintenanceWindows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "11:00", end: "12:00" }], managed: [] });
    c.setNow(iso(T0, 60));
    await c.checks.generate(c.owner, c.project);
    assert.deepEqual(await c.runner().run(c.owner, c.project), { observed: 0, tasks: 1, coalesced: 0, noAgent: 0, deferred: 0 });
    assert.deepEqual(await c.runner().run(c.owner, c.project), { observed: 0, tasks: 0, coalesced: 0, noAgent: 0, deferred: 0 }, "a second pass makes nothing new");
    assert.deepEqual(await c.again().runner.run(c.owner, c.project), { observed: 0, tasks: 0, coalesced: 0, noAgent: 0, deferred: 0 }, "nor another instance after a restart");
    const [check] = (await c.checks.pending(c.owner, c.project))!;
    assert.equal(check!.run?.how, "task", "still owed");
    const tasks = await c.store.storage.listAggregates("task", { limit: 50 });
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.id, check!.run!.taskId);
    assert.equal(tasks[0]!.body.state, "ready");
    assert.match(tasks[0]!.body.title, /^Check: Keep the server healthy/);
    assert.match(tasks[0]!.body.description, /answers on \/health/);
    assert.match(tasks[0]!.body.description, /service\.restart/);
    assert.match(tasks[0]!.body.description, /hold any change until it ends/, "the maintenance window holds actions");
    const assignment = await c.store.storage.listAggregates("assignment", { limit: 50 });
    assert.deepEqual(assignment.map((a) => a.body.owner), [{ kind: "agent", id: "ann" }]);
    const history = (await c.duties.history(c.owner, r, { limit: 20 }))!.items;
    assert.deepEqual(history.map((h) => [h.kind, h.taskId]), [["note", check!.run!.taskId]], "the history says the task was opened and links it");
    // The agent's own check entry finishes it.
    c.setNow(iso(T0, 70));
    await c.duties.record(c.owner, { commandId: cid("c"), responsibilityId: r, kind: "check", summary: "fine", outcome: "ok" });
    assert.deepEqual(await c.checks.pending(c.owner, c.project), []);
  });

  suite("a crash between the task and the note finishes the same task on the next pass, never a second", async (c) => {
    await c.make({ managed: [] });
    c.setNow(iso(T0, 60));
    await c.checks.generate(c.owner, c.project);
    let boom = true;
    const flaky = c.runner({ checks: { noteRun: async (by, id, run) => { if (boom) { boom = false; throw new Error("storage busy"); } return c.checks.noteRun(by, id, run); } } });
    await assert.rejects(() => flaky.run(c.owner, c.project), /storage busy/);
    assert.equal(await c.taskCount(), 1);
    assert.equal((await c.runner().run(c.owner, c.project)).tasks, 1, "the pass that finishes the job counts the task");
    assert.equal(await c.taskCount(), 1, "the same task, not another");
    assert.equal((await c.store.storage.listAggregates("assignment", { limit: 50 })).length, 1);
    const notes = (await c.duties.history(c.owner, (await c.checks.pending(c.owner, c.project))![0]!.responsibilityId, { limit: 20 }))!.items.filter((h) => h.kind === "note");
    assert.equal(notes.length, 1, "one note, not two");
  });

  suite("an event check rides on the open task; a task that ends with no check entry is tried again after a wait, at most three times, then recorded as not taken", async (c) => {
    const r = await c.make({ managed: [], eventSources: ["svc-health"] });
    await c.eventChecks().sweep(c.owner, c.project);
    c.setNow(iso(T0, 60)); await c.checks.generate(c.owner, c.project); await c.runner().run(c.owner, c.project);
    await c.publish("service.failed", { id: "svc-health", seq: 1 });
    c.setNow(iso(T0, 61)); await c.eventChecks().sweep(c.owner, c.project);
    assert.deepEqual(await c.runner().run(c.owner, c.project), { observed: 0, tasks: 0, coalesced: 1, noAgent: 0, deferred: 0 });
    assert.equal(await c.taskCount(), 1);
    const pending = (await c.checks.pending(c.owner, c.project))!;
    assert.deepEqual(pending.map((p) => p.run?.how).sort(), ["coalesced", "task"]);
    const taskId = pending.find((p) => p.run?.how === "task")!.run!.taskId!;
    assert.equal(pending.find((p) => p.run?.how === "coalesced")!.run!.taskId, taskId);
    // The task is cancelled with nothing recorded: the checks stay owed (not healthy). Nothing is retried at once; after a wait a fresh task opens.
    await c.projects.transitionTask({ commandId: cid("t"), actor: c.owner.id, taskId, expectedRevision: (await c.projects.getTask(taskId))!.revision, to: "cancelled" });
    assert.deepEqual(await c.runner().run(c.owner, c.project), { observed: 0, tasks: 0, coalesced: 0, noAgent: 0, deferred: 0 }, "not retried in the same breath");
    c.setNow(iso(T0, 125));
    assert.equal((await c.runner().run(c.owner, c.project)).tasks, 1, "after the wait the first check gets a second task; the other rides on it");
    assert.equal(await c.taskCount(), 2);
    assert.equal((await c.runner().run(c.owner, c.project)).tasks, 0);
    assert.equal((await c.checks.pending(c.owner, c.project))!.length, 2, "nothing was observed, so every check is still owed");
    const cancelOpen = async (): Promise<void> => { for (const t of await c.store.storage.listAggregates("task", { limit: 50 })) if (t.body.state === "ready") await c.projects.transitionTask({ commandId: cid("t"), actor: c.owner.id, taskId: t.id, expectedRevision: (await c.projects.getTask(t.id))!.revision, to: "cancelled" }); };
    await cancelOpen(); c.setNow(iso(T0, 190));
    assert.equal((await c.runner().run(c.owner, c.project)).tasks, 1, "a third try");
    assert.equal(await c.taskCount(), 3);
    await cancelOpen(); c.setNow(iso(T0, 260));
    const last = await c.runner().run(c.owner, c.project);
    assert.equal(last.tasks, 0, "no fourth task");
    assert.equal(last.noAgent, 1, "one check entry says it was not taken, and it finishes both");
    assert.equal(await c.taskCount(), 3);
    assert.deepEqual(await c.checks.pending(c.owner, c.project), [], "a recorded (attention) check entry finishes them");
    assert.deepEqual((await c.duties.history(c.owner, r, { limit: 30 }))!.items.filter((h) => h.kind === "check").map((h) => h.outcome), ["attention"]);
    assert.equal((await c.inc.list(c.owner, c.project, { open: true }))!.length, 1);
  });

  suite("a deterministic probe takes the check with no agent: its result is a history entry, a bad one is one grouped incident", async (c) => {
    const r = await c.make({ managed: [] });
    let result: "ok" | "failed" = "ok";
    const probe: CheckProbe = async () => ({ outcome: result, summary: result === "ok" ? "health answered 200" : "health answered 500" });
    c.setNow(iso(T0, 60)); await c.checks.generate(c.owner, c.project);
    assert.deepEqual(await c.runner({ probe }).run(c.owner, c.project), { observed: 1, tasks: 0, coalesced: 0, noAgent: 0, deferred: 0 });
    assert.equal(await c.taskCount(), 0, "no agent was asked");
    assert.deepEqual(await c.checks.pending(c.owner, c.project), [], "a recorded observation finishes the check");
    assert.deepEqual((await c.duties.history(c.owner, r, { limit: 10 }))!.items.map((h) => [h.kind, h.outcome, h.summary]), [["check", "ok", "health answered 200"]]);
    result = "failed";
    for (const m of [120, 180]) { c.setNow(iso(T0, m)); await c.checks.generate(c.owner, c.project); await c.runner({ probe }).run(c.owner, c.project); }
    const incidents = (await c.inc.list(c.owner, c.project, { open: true }))!;
    assert.deepEqual(incidents.map((i) => [i.signature, i.count, i.worst]), [["scheduled-check", 2, "failed"]], "repeated failures group into one incident");
    assert.equal((await c.inc.observed(c.owner, r))!.observed, "failed");
    // A probe that has nothing to say leaves the check to the agent.
    c.setNow(iso(T0, 240)); await c.checks.generate(c.owner, c.project);
    assert.equal((await c.runner({ probe: async () => undefined }).run(c.owner, c.project)).tasks, 1);
  });

  suite("a responsibility nobody answers for is recorded as not taken (attention), never healthy and never a task", async (c) => {
    const r = await c.make({ ownerId: undefined, managed: [] });
    c.setNow(iso(T0, 60)); await c.checks.generate(c.owner, c.project);
    assert.deepEqual(await c.runner().run(c.owner, c.project), { observed: 0, tasks: 0, coalesced: 0, noAgent: 1, deferred: 0 });
    assert.equal(await c.taskCount(), 0);
    assert.deepEqual((await c.duties.history(c.owner, r, { limit: 10 }))!.items.map((h) => [h.kind, h.outcome]), [["check", "attention"]]);
    assert.equal((await c.inc.list(c.owner, c.project, { open: true }))!.length, 1);
    assert.notEqual((await c.inc.observed(c.owner, r))!.observed, "ok");
  });

  suite("the owner's setting: off leaves checks owed and starts nothing, and the most open check tasks per project is a bound", async (c) => {
    const a = await c.make({ title: "A", managed: [] });
    const b = await c.make({ title: "B", managed: [] });
    c.setNow(iso(T0, 60)); await c.checks.generate(c.owner, c.project);
    assert.deepEqual(await c.settings.get(c.owner).then((s) => [s.revision, s.effective]), [0, { enabled: true, maxOpen: 5 }]);
    const set = await c.settings.set(c.owner, { commandId: cid("s"), enabled: false } as never);
    assert.equal(set.revision, 1);
    assert.deepEqual(await c.runner().run(c.owner, c.project), { observed: 0, tasks: 0, coalesced: 0, noAgent: 0, deferred: 2 });
    assert.equal(await c.taskCount(), 0);
    assert.equal((await c.checks.pending(c.owner, c.project))!.length, 2, "still owed, so still shown as not observed");
    await c.settings.set(c.owner, { commandId: cid("s"), enabled: true, maxOpen: 1, expectedRevision: 1 } as never);
    assert.deepEqual(await c.runner().run(c.owner, c.project), { observed: 0, tasks: 1, coalesced: 0, noAgent: 0, deferred: 1 }, "one task, the other waits for room");
    assert.equal(await c.taskCount(), 1);
    await c.settings.set(c.owner, { commandId: cid("s"), maxOpen: null } as never);
    assert.deepEqual(await c.runner().run(c.owner, c.project), { observed: 0, tasks: 1, coalesced: 0, noAgent: 0, deferred: 0 });
    assert.deepEqual((await c.settings.get(c.owner)).effective, { enabled: true, maxOpen: 5 });
    assert.ok(a !== b);
    // Who may change it, and what.
    assert.equal(await code(c.settings.set(c.ann, { commandId: cid("s"), enabled: false } as never)), "forbidden");
    assert.equal(await code(c.settings.get(c.ann)), "forbidden");
    for (const bad of [{}, { maxOpen: 0 }, { maxOpen: 51 }, { maxOpen: 1.5 }, { enabled: "yes" }, { other: 1, enabled: true }]) assert.equal(await code(c.settings.set(c.owner, { commandId: cid("s"), ...bad } as never)), "invalid_command", JSON.stringify(bad));
    assert.equal(await code(c.settings.set(c.owner, { commandId: cid("s"), enabled: true, expectedRevision: 99 } as never)), "stale_revision");
  });

  suite("a paused responsibility's checks wait untouched; an event check says what woke it in the task", async (c) => {
    const r = await c.make({ managed: [], eventSources: ["svc-health"] });
    await c.eventChecks().sweep(c.owner, c.project);
    c.setNow(iso(T0, 1));
    await c.publish("service.failed", { id: "svc-health", seq: 1 });
    c.setNow(iso(T0, 2));
    await c.eventChecks().sweep(c.owner, c.project);
    const rev = (await c.duties.get(c.owner, r))!.revision;
    await c.duties.update(c.owner, { commandId: cid("u"), responsibilityId: r, expectedRevision: rev, state: "paused" } as never);
    assert.equal((await c.runner().run(c.owner, c.project)).tasks, 0, "paused: nothing is started, the queue stays");
    assert.equal((await c.checks.pending(c.owner, c.project))!.length, 1);
    await c.duties.update(c.owner, { commandId: cid("u"), responsibilityId: r, expectedRevision: (await c.duties.get(c.owner, r))!.revision, state: "active" } as never);
    assert.equal((await c.runner().run(c.owner, c.project)).tasks, 1);
    const task = (await c.store.storage.listAggregates("task", { limit: 5 }))[0]!.body as unknown as { description: string };
    assert.match(task.description, /1 event from svc-health \(service\.failed\)/);
  });

  // ---- review (P04f): crash safety, bounded reads, clock changes -------------------------------------------------------------

  suite("review: a look repeated after a crash between the check and the saved position is the same check, even when more events came in meanwhile; two instances at once make one", async (c) => {
    await c.make({ eventSources: ["svc-health"], everyMinutes: undefined });
    await c.eventChecks().sweep(c.owner, c.project);
    await c.publish("service.failed", { id: "svc-health", seq: 1 });
    await c.publish("service.failed", { id: "svc-health", seq: 2 });
    c.setNow(iso(T0, 1));
    // The check is written, then the process dies before the position is saved.
    const crashing = c.eventChecksWith({ checks: { recordEvent: async (...a: Parameters<ResponsibilityChecks["recordEvent"]>) => { await c.checks.recordEvent(...a); throw new Error("process died"); } } });
    await assert.rejects(() => crashing.sweep(c.owner, c.project), /process died/);
    assert.equal((await c.checks.pending(c.owner, c.project))!.length, 1);
    await c.publish("service.failed", { id: "svc-health", seq: 3 });
    c.setNow(iso(T0, 2));
    assert.equal((await c.again().eventChecks.sweep(c.owner, c.project)).recorded, 0, "the repeated look is the check already written");
    assert.equal((await c.checks.pending(c.owner, c.project))!.length, 1, "one owed check, not two for overlapping events");
    assert.deepEqual(await c.eventChecks().sweep(c.owner, c.project), { recorded: 0, more: false }, "and the position went past every event");
    // Two instances looking at once from the same position record one check.
    await c.publish("service.failed", { id: "svc-health", seq: 4 });
    const both = await Promise.all([c.again().eventChecks.sweep(c.owner, c.project), c.again().eventChecks.sweep(c.owner, c.project)]);
    assert.equal(both[0].recorded + both[1].recorded, 1);
    assert.equal((await c.checks.pending(c.owner, c.project))!.length, 2);
  });

  suite("review: responsibilities at the same position share one read, a sweep reads a bounded number of events in all and the rest get their turn next, and a new responsibility starts at its creation, not at the start of a long history", async (c) => {
    let reads = 0;
    const counting: EventCheckDeps["events"] = { since: (...a) => { reads++; return c.events.since(...a); } };
    for (let i = 0; i < 12; i++) await c.make({ title: `Duty ${i}`, eventSources: ["svc-health"], everyMinutes: undefined });
    await c.eventChecksWith({ events: counting }).sweep(c.owner, c.project);
    await c.publish("service.failed", { id: "svc-health", seq: 1 });
    c.setNow(iso(T0, 1)); reads = 0;
    assert.deepEqual(await c.eventChecksWith({ events: counting }).sweep(c.owner, c.project), { recorded: 12, more: false });
    assert.equal(reads, 1, "twelve responsibilities at one position: one read");
    // A long history, then a new responsibility: it finds its start in a few reads and sees the event that came after it was created.
    for (let i = 0; i < 40; i++) await c.publish("other.kind");
    c.setNow(iso(T0, 10));
    const fresh = await c.make({ title: "Fresh", eventSources: ["svc-health"], everyMinutes: undefined });
    c.setNow(iso(T0, 11));
    await c.publish("service.failed", { id: "svc-health", seq: 2 });
    reads = 0;
    await c.eventChecksWith({ events: counting, batch: 5 }).sweep(c.owner, c.project);
    assert.ok(reads <= 12, `found its start by halving, not by reading forty events five at a time (${reads} reads)`);
    const mine = (await c.checks.pending(c.owner, c.project))!.filter((p) => p.responsibilityId === fresh);
    assert.deepEqual(mine.map((p) => p.trigger?.firstSeq), [42], "the event after its creation is owed to it on the first look");
    // A budget of one read per sweep: two positions take two sweeps, each responsibility gets its turn, nothing is skipped.
    await c.eventChecks().sweep(c.owner, c.project);
    const all = (await c.duties.list(c.owner, c.project, { state: "active" }))!;
    const paused = all.find((r) => r.title === "Duty 0")!;
    await c.duties.update(c.owner, { commandId: cid("u"), responsibilityId: paused.id, expectedRevision: paused.revision, state: "paused" } as never);
    await c.publish("service.failed", { id: "svc-health", seq: 3 });
    await c.eventChecks().sweep(c.owner, c.project);
    await c.duties.update(c.owner, { commandId: cid("u"), responsibilityId: paused.id, expectedRevision: (await c.duties.get(c.owner, paused.id))!.revision, state: "active" } as never);
    await c.publish("service.failed", { id: "svc-health", seq: 4 });
    const tight = c.eventChecksWith({ reads: 1, batch: 1 });
    for (let i = 0; i < 6; i++) await tight.sweep(c.owner, c.project);
    const head = (await c.events.since(`project:${c.project}`, 1, 1)).head;
    for (const r of all) assert.equal(await c.eventChecks().position(c.owner, r.id), head, `${r.title} reached the end`);
  });

  suite("review: the clock set back keeps the last-seen time honest, so a later real absence is still a gap; exactly five minutes away is not a gap, a moment more is", async (c) => {
    c.setNow(iso(T0, 100));
    await c.gaps.heartbeat(c.owner, { startup: true });
    c.setNow(T0); // the clock was put back by 100 minutes while running
    await c.gaps.heartbeat(c.owner);
    c.setNow(iso(T0, 30));
    assert.deepEqual(await c.again().gaps.heartbeat(c.owner, { startup: true }), { downtime: { start: T0, end: iso(T0, 30) } }, "30 minutes away after the clock went back is a gap");
    c.setNow(iso(T0, 35));
    assert.deepEqual(await c.again().gaps.heartbeat(c.owner, { startup: true }), {}, "exactly five minutes: not a gap");
    c.setNow(new Date(Date.parse(iso(T0, 40)) + 1).toISOString());
    assert.equal((await c.again().gaps.heartbeat(c.owner, { startup: true })).downtime?.start, iso(T0, 35), "five minutes and a moment: a gap");
    assert.equal((await c.gaps.list(c.owner, c.project))!.items.filter((g) => g.reason === "controller-down").length, 2);
  });
}
