import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import type { InFlight, RouteGate } from "./fallback.js";
import { CutoverService, DEFAULT_FAILBACK, FallbackService, RoutingService, checkLists, type CallBody, type FailbackPolicy, type HealthBody, type RouteRequest, type Step, type Topology } from "./index.js";

after(stopServer);

let now = Date.parse("2026-10-22T20:00:00.000Z");
const options = { clock: () => new Date(now).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>): Promise<DomainError> => {
  let seen: DomainError | undefined;
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); seen = error; return true; });
  return seen!;
};

const provider = (location: "local" | "cloud") => ({ enabled: true, paid: location === "cloud", location });
const route = { contextTokens: 100_000, capabilities: ["tools"] };
const mixedTable = {
  providers: { strata: provider("local"), radiance: provider("local"), local: provider("local"), openrouter: provider("cloud"), openai: provider("cloud") },
  routes: { "strata/qwen": route, "radiance/qwen": route, "local/qwen": route, "openrouter/qwen": route, "openrouter/big": route, "openai/gpt": route },
  profiles: { coder: ["strata/qwen", "radiance/qwen", "openrouter/qwen"], coord: ["local/qwen", "openrouter/qwen"], safety: ["openai/gpt", "radiance/qwen"], plain: ["strata/qwen", "openrouter/qwen", "openrouter/big", "openai/gpt"] },
  roles: { coder: "coder", coordinator: "coord", "safety-supervisor": "safety", plain: "plain" },
};
const mixedTopology = {
  services: ["strata-svc", "radiance-svc"],
  targets: {
    "strata/qwen": { endpoint: "strata-http", account: "local-acct", service: "strata-svc" },
    "radiance/qwen": { endpoint: "radiance-http", account: "local-acct", service: "radiance-svc" },
    "openrouter/qwen": { endpoint: "or-api", account: "or-acct" },
    "openrouter/big": { endpoint: "or-api-2", account: "or-acct" },
    "openai/gpt": { endpoint: "oa-api", account: "oa-acct" },
  },
  aliases: { "local/qwen": "strata/qwen" },
};
const localTable = {
  providers: { strata: provider("local"), radiance: provider("local") },
  routes: { "strata/qwen": route, "radiance/qwen": route },
  profiles: { main: ["strata/qwen", "radiance/qwen"] },
  roles: { coordinator: "main", "safety-supervisor": "main", coder: "main" },
};
const localTopology = { services: ["strata-svc", "radiance-svc"], targets: { "strata/qwen": { endpoint: "strata-http", account: "a", service: "strata-svc" }, "radiance/qwen": { endpoint: "radiance-http", account: "a", service: "radiance-svc" } }, aliases: {} };
const cloudTable = {
  providers: { openrouter: provider("cloud"), openai: provider("cloud") },
  routes: { "openrouter/qwen": route, "openai/gpt": route },
  profiles: { main: ["openrouter/qwen", "openai/gpt"] },
  roles: { coordinator: "main", "safety-supervisor": "main", coder: "main" },
};
const cloudTopology = { services: ["strata-svc"], targets: { "openrouter/qwen": { endpoint: "or-api", account: "or" }, "openai/gpt": { endpoint: "oa-api", account: "oa" } }, aliases: {} };

const request = (role: string, over: Partial<RouteRequest> = {}): RouteRequest => ({ role, contextTokens: 5000, needs: ["tools"], data: "cloud-allowed", paidAuthorized: true, ...over });
const usage = (cost = 1000) => ({ inputTokens: 100, outputTokens: 50, costMicros: cost });
const manual: FailbackPolicy = { mode: "manual", minProbes: 1, stableSeconds: 0, holdDownSeconds: 0 };
const auto: FailbackPolicy = { mode: "automatic", minProbes: 3, stableSeconds: 60, holdDownSeconds: 600 };

interface World { fb: FallbackService; cut: CutoverService; routing: RoutingService; owner: Principal; host: Principal; agent: Principal; task: string; storage: import("../storage/types.js").ControllerStorage; epoch: number; cancelled: InFlight[][]; restart: () => { fb: FallbackService; cut: CutoverService; routing: RoutingService } }

