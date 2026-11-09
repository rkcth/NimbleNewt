import assert from "node:assert/strict";
import { test } from "node:test";
import type { FirstCall } from "../context/dispatch.js";
import type { JsonObject } from "../storage/types.js";
import { LocalWorker, type AttemptRuntime, type RuntimeGuards } from "./local-worker.js";
import type { ToolGateway, WorkOrder } from "./ports.js";

// Card H12f: the local worker's guards, with the controller's services replaced by plain functions: the first call is admitted or refused, a stored conversation over the resume share is not resumed, a paused attempt is
// observed (pausing while a call is in flight, paused once it has settled) and messages reach only an attempt that is not paused.

const order = (extra: Partial<WorkOrder> = {}): WorkOrder => ({ attemptId: "att-1", taskId: "task-1", projectId: "proj-1", agentId: "agent:ann", generation: 1, route: "llama/local", credential: "c", recipe: { revision: "r1", reach: [] } as never, content: "do it", requestId: "req-1", expiresAt: "2030-01-01T00:00:00.000Z", ...extra });
const CALL: FirstCall = { systemPromptChars: 100, toolSchemaChars: 200, startupTokens: 50, replyReserveTokens: 100 };
const gateway = (calls: string[] = []): ToolGateway => ({ attemptId: "att-1", call: async (r: { callId: string }) => { calls.push(r.callId); return { state: "confirmed", operationId: "op", text: "ok" }; }, heartbeat: async () => ({ until: "x" }), usage: async () => undefined, acknowledgeDecisions: async () => undefined }) as unknown as ToolGateway;

interface Rig { local: LocalWorker; log: string[]; beats: (() => Promise<void>)[]; errors: string[] }
function rig(runtime: (log: string[], opened: { from: JsonObject | undefined }) => Partial<AttemptRuntime>, guards: RuntimeGuards): Rig & { opened: { from: JsonObject | undefined } } {
  const log: string[] = [];
  const beats: (() => Promise<void>)[] = [];
  const errors: string[] = [];
  const opened = { from: undefined as JsonObject | undefined };
  const local = new LocalWorker({
    hostId: "host:local", resources: { cpus: 1, memoryMb: 1 }, version: "v", capabilities: () => ({}) as never, guards,
    onGuardError: (_id, what, error) => { errors.push(`${what}: ${String((error as Error).message)}`); },
    schedule: (beat) => { beats.push(beat); return () => undefined; },
    sandbox: { open: async (r) => { log.push("sandbox open"); return { revision: r.revision, close: async () => { log.push("sandbox close"); } }; } },
    runtimes: { open: async (_o, _c, from) => { opened.from = from; log.push("runtime open"); return { run: async () => ({ status: "completed", text: "x" }), checkpoint: async () => ({}), close: async () => { log.push("runtime close"); }, ...runtime(log, opened) } as AttemptRuntime; } },
  });
  return { local, log, beats, errors, opened };
}

test("a first call over the context budget is not sent: the attempt ends failed with the reasons and everything is closed", async () => {
  let ran = false;
  const r = rig(() => ({ firstCall: () => CALL, run: async () => { ran = true; return { status: "completed" }; } }), { context: { admit: async () => ({ admit: false, reasons: ["startup is 40000 tokens, over 32768"] }), resume: async () => ({ resume: true, reason: "" }) } });
  const handle = await r.local.start(order());
  const result = await handle.run(gateway());
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /first call was not sent: startup is 40000 tokens/);
  assert.equal(ran, false);
  assert.deepEqual(r.log, ["sandbox open", "runtime open", "runtime close", "sandbox close"]);
});

test("a refused first call is made smaller once, if the runtime can, and asked again", async () => {
  let compacted = 0;
  const rounds: number[] = [];
  const r = rig(() => ({ firstCall: () => CALL, compact: async () => { compacted++; } }), { context: { admit: async (_o, _c, round) => { rounds.push(round); return { admit: round === 2, reasons: round === 2 ? [] : ["too big"] }; }, resume: async () => ({ resume: true, reason: "" }) } });
  const handle = await r.local.start(order());
  assert.equal((await handle.run(gateway())).status, "completed");
  assert.deepEqual(rounds, [1, 2]);
  assert.equal(compacted, 1);
});

