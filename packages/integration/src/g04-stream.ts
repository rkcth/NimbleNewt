import { createHash } from "node:crypto";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import {
  GenerationRefused, ModelRelay, streamTapFor,
  type ControllerStorage, type ModelStreamCall, type ModelStreamTap,
} from "@nimblenewt/controller";
import { BRIDGE_REPLAY, PiAdapter, type AdapterTool } from "@nimblenewt/pi-adapter";
import { piConversation } from "./conversation.js";
import { Chaos, Clock, OperationSpy, acknowledgedSurvive, describe, killProblem, openStore, operationsOf, runChild, startProcess, type Clean, type Slice, type SliceWorld, type StoreSpec } from "./g04-fixture.js";
import { DISPATCHER, DONE_TEXT, NOT_DONE_TEXT, PUSHED, TOOL_EFFECT_LEASE_MS, pushTarget, toolInvariants, toolPath, toolState, type ToolController, type ToolState } from "./g04-tool.js";
import { relayedModels, viaRelay } from "./g09-radiance-run.js";

// Card G04, slice 6: a kill inside the model stream, before the tool runs (Pi's side). The G04 tool slice (`g04-tool.ts`) begins, records and completes the
// generation inside the tool, so 7 of its 16 boundaries only stand for the stream. Here the generation comes from where production takes it: the model's reply
// goes through the production model relay (`ModelRelay`, card H12b) with the production stream tap (`streamTapFor`, card L05b), which begins the generation
// when the call is sent, records the reply's pieces (the tool call before Pi may see it) and completes it when the reply ends. The model is a scripted
// OpenAI-style server behind the relay's fetch (no network). The `push` tool then does only what the production tool bridge does (`ToolExecutionService`,
// card L05d): admit the recorded call as an effect of its generation and run it through the effect ledger. The controller, the relay and the Pi adapter die
// together by a real SIGKILL at every boundary from the first model call to the tool's answer, and a new process finishes the path. Glue only.

/** The model as the relay's upstream: an OpenAI-style chat completions server that streams. With no tool result yet it calls `push` once (ID `p1`); after a tool result it answers by what the result says. */
export interface ScriptedModel { readonly fetch: typeof globalThis.fetch; readonly calls: () => number }
export function scriptedModel(): ScriptedModel {
  let calls = 0;
  const sse = (delta: object, finish: string | null): string => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "scripted", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const fetch = (async (_url: unknown, init?: RequestInit): Promise<Response> => {
    calls++;
    const body = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) as { messages: { role: string; content: unknown }[] };
    const results = body.messages.filter((m) => m.role === "tool");
    // Three pieces, each its own chunk of the body, so the relay hands the tap the reply's start, the complete tool call (or the text) and the end separately.
    const pieces = results.length === 0
      ? [sse({ role: "assistant", content: "" }, null), sse({ tool_calls: [{ index: 0, id: "p1", type: "function", function: { name: "push", arguments: JSON.stringify({ ref: "main" }) } }] }, null), `${sse({}, "tool_calls")}data: [DONE]\n\n`]
      : [sse({ role: "assistant", content: "" }, null), sse({ content: JSON.stringify(results.at(-1)!.content).includes(PUSHED) ? DONE_TEXT : NOT_DONE_TEXT }, null), `${sse({}, "stop")}data: [DONE]\n\n`];
    const bytes = pieces.map((p) => new TextEncoder().encode(p));
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { const next = bytes.shift(); if (next === undefined) controller.close(); else controller.enqueue(next); } });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof globalThis.fetch;
  return { fetch, calls: () => calls };
}

/**
 * Which of two orders the end of a reply takes, both possible in production (the run fixes one, so its boundaries are the same every time):
 * - `recorded first`: the controller completes the generation before Pi has stored the reply and runs its tool (the stream's end reached the store first);
 * - `read first`: Pi stores the whole reply and calls its tool before the controller completes the generation. This is the production relay's own order (`relay.ts`: the last piece is passed on, then the reply is completed;
 *   Pi's SDK stops reading at `[DONE]`), and the tool bridge waits for the completion (`ToolExecutionService#admitted`, up to 3 s).
 */
export type EndOrder = "recorded first" | "read first";

/** The controller side the tool and the tap talk to. `replyEnded`: resolves once every reply this process is reading has been recorded to its end (the tap's `ended` returned). `toolCalled`: the tool tells the tap it was called. */
export interface StreamController extends ToolController { readonly replyEnded: () => Promise<void>; readonly toolCalled: () => void; readonly order: EndOrder }

