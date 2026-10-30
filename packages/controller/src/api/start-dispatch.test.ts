import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import type { RuntimeGuards, WorkerHost } from "../dispatch/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import { BlockerService } from "../domain/blockers.js";
import type { TickReport } from "../dispatch/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const dir = () => mkdtempSync(join(tmpdir(), "nn-dispatch-"));
const open = (file: string, extra: Partial<Parameters<typeof startController>[0]> = {}, out: string[] = []) =>
  startController({ storage: { kind: "sqlite", path: file }, argv: [], env: {}, print: (l) => { out.push(l); }, facts: supported, filesystem: ext4, features: [], ...extra });
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

test("the dispatcher lifts a pause whose recorded time has come, and no other (card L06b)", async () => {
  const d = dir();
  const c = await open(join(d, "c.sqlite"), { harnesses: [PI], dispatch: { timer: new ManualTimer(), intervalMs: 1000 } });
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const s = c.services;
    const owner = await s.principals.authenticate((await s.principals.bootstrapOwner({ name: "rob" })).token);
    const [a, b] = [(await s.agents.create(owner, { commandId: "ag-a", friendlyName: "Ann" })).id, (await s.agents.create(owner, { commandId: "ag-b", friendlyName: "Bob" })).id];
    for (const [i, id] of [a, b].entries()) await s.pauses.pause(owner, { commandId: `pz${i}`, scope: { kind: "agent", id }, reason: "the owner asked" });
    await s.pauses.setResumeCondition(owner, { commandId: "rc1", scope: { kind: "agent", id: a }, at: new Date(Date.now() - 1000).toISOString() });
    const tick = await c.dispatch.dispatcher.tick();
    assert.ok(tick.loops.some((l) => l.name === "lifecycle.resume-conditions" && l.ok), JSON.stringify(tick.loops.filter((l) => !l.ok)));
    assert.equal((await s.pauses.gate(owner, { kind: "agent", id: a }))?.intent, "active", "the scope with a due condition was lifted");
    assert.equal((await s.pauses.gate(owner, { kind: "agent", id: b }))?.intent, "pause", "the other stays paused");
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
    // The meeting clock is among the loops the tick runs (card M01).
    assert.ok((await c.dispatch.dispatcher.tick()).loops.some((l) => l.name === "meetings.tick" && l.ok), "the meeting clock ran");
    // Reviews are moved along as the dispatcher with no grant (card H05b), and the reviewer's host is found from its live attempt.
    assert.ok((await c.dispatch.dispatcher.tick()).loops.some((l) => l.name === "reviews.sweep" && l.ok), "the review sweep ran");
    assert.ok((await c.dispatch.dispatcher.tick()).loops.some((l) => l.name === "events.wakes" && l.ok), "the wake consumer ran (card H13c)");
    // Meeting records are swept for votes past their time and records nobody finished (card M02c).
    assert.ok((await c.dispatch.dispatcher.tick()).loops.some((l) => l.name === "meeting-records.sweep" && l.ok), "the meeting record sweep ran");
    assert.equal(await c.dispatch.hostOfAgent("agent:nobody"), undefined);
    assert.equal(await c.dispatch.hostOfAgent("agent:agt-abcdefghijklmnopqrst"), undefined, "an attempt that is not running yet has no host to judge");
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
    // A routine rotation at start was not reported; the one notice is that the dispatcher does not yet hold the stall-scan right (card L01b).
    assert.equal((await c.storage.listAggregates("notification-item", { limit: 5 })).length, 1);
    const dispatcher = (await c.services.principals.get("service:dispatcher"))!;
    await c.services.principals.disable(owner, { commandId: "dis", principalId: "service:dispatcher", expectedRevision: dispatcher.revision });
    await timer.fire();
    assert.deepEqual([c.dispatch?.driver.status().state, c.dispatch?.driver.status().ticks, timer.armed], ["disabled", 1, false]);
    assert.equal((await c.storage.listAggregates("notification-item", { limit: 5 })).length, 1, "the notices coalesce into one item");
  } finally { await c.close(); cleanup(d); }
});

