import assert from "node:assert/strict";
import { after, test } from "node:test";
import { API_VERSION } from "../api/index.js";
import { OPERATIONS } from "../api/operations.js";
import { BlockerService } from "../domain/blockers.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { WaitService } from "../domain/waits.js";
import { MeetingService } from "../meetings/index.js";
import { ReviewService } from "../review/index.js";
import { StandupService } from "../standups/index.js";
import { StatusService } from "../status/index.js";
import { CHAT_OPS, acceptedArgs, type ChatService, type Outcome } from "./index.js";
import { ModelInterpreter } from "./model-interpreter.js";
import { cid, openWorld, options, type World } from "./testing/harness.js";

// Card U11d: every item of the Needs-you list is answered where it stands, in free words, by one operation that routes to the service that already decides that kind of item; a review only the owner decides and a blocker
// only the owner resolves had no command at all before. Real services on every backend; the chat resolves the item from the owner's words and shows it first.

after(stopServer);

const cmd = (op: string, args: Record<string, unknown>, evidence: string) => ({ kind: "command", op, args, evidence, basis: "owner" });

test("the operation table and the interpreter prompt describe answering in place: the operation is owner-only and shown first, takes the owner's words for the item and never an ID", async () => {
  let system = "";
  const m = new ModelInterpreter({ complete: async (_route, r) => { system = r.system; return "[]"; } }, () => ["a/primary"]);
  await m.interpret({ text: "allow that", quoted: [], focus: {}, proposals: [] });
  assert.equal(CHAT_OPS["needs-you.answer"]?.mode, "propose");
  assert.ok(OPERATIONS.some((o) => o.name === "needs-you.answer" && o.kind === "command"));
  assert.ok((acceptedArgs("needs-you.answer") ?? []).includes("itemTopic"));
  assert.match(system, /To answer an item of the Needs-you list where it stands/);
  assert.match(system, /itemTopic is the owner's own words for which item/);
  assert.ok(system.includes(`needs-you.answer(${(acceptedArgs("needs-you.answer") ?? []).filter((k) => k !== "projectName").join(", ")})`), "listed with its arguments from the one table");
});

for (const backend of backends) {
  const suite = (name: string, body: (w: World, script: Record<string, unknown>, x: Extra) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const script: Record<string, unknown> = {};
      let extra!: Extra;
      const w = await openWorld(backend, script, undefined, (storage, epoch, built) => {
        const blockers = BlockerService.withEpoch(storage, epoch, options);
        const reviews = ReviewService.withEpoch(storage, epoch, options);
        const meetings = MeetingService.withEpoch(storage, epoch, {}, { availability: async () => "available", ...options });
        const standups = StandupService.withEpoch(storage, epoch, { meetings, assignments: built.assignments }, { availability: async () => "available", ...options });
        extra = { blockers, reviews, meetings };
        const status = StatusService.withEpoch(storage, epoch, {
          assignments: built.assignments, waits: WaitService.withEpoch(storage, epoch, built.assignments, options), blockers, contracts: built.contracts,
          reviews: { ownerPending: (owner, limit) => reviews.ownerPending(owner, limit) },
          meetingQuestions: async (by, limit) => { const r = await meetings.openOwnerQuestions(by, limit); return { truncated: r.truncated, items: r.items.map((q) => ({ id: q.id, revision: q.revision, projectId: q.projectId, topic: q.topic, question: q.question, askedAt: q.askedAt })) }; },
        }, options);
        return { status, standups, needsYouAnswers: { reviews, blockers } };
      });
      try { await body(w, script, extra); } finally { await w.close(); }
    });
  interface Extra { blockers: BlockerService; reviews: ReviewService; meetings: MeetingService }
  const say = (w: World, chat: ChatService, text: string, messageId = cid("m")) => chat.submit(w.ownerToken, { messageId, text });
  const only = (outcomes: readonly Outcome[]): Outcome => { assert.equal(outcomes.length, 1, JSON.stringify(outcomes)); return outcomes[0]!; };
  const list = async (w: World): Promise<{ kind: string; id: string; text: string; answer: { kind: string; choices?: string[] } }[]> => {
    const r = await w.api.handle(w.ownerToken, { v: API_VERSION, op: "status.ask", args: { request: { kind: "needs_you", limit: 50 } } });
    assert.ok(r.ok, JSON.stringify(r));
    return (((r as unknown as { result: { item: { items: never[] } } }).result.item.items)) as never;
  };

  /** A project with a blocker the owner resolves, a review only the owner decides and a question a meeting asked. */
  const furnish = async (w: World, x: Extra) => {
    const project = await w.project("Garden");
    const task = await w.task(project, "Order the pump");
    const blocker = (await x.blockers.openBlocker({ commandId: cid("b"), actor: "owner:rob", type: "grant_needed", subject: { kind: "task", id: task }, summary: "The bank has to confirm the payment limit", resolver: "owner" } as never)).id;
    const ann = await w.agent("ann", [{ action: "review.request", project }, { action: "attempt.work", project }, { action: "tool.run-script", project }]);
    await x.reviews.setPolicy(w.owner, { commandId: cid("pol"), projectId: project, policy: { mandatoryHuman: ["run-script"] } });
    const review = (await x.reviews.request(ann.principal, { commandId: cid("rq"), taskId: task, operation: { name: "run-script", args: { cwd: "/work" }, script: "echo hello\n", target: { kind: "workspace", id: "main" } }, context: { toolVersion: "1.2.3", authoritySource: "task grant", expectedEffects: ["builds the project"] } })).id;
    const agenda = await x.meetings.addAgendaItem(w.owner, { commandId: cid("ag"), projectId: project, topic: "Move the nightly build earlier?" });
    await x.meetings.setAgendaState(w.owner, { commandId: cid("st"), itemId: agenda.id, expectedRevision: (await x.meetings.agendaItem(w.owner, agenda.id))!.revision, to: "deferred", reason: "later", nextStep: "ask", ownerQuestion: "Should the nightly build run at 02:00 instead of 04:00?" } as never);
    return { project, task, blocker, review, ann };
  };

  suite("the Needs-you list says what each item is and how it is answered, and the owner answers a review, a blocker and a meeting's question in free words: each is shown first, nothing is decided before the owner agrees, and the answer reaches the service that decides it", async (w, script, x) => {
    const f = await furnish(w, x);
    const items = await list(w);
    const kinds = items.map((i) => i.kind).sort();
    assert.deepEqual(kinds, ["approval", "blocker", "meeting-question"], JSON.stringify(items));
    assert.deepEqual(items.find((i) => i.kind === "approval")!.answer, { kind: "choice", choices: ["allow", "deny"] });
    assert.deepEqual(items.find((i) => i.kind === "blocker")!.answer, { kind: "words" });
    assert.match(items.find((i) => i.kind === "meeting-question")!.text, /nightly build/);
    const chat = w.chat();
    const stateOf = async (): Promise<string> => (await x.reviews.get(w.owner, f.review))!.state;
    assert.equal(await stateOf(), "owner-decision");

    // The review: "yes, go ahead" is allow; it is a proposal until the owner agrees.
    const words = "Yes, go ahead with the run-script approval";
    script[words] = [cmd("needs-you.answer", { itemTopic: "run-script", answer: "allow" }, "go ahead")];
    const shown = only((await say(w, chat, words)).outcomes);
    assert.equal(shown.status, "proposed", JSON.stringify(shown));
    assert.equal(await stateOf(), "owner-decision", "the message that drew it up decided nothing");
    const yes = "Yes, do that";
    script[yes] = [{ kind: "apply_proposal", proposalId: shown.proposalId, evidence: "Yes, do that", basis: "owner" }];
    assert.equal(only((await say(w, chat, yes)).outcomes).status, "applied");
    assert.equal(await stateOf(), "approved");
    assert.ok(!(await list(w)).some((i) => i.kind === "approval"), "the answered item left the list");

    // The blocker: how it was resolved is the owner's own words.
    const said = "The bank confirmed the limit, so that blocker is resolved: the payment limit was raised";
    script[said] = [cmd("needs-you.answer", { itemTopic: "bank", answer: "the payment limit was raised" }, said)];
    const proposal = only((await say(w, chat, said)).outcomes);
    assert.equal(proposal.status, "proposed", JSON.stringify(proposal));
    assert.equal((await x.blockers.getBlocker(f.blocker))!.state, "open");
    script["Yes, resolve it"] = [{ kind: "apply_proposal", proposalId: proposal.proposalId, evidence: "Yes, resolve it", basis: "owner" }];
    assert.equal(only((await say(w, chat, "Yes, resolve it")).outcomes).status, "applied");
    const resolved = (await x.blockers.getBlocker(f.blocker))!;
    assert.deepEqual([resolved.state, (resolved as unknown as { resolution: string }).resolution], ["resolved", "the payment limit was raised"]);

    // The meeting's question.
    const reply = "Run the nightly build at 02:00, that is fine";
    script[reply] = [cmd("needs-you.answer", { itemTopic: "nightly build", answer: reply }, reply)];
    const asked = only((await say(w, chat, reply)).outcomes);
    assert.equal(asked.status, "proposed", JSON.stringify(asked));
    script["Yes, send that answer"] = [{ kind: "apply_proposal", proposalId: asked.proposalId, evidence: "Yes, send that answer", basis: "owner" }];
    assert.equal(only((await say(w, chat, "Yes, send that answer")).outcomes).status, "applied");
    const after = await x.meetings.ownerQuestions(w.owner, f.project);
    assert.deepEqual([after.open.length, after.answered.length, after.answered[0]?.answer], [0, 1, reply]);
    assert.deepEqual(await list(w), [], "nothing is left waiting");
  });

  suite("a choice the item does not offer, a wrong kind of item, an unknown item and an item that is not the owner's are refused and change nothing; only the owner answers, never an agent or a task credential", async (w, script, x) => {
    const f = await furnish(w, x);
    const call = (token: string, args: Record<string, unknown>, id = cid("n")) => w.api.handle(token, { v: API_VERSION, op: "needs-you.answer", commandId: id, args } as never);
    const refused = async (args: Record<string, unknown>, code: string): Promise<void> => { const r = await call(w.ownerToken, args); assert.ok(!r.ok && r.error.code === code, `${JSON.stringify(args)}: ${JSON.stringify(r)}`); };
    await refused({ kind: "approval", id: f.review, answer: "maybe" }, "invalid_command");
    await refused({ kind: "approval", id: "rvw-aaaaaaaaaaaaaaaaaaaa", answer: "allow" }, "not_found");
    await refused({ kind: "blocker", id: "blk-aaaaaaaaaaaaaaaaaaaa", answer: "done" }, "not_found");
    await refused({ kind: "stranger", id: f.review, answer: "allow" }, "invalid_command");
    await refused({ kind: "approval", id: f.review, answer: "allow", note: "x" }, "invalid_command");
    // A blocker that an agent resolves is not the owner's to answer here.
    const theirs = (await x.blockers.openBlocker({ commandId: cid("b"), actor: "owner:rob", type: "manual_hold", subject: { kind: "task", id: f.task }, summary: "Waiting for the agent", resolver: "agent:ann" } as never)).id;
    await refused({ kind: "blocker", id: theirs, answer: "done" }, "forbidden");
    assert.equal((await x.reviews.get(w.owner, f.review))!.state, "owner-decision");
    assert.equal((await x.blockers.getBlocker(f.blocker))!.state, "open");
    // Nobody but the owner.
    const task = await w.agent("tcr-holder", [{ action: "*", project: "*" }]);
    for (const token of [f.ann.token, task.token]) {
      const r = await call(token, { kind: "approval", id: f.review, answer: "allow" });
      assert.ok(!r.ok && r.error.code === "forbidden", JSON.stringify(r));
    }
    assert.equal((await x.reviews.get(w.owner, f.review))!.state, "owner-decision");
    // A review decided meanwhile no longer waits, and answering it again is refused with where it stands.
    assert.ok((await call(w.ownerToken, { kind: "approval", id: f.review, answer: "deny" })).ok);
    assert.equal((await x.reviews.get(w.owner, f.review))!.state, "denied");
    await refused({ kind: "approval", id: f.review, answer: "allow" }, "invalid_transition");
    // The same command ID again answers once.
    const once = cid("once");
    assert.ok((await call(w.ownerToken, { kind: "blocker", id: f.blocker, answer: "done" }, once)).ok);
    assert.ok((await call(w.ownerToken, { kind: "blocker", id: f.blocker, answer: "done" }, once)).ok);
  });

  suite("two items that fit the owner's words are asked about, and the owner's pick answers that one; words that fit no item, or a choice no item offers, answer nothing", async (w, script, x) => {
    const f = await furnish(w, x);
    const second = (await x.blockers.openBlocker({ commandId: cid("b"), actor: "owner:rob", type: "manual_hold", subject: { kind: "task", id: f.task }, summary: "The bank wants a signed form", resolver: "owner" } as never)).id;
    const chat = w.chat();
    const words = "The bank thing is sorted, resolved by the signed form";
    script[words] = [cmd("needs-you.answer", { itemTopic: "bank", answer: "resolved by the signed form" }, words)];
    const turn = await say(w, chat, words);
    const asked = only(turn.outcomes);
    assert.equal(asked.status, "asked", JSON.stringify(asked));
    assert.ok((asked.options ?? []).length === 2, JSON.stringify(asked));
    assert.ok((asked.options ?? []).some((o) => o.startsWith(second)), "the offer names the signed-form blocker");
    script["the signed form one, please"] = [{ kind: "answer", turnId: turn.turnId, choice: second, evidence: "the signed form one", basis: "owner" }];
    const picked = only((await say(w, chat, "the signed form one, please")).outcomes);
    assert.equal(picked.status, "proposed", JSON.stringify(picked));
    script["Yes, that one"] = [{ kind: "apply_proposal", proposalId: picked.proposalId, evidence: "Yes, that one", basis: "owner" }];
    assert.equal(only((await say(w, chat, "Yes, that one")).outcomes).status, "applied");
    assert.equal((await x.blockers.getBlocker(second))!.state, "resolved");
    assert.equal((await x.blockers.getBlocker(f.blocker))!.state, "open", "the other one was not touched");
    // Words that fit nothing; a choice (allow) no blocker offers.
    script["allow the garage door"] = [cmd("needs-you.answer", { itemTopic: "garage door", answer: "allow" }, "allow the garage door")];
    assert.equal(only((await say(w, chat, "allow the garage door")).outcomes).status, "refused");
    script["allow the bank blocker"] = [cmd("needs-you.answer", { itemTopic: "bank", answer: "allow" }, "allow the bank blocker")];
    assert.equal(only((await say(w, chat, "allow the bank blocker")).outcomes).status, "refused");
    assert.equal((await x.reviews.get(w.owner, f.review))!.state, "owner-decision");
  });
}
