import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AgentService } from "../agents/index.js";
import { DecisionService } from "../decisions/index.js";
import { AssignmentService } from "../domain/assignments.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { Availability } from "../conversations/index.js";
import { PauseService } from "../lifecycle/index.js";
import { allows } from "../security/access.js";
import { GrantService, PrincipalService, type Principal } from "../security/index.js";
import { MeetingRecordService, MeetingService, budgetRaiseApplier, grantApplier, taskUpdateApplier, taskReassignApplier, type ChangeApplier, type DecisionRecordBody, type MotionBody, type RecordBody, type SourceCite } from "./index.js";

after(stopServer);

// The only clock anything here reads. Tests move it; nothing sleeps.
let now = Date.parse("2026-10-20T08:00:00.000Z");
const clock = (): string => new Date(now).toISOString();
const minutes = (n: number): void => { now += n * 60_000; };
const options = { clock, pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};

for (const backend of backends) {
  interface Ctx {
    owner: Principal; host: Principal; mgr: Principal; reader: Principal; outsider: Principal; eve: Principal;
    asA: Principal; asB: Principal; asC: Principal; asD: Principal; asE: Principal;
    pA: string; pB: string; pC: string; pD: string; pE: string; project: string;
    meetings: MeetingService; records: MeetingRecordService; decisions: DecisionService; grants: GrantService; principals: PrincipalService; projects: ProjectService;
    other: Map<string, Availability>; shared: Set<string>; calls: { applied: string[]; failOnce: boolean; failLog: boolean; narrate: "ok" | "throw" };
    reopen(extra?: Partial<{ appliers: Record<string, ChangeApplier>; shareable: (c: SourceCite) => Promise<boolean>; widening: (cls: "access-change" | "spend", projectId: string) => Promise<"allow" | "ask"> }>): MeetingRecordService;
    task(title?: string): Promise<{ id: string; revision: number }>;
    grantUpdate(agent: string): Promise<{ id: string; revision: number }>;
    meet(o?: { roster?: string[]; chair?: string; paused?: string[]; item?: "delegated-decision" | "owner-instruction" }): Promise<{ occ: string; rec: string; item?: string }>;
    storage: import("../storage/types.js").ControllerStorage;
  }

  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      now = Date.parse("2026-10-20T08:00:00.000Z");
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const epoch = projects.epoch;
        const principals = PrincipalService.withEpoch(world.storage, epoch, options);
        const agents = AgentService.withEpoch(world.storage, epoch, options);
        const grants = GrantService.withEpoch(world.storage, epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const enroll = async (kind: "agent" | "host", nm: string, g: { action: string; project: string }[]): Promise<Principal> => {
          await principals.enroll(owner, { commandId: cid("e"), kind, name: nm, grants: g });
          return principals.authenticate((await principals.issueCredential(owner, `${kind}:${nm}`)).token);
        };
        const project = (await projects.createProject({ commandId: cid("pa"), actor: owner.id, name: "A" })).id;
        const other2 = (await projects.createProject({ commandId: cid("pb"), actor: owner.id, name: "B" })).id;
        const agentIds: string[] = [];
        for (const nm of ["A", "B", "C", "D", "E"]) agentIds.push((await agents.create(owner, { commandId: cid("ag"), friendlyName: nm })).id);
        const [pA, pB, pC, pD, pE] = agentIds.map((i) => `agent:${i}`) as [string, string, string, string, string];
        const login = async (id: string): Promise<Principal> => principals.authenticate((await principals.issueCredential(owner, id)).token);
        const [asA, asB, asC, asD, asE] = [await login(pA), await login(pB), await login(pC), await login(pD), await login(pE)] as [Principal, Principal, Principal, Principal, Principal];
        const other = new Map<string, Availability>();
        const pauses = PauseService.withEpoch(world.storage, epoch, {}, { ...options, otherAvailability: async (id) => other.get(id) ?? "available" });
        const meetings = MeetingService.withEpoch(world.storage, epoch, {}, { availability: pauses.availability, ...options });
        const decisions = DecisionService.withEpoch(world.storage, epoch, {}, options);
        const shared = new Set<string>();
        const calls = { applied: [] as string[], failOnce: false, failLog: false, narrate: "ok" as "ok" | "throw" };
        // The record service writes through this: with `failLog` set, the next write of a decision log line fails once (a lost log write).
        const flaky = new Proxy(world.storage, { get(target, name, receiver) {
          if (name !== "applyOperation") { const v = Reflect.get(target, name, receiver) as unknown; return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v; }
          return async (input: Parameters<typeof target.applyOperation>[0]) => {
            if (calls.failLog && input.changes.some((x) => x.type === "create" && x.ref.kind === "meeting-decision-log")) { calls.failLog = false; throw new Error("the disk is full"); }
            return target.applyOperation(input);
          };
        } });
        const base = taskUpdateApplier(projects);
        const counting: ChangeApplier = {
          ...base,
          async apply(change) {
            if (calls.failOnce) { calls.failOnce = false; throw new DomainError("unavailable", "storage went away"); }
            calls.applied.push(change.commandId);
            return base.apply(change);
          },
        };
        const authority = async (id: string): Promise<Principal | undefined> => {
          const p = await principals.get(id);
          return p === undefined ? undefined : grants.effective({ id, kind: p.kind, name: p.name, grants: p.grants }, clock());
        };
        const make = (extra: Partial<{ appliers: Record<string, ChangeApplier>; shareable: (c: SourceCite) => Promise<boolean>; widening: (cls: "access-change" | "spend", projectId: string) => Promise<"allow" | "ask"> }> = {}) => MeetingRecordService.withEpoch(flaky, epoch, { meetings, decisions }, {
          ...options, authority, appliers: extra.appliers ?? { "task.update": counting }, shareable: extra.shareable ?? (async (c) => shared.has(`${c.kind}:${c.id}`)), ...(extra.widening === undefined ? {} : { widening: extra.widening }),
          narrate: async ({ summary }) => { if (calls.narrate === "throw") throw new Error("the model is down"); return `A meeting with ${summary.decisions.length} decision(s).`; },
        });
        const records = make();
        const host = await enroll("host", "h1", []);
        const mgr = await enroll("agent", "mgr", [{ action: "meeting.manage", project }]);
        const reader = await enroll("agent", "reader", [{ action: "meeting.read", project }]);
        const outsider = await enroll("agent", "zed", []);
        const eve = await enroll("agent", "eve", [{ action: "meeting.manage", project: other2 }, { action: "meeting.read", project: other2 }]);
        const meet = async (o: { roster?: string[]; chair?: string; paused?: string[]; item?: "delegated-decision" | "owner-instruction" } = {}): Promise<{ occ: string; rec: string; item?: string }> => {
          for (const p of o.paused ?? []) other.set(p, "paused");
          const item = o.item === undefined ? undefined : (await meetings.addAgendaItem(owner, { commandId: cid("it"), projectId: project, topic: "Pick the release train", question: "Which train?", urgency: "urgent", intent: o.item })).id;
          const occ = (await meetings.callUrgent(mgr, { commandId: cid("urg"), projectId: project, title: "Sync", reason: "decide something", roster: o.roster ?? [pA, pB, pC] })).id;
          other.clear();
          const rec = (await records.open(mgr, { commandId: cid("open"), occurrenceId: occ, ...(o.chair === undefined ? {} : { chair: o.chair }) })).id;
          return { occ, rec, ...(item === undefined ? {} : { item }) };
        };
        await body({
          owner, host, mgr, reader, outsider, eve, asA, asB, asC, asD, asE, pA, pB, pC, pD, pE, project, meetings, records, decisions, grants, principals, projects, other, shared, calls, reopen: make, meet, storage: world.storage,
          task: async (title = "Write the guide") => { const t = await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title }); return { id: t.id, revision: t.revision }; },
          grantUpdate: (agent) => grants.grant(owner, { commandId: cid("g"), grantee: agent, action: "task.update", project, source: "direct", basis: "the owner said agents may edit tasks" } as never),
        });
      } finally { await world.close(); }
    });

  const text = "We should move the nightly build to 01:00 because the cache is warm then.";
  const motionOf = async (c: Ctx, rec: string, by: Principal, extra: Record<string, unknown> = {}): Promise<string> =>
    (await c.records.move(by, { commandId: cid("mv"), recordId: rec, text, ...(extra["changes"] !== undefined && extra["topic"] === undefined && extra["agendaItemId"] === undefined ? { topic: "unrelated topic" } : {}), ...extra } as never)).id;
  const open = (c: Ctx, by: Principal, motion: string, extra: Record<string, unknown> = {}) => c.records.openVote(by, { commandId: cid("ov"), motionId: motion, expectedVersion: 1, ...extra });
  const ballot = (c: Ctx, by: Principal, motion: string, value: "yes" | "no" | "abstain", extra: Record<string, unknown> = {}) =>
    c.records.castBallot(by, { commandId: cid("b"), motionId: motion, version: 1, value, reason: `${value} because of the cache`, ...extra } as never);
  const close = (c: Ctx, by: Principal, motion: string) => c.records.closeVote(by, { commandId: cid("cl"), motionId: motion });
  const motionBody = async (c: Ctx, id: string): Promise<MotionBody> => (await c.records.motion(c.owner, id)) as unknown as MotionBody;
  const decisionOf = async (c: Ctx, motion: string): Promise<DecisionRecordBody & { id: string }> => (await c.records.decision(c.owner, (await motionBody(c, motion)).decisionId!)) as never;
  const recordOf = async (c: Ctx, id: string): Promise<RecordBody> => (await c.records.record(c.owner, id)) as unknown as RecordBody;
  const change = (c: Ctx, task: { id: string; revision: number }, agent: string, title = "Write the guide, v2") =>
    ({ kind: "task.update", agent, target: { kind: "task", id: task.id }, expectedRevision: task.revision, patch: { title }, summary: `retitle the task to "${title}"` });
  /** Moves a motion through a clean unanimous vote to adoption. */
  const adopt = async (c: Ctx, rec: string, mover: Principal, extra: Record<string, unknown> = {}): Promise<string> => {
    const m = await motionOf(c, rec, mover, extra);
    await open(c, c.owner, m);
    for (const p of [c.asA, c.asB, c.asC]) await ballot(c, p, m, "yes");
    await close(c, c.owner, m);
    return m;
  };

  suite("the transcript holds typed entries in order, corrections are linked and the original stays; nobody writes as someone else", async (c) => {
    const { rec } = await c.meet({ chair: c.pD });
    const say = (by: Principal, t: string, extra: Record<string, unknown> = {}) => c.records.append(by, { commandId: cid("s"), recordId: rec, kind: "statement", text: t, ...extra } as never);
    const first = await say(c.asA, "The nightly build takes forty minutes.", { tag: "update" });
    assert.equal(first.seq > 0, true);
    const second = await say(c.asB, "Who owns the cache warm-up?", { tag: "question" });
    assert.ok(second.seq > first.seq, "sequence numbers rise");
    const ruling = await c.records.append(c.asD, { commandId: cid("r"), recordId: rec, kind: "ruling", text: "The warm-up question is in order." });
    const message = await c.records.append(c.owner, { commandId: cid("om"), recordId: rec, kind: "owner-message", text: "Keep it short, please." });
    const fix = await c.records.append(c.asA, { commandId: cid("cor"), recordId: rec, kind: "correction", corrects: first.id, text: "The nightly build takes thirty-five minutes." });
    const view = (await c.records.discussion(c.owner, rec))!;
    const kinds = view.entries.map((e) => e.kind);
    assert.deepEqual(kinds, ["statement", "statement", "ruling", "owner-message", "correction"], "entries come back in the order they were appended");
    assert.deepEqual(view.entries.map((e) => e.seq), view.entries.map((_, i) => i + 1));
    const original = view.entries.find((e) => e.id === first.id)!;
    assert.equal(original.text, "The nightly build takes forty minutes.", "the original is never changed");
    assert.equal(original.currentText, "The nightly build takes thirty-five minutes.");
    assert.deepEqual(original.correctedBy, [fix.id], "the correction is a linked update");
    assert.ok(view.entries.some((e) => e.id === ruling.id && e.kind === "ruling") && view.entries.some((e) => e.id === message.id && e.kind === "owner-message"));
    // A repeat of the same command makes no second entry.
    const again = await c.records.append(c.asA, { commandId: "fixed-1", recordId: rec, kind: "statement", text: "Once." });
    const twice = await c.records.append(c.asA, { commandId: "fixed-1", recordId: rec, kind: "statement", text: "Once." });
    assert.deepEqual([twice.id, twice.seq, twice.replayed], [again.id, again.seq, true]);
    // Motions, amendments and votes are made by their own commands; the types are not for forging.
    for (const kind of ["motion", "amendment", "vote", "presence"]) await refuses("invalid_command", () => c.records.append(c.asA, { commandId: cid("f"), recordId: rec, kind, text: "x" } as never));
    // Nobody writes as another agent, owner messages are the owner's, only the chair rules, no actor is accepted.
    await refuses("forbidden", () => say(c.asA, "I am B", { speaker: c.pB }));
    await refuses("forbidden", () => c.records.append(c.asA, { commandId: cid("om"), recordId: rec, kind: "owner-message", text: "The owner says so." }));
    await refuses("forbidden", () => c.records.append(c.asA, { commandId: cid("ru"), recordId: rec, kind: "ruling", text: "Overruled." }));
    await refuses("forbidden", () => c.records.append(c.asB, { commandId: cid("cor"), recordId: rec, kind: "correction", corrects: first.id, text: "B rewrites A" }));
    await refuses("forbidden", () => say(c.asE, "I was not invited"));
    await refuses("invalid_command", () => c.records.append(c.asA, { commandId: cid("a"), recordId: rec, kind: "statement", text: "x", actor: "owner:rob" } as never));
    await refuses("invalid_command", () => say(c.asA, "token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH is here"));
    // The controller may write down a roster agent's turn, and the entry shows both.
    const relayed = await say(c.host, "Relayed from B.", { speaker: c.pB });
    const shown = (await c.records.discussion(c.owner, rec, { fromSeq: relayed.seq, toSeq: relayed.seq }))!.entries[0]!;
    assert.deepEqual([shown.by, shown.speaker], [c.host.id, c.pB]);
    await refuses("forbidden", () => say(c.host, "Relayed from E.", { speaker: c.pE }));
    // Corrections and statements can be fixed by the chair or the owner too, and the tagged items follow.
    await c.records.append(c.asD, { commandId: cid("cor"), recordId: rec, kind: "correction", corrects: second.id, text: "Who owns the cache warm-up job?" });
    assert.equal((await c.records.summary(c.owner, rec))!.content.unresolved.find((u) => u.ref === second.id)!.text, "Who owns the cache warm-up job?");
  });

  suite("the transcript, its motions and the summary are read only by those who may: the owner, readers of the project's meetings, the roster and the chair", async (c) => {
    const { rec } = await c.meet({ chair: c.pD });
    const motion = await motionOf(c, rec, c.asA);
    await c.records.append(c.asA, { commandId: cid("s"), recordId: rec, kind: "statement", text: "Hello." });
    for (const viewer of [c.owner, c.mgr, c.reader, c.asA, c.asC, c.asD]) {
      assert.ok(await c.records.record(viewer, rec), `${viewer.id} reads the record`);
      assert.ok((await c.records.discussion(viewer, rec))!.entries.length >= 2);
      assert.ok(await c.records.motion(viewer, motion));
      assert.ok(await c.records.summary(viewer, rec));
    }
    for (const viewer of [c.outsider, c.eve, c.asE]) {
      assert.equal(await c.records.record(viewer, rec), undefined, `${viewer.id} reads like a missing record`);
      assert.equal(await c.records.discussion(viewer, rec), undefined);
      assert.equal(await c.records.motion(viewer, motion), undefined);
      assert.equal(await c.records.summary(viewer, rec), undefined);
      assert.equal(await c.records.ballots(viewer, motion), undefined);
    }
    // Opening, writing as another and settling are not for readers.
    await refuses("forbidden", () => c.records.finish(c.reader, { commandId: cid("fin"), recordId: rec }));
    await refuses("forbidden", () => c.records.summarize(c.mgr, { commandId: cid("sum"), recordId: rec }));
    const planned = (await c.meetings.planned(c.mgr, c.project))!.items[0]!.id;
    await refuses("forbidden", () => c.records.open(c.eve, { commandId: cid("o"), occurrenceId: planned }));
    await refuses("invalid_command", () => c.records.open(c.mgr, { commandId: cid("o"), occurrenceId: planned }), (e) => assert.match(e.message, /already has a record/));
    // A task credential of another task cannot read it.
    assert.equal(await c.records.record({ ...c.reader, taskScope: { taskId: "task-aaaaaaaaaaaaaaaaaaaa", projectId: "proj-aaaaaaaaaaaaaaaaaaaa" } }, rec), undefined);
  });

  suite("a vote: ballots carry reasons, stay hidden while it is open and are revealed together when it closes; a repeat does not vote twice", async (c) => {
    const { rec } = await c.meet({ chair: c.pD, roster: [c.pA, c.pB, c.pC, c.pE] });
    const m = await motionOf(c, rec, c.asA);
    await refuses("invalid_command", () => ballot(c, c.asA, m, "yes"), (e) => assert.match(e.message, /not open for ballots/));
    await open(c, c.asD, m);
    await refuses("invalid_command", () => open(c, c.asD, m), (e) => assert.match(e.message, /proposed|voting/));
    await ballot(c, c.asA, m, "yes");
    await refuses("invalid_command", () => c.records.castBallot(c.asB, { commandId: cid("b"), motionId: m, version: 1, value: "no", reason: "" } as never));
    const b = await c.records.castBallot(c.asB, { commandId: "b-once", motionId: m, version: 1, value: "no", reason: "The cache is not warm at 01:00 on weekends." });
    assert.equal(b.revised, false);
    await c.records.castBallot(c.asB, { commandId: "b-once", motionId: m, version: 1, value: "no", reason: "The cache is not warm at 01:00 on weekends." });
    // Hidden while open.
    assert.deepEqual(await c.records.ballots(c.reader, m), { hidden: true });
    assert.deepEqual(await c.records.ballots(c.asC, m), { hidden: true }, "a voter who has not voted sees none");
    const own = (await c.records.ballots(c.asB, m)) as { hidden: false; ballots: { voter: string }[] };
    assert.deepEqual(own.ballots.map((x) => x.voter), [c.pB], "a voter sees its own");
    assert.deepEqual(await c.records.ballots(c.owner, m), { hidden: true }, "individual ballots are hidden from everyone, the owner included, while the vote is open");
    const transcript = JSON.stringify((await c.records.discussion(c.owner, rec))!.entries);
    assert.ok(!transcript.includes("The cache is not warm"), "no ballot reason is in the transcript while the vote is open");
    await refuses("invalid_command", () => close(c, c.asD, m), (e) => assert.match(e.message, /not voted/));
    await c.records.castBallot(c.asC, { commandId: cid("b"), motionId: m, version: 1, value: "abstain", reason: "I have no data either way." });
    await ballot(c, c.asE, m, "yes");
    const closed = await close(c, c.asD, m);
    assert.equal(closed.state, "adopted");
    const d = await decisionOf(c, m);
    assert.deepEqual([d.outcome, d.tally!.yes, d.tally!.no, d.tally!.abstain, d.tally!.quorum, d.tally!.cast], ["adopted", 2, 1, 1, 3, 4]);
    assert.equal(d.table.length, 4);
    assert.ok(d.table.every((r) => r.reason.length > 0), "every ballot including the abstention has a reason");
    // The table is revealed in the transcript together with the tally.
    const after = (await c.records.discussion(c.owner, rec))!.entries.filter((e) => e.kind === "vote");
    assert.match(JSON.stringify(after.at(-1)!.data), /The cache is not warm/);
    const revealed = (await c.records.ballots(c.reader, m)) as { hidden: false; ballots: unknown[] };
    assert.equal(revealed.hidden, false);
    assert.equal(revealed.ballots.length, 4);
    // A repeat of the closing command (by another command ID) finds no open vote.
    await refuses("invalid_command", () => close(c, c.asD, m), (e) => assert.match(e.message, /no open vote/));
  });

  suite("the roster is fixed: a stranger, a new agent, a second session and an absent member add no voice; the owner is not needed for quorum; absence is never approval", async (c) => {
    const { rec } = await c.meet({ paused: [c.pC] });
    const r = await recordOf(c, rec);
    assert.deepEqual(r.withheld, [c.pC], "the paused member is absent, not abstaining");
    const m = await motionOf(c, rec, c.asA);
    await open(c, c.owner, m);
    await refuses("forbidden", () => ballot(c, c.asE, m, "yes"));
    await refuses("forbidden", () => ballot(c, c.asC, m, "yes"));
    await refuses("forbidden", () => ballot(c, c.owner, m, "yes"));
    await refuses("forbidden", () => ballot(c, c.host, m, "yes"));
    await refuses("forbidden", () => ballot(c, c.mgr, m, "yes"));
    await ballot(c, c.asA, m, "yes");
    // A second session of the same agent is the same voter: it cannot vote twice.
    const session2 = await c.principals.authenticate((await c.principals.issueCredential(c.owner, c.pA)).token);
    await refuses("invalid_command", () => ballot(c, session2, m, "yes"), (e) => assert.match(e.message, /already voted/));
    // Two of three on the roster is a quorum (majority), and the absent member did not approve: 2 of 3 cast.
    await ballot(c, c.asB, m, "yes");
    const done = await close(c, c.owner, m);
    assert.equal(done.state, "adopted");
    const d = await decisionOf(c, m);
    assert.deepEqual([d.tally!.roster, d.tally!.eligible, d.tally!.quorum, d.tally!.cast, d.tally!.absent], [3, 2, 2, 2, [c.pC]]);
    // A later edit of the schedule or a newly created agent changes nothing about this meeting.
    assert.deepEqual([...(await recordOf(c, rec)).roster].sort(), [c.pA, c.pB, c.pC].sort());
  });

  suite("without a quorum only discussion goes on and the binding vote is deferred; the owner's presence does not make one", async (c) => {
    const { rec } = await c.meet({ paused: [c.pB, c.pC] });
    await c.records.ownerJoin(c.owner, { commandId: cid("oj"), recordId: rec });
    const m = await motionOf(c, rec, c.asA);
    await refuses("invalid_command", () => open(c, c.owner, m), (e) => assert.match(e.message, /binding vote is deferred/));
    await c.records.append(c.asA, { commandId: cid("s"), recordId: rec, kind: "statement", text: "Reporting anyway.", tag: "update" });
    await c.records.table(c.owner, { commandId: cid("t"), motionId: m, reason: "no quorum today" });
    assert.equal((await motionBody(c, m)).state, "tabled");
    const s = (await c.records.summary(c.owner, rec))!.content;
    assert.equal(s.keyUpdates.length, 1, "reports proceed");
    assert.ok(s.unresolved.some((u) => u.kind === "motion" && /tabled/.test(u.text)));
    assert.deepEqual(s.attendance.absent.map((a) => a.id).sort(), [c.pB, c.pC].sort());
    // Too few ballots at the time limit: no quorum, nothing is decided, and nothing is applied.
    const second = await c.meet({ roster: [c.pA, c.pB, c.pC, c.pD, c.pE] });
    const m2 = await motionOf(c, second.rec, c.asA);
    await open(c, c.owner, m2);
    await ballot(c, c.asA, m2, "yes");
    await ballot(c, c.asB, m2, "yes");
    minutes(11);
    const closed = await close(c, c.owner, m2);
    assert.equal(closed.state, "no-quorum");
    assert.equal((await decisionOf(c, m2)).outcome, "no-quorum");
    assert.equal((await decisionOf(c, m2)).changes.length, 0);
  });

  suite("a revision is allowed only because of an owner message that came after the ballot, once per message, and a held vote takes no ballot", async (c) => {
    const { rec } = await c.meet({ chair: c.pD });
    const m = await motionOf(c, rec, c.asA);
    await open(c, c.asD, m);
    await ballot(c, c.asA, m, "yes");
    await refuses("invalid_command", () => ballot(c, c.asA, m, "no"), (e) => assert.match(e.message, /already voted/));
    const early = await c.records.append(c.owner, { commandId: cid("om"), recordId: rec, kind: "owner-message", text: "Think about weekends." });
    await ballot(c, c.asB, m, "yes");
    const late = await c.records.append(c.owner, { commandId: cid("om"), recordId: rec, kind: "owner-message", text: "Also think about cost." });
    // B voted after the first message, so only the second can trigger a revision for B.
    await refuses("invalid_command", () => ballot(c, c.asB, m, "no", { ownerMessageEntryId: early.id }), (e) => assert.match(e.message, /before your ballot/));
    const plainStatement = await c.records.append(c.asB, { commandId: cid("s"), recordId: rec, kind: "statement", text: "Not an owner message." });
    await refuses("invalid_command", () => ballot(c, c.asB, m, "no", { ownerMessageEntryId: plainStatement.id }), (e) => assert.match(e.message, /not an owner message/));
    // A held vote takes no ballot, new or revised, and its clock stops.
    await c.records.hold(c.owner, { commandId: cid("h"), motionId: m });
    const closesBefore = (await motionBody(c, m)).closesAt!;
    await refuses("invalid_command", () => ballot(c, c.asC, m, "yes"), (e) => assert.match(e.message, /held/));
    await refuses("invalid_command", () => ballot(c, c.asA, m, "no", { ownerMessageEntryId: late.id }), (e) => assert.match(e.message, /held/));
    minutes(30);
    await c.records.resume(c.owner, { commandId: cid("rs"), motionId: m });
    assert.equal(new Date(Date.parse(closesBefore) + 30 * 60_000).toISOString(), (await motionBody(c, m)).closesAt, "the held time is given back");
    const revised = await ballot(c, c.asA, m, "no", { ownerMessageEntryId: late.id });
    assert.equal(revised.revised, true);
    await refuses("invalid_command", () => ballot(c, c.asA, m, "yes", { ownerMessageEntryId: late.id }), (e) => assert.match(e.message, /already revised/));
    await ballot(c, c.asC, m, "yes");
    await close(c, c.asD, m);
    const d = await decisionOf(c, m);
    assert.equal(d.table.find((r) => r.voter === c.pA)!.value, "no", "the last ballot counts");
    assert.equal(d.table.find((r) => r.voter === c.pA)!.revisions, 2);
    const ballots = (await c.records.ballots(c.reader, m)) as unknown as { ballots: { voter: string; history: { value: string; trigger: string }[] }[] };
    const history = ballots.ballots.find((b) => b.voter === c.pA)!.history;
    assert.deepEqual(history.map((h) => [h.value, h.trigger]), [["yes", "initial"], ["no", `owner-message:${late.id}`]], "the original and the revision are both shown, with the trigger");
  });

  suite("a material amendment makes a new version and needs a fresh vote; ballots on the old version do not count; voting cannot be steered by a quiet rewrite", async (c) => {
    const { rec } = await c.meet({ chair: c.pD });
    const m = await motionOf(c, rec, c.asA);
    await refuses("forbidden", () => c.records.amend(c.asB, { commandId: cid("am"), motionId: m, expectedVersion: 1, text: "x", material: true }));
    await c.records.amend(c.asD, { commandId: cid("am"), motionId: m, expectedVersion: 1, text: `${text} Trial only.`, material: false });
    assert.equal((await motionBody(c, m)).version, 1, "a wording change before voting keeps the version");
    await open(c, c.asD, m);
    await ballot(c, c.asA, m, "yes");
    await refuses("invalid_command", () => c.records.amend(c.asD, { commandId: cid("am"), motionId: m, expectedVersion: 1, text: "quiet", material: false }), (e) => assert.match(e.message, /material/));
    const done = await c.records.amend(c.asD, { commandId: cid("am"), motionId: m, expectedVersion: 1, text: "Move the nightly build to 01:00 on weekdays only.", material: true });
    assert.equal(done.version, 2);
    const moved = await motionBody(c, m);
    assert.deepEqual([moved.state, moved.version], ["proposed", 2]);
    await refuses("invalid_command", () => ballot(c, c.asB, m, "yes", { version: 2 }), (e) => assert.match(e.message, /not open/));
    await c.records.openVote(c.asD, { commandId: cid("ov"), motionId: m, expectedVersion: 2 });
    await refuses("stale_revision", () => ballot(c, c.asB, m, "yes"), (e) => assert.match(e.message, /bound to one version/));
    // A's old ballot is for version 1: it does not count until A votes again on version 2.
    await c.records.castBallot(c.asB, { commandId: cid("b"), motionId: m, version: 2, value: "yes", reason: "weekdays are fine" });
    await c.records.castBallot(c.asC, { commandId: cid("b"), motionId: m, version: 2, value: "yes", reason: "agreed" });
    await refuses("invalid_command", () => close(c, c.asD, m), (e) => assert.match(e.message, /not voted/));
    await c.records.castBallot(c.asA, { commandId: cid("b"), motionId: m, version: 2, value: "no", reason: "now I disagree" });
    await close(c, c.asD, m);
    const d = await decisionOf(c, m);
    assert.deepEqual([d.version, d.tally!.yes, d.tally!.no], [2, 2, 1]);
    assert.equal(d.table.find((r) => r.voter === c.pA)!.value, "no");
    assert.equal(d.table.find((r) => r.voter === c.pA)!.revisions, 1, "the version-1 ballot is not a revision of version 2");
    // The record shows the version history and the amendments in the discussion.
    const motion = await motionBody(c, m);
    assert.deepEqual(motion.versions.map((v) => v.version), [1, 2]);
    assert.ok(d.discussion.entryIds.length >= 4);
  });

  suite("a tie is broken by the chair without a double vote: a chair on the roster by its one ballot, a chair off the roster or who abstained by a single recorded casting vote, and a tie fails when no chair can cast it", async (c) => {
    // (1) Member-chair: A is chair and voted yes; B voted no; C abstained. The one ballot decides.
    const one = await c.meet({ chair: c.pA });
    const m1 = await motionOf(c, one.rec, c.asB);
    await open(c, c.owner, m1);
    await ballot(c, c.asA, m1, "yes");
    await ballot(c, c.asB, m1, "no");
    await ballot(c, c.asC, m1, "abstain");
    const r1 = await close(c, c.asA, m1);
    assert.equal(r1.state, "adopted");
    const d1 = await decisionOf(c, m1);
    assert.deepEqual([d1.tally!.yes, d1.tally!.no, d1.tie!.how, d1.tie!.value], [1, 1, "chair-ballot", "yes"], "counted once: the tally still shows one yes");
    await refuses("invalid_command", () => c.records.castingVote(c.asA, { commandId: cid("cv"), motionId: m1, value: "no", reason: "again" }), (e) => assert.match(e.message, /not waiting/));
    // (2) Chair off the roster: a single casting vote, only on a tie, recorded as such.
    const two = await c.meet({ chair: c.pD });
    const m2 = await motionOf(c, two.rec, c.asB);
    await open(c, c.owner, m2);
    await refuses("invalid_command", () => c.records.castingVote(c.asD, { commandId: cid("cv"), motionId: m2, value: "yes", reason: "early" }), (e) => assert.match(e.message, /not waiting/));
    await ballot(c, c.asA, m2, "yes");
    await ballot(c, c.asB, m2, "no");
    await ballot(c, c.asC, m2, "abstain");
    const r2 = await close(c, c.owner, m2);
    assert.equal(r2.state, "tie-pending");
    assert.ok(!JSON.stringify((await c.records.discussion(c.reader, two.rec))!.entries).includes("because of the cache"), "the ballots are still not revealed");
    await refuses("forbidden", () => c.records.castingVote(c.asB, { commandId: cid("cv"), motionId: m2, value: "yes", reason: "I am a voter" }));
    await refuses("forbidden", () => c.records.castingVote(c.owner, { commandId: cid("cv"), motionId: m2, value: "yes", reason: "I am the owner" }));
    const cast = await c.records.castingVote(c.asD, { commandId: cid("cv"), motionId: m2, value: "no", reason: "The risk is not worth it." });
    assert.equal(cast.state, "rejected");
    const d2 = await decisionOf(c, m2);
    assert.deepEqual([d2.tie!.how, d2.tie!.chair, d2.tie!.value, d2.tally!.yes, d2.tally!.no], ["casting-vote", c.pD, "no", 1, 1], "the casting vote is not in the tally: it shows in the tie record");
    const shown = (await c.records.discussion(c.owner, two.rec))!.entries.filter((e) => e.kind === "vote").at(-1)!;
    assert.match(shown.text, /casting vote/);
    await refuses("invalid_command", () => c.records.castingVote(c.asD, { commandId: cid("cv"), motionId: m2, value: "yes", reason: "twice" }), (e) => assert.match(e.message, /not waiting/));
    // (3) A chair on the roster who abstained casts the casting vote.
    const three = await c.meet({ chair: c.pC });
    const m3 = await motionOf(c, three.rec, c.asB);
    await open(c, c.owner, m3);
    await ballot(c, c.asA, m3, "yes");
    await ballot(c, c.asB, m3, "no");
    await ballot(c, c.asC, m3, "abstain");
    assert.equal((await close(c, c.owner, m3)).state, "tie-pending");
    assert.equal((await c.records.castingVote(c.asC, { commandId: cid("cv"), motionId: m3, value: "yes", reason: "Cheaper." })).state, "adopted");
    // (4) No chair: the tie fails. No casting vote is asked for when there is no tie.
    const four = await c.meet();
    const m4 = await motionOf(c, four.rec, c.asB);
    await open(c, c.owner, m4);
    await ballot(c, c.asA, m4, "yes");
    await ballot(c, c.asB, m4, "no");
    await ballot(c, c.asC, m4, "abstain");
    assert.equal((await close(c, c.owner, m4)).state, "failed");
    assert.equal((await decisionOf(c, m4)).tie!.how, "none");
    const five = await c.meet({ chair: c.pD });
    const m5 = await adopt(c, five.rec, c.asA);
    assert.equal((await decisionOf(c, m5)).tie, undefined);
    await refuses("invalid_command", () => c.records.castingVote(c.asD, { commandId: cid("cv"), motionId: m5, value: "yes", reason: "no tie" }), (e) => assert.match(e.message, /not waiting/));
  });

  suite("a chair named or changed after the vote opened gets neither its ballot nor a casting vote: the tie fails", async (c) => {
    const tie = async (chair: string | undefined) => {
      const { rec } = await c.meet(chair === undefined ? {} : { chair });
      const m = await motionOf(c, rec, c.asB);
      await open(c, c.owner, m);
      await ballot(c, c.asA, m, "yes");
      await ballot(c, c.asB, m, "no");
      await ballot(c, c.asC, m, "abstain");
      return { rec, m };
    };
    // A chaired, voted yes; the owner makes B chair before the close: B's no-ballot must not decide it either.
    const one = await tie(c.pA);
    await c.records.setChair(c.owner, { commandId: cid("ch"), recordId: one.rec, chair: c.pB });
    assert.equal((await close(c, c.owner, one.m)).state, "failed");
    assert.equal((await decisionOf(c, one.m)).tie!.how, "none");
    // Unchanged chair: A's own ballot still decides.
    const two = await tie(c.pA);
    assert.equal((await close(c, c.owner, two.m)).state, "adopted");
    // No chair when the vote opened, one named after the ballots: the tie fails.
    const three = await tie(undefined);
    await c.records.setChair(c.owner, { commandId: cid("ch"), recordId: three.rec, chair: c.pA });
    assert.equal((await close(c, c.owner, three.m)).state, "failed");
  });

  suite("ballots are shown only once a tally was concluded: not when a vote is voided, a motion is tabled after an amendment, or while it is open", async (c) => {
    const a = await c.meet({ chair: c.pD });
    const m1 = await motionOf(c, a.rec, c.asA);
    await open(c, c.owner, m1);
    await ballot(c, c.asA, m1, "no");
    await c.records.finish(c.host, { commandId: cid("fin"), recordId: a.rec });
    assert.equal((await motionBody(c, m1)).state, "void");
    for (const viewer of [c.reader, c.owner, c.mgr, c.asB]) assert.deepEqual(await c.records.ballots(viewer, m1), { hidden: true });
    assert.equal(JSON.stringify(await c.records.summary(c.reader, a.rec)).includes("no because of the cache"), false);
    // The voter still sees its own.
    assert.equal(((await c.records.ballots(c.asA, m1)) as { ballots: unknown[] }).ballots.length, 1);
    const b = await c.meet({ chair: c.pD });
    const m2 = await motionOf(c, b.rec, c.asA);
    await open(c, c.owner, m2);
    await ballot(c, c.asA, m2, "yes");
    await c.records.amend(c.asD, { commandId: cid("am"), motionId: m2, expectedVersion: 1, text: "Narrower motion.", material: true });
    await c.records.table(c.asD, { commandId: cid("t"), motionId: m2, reason: "later" });
    assert.deepEqual(await c.records.ballots(c.reader, m2), { hidden: true });
    assert.deepEqual(await c.records.ballots(c.owner, m2), { hidden: true });
    // After a concluded tally everyone who reads the meeting sees them.
    const d = await c.meet({ chair: c.pD });
    const m3 = await adopt(c, d.rec, c.asA);
    assert.equal((await c.records.ballots(c.reader, m3) as { hidden: false }).hidden, false);
  });

  suite("a motion cannot dodge an owner decision by leaving its topic out: the agenda item's topic counts, and a motion with changes must name one", async (c) => {
    const task = await c.task();
    await c.grantUpdate(c.pA);
    await c.decisions.record(c.owner, { commandId: cid("dec"), projectId: c.project, category: "decision", topic: "Pick the release train", statement: "Use the monthly train.", wording: "Use the monthly train.", source: { channel: "direct" }, basedOn: 0 });
    const { rec, item } = await c.meet({ chair: c.pD, item: "delegated-decision" });
    const m = await adopt(c, rec, c.asA, { agendaItemId: item, changes: [change(c, task, c.pA)] });
    const d = await decisionOf(c, m);
    assert.equal(d.scope, "recommendation");
    assert.match(d.scopeReason!, /the owner has decided "pick the release train"/);
    await refuses("invalid_command", () => c.records.move(c.asA, { commandId: cid("mv"), recordId: rec, text, changes: [change(c, task, c.pA)] } as never), (e) => assert.match(e.message, /names the owner-decision topic/));
  });

  suite("a ruling or an owner message is never written down for someone else, and an owner who arrives before a decision is applied holds it", async (c) => {
    const { rec, item } = await c.meet({ chair: c.pD, item: "delegated-decision" });
    await refuses("invalid_command", () => c.records.append(c.owner, { commandId: cid("r"), recordId: rec, kind: "ruling", text: "Overruled.", speaker: c.pD } as never));
    await refuses("invalid_command", () => c.records.append(c.owner, { commandId: cid("om"), recordId: rec, kind: "owner-message", text: "Hi.", speaker: c.pA } as never));
    const task = await c.task();
    await c.grantUpdate(c.pA);
    const m = await adopt(c, rec, c.asB, { agendaItemId: item, changes: [change(c, task, c.pA)] });
    const before = await decisionOf(c, m);
    assert.equal(before.ownerResponse, "not-asked");
    await c.records.ownerJoin(c.owner, { commandId: cid("oj"), recordId: rec });
    assert.equal((await decisionOf(c, m)).ownerResponse, "pending");
    assert.deepEqual(await c.records.apply(c.host, { decisionId: before.id }), { applied: 0, notApplied: 0, pending: 1, waitingFor: "owner" });
    assert.equal((await c.records.ownerRespond(c.owner, { commandId: cid("or"), decisionId: before.id, response: "agree" })).applied, 1);
  });

  suite("a tie fails when the chair changed during the vote, is absent, or gives no answer in time; the lease closes votes and records nobody finished", async (c) => {
    // The chair changed during the vote.
    const a = await c.meet({ chair: c.pD });
    const m1 = await motionOf(c, a.rec, c.asA);
    await open(c, c.owner, m1);
    await ballot(c, c.asA, m1, "yes");
    await ballot(c, c.asB, m1, "no");
    await ballot(c, c.asC, m1, "abstain");
    await c.records.setChair(c.owner, { commandId: cid("ch"), recordId: a.rec, chair: c.pE });
    assert.equal((await close(c, c.owner, m1)).state, "failed", "the chair the vote opened under is gone");
    // The chair gives no answer within the limit; the sweep fails the tie.
    const b = await c.meet({ chair: c.pD });
    const m2 = await motionOf(c, b.rec, c.asA);
    await open(c, c.owner, m2);
    await ballot(c, c.asA, m2, "yes");
    await ballot(c, c.asB, m2, "no");
    await ballot(c, c.asC, m2, "abstain");
    assert.equal((await close(c, c.owner, m2)).state, "tie-pending");
    await refuses("invalid_command", () => close(c, c.owner, m2), (e) => assert.match(e.message, /waits for the chair/));
    minutes(11);
    await refuses("invalid_command", () => c.records.castingVote(c.asD, { commandId: cid("cv"), motionId: m2, value: "yes", reason: "late" }), (e) => assert.match(e.message, /over/));
    await refuses("forbidden", () => c.records.sweep(c.reader, { projectId: c.project }));
    const swept = await c.records.sweep(c.host, { projectId: c.project });
    assert.ok(swept.failedTies.includes(m2));
    // A vote that runs out of time and comes to a tie is reported as waiting for the casting vote, not as closed.
    const m2b = await motionOf(c, b.rec, c.asA);
    await open(c, c.owner, m2b);
    await ballot(c, c.asA, m2b, "yes");
    await ballot(c, c.asB, m2b, "no");
    minutes(11);
    const waiting = await c.records.sweep(c.host, { projectId: c.project });
    assert.deepEqual([waiting.tied.includes(m2b), waiting.closed.includes(m2b)], [true, false]);
    assert.equal((await motionBody(c, m2b)).state, "tie-pending");
    minutes(11);
    assert.ok((await c.records.sweep(c.host, { projectId: c.project })).failedTies.includes(m2b));
    assert.equal((await motionBody(c, m2)).state, "failed");
    // A vote that runs out of time is closed by the sweep on what was cast; running it again does nothing more.
    const m3 = await motionOf(c, b.rec, c.asA);
    await open(c, c.owner, m3);
    await ballot(c, c.asA, m3, "yes");
    await ballot(c, c.asB, m3, "yes");
    minutes(11);
    const first = await c.records.sweep(c.host, { projectId: c.project });
    assert.ok(first.closed.includes(m3));
    assert.equal((await motionBody(c, m3)).state, "adopted");
    assert.deepEqual((await c.records.sweep(c.host, { projectId: c.project })).closed, []);
    // A record nobody finished is ended by the lease two hours after the meeting's time, and its open motion is void.
    const m4 = await motionOf(c, b.rec, c.asA);
    minutes(130);
    const lease = await c.records.sweep(c.host, { projectId: c.project });
    assert.ok(lease.interrupted.includes(b.rec) && lease.interrupted.includes(a.rec));
    assert.equal((await recordOf(c, b.rec)).state, "interrupted");
    assert.equal((await motionBody(c, m4)).state, "void");
  });

  suite("ending a meeting during an open vote voids it as not concluded; the transcript and summary stay durable and readable, also when the summarizer fails and across a restart", async (c) => {
    const { rec } = await c.meet({ chair: c.pD });
    const done = await adopt(c, rec, c.asA);
    await c.records.append(c.asA, { commandId: cid("s"), recordId: rec, kind: "statement", text: "Build time is now 35 minutes.", tag: "update" });
    const open2 = await motionOf(c, rec, c.asB);
    await open(c, c.owner, open2);
    await ballot(c, c.asA, open2, "yes");
    c.calls.narrate = "throw";
    const fin = await c.records.finish(c.host, { commandId: cid("fin"), recordId: rec, interrupted: true, reason: "the host is shutting down" });
    assert.deepEqual(fin.voided, [open2]);
    assert.equal((await motionBody(c, open2)).state, "void");
    assert.equal((await recordOf(c, rec)).state, "interrupted");
    await refuses("invalid_command", () => ballot(c, c.asB, open2, "yes"), (e) => assert.match(e.message, /interrupted|not open/));
    await refuses("invalid_command", () => c.records.append(c.asA, { commandId: cid("s"), recordId: rec, kind: "statement", text: "More." }), (e) => assert.match(e.message, /interrupted/));
    const out = await c.records.summarize(c.host, { commandId: cid("sum"), recordId: rec });
    assert.match(out.overviewFailed ?? "", /summarizer failed/);
    const restarted = c.reopen();
    const s = (await restarted.summary(c.reader, rec))!;
    assert.equal(s.content.partial, true);
    assert.match(s.overviewFailed ?? "", /the model is down/);
    assert.equal(s.overview, undefined);
    assert.equal(s.content.decisions.length, 1, "the summary is complete without the summarizer");
    assert.equal(s.content.keyUpdates.length, 1);
    assert.ok(s.content.unresolved.some((u) => u.kind === "motion" && /vote is void and not concluded/.test(u.text)), "the open vote is reported as not concluded");
    assert.equal(s.snapshot!.current, true);
    assert.ok((await restarted.discussion(c.reader, rec))!.entries.length >= 7, "the transcript is whole");
    assert.equal(await restarted.summary(c.outsider, rec), undefined, "and still access-controlled");
    assert.ok(done);
    // A working summarizer adds an overview on the next build; the earlier failure is cleared.
    c.calls.narrate = "ok";
    const again = await c.records.summarize(c.host, { commandId: cid("sum"), recordId: rec });
    assert.equal(again.builds, 2);
    assert.match((await c.records.summary(c.reader, rec))!.overview ?? "", /1 decision/);
  });

  suite("a decision records the table of reasons, dissent, a link to the discussion and answers why from the record alone", async (c) => {
    const { rec } = await c.meet({ chair: c.pD });
    const m = await motionOf(c, rec, c.asA);
    await c.records.append(c.asB, { commandId: cid("s"), recordId: rec, kind: "statement", text: "A cold cache at 01:00 on Sundays worries me." });
    await c.records.amend(c.asD, { commandId: cid("am"), motionId: m, expectedVersion: 1, text: `${text} Weekdays only.`, material: true });
    await c.records.append(c.asD, { commandId: cid("r"), recordId: rec, kind: "ruling", motionId: m, text: "The objection about Sundays is upheld and the motion is narrowed." });
    await c.records.openVote(c.asD, { commandId: cid("ov"), motionId: m, expectedVersion: 2 });
    const vote = (by: Principal, value: "yes" | "no" | "abstain", reason: string) => c.records.castBallot(by, { commandId: cid("b"), motionId: m, version: 2, value, reason });
    await vote(c.asA, "yes", "The cache is warm on weekdays.");
    await vote(c.asB, "no", "I still do not trust the warm-up job.");
    await vote(c.asC, "yes", "Faster mornings.");
    await close(c, c.asD, m);
    const d = await decisionOf(c, m);
    assert.equal(d.outcome, "adopted");
    assert.deepEqual(d.dissent, [{ voter: c.pB, value: "no", reason: "I still do not trust the warm-up job." }]);
    assert.deepEqual(d.abstained, []);
    const link = d.discussion;
    const entries = (await c.records.discussion(c.reader, rec, { fromSeq: link.fromSeq, toSeq: link.toSeq }))!.entries;
    assert.equal(entries[0]!.kind, "motion", "the discussion link starts at the motion");
    assert.equal(entries.at(-1)!.kind, "vote", "and ends at the vote");
    assert.ok(link.entryIds.every((id) => entries.some((e) => e.id === id)), "every entry the decision names lies inside the linked range");
    const why = (await c.records.why(c.reader, d.id))!;
    const joined = why.lines.map((l) => l.text).join("\n");
    assert.match(joined, /motion by agent:.*Motion 1/s);
    assert.match(joined, /amendment by .*Material amendment.*version 2/s);
    assert.match(joined, /ruling by .*upheld/);
    assert.match(joined, new RegExp(`${c.pB} voted no: I still do not trust`));
    assert.match(joined, /Result: adopted\. Yes 2, no 1/);
    assert.ok(why.lines.filter((l) => l.entryId !== undefined).every((l) => l.seq !== undefined));
    assert.equal(await c.records.why(c.outsider, d.id), undefined);
  });

  suite("a conclusion that rests on a private record is marked unverifiable for readers who cannot be shown it, and asking for the rationale grants nothing", async (c) => {
    const { rec } = await c.meet({ chair: c.pD });
    const desk: SourceCite = { kind: "desk-record", id: "dsk-private-notes", revision: 3 };
    const wiki: SourceCite = { kind: "artifact", id: "art-shared-benchmark" };
    c.shared.add(`${wiki.kind}:${wiki.id}`);
    await c.records.append(c.asA, { commandId: cid("s"), recordId: rec, kind: "statement", text: "My notes show the warm-up fails on Sundays.", tag: "update", sources: [desk] });
    await c.records.append(c.asB, { commandId: cid("s"), recordId: rec, kind: "statement", text: "The benchmark shows 35 minutes.", tag: "update", sources: [wiki] });
    const m = await motionOf(c, rec, c.asA);
    await open(c, c.owner, m);
    await ballot(c, c.asA, m, "yes", { reason: "Based on my private notes.", sources: [desk] });
    await ballot(c, c.asB, m, "yes");
    await ballot(c, c.asC, m, "yes");
    await close(c, c.owner, m);
    const grantsBefore = JSON.stringify((await c.principals.get(c.reader.id))!.grants) + JSON.stringify((await c.principals.get(c.asB.id))!.grants);
    const read = (await c.records.summary(c.reader, rec))!;
    const [a, b] = read.content.keyUpdates;
    assert.deepEqual([a!.verifiable, b!.verifiable], [false, true]);
    assert.equal(a!.text, "My notes show the warm-up fails on Sundays.", "the claim is shown as a claim");
    assert.equal(read.content.decisions[0]!.verifiable, false);
    assert.equal(read.content.decisions[0]!.reasons.find((r) => r.voter === c.pA)!.verifiable, false);
    assert.equal(read.content.unverifiableCount, 2);
    assert.equal(read.privateSources, undefined, "readers are not told which records");
    const shownEntry = (await c.records.discussion(c.reader, rec))!.entries.find((e) => e.text.startsWith("My notes"))!;
    assert.deepEqual([shownEntry.verifiable, shownEntry.sources], [false, undefined], "no citation of a private record reaches a reader");
    const why = (await c.records.why(c.reader, (await decisionOf(c, m)).id))!;
    assert.ok(why.lines.some((l) => !l.verifiable && /Based on my private notes/.test(l.text)));
    assert.equal(JSON.stringify(why).includes("dsk-private-notes"), false);
    // Asking for the rationale grants no access: grants are as they were and the source is still not readable.
    assert.equal(JSON.stringify((await c.principals.get(c.reader.id))!.grants) + JSON.stringify((await c.principals.get(c.asB.id))!.grants), grantsBefore);
    // The owner sees which records.
    const owner = (await c.records.summary(c.owner, rec))!;
    assert.equal(owner.privateSources!.some((p) => p.cites.some((x) => x.id === "dsk-private-notes")), true);
    assert.equal(owner.content.keyUpdates[0]!.verifiable, false, "the published content is the same for everyone");
    // When the source can be shared the same conclusion is verifiable.
    c.shared.add(`${desk.kind}:${desk.id}`);
    assert.equal((await c.records.summary(c.reader, rec))!.content.unverifiableCount, 0);
  });

  suite("new decisions respect effective authority: an adopted motion whose carriers hold nothing, whose topic the owner has decided, or whose agenda item asked only for discussion is a recommendation", async (c) => {
    const task = await c.task();
    // (1) Nobody holds task.update: the vote grants nothing, so it stays a recommendation and nothing is applied.
    const one = await c.meet({ chair: c.pD });
    const m1 = await adopt(c, one.rec, c.asA, { changes: [change(c, task, c.pA)] });
    const d1 = await decisionOf(c, m1);
    assert.deepEqual([d1.outcome, d1.scope], ["adopted", "recommendation"]);
    assert.match(d1.scopeReason!, /vote grants none/);
    assert.deepEqual(d1.changes.map((x) => [x.state, x.code]), [["not-applied", "recommendation"]]);
    assert.deepEqual(await c.records.apply(c.host, { decisionId: d1.id }), { applied: 0, notApplied: 1, pending: 0 });
    assert.equal((await c.projects.getTask(task.id))!.title, "Write the guide");
    // (2) The agenda topic asked only for discussion (the urgent topic of a meeting): advisory.
    const two = await c.meet({ chair: c.pD });
    await c.grantUpdate(c.pA);
    const agendaId = (await c.meetings.occurrence(c.owner, two.occ))!.agenda[0]!.id;
    const m2 = await adopt(c, two.rec, c.asA, { agendaItemId: agendaId, changes: [change(c, task, c.pA)] });
    assert.equal((await decisionOf(c, m2)).scope, "recommendation");
    assert.match((await decisionOf(c, m2)).scopeReason!, /discussion or a recommendation/);
    // (3) The owner has decided the topic: a vote does not override it.
    await c.decisions.record(c.owner, { commandId: cid("dec"), projectId: c.project, category: "decision", topic: "Release Process", statement: "Releases are cut from main on Fridays.", wording: "Releases are cut from main on Fridays.", source: { channel: "direct" }, basedOn: 0 });
    const three = await c.meet({ chair: c.pD });
    const m3 = await adopt(c, three.rec, c.asA, { topic: "release process", changes: [change(c, task, c.pA)] });
    const d3 = await decisionOf(c, m3);
    assert.equal(d3.scope, "recommendation");
    assert.match(d3.scopeReason!, /the owner has decided/);
    // (4) With a delegated decision on the agenda, a carrier holding the action and no owner decision on the topic: in scope.
    const four = await c.meet({ chair: c.pD, item: "delegated-decision" });
    const m4 = await adopt(c, four.rec, c.asA, { agendaItemId: four.item, topic: "unrelated topic", changes: [change(c, task, c.pA)] });
    assert.equal((await decisionOf(c, m4)).scope, "in-scope");
    // (5) An explicit owner instruction is planned, not voted on; a topic nobody can check fails closed.
    const five = await c.meet({ chair: c.pD, item: "owner-instruction" });
    await refuses("invalid_command", () => motionOf(c, five.rec, c.asA, { agendaItemId: five.item }), (e) => assert.match(e.message, /not vote/));
  });

  suite("a motion cannot widen permissions or budgets: only registered kinds, never a grant, budget or configuration action, and only for roster agents in the project", async (c) => {
    const task = await c.task();
    const { rec } = await c.meet({ chair: c.pD });
    await refuses("invalid_command", () => motionOf(c, rec, c.asA, { changes: [{ ...change(c, task, c.pA), kind: "grant.create" }] }), (e) => assert.match(e.message, /not a kind of change/));
    const widening = c.reopen({ appliers: { "grant.widen": { ...taskUpdateApplier(c.projects), action: "principal.manage" } } });
    await refuses("invalid_command", () => widening.move(c.asA, { commandId: cid("mv"), recordId: rec, text, changes: [{ ...change(c, task, c.pA), kind: "grant.widen" }] } as never), (e) => assert.match(e.message, /never decided by a vote/));
    const spending = c.reopen({ appliers: { "budget.raise": { ...taskUpdateApplier(c.projects), action: "budget.manage" } } });
    await refuses("invalid_command", () => spending.move(c.asA, { commandId: cid("mv"), recordId: rec, text, changes: [{ ...change(c, task, c.pA), kind: "budget.raise" }] } as never), (e) => assert.match(e.message, /never decided by a vote/));
    await refuses("invalid_command", () => motionOf(c, rec, c.asA, { changes: [change(c, task, c.pE)] }), (e) => assert.match(e.message, /not on this meeting's roster/));
    const foreign = await c.projects.createTask({ commandId: cid("t"), actor: c.owner.id, projectId: (await c.projects.createProject({ commandId: cid("p"), actor: c.owner.id, name: "Elsewhere" })).id, title: "Other" });
    await refuses("invalid_command", () => motionOf(c, rec, c.asA, { changes: [change(c, { id: foreign.id, revision: foreign.revision }, c.pA)] }), (e) => assert.match(e.message, /not in this meeting's project/));
    await refuses("invalid_command", () => motionOf(c, rec, c.asA, { changes: [{ ...change(c, task, c.pA), patch: { title: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH" } }] }));
    await refuses("forbidden", () => motionOf(c, rec, c.asE));
  });

  suite("a vote reassigns a task through the assignment service when the carrying agent holds assignment.manage, does nothing without it, and never overrides a later move by the owner (card M02e)", async (c) => {
    const assignments = AssignmentService.withEpoch(c.storage, c.projects.epoch, c.projects, options);
    const mayWork = async (id: string, project: string, taskId: string) => {
      const p = await c.principals.get(id);
      if (p === undefined) return false;
      const eff = await c.grants.effective({ id: p.id, kind: p.kind, name: p.name, grants: p.grants }, new Date().toISOString());
      return allows(eff as never, "attempt.work", project, { resource: { kind: "task", id: taskId } }) && allows(eff as never, "task.read", project, { resource: { kind: "task", id: taskId } });
    };
    const reassign = c.reopen({ appliers: { "task.reassign": taskReassignApplier(assignments, c.projects, c.principals, mayWork) } });
    const idOf = (p: string): string => p.slice("agent:".length);
    const mk = async (title: string) => { const t = await c.task(title); await assignments.assignTask({ commandId: cid("as"), actor: c.owner.id, taskId: t.id, owner: { kind: "agent", id: idOf(c.pD) } }); return t; };
    const vote = async (t: { id: string; revision: number }, carrier: string, to: string) => {
      const a = (await assignments.getAssignment(t.id))!;
      const { rec } = await c.meet({ chair: c.pD });
      const m = await adopt({ ...c, records: reassign } as Ctx, rec, c.asB, { topic: "unrelated topic", changes: [{ kind: "task.reassign", agent: carrier, target: { kind: "task", id: t.id }, expectedRevision: t.revision, patch: { toAgent: to, from: a.owner === undefined ? null : `agent:${a.owner.id}`, generation: a.generation, revision: a.revision }, summary: "hand the task over" }] });
      return { d: await decisionOf({ ...c, records: reassign } as Ctx, m) };
    };
    const ownerOf = async (id: string) => (await assignments.getAssignment(id))!.owner?.id;
    await c.grants.grant(c.owner, { commandId: cid("g"), grantee: c.pA, action: "assignment.manage", project: c.project, source: "direct", basis: "may reassign" } as never);
    for (const action of ["attempt.work", "task.read"]) await c.grants.grant(c.owner, { commandId: cid("g"), grantee: c.pC, action, project: c.project, source: "direct", basis: "may work" } as never);
    const t1 = await mk("Task one");
    const one = await vote(t1, c.pA, c.pC);
    const r1 = await reassign.apply(c.host, { decisionId: one.d.id });
    assert.deepEqual([r1.applied, r1.notApplied], [1, 0]);
    assert.equal(await ownerOf(t1.id), idOf(c.pC));
    // Without the right the carrying agent holds, the vote is recorded but the task stays where it is.
    const t2 = await mk("Task two");
    const two = await vote(t2, c.pB, c.pC);
    const r2 = await reassign.apply(c.host, { decisionId: two.d.id });
    assert.deepEqual([r2.applied, r2.notApplied], [0, 1]);
    assert.equal(await ownerOf(t2.id), idOf(c.pD));
    // The owner transfers the task between the decision and its carrying out: the decision does not override that.
    const t3 = await mk("Task three");
    const three = await vote(t3, c.pA, c.pC);
    await assignments.transferTask({ commandId: cid("tr"), actor: c.owner.id, taskId: t3.id, expectedRevision: (await assignments.getAssignment(t3.id))!.revision, to: { kind: "agent", id: idOf(c.pB) } });
    const r3 = await reassign.apply(c.host, { decisionId: three.d.id });
    assert.deepEqual([r3.applied, r3.notApplied], [0, 1]);
    assert.equal(await ownerOf(t3.id), idOf(c.pB), "the owner's transfer stands");
    // ... or releases it.
    const t4 = await mk("Task four");
    const four = await vote(t4, c.pA, c.pC);
    await assignments.releaseTask({ commandId: cid("rl"), actor: c.owner.id, taskId: t4.id, expectedRevision: (await assignments.getAssignment(t4.id))!.revision });
    const r4 = await reassign.apply(c.host, { decisionId: four.d.id });
    assert.deepEqual([r4.applied, r4.notApplied], [0, 1]);
    assert.equal((await assignments.getAssignment(t4.id))!.state, "released", "the owner's release stands");
    // A target without attempt.work is refused.
    const t6 = await mk("Task six");
    const six = await vote(t6, c.pA, c.pE);
    const r6 = await reassign.apply(c.host, { decisionId: six.d.id });
    assert.deepEqual([r6.applied, r6.notApplied], [0, 1]);
    assert.equal(await ownerOf(t6.id), idOf(c.pD));
  });

  suite("a kind of change that widens spend or rights may be moved, and waits for the owner unless the approval policy lets its class through; the owner's agreement is what carries it out (owner decision 2026-10-29)", async (c) => {
    const widens = { ...taskUpdateApplier(c.projects), widens: "spend" as const };
    const asked: string[] = [];
    // Under a policy that asks (or with no policy given), the decision waits for the owner even though the owner is not in the room.
    const asking = c.reopen({ appliers: { "task.update": taskUpdateApplier(c.projects), "task.retitle-widening": widens }, widening: async (cls, project) => { asked.push(`${cls} ${project}`); return "ask"; } });
    const task = await c.task("Budgeted task");
    await c.grantUpdate(c.pA);
    const { rec } = await c.meet({ chair: c.pD, item: "delegated-decision" });
    const agenda = (await c.meetings.occurrence(c.owner, (await recordOf(c, rec)).occurrenceId))!.agenda.find((a) => a.intent === "delegated-decision")!.id;
    const m = await adopt({ ...c, records: asking } as Ctx, rec, c.asB, { agendaItemId: agenda, topic: "unrelated topic", changes: [{ ...change(c, task, c.pA, "Retitled by a vote"), kind: "task.retitle-widening" }] });
    const d = await decisionOf({ ...c, records: asking } as Ctx, m);
    assert.deepEqual([d.scope, d.ownerResponse], ["in-scope", "pending"], "a widening change waits for the owner");
    assert.ok(asked.length >= 1 && asked.every((a) => a.startsWith("spend ")));
    assert.deepEqual(await asking.apply(c.host, { decisionId: d.id }), { applied: 0, notApplied: 0, pending: 1, waitingFor: "owner" });
    assert.equal((await c.projects.getTask(task.id))!.title, "Budgeted task");
    assert.equal((await asking.ownerRespond(c.owner, { commandId: cid("or"), decisionId: d.id, response: "agree" })).applied, 1);
    assert.equal((await c.projects.getTask(task.id))!.title, "Retitled by a vote");
    // A policy that lets the class through (an autonomous profile, or a specific setting) carries it out without asking.
    const second = await c.task("Second budgeted task");
    const letting = c.reopen({ appliers: { "task.update": taskUpdateApplier(c.projects), "task.retitle-widening": widens }, widening: async () => "allow" });
    const two = await c.meet({ chair: c.pD, item: "delegated-decision" });
    const agenda2 = (await c.meetings.occurrence(c.owner, (await recordOf(c, two.rec)).occurrenceId))!.agenda.find((a) => a.intent === "delegated-decision")!.id;
    const m2 = await adopt({ ...c, records: letting } as Ctx, two.rec, c.asB, { agendaItemId: agenda2, topic: "unrelated topic", changes: [{ ...change(c, second, c.pA, "Retitled with the policy's leave"), kind: "task.retitle-widening" }] });
    const d2 = await decisionOf({ ...c, records: letting } as Ctx, m2);
    assert.equal(d2.ownerResponse, "not-asked");
    assert.deepEqual(await letting.apply(c.host, { decisionId: d2.id }), { applied: 1, notApplied: 0, pending: 0 });
    // The policy tightened after the vote: with the owner not having agreed, the change is refused at apply, not carried out.
    const third = await c.task("Third budgeted task");
    const three = await c.meet({ chair: c.pD, item: "delegated-decision" });
    const agenda3 = (await c.meetings.occurrence(c.owner, (await recordOf(c, three.rec)).occurrenceId))!.agenda.find((a) => a.intent === "delegated-decision")!.id;
    let answer: "allow" | "ask" = "allow";
    const moving = c.reopen({ appliers: { "task.update": taskUpdateApplier(c.projects), "task.retitle-widening": widens }, widening: async () => answer });
    const m3 = await adopt({ ...c, records: moving } as Ctx, three.rec, c.asB, { agendaItemId: agenda3, topic: "unrelated topic", changes: [{ ...change(c, third, c.pA, "Should not happen"), kind: "task.retitle-widening" }] });
    answer = "ask";
    const d3 = await decisionOf({ ...c, records: moving } as Ctx, m3);
    const result = await moving.apply(c.host, { decisionId: d3.id });
    assert.deepEqual([result.applied, result.notApplied], [0, 1]);
    assert.equal((await c.projects.getTask(third.id))!.title, "Third budgeted task");
  });

  suite("decisions apply with the expected revision: an adopted change is carried out once, a target that moved is shown as not applied, and a grant revoked since the meeting is not honoured", async (c) => {
    const first = await c.task("First task");
    const second = await c.task("Second task");
    const third = await c.task("Third task");
    const g = await c.grantUpdate(c.pA);
    const { rec } = await c.meet({ chair: c.pD, item: "delegated-decision" });
    const m = await adopt(c, rec, c.asB, { agendaItemId: (await c.meetings.occurrence(c.owner, (await recordOf(c, rec)).occurrenceId))!.agenda.find((a) => a.intent === "delegated-decision")!.id, changes: [change(c, first, c.pA, "First, retitled"), change(c, second, c.pA, "Second, retitled"), change(c, third, c.pA, "Third, retitled")] });
    const d = await decisionOf(c, m);
    assert.equal(d.scope, "in-scope");
    assert.deepEqual(d.changes.map((x) => x.state), ["adopted", "adopted", "adopted"]);
    // Between the meeting and the apply: the second task moved, and the grant is revoked after the first change would have been fine.
    await c.projects.updateTask({ commandId: cid("u"), actor: c.owner.id, taskId: second.id, expectedRevision: second.revision, title: "Second, edited by someone" });
    await refuses("forbidden", () => c.records.apply(c.asA, { decisionId: d.id }));
    const result = await c.records.apply(c.host, { decisionId: d.id });
    assert.deepEqual(result, { applied: 2, notApplied: 1, pending: 0 });
    const after = await decisionOf(c, m);
    assert.deepEqual(after.changes.map((x) => [x.state, x.code]), [["applied", undefined], ["not-applied", "conflict"], ["applied", undefined]]);
    assert.match(after.changes[1]!.reason!, /is at revision 2, not 1/);
    assert.equal((await c.projects.getTask(first.id))!.title, "First, retitled");
    assert.equal((await c.projects.getTask(second.id))!.title, "Second, edited by someone", "a conflict changes nothing");
    assert.equal((await c.projects.getTask(third.id))!.title, "Third, retitled");
    assert.equal(c.calls.applied.length, 2);
    // Applying again does nothing twice.
    assert.deepEqual(await c.records.apply(c.host, { decisionId: d.id }), { applied: 2, notApplied: 1, pending: 0 });
    assert.equal(c.calls.applied.length, 2);
    // The summary matches: adopted and applied are separate, and the conflict is listed with its reason.
    const s = (await c.records.summary(c.reader, rec))!.content;
    assert.deepEqual(s.adopted, [d.id]);
    assert.deepEqual(s.applied.map((x) => x.changeId), ["c1", "c3"]);
    assert.deepEqual(s.notApplied.map((x) => [x.changeId, /revision/.test(x.reason)]), [["c2", true]]);
    assert.equal(s.decisions[0]!.status, "part-applied");
    assert.equal(s.consistent, true);
    // A grant that was revoked after the meeting is not honoured, and the meeting does not reopen it.
    const fourth = await c.task("Fourth task");
    const next = await c.meet({ chair: c.pD, item: "delegated-decision" });
    const m2 = await adopt(c, next.rec, c.asB, { agendaItemId: next.item, changes: [change(c, fourth, c.pA, "Fourth, retitled")] });
    await c.grants.revoke(c.owner, { commandId: cid("rv"), grantId: g.id, expectedRevision: g.revision, reason: "the owner changed their mind" });
    const d2 = await decisionOf(c, m2);
    assert.deepEqual(await c.records.apply(c.host, { decisionId: d2.id }), { applied: 0, notApplied: 1, pending: 0 });
    assert.match((await decisionOf(c, m2)).changes[0]!.reason!, /does not hold task.update/);
    assert.equal((await c.projects.getTask(fourth.id))!.title, "Fourth task");
    assert.deepEqual((await c.principals.get(c.pA))!.grants, [], "applying granted nothing");
    assert.equal((await c.records.apply(c.host, { decisionId: d2.id })).applied, 0, "and a repeat does not reopen it");
  });

  suite("the decisions of a meeting reach M04's return to work: tasks changed by an adopted decision the team may carry out, and no refused change", async (c) => {
    const kept = await c.task("Kept");
    const refused = await c.task("Refused");
    await c.grantUpdate(c.pA);
    const { rec, item } = await c.meet({ chair: c.pD, item: "delegated-decision" });
    const m1 = await adopt(c, rec, c.asB, { agendaItemId: item, changes: [change(c, kept, c.pA, "Kept, retitled")] });
    await c.records.apply(c.host, { decisionId: (await decisionOf(c, m1)).id });
    await c.projects.updateTask({ commandId: cid("u"), actor: c.owner.id, taskId: refused.id, expectedRevision: refused.revision, title: "Moved on" });
    const m2 = await adopt(c, rec, c.asB, { agendaItemId: item, changes: [change(c, refused, c.pA)] });
    await c.records.apply(c.host, { decisionId: (await decisionOf(c, m2)).id });
    await adopt(c, rec, c.asB, { agendaItemId: item });
    const advisory = await adopt(c, rec, c.asB, { changes: [change(c, kept, c.pB)] });
    assert.equal((await decisionOf(c, advisory)).scope, "recommendation", "nobody carrying it holds the action");
    const out = await c.records.attendanceDecisions(c.host, { recordId: rec });
    assert.deepEqual(out.decisions.map((d) => [d.ref, d.supersedes]), [[(await decisionOf(c, m1)).id, [kept.id]]]);
    assert.equal(out.more, 0);
    await refuses("forbidden", () => c.records.attendanceDecisions(c.reader, { recordId: rec }));
  });

  suite("a crash between saving progress and finishing applies a change once; a task under an implementation hold is not changed", async (c) => {
    const task = await c.task();
    await c.grantUpdate(c.pA);
    const { rec, item } = await c.meet({ chair: c.pD, item: "delegated-decision" });
    const m = await adopt(c, rec, c.asB, { agendaItemId: item, changes: [change(c, task, c.pA)] });
    const d = await decisionOf(c, m);
    c.calls.failOnce = true;
    await refuses("unavailable", () => c.records.apply(c.host, { decisionId: d.id }));
    assert.equal((await decisionOf(c, m)).changes[0]!.state, "applying", "progress is saved before the effect");
    const result = await c.reopen().apply(c.host, { decisionId: d.id });
    assert.deepEqual(result, { applied: 1, notApplied: 0, pending: 0 });
    assert.deepEqual(c.calls.applied, [`mtg:${d.id}:c1`], "one application with a stable command ID");
    assert.equal((await c.projects.getTask(task.id))!.title, "Write the guide, v2");
    // An implementation hold from the owner blocks the change.
    const held = await c.task("Held task");
    await c.decisions.record(c.owner, { commandId: cid("hold"), projectId: c.project, category: "gate", gate: "implementation-hold", topic: "implementation-gate", statement: "Hold all implementation.", wording: "Hold all implementation until I say otherwise.", source: { channel: "direct" }, basedOn: 0 });
    const next = await c.meet({ chair: c.pD, item: "delegated-decision" });
    const m2 = await adopt(c, next.rec, c.asB, { agendaItemId: next.item, changes: [change(c, held, c.pA)] });
    await c.records.apply(c.host, { decisionId: (await decisionOf(c, m2)).id });
    const blocked = (await decisionOf(c, m2)).changes[0]!;
    assert.deepEqual([blocked.state, blocked.code], ["not-applied", "gate"]);
    assert.equal((await c.projects.getTask(held.id))!.title, "Held task");
  });

  suite("a change already applying keeps the agreement it started under: a replay after a crash uses it, and a later owner decline does not cancel it (card M02e)", async (c) => {
    const task = await c.task();
    await c.grantUpdate(c.pA);
    const { rec, item } = await c.meet({ chair: c.pD, item: "delegated-decision" });
    const m = await adopt(c, rec, c.asB, { agendaItemId: item, changes: [change(c, task, c.pA)] });
    const d = await decisionOf(c, m);
    const seen: string[] = [];
    let crash = true;
    const base = taskUpdateApplier(c.projects);
    const widening: ChangeApplier = { ...base, widens: "spend", async apply(ch) { seen.push(ch.agreedBy); if (crash) { crash = false; throw new DomainError("unavailable", "storage went away"); } return base.apply(ch); } };
    const svc = c.reopen({ appliers: { "task.update": widening }, widening: async () => "allow" });
    await refuses("unavailable", () => svc.apply(c.host, { decisionId: d.id }));
    const mid = (await decisionOf(c, m)).changes[0]!;
    assert.deepEqual([mid.state, mid.agreedBy], ["applying", "policy:spend"]);
    // The owner declines while the apply is half done; the started change carries on under the recorded agreement.
    await svc.ownerRespond(c.owner, { commandId: cid("dec"), decisionId: d.id, response: "decline" });
    assert.equal((await decisionOf(c, m)).changes[0]!.state, "applying", "a decline does not cancel a started apply");
    assert.deepEqual(await svc.apply(c.host, { decisionId: d.id }), { applied: 1, notApplied: 0, pending: 0 });
    assert.deepEqual(seen, ["policy:spend", "policy:spend"], "the same basis on the replay");
    assert.equal((await c.projects.getTask(task.id))!.title, "Write the guide, v2");
  });

  suite("an apply that committed and crashed before `applied` was saved is replayed under the recorded actor, so the service's recovery finishes it (card M02e3)", async (c) => {
    const assignments = AssignmentService.withEpoch(c.storage, c.projects.epoch, c.projects, options);
    const mayWork = async () => true;
    const crashing = (base: ChangeApplier, seen: string[]): ChangeApplier => {
      let crash = true;
      return { ...base, widens: "spend", async apply(ch) { seen.push(ch.actor); const done = await base.apply(ch); if (crash) { crash = false; throw new DomainError("unavailable", "went down after the effect"); } return done; } };
    };
    const idOf = (p: string): string => p.slice("agent:".length);
    // task.update: the owner agrees (the owner applies), the effect commits, the save of `applied` is lost, the service recovers.
    const seenU: string[] = [];
    const svcU = c.reopen({ appliers: { "task.update": crashing(taskUpdateApplier(c.projects), seenU) }, widening: async () => "ask" });
    const task = await c.task("Crash task");
    await c.grantUpdate(c.pA);
    const one = await c.meet({ chair: c.pD, item: "delegated-decision" });
    const mU = await adopt({ ...c, records: svcU } as Ctx, one.rec, c.asB, { agendaItemId: one.item, changes: [change(c, task, c.pA, "Retitled once")] });
    const dU = await decisionOf({ ...c, records: svcU } as Ctx, mU);
    await refuses("unavailable", () => svcU.ownerRespond(c.owner, { commandId: cid("or"), decisionId: dU.id, response: "agree" }));
    const midU = (await decisionOf({ ...c, records: svcU } as Ctx, mU)).changes[0]!;
    assert.deepEqual([midU.state, midU.actedAs], ["applying", c.owner.id]);
    assert.deepEqual(await svcU.apply(c.host, { decisionId: dU.id }), { applied: 1, notApplied: 0, pending: 0 });
    assert.deepEqual(seenU, [c.owner.id, c.owner.id], "the replay runs as the recorded actor");
    assert.equal((await c.projects.getTask(task.id))!.title, "Retitled once");
    assert.equal((await c.projects.getTask(task.id))!.revision, task.revision + 1, "the effect happened once");
    // task.reassign, the same way.
    const seenR: string[] = [];
    const svcR = c.reopen({ appliers: { "task.reassign": crashing(taskReassignApplier(assignments, c.projects, c.principals, mayWork), seenR) }, widening: async () => "ask" });
    await c.grants.grant(c.owner, { commandId: cid("g"), grantee: c.pA, action: "assignment.manage", project: c.project, source: "direct", basis: "may reassign" } as never);
    const t = await c.task("Crash reassign");
    await assignments.assignTask({ commandId: cid("as"), actor: c.owner.id, taskId: t.id, owner: { kind: "agent", id: idOf(c.pD) } });
    const a = (await assignments.getAssignment(t.id))!;
    const two = await c.meet({ chair: c.pD });
    const mR = await adopt({ ...c, records: svcR } as Ctx, two.rec, c.asB, { topic: "unrelated topic", changes: [{ kind: "task.reassign", agent: c.pA, target: { kind: "task", id: t.id }, expectedRevision: t.revision, patch: { toAgent: c.pC, from: c.pD, generation: a.generation, revision: a.revision }, summary: "hand the task over" }] });
    const dR = await decisionOf({ ...c, records: svcR } as Ctx, mR);
    await refuses("unavailable", () => svcR.ownerRespond(c.owner, { commandId: cid("or"), decisionId: dR.id, response: "agree" }));
    assert.equal((await decisionOf({ ...c, records: svcR } as Ctx, mR)).changes[0]!.state, "applying");
    assert.deepEqual(await svcR.apply(c.host, { decisionId: dR.id }), { applied: 1, notApplied: 0, pending: 0 });
    assert.deepEqual(seenR, [c.owner.id, c.owner.id]);
    assert.equal((await assignments.getAssignment(t.id))!.owner?.id, idOf(c.pC));
  });

  suite("an owner decline that arrives before a change is saved as applying stops the apply", async (c) => {
    const task = await c.task();
    await c.grantUpdate(c.pA);
    const { rec, item } = await c.meet({ chair: c.pD, item: "delegated-decision" });
    const m = await adopt(c, rec, c.asB, { agendaItemId: item, changes: [change(c, task, c.pA)] });
    const d = await decisionOf(c, m);
    const seen: string[] = [];
    const base = taskUpdateApplier(c.projects);
    const widening: ChangeApplier = { ...base, widens: "spend", async apply(ch) { seen.push(ch.commandId); return base.apply(ch); } };
    // The policy check runs after the decision was read and before the change is saved as applying: the decline lands in that gap.
    let svc: MeetingRecordService | undefined;
    svc = c.reopen({ appliers: { "task.update": widening }, widening: async () => { await svc!.ownerRespond(c.owner, { commandId: cid("dec"), decisionId: d.id, response: "decline" }); return "allow"; } });
    const out = await svc.apply(c.host, { decisionId: d.id });
    assert.deepEqual(seen, [], "a declined change is not applied");
    assert.equal(out.applied, 0);
    assert.equal((await decisionOf(c, m)).changes[0]!.state, "not-applied");
    assert.equal((await c.projects.getTask(task.id))!.title, "Write the guide");
  });

  suite("a meeting grant for every project is refused by the grant service, not only by the key check", async (c) => {
    const controller = { id: "service:meeting-records", kind: "service", name: "meeting-records", grants: [] } as never;
    const applier = grantApplier(c.grants, controller);
    const base = { commandId: "mtg:d1:c1", actor: "agent:x", expectedRevision: 1, patch: { grantee: c.pA, action: "task.read", expiresAt: "2026-10-21T08:00:00.000Z" }, agreedBy: "owner:agreed" };
    await assert.rejects(() => applier.apply({ ...base, target: { kind: "project", id: "*" } }), (e: unknown) => e instanceof DomainError && e.code === "invalid_command");
    await assert.rejects(() => applier.apply({ ...base, target: { kind: "project", id: c.project }, patch: { ...base.patch, action: "principal.manage" } }), (e: unknown) => e instanceof DomainError && e.code === "invalid_command");
    // The same patch shape minus the bad field is accepted by the real grant service, so the refusals above are about the field and not the setup.
    const soon = new Date(Date.parse(clock()) + 3600_000).toISOString();
    await applier.apply({ ...base, target: { kind: "project", id: c.project }, patch: { ...base.patch, expiresAt: soon } });
    for (const bad of ["9999-99-99T00:00:00.000Z", "2026-11-15T25:00:00.000Z"]) {
      await assert.rejects(() => applier.apply({ ...base, commandId: "mtg:d1:c2", target: { kind: "project", id: c.project }, patch: { ...base.patch, expiresAt: bad } }), (e: unknown) => e instanceof DomainError && e.code === "invalid_command" && e.field === "expiresAt");
    }
  });

  suite("owner presence: arrival is a durable event that reports what happened; with the owner present an adopted decision waits for agreement; departure authorizes nothing; an alternative needs no re-vote", async (c) => {
    const task = await c.task();
    const other = await c.task("Other task");
    await c.grantUpdate(c.pA);
    const { rec, item } = await c.meet({ chair: c.pD, item: "delegated-decision" });
    // Owner absent: an in-scope decision is actionable at once.
    const m1 = await adopt(c, rec, c.asB, { agendaItemId: item, changes: [change(c, task, c.pA, "Done while away")] });
    const d1 = await decisionOf(c, m1);
    assert.equal(d1.ownerResponse, "not-asked");
    assert.equal((await c.records.apply(c.host, { decisionId: d1.id })).applied, 1);
    // The owner arrives: the report is from the records and says what was already executed.
    const joined = await c.records.ownerJoin(c.owner, { commandId: cid("oj"), recordId: rec });
    assert.match(joined.report, /1 decision\(s\) adopted so far; 1 change\(s\) applied, 0 not applied, 0 not yet applied/);
    const entry = (await c.records.discussion(c.owner, rec))!.entries.filter((e) => e.kind === "presence").at(-1)!;
    assert.match(entry.text, /The owner joined\. 1 decision\(s\) adopted/);
    assert.equal((await recordOf(c, rec)).ownerPresent, true);
    await refuses("forbidden", () => c.records.ownerJoin(c.asA, { commandId: cid("oj"), recordId: rec }));
    await refuses("forbidden", () => c.records.ownerRespond(c.asA, { commandId: cid("or"), decisionId: d1.id, response: "agree" }));
    // With the owner present, the next adopted decision waits for the owner and unrelated work goes on.
    const m2 = await adopt(c, rec, c.asB, { agendaItemId: item, changes: [change(c, other, c.pA, "Wait for the owner")] });
    const d2 = await decisionOf(c, m2);
    assert.equal(d2.ownerResponse, "pending");
    assert.deepEqual(await c.records.apply(c.host, { decisionId: d2.id }), { applied: 0, notApplied: 0, pending: 1, waitingFor: "owner" });
    await c.records.ownerLeave(c.owner, { commandId: cid("ol"), recordId: rec });
    assert.deepEqual(await c.records.apply(c.host, { decisionId: d2.id }), { applied: 0, notApplied: 0, pending: 1, waitingFor: "owner" }, "leaving authorizes nothing");
    assert.equal((await c.projects.getTask(other.id))!.title, "Other task");
    assert.ok((await c.records.summary(c.reader, rec))!.content.unresolved.some((u) => u.kind === "owner"));
    assert.equal((await c.records.summary(c.reader, rec))!.content.decisions[1]!.status, "waiting-for-owner");
    const waitingSummary = (await c.records.summary(c.reader, rec))!.content;
    assert.deepEqual(waitingSummary.adopted, [d1.id, d2.id], "both are adopted");
    assert.deepEqual(waitingSummary.applied.map((a) => a.decisionId), [d1.id], "only the one that was carried out is applied");
    assert.deepEqual(waitingSummary.notApplied, []);
    assert.equal(waitingSummary.consistent, true);
    await c.records.append(c.asA, { commandId: cid("s"), recordId: rec, kind: "statement", text: "Unrelated work continues." });
    // The owner agrees: it is applied.
    const agreed = await c.records.ownerRespond(c.owner, { commandId: cid("or"), decisionId: d2.id, response: "agree" });
    assert.equal(agreed.applied, 1);
    assert.equal((await c.projects.getTask(other.id))!.title, "Wait for the owner");
    await refuses("invalid_command", () => c.records.ownerRespond(c.owner, { commandId: cid("or"), decisionId: d2.id, response: "decline" }), (e) => assert.match(e.message, /already answered/));
    // The owner declines one and makes an alternative of another: neither is applied, no re-vote is needed, and the owner's wording is a C08 record.
    await c.records.ownerJoin(c.owner, { commandId: cid("oj"), recordId: rec });
    const t3 = await c.task("Third");
    const t4 = await c.task("Fourth");
    const m3 = await adopt(c, rec, c.asB, { agendaItemId: item, changes: [change(c, t3, c.pA)] });
    const m4 = await adopt(c, rec, c.asB, { agendaItemId: item, changes: [change(c, t4, c.pA)] });
    await c.records.ownerRespond(c.owner, { commandId: cid("or"), decisionId: (await decisionOf(c, m3)).id, response: "decline" });
    const alt = await c.records.ownerRespond(c.owner, {
      commandId: cid("or"), decisionId: (await decisionOf(c, m4)).id, response: "alternative",
      alternative: { commandId: cid("alt"), projectId: c.project, category: "decision", topic: "task titles", statement: "Task four keeps its title.", wording: "Task four keeps its title.", source: { channel: "direct" }, basedOn: 0 },
    });
    assert.match(alt.ownerDecisionId!, /^dec-/);
    assert.equal((await c.decisions.get(c.owner, alt.ownerDecisionId!))!.statement, "Task four keeps its title.", "the alternative is C08's record, not a copy");
    for (const t of [t3, t4]) assert.equal((await c.projects.getTask(t.id))!.revision, 1);
    const sum = (await c.records.summary(c.reader, rec))!.content;
    assert.equal(sum.decisions[2]!.ownerResponse, "declined");
    assert.equal(sum.decisions[3]!.ownerDecisionId, alt.ownerDecisionId);
    assert.equal(sum.consistent, true);
    assert.equal(sum.attendance.owner.joins, 2);
    // Arrival after the fact still reports accurately: the declined and unapplied changes are counted as not applied.
    const again = await c.records.ownerJoin(c.owner, { commandId: cid("oj"), recordId: rec });
    assert.match(again.report, /4 decision\(s\) adopted so far; 2 change\(s\) applied, 2 not applied, 0 not yet applied/);
  });

  suite("the summary lists attendance, key updates, decisions with reasons, dissent, unresolved questions, actions and the plan, and keeps adopted apart from applied", async (c) => {
    const task = await c.task();
    const { rec, item } = await c.meet({ chair: c.pD, paused: [c.pC] });
    await c.records.join(c.asA, { commandId: cid("j"), recordId: rec });
    await c.records.append(c.asA, { commandId: cid("s"), recordId: rec, kind: "statement", text: "Build time is down to 35 minutes.", tag: "update" });
    const q = await c.records.append(c.asB, { commandId: cid("s"), recordId: rec, kind: "statement", text: "Who warms the cache?", tag: "question" });
    const q2 = await c.records.append(c.asB, { commandId: cid("s"), recordId: rec, kind: "statement", text: "Is Sunday safe?", tag: "question" });
    await c.records.append(c.asA, { commandId: cid("s"), recordId: rec, kind: "statement", text: "A will warm the cache by hand.", answers: q.id });
    await c.records.append(c.asA, { commandId: cid("s"), recordId: rec, kind: "statement", text: "Write the migration note.", tag: "action", assignee: c.pB, taskId: task.id });
    await c.records.append(c.asB, { commandId: cid("s"), recordId: rec, kind: "statement", text: "Tomorrow: finish the cache job, then the note.", tag: "plan", assignee: c.pA });
    await c.grantUpdate(c.pA);
    await motionOf(c, rec, c.asA, { changes: [change(c, task, c.pA, "Retitled by vote")] });
    const m1 = await motionOf(c, rec, c.asA);
    await open(c, c.asD, m1);
    await ballot(c, c.asA, m1, "yes");
    await ballot(c, c.asB, m1, "no", { reason: "Too early to commit." });
    assert.equal((await close(c, c.asD, m1)).state, "tie-pending", "C is absent, so one yes and one no is a tie");
    await c.records.castingVote(c.asD, { commandId: cid("cv"), motionId: m1, value: "no", reason: "Too early to commit." });
    const s = (await c.records.summary(c.reader, rec))!.content;
    assert.deepEqual([...s.attendance.present].sort(), [c.pA, c.pB].sort());
    assert.deepEqual(s.attendance.absent, [{ id: c.pC, why: "withheld-paused" }]);
    assert.equal(s.attendance.chair, c.pD);
    assert.deepEqual(s.keyUpdates.map((x) => x.text), ["Build time is down to 35 minutes."]);
    assert.deepEqual(s.unresolved.filter((u) => u.kind === "question").map((u) => u.ref), [q2.id], "an answered question is not unresolved");
    assert.ok(s.unresolved.some((u) => u.kind === "motion" && /not put to a vote/.test(u.text)));
    assert.deepEqual(s.actions.map((x) => [x.text, x.assignee, x.taskId]), [["Write the migration note.", c.pB, task.id]]);
    assert.deepEqual(s.plan.map((x) => [x.assignee, x.speaker]), [[c.pA, c.pB]]);
    assert.equal(s.decisions.length, 1);
    assert.equal(s.decisions[0]!.outcome, "rejected");
    assert.equal(s.decisions[0]!.tie!.how, "casting-vote");
    assert.deepEqual(s.dissent.map((x) => [x.voter, x.value]), [[c.pA, "yes"]], "dissent is the ballots against the outcome");
    assert.equal(s.decisions[0]!.reasons.length, 2);
    assert.deepEqual(s.decisions[0]!.discussion.recordId, rec);
    assert.deepEqual(s.adopted, []);
  });

  suite("stand-up plans persist across a restart and are read by the project's meeting readers", async (c) => {
    const first = await c.meet({ chair: c.pD });
    await c.records.append(c.asA, { commandId: cid("s"), recordId: first.rec, kind: "statement", text: "Finish the cache job.", tag: "plan", assignee: c.pA });
    await c.records.append(c.asB, { commandId: cid("s"), recordId: first.rec, kind: "statement", text: "Review the cache job.", tag: "plan", assignee: c.pB });
    await c.records.finish(c.host, { commandId: cid("fin"), recordId: first.rec });
    await c.records.summarize(c.host, { commandId: cid("sum"), recordId: first.rec });
    const restarted = c.reopen();
    const plan = (await restarted.latestPlan(c.reader, c.project))!;
    assert.deepEqual(plan.items.map((i) => i.text), ["Finish the cache job.", "Review the cache job."]);
    assert.equal(plan.recordId, first.rec);
    assert.equal(await restarted.latestPlan(c.outsider, c.project), undefined);
    assert.equal(await restarted.latestPlan(c.eve, c.project), undefined);
    // A later meeting's plan replaces it; a refresh of the earlier summary does not bring the old plan back.
    minutes(60);
    const second = await c.meet({ chair: c.pD });
    await c.records.append(c.asA, { commandId: cid("s"), recordId: second.rec, kind: "statement", text: "Ship the cache job.", tag: "plan", assignee: c.pA });
    await c.records.finish(c.host, { commandId: cid("fin"), recordId: second.rec });
    await c.records.summarize(c.host, { commandId: cid("sum"), recordId: second.rec });
    await c.records.summarize(c.host, { commandId: cid("sum"), recordId: first.rec });
    assert.deepEqual((await c.reopen().latestPlan(c.reader, c.project))!.items.map((i) => i.text), ["Ship the cache job."]);
    // Repeating the same summarize command changes nothing.
    const before = (await c.records.summary(c.reader, second.rec))!.snapshot!.builds;
    const once = await c.records.summarize(c.host, { commandId: "sum-fixed", recordId: second.rec });
    const twice = await c.records.summarize(c.host, { commandId: "sum-fixed", recordId: second.rec });
    assert.deepEqual([once.builds, twice.builds, (await c.records.summary(c.reader, second.rec))!.snapshot!.builds], [before + 1, before + 1, before + 1], "a repeat of the same command writes no new build");
  });

  suite("the decision log writes one line per change that reached a final state, with who allowed it and the policy's cell, no content of the change, once even on a replay or a restart, and only the owner reads it (card M02f)", async (c) => {
    const widens = { ...taskUpdateApplier(c.projects), widens: "spend" as const };
    let answer: "allow" | "ask" = "ask";
    const svc = c.reopen({ appliers: { "task.update": taskUpdateApplier(c.projects), "task.retitle-widening": widens }, widening: async () => answer });
    const ctx = { ...c, records: svc } as Ctx;
    const decide = async (title: string, words: string): Promise<{ d: DecisionRecordBody & { id: string }; task: { id: string } }> => {
      const task = await c.task(title);
      const meeting = await c.meet({ chair: c.pD, item: "delegated-decision" });
      const agenda = (await c.meetings.occurrence(c.owner, (await recordOf(c, meeting.rec)).occurrenceId))!.agenda.find((a) => a.intent === "delegated-decision")!.id;
      const m = await adopt(ctx, meeting.rec, c.asB, { agendaItemId: agenda, topic: "unrelated topic", changes: [{ ...change(c, task, c.pA, words), kind: "task.retitle-widening" }] });
      return { d: await decisionOf(ctx, m) as never, task };
    };
    await c.grantUpdate(c.pA);
    const log = (q: Parameters<MeetingRecordService["decisionLog"]>[1] = {}) => svc.decisionLog(c.owner, q);
    assert.deepEqual((await log()).entries, [], "nothing yet");
    // 1. The policy asks; the owner agrees: applied, allowed by the owner.
    const one = await decide("Log one", "SECRET words one");
    assert.equal((await svc.ownerRespond(c.owner, { commandId: cid("or"), decisionId: one.d.id, response: "agree" })).applied, 1);
    // 2. The policy lets spend through: applied, allowed by the policy.
    answer = "allow";
    const two = await decide("Log two", "SECRET words two");
    assert.deepEqual(await svc.apply(c.host, { decisionId: two.d.id }), { applied: 1, notApplied: 0, pending: 0 });
    // 3. The policy tightens after the vote: refused.
    const three = await decide("Log three", "SECRET words three");
    answer = "ask";
    assert.equal((await svc.apply(c.host, { decisionId: three.d.id })).notApplied, 1);
    // 4. The owner declines before anything runs.
    const four = await decide("Log four", "SECRET words four");
    await svc.ownerRespond(c.owner, { commandId: cid("or"), decisionId: four.d.id, response: "decline" });
    const all = (await log()).entries;
    assert.equal(all.length, 4);
    const by = (id: string) => all.find((e) => e.decisionId === id)!;
    assert.deepEqual([by(one.d.id).outcome, by(one.d.id).decidedBy, by(one.d.id).agreedBy, by(one.d.id).setting, by(one.d.id).widens], ["applied", "owner", "owner:agreed", "ask", "spend"]);
    assert.deepEqual([by(two.d.id).outcome, by(two.d.id).decidedBy, by(two.d.id).agreedBy, by(two.d.id).setting], ["applied", "policy", "policy:spend", "allow"]);
    assert.deepEqual([by(three.d.id).outcome, by(three.d.id).decidedBy, by(three.d.id).code, by(three.d.id).setting], ["refused", "none", "unauthorized", "ask"]);
    assert.deepEqual([by(four.d.id).outcome, by(four.d.id).decidedBy, by(four.d.id).code], ["declined", "owner", "owner"]);
    for (const e of all) {
      assert.match(e.patchHash, /^[0-9a-f]{64}$/);
      assert.equal(e.projectId, c.project);
      assert.equal(e.kind, "task.retitle-widening");
      assert.doesNotMatch(JSON.stringify(e), /SECRET|Log (one|two|three|four)/, "no words of the change are kept");
    }
    // Replays and a restarted service add nothing.
    await svc.apply(c.host, { decisionId: one.d.id });
    await svc.apply(c.host, { decisionId: two.d.id });
    await svc.apply(c.host, { decisionId: three.d.id });
    const restarted = c.reopen({ appliers: { "task.update": taskUpdateApplier(c.projects), "task.retitle-widening": widens }, widening: async () => "ask" });
    for (const x of [one, two, three, four]) await restarted.apply(c.host, { decisionId: x.d.id });
    assert.equal((await restarted.decisionLog(c.owner)).entries.length, 4, "each change is logged once");
    // Filters and pages.
    assert.deepEqual((await log({ outcome: "applied" })).entries.map((e) => e.decisionId).sort(), [one.d.id, two.d.id].sort());
    assert.equal((await log({ outcome: "declined" })).entries.length, 1);
    assert.equal((await log({ kind: "budget.raise" })).entries.length, 0);
    assert.equal((await log({ projectId: "proj-none" })).entries.length, 0);
    const seen: string[] = [];
    let page = await log({ limit: 3 });
    assert.equal(page.entries.length, 3);
    assert.ok(page.next !== undefined);
    seen.push(...page.entries.map((e) => e.id));
    page = await log({ limit: 3, after: page.next });
    seen.push(...page.entries.map((e) => e.id));
    assert.equal(page.next, undefined);
    assert.equal(new Set(seen).size, 4);
    await refuses("invalid_command", () => log({ limit: 0 }));
    await refuses("invalid_command", () => log({ limit: 101 }));
    await refuses("invalid_command", () => log({ outcome: "bogus" }));
    for (const p of [c.asA, c.host, c.mgr, c.reader]) await refuses("forbidden", () => svc.decisionLog(p, {}));
  });


  suite("a lost decision log line is written by the sweep, a log failure never changes the decision, and a failing change does not hide the lines of those that finished (card M02f)", async (c) => {
    const widens = { ...taskUpdateApplier(c.projects), widens: "spend" as const };
    const boom: ChangeApplier = { ...taskUpdateApplier(c.projects), async apply() { throw new Error("plain failure"); } };
    const svc = c.reopen({ appliers: { "task.update": taskUpdateApplier(c.projects), "task.boom": boom, "task.retitle-widening": widens }, widening: async () => "ask" });
    const ctx = { ...c, records: svc } as Ctx;
    await c.grantUpdate(c.pA);
    const itemOf = async (rec: string) => (await c.meetings.occurrence(c.owner, (await recordOf(c, rec)).occurrenceId))!.agenda.find((a) => a.intent === "delegated-decision")!.id;
    const decide = async (changes: Record<string, unknown>[]): Promise<{ id: string }> => {
      const meeting = await c.meet({ chair: c.pD, item: "delegated-decision" });
      return decisionOf(ctx, await adopt(ctx, meeting.rec, c.asB, { agendaItemId: await itemOf(meeting.rec), changes }));
    };
    const lines = async () => (await svc.decisionLog(c.owner)).entries;
    // 1. The owner declines, the log write fails: the decision stands, the line is missing, the sweep writes it once.
    const t1 = await c.task("Lost one");
    const one = await decide([{ ...change(c, t1, c.pA, "x"), kind: "task.retitle-widening" }]);
    c.calls.failLog = true;
    await svc.ownerRespond(c.owner, { commandId: cid("or"), decisionId: one.id, response: "decline" });
    assert.equal(c.calls.failLog, false, "the log write was attempted and failed");
    assert.equal((await decisionOf(ctx, (await c.records.decision(c.owner, one.id) as never as { motionId: string }).motionId)).changes[0]!.state, "not-applied", "the decision is unchanged by the failed log write");
    assert.equal((await lines()).length, 0, "the line is missing");
    const first = await svc.sweep(c.host, { projectId: c.project });
    assert.ok(first.logChecked.includes(one.id));
    assert.deepEqual((await lines()).map((e) => [e.decisionId, e.outcome]), [[one.id, "declined"]]);
    assert.deepEqual((await svc.sweep(c.host, { projectId: c.project })).logChecked, [], "once written, the decision leaves the index");
    assert.equal((await lines()).length, 1, "and the sweep does not write it twice");
    // 2. The last change is applied, the log write fails: the apply result is the same, the sweep fills the gap.
    const t2 = await c.task("Lost two");
    const two = await decide([change(c, t2, c.pA, "Lost two, retitled")]);
    c.calls.failLog = true;
    assert.deepEqual(await svc.apply(c.host, { decisionId: two.id }), { applied: 1, notApplied: 0, pending: 0 });
    assert.equal((await lines()).length, 1);
    await svc.sweep(c.host, { projectId: c.project });
    assert.deepEqual((await lines()).filter((e) => e.decisionId === two.id).map((e) => e.outcome), ["applied"]);
    // 3. c1 applies, c2 throws a plain error: c1's applied line exists, and the error still reaches the caller.
    const t3 = await c.task("Finished");
    const t4 = await c.task("Broken");
    const three = await decide([change(c, t3, c.pA, "Finished, retitled"), { ...change(c, t4, c.pA, "y"), kind: "task.boom" }]);
    await assert.rejects(() => svc.apply(c.host, { decisionId: three.id }), /plain failure/);
    assert.deepEqual((await lines()).filter((e) => e.decisionId === three.id).map((e) => e.outcome), ["applied"], "the finished change is logged although the next one threw");
    // 4. A target that moved is not-applied (code conflict); an owner alternative is overridden.
    const t5 = await c.task("Moved");
    const five = await decide([change(c, t5, c.pA, "z")]);
    await c.projects.updateTask({ commandId: cid("u"), actor: c.owner.id, taskId: t5.id, expectedRevision: t5.revision, title: "Moved by someone" });
    await svc.apply(c.host, { decisionId: five.id });
    const t6 = await c.task("Overridden");
    const six = await decide([{ ...change(c, t6, c.pA, "w"), kind: "task.retitle-widening" }]);
    await svc.ownerRespond(c.owner, { commandId: cid("or"), decisionId: six.id, response: "alternative", alternative: { commandId: cid("alt"), projectId: c.project, category: "decision", topic: "task titles", statement: "Keep the title.", wording: "Keep the title.", source: { channel: "direct" }, basedOn: 0 } });
    const all = await lines();
    const of = (id: string) => all.find((e) => e.decisionId === id)!;
    assert.deepEqual([of(five.id).outcome, of(five.id).code, of(five.id).decidedBy], ["not-applied", "conflict", "none"]);
    assert.deepEqual([of(six.id).outcome, of(six.id).decidedBy], ["overridden", "owner"]);
    // The plain team vote that widens nothing is labelled "vote", not "policy".
    assert.equal(of(two.id).decidedBy, "vote");
  });

  suite("the decision log records the policy cell as it was when the change was decided, an owner-agreed change refused for withdrawn rights as the owner's with rights_withdrawn, and the reader refuses a task-scoped owner credential and bounds its scan (card M02f)", async (c) => {
    const widens = { ...taskUpdateApplier(c.projects), widens: "spend" as const };
    let answer: "allow" | "ask" = "ask";
    const svc = c.reopen({ appliers: { "task.retitle-widening": widens }, widening: async () => answer });
    const ctx = { ...c, records: svc } as Ctx;
    const grant = await c.grantUpdate(c.pA);
    const decide = async (title: string): Promise<{ id: string }> => {
      const task = await c.task(title);
      const meeting = await c.meet({ chair: c.pD, item: "delegated-decision" });
      const agenda = (await c.meetings.occurrence(c.owner, (await recordOf(c, meeting.rec)).occurrenceId))!.agenda.find((a) => a.intent === "delegated-decision")!.id;
      return decisionOf(ctx, await adopt(ctx, meeting.rec, c.asB, { agendaItemId: agenda, changes: [{ ...change(c, task, c.pA, title), kind: "task.retitle-widening" }] }));
    };
    // Refused while the policy asks; then the policy loosens: the line still says "ask", the cell of that moment.
    answer = "allow";
    const one = await decide("Cell one");
    answer = "ask";
    await svc.apply(c.host, { decisionId: one.id });
    answer = "allow";
    await svc.sweep(c.host, { projectId: c.project });
    const entries = (await svc.decisionLog(c.owner)).entries;
    assert.deepEqual(entries.map((e) => [e.outcome, e.setting, e.decidedBy]), [["refused", "ask", "none"]]);
    // The owner agreed, then the agent's right was revoked: refused, but the owner is the one who allowed it.
    answer = "ask";
    const two = await decide("Cell two");
    await c.grants.revoke(c.owner, { commandId: cid("rv"), grantId: grant.id, expectedRevision: grant.revision, reason: "rights withdrawn" });
    await svc.ownerRespond(c.owner, { commandId: cid("or"), decisionId: two.id, response: "agree" });
    const withdrawn = (await svc.decisionLog(c.owner)).entries.find((e) => e.decisionId === two.id);
    assert.ok(withdrawn !== undefined);
    assert.deepEqual([withdrawn.outcome, withdrawn.code, withdrawn.decidedBy, withdrawn.agreedBy], ["refused", "rights_withdrawn", "owner", "owner:agreed"]);
    // A task-scoped owner credential is refused like a plain agent.
    await refuses("forbidden", () => svc.decisionLog({ ...c.owner, taskScope: { taskId: "task-aaaaaaaaaaaaaaaaaaaa" } } as never, {}));
    // The scan is bounded: a filter that matches nothing stops with a cursor.
    const small = MeetingRecordService.withEpoch(c.storage, await c.storage.currentEpoch(), {}, { ...options, logScan: { pageSize: 1, reads: 1 } });
    const bounded = await small.decisionLog(c.owner, { kind: "nothing" });
    assert.equal(bounded.scanLimited, true, "the scan stopped early");
    assert.deepEqual(bounded.entries, []);
    assert.match(bounded.next ?? "", /^mdl-/, "with a cursor to go on from");
    const rest = await small.decisionLog(c.owner, { kind: "nothing", after: bounded.next! });
    assert.equal(rest.scanLimited, true);
    assert.notEqual(rest.next, bounded.next, "and the cursor moves on");
    assert.equal((await svc.decisionLog(c.owner, { kind: "nothing" })).scanLimited, undefined, "a short log is read to its end");
  });

  suite("outcomes go back to the agenda item and so to its conversation, through M03's path, once", async (c) => {
    const { rec, item } = await c.meet({ chair: c.pD, item: "delegated-decision" });
    const m = await adopt(c, rec, c.asA, { agendaItemId: item });
    const m2 = await motionOf(c, rec, c.asA, { agendaItemId: item });
    await c.records.table(c.owner, { commandId: cid("t"), motionId: m2, reason: "needs a benchmark" });
    const first = await c.records.returnOutcomes(c.owner, { recordId: rec });
    assert.deepEqual(first.returned, [m, m2]);
    const itemNow = (await c.meetings.agendaItem(c.owner, item!))!;
    assert.equal(itemNow.state, "resolved");
    assert.equal(itemNow.outcomeRef, (await motionBody(c, m)).decisionId, "the item links C08-style to the decision record");
    assert.match(itemNow.outcomeNote!, /Motion 1 was adopted/);
    const again = await c.records.returnOutcomes(c.owner, { recordId: rec });
    assert.deepEqual(again.returned, [], "nothing is returned twice");
    await refuses("forbidden", () => c.records.returnOutcomes(c.reader, { recordId: rec }));
  });

  suite("simultaneous entries and ballots all land: sequence numbers are unique, every voter counts, and two closers make one decision", async (c) => {
    const { rec } = await c.meet({ chair: c.pD });
    const writers = [c.asA, c.asB, c.asC, c.asA, c.asB, c.asC];
    const made = await Promise.all(writers.map((w, i) => c.records.append(w, { commandId: cid("par"), recordId: rec, kind: "statement", text: `Parallel ${i}` })));
    assert.equal(new Set(made.map((x) => x.seq)).size, made.length, "every entry has its own sequence number");
    const m = await motionOf(c, rec, c.asA);
    await open(c, c.owner, m);
    await Promise.all([c.asA, c.asB, c.asC].map((p) => ballot(c, p, m, "yes")));
    const closers = await Promise.allSettled([close(c, c.owner, m), close(c, c.host, m)]);
    assert.ok(closers.some((r) => r.status === "fulfilled"), "one closes it");
    const d = await decisionOf(c, m);
    assert.equal(d.tally!.cast, 3);
    const entries = (await c.records.discussion(c.owner, rec, { limit: 100 }))!.entries;
    assert.deepEqual(entries.map((e) => e.seq), entries.map((_, i) => i + 1), "no gaps and no duplicates");
    assert.equal(entries.filter((e) => e.kind === "vote" && /adopted/.test(e.text)).length, 1);
  });

  suite("a vote with no time left takes no ballot, the limits are enforced, and one vote at a time", async (c) => {
    const { rec } = await c.meet({ chair: c.pD });
    const m = await motionOf(c, rec, c.asA);
    const m2 = await motionOf(c, rec, c.asB);
    await open(c, c.owner, m, { limitMinutes: 5 });
    await refuses("invalid_command", () => open(c, c.owner, m2), (e) => assert.match(e.message, /one vote at a time/));
    await refuses("invalid_command", () => c.records.openVote(c.owner, { commandId: cid("ov"), motionId: m2, expectedVersion: 1, limitMinutes: 500 }));
    minutes(6);
    await refuses("invalid_command", () => ballot(c, c.asA, m, "yes"), (e) => assert.match(e.message, /time for voting is over|over/));
    assert.equal((await close(c, c.owner, m)).state, "no-quorum", "no ballots at all");
    await refuses("invalid_command", () => c.records.move(c.asA, { commandId: cid("mv"), recordId: rec, text: "x".repeat(4001) } as never));
    await refuses("forbidden", () => c.records.openVote(c.asA, { commandId: cid("ov"), motionId: m2, expectedVersion: 1 }));
    await refuses("invalid_command", () => c.records.openVote(c.owner, { commandId: cid("ov"), motionId: m2, expectedVersion: 1, actor: "owner:rob" } as never));
    await refuses("stale_revision", () => c.records.openVote(c.owner, { commandId: cid("ov"), motionId: m2, expectedVersion: 7 }));
  });

}

test("a reassignment decided in a meeting names one active agent and the assignment it observed, goes through the assignment service, and is repeatable (card M02e)", async () => {
  const calls: [string, Record<string, unknown>][] = [];
  let current: Record<string, unknown> | undefined;
  const assignments = {
    getAssignment: async () => current,
    transferTask: async (c: Record<string, unknown>) => { calls.push(["transfer", c]); current = { ...current, owner: c["to"], generation: (current!["generation"] as number) + 1 }; return { revision: 50 }; },
    assignTask: async (c: Record<string, unknown>) => { calls.push(["assign", c]); current = { state: "assigned", revision: 60, generation: ((current?.["generation"] as number | undefined) ?? 0) + 1, owner: c["owner"] }; return { revision: 60 }; },
  };
  const states: Record<string, string> = { "agent:ann": "active", "agent:bob": "active", "agent:old": "disabled" };
  const works = new Set(["agent:ann", "agent:bob"]);
  const applier = taskReassignApplier(assignments as never, { getTask: async (id: string) => (id === "task-a" ? { projectId: "proj-a" } : undefined) } as never, { get: async (id: string) => (states[id] === undefined ? undefined : { state: states[id]! }) }, async (id) => works.has(id));
  assert.deepEqual([applier.action, applier.widens], ["assignment.manage", undefined]);
  assert.equal(await applier.project({ kind: "task", id: "task-a" }), "proj-a");
  assert.equal(await applier.project({ kind: "project", id: "task-a" }), undefined);
  const base = { commandId: "mtg:d1:c1", actor: "agent:x", target: { kind: "task", id: "task-a" }, expectedRevision: 1, agreedBy: "policy:none" };
  const never = { from: null };
  const refused = (patch: unknown, code = "invalid_command", b: object = base) => assert.rejects(() => applier.apply({ ...b, patch: patch as never } as never), (e: unknown) => e instanceof DomainError && e.code === code);
  for (const patch of [{}, { toAgent: "agent:ann" }, { toAgent: "ann", ...never }, { toAgent: "agent:ann", ...never, extra: 1 }, { toAgent: "agent:old", ...never }, { toAgent: "agent:nobody", ...never }, { toAgent: 7, ...never },
    { toAgent: "agent:ann", from: "ann", generation: 1, revision: 1 }, { toAgent: "agent:ann", from: null, generation: 0, revision: 1 }, { toAgent: "agent:ann", from: null, generation: 1 }, { toAgent: "agent:ann", from: null, revision: 1.5, generation: 1 }, { toAgent: "agent:ann", from: "agent:bob" }]) {
    await refused(patch);
  }
  await refused({ toAgent: "agent:ann", ...never }, "invalid_command", { ...base, target: { kind: "project", id: "p" } });
  assert.equal(calls.length, 0);
  await applier.apply({ ...base, patch: { toAgent: "agent:ann", ...never } });
  assert.deepEqual([calls[0]![0], calls[0]![1]["owner"], calls[0]![1]["expectedRevision"]], ["assign", { kind: "agent", id: "ann" }, undefined], "never assigned: a plain assignment");
  await applier.apply({ ...base, patch: { toAgent: "agent:ann", ...never } });
  assert.equal(calls.length, 1, "a replay finds the owner already in place at a later generation");
  // Assigned to ann at generation 1, revision 60: the decision observed that; the transfer carries the observed revision, not the live one.
  current = { ...current, revision: 99 };
  await applier.apply({ ...base, patch: { toAgent: "agent:bob", from: "agent:ann", generation: 1, revision: 60 } });
  assert.deepEqual([calls[1]![0], calls[1]![1]["commandId"], calls[1]![1]["expectedRevision"], calls[1]![1]["to"]], ["transfer", "mtg:d1:c1", 60, { kind: "agent", id: "bob" }]);
  await applier.apply({ ...base, patch: { toAgent: "agent:bob", from: "agent:ann", generation: 1, revision: 60 } });
  assert.equal(calls.length, 2, "a replay after the transfer does nothing");
  // The owner moved the task meanwhile: the decision does not override that.
  await refused({ toAgent: "agent:ann", from: "agent:old", generation: 2, revision: 70 }, "stale_revision");
  await refused({ toAgent: "agent:ann", from: "agent:bob", generation: 1, revision: 70 }, "stale_revision");
  current = { state: "released", revision: 7, generation: 2 };
  await refused({ toAgent: "agent:ann", from: "agent:bob", generation: 2, revision: 6 }, "stale_revision");
  await applier.apply({ ...base, patch: { toAgent: "agent:ann", from: null, generation: 2, revision: 7 } });
  assert.deepEqual([calls[2]![0], calls[2]![1]["expectedRevision"]], ["assign", 7], "released: assigned again at its observed revision");
  // A running attempt: use a hand-off. A target without the rights to work: refused.
  current = { state: "assigned", revision: 8, generation: 3, owner: { kind: "agent", id: "ann" }, activeAttemptId: "att-1" };
  await assert.rejects(() => applier.apply({ ...base, patch: { toAgent: "agent:bob", from: "agent:ann", generation: 3, revision: 8 } as never }), (e: unknown) => e instanceof DomainError && e.code === "invalid_command" && /hand-off/.test(e.message));
  current = { state: "assigned", revision: 8, generation: 3, owner: { kind: "agent", id: "ann" } };
  works.delete("agent:bob");
  await assert.rejects(() => applier.apply({ ...base, patch: { toAgent: "agent:bob", from: "agent:ann", generation: 3, revision: 8 } as never }), (e: unknown) => e instanceof DomainError && e.code === "invalid_command" && /may not work/.test(e.message));
  assert.equal(calls.length, 3);
});

test("a budget raise decided in a meeting widens spend, names a task and positive amounts only, and is carried out as the controller with who allowed it (card M02e)", async () => {
  const calls: Record<string, unknown>[] = [];
  const controller = { id: "service:meeting-records", kind: "service", name: "meeting-records", grants: [] } as never;
  const applier = budgetRaiseApplier({ raiseAgreed: async (_by: unknown, command: Record<string, unknown>) => { calls.push(command); } } as never, controller, { getTask: async (id: string) => (id === "task-a" ? { projectId: "proj-a" } : undefined) } as never);
  assert.deepEqual([applier.widens, applier.action], ["spend", "budget.manage"]);
  assert.equal(await applier.project({ kind: "task", id: "task-a" }), "proj-a");
  assert.equal(await applier.project({ kind: "agent", id: "task-a" }), undefined);
  const base = { commandId: "mtg:d1:c1", actor: "agent:x", target: { kind: "task", id: "task-a" }, expectedRevision: 1 };
  await applier.apply({ ...base, patch: { costMicros: 500, computeMs: 60_000 }, agreedBy: "owner:agreed" });
  await applier.apply({ ...base, commandId: "mtg:d1:c2", patch: { costMicros: 5 }, agreedBy: "policy:spend" });
  assert.deepEqual(calls.map((c) => [c["taskId"], c["costMicros"], c["computeMs"], c["agreedBy"], c["decisionId"]]), [["task-a", 500, 60_000, "owner:agreed", "mtg:d1:c1"], ["task-a", 5, undefined, "policy:spend", "mtg:d1:c2"]]);
  for (const patch of [{}, { costMicros: -1 }, { costMicros: 1.5 }, { costMicros: 5, tokens: 9 }, { computeMs: "lots" }]) {
    await assert.rejects(() => applier.apply({ ...base, patch: patch as never, agreedBy: "owner:agreed" }), (e: unknown) => e instanceof DomainError && e.code === "invalid_command");
  }
  await assert.rejects(() => applier.apply({ ...base, target: { kind: "agent", id: "x" }, patch: { costMicros: 1 }, agreedBy: "owner:agreed" }), (e: unknown) => e instanceof DomainError && e.code === "invalid_command");
  assert.equal(calls.length, 2, "nothing refused reached the budget");
});

test("a grant decided in a meeting widens rights, is for the target project, one agent, one action and an end time, and is carried out as the controller with who allowed it (card M02e)", async () => {
  const calls: Record<string, unknown>[] = [];
  const controller = { id: "service:meeting-records", kind: "service", name: "meeting-records", grants: [] } as never;
  const applier = grantApplier({ grantAgreed: async (_by: unknown, command: Record<string, unknown>) => { calls.push(command); } } as never, controller);
  assert.deepEqual([applier.widens, applier.action], ["access-change", "principal.manage"]);
  assert.equal(await applier.project({ kind: "project", id: "proj-a" }), "proj-a");
  assert.equal(await applier.project({ kind: "task", id: "proj-a" }), undefined);
  const base = { commandId: "mtg:d1:c1", actor: "agent:x", target: { kind: "project", id: "proj-a" }, expectedRevision: 1 };
  await applier.apply({ ...base, patch: { grantee: "agent:ann", action: "task.read", expiresAt: "2026-10-21T08:00:00Z", basis: "to read the plan" }, agreedBy: "policy:access-change" });
  assert.deepEqual(calls.map((c) => [c["grantee"], c["action"], c["project"], c["expiresAt"], c["agreedBy"], c["decisionId"], c["basis"]]), [["agent:ann", "task.read", "proj-a", "2026-10-21T08:00:00Z", "policy:access-change", "mtg:d1:c1", "to read the plan"]]);
  for (const patch of [{}, { grantee: "agent:ann", action: "task.read" }, { grantee: "agent:ann", action: "task.read", expiresAt: "2026-10-21T08:00:00Z", project: "*" }, { grantee: 5, action: "task.read", expiresAt: "x" }]) {
    await assert.rejects(() => applier.apply({ ...base, patch: patch as never, agreedBy: "owner:agreed" }), (e: unknown) => e instanceof DomainError && e.code === "invalid_command");
  }
  await assert.rejects(() => applier.apply({ ...base, target: { kind: "task", id: "t" }, patch: { grantee: "agent:ann", action: "task.read", expiresAt: "2026-10-21T08:00:00Z" }, agreedBy: "owner:agreed" }), (e: unknown) => e instanceof DomainError);
  assert.equal(calls.length, 1, "nothing refused reached the grants");
});

test("a grant decided in a meeting may name one task of the project, which becomes the grant's resource, and nothing else (card M02e)", async () => {
  const calls: Record<string, unknown>[] = [];
  const controller = { id: "service:meeting-records", kind: "service", name: "meeting-records", grants: [] } as never;
  const tasks: Record<string, string> = { "task-a": "proj-a", "task-b": "proj-b" };
  const applier = grantApplier({ grantAgreed: async (_by: unknown, command: Record<string, unknown>) => { calls.push(command); } } as never, controller, { getTask: async (id: string) => (tasks[id] === undefined ? undefined : { projectId: tasks[id] }) } as never);
  const base = { commandId: "mtg:d1:c1", actor: "agent:x", target: { kind: "project", id: "proj-a" }, expectedRevision: 1 };
  const patch = { grantee: "agent:ann", action: "task.update", expiresAt: "2026-10-21T08:00:00Z" };
  await applier.apply({ ...base, patch: { ...patch, taskId: "task-a" }, agreedBy: "owner:agreed" });
  await applier.apply({ ...base, commandId: "mtg:d1:c2", patch, agreedBy: "owner:agreed" });
  assert.deepEqual(calls.map((c) => c["resource"]), [{ kind: "task", id: "task-a" }, undefined]);
  for (const bad of [{ taskId: "task-b" }, { taskId: "task-zzz" }, { taskId: 5 }, { taskId: "" }, { taskId: "task-a", resource: { kind: "project", id: "proj-a" } }]) {
    await assert.rejects(() => applier.apply({ ...base, patch: { ...patch, ...bad } as never, agreedBy: "owner:agreed" }), (e: unknown) => e instanceof DomainError && e.code === "invalid_command");
  }
  const noProjects = grantApplier({ grantAgreed: async () => { calls.push({}); } } as never, controller);
  await assert.rejects(() => noProjects.apply({ ...base, patch: { ...patch, taskId: "task-a" }, agreedBy: "owner:agreed" }), (e: unknown) => e instanceof DomainError);
  assert.equal(calls.length, 2, "nothing refused reached the grants");
});
