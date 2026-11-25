import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fakeEngine, type FakeOptions } from "./g10-engines-fake.js";
import { concurrencyRun, evictionRun, extrasRun, idleRun, makeHead, parseMetrics, readCache, readEngineInfo, readMetrics, realEngineEnv, send, sharedRun, type EngineEnv } from "./g10-engines-live.js";

// Card G10, the other engines, offline: the measurement code of g10-engines-live.ts against scripted stand-ins of llama-server and vLLM (g10-engines-fake.ts). The real runs are manual (g10-engines-live-bench.ts).
// Nothing here opens a network connection: the stand-ins are given as `fetch`.

const LINES = 120;
function envFor(options: FakeOptions, sleeps: number[] = [], onSleep?: (ms: number) => void): { env: EngineEnv; fake: ReturnType<typeof fakeEngine> } {
  const fake = fakeEngine(options);
  const env = { ...realEngineEnv(options.kind, fake.fetch, "http://engine.invalid:8000/", "test-model", () => undefined), sleep: async (ms: number) => { sleeps.push(ms); onSleep?.(ms); } };
  return { env, fake };
}
const KINDS = [["llamacpp", { kind: "llamacpp" as const }], ["vllm", { kind: "vllm" as const }]] as const;

test("readCache: each engine's own fields; a missing field is 'not reported', never a guess", () => {
  assert.deepEqual(readCache("llamacpp", { usage: { prompt_tokens: 1000 }, timings: { cache_n: 900, prompt_n: 100, prompt_ms: 12.4 } }), { promptTokens: 1000, cachedTokens: 900, computedTokens: 100, serverPromptMs: 12.4, reported: true });
  assert.deepEqual(readCache("llamacpp", { timings: { cache_n: 7, prompt_n: 3 } }), { promptTokens: 10, cachedTokens: 7, computedTokens: 3, reported: true }, "prompt tokens come from the timings when usage is missing");
  assert.deepEqual(readCache("llamacpp", { usage: { prompt_tokens: 50 } }), { promptTokens: 50, reported: false });
  assert.deepEqual(readCache("vllm", { usage: { prompt_tokens: 500, prompt_tokens_details: { cached_tokens: 480 } } }), { promptTokens: 500, cachedTokens: 480, computedTokens: 20, reported: true });
  assert.deepEqual(readCache("vllm", { usage: { prompt_tokens: 500, prompt_tokens_details: null } }), { promptTokens: 500, reported: false }, "vLLM without the flag says nothing");
  assert.deepEqual(readCache("vllm", { usage: { prompt_tokens: 500 }, timings: { cache_n: 400, prompt_n: 100 } }), { promptTokens: 500, reported: false }, "llama.cpp timings are not read from a vLLM server");
  assert.deepEqual(readCache("vllm", null), { promptTokens: 0, reported: false });
  assert.deepEqual(readCache("llamacpp", { usage: { prompt_tokens: "9" }, timings: { cache_n: Number.NaN, prompt_n: 1 } }), { promptTokens: 0, computedTokens: 1, reported: false });
});

test("parseMetrics keeps only the named counters, sums labelled series, and keeps the cache configuration labels it names", () => {
  const text = [
    "# HELP vllm:prefix_cache_hits_total x", "vllm:prefix_cache_hits_total{model_name=\"a\",engine=\"0\"} 120", "vllm:prefix_cache_hits_total{model_name=\"b\"} 5", "vllm:prefix_cache_queries_total{model_name=\"a\"} 1000",
    "vllm:cache_config_info{block_size=\"16\",num_gpu_blocks=\"2048\",enable_prefix_caching=\"True\",secret_label=\"x\"} 1", "vllm:other_metric 3", "llamacpp:prompt_tokens_total 77", "process_cpu_seconds_total 4", "vllm:kv_cache_usage_perc NaN",
  ].join("\n");
  assert.deepEqual(parseMetrics(text), { counters: { "vllm:prefix_cache_hits_total": 125, "vllm:prefix_cache_queries_total": 1000, "llamacpp:prompt_tokens_total": 77 }, cacheConfig: "block_size=\"16\",num_gpu_blocks=\"2048\",enable_prefix_caching=\"True\"" });
});

