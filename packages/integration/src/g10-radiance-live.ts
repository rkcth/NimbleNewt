import { createHash, randomBytes } from "node:crypto";
import { CacheAdapter, MarkerService, MemoryStorage, PrincipalService, ProjectService, deriveKey, profileFor, type CacheContext, type CacheOutcome, type CacheProfile, type CallResult, type EndpointConfig, type HttpRequest, type HttpResponse, type Principal, type Transport, type WireRequest } from "@nimblenewt/controller";
import type { RadianceKey } from "./g09-radiance-gate.js";

/**
 * Card G10, the Radiance clauses the first run left open: a retained-marker run kept apart from the cold and native runs, the cache-setting refusal fallback against a real server, and several conversations at
 * once. Everything here goes through the production code: `CacheAdapter` with the Radiance profile for every model call, and `MarkerService` (over the reference store) for the retained marker's registration,
 * resolution, outcome and loss. There is no second state machine in this file: it builds requests, sends them through the adapter, and writes down what came back.
 *
 * It is a library with no side effects of its own. The offline tests (g10-radiance-live.test.ts) run it against the scripted stand-in server of g09-radiance-fake.ts; the live run is g10-radiance-live-bench.ts,
 * by hand, outside CI. The key is only ever an Authorization header (via `RadianceKey`).
 */

export interface LiveEnv {
  readonly fetch: typeof globalThis.fetch;
  /** The server root without /v1. */
  readonly root: string;
  readonly key: RadianceKey;
  readonly model: string;
  readonly log: (line: string) => void;
  /** Waits; tests give one that does not wait. */
  readonly sleep: (ms: number) => Promise<void>;
  /** Milliseconds, for the wall time of a call. */
  readonly now: () => number;
}

export const realEnv = (fetchFn: typeof globalThis.fetch, root: string, key: RadianceKey, model: string, log: (line: string) => void): LiveEnv =>
  ({ fetch: fetchFn, root: root.replace(/\/+$/, ""), key, model, log: (l) => log(key.scrub(l)), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => performance.now() });

export const radianceConfig = (model: string): EndpointConfig => ({ kind: "radiance", model, options: { hostTier: true, hybrid: true } });
export const radianceProfile = (model: string): CacheProfile => profileFor(radianceConfig(model));

interface Timing { readonly wallMs: number; readonly clientTtftMs?: number }
/** Real HTTP through the given fetch, streamed so the time to the first token is the client's own. One transport per call in flight (it remembers the last call's timing). */
export class HttpTransport implements Transport {
  last: Timing | undefined;
  readonly #env: LiveEnv;
  readonly #maxTokens: number;
  constructor(env: LiveEnv, maxTokens: number) { this.#env = env; this.#maxTokens = maxTokens; }
  async send(request: HttpRequest): Promise<HttpResponse> {
    const env = this.#env;
    const body: WireRequest = { ...request.body, model: env.model, max_tokens: this.#maxTokens };
    delete body["max_completion_tokens"];
    const started = env.now();
    const res = await env.fetch(`${env.root}${request.path}`, { method: request.method, headers: { ...request.headers, ...env.key.header(), "content-type": "application/json" }, body: JSON.stringify(body) });
    if (body["stream"] !== true || res.status >= 400) {
      const text = await res.text();
      let parsed: unknown; try { parsed = JSON.parse(text); } catch { parsed = { error: { message: text.slice(0, 300) } }; }
      this.last = { wallMs: env.now() - started };
      return { status: res.status, body: parsed };
    }
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = ""; let content = ""; let finish: unknown; let usage: unknown; let timings: unknown; let first: number | undefined;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim(); buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        const e = JSON.parse(data) as { choices?: { delta?: { content?: string; reasoning_content?: string }; finish_reason?: string | null }[]; usage?: unknown; timings?: unknown };
        const d = e.choices?.[0]?.delta;
        if (first === undefined && ((typeof d?.content === "string" && d.content.length > 0) || (typeof d?.reasoning_content === "string" && d.reasoning_content.length > 0))) first = env.now() - started;
        if (typeof d?.content === "string") content += d.content;
        const fr = e.choices?.[0]?.finish_reason;
        if (fr !== undefined && fr !== null) finish = fr;
        if (e.usage !== undefined && e.usage !== null) usage = e.usage;
        if (e.timings !== undefined) timings = e.timings;
      }
    }
    this.last = { wallMs: env.now() - started, ...(first === undefined ? {} : { clientTtftMs: first }) };
    return { status: res.status, body: { object: "chat.completion", model: env.model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finish }], usage, timings } };
  }
}

