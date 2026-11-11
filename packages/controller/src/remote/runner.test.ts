import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelStreamRefused } from "../dispatch/model-stream.js";
import type { WorkOrder, WorkerHandle } from "../dispatch/ports.js";
import { WorkerRequestError } from "./client.js";
import { RemoteOfferRunner } from "./runner.js";

// Card L05d: the remote worker host's side of one offer, with a stand-in for the attempt's protocol session and the host.
const order = { attemptId: "att-1", taskId: "task-1" } as unknown as WorkOrder;
const offer = { placement: 3, order };
interface Log { calls: string[]; completed: unknown[] }
function fake(options: { honor?: { ok: boolean }; control?: () => Promise<unknown[]>; complete?: () => Promise<void> } = {}) {
  const log: Log = { calls: [], completed: [] };
  let tapOptions: unknown;
  const attempt = {
    accept: async () => { log.calls.push("accept"); },
    honorContract: async () => options.honor ?? { ok: true },
    pollControl: async () => (options.control === undefined ? [] : options.control()),
    putCheckpoint: async (n: number) => { log.calls.push(`checkpoint ${n}`); },
    confirmRestarts: async () => ({ digest: "d", recipe: {} }),
    complete: async (r: unknown) => { await options.complete?.(); log.completed.push(r); },
    streamTap: (o: unknown) => { tapOptions = o; return { started: async () => ({ heldBufferBytes: 1 }) }; },
  };
  const client = { attempt: (id: string, placement: number) => { log.calls.push(`attempt ${id} ${placement}`); return attempt; } };
  return { client: client as never, log, tapOptions: () => tapOptions };
}
const handle = (over: Partial<WorkerHandle> = {}): WorkerHandle => ({ workerVersion: "w", run: async () => ({ status: "completed", text: "x" }) as never, checkpoint: async () => ({ turn: 1 }), restart: async () => undefined, stop: async () => undefined, ...over } as WorkerHandle);
const base = { abilities: {} as never, now: () => "2026-11-11T10:00:00.000Z", controlMs: 5 };

test("an offer is accepted, its contract confirmed, the order started and its result sent with a final checkpoint; the attempt is no longer running afterwards (card L05d)", async () => {
  const f = fake();
  const stopped: string[] = [];
  const runner = new RemoteOfferRunner({ ...base, client: f.client, host: { start: async () => handle({ stop: async () => { stopped.push("stop"); } }) } });
  assert.equal(await runner.run(offer), "completed");
  assert.deepEqual(f.log.calls, ["attempt att-1 3", "accept"]);
  assert.deepEqual(f.log.completed, [{ status: "completed", text: "x", checkpoint: { turn: 1 } }]);
  assert.deepEqual(stopped, ["stop"]);
  assert.deepEqual(runner.running, []);
});

test("a contract the worker cannot honor refuses the offer and starts nothing; an order that cannot start is reported failed (card L05d)", async () => {
  const f = fake({ honor: { ok: false } });
  let started = 0;
  assert.equal(await new RemoteOfferRunner({ ...base, client: f.client, host: { start: async () => { started++; return handle(); } } }).run(offer), "refused");
  assert.equal(started, 0);
  const g = fake();
  assert.equal(await new RemoteOfferRunner({ ...base, client: g.client, host: { start: async () => { throw new Error("no sandbox"); } } }).run(offer), "failed");
  assert.match(String((g.log.completed[0] as { error: string }).error), /could not start the order: no sandbox/);
});

test("a worker that breaks is reported as a failed result; a fenced answer drops the attempt and stops the sandbox (card L05d)", async () => {
  const f = fake();
  assert.equal(await new RemoteOfferRunner({ ...base, client: f.client, host: { start: async () => handle({ run: async () => { throw new Error("boom"); } }) } }).run(offer), "completed");
  assert.match(String((f.log.completed[0] as { error: string }).error), /the worker broke: boom/);
  const g = fake({ complete: async () => { throw new WorkerRequestError(409, "fenced", "the attempt is no longer current"); } });
  const stopped: string[] = [];
  const runner = new RemoteOfferRunner({ ...base, client: g.client, host: { start: async () => handle({ stop: async () => { stopped.push("stop"); } }) } });
  assert.equal(await runner.run(offer), "fenced");
  assert.deepEqual(stopped, ["stop"]);
});

