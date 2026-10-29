import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("activity steps, explanations, corrections and unavailable ranges work through the state API with rights (card C09b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-activity-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [] });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await call(boot.token, "project.create", { name: "Garden" }, "p1")).result.id as string;
    const task = (await call(boot.token, "task.create", { projectId: project, title: "weed" }, "t1")).result.id as string;
    const tok = async (name: string, grants: { action: string; project: string }[]) => { await c.services.principals.enroll(rob, { commandId: `e-${name}`, kind: "agent", name, grants }); return (await c.services.principals.issueCredential(rob, `agent:${name}`)).token; };
    const ann = await tok("ann", [{ action: "attempt.work", project }]);
    const aud = await tok("aud", [{ action: "history.read", project }]);
    const zed = await tok("zed", [{ action: "task.read", project }]);

    const one = await call(ann, "activity.record", { taskId: task, kind: "tool-call", summary: "ran the tests", manifest: { refs: [{ kind: "record", id: "dsk-1" }] }, payload: { text: "ok, key sk-live-ABCDEFGHIJKLMNOPQRSTUVWX1234" } }, "a1");
    assert.deepEqual([one.ok, one.result.seq], [true, 1], JSON.stringify(one));
    assert.equal((await call(zed, "activity.record", { taskId: task, kind: "lifecycle", summary: "x" }, "a2")).error.code, "forbidden");
    const steps = (await call(aud, "activity.steps", { taskId: task })).result.steps;
    assert.deepEqual([steps.length, steps[0].kind, steps[0].payload.state], [1, "tool-call", "stored"]);
    assert.equal((await call(zed, "activity.steps", { taskId: task })).error.code, "not_found");
    assert.doesNotMatch((await call(aud, "activity.payload", { taskId: task, seq: 1 })).result.payload.text, /sk-live/);
    assert.equal((await call(ann, "activity.payload", { taskId: task, seq: 1 })).error.code, "not_found", "sensitive content is not for the one who wrote it, only for history readers");

    const ex = { taskId: task, seq: 1, choice: "run the unit tests first", alternatives: [{ option: "run everything", whyNot: "too slow" }], evidence: [{ statement: "unit tests cover the change" }], uncertainty: "integration may differ" };
    assert.ok((await call(ann, "activity.explain", ex, "x1")).ok);
    assert.equal((await call(ann, "activity.explain", { ...ex, reasoning: "let me think" }, "x2")).error.code, "invalid_command");
    const later = await call(aud, "activity.explain-later", { taskId: task, seq: 1 }, "l1");
    assert.deepEqual([later.result.explanation.mode, later.result.explanation.grounded], ["retrospective", true]);
    assert.equal((await call(aud, "activity.explanations", { taskId: task, seq: 1 })).result.items.length, 1);

    assert.equal((await call(ann, "activity.correct", { taskId: task, seq: 1, note: "x" }, "k0")).error.code, "forbidden");
    assert.ok((await call(boot.token, "activity.correct", { taskId: task, seq: 1, note: "ran on the old checkout" }, "k1")).ok);
    assert.equal((await call(aud, "activity.steps", { taskId: task })).result.steps[0].corrections, 1);
    assert.equal((await call(aud, "activity.unavailable", { taskId: task, first: 1, last: 1, reason: "x" }, "u0")).error.code, "forbidden");
    assert.ok((await call(boot.token, "activity.unavailable", { taskId: task, first: 1, last: 1, reason: "archived" }, "u1")).ok);
    assert.deepEqual((await call(aud, "activity.steps", { taskId: task })).result.steps, [{ seq: 1, unavailable: "archived" }]);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
