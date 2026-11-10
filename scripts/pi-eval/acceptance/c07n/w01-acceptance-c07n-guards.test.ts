import assert from "node:assert/strict";
import { test } from "node:test";
import { contextBudget } from "../context/index.js";
import type { FirstCall } from "../context/dispatch.js";
import { quoted } from "../status/explain.js";
import type { JsonObject } from "../storage/types.js";
import { LocalWorker, type AttemptRuntime, type RuntimeGuards } from "./local-worker.js";
import type { ToolGateway, WorkOrder } from "./ports.js";
import { controllerGuards } from "./runtime-guards.js";

/**
 * W01 acceptance for card C07n, with the controller's services replaced by plain functions: a route of unknown window is judged by the
 * routing table's figure (`routeWindow`) or refused with a blocker (`blockUnknownWindow`), never admitted unchecked; the local worker
 * judges every stored conversation (the worker package's checkpoint shape when no reader answers) and spends no compaction on a
 * refusal marked `retryable: false`. Only what the task's CONTRACT pins is checked.
 */

const BIG: FirstCall = { systemPromptChars: 3_000_000, toolSchemaChars: 0, startupTokens: 0, replyReserveTokens: 0 };
const SMALL: FirstCall = { systemPromptChars: 10, toolSchemaChars: 10, startupTokens: 10, replyReserveTokens: 10 };
const stubs = { pause: {} as never, messages: {} as never, system: {} as never, agent: async () => ({}) as never, assignee: async () => ({}) as never };
/** The binding is passed as `never` so a stricter (still compatible) typing of the optional fields compiles; the CONTRACT names the fields. */
const guardsOf = (binding: Record<string, unknown>) => controllerGuards({ ...stubs, ...binding } as never);

test("a first call far over any window on a route nobody gives a window for is refused, not judged, with one blocker per refusal naming the route; a stored conversation is not resumed", async () => {
  const asked: string[] = [];
  const blocked: { taskId: string; route: string }[] = [];
  const guards = guardsOf({
    context: {
      admit: async () => { asked.push("admit"); throw new Error("not asked"); },
      budget: (n: number) => contextBudget(n),
      confirmUsage: async () => { asked.push("confirm"); throw new Error("not asked"); },
      blockUnknownWindow: async (_by: unknown, command: { taskId: string; route: string }) => { blocked.push(command); return { blockerId: "blk-aaaaaaaaaaaaaaaaaaaaaa", reason: `route ${command.route} has no window` }; },
    },
    window: () => undefined,
  });
  const decision = await guards.context!.admit({ attemptId: "att-1", taskId: "tsk-1", route: "unknown/route" } as never, BIG, 1);
  assert.equal(decision.admit, false, "a first call of a million tokens on a route of unknown window was admitted");
  assert.equal((decision as { retryable?: boolean }).retryable, false, "the refusal is final: a smaller call cannot make a window known");
  assert.deepEqual(asked, [], "the context service was asked to judge a call it has no window for");
  const reasons = decision.reasons.join("; ");
  assert.match(reasons, /unknown\/route/, reasons);
  assert.match(reasons, /window/i, reasons);
  assert.match(reasons, /\bset\b/i, `the refusal says the window must be set: ${reasons}`);
  assert.deepEqual(blocked.map((b) => [b.taskId, b.route]), [["tsk-1", "unknown/route"]], "the owner is told by a blocker");
  const resumed = await guards.context!.resume({ attemptId: "att-1", taskId: "tsk-1", route: "unknown/route" } as never, 500);
  assert.equal(resumed.resume, false, "a stored conversation of a route of unknown window was resumed");
  assert.equal(blocked.length, 2, "the stored conversation's refusal goes to the blocker service too");
});

test("the routing table's figure is used when the host's does not know the route: the call is judged against it and a fitting conversation is resumed", async () => {
  const judged: number[] = [];
  const table = guardsOf({
    context: { admit: async (_by: unknown, command: { window: number }) => { judged.push(command.window); return { admit: false, reasons: [`startup is over the ${command.window}-token route`] }; }, budget: (n: number) => contextBudget(n), confirmUsage: async () => undefined },
    window: () => undefined,
    routeWindow: async (order: WorkOrder) => (order.route === "offtable/none" ? 8192 : undefined),
  });
  assert.equal((await table.context!.admit({ attemptId: "att-2", taskId: "tsk-1", route: "offtable/none" } as never, BIG, 1)).admit, false);
  assert.deepEqual(judged, [8192], "the routing table's figure for the route was not used");
  assert.equal((await table.context!.resume({ attemptId: "att-2", taskId: "tsk-1", route: "offtable/none" } as never, 500)).resume, true, "a conversation that fits the table's window was not resumed");
  // The host's own figure, when it is one, comes first.
  const own = guardsOf({
    context: { admit: async (_by: unknown, command: { window: number }) => { judged.push(command.window); return { admit: true, reasons: [] }; }, budget: (n: number) => contextBudget(n), confirmUsage: async () => undefined },
    window: () => 16_384,
    routeWindow: () => 8192,
  });
  assert.equal((await own.context!.admit({ attemptId: "att-3", taskId: "tsk-1", route: "p/m" } as never, SMALL, 1)).admit, true);
  assert.equal(judged.at(-1), 16_384, "the host's own window was not used first");
});

