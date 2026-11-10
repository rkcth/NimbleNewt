import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BlockerService } from "@nimblenewt/controller";
import { rig, sandbox } from "./w03-rig-support.js";

// Card W03, end to end: the composed controller with the real local worker (bubblewrap, the worker process running Pi) and the real checkout layout. A fixture agent that keeps stopping without work.end is never recorded
// succeeded: its attempt goes on twice from the turn's checkpoint, in the same conversation (the model sees the earlier turns) on the same host, and then the task carries an agent_stopped_early blocker with its last text,
// its plan progress and the diff stat the host read from its checkout. An agent that ends with work.end done succeeds as before, in one run. Skipped without bubblewrap unless NIMBLENEWT_REQUIRE_SANDBOX=1 (set in CI).
// Since card W04 each of those turns is first nudged three times inside the turn (four model calls a run); the runs are what W03 counts.
test("an agent that keeps stopping without work.end goes on twice in the same conversation on the same host, then the task gets a blocker with its last text, plan and diff (card W03)", async (t) => {
  const launcher = await sandbox(t);
  if (launcher === undefined) return;
  // Each run is the turn's first reply and three nudged ones (card W04).
  const run = (first: string, then: string): { text: string }[] => [{ text: first }, { text: then }, { text: then }, { text: then }];
  const x = await rig(launcher, [...run("First I read the parser.", "Still reading."), ...run("Now I fix the parser.", "Still fixing."), ...run("Next I will run the tests.", "Next I will run the tests.")]);
  try {
    await x.run();
    let d = await x.get();
    assert.notEqual(d.outcome?.status, "succeeded");
    assert.equal(d.state, "waiting", JSON.stringify(d.outcome));
    assert.equal(d.turnEnd?.endKind, "no-work-end");
    assert.equal(d.turnEnd?.nudges, 3, "the turn was nudged three times before it stopped early (W04)");
    assert.equal(d.pinnedHost, "host:w1");
    assert.ok(d.resumeFrom !== undefined, "it goes on from the turn's checkpoint");
    // The agent's work so far, in its checkout.
    const where = x.ws.locate({ taskId: x.taskId, projectId: x.project })!;
    writeFileSync(join(where.checkout, "PLAN.md"), "- [x] read the parser\n- [ ] fix the parser\n- [ ] run the tests\n");
    writeFileSync(join(where.checkout, "src", "a.ts"), "export const a = 2;\n");

    await x.run();
    d = await x.get();
    assert.equal(d.state, "waiting");
    assert.equal(d.turnRound, 2);
    // The same conversation: the second run's request holds the first turn's reply, and the note that it goes on.
    assert.equal(x.answer.seen.length, 8);
    assert.match(x.answer.seen[4]!, /First I read the parser\./);
    assert.match(x.answer.seen[4]!, /This attempt goes on from where it stopped/);

    await x.run();
    d = await x.get();
    assert.equal(d.state, "finished");
    assert.equal(d.outcome?.status, "stopped-early");
    assert.equal(x.answer.seen.length, 12);
    assert.match(x.answer.seen[8]!, /Now I fix the parser\./, "the third run carries the second turn too");
    assert.equal(d.nudgesUsed, 9, "three runs of three nudges");
    const blocker = await BlockerService.withEpoch(x.c.storage, x.c.epoch).openFor("agent_stopped_early", { kind: "task", id: x.taskId });
    assert.ok(blocker);
    assert.match(blocker.summary, /Last visible text \(quoted\): "Next I will run the tests\."/);
    assert.match(blocker.summary, /1 of 3 step\(s\) checked; not checked: "fix the parser", "run the tests"/);
    assert.match(blocker.summary, /2 files changed, 4 insertions\(\+\), 1 deletion\(-\) against the task's base; 0 commit\(s\) ahead of the base/);
    await x.run();
    assert.equal(x.answer.seen.length, 12, "nothing starts again by itself");
  } finally { await x.close(); }
});

test("an agent that ends with work.end done succeeds in one run, as before (card W03)", async (t) => {
  const launcher = await sandbox(t);
  if (launcher === undefined) return;
  const x = await rig(launcher, [{ call: { name: "nimblenewt__work-end", args: { report: "Done as the task asked.", result: "done", note: "parser fixed" } } }, { text: "Ended: the parser is fixed." }]);
  try {
    await x.run();
    const d = await x.get();
    assert.equal(d.state, "finished");
    assert.equal(d.outcome?.status, "succeeded", d.outcome?.summary);
    assert.equal(d.turnEnd?.endKind, "normal");
    assert.equal(d.stoppedEarly, undefined);
    assert.equal(await BlockerService.withEpoch(x.c.storage, x.c.epoch).openFor("agent_stopped_early", { kind: "task", id: x.taskId }), undefined);
  } finally { await x.close(); }
});
