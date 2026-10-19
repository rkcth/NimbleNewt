import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { requestId, type SemanticResult } from "@nimblenewt/contracts";
import { fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import {
  InvalidToolError, PiAdapter, RequestIdConflictError, UnknownCommandError, UnsupportedRuntimeError,
  PINNED_PI_DURABLE_VERSION, type AdapterTool, type PiAdapterOptions,
} from "./index.js";
import { OFFLINE_MODEL_REF, createOfflineModels } from "./testing/offline.js";

const adapters: PiAdapter[] = [];
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.close();
});

async function open(tools: readonly AdapterTool[] = [], extra: Partial<PiAdapterOptions> = {}) {
  const offline = createOfflineModels();
  const adapter = await PiAdapter.open({ storage: new MemoryStorage(), models: offline.models, model: OFFLINE_MODEL_REF, tools, ...extra });
  adapters.push(adapter);
  return { adapter, faux: offline.faux };
}
const input = (id: string, content: string) => ({ kind: "input", requestId: requestId(id), content }) as const;

test("an input request completes with the model's answer and the caller's request ID", async () => {
  const { adapter, faux } = await open();
  faux.setResponses([fauxAssistantMessage("hello back")]);
  const handle = await adapter.submit(input("req-1", "hello"));
  assert.equal(handle.requestId, "req-1");
  assert.deepEqual(await handle.result(), { status: "completed", requestId: "req-1", text: "hello back", toolCalls: [] });
});

test("a duplicate submit returns the original submission and result without running the model again", async () => {
  const { adapter, faux } = await open();
  let modelCalls = 0;
  faux.setResponses([() => { modelCalls += 1; return fauxAssistantMessage("only once"); }]);
  const first = await adapter.submit(input("dup-1", "do it"));
  const firstResult = await first.result();
  const second = await adapter.submit(input("dup-1", "do it"));
  assert.equal(second.submissionId, first.submissionId);
  assert.deepEqual(await second.result(), firstResult);
  assert.equal(modelCalls, 1);
});

test("a duplicate submitted before the first settles shares the same submission", async () => {
  const { adapter, faux } = await open();
  faux.setResponses([fauxAssistantMessage("shared")]);
  const [a, b] = await Promise.all([adapter.submit(input("dup-2", "go")), adapter.submit(input("dup-2", "go"))]);
  assert.equal(a.submissionId, b.submissionId);
  assert.deepEqual(await a.result(), await b.result());
});

test("reusing a request ID with different content is rejected explicitly", async () => {
  const { adapter, faux } = await open();
  faux.setResponses([fauxAssistantMessage("ok")]);
  await (await adapter.submit(input("conflict-1", "first"))).result();
  await assert.rejects(adapter.submit(input("conflict-1", "something else")), RequestIdConflictError);
});

const SENTINEL = "SENTINEL-7f3a91";
const echo: AdapterTool = { name: "echo", description: "Return the sentinel", parameters: Type.Object({}), execute: async () => SENTINEL };

test("a tool's output sentinel reaches the next model step and the semantic result", async () => {
  const { adapter, faux } = await open([echo]);
  let nextStepSaw = "";
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("echo", {}, { id: "call-1" }), { stopReason: "toolUse" }),
    (context) => {
      nextStepSaw = JSON.stringify(context.messages.at(-1));
      return fauxAssistantMessage("saw it");
    },
  ]);
  const result = await (await adapter.submit(input("tool-1", "use the tool"))).result();
  assert.ok(nextStepSaw.includes(SENTINEL), `next model step did not see the tool output: ${nextStepSaw}`);
  assert.deepEqual(result, { status: "completed", requestId: "tool-1", text: "saw it", toolCalls: [{ callId: "call-1", name: "echo", status: "ok", output: SENTINEL }] });
});

