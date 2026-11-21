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
import { BRIDGE_REPLAY, PiAdapter, type AdapterTool } from "@nimblenewt/pi-adapter";
import { piConversation } from "./conversation.js";
import { Chaos, Clock, OperationSpy, acknowledgedSurvive, describe, killProblem, openStore, operationsOf, runChild, type Clean, type Slice, type SliceWorld, type StoreSpec } from "./g04-fixture.js";

// Card G04, slice "a kill during a protected tool the model calls". The G04 path (`g04-kill.ts`) runs its protected effect from the worker's own code;
// here the effect is started by a tool the Pi model calls, through the production route a tool bridge write takes (card L05d): the call is recorded
// in a generation, the generation is completed, the call is admitted as an effect of its generation (`GenerationService.admitCall`, with a command ID
// derived from the attempt and the call, `bridgeCommandId("bridge", attempt, call)`; the bridge's own admission ID is `ba-` and a digest of the same two, used by
// `g04-stream.ts`) and run through the effect ledger (`executeCall`). The controller and the Pi adapter
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
 * What the production bridge tools declare to Pi about an interrupted call (G04 follow-up: `"safe"`, present it again under its own call ID). The `push` tool here takes it from the bridge itself, so the test follows
 * the production setting; `undefined` is the setting of a call that is not presented again (every bridge tool before the follow-up, or a conversation whose interrupted work was abandoned).
 */
export const PRODUCTION_REPLAY: "safe" | undefined = BRIDGE_REPLAY;

/**
 * The outside target, the same as the S09 slice's (`executed.log` counts every arrival, `outside.log` holds each applied key once): it honours the key and
 * can be asked whether a key was applied. Its two steps are boundaries. The production controller composes the reconciler with no bridges, so this
 * target is reached only by the tool's own call (and by the same call presented again after a restart).
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

/**
 * The effect claim lease of every process here: an hour, longer than the restart's clock advance (10 minutes), so a claim the killed process held is still unexpired when the new process meets it. Only the primary epoch frees it
 * (G04 follow-up: a claim of an older epoch is given up at once); with the slice's default lease of 1 ms that rule would never be exercised by the kill sweep.
 */
export const TOOL_EFFECT_LEASE_MS = 60 * 60_000;

/** The controller side the tool talks to, set once the process has started its services (the adapter, and so the tool, exists before them). */
export interface ToolController { gen: GenerationService; world: SliceWorld; taskId: string; fence: Fence }

