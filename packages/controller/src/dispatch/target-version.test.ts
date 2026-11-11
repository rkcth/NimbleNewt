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
