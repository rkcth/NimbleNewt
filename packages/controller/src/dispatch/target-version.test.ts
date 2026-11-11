import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { ToolResult } from "./ports.js";
import { buildWorld, workGrants, type DispatchWorld } from "./testing/world.js";

after(stopServer);

const deferred = <T = void>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const bridge = (log: { applied: number }) => ({
  idempotent: false,
  execute: async () => { log.applied++; return { receipt: "r" }; },
  reconcile: async () => ({ state: (log.applied > 0 ? "applied" : "not_applied") as "applied" | "not_applied" }),
});

for (const backend of backends) {
  const suite = (name: string, body: (c: DispatchWorld) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const store = await backend.open();
      try { await body(await buildWorld(store.storage)); } finally { await store.close(); }
    });

  /** A call the policy sends to the owner, approved while the target is at `v1`; then the controller reads `after` just before the approval would be used. */
  const scenario = async (c: DispatchWorld, version: { current: string | undefined | Error }) => {
    const ann = await c.agent("ann", workGrants(c.project, ["git-push"]));
    await c.task("push", ann);
    const log = { applied: 0 };
    const go = deferred();
    const parked = deferred<ToolResult>();
    let again: ToolResult | undefined;
    const call = (gateway: { call(r: never, e: never): Promise<ToolResult> }) => gateway.call({ callId: "push1", tool: { name: "git-push", version: "2.0" }, args: { branch: "main" } } as never, { kind: "effect", effectKind: "git-push", target: "repo", input: {}, bridge: bridge(log) } as never);
    c.worker.script = async ({ gateway }) => {
      parked.resolve(await call(gateway as never));
      await go.promise;
      again = await call(gateway as never);
      return { status: "completed", text: "x" };
    };
    const d = c.restart({ targetVersion: async () => { if (version.current instanceof Error) throw version.current; return version.current; } });
    await d.tick();
    const first = await parked.promise;
    assert.equal(first.state, "awaiting-approval");
    const review = (await c.reviews.get(c.owner, (first as { reviewId: string }).reviewId))!;
    return { review, log, finish: async () => { go.resolve(); await d.idle(); return again; }, decide: () => c.reviews.decide(c.owner, { commandId: "dec", requestId: review.id, expectedRevision: review.revision, verdict: "allow", reason: "ok" }) };
  };

  suite("card A05b: the controller's reading of the target version is bound to the review; the same version runs the call once", async (c) => {
    const version = { current: "0123456789abcdef0123456789abcdef01234567" as string | undefined | Error };
    const s = await scenario(c, version);
    assert.equal(s.review.operation.target.version, version.current, "the reviewer is shown the version the controller read");
    await s.decide();
    const result = await s.finish();
    assert.equal(result?.state, "confirmed");
    assert.equal(s.log.applied, 1);
  });

  suite("card A05b: a target that moved between the approval and the run is not run, and the reason names the version", async (c) => {
    const version = { current: "v1" as string | undefined | Error };
    const s = await scenario(c, version);
    await s.decide();
    version.current = "v2";
    const result = await s.finish();
    assert.equal(result?.state, "refused");
    assert.match(JSON.stringify(result), /the target's version changed/);
    assert.equal(s.log.applied, 0, "nothing ran");
    assert.equal((await c.reviews.get(c.owner, s.review.id))!.state, "approved", "the refused try used nothing up");
  });

  suite("card A05b: a version that cannot be read when the approval is used refuses the call (fail closed); an unreadable one when asking refuses the request", async (c) => {
    const version = { current: "v1" as string | undefined | Error };
    const s = await scenario(c, version);
    await s.decide();
    version.current = new Error("disk gone");
    const result = await s.finish();
    assert.equal(result?.state, "refused");
    assert.match(JSON.stringify(result), /could not be read/);
    assert.equal(s.log.applied, 0);
  });

  /** One call with an agent-supplied target that claims a version, made under the given reading of the target's version; returns the result and how often the effect ran. */
  const once = async (c: DispatchWorld, read: () => Promise<string | undefined>, ms?: number) => {
    const ann = await c.agent("ann", workGrants(c.project, ["git-push"]));
    const { taskId } = await c.task("push", ann);
    const log = { applied: 0 };
    const out = deferred<ToolResult>();
    c.worker.script = async ({ gateway }) => {
      out.resolve(await (gateway as never as { call(r: unknown, e: unknown): Promise<ToolResult> }).call({ callId: "p", tool: { name: "git-push", version: "2.0" }, args: { branch: "main" }, target: { kind: "branch", id: "main", version: "agent-claims-this" } }, { kind: "effect", effectKind: "git-push", target: "repo", input: {}, bridge: bridge(log) }));
      return { status: "completed", text: "x" };
    };
    const d = c.restart({ targetVersion: read, ...(ms === undefined ? {} : { targetVersionMs: ms }) });
    await d.tick();
    const result = await out.promise;
    await d.idle();
    return { result, log, taskId };
  };

  suite("card A05b: a version that cannot be read when the approval is asked for refuses the call; no review is made and nothing runs", async (c) => {
    const { result, log, taskId } = await once(c, async () => { throw new Error("disk gone"); });
    assert.equal(result.state, "refused");
    assert.match(JSON.stringify(result), /could not be asked for.*could not be read/);
    assert.equal(log.applied, 0);
    assert.deepEqual(await c.reviews.reviewIdsForTask(taskId), [], "no review was asked for");
  });

  suite("card A05b: a reading of the version that never answers refuses the call within its limit (fail closed, not held forever)", async (c) => {
    const started = Date.now();
    const { result, log } = await once(c, () => new Promise<never>(() => undefined), 200);
    assert.equal(result.state, "refused");
    assert.match(JSON.stringify(result), /could not be read/);
    assert.equal(log.applied, 0);
    assert.ok(Date.now() - started < 60_000);
  });

  suite("card A05b: a reading that never answers just before the approval is used refuses the parked call; nothing runs", async (c) => {
    const ann = await c.agent("ann", workGrants(c.project, ["git-push"]));
    await c.task("push", ann);
    const log = { applied: 0 };
    const go = deferred();
    const parked = deferred<ToolResult>();
    let again: ToolResult | undefined;
    let hang = false;
    const call = (gateway: { call(r: never, e: never): Promise<ToolResult> }) => gateway.call({ callId: "push1", tool: { name: "git-push", version: "2.0" }, args: { branch: "main" } } as never, { kind: "effect", effectKind: "git-push", target: "repo", input: {}, bridge: bridge(log) } as never);
    c.worker.script = async ({ gateway }) => { parked.resolve(await call(gateway as never)); await go.promise; again = await call(gateway as never); return { status: "completed", text: "x" }; };
    const d = c.restart({ targetVersion: () => (hang ? new Promise<never>(() => undefined) : Promise.resolve("v1")), targetVersionMs: 200 });
    await d.tick();
    const first = await parked.promise;
    assert.equal(first.state, "awaiting-approval");
    const review = (await c.reviews.get(c.owner, (first as { reviewId: string }).reviewId))!;
    await c.reviews.decide(c.owner, { commandId: "dec", requestId: review.id, expectedRevision: review.revision, verdict: "allow", reason: "ok" });
    hang = true;
    go.resolve();
    await d.idle();
    assert.equal(again?.state, "refused");
    assert.match(JSON.stringify(again), /could not be read/);
    assert.equal(log.applied, 0);
    assert.equal((await c.reviews.get(c.owner, review.id))!.state, "approved", "nothing was used up");
  });

  suite("card A05b: the version the agent puts on its target is never taken: with no reading the review has none", async (c) => {
    const none = await once(c, async () => undefined);
    assert.equal(none.result.state, "awaiting-approval");
    const plain = (await c.reviews.get(c.owner, (none.result as { reviewId: string }).reviewId))!;
    assert.deepEqual(plain.operation.target, { kind: "branch", id: "main" }, "the agent's version is dropped");
  });

  suite("card A05b: the version the agent puts on its target is replaced by the controller's reading", async (c) => {
    const read = await once(c, async () => "v1");
    assert.equal(read.result.state, "awaiting-approval");
    const shown = (await c.reviews.get(c.owner, (read.result as { reviewId: string }).reviewId))!;
    assert.deepEqual(shown.operation.target, { kind: "branch", id: "main", version: "v1" });
  });

  suite("card A05b: a version the agent cannot name: the hook's malformed answer is refused, never recorded", async (c) => {
    const ann = await c.agent("ann", workGrants(c.project, ["git-push"]));
    await c.task("push", ann);
    const log = { applied: 0 };
    const out = deferred<ToolResult>();
    c.worker.script = async ({ gateway }) => {
      out.resolve(await (gateway as never as { call(r: unknown, e: unknown): Promise<ToolResult> }).call({ callId: "p", tool: { name: "git-push", version: "2.0" }, args: { branch: "main" }, target: { kind: "branch", id: "main", version: "agent-claims-this" } }, { kind: "effect", effectKind: "git-push", target: "repo", input: {}, bridge: bridge(log) }));
      return { status: "completed", text: "x" };
    };
    const d = c.restart({ targetVersion: async () => "not a version because spaces" });
    await d.tick(); await d.idle();
    const r = await out.promise;
    assert.notEqual(r.state, "awaiting-approval");
    assert.equal(log.applied, 0);
  });
}
