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
