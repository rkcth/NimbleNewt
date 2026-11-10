import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { requestId } from "@nimblenewt/contracts";
import { CONTINUATION_MARK, PiAdapter, type AdapterTool, type ContinuationPolicy, type PiAdapterOptions } from "./index.js";
import { OFFLINE_MODEL_REF, createOfflineModels } from "./testing/offline.js";

/** Card W04 at the adapter: Pi Durable's onYield hook continues the same turn, counted in a document of the conversation, bounded, and the turn's result covers the calls after a continuation. */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

const input = (id: string, content: string) => ({ kind: "input", requestId: requestId(id), content }) as const;
const step: AdapterTool = { name: "step", description: "Does a step", parameters: Type.Object({}), execute: async () => "stepped" };

async function open(policy: ContinuationPolicy | undefined, extra: Partial<PiAdapterOptions> = {}) {
  const offline = createOfflineModels();
  const adapter = await PiAdapter.open({ storage: new MemoryStorage(), models: offline.models, model: OFFLINE_MODEL_REF, tools: [step], ...(policy === undefined ? {} : { continuation: policy }), ...extra });
  cleanup.push(() => adapter.close());
  return { adapter, faux: offline.faux };
}

/** A policy that always says yes, and keeps what it was asked. */
function yes(text = "go on") {
  const asked: { n: number; max: number; turn: string; stopReason: string; visible: string }[] = [];
  const policy: ContinuationPolicy = { decide: async (a, ask) => { asked.push({ ...ask, stopReason: a.stopReason, visible: a.visibleText }); return text; } };
  return { policy, asked };
}

const thinkingOnly = () => fauxAssistantMessage([fauxThinking("hmm")]);

test("a turn that yields thinking-only twice and then calls a tool is continued twice, in the same turn, and its result has the tool call and the last answer", async () => {
  const { policy, asked } = yes();
  const { adapter, faux } = await open(policy);
  const seen: string[] = [];
  faux.setResponses([
    thinkingOnly(),
    thinkingOnly(),
    (ctx) => { seen.push(JSON.stringify(ctx.messages)); return fauxAssistantMessage(fauxToolCall("step", {}, { id: "s1" }), { stopReason: "toolUse" }); },
    fauxAssistantMessage("all steps done"),
    // "all steps done" has no tool call and no work.end either: it is continued a third time, and this answer is the turn's last.
    fauxAssistantMessage("after the third nudge"),
  ]);
  await adapter.beginTurn("req-1");
  const result = await (await adapter.root().submit(input("req-1", "do the steps"))).result();
  assert.equal(result.status, "completed");
  // Three answers ended without a tool call before the bound: thinking, thinking, "all steps done".
  assert.deepEqual(asked.map((a) => a.n), [1, 2, 3]);
  assert.ok(asked.every((a) => a.turn === "req-1" && a.max === 3));
  assert.equal(result.status === "completed" ? result.text : "", "after the third nudge");
  assert.deepEqual(result.toolCalls.map((c) => c.name), ["step"], "the call after a continuation belongs to the turn");
  assert.ok(seen[0]!.includes(`${CONTINUATION_MARK} go on`), "the model saw the nudge");
  assert.equal((await adapter.continuations()).used, 3);
});

test("a turn that never calls a tool gets exactly the bound, then its last answer ends it; nothing loops", async () => {
  const { policy, asked } = yes();
  const { adapter, faux } = await open({ ...policy, max: 3 });
  let calls = 0;
  faux.setResponses(Array.from({ length: 10 }, () => () => { calls++; return thinkingOnly(); }));
  await adapter.beginTurn("req-1");
  const result = await (await adapter.root().submit(input("req-1", "work"))).result();
  assert.equal(result.status, "completed");
  assert.equal(calls, 4, "the first answer and three continuations");
  assert.deepEqual(asked.map((a) => a.n), [1, 2, 3]);
  assert.deepEqual(await adapter.continuations(), { turn: "req-1", used: 3, length: 0, ended: false });
});

