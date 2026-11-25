import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CacheAdapter, type HttpResponse } from "@nimblenewt/controller";
import { keyFrom } from "./g09-radiance-gate.js";
import { fakeRadiance } from "./g09-radiance-fake.js";
import { HttpTransport, concurrencyRun, fixtureBody, makeHead, radianceProfile, readSessions, readStats, realEnv, refusalRun, refusingProfile, retainedRun, type LiveEnv } from "./g10-radiance-live.js";

// Card G10, the clauses the first run left open (retained marker, refusal fallback, concurrency), offline: the production CacheAdapter and MarkerService against the scripted server of g09-radiance-fake.ts.
// The live run is g10-radiance-live-bench.ts (by hand); its captured responses are re-tested in packages/controller/src/inference-cache/g10-live-captured.test.ts.

const SECRET = "test-key-0123456789abcdef";
const key = keyFrom(SECRET, "http://radiance.invalid:8002/v1");
const MODEL = "qwen3.8-flash-next-iq4r";
const here = dirname(fileURLToPath(import.meta.url));
function envFor(fake: ReturnType<typeof fakeRadiance>, sleeps: number[] = []): LiveEnv {
  return { ...realEnv(fake.fetch, "http://radiance.invalid:8002", key, MODEL, () => undefined), sleep: async (ms) => { sleeps.push(ms); } };
}

test("retained run: cold, native and retained runs are kept apart; the marker expects what the native run reused and every retained call reuses it with the right answer", async () => {
  const fake = fakeRadiance({ key: SECRET });
  const sleeps: number[] = [];
  const r = await retainedRun(envFor(fake, sleeps), { gapsS: [0, 60, 300], lines: 120 });
  const by = (name: string) => r.steps.find((s) => s.step === name)!;
  assert.equal(by("cold").phase, "cold-native");
  assert.equal(by("native-repeat").phase, "cold-native");
  assert.equal(by("cold").outcome, "cold");
  assert.equal(by("cold").cachedTokens, 0);
  assert.equal(by("native-repeat").outcome, "hit");
  const reusable = by("native-repeat").cachedTokens;
  assert.ok(reusable > 0 && reusable % 2048 === 0, "reuse is in whole 2,048-token steps");
  const retained = r.steps.filter((s) => s.phase === "retained" && s.step.startsWith("retained"));
  assert.deepEqual(retained.map((s) => s.step), ["retained-after-0s", "retained-after-60s", "retained-after-300s", "retained-switch-back"]);
  for (const s of retained) assert.deepEqual([s.expectedCachedTokens, s.outcome, s.cachedTokens >= reusable, s.correct], [reusable, "hit", true, true], s.step);
  assert.deepEqual(sleeps.filter((m) => m > 0), [60_000, 300_000], "each gap is waited, and the gap of 0 is not");
  const miss = by("lost-changed-head");
  assert.deepEqual([miss.outcome, miss.cachedTokens, miss.correct], ["miss", 0, true], "the changed head is a miss and still answered from its full context");
  assert.deepEqual(r.checks, { coldComputedEverything: true, nativeReuseServed: true, retainedReusedAll: true, retentionMissObserved: false, missMarkedLost: true, missStillAnsweredFromFullContext: true, allAnswersCorrect: true });
  const last = r.markers.at(-1) as { activeMarkersAtEnd: { kind: string; tokens: number; hits: number }[] };
  assert.deepEqual(last.activeMarkersAtEnd, [], "a lost marker is no longer listed as active");
  const changed = r.markers.find((m) => (m as { changedHead?: boolean }).changedHead) as { markerAfter: string };
  assert.equal(changed.markerAfter, "lost");
  // Each model call is a streamed chat completion with only the production profile's label added; no cache-reset path is ever called.
  const posts = fake.requests.filter((q) => q.method === "POST");
  assert.ok(posts.every((q) => q.path === "/v1/chat/completions" && typeof (q.body as { session_id?: unknown }).session_id === "string"));
  assert.ok(fake.requests.every((q) => q.auth && !q.path.includes("reset")));
});

