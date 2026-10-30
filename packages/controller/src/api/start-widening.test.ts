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

type Setup = Partial<Pick<SetPolicy, "profile" | "overrides">>;

/** Starts a controller, sets the approval policy as the owner, and runs a meeting that adopts one widening change; returns what the wiring did with it. */
async function scenario(kind: "budget.raise" | "grant.add", setup: Setup) {
  const d = mkdtempSync(join(tmpdir(), "nn-widen-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [] });
  const done = async () => { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); };
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    if (setup.profile !== undefined || setup.overrides !== undefined) {
      await PolicyService.withEpoch(c.storage, c.epoch, c.services.grants, {}).set(rob, { commandId: "pol1", scope: "installation", ...setup } as SetPolicy);
    }
    const project = (await call(boot.token, "project.create", { name: "Garden" }, "p1")).result.id as string;
    const task = (await call(boot.token, "task.create", { projectId: project, title: "Cover beds" }, "t1")).result;
    await BudgetService.withEpoch(c.storage, c.epoch, {}).open(rob, { commandId: "bo1", taskId: task.id, currency: "USD", costMicros: 1_000_000 });
    const limit = async () => (await call(boot.token, "budget.report", { taskId: task.id })).result.item.limit.costMicros as number;
    assert.equal(await limit(), 1_000_000);
    const tok = async (name: string, grants: { action: string; project: string }[]) => { await c.services.principals.enroll(rob, { commandId: `e-${name}`, kind: "agent", name, grants }); return (await c.services.principals.issueCredential(rob, `agent:${name}`)).token; };
    const ann = await tok("ann", [{ action: "task.read", project }, { action: "meeting.attend", project }, { action: "budget.manage", project }, { action: "principal.manage", project }]);
    const bob = await tok("bob", [{ action: "task.read", project }, { action: "meeting.attend", project }]);
    const change = kind === "budget.raise"
      ? { kind, agent: "agent:ann", target: { kind: "task", id: task.id }, expectedRevision: task.revision, patch: { costMicros: 500_000 }, summary: "raise the budget" }
      : { kind, agent: "agent:ann", target: { kind: "project", id: project }, expectedRevision: 1, patch: { grantee: "agent:bob", action: "task.read", expiresAt: new Date(Date.now() + 10 * 86_400_000).toISOString() }, summary: "let bob read tasks" };
    const urgent = await call(boot.token, "meeting.call-urgent", { projectId: project, title: "Money", reason: "frost", roster: ["agent:ann", "agent:bob"] }, "mu1");
    const rec = (await call(boot.token, "meeting.record.open", { occurrenceId: urgent.result.id, chair: "agent:ann" }, "mo1")).result.id as string;
    for (const [t, id] of [[ann, "j1"], [bob, "j2"]] as const) await call(t, "meeting.record.join", { recordId: rec }, id);
    const moved = await call(ann, "meeting.record.move", { recordId: rec, text: "Widen it.", topic: "unrelated topic", changes: [change] }, "mv1");
    assert.ok(moved.ok, JSON.stringify(moved));
    const mid = moved.result.id as string;
    assert.ok((await call(boot.token, "meeting.record.open-vote", { motionId: mid, expectedVersion: 1 }, "ov1")).ok);
    for (const [t, id] of [[ann, "b1"], [bob, "b2"]] as const) assert.ok((await call(t, "meeting.record.cast-ballot", { motionId: mid, version: 1, value: "yes", reason: "agreed" }, id)).ok, id);
    const closed = await call(boot.token, "meeting.record.close-vote", { motionId: mid }, "cv1");
    assert.equal(closed.result.state, "adopted", JSON.stringify(closed));
    const decisionId = closed.result.decisionId as string;
    const applied = await call(boot.token, "meeting.record.apply", { decisionId }, "ap1");
    assert.ok(applied.ok, JSON.stringify(applied));
    const changeState = async () => (await call(boot.token, "meeting.record.decision", { decisionId })).result.item.changes[0].state as string;
    const bobCanRead = async () => (await c.services.grants.effective((await c.services.principals.get("agent:bob"))! as never, new Date().toISOString()) as unknown as { grants: { action: string; project?: string; expiresAt?: string; basis?: string }[] }).grants.some((g) => g.action === "task.read" && g.expiresAt !== undefined);
    const agree = async () => { const r = await call(boot.token, "meeting.record.owner-respond", { decisionId, response: "agree" }, "or1"); assert.ok(r.ok, JSON.stringify(r)); return r.result as { applied?: number }; };
    return { done, applied: applied.result as { applied: number; waitingFor?: string }, limit, changeState, bobCanRead, agree };
  } catch (e) { await done(); throw e; }
}

const withScenario = async (kind: "budget.raise" | "grant.add", setup: Setup, body: (s: Awaited<ReturnType<typeof scenario>>) => Promise<void>) => { const s = await scenario(kind, setup); try { await body(s); } finally { await s.done(); } };

test("a budget raise decided in a meeting is carried out at once only where the spend policy allows it, and otherwise waits for the owner (card M02e)", async () => {
  // Strict profile: spend is asked, so the raise waits; the owner's agreement carries it out.
  await withScenario("budget.raise", {}, async (s) => {
    assert.equal(s.applied.applied, 0);
    assert.equal(s.applied.waitingFor, "owner");
    assert.equal(await s.limit(), 1_000_000, "strict: nothing was raised without the owner");
    assert.notEqual(await s.changeState(), "applied");
    assert.equal((await s.agree()).applied, 1);
    assert.equal(await s.limit(), 1_500_000, "the owner agreed: raised");
    assert.equal(await s.changeState(), "applied");
  });
  // Derived profile: the profile lets spend through in development.
  await withScenario("budget.raise", { profile: "derived" }, async (s) => {
    assert.equal(s.applied.applied, 1);
    assert.equal(await s.limit(), 1_500_000);
    assert.equal(await s.changeState(), "applied");
  });
  // Strict with an explicit allow on the spend cell.
  await withScenario("budget.raise", { overrides: { "spend.free": "allow" } }, async (s) => {
    assert.equal(s.applied.applied, 1);
    assert.equal(await s.limit(), 1_500_000);
  });
  // An explicit ask under a profile that would allow still waits for the owner.
  await withScenario("budget.raise", { profile: "derived", overrides: { "spend.free": "owner" } }, async (s) => {
    assert.equal(s.applied.waitingFor, "owner");
    assert.equal(await s.limit(), 1_000_000);
    await s.agree();
    assert.equal(await s.limit(), 1_500_000);
  });
});

test("a grant decided in a meeting is carried out under policy only where the access-change cell was set to allow by hand, else with the owner's agreement (card M02e)", async () => {
  // The profile alone never lets rights through, however loose it is.
  await withScenario("grant.add", { profile: "autonomous" }, async (s) => {
    assert.equal(s.applied.applied, 0);
    assert.equal(s.applied.waitingFor, "owner");
    assert.equal(await s.bobCanRead(), false);
    assert.equal((await s.agree()).applied, 1);
    assert.equal(await s.bobCanRead(), true);
  });
  // An explicit allow of the access-change cell carries it out.
  await withScenario("grant.add", { overrides: { "access-change.free": "allow" } }, async (s) => {
    assert.equal(s.applied.applied, 1);
    assert.equal(await s.bobCanRead(), true);
    assert.equal(await s.changeState(), "applied");
  });
});
