import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backendsNamed, stopServer } from "../domain/testing/backends.js";
import { BlockerService } from "../domain/blockers.js";
import { WaitService } from "../domain/waits.js";
import { StatusService } from "../status/index.js";
import { describe, proposalReason, acceptedArgs, CHAT_OPS, FLOOR_CONTROLS, MEETING_CONTROLS } from "./commands.js";
import { MeetingProcedureService, MeetingRecordService, taskUpdateApplier, type MeetingFloor, type ChairFloor } from "../meetings/index.js";
import type { Principal } from "../security/index.js";
import type { ChatService, Outcome } from "./index.js";
import { cid, openWorld, options } from "./testing/harness.js";

const cmd = (op: string, args: Record<string, unknown>, evidence: string) => ({ kind: "command", op, args, evidence, basis: "owner" });
const ask = (request: Record<string, unknown>, evidence: string) => ({ kind: "status", request, evidence, basis: "owner" });

/**
 * The chat controls of the one service that runs a motion (cards M05 and M06 together): starting the procedure, moving it a step, overruling a chair question's challenge, and asking where a motion stands or what a meeting waits on.
 * Changes are shown first and apply when the owner agrees; reads are answered at once. A stand-in floor records what it is asked, so what is tested here is the chat's own part: finding the right motion, meeting or question by the
 * owner's words and never by an ID the owner did not say. One backend per file.
 */
