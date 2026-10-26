import type { JsonValue } from "./index.js";

/**
 * The channel between the controller's worker host and the worker process that runs an attempt's Pi conversation inside the sandbox (card H12b). The sandbox has no network and the process holds only its task credential, so everything it needs from outside
 * goes over this one channel as JSON lines (standard input and output): the bridge requests of the protected tool bridge (T06) and the model calls, which a relay on the host side makes for it. Neither side trusts the other's lines: each is parsed and checked
 * here, and a line that does not fit is a `ChannelError`, never an exception from deep inside a handler.
 */

export const WORKER_CHANNEL_VERSION = 1;
/** The longest line either side accepts, in bytes. A model reply is sent in pieces, so no line is that large. */
export const MAX_CHANNEL_LINE_BYTES = 4 * 1024 * 1024;

export class ChannelError extends Error {
  constructor(message: string) { super(message); this.name = "ChannelError"; }
}

type Obj = { readonly [key: string]: JsonValue };

/** The model the process is to use: the alias it addresses it by (a path segment of the relay's address), and what Pi needs to know about it. */
export interface ChannelModel {
  /** The alias in the relay address: `<relayBase>/<alias>/...`. The host maps it to the real endpoint; the process never learns that. */
  readonly alias: string;
  readonly provider: string;
  /** The Pi API the endpoint speaks (`openai-completions`, `anthropic-messages`, ...). */
  readonly api: string;
  readonly modelId: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly reasoning: boolean;
  readonly input: readonly ("text" | "image")[];
}

/** What the host tells the process when it starts. The credential is the task's own, shown to the process once and never anything else of the controller's. */
/** Context limits the host sets for the process (card C07b); each absent field leaves Pi's own default. */
export interface ChannelContext {
  /** The model stream's timeout, and the provider SDK's retries inside one request. */
  readonly streamTimeoutMs?: number;
  readonly streamMaxRetries?: number;
  /** The most one tool result may hold before it is cut (Pi's output limits). */
  readonly toolOutputBytes?: number;
  readonly toolOutputLines?: number;
  /**
   * Compaction through Pi's `beforeCompact` hook: `timeoutMs` is the hook's own short ceiling; `extractive` makes the process write the summary itself (the start and the end of what is replaced, cut to a bound) instead of asking the model that is already
   * out of room. Without `extractive` Pi's own summariser runs.
   */
  readonly compaction?: { readonly timeoutMs?: number; readonly fallback?: "extractive" };
}

export interface ChannelStart {
  readonly attemptId: string;
  readonly agentId: string;
  /** The id part of the agent's own tool namespace (`a_<id>__...`) as the catalogue derives it; the process names its personal tools with it. */
  readonly namespaceId: string;
  readonly credential: string;
  /** The directory (as the process sees it) where the Pi conversation is stored, inside the agent's own home. */
  readonly storeDir: string;
  readonly model: ChannelModel;
  /** The cache key and retention the host derived for this attempt's route (opaque; nothing here can be used to reach another project's cache). */
  readonly cache?: { readonly key?: string; readonly retention?: "none" | "short" | "long" };
  /** The address the process uses for model calls. Calls to anything else fail: the sandbox has no network. */
  readonly relayBase: string;
  readonly context?: ChannelContext;
}

export type BridgeReplyMessage = { readonly ok: true; readonly result: Obj } | { readonly ok: false; readonly code: string; readonly message: string };
export type HeaderList = readonly (readonly [string, string])[];