test("retained run: a retained prefix the server dropped meanwhile is a miss, the marker is marked lost through the marker service, the answer still comes from the full context, and no later gap is waited", async () => {
  const fake = fakeRadiance({ key: SECRET });
  const gaps: number[] = [];
  const env = { ...envFor(fake), sleep: async (ms: number) => { gaps.push(ms); if (ms >= 60_000) fake.forget(); } };
  const r = await retainedRun(env, { gapsS: [0, 60, 300], lines: 120 });
  const miss = r.steps.find((s) => s.step === "retained-after-60s")!;
  assert.deepEqual([miss.outcome, miss.cachedTokens, miss.correct, miss.expectedCachedTokens > 0], ["miss", 0, true, true]);
  assert.deepEqual(gaps, [60_000], "after the loss the 300 s gap is not waited for");
  assert.equal(r.steps.some((s) => s.step === "retained-after-300s" || s.step === "lost-changed-head"), false);
  assert.deepEqual([r.checks["retentionMissObserved"], r.checks["retentionMissMarkedLost"], r.checks["retentionMissAnsweredFromFullContext"], r.checks["retainedReusedAll"]], [true, true, true, false]);
  assert.equal((r.markers.find((m) => (m as { gapS?: number }).gapS === 60) as { markerAfter: string }).markerAfter, "lost");
});

test("retained run: a marker the server cannot serve (nothing reused natively) is never registered, so nothing is expected of it", async () => {
  const fake = fakeRadiance({ key: SECRET });
  // Under the 2,048-token step nothing is ever reused, as on the real server.
  const r = await retainedRun(envFor(fake), { gapsS: [0], lines: 30 });
  assert.equal(r.steps.find((s) => s.step === "native-repeat")!.cachedTokens, 0);
  assert.equal(r.checks["nativeReuseServed"], false);
  assert.equal(r.steps.some((s) => s.step.startsWith("retained")), false);
});

test("refusal run: the production adapter retries a real 400 that names a refused setting with every cache setting removed, with the same messages, and records the fallback", async () => {
  const fake = fakeRadiance({ key: SECRET });
  const r = await refusalRun(envFor(fake), { lines: 120 });
  assert.deepEqual(r.refusal.status, 400);
  assert.match(r.refusal.message, /logit_bias/);
  const fb = r.steps.find((s) => s.step === "fallback-served")!;
  assert.deepEqual([fb.status, fb.correct, fb.fallback?.refusedStatus, fb.fallback?.removed, fb.cachedTokens > 0], [200, true, 400, ["session_id", "logit_bias"], true]);
  assert.deepEqual(r.checks, { serverRefusedTheSetting: true, fallbackRecorded: true, fallbackAnsweredFromFullContext: true, fallbackStillReusedTheHead: true, fallbackRepeatsPerCall: true, otherRefusalReturnedUnchanged: true });
  // The refused call and its retry carry the same messages.
  const posts = fake.requests.filter((q) => q.method === "POST").map((q) => q.body as { messages: unknown[]; logit_bias?: unknown; session_id?: unknown });
  const refusedAt = posts.findIndex((p, i) => p.logit_bias !== undefined && posts[i + 1]?.logit_bias === undefined && JSON.stringify(posts[i + 1]?.messages) === JSON.stringify(p.messages) && posts[i + 1]?.session_id === undefined);
  assert.ok(refusedAt >= 0, "a refused request is followed by the same messages without any cache setting");
});

test("refusal run: a 400 that names no cache setting is returned unchanged, and the wrapper profile differs from production only by the one setting", async () => {
  const p = radianceProfile(MODEL); const w = refusingProfile(MODEL);
  const ctx = { scopeKey: "nn-scope0123456789", shareKey: "nn-share0123456789" };
  const request = { messages: [{ role: "user", content: "x" }] };
  assert.deepEqual(Object.keys(w.prepare(request, ctx).body).filter((k) => !(k in p.prepare(request, ctx).body)), ["logit_bias"]);
  assert.deepEqual(w.prepare(request, { ...ctx, plain: true }).body, p.prepare(request, { ...ctx, plain: true }).body, "the plain retry is the production plain request");
  assert.equal(w.refusedCacheSetting({ status: 400, message: "temperature: expected a number" }), false);
  assert.equal(w.refusedCacheSetting({ status: 500, message: "logit_bias" }), false);
  assert.equal(p.refusedCacheSetting({ status: 400, message: "logit_bias: unsupported" }), false);
  const fake = fakeRadiance({ key: SECRET });
  const adapter = new CacheAdapter(p, new HttpTransport(envFor(fake), 8));
  const res = await adapter.call({ messages: [{ role: "user", content: "x" }], temperature: "hot" }, ctx, 0);
  assert.deepEqual([res.status, res.fallback, res.outcome], [400, undefined, "unknown"]);
  assert.equal(fake.requests.filter((q) => q.method === "POST").length, 1, "no retry");
});

