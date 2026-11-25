import { randomBytes } from "node:crypto";

/**
 * Card G10, the other engines: the measurements the Radiance runs made (g10-radiance-live.ts), adapted to llama.cpp's `llama-server` and to vLLM. Both speak the OpenAI-compatible
 * `/v1/chat/completions`; they differ in what they say about their cache:
 *
 *   llama.cpp: `timings.cache_n` (prompt tokens taken from the cache) and `timings.prompt_n` (prompt tokens computed), `/metrics` (with `--metrics`), `-np` slots, `id_slot`, `cache_prompt`,
 *              `--cache-reuse`, slot save and restore (with `--slot-save-path`).
 *   vLLM:      `usage.prompt_tokens_details.cached_tokens` (with `--enable-prompt-tokens-details`), `/metrics` prefix-cache hit and query counters, `cache_salt` (isolation).
 *
 * This file is a library with no side effects. The offline tests (g10-engines-live.test.ts) run it against scripted stand-in servers; the live run is g10-engines-live-bench.ts, by hand, outside CI.
 * It never sends anything but the synthetic ledger text below, and the evidence holds only usage, timing and counter fields plus a correct/incorrect flag (no prompt or answer text).
 * No credential is needed or handled: the servers are reached on a tunnel or proxy address the operator gives, and nothing here adds an Authorization header.
 */

export type EngineKind = "llamacpp" | "vllm";

export interface EngineEnv {
  readonly fetch: typeof globalThis.fetch;
  /** The server root without /v1. */
  readonly root: string;
  readonly kind: EngineKind;
  readonly model: string;
  readonly log: (line: string) => void;
  /** Waits; tests give one that does not wait. */
  readonly sleep: (ms: number) => Promise<void>;
  /** Milliseconds, for the wall time of a call. */
  readonly now: () => number;
}

export const realEngineEnv = (kind: EngineKind, fetchFn: typeof globalThis.fetch, root: string, model: string, log: (line: string) => void): EngineEnv =>
  ({ fetch: fetchFn, root: root.replace(/\/+$/, ""), kind, model, log, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => performance.now() });

// ---- Synthetic heads (the same shape the Radiance runs used) ---------------------------------------------------------------------------------------------------------------------------------------
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
const QUESTIONS = [
  { ask: "What is the vault code for this run?", pick: (h: Head) => h.code },
  { ask: "Which team is on call for this run?", pick: (h: Head) => h.team },
] as const;

// ---- One request and what the engine says about its cache -----------------------------------------------------------------------------------------------------------------------------------------
export interface Step {
  readonly phase: string;
  readonly step: string;
  readonly status: number;
  /** Prompt tokens as the engine counted them (0 when it did not say). */
  readonly promptTokens: number;
  /** Tokens served from cache; undefined when the engine did not report it for this call (see `reported`). */
  readonly cachedTokens?: number;
  /** Tokens computed; for llama.cpp `timings.prompt_n`, otherwise prompt minus cached. */
  readonly computedTokens?: number;
  readonly reported: boolean;
  /** cached / prompt, when both are known. */
  readonly reusedFraction?: number;
  readonly serverPromptMs?: number;
  readonly clientTtftMs?: number;
  readonly wallMs: number;
  readonly correct: boolean;
  readonly error?: string;
  /** Counter movement over this one call, when the call ran alone (serial phases only). */
  readonly metricsDelta?: Record<string, number>;
}
export interface Fixture { readonly name: string; readonly status: number; readonly body: unknown }

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Reads the cache figures from a completed chat-completion body, per engine. Pure. */
export function readCache(kind: EngineKind, body: unknown): { promptTokens: number; cachedTokens?: number; computedTokens?: number; serverPromptMs?: number; reported: boolean } {
  const o = (typeof body === "object" && body !== null ? body : {}) as { usage?: { prompt_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown } | null }; timings?: { cache_n?: unknown; prompt_n?: unknown; prompt_ms?: unknown } };
  const promptTokens = num(o.usage?.prompt_tokens) ?? (num(o.timings?.cache_n) !== undefined && num(o.timings?.prompt_n) !== undefined ? num(o.timings?.cache_n)! + num(o.timings?.prompt_n)! : 0);
  if (kind === "llamacpp") {
    const cached = num(o.timings?.cache_n); const computed = num(o.timings?.prompt_n); const ms = num(o.timings?.prompt_ms);
    return { promptTokens, ...(cached === undefined ? {} : { cachedTokens: cached }), ...(computed === undefined ? {} : { computedTokens: computed }), ...(ms === undefined ? {} : { serverPromptMs: ms }), reported: cached !== undefined };
  }
  const cached = num(o.usage?.prompt_tokens_details?.cached_tokens);
  return { promptTokens, ...(cached === undefined ? {} : { cachedTokens: cached, computedTokens: Math.max(0, promptTokens - cached) }), reported: cached !== undefined };
}

