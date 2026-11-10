import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { ROUTING_TABLE, EXEC_PROFILES, PI, ScriptedWorker, workGrants } from "../dispatch/testing/world.js";
import type { ToolGateway, WorkOrder } from "../dispatch/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { AdmissionService } from "../admission/index.js";
import { HostService } from "../hosts/index.js";
import { FakeApplier } from "../maintenance/index.js";
import { PolicyService } from "../policy/index.js";
import { DifficultyService } from "../routing/index.js";
import type { BridgeResponse } from "../toolbridge/index.js";
import { startController } from "./index.js";
import type { DispatchStartOptions } from "./dispatch-compose.js";

// Card A09, composed: a running worker asks for a change to its own environment through the tool bridge (`maintenance.request`) and gets the maintenance ID back at once, while the application (which would replace that very
// worker) has not finished; the owner's standing permission approves it without asking anyone; the agent reads where it stands with `maintenance.status`; it cannot ask for another agent.
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const D = (c: string): string => `sha256:${c.repeat(64)}`;
const ext = (name: string, extra: Record<string, unknown> = {}) => ({ name, version: "1.2.3", digest: D("b"), source: "https://registry.example.org/ext", installScripts: false, ...extra });
type Reply = Record<string, any>;
const good = (r: BridgeResponse): Reply => { assert.equal(r.ok, true, JSON.stringify(r)); return (r as { result: Reply }).result; };
const refused = (r: BridgeResponse, code: string): string => { assert.equal(r.ok, false, JSON.stringify(r)); assert.equal((r as { code: string }).code, code, JSON.stringify(r)); return (r as { message: string }).message; };
type BuildServices = Parameters<NonNullable<DispatchStartOptions["local"]>["build"]>[0];
type Send = (op: string, args: Record<string, unknown>, callId: string) => Promise<BridgeResponse>;

