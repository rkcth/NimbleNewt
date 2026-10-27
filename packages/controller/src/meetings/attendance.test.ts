import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AgentService } from "../agents/index.js";
import { DeskService, HistoryService, RetrievalService } from "../context/index.js";
import type { Availability } from "../conversations/index.js";
import { AssignmentService } from "../domain/assignments.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { CommandRunner } from "../domain/runner.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { WaitService } from "../domain/waits.js";
import { InquiryService } from "../inquiries/index.js";
import { PauseService } from "../lifecycle/index.js";
import { ProjectPlanService } from "../projects/index.js";
import { PrincipalService, type Grant, type Principal } from "../security/index.js";
import {
  ATTENDANCE_LIMITS, AttendanceService, MeetingService, type AttendanceBody, type AttendanceDeps, type Invitation, type MeetingDecision, type OccurrenceBody, type RoomStatus,
} from "./index.js";

after(stopServer);

// The only clock anything here reads. Tests move it; nothing sleeps.
let now = Date.parse("2026-10-23T08:00:00.000Z");
const at = (iso: string): void => { now = Date.parse(iso); };
const minutes = (n: number): void => { now += n * 60_000; };
const options = { clock: () => new Date(now).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};

for (const backend of backends) {
  interface Wake { key: string; agent: string; occurrenceId: string }
  interface Notice { key: string; agent: string; occurrenceId: string; decisions: readonly string[]; taskIds: readonly string[]; dueAt: string }
  interface Ctx {
    owner: Principal; host: Principal; mgr: Principal; reader: Principal; eve: Principal; asA: Principal; asB: Principal; asC: Principal;
    a: string; b: string; agentA: string; agentB: string; agentC: string; pA: string; pB: string; pC: string; team: string;
    meetings: MeetingService; pauses: PauseService; attendance: AttendanceService; assignments: AssignmentService; projects: ProjectService; histories: HistoryService;
    other: Map<string, Availability>; invitations: Invitation[]; wakes: Wake[]; notices: Notice[]; failNotice: { next: boolean };
    storage: ConstructorParameters<typeof CommandRunner>[0]; epoch: number; principals: PrincipalService;
    /** A ready task in project A assigned to the agent. */
    task(agent: string): Promise<string>;
    urgent(roster: string[], extra?: Record<string, unknown>): Promise<string>;
    room(occurrenceId: string, extra?: Record<string, unknown>): Promise<void>;
    boundary(taskId: string): Promise<void>;
    prep(occurrenceId: string, agent: string): Promise<unknown>;
    /** prepare + safe boundary + join, as the controller would. */
    attend(occurrenceId: string, agent: string, tasks: string[]): Promise<Awaited<ReturnType<AttendanceService["join"]>>>;
    status(occurrenceId: string): Promise<RoomStatus>;
    att(occurrenceId: string, agent: string): Promise<AttendanceBody>;
    occ(occurrenceId: string): Promise<OccurrenceBody>;
    gateIntent(taskId: string): Promise<string>;
    agentGate(agentId: string): Promise<string>;
    make(extra?: { assignments?: AssignmentService; pauses?: PauseService; charge?: AttendanceDeps["charge"]; onChargeError?: (e: unknown) => void }): AttendanceService;
  }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      at("2026-10-23T08:00:00.000Z");
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
        const team = (await agents.createTeam(owner, { commandId: cid("tm"), name: "builders" })).id;
        const agentA = (await agents.create(owner, { commandId: cid("ag"), friendlyName: "A", teamId: team })).id;
        const agentB = (await agents.create(owner, { commandId: cid("ag"), friendlyName: "B", teamId: team })).id;
        const agentC = (await agents.create(owner, { commandId: cid("ag"), friendlyName: "C" })).id;
        const [pA, pB, pC] = [`agent:${agentA}`, `agent:${agentB}`, `agent:${agentC}`] as const;
        // The agents may take part in a conversation of project A (the room's history needs it).
        const grantAgent = async (principalId: string, grants: Grant[]): Promise<Principal> => {
          const f = await world.storage.getAggregate({ kind: "principal", id: principalId });
          await principals.setGrants(owner, { commandId: cid("sg"), principalId, expectedRevision: f!.revision, grants });
          return principals.authenticate((await principals.issueCredential(owner, principalId)).token);
        };
        const chat: Grant[] = [{ action: "history.*", project: a }];
        const [asA, asB, asC] = [await grantAgent(pA, chat), await grantAgent(pB, chat), await grantAgent(pC, chat)];
        // Project A's participants are A and B (not C); the team "builders" is A and B as well.
        const plan = ProjectPlanService.withEpoch(world.storage, epoch, options);
        const proj = await world.storage.getAggregate({ kind: "project", id: a });
        await plan.setPlan(owner, { commandId: cid("pl"), projectId: a, expectedRevision: proj!.revision, participants: [{ principalId: pA }, { principalId: pB }] } as never);
        const other = new Map<string, Availability>();
        const assignments = AssignmentService.withEpoch(world.storage, epoch, projects, options);
        const waits = WaitService.withEpoch(world.storage, epoch, assignments, options);
        const pauses = PauseService.withEpoch(world.storage, epoch, { waits }, { ...options, otherAvailability: async (id) => other.get(id) ?? "available" });
        const histories = HistoryService.withEpoch(world.storage, epoch, options);
        const desks = DeskService.withEpoch(world.storage, epoch, options);
        const retrieval = RetrievalService.withEpoch(world.storage, epoch, desks, histories, options);
        const inquiries = InquiryService.withEpoch(world.storage, epoch, { histories, retrieval, waits, assignments }, options);
        const invitations: Invitation[] = [];
        const meetings = MeetingService.withEpoch(world.storage, epoch, { inquiries }, { availability: pauses.availability, invitations: { invite: async (i) => { invitations.push(i); } }, ...options });
        const wakes: Wake[] = [];
        const notices: Notice[] = [];
        const failNotice = { next: false };
        const make = (extra: { assignments?: AssignmentService; pauses?: PauseService; charge?: AttendanceDeps["charge"]; onChargeError?: (e: unknown) => void } = {}): AttendanceService =>
          AttendanceService.withEpoch(world.storage, epoch, { meetings, pauses: extra.pauses ?? pauses, projects, assignments: extra.assignments ?? assignments, agents, histories, ...(extra.charge === undefined ? {} : { charge: extra.charge }), ...(extra.onChargeError === undefined ? {} : { onChargeError: extra.onChargeError }) }, {
            availability: pauses.availability, ...options,
            wake: { wake: async (w) => { wakes.push(w); } },
            notices: { notify: async (x) => { if (failNotice.next) { failNotice.next = false; throw new Error("the delivery died"); } notices.push({ ...x }); } },
          });
        const attendance = make();
        const host = await enroll("host", "h1", []);
        const mgr = await enroll("agent", "mgr", [{ action: "meeting.manage", project: a }, { action: "assignment.manage", project: a }, { action: "history.*", project: a }]);
        const reader = await enroll("agent", "reader", [{ action: "meeting.read", project: a }]);
        const eve = await enroll("agent", "eve", [{ action: "meeting.manage", project: b }, { action: "assignment.manage", project: b }]);
        const task = async (agent: string): Promise<string> => {
          const id = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: a, title: "work" })).id;
          await projects.transitionTask({ commandId: cid("r"), actor: owner.id, taskId: id, expectedRevision: 1, to: "ready" });
          await assignments.assignTask({ commandId: cid("as"), actor: owner.id, taskId: id, owner: { kind: "agent", id: agent } });
          return id;
        };
        const urgent = async (roster: string[], extra: Record<string, unknown> = {}): Promise<string> =>
          (await meetings.callUrgent(owner, { commandId: cid("u"), projectId: a, title: "Release blocker", reason: "the build is red", roster, ...extra } as never)).id;
        const room = async (occurrenceId: string, extra: Record<string, unknown> = {}): Promise<void> => { await attendance.openRoom(owner, { commandId: cid("or"), occurrenceId, ...extra } as never); };
        const boundary = async (taskId: string): Promise<void> => { await pauses.observe(owner, { commandId: cid("ob"), scope: { kind: "task", id: taskId }, state: "paused", boundary: "finished" }); };
        const prep = (occurrenceId: string, agent: string) => attendance.prepare(owner, { commandId: cid("pp"), occurrenceId, agent, interrupted: [] });
        const attend = async (occurrenceId: string, agent: string, tasks: string[]) => {
          await attendance.prepare(owner, { commandId: cid("pr"), occurrenceId, agent, interrupted: tasks });
          for (const t of tasks) await boundary(t);
          return attendance.join(owner, { commandId: cid("jn"), occurrenceId, agent });
        };
        const status = async (occurrenceId: string): Promise<RoomStatus> => (await attendance.status(owner, occurrenceId))!;
        const att = async (occurrenceId: string, agent: string): Promise<AttendanceBody> => (await world.storage.getAggregate({ kind: "meeting-attendance", id: derivedId("mat", `${occurrenceId}\0${agent}`) }))!.body as unknown as AttendanceBody;
        const occ = async (occurrenceId: string): Promise<OccurrenceBody> => (await meetings.occurrence(owner, occurrenceId))!.occurrence as unknown as OccurrenceBody;
        const gateIntent = async (taskId: string): Promise<string> => (await pauses.gate(owner, { kind: "task", id: taskId }))?.intent ?? "none";
        const agentGate = async (agentId: string): Promise<string> => (await pauses.gate(owner, { kind: "agent", id: agentId }))?.intent ?? "none";
        await body({
          agentGate, owner, host, mgr, reader, eve, asA, asB, asC, a, b, agentA, agentB, agentC, pA, pB, pC, team, meetings, pauses, attendance, assignments, projects, histories, other, invitations, wakes, notices, failNotice,
          storage: world.storage, epoch, principals, task, urgent, room, boundary, prep, attend, status, att, occ, gateIntent, make,
        });
      } finally { await world.close(); }
    });

  const state = (s: RoomStatus, who: string) => s.participants.find((p) => p.who === who)!;

  // ---- admission near a meeting --------------------------------------------------------------------------------------------------------------------

  suite("near a scheduled meeting, work that cannot yield before it waits while work that can yield, short work and safe long-running operations start", async (c) => {
    // A once-only meeting at 10:00 UTC with a two-hour lead: the occurrence exists from 08:00.
    const schedule = (await c.meetings.createSchedule(c.mgr, { commandId: cid("sc"), projectId: c.a, title: "Stand-up", roster: [c.pA, c.pB], time: "10:00", timeZone: "UTC", recurrence: { kind: "once", date: "2026-10-23" }, prepareMinutes: 120 })).id;
    void schedule;
    assert.equal((await c.attendance.admission(c.owner, { agent: c.pA, expectedMinutes: 600 })).decision, "start", "nothing is known before the occurrence exists");
    minutes(1);
    const made = (await c.meetings.tick(c.host)).created;
    assert.equal(made.length, 1);
    const id = made[0]!.occurrenceId;
    // Work that ends before 10:00 starts; work that would still run at 10:00 and cannot yield waits for the meeting to end.
    const short = await c.attendance.admission(c.owner, { agent: c.pA, expectedMinutes: 60 });
    assert.equal(short.decision, "start");
    const long = await c.attendance.admission(c.owner, { agent: c.pA, expectedMinutes: 180 });
    assert.equal(long.decision, "defer");
    assert.ok(long.decision === "defer" && long.until === "2026-10-23T10:30:00.000Z" && long.meeting.occurrenceId === id);
    const yields = await c.attendance.admission(c.owner, { agent: c.pA, expectedMinutes: 180, yieldsAtBoundary: true });
    assert.equal(yields.decision, "start");
    const safe = await c.attendance.admission(c.owner, { agent: c.pA, expectedMinutes: 600, safeLongRunning: true });
    assert.ok(safe.decision === "start" && safe.continuesDuringMeeting === true);
    // Someone not on the roster is not held back; during the meeting only work that can yield starts.
    assert.equal((await c.attendance.admission(c.owner, { agent: c.pC, expectedMinutes: 600 })).decision, "start");
    at("2026-10-23T10:05:00.000Z");
    assert.equal((await c.attendance.admission(c.owner, { agent: c.pA, expectedMinutes: 5 })).decision, "defer");
    // A paused agent will not attend a scheduled meeting, so its work is not held for it.
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "agent", id: c.agentB }, reason: "hold" });
    assert.equal((await c.attendance.admission(c.owner, { agent: c.pB, expectedMinutes: 600 })).decision, "start");
    // After the meeting is held it no longer matters.
    await c.meetings.settle(c.owner, { commandId: cid("st"), occurrenceId: id, outcome: "held" });
    assert.equal((await c.attendance.admission(c.owner, { agent: c.pA, expectedMinutes: 600 })).decision, "start");
    // The question is for the controller or the agent itself.
    await refuses("forbidden", () => c.attendance.admission(c.asB, { agent: c.pA, expectedMinutes: 5 }));
    await refuses("forbidden", () => c.attendance.admission(c.reader, { agent: c.pA, expectedMinutes: 5 }));
    await refuses("invalid_command", () => c.attendance.admission(c.owner, { agent: c.pA, expectedMinutes: 0 }));
    assert.equal((await c.attendance.admission(c.asA, { agent: c.pA, expectedMinutes: 5 })).decision, "start");
  });

  // ---- joining ----------------------------------------------------------------------------------------------------------------------------------------

  suite("joining pauses the interrupted task at task scope only, keeps ownership and background work, and runs a separate meeting task that does not advance it", async (c) => {
    const t1 = await c.task(c.agentA);
    const t2 = await c.task(c.agentA);
    const id = await c.urgent([c.pA, c.pB]);
    await c.room(id);
    const before = (await c.assignments.getAssignment(t1))!;
    const preparing = await c.attendance.prepare(c.owner, { commandId: cid("pr"), occurrenceId: id, agent: c.pA, interrupted: [t1] });
    assert.deepEqual(preparing, { state: "preparing", waitingOn: [{ taskId: t1, observed: "pausing" }] });
    // Not at the boundary yet: joining changes nothing and says what it waits on.
    const early = await c.attendance.join(c.owner, { commandId: cid("jn"), occurrenceId: id, agent: c.pA });
    assert.deepEqual([early.joined, early.state, early.waitingOn], [false, "preparing", [{ taskId: t1, observed: "pausing" }]]);
    assert.equal((await c.att(id, c.pA)).meetingTaskId, undefined);
    await c.boundary(t1);
    const joined = await c.attendance.join(c.asA, { commandId: cid("jn"), occurrenceId: id, agent: c.pA });
    assert.ok(joined.joined && joined.state === "present" && joined.meetingTaskId !== undefined);
    const meetingTask = joined.meetingTaskId!;
    // Ownership, generation and revision of the interrupted assignment are untouched; the gate is the task's own and nothing else.
    const after = (await c.assignments.getAssignment(t1))!;
    assert.deepEqual([after.owner, after.generation, after.revision, after.state, after.activeAttemptId], [before.owner, before.generation, before.revision, before.state, before.activeAttemptId]);
    assert.equal((await c.assignments.history(t1)).length, 1, "no handoff: one generation of ownership");
    assert.equal(await c.gateIntent(t1), "pause");
    assert.deepEqual((await c.pauses.requests(c.owner, { kind: "task", id: t1 })).map((r) => [r.mode, r.action, r.scope.kind]), [["pause", "pause", "task"]], "only a Pause, at task scope");
    assert.equal(await c.gateIntent(t2), "none", "the agent's other task is not paused");
    assert.equal(await c.agentGate(c.agentA), "none");
    assert.equal((await c.pauses.availability(c.pA)), "available", "the agent itself is not paused or suspended");
    // The meeting task is a separate task assigned to the agent, can run while t1 is paused, and t1 is not advanced by it.
    assert.deepEqual((await c.pauses.guard(t1)).blockedBy, [{ kind: "task", id: t1 }]);
    assert.deepEqual((await c.pauses.guard(meetingTask)).blockedBy, []);
    const mt = (await c.assignments.getAssignment(meetingTask))!;
    assert.deepEqual([mt.owner, mt.state], [{ kind: "agent", id: c.agentA }, "assigned"]);
    assert.notEqual(meetingTask, t1);
    assert.equal(((await c.projects.getTask(meetingTask))!).state, "in_progress");
    assert.equal(((await c.projects.getTask(t1))!).state, "ready", "the paused task did not advance");
    // Background work of the paused task still records its result.
    const bg = await c.pauses.recordBackground(c.owner, { commandId: cid("bg"), taskId: t1, jobRef: "nightly-build", outcome: "succeeded", summary: "built" });
    assert.deepEqual(bg.pausedBy, [{ kind: "task", id: t1 }]);
    // Joining again is the same join.
    const again = await c.attendance.join(c.asA, { commandId: cid("jn2"), occurrenceId: id, agent: c.pA });
    assert.deepEqual([again.joined, again.meetingTaskId, again.replayed], [true, meetingTask, true]);
    // The durable join event.
    const s = await c.status(id);
    assert.equal(state(s, c.pA).state, "present");
    assert.ok(s.timeline.some((e) => e.who === c.pA && e.kind === "joined"));
    // Leaving finishes the meeting task and does not resume the interrupted one.
    await c.attendance.leave(c.asA, { commandId: cid("lv"), occurrenceId: id, agent: c.pA });
    assert.equal(((await c.projects.getTask(meetingTask))!).state, "done");
    assert.equal(await c.gateIntent(t1), "pause");
    assert.equal(state(await c.status(id), c.pA).state, "unavailable");
    await refuses("invalid_command", () => c.attendance.join(c.asA, { commandId: cid("jn3"), occurrenceId: id, agent: c.pA }));
  });

  suite("the status shows each invited agent as preparing, present, unavailable or blocked, and a blocked agent is one that cannot safely interrupt", async (c) => {
    const t1 = await c.task(c.agentA);
    const t3 = await c.task(c.agentB);
    c.other.set(c.pC, "suspended");
    const id = await c.urgent([c.pA, c.pB, c.pC]);
    await c.room(id);
    let s = await c.status(id);
    assert.deepEqual([state(s, c.pA).state, state(s, c.pB).state, state(s, c.pC).state], ["preparing", "preparing", "unavailable"]);
    assert.match(state(s, c.pC).reason!, /suspended/);
    // B reports an operation it cannot safely interrupt; clearing it returns it to preparing.
    await c.attendance.reportBlocked(c.asB, { commandId: cid("rb"), occurrenceId: id, agent: c.pB, blocked: true, reason: "a migration is half applied" });
    s = await c.status(id);
    assert.equal(state(s, c.pB).state, "blocked");
    assert.match(state(s, c.pB).reason!, /cannot safely interrupt/);
    await c.prep(id, c.pB);
    const refused = await c.attendance.join(c.asB, { commandId: cid("jn"), occurrenceId: id, agent: c.pB });
    assert.deepEqual([refused.joined, refused.state], [false, "blocked"]);
    await c.attendance.reportBlocked(c.asB, { commandId: cid("rb"), occurrenceId: id, agent: c.pB, blocked: false });
    assert.equal(state(await c.status(id), c.pB).state, "preparing");
    // A task whose executor cannot reach a boundary (uncooperative tool, recovery required) shows the agent as blocked; nothing is forced.
    await c.attendance.prepare(c.owner, { commandId: cid("pr"), occurrenceId: id, agent: c.pA, interrupted: [t1] });
    await c.pauses.observe(c.owner, { commandId: cid("ob"), scope: { kind: "task", id: t1 }, state: "recovery-required", boundary: "uncooperative", evidence: "a build tool does not stop" });
    s = await c.status(id);
    assert.equal(state(s, c.pA).state, "blocked");
    assert.deepEqual(state(s, c.pA).waitingOn, [{ taskId: t1, observed: "recovery-required" }]);
    const stuck = await c.attendance.join(c.owner, { commandId: cid("jn"), occurrenceId: id, agent: c.pA });
    assert.deepEqual([stuck.joined, stuck.state], [false, "blocked"]);
    assert.equal(await c.gateIntent(t1), "pause", "still only a pause: no force");
    // When it does reach the boundary the agent joins.
    await c.boundary(t1);
    assert.equal((await c.attendance.join(c.owner, { commandId: cid("jn"), occurrenceId: id, agent: c.pA })).joined, true);
    void t3;
    s = await c.status(id);
    assert.equal(state(s, c.pA).state, "present");
    // Only the agent itself or a meeting manager says it is blocked; a reader and another project's manager cannot.
    await refuses("forbidden", () => c.attendance.reportBlocked(c.asA, { commandId: cid("rb"), occurrenceId: id, agent: c.pB, blocked: true, reason: "x" }));
    await refuses("invalid_command", () => c.attendance.reportBlocked(c.asA, { commandId: cid("rb"), occurrenceId: id, agent: c.pA, blocked: true, reason: "x" }), (e) => assert.match(e.message, /present/));
  });

  // ---- immediate meetings -----------------------------------------------------------------------------------------------------------------------------

  suite("an immediate meeting starts at once with the project's participants or a named team, and asks first when the scope is unclear", async (c) => {
    const t1 = await c.task(c.agentA);
    c.other.set(c.pB, "suspended");
    // No scope: a question, nothing created, nobody invited.
    const asked = await c.attendance.callNow(c.owner, { commandId: cid("now"), projectId: c.a, title: "Release blocker", reason: "the build is red" });
    assert.equal(asked.status, "needs-scope");
    assert.ok(asked.status === "needs-scope" && asked.choices.some((x) => x.kind === "project" && x.agents === 2));
    assert.deepEqual((await c.meetings.planned(c.owner, c.a))!.items, []);
    assert.deepEqual(c.invitations, []);
    // A team nobody knows: asks again.
    assert.equal((await c.attendance.callNow(c.owner, { commandId: cid("now"), projectId: c.a, title: "x", reason: "y", scope: { kind: "team", teamId: "team-aaaaaaaaaaaaaaaaaaaa" } })).status, "needs-scope");
    // The project's participants (A and B, not C): the room exists at once, B shows as unavailable, A is preparing; the request is high priority and goes to A only.
    const started = await c.attendance.callNow(c.owner, { commandId: cid("now"), projectId: c.a, title: "Release blocker", reason: "the build is red", scope: { kind: "project" } });
    assert.equal(started.status, "started");
    const id = started.status === "started" ? started.occurrenceId : "";
    const s = await c.status(id);
    assert.equal(s.room.kind, "immediate");
    assert.deepEqual([...s.room.roster].sort(), [c.pA, c.pB].sort());
    assert.deepEqual([state(s, c.pA).state, state(s, c.pB).state], ["preparing", "unavailable"]);
    assert.equal(s.phase, "open");
    assert.equal(s.discussionMay, true, "starting the room is not waiting for everyone");
    assert.deepEqual((c.invitations as Invitation[]).map((i) => [i.agent, i.urgent]), [[c.pA, true]]);
    assert.equal((await c.occ(id)).kind, "urgent");
    // Repeating the command is the same meeting.
    const again = await c.attendance.callNow(c.owner, { commandId: "now-repeat", projectId: c.a, title: "Second", reason: "r", scope: { kind: "team", teamId: c.team } });
    const again2 = await c.attendance.callNow(c.owner, { commandId: "now-repeat", projectId: c.a, title: "Second", reason: "r", scope: { kind: "team", teamId: c.team } });
    assert.ok(again.status === "started" && again2.status === "started" && again.occurrenceId === again2.occurrenceId && again2.replayed);
    assert.deepEqual((await c.status(again.status === "started" ? again.occurrenceId : "")).room.scope, { kind: "team", id: c.team });
    void t1;
    // Not for those without the right to manage this project's meetings.
    await refuses("forbidden", () => c.attendance.callNow(c.eve, { commandId: cid("now"), projectId: c.a, title: "x", reason: "y", scope: { kind: "project" } }));
    await refuses("forbidden", () => c.attendance.callNow(c.reader, { commandId: cid("now"), projectId: c.a, title: "x", reason: "y", scope: { kind: "project" } }));
    await refuses("invalid_command", () => c.attendance.callNow(c.owner, { commandId: cid("now"), projectId: c.a, title: "x", reason: "y", scope: { kind: "everyone" } } as never));
  });

  suite("an immediate meeting with a large team says so instead of cutting the roster", async (c) => {
    // The roster cap is M01's 50; one over is refused with the count (nothing is truncated or created).
    const agents = AgentService.withEpoch(c.storage, c.epoch, options);
    const team = (await agents.createTeam(c.owner, { commandId: cid("tm"), name: "crowd" })).id;
    for (let i = 0; i < MEETING_ROSTER + 1; i++) await agents.create(c.owner, { commandId: cid("ag"), friendlyName: `M${i}`, teamId: team });
    const out = await c.attendance.callNow(c.owner, { commandId: cid("now"), projectId: c.a, title: "All hands", reason: "everyone", scope: { kind: "team", teamId: team } });
    assert.deepEqual(out, { status: "too-large", agents: MEETING_ROSTER + 1, limit: MEETING_ROSTER });
    assert.deepEqual((await c.meetings.planned(c.owner, c.a))!.items, []);
  });
  const MEETING_ROSTER = 50;

  // ---- everyone required ---------------------------------------------------------------------------------------------------------------------------------

  suite("'everyone required' waits for the missing participants under a visible timeout, then goes ahead and says who is missing", async (c) => {
    c.other.set(c.pB, "stopped");
    const id = await c.urgent([c.pA, c.pB]);
    await c.room(id, { requireAll: { timeoutMinutes: 10 } });
    let s = await c.status(id);
    assert.equal(s.phase, "gathering");
    assert.equal(s.deadline, "2026-10-23T08:10:00.000Z");
    assert.equal(s.discussionMay, false);
    assert.deepEqual([...s.missing].sort(), [c.pA, c.pB].sort());
    assert.equal(s.fullAttendance, false);
    // B cannot come and its presence matters here: the owner is asked, nothing is woken.
    assert.match(state(s, c.pB).ownerQuestion!, /authorize waking or recovering/);
    assert.equal(state(s, c.pA).ownerQuestion, undefined);
    assert.equal((await c.attend(id, c.pA, [])).joined, true);
    minutes(5);
    s = await c.status(id);
    assert.deepEqual([s.phase, s.missing, s.fullAttendance], ["gathering", [c.pB], false]);
    await refuses("invalid_command", () => c.attendance.beginDiscussion(c.owner, { commandId: cid("bd"), occurrenceId: id }), (e) => assert.match(e.message, new RegExp(`waiting for ${c.pB} until 2026-10-23T08:10:00`)));
    minutes(6);
    s = await c.status(id);
    assert.deepEqual([s.phase, s.discussionMay, s.fullAttendance, s.missing], ["open", true, false, [c.pB]]);
    const begun = await c.attendance.beginDiscussion(c.owner, { commandId: cid("bd"), occurrenceId: id });
    assert.deepEqual([begun.startedWith, begun.missing, begun.fullAttendance], [[c.pA], [c.pB], false], "the record never claims the full team attended");
    assert.equal(c.wakes.length, 0, "waiting woke nobody");
    // The same again, and a late arrival does not rewrite the record.
    const same = await c.attendance.beginDiscussion(c.owner, { commandId: cid("bd2"), occurrenceId: id });
    assert.deepEqual([same.startedWith, same.missing], [[c.pA], [c.pB]]);
    c.other.set(c.pB, "available");
    const late = await c.attend(id, c.pB, []);
    assert.equal(late.joined, true);
    assert.equal((await c.att(id, c.pB)).joinedLate, true);
    assert.equal((await c.status(id)).room.discussion?.fullAttendance, false);
    // A meeting that is not 'everyone required' starts with whoever is there, but not with nobody.
    const id2 = await c.urgent([c.pA, c.pB]);
    await c.room(id2);
    await refuses("invalid_command", () => c.attendance.beginDiscussion(c.owner, { commandId: cid("bd"), occurrenceId: id2 }), (e) => assert.match(e.message, /no one is present/));
    assert.equal((await c.attend(id2, c.pB, [])).joined, true);
    const partial = await c.attendance.beginDiscussion(c.owner, { commandId: cid("bd"), occurrenceId: id2 });
    assert.deepEqual([partial.startedWith, partial.missing], [[c.pB], [c.pA]]);
  });

  // ---- paused, suspended, stopped agents ---------------------------------------------------------------------------------------------------------------

  suite("a schedule never wakes a paused agent, a direct owner invitation allows bounded attendance with its other work still paused", async (c) => {
    const t1 = await c.task(c.agentA);
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "agent", id: c.agentA }, reason: "the owner paused A" });
    const id = await c.urgent([c.pA, c.pB]);
    await c.room(id);
    assert.equal(state(await c.status(id), c.pA).state, "unavailable");
    assert.match(state(await c.status(id), c.pA).reason!, /does not wake a paused agent/);
    // Neither the controller's preparation nor the agent's own join gets it in, and the invitations skip it.
    await refuses("invalid_command", () => c.attendance.prepare(c.owner, { commandId: cid("pr"), occurrenceId: id, agent: c.pA, interrupted: [] }));
    const self = await c.attendance.join(c.asA, { commandId: cid("jn"), occurrenceId: id, agent: c.pA });
    assert.deepEqual([self.joined, self.state], [false, "unavailable"]);
    const sent = await c.meetings.dispatchInvitations(c.owner, id);
    assert.deepEqual([sent.invited, sent.withheld], [[c.pB], [c.pA]]);
    // A manager cannot invite it; the owner can (M01), and then the room lets it in, for this meeting only.
    await refuses("forbidden", () => c.meetings.inviteDirect(c.mgr, { commandId: cid("iv"), occurrenceId: id, agent: c.pA }));
    await c.meetings.inviteDirect(c.owner, { commandId: cid("iv"), occurrenceId: id, agent: c.pA });
    await c.attendance.refresh(c.owner, id);
    assert.equal(state(await c.status(id), c.pA).state, "preparing");
    assert.equal(state(await c.status(id), c.pA).bounded, true);
    await c.prep(id, c.pA);
    const joined = await c.attendance.join(c.asA, { commandId: cid("jn"), occurrenceId: id, agent: c.pA });
    assert.ok(joined.joined);
    const meetingTask = joined.meetingTaskId!;
    // Only the meeting task runs; the agent's paused work and the agent's own state are unchanged.
    assert.deepEqual((await c.pauses.guard(meetingTask)).blockedBy, []);
    assert.deepEqual((await c.pauses.guard(t1)).blockedBy, [{ kind: "task", id: t1 }, { kind: "agent", id: c.agentA }].slice(1), "the agent's pause still holds its other work");
    assert.equal(await c.pauses.availability(c.pA), "paused");
    assert.equal(await c.agentGate(c.agentA), "pause");
    // The permission is the meeting's: it ends when the agent leaves, and it never covers another task of the agent.
    const t2 = await c.task(c.agentA);
    assert.equal((await c.pauses.guard(t2)).blockedBy.length, 1);
    await c.attendance.leave(c.asA, { commandId: cid("lv"), occurrenceId: id, agent: c.pA });
    const ex = await c.storage.getAggregate({ kind: "pause-exemption", id: `pxm-${meetingTask.slice(5)}` });
    assert.equal((ex!.body as { state: string }).state, "ended");
    // The end of the meeting leaves the agent paused: nothing was resumed.
    await c.attendance.endMeeting(c.owner, { commandId: cid("end"), occurrenceId: id });
    assert.equal(await c.agentGate(c.agentA), "pause");
    assert.equal(await c.pauses.availability(c.pA), "paused");
  });

  suite("the time an agent spends in a meeting is charged once, to its meeting task, and a failing charge never keeps the agent in the room (card R05d)", async (c) => {
    const charges: { commandId: string; projectId: string; agentId: string; computeMs: number; taskId?: string }[] = [];
    let fail = true;
    const errors: unknown[] = [];
    const charged = c.make({ charge: async (u) => { if (fail) throw new Error("ledger down"); charges.push(u); }, onChargeError: (e) => errors.push(e) });
    const id = await c.urgent([c.pA, c.pB]);
    await c.room(id);
    await c.prep(id, c.pA);
    const joined = await charged.join(c.asA, { commandId: cid("jn"), occurrenceId: id, agent: c.pA });
    assert.ok(joined.joined);
    minutes(7);
    await charged.leave(c.asA, { commandId: cid("lv"), occurrenceId: id, agent: c.pA });
    assert.equal(errors.length, 1, "the failed charge is reported");
    assert.equal((await c.status(id)).participants.find((p) => p.who === c.pA)?.state, "unavailable", "and the agent has left all the same");
    // The ledger is back: the end of the meeting does not leave A again, so the same leave, asked again, charges it.
    fail = false;
    await charged.leave(c.asA, { commandId: cid("lv2"), occurrenceId: id, agent: c.pA });
    await charged.leave(c.asA, { commandId: cid("lv3"), occurrenceId: id, agent: c.pA });
    assert.equal(charges.length, 2, "asked twice, the same command ID each time");
    assert.equal(new Set(charges.map((x) => x.commandId)).size, 1, "one attendance, one charge");
    assert.equal(charges[0]!.computeMs, 7 * 60_000);
    assert.equal(charges[0]!.agentId, c.pA);
    assert.equal(charges[0]!.taskId, joined.meetingTaskId);
    assert.equal(charges[0]!.projectId, c.a);
  });

  suite("a meeting that ends charges the agents still in the room once, and the owner's presence is nobody's budget (card R05d)", async (c) => {
    const charges: { commandId: string; projectId: string; agentId: string; computeMs: number; taskId?: string }[] = [];
    const charged = c.make({ charge: async (u) => { charges.push(u); } });
    const id = await c.urgent([c.pA, c.pB]);
    await c.room(id);
    await c.prep(id, c.pA);
    const joined = await charged.join(c.asA, { commandId: cid("jn"), occurrenceId: id, agent: c.pA });
    await charged.joinAsOwner(c.owner, { commandId: cid("jo"), occurrenceId: id });
    minutes(12);
    await charged.endMeeting(c.owner, { commandId: cid("end"), occurrenceId: id });
    assert.deepEqual(charges.map((x) => [x.agentId, x.computeMs, x.taskId]), [[c.pA, 12 * 60_000, joined.meetingTaskId]], "A is charged at the end; the owner is not");
    // Ending again, or A leaving afterwards, is the same charge under the same command ID.
    await charged.endMeeting(c.owner, { commandId: cid("end2"), occurrenceId: id }).catch(() => undefined);
    await charged.leave(c.asA, { commandId: cid("lv"), occurrenceId: id, agent: c.pA }).catch(() => undefined);
    assert.equal(new Set(charges.map((x) => x.commandId)).size, 1);
  });

  suite("a bounded attendance lapses with its lease, and an owner invitation is needed for each meeting", async (c) => {
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "agent", id: c.agentA }, reason: "A is paused" });
    const id = await c.urgent([c.pA, c.pB]);
    await c.room(id);
    await c.meetings.inviteDirect(c.owner, { commandId: cid("iv"), occurrenceId: id, agent: c.pA });
    await c.attendance.refresh(c.owner, id);
    const joined = await c.attend(id, c.pA, []);
    const meetingTask = joined.meetingTaskId!;
    assert.deepEqual((await c.pauses.guard(meetingTask)).blockedBy, []);
    // The permission is a lease: past the meeting's end (plus the grace) the meeting task is held by the agent's pause again.
    at("2026-10-23T09:45:00.000Z");
    assert.deepEqual((await c.pauses.guard(meetingTask)).blockedBy, [{ kind: "agent", id: c.agentA }]);
    // B was never paused or invited: it is an ordinary participant, not a bounded one.
    assert.deepEqual([state(await c.status(id), c.pB).state, state(await c.status(id), c.pB).bounded], ["preparing", false]);
  });

  suite("a bounded attendance never overrides the installation pause, or a pause placed after the owner's invitation", async (c) => {
    // (a) The whole installation is paused: an invitation does not let the agent in.
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "installation", id: "installation" }, reason: "the owner paused everything" });
    const idI = await c.urgent([c.pA]);
    await c.room(idI);
    await c.meetings.inviteDirect(c.owner, { commandId: cid("iv"), occurrenceId: idI, agent: c.pA });
    await c.attendance.refresh(c.owner, idI);
    assert.match(state(await c.status(idI), c.pA).reason!, /whole installation is paused/);
    await c.prep(idI, c.pA).then(() => assert.fail("prepared"), (e: unknown) => assert.ok(e instanceof DomainError));
    await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: { kind: "installation", id: "installation" }, reason: "ok" });
    // (b) Invited while paused and joined; then the installation is paused during the meeting: the emergency brake stops the meeting task too.
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "agent", id: c.agentA }, reason: "A is paused" });
    const id = await c.urgent([c.pA, c.pB]);
    await c.room(id);
    await c.meetings.inviteDirect(c.owner, { commandId: cid("iv"), occurrenceId: id, agent: c.pA });
    await c.attendance.refresh(c.owner, id);
    const joined = await c.attend(id, c.pA, []);
    const meetingTask = joined.meetingTaskId!;
    assert.deepEqual((await c.pauses.guard(meetingTask)).blockedBy, []);
    minutes(1);
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "installation", id: "installation" }, reason: "stop everything" });
    assert.deepEqual((await c.pauses.guard(meetingTask)).blockedBy, [{ kind: "installation", id: "installation" }]);
    await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: { kind: "installation", id: "installation" }, reason: "ok" });
    assert.deepEqual((await c.pauses.guard(meetingTask)).blockedBy, []);
    // (c) A team pause placed during the meeting blocks it too, and so does the agent's own pause resumed and placed again.
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "team", id: c.team }, reason: "the team stops" });
    assert.deepEqual((await c.pauses.guard(meetingTask)).blockedBy, [{ kind: "team", id: c.team }]);
    await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: { kind: "team", id: c.team }, reason: "ok" });
    await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: { kind: "agent", id: c.agentA }, reason: "resumed" });
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "agent", id: c.agentA }, reason: "paused again for a new reason" });
    assert.deepEqual((await c.pauses.guard(meetingTask)).blockedBy, [{ kind: "agent", id: c.agentA }]);
    // (d) Invited, resumed, paused again before joining: the old invitation does not cover the new pause, so the agent cannot join.
    const id2 = await c.urgent([c.pB]);
    await c.room(id2);
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "agent", id: c.agentB }, reason: "B is paused" });
    await c.attendance.refresh(c.owner, id2);
    minutes(1);
    await c.meetings.inviteDirect(c.owner, { commandId: cid("iv"), occurrenceId: id2, agent: c.pB });
    await c.attendance.refresh(c.owner, id2);
    assert.equal(state(await c.status(id2), c.pB).state, "preparing");
    await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: { kind: "agent", id: c.agentB }, reason: "resumed" });
    minutes(1);
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "agent", id: c.agentB }, reason: "a new reason" });
    await c.prep(id2, c.pB).then(() => assert.fail("prepared"), (e: unknown) => assert.ok(e instanceof DomainError));
    const refused = await c.attendance.join(c.owner, { commandId: cid("jn"), occurrenceId: id2, agent: c.pB });
    assert.deepEqual([refused.joined, refused.state], [false, "unavailable"]);
    assert.match(refused.reason!, /paused again after the owner's invitation/);
    // The owner invites again and it is covered.
    minutes(1);
    await c.meetings.inviteDirect(c.owner, { commandId: cid("iv"), occurrenceId: id2, agent: c.pB });
    await c.attendance.refresh(c.owner, id2);
    assert.equal((await c.attend(id2, c.pB, [])).joined, true);
  });

  suite("a participant who has left cannot be brought back in by a join that began before the leave, and the ended permission stays ended", async (c) => {
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "agent", id: c.agentA }, reason: "A is paused" });
    const id = await c.urgent([c.pA]);
    await c.room(id);
    await c.meetings.inviteDirect(c.owner, { commandId: cid("iv"), occurrenceId: id, agent: c.pA });
    await c.attendance.refresh(c.owner, id);
    await c.prep(id, c.pA);
    // A leave lands between the second join's early checks and its commit (the meeting task is being started).
    const first = await c.attendance.join(c.asA, { commandId: cid("jn"), occurrenceId: id, agent: c.pA });
    assert.ok(first.joined);
    await c.attendance.leave(c.asA, { commandId: cid("lv"), occurrenceId: id, agent: c.pA });
    assert.deepEqual((await c.pauses.guard(first.meetingTaskId!)).blockedBy, [{ kind: "agent", id: c.agentA }], "the permission ended with the leave");
    await refuses("invalid_command", () => c.attendance.join(c.owner, { commandId: cid("jn"), occurrenceId: id, agent: c.pA }));
    // The same race, driven: the leave happens inside the join's own steps for a participant not yet in.
    const id2 = await c.urgent([c.pB]);
    await c.room(id2);
    await c.prep(id2, c.pB);
    const att = await c.att(id2, c.pB);
    void att;
    let left = false;
    const racing = {
      epoch: c.assignments.epoch,
      assignTask: async (cmd: Parameters<AssignmentService["assignTask"]>[0]) => {
        const result = await c.assignments.assignTask(cmd);
        if (!left) {
          left = true;
          // B (not yet present) is marked as having left by a concurrent join+leave of its own.
          await c.attendance.join(c.owner, { commandId: "jn-inner", occurrenceId: id2, agent: c.pB });
          await c.attendance.leave(c.owner, { commandId: "lv-inner", occurrenceId: id2, agent: c.pB });
        }
        return result;
      },
    } as unknown as AssignmentService;
    await refuses("invalid_command", () => c.make({ assignments: racing }).join(c.owner, { commandId: "jn-outer", occurrenceId: id2, agent: c.pB }));
    assert.equal(state(await c.status(id2), c.pB).state, "unavailable");
    assert.ok((await c.att(id2, c.pB)).leftAt !== undefined);
  });

  suite("a suspended or stopped agent is woken only with the owner's authorization", async (c) => {
    c.other.set(c.pC, "suspended");
    const id = await c.urgent([c.pA, c.pC]);
    await c.room(id);
    assert.equal(state(await c.status(id), c.pC).state, "unavailable");
    // Nothing in preparing, joining, refreshing or inviting wakes it.
    await refuses("invalid_command", () => c.attendance.prepare(c.owner, { commandId: cid("pr"), occurrenceId: id, agent: c.pC, interrupted: [] }));
    assert.equal((await c.attendance.join(c.asC, { commandId: cid("jn"), occurrenceId: id, agent: c.pC })).joined, false);
    await c.attendance.refresh(c.owner, id);
    await c.meetings.dispatchInvitations(c.owner, id);
    await refuses("invalid_command", () => c.meetings.inviteDirect(c.owner, { commandId: cid("iv"), occurrenceId: id, agent: c.pC }));
    assert.deepEqual(c.wakes, []);
    // Only the owner authorizes it.
    await refuses("forbidden", () => c.attendance.authorizeWake(c.mgr, { commandId: cid("wk"), occurrenceId: id, agent: c.pC }));
    await refuses("forbidden", () => c.attendance.authorizeWake(c.host, { commandId: cid("wk"), occurrenceId: id, agent: c.pC }));
    await refuses("forbidden", () => c.attendance.authorizeWake(c.asC, { commandId: cid("wk"), occurrenceId: id, agent: c.pC }));
    assert.deepEqual(c.wakes, []);
    await c.attendance.authorizeWake(c.owner, { commandId: cid("wk"), occurrenceId: id, agent: c.pC });
    assert.deepEqual(c.wakes, [{ key: `${id}:${c.pC}`, agent: c.pC, occurrenceId: id, projectId: c.a }]);
    assert.equal(state(await c.status(id), c.pC).state, "preparing");
    // Until the lifecycle reports it reachable it cannot join (the authorization is a request to wake, not a claim that it woke).
    const early = await c.attendance.join(c.asC, { commandId: cid("jn"), occurrenceId: id, agent: c.pC });
    assert.deepEqual([early.joined, early.state], [false, "unavailable"]);
    c.other.set(c.pC, "available");
    await c.attendance.refresh(c.owner, id);
    await c.prep(id, c.pC);
    assert.equal((await c.attendance.join(c.asC, { commandId: cid("jn"), occurrenceId: id, agent: c.pC })).joined, true);
    // Authorizing an agent that is not suspended or stopped is not a thing.
    await refuses("invalid_command", () => c.attendance.authorizeWake(c.owner, { commandId: cid("wk"), occurrenceId: id, agent: c.pA }));
  });

  suite("waking needs a wake path: without one the owner's authorization is refused, not pretended", async (c) => {
    c.other.set(c.pC, "stopped");
    const bare = AttendanceService.withEpoch(c.storage, c.epoch, { meetings: c.meetings, pauses: c.pauses, projects: c.projects, assignments: c.assignments }, { availability: c.pauses.availability, ...options });
    const id = await c.urgent([c.pA, c.pC]);
    await bare.openRoom(c.owner, { commandId: cid("or"), occurrenceId: id });
    await refuses("invalid_command", () => bare.authorizeWake(c.owner, { commandId: cid("wk"), occurrenceId: id, agent: c.pC }), (e) => assert.match(e.message, /no wake path/));
    // And with no availability the room treats everyone as unreachable (fails closed).
    const closed = AttendanceService.withEpoch(c.storage, c.epoch, { meetings: c.meetings, pauses: c.pauses, projects: c.projects, assignments: c.assignments }, { availability: async () => { throw new Error("down"); }, ...options });
    const id2 = await c.urgent([c.pA]);
    await closed.openRoom(c.owner, { commandId: cid("or"), occurrenceId: id2 });
    assert.equal(state((await closed.status(c.owner, id2))!, c.pA).state, "unavailable");
  });

  // ---- saved briefs ----------------------------------------------------------------------------------------------------------------------------------------

  suite("a saved brief is never shown as a live answer", async (c) => {
    c.other.set(c.pB, "stopped");
    const id = await c.urgent([c.pA, c.pB]);
    await c.room(id);
    await c.attendance.saveBrief(c.asB, { commandId: cid("sb"), occurrenceId: id, text: "Blocked on the schema review; no change since Tuesday." });
    const brief = (await c.attendance.briefOf(c.reader, id, c.pB))!;
    assert.equal(brief.live, false);
    assert.equal(brief.savedAt, "2026-10-23T08:00:00.000Z");
    assert.match(brief.notice, /not a live answer/);
    assert.equal(state(await c.status(id), c.pB).state, "unavailable");
    // Also for an agent that is present: the brief stays a saved brief.
    await c.attendance.saveBrief(c.asA, { commandId: cid("sb"), occurrenceId: id, text: "Nothing new." });
    await c.attend(id, c.pA, []);
    assert.equal((await c.attendance.briefOf(c.owner, id, c.pA))!.live, false);
    // Only the agent writes its own brief; unreadable meetings and agents without one read like missing ones; no secrets.
    await refuses("forbidden", () => c.attendance.saveBrief(c.mgr, { commandId: cid("sb"), occurrenceId: id, text: "I speak for B" }));
    await refuses("invalid_command", () => c.attendance.saveBrief(c.asA, { commandId: cid("sb"), occurrenceId: id, text: "password=hunter2hunter2hunter2 sk-live-0123456789abcdef0123456789abcdef" }));
    assert.equal(await c.attendance.briefOf(c.eve, id, c.pB), undefined);
    assert.equal(await c.attendance.briefOf(c.reader, id, c.pC), undefined);
  });

  // ---- the owner and the late joiner ------------------------------------------------------------------------------------------------------------------------

  suite("the meeting proceeds without the owner, and a late joiner sees the state so far", async (c) => {
    const id = await c.urgent([c.pA, c.pB]);
    await c.room(id);
    await c.attend(id, c.pA, []);
    minutes(2);
    // The room runs and the discussion begins with the owner absent.
    const begun = await c.attendance.beginDiscussion(c.mgr, { commandId: cid("bd"), occurrenceId: id });
    assert.deepEqual(begun.startedWith, [c.pA]);
    const s0 = await c.status(id);
    assert.equal(s0.ownerPresent, false);
    // Things happen in the room: the conversation has entries.
    const history = s0.room.historyId!;
    assert.ok(history !== undefined);
    await c.histories.append(c.asA, history, { commandId: cid("h"), text: "A: the build broke on the lockfile." });
    minutes(3);
    // A late joiner (B) and then the owner read what has happened.
    const late = await c.attend(id, c.pB, []);
    assert.equal(late.joined, true);
    const seenByB = (await c.attendance.status(c.asB, id))!;
    assert.deepEqual(seenByB.timeline.filter((e) => e.kind.startsWith("joined")).map((e) => [e.who, e.kind]), [[c.pA, "joined"], [c.pB, "joined-late"]]);
    assert.equal((await c.histories.read(c.asB, history, { limit: 50 })).entries[0]!.text, "A: the build broke on the lockfile.");
    await c.attendance.joinAsOwner(c.owner, { commandId: cid("jo"), occurrenceId: id });
    const seenByOwner = await c.status(id);
    assert.equal(seenByOwner.ownerPresent, true);
    assert.equal(seenByOwner.participants.find((p) => p.isOwner)!.joinedLate, true);
    assert.equal(seenByOwner.fullAttendance, true);
    assert.equal(seenByOwner.room.discussion?.startedWith.length, 1, "what the discussion started with is not rewritten by later arrivals");
    // The owner is not required for anything and only the owner joins as the owner.
    await refuses("forbidden", () => c.attendance.joinAsOwner(c.mgr, { commandId: cid("jo"), occurrenceId: id }));
    // Someone who may not see the meeting sees nothing, as for a room that does not exist.
    assert.equal(await c.attendance.status(c.eve, id), undefined);
    assert.equal(await c.attendance.status(c.asC, id), undefined);
    assert.equal((await c.attendance.status(c.reader, id))?.room.occurrenceId, id);
    assert.equal(await c.attendance.status(c.owner, "mto-aaaaaaaaaaaaaaaaaaaa"), undefined);
  });

  // ---- the end of the meeting: return to work ---------------------------------------------------------------------------------------------------------

  suite("at the end only the pause made for attendance is resumed; the assignment is not transferred and the meeting task is finished", async (c) => {
    const t1 = await c.task(c.agentA);
    const t2 = await c.task(c.agentA);
    const id = await c.urgent([c.pA, c.pB]);
    await c.room(id);
    const before = (await c.assignments.getAssignment(t1))!;
    const joined = await c.attend(id, c.pA, [t1]);
    const done = await c.attendance.endMeeting(c.owner, { commandId: cid("end"), occurrenceId: id });
    assert.deepEqual(done.left, [c.pA]);
    assert.deepEqual(done.returned.find((r) => r.who === c.pA)!.outcomes, [{ taskId: t1, outcome: "resumed" }]);
    assert.equal(await c.gateIntent(t1), "active");
    const after = (await c.assignments.getAssignment(t1))!;
    assert.deepEqual([after.owner, after.generation, after.revision], [before.owner, before.generation, before.revision]);
    assert.equal((await c.assignments.history(t1)).length, 1);
    assert.equal(((await c.projects.getTask(joined.meetingTaskId!))!).state, "done");
    assert.equal((await c.occ(id)).state, "held");
    assert.equal((await c.status(id)).phase, "ended");
    assert.equal((await c.att(id, c.pA)).returned, true);
    assert.equal(await c.gateIntent(t2), "none");
    // The pause requests: one pause and one resume, both ours.
    assert.deepEqual((await c.pauses.requests(c.owner, { kind: "task", id: t1 })).map((r) => r.action), ["pause", "resume"]);
    // Nobody joins an ended room; repeating the end changes nothing.
    await refuses("invalid_command", () => c.attendance.join(c.owner, { commandId: cid("jn"), occurrenceId: id, agent: c.pB }));
    const repeat = await c.attendance.endMeeting(c.owner, { commandId: cid("end2"), occurrenceId: id });
    assert.deepEqual(repeat.left, []);
    assert.deepEqual((await c.pauses.requests(c.owner, { kind: "task", id: t1 })).map((r) => r.action), ["pause", "resume"]);
    // Only the owner, host or service ends a meeting (M01's rule for marking it held).
    const id2 = await c.urgent([c.pA]);
    await c.room(id2);
    await refuses("forbidden", () => c.attendance.endMeeting(c.mgr, { commandId: cid("end"), occurrenceId: id2 }));
    await refuses("forbidden", () => c.attendance.endMeeting(c.asA, { commandId: cid("end"), occurrenceId: id2 }));
  });

  suite("pauses that predate the meeting, were requested during it, or were replaced, and suspensions and stops, are kept", async (c) => {
    // t1 was paused before the meeting; t2 the owner asks to keep; t3 is resumed and paused again by someone else; t4 is resumed normally.
    const [t1, t2, t3, t4] = [await c.task(c.agentA), await c.task(c.agentA), await c.task(c.agentA), await c.task(c.agentA)];
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "task", id: t1 }, reason: "waiting for the vendor" });
    const id = await c.urgent([c.pA, c.pB]);
    await c.room(id);
    await c.attend(id, c.pA, [t1, t2, t3, t4]);
    assert.equal((await c.att(id, c.pA)).interrupted.find((x) => x.taskId === t1)!.pausedByUs, false);
    // During the meeting: keep t2; someone resumes t3 and pauses it again (a new request); the owner pauses the agent and it is then suspended.
    await c.attendance.keepPaused(c.mgr, { commandId: cid("kp"), occurrenceId: id, agent: c.pA, taskId: t2 });
    await refuses("forbidden", () => c.attendance.keepPaused(c.eve, { commandId: cid("kp"), occurrenceId: id, agent: c.pA, taskId: t2 }));
    await refuses("forbidden", () => c.attendance.keepPaused(c.asA, { commandId: cid("kp"), occurrenceId: id, agent: c.pA, taskId: t2 }));
    await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: { kind: "task", id: t3 }, reason: "continue" });
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "task", id: t3 }, reason: "wait for review" });
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "agent", id: c.agentA }, reason: "A is paused during the meeting" });
    const done = await c.attendance.endMeeting(c.owner, { commandId: cid("end"), occurrenceId: id });
    const outcomes = Object.fromEntries(done.returned.find((r) => r.who === c.pA)!.outcomes.map((o) => [o.taskId, [o.outcome, o.detail]]));
    assert.deepEqual(outcomes[t1], ["kept", "paused-before-meeting"]);
    assert.deepEqual(outcomes[t2], ["kept", "requested-during-meeting"]);
    assert.deepEqual(outcomes[t3], ["kept", "pause-replaced"]);
    assert.equal(outcomes[t4]![0], "resumed");
    assert.deepEqual([await c.gateIntent(t1), await c.gateIntent(t2), await c.gateIntent(t3), await c.gateIntent(t4)], ["pause", "pause", "pause", "active"]);
    // The agent's own pause and its suspension are untouched, and nothing was woken.
    assert.equal(await c.agentGate(c.agentA), "pause");
    assert.equal(await c.pauses.availability(c.pA), "paused");
    assert.deepEqual(c.wakes, []);
    // t4 is still held by the agent's pause (a task gate is resumed; the agent gate is not ours).
    assert.deepEqual((await c.pauses.guard(t4)).blockedBy, [{ kind: "agent", id: c.agentA }]);
    const resumed = (await c.att(id, c.pA)).interrupted.find((x) => x.taskId === t4)!;
    assert.deepEqual(resumed.stillPausedBy, [{ kind: "agent", id: c.agentA }]);
  });

  suite("a suspension or stop during the meeting is kept: the return lifts the attendance pause and wakes nobody", async (c) => {
    const t1 = await c.task(c.agentA);
    const id = await c.urgent([c.pA, c.pB]);
    await c.room(id);
    await c.attend(id, c.pA, [t1]);
    c.other.set(c.pA, "suspended");
    const done = await c.attendance.endMeeting(c.owner, { commandId: cid("end"), occurrenceId: id });
    assert.deepEqual(done.returned.find((r) => r.who === c.pA)!.outcomes, [{ taskId: t1, outcome: "resumed", detail: "the agent is suspended and stays suspended" }]);
    assert.equal(await c.pauses.availability(c.pA), "suspended");
    assert.deepEqual(c.wakes, []);
    // The same for a stop that came in during the meeting of another agent.
    const t3 = await c.task(c.agentB);
    const id2 = await c.urgent([c.pB]);
    await c.room(id2);
    await c.attend(id2, c.pB, [t3]);
    c.other.set(c.pB, "stopped");
    const done2 = await c.attendance.endMeeting(c.owner, { commandId: cid("end"), occurrenceId: id2 });
    assert.match(done2.returned[0]!.outcomes[0]!.detail!, /stopped and stays stopped/);
    assert.equal(await c.pauses.availability(c.pB), "stopped");
  });

  suite("return revalidates ownership: a reassigned task is not returned to the old owner and nothing is moved by the return", async (c) => {
    const t1 = await c.task(c.agentA);
    const t2 = await c.task(c.agentA);
    const id = await c.urgent([c.pA, c.pB]);
    await c.room(id);
    await c.attend(id, c.pA, [t1, t2]);
    // During the meeting the owner moves t1 to B by the usual route, and releases t2 and gives it to A again (same agent, a new generation).
    const current = (await c.assignments.getAssignment(t1))!;
    await c.assignments.transferTask({ commandId: cid("tf"), actor: c.owner.id, taskId: t1, expectedRevision: current.revision, to: { kind: "agent", id: c.agentB } });
    const second = (await c.assignments.getAssignment(t2))!;
    await c.assignments.releaseTask({ commandId: cid("rl"), actor: c.owner.id, taskId: t2, expectedRevision: second.revision });
    const released = (await c.assignments.getAssignment(t2))!;
    await c.assignments.assignTask({ commandId: cid("as"), actor: c.owner.id, taskId: t2, expectedRevision: released.revision, owner: { kind: "agent", id: c.agentA } });
    const moved = (await c.assignments.getAssignment(t1))!;
    const again = (await c.assignments.getAssignment(t2))!;
    assert.equal(again.generation, 2);
    const done = await c.attendance.endMeeting(c.owner, { commandId: cid("end"), occurrenceId: id });
    const outcomes = Object.fromEntries(done.returned.find((r) => r.who === c.pA)!.outcomes.map((o) => [o.taskId, o.outcome]));
    assert.deepEqual(outcomes, { [t1]: "ownership-changed", [t2]: "ownership-changed" });
    // The attendance pause is lifted so the new owner is not held by it, and the assignments are as the owner left them.
    assert.deepEqual([await c.gateIntent(t1), await c.gateIntent(t2)], ["active", "active"]);
    const after1 = (await c.assignments.getAssignment(t1))!;
    const after2 = (await c.assignments.getAssignment(t2))!;
    assert.deepEqual([after1.owner, after1.generation, after1.revision], [moved.owner, moved.generation, moved.revision]);
    assert.deepEqual([after2.owner, after2.generation, after2.revision], [again.owner, again.generation, again.revision]);
  });

  suite("a join that loses a race with the end of the meeting is refused, never left present in an ended room", async (c) => {
    const id = await c.urgent([c.pA, c.pB]);
    await c.room(id);
    // The end of the meeting happens between the join's reads and its commit (the meeting task is being assigned).
    await c.prep(id, c.pA);
    let ended = false;
    const racing = {
      epoch: c.assignments.epoch,
      assignTask: async (cmd: Parameters<AssignmentService["assignTask"]>[0]) => {
        const result = await c.assignments.assignTask(cmd);
        if (!ended) { ended = true; await c.attendance.endMeeting(c.owner, { commandId: "end-mid-join", occurrenceId: id }); }
        return result;
      },
    } as unknown as AssignmentService;
    await refuses("invalid_command", () => c.make({ assignments: racing }).join(c.owner, { commandId: "jn-race", occurrenceId: id, agent: c.pA }));
    const a = await c.att(id, c.pA);
    assert.notEqual(a.state, "present");
    assert.equal(a.joinedAt, undefined);
    assert.equal((await c.status(id)).phase, "ended");
  });

  suite("a decision that supersedes a task makes its agent revalidate before it continues, present or absent", async (c) => {
    const t1 = await c.task(c.agentA);
    const t3 = await c.task(c.agentB);
    c.other.set(c.pB, "stopped");
    const id = await c.urgent([c.pA, c.pB]);
    await c.room(id);
    await c.attend(id, c.pA, [t1]);
    const decisions: MeetingDecision[] = [{ ref: "decision:use-the-new-queue", summary: "switch to the new queue", supersedes: [t1, t3] }];
    const done = await c.attendance.endMeeting(c.owner, { commandId: cid("end"), occurrenceId: id, decisions, revalidateWithinMinutes: 60 });
    // A attended: its pause stays until it has revalidated. B was absent: it is notified, once, and must revalidate when it returns.
    assert.deepEqual(done.returned.find((r) => r.who === c.pA)!.outcomes.map((o) => o.outcome), ["revalidating"]);
    assert.equal(await c.gateIntent(t1), "pause");
    assert.deepEqual([...done.revalidating].sort(), [c.pA, c.pB].sort());
    assert.deepEqual(done.notified, [c.pB]);
    assert.equal(c.notices.length, 1);
    assert.deepEqual([c.notices[0]!.agent, c.notices[0]!.key, c.notices[0]!.taskIds, c.notices[0]!.decisions], [c.pB, `${id}:${c.pB}`, [t3], ["decision:use-the-new-queue"]]);
    const needA = (await c.attendance.revalidation(c.owner, t1))!;
    assert.deepEqual([needA.required, needA.entries[0]!.attended, needA.entries[0]!.overdue], [true, true, false]);
    const needB = (await c.attendance.revalidation(c.owner, t3))!;
    assert.deepEqual([needB.required, needB.entries[0]!.attended, needB.entries[0]!.notifiedAt !== undefined], [true, false, true]);
    assert.equal((await c.attendance.revalidation(c.owner, await c.task(c.agentB)))!.required, false, "a task the decision does not name is not held");
    assert.deepEqual(await c.attendance.pendingReturns(c.owner), [derivedId("mat", `${id}\0${c.pA}`)]);
    // Returning before the acknowledgement keeps the pause; the sweep does too.
    assert.deepEqual((await c.attendance.returnToWork(c.owner, { commandId: cid("rt"), occurrenceId: id, agent: c.pA })).map((o) => o.outcome), ["revalidating"]);
    assert.deepEqual(await c.attendance.sweepReturns(c.owner), { checked: 1, remaining: 1, endedRooms: [], unnotified: 0 });
    // Only the agent acknowledges its own requirement.
    await refuses("forbidden", () => c.attendance.acknowledge(c.mgr, { commandId: cid("ak"), occurrenceId: id, outcome: "continue" }));
    await refuses("forbidden", () => c.attendance.acknowledge(c.owner, { commandId: cid("ak"), occurrenceId: id, outcome: "continue" }));
    minutes(61);
    assert.equal((await c.attendance.revalidation(c.owner, t3))!.entries[0]!.overdue, true, "overdue is visible; nothing lifts it for the agent");
    await c.attendance.acknowledge(c.asA, { commandId: cid("ak"), occurrenceId: id, outcome: "replanned", note: "moved to the new queue" });
    assert.equal((await c.attendance.revalidation(c.owner, t1))!.required, false);
    assert.equal((await c.attendance.revalidation(c.owner, t3))!.required, true, "B has not acknowledged");
    // The sweep completes the return; the pending list empties.
    assert.deepEqual(await c.attendance.sweepReturns(c.owner), { checked: 1, remaining: 0, endedRooms: [], unnotified: 0 });
    assert.equal(await c.gateIntent(t1), "active");
    assert.deepEqual(await c.attendance.pendingReturns(c.owner), []);
    // B comes back and revalidates.
    c.other.set(c.pB, "available");
    assert.equal((await c.attendance.acknowledge(c.asB, { commandId: cid("ak"), all: true, outcome: "continue" })).cleared, 1);
    assert.equal((await c.attendance.revalidation(c.owner, t3))!.required, false);
    // Who may ask is limited: another project's manager gets what a missing task gets.
    assert.equal(await c.attendance.revalidation(c.eve, t3), undefined);
    assert.equal((await c.attendance.revalidation(c.asB, t3))!.required, false);
  });

  suite("a new priority defers the return without transferring the assignment, and the return runs again when the time has come", async (c) => {
    const t1 = await c.task(c.agentA);
    const id = await c.urgent([c.pA, c.pB]);
    await c.room(id);
    await c.attend(id, c.pA, [t1]);
    const before = (await c.assignments.getAssignment(t1))!;
    const done = await c.attendance.endMeeting(c.owner, { commandId: cid("end"), occurrenceId: id, decisions: [{ ref: "decision:hotfix-first", defers: [t1], deferMinutes: 120 }] });
    assert.deepEqual(done.returned.find((r) => r.who === c.pA)!.outcomes.map((o) => o.outcome), ["deferred"]);
    assert.equal(await c.gateIntent(t1), "pause");
    const item = (await c.att(id, c.pA)).interrupted[0]!;
    assert.equal(item.deferUntil, "2026-10-23T10:00:00.000Z");
    assert.deepEqual(await c.attendance.sweepReturns(c.owner), { checked: 1, remaining: 1, endedRooms: [], unnotified: 0 });
    minutes(121);
    assert.deepEqual(await c.attendance.sweepReturns(c.owner), { checked: 1, remaining: 0, endedRooms: [], unnotified: 0 });
    assert.equal(await c.gateIntent(t1), "active");
    const after = (await c.assignments.getAssignment(t1))!;
    assert.deepEqual([after.owner, after.generation, after.revision], [before.owner, before.generation, before.revision]);
    // The same through deferReturn, by whoever may pause the task, with a bounded time.
    const t2 = await c.task(c.agentA);
    const id2 = await c.urgent([c.pA]);
    await c.room(id2);
    await c.attend(id2, c.pA, [t2]);
    await c.attendance.leave(c.asA, { commandId: cid("lv"), occurrenceId: id2, agent: c.pA });
    await refuses("forbidden", () => c.attendance.deferReturn(c.eve, { commandId: cid("df"), occurrenceId: id2, agent: c.pA, taskId: t2, minutes: 30, reason: "x" }));
    await refuses("invalid_command", () => c.attendance.deferReturn(c.mgr, { commandId: cid("df"), occurrenceId: id2, agent: c.pA, taskId: t2, minutes: ATTENDANCE_LIMITS.deferMax + 1, reason: "x" }));
    const d = await c.attendance.deferReturn(c.mgr, { commandId: cid("df"), occurrenceId: id2, agent: c.pA, taskId: t2, minutes: 30, reason: "the release comes first" });
    assert.equal(d.until, new Date(now + 30 * 60_000).toISOString());
    assert.deepEqual((await c.attendance.returnToWork(c.owner, { commandId: cid("rt"), occurrenceId: id2, agent: c.pA })).map((o) => o.outcome), ["deferred"]);
    minutes(31);
    assert.deepEqual((await c.attendance.returnToWork(c.owner, { commandId: cid("rt"), occurrenceId: id2, agent: c.pA })).map((o) => o.outcome), ["resumed"]);
  });

  suite("a return can be made for an agent that left early, but not for one still in the meeting", async (c) => {
    const t1 = await c.task(c.agentA);
    const id = await c.urgent([c.pA, c.pB]);
    await c.room(id);
    await c.attend(id, c.pA, [t1]);
    await refuses("invalid_command", () => c.attendance.returnToWork(c.owner, { commandId: cid("rt"), occurrenceId: id, agent: c.pA }), (e) => assert.match(e.message, /still in the meeting/));
    await c.attendance.leave(c.asA, { commandId: cid("lv"), occurrenceId: id, agent: c.pA });
    assert.equal(await c.gateIntent(t1), "pause", "leaving alone resumes nothing");
    assert.deepEqual((await c.attendance.returnToWork(c.mgr, { commandId: cid("rt"), occurrenceId: id, agent: c.pA })).map((o) => o.outcome), ["resumed"]);
    assert.equal(await c.gateIntent(t1), "active");
    // Resuming is L01's authority: a host without it cannot, and the pause stays.
    const t2 = await c.task(c.agentB);
    await c.attend(id, c.pB, [t2]);
    await c.attendance.leave(c.asB, { commandId: cid("lv"), occurrenceId: id, agent: c.pB });
    await refuses("forbidden", () => c.attendance.returnToWork(c.host, { commandId: cid("rt"), occurrenceId: id, agent: c.pB }));
    assert.equal(await c.gateIntent(t2), "pause");
    await refuses("forbidden", () => c.attendance.returnToWork(c.eve, { commandId: cid("rt"), occurrenceId: id, agent: c.pB }));
  });

  // ---- authorization ------------------------------------------------------------------------------------------------------------------------------------------

  suite("no one acts as another principal, and nothing is accepted from the caller that names one", async (c) => {
    const t1 = await c.task(c.agentA);
    const id = await c.urgent([c.pA, c.pB]);
    await c.room(id);
    // Fields that name a principal are not accepted.
    await refuses("invalid_command", () => c.attendance.join(c.asA, { commandId: cid("jn"), occurrenceId: id, agent: c.pA, actor: c.owner.id } as never));
    await refuses("invalid_command", () => c.attendance.endMeeting(c.owner, { commandId: cid("end"), occurrenceId: id, actor: c.owner.id } as never));
    await refuses("invalid_command", () => c.attendance.acknowledge(c.asA, { commandId: cid("ak"), occurrenceId: id, outcome: "continue", agent: c.pB } as never));
    // An agent joins only itself; a reader and another project's manager cannot join or prepare anyone; a stranger's rooms read as missing.
    await refuses("forbidden", () => c.attendance.join(c.asA, { commandId: cid("jn"), occurrenceId: id, agent: c.pB }));
    await refuses("forbidden", () => c.attendance.join(c.reader, { commandId: cid("jn"), occurrenceId: id, agent: c.pA }));
    await refuses("forbidden", () => c.attendance.join(c.eve, { commandId: cid("jn"), occurrenceId: id, agent: c.pA }));
    await refuses("forbidden", () => c.attendance.prepare(c.reader, { commandId: cid("pr"), occurrenceId: id, agent: c.pA, interrupted: [t1] }));
    await refuses("forbidden", () => c.attendance.prepare(c.eve, { commandId: cid("pr"), occurrenceId: id, agent: c.pA, interrupted: [t1] }));
    await refuses("forbidden", () => c.attendance.openRoom(c.eve, { commandId: cid("or"), occurrenceId: id }));
    await refuses("forbidden", () => c.attendance.openRoom(c.asC, { commandId: cid("or"), occurrenceId: id }));
    await refuses("forbidden", () => c.attendance.leave(c.asB, { commandId: cid("lv"), occurrenceId: id, agent: c.pA }));
    assert.equal(await c.gateIntent(t1), "none", "none of that touched the task");
    // Preparing needs the right to pause the task (L01): a meeting manager without it is refused and the task is not paused; the owner can.
    await c.principals.enroll(c.owner, { commandId: cid("e"), kind: "agent", name: "bare", grants: [{ action: "meeting.manage", project: c.a }] });
    const bareP = await c.principals.authenticate((await c.principals.issueCredential(c.owner, "agent:bare")).token);
    await refuses("forbidden", () => c.attendance.prepare(bareP, { commandId: cid("pr"), occurrenceId: id, agent: c.pA, interrupted: [t1] }));
    assert.equal(await c.gateIntent(t1), "none");
    // A task of another agent cannot be named as A's interrupted work.
    const t3 = await c.task(c.agentB);
    await refuses("invalid_command", () => c.attendance.prepare(c.owner, { commandId: cid("pr"), occurrenceId: id, agent: c.pA, interrupted: [t3] }));
    assert.equal(await c.gateIntent(t3), "none");
    // More than five is refused.
    const many = await Promise.all(Array.from({ length: ATTENDANCE_LIMITS.interrupted + 1 }, () => c.task(c.agentA)));
    await refuses("invalid_command", () => c.attendance.prepare(c.owner, { commandId: cid("pr"), occurrenceId: id, agent: c.pA, interrupted: many }));
    // An occurrence of another project, or one that is not live, gets no room.
    await refuses("forbidden", () => c.attendance.openRoom(c.owner, { commandId: cid("or"), occurrenceId: "mto-bbbbbbbbbbbbbbbbbbbb" }));
  });

  // ---- restart, repeat, concurrency ----------------------------------------------------------------------------------------------------------------------

  suite("repeating, restarting and crashing between steps finish the work once", async (c) => {
    const t1 = await c.task(c.agentA);
    const id = await c.urgent([c.pA, c.pB]);
    const first = await c.attendance.openRoom(c.owner, { commandId: "open-1", occurrenceId: id });
    const second = await c.attendance.openRoom(c.owner, { commandId: "open-1", occurrenceId: id });
    const third = await c.attendance.openRoom(c.mgr, { commandId: "open-9", occurrenceId: id });
    assert.deepEqual([first.roomId === second.roomId, second.replayed, third.roomId === first.roomId], [true, true, true]);
    assert.equal((await c.status(id)).timelineCount, 2, "reopening added nothing");
    await c.attendance.prepare(c.owner, { commandId: "prep-1", occurrenceId: id, agent: c.pA, interrupted: [t1] });
    await c.attendance.prepare(c.owner, { commandId: "prep-1", occurrenceId: id, agent: c.pA, interrupted: [t1] });
    assert.deepEqual((await c.pauses.requests(c.owner, { kind: "task", id: t1 })).length, 1, "one pause, however often it is asked for");
    await c.boundary(t1);
    // A crash after the meeting task exists but before it is assigned: the retry (a new service) finishes it.
    let failed = false;
    const flaky = { epoch: c.assignments.epoch, assignTask: async (cmd: Parameters<AssignmentService["assignTask"]>[0]) => { if (!failed) { failed = true; throw new Error("the process died"); } return c.assignments.assignTask(cmd); } } as unknown as AssignmentService;
    await assert.rejects(c.make({ assignments: flaky }).join(c.owner, { commandId: "join-1", occurrenceId: id, agent: c.pA }), /process died/);
    assert.equal((await c.att(id, c.pA)).state, "preparing");
    const joined = await c.make().join(c.owner, { commandId: "join-2", occurrenceId: id, agent: c.pA });
    assert.ok(joined.joined);
    const tasks = await c.storage.listAggregates("task", { limit: 100 });
    assert.equal(tasks.filter((t) => (t.body as { title?: string }).title?.startsWith("Meeting:")).length, 1, "one meeting task");
    assert.deepEqual((await c.pauses.guard(joined.meetingTaskId!)).blockedBy, []);
    // A crash in the middle of the return: the resume fails once; the end is repeated and completes.
    let resumeFailed = false;
    const flakyPause = {
      pause: (p: Principal, cmd: Parameters<PauseService["pause"]>[1]) => c.pauses.pause(p, cmd), guard: (t: string) => c.pauses.guard(t),
      resume: async (p: Principal, cmd: Parameters<PauseService["resume"]>[1]) => { if (!resumeFailed) { resumeFailed = true; throw new Error("the process died"); } return c.pauses.resume(p, cmd); },
    } as unknown as PauseService;
    await assert.rejects(c.make({ pauses: flakyPause }).endMeeting(c.owner, { commandId: "end-1", occurrenceId: id }), /process died/);
    assert.equal((await c.status(id)).phase, "ended", "the room was closed first");
    assert.equal(await c.gateIntent(t1), "pause");
    const done = await c.make().endMeeting(c.owner, { commandId: "end-2", occurrenceId: id });
    assert.deepEqual(done.returned.find((r) => r.who === c.pA)!.outcomes.map((o) => o.outcome), ["resumed"]);
    assert.equal(await c.gateIntent(t1), "active");
    assert.equal((await c.pauses.requests(c.owner, { kind: "task", id: t1 })).map((r) => r.action).join(), "pause,resume");
    assert.equal((await c.occ(id)).state, "held");
  });

  suite("two joins of one agent make one meeting task, and a join racing the end either lands before it or is refused", async (c) => {
    const id = await c.urgent([c.pA, c.pB]);
    await c.room(id);
    await c.prep(id, c.pA);
    await c.prep(id, c.pB);
    const [x, y] = await Promise.allSettled([
      c.attendance.join(c.asA, { commandId: "jn-a", occurrenceId: id, agent: c.pA }),
      c.attendance.join(c.owner, { commandId: "jn-b", occurrenceId: id, agent: c.pA }),
    ]);
    const ok = [x, y].filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<AttendanceService["join"]>>>[];
    assert.ok(ok.length >= 1, JSON.stringify([x, y]));
    assert.ok(ok.every((r) => r.value.joined));
    assert.equal(new Set(ok.map((r) => r.value.meetingTaskId)).size, 1);
    const tasks = (await c.storage.listAggregates("task", { limit: 100 })).filter((t) => (t.body as { title?: string }).title?.startsWith("Meeting:"));
    assert.equal(tasks.length, 1);
    // The end racing B's join: afterwards B is either in and has left (task finished) or was refused; never present in an ended room.
    const [j, e] = await Promise.allSettled([
      c.attendance.join(c.asB, { commandId: "jn-c", occurrenceId: id, agent: c.pB }),
      c.attendance.endMeeting(c.owner, { commandId: "end-c", occurrenceId: id }),
    ]);
    assert.equal(e.status, "fulfilled", JSON.stringify(e));
    if (j.status === "rejected") assert.ok(j.reason instanceof DomainError);
    const b = await c.att(id, c.pB);
    assert.ok(b.state !== "present", "nobody is left present in an ended room");
    if (b.joinedAt !== undefined) assert.ok(b.leftAt !== undefined);
    // Two ends at once settle the meeting once.
    const id2 = await c.urgent([c.pA]);
    await c.room(id2);
    await c.attend(id2, c.pA, []);
    const ends = await Promise.allSettled([c.attendance.endMeeting(c.owner, { commandId: "e1", occurrenceId: id2 }), c.attendance.endMeeting(c.host, { commandId: "e2", occurrenceId: id2 })]);
    assert.ok(ends.some((r) => r.status === "fulfilled"), JSON.stringify(ends));
    assert.equal((await c.occ(id2)).state, "held");
    await c.attendance.endMeeting(c.owner, { commandId: "e3", occurrenceId: id2 });
  });

  suite("a room whose meeting was never ended is ended by the sweep once the meeting has lapsed, so no attendance pause is held for ever", async (c) => {
    const t1 = await c.task(c.agentA);
    const id = await c.urgent([c.pA, c.pB], { durationMinutes: 30 });
    await c.room(id);
    const joined = await c.attend(id, c.pA, [t1]);
    // Within the meeting and its grace the sweep leaves the room alone.
    at("2026-10-23T09:20:00.000Z");
    assert.deepEqual(await c.attendance.sweepReturns(c.owner), { checked: 0, remaining: 0, endedRooms: [], unnotified: 0 });
    assert.equal(await c.gateIntent(t1), "pause");
    // Past the end plus M01's 60-minute grace: the room ends as a lapsed meeting. Everyone leaves, the pause made for attendance is lifted, the occurrence is left to M01.
    at("2026-10-23T09:31:00.000Z");
    assert.deepEqual(await c.attendance.sweepReturns(c.owner), { checked: 0, remaining: 0, endedRooms: [id], unnotified: 0 });
    assert.equal(await c.gateIntent(t1), "active");
    assert.equal(((await c.projects.getTask(joined.meetingTaskId!))!).state, "done");
    assert.equal((await c.status(id)).phase, "ended");
    assert.equal((await c.occ(id)).state, "planned");
    assert.equal((await c.meetings.tick(c.host)).missed.includes(id), true, "M01 marks it missed");
    assert.deepEqual(await c.attendance.sweepReturns(c.owner), { checked: 0, remaining: 0, endedRooms: [], unnotified: 0 });
    // A meeting cancelled while people are in it is ended at the next sweep, at once.
    const t3 = await c.task(c.agentB);
    const id2 = await c.urgent([c.pB]);
    await c.room(id2);
    await c.attend(id2, c.pB, [t3]);
    await c.meetings.settle(c.owner, { commandId: cid("st"), occurrenceId: id2, outcome: "cancelled", reason: "the build is green again" });
    assert.deepEqual((await c.attendance.sweepReturns(c.owner)).endedRooms, [id2]);
    assert.equal(await c.gateIntent(t3), "active");
    await refuses("forbidden", () => c.attendance.sweepReturns(c.mgr));
  });

  suite("the bounded permission covers the meeting task only while it is the invited agent's", async (c) => {
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "agent", id: c.agentA }, reason: "A is paused" });
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "agent", id: c.agentC }, reason: "C is paused" });
    const id = await c.urgent([c.pA]);
    await c.room(id);
    await c.meetings.inviteDirect(c.owner, { commandId: cid("iv"), occurrenceId: id, agent: c.pA });
    await c.attendance.refresh(c.owner, id);
    const joined = await c.attend(id, c.pA, []);
    const meetingTask = joined.meetingTaskId!;
    assert.deepEqual((await c.pauses.guard(meetingTask)).blockedBy, []);
    // Reassigned to another paused agent, the permission does not follow it.
    const asg = (await c.assignments.getAssignment(meetingTask))!;
    await c.assignments.transferTask({ commandId: cid("tf"), actor: c.owner.id, taskId: meetingTask, expectedRevision: asg.revision, to: { kind: "agent", id: c.agentC } });
    assert.deepEqual((await c.pauses.guard(meetingTask)).blockedBy, [{ kind: "agent", id: c.agentC }]);
  });

  suite("a notice that fails to send never keeps anyone from returning to work, is reported as unnotified, and is retried by the sweep", async (c) => {
    const t1 = await c.task(c.agentA);
    const t3 = await c.task(c.agentB);
    c.other.set(c.pB, "stopped");
    const id = await c.urgent([c.pA, c.pB]);
    await c.room(id);
    await c.attend(id, c.pA, [t1]);
    c.failNotice.next = true;
    const decisions: MeetingDecision[] = [{ ref: "decision:x", supersedes: [t3] }];
    const first = await c.attendance.endMeeting(c.owner, { commandId: "end-1", occurrenceId: id, decisions });
    assert.deepEqual([first.notified, first.unnotified], [[], [c.pB]]);
    assert.equal(c.notices.length, 0);
    // The attendee was returned all the same, and the requirement exists.
    assert.deepEqual(first.returned.find((r) => r.who === c.pA)!.outcomes.map((o) => o.outcome), ["resumed"]);
    assert.equal(await c.gateIntent(t1), "active");
    assert.equal((await c.attendance.revalidation(c.owner, t3))!.required, true);
    // Repeating the end reports it again (the sink works now) and sends it once; the sweep has nothing left to retry.
    const done = await c.attendance.endMeeting(c.owner, { commandId: "end-2", occurrenceId: id, decisions });
    assert.deepEqual([done.notified, done.unnotified], [[c.pB], []]);
    assert.equal(c.notices.length, 1);
    assert.equal((await c.attendance.revalidation(c.owner, t3))!.entries.length, 1, "one requirement, not two");
    assert.ok((await c.attendance.revalidation(c.owner, t3))!.entries[0]!.notifiedAt !== undefined);
    assert.equal((await c.attendance.sweepReturns(c.owner)).unnotified, 0);
    // A failure that is only retried by the sweep.
    const t5 = await c.task(c.agentB);
    const id2 = await c.urgent([c.pB]);
    await c.room(id2);
    c.failNotice.next = true;
    const r2 = await c.attendance.endMeeting(c.owner, { commandId: "end-3", occurrenceId: id2, decisions: [{ ref: "decision:y", supersedes: [t5] }] });
    assert.deepEqual(r2.unnotified, [c.pB]);
    assert.deepEqual(await c.attendance.sweepReturns(c.owner), { checked: 0, remaining: 0, endedRooms: [], unnotified: 0 });
    assert.equal(c.notices.length, 2);
    assert.ok((await c.attendance.revalidation(c.owner, t5))!.entries[0]!.notifiedAt !== undefined);
    // With no notice path composed, the agents are reported as unnotified, and the requirement stands.
    const bare = AttendanceService.withEpoch(c.storage, c.epoch, { meetings: c.meetings, pauses: c.pauses, projects: c.projects, assignments: c.assignments }, { availability: c.pauses.availability, ...options });
    const t6 = await c.task(c.agentB);
    const id3 = await c.urgent([c.pB]);
    await bare.openRoom(c.owner, { commandId: cid("or"), occurrenceId: id3 });
    const r3 = await bare.endMeeting(c.owner, { commandId: "end-4", occurrenceId: id3, decisions: [{ ref: "decision:z", supersedes: [t6] }] });
    assert.deepEqual([r3.notified, r3.unnotified], [[], [c.pB]]);
    assert.equal((await bare.revalidation(c.owner, t6))!.required, true);
  });

  suite("a crash between the pause and the write of the attendance leaves the pause ours", async (c) => {
    const t1 = await c.task(c.agentA);
    const id = await c.urgent([c.pA]);
    await c.room(id);
    // The pause is made and the process dies before the attendance records it (simulated by pausing with the very command the preparation uses).
    const attId = derivedId("mat", `${id}\0${c.pA}`);
    await c.pauses.pause(c.owner, { commandId: `attend-pause:${attId}:${t1}`, scope: { kind: "task", id: t1 }, reason: `attending meeting ${id}; resumes when it ends unless paused for another reason` });
    await c.attendance.prepare(c.mgr, { commandId: cid("pr"), occurrenceId: id, agent: c.pA, interrupted: [t1] }).catch((e: unknown) => assert.ok(e instanceof DomainError));
    // A different caller finds a pause it did not make: not ours. The owner repeating the same preparation recognises its own.
    assert.equal((await c.att(id, c.pA)).interrupted.find((x) => x.taskId === t1)?.pausedByUs ?? false, false);
    const t2 = await c.task(c.agentA);
    await c.pauses.pause(c.owner, { commandId: `attend-pause:${attId}:${t2}`, scope: { kind: "task", id: t2 }, reason: `attending meeting ${id}; resumes when it ends unless paused for another reason` });
    await c.attendance.prepare(c.owner, { commandId: cid("pr"), occurrenceId: id, agent: c.pA, interrupted: [t2] });
    assert.equal((await c.att(id, c.pA)).interrupted.find((x) => x.taskId === t2)!.pausedByUs, true);
  });

  suite("a join needs a preparation, even an empty one", async (c) => {
    const id = await c.urgent([c.pA]);
    await c.room(id);
    await refuses("invalid_command", () => c.attendance.join(c.asA, { commandId: cid("jn"), occurrenceId: id, agent: c.pA }), (e) => assert.match(e.message, /prepare/));
    await c.prep(id, c.pA);
    assert.equal((await c.attendance.join(c.asA, { commandId: cid("jn"), occurrenceId: id, agent: c.pA })).joined, true);
  });

  suite("decisions are bounded and refuse secrets and unknown tasks", async (c) => {
    const t1 = await c.task(c.agentA);
    const id = await c.urgent([c.pA]);
    await c.room(id);
    await refuses("invalid_command", () => c.attendance.endMeeting(c.owner, { commandId: cid("end"), occurrenceId: id, decisions: [{ ref: "d", supersedes: ["task-aaaaaaaaaaaaaaaaaaaa"] }] }));
    await refuses("invalid_command", () => c.attendance.endMeeting(c.owner, { commandId: cid("end"), occurrenceId: id, decisions: [{ ref: "d", defers: [t1] }] }), (e) => assert.match(e.message, /time limit/));
    await refuses("invalid_command", () => c.attendance.endMeeting(c.owner, { commandId: cid("end"), occurrenceId: id, decisions: [{ ref: "token=sk-live-0123456789abcdef0123456789abcdef", supersedes: [t1] }] }));
    await refuses("invalid_command", () => c.attendance.endMeeting(c.owner, { commandId: cid("end"), occurrenceId: id, decisions: Array.from({ length: ATTENDANCE_LIMITS.decisions + 1 }, (_, i) => ({ ref: `d${i}` })) }));
    await refuses("invalid_command", () => c.attendance.endMeeting(c.owner, { commandId: cid("end"), occurrenceId: id, decisions: [{ ref: "d", deferMinutes: ATTENDANCE_LIMITS.deferMax + 1, defers: [t1] }] }));
    // Nothing was ended by the refusals.
    assert.equal((await c.status(id)).phase, "open");
    assert.equal((await c.occ(id)).state, "planned");
  });

  suite("the meeting conversation is the room's, and an agent outside the roster is not in it", async (c) => {
    const id = await c.urgent([c.pA, c.pB]);
    await c.room(id);
    const s = await c.status(id);
    assert.ok(s.room.historyId !== undefined);
    const scope = await c.histories.getScope(c.owner, s.room.historyId!);
    assert.equal(scope!.type, "meeting");
    assert.deepEqual([...scope!.participants].sort(), [c.owner.id, c.pA, c.pB].sort());
    await refuses("forbidden", () => c.histories.read(c.asC, s.room.historyId!, { limit: 10 }));
    // Reopening makes no second conversation.
    await c.attendance.openRoom(c.mgr, { commandId: cid("or"), occurrenceId: id });
    assert.equal((await c.status(id)).room.historyId, s.room.historyId);
    assert.equal((await c.storage.listAggregates("history-scope", { limit: 100 })).length, 1);
  });

  suite("an occurrence that is not live and waiting gets no room", async (c) => {
    const id = await c.urgent([c.pA]);
    await c.meetings.settle(c.owner, { commandId: cid("st"), occurrenceId: id, outcome: "cancelled", reason: "not needed" });
    await refuses("invalid_command", () => c.attendance.openRoom(c.owner, { commandId: cid("or"), occurrenceId: id }));
    await refuses("invalid_command", () => c.attendance.openRoom(c.owner, { commandId: cid("or"), occurrenceId: "not-an-id" }));
    await refuses("forbidden", () => c.attendance.openRoom(c.owner, { commandId: cid("or"), occurrenceId: "mto-aaaaaaaaaaaaaaaaaaaa" }));
    assert.equal(await c.attendance.status(c.owner, id), undefined);
  });
}
