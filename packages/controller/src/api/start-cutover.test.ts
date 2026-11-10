import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const provider = (location: "local" | "cloud") => ({ enabled: true, paid: location === "cloud", location });
const route = { contextTokens: 100_000, capabilities: ["tools"] };
const table = {
  providers: { strata: provider("local"), openrouter: provider("cloud") },
  routes: { "strata/qwen": route, "openrouter/qwen": route },
  profiles: { main: ["strata/qwen", "openrouter/qwen"] },
  roles: { coordinator: "main", "safety-supervisor": "main" },
};
const topology = { services: ["strata-svc"], targets: { "strata/qwen": { endpoint: "strata-http", account: "local-acct", service: "strata-svc" }, "openrouter/qwen": { endpoint: "or-api", account: "or-acct" } }, aliases: {} };

test("the owner disables, drains, cuts over and re-enables a target through the state API, and it survives a restart (card R04b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-cut-"));
  const open = () => startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4 });
  try {
    const first = await open();
    const boot = await first.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await first.services.principals.authenticate(boot.token);
    await first.services.routing.setTable(rob, { commandId: "t1", expectedRevision: 0, table });
    await first.services.cutover.setTopology(rob, { commandId: "o1", expectedRevision: 0, topology });
    await first.services.principals.enroll(rob, { commandId: "e1", kind: "agent", name: "zed", grants: [{ action: "task.read", project: "*" }] });
    const zed = (await first.services.principals.issueCredential(rob, "agent:zed")).token;
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => first.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string; message: string } }>;

    const off = await call(boot.token, "routing.disable", { level: "endpoint", name: "strata-http", reason: "disk swap" }, "d1");
    assert.equal(off.ok, true, JSON.stringify(off));
    assert.equal((await call(boot.token, "routing.disable", { level: "endpoint", name: "strata-http", reason: "disk swap" }, "d1")).result.replayed, true);
    const controls = (await call(boot.token, "routing.controls", {})).result.controls;
    assert.equal(controls.entries.length, 1);
    const report = (await call(boot.token, "routing.report", { level: "endpoint", name: "strata-http" })).result.report;
    assert.deepEqual([report.routingApplied, report.inFlightRemaining, report.safeToStop], [true, 0, true]);
    // Only the owner controls routing.
    for (const [op, args] of [["routing.disable", { level: "endpoint", name: "or-api", reason: "x" }], ["routing.cutover", { level: "endpoint", name: "or-api", reason: "x" }], ["routing.controls", {}], ["routing.failback.set", { policy: { mode: "manual", minProbes: 1, stableSeconds: 0, holdDownSeconds: 0 } }]] as const) {
      const r = await call(zed, op, args as never, op === "routing.controls" ? undefined : "z-" + op);
      assert.equal(r.ok, false, op);
      assert.ok(["forbidden", "not_found"].includes(r.error!.code), `${op}: ${r.error?.code}`);
    }
    assert.equal((await call(boot.token, "routing.drain", { level: "account", name: "or-acct", reason: "billing", drainSeconds: 600 }, "d2")).ok, true);
    const cut = await call(boot.token, "routing.cutover", { level: "service", name: "strata-svc", reason: "restart the engine" }, "d3");
    assert.deepEqual([cut.ok, cut.result?.cancelled], [true, []]);
    assert.equal((await call(boot.token, "routing.failback.set", { policy: { mode: "manual", minProbes: 2, stableSeconds: 60, holdDownSeconds: 300 } }, "d4")).ok, true);
    await first.close();

    const second = await open();
    const again = (await second.api.handle(boot.token, { v: 1, op: "routing.controls", args: {} } as never)) as any;
    assert.equal(again.result.controls.entries.length, 3, "the controls survived the restart");
    assert.equal(again.result.controls.failback.mode, "manual");
    const lift = (await second.api.handle(boot.token, { v: 1, op: "routing.reenable", commandId: "d5", args: { level: "endpoint", name: "strata-http", reason: "done" } } as never)) as any;
    assert.equal(lift.ok, true, JSON.stringify(lift));
    assert.equal(((await second.api.handle(boot.token, { v: 1, op: "routing.controls", args: {} } as never)) as any).result.controls.entries.length, 2);
    await second.close();
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("the owner sets a route's reply limit and reasoning cap through the state API and reads them in the routing view, which says nothing new for a route without them (card W07)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-rbud-"));
  try {
    const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4 });
    try {
      const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
      const rob = await c.services.principals.authenticate(boot.token);
      await c.services.routing.setTable(rob, { commandId: "t1", expectedRevision: 0, table });
      const call = (op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string; message: string } }>;
      const view = async (): Promise<string> => (await call("status.ask", { request: { kind: "model_routes" } })).result.item.lines.map((l: { text: string }) => l.text).join("\n");
      assert.match(await view(), /No route has a reply limit or a reasoning cap: each model call asks for what the agent's runtime decides\./);
      const set = await call("routing.budget.set", { route: "strata/qwen", maxTokens: 8000, reasoningTokens: 2000 }, "b1");
      assert.equal(set.ok, true, JSON.stringify(set));
      assert.deepEqual(set.result.budget, { maxTokens: 8000, reasoningTokens: 2000 });
      const bad = await call("routing.budget.set", { route: "strata/qwen", maxTokens: 0 }, "b2");
      assert.deepEqual([bad.ok, bad.error?.code], [false, "invalid_command"]);
      assert.deepEqual((await call("routing.budgets", {})).result.routes, [{ route: "openrouter/qwen", contextTokens: 100_000 }, { route: "strata/qwen", contextTokens: 100_000, maxTokens: 8000, reasoningTokens: 2000 }]);
      const lines = await view();
      assert.match(lines, /1 route\(s\) have a reply limit or a reasoning cap \(a reply cut off at its limit is continued with a nudge to stop deliberating and act\):/);
      assert.match(lines, /strata\/qwen: replies at most 8000 tokens, reasoning at most 2000 tokens \(no endpoint kind is configured on the controller for this route: on an OpenAI-style endpoint the figures are sent only if the host names the kind; when they are not sent, the task's activity says so\)\./, "the owner can tell why a budget may do nothing");
      assert.doesNotMatch(lines, /openrouter\/qwen:/, "a route without a budget is not listed");
    } finally { await c.close(); }
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
