import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type, createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import {
  DISPATCHER_PRINCIPAL, GenerationService, bridgeCommandId,
  type ControllerStorage, type EffectBridge, type Fence, type JsonObject, type Principal,
} from "@nimblenewt/controller";
import * as harness from "@nimblenewt/controller/testing";
import { PiAdapter, type AdapterTool } from "@nimblenewt/pi-adapter";
import { piConversation } from "./conversation.js";
import { Chaos, Clock, OperationSpy, acknowledgedSurvive, describe, openStore, operationsOf, runChild, type Clean, type Slice, type SliceWorld, type StoreSpec } from "./g04-fixture.js";

// Card G04, slice "a kill during a protected tool the model calls". The G04 path (`g04-kill.ts`) runs its protected effect from the worker's own code;
// here the effect is started by a tool the Pi model calls, through the production route a tool bridge write takes (card L05d): the call is recorded
// in a generation, the generation is completed, the call is admitted as an effect of its generation (`GenerationService.admitCall`, with the bridge's
// own command ID `bridgeCommandId("bridge", attempt, call)`) and run through the effect ledger (`executeCall`). The controller and the Pi adapter
// die together by a real SIGKILL at each boundary of that route, and a new process finishes the path. Glue only: every answer comes from the
// services, the database, the adapter's durable storage and the target's log.

/** The principal the controller's tool bridge acts as (the dispatcher's service principal); `admitCall` and `executeCall` are allowed to it and the owner only. */
export const DISPATCHER: Principal = { id: DISPATCHER_PRINCIPAL, kind: "service", name: "dispatcher", grants: [] };

/** What the tool and the model answer. */
export const PUSHED = "pushed: confirmed";
export const DONE_TEXT = "The seed order is pushed.";
export const NOT_DONE_TEXT = "The push did not finish; I am not repeating it on my own.";

const executedLog = (dir: string): string => join(dir, "executed.log");
const outsideLog = (dir: string): string => join(dir, "outside.log");

/**
 * The outside target, the same as the S09 slice's (`executed.log` counts every arrival, `outside.log` holds each applied key once): it honours the key and
 * can be asked whether a key was applied. Its two steps are boundaries. The production controller composes the reconciler with no bridges, so this
 * target is reached only by the tool's own call (and by the call's repetition, which Pi never makes for an interrupted call).
 */
export function pushTarget(world: SliceWorld): EffectBridge {
  return {
    idempotent: true,
    execute: async (request) => {
      world.chaos.hit("outside: before applying the effect");
      appendFileSync(executedLog(world.directory), `${request.key}\n`);
      if (!harness.outsideLines(world.directory).includes(request.key)) appendFileSync(outsideLog(world.directory), `${request.key}\n`);
      world.chaos.hit("outside: after applying the effect, before answering");
      return { receipt: `pushed ${request.key}` };
    },
    reconcile: async (request) => ({ state: harness.outsideLines(world.directory).includes(request.key) ? "applied" : "not_applied" }),
  };
}

/** The controller side the tool talks to, set once the process has started its services (the adapter, and so the tool, exists before them). */
export interface ToolController { gen: GenerationService; world: SliceWorld; taskId: string; fence: Fence }

/**
 * The `push` tool the model calls. Like the production bridge tools (`pi-adapter/src/bridge.ts`) it declares no `replay`, so Pi never runs an
 * interrupted call again; the model is told it was interrupted. Its body is the L05d route: begin, record the complete call, complete the
 * generation, admit the call as an effect and run it through the ledger. Every command ID is derived from the attempt and the call ID.
 * `replay: "safe"` (the second test) lets Pi run an interrupted call again after a restart, with the same call ID: what the route does when a call is
 * presented again.
 */
export function pushTool(controller: () => ToolController, replay?: "safe"): AdapterTool {
  return {
    name: "push", description: "Pushes the seed order to the supplier", parameters: Type.Object({ ref: Type.String() }),
    ...(replay === undefined ? {} : { replay }),
    execute: async (args, { callId }) => {
      const c = controller();
      c.world.chaos.hit("tool: called by the model");
      const begun = await c.gen.begin(DISPATCHER, { commandId: `g04t-begin:${callId}`, taskId: c.taskId, contextRevision: 1, fence: c.fence });
      await c.gen.record(DISPATCHER, { commandId: `g04t-rec:${callId}`, runId: begun.id, seq: 1, toolCall: { id: callId, name: "push", argumentsDelta: JSON.stringify(args), done: true } });
      await c.gen.complete(DISPATCHER, { commandId: `g04t-fin:${callId}`, runId: begun.id });
      const admitted = await c.gen.admitCall(DISPATCHER, { commandId: bridgeCommandId("bridge", c.fence.attemptId, callId), taskId: c.taskId, callId, target: "git.push" });
      const outcome = await c.gen.executeCall(DISPATCHER, { runId: admitted.runId, toolCallId: admitted.toolCallId }, pushTarget(c.world));
      c.world.chaos.hit("tool: outcome known, not yet returned to the model");
      return `pushed: ${outcome.status}`;
    },
  };
}

