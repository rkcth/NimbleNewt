import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { requestId } from "@nimblenewt/contracts";
import { fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import {
  InvalidBranchPointError, NoBranchPointError, PiAdapter, RequestIdConflictError, fingerprintsMatch, turnBoundaries,
  type AdapterTool,
} from "./index.js";
import { OFFLINE_MODEL_REF, createOfflineModels } from "./testing/offline.js";

const adapters: PiAdapter[] = [];
afterEach(async () => { for (const adapter of adapters.splice(0)) await adapter.close(); });

async function open(tools: readonly AdapterTool[] = []) {
  const offline = createOfflineModels();
  const adapter = await PiAdapter.open({ storage: new MemoryStorage(), models: offline.models, model: OFFLINE_MODEL_REF, tools });
  adapters.push(adapter);
  return { adapter, faux: offline.faux };
}
const input = (id: string, content: string) => ({ kind: "input", requestId: requestId(id), content }) as const;
const SENTINEL = "TOOL-SENTINEL-42";
const echo: AdapterTool = { name: "echo", description: "Returns the sentinel", parameters: Type.Object({}), execute: async () => SENTINEL };

/** The parent task: one turn with a tool call, then a final answer. Leaves the conversation idle at a boundary. */
async function finishedTask() {
  const world = await open([echo]);
  world.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("echo", {}, { id: "t1" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("task answer"),
  ]);
  await (await world.adapter.root().submit(input("task-1", "do the task"))).result();
  return world;
}

test("an inquiry branch sees the parent's full context, and the parent is left exactly unchanged", async () => {
  const { adapter, faux } = await finishedTask();
  const parent = adapter.root();
  const before = await parent.transcript();

  const branch = await parent.branch({ requestId: requestId("inq-1") });
  let childSaw = "";
  faux.setResponses([(context) => { childSaw = JSON.stringify(context.messages); return fauxAssistantMessage("inquiry answer"); }]);
  const inquiry = await (await branch.conversation.submit(input("ask-1", "How is it going?"))).result();

  assert.equal(inquiry.status, "completed");
  for (const expected of ["do the task", SENTINEL, "task answer", "How is it going?"]) {
    assert.ok(childSaw.includes(expected), `the inquiry could not see "${expected}": ${childSaw}`);
  }
  assert.deepEqual(await parent.transcript(), before, "the parent's history changed");
  assert.notEqual(branch.conversation.id, parent.id);
  assert.equal(branch.forkedAt, before.at(-1)?.id);
});

test("the parent's next model step does not see the inquiry, and the branch's history is separate", async () => {
  const { adapter, faux } = await finishedTask();
  const parent = adapter.root();
  const branch = await parent.branch({ requestId: requestId("inq-2") });
  faux.setResponses([fauxAssistantMessage("inquiry answer")]);
  await (await branch.conversation.submit(input("ask-2", "secret inquiry question"))).result();

  let parentSaw = "";
  faux.setResponses([(context) => { parentSaw = JSON.stringify(context.messages); return fauxAssistantMessage("carrying on"); }]);
  const resumed = await (await parent.submit(input("cont-1", "continue the task"))).result();
  assert.equal(resumed.status, "completed");
  assert.ok(parentSaw.includes("task answer") && parentSaw.includes("continue the task"));
  assert.ok(!parentSaw.includes("secret inquiry question") && !parentSaw.includes("inquiry answer"), `inquiry leaked into the parent: ${parentSaw}`);
  const parentText = (await parent.transcript()).map((e) => e.text).join("|");
  assert.ok(!parentText.includes("secret inquiry question"));
});

test("branching is idempotent by request ID, concurrently too, and a different fork point is a conflict", async () => {
  const { adapter } = await finishedTask();
  const parent = adapter.root();
  const [a, b] = await Promise.all([parent.branch({ requestId: requestId("idem-1") }), parent.branch({ requestId: requestId("idem-1") })]);
  assert.equal(a.conversation.id, b.conversation.id);
  const again = await parent.branch({ requestId: requestId("idem-1") });
  assert.deepEqual([again.conversation.id, again.forkedAt], [a.conversation.id, a.forkedAt]);
  // Naming the fork point the first call resolved is the same request; a different one is not.
  assert.equal((await parent.branch({ requestId: requestId("idem-1"), at: a.forkedAt })).conversation.id, a.conversation.id);
  await assert.rejects(parent.branch({ requestId: requestId("idem-1"), at: a.forkedAt - 1 }), RequestIdConflictError);
  assert.notEqual((await parent.branch({ requestId: requestId("idem-2") })).conversation.id, a.conversation.id);
});

test("branch points must be completed-turn boundaries", async () => {
  const empty = await open();
  await assert.rejects(empty.adapter.root().branch({ requestId: requestId("none-1") }), NoBranchPointError);

  const { adapter } = await finishedTask();
  const parent = adapter.root();
  const transcript = await parent.transcript();
  const userEntry = transcript.find((e) => e.kind === "pi.user");
  const toolCallEntry = transcript.find((e) => e.kind === "pi.assistant");
  assert.ok(userEntry && toolCallEntry);
  await assert.rejects(parent.branch({ requestId: requestId("bad-1"), at: userEntry.id }), InvalidBranchPointError);
  await assert.rejects(parent.branch({ requestId: requestId("bad-2"), at: toolCallEntry.id }), InvalidBranchPointError);
  await assert.rejects(parent.branch({ requestId: requestId("bad-3"), at: 99999 }), InvalidBranchPointError);
});

test("a branch taken while the parent is mid-turn forks at the last completed turn, not inside the running one", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const up = new Promise<void>((resolve) => { started = resolve; });
  const hold: AdapterTool = { name: "hold", description: "Waits", parameters: Type.Object({}), execute: async () => { started(); await gate; return "held"; } };
  const { adapter, faux } = await open([hold]);
  faux.setResponses([
    fauxAssistantMessage("turn one answer"),
    fauxAssistantMessage(fauxToolCall("hold", {}, { id: "h1" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("turn two answer"),
  ]);
  const parent = adapter.root();
  await (await parent.submit(input("turn-1", "first request"))).result();
  const turnOneEnd = (await parent.transcript()).at(-1)?.id;
  const running = await parent.submit(input("turn-2", "second request"));
  await up;

  const branch = await parent.branch({ requestId: requestId("mid-1") });
  assert.equal(branch.forkedAt, turnOneEnd);
  const childText = (await branch.conversation.transcript()).map((e) => e.text).join("|");
  assert.ok(childText.includes("first request") && !childText.includes("second request"));
  release();
  assert.equal((await running.result()).status, "completed");
});

test("a selected update is applied once, carries its provenance, and is seen by the parent's next step", async () => {
  const { adapter, faux } = await finishedTask();
  const parent = adapter.root();
  const branch = await parent.branch({ requestId: requestId("upd-branch") });
  faux.setResponses([fauxAssistantMessage("Use plan B.")]);
  await (await branch.conversation.submit(input("ask-3", "Which plan?"))).result();
  const answerEntry = (await branch.conversation.transcript()).at(-1);
  assert.ok(answerEntry);

  let modelCalls = 0;
  let parentSaw = "";
  faux.setResponses([(context) => { modelCalls += 1; parentSaw = JSON.stringify(context.messages); return fauxAssistantMessage("switching to plan B"); }]);
  const update = { kind: "update", requestId: requestId("upd-1"), content: "Decision: use plan B.", source: { conversationId: branch.conversation.id, entryId: answerEntry.id } } as const;
  const first = await parent.submit(update);
  const second = await parent.submit(update);
  assert.equal(second.submissionId, first.submissionId);
  assert.equal((await first.result()).status, "completed");
  assert.deepEqual(await second.result(), await first.result());

  assert.equal(modelCalls, 1);
  assert.ok(parentSaw.includes("Decision: use plan B."));
  const updates = (await parent.transcript()).filter((e) => e.kind === "nimblenewt.update");
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0]?.data, { source: { conversationId: branch.conversation.id, entryId: answerEntry.id }, run: true });
  await assert.rejects(parent.submit({ ...update, content: "Decision: use plan C." }), RequestIdConflictError);
});

test("without a selected update the parent resumes with its original context only", async () => {
  const { adapter, faux } = await finishedTask();
  const parent = adapter.root();
  const branch = await parent.branch({ requestId: requestId("noupd-branch") });
  faux.setResponses([fauxAssistantMessage("some answer")]);
  await (await branch.conversation.submit(input("ask-4", "Anything to change?"))).result();
  assert.equal((await parent.transcript()).filter((e) => e.kind === "nimblenewt.update").length, 0);
});

test("fingerprints from another version or an unknown format are treated as legacy and match", () => {
  assert.equal(fingerprintsMatch(undefined, "v1:sha256:aa"), true);
  assert.equal(fingerprintsMatch("v1:sha256:aa", "v1:sha256:aa"), true);
  assert.equal(fingerprintsMatch("v1:sha256:aa", "v1:sha256:bb"), false);
  assert.equal(fingerprintsMatch("v2:other:aa", "v1:sha256:bb"), true);
  assert.equal(fingerprintsMatch("aabbccddeeff", "v1:sha256:bb"), true); // F05-era raw hex
});

const entry = (id: number, kind: string, message: object) => ({ id, kind, model: [message] });
const call = (id: string) => ({ type: "toolCall", id, name: "echo", arguments: {} });

test("turnBoundaries: final answers and fully answered tool rounds are boundaries; inputs and open calls are not", () => {
  const entries = [
    entry(1, "pi.user", { role: "user", content: "go" }),
    entry(2, "pi.assistant", { role: "assistant", stopReason: "toolUse", content: [call("a"), call("b")] }),
    entry(3, "pi.tool-result", { role: "toolResult", toolCallId: "a" }),
    entry(4, "pi.tool-result", { role: "toolResult", toolCallId: "b" }),
    entry(5, "pi.assistant", { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] }),
    entry(6, "nimblenewt.update", { role: "user", content: "update" }),
    entry(7, "pi.assistant", { role: "assistant", stopReason: "toolUse", content: [call("c")] }),
  ];
  assert.deepEqual(turnBoundaries(entries), [4, 5], "parallel results end the round only after the last one; open calls are not a boundary");
  assert.deepEqual(turnBoundaries(entries.slice(0, 3)), [], "a half-answered tool round is not a boundary");
  assert.deepEqual(turnBoundaries([entry(1, "pi.user", { role: "user" }), entry(2, "pi.assistant", { role: "assistant", stopReason: "aborted", content: [] })]), []);
  assert.deepEqual(turnBoundaries([entry(9, "pi.assistant", { role: "assistant", stopReason: "stop", content: [] }), entry(8, "pi.compaction", {})]), [8, 9], "order is by id");
  assert.deepEqual(turnBoundaries([entry(1, "pi.assistant", { role: "assistant", stopReason: "stop", content: [] }), entry(2, "pi.compaction", {})]), [1, 2], "a compaction after the last answer is the newest boundary");
  assert.deepEqual(turnBoundaries([entry(1, "pi.assistant", { role: "assistant", stopReason: "toolUse", content: [call("x")] }), entry(2, "pi.compaction", {})]), [], "a compaction inside an open tool round is not a boundary");
  const answered = [entry(1, "pi.user", { role: "user" }), entry(2, "pi.assistant", { role: "assistant", stopReason: "stop", content: [] })];
  assert.deepEqual(turnBoundaries([...answered, entry(3, "pi.user", { role: "user" }), entry(4, "pi.compaction", {})]), [2], "a compaction after an unanswered input is not a boundary");
  assert.deepEqual(turnBoundaries([...answered, entry(3, "nimblenewt.update", { role: "user" }), entry(4, "pi.compaction", {})]), [2], "nor after an unanswered update");
  assert.deepEqual(turnBoundaries([...answered, entry(3, "pi.compaction", {})]), [2, 3], "an idle compaction after the last answer is");
  const round = [entry(3, "pi.user", { role: "user" }), entry(4, "pi.assistant", { role: "assistant", stopReason: "toolUse", content: [call("y")] }), entry(5, "pi.tool-result", { role: "toolResult", toolCallId: "y" })];
  assert.deepEqual(turnBoundaries([...answered, ...round, entry(6, "pi.compaction", {})]), [2, 5, 6], "a compaction after a fully answered tool round is");
});

