import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BudgetService } from "../budgets/budgets.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { PolicyService, type SetPolicy } from "../policy/policy.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

/** Five budget raises adopted in one meeting under a policy that lets spend through, with the owner's limit settings as given (card M02g): returns what the apply did. */
async function scenario(settings: Record<string, unknown>) {
  const d = mkdtempSync(join(tmpdir(), "nn-wlimit-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [] });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    await PolicyService.withEpoch(c.storage, c.epoch, c.services.grants, {}).set(rob, { commandId: "pol1", scope: "installation", profile: "derived" } as SetPolicy);
    if (Object.keys(settings).length > 0) {
      const staged = await c.services.configuration.stage(rob, { commandId: "cfg1", layer: "installation", set: settings as never });
      await c.services.configuration.apply(rob, { commandId: "cfg2", layer: "installation", expectedRevision: staged.revision });
    }
    const project = (await call(boot.token, "project.create", { name: "Garden" }, "p1")).result.id as string;
    const tasks: { id: string; revision: number }[] = [];
    for (let i = 0; i < 5; i++) {
      const t = (await call(boot.token, "task.create", { projectId: project, title: `Bed ${i}` }, `t${i}`)).result;
      await BudgetService.withEpoch(c.storage, c.epoch, {}).open(rob, { commandId: `bo${i}`, taskId: t.id, currency: "USD", costMicros: 1_000_000 });
      tasks.push(t);
    }
    const tok = async (name: string, grants: { action: string; project: string }[]) => { await c.services.principals.enroll(rob, { commandId: `e-${name}`, kind: "agent", name, grants }); return (await c.services.principals.issueCredential(rob, `agent:${name}`)).token; };
    const ann = await tok("ann", [{ action: "task.read", project }, { action: "meeting.attend", project }, { action: "budget.manage", project }]);
    const bob = await tok("bob", [{ action: "task.read", project }, { action: "meeting.attend", project }]);
    const changes = tasks.map((t, i) => ({ kind: "budget.raise", agent: "agent:ann", target: { kind: "task", id: t.id }, expectedRevision: t.revision, patch: { costMicros: 500_000 }, summary: `raise ${i}` }));
    const urgent = await call(boot.token, "meeting.call-urgent", { projectId: project, title: "Money", reason: "frost", roster: ["agent:ann", "agent:bob"] }, "mu1");
    const rec = (await call(boot.token, "meeting.record.open", { occurrenceId: urgent.result.id, chair: "agent:ann" }, "mo1")).result.id as string;
    for (const [t, id] of [[ann, "j1"], [bob, "j2"]] as const) await call(t, "meeting.record.join", { recordId: rec }, id);
    const moved = await call(ann, "meeting.record.move", { recordId: rec, text: "Raise all.", topic: "unrelated topic", changes }, "mv1");
    assert.ok(moved.ok, JSON.stringify(moved));
    const mid = moved.result.id as string;
    assert.ok((await call(boot.token, "meeting.record.open-vote", { motionId: mid, expectedVersion: 1 }, "ov1")).ok);
    for (const [t, id] of [[ann, "b1"], [bob, "b2"]] as const) assert.ok((await call(t, "meeting.record.cast-ballot", { motionId: mid, version: 1, value: "yes", reason: "agreed" }, id)).ok, id);
    const closed = await call(boot.token, "meeting.record.close-vote", { motionId: mid }, "cv1");
    assert.equal(closed.result.state, "adopted", JSON.stringify(closed));
    const decisionId = closed.result.decisionId as string;
    const applied = await call(boot.token, "meeting.record.apply", { decisionId }, "ap1");
    assert.ok(applied.ok, JSON.stringify(applied));
    const raised = async () => { let n = 0; for (const t of tasks) if ((await call(boot.token, "budget.report", { taskId: t.id })).result.item.limit.costMicros === 1_500_000) n++; return n; };
    const agree = async () => { const r = await call(boot.token, "meeting.record.owner-respond", { decisionId, response: "agree" }, "or1"); assert.ok(r.ok, JSON.stringify(r)); return r.result as { applied?: number }; };
    const needs = async () => ((await call(boot.token, "status.ask", { request: { kind: "needs_you" } })).result.item.lines as { text: string }[]).filter((l) => /meeting decision waits for you/.test(l.text)).length;
    const needsText = async () => ((await call(boot.token, "status.ask", { request: { kind: "needs_you" } })).result.item.lines as { text: string }[]).filter((l) => /meeting decision waits for you/.test(l.text)).map((l) => l.text);
    const logged = async () => ((await call(boot.token, "meeting.decisions.log", {})).result.item.entries as { outcome: string; decidedBy: string }[]).map((e) => `${e.outcome}:${e.decidedBy}`).sort();
    return { needsText, applied: applied.result as { applied: number; pending: number; waitingFor?: string }, raised, agree, logged, needs, done: async () => { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } };
  } catch (e) { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); throw e; }
}

const run = async (settings: Record<string, unknown>, body: (s: Awaited<ReturnType<typeof scenario>>) => Promise<void>) => { const s = await scenario(settings); try { await body(s); } finally { await s.done(); } };

test("a decision of five budget raises on the policy's leave is limited to three by default, to the owner's number, or not at all; the rest waits for the owner (card M02g)", async () => {
  await run({}, async (s) => {
    assert.deepEqual([s.applied.applied, s.applied.pending, s.applied.waitingFor], [3, 2, "owner"]);
    assert.equal(await s.raised(), 3);
    assert.equal(await s.needs(), 1, "the owner is shown the held decision");
    assert.match((await s.needsText())[0]!, /waits for you: "Raise all\."/, "and can tell it from another by its wording");
    assert.equal((await s.agree()).applied, 5);
    assert.equal(await s.needs(), 0, "and it leaves the list once answered");
    assert.equal(await s.raised(), 5);
    assert.deepEqual(await s.logged(), ["applied:owner", "applied:owner", "applied:policy", "applied:policy", "applied:policy"]);
  });
  await run({ "meeting.decision.maxPolicyWidening": 7 }, async (s) => {
    assert.equal(s.applied.applied, 5);
    assert.equal(await s.raised(), 5);
  });
  await run({ "meeting.decision.limitPolicyWidening": false, "meeting.decision.maxPolicyWidening": 1 }, async (s) => {
    assert.equal(s.applied.applied, 5, "the limit is switched off whatever the number says");
  });
  await run({ "meeting.decision.maxPolicyWidening": 0 }, async (s) => {
    assert.deepEqual([s.applied.applied, s.applied.waitingFor], [0, "owner"]);
    assert.equal(await s.raised(), 0);
  });
});
