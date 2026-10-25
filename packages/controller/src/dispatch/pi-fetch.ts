import { CacheAdapter, type CallResult, type EndpointState, type HttpRequest, type HttpResponse, type Transport } from "../inference-cache/adapter.js";
import type { CacheContext, CacheHit, CacheProfile, WireRequest } from "../inference-cache/profile.js";

/** The fetch the provider SDKs of Pi take (`options.fetch`). */
/** The caller's error hook must never turn bookkeeping into an unhandled rejection. */
const safely = (hook: ((error: unknown) => void) | undefined, error: unknown): void => { try { hook?.(error); } catch { /* the hook failed too: nothing more can be done */ } };

export type FetchFunction = typeof globalThis.fetch;

/** What one model call found, for the dispatcher's accounting. `result` is present when the call went through `CacheAdapter`; an observed call has only its hit. */
export interface PiCall { readonly hit: CacheHit; readonly status: number; readonly result?: CallResult }

export interface PiFetchOptions {
  readonly profile: CacheProfile;
  /** The context of the call: scope and share keys, the slot the project holds, retention, pin authorisation, isolation. */
  readonly context: () => CacheContext;
  /** Present: the call goes through `CacheAdapter` with this endpoint state (slot turns, holder checks and clearing, `prepare`, the fallback without cache settings). Absent: the call is only observed (its hit is read, nothing is changed). */
  readonly state?: EndpointState;
  readonly freshSlot?: "erase" | "off";
  /** Tokens a marker says the endpoint should still hold, to judge the outcome. */
  readonly expectedCachedTokens?: () => number;
  readonly onCall: (call: PiCall) => void;
  /** Given the bookkeeping of every call (resolved when the call has been judged and `onCall` has run), so a caller can wait for the last one before it reads the totals. */
  readonly track?: (done: Promise<void>) => void;
  /** Told when the bookkeeping around a call failed after Pi already had its answer (the answer is unaffected). */
  readonly onError?: (error: unknown) => void;
}

/**
 * The answer of an event stream or a JSON body as one object the profile can read hits from. Server-sent events carry the usage and timings in their last events (OpenAI and llama.cpp `usage` and `timings`, Anthropic's `message_start`
 * and `message_delta`, the Responses API's `response.completed`); later values replace earlier ones field by field. A body that is not JSON reads as nothing.
 */
export function responseBody(text: string, streamed: boolean): unknown {
  if (!streamed) { try { return JSON.parse(text) as unknown; } catch { return undefined; } }
  const merged: { usage?: Record<string, unknown>; timings?: Record<string, unknown> } = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "" || data === "[DONE]") continue;
    let event: unknown;
    try { event = JSON.parse(data); } catch { continue; }
    if (event === null || typeof event !== "object") continue;
    const e = event as { usage?: unknown; timings?: unknown; message?: { usage?: unknown }; response?: { usage?: unknown } };
    for (const usage of [e.usage, e.message?.usage, e.response?.usage]) if (usage !== null && typeof usage === "object") merged.usage = { ...merged.usage, ...(usage as Record<string, unknown>) };
    if (e.timings !== null && typeof e.timings === "object") merged.timings = { ...(e.timings as Record<string, unknown>) };
  }
  return merged;
}

/** Response headers for a body that was already read and decoded: the encoding and length no longer describe it. */
const decoded = (headers: Headers): Headers => { const h = new Headers(headers); h.delete("content-encoding"); h.delete("content-length"); return h; };
/** The end of the first complete server-sent event in `buf` (past its blank line), or -1. */
function eventEnd(buf: Uint8Array): number {
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === 10 && buf[i + 1] === 10) return i + 2;
    if (buf[i] === 10 && buf[i + 1] === 13 && buf[i + 2] === 10) return i + 3;
  }
  return -1;
}
/** Whether a complete event is the provider's end marker: a `data:` line that is exactly `[DONE]`, or a JSON object whose own `type` is `message_stop` or `response.completed`. Model text that merely contains these words is a different line. */
function endsAnswer(event: string): boolean {
  for (const line of event.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") return true;
    if (!payload.startsWith("{")) continue;
    try { const type = (JSON.parse(payload) as { type?: unknown }).type; if (type === "message_stop" || type === "response.completed") return true; } catch { /* a partial or foreign line is not the end */ }
  }
  return false;
}
const join = (a: Uint8Array, b: Uint8Array): Uint8Array => { const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; };

