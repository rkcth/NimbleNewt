/**
 * The model stream as the controller sees it (card L05b). The relay carries the bytes of every model reply to the worker process; `ModelStreamDecoder` reads the same bytes (it never changes them) and turns them into a few
 * provider-neutral events: text, a piece of a tool call, the end. The generation service records those events against the revision the call began under (`stream-feed.ts`), and the relay holds back the bytes of a reply whose generation was
 * interrupted. Two wire formats are read: OpenAI-style chat completions and Anthropic-style messages, streamed (server-sent events) or not. Anything else is not understood and yields no events (the reply still reaches the worker; nothing is recorded for it).
 */

export type ModelStreamEvent =
  | { readonly kind: "text"; readonly text: string }
  /** A piece of a tool call's arguments; `name` arrives with the first piece, `done` with the last. */
  | { readonly kind: "tool"; readonly id: string; readonly name?: string; readonly argumentsDelta: string; readonly done: boolean }
  | { readonly kind: "end" }
  /** Something the recording could not follow (the decoder gave up, a line was too long, a reply was too big to hold): a short visible note, recorded as text so the gap is not silent. */
  | { readonly kind: "note"; readonly text: string };

/** What the relay needs of the thing that records the stream. Every function must return; an error is never the call's. */
export interface ModelStreamTap {
  /** Called before the call is sent. Resolves `undefined` when this call is not recorded (setting off, task unknown to the generation service). Throws `ModelStreamRefused` when no generation may begin (the task is held). */
  started(call: { readonly requestChars: number; /** Digest of the request as the worker built it. */ readonly requestDigest?: string }): Promise<ModelStreamCall | undefined>;
}
export interface ModelStreamCall {
  /** Bytes the relay may hold back while it cannot yet tell a stream from a whole reply (and for a whole reply); past this the reply is passed on unrecorded, with a note. 0 or absent: no cap. */
  readonly heldBufferBytes?: number;
  /** The relay waits on the store (true) or no longer does (false): stall detection must not blame the model for that time. */
  /** A message the relay adds to the request before it is sent: the request was built before a correction and is being sent again (a retry), so it carries the correction. */
  readonly amend?: string;
  onWait?: ((waiting: boolean) => void) | undefined;
  /** The events of one piece of the reply, recorded in order. `held` is set when the generation was interrupted or superseded and the reply must not go on to the worker: the text says why. */
  events(events: readonly ModelStreamEvent[]): Promise<{ readonly held?: string }>;
  /** The reply ended (`ok`) or failed or was cancelled part way (`!ok`). Partial tool calls are dropped for good either way. */
  ended(outcome: { readonly ok: boolean }): Promise<void>;
}
/** A call is refused before it is sent. */
export class ModelStreamRefused extends Error { constructor(message: string) { super(message); this.name = "ModelStreamRefused"; } }

const MAX_LINE = 1024 * 1024;
const MAX_WHOLE = 4 * 1024 * 1024;
const safeId = (value: unknown, fallback: string): string => (typeof value === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(value) ? value : fallback);

interface Open { id: string; named: boolean; done: boolean }