for (const backend of backends) {
  const build = async (config: { table: object; topology: object }, gate?: (real: RouteGate) => RouteGate, body?: (w: World) => Promise<void>) => {
    now = Date.parse("2026-10-22T20:00:00.000Z");
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      await principals.enroll(owner, { commandId: cid("e"), kind: "host", name: "h1", grants: [] });
      const host = await principals.authenticate((await principals.issueCredential(owner, "host:h1")).token);
      await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "ann", grants: [{ action: "*", project: "*" }] });
      const agent = await principals.authenticate((await principals.issueCredential(owner, "agent:ann")).token);
      const cancelled: InFlight[][] = [];
      const wire = (): { fb: FallbackService; cut: CutoverService; routing: RoutingService } => {
        const routing = RoutingService.withEpoch(world.storage, projects.epoch, options, {});
        const cut = CutoverService.withEpoch(world.storage, projects.epoch, routing, options, {});
        const fb = FallbackService.withEpoch(world.storage, projects.epoch, routing, options, gate === undefined ? cut.gate() : gate(cut.gate()));
        cut.bind(fb, async (list) => { cancelled.push([...list]); });
        return { fb, cut, routing };
      };
      const first = wire();
      await first.routing.setTable(owner, { commandId: cid("t"), expectedRevision: 0, table: config.table });
      await first.cut.setTopology(owner, { commandId: cid("o"), expectedRevision: 0, topology: config.topology });
      const p = (await projects.createProject({ commandId: cid("p"), actor: "owner:rob", name: "A" })).id;
      const task = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: p, title: "t" })).id;
      await body!({ ...first, owner, host, agent, task, storage: world.storage, epoch: projects.epoch, cancelled, restart: wire });
    } finally { await world.close(); }
  };
  const suite = (name: string, run: (w: World) => Promise<void>, config: { table: object; topology: object } = { table: mixedTable, topology: mixedTopology }, gate?: (real: RouteGate) => RouteGate) =>
    test(`${backend.name}: ${name}`, () => build(config, gate, run));
  const step = (s: Step): Extract<Step, { kind: "route" }> => { assert.equal(s.kind, "route", JSON.stringify(s)); return s as Extract<Step, { kind: "route" }>; };
  const begin = (w: { fb: FallbackService; host: Principal; task: string }, role = "plain", over: Partial<RouteRequest> = {}) => w.fb.begin(w.host, { commandId: cid("b"), taskId: w.task, request: request(role, over) });
  const fail = (w: { fb: FallbackService; host: Principal }, s: Step, message: string, status?: number, extra: Record<string, unknown> = {}) =>
    w.fb.failed(w.host, { commandId: cid("f"), callId: s.callId, failure: { message, ...(status === undefined ? {} : { status }) }, ...extra });
  const callOf = async (w: World, s: Step): Promise<CallBody> => (await w.storage.getAggregate({ kind: "model-call", id: s.callId }))!.body as unknown as CallBody;
  const healthOf = async (w: World, id: string): Promise<HealthBody | undefined> => (await w.storage.getAggregate({ kind: "route-health", id }))?.body as unknown as HealthBody | undefined;

  suite("a role without a valid fallback list is rejected at configuration; weak lists need the owner's acknowledgement", async (w) => {
    const { "safety-supervisor": _s, ...withoutSafety } = mixedTable.roles; void _s;
    await refuses("invalid_command", () => w.routing.setTable(w.owner, { commandId: cid("t"), expectedRevision: 1, table: { ...mixedTable, roles: withoutSafety } }));
    const noBackup = await refuses("invalid_command", () => w.routing.setTable(w.owner, { commandId: cid("t"), expectedRevision: 1, table: { ...mixedTable, profiles: { ...mixedTable.profiles, safety: ["openai/gpt"] } } }));
    assert.match(noBackup.message, /safety-supervisor.*no backup/);
    await refuses("invalid_command", () => w.routing.setTable(w.owner, { commandId: cid("t"), expectedRevision: 1, table: { ...mixedTable, profiles: { ...mixedTable.profiles, safety: [] } } }));
    // Both entries on one endpoint and account: losing it loses the list.
    const one = await refuses("invalid_command", () => w.routing.setTable(w.owner, { commandId: cid("t"), expectedRevision: 1, table: { ...mixedTable, profiles: { ...mixedTable.profiles, coord: ["solo/a", "solo/b"] }, providers: { ...mixedTable.providers, solo: provider("cloud") }, routes: { ...mixedTable.routes, "solo/a": route, "solo/b": route } } }));
    assert.match(one.message, /coordinator.*one endpoint/);
    // The same rules, with the owner's acknowledgement, accept the single entry.
    const lenient = RoutingService.withEpoch(w.storage, w.epoch, options, { acknowledgedWeak: ["safety-supervisor"] });
    await lenient.setTable(w.owner, { commandId: cid("t"), expectedRevision: 1, table: { ...mixedTable, profiles: { ...mixedTable.profiles, safety: ["openai/gpt"] } } });
    // A missing coordinator is caught even when the table names no such role at all.
    const bare = { providers: mixedTable.providers, routes: mixedTable.routes, profiles: { x: ["strata/qwen", "openai/gpt"] }, roles: {} };
    assert.deepEqual(checkLists(bare, mixedTopology as unknown as Topology).map((p) => p.role), ["coordinator", "safety-supervisor"]);
  });

  suite("an alias that leads back to a route already in the list, a chain and a cycle are refused; a fallback has no list of its own to follow", async (w) => {
    await refuses("invalid_command", () => w.routing.setTable(w.owner, { commandId: cid("t"), expectedRevision: 1, table: { ...mixedTable, profiles: { ...mixedTable.profiles, plain: ["strata/qwen", "local/qwen", "openai/gpt"] } } }));
    const topo = await w.cut.topology();
    await refuses("invalid_command", () => w.cut.setTopology(w.owner, { commandId: cid("o"), expectedRevision: topo.revision, topology: { ...mixedTopology, aliases: { "local/qwen": "strata/qwen", "strata/qwen": "local/qwen" } } }));
    await refuses("invalid_command", () => w.cut.setTopology(w.owner, { commandId: cid("o"), expectedRevision: topo.revision, topology: { ...mixedTopology, aliases: { "local/qwen": "strata/qwen", "radiance/qwen": "local/qwen" } } }));
    await refuses("invalid_command", () => w.cut.setTopology(w.owner, { commandId: cid("o"), expectedRevision: topo.revision, topology: { ...mixedTopology, aliases: { "local/qwen": "local/qwen" } } }));
    // An alias that would turn the safety supervisor's two entries into one is refused by the topology.
    await refuses("invalid_command", () => w.cut.setTopology(w.owner, { commandId: cid("o"), expectedRevision: topo.revision, topology: { ...mixedTopology, aliases: { "local/qwen": "strata/qwen", "radiance/qwen": "openai/gpt" } } }));
    // A list entry that names another list (a profile) is not a route.
    await refuses("invalid_command", () => w.routing.setTable(w.owner, { commandId: cid("t"), expectedRevision: 1, table: { ...mixedTable, profiles: { ...mixedTable.profiles, plain: ["coder", "openai/gpt"] } } }));
    // The table cannot drop a route the topology describes.
    const { "openai/gpt": _g, ...routes } = mixedTable.routes; void _g;
    await refuses("invalid_command", () => w.routing.setTable(w.owner, { commandId: cid("t"), expectedRevision: 1, table: { ...mixedTable, routes, profiles: { ...mixedTable.profiles, safety: ["strata/qwen", "radiance/qwen"], plain: ["strata/qwen"] } } }));
  });

  suite("exclusions at model, endpoint, account, provider and service level block new dispatch, aliases resolved", async (w) => {
    const cases: [import("./index.js").ControlLevel, string, string[]][] = [
      ["model", "local/qwen", ["strata/qwen", "local/qwen"]], ["endpoint", "or-api", ["openrouter/qwen"]], ["account", "or-acct", ["openrouter/qwen", "openrouter/big"]],
      ["provider", "openai", ["openai/gpt"]], ["service", "strata-svc", ["strata/qwen", "local/qwen"]],
    ];
    for (const [level, name, blocked] of cases) {
      await w.cut.disable(w.owner, { commandId: cid("d"), level, name, reason: `test ${level}` });
      for (const r of Object.keys(mixedTable.routes)) assert.equal((await w.cut.gate().blocked(r)).length > 0, blocked.includes(r), `${level} ${name} ${r}`);
      await w.cut.reenable(w.owner, { commandId: cid("r"), level, name, reason: "done" });
      for (const r of Object.keys(mixedTable.routes)) assert.deepEqual(await w.cut.gate().blocked(r), [], `${level} ${name} lifted ${r}`);
    }
    await refuses("not_found", () => w.cut.disable(w.owner, { commandId: cid("d"), level: "service", name: "nope", reason: "x" }));
    await refuses("not_found", () => w.cut.disable(w.owner, { commandId: cid("d"), level: "endpoint", name: "nope", reason: "x" }));
    await refuses("invalid_command", () => w.cut.disable(w.owner, { commandId: cid("d"), level: "galaxy" as never, name: "x", reason: "x" }));
    await refuses("invalid_command", () => w.cut.disable(w.owner, { commandId: cid("d"), level: "provider", name: "openai", reason: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" }));
    await refuses("invalid_command", () => w.cut.reenable(w.owner, { commandId: cid("r"), level: "provider", name: "openai", reason: "x" }));
    // Only the owner (or routing.write) may change any of it; an agent with only ordinary grants may not, nor probe.
    await refuses("forbidden", () => w.cut.disable(w.agent, { commandId: cid("d"), level: "provider", name: "openai", reason: "x" }));
    await refuses("forbidden", () => w.cut.probe(w.agent, { commandId: cid("p"), scope: "endpoint", route: "openai/gpt", ok: true }));
  });

  suite("an alias to a disabled service is excluded at dispatch, and so is an alias to a provider R01 excludes", async (w) => {
    await w.cut.disable(w.owner, { commandId: cid("d"), level: "service", name: "strata-svc", reason: "switching to Radiance" });
    const coord = step(await begin(w, "coordinator"));
    assert.equal(coord.route, "openrouter/qwen");
    assert.equal(step(await begin(w, "coder")).route, "radiance/qwen");
    await w.cut.reenable(w.owner, { commandId: cid("r"), level: "service", name: "strata-svc", reason: "back" });
    assert.equal(step(await begin(w, "coordinator")).route, "local/qwen");
    await w.routing.exclude(w.owner, { commandId: cid("x"), kind: "provider", name: "strata", reason: "R01 exclusion" });
    assert.equal(step(await begin(w, "coordinator")).route, "openrouter/qwen");
  });

  suite("list position and attempt history survive a restart", async (w) => {
    const s1 = step(await begin(w, "plain"));
    assert.equal(s1.route, "strata/qwen");
    const s2 = step(await fail(w, s1, "overloaded_error", 529));
    assert.equal(s2.route, "openrouter/qwen");
    const again = w.restart();
    const s3 = step(await again.fb.step(w.host, s1.callId));
    assert.deepEqual([s3.route, s3.attempt], ["openrouter/qwen", 2]);
    const call = await callOf(w, s1);
    assert.deepEqual(call.list, { profile: "plain", routes: ["strata/qwen", "openrouter/qwen", "openrouter/big", "openai/gpt"], index: 1 });
    assert.deepEqual(call.attempts.map((a) => [a.route, a.outcome]), [["strata/qwen", "failed"], ["openrouter/qwen", "started"]]);
    const s4 = step(await again.fb.failed(w.host, { commandId: cid("f"), callId: s1.callId, failure: { message: "rate limit", status: 429 } }));
    assert.equal(s4.route, "openrouter/big");
    assert.equal((await callOf(w, s1)).list!.index, 2);
  });

  suite("a drain reports routing applied, requests in flight and safe to stop as separate facts", async (w) => {
    const before = await w.cut.report(w.host, { level: "service", name: "strata-svc" });
    assert.deepEqual([before.routingApplied, before.inFlightRemaining, before.safeToStop], [false, 0, false]);
    const running = step(await begin(w, "coder"));
    assert.equal(running.route, "strata/qwen");
    await w.fb.sent(w.host, { commandId: cid("sent"), callId: running.callId, attempt: 1 });
    await refuses("invalid_command", () => w.cut.drain(w.owner, { commandId: cid("dr"), level: "service", name: "strata-svc", reason: "maintenance" } as never));
    await w.cut.drain(w.owner, { commandId: cid("dr"), level: "service", name: "strata-svc", reason: "maintenance", drainSeconds: 600 });
    const during = await w.cut.report(w.host, { level: "service", name: "strata-svc" });
    assert.deepEqual([during.mode, during.routingApplied, during.inFlightRemaining, during.safeToStop, during.noRouteInUse, during.drainDeadlinePassed], ["drain", true, 1, false, false, false]);
    assert.deepEqual([...during.routesAffected].sort(), ["local/qwen", "strata/qwen"]);
    assert.equal(during.stopDiscardsCache, true);
    // New work goes elsewhere at once; the running request is left alone to finish.
    assert.equal(step(await begin(w, "coder")).route, "radiance/qwen");
    assert.equal(step(await w.fb.step(w.host, running.callId)).route, "strata/qwen");
    await w.fb.succeeded(w.host, { commandId: cid("s"), callId: running.callId, usage: usage(0) });
    const after = await w.cut.report(w.host, { level: "service", name: "strata-svc" });
    assert.deepEqual([after.routingApplied, after.inFlightRemaining, after.safeToStop], [true, 0, true]);
    // A drain is not a plain disable: it can only be upgraded to a cutover, and a repeat is refused.
    await refuses("invalid_command", () => w.cut.disable(w.owner, { commandId: cid("d"), level: "service", name: "strata-svc", reason: "x" }));
    await refuses("invalid_command", () => w.cut.drain(w.owner, { commandId: cid("dr"), level: "service", name: "strata-svc", reason: "again", drainSeconds: 60 }));
  });

  suite("a drain with no local route in use reports safe to stop; a service no route uses can be drained", async (w) => {
    const s = step(await begin(w, "plain", { prefer: "openai/gpt" }));
    assert.equal(s.route, "openai/gpt");
    await w.cut.drain(w.owner, { commandId: cid("dr"), level: "service", name: "radiance-svc", reason: "maintenance", drainSeconds: 60 });
    const r = await w.cut.report(w.owner, { level: "service", name: "radiance-svc" });
    assert.deepEqual([r.routingApplied, r.inFlightRemaining, r.safeToStop, r.noRouteInUse], [true, 0, true, true]);
    assert.deepEqual(r.routesAffected, ["radiance/qwen"]);
  });

  test(`${backend.name}: cloud-only installation drains a local service that nothing uses`, () => build({ table: cloudTable, topology: cloudTopology }, undefined, async (w) => {
    const s = step(await begin(w, "coder"));
    assert.equal(s.route, "openrouter/qwen");
    await w.cut.drain(w.owner, { commandId: cid("dr"), level: "service", name: "strata-svc", reason: "switching off the engine", drainSeconds: 30 });
    const r = await w.cut.report(w.owner, { level: "service", name: "strata-svc" });
    assert.deepEqual([r.routingApplied, r.inFlightRemaining, r.safeToStop, r.routesAffected.length], [true, 0, true, 0]);
    assert.equal(step(await w.fb.step(w.host, s.callId)).route, "openrouter/qwen");
  }));

  suite("a cutover cancels in-flight attempts, rejects late responses and records possible outstanding charges", async (w) => {
    const paid = step(await begin(w, "plain", { prefer: "openrouter/qwen" }));
    const local = step(await begin(w, "plain"));
    assert.deepEqual([paid.route, local.route], ["openrouter/qwen", "strata/qwen"]);
    const cut = await w.cut.cutover(w.owner, { commandId: "cut-1", level: "provider", name: "openrouter", reason: "credits gone" });
    assert.deepEqual(cut.cancelled.map((c) => [c.callId, c.route]), [[paid.callId, "openrouter/qwen"]]);
    assert.equal(w.cancelled.length, 1);
    // The cancelled call moved on (not to the cut-over provider); the other call was untouched.
    const moved = step(await w.fb.step(w.host, paid.callId));
    assert.deepEqual([moved.route, moved.attempt], ["strata/qwen", 2]);
    assert.equal(step(await w.fb.step(w.host, local.callId)).attempt, 1);
    const body = await callOf(w, paid);
    assert.equal(body.attempts[0]!.outcome, "abandoned");
    assert.equal(body.attempts[0]!.failure, undefined);
    assert.deepEqual(body.charges!.map((c) => [c.attempt, c.route, c.status]), [[1, "openrouter/qwen", "possible"]]);
    // A response from the abandoned attempt neither completes the call nor charges it as the current attempt; it must name its attempt.
    await refuses("invalid_command", () => w.fb.succeeded(w.host, { commandId: cid("s"), callId: paid.callId, usage: usage(300) }));
    assert.deepEqual(await w.fb.succeeded(w.host, { commandId: cid("s"), callId: paid.callId, attempt: 1, usage: usage(300) }), { applied: false });
    const late = await callOf(w, paid);
    assert.equal(late.state, "running");
    assert.deepEqual(late.late!.map((l) => [l.attempt, l.kind]), [[1, "succeeded"]]);
    assert.equal(late.charges![0]!.status, "confirmed");
    assert.equal(late.charges![0]!.costMicros, 300);
    assert.equal((await w.fb.spend(w.task)).costMicros, 300);
    // A late failure is also ignored: it does not fail the replacement or start another fallback.
    await w.fb.failed(w.host, { commandId: cid("f"), callId: paid.callId, attempt: 1, failure: { message: "overloaded", status: 529 } });
    assert.equal((await callOf(w, paid)).attempts.length, 2);
    // The replacement's own response is applied.
    assert.deepEqual(await w.fb.succeeded(w.host, { commandId: cid("s"), callId: paid.callId, attempt: 2, usage: usage(0) }), { applied: true });
    assert.equal((await callOf(w, paid)).state, "succeeded");
    // The cutover repeated with its command ID changes nothing; only the owner settles a charge.
    const replay = await w.cut.cutover(w.owner, { commandId: "cut-1", level: "provider", name: "openrouter", reason: "credits gone" });
    assert.deepEqual([replay.replayed, replay.cancelled.length], [true, 0]);
  });

  suite("a possible charge stays visible in the report until the owner settles it", async (w) => {
    const paid = step(await begin(w, "plain", { prefer: "openrouter/qwen" }));
    await w.cut.cutover(w.owner, { commandId: cid("c"), level: "endpoint", name: "or-api", reason: "provider down" });
    assert.equal((await w.cut.report(w.owner, { level: "endpoint", name: "or-api" })).possibleCharges, 1);
    assert.deepEqual([(await w.cut.report(w.owner, { level: "endpoint", name: "or-api" })).safeToStop], [true]);
    await refuses("forbidden", () => w.fb.settleCharge(w.host, { commandId: cid("sc"), callId: paid.callId, attempt: 1, outcome: "none" }));
    await refuses("invalid_command", () => w.fb.settleCharge(w.owner, { commandId: cid("sc"), callId: paid.callId, attempt: 1, outcome: "confirmed" }));
    await w.fb.settleCharge(w.owner, { commandId: cid("sc"), callId: paid.callId, attempt: 1, outcome: "confirmed", costMicros: 450 });
    assert.equal((await w.cut.report(w.owner, { level: "endpoint", name: "or-api" })).possibleCharges, 0);
    assert.equal((await w.fb.spend(w.task)).costMicros, 450);
    await refuses("invalid_transition", () => w.fb.settleCharge(w.owner, { commandId: cid("sc"), callId: paid.callId, attempt: 1, outcome: "none" }));
    await refuses("not_found", () => w.fb.settleCharge(w.owner, { commandId: cid("sc"), callId: paid.callId, attempt: 2, outcome: "none" }));
  });

  suite("a cutover is a no-op for a local attempt's charge, and an uncertain effect makes the cancelled call wait instead of trying elsewhere", async (w) => {
    const s = step(await begin(w, "coder"));
    await w.fb.abandon(w.owner, { commandId: cid("a"), callId: s.callId, attempt: 1, reason: "test", effects: [] });
    assert.equal((await callOf(w, s)).charges!.length, 0);
    const t = step(await begin(w, "coder"));
    const waiting = await w.fb.abandon(w.owner, { commandId: cid("a"), callId: t.callId, reason: "test", effects: [{ id: "eff-aaaaaaaaaaaaaaaaaaaa", state: "uncertain" }] });
    assert.equal(waiting.kind, "wait");
    await refuses("invalid_transition", () => w.fb.abandon(w.owner, { commandId: cid("a"), callId: t.callId, reason: "again" }));
  });

  suite("an account-wide block is told apart from an endpoint failure", async (w) => {
    const s = step(await begin(w, "plain", { prefer: "openrouter/qwen" }));
    // An outage blocks that endpoint only.
    await fail(w, s, "overloaded_error", 529);
    assert.equal((await healthOf(w, "endpoint-or-api"))?.state, "down");
    assert.equal((await healthOf(w, "account-or-acct")), undefined);
    assert.equal((await w.cut.gate().blocked("openrouter/qwen")).length, 1);
    assert.deepEqual(await w.cut.gate().blocked("openrouter/big"), []);
    // A credit failure blocks the whole account.
    const t = step(await begin(w, "plain", { prefer: "openrouter/big" }));
    await fail(w, t, "Your credit balance is too low", 402);
    assert.equal((await healthOf(w, "account-or-acct"))?.state, "down");
    assert.ok((await w.cut.gate().blocked("openrouter/big"))[0]!.includes("account or-acct"));
    assert.ok((await w.cut.gate().blocked("openrouter/qwen")).some((r) => r.includes("account or-acct")));
    assert.deepEqual(await w.cut.gate().blocked("openai/gpt"), []);
    // Every new call now skips the account without trying it.
    const u = step(await begin(w, "plain", { prefer: "openrouter/big" }));
    assert.equal(u.route, "strata/qwen");
  });

  suite("a rate limit cools one model for a short time and needs no probes", async (w) => {
    const s = step(await begin(w, "plain", { prefer: "openrouter/qwen" }));
    await fail(w, s, "rate limit reached", 429);
    assert.equal((await w.cut.gate().blocked("openrouter/qwen")).length, 1);
    assert.deepEqual(await w.cut.gate().blocked("openrouter/big"), []);
    now += 61_000;
    assert.deepEqual(await w.cut.gate().blocked("openrouter/qwen"), []);
  });

  suite("a tool error or a bad answer does not trigger failover or mark the route down", async (w) => {
    for (const [message, status] of [["tool run_tests returned exit code 1", undefined], ["malformed request body", 400], ["prompt is too long: 210000 tokens", 400]] as [string, number | undefined][]) {
      const s = step(await begin(w, "plain"));
      const out = await fail(w, s, message, status);
      assert.equal(out.kind, "failed", message);
      assert.deepEqual(await w.cut.gate().blocked("strata/qwen"), [], message);
    }
    assert.equal(await healthOf(w, "endpoint-strata-http"), undefined);
    assert.equal(await healthOf(w, "account-local-acct"), undefined);
    assert.equal(step(await begin(w, "plain")).route, "strata/qwen");
  });

  suite("an explicitly disabled route stays disabled despite successful probes", async (w) => {
    await w.cut.disable(w.owner, { commandId: cid("d"), level: "model", name: "strata/qwen", reason: "owner turned it off" });
    const s = step(await begin(w, "plain"));
    assert.equal(s.route, "openrouter/qwen");
    // The endpoint also failed earlier, recovered by probes, and is healthy; the control still holds.
    await w.cut.gate().failure!({ route: "strata/qwen", class: "outage", at: new Date(now).toISOString(), key: "k1" });
    for (let i = 0; i < 5; i++) { now += 60_000; await w.cut.probe(w.host, { commandId: cid("p"), scope: "endpoint", route: "strata/qwen", ok: true }); }
    assert.equal((await healthOf(w, "endpoint-strata-http"))?.state, "healthy");
    assert.ok((await w.cut.gate().blocked("strata/qwen"))[0]!.includes("owner turned it off"));
    assert.equal(step(await begin(w, "plain")).route, "openrouter/qwen");
    // The owner's re-enable names the alias; it lifts the control on the route the alias resolves to.
    await w.cut.reenable(w.owner, { commandId: cid("r"), level: "model", name: "local/qwen", reason: "the owner says so" });
    assert.deepEqual(await w.cut.gate().blocked("strata/qwen"), []);
    assert.equal(step(await begin(w, "plain")).route, "strata/qwen");
    await refuses("forbidden", () => w.cut.reenable(w.agent, { commandId: cid("r"), level: "model", name: "strata/qwen", reason: "x" }));
  });

  suite("automatic failback needs enough good probes over enough time and does not flap", async (w) => {
    await w.cut.setFailbackPolicy(w.owner, { commandId: cid("fp"), policy: auto });
    const down = async () => { const s = step(await begin(w, "plain")); assert.equal(s.route, "strata/qwen"); await fail(w, s, "ECONNREFUSED"); };
    await down();
    assert.equal((await healthOf(w, "endpoint-strata-http"))!.state, "down");
    const probe = (ok: boolean) => w.cut.probe(w.host, { commandId: cid("p"), scope: "endpoint", route: "strata/qwen", ok });
    // Three good probes straight away are not enough time; a bad probe starts the count again.
    await probe(true); await probe(true); await probe(true);
    assert.equal((await healthOf(w, "endpoint-strata-http"))!.state, "down");
    now += 30_000; await probe(false);
    assert.equal((await healthOf(w, "endpoint-strata-http"))!.probesOk, 0);
    await probe(true); now += 30_000; await probe(true); now += 31_000; await probe(true);
    const h = (await healthOf(w, "endpoint-strata-http"))!;
    assert.equal(h.state, "healthy");
    // New work starts at the top of its list again; the call that went elsewhere was not moved.
    assert.equal(step(await begin(w, "plain")).route, "strata/qwen");
    // Failing again soon after the restore: it is down, and only the owner can bring it back.
    now += 60_000;
    await down();
    assert.equal((await healthOf(w, "endpoint-strata-http"))!.needsOwner, true);
    for (let i = 0; i < 6; i++) { now += 61_000; await probe(true); }
    assert.equal((await healthOf(w, "endpoint-strata-http"))!.state, "down");
    assert.equal(step(await begin(w, "plain")).route, "openrouter/qwen");
    await w.cut.restore(w.owner, { commandId: cid("rs"), scope: "endpoint", route: "strata/qwen" });
    assert.equal(step(await begin(w, "plain")).route, "strata/qwen");
    await refuses("invalid_transition", () => w.cut.restore(w.owner, { commandId: cid("rs"), scope: "endpoint", route: "strata/qwen" }));
    // After a long quiet time a new failure is an ordinary one again.
    now += 3600_000;
    await w.cut.gate().failure!({ route: "strata/qwen", class: "outage", at: new Date(now).toISOString(), key: "later" });
    assert.equal((await healthOf(w, "endpoint-strata-http"))!.needsOwner, false, "the owner's restore cleared it, and the next failure came long after");
  });

  suite("manual failback never restores by probes; the policy has bounds", async (w) => {
    await w.cut.setFailbackPolicy(w.owner, { commandId: cid("fp"), policy: manual });
    const s = step(await begin(w, "plain"));
    await fail(w, s, "ECONNREFUSED");
    for (let i = 0; i < 10; i++) { now += 3600_000; await w.cut.probe(w.host, { commandId: cid("p"), scope: "endpoint", route: "strata/qwen", ok: true }); }
    assert.equal((await healthOf(w, "endpoint-strata-http"))!.state, "down");
    assert.equal(step(await begin(w, "plain")).route, "openrouter/qwen");
    await w.cut.restore(w.owner, { commandId: cid("rs"), scope: "endpoint", route: "strata/qwen" });
    assert.equal(step(await begin(w, "plain")).route, "strata/qwen");
    await refuses("invalid_command", () => w.cut.setFailbackPolicy(w.owner, { commandId: cid("fp"), policy: { ...manual, minProbes: 0 } }));
    await refuses("invalid_command", () => w.cut.setFailbackPolicy(w.owner, { commandId: cid("fp"), policy: { ...manual, mode: "sometimes" } }));
    await refuses("invalid_command", () => w.cut.setFailbackPolicy(w.owner, { commandId: cid("fp"), policy: { ...manual, extra: 1 } }));
  });

  suite("a repeated failure report counts once, and a replayed command is the recorded answer", async (w) => {
    const s = step(await begin(w, "plain"));
    const f = { commandId: "same-failure", callId: s.callId, failure: { message: "ECONNREFUSED" } };
    await w.fb.failed(w.host, f);
    await w.fb.failed(w.host, f);
    assert.equal((await healthOf(w, "endpoint-strata-http"))!.failures, 1);
    assert.equal((await callOf(w, s)).attempts.length, 2);
  });

  test(`${backend.name}: a gate that flips after the decision abandons the attempt and picks again`, () => {
    let calls = 0;
    return build({ table: mixedTable, topology: mixedTopology }, (real) => ({
      ...real,
      blocked: async (r) => { const out = await real.blocked(r); if (r === "strata/qwen" && out.length === 0) { calls++; if (calls === 3) return ["flipped"]; } return out; },
    }), async (w) => {
      calls = 0;
      const s = step(await begin(w, "plain"));
      assert.deepEqual([s.route, s.attempt], ["openrouter/qwen", 2]);
      const body = await callOf(w, s);
      // The route chosen first was never sent to: it stays in the list as skipped (numbers are never reused) and costs nothing.
      assert.deepEqual(body.attempts.map((a) => [a.route, a.outcome]), [["strata/qwen", "skipped"], ["openrouter/qwen", "started"]]);
      assert.match(body.attempts[0]!.abandoned!, /before the request was sent/);
    });
  });

  test(`${backend.name}: a paid route blocked after it was chosen records no charge and uses no attempt`, () => {
    let calls = 0;
    return build({ table: mixedTable, topology: mixedTopology }, (real) => ({
      ...real,
      blocked: async (r, id) => { const out = await real.blocked(r, id); if (r === "openrouter/qwen" && out.length === 0) { calls++; if (calls === 3) return ["flipped"]; } return out; },
    }), async (w) => {
      calls = 0;
      const s = step(await begin(w, "plain", { prefer: "openrouter/qwen" }));
      assert.deepEqual([s.route, s.attempt], ["strata/qwen", 2]);
      const body = await callOf(w, s);
      assert.equal((body.charges ?? []).length, 0);
      assert.deepEqual(body.attempts.map((a) => a.outcome), ["skipped", "started"]);
      // All four attempts are still available.
      let cur: Step = s;
      for (let i = 0; i < 3; i++) cur = await fail(w, cur, "ECONNREFUSED " + i, 503, { attempt: (cur as { attempt: number }).attempt });
      assert.notEqual(cur.kind, "failed");
    });
  });

  suite("concurrent outage reports on one endpoint are all answered and all counted", async (w) => {
    const calls: Step[] = [];
    for (let i = 0; i < 6; i++) calls.push(await begin(w, "plain"));
    const res = await Promise.allSettled(calls.map((s) => fail(w, s, "ECONNREFUSED")));
    assert.deepEqual(res.map((r) => r.status), Array(6).fill("fulfilled"), JSON.stringify(res.filter((r) => r.status === "rejected")));
    assert.equal((await healthOf(w, "endpoint-strata-http"))!.failures, 6);
  });

  suite("a failure report replayed after the topology changed is the recorded answer", async (w) => {
    const s = step(await begin(w, "plain"));
    const f = { commandId: "old-failure", callId: s.callId, failure: { message: "ECONNREFUSED" } };
    await w.fb.failed(w.host, f);
    const topo = await w.cut.topology();
    await w.cut.setTopology(w.owner, { commandId: cid("o"), expectedRevision: topo.revision, topology: { ...mixedTopology, targets: { ...mixedTopology.targets, "strata/qwen": { endpoint: "strata-http-2", account: "local-acct", service: "strata-svc" } } } });
    await w.fb.failed(w.host, f);
    assert.equal((await healthOf(w, "endpoint-strata-http"))!.failures, 1);
  });

  suite("a failing gate never turns a recorded failure into an error for the dispatcher", async (w) => {
    const broken = FallbackService.withEpoch(w.storage, w.epoch, w.routing, options, { ...w.cut.gate(), failure: async () => { throw new Error("boom"); } });
    const s = step(await broken.begin(w.host, { commandId: cid("b"), taskId: w.task, request: request("plain") }));
    const next = await broken.failed(w.host, { commandId: cid("f"), callId: s.callId, failure: { message: "ECONNREFUSED" } });
    assert.equal(next.kind, "route");
  });

  suite("a repeated cutover tells the listener again after it failed once, and one stale call does not stop the sweep", async (w) => {
    const a = step(await begin(w, "plain"));
    const b = step(await begin(w, "plain"));
    let heard = 0;
    let boom = 2;
    const heardLists: number[] = [];
    w.cut.bind(w.fb, async (list) => { heard++; heardLists.push(list.length); if (boom-- > 0) throw new Error("runtime unreachable"); });
    await assert.rejects(() => w.cut.cutover(w.owner, { commandId: "cut-listener", level: "service", name: "strata-svc", reason: "move" }), /runtime unreachable/);
    // Both attempts were cancelled in the ledger, and the target is not yet safe to stop: the cancel was not passed on (a report retries it once and it fails again).
    assert.equal((await callOf(w, a)).attempts[0]!.outcome, "abandoned");
    assert.equal((await callOf(w, b)).attempts[0]!.outcome, "abandoned");
    const pending = await w.cut.report(w.owner, { level: "service", name: "strata-svc" });
    assert.deepEqual([pending.routingApplied, pending.inFlightRemaining, pending.cancelPending, pending.safeToStop], [true, 0, true, false]);
    const again = await w.cut.cutover(w.owner, { commandId: "cut-listener", level: "service", name: "strata-svc", reason: "move" });
    assert.equal(again.replayed, true);
    assert.deepEqual(again.cancelled.map((c) => c.callId).sort(), [a.callId, b.callId].sort());
    assert.deepEqual(heardLists, [2, 2, 2]);
    const done = await w.cut.report(w.owner, { level: "service", name: "strata-svc" });
    assert.deepEqual([done.cancelPending, done.safeToStop], [false, true]);
    // Nothing more is passed on once it is acknowledged.
    await w.cut.cutover(w.owner, { commandId: "cut-listener", level: "service", name: "strata-svc", reason: "move" });
    assert.equal(heard, 3);
  });

  suite("a cutover waits for the sweep per call: a call that cannot be cancelled does not stop the others", async (w) => {
    const a = step(await begin(w, "plain"));
    const b = step(await begin(w, "plain"));
    const seen: string[] = [];
    w.cut.bind(w.fb, async (list) => { seen.push(...list.map((x) => x.callId)); });
    // The first call's record is made stale: its abandon is refused (a plain failure other than a transition) once; the sweep goes on to the second.
    const real = w.fb.abandon.bind(w.fb);
    let failedOnce = false;
    (w.fb as unknown as { abandon: typeof w.fb.abandon }).abandon = async (by, cmd) => { if (cmd.callId === a.callId && !failedOnce) { failedOnce = true; throw new DomainError("unavailable", "storage hiccup"); } return real(by, cmd); };
    await assert.rejects(() => w.cut.cutover(w.owner, { commandId: "cut-partial", level: "service", name: "strata-svc", reason: "move" }), /storage hiccup/);
    assert.deepEqual(seen, [b.callId], "the call that was cancelled was passed on although another failed");
    const r = await w.cut.cutover(w.owner, { commandId: "cut-partial", level: "service", name: "strata-svc", reason: "move" });
    assert.deepEqual(r.cancelled.map((c) => c.callId).sort(), [a.callId, b.callId].sort());
    assert.equal((await w.cut.report(w.owner, { level: "service", name: "strata-svc" })).safeToStop, true);
  });

  suite("a late report counts its cost once: not after the owner settled the charge", async (w) => {
    const paid = step(await begin(w, "plain", { prefer: "openrouter/qwen" }));
    await w.fb.sent(w.host, { commandId: cid("sent"), callId: paid.callId, attempt: 1 });
    await w.cut.cutover(w.owner, { commandId: cid("c"), level: "provider", name: "openrouter", reason: "x" });
    await w.fb.settleCharge(w.owner, { commandId: cid("sc"), callId: paid.callId, attempt: 1, outcome: "confirmed", costMicros: 450 });
    await w.fb.succeeded(w.host, { commandId: cid("s"), callId: paid.callId, attempt: 1, usage: usage(300) });
    assert.equal((await w.fb.spend(w.task)).costMicros, 450);
    assert.equal((await callOf(w, paid)).late!.length, 1);
  });

  suite("a cutover reported at an enclosing level is applied; reported for a different target it is not", async (w) => {
    await w.cut.cutover(w.owner, { commandId: cid("c"), level: "provider", name: "strata", reason: "engine switch" });
    const svc = await w.cut.report(w.owner, { level: "service", name: "strata-svc" });
    assert.deepEqual([svc.routingApplied, svc.mode, svc.safeToStop], [true, "cutover", true]);
    assert.equal((await w.cut.report(w.owner, { level: "service", name: "radiance-svc" })).routingApplied, false);
    assert.equal((await w.cut.report(w.owner, { level: "provider", name: "radiance" })).routingApplied, false);
  });

  suite("a drain past its deadline becomes a cutover when the next call or tick sees it", async (w) => {
    const running = step(await begin(w, "coder"));
    await w.fb.sent(w.host, { commandId: cid("sent"), callId: running.callId, attempt: 1 });
    await w.cut.drain(w.owner, { commandId: cid("dr"), level: "service", name: "strata-svc", reason: "maintenance", drainSeconds: 600 });
    now += 599_000;
    assert.equal(step(await w.fb.step(w.host, running.callId)).route, "strata/qwen", "inside the bound the running request is left alone");
    now += 2_000;
    // The next step call (or report, or tick) applies the deadline.
    const moved = step(await w.fb.step(w.host, running.callId));
    assert.equal(moved.route, "radiance/qwen");
    const entry = (await w.cut.controls()).entries[0]!;
    assert.deepEqual([entry.mode, entry.expired, entry.cancelPending, entry.by], ["cutover", true, false, "controller"]);
    assert.match(entry.reason, /drain deadline reached/);
    assert.equal((await callOf(w, running)).attempts[0]!.abandoned, "cutover of service strata-svc");
    assert.equal(w.cancelled.length, 1);
  });

  suite("a scheduler tick applies an expired drain and a gate call blocks as soon as it expires", async (w) => {
    await w.cut.drain(w.owner, { commandId: cid("dr"), level: "provider", name: "openai", reason: "maintenance", drainSeconds: 10 });
    now += 11_000;
    await w.cut.tick(w.host);
    assert.equal((await w.cut.controls()).entries[0]!.mode, "cutover");
    await w.cut.drain(w.owner, { commandId: cid("dr"), level: "service", name: "radiance-svc", reason: "later", drainSeconds: 5 }).catch(() => undefined);
    now += 6_000;
    assert.ok((await w.cut.gate().blocked("radiance/qwen"))[0]!.includes("cut over"));
    assert.equal((await w.cut.report(w.owner, { level: "service", name: "radiance-svc" })).drainDeadlinePassed, true);
  });

  suite("after a restart a route disabled since is not handed back for an attempt not yet sent; a sent attempt is left alone", async (w) => {
    const unsent = step(await begin(w, "plain"));
    const sent = step(await begin(w, "plain"));
    await w.fb.sent(w.host, { commandId: cid("sent"), callId: sent.callId, attempt: 1 });
    await w.cut.disable(w.owner, { commandId: cid("d"), level: "model", name: "strata/qwen", reason: "owner turned it off" });
    const again = w.restart();
    assert.equal(step(await again.fb.step(w.host, unsent.callId)).route, "openrouter/qwen");
    assert.equal(step(await again.fb.step(w.host, sent.callId)).route, "strata/qwen");
  });

  suite("half-open: a down endpoint gets one trial after the outage cooldown when nothing probes; success returns it, failure waits again", async (w) => {
    const s = step(await begin(w, "plain"));
    await fail(w, s, "ECONNREFUSED");
    assert.equal(step(await begin(w, "plain")).route, "openrouter/qwen");
    now += 299_000;
    assert.equal(step(await begin(w, "plain")).route, "openrouter/qwen", "not before the cooldown");
    now += 2_000;
    const trial = step(await begin(w, "plain"));
    assert.equal(trial.route, "strata/qwen");
    assert.equal(step(await begin(w, "plain")).route, "openrouter/qwen", "only one trial at a time");
    await w.fb.succeeded(w.host, { commandId: cid("s"), callId: trial.callId, attempt: 1, usage: usage(0) });
    assert.equal((await healthOf(w, "endpoint-strata-http"))!.state, "healthy");
    assert.equal(step(await begin(w, "plain")).route, "strata/qwen");
    // A trial that fails sends the target back down for another cooldown.
    now += 1_000_000; // long after the restore: an ordinary failure, not flapping
    const t2 = step(await begin(w, "plain"));
    await fail(w, t2, "ECONNREFUSED");
    now += 301_000;
    const t3 = step(await begin(w, "plain"));
    assert.equal(t3.route, "strata/qwen");
    const out = await fail(w, t3, "ECONNREFUSED");
    assert.equal(out.kind, "route");
    assert.equal(step(await begin(w, "plain")).route, "openrouter/qwen");
    now += 100_000;
    assert.equal(step(await begin(w, "plain")).route, "openrouter/qwen");
  });

  suite("half-open is off in manual mode and for a target that needs the owner", async (w) => {
    await w.cut.setFailbackPolicy(w.owner, { commandId: cid("fp"), policy: manual });
    const s = step(await begin(w, "plain"));
    await fail(w, s, "ECONNREFUSED");
    now += 3600_000;
    assert.equal(step(await begin(w, "plain")).route, "openrouter/qwen");
  });

  suite("the default failback policy is automatic: 3 probes, 120 s stable, 900 s hold-down", async (w) => {
    assert.deepEqual((await w.cut.controls()).failback, { mode: "automatic", minProbes: 3, stableSeconds: 120, holdDownSeconds: 900 });
    assert.deepEqual(DEFAULT_FAILBACK, { mode: "automatic", minProbes: 3, stableSeconds: 120, holdDownSeconds: 900 });
  });

  suite("a list needs two distinct endpoints, and two distinct accounts unless every entry is a local engine", async (w) => {
    const sameAccount = { ...mixedTopology, targets: { ...mixedTopology.targets, "openai/gpt": { endpoint: "oa-api", account: "or-acct" } } };
    const t = { ...mixedTable, profiles: { ...mixedTable.profiles, safety: ["openai/gpt", "openrouter/qwen"] } };
    const lenient = checkLists({ ...t, exclusions: [] } as never, sameAccount as unknown as Topology, {});
    assert.ok(lenient.some((p) => p.role === "safety-supervisor" && /one account/.test(p.problem)), JSON.stringify(lenient));
    // Local engines sharing a nominal account are fine.
    assert.deepEqual(checkLists({ ...localTable, exclusions: [] } as never, localTopology as unknown as Topology, {}), []);
  });

  suite("two skips in a row do not wedge the call; a late response for a skipped attempt is never applied to its replacement; restart in between", async (w) => {
    const s1 = step(await begin(w, "plain"));
    assert.deepEqual([s1.route, s1.attempt], ["strata/qwen", 1]);
    await w.cut.disable(w.owner, { commandId: cid("d"), level: "service", name: "strata-svc", reason: "moving to Radiance" });
    const s2 = step(await w.fb.step(w.host, s1.callId));
    assert.deepEqual([s2.route, s2.attempt], ["openrouter/qwen", 2]);
    const again = w.restart();
    await w.cut.disable(w.owner, { commandId: cid("d"), level: "provider", name: "openrouter", reason: "credits" });
    const s3 = step(await again.fb.step(w.host, s1.callId));
    assert.deepEqual([s3.route, s3.attempt], ["openai/gpt", 3]);
    // Later steps keep working, and the two skipped routes did not use the attempts allowed.
    assert.equal(step(await again.fb.step(w.host, s1.callId)).attempt, 3);
    const body = await callOf(w, s1);
    assert.deepEqual(body.attempts.map((a) => a.outcome), ["skipped", "skipped", "started"]);
    // A response that names a skipped attempt is recorded as late and applied to nothing.
    assert.deepEqual(await again.fb.succeeded(w.host, { commandId: cid("s"), callId: s1.callId, attempt: 1, usage: usage(0) }), { applied: false });
    assert.deepEqual(await again.fb.succeeded(w.host, { commandId: cid("s"), callId: s1.callId, attempt: 2, usage: usage(0) }), { applied: false });
    const after = await callOf(w, s1);
    assert.equal(after.state, "running");
    assert.deepEqual(after.late!.map((l) => [l.attempt, l.route]), [[1, "strata/qwen"], [2, "openrouter/qwen"]]);
    await refuses("invalid_command", () => again.fb.succeeded(w.host, { commandId: cid("s"), callId: s1.callId, usage: usage(0) }));
    assert.deepEqual(await again.fb.succeeded(w.host, { commandId: cid("s"), callId: s1.callId, attempt: 3, usage: usage(0) }), { applied: true });
    // Three failures after two skips still leave room for the fourth counted attempt.
  });

  suite("a half-open trial is claimed only for the route the call actually chooses", async (w) => {
    const s = step(await begin(w, "plain"));
    await fail(w, s, "ECONNREFUSED");
    now += 301_000;
    // This call has already tried strata/qwen: it must not take the trial for a route it then skips.
    const done = step(await begin(w, "plain", { prefer: "openai/gpt" }));
    assert.equal(done.route, "openai/gpt");
    assert.equal((await healthOf(w, "endpoint-strata-http"))!.trialCall, undefined, "a call that chose another route took no trial");
    const next = step(await begin(w, "plain"));
    assert.equal(next.route, "strata/qwen");
    assert.equal((await healthOf(w, "endpoint-strata-http"))!.trialCall, next.callId);
  });

  for (const [label, config, expectFirst, expectAfter] of [
    ["local-only", { table: localTable, topology: localTopology }, "strata/qwen", "radiance/qwen"],
    ["cloud-only", { table: cloudTable, topology: cloudTopology }, "openrouter/qwen", "openai/gpt"],
    ["mixed", { table: mixedTable, topology: mixedTopology }, "strata/qwen", "radiance/qwen"],
  ] as [string, { table: object; topology: object }, string, string][]) {
    test(`${backend.name}: ${label} configuration keeps its controls, health and list position across a restart`, () => build(config, undefined, async (w) => {
      const first = step(await begin(w, "coder"));
      assert.equal(first.route, expectFirst);
      const target = label === "cloud-only" ? { level: "provider" as const, name: "openrouter" } : { level: "service" as const, name: "strata-svc" };
      await w.cut.cutover(w.owner, { commandId: cid("c"), ...target, reason: "move now" });
      const second = step(await w.fb.step(w.host, first.callId));
      assert.equal(second.route, expectAfter);
      const again = w.restart();
      assert.equal((await again.cut.report(w.owner, target)).routingApplied, true);
      assert.equal(step(await again.fb.step(w.host, first.callId)).route, expectAfter);
      assert.equal((await callOf(w, first)).list!.index, 1);
      assert.equal(step(await again.fb.begin(w.host, { commandId: cid("b"), taskId: w.task, request: request("coder") })).route, expectAfter);
      await again.cut.reenable(w.owner, { commandId: cid("r"), ...target, reason: "back" });
      assert.equal(step(await again.fb.begin(w.host, { commandId: cid("b"), taskId: w.task, request: request("coder") })).route, expectFirst);
      assert.equal((await again.cut.controls()).entries.length, 0);
    }));
  }

  suite("a cutover cannot run without the fallback service, and unknown fields and credentials are refused", async (w) => {
    const alone = CutoverService.withEpoch(w.storage, w.epoch, w.routing, options);
    await refuses("unavailable", () => alone.cutover(w.owner, { commandId: cid("c"), level: "provider", name: "openai", reason: "x" }));
    assert.equal((await w.cut.controls()).entries.length, 0, "nothing was committed");
    await refuses("invalid_command", () => w.cut.disable(w.owner, { commandId: cid("d"), level: "provider", name: "openai", reason: "x", extra: 1 } as never));
    await refuses("invalid_command", () => w.cut.probe(w.host, { commandId: cid("p"), scope: "endpoint", route: "openai/gpt", ok: "yes" as never }));
    await refuses("invalid_command", () => w.cut.probe(w.host, { commandId: cid("p"), scope: "galaxy" as never, route: "openai/gpt", ok: true }));
  });
}