test("a stored conversation over the resume share is not resumed: the runtime starts fresh and the agent is told why", async () => {
  const stored: JsonObject = { nn: { contextTokens: 30000 } };
  let content = "";
  const r = rig(() => ({ run: async (c: string) => { content = c; return { status: "completed" }; } }), { context: { storedTokens: (from) => (from["nn"] as { contextTokens: number }).contextTokens, admit: async () => ({ admit: true, reasons: [] }), resume: async (_o, tokens) => ({ resume: tokens < 20000, reason: `the stored conversation is ${tokens} tokens, over 20000; starting fresh` }) } });
  const handle = await r.local.start(order({ resumeFrom: stored }));
  await handle.run(gateway());
  assert.equal(r.opened.from, undefined, "the runtime did not get the checkpoint");
  assert.match(content, /starting fresh/);
  const small = rig(() => ({}), { context: { storedTokens: () => 100, admit: async () => ({ admit: true, reasons: [] }), resume: async () => ({ resume: true, reason: "fits" }) } });
  await small.local.start(order({ resumeFrom: stored }));
  assert.deepEqual(small.opened.from, stored, "a conversation that fits is resumed");
});

// Card C07n: the worker continues a stored conversation only when its size was judged. The checkpoint shape the worker package's host writes is read without an embedder-supplied
// reader, and a checkpoint that says nothing at all is left behind rather than carried in unchecked.
test("a checkpoint is judged whether or not the guard brings a reader: the worker package's shape is read, and one that says nothing is not resumed", async () => {
  const judged: number[] = [];
  const readers: RuntimeGuards["context"] = { admit: async () => ({ admit: true, reasons: [] }), resume: async (_o, tokens) => { judged.push(tokens); return { resume: tokens < 20_000, reason: `the stored conversation is ${tokens} tokens, over 20000; starting fresh` }; } };
  // Of the worker package's shape: 30,000 tokens, over the share, so it starts fresh and says why.
  let content = "";
  const big = rig(() => ({ run: async (c: string) => { content = c; return { status: "completed" }; } }), { context: readers });
  await (await big.local.start(order({ resumeFrom: { nn: { contextTokens: 30_000 } } }))).run(gateway());
  assert.deepEqual(judged, [30_000], "the size was read from the checkpoint's own shape");
  assert.equal(big.opened.from, undefined, "the runtime did not get the checkpoint");
  assert.match(content, /the stored conversation is 30000 tokens, over 20000; starting fresh\]$/, "the agent is told why it starts without its conversation");
  // One that says nothing: no size to judge, so nothing is continued, and it is said in the attempt's note and to the host.
  const quiet = rig(() => ({ run: async (c: string) => { content = c; return { status: "completed" }; } }), { context: readers });
  await (await quiet.local.start(order({ resumeFrom: { pi: { conversationId: 7 } } }))).run(gateway());
  assert.deepEqual(judged, [30_000], "there was no size to judge it against");
  assert.equal(quiet.opened.from, undefined, "a checkpoint of unknown size is not carried in");
  assert.match(content, /\[the size of the stored conversation is not known \(its checkpoint does not say\), so it was not resumed; starting fresh from the continuation record\]$/, content.slice(-200));
  assert.deepEqual(quiet.errors, ["resume decision: the checkpoint does not say how large the stored conversation is"], "the host is told its checkpoints say nothing");
  // A fitting conversation of the known shape is resumed as before; a worker with no context guard at all is untouched by any of this.
  const fits = rig(() => ({}), { context: readers });
  await (await fits.local.start(order({ resumeFrom: { nn: { contextTokens: 900 } } }))).run(gateway());
  assert.deepEqual(fits.opened.from, { nn: { contextTokens: 900 } }, "a conversation that fits is resumed");
  const unguarded = rig(() => ({}), {});
  await (await unguarded.local.start(order({ resumeFrom: { pi: { conversationId: 7 } } }))).run(gateway());
  assert.deepEqual(unguarded.opened.from, { pi: { conversationId: 7 } }, "a worker without the context guard resumes as it always did");
});

