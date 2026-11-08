import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdmissionService } from "../admission/index.js";
import { ScriptedInterpreter } from "../chat/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { EXEC_PROFILES, PI, ROUTING_TABLE, ScriptedWorker, workGrants } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { EventService, type HandlingBody } from "../events/index.js";
import { HostService } from "../hosts/index.js";
import { PolicyService } from "../policy/index.js";
import { DifficultyService } from "../routing/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const ANN = "agt-annannannannannannan";
const BEN = "agt-benbenbenbenbenbenbe";
const SHA = (c: string): string => c.repeat(40);

test("sources the owner defines after start (a timer, a folder, a git repository, a service health address) and the built-in model-availability source wake the right agent: the owner of the watched task, whose running attempt is woken, and nobody else (card H13f)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-defsrc-"));
  let now = Date.now();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const worker = new ScriptedWorker("host:w1", async () => { await gate; return { status: "completed", text: "done" }; });
  let status = 200;
  const server = createServer((_req, res) => { res.writeHead(status); res.end(); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/health`;
  const say: Record<string, unknown[]> = {};
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [{ ...PI, abort: "none" as const }],
    chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) },
    dispatch: { timer: new ManualTimer(), manual: true, workers: [worker], clock: () => new Date(now).toISOString() },
  });
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const owner = await s.principals.authenticate(boot.token);
    await s.routing.setTable(owner, { commandId: "rt", expectedRevision: 0, table: { ...ROUTING_TABLE, roles: { coordinator: "r-cloud", "safety-supervisor": "r-cloud" } } } as never);
    await DifficultyService.withEpoch(c.storage, c.epoch, s.routing, s.contracts).setProfiles(owner, { commandId: "sp", expectedRevision: 0, profiles: EXEC_PROFILES } as never);
    await s.principals.enroll(owner, { commandId: "e-host", kind: "host", name: "w1", grants: [] });
    const hostP = await s.principals.authenticate((await s.principals.issueCredential(owner, "host:w1")).token);
    const hosts = HostService.withEpoch(c.storage, c.epoch, s.assignments);
    await hosts.announce(hostP, { commandId: "an", capabilities: { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] } });
    await hosts.heartbeat(hostP, { commandId: "hb", sequence: 1 });
    await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap", actor: owner.id, host: "host:w1", capacity: { cpus: 8, memoryMb: 16_384 } });
    await PolicyService.withEpoch(c.storage, c.epoch, s.grants).set(owner, { scope: "installation", commandId: "pol", profile: "autonomous" } as never);
    const project = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
    for (const name of [ANN, BEN]) await s.principals.enroll(owner, { commandId: `e-${name}`, kind: "agent", name, grants: [...workGrants(project)] });
    const task = async (n: number, agent: string, attempt: boolean): Promise<{ taskId: string; attemptId?: string }> => {
      const taskId = (await s.projects.createTask({ commandId: `t${n}`, actor: owner.id, projectId: project, title: `Water bed ${n}` })).id;
      await s.projects.transitionTask({ commandId: `r${n}`, actor: owner.id, taskId, expectedRevision: 1, to: "ready" });
      await s.assignments.assignTask({ commandId: `as${n}`, actor: owner.id, taskId, owner: { kind: "agent", id: agent } });
      if (!attempt) return { taskId };
      const a = (await s.assignments.getAssignment(taskId))!;
      return { taskId, attemptId: (await s.assignments.admitAttempt({ commandId: `ad${n}`, actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: agent }, harness: "pi" })).id };
    };
    const ann = await task(1, ANN, true);
    const ben = await task(2, BEN, false);
    const call = (op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string; message: string } }>;
    const tick = async (n = 3): Promise<void> => { for (let i = 0; i < n; i++) await c.dispatch!.dispatcher.tick(); };
    await tick(1);
    assert.equal((await c.dispatch!.dispatcher.get(owner, ann.attemptId!))!.state, "running");

    // The places watched: a folder, a git repository (its files, as git keeps them) and the health address.
    const folder = join(d, "inbox"); mkdirSync(folder);
    writeFileSync(join(folder, "order.txt"), "3 roses");
    const repo = join(d, "repo"); mkdirSync(join(repo, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(repo, ".git", "refs", "heads", "main"), `${SHA("a")}\n`);

    // Defined after start, each reporting into ann's task; the controller is not restarted.
    const defs = [
      { sourceId: "every-minute", type: "timer", everyMinutes: 1 },
      { sourceId: "orders", type: "file", path: folder, checkSeconds: 10 },
      { sourceId: "garden-repo", type: "repository", path: repo, checkSeconds: 10 },
      { sourceId: "garden-api", type: "service", url, checkSeconds: 10 },
    ];
    for (const def of defs) { const r = await call("events.sources.define", { ...def, projectId: project, taskId: ann.taskId }, `def-${def.sourceId}`); assert.ok(r.ok, JSON.stringify(r)); }
    // Refused: another project's task, a name the host's source has, an unknown project, and a caller who is not the owner.
    const elsewhere = (await s.projects.createProject({ commandId: "p2", actor: owner.id, name: "Orchard" })).id;
    const elsewhereTask = (await s.projects.createTask({ commandId: "t9", actor: owner.id, projectId: elsewhere, title: "Prune" })).id;
    assert.equal((await call("events.sources.define", { sourceId: "x", type: "timer", everyMinutes: 1, projectId: project, taskId: elsewhereTask }, "bad1")).error?.code, "not_found");
    assert.equal((await call("events.sources.define", { sourceId: "tasks", type: "timer", everyMinutes: 1, projectId: project }, "bad2")).error?.code, "invalid_command");
    assert.equal((await call("events.sources.define", { sourceId: "x", type: "timer", everyMinutes: 1, projectId: project.slice(0, -1) + (project.endsWith("a") ? "b" : "a") }, "bad3")).error?.code, "not_found");
    const annToken = (await s.principals.issueCredential(owner, `agent:${ANN}`)).token;
    assert.equal(((await c.api.handle(annToken, { v: 1, op: "events.sources.define", commandId: "bad4", args: { sourceId: "y", type: "timer", everyMinutes: 1, projectId: project } } as never)) as { error?: { code: string } }).error?.code, "forbidden");
    const listed = (await call("events.sources.get", {})).result.item.sources as { id: string; type: string; enabled: boolean; defined: boolean; watches?: string }[];
    assert.deepEqual(listed.map((x) => [x.id, x.type, x.enabled, x.defined]), [["tasks", "task-completion", true, false], ["models", "model-availability", true, false], ["every-minute", "timer", true, true], ["orders", "file", true, true], ["garden-repo", "repository", true, true], ["garden-api", "service-failure", true, true]]);
    assert.match(listed.find((x) => x.id === "garden-api")!.watches!, /service health http:\/\/127\.0\.0\.1:\d+\/health/);

    // The owner's watch on ann's task (chat makes the same call; card H13f part 1).
    assert.ok((await call("watch.create", { stream: `task:${ann.taskId}`, taskId: ann.taskId }, "w1")).ok);
    // Ben's task watches the project's stream for model outages only.
    assert.ok((await call("watch.create", { stream: `project:${project}`, taskId: ben.taskId, kinds: ["model.unavailable"] }, "w2")).ok);
    await tick(); // first look at each source: a baseline, nothing reported (the service answered 200, so it is healthy)
    assert.deepEqual(await EventService.withEpoch(c.storage, c.epoch).trace(owner, `task:${ann.taskId}`), [], "nothing is reported by a baseline");

    // Things happen: a file changes, the branch moves, the service fails, a minute passes; and a route the router uses is recorded down.
    writeFileSync(join(folder, "order.txt"), "12 roses and a hedge");
    writeFileSync(join(repo, ".git", "refs", "heads", "main"), `${SHA("b")}\n`);
    status = 503;
    await c.storage.applyOperation({ operationId: "seed-health", epoch: c.epoch, actor: "test", correlationId: "seed", at: new Date(now).toISOString(), changes: [{ type: "create", ref: { kind: "route-health", id: "rhl-endpoint-gpu1" }, body: { scope: "endpoint", name: "gpu1", state: "down", since: new Date(now).toISOString(), lastClass: "outage", failures: 3, probesOk: 0, needsOwner: false } }], audit: [{ type: "seed", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
    now += 61_000;
    await tick();

    const owner_ = owner;
    const trace = await EventService.withEpoch(c.storage, c.epoch).trace(owner_, `task:${ann.taskId}`);
    assert.deepEqual(trace.map((e) => e.kind).sort(), ["file.changed", "repository.changed", "service.failed", "timer.fired"]);
    const projectTrace = await EventService.withEpoch(c.storage, c.epoch).trace(owner_, `project:${project}`);
    assert.deepEqual(projectTrace.map((e) => [e.kind, e.ref.kind]), [["model.unavailable", "model"]], "the router's health record reaches the project's stream");

    // The right agent: the events of ann's sources are handed to ann for ann's task, and ann's attempt is woken; the model outage goes to ben, whose watch asked for it, and to nobody else.
    const all = (await c.storage.listAggregates("event-handling", { limit: 100 })).map((a) => a.body as unknown as HandlingBody);
    assert.ok(all.every((h) => h.state === "scheduled" && h.inboxMessageId !== undefined), JSON.stringify(all.map((h) => h.state)));
    const handlings = all.filter((h) => h.taskId === ann.taskId);
    const bens = all.filter((h) => h.taskId === ben.taskId);
    assert.equal(handlings.length + bens.length, all.length);
    assert.ok(handlings.length >= 1 && handlings.every((h) => h.owner.id.endsWith(ANN)), JSON.stringify(handlings.map((h) => [h.taskId, h.owner])));
    assert.deepEqual(handlings.flatMap((h) => h.events.map((e) => e.kind)).sort(), ["file.changed", "repository.changed", "service.failed", "timer.fired"]);
    assert.ok(bens.length >= 1 && bens.every((h) => h.owner.id.endsWith(BEN)), JSON.stringify(bens.map((h) => [h.taskId, h.owner])));
    assert.deepEqual(bens.flatMap((h) => h.events.map((e) => e.kind)), ["model.unavailable"]);
    // Woken: the attempt ann holds on the task now (the clock moved a minute, so the dispatcher may have replaced the first one; either way it is ann's active attempt).
    const held = (await s.assignments.getAssignment(ann.taskId))!;
    assert.equal(held.owner?.id, ANN);
    assert.ok(handlings.some((h) => h.woken !== undefined && h.woken.attemptId === held.activeAttemptId), JSON.stringify([held, handlings.map((h) => h.woken)]));

    // Turned off, a defined source is not looked at; removed, it is gone from the list and from the off-list. Status in chat shows the setting.
    assert.ok((await call("events.sources.change", { disable: ["orders"] }, "off1")).ok);
    writeFileSync(join(folder, "late.txt"), "x");
    now += 11_000; await tick();
    assert.equal((await EventService.withEpoch(c.storage, c.epoch).trace(owner_, `task:${ann.taskId}`)).filter((e) => e.kind === "file.changed").length, 1, "a source turned off is not polled");
    say["What are you watching?"] = [{ kind: "status", request: { kind: "event_sources" }, evidence: "What are you watching?", basis: "owner" }];
    const shown = (await c.chat!.submit(boot.token, { messageId: "m1", text: "What are you watching?" })).outcomes[0] as { status: string; lines?: readonly { text: string }[] };
    const text = JSON.stringify(shown);
    assert.match(text, /orders \(file, defined by you\): off; file or folder /, text.slice(0, 600));
    assert.match(text, /models \(model-availability, built in or from the host\): on/);
    assert.ok((await call("events.sources.remove", { sourceId: "orders" }, "rm1")).ok);
    const after = (await call("events.sources.get", {})).result.item;
    assert.deepEqual([after.sources.some((x: { id: string }) => x.id === "orders"), after.disabled], [false, []]);
    assert.equal((await call("events.sources.remove", { sourceId: "tasks" }, "rm2")).error?.code, "not_found", "a built-in source is turned off, not removed");
    // The same ID again replaces the definition; at most 50 are defined.
    assert.equal((await call("events.sources.define", { sourceId: "every-minute", type: "timer", everyMinutes: 5, projectId: project }, "re1")).result.replaced, true);
    for (let i = 0; i < 47; i++) assert.ok((await call("events.sources.define", { sourceId: `t${i}`, type: "timer", everyMinutes: 60, projectId: project }, `many${i}`)).ok);
    const full = await call("events.sources.define", { sourceId: "one-too-many", type: "timer", everyMinutes: 60, projectId: project }, "many-x");
    assert.equal(full.error?.code, "invalid_command");
    assert.match(full.error!.message, /at most 50 sources may be defined/);
  } finally {
    release(); await c.dispatch?.dispatcher.idle(); await c.close();
    server.closeAllConnections(); await new Promise((r) => server.close(r));
    rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("in chat the owner defines a source and watches it by plain words; the path must be in the owner's own message, and the definition is shown first (card H13f)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-defsrc-chat-"));
  const say: Record<string, unknown[]> = {};
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [],
    chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) },
    dispatch: { timer: new ManualTimer(), intervalMs: 1000 },
  });
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const owner = await s.principals.authenticate(boot.token);
    const project = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
    const taskId = (await s.projects.createTask({ commandId: "t1", actor: owner.id, projectId: project, title: "Order seeds" })).id;
    const chat = c.chat!;
    await chat.setFocus(boot.token, { commandId: "f1", projectId: project });
    const turn = async (id: string, text: string, intents: unknown[]) => { say[text] = intents; return (await chat.submit(boot.token, { messageId: id, text })).outcomes; };
    const cmd = (op: string, args: Record<string, unknown>, evidence: string) => ({ kind: "command", op, args, evidence, basis: "owner" });

    // The model gives a path the owner did not write: refused, nothing defined.
    const wrong = await turn("m1", "Keep an eye on the seed orders folder for Order seeds.", [cmd("events.sources.define", { sourceId: "seed-orders", type: "file", path: "/etc", taskTitle: "Order seeds" }, "Keep an eye on the seed orders folder")]);
    assert.equal(wrong[0]!.status, "refused", JSON.stringify(wrong));
    // Nor a path that differs from the owner's only in letter case (it would be another place).
    const cased = `Watch ${d} for Order seeds.`;
    const upper = await turn("m1b", cased, [cmd("events.sources.define", { sourceId: "seed-orders", type: "file", path: d.toUpperCase(), taskTitle: "Order seeds" }, cased)]);
    assert.equal(upper[0]!.status, "refused", JSON.stringify(upper));
    // Nor an address that differs from the owner's only in letter case (another path on the server).
    const site = "Tell whoever does Order seeds when http://127.0.0.1:9/Health fails.";
    const casedUrl = await turn("m1c", site, [cmd("events.sources.define", { sourceId: "seed-api", type: "service", url: "http://127.0.0.1:9/health", taskTitle: "Order seeds" }, site)]);
    assert.equal(casedUrl[0]!.status, "refused", JSON.stringify(casedUrl));
    // The owner's own path: shown first, then applied on the owner's word.
    const text = `Watch ${d} for changes and tell whoever does Order seeds.`;
    const shown = await turn("m2", text, [cmd("events.sources.define", { sourceId: "seed-orders", type: "file", path: d, taskTitle: "Order seeds" }, `Watch ${d} for changes`), cmd("watch.create", { taskTitle: "Order seeds" }, "tell whoever does Order seeds")]);
    assert.equal(shown[0]!.status, "proposed", JSON.stringify(shown));
    assert.equal((await s.principals.authenticate(boot.token)).kind, "owner");
    const before = (await c.api.handle(boot.token, { v: 1, op: "events.sources.get", args: {} } as never)) as unknown as { result: { item: { sources: { id: string }[] } } };
    assert.ok(!before.result.item.sources.some((x) => x.id === "seed-orders"), "not defined until the owner accepts");
    const applied = await turn("m3", "yes, go ahead", [{ kind: "apply_proposal", proposalId: (shown[0] as { proposalId: string }).proposalId, evidence: "go ahead", basis: "owner" }]);
    assert.equal(applied[0]!.status, "applied", JSON.stringify(applied));
    const got = (await c.api.handle(boot.token, { v: 1, op: "events.sources.get", args: {} } as never)) as unknown as { result: { item: { sources: { id: string; definition?: { taskId?: string; path?: string } }[] } } };
    const def = got.result.item.sources.find((x) => x.id === "seed-orders")!;
    assert.deepEqual([def.definition?.taskId, def.definition?.path], [taskId, d], "the task was named by its title and resolved");
    // A watch of the whole project's stream, by words.
    const whole = await turn("m4", "Also tell whoever does Order seeds about anything in this project.", [cmd("watch.create", { taskTitle: "Order seeds", watchProject: true }, "tell whoever does Order seeds about anything in this project")]);
    assert.notEqual(whole[0]!.status, "refused", JSON.stringify(whole));
    // Removing it in chat is shown first too.
    const rm = await turn("m5", "Stop watching seed-orders.", [cmd("events.sources.remove", { sourceId: "seed-orders" }, "Stop watching seed-orders")]);
    assert.equal(rm[0]!.status, "proposed", JSON.stringify(rm));
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