test("start binds the controller's services to the local worker's guards, offers the quiesce coordinator, and reaches remote MCP servers only at checked public addresses (card H12k)", async () => {
  const d = dir();
  const timer = new ManualTimer();
  const built: { guards: RuntimeGuards }[] = [];
  const worker = { hostId: "host:w1" } as unknown as WorkerHost;
  let answer: string[] | string[][] = ["10.0.0.5"];
  let lookups = 0;
  let closed = 0;
  let gated = false;
  const c = await open(join(d, "c.sqlite"), {
    harnesses: [PI],
    dispatch: { timer, manual: true, local: { window: () => 8192, close: async () => { closed++; }, build: (services) => { built.push(services); const limits = services.context({ route: "x" } as never); const relay = services.attemptRelay({ attemptId: "att-r", route: "llama/local", expiresAt: "2999-01-01T00:00:00.000Z" } as never, { forAttempt: (a: { onFirstUsage?: unknown }) => ({ alias: "m0", relayBase: "x", relay: async () => { throw new Error(String(typeof a.onFirstUsage)); } }) } as never);
          assert.equal(services.attemptRelay({ attemptId: "att-r", route: "llama/local", expiresAt: "2999-01-01T00:00:00.000Z" } as never, {} as never), relay, "one relay for every call of an attempt");
          assert.ok(limits !== undefined && (limits.toolOutputBytes ?? 0) > 0 && limits.compaction?.fallback === "extractive", "the composer gives the host the context limits of the window"); return worker; } }, mcp: { resolve: async () => { lookups++; return Array.isArray(answer[0]) ? (answer as string[][])[Math.min(lookups, answer.length) - 1]! : (answer as string[]); }, gate: async () => { if (gated) throw new Error("the controller is paused"); } } },
  });
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    assert.equal(built.length, 1, "the local host is built once, with guards");
    const guards = built[0]!.guards;
    assert.ok(guards.context !== undefined && guards.pause !== undefined && guards.messages !== undefined, "all three guards are bound");
    // Nothing is running: the coordinator just runs the operation.
    assert.equal(await c.dispatch.quiesce.around({ taskId: "tsk-aaaaaaaaaaaaaaaaaaaa" }, "integration", async (quiet) => quiet.attempts.length), 0);
    // A remote server the owner approved is reached through the guard: a private answer is refused, a public one gives the checked address.
    const owner = await c.services.principals.authenticate((await c.services.principals.bootstrapOwner({ name: "rob" })).token);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
    const mcp = c.dispatch.mcp!;
    const server = (await mcp.service.register(owner, { commandId: "m1", name: "docs", mode: "remote", transport: "streamable-http", protocolRevision: "2025-06-18", sdk: { name: "@modelcontextprotocol/sdk", version: "1.12.0" }, remote: { url: "https://mcp.example.com/v1", credentialRef: "docs.token", scopes: ["docs:read"] }, audience: [project], allowed: { tools: ["search"] } } as never)).id;
    await assert.rejects(mcp.connector.connect(server, async () => "connected"), /internal address/);
    answer = ["93.184.216.34"];
    assert.equal(await mcp.connector.connect(server, async (t) => t.address), "93.184.216.34");
    // The rebinding pattern through the composed controller: public at the check, private at the second lookup. The transport is never called.
    let used = false;
    answer = [["93.184.216.34"], ["127.0.0.1"]]; lookups = 0;
    await assert.rejects(mcp.connector.connect(server, async () => { used = true; }), /internal address/);
    assert.deepEqual([lookups, used], [2, false], "the second lookup was the one refused");
    // A rotating public name is fine and the connection uses the first, checked address.
    answer = [["93.184.216.34"], ["93.184.216.35"]]; lookups = 0;
    assert.equal(await mcp.connector.connect(server, async (t) => t.address), "93.184.216.34");
    answer = ["93.184.216.34"];
    // The owner revokes the server: no new connection.
    await mcp.service.revoke(owner, { commandId: "m-rv", serverId: server, expectedRevision: 1 });
    await assert.rejects(mcp.connector.connect(server, async () => { used = true; }), /revoked; no new connection/);
    assert.equal(used, false);
    gated = true;
    await assert.rejects(mcp.connector.connect(server, async () => "connected"), /paused/, "a paused controller gives out no endpoint");
  } finally { await c.close(); assert.equal(closed, 1, "closing the controller shuts the local host down"); cleanup(d); }
});