/** The request body as text, whatever shape the caller gave it (string, bytes, stream, blob, or none with a `Request` as input). Undefined when there is none or it cannot be read. */
async function bodyText(input: Parameters<FetchFunction>[0], init: RequestInit | undefined): Promise<string | undefined> {
  const body = init?.body;
  try {
    if (body === undefined || body === null) return input instanceof Request ? await input.clone().text() : undefined;
    return typeof body === "string" ? body : await new Response(body as ConstructorParameters<typeof Response>[0]).text();
  } catch { return undefined; }
}

/**
 * Pi's own HTTP calls, sent through the endpoint's cache state (card H12e). Pi's provider SDK calls `fetch(url, { body })` for a model call; this wraps that fetch so the body is handed to `CacheAdapter.call` (the same code
 * path every other C06 caller uses: slot turn, last-holder check and clearing, `profile.prepare`, fallback without cache settings, holder recorded after the call) and the adapter's transport is the real fetch. The answer is
 * streamed back to Pi as it arrives; the adapter holds the slot's turn until the stream has ended, so no other project's call can enter the slot while this one is generating. A request that is not a JSON POST (a model list,
 * anything with another body) is passed to the real fetch untouched.
 *
 * Without `state` the call is only observed: sent as Pi built it, with the hit read from the answer.
 */