test("shared head: cold, a second and a third conversation reuse the head, an unrelated head does not; both engines", async () => {
  for (const [name, options] of KINDS) {
    const { env, fake } = envFor(options);
    const r = await sharedRun(env, { lines: LINES });
    assert.deepEqual(r.steps.map((s) => s.step), ["cold", "second-conversation", "third-conversation", "unrelated-head"], name);
    assert.ok(Object.values(r.checks).every(Boolean), `${name} ${JSON.stringify(r.checks)}`);
    const [cold, second] = r.steps;
    assert.equal(cold!.cachedTokens, 0, name);
    assert.ok(second!.cachedTokens! > 0.8 * second!.promptTokens, name);
    assert.deepEqual(r.fixtures.map((f) => f.name), [`${name}-cold`, `${name}-shared-hit`]);
    // Only chat completions are sent as model calls, each carrying the synthetic text only.
    const posts = fake.requests.filter((q) => q.method === "POST");
    assert.ok(posts.every((q) => q.path === "/v1/chat/completions" && q.body!["stream"] === true), name);
    assert.ok(r.steps.every((s) => s.metricsDelta === undefined || Object.keys(s.metricsDelta).length > 0));
  }
});

test("shared head: a vLLM server without --enable-prompt-tokens-details is recorded as not reported, and no reuse is claimed", async () => {
  const { env } = envFor({ kind: "vllm", details: false });
  const r = await sharedRun(env, { lines: LINES });
  assert.ok(r.steps.every((s) => !s.reported && s.cachedTokens === undefined && s.reusedFraction === undefined));
  assert.equal(r.checks["cacheFiguresReported"], false);
  assert.equal(r.checks["secondConversationReusedHead"], false);
  assert.equal(r.checks["coldComputedMostOfIt"], false, "an unreported cold call is not counted as a measured cold call");
  assert.ok(r.steps.every((s) => s.correct));
  const second = r.steps[1]!;
  assert.ok((second.metricsDelta?.["vllm:prefix_cache_hits_total"] ?? 0) > 0, "the metrics counters still show the hit");
});

test("idle gaps: every gap is waited (0 is not), each gap has its own head, and a server that drops the cache during a gap is a miss from that gap on", async () => {
  for (const [name, options] of KINDS) {
    const sleeps: number[] = []; const order: string[] = [];
    const { env, fake } = envFor(options, sleeps, (ms) => order.push(`sleep ${ms}`));
    const r = await idleRun({ ...env, fetch: (async (u: string, init?: RequestInit) => { if (String(u).endsWith("/v1/chat/completions")) order.push("chat"); return fake.fetch(u, init); }) as unknown as typeof fetch }, { gapsS: [0, 15, 30, 60, 120], lines: LINES });
    assert.deepEqual(sleeps, [15_000, 30_000, 60_000, 120_000], name);
    assert.deepEqual(order, ["chat", "chat", "chat", "sleep 15000", "chat", "chat", "sleep 30000", "chat", "chat", "sleep 60000", "chat", "chat", "sleep 120000", "chat"], `${name}: each gap sits between the warm call and the call after it, with nothing sent meanwhile`);
    const nonces = fake.requests.filter((q) => q.path === "/v1/chat/completions").map((q) => /^Run ([0-9a-f]+)\./.exec((q.body!["messages"] as { content: string }[])[0]!.content)?.[1]);
    assert.deepEqual([new Set(nonces).size, nonces.length], [5, 10], `${name}: one head per gap, read twice`);
    for (let i = 0; i < 10; i += 2) assert.equal(nonces[i], nonces[i + 1], name);
    assert.deepEqual(r.checks, { reusedAfter0s: true, reusedAfter15s: true, reusedAfter30s: true, reusedAfter60s: true, reusedAfter120s: true, allAnswersCorrect: true }, name);
  }
  const fake = fakeEngine({ kind: "vllm" });
  const env: EngineEnv = { ...realEngineEnv("vllm", fake.fetch, "http://e.invalid", "m", () => undefined), sleep: async (ms) => { if (ms >= 60_000) fake.forget(); } };
  const r = await idleRun(env, { gapsS: [0, 30, 60, 120], lines: LINES });
  assert.deepEqual([r.checks["reusedAfter0s"], r.checks["reusedAfter30s"], r.checks["reusedAfter60s"], r.checks["reusedAfter120s"]], [true, true, false, false]);
  assert.equal(r.steps.find((s) => s.step === "after-60s")!.cachedTokens, 0);
});

