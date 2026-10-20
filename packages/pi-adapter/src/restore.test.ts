import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { requestId } from "@nimblenewt/contracts";
import { PiAdapter } from "./index.js";
import { EFFECT_OUTPUT, attemptsIn, effectTool } from "./testing/crash-fixture.js";
import { OFFLINE_MODEL_REF, createOfflineModels } from "./testing/offline.js";

const cleanup: (() => Promise<void> | void)[] = [];
// Last in, first out: adapters close before their scratch directory is removed.
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "nn restore-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

async function reopen(directory: string, tools: Parameters<typeof PiAdapter.open>[0]["tools"], responses: Parameters<ReturnType<typeof createOfflineModels>["faux"]["setResponses"]>[0]) {
  const offline = createOfflineModels();
  offline.faux.setResponses(responses);
  const adapter = await PiAdapter.open({ storage: await openNodeJsonlStorage(directory, BACKGROUND_CONTEXT), models: offline.models, model: OFFLINE_MODEL_REF, ...(tools === undefined ? {} : { tools }) });
  cleanup.push(() => adapter.close());
  return adapter;
}

const input = (id: string, content: string) => ({ kind: "input", requestId: requestId(id), content }) as const;

test("after a clean close and reopen, a duplicate submit returns the original result without calling the model", async () => {
  const dir = scratch();
  const first = await reopen(dir, [], [fauxAssistantMessage("original answer")]);
  const original = await (await first.root().submit(input("reopen-1", "hello"))).result();
  await first.close();

  let modelCalls = 0;
  const second = await reopen(dir, [], [() => { modelCalls += 1; return fauxAssistantMessage("different answer"); }]);
  const again = await (await second.root().submit(input("reopen-1", "hello"))).result();
  assert.deepEqual(again, original);
  assert.equal(modelCalls, 0);
  assert.equal(await second.root().recorded(requestId("reopen-1")).then((r) => r?.status), "completed");
});

function killChild(directory: string, log: string, replay?: "safe") {
  const script = fileURLToPath(new URL("./testing/crash-child.js", import.meta.url));
  const result = spawnSync(process.execPath, [script, directory, log, ...(replay === undefined ? [] : [replay])], { encoding: "utf8", timeout: 30000 });
  return result;
}

test("a real process kill mid-tool is recovered in a fresh process; an unsafe tool is not re-run", async (t) => {
  const dir = scratch();
  const log = join(dir, "attempts.log");
  const child = killChild(dir, log);
  if (process.platform !== "win32") assert.equal(child.signal, "SIGKILL", child.stderr);
  else assert.notEqual(child.status, 0, child.stderr);
  assert.equal(attemptsIn(log), 1);

  const adapter = await reopen(dir, [effectTool(log, { killFirstAttempt: false })], [fauxAssistantMessage("recovered")]);
  adapter.releaseHold();
  const result = await (await adapter.root().submit(input("kill-1", "do the effect"))).result();
  assert.equal(attemptsIn(log), 1, "an interrupted unsafe tool must not run again");
  assert.equal(result.status, "completed");
  assert.equal(result.toolCalls[0]?.status, "error");
  assert.match(result.toolCalls[0] && "output" in result.toolCalls[0] ? result.toolCalls[0].output : "", /interrupt/i);
  t.diagnostic(JSON.stringify(result));
});

test("a real process kill mid-tool is recovered in a fresh process; a replay-safe tool runs again", async () => {
  const dir = scratch();
  const log = join(dir, "attempts.log");
  killChild(dir, log, "safe");
  assert.equal(attemptsIn(log), 1);

  const adapter = await reopen(dir, [effectTool(log, { killFirstAttempt: false, replay: "safe" })], [fauxAssistantMessage("recovered")]);
  adapter.releaseHold();
  const result = await (await adapter.root().submit(input("kill-1", "do the effect"))).result();
  assert.equal(attemptsIn(log), 2);
  assert.deepEqual([result.status, result.toolCalls[0]?.status, result.toolCalls[0] && "output" in result.toolCalls[0] ? result.toolCalls[0].output : ""], ["completed", "ok", EFFECT_OUTPUT]);
});

test("the root conversation is the same after reopen and can be re-acquired by ID", async () => {
  const dir = scratch();
  const first = await reopen(dir, [], []);
  const id = first.root().id;
  await first.close();
  const second = await reopen(dir, [], []);
  assert.equal(second.root().id, id);
  assert.equal((await second.conversation(id))?.id, id);
  assert.equal(await second.conversation(id + 1000), undefined);
});