test("concurrency: N conversations at once through the production adapter; every cold one computes all, every repeat reuses, answers right under load", async () => {
  const fake = fakeRadiance({ key: SECRET, pieceMs: 1 });
  const r = await concurrencyRun(envFor(fake), { levels: [1, 2, 8], lines: 100 });
  assert.deepEqual(r.levels.map((l) => [l.streams, l.cold.length, l.repeat.length]), [[1, 1, 1], [2, 2, 2], [8, 8, 8]]);
  assert.deepEqual(r.checks, { allAnswersCorrectUnderLoad: true, everyRepeatReusedSomething: true, everyColdComputedEverything: true });
  for (const l of r.levels) for (const s of l.repeat) assert.ok(s.cachedTokens > 0 && s.cachedTokens % 2048 === 0, `${l.streams}: ${s.step}`);
  assert.ok(fake.state.maxInFlight >= 8, `the level of 8 overlapped (max ${fake.state.maxInFlight})`);
  assert.equal(r.afterLoad?.length, 1);
  assert.equal(r.afterLoad![0]!.correct, true);
  await assert.rejects(concurrencyRun(envFor(fake), { levels: [9], lines: 20 }), /1 to 8 streams/);
  await assert.rejects(concurrencyRun(envFor(fake), { levels: [0], lines: 20 }), /1 to 8 streams/);
});

test("stats and sessions readers keep only named figures, never fail the run, and never carry the key", async () => {
  const fake = fakeRadiance({ key: SECRET });
  const s = await readStats(envFor(fake));
  assert.equal(s["max_num_seqs"], 8);
  assert.equal(key.count(JSON.stringify(s)), 0);
  assert.deepEqual(await readSessions(envFor(fake), ["a"]), []);
  const broken: LiveEnv = { ...envFor(fake), fetch: (async () => { throw new Error(`down ${SECRET}`); }) as typeof fetch };
  const b = await readStats(broken);
  assert.equal(typeof b["error"], "string");
  assert.equal(key.count(JSON.stringify(b)), 0, "the error text is scrubbed");
  assert.deepEqual(await readSessions(broken, ["a"]), []);
});

test("fixtures keep the usage, timings and a short answer; a refusal keeps only its error; neither carries an id or the key", () => {
  const body = fixtureBody({ id: "chatcmpl-abc", model: MODEL, system_fingerprint: "x", choices: [{ message: { content: "amber-123".repeat(30) }, finish_reason: "stop" }], usage: { prompt_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } }, timings: { cache_n: 0, prompt_n: 5 } }) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ["choices", "model", "object", "timings", "usage"]);
  assert.ok(((body["choices"] as { message: { content: string } }[])[0]!.message.content).length <= 80);
  assert.deepEqual(fixtureBody({ error: { message: "m", type: "t", param: "p", code: null }, extra: 1 }), { error: { message: "m", type: "t", param: "p", code: null } });
  assert.deepEqual(Object.keys(fixtureBody(undefined) as object), ["object", "model", "choices", "usage", "timings"]);
});

test("heads are synthetic, differ every time, and hold their facts; the transport adds the key only as a header and sets the reply limit", async () => {
  const a = makeHead(40); const b = makeHead(40);
  assert.notEqual(a.nonce, b.nonce);
  assert.ok(a.text.includes(`the vault code for this run is ${a.code}`) && a.text.includes(`the on-call team for this run is ${a.team}`));
  const fake = fakeRadiance({ key: SECRET });
  const t = new HttpTransport(envFor(fake), 7);
  const res = await t.send({ method: "POST", path: "/v1/chat/completions", headers: {}, body: { messages: [{ role: "user", content: "Reply with exactly: READY" }], max_completion_tokens: 99 } });
  assert.equal(res.status, 200);
  const sent = fake.requests.at(-1)!.body as { max_tokens: number; max_completion_tokens?: number };
  assert.deepEqual([sent.max_tokens, sent.max_completion_tokens], [7, undefined]);
  assert.ok(fake.requests.at(-1)!.auth);
  const unauth = new HttpTransport({ ...envFor(fake), key: keyFrom("another-key-0123456789", "http://x") }, 7);
  const bad: HttpResponse = await unauth.send({ method: "POST", path: "/v1/chat/completions", headers: {}, body: { messages: [] } });
  assert.equal(bad.status, 401);
});

test("the committed live fixtures hold no key-like text, no id and no address", () => {
  const dir = join(here, "..", "..", "controller", "test-fixtures", "g10-radiance-live");
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { /* the live run has not been captured yet */ }
  for (const f of files) {
    const text = readFileSync(join(dir, f), "utf8");
    assert.ok(!/Bearer |sk-|chatcmpl-|\d+\.\d+\.\d+\.\d+|localhost|127\.0\.0\.1/.test(text), f);
  }
});
