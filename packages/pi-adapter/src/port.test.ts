import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { requestId, type AuditEvent, type RecoveryDecision, type RuntimePort } from "@nimblenewt/contracts";
import { fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { InvalidRecoveryError, NotHeldError, PiAdapter, type AdapterTool, type PiAdapterOptions } from "./index.js";
import { OFFLINE_MODEL_REF, createOfflineModels } from "./testing/offline.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function open(extra: Partial<PiAdapterOptions> = {}, tools: readonly AdapterTool[] = []) {
  const offline = createOfflineModels();
  const events: AuditEvent[] = [];
  const adapter = await PiAdapter.open({ storage: new MemoryStorage(), models: offline.models, model: OFFLINE_MODEL_REF, tools, audit: (event) => { events.push(event); }, ...extra });
  cleanup.push(() => adapter.close());
  return { adapter, faux: offline.faux, events };
}
const input = (id: string, content: string) => ({ kind: "input", requestId: requestId(id), content }) as const;

function holdingTool() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const up = new Promise<void>((resolve) => { started = resolve; });
  const tool: AdapterTool = { name: "hold", description: "Waits", parameters: Type.Object({}), execute: async (_a, { signal }) => { signal?.addEventListener("abort", release); started(); await gate; return "held"; } };
  return { tool, up };
}

test("a controller written only against the contract port can run a task, branch it, checkpoint it and restore it", async () => {
  const { adapter, faux } = await open();
  const runtime: RuntimePort = adapter; // the adapter satisfies the harness-agnostic port, checked by the compiler too
  faux.setResponses([fauxAssistantMessage("task answer"), fauxAssistantMessage("inquiry answer")]);

  const conversation = runtime.root();
  const result = await (await conversation.submit(input("p-1", "do the task"))).result();
  assert.deepEqual([result.status, "text" in result && result.text], ["completed", "task answer"]);

  const checkpoint = await conversation.checkpoint();
  assert.deepEqual(await runtime.verifyCheckpoint(checkpoint), { valid: true });
  const branch = await conversation.branch({ requestId: requestId("p-branch") });
  assert.equal((await (await branch.conversation.submit(input("p-ask", "how is it going?"))).result()).status, "completed");
  assert.deepEqual((await conversation.listBranches()).map((b) => b.requestId), ["p-branch"]);
  const restored = await runtime.restoreCheckpoint(checkpoint, requestId("p-restore"));
  assert.ok((await restored.conversation.transcript()).some((e) => e.text === "task answer"));
  assert.equal(await conversation.lookup(requestId("p-1")).then((r) => r?.status), "completed");
  assert.deepEqual(await runtime.interrupted(), { held: false, conversations: [] });
  assert.equal((await runtime.conversation(restored.conversation.id))?.id, restored.conversation.id);
});

test("controller-reviewed actions are reported as audit events after they take effect, once each", async () => {
  const hold = holdingTool();
  const { adapter, faux, events } = await open({}, [hold.tool]);
  const conversation = adapter.root();
  faux.setResponses([fauxAssistantMessage("task answer")]);
  await (await conversation.submit(input("a-1", "do the task"))).result();
  assert.equal(events.length, 0, "ordinary submissions are not audited");

  const checkpoint = await conversation.checkpoint();
  const restored = await adapter.restoreCheckpoint(checkpoint, requestId("a-restore"));
  const branch = await conversation.branch({ requestId: requestId("a-branch") });
  faux.setResponses([fauxAssistantMessage(fauxToolCall("hold", {}, { id: "h" }), { stopReason: "toolUse" })]);
  await branch.conversation.submit(input("a-ask", "inquire"));
  await hold.up;
  const report = await conversation.discardBranch(requestId("a-branch"));

  faux.setResponses([fauxAssistantMessage(fauxToolCall("hold", {}, { id: "h2" }), { stopReason: "toolUse" })]);
  await conversation.submit(input("a-run", "run"));
  await conversation.submit(input("a-queued", "queued"));
  const aborted = await conversation.abort();
  await conversation.readmit(requestId("a-queued"), requestId("a-queued-again"));

  assert.deepEqual(events.map((e) => e.type), ["restore_checkpoint", "discard_branch", "abort", "readmit"],
    "discarding a branch is one event, not also an abort event for the branch's own abort");
  const [restoreEvent, discardEvent, abortEvent, readmitEvent] = events;
  assert.ok(restoreEvent?.type === "restore_checkpoint" && discardEvent?.type === "discard_branch" && abortEvent?.type === "abort" && readmitEvent?.type === "readmit");
  assert.deepEqual(restoreEvent, { type: "restore_checkpoint", at: restoreEvent.at, checkpoint, branchRequestId: "a-restore", newConversationId: restored.conversation.id });
  assert.deepEqual([discardEvent.report, discardEvent.branchRequestId], [report, "a-branch"]);
  assert.deepEqual(abortEvent.report, aborted);
  assert.deepEqual([readmitEvent.requestId, readmitEvent.newRequestId], ["a-queued", "a-queued-again"]);
  assert.ok(events.every((e) => typeof e.at === "number" && e.at > 0));
});

test("a failing audit sink surfaces its error to the caller, after the action has taken effect", async () => {
  const { adapter, faux } = await open({ audit: () => { throw new Error("audit store down"); } });
  faux.setResponses([fauxAssistantMessage("task answer")]);
  const conversation = adapter.root();
  await (await conversation.submit(input("f-1", "do the task"))).result();
  await assert.rejects(conversation.branch({ requestId: requestId("f-branch") }).then((b) => conversation.discardBranch(requestId("f-branch")).then(() => b)), /audit store down/);
  assert.equal((await conversation.listBranches())[0]?.discarded, true, "the discard had already taken effect");
});

test("recover(): not valid when nothing is held, and needs a reason and a decider", async () => {
  const { adapter } = await open();
  const decision: RecoveryDecision = { abandon: [], reason: "reviewed after the crash", decidedBy: "rob" };
  await assert.rejects(adapter.recover(decision), NotHeldError);
  await assert.rejects(adapter.recover({ ...decision, reason: "  " }), NotHeldError, "the hold check comes first");
});
