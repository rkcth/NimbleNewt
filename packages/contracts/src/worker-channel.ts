import type { JsonValue } from "./index.js";
import { ANCHOR_CHANNEL_MAX, verifyAnchor } from "./anchor.js";

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

/**
 * How a completed turn ended (card W02), as the worker process reads the turn's last reply: `length` (the reply hit the output limit; Pi answers on it as on a normal stop), `empty-visible-text` (the reply had no visible text: thinking only,
 * or nothing), `no-work-end` (a natural stop without a `work.end` in the turn), `announced-step-without-tool-call` (the last text says it will do something next and no tool call follows) or `normal` (the turn ended with `work.end`).
 */
export const TURN_END_KINDS = ["length", "empty-visible-text", "no-work-end", "announced-step-without-tool-call", "normal"] as const;
export type TurnEndKind = (typeof TURN_END_KINDS)[number];
/** A turn's ending as the host and the controller read it: `unknown` when the worker did not say (an older worker, a turn that failed or was cancelled, a process that ended). Never read as `normal`. */
export type HostEndKind = TurnEndKind | "unknown";
/** The end kind a result says, or `unknown` when it says none or one this side does not know. */
export const endKindOf = (value: unknown): HostEndKind => (typeof value === "string" && (TURN_END_KINDS as readonly string[]).includes(value) ? (value as TurnEndKind) : "unknown");

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
   * `keep` (card C07q): the owner's decisions for the task as the controller had them when the process started (a note saying what they are and how to read the current ones, then one line each, the owner's wording quoted); the process
   * adds them to every summary it writes, so a compaction never drops them. At most `CHANNEL_KEEP.lines` lines of `CHANNEL_KEEP.line` characters.
   * `anchor` (card W12): the goal anchor the controller wrote for the attempt, exactly one block that checks out (`anchor.ts`). The process takes any block out of the conversation it summarises and puts this one at the top of the summary, so
   * the conversation that goes on holds one, never a stack of them.
   */
  readonly compaction?: { readonly timeoutMs?: number; readonly fallback?: "extractive"; readonly keep?: { readonly note: string; readonly lines: readonly string[] }; readonly anchor?: { readonly text: string } };
}

