import { randomBytes } from "node:crypto";
import type { HttpRequest, HttpResponse, Transport } from "@nimblenewt/controller";

/**
 * Card G10, hosted OpenAI route: the pieces of the measurement that can be tested offline. The owner's hosted OpenAI access is a ChatGPT sign-in held by Hermes, so a call goes through the `hermes` command
 * line (one-shot mode, `-z`) and not through HTTP with a key this repository could see. The route has three properties the measurement has to state, not hide:
 *
 *  1. Hermes takes one prompt string. A chat request's messages are flattened into it (`flattenMessages`); the system text and the user text reach the model as one user turn after Hermes's own system prompt.
 *  2. Hermes builds its own provider request. Whatever cache settings the production profile put in the body (`prompt_cache_key`, `prompt_cache_retention`, ...) are NOT forwarded; `HermesTransport` lists them in
 *     `dropped` for every call, so a result is never read as "the marker worked".
 *  3. Hermes reports tokens from the provider's own usage fields in a usage file (`--usage-file`): input tokens not served from cache, `cache_read_tokens`, output tokens. `hermesResponse` turns that into the
 *     OpenAI chat shape the production profile reads (`usage.prompt_tokens`, `usage.prompt_tokens_details.cached_tokens`), so the production `CacheAdapter` and profile judge the call; nothing here re-implements
 *     the judging. Time to first token is not reported by one-shot mode: only the wall time of the whole command (process start, the answer and Hermes's own title call) is recorded.
 */

/** The fields of Hermes's usage report this measurement reads. The report also carries a session id and billing fields, which are never kept. */
export interface HermesUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_write_tokens?: number;
  readonly reasoning_tokens?: number;
  readonly api_calls: number;
  readonly model: string;
  readonly provider: string;
  readonly completed: boolean;
  readonly failed?: boolean;
  /** Calls Hermes made on its own besides the answer (a short title), counted so the number of provider calls is exact. */
  readonly auxiliary?: { readonly api_calls?: number };
}

const whole = (v: unknown): number | undefined => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined);

/** Keeps only the fields above, and only when each has the right type. Returns undefined for a report that does not look like Hermes's (so nothing is invented from it). */
export function readHermesUsage(raw: unknown): HermesUsage | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const input = whole(o["input_tokens"]); const output = whole(o["output_tokens"]); const cacheRead = whole(o["cache_read_tokens"]); const calls = whole(o["api_calls"]);
  if (input === undefined || output === undefined || cacheRead === undefined || calls === undefined) return undefined;
  if (typeof o["model"] !== "string" || typeof o["provider"] !== "string" || typeof o["completed"] !== "boolean") return undefined;
  const write = whole(o["cache_write_tokens"]); const reasoning = whole(o["reasoning_tokens"]);
  const aux = whole((o["auxiliary"] as { api_calls?: unknown } | undefined)?.api_calls);
  return {
    input_tokens: input, output_tokens: output, cache_read_tokens: cacheRead, ...(write === undefined ? {} : { cache_write_tokens: write }), ...(reasoning === undefined ? {} : { reasoning_tokens: reasoning }), api_calls: calls,
    model: o["model"], provider: o["provider"], completed: o["completed"], ...(typeof o["failed"] === "boolean" ? { failed: o["failed"] } : {}), ...(aux === undefined ? {} : { auxiliary: { api_calls: aux } }),
  };
}

/**
 * Hermes counts `input_tokens` as the part of the prompt NOT served from cache (it subtracts the cache buckets from the provider's total; see its usage normalisation), so the provider's prompt total is
 * input plus cache read plus cache write. The OpenAI chat shape wants the total and the cached part.
 */
export function hermesResponse(usage: HermesUsage, text: string): { readonly object: "chat.completion"; readonly model: string; readonly choices: readonly unknown[]; readonly usage: unknown } {
  const cached = usage.cache_read_tokens;
  const total = usage.input_tokens + usage.cache_read_tokens + (usage.cache_write_tokens ?? 0);
  return {
    object: "chat.completion", model: usage.model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: usage.completed ? "stop" : "length" }],
    usage: { prompt_tokens: total, completion_tokens: usage.output_tokens, total_tokens: total + usage.output_tokens, prompt_tokens_details: { cached_tokens: cached } },
  };
}

