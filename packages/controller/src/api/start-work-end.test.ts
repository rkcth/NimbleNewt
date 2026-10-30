import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { AdmissionService } from "../admission/service.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI, workGrants } from "../dispatch/testing/world.js";
import { RemoteWorkerClient } from "../remote/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] };
const open = (file: string, blobs: string) => startController({
  storage: { kind: "sqlite", path: file }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
  dispatch: {
    timer: new ManualTimer(), manual: true,
    route: async () => ({ route: "cloud/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: true } }),
    remote: { blobDirectory: blobs, hosts: [{ hostId: "host:pc", checkpointWaitMs: 300, pollMs: 20, resources: { cpus: 1, memoryMb: 256 }, requirements: () => ({ data: "cloud-allowed" as const, harness: "pi" }) }] },
  },
});
type C = Awaited<ReturnType<typeof open>>;
const call = async (c: C, token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;

async function attemptFor(c: C, owner: Awaited<ReturnType<C["services"]["principals"]["authenticate"]>>, project: string, n: number): Promise<{ attempt: string; task: string; token: string; agent: string }> {
  const s = c.services;
  const agent = `agt-${String.fromCharCode(96 + n).repeat(20)}`;
  await s.principals.enroll(owner, { commandId: `e-${n}`, kind: "agent", name: agent, grants: workGrants(project, ["read-file"]) });
  const token = (await s.principals.issueCredential(owner, `agent:${agent}`)).token;
  const task = (await s.projects.createTask({ commandId: `t${n}`, actor: owner.id, projectId: project, title: `Order seeds ${n}` })).id;
  await s.projects.transitionTask({ commandId: `r${n}`, actor: owner.id, taskId: task, expectedRevision: 1, to: "ready" });
  await s.assignments.assignTask({ commandId: `as${n}`, actor: owner.id, taskId: task, owner: { kind: "agent", id: agent } });
  const a = (await s.assignments.getAssignment(task))!;
  const attempt = (await s.assignments.admitAttempt({ commandId: `ad${n}`, actor: "inbox", taskId: task, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: agent }, harness: "pi" })).id;
  return { attempt, task, token, agent };
}

test("work.end through the controller: the attempt ends with the result, a stranger is refused, an owner stop drops the intent, a restart recovers an open one (card H12n)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-workend-"));
  const file = join(d, "c.sqlite");
  const blobs = join(d, "blobs");
  let c = await open(file, blobs);
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const owner = await c.services.principals.authenticate(boot.token);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
    const one = await attemptFor(c, owner, project, 1);
    const two = await attemptFor(c, owner, project, 2);
    const three = await attemptFor(c, owner, project, 3);
    await c.services.principals.enroll(owner, { commandId: "e-pc", kind: "host", name: "pc", grants: [] });
    const client = new RemoteWorkerClient({ url: c.dispatch.workerUrl!, token: (await c.services.principals.issueCredential(owner, "host:pc")).token, workerVersion: "worker-9.1.0" });
    await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap-pc", actor: owner.id, host: "host:pc", capacity: { cpus: 32, memoryMb: 65_536 } });
    await client.connect({ ...CAPS } as never);
    await client.heartbeat(1);
    const first = await c.dispatch.dispatcher.tick(); // the dispatcher starts the three attempts on the host
    assert.deepEqual([...first.started].sort(), [one.attempt, two.attempt].sort(), "the host has room for two at a time");
    const state = async (id: string) => (await c.dispatch!.dispatcher.get(c.dispatch!.principal, id))!;

    // A stranger (another agent) and the owner are refused; the answer for the stranger does not say the attempt exists.
    const refused = await call(c, two.token, "work.end", { attemptId: one.attempt, result: "done" }, "x1");
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, "not_found");
    assert.equal((await call(c, boot.token, "work.end", { attemptId: one.attempt }, "x2")).error.code, "forbidden");

    // The agent ends its own attempt: the intent is recorded and the attempt frozen; the tick completes it with the result.
    const ended = await call(c, one.token, "work.end", { attemptId: one.attempt, result: "partial", note: "two beds left" }, "e1");
    assert.ok(ended.ok, JSON.stringify(ended));
    assert.equal(ended.result.item.state, "requested");
    assert.equal((await state(one.attempt)).state !== "finished", true);
    assert.ok((await state(one.attempt)).frozen !== undefined, "frozen at once");
    const replay = await call(c, one.token, "work.end", { attemptId: one.attempt, result: "partial", note: "two beds left" }, "e1");
    assert.equal(replay.result.item.replayed, true);
    // A submit cannot be checked yet (the landing check is not bound): refused as unavailable, nothing recorded.
    assert.equal((await call(c, three.token, "work.end", { attemptId: three.attempt, submit: true }, "s1")).error.code, "unavailable");
    const tick = await c.dispatch.dispatcher.tick();
    assert.ok(tick.loops.some((l) => l.name === "workend.complete" && l.ok), JSON.stringify(tick.loops.filter((l) => !l.ok)));
    const after = await state(one.attempt);
    assert.equal(after.state, "finished");
    assert.equal(after.outcome?.status, "succeeded");
    assert.match(after.outcome?.summary ?? "", /partial.*two beds left/);
    assert.equal((await c.services.workEnd.get(one.attempt))?.state, "done");

    // An owner stop drops an open intent: nothing is finished on the agent's say-so afterwards.
    assert.ok((await call(c, two.token, "work.end", { attemptId: two.attempt, result: "done" }, "e2")).ok);
    // The scripted host sends no checkpoint, so the ordinary stop is blocked in preparation and the owner chooses Force Stop (the emergency path of the same drop).
    const stop = await call(c, boot.token, "lifecycle.stop", { scope: { kind: "task", id: two.task }, mode: "stop", reason: "the owner stops it" }, "st1");
    assert.ok(stop.ok, JSON.stringify(stop));
    assert.equal((await c.services.workEnd.get(two.attempt))?.state, "dropped", "a stop in preparation drops the intent at once: nothing can complete it any more");
    assert.equal((await c.services.workEnd.get(two.attempt))?.typed, "owner_stop");
    assert.equal((await call(c, two.token, "work.end", { attemptId: two.attempt, result: "done" }, "e2b")).result.item.state, "dropped", "asking again is the recorded (dropped) ending, nothing new");
    const forced = await call(c, boot.token, "lifecycle.choose", { intentId: stop.result.intentId, choice: "force-stop", reason: "no checkpoint will come" }, "st2");
    assert.ok(forced.ok, JSON.stringify(forced));
    const dropped = await c.services.workEnd.get(two.attempt);
    assert.equal(dropped?.state, "dropped");
    assert.equal(dropped?.typed, "owner_stop", "dropped when the stop began, with its reason then");
    assert.equal((await state(two.attempt)).outcome?.status, "abandoned");

    // A restart finds (the third attempt is still waiting for a place on the host; a running one would be ended by the shutdown itself) an open ending and completes it once.
    assert.ok((await call(c, three.token, "work.end", { attemptId: three.attempt, result: "blocked", note: "no seeds" }, "e3")).ok);
    assert.equal((await c.services.workEnd.get(three.attempt))?.state, "requested");
    await c.close();
    c = await open(file, blobs);
    assert.equal((await c.services.workEnd.get(three.attempt))?.state, "done", "recovered at start-up");
    const last = (await c.dispatch!.dispatcher.get(c.dispatch!.principal, three.attempt))!;
    assert.deepEqual([last.state, last.outcome?.status], ["finished", "abandoned"]);
    assert.deepEqual(await c.services.workEnd.recover(), [], "nothing is completed twice");
    assert.match(last.outcome?.summary ?? "", /blocked.*no seeds/);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

