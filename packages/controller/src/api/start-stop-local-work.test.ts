import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { AdmissionService } from "../admission/service.js";
import type { HostLocalWork, WorkerHost } from "../dispatch/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI, ScriptedWorker, workGrants } from "../dispatch/testing/world.js";
import { CommandRunner } from "../domain/runner.js";
import { HostService } from "../hosts/hosts.js";
import { startController } from "./index.js";

// Card L02d, end to end through startController: a Stop ends what the worker host still holds (local processes, a swarm child's work, background jobs), names what will not end, and bills the cleanup cost to the task's budget once.
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] };

/** A scripted local host whose agents run until they are stopped, and which reports what a sandbox would still hold; the test moves `held` the way a closing sandbox does. */
function fakeHost(held: { work: () => HostLocalWork; asked: string[][] }): ScriptedWorker {
  const host = new ScriptedWorker("host:w1", async ({ worker }) => {
    await new Promise<void>((done) => { const stop = worker.stop.bind(worker); worker.stop = async () => { await stop(); done(); }; });
    return { status: "completed", text: "stopped" };
  });
  (host as unknown as WorkerHost).localWork = async (ids: readonly string[]) => { held.asked.push([...ids]); return held.work(); };
  return host;
}
const open = (file: string, host: WorkerHost) => startController({
  storage: { kind: "sqlite", path: file }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
  dispatch: {
    timer: new ManualTimer(), manual: true,
    route: async () => ({ route: "cloud/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: true } }),
    local: { acceptUnenforcedLimits: true, window: () => 8192, build: () => host },
  },
});
type C = Awaited<ReturnType<typeof open>>;
const call = async (c: C, token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;

async function world(d: string, held: { work: () => HostLocalWork; asked: string[][] }) {
  const host = fakeHost(held);
  const c = await open(join(d, "c.sqlite"), host);
  assert.ok(c.dispatch !== undefined, c.dispatchProblem);
  const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
  const owner = await c.services.principals.authenticate(boot.token);
  const project = (await c.services.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
  await c.services.principals.enroll(owner, { commandId: "e-w1", kind: "host", name: "w1", grants: [] });
  const hostP = await c.services.principals.authenticate((await c.services.principals.issueCredential(owner, "host:w1")).token);
  const hosts = HostService.withEpoch(c.storage, c.epoch, c.services.assignments);
  await hosts.announce(hostP, { commandId: "an1", capabilities: CAPS as never });
  await hosts.heartbeat(hostP, { commandId: "hb1", sequence: 1 });
  await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap-w1", actor: owner.id, host: "host:w1", capacity: { cpus: 32, memoryMb: 65_536 } });
  const task = async (n: number, parent?: string) => {
    const agent = `agt-${String.fromCharCode(96 + n).repeat(20)}`;
    await c.services.principals.enroll(owner, { commandId: `e-${n}`, kind: "agent", name: agent, grants: workGrants(project, ["read-file"]) });
    const id = (await c.services.projects.createTask({ commandId: `t${n}`, actor: owner.id, projectId: project, title: `Order seeds ${n}` })).id;
    await c.services.projects.transitionTask({ commandId: `r${n}`, actor: owner.id, taskId: id, expectedRevision: 1, to: "ready" });
    await c.services.assignments.assignTask({ commandId: `as${n}`, actor: owner.id, taskId: id, owner: { kind: "agent", id: agent } });
    const a = (await c.services.assignments.getAssignment(id))!;
    const attempt = (await c.services.assignments.admitAttempt({ commandId: `ad${n}`, actor: "inbox", taskId: id, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: agent }, harness: "pi" })).id;
    if (parent !== undefined) {
      const ref = { kind: "swarm-link", id };
      await new CommandRunner(c.storage, c.epoch, {}).command("swarm.test-link", { commandId: `link-${n}`, actor: "system" }, async () => ({ payload: { id }, build: async () => ({ ref, creates: true, changes: [{ type: "create", ref, body: { parentTaskId: parent, projectId: project, createdBy: owner.id, createdAt: new Date().toISOString() } }], detail: { id } }) }));
    }
    return { id, attempt, agent };
  };
  return { c, boot, owner, project, task, state: async (id: string) => (await c.dispatch!.dispatcher.get(c.dispatch!.principal, id))! };
}
const cleanup = (d: string): void => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

test("a Stop asks the worker host what is still held, ends a background job, bills the cleanup cost to the task's budget once, and a process that stays is named and keeps the stop from being clean (card L02d)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-l02d-"));
  const held = { asked: [] as string[][], processes: [{ ref: "node server.js --token=sk-live-abcdef0123456789", kind: "process" as const, state: "running" as const }], cost: 0 };
  let attemptId = "";
  const w = await world(d, { asked: held.asked, work: () => ({ processes: held.processes, costs: attemptId === "" ? [] : [{ attemptId, costMicros: held.cost, computeMs: held.cost / 10 }] }) });
  const { c, boot, owner } = w;
  try {
    const one = await w.task(1);
    attemptId = one.attempt;
    await c.dispatch!.dispatcher.tick();
    assert.equal((await w.state(one.attempt)).state !== "finished", true, "the attempt is live");
    assert.ok((await call(c, boot.token, "budget.open", { taskId: one.id, currency: "USD", costMicros: 5_000_000 }, "b1")).ok);
    const job = (await c.services.jobs.admit(owner, { commandId: "j1", taskId: one.id, kind: "tool", label: "dev server", operationId: "op-1", background: true })).id;
    held.cost = 7000;

    // The readiness look shows the process (secret-looking text redacted) and the job; nothing is paused or changed.
    const ready = await call(c, boot.token, "lifecycle.readiness", { scope: { kind: "task", id: one.id } });
    assert.ok(ready.ok, JSON.stringify(ready));
    assert.ok(ready.result.unsettled.some((i: { kind: string; ref: string }) => i.kind === "process" && !/sk-live-abcdef/.test(i.ref)), JSON.stringify(ready.result));
    assert.ok(held.asked.length > 0 && held.asked.every((ids) => ids.includes(one.attempt)), "the host was asked about the attempt");

    // The Stop: the job is asked to stop, the process is still there after the stop, so it is named and the result is recovery-required, not a clean stop.
    const stop = await call(c, boot.token, "lifecycle.stop", { scope: { kind: "task", id: one.id }, mode: "stop", reason: "night" }, "st1");
    assert.ok(stop.ok, JSON.stringify(stop));
    assert.equal(stop.result.outcome.state, "recovery-required", JSON.stringify(stop.result));
    assert.ok(stop.result.outcome.unresolved.some((u: string) => /node server/.test(u) && !/sk-live-abcdef/.test(u)), JSON.stringify(stop.result.outcome));
    assert.ok(stop.result.outcome.unresolved.includes(job), "a job that has been asked to stop and has not is named");
    assert.equal((await c.services.jobs.get(owner, job))?.state, "cancellation_requested", "Stop asked the job to stop");
    assert.equal((await w.state(one.attempt)).state, "finished", "the attempt itself was ended");

    // The cleanup cost is on the task's budget exactly once, as stop-cleanup, even though the cost was reported again by later looks.
    const usage = await call(c, boot.token, "budget.usage", { taskId: one.id });
    assert.deepEqual([usage.result.item.byActivity["stop-cleanup"]?.costMicros, usage.result.item.byActivity["stop-cleanup"]?.computeMs], [7000, 700], JSON.stringify(usage.result));
    const again = await call(c, boot.token, "lifecycle.sweep", {}, "sw1");
    assert.ok(again.ok);
    assert.equal((await call(c, boot.token, "budget.usage", { taskId: one.id })).result.item.byActivity["stop-cleanup"].costMicros, 7000, "a sweep or a repeat does not charge again");
  } finally { await c.close(); cleanup(d); }
});