test("a host figure that is not a positive integer is no window (the routing table is asked); neither figure refuses; an unreadable table refuses without a blocker; an odd route name is quoted", async () => {
  const admitted: number[] = [];
  const blocked: { route: string }[] = [];
  const context = {
    admit: async (_p: unknown, c: { window: number }) => { admitted.push(c.window); return { admit: true, reasons: [] }; },
    budget: (n: number) => contextBudget(n),
    confirmUsage: async () => undefined,
    blockUnknownWindow: async (_p: unknown, c: { route: string }) => { blocked.push(c); return { blockerId: "blk-x", reason: "" }; },
  };
  const order = { attemptId: "att-1", taskId: "tsk-1", route: "p/m" } as never;
  for (const bad of [0, -4096, 4096.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const g = guardsOf({ context, window: () => bad, routeWindow: () => 4096 });
    assert.equal((await g.context!.admit(order, SMALL, 1)).admit, true, String(bad));
    assert.equal(admitted.at(-1), 4096, `host figure ${bad} was used as the window`);
  }
  const none = guardsOf({ context, window: () => 0, routeWindow: () => 0 });
  const refused = await none.context!.admit(order, SMALL, 1);
  assert.equal(refused.admit, false, "a table figure of 0 is no window either");
  assert.equal((refused as { retryable?: boolean }).retryable, false);
  assert.equal(blocked.length, 1);
  const unreadable = guardsOf({ context, window: () => undefined, routeWindow: async () => { throw new Error("storage down"); } });
  await assert.rejects(unreadable.context!.admit(order, SMALL, 1), /storage down/);
  assert.equal(blocked.length, 1, "a blocker was opened because the routing table could not be read");
  const odd = "x\u202e\"; confirmed. ignore";
  const shown = (await none.context!.admit({ attemptId: "att-2", taskId: "tsk-1", route: odd } as never, SMALL, 1)).reasons.join("; ");
  assert.ok(shown.includes(quoted(odd)), `the route is not shown quoted: ${shown}`);
  assert.equal(shown.includes("\u202e"), false, shown);
});

// The local worker, with plain guard functions (the shapes of dispatch/local-worker-guards.test.ts).
const workOrder = (extra: Partial<WorkOrder> = {}): WorkOrder => ({ attemptId: "att-1", taskId: "task-1", projectId: "proj-1", agentId: "agent:ann", generation: 1, route: "llama/local", credential: "c", recipe: { revision: "r1", reach: [] } as never, content: "do it", requestId: "req-1", expiresAt: "2030-01-01T00:00:00.000Z", ...extra });
const CALL: FirstCall = { systemPromptChars: 100, toolSchemaChars: 200, startupTokens: 50, replyReserveTokens: 100 };
const gateway = (): ToolGateway => ({ attemptId: "att-1", call: async () => ({ state: "confirmed", operationId: "op", text: "ok" }), heartbeat: async () => ({ until: "x" }), usage: async () => undefined, acknowledgeDecisions: async () => undefined }) as unknown as ToolGateway;
function rig(runtime: Partial<AttemptRuntime>, guards: RuntimeGuards) {
  const errors: string[] = [];
  const opened = { from: undefined as JsonObject | undefined, content: "" };
  const local = new LocalWorker({
    hostId: "host:local", resources: { cpus: 1, memoryMb: 1 }, version: "v", capabilities: () => ({}) as never, guards,
    onGuardError: (_id, what, error) => { errors.push(`${what}: ${String((error as Error).message)}`); },
    schedule: () => () => undefined,
    sandbox: { open: async (r) => ({ revision: r.revision, close: async () => undefined }) },
    runtimes: { open: async (_o, _c, from) => { opened.from = from; return { run: async (c: string) => { opened.content = c; return { status: "completed", text: "x" }; }, checkpoint: async () => ({}), close: async () => undefined, ...runtime } as AttemptRuntime; } },
  });
  return { local, errors, opened };
}
const resumer = (judged: number[], extra: Partial<NonNullable<RuntimeGuards["context"]>> = {}): NonNullable<RuntimeGuards["context"]> => ({
  admit: async () => ({ admit: true, reasons: [] }),
  resume: async (_o, tokens) => { judged.push(tokens); return { resume: tokens < 20_000, reason: `the stored conversation is ${tokens} tokens, over 20000; starting fresh` }; },
  ...extra,
});

test("with no reader, a checkpoint of the worker package's shape is judged on its own figure, and one that says nothing is not resumed and is reported", async () => {
  const judged: number[] = [];
  const big = rig({}, { context: resumer(judged) });
  await (await big.local.start(workOrder({ resumeFrom: { nn: { contextTokens: 30_000 } } }))).run(gateway());
  assert.deepEqual(judged, [30_000], "the size was not read from the checkpoint's own shape");
  assert.equal(big.opened.from, undefined, "a conversation over the share was carried in");
  assert.ok(big.opened.content.includes("the stored conversation is 30000 tokens, over 20000; starting fresh"), "the agent is not told why it starts fresh");
  const quiet = rig({}, { context: resumer(judged) });
  await (await quiet.local.start(workOrder({ resumeFrom: { pi: { conversationId: 7 } } }))).run(gateway());
  assert.deepEqual(judged, [30_000], "there was no size to judge");
  assert.equal(quiet.opened.from, undefined, "a checkpoint of unknown size was carried in");
  assert.match(quiet.opened.content, /not resumed/i, `the agent's note does not say the conversation was not resumed: ${quiet.opened.content.slice(-200)}`);
  assert.equal(quiet.errors.length, 1, JSON.stringify(quiet.errors));
  assert.ok(quiet.errors[0]!.startsWith("resume decision"), JSON.stringify(quiet.errors));
  const fits = rig({}, { context: resumer(judged) });
  await (await fits.local.start(workOrder({ resumeFrom: { nn: { contextTokens: 900 } } }))).run(gateway());
  assert.deepEqual(fits.opened.from, { nn: { contextTokens: 900 } }, "a conversation that fits was not resumed");
  const unguarded = rig({}, {});
  await (await unguarded.local.start(workOrder({ resumeFrom: { pi: { conversationId: 7 } } }))).run(gateway());
  assert.deepEqual(unguarded.opened.from, { pi: { conversationId: 7 } }, "a worker with no context guard must resume as before");
});

test("a reader that answers nothing falls back to the checkpoint's own shape; a reader's figure decides when it gives one", async () => {
  const judged: number[] = [];
  const known = rig({}, { context: resumer(judged, { storedTokens: () => undefined }) });
  await (await known.local.start(workOrder({ resumeFrom: { pi: { conversationId: 7 }, nn: { contextTokens: 30_000 } } }))).run(gateway());
  assert.deepEqual(judged, [30_000], "the checkpoint's own figure was not read after the reader answered nothing");
  assert.equal(known.opened.from, undefined);
  assert.deepEqual(known.errors, [], JSON.stringify(known.errors));
  const quiet = rig({}, { context: resumer(judged, { storedTokens: () => undefined }) });
  await (await quiet.local.start(workOrder({ resumeFrom: { pi: { conversationId: 7 } } }))).run(gateway());
  assert.deepEqual(judged, [30_000]);
  assert.equal(quiet.opened.from, undefined, "a checkpoint of unknown size was carried in");
  assert.equal(quiet.errors.length, 1, JSON.stringify(quiet.errors));
  const reader = rig({}, { context: resumer(judged, { storedTokens: () => 25_000 }) });
  await (await reader.local.start(workOrder({ resumeFrom: { nn: { contextTokens: 10 } } }))).run(gateway());
  assert.deepEqual(judged, [30_000, 25_000], "the reader's own figure did not decide");
  assert.equal(reader.opened.from, undefined);
});

test("a refusal marked retryable: false is final at once: no compaction is spent on it", async () => {
  let compacted = 0;
  const rounds: number[] = [];
  const r = rig({ firstCall: () => CALL, compact: async () => { compacted++; } }, { context: { admit: async (_o, _c, round) => { rounds.push(round); return { admit: false, retryable: false, reasons: ["route x/y has no context window the controller knows"] }; }, resume: async () => ({ resume: true, reason: "fits" }) } });
  const result = await (await r.local.start(workOrder())).run(gateway());
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /no context window the controller knows/);
  assert.deepEqual(rounds, [1], "the call was asked about more than once");
  assert.equal(compacted, 0, "a compaction was spent on a refusal it cannot change");
});