export interface ChannelStart {
  readonly attemptId: string;
  readonly agentId: string;
  /** The id part of the agent's own tool namespace (`a_<id>__...`) as the catalogue derives it; the process names its personal tools with it. */
  readonly namespaceId: string;
  readonly credential: string;
  /** The directory (as the process sees it) where the Pi conversation is stored, inside the agent's own home. */
  readonly storeDir: string;
  /**
   * Present when the controller has reviewed the work an earlier process of this attempt left unfinished in the store (a restart for a changed recipe, a resume after the worker was lost) and wants the conversation to go on from it. Without it a store with
   * unfinished work is not touched and the turn is refused (Pi holds interrupted work until it is reviewed). `reason` goes into the audit record.
   */
  readonly recover?: { readonly reason: string };
  readonly model: ChannelModel;
  /** The cache key and retention the host derived for this attempt's route (opaque; nothing here can be used to reach another project's cache). */
  readonly cache?: { readonly key?: string; readonly retention?: "none" | "short" | "long" };
  /** The address the process uses for model calls. Calls to anything else fail: the sandbox has no network. */
  readonly relayBase: string;
  readonly context?: ChannelContext;
  /**
   * The lease the controller meant for this attempt, as a duration (card H08b): the process counts it from the moment it reads the start, on its own monotonic clock, renews it with `lease.renew` and stops on `lease.fenced`. A suspend of more than 5 seconds counts as losing the lease; on Linux it is told from the never-stepped boot clock, elsewhere from the wall clock (where a
   * forward step of the wall clock still reads as a wake). Without it the process runs no watchdog.
   * `graceMs` is how long after work stops the process ends itself if it has not wound down.
   */
  readonly lease?: { readonly leaseMs: number; readonly graceMs: number };
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
  /** Compact the stored conversation once (card H12f): asked when the first call is over the context budget. */
  | { readonly t: "compact"; readonly id: number }
  | { readonly t: "close" }
  | { readonly t: "bridge.reply"; readonly id: number; readonly reply: BridgeReplyMessage }
  | { readonly t: "fetch.head"; readonly id: number; readonly status: number; readonly statusText: string; readonly headers: HeaderList }
  /** A piece of the model's reply body, base64. */
  | { readonly t: "fetch.chunk"; readonly id: number; readonly data: string }
  | { readonly t: "fetch.end"; readonly id: number }
  | { readonly t: "fetch.error"; readonly id: number; readonly message: string }
  /**
   * The answer to the process's `lease.renew` (card H08b): the controller extended the attempt's lease and says for how long, as a duration (never a time on the controller's clock). The process counts it from the moment it SENT the request, on its
   * own monotonic clock, so a slow or replayed answer never stretches the lease.
   */
  | { readonly t: "lease.ok"; readonly id: number; readonly leaseMs: number }
  /** The controller refused the renewal because the attempt is no longer this process's (moved, replaced, ended): productive work stops at once. */
  | { readonly t: "lease.fenced"; readonly id: number; readonly reason: string };

/** One block of model thinking a process reports (card U09b). `block` is the position within its conversation entry. */
export interface ThinkingReport { readonly entryId: number; readonly block: number; readonly provider: string; readonly model: string; readonly text: string; readonly opaque: boolean }
/** The bounds of one `thinking` message: blocks per message and characters per block (the process cuts; the host's parser refuses more). */
export const THINKING_REPORT = { blocks: 50, chars: 8000, parseChars: 20_000 } as const;

/** Process to host. */
export type FromChild =
  /** `toolSchemaChars`: the size of the tools as offered to the model; `systemPromptChars` when the process knows it (card H12f: context admission). */
  | { readonly t: "ready"; readonly v: number; readonly toolSchemaChars?: number; readonly systemPromptChars?: number }
  | { readonly t: "bridge"; readonly id: number; readonly token: string; readonly request: { readonly op: string; readonly callId: string; readonly args?: Obj } }
  | { readonly t: "fetch"; readonly id: number; readonly url: string; readonly method: string; readonly headers: HeaderList; readonly body?: string }
  | { readonly t: "fetch.abort"; readonly id: number }
  /** `endKind` and `visibleChars` (card W02): how a completed turn ended and the length of its last reply's visible text (trimmed). A worker from before W02 sends neither: the host reads that as `unknown`. */
  /** `nudges` (card W04): how many times the process continued the turn after it yielded without a tool call or work.end; absent from a worker before W04. */
  | { readonly t: "result"; readonly status: "completed" | "failed" | "cancelled"; readonly text?: string; readonly error?: string; readonly endKind?: TurnEndKind; readonly visibleChars?: number; readonly nudges?: number }
  /**
   * `contextTokens`: an estimate of the stored conversation, for the resume decision (card H12f). `durable` (card L04d): the process read the checkpoint back from its store and checked that the stored history up to it is what
   * the checkpoint describes; a process that did not check sends none, and the host reads that as not verified.
   */
  | { readonly t: "checkpoint.ok"; readonly id: number; readonly checkpoint: Obj; readonly contextTokens?: number; readonly durable?: CheckpointDurability }
  | { readonly t: "tell.ok"; readonly id: number }
  | { readonly t: "compact.ok"; readonly id: number; readonly contextTokens?: number }
  /** The process compacted its own conversation (card C07q): how many messages it replaced, how long its summary is and the summary's sha-256 in hex. The text stays in the process's store; the host tells the controller, which keeps the compaction in the task's chain. */
  | { readonly t: "compacted"; readonly messageCount: number; readonly summaryChars: number; readonly digest: string }
  /**
   * The model's thinking returned during the turn (card U09b): the blocks the conversation kept since the last report, at most `THINKING_REPORT.blocks`, each cut to `THINKING_REPORT.chars` by the process. It is untrusted model output: the host passes
   * it to the controller, which removes control characters, hides credentials, bounds and stores it for the owner; it is never given to an agent or a model. Told, not asked. A worker from before U09b sends none.
   */
  | { readonly t: "thinking"; readonly blocks: readonly ThinkingReport[] }
  /** The lease ended (card H08b3): told on its own so the host sees it whether or not a turn is open (an unsolicited `result` has no waiter). `reason` is a `LossReason`. */
  | { readonly t: "lease.lost"; readonly reason: string }
  /** Asks the controller to extend the attempt's lease (card H08b); answered `lease.ok` or `lease.fenced` with the same ID, or not at all (the controller could not be asked: the lease runs on and may end). */
  | { readonly t: "lease.renew"; readonly id: number }
  /** The process could not do what it was asked (`id` names the request when there is one). */
  | { readonly t: "fault"; readonly id?: number; readonly message: string };

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const fail = (what: string): never => { throw new ChannelError(what); };
const str = (o: Obj, k: string, max = 1_000_000): string => (typeof o[k] === "string" && (o[k] as string).length <= max ? (o[k] as string) : fail(`${k}: must be text`));
const optStr = (o: Obj, k: string, max?: number): string | undefined => (o[k] === undefined ? undefined : str(o, k, max));
const int = (o: Obj, k: string): number => (Number.isSafeInteger(o[k]) && (o[k] as number) >= 0 ? (o[k] as number) : fail(`${k}: must be a whole number`));
const obj = (o: Obj, k: string): Obj => (isObj(o[k]) ? (o[k] as Obj) : fail(`${k}: must be an object`));
/** The read-back check of a checkpoint (card L04d): whether it passed and, when it did not, why (at most `CHECKPOINT_DURABILITY_ERROR` characters). */
export interface CheckpointDurability { readonly verified: boolean; readonly error?: string }
export const CHECKPOINT_DURABILITY_ERROR = 300;
const durabilityOf = (o: Obj): CheckpointDurability => {
  if (typeof o["verified"] !== "boolean") return fail("durable.verified: must be true or false");
  const error = optStr(o, "error", CHECKPOINT_DURABILITY_ERROR);
  return { verified: o["verified"] as boolean, ...(error === undefined ? {} : { error }) };
};
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
  const leaseObj = o["lease"] === undefined ? undefined : obj(o, "lease");
  const lease = leaseObj === undefined ? undefined : { leaseMs: bounded(leaseObj, "leaseMs", 1000, 3_600_000) ?? fail("lease.leaseMs: required"), graceMs: bounded(leaseObj, "graceMs", 0, 600_000) ?? fail("lease.graceMs: required") };
  return {
    attemptId: str(o, "attemptId", 200), agentId: str(o, "agentId", 200), namespaceId: /^[a-z0-9]{6,32}$/.test(str(o, "namespaceId", 40)) ? (o["namespaceId"] as string) : fail("namespaceId: 6 to 32 lower-case letters or digits"), credential: str(o, "credential", 4096),
    storeDir: str(o, "storeDir", 1000), model,
    ...(o["recover"] === undefined ? {} : { recover: { reason: str(obj(o, "recover"), "reason", 300).trim() === "" ? fail("recover.reason: required") : (obj(o, "recover")["reason"] as string) } }),
    ...(c === undefined ? {} : { cache: { ...(key === undefined ? {} : { key }), ...(retention === undefined ? {} : { retention: retention as "none" | "short" | "long" }) } }),
    relayBase: str(o, "relayBase", 500),
    ...(context === undefined ? {} : { context }),
    ...(lease === undefined ? {} : { lease }),
  };
}