test("a steered-in update starts its own segment: tool calls after it belong to the update, not the request it interrupted", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const up = new Promise<void>((resolve) => { started = resolve; });
  const hold: AdapterTool = { name: "hold", description: "Waits", parameters: Type.Object({}), execute: async () => { started(); await gate; return "held"; } };
  const { adapter, faux } = await open([hold, echo]);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("hold", {}, { id: "c1" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("echo", {}, { id: "c2" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("final"),
  ]);
  const a = await adapter.root().submit(input("seg-a", "start"));
  await up;
  const u = await adapter.root().submit({ kind: "update", requestId: requestId("seg-u"), content: "change course", whenBusy: "steer" });
  release();
  const [ra, ru] = [await a.result(), await u.result()];
  assert.deepEqual(ra.toolCalls.map((c) => c.callId), ["c1"]);
  assert.deepEqual(ru.toolCalls.map((c) => c.callId), ["c2"]);
});

test("after a compaction the default branch gets the compacted context, not the history the task no longer has", async () => {
  const offline = createOfflineModels();
  const adapter = await PiAdapter.open({
    storage: new MemoryStorage(), models: offline.models, model: OFFLINE_MODEL_REF, settings: { compaction: { keepRecentTokens: 1 } },
  });
  adapters.push(adapter);
  const parent = adapter.root();
  offline.faux.setResponses([
    fauxAssistantMessage("ANSWER-ONE"), fauxAssistantMessage("ANSWER-TWO"), fauxAssistantMessage("SUMMARY-OF-EARLIER-WORK"),
  ]);
  await (await parent.submit(input("c-1", "OLD-REQUEST-MARKER first"))).result();
  await (await parent.submit(input("c-2", "second request"))).result();
  await parent.compact();
  const entries = await parent.transcript();
  const compaction = entries.find((e) => e.kind === "pi.compaction");
  assert.ok(compaction, "the compaction entry should exist");

  const branch = await parent.branch({ requestId: requestId("after-compaction") });
  assert.equal(branch.forkedAt, compaction.id, "the default fork point is the compaction, not the answer before it");

  let childSaw = "";
  offline.faux.setResponses([(context) => { childSaw = JSON.stringify(context.messages); return fauxAssistantMessage("inquiry answer"); }]);
  await (await branch.conversation.submit(input("c-ask", "Where are we?"))).result();
  assert.ok(childSaw.includes("SUMMARY-OF-EARLIER-WORK"), `the branch did not get the summary: ${childSaw}`);
  assert.ok(!childSaw.includes("OLD-REQUEST-MARKER"), `the branch saw history that was compacted away: ${childSaw}`);
});

test("an explicit branch point before the latest compaction is allowed and sees the older, uncompacted history", async () => {
  const offline = createOfflineModels();
  const adapter = await PiAdapter.open({
    storage: new MemoryStorage(), models: offline.models, model: OFFLINE_MODEL_REF, settings: { compaction: { keepRecentTokens: 1 } },
  });
  adapters.push(adapter);
  const parent = adapter.root();
  offline.faux.setResponses([fauxAssistantMessage("ANSWER-ONE"), fauxAssistantMessage("ANSWER-TWO"), fauxAssistantMessage("A SUMMARY")]);
  await (await parent.submit(input("h-1", "HISTORIC-MARKER first"))).result();
  const firstAnswer = (await parent.transcript()).find((e) => e.kind === "pi.assistant");
  await (await parent.submit(input("h-2", "second request"))).result();
  await parent.compact();
  assert.ok(firstAnswer);

  const historic = await parent.branch({ requestId: requestId("historic"), at: firstAnswer.id });
  let childSaw = "";
  offline.faux.setResponses([(context) => { childSaw = JSON.stringify(context.messages); return fauxAssistantMessage("historic answer"); }]);
  await (await historic.conversation.submit(input("h-ask", "What did we start with?"))).result();
  assert.ok(childSaw.includes("HISTORIC-MARKER"));
});

test("a compaction that lands after the task's unanswered input is not a fork point: the branch never inherits the pending instruction", async () => {
  const offline = createOfflineModels({ contextWindow: 30000 });
  const adapter = await PiAdapter.open({
    storage: new MemoryStorage(), models: offline.models, model: OFFLINE_MODEL_REF,
    settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 16384 } },
  });
  adapters.push(adapter);
  const parent = adapter.root();

  let reachedAnswer!: () => void;
  const answerReached = new Promise<void>((resolve) => { reachedAnswer = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  offline.faux.setResponses([
    fauxAssistantMessage("ANSWER-ONE"),
    fauxAssistantMessage("SUMMARY-OF-FIRST-REQUEST"),
    async () => { reachedAnswer(); await gate; return fauxAssistantMessage("ANSWER-TWO"); },
  ]);
  await (await parent.submit(input("big-1", `FIRST-REQUEST ${"padding ".repeat(20000)}`))).result();
  const running = await parent.submit(input("big-2", "SECOND-TASK-INPUT please do it"));
  await answerReached; // Pi has compacted while preparing the second generation, and it is still unanswered

  const transcript = await parent.transcript();
  const kinds = transcript.map((e) => e.kind);
  assert.ok(kinds.lastIndexOf("pi.compaction") > kinds.lastIndexOf("pi.user"), `expected a compaction after the pending input: ${kinds.join(",")}`);

  const branch = await parent.branch({ requestId: requestId("pending-branch") });
  offline.faux.setResponses([]);
  const lastAnswer = [...transcript].reverse().find((e) => e.kind === "pi.assistant");
  assert.equal(branch.forkedAt, lastAnswer?.id, "the default fork point is the last answered turn");
  const childText = (await branch.conversation.transcript()).map((e) => e.text).join("|");
  assert.ok(!childText.includes("SECOND-TASK-INPUT"), "the branch inherited the task's unanswered instruction");

  release();
  assert.equal((await running.result()).status, "completed");
});

const placed = (id: string, content: string) => ({ kind: "update", requestId: requestId(id), content, run: false }) as const;

test("a place-only update is added to the transcript without asking the model anything, once, and the next run sees it", async () => {
  const { adapter, faux } = await finishedTask();
  const parent = adapter.root();
  let modelCalls = 0;
  let nextSaw = "";
  faux.setResponses([(context) => { modelCalls += 1; nextSaw = JSON.stringify(context.messages); return fauxAssistantMessage("continuing"); }]);

  const first = await parent.submit(placed("place-1", "Decision: use plan B."));
  const second = await parent.submit(placed("place-1", "Decision: use plan B."));
  assert.equal(second.submissionId, first.submissionId);
  const result = await first.result();
  assert.equal(result.status, "placed");
  assert.deepEqual(await second.result(), result);
  assert.equal(modelCalls, 0, "a place-only update must not ask the model anything");

  const updates = (await parent.transcript()).filter((e) => e.kind === "nimblenewt.update");
  assert.equal(updates.length, 1);
  assert.deepEqual([updates[0]?.id === (result.status === "placed" ? result.entryId : -1), updates[0]?.data, updates[0]?.text], [true, { source: null, run: false }, "Decision: use plan B."]);

  await (await parent.submit(input("after-place", "carry on"))).result();
  assert.equal(modelCalls, 1);
  assert.equal(nextSaw.split("Decision: use plan B.").length - 1, 1, "the update should reach the model exactly once");
  await assert.rejects(parent.submit({ ...placed("place-1", "Decision: use plan C.") }), RequestIdConflictError);
  await assert.rejects(parent.submit({ kind: "update", requestId: requestId("place-1"), content: "Decision: use plan B." }), RequestIdConflictError, "run: false is part of the request's identity");
});

test("a place-only update that arrives mid-run waits for the boundary and does not take over the run's tool calls", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const up = new Promise<void>((resolve) => { started = resolve; });
  const hold: AdapterTool = { name: "hold", description: "Waits", parameters: Type.Object({}), execute: async () => { started(); await gate; return "held"; } };
  const { adapter, faux } = await open([hold, echo]);
  let modelCalls = 0;
  faux.setResponses([
    () => { modelCalls += 1; return fauxAssistantMessage(fauxToolCall("hold", {}, { id: "c1" }), { stopReason: "toolUse" }); },
    () => { modelCalls += 1; return fauxAssistantMessage(fauxToolCall("echo", {}, { id: "c2" }), { stopReason: "toolUse" }); },
    () => { modelCalls += 1; return fauxAssistantMessage("final"); },
  ]);
  const a = await adapter.root().submit(input("mid-a", "start"));
  await up;
  const u = await adapter.root().submit(placed("mid-u", "Decision: use plan B."));
  release();
  const [ra, ru] = [await a.result(), await u.result()];
  assert.equal(ru.status, "placed");
  assert.equal(modelCalls, 3, "the update caused an extra model call");
  assert.deepEqual([ra.status, ra.toolCalls.map((c) => c.callId)], ["completed", ["c1", "c2"]], "the run's tool calls were cut at the placed update");
});