interface Message { readonly role?: unknown; readonly content?: unknown }
const textOf = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => (p !== null && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join("") : "";

/** One prompt string from chat messages: each message in order, its text first and nothing added in front of the first message, so a shared system text stays at the very start of the prompt. */
export function flattenMessages(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  return (messages as Message[]).map((m, i) => (i === 0 && m.role === "system" ? textOf(m.content) : `${typeof m.role === "string" ? m.role : "user"}: ${textOf(m.content)}`)).join("\n\n");
}

/** Cache settings of a production body that Hermes's own request does not carry. */
export const CACHE_FIELDS = ["prompt_cache_key", "prompt_cache_retention", "session_id", "cache_prompt", "id_slot", "cache_control"] as const;

/** What one run of the command gave back. */
export interface HermesRun { readonly text: string; readonly usage: unknown; readonly wallMs: number; readonly exitCode: number }
/** Runs one prompt through Hermes. The bench's version starts the real command; tests supply a replay. */
export type HermesRunner = (prompt: string) => Promise<HermesRun>;

/** A `Transport` for the production `CacheAdapter` over Hermes one-shot mode. */
export class HermesTransport implements Transport {
  readonly #run: HermesRunner;
  /** Every call, in order: what was dropped, the wall time and the usage as Hermes gave it (no session id). */
  readonly calls: { readonly dropped: readonly string[]; readonly wallMs: number; readonly usage: HermesUsage | undefined; readonly text: string; readonly exitCode: number }[] = [];
  constructor(run: HermesRunner) { this.#run = run; }
  async send(request: HttpRequest): Promise<HttpResponse> {
    const dropped = CACHE_FIELDS.filter((f) => f in request.body);
    const run = await this.#run(flattenMessages(request.body["messages"]));
    const usage = readHermesUsage(run.usage);
    this.calls.push({ dropped, wallMs: run.wallMs, usage, text: run.text, exitCode: run.exitCode });
    // A failed or unreadable run is reported as a failed response; the adapter then returns it as it is (it retries without cache settings only when the failure names one of them, which this one cannot).
    if (run.exitCode !== 0 || usage === undefined || usage.failed === true) return { status: 502, body: { error: { message: `hermes one-shot run failed (exit ${run.exitCode}${usage === undefined ? ", no readable usage report" : ""})` } } };
    return { status: 200, body: hermesResponse(usage, run.text) };
  }
}

// ---- the synthetic prompts ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
const TEAMS = ["Kestrel", "Heron", "Otter", "Lynx", "Marten", "Plover", "Wren", "Badger", "Ibis", "Stoat"];
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
/** Synthetic ledger rules with a nonce at the very start (so a new head shares nothing before it) and two facts the questions ask about. */
export function syntheticHead(nonce: string, lines: number, random: (n: number) => number = (n) => randomBytes(2).readUInt16BE(0) % n): { readonly text: string; readonly code: string; readonly team: string } {
  const code = `${["amber", "cobalt", "saffron", "violet", "jade"][random(5)]}-${100 + random(900)}`;
  const team = TEAMS[random(TEAMS.length)]!;
  const out = [`Run ${nonce}. You answer questions about the ledger rules below. Answer with the exact value only, no explanation.`];
  for (let i = 1; i <= lines; i++) {
    out.push(`Rule ${i}: entries in ledger section ${i} are reconciled every ${DAYS[i % 5]} by team ${TEAMS[(i * 7) % 10]}, with a tolerance of ${(i * 13) % 97} cents.`);
    if (i === Math.floor(lines / 2)) out.push(`Note: the vault code for this run is ${code}.`);
    if (i === Math.floor((lines * 3) / 4)) out.push(`Note: the on-call team for this run is ${team}.`);
  }
  return { text: out.join("\n"), code, team };
}
