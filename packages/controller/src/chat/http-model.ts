import { classifyProviderFailure } from "../routing/fallback.js";
import { redactText } from "../security/redact.js";
import type { ModelEndpoint } from "../dispatch/relay.js";
import type { ModelCall } from "./model-interpreter.js";

/**
 * The chat's model call over an OpenAI-compatible endpoint (card U03b): the owner's configured endpoint for a route (the same configuration the worker relay uses, with the credential read at each call), one non-streamed
 * completion with no randomness, a bounded reply, a time limit. A failure is thrown with its class (R02's `classifyProviderFailure`: credit, rate limit, outage, auth, ...) so the caller can fall back to the next route; the
 * message never carries the credential or the endpoint's reply beyond a short redacted piece. The call has no tools and no side effects, so a retry on another route repeats nothing.
 */
export interface HttpModelOptions {
  /** The endpoint of a route (`provider/model`); `undefined` when the route has none. */
  readonly endpoint: (route: string) => ModelEndpoint | undefined;
  /** The model name sent for a route. Default: the part of the route after the first `/`. */
  readonly model?: (route: string) => string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly maxReplyTokens?: number;
  /** Told of each failure (route, class, redacted text), for the log. */
  readonly onFailure?: (route: string, failure: string, text: string) => void;
}

const MAX_REPLY_BYTES = 1024 * 1024;

export class HttpModelCall implements ModelCall {
  readonly #o: HttpModelOptions;
  constructor(options: HttpModelOptions) { this.#o = options; }

  async complete(route: string, request: { readonly system: string; readonly user: string }): Promise<string> {
    const endpoint = this.#o.endpoint(route);
    if (endpoint === undefined) throw new Error(`route ${route.slice(0, 60)} has no endpoint`);
    const fail = (status: number | undefined, message: string): never => {
      const text = redactText(message).slice(0, 300);
      const kind = classifyProviderFailure({ message: text, ...(status === undefined ? {} : { status }) });
      this.#o.onFailure?.(route, kind, text);
      throw new Error(`${kind}: ${text}`);
    };
    const headers = new Headers({ "content-type": "application/json", accept: "application/json" });
    try { for (const [k, v] of Object.entries(await endpoint.headers?.() ?? {})) headers.set(k, v); } catch { return fail(undefined, "the endpoint's credentials could not be read"); }
    const model = this.#o.model?.(route) ?? route.slice(route.indexOf("/") + 1);
    let response: Response;
    try {
      response = await (this.#o.fetch ?? globalThis.fetch)(`${endpoint.url.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST", headers, redirect: "error", signal: AbortSignal.timeout(this.#o.timeoutMs ?? 60_000),
        body: JSON.stringify({ model, temperature: 0, stream: false, max_tokens: this.#o.maxReplyTokens ?? 1500, messages: [{ role: "system", content: request.system }, { role: "user", content: request.user }] }),
      });
    } catch (error) { return fail(undefined, error instanceof Error ? error.message : String(error)); }
    const text = await readBounded(response);
    if (!response.ok) return fail(response.status, text.slice(0, 300));
    let content: unknown;
    try { content = (JSON.parse(text) as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content; } catch { return fail(undefined, "the reply was not JSON"); }
    if (typeof content !== "string" || content === "") return fail(undefined, "the reply held no text");
    return content;
  }
}

async function readBounded(response: Response): Promise<string> {
  if (response.body === null) return "";
  const parts: Buffer[] = []; let size = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > MAX_REPLY_BYTES) { await response.body.cancel().catch(() => undefined); break; }
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts).toString("utf8");
}
