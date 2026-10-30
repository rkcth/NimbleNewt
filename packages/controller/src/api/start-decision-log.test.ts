import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BudgetService } from "../budgets/budgets.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const boot = (path: string) => startController({ storage: { kind: "sqlite", path }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [] });

/** The meeting decision log through the real controller (card M02f): two budget raises adopted in one meeting, agreed by the owner, logged once each, read through `meeting.decisions.log`. */
test("meeting.decisions.log: the owner reads one line per carried-out change, an agent is refused, pages work, and a replay or a restart writes nothing twice", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-dlog-"));
  const path = join(d, "c.sqlite");
  let c = await boot(path);
  try {
    const bootRes = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(bootRes.token);
    const owner = bootRes.token;
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await call(owner, "project.create", { name: "Garden" }, "p1")).result.id as string;
    const tasks: { id: string; revision: number }[] = [];
    for (const [i, title] of ["Cover beds", "Water beds"].entries()) {
      const t = (await call(owner, "task.create", { projectId: project, title }, `t${i}`)).result;
      await BudgetService.withEpoch(c.storage, c.epoch, {}).open(rob, { commandId: `bo${i}`, taskId: t.id, currency: "USD", costMicros: 1_000_000 });
      tasks.push(t);
    }
    const tok = async (name: string, grants: { action: string; project: string }[]) => { await c.services.principals.enroll(rob, { commandId: `e-${name}`, kind: "agent", name, grants }); return (await c.services.principals.issueCredential(rob, `agent:${name}`)).token; };
    const ann = await tok("ann", [{ action: "task.read", project }, { action: "meeting.attend", project }, { action: "budget.manage", project }]);
    const bob = await tok("bob", [{ action: "task.read", project }, { action: "meeting.attend", project }]);
    const changes = tasks.map((t, i) => ({ kind: "budget.raise", agent: "agent:ann", target: { kind: "task", id: t.id }, expectedRevision: t.revision, patch: { costMicros: 500_000 * (i + 1) }, summary: `raise budget ${i}` }));
    const urgent = await call(owner, "meeting.call-urgent", { projectId: project, title: "Money", reason: "frost", roster: ["agent:ann", "agent:bob"] }, "mu1");
    const rec = (await call(owner, "meeting.record.open", { occurrenceId: urgent.result.id, chair: "agent:ann" }, "mo1")).result.id as string;
    for (const [t, id] of [[ann, "j1"], [bob, "j2"]] as const) await call(t, "meeting.record.join", { recordId: rec }, id);
    const moved = await call(ann, "meeting.record.move", { recordId: rec, text: "Raise both.", topic: "unrelated topic", changes }, "mv1");
    assert.ok(moved.ok, JSON.stringify(moved));
    const mid = moved.result.id as string;
    assert.ok((await call(owner, "meeting.record.open-vote", { motionId: mid, expectedVersion: 1 }, "ov1")).ok);
    for (const [t, id] of [[ann, "b1"], [bob, "b2"]] as const) assert.ok((await call(t, "meeting.record.cast-ballot", { motionId: mid, version: 1, value: "yes", reason: "agreed" }, id)).ok, id);
    const closed = await call(owner, "meeting.record.close-vote", { motionId: mid }, "cv1");
    assert.equal(closed.result.state, "adopted", JSON.stringify(closed));
    const decisionId = closed.result.decisionId as string;
    const logOp = (token: string, args: Record<string, unknown> = {}) => call(token, "meeting.decisions.log", args);

    // Nothing is carried out and nothing logged while the decision waits for the owner.
    assert.equal((await call(owner, "meeting.record.apply", { decisionId }, "ap0")).result.waitingFor, "owner");
    assert.deepEqual((await logOp(owner)).result.item.entries, []);
    const agreed = await call(owner, "meeting.record.owner-respond", { decisionId, response: "agree" }, "or1");
    assert.ok(agreed.ok, JSON.stringify(agreed));
    assert.equal(agreed.result.applied, 2);

    const first = await logOp(owner);
    assert.ok(first.ok, JSON.stringify(first));
    const entries = first.result.item.entries as any[];
    assert.equal(entries.length, 2);
    for (const e of entries) {
      assert.deepEqual([e.kind, e.outcome, e.decidedBy, e.agreedBy, e.widens, e.projectId, e.decisionId], ["budget.raise", "applied", "owner", "owner:agreed", "spend", project, decisionId]);
      assert.match(e.patchHash, /^[0-9a-f]{64}$/);
      assert.doesNotMatch(JSON.stringify(e), /raise budget/, "no words of the change");
    }
    assert.deepEqual(entries.map((e) => e.counters.costMicros as number).sort((a, b) => a - b), [500_000, 1_000_000]);

    // An agent (even one holding every meeting right) is refused.
    for (const t of [ann, bob]) { const r = await logOp(t); assert.equal(r.ok, false); assert.equal(r.error.code, "forbidden"); }

    // Paging with a cursor, limits and filters.
    const p1 = (await logOp(owner, { limit: 1 })).result.item;
    assert.equal(p1.entries.length, 1);
    assert.ok(p1.next);
    const p2 = (await logOp(owner, { limit: 1, after: p1.next })).result.item;
    assert.equal(p2.entries.length, 1);
    assert.equal(p2.next, undefined);
    assert.notEqual(p1.entries[0].id, p2.entries[0].id);
    assert.equal((await logOp(owner, { limit: 0 })).ok, false);
    assert.equal((await logOp(owner, { limit: 101 })).ok, false);
    assert.equal((await logOp(owner, { kind: "grant.add" })).result.item.entries.length, 0);
    assert.equal((await logOp(owner, { outcome: "applied", projectId: project })).result.item.entries.length, 2);
    assert.equal((await logOp(owner, { outcome: "declined" })).result.item.entries.length, 0);

    // A replay writes nothing more, and neither does a restart followed by a repeat of the apply.
    assert.ok((await call(owner, "meeting.record.apply", { decisionId }, "ap1")).ok);
    assert.equal((await logOp(owner)).result.item.entries.length, 2);
    await c.close();
    c = await boot(path);
    const again = await c.services.principals.authenticate(owner);
    assert.equal(again.kind, "owner");
    assert.ok((await call(owner, "meeting.record.apply", { decisionId }, "ap2")).ok);
    const after = (await logOp(owner)).result.item.entries as any[];
    assert.deepEqual(after.map((e) => e.id).sort(), entries.map((e) => e.id).sort(), "the same two lines");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
