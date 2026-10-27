import { redactText } from "../security/redact.js";
import type { PiCachePolicy } from "../inference-cache/index.js";

/**
 * The model relay (card H12b). The worker process runs in a sandbox with no network, so the model calls of its Pi conversation are made here, on its behalf, by the controller's side of the channel. The relay is a narrow pipe, not a proxy: a call is
 * accepted only for the address the attempt was given (its own route's alias), is sent only to the endpoint the owner configured for that route, carries only the few headers a model API needs, and gets the provider's credential from the endpoint's
 * configuration, which the process never sees. The cache policy of the attempt (card H12e) is applied here, around the call, exactly as it was when Pi made the call itself: the body edit that puts the backend's cache settings in, and the wrapper with the
 * endpoint's cache state (slot turns, holders, markers). The reply is handed back as it arrives, not collected first.
 */

export interface RelayRequest { readonly url: string; readonly method: string; readonly headers: readonly (readonly [string, string])[]; readonly body: Uint8Array | undefined; readonly signal: AbortSignal }
export interface RelayResponse { readonly status: number; readonly statusText: string; readonly headers: readonly (readonly [string, string])[]; readonly body: AsyncIterable<Uint8Array> | null }

/** Where a route's model calls really go. The credential is read at each call, so a rotated one is used from the next call. */
export interface ModelEndpoint {
  /** The API's base address, such as `http://llama:8080/v1`. */
  readonly url: string;
  readonly headers?: () => Promise<Readonly<Record<string, string>>> | Readonly<Record<string, string>>;
}

export interface ModelRelayOptions {
  /** The owner's endpoint for a route (`provider/model`); `undefined` when the route has none (a call is then refused). */
  readonly endpoint: (route: string) => ModelEndpoint | undefined;
  /** The fetch used to reach the endpoints (default: the global one). */
  readonly fetch?: typeof globalThis.fetch;
  /** The address the process uses (default `http://relay.invalid`). */
  readonly relayBase?: string;
  readonly maxBodyBytes?: number;
  /** Told when a call fails (redacted); the process gets the same text as the failure of its call. */
  readonly onError?: (route: string, message: string) => void;
}

/**
 * What the relay tells about every model call it makes for an attempt (card V01b), so stall detection can tell a model that is reading a big prompt or writing slowly from one that has stopped. Every function must return at once and
 * must not throw (a throw is ignored, and the call is not affected).
 */
export interface RelayMonitor {
  /** The call is about to be sent. `requestChars` is the size of the body. */
  started(call: { readonly requestChars: number }): void;
  /** The first bytes of the reply arrived. */
  firstOutput(): void;
  /** At most once in `progressMs` while the reply streams: the bytes of reply received so far. */
  progress(bytes: number): void;
  /** The call ended: with `ok` false it failed, was refused or was cancelled. The counts are what the provider reported, when it did. */
  finished(call: { readonly ok: boolean; readonly inputTokens?: number; readonly cachedTokens?: number; readonly outputTokens?: number }): void;
}

export interface AttemptRelay {
  /** The alias the process addresses the route by (`<relayBase>/<alias>/...`). */
  readonly alias: string;
  readonly relayBase: string;
  relay(request: RelayRequest): Promise<RelayResponse>;
}

const SEND = new Set(["content-type", "accept", "anthropic-version", "user-agent"]);
/** The only paths a model API call needs; anything else (files, batches, fine-tuning, account endpoints) would spend the owner's key on more than this attempt's conversation. */
const PATHS = new Set(["chat/completions", "messages", "messages/count_tokens"]);
const KEEP = new Set(["content-type", "retry-after", "retry-after-ms", "x-should-retry", "request-id", "x-request-id"]);
const ALIAS = "m0";

export class ModelRelay {
  readonly #options: ModelRelayOptions;
  readonly #base: string;

  constructor(options: ModelRelayOptions) {
    this.#options = options;
    this.#base = (options.relayBase ?? "http://relay.invalid").replace(/\/+$/, "");
  }

