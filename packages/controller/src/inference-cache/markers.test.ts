import assert from "node:assert/strict";
import { after, test } from "node:test";
import { BudgetService } from "../budgets/index.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { CacheAdapter, MARKER_LIMITS, MarkerService, ledgerCache, profileFor, type EndpointConfig, type Transport } from "./index.js";

after(stopServer);

let clock = Date.parse("2026-10-22T21:00:00.000Z");
const options = { clock: () => new Date(clock).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};
const digest = (c: string): string => c.repeat(64).slice(0, 64);
const CLAUDE: EndpointConfig = { kind: "claude", model: "claude-opus-5-5" };
const LLAMA: EndpointConfig = { kind: "llama-cpp", model: "m", options: { slots: 2, slotSave: true } };
const STRATA: EndpointConfig = { kind: "strata", model: "m", options: { pinPrefix: true } };
const OPENAI: EndpointConfig = { kind: "openai", model: "gpt-x" };

for (const backend of backends) {
  interface Ctx { svc: MarkerService; reopen(): MarkerService; owner: Principal; host: Principal; ann: Principal; a: string; b: string; budgets: BudgetService; task: string }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      clock = Date.parse("2026-10-22T21:00:00.000Z");
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        await principals.enroll(owner, { commandId: cid("e"), kind: "host", name: "h1", grants: [] });
        const host = await principals.authenticate((await principals.issueCredential(owner, "host:h1")).token);
        await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "ann", grants: [{ action: "*", project: "*" }] });
        const ann = await principals.authenticate((await principals.issueCredential(owner, "agent:ann")).token);
        const a = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "A" })).id;
        const b = (await projects.createProject({ commandId: cid("pb"), actor: "owner:rob", name: "B" })).id;
        const task = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: a, title: "t" })).id;
        await body({
          svc: MarkerService.withEpoch(world.storage, projects.epoch, options), reopen: () => MarkerService.withEpoch(world.storage, projects.epoch, options),
          budgets: BudgetService.withEpoch(world.storage, projects.epoch, options), owner, host, ann, a, b, task,
        });
      } finally { await world.close(); }
    });
  const reg = (c: Ctx, project: string, extra: Record<string, unknown> = {}) => c.svc.register(c.host, { commandId: cid("m"), projectId: project, route: "local/qwen", endpoint: LLAMA, kind: "prefix", digest: digest("a"), tokens: 1000, ...extra } as never);

  suite("a marker is opaque, resolves while it is unexpired, and a repeated registration is the recorded answer", async (c) => {
    const command = cid("m");
    const spec = { projectId: c.a, route: "local/qwen", endpoint: LLAMA, kind: "prefix" as const, digest: digest("a"), tokens: 1234 };
    const m1 = await c.svc.register(c.host, { commandId: command, ...spec });
    const m2 = await c.svc.register(c.host, { commandId: command, ...spec });
    assert.deepEqual([m1.id === m2.id, m1.replayed, m2.replayed, /^cmk-[a-z2-7]{20}$/.test(m1.id)], [true, false, true, true]);
    await refuses("command_conflict", () => c.svc.register(c.host, { commandId: command, ...spec, tokens: 1235 }));
    const found = await c.svc.resolve(c.host, { projectId: c.a, markerId: m1.id, route: "local/qwen" });
    assert.equal(found.state, "active");
    if (found.state === "active") assert.deepEqual([found.expectedCachedTokens, found.marker.backend, found.marker.kind, found.marker.handle], [1234, "llama-cpp", "prefix", undefined]);
    assert.equal((await c.svc.list(c.owner, c.a)).length, 1);
    assert.equal(JSON.stringify(await c.svc.list(c.owner, c.a)).includes("digest"), true, "the digest is kept (it is not the text)");
    // a restart (a new service on the same storage) sees the same marker
    assert.equal((await c.reopen().resolve(c.owner, { projectId: c.a, markerId: m1.id, route: "local/qwen" })).state, "active");
  });

  suite("markers are made only for what the endpoint's profile advertises", async (c) => {
    await refuses("invalid_command", () => reg(c, c.a, { endpoint: OPENAI, kind: "slot-file" }), (e) => assert.equal(e.field, "kind"));
    await refuses("invalid_command", () => reg(c, c.a, { endpoint: CLAUDE, kind: "pin" }), (e) => assert.match(e.message, /cannot pin/));
    await refuses("invalid_command", () => reg(c, c.a, { endpoint: { model: "m" }, kind: "prefix" }), (e) => assert.match(e.message, /no prefix reuse/));
    await refuses("invalid_command", () => reg(c, c.a, { endpoint: { kind: "vllm", model: "m" }, kind: "slot-file" }));
    await refuses("invalid_command", () => reg(c, c.a, { endpoint: { kind: "vllm", model: "m", options: { prefixCaching: false } }, kind: "prefix" }));
    // the ones it does advertise work, and a slot file gets a generated name that the profile accepts
    const slot = await reg(c, c.a, { endpoint: LLAMA, kind: "slot-file" });
    const pin = await reg(c, c.a, { endpoint: STRATA, kind: "pin" });
    const [sm, pm] = await Promise.all([c.svc.resolve(c.host, { projectId: c.a, markerId: slot.id, route: "local/qwen" }), c.svc.resolve(c.host, { projectId: c.a, markerId: pin.id, route: "local/qwen" })]);
    assert.equal(sm.state === "active" && /^nn-[a-z2-7]{20}\.bin$/.test(sm.marker.handle ?? ""), true);
    assert.equal(sm.state === "active" && profileFor(LLAMA).slotRequest!("save", 0, sm.marker.handle).path, "/slots/0?action=save");
    assert.equal(pm.state === "active" ? pm.marker.handle : "unresolved", undefined, "a pin needs no file");
  });

  suite("the expectation never outlives the backend's own lifetime: Claude's markers last at most an hour, and a marker can only be short-lived or default", async (c) => {
    await refuses("invalid_command", () => reg(c, c.a, { endpoint: CLAUDE, ttlMs: 3_600_001 }), (e) => assert.equal(e.field, "ttlMs"));
    await refuses("invalid_command", () => reg(c, c.a, { ttlMs: MARKER_LIMITS.maxTtlMs + 1 }), (e) => assert.equal(e.field, "ttlMs"));
    await refuses("invalid_command", () => reg(c, c.a, { ttlMs: 0 }));
    const claude = await reg(c, c.a, { endpoint: CLAUDE, ttlMs: 3_600_000 });
    const dflt = await reg(c, c.a, { endpoint: CLAUDE });
    const route = "local/qwen";
    clock += 3_599_000;
    assert.equal((await c.svc.resolve(c.host, { projectId: c.a, markerId: claude.id, route })).state, "active");
    clock += 2_000;
    assert.deepEqual([(await c.svc.resolve(c.host, { projectId: c.a, markerId: claude.id, route })), (await c.svc.resolve(c.host, { projectId: c.a, markerId: dflt.id, route }))], [{ state: "unavailable", reason: "expired" }, { state: "unavailable", reason: "expired" }]);
    assert.deepEqual(await c.svc.list(c.owner, c.a), []);
    // a slot file, which the backend keeps until erased, may be kept for days
    const file = await reg(c, c.a, { endpoint: LLAMA, kind: "slot-file", ttlMs: 6 * 86_400_000 });
    clock += 5 * 86_400_000;
    assert.equal((await c.svc.resolve(c.host, { projectId: c.a, markerId: file.id, route })).state, "active");
  });

  suite("privacy: only the dispatcher uses markers, another project's marker or another route reads like a missing one", async (c) => {
    const m = await reg(c, c.a);
    for (const who of [c.ann]) {
      await refuses("forbidden", () => c.svc.resolve(who, { projectId: c.a, markerId: m.id, route: "local/qwen" }));
      await refuses("forbidden", () => c.svc.list(who, c.a));
      await refuses("forbidden", () => c.svc.register(who, { commandId: cid("m"), projectId: c.a, route: "local/qwen", endpoint: LLAMA, kind: "prefix", digest: digest("a"), tokens: 5 }));
      await refuses("forbidden", () => c.svc.release(who, { commandId: cid("r"), projectId: c.a, markerId: m.id }));
      await refuses("forbidden", () => c.svc.recordOutcome(who, { commandId: cid("o"), projectId: c.a, markerId: m.id, outcome: "miss" }));
    }
    const missing = { state: "unavailable", reason: "missing" };
    assert.deepEqual(await c.svc.resolve(c.host, { projectId: c.b, markerId: m.id, route: "local/qwen" }), missing, "project B cannot see project A's marker");
    assert.deepEqual(await c.svc.resolve(c.host, { projectId: c.a, markerId: m.id, route: "local/other" }), missing, "another route does not share it");
    assert.deepEqual(await c.svc.resolve(c.host, { projectId: c.a, markerId: "cmk-aaaaaaaaaaaaaaaaaaaa", route: "local/qwen" }), missing);
    assert.deepEqual(await c.svc.list(c.owner, c.b), []);
    await refuses("not_found", () => c.svc.release(c.host, { commandId: cid("r"), projectId: c.b, markerId: m.id }));
    await refuses("not_found", () => reg(c, "proj-aaaaaaaaaaaaaaaaaaaa"));
    await refuses("invalid_command", () => c.svc.register(c.host, { commandId: cid("m"), projectId: c.a, route: "local/qwen", endpoint: LLAMA, kind: "prefix", digest: "not a digest", tokens: 5 }));
    await refuses("invalid_command", () => c.svc.register(c.host, { commandId: cid("m"), projectId: c.a, route: "local/qwen", endpoint: LLAMA, kind: "prefix", digest: digest("a"), tokens: 5, text: "the prompt" } as never));
  });

  suite("quota: a project holds a bounded number of tokens and markers, released and expired ones free their place, and nothing is evicted silently", async (c) => {
    const big = MARKER_LIMITS.tokens;
    const kept: string[] = [];
    for (let i = 0; i < MARKER_LIMITS.tokensPerProject / big; i++) kept.push((await reg(c, c.a, { tokens: big })).id);
    await refuses("invalid_command", () => reg(c, c.a, { tokens: 1 }), (e) => assert.match(e.message, /cache: this project's markers would hold more than/));
    assert.equal((await c.svc.list(c.owner, c.a)).length, kept.length, "nothing was evicted to make room");
    assert.equal((await reg(c, c.b, { tokens: big })).replayed, false, "another project has its own quota");
    await c.svc.release(c.host, { commandId: cid("r"), projectId: c.a, markerId: kept[0]! });
    assert.equal((await reg(c, c.a, { tokens: big })).replayed, false, "a released marker freed its tokens");
    clock += 3_700_000;
    assert.equal((await reg(c, c.a, { tokens: big })).replayed, false, "expired markers free theirs");
    assert.equal((await c.svc.list(c.owner, c.a)).length, 1, "the expired ones were swept");
  });

  suite("quota: at most 200 markers per project", async (c) => {
    for (let i = 0; i < MARKER_LIMITS.perProject; i++) await reg(c, c.a, { tokens: 1 });
    await refuses("invalid_command", () => reg(c, c.a, { tokens: 1 }), (e) => assert.match(e.message, /already has 200 markers/));
  });

  suite("concurrent registrations cannot exceed the quota", async (c) => {
    const big = MARKER_LIMITS.tokens;
    const room = MARKER_LIMITS.tokensPerProject / big;
    const results = await Promise.allSettled(Array.from({ length: room + 5 }, () => reg(c, c.a, { tokens: big })));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, room);
    for (const r of results) if (r.status === "rejected") assert.ok(r.reason instanceof DomainError && r.reason.code === "invalid_command", String(r.reason));
    assert.equal((await c.svc.list(c.owner, c.a)).length, room);
  });

  suite("a miss marks the marker lost so later calls stop expecting it; hits are counted; release is final and repeats are the recorded answer", async (c) => {
    const m = await reg(c, c.a);
    const route = "local/qwen";
    const hit = cid("o");
    assert.equal((await c.svc.recordOutcome(c.host, { commandId: hit, projectId: c.a, markerId: m.id, outcome: "hit" })).replayed, false);
    assert.equal((await c.svc.recordOutcome(c.host, { commandId: hit, projectId: c.a, markerId: m.id, outcome: "hit" })).replayed, true);
    await c.svc.recordOutcome(c.host, { commandId: cid("o"), projectId: c.a, markerId: m.id, outcome: "partial" });
    await c.svc.recordOutcome(c.host, { commandId: cid("o"), projectId: c.a, markerId: m.id, outcome: "cold" });
    const active = await c.svc.resolve(c.host, { projectId: c.a, markerId: m.id, route });
    assert.equal(active.state === "active" && active.marker.hits, 2, "the repeated hit counted once");
    await c.svc.recordOutcome(c.host, { commandId: cid("o"), projectId: c.a, markerId: m.id, outcome: "miss", reason: "slot taken by another agent" });
    assert.deepEqual(await c.svc.resolve(c.host, { projectId: c.a, markerId: m.id, route }), { state: "unavailable", reason: "lost" });
    assert.deepEqual(await c.svc.list(c.owner, c.a), []);
    const n2 = await reg(c, c.a);
    await c.svc.release(c.host, { commandId: cid("r"), projectId: c.a, markerId: n2.id });
    assert.deepEqual(await c.svc.resolve(c.host, { projectId: c.a, markerId: n2.id, route }), { state: "unavailable", reason: "released" });
    await c.svc.recordOutcome(c.host, { commandId: cid("o"), projectId: c.a, markerId: n2.id, outcome: "miss" });
    assert.deepEqual(await c.svc.resolve(c.host, { projectId: c.a, markerId: n2.id, route }), { state: "unavailable", reason: "released" }, "a released marker stays released");
    await refuses("invalid_command", () => c.svc.recordOutcome(c.host, { commandId: cid("o"), projectId: c.a, markerId: m.id, outcome: "great" as never }));
    await refuses("invalid_command", () => c.svc.recordOutcome(c.host, { commandId: cid("o"), projectId: c.a, markerId: m.id, outcome: "miss", reason: "x".repeat(MARKER_LIMITS.reason + 1) }));
  });

  suite("a slot-file marker outlives its expiry until released, stays out of the quota, and is listed for erasing", async (c) => {
    const file = await reg(c, c.a, { endpoint: LLAMA, kind: "slot-file", ttlMs: 60_000, tokens: 1000 });
    const lost = await reg(c, c.a, { endpoint: LLAMA, kind: "slot-file", tokens: 1000 });
    const prefix = await reg(c, c.a, { endpoint: LLAMA, kind: "prefix", ttlMs: 60_000, tokens: 1000 });
    await c.svc.recordOutcome(c.host, { commandId: cid("o"), projectId: c.a, markerId: lost.id, outcome: "miss" });
    clock += 120_000;
    // registering again sweeps: the stale prefix marker goes, the stale slot files do not
    await reg(c, c.a, { tokens: 1 });
    assert.deepEqual(await c.svc.resolve(c.host, { projectId: c.a, markerId: prefix.id, route: "local/qwen" }), { state: "unavailable", reason: "missing" });
    assert.deepEqual(await c.svc.resolve(c.host, { projectId: c.a, markerId: file.id, route: "local/qwen" }), { state: "unavailable", reason: "expired" });
    const pending = await c.svc.pendingErase(c.host, c.a);
    const handles = (await c.svc.pendingErase(c.owner, c.a)).map((p) => p.id).sort();
    assert.deepEqual(handles, [file.id, lost.id].sort());
    assert.ok(pending.every((p) => /^nn-[a-z2-7]{20}\.bin$/.test(p.handle)));
    assert.deepEqual((await c.svc.list(c.owner, c.a)).map((m) => m.kind), ["prefix"], "stale slot files are not listed as usable");
    // they do not use the project's token quota
    for (let i = 0; i < MARKER_LIMITS.tokensPerProject / MARKER_LIMITS.tokens - 1; i++) await reg(c, c.a, { tokens: MARKER_LIMITS.tokens });
    // the dispatcher erases the file on the server, then releases the marker, and only then is it gone
    await c.svc.release(c.host, { commandId: cid("r"), projectId: c.a, markerId: file.id });
    await reg(c, c.a, { tokens: 1 });
    assert.deepEqual((await c.svc.pendingErase(c.host, c.a)).map((p) => p.id), [lost.id]);
    await refuses("forbidden", () => c.svc.pendingErase(c.ann, c.a));
    assert.deepEqual(await c.svc.pendingErase(c.host, c.b), []);
  });

  suite("default expectations follow the backend's real lifetime, an endpoint that names its route must match, and a credential-shaped reason is refused", async (c) => {
    const claude = await reg(c, c.a, { endpoint: CLAUDE });
    const openai = await reg(c, c.a, { endpoint: OPENAI });
    const llama = await reg(c, c.a);
    const expires = async (id: string) => { const m = (await c.svc.list(c.owner, c.a)).find((x) => x.id === id)!; return Date.parse(m.expiresAt) - Date.parse(m.createdAt); };
    assert.deepEqual([await expires(claude.id), await expires(openai.id), await expires(llama.id)], [300_000, 300_000, 3_600_000]);
    await refuses("invalid_command", () => reg(c, c.a, { endpoint: { ...LLAMA, route: "local/other" } }), (e) => assert.equal(e.field, "route"));
    assert.equal((await reg(c, c.a, { endpoint: { ...LLAMA, route: "local/qwen" } })).replayed, false);
    await refuses("invalid_command", () => c.svc.recordOutcome(c.host, { commandId: cid("o"), projectId: c.a, markerId: llama.id, outcome: "miss", reason: "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" }), (e) => assert.equal(e.field, "reason"));
    assert.equal((await c.svc.resolve(c.host, { projectId: c.a, markerId: llama.id, route: "local/qwen" })).state, "active", "the refused outcome changed nothing");
  });

  suite("a route has one pin, held by one project, durably: another project is refused, also after a restart, and releasing, losing or expiring the pin frees it", async (c) => {
    const pin = (project: string, route = "local/qwen", extra: Record<string, unknown> = {}) => reg(c, project, { endpoint: STRATA, kind: "pin", route, ...extra });
    const a1 = await pin(c.a);
    await refuses("invalid_command", () => pin(c.b), (e) => { assert.equal(e.field, "kind"); assert.match(e.message, /another project holds it/); });
    assert.equal((await pin(c.b, "local/other")).replayed, false, "another route has its own pin");
    const a2 = await pin(c.a); // the holder replaces its own
    // a restart: a new service on the same storage still knows the holder
    await refuses("invalid_command", () => c.reopen().register(c.host, { commandId: cid("m"), projectId: c.b, route: "local/qwen", endpoint: STRATA, kind: "pin", digest: digest("a"), tokens: 10 }));
    // releasing the replaced marker does not free the pin the project still holds with the new one
    await c.svc.release(c.host, { commandId: cid("r"), projectId: c.a, markerId: a1.id });
    await refuses("invalid_command", () => pin(c.b));
    await c.svc.release(c.host, { commandId: cid("r"), projectId: c.a, markerId: a2.id });
    const b1 = await pin(c.b);
    // a lost pin (a miss) frees it as well
    await refuses("invalid_command", () => pin(c.a));
    await c.svc.recordOutcome(c.host, { commandId: cid("o"), projectId: c.b, markerId: b1.id, outcome: "miss" });
    const a3 = await pin(c.a, "local/qwen", { ttlMs: 60_000 });
    // an expired pin frees it
    await refuses("invalid_command", () => pin(c.b));
    clock += 120_000;
    assert.equal((await pin(c.b)).replayed, false);
    void a3;
  });

  suite("concurrent pin registrations for one route: exactly one project wins", async (c) => {
    const results = await Promise.allSettled([c.a, c.b].map((p) => reg(c, p, { endpoint: STRATA, kind: "pin" })));
    assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  });

  suite("the record cap counts stale slot files too: after 400 markers the 401st is refused until some are released", async (c) => {
    const slotFile = () => reg(c, c.a, { endpoint: LLAMA, kind: "slot-file", ttlMs: 1000, tokens: 1 });
    const made: string[] = [];
    for (let i = 0; i < MARKER_LIMITS.perProject; i++) made.push((await slotFile()).id);
    clock += 5000; // the first 200 are stale now, and kept
    for (let i = 0; i < MARKER_LIMITS.records - MARKER_LIMITS.perProject; i++) await slotFile();
    await refuses("invalid_command", () => slotFile(), (e) => assert.match(e.message, /400 markers/));
    assert.equal((await c.svc.pendingErase(c.host, c.a)).length, MARKER_LIMITS.perProject);
    clock += 5000; // now all 400 are stale slot files
    await refuses("invalid_command", () => slotFile(), (e) => assert.match(e.message, /400 markers/));
    assert.equal((await c.svc.pendingErase(c.host, c.a)).length, MARKER_LIMITS.records);
    await c.svc.release(c.host, { commandId: cid("r"), projectId: c.a, markerId: made[0]! });
    assert.equal((await slotFile()).replayed, false, "releasing one made room");
  });

  suite("end to end: a call through an adapter is judged against its marker, a miss retires the marker, and the cache figures reach the usage ledger", async (c) => {
    // a Claude-like endpoint whose cache is gone the second time (evicted)
    const calls: number[] = [];
    const server: Transport = { send: async () => { calls.push(1); return { status: 200, body: { usage: { input_tokens: 40, cache_read_input_tokens: calls.length === 1 ? 0 : 0, cache_creation_input_tokens: calls.length === 1 ? 900 : 0, output_tokens: 3 } } }; } };
    const adapter = new CacheAdapter(profileFor(CLAUDE), server);
    const route = "anthropic/claude-opus-5-5";
    const request = { model: "claude-opus-5-5", system: "s".repeat(4000), messages: [{ role: "user", content: "q" }] };
    const first = await adapter.call(request, { scopeKey: "nn-scope" });
    assert.equal(first.outcome, "cold");
    const marker = await c.svc.register(c.host, { commandId: cid("m"), projectId: c.a, route, endpoint: CLAUDE, kind: "prefix", digest: digest("c"), tokens: first.hit.writtenTokens });
    await c.budgets.open(c.owner, { commandId: cid("o"), taskId: c.task, currency: "USD", costMicros: 1000 });
    const res = await c.budgets.reserve(c.host, { commandId: cid("r"), taskId: c.task, costMicros: 10, purpose: "call" });
    await c.budgets.settle(c.host, { commandId: cid("s"), reservationId: res.id, costMicros: 8, cache: ledgerCache(first.hit, "claude", route)! });
    const resolved = await c.svc.resolve(c.host, { projectId: c.a, markerId: marker.id, route });
    assert.equal(resolved.state, "active");
    const second = await adapter.call(request, { scopeKey: "nn-scope" }, resolved.state === "active" ? resolved.expectedCachedTokens : 0);
    assert.deepEqual([second.status, second.outcome], [200, "miss"], "the evicted cache is a miss and the call still succeeded");
    await c.svc.recordOutcome(c.host, { commandId: cid("o"), projectId: c.a, markerId: marker.id, outcome: second.outcome, reason: "cache_read_input_tokens was 0" });
    assert.deepEqual(await c.svc.resolve(c.host, { projectId: c.a, markerId: marker.id, route }), { state: "unavailable", reason: "lost" });
    const res2 = await c.budgets.reserve(c.host, { commandId: cid("r"), taskId: c.task, costMicros: 10, purpose: "call" });
    await c.budgets.settle(c.host, { commandId: cid("s"), reservationId: res2.id, costMicros: 8, cache: ledgerCache(second.hit, "claude", route)! });
    const usage = await c.budgets.usage(c.owner, { projectId: c.a });
    assert.deepEqual(usage.cacheByBackend, { claude: { cachedTokens: 0, computedTokens: 40 + 900 + 40, writtenTokens: 900, calls: 2 } });
  });
}
