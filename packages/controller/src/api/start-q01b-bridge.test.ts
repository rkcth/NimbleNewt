import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { stopServer } from "../domain/testing/backends.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { ROUTING_TABLE, EXEC_PROFILES, PI, ScriptedWorker } from "../dispatch/testing/world.js";
import type { ToolGateway, WorkOrder } from "../dispatch/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { AdmissionService } from "../admission/index.js";
import { HostService } from "../hosts/index.js";
import { PolicyService } from "../policy/index.js";
import { DifficultyService } from "../routing/index.js";
import { startTestServer, type TestServer } from "../storage/postgres/testing/server.js";
import type { BridgeResponse } from "../toolbridge/index.js";
import { startController } from "./index.js";
import type { DispatchStartOptions } from "./dispatch-compose.js";

after(stopServer);

// Card Q01b, the agent's door: a running worker in the reviewer, qa or docs role records its submission through the protected tool bridge (`submission.record`), with the same checks as the API. The task comes from the attempt,
// the role from the kind, and a document change names an artifact of the task whose digest the controller recorded; code is never submitted this way (the host reads it at `work.end`). Run on SQLite and PostgreSQL (the
// composed controller's two stores; the reference store and the worker-thread SQLite are covered by the bridge's own suite in toolbridge/service.test.ts).
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
type Reply = Record<string, any>;
const good = (r: BridgeResponse): Reply => { assert.equal(r.ok, true, JSON.stringify(r)); return (r as { result: Reply }).result; };
const refused = (r: BridgeResponse, code: string): string => { assert.equal(r.ok, false, JSON.stringify(r)); assert.equal((r as { code: string }).code, code, JSON.stringify(r)); return (r as { message: string }).message; };
type BuildServices = Parameters<NonNullable<DispatchStartOptions["local"]>["build"]>[0];
type Storage = "sqlite" | { pg: TestServer };
const BASE = "c".repeat(40), TREE = "a".repeat(40), PATCH = "d".repeat(40);

