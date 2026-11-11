import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { ROUTING_TABLE, EXEC_PROFILES, PI, ScriptedWorker, workGrants } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { AdmissionService } from "../admission/index.js";
import { HostService } from "../hosts/index.js";
import { DifficultyService } from "../routing/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const AGENT = "agt-abcdefghijklmnopqrst";
const sha = (text: string): string => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const effect = { kind: "effect", effectKind: "git-push", target: "repo", input: {}, bridge: { idempotent: false, execute: async () => ({ receipt: "r" }), reconcile: async () => ({ state: "not_applied" as const }) } };

/** Starts a real controller (the version hook is whatever `startController` composes), has an agent call a tool on a target and returns the version the review recorded for it. */
async function versionOfReview(targetVersions: false | undefined, target: { kind: string; id: string }): Promise<{ state: string; version: string | undefined; reviews: number }> {
  const d = mkdtempSync(join(tmpdir(), "nn-tvs-"));
  const checkout = join(d, "checkout");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(checkout);
  writeFileSync(join(checkout, "a.txt"), "hello");
  let script: (ctx: { gateway: any }) => Promise<any> = async () => ({ status: "completed", text: "done" });
  const worker = new ScriptedWorker("host:w1", (ctx) => script(ctx as never));
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: { timer: new ManualTimer(), manual: true, workers: [worker] }, ...(targetVersions === false ? { targetVersions: false as const } : {}),
  });
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    await s.routing.setTable(rob, { commandId: "rt", expectedRevision: 0, table: { ...ROUTING_TABLE, roles: { coordinator: "r-cloud", "safety-supervisor": "r-cloud" } } } as never);
    await DifficultyService.withEpoch(c.storage, c.epoch, s.routing, s.contracts).setProfiles(rob, { commandId: "sp", expectedRevision: 0, profiles: EXEC_PROFILES } as never);
    await s.principals.enroll(rob, { commandId: "e-host", kind: "host", name: "w1", grants: [] });
    const hostP = await s.principals.authenticate((await s.principals.issueCredential(rob, "host:w1")).token);
    const hosts = HostService.withEpoch(c.storage, c.epoch, s.assignments);
    await hosts.announce(hostP, { commandId: "an", capabilities: { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] } });
    await hosts.heartbeat(hostP, { commandId: "hb", sequence: 1 });
    await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap", actor: rob.id, host: "host:w1", capacity: { cpus: 8, memoryMb: 16_384 } });
    const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden", repositories: [{ id: "repo1", location: checkout }] } as never)).id;
    await s.resources.bindResource(rob, { commandId: "bind", projectId: project, kind: "repository", label: "main", locator: checkout, repositoryId: "repo1", access: "read" } as never);
    await s.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: AGENT, grants: workGrants(project, ["git-push"]) });
    const taskId = (await s.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Push", repositoryId: "repo1" })).id;
    await s.projects.transitionTask({ commandId: "r1", actor: rob.id, taskId, expectedRevision: 1, to: "ready" });
    await s.assignments.assignTask({ commandId: "as1", actor: rob.id, taskId, owner: { kind: "agent", id: AGENT } });
    const a = (await s.assignments.getAssignment(taskId))!;
    await s.assignments.admitAttempt({ commandId: "ad1", actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: AGENT }, harness: "pi" });
    let result: any;
    script = async ({ gateway }) => { result = await gateway.call({ callId: "c1", tool: { name: "git-push", version: "2.0" }, args: { branch: "main" }, target }, effect); return { status: "completed", text: "x" }; };
    await c.dispatch.dispatcher.tick();
    await c.dispatch.dispatcher.idle();
    const ids = await s.reviews.reviewIdsForTask(taskId);
    const review = ids.length === 0 ? undefined : await s.reviews.get(rob, ids[0]!);
    return { state: String(result?.state), version: review?.operation.target.version, reviews: ids.length };
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}

test("card A05b follow-up: startController gives the dispatcher the version hook, so a live call on a workspace file is reviewed at the file's digest", async () => {
  const live = await versionOfReview(undefined, { kind: "file", id: "a.txt" });
  assert.equal(live.state, "awaiting-approval");
  assert.equal(live.version, sha("hello"));
});

test("card A05b follow-up: a live call on a kind with no reading is reviewed with no version, as before, and `targetVersions: false` turns the reading off", async () => {
  const unknown = await versionOfReview(undefined, { kind: "repository", id: "main" });
  assert.equal(unknown.state, "awaiting-approval");
  assert.equal(unknown.version, undefined);
  const off = await versionOfReview(false, { kind: "file", id: "a.txt" });
  assert.equal(off.state, "awaiting-approval");
  assert.equal(off.version, undefined);
});

test("card A05b follow-up: a live call on a file that cannot be read safely is refused, not reviewed without a version", async () => {
  const refused = await versionOfReview(undefined, { kind: "file", id: "../outside" });
  assert.equal(refused.state, "refused");
  assert.equal(refused.reviews, 0);
});
