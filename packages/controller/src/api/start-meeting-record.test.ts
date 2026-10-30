import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("a meeting held through the state API produces a record, a vote, a decision with its reason, and a summary readable by those allowed (card M02b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-mrec-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [] });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await call(boot.token, "project.create", { name: "Garden" }, "p1")).result.id as string;
    const tok = async (name: string, grants: { action: string; project: string }[]) => { await c.services.principals.enroll(rob, { commandId: `e-${name}`, kind: "agent", name, grants }); return (await c.services.principals.issueCredential(rob, `agent:${name}`)).token; };
    const ann = await tok("ann", [{ action: "task.read", project }, { action: "meeting.attend", project }]);
    const bob = await tok("bob", [{ action: "task.read", project }, { action: "meeting.attend", project }]);
    const zed = await tok("zed", [{ action: "task.read", project }]);

    const urgent = await call(boot.token, "meeting.call-urgent", { projectId: project, title: "Beds", reason: "frost tonight", roster: ["agent:ann", "agent:bob"] }, "mu1");
    assert.ok(urgent.ok, JSON.stringify(urgent));
    const opened = await call(boot.token, "meeting.record.open", { occurrenceId: urgent.result.id, chair: "agent:ann" }, "mo1");
    assert.ok(opened.ok, JSON.stringify(opened));
    const rec = opened.result.id as string;
    assert.equal((await call(zed, "meeting.record.open", { occurrenceId: urgent.result.id }, "mo2")).ok, false);
    for (const [t, id] of [[ann, "j1"], [bob, "j2"]] as const) assert.ok((await call(t, "meeting.record.join", { recordId: rec }, id)).ok, id);
    const said = await call(ann, "meeting.record.append", { recordId: rec, kind: "statement", text: "Frost is forecast for tonight." }, "ap1");
    assert.ok(said.ok && said.result.seq > 0, JSON.stringify(said));
    const motion = await call(ann, "meeting.record.move", { recordId: rec, text: "Cover the beds tonight." }, "mv1");
    assert.ok(motion.ok, JSON.stringify(motion));
    const mid = motion.result.id as string;
    const vote = await call(boot.token, "meeting.record.open-vote", { motionId: mid, expectedVersion: 1 }, "ov1");
    assert.ok(vote.ok, JSON.stringify(vote));
    assert.ok((await call(ann, "meeting.record.cast-ballot", { motionId: mid, version: 1, value: "yes", reason: "frost kills seedlings" }, "b1")).ok);
    assert.ok((await call(bob, "meeting.record.cast-ballot", { motionId: mid, version: 1, value: "yes", reason: "cheap to do" }, "b2")).ok);
    const hidden = await call(zed, "meeting.record.ballots", { motionId: mid });
    assert.notEqual(hidden.result?.item?.ballots?.length, 2, "a stranger does not read the ballots");
    const closed = await call(boot.token, "meeting.record.close-vote", { motionId: mid }, "cv1");
    assert.ok(closed.ok, JSON.stringify(closed));
    assert.equal(closed.result.state, "adopted");
    const decisionId = closed.result.decisionId as string;
    const why = await call(boot.token, "meeting.record.why", { decisionId });
    assert.ok(why.ok && why.result.item.lines.length > 0, JSON.stringify(why));
    assert.ok((await call(boot.token, "meeting.record.discussion", { recordId: rec })).result.item.entries.length >= 2);
    assert.ok((await call(boot.token, "meeting.record.finish", { recordId: rec }, "f1")).ok);
    assert.ok((await call(boot.token, "meeting.record.summarize", { recordId: rec }, "s1")).ok);
    const summary = await call(boot.token, "meeting.record.summary", { recordId: rec });
    assert.ok(summary.ok, JSON.stringify(summary));
    assert.equal((await call(zed, "meeting.record.summary", { recordId: rec })).error?.code ?? "hidden", (await call(zed, "meeting.record.get", { recordId: rec })).error?.code ?? "hidden");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a decision of a meeting that names a change to a task is applied once by the project service, as an agent that holds the right (card M02c)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-mrec-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [] });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await call(boot.token, "project.create", { name: "Garden" }, "p1")).result.id as string;
    const task = (await call(boot.token, "task.create", { projectId: project, title: "Cover beds" }, "t1")).result;
    const tok = async (name: string, grants: { action: string; project: string }[]) => { await c.services.principals.enroll(rob, { commandId: `e-${name}`, kind: "agent", name, grants }); return (await c.services.principals.issueCredential(rob, `agent:${name}`)).token; };
    const ann = await tok("ann", [{ action: "task.read", project }, { action: "meeting.attend", project }, { action: "task.update", project }]);
    const bob = await tok("bob", [{ action: "task.read", project }, { action: "meeting.attend", project }]);
    const urgent = await call(boot.token, "meeting.call-urgent", { projectId: project, title: "Beds", reason: "frost tonight", roster: ["agent:ann", "agent:bob"] }, "mu1");
    const rec = (await call(boot.token, "meeting.record.open", { occurrenceId: urgent.result.id, chair: "agent:ann" }, "mo1")).result.id as string;
    for (const [t, id] of [[ann, "j1"], [bob, "j2"]] as const) await call(t, "meeting.record.join", { recordId: rec }, id);
    const moved = await call(ann, "meeting.record.move", { recordId: rec, text: "Retitle the task to say it is urgent.", topic: "unrelated topic", changes: [{ kind: "task.update", agent: "agent:ann", target: { kind: "task", id: task.id }, expectedRevision: task.revision, patch: { title: "Cover beds tonight" }, summary: "retitle the task" }] }, "mv1");
    assert.ok(moved.ok, JSON.stringify(moved));
    const mid = moved.result.id as string;
    assert.ok((await call(boot.token, "meeting.record.open-vote", { motionId: mid, expectedVersion: 1 }, "ov1")).ok);
    for (const [t, id] of [[ann, "b1"], [bob, "b2"]] as const) assert.ok((await call(t, "meeting.record.cast-ballot", { motionId: mid, version: 1, value: "yes", reason: "agreed" }, id)).ok, id);
    const closed = await call(boot.token, "meeting.record.close-vote", { motionId: mid }, "cv1");
    assert.equal(closed.result.state, "adopted", JSON.stringify(closed));
    const applied = await call(boot.token, "meeting.record.apply", { decisionId: closed.result.decisionId }, "ap1");
    assert.equal(applied.result.applied, 1, JSON.stringify(applied));
    const after = await call(boot.token, "task.get", { taskId: task.id });
    assert.equal(after.result.item.title, "Cover beds tonight", JSON.stringify(after));
    const steps = (await call(boot.token, "activity.steps", { taskId: task.id })).result.steps as { kind: string; summary: string }[];
    assert.equal(steps.filter((x) => x.kind === "meeting-decision").length, 1, JSON.stringify(steps));
    assert.match(steps.find((x) => x.kind === "meeting-decision")!.summary, /changed this task/);
    // Applying again changes nothing: the decision applies once.
    await call(boot.token, "meeting.record.apply", { decisionId: closed.result.decisionId }, "ap2");
    assert.equal((await call(boot.token, "task.get", { taskId: task.id })).result.item.revision, after.result.item.revision);
    assert.equal(((await call(boot.token, "activity.steps", { taskId: task.id })).result.steps as { kind: string }[]).filter((x) => x.kind === "meeting-decision").length, 1, "the step is recorded once");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a statement citing a shared artifact is shown verified to a reader; one citing a desk record, or a missing record, is marked unverifiable and the citation is withheld (card M02e)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-mrec-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [] });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await call(boot.token, "project.create", { name: "Garden" }, "p1")).result.id as string;
    const seed = async (kind: string, id: string) => { await c.storage.applyOperation({ operationId: `seed-${kind}-${id}`, epoch: c.epoch, actor: "test", correlationId: `seed-${id}`, at: new Date().toISOString(), changes: [{ type: "create", ref: { kind, id }, body: { projectId: project, name: id } }], audit: [{ type: "seed", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never); };
    await seed("artifact", "art-bench");
    await seed("desk-record", "dsk-private");
    const tok = async (name: string, grants: { action: string; project: string }[]) => { await c.services.principals.enroll(rob, { commandId: `e-${name}`, kind: "agent", name, grants }); return (await c.services.principals.issueCredential(rob, `agent:${name}`)).token; };
    const ann = await tok("ann", [{ action: "task.read", project }, { action: "meeting.attend", project }]);
    const reader = await tok("reader", [{ action: "task.read", project }, { action: "meeting.read", project }]);
    const urgent = await call(boot.token, "meeting.call-urgent", { projectId: project, title: "Beds", reason: "frost tonight", roster: ["agent:ann"] }, "mu1");
    const rec = (await call(boot.token, "meeting.record.open", { occurrenceId: urgent.result.id, chair: "agent:ann" }, "mo1")).result.id as string;
    await call(ann, "meeting.record.join", { recordId: rec }, "j1");
    const say = async (text: string, id: string, sources: { kind: string; id: string }[]) => assert.ok((await call(ann, "meeting.record.append", { recordId: rec, kind: "statement", text, sources }, id)).ok, id);
    await say("The benchmark shows 35 minutes.", "a1", [{ kind: "artifact", id: "art-bench" }]);
    await say("My notes say Sundays fail.", "a2", [{ kind: "desk-record", id: "dsk-private" }]);
    await say("Some artifact that is not there.", "a3", [{ kind: "artifact", id: "art-missing" }]);
    const entries = (await call(reader, "meeting.record.discussion", { recordId: rec })).result.item.entries as { text: string; verifiable: boolean; sources?: unknown[] }[];
    const by = (t: string) => entries.find((e) => e.text === t)!;
    assert.equal(by("The benchmark shows 35 minutes.").verifiable, true);
    assert.equal(by("The benchmark shows 35 minutes.").sources?.length, 1);
    assert.equal(by("My notes say Sundays fail.").verifiable, false);
    assert.equal(by("My notes say Sundays fail.").sources, undefined);
    assert.equal(by("Some artifact that is not there.").verifiable, false);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