/**
 * The `push` tool as the production tool bridge runs it (L05d, `ToolExecutionService#generationCheck` and `#admitted`): the call is checked against its generation, admitted as an effect of the generation the stream recorded
 * with the bridge's own admission command ID (`bridgeAdmitId`), and run through the ledger. Left out: the bridge's name and arguments check (the scripted model writes one call), its busy wait and its mapping of a failed outcome.
 * The bridge waits briefly (up to 3 s) for a generation that is still streaming, because the reply ends a moment after the worker has read it whole; here the tool waits for the tap's end of the reply this process is reading
 * (an event, no fixed pause), so the order of boundaries is the same in every run. A refusal is answered as the bridge answers it ("it was not run"); with no reply being read (a call presented again after a restart) a
 * generation that is still streaming is refused at once, where the bridge would refuse it after its 3 s.
 */
/** The command ID the production bridge admits a call with (`ToolExecutionService#admitted`: `ba-` and a digest of the attempt and the call ID). */
export function bridgeAdmitId(attemptId: string, callId: string): string {
  return `ba-${createHash("sha256").update(`${attemptId}\0${callId}`).digest("hex").slice(0, 40)}`;
}

export function streamPushTool(controller: () => StreamController): AdapterTool {
  return {
    name: "push", description: "Pushes the seed order to the supplier", parameters: Type.Object({ ref: Type.String() }), replay: BRIDGE_REPLAY,
    execute: async (_args, { callId }) => {
      const c = controller();
      if (c.order === "recorded first") await c.replyEnded();
      c.world.chaos.hit("tool: called by the model");
      // Read first: the reply's completion waits for this call (Pi has stored the reply), and the call waits for the completion, as the bridge does.
      if (c.order === "read first") { c.toolCalled(); await c.replyEnded(); }
      // The bridge's check comes first (`#generationCheck`): a call of a generation that was interrupted, superseded or held is refused before the admission. A call that no generation holds the production bridge would run
      // directly, outside the ledger (a local worker with recording on): the copy does not refuse it quietly but fails the run, so the sweep cannot pass on a path the bridge does not take.
      const verdict = await c.gen.checkCall(DISPATCHER, { taskId: c.taskId, callId });
      if (!verdict.recorded) throw new Error(`call ${callId} belongs to no recorded generation: the production bridge would run it outside the ledger`);
      if (!verdict.ok) return `generation_refused: ${verdict.reason ?? "not a current generation"}; it was not run`;
      let outcome: Awaited<ReturnType<typeof c.gen.executeCall>>;
      try {
        const admitted = await c.gen.admitCall(DISPATCHER, { commandId: bridgeAdmitId(c.fence.attemptId, callId), taskId: c.taskId, callId, target: "git.push" });
        outcome = await c.gen.executeCall(DISPATCHER, { runId: admitted.runId, toolCallId: admitted.toolCallId }, pushTarget(c.world));
      } catch (error) {
        if (error instanceof GenerationRefused) return `generation_refused: ${error.reason}; it was not run`;
        throw error;
      }
      c.world.chaos.hit("tool: outcome known, not yet returned to the model");
      return `pushed: ${outcome.status}`;
    },
  };
}

/**
 * The real Pi adapter whose model calls go through the production relay and stream tap to the scripted model. The tap is made at the first call (the attempt exists only once the path has started), once per process:
 * its command IDs carry `nonce` (the production tap's distinction between processes), the holder name, so the uncrashed run and the killed child make the same operations. Settings: recorded, cut, closed, every piece written
 * at once (the batching is time-based otherwise, and a timer would make the boundaries depend on the clock).
 */
