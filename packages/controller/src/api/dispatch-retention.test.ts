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

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("the relay of an attempt with no time limit is kept past 24 hours, as long as the attempt is live (it was dropped and rebuilt at a day)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-retain-"));
  let now = Date.parse("2026-10-30T09:00:00.000Z");
  let relays: ((o: object) => unknown) | undefined;
  const worker = { hostId: "host:w1" } as unknown as WorkerHost;
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: { timer: new ManualTimer(), manual: true, clock: () => new Date(now).toISOString(), local: { window: () => 8192, close: async () => undefined, build: (services: Parameters<NonNullable<NonNullable<NonNullable<Parameters<typeof startController>[0]["dispatch"]>["local"]>["build"]>>[0]) => {
      relays = (o) => services.attemptRelay(o as never, { forAttempt: () => ({ alias: "m0", relayBase: "x", relay: async () => { throw new Error("x"); } }) } as never);
      void ({} as RuntimeGuards); return worker; } } },
  } as never);
  try {
    const order = { attemptId: "att-unlimited", route: "llama/local" }; // no expiresAt
    const first = relays!(order);
    now += 48 * 3_600_000;
    assert.equal(relays!(order), first, "the same relay two days on");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
