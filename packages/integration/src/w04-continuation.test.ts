import assert from "node:assert/strict";
import { test } from "node:test";
import { BlockerService } from "@nimblenewt/controller";
import { rig, sandbox } from "./w03-rig-support.js";

// Card W04, end to end: the composed controller, the real local worker (bubblewrap, the worker process running Pi Durable) and a scripted endpoint. A turn that yields without a tool call and without work.end is continued in the
// same turn with a fixed nudge, after the controller's bridge agreed (turn.continue); the nudges are recorded on the attempt. W03's readmit is the outer net once three nudges did not help. Skipped without bubblewrap unless
// NIMBLENEWT_REQUIRE_SANDBOX=1 (set in CI).
const NUDGE = /\[NimbleNewt: the turn goes on\] Remaining: the unchecked steps of your PLAN\.md\. Make the next tool call now\./;

test("an agent that yields thinking-only twice and then calls work.end is nudged twice in the same turn and succeeds in one run, with its nudges recorded (card W04)", async (t) => {
  const launcher = await sandbox(t);
  if (launcher === undefined) return;
  const x = await rig(launcher, [{ thinking: "I should read the parser." }, { thinking: "Then fix it." }, { call: { name: "nimblenewt__work-end", args: { report: "Done as the task asked.", result: "done", note: "parser fixed" } } }, { text: "Ended: the parser is fixed." }]);
  try {
    await x.run();
    const d = await x.get();
    assert.equal(d.state, "finished");
    assert.equal(d.outcome?.status, "succeeded", d.outcome?.summary);
    assert.equal(d.turnEnd?.endKind, "normal");
    assert.equal(d.turnEnd?.nudges, 2);
    assert.equal(d.nudgesUsed, 2);
    assert.equal(d.stoppedEarly, undefined, "no readmit: the nudges were enough");
    assert.equal(x.answer.seen.length, 4, "one turn: the first call, two nudged ones and the reply after work.end");
    assert.doesNotMatch(x.answer.seen[0]!, NUDGE);
    assert.match(x.answer.seen[1]!, NUDGE, "the model is given the nudge");
    assert.equal((x.answer.seen[2]!.match(/the turn goes on/g) ?? []).length, 2, "the second nudge follows the first in the same conversation");
    // Each nudge is a step of the task's activity, so the owner can see it.
    const steps = (await x.c.services.activity.steps(x.owner, x.taskId)).steps.map((s) => ("summary" in s ? s.summary : "")).filter((s) => /was continued \(nudge/.test(s));
    assert.equal(steps.length, 2, JSON.stringify(steps));
    assert.match(steps[0]!, /\(nudge 1 of 3\): it had ended as empty-visible-text, without a tool call or work\.end\./);
  } finally { await x.close(); }
});

test("an agent that never calls a tool gets exactly three nudges a turn; W03 then goes on twice and blocks the task, with every nudge recorded (card W04)", async (t) => {
  const launcher = await sandbox(t);
  if (launcher === undefined) return;
  const x = await rig(launcher, [{ thinking: "thinking, and nothing else" }]);
  try {
    await x.run();
    let d = await x.get();
    assert.equal(d.state, "waiting", "the turn stopped early after its nudges (W03)");
    assert.equal(d.turnEnd?.endKind, "empty-visible-text");
    assert.equal(d.turnEnd?.nudges, 3);
    assert.equal(x.answer.seen.length, 4, "the first call and exactly three nudged ones; no fourth");
    await x.run();
    await x.run();
    d = await x.get();
    assert.equal(d.outcome?.status, "stopped-early");
    assert.equal(x.answer.seen.length, 12, "each readmitted turn has its own three nudges");
    assert.deepEqual(d.stoppedEarly?.map((r) => r.nudges), [3, 3, 3]);
    assert.equal(d.nudgesUsed, 9);
    const blocker = await BlockerService.withEpoch(x.c.storage, x.c.epoch).openFor("agent_stopped_early", { kind: "task", id: x.taskId });
    assert.match(blocker?.summary ?? "", /after 3 nudge\(s\) to go on/);
    await x.run();
    assert.equal(x.answer.seen.length, 12, "nothing loops on");
  } finally { await x.close(); }
});

test("a paused task's turn is not nudged: the controller refuses the continuation and no further model call is made (card W04)", async (t) => {
  const launcher = await sandbox(t);
  if (launcher === undefined) return;
  let x: Awaited<ReturnType<typeof rig>> | undefined;
  // The task is paused while the agent's first reply is being made: the reply ends the turn and the nudge is refused.
  x = await rig(launcher, [{ thinking: "thinking", before: async () => { await x!.c.services.pauses.pause(x!.owner, { commandId: "pz", scope: { kind: "task", id: x!.taskId }, reason: "owner looks" } as never); } }]);
  try {
    await x.run();
    const d = await x.get();
    assert.equal(x.answer.seen.length, 1, "no nudged call while paused");
    assert.equal(d.turnEnd?.nudges ?? 0, 0);
  } finally { await x.close(); }
});
