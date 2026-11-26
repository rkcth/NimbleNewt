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
  // The figure in the clause it belongs to: from the lead words up to the next ";" (or, instead, the given stop words), so two figures swapped between "same slot" and "another slot" are caught.
  const clause = (text: string, lead: string, stop?: string): string => {
    const i = text.indexOf(lead); assert.ok(i >= 0, `"${lead}" in ${text}`);
    const rest = text.slice(i + lead.length); const ends = [rest.indexOf(stop ?? ";")].filter((x) => x >= 0);
    return ends.length === 0 ? rest : rest.slice(0, Math.min(...ends));
  };
  const full = llama({ slots: 4, slotSave: true, hostPromptCacheOff: true });
  // llama.cpp
  quotes(clause(evidenceOf(full, "prefix-reuse"), "a second and a third conversation"), read("llamacpp", r1, "shared", "second-conversation"), "llama prefix reuse");
  quotes(clause(evidenceOf(full, "prefix-reuse"), "a new head computed in full"), read("llamacpp", r1, "shared", "cold"), "llama cold");
  // concurrent reuse is stated as not qualified, with the counts of the rows
  const warmReused = (r: Run, level: number): number => Array.from({ length: level }, (_, i) => read("llamacpp", r, "concurrency", `n${level}-warm-${i + 1}`)).filter((h) => h.cached / h.prompt > 0.5).length;
  const counts = [2, 4, 8].map((l) => warmReused(r1, l));
  assert.deepEqual([2, 4, 8].map((l) => warmReused(r2, l)), counts, "both runs");
  assert.ok(evidenceOf(full, "prefix-reuse").includes(`with 2, 4 and 8 sent at once only ${counts[0]}, ${counts[1]} and ${counts[2]} of the warm requests reused`), `concurrent counts ${counts.join(", ")}`);
  for (const [r, label] of [[r1, "run 1"], [r2, "run 2"]] as const) {
    const off = read("llamacpp", r, "extras", "cache-prompt-off"); assert.equal(off.cached, 0, label); quotes(clause(evidenceOf(full, "reuse-off"), "cache_prompt false computed everything", ")"), off, `reuse off ${label}`);
    const again = read("llamacpp", r, "extras", "slot0-again"); assert.ok(again.cached / again.prompt > 0.99, label); quotes(clause(evidenceOf(full, "slot-affinity"), "id_slot 0 again reused"), again, `same slot ${label}`);
    const other = read("llamacpp", r, "extras", "slot1-same-head"); assert.ok(other.cached < 10, label); quotes(clause(evidenceOf(full, "slot-affinity"), "named into slot 1 reused"), other, `other slot ${label}`);
  }
  const erased = read("llamacpp", r2, "extras", "slot0-after-erase"); const restored = read("llamacpp", r2, "extras", "slot0-after-restore");
  assert.deepEqual([erased.cached, restored.cached / restored.prompt > 0.99], [0, true]);
  quotes(clause(evidenceOf(full, "slot-save-restore"), "after the erase", "after the restore"), erased, "erase"); quotes(clause(evidenceOf(full, "slot-save-restore"), "after the restore into the same slot"), restored, "restore");
  // run 1 (host cache on): the erase left the head, so the restore proves nothing and the capability is not qualified there
  assert.ok(read("llamacpp", r1, "extras", "slot0-after-erase").cached > 6000);
  assert.equal(isQualified(llama({ slots: 4, slotSave: true }), "slot-save-restore"), false);
  // vLLM
  const vp = vllm();
  quotes(clause(evidenceOf(vp, "prefix-reuse"), "a second conversation", " and a third"), read("vllm", v, "shared", "second-conversation"), "vllm second");
  quotes(evidenceOf(vp, "fork"), read("vllm", v, "shared", "third-conversation"), "vllm third");
  const same = read("vllm", v, "extras", "salt-a-again"); quotes(clause(evidenceOf(vp, "isolation"), "under the same cache_salt"), same, "same salt");
  const [otherSalt, noSalt] = [read("vllm", v, "extras", "salt-b-same-head").cached, read("vllm", v, "extras", "no-salt-same-head").cached];
  assert.ok(evidenceOf(vp, "isolation").includes(`under another salt ${n(otherSalt)}, with no salt ${n(noSalt)}`), "the other-salt and no-salt figures are the rows'");
  assert.match(evidenceOf(vp, "isolation"), /only for calls that carry the salt/, "the condition the measurement covers is stated");
  assert.deepEqual([read("vllm", v, "extras", "salt-b-same-head").cached, read("vllm", v, "extras", "no-salt-same-head").cached], [0, 0], "another salt and no salt reused nothing");
  for (const level of [1, 2, 4, 8]) for (let i = 1; i <= level; i++) assert.ok(read("vllm", v, "concurrency", `n${level}-warm-${i}`).cached >= 6400, `vllm n${level}-warm-${i}`);
  for (const gap of [0, 15, 30, 60, 120]) assert.equal(read("vllm", v, "idle", `after-${gap}s`).cached, 6400, `vllm after ${gap} s`);
});

