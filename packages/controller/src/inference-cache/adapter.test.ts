import assert from "node:assert/strict";
import { test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { CacheAdapter, CacheEndpoints, SlotAffinity, deriveKey, judge, ledgerCache, profileFor, type CacheContext, type CacheHit, type EndpointConfig, type HttpRequest, type HttpResponse, type Transport, type WireRequest } from "./index.js";

// ---- simulated servers: they model only the cache behaviour the profiles rely on, with the response shapes read from each server's source or documentation (not yet captured from a running server; see the G10 follow-up in the notes) ----------------------------------
const CHUNK = 4;
const tokensOf = (body: WireRequest): string[] => { const s = JSON.stringify(body["messages"]); return Array.from({ length: Math.ceil(s.length / CHUNK) }, (_, i) => s.slice(i * CHUNK, (i + 1) * CHUNK)); };
const lcp = (a: readonly string[], b: readonly string[]): number => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
const ok = (body: unknown): HttpResponse => ({ status: 200, body });
const refuse = (status: number, message: string): HttpResponse => ({ status, body: { error: { message } } });

/** llama-server: one prompt per slot; `id_slot` picks the slot, otherwise slot 0; cache_prompt reuses the longest common prefix; slot files save and restore. */
class LlamaSim implements Transport {
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

/** vLLM with automatic prefix caching: reuse is per cache_salt, in whole 16-token blocks. */
class VllmSim implements Transport {
  readonly seen = new Map<string, string[][]>();
  constructor(readonly options: { oldVersion?: boolean } = {}) {}
  async send(r: HttpRequest): Promise<HttpResponse> {
    if (this.options.oldVersion === true && "cache_salt" in r.body) return refuse(400, "Unrecognized request argument: cache_salt");
    const salt = typeof r.body["cache_salt"] === "string" ? (r.body["cache_salt"] as string) : "";
    const t = tokensOf(r.body);
    const prior = this.seen.get(salt) ?? [];
    const best = prior.reduce((m, p) => Math.max(m, lcp(p, t)), 0);
    this.seen.set(salt, [...prior, t]);
    const cached = Math.floor(Math.min(best, t.length - 1) / 16) * 16;
    return ok({ usage: { prompt_tokens: t.length, completion_tokens: 3, prompt_tokens_details: { cached_tokens: cached } } });
  }
}

/** Claude Messages API: breakpoints write entries keyed by the exact prefix; entries expire by their lifetime; a read refreshes the entry. */
class ClaudeSim implements Transport {
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

const slotFile = (handle: string) => ({ kind: "slot-file", handle });
const scopeA = deriveKey("installation-secret-0123", "scope", "proj-a");
const scopeB = deriveKey("installation-secret-0123", "scope", "proj-b");
const ctx = (extra: Partial<CacheContext> = {}): CacheContext => ({ scopeKey: scopeA, ...extra });
const doc = (label: string, n: number): string => `${label}:`.padEnd(n * CHUNK, label);
const convo = (label: string, turns: number, n = 400): WireRequest => ({ model: "m", messages: [{ role: "system", content: doc(label, n) }, ...Array.from({ length: turns }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `turn ${i} of ${label}` }))] });

test("llama.cpp: agents that alternate keep their prompts when each has its own slot, and lose them all when they share one", async () => {
  const run = async (slots: number, useAffinity: boolean): Promise<{ computed: number; outcomes: string[] }> => {
    const sim = new LlamaSim(slots);
    const adapter = new CacheAdapter(profileFor({ kind: "llama-cpp", model: "m", options: { slots } }), sim);
    const affinity = new SlotAffinity(slots);
    const expected: Record<string, number> = {};
    let computed = 0; const outcomes: string[] = [];
    for (let round = 0; round < 4; round++) {
      for (const agent of ["a", "b"]) {
        const slot = useAffinity ? (affinity.assign("proj", agent) as { slot: number }).slot : 0;
        const r = await adapter.call(convo(agent, round * 2 + 1), ctx({ ...(slot === undefined ? {} : { slot }) }), expected[agent] ?? 0);
        assert.equal(r.status, 200);
        computed += r.hit.computedTokens; outcomes.push(`${agent}:${r.outcome}`);
        expected[agent] = r.hit.promptTokens - 10; // the stable part: the closing of the message list moves
      }
    }
    return { computed, outcomes };
  };
  const tuned = await run(2, true);
  const shared = await run(1, false);
  assert.ok(tuned.outcomes.slice(0, 2).every((o) => !o.endsWith(":miss")), "the first calls expected nothing");
  assert.deepEqual(tuned.outcomes.slice(2), ["a:hit", "b:hit", "a:hit", "b:hit", "a:hit", "b:hit"]);
  assert.ok(shared.outcomes.slice(2).every((o) => o.endsWith(":miss") || o.endsWith(":partial")), shared.outcomes.join());
  assert.ok(tuned.computed * 3 < shared.computed, `with a slot each only the new tokens are computed (${tuned.computed} against ${shared.computed})`);
});

test("llama.cpp: slot save and restore keep a conversation across eviction, restore into another slot forks it, and a refusal never throws", async () => {
  const sim = new LlamaSim(2);
  const adapter = new CacheAdapter(profileFor({ kind: "llama-cpp", model: "m", options: { slots: 2, slotSave: true } }), sim);
  const first = await adapter.call(convo("a", 1), ctx({ slot: 0 }));
  assert.equal(first.hit.cachedTokens, 0);
  assert.deepEqual(await adapter.slot("save", 0, slotFile("nn-abcdefgh2345.bin"), scopeA), { ok: true, tokens: first.hit.promptTokens, ms: 4.5 });
  await adapter.call(convo("z", 1), ctx({ slot: 0 })); // another agent takes slot 0
  const lost = await adapter.call(convo("a", 3), ctx({ slot: 0 }), first.hit.promptTokens - 10);
  assert.ok(lost.outcome !== "hit" && lost.hit.cachedTokens < 50, "the slot was overwritten by another agent");
  await adapter.slot("save", 0, slotFile("nn-zzzzzzzz2345.bin"), scopeA);
  assert.deepEqual(await adapter.slot("restore", 1, slotFile("nn-abcdefgh2345.bin"), scopeA), { ok: true, tokens: first.hit.promptTokens, ms: 3.1 });
  const forked = await adapter.call(convo("a", 3), ctx({ slot: 1 }), first.hit.promptTokens - 1);
  assert.ok(forked.hit.cachedTokens >= first.hit.promptTokens - 1, "the fork reads what was saved");
  assert.equal(forked.outcome, "hit");
  const gone = await adapter.slot("restore", 1, slotFile("nn-missing22345.bin"), scopeA);
  assert.deepEqual([gone.ok, gone.reason], [false, "status 404: file not found"]);
  const filesBefore = [...sim.files.keys()].sort();
  assert.deepEqual(await adapter.clearSlot(1), { ok: true });
  assert.deepEqual([...sim.files.keys()].sort(), filesBefore, "clearing a slot empties its KV cache and deletes no file");
  assert.equal((await new CacheAdapter(profileFor({ kind: "vllm", model: "m" }), new VllmSim()).clearSlot(0)).ok, false);
  await assert.rejects(() => adapter.slot("save", 0, undefined as never, scopeA), (e: unknown) => e instanceof DomainError && e.field === "marker", "a file name comes only from a resolved marker");
  await assert.rejects(() => adapter.slot("restore", 0, { kind: "prefix" }, scopeA), (e: unknown) => e instanceof DomainError && e.field === "marker");
  // unsupported where the profile says so
  const noSave = new CacheAdapter(profileFor({ kind: "llama-cpp", model: "m" }), sim);
  assert.match((await noSave.slot("save", 0, slotFile("nn-abcdefgh2345.bin"), scopeA)).reason ?? "", /^unsupported/);
  const vllm = new CacheAdapter(profileFor({ kind: "vllm", model: "m" }), new VllmSim());
  assert.equal((await vllm.slot("save", 0, slotFile("nn-abcdefgh2345.bin"), scopeA)).ok, false);
});

test("vLLM: projects with different salts never share a prefix; agents of one project do", async () => {
  const sim = new VllmSim();
  const adapter = new CacheAdapter(profileFor({ kind: "vllm", model: "m" }), sim);
  const shared = convo("common", 1, 600);
  assert.equal((await adapter.call(shared, ctx({ scopeKey: scopeA }))).hit.cachedTokens, 0);
  const sameProject = await adapter.call({ ...shared, messages: [...(shared["messages"] as unknown[]), { role: "assistant", content: "x" }, { role: "user", content: "agent two asks" }] }, ctx({ scopeKey: scopeA }), 500);
  assert.ok(sameProject.hit.cachedTokens >= 500, "a second agent of the same project reads the shared prefix");
  assert.equal(sameProject.outcome, "hit");
  const otherProject = await adapter.call(shared, ctx({ scopeKey: scopeB }));
  assert.deepEqual([otherProject.hit.known, otherProject.hit.cachedTokens, otherProject.outcome], [true, 0, "cold"], "another project's salt reads nothing, so it cannot probe by timing");
});

test("Claude: a long-lived head and a short-lived tail; the head survives a gap that kills the tail, and the marker's expiry shows as a partial or a miss", async () => {
  const sim = new ClaudeSim();
  const adapter = new CacheAdapter(profileFor({ kind: "claude", model: "claude-opus-5-5" }), sim);
  const request = (turns: number): WireRequest => ({ model: "claude-opus-5-5", system: doc("s", 800), messages: Array.from({ length: turns }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `${doc(String(i), 120)}` })) });
  const c = ctx({ retention: "long" });
  const one = await adapter.call(request(1), c);
  assert.deepEqual([one.hit.cachedTokens > 0, one.hit.writtenTokens > 0, one.outcome, one.hit.writtenByTtl!.oneHour > 0], [false, true, "cold", true]);
  const two = await adapter.call(request(3), c, one.hit.writtenTokens);
  assert.equal(two.outcome, "hit");
  assert.ok(two.hit.cachedTokens >= one.hit.writtenTokens);
  // five to ten minutes of silence: the five-minute tail is gone, the hour-long head is still there
  sim.now += 600_000;
  const three = await adapter.call(request(3), c, two.hit.promptTokens - 10);
  assert.equal(three.outcome, "partial");
  assert.ok(three.hit.cachedTokens > 0 && three.hit.cachedTokens < two.hit.promptTokens);
  // past the hour: everything is gone, and a hit that was expected is a miss
  sim.now += 3_700_000;
  const four = await adapter.call(request(3), c, three.hit.promptTokens - 10);
  assert.deepEqual([four.outcome, four.hit.cachedTokens], ["miss", 0]);
  assert.equal(four.status, 200, "the call still succeeded: a cache miss costs time, never the answer");
});

