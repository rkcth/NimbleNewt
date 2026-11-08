import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { personalNamespace } from "../catalog/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { ROUTING_TABLE, EXEC_PROFILES, PI, ScriptedWorker, workGrants } from "../dispatch/testing/world.js";
import type { ToolGateway, WorkOrder } from "../dispatch/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { AdmissionService } from "../admission/index.js";
import { HostService } from "../hosts/index.js";
import { PolicyService } from "../policy/index.js";
import { DifficultyService } from "../routing/index.js";
import type { BridgeResponse } from "../toolbridge/index.js";
import { startController } from "./index.js";
import type { DispatchStartOptions } from "./dispatch-compose.js";

// Card T06b, composed: the controller hands the local host builder its own tool execution service as the bridge, and the agent's namespace; the dispatcher it builds asks the same service whether a catalogue call is replay-safe.
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const AGENT = "agt-bcdefghijklmnopqrstu";
const manifest = (recovery: "restart" | "none") => ({
  purpose: "check a page", input: { type: "object", properties: { url: { type: "string", maxLength: 200 } }, required: ["url"], additionalProperties: false },
  output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }, entryPoint: "bin/check.js", interpreter: { name: "node", version: "22.19.0" },
  os: ["linux"], arch: ["x64"], dependencies: [], requestedAccess: [], limits: { cpus: 1, memoryMb: 128, seconds: 30 }, cancellation: "cooperative", recovery,
});
const good = (r: BridgeResponse): Record<string, any> => { assert.equal(r.ok, true, JSON.stringify(r)); return (r as { result: Record<string, any> }).result; };
type BuildServices = Parameters<NonNullable<DispatchStartOptions["local"]>["build"]>[0];

