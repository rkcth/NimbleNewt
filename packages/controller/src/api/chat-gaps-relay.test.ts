import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BudgetService } from "../budgets/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { ModelRelay } from "../dispatch/relay.js";
import type { WorkerHost } from "../dispatch/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("the model relay stops a paid call once the owner's aggregate spending cap is reached, and lets a local route through (chat gaps)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-capgate-"));
  let services: Parameters<Parameters<NonNullable<NonNullable<Parameters<typeof startController>[0]["dispatch"]>["local"]>["build"]>[0] extends infer S ? (s: S) => void : never>[0] | undefined;
  const calls: string[] = [];
  const fetch: typeof globalThis.fetch = async (url) => { calls.push(String(url)); return new Response("{}", { status: 200 }); };
  const relay = new ModelRelay({ endpoint: (route) => (route === "cloud/big" ? { url: "https://cloud.example/v1/" } : route === "llama/local" ? { url: "http://llama.internal:8080/v1/" } : undefined), fetch });
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: { timer: new ManualTimer(), manual: true, local: { window: () => 8192, close: async () => undefined, build: (s) => { services = s as never; return { hostId: "host:w1" } as unknown as WorkerHost; } } },
  });
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const rob = await c.services.principals.authenticate((await c.services.principals.bootstrapOwner({ name: "rob" })).token);
    const table = { providers: { llama: { enabled: true, paid: false, location: "local" }, other: { enabled: true, paid: false, location: "local" }, cloud: { enabled: true, paid: true, location: "cloud" } }, routes: { "llama/local": { contextTokens: 8192, capabilities: [] }, "other/backup": { contextTokens: 8192, capabilities: [] }, "cloud/big": { contextTokens: 8192, capabilities: [] } }, profiles: { fast: ["llama/local", "other/backup"] }, roles: { coordinator: "fast", "safety-supervisor": "fast" } };
    await c.services.routing.setTable(rob, { commandId: "tbl", expectedRevision: 0, table } as never);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const task = (await c.services.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Build" })).id;
    const budgets = BudgetService.withEpoch(c.storage, c.epoch);
    await budgets.open(rob, { commandId: "bo", taskId: task, currency: "USD", costMicros: 1_000_000 });
    const send = async (attemptId: string, route: string) => {
      const attempt = services!.attemptRelay({ attemptId, taskId: task, projectId: project, agentId: "ann", generation: 1, route, expiresAt: "2999-01-01T00:00:00.000Z" } as never, relay);
      return attempt.relay({ url: `${attempt.relayBase}/${attempt.alias}/chat/completions`, method: "POST", headers: [["content-type", "application/json"]], body: Buffer.from("{}"), signal: new AbortController().signal } as never);
    };
    // No cap: a paid call goes out.
    assert.equal((await send("att-1", "cloud/big")).status, 200);
    await budgets.setAggregate(rob, { commandId: "cap", enabled: true, scope: "installation", period: "none", amountMicros: 1000 });
    await budgets.charge(rob, { commandId: "ch", activity: "model-call", taskId: task, agentId: "agent:ann", costMicros: 1500 });
    const before = calls.length;
    await assert.rejects(() => send("att-2", "cloud/big"), /the model relay refused the call: .*aggregate cap is reached/);
    assert.equal(calls.length, before, "the paid call was never sent");
    // A free (local) route is not money: it goes through.
    assert.equal((await send("att-3", "llama/local")).status, 200);
    // Turned off: paid calls go out again.
    await budgets.setAggregate(rob, { commandId: "cap2", enabled: false });
    assert.equal((await send("att-4", "cloud/big")).status, 200);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
