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
import { PolicyService } from "../policy/index.js";
import { RemoteWorkerClient } from "../remote/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] };

test("local-only data goes to the hosts the approval profile and the owner's setting allow: strict lists none by itself, the other profiles allow every enrolled host not excluded, and the owner's change in chat is shown first (card H07c)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-placement-"));
  const say: Record<string, unknown[]> = {};
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) },
    dispatch: {
      timer: new ManualTimer(), manual: true,
      route: async () => ({ route: "localp/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "local-only", paidAuthorized: false } }),
      remote: { blobDirectory: join(d, "blobs"), hosts: ["pc", "laptop", "rented"].map((n) => ({ hostId: `host:${n}`, checkpointWaitMs: 300, pollMs: 20, resources: { cpus: 1, memoryMb: 1024 }, requirements: () => ({ data: "local-only" as const, harness: "pi" }) })) },
    },
  });
  try {
    assert.ok(c.dispatch?.workerUrl !== undefined && c.dispatch.remote !== undefined, c.dispatchProblem);
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const hosts: string[] = [];
    const clients = new Map<string, RemoteWorkerClient>();
    for (const name of ["pc", "laptop", "rented"]) {
      await c.services.principals.enroll(rob, { commandId: `e-${name}`, kind: "host", name, grants: [] });
      const token = (await c.services.principals.issueCredential(rob, `host:${name}`)).token;
      const client = new RemoteWorkerClient({ url: c.dispatch.workerUrl, token, workerVersion: "worker-9.1.0" });
      await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: `cap-${name}`, actor: rob.id, host: `host:${name}`, capacity: { cpus: 8, memoryMb: 16_384 } });
      await client.connect({ ...CAPS } as never);
      clients.set(`host:${name}`, client);
      await client.heartbeat(1);
      hosts.push(`host:${name}`);
    }
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string; message: string } }>;
    const eligible = async (): Promise<string[]> => [...(await c.dispatch!.remote!.candidates(rob, { taskId: "task-aaaaaaaaaaaaaaaaaaaa", projectId: project, agentId: "agent:ann", requirements: { data: "local-only", harness: "pi" } })).eligible].sort();
    const dataHosts = async (): Promise<string[]> => (await call(boot.token, "placement.get", {})).result.item.dataHosts;

    await c.services.principals.enroll(rob, { commandId: "e-worker", kind: "agent", name: "agt-abcdefghijklmnopqrst", grants: workGrants(project, ["read-file"]) });
    const newTask = async (n: number): Promise<string> => {
      const taskId = (await c.services.projects.createTask({ commandId: `t${n}`, actor: rob.id, projectId: project, title: `Order seeds ${n}` })).id;
      await c.services.projects.transitionTask({ commandId: `r${n}`, actor: rob.id, taskId, expectedRevision: 1, to: "ready" });
      await c.services.assignments.assignTask({ commandId: `as${n}`, actor: rob.id, taskId, owner: { kind: "agent", id: "agt-abcdefghijklmnopqrst" } });
      const a = (await c.services.assignments.getAssignment(taskId))!;
      return (await c.services.assignments.admitAttempt({ commandId: `ad${n}`, actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: "agt-abcdefghijklmnopqrst" }, harness: "pi" })).id;
    };
    // The strict profile (the default): nothing is allowed until the owner lists a host.
    assert.deepEqual([await eligible(), await dataHosts()], [[], []]);
    assert.equal((await call(boot.token, "placement.get", {})).result.item.profile, "strict");
    // Nothing listed: the task waits, and no host is offered it.
    const attempt0 = await newTask(0);
    const waiting = await c.dispatch.dispatcher.tick();
    assert.deepEqual(waiting.started, [], "no host may hold the data yet");
    assert.match((await c.dispatch.dispatcher.get(rob, attempt0))!.outcome!.summary, /data is local-only and the data-location policy does not list host:/, "the placement itself refused it");
    for (const h of hosts) assert.equal((await clients.get(h)!.offers()).length, 0, `${h} was offered nothing`);
    const set1 = await call(boot.token, "placement.set", { allow: ["host:pc"], expectedRevision: 0 }, "pl1");
    assert.ok(set1.ok, JSON.stringify(set1));
    assert.deepEqual(await eligible(), ["host:pc"], "a listed host counts from the next placement");
    assert.equal((await call(boot.token, "placement.set", { allow: ["host:pc"], expectedRevision: 0 }, "pl2")).error?.code, "stale_revision");
    assert.equal((await call(boot.token, "placement.set", { allow: ["pc"] }, "pl3")).error?.code, "invalid_command");
    assert.equal((await call(boot.token, "placement.set", {}, "pl4")).error?.code, "invalid_command");
    // The placement itself, not only the list of candidates: a task whose data is local-only starts on the listed host and nowhere else.
    const attempt1 = await newTask(1);
    const report = await c.dispatch!.dispatcher.tick();
    assert.deepEqual(report.started, [attempt1], JSON.stringify(report.failures));
    assert.equal((await c.dispatch!.remote!.placement(rob, attempt1))!.hostId, "host:pc", "the listed host got it");
    for (const other of ["host:laptop", "host:rented"]) assert.equal((await clients.get(other)!.offers()).length, 0, `${other} was offered nothing`);
    // Only the owner reads or changes it.
    await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "ann", grants: [{ action: "task.read", project }] });
    const ann = (await c.services.principals.issueCredential(rob, "agent:ann")).token;
    assert.equal((await call(ann, "placement.get", {})).error?.code, "forbidden");
    assert.equal((await call(ann, "placement.set", { allow: ["host:rented"] }, "pl5")).error?.code, "forbidden");

    // The derived profile allows every enrolled host of the owner; an exclusion takes one out; a host disabled leaves.
    const policy = PolicyService.withEpoch(c.storage, c.epoch, c.services.grants);
    await policy.set(rob, { commandId: "prof", scope: "installation", profile: "derived" } as never);
    assert.deepEqual(await eligible(), [...hosts].sort());
    assert.equal((await call(boot.token, "placement.get", {})).result.item.profile, "derived");
    assert.ok((await call(boot.token, "placement.set", { exclude: ["host:rented"] }, "pl6")).ok);
    assert.deepEqual(await eligible(), ["host:laptop", "host:pc"]);
    assert.deepEqual((await call(boot.token, "placement.get", {})).result.item.allow, ["host:pc"], "a list left out stays as it was");

    // In chat the change is shown first, in every profile, and applies only on the owner's word.
    const turn = async (id: string, text: string, intents: unknown[]) => { say[text] = intents; return (await c.chat!.submit(boot.token, { messageId: id, text })).outcomes; };
    const text = "don't let host:laptop hold my local-only files";
    const shown = await turn("m1", text, [{ kind: "command", op: "placement.change", args: { excludeAdd: ["host:laptop"] }, evidence: text, basis: "owner" }]);
    assert.equal(shown[0]!.status, "proposed", JSON.stringify(shown));
    assert.deepEqual(await eligible(), ["host:laptop", "host:pc"], "nothing changed yet");
    // While it waits the owner excludes another host; accepting the first request must not bring that host back.
    assert.ok((await call(boot.token, "placement.change", { excludeAdd: ["host:pc"] }, "pl7")).ok);
    assert.deepEqual(await eligible(), ["host:laptop"]);
    const applied = await turn("m2", "yes, do that", [{ kind: "apply_proposal", proposalId: shown[0]!.proposalId, evidence: "do that", basis: "owner" }]);
    assert.equal(applied[0]!.status, "applied", JSON.stringify(applied));
    assert.deepEqual(await eligible(), [], "the host excluded meanwhile stays excluded");
    const lists = (await call(boot.token, "placement.get", {})).result.item;
    assert.deepEqual([lists.allow, lists.exclude], [[], ["host:laptop", "host:pc", "host:rented"]], "excluding a host takes it off the allowed list");
    assert.ok((await call(boot.token, "placement.change", { excludeRemove: ["host:pc"], allowAdd: ["host:rented"] }, "pl8")).ok);
    assert.deepEqual(await eligible(), ["host:pc", "host:rented"]);
    assert.equal((await call(boot.token, "placement.change", {}, "pl9")).error?.code, "invalid_command");
    assert.equal((await call(ann, "placement.change", { allowAdd: ["host:rented"] }, "pl10")).error?.code, "forbidden");
    // Cloud-allowed data is not affected by any of this.
    const cloud = await c.dispatch.remote.candidates(rob, { taskId: "task-aaaaaaaaaaaaaaaaaaaa", projectId: project, agentId: "agent:ann", requirements: { data: "cloud-allowed", harness: "pi" } });
    assert.equal(cloud.eligible.length, 3);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