test("eviction cliff: both engines keep the first head through a few others and lose it past their capacity; the cliff is recorded, or 'not reached'", async () => {
  // vLLM: 20,000 tokens of cache; a head of 120 rules is about 2,444 tokens, so eight heads fit and nine do not. Each probe also refreshes the first head, so the cliff is the number of OTHER heads read since the previous probe that no longer fits beside it (here 8 others between the probes at 8 and 16).
  let { env } = envFor({ kind: "vllm", capacityTokens: 20_000 });
  let r = await evictionRun(env, { lines: LINES, levels: [1, 2, 4, 8, 16, 32] });
  assert.equal(r.notes["cliffReached"], true);
  assert.equal(r.notes["cliffAtOtherHeads"], 16);
  const probes = r.steps.filter((s) => s.step.startsWith("first-head-after-"));
  assert.deepEqual(probes.map((s) => (s.reusedFraction ?? 0) >= 0.5), [true, true, true, true, false], "levels 1, 2, 4 and 8 still hit; 16 is the first miss and the ladder stops there");
  assert.equal(r.steps.filter((s) => s.step.startsWith("other-head-")).length, 16);
  assert.equal(r.checks["firstHeadWasWarm"], true);
  assert.deepEqual([r.notes["cliffOtherHeadsSinceLastUse"], r.notes["lastKeptOtherHeadsSinceLastUse"]], [8, 4], "8 others since the probe at 8 pushed it out; 4 since the probe at 4 did not");
  // llama.cpp with four slots: the first head's slot is taken over once four other conversations have run since its last use.
  ({ env } = envFor({ kind: "llamacpp", slots: 4 }));
  r = await evictionRun(env, { lines: LINES, levels: [1, 2, 4, 8] });
  assert.deepEqual([r.notes["cliffAtOtherHeads"], r.notes["cliffOtherHeadsSinceLastUse"], r.notes["lastKeptOtherHeadsSinceLastUse"]], [8, 4, 2]);
  // With a host-memory prompt cache the first head outlives its slot: no cliff within the same ladder, and the cliff moves out to what the host cache holds (about 4 heads here).
  ({ env } = envFor({ kind: "llamacpp", slots: 4, hostCacheTokens: 4 * 2444 }));
  r = await evictionRun(env, { lines: LINES, levels: [1, 2, 4, 8, 16] });
  assert.deepEqual([r.notes["cliffAtOtherHeads"], r.notes["cliffOtherHeadsSinceLastUse"]], [16, 8]);
  // A capacity that is not reached within the ladder is said so.
  ({ env } = envFor({ kind: "vllm", capacityTokens: 4_000_000 }));
  r = await evictionRun(env, { lines: LINES, levels: [1, 2, 4] });
  assert.deepEqual([r.notes["cliffReached"], "cliffAtOtherHeads" in r.notes, "cliffOtherHeadsSinceLastUse" in r.notes, r.notes["lastKeptOtherHeadsSinceLastUse"]], [false, false, false, 2]);
  assert.ok(r.steps.filter((s) => s.step.startsWith("first-head-after-")).every((s) => (s.reusedFraction ?? 0) >= 0.5));
});

