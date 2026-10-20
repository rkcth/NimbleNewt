import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { requestId, type Checkpoint } from "@nimblenewt/contracts";
import { CheckpointRejectedError, InvalidBranchPointError, NoBranchPointError, PiAdapter, canonicalJson, digestHistory, type PiAdapterOptions } from "./index.js";
import { OFFLINE_MODEL_REF, createOfflineModels } from "./testing/offline.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

const input = (id: string, content: string) => ({ kind: "input", requestId: requestId(id), content }) as const;

async function open(extra: Partial<PiAdapterOptions> = {}) {
  const offline = createOfflineModels();
  const adapter = await PiAdapter.open({ storage: new MemoryStorage(), models: offline.models, model: OFFLINE_MODEL_REF, ...extra });
  cleanup.push(() => adapter.close());
  return { adapter, faux: offline.faux };
}

async function taskWithTwoTurns(content = "first request") {
  const world = await open();
  world.faux.setResponses([fauxAssistantMessage("answer one"), fauxAssistantMessage("answer two")]);
  const conversation = world.adapter.root();
  await (await conversation.submit(input("turn-1", content))).result();
  const afterFirst = await conversation.checkpoint();
  await (await conversation.submit(input("turn-2", "second request"))).result();
  return { ...world, conversation, afterFirst };
}

test("a checkpoint is a small portable record of a completed-turn boundary, and it verifies", async () => {
  const { adapter, conversation, afterFirst } = await taskWithTwoTurns();
  assert.deepEqual(Object.keys(afterFirst).sort(), ["at", "contractsVersion", "conversationId", "digest", "format", "runtimeVersion"]);
  assert.match(afterFirst.digest, /^v1:sha256:[0-9a-f]{64}$/);
  assert.equal(afterFirst.conversationId, conversation.id);
  const roundTripped = JSON.parse(JSON.stringify(afterFirst)) as Checkpoint;
  assert.deepEqual(await adapter.verifyCheckpoint(roundTripped), { valid: true });
  assert.deepEqual(await conversation.verifyCheckpoint(roundTripped), { valid: true });
  // The default checkpoint is the latest boundary: the end of the second turn, later than the first checkpoint.
  const latest = await conversation.checkpoint();
  assert.ok(latest.at > afterFirst.at && latest.digest !== afterFirst.digest);
  assert.equal(latest.at, (await conversation.transcript()).at(-1)?.id);
});

test("later turns and compaction do not invalidate an earlier checkpoint", async () => {
  const { adapter, faux, conversation, afterFirst } = await taskWithTwoTurns();
  faux.setResponses([fauxAssistantMessage("a summary")]);
  await conversation.compact();
  assert.deepEqual(await adapter.verifyCheckpoint(afterFirst), { valid: true });
  const afterCompaction = await conversation.checkpoint();
  assert.deepEqual(await adapter.verifyCheckpoint(afterCompaction), { valid: true });
});

test("a checkpoint still verifies after the storage is reopened in a fresh adapter", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn checkpoint-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const reopen = async () => {
    const offline = createOfflineModels();
    offline.faux.setResponses([fauxAssistantMessage("answer one")]);
    const adapter = await PiAdapter.open({ storage: await openNodeJsonlStorage(dir, BACKGROUND_CONTEXT), models: offline.models, model: OFFLINE_MODEL_REF });
    cleanup.push(() => adapter.close());
    return adapter;
  };
  const first = await reopen();
  await (await first.root().submit(input("turn-1", "first request"))).result();
  const checkpoint = JSON.parse(JSON.stringify(await first.root().checkpoint())) as Checkpoint;
  await first.close();
  cleanup.pop();
  assert.deepEqual(await (await reopen()).verifyCheckpoint(checkpoint), { valid: true });
});

test("a checkpoint is rejected, with a reason, when it cannot be trusted", async () => {
  const { adapter, conversation, afterFirst } = await taskWithTwoTurns();
  const reasons = async (checkpoint: unknown) => {
    const verdict = await adapter.verifyCheckpoint(checkpoint as Checkpoint);
    return verdict.valid ? "valid" : verdict.reason;
  };
  assert.equal(await reasons({ ...afterFirst, format: 2 }), "unsupported_format");
  assert.equal(await reasons({ ...afterFirst, runtimeVersion: "1.2.0" }), "incompatible_runtime");
  // The contracts version is informational: an unrelated contract change must not invalidate checkpoints.
  assert.equal(await reasons({ ...afterFirst, contractsVersion: 999 }), "valid");
  assert.equal(await reasons({ ...afterFirst, digest: afterFirst.digest.replace("v1:", "v2:") }), "unsupported_format");
  assert.equal(await reasons({ ...afterFirst, conversationId: 424242 }), "unknown_conversation");
  assert.equal(await reasons({ ...afterFirst, at: 999999 }), "unknown_entry");
  const userEntry = (await conversation.transcript()).find((e) => e.kind === "pi.user");
  assert.equal(await reasons({ ...afterFirst, at: userEntry?.id }), "not_a_boundary");
  const flipped = afterFirst.digest.endsWith("0") ? "1" : "0"; // always a different digest
  assert.equal(await reasons({ ...afterFirst, digest: `${afterFirst.digest.slice(0, -1)}${flipped}` }), "history_changed");
  assert.equal(await reasons(afterFirst), "valid");
  // A conversation handle also refuses a checkpoint that belongs to another conversation.
  const other = (await adapter.root().branch({ requestId: requestId("other") })).conversation;
  const verdict = await other.verifyCheckpoint(afterFirst);
  assert.deepEqual([verdict.valid, !verdict.valid && verdict.reason], [false, "unknown_conversation"]);
});

