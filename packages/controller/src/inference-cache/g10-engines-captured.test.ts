import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CacheAdapter, type CallResult, type HttpRequest, type HttpResponse, type Transport } from "./adapter.js";
import { isQualified, type CacheProfile, type EndpointOptions } from "./profile.js";
import { profileFor } from "./profiles.js";

// Card G10, llama.cpp and vLLM: the production C06 profiles and CacheAdapter re-tested against the responses captured on a rented GPU on 2026-11-25 by packages/integration/src/g10-engines-live-bench.ts
// (packages/integration/test-fixtures/g10-engines/README.md) and against the figures of every committed evidence row (docs/nimblenewt/implementation-plan/evidence/g10-*-run*.json). The bench was its own
// client when it ran; here the captured bodies go through the reader and the judging the dispatcher uses. Nothing here calls a server.

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "..", "..", "integration", "test-fixtures", "g10-engines");
const EVIDENCE = join(HERE, "..", "..", "..", "..", "docs", "nimblenewt", "implementation-plan", "evidence");
interface Fixture { readonly status: number; readonly body: Record<string, unknown> }
const load = (name: string): Fixture => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as Fixture;
interface Row { readonly phase: string; readonly step: string; readonly status: number; readonly promptTokens: number; readonly cachedTokens: number; readonly computedTokens?: number; readonly reported: boolean }
type Run = Record<"shared" | "extras" | "idle" | "concurrency" | "eviction", { readonly steps: readonly Row[] } | undefined>;
const run = (file: string): Run => JSON.parse(readFileSync(join(EVIDENCE, file), "utf8")) as Run;
const row = (r: Run, phase: keyof Run, step: string): Row => { const s = r[phase]?.steps.find((x) => x.step === step); assert.ok(s !== undefined, `${String(phase)}/${step}`); return s; };
const usage = (b: Record<string, unknown>): { prompt_tokens: number; prompt_tokens_details: { cached_tokens: number; created_cache_tokens?: number } } => b["usage"] as never;
const llama = (options: EndpointOptions = {}): CacheProfile => profileFor({ kind: "llama-cpp", model: "qwen3-8b-q8", options });
const vllm = (options: EndpointOptions = {}): CacheProfile => profileFor({ kind: "vllm", model: "Qwen/Qwen3-8B", options });
const ctxA = { scopeKey: "nn-scopeAAAAAAAAAAAAAAA", shareKey: "nn-shareAAAAAAAAAAAAAAA" };
const ctxB = { scopeKey: "nn-scopeBBBBBBBBBBBBBBB" };
const request = { model: "m", stream: true, messages: [{ role: "system", content: "head" }, { role: "user", content: "q" }] };

/** Replays the given model responses in order; slot actions (erase, save, restore) answer 200 without taking a reply. Keeps everything sent. */
function replay(...replies: Fixture[]): { transport: Transport; seen: HttpRequest[] } {
  const seen: HttpRequest[] = []; let i = 0;
  return { seen, transport: { send: async (r): Promise<HttpResponse> => { seen.push(r); if (r.path.startsWith("/slots/")) return { status: 200, body: {} }; const f = replies[Math.min(i++, replies.length - 1)]!; return { status: f.status, body: structuredClone(f.body) }; } } };
}
/** A committed evidence row's figures put into the captured response shape of its engine (the bench kept only the figures for rows other than the four captured ones). */
function shaped(kind: "llamacpp" | "vllm", r: Row): Record<string, unknown> {
  const b = structuredClone(load(`${kind}-shared-hit`).body);
  const u = usage(b); u.prompt_tokens = r.promptTokens; u.prompt_tokens_details.cached_tokens = r.cachedTokens;
  if (kind === "llamacpp") { const t = b["timings"] as Record<string, number>; t["cache_n"] = r.cachedTokens; t["prompt_n"] = r.promptTokens - r.cachedTokens; }
  return b;
}