test("concurrency 1, 2, 4 and 8: every warm request reuses the head, cold ones are counted, and the requests really overlap", async () => {
  for (const [name, options] of KINDS) {
    const { env, fake } = envFor(options);
    const r = await concurrencyRun(env, { levels: [1, 2, 4, 8], lines: LINES });
    assert.deepEqual(r.levels.map((l) => [l.level, l.warm.length, l.cold.length, l.warmReusedCount]), [[1, 1, 1, 1], [2, 2, 2, 2], [4, 4, 4, 4], [8, 8, 8, 8]], name);
    assert.deepEqual(r.checks, { everyWarmRequestReusedTheHead: true, allAnswersCorrectUnderLoad: true, noRequestRefused: true }, name);
    assert.ok(fake.inFlightMax() >= 8, `${name}: at least 8 requests were in flight together (saw ${fake.inFlightMax()})`);
    // Each cold group sends one new head to n conversations at once: the first computes, so at most n-1 of them can reuse.
    assert.ok(r.levels.every((l) => l.coldReusedCount <= l.level - 1), name);
  }
  {
    const { env, fake } = envFor({ kind: "vllm" });
    await concurrencyRun(env, { levels: [4], lines: LINES });
    assert.deepEqual(fake.chatStarts, [1, 1, 2, 3, 4, 1, 2, 3, 4], "the prime call alone, then 4 warm and 4 cold requests each arriving while the earlier ones are still in flight");
  }
  const { env } = envFor({ kind: "vllm", details: false });
  const r = await concurrencyRun(env, { levels: [2], lines: LINES });
  assert.equal(r.checks["everyWarmRequestReusedTheHead"], false, "unreported figures are not counted as reuse");
});

test("refused or failing requests are recorded, not thrown", async () => {
  const fake = fakeEngine({ kind: "vllm" });
  const failing = { ...realEngineEnv("vllm", (async () => new Response("overloaded", { status: 503 })) as unknown as typeof fetch, "http://e.invalid", "m", () => undefined), sleep: async () => undefined };
  const a = await send(failing, "t", "s", makeHead(20), 0);
  assert.deepEqual([a.step.status, a.step.correct, a.step.reported, a.step.error], [503, false, false, "overloaded"]);
  const thrown = { ...failing, fetch: (async () => { throw new Error("connection reset"); }) as unknown as typeof fetch };
  const b = await send(thrown, "t", "s", makeHead(20), 0);
  assert.deepEqual([b.step.status, b.step.correct, b.step.error], [0, false, "connection reset"]);
  const m = await readMetrics(thrown);
  assert.equal("error" in m && m.error, "connection reset");
  const c = await readMetrics({ ...failing, fetch: fake.fetch, root: "http://e.invalid" });
  assert.ok("counters" in c);
});