// ---- Synthetic heads (the same shape G10's first run used) ----------------------------------------------------------------------------------------------------------------------------------------------
const TEAMS = ["Kestrel", "Heron", "Otter", "Lynx", "Marten", "Plover", "Wren", "Badger", "Ibis", "Stoat"];
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
export interface Head { readonly text: string; readonly code: string; readonly team: string; readonly nonce: string }
/** Synthetic ledger rules (about 33 tokens a line) with a code word in the middle and an on-call team in the second half. Nothing private. */
export function makeHead(lines: number): Head {
  const nonce = randomBytes(6).toString("hex");
  const code = `${["amber", "cobalt", "saffron", "violet", "jade"][randomBytes(1)[0]! % 5]}-${100 + (randomBytes(2).readUInt16BE(0) % 900)}`;
  const team = TEAMS[randomBytes(1)[0]! % TEAMS.length]!;
  const out = [`Run ${nonce}. You answer questions about the ledger rules below. Answer with the exact value only, no explanation.`];
  for (let i = 1; i <= lines; i++) {
    out.push(`Rule ${i}: entries in ledger section ${i} are reconciled every ${DAYS[i % 5]} by team ${TEAMS[(i * 7) % 10]}, with a tolerance of ${(i * 13) % 97} cents.`);
    if (i === Math.floor(lines / 2)) out.push(`Note: the vault code for this run is ${code}.`);
    if (i === Math.floor((lines * 3) / 4)) out.push(`Note: the on-call team for this run is ${team}.`);
  }
  return { text: out.join("\n"), code, team, nonce };
}
const QA = { role: "user", content: "What is the vault code for this run?" };
const QB = { role: "user", content: "Which team is on call for this run?" };
const BASE: WireRequest = { stream: true, stream_options: { include_usage: true }, chat_template_kwargs: { enable_thinking: false }, temperature: 0 };

export interface Step {
  readonly phase: string;
  readonly step: string;
  readonly status: number;
  readonly outcome: CacheOutcome;
  readonly applied: readonly string[];
  readonly promptTokens: number;
  readonly cachedTokens: number;
  readonly computedTokens: number;
  readonly expectedCachedTokens: number;
  readonly serverPromptMs?: number;
  readonly serverTtftMs?: number;
  readonly clientTtftMs?: number;
  readonly wallMs: number;
  readonly answer: string;
  readonly expected: string;
  readonly correct: boolean;
  readonly fallback?: { readonly reason: string; readonly refusedStatus: number; readonly removed: readonly string[] };
}
export interface Fixture { readonly name: string; readonly status: number; readonly body: unknown }

const statNames = ["version", "running", "waiting", "in_flight", "max_num_seqs", "kv_tokens_used", "kv_tokens_total", "kv_tokens_cached", "kv_bytes_used", "kv_bytes_total", "prefix_hit_rate", "prefix_evictions", "linear_hit_rate", "linear_cached_tokens", "checkpoints_written", "ckpt_evictions", "ckpt_refused", "hit_cuts", "total_requests", "prefill_tps", "decode_tps"] as const;
export async function readStats(env: LiveEnv): Promise<Record<string, unknown>> {
  try {
    const r = await env.fetch(`${env.root}/stats`, { headers: env.key.header() });
    const o = (await r.json()) as Record<string, unknown>;
    const cards = Array.isArray(o["cards"]) ? (o["cards"] as { index?: number; vram_used?: number; vram_total?: number }[]).map((c) => ({ index: c.index, vramUsed: c.vram_used, vramTotal: c.vram_total })) : undefined;
    return { at: new Date().toISOString(), ...Object.fromEntries(statNames.map((k) => [k, o[k]])), ...(cards === undefined ? {} : { cards }) };
  } catch (error) { return { at: new Date().toISOString(), error: env.key.scrub(error instanceof Error ? error.message : String(error)).slice(0, 120) }; }
}
/** What `/sessions` says about the conversations with these labels (their sizes and where they sit), nothing else. */
export async function readSessions(env: LiveEnv, labels: readonly string[]): Promise<unknown[]> {
  try {
    const r = await env.fetch(`${env.root}/sessions`, { headers: env.key.header() });
    const o = (await r.json()) as { sessions?: Record<string, unknown>[] };
    return (o.sessions ?? []).filter((s) => typeof s["label"] === "string" && labels.includes(s["label"] as string)).map((s) => Object.fromEntries(Object.entries(s).filter(([, v]) => typeof v === "number" || typeof v === "boolean" || typeof v === "string")));
  } catch { return []; }
}

