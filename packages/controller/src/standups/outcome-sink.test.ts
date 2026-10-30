import assert from "node:assert/strict";
import { test } from "node:test";
import { improvementOutcomeSink } from "./outcome-sink.js";

test("an improvement's outcome is filed against its own task once per key; one without a task is not filed and says so (card M03d)", async () => {
  const sent: { commandId: string; taskId: string; to: string; purpose: string; text: string }[] = [];
  const sink = improvementOutcomeSink({ noticeFromController: async (c) => { sent.push(c); } });
  const base = { key: "imp-1:3:agent:agt-x", kind: "improvement-outcome" as const, projectId: "proj-a", to: { kind: "agent" as const, id: "agent:agt-x" }, text: "It was adopted.", refs: [] };
  assert.equal(await sink.deliver({ ...base, taskId: "task-9" }), true);
  assert.deepEqual([sent[0]!.commandId, sent[0]!.taskId, sent[0]!.to, sent[0]!.text], ["imo:imp-1:3:agent:agt-x", "task-9", "agent:agt-x", "It was adopted."]);
  assert.equal(await sink.deliver(base), false, "no task of its own: not filed on an unrelated task");
  assert.equal(await sink.deliver({ ...base, kind: "agenda-outcome", to: { kind: "chat-turn", id: "t" }, taskId: "task-9" }), false, "only improvement outcomes to agents are filed here");
  assert.equal(sent.length, 1);
});
