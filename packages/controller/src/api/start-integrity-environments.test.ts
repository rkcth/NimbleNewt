import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { derivedId } from "../domain/ids.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import type { EnvironmentRuntime, ReloadInput, TrialResult, ValidateResult } from "../maintenance/index.js";
import { NotificationService } from "../notifications/index.js";
import { integrityKey } from "../notifications/security-detect.js";
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
/** The item's reference the Urgent watch derives from the detector's report (kind, reporter, project, key): pins the place `environments` the controller's guard names. */
const securityRef = (key: string): string => createHash("sha256").update(`integrity-check-failed|service:detect-integrity|-|${key}`).digest("hex").slice(0, 24);

test("U11d: a changed pinned environment revision and a failed activation are one Urgent item each through the running controller, and a repeat (also after a restart) adds none", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-sint-"));
  const open = async () => await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: { timer: new ManualTimer(), manual: true },
  } as never);
  let c = await open();
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
    assert.equal(first[0]!.ref.id, securityRef(integrityKey("environments", "the pinned environment revision is missing or has changed")), "the guard names the place environments");
    assert.ok(!JSON.stringify(first[0]).includes(d) && !JSON.stringify(first[0]).includes(attemptId) && !JSON.stringify(first[0]).includes(agentKey), "no host path or ID in the item");

    // A failed activation: the observed extension is one the manifest does not name. One more item, none for a repeat.
    await s.environments.change(rob, { commandId: "ec2", agentId, manifest: { ...manifest, configuration: { installation: 2 } }, reason: "second", expectedRevision: 1 });
    for (let i = 0; i < 2; i++) await assert.rejects(() => s.environments.activate(rob, { commandId: `ea2-${i}`, agentId, revision: 2, observed: { "nimblenewt.desk": D("c") } }), (e) => (e as { code?: string }).code === "integrity");
    await until(async () => (await items()).length === 2, "one item for the failed activation");
    await sleep(150);
    assert.equal((await items()).length, 2, "a repeat adds none");
    assert.ok((await items()).every((i) => i.level === "urgent"));

    // A restart forgets the detectors' memory; the Urgent watch still tells each event once: the same failures met again add no item, and none is lost.
    await c.close();
    c = await open();
    const s2 = c.services;
    const rob2 = (await s2.principals.authenticate(boot.token))!;
    const notifications2 = NotificationService.withEpoch(c.storage, c.epoch, {});
    const items2 = async () => (await notifications2.inbox(rob2)).items.filter((i) => i.ref.kind === "security" && i.state !== "settled" && i.state !== "answered");
    await assert.rejects(() => s2.environments.resume(rob2, attemptId), (e) => (e as { code?: string }).code === "integrity");
    await assert.rejects(() => s2.environments.activate(rob2, { commandId: "ea3", agentId, revision: 2, observed: { "nimblenewt.desk": D("c") } }), (e) => (e as { code?: string }).code === "integrity");
    await sleep(300);
    assert.equal((await items2()).length, 2, "after a restart the same damage is still the same two items");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("U11d: an activation that fails inside the controller's own maintenance applier is one Urgent item, and the request is rolled back as before", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-sinta-"));
  // The worker comes back from its reload with an extension the manifest does not name: the applier's activation fails its integrity check.
  const host: EnvironmentRuntime = {
    trial: async (): Promise<TrialResult> => ({ ok: true, digestVerified: true, scriptsDeclared: false, scriptsRan: false }),
    reload: async (_i: ReloadInput) => ({ ok: true as const, observed: { "nimblenewt.desk": D("7") } }),
    validate: async (): Promise<ValidateResult> => ({ ok: true, sessionIntact: true, compactionIntact: true }),
  };
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], maintenance: { environmentRuntime: host },
  } as never);
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = (await s.principals.authenticate(boot.token))!;
    const notifications = NotificationService.withEpoch(c.storage, c.epoch, {});
    const items = async () => (await notifications.inbox(rob)).items.filter((i) => i.ref.kind === "security" && i.state !== "settled" && i.state !== "answered");
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any }>;
    const ann = await s.agents.create(rob, { commandId: "ag-a", friendlyName: "Ann", roles: ["author"] } as never);
    const annToken = (await s.principals.issueCredential(rob, `agent:${ann.id}`)).token;
    const agentId = `agent:${ann.id}`;
    await s.environments.change(rob, { commandId: "env-a", agentId, manifest: { base: { name: "nimblenewt-base", version: "1.0.0", digest: D("1") }, packages: [], skills: [], capabilities: [], configuration: { installation: 1 }, limits: { cpus: 1, memoryMb: 1024, diskMb: 5000, processes: 100 }, protectedExtensions: [] }, reason: "first environment" });
    await s.environments.activate(rob, { commandId: "act-a", agentId, revision: 1, observed: {} });
    const asked = await call(annToken, "maintenance.request", { kind: "package", spec: { name: "ripgrep", version: "1.2.3", digest: D("a"), source: "https://registry.example.org/pkg", installScripts: false }, reason: "search faster", rollbackPlan: "remove it" }, "m1");
    const mid = asked.result.maintenanceId as string;
    const spec = (await call(boot.token, "maintenance.get", { maintenanceId: mid })).result.item.specDigest;
    assert.ok((await call(boot.token, "maintenance.decide", { maintenanceId: mid, verdict: "approve", specDigest: spec }, "dec1")).ok);
    await s.maintenance.idle();
    const item = (await call(boot.token, "maintenance.get", { maintenanceId: mid })).result.item;
    assert.equal(item.status, "failed", JSON.stringify(item));
    assert.match(item.failure.reason, /was not activated/);
    assert.equal((await s.environments.get(rob, agentId))?.active?.revision, 1, "the previous revision stays active");
    await until(async () => (await items()).length === 1, "one item for the applier's failed activation");
    const [raised] = await items();
    assert.equal(raised!.level, "urgent");
    assert.equal(raised!.ref.id, securityRef(integrityKey("environments", "revision 2 was not activated: nimblenewt.desk is loaded but the manifest does not name it")));
    await sleep(150);
    assert.equal((await items()).length, 1);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
