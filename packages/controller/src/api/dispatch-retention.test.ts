import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import type { RuntimeGuards, WorkerHost } from "../dispatch/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import { startController } from "./index.js";
import { DISPATCH_KIND } from "../dispatch/index.js";
import { derivedId } from "../domain/ids.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("the relay of an attempt with no time limit is kept past 24 hours, as long as the attempt is live (it was dropped and rebuilt at a day)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-retain-"));
  let now = Date.parse("2026-10-30T09:00:00.000Z");
  let relays: ((o: object) => unknown) | undefined;
  const worker = { hostId: "host:w1" } as unknown as WorkerHost;
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: { timer: new ManualTimer(), manual: true, clock: () => new Date(now).toISOString(), local: { acceptUnenforcedLimits: true, window: () => 8192, close: async () => undefined, build: (services: Parameters<NonNullable<NonNullable<NonNullable<Parameters<typeof startController>[0]["dispatch"]>["local"]>["build"]>>[0]) => {
      relays = (o) => services.attemptRelay(o as never, { forAttempt: () => ({ alias: "m0", relayBase: "x", relay: async () => { throw new Error("x"); } }) } as never);
      void ({} as RuntimeGuards); return worker; } } },
  } as never);
  try {
    // Valid attempt IDs (the dispatcher answers only for those): one live attempt, one that is finished.
    const live = "att-aaaaaaaaaaaaaaaaaaaa", over = "att-bbbbbbbbbbbbbbbbbbbb";
    for (const [id, state] of [[live, "running"], [over, "finished"]] as const) {
      await c.storage.applyOperation({ operationId: `mk-${id}`, epoch: c.epoch, actor: "owner:rob", correlationId: id, at: new Date().toISOString(), changes: [{ type: "create", ref: { kind: DISPATCH_KIND, id: derivedId("dpa", id) }, body: { attemptId: id, state, taskId: "task-aaaaaaaaaaaaaaaaaaaa", projectId: "proj-aaaaaaaaaaaaaaaaaaaa", agentId: "agt-aaaaaaaaaaaaaaaaaaaa" } }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
    }
    const first = relays!({ attemptId: live, route: "llama/local" }); // no expiresAt
    const firstOver = relays!({ attemptId: over, route: "llama/local" });
    now += 48 * 3_600_000;
    relays!({ attemptId: live, route: "llama/local" }); // starts the sweep
    await new Promise((r) => setTimeout(r, 200)); // the sweep asks the dispatcher and forgets asynchronously
    assert.equal(relays!({ attemptId: live, route: "llama/local" }), first, "the same relay two days on while the attempt is live");
    assert.notEqual(relays!({ attemptId: over, route: "llama/local" }), firstOver, "an attempt that finished is forgotten by the sweep (so the sweep did run)");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
