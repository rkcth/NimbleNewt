import assert from "node:assert/strict";
import { test } from "node:test";
import { improvementOutcomeSink, ownerQuestionSink } from "./outcome-sink.js";

test("an improvement's outcome is filed against its own task once per key; one without a task is not filed and says so (card M03d)", async () => {
  const sent: { commandId: string; taskId: string; to: string; purpose: string; text: string }[] = [];
  const sink = improvementOutcomeSink({ noticeFromController: async (c) => { sent.push(c); } });
  const base = { key: "imp-1:3:agent:agt-x", kind: "improvement-outcome" as const, projectId: "proj-a", to: { kind: "agent" as const, id: "agent:agt-x" }, text: "It was adopted.", refs: [] };
  assert.equal(await sink.deliver({ ...base, taskId: "task-9" }), true);
  assert.deepEqual([sent[0]!.commandId, sent[0]!.taskId, sent[0]!.to, sent[0]!.text], ["imo:imp-1:3:agent:agt-x", "task-9", "agent:agt-x", "It was adopted."]);
  assert.equal(await sink.deliver(base), false, "no task of its own: not filed on an unrelated task");
  assert.equal(await sink.deliver({ ...base, kind: "agenda-outcome", to: { kind: "chat-turn", id: "t" }, taskId: "task-9" }), false, "only improvement outcomes to agents are filed here");
  assert.equal(sent.length, 1);
  // A notice that cannot be filed leaves the outcome waiting; it does not throw into the delivery of the others.
  const refusing = improvementOutcomeSink({ noticeFromController: async () => { throw new Error("x may not read that task"); } });
  assert.equal(await refusing.deliver({ ...base, taskId: "task-9" }), false);
});

test("a question a stand-up asked the owner is told by a short notification keyed by the question and, when it came from a chat turn, by a note on that turn; a notification that fails is retried, a turn that fails is not a reason to keep the owner uninformed (card M03h)", async () => {
  const notes: { commandId: string; questionId: string; projectId: string; detail: string }[] = [];
  const turns: { turn: string; key: string; text: string }[] = [];
  let failNotify = false;
  let failTurn = false;
  const sink = ownerQuestionSink({
    notify: async (c) => { if (failNotify) throw new Error("inbox full"); notes.push(c); },
    followUp: async (turn, f) => { if (failTurn) throw new Error("turn gone"); turns.push({ turn, ...f }); return true; },
  });
  const long = "Which of the two release trains should be the last to carry the old API, given that the mobile app still calls it and the next store review is a month away?";
  const n = { key: "sqn-a", questionId: "sqn-a", projectId: "proj-1", topic: "Old API", question: long, source: { kind: "chat-turn" as const, id: "turn-1" } };
  failNotify = true;
  assert.equal(await sink.raise(n), false, "no notification, so the delivery is tried again");
  assert.deepEqual([notes.length, turns.length], [0, 0]);
  failNotify = false; failTurn = true;
  assert.equal(await sink.raise(n), true, "the owner was told; a missing turn does not undo it");
  failTurn = false;
  assert.equal(await sink.raise(n), true);
  assert.equal(notes[0]!.commandId, "oqn:sqn-a");
  assert.ok(notes[0]!.detail.length <= 200, "the inbox keeps 200 characters");
  assert.match(notes[0]!.detail, /Old API/);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.key, "oqn:sqn-a");
  assert.match(turns[0]!.text, /the old API, given that the mobile app/, "the turn carries more of the question than the notification");
  // A topic that came from an inquiry or from nowhere has no turn to write on; the notification alone tells the owner.
  assert.equal(await sink.raise({ ...n, key: "sqn-b", questionId: "sqn-b", source: { kind: "inquiry" as const, id: "inq-1" } }), true);
  assert.equal(await sink.raise({ key: "sqn-c", questionId: "sqn-c", projectId: "proj-1", topic: "Logging", question: "Which level?" }), true);
  assert.equal(turns.length, 1);
  assert.equal(notes.length, 4);
});
