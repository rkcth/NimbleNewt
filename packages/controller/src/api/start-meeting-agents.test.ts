import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BudgetService } from "../budgets/budgets.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { ScriptedInterpreter } from "../chat/index.js";
import { PolicyService, type SetPolicy } from "../policy/policy.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

/** Five budget raises adopted in one meeting under a policy that lets spend through, with the owner's limit settings as given (card M02g): returns what the apply did. */
async function scenario(settings: Record<string, unknown>, profile: "derived" | "strict" = "derived", extra: Record<string, unknown> = {}, prep?: (call: (token: string, op: string, args: Record<string, unknown>, commandId?: string) => Promise<any>, token: string) => Promise<void>) {
  const d = mkdtempSync(join(tmpdir(), "nn-wlimit-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], ...extra } as never);
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    await PolicyService.withEpoch(c.storage, c.epoch, c.services.grants, {}).set(rob, { commandId: "pol1", scope: "installation", profile } as SetPolicy);
    if (Object.keys(settings).length > 0) {
      const staged = await c.services.configuration.stage(rob, { commandId: "cfg1", layer: "installation", set: settings as never });
      await c.services.configuration.apply(rob, { commandId: "cfg2", layer: "installation", expectedRevision: staged.revision });
    }
    if (prep !== undefined) await prep(call, boot.token);
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
    return { c, rob, call, token: boot.token, project, rec, decisionId, needsText, applied: applied.result as { applied: number; pending: number; waitingFor?: string }, raised, agree, logged, needs, done: async () => { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } };
  } catch (e) { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); throw e; }
}

const run = async (settings: Record<string, unknown>, body: (s: Awaited<ReturnType<typeof scenario>>) => Promise<void>, profile: "derived" | "strict" = "derived", extra: Record<string, unknown> = {}, prep?: Parameters<typeof scenario>[3]) => { const s = await scenario(settings, profile, extra, prep); try { await body(s); } finally { await s.done(); } };

test("the project's cap across decisions is a setting (default 10 a day), the owner raises, lowers or switches it off, and bad values are refused (card M02h)", async () => {
  await run({ "meeting.decision.maxPolicyWidening": 50, "meeting.decision.maxPolicyWideningPerDay": 2 }, async (s) => {
    assert.deepEqual([s.applied.applied, s.applied.pending, s.applied.waitingFor], [2, 3, "owner"]);
    assert.equal(await s.raised(), 2);
    assert.equal((await s.agree()).applied, 5);
  });
  await run({ "meeting.decision.maxPolicyWidening": 50 }, async (s) => assert.equal(s.applied.applied, 5, "the default of 10 a day does not hold five back"));
  await run({ "meeting.decision.maxPolicyWidening": 50, "meeting.decision.maxPolicyWideningPerDay": 0 }, async (s) => assert.deepEqual([s.applied.applied, s.applied.waitingFor], [0, "owner"]));
  await run({ "meeting.decision.maxPolicyWidening": 50, "meeting.decision.maxPolicyWideningPerDay": 1, "meeting.decision.limitPolicyWidening": false }, async (s) => assert.equal(s.applied.applied, 5, "the same switch turns both limits off"));
  await run({}, async (s) => {
    for (const bad of [{ "meeting.decision.maxPolicyWideningPerDay": 501 }, { "meeting.decision.maxPolicyWideningPerDay": -1 }, { "meeting.decision.steward": "yes" }, { "meeting.decision.stewardRights": 1 }, { "meeting.decision.holdExpiryDays": 366 }, { "meeting.decision.holdExpiryDays": 1.5 }])
      assert.notEqual(await s.c.services.configuration.stage(s.rob, { commandId: `bad${Object.keys(bad)[0]}${Object.values(bad)[0]}`, layer: "installation", set: bad as never }).then(() => "staged", (e: Error) => e.message), "staged", JSON.stringify(bad));
    assert.deepEqual(await s.c.services.configuration.installationValues(["meeting.decision.maxPolicyWideningPerDay", "meeting.decision.steward", "meeting.decision.stewardRights", "meeting.decision.holdExpiryDays"]), { "meeting.decision.maxPolicyWideningPerDay": 10, "meeting.decision.steward": false, "meeting.decision.stewardRights": false, "meeting.decision.holdExpiryDays": 14 });
  });
});