test("tool arguments are validated and passed to the tool", async () => {
  const add: AdapterTool<ReturnType<typeof Type.Object<{ a: ReturnType<typeof Type.Number>; b: ReturnType<typeof Type.Number> }>>> = {
    name: "add", description: "Add", parameters: Type.Object({ a: Type.Number(), b: Type.Number() }), execute: async ({ a, b }) => String(a + b),
  };
  const { adapter, faux } = await open([add as unknown as AdapterTool]);
  faux.setResponses([fauxAssistantMessage(fauxToolCall("add", { a: 2, b: 3 }, { id: "c" }), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
  const result = await (await adapter.submit(input("tool-2", "add"))).result();
  assert.deepEqual(result.toolCalls, [{ callId: "c", name: "add", status: "ok", output: "5" }]);
});

test("a throwing tool is reported as an error outcome, not a completed success", async () => {
  const boom: AdapterTool = { name: "boom", description: "Always fails", parameters: Type.Object({}), execute: async () => { throw new Error("kaput"); } };
  const { adapter, faux } = await open([boom]);
  faux.setResponses([fauxAssistantMessage(fauxToolCall("boom", {}, { id: "c" }), { stopReason: "toolUse" }), fauxAssistantMessage("gave up")]);
  const result = await (await adapter.submit(input("tool-3", "go"))).result();
  assert.equal(result.toolCalls[0]?.status, "error");
  assert.match(result.toolCalls[0] && "output" in result.toolCalls[0] ? result.toolCalls[0].output : "", /kaput/);
});

test("a call to an unknown tool fails the request explicitly", async () => {
  const { adapter, faux } = await open([echo]);
  faux.setResponses([fauxAssistantMessage(fauxToolCall("nope", {}, { id: "c" }), { stopReason: "toolUse" }), fauxAssistantMessage("carried on")]);
  const result: SemanticResult = await (await adapter.submit(input("tool-4", "go"))).result();
  assert.equal(result.status, "failed");
  assert.ok(result.status === "failed" && result.code === "unknown_tool" && result.detail.includes("nope") && result.text === "carried on");
  assert.deepEqual(result.toolCalls, [{ callId: "c", name: "nope", status: "unknown_tool" }]);
});

test("an unknown command is rejected explicitly, naming the supported set", async () => {
  const { adapter } = await open();
  await assert.rejects(adapter.submit({ kind: "command", requestId: requestId("cmd-1"), name: "nimblenewt.explode" }),
    (e) => e instanceof UnknownCommandError && e.command === "nimblenewt.explode" && e.message.includes("(none)"));
});

test("an unsupported runtime refuses to open", async () => {
  const offline = createOfflineModels();
  const base = { storage: new MemoryStorage(), models: offline.models, model: OFFLINE_MODEL_REF };
  await assert.rejects(PiAdapter.open({ ...base, runtime: { piDurableVersion: "1.2.0", nodeVersion: "24.21.0" } }), UnsupportedRuntimeError);
  await assert.rejects(PiAdapter.open({ ...base, runtime: { piDurableVersion: PINNED_PI_DURABLE_VERSION, nodeVersion: "20.0.0" } }), UnsupportedRuntimeError);
});

test("duplicate or empty tool names are rejected", async () => {
  const offline = createOfflineModels();
  const base = { storage: new MemoryStorage(), models: offline.models, model: OFFLINE_MODEL_REF };
  await assert.rejects(PiAdapter.open({ ...base, tools: [echo, echo] }), InvalidToolError);
  await assert.rejects(PiAdapter.open({ ...base, tools: [{ ...echo, name: "" }] }), InvalidToolError);
});

const text = (r: SemanticResult) => ("text" in r ? r.text : "");
const onlyTools = (r: SemanticResult) => r.toolCalls.map((c) => c.name);

test("tool calls are attributed to the request that made them when requests run back to back", async () => {
  const other: AdapterTool = { name: "other", description: "Other", parameters: Type.Object({}), execute: async () => "OTHER" };
  const { adapter, faux } = await open([echo, other]);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("echo", {}, { id: "a1" }), { stopReason: "toolUse" }), fauxAssistantMessage("answer A"),
    fauxAssistantMessage(fauxToolCall("other", {}, { id: "b1" }), { stopReason: "toolUse" }), fauxAssistantMessage("answer B"),
  ]);
  const a = await adapter.submit(input("attr-a", "A"));
  const b = await adapter.submit(input("attr-b", "B")); // admitted while A may still be running
  const [ra, rb] = [await a.result(), await b.result()];
  assert.deepEqual([text(ra), onlyTools(ra)], ["answer A", ["echo"]]);
  assert.deepEqual([text(rb), onlyTools(rb)], ["answer B", ["other"]]);
});

test("an aborted request is reported as unanswered and its result never changes when later work runs", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const toolStarted = new Promise<void>((resolve) => { started = resolve; });
  let sawAbort = false;
  const slow: AdapterTool = {
    name: "slow", description: "Waits", parameters: Type.Object({}),
    execute: async (_args, { signal }) => { signal?.addEventListener("abort", () => { sawAbort = true; release(); }); started(); await gate; return "late"; },
  };
  const { adapter, faux } = await open([slow, echo]);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("slow", {}, { id: "s1" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("echo", {}, { id: "e1" }), { stopReason: "toolUse" }), fauxAssistantMessage("answer B"),
  ]);
  const a = await adapter.submit(input("abort-a", "A"));
  await toolStarted;
  await adapter.abort();
  const first = await a.result();
  assert.equal(first.status, "unanswered");
  assert.ok(first.status === "unanswered" && first.reason === "aborted", JSON.stringify(first));
  assert.ok(sawAbort, "the tool did not receive the abort signal");

  const b = await adapter.submit(input("abort-b", "B"));
  assert.equal(text(await b.result()), "answer B");
  assert.deepEqual((await (await adapter.submit(input("abort-a", "A"))).result()), first);
  assert.ok(!onlyTools(first).includes("echo"), "request B's tool call leaked into request A's result");
});