/** Host to process. */
export type ToChild =
  | { readonly t: "start"; readonly v: number; readonly start: ChannelStart }
  /** Run the turn: the text to answer and the request ID of the turn (the same attempt always names the same request, so a restart finds the original). */
  | { readonly t: "run"; readonly requestId: string; readonly content: string }
  | { readonly t: "checkpoint"; readonly id: number }
  | { readonly t: "tell"; readonly id: number; readonly text: string }
  | { readonly t: "close" }
  | { readonly t: "bridge.reply"; readonly id: number; readonly reply: BridgeReplyMessage }
  | { readonly t: "fetch.head"; readonly id: number; readonly status: number; readonly statusText: string; readonly headers: HeaderList }
  /** A piece of the model's reply body, base64. */
  | { readonly t: "fetch.chunk"; readonly id: number; readonly data: string }
  | { readonly t: "fetch.end"; readonly id: number }
  | { readonly t: "fetch.error"; readonly id: number; readonly message: string };

/** Process to host. */
export type FromChild =
  /** `toolSchemaChars`: the size of the tools as offered to the model; `systemPromptChars` when the process knows it (card H12f: context admission). */
  | { readonly t: "ready"; readonly v: number; readonly toolSchemaChars?: number; readonly systemPromptChars?: number }
  | { readonly t: "bridge"; readonly id: number; readonly token: string; readonly request: { readonly op: string; readonly callId: string; readonly args?: Obj } }
  | { readonly t: "fetch"; readonly id: number; readonly url: string; readonly method: string; readonly headers: HeaderList; readonly body?: string }
  | { readonly t: "fetch.abort"; readonly id: number }
  | { readonly t: "result"; readonly status: "completed" | "failed" | "cancelled"; readonly text?: string; readonly error?: string }
  /** `contextTokens`: an estimate of the stored conversation, for the resume decision (card H12f). */
  | { readonly t: "checkpoint.ok"; readonly id: number; readonly checkpoint: Obj; readonly contextTokens?: number }
  | { readonly t: "tell.ok"; readonly id: number }
  /** The process could not do what it was asked (`id` names the request when there is one). */
  | { readonly t: "fault"; readonly id?: number; readonly message: string };

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const fail = (what: string): never => { throw new ChannelError(what); };
const str = (o: Obj, k: string, max = 1_000_000): string => (typeof o[k] === "string" && (o[k] as string).length <= max ? (o[k] as string) : fail(`${k}: must be text`));
const optStr = (o: Obj, k: string, max?: number): string | undefined => (o[k] === undefined ? undefined : str(o, k, max));
const int = (o: Obj, k: string): number => (Number.isSafeInteger(o[k]) && (o[k] as number) >= 0 ? (o[k] as number) : fail(`${k}: must be a whole number`));
const obj = (o: Obj, k: string): Obj => (isObj(o[k]) ? (o[k] as Obj) : fail(`${k}: must be an object`));
const headers = (o: Obj, k: string): HeaderList => {
  const list = o[k];
  if (!Array.isArray(list) || list.length > 200) return fail(`${k}: must be a list of [name, value]`);
  return list.map((h) => (Array.isArray(h) && h.length === 2 && typeof h[0] === "string" && typeof h[1] === "string" && h[0].length < 200 && h[1].length < 16_384 ? ([h[0], h[1]] as const) : fail(`${k}: must be a list of [name, value]`)));
};
const base64 = (o: Obj, k: string): string => { const s = str(o, k, MAX_CHANNEL_LINE_BYTES); return /^[A-Za-z0-9+/]*={0,2}$/.test(s) ? s : fail(`${k}: must be base64`); };

