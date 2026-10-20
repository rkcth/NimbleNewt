import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { requestId, type AuditEvent, type RuntimePort } from "@nimblenewt/contracts";
import { BranchDiscardedError, PiAdapter, RequestIdConflictError, TooManyBranchesError, type AdapterTool, type PiAdapterOptions } from "./index.js";
import { OFFLINE_MODEL_REF, createOfflineModels } from "./testing/offline.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

const input = (id: string, content: string) => ({ kind: "input", requestId: requestId(id), content }) as const;

async function open(extra: Partial<PiAdapterOptions> = {}, tools: readonly AdapterTool[] = []) {
  const offline = createOfflineModels();
  const events: AuditEvent[] = [];
  const adapter = await PiAdapter.open({ storage: new MemoryStorage(), models: offline.models, model: OFFLINE_MODEL_REF, tools, audit: (e) => { events.push(e); }, ...extra });
  cleanup.push(() => adapter.close());
  return { adapter, faux: offline.faux, events };
}

function holdingTool() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const up = new Promise<void>((resolve) => { started = resolve; });
  let aborted = false;
  const tool: AdapterTool = { name: "hold", description: "Waits", parameters: Type.Object({}), execute: async (_a, { signal }) => { signal?.addEventListener("abort", () => { aborted = true; release(); }); started(); await gate; return "held"; } };
  return { tool, release, up, wasAborted: () => aborted };
}
const echo: AdapterTool = { name: "echo", description: "Returns a marker", parameters: Type.Object({}), execute: async () => "ECHO-RESULT" };

test("tasks start with empty, separate contexts: A and B never see each other or the root, even interleaved", async () => {
  const hold = holdingTool();
  const { adapter, faux } = await open({}, [hold.tool, echo]);
  const seen = new Map<string, string>();
  const reply = (key: string, marker: string) => (context: { messages: readonly unknown[] }) => { seen.set(key, JSON.stringify(context.messages)); return fauxAssistantMessage(`answer ${marker}`); };

  const a = (await adapter.createTask({ requestId: requestId("task-a") })).conversation;
  const b = (await adapter.createTask({ requestId: requestId("task-b") })).conversation;
  assert.deepEqual([(await a.transcript()).length, (await b.transcript()).length], [0, 0], "a task starts with an empty context");
  assert.notEqual(a.id, b.id);

  // Task A starts a long tool call; task B runs to completion meanwhile; then A finishes. Replies are chosen by content,
  // since the two conversations share one scripted model.
  faux.setResponses(Array.from({ length: 8 }, () => (context: { messages: readonly unknown[] }) => {
    const text = JSON.stringify(context.messages);
    if (text.includes("ALPHA-TASK") && !text.includes('"role":"toolResult"')) return fauxAssistantMessage(fauxToolCall("hold", {}, { id: "a-hold" }), { stopReason: "toolUse" });
    if (text.includes("BETA-TASK") && !text.includes('"role":"toolResult"')) return fauxAssistantMessage(fauxToolCall("echo", {}, { id: "b-echo" }), { stopReason: "toolUse" });
    const key = text.includes("ALPHA-TASK") ? "alpha" : text.includes("BETA-TASK") ? "beta" : "root";
    return reply(key, key.toUpperCase())(context);
  }));
  const alpha = await a.submit(input("alpha-1", "ALPHA-TASK: start"));
  await hold.up;
  const beta = await (await b.submit(input("beta-1", "BETA-TASK: start"))).result();
  assert.deepEqual([beta.status, "text" in beta && beta.text, beta.toolCalls.map((c) => c.name)], ["completed", "answer BETA", ["echo"]]);
  hold.release();
  const alphaResult = await alpha.result();
  assert.deepEqual([alphaResult.status, "text" in alphaResult && alphaResult.text, alphaResult.toolCalls.map((c) => c.name)], ["completed", "answer ALPHA", ["hold"]]);

  const rootResult = await (await adapter.root().submit(input("root-1", "ROOT-TASK: start"))).result();
  assert.equal("text" in rootResult && rootResult.text, "answer ROOT");
  const everything = { alpha: (await a.transcript()).map((e) => e.text).join("|"), beta: (await b.transcript()).map((e) => e.text).join("|"), root: (await adapter.root().transcript()).map((e) => e.text).join("|") };
  assert.ok(everything.alpha.includes("ALPHA-TASK") && !everything.alpha.includes("BETA-TASK") && !everything.alpha.includes("ROOT-TASK"));
  assert.ok(everything.beta.includes("BETA-TASK") && !everything.beta.includes("ALPHA-TASK") && !everything.beta.includes("ROOT-TASK"));
  assert.ok(everything.root.includes("ROOT-TASK") && !everything.root.includes("ALPHA-TASK") && !everything.root.includes("BETA-TASK"));
  // What each task's model actually received on its final request (not just what was stored).
  const modelSaw = (key: string) => seen.get(key) ?? assert.fail(`no final model request recorded for ${key}`);
  for (const [key, own, others] of [["alpha", "ALPHA-TASK", ["BETA-TASK", "ROOT-TASK"]], ["beta", "BETA-TASK", ["ALPHA-TASK", "ROOT-TASK"]], ["root", "ROOT-TASK", ["ALPHA-TASK", "BETA-TASK"]]] as const) {
    assert.ok(modelSaw(key).includes(own), `${key} lost its own context`);
    for (const other of others) assert.ok(!modelSaw(key).includes(other), `${key}'s model request contained ${other}`);
  }
});

