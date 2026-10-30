import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AgentService } from "../agents/index.js";
import { ConfigurationService } from "../configuration/index.js";
import { DeskService, HistoryService, RetrievalService } from "../context/index.js";
import type { Availability } from "../conversations/index.js";
import { AssignmentService } from "../domain/assignments.js";
import { BlockerService } from "../domain/blockers.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { CommandRunner } from "../domain/runner.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { WaitService } from "../domain/waits.js";
import { InquiryService } from "../inquiries/index.js";
import { PauseService } from "../lifecycle/index.js";
import { MEETING_SETTINGS, MeetingService, type AgendaBody, type OccurrenceBody, type ScheduleBody } from "../meetings/index.js";
import { ContractService } from "../planning/index.js";
import { PrincipalService, type Grant, type Principal } from "../security/index.js";
import {
  ImprovementService, StandupService, allocationFrom, needsOwnerFrom, outcomeLine, type BriefBody, type OutcomeNotice, type PrepNotice, type StandupConfigBody,
} from "./index.js";

after(stopServer);

// The only clock anything here reads. Tests move it; nothing sleeps.
let now = Date.parse("2026-10-20T08:00:00.000Z");
const at = (iso: string): void => { now = Date.parse(iso); };
const options = { clock: () => new Date(now).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};

