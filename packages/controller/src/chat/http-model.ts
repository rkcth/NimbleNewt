import { applyRouteBudget } from "../dispatch/route-budget.js";
import { classifyProviderFailure } from "../routing/fallback.js";
import { redactText } from "../security/redact.js";
import type { ModelEndpoint } from "../dispatch/relay.js";
import type { ModelCall, ModelReply } from "./model-interpreter.js";

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
  /**
   * Per-route limits, read at each call (the W09 fixes: the second agent's client gives each route the reply limit, ceiling, time limit and reasoning cap of `reviewerCallLimits`). When given, they replace `maxReplyTokens` and
   * `timeoutMs`; a reply cut at its limit with no text (`finish_reason` `length`) is asked once more at `ceilingTokens` within the same time limit, and when it is still cut (or the ceiling is the limit) the call fails as
   * `reply-cut`. A reasoning cap is sent in the field the endpoint's kind names (card W07's table); a server that refuses that field (a vLLM without its reasoning parser) is asked once more without it.
   * Without `limits` the call is as before: one request, a reply with no text is a failure.
   */
  readonly limits?: (route: string) => HttpCallLimits | undefined | Promise<HttpCallLimits | undefined>;
  /** Told of each failure (route, class, redacted text), for the log. */
  readonly onFailure?: (route: string, failure: string, text: string) => void;
}

export interface HttpCallLimits {
  readonly replyTokens: number;
  readonly ceilingTokens?: number;
  readonly timeoutMs: number;
  readonly reasoningTokens?: number;
  readonly kind?: string;
}

const MAX_REPLY_BYTES = 1024 * 1024;