// Card C07n: a reader that answers nothing is not a pass. The worker package's own checkpoint shape is read after it, so a checkpoint that does carry a figure is still judged on it.
test("a reader that answers nothing falls back to the checkpoint's own shape: the conversation is judged, and one that says nothing is still not resumed", async () => {
  const judged: number[] = [];
  const readers: RuntimeGuards["context"] = { admit: async () => ({ admit: true, reasons: [] }), storedTokens: () => undefined, resume: async (_o, tokens) => { judged.push(tokens); return { resume: tokens < 20_000, reason: `the stored conversation is ${tokens} tokens, over 20000; starting fresh` }; } };
  let content = "";
  const known = rig(() => ({ run: async (c: string) => { content = c; return { status: "completed" }; } }), { context: readers });
  await (await known.local.start(order({ resumeFrom: { pi: { conversationId: 7 }, nn: { contextTokens: 30_000 } } }))).run(gateway());
  assert.deepEqual(judged, [30_000], "the reader answered nothing and the checkpoint's own figure was not read after it");
  assert.equal(known.opened.from, undefined, "a conversation over the resume share was carried in unchecked");
  assert.match(content, /the stored conversation is 30000 tokens, over 20000; starting fresh\]$/, content.slice(-200));
  assert.deepEqual(known.errors, [], JSON.stringify(known.errors));
  // A checkpoint that says nothing either: nothing is resumed, and the host is told.
  const quiet = rig(() => ({ run: async () => ({ status: "completed" }) }), { context: readers });
  await (await quiet.local.start(order({ resumeFrom: { pi: { conversationId: 7 } } }))).run(gateway());
  assert.deepEqual(judged, [30_000], "there was no figure to judge it against");
  assert.equal(quiet.opened.from, undefined, "a checkpoint of unknown size is not carried in");
  assert.deepEqual(quiet.errors, ["resume decision: the checkpoint does not say how large the stored conversation is"], JSON.stringify(quiet.errors));
});

test("card C07n: a refusal a smaller call cannot change is final at once (no compaction is spent on it)", async () => {
  let compacted = 0; const rounds: number[] = [];
  const r = rig(() => ({ firstCall: () => CALL, compact: async () => { compacted++; } }), { context: { admit: async (_o, _c, round) => { rounds.push(round); return { admit: false, retryable: false, reasons: ["route x/y has no context window the controller knows"] }; }, resume: async () => ({ resume: true, reason: "fits" }) } });
  const result = await (await r.local.start(order())).run(gateway());
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /no context window the controller knows/);
  assert.deepEqual(rounds, [1], "the call was asked about once");
  assert.equal(compacted, 0, "a compaction cannot make a window known");
});

