import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { requestId } from "@nimblenewt/contracts";
import { fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { CompactionHookTimeout, PiAdapter, applyContextPolicy, type AdapterContextPolicy, type AdapterTool, type CompactionRequest } from "./index.js";
import { OFFLINE_MODEL_REF, createOfflineModels } from "./testing/offline.js";

const adapters: PiAdapter[] = [];
afterEach(async () => { for (const adapter of adapters.splice(0)) await adapter.close(); });
const input = (id: string, content: string) => ({ kind: "input", requestId: requestId(id), content }) as const;

async function open(contextPolicy: AdapterContextPolicy, tools: readonly AdapterTool[] = []) {
  const offline = createOfflineModels();
  const adapter = await PiAdapter.open({ storage: new MemoryStorage(), models: offline.models, model: OFFLINE_MODEL_REF, tools, settings: { compaction: { keepRecentTokens: 1 } }, contextPolicy });
  adapters.push(adapter);
  return { adapter, faux: offline.faux };
}
async function twoTurns(world: Awaited<ReturnType<typeof open>>) {
  world.faux.setResponses([fauxAssistantMessage("ANSWER-ONE"), fauxAssistantMessage("ANSWER-TWO")]);
  await (await world.adapter.root().submit(input("c-1", "OLD-REQUEST-MARKER first"))).result();
  await (await world.adapter.root().submit(input("c-2", "second request"))).result();
}

test("the controller's summariser supplies the compaction summary through beforeCompact, and Pi's own summariser is not asked", async () => {
  const seen: CompactionRequest[] = [];
  const world = await open({ beforeCompact: async (r) => { seen.push(r); return { summary: "CONTROLLER-SUMMARY: the owner chose PostgreSQL." }; } });
  await twoTurns(world);
  await world.adapter.root().compact();
  assert.equal(seen.length, 1);
  assert.match(seen[0]!.text, /OLD-REQUEST-MARKER first/, "the hook sees the conversation being replaced");
  assert.equal(seen[0]!.reason, "manual");
  assert.match(seen[0]!.key, /^\d+:/);
  const entries = await world.adapter.root().transcript();
  assert.ok(JSON.stringify(entries.find((e) => e.kind === "pi.compaction")).includes("CONTROLLER-SUMMARY"));
});

test("a hook that declines leaves the conversation uncompacted", async () => {
  const world = await open({ beforeCompact: async () => ({ decline: true }) });
  await twoTurns(world);
  await world.adapter.root().compact();
  assert.equal((await world.adapter.root().transcript()).some((e) => e.kind === "pi.compaction"), false);
});

test("a hook that hangs is stopped by the adapter's own ceiling; Pi's own summariser (the model out of room) is not tried; the failure is reported; nothing hangs", async () => {
  const failures: unknown[] = [];
  let seenSignal: AbortSignal | undefined;
  const world = await open({ beforeCompactTimeoutMs: 60, beforeCompact: (r) => { seenSignal = r.signal; return new Promise(() => undefined); }, onHookFailure: (e) => failures.push(e) });
  world.faux.setResponses([fauxAssistantMessage("ANSWER-ONE"), fauxAssistantMessage("ANSWER-TWO"), fauxAssistantMessage("PI-OWN-SUMMARY")]);
  await (await world.adapter.root().submit(input("c-1", "first"))).result();
  await (await world.adapter.root().submit(input("c-2", "second"))).result();
  const t0 = Date.now();
  await world.adapter.root().compact();
  assert.ok(Date.now() - t0 < 60_000);
  assert.equal(failures.length, 1);
  assert.equal(seenSignal?.aborted, true, "the callback was told to stop when the adapter gave up");
  assert.ok(failures[0] instanceof CompactionHookTimeout);
  assert.match((failures[0] as Error).message, /Context compression timed out/);
  assert.equal((await world.adapter.root().transcript()).some((e) => e.kind === "pi.compaction"), false, "declined, not summarised by Pi's own model");
  assert.equal(world.faux.getPendingResponseCount(), 1, "Pi's own summary reply was never consumed");
  // A callback that throws is the same.
  const thrower = await open({ beforeCompact: async () => { throw new Error("summariser exploded"); }, onHookFailure: (e) => failures.push(e) });
  await twoTurns(thrower);
  await thrower.adapter.root().compact();
  assert.equal(failures.length, 2);
  assert.equal((await thrower.adapter.root().transcript()).some((e) => e.kind === "pi.compaction"), false);
});

test("tool results are cut to the policy's limit for every adapter tool, and a tool can keep the tail", async () => {
  const long = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
  const head: AdapterTool = { name: "head", description: "long", parameters: Type.Object({}), execute: async () => long };
  const tail: AdapterTool = { name: "tail", description: "long", parameters: Type.Object({}), outputRetain: "tail", execute: async () => long };
  const world = await open({ toolOutputBytes: 600, toolOutputLines: 1000 }, [head, tail]);
  let seen = "";
  world.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("head", {}, { id: "h1" }), fauxToolCall("tail", {}, { id: "t1" })], { stopReason: "toolUse" }),
    (context) => { seen = JSON.stringify(context.messages); return fauxAssistantMessage("done"); },
  ]);
  await (await world.adapter.root().submit(input("c-1", "go"))).result();
  assert.ok(seen.includes("line 0\\n"), "the head tool kept the start");
  const toolResults = JSON.parse(seen).filter((m: { role: string }) => m.role === "toolResult");
  assert.equal(toolResults.length, 2);
  for (const r of toolResults) assert.ok(JSON.stringify(r).length < 1600, `a result of ${JSON.stringify(r).length} characters passed the 600-byte limit`);
  assert.ok(JSON.stringify(toolResults[1]).includes("line 399") && !JSON.stringify(toolResults[1]).includes("line 0\\n"), "the tail tool kept the end");
});

test("the policy's values are validated and merged over explicit settings", () => {
  for (const bad of [{ streamTimeoutMs: 0 }, { streamMaxRetries: -1 }, { toolOutputBytes: Number.NaN }, { beforeCompactTimeoutMs: -5 }]) assert.throws(() => applyContextPolicy(bad, undefined), RangeError);
  const merged = applyContextPolicy({ streamTimeoutMs: 90_000, streamMaxRetries: 1 }, { stream: { headers: { a: "b" } }, compaction: { keepRecentTokens: 5 } });
  assert.deepEqual(merged.settings, { stream: { headers: { a: "b" }, timeoutMs: 90_000, maxRetries: 1 }, compaction: { keepRecentTokens: 5 } });
  assert.deepEqual(applyContextPolicy(undefined, undefined), { settings: undefined, hooks: [], toolLimits: {} });
  assert.equal(applyContextPolicy({ beforeCompact: async () => undefined }, undefined).hooks.length, 1);
});