test("Claude: below the model's minimum nothing is marked and a zero is cold, not a miss", async () => {
  const sim = new ClaudeSim();
  const adapter = new CacheAdapter(profileFor({ kind: "claude", model: "claude-haiku-4-5" }), sim);
  const short = await adapter.call({ model: "m", system: doc("s", 200), messages: [{ role: "user", content: "hi" }] }, ctx());
  assert.deepEqual([short.applied, short.hit.writtenTokens, short.hit.cachedTokens, short.outcome], [[], 0, 0, "cold"]);
  assert.match(short.skipped.join(), /under the 4096-token minimum/);
  const again = await adapter.call({ model: "m", system: doc("s", 200), messages: [{ role: "user", content: "hi" }] }, ctx(), 500);
  assert.equal(again.outcome, "cold", "nothing was marked, so nothing is expected: not a miss for the profile");
});

test("a refused cache setting repeats the same messages without any cache setting: no context is lost, and the fallback is recorded", async () => {
  // Claude without the extended lifetime
  const claude = new ClaudeSim({ rejectTtl: true });
  const req: WireRequest = { model: "claude-opus-5-5", system: doc("s", 800), messages: [{ role: "user", content: "q" }] };
  const c = await new CacheAdapter(profileFor({ kind: "claude", model: "claude-opus-5-5" }), claude).call(req, ctx({ retention: "long" }));
  assert.equal(c.status, 200);
  assert.deepEqual(c.fallback?.removed, ["cache_control system-end 1h", "cache_control last-message 5m"]);
  assert.equal(c.fallback?.refusedStatus, 400);
  assert.match(c.fallback?.reason ?? "", /extended cache/);
  assert.equal(claude.seen.length, 2);
  assert.ok(!JSON.stringify(claude.seen[1]!.body).includes("cache_control"));
  assert.deepEqual(claude.seen[1]!.body["messages"], req["messages"], "the same messages went again");
  assert.equal(claude.seen[1]!.body["system"], req["system"], "and the same system prompt (as given, not rewritten)");
  assert.deepEqual([c.applied, c.outcome], [[], "cold"]);
  // an older vLLM that does not know cache_salt
  const v = await new CacheAdapter(profileFor({ kind: "vllm", model: "m" }), new VllmSim({ oldVersion: true })).call(convo("a", 1), ctx());
  assert.deepEqual([v.status, v.fallback?.removed], [200, ["cache_salt"]]);
  // llama.cpp build without slot selection
  const l = await new CacheAdapter(profileFor({ kind: "llama-cpp", model: "m", options: { slots: 2 } }), new LlamaSim(2, { rejectSlot: true })).call(convo("a", 1), ctx({ slot: 1 }));
  assert.deepEqual([l.status, l.fallback?.removed], [200, ["cache_prompt", "id_slot"]]);
  // an error that has nothing to do with the cache is returned as it is, and nothing is repeated
  let sent = 0;
  const failing: Transport = { send: async () => { sent++; return refuse(400, "maximum context length is 8192 tokens, cache_control is fine"); } };
  const overflow = await new CacheAdapter(profileFor({ kind: "claude", model: "claude-opus-5-5" }), failing).call(req, ctx());
  assert.deepEqual([overflow.status, sent, overflow.fallback !== undefined], [400, 2, true], "this wording mentions cache_control, so it is treated as refused once");
  sent = 0;
  const plainFailure: Transport = { send: async () => { sent++; return refuse(400, "maximum context length is 8192 tokens"); } };
  const r = await new CacheAdapter(profileFact(), plainFailure).call(req, ctx());
  assert.deepEqual([r.status, sent, r.fallback, r.outcome], [400, 1, undefined, "unknown"]);
  // a server error is not a refusal either
  const down: Transport = { send: async () => { sent++; return refuse(503, "cache_control overloaded"); } };
  sent = 0;
  assert.equal((await new CacheAdapter(profileFact(), down).call(req, ctx())).status, 503);
  assert.equal(sent, 1);
  // and when the plain repeat fails too, that failure is what the caller gets
  const always: Transport = { send: async (x) => (JSON.stringify(x.body).includes("cache_control") ? refuse(400, "cache_control not supported") : refuse(500, "boom")) };
  const both = await new CacheAdapter(profileFact(), always).call(req, ctx());
  assert.deepEqual([both.status, both.fallback?.refusedStatus], [500, 400]);
});
const profileFact = () => profileFor({ kind: "claude", model: "claude-opus-5-5" });