// Card C07g: a view built for a route nobody had measured is built again with the fixed part the process reports, before anything is sent; the rebuilt view replaces the order's in the first prompt.
test("a view made on an unmeasured route is rebuilt with the process's own fixed part before the first call: the new view is what is admitted and sent, a refusal sends nothing, and a measured view or a failing rebuild keeps the order's", async () => {
  const VIEW = "\n\nOLD VIEW";
  const moved = order({ content: `do it${VIEW}`, startupView: { route: "llama/local", measured: false, chars: VIEW.length }, resumeNote: "carry on" });
  const run = (sizes: string[], sent: string[]) => (): Partial<AttemptRuntime> => ({ firstCall: (c: string) => { sizes.push(c); return CALL; }, run: async (c: string) => { sent.push(c); return { status: "completed" }; } });
  // Rebuilt: the measured figures go to the controller, the new view replaces the old one (the note still follows it), and the admission is of the prompt that is sent.
  const sizes: string[] = []; const sent: string[] = []; const asked: unknown[] = []; const admitted: number[] = [];
  const r = rig(run(sizes, sent), { context: { admit: async (_o, call) => { admitted.push(call.startupTokens); return { admit: true, reasons: [] }; }, resume: async () => ({ resume: true, reason: "" }), rebuildView: async (o, fixed, launch) => { asked.push([o.attemptId, fixed, typeof launch]); return { text: "NEW VIEW, built on the measured tools" }; } } });
  await (await r.local.start(moved)).run(gateway());
  assert.deepEqual(asked, [["att-1", { systemPromptChars: 100, toolSchemaChars: 200 }, "string"]], "measured from the process before the first call");
  assert.deepEqual(sent, ["do it\n\nNEW VIEW, built on the measured tools\n\n[carry on]"]);
  assert.deepEqual(sizes, ["", "do it\n\nNEW VIEW, built on the measured tools\n\n[carry on]"], "the admission measured the prompt that was sent");
  // A rebuilt view that is empty (nothing to show any more) leaves the task's own text.
  const emptySent: string[] = [];
  const e = rig(run([], emptySent), { context: { admit: async () => ({ admit: true, reasons: [] }), resume: async () => ({ resume: true, reason: "" }), rebuildView: async () => ({ text: "" }) } });
  await (await e.local.start(order({ content: `do it${VIEW}`, startupView: { route: "llama/local", measured: false, chars: VIEW.length } }))).run(gateway());
  assert.deepEqual(emptySent, ["do it"]);
  // The context does not fit with the real fixed part: nothing is admitted or sent, the attempt fails with the reason, and everything is closed.
  const refusedSent: string[] = []; let admits = 0;
  const f = rig(run([], refusedSent), { context: { admit: async () => { admits++; return { admit: true, reasons: [] }; }, resume: async () => ({ resume: true, reason: "" }), rebuildView: async () => ({ refused: "essential constraints do not fit the 8192-token route" }) } });
  const failed = await (await f.local.start(moved)).run(gateway());
  assert.equal(failed.status, "failed");
  assert.match(failed.error ?? "", /first call was not sent: the owner's context does not fit route llama\/local with its measured prompt and tools: essential constraints do not fit/);
  assert.deepEqual([refusedSent, admits], [[], 0]);
  assert.deepEqual(f.log, ["sandbox open", "runtime open", "runtime close", "sandbox close"]);
  // A measured view is not rebuilt; a rebuild that fails, or answers nothing, keeps the order's view (the first call is still checked with its real size) and the failure is reported.
  for (const [what, view, rebuild] of [
    ["measured", { route: "llama/local", measured: true, chars: VIEW.length }, async () => { throw new Error("should not be asked"); }],
    ["failing", { route: "llama/local", measured: false, chars: VIEW.length }, async () => { throw new Error("the store is down"); }],
    ["keep", { route: "llama/local", measured: false, chars: VIEW.length }, async () => undefined],
    ["inconsistent", { route: "llama/local", measured: false, chars: 500 }, async () => { throw new Error("should not be asked"); }],
  ] as const) {
    const kept: string[] = [];
    const k = rig(run([], kept), { context: { admit: async () => ({ admit: true, reasons: [] }), resume: async () => ({ resume: true, reason: "" }), rebuildView: rebuild } });
    await (await k.local.start(order({ content: `do it${VIEW}`, startupView: view }))).run(gateway());
    assert.deepEqual(kept, [`do it${VIEW}`], what);
    assert.deepEqual(k.errors, what === "failing" ? ["context rebuild: the store is down"] : [], what);
  }
});

test("a paused attempt is pausing while a call is in flight and paused only once it has settled; an interrupt reaches a running attempt and nothing reaches a paused one", async () => {
  const observed: string[] = [];
  const told: string[] = [];
  const acked: string[] = [];
  let paused = false;
  let release!: () => void;
  const hold = new Promise<void>((ok) => { release = ok; });
  let started!: () => void;
  const inCall = new Promise<void>((ok) => { started = ok; });
  const guards: RuntimeGuards = {
    pause: { isPaused: async () => paused, observe: async (_o, state, boundary) => { observed.push(`${state}${boundary === undefined ? "" : `/${boundary}`}`); } },
    messages: { readable: async (_o, boundary) => (acked.some((a) => a.startsWith(boundary)) ? [] : [{ id: `m-${boundary}`, text: `text for ${boundary}` }]), acknowledge: async (_o, boundary, ids) => { acked.push(`${boundary}:${ids.join(",")}`); return []; } },
  };
  const log: string[] = [];
  const beats: (() => Promise<void>)[] = [];
  let bound: ((r: { callId: string; tool: { name: string; version: string }; args: object }, e: never) => Promise<unknown>) | undefined;
  const local = new LocalWorker({
    hostId: "host:local", resources: { cpus: 1, memoryMb: 1 }, version: "v", capabilities: () => ({}) as never, guards, schedule: (beat) => { beats.push(beat); return () => undefined; },
    sandbox: { open: async (r) => ({ revision: r.revision, close: async () => undefined }) },
    runtimes: { open: async (_o, call) => { bound = call as never; log.push("open"); return { run: async () => { await (bound!({ callId: "c1", tool: { name: "slow", version: "1" }, args: {} }, { kind: "local", run: async () => ({ text: "x" }) } as never)); return { status: "completed", text: "done" }; }, checkpoint: async () => ({}), tell: async (t: string) => { told.push(t); }, close: async () => undefined }; } },
  });
  const handle = await local.start(order());
  const g = { ...gateway(), call: async () => { started(); await hold; return { state: "confirmed", operationId: "op", text: "ok" }; } } as unknown as ToolGateway;
  const running = handle.run(g);
  await inCall;
  const beat = beats[0]!;
  // Not paused, a call in flight: the interrupt is delivered, advice waits for a safe boundary.
  await beat();
  assert.deepEqual(told, ["text for interrupt"]);
  assert.deepEqual(acked, ["interrupt:m-interrupt"]);
  // Paused with the call still in flight: pausing, and nothing is delivered.
  paused = true;
  await beat();
  assert.deepEqual(observed, ["pausing"]);
  assert.equal(told.length, 1, "nothing is delivered to a paused attempt");
  await beat();
  assert.deepEqual(observed, ["pausing"], "the same state is not reported twice");
  // The call settles: now it is paused, with the safe-boundary statement.
  release();
  await running;
  assert.deepEqual(observed, ["pausing", "paused/finished"]);
  assert.equal(told.length, 1);
  // Resumed: the next beat reports nothing and delivery works again.
  paused = false;
  await beat();
  assert.equal(told.length >= 2, true, "delivery goes on once it is not paused (advice at a safe boundary)");
  assert.ok(acked.some((a) => a.startsWith("safe-boundary")));
});

test("a guard that fails is reported and does not stop the attempt", async () => {
  const errors: string[] = [];
  let beat!: () => Promise<void>;
  const local = new LocalWorker({
    hostId: "host:local", resources: { cpus: 1, memoryMb: 1 }, version: "v", capabilities: () => ({}) as never,
    guards: { pause: { isPaused: async () => { throw new Error("the pause service is down"); }, observe: async () => undefined }, messages: { readable: async () => { throw new Error("no messages"); }, acknowledge: async () => [] } },
    onGuardError: (_i, what, e) => { errors.push(`${what}: ${(e as Error).message}`); }, schedule: (b) => { beat = b; return () => undefined; },
    sandbox: { open: async (r) => ({ revision: r.revision, close: async () => undefined }) },
    runtimes: { open: async () => ({ run: async () => ({ status: "completed", text: "done" }), checkpoint: async () => ({}), tell: async () => undefined, close: async () => undefined }) },
  });
  const handle = await local.start(order());
  const running = handle.run(gateway());
  await beat();
  assert.equal((await running).status, "completed");
  assert.ok(errors.some((e) => /pause observation: the pause service is down/.test(e)));
  assert.ok(errors.some((e) => /message delivery \(interrupt\): no messages/.test(e)));
});

test("overlapping beats do not tell a message twice, an acknowledgement that failed is retried without telling again, and nothing is told after the turn", async () => {
  const told: string[] = [];
  let acks = 0;
  let slow!: () => void;
  const gate = new Promise<void>((ok) => { slow = ok; });
  let readsAfterTurn = 0;
  let turnOver = false;
  const guards: RuntimeGuards = {
    messages: {
      readable: async () => { if (turnOver) readsAfterTurn++; await gate; return acks >= 2 ? [] : [{ id: "m1", text: "hello" }]; },
      acknowledge: async () => { if (++acks === 1) throw new Error("storage hiccup"); return []; },
    },
  };
  const beats: (() => Promise<void>)[] = [];
  let release!: () => void;
  const hold = new Promise<void>((ok) => { release = ok; });
  const local = new LocalWorker({
    hostId: "host:local", resources: { cpus: 1, memoryMb: 1 }, version: "v", capabilities: () => ({}) as never, guards, onGuardError: () => undefined, schedule: (beat) => { beats.push(beat); return () => undefined; },
    sandbox: { open: async (r) => ({ revision: r.revision, close: async () => undefined }) },
    runtimes: { open: async () => ({ run: async () => { await hold; return { status: "completed", text: "done" }; }, checkpoint: async () => ({}), tell: async (t: string) => { told.push(t); }, close: async () => undefined }) },
  });
  const handle = await local.start(order());
  const running = handle.run(gateway());
  const first = beats[0]!();
  const second = beats[0]!();
  slow();
  await Promise.all([first, second]);
  assert.deepEqual(told, ["hello"], "two beats at once told it once");
  assert.equal(acks, 2, "the second pass retried the acknowledgement that failed in the first, without telling again");
  await beats[0]!();
  assert.deepEqual(told, ["hello"]);
  assert.equal(acks, 2, "acknowledged, so nothing is left to read");
  turnOver = true;
  release();
  await running;
  assert.equal(readsAfterTurn, 0, "no message is read after the turn");
});

test("H12j: a paused attempt with a model call still open is pausing, and advice is not delivered, until the model call ends", async () => {
  const observed: string[] = [];
  let modelCalls = 1;
  let beat!: () => Promise<void>;
  let finish!: () => void;
  const turn = new Promise<void>((ok) => { finish = ok; });
  const local = new LocalWorker({
    hostId: "host:local", resources: { cpus: 1, memoryMb: 1 }, version: "v", capabilities: () => ({}) as never,
    guards: {
      pause: { isPaused: async () => true, observe: async (_o, state) => { observed.push(state); } },
      messages: { readable: async (_o, boundary) => { return []; }, acknowledge: async () => [] },
    },
    schedule: (b) => { beat = b; return () => undefined; },
    sandbox: { open: async (r) => ({ revision: r.revision, close: async () => undefined }) },
    runtimes: { open: async () => ({ run: async () => { await turn; return { status: "completed" }; }, checkpoint: async () => ({}), tell: async () => undefined, activeModelCalls: () => modelCalls, close: async () => undefined }) },
  });
  const handle = await local.start(order());
  const running = handle.run(gateway());
  await beat();
  assert.deepEqual(observed, ["pausing"], "a provider call is still open, so the attempt is not paused");
  modelCalls = 0;
  await beat();
  assert.deepEqual(observed, ["pausing", "paused"]);
  finish();
  await running;
});

test("H12j: advice waits for a safe boundary while a model call is open", async () => {
  const asked: string[] = [];
  let modelCalls = 1;
  let beat!: () => Promise<void>;
  let finish!: () => void;
  const turn = new Promise<void>((ok) => { finish = ok; });
  const local = new LocalWorker({
    hostId: "host:local", resources: { cpus: 1, memoryMb: 1 }, version: "v", capabilities: () => ({}) as never,
    guards: { messages: { readable: async (_o, boundary) => { asked.push(boundary); return []; }, acknowledge: async () => [] } },
    schedule: (b) => { beat = b; return () => undefined; },
    sandbox: { open: async (r) => ({ revision: r.revision, close: async () => undefined }) },
    runtimes: { open: async () => ({ run: async () => { await turn; return { status: "completed" }; }, checkpoint: async () => ({}), tell: async () => undefined, activeModelCalls: () => modelCalls, close: async () => undefined }) },
  });
  const handle = await local.start(order());
  const running = handle.run(gateway());
  await beat();
  assert.deepEqual(asked, ["interrupt"]);
  modelCalls = 0;
  await beat();
  assert.deepEqual(asked, ["interrupt", "interrupt", "safe-boundary"]);
  finish();
  await running;
});

const ADMIT_ALL: RuntimeGuards["context"] = { admit: async () => ({ admit: true, reasons: [] }), resume: async () => ({ resume: true, reason: "fits" }) };

test("card H12f: the first refusal is announced as one to be retried when the runtime can compact (no blocker yet), the second is final; a compaction that fails still gets the second round, which refuses", async () => {
  const calls: [number, boolean | undefined][] = [];
  const r = rig(() => ({ firstCall: () => CALL, compact: async () => { throw new Error("the process could not compact"); } }), { context: { admit: async (_o, _c, round, retry) => { calls.push([round, retry]); return { admit: false, reasons: ["too big"] }; }, resume: ADMIT_ALL.resume } });
  const result = await (await r.local.start(order())).run(gateway());
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /first call was not sent: too big/);
  assert.deepEqual(calls, [[1, true], [2, false]]);
  assert.deepEqual(r.errors, ["compaction: the process could not compact"], "the failed compaction is reported, not silent");
  // A runtime that cannot compact has one round, and it is final.
  const plain: [number, boolean | undefined][] = [];
  const p = rig(() => ({ firstCall: () => CALL }), { context: { admit: async (_o, _c, round, retry) => { plain.push([round, retry]); return { admit: false, reasons: ["too big"] }; }, resume: ADMIT_ALL.resume } });
  await (await p.local.start(order())).run(gateway());
  assert.deepEqual(plain, [[1, false]]);
});

