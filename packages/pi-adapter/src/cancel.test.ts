import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { requestId, type SemanticResult } from "@nimblenewt/contracts";
import { fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { AlreadyReadmittedError, InvalidReadmissionError, NoBranchPointError, NotRetainedError, PiAdapter, RequestIdConflictError, type AdapterTool } from "./index.js";
import { OFFLINE_MODEL_REF, createOfflineModels } from "./testing/offline.js";

const adapters: PiAdapter[] = [];
afterEach(async () => { for (const adapter of adapters.splice(0)) await adapter.close(); });

async function open(tools: readonly AdapterTool[] = [], models: Parameters<typeof createOfflineModels>[0] = {}) {
  const offline = createOfflineModels(models);
  const adapter = await PiAdapter.open({ storage: new MemoryStorage(), models: offline.models, model: OFFLINE_MODEL_REF, tools });
  adapters.push(adapter);
  return { adapter, faux: offline.faux };
}
const input = (id: string, content: string) => ({ kind: "input", requestId: requestId(id), content }) as const;
const text = (r: SemanticResult) => ("text" in r ? r.text : "");

function holdingTool() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const up = new Promise<void>((resolve) => { started = resolve; });
  let aborted = false;
  const tool: AdapterTool = {
    name: "hold", description: "Waits", parameters: Type.Object({}),
    execute: async (_args, { signal }) => { signal?.addEventListener("abort", () => { aborted = true; release(); }); started(); await gate; return "held"; },
  };
  return { tool, release, up, wasAborted: () => aborted };
}

/** A running request A (blocked in a tool) with B and C queued behind it. */
async function busyWithQueue() {
  const hold = holdingTool();
  const world = await open([hold.tool]);
  let modelCalls = 0;
  world.faux.setResponses([
    () => { modelCalls += 1; return fauxAssistantMessage(fauxToolCall("hold", {}, { id: "h1" }), { stopReason: "toolUse" }); },
    () => { modelCalls += 1; return fauxAssistantMessage("ran later"); },
    () => { modelCalls += 1; return fauxAssistantMessage("ran later too"); },
  ]);
  const conversation = world.adapter.root();
  const a = await conversation.submit(input("A", "first"));
  await hold.up;
  const b = await conversation.submit(input("B", "second"));
  const c = await conversation.submit({ kind: "update", requestId: requestId("C"), content: "third", source: { conversationId: 99, entryId: 7 } });
  return { ...world, ...hold, conversation, a, b, c, modelCalls: () => modelCalls };
}

test("aborting reports what was stopped and what was withdrawn before starting; withdrawn requests do nothing", async () => {
  const w = await busyWithQueue();
  const report = await w.conversation.abort();
  assert.deepEqual([report.aborted, report.retained], [["A"], ["B", "C"]]);
  assert.ok(w.wasAborted(), "the running tool did not receive the abort signal");

  const [ra, rb, rc] = [await w.a.result(), await w.b.result(), await w.c.result()];
  assert.deepEqual([ra.status, ra.status === "unanswered" ? ra.reason : "", "retained" in ra], ["unanswered", "aborted", false]);
  for (const r of [rb, rc]) assert.deepEqual([r.status, r.status === "unanswered" && r.reason, r.status === "unanswered" && r.retained], ["unanswered", "aborted", true]);
  assert.equal(w.modelCalls(), 1, "a withdrawn request reached the model");
});

test("withdrawn requests are listed with their payloads and run only when the controller readmits them", async () => {
  const w = await busyWithQueue();
  await w.conversation.abort();
  await w.b.result(); await w.c.result();

  const retained = await w.conversation.retainedRequests();
  assert.deepEqual(retained.map((r) => [r.requestId, r.request.kind, r.request.content]), [["B", "input", "second"], ["C", "update", "third"]]);
  assert.deepEqual(retained[1]?.request.kind === "update" && retained[1].request.source, { conversationId: 99, entryId: 7 });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(w.modelCalls(), 1, "retained requests ran without being readmitted");

  const again = await w.conversation.readmit(requestId("B"), requestId("B-again"));
  const result = await again.result();
  assert.equal(result.status, "completed");
  assert.equal(text(result), "ran later");
  assert.equal((await w.conversation.readmit(requestId("B"), requestId("B-again"))).submissionId, again.submissionId, "readmitting twice under one ID is idempotent");
  await assert.rejects(w.conversation.readmit(requestId("B"), requestId("B-other")), AlreadyReadmittedError);
  assert.deepEqual((await w.conversation.retainedRequests()).map((r) => r.requestId), ["C"]);

  // The readmitted update is still an update, with its provenance.
  await (await w.conversation.readmit(requestId("C"), requestId("C-again"))).result();
  const transcript = await w.conversation.transcript();
  const update = transcript.find((e) => e.kind === "nimblenewt.update");
  assert.deepEqual(update?.data, { source: { conversationId: 99, entryId: 7 } });
});

