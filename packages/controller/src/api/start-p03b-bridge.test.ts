import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { ROUTING_TABLE, EXEC_PROFILES, PI, ScriptedWorker } from "../dispatch/testing/world.js";
import type { ToolGateway, WorkOrder } from "../dispatch/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { AdmissionService } from "../admission/index.js";
import { HostService } from "../hosts/index.js";
import { PolicyService } from "../policy/index.js";
import { DifficultyService } from "../routing/index.js";
import { SimulatedServices } from "../service-ops/index.js";
import type { BridgeResponse } from "../toolbridge/index.js";
import { startController } from "./index.js";
import type { DispatchStartOptions } from "./dispatch-compose.js";

// Card P03b, composed: a running worker does non-code work through the protected tool bridge with the same rules as the API. It reads and repairs a service resource it has the right on
// (`service.observe`, `service.operate`), is refused before anything changes for a resource or a cascade outside its right, publishes its findings (`artifact.publish`), drafts deliverables
// that name them and the verified operation (`deliverable.draft`) and submits them (`deliverable.submit`) against the contract version its attempt began with. Nothing names a task, a
// responsible agent or a contract version: they come from the attempt.
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
type Reply = Record<string, any>;
const good = (r: BridgeResponse): Reply => { assert.equal(r.ok, true, JSON.stringify(r)); return (r as { result: Reply }).result; };
const refused = (r: BridgeResponse, code: string): string => { assert.equal(r.ok, false, JSON.stringify(r)); assert.equal((r as { code: string }).code, code, JSON.stringify(r)); return (r as { message: string }).message; };
type BuildServices = Parameters<NonNullable<DispatchStartOptions["local"]>["build"]>[0];
type Send = (op: string, args: Record<string, unknown>, callId: string) => Promise<BridgeResponse>;

