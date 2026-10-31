import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { CHAT_OPS } from "../chat/index.js";
import { OPERATION_BY_NAME } from "./operations.js";
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
    assert.equal((await call(aud, "activity.payload", { taskId: task, seq: 1 })).error.code, "not_found", "a project-wide history.read does not read sensitive content");
    const deep = await tok("dee", [{ action: "history.read", project }, { action: "history.sensitive.read", project }]);
    assert.doesNotMatch((await call(deep, "activity.payload", { taskId: task, seq: 1 })).result.payload.text, /sk-live/);
    assert.equal((await call(ann, "activity.payload", { taskId: task, seq: 1 })).error.code, "not_found", "sensitive content is not for the one who wrote it, only for history readers");

    const ex = { taskId: task, seq: 1, choice: "run the unit tests first", alternatives: [{ option: "run everything", whyNot: "too slow" }], evidence: [{ statement: "unit tests cover the change" }], uncertainty: "integration may differ" };
    assert.ok((await call(ann, "activity.explain", ex, "x1")).ok);
    assert.equal((await call(ann, "activity.explain", { ...ex, reasoning: "let me think" }, "x2")).error.code, "invalid_command");
    assert.equal((await call(aud, "activity.explain-later", { taskId: task, seq: 1 }, "l0")).error.code, "forbidden", "a reader of the history cannot add an explanation");
    const later = await call(ann, "activity.explain-later", { taskId: task, seq: 1 }, "l1");
    assert.deepEqual([later.result.explanation.mode, later.result.explanation.grounded], ["retrospective", true]);
    assert.equal((await call(aud, "activity.explanations", { taskId: task, seq: 1 })).result.items.length, 1);

    assert.equal((await call(ann, "activity.correct", { taskId: task, seq: 1, note: "x" }, "k0")).error.code, "forbidden");
    // paging the whole-task listing
    assert.equal((await call(aud, "activity.explanations", { taskId: task, limit: 0 })).error.code, "invalid_command");
    assert.equal((await call(aud, "activity.explanations", { taskId: task, limit: 101 })).error.code, "invalid_command");
    assert.equal((await call(aud, "activity.explanations", { taskId: task, after: -1 })).error.code, "invalid_command");
    assert.equal((await call(aud, "activity.explanations", { taskId: task, after: "1" })).error.code, "invalid_command");
    assert.equal((await call(zed, "activity.explanations", { taskId: task })).error.code, (await call(zed, "activity.explanations", { taskId: task, limit: 1 })).error.code, "no right, same refusal");
    const e1 = await call(aud, "activity.explanations", { taskId: task, limit: 1 });
    assert.deepEqual([e1.ok, e1.result.items.length, e1.result.next], [true, 1, 1], JSON.stringify(e1));
    const e2 = await call(aud, "activity.explanations", { taskId: task, after: e1.result.next, limit: 1 });
    assert.deepEqual([e2.result.items.length, e2.result.next], [1, undefined]);
    assert.notDeepEqual(e1.result.items[0], e2.result.items[0]);
    assert.equal((await call(aud, "activity.explanations", { taskId: task })).result.items.length, 2);
    assert.ok((await call(boot.token, "activity.correct", { taskId: task, seq: 1, note: "ran on the old checkout" }, "k1")).ok);
    assert.equal((await call(aud, "activity.steps", { taskId: task })).result.steps[0].corrections, 1);
    const cor = await call(aud, "activity.corrections", { taskId: task, seq: 1 });
    assert.deepEqual([cor.ok, cor.result.items.length, cor.result.items[0].note, cor.result.next], [true, 1, "ran on the old checkout", undefined], JSON.stringify(cor));
    assert.equal((await call(zed, "activity.corrections", { taskId: task, seq: 1 })).error.code, "not_found", "no history right, no corrections");
    assert.equal((await call(aud, "activity.corrections", { taskId: task, seq: 1, limit: 101 })).error.code, "invalid_command");
    assert.equal((await call(aud, "activity.corrections", { taskId: task, seq: 1, after: -1 })).error.code, "invalid_command");
    assert.ok((await call(boot.token, "activity.correct", { taskId: task, seq: 1, note: "second note" }, "k2")).ok);
    const p1 = await call(aud, "activity.corrections", { taskId: task, seq: 1, limit: 1 });
    assert.deepEqual([p1.result.items.length, p1.result.next], [1, 1]);
    const p2 = await call(aud, "activity.corrections", { taskId: task, seq: 1, after: p1.result.next, limit: 1 });
    assert.deepEqual([p2.result.items[0].note, p2.result.next], ["second note", undefined]);
    assert.equal((await call(aud, "activity.unavailable", { taskId: task, first: 1, last: 1, reason: "x" }, "u0")).error.code, "forbidden");
    assert.ok((await call(boot.token, "activity.unavailable", { taskId: task, first: 1, last: 1, reason: "archived" }, "u1")).ok);
    assert.deepEqual((await call(aud, "activity.steps", { taskId: task })).result.steps, [{ seq: 1, unavailable: "archived" }]);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("replay through the state API: a task credential replays its own task only, the read bounds are chat-settable, and the status view is documented (card U09)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-replay-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [] });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await call(boot.token, "project.create", { name: "Garden" }, "p1")).result.id as string;
    const mine = (await call(boot.token, "task.create", { projectId: project, title: "weed" }, "t1")).result.id as string;
    const sibling = (await call(boot.token, "task.create", { projectId: project, title: "water" }, "t2")).result.id as string;
    await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "agt-abcdefghijklmnopqrst", grants: [{ action: "history.read", project }, { action: "task.read", project }, { action: "attempt.work", project }] });
    const cred = (await c.services.taskCredentials.issue(rob, { commandId: "tc1", taskId: mine, agentId: "agent:agt-abcdefghijklmnopqrst" })).token;
    for (const t of [mine, sibling]) assert.ok((await call(boot.token, "activity.record", { taskId: t, kind: "owner-message", summary: `note on ${t}` }, `r-${t}`)).ok);
    // Its own task: allowed. A sibling task of the same project: forbidden, for every replay read and the raw reads.
    assert.ok((await call(cred, "activity.replay.open", { taskId: mine })).ok);
    assert.ok((await call(cred, "activity.replay.step", { taskId: mine, seq: 1 })).ok);
    assert.ok((await call(cred, "activity.explanations", { taskId: mine })).ok);
    for (const [op, args] of [["activity.replay.open", {}], ["activity.replay.step", { seq: 1 }], ["activity.replay.led", { seq: 1 }], ["activity.replay.search", { query: "note" }], ["activity.replay.export", {}], ["activity.steps", {}], ["activity.payload", { seq: 1 }], ["activity.explanations", {}], ["activity.corrections", { seq: 1 }], ["activity.explain-later", { seq: 1 }]] as [string, Record<string, unknown>][]) {
      assert.equal((await call(cred, op, { taskId: sibling, ...args })).error?.code, "forbidden", op);
    }
    assert.ok((await call(boot.token, "activity.replay.open", { taskId: sibling })).ok, "the owner replays any task");
    // The read bounds: owner only, chat-settable (set, enable, disable), race-safe.
    const g0 = (await call(boot.token, "replay.limits.get", {})).result.item;
    assert.deepEqual([g0.revision, g0.enabled, g0.values.scan], [0, true, 50000]);
    assert.equal((await call(cred, "replay.limits.get", {})).error?.code, "forbidden");
    assert.equal((await call(cred, "replay.limits.set", { scan: 3 }, "ls0")).error?.code, "forbidden");
    const off = await call(boot.token, "replay.limits.disable", { expectedRevision: 0 }, "ls1");
    assert.ok(off.ok, JSON.stringify(off));
    assert.equal((await call(boot.token, "replay.limits.set", { scan: 3, expectedRevision: 0 }, "ls2")).error?.code, "stale_revision");
    assert.ok((await call(boot.token, "replay.limits.enable", { expectedRevision: off.result.revision }, "ls3")).ok);
    assert.equal((await call(boot.token, "replay.limits.get", {})).result.item.enabled, true);
    // Every one is a chat command (the owner can enable, disable and change them by chat), and each is a state-API operation.
    for (const op of ["replay.limits.set", "replay.limits.enable", "replay.limits.disable"]) { assert.equal(CHAT_OPS[op]?.mode, "apply", op); assert.ok(OPERATION_BY_NAME.has(op), op); }
    // The status view is part of the documented question (the interpreter reads this summary to produce { kind: "replay" }).
    const doc = OPERATION_BY_NAME.get("status.ask")!.summary;
    assert.match(doc, /`replay`/);
    assert.match(doc, /kind: "replay", taskId/);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true }); }
});