function parseStart(o: Obj): ChannelStart {
  const m = obj(o, "model");
  const model: ChannelModel = {
    alias: /^[a-z0-9][a-z0-9-]{0,40}$/.test(str(m, "alias", 41)) ? (m["alias"] as string) : fail("model.alias: a short lower-case name"),
    provider: str(m, "provider", 80), api: str(m, "api", 80), modelId: str(m, "modelId", 200), contextWindow: int(m, "contextWindow"), maxTokens: int(m, "maxTokens"),
    reasoning: typeof m["reasoning"] === "boolean" ? m["reasoning"] : fail("model.reasoning: must be true or false"),
    input: Array.isArray(m["input"]) && m["input"].every((x) => x === "text" || x === "image") ? (m["input"] as ("text" | "image")[]) : fail("model.input: must list text and image"),
  };
  const c = o["cache"] === undefined ? undefined : obj(o, "cache");
  const retention = c === undefined ? undefined : optStr(c, "retention", 10);
  if (retention !== undefined && retention !== "none" && retention !== "short" && retention !== "long") fail("cache.retention: none, short or long");
  const key = c === undefined ? undefined : optStr(c, "key", 200);
  const context = o["context"] === undefined ? undefined : parseContext(obj(o, "context"));
  return {
    attemptId: str(o, "attemptId", 200), agentId: str(o, "agentId", 200), namespaceId: /^[a-z0-9]{6,32}$/.test(str(o, "namespaceId", 40)) ? (o["namespaceId"] as string) : fail("namespaceId: 6 to 32 lower-case letters or digits"), credential: str(o, "credential", 4096),
    storeDir: str(o, "storeDir", 1000), model,
    ...(c === undefined ? {} : { cache: { ...(key === undefined ? {} : { key }), ...(retention === undefined ? {} : { retention: retention as "none" | "short" | "long" }) } }),
    relayBase: str(o, "relayBase", 500),
    ...(context === undefined ? {} : { context }),
  };
}

const bounded = (o: Obj, k: string, min: number, max: number): number | undefined => {
  if (o[k] === undefined) return undefined;
  const v = int(o, k);
  return v >= min && v <= max ? v : fail(`${k}: must be between ${min} and ${max}`);
};
function parseContext(o: Obj): ChannelContext {
  const compaction = o["compaction"] === undefined ? undefined : obj(o, "compaction");
  const timeoutMs = compaction === undefined ? undefined : bounded(compaction, "timeoutMs", 1000, 600_000);
  const fallback = compaction === undefined ? undefined : optStr(compaction, "fallback", 20);
  if (fallback !== undefined && fallback !== "extractive") fail("compaction.fallback: extractive");
  const out = { streamTimeoutMs: bounded(o, "streamTimeoutMs", 1000, 3_600_000), streamMaxRetries: bounded(o, "streamMaxRetries", 0, 10), toolOutputBytes: bounded(o, "toolOutputBytes", 1000, 10_000_000), toolOutputLines: bounded(o, "toolOutputLines", 10, 100_000) };
  return {
    ...Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)),
    ...(compaction === undefined ? {} : { compaction: { ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(fallback === undefined ? {} : { fallback: "extractive" as const }) } }),
  };
}

function reply(o: Obj): BridgeReplyMessage {
  if (o["ok"] === true) return { ok: true, result: obj(o, "result") };
  if (o["ok"] === false) return { ok: false, code: str(o, "code", 80), message: str(o, "message", 2000) };
  return fail("reply.ok: must be true or false");
}

/** Checks a line the host read from the process. */
export function parseFromChild(value: unknown): FromChild {
  if (!isObj(value)) return fail("a message is an object");
  switch (value["t"]) {
    case "ready": {
      const toolSchemaChars = value["toolSchemaChars"] === undefined ? undefined : int(value, "toolSchemaChars");
      const systemPromptChars = value["systemPromptChars"] === undefined ? undefined : int(value, "systemPromptChars");
      return { t: "ready", v: int(value, "v"), ...(toolSchemaChars === undefined ? {} : { toolSchemaChars }), ...(systemPromptChars === undefined ? {} : { systemPromptChars }) };
    }
    case "bridge": {
      const r = obj(value, "request");
      const args = r["args"] === undefined ? undefined : obj(r, "args");
      return { t: "bridge", id: int(value, "id"), token: str(value, "token", 4096), request: { op: str(r, "op", 80), callId: str(r, "callId", 400), ...(args === undefined ? {} : { args }) } };
    }
    case "fetch": {
      const body = value["body"] === undefined ? undefined : base64(value, "body");
      return { t: "fetch", id: int(value, "id"), url: str(value, "url", 4000), method: str(value, "method", 16), headers: headers(value, "headers"), ...(body === undefined ? {} : { body }) };
    }
    case "fetch.abort": return { t: "fetch.abort", id: int(value, "id") };
    case "result": {
      const status = value["status"];
      if (status !== "completed" && status !== "failed" && status !== "cancelled") return fail("status: completed, failed or cancelled");
      const text = optStr(value, "text", 4_000_000); const error = optStr(value, "error", 10_000);
      return { t: "result", status, ...(text === undefined ? {} : { text }), ...(error === undefined ? {} : { error }) };
    }
    case "checkpoint.ok": {
      const contextTokens = value["contextTokens"] === undefined ? undefined : int(value, "contextTokens");
      return { t: "checkpoint.ok", id: int(value, "id"), checkpoint: obj(value, "checkpoint"), ...(contextTokens === undefined ? {} : { contextTokens }) };
    }
    case "tell.ok": return { t: "tell.ok", id: int(value, "id") };
    case "fault": return { t: "fault", ...(value["id"] === undefined ? {} : { id: int(value, "id") }), message: str(value, "message", 4000) };
    default: return fail(`unknown message ${String(value["t"]).slice(0, 40)}`);
  }
}