test("extras, llama.cpp: an unknown setting is refused and the plain retry answers; slots keep their own cache; cache_prompt false computes all; save, erase and restore bring the head back", async () => {
  const { env, fake } = envFor({ kind: "llamacpp", slots: 4, strict: true });
  const r = await extrasRun(env, { lines: LINES, saveFile: "nn-test.bin" });
  assert.deepEqual(r.checks, { plainRetryAnswered: true, sameSlotReused: true, cachePromptFalseComputedAll: true, eraseRemovedTheHead: true, restoreGaveTheHeadBack: true, allAnswersCorrect: true });
  assert.deepEqual(r.notes["unknownCacheSetting"], { outcome: "refused", status: 400, message: "unknown field nn_unknown_cache_setting" });
  assert.equal(r.notes["otherSlotReusedHead"], false, "a second slot starts empty: nothing is shared across slots");
  const sr = r.notes["slotSaveRestore"] as { saveStatus: number; afterEraseReusedFraction: number; afterRestoreReusedFraction: number };
  assert.deepEqual([sr.saveStatus, sr.afterEraseReusedFraction < 0.5, sr.afterRestoreReusedFraction >= 0.5], [200, true, true]);
  assert.deepEqual(fake.requests.filter((q) => q.path.startsWith("/slots/")).map((q) => q.path), ["/slots/0?action=save", "/slots/0?action=erase", "/slots/0?action=restore"]);
  // The real server of the 2026-11-25 run ignored the unknown field: the default stand-in does too.
  const lenient = await extrasRun(envFor({ kind: "llamacpp", slots: 4 }).env, { lines: LINES });
  assert.deepEqual(lenient.notes["unknownCacheSetting"], { outcome: "ignored", status: 200 });
  const noSave = envFor({ kind: "llamacpp", saveEnabled: false }).env;
  const r2 = await extrasRun(noSave, { lines: LINES });
  assert.deepEqual(r2.notes["slotSaveRestore"], { saveStatus: 501, outcome: "not available (the server needs --slot-save-path)" });
  assert.equal("restoreGaveTheHeadBack" in r2.checks, false);
  // A server with a host-memory prompt cache (--cache-ram) still serves the head after the slot is erased: said, not hidden.
  const withHost = envFor({ kind: "llamacpp", slots: 4, hostCacheTokens: 100_000 }).env;
  const r3 = await extrasRun(withHost, { lines: LINES, saveFile: "nn-test.bin" });
  assert.deepEqual([r3.checks["eraseRemovedTheHead"], r3.checks["restoreGaveTheHeadBack"]], [false, true]);
  assert.equal((r3.notes["slotSaveRestore"] as { afterEraseReusedFraction: number }).afterEraseReusedFraction >= 0.5, true);
});

test("extras, vLLM: an unknown setting is ignored; cache_salt partitions the cache (same salt reuses, another salt and none do not); an older build that refuses cache_salt is recorded", async () => {
  const { env, fake } = envFor({ kind: "vllm" });
  const r = await extrasRun(env, { lines: LINES });
  assert.deepEqual(r.checks, { plainRetryAnswered: true, sameSaltReused: true, otherSaltDidNotReuse: true, noSaltDidNotReuse: true, allAnswersCorrect: true });
  // The salts are new for every run: a second run on the same server uses other values, so it cannot meet the first run's blocks.
  await extrasRun(env, { lines: LINES });
  const salts = fake.requests.map((q) => q.body?.["cache_salt"]).filter((v): v is string => typeof v === "string");
  assert.equal(salts.length, 6);
  assert.deepEqual([salts[0] === salts[1], salts[1] !== salts[2], new Set(salts).size], [true, true, 4], "a, a, b in each run; four distinct values over two runs");
  assert.deepEqual(r.notes["unknownCacheSetting"], { outcome: "ignored", status: 200 });
  const old = envFor({ kind: "vllm", noSalt: true }).env;
  const r2 = await extrasRun(old, { lines: LINES });
  assert.deepEqual(r2.notes["cacheSalt"], { outcome: "refused", status: 400, message: "cache_salt is not supported" });
  assert.equal("sameSaltReused" in r2.checks, false);
});

test("engine info: llama.cpp slot count and context, vLLM maximum length; nothing else is kept", async () => {
  assert.deepEqual({ ...(await readEngineInfo(envFor({ kind: "llamacpp", slots: 3 }).env)), at: "-" }, { at: "-", kind: "llamacpp", totalSlots: 3, nCtxPerSlot: 8192, slots: [{ id: 0, nCtx: 8192, busy: false }, { id: 1, nCtx: 8192, busy: false }, { id: 2, nCtx: 8192, busy: false }] });
  assert.deepEqual({ ...(await readEngineInfo(envFor({ kind: "vllm" }).env)), at: "-" }, { at: "-", kind: "vllm", maxModelLen: 16384 });
});

