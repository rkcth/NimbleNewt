import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backendsNamed, stopServer } from "../domain/testing/backends.js";
import { describe, proposalReason, acceptedArgs, CHAT_OPS } from "./commands.js";
import { MeetingDeskReadService, MeetingRecordService, taskUpdateApplier, type ChangeApplier } from "../meetings/index.js";
import { DomainError } from "../domain/errors.js";
import { GrantService } from "../security/index.js";
import type { ChatService, Outcome } from "./index.js";
import { cid, openWorld, options, type World } from "./testing/harness.js";

const cmd = (op: string, args: Record<string, unknown>, evidence: string) => ({ kind: "command", op, args, evidence, basis: "owner" });
const OPEN = "meeting.record.open-vote";
const CLOSE = "meeting.record.close-vote";
const TABLE = "meeting.record.table";
const FINISH = "meeting.record.finish";
const APPLY = "meeting.record.apply";
const OUTCOMES = "meeting.record.outcomes";

interface Room {
  records: MeetingRecordService;
  crash: { n: number };
  /** A meeting with the three agents joined; returns the record's ID. */
  meeting(title: string, project?: string): Promise<{ recordId: string; project: string }>;
  /** A motion moved in that meeting (one retitling change when `change` is set). */
  motion(recordId: string, text: string, o?: { topic?: string; change?: string; agendaItemId?: string }): Promise<{ id: string; taskId?: string }>;
  vote(motionId: string, value?: "yes" | "no"): Promise<void>;
  state(motionId: string): Promise<string>;
  recordState(recordId: string): Promise<string>;
  title(taskId: string): Promise<string>;
  project: string;
  agentToken: string;
}