test("a branch taken after a place-only update sees it, because it is part of the task's context", async () => {
  const { adapter, faux } = await finishedTask();
  const parent = adapter.root();
  await (await parent.submit(placed("branch-place", "Decision: use plan B."))).result();
  const updateEntry = (await parent.transcript()).find((e) => e.kind === "nimblenewt.update");
  const branch = await parent.branch({ requestId: requestId("after-place") });
  assert.equal(branch.forkedAt, updateEntry?.id);
  let childSaw = "";
  faux.setResponses([(context) => { childSaw = JSON.stringify(context.messages); return fauxAssistantMessage("answer"); }]);
  await (await branch.conversation.submit(input("ask-place", "Which plan?"))).result();
  assert.ok(childSaw.includes("Decision: use plan B."));
});

test("turnBoundaries: a place-only update is a boundary only when nothing is waiting for an answer, and never leaves an input pending", () => {
  const answered = [entry(1, "pi.user", { role: "user" }), entry(2, "pi.assistant", { role: "assistant", stopReason: "stop", content: [] })];
  const placedUpdate = (id: number) => ({ id, kind: "nimblenewt.update", model: [{ role: "user" }], data: { run: false } });
  assert.deepEqual(turnBoundaries([...answered, placedUpdate(3)]), [2, 3]);
  assert.deepEqual(turnBoundaries([...answered, entry(3, "pi.user", { role: "user" }), placedUpdate(4)]), [2], "not while an input is waiting for its answer");
  assert.deepEqual(turnBoundaries([...answered, placedUpdate(3), entry(4, "pi.compaction", {})]), [2, 3, 4], "a placed update does not leave an input pending for a later compaction");
  assert.deepEqual(turnBoundaries([...answered, { id: 3, kind: "nimblenewt.update", model: [{ role: "user" }], data: { run: true } }]), [2], "an applied (running) update is an input awaiting its answer");
});

test("turnBoundaries: the framing entry of an aborted input extends the boundary before it, so a branch inherits the edit", () => {
  const abortedRound = [
    entry(1, "pi.user", { role: "user" }),
    entry(2, "pi.assistant", { role: "assistant", stopReason: "toolUse", content: [call("x")] }),
    entry(3, "pi.tool-result", { role: "toolResult", toolCallId: "x" }),
  ];
  assert.deepEqual(turnBoundaries([...abortedRound, entry(4, "nimblenewt.aborted-input", {})]), [3, 4]);
  assert.deepEqual(turnBoundaries([entry(1, "pi.user", { role: "user" }), entry(2, "nimblenewt.aborted-input", {})]), [], "nothing was answered, so there is no boundary");
});