test("the Radiance qualifications quote the committed Radiance rows: each repeat's and fork's figures, the fork's server prompt times against the cold ones, and run 2's reuse at every stream count", () => {
  interface RStep { readonly repeat?: number; readonly step: string; readonly promptTokens: number; readonly cachedTokens: number; readonly serverPromptMs: number; readonly correct: boolean }
  const r1 = JSON.parse(readFileSync(join(EVIDENCE, "g10-radiance-run1.json"), "utf8")) as { partA: { steps: RStep[] } };
  const r2 = JSON.parse(readFileSync(join(EVIDENCE, "g10-radiance-run2.json"), "utf8")) as { concurrency: { levels: { repeat: RStep[] }[] } };
  const p = profileFor({ kind: "radiance", model: "m" });
  const ev = (c: string): string => (p.qualifications ?? []).find((q) => q.capability === c)!.evidence;
  const n = (x: number): string => x.toLocaleString("en-US");
  const of = (name: string): RStep[] => r1.partA.steps.filter((s) => s.step === name);
  const [cold, repeat, fork] = [of("cold"), of("repeat"), of("fork")];
  assert.deepEqual([cold.length, repeat.length, fork.length], [3, 3, 3]);
  assert.ok(cold.every((s) => s.cachedTokens === 0) && ev("prefix-reuse").includes(`a new head 0 of ${n(cold[0]!.promptTokens)} cached`));
  const cached = new Set(repeat.map((s) => s.cachedTokens)); assert.equal(cached.size, 1);
  assert.ok(ev("prefix-reuse").includes(`again ${n(repeat[0]!.cachedTokens)} of ${repeat.slice(0, -1).map((s) => n(s.promptTokens)).join(", ")} and ${n(repeat.at(-1)!.promptTokens)} in three repeats`), ev("prefix-reuse"));
  assert.ok(ev("fork").includes(`${n(fork[0]!.cachedTokens)} of ${n(fork[0]!.promptTokens)} cached, answered right in ${fork.filter((s) => s.correct).length} of 3`), ev("fork"));
  const range = (xs: number[]): string => `${(Math.min(...xs) / 1000).toFixed(1)} to ${(Math.max(...xs) / 1000).toFixed(1)} s`;
  assert.ok(ev("fork").includes(`server prompt time ${range(fork.map((s) => s.serverPromptMs))} against ${range(cold.map((s) => s.serverPromptMs))} cold`), ev("fork"));
  const repeats2 = r2.concurrency.levels.flatMap((l) => l.repeat);
  assert.equal(repeats2.length, 15);
  assert.ok(repeats2.every((s) => s.cachedTokens === 6144) && ev("prefix-reuse").includes("6,144 of about 6,673 on every repeat at 1, 2, 4 and 8 streams"));
  assert.ok(repeats2.every((s) => Math.abs(s.promptTokens - 6673) <= 3), "about 6,673");
});

test("the capability matrix in g10-evidence.md marks qualified exactly what the profiles qualify, and says not measured for Claude, Strata and an OpenAI-compatible service", () => {
  const doc = readFileSync(join(EVIDENCE, "..", "g10-evidence.md"), "utf8");
  const section = doc.slice(doc.indexOf("## Capability matrix"), doc.indexOf("## Stated limits of the narrowed card"));
  const rowOf = (name: string): string[] => { const line = section.split("\n").find((l) => l.startsWith(`| ${name} `)); assert.ok(line !== undefined, name); return line.split("|").slice(1, -1).map((c) => c.trim()); };
  const header = section.split("\n").find((l) => l.startsWith("| Backend"))!.split("|").slice(1, -1).map((c) => c.trim());
  const col = (h: string): number => { const i = header.findIndex((x) => x.startsWith(h)); assert.ok(i >= 0, h); return i; };
  const q = (cell: string): boolean => cell.includes("**qualified");
  const radiance = rowOf("Radiance"), vllmRow = rowOf("vLLM"), llamaRow = rowOf("llama.cpp");
  assert.deepEqual([q(radiance[col("Prefix reuse")]!), q(radiance[col("Fork")]!), q(radiance[col("Isolation")]!)], [true, true, false]);
  assert.deepEqual([q(vllmRow[col("Prefix reuse")]!), q(vllmRow[col("Fork")]!), q(vllmRow[col("Isolation")]!), q(vllmRow[col("Pin")]!)], [true, true, true, false]);
  assert.deepEqual([q(llamaRow[col("Prefix reuse")]!), q(llamaRow[col("Fork")]!), q(llamaRow[col("Pin")]!), q(llamaRow[col("Slot save")]!), q(llamaRow[col("Other qualified")]!)], [true, false, false, true, true]);
  assert.match(llamaRow[col("Isolation")]!, /^none; `cache_prompt: false` \*\*qualified\*\* as reuse off/, "llama.cpp keeps no projects apart; only reuse off is qualified");
  assert.match(llamaRow[col("Prefix reuse")]!, /one request at a time.*concurrent reuse not qualified/);
  assert.match(llamaRow[col("Slot save")]!, /only with `--cache-ram 0` attested/);
  assert.match(vllmRow[col("Isolation")]!, /only for calls that carry the salt/);
  for (const name of ["Claude", "Strata", "OpenAI-compatible service", "OpenAI (through Hermes)"]) {
    const row = rowOf(name); assert.equal(row.some(q), false, `${name}: nothing qualified`);
  }
  for (const name of ["Claude", "Strata"]) assert.match(rowOf(name)[col("Status")]!, /experimental, not measured/);
  assert.match(rowOf("OpenAI-compatible service")[col("Status")]!, /^not measured$/);
});