test("evidence holds usage and timing fields only: no ledger text, no nonce, no answer, and the model calls carry no credential header", async () => {
  const { env } = envFor({ kind: "llamacpp" });
  const head = makeHead(30);
  const r = await send(env, "p", "s", head, 0);
  const text = JSON.stringify([r.step, r.raw]);
  assert.ok(!text.includes("Rule 1:") && !text.includes(head.nonce) && !text.includes(head.code) && !text.includes("ledger"), "no prompt or answer text");
  const seen: Record<string, string>[] = [];
  const spy: EngineEnv = { ...env, fetch: (async (u: string, init?: { headers?: Record<string, string> }) => { seen.push(init?.headers ?? {}); return new Response("{}", { status: 404 }); }) as unknown as typeof fetch };
  await send(spy, "p", "s", head, 0);
  assert.ok(seen.every((h) => Object.keys(h).every((k) => k.toLowerCase() === "content-type")), "only a content type is sent");
});

test("captured responses (2026-11-25, Qwen3-8B on a rented GPU) read right with the same reader the bench uses", () => {
  const read = (name: string): { status: number; body: { usage: { prompt_tokens: number; prompt_tokens_details?: { cached_tokens: number } }; timings?: { cache_n: number; prompt_n: number } } } =>
    JSON.parse(readFileSync(fileURLToPath(new URL(`../test-fixtures/g10-engines/${name}.json`, import.meta.url)), "utf8"));
  const vCold = readCache("vllm", read("vllm-cold").body); const vHit = readCache("vllm", read("vllm-shared-hit").body);
  assert.deepEqual([vCold.reported, vCold.cachedTokens, vHit.reported, vHit.promptTokens], [true, 0, true, 6470]);
  assert.ok(vHit.cachedTokens! > 0.98 * vHit.promptTokens && vHit.cachedTokens! % 64 === 0, "vLLM reuses whole 64-token blocks on this build");
  const lCold = readCache("llamacpp", read("llamacpp-cold").body); const lHit = readCache("llamacpp", read("llamacpp-shared-hit").body);
  assert.ok(lCold.reported && lCold.cachedTokens! < 0.01 * lCold.promptTokens, "a cold llama.cpp call computes (almost) all of it (other cold calls in the runs show 4 to 6 cached tokens, the shared chat-template start)");
  assert.deepEqual([lHit.cachedTokens, lHit.computedTokens, lHit.promptTokens], [6454, 18, 6472]);
  const raw = read("llamacpp-shared-hit").body;
  assert.equal(raw.timings!.cache_n + raw.timings!.prompt_n, raw.usage.prompt_tokens, "cache_n + prompt_n is the prompt");
  assert.equal(raw.usage.prompt_tokens_details!.cached_tokens, raw.timings!.cache_n, "this build repeats cache_n in usage");
  for (const n of ["vllm-cold", "vllm-shared-hit", "llamacpp-cold", "llamacpp-shared-hit"]) assert.ok(!/content|ledger|Rule/.test(JSON.stringify(read(n))), `${n}: no text`);
});

test("time to first token is taken at the first non-empty content, not at the end of the stream", async () => {
  let clock = 1000; const enc = new TextEncoder();
  const ev = (o: unknown): Uint8Array => enc.encode(`data: ${JSON.stringify(o)}\n\n`);
  const head = makeHead(20);
  // A plain response whose stream makes each chunk only when the client asks for it (highWaterMark 0): a Response would read ahead on some Node versions and move the clock early.
  const streaming = (async () => ({ status: 200, body: new ReadableStream<Uint8Array>({
    async pull(c) {
      if (clock === 1000) { clock += 30; c.enqueue(ev({ choices: [{ delta: { role: "assistant", content: "" } }] })); return; }
      if (clock === 1030) { clock += 20; c.enqueue(ev({ choices: [{ delta: { content: head.code } }] })); return; }
      if (clock === 1050) { clock += 400; c.enqueue(ev({ choices: [], usage: { prompt_tokens: 100 }, timings: { cache_n: 90, prompt_n: 10 } })); c.enqueue(enc.encode("data: [DONE]\n\n")); c.close(); }
    },
  }, { highWaterMark: 0 }), text: async () => "" })) as unknown as typeof fetch;
  const env: EngineEnv = { ...realEngineEnv("llamacpp", streaming, "http://e.invalid", "m", () => undefined), now: () => clock, sleep: async () => undefined };
  const r = await send(env, "t", "s", head, 0, { noMetrics: true });
  assert.deepEqual([r.step.clientTtftMs, r.step.wallMs, r.step.correct, r.step.cachedTokens], [50, 450, true, 90], "the empty role event does not count; the usage event at the end is not the first token");
});

