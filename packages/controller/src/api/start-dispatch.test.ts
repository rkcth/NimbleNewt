import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const dir = () => mkdtempSync(join(tmpdir(), "nn-dispatch-"));
const open = (file: string, extra: Partial<Parameters<typeof startController>[0]> = {}, out: string[] = []) =>
  startController({ storage: { kind: "sqlite", path: file }, argv: [], env: {}, print: (l) => { out.push(l); }, facts: supported, filesystem: ext4, ...extra });
const cleanup = (d: string): void => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

test("no dispatcher is built and no loop runs unless the operator asks for it", async () => {
  const d = dir();
  const c = await open(join(d, "c.sqlite"));
  try {
    assert.equal(c.dispatch, undefined);
    assert.equal(c.dispatchProblem, undefined);
    assert.equal(await c.services.principals.get("service:dispatcher"), undefined);
  } finally { await c.close(); cleanup(d); }
});

test("start builds the dispatcher and its loops under the controller's epoch; the timer drives them; close stops them gracefully", async () => {
  const d = dir();
  const timer = new ManualTimer();
  const errors: unknown[] = [];
  const c = await open(join(d, "c.sqlite"), { harnesses: [PI], dispatch: { timer, intervalMs: 1000 }, onInternalError: (e) => errors.push(e) });
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    // The dispatcher's service principal exists, enrolled by the controller with no grants and no owner step.
    const principal = await c.services.principals.get("service:dispatcher");
    assert.equal(principal?.kind, "service");
    assert.equal(principal?.hasCredential, true);
    assert.deepEqual(principal?.grants, []);
    assert.deepEqual(timer.delays, [1000], "the timer is armed at start");
    // An agent's task with an admitted attempt: the composed dispatcher finds it on the first tick and runs the checks (no route is configured, so it says why it cannot start).
    const owner = await c.services.principals.authenticate((await c.services.principals.bootstrapOwner({ name: "rob" })).token);
    const admit = async (n: number, agent: string): Promise<string> => {
      await c.services.principals.enroll(owner, { commandId: `e-${n}`, kind: "agent", name: agent, grants: [] });
      const task = (await c.services.projects.createTask({ commandId: `t${n}`, actor: owner.id, projectId: project, title: `Order seeds ${n}` })).id;
      await c.services.projects.transitionTask({ commandId: `r${n}`, actor: owner.id, taskId: task, expectedRevision: 1, to: "ready" });
      await c.services.assignments.assignTask({ commandId: `as${n}`, actor: owner.id, taskId: task, owner: { kind: "agent", id: agent } });
      const a = (await c.services.assignments.getAssignment(task))!;
      return (await c.services.assignments.admitAttempt({ commandId: `ad${n}`, actor: "inbox", taskId: task, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: agent }, harness: "pi" })).id;
    };
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
    // One attempt whose agent record the meeting revalidation cannot read (not an agent ID) and one that is fine: the bad one is reported and does not stop the other.
    const bad = await admit(1, "ann");
    const attempt = await admit(2, "agt-abcdefghijklmnopqrst");
    await timer.fire();
    const status = c.dispatch.driver.status();
    assert.deepEqual([status.state, status.ticks, status.failedTicks], ["running", 1, 0]);
    assert.deepEqual(status.loopFailures, {}, JSON.stringify(status.errors));
    assert.equal(status.errors.length, 1, JSON.stringify(status.errors));
    assert.deepEqual([status.errors[0]!.source, status.errors[0]!.message], [`attempt ${bad}`, "agent: is not an agent principal"], "the bad attempt is recorded, not silent");
    assert.equal(status.lastReport?.scanned, 2);
    // No route is configured, so the checks say so for the good attempt (a blocker names the owner) instead of starting it blindly.
    const next = await c.dispatch.dispatcher.tick();
    const why = [...next.blocked, ...next.skipped].find((x) => x.attemptId === attempt);
    assert.ok(why !== undefined && why.check === "route", JSON.stringify(next));
    assert.deepEqual(timer.delays, [1000, 1000], "and the next tick is armed");
    assert.equal(errors.length, 1, "and it reached the observer");
    // The gateway the worker is given is the dispatcher's, bound to the attempt.
    assert.equal(c.dispatch.dispatcher.gateway(attempt).attemptId, attempt);
  } finally {
    await c.close();
    assert.equal(c.dispatch?.driver.status().state, "stopped");
    assert.equal(timer.armed, false, "no timer is left behind");
    cleanup(d);
  }
});