interface Rig {
  readonly adapter: CacheAdapter;
  readonly transport: HttpTransport;
}
const rig = (env: LiveEnv, profile: CacheProfile, maxTokens = 24): Rig => { const transport = new HttpTransport(env, maxTokens); return { transport, adapter: new CacheAdapter(profile, transport) }; };

async function stepOf(env: LiveEnv, r: Rig, phase: string, step: string, messages: unknown[], expected: string, ctx: CacheContext, expectCached: number, fixtures: Fixture[] | undefined, keep: boolean): Promise<Step> {
  const res: CallResult = await r.adapter.call({ ...BASE, messages }, ctx, expectCached);
  const t = r.transport.last!;
  const b = res.body as { choices?: { message?: { content?: string } }[]; timings?: { prompt_ms?: number; ttft_ms?: number } } | undefined;
  const answer = (b?.choices?.[0]?.message?.content ?? "").trim();
  const s: Step = {
    phase, step, status: res.status, outcome: res.outcome, applied: res.applied, promptTokens: res.hit.promptTokens, cachedTokens: res.hit.cachedTokens, computedTokens: res.hit.computedTokens, expectedCachedTokens: expectCached,
    ...(typeof b?.timings?.prompt_ms === "number" ? { serverPromptMs: Math.round(b.timings.prompt_ms) } : {}), ...(typeof b?.timings?.ttft_ms === "number" ? { serverTtftMs: Math.round(b.timings.ttft_ms) } : {}),
    ...(t.clientTtftMs === undefined ? {} : { clientTtftMs: Math.round(t.clientTtftMs) }), wallMs: Math.round(t.wallMs), answer: answer.slice(0, 80), expected, correct: res.status < 400 && answer.toLowerCase().includes(expected.toLowerCase()),
    ...(res.fallback === undefined ? {} : { fallback: res.fallback }),
  };
  if (keep && fixtures !== undefined) fixtures.push({ name: `${phase}-${step}`, status: res.status, body: fixtureBody(res.body) });
  env.log(JSON.stringify(s));
  return s;
}

