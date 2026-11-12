import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { AdmissionService } from "../admission/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI, ScriptedWorker, workGrants } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { HostService } from "../hosts/index.js";
import { PolicyService } from "../policy/index.js";
import { DifficultyService } from "../routing/index.js";
import { startTestServer, withClient, type TestServer } from "../storage/postgres/testing/server.js";
import { startController, type Controller, type StartOptions } from "./index.js";

// Card L04d follow-up through the composed controller: the shipped resume reviewer (the owner's own route, a model call) runs apart from the dispatcher's tick. While one resumed task's review is still
// out with the model, the tick comes back and dispatches another task; once the review answers, the held task starts, with one resume recorded. The model is an offline fixture that waits on a gate.
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const local = { enabled: true, paid: false, location: "local" as const };
const route = { contextTokens: 100_000, capabilities: ["tools"] };
const table = { providers: { strata: local, gpu2: local }, routes: { "strata/qwen": route, "gpu2/qwen": route }, profiles: { main: ["strata/qwen", "gpu2/qwen"] }, roles: { coordinator: "main", "safety-supervisor": "main" } };
const PROFILES = { profiles: { default: { harness: "pi", routingProfile: "main" } }, mapping: { unrated: "default" } };
const ANN = "agt-annannannannannannan";
const DIGEST = `v1:sha256:${"a".repeat(64)}`;
const capture = {
  identity: "conv-1", agent: `agent:${ANN}`, boundary: { kind: "turn-complete" as const }, checkpoint: { format: 2, conversationId: 7, at: 41, digest: DIGEST, runtime: { name: "pi-durable", version: "1.3.0" } }, durable: { verified: true },
  continuation: { artifacts: [], decisions: [], pendingEffects: [], budget: { spent: 1, remaining: 9, unit: "k-tokens" }, nextStep: "run the tests" },
  manifest: { summaryLineage: [], sourceRanges: [{ source: "history", from: 1, to: 41 }], compression: { state: "none" as const, compactions: 0 }, branches: [], messageCursor: 41, routingRevision: 1, environmentRevision: 1, adapter: { name: "pi-durable", version: "1.3.0" } },
  nonCheckpointableTools: [], scratchRecords: [], credentialRefs: [],
};
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const within = async <T>(ms: number, run: Promise<T>, what: string): Promise<T> => { let t: ReturnType<typeof setTimeout> | undefined; try { return await Promise.race([run, new Promise<never>((_, reject) => { t = setTimeout(() => reject(new Error(`${what} did not come back within ${ms} ms`)), ms); })]); } finally { clearTimeout(t); } };

