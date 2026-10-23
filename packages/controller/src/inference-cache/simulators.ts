import type { HttpRequest, HttpResponse, Transport } from "./adapter.js";
import type { WireRequest } from "./profile.js";

// ---- simulated servers: they model only the cache behaviour the profiles rely on, with the response shapes read from each server's source or documentation (not yet captured from a running server; see the G10 follow-up in the notes) ----------------------------------
export const CHUNK = 4;
/** A request as the cache sees it: tools first, then the messages (the order the servers render them). Without tools the text is the messages alone. */
export const tokensOf = (body: WireRequest): string[] => { const s = Array.isArray(body["tools"]) && body["tools"].length > 0 ? JSON.stringify([body["tools"], body["messages"]]) : JSON.stringify(body["messages"]); return Array.from({ length: Math.ceil(s.length / CHUNK) }, (_, i) => s.slice(i * CHUNK, (i + 1) * CHUNK)); };
const lcp = (a: readonly string[], b: readonly string[]): number => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
export const ok = (body: unknown): HttpResponse => ({ status: 200, body });
export const refuse = (status: number, message: string): HttpResponse => ({ status, body: { error: { message } } });

/** llama-server: one prompt per slot; `id_slot` picks the slot, otherwise slot 0; cache_prompt reuses the longest common prefix; slot files save and restore. */
export class LlamaSim implements Transport {
  readonly slots: string[][];
  readonly files = new Map<string, string[]>();
  readonly seen: HttpRequest[] = [];
  constructor(n: number, readonly options: { rejectSlot?: boolean } = {}) { this.slots = Array.from({ length: n }, () => []); }
  async send(r: HttpRequest): Promise<HttpResponse> {
    this.seen.push(r);
    await new Promise((resolve) => setImmediate(resolve)); // a real server takes time, so concurrent calls can interleave unless the adapter serialises them
    const slotPath = /^\/slots\/(\d+)\?action=(save|restore|erase)$/.exec(r.path);
    if (slotPath !== null) {
      const slot = Number(slotPath[1]); const action = slotPath[2]!; const name = (r.body as { filename?: string }).filename;
      if (slot >= this.slots.length) return refuse(400, "invalid slot");
      if (action === "save") { this.files.set(name!, [...this.slots[slot]!]); return ok({ id_slot: slot, filename: name, n_saved: this.slots[slot]!.length, n_written: 1, timings: { save_ms: 4.5 } }); }
      if (action === "restore") { const f = this.files.get(name!); if (f === undefined) return refuse(404, "file not found"); this.slots[slot] = [...f]; return ok({ id_slot: slot, filename: name, n_restored: f.length, timings: { restore_ms: 3.1 } }); }
      this.slots[slot] = []; return ok({ id_slot: slot, n_erased: 1 });
    }
    if (this.options.rejectSlot === true && "id_slot" in r.body) return refuse(400, "unknown field id_slot");
    const slot = typeof r.body["id_slot"] === "number" ? (r.body["id_slot"] as number) : 0;
    const t = tokensOf(r.body);
    const reuse = r.body["cache_prompt"] === true ? Math.min(lcp(this.slots[slot]!, t), t.length - 1) : 0;
    this.slots[slot] = t;
    return ok({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: t.length, completion_tokens: 3 }, timings: { cache_n: reuse, prompt_n: t.length - reuse } });
  }
}

/**
 * A server with automatic prefix caching: reuse is per cache_salt, in whole 16-token blocks, across every conversation that reaches it. `shape` is how it reports hits: vLLM and OpenAI put `cached_tokens` in the usage;
 * llama.cpp-family servers (Radiance, Strata) put `cache_n` and `prompt_n` in `timings`. The shapes are read from each server's source or documentation, not captured from a running one.
 */