test("a second controller instance on the same store takes the epoch and the first stops running the loops", async () => {
  const d = dir();
  const file = join(d, "c.sqlite");
  const t1 = new ManualTimer(), t2 = new ManualTimer();
  const first = await open(file, { dispatch: { timer: t1, intervalMs: 1000 } });
  try {
    await t1.fire();
    assert.equal(first.dispatch?.driver.status().ticks, 1);
    const second = await open(file, { dispatch: { timer: t2, intervalMs: 1000 } });
    try {
      assert.ok(second.epoch > first.epoch);
      await t1.fire();
      assert.equal(first.dispatch?.driver.status().state, "fenced");
      assert.equal(first.dispatch?.driver.status().ticks, 1, "the deposed instance ran no further tick");
      assert.equal(t1.armed, false);
      await t2.fire();
      assert.deepEqual([second.dispatch?.driver.status().state, second.dispatch?.driver.status().ticks], ["running", 1]);
      assert.deepEqual(second.dispatch?.driver.status().loopFailures, {});
    } finally { await second.close(); }
  } finally { await first.close(); cleanup(d); }
});

test("a dispatcher the owner disabled is not re-enabled by start: the controller starts without it, says so, and keeps the reason", async () => {
  const d = dir();
  const file = join(d, "c.sqlite");
  const first = await open(file, { dispatch: { manual: true } });
  try {
    const owner = await first.services.principals.authenticate((await first.services.principals.bootstrapOwner({ name: "rob" })).token);
    const dispatcher = (await first.services.principals.get("service:dispatcher"))!;
    await first.services.principals.disable(owner, { commandId: "dis", principalId: "service:dispatcher", expectedRevision: dispatcher.revision });
  } finally { await first.close(); }
  try {
    const out: string[] = [];
    const again = await open(file, { dispatch: { manual: true } }, out);
    try {
      assert.equal(again.dispatch, undefined);
      assert.match(again.dispatchProblem ?? "", /not an active service/);
      assert.ok(out.some((l) => l.startsWith("The dispatcher is not running")));
      const items = (await again.storage.listAggregates("notification-item", { limit: 20 })).map((a) => a.body as unknown as { kind: string });
      assert.deepEqual(items.map((i) => i.kind), ["maintenance"], "the owner is told");
      assert.ok(again.api, "the rest of the controller is up");
    } finally { await again.close(); }
  } finally { cleanup(d); }
});

test("a dispatcher the owner disables while the controller runs is noticed on the next tick: the driver stops and the owner is told", async () => {
  const d = dir();
  const timer = new ManualTimer();
  const c = await open(join(d, "c.sqlite"), { dispatch: { timer, intervalMs: 1000 } });
  try {
    const owner = await c.services.principals.authenticate((await c.services.principals.bootstrapOwner({ name: "rob" })).token);
    await timer.fire();
    assert.equal(c.dispatch?.driver.status().ticks, 1);
    // A routine rotation at start was not reported.
    assert.deepEqual(await c.storage.listAggregates("notification-item", { limit: 5 }), []);
    const dispatcher = (await c.services.principals.get("service:dispatcher"))!;
    await c.services.principals.disable(owner, { commandId: "dis", principalId: "service:dispatcher", expectedRevision: dispatcher.revision });
    await timer.fire();
    assert.deepEqual([c.dispatch?.driver.status().state, c.dispatch?.driver.status().ticks, timer.armed], ["disabled", 1, false]);
    assert.equal((await c.storage.listAggregates("notification-item", { limit: 5 })).length, 1);
  } finally { await c.close(); cleanup(d); }
});
