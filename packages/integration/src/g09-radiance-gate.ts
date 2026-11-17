import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Card G09, the measured run against the owner's Radiance server: the safety and measurement pieces, kept apart from the scenario (`g09-radiance-run.ts`) and the command (`g09-radiance-bench.ts`) so they can be tested
 * offline (`g09-radiance.test.ts`). Same rules as card G10's bench and card M00's `prototypes/meeting/lib/radiance.mjs`:
 *
 * - The API key is read from Pi's own configuration (`~/.pi/agent/models.json`, provider `radiance`) and is only ever put in an Authorization header. It is never returned as a value a caller could print: `radianceKey`
 *   gives a header function and a scrubber. Error texts that leave this module pass through the scrubber.
 * - Before every model call the server must be idle (`/stats`: in_flight, running and waiting all stated and 0) and the pinned model must already be served (`/v1/models`: the id with state `resident`). Otherwise the
 *   call is refused (`RadianceRefused`) and the run stops. Only GET /stats and GET /v1/models are sent besides the model calls; nothing loads, unloads, switches, resets or restarts anything.
 * - One model call at a time, a fixed number of calls and a fixed reply limit per call (`Budget`). A call over the budget is refused before it is sent.
 * - An interruption is this client closing its own request (an abort or a cancelled body): `observeBody` passes a cancel straight to the connection, so the server sees the client go away. Other sessions are never touched.
 */

export const PINNED_MODEL = "qwen3.8-flash-next-iq4r";

export class RadianceRefused extends Error {
  readonly why: string;
  constructor(why: string) { super(`Radiance check: REFUSED (${why})`); this.name = "RadianceRefused"; this.why = why; }
}
export class BudgetExceeded extends Error { constructor(why: string) { super(`budget: ${why}`); this.name = "BudgetExceeded"; } }

/** The key, as something that can only be used: a header for a request, and a scrubber for any text that might carry it. */
export interface RadianceKey {
  readonly baseUrl: string;
  header(): Readonly<Record<string, string>>;
  /** The text with every occurrence of the key replaced by `<key>`. */
  scrub(text: string): string;
  /** How many times the key occurs in the text (0 is the only good answer). */
  count(text: string): number;
}

export function keyFrom(secret: string, baseUrl: string): RadianceKey {
  if (secret.length < 8) throw new Error("the radiance apiKey in Pi's models.json is too short to be a key");
  const count = (text: string): number => { let n = 0; for (let at = text.indexOf(secret); at >= 0; at = text.indexOf(secret, at + 1)) n++; return n; };
  return Object.freeze({ baseUrl, header: () => ({ authorization: `Bearer ${secret}` }), scrub: (text: string) => text.split(secret).join("<key>"), count });
}

/** Reads the key from Pi's configuration. The error never names the key. */
export function radianceKey(home = homedir()): RadianceKey {
  let models: { providers?: Record<string, { apiKey?: unknown; baseUrl?: unknown }> };
  try { models = JSON.parse(readFileSync(join(home, ".pi", "agent", "models.json"), "utf8")) as typeof models; } catch { throw new Error("Pi's models.json could not be read"); }
  const p = models.providers?.["radiance"];
  if (p === undefined || typeof p.apiKey !== "string" || p.apiKey.length === 0) throw new Error("no radiance provider with an apiKey in Pi's models.json");
  return keyFrom(p.apiKey, typeof p.baseUrl === "string" ? p.baseUrl : "http://127.0.0.1:8002/v1");
}

/** The server root: the OpenAI base URL without its trailing /v1. */
export const serverRoot = (baseUrl: string): string => baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");

const STATS = ["version", "in_flight", "running", "waiting", "max_num_seqs", "total_requests", "kv_tokens_used", "kv_tokens_total", "kv_tokens_cached", "prefix_evictions", "checkpoints_written", "ckpt_evictions", "ckpt_refused", "hit_cuts", "hit_cut_tokens", "linear_cached_tokens"] as const;
export type Stats = Partial<Record<(typeof STATS)[number], unknown>>;
export const statsOf = (s: unknown): Stats => (s !== null && typeof s === "object" ? Object.fromEntries(STATS.map((k) => [k, (s as Record<string, unknown>)[k]])) as Stats : {});