test("a request fingerprint survives a restart, so reuse with different content is still rejected", async () => {
  const dir = scratch();
  const first = await reopen(dir, [], [fauxAssistantMessage("a"), fauxAssistantMessage("b")]);
  await first.root().submit(input("fp-1", "original")); // deliberately never read: no recorded result yet
  await first.close();
  const second = await reopen(dir, [], [fauxAssistantMessage("c")]);
  second.releaseHold(); // fp-1 was left unfinished, so the hold must be released before anything can be submitted
  await assert.rejects(second.root().submit(input("fp-1", "tampered")), (e) => e instanceof Error && e.name === "RequestIdConflictError");
});


test("reopening storage does not run interrupted work until the hold is released", async () => {
  const dir = scratch();
  const log = join(dir, "attempts.log");
  killChild(dir, log, "safe");
  assert.equal(attemptsIn(log), 1);

  const adapter = await reopen(dir, [effectTool(log, { killFirstAttempt: false, replay: "safe" })], [fauxAssistantMessage("recovered")]);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(attemptsIn(log), 1, "interrupted work ran without releasing the hold");
  assert.equal(await adapter.root().recorded(requestId("kill-1")), undefined);

  adapter.releaseHold();
  const deadline = Date.now() + 20000;
  while (attemptsIn(log) < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(attemptsIn(log), 2, "releaseHold() did not continue the interrupted work");
});

test("lookup() reads a settled request after a restart without starting interrupted work", async () => {
  const dir = scratch();
  const log = join(dir, "attempts.log");

  // A request that settles normally. Doing this first matters: submitting or waiting starts Pi's harness-wide
  // scheduler, which would also resume any interrupted run already in the storage.
  const earlier = await reopen(dir, [], [fauxAssistantMessage("earlier answer")]);
  const done = await (await earlier.root().submit(input("settled-1", "hi"))).result();
  await earlier.close();
  cleanup.pop(); // `reopen` registered a close for the adapter just closed explicitly

  killChild(dir, log, "safe"); // now leave request kill-1 interrupted in the same storage

  let modelCalls = 0;
  const adapter = await reopen(dir, [effectTool(log, { killFirstAttempt: false, replay: "safe" })], [() => { modelCalls += 1; return fauxAssistantMessage("must not run"); }]);
  assert.deepEqual(await adapter.root().lookup(requestId("settled-1")), done);
  assert.equal(await adapter.root().lookup(requestId("kill-1")), undefined, "an interrupted request is not settled");
  assert.equal(await adapter.root().lookup(requestId("never-seen")), undefined);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(attemptsIn(log), 1, "lookup() started interrupted work");
  assert.equal(modelCalls, 0);
});

test("requests withdrawn by an abort are still retained after a restart and can be readmitted by the new process", async () => {
  const dir = scratch();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const up = new Promise<void>((resolve) => { started = resolve; });
  const hold = {
    name: "hold", description: "Waits", parameters: Type.Object({}),
    execute: async (_args: unknown, { signal }: { signal: AbortSignal | undefined }) => { signal?.addEventListener("abort", release); started(); await gate; return "held"; },
  };
  const first = await reopen(dir, [hold as never], [fauxAssistantMessage(fauxToolCall("hold", {}, { id: "h" }), { stopReason: "toolUse" })]);
  const a = await first.root().submit(input("keep-a", "first"));
  await up;
  await first.root().submit(input("keep-b", "second"));
  const report = await first.root().abort();
  assert.deepEqual([report.aborted, report.retained], [["keep-a"], ["keep-b"]]);
  await a.result();
  await first.close();
  cleanup.pop();

  let modelCalls = 0;
  const second = await reopen(dir, [], [() => { modelCalls += 1; return fauxAssistantMessage("second ran"); }]);
  assert.deepEqual((await second.root().retainedRequests()).map((r) => [r.requestId, r.request.content]), [["keep-b", "second"]]);
  assert.equal(modelCalls, 0);
  const result = await (await second.root().readmit(requestId("keep-b"), requestId("keep-b-again"))).result();
  assert.deepEqual([result.status, result.status === "completed" && result.text, modelCalls], ["completed", "second ran", 1]);
});
