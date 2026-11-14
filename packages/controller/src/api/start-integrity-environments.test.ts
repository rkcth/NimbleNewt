import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { derivedId } from "../domain/ids.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { NotificationService } from "../notifications/index.js";
import { startController } from "./index.js";

/**
 * Card U11d through the running controller: the environment service the controller hands the dispatcher and the maintenance applier (and exposes in `services`) tells its integrity failures to the security
 * detectors, so a changed pinned revision and a failed activation are each one Urgent item for the owner, however often they repeat.
 */
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => Promise<boolean>, what: string): Promise<void> => { for (let i = 0; i < 200; i++) { if (await ok()) return; await sleep(30); } assert.fail(`timed out: ${what}`); };
const D = (c: string): string => `sha256:${c.repeat(64).slice(0, 64)}`;

test("U11d: a changed pinned environment revision and a failed activation are one Urgent item each through the running controller, and a repeat adds none", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-sint-"));
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: { timer: new ManualTimer(), manual: true },
  } as never);
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = (await s.principals.authenticate(boot.token))!;
    const notifications = NotificationService.withEpoch(c.storage, c.epoch, {});
    const items = async () => (await notifications.inbox(rob)).items.filter((i) => i.ref.kind === "security" && i.state !== "settled" && i.state !== "answered");
    const agentKey = (await s.agents.create(rob, { commandId: "ag1", friendlyName: "A" })).id;
    const agentId = `agent:${agentKey}`;
    const manifest = { base: { name: "nimblenewt-base", version: "1.0.0", digest: D("a") }, packages: [], skills: [], capabilities: ["desk.read"], configuration: { installation: 1 }, limits: { cpus: 2, memoryMb: 2048, diskMb: 10_000, processes: 200 }, protectedExtensions: [] };
    await s.environments.change(rob, { commandId: "ec1", agentId, manifest, reason: "first" });
    await s.environments.activate(rob, { commandId: "ea1", agentId, revision: 1, observed: {} });
    const project = (await s.projects.createProject({ commandId: "p1", actor: "owner:rob", name: "Garden" })).id;
    const taskId = (await s.projects.createTask({ commandId: "t1", actor: "owner:rob", projectId: project, title: "T" })).id;
    await s.projects.transitionTask({ commandId: "r1", actor: "owner:rob", taskId, expectedRevision: 1, to: "ready" });
    await s.assignments.assignTask({ commandId: "as1", actor: "owner:rob", taskId, owner: { kind: "agent", id: agentKey } });
    const a = (await s.assignments.getAssignment(taskId))!;
    const attemptId = (await s.assignments.admitAttempt({ commandId: "ad1", actor: "worker", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: agentKey }, harness: "pi" })).id;
    await s.environments.pin(rob, { commandId: "pin1", attemptId, agentId, kind: "attempt" });
    assert.equal((await s.environments.resume(rob, attemptId)).revision, 1);
    await sleep(100);
    assert.equal((await items()).length, 0, "sound: nothing is raised");

    // The pinned revision changes: the resume fails as before and one Urgent item appears; asking again adds none.
    const ref = { kind: "environment-revision", id: derivedId("evr", `${agentId}|1`) };
    const stored = (await c.storage.getAggregate(ref))!;
    await c.storage.applyOperation({ operationId: "dmg1", epoch: c.epoch, actor: "owner:rob", correlationId: "dmg1", at: new Date().toISOString(), changes: [{ type: "update", ref, expectedRevision: stored.revision, body: { ...stored.body, digest: D("9") } }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
    for (let i = 0; i < 3; i++) await assert.rejects(() => s.environments.resume(rob, attemptId), (e) => (e as { code?: string }).code === "integrity");
    await until(async () => (await items()).length === 1, "one item for the changed revision");
    await sleep(150);
    const first = await items();
    assert.equal(first.length, 1);
    assert.equal(first[0]!.level, "urgent");
    assert.match(first[0]!.label, /integrity check failed/i);

    // A failed activation: the observed extension is one the manifest does not name. One more item, none for a repeat.
    await s.environments.change(rob, { commandId: "ec2", agentId, manifest: { ...manifest, configuration: { installation: 2 } }, reason: "second", expectedRevision: 1 });
    for (let i = 0; i < 2; i++) await assert.rejects(() => s.environments.activate(rob, { commandId: `ea2-${i}`, agentId, revision: 2, observed: { "nimblenewt.desk": D("c") } }), (e) => (e as { code?: string }).code === "integrity");
    await until(async () => (await items()).length === 2, "one item for the failed activation");
    await sleep(150);
    assert.equal((await items()).length, 2, "a repeat adds none");
    assert.ok((await items()).every((i) => i.level === "urgent"));
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
