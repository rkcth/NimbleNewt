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
  void occurrenceOf; void item;

  // ---- W01 acceptance, card M03h part 1: StandupService.overview ---------------------------------------------------------

  suite("acceptance M03h: a project's stand-ups are told as schedules with the meeting ahead and the last one held; one that has not met is shown, ended ones are counted and left out unless asked for", async (c) => {
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
    assert.ok(got !== undefined);
    assert.deepEqual(got.items.map((x) => [x.title, x.state, x.recurrence, x.nextAt ?? "-", x.lastAt ?? "-"]), [
      ["Later review", "active", "daily", "2026-10-23T08:00:00.000Z", "-"],
      ["Daily stand-up", "active", "daily", "-", "2026-10-23T07:00:00.000Z"],
      ["Not yet met", "active", "daily", "-", "-"],
      ["One-off", "active", "once on 2026-11-02", "-", "-"],
      ["Weekly review", "active", "weekly on Mon, Wed", "-", "-"],
    ], "the one with a meeting ahead comes first, then the rest by title; the repeat in words");
    assert.deepEqual([got.more, got.ended], [false, 0]);
    const met = got.items.find((x) => x.scheduleId === daily.scheduleId)!;
    const settled = (await c.meetings.occurrence(c.owner, dailyOcc))!.occurrence;
    const dailySchedule = (await c.meetings.schedule(c.owner, daily.scheduleId))!;
    assert.deepEqual([met.lastOccurrenceId, met.lastState, met.lastRevision, met.occurrences, met.revision], [dailyOcc, "held", settled.revision, 1, dailySchedule.revision], "the last meeting is the one that was settled, with its revision; the schedule's revision");
    assert.deepEqual([met.time, met.timeZone, met.durationMinutes, met.window, [...met.roster].sort()], ["09:00", "Europe/Berlin", 30, { from: "08:00", to: "10:00" }, [c.pA, c.pB].sort()]);
    assert.equal(met.nextAt, undefined, "nothing planned ahead of the daily one");
    const ahead = got.items.find((x) => x.scheduleId === later.scheduleId)!;
    assert.ok(ahead.nextOccurrenceId !== undefined && ahead.nextRevision !== undefined && ahead.lastAt === undefined && ahead.lastOccurrenceId === undefined, "a meeting ahead, none held yet: the planned one is the next, not the last");
    assert.equal(ahead.nextOccurrenceId, created.find((x) => x.scheduleId === later.scheduleId)!.occurrenceId);
    assert.deepEqual([got.items.find((x) => x.scheduleId === fresh.scheduleId)!.occurrences, got.items.find((x) => x.scheduleId === weekly.scheduleId)!.occurrences], [0, 0], "a stand-up that has not met is told, not left out");
    assert.ok(got.items.some((x) => x.scheduleId === once.scheduleId));

    // The limit pages the shown kind; `more` says some were left out.
    const two = (await c.standups.overview(c.owner, c.a, { limit: 2 }))!;
    assert.deepEqual(two.items.map((x) => x.title), ["Later review", "Daily stand-up"]);
    assert.equal(two.more, true);

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

    // The recent list now names each meeting's stand-up.
    const recent = (await c.standups.recent(c.owner, c.a))!;
    const ofDaily = recent.items.find((x) => x.occurrenceId === dailyOcc) as unknown as { scheduleId?: string } | undefined;
    assert.equal(ofDaily?.scheduleId, daily.scheduleId, "standup.recent items carry their scheduleId");
  });
}