  /** The relay for one attempt: it can reach its route's endpoint and nothing else. `cache` is the attempt's policy (H12e), applied around each call. */
  forAttempt(attempt: {
    readonly route: string;
    /** The model the route names; a body that asks for another is refused. */ readonly model?: string;
    /** Told once, after the attempt's first model call has been answered, what the provider reported as its input size and how long the request was (card C07b: the first call is checked against the provider's own count). A failure of this function never reaches the call. */
    readonly onFirstUsage?: (usage: { readonly inputTokens: number; readonly requestChars: number }) => void;
    /** Told how each call goes (card V01b). */
    readonly monitor?: RelayMonitor;
    /** The least time between two progress reports of one reply (default 15 seconds). */
    readonly progressMs?: number;
  }, cache?: Pick<PiCachePolicy, "payload" | "fetch">): AttemptRelay {
    const route = attempt.route;
    const maxBody = this.#options.maxBodyBytes ?? 8 * 1024 * 1024;
    const prefix = `${this.#base}/${ALIAS}/`;
    let firstCall = attempt.onFirstUsage !== undefined;
    const refuse = (why: string): never => { throw new Error(`the model relay refused the call: ${why}`); };
    return {
      alias: ALIAS, relayBase: this.#base,
      relay: async (request) => {
        if (request.method !== "POST") refuse(`method ${request.method.slice(0, 10)} is not allowed`);
        if (request.url.length > 2000 || !request.url.startsWith(prefix)) refuse("that address is not this attempt's model");
        let parsed: URL;
        try { parsed = new URL(request.url); } catch { return refuse("the address is not valid"); }
        if (parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") refuse("the address carries credentials");
        // Checked on the address as sent: `new URL` would fold ".." away and hide it.
        const rest = request.url.slice(prefix.length).split(/[?#]/)[0]!;
        if (rest.split("/").some((s) => s === ".." || s === "." || s === "") || /%2e|%2f|%5c|\\/i.test(rest) || parsed.pathname !== `/${ALIAS}/${rest}`) refuse("the path is not allowed");
        if (!PATHS.has(rest) || parsed.search !== "") refuse("only the model API's own calls are allowed");
        const endpoint = this.#options.endpoint(route);
        if (endpoint === undefined) refuse(`route ${route.slice(0, 60)} has no endpoint`);
        const target = `${endpoint!.url.replace(/\/+$/, "")}/${rest}`;
        if (request.body !== undefined && request.body.length > maxBody) refuse("the request is too large");
        const headers = new Headers();
        for (const [name, value] of request.headers) if (SEND.has(name.toLowerCase())) headers.set(name, value);
        try { for (const [name, value] of Object.entries(await endpoint!.headers?.() ?? {})) headers.set(name, value); } catch (error) {
          const text = redactText(error instanceof Error ? error.message : String(error)).slice(0, 300);
          this.#options.onError?.(route, text);
          throw new Error("the model endpoint's credentials could not be read");
        }
        let body: Uint8Array | undefined = request.body;
        if (attempt.model !== undefined) {
          let asked: unknown;
          try { asked = (JSON.parse(Buffer.from(body ?? new Uint8Array()).toString("utf8")) as { model?: unknown }).model; } catch { return refuse("the body is not JSON"); }
          if (asked !== attempt.model) refuse("the body names another model");
        }
        if (body !== undefined && cache?.payload !== undefined && /json/i.test(headers.get("content-type") ?? "")) {
          // The backend's cache settings go into the body here, as they did when Pi made the call itself. A body that is not a JSON object is sent as it is.
          try {
            const shaped = cache.payload(JSON.parse(Buffer.from(body).toString("utf8")) as unknown);
            body = Buffer.from(JSON.stringify(shaped), "utf8");
          } catch { /* sent unchanged */ }
        }
        const inner = this.#options.fetch ?? globalThis.fetch;
        const wrapped = cache?.fetch === undefined ? inner : cache.fetch(inner);
        const monitor = rest === "messages/count_tokens" ? undefined : attempt.monitor;
        const tell = (f: () => void): void => { try { f(); } catch { /* the call is not affected */ } };
        if (monitor !== undefined) tell(() => monitor.started({ requestChars: body?.length ?? 0 }));
        let response: Response;
        try {
          response = await wrapped(target, { method: request.method, headers, ...(body === undefined || request.method === "GET" ? {} : { body: Buffer.from(body) }), signal: request.signal, redirect: "error" });
        } catch (error) {
          const text = redactText(error instanceof Error ? error.message : String(error)).slice(0, 300);
          this.#options.onError?.(route, text);
          if (monitor !== undefined) tell(() => monitor.finished({ ok: false }));
          throw new Error(`the model endpoint could not be reached: ${text}`);
        }
        if (monitor !== undefined && (!response.ok || response.body === null)) tell(() => monitor.finished({ ok: response.ok }));
        const watch = firstCall && response.ok && response.body !== null && rest !== "messages/count_tokens";
        if (watch) firstCall = false;
        const requestChars = body?.length ?? 0;
        const out: [string, string][] = [];
        response.headers.forEach((value, name) => { if (KEEP.has(name.toLowerCase())) out.push([name, value]); });
        const watching = monitor !== undefined && response.ok && response.body !== null;
        if (!watch && !watching) return { status: response.status, statusText: response.statusText, headers: out, body: response.body === null ? null : (response.body as unknown as AsyncIterable<Uint8Array>) };
        const hooks: ReplyHooks = {
          ...(watch ? { inputTokens: (tokens) => { try { attempt.onFirstUsage?.({ inputTokens: tokens, requestChars }); } catch { /* the call is not affected */ } } } : {}),
          ...(watching ? { monitor: { first: () => tell(() => monitor!.firstOutput()), progress: (bytes) => tell(() => monitor!.progress(bytes)), finished: (call) => tell(() => monitor!.finished(call)) }, progressMs: attempt.progressMs ?? 15_000 } : {}),
        };
        return { status: response.status, statusText: response.statusText, headers: out, body: reporting(response.body as unknown as AsyncIterable<Uint8Array>, hooks) };
      },
    };
  }
}

const SCAN = 16 * 1024;
interface ReplyHooks {
  /** The provider's input size, once the reply has ended normally. */
  readonly inputTokens?: (tokens: number) => void;
  readonly monitor?: { first(): void; progress(bytes: number): void; finished(call: { ok: boolean; inputTokens?: number; cachedTokens?: number; outputTokens?: number }): void };
  readonly progressMs?: number;
}
/**
 * Passes the reply on unchanged and, when it has ended normally, tells the hooks the input size the provider reported in it, read from the first and the last bytes of the reply (a plain reply is small; a stream reports at its start
 * or its end). OpenAI-style `prompt_tokens` already includes cached tokens; Anthropic-style `input_tokens` leaves them out, so the cache read and creation counts are added. A reply that is cancelled part way, a number cut by the
 * edge of what is read, or no count at all, tells nothing about the size. The monitor (card V01b) is told when the first bytes arrive, at a bounded interval how many bytes have, and at the end (normal, failed or cancelled) the counts.
 */
async function* reporting(body: AsyncIterable<Uint8Array>, hooks: ReplyHooks): AsyncGenerator<Uint8Array> {
  const head: Buffer[] = []; let headBytes = 0; let tail = Buffer.alloc(0);
  let bytes = 0; let lastProgress = Date.now(); let first = true; let ended = false;
  try {
    for await (const piece of body) {
      if (headBytes < SCAN) { head.push(Buffer.from(piece.subarray(0, SCAN - headBytes))); headBytes += Math.min(piece.length, SCAN - headBytes); }
      tail = Buffer.concat([tail, piece.length > SCAN ? piece.subarray(-SCAN) : piece]).subarray(-SCAN);
      bytes += piece.length;
      if (hooks.monitor !== undefined && piece.length > 0) {
        if (first) { first = false; hooks.monitor.first(); lastProgress = Date.now(); }
        else if (Date.now() - lastProgress >= (hooks.progressMs ?? 15_000)) { lastProgress = Date.now(); hooks.monitor.progress(bytes); }
      }
      yield piece;
    }
    ended = true;
  } finally {
    // Cancelled or failed part way: the monitor is told it did not end well.
    if (!ended) hooks.monitor?.finished({ ok: false });
  }
  const text = `${Buffer.concat(head).toString("utf8")}\u0001${tail.toString("utf8")}`;
  const most = (name: string): number => { let best = 0; for (const m of text.matchAll(new RegExp(`"${name}"\\s*:\\s*(\\d{1,9})(?=[,}\\s])`, "g"))) best = Math.max(best, Number(m[1])); return best; };
  const cached = most("cache_read_input_tokens") + most("cache_creation_input_tokens");
  const total = most("prompt_tokens") || most("input_tokens") + cached;
  const output = most("completion_tokens") || most("output_tokens");
  const cachedOpenAi = most("cached_tokens");
  if (total >= 1) hooks.inputTokens?.(total);
  hooks.monitor?.finished({ ok: true, ...(total >= 1 ? { inputTokens: total } : {}), ...(cached + cachedOpenAi >= 1 ? { cachedTokens: cached + cachedOpenAi } : {}), ...(output >= 1 ? { outputTokens: output } : {}) });
}
