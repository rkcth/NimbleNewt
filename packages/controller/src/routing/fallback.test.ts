import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { FallbackService, RoutingService, classifyProviderFailure, type RouteRequest, type Step } from "./index.js";

after(stopServer);

let now = Date.parse("2026-10-22T20:00:00.000Z");
const options = { clock: () => new Date(now).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); return true; });
};
const table = {
  providers: { alpha: { enabled: true, paid: true, location: "cloud" }, beta: { enabled: true, paid: true, location: "cloud" }, gamma: { enabled: true, paid: false, location: "local" } },
  routes: { "alpha/one": { contextTokens: 100_000, capabilities: ["tools"] }, "beta/two": { contextTokens: 100_000, capabilities: ["tools"] }, "gamma/three": { contextTokens: 100_000, capabilities: ["tools"] } },
  profiles: { main: ["alpha/one", "beta/two", "gamma/three"] },
  roles: { coder: "main" },
};
const request: RouteRequest = { role: "coder", contextTokens: 5000, needs: ["tools"], data: "cloud-allowed", paidAuthorized: true };
const EFF = "eff-aaaaaaaaaaaaaaaaaaaa";
const usage = (cost = 1000) => ({ inputTokens: 100, outputTokens: 50, costMicros: cost });

test("failures are sorted into the kinds that decide what happens next", () => {
  const cases: [string, number | undefined, string][] = [
    ["Your credit balance is too low", 400, "credit"], ["payment required", 402, "credit"], ["insufficient_quota", undefined, "credit"], ["Rate limit reached for requests", 429, "rate-limit"], ["too many requests", undefined, "rate-limit"],
    ["overloaded_error", 529, "outage"], ["upstream connect error", 503, "outage"], ["ECONNRESET", undefined, "outage"], ["request timed out", undefined, "outage"], ["Invalid API key", 401, "auth"],
    ["prompt is too long: 210000 tokens", 400, "context-overflow"], ["Compaction failed: timeout", undefined, "context-overflow"], ["malformed request body", 400, "invalid-request"], ["something odd", undefined, "unknown"],
    ["Rate limit: too many tokens per minute", 429, "rate-limit"],
    ["429 RESOURCE_EXHAUSTED: Quota exceeded for requests per minute", 429, "rate-limit"], ["You exceeded your current quota, please check your plan and billing details", 429, "credit"],
    ["authentication timed out", undefined, "outage"], ["The request was refused for your region", 403, "unknown"], ["Incorrect API key provided", 401, "auth"], ["quota exceeded", undefined, "credit"],
  ];
  for (const [message, status, want] of cases) assert.equal(classifyProviderFailure({ message, ...(status === undefined ? {} : { status }) }), want, message);
});