export class HttpModelCall implements ModelCall {
  readonly #o: HttpModelOptions;
  constructor(options: HttpModelOptions) { this.#o = options; }

  async complete(route: string, request: { readonly system: string; readonly user: string }): Promise<string> { return (await this.completeDetailed(route, request)).text; }

  async completeDetailed(route: string, request: { readonly system: string; readonly user: string }): Promise<ModelReply> {
    const endpoint = this.#o.endpoint(route);
    if (endpoint === undefined) throw new Error(`route ${route.slice(0, 60)} has no endpoint`);
    // The tokens the server counted for this call's replies so far (a reply cut before any text and asked again is still paid for).
    let input = 0, output = 0, counted = false;
    const fail = (status: number | undefined, message: string, named?: string): never => {
      const text = redactText(message).slice(0, 300);
      const kind = named ?? classifyProviderFailure({ message: text, ...(status === undefined ? {} : { status }) });
      this.#o.onFailure?.(route, kind, text);
      const error = new Error(`${kind}: ${text}`);
      // A failed call whose replies the server counted carries those tokens (`failedUsage`), so the daily cap counts them too.
      if (counted && input + output > 0) Object.defineProperty(error, "usage", { value: { inputTokens: input, outputTokens: output }, enumerable: false });
      throw error;
    };
    let limits: HttpCallLimits | undefined;
    if (this.#o.limits !== undefined) {
      try { limits = await this.#o.limits(route); } catch (error) { return fail(undefined, `the route's reply limits could not be read${error instanceof Error && error.message !== "" ? `: ${error.message}` : ""}`); }
    }
    const headers = new Headers({ "content-type": "application/json", accept: "application/json" });
    try { for (const [k, v] of Object.entries(await endpoint.headers?.() ?? {})) headers.set(k, v); } catch (error) { return fail(undefined, `the endpoint's credentials could not be read${error instanceof Error && error.message !== "" ? `: ${error.message}` : ""}`); } // the reason (a refused secret name, a missing secret) names the secret, never its value, and is redacted
    const model = this.#o.model?.(route) ?? route.slice(route.indexOf("/") + 1);
    // One time limit for the whole call: a retry after a cut reply never extends it.
    const signal = AbortSignal.timeout(limits?.timeoutMs ?? this.#o.timeoutMs ?? 60_000);
    let replyTokens = limits?.replyTokens ?? this.#o.maxReplyTokens ?? 1500;
    const ceiling = limits === undefined ? replyTokens : Math.max(replyTokens, limits.ceilingTokens ?? replyTokens);
    let reasoning = limits?.reasoningTokens !== undefined;
    for (let tries = 0; ; tries++) {
      const body: Record<string, unknown> = { model, temperature: 0, stream: false, max_tokens: replyTokens, messages: [{ role: "system", content: request.system }, { role: "user", content: request.user }] };
      const added = reasoning ? applyRouteBudget(body, "chat/completions", limits!.kind, { reasoningTokens: limits!.reasoningTokens! }).added : undefined;
      let response: Response;
      try {
        response = await (this.#o.fetch ?? globalThis.fetch)(`${endpoint.url.replace(/\/+$/, "")}/chat/completions`, { method: "POST", headers, redirect: "error", signal, body: JSON.stringify(body) });
      } catch (error) { return fail(undefined, whyFailed(error)); }
      let text: string;
      try { text = await readBounded(response); } catch (error) { return fail(undefined, whyFailed(error)); }
      // A server that refuses the reasoning field the client added (vLLM with no reasoning parser) is asked once more without it, as the worker relay does.
      if (response.status === 400 && added !== undefined && tries < 3 && text.includes(added)) { reasoning = false; continue; }
      if (!response.ok) return fail(response.status, text.slice(0, 300));
      let parsed: { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[]; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown }; error?: unknown };
      try { parsed = JSON.parse(text) as typeof parsed; } catch { return fail(undefined, "the reply was not JSON"); }
      const count = (v: unknown): number | undefined => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined);
      const inputTokens = count(parsed?.usage?.prompt_tokens), outputTokens = count(parsed?.usage?.completion_tokens);
      // A reply whose count is missing, negative or not a safe whole number (1e300 included) adds nothing, so no figure lowers the count; the sums across a call's replies are kept at the largest safe integer, so the cap's arithmetic stays exact and is reached.
      if (inputTokens !== undefined && outputTokens !== undefined) { counted = true; input = Math.min(Number.MAX_SAFE_INTEGER, input + inputTokens); output = Math.min(Number.MAX_SAFE_INTEGER, output + outputTokens); }
      const choice = parsed?.choices?.[0];
      const content = choice?.message?.content;
      if (typeof content !== "string" || content === "") {
        if (limits !== undefined && choice?.finish_reason === "length") {
          // Cut at the reply limit before any text (a reasoning model that spent the limit thinking): asked once more at the ceiling, within the same time limit.
          if (replyTokens < ceiling && tries < 3) { replyTokens = ceiling; continue; }
          return fail(undefined, `the reply was cut at the ${replyTokens}-token reply limit before it held any text${replyTokens < (limits.ceilingTokens ?? replyTokens) ? "" : " (the route's ceiling)"}`, "reply-cut");
        }
        const reason = (() => { const e = parsed?.error; return typeof e === "string" ? e : typeof e === "object" && e !== null ? String((e as { message?: unknown; code?: unknown; type?: unknown }).message ?? (e as { code?: unknown }).code ?? (e as { type?: unknown }).type ?? "") : ""; })();
        return fail(undefined, reason === "" ? "the reply held no text" : reason);
      }
      return { text: content, ...(counted ? { usage: { inputTokens: input, outputTokens: output } } : {}) };
    }
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

/** What went wrong, with the reason Node keeps in `cause` (a refused connection, a failed name lookup, a refused redirect and a timeout all arrive as "fetch failed" or a bare abort). */
function whyFailed(error: unknown): string {
  const e = error as { message?: unknown; name?: unknown; cause?: { code?: unknown; message?: unknown } };
  const cause = e?.cause == null ? "" : ` (${String(e.cause.code ?? e.cause.message ?? "").slice(0, 100)})`;
  return `${String(e?.name === "TimeoutError" ? "timed out" : e?.message ?? error)}${cause}`;
}

/** The tokens a failed call's replies used, when the HTTP client counted them (a reply cut before any text); undefined otherwise. */
export function failedUsage(error: unknown): { readonly inputTokens: number; readonly outputTokens: number } | undefined {
  const u = (error as { usage?: unknown } | null)?.usage as { inputTokens?: unknown; outputTokens?: unknown } | undefined;
  const ok = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  return u !== undefined && u !== null && typeof u === "object" && ok(u.inputTokens) && ok(u.outputTokens) ? { inputTokens: u.inputTokens, outputTokens: u.outputTokens } : undefined;
}