test("a cache reset or engine pause is never called through an adapter, whatever the path says", async () => {
  const sim = new LlamaSim(1);
  for (const [kind, path] of [["radiance", "/reset_prefix_cache"], ["vllm", "/reset_prefix_cache"], ["vllm", "/pause"], ["vllm", "/pause/now"]] as const) {
    const adapter = new CacheAdapter(profileFor({ kind, model: "m" } as EndpointConfig), sim, { path });
    await assert.rejects(adapter.call(convo("a", 1), ctx()), (e: unknown) => e instanceof DomainError && e.code === "forbidden" && /empties the server's cache/.test(e.message), `${kind} ${path}`);
  }
  assert.equal(sim.seen.length, 0, "nothing was sent");
  assert.equal((await new CacheAdapter(profileFor({ kind: "vllm", model: "m" }), sim, { path: "/pausefoo" }).call(convo("a", 1), ctx())).status, 200, "only the exact path and its sub-paths are refused");
});

test("Radiance, OpenAI-compatible and generic responses are read through their own fields; an unreadable response is unknown, never zero", async () => {
  const radiance = new CacheAdapter(profileFor({ kind: "radiance", model: "m" }), { send: async () => ok({ usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 90 } }, timings: { cache_n: 90, prompt_n: 10 } }) });
  const r = await radiance.call(convo("a", 1), ctx(), 90);
  assert.deepEqual([r.outcome, r.hit.cachedTokens, r.applied], ["hit", 90, ["session_id"]]);
  assert.match(r.hit.caveat ?? "", /hybrid/);
  const odd = new CacheAdapter(profileFor({ kind: "openai-compatible", model: "m" }), { send: async () => ok({ choices: [] }) });
  const o = await odd.call(convo("a", 1), ctx(), 90);
  assert.deepEqual([o.hit.known, o.outcome], [false, "unknown"]);
  const gen = new CacheAdapter(profileFor({ model: "m" }), { send: async () => ok({ usage: { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } } }) });
  assert.equal((await gen.call(convo("a", 1), ctx(), 5)).outcome, "cold", "the generic profile expects nothing, so a zero is not a miss");
  await assert.rejects(() => gen.call(convo("a", 1), ctx(), -1), (e: unknown) => e instanceof DomainError && e.field === "expectedCachedTokens");
});