test("creating a task is idempotent by request ID, also concurrently, and is audited once", async () => {
  const { adapter, events } = await open();
  const results = await Promise.all(Array.from({ length: 5 }, () => adapter.createTask({ requestId: requestId("idem-task") })));
  assert.equal(new Set(results.map((r) => r.conversation.id)).size, 1);
  assert.equal(results.filter((r) => r.created).length, 1, "exactly one caller creates the task");
  assert.equal((await adapter.createTask({ requestId: requestId("idem-task") })).created, false);
  assert.deepEqual(events.filter((e) => e.type === "create_task").length, 1);
  assert.equal((await adapter.root().listBranches()).length, 1);
});

test("one request ID cannot be a task and a branch or restore at once", async () => {
  const { adapter, faux } = await open();
  faux.setResponses([fauxAssistantMessage("answer")]);
  await (await adapter.root().submit(input("t-1", "work"))).result();
  await adapter.createTask({ requestId: requestId("as-task") });
  await adapter.root().branch({ requestId: requestId("as-branch") });
  await assert.rejects(adapter.root().branch({ requestId: requestId("as-task") }), RequestIdConflictError);
  await assert.rejects(adapter.createTask({ requestId: requestId("as-branch") }), RequestIdConflictError);
  await assert.rejects(adapter.restoreCheckpoint(await adapter.root().checkpoint(), requestId("as-branch")), RequestIdConflictError);
});

test("tasks are limited separately from branches, discarding frees a slot, and concurrent creators cannot exceed the limit", async () => {
  const { adapter, faux } = await open({ maxActiveTasks: 2, maxActiveBranches: 1 });
  faux.setResponses([fauxAssistantMessage("answer")]);
  await (await adapter.root().submit(input("l-1", "work"))).result();
  await adapter.root().branch({ requestId: requestId("one-branch") }); // uses the branch slot, not a task slot
  await adapter.createTask({ requestId: requestId("task-1") });
  await adapter.createTask({ requestId: requestId("task-2") });
  await assert.rejects(adapter.createTask({ requestId: requestId("task-3") }), (e) => e instanceof TooManyBranchesError && e.limit === 2);
  assert.equal((await adapter.createTask({ requestId: requestId("task-1") })).created, false, "an existing task is returned even at the limit");
  await adapter.root().discardBranch(requestId("task-1"));
  assert.equal((await adapter.createTask({ requestId: requestId("task-3") })).created, true);

  const racing = await open({ maxActiveTasks: 3 });
  const outcomes = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => racing.adapter.createTask({ requestId: requestId(`race-${i}`) })));
  assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 3);
  assert.equal((await racing.adapter.root().listBranches()).length, 3);
});

test("tasks are listed with their kind, closed with discardBranch, and aborting the root leaves them running", async () => {
  const hold = holdingTool();
  const { adapter, faux } = await open({}, [hold.tool]);
  const task = (await adapter.createTask({ requestId: requestId("listed") })).conversation;
  assert.deepEqual((await adapter.root().listBranches()).map((b) => [b.requestId, b.kind, b.forkedAt, b.discarded]), [["listed", "task", 0, false]]);

  faux.setResponses([fauxAssistantMessage(fauxToolCall("hold", {}, { id: "h" }), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
  const running = await task.submit(input("t-run", "long job"));
  await hold.up;
  assert.deepEqual(await adapter.root().abort(), { aborted: [], retained: [] });
  assert.equal(hold.wasAborted(), false, "aborting the root aborted a task");

  const report = await adapter.root().discardBranch(requestId("listed"));
  assert.deepEqual(report.aborted, ["t-run"]);
  assert.equal((await running.result()).status, "unanswered");
  await assert.rejects(task.submit(input("t-more", "again")), BranchDiscardedError);
  assert.equal((await adapter.root().listBranches())[0]?.discarded, true);
});

test("tasks survive a restart and keep running on the configured model", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn tasks-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const reopen = async () => {
    const offline = createOfflineModels();
    offline.faux.setResponses([fauxAssistantMessage("task answer"), fauxAssistantMessage("after restart")]);
    const adapter = await PiAdapter.open({ storage: await openNodeJsonlStorage(dir, BACKGROUND_CONTEXT), models: offline.models, model: OFFLINE_MODEL_REF });
    cleanup.push(() => adapter.close());
    return adapter;
  };
  const first = await reopen();
  const task = (await first.createTask({ requestId: requestId("durable") })).conversation;
  await (await task.submit(input("d-1", "first"))).result();
  await first.close();
  cleanup.pop();

  const second = await reopen();
  const again = await second.createTask({ requestId: requestId("durable") });
  assert.deepEqual([again.created, again.conversation.id], [false, task.id]);
  assert.equal((await again.conversation.lookup(requestId("d-1")))?.status, "completed");
  assert.equal((await (await again.conversation.submit(input("d-2", "second"))).result()).status, "completed");
});

test("a controller creates tasks through the port, including while interrupted work is held", async () => {
  const { adapter } = await open();
  const runtime: RuntimePort = adapter;
  const task = await runtime.createTask({ requestId: requestId("via-port") });
  assert.deepEqual([task.created, task.discarded, (await task.conversation.transcript()).length], [true, false, 0]);
});
