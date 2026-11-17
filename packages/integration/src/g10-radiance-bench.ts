import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CacheAdapter, deriveKey, profileFor, type CacheContext, type HttpRequest, type HttpResponse, type Transport, type WireRequest } from "@nimblenewt/controller";
import { cachedShare, computed, run, type Backend } from "./c06b-scenario.js";

/**
 * Card G10: a measured run against a real Radiance server. Not a test (the offline guard blocks the network in tests) and never run by CI: the owner or an agent runs it by hand, one request at a time,
 * against a server that is already running. It never loads, unloads or switches a model, never calls a cache reset, and sends nothing a client of the server would not.
 *
 *   node packages/integration/dist/g10-radiance-bench.js --out /path/results.json [--repeats 3] [--idle 90] [--url http://127.0.0.1:8002] [--model qwen3.8-flash-next-iq4r]
 *
 * The API key is read from Pi's own configuration (~/.pi/agent/models.json, provider `radiance`) or from the file named by G10_RADIANCE_KEY_FILE (one line), and is only ever put in the Authorization header.
 *
 * Part A goes through the production `CacheAdapter` with the Radiance profile (C06): cold, repeated (native reuse), a second conversation on the same head (fork), a switch back to the first conversation, the
 * same head without the session label, a changed head (the miss and its full-context fallback), and the first conversation again after an idle wait. Each prompt holds facts the model is asked to repeat, so
 * the answer shows whether the reused state still gives the same context. Part B runs C06b's two-agent conversation (c06b-scenario.ts) against the server with the NimbleNewt and the naive layout.
 */

const arg = (name: string, fallback: string): string => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback; };
const BASE = arg("url", "http://127.0.0.1:8002").replace(/\/+$/, "");
const MODEL = arg("model", "qwen3.8-flash-next-iq4r");
const REPEATS = Number(arg("repeats", "3"));
const IDLE_S = Number(arg("idle", "90"));
const OUT = arg("out", "");
const PARTS = arg("parts", "AB");
if (OUT === "") { process.stderr.write("--out <file> is required\n"); process.exit(2); }

function apiKey(): string {
  const file = process.env["G10_RADIANCE_KEY_FILE"];
  if (file !== undefined) return readFileSync(file, "utf8").trim();
  const models = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "models.json"), "utf8")) as { providers?: Record<string, { apiKey?: string }> };
  const key = models.providers?.["radiance"]?.apiKey;
  if (typeof key !== "string" || key.length === 0) throw new Error("no radiance apiKey in Pi's models.json");
  return key;
}
const KEY = apiKey();
const auth = { authorization: `Bearer ${KEY}` };

async function getJson(path: string): Promise<unknown> {
  const r = await fetch(`${BASE}${path}`, { headers: auth });
  return r.json();
}

interface Timing { readonly wallMs: number; readonly clientTtftMs?: number; readonly events?: unknown[] }
/** Real HTTP, one request at a time. A streamed answer is put together the way a client sees it (content, then the finish event's timings and the last event's usage); the raw last events are kept as fixtures. */
class HttpTransport implements Transport {
  last: Timing | undefined;
  readonly maxTokens: number;
  constructor(maxTokens: number) { this.maxTokens = maxTokens; }
  async send(request: HttpRequest): Promise<HttpResponse> {
    const body: WireRequest = { ...request.body, model: MODEL, max_tokens: this.maxTokens };
    delete body["max_completion_tokens"];
    const started = performance.now();
    const res = await fetch(`${BASE}${request.path}`, { method: request.method, headers: { ...request.headers, ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });
    if (body["stream"] !== true || res.status >= 400) {
      const out = { status: res.status, body: await res.json() as unknown };
      this.last = { wallMs: performance.now() - started };
      return out;
    }
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = ""; let content = ""; let finish: unknown; let usage: unknown; let timings: unknown; let first: number | undefined;
    const events: unknown[] = [];
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
        const e = JSON.parse(data) as { choices?: { delta?: { content?: string; reasoning_content?: string }; finish_reason?: string }[]; usage?: unknown; timings?: unknown };
        const d = e.choices?.[0]?.delta;
        if (first === undefined && (typeof d?.content === "string" && d.content.length > 0 || typeof d?.reasoning_content === "string" && d.reasoning_content.length > 0)) first = performance.now() - started;
        if (typeof d?.content === "string") content += d.content;
        if (e.choices?.[0]?.finish_reason !== undefined && e.choices[0].finish_reason !== null) finish = e.choices[0].finish_reason;
        if (e.usage !== undefined && e.usage !== null) usage = e.usage;
        if (e.timings !== undefined) timings = e.timings;
        if (e.usage !== undefined || e.timings !== undefined) events.push(e);
      }
    }
    this.last = { wallMs: performance.now() - started, ...(first === undefined ? {} : { clientTtftMs: first }), events };
    return { status: res.status, body: { object: "chat.completion", model: MODEL, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finish }], usage, timings } };
  }
}

