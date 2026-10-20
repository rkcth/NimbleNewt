import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { requestId, type AuditEvent } from "@nimblenewt/contracts";
import { InterruptedWorkError, InvalidRecoveryError, NotHeldError, PiAdapter } from "./index.js";
import { twoConversationTools } from "./testing/crash-fixture.js";
import { OFFLINE_MODEL_REF, createOfflineModels } from "./testing/offline.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

const count = (dir: string, name: string) => (existsSync(join(dir, `${name}.log`)) ? readFileSync(join(dir, `${name}.log`), "utf8").split("\n").filter(Boolean).length : 0);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => Promise<boolean> | boolean, what: string, ms = 20000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/** Storage left by a process killed with two conversations interrupted (root in toolA, a branch in toolB). */
function interruptedStorage(): { dir: string; ids: { root: number; branch: number } } {
  const dir = mkdtempSync(join(tmpdir(), "nn hold-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const script = fileURLToPath(new URL("./testing/crash-child-two.js", import.meta.url));
  const child = spawnSync(process.execPath, [script, dir], { encoding: "utf8", timeout: 30000 });
  if (process.platform !== "win32") assert.equal(child.signal, "SIGKILL", child.stderr);
  else assert.notEqual(child.status, 0, child.stderr);
  assert.deepEqual([count(dir, "toolA"), count(dir, "toolB")], [1, 1]);
  return { dir, ids: JSON.parse(readFileSync(join(dir, "ids.json"), "utf8")) as { root: number; branch: number } };
}

async function reopen(dir: string, options: { holdInterrupted?: boolean; audit?: (event: AuditEvent) => void } = {}) {
  const offline = createOfflineModels();
  let modelCalls = 0;
  const seen: string[] = [];
  offline.faux.setResponses(Array.from({ length: 6 }, () => (context: { messages: readonly unknown[] }) => {
    modelCalls += 1;
    seen.push(JSON.stringify(context.messages));
    return fauxAssistantMessage("B finished");
  }));
  const adapter = await PiAdapter.open({
    storage: await openNodeJsonlStorage(dir, BACKGROUND_CONTEXT), models: offline.models, model: OFFLINE_MODEL_REF,
    tools: twoConversationTools(dir, { child: false }), ...options,
  });
  cleanup.push(() => adapter.close());
  return { adapter, modelCalls: () => modelCalls, modelSaw: (text: string) => seen.some((m) => m.includes(text)) };
}

test("interrupted work is reported read-only, and everything that would make progress is refused", async () => {
  const { dir, ids } = interruptedStorage();
  const { adapter, modelCalls } = await reopen(dir);

  const report = await adapter.interrupted();
  assert.equal(report.held, true);
  assert.deepEqual(report.conversations.map((c) => c.conversationId), [ids.root, ids.branch]);
  assert.deepEqual(report.conversations.map((c) => c.requestIds), [["req-a", "req-a2", "req-u"], ["req-b"]]);
  assert.ok(report.conversations.every((c) => c.tasks > 0 && !c.abandoned));

  const root = adapter.root();
  await assert.rejects(root.submit({ kind: "input", requestId: requestId("new-1"), content: "hello" }), InterruptedWorkError);
  await assert.rejects(root.abort(), InterruptedWorkError);
  await assert.rejects(root.compact(), InterruptedWorkError);
  await assert.rejects(root.discardBranch(requestId("side")), InterruptedWorkError);
  // Checkpoints are read-only, so they work while held and start nothing.
  const heldCheckpoint = await root.checkpoint();
  assert.deepEqual(await adapter.verifyCheckpoint(heldCheckpoint), { valid: true });
  assert.deepEqual((await root.listBranches()).map((b) => [b.requestId, b.discarded]), [["side", false]], "a refused discard must not mark the branch");
  // Reads are allowed and do not disturb anything.
  assert.equal(await root.lookup(requestId("req-a")), undefined);
  assert.ok((await root.transcript()).length > 0);
  assert.deepEqual(await root.retainedRequests(), []);
  await sleep(600);
  assert.deepEqual([count(dir, "toolA"), count(dir, "toolB"), modelCalls()], [1, 1, 0], "something ran while the hold was on");
});

test("abandoning one conversation leaves the other's work untouched until release, then only the other resumes", async () => {
  const { dir, ids } = interruptedStorage();
  const { adapter, modelSaw } = await reopen(dir);

  await adapter.abandonInterrupted([ids.root]);
  const report = await adapter.interrupted();
  assert.deepEqual(report.conversations.map((c) => [c.conversationId, c.abandoned]), [[ids.root, true], [ids.branch, false]]);
  await sleep(600);
  assert.deepEqual([count(dir, "toolA"), count(dir, "toolB")], [1, 1], "abandoning ran something");

  // The abandoned request's input is framed for the model right away, before any run can start.
  const rootTranscript = await adapter.root().transcript();
  assert.equal(rootTranscript.filter((e) => e.kind === "nimblenewt.aborted-input").length, 1, "the abandoned input was not framed before release");

  await adapter.releaseHold();
  await assert.rejects(adapter.abandonInterrupted([ids.branch]), NotHeldError);
  const branch = await adapter.conversation(ids.branch);
  assert.ok(branch);
  await until(async () => (await branch.lookup(requestId("req-b")))?.status === "completed", "the branch request to finish");
  assert.equal(count(dir, "toolB"), 2, "the replay-safe tool of the kept conversation should have run again");
  assert.equal(count(dir, "toolA"), 1, "the abandoned conversation's tool ran again");
  await until(async () => (await adapter.root().lookup(requestId("req-a")))?.status === "unanswered", "the abandoned request to settle");
  const abandoned = await adapter.root().lookup(requestId("req-a"));
  assert.deepEqual([abandoned?.status, abandoned?.status === "unanswered" && abandoned.reason], ["unanswered", "aborted"]);
  assert.equal((await adapter.interrupted()).held, false);

  // The request queued behind it never started: it was withdrawn, not run, and the controller can still readmit it.
  assert.equal(modelSaw("QUEUED-AFTER-A"), false, "the queued request of an abandoned conversation reached the model");
  const queued = await adapter.root().lookup(requestId("req-a2"));
  assert.deepEqual([queued?.status, queued?.status === "unanswered" && queued.retained], ["unanswered", true]);
  assert.deepEqual((await adapter.root().retainedRequests()).map((r) => r.requestId), ["req-a2"]);

  // The queued place-only update asks the model nothing, so abandonment leaves it alone. With no run left to reach a turn
  // boundary, Pi keeps it queued until the next input places it: nothing happens behind the controller's back.
  await sleep(300);
  assert.equal(await adapter.root().lookup(requestId("req-u")), undefined);
  assert.ok(!(await adapter.root().transcript()).some((e) => e.text === "PLACED-UPDATE"));
  await (await adapter.root().submit({ kind: "input", requestId: requestId("after-recovery"), content: "carry on" })).result();
  await until(async () => (await adapter.root().lookup(requestId("req-u")))?.status === "placed", "the queued place-only update to be placed by the next input");
  assert.ok((await adapter.root().transcript()).some((e) => e.kind === "nimblenewt.update" && e.text === "PLACED-UPDATE"));
});

test("releasing the hold without abandoning anything resumes every interrupted conversation", async () => {
  const { dir, ids } = interruptedStorage();
  const { adapter } = await reopen(dir);
  await adapter.releaseHold();
  await until(() => count(dir, "toolA") === 2 && count(dir, "toolB") === 2, "both replay-safe tools to run again");
  const branch = await adapter.conversation(ids.branch);
  await until(async () => (await branch?.lookup(requestId("req-b")))?.status === "completed", "the branch request to finish");
});

test("holdInterrupted: false opts out, and a storage with nothing interrupted is never held", async () => {
  const { dir } = interruptedStorage();
  const { adapter } = await reopen(dir, { holdInterrupted: false });
  assert.equal((await adapter.interrupted()).held, false);
  await sleep(300);
  assert.equal(count(dir, "toolB"), 1, "opening alone must not run interrupted work, with or without a hold");
  // Without the hold a progress call is allowed, and (Pi's scheduler being harness-wide) it resumes the interrupted work.
  await adapter.root().submit({ kind: "input", requestId: requestId("fresh-1"), content: "anything" });
  await until(() => count(dir, "toolB") === 2, "interrupted work to resume once something makes progress");

  const clean = mkdtempSync(join(tmpdir(), "nn hold-clean-"));
  cleanup.push(() => rmSync(clean, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const fresh = await reopen(clean);
  assert.deepEqual(await fresh.adapter.interrupted(), { held: false, conversations: [] });
});

test("a discarded branch's interrupted work is abandoned automatically on release, even if the process died before aborting it", async () => {
  const { dir, ids } = interruptedStorage();
  const { adapter } = await reopen(dir);

  // The crash window: the branch was marked discarded, then the process died before its work was aborted.
  await adapter.root().markBranchDiscardedForTests(requestId("side"));
  const report = await adapter.interrupted();
  assert.deepEqual(report.conversations.map((c) => [c.conversationId, c.discarded]), [[ids.root, false], [ids.branch, true]]);

  await adapter.releaseHold();
  await until(() => count(dir, "toolA") === 2, "the root conversation's replay-safe tool to run again");
  await sleep(400);
  assert.equal(count(dir, "toolB"), 1, "the discarded branch's interrupted tool ran again");
  const branch = await adapter.conversation(ids.branch);
  await until(async () => (await branch?.lookup(requestId("req-b")))?.status === "unanswered", "the discarded branch's request to settle");
});

test("recover() is one reviewed step: it validates the decision, abandons, releases, and records what was found", async () => {
  const { dir, ids } = interruptedStorage();
  const events: AuditEvent[] = [];
  const { adapter } = await reopen(dir, { audit: (event) => { events.push(event); } });
  const decision = { abandon: [ids.root], reason: "the root task was cancelled by the owner", decidedBy: "rob" };

  await assert.rejects(adapter.recover({ ...decision, reason: " " }), InvalidRecoveryError);
  await assert.rejects(adapter.recover({ ...decision, decidedBy: "" }), InvalidRecoveryError);
  await assert.rejects(adapter.recover({ ...decision, abandon: [987654] }), InvalidRecoveryError);
  assert.equal((await adapter.interrupted()).held, true, "a refused decision must change nothing");
  assert.equal(events.length, 0);
  await sleep(300);
  assert.deepEqual([count(dir, "toolA"), count(dir, "toolB")], [1, 1]);

  const found = await adapter.interrupted();
  await adapter.recover(decision);
  assert.equal((await adapter.interrupted()).held, false);
  assert.deepEqual(events.map((e) => e.type), ["recover"]);
  const event = events[0]!;
  assert.ok(event.type === "recover");
  assert.deepEqual([event.decision, event.found], [decision, found]);

  const branch = await adapter.conversation(ids.branch);
  await until(async () => (await branch?.lookup(requestId("req-b")))?.status === "completed", "the kept conversation to resume");
  assert.deepEqual([count(dir, "toolA"), count(dir, "toolB")], [1, 2], "only the kept conversation's tool ran again");
  await assert.rejects(adapter.recover(decision), NotHeldError, "recovery cannot be repeated once the hold is released");
});