test("judging a response: hit, partial, miss, cold or unknown", () => {
  const hit = (cached: number, known = true): CacheHit => ({ known, source: "s", promptTokens: 1000, cachedTokens: cached, computedTokens: 1000 - cached, writtenTokens: 0 });
  assert.deepEqual([judge(hit(900), "yes", 900), judge(hit(1000), "yes", 900), judge(hit(300), "yes", 900), judge(hit(0), "yes", 900)], ["hit", "hit", "partial", "miss"]);
  assert.deepEqual([judge(hit(0), "yes", 0), judge(hit(50), "yes", 0), judge(hit(0), "no", 900), judge(hit(0), "maybe", 900), judge(hit(0, false), "yes", 900)], ["cold", "hit", "cold", "cold", "unknown"]);
});

test("what goes to the usage ledger: the figures of a response that carried them, tagged with the backend and route, and nothing for one that did not", () => {
  const hit: CacheHit = { known: true, source: "s", promptTokens: 1000, cachedTokens: 600, computedTokens: 400, writtenTokens: 100 };
  assert.deepEqual(ledgerCache(hit, "claude", "anthropic/claude-opus-5-5"), { backend: "claude", route: "anthropic/claude-opus-5-5", cachedTokens: 600, computedTokens: 400, writtenTokens: 100 });
  assert.equal(ledgerCache({ ...hit, known: false }, "claude", "anthropic/claude-opus-5-5"), undefined);
});

