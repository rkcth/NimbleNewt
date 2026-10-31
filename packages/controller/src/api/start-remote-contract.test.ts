import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdmissionService } from "../admission/service.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { RemoteWorkerClient, contractProblems } from "../remote/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] };


type Api = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => Promise<{ ok: boolean; result?: any; error?: { code: string; message?: string } }>;
const full = { formats: [1], features: ["limits", "wall-time"], enforces: { cpus: "full", memoryMb: "full", diskMb: "full", processes: "full", wallTimeMs: "full" } } as const;

async function world() {
  const d = mkdtempSync(join(tmpdir(), "nn-remote-contract-"));
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: {
      timer: new ManualTimer(), manual: true,
      route: async () => ({ route: "localp/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: false } }),
      remote: { blobDirectory: join(d, "blobs"), hosts: [{ hostId: "host:r1", checkpointWaitMs: 300, pollMs: 20, resources: { cpus: 1, memoryMb: 1024 }, requirements: () => ({ data: "cloud-allowed", harness: "pi" }) }] },
    },
  });
  assert.ok(c.dispatch?.workerUrl !== undefined, c.dispatchProblem);
  const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
  const rob = await c.services.principals.authenticate(boot.token);
  const api: Api = (token, op, args, commandId) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as never;
  const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
  await c.services.principals.enroll(rob, { commandId: "e-r1", kind: "host", name: "r1", grants: [] });
  const hostToken = (await c.services.principals.issueCredential(rob, "host:r1")).token;
  await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap", actor: rob.id, host: "host:r1", capacity: { cpus: 8, memoryMb: 16_384 } });
  await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "agt-abcdefghijklmnopqrst", grants: [{ action: "attempt.work", project }, { action: "task.read", project }, { action: "effect.perform", project }, { action: "review.request", project }] as never });
  const client = new RemoteWorkerClient({ url: c.dispatch!.workerUrl!, token: hostToken, workerVersion: "worker-9.1.0" });
  await client.connect(CAPS as never);
  let beat = 0;
  await client.heartbeat(++beat);
  let n = 0;
  const attempt = async (title: string, permissions?: string[]) => {
    const k = n++;
    const task = (await c.services.projects.createTask({ commandId: `t${k}`, actor: rob.id, projectId: project, title })).id;
    await c.services.projects.transitionTask({ commandId: `r${k}`, actor: rob.id, taskId: task, expectedRevision: 1, to: "ready" });
    if (permissions !== undefined) assert.ok((await api(boot.token, "contract.set", { taskId: task, expectedVersion: 0, permissions }, `cs${k}`)).ok);
    await c.services.assignments.assignTask({ commandId: `as${k}`, actor: rob.id, taskId: task, owner: { kind: "agent", id: "agt-abcdefghijklmnopqrst" } });
    const a = (await c.services.assignments.getAssignment(task))!;
    const attemptId = (await c.services.assignments.admitAttempt({ commandId: `ad${k}`, actor: "inbox", taskId: task, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: "agt-abcdefghijklmnopqrst" }, harness: "pi" })).id;
    await client.heartbeat(++beat);
    const report = await c.dispatch!.dispatcher.tick();
    return { task, attemptId, report };
  };
  const offered = async (attemptId: string) => {
    const offer = (await client.offers()).find((o) => o.order.attemptId === attemptId);
    assert.ok(offer, "the attempt was offered");
    const mine = client.attempt(attemptId, offer!.placement);
    await mine.accept();
    return { offer: offer!, mine };
  };
  return { c, d, api, ownerToken: boot.token, client, attempt, offered, done: async () => { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } };
}