test("card H12b: a recipe change in the middle of a turn ends the old process on purpose and the turn goes on in the new one under the same request; usage of the part that was cut is carried; a failed restart ends the turn as it was", async () => {
  const runs: string[] = [];
  let release!: () => void;
  const hold = new Promise<void>((ok) => { release = ok; });
  let opens = 0;
  let started!: () => void;
  const running = new Promise<void>((ok) => { started = ok; });
  const r = rig((_log) => {
    const mine = ++opens;
    return {
      run: async (_c: string, requestId: string) => {
        runs.push(`${mine}:${requestId}`);
        if (mine === 1) { started(); await hold; return { status: "failed", error: "the worker process was closed", usage: { turnSeq: 1, cache: { backend: "vllm", route: "llama/local", cachedTokens: 5, computedTokens: 7, writtenTokens: 1 } } }; }
        return { status: "completed", text: "finished in the new process", usage: { turnSeq: 1, cache: { backend: "vllm", route: "llama/local", cachedTokens: 10, computedTokens: 2, writtenTokens: 0 } } };
      },
      close: async () => { if (mine === 1) release(); },
    };
  }, {});
  const handle = await r.local.start(order());
  const turn = handle.run(gateway());
  await running;
  await handle.restart({ revision: "r2", reach: ["x"] } as never, { n: 1 });
  const result = await turn;
  assert.equal(result.status, "completed");
  assert.equal(result.text, "finished in the new process");
  assert.deepEqual(runs, ["1:req-1", "2:req-1"], "the same request in the new process");
  assert.deepEqual(result.usage, { turnSeq: 1, cache: { backend: "vllm", route: "llama/local", cachedTokens: 15, computedTokens: 9, writtenTokens: 1 } }, "the part cut short is not lost");

  // A restart that fails leaves the turn's own result: nothing is run again on a runtime that is not there.
  let go!: () => void;
  const stuck = new Promise<void>((ok) => { go = ok; });
  let began!: () => void;
  const begun = new Promise<void>((ok) => { began = ok; });
  let sandboxes = 0;
  const bad = new LocalWorker({
    hostId: "host:local", resources: { cpus: 1, memoryMb: 1 }, version: "v", capabilities: () => ({}) as never,
    sandbox: { open: async (recipe) => { if (++sandboxes === 2) throw new Error("no sandbox for the new recipe"); return { revision: recipe.revision, close: async () => undefined }; } },
    runtimes: { open: async () => ({ run: async () => { began(); await stuck; return { status: "failed", error: "closed", usage: { turnSeq: 1, cache: { backend: "vllm", route: "llama/local", cachedTokens: 6, computedTokens: 2, writtenTokens: 0 } } }; }, checkpoint: async () => ({}), close: async () => { go(); } }) },
  });
  const h2 = await bad.start(order());
  const t2 = h2.run(gateway());
  await begun;
  await assert.rejects(h2.restart({ revision: "r2", reach: [] } as never, {}), /no sandbox for the new recipe/);
  const after = await t2;
  assert.deepEqual([after.status, after.error], ["failed", "closed"]);
  // The figures the cut turn's calls produced end the attempt with it, once (card H12e): the attempt is over, so nothing else would take them.
  assert.deepEqual(after.usage, { turnSeq: 1, cache: { backend: "vllm", route: "llama/local", cachedTokens: 6, computedTokens: 2, writtenTokens: 0 } });
});

