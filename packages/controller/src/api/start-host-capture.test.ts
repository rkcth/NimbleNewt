import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { AdmissionService } from "../admission/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI, ScriptedWorker, EXEC_PROFILES, workGrants } from "../dispatch/testing/world.js";
import type { WorkerTurnResult } from "../dispatch/ports.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { HostService } from "../hosts/index.js";
import { PolicyService } from "../policy/index.js";
import { DifficultyService } from "../routing/index.js";
import { startTestServer, withClient, type TestServer } from "../storage/postgres/testing/server.js";
import type { JsonObject } from "../storage/types.js";
import { startController, type Controller, type StartOptions } from "./index.js";

// Card L04d through the composed controller: a worker host's turn ends with a checkpoint, the dispatcher captures it as the task's continuation, and the resumed attempt is checked against that capture —
// the third piece of the checked resume, with no owner or host calling continuation.capture by hand. Also: a route that differs from the one the checkpoint was taken on is a resume after a change of model.
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const TABLE = (order: string[]) => ({
  providers: { localp: { enabled: true, paid: false, location: "local" }, localq: { enabled: true, paid: false, location: "local" } },
  routes: { "localp/small": { contextTokens: 128_000, capabilities: ["tools"] }, "localq/other": { contextTokens: 128_000, capabilities: ["tools"] } },
  profiles: { "r-local": order }, roles: { coordinator: "r-local", "safety-supervisor": "r-local" },
});
/** The checkpoint the local Pi host hands the dispatcher after a turn: the adapter's reference and the process's read-back check. */
const piCheckpoint = (at: number, durable?: { verified: boolean; error?: string }): JsonObject => ({
  pi: { format: 2, conversationId: 1, at, digest: `v1:sha256:${"c".repeat(64)}`, runtime: { name: "pi-durable", version: "1.3.0" }, historyFormat: "pi-durable:1", contractsVersion: 1 },
  nn: { turnSeq: at, ...(durable === undefined ? {} : { durable }) },
} as unknown as JsonObject);