test("Strata: a pin is sent only when the dispatcher holds the route's pin marker for the project", async () => {
  const sent: WireRequest[] = [];
  const adapter = new CacheAdapter(profileFor({ kind: "strata", model: "m", options: { pinPrefix: true } }), { send: async (r) => { sent.push(r.body); return ok({ timings: { cache_n: 0, prompt_n: 10 } }); } });
  const without = await adapter.call(convo("doc", 3), ctx({ pinMessages: 1 }));
  assert.equal(without.applied.includes("strata_prefix"), false);
  assert.match(without.skipped.join(), /holds no pin marker for the route/);
  assert.deepEqual((await adapter.call(convo("doc", 3), ctx({ pinMessages: 1, pinAuthorized: true }))).applied, ["strata_prefix"]);
  // two adapters for the same endpoint behave the same: neither pins on its own say-so
  const other = new CacheAdapter(profileFor({ kind: "strata", model: "m", options: { pinPrefix: true } }), { send: async (r) => { sent.push(r.body); return ok({}); } });
  assert.equal((await other.call(convo("doc", 3), ctx({ scopeKey: scopeB, pinMessages: 1 }))).applied.includes("strata_prefix"), false);
});

describe_slots();
function describe_slots(): void {
  const llama = (sim: LlamaSim, freshSlot?: "erase" | "off") => new CacheAdapter(profileFor({ kind: "llama-cpp", model: "m", options: { slots: 2, slotSave: true } }), sim, freshSlot === undefined ? {} : { freshSlot });
  const warm = async (sim: LlamaSim, scopeKey: string, slot: number, label = "x") => { const a = llama(sim); await a.call(convo(label, 1), ctx({ scopeKey, slot })); await a.call(convo(label, 1), ctx({ scopeKey, slot })); return a; };

  test("slots: a call with no slot (none given, or refused) runs with reuse off, so it cannot land in another project's slot", async () => {
    const sim = new LlamaSim(2);
    await warm(sim, scopeA, 0);
    const b = await llama(sim).call(convo("x", 1), ctx({ scopeKey: scopeB }));
    assert.deepEqual([b.hit.cachedTokens, b.applied, b.outcome], [0, ["cache_prompt=false"], "cold"]);
    assert.equal(sim.seen.at(-1)!.body["cache_prompt"], false);
    assert.equal(sim.seen.at(-1)!.body["id_slot"], undefined);
    assert.match(b.skipped.join(), /reuse is off/);
    // the refusal of SlotAffinity is the same case
    const full = new SlotAffinity(1);
    full.assign("projA", "g");
    const refused = full.assign("projB", "g");
    assert.ok("refused" in refused);
    const viaRefusal = await llama(sim).call(convo("x", 1), ctx({ scopeKey: scopeB, ..."slot" in refused ? { slot: (refused as { slot: number }).slot } : {} }));
    assert.equal(viaRefusal.hit.cachedTokens, 0);
    // a server that is not configured with slots keeps the old behaviour
    const unconfigured = await new CacheAdapter(profileFor({ kind: "llama-cpp", model: "m" }), new LlamaSim(1)).call(convo("x", 1), ctx());
    assert.deepEqual(unconfigured.applied, ["cache_prompt"]);
  });

  test("slots: a slot handed to another project (after a release, a restart, or a call without a slot) is cleared first, and the new holder then reuses its own prompt", async () => {
    const sim = new LlamaSim(2);
    await warm(sim, scopeA, 0);
    assert.ok(sim.slots[0]!.length > 0);
    // release-then-reassign: project B gets slot 0 while the server still holds A's KV there
    const affinity = new SlotAffinity(1);
    assert.deepEqual(affinity.assign("projA", "g"), { slot: 0 });
    affinity.release("projA", "g");
    const slot = (affinity.assign("projB", "g") as { slot: number }).slot;
    const bAdapter = llama(sim);
    const first = await bAdapter.call(convo("x", 1), ctx({ scopeKey: scopeB, slot }));
    assert.deepEqual([first.slotCleared, first.hit.cachedTokens, first.applied], [true, 0, ["cache_prompt", "id_slot"]]);
    assert.ok(sim.seen.some((r) => r.path === "/slots/0?action=erase"));
    const second = await bAdapter.call(convo("x", 1), ctx({ scopeKey: scopeB, slot }));
    assert.deepEqual([second.slotCleared, second.hit.cachedTokens > 0], [undefined, true], "B's own prompt is reused once it holds the slot");
    // a restart: a fresh adapter knows no holder, so even the same project's first call clears (a re-read, never a leak)
    const restarted = llama(sim);
    const afterRestart = await restarted.call(convo("x", 1), ctx({ scopeKey: scopeA, slot }));
    assert.deepEqual([afterRestart.slotCleared, afterRestart.hit.cachedTokens], [true, 0]);
    // a call that names no slot makes every slot's holder unknown
    await restarted.call(convo("x", 1), ctx({ scopeKey: scopeA, slot })); // A holds the slot again
    await restarted.call(convo("y", 1), ctx({ scopeKey: scopeB }));
    assert.equal((await restarted.call(convo("x", 1), ctx({ scopeKey: scopeA, slot }))).slotCleared, true);
  });

  test("slots: reuse is turned off instead when so configured or when the slot cannot be cleared; a restore makes the project the holder", async () => {
    const sim = new LlamaSim(2);
    await warm(sim, scopeA, 0);
    const seenBefore = sim.seen.length;
    const off = await llama(sim, "off").call(convo("x", 1), ctx({ scopeKey: scopeB, slot: 0 }));
    assert.deepEqual([off.slotCleared, off.hit.cachedTokens, off.applied], [undefined, 0, ["cache_prompt=false", "id_slot"]]);
    assert.ok(!sim.seen.slice(seenBefore).some((r) => r.path.includes("erase")));
    const stubborn: Transport = { send: async (r) => (r.path.includes("erase") ? refuse(404, "no such endpoint") : sim.send(r)) };
    await warm(sim, scopeA, 1, "q");
    const adapter = new CacheAdapter(profileFor({ kind: "llama-cpp", model: "m", options: { slots: 2 } }), stubborn);
    const r = await adapter.call(convo("q", 1), ctx({ scopeKey: scopeB, slot: 1 }));
    assert.deepEqual([r.slotCleared, r.hit.cachedTokens, r.applied], [undefined, 0, ["cache_prompt=false", "id_slot"]]);
    // restore: the saved state is the project's own, so the next call keeps it
    const a = llama(sim);
    await a.call(convo("r", 1), ctx({ scopeKey: scopeA, slot: 0 }));
    await a.slot("save", 0, slotFile("nn-abcdefgh2345.bin"), scopeA);
    const b = llama(sim);
    await b.slot("restore", 1, slotFile("nn-abcdefgh2345.bin"), scopeA);
    const kept = await b.call(convo("r", 3), ctx({ scopeKey: scopeA, slot: 1 }));
    assert.deepEqual([kept.slotCleared, kept.hit.cachedTokens > 0], [undefined, true]);
  });
}