test("start gives the local host one cache policy per attempt, from the owner's endpoint configuration and a secret that stays on the controller (card H12e)", async () => {
  const d = dir();
  const seen: { forOrder: (order: never) => Promise<{ policy: { key?: string; payload: (p: unknown) => unknown }; routed: boolean }> }[] = [];
  const c = await open(join(d, "c.sqlite"), {
    harnesses: [PI],
    dispatch: {
      timer: new ManualTimer(), manual: true,
      cache: { secret: "installation-secret-0123456789", endpoints: { "vllm/big": { url: "http://127.0.0.1:8000", config: { kind: "vllm", model: "big", route: "vllm/big" } } } },
      local: { window: () => 8192, build: (services) => { seen.push(services.cache as never); return { hostId: "host:w1" } as unknown as WorkerHost; } },
    },
  });
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const cache = seen[0];
    assert.ok(cache !== undefined, "the host is given the cache");
    const order = (attemptId: string, projectId: string, route = "vllm/big") => ({ attemptId, projectId, route }) as never;
    const one = await cache.forOrder(order("att-1", "proj-a"));
    assert.equal(await cache.forOrder(order("att-1", "proj-a")), one, "the same attempt is given the same policy, so the relay and the host share its figures");
    const other = await cache.forOrder(order("att-2", "proj-b"));
    assert.notEqual(one.policy.key, other.policy.key, "another project has another key");
    assert.match(one.policy.key!, /^nn-/);
    assert.equal(JSON.stringify(one.policy).includes("installation-secret"), false);
    // A route with no configured endpoint is a generic backend: nothing is sent.
    assert.equal((await cache.forOrder(order("att-3", "proj-a", "other/model"))).routed, false);
  } finally { await c.close(); cleanup(d); }
});

test("the tick runs the reconciler and stall detection; stall detection needs the dispatcher to hold recovery.stall-scan, and a dispatcher without it says so once instead of failing every tick", async () => {
  const d = dir();
  const timer = new ManualTimer();
  const c = await open(join(d, "c.sqlite"), { harnesses: [PI], dispatch: { timer, intervalMs: 1000 } });
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const owner = await c.services.principals.authenticate((await c.services.principals.bootstrapOwner({ name: "rob" })).token);
    const ran = async () => (await c.dispatch!.dispatcher.tick()).loops.filter((l) => l.name.startsWith("recovery."));
    const notices = async () => (await c.storage.listAggregates("notification-item", { limit: 100 })).filter((n) => JSON.stringify(n.body).includes("recovery.stall-scan")).length;
    assert.deepEqual((await ran()).map((l) => [l.name, l.ok]), [["recovery.reconcile", true], ["recovery.stall-scan", true]], "no failing loop without the right");
    await ran();
    assert.equal(await notices(), 1, "the owner is told once");
    // The owner grants the narrow right: the scan now runs, and the right is not the broad one.
    await c.services.grants.grant(owner, { commandId: "g-scan", grantee: "service:dispatcher", action: "recovery.stall-scan", project: "*", source: "direct", basis: "run stall detection" });
    const dispatcher = (await c.services.principals.get("service:dispatcher"))!;
    assert.equal((await c.services.grants.explain(dispatcher as never, "recovery.stall-scan", "*", new Date().toISOString())).allowed, true);
    assert.equal((await c.services.grants.explain(dispatcher as never, "recovery.read", "*", new Date().toISOString())).allowed, false, "the narrow right does not give the broad one");
    assert.deepEqual((await ran()).map((l) => [l.name, l.ok]), [["recovery.reconcile", true], ["recovery.stall-scan", true]]);
    assert.equal(await notices(), 1);
  } finally {
    await c.close();
    cleanup(d);
  }
});

