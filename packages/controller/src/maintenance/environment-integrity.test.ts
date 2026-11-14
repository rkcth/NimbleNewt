import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AgentService } from "../agents/index.js";
import { AssignmentService } from "../domain/assignments.js";
import { derivedId } from "../domain/ids.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { EnvironmentService, type EnvironmentManifest } from "../environments/index.js";
import { PauseService, StopService, type InventoryItem, type StopPorts } from "../lifecycle/index.js";
import { SecurityDetectors, watchIntegrity } from "../notifications/security-detect.js";
import { GrantService, PrincipalService } from "../security/index.js";
import { EnvironmentChangeApplier, MemoryJournal, type EnvironmentRuntime, type ReloadInput, type TrialInput, type TrialResult, type ValidateResult } from "./environment-applier.js";
import type { MaintenanceView } from "./maintenance.js";

after(stopServer);

/**
 * Card U11d, the environment hooks: a pinned environment revision that has changed (the dispatcher's `resume` at launch) and a failed activation (the applier's `activate`) are told to the security detectors as
 * `integrity-check-failed`, once each however often they repeat, with the same error going on to the caller. Real services on every storage backend; the reports are what the detectors send to the Urgent watch.
 */
const options = { clock: () => "2026-11-14T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const D = (c: string): string => `sha256:${c.repeat(64).slice(0, 64)}`;
const manifest = (): EnvironmentManifest => ({
  base: { name: "nimblenewt-base", version: "1.0.0", digest: D("a") }, packages: [{ name: "ripgrep", version: "14.1.0", digest: D("b") }], skills: [], capabilities: ["desk.read"],
  configuration: { installation: 1 }, limits: { cpus: 2, memoryMb: 2048, diskMb: 10_000, processes: 200 }, protectedExtensions: [{ name: "nimblenewt.desk", digest: D("c") }],
});
const OBSERVED = { "nimblenewt.desk": D("c") };
class Runtime implements EnvironmentRuntime {
  reloadResults: Array<{ ok: true; observed: Record<string, string> } | { ok: false; reason: string }> = [];
  async trial(_i: TrialInput): Promise<TrialResult> { return { ok: true, digestVerified: true, scriptsDeclared: false, scriptsRan: false }; }
  async reload(_i: ReloadInput) { return this.reloadResults.shift() ?? { ok: true as const, observed: OBSERVED }; }
  async validate(_i: ReloadInput): Promise<ValidateResult> { return { ok: true, sessionIntact: true, compactionIntact: true }; }
}
class Stopping implements StopPorts {
  unsupported(): string | undefined { return undefined; }
  async inventory(): Promise<InventoryItem[]> { return []; }
  async cleanup() { return { remaining: [] }; }
  async checkpoint() { return { checkpointId: `cp-${n++}`, durable: true, artifactsDurable: true }; }
  async terminate() { return { ended: true, unresolved: [] }; }
}
const view = (agentId: string, id: string): MaintenanceView => ({ id, agentId, kind: "package", class: "dependency", specDigest: D("e"), spec: { name: "jq", version: "1.7.1", digest: D("f"), source: "https://example.org/jq-1.7.1.tgz", installScripts: false } });

for (const backend of backends) {
  test(`${backend.name}: a changed pinned revision at launch and a failed activation each raise one integrity report, once however often they repeat, and the caller sees the same error`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const epoch = projects.epoch;
      const principals = PrincipalService.withEpoch(world.storage, epoch, options);
      GrantService.withEpoch(world.storage, epoch, options);
      const agents = AgentService.withEpoch(world.storage, epoch, options);
      const owner = (await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token))!;
      const agentKey = (await agents.create(owner, { commandId: cid("ag"), friendlyName: "A" })).id;
      const agentId = `agent:${agentKey}`;
      const raw = EnvironmentService.withEpoch(world.storage, epoch, { ...options, reservedDigest: async (nm) => (nm === "nimblenewt.desk" ? D("c") : undefined), skillUsable: async () => false });
      const reports: { kind: string; key: string }[] = [];
      let broken = false;
      const detectors = new SecurityDetectors({ report: async (_by, e) => { reports.push({ kind: e.kind, key: e.key }); if (broken) throw new Error("the watch is down"); }, enabled: async () => true });
      const env = watchIntegrity(raw, "environments", ["resume", "activate"], (source, e) => detectors.signal(source, e));
      await env.change(owner, { commandId: cid("c"), agentId, manifest: manifest(), reason: "first" });
      await env.activate(owner, { commandId: cid("a"), agentId, revision: 1, observed: OBSERVED });

      // An attempt pinned to revision 1.
      const assign = AssignmentService.withEpoch(world.storage, epoch, projects, options);
      const project = (await projects.createProject({ commandId: cid("pp"), actor: "owner:rob", name: "P" })).id;
      const taskId = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: project, title: "T" })).id;
      await projects.transitionTask({ commandId: cid("ready"), actor: "owner:rob", taskId, expectedRevision: 1, to: "ready" });
      await assign.assignTask({ commandId: cid("as"), actor: "owner:rob", taskId, owner: { kind: "agent", id: agentKey } });
      const a = (await assign.getAssignment(taskId))!;
      const attemptId = (await assign.admitAttempt({ commandId: cid("ad"), actor: "worker", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: agentKey } })).id;
      const agentPrincipal = (await principals.authenticate((await principals.issueCredential(owner, agentId)).token))!;
      await env.pin(owner, { commandId: cid("p"), attemptId, agentId, kind: "attempt" });

      // Sound: resumes, nothing is told.
      assert.equal((await env.resume(owner, attemptId)).revision, 1);
      await detectors.settled();
      assert.equal(reports.length, 0);

      // The pinned revision changes under the pin: the launch's resume fails as before, and is told once (the key does not hold the message).
      const ref = { kind: "environment-revision", id: derivedId("evr", `${agentId}|1`) };
      const stored = (await world.storage.getAggregate(ref))!;
      await world.storage.applyOperation({ operationId: cid("dmg"), epoch, actor: "owner:rob", correlationId: cid("dmg"), at: options.clock(), changes: [{ type: "update", ref, expectedRevision: stored.revision, body: { ...stored.body, digest: D("9") } }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
      const gone = (e: unknown): boolean => (e as { code?: string }).code === "integrity" && /missing or has changed/.test((e as Error).message);
      await assert.rejects(() => env.resume(owner, attemptId), gone);
      await assert.rejects(() => env.resume(agentPrincipal, attemptId), gone);
      await assert.rejects(() => env.resume(owner, attemptId), gone);
      await detectors.settled();
      assert.equal(reports.length, 1, "three launches meeting the same damage are one report");
      assert.equal(reports[0]!.kind, "integrity-check-failed");
      assert.match(reports[0]!.key, /^environments:[0-9a-f]{24}$/);
      // A bad attempt ID is a refusal, not an integrity failure: nothing more is told.
      await assert.rejects(() => env.resume(owner, "att-aaaaaaaaaaaaaaaaaaaa"), (e) => (e as { code?: string }).code === "forbidden");
      await detectors.settled();
      assert.equal(reports.length, 1);

      // A failed activation seen by the applier: the worker came back with another extension on disk; the change is rolled back, and the failure is told once; the repeat of the request replays and tells nothing.
      const pauses = PauseService.withEpoch(world.storage, epoch, {}, options);
      const stops = StopService.withEpoch(world.storage, epoch, pauses, new Stopping(), options);
      const rt = new Runtime();
      const journal = new MemoryJournal();
      const applier = new EnvironmentChangeApplier({ environments: env, pauses, stops, runtime: rt, journal, pollMs: 1 });
      rt.reloadResults = [{ ok: true, observed: { "nimblenewt.desk": D("7") } }];
      const out = await applier.apply(view(agentId, "mnt-integ"));
      assert.equal(out.outcome, "failed", JSON.stringify(out));
      assert.match((out as { reason: string }).reason, /was not activated/);
      await detectors.settled();
      assert.equal(reports.length, 2, "the failed activation is one more report");
      assert.match(reports[1]!.key, /^environments:[0-9a-f]{24}$/);
      assert.notEqual(reports[1]!.key, reports[0]!.key, "different damage is a different key");
      const again = await applier.apply(view(agentId, "mnt-integ"));
      assert.equal(again.outcome, "failed");
      await detectors.settled();
      assert.equal(reports.length, 2, "a repeat of the rolled-back request tells nothing new");
      // The same kind of failure for a later change (another revision number) is the same key: digits are not part of it.
      rt.reloadResults = [{ ok: true, observed: { "nimblenewt.desk": D("7") } }];
      assert.equal((await applier.apply({ ...view(agentId, "mnt-integ2"), spec: { name: "fd", version: "9.0.0", digest: D("1"), source: "https://example.org/fd.tgz", installScripts: false } })).outcome, "failed");
      await detectors.settled();
      assert.equal(reports.length, 2);

      // A failing watch changes nothing for the caller.
      broken = true;
      await assert.rejects(() => env.activate(owner, { commandId: cid("a"), agentId, revision: 1, observed: { "nimblenewt.desk": D("8") } }), (e) => (e as { code?: string }).code === "integrity");
      await assert.rejects(() => env.resume(owner, attemptId), gone);
      // A detector that throws at once (not only one whose report fails later) changes nothing either: the same error, and a sound call's result is unchanged.
      const throwing = watchIntegrity(raw, "environments", ["resume", "activate"], () => { throw new Error("the detector is broken"); });
      await assert.rejects(() => throwing.resume(owner, attemptId), gone);
      await assert.rejects(() => throwing.activate(owner, { commandId: cid("a"), agentId, revision: 1, observed: { "nimblenewt.desk": D("6") } }), (e) => (e as { code?: string }).code === "integrity" && /was not activated/.test((e as Error).message));
      assert.equal((await throwing.get(owner, agentId))?.active?.revision, 1);
    } finally { await world.close(); }
  });
}
