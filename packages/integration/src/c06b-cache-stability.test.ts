import assert from "node:assert/strict";
import { test } from "node:test";
import { piCachePolicy, profileFor } from "@nimblenewt/controller";
import { ClaudeSim, LlamaSim, VllmSim } from "@nimblenewt/controller/testing";
import { cachedShare, computed, run, texts, type Backend } from "./c06b-scenario.js";

// Card C06b, measured: two agents of one project take turns (a context switch on every request). The conversation (c06b-scenario.ts) is run twice per backend, once with the NimbleNewt layout and cache policy and once with the
// layout a caller gets from Pi Durable 1.3.0 by assembling sections and tools naively. Each request is the exact body pi-ai builds for the provider, sent to a simulated server of that backend, and the hit is read with that
// backend's own profile (C06) from the fields that backend reports. The simulators model only position-based prefix reuse; the figures are not measurements of real servers (G10 runs the same conversation against Radiance:
// g10-radiance-bench.ts), but they show which layout leaves reusable bytes in front.

const BACKENDS: Backend[] = [
  { name: "llama.cpp", profile: () => profileFor({ kind: "llama-cpp", model: "m", options: { slots: 2 } }), wire: "openai-completions", server: () => new LlamaSim(2), sharesAcrossAgents: false, charsPerToken: 4, slot: (a) => (a === "reviewer" ? 0 : 1) },
  { name: "vLLM", profile: () => profileFor({ kind: "vllm", model: "m", options: { promptDetails: true } }), wire: "openai-completions", server: () => new VllmSim(), sharesAcrossAgents: true, charsPerToken: 4 },
  { name: "Radiance", profile: () => profileFor({ kind: "radiance", model: "m" }), wire: "openai-completions", server: () => new VllmSim({ shape: "timings" }), sharesAcrossAgents: true, charsPerToken: 4 },
  { name: "Strata", profile: () => profileFor({ kind: "strata", model: "m" }), wire: "openai-completions", server: () => new VllmSim({ shape: "timings" }), sharesAcrossAgents: true, charsPerToken: 4 },
  { name: "OpenAI", profile: () => profileFor({ kind: "openai", model: "gpt-x", options: { promptCacheKey: true } }), wire: "openai-completions", server: () => new VllmSim(), sharesAcrossAgents: true, charsPerToken: 4 },
  { name: "Claude", profile: () => profileFor({ kind: "claude", model: "claude-opus-5-5" }), wire: "anthropic-messages", server: () => new ClaudeSim({ minTokens: 100 }), sharesAcrossAgents: true, charsPerToken: 3 },
];

for (const backend of BACKENDS) {
  test(`${backend.name}: after every context switch the agent's own history and, where the backend shares, the project's head are reused; the naive layout reuses less`, async () => {
    const ours = await run(backend, "nimblenewt");
    if (backend.slot !== undefined) {
      // A slotted server needs C06's slot partitioning around the HTTP call. This measurement applies only the body policy (no adapter state), so it runs with reuse off; with the dispatcher's CachePolicies the call goes through CacheAdapter and reuses (h12e-pi-cache.test.ts).
      assert.deepEqual(ours.hits.map((h) => h.cachedTokens), [0, 0, 0, 0, 0, 0]);
      assert.match(piCachePolicy(backend.profile(), { scopeKey: "x" }).degraded ?? "", /slotted server/);
      return;
    }
    const legacy = await run(backend, "legacy");
    // Each agent's later requests read nearly all of its own previous prompt.
    for (const i of [2, 3, 4, 5]) {
      const previous = ours.hits[i - 2]!;
      assert.ok(ours.hits[i]!.cachedTokens >= previous.promptTokens * 0.8, `${backend.name} request ${i + 1} (${ours.order[i]}): cached ${ours.hits[i]!.cachedTokens} of the ${previous.promptTokens} tokens its agent sent last time`);
    }
    // The second agent's first request reads the head the first agent left: tools, preamble and project context are the same bytes (Claude: at its tools and shared-system breakpoints).
    const { PREAMBLE, PROJECT } = texts();
    const headChars = PREAMBLE.length + PROJECT.length;
    if (backend.sharesAcrossAgents) assert.ok(ours.hits[1]!.cachedTokens >= (headChars / backend.charsPerToken) * 0.8, `${backend.name}: the tester's first request cached ${ours.hits[1]!.cachedTokens} tokens, expected the shared head of about ${Math.round(headChars / backend.charsPerToken)}`);
    else assert.ok(ours.hits[1]!.cachedTokens <= 16, `${backend.name}: a backend that keeps a slot per agent shares nothing across agents`);
    assert.ok(computed(ours) < computed(legacy), `${backend.name}: computed ${computed(ours)} tokens with the NimbleNewt layout against ${computed(legacy)} with the naive one`);
    // Record the figures for G10: tokens computed over the six requests, and the share served from cache.
    process.stdout.write(`# C06b ${backend.name}: computed ${computed(ours)} vs ${computed(legacy)} tokens (naive); served from cache ${cachedShare(ours)}% vs ${cachedShare(legacy)}%\n`);
  });
}
