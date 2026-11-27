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

// Card B05 in the composed controller: an improved experiment's practice is asked for by the proposing agent, refused to it as reviewer, approved by the owner, monitored, shown in the experiments status
// view, and after a restart a regression report withdraws it so it is no longer in force; a replayed report makes nothing new.
test("adoption through the running controller's API: ask, independent approval, monitoring, the status view, a restart and a regression that withdraws it (card B05)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-adp-"));
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
    const id = (await call(ann.token, "experiment.propose", { projectId: project, title: "Checklist", proposal, affectedKey: "reviews" }, "e1")).result.id as string;
    const criteria = { baseline: { label: "v4", ref: "abc", digest: "a".repeat(64) }, evaluator: { label: "r", ref: "r2", digest: "b".repeat(64) }, cases: [{ id: "c1", text: "missing field" }], baselinePassing: ["c1"], baselineMetrics: { timeToAcceptedSeconds: 100 }, budget: { maxRuns: 1, maxCost: 10 }, minRuns: 1 };
    assert.ok((await call(boot.token, "experiment.pin", { experimentId: id, expectedRevision: 1, criteria }, "x1")).ok);
    const manifest = { base: { name: "nimblenewt-base", version: "1.0.0", digest: `sha256:${"1".repeat(64)}` }, packages: [], skills: [], capabilities: [], configuration: {}, limits: { cpus: 1, memoryMb: 512, diskMb: 1024, processes: 64 }, protectedExtensions: [] };
    await s.environments.change(rob, { commandId: "env-ann", agentId: ann.id, manifest, reason: "first" });
    assert.ok((await call(ann.token, "experiment.run", { experimentId: id, environment: { agentId: ann.id, revision: 1, observed: {}, disposable: true }, cost: 2, metrics: { timeToAcceptedSeconds: 80 }, cases: [{ id: "c1", passed: true }] }, "run1")).ok);
    const exp = (await call(boot.token, "experiment.get", { experimentId: id })).result.item;
    assert.equal((await call(boot.token, "experiment.conclude", { experimentId: id, expectedRevision: exp.revision, finding: "faster" }, "c1")).result.verdict, "improved");

    const asked = await call(ann.token, "adoption.request", { experimentId: id, target: { kind: "practice" }, reason: "it helped" }, "a1");
    assert.ok(asked.ok, JSON.stringify(asked));
    const adp = asked.result.id as string;
    assert.equal((await call(ann.token, "adoption.approve", { adoptionId: adp, expectedRevision: 1, review: "mine" }, "ap0")).error.code, "forbidden", "the asker and proposer is not its own reviewer");
    // A tool that was never published is not adopted (the catalog is the composed one).
    const toolAsk = await call(ann.token, "adoption.request", { experimentId: id, target: { kind: "tool", name: "toolbox.lint", version: "1.0.0" }, reason: "the lint tool" }, "a2");
    assert.equal((await call(boot.token, "adoption.approve", { adoptionId: toolAsk.result.id, expectedRevision: 1, review: "ok" }, "ap1")).error.code, "not_found");
    assert.deepEqual((await call(boot.token, "adoption.in-force", { projectId: project, experimentId: id, target: { kind: "practice" } })).result.item, null);
    const approved = await call(boot.token, "adoption.approve", { adoptionId: adp, expectedRevision: 1, review: "the run beat the baseline" }, "ap2");
    assert.ok(approved.ok, JSON.stringify(approved));
    assert.equal((await call(boot.token, "adoption.in-force", { projectId: project, experimentId: id, target: { kind: "practice" } })).result.item.adoptionId, adp);
    const fine = await call(ann.token, "adoption.monitor", { adoptionId: adp, metrics: { timeToAcceptedSeconds: 90 } }, "m1");
    assert.deepEqual(fine.result, { report: 1, status: "active", regressed: [] });
    const text = async () => ((await call(boot.token, "status.ask", { request: { kind: "experiments", projectId: project } })).result.item.lines as { text: string }[]).map((l) => l.text).join("\n");
    assert.match(await text(), /Adoption of the practice it tried from experiment exp-[a-z2-7]+: in force, approved by owner:rob \(grant: owner\)\. 1 monitoring report\(s\); the last \([^)]+\): timeToAcceptedSeconds 10% better than the baseline\./);
    assert.match(await text(), /Adoption of tool toolbox\.lint 1\.0\.0 from experiment exp-[a-z2-7]+: asked by agent:[a-z0-9-]+, waiting for an independent review\./);

    await c.close();
    c = await open();
    const regress = { adoptionId: adp, metrics: { timeToAcceptedSeconds: 120 } };
    const out = await call(ann.token, "adoption.monitor", regress, "m2");
    assert.deepEqual(out.result, { report: 2, status: "withdrawn", regressed: ["timeToAcceptedSeconds"] }, JSON.stringify(out));
    assert.deepEqual((await call(ann.token, "adoption.monitor", regress, "m2")).result, out.result, "a replayed report is the same report");
    assert.deepEqual((await call(boot.token, "adoption.in-force", { projectId: project, experimentId: id, target: { kind: "practice" } })).result.item, null, "regression stops future use");
    assert.equal((await call(ann.token, "adoption.monitor", { adoptionId: adp, metrics: { timeToAcceptedSeconds: 80 } }, "m3")).error.code, "invalid_command");
    assert.match(await text(), /withdrawn: monitoring showed a regression, so it is no longer used\. 2 monitoring report\(s\).*timeToAcceptedSeconds 20% worse than the baseline; regressed: timeToAcceptedSeconds\./);
    const got = (await call(ann.token, "adoption.get", { adoptionId: adp })).result.item;
    assert.deepEqual([got.status, got.withdrawnWhy, got.reportCount], ["withdrawn", "regression", 2]);
    assert.deepEqual((await call(boot.token, "adoption.list", { projectId: project, status: "withdrawn" })).result.item.items.map((x: { id: string }) => x.id), [adp]);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
