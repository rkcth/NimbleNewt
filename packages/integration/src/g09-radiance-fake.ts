/**
 * Card G09: a scripted stand-in for the owner's Radiance server, for the offline tests of the measured run (`g09-radiance.test.ts`). It answers the three routes the run uses, the way the real server does as captured by G10
 * (`packages/controller/test-fixtures/g10-radiance/`): GET /stats, GET /v1/models and streamed POST /v1/chat/completions whose last events carry `usage` (with `prompt_tokens_details.cached_tokens`) and `timings`
 * (`cache_n`, `prompt_n`). It "reads" its context: the answers are looked up in the messages it was sent, so a request that lost its context gets a wrong answer. Reuse is by leading characters shared with an earlier
 * request, in whole steps of 2,048 tokens (4 characters a token), as G10 measured. A request whose client goes away stops at once and leaves `in_flight` (after `drainMs`).
 */

export interface FakeOptions {
  readonly key: string;
  /** Leave the server busy (another client) from the start. */
  readonly busy?: boolean;
  /** The pinned model's state in /v1/models (default resident). */
  readonly modelState?: string;
  /** Delay between streamed pieces of the long answers (default 15 ms). */
  readonly pieceMs?: number;
  /** How long the server takes to notice a client that went away (default 30 ms). */
  readonly drainMs?: number;
  /** Stream a tool call's arguments in one piece (a server whose tool parser holds the whole call). */
  readonly wholeToolCalls?: boolean;
}
export interface FakeRadiance {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: { path: string; method: string; auth: boolean; body?: unknown }[];
  readonly state: { inFlight: number; maxInFlight: number; aborted: number; total: number };
}

const enc = new TextEncoder();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
type Msg = { role: string; content?: unknown; tool_calls?: unknown };
const textOf = (m: Msg): string => (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? (m.content as { text?: string }[]).map((p) => p.text ?? "").join("") : "");