/** A scripted model that reads the conversation: with no tool result yet it calls `push` once; after a tool result it answers by what the result says. It never calls the tool a second time. */
export interface ToolModel { readonly calls: () => number }
export async function openToolAdapter(directory: string, controller: () => ToolController, replay?: "safe"): Promise<{ adapter: PiAdapter; model: ToolModel }> {
  const models = createModels();
  const faux = fauxProvider({ provider: "offline", models: [{ id: "scripted" }] });
  models.setProvider(faux.provider);
  const reply = (context: { messages: readonly unknown[] }) => {
    const results = (context.messages as { role: string; content: unknown }[]).filter((m) => m.role === "toolResult");
    if (results.length === 0) return fauxAssistantMessage(fauxToolCall("push", { ref: "main" }, { id: "p1" }), { stopReason: "toolUse" });
    const text = JSON.stringify(results.at(-1)!.content);
    return fauxAssistantMessage(text.includes(PUSHED) ? DONE_TEXT : NOT_DONE_TEXT);
  };
  faux.setResponses(Array.from({ length: 8 }, () => reply));
  const adapter = await PiAdapter.open({ storage: await openNodeJsonlStorage(directory, BACKGROUND_CONTEXT), models, model: { provider: "offline", modelId: "scripted" }, tools: [pushTool(controller, replay)] });
  return { adapter, model: { calls: () => faux.state.callCount } };
}

async function settle(slice: Slice): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const r = await slice.reconciler.runPass();
    if (Object.values(r.delivered).reduce((a, b) => a + b, 0) + r.inboxAdmitted + r.effectsRun + r.eventsRepaired === 0) return;
  }
}

/**
 * The path with the protected effect inside the model's tool call: the S09 path's commands (the same command IDs), except that the worker does not
 * intend and run the effect itself; the model's `push` call does. Running it again after any death finishes it.
 */
export async function toolPath(slice: Slice, world: SliceWorld, bind: (c: ToolController) => void): Promise<{ text: string }> {
  const { projects, assign, artifacts, ids } = slice;
  const me = "owner-chat";
  await projects.createProject({ commandId: "slice-project", actor: me, name: "Garden", goal: "Plan the beds" });
  await projects.createTask({ commandId: "slice-task", actor: me, projectId: ids.project, title: "Order seeds", description: "from the supplier" });
  await projects.transitionTask({ commandId: "slice-ready", actor: me, taskId: ids.task, expectedRevision: 1, to: "ready" });
  await assign.assignTask({ commandId: "slice-assign", actor: me, taskId: ids.task, owner: harness.WORKER });
  await settle(slice);
  const fence: Fence = { generation: 1, attemptId: ids.attemptId };
  const w = "worker-1";
  await assign.transitionTask({ commandId: "slice-start", actor: w, taskId: ids.task, expectedRevision: 2, to: "in_progress", fence });
  const gen = GenerationService.withEpoch(world.chaos.wrap(world.storage), projects.epoch, { assignments: assign, effects: slice.effects }, { clock: world.clock, pause: async () => undefined });
  bind({ gen, world, taskId: ids.task, fence });
  // The worker's model step: the controller's inbox bridge submits the attempt's work once (and after a restart resumes the interrupted work through the adapter's reviewed recovery step).
  const run = await slice.bridge.run(ids.messageId);
  const published = await artifacts.publish({ commandId: "slice-artifact", actor: w, name: "order", projectId: ids.project, taskId: ids.task, files: [{ path: "order.txt", content: Buffer.from(run.text) }] });
  await slice.recovery.record({ commandId: "slice-recovery", actor: w, attemptId: ids.attemptId, taskId: ids.task, requestIds: [run.requestId], artifactId: published.id, ...(run.checkpoint === undefined ? {} : { checkpoint: run.checkpoint }), resultText: run.text });
  await assign.transitionTask({ commandId: "slice-done", actor: w, taskId: ids.task, expectedRevision: 3, to: "done", fence });
  await assign.finishAttempt({ commandId: "slice-finish", actor: w, taskId: ids.task, expectedRevision: 2, fence, outcome: "succeeded", summary: "ordered" });
  await settle(slice);
  return { text: run.text };
}