// The stores a controller can be started on. The typical tier (NIMBLENEWT_TIER=typical) runs SQLite only.
let server: Promise<TestServer> | undefined;
after(async () => { if (server !== undefined) await (await server).stop(); });
interface Store { readonly name: string; open(): Promise<{ storage: StartOptions["storage"]; close(): Promise<void> }> }
const stores: Store[] = [
  { name: "SQLite", open: async () => { const d = mkdtempSync(join(tmpdir(), "nn-hostcap-")); return { storage: { kind: "sqlite", path: join(d, "c.sqlite") }, close: async () => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) }; } },
  ...(process.env["NIMBLENEWT_TIER"] === "typical" ? [] : [{ name: "PostgreSQL", open: async () => {
    server ??= startTestServer();
    const s = await server;
    const schema = `hostcap_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    return { storage: { kind: "postgres" as const, url: s.url(), schema }, close: async () => { await withClient(s.url(), async (cl) => { await cl.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }); } };
  } }]),
];

interface Run { readonly c: Controller; readonly worker: ScriptedWorker; readonly taskId: string; readonly attemptId: string; readonly owner: Awaited<ReturnType<Controller["services"]["principals"]["authenticate"]>>; tick(n?: number): Promise<void>; close(): Promise<void> }

/** A controller with one local scripted host whose first turn stops early with `first` (W03 readmits it from its checkpoint), and whose later turns finish. */
async function begin(store: Store, first: WorkerTurnResult, dispatch: Record<string, unknown> = {}): Promise<Run> {
  const db = await store.open();
  let turns = 0;
  const worker = new ScriptedWorker("host:w1", async () => (++turns === 1 ? first : { status: "completed", text: "done", endKind: "normal" }));
  const c: Controller = await startController({
    storage: db.storage, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: { timer: new ManualTimer(), manual: true, workers: [worker], ...dispatch },
  } as never);
  const s = c.services;
  const boot = await s.principals.bootstrapOwner({ name: "rob" });
  const owner = await s.principals.authenticate(boot.token);
  await s.routing.setTable(owner, { commandId: "rt", expectedRevision: 0, table: TABLE(["localp/small", "localq/other"]) } as never);
  await DifficultyService.withEpoch(c.storage, c.epoch, s.routing, s.contracts).setProfiles(owner, { commandId: "sp", expectedRevision: 0, profiles: EXEC_PROFILES } as never);
  await s.principals.enroll(owner, { commandId: "e-host", kind: "host", name: "w1", grants: [] });
  const hostP = await s.principals.authenticate((await s.principals.issueCredential(owner, "host:w1")).token);
  const hosts = HostService.withEpoch(c.storage, c.epoch, s.assignments);
  await hosts.announce(hostP, { commandId: "an", capabilities: { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] } });
  await hosts.heartbeat(hostP, { commandId: "hb", sequence: 1 });
  await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap", actor: owner.id, host: "host:w1", capacity: { cpus: 8, memoryMb: 16_384 } });
  await PolicyService.withEpoch(c.storage, c.epoch, s.grants).set(owner, { scope: "installation", commandId: "pol", profile: "autonomous" } as never);
  const project = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
  const annId = (await s.agents.create(owner, { commandId: "ag-a", friendlyName: "ann" })).id;
  for (const g of workGrants(project)) await s.grants.grant(owner, { commandId: `g-${g.action}`, grantee: `agent:${annId}`, action: g.action, project, source: "direct", basis: "test" });
  const taskId = (await s.projects.createTask({ commandId: "t1", actor: owner.id, projectId: project, title: "Water the beds" })).id;
  await s.projects.transitionTask({ commandId: "r1", actor: owner.id, taskId, expectedRevision: 1, to: "ready" });
  await s.assignments.assignTask({ commandId: "as1", actor: owner.id, taskId, owner: { kind: "agent", id: annId } });
  const a = (await s.assignments.getAssignment(taskId))!;
  const attemptId = (await s.assignments.admitAttempt({ commandId: "ad1", actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: annId }, harness: "pi" })).id;
  return {
    c, worker, taskId, attemptId, owner,
    tick: async (n = 1) => { for (let i = 0; i < n; i++) await c.dispatch!.dispatcher.tick(); },
    close: async () => { await c.close(); await db.close(); },
  };
}

const stoppedEarly = (checkpoint: JsonObject): WorkerTurnResult => ({ status: "completed", text: "Now let me run the tests:", endKind: "announced-step-without-tool-call", visibleChars: 25, checkpoint } as WorkerTurnResult);
const continuationsOf = async (r: Run) => (await r.c.storage.listAggregates("continuation", { limit: 50 })).map((x) => ({ id: x.id, ...(x.body as unknown as { taskId: string; status: string; capturedBy: string; boundary: { kind: string }; checkpoint: { at: number }; problem?: string }) })).filter((x) => x.taskId === r.taskId);
const checksOf = async (r: Run) => (await r.c.storage.listAggregates("resume-check", { limit: 50 })).map((x) => ({ id: x.id, ...(x.body as unknown as { taskId: string; phase: string; continuationId?: string; after: string; model: { id: string }; previousModel?: { id: string } }) })).filter((x) => x.taskId === r.taskId);
const resumesOf = async (r: Run) => (await r.c.storage.listAggregates("continuation-resume", { limit: 50 })).map((x) => x.body as unknown as { taskId: string; continuationId: string; modelChanged: boolean; after: string; previousModel?: { id: string } }).filter((x) => x.taskId === r.taskId);

for (const store of stores) {
  test(`${store.name}: a host's turn that ends with a checkpoint that reads back is captured as the task's continuation, and the resumed attempt is checked against that capture and goes on (card L04d)`, async () => {
    const r = await begin(store, stoppedEarly(piCheckpoint(41, { verified: true })));
    try {
      await r.tick(6);
      const caps = await continuationsOf(r);
      assert.equal(caps.length, 1, JSON.stringify(caps));
      assert.deepEqual([caps[0]!.status, caps[0]!.capturedBy, caps[0]!.boundary.kind, caps[0]!.checkpoint.at], ["complete", "service:dispatcher", "turn-complete", 41]);
      // The attempt was readmitted from that checkpoint and checked against that very capture before it went on.
      const checks = await checksOf(r);
      assert.equal(checks.length, 1, JSON.stringify(checks));
      assert.deepEqual([checks[0]!.phase, checks[0]!.continuationId, checks[0]!.after], ["done", caps[0]!.id, "continue"]);
      const resumes = await resumesOf(r);
      assert.deepEqual(resumes.map((x) => [x.continuationId, x.modelChanged]), [[caps[0]!.id, false]], "one resume is recorded, from the host's capture");
      assert.equal(r.worker.starts.length, 2, "the attempt went on in a second run");
      assert.deepEqual(r.worker.starts[1]!.resumeFrom, piCheckpoint(41, { verified: true }), "from the checkpoint that was captured");
    } finally { await r.close(); }
  });

  test(`${store.name}: a checkpoint the host did not read back is kept as an incomplete capture with its reason and is never resumed from; with captures off nothing is captured (card L04d)`, async () => {
    const unread = await begin(store, stoppedEarly(piCheckpoint(7, { verified: false, error: "the checkpoint did not read back: history_changed" })));
    try {
      await unread.tick(6);
      const caps = await continuationsOf(unread);
      assert.deepEqual(caps.map((x) => [x.status, x.problem]), [["incomplete", "the checkpoint did not read back: history_changed"]]);
      assert.deepEqual(await checksOf(unread), [], "no complete continuation, so there is nothing to check the resume against (as before L04d)");
      assert.equal(unread.worker.starts.length, 2, "and the attempt goes on from its checkpoint as before");
    } finally { await unread.close(); }
    const off = await begin(store, stoppedEarly(piCheckpoint(7, { verified: true })), { captureContinuations: false });
    try {
      await off.tick(6);
      assert.deepEqual(await continuationsOf(off), []);
      assert.deepEqual(await checksOf(off), []);
      assert.equal(off.worker.starts.length, 2);
    } finally { await off.close(); }
  });

  test(`${store.name}: a resume on a route other than the one the checkpoint was taken on is checked and recorded as a change of model, naming the model before (card L04d)`, async () => {
    const r = await begin(store, stoppedEarly(piCheckpoint(41, { verified: true })));
    try {
      // The first run, on the first route of the profile, stops early and is readmitted from its checkpoint.
      await r.tick(1);
      assert.equal(r.worker.starts[0]!.route, "localp/small");
      for (let i = 0; i < 3 && (await r.c.dispatch!.dispatcher.get(r.c.dispatch!.principal, r.attemptId))?.state !== "waiting"; i++) await r.tick(1);
      // Before it goes on, the owner puts another route first.
      const s = r.c.services;
      const rev = (await r.c.storage.getAggregate({ kind: "routing-table", id: "routing" }))!.revision;
      await s.routing.setTable(r.owner, { commandId: "rt2", expectedRevision: rev, table: TABLE(["localq/other", "localp/small"]) } as never);
      await r.tick(5);
      assert.equal(r.worker.starts.length, 2, JSON.stringify(r.worker.starts.map((x) => x.route)));
      assert.equal(r.worker.starts[1]!.route, "localq/other");
      const checks = await checksOf(r);
      assert.deepEqual(checks.map((x) => [x.phase, x.after, x.model.id, x.previousModel?.id]), [["done", "model-change", "other", "small"]]);
      assert.deepEqual((await resumesOf(r)).map((x) => [x.after, x.modelChanged, x.previousModel?.id]), [["model-change", true, "small"]]);
    } finally { await r.close(); }
  });
}