test("a host that cannot say what it holds makes the stop's look unknown, never clean; and a Force Stop still ends the attempt (card L02d)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-l02d-"));
  const w = await world(d, { asked: [], work: () => { throw new Error("sandbox daemon unreachable"); } });
  const { c, boot } = w;
  try {
    const one = await w.task(1);
    await c.dispatch!.dispatcher.tick();
    const ready = await call(c, boot.token, "lifecycle.readiness", { scope: { kind: "task", id: one.id } });
    assert.equal(ready.result.ready, false);
    assert.ok(ready.result.unsettled.some((i: { ref: string; state: string }) => i.ref === "runtime:processes" && i.state === "unknown"), JSON.stringify(ready.result));
    const forced = await call(c, boot.token, "lifecycle.force", { scope: { kind: "task", id: one.id }, reason: "now" }, "f1");
    assert.ok(forced.ok, JSON.stringify(forced));
    assert.equal(forced.result.outcome.graceful, false);
    assert.equal((await w.state(one.attempt)).state, "finished");
  } finally { await c.close(); cleanup(d); }
});

test("a Stop of a task ends its swarm child's work too, and a Pause leaves a background job running (card L02d)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-l02d-"));
  const w = await world(d, { asked: [], work: () => ({ processes: [] }) });
  const { c, boot, owner } = w;
  try {
    const parent = await w.task(1);
    const child = await w.task(2, parent.id);
    await c.dispatch!.dispatcher.tick();
    assert.equal((await w.state(child.attempt)).state !== "finished", true, "the child's attempt is live");
    const job = (await c.services.jobs.admit(owner, { commandId: "j1", taskId: child.id, kind: "tool", label: "child build", operationId: "op-c", background: true })).id;
    // A Pause of the parent changes neither the child nor its job.
    assert.ok((await call(c, boot.token, "lifecycle.pause", { scope: { kind: "task", id: parent.id }, reason: "lunch" }, "pa1")).ok);
    assert.equal((await c.services.jobs.get(owner, job))?.state, "admitted");
    assert.equal((await w.state(child.attempt)).state !== "finished", true);
    const ready = await call(c, boot.token, "lifecycle.readiness", { scope: { kind: "task", id: parent.id } });
    assert.ok(ready.result.unsettled.some((i: { kind: string; ref: string }) => i.kind === "child" && i.ref === child.attempt), JSON.stringify(ready.result));
    const stop = await call(c, boot.token, "lifecycle.stop", { scope: { kind: "task", id: parent.id }, mode: "stop", reason: "done for today" }, "st1");
    assert.ok(stop.ok, JSON.stringify(stop));
    assert.equal((await w.state(child.attempt)).state, "finished", "the child's attempt was ended by the parent's Stop");
    assert.equal((await w.state(parent.attempt)).state, "finished");
    assert.equal((await c.services.jobs.get(owner, job))?.state, "cancellation_requested", "the child's job was asked to stop");
  } finally { await c.close(); cleanup(d); }
});

