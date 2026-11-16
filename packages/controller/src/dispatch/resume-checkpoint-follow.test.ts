import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld, workGrants, type DispatchWorld } from "./testing/world.js";
import type { DispatcherDeps } from "./dispatcher.js";

after(stopServer);

// Card L04d (follow-ups): the resume check follows the checkpoint the attempt restores, and a turn's capture is made after the turn's usage was charged.
const PI = (digest: string, at: number): Record<string, unknown> => ({ pi: { conversationId: 1, at, digest, runtime: { name: "pi", version: "1" }, format: 1 } });
const D1 = `sha256:${"a".repeat(64)}`;
const D2 = `sha256:${"b".repeat(64)}`;

for (const backend of backends) {
  const suite = (name: string, body: (c: DispatchWorld) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const store = await backend.open();
      try { await body(await buildWorld(store.storage)); } finally { await store.close(); }
    });

  const fakeResumes = (started: Record<string, unknown>[], extra: Partial<NonNullable<DispatcherDeps["resumes"]>>): NonNullable<DispatcherDeps["resumes"]> => ({
    start: async (_by: unknown, command: Record<string, unknown>) => { started.push(command); return { id: "rck-1", revision: 1, body: undefined, phase: "reviewing" } as never; },
    commit: async () => ({ id: "rck-1", phase: "done" }) as never,
    advance: async () => { throw new Error("not used"); }, forTask: async () => undefined, get: async () => undefined, checkIdFor: (_by, k) => `rck-${k}`, retryable: async () => false, exhausted: () => false, cancelledAsStale: () => false,
    retry: async () => { throw new Error("not used"); }, cancel: async () => { throw new Error("not used"); },
    hasContinuation: async () => true,
    ...extra,
  } as NonNullable<DispatcherDeps["resumes"]>);

  const restartFrom = async (c: DispatchWorld, digest: string, at: number, resumes: NonNullable<DispatcherDeps["resumes"]>, told: string[]): Promise<void> => {
    const ann = await c.agent("ann", workGrants(c.project, []));
    await c.task("long job", ann);
    const ids = new Set<string>();
    const activity: NonNullable<DispatcherDeps["activity"]> = async (s) => { if (!ids.has(s.commandId)) { ids.add(s.commandId); told.push(s.summary); } };
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    c.worker.script = async ({ worker }) => { worker.checkpoint = async () => PI(digest, at) as never; await gate; return { status: "completed", text: "late" }; };
    let d = c.restart({ resumes, activity });
    await d.tick();
    await d.shutdown();
    release();
    await d.idle();
    d = c.restart({ resumes, activity });
    await d.tick();
    await d.idle();
  };

  suite("the dispatcher starts the check naming the checkpoint the attempt restores, and says nothing when that checkpoint has its own complete capture", async (c) => {
    const started: Record<string, unknown>[] = [];
    const told: string[] = [];
    const resumes = fakeResumes(started, {
      latestCheckpoint: async () => ({ conversationId: 1, at: 5, digest: D1 }),
      capturedCheckpoint: async (_by: unknown, _task: string, digest: string) => (digest === D2 ? { conversationId: 1, at: 9, digest: D2 } : undefined),
    });
    await restartFrom(c, D2, 9, resumes, told);
    assert.ok(started.length >= 1, "a check was started");
    assert.ok(started.every((s) => s["checkpointDigest"] === D2), `every start names the checkpoint: ${JSON.stringify(started)}`);
    assert.deepEqual(told.filter((t) => /has no complete capture/.test(t)), [], "the check follows its own capture: nothing to tell");
  });

  suite("a checkpoint with no complete capture is still told, and its check names it (the service then falls back to the latest)", async (c) => {
    const started: Record<string, unknown>[] = [];
    const told: string[] = [];
    const resumes = fakeResumes(started, {
      latestCheckpoint: async () => ({ conversationId: 1, at: 5, digest: D1 }),
      capturedCheckpoint: async () => undefined,
    });
    await restartFrom(c, D2, 9, resumes, told);
    assert.equal(told.filter((t) => /has no complete capture/.test(t)).length, 1, JSON.stringify(told));
    assert.ok(started.every((s) => s["checkpointDigest"] === D2));
  });

  suite("a completed turn's usage is charged before its checkpoint is captured", async (c) => {
    const ann = await c.agent("ann", workGrants(c.project, []));
    await c.task("charged", ann);
    const order: string[] = [];
    const budgets = new Proxy(c.budgets, { get: (target, prop) => {
      const v = Reflect.get(target, prop) as unknown;
      if (prop === "charge") return async (...args: unknown[]) => { order.push("charge"); return (target.charge as (...a: unknown[]) => unknown).apply(target, args); };
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    } });
    c.worker.script = async () => ({ status: "completed", text: "done", checkpoint: PI(D1, 3) as never, usage: { costMicros: 700 } });
    const d = c.restart({ budgets: budgets as never, checkpoints: async (info) => { if (info.boundary === "turn-complete") order.push("capture"); } });
    await d.tick();
    await d.idle();
    const at = (x: string): number => order.indexOf(x);
    assert.ok(at("capture") >= 0, `the turn was captured: ${JSON.stringify(order)}`);
    assert.ok(at("charge") >= 0 && at("charge") < at("capture"), `usage first, then the capture: ${JSON.stringify(order)}`);
  });
}
