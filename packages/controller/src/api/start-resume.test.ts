import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const DIGEST = `v1:sha256:${"a".repeat(64)}`;
const capture = (decisions: string[]) => ({
  identity: "conv-1", agent: "agent:ann", boundary: { kind: "turn-complete" as const }, checkpoint: { format: 2, conversationId: 7, at: 41, digest: DIGEST, runtime: { name: "pi-durable", version: "1.3.0" } }, durable: { verified: true },
  continuation: { artifacts: [], decisions, pendingEffects: [], budget: { spent: 1, remaining: 9, unit: "k-tokens" }, nextStep: "run the tests" },
  manifest: { summaryLineage: [], sourceRanges: [{ source: "history", from: 1, to: 41 }], compression: { state: "none" as const, compactions: 0 }, branches: [], messageCursor: 41, routingRevision: 1, environmentRevision: 1, adapter: { name: "pi-durable", version: "1.3.0" } },
  nonCheckpointableTools: [], scratchRecords: [], credentialRefs: [],
});

test("a task is resumed through the state API only after a check: collected, verified, reviewed, committed once; missing context blocks it with a blocker (card L04b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-resume-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [] });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await call(boot.token, "project.create", { name: "Garden" }, "p1")).result.id as string;
    const task = (await call(boot.token, "task.create", { projectId: project, title: "weed" }, "t1")).result.id as string;
    await c.services.principals.enroll(rob, { commandId: "e-host", kind: "host", name: "h1", grants: [] });
    const host = await c.services.principals.authenticate((await c.services.principals.issueCredential(rob, "host:h1")).token);
    await c.services.principals.enroll(rob, { commandId: "e-zed", kind: "agent", name: "zed", grants: [{ action: "task.read", project }] });
    const zed = (await c.services.principals.issueCredential(rob, "agent:zed")).token;
    const model = { provider: "local", id: "m1" };

    // Nothing captured: blocked, with a blocker the owner can see.
    const none = await call(boot.token, "resume.start", { taskId: task, model, after: "restart" }, "r0");
    assert.deepEqual([none.result.item.phase, none.result.item.blocked.type], ["blocked", "missing_context"]);
    assert.equal((await call(boot.token, "resume.cancel", { checkId: none.result.item.id }, "r0c")).result.item.phase, "cancelled");

    await c.services.continuations.capture(host, { commandId: "cap1", taskId: task, ...capture([]) });
    const s = await call(boot.token, "resume.start", { taskId: task, model, after: "restart" }, "r1");
    assert.ok(s.ok, JSON.stringify(s));
    assert.equal(s.result.item.phase, "ready");
    assert.equal(s.result.item.revisionSet.unverified, true, "with nothing recorded nothing is called unchanged");
    assert.equal((await call(zed, "resume.get", { checkId: s.result.item.id })).error.code, "not_found");
    assert.equal((await call(zed, "resume.commit", { checkId: s.result.item.id }, "z1")).error.code, "not_found");
    const done = await call(boot.token, "resume.commit", { checkId: s.result.item.id, restoredBy: "reconstruction", limits: ["tool effects are not reproduced"] }, "r2");
    assert.equal(done.result.item.phase, "done", JSON.stringify(done));
    assert.equal(done.result.item.restore.method, "reconstruction");

    // A continuation naming a decision that is gone cannot be resumed from.
    await c.services.continuations.capture(host, { commandId: "cap2", taskId: task, ...capture(["dsk-aaaaaaaaaaaaaaaaaaaa"]) });
    const gone = await call(boot.token, "resume.start", { taskId: task, model, after: "continue" }, "r3");
    assert.equal(gone.result.item.blocked.type, "missing_context");
    assert.match(gone.result.item.blocked.reason, /decision dsk-aaaaaaaaaaaaaaaaaaaa/);
    assert.equal((await call(boot.token, "resume.sweep", {}, "sw")).ok, true);
    assert.equal((await call(zed, "resume.sweep", {}, "sw2")).error.code, "forbidden");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