test("a store whose history differs (a different or damaged backup) does not verify against the original's checkpoint", async () => {
  const original = await taskWithTwoTurns("first request");
  const lookalike = await taskWithTwoTurns("a different first request"); // same entry IDs, different content
  assert.equal(original.afterFirst.at, lookalike.afterFirst.at);
  const verdict = await lookalike.adapter.verifyCheckpoint(original.afterFirst);
  assert.deepEqual([verdict.valid, !verdict.valid && verdict.reason], [false, "history_changed"]);
});

test("restoring a checkpoint gives a new conversation with the task as it was, without later turns, once per request ID", async () => {
  const { adapter, faux, conversation, afterFirst } = await taskWithTwoTurns();
  const restored = await adapter.restoreCheckpoint(afterFirst, requestId("restore-1"));
  assert.notEqual(restored.conversation.id, conversation.id);
  assert.equal(restored.forkedAt, afterFirst.at);
  const text = (await restored.conversation.transcript()).map((e) => e.text).join("|");
  assert.ok(text.includes("first request") && text.includes("answer one"));
  assert.ok(!text.includes("second request") && !text.includes("answer two"), "the restored context contains later turns");

  let saw = "";
  faux.setResponses([(context) => { saw = JSON.stringify(context.messages); return fauxAssistantMessage("continued"); }]);
  assert.equal((await (await restored.conversation.submit(input("go-on", "carry on from there"))).result()).status, "completed");
  assert.ok(saw.includes("answer one") && !saw.includes("answer two"));

  assert.equal((await adapter.restoreCheckpoint(afterFirst, requestId("restore-1"))).conversation.id, restored.conversation.id);
  await assert.rejects(adapter.restoreCheckpoint({ ...afterFirst, digest: "v1:sha256:00" }, requestId("restore-2")), (e) => e instanceof CheckpointRejectedError && e.reason === "history_changed");
  assert.equal((await conversation.listBranches()).length, 1, "a rejected checkpoint must not create a branch");
});

test("checkpoints can only be taken at completed-turn boundaries", async () => {
  const fresh = await open();
  await assert.rejects(fresh.adapter.root().checkpoint(), NoBranchPointError);
  const { adapter, conversation } = await taskWithTwoTurns();
  const transcript = await conversation.transcript();
  const userEntry = transcript.find((e) => e.kind === "pi.user");
  const firstAnswer = transcript.find((e) => e.kind === "pi.assistant");
  assert.ok(userEntry && firstAnswer);
  await assert.rejects(conversation.checkpoint({ at: userEntry.id }), InvalidBranchPointError);
  const older = await conversation.checkpoint({ at: firstAnswer.id });
  assert.ok(older.at < (await conversation.checkpoint()).at);
  assert.deepEqual(await adapter.verifyCheckpoint(older), { valid: true }, "a checkpoint at an older boundary covers only the history up to it");
});

test("digests are canonical: key order and input order do not matter, any covered field does", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, 2], c: null } }), canonicalJson({ a: { c: null, d: [1, 2] }, b: 1 }));
  const base = { id: 1, kind: "pi.user", model: [{ role: "user", content: "hi" }], data: { x: 1 } };
  const entries = [base, { id: 2, kind: "pi.assistant", model: [{ role: "assistant", content: [] }] }];
  const digest = digestHistory(entries);
  assert.equal(digestHistory([...entries].reverse()), digest);
  for (const changed of [
    { ...base, id: 9 }, { ...base, kind: "x" }, { ...base, model: [{ role: "user", content: "ho" }] }, { ...base, data: { x: 2 } },
    { ...base, edits: [{ target: 1, action: "omit" }] }, { ...base, head: 1 },
  ]) assert.notEqual(digestHistory([changed, entries[1]!]), digest);
});