// ---- Part A ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const TEAMS = ["Kestrel", "Heron", "Otter", "Lynx", "Marten", "Plover", "Wren", "Badger", "Ibis", "Stoat"];
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
/** About 6,000 tokens of rules, with two facts the questions ask about: a code word in the middle and a team in the second half. */
function head(nonce: string, lines = 400): { text: string; code: string; team: string } {
  const code = `${["amber", "cobalt", "saffron", "violet", "jade"][randomBytes(1)[0]! % 5]}-${100 + (randomBytes(2).readUInt16BE(0) % 900)}`;
  const team = TEAMS[randomBytes(1)[0]! % TEAMS.length]!;
  const out = [`Run ${nonce}. You answer questions about the ledger rules below. Answer with the exact value only, no explanation.`];
  for (let i = 1; i <= lines; i++) {
    out.push(`Rule ${i}: entries in ledger section ${i} are reconciled every ${DAYS[i % 5]} by team ${TEAMS[(i * 7) % 10]}, with a tolerance of ${(i * 13) % 97} cents.`);
    if (i === Math.floor(lines / 2)) out.push(`Note: the vault code for this run is ${code}.`);
    if (i === Math.floor((lines * 3) / 4)) out.push(`Note: the on-call team for this run is ${team}.`);
  }
  return { text: out.join("\n"), code, team };
}

interface Step { readonly repeat: number; readonly step: string; readonly outcome: string; readonly applied: readonly string[]; readonly promptTokens: number; readonly cachedTokens: number; readonly computedTokens: number; readonly serverPromptMs?: number; readonly serverTtftMs?: number; readonly clientTtftMs?: number; readonly wallMs: number; readonly answer: string; readonly expected: string; readonly correct: boolean; readonly caveat?: string }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const statsOf = (s: unknown): unknown => { const o = s as Record<string, unknown>; const pick = ["version", "in_flight", "running", "waiting", "kv_tokens_used", "kv_tokens_total", "kv_tokens_cached", "kv_bytes_used", "kv_bytes_total", "prefix_hit_rate", "prefix_evictions", "linear_hit_rate", "linear_cached_tokens", "checkpoints_written", "ckpt_evictions", "ckpt_refused", "hit_cuts", "hit_cut_tokens", "total_requests", "max_num_seqs"]; return Object.fromEntries(pick.map((k) => [k, o[k]])); };

async function partA(results: Record<string, unknown>): Promise<void> {
  const transport = new HttpTransport(24);
  const profile = profileFor({ kind: "radiance", model: MODEL, options: { hostTier: true, hybrid: true } });
  const adapter = new CacheAdapter(profile, transport);
  const steps: Step[] = [];
  const fixtures: Record<string, unknown> = {};
  const sessionsSeen: Record<string, unknown> = {};
  const secret = randomBytes(24).toString("hex");
  for (let r = 1; r <= REPEATS; r++) {
    const nonce = randomBytes(6).toString("hex");
    const h = head(nonce);
    const ctx: CacheContext = { scopeKey: deriveKey(secret, "scope", `g10-${nonce}`), shareKey: deriveKey(secret, "share", `g10-${nonce}`) };
    const sys = { role: "system", content: h.text };
    const qa = { role: "user", content: "What is the vault code for this run?" };
    const qb = { role: "user", content: "Which team is on call for this run?" };
    const base = { stream: true, stream_options: { include_usage: true }, chat_template_kwargs: { enable_thinking: false }, temperature: 0 };
    const send = async (name: string, messages: unknown[], expected: string, context: CacheContext, expectCached: number, extra: WireRequest = {}): Promise<Step> => {
      const res = await adapter.call({ ...base, ...extra, messages }, context, expectCached);
      const t = transport.last!;
      const b = res.body as { choices?: { message?: { content?: string } }[]; timings?: { prompt_ms?: number; ttft_ms?: number } };
      const answer = (b.choices?.[0]?.message?.content ?? "").trim();
      const step: Step = {
        repeat: r, step: name, outcome: res.outcome, applied: res.applied, promptTokens: res.hit.promptTokens, cachedTokens: res.hit.cachedTokens, computedTokens: res.hit.computedTokens,
        ...(b.timings?.prompt_ms === undefined ? {} : { serverPromptMs: Math.round(b.timings.prompt_ms) }), ...(b.timings?.ttft_ms === undefined ? {} : { serverTtftMs: Math.round(b.timings.ttft_ms) }),
        ...(t.clientTtftMs === undefined ? {} : { clientTtftMs: Math.round(t.clientTtftMs) }), wallMs: Math.round(t.wallMs), answer: answer.slice(0, 80), expected, correct: answer.toLowerCase().includes(expected.toLowerCase()),
        ...(res.hit.caveat === undefined ? {} : { caveat: res.hit.caveat }),
      };
      steps.push(step);
      if (r === 1) fixtures[name] = { response: res.body, streamEvents: t.events };
      process.stdout.write(`${JSON.stringify(step)}\n`);
      return step;
    };
    const s1 = await send("cold", [sys, qa], h.code, ctx, 0);
    const s2 = await send("repeat", [sys, qa], h.code, ctx, 1);
    await send("fork", [sys, qb], h.team, ctx, 1);
    await send("switch-back", [sys, qa, { role: "assistant", content: s1.answer }, qb], h.team, ctx, s1.promptTokens > 0 ? 1 : 0);
    await send("no-label", [sys, qa], h.code, { ...ctx, plain: true }, 1);
    const changed = { role: "system", content: `Changed. ${h.text}` };
    await send("changed-head", [changed, qa], h.code, ctx, Math.max(1, s2.cachedTokens));
    if (r === 1) {
      const nonStream = await adapter.call({ messages: [sys, qa], chat_template_kwargs: { enable_thinking: false }, temperature: 0 }, ctx, 1);
      fixtures["repeat-non-stream"] = { response: nonStream.body };
      process.stdout.write(`non-stream repeat: cached ${nonStream.hit.cachedTokens} of ${nonStream.hit.promptTokens}\n`);
    }
    const sessions = await getJson("/sessions") as { sessions?: { label?: string }[] };
    sessionsSeen[`repeat-${r}`] = (sessions.sessions ?? []).filter((s) => s.label === ctx.shareKey || s.label === ctx.scopeKey);
    if (IDLE_S > 0) { await sleep(IDLE_S * 1000); await send(`after-idle-${IDLE_S}s`, [sys, qa], h.code, ctx, Math.max(1, s2.cachedTokens)); }
  }
  results["partA"] = { steps, sessions: sessionsSeen, profile: { kind: profile.kind, hitFields: profile.hitFields, caveats: profile.caveats } };
  results["fixtures"] = fixtures;
}

