import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdmissionService } from "../admission/index.js";
import { ScriptedInterpreter } from "../chat/index.js";
import { ModelRelay } from "../dispatch/relay.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI, ScriptedWorker, workGrants } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { GenerationService } from "../generation/index.js";
import { HostService } from "../hosts/index.js";
import { PolicyService } from "../policy/index.js";
import { DifficultyService } from "../routing/index.js";
import { durationInWords } from "../chat/commands.js";
import { routeCallsOf } from "./route-calls.js";
import { startController, type Controller } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const local = { enabled: true, paid: false, location: "local" as const };
const route = { contextTokens: 100_000, capabilities: ["tools"] };
// Three local engines on three endpoints; every model-using role has a list over them.
const table = {
  providers: { strata: local, gpu2: local, gpu3: local },
  routes: { "strata/qwen": route, "gpu2/qwen": route, "gpu3/qwen": route },
  profiles: { main: ["strata/qwen", "gpu2/qwen", "gpu3/qwen"] },
  roles: { coordinator: "main", "safety-supervisor": "main" },
};
const topology = {
  services: ["strata-svc"],
  targets: { "strata/qwen": { endpoint: "strata-http", account: "local", service: "strata-svc" }, "gpu2/qwen": { endpoint: "gpu2-http", account: "local" }, "gpu3/qwen": { endpoint: "gpu3-http", account: "local" } },
  aliases: {},
};
const PROFILES = { profiles: { default: { harness: "pi", routingProfile: "main" } }, mapping: { unrated: "default" } };
const ANN = "agt-annannannannannannan";
type Reply = { ok: boolean; result?: any; error?: { code: string; message: string } };

/** A worker that keeps its attempt running until the test ends it, and remembers which route each attempt was started on. */
function holdingWorker(): { worker: ScriptedWorker; routes: Map<string, string> } {
  const routes = new Map<string, string>();
  // The turn lasts until its worker is stopped (a cutover, a stop, the controller closing).
  const worker = new ScriptedWorker("host:w1", async ({ order, worker: handle }) => {
    routes.set(order.attemptId, order.route);
    await new Promise<void>((resolve) => { const t = setInterval(() => { if (handle.stopped > 0) { clearInterval(t); resolve(); } }, 5); });
    return { status: "cancelled", text: "stopped" };
  });
  return { worker, routes };
}

async function open(dir: string, worker: ScriptedWorker, extra: Record<string, unknown> = {}): Promise<Controller> {
  return startController({
    storage: { kind: "sqlite", path: join(dir, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: { timer: new ManualTimer(), manual: true, workers: [worker] }, ...extra,
  } as never);
}

async function setUp(c: Controller): Promise<{ token: string; owner: Awaited<ReturnType<Controller["services"]["principals"]["authenticate"]>>; project: string }> {
  const s = c.services;
  const boot = await s.principals.bootstrapOwner({ name: "rob" });
  const owner = await s.principals.authenticate(boot.token);
  await s.routing.setTable(owner, { commandId: "rt", expectedRevision: 0, table } as never);
  await s.cutover.setTopology(owner, { commandId: "topo", expectedRevision: 0, topology } as never);
  await DifficultyService.withEpoch(c.storage, c.epoch, s.routing, s.contracts).setProfiles(owner, { commandId: "sp", expectedRevision: 0, profiles: PROFILES } as never);
  await s.principals.enroll(owner, { commandId: "e-host", kind: "host", name: "w1", grants: [] });
  const hostP = await s.principals.authenticate((await s.principals.issueCredential(owner, "host:w1")).token);
  const hosts = HostService.withEpoch(c.storage, c.epoch, s.assignments);
  await hosts.announce(hostP, { commandId: "an", capabilities: { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] } });
  await hosts.heartbeat(hostP, { commandId: "hb", sequence: 1 });
  await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap", actor: owner.id, host: "host:w1", capacity: { cpus: 8, memoryMb: 16_384 } });
  await PolicyService.withEpoch(c.storage, c.epoch, s.grants).set(owner, { scope: "installation", commandId: "pol", profile: "autonomous" } as never);
  const project = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
  await s.principals.enroll(owner, { commandId: `e-${ANN}`, kind: "agent", name: ANN, grants: [...workGrants(project)] });
  return { token: boot.token, owner, project };
}

async function task(c: Controller, owner: { id: string }, project: string, n: number): Promise<{ taskId: string; attemptId: string }> {
  const s = c.services;
  const taskId = (await s.projects.createTask({ commandId: `t${n}`, actor: owner.id, projectId: project, title: `Water bed ${n}` })).id;
  await s.projects.transitionTask({ commandId: `r${n}`, actor: owner.id, taskId, expectedRevision: 1, to: "ready" });
  await s.assignments.assignTask({ commandId: `as${n}`, actor: owner.id, taskId, owner: { kind: "agent", id: ANN } });
  const a = (await s.assignments.getAssignment(taskId))!;
  return { taskId, attemptId: (await s.assignments.admitAttempt({ commandId: `ad${n}`, actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: ANN }, harness: "pi" })).id };
}