test("the steward agent a host provides decides a budget raise the strict policy leaves to the owner only while the owner's setting is on; its ask or failure waits for the owner (card M02h)", async () => {
  const asked: string[] = [];
  const mode = { v: "allow" as "allow" | "ask" | "throw" };
  const steward = async (input: { kind: string; widens: string }) => { asked.push(`${input.kind}:${input.widens}`); if (mode.v === "throw") throw new Error("model down"); return { verdict: mode.v === "allow" ? "allow" as const : "ask" as const, reason: "small raise" }; };
  const extra = { meetingRecords: { steward } };
  await run({ "meeting.decision.maxPolicyWidening": 50 }, async (s) => {
    assert.deepEqual([s.applied.applied, s.applied.waitingFor], [0, "owner"], "switch off: strict policy asks, the steward is not asked");
    assert.deepEqual(asked, []);
  }, "strict", extra);
  await run({ "meeting.decision.maxPolicyWidening": 50, "meeting.decision.steward": true }, async (s) => {
    assert.equal(s.applied.applied, 5);
    assert.equal(await s.raised(), 5);
    assert.deepEqual(asked.slice(0, 2), ["budget.raise:spend", "budget.raise:spend"]);
    assert.deepEqual(await s.logged(), ["applied:steward", "applied:steward", "applied:steward", "applied:steward", "applied:steward"]);
    assert.equal(await s.needs(), 0);
  }, "strict", extra);
  mode.v = "throw";
  await run({ "meeting.decision.maxPolicyWidening": 50, "meeting.decision.steward": true }, async (s) => {
    assert.deepEqual([s.applied.applied, s.applied.waitingFor], [0, "owner"]);
    assert.equal(await s.needs(), 1);
  }, "strict", extra);
  mode.v = "allow";
  // The per-decision limit holds the steward too.
  await run({ "meeting.decision.maxPolicyWidening": 2, "meeting.decision.steward": true }, async (s) => assert.deepEqual([s.applied.applied, s.applied.pending], [2, 3]), "strict", extra);
});

test("the steward's allow never goes past the owner's ceiling on raises, and nobody but the owner can switch the steward on or change the cap and expiry (card M02h review)", async () => {
  const steward = async () => ({ verdict: "allow" as const, reason: "small raise" });
  // The owner's ceiling is below each 0.5 USD raise: the steward allows, the budget service refuses, nothing is raised and the log says so.
  await run({ "meeting.decision.maxPolicyWidening": 50, "meeting.decision.steward": true }, async (s) => {
    assert.deepEqual([s.applied.applied, s.applied.pending], [0, 0], JSON.stringify(s.applied));
    assert.equal(await s.raised(), 0);
    assert.deepEqual(await s.logged(), ["not-applied:steward", "not-applied:steward", "not-applied:steward", "not-applied:steward", "not-applied:steward"]);
  }, "strict", { meetingRecords: { steward } }, async (call, token) => { assert.ok((await call(token, "agreed.limits.change", { set: { raiseMaxCostMicros: 100_000 } }, "lim1")).ok); });
  // At the ceiling exactly the same raises go through.
  await run({ "meeting.decision.maxPolicyWidening": 50, "meeting.decision.steward": true }, async (s) => assert.equal(await s.raised(), 5), "strict", { meetingRecords: { steward } }, async (call, token) => { assert.ok((await call(token, "agreed.limits.change", { set: { raiseMaxCostMicros: 500_000 } }, "lim1")).ok); });
  // An agent, even one granted config.write, cannot set any of the widening settings (installation layer: the owner's only).
  await run({}, async (s) => {
    await s.c.services.principals.enroll(s.rob, { commandId: "e-cfg", kind: "agent", name: "cfg", grants: [{ action: "config.write", project: "*" }] });
    const cfg = await s.c.services.principals.authenticate((await s.c.services.principals.issueCredential(s.rob, "agent:cfg")).token);
    for (const key of ["meeting.decision.steward", "meeting.decision.stewardRights", "meeting.decision.maxPolicyWideningPerDay", "meeting.decision.holdExpiryDays", "meeting.decision.limitPolicyWidening"]) {
      const value = key === "meeting.decision.maxPolicyWideningPerDay" ? 500 : key === "meeting.decision.holdExpiryDays" ? 0 : key !== "meeting.decision.limitPolicyWidening";
      await assert.rejects(() => s.c.services.configuration.stage(cfg, { commandId: `cfg-${key}`, layer: "installation", set: { [key]: value } as never }), (e: Error & { code?: string }) => e.code === "forbidden", key);
    }
    assert.deepEqual(await s.c.services.configuration.installationValues(["meeting.decision.steward", "meeting.decision.stewardRights"]), { "meeting.decision.steward": false, "meeting.decision.stewardRights": false });
  });
});

test("the narrator a host provides writes the overview of a summary; without one there is none (card M02h)", async () => {
  const narrate = async () => "The team raised five budgets.";
  await run({}, async (s) => {
    const fin = await s.call(s.token, "meeting.record.finish", { recordId: s.rec }, "fin1");
    assert.ok(fin.ok, JSON.stringify(fin));
    const sum = await s.call(s.token, "meeting.record.summarize", { recordId: s.rec }, "sum1");
    assert.ok(sum.ok, JSON.stringify(sum));
    assert.equal(sum.result.overviewFailed, undefined);
    const read = (await s.call(s.token, "meeting.record.summary", { recordId: s.rec })).result.item;
    assert.equal(read.overview, "The team raised five budgets.");
  }, "derived", { meetingRecords: { narrate } });
  await run({}, async (s) => {
    await s.call(s.token, "meeting.record.finish", { recordId: s.rec }, "fin1");
    await s.call(s.token, "meeting.record.summarize", { recordId: s.rec }, "sum1");
    assert.equal((await s.call(s.token, "meeting.record.summary", { recordId: s.rec })).result.item.overview, undefined);
  });
});