test("duplicate and conflicting submits after a compaction see the original recorded result", async () => {
  const { adapter, faux } = await open([echo], { settings: { compaction: { keepRecentTokens: 1 } } });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("echo", {}, { id: "k1" }), { stopReason: "toolUse" }), fauxAssistantMessage("answer 1"),
    fauxAssistantMessage("answer 2"), fauxAssistantMessage("a summary"),
  ]);
  const first = await (await adapter.submit(input("compact-1", "one"))).result();
  await (await adapter.submit(input("compact-2", "two"))).result();
  await adapter.compact();
  assert.equal(first.status, "completed");
  assert.deepEqual(await (await adapter.submit(input("compact-1", "one"))).result(), first);
  await assert.rejects(adapter.submit(input("compact-1", "different")), RequestIdConflictError);
});

test("a result is built from the transcript only once: it is the recorded value even if read first after compaction", async () => {
  const { adapter, faux } = await open([echo], { settings: { compaction: { keepRecentTokens: 1 } } });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("echo", {}, { id: "k1" }), { stopReason: "toolUse" }), fauxAssistantMessage("answer 1"),
    fauxAssistantMessage("answer 2"), fauxAssistantMessage("a summary"),
  ]);
  const handle = await adapter.submit(input("late-1", "one")); // result() deliberately not called yet
  await (await adapter.submit(input("late-2", "two"))).result();
  await adapter.compact();
  const result = await handle.result();
  assert.deepEqual([result.status, text(result), onlyTools(result)], ["completed", "answer 1", ["echo"]]);
});

test("reusing a request ID with different content is rejected while the original is still queued", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const hold: AdapterTool = { name: "hold", description: "Waits", parameters: Type.Object({}), execute: async () => { await gate; return "held"; } };
  const { adapter, faux } = await open([hold]);
  faux.setResponses([fauxAssistantMessage(fauxToolCall("hold", {}, { id: "h1" }), { stopReason: "toolUse" }), fauxAssistantMessage("first done"), fauxAssistantMessage("second done")]);
  const running = await adapter.submit(input("q-running", "running"));
  const queued = await adapter.submit(input("q-queued", "original"));
  await assert.rejects(adapter.submit(input("q-queued", "tampered")), RequestIdConflictError);
  release();
  await running.result();
  assert.equal(text(await queued.result()), "second done");
});

test("a tool receives its call ID and the semantic result carries it", async () => {
  let seen = "";
  const tool: AdapterTool = { name: "ctx", description: "Reports its call", parameters: Type.Object({}), execute: async (_a, { callId }) => { seen = callId; return "ok"; } };
  const { adapter, faux } = await open([tool]);
  faux.setResponses([fauxAssistantMessage(fauxToolCall("ctx", {}, { id: "call-xyz" }), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
  const result = await (await adapter.submit(input("ctx-1", "go"))).result();
  assert.equal(seen, "call-xyz");
  assert.equal(result.toolCalls[0]?.callId, "call-xyz");
});

test("an aborted request read for the first time after later work excludes that work's tool calls", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const toolStarted = new Promise<void>((resolve) => { started = resolve; });
  const slow: AdapterTool = { name: "slow", description: "Waits", parameters: Type.Object({}), execute: async (_a, { signal }) => { signal?.addEventListener("abort", release); started(); await gate; return "late"; } };
  const { adapter, faux } = await open([slow, echo]);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("slow", {}, { id: "s1" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("echo", {}, { id: "e1" }), { stopReason: "toolUse" }), fauxAssistantMessage("answer B"),
  ]);
  const a = await adapter.submit(input("late-abort-a", "A"));
  await toolStarted;
  await adapter.abort();
  const b = await adapter.submit(input("late-abort-b", "B"));
  assert.deepEqual([text(await b.result()), onlyTools(await b.result())], ["answer B", ["echo"]]);
  const first = await a.result(); // first read, after B finished
  assert.equal(first.status, "unanswered");
  assert.ok(!onlyTools(first).includes("echo"), `request B's tool call leaked into A: ${JSON.stringify(first)}`);
});

test("a completed request excludes tool calls made by requests that ran after it", async () => {
  const other: AdapterTool = { name: "other", description: "Other", parameters: Type.Object({}), execute: async () => "OTHER" };
  const { adapter, faux } = await open([echo, other]);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("echo", {}, { id: "a1" }), { stopReason: "toolUse" }), fauxAssistantMessage("answer A"),
    fauxAssistantMessage(fauxToolCall("other", {}, { id: "b1" }), { stopReason: "toolUse" }), fauxAssistantMessage("answer B"),
  ]);
  const a = await adapter.submit(input("excl-a", "A"));
  const b = await adapter.submit(input("excl-b", "B"));
  const rb = await b.result(); // B finishes, with its tool call in the transcript, before A is first read
  const ra = await a.result();
  assert.deepEqual([text(ra), onlyTools(ra)], ["answer A", ["echo"]]);
  assert.deepEqual([text(rb), onlyTools(rb)], ["answer B", ["other"]]);
});