/** A response as kept in a fixture: the usage and timings the profile reads and the short answer; no id and nothing else the server added. A refusal keeps only its error. */
export function fixtureBody(body: unknown): unknown {
  const o = (body !== null && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (o["error"] !== undefined) { const e = o["error"] as Record<string, unknown>; return { error: { message: typeof e?.["message"] === "string" ? e["message"] : "", type: e?.["type"], param: e?.["param"], code: e?.["code"] } }; }
  const choice = (Array.isArray(o["choices"]) ? o["choices"][0] : undefined) as { message?: { content?: string }; finish_reason?: unknown } | undefined;
  return { object: "chat.completion", model: o["model"], choices: [{ index: 0, message: { role: "assistant", content: String(choice?.message?.content ?? "").slice(0, 80) }, finish_reason: choice?.finish_reason ?? null }], usage: o["usage"], timings: o["timings"] };
}

const keysFor = (secret: string, nonce: string): CacheContext => ({ scopeKey: deriveKey(secret, "scope", `g10l-${nonce}`), shareKey: deriveKey(secret, "share", `g10l-${nonce}`) });

// ---- (a) the retained-marker run ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export interface RetainedResult { readonly steps: Step[]; readonly markers: unknown[]; readonly sessions: unknown[]; readonly statsBefore: unknown; readonly statsAfter: unknown; readonly fixtures: Fixture[]; readonly checks: Record<string, boolean> }

async function openMarkers(): Promise<{ markers: MarkerService; owner: Principal; projectId: string; close(): Promise<void> }> {
  const storage = new MemoryStorage();
  const projects = await ProjectService.open(storage, { holder: "g10-live" });
  const principals = PrincipalService.withEpoch(storage, projects.epoch);
  const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
  const projectId = (await projects.createProject({ commandId: "g10-p", actor: "owner:rob", name: "G10 live" })).id;
  return { markers: MarkerService.withEpoch(storage, projects.epoch), owner, projectId, close: () => storage.close() };
}

/**
 * Cold, native and retained runs kept apart. Cold: a new head. Native: the same request again at once (no marker, nothing expected beyond "some"). Retained: after the native step the controller registers a
 * prefix marker for the tokens the server reported cached; after each idle gap (and an unrelated conversation in between) the marker is resolved and its token count is what the call expects. The outcome goes
 * back to the marker service; a miss marks the marker lost. Every answer is checked against the fact hidden in the head.
 */
export async function retainedRun(env: LiveEnv, options: { readonly gapsS: readonly number[]; readonly lines: number; readonly secret?: string }): Promise<RetainedResult> {
  const secret = options.secret ?? randomBytes(24).toString("hex");
  const profile = radianceProfile(env.model);
  const r = rig(env, profile);
  const m = await openMarkers();
  const steps: Step[] = []; const fixtures: Fixture[] = []; const markerLog: unknown[] = [];
  const route = `radiance/${env.model}`;
  const statsBefore = await readStats(env);
  try {
    const h = makeHead(options.lines);
    const ctx = keysFor(secret, h.nonce);
    const sys = { role: "system", content: h.text };
    const digest = createHash("sha256").update(h.text).digest("hex");
    const push = async (step: string, messages: unknown[], expected: string, expectCached: number, keep = false, context: CacheContext = ctx): Promise<Step> => { const s = await stepOf(env, r, step.startsWith("cold") || step.startsWith("native") ? "cold-native" : step.startsWith("retained") || step.startsWith("lost") ? "retained" : "other", step, messages, expected, context, expectCached, fixtures, keep); steps.push(s); return s; };
    const cold = await push("cold", [sys, QA], h.code, 0, true);
    const native = await push("native-repeat", [sys, QA], h.code, 1, true);
    const reusable = native.cachedTokens;
    const checks: Record<string, boolean> = {};
    checks["coldComputedEverything"] = cold.cachedTokens === 0;
    checks["nativeReuseServed"] = reusable > 0 && reusable % 2048 === 0;
    let markerId: string | undefined;
    if (reusable > 0) {
      const made = await m.markers.register(m.owner, { commandId: "g10-m1", projectId: m.projectId, route, endpoint: radianceConfig(env.model), kind: "prefix", digest, tokens: reusable });
      markerId = made.id;
    }
    let n = 0;
    for (const gap of options.gapsS) {
      if (markerId === undefined || markerLog.some((e) => (e as { outcome?: string }).outcome === "miss")) break;
      // An unrelated conversation uses the server in between (a different head, so nothing of it is shared), then the idle gap.
      const other = makeHead(Math.max(20, Math.floor(options.lines / 3)));
      await push(`other-${n}`, [{ role: "system", content: other.text }, QA], other.code, 0, false, keysFor(secret, other.nonce));
      if (gap > 0) await env.sleep(gap * 1000);
      const res = await m.markers.resolve(m.owner, { projectId: m.projectId, markerId, route });
      if (res.state !== "active") { markerLog.push({ gapS: gap, resolved: res.reason }); checks["markerStayedActive"] = false; break; }
      const question = n % 2 === 0 ? QA : QB; const expected = n % 2 === 0 ? h.code : h.team;
      const s = await push(`retained-after-${gap}s`, [sys, question], expected, res.expectedCachedTokens, true);
      await m.markers.recordOutcome(m.owner, { commandId: `g10-o-${n}`, projectId: m.projectId, markerId, outcome: s.outcome });
      const afterwards = s.outcome === "miss" ? await m.markers.resolve(m.owner, { projectId: m.projectId, markerId, route }) : undefined;
      markerLog.push({ gapS: gap, expectedCachedTokens: res.expectedCachedTokens, servedCachedTokens: s.cachedTokens, outcome: s.outcome, reusedAll: s.cachedTokens >= res.expectedCachedTokens, answerCorrect: s.correct, ...(afterwards === undefined ? {} : { markerAfter: afterwards.state === "unavailable" ? afterwards.reason : "active" }) });
      if (afterwards !== undefined) { checks["retentionMissMarkedLost"] = afterwards.state === "unavailable" && afterwards.reason === "lost"; checks["retentionMissAnsweredFromFullContext"] = s.correct; }
      n++;
    }
    // Switch latency: the first conversation, another conversation, and back (the switch-back is a retained step of the same marker).
    if (markerId !== undefined) {
      const res = await m.markers.resolve(m.owner, { projectId: m.projectId, markerId, route });
      if (res.state === "active") {
        const s = await push("retained-switch-back", [sys, QB], h.team, res.expectedCachedTokens, true);
        await m.markers.recordOutcome(m.owner, { commandId: "g10-o-switch", projectId: m.projectId, markerId, outcome: s.outcome });
        markerLog.push({ switchBack: true, expectedCachedTokens: res.expectedCachedTokens, servedCachedTokens: s.cachedTokens, outcome: s.outcome, answerCorrect: s.correct });
        }
    }
    // The miss: one word in front of the head. The marker's expectation is not met, the call still answers from its full context, and the marker is lost.
    if (markerId !== undefined) {
      const res = await m.markers.resolve(m.owner, { projectId: m.projectId, markerId, route });
      if (res.state === "active") {
        const changed = { role: "system", content: `Changed. ${h.text}` };
        const s = await push("lost-changed-head", [changed, QA], h.code, res.expectedCachedTokens, true);
        await m.markers.recordOutcome(m.owner, { commandId: "g10-o-miss", projectId: m.projectId, markerId, outcome: s.outcome, reason: "a hit was expected and none was served" });
        const after = await m.markers.resolve(m.owner, { projectId: m.projectId, markerId, route });
        markerLog.push({ changedHead: true, expectedCachedTokens: res.expectedCachedTokens, servedCachedTokens: s.cachedTokens, outcome: s.outcome, answerCorrect: s.correct, markerAfter: after.state === "unavailable" ? after.reason : "active" });
        checks["missMarkedLost"] = s.outcome === "miss" && after.state === "unavailable" && after.reason === "lost";
        checks["missStillAnsweredFromFullContext"] = s.correct;
      }
    }
    const retained = steps.filter((s) => s.phase === "retained" && s.step.startsWith("retained"));
    checks["retainedReusedAll"] = retained.length > 0 && retained.every((s) => s.outcome === "hit");
    checks["retentionMissObserved"] = retained.some((s) => s.outcome === "miss");
    checks["allAnswersCorrect"] = steps.every((s) => s.correct);
    const listed = markerId === undefined ? [] : await m.markers.list(m.owner, m.projectId);
    markerLog.push({ activeMarkersAtEnd: listed.map((x) => ({ kind: x.kind, tokens: x.tokens, hits: x.hits })) });
    const sessions = await readSessions(env, [ctx.shareKey!, ctx.scopeKey]);
    return { steps, markers: markerLog, sessions, statsBefore, statsAfter: await readStats(env), fixtures, checks };
  } finally { await m.close(); }
}

// ---- (b) the refusal fallback against a real server --------------------------------------------------------------------------------------------------------------------------------------------------------
export interface RefusalResult { readonly steps: Step[]; readonly refusal: { readonly status: number; readonly message: string }; readonly fixtures: Fixture[]; readonly checks: Record<string, boolean> }

/**
 * Radiance accepts every cache field the profile can send (session_id and the rest are ignored or kept as a label), so the server never refuses a real cache setting. What it does refuse is a setting it does
 * not implement (`logit_bias` other than `{}`: "unsupported_parameter") or mistype. The run therefore wraps the production Radiance profile so that one extra "cache" setting, `logit_bias`, is applied and named as
 * refused by its own error text; the production adapter then does what it does on any refusal (retry with every cache setting removed, same messages) against a real HTTP refusal and a real second answer.
 * A second real 400 that names no cache setting (`temperature` mistyped) shows the adapter returning it unchanged, with no retry.
 */
export function refusingProfile(model: string): CacheProfile {
  const base = radianceProfile(model);
  return {
    ...base,
    prepare: (request, ctx) => {
      const p = base.prepare(request, ctx);
      if (ctx.plain === true) return p;
      return { ...p, body: { ...p.body, logit_bias: { "50256": -1 } }, applied: [...p.applied, "logit_bias"] };
    },
    refusedCacheSetting: (f) => (f.status === 400 || f.status === 422) && /\blogit_bias\b/.test(f.message.toLowerCase()),
  };
}

export async function refusalRun(env: LiveEnv, options: { readonly lines: number; readonly secret?: string }): Promise<RefusalResult> {
  const secret = options.secret ?? randomBytes(24).toString("hex");
  const steps: Step[] = []; const fixtures: Fixture[] = []; const checks: Record<string, boolean> = {};
  const h = makeHead(options.lines);
  const ctx = keysFor(secret, h.nonce);
  const sys = { role: "system", content: h.text };
  const production = rig(env, radianceProfile(env.model));
  const refusing = rig(env, refusingProfile(env.model));
  steps.push(await stepOf(env, production, "refusal", "warm-cold", [sys, QA], h.code, ctx, 0, fixtures, true));
  const warm = await stepOf(env, production, "refusal", "warm-native", [sys, QA], h.code, ctx, 1, fixtures, true);
  steps.push(warm);
  // The refused call: the server's own 400 is read straight from the transport as well, so the refusal itself is kept as it was sent.
  const direct = new HttpTransport(env, 24);
  const probeBody = refusingProfile(env.model).prepare({ ...BASE, stream: false, messages: [sys, QA] }, ctx).body;
  const refused = await direct.send({ method: "POST", path: "/v1/chat/completions", headers: {}, body: probeBody });
  const message = ((refused.body as { error?: { message?: string } }).error?.message ?? "").slice(0, 300);
  fixtures.push({ name: "refusal-logit_bias", status: refused.status, body: fixtureBody(refused.body) });
  checks["serverRefusedTheSetting"] = refused.status === 400 && /logit_bias/.test(message);
  const fb = await stepOf(env, refusing, "refusal", "fallback-served", [sys, QA], h.code, ctx, warm.cachedTokens, fixtures, true);
  steps.push(fb);
  checks["fallbackRecorded"] = fb.fallback !== undefined && fb.fallback.refusedStatus === 400 && fb.fallback.removed.includes("logit_bias");
  checks["fallbackAnsweredFromFullContext"] = fb.status === 200 && fb.correct;
  checks["fallbackStillReusedTheHead"] = fb.cachedTokens > 0;
  // A different question with the refused setting still in play: the adapter goes through the same path again (nothing is remembered about a refusal, so each call pays one extra round trip).
  const fb2 = await stepOf(env, refusing, "refusal", "fallback-second-question", [sys, QB], h.team, ctx, warm.cachedTokens, fixtures, true);
  steps.push(fb2);
  checks["fallbackRepeatsPerCall"] = fb2.fallback !== undefined && fb2.correct;
  // A real 400 that names no cache setting is not retried.
  const mistyped = new HttpTransport(env, 24);
  const typedAdapter = new CacheAdapter(radianceProfile(env.model), mistyped);
  const other = await typedAdapter.call({ ...BASE, stream: false, temperature: "hot", messages: [sys, QA] }, ctx, 0);
  fixtures.push({ name: "refusal-other-400", status: other.status, body: fixtureBody(other.body) });
  checks["otherRefusalReturnedUnchanged"] = other.status === 400 && other.fallback === undefined && other.outcome === "unknown";
  steps.push({ phase: "refusal", step: "other-400-temperature", status: other.status, outcome: other.outcome, applied: other.applied, promptTokens: 0, cachedTokens: 0, computedTokens: 0, expectedCachedTokens: 0, wallMs: Math.round(mistyped.last?.wallMs ?? 0), answer: "", expected: "", correct: false });
  return { steps, refusal: { status: refused.status, message }, fixtures, checks };
}

// ---- (c) concurrency -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export interface LevelResult {
  readonly streams: number;
  readonly cold: readonly Step[];
  readonly repeat: readonly Step[];
  readonly coldWallMs: number;
  readonly repeatWallMs: number;
  readonly statsBefore: unknown;
  readonly statsAfter: unknown;
  /** The most the server reported running and waiting at once while this level's calls were in flight (sampled; it includes other clients). */
  readonly peak: { readonly running: number; readonly waiting: number };
  readonly sessions: readonly unknown[];
}
export interface ConcurrencyResult { readonly levels: LevelResult[]; readonly afterLoad?: readonly Step[]; readonly fixtures: Fixture[]; readonly checks: Record<string, boolean> }