/** The finished state of one run, as the database, the target and the conversation report it. */
export interface ToolState {
  /** Raw arrivals at the target, and keys it applied. */
  readonly executed: number; readonly applied: number;
  /** Effects in the ledger with their status and whether they started. */
  readonly effects: readonly { readonly id: string; readonly status: string; readonly started: boolean }[];
  /** The tool call's state in its generation, if it was recorded. */
  readonly call: string | undefined;
  /** What the model said at the end, and what the attempt's recovery point holds. */
  readonly text: string; readonly resultText: string | undefined;
  readonly taskState: string | undefined; readonly attemptState: string | undefined;
  /** The task as user messages in the transcript, and the model's final answers there. */
  readonly inputs: number; readonly answers: number;
  readonly blockers: readonly string[];
}

export async function toolState(slice: Slice, world: SliceWorld, adapter: PiAdapter, text: string): Promise<ToolState> {
  const effects: { id: string; status: string; started: boolean }[] = [];
  for (const a of await world.storage.listAggregates("effect", { limit: 100 })) {
    const record = await world.storage.getEffect(a.id);
    effects.push({ id: a.id, status: record?.status ?? "missing", started: (a.body as { started?: boolean }).started === true });
  }
  const runs = await world.storage.listAggregates("generation-run", { limit: 100 });
  const calls = runs.flatMap((r) => ((r.body as { toolCalls?: { id: string; state: string }[] }).toolCalls ?? []).filter((c) => c.id === "p1").map((c) => c.state));
  const transcript = await adapter.root().transcript();
  return {
    executed: harness.executedLines(world.directory).length, applied: harness.outsideLines(world.directory).length, effects, call: calls[0],
    text, resultText: (await slice.recovery.forAttempt(slice.ids.attemptId))?.resultText,
    taskState: (await slice.projects.getTask(slice.ids.task))?.state, attemptState: (await slice.assign.getAttempt(slice.ids.attemptId))?.state,
    inputs: transcript.filter((e) => e.role === "user" && e.text.includes("Order seeds")).length,
    answers: transcript.filter((e) => e.text === DONE_TEXT || e.text === NOT_DONE_TEXT).length,
    blockers: (await slice.blockers.list({ limit: 10, openOnly: true })).items.map((b) => b.type),
  };
}

/**
 * What every run must satisfy, whatever boundary it died at: the protected effect reached the outside world at most once and at most one effect
 * exists; the model was never told "pushed" unless the target applied it; the path finished (task done, attempt succeeded, one task message and one
 * final answer in the transcript, the answer kept in the recovery point); and an effect that is settled agrees with the outside world.
 */
export function toolInvariants(s: ToolState): string[] {
  const problems: string[] = [];
  const expect = (ok: boolean, what: string) => { if (!ok) problems.push(what); };
  expect(s.executed <= 1, `the target was reached ${s.executed} times`);
  expect(s.applied <= 1, `the outside world holds ${s.applied} pushes`);
  expect(s.effects.length <= 1, `${s.effects.length} effects in the ledger`);
  expect(s.text !== DONE_TEXT || s.applied === 1, "the model was told the push happened but the outside world does not hold it");
  for (const e of s.effects) {
    if (e.status === "confirmed") expect(s.applied === 1, `effect ${e.id} is confirmed but nothing was applied`);
    if (e.status === "failed") expect(s.applied === 0, `effect ${e.id} failed but the push was applied`);
    if (e.status === "intended" && !e.started) expect(s.applied === 0, `effect ${e.id} never started but the push was applied`);
  }
  expect(s.taskState === "done" && s.attemptState === "succeeded", `task ${s.taskState}, attempt ${s.attemptState}`);
  expect(s.inputs === 1, `the task is ${s.inputs} user message(s) in the transcript`);
  expect(s.answers === 1, `the transcript holds ${s.answers} final answer(s)`);
  expect(s.resultText === s.text, "the recovery point does not hold the model's final answer");
  return problems;
}

/**
 * How a run ended, in words, for the evidence: the clean outcome; the call cut before any effect existed or before it started (nothing pushed, the
 * model told it did not finish); pushed but the model told it did not finish; or an effect that started and that nothing settles afterwards.
 */