test("the composed dispatcher reads prerequisites without grants: a task with an open prerequisite waits, starts once it is done, and a cancelled prerequisite opens the owner blocker (card L04c)", async () => {
  const d = dir();
  const timer = new ManualTimer();
  const c = await open(join(d, "c.sqlite"), { harnesses: [PI], dispatch: { timer, intervalMs: 1000 } });
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const s = c.services;
    const owner = await s.principals.authenticate((await s.principals.bootstrapOwner({ name: "rob" })).token);
    const project = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
    const mk = async (n: string): Promise<string> => { const t = (await s.projects.createTask({ commandId: `t-${n}`, actor: owner.id, projectId: project, title: `Task ${n}` })).id; await s.projects.transitionTask({ commandId: `r-${n}`, actor: owner.id, taskId: t, expectedRevision: 1, to: "ready" }); return t; };
    const admit = async (n: string, task: string): Promise<string> => {
      const agent = `ag${n}`;
      await s.principals.enroll(owner, { commandId: `e-${n}`, kind: "agent", name: agent, grants: [] });
      await s.assignments.assignTask({ commandId: `as-${n}`, actor: owner.id, taskId: task, owner: { kind: "agent", id: agent } });
      const a = (await s.assignments.getAssignment(task))!;
      return (await s.assignments.admitAttempt({ commandId: `ad-${n}`, actor: "inbox", taskId: task, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: agent }, harness: "pi" })).id;
    };
    const base = await mk("base");
    const dep = await mk("dep");
    await s.contracts.addDependency(owner, { commandId: "dep1", taskId: dep, prerequisiteId: base });
    const attempt = await admit("1", dep);
    const why = async () => { const t = await c.dispatch!.dispatcher.tick(); return [...t.blocked, ...t.skipped].find((x) => x.attemptId === attempt); };
    for (let n = 0; n < 2; n++) {
      const w = await why();
      assert.equal(w?.check, "dependency", JSON.stringify(w));
      assert.match((w as { reason?: string }).reason ?? "", new RegExp(base));
    }
    await s.projects.transitionTask({ commandId: "ip", actor: owner.id, taskId: base, expectedRevision: 2, to: "in_progress" });
    await s.projects.transitionTask({ commandId: "dn", actor: owner.id, taskId: base, expectedRevision: 3, to: "done" });
    const after = await why();
    assert.notEqual(after?.check, "dependency", "with the prerequisite done the dependency check passes (a later check, here the route, answers)");

    // A cancelled prerequisite: the dependent waits and the owner gets one blocker, however many ticks.
    const base2 = await mk("base2");
    const dep2 = await mk("dep2");
    await s.contracts.addDependency(owner, { commandId: "dep2", taskId: dep2, prerequisiteId: base2 });
    await s.projects.transitionTask({ commandId: "cx", actor: owner.id, taskId: base2, expectedRevision: 2, to: "cancelled" });
    const attempt2 = await admit("2", dep2);
    for (let n = 0; n < 2; n++) {
      const t: TickReport = await c.dispatch.dispatcher.tick();
      const w: { check: string; reason: string } | undefined = t.skipped.find((x) => x.attemptId === attempt2);
      assert.equal(w?.check, "dependency", JSON.stringify(t));
      assert.match(w!.reason, /cancelled or missing/);
    }
    const blockers = (await BlockerService.withEpoch(c.storage, c.epoch).list({ limit: 50, openOnly: true })).items.filter((b) => b.subject.id === dep2);
    assert.equal(blockers.length, 1, JSON.stringify(blockers));
  } finally { await c.close(); cleanup(d); }
});

test("start hands the configured limits for local agents to the host builder, and refuses a bad figure at start (card H12k)", async () => {
  const d = dir();
  const seen: unknown[] = [];
  const mk = (limits?: unknown) => ({ harnesses: [PI], dispatch: { timer: new ManualTimer(), manual: true, local: { window: () => 8192, ...(limits === undefined ? {} : { limits }), build: (s: { currentLimits: () => Promise<unknown> }) => { seen.push(s.currentLimits()); return { hostId: "host:w1" } as unknown as WorkerHost; } } } } as unknown as Partial<Parameters<typeof startController>[0]>);
  const none = await open(join(d, "a.sqlite"), mk());
  await none.close();
  assert.deepEqual(await Promise.all(seen), [undefined], "nothing configured: nothing applied");
  const c = await open(join(d, "b.sqlite"), mk({ cpus: 2, memoryMb: 2048, processes: undefined }));
  await c.close();
  assert.deepEqual(await seen[1], { cpus: 2, memoryMb: 2048 });
  for (const bad of [{ cpus: 0 }, { cpus: 1.5 }, { memoryMb: "1g" }, { diskMb: -1 }, { gpus: 1 }, [1], null]) {
    await assert.rejects(open(join(d, `x${seen.length}.sqlite`), mk(bad)), /dispatch\.local\.limits/);
  }
  assert.equal(seen.length, 2, "a refused start builds nothing");
  cleanup(d);
});
