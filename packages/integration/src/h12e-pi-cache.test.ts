import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createModels, createProvider, type MutableModels } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { streamSimple, stream } from "@earendil-works/pi-ai/api/openai-completions";
import { requestId } from "@nimblenewt/contracts";
import { CacheEndpoints, CachePolicies, type Principal } from "@nimblenewt/controller";
import { LlamaSim, simulatedFetch } from "@nimblenewt/controller/testing";
import { PiAdapter, type CacheShaping } from "@nimblenewt/pi-adapter";

// Card H12e: Pi's own HTTP calls (the request pi-ai's openai-completions provider builds and sends with its SDK) go through the C06 CacheAdapter and the per-endpoint state. The server is the simulated llama-server of C06;
// the real Pi adapter, the real pi-ai provider and the dispatcher's CachePolicies are used, only the network is replaced.

const SECRET = "installation-secret-0123456789";
const A = "proj-aaaaaaaaaaaaaaaaaaaa", B = "proj-bbbbbbbbbbbbbbbbbbbb";
const principal = { id: "service:dispatcher", kind: "service", name: "dispatcher", grants: [] } as Principal;
const URL = "http://llama.test:8080";
const LAYOUT = { preamble: `You work inside NimbleNewt. ${"Be exact and cite sources. ".repeat(40)}`, project: `Project notes. ${"Money is integer cents. ".repeat(40)}`, agent: "You review pull requests." };
const adapters: PiAdapter[] = [];
afterEach(async () => { for (const a of adapters.splice(0)) await a.close(); });

function models(): MutableModels {
  const m = createModels();
  m.setProvider(createProvider({
    id: "llama", baseUrl: `${URL}/v1`,
    auth: { apiKey: { name: "none", resolve: async () => ({ auth: { apiKey: "local" } }) } },
    models: [{ id: "local", name: "local", api: "openai-completions", provider: "llama", baseUrl: `${URL}/v1`, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }],
    api: { stream, streamSimple } as never,
  }));
  return m;
}

const endpoints = (slots: number) => ({ "llama/local": { url: URL, config: { kind: "llama-cpp" as const, model: "local", route: "llama/local", options: { slots } } } });

async function agent(policies: CachePolicies, projectId: string, server: LlamaSim) {
  const attempt = await policies.forAttempt({ projectId, route: "llama/local" }, { splitSystem: true });
  const cache: CacheShaping = { policy: () => attempt.policy };
  // pi-ai gets its SDK's fetch from the policy's wrapper, whose inner fetch is the simulated server.
  const m = models();
  globalThis.fetch = simulatedFetch(server);
  const adapter = await PiAdapter.open({ storage: new MemoryStorage(), models: m, model: { provider: "llama", modelId: "local" }, promptLayout: LAYOUT, cache });
  adapters.push(adapter);
  const say = async (id: string, text: string): Promise<string> => {
    const result = await (await adapter.root().submit({ kind: "input", requestId: requestId(id), content: text })).result();
    return JSON.stringify(result);
  };
  return { attempt, say };
}

/** The network stack a worker's process has: the global `fetch`, here the simulated server. Pi's wrapper (the policy's `fetch`) is handed this as the inner fetch at each call. */
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test("slotted llama.cpp through Pi's own calls: real reuse inside a project, none across projects, hit figures for accounting, and no degraded mode", async () => {
  const policies = new CachePolicies({ secret: SECRET, state: new CacheEndpoints(), principal, endpoints: endpoints(2) });
  const server = new LlamaSim(2);
  const a1 = await agent(policies, A, server);
  const a2 = await agent(policies, A, server);
  const b1 = await agent(policies, B, server);
  assert.equal(a1.attempt.policy.degraded, undefined);
  assert.equal(a1.attempt.routed, true);
  await a1.say("a1-1", "please review the change");
  await a1.say("a1-2", "and the tests");
  const own = (await a1.attempt.takeUsage())!;
  assert.ok(own.cachedTokens > 0, `the same conversation reads its own history from the slot (cached ${own.cachedTokens})`);
  // A second agent of the same project shares the slot and the head of the prompt.
  await a2.say("a2-1", "a different task");
  const shared = (await a2.attempt.takeUsage())!;
  assert.ok(shared.cachedTokens > 0, `the project's other agent reuses the shared head (cached ${shared.cachedTokens})`);
  // Another project with the same text gets its own slot and reads nothing.
  await b1.say("b1-1", "please review the change");
  const other = (await b1.attempt.takeUsage())!;
  assert.equal(other.cachedTokens, 0, "no reuse across projects");
  assert.notEqual(a1.attempt.slot, b1.attempt.slot);
  assert.equal(other.backend, "llama-cpp");
});

test("one slot for two projects: the second runs without a slot and without reuse, and the first never reads what the second left in the slot", async () => {
  const policies = new CachePolicies({ secret: SECRET, state: new CacheEndpoints(), principal, endpoints: endpoints(1) });
  const server = new LlamaSim(1);
  const a = await agent(policies, A, server);
  const b = await agent(policies, B, server);
  assert.equal(b.attempt.slot, undefined);
  await a.say("a-1", "first");
  await b.say("b-1", "first");
  await a.say("a-2", "second");
  assert.equal((await b.attempt.takeUsage())!.cachedTokens, 0);
  const usage = (await a.attempt.takeUsage())!;
  const requests = server.seen.filter((r) => r.path === "/v1/chat/completions");
  assert.deepEqual(requests.map((r) => [r.body["id_slot"], r.body["cache_prompt"]]), [[0, true], [undefined, false], [0, true]]);
  assert.equal(usage.cachedTokens, 0, "the slot was cleared before the first project used it again");
});

test("without the endpoint's state the call keeps the no-reuse mode and says why; the figures are still observed", async () => {
  const policies = new CachePolicies({ secret: SECRET, principal, endpoints: endpoints(2) });
  const server = new LlamaSim(2);
  const a = await agent(policies, A, server);
  assert.match(a.attempt.policy.degraded ?? "", /not available/);
  await a.say("a-1", "first");
  await a.say("a-2", "second");
  assert.deepEqual(server.seen.filter((r) => r.path === "/v1/chat/completions").map((r) => [r.body["id_slot"], r.body["cache_prompt"]]), [[undefined, false], [undefined, false]]);
  assert.equal((await a.attempt.takeUsage())!.cachedTokens, 0);
});
