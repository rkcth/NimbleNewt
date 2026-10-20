import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { requestId } from "@nimblenewt/contracts";
import { BranchDiscardedError, InvalidBranchPointError, PiAdapter, TooManyBranchesError, type AdapterTool, type PiAdapterOptions } from "./index.js";
import { OFFLINE_MODEL_REF, createOfflineModels } from "./testing/offline.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

const input = (id: string, content: string) => ({ kind: "input", requestId: requestId(id), content }) as const;

async function open(tools: readonly AdapterTool[] = [], extra: Partial<PiAdapterOptions> = {}) {
  const offline = createOfflineModels();
  const adapter = await PiAdapter.open({ storage: new MemoryStorage(), models: offline.models, model: OFFLINE_MODEL_REF, tools, ...extra });
  cleanup.push(() => adapter.close());
  return { adapter, faux: offline.faux };
}

/** An idle conversation with one completed turn, so it can be branched. */
async function finishedTask(extra: Partial<PiAdapterOptions> = {}, tools: readonly AdapterTool[] = []) {
  const world = await open(tools, extra);
  world.faux.setResponses([fauxAssistantMessage("task answer")]);
  await (await world.adapter.root().submit(input("task-1", "do the task"))).result();
  return world;
}

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
  return { tool, up, wasAborted: () => aborted };
}

test("listBranches shows a conversation's branches in creation order with their state", async () => {
  const { adapter } = await finishedTask();
  const parent = adapter.root();
  assert.deepEqual(await parent.listBranches(), []);
  const first = await parent.branch({ requestId: requestId("b-1") });
  const second = await parent.branch({ requestId: requestId("b-2") });
  await parent.discardBranch(requestId("b-1"));
  assert.deepEqual(await parent.listBranches(), [
    { requestId: "b-1", kind: "inquiry", conversationId: first.conversation.id, forkedAt: first.forkedAt, discarded: true },
    { requestId: "b-2", kind: "inquiry", conversationId: second.conversation.id, forkedAt: second.forkedAt, discarded: false },
  ]);
});

test("discarding a branch aborts its running work, closes it to new work, keeps its transcript, and leaves the parent alone", async () => {
  const hold = holdingTool();
  const { adapter, faux } = await finishedTask({}, [hold.tool]);
  const parent = adapter.root();
  const parentBefore = await parent.transcript();
  const branch = await parent.branch({ requestId: requestId("d-1") });
  faux.setResponses([fauxAssistantMessage(fauxToolCall("hold", {}, { id: "h" }), { stopReason: "toolUse" })]);
  const inquiry = await branch.conversation.submit(input("d-ask", "inquire"));
  await hold.up;

  const report = await parent.discardBranch(requestId("d-1"));
  assert.deepEqual(report.aborted, ["d-ask"]);
  assert.ok(hold.wasAborted(), "the branch's running tool was not aborted");
  assert.equal((await inquiry.result()).status, "unanswered");

  await assert.rejects(branch.conversation.submit(input("d-more", "again")), BranchDiscardedError);
  await assert.rejects(branch.conversation.compact(), BranchDiscardedError);
  await assert.rejects(branch.conversation.branch({ requestId: requestId("nested") }), BranchDiscardedError);
  const readable = await branch.conversation.transcript();
  assert.ok(readable.some((e) => e.text === "inquire"), "a discarded branch's transcript must stay readable");
  assert.equal((await branch.conversation.lookup(requestId("d-ask")))?.status, "unanswered");
  assert.deepEqual(await parent.transcript(), parentBefore, "discarding a branch changed the parent");

  assert.deepEqual(await parent.discardBranch(requestId("d-1")), { aborted: [], retained: [] }, "discarding twice is a no-op");
  await assert.rejects(parent.discardBranch(requestId("never-created")), InvalidBranchPointError);
});

test("asking for a discarded branch's request ID again returns it, marked discarded", async () => {
  const { adapter } = await finishedTask();
  const parent = adapter.root();
  const created = await parent.branch({ requestId: requestId("again-1") });
  await parent.discardBranch(requestId("again-1"));
  const again = await parent.branch({ requestId: requestId("again-1") });
  assert.deepEqual([again.conversation.id, again.discarded], [created.conversation.id, true]);
});

test("only active branches count toward the limit; discarding frees a slot; an existing request ID is never refused", async () => {
  const { adapter } = await finishedTask({ maxActiveBranches: 2 });
  const parent = adapter.root();
  await parent.branch({ requestId: requestId("l-1") });
  await parent.branch({ requestId: requestId("l-2") });
  await assert.rejects(parent.branch({ requestId: requestId("l-3") }), (e) => e instanceof TooManyBranchesError && e.limit === 2);
  assert.equal((await parent.branch({ requestId: requestId("l-1") })).discarded, false, "an existing branch is returned even at the limit");
  await parent.discardBranch(requestId("l-1"));
  assert.equal((await parent.branch({ requestId: requestId("l-3") })).discarded, false);
  await assert.rejects(parent.branch({ requestId: requestId("l-4") }), TooManyBranchesError);
});

test("concurrent branch creation cannot exceed the limit", async () => {
  const { adapter } = await finishedTask({ maxActiveBranches: 2 });
  const parent = adapter.root();
  const outcomes = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => parent.branch({ requestId: requestId(`c-${i}`) })));
  assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 2);
  assert.ok(outcomes.filter((o) => o.status === "rejected").every((o) => (o as PromiseRejectedResult).reason instanceof TooManyBranchesError));
  assert.equal((await parent.listBranches()).length, 2);
});

