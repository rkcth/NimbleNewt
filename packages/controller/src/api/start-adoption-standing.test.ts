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
const SKILL = { purpose: "lint a file", input: { type: "object" }, output: { type: "object" }, os: ["linux", "darwin"], arch: ["x64", "arm64"], dependencies: [], requestedAccess: [], limits: { cpus: 1, memoryMb: 256, seconds: 60 }, cancellation: "cooperative", recovery: "restart" };

// Card B05, standing slice, in the composed controller: an adopted shared tool version follows the catalog. The owner approves it; once the version is set aside it is not in force (the API says so and
// the experiments status view says why, instead of "in force"); after a restart a rollback to it puts it in force again; once it is revoked it is not in force, and a set-aside version is not adopted.
test("an adopted tool version is in force only while the catalog offers it, through the running controller's API and status view, across a restart (card B05)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-adps-"));
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
    await s.grants.grant(rob, { commandId: "g-ann-d", grantee: ann.id, action: "desk.write", project, source: "direct", basis: "test" } as never);
    ann.token = (await s.principals.issueCredential(rob, ann.id)).token;
    const annP = await s.principals.authenticate(ann.token);

    const proposal = { problem: "slow", affectedWork: "reviews", change: "a lint step", effort: "a day", runningCost: "none", benefit: "less rework", evaluation: "five tasks", stoppingCondition: "one run" };
    const id = (await call(ann.token, "experiment.propose", { projectId: project, title: "Lint", proposal, affectedKey: "reviews" }, "e1")).result.id as string;
    const criteria = { baseline: { label: "v4", ref: "abc", digest: "a".repeat(64) }, evaluator: { label: "r", ref: "r2", digest: "b".repeat(64) }, cases: [{ id: "c1", text: "missing field" }], baselinePassing: ["c1"], baselineMetrics: { timeToAcceptedSeconds: 100 }, budget: { maxRuns: 1, maxCost: 10 }, minRuns: 1 };
    assert.ok((await call(boot.token, "experiment.pin", { experimentId: id, expectedRevision: 1, criteria }, "x1")).ok);
    const manifest = { base: { name: "nimblenewt-base", version: "1.0.0", digest: `sha256:${"1".repeat(64)}` }, packages: [], skills: [], capabilities: [], configuration: {}, limits: { cpus: 1, memoryMb: 512, diskMb: 1024, processes: 64 }, protectedExtensions: [] };
    await s.environments.change(rob, { commandId: "env-ann", agentId: ann.id, manifest, reason: "first" });
    assert.ok((await call(ann.token, "experiment.run", { experimentId: id, environment: { agentId: ann.id, revision: 1, observed: {}, disposable: true }, cost: 2, metrics: { timeToAcceptedSeconds: 80 }, cases: [{ id: "c1", passed: true }] }, "run1")).ok);
    const exp = (await call(boot.token, "experiment.get", { experimentId: id })).result.item;
    assert.equal((await call(boot.token, "experiment.conclude", { experimentId: id, expectedRevision: exp.revision, finding: "faster" }, "c1")).result.verdict, "improved");

    // The shared toolbox: toolbox.lint 1.0.0 and 1.1.0, registered by the owner from ann's note.
    const note = (await s.desks.write(annP, { commandId: "n1", projectId: project, kind: "note", title: "lint", body: "Run lint on the file.", visibility: "shared", status: "accepted" } as never)).id;
    for (const v of ["1.0.0", "1.1.0"]) await s.catalog.register(rob, { commandId: `reg-${v}`, name: "toolbox.lint", kind: "skill", version: v, manifest: SKILL, instructionsRecordId: note } as never);
    const target = { kind: "tool", name: "toolbox.lint", version: "1.0.0" };
    const adp = (await call(ann.token, "adoption.request", { experimentId: id, target, reason: "lint helped" }, "a1")).result.id as string;
    const ok = await call(boot.token, "adoption.approve", { adoptionId: adp, expectedRevision: 1, review: "the run beat the baseline" }, "ap1");
    assert.ok(ok.ok, JSON.stringify(ok));
    const inForce = async () => (await call(boot.token, "adoption.in-force", { projectId: project, target })).result.item;
    const text = async () => ((await call(boot.token, "status.ask", { request: { kind: "experiments", projectId: project } })).result.item.lines as { text: string }[]).map((l) => l.text).join("\n");
    assert.equal((await inForce())?.adoptionId, adp);
    assert.match(await text(), /Adoption of tool toolbox\.lint 1\.0\.0 from experiment exp-[a-z2-7]+: in force, approved by owner:rob \(grant: owner\)\./);

    // Set aside: not in force; the view says why; the adoption itself is still active.
    await s.catalog.deprecate(rob, { commandId: "dep1", name: "toolbox.lint", version: "1.0.0", reason: "1.1.0 replaces it" });
    assert.equal(await inForce(), null, "set aside: not in force");
    assert.match(await text(), /Adoption of tool toolbox\.lint 1\.0\.0 from experiment exp-[a-z2-7]+: approved by owner:rob \(grant: owner\), but not in force now: the version was set aside in the catalog, so it is not used\./);
    assert.equal((await call(boot.token, "adoption.get", { adoptionId: adp })).result.item.status, "active");
    // A set-aside version is not adopted either.
    await s.catalog.deprecate(rob, { commandId: "dep2", name: "toolbox.lint", version: "1.1.0", reason: "trying" });
    const other = (await call(ann.token, "adoption.request", { experimentId: id, target: { ...target, version: "1.1.0" }, reason: "newer" }, "a2")).result.id as string;
    const refused = await call(boot.token, "adoption.approve", { adoptionId: other, expectedRevision: 1, review: "ok" }, "ap2");
    assert.equal(refused.error?.code, "invalid_command", JSON.stringify(refused));

    await c.close();
    c = await open();
    // After a restart, the owner rolls back to 1.0.0: in force again, the same adoption.
    await c.services.catalog.rollback(rob, { commandId: "rb1", name: "toolbox.lint", toVersion: "1.0.0", reason: "back to the adopted one" });
    assert.equal((await inForce())?.adoptionId, adp, "in force again");
    assert.match(await text(), /toolbox\.lint 1\.0\.0 from experiment exp-[a-z2-7]+: in force, approved by owner:rob/);
    // Revoked: not in force; the view says so.
    await c.services.catalog.revoke(rob, { commandId: "rv1", name: "toolbox.lint", version: "1.0.0", reason: "unsafe" });
    assert.equal(await inForce(), null, "revoked: not in force");
    assert.match(await text(), /toolbox\.lint 1\.0\.0 from experiment exp-[a-z2-7]+: approved by owner:rob \(grant: owner\), but not in force now: the version was revoked, so it is not used\./);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
