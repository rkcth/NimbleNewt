// G02: first-milestone acceptance of the Pi adapter. These tests drive the actual NimbleNewt adapter, opened on Pi's JSONL
// storage with a pinned runtime and a deterministic provider, and use only the controller-facing contract types
// (`RuntimePort`, `ConversationPort`) for everything they check. Process death is a real SIGKILL of a child process.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { requestId, type AuditEvent, type ConversationPort, type RuntimePort, type SemanticResult } from "@nimblenewt/contracts";
import { PINNED_PI_DURABLE_VERSION, PiAdapter, detectRuntime, type AdapterTool, type PiAdapterOptions } from "./index.js";
import { attemptsIn, effectTool, twoConversationTools } from "./testing/crash-fixture.js";
import { OFFLINE_MODEL_REF, createOfflineModels } from "./testing/offline.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

const SENTINEL = "SEMANTIC-OUTPUT-SENTINEL";
const input = (id: string, content: string) => ({ kind: "input", requestId: requestId(id), content }) as const;
const text = (r: SemanticResult | undefined) => (r !== undefined && "text" in r ? r.text : "");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `nn ${prefix}-`));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

const echo: AdapterTool = { name: "echo", description: "Returns a sentinel", parameters: Type.Object({}), execute: async () => SENTINEL };

/** Opens the adapter on JSONL storage in `dir` and hands back only the controller-facing port. */
async function openRuntime(dir: string, options: { tools?: readonly AdapterTool[]; slow?: boolean; extra?: Partial<PiAdapterOptions> } = {}) {
  const offline = createOfflineModels(options.slow ? { slowStream: { tokensPerSecond: 40, tokenSize: 3 } } : {});
  const events: AuditEvent[] = [];
  const adapter = await PiAdapter.open({
    storage: await openNodeJsonlStorage(dir, BACKGROUND_CONTEXT), models: offline.models, model: OFFLINE_MODEL_REF,
    tools: options.tools ?? [], audit: (event) => { events.push(event); }, ...options.extra,
  });
  cleanup.push(() => adapter.close());
  const runtime: RuntimePort = adapter;
  return { runtime, faux: offline.faux, events, close: async () => { await adapter.close(); cleanup.pop(); } };
}

/**
 * Scripted replies chosen by what the model is being asked right now (its last message), since several conversations share
 * one scripted model and their histories overlap.
 */
interface Asked { readonly role: string; readonly text: string; readonly all: string }
/** A model request reduced to `role: text` lines, so two requests can be compared for exactly the same context. */
function project(requestJson: string): string[] {
  return (JSON.parse(requestJson) as { role: string; content: unknown }[]).map((message) => {
    const body = typeof message.content === "string" ? message.content
      : (message.content as { type: string; text?: string; name?: string }[]).map((part) => (part.type === "text" ? part.text : part.type === "toolCall" ? `<call ${part.name}>` : `<${part.type}>`)).join("");
    return `${message.role}: ${body}`;
  });
}
const lastLine = (requestJson: string) => project(requestJson).at(-1) ?? "";

type Rule = { readonly when: (asked: Asked) => boolean; readonly reply: (asked: Asked) => ReturnType<typeof fauxAssistantMessage> };
function script(rules: readonly Rule[], onRequest?: (all: string) => void) {
  return Array.from({ length: 60 }, () => (context: { messages: readonly unknown[] }) => {
    const all = JSON.stringify(context.messages);
    onRequest?.(all);
    const last = (context.messages.at(-1) ?? {}) as { role?: string; content?: unknown };
    const asked: Asked = { role: String(last.role), text: typeof last.content === "string" ? last.content : JSON.stringify(last.content), all };
    const rule = rules.find((r) => r.when(asked));
    return rule ? rule.reply(asked) : fauxAssistantMessage(`no rule matched: ${asked.role} ${asked.text.slice(0, 80)}`);
  });
}

