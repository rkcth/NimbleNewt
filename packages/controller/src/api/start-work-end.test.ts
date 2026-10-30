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
    assert.equal((await c.services.workEnd.get(two.attempt))?.state, "requested", "a stop still in preparation leaves the intent as it is");
    const forced = await call(c, boot.token, "lifecycle.choose", { intentId: stop.result.intentId, choice: "force-stop", reason: "no checkpoint will come" }, "st2");
    assert.ok(forced.ok, JSON.stringify(forced));
    const dropped = await c.services.workEnd.get(two.attempt);
    assert.equal(dropped?.state, "dropped");
    assert.equal(dropped?.typed, "emergency_stop");
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