test("a worker asks for an environment change through the bridge and has the maintenance ID before the application that replaces it finishes; a standing permission asks no one again; it reads the status and cannot ask for another agent (card A09)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-a09-bridge-"));
  const applier = new FakeApplier();
  let release!: () => void;
  applier.gate = new Promise<void>((resolve) => { release = resolve; });
  let services: BuildServices | undefined;
  let script: (ctx: { order: WorkOrder; gateway: ToolGateway }) => Promise<any> = async () => ({ status: "completed", text: "done" });
  const worker = new ScriptedWorker("host:w1", (ctx) => script(ctx as never));
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: { timer: new ManualTimer(), manual: true, local: { window: () => 32768, acceptUnenforcedLimits: true, build: (s: BuildServices) => { services = s; return worker; } } },
    tools: { runner: { run: async () => ({ text: "{}" }) }, isLocalHost: (h: string) => h === "host:w1", facts: async () => ({ os: "linux", arch: "x64", interpreters: { node: "22.19.0" }, packages: {}, cpus: 8, memoryMb: 16_384 }) },
    maintenance: { applier },
  } as never);
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const s = c.services;
    const owner = await s.principals.authenticate((await s.principals.bootstrapOwner({ name: "rob" })).token);
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
    // Ann is an agent with a record (an environment belongs to an agent), the grants to work, and the owner's standing permission for extensions only.
    const ann = (await s.agents.create(owner, { commandId: "ag-ann", friendlyName: "Ann" } as never)).id;
    // Bob reports to Ann: the state API shows a supervisor its reports' requests, the bridge shows an agent its own only.
    const bob = (await s.agents.create(owner, { commandId: "ag-bob", friendlyName: "Bob", supervisorId: ann } as never)).id;
    const bobs = (await s.maintenance!.request(owner, { commandId: "m-bob", agentId: `agent:${bob}`, kind: "package", spec: { ...ext("bob-pad"), source: "https://registry.example.org/pkg" }, reason: "for Bob", rollbackPlan: "remove it" } as never)).maintenanceId;
    let g = 0;
    for (const grant of workGrants(project)) await s.grants.grant(owner, { commandId: `g-${g++}`, grantee: `agent:${ann}`, action: grant.action, project: grant.project, source: "direct", basis: "work" });
    await s.grants.grant(owner, { commandId: "g-standing", grantee: `agent:${ann}`, action: "approve.maintenance.extension", project: "*", source: "direct", basis: "Ann may add extensions to her own environment" });
    const taskId = (await s.projects.createTask({ commandId: "t-1", actor: owner.id, projectId: project, title: "Lint the site" })).id;
    await s.projects.transitionTask({ commandId: "r-1", actor: owner.id, taskId, expectedRevision: 1, to: "ready" });
    await s.assignments.assignTask({ commandId: "as-1", actor: owner.id, taskId, owner: { kind: "agent", id: ann } });
    const a = (await s.assignments.getAssignment(taskId))!;
    await s.assignments.admitAttempt({ commandId: "ad-1", actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: ann }, harness: "pi" });

    const seen: Record<string, Reply | string> = {};
    let failure: unknown;
    script = async ({ order, gateway }) => {
      const send: Send = (op, args, callId) => services!.bridge!(order, gateway.call, order.credential, { op, callId, args });
      try {
        // The request answers at once with the ID; the application (held open here, as one that restarts this worker would be) has started and not finished.
        const asked = good(await send("maintenance.request", { kind: "extension", spec: ext("eslint-helper"), reason: "lint faster", rollbackPlan: "remove the extension" }, "mr-1"));
        assert.match(asked["maintenanceId"], /^mnt-[a-z2-7]{20}$/);
        assert.equal(asked["status"], "approved", "the standing permission approved it: no one was asked");
        assert.equal(applier.effects.has(asked["maintenanceId"]), false, "the answer came before the application finished");
        seen["extension"] = asked;
        // The same call ID is the same request.
        assert.equal(good(await send("maintenance.request", { kind: "extension", spec: ext("eslint-helper"), reason: "lint faster", rollbackPlan: "remove the extension" }, "mr-1"))["maintenanceId"], asked["maintenanceId"]);
        // A package is not covered by a permission for extensions: it waits for a decider (the owner, in this profile without supervisors).
        const pkg = good(await send("maintenance.request", { kind: "package", spec: { ...ext("left-pad"), source: "https://registry.example.org/pkg" }, reason: "pad", rollbackPlan: "remove it" }, "mr-2"));
        assert.equal(pkg["status"], "pending");
        seen["package"] = pkg;
        // The agent names no agent: its own environment is the only one it can ask about.
        refused(await send("maintenance.request", { agentId: `agent:${bob}`, kind: "skill", spec: { name: "x", digest: D("c") }, reason: "for Bob" }, "mr-3"), "invalid_command");
        // A spec cannot carry a capability, a command or a host path.
        refused(await send("maintenance.request", { kind: "extension", spec: { ...ext("sneaky"), grants: ["*"] }, reason: "x", rollbackPlan: "y" }, "mr-4"), "invalid_command");
        // Where it stands.
        const st = good(await send("maintenance.status", { maintenanceId: pkg["maintenanceId"] }, "ms-1"));
        assert.deepEqual([st["maintenanceId"], st["kind"], st["class"], st["status"]], [pkg["maintenanceId"], "package", "dependency", "pending"]);
        refused(await send("maintenance.status", { maintenanceId: "../etc" }, "ms-2"), "invalid_command");
        refused(await send("maintenance.status", { maintenanceId: "mnt-aaaaaaaaaaaaaaaaaaaa" }, "ms-3"), "not_found");
        refused(await send("maintenance.status", { maintenanceId: bobs }, "ms-4"), "not_found");
      } catch (error) { failure = error; throw error; }
      return { status: "completed", text: "done" };
    };
    await c.dispatch.dispatcher.tick();
    await c.dispatch.dispatcher.idle();
    if (failure !== undefined) throw failure;
    const id = (seen["extension"] as Reply)["maintenanceId"] as string;
    // The application goes on after the worker's call returned, and finishes with a recorded effect.
    release();
    await s.maintenance!.idle();
    const item = await s.maintenance!.get(owner, id);
    assert.equal(item["status"], "applied");
    assert.deepEqual([(item["decision"] as Reply)["via"], (item["decision"] as Reply)["rule"]], ["rule", "standing-grant"]);
    assert.equal(applier.calls.filter((x) => x.op === "apply" && x.id === id).length, 1);
    // The package was never applied: it waits for the owner.
    assert.equal(applier.calls.some((x) => x.id === (seen["package"] as Reply)["maintenanceId"]), false);
  } finally { release(); await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