export class VllmSim implements Transport {
  readonly seen = new Map<string, string[][]>();
  constructor(readonly options: { oldVersion?: boolean; shape?: "usage" | "timings" } = {}) {}
  async send(r: HttpRequest): Promise<HttpResponse> {
    if (this.options.oldVersion === true && "cache_salt" in r.body) return refuse(400, "Unrecognized request argument: cache_salt");
    const salt = typeof r.body["cache_salt"] === "string" ? (r.body["cache_salt"] as string) : "";
    const t = tokensOf(r.body);
    const prior = this.seen.get(salt) ?? [];
    const best = prior.reduce((m, p) => Math.max(m, lcp(p, t)), 0);
    this.seen.set(salt, [...prior, t]);
    const cached = Math.floor(Math.min(best, t.length - 1) / 16) * 16;
    if (this.options.shape === "timings") return ok({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: t.length, completion_tokens: 3 }, timings: { cache_n: cached, prompt_n: t.length - cached } });
    return ok({ usage: { prompt_tokens: t.length, completion_tokens: 3, prompt_tokens_details: { cached_tokens: cached } } });
  }
}

/** Claude Messages API: breakpoints write entries keyed by the exact prefix; entries expire by their lifetime; a read refreshes the entry. */
export class ClaudeSim implements Transport {
  readonly entries = new Map<string, { expires: number; tokens: number }>();
  readonly seen: HttpRequest[] = [];
  now = 0;
  constructor(readonly options: { minTokens?: number; rejectTtl?: boolean } = {}) {}
  async send(r: HttpRequest): Promise<HttpResponse> {
    this.seen.push(r);
    const b = r.body;
    const flat: { key: string; ttl?: string; tokens: number }[] = [];
    let acc = "";
    const add = (part: unknown, cc: unknown): void => { acc += JSON.stringify(part, (k, v) => (k === "cache_control" ? undefined : v)); flat.push({ key: acc, ...(cc !== undefined ? { ttl: (cc as { ttl?: string }).ttl ?? "5m" } : {}), tokens: Math.ceil(acc.length / 3) }); };
    for (const t of (b["tools"] as Record<string, unknown>[] | undefined) ?? []) add(t, t["cache_control"]);
    for (const s of Array.isArray(b["system"]) ? (b["system"] as Record<string, unknown>[]) : b["system"] === undefined ? [] : [{ type: "text", text: b["system"] }]) add(s, s["cache_control"]);
    for (const m of b["messages"] as { content: unknown }[]) for (const c of Array.isArray(m.content) ? (m.content as Record<string, unknown>[]) : [{ type: "text", text: m.content }]) add({ role: (m as { role?: string }).role, ...c }, c["cache_control"]);
    const total = flat.at(-1)!.tokens;
    if (this.options.rejectTtl === true && flat.some((f) => f.ttl === "1h")) return refuse(400, "cache_control.ttl: extended cache is not enabled");
    let read = 0; let written = 0; let w5 = 0; let w1 = 0;
    const marked = flat.filter((f) => f.ttl !== undefined);
    // each breakpoint looks back over at most 20 blocks for an entry an earlier request wrote
    search: for (const f of [...marked].reverse()) {
      for (let i = flat.indexOf(f); i >= Math.max(0, flat.indexOf(f) - 20); i--) {
        const e = this.entries.get(flat[i]!.key);
        if (e !== undefined && e.expires > this.now) { read = e.tokens; e.expires = this.now + (f.ttl === "1h" ? 3_600_000 : 300_000); break search; }
      }
    }
    for (const f of marked) {
      if (f.tokens < (this.options.minTokens ?? 512) || f.tokens <= read) continue;
      const life = f.ttl === "1h" ? 3_600_000 : 300_000;
      this.entries.set(f.key, { expires: this.now + life, tokens: f.tokens });
      written = Math.max(written, f.tokens - read); if (f.ttl === "1h") w1 += f.tokens - read; else w5 += f.tokens - read;
    }
    return ok({ usage: { input_tokens: total - read - written, cache_read_input_tokens: read, cache_creation_input_tokens: written, cache_creation: { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: w1 }, output_tokens: 3 } });
  }
}