test("a worker repairs a service, publishes its findings and drafts and submits its deliverables through the bridge, with the API's scope, fence and ledger rules; nothing names its task (card P03b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-p03b-bridge-"));
  const sim = new SimulatedServices({
    billing: { db: { state: { size: 10 }, dependents: [{ service: "billing", resource: "api" }] }, api: { state: {} }, cache: { state: {} } },
  });
  let services: BuildServices | undefined;
  let script: (ctx: { order: WorkOrder; gateway: ToolGateway }) => Promise<any> = async () => ({ status: "completed", text: "done" });
  const worker = new ScriptedWorker("host:w1", (ctx) => script(ctx as never));
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    artifacts: { directory: join(d, "blobs") }, serviceTarget: sim,
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
    // Ann writes reports (author, docs) and may repair ONE resource: billing/cache. No project-wide effect.perform.
    const ann = (await s.agents.create(owner, { commandId: "ag-ann", friendlyName: "Ann", roles: ["author", "docs"] } as never)).id;
    const grants: { action: string; resource?: { kind: string; id: string } }[] = [
      { action: "attempt.work" }, { action: "review.request" }, { action: "task.read" }, { action: "artifact.publish" }, { action: "effect.perform", resource: { kind: "service", id: "billing/cache" } },
    ];
    for (const [i, g] of grants.entries()) await s.grants.grant(owner, { commandId: `g-${i}`, grantee: `agent:${ann}`, action: g.action, project, ...(g.resource === undefined ? {} : { resource: g.resource }), source: "direct", basis: "work" } as never);
    const taskId = (await s.projects.createTask({ commandId: "t-1", actor: owner.id, projectId: project, title: "Tune the billing cache" })).id;
    const otherTask = (await s.projects.createTask({ commandId: "t-2", actor: owner.id, projectId: project, title: "Someone else's report" })).id;
    // The task has a contract (version 1) before the attempt begins: a submission is checked against THAT version, not against 0.
    const call = async (op: string, args: Record<string, unknown>, commandId?: string): Promise<Reply> => (await c.api.handle(ownerToken, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as Reply;
    const setContract = async (expectedVersion: number, criterion: string, commandId: string): Promise<void> => { const r = await call("contract.set", { taskId, expectedVersion, acceptanceCriteria: [criterion] }, commandId); assert.equal(r["ok"], true, JSON.stringify(r)); };
    await setContract(0, "the cache keeps entries for a minute", "ct-1");
    await s.projects.transitionTask({ commandId: "r-1", actor: owner.id, taskId, expectedRevision: 1, to: "ready" });
    await s.assignments.assignTask({ commandId: "as-1", actor: owner.id, taskId, owner: { kind: "agent", id: ann } });
    const a = (await s.assignments.getAssignment(taskId))!;
    await s.assignments.admitAttempt({ commandId: "ad-1", actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: ann }, harness: "pi" });

    const cache = { service: "billing", resource: "cache" };
    const db = { service: "billing", resource: "db" };
    const seen: Reply = {};
    let failure: unknown;
    script = async ({ order, gateway }) => {
      const send: Send = (op, args, callId) => services!.bridge!(order, gateway.call, order.credential, { op, callId, args });
      try {
        // Reading: the resource it has the right on; another resource is refused.
        const looked = good(await send("service.observe", cache, "o-1"));
        assert.equal(looked["systemVersion"], `v${sim.versionOf(cache)}`);
        refused(await send("service.observe", db, "o-2"), "forbidden");
        refused(await send("service.observe", { ...cache, taskId: "task-aaaaaaaaaaaaaaaaaaaa" }, "o-3"), "invalid_command");
        // The repair: recorded in the ledger, applied once, read back from the service.
        const set = { ...cache, action: { type: "set", params: { fields: { ttl: 60 } } } };
        const op = good(await send("service.operate", set, "op-1"));
        assert.equal(op["status"], "confirmed", JSON.stringify(op));
        assert.equal(op["outcome"]["reference"], op["effectId"]);
        assert.deepEqual(sim.stateOf(cache), { ttl: 60 });
        assert.equal(good(await send("service.operate", set, "op-1"))["effectId"], op["effectId"], "the same call ID is the same operation");
        assert.equal(sim.calls.filter((x) => x.applied).length, 1, "applied once");
        // Outside the right: refused before anything is done, also for an action that would cascade.
        const dbBefore = sim.versionOf(db);
        refused(await send("service.operate", { ...db, action: { type: "restart" } }, "op-2"), "forbidden");
        assert.equal(sim.versionOf(db), dbBefore, "nothing changed");
        assert.equal(sim.calls.filter((x) => x.applied).length, 1);
        refused(await send("service.operate", { ...set, taskId: "task-aaaaaaaaaaaaaaaaaaaa" }, "op-3"), "invalid_command");
        // The findings, and two deliverables: a report naming them and the operational outcome naming the verified operation.
        const art = good(await send("artifact.publish", { name: "Cache findings", files: [{ path: "findings.md", text: "# The TTL was unset; set to 60 s." }] }, "ap-1"));
        const report = good(await send("deliverable.draft", { type: "report", title: "Cache findings", artifacts: [{ artifactId: art["id"] }] }, "dd-1"));
        const outcome = good(await send("deliverable.draft", { type: "operational-outcome", title: "Cache TTL set", outcome: op["outcome"] }, "dd-2"));
        // What the attempt decides is not the caller's: the task, the responsible agent and an outcome that is not its own verified operation.
        refused(await send("deliverable.draft", { type: "report", title: "x", taskId: otherTask }, "dd-3"), "invalid_command");
        refused(await send("deliverable.draft", { type: "report", title: "x", responsibleAgent: "agent:someone" }, "dd-4"), "invalid_command");
        assert.equal((await send("deliverable.draft", { type: "operational-outcome", title: "Made up", outcome: { ...op["outcome"], systemVersion: "v999" } }, "dd-5")).ok, false, "an outcome the service did not report");
        // Submitting is against the contract version the attempt began with; the agent cannot name one.
        refused(await send("deliverable.submit", { id: report["id"], expectedRevision: report["revision"], contractVersion: 0 }, "ds-0"), "invalid_command");
        good(await send("deliverable.submit", { id: report["id"], expectedRevision: report["revision"] }, "ds-1"));
        good(await send("deliverable.submit", { id: outcome["id"], expectedRevision: outcome["revision"] }, "ds-2"));
        // A deliverable of another task (the owner made Ann responsible for it) is not reached through this attempt's credential.
        const foreign = await call("deliverable.draft", { taskId: otherTask, type: "report", title: "Elsewhere", responsibleAgent: `agent:${ann}` }, "dd-foreign");
        assert.equal(foreign["ok"], true, JSON.stringify(foreign));
        refused(await send("deliverable.submit", { id: foreign["result"]["id"], expectedRevision: foreign["result"]["revision"] }, "ds-3"), "not_found");
        // An operation the service refuses, and one whose read-back does not match: answered with their real standing, never confirmed, and no outcome to name.
        sim.faults.refuseNext = "the cache is busy";
        const refusedOp = good(await send("service.operate", { ...cache, action: { type: "set", params: { fields: { ttl: 61 } } } }, "op-4"));
        assert.deepEqual([refusedOp["status"], refusedOp["outcome"]], ["failed", undefined], JSON.stringify(refusedOp));
        sim.faults.corruptNext = true;
        const unsure = good(await send("service.operate", { ...cache, action: { type: "set", params: { fields: { ttl: 62 } } } }, "op-5"));
        assert.deepEqual([unsure["status"], unsure["outcome"]], ["uncertain", undefined], JSON.stringify(unsure));
        // The owner changes the contract while the attempt runs: a submission is now refused as stale, and the agent cannot name the new version to get past it.
        await setContract(1, "the cache keeps entries for two minutes", "ct-2");
        const late = good(await send("deliverable.draft", { type: "report", title: "Late findings", artifacts: [{ artifactId: art["id"] }] }, "dd-6"));
        assert.match(refused(await send("deliverable.submit", { id: late["id"], expectedRevision: late["revision"] }, "ds-4"), "stale_revision"), /changed after this attempt began \(it was version 1\); this attempt cannot submit/);
        assert.match(refused(await send("deliverable.submit", { id: late["id"], expectedRevision: late["revision"] + 5 }, "ds-6"), "stale_revision"), /the deliverable is at revision/, "a stale deliverable revision keeps the API's words");
        refused(await send("deliverable.submit", { id: late["id"], expectedRevision: late["revision"], contractVersion: 2 }, "ds-5"), "invalid_command");
        Object.assign(seen, { refusedOp, unsure, late });
        Object.assign(seen, { op, art, report, outcome });
      } catch (error) { failure = error; throw error; }
      return { status: "completed", text: "done" };
    };
    await c.dispatch.dispatcher.tick();
    await c.dispatch.dispatcher.idle();
    if (failure !== undefined) throw failure;
    assert.ok(seen["outcome"] !== undefined, "the worker ran");
    // What the owner reads afterwards: both submitted (not accepted), Ann responsible, the outcome names the confirmed, verified effect of THIS task.
    const read = async (id: string) => ((await c.api.handle(ownerToken, { v: 1, op: "deliverable.record.get", args: { id } } as never)) as Reply)["result"]["item"];
    const r = await read(seen["report"]["id"]);
    assert.deepEqual([r.state, r.type, r.responsibleAgent, r.taskId, r.version.content.artifacts.map((x: Reply) => x.artifactId)], ["submitted", "report", `agent:${ann}`, taskId, [seen["art"]["id"]]]);
    const o = await read(seen["outcome"]["id"]);
    assert.deepEqual([o.state, o.type, o.version.content.outcome.reference], ["submitted", "operational-outcome", seen["op"]["effectId"]]);
    const row = await c.storage.getEffect(seen["op"]["effectId"]);
    assert.deepEqual([row!.status, row!.target, (row!.evidence as Reply)["verified"]], ["confirmed", "service:billing/cache", true]);
    assert.equal(r.version.contractVersion, 1, "checked against the contract version the attempt began with");
    assert.equal((await read(seen["late"]["id"])).state, "draft", "the stale submission left it in draft");
    // The task's activity: each service operation is a step carrying where the operation really stands (a repeat is one step); a read is no step.
    const steps = ((await call("activity.steps", { taskId })) ["result"]["steps"] as { kind: string; summary: string; outcome?: string; manifest: { refs: { kind: string; id: string }[] } }[]).filter((x) => x.kind === "tool-call");
    const of = (effectId: string) => steps.filter((x) => x.manifest.refs.some((ref) => ref.kind === "effect" && ref.id === effectId)).map((x) => x.outcome);
    assert.deepEqual([of(seen["op"]["effectId"]), of(seen["refusedOp"]["effectId"]), of(seen["unsure"]["effectId"])], [["confirmed"], ["failed"], ["uncertain"]], JSON.stringify(steps));
    assert.equal(steps.filter((x) => /drafted deliverable/.test(x.summary)).length, 3, "three drafts through the bridge");
    assert.equal(steps.filter((x) => /submitted deliverable/.test(x.summary)).length, 2, "two submissions; the refused ones are no step");
    assert.ok(!steps.some((x) => /observe/.test(x.summary)), "a read is no step");
  } finally {
    await c.close();
    rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