async function reviewerThroughTheBridge(storage: Storage): Promise<void> {
  const d = mkdtempSync(join(tmpdir(), "nn-q01b-bridge-"));
  let services: BuildServices | undefined;
  let script: (ctx: { order: WorkOrder; gateway: ToolGateway }) => Promise<any> = async () => ({ status: "completed", text: "done" });
  const worker = new ScriptedWorker("host:w1", (ctx) => script(ctx as never));
  const c = await startController({
    storage: storage === "sqlite" ? { kind: "sqlite", path: join(d, "c.sqlite") } : { kind: "postgres", url: storage.pg.url(), schema: `q01bb_${process.pid}_${Math.random().toString(36).slice(2, 8)}` },
    argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], artifacts: { directory: join(d, "blobs") },
    dispatch: { timer: new ManualTimer(), manual: true, local: { window: () => 32768, acceptUnenforcedLimits: true, build: (s: BuildServices) => { services = s; return worker; } } },
    tools: { runner: { run: async () => ({ text: "{}" }) }, isLocalHost: (h: string) => h === "host:w1", facts: async () => ({ os: "linux", arch: "x64", interpreters: { node: "22.19.0" }, packages: {}, cpus: 8, memoryMb: 16_384 }) },
  } as never);
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const s = c.services;
    const ownerToken = (await s.principals.bootstrapOwner({ name: "rob" })).token;
    const owner = await s.principals.authenticate(ownerToken);
    await s.routing.setTable(owner, { commandId: "rt", expectedRevision: 0, table: { ...ROUTING_TABLE, roles: { coordinator: "r-cloud", "safety-supervisor": "r-cloud" } } } as never);
    await DifficultyService.withEpoch(c.storage, c.epoch, s.routing, s.contracts).setProfiles(owner, { commandId: "sp", expectedRevision: 0, profiles: EXEC_PROFILES } as never);
    await s.principals.enroll(owner, { commandId: "e-host", kind: "host", name: "w1", grants: [] });
    const hostP = await s.principals.authenticate((await s.principals.issueCredential(owner, "host:w1")).token);
    const hosts = HostService.withEpoch(c.storage, c.epoch, s.assignments);
    await hosts.announce(hostP, { commandId: "an", capabilities: { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] } });
    await hosts.heartbeat(hostP, { commandId: "hb", sequence: 1 });
    await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap", actor: owner.id, host: "host:w1", capacity: { cpus: 8, memoryMb: 16_384 } });
    await PolicyService.withEpoch(c.storage, c.epoch, s.grants).set(owner, { scope: "installation", commandId: "pol", profile: "autonomous" } as never);
    const project = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
    // `id` is the principal (`agent:...`); an assignment names the agent by its bare ID (`bare`), as the dispatcher reads it.
    const hire = async (name: string, roles: string[], actions: string[]): Promise<{ id: string; bare: string; token: string }> => {
      const made = await s.agents.create(owner, { commandId: `mk-${name}`, friendlyName: name, roles } as never);
      const id = `agent:${made.id}`;
      for (const [i, action] of actions.entries()) await s.grants.grant(owner, { commandId: `g-${name}-${i}`, grantee: id, action, project, source: "direct", basis: "work" } as never);
      return { id, bare: made.id, token: (await s.principals.issueCredential(owner, id)).token };
    };
    // Ann writes the code; Ben reviews, checks and documents it (reviewer, qa, docs: never director).
    const ann = await hire("Ann", ["author"], ["attempt.work", "task.read"]);
    const ben = await hire("Ben", ["reviewer", "qa", "docs"], ["attempt.work", "task.read", "artifact.publish"]);
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string): Promise<Reply> => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<Reply>;
    const taskId = (await s.projects.createTask({ commandId: "t-1", actor: owner.id, projectId: project, title: "Water the beds" })).id;
    const otherTask = (await s.projects.createTask({ commandId: "t-2", actor: owner.id, projectId: project, title: "Another task" })).id;
    await s.projects.transitionTask({ commandId: "r-1", actor: owner.id, taskId, expectedRevision: 1, to: "ready" });
    // Ann's code submission, as the host records it at her work.end (here through the API, during her attempt).
    await s.assignments.assignTask({ commandId: "as-1", actor: owner.id, taskId, owner: { kind: "agent", id: ann.bare } } as never);
    let a = (await s.assignments.getAssignment(taskId))!;
    await s.assignments.admitAttempt({ commandId: "ad-1", actor: owner.id, taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: ann.bare }, harness: "pi" } as never);
    const code = await call(ann.token, "submission.record", { taskId, kind: "code", role: "author", base: BASE, tree: TREE, patchId: PATCH }, "code-1");
    assert.equal(code["ok"], true, JSON.stringify(code));
    const codeId = code["result"]["id"] as string;
    // The task passes to Ben for review: his attempt runs on the same task.
    a = (await s.assignments.getAssignment(taskId))!;
    await s.assignments.transferTask({ commandId: "tr-1", actor: owner.id, taskId, expectedRevision: a.revision, to: { kind: "agent", id: ben.bare }, reason: "review" } as never);
    a = (await s.assignments.getAssignment(taskId))!;
    await s.assignments.admitAttempt({ commandId: "ad-2", actor: owner.id, taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: ben.bare }, harness: "pi" } as never);
    // An artifact of another task, which Ben's attempt must not be able to submit.
    const foreign = await call(ownerToken, "artifact.publish", { taskId: otherTask, name: "Elsewhere", files: [{ path: "x.md", text: "x" }] }, "ap-foreign");
    assert.equal(foreign["ok"], true, JSON.stringify(foreign));

    const seen: Reply = {};
    let failure: unknown;
    script = async ({ order, gateway }) => {
      const send = (op: string, args: Record<string, unknown>, callId: string): Promise<BridgeResponse> => services!.bridge!(order, gateway.call, order.credential, { op, callId, args });
      try {
        seen["review"] = good(await send("submission.record", { kind: "review", subject: codeId, verdict: "approve" }, "rv-1"));
        seen["review-again"] = good(await send("submission.record", { kind: "review", subject: codeId, verdict: "approve" }, "rv-1"));
        seen["qa"] = good(await send("submission.record", { kind: "qa", subject: codeId, report: "Every bed is watered." }, "qa-1"));
        const art = good(await send("artifact.publish", { name: "Watering guide", files: [{ path: "guide.md", text: "# Water each bed at dawn." }] }, "ap-1"));
        seen["art"] = art;
        seen["document"] = good(await send("submission.record", { kind: "document", artifactId: art["id"], report: "The guide says when." }, "doc-1"));
        // The rules of the service hold through the bridge: no role Ben lacks, no review of his own document, no artifact of another task, no code, no task or role of the agent's choosing.
        seen["signoff"] = refused(await send("submission.record", { kind: "signoff", subject: codeId, decision: "approve" }, "so-1"), "forbidden");
        seen["self-review"] = refused(await send("submission.record", { kind: "review", subject: seen["document"]["id"], verdict: "approve" }, "rv-2"), "forbidden");
        seen["foreign"] = refused(await send("submission.record", { kind: "document", artifactId: foreign["result"]["id"] }, "doc-2"), "not_found");
        seen["code"] = refused(await send("submission.record", { kind: "code" }, "cd-1"), "invalid_command");
        seen["task"] = refused(await send("submission.record", { kind: "review", subject: codeId, verdict: "approve", taskId: otherTask }, "rv-3"), "invalid_command");
        seen["role"] = refused(await send("submission.record", { kind: "review", role: "director", subject: codeId, verdict: "approve" }, "rv-4"), "invalid_command");
        seen["unknown-subject"] = refused(await send("submission.record", { kind: "review", subject: "sbm-aaaaaaaaaaaaaaaaaaaa", verdict: "approve" }, "rv-5"), "invalid_command");
      } catch (error) { failure = error; throw error; }
      return { status: "completed", text: "done" };
    };
    const ticked = await c.dispatch.dispatcher.tick();
    assert.deepEqual(ticked.failures ?? [], [], "Ben's attempt was dispatched");
    await c.dispatch.dispatcher.idle();
    if (failure !== undefined) throw failure;
    assert.ok(seen["review"] !== undefined, "the worker ran");
    assert.equal(seen["review-again"]["id"], seen["review"]["id"], "the same call records once");
    assert.equal(seen["review-again"]["replayed"], true);
    const get = async (id: string): Promise<Reply> => { const r = await call(ownerToken, "submission.get", { submissionId: id }); assert.equal(r["ok"], true, JSON.stringify(r)); return r["result"]["item"]; };
    const review = await get(seen["review"]["id"]);
    assert.deepEqual([review["kind"], review["role"], review["submittedBy"], review["taskId"], review["subject"], review["verdict"], review["tree"], review["patchId"]], ["review", "reviewer", ben.id, taskId, codeId, "approve", TREE, PATCH], "bound to the tree and patch it was given");
    const qa = await get(seen["qa"]["id"]);
    assert.deepEqual([qa["kind"], qa["role"], qa["subject"], qa["tree"]], ["qa", "qa", codeId, TREE]);
    const doc = await get(seen["document"]["id"]);
    const artifact = await c.storage.getAggregate({ kind: "artifact", id: seen["art"]["id"] });
    assert.deepEqual([doc["kind"], doc["role"], doc["artifactId"], doc["artifactDigest"], doc["makesCommit"]], ["document", "docs", seen["art"]["id"], `sha256:${(artifact!.body as { manifestDigest: string }).manifestDigest}`, false], "the digest the controller recorded at publication");
    for (const record of [review, qa, doc]) assert.equal(record["attemptId"], undefined, "only code names an attempt");
    const listed = await call(ownerToken, "submission.list", { taskId });
    assert.deepEqual((listed["result"]["items"] as Reply[]).map((x) => x["kind"]).sort(), ["code", "document", "qa", "review"], "nothing else was recorded");
    assert.match(seen["code"], /work-end submit true/);
    assert.match(seen["unknown-subject"], /no such submission for this task/);
    assert.match(seen["signoff"], /does not hold the role director/);
  } finally {
    await c.close();
    rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test("SQLite: a reviewer, qa and docs agent records its review, qa report and document change through the bridge for its own task; the service's rules hold (card Q01b)", () => reviewerThroughTheBridge("sqlite"));
test("PostgreSQL: a reviewer, qa and docs agent records its review, qa report and document change through the bridge for its own task; the service's rules hold (card Q01b)", async () => {
  const pg = await startTestServer();
  try { await reviewerThroughTheBridge({ pg }); } finally { await pg.stop(); }
});