export function outcomeOf(s: ToolState): string {
  const e = s.effects[0];
  if (s.text === DONE_TEXT && e?.status === "confirmed") return "pushed once, model told";
  if (e === undefined) return "cut before the call was admitted: nothing pushed, model told it did not finish";
  if (e.status === "intended" && !e.started) return "admitted, never started: nothing pushed, the intent stays open, model told it did not finish";
  if (e.status === "intended" && e.started) return `started, never settled (${s.applied === 1 ? "pushed" : "not pushed"}): no blocker, model told it did not finish`;
  if (e.status === "confirmed") return "pushed once and confirmed, but the model was told it did not finish";
  return `effect ${e.status}, ${s.applied} pushed`;
}

/** The uncrashed run: its boundaries with the operation behind each, and its finished state. The holder is "child", as in the killed process. */
export async function cleanToolRun(spec: StoreSpec, directory: string, replay?: "safe"): Promise<Clean & { state: ToolState }> {
  const storage = await openStore(spec);
  let controller: ToolController | undefined;
  const { adapter } = await openToolAdapter(join(directory, "pi"), () => controller!, replay);
  try {
    const spy = new OperationSpy();
    const chaos = new Chaos();
    const world: SliceWorld = { storage: spy.wrap(storage), directory, chaos, clock: new Clock().now, conversation: () => piConversation(adapter) };
    const slice = await harness.startProcess(world, "child");
    const { text } = await toolPath(slice, world, (c) => { controller = c; });
    const state = await toolState(slice, world, adapter, text);
    const problems = toolInvariants(state);
    if (state.applied !== 1 || state.text !== DONE_TEXT) problems.push(`the uncrashed run did not push once and say so: ${JSON.stringify(state)}`);
    if (problems.length > 0) throw new Error(`the uncrashed run is wrong: ${problems.join("; ")}`);
    return { labels: [...chaos.labels], operations: await operationsOf(storage, spy, chaos.labels), signature: "", state };
  } finally { await adapter.close(); await storage.close(); }
}

/** The run in the child process for `g04-child.ts` (scenario `tool`). */
export async function childToolRun(storage: ControllerStorage, directory: string, chaos: InstanceType<typeof Chaos>, replay?: "safe"): Promise<{ close(): Promise<void> }> {
  let controller: ToolController | undefined;
  const { adapter } = await openToolAdapter(join(directory, "pi"), () => controller!, replay);
  const world: SliceWorld = { storage, directory, chaos, clock: new Clock().now, conversation: () => piConversation(adapter) };
  const slice = await harness.startProcess(world, "child");
  await toolPath(slice, world, (c) => { controller = c; });
  return { close: () => adapter.close() };
}

export interface ToolKilled { readonly index: number; readonly label: string; readonly problems: string[]; readonly outcome: string; readonly modelCalls: number }

/** Kills a child at `crashAt`, reads the database with no command run, restarts the whole path in this process and checks the invariants. */
export async function killToolAndRestart(spec: StoreSpec, directory: string, clean: Clean, crashAt: number, replay?: "safe"): Promise<ToolKilled> {
  const label = describe(clean, crashAt);
  const child = await runChild(spec, directory, crashAt, replay === undefined ? "tool" : "tool-replay");
  if (!child.killed || child.out.includes("finished")) return { index: crashAt, label, problems: [`${label}: the child was not killed (${child.err.slice(0, 300)})`], outcome: "not killed", modelCalls: 0 };
  const storage = await openStore(spec);
  let controller: ToolController | undefined;
  const { adapter, model } = await openToolAdapter(join(directory, "pi"), () => controller!, replay);
  try {
    const problems = (await acknowledgedSurvive(storage, clean, crashAt)).map((p) => `${label}: ${p}`);
    const clock = new Clock();
    clock.advance(10 * 60_000);
    const world: SliceWorld = { storage, directory, chaos: new Chaos(), clock: clock.now, conversation: () => piConversation(adapter) };
    const slice = await harness.startProcess(world, "restarted");
    const { text } = await toolPath(slice, world, (c) => { controller = c; });
    const state = await toolState(slice, world, adapter, text);
    problems.push(...toolInvariants(state).map((p) => `${label}: ${p}`));
    return { index: crashAt, label, problems, outcome: outcomeOf(state), modelCalls: model.calls() };
  } finally { await adapter.close(); await storage.close(); }
}

/** The boundaries of the tool's route: from the model's call to the tool's answer (the generation, the admission, the ledger and the target). */
export function toolBoundaries(clean: Clean): number[] {
  const first = clean.labels.indexOf("tool: called by the model");
  const last = clean.labels.indexOf("tool: outcome known, not yet returned to the model");
  if (first < 0 || last < first) throw new Error("the uncrashed run has no tool boundaries");
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

export type { JsonObject };