// ---- Part B ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
async function partB(results: Record<string, unknown>): Promise<void> {
  const out: Record<string, unknown> = {};
  for (const scale of [1, 4]) {
    for (const layout of ["nimblenewt", "legacy"] as const) {
      const transport = new HttpTransport(8);
      const backend: Backend = { name: "Radiance (real)", profile: () => profileFor({ kind: "radiance", model: MODEL, options: { hostTier: true, hybrid: true } }), wire: "openai-completions", server: () => transport, sharesAcrossAgents: true, charsPerToken: 4 };
      const nonce = randomBytes(6).toString("hex");
      const timings: unknown[] = [];
      const wrapped: Backend = { ...backend, server: () => ({ send: async (req) => { const res = await transport.send(req); const b = res.body as { timings?: { prompt_ms?: number; ttft_ms?: number } }; timings.push({ wallMs: Math.round(transport.last!.wallMs), serverPromptMs: Math.round(b.timings?.prompt_ms ?? -1), serverTtftMs: Math.round(b.timings?.ttft_ms ?? -1) }); return res; } }) };
      const r = await run(wrapped, layout, { modelId: MODEL, scale, project: `g10-${nonce}`, nonce: `Run ${nonce}.` });
      const summary = { computed: computed(r), cachedSharePct: cachedShare(r), requests: r.hits.map((h, i) => ({ agent: r.order[i], prompt: h.promptTokens, cached: h.cachedTokens, computed: h.computedTokens, ...(timings[i] as object) })) };
      out[`scale${scale}-${layout}`] = summary;
      process.stdout.write(`# B scale ${scale} ${layout}: computed ${summary.computed}, served from cache ${summary.cachedSharePct}%\n${JSON.stringify(summary.requests)}\n`);
    }
  }
  results["partB"] = out;
}

const results: Record<string, unknown> = { startedAt: new Date().toISOString(), url: BASE, model: MODEL, repeats: REPEATS, idleSeconds: IDLE_S };
results["models"] = ((await getJson("/v1/models")) as { data?: { id?: string; state?: string }[] }).data?.map((m) => ({ id: m.id, state: m.state }));
results["statsBefore"] = statsOf(await getJson("/stats"));
const idle = results["statsBefore"] as { running?: number; waiting?: number };
if ((idle.running ?? 0) > 0 || (idle.waiting ?? 0) > 0) process.stdout.write(`note: the server is running ${idle.running} and has ${idle.waiting} waiting; timings include that load\n`);
if (PARTS.includes("A")) await partA(results);
if (PARTS.includes("B")) await partB(results);
results["statsAfter"] = statsOf(await getJson("/stats"));
results["finishedAt"] = new Date().toISOString();
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(results, null, 1)}\n`);
process.stdout.write(`results: ${OUT}\n`);
