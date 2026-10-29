import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("an agent reads the approval policy that binds it, fresh each time, for its own projects only (card U04b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-polctx-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [] });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const a = (await call(boot.token, "project.create", { name: "A" }, "p1")).result.id as string;
    const b = (await call(boot.token, "project.create", { name: "B" }, "p2")).result.id as string;
    await c.services.principals.enroll(rob, { commandId: "e1", kind: "agent", name: "ann", grants: [{ action: "attempt.work", project: a }] });
    const ann = (await c.services.principals.issueCredential(rob, "agent:ann")).token;
    const mine = await call(ann, "policy.context", { projectId: a });
    assert.ok(mine.ok, JSON.stringify(mine));
    assert.ok(mine.result.context !== null);
    assert.equal((await call(ann, "policy.context", { projectId: b })).result.context, null, "a project the agent holds nothing in reads like a missing one");
    assert.equal((await call(ann, "policy.context", { projectId: "proj-zzzzzzzzzzzzzzzzzzzz" })).result.context, null);
    assert.equal((await call(ann, "policy.context", { projectId: a, principal: "owner:rob" })).error.code, "invalid_command", "no asking about someone else");
    assert.ok((await call(boot.token, "policy.context", { projectId: b })).result.context !== null, "the owner may ask about any project");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