export interface StreamAdapter { readonly adapter: PiAdapter; readonly model: ScriptedModel; readonly bind: (c: ToolController) => StreamController }
export async function openStreamAdapter(directory: string, nonce: string, order: EndOrder): Promise<StreamAdapter> {
  const model = scriptedModel();
  let inner: ModelStreamTap | undefined;
  let bound: StreamController | undefined;
  const controller = (): StreamController | undefined => bound;
  const reading = new Set<Promise<void>>();
  // Read first: the completion of a reply that carries a finished tool call waits until the tool was called (Pi stored the reply before it runs a tool).
  let called: (() => void) | undefined;
  const tap: ModelStreamTap = {
    async started(call) {
      const c = controller();
      if (c === undefined) throw new Error("the model was called before the path bound the controller");
      inner ??= streamTapFor({ generation: c.gen, principal: DISPATCHER, nonce: () => nonce, settings: async () => ({ record: true, cut: true, failClosed: true, batchMs: 0, batchChars: 0 }) }, { attemptId: c.fence.attemptId, taskId: c.taskId, generation: c.fence.generation });
      const recorded = await inner.started(call);
      if (recorded === undefined) return undefined;
      let done!: () => void;
      const end = new Promise<void>((resolve) => { done = resolve; });
      reading.add(end);
      let carriesCall = false;
      const toolCalled = new Promise<void>((resolve) => { called = resolve; });
      const wrapped: ModelStreamCall = {
        ...recorded,
        events: (e) => { if (e.some((x) => x.kind === "tool" && x.done)) carriesCall = true; return recorded.events(e); },
        ended: async (outcome) => {
          try {
            if (order === "read first" && carriesCall && outcome.ok) await toolCalled;
            await recorded.ended(outcome);
          } finally { reading.delete(end); done(); }
        },
      };
      Object.defineProperty(wrapped, "onWait", { get: () => recorded.onWait, set: (v) => { recorded.onWait = v; } });
      return wrapped;
    },
  };
  const relay = new ModelRelay({ fetch: model.fetch, endpoint: () => ({ url: "http://model.invalid/v1" }) }).forAttempt({ route: "offline/scripted", model: "scripted", stream: tap });
  const fetch = viaRelay(relay);
  const adapter = await PiAdapter.open({
    storage: await openNodeJsonlStorage(directory, BACKGROUND_CONTEXT), models: await relayedModels("offline", "scripted", relay.alias), model: { provider: "offline", modelId: "scripted" },
    tools: [streamPushTool(() => { const c = controller(); if (c === undefined) throw new Error("the tool was called before the path bound the controller"); return c; })], cache: { policy: () => ({ fetch: () => fetch }) },
  });
  const replyEnded = async (): Promise<void> => { await Promise.all([...reading]); };
  return { adapter, model, bind: (c) => (bound = { ...c, replyEnded, toolCalled: () => called?.(), order }) };
}

/** A generation of the task as stored: its number, state and the state of the model's call `p1` in it (if it holds it). */
export interface StreamRun { readonly number: number; readonly state: string; readonly p1: string | undefined }
export interface StreamState extends ToolState { readonly runs: readonly StreamRun[]; readonly modelCalls: number }

export async function streamState(slice: Slice, world: SliceWorld, adapter: PiAdapter, text: string, modelCalls: number): Promise<StreamState> {
  const base = await toolState(slice, world, adapter, text);
  const runs = (await world.storage.listAggregates("generation-run", { limit: 100 })).map((r) => {
    const b = r.body as { number: number; state: string; toolCalls?: { id: string; state: string }[] };
    return { number: b.number, state: b.state, p1: b.toolCalls?.find((c) => c.id === "p1")?.state };
  }).sort((a, b) => a.number - b.number);
  // The tool slice reads the call in the first generation; here a call cut by a kill may be recorded in a generation that a later reply superseded, so the call that counts is the admitted one, wherever it is.
  const admitted = runs.filter((r) => r.p1 === "admitted");
  return { ...base, call: admitted.length > 0 ? "admitted" : runs.find((r) => r.p1 !== undefined)?.p1, runs, modelCalls };
}

/** The tool slice's invariants, and the stream's own: the call is admitted in at most one generation, and no generation is left streaming once the path has finished (nothing would ever complete it). */
export function streamInvariants(s: StreamState): string[] {
  const problems = toolInvariants(s);
  const admitted = s.runs.filter((r) => r.p1 === "admitted").length;
  if (admitted > 1) problems.push(`the call is admitted in ${admitted} generations`);
  for (const r of s.runs) if (r.state === "streaming") problems.push(`generation ${r.number} is left streaming`);
  // Each new reply supersedes the one before (card L05b): every generation but the last is interrupted and the last (the answer) finished, and a superseded generation holds no call that could still be admitted (a
  // complete, partial or held call there is withdrawn or dropped by the supersession, unless it was admitted before).
  s.runs.forEach((r, i) => {
    const last = i === s.runs.length - 1;
    if (r.state !== (last ? "finished" : "interrupted")) problems.push(`generation ${r.number} is ${r.state}, expected ${last ? "finished (the answer)" : "interrupted (superseded)"}`);
    if (!last && (r.p1 === "complete" || r.p1 === "partial" || r.p1 === "held")) problems.push(`superseded generation ${r.number} still holds the call as ${r.p1}`);
  });
  return problems;
}

/** How a run ended, in words, for the evidence: the tool slice's words, and the generations (state, and the call's state where it is recorded). */
export function streamOutcome(s: StreamState): string {
  const pushed = s.applied === 0 ? "nothing pushed" : `${s.applied} pushed`;
  const told = s.text === DONE_TEXT ? "model told it was pushed" : s.text === NOT_DONE_TEXT ? "model told it did not finish" : `model said ${JSON.stringify(s.text)}`;
  const e = s.effects[0];
  const effect = e === undefined ? "no effect" : `effect ${e.status}${e.reported ? " (owner told)" : ""}`;
  const runs = s.runs.map((r) => `${r.number} ${r.state}${r.p1 === undefined ? "" : ` (p1 ${r.p1})`}`).join(", ");
  return `${pushed}, ${effect}, ${told}; generations: ${runs}`;
}