/** The counters worth keeping from a Prometheus text, by name; labels of `cache_config_info` are kept as one string. Pure. */
const KEEP = /^(llamacpp:(prompt_tokens_total|prompt_seconds_total|tokens_predicted_total|requests_processing|requests_deferred|kv_cache_usage_ratio|kv_cache_tokens)|vllm:(prefix_cache_hits_total|prefix_cache_queries_total|gpu_prefix_cache_hits_total|gpu_prefix_cache_queries_total|external_prefix_cache_hits_total|kv_cache_usage_perc|gpu_cache_usage_perc|num_requests_running|num_requests_waiting|num_preemptions_total))\b/;
export function parseMetrics(text: string): { counters: Record<string, number>; cacheConfig?: string } {
  const counters: Record<string, number> = {}; let cacheConfig: string | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("vllm:cache_config_info")) { const m = /\{([^}]*)\}/.exec(line); if (m) cacheConfig = m[1]!.split(",").filter((p) => /^(block_size|num_gpu_blocks|gpu_memory_utilization|enable_prefix_caching|cache_dtype)=/.test(p.trim())).join(",").slice(0, 200); continue; }
    const m = /^([A-Za-z_:][A-Za-z0-9_:]*)(\{[^}]*\})?\s+(-?[0-9.eE+-]+|NaN|\+Inf)$/.exec(line);
    if (!m || !KEEP.test(m[1]!)) continue;
    const v = Number(m[3]);
    if (Number.isFinite(v)) counters[m[1]!] = (counters[m[1]!] ?? 0) + v;
  }
  return { counters, ...(cacheConfig === undefined ? {} : { cacheConfig }) };
}
export async function readMetrics(env: EngineEnv): Promise<{ at: string; counters: Record<string, number>; cacheConfig?: string } | { at: string; error: string }> {
  try {
    const r = await env.fetch(`${env.root}/metrics`);
    if (r.status !== 200) return { at: new Date().toISOString(), error: `status ${r.status}` };
    return { at: new Date().toISOString(), ...parseMetrics(await r.text()) };
  } catch (error) { return { at: new Date().toISOString(), error: (error instanceof Error ? error.message : String(error)).slice(0, 120) }; }
}
const delta = (a: Awaited<ReturnType<typeof readMetrics>>, b: Awaited<ReturnType<typeof readMetrics>>): Record<string, number> | undefined => {
  if (!("counters" in a) || !("counters" in b)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(b.counters)) if (/_total$/.test(k) && v !== (a.counters[k] ?? 0)) out[k] = v - (a.counters[k] ?? 0);
  return out;
};
/** llama.cpp's `/props` and `/slots`: the slot count and context size only. */
export async function readEngineInfo(env: EngineEnv): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { at: new Date().toISOString(), kind: env.kind };
  try {
    if (env.kind === "llamacpp") {
      const props = (await (await env.fetch(`${env.root}/props`)).json()) as { total_slots?: unknown; default_generation_settings?: { n_ctx?: unknown } };
      out["totalSlots"] = props.total_slots; out["nCtxPerSlot"] = props.default_generation_settings?.n_ctx;
      const slots = (await (await env.fetch(`${env.root}/slots`)).json()) as { id?: unknown; n_ctx?: unknown; is_processing?: unknown }[];
      if (Array.isArray(slots)) out["slots"] = slots.map((s) => ({ id: s.id, nCtx: s.n_ctx, busy: s.is_processing }));
    } else {
      const models = (await (await env.fetch(`${env.root}/v1/models`)).json()) as { data?: { max_model_len?: unknown }[] };
      out["maxModelLen"] = models.data?.[0]?.max_model_len;
    }
  } catch (error) { out["error"] = (error instanceof Error ? error.message : String(error)).slice(0, 120); }
  return out;
}