test("slots: a refused id_slot retries with reuse off, forgets every holder, and a refused cache_prompt is returned as an error", async () => {
  const sent: HttpRequest[] = [];
  let rejected = false;
  const server: Transport = { send: async (r) => {
    sent.push(r);
    if (r.path.includes("erase")) return ok({});
    if (!rejected && "id_slot" in r.body) { rejected = true; return refuse(400, "unknown field id_slot"); }
    return ok({ timings: { cache_n: 0, prompt_n: 10 } });
  } };
  const adapter = new CacheAdapter(profileFor({ kind: "llama-cpp", model: "m", options: { slots: 2 } }), server);
  const first = await adapter.call(convo("x", 1), ctx({ slot: 1 }));
  assert.deepEqual(sent.map((r) => (r.path.includes("erase") ? "erase" : JSON.stringify({ cache_prompt: r.body["cache_prompt"], id_slot: r.body["id_slot"] }))), ["erase", '{"cache_prompt":true,"id_slot":1}', '{"cache_prompt":false}']);
  assert.deepEqual([first.status, first.fallback?.removed], [200, ["cache_prompt", "id_slot"]]);
  assert.ok(!("id_slot" in sent[2]!.body));
  // the retry went to an unknown slot, so slot 1 is not recorded as this project's: the next call clears it again
  sent.length = 0;
  await adapter.call(convo("x", 1), ctx({ slot: 1 }));
  assert.deepEqual(sent.map((r) => (r.path.includes("erase") ? "erase" : "call")), ["erase", "call"]);
  // a refusal that names cache_prompt itself cannot be answered safely: the error comes back and nothing is retried
  sent.length = 0;
  const strict: Transport = { send: async (r) => { sent.push(r); return r.path.includes("erase") ? ok({}) : refuse(400, "unknown field cache_prompt"); } };
  const refused = await new CacheAdapter(profileFor({ kind: "llama-cpp", model: "m", options: { slots: 2 } }), strict).call(convo("x", 1), ctx({ slot: 0 }));
  assert.deepEqual([refused.status, refused.fallback, sent.length], [400, undefined, 2]);
});