/** The owner's other meeting controls by chat (card M02h): opening and closing a vote, tabling a motion, ending a meeting and carrying out a decision again, each found by the owner's words. One backend per file. */
export function defineMeetingControlTests(backendName: string): void {
  after(stopServer);
  for (const backend of backendsNamed(backendName)) {
    const suite = (name: string, body: (w: World, script: Record<string, unknown>, room: Room) => Promise<void>) =>
      test(`${backend.name}: ${name}`, async () => {
        const script: Record<string, unknown> = {};
        const holder: { r?: MeetingRecordService } = {};
        const lazy = new Proxy({}, { get: (_t, k) => async (...a: unknown[]) => (holder.r as unknown as Record<string, (...x: unknown[]) => Promise<unknown>>)[k as string]!(...a) }) as MeetingRecordService;
        const deskHolder: { d?: MeetingDeskReadService } = {};
        const lazyDesk = new Proxy({}, { get: (_t, k) => async (...a: unknown[]) => (deskHolder.d as unknown as Record<string, (...x: unknown[]) => Promise<unknown>>)[k as string]!(...a) }) as MeetingDeskReadService;
        const w = await openWorld(backend, script, undefined, { records: lazy, deskReads: lazyDesk });
        deskHolder.d = MeetingDeskReadService.withEpoch(w.world.storage, w.projects.epoch, options);
        const grants = GrantService.withEpoch(w.world.storage, w.projects.epoch, options);
        const authority = async (id: string) => { const p = await w.principals.get(id); return p === undefined ? undefined : grants.effective({ id, kind: p.kind, name: p.name, grants: p.grants }, options.clock()); };
        const crash = { n: 0 };
        const base = taskUpdateApplier(w.projects);
        const crashing: ChangeApplier = { ...base, widens: "spend", async apply(ch) { if (crash.n > 0) { crash.n--; throw new DomainError("unavailable", "storage went away"); } return base.apply(ch); } };
        holder.r = MeetingRecordService.withEpoch(w.world.storage, w.projects.epoch, { meetings: w.meetings, decisions: w.decisions }, { ...options, authority, appliers: { "task.update": crashing, "task.retitle": base }, widening: async () => "allow", shareable: async () => false });
        const records = holder.r;
        const project = await w.project("A");
        const mgr = await w.agent("mgr", [{ action: "meeting.manage", project: "*" }]);
        const grantsOf = (extra: string[]) => [{ action: "task.read", project: "*" }, ...extra.map((action) => ({ action, project: "*" }))];
        const crew = [await w.agent("ann", grantsOf(["meeting.attend", "task.update"])), await w.agent("bob", grantsOf(["meeting.attend", "task.update"])), await w.agent("cyd", grantsOf(["meeting.attend", "task.update"]))];
        const room: Room = {
          records, crash, project, agentToken: crew[0]!.token,
          meeting: async (title, p = project) => {
            const occ = (await w.meetings.callUrgent(mgr.principal, { commandId: cid("urg"), projectId: p, title, reason: "decide", roster: crew.map((c) => c.principal.id) })).id;
            const rec = (await records.open(mgr.principal, { commandId: cid("open"), occurrenceId: occ })).id;
            for (const c of crew) await records.join(c.principal, { commandId: cid("j"), recordId: rec });
            return { recordId: rec, project: p };
          },
          motion: async (recordId, text, o = {}) => {
            let taskId: string | undefined;
            const changes: Record<string, unknown>[] = [];
            if (o.change !== undefined) {
              taskId = await w.task(project, o.change);
              changes.push({ kind: "task.update", agent: crew[0]!.principal.id, target: { kind: "task", id: taskId }, expectedRevision: (await w.projects.getTask(taskId))!.revision, patch: { title: `${o.change} v2` }, summary: `retitle ${o.change}` });
            }
            const id = (await records.move(crew[1]!.principal, { commandId: cid("mv"), recordId, text, ...(o.topic === undefined && o.change === undefined ? {} : { topic: o.topic ?? "build tasks" }), ...(o.agendaItemId === undefined ? {} : { agendaItemId: o.agendaItemId }), changes } as never)).id;
            return { id, ...(taskId === undefined ? {} : { taskId }) };
          },
          vote: async (motionId, value = "yes") => {
            await records.openVote(w.owner, { commandId: cid("ov"), motionId, expectedVersion: 1 });
            for (const c of crew) await records.castBallot(c.principal, { commandId: cid("b"), motionId, version: 1, value, reason: "it helps" } as never);
          },
          state: async (motionId) => String((await records.motion(w.owner, motionId))!.state),
          recordState: async (recordId) => String((await records.record(w.owner, recordId))!.state),
          title: async (taskId) => (await w.projects.getTask(taskId))!.title,
        };
        try { await body(w, script, room); } finally { await w.close(); }
      });
    const say = (w: World, chat: ChatService, text: string) => chat.submit(w.ownerToken, { messageId: cid("m"), text });
    const only = (outcomes: readonly Outcome[]): Outcome => { assert.equal(outcomes.length, 1); return outcomes[0]!; };
    const call = async (w: World, token: string, op: string, args: Record<string, unknown>) => w.api.handle(token, { v: 1, op, args } as never) as Promise<any>;

    suite("the owner opens the vote on a motion by its words; the version is read, the proposal is shown first, nothing changes until confirmed", async (w, script, room) => {
      const { recordId } = await room.meeting("Infrastructure sync");
      const nightly = await room.motion(recordId, "Move the nightly build to one in the morning.");
      const staging = await room.motion(recordId, "Retire the old staging server on Friday.");
      const chat = w.chat();
      // A model-supplied version is replaced by the one in the records; no ID is needed.
      script["Start the vote on the nightly build motion."] = [cmd(OPEN, { motionTopic: "nightly build", expectedVersion: 7 }, "vote on the nightly build motion")];
      const proposed = only((await say(w, chat, "Start the vote on the nightly build motion.")).outcomes);
      assert.equal(proposed.status, "proposed", JSON.stringify(proposed));
      assert.match(String(proposed.preview), /Open the vote on a motion/);
      assert.match(String(proposed.preview), /nightly build/);
      const body = (await chat.getProposal(w.ownerToken, proposed.proposalId!))!;
      assert.match(body.reason, /opening a vote starts the clock/);
      assert.equal(await room.state(nightly.id), "proposed", "nothing changed before the owner confirms");
      await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: proposed.proposalId! });
      assert.equal(await room.state(nightly.id), "voting");
      assert.equal(await room.state(staging.id), "proposed", "the other motion is untouched");
      // The motion already voting is no longer one that waits for a vote.
      script["Start the vote on the nightly build motion again."] = [cmd(OPEN, { motionTopic: "nightly build" }, "vote on the nightly build motion again")];
      const again = only((await say(w, chat, "Start the vote on the nightly build motion again.")).outcomes);
      assert.equal(again.status, "refused", JSON.stringify(again));
      // Its state is said, rather than a "no such motion".
      assert.match(String(again.message), /motion 1 .* is voting, not a motion waiting for a vote/);
    });

    suite("several motions that fit are asked about, and an ID the owner did not say is the model's own", async (w, script, room) => {
      const { recordId } = await room.meeting("Infrastructure sync");
      const a = await room.motion(recordId, "Move the nightly build to one in the morning.");
      const b = await room.motion(recordId, "Move the weekly build to Sunday.");
      const chat = w.chat();
      script["Open the vote on the build motion."] = [cmd(OPEN, { motionTopic: "build motion" }, "vote on the build motion")];
      const asked = only((await say(w, chat, "Open the vote on the build motion.")).outcomes);
      assert.equal(asked.status, "asked", JSON.stringify(asked));
      assert.match(String(asked.question), /Which motion waiting for a vote do you mean/);
      // The model names an ID the owner never wrote: with two candidates the owner is asked, nothing is proposed.
      script["Start the vote please."] = [cmd(OPEN, { motionId: b.id }, "start the vote")];
      const guessed = only((await say(w, chat, "Start the vote please.")).outcomes);
      assert.notEqual(guessed.status, "proposed", JSON.stringify(guessed));
      assert.equal(await room.state(a.id), "proposed");
      assert.equal(await room.state(b.id), "proposed");
      // Words that fit nothing refuse.
      script["Open the vote on the parking lot motion."] = [cmd(OPEN, { motionTopic: "parking lot" }, "vote on the parking lot motion")];
      const none = only((await say(w, chat, "Open the vote on the parking lot motion.")).outcomes);
      assert.equal(none.status, "refused");
    });

    suite("counting the vote closes it and an adopted decision is carried out", async (w, script, room) => {
      const { recordId } = await room.meeting("Build sync");
      const m = await room.motion(recordId, "Rename the nightly task.", { change: "Nightly task" });
      await room.vote(m.id);
      const chat = w.chat();
      script["Count the vote on the nightly task."] = [cmd(CLOSE, { motionTopic: "nightly task" }, "count the vote on the nightly task")];
      const proposed = only((await say(w, chat, "Count the vote on the nightly task.")).outcomes);
      assert.equal(proposed.status, "proposed", JSON.stringify(proposed));
      assert.match((await chat.getProposal(w.ownerToken, proposed.proposalId!))!.reason, /counting the vote now settles the motion/);
      assert.equal(await room.state(m.id), "voting");
      await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: proposed.proposalId! });
      assert.equal(await room.state(m.id), "adopted");
    });

    suite("tabling a motion takes the owner's words as the reason, or the message when none is given", async (w, script, room) => {
      const { recordId } = await room.meeting("Sync");
      const m = await room.motion(recordId, "Buy a bigger coffee machine.");
      const other = await room.motion(recordId, "Replace the printer.");
      const chat = w.chat();
      script["Table the coffee machine motion, we have no budget."] = [cmd(TABLE, { motionTopic: "coffee machine" }, "table the coffee machine motion")];
      const proposed = only((await say(w, chat, "Table the coffee machine motion, we have no budget.")).outcomes);
      assert.equal(proposed.status, "proposed", JSON.stringify(proposed));
      assert.match(String(proposed.preview), /Table a motion/);
      assert.match((await chat.getProposal(w.ownerToken, proposed.proposalId!))!.reason, /cannot be taken back/);
      await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: proposed.proposalId! });
      assert.equal(await room.state(m.id), "tabled");
      assert.equal(await room.state(other.id), "proposed");
      // A reason the model made up is not the owner's.
      script["Table the printer motion."] = [cmd(TABLE, { motionTopic: "printer", reason: "the printer is broken beyond repair" }, "table the printer motion")];
      const made = only((await say(w, chat, "Table the printer motion.")).outcomes);
      assert.equal(made.status, "refused", JSON.stringify(made));
      assert.equal(await room.state(other.id), "proposed");
    });

    suite("ending a meeting by its title voids the motions not concluded and removes it from the open meetings", async (w, script, room) => {
      const one = await room.meeting("Infrastructure sync");
      const two = await room.meeting("Budget review");
      const m = await room.motion(one.recordId, "Retire the old staging server.");
      const chat = w.chat();
      script["End the budget review meeting."] = [cmd(FINISH, { meetingTopic: "budget review" }, "end the budget review meeting")];
      const proposed = only((await say(w, chat, "End the budget review meeting.")).outcomes);
      assert.equal(proposed.status, "proposed", JSON.stringify(proposed));
      assert.match(String(proposed.preview), /End a meeting/);
      assert.match((await chat.getProposal(w.ownerToken, proposed.proposalId!))!.reason, /ending a meeting cannot be taken back/);
      await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: proposed.proposalId! });
      assert.equal(await room.recordState(two.recordId), "ended");
      assert.equal(await room.recordState(one.recordId), "open");
      assert.equal(await room.state(m.id), "proposed");
      const open = (await call(w, w.ownerToken, "meeting.owner-controls", {})).result.item;
      assert.deepEqual(open.meetings.map((x: { id: string }) => x.id), [one.recordId]);
      // Ended: nothing is left to end by those words.
      script["End the budget review meeting again."] = [cmd(FINISH, { meetingTopic: "budget review" }, "end the budget review meeting again")];
      assert.equal(only((await say(w, chat, "End the budget review meeting again.")).outcomes).status, "refused");
    });

    suite("a decision whose change stayed applying is carried out again by chat", async (w, script, room) => {
      const { recordId } = await room.meeting("Build sync");
      const m = await room.motion(recordId, "Rename the nightly task.", { change: "Nightly task" });
      await room.vote(m.id);
      const closed = await room.records.closeVote(w.owner, { commandId: cid("cl"), motionId: m.id });
      room.crash.n = 1;
      await assert.rejects(() => room.records.apply(w.owner, { decisionId: closed.decisionId! }), (e: unknown) => e instanceof DomainError && e.code === "unavailable");
      assert.equal(await room.title((await call(w, w.ownerToken, "task.list", { projectId: room.project })).result.items.find((t: { title: string }) => t.title === "Nightly task").id), "Nightly task", "not carried out yet");
      const listed = (await call(w, w.ownerToken, "meeting.owner-controls", {})).result.item;
      assert.equal(listed.unfinished.length, 1);
      assert.equal(listed.unfinished[0].applying, 1);
      const chat = w.chat();
      script["Finish the nightly task rename."] = [cmd(APPLY, { decisionTopic: "nightly task" }, "finish the nightly task rename")];
      const proposed = only((await say(w, chat, "Finish the nightly task rename.")).outcomes);
      assert.equal(proposed.status, "proposed", JSON.stringify(proposed));
      assert.match((await chat.getProposal(w.ownerToken, proposed.proposalId!))!.reason, /carries out changes to your project/);
      await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: proposed.proposalId! });
      assert.equal((await call(w, w.ownerToken, "task.list", { projectId: room.project })).result.items.some((t: { title: string }) => t.title === "Nightly task v2"), true, "the change was carried out");
      assert.equal((await call(w, w.ownerToken, "meeting.owner-controls", {})).result.item.unfinished.length, 0);
      script["Finish the nightly task rename again."] = [cmd(APPLY, { decisionTopic: "nightly task" }, "finish the nightly task rename again")];
      assert.equal(only((await say(w, chat, "Finish the nightly task rename again.")).outcomes).status, "refused");
    });

    suite("the owner's pick from the question of which motion or meeting is carried on (review)", async (w, script, room) => {
      const { recordId } = await room.meeting("Infrastructure sync");
      const other = await room.meeting("Infrastructure review");
      const a = await room.motion(recordId, "Move the nightly build to one in the morning.");
      const b = await room.motion(recordId, "Move the weekly build to Sunday.");
      const chat = w.chat();
      script["Open the vote on the build motion."] = [cmd(OPEN, { motionTopic: "build motion" }, "vote on the build motion")];
      const first = await say(w, chat, "Open the vote on the build motion.");
      assert.equal(only(first.outcomes).status, "asked");
      script["The weekly one."] = [{ kind: "answer", turnId: first.turnId, choice: b.id, evidence: "The weekly one", basis: "owner" }];
      const picked = only((await say(w, chat, "The weekly one.")).outcomes);
      assert.equal(picked.status, "proposed", JSON.stringify(picked));
      await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: picked.proposalId! });
      assert.equal(await room.state(b.id), "voting");
      assert.equal(await room.state(a.id), "proposed");
      script["End the infrastructure meeting."] = [cmd(FINISH, { meetingTopic: "infrastructure" }, "end the infrastructure meeting")];
      const second = await say(w, chat, "End the infrastructure meeting.");
      assert.equal(only(second.outcomes).status, "asked");
      script["The review."] = [{ kind: "answer", turnId: second.turnId, choice: other.recordId, evidence: "The review", basis: "owner" }];
      const ending = only((await say(w, chat, "The review.")).outcomes);
      assert.equal(ending.status, "proposed", JSON.stringify(ending));
      await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: ending.proposalId! });
      assert.equal(await room.recordState(other.recordId), "ended");
      assert.equal(await room.recordState(recordId), "open");
    });

    suite("a motion whose vote is open is not offered for tabling, and words that fit a motion in another state never act on a looser fit (review)", async (w, script, room) => {
      const { recordId } = await room.meeting("Sync");
      const coffee = await room.motion(recordId, "Buy a bigger coffee machine.");
      const printer = await room.motion(recordId, "Replace the printer.");
      await room.vote(coffee.id);
      const chat = w.chat();
      // The records service tables only a motion not yet put to a vote: proposing it would fail after the owner confirms.
      script["Table the coffee machine motion."] = [cmd(TABLE, { motionTopic: "coffee machine" }, "table the coffee machine motion")];
      const tabled = only((await say(w, chat, "Table the coffee machine motion.")).outcomes);
      assert.equal(tabled.status, "refused", JSON.stringify(tabled));
      assert.match(String(tabled.message), /voting/);
      // The nightly build motion waits for a vote while the weekly build one is being voted on: counting "the nightly build" vote is not counting the weekly one.
      const nightly = await room.motion(recordId, "Move the nightly build to one in the morning.");
      const weekly = await room.motion(recordId, "Move the weekly build to Sunday.");
      await room.records.closeVote(w.owner, { commandId: cid("cl"), motionId: coffee.id });
      await room.vote(weekly.id);
      script["Count the vote on the nightly build."] = [cmd(CLOSE, { motionTopic: "nightly build" }, "count the vote on the nightly build")];
      const counted = only((await say(w, chat, "Count the vote on the nightly build.")).outcomes);
      assert.equal(counted.status, "refused", JSON.stringify(counted));
      assert.match(String(counted.message), /proposed/);
      assert.equal(await room.state(weekly.id), "voting");
      assert.equal(await room.state(nightly.id), "proposed");
      assert.equal(await room.state(printer.id), "proposed");
    });

    suite("the owner has a finished meeting hand its outcomes back and ask them about what was left open, in their own words; the answer is written onto the meeting's record (card M05)", async (w, script, room) => {
      const topic = (await w.meetings.addAgendaItem(w.owner, { commandId: cid("it"), projectId: room.project, topic: "Pick the cache size", question: "How big?", urgency: "urgent", intent: "delegated-decision" })).id;
      const { recordId } = await room.meeting("Infrastructure sync");
      const moved = (await room.motion(recordId, "Make the cache four gigabytes, as the benchmark shows.", { agendaItemId: topic })).id;
      await room.records.table(w.owner, { commandId: cid("t"), motionId: moved, reason: "no benchmark yet" });
      const chat = w.chat();
      const ask = "Hand back what the infrastructure sync decided, and ask me about the things it left open.";
      script[ask] = [cmd(OUTCOMES, { meetingTopic: "infrastructure", askOwner: true }, "ask me about the things it left open")];
      const proposed = only((await say(w, chat, ask)).outcomes);
      assert.equal(proposed.status, "proposed", JSON.stringify(proposed));
      assert.match(String(proposed.preview), /Hand a meeting's outcomes back/);
      assert.match(String(proposed.preview), /puts a question to you/);
      assert.match(String(proposed.preview), /Infrastructure sync/);
      assert.match((await chat.getProposal(w.ownerToken, proposed.proposalId!))!.reason, /puts a question to you/);
      assert.equal((await w.meetings.ownerQuestions(w.owner, room.project)).open.length, 0, "nothing is asked before the owner agrees");
      await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: proposed.proposalId! });
      const open = (await w.meetings.ownerQuestions(w.owner, room.project)).open;
      assert.equal(open.length, 1);
      assert.match(open[0]!.question, /tabled/);
      assert.equal((await room.records.motion(w.owner, moved) as unknown as { outcomeReturned?: boolean }).outcomeReturned, true);
      // The owner's answer (in chat it is the stand-up answer command, tested with the stand-up commands) goes onto the meeting's record.
      const reply = "In project A, about the cache size: yes, run the benchmark first.";
      await w.meetings.answerOwnerQuestion(w.owner, { commandId: cid("an"), questionId: open[0]!.id, expectedRevision: open[0]!.revision, answer: reply });
      const notes = ((await room.records.record(w.owner, recordId)) as unknown as { ownerAnswers?: { answer: string }[] }).ownerAnswers!;
      assert.deepEqual(notes.map((n) => n.answer), [reply]);
    });

    suite("asking by chat is refused when the meeting deferred nothing or the wish is not a plain yes, and an agent cannot ask through the API (card M05)", async (w, script, room) => {
      const topic = (await w.meetings.addAgendaItem(w.owner, { commandId: cid("it"), projectId: room.project, topic: "Pick the editor", question: "Which?", urgency: "urgent", intent: "discussion" })).id;
      const { recordId } = await room.meeting("Infrastructure sync");
      const m = await room.motion(recordId, "Use the new editor everywhere.", { agendaItemId: topic });
      await room.vote(m.id);
      await room.records.closeVote(w.owner, { commandId: cid("cl"), motionId: m.id });
      assert.equal(await room.state(m.id), "adopted");
      const chat = w.chat();
      script["Hand back the infrastructure sync outcomes and ask me, yes."] = [cmd(OUTCOMES, { meetingTopic: "infrastructure", askOwner: "yes" }, "ask me")];
      const odd = only((await say(w, chat, "Hand back the infrastructure sync outcomes and ask me, yes.")).outcomes);
      assert.equal(odd.status, "refused", JSON.stringify(odd));
      assert.match(String(odd.message), /askOwner is true or false/);
      // The meeting decided everything, so there is nothing left open to ask about.
      script["Hand back the infrastructure sync outcomes and ask me about the open things."] = [cmd(OUTCOMES, { meetingTopic: "infrastructure", askOwner: true }, "ask me about the open things")];
      const nothing = only((await say(w, chat, "Hand back the infrastructure sync outcomes and ask me about the open things.")).outcomes);
      assert.equal(nothing.status, "refused", JSON.stringify(nothing));
      assert.match(String(nothing.message), /deferred nothing/);
      // Without the wish to be asked the same words are a plain proposal.
      script["Hand back the infrastructure sync outcomes."] = [cmd(OUTCOMES, { meetingTopic: "infrastructure" }, "Hand back the infrastructure sync outcomes")];
      const plain = only((await say(w, chat, "Hand back the infrastructure sync outcomes.")).outcomes);
      assert.equal(plain.status, "proposed", JSON.stringify(plain));
      assert.match(String(plain.preview), /nothing is asked of you/);
      // An agent with the right to manage meetings may not make a meeting ask the owner, whatever it sends.
      const mgr = await w.agent("mgr2", [{ action: "meeting.manage", project: "*" }]);
      const refused = await call(w, mgr.token, "meeting.record.outcomes", { recordId, askOwner: true });
      assert.equal(refused.ok, false);
      assert.equal(refused.error.code, "forbidden");
      assert.equal((await call(w, mgr.token, "meeting.owner-outcomes", {})).ok, false, "the list is the owner's");
      assert.equal((await call(w, w.ownerToken, "meeting.owner-outcomes", {})).ok, true);
    });

    suite("only the owner reads what can be acted on, and the controls are chat commands with a line of their own", async (w, _script, room) => {
      const { recordId: syncRecord } = await room.meeting("Sync");
      // Card M05b: what the chair read from absent members' desks is an owner query of the API (the chat asks it through the status view `meeting_desk_reads`); it lists nothing for a meeting where nobody read anything, refuses a bad page size and malformed arguments.
      const occurrenceId = String((await call(w, w.ownerToken, "meeting.record.get", { recordId: syncRecord })).result.item.occurrenceId);
      const noReads = await call(w, w.ownerToken, "meeting.desk-reads", { occurrenceId });
      assert.deepEqual([noReads.ok, noReads.result.item.reads, noReads.result.item.attempts], [true, [], []]);
      assert.equal((await call(w, room.agentToken, "meeting.desk-reads", { occurrenceId })).result.item.reads.length, 0, "a roster member reads the same, empty list");
      assert.equal((await call(w, w.ownerToken, "meeting.desk-reads", { occurrenceId, limit: 0 })).ok, false);
      assert.equal((await call(w, w.ownerToken, "meeting.desk-reads", { occurrenceId, color: "red" })).ok, false);
      assert.equal((await call(w, w.ownerToken, "meeting.desk-reads", {})).ok, false);
      const refused = await call(w, room.agentToken, "meeting.owner-controls", {});
      assert.equal(refused.ok, false);
      assert.equal((await call(w, w.ownerToken, "meeting.owner-controls", { limit: 0 })).ok, false);
      assert.equal((await call(w, w.ownerToken, "meeting.owner-controls", {})).ok, true);
      for (const op of [OPEN, CLOSE, TABLE, FINISH, APPLY, OUTCOMES]) {
        assert.equal(CHAT_OPS[op]?.mode, "propose", `${op} is always shown first`);
        assert.ok(acceptedArgs(op) !== undefined, `${op} is a chat command`);
        assert.doesNotMatch(String(proposalReason(op, {}, false, { profile: "derived", said: true, quoted: false })), /capabilities/, `${op} has its own reason`);
        assert.ok(describe(op, { motionId: "mmo-x", recordId: "mrc-x", decisionId: "mdc-x" }, {}).length > 10);
      }
      assert.ok(!acceptedArgs(OPEN)!.includes("limitMinutes"), "the length of a vote is not chat's to set");
      assert.ok(acceptedArgs(TABLE)!.includes("motionTopic") && acceptedArgs(FINISH)!.includes("meetingTopic") && acceptedArgs(APPLY)!.includes("decisionTopic"));
      assert.ok(acceptedArgs(OUTCOMES)!.includes("meetingTopic") && acceptedArgs(OUTCOMES)!.includes("askOwner") && acceptedArgs(OUTCOMES)!.includes("recordId"));
    });
  }
}