async function sampled<T>(env: LiveEnv, work: () => Promise<T>): Promise<{ value: T; peak: { running: number; waiting: number } }> {
  const peak = { running: 0, waiting: 0 };
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      const s = await readStats(env);
      if (typeof s["running"] === "number") peak.running = Math.max(peak.running, s["running"]);
      if (typeof s["waiting"] === "number") peak.waiting = Math.max(peak.waiting, s["waiting"]);
      await env.sleep(750);
    }
  })();
  try { return { value: await work(), peak }; } finally { stop = true; await loop; }
}

/** N conversations at once, each with its own head: all cold together, then all repeated together (each expecting the reuse the server reported on its own cold... none, then "some"). Then the first level's conversations again after the heavier levels. */
export async function concurrencyRun(env: LiveEnv, options: { readonly levels: readonly number[]; readonly lines: number; readonly secret?: string }): Promise<ConcurrencyResult> {
  const secret = options.secret ?? randomBytes(24).toString("hex");
  const profile = radianceProfile(env.model);
  const fixtures: Fixture[] = []; const levels: LevelResult[] = []; const checks: Record<string, boolean> = {};
  let first: { head: Head; ctx: CacheContext; cached: number } | undefined;
  for (const n of options.levels) {
    if (!Number.isSafeInteger(n) || n < 1 || n > 8) throw new Error("a level is 1 to 8 streams (the Flash-Next recipe's max-num-seqs)");
    const heads = Array.from({ length: n }, () => makeHead(options.lines));
    const ctxs = heads.map((h) => keysFor(secret, h.nonce));
    const rigs = heads.map(() => rig(env, profile));
    const statsBefore = await readStats(env);
    const round = async (step: string, expectFor: (i: number) => number): Promise<{ steps: Step[]; wallMs: number; peak: { running: number; waiting: number } }> => {
      const t0 = env.now();
      const { value, peak } = await sampled(env, () => Promise.all(heads.map((h, i) => stepOf(env, rigs[i]!, `concurrency-${n}`, `${step}-${i}`, [{ role: "system", content: h.text }, QA], h.code, ctxs[i]!, expectFor(i), fixtures, n === options.levels[options.levels.length - 1] && i === 0))));
      return { steps: value, wallMs: Math.round(env.now() - t0), peak };
    };
    const cold = await round("cold", () => 0);
    const repeat = await round("repeat", () => 1);
    const sessions = await readSessions(env, ctxs.flatMap((c) => [c.shareKey!, c.scopeKey]));
    levels.push({ streams: n, cold: cold.steps, repeat: repeat.steps, coldWallMs: cold.wallMs, repeatWallMs: repeat.wallMs, statsBefore, statsAfter: await readStats(env), peak: { running: Math.max(cold.peak.running, repeat.peak.running), waiting: Math.max(cold.peak.waiting, repeat.peak.waiting) }, sessions });
    if (first === undefined) first = { head: heads[0]!, ctx: ctxs[0]!, cached: repeat.steps[0]!.cachedTokens };
  }
  let afterLoad: Step[] | undefined;
  if (first !== undefined && levels.length > 1) {
    const r = rig(env, profile);
    afterLoad = [await stepOf(env, r, "concurrency-after-load", "first-conversation-again", [{ role: "system", content: first.head.text }, QA], first.head.code, first.ctx, Math.max(1, first.cached), fixtures, true)];
  }
  const all = levels.flatMap((l) => [...l.cold, ...l.repeat]);
  checks["allAnswersCorrectUnderLoad"] = all.every((s) => s.correct);
  checks["everyRepeatReusedSomething"] = levels.every((l) => l.repeat.every((s) => s.cachedTokens > 0));
  checks["everyColdComputedEverything"] = levels.every((l) => l.cold.every((s) => s.cachedTokens === 0));
  return { levels, ...(afterLoad === undefined ? {} : { afterLoad }), fixtures, checks };
}