const bounded = (o: Obj, k: string, min: number, max: number): number | undefined => {
  if (o[k] === undefined) return undefined;
  const v = int(o, k);
  return v >= min && v <= max ? v : fail(`${k}: must be between ${min} and ${max}`);
};
/** The bounds of the owner's decisions a process keeps through its compactions (card C07q). */
export const CHANNEL_KEEP = { lines: 12, line: 600, note: 1000 } as const;
function parseKeep(o: Obj): { readonly note: string; readonly lines: readonly string[] } {
  const lines = o["lines"];
  if (!Array.isArray(lines) || lines.length > CHANNEL_KEEP.lines || lines.some((l) => typeof l !== "string" || l.length > CHANNEL_KEEP.line || /[\r\n]/.test(l))) return fail(`compaction.keep.lines: at most ${CHANNEL_KEEP.lines} single lines of ${CHANNEL_KEEP.line} characters`);
  return { note: str(o, "note", CHANNEL_KEEP.note), lines: lines as string[] };
}
function parseContext(o: Obj): ChannelContext {
  const compaction = o["compaction"] === undefined ? undefined : obj(o, "compaction");
  const keep = compaction?.["keep"] === undefined ? undefined : parseKeep(obj(compaction, "keep"));
  const timeoutMs = compaction === undefined ? undefined : bounded(compaction, "timeoutMs", 1000, 600_000);
  const fallback = compaction === undefined ? undefined : optStr(compaction, "fallback", 20);
  if (fallback !== undefined && fallback !== "extractive") fail("compaction.fallback: extractive");
  const out = { streamTimeoutMs: bounded(o, "streamTimeoutMs", 1000, 3_600_000), streamMaxRetries: bounded(o, "streamMaxRetries", 0, 10), toolOutputBytes: bounded(o, "toolOutputBytes", 1000, 10_000_000), toolOutputLines: bounded(o, "toolOutputLines", 10, 100_000) };
  const anchorObj = compaction?.["anchor"] === undefined ? undefined : obj(compaction, "anchor");
  const anchorText = anchorObj === undefined ? undefined : str(anchorObj, "text", ANCHOR_CHANNEL_MAX);
  if (anchorText !== undefined && verifyAnchor(anchorText) === undefined) fail("compaction.anchor.text: must be exactly one goal anchor block whose digest checks out");
  // Only the extractive summary puts the block back; with Pi's own summariser (the model writing the summary) it would be lost after the first cut without anyone knowing (W12 review).
  if (anchorText !== undefined && fallback !== "extractive") fail("compaction.anchor: needs compaction.fallback extractive (only that summary puts the block back after a cut)");
  return {
    ...Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)),
    ...(compaction === undefined ? {} : { compaction: { ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(fallback === undefined ? {} : { fallback: "extractive" as const }), ...(keep === undefined ? {} : { keep }), ...(anchorText === undefined ? {} : { anchor: { text: anchorText } }) } }),
  };
}