for (const backend of backends) {
  const suite = (name: string, body: (c: { fb: FallbackService; routing: RoutingService; owner: Principal; host: Principal; agent: Principal; task: string }) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
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
        const routing = RoutingService.withEpoch(world.storage, projects.epoch, options);
        await routing.setTable(owner, { commandId: cid("t"), expectedRevision: 0, table });
        const fb = FallbackService.withEpoch(world.storage, projects.epoch, routing, options);
        const p = (await projects.createProject({ commandId: cid("p"), actor: "owner:rob", name: "A" })).id;
        const task = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: p, title: "t" })).id;
        await body({ fb, routing, owner, host, agent, task });
      } finally { await world.close(); }
    });
  const route = (s: Step): string => { assert.equal(s.kind, "route", JSON.stringify(s)); return (s as Extract<Step, { kind: "route" }>).route; };
  const fail = (c: { fb: FallbackService; host: Principal }, s: Step, message: string, status?: number, extra: Record<string, unknown> = {}) => c.fb.failed(c.host, { commandId: cid("f"), callId: s.callId, failure: { message, ...(status === undefined ? {} : { status }) }, ...extra });

  suite("credit, rate-limit and outage failures move to the next eligible route; spend is added across attempts", async (c) => {
    const s1 = await c.fb.begin(c.host, { commandId: cid("b"), taskId: c.task, request });
    assert.equal(route(s1), "alpha/one");
    const s2 = await fail(c, s1, "Your credit balance is too low", 402, { usage: usage(500) });
    assert.equal(route(s2), "beta/two");
    const s3 = await fail(c, s2, "overloaded_error", 529, { usage: usage(200) });
    assert.deepEqual([route(s3), (s3 as { attempt: number }).attempt], ["gamma/three", 3]);
    await c.fb.succeeded(c.host, { commandId: cid("s"), callId: s1.callId, usage: usage(0) });
    assert.deepEqual(await c.fb.spend(c.task), { costMicros: 700, tokens: 450, calls: 3 });
    await refuses("invalid_transition", () => c.fb.succeeded(c.host, { commandId: cid("s"), callId: s1.callId, usage: usage(0) }));
  });

  suite("exhausted routes become a visible wait, and resume tries again when cooldowns or the table have changed", async (c) => {
    await c.routing.exclude(c.owner, { commandId: cid("x"), kind: "provider", name: "gamma", reason: "offline" });
    const s1 = await c.fb.begin(c.host, { commandId: cid("b"), taskId: c.task, request });
    const s2 = await fail(c, s1, "rate limit reached", 429);
    assert.equal(route(s2), "beta/two");
    const s3 = await fail(c, s2, "rate limit reached", 429);
    assert.equal(s3.kind, "wait");
    const wait = s3 as Extract<Step, { kind: "wait" }>;
    assert.equal(wait.reason, "no eligible route is left");
    assert.equal(wait.until, new Date(now + 60_000).toISOString());
    assert.ok(wait.why.some((w) => /gamma\/three: provider gamma is excluded/.test(w)) && wait.why.some((w) => /already tried|cooling/.test(w)));
    // Too early: still waiting. After the cooldown the first route is tried again. A lifted exclusion offers another.
    assert.equal((await c.fb.resume(c.host, { commandId: cid("r"), callId: s1.callId })).kind, "wait");
    now += 61_000;
    assert.equal(route(await c.fb.resume(c.host, { commandId: cid("r"), callId: s1.callId })), "alpha/one");
    await refuses("invalid_transition", () => c.fb.resume(c.host, { commandId: cid("r"), callId: s1.callId }));
  });

  suite("a credit or authentication failure skips the rest of that provider for this call", async (c) => {
    const table2 = { ...table, routes: { ...table.routes, "alpha/two": { contextTokens: 100_000, capabilities: ["tools"] } }, profiles: { main: ["alpha/one", "alpha/two", "beta/two"] } };
    await c.routing.setTable(c.owner, { commandId: cid("t"), expectedRevision: (await c.routing.get())!.revision, table: table2 });
    const s1 = await c.fb.begin(c.host, { commandId: cid("b"), taskId: c.task, request });
    assert.equal(route(await fail(c, s1, "invalid api key", 401)), "beta/two");
  });

  suite("failures that would fail the same way are not sent to another route; four attempts is the most", async (c) => {
    for (const [message, status] of [["prompt is too long: 210000 tokens", 400], ["malformed request body", 400], ["something odd", undefined]] as const) {
      const s = await c.fb.begin(c.host, { commandId: cid("b"), taskId: c.task, request });
      const out = await fail(c, s, message, status);
      assert.equal(out.kind, "failed", message);
    }
    const four = { ...table, routes: { ...table.routes, "gamma/four": { contextTokens: 100_000, capabilities: ["tools"] }, "gamma/five": { contextTokens: 100_000, capabilities: ["tools"] } }, profiles: { main: ["gamma/three", "gamma/four", "gamma/five", "alpha/one", "beta/two"] } };
    await c.routing.setTable(c.owner, { commandId: cid("t"), expectedRevision: (await c.routing.get())!.revision, table: four });
    let s = await c.fb.begin(c.host, { commandId: cid("b"), taskId: c.task, request });
    for (let i = 0; i < 3; i++) s = await fail(c, s, "service unavailable", 503);
    assert.equal(s.kind, "route");
    s = await fail(c, s, "service unavailable", 503);
    assert.deepEqual([s.kind, (s as { reason: string }).reason], ["failed", "4 attempts have failed"]);
  });

  suite("a fallback never repeats an external effect: an uncertain one holds the call until it is reconciled, and the next route is told what not to redo", async (c) => {
    const s1 = await c.fb.begin(c.host, { commandId: cid("b"), taskId: c.task, request });
    const held = await fail(c, s1, "overloaded_error", 529, { effects: [{ id: EFF, state: "uncertain" }] });
    assert.equal(held.kind, "wait");
    assert.match((held as { reason: string }).reason, /uncertain; it must be reconciled/);
    assert.equal((await c.fb.resume(c.host, { commandId: cid("r"), callId: s1.callId })).kind, "wait");
    const again = await c.fb.resume(c.host, { commandId: cid("r"), callId: s1.callId, effects: [{ id: EFF, state: "confirmed" }] });
    assert.equal(route(again), "beta/two");
    assert.deepEqual((again as unknown as { doNotRepeat: string[] }).doNotRepeat, [EFF]);
    // Confirmed effects ride along on a plain fallback too.
    const s2 = await c.fb.begin(c.host, { commandId: cid("b"), taskId: c.task, request });
    const next = await fail(c, s2, "overloaded_error", 529, { effects: [{ id: "eff-bbbbbbbbbbbbbbbbbbbb", state: "confirmed" }] });
    assert.deepEqual((next as unknown as { doNotRepeat: string[] }).doNotRepeat, ["eff-bbbbbbbbbbbbbbbbbbbb"]);
  });

  suite("a task over its budget does not begin a call; the owner raises it", async (c) => {
    await refuses("forbidden", () => c.fb.setBudget(c.agent, { commandId: cid("g"), taskId: c.task, maxCostMicros: 1 }));
    await c.fb.setBudget(c.owner, { commandId: cid("g"), taskId: c.task, maxCostMicros: 1000 });
    const s1 = await c.fb.begin(c.host, { commandId: cid("b"), taskId: c.task, request });
    await c.fb.succeeded(c.host, { commandId: cid("s"), callId: s1.callId, usage: usage(1000) });
    const blocked = await c.fb.begin(c.host, { commandId: cid("b"), taskId: c.task, request });
    assert.equal(blocked.kind, "wait");
    assert.match((blocked as { reason: string }).reason, /budget is used up/);
    const cur = await c.fb.spend(c.task);
    assert.equal(cur.costMicros, 1000);
    await c.fb.setBudget(c.owner, { commandId: cid("g"), taskId: c.task, maxCostMicros: 5000, maxTokens: 10_000_000 });
    assert.equal(route(await c.fb.resume(c.host, { commandId: cid("r"), callId: blocked.callId })), "alpha/one");
  });

  suite("two calls of one task reporting at the same moment are both counted; the attempt that just failed counts against the budget for the next route", async (c) => {
    const a = await c.fb.begin(c.host, { commandId: cid("b"), taskId: c.task, request });
    const b = await c.fb.begin(c.host, { commandId: cid("b"), taskId: c.task, request });
    await Promise.all([c.fb.succeeded(c.host, { commandId: cid("s"), callId: a.callId, usage: usage(300) }), c.fb.succeeded(c.host, { commandId: cid("s"), callId: b.callId, usage: usage(400) })]);
    assert.deepEqual(await c.fb.spend(c.task), { costMicros: 700, tokens: 300, calls: 2 });
    await c.fb.setBudget(c.owner, { commandId: cid("g"), taskId: c.task, maxCostMicros: 1000 });
    const s = await c.fb.begin(c.host, { commandId: cid("b"), taskId: c.task, request });
    const out = await fail(c, s, "overloaded_error", 529, { usage: usage(400) });
    assert.equal(out.kind, "wait", "700 + 400 is over 1000, so no next route is started");
    assert.match((out as { reason: string }).reason, /budget is used up/);
  });

  suite("a fifth attempt never starts, even after an uncertain effect is reconciled; the owner can clear a credit block after fixing billing", async (c) => {
    const four = { ...table, routes: { ...table.routes, "gamma/four": { contextTokens: 100_000, capabilities: ["tools"] } }, profiles: { main: ["gamma/three", "gamma/four", "alpha/one", "beta/two", "gamma/three"].filter((x, i, l) => l.indexOf(x) === i) } };
    await c.routing.setTable(c.owner, { commandId: cid("t"), expectedRevision: (await c.routing.get())!.revision, table: four });
    let s = await c.fb.begin(c.host, { commandId: cid("b"), taskId: c.task, request });
    for (let i = 0; i < 3; i++) s = await fail(c, s, "service unavailable", 503);
    const held = await fail(c, s, "service unavailable", 503, { effects: [{ id: EFF, state: "uncertain" }] });
    assert.equal(held.kind, "wait");
    const after = await c.fb.resume(c.host, { commandId: cid("r"), callId: s.callId, effects: [{ id: EFF, state: "confirmed" }] });
    assert.deepEqual([after.kind, (after as { reason: string }).reason], ["failed", "4 attempts have failed"]);
    // Credit block: the provider stays blocked for a dispatcher's resume, and is cleared by the owner's.
    const only = { ...table, profiles: { main: ["alpha/one"] } };
    await c.routing.setTable(c.owner, { commandId: cid("t"), expectedRevision: (await c.routing.get())!.revision, table: only });
    const s2 = await c.fb.begin(c.host, { commandId: cid("b"), taskId: c.task, request });
    assert.equal((await fail(c, s2, "Your credit balance is too low", 402)).kind, "wait");
    assert.equal((await c.fb.resume(c.host, { commandId: cid("r"), callId: s2.callId })).kind, "wait");
    assert.equal(route(await c.fb.resume(c.owner, { commandId: cid("r"), callId: s2.callId })), "alpha/one");
  });

  suite("who may dispatch, validation, and repeats of a report", async (c) => {
    await refuses("forbidden", () => c.fb.begin(c.agent, { commandId: cid("b"), taskId: c.task, request }));
    await refuses("not_found", () => c.fb.begin(c.host, { commandId: cid("b"), taskId: "task-aaaaaaaaaaaaaaaaaaaa", request }));
    await assert.rejects(() => c.fb.begin(c.host, { commandId: cid("b"), taskId: c.task, request: { ...request, data: "anywhere" } }), DomainError);
    const id = cid("b");
    const one = await c.fb.begin(c.host, { commandId: id, taskId: c.task, request });
    assert.deepEqual(await c.fb.begin(c.host, { commandId: id, taskId: c.task, request }), one);
    const fid = cid("f");
    const first = await c.fb.failed(c.host, { commandId: fid, callId: one.callId, failure: { message: "overloaded", status: 529 }, usage: usage(10) });
    assert.deepEqual(await c.fb.failed(c.host, { commandId: fid, callId: one.callId, failure: { message: "overloaded", status: 529 }, usage: usage(10) }), first);
    assert.equal((await c.fb.spend(c.task)).calls, 1, "a repeated report is charged once");
    await refuses("forbidden", () => c.fb.step(c.agent, one.callId));
    await refuses("not_found", () => c.fb.failed(c.host, { commandId: cid("f"), callId: "mcl-aaaaaaaaaaaaaaaaaaaa", failure: { message: "x" } }));
    await assert.rejects(() => c.fb.failed(c.host, { commandId: cid("f"), callId: one.callId, failure: { message: "x" }, effects: [{ id: "nope", state: "uncertain" }] }), DomainError);
    // A secret in a failure message is not recorded.
    const two = await c.fb.begin(c.host, { commandId: cid("b"), taskId: c.task, request });
    await c.fb.failed(c.host, { commandId: cid("f"), callId: two.callId, failure: { message: "bad key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH" } });
    const stored = (await c.fb.step(c.host, two.callId)) as { reason: string };
    assert.ok(!JSON.stringify(stored).includes("sk-ant-api03"));
  });
}
