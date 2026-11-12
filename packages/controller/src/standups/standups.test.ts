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
import { AgentMessageService, MESSAGE_LIMITS } from "../messaging/index.js";
import { GrantService, PrincipalService, type Grant, type Principal } from "../security/index.js";
import {
  ImprovementService, StandupService, allocationFrom, needsOwnerFrom, outcomeLine, preparationNoticeSink, type BriefBody, type OutcomeNotice, type PrepNotice, type StandupConfigBody,
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

  suite("the controller can ask which projects have an active stand-up: none, active, paused and ended are told apart (card U11d)", async (c) => {
    assert.equal((await c.standups.activeProjects()).size, 0, "no stand-up yet");
    const made = await c.schedule();
    assert.deepEqual([...await c.standups.activeProjects()], [c.a]);
    let rev = (await c.standups.standup(c.mgr, made.scheduleId))!.schedule.revision;
    await c.standups.update(c.mgr, { commandId: cid("u"), scheduleId: made.scheduleId, expectedRevision: rev, state: "paused" });
    assert.equal((await c.standups.activeProjects()).size, 0, "paused is not scheduled");
    rev = (await c.standups.standup(c.mgr, made.scheduleId))!.schedule.revision;
    await c.standups.update(c.mgr, { commandId: cid("u"), scheduleId: made.scheduleId, expectedRevision: rev, state: "active" });
    assert.deepEqual([...await c.standups.activeProjects()], [c.a]);
    rev = (await c.standups.standup(c.mgr, made.scheduleId))!.schedule.revision;
    await c.standups.update(c.mgr, { commandId: cid("u"), scheduleId: made.scheduleId, expectedRevision: rev, state: "ended" });
    assert.equal((await c.standups.activeProjects()).size, 0, "ended is not scheduled");
  });

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

  suite("the advance notice names the task the agent works on now (in progress first, then ready or blocked) and none for an agent that holds no live task; a finished task is never named (card M03h)", async (c) => {
    await c.task("Finished long ago", c.agentB, "done");
    const ready = await c.task("Next job", c.agentB, "ready");
    const occ = await c.occurrenceAt("2026-10-21T07:00:00.000Z");
    await c.standups.prepare(c.host, occ);
    const first = Object.fromEntries(c.notices.map((n) => [n.agent, n.taskId]));
    assert.equal(first[c.pB], ready, "a ready task is the one named when nothing is in progress");
    assert.equal(first[c.pA], undefined, "an agent with no task has none named");
    assert.equal(first[c.pC], undefined);
    // A second preparation names nothing new for B even once it has a task in progress: it was told once, on the task it held then.
    await c.task("Current job", c.agentB, "in_progress");
    await c.standups.prepare(c.host, occ);
    assert.equal(c.notices.filter((n) => n.agent === c.pB).length, 1);
  });

  suite("through the controller's own messages, the advance notice cannot stop a preparation: a full inbox is told later and the briefs are made, a notice filed before a lost preparation record is not refused once the agent's task changed, and only an agent that was told is recorded as told (card M03h review)", async (c) => {
    const grants = GrantService.withEpoch(c.storage, c.epoch, options);
    for (const p of [c.pA, c.pB, c.pC]) await grants.grant(c.owner, { commandId: cid("g"), grantee: p, action: "task.read", project: c.a, source: "direct", basis: "test" });
    const messages = AgentMessageService.withEpoch(c.storage, c.epoch, { availability: c.pauses.availability, taskPaused: (t) => c.pauses.isPaused(t), guard: (t) => c.pauses.guard(t), waits: c.waits, assignments: c.assignments, ...options });
    const real = preparationNoticeSink(messages);
    let stopAt: string | undefined;
    const standups = c.make({ notices: { notify: async (n: PrepNotice) => { if (n.agent === stopAt) { stopAt = undefined; await real.notify(n); throw new Error("the controller stopped here"); } return real.notify(n); } } });
    const firstJob = await c.task("First job", c.agentA, "ready");
    const bJob = await c.task("B's job", c.agentB, "ready");
    // B holds a task it is not running, so it reads no notices: its inbox is full of the controller's.
    for (let i = 0; i < MESSAGE_LIMITS.perSenderQueue; i++) await messages.noticeFromController({ commandId: cid("old"), taskId: bJob, to: c.pB, purpose: "An older notice", text: "Something from before." });
    const occ = await c.occurrenceAt("2026-10-21T07:00:00.000Z");
    const told = async (to: string): Promise<string[]> => (await c.storage.listAggregates("agent-message", { limit: 500 } as never)).map((m) => m.body as unknown as { to: string; purpose: string; taskId: string }).filter((m) => m.to === to && m.purpose === "A stand-up is coming").map((m) => m.taskId);
    // The controller stops right after A's notice is filed, before the preparation record is written.
    stopAt = c.pA;
    await assert.rejects(standups.prepare(c.host, occ), /stopped here/);
    assert.deepEqual(await told(c.pA), [firstJob]);
    assert.equal(await c.storage.getAggregate({ kind: "standup-prep", id: occ }), undefined);
    // Meanwhile A starts other work, so the task its notice would name now differs from the one it was told on.
    await c.task("Urgent job", c.agentA, "in_progress");
    const r = await standups.prepare(c.host, occ);
    assert.deepEqual(await told(c.pA), [firstJob], "A is not told twice, and the same key on another task does not fail the preparation");
    assert.deepEqual(await told(c.pB), [], "B's full inbox takes nothing");
    assert.deepEqual(r.briefs.map((b) => b.agent).sort(), [c.pA, c.pB, c.pC].sort(), "every brief is made all the same");
    const prepared = (await standups.prepared(c.owner, occ))!;
    assert.deepEqual(Object.keys(prepared.notified), [c.pA], "only the agent that was told is recorded as told: not B (full inbox) nor C (no task)");
    // C takes a task before the meeting: the next preparation tells it, once.
    const cJob = await c.task("C's job", c.agentC, "ready");
    await standups.prepare(c.host, occ);
    await standups.prepare(c.host, occ);
    assert.deepEqual(await told(c.pC), [cJob]);
    assert.deepEqual(Object.keys((await standups.prepared(c.owner, occ))!.notified).sort(), [c.pA, c.pC].sort());
  });

  suite("when an agent holds a ready and an in-progress task, the notice is filed against the one in progress (card M03h)", async (c) => {
    await c.task("Next job", c.agentB, "ready");
    const live = await c.task("Current job", c.agentB, "in_progress");
    const occ = await c.occurrenceAt("2026-10-21T07:00:00.000Z");
    await c.standups.prepare(c.host, occ);
    assert.equal(c.notices.find((n) => n.agent === c.pB)!.taskId, live);
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

  suite("a brief says how many messages wait for the agent at the stand-up, for that agent only, and leaves the line out when counting fails (card U12d)", async (c) => {
    const w = await world(c);
    const counts: Record<string, number> = { [c.pA]: 2, [c.pB]: 1 };
    const withCounts = c.make({ waitingMessages: async (_by: unknown, agent: string) => { if (agent === c.pC) throw new Error("inbox unreadable"); return counts[agent] ?? 0; } } as never);
    await withCounts.prepare(c.host, w.occ);
    const byAgent = Object.fromEntries((await withCounts.briefs(c.owner, w.occ)).map((b) => [b.agent, b as unknown as BriefBody]));
    assert.ok(byAgent[c.pA]!.advice.some((e) => /^2 messages are waiting for you\. Read them at this stand-up/.test(e.text)));
    assert.ok(byAgent[c.pB]!.advice.some((e) => /^1 message is waiting for you\. Read it at this stand-up/.test(e.text)));
    assert.ok(!byAgent[c.pC]!.advice.some((e) => /waiting for you/.test(e.text)), "a failed count leaves the line out");
    // The count follows the inbox: when nothing waits any more the line goes.
    counts[c.pA] = 0;
    await withCounts.prepare(c.host, w.occ);
    const again = (await withCounts.briefs(c.owner, w.occ)).find((b) => b.agent === c.pA) as unknown as BriefBody;
    assert.ok(!again.advice.some((e) => /waiting for you/.test(e.text)));
  });

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
    await refuses("forbidden", () => c.standups.addStatement(c.host, { commandId: cid("st"), briefId: mineId, expectedRevision: b2.revision, section: "note", text: "hello" }));
    await refuses("stale_revision", () => c.standups.addStatement(c.asA, { commandId: cid("st"), briefId: mineId, expectedRevision: b0.revision, section: "note", text: "hello" }));
    // The owner may leave a note on the agent's brief (card M03h); it is kept as the owner's and never reads as the agent's own words. It counts toward the same limit.
    await c.standups.addStatement(c.owner, { commandId: cid("st"), briefId: mineId, expectedRevision: b2.revision, section: "note", text: "Please also look at the cache size." });
    const bo = (await c.standups.brief(c.asA, mineId))!;
    assert.deepEqual(bo.statements.map((x) => [x.section, x.by ?? "agent"]), [["advice", "agent"], ["note", "owner"]]);
    await refuses("invalid_command", () => c.standups.addStatement(c.asA, { commandId: cid("st"), briefId: mineId, expectedRevision: b2.revision, section: "note", text: "key sk-abcdefghijklmnopqrstuvwxyz123456" }));
    await refuses("invalid_command", () => c.standups.addStatement(c.asA, { commandId: cid("st"), briefId: mineId, expectedRevision: b2.revision, section: "plan" as never, text: "x" }));
    let revision = bo.revision;
    for (let i = 2; i < 10; i++) { await c.standups.addStatement(c.asA, { commandId: cid("st"), briefId: mineId, expectedRevision: revision, section: "note", text: `note ${i}` }); revision++; }
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
    const pExport = await c.task("Ship the export", c.agentA, "in_progress");
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
    // With attempts on record, the use is the worker-slot time of the attempts in the period, by the class of each attempt's task (card M03h): 2 hours on P work and 1 hour on PC work make a PC share of 33%.
    const proj = c.a;
    at("2026-10-20T10:00:00.000Z"); await c.put("dispatch", "att-slot-p", { attemptId: "att-slot-p", taskId: pExport, projectId: proj, state: "finished", startedAt: "2026-10-20T08:00:00.000Z", claimedAt: "2026-10-20T08:00:00.000Z" });
    at("2026-10-20T13:00:00.000Z"); await c.put("dispatch", "att-slot-pc", { attemptId: "att-slot-pc", taskId: pcWork, projectId: proj, state: "finished", startedAt: "2026-10-20T12:00:00.000Z", claimedAt: "2026-10-20T12:00:00.000Z" });
    at("2026-10-20T13:30:00.000Z"); await c.put("dispatch", "att-other-project", { attemptId: "att-other-project", taskId: pcWork, projectId: "prj-elsewhere", state: "finished", startedAt: "2026-10-20T08:00:00.000Z", claimedAt: "2026-10-20T08:00:00.000Z" });
    at("2026-10-21T05:00:00.000Z");
    const slot = (await c.make({}).prepare(c.host, occ)).review.lines.map((l) => l.text).join("\n");
    assert.match(slot, /actual PC share 33% \(worker-slot time of 2 attempts\)/);
    // The exact end time is used for a finished attempt (not the last update of its record), and an attempt that parked and came back is left out and said to be: its first start would count the waiting as running (card M03h).
    at("2026-10-20T20:00:00.000Z"); await c.put("dispatch", "att-slot-late", { attemptId: "att-slot-late", taskId: pExport, projectId: proj, state: "finished", startedAt: "2026-10-20T14:00:00.000Z", claimedAt: "2026-10-20T14:00:00.000Z", outcome: { status: "succeeded", summary: "done", at: "2026-10-20T15:00:00.000Z" } });
    at("2026-10-20T20:00:00.000Z"); await c.put("dispatch", "att-slot-parked", { attemptId: "att-slot-parked", taskId: pcWork, projectId: proj, state: "finished", startedAt: "2026-10-20T08:00:00.000Z", claimedAt: "2026-10-20T08:00:00.000Z", requests: 2, outcome: { status: "succeeded", summary: "done", at: "2026-10-20T19:00:00.000Z" } });
    at("2026-10-21T05:00:00.000Z");
    const slot2 = (await c.make({}).prepare(c.host, occ)).review.lines.map((l) => l.text).join("\n");
    assert.match(slot2, /actual PC share 25% \(worker-slot time of 3 attempts; 1 older record that parked or was placed again is not counted/);
    // The usage sink (card M03h): a record with slot spans counts its runs, not the time it waited between them. This PC attempt ran 09:00-10:00, parked for an approval until 16:00 and ran 16:00-17:00:
    // 2 hours of PC time, not the 8 from its first start to its end.
    at("2026-10-20T20:00:00.000Z"); await c.put("dispatch", "att-slot-spans", { attemptId: "att-slot-spans", taskId: pcWork, projectId: proj, state: "finished", startedAt: "2026-10-20T09:00:00.000Z", claimedAt: "2026-10-20T09:00:00.000Z", requests: 2, resumedFor: ["op-1"], slotSpans: [{ from: "2026-10-20T09:00:00.000Z", to: "2026-10-20T10:00:00.000Z" }, { from: "2026-10-20T16:00:00.000Z", to: "2026-10-20T17:00:00.000Z" }], outcome: { status: "succeeded", summary: "done", at: "2026-10-20T17:00:00.000Z" } });
    at("2026-10-21T05:00:00.000Z");
    const slot3 = (await c.make({}).prepare(c.host, occ)).review.lines.map((l) => l.text).join("\n");
    // P: 2 h + 1 h = 3 h; PC: 1 h + 2 h (the spans, not the 8 hours from the first start to the end) = 3 h; the older parked record is still left out.
    assert.match(slot3, /actual PC share 50% \(worker-slot time of 4 attempts; 1 older record that parked or was placed again is not counted/);
    // A record whose oldest spans were let go inside the period counts what it keeps and says so; a span before the period and one that is still open on a running attempt are cut to the period.
    at("2026-10-20T20:00:00.000Z"); await c.put("dispatch", "att-slot-cut", { attemptId: "att-slot-cut", taskId: pExport, projectId: proj, state: "running", startedAt: "2026-10-19T09:00:00.000Z", claimedAt: "2026-10-19T09:00:00.000Z", slotSpansCut: "2026-10-20T08:00:00.000Z", slotSpans: [{ from: "2026-10-20T09:00:00.000Z", to: "2026-10-20T10:00:00.000Z" }, { from: "2026-10-21T04:00:00.000Z" }] });
    at("2026-10-21T05:00:00.000Z");
    const slot4 = (await c.make({}).prepare(c.host, occ)).review.lines.map((l) => l.text).join("\n");
    // P: 3 h + 1 h + 1 h (04:00 to the review at 05:00) = 5 h; PC 3 h: 3 / 8 = 38%.
    assert.match(slot4, /actual PC share 38% \(worker-slot time of 5 attempts; 1 older record that parked or was placed again is not counted, as its run time is not recorded; the earliest runs of 1 attempt are not on record\)/);
    // A record that ran before the sink inside the period and has just opened its first span holds no recorded time in the period yet; its missing runs are still said to be missing.
    at("2026-10-20T20:00:00.000Z"); await c.put("dispatch", "att-slot-new", { attemptId: "att-slot-new", taskId: pcWork, projectId: proj, state: "running", startedAt: "2026-10-20T09:00:00.000Z", claimedAt: "2026-10-20T09:00:00.000Z", slotSpansCut: "2026-10-20T12:00:00.000Z", slotSpans: [{ from: "2026-10-21T05:00:00.000Z" }] });
    at("2026-10-21T05:00:00.000Z");
    const slot5 = (await c.make({}).prepare(c.host, occ)).review.lines.map((l) => l.text).join("\n");
    assert.match(slot5, /actual PC share 38% \(worker-slot time of 5 attempts; 1 older record that parked or was placed again is not counted, as its run time is not recorded; the earliest runs of 2 attempts are not on record\)/);
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
    for (const who of [c.plain, c.reader, c.mgr, c.asA, c.host]) { assert.equal((await c.standups.agenda(who, occ))?.needsOwner, undefined, who.id); assert.equal((await c.standups.prepared(who, occ))?.needsOwner, undefined, who.id); }
    assert.ok((await c.standups.prepared(c.owner, occ))!.needsOwner !== undefined);
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

  suite("the owner's list is the owner's alone (not a host's or a service's), is kept as first stored for a meeting that has started or been reported, and a repeated count does not rewrite the preparation", async (c) => {
    const occ = await c.occurrenceAt("2026-10-21T07:00:00.000Z");
    at("2026-10-21T05:00:00.000Z");
    const svc: Principal = { ...c.host, kind: "service" } as Principal;
    let lines = [{ text: "Approve the key, waiting since 1.", cites: [{ kind: "notification-item", id: "ntf-1", revision: 1 }] }];
    const s = c.make({ ownerItems: async () => lines });
    await s.prepare(c.host, occ);
    assert.ok((await c.standups.prepared(c.owner, occ))!.needsOwner !== undefined);
    for (const who of [c.host, svc]) { assert.equal((await c.standups.prepared(who, occ))?.needsOwner, undefined, who.kind); assert.equal((await c.standups.agenda(who, occ))?.needsOwner, undefined, who.kind); }
    // A repeated notice (same item, higher count and revision) does not rewrite the record; a new item does.
    const rev = async (): Promise<number> => (await c.storage.getAggregate({ kind: "standup-prep", id: occ }))!.revision;
    const r0 = await rev();
    lines = [{ text: "Approve the key (reported 3 times), waiting since 1.", cites: [{ kind: "notification-item", id: "ntf-1", revision: 4 }] }];
    at("2026-10-21T05:05:00.000Z");
    await s.prepare(c.host, occ);
    assert.equal(await rev(), r0, "a changed count alone writes nothing");
    lines = [...lines, { text: "Second item", cites: [{ kind: "notification-item", id: "ntf-2", revision: 1 }] }];
    await s.prepare(c.host, occ);
    assert.ok(await rev() > r0, "a new item is stored");
    assert.equal((await c.standups.prepared(c.owner, occ))!.needsOwner!.length, 2);
    // Once the meeting has started, the stored list stays as it was.
    at("2026-10-21T07:30:00.000Z");
    lines = [{ text: "Only today's item", cites: [{ kind: "notification-item", id: "ntf-9", revision: 1 }] }];
    await s.prepare(c.host, occ);
    assert.deepEqual((await c.standups.prepared(c.owner, occ))!.needsOwner!.map((l) => l.cites[0]!.id), ["ntf-1", "ntf-2"]);
  });

  suite("a reported (catch-up) occurrence is not given today's owner list", async (c) => {
    at("2026-10-23T08:00:00.000Z");
    await c.schedule({ time: "09:00", windowFrom: "08:00", windowTo: "10:00" });
    at("2026-10-29T12:00:00.000Z");
    const made = (await c.meetings.tick(c.host)).created;
    const occ = made[made.length - 1]!.occurrenceId;
    assert.equal((await occurrenceOf(c, occ)).state, "reported");
    const s = c.make({ ownerItems: async () => [{ text: "Today's item", cites: [{ kind: "notification-item", id: "ntf-t", revision: 1 }] }] });
    await s.prepare(c.host, occ);
    assert.equal((await c.standups.prepared(c.owner, occ))!.needsOwner, undefined);
  });

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
    // A decision that is still waiting shows up for the owner only once it is old enough (card M03e), and only to the controller.
    await refuses("forbidden", () => im.untold(c.mgr, c.a, 0));
    await refuses("invalid_command", () => im.untold(c.host, c.a, -1));
    const day = 86_400_000;
    assert.deepEqual((await im.untold(c.host, c.a, 3 * day)).map((x) => x.id), [], "a fresh decision is not shown");
    const decidedAt = now;
    at(new Date(decidedAt + 4 * day).toISOString());
    const stale = await im.untold(c.host, c.a, 3 * day);
    assert.deepEqual(stale.filter((x) => x.id === first.id).map((x) => [x.disposition, x.title]), [["adopted", "Retry flaky builds once"]]);
    at(new Date(decidedAt).toISOString());
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

  suite("the project's stand-ups are told by their latest occurrence, most recent first, to those who may read its meetings; the limit is honoured and a stand-up that has not met yet is left out (card M03h)", async (c) => {
    const daily = await c.schedule();
    const weekly = await c.schedule({ title: "Weekly review", time: "10:00", windowTo: "11:00" });
    at("2026-10-23T07:00:00.000Z");
    const created = (await c.meetings.tick(c.host)).created;
    const dailyOcc = created.find((x) => x.scheduleId === daily.scheduleId)!.occurrenceId;
    const weeklyOcc = created.find((x) => x.scheduleId === weekly.scheduleId)!.occurrenceId;
    await c.meetings.settle({ ...c.host, kind: "service" } as Principal, { commandId: "s1", occurrenceId: dailyOcc, outcome: "held" });
    await c.schedule({ title: "Not yet met" });
    const got = await c.standups.recent(c.owner, c.a);
    assert.ok(got !== undefined);
    assert.deepEqual(got.items.map((x) => [x.title, x.startsAt, x.state]), [["Weekly review", "2026-10-23T08:00:00.000Z", "planned"], ["Daily stand-up", "2026-10-23T07:00:00.000Z", "held"]]);
    assert.deepEqual(got.items.map((x) => x.occurrenceId), [weeklyOcc, dailyOcc]);
    assert.ok(got.items.every((x) => x.revision >= 1));
    assert.equal(got.more, false);
    const one = await c.standups.recent(c.owner, c.a, { limit: 1 });
    assert.deepEqual(one!.items.map((x) => x.title), ["Weekly review"]);
    assert.equal(one!.more, true, "the stand-up left out is told");
    assert.deepEqual((await c.standups.recent(c.reader, c.a))!.items.map((x) => x.occurrenceId), [weeklyOcc, dailyOcc], "a reader of the project's meetings sees them too");
    assert.equal(await c.standups.recent(c.eve, c.a), undefined, "a manager of another project sees none");
    assert.deepEqual(await c.standups.recent(c.owner, c.b), { items: [], more: false }, "a project with no stand-ups answers an empty list");
    await refuses("invalid_command", () => c.standups.recent(c.owner, c.a, { limit: 0 }));
    await refuses("invalid_command", () => c.standups.recent(c.owner, c.a, { limit: 51 }));
  });

  suite("the project's stand-ups are told as schedules, each with the meeting coming up next and the one last held; one that has not met is shown and ended ones are counted and left out unless asked for (card M03h)", async (c) => {
    const daily = await c.schedule();
    const later = await c.schedule({ title: "Later review", time: "10:00", windowTo: "11:00" });
    at("2026-10-23T07:00:00.000Z");
    const created = (await c.meetings.tick(c.host)).created;
    const dailyOcc = created.find((x) => x.scheduleId === daily.scheduleId)!.occurrenceId;
    await c.meetings.settle({ ...c.host, kind: "service" } as Principal, { commandId: "s1", occurrenceId: dailyOcc, outcome: "held" });
    // Made after the clock passed: these have no meeting of their own yet.
    const fresh = await c.schedule({ title: "Not yet met" });
    const weekly = await c.schedule({ title: "Weekly review", recurrence: { kind: "weekly", days: [3, 1] }, time: "10:30", windowTo: "11:00" });
    const once = await c.schedule({ title: "One-off", recurrence: { kind: "once", date: "2026-11-02" }, time: "09:30" });

    const got = (await c.standups.overview(c.owner, c.a))!;
    assert.deepEqual(got.items.map((x) => [x.title, x.state, x.recurrence, x.nextAt ?? "-", x.lastAt ?? "-"]), [
      ["Later review", "active", "daily", "2026-10-23T08:00:00.000Z", "-"],
      ["Daily stand-up", "active", "daily", "-", "2026-10-23T07:00:00.000Z"],
      ["Not yet met", "active", "daily", "-", "-"],
      ["One-off", "active", "once on 2026-11-02", "-", "-"],
      ["Weekly review", "active", "weekly on Mon, Wed", "-", "-"],
    ], "the one with a meeting ahead comes first, then the rest by title");
    assert.deepEqual([got.more, got.ended], [false, 0]);
    const met = got.items.find((x) => x.scheduleId === daily.scheduleId)!;
    assert.deepEqual([met.lastOccurrenceId, met.lastState, met.lastRevision, met.occurrences, met.revision], [dailyOcc, "held", 2, 1, met.revision], "the last meeting is the one that was settled, with the revision to cite");
    assert.deepEqual([met.time, met.timeZone, met.durationMinutes, met.window, met.roster], ["09:00", "Europe/Berlin", 30, { from: "08:00", to: "10:00" }, [c.pA, c.pB].sort()]);
    const ahead = got.items.find((x) => x.scheduleId === later.scheduleId)!;
    assert.ok(ahead.nextOccurrenceId !== undefined && ahead.nextRevision !== undefined && ahead.lastAt === undefined, "a meeting ahead, none held yet");
    assert.deepEqual([got.items.find((x) => x.scheduleId === fresh.scheduleId)!.occurrences, got.items.find((x) => x.scheduleId === weekly.scheduleId)!.occurrences], [0, 0], "a stand-up that has not met is told, not left out");
    assert.ok(got.items.every((x) => x.scheduleId !== "" && x.title !== ""));
    assert.ok((await c.standups.overview(c.owner, c.a))!.items.find((x) => x.scheduleId === once.scheduleId) !== undefined);

    // The limit pages the shown kind; `more` says some were left out.
    const one = (await c.standups.overview(c.owner, c.a, { limit: 2 }))!;
    assert.deepEqual(one.items.map((x) => x.title), ["Later review", "Daily stand-up"]);
    assert.equal(one.more, true);

    // An ended stand-up is counted but not shown, unless asked for.
    const rev = (await c.meetings.schedule(c.owner, once.scheduleId))!.revision;
    await c.standups.update(c.mgr, { commandId: cid("u"), scheduleId: once.scheduleId, expectedRevision: rev, state: "ended" });
    const after = (await c.standups.overview(c.owner, c.a))!;
    assert.ok(!after.items.some((x) => x.scheduleId === once.scheduleId), "an ended stand-up is not one the project is running");
    assert.equal(after.ended, 1);
    const withEnded = (await c.standups.overview(c.owner, c.a, { includeEnded: true }))!;
    assert.deepEqual([withEnded.items.filter((x) => x.scheduleId === once.scheduleId).map((x) => x.state), withEnded.ended], [["ended"], 0]);

    // Who may read it: whoever may read the project's meetings; anyone else gets nothing, and a readable project with none answers an empty list.
    assert.deepEqual((await c.standups.overview(c.reader, c.a))!.items.map((x) => x.title), after.items.map((x) => x.title));
    assert.equal(await c.standups.overview(c.eve, c.a), undefined, "a manager of another project sees none");
    assert.equal(await c.standups.overview(c.dev, c.a), undefined, "an agenda writer without the meeting read sees none");
    assert.deepEqual(await c.standups.overview(c.owner, c.b), { items: [], more: false, ended: 0 }, "a project with no stand-ups answers an empty list");
    await refuses("invalid_command", () => c.standups.overview(c.owner, "nope!", {}));
    await refuses("invalid_command", () => c.standups.overview(c.owner, c.a, { limit: 0 }));
    await refuses("invalid_command", () => c.standups.overview(c.owner, c.a, { limit: 51 }));
  });

  // ---- questions the meeting asks the owner (card M03h) ---------------------------------------------------------------------

  suite("a topic settled with a question for the owner keeps it as a record of its own: bounded, readable by those who read the meetings, answered by the owner alone and once, announced once through the sink (card M03h)", async (c) => {
    at("2026-10-20T09:00:00.000Z");
    const settle = async (topic: string, question: string | undefined, to: "resolved" | "deferred" | "queued" = "resolved", agendaState?: { itemId: string; revision: number }): Promise<string> => {
      const made = agendaState ?? await (async () => { const m = await c.meetings.addAgendaItem(c.owner, { ...item({ topic }), projectId: c.a }); return { itemId: m.id, revision: (await c.meetings.agendaItem(c.owner, m.id))!.revision }; })();
      await c.meetings.setAgendaState(c.owner, { commandId: cid("st"), itemId: made.itemId, expectedRevision: made.revision, to, ...(to === "deferred" ? { reason: "later", nextStep: "ask" } : {}), ...(question === undefined ? {} : { ownerQuestion: question }) });
      return made.itemId;
    };
    // A queued item has no outcome yet; a credential-shaped or over-long question is not recorded; nothing is created by the refusals.
    const queued = await c.meetings.addAgendaItem(c.owner, { ...item({ topic: "Too early" }), projectId: c.a });
    await refuses("invalid_command", () => c.meetings.setAgendaState(c.owner, { commandId: cid("st"), itemId: queued.id, expectedRevision: 1, to: "queued", ownerQuestion: "Why?" } as never));
    await refuses("invalid_command", () => settle("Secrets", "Use key sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD"));
    await refuses("invalid_command", () => settle("Long", "x".repeat(501)));
    // An agent may raise and settle its own topic, but not make the meeting ask the owner (that is an inquiry, with its task); an agent that manages meetings may not either.
    const own = await c.meetings.addAgendaItem(c.dev, { ...item({ topic: "Agent's own" }), projectId: c.a });
    await refuses("forbidden", () => c.meetings.setAgendaState(c.dev, { commandId: cid("st"), itemId: own.id, expectedRevision: 1, to: "resolved", ownerQuestion: "Can I have more budget?" }), (e) => assert.match(e.message, /ask the owner/));
    await refuses("forbidden", () => c.meetings.setAgendaState(c.mgr, { commandId: cid("st"), itemId: own.id, expectedRevision: 1, to: "resolved", ownerQuestion: "Can it have more budget?" }));
    await c.meetings.setAgendaState(c.dev, { commandId: cid("st"), itemId: own.id, expectedRevision: 1, to: "resolved", outcomeNote: "Done." });
    assert.equal((await c.standups.ownerQuestions(c.owner, c.a)).open.length, 0);

    const first = await settle("Backups", "Keep seven nightly backups or thirty?", "deferred");
    const listed = await c.standups.ownerQuestions(c.owner, c.a);
    assert.equal(listed.open.length, 1);
    const q = listed.open[0]!;
    assert.deepEqual([q.topic, q.question, q.state, q.agendaItemId, q.askedBy], ["Backups", "Keep seven nightly backups or thirty?", "open", first, c.owner.id]);
    assert.equal((await c.meetings.agendaItem(c.owner, first))!.ownerQuestionId, q.id, "the topic points at its question");
    // Readers of the project's meetings see it; others do not.
    assert.equal((await c.standups.ownerQuestions(c.reader, c.a)).open.length, 1);
    await refuses("forbidden", () => c.standups.ownerQuestions(c.eve, c.a));

    // Only the owner answers, on the current revision, once.
    await refuses("forbidden", () => c.standups.answerQuestion(c.host, { commandId: cid("an"), questionId: q.id, expectedRevision: q.revision, answer: "thirty" }));
    await refuses("forbidden", () => c.standups.answerQuestion(c.mgr, { commandId: cid("an"), questionId: q.id, expectedRevision: q.revision, answer: "thirty" }));
    await refuses("stale_revision", () => c.standups.answerQuestion(c.owner, { commandId: cid("an"), questionId: q.id, expectedRevision: q.revision + 1, answer: "thirty" }));
    await refuses("invalid_command", () => c.standups.answerQuestion(c.owner, { commandId: cid("an"), questionId: q.id, expectedRevision: q.revision, answer: "token sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD" }));
    await refuses("invalid_command", () => c.standups.answerQuestion(c.owner, { commandId: cid("an"), questionId: "not-an-id", expectedRevision: 1, answer: "x" }));
    const answerId = cid("an");
    await c.standups.answerQuestion(c.owner, { commandId: answerId, questionId: q.id, expectedRevision: q.revision, answer: "thirty" });
    await c.standups.answerQuestion(c.owner, { commandId: answerId, questionId: q.id, expectedRevision: q.revision, answer: "thirty" });
    await refuses("invalid_command", () => c.standups.answerQuestion(c.owner, { commandId: cid("an"), questionId: q.id, expectedRevision: q.revision + 1, answer: "again" }), (e) => assert.match(e.message, /already answered/));
    const done = await c.standups.ownerQuestions(c.owner, c.a);
    assert.equal(done.open.length, 0);
    assert.deepEqual(done.answered.map((x) => [x.state, x.answer]), [["answered", "thirty"]]);

    // At most ten are open at a time; the eleventh waits until one is answered. The answered list keeps the newest ten.
    for (let i = 0; i < 10; i++) await settle(`Topic ${i}`, `Question ${i}?`);
    await refuses("unavailable", () => settle("One too many", "Question 10?"), (e) => assert.match(e.message, /already open/));
    const full = await c.standups.ownerQuestions(c.owner, c.a);
    assert.equal(full.open.length, 10);
    for (const open of full.open.slice(0, 3)) await c.standups.answerQuestion(c.owner, { commandId: cid("an"), questionId: open.id, expectedRevision: open.revision, answer: `A ${open.topic}` });
    await settle("Now it fits", "Question 11?");
    for (let i = 0; i < 8; i++) { const now = (await c.standups.ownerQuestions(c.owner, c.a)).open[0]!; await c.standups.answerQuestion(c.owner, { commandId: cid("an"), questionId: now.id, expectedRevision: now.revision, answer: `B ${i}` }); }
    const end = await c.standups.ownerQuestions(c.owner, c.a);
    assert.equal(end.answered.length, 10, "the newest ten answers are kept");
    assert.equal(end.answered[0]!.answer, "B 7", "newest first");
    assert.equal(end.answered.some((x) => x.answer === "thirty"), false, "the oldest fell off the list (its record stays)");
    assert.equal((await c.meetings.ownerQuestion(c.owner, q.id))!.answer, "thirty");
  });

  suite("the owner is told of a question once through the sink, retried while the sink says no, and the agenda shows what was asked and answered (card M03h)", async (c) => {
    at("2026-10-20T09:00:00.000Z");
    const told: { key: string; topic: string; question: string; source?: { kind: string; id: string } }[] = [];
    let accept = false;
    let throws = false;
    const s = c.make({ ownerQuestions: { raise: async (n: { key: string; topic: string; question: string; source?: { kind: string; id: string } }) => { if (throws) throw new Error("inbox down"); if (!accept) return false; told.push(n); } } } as never);
    await c.put("chat-turn", "turn-9", { projectId: c.a });
    const m = await c.meetings.addAgendaItem(c.owner, { ...item({ topic: "Old API" }), projectId: c.a, source: { kind: "chat-turn", id: "turn-9" } } as never);
    await c.meetings.setAgendaState(c.owner, { commandId: cid("st"), itemId: m.id, expectedRevision: 1, to: "resolved", outcomeNote: "Agreed.", ownerQuestion: "Which release is the last?" });
    // Only the controller delivers.
    await refuses("forbidden", () => s.deliverOutcomes(c.mgr, c.a));
    // The sink says no, or breaks: the question stays unannounced and is reported as waiting; the outcome delivery is not affected.
    const waiting = await s.deliverOutcomes(c.owner, c.a);
    assert.equal(waiting.questions?.waiting.length, 1);
    throws = true;
    assert.equal((await s.deliverOutcomes(c.owner, c.a)).questions?.waiting.length, 1);
    throws = false; accept = true;
    const sent = await s.deliverOutcomes(c.owner, c.a);
    assert.equal(sent.questions?.told.length, 1);
    assert.deepEqual(told.map((t) => [t.topic, t.question, t.source]), [["Old API", "Which release is the last?", { kind: "chat-turn", id: "turn-9" }]]);
    assert.equal((await s.deliverOutcomes(c.owner, c.a)).questions, undefined, "told once");
    assert.equal(told.length, 1);
    // Without a sink nothing is announced and the question is reported as waiting.
    const bare = c.make({} as never);
    const m2 = await c.meetings.addAgendaItem(c.owner, { ...item({ topic: "Logging" }), projectId: c.a });
    await c.meetings.setAgendaState(c.owner, { commandId: cid("st"), itemId: m2.id, expectedRevision: 1, to: "resolved", ownerQuestion: "Which level?" });
    assert.equal((await bare.deliverOutcomes(c.owner, c.a)).questions?.waiting.length, 1);

    // The next agenda lists what is open and what was answered, with the records; an agent on the roster does not read the owner's answers.
    const open = (await s.ownerQuestions(c.owner, c.a)).open;
    const old = open.find((x) => x.topic === "Old API")!;
    await s.answerQuestion(c.owner, { commandId: cid("an"), questionId: old.id, expectedRevision: old.revision, answer: "Release 2.0" });
    const occ = await c.occurrenceAt("2026-10-21T08:00:00.000Z");
    const agenda = (await s.agenda(c.owner, occ))!;
    assert.equal(agenda.ownerQuestions?.open.length, 1);
    assert.match(agenda.ownerQuestions!.open[0]!.text, /Which level\?" No answer yet/);
    assert.match(agenda.ownerQuestions!.answered[0]!.text, /The owner answered: "Release 2\.0"/);
    assert.equal(agenda.ownerQuestions!.answered[0]!.cites[0]!.kind, "owner-question");
    const asAgent = await s.agenda(c.asA, occ);
    assert.equal(asAgent?.ownerQuestions, undefined, "a roster member without the records' grants does not read them");
  });

  suite("an answer that lands while the question is being announced still closes the announcement (card M03h review)", async (c) => {
    at("2026-10-20T09:00:00.000Z");
    const closed: string[] = [];
    const s = c.make({
      // The owner answers (straight through the meeting service, as a racing request would) while the notification is being filed.
      ownerQuestions: { raise: async (n: { questionId: string }) => { const q = (await c.meetings.ownerQuestion(c.owner, n.questionId))!; await c.meetings.answerOwnerQuestion(c.owner, { commandId: cid("an"), questionId: q.id, expectedRevision: q.revision, answer: "Release 3" }); return true; } },
      onOwnerAnswered: async (q: { questionId: string }) => { closed.push(q.questionId); },
    } as never);
    const m = await c.meetings.addAgendaItem(c.owner, { ...item({ topic: "Racing" }), projectId: c.a });
    await c.meetings.setAgendaState(c.owner, { commandId: cid("st"), itemId: m.id, expectedRevision: 1, to: "resolved", ownerQuestion: "Which release?" });
    const id = (await c.meetings.agendaItem(c.owner, m.id))!.ownerQuestionId!;
    assert.deepEqual((await s.deliverOutcomes(c.owner, c.a)).questions?.told, [id]);
    assert.deepEqual(closed, [id], "the notification filed after the answer is closed");
    // An ordinary announcement, with no answer yet, closes nothing.
    const quiet = c.make({ ownerQuestions: { raise: async () => true }, onOwnerAnswered: async (q: { questionId: string }) => { closed.push(q.questionId); } } as never);
    const m2 = await c.meetings.addAgendaItem(c.owner, { ...item({ topic: "Calm" }), projectId: c.a });
    await c.meetings.setAgendaState(c.owner, { commandId: cid("st"), itemId: m2.id, expectedRevision: 1, to: "resolved", ownerQuestion: "Which level?" });
    assert.equal((await quiet.deliverOutcomes(c.owner, c.a)).questions?.told.length, 1);
    assert.deepEqual(closed, [id]);
  });

  suite("a task credential settles only the topics its agent owns, whatever management grant it carries (card M03h follow-up 3)", async (c) => {
    at("2026-10-20T09:00:00.000Z");
    const scope = { projectId: c.a, taskId: "task-aaaaaaaaaaaaaaaaaaaa" };
    const theirs = await c.meetings.addAgendaItem(c.dev, { ...item({ topic: "Dev's topic" }), projectId: c.a });
    const mgrTask = { ...c.mgr, taskScope: scope } as Principal;
    // The manager's own credential may settle it; the same manager's task credential may not.
    await refuses("forbidden", () => c.meetings.setAgendaState(mgrTask, { commandId: cid("st"), itemId: theirs.id, expectedRevision: 1, to: "resolved", outcomeNote: "Settled by a task." }));
    assert.equal((await c.meetings.agendaItem(c.owner, theirs.id))!.state, "queued");
    // The owner of the topic settles it with a task credential, and a manager still settles with its own.
    await c.meetings.setAgendaState({ ...c.dev, taskScope: scope } as Principal, { commandId: cid("st"), itemId: theirs.id, expectedRevision: 1, to: "resolved", outcomeNote: "Done." });
    const other = await c.meetings.addAgendaItem(c.dev, { ...item({ topic: "Another" }), projectId: c.a });
    await c.meetings.setAgendaState(c.mgr, { commandId: cid("st"), itemId: other.id, expectedRevision: 1, to: "resolved", outcomeNote: "Manager settles." });
  });

  suite("the agenda says in plain words that a full set of open questions blocks new ones (card M03h follow-up 4)", async (c) => {
    at("2026-10-20T09:00:00.000Z");
    const ask = async (i: number): Promise<void> => {
      const m = await c.meetings.addAgendaItem(c.owner, { ...item({ topic: `Topic ${i}` }), projectId: c.a });
      await c.meetings.setAgendaState(c.owner, { commandId: cid("st"), itemId: m.id, expectedRevision: 1, to: "resolved", ownerQuestion: `Question ${i}?` });
    };
    for (let i = 0; i < 9; i++) await ask(i);
    const occ = await c.occurrenceAt("2026-10-21T08:00:00.000Z");
    assert.equal(((await c.standups.agenda(c.owner, occ))!.notes ?? []).some((n) => /most a project holds/.test(n)), false, "nine open questions leave room");
    await ask(9);
    const full = (await c.standups.agenda(c.owner, occ))!;
    assert.ok((full.notes ?? []).some((n) => /10 questions to the owner are open.*most a project holds.*cannot ask another/.test(n)), JSON.stringify(full.notes));
    const first = (await c.standups.ownerQuestions(c.owner, c.a)).open[0]!;
    await c.standups.answerQuestion(c.owner, { commandId: cid("an"), questionId: first.id, expectedRevision: first.revision, answer: "Yes" });
    assert.equal(((await c.standups.agenda(c.owner, occ))!.notes ?? []).some((n) => /most a project holds/.test(n)), false, "answering one makes room again");
  });

  // ---- card M03h: the project's own index of its stand-ups ----------------------------------------------------------------------------------

  /** The service over a storage that remembers which kinds were listed (a scan of every record of a kind) and which were read by ID. */
  const spied = (c: Ctx): { service: StandupService; listed: string[] } => {
    const listed: string[] = [];
    const spy = new Proxy(c.storage, { get(target, key) {
      const value = (target as never)[key];
      if (key === "listAggregates") return async (kind: string, page: never) => { listed.push(kind); return target.listAggregates(kind, page); };
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    } });
    return { service: StandupService.withEpoch(spy, c.epoch, { meetings: c.meetings, assignments: c.assignments }, { availability: c.pauses.availability, ...options } as never), listed };
  };
  const indexOf = async (c: Ctx, project: string): Promise<{ ids: string[]; revision: number } | undefined> => {
    const found = await c.storage.getAggregate({ kind: "standup-index", id: project });
    return found === undefined ? undefined : { ids: (found.body as unknown as { ids: string[] }).ids, revision: found.revision };
  };
  const dropIndex = async (c: Ctx, project: string): Promise<void> => {
    const found = (await c.storage.getAggregate({ kind: "standup-index", id: project }))!;
    await new CommandRunner(c.storage, c.epoch, options).command("test.drop-index", { commandId: cid("drop"), actor: c.owner.id }, async () => ({ payload: {}, build: async () => ({ ref: found, creates: false, changes: [{ type: "delete" as const, ref: { kind: "standup-index", id: project }, expectedRevision: found.revision }], detail: {} }) }));
  };

  suite("a project's stand-ups are found from its own index, so the lookups read no stand-up record of other projects (card M03h)", async (c) => {
    const daily = await c.schedule();
    const weekly = await c.schedule({ title: "Weekly review", time: "10:00", windowTo: "11:00" });
    const theirs = await c.standups.configure(c.eve, { commandId: cid("sc"), projectId: c.b, title: "Other project's", roster: [c.pA], time: "09:00", windowFrom: "08:00", windowTo: "10:00", timeZone: "Europe/Berlin" } as never);
    assert.deepEqual((await indexOf(c, c.a))!.ids, [daily.scheduleId, weekly.scheduleId].sort(), "configure puts each stand-up on its project's index, in order");
    assert.deepEqual((await indexOf(c, c.b))!.ids, [theirs.scheduleId], "another project has its own index");
    // The same command again changes nothing.
    const before = (await indexOf(c, c.a))!;
    const again = await c.standups.configure(c.mgr, { commandId: "same-cmd", projectId: c.a, title: "Third", roster: [c.pA], time: "09:00", windowFrom: "08:00", windowTo: "10:00", timeZone: "Europe/Berlin" } as never);
    const replay = await c.standups.configure(c.mgr, { commandId: "same-cmd", projectId: c.a, title: "Third", roster: [c.pA], time: "09:00", windowFrom: "08:00", windowTo: "10:00", timeZone: "Europe/Berlin" } as never);
    assert.equal(replay.scheduleId, again.scheduleId);
    const after = (await indexOf(c, c.a))!;
    assert.equal(after.ids.length, before.ids.length + 1, "a repeated command lists the stand-up once");
    assert.equal(after.ids.filter((x) => x === again.scheduleId).length, 1);

    const { service, listed } = spied(c);
    const list = await service.list(c.owner, c.a);
    assert.deepEqual(list!.items.map((x) => x.scheduleId).sort(), after.ids);
    assert.equal((await service.recent(c.owner, c.a))!.items.length, 0, "none has met");
    assert.equal((await service.overview(c.owner, c.a))!.items.length, 3);
    assert.deepEqual(await service.list(c.owner, c.b).then((x) => x?.items.some((i) => after.ids.includes(i.scheduleId))), false, "another project's list holds none of this one's");
    assert.deepEqual(listed.filter((k) => k === "standup-config"), [], "no stand-up record was listed: the index was read");
    assert.deepEqual(await service.list(c.eve, c.a), undefined, "rights are asked as before");
  });

  suite("a project that has stand-ups from before the index is looked up once the old way and the index is written from that (card M03h)", async (c) => {
    const one = await c.schedule();
    const two = await c.schedule({ title: "Second" });
    await dropIndex(c, c.a);
    assert.equal(await indexOf(c, c.a), undefined);
    const { service, listed } = spied(c);
    assert.deepEqual((await service.list(c.owner, c.a))!.items.map((x) => x.scheduleId).sort(), [one.scheduleId, two.scheduleId].sort());
    assert.ok(listed.includes("standup-config"), "the first look scans");
    assert.deepEqual((await indexOf(c, c.a))!.ids, [one.scheduleId, two.scheduleId].sort(), "and writes the index");
    listed.length = 0;
    await service.overview(c.owner, c.a);
    assert.deepEqual(listed.filter((k) => k === "standup-config"), [], "the next look does not scan");
    // A stand-up made after the backfill joins it; one made while the index is missing is in the rebuilt one.
    const three = await c.schedule({ title: "Third" });
    assert.ok((await indexOf(c, c.a))!.ids.includes(three.scheduleId));
    await dropIndex(c, c.a);
    const four = await c.schedule({ title: "Fourth" });
    assert.deepEqual((await indexOf(c, c.a))!.ids, [one.scheduleId, two.scheduleId, three.scheduleId, four.scheduleId].sort(), "a rebuilt index holds the new stand-up exactly once");
    // A project with none gets an empty index and keeps answering an empty list.
    assert.deepEqual(await service.list(c.owner, c.b), { items: [], more: false });
    assert.deepEqual((await indexOf(c, c.b))!.ids, []);
  });

  suite("a project holds at most 200 stand-ups, refused before any schedule is made (card M03h)", async (c) => {
    const first = await c.schedule();
    const index = (await indexOf(c, c.a))!;
    const ids = [first.scheduleId, ...Array.from({ length: 199 }, (_, i) => `msc-${i.toString().padStart(20, "0")}`)];
    await new CommandRunner(c.storage, c.epoch, options).command("test.fill-index", { commandId: cid("fill"), actor: c.owner.id }, async () => ({ payload: {}, build: async () => ({ ref: { kind: "standup-index", id: c.a }, creates: false, changes: [{ type: "update" as const, ref: { kind: "standup-index", id: c.a }, expectedRevision: index.revision, body: { ids } as never }], detail: {} }) }));
    const schedules = async (): Promise<number> => (await c.storage.listAggregates("meeting-schedule", { limit: 1000 })).length;
    const made = await schedules();
    await refuses("unavailable", () => c.schedule({ title: "One too many" }), (e) => assert.match(e.message, /at most 200/));
    assert.equal(await schedules(), made, "no schedule was left behind");
    assert.equal((await indexOf(c, c.a))!.ids.length, 200);
    // Another project is not held back, and a caller who may not manage the project learns nothing of the limit.
    assert.ok((await c.standups.configure(c.eve, { commandId: cid("sc"), projectId: c.b, title: "B stand-up", roster: [c.pA], time: "09:00", windowFrom: "08:00", windowTo: "10:00", timeZone: "Europe/Berlin" } as never)).scheduleId);
    await refuses("forbidden", () => c.standups.configure(c.eve, { commandId: cid("sc"), projectId: c.a, title: "Not mine", roster: [c.pA], time: "09:00", windowFrom: "08:00", windowTo: "10:00", timeZone: "Europe/Berlin" } as never));
  });

}