test("slots: adapters on one server share holders and affinity through the controller's registry, so a hand-over seen by one is seen by the other", async () => {
  const endpoints = new CacheEndpoints();
  assert.equal(endpoints.state("http://Host:8080/"), endpoints.state("http://host:8080"), "the URL is normalised");
  assert.notEqual(endpoints.state("http://host:8081"), endpoints.state("http://host:8080"));
  assert.throws(() => endpoints.state("not a url"), (e: unknown) => e instanceof DomainError && e.field === "url");
  const profile = () => profileFor({ kind: "llama-cpp", model: "m", options: { slots: 1 } });
  const run = async (state1: ReturnType<CacheEndpoints["state"]>, state2: ReturnType<CacheEndpoints["state"]>) => {
    const sim = new LlamaSim(1);
    const a = new CacheAdapter(profile(), sim, { state: state1 });
    const b = new CacheAdapter(profile(), sim, { state: state2 });
    await a.call(convo("x", 1), ctx({ scopeKey: scopeA, slot: 0 }));
    await a.call(convo("x", 1), ctx({ scopeKey: scopeA, slot: 0 }));
    const viaB = await b.call(convo("x", 1), ctx({ scopeKey: scopeB, slot: 0 }));
    assert.equal(viaB.hit.cachedTokens, 0, "B never reuses A's prompt");
    return a.call(convo("x", 1), ctx({ scopeKey: scopeA, slot: 0 }));
  };
  const shared = endpoints.state("http://shared:1");
  const together = await run(shared, shared);
  assert.deepEqual([together.slotCleared, together.hit.cachedTokens], [true, 0], "A sees that B held the slot, so A does not reuse B's prompt");
  const apart = await run(new CacheEndpoints().state("http://x:1"), new CacheEndpoints().state("http://y:1"));
  assert.ok(apart.hit.cachedTokens > 0, "with private state A would wrongly reuse B's prompt: this is what the registry prevents");
  // the slot affinity is shared as well
  const s = endpoints.state("http://affinity:1");
  assert.deepEqual(s.affinity(1).assign("projA", "g"), { slot: 0 });
  assert.ok("refused" in endpoints.state("http://AFFINITY:1/").affinity(1).assign("projB", "g"));
});

test("slots: a plain call on a slotted server may land anywhere, so it takes the server's turn and every holder is forgotten", async () => {
  const sim = new LlamaSim(2);
  const state = new CacheEndpoints().state("http://plain:1");
  const adapter = new CacheAdapter(profileFor({ kind: "llama-cpp", model: "m", options: { slots: 2 } }), sim, { state });
  await adapter.call(convo("x", 1), ctx({ scopeKey: scopeA, slot: 1 })); // A: slot 1 cleared, holder A
  await adapter.call(convo("x", 1), ctx({ scopeKey: scopeA, slot: 1 }));
  const plain = await adapter.call(convo("x", 1), ctx({ scopeKey: scopeB, slot: 1, plain: true }));
  assert.equal(sim.seen.at(-1)!.body["cache_prompt"], false);
  assert.equal(sim.seen.at(-1)!.body["id_slot"], undefined);
  assert.equal(plain.hit.cachedTokens, 0);
  sim.seen.length = 0;
  const again = await adapter.call(convo("x", 1), ctx({ scopeKey: scopeA, slot: 1 }));
  assert.deepEqual([again.slotCleared, sim.seen[0]!.path], [true, "/slots/1?action=erase"], "A's slot is cleared again: the plain call may have landed there");
});