/**
 * The `push` tool the model calls. Its body is the L05d route: begin, record the complete call, complete the generation, admit the call as an effect and run it through the ledger. Every command ID is derived from the
 * attempt and the call ID. `replay: "safe"` (the production bridge tools' setting, `PRODUCTION_REPLAY`) lets Pi present an interrupted call again after a restart, with the same call ID; with no `replay` Pi tells the model
 * the call was interrupted and never presents it again.
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
  /** Effects in the ledger with their status, whether they started and whether an open `effect_uncertain` blocker tells the owner about them. */
  readonly effects: readonly { readonly id: string; readonly status: string; readonly started: boolean; readonly reported: boolean }[];
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
  const effects: { id: string; status: string; started: boolean; reported: boolean }[] = [];
  for (const a of await world.storage.listAggregates("effect", { limit: 100 })) {
    const record = await world.storage.getEffect(a.id);
    const reported = (await slice.blockers.openFor("effect_uncertain", { kind: "effect", id: a.id })) !== undefined;
    effects.push({ id: a.id, status: record?.status ?? "missing", started: (a.body as { started?: boolean }).started === true, reported });
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
 * G04 follow-up guarantees: no effect is left open (`intended`) once the path has finished, and an effect that may or may not have happened (`uncertain`) is shown to the owner by an open blocker.
 */
export function toolInvariants(s: ToolState): string[] {
  const problems: string[] = [];
  const expect = (ok: boolean, what: string) => { if (!ok) problems.push(what); };
  expect(s.executed <= 1, `the target was reached ${s.executed} times`);
  expect(s.applied <= 1, `the outside world holds ${s.applied} pushes`);
  expect(s.effects.length <= 1, `${s.effects.length} effects in the ledger`);
  expect(s.text !== DONE_TEXT || s.applied === 1, "the model was told the push happened but the outside world does not hold it");
  expect(s.text !== DONE_TEXT || s.effects[0]?.status === "confirmed", "the model was told the push happened but the ledger does not hold it as confirmed");
  expect(s.effects.length > 0 || s.executed === 0, "the target was reached with no effect in the ledger");
  // The admission records the call as admitted and creates its effect in one commit: a call's state and the ledger agree.
  expect((s.effects.length === 1) === (s.call === "admitted"), `the call is ${s.call ?? "not recorded"} while the ledger holds ${s.effects.length} effect(s)`);
  for (const e of s.effects) {
    if (e.status === "confirmed") expect(s.applied === 1, `effect ${e.id} is confirmed but nothing was applied`);
    if (e.status === "failed") expect(s.applied === 0, `effect ${e.id} failed but the push was applied`);
    expect(e.status !== "intended", `effect ${e.id} is left open (${e.started ? "started" : "never started"}): nothing settles or reports it`);
    if (e.status === "uncertain") expect(e.reported, `effect ${e.id} is uncertain and the owner is not told`);
    if (e.status === "failed") expect(!e.started, `effect ${e.id} started and was closed as failed: it may have happened`);
  }
  expect(s.taskState === "done" && s.attemptState === "succeeded", `task ${s.taskState}, attempt ${s.attemptState}`);
  expect(s.inputs === 1, `the task is ${s.inputs} user message(s) in the transcript`);
  expect(s.answers === 1, `the transcript holds ${s.answers} final answer(s)`);
  expect(s.resultText === s.text, "the recovery point does not hold the model's final answer");
  return problems;
}

/**
 * How a run ended, in words, for the evidence: the clean outcome (pushed once, confirmed, the model told); the call cut before any effect existed; an effect admitted but never started and closed as failed; one that
 * started, was never settled and was marked uncertain with the owner told; pushed and confirmed while the model was told it did not finish; or an effect left open (which the invariants refuse).
 */
export function outcomeOf(s: ToolState): string {
  // Every part of the sentence is read from the state (nothing is assumed from the branch), so a change in what is pushed, what the model is told
  // or which blockers are open changes the outcome and the per-boundary comparison notices it.
  const e = s.effects[0];
  const pushed = s.applied === 0 ? "nothing pushed" : `${s.applied} pushed`;
  const told = s.text === DONE_TEXT ? "model told it was pushed" : s.text === NOT_DONE_TEXT ? "model told it did not finish" : `model said ${JSON.stringify(s.text)}`;
  const blocked = s.blockers.length === 0 ? "no blocker" : `blockers ${[...s.blockers].sort().join(", ")}`;
  if (s.text === DONE_TEXT && e?.status === "confirmed" && s.applied === 1 && s.blockers.length === 0 && s.call === "admitted") return "pushed once, model told";
  if (e === undefined) return `cut before the call was admitted: ${pushed}, ${blocked}, ${told}`;
  if (e.status === "intended") return `left open (${e.started ? "started" : "never started"}): ${pushed}, ${blocked}, ${told}`;
  if (e.status === "failed" && !e.started) return `admitted, never started: closed as failed once the attempt ended, ${pushed}, ${blocked}, ${told}`;
  if (e.status === "uncertain") return `started, never settled: marked uncertain once the attempt ended, ${pushed}, ${e.reported ? "the owner told by its blocker" : "the owner NOT told"}, ${blocked}, ${told}`;
  if (e.status === "confirmed" && s.applied === 1) return `pushed once and confirmed, but the call was not presented again: ${blocked}, ${told}`;
  return `effect ${e.status}${e.started ? " (started)" : ""}, ${pushed}, ${blocked}, ${told}`;
}

/** The uncrashed run: its boundaries with the operation behind each, and its finished state. The holder is "child", as in the killed process. */
export async function cleanToolRun(spec: StoreSpec, directory: string, replay?: "safe"): Promise<Clean & { state: ToolState }> {
  const storage = await openStore(spec);
  let controller: ToolController | undefined;
  const { adapter } = await openToolAdapter(join(directory, "pi"), () => controller!, replay);
  try {
    const spy = new OperationSpy();
    const chaos = new Chaos();
    const world: SliceWorld = { storage: spy.wrap(storage), directory, chaos, clock: new Clock().now, conversation: () => piConversation(adapter), effectLeaseMs: TOOL_EFFECT_LEASE_MS };
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
  const world: SliceWorld = { storage, directory, chaos, clock: new Clock().now, conversation: () => piConversation(adapter), effectLeaseMs: TOOL_EFFECT_LEASE_MS };
  const slice = await harness.startProcess(world, "child");
  await toolPath(slice, world, (c) => { controller = c; });
  return { close: () => adapter.close() };
}

export interface ToolKilled { readonly index: number; readonly label: string; readonly problems: string[]; readonly outcome: string; readonly modelCalls: number }

/** Kills a child at `crashAt`, reads the database with no command run, restarts the whole path in this process and checks the invariants. */
export async function killToolAndRestart(spec: StoreSpec, directory: string, clean: Clean, crashAt: number, replay?: "safe"): Promise<ToolKilled> {
  const label = describe(clean, crashAt);
  const child = await runChild(spec, directory, crashAt, replay === undefined ? "tool" : "tool-replay");
  // The kill landed on the boundary the uncrashed run numbered, and the child did not hang (shared check, g04-fixture.ts).
  const notKilled = killProblem(child, clean.labels, crashAt, label);
  if (notKilled !== undefined) return { index: crashAt, label, problems: [notKilled], outcome: child.hung ? "hung" : child.killed && !child.out.includes("finished") ? "killed elsewhere" : "not killed", modelCalls: 0 };
  const storage = await openStore(spec);
  let controller: ToolController | undefined;
  const { adapter, model } = await openToolAdapter(join(directory, "pi"), () => controller!, replay);
  try {
    const problems = (await acknowledgedSurvive(storage, clean, crashAt)).map((p) => `${label}: ${p}`);
    const clock = new Clock();
    clock.advance(10 * 60_000);
    const world: SliceWorld = { storage, directory, chaos: new Chaos(), clock: clock.now, conversation: () => piConversation(adapter), effectLeaseMs: TOOL_EFFECT_LEASE_MS };
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