/** The outcome of the uncrashed run: the reply with the call is superseded by the answer's generation (card L05b: a new reply begins a new generation), its call admitted; the answer's generation finished. */
export const CLEAN_OUTCOME = "1 pushed, effect confirmed, model told it was pushed; generations: 1 interrupted (p1 admitted), 2 finished";
/** The result part of an outcome (before the generations), and the uncrashed run's: every kill must end with it. */
export const resultOf = (outcome: string): string => outcome.split(";")[0]!;
export const CLEAN_RESULT = resultOf(CLEAN_OUTCOME);

export async function cleanStreamRun(spec: StoreSpec, directory: string, order: EndOrder): Promise<Clean & { state: StreamState }> {
  const storage = await openStore(spec);
  const { adapter, model, bind } = await openStreamAdapter(join(directory, "pi"), "child", order);
  try {
    const spy = new OperationSpy();
    const chaos = new Chaos();
    const world: SliceWorld = { storage: spy.wrap(storage), directory, chaos, clock: new Clock().now, conversation: () => piConversation(adapter), effectLeaseMs: TOOL_EFFECT_LEASE_MS };
    const slice = await startProcess(world, "child");
    const { text } = await toolPath(slice, world, bind);
    const state = await streamState(slice, world, adapter, text, model.calls());
    const problems = streamInvariants(state);
    if (streamOutcome(state) !== CLEAN_OUTCOME || model.calls() !== 2) problems.push(`the uncrashed run is not the expected one: ${streamOutcome(state)}, ${model.calls()} model call(s)`);
    if (problems.length > 0) throw new Error(`the uncrashed run is wrong: ${problems.join("; ")}`);
    return { labels: [...chaos.labels], operations: await operationsOf(storage, spy, chaos.labels), signature: "", state };
  } finally { await adapter.close(); await storage.close(); }
}

/** The run in the child process for `g04-child.ts` (scenarios `stream` and `stream-read-first`). */
export async function childStreamRun(storage: ControllerStorage, directory: string, chaos: InstanceType<typeof Chaos>, order: EndOrder): Promise<{ close(): Promise<void> }> {
  const { adapter, bind } = await openStreamAdapter(join(directory, "pi"), "child", order);
  const world: SliceWorld = { storage, directory, chaos, clock: new Clock().now, conversation: () => piConversation(adapter), effectLeaseMs: TOOL_EFFECT_LEASE_MS };
  const slice = await startProcess(world, "child");
  await toolPath(slice, world, bind);
  return { close: () => adapter.close() };
}

export interface StreamKilled { readonly index: number; readonly label: string; readonly problems: string[]; readonly outcome: string; readonly modelCalls: number }

/** Kills a child at `crashAt`, reads the database with no command run, restarts the whole path in this process (the tap's nonce is the new holder's) and checks the invariants. */
export async function killStreamAndRestart(spec: StoreSpec, directory: string, clean: Clean, crashAt: number, order: EndOrder): Promise<StreamKilled> {
  const label = describe(clean, crashAt);
  const child = await runChild(spec, directory, crashAt, order === "read first" ? "stream-read-first" : "stream");
  const notKilled = killProblem(child, clean.labels, crashAt, label);
  if (notKilled !== undefined) return { index: crashAt, label, problems: [notKilled], outcome: child.hung ? "hung" : "not killed there", modelCalls: 0 };
  const storage = await openStore(spec);
  const { adapter, model, bind } = await openStreamAdapter(join(directory, "pi"), "restarted", order);
  try {
    const problems = (await acknowledgedSurvive(storage, clean, crashAt)).map((p) => `${label}: ${p}`);
    const clock = new Clock();
    clock.advance(10 * 60_000);
    const world: SliceWorld = { storage, directory, chaos: new Chaos(), clock: clock.now, conversation: () => piConversation(adapter), effectLeaseMs: TOOL_EFFECT_LEASE_MS };
    const slice = await startProcess(world, "restarted");
    const { text } = await toolPath(slice, world, bind);
    const state = await streamState(slice, world, adapter, text, model.calls());
    problems.push(...streamInvariants(state).map((p) => `${label}: ${p}`));
    return { index: crashAt, label, problems, outcome: streamOutcome(state), modelCalls: model.calls() };
  } finally { await adapter.close(); await storage.close(); }
}

/** The boundaries swept: from the first model call's generation (its begin) to the tool's answer, the whole of Pi's side before the tool runs and the tool's own route. */
export function streamBoundaries(clean: Clean): number[] {
  const first = clean.operations.find((o) => o.type === "generation.begin")?.before;
  const last = clean.labels.indexOf("tool: outcome known, not yet returned to the model");
  if (first === undefined || last < first) throw new Error("the uncrashed run has no stream boundaries before the tool's answer");
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}
