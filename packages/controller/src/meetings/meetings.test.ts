import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AgentService } from "../agents/index.js";
import { ConfigurationService } from "../configuration/index.js";
import { DeskService, HistoryService, RetrievalService } from "../context/index.js";
import type { Availability } from "../conversations/index.js";
import { AssignmentService } from "../domain/assignments.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { CommandRunner } from "../domain/runner.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { WaitService } from "../domain/waits.js";
import type { Change, JsonObject } from "../storage/types.js";
import { InquiryService } from "../inquiries/index.js";
import { PauseService } from "../lifecycle/index.js";
import { PrincipalService, type Grant, type Principal } from "../security/index.js";
import { MEETING_LIMITS, MEETING_SETTINGS, MeetingService, ownerTimeZoneFrom, type Invitation, type OccurrenceBody } from "./index.js";

after(stopServer);

// The only clock anything here reads. Tests move it; nothing sleeps.
let now = Date.parse("2026-10-20T08:00:00.000Z");
const at = (iso: string): void => { now = Date.parse(iso); };
const options = { clock: () => new Date(now).toISOString(), pause: async () => undefined };
let projectA = "";
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};

for (const backend of backends) {
  interface Sink { sent: Invitation[]; failFor?: string; invite(i: Invitation): Promise<void> }
  interface Ctx {
    owner: Principal; host: Principal; mgr: Principal; scribe: Principal; reader: Principal; eve: Principal; asA: Principal; asZ: Principal;
    a: string; b: string; agentA: string; agentB: string; agentC: string; pA: string; pB: string; pC: string;
    meetings: MeetingService; reopen(extra?: Partial<ConstructorParameters<typeof Object>[0]>): MeetingService; sink: Sink; other: Map<string, Availability>;
    pauses: PauseService; projects: ProjectService; storage: ConstructorParameters<typeof CommandRunner>[0]; epoch: number;
    make(zone?: () => Promise<string | undefined>): MeetingService; inquiries(): { service: InquiryService; ask(): Promise<string>; ann: Principal; ben: Principal };
    config: ConfigurationService; principals: PrincipalService;
    schedule(extra?: Record<string, unknown>): Promise<string>;
    tickAll(): Promise<Awaited<ReturnType<MeetingService["tick"]>>>;
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
        projectA = a;
        const b = (await projects.createProject({ commandId: cid("pb"), actor: owner.id, name: "B" })).id;
        const agentA = (await agents.create(owner, { commandId: cid("ag"), friendlyName: "A" })).id;
        const agentB = (await agents.create(owner, { commandId: cid("ag"), friendlyName: "B" })).id;
        const agentC = (await agents.create(owner, { commandId: cid("ag"), friendlyName: "C" })).id;
        const [pA, pB, pC] = [`agent:${agentA}`, `agent:${agentB}`, `agent:${agentC}`] as const;
        const other = new Map<string, Availability>();
        const pauses = PauseService.withEpoch(world.storage, epoch, {}, { ...options, otherAvailability: async (id) => other.get(id) ?? "available" });
        const sink: Sink = { sent: [], async invite(i) {
          if (this.failFor === i.agent) { delete this.failFor; throw new Error("the delivery died"); }
          this.sent.push(i);
        } };
        const config = ConfigurationService.withEpoch(world.storage, epoch, { ...options, settings: MEETING_SETTINGS });
        const wiring = (zone?: () => Promise<string | undefined>) => ({ availability: pauses.availability, invitations: sink, ...(zone === undefined ? {} : { ownerTimeZone: zone }), ...options });
        const histories = HistoryService.withEpoch(world.storage, epoch, options);
        const desks = DeskService.withEpoch(world.storage, epoch, options);
        const retrieval = RetrievalService.withEpoch(world.storage, epoch, desks, histories, options);
        const assignments = AssignmentService.withEpoch(world.storage, epoch, projects, options);
        const waits = WaitService.withEpoch(world.storage, epoch, assignments, options);
        const inquiries = InquiryService.withEpoch(world.storage, epoch, { histories, retrieval, waits, assignments }, options);
        const make = (zone?: () => Promise<string | undefined>) => MeetingService.withEpoch(world.storage, epoch, { inquiries }, wiring(zone));
        const meetings = make();
        const host = await enroll("host", "h1", []);
        const mgr = await enroll("agent", "mgr", [{ action: "meeting.manage", project: a }]);
        const scribe = await enroll("agent", "scribe", [{ action: "meeting.agenda", project: a }]);
        const reader = await enroll("agent", "reader", [{ action: "meeting.read", project: a }]);
        const eve = await enroll("agent", "eve", [{ action: "meeting.manage", project: b }, { action: "meeting.agenda", project: b }]);
        const asA = await principals.authenticate((await principals.issueCredential(owner, pA)).token);
        const asZ = await enroll("agent", "zed", []);
        const schedule = async (extra: Record<string, unknown> = {}): Promise<string> =>
          (await meetings.createSchedule(mgr, { commandId: cid("sc"), projectId: a, title: "Daily stand-up", roster: [pA, pB], time: "09:00", timeZone: "Europe/Berlin", ...extra } as never)).id;
        await body({
          owner, host, mgr, scribe, reader, eve, asA, asZ, a, b, agentA, agentB, agentC, pA, pB, pC, meetings, reopen: () => make(), sink, other, pauses, projects, storage: world.storage, epoch, make,
          config, principals, schedule, tickAll: () => meetings.tick(host),
          ...(await (async () => {
            const ann = await enroll("agent", "ann", [{ action: "history.*", project: a }, { action: "desk.read", project: a }, { action: "desk.write", project: a }, { action: "attempt.work", project: a }, { action: "meeting.agenda", project: a }]);
            const ben = await enroll("agent", "ben", [{ action: "history.*", project: a }, { action: "desk.read", project: a }]);
            return {
              inquiries: () => ({
                service: inquiries, ann, ben,
                ask: async () => {
                  const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: a, title: "the task" })).id;
                  await projects.transitionTask({ commandId: cid("tr"), actor: owner.id, taskId: task, expectedRevision: 1, to: "ready" });
                  await assignments.assignTask({ commandId: cid("as"), actor: owner.id, taskId: task, owner: { kind: "agent", id: "ann" } });
                  return (await inquiries.ask(ann, { commandId: cid("ask"), taskId: task, to: "agent:ben", question: "Should this go to the meeting?" } as never)).id;
                },
              }),
            };
          })()),
        } as Ctx);
      } finally { await world.close(); }
    });

  const occurrenceOf = async (c: Ctx, id: string): Promise<OccurrenceBody> => (await c.meetings.occurrence(c.owner, id))!.occurrence as unknown as OccurrenceBody;
  const item = (extra: Record<string, unknown> = {}) => ({ commandId: cid("ag"), projectId: projectA, topic: "Move the nightly build earlier?", question: "Can we run the nightly build at 01:00 instead?", ...extra });

  suite("a daily schedule in Europe/Berlin makes one occurrence per day at the same wall-clock time across both daylight-saving changes, and a repeated tick makes none", async (c) => {
    at("2026-03-26T12:00:00.000Z");
    const id = await c.schedule({ prepareMinutes: 30 });
    const days: [string, string][] = [["2026-03-27", "08:00"], ["2026-03-28", "08:00"], ["2026-03-29", "07:00"], ["2026-03-30", "07:00"]];
    for (const [date, utc] of days) {
      const start = Date.parse(`${date}T${utc}:00.000Z`);
      now = start - 31 * 60_000;
      assert.equal((await c.tickAll()).created.length, 0, `${date}: the preparation window has not opened`);
      now = start - 29 * 60_000;
      const made = (await c.tickAll()).created;
      assert.equal(made.length, 1, date);
      const o = await occurrenceOf(c, made[0]!.occurrenceId);
      assert.deepEqual([o.localDate, o.startsAt, o.mode, o.kind, o.state], [date, `${date}T${utc}:00.000Z`, "live", "scheduled", "planned"]);
      assert.equal(o.prepareFrom, new Date(start - 30 * 60_000).toISOString());
      assert.equal((await c.meetings.schedule(c.mgr, id))!.cursor, o.startsAt, "the cursor moved past the slot in the same commit");
      assert.equal((await c.tickAll()).created.length, 0, "ticking again makes nothing");
      assert.equal((await c.reopen().tick(c.host)).created.length, 0, "nor does a restarted service");
    }
    assert.equal((await c.meetings.schedule(c.mgr, id))!.occurrences, 4);
    // The autumn change: 02:30 happens twice on 2026-10-25; it is one meeting, at the first pass.
    const late = await c.schedule({ time: "02:30" });
    at("2026-10-25T00:35:00.000Z");
    const first = (await c.tickAll()).created.filter((x) => x.scheduleId === late);
    assert.equal(first.length, 1);
    assert.equal((await occurrenceOf(c, first[0]!.occurrenceId)).startsAt, "2026-10-25T00:30:00.000Z");
    at("2026-10-25T01:35:00.000Z");
    assert.equal((await c.tickAll()).created.filter((x) => x.scheduleId === late).length, 0, "the second 02:30 is not a second meeting");
    assert.equal((await c.meetings.schedule(c.mgr, late))!.nextPrepareAt, "2026-10-26T01:30:00.000Z");
  });

  suite("restart after days of downtime creates one occurrence for the latest slot, says what it covers, and a second service or a concurrent tick adds nothing", async (c) => {
    const id = await c.schedule();
    at("2026-10-25T20:00:00.000Z"); // five days later: the controller was down
    const restarted = c.reopen();
    const [one, two] = await Promise.all([restarted.tick(c.host), c.reopen().tick(c.owner)]);
    const made = [...one.created, ...two.created];
    assert.equal(made.length, 1, "exactly one of the two concurrent ticks made it");
    const o = await occurrenceOf(c, made[0]!.occurrenceId);
    assert.deepEqual([o.localDate, o.startsAt, o.mode, o.skippedCount, o.skippedSlots, o.coversFrom], ["2026-10-25", "2026-10-25T08:00:00.000Z", "catch-up", 4, ["2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24"], "2026-10-20T08:00:00.000Z"]);
    assert.equal(o.skippedTruncated, false);
    assert.equal((await restarted.schedule(c.mgr, id))!.occurrences, 1);
    assert.equal((await c.reopen().tick(c.host)).created.length, 0);
    // Next day, two services racing: one more.
    at("2026-10-26T08:10:00.000Z");
    const race = await Promise.all([c.reopen().tick(c.host), c.reopen().tick(c.host), c.reopen().tick(c.owner)]);
    assert.equal(race.flatMap((r) => r.created).length, 1);
    assert.equal((await c.meetings.schedule(c.mgr, id))!.occurrences, 2);
  });

  suite("a restart shortly after the start time still finds a live meeting; a report whose time is over is a catch-up and calls nobody in", async (c) => {
    const id = await c.schedule();
    at("2026-10-23T07:10:00.000Z"); // down since the 20th, back ten minutes into the 23rd's meeting
    const made = (await c.tickAll()).created;
    const o = await occurrenceOf(c, made[0]!.occurrenceId);
    assert.deepEqual([o.mode, o.skippedCount, o.startsAt], ["live", 2, "2026-10-23T07:00:00.000Z"]);
    assert.equal((await c.meetings.dispatchInvitations(c.host, made[0]!.occurrenceId)).invited.length, 2);
    at("2026-10-24T09:00:00.000Z");
    const late = (await c.tickAll()).created[0]!;
    assert.equal(late.mode, "catch-up");
    c.sink.sent.length = 0;
    assert.deepEqual(await c.meetings.dispatchInvitations(c.host, late.occurrenceId), { invited: [], withheld: [] });
    assert.equal(c.sink.sent.length, 0, "no invitation for a report");
    void id;
  });

  suite("a downtime longer than the look-back is reported as truncated", async (c) => {
    await c.schedule();
    at("2028-01-10T20:00:00.000Z");
    const o = await occurrenceOf(c, (await c.tickAll()).created[0]!.occurrenceId);
    assert.equal(o.skippedTruncated, true);
    assert.equal(o.localDate, "2028-01-10");
    assert.ok(o.skippedCount >= MEETING_LIMITS.scheduleScanDays - 3);
  });

  suite("paused, suspended and stopped participants are withheld and not woken; a resumed one can still join; nothing here lifts a pause", async (c) => {
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "agent", id: c.agentA }, reason: "owner asked for quiet" });
    c.other.set(c.pC, "suspended");
    await c.schedule({ roster: [c.pA, c.pB, c.pC] });
    at("2026-10-21T07:01:00.000Z");
    const made = (await c.tickAll()).created[0]!;
    const o = await occurrenceOf(c, made.occurrenceId);
    assert.deepEqual(o.participants.map((p) => [p.id === c.pA ? "A" : p.id === c.pB ? "B" : "C", p.status, p.availability]).sort(), [["A", "withheld-paused", "paused"], ["B", "eligible", "available"], ["C", "withheld-unavailable", "suspended"]]);
    const sent = await c.meetings.dispatchInvitations(c.host, made.occurrenceId);
    assert.deepEqual(sent.invited, [c.pB]);
    assert.deepEqual(sent.withheld.sort(), [c.pA, c.pC].sort());
    assert.deepEqual(c.sink.sent.map((i) => i.agent), [c.pB]);
    assert.equal(c.sink.sent[0]!.key, `${made.occurrenceId}:${c.pB}`);
    assert.equal(await c.pauses.availability(c.pA), "paused", "the pause is still in force");
    // Repeating sends nothing more.
    assert.deepEqual((await c.meetings.dispatchInvitations(c.host, made.occurrenceId)).invited, []);
    assert.equal(c.sink.sent.length, 1);
    // B is paused after the occurrence was made: the invitation is decided again, so nothing goes to it. A is resumed by the owner: it may join late.
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "agent", id: c.agentB }, reason: "later" });
    await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: { kind: "agent", id: c.agentA }, reason: "back" });
    const second = await c.meetings.dispatchInvitations(c.host, made.occurrenceId);
    assert.deepEqual(second.invited, [c.pA]);
    assert.ok(second.withheld.includes(c.pB));
    const after = await occurrenceOf(c, made.occurrenceId);
    assert.equal(after.participants.find((p) => p.id === c.pB)!.status, "withheld-paused");
    assert.equal(after.participants.find((p) => p.id === c.pB)!.invitedAt !== undefined, true, "B had been invited before it was paused, and that stays on record");
    assert.equal(await c.pauses.availability(c.pB), "paused");
  });

  suite("the owner can invite one paused agent by hand: it attends that meeting only and stays paused; a suspended agent is not woken by an invitation", async (c) => {
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "agent", id: c.agentA }, reason: "quiet" });
    c.other.set(c.pC, "stopped");
    await c.schedule({ roster: [c.pA, c.pB, c.pC] });
    at("2026-10-21T07:01:00.000Z");
    const id = (await c.tickAll()).created[0]!.occurrenceId;
    await refuses("forbidden", () => c.meetings.inviteDirect(c.mgr, { commandId: cid("iv"), occurrenceId: id, agent: c.pA }));
    await refuses("invalid_command", () => c.meetings.inviteDirect(c.owner, { commandId: cid("iv"), occurrenceId: id, agent: c.pC }), (e) => assert.match(e.message, /does not wake/));
    await refuses("invalid_command", () => c.meetings.inviteDirect(c.owner, { commandId: cid("iv"), occurrenceId: id, agent: "agent:agt-aaaaaaaaaaaaaaaaaaaa" }), (e) => assert.match(e.message, /not on the roster/));
    const command = { commandId: cid("iv"), occurrenceId: id, agent: c.pA };
    await c.meetings.inviteDirect(c.owner, command);
    await c.meetings.inviteDirect(c.owner, command);
    const result = await c.meetings.dispatchInvitations(c.host, id);
    assert.deepEqual(result.invited.sort(), [c.pA, c.pB].sort());
    assert.equal(c.sink.sent.find((i) => i.agent === c.pA)!.bounded, true);
    assert.equal(c.sink.sent.find((i) => i.agent === c.pB)!.bounded, false);
    assert.deepEqual(result.withheld, [c.pC]);
    assert.equal(await c.pauses.availability(c.pA), "paused", "attending does not resume its other work");
    assert.equal((await occurrenceOf(c, id)).participants.find((p) => p.id === c.pC)!.status, "withheld-unavailable");
    // The invited agent is stopped after all: it is withheld at dispatch time.
    c.other.set(c.pA, "stopped");
    await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: { kind: "agent", id: c.agentA }, reason: "x" });
    assert.equal((await occurrenceOf(c, id)).participants.find((p) => p.id === c.pA)!.invitedAt !== undefined, true);
  });

  suite("delivery of invitations is at least once: a sink that dies part-way is retried with the same keys and nobody is recorded as invited before delivery", async (c) => {
    await c.schedule();
    at("2026-10-21T07:01:00.000Z");
    const id = (await c.tickAll()).created[0]!.occurrenceId;
    c.sink.failFor = c.pB;
    await assert.rejects(() => c.meetings.dispatchInvitations(c.host, id), /delivery died/);
    assert.deepEqual((await occurrenceOf(c, id)).participants.map((p) => p.invitedAt), [undefined, undefined], "nothing was recorded");
    const again = await c.meetings.dispatchInvitations(c.host, id);
    assert.deepEqual(again.invited.sort(), [c.pA, c.pB].sort());
    assert.equal(new Set(c.sink.sent.map((i) => i.key)).size, 2, "the first agent's invitation went twice under one key, which a sink de-duplicates");
    await refuses("forbidden", () => c.meetings.dispatchInvitations(c.mgr, id));
  });

  suite("an urgent meeting starts at once, is idempotent by command ID, withholds paused participants, and brings the waiting urgent topics", async (c) => {
    at("2026-10-21T10:00:00.000Z");
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "agent", id: c.agentA }, reason: "quiet" });
    const urgentTopic = await c.meetings.addAgendaItem(c.scribe, item({ urgency: "urgent", topic: "Production build is red" }));
    const calm = await c.meetings.addAgendaItem(c.scribe, item({ topic: "Rename the build job" }));
    const command = { commandId: cid("ug"), projectId: c.a, title: "Build is red", reason: "Nobody can merge until it is green.", roster: [c.pB, c.pA, c.pB] };
    const made = await c.meetings.callUrgent(c.mgr, command);
    assert.equal((await c.meetings.callUrgent(c.mgr, command)).id, made.id);
    assert.equal((await c.meetings.callUrgent(c.mgr, command)).replayed, true);
    const o = (await c.meetings.occurrence(c.mgr, made.id))!;
    assert.deepEqual([o.occurrence.kind, o.occurrence.mode, o.occurrence.startsAt, o.occurrence.state], ["urgent", "live", "2026-10-21T10:00:00.000Z", "planned"]);
    assert.deepEqual(o.occurrence.participants.map((p) => [p.id === c.pA ? "A" : "B", p.status]).sort(), [["A", "withheld-paused"], ["B", "eligible"]], "the duplicate in the roster is one participant");
    assert.deepEqual(o.agenda.map((i) => i.topic), ["Build is red", "Production build is red"]);
    assert.equal((await c.meetings.agendaItem(c.owner, calm.id))!.state, "queued", "the calm topic waits");
    assert.equal((await c.meetings.agendaItem(c.owner, urgentTopic.id))!.state, "scheduled");
    assert.deepEqual((await c.meetings.dispatchInvitations(c.host, made.id)).invited, [c.pB]);
    assert.equal(c.sink.sent[0]!.urgent, true);
    // Refusals.
    await refuses("forbidden", () => c.meetings.callUrgent(c.reader, { ...command, commandId: cid("ug") }));
    await refuses("forbidden", () => c.meetings.callUrgent(c.eve, { ...command, commandId: cid("ug") }));
    await refuses("invalid_command", () => c.meetings.callUrgent(c.mgr, { ...command, commandId: cid("ug"), roster: [c.pB, "agent:nobody"] }), (e) => assert.match(e.message, /not an active agent/));
    await refuses("invalid_command", () => c.meetings.callUrgent(c.mgr, { ...command, commandId: cid("ug"), roster: [] }));
    await refuses("command_conflict", () => c.meetings.callUrgent(c.mgr, { ...command, title: "something else" }));
    await refuses("invalid_command", () => c.meetings.callUrgent(c.mgr, { ...command, commandId: cid("ug"), extra: 1 } as never));
  });

  suite("the agenda is retained: urgent first, limited to the participants named, cancelled or missed meetings give items back, held meetings defer what they did not reach", async (c) => {
    // The clock moves between additions so that "oldest first" is well defined.
    const normal = await c.meetings.addAgendaItem(c.scribe, item({ topic: "Normal topic" }));
    now += 1000;
    const urgent = await c.meetings.addAgendaItem(c.scribe, item({ topic: "Urgent topic", urgency: "urgent" }));
    now += 1000;
    const forC = await c.meetings.addAgendaItem(c.scribe, item({ topic: "Only for C", participants: [c.pC] }));
    now += 1000;
    await c.schedule();
    at("2026-10-21T07:01:00.000Z");
    const first = (await c.tickAll()).created[0]!.occurrenceId;
    let view = (await c.meetings.occurrence(c.owner, first))!;
    assert.deepEqual(view.agenda.map((i) => i.topic), ["Urgent topic", "Normal topic"]);
    assert.deepEqual((await c.meetings.openAgenda(c.owner, c.a))!.items.map((i) => i.topic), ["Only for C"], "what the meeting did not take is still queued");
    // Cancelling gives the items back; they come with the next meeting.
    await c.meetings.settle(c.mgr, { commandId: cid("st"), occurrenceId: first, outcome: "cancelled", reason: "the chair is out" });
    assert.deepEqual((await c.meetings.openAgenda(c.owner, c.a))!.items.map((i) => i.topic), ["Urgent topic", "Normal topic", "Only for C"]);
    assert.equal((await c.meetings.agendaItem(c.owner, urgent.id))!.state, "queued");
    assert.equal((await c.meetings.planned(c.mgr, c.a))!.items.length, 0, "the settled meeting is no longer waiting");
    at("2026-10-22T07:01:00.000Z");
    const second = (await c.tickAll()).created[0]!.occurrenceId;
    view = (await c.meetings.occurrence(c.owner, second))!;
    assert.deepEqual(view.agenda.map((i) => i.topic), ["Urgent topic", "Normal topic"]);
    // The meeting discusses one item and runs out of time for the other.
    const u = (await c.meetings.agendaItem(c.owner, urgent.id))!;
    await c.meetings.setAgendaState(c.mgr, { commandId: cid("as"), itemId: urgent.id, expectedRevision: u.revision, to: "discussed", outcomeRef: "decision-record-1" });
    await refuses("forbidden", () => c.meetings.settle(c.mgr, { commandId: cid("st"), occurrenceId: second, outcome: "held" }));
    await c.meetings.settle(c.host, { commandId: "held-once", occurrenceId: second, outcome: "held" });
    await c.meetings.settle(c.host, { commandId: "held-once", occurrenceId: second, outcome: "held" });
    await refuses("invalid_command", () => c.meetings.settle(c.host, { commandId: cid("st"), occurrenceId: second, outcome: "held" }), (e) => assert.match(e.message, /already held/));
    const done = (await c.meetings.agendaItem(c.owner, urgent.id))!;
    assert.deepEqual([done.state, done.outcomeRef], ["discussed", "decision-record-1"]);
    const unreached = (await c.meetings.agendaItem(c.owner, normal.id))!;
    assert.deepEqual([unreached.state, unreached.deferral?.reason], ["deferred", "the meeting did not reach it"]);
    assert.deepEqual((await c.meetings.openAgenda(c.owner, c.a))!.items.map((i) => i.topic), ["Normal topic", "Only for C"], "the deferred item is open, with its reason visible");
    // The deferred item comes back on the next agenda.
    at("2026-10-23T07:01:00.000Z");
    const third = (await c.tickAll()).created[0]!.occurrenceId;
    assert.deepEqual((await c.meetings.occurrence(c.owner, third))!.agenda.map((i) => [i.topic, i.deferral?.nextStep !== undefined]), [["Normal topic", true]]);
    // Nobody holds or cancels the third: a later tick marks it missed and the item is back in the queue.
    at("2026-10-23T09:00:00.000Z");
    const swept = await c.tickAll();
    assert.deepEqual(swept.missed, [third]);
    assert.equal((await occurrenceOf(c, third)).state, "missed");
    assert.equal((await c.meetings.agendaItem(c.owner, normal.id))!.state, "queued");
    void forC;
  });

  suite("a catch-up report takes no agenda items: they stay queued for the next meeting that can be held", async (c) => {
    const topic = await c.meetings.addAgendaItem(c.scribe, item());
    await c.schedule();
    at("2026-10-24T15:00:00.000Z");
    const made = (await c.tickAll()).created[0]!;
    assert.equal(made.mode, "catch-up");
    assert.equal((await c.meetings.occurrence(c.owner, made.occurrenceId))!.agenda.length, 0);
    assert.equal((await c.meetings.agendaItem(c.owner, topic.id))!.state, "queued");
    at("2026-10-25T08:05:00.000Z");
    assert.equal((await c.meetings.occurrence(c.owner, (await c.tickAll()).created[0]!.occurrenceId))!.agenda.length, 1);
  });

  suite("more open items than fit stay open and are counted; the open agenda pages with a continuation marker", async (c) => {
    for (let i = 0; i < MEETING_LIMITS.agendaPerMeeting + 2; i++) await c.meetings.addAgendaItem(c.scribe, item({ topic: `Topic ${String(i).padStart(2, "0")}` }));
    const firstPage = (await c.meetings.openAgenda(c.owner, c.a, { limit: 10 }))!;
    assert.equal(firstPage.items.length, 10);
    assert.ok(firstPage.next !== undefined);
    const rest = (await c.meetings.openAgenda(c.owner, c.a, { limit: 100, afterId: firstPage.next! }))!;
    assert.equal(rest.items.length, MEETING_LIMITS.agendaPerMeeting + 2 - 10);
    assert.equal(rest.next, undefined);
    await c.schedule();
    at("2026-10-21T07:01:00.000Z");
    const o = (await c.meetings.occurrence(c.owner, (await c.tickAll()).created[0]!.occurrenceId))!;
    assert.equal(o.agenda.length, MEETING_LIMITS.agendaPerMeeting);
    assert.equal(o.occurrence.agendaOverflow, 2);
    assert.equal((await c.meetings.openAgenda(c.owner, c.a))!.items.length, 2);
  });

  suite("agenda items move only along legal steps; a deferral needs a reason and a next step; resolved is final; only the owner or a manager changes them", async (c) => {
    const id = (await c.meetings.addAgendaItem(c.scribe, item({ requestedOutcome: "a recommendation", context: "Nightly takes 40 minutes.", intent: "recommendation" }))).id;
    let rev = (await c.meetings.agendaItem(c.owner, id))!.revision;
    await refuses("invalid_command", () => c.meetings.setAgendaState(c.mgr, { commandId: cid("s"), itemId: id, expectedRevision: rev, to: "discussed" }), (e) => assert.match(e.message, /cannot become discussed/));
    await refuses("invalid_command", () => c.meetings.setAgendaState(c.mgr, { commandId: cid("s"), itemId: id, expectedRevision: rev, to: "deferred" }));
    await refuses("invalid_command", () => c.meetings.setAgendaState(c.mgr, { commandId: cid("s"), itemId: id, expectedRevision: rev, to: "deferred", reason: "needs the benchmark" }), (e) => assert.match(e.message, /nextStep/));
    await refuses("invalid_command", () => c.meetings.setAgendaState(c.mgr, { commandId: cid("s"), itemId: id, expectedRevision: rev, to: "deferred", nextStep: "Ben measures" }), (e) => assert.match(e.message, /reason/));
    await refuses("invalid_command", () => c.meetings.setAgendaState(c.mgr, { commandId: cid("s"), itemId: id, expectedRevision: rev, to: "resolved", reason: "x" }));
    await refuses("forbidden", () => c.meetings.setAgendaState(c.reader, { commandId: cid("s"), itemId: id, expectedRevision: rev, to: "resolved" }));
    await refuses("forbidden", () => c.meetings.setAgendaState(c.eve, { commandId: cid("s"), itemId: id, expectedRevision: rev, to: "resolved" }));
    await refuses("stale_revision", () => c.meetings.setAgendaState(c.mgr, { commandId: cid("s"), itemId: id, expectedRevision: rev + 5, to: "resolved" }));
    await c.meetings.setAgendaState(c.mgr, { commandId: cid("s"), itemId: id, expectedRevision: rev, to: "deferred", reason: "needs the benchmark", nextStep: "Ben measures the build first" });
    let seen = (await c.meetings.agendaItem(c.owner, id))!;
    assert.deepEqual([seen.state, seen.deferral], ["deferred", { reason: "needs the benchmark", nextStep: "Ben measures the build first" }]);
    assert.equal((await c.meetings.openAgenda(c.owner, c.a))!.items.length, 1, "deferred stays visible");
    rev = seen.revision;
    // The requester (who owns the item) can put it back in the queue.
    await c.meetings.setAgendaState(c.scribe, { commandId: cid("s"), itemId: id, expectedRevision: rev, to: "queued" });
    seen = (await c.meetings.agendaItem(c.owner, id))!;
    assert.deepEqual([seen.state, seen.deferral], ["queued", undefined]);
    await c.meetings.setAgendaState(c.mgr, { commandId: cid("s"), itemId: id, expectedRevision: seen.revision, to: "resolved", outcomeRef: "decision-7" });
    assert.equal((await c.meetings.openAgenda(c.owner, c.a))!.items.length, 0, "a resolved item leaves the open agenda");
    seen = (await c.meetings.agendaItem(c.owner, id))!;
    await refuses("invalid_command", () => c.meetings.setAgendaState(c.mgr, { commandId: cid("s"), itemId: id, expectedRevision: seen.revision, to: "queued" }), (e) => assert.match(e.message, /is resolved/));
    assert.equal(seen.outcomeRef, "decision-7");
    assert.equal(seen.question, "Can we run the nightly build at 01:00 instead?");
    assert.equal(seen.intent, "recommendation");
  });

  suite("who can do what: grants are per project, service work is for the owner, host and service only, unreadable records look missing", async (c) => {
    const sched = { commandId: cid("sc"), projectId: c.a, title: "Stand-up", roster: [c.pA], time: "09:00", timeZone: "Europe/Berlin" };
    await refuses("forbidden", () => c.meetings.createSchedule(c.reader, sched));
    await refuses("forbidden", () => c.meetings.createSchedule(c.scribe, { ...sched, commandId: cid("sc") }));
    await refuses("forbidden", () => c.meetings.createSchedule(c.eve, { ...sched, commandId: cid("sc") }));
    await refuses("forbidden", () => c.meetings.createSchedule(c.mgr, { ...sched, commandId: cid("sc"), projectId: "proj-aaaaaaaaaaaaaaaaaaaa" }), (e) => assert.doesNotMatch(e.message, /exist/));
    await refuses("forbidden", () => c.meetings.createSchedule(c.mgr, { ...sched, commandId: cid("sc"), projectId: c.b }));
    const id = (await c.meetings.createSchedule(c.mgr, sched)).id;
    assert.ok((await c.meetings.schedule(c.reader, id)) !== undefined);
    assert.equal(await c.meetings.schedule(c.eve, id), undefined, "another project's manager sees nothing");
    assert.equal(await c.meetings.schedule(c.asZ, id), undefined);
    assert.equal(await c.meetings.schedule(c.reader, "msc-aaaaaaaaaaaaaaaaaaaa"), undefined, "the same answer as for a missing one");
    for (const who of [c.mgr, c.scribe, c.reader, c.eve, c.asA]) await refuses("forbidden", () => c.meetings.tick(who), (e) => assert.match(e.message, /meeting clock/));
    await c.meetings.tick(c.host);
    await c.meetings.tick(c.owner);
    await refuses("invalid_command", () => c.meetings.tick(c.host, { limit: 0 }));
    await refuses("invalid_command", () => c.meetings.tick(c.host, { afterId: "x" }));
    // A task credential cannot run the clock.
    await refuses("forbidden", () => c.meetings.tick({ ...c.host, taskScope: { projectId: c.a, taskId: "task-aaaaaaaaaaaaaaaaaaaa" } } as Principal));
    // Agenda: anyone with the agenda right; instructions only from the owner; unknown fields and credentials refused.
    await refuses("forbidden", () => c.meetings.addAgendaItem(c.asZ, { ...item(), projectId: c.a }));
    await refuses("forbidden", () => c.meetings.addAgendaItem(c.eve, { ...item(), projectId: c.a }));
    await refuses("forbidden", () => c.meetings.addAgendaItem(c.scribe, { ...item({ intent: "owner-instruction" }), projectId: c.a }), (e) => assert.match(e.message, /only the owner/));
    await refuses("forbidden", () => c.meetings.addAgendaItem(c.mgr, { ...item({ intent: "delegated-decision" }), projectId: c.a }));
    const instruction = await c.meetings.addAgendaItem(c.owner, { ...item({ intent: "owner-instruction" }), projectId: c.a });
    assert.equal((await c.meetings.agendaItem(c.owner, instruction.id))!.intent, "owner-instruction");
    await refuses("invalid_command", () => c.meetings.addAgendaItem(c.scribe, { ...item({ question: "use Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCDEF please" }), projectId: c.a }), (e) => assert.match(e.message, /credential/));
    await refuses("invalid_command", () => c.meetings.addAgendaItem(c.scribe, { ...item({ surprise: true }), projectId: c.a }));
    await refuses("invalid_command", () => c.meetings.addAgendaItem(c.scribe, { ...item({ urgency: "now" }), projectId: c.a }));
    // Agenda reads: the requester and managers see an item; another project's manager does not.
    const mine = await c.meetings.addAgendaItem(c.scribe, { ...item(), projectId: c.a });
    assert.ok(await c.meetings.agendaItem(c.scribe, mine.id));
    assert.equal(await c.meetings.agendaItem(c.eve, mine.id), undefined);
    assert.equal(await c.meetings.openAgenda(c.eve, c.a), undefined);
    assert.equal(await c.meetings.openAgenda(c.asZ, c.a), undefined);
    // A meeting is visible to its roster and to readers, not to other agents.
    at("2026-10-21T07:01:00.000Z");
    const o = (await c.meetings.tick(c.host)).created[0]!.occurrenceId;
    assert.ok(await c.meetings.occurrence(c.asA, o), "a roster member sees its own meeting");
    assert.ok(await c.meetings.occurrence(c.reader, o));
    assert.equal(await c.meetings.occurrence(c.asZ, o), undefined, "an agent that is not on the roster sees nothing");
    assert.equal(await c.meetings.occurrence(c.eve, o), undefined);
    assert.equal(await c.meetings.occurrence(c.eve, "mto-aaaaaaaaaaaaaaaaaaaa"), undefined);
    await refuses("forbidden", () => c.meetings.settle(c.eve, { commandId: cid("st"), occurrenceId: o, outcome: "cancelled", reason: "no" }));
    await refuses("forbidden", () => c.meetings.settle(c.asA, { commandId: cid("st"), occurrenceId: o, outcome: "held" }));
    await refuses("invalid_command", () => c.meetings.settle(c.mgr, { commandId: cid("st"), occurrenceId: o, outcome: "cancelled" }));
  });

  suite("a topic can point to the conversation it came from: an inquiry the requester can see, or a chat turn; nothing else", async (c) => {
    const { ann, ask } = c.inquiries();
    const inquiryId = await ask();
    const linked = await c.meetings.addAgendaItem(ann, { ...item(), projectId: c.a, source: { kind: "inquiry", id: inquiryId } });
    assert.deepEqual((await c.meetings.agendaItem(c.owner, linked.id))!.source, { kind: "inquiry", id: inquiryId });
    await refuses("invalid_command", () => c.meetings.addAgendaItem(c.scribe, { ...item(), projectId: c.a, source: { kind: "inquiry", id: inquiryId } }), (e) => assert.match(e.message, /can see/));
    await refuses("invalid_command", () => c.meetings.addAgendaItem(c.owner, { ...item(), projectId: c.b, source: { kind: "inquiry", id: inquiryId } }));
    await refuses("invalid_command", () => c.meetings.addAgendaItem(c.owner, { ...item(), projectId: c.a, source: { kind: "inquiry", id: "inq-aaaaaaaaaaaaaaaaaaaa" } }));
    await refuses("invalid_command", () => c.meetings.addAgendaItem(c.scribe, { ...item(), projectId: c.a, source: { kind: "chat-turn", id: "turn-nothing" } }));
    await refuses("invalid_command", () => c.meetings.addAgendaItem(c.scribe, { ...item(), projectId: c.a, source: { kind: "file", id: "x" } as never }));
    const runner = new CommandRunner(c.storage, c.epoch, options);
    await runner.command("test.turn", { commandId: cid("tt"), actor: c.owner.id }, async () => ({ payload: {}, build: async () => ({ ref: { kind: "chat-turn", id: "turn-real" }, creates: true, changes: [{ type: "create" as const, ref: { kind: "chat-turn", id: "turn-real" }, body: { projectId: c.a } }], detail: {} }) }));
    await runner.command("test.turn", { commandId: cid("tt"), actor: c.owner.id }, async () => ({ payload: {}, build: async () => ({ ref: { kind: "chat-turn", id: "turn-foreign" }, creates: true, changes: [{ type: "create" as const, ref: { kind: "chat-turn", id: "turn-foreign" }, body: { projectId: c.b } }], detail: {} }) }));
    const missing = await c.meetings.addAgendaItem(c.mgr, { ...item(), projectId: c.a, source: { kind: "chat-turn", id: "turn-nothing" } }).catch((e: Error) => e.message);
    const foreign = await c.meetings.addAgendaItem(c.mgr, { ...item(), projectId: c.a, source: { kind: "chat-turn", id: "turn-foreign" } }).catch((e: Error) => e.message);
    assert.equal(foreign, missing, "a turn of another project looks exactly like a missing one");
    await refuses("invalid_command", () => c.meetings.addAgendaItem(c.scribe, { ...item(), projectId: c.a, source: { kind: "chat-turn", id: "turn-real" } }), (e) => assert.match(e.message, /may link/));
    const fromChat = await c.meetings.addAgendaItem(c.mgr, { ...item(), projectId: c.a, source: { kind: "chat-turn", id: "turn-real" } });
    assert.deepEqual((await c.meetings.agendaItem(c.owner, fromChat.id))!.source, { kind: "chat-turn", id: "turn-real" });
  });

  suite("the time zone is the owner's setting unless the schedule names one; the setting is checked", async (c) => {
    const zone = ownerTimeZoneFrom(c.config, c.owner);
    const service = c.make(zone);
    const sched = { projectId: c.a, title: "Stand-up", roster: [c.pA], time: "09:00" };
    await refuses("invalid_command", () => service.createSchedule(c.mgr, { ...sched, commandId: cid("sc") }), (e) => assert.match(e.message, /no meeting.timeZone setting/));
    await refuses("invalid_command", () => service.createSchedule(c.mgr, { ...sched, commandId: cid("sc"), timeZone: "Mars/Phobos" }));
    await assert.rejects(() => c.config.stage(c.owner, { commandId: cid("st"), layer: "installation", set: { "meeting.timeZone": "+05:30" } }), /IANA/);
    const staged = await c.config.stage(c.owner, { commandId: cid("st"), layer: "installation", set: { "meeting.timeZone": "Asia/Kolkata" } });
    await c.config.apply(c.owner, { commandId: cid("ap"), layer: "installation", expectedRevision: staged.revision });
    const id = (await service.createSchedule(c.mgr, { ...sched, commandId: cid("sc") })).id;
    const s = (await service.schedule(c.mgr, id))!;
    assert.deepEqual([s.timeZone, s.timeZoneFromOwnerSetting, s.nextPrepareAt], ["Asia/Kolkata", true, "2026-10-21T03:30:00.000Z"]);
    const named = (await service.createSchedule(c.mgr, { ...sched, commandId: cid("sc"), timeZone: "America/New_York" })).id;
    assert.deepEqual([(await service.schedule(c.mgr, named))!.timeZone, (await service.schedule(c.mgr, named))!.timeZoneFromOwnerSetting], ["America/New_York", false]);
  });

  suite("changing, pausing or resuming a schedule never makes occurrences for times that already passed; ended schedules stay ended", async (c) => {
    const id = await c.schedule();
    let rev = (await c.meetings.schedule(c.mgr, id))!.revision;
    await refuses("forbidden", () => c.meetings.updateSchedule(c.eve, { commandId: cid("u"), scheduleId: id, expectedRevision: rev, state: "paused" }));
    await refuses("stale_revision", () => c.meetings.updateSchedule(c.mgr, { commandId: cid("u"), scheduleId: id, expectedRevision: rev + 3, state: "paused" }));
    await c.meetings.updateSchedule(c.mgr, { commandId: cid("u"), scheduleId: id, expectedRevision: rev, state: "paused" });
    at("2026-10-27T12:00:00.000Z");
    assert.equal((await c.tickAll()).created.length, 0, "a paused schedule makes nothing");
    rev = (await c.meetings.schedule(c.mgr, id))!.revision;
    await c.meetings.updateSchedule(c.mgr, { commandId: cid("u"), scheduleId: id, expectedRevision: rev, state: "active" });
    assert.equal((await c.tickAll()).created.length, 0, "resuming does not replay the week it was paused");
    assert.equal((await c.meetings.schedule(c.mgr, id))!.nextPrepareAt, "2026-10-28T08:00:00.000Z");
    // Moving the time to earlier today (already past) does not make a meeting for it.
    rev = (await c.meetings.schedule(c.mgr, id))!.revision;
    await c.meetings.updateSchedule(c.mgr, { commandId: cid("u"), scheduleId: id, expectedRevision: rev, time: "08:00", timeZone: "Europe/London" });
    assert.equal((await c.tickAll()).created.length, 0);
    assert.equal((await c.meetings.schedule(c.mgr, id))!.nextPrepareAt, "2026-10-28T08:00:00.000Z", "08:00 in London (GMT after the 25th)");
    at("2026-10-28T08:05:00.000Z");
    assert.equal((await c.tickAll()).created.length, 1);
    // A one-off schedule ends after its occurrence, and an ended one cannot be changed.
    const once = await c.schedule({ recurrence: { kind: "once", date: "2026-11-02" } });
    at("2026-11-02T08:05:00.000Z");
    assert.equal((await c.tickAll()).created.filter((x) => x.scheduleId === once).length, 1);
    const ended = (await c.meetings.schedule(c.mgr, once))!;
    assert.equal(ended.state, "ended");
    assert.equal(ended.nextPrepareAt, undefined);
    await refuses("invalid_command", () => c.meetings.updateSchedule(c.mgr, { commandId: cid("u"), scheduleId: once, expectedRevision: ended.revision, state: "active" }), (e) => assert.match(e.message, /has ended/));
    // An end date ends a daily schedule after its last day.
    const bounded = await c.schedule({ endDate: "2026-11-03", startDate: "2026-11-03" });
    at("2026-11-03T08:05:00.000Z");
    assert.equal((await c.tickAll()).created.filter((x) => x.scheduleId === bounded).length, 1);
    assert.equal((await c.meetings.schedule(c.mgr, bounded))!.state, "ended");
  });

  suite("weekly schedules follow the named days in the zone", async (c) => {
    const id = await c.schedule({ recurrence: { kind: "weekly", days: [3, 1, 1] }, timeZone: "America/New_York" });
    const dates: string[] = [];
    for (let d = 21; d <= 30; d++) {
      at(`2026-10-${d}T14:00:00.000Z`);
      const made = (await c.tickAll()).created.filter((x) => x.scheduleId === id);
      if (made.length > 0) dates.push((await occurrenceOf(c, made[0]!.occurrenceId)).localDate);
    }
    assert.deepEqual(dates, ["2026-10-21", "2026-10-26", "2026-10-28"], "Wednesday, Monday, Wednesday");
    assert.deepEqual((await c.meetings.schedule(c.mgr, id))!.recurrence, { kind: "weekly", days: [1, 3] });
    await refuses("invalid_command", () => c.schedule({ recurrence: { kind: "weekly", days: [] } }));
    await refuses("invalid_command", () => c.schedule({ recurrence: { kind: "weekly", days: [7] } }));
    await refuses("invalid_command", () => c.schedule({ recurrence: { kind: "monthly" } }));
    await refuses("invalid_command", () => c.schedule({ time: "9:00" }));
    await refuses("invalid_command", () => c.schedule({ roster: [] }));
    await refuses("invalid_command", () => c.schedule({ roster: ["agent:nobody"] }));
    await refuses("invalid_command", () => c.schedule({ durationMinutes: 0 }));
    await refuses("invalid_command", () => c.schedule({ startDate: "2026-02-30" }));
    await refuses("invalid_command", () => c.schedule({ startDate: "2026-11-05", endDate: "2026-11-01" }));
  });

  suite("the clock pages through many schedules with a marker and leaves none out", async (c) => {
    const ids = [await c.schedule({ title: "One" }), await c.schedule({ title: "Two" }), await c.schedule({ title: "Three" })];
    at("2026-10-21T07:01:00.000Z");
    const first = await c.meetings.tick(c.host, { limit: 2 });
    assert.equal(first.created.length, 2);
    assert.ok(first.next !== undefined, "there is more");
    assert.equal(first.nextDueAt, undefined, "the next-due time is not claimed for a partial pass");
    const second = await c.meetings.tick(c.host, { limit: 2, afterId: first.next! });
    assert.equal(second.created.length, 1);
    assert.equal(second.next, undefined);
    assert.deepEqual([...first.created, ...second.created].map((x) => x.scheduleId).sort(), [...ids].sort());
    assert.equal(second.nextDueAt, "2026-10-22T07:00:00.000Z");
  });

  suite("an edit that makes an already-made date due again advances the cursor and makes no second occurrence", async (c) => {
    const id = await c.schedule();
    at("2026-10-21T07:05:00.000Z");
    const first = (await c.tickAll()).created;
    assert.equal(first.length, 1);
    let rev = (await c.meetings.schedule(c.mgr, id))!.revision;
    await c.meetings.updateSchedule(c.mgr, { commandId: cid("u"), scheduleId: id, expectedRevision: rev, time: "09:30" });
    at("2026-10-21T07:35:00.000Z");
    assert.equal((await c.tickAll()).created.length, 0, "the date already has its meeting");
    const s = (await c.meetings.schedule(c.mgr, id))!;
    assert.deepEqual([s.cursor, s.occurrences, s.nextPrepareAt], ["2026-10-21T07:30:00.000Z", 1, "2026-10-22T07:30:00.000Z"]);
    rev = s.revision;
    assert.equal((await c.tickAll()).created.length, 0);
    assert.equal((await c.meetings.schedule(c.mgr, id))!.revision, rev, "and nothing more is written");
  });

  suite("the open agenda of a project is bounded; an urgent meeting is still possible when it is full", async (c) => {
    for (let i = 0; i < MEETING_LIMITS.openAgendaPerProject; i++) await c.meetings.addAgendaItem(c.scribe, item({ topic: `Topic ${i}` }));
    await refuses("unavailable", () => c.meetings.addAgendaItem(c.scribe, item({ topic: "one too many" })));
    await c.meetings.callUrgent(c.mgr, { commandId: cid("ug"), projectId: c.a, title: "Still possible", reason: "y", roster: [c.pB] });
    assert.equal((await c.meetings.openAgenda(c.owner, c.a, { limit: 100 }))!.items.length, 100);
  });

  const fillOpen = async (c: Ctx, projectId: string, count: number, globalCount = count): Promise<void> => {
    const runner = new CommandRunner(c.storage, c.epoch, options);
    const ids = Array.from({ length: count }, (_, i) => `mto-${String(i).padStart(20, "a")}`);
    const existing = await runner.get("meeting-open", "all");
    const projects = [...new Set([...((existing?.body as { projects?: string[] } | undefined)?.projects ?? []), projectId])];
    const one = (ref: { kind: string; id: string }, body: JsonObject, rev: number | undefined): Change => (rev === undefined ? { type: "create", ref, body } : { type: "update", ref, expectedRevision: rev, body });
    const own = await runner.get("meeting-open", projectId);
    await runner.command("test.fill", { commandId: cid("fill"), actor: c.owner.id }, async () => ({ payload: {}, build: async () => ({
      ref: { kind: "meeting-open", id: projectId }, creates: true, detail: {},
      changes: [one({ kind: "meeting-open", id: projectId }, { ids }, own?.revision), one({ kind: "meeting-open", id: "all" }, { count: globalCount, projects }, existing?.revision)],
    }) }));
  };

  suite("waiting meetings are bounded per project and overall; one busy project does not block another", async (c) => {
    const id = await c.schedule();
    const other = (await c.meetings.createSchedule(c.eve, { commandId: cid("sc"), projectId: c.b, title: "B stand-up", roster: [c.pB], time: "09:00", timeZone: "Europe/Berlin" })).id;
    await fillOpen(c, c.a, MEETING_LIMITS.openOccurrencesPerProject);
    at("2026-10-21T07:01:00.000Z");
    const result = await c.tickAll();
    assert.deepEqual(result.blocked, [id], "project A is full");
    assert.deepEqual(result.created.map((x) => x.scheduleId), [other], "project B is not blocked by it");
    await refuses("unavailable", () => c.meetings.callUrgent(c.mgr, { commandId: cid("ug"), projectId: c.a, title: "x", reason: "y", roster: [c.pB] }));
    // The whole installation full blocks everyone.
    await fillOpen(c, c.b, 1, MEETING_LIMITS.openOccurrences);
    await refuses("unavailable", () => c.meetings.callUrgent(c.eve, { commandId: cid("ug"), projectId: c.b, title: "x", reason: "y", roster: [c.pB] }));
  });

  suite("a catch-up is created already settled as a report: it takes no place in the open lists, is not listed as planned, and cannot block anything", async (c) => {
    const id = await c.schedule();
    await fillOpen(c, c.a, MEETING_LIMITS.openOccurrencesPerProject);
    at("2026-10-25T20:00:00.000Z");
    const result = await c.tickAll();
    assert.deepEqual(result.blocked, [], "a report does not need a place");
    const o = await occurrenceOf(c, result.created[0]!.occurrenceId);
    assert.deepEqual([o.mode, o.state, o.settledAt, o.agenda.length], ["catch-up", "reported", "2026-10-25T20:00:00.000Z", 0]);
    const open = await new CommandRunner(c.storage, c.epoch, options).get("meeting-open", c.a);
    assert.equal((open!.body as unknown as { ids: string[] }).ids.length, MEETING_LIMITS.openOccurrencesPerProject, "the open list did not grow");
    assert.equal((await c.meetings.planned(c.mgr, c.a))!.items.some((i) => i.id === result.created[0]!.occurrenceId), false);
    await refuses("invalid_command", () => c.meetings.settle(c.host, { commandId: cid("st"), occurrenceId: result.created[0]!.occurrenceId, outcome: "held" }), (e) => assert.match(e.message, /already reported/));
    assert.equal((await c.meetings.schedule(c.mgr, id))!.occurrences, 1);
    // After many outages the sweep has nothing of them to settle.
    at("2026-11-30T20:00:00.000Z");
    assert.deepEqual((await c.tickAll()).missed, []);
  });

  suite("when the availability hook is missing or fails, participants are withheld, never invited", async (c) => {
    for (const hook of [undefined, async () => { throw new Error("the pause service is down"); }]) {
      const service = MeetingService.withEpoch(c.storage, c.epoch, {}, { ...options, ...(hook === undefined ? {} : { availability: hook }), invitations: c.sink } as never);
      const made = await service.callUrgent(c.mgr, { commandId: cid("ug"), projectId: c.a, title: "Hook down", reason: "y", roster: [c.pA, c.pB] });
      const o = (await service.occurrence(c.mgr, made.id))!.occurrence;
      assert.deepEqual(o.participants.map((p) => [p.status, p.availability]), [["withheld-unavailable", "stopped"], ["withheld-unavailable", "stopped"]]);
      assert.deepEqual(await service.dispatchInvitations(c.host, made.id), { invited: [], withheld: [c.pA, c.pB].sort() });
      await refuses("invalid_command", () => service.inviteDirect(c.owner, { commandId: cid("iv"), occurrenceId: made.id, agent: c.pA }), (e) => assert.match(e.message, /does not wake/));
    }
    assert.equal(c.sink.sent.length, 0);
  });

  suite("an edit that overtakes a slot is reported by the next tick as skipped, with a reason, and a second meeting on a date is never made", async (c) => {
    const id = await c.schedule();
    // Moved to a later time while today's slot (09:00 Berlin = 07:00Z) was already due and not yet made.
    at("2026-10-21T08:00:00.000Z");
    let rev = (await c.meetings.schedule(c.mgr, id))!.revision;
    await c.meetings.updateSchedule(c.mgr, { commandId: cid("u"), scheduleId: id, expectedRevision: rev, time: "09:30" });
    let result = await c.tickAll();
    assert.equal(result.created.length, 0);
    assert.deepEqual(result.skipped.map((x) => [x.localDate, x.reason.includes("changed or resumed")]), [["2026-10-21", true]]);
    assert.deepEqual((await c.tickAll()).skipped, [], "reported once");
    assert.equal((await c.meetings.schedule(c.mgr, id))!.nextPrepareAt, "2026-10-22T07:30:00.000Z");
    // A date that already has its meeting: the edit moves its time, no second meeting, and the tick says so.
    at("2026-10-22T07:35:00.000Z");
    assert.equal((await c.tickAll()).created.length, 1);
    rev = (await c.meetings.schedule(c.mgr, id))!.revision;
    await c.meetings.updateSchedule(c.mgr, { commandId: cid("u"), scheduleId: id, expectedRevision: rev, time: "10:00" });
    at("2026-10-22T08:05:00.000Z");
    result = await c.tickAll();
    assert.equal(result.created.length, 0);
    assert.deepEqual(result.skipped.map((x) => x.localDate), ["2026-10-22"]);
    assert.match(result.skipped[0]!.reason, /already had its meeting/);
  });

  suite("a tick racing an edit never makes two meetings for a date, never loses a slot silently, and never throws a contention error to the caller", async (c) => {
    const id = await c.schedule();
    at("2026-10-21T07:05:00.000Z");
    const rev = (await c.meetings.schedule(c.mgr, id))!.revision;
    const [ticked, edited] = await Promise.allSettled([c.tickAll(), c.meetings.updateSchedule(c.mgr, { commandId: cid("u"), scheduleId: id, expectedRevision: rev, time: "08:50" })]);
    assert.equal(ticked.status, "fulfilled", String((ticked as PromiseRejectedResult).reason));
    if (edited.status === "rejected") assert.ok(edited.reason instanceof DomainError && edited.reason.code === "stale_revision", String(edited.reason));
    const first = ticked.status === "fulfilled" ? ticked.value : undefined;
    const again = await c.tickAll();
    const total = (first?.created.length ?? 0) + again.created.length;
    assert.ok(total <= 1, "at most one meeting for the date");
    const s = (await c.meetings.schedule(c.mgr, id))!;
    assert.equal(s.occurrences, total);
    // Either the tick won (one meeting, the edit then applies to tomorrow) or the edit won and the slot was reported as skipped.
    const reported = (first?.skipped.length ?? 0) + again.skipped.length;
    assert.ok(total === 1 || reported === 1, `meetings ${total}, skipped ${reported}`);
  });

  suite("a schedule whose first slot is far ahead stays active and waits for it", async (c) => {
    const once = await c.schedule({ recurrence: { kind: "once", date: "2028-01-05" } });
    const daily = await c.schedule({ startDate: "2027-12-31" });
    assert.deepEqual([(await c.meetings.schedule(c.mgr, once))!.state, (await c.meetings.schedule(c.mgr, once))!.nextPrepareAt], ["active", "2028-01-05T08:00:00.000Z"]);
    assert.deepEqual([(await c.meetings.schedule(c.mgr, daily))!.state, (await c.meetings.schedule(c.mgr, daily))!.nextPrepareAt], ["active", "2027-12-31T08:00:00.000Z"]);
    at("2028-01-05T08:00:00.000Z");
    const made = (await c.tickAll()).created.map((x) => x.scheduleId);
    assert.ok(made.includes(once));
    assert.equal((await c.meetings.schedule(c.mgr, once))!.state, "ended");
  });

  suite("items that do not fit back on a full open list stay queued, marked unlisted, and the meeting counts them", async (c) => {
    for (let i = 0; i < 3; i++) { await c.meetings.addAgendaItem(c.scribe, item({ topic: `Topic ${i}` })); now += 1000; }
    await c.schedule();
    at("2026-10-21T07:01:00.000Z");
    const o = (await c.tickAll()).created[0]!.occurrenceId;
    const runner = new CommandRunner(c.storage, c.epoch, options);
    const index = await runner.get("agenda-index", c.a);
    await runner.command("test.fill", { commandId: cid("fill"), actor: c.owner.id }, async () => ({ payload: {}, build: async () => ({
      ref: { kind: "agenda-index", id: c.a }, creates: false, detail: {},
      changes: [{ type: "update" as const, ref: { kind: "agenda-index", id: c.a }, expectedRevision: index!.revision, body: { ids: Array.from({ length: MEETING_LIMITS.openAgendaPerProject }, (_, i) => `mag-${String(i).padStart(20, "a")}`) } }],
    }) }));
    await c.meetings.settle(c.mgr, { commandId: cid("st"), occurrenceId: o, outcome: "cancelled", reason: "off" });
    const settled = await occurrenceOf(c, o);
    assert.equal(settled.agendaUnlisted, 3);
    const items = (await c.meetings.occurrence(c.owner, o))!.agenda;
    assert.deepEqual(items.map((i) => [i.state, i.unlisted]), [["queued", true], ["queued", true], ["queued", true]]);
    await refuses("unavailable", () => c.meetings.setAgendaState(c.mgr, { commandId: cid("s"), itemId: items[0]!.id, expectedRevision: items[0]!.revision, to: "queued" }));
  });

  suite("the open agenda is ordered over the whole list before it is paged", async (c) => {
    await c.meetings.addAgendaItem(c.scribe, item({ topic: "First, calm" })); now += 1000;
    await c.meetings.addAgendaItem(c.scribe, item({ topic: "Second, calm" })); now += 1000;
    await c.meetings.addAgendaItem(c.scribe, item({ topic: "Third, urgent", urgency: "urgent" }));
    const one = (await c.meetings.openAgenda(c.owner, c.a, { limit: 1 }))!;
    assert.deepEqual(one.items.map((i) => i.topic), ["Third, urgent"]);
    const two = (await c.meetings.openAgenda(c.owner, c.a, { limit: 1, afterId: one.next! }))!;
    assert.deepEqual(two.items.map((i) => i.topic), ["First, calm"]);
    const three = (await c.meetings.openAgenda(c.owner, c.a, { limit: 5, afterId: two.next! }))!;
    assert.deepEqual([three.items.map((i) => i.topic), three.next], [["Second, calm"], undefined]);
  });
}