test("what the decision log suggests is read through the API and in chat's status request, owner only, and never changes the policy (card M02h)", async () => {
  // Five raises the strict policy asked about, all agreed by the owner and carried out: the log suggests letting spend through.
  await run({ "meeting.decision.maxPolicyWidening": 50 }, async (s) => {
    assert.equal((await s.agree()).applied, 5);
    const read = await s.call(s.token, "meeting.decisions.patterns", {});
    assert.ok(read.ok, JSON.stringify(read));
    assert.deepEqual(read.result.item.patterns.map((p: { kind: string; ownerAgreed: number; suggestion?: { set: string } }) => [p.kind, p.ownerAgreed, p.suggestion?.set]), [["budget.raise", 5, "allow"]]);
    const few = await s.call(s.token, "meeting.decisions.patterns", { minAgreed: 6 });
    assert.equal(few.result.item.patterns[0].suggestion, undefined);
    assert.equal((await s.call(s.token, "meeting.decisions.patterns", { minAgreed: 1 })).ok, false, "a bad threshold is refused");
    const asked = await s.call(s.token, "status.ask", { request: { kind: "decision_patterns", projectId: s.project } });
    const lines = (asked.result.item.lines as { text: string }[]).map((l) => l.text);
    assert.match(lines[0]!, /budget\.raise \(spend\): you agreed to 5, refused 0, 0 went ahead on the policy's or steward's leave, 0 not carried out\. Suggestion: You agreed to all 5/);
    // An agent may not read it.
    const ann = (await s.c.services.principals.issueCredential(s.rob, "agent:ann")).token;
    assert.equal((await s.call(ann, "meeting.decisions.patterns", {})).ok, false);
    assert.equal((await s.call(ann, "status.ask", { request: { kind: "decision_patterns" } })).result?.item?.lines?.length ?? 0, 0);
  }, "strict");
  await run({}, async (s) => {
    const lines = (await s.call(s.token, "status.ask", { request: { kind: "decision_patterns" } })).result.item.lines as { text: string }[];
    assert.match(lines[0]!.text, /you agreed to 0, refused 0, 3 went ahead/);
  });
});

test("switching the steward on when no steward can answer is still accepted but the proposal says plainly that it has no effect yet; with a working steward it says nothing of the kind (card M02h)", async () => {
  const cases: { name: string; meetingRecords?: Record<string, unknown>; key: string; value: boolean; warns: RegExp | undefined }[] = [
    { name: "no steward configured", key: "meeting.decision.steward", value: true, warns: /no effect for now, because no steward agent is configured/ },
    { name: "rights switch, no steward", key: "meeting.decision.stewardRights", value: true, warns: /no effect for now/ },
    { name: "switching it off needs no warning", key: "meeting.decision.steward", value: false, warns: undefined },
    { name: "steward that cannot run now", meetingRecords: { steward: async () => ({ verdict: "ask" }), stewardUnavailable: async () => "no model route is usable for chat yet" }, key: "meeting.decision.steward", value: true, warns: /no effect for now, because no model route is usable for chat yet/ },
    { name: "unavailable check that throws", meetingRecords: { steward: async () => ({ verdict: "ask" }), stewardUnavailable: async () => { throw new Error("boom"); } }, key: "meeting.decision.steward", value: true, warns: /no effect for now, because its model could not be checked/ },
    { name: "a working steward", meetingRecords: { steward: async () => ({ verdict: "ask" }), stewardUnavailable: async () => undefined }, key: "meeting.decision.steward", value: true, warns: undefined },
    { name: "a steward with no availability check", meetingRecords: { steward: async () => ({ verdict: "ask" }) }, key: "meeting.decision.steward", value: true, warns: undefined },
    { name: "another setting", key: "meeting.decision.holdExpiryDays", value: true, warns: undefined },
  ];
  for (const k of cases) {
    const d = mkdtempSync(join(tmpdir(), "nn-wsteward-"));
    const say: Record<string, unknown[]> = {};
    const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) }, ...(k.meetingRecords === undefined ? {} : { meetingRecords: k.meetingRecords }) } as never);
    try {
      const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
      const text = `change ${k.key} please (${k.name})`;
      say[text] = [{ kind: "policy_edit", change: { type: "setting", layer: "installation", key: k.key, value: k.key === "meeting.decision.holdExpiryDays" ? 7 : k.value }, evidence: text, basis: "owner" }];
      const turn = await c.chat!.submit(boot.token, { messageId: "m1", text });
      const out = (turn.outcomes as unknown as { status: string; explanation?: string[] }[])[0]!;
      assert.equal(out.status, "proposed", `${k.name}: ${JSON.stringify(turn.outcomes)}`);
      const shown = JSON.stringify(turn.outcomes);
      if (k.warns === undefined) assert.doesNotMatch(shown, /no effect for now/, k.name); else assert.match(shown, k.warns, k.name);
    } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  }
});