const api = (c: Controller, token: string) => (op: string, args: Record<string, unknown>, commandId?: string): Promise<Reply> => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<Reply>;

test("model calls of the running controller go through the fallback service: a drain sends the next attempt elsewhere and leaves the running one, a cutover cancels the running generation and worker and its replacement goes to the next open route, and both hold across a restart (card R04c)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-rcalls-"));
  const first = holdingWorker();
  let c = await open(d, first.worker);
  let crashed: Controller | undefined;
  try {
    const { token, owner, project } = await setUp(c);
    let call = api(c, token);
    const tick = async (): Promise<void> => { await c.dispatch!.dispatcher.tick(); };
    const one = await task(c, owner, project, 1);
    await tick();
    assert.equal((await c.dispatch!.dispatcher.get(owner, one.attemptId))!.state, "running");
    assert.equal(first.routes.get(one.attemptId), "strata/qwen", "the first route of the list");
    // The run is a model call of the fallback service: sent, and counted by the drain report.
    const mc1 = (await c.dispatch!.dispatcher.get(owner, one.attemptId))!.modelCall!;
    assert.deepEqual([mc1.route, mc1.sent], ["strata/qwen", true]);
    assert.ok((await c.services.fallback.call(c.dispatch!.principal, mc1.callId))!.attempts[0]!.sentAt !== undefined, "the fallback service was told the request is under way");
    const r0 = (await call("routing.report", { level: "endpoint", name: "strata-http" })).result.report;
    assert.deepEqual([r0.routingApplied, r0.inFlightRemaining, r0.safeToStop], [false, 1, false]);

    // Drain: new work goes elsewhere at once; the running attempt is left to finish.
    assert.ok((await call("routing.drain", { level: "service", name: "strata-svc", reason: "swap the disk", drainSeconds: 3600 }, "dr1")).ok);
    const r1 = (await call("routing.report", { level: "service", name: "strata-svc" })).result.report;
    assert.deepEqual([r1.routingApplied, r1.inFlightRemaining, r1.safeToStop], [true, 1, false], "applied, one still running, not safe yet");
    const two = await task(c, owner, project, 2);
    await tick();
    assert.equal(first.routes.get(two.attemptId), "gpu2/qwen", "the next attempt went past the draining service");
    // Card G09: the task's activity says why it is not on its configured route (its routing decision names that one); the running attempt has nothing of the kind.
    const why = async (taskId: string): Promise<string[]> => (await c.services.activity.steps(owner, taskId)).steps.map((s) => ("summary" in s ? String(s.summary) : "")).filter((s) => /closed to new work/.test(s));
    const told = await why(two.taskId);
    assert.equal(told.length, 1, JSON.stringify(told));
    assert.equal(told[0], `The task's configured route strata/qwen is closed to new work, so attempt ${two.attemptId} goes to the next open route gpu2/qwen (strata/qwen: service strata-svc is draining (no new work): swap the disk).`);
    assert.deepEqual(await why(one.taskId), []);
    assert.equal((await c.dispatch!.dispatcher.get(owner, one.attemptId))!.state, "running", "a drain leaves the running attempt alone");
    assert.equal(first.worker.handles.find((h) => h.order.attemptId === one.attemptId)!.stopped, 0);

    // Cutover of gpu2: the running attempt there is cancelled (its generation, its worker), a replacement is admitted and runs on the next open route.
    const cut = await call("routing.cutover", { level: "endpoint", name: "gpu2-http", reason: "the card is overheating" }, "cut1");
    assert.equal(cut.ok, true, JSON.stringify(cut));
    assert.equal(cut.result.cancelled.length, 1);
    const ended = (await c.dispatch!.dispatcher.get(owner, two.attemptId))!;
    assert.equal(ended.state, "finished");
    assert.match(ended.outcome!.summary, /gpu2\/qwen was cut over/);
    assert.equal(first.worker.handles.find((h) => h.order.attemptId === two.attemptId)!.stopped, 1, "the runtime was stopped");
    const generations = GenerationService.withEpoch(c.storage, c.epoch, { assignments: c.services.assignments } as never);
    assert.equal((await generations.gate(owner, two.taskId))?.gate.hold, undefined, "the generation hold of the cutover was lifted once the attempt ended");
    const cancelledCall = await c.services.fallback.call(c.dispatch!.principal, ended.modelCall!.callId);
    assert.equal(cancelledCall!.attempts[0]!.outcome, "abandoned");
    // A late reply for the cancelled attempt is recorded, never applied.
    assert.deepEqual(await c.services.fallback.succeeded(c.dispatch!.principal, { commandId: "late-1", callId: ended.modelCall!.callId, attempt: 1, usage: { inputTokens: 1, outputTokens: 1, costMicros: 0 } }), { applied: false });
    const replacement = (await c.services.assignments.getAssignment(two.taskId))!.activeAttemptId!;
    assert.ok(replacement !== undefined && replacement !== two.attemptId, "a replacement was admitted");
    await tick();
    assert.equal(first.routes.get(replacement), "gpu3/qwen", "the replacement went to the next open route");
    // The cutover is done: nothing runs on gpu2 and it is safe to stop.
    const r2 = (await call("routing.report", { level: "endpoint", name: "gpu2-http" })).result.report;
    assert.deepEqual([r2.routingApplied, r2.inFlightRemaining, r2.safeToStop, r2.cancelPending], [true, 0, true, false]);
    // The owner reads all of it in chat terms (the status view the chat uses).
    const view = (await call("status.ask", { request: { kind: "model_routes" } })).result.item.lines.map((l: { text: string }) => l.text).join("\n");
    assert.match(view, /service strata-svc is draining until/);
    assert.match(view, /endpoint gpu2-http is cut over since .*: the card is overheating/);
    const one2 = (await call("status.ask", { request: { kind: "model_routes", level: "service", name: "strata-svc" } })).result.item.lines.map((l: { text: string }) => l.text).join("\n");
    assert.match(one2, /routing applied \(draining\)[\s\S]*1 request\(s\) still running[\s\S]*not safe to stop/);

    // The process dies (it is not closed): a new controller takes over the same records. The controls and the running call hold; a cutover then still finds the attempt that started before, and the host is told to let it go.
    crashed = c;
    const second = holdingWorker();
    c = await open(d, second.worker);
    call = api(c, token);
    const controls = (await call("routing.controls", {})).result.controls;
    assert.deepEqual(controls.entries.map((e: { level: string; name: string; mode: string }) => `${e.level}/${e.name}/${e.mode}`).sort(), ["endpoint/gpu2-http/cutover", "service/strata-svc/drain"]);
    const r3 = (await call("routing.report", { level: "service", name: "strata-svc" })).result.report;
    assert.equal(r3.inFlightRemaining, 1, "the running call survived the restart");
    const cut2 = await call("routing.cutover", { level: "service", name: "strata-svc", reason: "the drain took too long" }, "cut2");
    assert.equal(cut2.ok, true, JSON.stringify(cut2));
    assert.equal((await c.dispatch!.dispatcher.get(owner, one.attemptId))!.state, "finished");
    assert.ok(second.worker.released.some((r) => r.attemptId === one.attemptId), "the host was told to let the worker go");
    const again = (await c.services.assignments.getAssignment(one.taskId))!.activeAttemptId!;
    await c.dispatch!.dispatcher.tick();
    assert.equal(second.routes.get(again), "gpu3/qwen", "after the restart the replacement went to the only open route");
    // Cutting over the last open route cancels both attempts on it (one started by the dead process, one by this one); every route is now closed, so their replacements wait (no blocker) until the owner re-enables a target.
    const cut3 = await call("routing.cutover", { level: "endpoint", name: "gpu3-http", reason: "maintenance" }, "cut3");
    assert.equal(cut3.result.cancelled.length, 2, JSON.stringify(cut3));
    const replacements = [(await c.services.assignments.getAssignment(one.taskId))!.activeAttemptId!, (await c.services.assignments.getAssignment(two.taskId))!.activeAttemptId!];
    const closed = await c.dispatch!.dispatcher.tick();
    for (const id of replacements) assert.ok(closed.skipped.some((s) => s.attemptId === id && s.check === "route" && /closed to new work/.test(s.reason)), JSON.stringify(closed.skipped));
    assert.deepEqual(closed.blocked, []);
    assert.ok((await call("routing.reenable", { level: "endpoint", name: "gpu2-http", reason: "cooled down" }, "re2")).ok);
    await c.dispatch!.dispatcher.tick();
    assert.deepEqual(replacements.map((id) => second.routes.get(id)), ["gpu2/qwen", "gpu2/qwen"]);

    // An orderly restart: the attempts that were running go back to waiting with their calls ended, so nothing is counted as running on a route; started again, they go to an open route.
    await c.close();
    const third = holdingWorker();
    c = await open(d, third.worker);
    call = api(c, token);
    const r4 = (await call("routing.report", { level: "endpoint", name: "gpu2-http" })).result.report;
    assert.equal(r4.inFlightRemaining, 0, "nothing runs on gpu2 while the controller is down");
    for (const id of replacements) assert.equal((await c.dispatch!.dispatcher.get(owner, id))!.state, "waiting");
    await c.dispatch!.dispatcher.tick();
    assert.deepEqual(replacements.map((id) => third.routes.get(id)), ["gpu2/qwen", "gpu2/qwen"], "the same attempts started again on the open route");
    assert.equal((await call("routing.report", { level: "endpoint", name: "gpu2-http" })).result.report.inFlightRemaining, 2);
  } finally {
    await c.close();
    await crashed?.close().catch(() => undefined);
    rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("the model relay of an attempt whose call was cut over sends nothing more, even before its worker is stopped (card R04c)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-rrelay-"));
  const held = holdingWorker();
  let services: { attemptRelay: (order: never, relay: ModelRelay) => { relayBase: string; alias: string; relay: (r: never) => Promise<{ status: number }> } } | undefined;
  const sent: string[] = [];
  const relay = new ModelRelay({ endpoint: () => ({ url: "http://engine.internal:8080/v1/" }), fetch: async (url) => { sent.push(String(url)); return new Response("{}", { status: 200 }); } });
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: { timer: new ManualTimer(), manual: true, local: { acceptUnenforcedLimits: true, window: () => 100_000, close: async () => undefined, build: (s: never) => { services = s; return held.worker; } } },
  } as never);
  try {
    const { token, owner, project } = await setUp(c);
    const one = await task(c, owner, project, 1);
    await c.dispatch!.dispatcher.tick();
    const order = held.worker.starts.find((o) => o.attemptId === one.attemptId)!;
    assert.equal(order.route, "strata/qwen");
    const attempt = services!.attemptRelay(order as never, relay);
    const ask = () => attempt.relay({ url: `${attempt.relayBase}/${attempt.alias}/chat/completions`, method: "POST", headers: [["content-type", "application/json"]], body: Buffer.from("{}"), signal: new AbortController().signal } as never);
    assert.equal((await ask()).status, 200);
    // The call is taken back as a cutover does it, but the listener has not stopped the worker yet (it failed once): the relay refuses on its own.
    const mc = (await c.dispatch!.dispatcher.get(owner, one.attemptId))!.modelCall!;
    await c.services.fallback.abandon(c.dispatch!.principal, { commandId: "cut-by-hand", callId: mc.callId, attempt: mc.attempt, reason: "cutover of endpoint strata-http" });
    assert.equal((await c.dispatch!.dispatcher.get(owner, one.attemptId))!.state, "running");
    const before = sent.length;
    await assert.rejects(ask, /the model relay refused the call: the route strata\/qwen of this attempt was cut over or closed/);
    assert.equal(sent.length, before, "nothing was sent");
    void token;
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("the fallback lists are checked in the running controller: a role with an empty list, or a topology that would put a whole list on one endpoint, is refused at configuration (card R04c)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-rlists-"));
  const c = await open(d, holdingWorker().worker);
  try {
    const s = c.services;
    const owner = await s.principals.authenticate((await s.principals.bootstrapOwner({ name: "rob" })).token);
    const empty = { ...table, profiles: { ...table.profiles, none: [] }, roles: { ...table.roles, reviewer: "none" } };
    await assert.rejects(s.configuration.bindRouting(owner, { commandId: "b0", expectedRevision: 0, routing: empty } as never), /reviewer profile none is empty/);
    await assert.rejects(s.routing.setTable(owner, { commandId: "t0", expectedRevision: 0, table: { ...table, roles: { coordinator: "main" } } } as never), /safety-supervisor has no fallback list/);
    await s.configuration.bindRouting(owner, { commandId: "b1", expectedRevision: 0, routing: table } as never);
    const oneEndpoint = { services: [], aliases: {}, targets: Object.fromEntries(Object.keys(table.routes).map((r) => [r, { endpoint: "one-box", account: "local" }])) };
    await assert.rejects(s.cutover.setTopology(owner, { commandId: "o0", expectedRevision: 0, topology: oneEndpoint } as never), /every entry of profile main is on one endpoint/);
    await s.cutover.setTopology(owner, { commandId: "o1", expectedRevision: 0, topology } as never);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("health probes run on the dispatcher's timer for a target that is down, only while switched on, and a drain past its deadline becomes a cutover on the tick (card R04c)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-rprobe-"));
  const probed: string[] = [];
  let enabled = false;
  const held = holdingWorker();
  const c = await open(d, held.worker, { routeProbes: { run: async (p: { route: string }) => { probed.push(p.route); return true; }, intervalMs: 1000, get enabled() { return enabled; } } });
  try {
    const { token, owner, project } = await setUp(c);
    const call = api(c, token);
    // An outage of gpu2's endpoint, learned the way a reported failure teaches the gate.
    await c.services.cutover.gate().failure!({ route: "gpu2/qwen", class: "outage", at: new Date().toISOString(), key: "seed-outage" });
    assert.equal((await c.services.cutover.health("endpoint", "gpu2-http"))?.state, "down");
    await c.dispatch!.dispatcher.tick();
    assert.deepEqual(probed, [], "switched off: nothing is sent");
    enabled = true;
    await c.dispatch!.dispatcher.tick();
    assert.deepEqual(probed, ["gpu2/qwen"], "one probe on the tick");
    assert.equal((await c.services.cutover.health("endpoint", "gpu2-http"))?.probesOk, 1);
    // A drain whose deadline passes is turned into a cutover by the tick, which cancels what still runs on the target.
    const one = await task(c, owner, project, 1);
    await c.dispatch!.dispatcher.tick();
    assert.equal(held.routes.get(one.attemptId), "strata/qwen");
    assert.ok((await call("routing.drain", { level: "endpoint", name: "strata-http", reason: "short drain", drainSeconds: 1 }, "dr")).ok);
    await new Promise((r) => setTimeout(r, 1100));
    await c.dispatch!.dispatcher.tick();
    const after = (await c.dispatch!.dispatcher.get(owner, one.attemptId))!;
    assert.equal(after.state, "finished", "the expired drain cut the attempt over");
    const entry = (await call("routing.controls", {})).result.controls.entries[0];
    assert.deepEqual([entry.mode, entry.expired], ["cutover", true]);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("the owner drains and cuts over by free-form chat: a drain follows the approval profile, a cutover is shown first and runs when accepted, and both are in the interpreter's instructions (card R04c)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-rchat-"));
  const say: Record<string, unknown[]> = {};
  const c = await open(d, holdingWorker().worker, { chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) } });
  try {
    const { token } = await setUp(c);
    const call = api(c, token);
    const cmd = (op: string, args: Record<string, unknown>, evidence: string) => ({ kind: "command", op, args, evidence, basis: "owner" });
    let n = 0;
    const turn = async (text: string, intents: unknown[]) => { say[text] = intents; return c.chat!.submit(token, { messageId: `m${++n}`, text }); };
    let text = "Drain the strata-svc service over the next 3600 seconds, we are swapping its disk.";
    let out = await turn(text, [cmd("routing.drain", { level: "service", name: "strata-svc", reason: "we are swapping its disk", drainSeconds: 3600 }, text)]);
    assert.equal(out.outcomes[0]!.status, "applied", JSON.stringify(out.outcomes));
    assert.equal((await call("routing.controls", {})).result.controls.entries[0].mode, "drain");
    text = "Cut over from gpu2-http right now, the card is overheating.";
    out = await turn(text, [cmd("routing.cutover", { level: "endpoint", name: "gpu2-http", reason: "the card is overheating" }, text)]);
    assert.equal(out.outcomes[0]!.status, "proposed", JSON.stringify(out.outcomes));
    assert.equal((await call("routing.controls", {})).result.controls.entries.length, 1, "nothing is cut over before it is accepted");
    const proposalId = (out.outcomes[0] as { proposalId?: string }).proposalId!;
    text = "Yes, do it.";
    out = await turn(text, [{ kind: "apply_proposal", proposalId, evidence: "Yes, do it.", basis: "owner" }]);
    assert.ok(out.outcomes.some((o) => o.status === "applied"), JSON.stringify(out.outcomes));
    assert.deepEqual((await call("routing.controls", {})).result.controls.entries.map((e: { mode: string }) => e.mode).sort(), ["cutover", "drain"]);
    // A name the owner did not say is not taken from the model.
    text = "Drain the other box for an hour.";
    out = await turn(text, [cmd("routing.drain", { level: "endpoint", name: "gpu3-http", reason: "other box", drainSeconds: 3600 }, text)]);
    assert.notEqual(out.outcomes[0]!.status, "applied");
    // The status view is reachable by chat as well.
    text = "What is out of service right now?";
    out = await turn(text, [{ kind: "status", request: { kind: "model_routes" }, evidence: text, basis: "owner" }]);
    assert.match(out.reply.join("\n"), /endpoint gpu2-http is cut over/);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("each run's model call is reported once whatever the end: a worker that never starts withdraws it, a completed turn succeeds with its own charge once, a call sent but not recorded as sent is abandoned rather than left running, and an owner's hold on the task is not lifted by a cutover (card R04c)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-rends-"));
  const held = holdingWorker();
  const c = await open(d, held.worker);
  try {
    const { owner, project } = await setUp(c);
    const fb = c.services.fallback;
    const by = c.dispatch!.principal;
    const calls = routeCallsOf(fb, c.services.cutover, by);
    const request = { contextTokens: 1000, needs: ["tools"], data: "local-only" as const, paidAuthorized: false };
    const tk = (await c.services.projects.createTask({ commandId: "tx", actor: owner.id, projectId: project, title: "Prune hedge" })).id;
    const begin = async (key: string): Promise<{ callId: string; attempt: number }> => { const got = await calls.begin({ key, taskId: tk, route: "strata/qwen", role: "worker", request }); assert.ok("callId" in got, JSON.stringify(got)); return got; };
    const inFlight = async (): Promise<number> => (await fb.inFlight(by)).filter((f) => f.taskId === tk).length;
    // Never started: withdrawn, no charge, not counted; a repeat changes nothing.
    const a = await begin("k-a");
    await calls.ended({ ...a, sent: false, outcome: "failed", summary: "x", costMicros: 0 });
    await calls.ended({ ...a, sent: false, outcome: "failed", summary: "x", costMicros: 0 });
    assert.equal((await fb.call(by, a.callId))!.attempts[0]!.outcome, "skipped");
    assert.equal(await inFlight(), 0);
    // A completed turn: succeeded with what it was charged, once even when reported again.
    const b = await begin("k-b");
    await calls.sent(b);
    await calls.ended({ ...b, sent: true, outcome: "succeeded", summary: "done", costMicros: 7 });
    await calls.ended({ ...b, sent: true, outcome: "succeeded", summary: "done", costMicros: 7 });
    assert.deepEqual([(await fb.spend(tk)).costMicros, (await fb.spend(tk)).calls], [7, 1]);
    // Sent as far as the fallback service knows, but the attempt's record never said so (a crash between the two): abandoned, not left running for ever.
    const e = await begin("k-e");
    await calls.sent(e);
    await calls.ended({ ...e, sent: false, outcome: "failed", summary: "lost", costMicros: 0 });
    assert.equal((await fb.call(by, e.callId))!.attempts[0]!.outcome, "abandoned");
    assert.equal(await inFlight(), 0, "nothing is left running on the route");
    assert.equal((await fb.spend(tk)).failures ?? 0, 0, "an abandoned run is not a failure of the route or the task");

    // An owner's pause of a task whose attempt is cut over: the attempt still ends, and the owner's hold stays.
    const one = await task(c, owner, project, 1);
    await c.dispatch!.dispatcher.tick();
    assert.equal((await c.dispatch!.dispatcher.get(owner, one.attemptId))!.state, "running");
    const generations = GenerationService.withEpoch(c.storage, c.epoch, { assignments: c.services.assignments } as never);
    await generations.interrupt(owner, { commandId: "own-hold", taskId: one.taskId, mode: "finish_and_hold", reason: "the owner looks at it first" } as never);
    const before = (await generations.gate(owner, one.taskId))?.gate.hold;
    assert.equal(before?.reason, "the owner looks at it first");
    await c.services.cutover.cutover(owner, { commandId: "cut-own", level: "endpoint", name: "strata-http", reason: "maintenance" } as never);
    assert.equal((await c.dispatch!.dispatcher.get(owner, one.attemptId))!.state, "finished", "the attempt still ends");
    assert.equal((await generations.gate(owner, one.taskId))?.gate.hold?.reason, "the owner looks at it first", "the owner's hold is left as it was");

    // A worker that cannot start: the call begun for it is withdrawn (skipped, no charge), so no route is left with a call that never ran.
    held.worker.failToStart = new Error("no sandbox");
    const two = await task(c, owner, project, 2);
    await c.dispatch!.dispatcher.tick();
    const two2 = (await c.dispatch!.dispatcher.get(owner, two.attemptId))!;
    assert.ok(two2.modelCall !== undefined, "a call was begun for it");
    const callTwo = (await fb.call(by, two2.modelCall.callId))!;
    assert.deepEqual([callTwo.attempts.at(-1)!.outcome, callTwo.attempts.at(-1)!.sentAt, callTwo.charges ?? []], ["skipped", undefined, []], JSON.stringify(callTwo));
    assert.equal((await fb.inFlight(by)).filter((f) => f.taskId === two.taskId).length, 0);
    held.worker.failToStart = undefined;

    // A task whose model budget is used up does not start: the attempt waits (no call left behind) until the owner raises it.
    const three = await task(c, owner, project, 3);
    await fb.setBudget(owner, { commandId: "bud3", taskId: three.taskId, maxCostMicros: 0 });
    const waited = await c.dispatch!.dispatcher.tick();
    assert.ok(waited.skipped.some((s) => s.attemptId === three.attemptId && s.check === "route" && /budget is used up/.test(s.reason)), JSON.stringify(waited.skipped));
    assert.notEqual((await c.dispatch!.dispatcher.get(owner, three.attemptId))!.state, "running");
    assert.equal((await fb.inFlight(by)).filter((f) => f.taskId === three.taskId).length, 0);
    await fb.setBudget(owner, { commandId: "bud3b", taskId: three.taskId, maxCostMicros: null });
    await c.dispatch!.dispatcher.tick();
    assert.equal((await c.dispatch!.dispatcher.get(owner, three.attemptId))!.state, "running", "raised: it starts");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a drain's time must be in the owner's own words: a number the model chose is refused, and the owner's own duration in any usual wording is taken (card R04c)", async () => {
  assert.equal(durationInWords(3600, "Drain it over the next hour."), true);
  assert.equal(durationInWords(3600, "drain for 60 minutes"), true);
  assert.equal(durationInWords(1800, "give it half an hour"), true);
  assert.equal(durationInWords(5400, "1.5 hours please"), true);
  assert.equal(durationInWords(600, "Drain the strata box, we are swapping its disk."), false);
  assert.equal(durationInWords(3600, "Drain gpu-3600 now"), false);
  const d = mkdtempSync(join(tmpdir(), "nn-rdrainw-"));
  const say: Record<string, unknown[]> = {};
  const c = await open(d, holdingWorker().worker, { chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) } });
  try {
    const { token } = await setUp(c);
    const call = api(c, token);
    const text = "Drain the strata-svc service, we are swapping its disk.";
    say[text] = [{ kind: "command", op: "routing.drain", args: { level: "service", name: "strata-svc", reason: "we are swapping its disk", drainSeconds: 600 }, evidence: text, basis: "owner" }];
    const out = await c.chat!.submit(token, { messageId: "m1", text });
    assert.equal(out.outcomes[0]!.status, "refused", JSON.stringify(out.outcomes));
    assert.equal((await call("routing.controls", {})).result.controls.entries.length, 0, "nothing was drained");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a cutover that lands while the worker is starting: the run does not go on, the worker is let go and a replacement is admitted (card R04c)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-rstart-"));
  const held = holdingWorker();
  const c = await open(d, held.worker);
  try {
    const { owner, project } = await setUp(c);
    const fb = c.services.fallback;
    const by = c.dispatch!.principal;
    let release!: () => void;
    held.worker.startGate = new Promise<void>((r) => { release = r; });
    const one = await task(c, owner, project, 1);
    const ticking = c.dispatch!.dispatcher.tick();
    for (let i = 0; i < 400 && !held.worker.starts.some((o) => o.attemptId === one.attemptId); i++) await new Promise((r) => setTimeout(r, 5));
    const mc = (await c.dispatch!.dispatcher.get(owner, one.attemptId))!.modelCall!;
    await fb.abandon(by, { commandId: "cut-while-starting", callId: mc.callId, attempt: mc.attempt, reason: "cutover of endpoint strata-http" });
    release();
    await ticking;
    const ended = (await c.dispatch!.dispatcher.get(owner, one.attemptId))!;
    assert.equal(ended.state, "finished", JSON.stringify(ended));
    assert.match(ended.outcome!.summary, /taken back while the worker was starting/);
    assert.equal((await fb.call(by, mc.callId))!.attempts[0]!.sentAt, undefined, "never marked sent");
    assert.equal(held.worker.handles.find((h) => h.order.attemptId === one.attemptId)!.stopped, 1, "the worker was let go");
    assert.notEqual((await c.services.assignments.getAssignment(one.taskId))!.activeAttemptId, one.attemptId, "a replacement was admitted");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("an attempt that waited while its configured route was closed and then ran on that route is not said to have moved; one placed past it is told once, however many ticks it waited (card G09)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-rwait-"));
  const held = holdingWorker();
  const c = await open(d, held.worker);
  try {
    const { token, owner, project } = await setUp(c);
    const call = api(c, token);
    const tick = async (): Promise<void> => { await c.dispatch!.dispatcher.tick(); };
    const why = async (taskId: string): Promise<string[]> => (await c.services.activity.steps(owner, taskId)).steps.map((s) => ("summary" in s ? String(s.summary) : "")).filter((s) => /closed to new work/.test(s));
    const admission = AdmissionService.withEpoch(c.storage, c.epoch);
    // The host has room for nothing: the attempt passes the route step (strata is draining, gpu2 is open) and then waits for a host.
    await admission.setCapacity({ commandId: "cap-small", actor: owner.id, host: "host:w1", capacity: { cpus: 1, memoryMb: 1 } });
    assert.ok((await call("routing.drain", { level: "service", name: "strata-svc", reason: "swap the disk", drainSeconds: 3600 }, "dr1")).ok);
    const one = await task(c, owner, project, 1);
    for (let n = 0; n < 3; n++) await tick();
    assert.notEqual((await c.dispatch!.dispatcher.get(owner, one.attemptId))!.state, "running", "no host could take it");
    assert.deepEqual(await why(one.taskId), [], "nothing is said while it waits: it has gone nowhere");
    // The drain is lifted and the host has room again: the attempt runs on its configured route, and nothing says it moved.
    assert.ok((await call("routing.reenable", { level: "service", name: "strata-svc", reason: "the disk is in" }, "re1")).ok);
    await admission.setCapacity({ commandId: "cap-big", actor: owner.id, host: "host:w1", capacity: { cpus: 8, memoryMb: 16_384 } });
    await tick();
    assert.equal(held.routes.get(one.attemptId), "strata/qwen");
    assert.deepEqual(await why(one.taskId), [], "it ran on its configured route");
    // A second attempt placed past a closed route after waiting several ticks: one step.
    await admission.setCapacity({ commandId: "cap-small2", actor: owner.id, host: "host:w1", capacity: { cpus: 1, memoryMb: 1 } });
    assert.ok((await call("routing.drain", { level: "service", name: "strata-svc", reason: "swap the disk", drainSeconds: 3600 }, "dr2")).ok);
    const two = await task(c, owner, project, 2);
    for (let n = 0; n < 3; n++) await tick();
    assert.deepEqual(await why(two.taskId), []);
    await admission.setCapacity({ commandId: "cap-big2", actor: owner.id, host: "host:w1", capacity: { cpus: 8, memoryMb: 16_384 } });
    for (let n = 0; n < 3; n++) await tick();
    assert.equal(held.routes.get(two.attemptId), "gpu2/qwen");
    assert.equal((await why(two.taskId)).length, 1);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