test("card H12f: a restarted sandbox's conversation is admitted again; one that cannot fit is refused and the restart fails, leaving the attempt for the dispatcher to keep frozen", async () => {
  const rounds: [number, boolean | undefined][] = [];
  let sizes = 0;
  const r = rig(() => ({ firstCall: () => { sizes++; return CALL; } }), { context: { admit: async (_o, _c, round, retry) => { rounds.push([round, retry]); return { admit: rounds.length === 1 || round === 5, reasons: ["conversation too big"] }; }, resume: ADMIT_ALL.resume } });
  const handle = await r.local.start(order());
  await assert.rejects(handle.restart({ revision: "r2", reach: [] } as never, {}), /restarted sandbox's first call was not sent: conversation too big/);
  assert.deepEqual(rounds.map(([round]) => round), [1, 2], "the restart's check has a round of its own (numbering goes on from the start)");
  assert.equal(sizes, 2);
});

test("review fix (card H12b): a restart that fails after opening the new sandbox (re-admission refused, process not started) closes the new runtime and sandbox; the frozen attempt does not keep them running", async () => {
  for (const failure of ["refused", "open"] as const) {
    const open = new Set<string>();
    let sandboxes = 0; let runtimes = 0; let asked = 0;
    const local = new LocalWorker({
      hostId: "host:local", resources: { cpus: 1, memoryMb: 1 }, version: "v", capabilities: () => ({}) as never,
      ...(failure === "refused" ? { guards: { context: { admit: async () => ({ admit: ++asked === 1, reasons: ["conversation too big"] }), resume: ADMIT_ALL.resume } } as never } : {}),
      sandbox: { open: async (recipe) => { const n = ++sandboxes; open.add(`sandbox ${n}`); return { revision: recipe.revision, close: async () => { open.delete(`sandbox ${n}`); } }; } },
      runtimes: { open: async () => { const n = ++runtimes; if (failure === "open" && n === 2) throw new Error("the process did not start"); open.add(`runtime ${n}`); return { firstCall: () => CALL, run: async () => ({ status: "completed" as const }), checkpoint: async () => ({}), close: async () => { open.delete(`runtime ${n}`); } }; } },
    });
    const handle = await local.start(order());
    assert.deepEqual([...open].sort(), ["runtime 1", "sandbox 1"]);
    await assert.rejects(handle.restart({ revision: "r2", reach: [] } as never, {}));
    assert.deepEqual([...open], [], `nothing is left running after a ${failure} restart`);
  }
});

test("card H12b: restarts run one at a time, and a stop that comes while the sandbox is being started again ends what the restart opened", async () => {
  const log: string[] = [];
  let release!: () => void;
  const slow = new Promise<void>((ok) => { release = ok; });
  let sandboxes = 0;
  let entered!: () => void;
  const inOpen = new Promise<void>((ok) => { entered = ok; });
  const local = new LocalWorker({
    hostId: "host:local", resources: { cpus: 1, memoryMb: 1 }, version: "v", capabilities: () => ({}) as never,
    sandbox: { open: async (recipe) => { const n = ++sandboxes; log.push(`sandbox ${n} open`); if (n === 2) { entered(); await slow; } return { revision: recipe.revision, close: async () => { log.push(`sandbox ${n} close`); } }; } },
    runtimes: { open: async () => { const n = log.filter((l) => l.startsWith("runtime") && l.endsWith("open")).length + 1; log.push(`runtime ${n} open`); return { run: async () => ({ status: "completed" as const }), checkpoint: async () => ({}), close: async () => { log.push(`runtime ${n} close`); } }; } },
  });
  const handle = await local.start(order());
  const restarting = handle.restart({ revision: "r2", reach: [] } as never, {});
  const outcome = restarting.then(() => "restarted", (error: Error) => error.message);
  await inOpen;
  const stopping = handle.stop();
  release();
  await stopping;
  assert.match(await outcome, /the attempt was stopped/);
  assert.ok(log.includes("sandbox 2 close"), `the sandbox the restart opened was closed: ${log.join(", ")}`);
  assert.equal(log.filter((l) => l === "runtime 2 open").length, 0, "no runtime was started in it");
});
