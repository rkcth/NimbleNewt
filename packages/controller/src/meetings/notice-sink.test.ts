import assert from "node:assert/strict";
import { test } from "node:test";
import { meetingNoticeSink, meetingWindowSink } from "./notice-sink.js";

test("an agent that was away is told what the meeting decided, against the first task it touches, once per key (card M04c)", async () => {
  const sent: { commandId: string; taskId: string; to: string; purpose: string; text: string }[] = [];
  const sink = meetingNoticeSink({ noticeFromController: async (c) => { sent.push(c); } });
  await sink.notify({ key: "mto-aaa:agent:agt-bbb", agent: "agent:agt-bbb", occurrenceId: "mto-aaa", projectId: "proj-x", decisions: ["dec-1", "dec-2"], taskIds: ["task-1", "task-2"], dueAt: "2026-10-30T10:00:00.000Z" });
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0]!.commandId, sent[0]!.taskId, sent[0]!.to], ["mtn:mto-aaa:agent:agt-bbb", "task-1", "agent:agt-bbb"]);
  assert.match(sent[0]!.text, /dec-1; dec-2/);
  assert.match(sent[0]!.text, /task-1, task-2/);
  assert.match(sent[0]!.text, /acknowledge by 2026-10-30T10:00:00.000Z/);
  await sink.notify({ key: "k2", agent: "agent:agt-bbb", occurrenceId: "mto-aaa", projectId: "proj-x", decisions: [], taskIds: [], dueAt: "2026-10-30T10:00:00.000Z" });
  assert.equal(sent.length, 1, "no task, nothing to hang the notice on");
  await assert.rejects(meetingNoticeSink({ noticeFromController: async () => { throw new Error("inbox full"); } }).notify({ key: "k3", agent: "agent:agt-bbb", occurrenceId: "mto-aaa", projectId: "proj-x", decisions: ["d"], taskIds: ["t"], dueAt: "x" }), /inbox full/, "a failure reaches the attendance service, which keeps the agent in the unnotified list");
});

test("the window warnings are filed as controller notices against the task named, once per key (owner decision 2026-10-29)", async () => {
  const sent: { commandId: string; taskId: string; to: string; purpose: string; text: string }[] = [];
  const sink = meetingWindowSink({ noticeFromController: async (c) => { sent.push(c); } });
  for (const phase of ["ahead", "begins", "ends"] as const) await sink.notify({ key: `att-1:${phase}`, phase, agent: "agent:agt-bbb", occurrenceId: "mto-aaa", taskId: "task-1" });
  assert.deepEqual(sent.map((s) => [s.commandId, s.taskId]), [["mtw:att-1:ahead", "task-1"], ["mtw:att-1:begins", "task-1"], ["mtw:att-1:ends", "task-1"]]);
  assert.match(sent[0]!.text, /no long-running work/);
  assert.match(sent[1]!.text, /has begun/);
  assert.match(sent[2]!.text, /is over/);
});
