import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { personalNamespace } from "../catalog/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { ROUTING_TABLE, EXEC_PROFILES, PI, ScriptedWorker, workGrants } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { AdmissionService } from "../admission/index.js";
import { HostService } from "../hosts/index.js";
import { PolicyService } from "../policy/index.js";
import { DifficultyService } from "../routing/index.js";
import { NotificationService } from "../notifications/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const AGENT = "agt-abcdefghijklmnopqrst";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const local = () => ({ kind: "local" as const, run: async () => ({ text: "ok" }) });
const read = (callId: string) => ({ callId, tool: { name: "read-file", version: "1.0.0" }, args: { path: "README.md" } });

test("a real policy denial of an agent's tool call goes from the tool path through the controller and the dispatcher composition to the Urgent watch and is counted exactly once, also when the same call is asked again (card U11c review)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-urgden-"));
  const sent: { text: string }[] = [];
  const channels = { chat: { send: async (m: { deliveryId: string; text: string }) => { sent.push(m); } } };
  let script: (ctx: { order: any; gateway: any }) => Promise<any> = async () => ({ status: "completed", text: "done" });
  const worker = new ScriptedWorker("host:w1", (ctx) => script(ctx as never));
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: { timer: new ManualTimer(), manual: true, workers: [worker] }, notifications: { channels },
  });
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    // The route, the host and the autonomous profile the dispatcher needs to start an attempt.
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
    await s.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: AGENT, grants: [...workGrants(project, ["read-file"]), { action: "desk.write", project }, { action: "desk.read", project }, { action: "catalog.register", project: "*" }, { action: "catalog.read", project: "*" }, { action: `tool.${personalNamespace(`agent:${AGENT}`).replace(/^a_/, "a-")}.*`, project }] });
    const taskId = (await s.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Check a page" })).id;
    await s.projects.transitionTask({ commandId: "r1", actor: rob.id, taskId, expectedRevision: 1, to: "ready" });
    await s.assignments.assignTask({ commandId: "as1", actor: rob.id, taskId, owner: { kind: "agent", id: AGENT } });
    const a = (await s.assignments.getAssignment(taskId))!;
    await s.assignments.admitAttempt({ commandId: "ad1", actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: AGENT }, harness: "pi" });
    const call = (op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any }>;
    const rev = async () => (await call("notifications.settings", {})).result.item.revision as number;
    const cfg = await call("notifications.configure", { channel: "external", channelName: "chat", deniedThreshold: 2, expectedRevision: await rev() }, "s1");
    assert.ok(cfg.ok, JSON.stringify(cfg));
    // A standing restriction placed after the grant check and before the policy is asked: the one way the policy itself denies a call. The policy is the only caller of `effective` from `evaluate`.
    const grants = s.grants as unknown as { effective: (p: any, now?: string) => Promise<any> };
    const effective = grants.effective.bind(grants);
    grants.effective = async (p, now) => {
      const e = await effective(p, now);
      return /PolicyService\.evaluate|at .*evaluate/.test(new Error().stack ?? "") && p.id === `agent:${AGENT}` ? { ...e, restrictions: [...(e.restrictions ?? []), { action: "tool.read-file", project: "*" }] } : e;
    };
    const results: string[] = [];
    script = async ({ gateway }) => {
      for (const id of ["r1", "r1", "r2"]) results.push(String((await gateway.call(read(id), local())).state));
      return { status: "completed", text: "x" };
    };
    await c.dispatch.dispatcher.tick();
    await c.dispatch.dispatcher.idle();
    assert.deepEqual(results, ["refused", "refused", "refused"]);
    await sleep(50);
    await c.dispatch.dispatcher.tick(); await c.dispatch.dispatcher.tick();
    const owner = (await s.principals.authenticate(boot.token))!;
    const items = (await NotificationService.withEpoch(c.storage, c.epoch, { channels }).inbox(owner)).items.filter((i) => i.ref.kind === "agent" && i.state !== "settled" && i.state !== "answered");
    assert.equal(items.length, 1, JSON.stringify(items));
    assert.match(items[0]!.label, /refused 2 times/, "two different calls were denied; asking r1 again was not a third denial");
    assert.equal(sent.filter((m) => /refused 2 times/.test(m.text)).length, 1, JSON.stringify(sent));
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
