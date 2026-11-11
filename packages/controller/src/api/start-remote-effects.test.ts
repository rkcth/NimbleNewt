import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdmissionService } from "../admission/service.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI, EXEC_PROFILES, ROUTING_TABLE } from "../dispatch/testing/world.js";
import { DifficultyService } from "../routing/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import type { EffectBridge } from "../domain/effects.js";
import { PolicyService } from "../policy/index.js";
import { RemoteWorkerClient } from "../remote/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] };


type Api = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => Promise<{ ok: boolean; result?: any; error?: { code: string; message?: string } }>;
const full = { formats: [1], features: ["limits", "wall-time"], enforces: { cpus: "full", memoryMb: "full", diskMb: "full", processes: "full", wallTimeMs: "full" } } as const;

async function world(bridges?: Record<string, EffectBridge>) {
  const d = mkdtempSync(join(tmpdir(), "nn-remote-contract-"));
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: {
      timer: new ManualTimer(), manual: true, ...(bridges === undefined ? {} : { dispatcher: { bridges } }),
      route: async () => ({ route: "localp/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: false } }),
      remote: { blobDirectory: join(d, "blobs"), hosts: [{ hostId: "host:r1", window: () => 131_072, checkpointWaitMs: 300, pollMs: 20, resources: { cpus: 1, memoryMb: 1024 }, requirements: () => ({ data: "cloud-allowed", harness: "pi" }) }] },
    },
  });
  assert.ok(c.dispatch?.workerUrl !== undefined, c.dispatchProblem);
  const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
  const rob = await c.services.principals.authenticate(boot.token);
  const api: Api = (token, op, args, commandId) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as never;
  await c.services.routing.setTable(rob, { commandId: "rt", expectedRevision: 0, table: { ...ROUTING_TABLE, profiles: { "r-local": ["localp/small", "cloudp/big"] }, roles: { coordinator: "r-local", "safety-supervisor": "r-local" } } } as never);
  await DifficultyService.withEpoch(c.storage, c.epoch, c.services.routing, c.services.contracts).setProfiles(rob, { commandId: "sp", expectedRevision: 0, profiles: EXEC_PROFILES } as never);
  const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
  await c.services.principals.enroll(rob, { commandId: "e-r1", kind: "host", name: "r1", grants: [] });
  const hostToken = (await c.services.principals.issueCredential(rob, "host:r1")).token;
  await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap", actor: rob.id, host: "host:r1", capacity: { cpus: 8, memoryMb: 16_384 } });
  await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "agt-abcdefghijklmnopqrst", grants: [{ action: "attempt.work", project }, { action: "task.read", project }, { action: "effect.perform", project }, { action: "review.request", project }, { action: "tool.git-push", project }] as never });
  const client = new RemoteWorkerClient({ url: c.dispatch!.workerUrl!, token: hostToken, workerVersion: "worker-9.1.0" });
  await client.connect(CAPS as never);
  let beat = 0;
  await client.heartbeat(++beat);
  let n = 0;
  const attempt = async (title: string, permissions?: string[]) => {
    const k = n++;
    const task = (await c.services.projects.createTask({ commandId: `t${k}`, actor: rob.id, projectId: project, title })).id;
    await c.services.projects.transitionTask({ commandId: `r${k}`, actor: rob.id, taskId: task, expectedRevision: 1, to: "ready" });
    if (permissions !== undefined) assert.ok((await api(boot.token, "contract.set", { taskId: task, expectedVersion: 0, permissions }, `cs${k}`)).ok);
    await c.services.assignments.assignTask({ commandId: `as${k}`, actor: rob.id, taskId: task, owner: { kind: "agent", id: "agt-abcdefghijklmnopqrst" } });
    const a = (await c.services.assignments.getAssignment(task))!;
    const attemptId = (await c.services.assignments.admitAttempt({ commandId: `ad${k}`, actor: "inbox", taskId: task, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: "agt-abcdefghijklmnopqrst" }, harness: "pi" })).id;
    await client.heartbeat(++beat);
    const report = await c.dispatch!.dispatcher.tick();
    return { task, attemptId, report };
  };
  const offered = async (attemptId: string) => {
    const offer = (await client.offers()).find((o) => o.order.attemptId === attemptId);
    assert.ok(offer, "the attempt was offered");
    const mine = client.attempt(attemptId, offer!.placement);
    await mine.accept();
    return { offer: offer!, mine };
  };
  return { c, d, api, ownerToken: boot.token, client, attempt, offered, done: async () => { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } };
}


test("a remote worker's effect call runs through the composed controller's ledger and its own bridge, once; a controller with no bridge for the kind refuses it and records nothing (card H12a)", async () => {
  const log = { applied: 0 };
  const w = await world({ "git-push": { idempotent: false, execute: async () => { log.applied++; return { receipt: "r" }; }, reconcile: async () => ({ state: log.applied > 0 ? "applied" : "not_applied" }) } });
  try {
    const owner = await w.c.services.principals.authenticate(w.ownerToken);
    await PolicyService.withEpoch(w.c.storage, w.c.epoch, w.c.services.grants).set(owner, { scope: "installation", commandId: "pol", profile: "autonomous" } as never);
    const a = await w.attempt("Push the seeds", ["class.inspect", "class.push"]);
    assert.ok(a.report.started.includes(a.attemptId), JSON.stringify({ s: a.report.skipped, f: a.report.failures }));
    const { offer, mine } = await w.offered(a.attemptId);
    assert.deepEqual(await mine.honorContract(offer.order, full as never), { ok: true });
    const call = { callId: "p1", tool: { name: "git-push", version: "2.0" }, args: { branch: "feature-x" }, target: { kind: "branch", id: "feature-x" } };
    const effect = { kind: "git-push", target: "repo", input: { branch: "feature-x" } };
    const first = await mine.effect(call, effect);
    assert.equal(first.state, "confirmed", JSON.stringify(first));
    assert.deepEqual(await mine.effect(call, effect), first, "a message sent again is the same call");
    assert.equal(log.applied, 1);
    await assert.rejects(() => mine.effect({ ...call, callId: "p2" }, { ...effect, kind: "git-force-push" }), (e: { code?: string }) => e.code === "invalid_command");
    assert.equal(log.applied, 1);
  } finally { await w.done(); }
});

test("a composed controller started with no bridges refuses every remote effect call and applies nothing (card H12a)", async () => {
  const w = await world();
  try {
    const owner = await w.c.services.principals.authenticate(w.ownerToken);
    await PolicyService.withEpoch(w.c.storage, w.c.epoch, w.c.services.grants).set(owner, { scope: "installation", commandId: "pol", profile: "autonomous" } as never);
    const a = await w.attempt("Push the seeds", ["class.inspect", "class.push"]);
    const { offer, mine } = await w.offered(a.attemptId);
    assert.deepEqual(await mine.honorContract(offer.order, full as never), { ok: true });
    await assert.rejects(() => mine.effect({ callId: "p1", tool: { name: "git-push", version: "2.0" }, args: {} }, { kind: "git-push", target: "repo", input: {} }), (e: { code?: string; message?: string }) => e.code === "invalid_command" && /no bridge/.test(e.message ?? ""));
  } finally { await w.done(); }
});