export interface SendOptions { readonly extra?: Record<string, unknown>; readonly maxTokens?: number; readonly noMetrics?: boolean }
interface Sent { readonly step: Step; readonly raw: { status: number; body: unknown } }

/** One streamed chat completion (so the time to the first token is this client's own), read per engine. The answer is judged and dropped. */
export async function send(env: EngineEnv, phase: string, step: string, head: Head, q: number, options: SendOptions = {}): Promise<Sent> {
  const question = QUESTIONS[q % QUESTIONS.length]!;
  const expected = question.pick(head);
  const body: Record<string, unknown> = {
    model: env.model, stream: true, stream_options: { include_usage: true }, temperature: 0, max_tokens: options.maxTokens ?? 24,
    chat_template_kwargs: { enable_thinking: false },
    messages: [{ role: "system", content: head.text }, { role: "user", content: question.ask }],
    ...(options.extra ?? {}),
  };
  const before = options.noMetrics === true ? undefined : await readMetrics(env);
  const started = env.now();
  let status = 0; let content = ""; let usage: unknown; let timings: unknown; let first: number | undefined; let error: string | undefined; let errorBody: unknown;
  try {
    const res = await env.fetch(`${env.root}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    status = res.status;
    if (res.status >= 400 || res.body === null) {
      const text = await res.text();
      try { errorBody = JSON.parse(text); } catch { errorBody = { error: { message: text.slice(0, 300) } }; }
      error = errorMessage(errorBody);
    } else {
      const reader = res.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
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
          const e = JSON.parse(data) as { choices?: { delta?: { content?: string; reasoning_content?: string } }[]; usage?: unknown; timings?: unknown };
          const d = e.choices?.[0]?.delta;
          if (first === undefined && ((typeof d?.content === "string" && d.content.length > 0) || (typeof d?.reasoning_content === "string" && d.reasoning_content.length > 0))) first = env.now() - started;
          if (typeof d?.content === "string") content += d.content;
          if (e.usage !== undefined && e.usage !== null) usage = e.usage;
          if (e.timings !== undefined && e.timings !== null) timings = e.timings;
        }
      }
    }
  } catch (e) { error = (e instanceof Error ? e.message : String(e)).slice(0, 160); }
  const wallMs = env.now() - started;
  const after = before === undefined ? undefined : await readMetrics(env);
  const completion = { usage, timings };
  const cache = status === 200 ? readCache(env.kind, completion) : { promptTokens: 0, reported: false };
  const md = before !== undefined && after !== undefined ? delta(before, after) : undefined;
  const s: Step = {
    phase, step, status, promptTokens: cache.promptTokens,
    ...("cachedTokens" in cache && cache.cachedTokens !== undefined ? { cachedTokens: cache.cachedTokens } : {}),
    ...("computedTokens" in cache && cache.computedTokens !== undefined ? { computedTokens: cache.computedTokens } : {}),
    reported: cache.reported,
    ...("cachedTokens" in cache && cache.cachedTokens !== undefined && cache.promptTokens > 0 ? { reusedFraction: Math.round((cache.cachedTokens / cache.promptTokens) * 1000) / 1000 } : {}),
    ...("serverPromptMs" in cache && cache.serverPromptMs !== undefined ? { serverPromptMs: Math.round(cache.serverPromptMs) } : {}),
    ...(first === undefined ? {} : { clientTtftMs: Math.round(first) }), wallMs: Math.round(wallMs),
    correct: status === 200 && content.toLowerCase().includes(expected.toLowerCase()),
    ...(error === undefined ? {} : { error }),
    ...(md === undefined || Object.keys(md).length === 0 ? {} : { metricsDelta: md }),
  };
  env.log(`${phase}/${step}: status ${s.status} prompt ${s.promptTokens} cached ${s.cachedTokens ?? "?"} ttft ${s.clientTtftMs ?? "-"} ms wall ${s.wallMs} ms${s.correct ? "" : " (answer not as expected)"}`);
  const raw = status === 200 ? { status, body: { object: "chat.completion", model: env.model, usage, timings } } : { status, body: errorBody ?? { error: { message: error ?? "" } } };
  return { step: s, raw };
}
function errorMessage(body: unknown): string {
  const o = body as { error?: { message?: unknown } | string; message?: unknown };
  const m = typeof o.error === "string" ? o.error : typeof o.error?.message === "string" ? o.error.message : typeof o.message === "string" ? o.message : "";
  return m.slice(0, 160);
}

const reuse = (s: Step): number => s.reusedFraction ?? 0;
/** What counts as the head being reused: at least half of the prompt came from cache. */
export const REUSED = 0.5;
const fixtureOf = (name: string, r: Sent): Fixture => ({ name, status: r.raw.status, body: r.raw.body });
export interface PhaseResult { readonly steps: Step[]; readonly checks: Record<string, boolean>; readonly fixtures: Fixture[]; readonly notes: Record<string, unknown> }

// ---- S: a shared head across conversations -------------------------------------------------------------------------------------------------------------------------------------------------------
/** A cold head, the same head in a second and a third conversation (different questions), and an unrelated head as control. */
export async function sharedRun(env: EngineEnv, opts: { lines: number }): Promise<PhaseResult> {
  const head = makeHead(opts.lines); const other = makeHead(opts.lines);
  const steps: Step[] = []; const fixtures: Fixture[] = [];
  const run = async (step: string, h: Head, q: number, fixture?: string): Promise<Step> => { const r = await send(env, "shared", step, h, q); steps.push(r.step); if (fixture !== undefined) fixtures.push(fixtureOf(fixture, r)); return r.step; };
  const cold = await run("cold", head, 0, `${env.kind}-cold`);
  const second = await run("second-conversation", head, 1, `${env.kind}-shared-hit`);
  const third = await run("third-conversation", head, 0);
  const control = await run("unrelated-head", other, 0);
  const checks = {
    coldComputedMostOfIt: cold.reported && reuse(cold) < 0.1,
    cacheFiguresReported: steps.every((s) => s.reported),
    secondConversationReusedHead: reuse(second) >= REUSED,
    thirdConversationReusedHead: reuse(third) >= REUSED,
    unrelatedHeadNotReused: reuse(control) < 0.1,
    allAnswersCorrect: steps.every((s) => s.correct),
  };
  return { steps, checks, fixtures, notes: {} };
}

// ---- I: idle gaps --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
/** For each gap a fresh head is read once, left alone for the gap (this client sends nothing meanwhile), then asked again in a new conversation. */
export async function idleRun(env: EngineEnv, opts: { gapsS: readonly number[]; lines: number }): Promise<PhaseResult> {
  const steps: Step[] = []; const checks: Record<string, boolean> = {};
  let allCorrect = true;
  for (const g of opts.gapsS) {
    const head = makeHead(opts.lines);
    const warm = await send(env, "idle", `warm-for-${g}s`, head, 0); steps.push(warm.step);
    if (g > 0) await env.sleep(g * 1000);
    const again = await send(env, "idle", `after-${g}s`, head, 1); steps.push(again.step);
    checks[`reusedAfter${g}s`] = reuse(again.step) >= REUSED;
    allCorrect &&= warm.step.correct && again.step.correct;
  }
  checks["allAnswersCorrect"] = allCorrect;
  return { steps, checks, fixtures: [], notes: { gapsS: [...opts.gapsS] } };
}

// ---- E: eviction by other conversations (the cliff) -----------------------------------------------------------------------------------------------------------------------------------------
/**
 * One head is read, then distinct heads of the same size are read until `levels[i]` others have been read in total; after each level the first head is asked again. `cliffAtOtherHeads` is the
 * first cumulative level at which less than half of it came from cache (undefined: not reached within `levels`); the ladder stops there. Every probe, hit or miss, reads the head again, so what
 * pushed it out is the number of OTHER heads read since its last use (the previous probe): `cliffOtherHeadsSinceLastUse` (level minus the previous level), and `lastKeptOtherHeadsSinceLastUse` for
 * the last probe that still hit.
 */
export async function evictionRun(env: EngineEnv, opts: { lines: number; levels: readonly number[] }): Promise<PhaseResult> {
  const steps: Step[] = []; const base = makeHead(opts.lines);
  const first = await send(env, "eviction", "warm-first-head", base, 0); steps.push(first.step);
  let inserted = 0; let cliffAt: number | undefined; let prompt = first.step.promptTokens;
  let lastUsedAt = 0; let cliffSince: number | undefined; let keptSince: number | undefined;
  for (const level of opts.levels) {
    while (inserted < level) { inserted += 1; const r = await send(env, "eviction", `other-head-${inserted}`, makeHead(opts.lines), 0, { noMetrics: true }); steps.push(r.step); prompt = Math.max(prompt, r.step.promptTokens); }
    const probe = await send(env, "eviction", `first-head-after-${level}-others`, base, 1); steps.push(probe.step);
    const since = inserted - lastUsedAt; lastUsedAt = inserted;
    if (reuse(probe.step) < REUSED) { cliffAt = level; cliffSince = since; break; }
    keptSince = since;
  }
  const probes = steps.filter((s) => s.step.startsWith("first-head-after-"));
  const checks = { firstHeadWasWarm: probes.length > 0 && probes[0] !== undefined && (reuse(probes[0]) >= REUSED || cliffAt === opts.levels[0]), allAnswersCorrect: steps.every((s) => s.correct) };
  return { steps, checks, fixtures: [], notes: { levels: [...opts.levels], cliffReached: cliffAt !== undefined, ...(cliffAt === undefined ? {} : { cliffAtOtherHeads: cliffAt, cliffOtherHeadsSinceLastUse: cliffSince }), ...(keptSince === undefined ? {} : { lastKeptOtherHeadsSinceLastUse: keptSince }), tokensPerHeadAbout: prompt, otherTokensInsertedAtEnd: inserted * prompt } };
}

// ---- C: concurrency ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export interface LevelResult { readonly level: number; readonly warm: readonly Step[]; readonly cold: readonly Step[]; readonly warmWallMs: number; readonly coldWallMs: number; readonly warmReusedCount: number; readonly coldReusedCount: number }
/** For each level n: n conversations at once on a head already read (all should reuse it), then n at once on a brand-new head (how many share the first computation). */
export async function concurrencyRun(env: EngineEnv, opts: { levels: readonly number[]; lines: number }): Promise<PhaseResult & { levels: LevelResult[] }> {
  const levels: LevelResult[] = []; const steps: Step[] = [];
  for (const n of opts.levels) {
    const head = makeHead(opts.lines);
    const prime = await send(env, "concurrency", `n${n}-prime`, head, 0, { noMetrics: true }); steps.push(prime.step);
    const t0 = env.now();
    const warm = await Promise.all(Array.from({ length: n }, (_, i) => send(env, "concurrency", `n${n}-warm-${i + 1}`, head, i + 1, { noMetrics: true })));
    const warmWallMs = Math.round(env.now() - t0);
    const fresh = makeHead(opts.lines);
    const t1 = env.now();
    const cold = await Promise.all(Array.from({ length: n }, (_, i) => send(env, "concurrency", `n${n}-cold-${i + 1}`, fresh, i, { noMetrics: true })));
    const coldWallMs = Math.round(env.now() - t1);
    const w = warm.map((r) => r.step); const c = cold.map((r) => r.step);
    steps.push(...w, ...c);
    levels.push({ level: n, warm: w, cold: c, warmWallMs, coldWallMs, warmReusedCount: w.filter((s) => reuse(s) >= REUSED).length, coldReusedCount: c.filter((s) => reuse(s) >= REUSED).length });
  }
  const checks = {
    everyWarmRequestReusedTheHead: levels.every((l) => l.warmReusedCount === l.level),
    allAnswersCorrectUnderLoad: steps.every((s) => s.correct),
    noRequestRefused: steps.every((s) => s.status === 200),
  };
  return { steps, checks, fixtures: [], notes: { levels: [...opts.levels] }, levels };
}

// ---- X: what only one engine has ------------------------------------------------------------------------------------------------------------------------------------------------------------------
/** Cache-setting probes of each engine: whether the setting is honoured, refused or ignored, and the plain retry without it. */
export async function extrasRun(env: EngineEnv, opts: { lines: number; saveFile?: string }): Promise<PhaseResult> {
  const steps: Step[] = []; const checks: Record<string, boolean> = {}; const notes: Record<string, unknown> = {};
  const add = async (step: string, head: Head, q: number, extra?: Record<string, unknown>): Promise<Step> => { const r = await send(env, "extras", step, head, q, extra === undefined ? {} : { extra }); steps.push(r.step); return r.step; };
  // A setting no engine knows: refused or ignored, and the plain request works (the fallback path).
  const head = makeHead(opts.lines);
  await add("warm", head, 0);
  const unknown = await add("unknown-cache-setting", head, 1, { nn_unknown_cache_setting: true });
  notes["unknownCacheSetting"] = unknown.status >= 400 ? { outcome: "refused", status: unknown.status, message: unknown.error ?? "" } : { outcome: "ignored", status: unknown.status };
  const plain = await add("retry-without-setting", head, 0);
  checks["plainRetryAnswered"] = plain.status === 200 && plain.correct;
  if (env.kind === "llamacpp") {
    const slotHead = makeHead(opts.lines);
    await add("slot0-warm", slotHead, 0, { id_slot: 0, cache_prompt: true });
    const same = await add("slot0-again", slotHead, 1, { id_slot: 0, cache_prompt: true });
    const other = await add("slot1-same-head", slotHead, 0, { id_slot: 1, cache_prompt: true });
    const off = await add("cache-prompt-off", slotHead, 1, { id_slot: 0, cache_prompt: false });
    checks["sameSlotReused"] = reuse(same) >= REUSED;
    checks["cachePromptFalseComputedAll"] = off.status === 200 && off.reported && reuse(off) < 0.1;
    notes["otherSlotReusedHead"] = other.status === 200 ? reuse(other) >= REUSED : "refused";
    // Slot save and restore (needs --slot-save-path): save slot 0, erase it, restore it, ask again.
    const file = opts.saveFile ?? `nn-g10-${randomBytes(3).toString("hex")}.bin`;
    const call = async (action: string, body: unknown): Promise<number> => { try { const r = await env.fetch(`${env.root}/slots/0?action=${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); await r.text(); return r.status; } catch { return 0; } };
    const saved = await call("save", { filename: file });
    if (saved === 200) {
      const erased = await call("erase", {});
      const probeCold = await add("slot0-after-erase", slotHead, 0, { id_slot: 0, cache_prompt: true });
      const restored = await call("restore", { filename: file });
      const afterRestore = await add("slot0-after-restore", slotHead, 1, { id_slot: 0, cache_prompt: true });
      notes["slotSaveRestore"] = { saveStatus: saved, eraseStatus: erased, restoreStatus: restored, afterEraseReusedFraction: probeCold.reusedFraction ?? null, afterRestoreReusedFraction: afterRestore.reusedFraction ?? null };
      // Two separate answers: did the erase really remove the head (a server with a host-memory prompt cache can still serve it), and did the restore give it back.
      checks["eraseRemovedTheHead"] = reuse(probeCold) < REUSED;
      checks["restoreGaveTheHeadBack"] = restored === 200 && reuse(afterRestore) >= REUSED;
    } else notes["slotSaveRestore"] = { saveStatus: saved, outcome: "not available (the server needs --slot-save-path)" };
  } else {
    // vLLM: cache_salt partitions the prefix cache (isolation): the same head under another salt, and with no salt, must be computed again.
    // The salts are new for every run, so no earlier run's blocks can be found under them.
    const salted = makeHead(opts.lines); const saltA = `nn-a-${randomBytes(6).toString("hex")}`; const saltB = `nn-b-${randomBytes(6).toString("hex")}`;
    await add("salt-a-warm", salted, 0, { cache_salt: saltA });
    const sameSalt = await add("salt-a-again", salted, 1, { cache_salt: saltA });
    const otherSalt = await add("salt-b-same-head", salted, 0, { cache_salt: saltB });
    const noSalt = await add("no-salt-same-head", salted, 1);
    if (sameSalt.status === 200 && otherSalt.status === 200) {
      checks["sameSaltReused"] = reuse(sameSalt) >= REUSED;
      checks["otherSaltDidNotReuse"] = reuse(otherSalt) < 0.1;
      checks["noSaltDidNotReuse"] = reuse(noSalt) < 0.1;
    } else notes["cacheSalt"] = { outcome: "refused", status: otherSalt.status === 200 ? sameSalt.status : otherSalt.status, message: (sameSalt.error ?? otherSalt.error ?? "") };
  }
  checks["allAnswersCorrect"] = steps.filter((s) => s.status === 200).every((s) => s.correct);
  return { steps, checks, fixtures: [], notes };
}