test("only requests that never started can be readmitted", async () => {
  const w = await busyWithQueue();
  await w.conversation.abort();
  await w.a.result();
  await assert.rejects(w.conversation.readmit(requestId("A"), requestId("A2")), NotRetainedError); // started, then aborted
  await assert.rejects(w.conversation.readmit(requestId("never-submitted"), requestId("X")), NotRetainedError);
});

test("aborting an idle conversation, or twice, reports nothing new", async () => {
  const { adapter, faux } = await open();
  faux.setResponses([fauxAssistantMessage("done")]);
  const conversation = adapter.root();
  await (await conversation.submit(input("idle-1", "hi"))).result();
  assert.deepEqual(await conversation.abort(), { aborted: [], retained: [] });
  const w = await busyWithQueue();
  await w.conversation.abort();
  assert.deepEqual(await w.conversation.abort(), { aborted: [], retained: [] });
});

test("aborting while a tool call's arguments are still streaming never runs the tool and keeps the partial call out of later context", async () => {
  let executions = 0;
  const danger: AdapterTool<ReturnType<typeof Type.Object<{ payload: ReturnType<typeof Type.String> }>>> = {
    name: "danger", description: "Has an effect", parameters: Type.Object({ payload: Type.String() }),
    execute: async () => { executions += 1; return "ran"; },
  };
  const { adapter, faux } = await open([danger as unknown as AdapterTool], { slowStream: { tokensPerSecond: 40, tokenSize: 3 } });
  const conversation = adapter.root();
  let nextSaw = "";
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("danger", { payload: "x".repeat(400) }, { id: "partial-1" }), { stopReason: "toolUse" }),
    (context) => { nextSaw = JSON.stringify(context.messages); return fauxAssistantMessage("next answer"); },
  ]);
  const first = await conversation.submit(input("stream-1", "go"));
  await new Promise((resolve) => setTimeout(resolve, 400)); // part-way through the arguments (checked below)
  assert.equal((await conversation.abort()).aborted[0], "stream-1");
  const aborted = await first.result();
  assert.deepEqual([aborted.status, aborted.status === "unanswered" && aborted.reason, aborted.toolCalls], ["unanswered", "aborted", []]);
  assert.equal(executions, 0, "a partially streamed tool call was executed");
  // Prove the abort really landed mid tool call, so this test cannot pass vacuously on a slow or fast runner.
  const partial = (await conversation.transcript()).find((e) => e.kind === "pi.assistant");
  assert.deepEqual([partial?.stopReason, partial?.toolCallIds], ["aborted", ["partial-1"]], "the abort did not land while the tool call was streaming");

  await assert.rejects(conversation.branch({ requestId: requestId("after-abort") }), NoBranchPointError, "an aborted partial turn must not be a fork point");
  const second = await (await conversation.submit(input("stream-2", "second"))).result();
  assert.equal(second.status, "completed");
  assert.equal(executions, 0);
  assert.ok(nextSaw.includes("second"), "the second request should reach the model");
  assert.ok(!nextSaw.includes("partial-1") && !nextSaw.includes('"type":"toolCall"'), `the partial tool call reached the model: ${nextSaw}`);
});

