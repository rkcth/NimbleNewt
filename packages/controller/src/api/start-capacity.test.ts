import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdmissionService } from "../admission/service.js";
import { ScriptedInterpreter } from "../chat/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI, workGrants } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { RemoteWorkerClient } from "../remote/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] };
// One agent has one native store, so two attempts of one agent never run together here: the cases use a different agent for each attempt.
const AGENTS = "abcdefghij".split("").map((ch) => `agt-${ch.repeat(20)}`);

test("capacity caps through the composed controller: off by default; per-project and fan-in caps make attempts wait for capacity with a reason (not fail); the owner changes them by API and in chat; a lifted cap lets the waiting attempt start (card H10b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-capacity-"));
  const say: Record<string, unknown[]> = {};
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) },
    dispatch: {
      timer: new ManualTimer(), manual: true,
      route: async () => ({ route: "localp/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: false } }),
      remote: { blobDirectory: join(d, "blobs"), hosts: [{ hostId: "host:pc", checkpointWaitMs: 300, pollMs: 20, resources: { cpus: 1, memoryMb: 1024 }, requirements: () => ({ data: "cloud-allowed" as const, harness: "pi" }) }] },
    },
  });
  try {
    assert.ok(c.dispatch?.workerUrl !== undefined && c.dispatch.remote !== undefined, c.dispatchProblem);
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    await c.services.principals.enroll(rob, { commandId: "e-pc", kind: "host", name: "pc", grants: [] });
    const client = new RemoteWorkerClient({ url: c.dispatch.workerUrl, token: (await c.services.principals.issueCredential(rob, "host:pc")).token, workerVersion: "worker-9.1.0" });
    const admission = AdmissionService.withEpoch(c.storage, c.epoch);
    await admission.setCapacity({ commandId: "cap-pc", actor: rob.id, host: "host:pc", capacity: { cpus: 64, memoryMb: 262_144 } });
    await admission.setLimits({ commandId: "lim", actor: rob.id, limits: { productive: 32, perHost: 16, control: 2, queue: 100, depth: 3, children: 4, patience: 5 } });
    await client.connect({ ...CAPS } as never);
    await client.heartbeat(1);
    const project2 = (await c.services.projects.createProject({ commandId: "p2", actor: rob.id, name: "Shed" })).id;
    for (const a of AGENTS) await c.services.principals.enroll(rob, { commandId: `e-${a}`, kind: "agent", name: a, grants: [...workGrants(project, ["read-file"]), ...workGrants(project2, ["read-file"])] });
    const call = (op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string; message: string } }>;
    let n = 0;
    const newTask = async (agent: string, projectId = project): Promise<{ taskId: string; attemptId: string }> => {
      const k = n++;
      const taskId = (await c.services.projects.createTask({ commandId: `t${k}`, actor: rob.id, projectId, title: `Order seeds ${k}` })).id;
      await c.services.projects.transitionTask({ commandId: `r${k}`, actor: rob.id, taskId, expectedRevision: 1, to: "ready" });
      await c.services.assignments.assignTask({ commandId: `as${k}`, actor: rob.id, taskId, owner: { kind: "agent", id: agent } });
      const a = (await c.services.assignments.getAssignment(taskId))!;
      return { taskId, attemptId: (await c.services.assignments.admitAttempt({ commandId: `ad${k}`, actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: agent }, harness: "pi" })).id };
    };

    // Off by default: nothing is capped.
    assert.deepEqual((await call("capacity.limits.get", {})).result.item, { revision: 0, limits: {}, effective: {} });
    const free = [await newTask(AGENTS[0]!), await newTask(AGENTS[1]!)];
    const open = await c.dispatch.dispatcher.tick();
    assert.deepEqual([...open.started].sort(), free.map((t) => t.attemptId).sort(), JSON.stringify(open));
    assert.deepEqual(open.capacityWaits, []);

    // A per-project cap of 2 (two already run in this project): a third waits, and the report says why.
    assert.ok((await call("capacity.limits.change", { set: { perProject: 2 }, expectedRevision: 0 }, "cl1")).ok);
    const third = await newTask(AGENTS[2]!);
    const other = await newTask(AGENTS[3]!, project2);
    const capped = await c.dispatch.dispatcher.tick();
    assert.deepEqual(capped.started, [other.attemptId], "another project is not held back");
    assert.equal(capped.failures.length, 0);
    assert.deepEqual(capped.skipped.filter((s) => s.attemptId === third.attemptId), [], "waiting for capacity is not a skip or a failure");
    assert.equal(capped.capacityWaits.length, 1);
    assert.equal(capped.capacityWaits[0]!.attemptId, third.attemptId);
    assert.ok(capped.capacityWaits[0]!.reason.startsWith(`waiting for capacity: project ${project} already has 2 attempts running`), capped.capacityWaits[0]!.reason);
    // Lifting the cap in chat: shown first, applied on the owner's word, and the waiting attempt starts on the next tick.
    const turn = async (id: string, text: string, intents: unknown[]) => { say[text] = intents; return (await c.chat!.submit(boot.token, { messageId: id, text })).outcomes; };
    const text = "disable perProject so a project may run any number of attempts";
    const shown = await turn("m1", text, [{ kind: "command", op: "capacity.limits.change", args: { disable: ["perProject"] }, evidence: text, basis: "owner" }]);
    assert.equal(shown[0]!.status, "proposed", JSON.stringify(shown));
    assert.deepEqual((await c.dispatch.dispatcher.tick()).started, [], "nothing changed while it waits for the owner");
    const applied = await turn("m2", "yes, do that", [{ kind: "apply_proposal", proposalId: shown[0]!.proposalId, evidence: "do that", basis: "owner" }]);
    assert.equal(applied[0]!.status, "applied", JSON.stringify(applied));
    assert.deepEqual((await call("capacity.limits.get", {})).result.item.limits, { perProject: { enabled: false, value: 2 } });
    assert.deepEqual((await c.dispatch.dispatcher.tick()).started, [third.attemptId]);

    // Fan-in: the children of one parent report to the parent's agent; two at a time.
    const parent = await newTask(AGENTS[4]!);
    const kids = [await newTask(AGENTS[5]!), await newTask(AGENTS[6]!), await newTask(AGENTS[7]!)];
    for (const k of kids) {
      const ref = { kind: "swarm-link", id: k.taskId };
      await c.storage.applyOperation({ operationId: `lnk-${k.taskId}`, epoch: c.epoch, actor: rob.id, correlationId: "lnk", at: new Date().toISOString(), changes: [{ type: "create", ref, body: { parentTaskId: parent.taskId, projectId: project, createdBy: rob.id, createdAt: new Date().toISOString() } }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
    }
    assert.ok((await call("capacity.limits.change", { set: { fanIn: 2 } }, "cl2")).ok);
    const fan = await c.dispatch.dispatcher.tick();
    const startedKids = fan.started.filter((id) => kids.some((k) => k.attemptId === id));
    assert.equal(startedKids.length, 2, JSON.stringify(fan));
    const waitingKid = kids.find((k) => !startedKids.includes(k.attemptId))!;
    assert.match(fan.capacityWaits.find((w) => w.attemptId === waitingKid.attemptId)?.reason ?? "", /already receives reports from 2 running attempts \(the owner's fan-in cap\)/);
    assert.ok(fan.started.includes(parent.attemptId), "the parent itself reports to no one and is not held");

    // Owner only, validated, race-safe.
    await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "ann", grants: [{ action: "task.read", project }] });
    const ann = (await c.services.principals.issueCredential(rob, "agent:ann")).token;
    const as = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; error?: { code: string } }>;
    assert.equal((await as(ann, "capacity.limits.get", {})).error?.code, "forbidden");
    assert.equal((await as(ann, "capacity.limits.change", { set: { fanIn: 9 } }, "cl3")).error?.code, "forbidden");
    assert.equal((await call("capacity.limits.change", { set: { fanIn: 0 } }, "cl4")).error?.code, "invalid_command");
    assert.equal((await call("capacity.limits.change", { set: { fanIn: 5 }, expectedRevision: 0 }, "cl5")).error?.code, "stale_revision");
    // Turning fan-in off lets the waiting child in at once (the change sweeps admission); the next tick starts it.
    assert.ok((await call("capacity.limits.change", { disable: ["fanIn"] }, "cl6")).ok);
    assert.deepEqual((await c.dispatch.dispatcher.tick()).started, [waitingKid.attemptId]);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
