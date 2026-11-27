import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

// Card B04 in the composed controller: an agent proposes an experiment, the owner pins its criteria, the agent reports a run that uses up the budget, the status view says it is paused, and after a restart
// the experiment, its run and its pinned seal are as they were and a replayed run makes nothing new.
test("experiments through the running controller's API: propose, pin, a run that pauses, the status view and a restart (card B04)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-exp-"));
  const open = () => startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: { timer: new ManualTimer(), manual: true, route: async () => ({ route: "cloud/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: true } }) } });
  let c = await open();
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const made = await s.agents.create(rob, { commandId: "mk-ann", friendlyName: "Ann", roles: ["author"] });
    const ann = { id: `agent:${made.id}`, token: "" };
    await s.grants.grant(rob, { commandId: "g-ann", grantee: ann.id, action: "meeting.agenda", project, source: "direct", basis: "test" } as never);
    ann.token = (await s.principals.issueCredential(rob, ann.id)).token;

    const proposal = { problem: "slow", affectedWork: "reviews", change: "a checklist", effort: "a day", runningCost: "none", benefit: "less rework", evaluation: "five tasks", stoppingCondition: "one run" };
    const proposed = await call(ann.token, "experiment.propose", { projectId: project, title: "Checklist", proposal, affectedKey: "reviews" }, "e1");
    assert.ok(proposed.ok, JSON.stringify(proposed));
    const id = proposed.result.id as string;
    const criteria = { baseline: { label: "v4", ref: "abc", digest: "a".repeat(64) }, evaluator: { label: "r", ref: "r2", digest: "b".repeat(64) }, cases: [{ id: "c1", text: "missing field" }], baselinePassing: ["c1"], baselineMetrics: { timeToAcceptedSeconds: 100 }, budget: { maxRuns: 1, maxCost: 10 }, minRuns: 1 };
    assert.equal((await call(ann.token, "experiment.pin", { experimentId: id, expectedRevision: 1, criteria }, "x0")).error.code, "forbidden", "the proposer cannot pin its own criteria");
    const pinned = await call(boot.token, "experiment.pin", { experimentId: id, expectedRevision: 1, criteria }, "x1");
    assert.ok(pinned.ok, JSON.stringify(pinned));
    // The run names ann's A08 environment revision; the composed controller checks it with A08's integrity check (slice 2): another agent's revision and a wrong extension digest are refused.
    const manifest = { base: { name: "nimblenewt-base", version: "1.0.0", digest: `sha256:${"1".repeat(64)}` }, packages: [], skills: [], capabilities: [], configuration: {}, limits: { cpus: 1, memoryMb: 512, diskMb: 1024, processes: 64 }, protectedExtensions: [] };
    await s.environments.change(rob, { commandId: "env-ann", agentId: ann.id, manifest, reason: "first" });
    await s.environments.change(rob, { commandId: "env-bob", agentId: "agent:bob", manifest, reason: "first" });
    const env = { agentId: ann.id, revision: 1, observed: {}, disposable: true };
    const refused = [await call(ann.token, "experiment.run", { experimentId: id, environment: { ...env, agentId: "agent:bob" }, cost: 2, metrics: { timeToAcceptedSeconds: 80 }, cases: [{ id: "c1", passed: true }] }, "run0"),
      await call(ann.token, "experiment.run", { experimentId: id, environment: { ...env, observed: { "nimblenewt.guard": `sha256:${"2".repeat(64)}` } }, cost: 2, metrics: { timeToAcceptedSeconds: 80 }, cases: [{ id: "c1", passed: true }] }, "run00")];
    assert.deepEqual(refused.map((r) => r.error?.code), ["not_found", "integrity"], JSON.stringify(refused));
    const run = { experimentId: id, environment: env, cost: 2, metrics: { timeToAcceptedSeconds: 80 }, cases: [{ id: "c1", passed: true }] };
    const ran = await call(ann.token, "experiment.run", run, "run1");
    assert.deepEqual([ran.ok, ran.result.run, ran.result.status], [true, 1, "paused"], JSON.stringify(ran));
    assert.equal((await call(ann.token, "experiment.run", run, "run2")).error.code, "unavailable");

    const view = await call(boot.token, "status.ask", { request: { kind: "experiments", projectId: project } });
    assert.ok(view.ok, JSON.stringify(view));
    assert.match((view.result.item.lines as { text: string }[]).map((l) => l.text).join("\n"), /paused: "Checklist".*1 of 1 runs, cost 2 of 10; the budget is used up.*Last run in agent:[a-z0-9-]+'s environment revision 1, checked\./);

    await c.close();
    c = await open();
    const again = await call(ann.token, "experiment.run", run, "run1");
    assert.deepEqual([again.ok, again.result.run], [true, 1], "a replayed run is the same run");
    const got = (await call(boot.token, "experiment.get", { experimentId: id })).result.item;
    assert.deepEqual([got.status, got.runs.length, got.spent, got.pausedWhy], ["paused", 1, { runs: 1, cost: 2 }, "budget"]);
    assert.deepEqual([got.runs[0].environmentRevision.agentId, got.runs[0].environmentRevision.revision, /^sha256:[0-9a-f]{64}$/.test(got.runs[0].environmentRevision.digest)], [ann.id, 1, true], "the run keeps the revision as checked, across a restart");
    const concluded = await call(boot.token, "experiment.conclude", { experimentId: id, expectedRevision: got.revision, finding: "faster" }, "c1");
    assert.deepEqual([concluded.ok, concluded.result.verdict], [true, "improved"], JSON.stringify(concluded));
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