test("a length stop is continued and is not the turn's answer; it is counted as a length continuation", async () => {
  const { policy, asked } = yes();
  // Only the length stop is continued here, so the turn ends on the answer after the tool call.
  const { adapter, faux } = await open({ decide: async (a, ask) => (a.stopReason === "length" ? policy.decide(a, ask) : undefined) });
  faux.setResponses([fauxAssistantMessage("The report so far: step one is", { stopReason: "length" }), fauxAssistantMessage(fauxToolCall("step", {}, { id: "s1" }), { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("done")])]);
  await adapter.beginTurn("req-1");
  const result = await (await adapter.root().submit(input("req-1", "report"))).result();
  assert.equal(result.status === "completed" ? result.text : "", "done", "the cut-off reply is not the answer");
  assert.deepEqual(asked.map((a) => a.stopReason), ["length"]);
  assert.deepEqual(await adapter.continuations(), { turn: "req-1", used: 1, length: 1, ended: false });
});

test("a policy that declines, or throws, lets the answer end the turn; a turn after work ended, or a turn not begun, is never continued", async () => {
  const errors: unknown[] = [];
  const declining = await open({ decide: async () => undefined });
  declining.faux.setResponses([thinkingOnly(), fauxAssistantMessage("unused")]);
  await declining.adapter.beginTurn("r");
  assert.equal((await (await declining.adapter.root().submit(input("r", "x"))).result()).status, "completed");
  assert.equal(declining.faux.getPendingResponseCount(), 1);
  assert.equal((await declining.adapter.continuations()).used, 0);

  const throwing = await open({ decide: async () => { throw new Error("no"); }, onError: (e) => errors.push(e) });
  throwing.faux.setResponses([thinkingOnly(), fauxAssistantMessage("unused")]);
  await throwing.adapter.beginTurn("r");
  await (await throwing.adapter.root().submit(input("r", "x"))).result();
  assert.equal(throwing.faux.getPendingResponseCount(), 1);
  assert.equal(errors.length, 1);

  const { policy, asked } = yes();
  const ended = await open(policy);
  ended.faux.setResponses([thinkingOnly(), fauxAssistantMessage("unused")]);
  await ended.adapter.beginTurn("r");
  await ended.adapter.markWorkEnded();
  await (await ended.adapter.root().submit(input("r", "x"))).result();
  assert.equal(asked.length, 0, "the policy is not even asked after work ended");

  const unbegun = await open(policy);
  unbegun.faux.setResponses([thinkingOnly(), fauxAssistantMessage("unused")]);
  await (await unbegun.adapter.root().submit(input("r", "x"))).result();
  assert.equal(asked.length, 0);
});

test("each turn has its own count; the same turn begun again keeps it; max 0 installs nothing and a bad max is refused", async () => {
  const { policy, asked } = yes();
  const { adapter, faux } = await open({ ...policy, max: 1 });
  faux.setResponses([thinkingOnly(), thinkingOnly(), thinkingOnly(), thinkingOnly()]);
  await adapter.beginTurn("t1");
  await (await adapter.root().submit(input("t1", "a"))).result();
  assert.deepEqual(await adapter.beginTurn("t1"), { turn: "t1", used: 1, length: 0, ended: false }, "the same turn again keeps its count");
  assert.deepEqual(await adapter.beginTurn("t2"), { turn: "t2", used: 0, length: 0, ended: false }, "a new turn starts at 0");
  await (await adapter.root().submit(input("t2", "b"))).result();
  assert.deepEqual(asked.map((a) => `${a.turn}:${a.n}`), ["t1:1", "t2:1"]);

  const off = await open({ ...policy, max: 0 });
  off.faux.setResponses([thinkingOnly(), fauxAssistantMessage("unused")]);
  await off.adapter.beginTurn("x");
  await (await off.adapter.root().submit(input("x", "a"))).result();
  assert.equal(off.faux.getPendingResponseCount(), 1);
  await assert.rejects(open({ ...policy, max: 11 }), /from 0 to 10/);
});

test("a branch of the conversation is never continued: only the root's turn is", async () => {
  const { policy, asked } = yes();
  const { adapter, faux } = await open(policy);
  faux.setResponses([fauxAssistantMessage("root answer")]);
  await (await adapter.root().submit(input("root-1", "start"))).result();
  const branch = await adapter.root().branch({ requestId: requestId("b-1") });
  await adapter.beginTurn("b-ask");
  faux.setResponses([thinkingOnly(), fauxAssistantMessage("unused")]);
  await (await branch.conversation.submit(input("b-ask", "inquire"))).result();
  assert.equal(asked.length, 0);
});
