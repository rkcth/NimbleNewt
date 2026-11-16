import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ManualTimer } from "../dispatch/testing/timer.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

// T2: the controller as started (not a hand-built API) offers the owner's daily cap on its own model calls, and the status view reads it.
test("a started controller offers chat.budget.get and chat.budget.set to the owner only, and the status question reads the same cap", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-chatbud-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], dispatch: { timer: new ManualTimer(), manual: true } } as never);
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string): Promise<any> => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as never;
    assert.equal((await call(boot.token, "chat.budget.get", {})).result.item.maxTokensPerDay, null, "no cap by default");
    assert.ok((await call(boot.token, "chat.budget.set", { maxTokensPerDay: 750_000 }, "s1")).ok);
    assert.equal((await call(boot.token, "chat.budget.get", {})).result.item.maxTokensPerDay, 750_000);
    assert.equal((await call(boot.token, "chat.budget.set", { maxTokensPerDay: 750_000 }, "s1")).result.replayed, true);
    const asked = await call(boot.token, "status.ask", { request: { kind: "chat_budget" } });
    assert.ok(asked.ok, JSON.stringify(asked));
    assert.match(JSON.stringify(asked.result), /may use 750000 tokens a day/);
    await c.services.principals.enroll(await c.services.principals.authenticate(boot.token), { commandId: "e-ann", kind: "agent", name: "agt-abcdefghijklmnopqrst", grants: [{ action: "*", project: "*" }] });
    const ann = (await c.services.principals.issueCredential(await c.services.principals.authenticate(boot.token), "agent:agt-abcdefghijklmnopqrst")).token;
    assert.equal((await call(ann, "chat.budget.get", {})).error?.code, "forbidden");
    assert.equal((await call(ann, "chat.budget.set", { maxTokensPerDay: null }, "a1")).error?.code, "forbidden");
    assert.equal((await call(boot.token, "chat.budget.get", {})).result.item.maxTokensPerDay, 750_000, "the agent's refused call changed nothing");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