test("a stopped parent keeps its swarm children from starting again: after the Stop the next tick starts nothing for a child, and resuming the parent lets go (card L02d)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-l02d-"));
  const w = await world(d, { asked: [], work: () => ({ processes: [] }) });
  const { c, boot } = w;
  try {
    const parent = await w.task(1);
    const child = await w.task(2, parent.id);
    await c.dispatch!.dispatcher.tick();
    const stop = await call(c, boot.token, "lifecycle.stop", { scope: { kind: "task", id: parent.id }, mode: "stop", reason: "night" }, "st1");
    assert.ok(stop.ok, JSON.stringify(stop));
    assert.equal((await w.state(child.attempt)).state, "finished", "the child's attempt was ended with the parent's");
    // A new attempt for the child (a retry, a re-assignment) is not started while the parent's Stop holds.
    const assignment = (await c.services.assignments.getAssignment(child.id))!;
    const again = (await c.services.assignments.admitAttempt({ commandId: "ad-again", actor: "inbox", taskId: child.id, expectedRevision: assignment.revision, generation: assignment.generation, owner: { kind: "agent", id: child.agent }, harness: "pi" })).id;
    const held = await c.dispatch!.dispatcher.tick();
    assert.ok(!held.started.includes(again), JSON.stringify(held));
    assert.ok(held.skipped.some((s) => s.attemptId === again && /parent task .* is stopped/.test(s.reason)), JSON.stringify(held.skipped));
    // The parent resumed: the hold is let go and the child starts.
    assert.ok((await call(c, boot.token, "lifecycle.resume", { scope: { kind: "task", id: parent.id }, reason: "morning" }, "rs1")).ok);
    const free = await c.dispatch!.dispatcher.tick();
    assert.ok(free.started.includes(again), JSON.stringify(free));
  } finally { await c.close(); cleanup(d); }
});