/** Idle only when all three counts are stated and are 0; anything else is busy (a wrong pass would share the server with someone). */
export function idleOf(stats: Stats): { ok: boolean; why: string } {
  const bad = (["in_flight", "running", "waiting"] as const).filter((k) => stats[k] !== 0);
  if (bad.length === 0) return { ok: true, why: "in_flight, running and waiting are all 0" };
  return { ok: false, why: `the server is not idle or does not say so (${bad.map((k) => `${k}=${typeof stats[k] === "number" ? String(stats[k]) : "missing"}`).join(", ")})` };
}

/** The pinned model must already be served: listed with state `resident`. A model that is listed `cold` (or not at all) would have to be loaded, which this run must never cause. */
export function pinnedServed(models: unknown, id: string): { ok: boolean; why: string } {
  const data = (models as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return { ok: false, why: "the server's model list could not be read" };
  const entry = data.find((m) => (m as { id?: unknown } | null)?.id === id) as { state?: unknown } | undefined;
  if (entry === undefined) return { ok: false, why: `the pinned model ${id} is not listed` };
  if (entry.state !== "resident") return { ok: false, why: `the pinned model ${id} is listed as ${typeof entry.state === "string" ? entry.state.slice(0, 20) : "without a state"}, not resident` };
  return { ok: true, why: `${id} is resident` };
}

export interface GateReading { readonly at: string; readonly stats: Stats; readonly idle: boolean; readonly why: string }

/**
 * The idle gate. `check()` before every model call; `waitIdle()` after this client closed its own request, to measure how long the server takes to notice (it never waits for anybody else: the caller decides what a
 * timeout means). GET requests only, with the key in the Authorization header and no redirects.
 */
export class ServerGate {
  readonly #root: string;
  readonly #key: RadianceKey;
  readonly #fetch: typeof globalThis.fetch;
  readonly #model: string;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #settleMs: number;
  readonly readings: GateReading[] = [];
  constructor(options: { root: string; key: RadianceKey; fetch: typeof globalThis.fetch; model?: string; sleep?: (ms: number) => Promise<void>; settleMs?: number }) {
    this.#settleMs = options.settleMs ?? 5000;
    this.#root = serverRoot(options.root); this.#key = options.key; this.#fetch = options.fetch; this.#model = options.model ?? PINNED_MODEL;
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }
  async #get(path: string): Promise<unknown> {
    let res: Response;
    try { res = await this.#fetch(`${this.#root}${path}`, { method: "GET", redirect: "manual", headers: { ...this.#key.header() }, signal: AbortSignal.timeout(5000) }); } catch (error) { throw new RadianceRefused(this.#key.scrub(`GET ${path} failed: ${error instanceof Error ? error.message : String(error)}`).slice(0, 200)); }
    if (!res.ok) throw new RadianceRefused(`GET ${path} answered ${res.status}`);
    try { return await res.json(); } catch { throw new RadianceRefused(`GET ${path} did not answer JSON`); }
  }
  async stats(): Promise<Stats> { return statsOf(await this.#get("/stats")); }
  /**
   * Refuses unless the server is idle and the pinned model is already served. A server that is busy is read again for up to `settleMs` (default 5 s; the counts of this client's own call that just ended can lag by a
   * moment) and nothing is sent until it says idle; still busy after that, the call is refused.
   */
  async check(settleMs = this.#settleMs): Promise<GateReading> {
    const start = performance.now();
    let stats = await this.stats();
    let idle = idleOf(stats);
    while (!idle.ok && performance.now() - start < settleMs) { await this.#sleep(100); stats = await this.stats(); idle = idleOf(stats); }
    const reading = { at: new Date().toISOString(), stats, idle: idle.ok, why: idle.why };
    this.readings.push(reading);
    if (!idle.ok) throw new RadianceRefused(idle.why);
    const served = pinnedServed(await this.#get("/v1/models"), this.#model);
    if (!served.ok) throw new RadianceRefused(served.why);
    return reading;
  }
  /** Polls /stats (every `everyMs`) until it says idle; resolves the time it took, or undefined if it did not within `maxMs`. */
  async waitIdle(maxMs: number, everyMs = 100): Promise<{ ms: number | undefined; polls: number }> {
    const start = performance.now();
    let polls = 0;
    for (;;) {
      polls++;
      if (idleOf(await this.stats()).ok) return { ms: Math.round(performance.now() - start), polls };
      if (performance.now() - start >= maxMs) return { ms: undefined, polls };
      await this.#sleep(everyMs);
    }
  }
}

/** A fixed number of model calls and a fixed reply limit per call, both stated before the run. */
export class Budget {
  readonly maxCalls: number;
  readonly maxReplyTokens: number;
  calls = 0;
  constructor(maxCalls: number, maxReplyTokens: number) { this.maxCalls = maxCalls; this.maxReplyTokens = maxReplyTokens; }
  /** Takes one call; refuses past the budget or a body whose reply limit is missing or over the cap. */
  take(body: unknown): void {
    const o = body as { max_tokens?: unknown; max_completion_tokens?: unknown } | null;
    const limit = o?.max_tokens ?? o?.max_completion_tokens;
    if (typeof limit !== "number" || !(limit >= 1) || limit > this.maxReplyTokens) throw new BudgetExceeded(`a call's reply limit must be 1..${this.maxReplyTokens} tokens (it was ${typeof limit === "number" ? limit : "missing"})`);
    if (this.calls >= this.maxCalls) throw new BudgetExceeded(`the run may make ${this.maxCalls} model calls and has made them all`);
    this.calls++;
  }
}

/** One at a time: every call waits until the previous one has ended (its body read to the end, cancelled or failed). */
export function oneAtATime(): <T>(run: (done: () => void) => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return async (run) => {
    let release!: () => void;
    const mine = new Promise<void>((r) => { release = r; });
    const before = tail;
    tail = before.then(() => mine);
    await before;
    let released = false;
    const done = (): void => { if (!released) { released = true; release(); } };
    try { return await run(done); } catch (error) { done(); throw error; }
  };
}

/** What the server reported about one streamed answer: `usage` and `timings` of its last events, the finish reason, and the text and tool-call pieces it carried. */
export interface StreamFacts {
  promptTokens?: number; cachedTokens?: number; completionTokens?: number; cacheN?: number; promptN?: number; promptMs?: number; ttftMs?: number; predictedN?: number;
  finish?: string; textChars: number; toolPieces: number; toolNames: string[]; events: number;
}
const n = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
/** Reads the server-sent events of an OpenAI-style stream, piece by piece. */
export class SseFacts {
  readonly facts: StreamFacts = { textChars: 0, toolPieces: 0, toolNames: [], events: 0 };
  #buffer = "";
  readonly #decoder = new TextDecoder();
  push(piece: Uint8Array): void {
    this.#buffer += this.#decoder.decode(piece, { stream: true });
    let nl: number;
    while ((nl = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, nl).trim(); this.#buffer = this.#buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]" || data === "") continue;
      let e: { choices?: { delta?: { content?: unknown; tool_calls?: { function?: { name?: unknown } }[] }; finish_reason?: unknown }[]; usage?: Record<string, unknown> | null; timings?: Record<string, unknown> };
      try { e = JSON.parse(data) as typeof e; } catch { continue; }
      const f = this.facts;
      f.events++;
      const c = e.choices?.[0];
      if (typeof c?.delta?.content === "string") f.textChars += c.delta.content.length;
      for (const t of c?.delta?.tool_calls ?? []) { f.toolPieces++; if (typeof t.function?.name === "string" && t.function.name !== "") f.toolNames.push(t.function.name.slice(0, 40)); }
      if (typeof c?.finish_reason === "string") f.finish = c.finish_reason;
      const u = e.usage;
      if (u !== undefined && u !== null) {
        const p = n(u["prompt_tokens"]); if (p !== undefined) f.promptTokens = p;
        const ct = n(u["completion_tokens"]); if (ct !== undefined) f.completionTokens = ct;
        const cached = n((u["prompt_tokens_details"] as Record<string, unknown> | undefined)?.["cached_tokens"]); if (cached !== undefined) f.cachedTokens = cached;
      }
      const t = e.timings;
      if (t !== undefined && t !== null) {
        const set = (k: "cacheN" | "promptN" | "promptMs" | "ttftMs" | "predictedN", v: unknown): void => { const x = n(v); if (x !== undefined) f[k] = k === "promptMs" || k === "ttftMs" ? Math.round(x) : x; };
        set("cacheN", t["cache_n"]); set("promptN", t["prompt_n"]); set("promptMs", t["prompt_ms"]); set("ttftMs", t["ttft_ms"]); set("predictedN", t["predicted_n"]);
      }
    }
  }
}

/**
 * Wraps a response body so every piece is seen as it passes, and a cancel from the reader goes straight to the connection (no tee: a tee would keep reading for the other branch, and the server would never see this
 * client go away). `onEnd` is told once how the body ended.
 */
export function observeBody(body: ReadableStream<Uint8Array>, onPiece: (piece: Uint8Array) => void, onEnd: (how: "complete" | "cancelled" | "error", detail?: string) => void, signal?: AbortSignal): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let ended = false;
  const end = (how: "complete" | "cancelled" | "error", detail?: string): void => { if (ended) return; ended = true; try { onEnd(how, detail); } catch { /* the stream is not affected */ } };
  // The request's own abort ends the body here too, even if nobody reads it any more (a reader that stopped at the end marker and went away).
  signal?.addEventListener("abort", () => { if (ended) return; end("cancelled", "aborted"); void reader.cancel().catch(() => undefined); }, { once: true });
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let r: Awaited<ReturnType<typeof reader.read>>;
      try { r = await reader.read(); } catch (error) { end("error", error instanceof Error ? error.name : "error"); controller.error(error); return; }
      if (r.done) { end("complete"); controller.close(); return; }
      try { onPiece(r.value); } catch { /* the stream is not affected */ }
      controller.enqueue(r.value);
    },
    async cancel(reason) { end("cancelled"); await reader.cancel(reason).catch(() => undefined); },
  }, { highWaterMark: 0 });
}

/** A model request reduced to `role: text` lines (tool calls as `<call name>`), the exact context manifest the server was handed. */
export function manifestOfBody(body: unknown): string[] {
  const messages = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) return [];
  return messages.map((m: { role?: unknown; content?: unknown; tool_calls?: { function?: { name?: unknown } }[] }) => {
    const text = typeof m.content === "string" ? m.content
      : Array.isArray(m.content) ? (m.content as { type?: unknown; text?: unknown }[]).map((p) => (typeof p.text === "string" ? p.text : `<${String(p.type)}>`)).join("") : "";
    const calls = (m.tool_calls ?? []).map((c) => `<call ${String(c.function?.name)}>`).join("");
    return `${String(m.role)}: ${text}${calls}`;
  });
}
/** A manifest line for the evidence file: role, length, a digest, and the first characters (the full head would be thousands of tokens). */
export const lineDigest = (line: string): string => `${line.slice(0, line.indexOf(":") + 1)} ${line.length} chars sha256:${createHash("sha256").update(line).digest("hex").slice(0, 12)} ${JSON.stringify(line.slice(line.indexOf(":") + 2, line.indexOf(":") + 62))}`;