test("captured llama.cpp responses through the production profile: hits from timings.cache_n and prompt_n, agreeing with the usage copy this build also sends and with the committed evidence rows", () => {
  const r1 = run("g10-llamacpp-run1.json");
  for (const options of [{}, { slots: 4 }, { slots: 4, slotSave: true, hostPromptCacheOff: true }] satisfies EndpointOptions[]) {
    const p = llama(options);
    for (const [name, step, cached, computed] of [["llamacpp-cold", "cold", 0, 6472], ["llamacpp-shared-hit", "second-conversation", 6454, 18]] as const) {
      const body = load(name).body;
      const hit = p.read(body);
      assert.deepEqual([hit.known, hit.source, hit.promptTokens, hit.cachedTokens, hit.computedTokens, hit.writtenTokens], [true, "timings.cache_n + timings.prompt_n", 6472, cached, computed, 0], `${name} ${JSON.stringify(options)}`);
      assert.equal(hit.promptTokens, usage(body).prompt_tokens, `${name}: cache_n + prompt_n is the whole prompt`);
      assert.equal(hit.cachedTokens, usage(body).prompt_tokens_details.cached_tokens, `${name}: the two hit fields agree`);
      const evidence = row(r1, "shared", step);
      assert.deepEqual([hit.promptTokens, hit.cachedTokens], [evidence.promptTokens, evidence.cachedTokens], `${name} is the evidence row shared/${step}`);
      // A proxy that drops timings: the usage field this build repeats the figure in gives the same reading.
      const { timings: _t, ...withoutTimings } = body;
      const fallback = p.read(withoutTimings);
      assert.deepEqual([fallback.known, fallback.source, fallback.promptTokens, fallback.cachedTokens], [true, "usage.prompt_tokens_details.cached_tokens", hit.promptTokens, hit.cachedTokens], name);
    }
  }
});

test("captured llama.cpp responses through the production CacheAdapter, in the three server configurations G10 ran or C06e needs: cold, hit and miss are judged as the dispatcher would see them", async () => {
  // (a) As the bench ran it: no slots configured, so the server places each call by similarity with reuse on and no id_slot is sent.
  {
    const { transport, seen } = replay(load("llamacpp-cold"), load("llamacpp-shared-hit"), load("llamacpp-cold"));
    const a = new CacheAdapter(llama(), transport);
    const out: CallResult[] = [await a.call(request, ctxA, 0), await a.call(request, ctxA, 1)];
    out.push(await a.call(request, ctxA, out[1]!.hit.cachedTokens)); // a changed head after a hit: nothing served where 6,454 were expected
    assert.deepEqual(out.map((r) => [r.outcome, r.hit.cachedTokens, r.isolation]), [["cold", 0, "reuse-slots-not-configured"], ["hit", 6454, "reuse-slots-not-configured"], ["miss", 0, "reuse-slots-not-configured"]]);
    assert.deepEqual(seen.map((s) => [s.path, s.body["cache_prompt"], "id_slot" in s.body]), Array(3).fill(["/v1/chat/completions", true, false]));
  }
  // (b) Run 1's server (default host prompt cache) with its 4 slots configured and not attested: the first call into slot 0 has an unknown holder, so it is sent with reuse off and nothing is erased;
  // the project's next call is the slot's own and reuses.
  {
    const { transport, seen } = replay(load("llamacpp-cold"), load("llamacpp-shared-hit"), load("llamacpp-cold"));
    const a = new CacheAdapter(llama({ slots: 4, slotSave: true }), transport);
    const first = await a.call(request, { ...ctxA, slot: 0 }, 0);
    const second = await a.call(request, { ...ctxA, slot: 0 }, 1);
    const third = await a.call(request, { ...ctxA, slot: 0 }, second.hit.cachedTokens);
    assert.deepEqual([first.outcome, first.isolation, second.outcome, second.isolation, third.outcome], ["cold", "cache-prompt-off-host-cache-not-attested", "hit", "same-project", "miss"]);
    assert.deepEqual(seen.map((s) => [s.path, s.body["cache_prompt"], s.body["id_slot"]]), [["/v1/chat/completions", false, 0], ["/v1/chat/completions", true, 0], ["/v1/chat/completions", true, 0]]);
    assert.equal(seen.some((s) => s.path.includes("action=erase")), false, "an unattested server is never erased-then-reused");
  }
  // (c) Run 2's server (--cache-ram 0) attested: the slot is erased first and the call reuses; another project then gets the slot erased again before its call.
  {
    const { transport, seen } = replay(load("llamacpp-cold"), load("llamacpp-shared-hit"), load("llamacpp-cold"));
    const a = new CacheAdapter(llama({ slots: 4, slotSave: true, hostPromptCacheOff: true }), transport);
    const first = await a.call(request, { ...ctxA, slot: 0 }, 0);
    const second = await a.call(request, { ...ctxA, slot: 0 }, 1);
    const other = await a.call(request, { ...ctxB, slot: 0 }, 0);
    assert.deepEqual([first.outcome, first.isolation, first.slotCleared, second.outcome, second.isolation, other.outcome, other.isolation], ["cold", "erase-host-cache-attested-off", true, "hit", "same-project", "cold", "erase-host-cache-attested-off"]);
    assert.deepEqual(seen.map((s) => s.path), ["/slots/0?action=erase", "/v1/chat/completions", "/v1/chat/completions", "/slots/0?action=erase", "/v1/chat/completions"]);
    for (const s of seen.filter((x) => x.path.startsWith("/v1/"))) { assert.deepEqual([s.body["cache_prompt"], s.body["id_slot"]], [true, 0]); for (const f of ["cache_salt", "session_id", "prompt_cache_key"]) assert.equal(f in s.body, false, f); }
  }
});