test("the committed evidence (2026-11-25) holds the figures the note states, recomputed from the steps", () => {
  type S = { step: string; promptTokens: number; cachedTokens?: number; clientTtftMs?: number; correct: boolean; status: number };
  type Run = Record<string, { steps: S[]; levels?: { level: number; warmReusedCount: number; coldReusedCount: number; warmWallMs: number }[] }>;
  const load = (n: string): Run => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../docs/nimblenewt/implementation-plan/evidence/${n}.json`, import.meta.url)), "utf8"));
  const v = load("g10-vllm-run1"); const l1 = load("g10-llamacpp-run1"); const l2 = load("g10-llamacpp-run2");
  const hit = (s: S): boolean => (s.cachedTokens ?? 0) / s.promptTokens >= 0.5;
  // The ladder, as other heads read since the head's last use (the previous probe): [kept at, lost at].
  const ladder = (run: Run): [number, number] => {
    let last = 0; let kept = 0; let others = 0;
    for (const s of run["eviction"]!.steps) {
      if (s.step.startsWith("other-head-")) others += 1;
      if (s.step.startsWith("first-head-after-")) { const since = others - last; last = others; if (!hit(s)) return [kept, since]; kept = since; }
    }
    return [kept, Number.NaN];
  };
  assert.deepEqual([ladder(v), ladder(l2), ladder(l1)], [[4, 8], [2, 4], [8, 16]], "vLLM, llama.cpp without the host cache, llama.cpp with it");
  // Concurrency: reused counts per level.
  const conc = (run: Run): number[][] => run["concurrency"]!.levels!.map((x) => [x.level, x.warmReusedCount, x.coldReusedCount]);
  assert.deepEqual(conc(v), [[1, 1, 0], [2, 2, 1], [4, 4, 3], [8, 8, 7]]);
  assert.deepEqual(conc(l1), [[1, 1, 0], [2, 1, 0], [4, 1, 0], [8, 5, 4]]);
  assert.deepEqual(conc(l2), [[1, 1, 0], [2, 1, 0], [4, 1, 0], [8, 5, 4]]);
  // The erase rows: host cache on (run 1) still served the head into the erased slot; with --cache-ram 0 (run 2) it did not, and the restore gave it back.
  const row = (run: Run, step: string): [number, number] => { const s = run["extras"]!.steps.find((x) => x.step === step)!; return [s.cachedTokens!, s.promptTokens]; };
  assert.deepEqual([row(l1, "slot0-after-erase"), row(l2, "slot0-after-erase"), row(l2, "slot0-after-restore")], [[6469, 6470], [0, 6471], [6470, 6471]]);
  assert.deepEqual([row(l1, "cache-prompt-off"), row(l1, "slot1-same-head"), row(l2, "slot1-same-head")], [[0, 6470], [4, 6470], [0, 6471]]);
  // vLLM's one slow first token after an idle gap, with the whole head reused.
  const idle = v["idle"]!.steps.filter((s) => s.step.startsWith("after-")).map((s) => [s.cachedTokens, s.clientTtftMs]);
  assert.deepEqual(idle, [[6400, 244], [6400, 1794], [6400, 369], [6400, 757], [6400, 668]]);
  for (const run of [v, l1, l2]) for (const p of Object.values(run)) if (typeof p === "object" && p !== null && "steps" in p) assert.ok(p.steps.every((s) => s.status === 200 && s.correct));
});
