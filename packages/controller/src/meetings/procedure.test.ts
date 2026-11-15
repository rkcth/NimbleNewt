import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AgentService } from "../agents/index.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { Availability } from "../conversations/index.js";
import { PauseService } from "../lifecycle/index.js";
import { GrantService, PrincipalService, type Principal } from "../security/index.js";
import {
  MeetingProcedureService, MeetingRecordService, MeetingService, PROCEDURE_DEFAULTS, taskUpdateApplier, type BallotRequest, type ChairFloor, type CommentRequest, type MeetingFloor, type MotionBody,
  type ObjectionRequest, type ProcedureBody, type ProcedureSettings, type RecordBody, type RevisionRequest, type RulingInput,
} from "./index.js";

after(stopServer);

let now = Date.parse("2026-10-20T08:00:00.000Z");
const clock = (): string => new Date(now).toISOString();
const minutes = (n: number): void => { now += n * 60_000; };
const options = { clock, pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};

/** The scripted members: they answer from tables and record everything they were given, so a test can read exactly what each member received. */
class Script implements MeetingFloor, ChairFloor {
  comments: CommentRequest[] = [];
  objections: ObjectionRequest[] = [];
  ballots: BallotRequest[] = [];
  revisions: RevisionRequest[] = [];
  onComment: (r: CommentRequest) => ReturnType<MeetingFloor["comment"]> = async (r) => ({ text: `${r.agent} on round ${r.round}: the cache is warm at 01:00`, stance: "for" });
  onObjection: (r: ObjectionRequest) => ReturnType<MeetingFloor["objection"]> = async () => ({ answer: "none" });
  onBallot: (r: BallotRequest) => ReturnType<MeetingFloor["ballot"]> = async (r) => ({ value: "yes", reason: `${r.agent} votes yes because the cache is warm` });
  onRevision: (r: RevisionRequest) => ReturnType<MeetingFloor["revision"]> = async () => ({ keep: true });
  onRule: ChairFloor["rule"] = async () => undefined;
  onCasting: ChairFloor["castingVote"] = async () => undefined;
  comment(r: CommentRequest) { this.comments.push(r); return this.onComment(r); }
  objection(r: ObjectionRequest) { this.objections.push(r); return this.onObjection(r); }
  ballot(r: BallotRequest) { this.ballots.push(r); return this.onBallot(r); }
  revision(r: RevisionRequest) { this.revisions.push(r); return this.onRevision(r); }
  rule(r: Parameters<ChairFloor["rule"]>[0]) { return this.onRule(r); }
  castingVote(r: Parameters<ChairFloor["castingVote"]>[0]) { return this.onCasting(r); }
}

const text = "We should move the nightly build to 01:00 because the cache is warm then.";