/** A controller with the host connected and the project's owner, for the tests of the ending against the dispatcher. */
async function world(d: string) {
  const c = await open(join(d, "c.sqlite"), join(d, "blobs"));
  assert.ok(c.dispatch !== undefined, c.dispatchProblem);
  const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
  const owner = await c.services.principals.authenticate(boot.token);
  const project = (await c.services.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
  await c.services.principals.enroll(owner, { commandId: "e-pc", kind: "host", name: "pc", grants: [] });
  const client = new RemoteWorkerClient({ url: c.dispatch.workerUrl!, token: (await c.services.principals.issueCredential(owner, "host:pc")).token, workerVersion: "worker-9.1.0" });
  await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap-pc", actor: owner.id, host: "host:pc", capacity: { cpus: 32, memoryMb: 65_536 } });
  await client.connect({ ...CAPS } as never);
  await client.heartbeat(1);
  return { c, boot, owner, project, client, state: async (id: string) => (await c.dispatch!.dispatcher.get(c.dispatch!.principal, id))! };
}

test("work.end then the agent's turn completes: the attempt records the agent's result, the note and the tell, not a plain success; a failed turn drops the intent as attempt_ended (card H12n review 1)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-workend-"));
  const { c, owner, project, client, state } = await world(d);
  try {
    const one = await attemptFor(c, owner, project, 1);
    const two = await attemptFor(c, owner, project, 2);
    await c.dispatch!.dispatcher.tick();
    const offers = await client.offers();
    const play = async (a: { attempt: string }) => { const offer = offers.find((o) => o.order.attemptId === a.attempt)!; const att = client.attempt(a.attempt, offer.placement); await att.accept(); return att; };
    const finished = async (id: string) => { for (let n = 0; n < 200 && (await state(id)).state !== "finished"; n++) await new Promise((r) => setTimeout(r, 25)); };
    const first = await play(one);
    const second = await play(two);
    assert.ok((await call(c, one.token, "work.end", { attemptId: one.attempt, result: "blocked", note: "no seeds", message: "need seeds" }, "e1")).ok);
    await first.complete({ status: "completed", text: "stopping" });
    await finished(one.attempt);
    const ended = await state(one.attempt);
    assert.equal(ended.state, "finished");
    assert.equal(ended.outcome?.status, "abandoned", "blocked is what the attempt records");
    assert.match(ended.outcome?.summary ?? "", /blocked.*no seeds/);
    assert.equal((await c.services.workEnd.get(one.attempt))?.state, "done", "the intent was completed, not dropped as an owner stop");
    await c.dispatch!.dispatcher.tick();
    assert.equal((await c.services.workEnd.get(one.attempt))?.state, "done", "and the next tick leaves it as it is");

    assert.ok((await call(c, two.token, "work.end", { attemptId: two.attempt, result: "done", note: "all beds" }, "e2")).ok);
    await second.complete({ status: "failed", error: "the model broke" });
    await finished(two.attempt);
    const failed = await state(two.attempt);
    assert.equal(failed.outcome?.status, "failed");
    assert.match(failed.outcome?.summary ?? "", /the model broke.*done: all beds/);
    const rec = await c.services.workEnd.get(two.attempt);
    assert.deepEqual([rec?.state, rec?.typed], ["dropped", "attempt_ended"], "not an owner's stop");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("an owner Stop whose preparation is still waiting drops the ending at once, so the sweep cannot finish the attempt succeeded (card H12n review 2)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-workend-"));
  const { c, boot, owner, project, state } = await world(d);
  try {
    const one = await attemptFor(c, owner, project, 1);
    await c.dispatch!.dispatcher.tick();
    assert.ok((await call(c, one.token, "work.end", { attemptId: one.attempt, result: "done" }, "e1")).ok);
    const stop = await call(c, boot.token, "lifecycle.stop", { scope: { kind: "task", id: one.task }, mode: "stop", reason: "the owner stops it" }, "st1");
    assert.ok(stop.ok, JSON.stringify(stop));
    const rec = await c.services.workEnd.get(one.attempt);
    assert.deepEqual([rec?.state, rec?.typed], ["dropped", "owner_stop"]);
    for (let n = 0; n < 3; n++) await c.dispatch!.dispatcher.tick();
    const after = await state(one.attempt);
    assert.notEqual(after.outcome?.status, "succeeded");
    assert.equal((await c.services.workEnd.get(one.attempt))?.state, "dropped");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a credential scoped to one task cannot end the same agent's attempt on another task (card H12n review 6)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-workend-"));
  const { c, owner, project } = await world(d);
  try {
    const one = await attemptFor(c, owner, project, 1);
    await c.dispatch!.dispatcher.tick();
    const s = c.services;
    const taskB = (await s.projects.createTask({ commandId: "tb", actor: owner.id, projectId: project, title: "Water the beds" })).id;
    await s.projects.transitionTask({ commandId: "rb", actor: owner.id, taskId: taskB, expectedRevision: 1, to: "ready" });
    await s.assignments.assignTask({ commandId: "asb", actor: owner.id, taskId: taskB, owner: { kind: "agent", id: one.agent } });
    const scopedB = (await s.taskCredentials.issue(owner, { commandId: "ib", taskId: taskB, agentId: `agent:${one.agent}` })).token;
    const refused = await call(c, scopedB, "work.end", { attemptId: one.attempt }, "x1");
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, "not_found");
    assert.equal(await c.services.workEnd.get(one.attempt), undefined, "nothing was recorded");
    const scopedA = (await s.taskCredentials.issue(owner, { commandId: "ia", taskId: one.task, agentId: `agent:${one.agent}` })).token;
    const ok = await call(c, scopedA, "work.end", { attemptId: one.attempt }, "x2");
    assert.ok(ok.ok, JSON.stringify(ok));
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