let server: Promise<TestServer> | undefined;
after(async () => { if (server !== undefined) await (await server).stop(); });
interface Store { readonly name: string; open(): Promise<{ storage: StartOptions["storage"]; close(): Promise<void> }> }
const stores: Store[] = [
  { name: "SQLite", open: async () => { const d = mkdtempSync(join(tmpdir(), "nn-roff-")); return { storage: { kind: "sqlite", path: join(d, "c.sqlite") }, close: async () => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) }; } },
  ...(process.env["NIMBLENEWT_TIER"] === "typical" ? [] : [{ name: "PostgreSQL", open: async () => {
    server ??= startTestServer();
    const s = await server;
    const schema = `roff_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    return { storage: { kind: "postgres" as const, url: s.url(), schema }, close: async () => { await withClient(s.url(), async (cl) => { await cl.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }); } };
  } }]),
];

/** A worker that keeps its attempt running until its worker is stopped. */
function holdingWorker(): ScriptedWorker {
  return new ScriptedWorker("host:w1", async ({ worker: handle }) => {
    await new Promise<void>((resolve) => { const t = setInterval(() => { if (handle.stopped > 0) { clearInterval(t); resolve(); } }, 5); });
    return { status: "cancelled", text: "stopped" };
  });
}

const open = (storage: StartOptions["storage"], worker: ScriptedWorker, extra: Record<string, unknown> = {}): Promise<Controller> => startController({
  storage, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], dispatch: { timer: new ManualTimer(), manual: true, workers: [worker] }, ...extra,
} as never);

async function setUp(c: Controller): Promise<{ token: string; owner: Awaited<ReturnType<Controller["services"]["principals"]["authenticate"]>>; project: string }> {
  const s = c.services;
  const boot = await s.principals.bootstrapOwner({ name: "rob" });
  const owner = await s.principals.authenticate(boot.token);
  await s.routing.setTable(owner, { commandId: "rt", expectedRevision: 0, table } as never);
  await DifficultyService.withEpoch(c.storage, c.epoch, s.routing, s.contracts).setProfiles(owner, { commandId: "sp", expectedRevision: 0, profiles: PROFILES } as never);
  await s.principals.enroll(owner, { commandId: "e-host", kind: "host", name: "w1", grants: [] });
  const hostP = await s.principals.authenticate((await s.principals.issueCredential(owner, "host:w1")).token);
  const hosts = HostService.withEpoch(c.storage, c.epoch, s.assignments);
  await hosts.announce(hostP, { commandId: "an", capabilities: { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] } });
  await hosts.heartbeat(hostP, { commandId: "hb", sequence: 1 });
  await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap", actor: owner.id, host: "host:w1", capacity: { cpus: 8, memoryMb: 16_384 } });
  await PolicyService.withEpoch(c.storage, c.epoch, s.grants).set(owner, { scope: "installation", commandId: "pol", profile: "autonomous" } as never);
  const project = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
  await s.principals.enroll(owner, { commandId: `e-${ANN}`, kind: "agent", name: ANN, grants: [...workGrants(project)] });
  return { token: boot.token, owner, project };
}

async function task(c: Controller, owner: { id: string }, project: string, n: number, repositoryId?: string): Promise<{ taskId: string; attemptId: string }> {
  const s = c.services;
  const taskId = (await s.projects.createTask({ commandId: `t${n}`, actor: owner.id, projectId: project, title: `Water bed ${n}`, ...(repositoryId === undefined ? {} : { repositoryId }) })).id;
  await s.projects.transitionTask({ commandId: `r${n}`, actor: owner.id, taskId, expectedRevision: 1, to: "ready" });
  await s.assignments.assignTask({ commandId: `as${n}`, actor: owner.id, taskId, owner: { kind: "agent", id: ANN } });
  const a = (await s.assignments.getAssignment(taskId))!;
  return { taskId, attemptId: (await s.assignments.admitAttempt({ commandId: `ad${n}`, actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: ANN }, harness: "pi" })).id };
}

for (const store of stores) {
  test(`${store.name}: the resume reviewer's model call runs apart from the tick: another task is dispatched while it is out, the held task starts when it answers, one resume is recorded (card L04d follow-up)`, async () => {
    const db = await store.open();
    const root = mkdtempSync(join(tmpdir(), "nn-roff-checkout-"));
    let c = await open(db.storage, holdingWorker());
    /** Lets the offline reviewer model answer (also on a failed assertion, so the controller can close). */
    let release: () => void = () => undefined;
    try {
      const { token, owner, project } = await setUp(c);
      const call = async (op: string, args: Record<string, unknown>, commandId?: string): Promise<any> => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
      // The first task works in a bound folder; a file it relied on has changed since (the reviewer is asked only about changes that were observed).
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "a.ts"), "now", "utf8");
      assert.ok((await call("resource.bind", { projectId: project, kind: "repository", label: "src", locator: root, repositoryId: "repo-main" }, "b1")).ok);
      const one = await task(c, owner, project, 1, "repo-main");
      const two = await task(c, owner, project, 2);
      assert.deepEqual([...(await c.dispatch!.dispatcher.tick()).started].sort(), [one.attemptId, two.attemptId].sort());
      // The first task has a continuation and an input that changed since; the second has none (nothing to check).
      const host = await c.services.principals.authenticate((await c.services.principals.issueCredential(owner, "host:w1")).token);
      assert.ok((await c.services.continuations.capture(host, { commandId: "cap1", taskId: one.taskId, ...capture } as never)).id);
      assert.ok((await call("resume.dependencies.record", { taskId: one.taskId, dependencies: [{ kind: "file", key: "src/a.ts", hash: "d".repeat(64) }] }, "dep1")).ok);
      // An orderly restart: both attempts go back to waiting with their checkpoints. The new controller has a reviewer model that does not answer until the test lets it.
      await c.close();
      const gate = new Promise<void>((r) => { release = r; });
      const asked: string[] = [];
      const reviewerModel = {
        complete: async (): Promise<string> => { throw new Error("the routed client asks for the detailed reply"); },
        completeDetailed: async (route: string, request: { user: string }) => {
          asked.push(route);
          await gate;
          const ids = (request.user.match(/these ids: ([^\n]*)/)?.[1] ?? "").split(", ").filter((x) => x !== "");
          return { text: JSON.stringify(Object.fromEntries(ids.map((id) => [id, { relevant: false, rationale: "the task only reads the soil report" }]))), usage: { inputTokens: 10, outputTokens: 5 } };
        },
      };
      const worker = holdingWorker();
      c = await open(db.storage, worker, { reviewerModel });
      await c.services.configuration.change(owner, { commandId: "route", layer: "installation", set: { "resume.reviewerRoute": "gpu2/qwen" } } as never);
      for (const x of [one, two]) assert.equal((await c.dispatch!.dispatcher.get(owner, x.attemptId))!.state, "waiting");
      // Every tick comes back although the review does not; the second task is dispatched meanwhile and the first only waits.
      const started: string[] = [];
      let reason = "";
      for (let i = 0; i < 40 && !started.includes(two.attemptId); i++) {
        const t = await within(8000, c.dispatch!.dispatcher.tick(), "the tick");
        started.push(...t.started);
        reason = t.skipped.find((s) => s.attemptId === one.attemptId)?.reason ?? reason;
        await pause(25);
      }
      assert.deepEqual(started, [two.attemptId], "the second task started while the first one's review was out, and the first did not");
      assert.match(reason, /being run apart from the tick/);
      for (let i = 0; i < 200 && asked.length === 0; i++) await pause(20);
      assert.deepEqual(asked, ["gpu2/qwen"], "the reviewer was asked once, on the owner's route");
      release();
      const later: string[] = [];
      for (let i = 0; i < 40 && !later.includes(one.attemptId); i++) { later.push(...(await within(8000, c.dispatch!.dispatcher.tick(), "the tick")).started); await pause(25); }
      assert.deepEqual(later, [one.attemptId], "the held task starts once the review has answered");
      const check = (await call("resume.for-task", { taskId: one.taskId })).result.item;
      assert.deepEqual([check.phase, check.review?.state], ["done", "ran"], JSON.stringify(check));
      assert.deepEqual(asked, ["gpu2/qwen"], "still asked once");
      assert.equal((await c.storage.listAggregates("continuation-resume", { limit: 10 })).length, 1, "one resume recorded");
    } finally { release(); await c.close().catch(() => undefined); await db.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  });
}
