import type { EngineKind } from "./g10-engines-live.js";

/**
 * Scripted stand-ins for llama.cpp's `llama-server` and for vLLM, for the offline tests of g10-engines-live.ts. They model what each engine says about its cache, not the engines' speed:
 *
 *   llama.cpp: `-np` slots, each holding the last prompt it ran; a call without `id_slot` goes to the slot with the longest common prefix when it is at least 10% of the prompt (llama.cpp's default similarity threshold), else to the least recently used slot, `cache_prompt: false` computes everything,
 *              `timings.cache_n`/`prompt_n`, slot save/erase/restore, `/props`, `/slots`, `/metrics`, an unknown request field is refused with 400 when `strict`.
 *   vLLM:      automatic prefix caching in 16-token blocks with a least-recently-used capacity, `usage.prompt_tokens_details.cached_tokens` (only with `details`), `cache_salt` partitions, `/metrics`.
 *
 * "Tokens" are whitespace-separated words. The answer is found by reading the synthetic ledger text, so a wrong answer would show.
 */
export interface FakeOptions {
  readonly kind: EngineKind;
  /** llama.cpp: number of slots. */
  readonly slots?: number;
  /** vLLM: capacity of the prefix cache in tokens. */
  readonly capacityTokens?: number;
  /** vLLM: report cached_tokens (the engine's flag). Default true. */
  readonly details?: boolean;
  /** llama.cpp: refuse unknown request fields. Default true. vLLM ignores them. */
  readonly strict?: boolean;
  /** llama.cpp: slot files allowed (--slot-save-path). Default true. */
  readonly saveEnabled?: boolean;
  /** vLLM: refuse `cache_salt` (an older build). */
  readonly noSalt?: boolean;
}
export interface FakeRequest { readonly method: string; readonly path: string; readonly body?: Record<string, unknown> }
export interface Fake { readonly fetch: typeof globalThis.fetch; readonly requests: FakeRequest[]; forget(): void; readonly inFlightMax: () => number }

const BLOCK = 16;
const words = (s: string): string[] => s.split(/\s+/).filter((w) => w !== "");
const KNOWN = new Set(["model", "stream", "stream_options", "temperature", "max_tokens", "chat_template_kwargs", "messages", "id_slot", "cache_prompt", "cache_salt"]);

function answerFor(messages: { role: string; content: string }[]): string {
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  const ask = messages.find((m) => m.role === "user")?.content ?? "";
  if (ask.includes("vault code")) return /vault code for this run is ([a-z]+-\d+)/.exec(system)?.[1] ?? "unknown";
  if (ask.includes("on call")) return /on-call team for this run is ([A-Za-z]+)/.exec(system)?.[1] ?? "unknown";
  return "unknown";
}