test("captured vLLM responses through the production profile and CacheAdapter: hits from usage.prompt_tokens_details.cached_tokens, cache_salt sent per project, and a response without the field is unknown, not zero", async () => {
  const v = run("g10-vllm-run1.json");
  const p = vllm({ promptDetails: true });
  for (const [name, step, cached] of [["vllm-cold", "cold", 0], ["vllm-shared-hit", "second-conversation", 6400]] as const) {
    const body = load(name).body;
    const hit = p.read(body);
    assert.deepEqual([hit.known, hit.source, hit.promptTokens, hit.cachedTokens, hit.computedTokens], [true, "usage.prompt_tokens_details.cached_tokens", 6470, cached, 6470 - cached], name);
    assert.deepEqual([hit.promptTokens, hit.cachedTokens], [row(v, "shared", step).promptTokens, row(v, "shared", step).cachedTokens], `${name} is the evidence row shared/${step}`);
    // This build also reports created_cache_tokens (6,464 cold, 64 on the hit); the profile does not read it, so nothing is counted as written.
    assert.ok((usage(body).prompt_tokens_details.created_cache_tokens ?? 0) > 0);
    assert.equal(hit.writtenTokens, 0);
  }
  // Without --enable-prompt-tokens-details: as configured, and as the server's own body would be without the details.
  assert.equal(vllm({ promptDetails: false }).read(load("vllm-shared-hit").body).known, false);
  const noDetails = structuredClone(load("vllm-shared-hit").body); delete (noDetails["usage"] as Record<string, unknown>)["prompt_tokens_details"];
  assert.equal(p.read(noDetails).known, false);
  const unknown = await new CacheAdapter(p, replay({ status: 200, body: noDetails }).transport).call(request, ctxA, 6400);
  assert.equal(unknown.outcome, "unknown", "a missing figure is never judged a miss");

  const { transport, seen } = replay(load("vllm-cold"), load("vllm-shared-hit"), load("vllm-cold"), load("vllm-cold"));
  const a = new CacheAdapter(p, transport);
  const cold = await a.call(request, ctxA, 0);
  const hit = await a.call(request, ctxA, 1);
  const miss = await a.call(request, ctxA, hit.hit.cachedTokens);
  const otherProject = await a.call(request, ctxB, 0);
  assert.deepEqual([cold.outcome, hit.outcome, miss.outcome, otherProject.outcome], ["cold", "hit", "miss", "cold"]);
  assert.deepEqual(seen.map((s) => s.body["cache_salt"]), [ctxA.scopeKey, ctxA.scopeKey, ctxA.scopeKey, ctxB.scopeKey], "the salt is the project's scope key, not the share key");
  for (const s of seen) for (const f of ["cache_prompt", "id_slot", "session_id", "prompt_cache_key"]) assert.equal(f in s.body, false, f);
});

test("every committed llama.cpp and vLLM evidence row, put in its engine's captured shape, is read by the production profile as the bench recorded it", () => {
  const files = [["g10-llamacpp-run1.json", "llamacpp"], ["g10-llamacpp-run2.json", "llamacpp"], ["g10-vllm-run1.json", "vllm"]] as const;
  let count = 0;
  for (const [file, kind] of files) {
    const p = kind === "llamacpp" ? llama({ slots: 4 }) : vllm();
    const r = run(file);
    for (const phase of ["shared", "extras", "idle", "concurrency", "eviction"] as const) {
      for (const s of r[phase]?.steps ?? []) {
        if (s.status !== 200 || !s.reported) continue;
        const hit = p.read(shaped(kind, s));
        assert.deepEqual([hit.known, hit.promptTokens, hit.cachedTokens], [true, s.promptTokens, s.cachedTokens], `${file} ${phase}/${s.step}`);
        if (s.computedTokens !== undefined) assert.equal(hit.computedTokens, s.computedTokens, `${file} ${phase}/${s.step}`);
        count++;
      }
    }
  }
  assert.ok(count >= 100, `rows read: ${count}`);
});