for (const backend of backends) {
  interface Ctx {
    owner: Principal; host: Principal; mgr: Principal; outsider: Principal;
    asA: Principal; asB: Principal; asC: Principal; asD: Principal; asE: Principal;
    pA: string; pB: string; pC: string; pD: string; pE: string; project: string;
    meetings: MeetingService; records: MeetingRecordService; procedure: MeetingProcedureService; script: Script; tasks: string[]; settings: { -readonly [K in keyof ProcedureSettings]?: ProcedureSettings[K] };
    traits: Map<string, { family?: string; info?: string }>; other: Map<string, Availability>; withChair: boolean; actable: Set<string>;
    reopen(): MeetingProcedureService;
    bare(): MeetingProcedureService;
    meet(o?: { roster?: string[]; chair?: string; paused?: string[] }): Promise<{ occ: string; rec: string }>;
    storage: import("../storage/types.js").ControllerStorage;
    state(motion: string): Promise<ProcedureBody>;
    motion(rec: string, by: Principal): Promise<string>;
    pump(motion: string, max?: number): Promise<{ stage: string; did: string; waiting?: { on: string; why: string }; done: boolean; steps: number }>;
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
        const agentIds: string[] = [];
        for (const nm of ["A", "B", "C", "D", "E"]) agentIds.push((await agents.create(owner, { commandId: cid("ag"), friendlyName: nm })).id);
        const [pA, pB, pC, pD, pE] = agentIds.map((i) => `agent:${i}`) as [string, string, string, string, string];
        const login = async (id: string): Promise<Principal> => principals.authenticate((await principals.issueCredential(owner, id)).token);
        const [asA, asB, asC, asD, asE] = [await login(pA), await login(pB), await login(pC), await login(pD), await login(pE)] as [Principal, Principal, Principal, Principal, Principal];
        const byId = new Map<string, Principal>([[pA, asA], [pB, asB], [pC, asC], [pD, asD], [pE, asE]]);
        const other = new Map<string, Availability>();
        const pauses = PauseService.withEpoch(world.storage, epoch, {}, { ...options, otherAvailability: async (id) => other.get(id) ?? "available" });
        const meetings = MeetingService.withEpoch(world.storage, epoch, {}, { availability: pauses.availability, ...options });
        const records = MeetingRecordService.withEpoch(world.storage, epoch, { meetings }, { ...options, appliers: { "task.update": taskUpdateApplier(projects) }, shareable: async () => false });
        const script = new Script();
        const settings: { -readonly [K in keyof ProcedureSettings]?: ProcedureSettings[K] } = {};
        const traits = new Map<string, { family?: string; info?: string }>();
        const tasks: string[] = [];
        const actable = new Set<string>([pA, pB, pC, pD, pE]);
        const make = (): MeetingProcedureService => MeetingProcedureService.withEpoch(world.storage, epoch, records, {
          ...options, settings: async () => settings, floor: script, chair: ctx.withChair ? script : undefined as never, actAs: async (a) => (actable.has(a) ? byId.get(a) : undefined), traits: (a) => traits.get(a),
          followUp: async (t) => { const made = await projects.createTask({ commandId: t.commandId, actor: owner.id, projectId: t.projectId, title: t.title, description: t.description }); tasks.push(made.id); return { taskId: made.id }; },
        });
        const host = await enroll("host", "h1", []);
        const mgr = await enroll("agent", "mgr", [{ action: "meeting.manage", project }]);
        const outsider = await enroll("agent", "zed", []);
        const ctx: Ctx = {
          owner, host, mgr, outsider, asA, asB, asC, asD, asE, pA, pB, pC, pD, pE, project, meetings, records, procedure: undefined as never, script, tasks, settings, traits, other, withChair: false, actable, storage: world.storage,
          reopen: make,
          bare: () => MeetingProcedureService.withEpoch(world.storage, epoch, records, { ...options }),
          meet: async (o = {}) => {
            for (const p of o.paused ?? []) other.set(p, "paused");
            const occ = (await meetings.callUrgent(mgr, { commandId: cid("urg"), projectId: project, title: "Sync", reason: "decide something", roster: o.roster ?? [pA, pB, pC] })).id;
            other.clear();
            const rec = (await records.open(mgr, { commandId: cid("open"), occurrenceId: occ, ...(o.chair === undefined ? {} : { chair: o.chair }) })).id;
            return { occ, rec };
          },
          state: async (motion) => (await ctx.procedure.status(owner, motion)) as unknown as ProcedureBody,
          motion: async (rec, by) => (await records.move(by, { commandId: cid("mv"), recordId: rec, text })).id,
          pump: async (motion, max = 200) => ctx.procedure.run(host, { motionId: motion, steps: max }),
        };
        ctx.procedure = make();
        await body(ctx);
      } finally { await world.close(); }
    });

  /** Moves the procedure one step at a time until `count` ballots have been asked for. */
  const untilBallots = async (c: Ctx, motion: string, count: number): Promise<void> => {
    for (let i = 0; i < 200 && c.script.ballots.length < count; i++) await c.procedure.advance(c.host, { motionId: motion });
    assert.equal(c.script.ballots.length, count);
  };
  const begin = (c: Ctx, motion: string) => c.procedure.begin(c.host, { commandId: cid("pb"), motionId: motion });
  const motionBody = async (c: Ctx, id: string): Promise<MotionBody> => (await c.records.motion(c.owner, id)) as unknown as MotionBody;
  const recordOf = async (c: Ctx, id: string): Promise<RecordBody> => (await c.records.record(c.owner, id)) as unknown as RecordBody;
  const statements = async (c: Ctx, rec: string) => (await c.records.discussion(c.owner, rec, { limit: 100 }))!.entries;
  const rule = (c: Ctx, by: Principal, motion: string, input: RulingInput) => c.procedure.rule(by, { commandId: cid("ru"), motionId: motion, ...input } as never);

  suite("two comment rounds: every present member has the floor once per round, hears the whole transcript up to its turn, the second round may check its desk, and the ballots stay out of the transcript", async (c) => {
    const { rec } = await c.meet();
    const motion = await c.motion(rec, c.asA);
    await begin(c, motion);
    const end = await c.pump(motion);
    assert.equal(end.done, true, end.did);
    const speakers = c.script.comments.map((r) => `${r.round}:${r.agent}`);
    const order = (await recordOf(c, rec)).roster;
    assert.deepEqual(speakers, [...order.map((a) => `1:${a}`), ...order.map((a) => `2:${a}`)], "everyone once per round, in seat order");
    assert.deepEqual(c.script.comments.map((r) => r.deskCheck), [false, false, false, true, true, true], "the desk may be checked from round two");
    // The whole transcript up to the turn: the first speaker hears nothing of the others, the last of round two hears all five earlier statements.
    assert.equal(c.script.comments[0]!.transcript.filter((e) => e.kind === "statement").length, 0);
    assert.equal(c.script.comments[2]!.transcript.filter((e) => e.kind === "statement").length, 2);
    assert.equal(c.script.comments[5]!.transcript.filter((e) => e.kind === "statement").length, 5);
    assert.ok(c.script.comments[5]!.transcript.some((e) => e.text.includes(`${order[0]} on round 1`)));
    // The ballots are not in anything a member is given.
    const all = JSON.stringify([c.script.comments, c.script.objections, c.script.ballots]);
    assert.equal(/votes yes because/.test(JSON.stringify([c.script.comments, c.script.objections])), false);
    for (const b of c.script.ballots) assert.equal(b.transcript.some((e) => /votes yes because/.test(e.text)), false, "no ballot in another voter's delivery");
    void all;
    const m = await motionBody(c, motion);
    assert.equal(m.state, "adopted");
    assert.equal((await c.state(motion)).stage, "concluded");
  });

  suite("the number of rounds is the owner's setting; the settings in force when the procedure began are kept", async (c) => {
    c.settings.rounds = 1;
    const { rec } = await c.meet();
    const motion = await c.motion(rec, c.asA);
    await begin(c, motion);
    c.settings.rounds = 4;
    await c.pump(motion);
    assert.equal(c.script.comments.length, 3, "one round of three members");
    assert.equal((await c.state(motion)).settings.rounds, 1, "a later change does not alter a procedure under way");
    c.settings.rounds = 3;
    const { rec: rec2 } = await c.meet();
    const second = await c.motion(rec2, c.asA);
    c.script.comments = [];
    await begin(c, second);
    await c.pump(second);
    assert.equal(c.script.comments.length, 9, "three rounds of three members");
    assert.deepEqual(PROCEDURE_DEFAULTS.rounds, 2, "the default is two");
  });

  suite("an absent member is skipped and recorded and has no ballot; nobody added later votes", async (c) => {
    const { rec } = await c.meet({ paused: [c.pB] });
    const motion = await c.motion(rec, c.asA);
    await begin(c, motion);
    const seated = (await recordOf(c, rec)).roster.filter((a) => a !== c.pB);
    assert.deepEqual((await c.state(motion)).seats, seated);
    await c.pump(motion);
    const state = await c.state(motion);
    assert.deepEqual([...new Set(state.skipped.filter((s) => s.stage === "comment").map((s) => s.agent))], [c.pB]);
    // B was absent when the record opened, so it has no ballot: the quorum is the roster's majority (2 of 3) and two ballots decide.
    assert.deepEqual(c.script.ballots.map((b) => b.agent).sort(), [c.pA, c.pC].sort());
    assert.equal((await motionBody(c, motion)).state, "adopted");
  });

  suite("a member who joins the room before being asked is heard first", async (c) => {
    const { rec } = await c.meet();
    const motion = await c.motion(rec, c.asA);
    await begin(c, motion);
    const order = (await recordOf(c, rec)).roster;
    const last = order[order.length - 1]!;
    await c.procedure.advance(c.host, { motionId: motion });
    await c.records.join(last === c.pA ? c.asA : last === c.pB ? c.asB : c.asC, { commandId: cid("j"), recordId: rec });
    const step = await c.procedure.advance(c.host, { motionId: motion });
    assert.match(step.did, new RegExp(`${last} spoke`), "the member who joined is heard before the rest");
    await c.pump(motion);
    assert.deepEqual(c.script.comments.slice(0, 3).map((r) => r.agent), [order[0], last, order[1]]);
  });

  suite("a member still absent when the round ends is skipped and recorded, and is not asked in the objection check", async (c) => {
    const { rec } = await c.meet({ paused: [c.pC] });
    const motion = await c.motion(rec, c.asA);
    await begin(c, motion);
    await c.pump(motion);
    const state = await c.state(motion);
    assert.deepEqual([...new Set(state.skipped.filter((s) => s.agent === c.pC).map((s) => `${s.stage}:${s.round}`))].sort(), ["check:1", "comment:1", "comment:2"]);
    assert.equal(c.script.objections.every((o) => o.agent !== c.pC), true);
    const summary = (await c.records.summary(c.owner, rec))!.content;
    assert.deepEqual(summary.procedure![0]!.skipped, [c.pC], "the summary lists who was skipped");
  });

  suite("the objection check gives each member only the motion version and the summary of the rounds; a member that does not answer is recorded and does not block", async (c) => {
    const { rec } = await c.meet({ roster: [c.pA, c.pB, c.pC, c.pD] });
    const motion = await c.motion(rec, c.asA);
    c.script.onObjection = async (r) => (r.agent === c.pB ? undefined : r.agent === c.pC ? Promise.reject(new Error("the model is down")) : { answer: "none" });
    await begin(c, motion);
    await c.pump(motion);
    assert.equal(c.script.objections.length, 4);
    for (const o of c.script.objections) {
      assert.deepEqual(Object.keys(o).sort(), ["agent", "motion", "run", "summary"], "the check carries nothing else");
      assert.equal(o.motion.version, 1);
      assert.match(o.summary, /Round 1: 4 members spoke/);
      assert.match(o.summary, /Round 2: 4 members spoke/);
    }
    const state = await c.state(motion);
    assert.deepEqual(state.check.answers.filter((a) => a.answer === "no-response").map((a) => a.agent).sort(), [c.pB, c.pC].sort());
    assert.equal((await motionBody(c, motion)).state, "adopted", "silence neither blocks nor counts as an objection");
  });

  suite("an objection holds the vote until the chair or the owner rules; the vote cannot be opened round the check", async (c) => {
    const { rec } = await c.meet({ chair: c.pD });
    const motion = await c.motion(rec, c.asA);
    c.script.onObjection = async (r) => (r.agent === c.pB ? { answer: "objection", reason: "the backup window overlaps at 01:00" } : { answer: "none" });
    await begin(c, motion);
    const held = await c.pump(motion);
    assert.equal(held.stage, "ruling");
    assert.equal(held.waiting!.on, "chair");
    assert.equal((await motionBody(c, motion)).state, "proposed");
    // The chair's own command to open the vote is refused while the check is unsettled; the controller's too.
    await refuses("invalid_command", () => c.records.openVote(c.asD, { commandId: cid("ov"), motionId: motion, expectedVersion: 1 }), (e) => assert.match(e.message, /ruling/));
    await refuses("invalid_command", () => c.records.openVote(c.host, { commandId: cid("ov"), motionId: motion, expectedVersion: 1 }));
    // The objection is in the transcript for the chair and everyone who speaks later.
    assert.ok((await statements(c, rec)).some((e) => /objection from .*backup window/.test(e.text)));
    // Only the chair and the owner rule.
    await refuses("forbidden", () => rule(c, c.asA, motion, { ruling: "proceed" }));
    await refuses("forbidden", () => rule(c, c.host, motion, { ruling: "proceed" }));
    // An amendment or a tabling goes through record commands a host may use for itself; as a ruling it is still the chair's or the owner's.
    await refuses("forbidden", () => rule(c, c.host, motion, { ruling: "uphold", addressed: "amend", text: "Move the build to 03:00 instead." }));
    await refuses("forbidden", () => rule(c, c.mgr, motion, { ruling: "uphold", addressed: "amend", text: "Move the build to 03:00 instead." }));
    assert.equal((await motionBody(c, motion)).version, 1, "nothing was amended");
    await rule(c, c.asD, motion, { ruling: "proceed", text: "The backup moves." });
    const state = await c.state(motion);
    assert.deepEqual(state.dissent.map((d) => d.agent), [c.pB], "the remaining objection is recorded as dissent");
    await c.pump(motion);
    assert.equal((await motionBody(c, motion)).state, "adopted");
    const note = (await c.records.summary(c.owner, rec))!.content.procedure![0]!;
    assert.deepEqual(note.dissent, [{ agent: c.pB, reason: "the backup window overlaps at 01:00" }]);
    // A ruling when nothing waits is refused.
    await refuses("invalid_command", () => rule(c, c.owner, motion, { ruling: "proceed" }));
  });

  suite("an upheld objection is addressed and the check runs again, at most the owner's number of times; then the chair or owner rules whether to proceed", async (c) => {
    c.settings.objectionReruns = 2;
    const { rec } = await c.meet({ chair: c.pD });
    const motion = await c.motion(rec, c.asA);
    c.script.onObjection = async (r) => (r.agent === c.pB ? { answer: "objection", reason: `still unhappy at run ${r.run}` } : { answer: "none" });
    await begin(c, motion);
    await c.pump(motion);
    await rule(c, c.asD, motion, { ruling: "uphold", addressed: "amend", text: "Move the build to 01:30 instead." });
    assert.equal((await motionBody(c, motion)).version, 2);
    let state = await c.state(motion);
    assert.deepEqual([state.stage, state.check.run, state.version], ["check", 2, 2]);
    await c.pump(motion);
    await rule(c, c.asD, motion, { ruling: "uphold", addressed: "clarify", text: "The backup job is not affected." });
    await c.pump(motion);
    assert.equal(c.script.objections.at(-1)!.run, 3);
    assert.equal(c.script.objections.at(-1)!.motion.text, "Move the build to 01:30 instead.", "the rerun carries the amended motion");
    // Two reruns used: uphold is refused, proceed and table remain.
    await refuses("invalid_command", () => rule(c, c.asD, motion, { ruling: "uphold", addressed: "clarify", text: "again" }), (e) => assert.match(e.message, /reruns/));
    await rule(c, c.owner, motion, { ruling: "proceed" });
    state = await c.state(motion);
    assert.deepEqual(state.dissent.map((d) => d.run), [3]);
    await c.pump(motion);
    const m = await motionBody(c, motion);
    assert.equal(m.state, "adopted");
    assert.equal(m.version, 2, "ballots are bound to the amended version");
  });

  suite("the number of reruns is a setting: with none, an upheld objection is not allowed", async (c) => {
    c.settings.objectionReruns = 0;
    const { rec } = await c.meet({ chair: c.pD });
    const motion = await c.motion(rec, c.asA);
    c.script.onObjection = async (r) => (r.agent === c.pB ? { answer: "objection", reason: "no" } : { answer: "none" });
    await begin(c, motion);
    await c.pump(motion);
    await refuses("invalid_command", () => rule(c, c.asD, motion, { ruling: "uphold", addressed: "clarify", text: "x" }));
    await rule(c, c.asD, motion, { ruling: "proceed" });
  });

  suite("tabling: members need time to research, the chair tables, there is no vote, the research becomes owned follow-up tasks and the motion returns as a deferred item with its reason and next step", async (c) => {
    const { rec } = await c.meet({ chair: c.pD });
    const motion = await c.motion(rec, c.asA);
    c.script.onObjection = async (r) => (r.agent === c.pC ? { answer: "research", reason: "measure the nightly cache hit rate at 01:00" } : { answer: "none" });
    await begin(c, motion);
    const held = await c.pump(motion);
    assert.equal(held.stage, "ruling");
    await refuses("invalid_command", () => rule(c, c.asD, motion, { ruling: "table" } as never), (e) => assert.equal(e.code, "invalid_command"));
    await rule(c, c.asD, motion, { ruling: "table", reason: "A decisive measurement is pending." });
    const state = await c.state(motion);
    assert.equal(state.stage, "tabled");
    assert.equal((await motionBody(c, motion)).state, "tabled");
    assert.equal(c.script.ballots.length, 0, "no ballot was asked");
    assert.equal(state.followUps.length, 1);
    assert.equal(state.followUps[0]!.agent, c.pC);
    assert.equal(c.tasks.length, 1, "one follow-up task was made");
    const summary = (await c.records.summary(c.owner, rec))!.content;
    assert.equal(summary.procedure![0]!.tabled!.followUps[0]!.taskId, c.tasks[0]);
    // Quorum and roster are unchanged.
    assert.deepEqual((await recordOf(c, rec)).roster.slice().sort(), [c.pA, c.pB, c.pC].sort());
    // The record's reason carries the next step for the deferred agenda item.
    assert.match((await motionBody(c, motion)).voidReason!, /Next step: .*measure the nightly cache hit rate/);
    assert.deepEqual((await c.state(motion)).voteAsked, [], "the cheap path: nobody was asked for a ballot");
  });

  suite("the chair may table only when a member asked for time to research and tabling is on; the owner always may, may overrule a tabling and ask for the vote anyway", async (c) => {
    const { rec } = await c.meet({ chair: c.pD });
    const motion = await c.motion(rec, c.asA);
    c.script.onObjection = async (r) => (r.agent === c.pB ? { answer: "objection", reason: "the backup window" } : { answer: "none" });
    await begin(c, motion);
    await c.pump(motion);
    // An objection alone is not a request for research: the chair may not table.
    await refuses("invalid_command", () => rule(c, c.asD, motion, { ruling: "table", reason: "just because" }), (e) => assert.match(e.message, /time to research/));
    // The owner always may.
    await rule(c, c.owner, motion, { ruling: "table", reason: "The owner wants this looked at first." });
    assert.equal((await motionBody(c, motion)).state, "tabled");
    // The owner changes their mind: overrule the tabling and ask for the vote anyway.
    await refuses("forbidden", () => c.procedure.overruleTabling(c.asD, { commandId: cid("ot"), motionId: motion }));
    const again = await c.procedure.overruleTabling(c.owner, { commandId: cid("ot"), motionId: motion });
    assert.equal((await motionBody(c, motion)).state, "tabled", "the tabled motion stays on record");
    const moved = await motionBody(c, again.motionId);
    assert.equal(moved.text, text);
    const fresh = await c.state(again.motionId);
    assert.equal(fresh.resumedFrom, motion);
    assert.equal(fresh.stage, "check", "the discussion has been held: the procedure resumes at the objection check");
    c.script.onObjection = async () => ({ answer: "none" });
    const done = await c.pump(again.motionId);
    assert.equal(done.done, true, done.did);
    assert.equal((await motionBody(c, again.motionId)).state, "adopted");
    // A second overrule of the same tabling repeats nothing.
    const twice = await c.procedure.overruleTabling(c.owner, { commandId: cid("ot2"), motionId: motion });
    assert.equal(twice.motionId, again.motionId);
  });

  suite("tabling can be switched off: then only the owner tables", async (c) => {
    c.settings.tabling = false;
    const { rec } = await c.meet({ chair: c.pD });
    const motion = await c.motion(rec, c.asA);
    c.script.onObjection = async (r) => (r.agent === c.pC ? { answer: "research", reason: "measure it" } : { answer: "none" });
    await begin(c, motion);
    await c.pump(motion);
    await refuses("invalid_command", () => rule(c, c.asD, motion, { ruling: "table", reason: "x" }), (e) => assert.match(e.message, /switched off/));
    await rule(c, c.asD, motion, { ruling: "proceed" });
  });

  suite("each ballot is asked of one member alone: the last voter's delivery holds no other ballot, and quorum, absence and the tie rule are the record's", async (c) => {
    const { rec } = await c.meet({ chair: c.pD });
    const motion = await c.motion(rec, c.asA);
    c.script.onBallot = async (r) => ({ value: r.agent === c.pC ? "no" : "yes", reason: `${r.agent} reasoned privately about the unique-marker-${r.agent.slice(6, 10)}` });
    await begin(c, motion);
    await c.pump(motion);
    const last = c.script.ballots.at(-1)!;
    assert.equal(c.script.ballots.length, 3);
    const seen = JSON.stringify(last);
    for (const a of [c.pA, c.pB, c.pC]) assert.equal(seen.includes(`unique-marker-${a.slice(6, 10)}`), false, "no ballot in anyone's delivery");
    const decision = (await c.records.decision(c.owner, (await motionBody(c, motion)).decisionId!))!;
    assert.equal((decision as unknown as { outcome: string }).outcome, "adopted");
    // The ballots are revealed together with the tally.
    assert.equal(((decision as unknown as { table: unknown[] }).table).length, 3);
  });

  suite("an owner message during an open vote: a voter who has not cast gets it with its ballot request, and each voter who cast before it is offered one revision turn; a revised ballot replaces the earlier one", async (c) => {
    const { rec } = await c.meet({ chair: c.pD });
    const motion = await c.motion(rec, c.asA);
    await begin(c, motion);
    // Run up to the second ballot.
    await untilBallots(c, motion, 2);
    assert.equal(c.script.ballots.length, 2);
    const said = await c.procedure.ownerMessage(c.owner, { commandId: cid("om"), recordId: rec, text: "Note that the backup job also runs at 01:00." });
    const [first, second] = c.script.ballots.map((b) => b.agent) as [string, string];
    c.script.onRevision = async (r) => (r.agent === first ? { value: "no", reason: "the backup job collides with the build" } : { keep: true });
    const done = await c.pump(motion);
    assert.equal(done.done, true, done.did);
    // C had not cast: the message is in its ballot request.
    assert.ok(c.script.ballots[2]!.transcript.some((e) => e.kind === "owner-message" && e.seq === said.seq));
    // A and B cast before it: each was offered exactly one revision turn, with the owner's message and what was said since.
    assert.deepEqual(c.script.revisions.map((r) => r.agent).sort(), [first, second].sort());
    for (const r of c.script.revisions) { assert.equal(r.ownerMessage.seq, said.seq); assert.ok(r.since.some((e) => e.seq === said.seq)); }
    const state = await c.state(motion);
    assert.deepEqual(state.offers.map((o) => `${o.agent}:${o.outcome}`).sort(), [`${first}:revised`, `${second}:kept`].sort());
    const decision = (await c.records.decision(c.owner, (await motionBody(c, motion)).decisionId!)) as unknown as { table: { voter: string; value: string }[]; tally: { yes: number; no: number } };
    assert.deepEqual([decision.tally.yes, decision.tally.no], [2, 1], "A's revised ballot is the one that counts");
  });

  suite("revision turns are limited by the owner's maximum per voter, and the vote closes only when all revision turns are finished", async (c) => {
    c.settings.maxRevisions = 1;
    const { rec } = await c.meet({ chair: c.pD });
    const motion = await c.motion(rec, c.asA);
    await begin(c, motion);
    await untilBallots(c, motion, 3);
    await c.procedure.ownerMessage(c.owner, { commandId: cid("om"), recordId: rec, text: "First thought from the owner." });
    await c.procedure.ownerMessage(c.owner, { commandId: cid("om"), recordId: rec, text: "Second thought from the owner." });
    assert.equal((await motionBody(c, motion)).state, "voting", "all ballots are in, but the revision turns are not finished");
    const done = await c.pump(motion);
    assert.equal(done.done, true);
    assert.equal(c.script.revisions.length, 3, "one per voter, not one per message: the maximum is one");
    assert.equal((await c.state(motion)).offersCapped.length, 3);
    c.settings.maxRevisions = 0;
  });

  suite("the owner is warned before a message that quotes a ballot during an open vote, and only the owner writes one", async (c) => {
    const { rec } = await c.meet({ chair: c.pD });
    const motion = await c.motion(rec, c.asA);
    c.script.onBallot = async (r) => ({ value: "yes", reason: `${r.agent} wants the earlier slot because the warm cache halves the run time` });
    await begin(c, motion);
    await untilBallots(c, motion, 1);
    await refuses("invalid_command", () => c.procedure.ownerMessage(c.owner, { commandId: cid("om"), recordId: rec, text: "A says: wants the earlier slot because the warm cache halves the run time. Agree?" }), (e) => { assert.equal(e.field, "acknowledged"); assert.match(e.message, /repeats the reason/); });
    const sent = await c.procedure.ownerMessage(c.owner, { commandId: cid("om"), recordId: rec, text: "A says: wants the earlier slot because the warm cache halves the run time. Agree?", acknowledged: true });
    assert.match(sent.warning!, /repeats the reason/);
    const plain = await c.procedure.ownerMessage(c.owner, { commandId: cid("om"), recordId: rec, text: "Please keep to the facts." });
    assert.equal(plain.warning, undefined);
    await refuses("forbidden", () => c.procedure.ownerMessage(c.asA, { commandId: cid("om"), recordId: rec, text: "I am the owner" }));
    await refuses("forbidden", () => c.procedure.ownerMessage(c.host, { commandId: cid("om"), recordId: rec, text: "I am the owner" }));
  });

  suite("an owner message that materially amends the motion starts a fresh round, a fresh check and a fresh vote; ballots on the old version do not count", async (c) => {
    const { rec } = await c.meet({ chair: c.pD });
    const motion = await c.motion(rec, c.asA);
    await begin(c, motion);
    await untilBallots(c, motion, 2);
    const before = c.script.comments.length;
    const out = await c.procedure.amend(c.owner, { commandId: cid("am"), motionId: motion, text: "Move the build to 02:00 instead.", material: true });
    assert.deepEqual([out.version, out.fresh], [2, true]);
    let state = await c.state(motion);
    assert.deepEqual([state.stage, state.round, state.rounds, state.fresh], ["comment", 1, 1, 1]);
    await c.pump(motion);
    assert.equal(c.script.comments.length - before, 3, "one fresh round");
    const beforeChecks = 3;
    void beforeChecks;
    assert.equal(c.script.objections.length, 6, "one fresh objection check after the first");
    state = await c.state(motion);
    const m = await motionBody(c, motion);
    assert.equal(m.version, 2);
    assert.equal(m.state, "adopted");
    assert.equal(c.script.ballots.length, 5, "the two old ballots were set aside; three on the new version");
    const note = (await c.records.summary(c.owner, rec))!.content.procedure![0]!;
    assert.equal(note.fresh, 1);
    // A non-material change does not restart anything.
    const { rec: rec2 } = await c.meet({ chair: c.pD });
    const second = await c.motion(rec2, c.asA);
    await begin(c, second);
    await c.procedure.advance(c.host, { motionId: second });
    const small = await c.procedure.amend(c.owner, { commandId: cid("am"), motionId: second, text: `${text} (typo fixed)`, material: false });
    assert.equal(small.fresh, false);
    assert.equal((await c.state(second)).stage, "comment");
  });

  suite("a tie goes to the chair's casting vote (no double vote); with no chair able to cast it the tie fails", async (c) => {
    const { rec } = await c.meet({ roster: [c.pA, c.pB], chair: c.pD });
    const motion = await c.motion(rec, c.asA);
    c.script.onBallot = async (r) => ({ value: r.agent === c.pA ? "yes" : "no", reason: `${r.agent} has a view` });
    c.withChair = true;
    c.procedure = c.reopen();
    await begin(c, motion);
    const first = await c.pump(motion);
    assert.equal(first.waiting!.on, "chair", "a tie waits for the chair's casting vote");
    c.script.onCasting = async () => ({ value: "yes", reason: "the earlier slot is better" });
    const done = await c.pump(motion);
    assert.equal(done.done, true, done.did);
    const decision = (await c.records.decision(c.owner, (await motionBody(c, motion)).decisionId!)) as unknown as { outcome: string; tie?: { how: string } };
    assert.equal(decision.outcome, "adopted");
    assert.equal(decision.tie?.how, "casting-vote");
    // No chair able to answer: the tie fails when its time is up.
    const { rec: rec2 } = await c.meet({ roster: [c.pA, c.pB], chair: c.pD });
    const second = await c.motion(rec2, c.asA);
    c.script.onCasting = async () => undefined;
    await begin(c, second);
    const waiting = await c.pump(second);
    assert.equal(waiting.waiting!.on, "chair");
    minutes(60);
    await c.records.sweep(c.host, { projectId: c.project });
    const swept = await c.procedure.advance(c.host, { motionId: second });
    assert.equal(swept.done, true);
    assert.equal((await motionBody(c, second)).state, "failed");
  });

  suite("a held vote waits for the owner: nothing is asked, no ballot is cast, and the vote goes on where it stopped", async (c) => {
    const { rec } = await c.meet({ chair: c.pD });
    const motion = await c.motion(rec, c.asA);
    await begin(c, motion);
    await untilBallots(c, motion, 1);
    await c.records.hold(c.owner, { commandId: cid("h"), motionId: motion });
    const held = await c.procedure.advance(c.host, { motionId: motion });
    assert.equal(held.waiting!.on, "owner");
    assert.equal(c.script.ballots.length, 1);
    await c.records.resume(c.owner, { commandId: cid("r"), motionId: motion });
    const done = await c.pump(motion);
    assert.equal(done.done, true);
    assert.equal(c.script.ballots.length, 3);
  });

  suite("a restart resumes where the procedure stopped: nobody is asked twice", async (c) => {
    const { rec } = await c.meet();
    const motion = await c.motion(rec, c.asA);
    await begin(c, motion);
    for (let i = 0; i < 4; i++) await c.procedure.advance(c.host, { motionId: motion });
    const asked = c.script.comments.length;
    c.procedure = c.reopen();
    const done = await c.pump(motion);
    assert.equal(done.done, true);
    assert.equal(c.script.comments.length, 6, `six turns in all, not ${asked + 6}`);
    assert.equal(new Set(c.script.comments.map((r) => `${r.round}:${r.agent}`)).size, 6);
    assert.equal((await statements(c, rec)).filter((e) => e.kind === "statement" && !/Objection/.test(e.text)).length, 6);
  });

  suite("only the controller drives the procedure; members, readers and outsiders cannot move it, begin it or read its votes", async (c) => {
    const { rec } = await c.meet({ chair: c.pD });
    const motion = await c.motion(rec, c.asA);
    await refuses("forbidden", () => c.procedure.begin(c.asA, { commandId: cid("pb"), motionId: motion }));
    await refuses("forbidden", () => c.procedure.begin(c.outsider, { commandId: cid("pb"), motionId: motion }));
    await refuses("invalid_command", () => c.procedure.begin(c.host, { commandId: cid("pb"), motionId: motion, actor: "owner:rob" } as never));
    await begin(c, motion);
    await refuses("invalid_command", () => begin(c, motion), (e) => assert.match(e.message, /already has a procedure/));
    for (const who of [c.asA, c.asD, c.mgr, c.outsider]) await refuses("forbidden", () => c.procedure.advance(who, { motionId: motion }));
    // At the objection check and during the vote too, where a step writes nothing on a member's behalf: a member still cannot move it.
    for (let i = 0; i < 40 && (await c.state(motion)).stage === "comment"; i++) await c.procedure.advance(c.host, { motionId: motion });
    assert.equal((await c.state(motion)).stage, "check");
    const atCheck = (await c.procedure.status(c.owner, motion))!["revision"];
    for (const who of [c.asA, c.asD, c.mgr, c.outsider, { ...c.host, taskScope: { taskId: "task-x", projectId: c.project } } as Principal]) await refuses("forbidden", () => c.procedure.advance(who, { motionId: motion }));
    await refuses("forbidden", () => c.procedure.run(c.asD, { motionId: motion }));
    assert.equal((await c.procedure.status(c.owner, motion))!["revision"], atCheck, "nothing moved");
    await untilBallots(c, motion, 2);
    for (const who of [c.asA, c.asD, c.mgr]) await refuses("forbidden", () => c.procedure.advance(who, { motionId: motion }));
    assert.equal(c.script.ballots.length, 2, "no ballot was asked for by a member");
    // The owner sees who has voted; the chair (usually a voter too) and a member see the stage but not the vote's progress; outsiders see nothing.
    const owner = (await c.procedure.status(c.owner, motion))!;
    assert.equal((owner["voteAsked"] as string[]).length, 2);
    const chair = (await c.procedure.status(c.asD, motion))!;
    assert.equal(chair["stage"], "voting");
    for (const key of ["voteAsked", "ballotSeq", "noBallot", "offers", "offersCapped", "stances", "echo"]) assert.equal(key in chair, false, `the chair does not see ${key}`);
    const member = (await c.procedure.status(c.asC, motion))!;
    assert.equal(member["stage"], "voting");
    for (const key of ["voteAsked", "ballotSeq", "noBallot", "offers", "offersCapped", "stances", "echo"]) assert.equal(key in member, false, `a member does not see ${key}`);
    // A task credential of another project is not the chair: it may neither begin nor rule.
    const elsewhere = { ...c.asD, taskScope: { taskId: "task-x", projectId: "proj-elsewhere" } } as Principal;
    const { rec: rec2 } = await c.meet({ chair: c.pD });
    await refuses("forbidden", () => c.procedure.begin(elsewhere, { commandId: cid("pb"), motionId: motion }));
    void rec2;
    assert.equal(await c.procedure.status(c.outsider, motion), undefined);
    // Credential-shaped text never lands in a record.
    c.script.onComment = async () => ({ text: "the token is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH" });
  });

  suite("a motion cannot be put to a vote around the procedure by anyone but the owner; the owner's own order is the owner's ruling", async (c) => {
    const { rec } = await c.meet({ chair: c.pD });
    const motion = await c.motion(rec, c.asA);
    await begin(c, motion);
    await refuses("invalid_command", () => c.records.openVote(c.asD, { commandId: cid("ov"), motionId: motion, expectedVersion: 1 }), (e) => assert.match(e.message, /comment stage/));
    await c.records.openVote(c.owner, { commandId: cid("ov"), motionId: motion, expectedVersion: 1 });
    const step = await c.procedure.advance(c.host, { motionId: motion });
    assert.ok(step.stage === "comment" || step.stage === "voting");
  });

  suite("a motion without a procedure votes as before: the record's rules are untouched", async (c) => {
    const { rec } = await c.meet({ chair: c.pD });
    const motion = await c.motion(rec, c.asA);
    await c.records.openVote(c.asD, { commandId: cid("ov"), motionId: motion, expectedVersion: 1 });
    for (const p of [c.asA, c.asB]) await c.records.castBallot(p, { commandId: cid("b"), motionId: motion, version: 1, value: "yes", reason: "fine" });
    minutes(11);
    await c.records.closeVote(c.owner, { commandId: cid("cl"), motionId: motion });
    assert.equal((await motionBody(c, motion)).state, "adopted");
    assert.equal((await c.records.summary(c.owner, rec))!.content.procedure, undefined);
  });

  suite("seating prefers members of different model families, then different information; the owner can switch it off", async (c) => {
    c.traits.set(c.pA, { family: "gpt" }); c.traits.set(c.pB, { family: "gpt" }); c.traits.set(c.pC, { family: "qwen" }); c.traits.set(c.pD, { family: "qwen" }); c.traits.set(c.pE, { family: "glm" });
    const { rec } = await c.meet({ roster: [c.pA, c.pB, c.pC, c.pD, c.pE] });
    const motion = await c.motion(rec, c.asA);
    await begin(c, motion);
    const seats = (await c.state(motion)).seats;
    const family = (a: string): string => c.traits.get(a)!.family!;
    for (let i = 1; i < seats.length; i++) assert.notEqual(family(seats[i]!), family(seats[i - 1]!), "no two neighbours share a family");
    assert.equal(new Set(seats).size, 5);
    c.settings.seating = "listed";
    const { rec: rec2 } = await c.meet({ roster: [c.pA, c.pB, c.pC, c.pD, c.pE] });
    const second = await c.motion(rec2, c.asA);
    await begin(c, second);
    assert.deepEqual((await c.state(second)).seats, (await recordOf(c, rec2)).roster);
  });

  suite("a meeting where every first-round stance and every ballot was the same is flagged as an echo in its summary; the flag can be switched off; a split is not flagged", async (c) => {
    const { rec } = await c.meet();
    const motion = await c.motion(rec, c.asA);
    await begin(c, motion);
    await c.pump(motion);
    assert.equal((await c.records.summary(c.owner, rec))!.content.procedure![0]!.echo, true);
    // A split in the first round is not an echo.
    const { rec: rec2 } = await c.meet();
    const second = await c.motion(rec2, c.asA);
    c.script.onComment = async (r) => ({ text: `${r.agent} speaks`, stance: r.agent === c.pB ? "against" : "for" });
    await begin(c, second);
    await c.pump(second);
    assert.equal((await c.records.summary(c.owner, rec2))!.content.procedure![0]!.echo, false);
    // Off: nothing is flagged.
    c.settings.echoFlag = false;
    c.script.onComment = async (r) => ({ text: `${r.agent} speaks`, stance: "for" });
    const { rec: rec3 } = await c.meet();
    const third = await c.motion(rec3, c.asA);
    await begin(c, third);
    await c.pump(third);
    assert.equal((await c.records.summary(c.owner, rec3))!.content.procedure![0]!.echo, false);
  });

  suite("a model chair rules by itself when it is wired; without one the owner's command is the way, and the owner's controls list what waits", async (c) => {
    c.withChair = true;
    c.procedure = c.reopen();
    const { rec } = await c.meet({ chair: c.pD });
    const motion = await c.motion(rec, c.asA);
    c.script.onObjection = async (r) => (r.agent === c.pB ? { answer: "objection", reason: "timing" } : { answer: "none" });
    await begin(c, motion);
    const held = await c.pump(motion);
    assert.equal(held.waiting!.on, "chair");
    let controls = await c.procedure.ownerControls(c.owner);
    assert.deepEqual(controls.rulings.map((r) => r.motionId), [motion]);
    assert.deepEqual(await c.procedure.ownerControls(c.asA), { rulings: [], tabled: [] });
    c.script.onRule = async () => ({ ruling: "proceed", text: "Noted." });
    const done = await c.pump(motion);
    assert.equal(done.done, true, done.did);
    controls = await c.procedure.ownerControls(c.owner);
    assert.deepEqual(controls.rulings, []);
  });

  suite("a member's reply that holds a credential is refused and counts as no answer; nothing secret reaches the record", async (c) => {
    const { rec } = await c.meet();
    const motion = await c.motion(rec, c.asA);
    c.script.onComment = async (r) => (r.agent === c.pA ? { text: "my key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH" } : { text: `${r.agent} speaks`, stance: "for" });
    await begin(c, motion);
    await c.pump(motion);
    assert.equal(JSON.stringify(await statements(c, rec)).includes("sk-ant"), false);
    assert.ok((await c.state(motion)).skipped.some((s) => s.agent === c.pA && s.reason === "no answer"));
  });

  suite("without a wired floor the procedure waits and asks nobody", async (c) => {
    const { rec } = await c.meet();
    const motion = await c.motion(rec, c.asA);
    const bare = c.bare();
    await bare.begin(c.host, { commandId: cid("pb"), motionId: motion });
    const step = await bare.advance(c.host, { motionId: motion });
    assert.equal(step.waiting!.on, "nobody");
    assert.equal(c.script.comments.length, 0);
  });

  suite("review M06: while a vote is open nobody learns from the summary or the chair's view who has or has not voted; it is told once the vote is over", async (c) => {
    const { rec } = await c.meet({ chair: c.pD });
    const motion = await c.motion(rec, c.asA);
    // The first seated member gives no ballot.
    let first: string | undefined;
    c.script.onBallot = async (r) => { first ??= r.agent; return r.agent === first ? undefined : { value: "yes", reason: `${r.agent} agrees with the slot` }; };
    await begin(c, motion);
    await untilBallots(c, motion, 2);
    await c.procedure.advance(c.host, { motionId: motion });
    assert.deepEqual((await c.state(motion)).noBallot, [first], "the owner's full view has it");
    for (const who of [c.owner, c.asA, c.asD]) {
      const note = (await c.records.summary(who, rec))!.content.procedure![0]!;
      assert.equal(note.noResponse.includes(first!), false, `the live summary does not tell ${who.id} who gave no ballot`);
    }
    assert.equal(JSON.stringify(await c.procedure.status(c.asD, motion)).includes("noBallot"), false);
    minutes(11);
    const done = await c.pump(motion);
    assert.equal(done.done, true, done.did);
    assert.ok((await c.records.summary(c.owner, rec))!.content.procedure![0]!.noResponse.includes(first!), "after the vote it is part of the record");
  });

  suite("review M06: an objection's reason or a stance that looks like a credential is not kept; control characters are folded", async (c) => {
    const { rec } = await c.meet({ chair: c.pD });
    const motion = await c.motion(rec, c.asA);
    const secret = ["sk-ant-api03", "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH"].join("-");
    c.script.onComment = async (r) => ({ text: `${r.agent} speaks`, stance: r.agent === c.pA ? secret : "for" });
    c.script.onObjection = async (r) => (r.agent === c.pB ? { answer: "objection", reason: `use ${secret}` } : r.agent === c.pC ? { answer: "objection", reason: "line one\u0000\u001b[31m\nline two" } : { answer: "none" });
    await begin(c, motion);
    const held = await c.pump(motion);
    assert.equal(held.stage, "ruling");
    const state = await c.state(motion);
    assert.equal(JSON.stringify(state).includes("sk-ant"), false, "nothing credential-shaped in the procedure's record");
    assert.equal(state.check.answers.find((a) => a.agent === c.pB)!.answer, "no-response");
    assert.equal(state.check.answers.find((a) => a.agent === c.pC)!.reason, "line one [31m line two");
    assert.equal(state.stances.some((s) => s.agent === c.pA), false);
    assert.equal(JSON.stringify(await statements(c, rec)).includes("sk-ant"), false);
    assert.equal(JSON.stringify((await c.records.summary(c.owner, rec))!.content).includes("sk-ant"), false);
  });

  suite("review M06: a model chair's ruling that the rules refuse holds the vote instead of failing every step; the owner can still rule", async (c) => {
    c.withChair = true;
    c.procedure = c.reopen();
    const { rec } = await c.meet({ chair: c.pD });
    const motion = await c.motion(rec, c.asA);
    c.script.onObjection = async (r) => (r.agent === c.pB ? { answer: "objection", reason: "the backup window" } : { answer: "none" });
    // An objection is not a request for research, so the chair may not table; and a ruling with unknown fields.
    c.script.onRule = async () => ({ ruling: "table", reason: "I would rather not", extra: "ignored" }) as never;
    await begin(c, motion);
    assert.equal((await c.pump(motion)).stage, "ruling");
    let asked = 0;
    c.script.onRule = async () => { asked++; return ({ ruling: "table", reason: "I would rather not", extra: "ignored" }) as never; };
    // The chair is asked at the next step, and asked again later: each time the refused ruling leaves the vote held.
    for (let i = 0; i < 2; i++) {
      const held = await c.pump(motion);
      assert.equal(held.stage, "ruling");
      assert.equal(held.waiting!.on, "chair");
    }
    assert.equal(asked, 2);
    assert.equal((await motionBody(c, motion)).state, "proposed", "nothing was tabled");
    c.script.onRule = async () => undefined;
    await rule(c, c.owner, motion, { ruling: "proceed" });
    assert.equal((await c.pump(motion)).done, true);
    assert.equal((await motionBody(c, motion)).state, "adopted");
  });

  suite("review M06: a material amendment made on the record itself during the vote starts the fresh pass; the procedure does not call the motion concluded", async (c) => {
    const { rec } = await c.meet({ chair: c.pD });
    const motion = await c.motion(rec, c.asA);
    await begin(c, motion);
    await untilBallots(c, motion, 2);
    await c.records.amend(c.asD, { commandId: cid("am"), motionId: motion, expectedVersion: 1, text: "Move the build to 02:00 instead.", material: true });
    assert.equal((await motionBody(c, motion)).state, "proposed");
    const step = await c.procedure.advance(c.host, { motionId: motion });
    assert.equal(step.done, false, step.did);
    const state = await c.state(motion);
    assert.deepEqual([state.stage, state.version, state.fresh, state.voteAsked.length], ["comment", 2, 1, 0]);
    const done = await c.pump(motion);
    assert.equal(done.done, true, done.did);
    const m = await motionBody(c, motion);
    assert.deepEqual([m.state, m.version], ["adopted", 2]);
    assert.equal(c.script.ballots.length, 5, "three fresh ballots on the new version");
  });

  suite("review M06: a tie whose casting time is over fails at the next step without waiting for a sweep; the chair is told only that it is tied", async (c) => {
    const { rec } = await c.meet({ roster: [c.pA, c.pB], chair: c.pD });
    const motion = await c.motion(rec, c.asA);
    c.script.onBallot = async (r) => ({ value: r.agent === c.pA ? "yes" : "no", reason: `${r.agent} has a view` });
    const asked: unknown[] = [];
    c.script.onCasting = async (r) => { asked.push(r); return undefined; };
    c.withChair = true;
    c.procedure = c.reopen();
    await begin(c, motion);
    assert.equal((await c.pump(motion)).waiting!.on, "chair");
    assert.equal(asked.length, 1);
    assert.equal(JSON.stringify(asked[0]).match(/"(yes|no)"/), null, "no counts in the casting request");
    minutes(60);
    const done = await c.procedure.advance(c.host, { motionId: motion });
    assert.equal(done.done, true, done.did);
    assert.equal((await motionBody(c, motion)).state, "failed");
    assert.equal((await c.state(motion)).stage, "concluded");
  });

  suite("review M06: crash windows: a revision turn answered before a restart and an upheld amendment made before a restart are not lost or repeated", async (c) => {
    const { rec } = await c.meet({ chair: c.pD });
    const motion = await c.motion(rec, c.asA);
    await begin(c, motion);
    await untilBallots(c, motion, 3);
    const said = await c.procedure.ownerMessage(c.owner, { commandId: cid("om"), recordId: rec, text: "Note that the backup job also runs at 01:00." });
    const procId = (await c.procedure.status(c.owner, motion))!["id"] as string;
    const first = c.script.ballots[0]!.agent;
    const asFirst = [c.asA, c.asB, c.asC].find((p) => p.id === first)!;
    // The revision was cast, then the controller stopped before saving its state.
    await c.records.castBallot(asFirst, { commandId: `mpr:${procId}:r:${first}:${said.seq}`, motionId: motion, version: 1, value: "no", reason: "the backup job collides", ownerMessageEntryId: `mte-${rec.slice(4)}-${said.seq}` });
    c.procedure = c.reopen();
    c.script.onRevision = async () => ({ value: "no", reason: "a different answer after the restart" });
    await c.procedure.advance(c.host, { motionId: motion });
    assert.deepEqual((await c.state(motion)).offers.map((o) => `${o.agent}:${o.outcome}`), [`${first}:revised`]);
    // An upheld amendment written before a restart: the same ruling again does not fail and does not amend twice.
    const { rec: rec2 } = await c.meet({ chair: c.pD });
    const second = await c.motion(rec2, c.asA);
    c.script.onObjection = async (r) => (r.agent === c.pB && r.run === 1 ? { answer: "objection", reason: "the backup window" } : { answer: "none" });
    await begin(c, second);
    await c.pump(second);
    const ruling = cid("ru");
    await c.records.amend(c.owner, { commandId: `${ruling}:amend`, motionId: second, expectedVersion: 1, text: "Move the build to 01:30 instead.", material: true });
    await c.procedure.rule(c.owner, { commandId: ruling, motionId: second, ruling: "uphold", addressed: "amend", text: "Move the build to 01:30 instead." } as never);
    const state = await c.state(second);
    assert.deepEqual([state.stage, state.version, state.check.run], ["check", 2, 2]);
    assert.equal((await motionBody(c, second)).version, 2, "amended once");
    assert.equal((await c.pump(second)).done, true);
  });

  suite("review M06: two controllers driving the same procedure at once write every statement and ballot once and finish it", async (c) => {
    const { rec } = await c.meet({ chair: c.pD });
    const motion = await c.motion(rec, c.asA);
    await begin(c, motion);
    const one = c.reopen();
    const two = c.reopen();
    const drive = async (p: typeof one): Promise<void> => {
      for (let i = 0; i < 200; i++) { const step = await p.advance(c.host, { motionId: motion }); if (step.done || step.waiting !== undefined) return; }
    };
    await Promise.all([drive(one), drive(two)]);
    await drive(one);
    const m = await motionBody(c, motion);
    assert.equal(m.state, "adopted");
    const said = (await statements(c, rec)).filter((e) => e.kind === "statement");
    assert.equal(said.length, 6, "two rounds of three, each once");
    const decision = (await c.records.decision(c.owner, m.decisionId!)) as unknown as { table: unknown[] };
    assert.equal(decision.table.length, 3);
    const state = await c.state(motion);
    assert.equal(new Set(state.voteAsked).size, state.voteAsked.length, "nobody is in the vote twice");
    assert.equal(state.stage, "concluded");
  });
}