export function fakeRadiance(options: FakeOptions): FakeRadiance {
  const state = { inFlight: options.busy === true ? 1 : 0, maxInFlight: 0, aborted: 0, total: 0 };
  const requests: FakeRadiance["requests"] = [];
  const seen: string[] = [];
  const pieceMs = options.pieceMs ?? 15;
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const answer = (messages: Msg[]): { text?: string; tool?: { name: string; args: string }; slow?: boolean } => {
    const last = messages.at(-1)!;
    const all = messages.map(textOf).join("\n");
    if (last.role === "tool") return { text: textOf(last).startsWith("refused") ? "The note was not recorded: the owner's correction stands." : "Recorded." };
    const q = textOf(last);
    const find = (re: RegExp): string => { const m = [...all.matchAll(re)].at(-1); return m?.[1] ?? "unknown"; };
    if (q.includes("Reply with exactly: READY")) return { text: "READY" };
    if (q.includes("record_note")) return { tool: { name: "record_note", args: JSON.stringify({ note: `Rules 1 to 25: ${"each ledger section is reconciled on its day by its team within its tolerance. ".repeat(12)}` }) } };
    if (q.includes("400 words")) return { text: "Reconciliation runs through the week. ".repeat(60), slow: true };
    if (q.includes("release colour")) return { text: find(/the release colour is ([A-Z]+)/g) };
    if (q.includes("vault code")) return { text: find(/vault code for this run is ([a-z]+-\d+)/g) };
    if (q.includes("on call")) return { text: find(/on-call team for this run is (\w+)/g) };
    return { text: "OK" };
  };

  const fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
    const auth = new Headers(init?.headers).get("authorization") === `Bearer ${options.key}`;
    const method = (init?.method ?? "GET").toUpperCase();
    if (!auth) { requests.push({ path: url.pathname, method, auth }); return json({ error: "unauthorized" }, 401); }
    if (method === "GET" && url.pathname === "/stats") { requests.push({ path: url.pathname, method, auth }); return json({ version: "fake", in_flight: state.inFlight, running: state.inFlight, waiting: 0, total_requests: state.total, max_num_seqs: 8 }); }
    if (method === "GET" && url.pathname === "/v1/models") { requests.push({ path: url.pathname, method, auth }); return json({ data: [{ id: "qwen3.8-flash-next-iq4r", state: options.modelState ?? "resident" }, { id: "other-model", state: "cold" }] }); }
    if (method !== "POST" || url.pathname !== "/v1/chat/completions") return json({ error: "not found" }, 404);
    const body = JSON.parse(typeof init?.body === "string" ? init.body : Buffer.from(init?.body as Uint8Array).toString("utf8")) as { messages: Msg[]; max_tokens?: number; stream?: boolean };
    requests.push({ path: url.pathname, method, auth, body });
    state.total++; state.inFlight++; state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    // Reuse: the longest run of leading characters shared with an earlier request, in whole 2,048-token steps.
    const flat = body.messages.map((m) => `${m.role}\u0000${textOf(m)}\u0000${JSON.stringify(m.tool_calls ?? null)}`).join("\u0001");
    let shared = 0;
    for (const s of seen) { let i = 0; const max = Math.min(s.length, flat.length); while (i < max && s.charCodeAt(i) === flat.charCodeAt(i)) i++; shared = Math.max(shared, i); }
    seen.push(flat);
    const promptTokens = Math.ceil(flat.length / 4);
    const cached = Math.min(Math.floor(Math.floor(shared / 4) / 2048) * 2048, Math.max(0, promptTokens - 1));
    const a = answer(body.messages);
    const signal = init?.signal;
    let left = false;
    const leave = (): void => { if (left) return; left = true; void sleep(options.drainMs ?? 30).then(() => { state.inFlight--; }); };
    const head = { id: "chatcmpl-fake", object: "chat.completion.chunk", created: 1, model: "qwen3.8-flash-next-iq4r", system_fingerprint: "fake" };
    const event = (o: object): Uint8Array => enc.encode(`data: ${JSON.stringify({ ...head, ...o })}\n\n`);
    const pieces: Uint8Array[] = [event({ choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })];
    let completion = 0;
    if (a.tool !== undefined) {
      const args = a.tool.args;
      const parts = options.wholeToolCalls === true ? [args] : args.match(/.{1,24}/gs) ?? [args];
      // Whole: the call and the finish in one event, as a server whose tool parser holds the call until it is complete would send it.
      pieces.push(event({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_fake_1", type: "function", function: { name: a.tool.name, arguments: options.wholeToolCalls === true ? args : "" } }] }, finish_reason: options.wholeToolCalls === true ? "tool_calls" : null }] }));
      if (options.wholeToolCalls !== true) for (const p of parts) pieces.push(event({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: p } }] }, finish_reason: null }] }));
      completion = Math.ceil(args.length / 4);
    } else {
      const words = (a.text ?? "").match(/.{1,20}/gs) ?? [""];
      for (const w of words) pieces.push(event({ choices: [{ index: 0, delta: { content: w }, finish_reason: null }] }));
      completion = Math.ceil((a.text ?? "").length / 4);
    }
    completion = Math.min(completion, body.max_tokens ?? completion);
    const timings = { cache_n: cached, prompt_n: promptTokens - cached, prompt_ms: (promptTokens - cached) / 2, ttft_ms: (promptTokens - cached) / 2 + 5, predicted_n: completion };
    if (!(a.tool !== undefined && options.wholeToolCalls === true)) pieces.push(event({ choices: [{ index: 0, delta: {}, finish_reason: a.tool !== undefined ? "tool_calls" : "stop" }], timings }));
    pieces.push(event({ choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: completion, total_tokens: promptTokens + completion, prompt_tokens_details: { cached_tokens: cached } }, timings }));
    pieces.push(enc.encode("data: [DONE]\n\n"));
    const slow = a.slow === true || a.tool !== undefined;
    let next = 0;
    signal?.addEventListener("abort", () => { state.aborted++; leave(); }, { once: true });
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (signal?.aborted === true) { leave(); controller.error(new DOMException("aborted", "AbortError")); return; }
        if (next >= pieces.length) { leave(); controller.close(); return; }
        if (slow && next > 0) await sleep(pieceMs);
        controller.enqueue(pieces[next++]!);
      },
      cancel() { state.aborted++; leave(); },
    }, { highWaterMark: 0 });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof globalThis.fetch;
  return { fetch, requests, state };
}