test("G02 milestone: tasks, tool output, dedupe, inquiry, update, compaction, checkpoints, across a restart", async () => {
  const dir = scratch("g02");
  const requests: string[] = [];
  const rules: Rule[] = [
    { when: (q) => q.text.includes("summar") || q.text.includes("Summar"), reply: () => fauxAssistantMessage("SUMMARY-OF-ALPHA") },
    { when: (q) => q.role === "user" && q.text.includes("ALPHA-WORK"), reply: () => fauxAssistantMessage(fauxToolCall("echo", {}, { id: "alpha-echo" }), { stopReason: "toolUse" }) },
    { when: (q) => q.role === "toolResult", reply: (q) => fauxAssistantMessage(q.text.includes(SENTINEL) ? "alpha saw the tool output" : "alpha MISSED the tool output") },
    { when: (q) => q.text.includes("INQUIRY"), reply: (q) => fauxAssistantMessage(q.all.includes("ALPHA-WORK") ? "inquiry saw alpha's context" : "inquiry saw nothing") },
    { when: (q) => q.text.includes("BETA-WORK"), reply: () => fauxAssistantMessage("beta answer") },
    { when: (q) => q.text.includes("Decision: use plan B"), reply: () => fauxAssistantMessage("alpha continues with plan B") },
    { when: (q) => q.text.includes("alpha-continue"), reply: () => fauxAssistantMessage("alpha continues unchanged") },
  ];
  const first = await openRuntime(dir, { tools: [echo], extra: { settings: { compaction: { keepRecentTokens: 1 } } } });
  first.faux.setResponses(script(rules, (m) => requests.push(m)));

  // (a) Tasks A and B start with empty, separate contexts.
  const alpha = (await first.runtime.createTask({ requestId: requestId("task-alpha") })).conversation;
  const beta = (await first.runtime.createTask({ requestId: requestId("task-beta") })).conversation;
  assert.deepEqual([(await alpha.transcript()).length, (await beta.transcript()).length], [0, 0]);

  // (d) Semantic tool output reaches the next model step; the same request ID is deduplicated.
  const alphaFirst = await (await alpha.submit(input("alpha-1", "ALPHA-WORK: do the thing"))).result();
  assert.deepEqual([alphaFirst.status, text(alphaFirst), alphaFirst.toolCalls.map((c) => [c.name, c.status])], ["completed", "alpha saw the tool output", [["echo", "ok"]]]);
  const callsBefore = requests.length;
  const duplicate = await alpha.submit(input("alpha-1", "ALPHA-WORK: do the thing"));
  assert.deepEqual(await duplicate.result(), alphaFirst);
  assert.equal(requests.length, callsBefore, "a duplicate submission reached the model");
  const betaFirst = await (await beta.submit(input("beta-1", "BETA-WORK: unrelated"))).result();
  assert.equal(text(betaFirst), "beta answer");
  assert.ok(!(await beta.transcript()).some((e) => e.text.includes("ALPHA")), "task B saw task A's context");

  // (b) An inquiry branch sees A's context and leaves A unchanged; the unchanged resume carries nothing of the inquiry.
  const alphaBefore = await alpha.transcript();
  const inquiry = await alpha.branch({ requestId: requestId("inquiry-1") });
  const answer = await (await inquiry.conversation.submit(input("inq-ask", "INQUIRY: how is it going?"))).result();
  assert.equal(text(answer), "inquiry saw alpha's context");
  assert.deepEqual(await alpha.transcript(), alphaBefore, "the inquiry changed the task");
  const unchanged = await (await alpha.submit(input("alpha-2", "alpha-continue (no update)"))).result();
  assert.equal(text(unchanged), "alpha continues unchanged");
  assert.ok(!requests.at(-1)!.includes("INQUIRY: how is it going?"), "the inquiry reached the task's model request");

  //     A selected update is applied exactly once and the updated resume sees it.
  const update = { kind: "update", requestId: requestId("update-1"), content: "Decision: use plan B", source: { conversationId: inquiry.conversation.id, entryId: (await inquiry.conversation.transcript()).at(-1)!.id } } as const;
  const applied = await alpha.submit(update);
  const appliedAgain = await alpha.submit(update);
  assert.equal(appliedAgain.submissionId, applied.submissionId);
  assert.equal(text(await applied.result()), "alpha continues with plan B");
  assert.equal((await alpha.transcript()).filter((e) => e.kind === "nimblenewt.update").length, 1);

  //     The resumes are exactly the task's prior context plus the new input: nothing is lost, nothing from the inquiry is added.
  const toolRoundRequest = requests.find((r) => lastLine(r).startsWith("toolResult:") && project(r).some((l) => l.includes("ALPHA-WORK")));
  const unchangedResume = requests.find((r) => lastLine(r) === "user: alpha-continue (no update)");
  const updatedResume = requests.find((r) => lastLine(r) === "user: Decision: use plan B");
  assert.ok(toolRoundRequest && unchangedResume && updatedResume, "the requests under comparison were not recorded");
  assert.deepEqual(project(unchangedResume), [...project(toolRoundRequest), "assistant: alpha saw the tool output", "user: alpha-continue (no update)"], "the unchanged resume is not exactly the task's prior context plus the new input");
  assert.deepEqual(project(updatedResume), [...project(unchangedResume), "assistant: alpha continues unchanged", "user: Decision: use plan B"], "the updated resume is not exactly the prior context plus the update");

  // (e) Compaction keeps history recoverable: a checkpoint from before still verifies and restores the older context, and a
  //     branch taken after compaction gets the compacted context.
  const beforeCompaction = await alpha.checkpoint();
  const oldContext = (await alpha.transcript()).map((e) => e.text).join("|");
  const summaryRequests = requests.length;
  await alpha.compact();
  assert.ok(requests.length > summaryRequests, "compaction did not ask the model for a summary");
  const afterCompaction = await alpha.checkpoint();
  assert.ok(afterCompaction.at > beforeCompaction.at);
  assert.deepEqual(await first.runtime.verifyCheckpoint(beforeCompaction), { valid: true });
  //     A checkpoint that cannot be trusted is refused, with a reason: damaged history, or a different runtime.
  const flipped = beforeCompaction.digest.endsWith("0") ? "1" : "0";
  const reasonFor = async (checkpoint: typeof beforeCompaction) => { const verdict = await first.runtime.verifyCheckpoint(checkpoint); return verdict.valid ? "valid" : verdict.reason; };
  assert.equal(await reasonFor({ ...beforeCompaction, digest: `${beforeCompaction.digest.slice(0, -1)}${flipped}` }), "history_changed");
  assert.equal(await reasonFor({ ...beforeCompaction, runtimeVersion: "0.0.0-other" }), "incompatible_runtime");
  assert.equal(await reasonFor({ ...beforeCompaction, at: beforeCompaction.at + 100000 }), "unknown_entry");
  const restoredOld = await first.runtime.restoreCheckpoint(beforeCompaction, requestId("restore-old"));
  assert.equal((await restoredOld.conversation.transcript()).map((e) => e.text).join("|"), oldContext, "restoring the pre-compaction checkpoint must give back the older, uncompacted history");

  // Everything is on disk. Close, then reopen in a fresh adapter.
  const checkpointForRestart = afterCompaction;
  await first.close();

  const second = await openRuntime(dir, { tools: [echo] });
  second.faux.setResponses(script(rules, (m) => requests.push(m)));
  assert.deepEqual(await second.runtime.interrupted(), { held: false, conversations: [] });
  const alphaAgain = await second.runtime.createTask({ requestId: requestId("task-alpha") });
  const betaAgain = await second.runtime.createTask({ requestId: requestId("task-beta") });
  assert.deepEqual([alphaAgain.created, betaAgain.created, alphaAgain.conversation.id, betaAgain.conversation.id], [false, false, alpha.id, beta.id]);
  assert.deepEqual(await alphaAgain.conversation.lookup(requestId("alpha-1")), alphaFirst);
  assert.deepEqual(await second.runtime.verifyCheckpoint(checkpointForRestart), { valid: true });
  const dedupeAfterRestart = requests.length;
  assert.deepEqual(await (await alphaAgain.conversation.submit(input("alpha-1", "ALPHA-WORK: do the thing"))).result(), alphaFirst);
  assert.equal(requests.length, dedupeAfterRestart, "a duplicate after restart reached the model");
  assert.ok(!(await betaAgain.conversation.transcript()).some((e) => e.text.includes("ALPHA")), "task separation did not survive the restart");
  const branchAfterCompaction = await alphaAgain.conversation.branch({ requestId: requestId("after-compaction") });
  assert.ok((await branchAfterCompaction.conversation.transcript()).some((e) => e.kind === "pi.compaction"), "a branch taken after compaction should start from the compaction");
  const kinds = second.events.map((e) => e.type);
  assert.deepEqual(kinds, [], "reads and ordinary submissions after the restart must not produce audit events");
});