/** Checks a line the process read from the host. */
export function parseToChild(value: unknown): ToChild {
  if (!isObj(value)) return fail("a message is an object");
  switch (value["t"]) {
    case "start": return { t: "start", v: int(value, "v"), start: parseStart(obj(value, "start")) };
    case "run": return { t: "run", requestId: str(value, "requestId", 200), content: str(value, "content", 2_000_000) };
    case "checkpoint": return { t: "checkpoint", id: int(value, "id") };
    case "tell": return { t: "tell", id: int(value, "id"), text: str(value, "text", 100_000) };
    case "close": return { t: "close" };
    case "bridge.reply": return { t: "bridge.reply", id: int(value, "id"), reply: reply(obj(value, "reply")) };
    case "fetch.head": return { t: "fetch.head", id: int(value, "id"), status: int(value, "status"), statusText: str(value, "statusText", 200), headers: headers(value, "headers") };
    case "fetch.chunk": return { t: "fetch.chunk", id: int(value, "id"), data: base64(value, "data") };
    case "fetch.end": return { t: "fetch.end", id: int(value, "id") };
    case "fetch.error": return { t: "fetch.error", id: int(value, "id"), message: str(value, "message", 4000) };
    default: return fail(`unknown message ${String(value["t"]).slice(0, 40)}`);
  }
}

/** One message as a line. */
export function encodeMessage(message: ToChild | FromChild): string {
  const line = JSON.stringify(message);
  if (Buffer.byteLength(line, "utf8") > MAX_CHANNEL_LINE_BYTES) throw new ChannelError("a message is longer than the channel allows");
  return `${line}\n`;
}

/** Splits a byte stream into lines and parses them. Partial lines wait for the rest; a line over the limit, or one that is not JSON, is a `ChannelError` (the channel cannot be trusted after it). */
export class LineDecoder {
  #pending = Buffer.alloc(0);

  push(chunk: Buffer | string): unknown[] {
    const data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    const out: unknown[] = [];
    let buffer = this.#pending.length === 0 ? data : Buffer.concat([this.#pending, data]);
    for (let end = buffer.indexOf(10); end !== -1; end = buffer.indexOf(10)) {
      const line = buffer.subarray(0, end);
      buffer = buffer.subarray(end + 1);
      if (line.length > MAX_CHANNEL_LINE_BYTES) throw new ChannelError("a message is longer than the channel allows");
      if (line.length === 0) continue;
      try { out.push(JSON.parse(line.toString("utf8"))); } catch { throw new ChannelError("a message is not JSON"); }
    }
    if (buffer.length > MAX_CHANNEL_LINE_BYTES) throw new ChannelError("a message is longer than the channel allows");
    this.#pending = Buffer.from(buffer);
    return out;
  }
}