export function defineMeetingIntegrationChatTests(backendName: string): void {
  after(stopServer);
  for (const backend of backendsNamed(backendName)) {
    interface Room {
      procedure: MeetingProcedureService; records: MeetingRecordService; challenged: { id: string; to: string; topic: string; challenge: { by: string; reason: string; ruling?: string } }[]; floorCalls: Record<string, unknown>[];
      inquiries: { recordId: string; projectId: string; since: string; idleMinutes: number; questions: number }[]; waitingOn: Record<string, unknown>;
      comments: string[]; meeting(title: string): Promise<string>; motion(recordId: string, text: string): Promise<string>; status: StatusService;
    }
    const suite = (name: string, body: (w: Awaited<ReturnType<typeof openWorld>>, script: Record<string, unknown>, room: Room) => Promise<void>) =>
      test(`${backend.name}: ${name}`, async () => {
        const script: Record<string, unknown> = {};
        const holder: { r?: MeetingRecordService; p?: MeetingProcedureService; s?: StatusService } = {};
        const lazy = <T extends object>(get: () => T | undefined): T => new Proxy({}, { get: (_t, k) => async (...a: unknown[]) => (get() as unknown as Record<string, (...x: unknown[]) => Promise<unknown>>)[k as string]!(...a) }) as T;
        const challenged: Room["challenged"] = [];
        const floorCalls: Room["floorCalls"] = [];
        const inquiries: Room["inquiries"] = [];
        const waitingOn: Record<string, unknown> = { kind: "person", who: "owner", what: "the owner's questions (inquiry open)", since: "2026-10-22T10:00:00.000Z" };
        const comments: string[] = [];
        // what the floor of a meeting shows and does, as far as the chat reaches it
        const floorStub = {
          state: async () => ({ chairQuestions: challenged }),
          ruleOnChallenge: async (_by: Principal, c: Record<string, unknown>) => { floorCalls.push(c); },
          endInquiry: async (_by: Principal, c: Record<string, unknown>) => { floorCalls.push({ op: "inquiry-end", ...c }); },
          waiting: async () => waitingOn,
          openInquiries: async () => ({ items: inquiries, truncated: false }),
        };
        const w = await openWorld(backend, script, undefined, (storage, epoch, built) => {
          const blockers = BlockerService.withEpoch(storage, epoch, options);
          holder.s = StatusService.withEpoch(storage, epoch, {
            assignments: built.assignments, waits: WaitService.withEpoch(storage, epoch, built.assignments, options), blockers, contracts: built.contracts,
            meetingInquiries: async () => ({ items: inquiries, truncated: false }),
            meetingProcedure: async (v, motionId) => holder.p!.status(v, motionId),
            meetingWaiting: async (v, recordId) => { const x = await floorStub.waiting(); return recordId === "" || v === undefined ? undefined : { waiting: x }; },
          }, options);
          return { records: lazy(() => holder.r), procedure: lazy(() => holder.p), floor: floorStub as never, status: holder.s, needsYouAnswers: { blockers } };
        });
        const people = new Map<string, Principal>();
        const members: MeetingFloor & ChairFloor = {
          comment: async (r) => { comments.push(r.agent); return { text: `${r.agent} comments`, stance: "for" }; },
          objection: async () => ({ answer: "none" }),
          ballot: async () => ({ value: "yes", reason: "the plan keeps the cache warm overnight" }),
          revision: async () => ({ keep: true }),
          rule: async () => undefined,
          castingVote: async () => undefined,
        };
        holder.r = MeetingRecordService.withEpoch(w.world.storage, w.projects.epoch, { meetings: w.meetings, decisions: w.decisions }, { ...options, appliers: { "task.update": taskUpdateApplier(w.projects) }, shareable: async () => false });
        holder.p = MeetingProcedureService.withEpoch(w.world.storage, w.projects.epoch, holder.r, { ...options, floor: members, chair: members, actAs: async (a) => people.get(a), settings: async () => ({ rounds: 1 }) });
        const project = await w.project("A");
        const mgr = await w.agent("mgr", [{ action: "meeting.manage", project: "*" }]);
        const grantsOf = [{ action: "task.read", project: "*" }, { action: "meeting.attend", project: "*" }];
        const crew = [await w.agent("ann", grantsOf), await w.agent("bob", grantsOf), await w.agent("cyd", grantsOf)];
        for (const c of crew) people.set(c.principal.id, c.principal);
        const room: Room = {
          procedure: holder.p, records: holder.r, challenged, floorCalls, inquiries, waitingOn, comments, status: holder.s!,
          meeting: async (title) => {
            const occ = (await w.meetings.callUrgent(mgr.principal, { commandId: cid("urg"), projectId: project, title, reason: "decide", roster: crew.map((c) => c.principal.id) })).id;
            const rec = (await holder.r!.open(mgr.principal, { commandId: cid("open"), occurrenceId: occ, chair: crew[2]!.principal.id })).id;
            for (const c of crew) await holder.r!.join(c.principal, { commandId: cid("j"), recordId: rec });
            return rec;
          },
          motion: async (recordId, text) => (await holder.r!.move(crew[0]!.principal, { commandId: cid("mv"), recordId, text })).id,
        };
        try { await body(w, script, room); } finally { await w.close(); }
      });
    const say = (w: { ownerToken: string }, chat: ChatService, text: string) => chat.submit(w.ownerToken, { messageId: cid("m"), text });
    const only = (outcomes: readonly Outcome[]): Outcome => { assert.equal(outcomes.length, 1, JSON.stringify(outcomes)); return outcomes[0]!; };
    const stageOf = async (room: Room, w: { owner: Principal }, motionId: string): Promise<string | undefined> => ((await room.procedure.status(w.owner, motionId)) as { stage?: string } | undefined)?.stage;

    suite("the owner starts a motion's procedure and moves it a step by its words: each is shown first and nothing starts before the owner agrees", async (w, script, room) => {
      const rec = await room.meeting("Build sync");
      const motion = await room.motion(rec, "Move the nightly build to one in the morning.");
      const other = await room.motion(rec, "Retire the old staging server on Friday.");
      const chat = w.chat();
      assert.equal(await stageOf(room, w, motion), undefined, "the motion was moved and nobody started its procedure");
      script["Start the procedure for the nightly build motion."] = [cmd("meeting.proc.begin", { motionTopic: "nightly build" }, "start the procedure for the nightly build motion")];
      const shown = only((await say(w, chat, "Start the procedure for the nightly build motion.")).outcomes);
      assert.equal(shown.status, "proposed", JSON.stringify(shown));
      assert.match(String(shown.preview), /Start the procedure for a motion/);
      assert.equal(await stageOf(room, w, motion), undefined, "the message that drew it up started nothing");
      await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: shown.proposalId! });
      assert.equal(await stageOf(room, w, motion), "comment");
      assert.equal(await stageOf(room, w, other), undefined, "the other motion is untouched");
      // one step: one member's statement
      script["Take the next step on the nightly build."] = [cmd("meeting.proc.advance", { motionTopic: "nightly build" }, "take the next step on the nightly build")];
      const step = only((await say(w, chat, "Take the next step on the nightly build.")).outcomes);
      assert.equal(step.status, "proposed", JSON.stringify(step));
      assert.equal(room.comments.length, 0, "no member was asked before the owner agreed");
      await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: step.proposalId! });
      assert.equal(room.comments.length, 1, "one step asked one member");
      // words that fit no motion are refused; an ID the owner never said is not taken when two motions fit
      script["Start the procedure for the parking motion."] = [cmd("meeting.proc.begin", { motionTopic: "parking lot" }, "start the procedure for the parking motion")];
      assert.equal(only((await say(w, chat, "Start the procedure for the parking motion.")).outcomes).status, "refused");
      script["Start a procedure."] = [cmd("meeting.proc.begin", { motionId: other }, "start a procedure")];
      assert.equal(only((await say(w, chat, "Start a procedure.")).outcomes).status, "asked", "an ID the owner never said is not taken: two motions are waiting to start, so the owner is asked");
    });

    suite("the owner overrules or upholds a challenge to a chair question in words: the challenged question is found in the meeting, several ask which, and nothing is decided before the owner agrees", async (w, script, room) => {
      const rec = await room.meeting("Planning sync");
      room.challenged.push({ id: "cq1", to: "agent:ann", topic: "the cache hit rate", challenge: { by: "agent:bob", reason: "this seeks a position" } });
      const chat = w.chat();
      script["Let the chair ask the cache question anyway in the planning sync."] = [cmd("meeting.floor.cq-rule", { meetingTopic: "planning sync", ruling: "dismissed" }, "let the chair ask the cache question anyway in the planning sync")];
      const shown = only((await say(w, chat, "Let the chair ask the cache question anyway in the planning sync.")).outcomes);
      assert.equal(shown.status, "proposed", JSON.stringify(shown));
      assert.match(String(shown.preview), /Rule on a challenged chair question/);
      assert.deepEqual(room.floorCalls, [], "nothing was decided before the owner agreed");
      await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: shown.proposalId! });
      assert.equal(room.floorCalls.length, 1);
      assert.deepEqual([room.floorCalls[0]!["recordId"], room.floorCalls[0]!["questionId"], room.floorCalls[0]!["ruling"]], [rec, "cq1", "dismissed"]);
      // two challenged questions: the words pick one, else the owner is asked
      room.challenged.push({ id: "cq2", to: "agent:cyd", topic: "last week's build time", challenge: { by: "agent:ann", reason: "leading" } });
      script["Drop that chair question in the planning sync."] = [cmd("meeting.floor.cq-rule", { meetingTopic: "planning sync", ruling: "upheld" }, "drop that chair question in the planning sync")];
      const unclear = only((await say(w, chat, "Drop that chair question in the planning sync.")).outcomes);
      assert.equal(unclear.status, "asked", JSON.stringify(unclear));
      script["Drop the build time chair question in the planning sync."] = [cmd("meeting.floor.cq-rule", { meetingTopic: "planning sync", ruling: "upheld" }, "drop the build time chair question in the planning sync")];
      const picked = only((await say(w, chat, "Drop the build time chair question in the planning sync.")).outcomes);
      assert.equal(picked.status, "proposed", JSON.stringify(picked));
      // a meeting with nothing challenged has nothing to rule on
      room.challenged.length = 0;
      assert.equal(only((await say(w, chat, "Drop the build time chair question in the planning sync.")).outcomes).status, "refused");
    });

    suite("the owner asks where a motion stands and what a meeting waits on, and the answer comes at once from the records, citing them, with nothing written", async (w, script, room) => {
      const rec = await room.meeting("Build sync");
      const motion = await room.motion(rec, "Move the nightly build to one in the morning.");
      await room.procedure.begin(w.owner, { commandId: cid("pb"), motionId: motion });
      const chat = w.chat({ status: room.status });
      const audit = async () => (await w.world.storage.listAudit({ afterSeq: 0, limit: 1000 })).filter((x) => !x.type.startsWith("chat.")).length;
      const before = await audit();
      const q1 = "Where does the nightly build motion stand?";
      script[q1] = [ask({ kind: "meeting_procedure", motionTopic: "nightly build" }, q1)];
      const a1 = only((await say(w, chat, q1)).outcomes);
      assert.equal(a1.status, "answered", JSON.stringify(a1));
      assert.ok(a1.lines!.every((l) => l.cites.length > 0), "every line cites a record");
      assert.match(a1.lines!.map((l) => l.text).join("\n"), /comment stage, round 1/);
      const q2 = "What is the build sync waiting on?";
      script[q2] = [ask({ kind: "meeting_waiting", meetingTopic: "build sync" }, q2)];
      const a2 = only((await say(w, chat, q2)).outcomes);
      assert.equal(a2.status, "answered", JSON.stringify(a2));
      assert.match(a2.lines!.map((l) => l.text).join("\n"), /waits on you/);
      room.waitingOn["kind"] = "agent"; room.waitingOn["who"] = "agent:bob"; room.waitingOn["what"] = "statement";
      const a3 = only((await say(w, chat, q2)).outcomes);
      assert.match(a3.lines!.map((l) => l.text).join("\n"), /waits on agent:bob: statement/);
      // a motion no words fit is not guessed at
      const q3 = "Where does the parking motion stand?";
      script[q3] = [ask({ kind: "meeting_procedure", motionTopic: "parking lot" }, q3)];
      assert.equal(only((await say(w, chat, q3)).outcomes).status, "refused");
      assert.equal(await audit(), before, "nothing was written");
    });

    suite("an open inquiry is on the Needs-you list and the owner ends it there with a word: the meeting goes on and the item leaves", async (w, script, room) => {
      const rec = await room.meeting("Build sync");
      room.inquiries.push({ recordId: rec, projectId: "proj-a", since: "2026-10-22T09:00:00.000Z", idleMinutes: 12, questions: 3 });
      const list = async (): Promise<{ kind: string; id: string; text: string; answer: { kind: string; choices?: string[] } }[]> => {
        const r = await w.api.handle(w.ownerToken, { v: 1, op: "status.ask", args: { request: { kind: "needs_you", limit: 50 } } } as never) as unknown as { ok: boolean; result: { item: { items: never[] } } };
        assert.ok(r.ok, JSON.stringify(r));
        return r.result.item.items as never;
      };
      const items = (await list()).filter((i) => i.kind === "meeting-inquiry");
      assert.equal(items.length, 1);
      assert.match(items[0]!.text, /inquiry in a meeting is open \(3 questions so far, idle 12 minutes\)/);
      assert.deepEqual(items[0]!.answer, { kind: "choice", choices: ["done"] });
      const chat = w.chat();
      script["I am done with my inquiry in the build sync"] = [cmd("needs-you.answer", { itemTopic: "inquiry", answer: "done" }, "I am done with my inquiry in the build sync")];
      const shown = only((await say(w, chat, "I am done with my inquiry in the build sync")).outcomes);
      assert.equal(shown.status, "proposed", JSON.stringify(shown));
      assert.deepEqual(room.floorCalls, [], "nothing ended before the owner agreed");
      await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: shown.proposalId! });
      assert.equal(room.floorCalls.length, 1);
      assert.equal(room.floorCalls[0]!["recordId"], rec);
      assert.equal(room.floorCalls[0]!["op"], "inquiry-end");
      // only the owner may answer there
      const crewToken = (await w.agent("late", [{ action: "task.read", project: "*" }])).token;
      const refused = await w.api.handle(crewToken, { v: 1, op: "needs-you.answer", commandId: cid("c"), args: { kind: "meeting-inquiry", id: rec, answer: "done" } } as never) as { ok: boolean };
      assert.equal(refused.ok, false);
    });

    suite("the new controls are the owner's alone, always shown first, and the interpreter is told how to use them", async (w, _script, room) => {
      for (const op of ["meeting.proc.begin", "meeting.proc.advance", "meeting.floor.cq-rule"]) {
        assert.equal(CHAT_OPS[op]?.mode, "propose", `${op} is shown first`);
        assert.ok(MEETING_CONTROLS.has(op), `${op} is found by the owner's words`);
        assert.ok(acceptedArgs(op) !== undefined, `${op} is a chat command`);
        assert.doesNotMatch(String(proposalReason(op, {}, false, { profile: "derived", said: true, quoted: false })), /capabilities/, `${op} has its own reason`);
        assert.ok(describe(op, { motionId: "mmo-x", recordId: "mrc-x", questionId: "cq1", ruling: "dismissed" }, {}).length > 10);
      }
      assert.ok(FLOOR_CONTROLS.has("meeting.floor.cq-rule"));
      assert.ok(acceptedArgs("meeting.proc.begin")!.includes("motionTopic") && acceptedArgs("meeting.floor.cq-rule")!.includes("meetingTopic"));
      const rec = await room.meeting("Build sync");
      const motion = await room.motion(rec, "Move the nightly build.");
      const member = (await w.agent("dee", [{ action: "task.read", project: "*" }])).token;
      // (the floor's own check that only the owner or the chair may rule is tested with the real floor)
      for (const [op, args] of [["meeting.proc.begin", { motionId: motion }]] as const) {
        const res = await w.api.handle(member, { v: 1, op, commandId: cid("c"), args } as never) as { ok: boolean };
        assert.equal(res.ok, false, `${op} is refused for a member`);
      }
    });
  }
}