test("G02 abort during streaming of partial tool arguments: no tool runs, queued input retained, readmitted once", async () => {
  let executions = 0;
  const danger: AdapterTool<ReturnType<typeof Type.Object<{ payload: ReturnType<typeof Type.String> }>>> = {
    name: "danger", description: "Has an external effect", parameters: Type.Object({ payload: Type.String() }), execute: async () => { executions += 1; return "ran"; },
  };
  const { runtime, faux, events } = await openRuntime(scratch("g02-stream"), { tools: [danger as unknown as AdapterTool], slow: true });
  const conversation = runtime.root();
  let answered = 0;
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("danger", { payload: "x".repeat(400) }, { id: "partial-call" }), { stopReason: "toolUse" }),
    () => { answered += 1; return fauxAssistantMessage("queued request ran"); },
  ]);
  const running = await conversation.submit(input("stream-1", "start the dangerous thing"));
  await conversation.submit(input("queued-1", "do this afterwards"));
  await sleep(400); // part-way through the arguments (asserted below)
  const report = await conversation.abort();
  assert.deepEqual([report.aborted, report.retained], [["stream-1"], ["queued-1"]]);
  const stopped = await running.result();
  assert.deepEqual([stopped.status, stopped.status === "unanswered" && stopped.reason, stopped.toolCalls], ["unanswered", "aborted", []]);
  const partial = (await conversation.transcript()).find((e) => e.kind === "pi.assistant");
  assert.deepEqual([partial?.stopReason, partial?.toolCallIds], ["aborted", ["partial-call"]], "the abort did not land while the tool call was streaming");
  assert.equal(executions, 0, "a partially streamed tool call executed");

  await sleep(300);
  assert.equal(answered, 0, "the withdrawn request ran without being readmitted");
  const retained = await conversation.retainedRequests();
  assert.deepEqual(retained.map((r) => [r.requestId, r.request.content]), [["queued-1", "do this afterwards"]]);
  const readmitted = await conversation.readmit(requestId("queued-1"), requestId("queued-1-again"));
  assert.equal(text(await readmitted.result()), "queued request ran");
  assert.equal(answered, 1, "the retained request ran more than once");
  assert.equal(executions, 0);
  assert.deepEqual(events.map((e) => e.type), ["abort", "readmit"]);
});