test("aborting a task does not abort its inquiry branch, and aborting the branch does not touch the task", async () => {
  const hold = holdingTool();
  const { adapter, faux } = await open([hold.tool]);
  const parent = adapter.root();
  faux.setResponses([fauxAssistantMessage("task answer")]);
  await (await parent.submit(input("t-1", "task"))).result();
  const branch = await parent.branch({ requestId: requestId("inq") });

  faux.setResponses([fauxAssistantMessage(fauxToolCall("hold", {}, { id: "h" }), { stopReason: "toolUse" }), fauxAssistantMessage("inquiry done")]);
  const inquiry = await branch.conversation.submit(input("q-1", "inquire"));
  await hold.up;
  assert.deepEqual(await parent.abort(), { aborted: [], retained: [] }); // nothing running in the parent
  assert.equal(hold.wasAborted(), false, "aborting the parent aborted the branch's tool");
  hold.release();
  assert.equal((await inquiry.result()).status, "completed");
});

test("readmitting concurrently under different new IDs runs the request once; under the same ID it is idempotent", async () => {
  const w = await busyWithQueue();
  await w.conversation.abort();
  await w.b.result();
  const outcomes = await Promise.allSettled([
    w.conversation.readmit(requestId("B"), requestId("B-n1")),
    w.conversation.readmit(requestId("B"), requestId("B-n2")),
  ]);
  assert.deepEqual(outcomes.map((o) => o.status).sort(), ["fulfilled", "rejected"]);
  const rejected = outcomes.find((o): o is PromiseRejectedResult => o.status === "rejected");
  assert.ok(rejected?.reason instanceof AlreadyReadmittedError);
  const winner = outcomes.find((o): o is PromiseFulfilledResult<Awaited<ReturnType<typeof w.conversation.readmit>>> => o.status === "fulfilled");
  assert.equal((await winner?.value.result())?.status, "completed");
  assert.equal(w.modelCalls(), 2, "the retained request ran more than once (1 for A, 1 for B)");

  const same = await Promise.all([w.conversation.readmit(requestId("C"), requestId("C-n")), w.conversation.readmit(requestId("C"), requestId("C-n"))]);
  assert.equal(same[0].submissionId, same[1].submissionId);
});

test("the instruction of a request that had started and was aborted stays in the model's context (current behaviour, pinned)", async () => {
  const hold = holdingTool();
  const { adapter, faux } = await open([hold.tool]);
  const conversation = adapter.root();
  faux.setResponses([fauxAssistantMessage(fauxToolCall("hold", {}, { id: "h" }), { stopReason: "toolUse" })]);
  const started = await conversation.submit(input("risky", "DELETE-ALL-FILES-INSTRUCTION"));
  await hold.up;
  await conversation.abort();
  await started.result();

  let nextSaw = "";
  faux.setResponses([(context) => { nextSaw = JSON.stringify(context.messages); return fauxAssistantMessage("ok"); }]);
  await (await conversation.submit(input("later", "something else"))).result();
  // Pi keeps an aborted, started request's input in later context. Nothing re-runs it, but the model can see it and may
  // act on it. Changing this (hide the entry, or frame it as aborted) is the F06c2 decision; a change must update this test.
  assert.ok(nextSaw.includes("DELETE-ALL-FILES-INSTRUCTION"));
});

test("readmitting under the request's own ID is refused", async () => {
  const w = await busyWithQueue();
  await w.conversation.abort();
  await w.b.result();
  await assert.rejects(w.conversation.readmit(requestId("B"), requestId("B")), InvalidReadmissionError);
});

test("a readmission refused because the new ID is taken gives the claim back, so another new ID still works", async () => {
  const w = await busyWithQueue();
  await w.conversation.abort();
  await w.b.result();
  // "taken" is already used by a different request, so submitting B's payload under it is a conflict.
  w.faux.setResponses([fauxAssistantMessage("taken answer"), fauxAssistantMessage("B finally")]);
  await (await w.conversation.submit(input("taken", "a different payload"))).result();
  await assert.rejects(w.conversation.readmit(requestId("B"), requestId("taken")), RequestIdConflictError);
  assert.deepEqual((await w.conversation.retainedRequests()).map((r) => r.requestId), ["B", "C"], "the refused readmission should not hide B");
  const retry = await w.conversation.readmit(requestId("B"), requestId("B-retry"));
  assert.equal((await retry.result()).status, "completed");
});