/** One model call as the measured fetch saw it. */
export interface CallRecord {
  readonly n: number;
  phase: string;
  readonly startedMs: number;
  headMs?: number; firstByteMs?: number; endMs?: number;
  status?: number;
  ended?: "complete" | "cancelled" | "error" | "refused";
  detail?: string;
  bytes: number;
  readonly maxTokens: number | undefined;
  readonly manifest: string[];
  facts?: StreamFacts;
  /** When this client closed its request (cancel or abort), ms from the start of the call. */
  closedMs?: number;
}

/**
 * The fetch the relay uses to reach Radiance (`ModelRelayOptions.fetch`): budget, one at a time, idle gate, then the real call, with its stream observed. A refusal fails the call before anything is sent. `phase()` names
 * the scenario step each call is recorded under.
 */
export function measuredFetch(options: { fetch: typeof globalThis.fetch; gate: Pick<ServerGate, "check">; budget: Budget; key: RadianceKey; phase: () => string; calls: CallRecord[]; callTimeoutMs?: number; t0?: number; onRefused?: (error: Error) => void; trace?: (line: string) => void }): typeof globalThis.fetch {
  const trace = (line: string): void => { try { options.trace?.(options.key.scrub(line)); } catch { /* ignored */ } };
  const queue = oneAtATime();
  const t0 = options.t0 ?? performance.now();
  const since = (): number => Math.round(performance.now() - t0);
  return (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit): Promise<Response> => { trace(`call queued (${options.phase()})`); return queue(async (done) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const raw = init?.body;
    const text = typeof raw === "string" ? raw : raw instanceof Uint8Array ? Buffer.from(raw).toString("utf8") : raw === undefined || raw === null ? "" : undefined;
    if (text === undefined) throw new Error("the measured fetch takes a text or byte body only");
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new Error("the measured fetch takes a JSON body only"); }
    const record: CallRecord = { n: options.calls.length + 1, phase: options.phase(), startedMs: since(), bytes: 0, maxTokens: n((body as { max_tokens?: unknown }).max_tokens), manifest: manifestOfBody(body) };
    try {
      options.budget.take(body);
      await options.gate.check();
    } catch (error) {
      record.ended = "refused"; record.detail = options.key.scrub(error instanceof Error ? error.message : String(error)).slice(0, 300);
      options.calls.push(record);
      try { options.onRefused?.(error as Error); } catch { /* ignored */ }
      throw error;
    }
    options.calls.push(record);
    trace(`call ${record.n} gated and sent (${record.phase})`);
    const signals = [AbortSignal.timeout(options.callTimeoutMs ?? 180_000), ...(init?.signal ? [init.signal] : [])];
    const signal = AbortSignal.any(signals);
    signal.addEventListener("abort", () => { record.closedMs ??= since() - record.startedMs; }, { once: true });
    let res: Response;
    try { res = await options.fetch(url, { ...init, signal, redirect: "error" }); } catch (error) {
      record.ended = "error"; record.detail = options.key.scrub(error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 300); record.endMs = since() - record.startedMs;
      throw error;
    }
    record.headMs = since() - record.startedMs; record.status = res.status;
    trace(`call ${record.n} head ${res.status} after ${record.headMs} ms`);
    if (res.body === null) { record.ended = "complete"; record.endMs = record.headMs; return res; }
    const sse = new SseFacts();
    record.facts = sse.facts;
    const observed = observeBody(res.body, (piece) => { if (record.firstByteMs === undefined) record.firstByteMs = since() - record.startedMs; record.bytes += piece.length; sse.push(piece); }, (how, detail) => {
      record.ended = how; record.endMs = since() - record.startedMs;
      trace(`call ${record.n} body ${how} after ${record.endMs} ms (${record.bytes} bytes)`);
      if (how !== "complete") record.closedMs ??= record.endMs;
      if (detail !== undefined) record.detail = options.key.scrub(detail).slice(0, 200);
      done();
    }, signal);
    return new Response(observed, { status: res.status, statusText: res.statusText, headers: res.headers });
  }); }) as typeof globalThis.fetch;
}

/** Throws (without saying the key) if the text holds it. */
export function assertNoKey(text: string, key: RadianceKey, where: string): void {
  const found = key.count(text);
  if (found !== 0) throw new Error(`the key was found ${found} time(s) in ${where}; nothing was written`);
}