/** Starts a child process that leaves `kill-1` interrupted in `dir` (killed with SIGKILL in the middle of a tool call). */
function killChild(dir: string, log: string, replay?: "safe") {
  const script = fileURLToPath(new URL("./testing/crash-child.js", import.meta.url));
  const child = spawnSync(process.execPath, [script, dir, log, ...(replay === undefined ? [] : [replay])], { encoding: "utf8", timeout: 30000 });
  if (process.platform !== "win32") assert.equal(child.signal, "SIGKILL", child.stderr);
  else assert.notEqual(child.status, 0, child.stderr);
  assert.equal(attemptsIn(log), 1);
}

test("G02 real process kill: recovery through recover(), an unsafe tool is not re-run and the model is told it was interrupted", async () => {
  const dir = scratch("g02-kill-unsafe");
  const log = join(dir, "attempts.log");
  killChild(dir, log);
  const { runtime, faux, events } = await openRuntime(dir, { tools: [effectTool(log, { killFirstAttempt: false })] });
  faux.setResponses([fauxAssistantMessage("recovered")]);

  assert.equal((await runtime.interrupted()).held, true);
  await assert.rejects(runtime.root().submit(input("new-work", "anything")), (e) => e instanceof Error && e.name === "InterruptedWorkError");
  await sleep(300);
  assert.equal(attemptsIn(log), 1, "something ran while the hold was on");

  await runtime.recover({ abandon: [], reason: "reviewed: the effect may have partially run, let the model decide", decidedBy: "g02" });
  const result = await (await runtime.root().submit(input("kill-1", "do the effect"))).result();
  assert.equal(attemptsIn(log), 1, "an interrupted tool that is not replay-safe ran again");
  assert.deepEqual([result.status, result.toolCalls[0]?.status], ["completed", "error"]);
  assert.match(result.toolCalls[0] && "output" in result.toolCalls[0] ? result.toolCalls[0].output : "", /interrupt/i);
  assert.deepEqual(events.map((e) => e.type), ["recover"]);
});

