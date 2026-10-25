import type { FromChild, HeaderList, ToChild } from "@nimblenewt/contracts";

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
  /** Fails every call in flight (the channel ended). */
  closeAll(reason: string): void;
}

const abortError = (): Error => { const e = new Error("The operation was aborted"); e.name = "AbortError"; return e; };
const BODYLESS = new Set([101, 204, 205, 304]);

export function relayFetch(relayBase: string, send: (message: FromChild) => void): RelayFetch {
  const base = relayBase.replace(/\/+$/, "");
  const pending = new Map<number, Pending>();
  let next = 0;

  const call = async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit): Promise<Response> => {
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
          const error = new TypeError(`fetch failed: ${message.message}`);
          entry.fail(error);
          entry.errorStream?.(error);
          return true;
        }
        default: return false;
      }
    },
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