test("the owner's limits, best-effort setting and the task contract travel with the order to a remote worker; the worker confirms, the launch is recorded for the owner, and a call is refused before the confirmation (card H12a)", async () => {
  const w = await world();
  try {
    assert.ok((await w.api(w.ownerToken, "workers.limits.set", { limits: { memoryMb: 512, processes: 40, wallTimeMs: 600_000 } }, "wl1")).ok);
    const first = await w.attempt("Order seeds", ["class.inspect", "class.workspace-edit"]);
    assert.ok(first.report.started.includes(first.attemptId), JSON.stringify({ s: first.report.skipped, f: first.report.failures }));
    const { offer, mine } = await w.offered(first.attemptId);
    const contract = offer.order.contract!;
    assert.equal(contract.format, 1);
    assert.deepEqual(contract.limits, { memoryMb: 512, processes: 40, wallTimeMs: 600_000 });
    assert.equal(contract.bestEffort, false);
    assert.deepEqual(contract.permissions, ["class.inspect", "class.workspace-edit"]);
    assert.ok(contract.taskContractVersion >= 1);
    assert.deepEqual(contract.requires, ["limits", "wall-time"]);
    // The wire order cannot be altered: the worker finds the digest wrong and refuses without running anything.
    const forged = { ...offer.order, contract: { ...contract, limits: { memoryMb: 999_999 } } };
    assert.match(contractProblems(forged, full as never, new Date().toISOString()).join(), /digest/);
    // No call before the confirmation, over the real transport and the real gateway.
    await assert.rejects(() => mine.begin({ callId: "c0", tool: { name: "read-file", version: "1" }, args: {} }), (e: { code?: string }) => e.code === "invalid_transition");
    assert.deepEqual(await mine.honorContract(offer.order, full as never), { ok: true });
    const begun = await mine.begin({ callId: "c1", tool: { name: "read-file", version: "1" }, args: {} });
    assert.ok(begun.operationId);
    // The launch is on the owner's record, with the figures the worker confirmed.
    const rec = await w.api(w.ownerToken, "workers.limits.enforced", { attemptId: first.attemptId });
    assert.ok(rec.ok, JSON.stringify(rec));
    const last = rec.result.item.launches.at(-1);
    assert.equal(last.outcome, "started");
    assert.deepEqual(last.requested, { memoryMb: 512, processes: 40, wallTimeMs: 600_000 });
    assert.deepEqual(last.enforcement.map((e: { limit: string; enforced: string }) => [e.limit, e.enforced]).sort(), [["memoryMb", "full"], ["processes", "full"], ["wallTimeMs", "full"]]);
    // Usage and the result come back through the same path and are charged once.
    await mine.usage({ turnSeq: 1, costMicros: 0, computeMs: 5 });
    await mine.complete({ status: "completed", text: "done" });
    await w.c.dispatch!.dispatcher.idle();
    assert.equal((await w.c.dispatch!.dispatcher.get(await w.c.services.principals.authenticate(w.ownerToken), first.attemptId))!.outcome?.status, "succeeded");
  } finally { await w.done(); }
});

test("a remote worker that cannot hold the owner's limits refuses the order and the attempt fails with the reason; best effort, set by the owner, lets the next order through with the shortfall on record (card H12a)", async () => {
  const w = await world();
  try {
    const owner = await w.c.services.principals.authenticate(w.ownerToken);
    assert.ok((await w.api(w.ownerToken, "workers.limits.set", { limits: { memoryMb: 512, diskMb: 100 } }, "wl1")).ok);
    const weak = { ...full, enforces: { ...full.enforces, diskMb: "none" } } as never;
    const a = await w.attempt("Order seeds");
    const { offer, mine } = await w.offered(a.attemptId);
    const refused = await mine.honorContract(offer.order, weak);
    assert.equal(refused.ok, false);
    await w.c.dispatch!.dispatcher.idle();
    const dispatch = (await w.c.dispatch!.dispatcher.get(owner, a.attemptId))!;
    assert.equal(dispatch.outcome?.status, "failed");
    assert.match(dispatch.outcome?.summary ?? "", /refused the dispatch contract.*diskMb/);
    // The owner allows best effort (chat-settable, like the limits): the same shortfall is now accepted and recorded.
    assert.ok((await w.api(w.ownerToken, "workers.limits.besteffort", { enabled: true }, "be1")).ok);
    const b = await w.attempt("Order bulbs");
    assert.ok(b.report.started.includes(b.attemptId), JSON.stringify({ s: b.report.skipped, f: b.report.failures }));
    const second = await w.offered(b.attemptId);
    assert.equal(second.offer.order.contract!.bestEffort, true);
    assert.deepEqual(await second.mine.honorContract(second.offer.order, weak), { ok: true });
    const rec = await w.api(w.ownerToken, "workers.limits.enforced", { attemptId: b.attemptId }); assert.ok(rec.ok, JSON.stringify(rec));
    const last = rec.result.item.launches.at(-1);
    assert.equal(last.bestEffort, true);
    assert.ok(last.enforcement.some((e: { limit: string; enforced: string }) => e.limit === "diskMb" && e.enforced === "none"));
    // The first attempt's refusal is on record too.
    const first = await w.api(w.ownerToken, "workers.limits.enforced", { attemptId: a.attemptId }); assert.ok(first.ok, JSON.stringify(first));
    assert.equal(first.result.item.launches.at(-1).outcome, "refused");
  } finally { await w.done(); }
});

test("when the owner's limits cannot be read the remote worker is not given the order: the attempt fails at start, nothing is offered, nothing runs unlimited (card H12a)", async () => {
  const w = await world();
  try {
    const storage = w.c.storage as unknown as { getAggregate: (ref: { kind: string; id: string }) => Promise<unknown> };
    const real = storage.getAggregate.bind(storage);
    storage.getAggregate = async (ref) => { if (ref.kind === "worker-limits-settings") throw new Error("disk gone"); return real(ref); };
    const a = await w.attempt("Order seeds");
    storage.getAggregate = real;
    assert.ok(!a.report.started.includes(a.attemptId));
    assert.deepEqual(await w.client.offers(), []);
    const dispatch = (await w.c.dispatch!.dispatcher.get(await w.c.services.principals.authenticate(w.ownerToken), a.attemptId))!;
    assert.equal(dispatch.state, "finished");
    assert.match(dispatch.outcome?.summary ?? "", /did not start/);
  } finally { await w.done(); }
});