export class ModelStreamDecoder {
  /** `sse`: the response said it is a server-sent stream (its content type), so it is never held back as a possible whole reply. */
  constructor(options: { readonly sse?: boolean } = {}) { this.#sse = options.sse === true; }
  readonly #text = new TextDecoder("utf-8");
  #pending = "";
  #whole = "";
  #sse: boolean;
  #ended = false;
  /** The data lines of the event being read (an event's data may span several lines; the event ends at a blank line). */
  #data: string[] = [];
  #noted = new Set<string>();
  /** Tool calls seen so far in this reply, by the provider's own index. */
  readonly #calls = new Map<string, Open>();
  #lastType = "";

  /** True once the reply has shown itself to be a server-sent stream. */
  get streaming(): boolean { return this.#sse; }

  /** Feeds the next bytes of the reply; returns the events they complete. */
  push(bytes: Uint8Array): ModelStreamEvent[] {
    const chunk = this.#text.decode(bytes, { stream: true });
    if (!this.#sse && this.#whole.length < MAX_WHOLE) this.#whole += chunk;
    this.#pending += chunk;
    const out: ModelStreamEvent[] = [];
    for (;;) {
      const at = this.#pending.indexOf("\n");
      if (at < 0) break;
      const line = this.#pending.slice(0, at).replace(/\r$/, "");
      this.#pending = this.#pending.slice(at + 1);
      this.#line(line, out);
    }
    if (this.#pending.length > MAX_LINE) { this.#pending = ""; this.#note(out, "a line of the reply was longer than 1 MB and was not recorded"); }
    if (!this.#sse && this.#whole.length >= MAX_WHOLE) this.#note(out, "the reply was larger than 4 MB and is not recorded");
    return out;
  }

  /** The reply is over: a reply that was not streamed is read whole; a stream that ended without saying so is ended. */
  finish(): ModelStreamEvent[] {
    const out: ModelStreamEvent[] = [];
    if (this.#pending.trim() !== "") { this.#line(this.#pending.replace(/\r$/, ""), out); this.#pending = ""; }
    this.#dispatch(out);
    if (!this.#sse && this.#whole.trim() !== "") this.#wholeReply(out);
    return out;
  }

  #note(out: ModelStreamEvent[], text: string): void { if (!this.#noted.has(text)) { this.#noted.add(text); out.push({ kind: "note", text }); } }

  #line(line: string, out: ModelStreamEvent[]): void {
    // A comment line (`: keep-alive`) shows a stream at once, before any data.
    if (line.startsWith(":")) { this.#sse = true; return; }
    if (line === "") { this.#dispatch(out); return; }
    if (line.startsWith("event:")) { this.#lastType = line.slice(6).trim(); this.#sse = true; return; }
    if (!line.startsWith("data:")) return;
    this.#sse = true;
    this.#data.push(line.slice(5).replace(/^ /, ""));
    // Providers send one event per data line without a blank line in between often enough that a complete JSON line is dispatched at once; a line that does not parse waits for the lines that follow.
    const joined = this.#data.join("\n").trim();
    if (joined === "[DONE]") { this.#dispatch(out); return; }
    try { JSON.parse(joined); this.#dispatch(out); } catch { /* more lines may follow */ }
    if (this.#data.length > 64) { this.#data = []; this.#note(out, "an event with more than 64 data lines was not recorded"); }
  }

  #dispatch(out: ModelStreamEvent[]): void {
    if (this.#data.length === 0) return;
    const data = this.#data.join("\n").trim();
    this.#data = [];
    if (data === "[DONE]") { this.#close(out); return; }
    let json: unknown;
    try { json = JSON.parse(data); } catch { return; }
    if (json === null || typeof json !== "object" || Array.isArray(json)) return;
    this.#chunk(json as Record<string, unknown>, out);
  }

  #close(out: ModelStreamEvent[]): void {
    for (const [, c] of this.#calls) if (!c.done) { c.done = true; out.push({ kind: "tool", id: c.id, argumentsDelta: "", done: true }); }
    if (!this.#ended) { this.#ended = true; out.push({ kind: "end" }); }
  }

  #chunk(j: Record<string, unknown>, out: ModelStreamEvent[]): void {
    const type = typeof j["type"] === "string" ? (j["type"] as string) : this.#lastType;
    if (Array.isArray(j["choices"])) {
      // OpenAI style.
      for (const choice of j["choices"] as (Record<string, unknown> | null)[]) {
        if (choice === null || typeof choice !== "object") continue;
        // Only the first choice (n = 1 is what the worker asks for) is recorded; the others are passed on and said once.
        const which = typeof choice["index"] === "number" ? choice["index"] : 0;
        if (which !== 0) { this.#note(out, `choice ${which} of the reply is not recorded (only the first choice is)`); continue; }
        const delta = (choice["delta"] ?? {}) as Record<string, unknown>;
        if (typeof delta["content"] === "string" && delta["content"] !== "") out.push({ kind: "text", text: delta["content"] });
        if (Array.isArray(delta["tool_calls"])) {
          for (const t of delta["tool_calls"] as (Record<string, unknown> | null)[]) {
            if (t === null || typeof t !== "object") continue;
            const index = typeof t["index"] === "number" ? t["index"] : 0;
            const key = `o:${which}:${index}`;
            let open = this.#calls.get(key);
            const fn = (typeof t["function"] === "object" && t["function"] !== null ? t["function"] : {}) as Record<string, unknown>;
            const name = typeof fn["name"] === "string" && fn["name"] !== "" ? safeId(fn["name"], "tool") : undefined;
            const fresh = open === undefined;
            if (open === undefined) { open = { id: safeId(t["id"], `call-${index}`), named: false, done: false }; this.#calls.set(key, open); }
            const args = typeof fn["arguments"] === "string" ? fn["arguments"] : "";
            if (!fresh && name === undefined && args === "") continue;
            out.push({ kind: "tool", id: open.id, ...(name !== undefined && !open.named ? { name } : {}), argumentsDelta: args, done: false });
            if (name !== undefined) open.named = true;
          }
        }
        if (choice["finish_reason"] !== null && choice["finish_reason"] !== undefined) this.#close(out);
      }
      return;
    }
    // Anthropic style.
    const index = typeof j["index"] === "number" ? j["index"] : 0;
    const key = `a:${index}`;
    if (type === "content_block_start") {
      const block = (typeof j["content_block"] === "object" && j["content_block"] !== null ? j["content_block"] : {}) as Record<string, unknown>;
      if (block["type"] === "tool_use") {
        const id = safeId(block["id"], `call-${index}`);
        this.#calls.set(key, { id, named: true, done: false });
        out.push({ kind: "tool", id, name: safeId(block["name"], "tool"), argumentsDelta: "", done: false });
      } else if (typeof block["text"] === "string" && block["text"] !== "") out.push({ kind: "text", text: block["text"] });
    } else if (type === "content_block_delta") {
      const delta = (typeof j["delta"] === "object" && j["delta"] !== null ? j["delta"] : {}) as Record<string, unknown>;
      if (delta["type"] === "text_delta" && typeof delta["text"] === "string" && delta["text"] !== "") out.push({ kind: "text", text: delta["text"] });
      else if (delta["type"] === "input_json_delta" && typeof delta["partial_json"] === "string") {
        const open = this.#calls.get(key);
        if (open !== undefined && delta["partial_json"] !== "") out.push({ kind: "tool", id: open.id, argumentsDelta: delta["partial_json"], done: false });
      }
    } else if (type === "content_block_stop") {
      const open = this.#calls.get(key);
      if (open !== undefined && !open.done) { open.done = true; out.push({ kind: "tool", id: open.id, argumentsDelta: "", done: true }); }
    } else if (type === "message_stop") this.#close(out);
  }

  #wholeReply(out: ModelStreamEvent[]): void {
    let json: unknown;
    try { json = JSON.parse(this.#whole); } catch { return; }
    if (json === null || typeof json !== "object") return;
    const j = json as Record<string, unknown>;
    if (Array.isArray(j["choices"])) {
      const first = (j["choices"] as unknown[])[0];
      const message = (first !== null && typeof first === "object" && typeof (first as Record<string, unknown>)["message"] === "object" && (first as Record<string, unknown>)["message"] !== null ? (first as Record<string, unknown>)["message"] : {}) as Record<string, unknown>;
      if (typeof message["content"] === "string" && message["content"] !== "") out.push({ kind: "text", text: message["content"] });
      if (Array.isArray(message["tool_calls"])) {
        (message["tool_calls"] as (Record<string, unknown> | null)[]).forEach((t, index) => {
          if (t === null || typeof t !== "object") return;
          const fn = (typeof t["function"] === "object" && t["function"] !== null ? t["function"] : {}) as Record<string, unknown>;
          out.push({ kind: "tool", id: safeId(t["id"], `call-${index}`), name: safeId(fn["name"], "tool"), argumentsDelta: typeof fn["arguments"] === "string" ? fn["arguments"] : "", done: true });
        });
      }
    } else if (Array.isArray(j["content"])) {
      (j["content"] as (Record<string, unknown> | null)[]).forEach((b, index) => {
        if (b === null || typeof b !== "object") return;
        if (b["type"] === "text" && typeof b["text"] === "string" && b["text"] !== "") out.push({ kind: "text", text: b["text"] });
        else if (b["type"] === "tool_use") out.push({ kind: "tool", id: safeId(b["id"], `call-${index}`), name: safeId(b["name"], "tool"), argumentsDelta: JSON.stringify(b["input"] ?? {}), done: true });
      });
    } else return;
    out.push({ kind: "end" });
  }
}