for (const backend of backends) {
  interface Ctx {
    owner: Principal; host: Principal; mgr: Principal; scribe: Principal; dev: Principal; dev2: Principal; reader: Principal; plain: Principal; eve: Principal; asA: Principal; asB: Principal;
    a: string; b: string; agentA: string; agentB: string; agentC: string; pA: string; pB: string; pC: string;
    meetings: MeetingService; standups: StandupService; improvements: ImprovementService; pauses: PauseService; other: Map<string, Availability>;
    notices: (PrepNotice)[]; outcomes: OutcomeNotice[]; failNotice: { agent?: string }; failOutcome: { on: boolean }; hooks: { onDeliver?: (n: OutcomeNotice) => Promise<void> }; meetingsWith(over: { returnsListed?: number; returnsMore?: number }): MeetingService;
    projects: ProjectService; assignments: AssignmentService; contracts: ContractService; blockers: BlockerService; waits: WaitService;
    make(over?: Partial<ConstructorParameters<typeof Object>[0]>): StandupService;
    makeImprovements(withSink: boolean): ImprovementService;
    put(kind: string, id: string, body: Record<string, unknown>): Promise<void>;
    task(title: string, who: string | undefined, state: "ready" | "in_progress" | "done" | "blocked", project?: string): Promise<string>;
    schedule(extra?: Record<string, unknown>): Promise<{ scheduleId: string }>;
    occurrenceAt(iso: string, extra?: Record<string, unknown>): Promise<string>;
    storage: ConstructorParameters<typeof CommandRunner>[0]; epoch: number;
  }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      at("2026-10-20T08:00:00.000Z");
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const epoch = projects.epoch;
        const principals = PrincipalService.withEpoch(world.storage, epoch, options);
        const agents = AgentService.withEpoch(world.storage, epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const enroll = async (kind: "agent" | "host", nm: string, grants: Grant[]): Promise<Principal> => {
          await principals.enroll(owner, { commandId: cid("e"), kind, name: nm, grants });
          return principals.authenticate((await principals.issueCredential(owner, `${kind}:${nm}`)).token);
        };
        const a = (await projects.createProject({ commandId: cid("pa"), actor: owner.id, name: "A" })).id;
        const b = (await projects.createProject({ commandId: cid("pb"), actor: owner.id, name: "B" })).id;
        const agentA = (await agents.create(owner, { commandId: cid("ag"), friendlyName: "A" })).id;
        const agentB = (await agents.create(owner, { commandId: cid("ag"), friendlyName: "B" })).id;
        const agentC = (await agents.create(owner, { commandId: cid("ag"), friendlyName: "C" })).id;
        const [pA, pB, pC] = [`agent:${agentA}`, `agent:${agentB}`, `agent:${agentC}`] as const;
        const other = new Map<string, Availability>();
        const pauses = PauseService.withEpoch(world.storage, epoch, {}, { ...options, otherAvailability: async (id) => other.get(id) ?? "available" });
        const histories = HistoryService.withEpoch(world.storage, epoch, options);
        const desks = DeskService.withEpoch(world.storage, epoch, options);
        const retrieval = RetrievalService.withEpoch(world.storage, epoch, desks, histories, options);
        const assignments = AssignmentService.withEpoch(world.storage, epoch, projects, options);
        const waits = WaitService.withEpoch(world.storage, epoch, assignments, options);
        const blockers = BlockerService.withEpoch(world.storage, epoch, options);
        const contracts = ContractService.withEpoch(world.storage, epoch, options);
        const inquiries = InquiryService.withEpoch(world.storage, epoch, { histories, retrieval, waits, assignments }, options);
        const config = ConfigurationService.withEpoch(world.storage, epoch, { ...options, settings: MEETING_SETTINGS });
        const meetings = MeetingService.withEpoch(world.storage, epoch, { inquiries }, { availability: pauses.availability, ...options });
        const notices: PrepNotice[] = [];
        const outcomes: OutcomeNotice[] = [];
        const failNotice: { agent?: string } = {};
        const failOutcome = { on: false };
        const hooks: { onDeliver?: (n: OutcomeNotice) => Promise<void> } = {};
        const sinkOf = {
          notices: { async notify(x: PrepNotice) { if (failNotice.agent === x.agent) { delete failNotice.agent; throw new Error("the delivery died"); } if (!notices.some((y) => y.key === x.key)) notices.push(x); } },
          outcomes: { async deliver(x: OutcomeNotice) { if (failOutcome.on) throw new Error("the conversation is away"); await hooks.onDeliver?.(x); if (!outcomes.some((y) => y.key === x.key)) outcomes.push(x); } },
        };
        const make = (over: Record<string, unknown> = {}) => StandupService.withEpoch(world.storage, epoch, { meetings: (over["meetings"] as MeetingService | undefined) ?? meetings, assignments }, { availability: pauses.availability, notices: sinkOf.notices, outcomes: sinkOf.outcomes, ...options, ...over } as never);
        const makeImprovements = (withSink: boolean) => ImprovementService.withEpoch(world.storage, epoch, { meetings }, { ...options, ...(withSink ? { outcomes: sinkOf.outcomes } : {}) });
        const host = await enroll("host", "h1", []);
        const mgr = await enroll("agent", "mgr", [{ action: "meeting.manage", project: a }]);
        const scribe = await enroll("agent", "scribe", [{ action: "meeting.agenda", project: a }]);
        const dev = await enroll("agent", "dev", [{ action: "meeting.agenda", project: a }, { action: "task.read", project: a }]);
        const dev2 = await enroll("agent", "dev2", [{ action: "meeting.agenda", project: a }, { action: "task.read", project: a }]);
        const reader = await enroll("agent", "reader", [{ action: "meeting.read", project: a }, { action: "history.read", project: a }]);
        const plain = await enroll("agent", "plain", [{ action: "meeting.read", project: a }]);
        const eve = await enroll("agent", "eve", [{ action: "meeting.manage", project: b }, { action: "meeting.agenda", project: b }]);
        const asA = await principals.authenticate((await principals.issueCredential(owner, pA)).token);
        const asB = await principals.authenticate((await principals.issueCredential(owner, pB)).token);
        const runner = new CommandRunner(world.storage, epoch, options);
        const put = async (kind: string, id: string, bodyOf: Record<string, unknown>): Promise<void> => {
          await runner.command("test.put", { commandId: cid("put"), actor: owner.id }, async () => ({ payload: {}, build: async () => ({ ref: { kind, id }, creates: true, changes: [{ type: "create" as const, ref: { kind, id }, body: bodyOf as never }], detail: {} }) }));
        };
        const task: Ctx["task"] = async (title, who, state, project = a) => {
          const id = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title })).id;
          let rev = 1;
          const go = async (to: "ready" | "in_progress" | "done" | "blocked"): Promise<void> => { await projects.transitionTask({ commandId: cid("tr"), actor: owner.id, taskId: id, expectedRevision: rev, to }); rev++; };
          await go("ready");
          if (who !== undefined) await assignments.assignTask({ commandId: cid("as"), actor: owner.id, taskId: id, owner: { kind: "agent", id: who } });
          if (state !== "ready") await go("in_progress");
          if (state === "done") await go("done");
          if (state === "blocked") await go("blocked");
          return id;
        };
        const standups = make();
        const schedule: Ctx["schedule"] = (extra = {}) => standups.configure(mgr, { commandId: cid("sc"), projectId: a, title: "Daily stand-up", roster: [pA, pB], time: "09:00", windowFrom: "08:00", windowTo: "10:00", timeZone: "Europe/Berlin", ...extra } as never);
        // A live occurrence at the given start (UTC), made by a daily schedule in Berlin whose 09:00 falls on that instant, with the clock just inside its preparation window.
        const occurrenceAt: Ctx["occurrenceAt"] = async (iso, extra = {}) => {
          const berlinHour = new Date(Date.parse(iso)).getUTCHours() + (Date.parse(iso) < Date.parse("2026-10-25T01:00:00.000Z") ? 2 : 1);
          const time = `${String(berlinHour).padStart(2, "0")}:00`;
          at(new Date(Date.parse(iso) - 24 * 3_600_000).toISOString());
          const made = await schedule({ time, windowFrom: "06:00", windowTo: "18:00", roster: [pA, pB, pC], ...extra });
          at(new Date(Date.parse(iso) - 30 * 60_000).toISOString());
          const created = (await meetings.tick(host)).created.filter((x) => x.scheduleId === made.scheduleId);
          assert.equal(created.length, 1);
          return created[0]!.occurrenceId;
        };
        await body({
          owner, host, mgr, scribe, dev, dev2, reader, plain, eve, asA, asB, a, b, agentA, agentB, agentC, pA, pB, pC, meetings, standups, improvements: makeImprovements(true), pauses, other, notices, outcomes, failNotice, failOutcome, hooks, meetingsWith: (over) => MeetingService.withEpoch(world.storage, epoch, { inquiries }, { availability: pauses.availability, ...options, ...over }),
          projects, assignments, contracts, blockers, waits, make: make as never, makeImprovements, put, task, schedule, occurrenceAt, storage: world.storage, epoch,
        });
        void config;
      } finally { await world.close(); }
    });

  const occurrenceOf = async (c: Ctx, id: string): Promise<OccurrenceBody> => (await c.meetings.occurrence(c.owner, id))!.occurrence as unknown as OccurrenceBody;
  const item = (extra: Record<string, unknown> = {}) => ({ commandId: cid("ag"), topic: "Move the nightly build earlier?", ...extra });

  // ---- configuration --------------------------------------------------------------------------------------------------------

  suite("a stand-up is a daily schedule with a participant group, length, zone and a daily window its time must lie in; a refused set-up leaves nothing behind and a repeat returns the same stand-up", async (c) => {
    const id = cid("conf");
    // Outside the window, running past its end, reversed, or in an unknown zone: refused before anything is created.
    await refuses("invalid_command", () => c.standups.configure(c.mgr, { commandId: id, projectId: c.a, title: "Daily", roster: [c.pA, c.pB], time: "07:30", windowFrom: "08:00", windowTo: "10:00", timeZone: "Europe/Berlin" }), (e) => assert.match(e.message, /daily window/));
    await refuses("invalid_command", () => c.standups.configure(c.mgr, { commandId: id, projectId: c.a, title: "Daily", roster: [c.pA, c.pB], time: "09:45", durationMinutes: 30, windowFrom: "08:00", windowTo: "10:00", timeZone: "Europe/Berlin" }), (e) => assert.match(e.message, /daily window/));
    await refuses("invalid_command", () => c.standups.configure(c.mgr, { commandId: id, projectId: c.a, title: "Daily", roster: [c.pA, c.pB], time: "09:00", windowFrom: "10:00", windowTo: "08:00", timeZone: "Europe/Berlin" }));
    await refuses("invalid_command", () => c.standups.configure(c.mgr, { commandId: id, projectId: c.a, title: "Daily", roster: [c.pA, c.pB], time: "09:00", windowFrom: "08:00", windowTo: "10:00", timeZone: "Mars/Olympus" }));
    await refuses("invalid_command", () => c.standups.configure(c.mgr, { commandId: id, projectId: c.a, title: "Daily", roster: [c.pA, c.pB], time: "09:00", windowFrom: "08:00", windowTo: "10:00" }), (e) => assert.match(e.message, /timeZone/));
    // The same command ID with good values is a fresh command: nothing was made by the refusals.
    const made = await c.standups.configure(c.mgr, { commandId: id, projectId: c.a, title: "Daily", roster: [c.pB, c.pA], time: "09:00", windowFrom: "08:00", windowTo: "10:00", timeZone: "Europe/Berlin", durationMinutes: 20, coverageHours: 24 });
    assert.equal(made.replayed, false);
    const again = await c.standups.configure(c.mgr, { commandId: id, projectId: c.a, title: "Daily", roster: [c.pB, c.pA], time: "09:00", windowFrom: "08:00", windowTo: "10:00", timeZone: "Europe/Berlin", durationMinutes: 20, coverageHours: 24 });
    assert.deepEqual([again.scheduleId, again.replayed], [made.scheduleId, true]);
    const view = (await c.standups.standup(c.mgr, made.scheduleId))!;
    const s = view.schedule as unknown as ScheduleBody;
    assert.deepEqual([s.time, s.timeZone, s.roster, s.durationMinutes, s.prepareMinutes, s.recurrence], ["09:00", "Europe/Berlin", [c.pA, c.pB].sort(), 20, 60, { kind: "daily" }]);
    const cfg = view.config as unknown as StandupConfigBody;
    assert.deepEqual([cfg.windowFrom, cfg.windowTo, cfg.coverageHours], ["08:00", "10:00", 24]);
    // Authority and visibility: a manager of another project, an agenda writer and a reader cannot set one up; what they may not read looks missing.
    for (const who of [c.eve, c.scribe, c.reader]) await refuses("forbidden", () => c.standups.configure(who, { commandId: cid("conf"), projectId: c.a, title: "Daily", roster: [c.pA], time: "09:00", windowFrom: "08:00", windowTo: "10:00", timeZone: "UTC" }));
    assert.equal(await c.standups.standup(c.eve, made.scheduleId), undefined);
    assert.ok(await c.standups.standup(c.reader, made.scheduleId) !== undefined);
    assert.ok(await c.standups.standup(c.plain, made.scheduleId) !== undefined);
    // Unknown fields and a caller-supplied actor are refused.
    await refuses("invalid_command", () => c.standups.configure(c.mgr, { commandId: cid("conf"), projectId: c.a, title: "Daily", roster: [c.pA], time: "09:00", windowFrom: "08:00", windowTo: "10:00", timeZone: "UTC", actor: "owner:rob" } as never));
  });

  suite("changing a stand-up keeps the window rule: a time outside the window is refused and changes nothing; the window and the coverage can be changed; a stale revision is refused", async (c) => {
    const { scheduleId } = await c.schedule({ windowFrom: "08:00", windowTo: "10:00", time: "09:00" });
    const rev = (await c.meetings.schedule(c.mgr, scheduleId))!.revision;
    await refuses("invalid_command", () => c.standups.update(c.mgr, { commandId: cid("u"), scheduleId, expectedRevision: rev, time: "11:00" }), (e) => assert.match(e.message, /daily window/));
    await refuses("invalid_command", () => c.standups.update(c.mgr, { commandId: cid("u"), scheduleId, expectedRevision: rev, durationMinutes: 90 }), (e) => assert.match(e.message, /daily window/));
    assert.deepEqual([(await c.meetings.schedule(c.mgr, scheduleId))!.revision, (await c.meetings.schedule(c.mgr, scheduleId))!.time], [rev, "09:00"], "a refused change touched nothing");
    await c.standups.update(c.mgr, { commandId: cid("u"), scheduleId, expectedRevision: rev, time: "09:30" });
    assert.equal((await c.meetings.schedule(c.mgr, scheduleId))!.time, "09:30");
    const rev2 = (await c.meetings.schedule(c.mgr, scheduleId))!.revision;
    await c.standups.update(c.mgr, { commandId: cid("u"), scheduleId, expectedRevision: rev2, time: "11:00", windowTo: "12:00", coverageHours: 36 });
    const cfg = (await c.standups.standup(c.mgr, scheduleId))!.config as unknown as StandupConfigBody;
    assert.deepEqual([cfg.windowTo, cfg.coverageHours, (await c.meetings.schedule(c.mgr, scheduleId))!.time], ["12:00", 36, "11:00"]);
    await refuses("stale_revision", () => c.standups.update(c.mgr, { commandId: cid("u"), scheduleId, expectedRevision: rev, title: "Renamed" }));
    await refuses("forbidden", () => c.standups.update(c.scribe, { commandId: cid("u"), scheduleId, expectedRevision: rev2 + 1, title: "Renamed" }));
    await refuses("forbidden", () => c.standups.update(c.eve, { commandId: cid("u"), scheduleId, expectedRevision: rev2 + 1, title: "Renamed" }));
  });

  suite("the stand-up keeps its wall-clock time across the autumn change, and after downtime there is one catch-up report with briefs and no notices", async (c) => {
    at("2026-10-23T08:00:00.000Z");
    const { scheduleId } = await c.schedule({ time: "09:00", windowFrom: "08:00", windowTo: "10:00" });
    at("2026-10-24T05:50:00.000Z");
    assert.equal((await c.meetings.tick(c.host)).created.length, 0, "the preparation window (60 minutes) has not opened");
    at("2026-10-24T06:10:00.000Z");
    const first = (await c.meetings.tick(c.host)).created;
    assert.equal((await occurrenceOf(c, first[0]!.occurrenceId)).startsAt, "2026-10-24T07:00:00.000Z", "09:00 in Berlin is 07:00 UTC before the change");
    at("2026-10-25T07:10:00.000Z");
    const second = (await c.meetings.tick(c.host)).created;
    assert.equal((await occurrenceOf(c, second[0]!.occurrenceId)).startsAt, "2026-10-25T08:00:00.000Z", "and 08:00 UTC after it: the wall-clock time holds");
    // The controller was down for four days: one catch-up report, not four meetings.
    at("2026-10-29T12:00:00.000Z");
    const late = await c.meetings.tick(c.host);
    const made = late.created.filter((x) => x.scheduleId === scheduleId);
    assert.equal(made.length, 1);
    const report = await occurrenceOf(c, made[0]!.occurrenceId);
    assert.deepEqual([report.mode, report.state], ["catch-up", "reported"]);
    assert.ok(report.skippedCount >= 3);
    const prepared = await c.standups.prepare(c.host, made[0]!.occurrenceId);
    assert.deepEqual(prepared.notified, [], "there is no meeting to call anyone into");
    assert.equal(c.notices.length, 0);
    assert.equal(prepared.briefs.length, 2);
    const briefs = await c.standups.briefs(c.owner, made[0]!.occurrenceId);
    assert.ok(briefs.every((b) => b.coversFrom === report.coversFrom), "the report covers the period since the previous handled meeting");
    void scheduleId;
  });

  // ---- advance notice -------------------------------------------------------------------------------------------------------

  suite("agents that can be reached are told once to reach a safe boundary; a paused or suspended agent is not woken (it is listed as withheld); a failed delivery is retried with the same key; a resumed agent is told later", async (c) => {
    const occ = await c.occurrenceAt("2026-10-21T07:00:00.000Z");
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "agent", id: c.agentA }, reason: "quiet" });
    c.other.set(c.pC, "suspended");
    c.failNotice.agent = c.pB;
    await assert.rejects(c.standups.prepare(c.host, occ), /delivery died/);
    assert.equal(c.notices.length, 0);
    assert.equal(await c.standups.prepared(c.owner, occ), undefined, "a failed delivery is not recorded as sent");
    const first = await c.standups.prepare(c.host, occ);
    assert.deepEqual(first.notified, [c.pB]);
    assert.deepEqual([...first.withheld].sort(), [c.pA, c.pC].sort());
    assert.equal(c.notices.length, 1);
    assert.equal(c.notices[0]!.key, `${occ}:${c.pB}:prepare`);
    assert.match(c.notices[0]!.message, /safe boundary/);
    assert.equal(c.notices[0]!.startsAt, "2026-10-21T07:00:00.000Z");
    assert.equal(await c.pauses.availability(c.pA), "paused", "nothing was resumed");
    assert.equal(await c.pauses.availability(c.pC), "suspended");
    // Again: nobody is told twice, and nothing is written when nothing changed.
    const rev = (await c.standups.prepared(c.owner, occ))!.revision;
    assert.deepEqual((await c.standups.prepare(c.host, occ)).notified, []);
    assert.equal((await c.standups.prepared(c.owner, occ))!.revision, rev);
    // The owner resumes A: the next preparation tells it; the suspended C is still not told.
    await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: { kind: "agent", id: c.agentA }, reason: "back" });
    assert.deepEqual((await c.standups.prepare(c.host, occ)).notified, [c.pA]);
    assert.deepEqual(c.notices.map((x) => x.agent).sort(), [c.pA, c.pB].sort());
    // A restarted service does the same: nothing new.
    assert.deepEqual((await c.make().prepare(c.host, occ)).notified, []);
    // Only the controller prepares.
    for (const who of [c.mgr, c.scribe, c.asA, c.reader, c.eve]) await refuses("forbidden", () => c.standups.prepare(who, occ));
    await refuses("not_found", () => c.standups.prepare(c.host, "mto-aaaaaaaaaaaaaaaaaaaa"));
    await refuses("invalid_command", () => c.standups.prepare(c.host, "nonsense"));
  });

  suite("several processes preparing the same occurrence at once make one brief per agent and one record of what was prepared, and nobody is told twice", async (c) => {
    const occ = await c.occurrenceAt("2026-10-21T07:00:00.000Z");
    await c.task("Some work", c.agentA, "in_progress");
    const results = await Promise.all([c.standups, c.make(), c.make(), c.make()].map((s) => s.prepare(c.host, occ)));
    assert.equal(results.length, 4);
    assert.equal((await c.standups.briefs(c.owner, occ)).length, 3);
    assert.equal(c.notices.length, 3, "the sink de-duplicates by key, so each agent has one notice");
    const prep = (await c.standups.prepared(c.owner, occ))!;
    assert.deepEqual(Object.keys(prep.notified).sort(), [c.pA, c.pB, c.pC].sort());
    assert.deepEqual((await c.standups.prepare(c.host, occ)).briefs.map((b) => b.change), ["unchanged", "unchanged", "unchanged"]);
  });

  suite("when availability cannot be read, nobody is told (it fails closed); after the meeting's end no notice goes out but the briefs can still be made", async (c) => {
    const occ = await c.occurrenceAt("2026-10-21T07:00:00.000Z");
    const blind = c.make({ availability: async () => { throw new Error("pause service down"); } });
    const r = await blind.prepare(c.host, occ);
    assert.deepEqual(r.notified, []);
    assert.equal(r.withheld.length, 3);
    assert.equal(c.notices.length, 0);
    assert.ok((await blind.briefs(c.owner, occ)).every((b) => b.agentState === "stopped"), "an unreadable state is recorded as stopped, not guessed to be available");
    at("2026-10-21T08:30:00.000Z");
    const late = await c.standups.prepare(c.host, occ);
    assert.deepEqual(late.notified, []);
    assert.equal(c.notices.length, 0);
  });

  // ---- briefs ---------------------------------------------------------------------------------------------------------------

  const world = async (c: Ctx) => {
    const occ = await c.occurrenceAt("2026-10-21T07:00:00.000Z");
    // The period is 2026-10-20T07:00Z to the preparation time. Work is recorded at moments on both sides of its start.
    at("2026-10-19T10:00:00.000Z"); const old = await c.task("Old release notes", c.agentA, "done");
    at("2026-10-20T15:00:00.000Z"); const done = await c.task("Fix the login redirect", c.agentA, "done");
    const art = "art-donedonedonedonedone";
    at("2026-10-20T16:00:00.000Z"); await c.put("artifact", art, { name: "login-fix.patch", projectId: c.a, taskId: done, entries: [], manifestDigest: "d", totalBytes: 0, createdBy: c.pA });
    at("2026-10-20T17:00:00.000Z");
    const work = await c.task("Rework the cache", c.agentA, "in_progress");
    const next = await c.task("Document the cache", c.agentA, "ready");
    const held = await c.task("Wait for the API key", c.agentA, "in_progress");
    const stuck = await c.task("Unexplained stall", c.agentA, "blocked");
    const mine = await c.task("Their own work", c.agentB, "in_progress");
    const cs = await c.task("C's work", c.agentC, "in_progress");
    await c.contracts.setContract(c.owner, { commandId: cid("ct"), taskId: work, expectedVersion: (await c.contracts.get(c.owner, work))!.version, priority: 7 } as never);
    await c.contracts.setContract(c.owner, { commandId: cid("ct"), taskId: next, expectedVersion: (await c.contracts.get(c.owner, next))!.version, priority: 3 } as never);
    const blocker = (await c.blockers.openBlocker({ commandId: cid("b"), actor: c.owner.id, type: "manual_hold", subject: { kind: "task", id: held }, summary: "waiting for the vendor's API key", resolver: "owner" })).id;
    const waiter = await c.task("Decide the cache size", c.agentA, "in_progress");
    const wait = (await c.waits.openWait({ commandId: cid("w"), actor: c.owner.id, taskId: waiter, reason: "input", resolver: "owner", summary: "which cache size?", nextAction: "resize", indefinite: { owner: "rob" } })).id;
    const inquiry = "inq-askedaskedaskedasked";
    await c.put("inquiry", inquiry, { taskId: work, projectId: c.a, asker: c.pA, to: c.pB, question: "Is the shared cache safe to resize?", scopeId: "s", correlationId: inquiry, contextRefs: [], state: "open", askedAt: "2026-10-20T17:30:00.000Z" });
    at("2026-10-21T05:00:00.000Z");
    return { occ, old, done, art, work, next, held, stuck, mine, cs, blocker, wait, waiter, inquiry };
  };
  const rev = async (c: Ctx, kind: string, id: string): Promise<number> => (await new CommandRunner(c.storage, c.epoch, options).get(kind, id))!.revision;

  suite("a brief lists accomplishments, unfinished work, blockers, advice needed and next priorities from the records, each with its citations, for the period only and for its own agent only", async (c) => {
    const w = await world(c);
    c.other.set(c.pC, "suspended");
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "agent", id: c.agentB }, reason: "quiet" });
    const prepared = await c.standups.prepare(c.host, w.occ);
    assert.deepEqual(prepared.briefs.map((b) => b.change), ["created", "created", "created"]);
    const byAgent = Object.fromEntries((await c.standups.briefs(c.owner, w.occ)).map((b) => [b.agent, b]));
    const A = byAgent[c.pA]! as unknown as BriefBody;
    const cites = (entries: readonly { cites: readonly { kind: string; id: string; revision?: number }[] }[]) => entries.flatMap((e) => e.cites.map((x) => `${x.kind}:${x.id}:${x.revision}`));
    assert.equal(A.coversFrom, "2026-10-20T07:00:00.000Z");
    assert.equal(A.agentState, "available");
    // Accomplishments: the task done in the period and its artifact; the older one is not there.
    assert.equal(A.accomplishments.length, 2);
    assert.deepEqual(cites(A.accomplishments).sort(), [`artifact:${w.art}:1`, `task:${w.done}:${await rev(c, "task", w.done)}`, `task:${w.done}:${await rev(c, "task", w.done)}`].sort());
    assert.ok(!JSON.stringify(A).includes(w.old), "the work finished before the period is not in the brief");
    assert.match(A.accomplishments[0]!.text, /Fix the login redirect/);
    // Unfinished work, blockers with the kind of record behind them, advice asked for, and priorities in order.
    assert.deepEqual(A.unfinished.map((e) => e.cites[0]!.id).sort(), [w.work, w.next, w.held, w.stuck, w.waiter].sort());
    assert.deepEqual(cites(A.blockers).filter((x) => !x.startsWith("task:")).sort(), [`blocker:${w.blocker}:1`, `wait:${w.wait}:${await rev(c, "wait", w.wait)}`].sort());
    assert.ok(A.blockers.some((e) => /no blocker or wait is recorded/.test(e.text) && e.cites[0]!.id === w.stuck), "a blocked task nothing explains says so");
    assert.deepEqual(A.advice.map((e) => e.cites[0]), [{ kind: "inquiry", id: w.inquiry, revision: 1 }]);
    assert.deepEqual(A.priorities.map((e) => e.cites[0]!.id), [w.work, w.held, w.next], "by priority; a task that waits is not a next priority");
    assert.match(A.priorities[0]!.text, /priority 7/);
    // Another agent's brief holds its own work only; a paused one has a brief made from the records, and a suspended one too.
    const B = byAgent[c.pB]! as unknown as BriefBody;
    assert.deepEqual([B.agentState, B.unfinished.map((e) => e.cites[0]!.id)], ["paused", [w.mine]]);
    assert.deepEqual([(byAgent[c.pC] as unknown as BriefBody).agentState, (byAgent[c.pC] as unknown as BriefBody).unfinished.map((e) => e.cites[0]!.id)], ["suspended", [w.cs]]);
    assert.ok(!JSON.stringify(B).includes(w.work));
    // Nobody was woken or asked: only A was told (B is paused, C suspended), and the pauses are as they were.
    assert.deepEqual(c.notices.map((x) => x.agent), [c.pA]);
    assert.equal(await c.pauses.availability(c.pB), "paused");
    // Repeating changes nothing; a change in the records refreshes the brief; once the meeting has started it is left as the meeting saw it.
    assert.deepEqual((await c.standups.prepare(c.host, w.occ)).briefs.map((b) => b.change), ["unchanged", "unchanged", "unchanged"]);
    const before = (await c.standups.brief(c.owner, byAgent[c.pA]!.id))!.revision;
    await c.projects.transitionTask({ commandId: cid("tr"), actor: c.owner.id, taskId: w.next, expectedRevision: await rev(c, "task", w.next), to: "in_progress" });
    const refreshed = await c.standups.prepare(c.host, w.occ);
    assert.equal(refreshed.briefs.find((b) => b.agent === c.pA)!.change, "updated");
    assert.equal((await c.standups.brief(c.owner, byAgent[c.pA]!.id))!.revision, before + 1);
    at("2026-10-21T07:05:00.000Z");
    await c.projects.transitionTask({ commandId: cid("tr"), actor: c.owner.id, taskId: w.next, expectedRevision: await rev(c, "task", w.next), to: "done" });
    assert.equal((await c.standups.prepare(c.host, w.occ)).briefs.find((b) => b.agent === c.pA)!.change, "unchanged");
  });

  suite("a scan that stops early marks the brief and the review partial instead of silently dropping records", async (c) => {
    const w = await world(c);
    const tight = c.make({ scanPageSize: 1, scanPages: 1 });
    const r = await tight.prepare(c.host, w.occ);
    assert.equal(r.review.partial, true);
    assert.ok(r.review.lines.some((l) => /search stopped before every record was read/.test(l.text)));
    assert.ok((await tight.briefs(c.owner, w.occ)).every((b) => b.partial));
  });

  suite("who may read a brief: the owner, the controller, the agent itself, and readers of both meetings and histories; anyone else sees what looks like a missing brief; an agent adds its own words only to its own brief", async (c) => {
    const w = await world(c);
    await c.standups.prepare(c.host, w.occ);
    const mineId = (await c.standups.briefs(c.owner, w.occ)).find((b) => b.agent === c.pA)!.id;
    for (const who of [c.owner, c.host, c.asA, c.reader, c.mgr]) assert.ok(await c.standups.brief(who, mineId), who.id);
    for (const who of [c.asB, c.plain, c.scribe, c.eve]) assert.equal(await c.standups.brief(who, mineId), undefined, who.id);
    // The words of a question asked of another agent: the owner, the controller and the agent itself only; others get the citation.
    const adviceOf = async (who: Principal) => (await c.standups.brief(who, mineId))!.advice[0]!;
    for (const who of [c.owner, c.host, c.asA]) assert.match((await adviceOf(who)).detail ?? "", /Is the shared cache safe to resize\?/, who.id);
    for (const who of [c.reader, c.mgr]) { const e = await adviceOf(who); assert.equal(e.detail, undefined, who.id); assert.ok(!JSON.stringify(e).includes("shared cache") && !JSON.stringify(e).includes(c.pB), who.id); assert.equal(e.cites[0]!.kind, "inquiry"); }
    assert.equal(await c.standups.brief(c.owner, "sbr-aaaaaaaaaaaaaaaaaaaa"), undefined);
    assert.equal((await c.standups.briefs(c.plain, w.occ)).length, 0);
    assert.equal((await c.standups.briefs(c.asA, w.occ)).length, 1, "an agent sees its own brief");
    // The agent adds its own words; they are kept apart from the records.
    const b0 = (await c.standups.brief(c.asA, mineId))!;
    await c.standups.addStatement(c.asA, { commandId: cid("st"), briefId: mineId, expectedRevision: b0.revision, section: "advice", text: "I need a decision on the cache size." });
    const b1 = (await c.standups.brief(c.asA, mineId))!;
    assert.deepEqual(b1.statements.map((s) => [s.section, s.text]), [["advice", "I need a decision on the cache size."]]);
    assert.equal(b1.advice.length, b0.advice.length, "its words are not mixed into the record-backed section");
    // A refresh keeps them.
    await c.projects.transitionTask({ commandId: cid("tr"), actor: c.owner.id, taskId: w.next, expectedRevision: await rev(c, "task", w.next), to: "in_progress" });
    await c.standups.prepare(c.host, w.occ);
    assert.equal((await c.standups.brief(c.asA, mineId))!.statements.length, 1);
    const b2 = (await c.standups.brief(c.asA, mineId))!;
    await refuses("forbidden", () => c.standups.addStatement(c.asB, { commandId: cid("st"), briefId: mineId, expectedRevision: b2.revision, section: "note", text: "hello" }));
    await refuses("forbidden", () => c.standups.addStatement(c.owner, { commandId: cid("st"), briefId: mineId, expectedRevision: b2.revision, section: "note", text: "hello" }));
    await refuses("stale_revision", () => c.standups.addStatement(c.asA, { commandId: cid("st"), briefId: mineId, expectedRevision: b0.revision, section: "note", text: "hello" }));
    await refuses("invalid_command", () => c.standups.addStatement(c.asA, { commandId: cid("st"), briefId: mineId, expectedRevision: b2.revision, section: "note", text: "key sk-abcdefghijklmnopqrstuvwxyz123456" }));
    await refuses("invalid_command", () => c.standups.addStatement(c.asA, { commandId: cid("st"), briefId: mineId, expectedRevision: b2.revision, section: "plan" as never, text: "x" }));
    let revision = b2.revision;
    for (let i = 1; i < 10; i++) { await c.standups.addStatement(c.asA, { commandId: cid("st"), briefId: mineId, expectedRevision: revision, section: "note", text: `note ${i}` }); revision++; }
    await refuses("invalid_command", () => c.standups.addStatement(c.asA, { commandId: cid("st"), briefId: mineId, expectedRevision: revision, section: "note", text: "one too many" }));
    at("2026-10-21T07:00:00.000Z");
    await refuses("invalid_command", () => c.standups.addStatement(c.asA, { commandId: cid("st"), briefId: mineId, expectedRevision: revision, section: "note", text: "too late" }), (e) => assert.match(e.message, /started/));
  });

  // ---- the agenda -----------------------------------------------------------------------------------------------------------

  suite("the agenda puts urgent points first, then conflicts, questions and decisions, then other topics and improvements; each point states what its request type lets the team do", async (c) => {
    // Raised in a scrambled order, all at the same instant.
    at("2026-10-20T09:00:00.000Z");
    await c.meetings.addAgendaItem(c.scribe, { ...item({ topic: "Faster test setup" }), projectId: c.a, category: "improvement" });
    await refuses("forbidden", () => c.meetings.addAgendaItem(c.scribe, { ...item({ topic: "Disagreement" }), projectId: c.a, category: "conflict" }), (e) => assert.match(e.message, /raise it as a question/));
    const ids: Record<string, string> = {};
    ids["topic"] = (await c.meetings.addAgendaItem(c.scribe, { ...item({ topic: "Plain topic" }), projectId: c.a })).id;
    ids["decision"] = (await c.meetings.addAgendaItem(c.owner, { ...item({ topic: "Pick the linter" }), projectId: c.a, intent: "delegated-decision" })).id;
    ids["improvement"] = (await c.meetings.addAgendaItem(c.mgr, { ...item({ topic: "Shared test fixtures" }), projectId: c.a, category: "improvement", timeboxMinutes: 10 })).id;
    ids["question"] = (await c.meetings.addAgendaItem(c.scribe, { ...item({ topic: "Is the cache safe?" }), projectId: c.a, question: "Is the shared cache safe to resize?" })).id;
    ids["conflict"] = (await c.meetings.addAgendaItem(c.mgr, { ...item({ topic: "A and B disagree on retries" }), projectId: c.a, category: "conflict" })).id;
    ids["urgent"] = (await c.meetings.addAgendaItem(c.scribe, { ...item({ topic: "Production is slow" }), projectId: c.a, urgency: "urgent" })).id;
    ids["instruction"] = (await c.meetings.addAgendaItem(c.owner, { ...item({ topic: "Use the new CI" }), projectId: c.a, intent: "owner-instruction" })).id;
    const expected = ["urgent", "conflict", "question", "decision", "instruction", "topic", "improvement"];
    const idsInOrder = expected.map((k) => ids[k]!);
    const openList = (await c.meetings.openAgenda(c.owner, c.a))!.items.map((i) => i.id);
    assert.deepEqual(openList.filter((x) => idsInOrder.includes(x)), idsInOrder, "the queue is in meeting order");
    const occ = await c.occurrenceAt("2026-10-21T07:00:00.000Z");
    await c.standups.prepare(c.host, occ);
    const agenda = (await c.standups.agenda(c.plain, occ))!;
    assert.deepEqual(agenda.items.map((i) => i.id).filter((x) => idsInOrder.includes(x)), idsInOrder);
    assert.deepEqual(agenda.sections.conflicts.map((i) => i.id), [ids["conflict"]]);
    assert.deepEqual(agenda.sections.questions.map((i) => i.id), [ids["question"]]);
    assert.deepEqual(agenda.sections.decisions.map((i) => i.id).sort(), [ids["decision"]!, ids["instruction"]!].sort());
    assert.equal(agenda.sections.improvements.find((i) => i.id === ids["improvement"])!.timeboxMinutes, 10);
    const line = (k: string) => agenda.items.find((i) => i.id === ids[k])!;
    assert.deepEqual([line("topic").executes, line("topic").votable, line("topic").authority.startsWith("discussion only")], [false, true, true]);
    assert.deepEqual([line("decision").executes, line("decision").votable], [true, true]);
    assert.deepEqual([line("instruction").executes, line("instruction").votable], [true, false]);
    assert.match(line("instruction").authority, /does not vote/);
    assert.match(agenda.routine, /Routine progress is in the written briefs/);
    // A reader of meetings only sees the agenda and the review, not the briefs; one who reads both sees the briefs listed.
    assert.deepEqual(agenda.withheld, ["the planning review", "briefs"], "meeting.read alone shows the agenda, not the records behind it");
    assert.equal(agenda.planning, undefined);
    assert.ok((await c.standups.agenda(c.reader, occ))!.planning !== undefined);
    const full = (await c.standups.agenda(c.reader, occ))!;
    assert.equal(full.briefs?.length, 3);
    assert.equal(await c.standups.agenda(c.eve, occ), undefined);
    assert.equal(await c.standups.agenda(c.scribe, occ), undefined, "an agenda writer who may not read meetings sees nothing");
    assert.equal(await c.standups.agenda(c.owner, "mto-aaaaaaaaaaaaaaaaaaaa"), undefined);
  });

  // ---- the P/PC balance review ----------------------------------------------------------------------------------------------

  suite("the planning agenda carries a P/PC balance review: delivered and pending production, capacity work, allocation against use, deferred PC work and the next protected window; without providers it says so", async (c) => {
    const occ = await c.occurrenceAt("2026-10-21T07:00:00.000Z");
    at("2026-10-20T12:00:00.000Z");
    const pc = async (id: string): Promise<void> => { await c.contracts.setContract(c.owner, { commandId: cid("ct"), taskId: id, expectedVersion: (await c.contracts.get(c.owner, id))!.version, workClass: "PC" } as never); };
    await c.task("Ship the report", c.agentA, "done");
    await c.task("Ship the export", c.agentA, "in_progress");
    const pcDone = await c.task("Cache the fixtures", c.agentB, "done"); await pc(pcDone);
    const pcWork = await c.task("Faster lint", c.agentB, "in_progress"); await pc(pcWork);
    const pcStuck = await c.task("Retire the old tool", c.agentB, "blocked"); await pc(pcStuck);
    // Improvement proposals: one adopted in the period, one deferred with a next step, one open.
    const dev = c.improvements;
    const adopted = (await dev.propose(c.scribe, { commandId: cid("im"), projectId: c.a, title: "Pin the linter version", observation: "The linter changed under us twice." })).id;
    const deferred = (await dev.propose(c.scribe, { commandId: cid("im"), projectId: c.a, title: "Mirror the package cache", observation: "Installs are slow." })).id;
    await dev.propose(c.scribe, { commandId: cid("im"), projectId: c.a, title: "Name the fixtures", observation: "Nobody can find them." });
    await dev.decide(c.mgr, { commandId: cid("d"), itemId: adopted, expectedRevision: 1, to: "accepted" });
    await dev.decide(c.mgr, { commandId: cid("d"), itemId: adopted, expectedRevision: 2, to: "adopted", evaluation: "Lint failures from version drift fell from 4 a week to none over two weeks." });
    await dev.decide(c.mgr, { commandId: cid("d"), itemId: deferred, expectedRevision: 1, to: "deferred", reason: "no spare capacity this week", nextStep: "re-check at Monday planning" });
    at("2026-10-21T05:00:00.000Z");
    const bare = await c.standups.prepare(c.host, occ);
    const text = bare.review.lines.map((l) => l.text).join("\n");
    assert.match(text, /Production \(P\): 1 delivered since 2026-10-20T07:00:00.000Z: Ship the report; 1 pending\./);
    assert.match(text, /Capacity \(PC\): 1 PC task finished and 1 under way: Cache the fixtures; improvement proposals: 2 open, 1 adopted and 0 stopped since .* \(adopted: Pin the linter version\)/);
    assert.match(text, /Allocation against use: no P\/PC allocation is set; actual PC share 50% by count/);
    assert.match(text, /Deferred PC work: 1 PC task blocked and 1 proposal deferred \(Mirror the package cache: next step re-check at Monday planning\)/);
    assert.match(text, /Next protected improvement window: none is scheduled\./);
    assert.ok(bare.review.lines.every((l) => l.cites.length > 0), "every line cites the records it rests on");
    assert.deepEqual([bare.review.figures.deliveredP, bare.review.figures.pendingP, bare.review.figures.deliveredPC, bare.review.figures.activePC, bare.review.figures.deferredPC], [1, 1, 1, 1, 2]);
    // With the owner's allocation and a measured use and a window, the lines say so.
    const rich = c.make({ allocation: async () => ({ floor: 10, target: 20, ceiling: 30 }), usage: async () => ({ pcShare: 18, basis: "worker-slot time" }), improvementWindow: async () => "2026-11-02T09:00:00.000Z" });
    const r = (await rich.prepare(c.host, occ)).review.lines.map((l) => l.text).join("\n");
    assert.match(r, /planned PC share: floor 10%, target 20%, ceiling 30%; actual PC share 18% \(worker-slot time\)/);
    assert.match(r, /Next protected improvement window: 2026-11-02T09:00:00.000Z\./);
    // What needs the owner opens the meeting's agenda (the digest); an unreadable list is said to be unreadable, not left out.
    const owned = c.make({ ownerItems: async () => [{ text: "Approve the paid API key", cites: [{ kind: "notification-item", id: "ntf-1", revision: 2 }] }] });
    await owned.prepare(c.host, occ);
    assert.deepEqual((await c.standups.agenda(c.owner, occ))!.needsOwner?.map((l) => [l.text, l.cites[0]!.id]), [["Approve the paid API key", "ntf-1"]]);
    // The owner's to-do list is the owner's: not for readers of meetings, managers of them or the agents.
    for (const who of [c.plain, c.reader, c.mgr, c.asA]) { assert.equal((await c.standups.agenda(who, occ))?.needsOwner, undefined, who.id); assert.equal((await c.standups.prepared(who, occ))?.needsOwner, undefined, who.id); }
    assert.ok((await c.standups.prepared(c.host, occ))!.needsOwner !== undefined);
    const broken = c.make({ ownerItems: async () => { throw new Error("inbox down"); } });
    await broken.prepare(c.host, occ);
    assert.match((await c.standups.agenda(c.owner, occ))!.needsOwner![0]!.text, /could not be read just now/);
    const inbox = { inbox: async () => ({ items: [
      { id: "ntf-a", revision: 1, state: "queued", urgent: false, label: "Review request for the login fix", count: 1, firstAt: "2026-10-20T10:00:00.000Z", projectId: c.a },
      { id: "ntf-b", revision: 3, state: "queued", urgent: true, label: "Safety stop", count: 2, firstAt: "2026-10-20T12:00:00.000Z", projectId: c.a },
      { id: "ntf-c", revision: 1, state: "answered", urgent: false, label: "Done already", count: 1, firstAt: "2026-10-20T09:00:00.000Z", projectId: c.a },
      { id: "ntf-d", revision: 1, state: "sent", urgent: false, label: "Another project's", count: 1, firstAt: "2026-10-20T08:00:00.000Z", projectId: c.b },
      { id: "ntf-e", revision: 1, state: "queued", urgent: false, label: "Names no project", count: 1, firstAt: "2026-10-20T07:00:00.000Z" },
    ] }) };
    assert.deepEqual((await needsOwnerFrom(inbox as never, c.owner)(c.a)).map((l) => l.cites[0]!.id), ["ntf-b", "ntf-a"], "urgent first, then oldest; answered items, other projects' items and items that name no project are left out");
    // The review is part of the agenda a reader of the meetings sees.
    assert.ok((await c.standups.agenda(c.reader, occ))!.planning!.lines.length >= 5);
    assert.equal((await c.standups.prepared(c.plain, occ))!.review, undefined, "the review names tasks: records rights are needed");
    // The configured allocation can come from the configuration service's values; unreadable gives nothing.
    const fake = { effective: async () => ({ values: { "workClass.pcFloor": { value: 10 }, "workClass.pcTarget": { value: 20 }, "workClass.pcCeiling": { value: 30 } } }) };
    assert.deepEqual(await allocationFrom(fake, c.owner)(), { floor: 10, target: 20, ceiling: 30 });
    assert.equal(await allocationFrom({ effective: async () => undefined }, c.owner)(), undefined);
    assert.equal(c.pA.length > 0, true);
  });

  // ---- outcomes back to the conversation --------------------------------------------------------------------------------------

  suite("an outcome goes back to the conversation the topic came from, once: a topic the meeting did not reach is told so with its reason and next step, a discussion says nothing was started, an instruction does not; a failing conversation is retried with the same key", async (c) => {
    await c.put("chat-turn", "turn-real", { projectId: c.a });
    const talk = (await c.meetings.addAgendaItem(c.owner, { ...item({ topic: "Should we drop the old API?" }), projectId: c.a, source: { kind: "chat-turn", id: "turn-real" } })).id;
    const instruct = (await c.meetings.addAgendaItem(c.owner, { ...item({ topic: "Move to the new CI" }), projectId: c.a, intent: "owner-instruction", source: { kind: "chat-turn", id: "turn-real" } })).id;
    const plainItem = (await c.meetings.addAgendaItem(c.scribe, { ...item({ topic: "No conversation" }), projectId: c.a })).id;
    const occ = await c.occurrenceAt("2026-10-21T07:00:00.000Z");
    await c.meetings.setAgendaState(c.owner, { commandId: cid("st"), itemId: instruct, expectedRevision: (await c.meetings.agendaItem(c.owner, instruct))!.revision, to: "resolved", outcomeNote: "Done by the team on the 21st." });
    // The meeting is held; the discussion topic and the other were not reached.
    await c.meetings.settle(c.host, { commandId: cid("se"), occurrenceId: occ, outcome: "held" });
    assert.equal((await c.meetings.agendaItem(c.owner, talk))!.state, "deferred");
    // Not for a mere manager or agenda writer to collect or mark.
    for (const who of [c.mgr, c.scribe, c.reader]) { await refuses("forbidden", () => c.meetings.outcomesToReturn(who, c.a)); await refuses("forbidden", () => c.standups.deliverOutcomes(who, c.a)); await refuses("forbidden", () => c.meetings.markOutcomeReturned(who, talk, 1)); }
    const waiting = (await c.meetings.outcomesToReturn(c.host, c.a)).items.map((i) => i.id).sort();
    assert.deepEqual(waiting, [talk, instruct].sort(), "an item without a conversation is not queued");
    c.failOutcome.on = true;
    await assert.rejects(c.standups.deliverOutcomes(c.host, c.a), /conversation is away/);
    assert.equal((await c.meetings.agendaItem(c.owner, talk))!.returnedAt, undefined, "not marked until the conversation has it");
    c.failOutcome.on = false;
    const done = await c.standups.deliverOutcomes(c.host, c.a);
    assert.deepEqual([...done.delivered].sort(), [talk, instruct].sort());
    const toldTalk = c.outcomes.find((o) => o.refs[0]!.id === talk)!;
    assert.deepEqual([toldTalk.to, toldTalk.kind], [{ kind: "chat-turn", id: "turn-real" }, "agenda-outcome"]);
    assert.match(toldTalk.text, /was not settled and stays on the list\. Reason: the meeting did not reach it Next step: it is on the next meeting's agenda/);
    assert.match(toldTalk.text, /no work was started because of it/);
    const toldInstruct = c.outcomes.find((o) => o.refs[0]!.id === instruct)!;
    assert.match(toldInstruct.text, /was settled at the stand-up: Done by the team on the 21st\./);
    assert.ok(!/no work was started/.test(toldInstruct.text));
    assert.ok((await c.meetings.agendaItem(c.owner, talk))!.returnedAt !== undefined);
    assert.deepEqual((await c.standups.deliverOutcomes(c.host, c.a)).delivered, [], "nothing is told twice");
    assert.equal(c.outcomes.length, 2);
    // Later the deferred topic is discussed and resolved with a note: it is queued again and told again, under a new key.
    const cur = (await c.meetings.agendaItem(c.owner, talk))!;
    await c.meetings.setAgendaState(c.owner, { commandId: cid("st"), itemId: talk, expectedRevision: cur.revision, to: "resolved", outcomeNote: "Keep the old API for six months.", outcomeRef: "decision-42" });
    assert.deepEqual((await c.standups.deliverOutcomes(c.host, c.a)).delivered, [talk]);
    assert.match(c.outcomes.at(-1)!.text, /Keep the old API for six months\. Record: decision-42\./);
    assert.notEqual(c.outcomes.at(-1)!.key, toldTalk.key);
    // Without a sink the outcomes wait and are listed.
    const quiet = c.make({ outcomes: undefined });
    await c.put("chat-turn", "turn-two", { projectId: c.a });
    const third = (await c.meetings.addAgendaItem(c.owner, { ...item({ topic: "Third" }), projectId: c.a, source: { kind: "chat-turn", id: "turn-two" } })).id;
    await c.meetings.setAgendaState(c.owner, { commandId: cid("st"), itemId: third, expectedRevision: 1, to: "deferred", reason: "later", nextStep: "ask Dana" });
    assert.deepEqual(await quiet.deliverOutcomes(c.host, c.a), { delivered: [], waiting: [third] });
    void plainItem;
    // The wording comes from the typed record, whatever the item.
    assert.match(outcomeLine({ topic: "T", state: "discussed", intent: "recommendation" }), /was discussed at the stand-up\./);
  });

  suite("a stand-up schedule keeps its window against every change, including a direct change of the schedule", async (c) => {
    const { scheduleId } = await c.schedule({ windowFrom: "08:00", windowTo: "10:00", time: "09:00" });
    const rev = (await c.meetings.schedule(c.mgr, scheduleId))!.revision;
    await refuses("invalid_command", () => c.meetings.updateSchedule(c.mgr, { commandId: cid("u"), scheduleId, expectedRevision: rev, time: "11:00" }), (e) => assert.match(e.message, /daily window/));
    await refuses("invalid_command", () => c.meetings.updateSchedule(c.mgr, { commandId: cid("u"), scheduleId, expectedRevision: rev, durationMinutes: 120 }), (e) => assert.match(e.message, /daily window/));
    await refuses("invalid_command", () => c.meetings.updateSchedule(c.mgr, { commandId: cid("u"), scheduleId, expectedRevision: rev, window: { from: "09:30", to: "10:00" } }), (e) => assert.match(e.message, /daily window/));
    assert.equal((await c.meetings.schedule(c.mgr, scheduleId))!.revision, rev, "nothing changed");
    await c.meetings.updateSchedule(c.mgr, { commandId: cid("u"), scheduleId, expectedRevision: rev, time: "09:30" });
    assert.equal((await c.meetings.schedule(c.mgr, scheduleId))!.time, "09:30");
    // A schedule made without a window (an ordinary meeting) is not bound by one.
    const plainId = (await c.meetings.createSchedule(c.mgr, { commandId: cid("sc"), projectId: c.a, title: "Weekly", roster: [c.pA], time: "15:00", timeZone: "UTC" })).id;
    await c.meetings.updateSchedule(c.mgr, { commandId: cid("u"), scheduleId: plainId, expectedRevision: (await c.meetings.schedule(c.mgr, plainId))!.revision, time: "23:00" });
  });

  suite("an agent that is paused but invited by the owner is told about the stand-up and stays paused; one that is only paused is not", async (c) => {
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "agent", id: c.agentA }, reason: "quiet" });
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "agent", id: c.agentB }, reason: "quiet" });
    const occ = await c.occurrenceAt("2026-10-21T07:00:00.000Z");
    await c.meetings.inviteDirect(c.owner, { commandId: cid("iv"), occurrenceId: occ, agent: c.pA });
    const r = await c.standups.prepare(c.host, occ);
    assert.deepEqual([...r.notified].sort(), [c.pA, c.pC].sort());
    assert.deepEqual(r.withheld, [c.pB]);
    assert.equal(await c.pauses.availability(c.pA), "paused", "the pause is still in force");
    assert.equal(await c.pauses.availability(c.pB), "paused");
  });

  suite("an outcome is marked returned only if it is the revision that was sent: a newer outcome stays waiting and goes out next time", async (c) => {
    await c.put("chat-turn", "turn-real", { projectId: c.a });
    const talk = (await c.meetings.addAgendaItem(c.owner, { ...item({ topic: "Should we drop the old API?" }), projectId: c.a, source: { kind: "chat-turn", id: "turn-real" } })).id;
    await c.meetings.setAgendaState(c.owner, { commandId: cid("st"), itemId: talk, expectedRevision: 1, to: "deferred", reason: "later", nextStep: "ask Dana" });
    // While the first outcome is being sent, the meeting resolves the item.
    c.hooks.onDeliver = async () => {
      delete c.hooks.onDeliver;
      await c.meetings.setAgendaState(c.owner, { commandId: cid("st"), itemId: talk, expectedRevision: 2, to: "resolved", outcomeNote: "Keep it six months." });
    };
    const first = await c.standups.deliverOutcomes(c.host, c.a);
    assert.deepEqual([first.delivered, first.waiting], [[], [talk]]);
    assert.equal((await c.meetings.agendaItem(c.owner, talk))!.returnedAt, undefined);
    assert.equal(c.outcomes.length, 1);
    const second = await c.standups.deliverOutcomes(c.host, c.a);
    assert.deepEqual(second.delivered, [talk]);
    assert.match(c.outcomes[1]!.text, /Keep it six months\./);
    assert.notEqual(c.outcomes[1]!.key, c.outcomes[0]!.key);
    assert.equal(await c.meetings.markOutcomeReturned(c.host, talk, 1), false, "an old revision is never marked");
  });

  suite("more than one page of waiting outcomes are all delivered", async (c) => {
    await c.put("chat-turn", "turn-real", { projectId: c.a });
    const ids: string[] = [];
    for (let i = 0; i < 51; i++) {
      const id = (await c.meetings.addAgendaItem(c.owner, { ...item({ topic: `Topic ${i}` }), projectId: c.a, source: { kind: "chat-turn", id: "turn-real" } })).id;
      await c.meetings.setAgendaState(c.owner, { commandId: cid("st"), itemId: id, expectedRevision: 1, to: "resolved", outcomeNote: `done ${i}` });
      ids.push(id);
    }
    const r = await c.standups.deliverOutcomes(c.host, c.a);
    assert.equal(r.delivered.length, 51);
    assert.deepEqual(r.waiting, []);
    assert.equal(c.outcomes.length, 51);
    assert.equal((await c.meetings.outcomesToReturn(c.host, c.a)).items.length, 0);
    assert.deepEqual((await c.standups.deliverOutcomes(c.host, c.a)).delivered, []);
  });

  suite("a decision on an improvement the proposer has not been told yet is in its next brief and only its own (card M03d)", async (c) => {
    const w = await world(c);
    const id = "imp-aaaaaaaaaaaaaaaaaaaa";
    await c.put("improvement-item", id, { projectId: c.a, title: "Retry flaky builds once", observation: "o", proposedBy: c.pA, owner: c.pA, disposition: "rejected", reason: "Hides real failures", timeboxMinutes: 10, brought: 0, returnPending: true, history: [] });
    await c.standups.prepare(c.host, w.occ);
    const byAgent = Object.fromEntries((await c.standups.briefs(c.owner, w.occ)).map((b) => [b.agent, b])) as Record<string, unknown> as Record<string, BriefBody>;
    const mine = byAgent[c.pA]!.advice.filter((e) => e.cites.some((x) => x.kind === "improvement-item" && x.id === id));
    assert.equal(mine.length, 1);
    assert.match(mine[0]!.text, /was rejected: Hides real failures/);
    assert.ok(!byAgent[c.pB]!.advice.some((e) => e.cites.some((x) => x.id === id)), "another agent's brief does not carry it");
    // Once the brief is stored with it, the service says so, and only for the proposer's decision (at the revision the brief carried).
    const told: [string, number][] = [];
    const tracking = c.make({ onBriefed: async (_by: unknown, item: string, revision: number) => { told.push([item, revision]); } });
    await tracking.prepare(c.host, w.occ);
    assert.deepEqual(told, [[id, 1]]);
  });

  suite("a full list of waiting outcomes never blocks a state change: the outcome goes on an overflow list, is listed again when there is room, is mentioned on the next agenda, and one that fits nowhere is marked", async (c) => {
    const small = c.meetingsWith({ returnsListed: 2, returnsMore: 1 });
    const quiet = c.make({ meetings: small });
    await c.put("chat-turn", "turn-real", { projectId: c.a });
    const make = async (n: number): Promise<string> => (await small.addAgendaItem(c.owner, { ...item({ topic: `Topic ${n}` }), projectId: c.a, source: { kind: "chat-turn", id: "turn-real" } })).id;
    const ids = [await make(1), await make(2), await make(3), await make(4)];
    for (const id of ids) await small.setAgendaState(c.owner, { commandId: cid("st"), itemId: id, expectedRevision: 1, to: "resolved", outcomeNote: "settled" });
    const flag = async (id: string) => (await small.agendaItem(c.owner, id))!.returnUnlisted;
    assert.deepEqual(await Promise.all(ids.map(flag)), [undefined, undefined, true, true]);
    assert.equal((await small.outcomesToReturn(c.host, c.a)).items.length, 2);
    assert.equal(await small.returnsWaiting(c.owner, c.a), 3);
    // The meeting's own agenda says that outcomes are waiting.
    const occ = await c.occurrenceAt("2026-10-21T07:00:00.000Z");
    await quiet.prepare(c.host, occ);
    assert.match((await quiet.agenda(c.owner, occ))!.notes![0]!, /3 outcomes of earlier topics have not yet been told/);
    // Delivering tells the two listed; the next delivery lists the third (room has come) and tells it. The fourth fitted nowhere and is not found again.
    assert.equal((await quiet.deliverOutcomes(c.host, c.a)).delivered.length, 2);
    assert.equal((await quiet.deliverOutcomes(c.host, c.a)).delivered.length, 1);
    assert.equal(await flag(ids[2]!), undefined);
    assert.deepEqual((await quiet.deliverOutcomes(c.host, c.a)).delivered, []);
    assert.equal(c.outcomes.length, 3);
    assert.equal(await flag(ids[3]!), true, "the item says its outcome was never queued");
  });

  suite("a held meeting that defers topics against a full list still defers them; the meeting counts the outcomes that wait and the one that had to wait is told next time", async (c) => {
    await c.put("chat-turn", "turn-real", { projectId: c.a });
    const tight = c.meetingsWith({ returnsListed: 1, returnsMore: 1 });
    const a1 = await tight.addAgendaItem(c.owner, { ...item({ topic: "Held one" }), projectId: c.a, source: { kind: "chat-turn", id: "turn-real" } });
    const a2 = await tight.addAgendaItem(c.owner, { ...item({ topic: "Held two" }), projectId: c.a, source: { kind: "chat-turn", id: "turn-real" } });
    const occ2 = await c.occurrenceAt("2026-10-23T07:00:00.000Z");
    assert.deepEqual((await c.meetings.occurrence(c.owner, occ2))!.agenda.map((i) => i.id).sort(), [a1.id, a2.id].sort());
    await tight.settle(c.host, { commandId: cid("se"), occurrenceId: occ2, outcome: "held" });
    assert.equal((await occurrenceOf(c, occ2)).returnsUnlisted, 1);
    const states = await Promise.all([a1.id, a2.id].map((id) => tight.agendaItem(c.owner, id)));
    assert.equal(states.filter((x) => x!.state === "deferred").length, 2, "both are deferred whatever the list");
    assert.equal(states.filter((x) => x!.returnUnlisted === true).length, 1);
    const tightStandups = c.make({ meetings: tight });
    assert.equal((await tightStandups.deliverOutcomes(c.host, c.a)).delivered.length, 1);
    assert.equal((await tightStandups.deliverOutcomes(c.host, c.a)).delivered.length, 1, "the one that had to wait is told next time");
  });

  // ---- correcting a captured item ---------------------------------------------------------------------------------------------

  suite("a captured item can be corrected while it is open: by its requester or a manager, with the revision read; only the owner can set or change an instruction; the correction is counted and replays once", async (c) => {
    const own = (await c.meetings.addAgendaItem(c.scribe, { ...item({ topic: "Tidy the logs" }), projectId: c.a, question: "Can we shorten them?", context: "They fill the disk." })).id;
    const instruction = (await c.meetings.addAgendaItem(c.owner, { ...item({ topic: "Adopt the new linter" }), projectId: c.a, intent: "owner-instruction" })).id;
    const command = { commandId: cid("co"), itemId: own, expectedRevision: 1, topic: "Tidy the logs and the traces", urgency: "urgent" as const, question: null, context: "They fill the disk fast." };
    const first = await c.meetings.correctAgendaItem(c.scribe, command);
    assert.deepEqual([first.revision, first.replayed], [2, false]);
    const replay = await c.meetings.correctAgendaItem(c.scribe, command);
    assert.deepEqual([replay.revision, replay.replayed], [2, true]);
    const now1 = (await c.meetings.agendaItem(c.owner, own))! as unknown as AgendaBody & { revision: number };
    assert.deepEqual([now1.topic, now1.urgency, now1.question, now1.context, now1.correctionCount, now1.corrections?.length, [...(now1.corrections?.[0]?.fields ?? [])].sort(), now1.corrections?.[0]?.by], ["Tidy the logs and the traces", "urgent", undefined, "They fill the disk fast.", 1, 1, ["context", "question", "topic", "urgency"], c.scribe.id]);
    await refuses("stale_revision", () => c.meetings.correctAgendaItem(c.scribe, { commandId: cid("co"), itemId: own, expectedRevision: 1, topic: "x" }));
    await refuses("invalid_command", () => c.meetings.correctAgendaItem(c.scribe, { commandId: cid("co"), itemId: own, expectedRevision: 2 } as never), (e) => assert.match(e.message, /nothing to correct/));
    await refuses("invalid_command", () => c.meetings.correctAgendaItem(c.scribe, { commandId: cid("co"), itemId: own, expectedRevision: 2, topic: "key sk-abcdefghijklmnopqrstuvwxyz123456" }));
    // Authority: the request type is not the supervisor's to change, in either direction.
    await refuses("forbidden", () => c.meetings.correctAgendaItem(c.scribe, { commandId: cid("co"), itemId: own, expectedRevision: 2, intent: "owner-instruction" }));
    await refuses("forbidden", () => c.meetings.correctAgendaItem(c.mgr, { commandId: cid("co"), itemId: own, expectedRevision: 2, intent: "delegated-decision" }));
    await refuses("forbidden", () => c.meetings.correctAgendaItem(c.mgr, { commandId: cid("co"), itemId: instruction, expectedRevision: 1, topic: "Do not adopt the new linter" }));
    await refuses("forbidden", () => c.meetings.correctAgendaItem(c.mgr, { commandId: cid("co"), itemId: instruction, expectedRevision: 1, intent: "discussion" }));
    await refuses("forbidden", () => c.meetings.correctAgendaItem(c.scribe, { commandId: cid("co"), itemId: own, expectedRevision: 2, category: "conflict" }));
    // Who may touch it: the requester and a manager; another project's manager and an unrelated agent cannot, and the answer is the same as for a missing item.
    await refuses("forbidden", () => c.meetings.correctAgendaItem(c.eve, { commandId: cid("co"), itemId: own, expectedRevision: 2, topic: "x" }));
    await refuses("forbidden", () => c.meetings.correctAgendaItem(c.dev, { commandId: cid("co"), itemId: own, expectedRevision: 2, topic: "x" }));
    await refuses("forbidden", () => c.meetings.correctAgendaItem(c.reader, { commandId: cid("co"), itemId: own, expectedRevision: 2, topic: "x" }));
    await refuses("forbidden", () => c.meetings.correctAgendaItem(c.mgr, { commandId: cid("co"), itemId: "mag-aaaaaaaaaaaaaaaaaaaa", expectedRevision: 1, topic: "x" }));
    await c.meetings.correctAgendaItem(c.mgr, { commandId: cid("co"), itemId: own, expectedRevision: 2, requestedOutcome: "A yes or no", category: "decision", timeboxMinutes: 5 });
    assert.equal((await c.meetings.agendaItem(c.owner, own))!.correctionCount, 2);
    await c.meetings.correctAgendaItem(c.owner, { commandId: cid("co"), itemId: instruction, expectedRevision: 1, topic: "Adopt the newest linter" });
    // A scheduled item can still be corrected; a resolved one is history.
    const occ = await c.occurrenceAt("2026-10-21T07:00:00.000Z");
    assert.equal((await c.meetings.agendaItem(c.owner, own))!.state, "scheduled");
    await c.meetings.correctAgendaItem(c.scribe, { commandId: cid("co"), itemId: own, expectedRevision: 4, urgency: "normal" });
    await c.meetings.setAgendaState(c.owner, { commandId: cid("st"), itemId: own, expectedRevision: 5, to: "resolved" });
    await refuses("invalid_command", () => c.meetings.correctAgendaItem(c.owner, { commandId: cid("co"), itemId: own, expectedRevision: 6, topic: "too late" }));
    void occ;
  });

  // ---- the improvement backlog ------------------------------------------------------------------------------------------------

  suite("improvement proposals carry evidence the proposer may read, group duplicates without losing either proposer's evidence, are timeboxed on the agenda, and are decided with reasons by managers only", async (c) => {
    const mineTask = await c.task("A flaky build", c.agentA, "in_progress");
    const foreignTask = await c.task("Another project's task", undefined, "ready", c.b);
    const im = c.improvements;
    const first = await im.propose(c.dev, { commandId: cid("im"), projectId: c.a, title: "Retry flaky builds once", observation: "Builds fail on network blips.", possibleImprovement: "Retry the fetch step", evidence: [{ kind: "task", id: mineTask }], affectedTasks: [mineTask], timeboxMinutes: 15 });
    const body1 = (await im.get(c.dev, first.id))!;
    assert.deepEqual([body1.disposition, body1.owner, body1.proposedBy, body1.timeboxMinutes, body1.evidence, body1.affectedTasks], ["new", c.dev.id, c.dev.id, 15, [{ kind: "task", id: mineTask }], [mineTask]]);
    assert.equal((await im.propose(c.dev, { commandId: "same", projectId: c.a, title: "t", observation: "o" })).replayed, false);
    assert.equal((await im.propose(c.dev, { commandId: "same", projectId: c.a, title: "t", observation: "o" })).replayed, true);
    // Evidence: the proposer's own readable records of this project only; credentials are refused.
    await refuses("invalid_command", () => im.propose(c.dev, { commandId: cid("im"), projectId: c.a, title: "x", observation: "y", evidence: [{ kind: "task", id: foreignTask }] }), (e) => assert.match(e.message, /may read/));
    await refuses("invalid_command", () => im.propose(c.dev, { commandId: cid("im"), projectId: c.a, title: "x", observation: "y", evidence: [{ kind: "task", id: "task-aaaaaaaaaaaaaaaaaaaa" }] }));
    await refuses("invalid_command", () => im.propose(c.scribe, { commandId: cid("im"), projectId: c.a, title: "x", observation: "y", evidence: [{ kind: "task", id: mineTask }] }), (e) => assert.match(e.message, /may read/));
    await refuses("invalid_command", () => im.propose(c.dev, { commandId: cid("im"), projectId: c.a, title: "x", observation: "key sk-abcdefghijklmnopqrstuvwxyz123456" }));
    await refuses("invalid_command", () => im.propose(c.dev, { commandId: cid("im"), projectId: c.a, title: "x", observation: "y", affectedTasks: [foreignTask] }));
    await refuses("invalid_command", () => im.propose(c.dev, { commandId: cid("im"), projectId: c.a, title: "x", observation: "y", timeboxMinutes: 61 }));
    for (const who of [c.reader, c.plain, c.eve]) await refuses("forbidden", () => im.propose(who, { commandId: cid("im"), projectId: c.a, title: "x", observation: "y" }));
    // A repeat of the same friction by another agent is grouped under the first, with its own evidence.
    const second = await im.propose(c.dev2, { commandId: cid("im"), projectId: c.a, title: "Builds die on network errors", observation: "Same problem, in the nightly.", evidence: [{ kind: "task", id: mineTask }] });
    await refuses("forbidden", () => im.group(c.dev, { commandId: cid("g"), itemId: second.id, expectedRevision: 1, under: first.id, underRevision: 1 }));
    await refuses("stale_revision", () => im.group(c.mgr, { commandId: cid("g"), itemId: second.id, expectedRevision: 5, under: first.id, underRevision: 1 }));
    await refuses("invalid_command", () => im.group(c.mgr, { commandId: cid("g"), itemId: second.id, expectedRevision: 1, under: second.id, underRevision: 1 }));
    await im.group(c.mgr, { commandId: cid("g"), itemId: second.id, expectedRevision: 1, under: first.id, underRevision: 1 });
    const primary = (await im.get(c.mgr, first.id))!;
    const dup = (await im.get(c.dev2, second.id))!;
    assert.deepEqual([primary.duplicates, dup.groupedUnder, dup.evidence, dup.observation], [[second.id], first.id, [{ kind: "task", id: mineTask }], "Same problem, in the nightly."]);
    assert.deepEqual((await im.open(c.mgr, c.a))!.items.map((i) => i.id).filter((id) => id === first.id || id === second.id), [first.id], "a grouped duplicate is not listed on its own");
    await refuses("invalid_command", () => im.group(c.mgr, { commandId: cid("g"), itemId: first.id, expectedRevision: primary.revision, under: second.id, underRevision: dup.revision }));
    await refuses("invalid_command", () => im.decide(c.mgr, { commandId: cid("d"), itemId: second.id, expectedRevision: dup.revision, to: "investigating" }), (e) => assert.match(e.message, /decide that one/));
    // Another project's proposal cannot be grouped in.
    const foreign = await im.propose(c.eve, { commandId: cid("im"), projectId: c.b, title: "x", observation: "y" });
    await refuses("forbidden", () => im.group(c.mgr, { commandId: cid("g"), itemId: foreign.id, expectedRevision: 1, under: first.id, underRevision: primary.revision }));
    // On the agenda, timeboxed, linked to the proposal; once while it is open.
    const brought = await im.bringToStandup(c.mgr, { commandId: cid("b"), itemId: first.id, expectedRevision: primary.revision });
    const agendaItem = (await c.meetings.agendaItem(c.mgr, brought.agendaItemId))!;
    assert.deepEqual([agendaItem.category, agendaItem.timeboxMinutes, agendaItem.link, agendaItem.intent, agendaItem.topic], ["improvement", 15, { kind: "improvement", id: first.id }, "recommendation", "Retry flaky builds once"]);
    const cur = (await im.get(c.mgr, first.id))!;
    assert.equal((await im.bringToStandup(c.mgr, { commandId: cid("b"), itemId: first.id, expectedRevision: cur.revision })).agendaItemId, brought.agendaItemId);
    await refuses("forbidden", () => im.bringToStandup(c.dev, { commandId: cid("b"), itemId: first.id, expectedRevision: cur.revision }));
    await refuses("invalid_command", () => im.bringToStandup(c.mgr, { commandId: cid("b"), itemId: second.id, expectedRevision: dup.revision }));
    await c.meetings.setAgendaState(c.owner, { commandId: cid("st"), itemId: brought.agendaItemId, expectedRevision: agendaItem.revision, to: "resolved" });
    const again = await im.bringToStandup(c.mgr, { commandId: cid("b"), itemId: first.id, expectedRevision: cur.revision });
    assert.notEqual(again.agendaItemId, brought.agendaItemId, "after it was dealt with, bringing it back makes a new point");
    // A link to a proposal the requester may not link is refused.
    await refuses("invalid_command", () => c.meetings.addAgendaItem(c.scribe, { ...item({ topic: "x" }), projectId: c.a, link: { kind: "improvement", id: first.id } }));
    // Decisions: reasons are required, the order is the lifecycle's, final is final, and a task link must be in the project.
    const v = async (): Promise<number> => (await im.get(c.mgr, first.id))!.revision;
    await refuses("forbidden", async () => im.decide(c.dev, { commandId: cid("d"), itemId: first.id, expectedRevision: await v(), to: "accepted" }));
    await refuses("invalid_command", async () => im.decide(c.mgr, { commandId: cid("d"), itemId: first.id, expectedRevision: await v(), to: "adopted", evaluation: "x" }), (e) => assert.match(e.message, /cannot become adopted/));
    await refuses("invalid_command", async () => im.decide(c.mgr, { commandId: cid("d"), itemId: first.id, expectedRevision: await v(), to: "deferred", reason: "busy" }));
    await refuses("invalid_command", async () => im.decide(c.mgr, { commandId: cid("d"), itemId: first.id, expectedRevision: await v(), to: "rejected" }));
    await refuses("invalid_command", async () => im.decide(c.mgr, { commandId: cid("d"), itemId: first.id, expectedRevision: await v(), to: "accepted", taskId: foreignTask }));
    await im.decide(c.mgr, { commandId: cid("d"), itemId: first.id, expectedRevision: await v(), to: "accepted", taskId: mineTask, owner: c.pB });
    assert.deepEqual([(await im.get(c.mgr, first.id))!.disposition, (await im.get(c.mgr, first.id))!.owner, (await im.get(c.mgr, first.id))!.taskId], ["accepted", c.pB, mineTask]);
    await refuses("invalid_command", async () => im.decide(c.mgr, { commandId: cid("d"), itemId: first.id, expectedRevision: await v(), to: "adopted" }), (e) => assert.match(e.message, /evaluation/));
    await im.decide(c.mgr, { commandId: cid("d"), itemId: first.id, expectedRevision: await v(), to: "adopted", evaluation: "Retried builds: failures down from 9 to 1 a week." });
    await refuses("invalid_command", async () => im.decide(c.mgr, { commandId: cid("d"), itemId: first.id, expectedRevision: await v(), to: "stopped", reason: "no" }), (e) => assert.match(e.message, /cannot become/));
    // The decision goes to every proposer of the group, once, and only the controller delivers.
    await refuses("forbidden", () => im.deliverOutcomes(c.mgr, c.a));
    const quiet = c.makeImprovements(false);
    assert.ok((await quiet.deliverOutcomes(c.host, c.a)).waiting.includes(first.id));
    // A sink that could not file it (no task to hang it on) leaves it waiting, not told.
    const unfiled = ImprovementService.withEpoch(c.storage, c.epoch, { meetings: c.meetings }, { outcomes: { deliver: async () => false } });
    assert.ok((await unfiled.deliverOutcomes(c.host, c.a)).waiting.includes(first.id));
    const told = await im.deliverOutcomes(c.host, c.a);
    assert.ok(told.delivered.includes(first.id));
    const notices = c.outcomes.filter((o) => o.kind === "improvement-outcome" && o.refs[0]!.id === first.id);
    assert.deepEqual(notices.map((o) => o.to.id).sort(), [c.dev.id, c.dev2.id].sort());
    assert.ok(notices.every((o) => o.taskId === mineTask), "the outcome names the task it is about, where a notice can be filed");
    assert.match(notices[0]!.text, /was adopted\. Evaluation: Retried builds: failures down from 9 to 1 a week\./);
    assert.match(outcomeLine({ topic: "T", state: "deferred", intent: "discussion", deferral: { reason: "r", nextStep: "n" } }), /Next step: n/);
    assert.deepEqual((await im.deliverOutcomes(c.host, c.a)).delivered.filter((id) => id === first.id), []);
    assert.ok(!(await im.open(c.mgr, c.a))!.items.some((i) => i.id === first.id), "a decided and told proposal leaves the open list");
    // Reading: the proposer, managers and readers; nobody else.
    assert.ok(await im.get(c.dev, first.id));
    assert.equal(await im.get(c.dev2, first.id), undefined);
    assert.equal(await im.get(c.eve, first.id), undefined);
    assert.equal(await im.open(c.dev, c.a), undefined);
    assert.ok(await im.open(c.plain, c.a));
  });
}