export function piFetch(options: PiFetchOptions): (inner: FetchFunction) => FetchFunction {
  return (inner) => async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input instanceof Request ? input.url : undefined;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (url === undefined || method !== "POST") return inner(input, init);
    // Through the adapter the body is Pi's request whatever shape the caller gave it. A POST that cannot be read as a JSON object is refused rather than sent around the adapter: it would carry no slot and no
    // `cache_prompt: false`, and a slotted server would place it by similarity, possibly in another project's slot. Only an observed call (no state) may pass such a request on untouched.
    const routed = options.state !== undefined;
    const text = routed || typeof init?.body === "string" ? await bodyText(input, init) : undefined;
    let request: unknown;
    try { request = text === undefined ? undefined : JSON.parse(text); } catch { request = undefined; }
    if (request === null || typeof request !== "object" || Array.isArray(request)) {
      if (routed) throw new TypeError("the model call is not a JSON object, so it cannot go through the cache adapter; it was not sent");
      return inner(input, init);
    }
    const callPath = new URL(url).pathname;
    const base = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    base.delete("content-length");
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined) ?? undefined;
    // Pi's cancel of its branch, and its own abort, both stop the request: a server that keeps generating for a reader that left holds the slot for nothing.
    const stop = new AbortController();
    const signal = callerSignal == null ? stop.signal : AbortSignal.any([stop.signal, callerSignal]);

    let early: { resolve(r: Response): void; reject(e: unknown): void } | undefined;
    const answer = new Promise<Response>((resolve, reject) => { early = { resolve, reject }; });
    let settled = false;
    const give = (r: Response): void => { if (!settled) { settled = true; early!.resolve(r); } };
    let last: { status: number; statusText: string; headers: Headers; text: string } | undefined;

    const transport: Transport = {
      async send(r: HttpRequest): Promise<HttpResponse> {
        const main = r.method === "POST" && r.path === callPath;
        const headers = new Headers(base);
        for (const [k, v] of Object.entries(r.headers)) headers.set(k, v);
        if (r.method === "POST") headers.set("content-type", "application/json");
        // A call whose caller left while it waited for the slot's turn is not sent at all.
        signal.throwIfAborted();
        const res = await inner(main ? url : new URL(r.path, url).href, { method: r.method, headers, ...(r.method === "POST" ? { body: JSON.stringify(r.body) } : {}), signal });
        const streamed = (res.headers.get("content-type") ?? "").includes("text/event-stream");
        if (main && res.ok && streamed && res.body !== null) {
          // Pi gets the stream now; the adapter gets the text when the answer has ended, and keeps the slot's turn until then. The end is the provider's end marker (not the connection closing, which a proxy or
          // keep-alive may never do), or Pi leaving, or the stream ending: at any of these the connection is dropped and the turn is released.
          const source = res.body.getReader(); const decoder = new TextDecoder();
          let collected = ""; let left = false; let toPi!: ReadableStreamDefaultController<Uint8Array>;
          const piSide = new ReadableStream<Uint8Array>({ start: (c) => { toPi = c; }, cancel: () => { left = true; stop.abort(); void source.cancel().catch(() => undefined); } });
          give(new Response(piSide, { status: res.status, statusText: res.statusText, headers: decoded(res.headers) }));
          try {
            // Whole events only are judged: the end is a complete event, forwarded to Pi up to and including its blank line, and nothing after it.
            let held: Uint8Array = new Uint8Array(0); let ended = false;
            while (!ended) {
              const { done, value } = await source.read();
              if (done) break;
              held = join(held, value);
              for (let cut = eventEnd(held); cut >= 0 && !ended; cut = eventEnd(held)) {
                const event = held.slice(0, cut); held = held.slice(cut);
                const text = decoder.decode(event);
                collected += text;
                if (!left) toPi.enqueue(event);
                ended = endsAnswer(text);
              }
            }
            if (!ended && held.length > 0) { collected += decoder.decode(held); if (!left) toPi.enqueue(held); }
            if (!left) toPi.close();
          } catch (error) {
            if (!left) { toPi.error(error); throw error; }
          } finally { void source.cancel().catch(() => undefined); stop.abort(); }
          return { status: res.status, body: responseBody(collected, true) };
        }
        const answerText = await res.text();
        if (main) last = { status: res.status, statusText: res.statusText, headers: decoded(res.headers), text: answerText };
        const body = responseBody(answerText, false);
        return { status: res.status, body: body ?? (res.ok ? {} : { error: { message: answerText.slice(0, 2000) } }) };
      },
    };

    const run = async (): Promise<PiCall> => {
      if (options.state === undefined) {
        const sent = await transport.send({ method: "POST", path: callPath, headers: {}, body: request as WireRequest });
        return { hit: sent.status < 400 ? options.profile.read(sent.body) : options.profile.read(undefined), status: sent.status };
      }
      const adapter = new CacheAdapter(options.profile, transport, { path: callPath, state: options.state, ...(options.freshSlot === undefined ? {} : { freshSlot: options.freshSlot }) });
      const result = await adapter.call(request as WireRequest, options.context(), options.expectedCachedTokens?.() ?? 0);
      return { hit: result.hit, status: result.status, result };
    };
    // A caller that aborts while its call still waits for the slot's turn is answered at once (the call itself is not sent when its turn comes).
    const onAbort = (): void => { if (!settled) { settled = true; early!.reject(callerSignal!.reason ?? new DOMException("aborted", "AbortError")); } };
    if (callerSignal != null) { if (callerSignal.aborted) onAbort(); else callerSignal.addEventListener("abort", onAbort, { once: true }); }
    const finished = run().finally(() => callerSignal?.removeEventListener("abort", onAbort)).then(
      (call) => {
        // The last answer of the call, when no stream was given to Pi (an error status, or a plain JSON body).
        if (last !== undefined) give(new Response(last.text, { status: last.status, statusText: last.statusText, headers: last.headers }));
        try { options.onCall(call); } catch (error) { safely(options.onError, error); }
      },
      (error: unknown) => { if (settled) { if (callerSignal?.aborted !== true) safely(options.onError, error); } else { settled = true; early!.reject(error); } },
    );
    options.track?.(finished);
    return answer;
  };
}