test("G02 real process kill: a replay-safe tool re-runs once after recover()", async () => {
  const dir = scratch("g02-kill-safe");
  const log = join(dir, "attempts.log");
  killChild(dir, log, "safe");
  const { runtime, faux } = await openRuntime(dir, { tools: [effectTool(log, { killFirstAttempt: false, replay: "safe" })] });
  faux.setResponses([fauxAssistantMessage("recovered")]);
  await runtime.recover({ abandon: [], reason: "the effect is idempotent", decidedBy: "g02" });
  const result = await (await runtime.root().submit(input("kill-1", "do the effect"))).result();
  assert.equal(attemptsIn(log), 2);
  assert.deepEqual([result.status, result.toolCalls[0]?.status], ["completed", "ok"]);
});

test("G02 real process kill with two conversations: recover() abandons one and resumes the other", async () => {
  const dir = scratch("g02-kill-two");
  const script = fileURLToPath(new URL("./testing/crash-child-two.js", import.meta.url));
  const child = spawnSync(process.execPath, [script, dir], { encoding: "utf8", timeout: 30000 });
  if (process.platform !== "win32") assert.equal(child.signal, "SIGKILL", child.stderr);
  else assert.notEqual(child.status, 0, child.stderr);
  const ids = JSON.parse(readFileSync(join(dir, "ids.json"), "utf8")) as { root: number; branch: number };
  const count = (name: string) => (existsSync(join(dir, `${name}.log`)) ? readFileSync(join(dir, `${name}.log`), "utf8").split("\n").filter(Boolean).length : 0);

  const { runtime, faux } = await openRuntime(dir, { tools: twoConversationTools(dir, { child: false }) });
  faux.setResponses(Array.from({ length: 6 }, () => () => fauxAssistantMessage("B finished")));
  const found = await runtime.interrupted();
  assert.deepEqual(found.conversations.map((c) => c.conversationId), [ids.root, ids.branch]);
  await runtime.recover({ abandon: [ids.root], reason: "task A was cancelled by the owner", decidedBy: "g02" });
  const branch = await runtime.conversation(ids.branch);
  const deadline = Date.now() + 20000;
  while ((await branch?.lookup(requestId("req-b")))?.status !== "completed" && Date.now() < deadline) await sleep(50);
  assert.equal((await branch?.lookup(requestId("req-b")))?.status, "completed");
  assert.deepEqual([count("toolA"), count("toolB")], [1, 2], "only the kept conversation's replay-safe tool ran again");
  assert.equal((await runtime.root().lookup(requestId("req-a")))?.status, "unanswered");
});

test("G02 environment: the exact runtime pin and the lockfile agree, and are recorded with the platform", (t) => {
  const runtime = detectRuntime();
  assert.equal(runtime.piDurableVersion, PINNED_PI_DURABLE_VERSION);
  const lockPath = fileURLToPath(new URL("../../../package-lock.json", import.meta.url));
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { packages: Record<string, { version?: string }> };
  assert.equal(lock.packages["node_modules/@earendil-works/pi-durable"]?.version, PINNED_PI_DURABLE_VERSION, "the lockfile does not pin the adapter's Pi Durable version");
  t.diagnostic(`G02 environment: ${process.platform}/${process.arch} node ${process.versions.node} pi-durable ${runtime.piDurableVersion}`);
});
