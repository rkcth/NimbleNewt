import { safeText, type FromChild, type HeaderList, type ToChild } from "@nimblenewt/contracts";

/**
 * The `fetch` of the worker process (card H12b). The sandbox has no network, so every model call is sent over the channel to the host's relay, which makes it (with the provider's credential, which this process never sees) and sends the reply back in pieces.
 * Only addresses under the relay's own base are accepted; any other address fails at once, as it would in a sandbox with no network.
 */

interface Pending {
  stream?: ReadableStream<Uint8Array>;
  head?: (response: Response) => void;
  fail: (error: unknown) => void;
  chunk?: (bytes: Uint8Array) => void;
  end?: () => void;
  errorStream?: (error: unknown) => void;
}

export interface RelayFetch {
  readonly fetch: typeof globalThis.fetch;
  /** Feeds a message from the host that belongs to a call in flight. Returns false for any other message. */
  accept(message: ToChild): boolean;
  /** Latches the relay closed (the lease ended): every later call fails before anything is sent. Does not touch calls in flight; `closeAll` does. */
  refuse(reason: string): void;
  /** Fails every call in flight (the channel ended). */
  closeAll(reason: string): void;
  /**
   * W09 fixes: from the next call on, a model request (a POST whose body is a JSON object that names a reply limit, `max_tokens` or `max_completion_tokens`) whose limit is below `tokens` is sent with `tokens` instead. Raises only, never
   * lowers; undefined turns it off. The host's relay still applies the route's own budget after it (an owner's reply limit wins there).
   */
  raiseReplyLimit(tokens: number | undefined, window?: number): void;
}

/** Pi's margin between the window and the request plus its reply (pi-ai `CONTEXT_SAFETY_TOKENS`; `PI_CONTEXT_SAFETY_TOKENS` in compaction-thresholds.ts). */
const REPLY_SAFETY_TOKENS = 4096;

/** A model request's body with its reply limit raised to `floor` (in the field the request uses), or the body unchanged when it is not a JSON object, names no reply limit, or already asks for at least `floor`. */
export function withReplyFloor(body: Buffer, floor: number, window?: number): Buffer {
  let json: unknown;
  try { json = JSON.parse(body.toString("utf8")); } catch { return body; }
  if (json === null || typeof json !== "object" || Array.isArray(json)) return body;
  const o = json as Record<string, unknown>;
  const field = typeof o["max_completion_tokens"] === "number" ? "max_completion_tokens" : typeof o["max_tokens"] === "number" ? "max_tokens" : undefined;
  if (field === undefined) return body;
  const asked = o[field] as number;
  // Never past the window: Pi sizes its own limit as window - estimated input - its 4,096-token margin, and so does this, with the input counted as one token for every 3 bytes of the request (more than it holds).
  const room = window === undefined ? floor : Math.min(floor, window - Math.ceil(body.length / 3) - REPLY_SAFETY_TOKENS);
  if (asked >= room) return body;
  o[field] = room;
  return Buffer.from(JSON.stringify(o), "utf8");
}

const abortError = (): Error => { const e = new Error("The operation was aborted"); e.name = "AbortError"; return e; };
const BODYLESS = new Set([101, 204, 205, 304]);

export function relayFetch(relayBase: string, send: (message: FromChild) => void): RelayFetch {
  const base = relayBase.replace(/\/+$/, "");
  const pending = new Map<number, Pending>();
  let next = 0;
  let refusing: string | undefined;
  let replyFloor: number | undefined;
  let replyWindow: number | undefined;

  const call = async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit): Promise<Response> => {
    if (refusing !== undefined) throw new TypeError(`fetch failed: ${refusing}`);
    const request = typeof input === "object" && "url" in input && "method" in input ? (input as Request) : undefined;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (!url.startsWith(`${base}/`)) throw new TypeError(`fetch failed: there is no network here; only ${base}/ can be reached`);
    const signal = init?.signal ?? request?.signal ?? undefined;
    if (signal?.aborted) throw abortError();
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers ?? request?.headers);
    const raw = init?.body ?? (request === undefined ? undefined : await request.arrayBuffer());
    let body: Buffer | undefined;
    if (raw === undefined || raw === null) body = undefined;
    else if (typeof raw === "string") body = Buffer.from(raw, "utf8");
    else if (raw instanceof ArrayBuffer) body = Buffer.from(raw);
    else if (ArrayBuffer.isView(raw)) body = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    else throw new TypeError("fetch failed: the request body must be text or bytes");
    if (replyFloor !== undefined && method === "POST" && body !== undefined && body.length > 0) body = withReplyFloor(body, replyFloor, replyWindow);
    const id = ++next;
    const list: HeaderList = [...headers.entries()].map(([k, v]) => [k, v] as const);
    return await new Promise<Response>((resolve, reject) => {
      const entry: Pending = { fail: reject };
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          entry.chunk = (bytes) => { try { controller.enqueue(bytes); } catch { /* the reader has gone */ } };
          entry.end = () => { try { controller.close(); } catch { /* already closed */ } };
          entry.errorStream = (error) => { try { controller.error(error); } catch { /* already closed */ } };
        },
        cancel() { if (pending.delete(id)) send({ t: "fetch.abort", id }); },
      });
      entry.head = (response) => resolve(response);
      pending.set(id, entry);
      const onAbort = (): void => {
        if (!pending.delete(id)) return;
        send({ t: "fetch.abort", id });
        reject(abortError());
        entry.errorStream?.(abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      entry.stream = stream;
      send({ t: "fetch", id, url, method, headers: list, ...(body === undefined || body.length === 0 ? {} : { body: body.toString("base64") }) });
    });
  };

  return {
    fetch: call as typeof globalThis.fetch,
    raiseReplyLimit(tokens, window) { replyFloor = tokens !== undefined && Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined; replyWindow = window !== undefined && Number.isSafeInteger(window) && window > 0 ? window : undefined; },
    accept(message) {
      switch (message.t) {
        case "fetch.head": {
          const entry = pending.get(message.id);
          if (entry === undefined) return true;
          const stream = entry.stream;
          const bodyless = BODYLESS.has(message.status);
          entry.fail = () => undefined;
          entry.head?.(new Response(bodyless ? null : (stream ?? null), { status: message.status, statusText: message.statusText, headers: message.headers.map(([k, v]) => [k, v] as [string, string]) }));
          if (bodyless) pending.delete(message.id);
          return true;
        }
        case "fetch.chunk": pending.get(message.id)?.chunk?.(new Uint8Array(Buffer.from(message.data, "base64"))); return true;
        case "fetch.end": { const entry = pending.get(message.id); pending.delete(message.id); entry?.end?.(); return true; }
        case "fetch.error": {
          const entry = pending.get(message.id);
          pending.delete(message.id);
          if (entry === undefined) return true;
          const error = new TypeError(`fetch failed: ${safeText(message.message, 1000)}`);
          entry.fail(error);
          entry.errorStream?.(error);
          return true;
        }
        default: return false;
      }
    },
    refuse(reason) { refusing ??= reason; },
    closeAll(reason) {
      for (const [id, entry] of [...pending]) {
        pending.delete(id);
        const error = new TypeError(`fetch failed: ${reason}`);
        entry.fail(error);
        entry.errorStream?.(error);
      }
    },
  };
}