export function fakeEngine(options: FakeOptions): Fake {
  const requests: FakeRequest[] = [];
  const kind = options.kind;
  const strict = options.strict ?? true;
  let tick = 0; let inFlight = 0; let inFlightMax = 0;
  // llama.cpp state
  const slotCount = options.slots ?? 4;
  const slots: { tokens: string[]; used: number }[] = Array.from({ length: slotCount }, () => ({ tokens: [], used: 0 }));
  const files = new Map<string, string[]>();
  // vLLM state: block chain keys in LRU order
  const blocks = new Map<string, number>();
  const capacityBlocks = Math.floor((options.capacityTokens ?? 20_000) / BLOCK);
  let promptTokensTotal = 0; let hitsTotal = 0; let queriesTotal = 0;
  const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const chat = (body: Record<string, unknown>): Response => {
    const messages = body["messages"] as { role: string; content: string }[];
    if (kind === "llamacpp" && strict) { const bad = Object.keys(body).find((k) => !KNOWN.has(k)); if (bad !== undefined) return json(400, { error: { code: 400, message: `unknown field ${bad}`, type: "invalid_request_error" } }); }
    if (kind === "vllm" && options.noSalt === true && "cache_salt" in body) return json(400, { error: { message: "cache_salt is not supported", type: "BadRequestError", code: 400 } });
    const tokens = words(messages.map((m) => m.content).join(" "));
    const prompt = tokens.length;
    let cached = 0; let computed = prompt;
    tick += 1;
    if (kind === "llamacpp") {
      const wanted = body["id_slot"];
      const reuse = body["cache_prompt"] !== false;
      const common = (a: string[], b: string[]): number => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
      let id: number;
      if (typeof wanted === "number" && wanted >= 0 && wanted < slotCount) id = wanted;
      else { id = 0; let best = Number.NEGATIVE_INFINITY; slots.forEach((s, i) => { const raw = common(s.tokens, tokens); const c = raw / Math.max(1, tokens.length) >= 0.1 ? raw : 0; const score = c * 1_000_000 - s.used; if (score > best) { best = score; id = i; } }); }
      const slot = slots[id]!;
      cached = reuse ? Math.min(common(slot.tokens, tokens), prompt - 1) : 0;
      computed = prompt - cached;
      slot.tokens = tokens; slot.used = tick;
    } else {
      const salt = typeof body["cache_salt"] === "string" ? body["cache_salt"] : "";
      const keys: string[] = []; let chain = `salt:${salt}`;
      for (let i = 0; i + BLOCK <= tokens.length; i += BLOCK) { chain = `${chain}|${tokens.slice(i, i + BLOCK).join(" ")}`; keys.push(chain); }
      let hit = 0; while (hit < keys.length && blocks.has(keys[hit]!)) hit++;
      cached = Math.min(hit * BLOCK, Math.floor((prompt - 1) / BLOCK) * BLOCK);
      computed = prompt - cached;
      queriesTotal += prompt; hitsTotal += cached;
      for (const k of keys) { blocks.delete(k); blocks.set(k, tick); }
      while (blocks.size > capacityBlocks) blocks.delete(blocks.keys().next().value as string);
    }
    promptTokensTotal += computed;
    const answer = answerFor(messages);
    const usage: Record<string, unknown> = { prompt_tokens: prompt, completion_tokens: 3, total_tokens: prompt + 3 };
    if (kind === "vllm" && (options.details ?? true)) usage["prompt_tokens_details"] = { cached_tokens: cached };
    const events: unknown[] = [{ choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }, { choices: [{ index: 0, delta: { content: answer } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }];
    events.push({ choices: [], usage, ...(kind === "llamacpp" ? { timings: { cache_n: cached, prompt_n: computed, prompt_ms: computed * 0.5, predicted_n: 3 } } : {}) });
    const text = `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`;
    return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
  };

  const metrics = (): Response => {
    const lines = kind === "llamacpp"
      ? [`llamacpp:prompt_tokens_total ${promptTokensTotal}`, "llamacpp:requests_processing 0"]
      : [`vllm:prefix_cache_hits_total{model_name="m"} ${hitsTotal}`, `vllm:prefix_cache_queries_total{model_name="m"} ${queriesTotal}`, `vllm:cache_config_info{block_size="${BLOCK}",num_gpu_blocks="${capacityBlocks}",enable_prefix_caching="True"} 1`, "vllm:kv_cache_usage_perc 0.1"];
    return new Response(`# HELP x\n${lines.join("\n")}\n`, { status: 200 });
  };

  const fakeFetch = (async (input: unknown, init?: { method?: string; body?: string }): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : (JSON.parse(init.body) as Record<string, unknown>);
    requests.push({ method, path: url.pathname + url.search, ...(body === undefined ? {} : { body }) });
    inFlight += 1; inFlightMax = Math.max(inFlightMax, inFlight);
    try {
      await Promise.resolve();
      if (url.pathname === "/v1/chat/completions" && method === "POST") return chat(body ?? {});
      if (url.pathname === "/metrics") return metrics();
      if (url.pathname === "/v1/models") return json(200, { data: [{ id: "m", max_model_len: 16384 }] });
      if (kind === "llamacpp" && url.pathname === "/props") return json(200, { total_slots: slotCount, default_generation_settings: { n_ctx: 8192 } });
      if (kind === "llamacpp" && url.pathname === "/slots" && method === "GET") return json(200, slots.map((_, i) => ({ id: i, n_ctx: 8192, is_processing: false })));
      const m = /^\/slots\/(\d+)$/.exec(url.pathname);
      if (kind === "llamacpp" && m && method === "POST") {
        const slot = slots[Number(m[1])]; const action = url.searchParams.get("action");
        if (slot === undefined) return json(404, { error: { message: "no such slot" } });
        if (action === "erase") { slot.tokens = []; return json(200, { id_slot: Number(m[1]), n_erased: 1 }); }
        if (options.saveEnabled === false) return json(501, { error: { message: "This server does not support slot save/restore. Start it with --slot-save-path" } });
        const filename = String(body?.["filename"] ?? "");
        if (action === "save") { files.set(filename, slot.tokens.slice()); return json(200, { id_slot: Number(m[1]), filename, n_saved: slot.tokens.length }); }
        if (action === "restore") { const t = files.get(filename); if (t === undefined) return json(400, { error: { message: "file not found" } }); slot.tokens = t.slice(); slot.used = ++tick; return json(200, { id_slot: Number(m[1]), filename, n_restored: t.length }); }
      }
      return json(404, { error: { message: `no route ${url.pathname}` } });
    } finally { inFlight -= 1; }
  }) as unknown as typeof globalThis.fetch;

  return { fetch: fakeFetch, requests, forget: () => { blocks.clear(); for (const s of slots) s.tokens = []; }, inFlightMax: () => inFlightMax };
}
