import assert from "node:assert/strict";
import { test } from "node:test";
import { rig, sandbox } from "./w03-rig-support.js";

// Card W07, end to end: the composed controller, the real local worker (bubblewrap, the worker process running Pi Durable), the controller's model relay and a scripted provider that records every request body it receives. A route's
// reply limit and reasoning cap reach the provider in the field names of the endpoint's kind; a route without them is sent what Pi built; a reply cut off at the limit is continued in the same turn with the nudge to stop deliberating and
// act, counted as a nudge; and a changed budget applies from the next call. Skipped without bubblewrap unless NIMBLENEWT_REQUIRE_SANDBOX=1 (set in CI).
const LENGTH_NUDGE = /\[NimbleNewt: the turn goes on\] Your last reply was cut off at the output limit: stop deliberating, act\./;
const WORK_END = { name: "nimblenewt__work-end", args: { result: "done", note: "parser fixed" } };

test("a route's reply limit and reasoning cap reach the provider through the relay; a length stop is continued with the stop deliberating, act nudge; a changed budget applies from the next call (card W07)", async (t) => {
  const launcher = await sandbox(t);
  if (launcher === undefined) return;
  let x: Awaited<ReturnType<typeof rig>> | undefined;
  // The owner lowers the limit while the first (cut-off) reply is being made: the nudged call after it carries the new figure.
  x = await rig(launcher, [
    { text: "Let me think about the parser in great detail. First, the grammar", length: true, before: async () => { await x!.c.services.routing.setRouteBudget(x!.owner, { commandId: "b2", route: "localp/small", maxTokens: 600, reasoningTokens: 200 }); } },
    { call: WORK_END },
    { text: "Ended: the parser is fixed." },
  ], { kind: "vllm" });
  try {
    await x.c.services.routing.setRouteBudget(x.owner, { commandId: "b1", route: "localp/small", maxTokens: 900, reasoningTokens: 300 });
    await x.run();
    const d = await x.get();
    assert.equal(d.outcome?.status, "succeeded", d.outcome?.summary);
    assert.equal(d.turnEnd?.endKind, "normal");
    assert.equal(d.turnEnd?.nudges, 1, "the length stop was continued once and counted as a nudge");
    assert.equal(d.nudgesUsed, 1);
    assert.equal(x.answer.bodies.length, 3, "one turn: the cut-off call, the nudged one and the reply after work.end");
    // At the provider, not in configuration: the first call carries the budget in force when it was sent, every later one the changed budget.
    assert.deepEqual([x.answer.bodies[0]!["max_tokens"], x.answer.bodies[0]!["thinking_token_budget"]], [900, 300]);
    for (const body of x.answer.bodies.slice(1)) assert.deepEqual([body["max_tokens"], body["thinking_token_budget"], body["max_completion_tokens"]], [600, 200, undefined]);
    assert.doesNotMatch(x.answer.seen[0]!, LENGTH_NUDGE);
    assert.match(x.answer.seen[1]!, LENGTH_NUDGE, "the model is told to stop deliberating and act");
    assert.doesNotMatch(x.answer.seen[1]!, /Ended: the parser is fixed/);
    const steps = (await x.c.services.activity.steps(x.owner, x.taskId)).steps.map((s) => ("summary" in s ? s.summary : ""));
    assert.match(steps.filter((s) => /was continued \(nudge/.test(s)).join("\n"), /\(nudge 1 of 3\): it had ended as length/);
    assert.equal(steps.filter((s) => /^Route localp\/small:/.test(s)).length, 0, "everything was sent, so nothing is recorded as not sent");
  } finally { await x.close(); }
});

test("a route without a budget is sent what Pi built, and an endpoint whose kind is not set gets no figure, which is recorded once on the task (card W07)", async (t) => {
  const launcher = await sandbox(t);
  if (launcher === undefined) return;
  const plain = await rig(launcher, [{ call: WORK_END }, { text: "Ended." }], { kind: "vllm" });
  try {
    await plain.run();
    assert.equal((await plain.get()).outcome?.status, "succeeded");
    // Pi's own figure: the channel model's maxTokens (1024 in this rig), in the field Pi chooses, and no reasoning budget.
    for (const body of plain.answer.bodies) assert.deepEqual([body["max_completion_tokens"], "max_tokens" in body, "thinking_token_budget" in body], [1024, false, false], "the body as Pi built it, as before W07");
  } finally { await plain.close(); }
  const unknown = await rig(launcher, [{ call: WORK_END }, { text: "Ended." }]);
  try {
    await unknown.c.services.routing.setRouteBudget(unknown.owner, { commandId: "b1", route: "localp/small", maxTokens: 900 });
    await unknown.run();
    assert.equal((await unknown.get()).outcome?.status, "succeeded");
    for (const body of unknown.answer.bodies) assert.deepEqual([body["max_completion_tokens"], "max_tokens" in body], [1024, false], "not sent: the relay does not know the field names, so Pi's figure stands");
    const steps = (await unknown.c.services.activity.steps(unknown.owner, unknown.taskId)).steps.map((s) => ("summary" in s ? s.summary : "")).filter((s) => /^Route localp\/small:/.test(s));
    assert.equal(steps.length, 1, `recorded once for the attempt, not once a call: ${JSON.stringify(steps)}`);
    assert.match(steps[0]!, /the reply limit \(900 tokens\) was not sent: the endpoint's kind is not set/);
  } finally { await unknown.close(); }
});