test("the qualifications rest on the committed rows: each figure a qualification quotes is the production profile's reading of that row", () => {
  const n = (x: number): string => x.toLocaleString("en-US");
  const [r1, r2, v] = [run("g10-llamacpp-run1.json"), run("g10-llamacpp-run2.json"), run("g10-vllm-run1.json")];
  const read = (kind: "llamacpp" | "vllm", r: Run, phase: keyof Run, step: string): { cached: number; prompt: number } => { const h = (kind === "llamacpp" ? llama({ slots: 4 }) : vllm()).read(shaped(kind, row(r, phase, step))); return { cached: h.cachedTokens, prompt: h.promptTokens }; };
  const evidenceOf = (p: CacheProfile, capability: string): string => { const q = (p.qualifications ?? []).find((x) => x.capability === capability); assert.ok(q !== undefined, `${p.kind} ${capability}`); return q.evidence; };
  // The figure as a whole number: "0 of 6,471" must not be found inside "6,470 of 6,471".
  const quotes = (text: string, h: { cached: number; prompt: number }, label: string): void => assert.ok(new RegExp(`(?<![\\d,])${n(h.cached)} of ${n(h.prompt)}(?![\\d,]\\d)`).test(text), `${label}: "${n(h.cached)} of ${n(h.prompt)}" in ${text}`);
  const full = llama({ slots: 4, slotSave: true, hostPromptCacheOff: true });
  // llama.cpp
  quotes(evidenceOf(full, "prefix-reuse"), read("llamacpp", r1, "shared", "second-conversation"), "llama prefix reuse");
  quotes(evidenceOf(full, "prefix-reuse"), read("llamacpp", r1, "shared", "cold"), "llama cold");
  for (const [r, label] of [[r1, "run 1"], [r2, "run 2"]] as const) {
    const off = read("llamacpp", r, "extras", "cache-prompt-off"); assert.equal(off.cached, 0, label); quotes(evidenceOf(full, "reuse-off"), off, `reuse off ${label}`);
    const again = read("llamacpp", r, "extras", "slot0-again"); assert.ok(again.cached / again.prompt > 0.99, label); quotes(evidenceOf(full, "slot-affinity"), again, `same slot ${label}`);
    const other = read("llamacpp", r, "extras", "slot1-same-head"); assert.ok(other.cached < 10, label); quotes(evidenceOf(full, "slot-affinity"), other, `other slot ${label}`);
  }
  const erased = read("llamacpp", r2, "extras", "slot0-after-erase"); const restored = read("llamacpp", r2, "extras", "slot0-after-restore");
  assert.deepEqual([erased.cached, restored.cached / restored.prompt > 0.99], [0, true]);
  quotes(evidenceOf(full, "slot-save-restore"), erased, "erase"); quotes(evidenceOf(full, "slot-save-restore"), restored, "restore");
  // run 1 (host cache on): the erase left the head, so the restore proves nothing and the capability is not qualified there
  assert.ok(read("llamacpp", r1, "extras", "slot0-after-erase").cached > 6000);
  assert.equal(isQualified(llama({ slots: 4, slotSave: true }), "slot-save-restore"), false);
  // vLLM
  const vp = vllm();
  quotes(evidenceOf(vp, "prefix-reuse"), read("vllm", v, "shared", "second-conversation"), "vllm second");
  quotes(evidenceOf(vp, "fork"), read("vllm", v, "shared", "third-conversation"), "vllm third");
  const same = read("vllm", v, "extras", "salt-a-again"); quotes(evidenceOf(vp, "isolation"), same, "same salt");
  assert.deepEqual([read("vllm", v, "extras", "salt-b-same-head").cached, read("vllm", v, "extras", "no-salt-same-head").cached], [0, 0], "another salt and no salt reused nothing");
  for (const level of [1, 2, 4, 8]) for (let i = 1; i <= level; i++) assert.ok(read("vllm", v, "concurrency", `n${level}-warm-${i}`).cached >= 6400, `vllm n${level}-warm-${i}`);
  for (const gap of [0, 15, 30, 60, 120]) assert.equal(read("vllm", v, "idle", `after-${gap}s`).cached, 6400, `vllm after ${gap} s`);
});