test("slots: a restore records its holder inside the slot's turn, and not if what is known was wiped meanwhile", async () => {
  const sim = new LlamaSim(2);
  const state = new CacheEndpoints().state("http://restore:1");
  const adapter = new CacheAdapter(profileFor({ kind: "llama-cpp", model: "m", options: { slots: 2, slotSave: true } }), sim, { state });
  await adapter.call(convo("r", 1), ctx({ scopeKey: scopeA, slot: 0 }));
  await adapter.slot("save", 0, slotFile("nn-abcdefgh2345.bin"), scopeA);
  // a restore racing with a slot-less call of another project: the restore holds the slot's turn first, then the slot-less call forgets everything
  await Promise.all([adapter.slot("restore", 1, slotFile("nn-abcdefgh2345.bin"), scopeA), adapter.call(convo("o", 1), ctx({ scopeKey: scopeB }))]);
  assert.equal(state.holder.size, 0, "the slot-less call ran after the restore and forgot the holders");
  await adapter.slot("restore", 1, slotFile("nn-abcdefgh2345.bin"), scopeA);
  assert.equal(state.holder.get(1), scopeA);
  // a wipe during the restore (a retry placed anywhere) keeps the holder from being recorded
  const slow: Transport = { send: async (r) => { state.forget(); return sim.send(r); } };
  const racing = new CacheAdapter(profileFor({ kind: "llama-cpp", model: "m", options: { slots: 2, slotSave: true } }), slow, { state });
  state.holder.clear();
  await racing.slot("restore", 0, slotFile("nn-abcdefgh2345.bin"), scopeA);
  assert.equal(state.holder.has(0), false);
});

test("slots: calls of different projects into one slot take turns, so a clear and a send never interleave; other slots run side by side", async () => {
  const sim = new LlamaSim(2);
  const state = new CacheEndpoints().state("http://turns:1");
  const make = () => new CacheAdapter(profileFor({ kind: "llama-cpp", model: "m", options: { slots: 2 } }), sim, { state });
  await Promise.all([make().call(convo("pa", 1), ctx({ scopeKey: scopeA, slot: 0 })), make().call(convo("pb", 1), ctx({ scopeKey: scopeB, slot: 0 })), make().call(convo("pc", 1), ctx({ scopeKey: scopeA, slot: 1 }))]);
  const slot0 = sim.seen.filter((r) => r.path.startsWith("/slots/0") || r.body["id_slot"] === 0).map((r) => (r.path.includes("erase") ? "erase" : "chat"));
  assert.deepEqual(slot0, ["erase", "chat", "erase", "chat"], "never erase, erase, chat, chat");
});

test("a 422 that names the field we sent is a refused cache setting; one that names something else is returned as it is", async () => {
  const fastApi = (field: string): Transport => ({ send: async (r) => ((r.body as Record<string, unknown>)["cache_salt"] !== undefined ? { status: 422, body: { detail: [{ type: "extra_forbidden", loc: ["body", field], msg: "Extra inputs are not permitted" }] } } : ok({ usage: { prompt_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } } })) });
  const refused = await new CacheAdapter(profileFor({ kind: "vllm", model: "m" }), fastApi("cache_salt")).call(convo("a", 1), ctx());
  assert.deepEqual([refused.status, refused.fallback?.removed], [200, ["cache_salt"]]);
  const other = await new CacheAdapter(profileFor({ kind: "vllm", model: "m" }), fastApi("messages")).call(convo("a", 1), ctx());
  assert.deepEqual([other.status, other.fallback], [422, undefined]);
});

test("isolation required: a backend that cannot keep projects apart is called without cache settings and the result says why", async () => {
  const sim = new LlamaSim(2);
  const adapter = new CacheAdapter(profileFor({ kind: "llama-cpp", model: "m", options: { slots: 2 } }), sim);
  await adapter.call(convo("a", 1), ctx({ slot: 0 }));
  const iso = await adapter.call(convo("a", 3), ctx({ slot: 0, isolationRequired: true }), 500);
  assert.deepEqual([iso.hit.cachedTokens, iso.outcome, iso.applied], [0, "cold", ["cache_prompt=false"]]);
  assert.match(iso.skipped.join(), /requires isolation/);
  assert.equal(sim.seen.at(-1)!.body["id_slot"], undefined);
});