test("the composed controller gives the local host its tool bridge and the agent's namespace, and the dispatcher takes replay-safety from the approved manifest through the same service (card T06b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-t06b-start-"));
  let services: BuildServices | undefined;
  let script: (ctx: { order: WorkOrder; gateway: ToolGateway }) => Promise<any> = async () => ({ status: "completed", text: "done" });
  const worker = new ScriptedWorker("host:w1", (ctx) => script(ctx as never));
  const runs: string[] = [];
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: { timer: new ManualTimer(), manual: true, local: { window: () => 32768, acceptUnenforcedLimits: true, build: (s) => { services = s; return worker; } } },
    tools: { runner: { run: async (launch) => { runs.push(launch.tool.name); return { text: '{"ok":true}', cpuMs: 1 }; } }, isLocalHost: (h) => h === "host:w1", facts: async () => ({ os: "linux", arch: "x64", interpreters: { node: "22.19.0" }, packages: {}, cpus: 8, memoryMb: 16_384 }) },
  });
  try {
    assert.ok(c.dispatch !== undefined && c.tools !== undefined, c.dispatchProblem);
    assert.ok(services?.bridge !== undefined, "the host builder is given the bridge when the controller runs the tool service");
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
    await PolicyService.withEpoch(c.storage, c.epoch, s.grants).set(rob, { scope: "installation", commandId: "pol", profile: "autonomous" } as never);
    const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    // No grant on the agent's own tool namespace: it comes with enrolment.
    await s.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: AGENT, grants: [...workGrants(project), { action: "desk.write", project }, { action: "desk.read", project }, { action: "catalog.register", project: "*" }, { action: "catalog.read", project: "*" }] });
    const taskId = (await s.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Check a page" })).id;
    await s.projects.transitionTask({ commandId: "r1", actor: rob.id, taskId, expectedRevision: 1, to: "ready" });
    await s.assignments.assignTask({ commandId: "as1", actor: rob.id, taskId, owner: { kind: "agent", id: AGENT } });
    const a = (await s.assignments.getAssignment(taskId))!;
    const attemptId = (await s.assignments.admitAttempt({ commandId: "ad1", actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: AGENT }, harness: "pi" })).id;

    const seen: { namespace?: string; forged?: BridgeResponse; tools: Record<string, string> } = { tools: {} };
    let failure: unknown;
    script = async ({ order, gateway }) => {
      // Exactly what a worker process sends: its task credential and a request; the host binds the attempt and its gateway.
      const send = (op: string, args: Record<string, unknown>, callId: string, token = order.credential) => services!.bridge!(order, gateway.call, token, { op, callId, args });
      try {
        seen.namespace = services!.namespaceId(order);
        seen.forged = await send("desk.read", { recordId: "x" }, "forged-1", "nn_forged_credential");
        for (const recovery of ["restart", "none"] as const) {
          const doc = good(await send("desk.write", { kind: "note", title: `${recovery} notes`, body: "how to use it", visibility: "shared", status: "accepted" }, `doc-${recovery}`));
          const code = good(await send("desk.write", { kind: "note", title: `${recovery} code`, body: "console.log('{\"ok\":true}')", visibility: "shared", status: "accepted" }, `code-${recovery}`));
          const made = good(await send("tool.register", { name: `check-${recovery}`, kind: "tool", version: "1.0.0", manifest: manifest(recovery), instructionsRecordId: doc["id"], executableRecordId: code["id"] }, `reg-${recovery}`));
          seen.tools[recovery] = made["name"] as string;
          const args = { tool: made["name"], version: "1.0.0", input: { url: "u" } };
          // A first call of an unclassified tool is parked for review; the owner allows it and the same call is made again.
          const first = good(await send("tool.invoke", args, `inv-${recovery}`));
          if (first["state"] === "awaiting-approval") {
            const review = (await s.reviews.get(rob, first["reviewId"] as string))!;
            await s.reviews.decide(rob, { commandId: `dec-${recovery}`, requestId: review.id, expectedRevision: review.revision, verdict: "allow", reason: "fine" } as never);
            good(await send("tool.invoke", args, `inv-${recovery}`));
          }
        }
      } catch (error) { failure = error; throw error; }
      return { status: "completed", text: "done" };
    };
    await c.dispatch.dispatcher.tick();
    await c.dispatch.dispatcher.idle();
    if (failure !== undefined) throw failure;

    // The namespace the host gives the process is the agent's own, the one its registered tools are named in.
    assert.equal(seen.namespace, personalNamespace(`agent:${AGENT}`).slice(2));
    assert.ok(seen.tools["restart"]!.startsWith(`a_${seen.namespace}.`), JSON.stringify(seen.tools));
    // A request with a credential that is not the attempt's is refused by the service, not by the host.
    assert.equal(seen.forged?.ok, false);
    assert.equal((seen.forged as { code?: string } | undefined)?.code, "unauthenticated", JSON.stringify(seen.forged));
    assert.deepEqual(runs, [seen.tools["restart"], seen.tools["none"]], "both tools ran through the controller's runner");
    // The dispatcher asked the tool service: the call of a tool whose approved manifest says `restart` is replay-safe, the other is not.
    const restart = await c.dispatch.dispatcher.toolOperation(c.dispatch.principal, attemptId, "inv-restart");
    const none = await c.dispatch.dispatcher.toolOperation(c.dispatch.principal, attemptId, "inv-none");
    assert.equal(restart?.state, "confirmed", JSON.stringify(restart));
    assert.equal(none?.state, "confirmed", JSON.stringify(none));
    assert.equal(restart?.replaySafe, true, JSON.stringify(restart));
    assert.equal(none?.replaySafe, undefined, JSON.stringify(none));
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("without the tool service the host builder gets no bridge and the dispatcher no replay-safe answer (card T06b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-t06b-start-"));
  let services: BuildServices | undefined;
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: { timer: new ManualTimer(), manual: true, local: { window: () => 32768, acceptUnenforcedLimits: true, build: (s) => { services = s; return new ScriptedWorker("host:w1", async () => ({ status: "completed", text: "done" })); } } },
  });
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    assert.ok(services !== undefined);
    assert.equal(services.bridge, undefined);
    assert.equal(c.tools, undefined);
    assert.equal(services.namespaceId({ agentId: `agent:${AGENT}` } as WorkOrder), personalNamespace(`agent:${AGENT}`).slice(2));
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