function reply(o: Obj): BridgeReplyMessage {
  if (o["ok"] === true) return { ok: true, result: obj(o, "result") };
  if (o["ok"] === false) return { ok: false, code: str(o, "code", 80), message: str(o, "message", 2000) };
  return fail("reply.ok: must be true or false");
}

/** The most continuations one turn can report (card W04): the worker's own bound is far lower; a figure above this is a broken process, not a count. */
export const MAX_TURN_NUDGES = 100;

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
      // An end kind this side does not know (a newer worker) is left out, so it reads as unknown, never as normal.
      const kind = value["endKind"] === undefined ? undefined : endKindOf(optStr(value, "endKind", 60));
      const visibleChars = value["visibleChars"] === undefined ? undefined : int(value, "visibleChars");
      const nudges = value["nudges"] === undefined ? undefined : bounded(value, "nudges", 0, MAX_TURN_NUDGES);
      return { t: "result", status, ...(text === undefined ? {} : { text }), ...(error === undefined ? {} : { error }), ...(kind === undefined || kind === "unknown" ? {} : { endKind: kind }), ...(visibleChars === undefined ? {} : { visibleChars }), ...(nudges === undefined ? {} : { nudges }) };
    }
    case "checkpoint.ok": {
      const contextTokens = value["contextTokens"] === undefined ? undefined : int(value, "contextTokens");
      const durable = value["durable"] === undefined ? undefined : durabilityOf(obj(value, "durable"));
      return { t: "checkpoint.ok", id: int(value, "id"), checkpoint: obj(value, "checkpoint"), ...(contextTokens === undefined ? {} : { contextTokens }), ...(durable === undefined ? {} : { durable }) };
    }
    case "thinking": {
      const list = value["blocks"];
      if (!Array.isArray(list) || list.length < 1 || list.length > THINKING_REPORT.blocks) return fail(`blocks: 1 to ${THINKING_REPORT.blocks} blocks`);
      const blocks = list.map((b): ThinkingReport => {
        if (!isObj(b)) return fail("blocks: each block is an object");
        if (typeof b["opaque"] !== "boolean") return fail("opaque: must be true or false");
        const provider = str(b, "provider", 80); const model = str(b, "model", 200);
        if (provider === "" || model === "") return fail("provider and model: required");
        return { entryId: int(b, "entryId"), block: int(b, "block"), provider, model, text: str(b, "text", THINKING_REPORT.parseChars), opaque: b["opaque"] };
      });
      return { t: "thinking", blocks };
    }
    case "lease.lost": return { t: "lease.lost", reason: str(value, "reason", 40) };
    case "lease.renew": return { t: "lease.renew", id: int(value, "id") };
    case "tell.ok": return { t: "tell.ok", id: int(value, "id") };
    case "compact.ok": { const contextTokens = value["contextTokens"] === undefined ? undefined : int(value, "contextTokens"); return { t: "compact.ok", id: int(value, "id"), ...(contextTokens === undefined ? {} : { contextTokens }) }; }
    case "compacted": {
      const digest = str(value, "digest", 64);
      if (!/^[0-9a-f]{64}$/.test(digest)) fail("digest: must be a sha-256 digest in hex");
      return { t: "compacted", messageCount: bounded(value, "messageCount", 0, 10_000_000) ?? fail("messageCount: must be a whole number"), summaryChars: bounded(value, "summaryChars", 0, 1_000_000_000) ?? fail("summaryChars: must be a whole number"), digest };
    }
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
    case "compact": return { t: "compact", id: int(value, "id") };
    case "close": return { t: "close" };
    case "bridge.reply": return { t: "bridge.reply", id: int(value, "id"), reply: reply(obj(value, "reply")) };
    case "fetch.head": return { t: "fetch.head", id: int(value, "id"), status: int(value, "status"), statusText: str(value, "statusText", 200), headers: headers(value, "headers") };
    case "fetch.chunk": return { t: "fetch.chunk", id: int(value, "id"), data: base64(value, "data") };
    case "fetch.end": return { t: "fetch.end", id: int(value, "id") };
    case "fetch.error": return { t: "fetch.error", id: int(value, "id"), message: str(value, "message", 4000) };
    case "lease.ok": return { t: "lease.ok", id: int(value, "id"), leaseMs: bounded(value, "leaseMs", 0, 3_600_000) ?? fail("leaseMs: required") };
    case "lease.fenced": return { t: "lease.fenced", id: int(value, "id"), reason: str(value, "reason", 500) };
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
