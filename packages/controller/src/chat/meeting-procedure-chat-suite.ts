import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backendsNamed, stopServer } from "../domain/testing/backends.js";
import { describe, proposalReason, acceptedArgs, CHAT_OPS } from "./commands.js";
import { MeetingProcedureService, MeetingRecordService, taskUpdateApplier, type MeetingFloor, type ChairFloor } from "../meetings/index.js";
import type { Principal } from "../security/index.js";
import type { ChatService, Outcome } from "./index.js";
import { cid, openWorld, options } from "./testing/harness.js";

const cmd = (op: string, args: Record<string, unknown>, evidence: string) => ({ kind: "command", op, args, evidence, basis: "owner" });
const RULE = "meeting.proc.rule";
const UNTABLE = "meeting.proc.untable";
const SAY = "meeting.proc.owner-message";

/** The owner's controls of the meeting procedure by chat (card M06): rulings, overruling a tabling and writing to a meeting, each found by the owner's words and shown first. One backend per file. */
export function defineMeetingProcedureChatTests(backendName: string): void {
  after(stopServer);
  for (const backend of backendsNamed(backendName)) {
    const suite = (name: string, body: (w: Awaited<ReturnType<typeof openWorld>>, script: Record<string, unknown>, room: Room) => Promise<void>) =>
      test(`${backend.name}: ${name}`, async () => {
        const script: Record<string, unknown> = {};
        const holder: { r?: MeetingRecordService; p?: MeetingProcedureService } = {};
        const lazy = <T extends object>(get: () => T | undefined): T => new Proxy({}, { get: (_t, k) => async (...a: unknown[]) => (get() as unknown as Record<string, (...x: unknown[]) => Promise<unknown>>)[k as string]!(...a) }) as T;
        const w = await openWorld(backend, script, undefined, { records: lazy(() => holder.r), procedure: lazy(() => holder.p) });
        const people = new Map<string, Principal>();
        const scripted: { objection: (agent: string) => { answer: "none" | "objection" | "research"; reason?: string }; ballots: string[] } = { objection: () => ({ answer: "none" }), ballots: [] };
        const floor: MeetingFloor & ChairFloor = {
          comment: async (r) => ({ text: `${r.agent} comments`, stance: "for" }),
          objection: async (r) => scripted.objection(r.agent),
          ballot: async (r) => { const reason = `${r.agent} wants the earlier slot because the warm cache halves the run time`; scripted.ballots.push(reason); return { value: "yes", reason }; },
          revision: async () => ({ keep: true }),
          rule: async () => undefined,
          castingVote: async () => undefined,
        };
        holder.r = MeetingRecordService.withEpoch(w.world.storage, w.projects.epoch, { meetings: w.meetings, decisions: w.decisions }, { ...options, appliers: { "task.update": taskUpdateApplier(w.projects) }, shareable: async () => false });
        holder.p = MeetingProcedureService.withEpoch(w.world.storage, w.projects.epoch, holder.r, { ...options, floor, chair: floor, actAs: async (a) => people.get(a), settings: async () => ({ rounds: 1 }) });
        const project = await w.project("A");
        const mgr = await w.agent("mgr", [{ action: "meeting.manage", project: "*" }]);
        const grantsOf = [{ action: "task.read", project: "*" }, { action: "meeting.attend", project: "*" }];
        const crew = [await w.agent("ann", grantsOf), await w.agent("bob", grantsOf), await w.agent("cyd", grantsOf)];
        for (const c of crew) people.set(c.principal.id, c.principal);
        const room: Room = {
          scripted, procedure: holder.p, records: holder.r, project, agentToken: crew[0]!.token,
          meeting: async (title) => {
            const occ = (await w.meetings.callUrgent(mgr.principal, { commandId: cid("urg"), projectId: project, title, reason: "decide", roster: crew.map((c) => c.principal.id) })).id;
            const rec = (await holder.r!.open(mgr.principal, { commandId: cid("open"), occurrenceId: occ, chair: crew[2]!.principal.id })).id;
            for (const c of crew) await holder.r!.join(c.principal, { commandId: cid("j"), recordId: rec });
            return rec;
          },
          motion: async (recordId, text) => (await holder.r!.move(crew[0]!.principal, { commandId: cid("mv"), recordId, text })).id,
          run: async (motionId) => holder.p!.run(w.owner, { motionId }),
          state: async (motionId) => String((await holder.r!.motion(w.owner, motionId))!.state),
          stage: async (motionId) => String(((await holder.p!.status(w.owner, motionId)) as { stage: string }).stage),
        };
        try { await body(w, script, room); } finally { await w.close(); }
      });
    interface Room {
      scripted: { objection: (agent: string) => { answer: "none" | "objection" | "research"; reason?: string }; ballots: string[] };
      procedure: MeetingProcedureService; records: MeetingRecordService; project: string; agentToken: string;
      meeting(title: string): Promise<string>; motion(recordId: string, text: string): Promise<string>;
      run(motionId: string): Promise<{ stage: string; waiting?: { on: string } }>; state(motionId: string): Promise<string>; stage(motionId: string): Promise<string>;
    }
    const say = (w: { ownerToken: string }, chat: ChatService, text: string) => chat.submit(w.ownerToken, { messageId: cid("m"), text });
    const only = (outcomes: readonly Outcome[]): Outcome => { assert.equal(outcomes.length, 1); return outcomes[0]!; };
    const call = async (w: { api: { handle: (t: string, r: never) => Promise<unknown> } }, token: string, op: string, args: Record<string, unknown>) => w.api.handle(token, { v: 1, op, args } as never) as Promise<any>;

    suite("the owner rules on an objection by its words: shown first, nothing changes until confirmed, the objection becomes dissent and the vote can open", async (w, script, room) => {
      const rec = await room.meeting("Infrastructure sync");
      const motion = await room.motion(rec, "Move the nightly build to one in the morning.");
      const other = await room.motion(rec, "Retire the old staging server on Friday.");
      room.scripted.objection = (a) => (a.endsWith("bob") ? { answer: "objection", reason: "the backup window overlaps" } : { answer: "none" });
      await room.procedure.begin(w.owner, { commandId: cid("pb"), motionId: motion });
      await room.procedure.begin(w.owner, { commandId: cid("pb"), motionId: other });
      assert.equal((await room.run(motion)).stage, "ruling");
      assert.equal((await room.run(other)).stage, "ruling");
      const chat = w.chat();
      // Two motions wait for a ruling: the words pick one; an ID the owner never said is not taken.
      script["Go ahead with the nightly build despite the objection."] = [cmd(RULE, { motionTopic: "nightly build", ruling: "proceed" }, "go ahead with the nightly build despite the objection")];
      const proposed = only((await say(w, chat, "Go ahead with the nightly build despite the objection.")).outcomes);
      assert.equal(proposed.status, "proposed", JSON.stringify(proposed));
      assert.match(String(proposed.preview), /Rule on the objections to a motion/);
      assert.equal(await room.stage(motion), "ruling", "nothing changed before the owner confirms");
      const body = (await chat.getProposal(w.ownerToken, proposed.proposalId!))!;
      assert.match(body.reason, /decides whether the vote is held/);
      await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: proposed.proposalId! });
      assert.equal(await room.stage(motion), "ready");
      assert.equal(await room.stage(other), "ruling", "the other motion is untouched");
      assert.deepEqual(((await room.procedure.status(w.owner, motion)) as { dissent: { agent: string }[] }).dissent.length, 1);
      script["Rule on it."] = [cmd(RULE, { motionId: other, ruling: "proceed" }, "rule on it")];
      const guessed = only((await say(w, chat, "Rule on it.")).outcomes);
      assert.equal(guessed.status, "proposed", "the only motion left waiting is the one meant");
      script["Go ahead with the parking motion."] = [cmd(RULE, { motionTopic: "parking lot", ruling: "proceed" }, "go ahead with the parking motion")];
      assert.equal(only((await say(w, chat, "Go ahead with the parking motion.")).outcomes).status, "refused");
    });

    suite("the owner tables a motion in words and later overrules the tabling: the motion is moved again and goes to the vote after its objection check", async (w, script, room) => {
      const rec = await room.meeting("Build sync");
      const motion = await room.motion(rec, "Move the nightly build to one in the morning.");
      room.scripted.objection = (a) => (a.endsWith("bob") ? { answer: "research", reason: "measure the cache hit rate at one" } : { answer: "none" });
      await room.procedure.begin(w.owner, { commandId: cid("pb"), motionId: motion });
      await room.run(motion);
      const chat = w.chat();
      script["Table the nightly build motion until we have the numbers."] = [cmd(RULE, { motionTopic: "nightly build", ruling: "table" }, "table the nightly build motion until we have the numbers")];
      const proposed = only((await say(w, chat, "Table the nightly build motion until we have the numbers.")).outcomes);
      assert.equal(proposed.status, "proposed", JSON.stringify(proposed));
      await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: proposed.proposalId! });
      assert.equal(await room.state(motion), "tabled");
      assert.match(String(((await room.records.motion(w.owner, motion)) as { voidReason: string }).voidReason), /until we have the numbers/, "the reason is the owner's own words");
      // A tabled motion is not one that waits for a ruling.
      script["Rule on the nightly build."] = [cmd(RULE, { motionTopic: "nightly build", ruling: "proceed" }, "rule on the nightly build")];
      assert.equal(only((await say(w, chat, "Rule on the nightly build.")).outcomes).status, "refused");
      script["Vote on the nightly build anyway."] = [cmd(UNTABLE, { motionTopic: "nightly build" }, "vote on the nightly build anyway")];
      const again = only((await say(w, chat, "Vote on the nightly build anyway.")).outcomes);
      assert.equal(again.status, "proposed", JSON.stringify(again));
      assert.match(String(again.preview), /Overrule a tabling/);
      await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: again.proposalId! });
      const controls = (await call(w, w.ownerToken, "meeting.proc.owner-controls", {})).result.item;
      assert.equal(controls.tabled.length, 0, "the tabling was overruled");
      assert.equal(await room.state(motion), "tabled", "the tabled motion stays on record");
    });

    suite("a message to a meeting is shown first; one that quotes a ballot is refused with a warning until the owner says to send it anyway", async (w, script, room) => {
      const rec = await room.meeting("Build sync");
      const motion = await room.motion(rec, "Move the nightly build to one in the morning.");
      await room.procedure.begin(w.owner, { commandId: cid("pb"), motionId: motion });
      // Run to the vote and stop after the first ballot.
      for (let i = 0; i < 100 && room.scripted.ballots.length < 1; i++) await room.procedure.advance(w.owner, { motionId: motion });
      assert.equal(room.scripted.ballots.length, 1);
      const chat = w.chat();
      const quoted = "Tell the build sync that someone wants the earlier slot because the warm cache halves the run time, do you agree?";
      script[quoted] = [cmd(SAY, { meetingTopic: "build sync", text: quoted }, quoted)];
      const proposed = only((await say(w, chat, quoted)).outcomes);
      assert.equal(proposed.status, "proposed", JSON.stringify(proposed));
      assert.match(String(proposed.preview), /everyone who speaks in the meeting after it sees these words/);
      const refused = await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: proposed.proposalId! });
      assert.match(JSON.stringify(refused), /repeats the reason/, "the owner is warned that ballots stop being private");
      const resend = `${quoted} Send it anyway.`;
      script[resend] = [cmd(SAY, { meetingTopic: "build sync", text: quoted, acknowledged: true }, resend)];
      const second = only((await say(w, chat, resend)).outcomes);
      assert.equal(second.status, "proposed", JSON.stringify(second));
      await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: second.proposalId! });
      const entries = (await room.records.discussion(w.owner, rec))!.entries;
      assert.ok(entries.some((e) => e.kind === "owner-message" && e.text === quoted));
    });

    suite("the controls are the owner's alone and carry their own proposal reasons, and no chat argument can set what only the system decides", async (w, _script, room) => {
      for (const op of [RULE, UNTABLE, SAY]) {
        assert.equal(CHAT_OPS[op]?.mode, "propose", `${op} is always shown first`);
        assert.ok(acceptedArgs(op) !== undefined, `${op} is a chat command`);
        assert.doesNotMatch(String(proposalReason(op, {}, false, { profile: "derived", said: true, quoted: false })), /capabilities/, `${op} has its own reason`);
        assert.ok(describe(op, { motionId: "mmo-x", recordId: "mrc-x" }, {}).length > 10);
      }
      assert.ok(acceptedArgs(RULE)!.includes("motionTopic") && acceptedArgs(UNTABLE)!.includes("motionTopic") && acceptedArgs(SAY)!.includes("meetingTopic"));
      assert.ok(!acceptedArgs(RULE)!.includes("actor"));
      const rec = await room.meeting("Build sync");
      const motion = await room.motion(rec, "Move the nightly build.");
      await room.procedure.begin(w.owner, { commandId: cid("pb"), motionId: motion });
      for (const op of ["meeting.proc.advance", "meeting.proc.run", "meeting.proc.begin", "meeting.proc.untable", "meeting.proc.rule", "meeting.proc.owner-message"]) {
        const args: Record<string, unknown> = op.endsWith("owner-message") ? { recordId: rec, text: "hi" } : op.endsWith("rule") ? { motionId: motion, ruling: "proceed" } : { motionId: motion };
        const res = await w.api.handle(room.agentToken, { v: 1, op, commandId: cid("c"), args } as never) as { ok: boolean };
        assert.equal(res.ok, false, `${op} is refused for a member`);
      }
      assert.deepEqual((await call(w, room.agentToken, "meeting.proc.owner-controls", {})).result?.item, { rulings: [], tabled: [] });
    });
  }
}