test("the controller's control messages are followed while the turn runs: tell, checkpoint and stop (card L05d)", async () => {
  const sent: unknown[][] = [[{ seq: 1, kind: "tell", text: "beans" }, { seq: 2, kind: "checkpoint" }]];
  const f = fake({ control: async () => sent.shift() ?? [] });
  const told: string[] = [];
  const release: { open?: () => void } = {};
  const running = new Promise<void>((r) => { release.open = r; });
  const runner = new RemoteOfferRunner({ ...base, client: f.client, host: { start: async () => handle({ tell: async (t: string) => { told.push(t); }, run: async () => { await running; return { status: "completed" } as never; } }) } });
  const done = runner.run(offer);
  const end = Date.now() + 5000;
  while (told.length === 0 || !f.log.calls.includes("checkpoint 1")) { if (Date.now() > end) assert.fail("the control messages were not followed"); await new Promise((r) => setTimeout(r, 10)); }
  release.open!();
  assert.equal(await done, "completed");
  assert.deepEqual(told, ["beans"]);
});

test("a restart whose confirmation could not be sent is not applied: the batch is read again and the restart happens only once it is confirmed (card L05d review)", async () => {
  const restartMsg = { seq: 1, kind: "restart", recipe: { mounts: ["changed"] } };
  let polls = 0;
  const f = fake({ control: async () => { polls++; return [restartMsg]; } });
  let confirms = 0;
  const attempt = (f.client as unknown as { attempt: (id: string, p: number) => Record<string, unknown> }).attempt("att-1", 3);
  attempt["confirmRestarts"] = async () => { if (++confirms === 1) throw new Error("connection reset"); return { digest: "d2", recipe: restartMsg.recipe }; };
  const restarted: number[] = [];
  const release: { open?: () => void } = {};
  const running = new Promise<void>((r) => { release.open = r; });
  const runner = new RemoteOfferRunner({ ...base, client: f.client, host: { start: async () => handle({ restart: async () => { restarted.push(confirms); }, run: async () => { await running; return { status: "completed" } as never; } }) } });
  const done = runner.run({ placement: 3, order: { ...order, contract: { digest: "d1" }, recipe: {} } as unknown as WorkOrder });
  const end = Date.now() + 5000;
  while (restarted.length === 0) { if (Date.now() > end) assert.fail("the restart was never applied"); await new Promise((r) => setTimeout(r, 5)); }
  release.open!();
  assert.equal(await done, "completed");
  assert.equal(restarted[0], 2, "the restart waited for its confirmation");
  assert.ok(polls >= 2);
});

test("the relay's stream tap records through the attempt's protocol tap while the attempt runs, with the worker's batching; an attempt that is not running gets its model call refused before it is sent (card L05d)", async () => {
  const f = fake();
  const release: { open?: () => void } = {};
  const running = new Promise<void>((r) => { release.open = r; });
  const runner = new RemoteOfferRunner({ ...base, client: f.client, stream: { batchMs: 7 }, host: { start: async () => handle({ run: async () => { await running; return { status: "completed" } as never; } }) } });
  await assert.rejects(runner.tap("att-1").started({ requestChars: 1 }), (e: unknown) => e instanceof ModelStreamRefused && /not running on this worker/.test((e as Error).message));
  const done = runner.run(offer);
  while (!runner.running.includes("att-1")) await new Promise((r) => setTimeout(r, 5));
  while (!f.log.calls.includes("accept")) await new Promise((r) => setTimeout(r, 5));
  const tap = runner.tap("att-1");
  assert.deepEqual(await tap.started({ requestChars: 1 }), { heldBufferBytes: 1 });
  await tap.started({ requestChars: 2 });
  assert.deepEqual(f.tapOptions(), { batchMs: 7 }, "one protocol tap per attempt, made with the worker's batching");
  release.open!();
  assert.equal(await done, "completed");
  await assert.rejects(runner.tap("att-1").started({ requestChars: 1 }), ModelStreamRefused);
});

test("a stream event's alias is kept when it is a tool call ID the bridge could send and refused otherwise (card L05d)", async () => {
  const { checkStreamEvents } = await import("./service.js");
  const tool = (alias: unknown) => [{ kind: "tool", id: "call-0", name: "t", alias, argumentsDelta: "{}", done: true }];
  assert.deepEqual(checkStreamEvents(tool("h:0123456789abcdef0123456789abcdef01234567")), tool("h:0123456789abcdef0123456789abcdef01234567"));
  assert.deepEqual(checkStreamEvents(tool(undefined)).map((e) => "alias" in e), [false]);
  for (const bad of ["has space", "", "x".repeat(121), 7]) assert.throws(() => checkStreamEvents(tool(bad)), /alias/, String(bad));
});
