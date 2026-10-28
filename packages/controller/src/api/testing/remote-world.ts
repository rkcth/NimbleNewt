import assert from "node:assert/strict";
import { join } from "node:path";
import { AdmissionService } from "../../admission/service.js";
import { ManualTimer } from "../../dispatch/testing/timer.js";
import { PI, workGrants } from "../../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../../environment/index.js";
import { RemoteWorkerClient } from "../../remote/index.js";
import { startController } from "../index.js";

export const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
export const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
export const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] };
export const AGENT = "agt-abcdefghijklmnopqrst";

/** A composed controller with two remote hosts, a clock the test moves and an agent with tasks to run. */
export async function world(d: string, policy: { dataHosts?: string[]; platforms?: { os: string; arch: string }[]; credentialHosts?: string[] }, options: { requirements?: () => Record<string, unknown>; checkpointWaitMs?: number } = {}) {
  let now = Date.now();
  const timer = new ManualTimer();
  const requirements = (options.requirements ?? (() => ({ data: "local-only" as const, harness: "pi" }))) as () => never;
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: {
      timer, manual: true, clock: () => new Date(now).toISOString(),
      route: async () => ({ route: "localp/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "local-only", paidAuthorized: false } }),
      remote: {
        blobDirectory: join(d, "blobs"), relocationPolicy: async () => policy, placementPolicy: async () => ({ dataHosts: ["host:r1", "host:r2"] }),
        hosts: ["r1", "r2"].map((n) => ({ hostId: `host:${n}`, checkpointWaitMs: options.checkpointWaitMs ?? 300, pollMs: 20, resources: { cpus: 1, memoryMb: 1024 }, requirements })),
      },
    },
  });
  assert.ok(c.dispatch?.workerUrl !== undefined, c.dispatchProblem);
  const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
  const rob = await c.services.principals.authenticate(boot.token);
  const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
  await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: AGENT, grants: workGrants(project, ["read-file"]) });
  const host = async (name: string, connect = true, caps: Record<string, unknown> = CAPS) => {
    await c.services.principals.enroll(rob, { commandId: `e-${name}`, kind: "host", name, grants: [] });
    const token = (await c.services.principals.issueCredential(rob, `host:${name}`)).token;
    await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: `cap-${name}`, actor: rob.id, host: `host:${name}`, capacity: { cpus: 8, memoryMb: 16_384 } });
    const client = new RemoteWorkerClient({ url: c.dispatch!.workerUrl!, token, workerVersion: "worker-9.1.0" });
    let seq = 0;
    const beat = async (): Promise<void> => { await client.heartbeat(++seq); };
    const join = async (): Promise<void> => { await client.connect(caps as never); await beat(); };
    if (connect) await join();
    const principal = await c.services.principals.authenticate(token);
    return { id: `host:${name}`, token, client, beat, join, principal };
  };
  let n = 0;
  /** A new task for the agent with its attempt admitted; the next tick starts it on a host that can. */
  const task = async (title: string): Promise<{ taskId: string; attemptId: string }> => {
    n += 1;
    const taskId = (await c.services.projects.createTask({ commandId: `t${n}`, actor: rob.id, projectId: project, title })).id;
    await c.services.projects.transitionTask({ commandId: `r${n}`, actor: rob.id, taskId, expectedRevision: 1, to: "ready" });
    await c.services.assignments.assignTask({ commandId: `as${n}`, actor: rob.id, taskId, owner: { kind: "agent", id: AGENT } });
    const a = (await c.services.assignments.getAssignment(taskId))!;
    const attemptId = (await c.services.assignments.admitAttempt({ commandId: `ad${n}`, actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: AGENT }, harness: "pi" })).id;
    return { taskId, attemptId };
  };
  return { c, rob, host, task, now: () => new Date(now).toISOString(), advance: (ms: number) => { now += ms; }, tick: () => c.dispatch!.dispatcher.tick() };
}