test("a discarded branch stays discarded after a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn lifecycle-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const reopen = async () => {
    const offline = createOfflineModels();
    offline.faux.setResponses([fauxAssistantMessage("task answer"), fauxAssistantMessage("never used")]);
    const adapter = await PiAdapter.open({ storage: await openNodeJsonlStorage(dir, BACKGROUND_CONTEXT), models: offline.models, model: OFFLINE_MODEL_REF });
    cleanup.push(() => adapter.close());
    return adapter;
  };
  const first = await reopen();
  await (await first.root().submit(input("task-1", "do the task"))).result();
  const branch = await first.root().branch({ requestId: requestId("persist-1") });
  await first.root().discardBranch(requestId("persist-1"));
  await first.close();
  cleanup.pop();

  const second = await reopen();
  assert.deepEqual((await second.root().listBranches()).map((b) => [b.requestId, b.discarded]), [["persist-1", true]]);
  const child = await second.conversation(branch.conversation.id);
  await assert.rejects(child!.submit(input("after-restart", "hello")), BranchDiscardedError);
});

test("a submission already in flight when a branch is discarded never runs in it", async () => {
  let executions = 0;
  const counted: AdapterTool = { name: "counted", description: "Counts runs", parameters: Type.Object({}), execute: async () => { executions += 1; return "ran"; } };
  let holdNext = 0;
  const offline = createOfflineModels();
  const adapter = await PiAdapter.open({
    storage: new MemoryStorage(), models: offline.models, model: OFFLINE_MODEL_REF, tools: [counted],
    // Holds the next submission after its request ID is claimed and before Pi has seen it: the window in which a discard
    // (mark, then abort) can complete entirely, so that Pi has nothing to abort and its commit queue cannot order the two.
    testHooks: { beforeAdmission: async () => { const wait = holdNext; holdNext = 0; if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait)); } },
  });
  cleanup.push(() => adapter.close());
  offline.faux.setResponses([fauxAssistantMessage("task answer")]);
  await (await adapter.root().submit(input("task-1", "do the task"))).result();
  const branch = await adapter.root().branch({ requestId: requestId("race-1") });

  offline.faux.setResponses([fauxAssistantMessage(fauxToolCall("counted", {}, { id: "c" }), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
  holdNext = 100;
  const racing = branch.conversation.submit(input("race-ask", "inquire")).then((h) => ({ ok: true as const, h }), (e: unknown) => ({ ok: false as const, e }));
  await new Promise((resolve) => setTimeout(resolve, 20)); // claimed, and waiting to be handed to Pi
  await adapter.root().discardBranch(requestId("race-1"));
  const afterDiscard = executions;
  const outcome = await racing;
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(executions, afterDiscard, "a tool ran in the branch after the discard returned");
  assert.equal(executions, 0);
  if (outcome.ok) assert.equal((await outcome.h.result()).status, "unanswered", "an admitted submission must have been aborted");
  else assert.ok(outcome.e instanceof BranchDiscardedError);
});

test("discarding a branch discards its own branches too, and aborts their work", async () => {
  const hold = holdingTool();
  const { adapter, faux } = await finishedTask({}, [hold.tool]);
  const child = await adapter.root().branch({ requestId: requestId("tree-child") });
  faux.setResponses([fauxAssistantMessage("child answer")]);
  await (await child.conversation.submit(input("child-turn", "child work"))).result();
  const grandchild = await child.conversation.branch({ requestId: requestId("tree-grandchild") });
  faux.setResponses([fauxAssistantMessage(fauxToolCall("hold", {}, { id: "h" }), { stopReason: "toolUse" })]);
  const running = await grandchild.conversation.submit(input("grand-ask", "deep inquiry"));
  await hold.up;

  const report = await adapter.root().discardBranch(requestId("tree-child"));
  assert.deepEqual(report.aborted, ["grand-ask"]);
  assert.ok(hold.wasAborted());
  assert.equal((await running.result()).status, "unanswered");
  assert.deepEqual((await child.conversation.listBranches()).map((b) => b.discarded), [true]);
  await assert.rejects(grandchild.conversation.submit(input("grand-more", "again")), BranchDiscardedError);
});

test("restored checkpoints and inquiry branches are limited separately", async () => {
  const { adapter } = await finishedTask({ maxActiveBranches: 1 });
  const parent = adapter.root();
  const checkpoint = await parent.checkpoint();
  await parent.branch({ requestId: requestId("inq-1") });
  await assert.rejects(parent.branch({ requestId: requestId("inq-2") }), TooManyBranchesError);
  // The inquiry does not use up the restore slot, and vice versa.
  const restored = await adapter.restoreCheckpoint(checkpoint, requestId("rest-1"));
  assert.equal(restored.discarded, false);
  await assert.rejects(adapter.restoreCheckpoint(checkpoint, requestId("rest-2")), TooManyBranchesError);
  assert.deepEqual((await parent.listBranches()).map((b) => [b.requestId, b.kind]), [["inq-1", "inquiry"], ["rest-1", "restore"]]);
  await parent.discardBranch(requestId("rest-1"));
  assert.equal((await adapter.restoreCheckpoint(checkpoint, requestId("rest-2"))).discarded, false);
});
