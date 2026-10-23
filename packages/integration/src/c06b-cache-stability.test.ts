import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type, fauxAssistantMessage, fauxProvider, createModels } from "@earendil-works/pi-ai";
import { Harness, MemoryStorage, createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { requestId } from "@nimblenewt/contracts";
import { deriveKey, piCachePolicy, profileFor, type CacheContext, type CacheHit, type CacheProfile, type Transport, type WireRequest } from "@nimblenewt/controller";
import { ClaudeSim, LlamaSim, VllmSim } from "@nimblenewt/controller/testing";
import { PiAdapter, shapeModels, volatileContext, type AdapterTool } from "@nimblenewt/pi-adapter";

// Card C06b, measured: two agents of one project take turns (a context switch on every request). The same conversation is run twice per backend, once with the NimbleNewt layout and cache policy and once with the layout a caller
// gets from Pi Durable 1.3.0 by assembling sections and tools naively (role first, a clock in the system prompt, tools in each agent's own order, Pi's per-conversation session ID as the cache key). Each request is the exact body pi-ai builds
// for the provider, sent to a simulated server of that backend, and the hit is read with that backend's own profile (C06) from the fields that backend reports. The simulators model only position-based prefix reuse; the figures are not
// measurements of real servers (G10 does that), but they show which layout leaves reusable bytes in front.

const SECRET = "installation-secret-0123";
const PREAMBLE = `You work inside NimbleNewt on behalf of the owner. ${"Be exact, show your sources, and say when you do not know. ".repeat(30)}`;
const PROJECT = `Project Aster is a ledger service written in TypeScript. ${"Money is stored as integer cents and never as floating point. ".repeat(30)}`;
const ROLES = { reviewer: `You review pull requests. ${"Read the diff before commenting. ".repeat(8)}`, tester: `You write tests. ${"Prefer small deterministic cases. ".repeat(8)}` } as const;
// The same four tools for both agents (what an agent may do with them is policy, not declaration), each agent declaring them in its own order.
const TOOL_ORDER = { reviewer: ["read_file", "search", "comment", "run_tests"], tester: ["search", "run_tests", "read_file", "comment"] } as const;
type Agent = keyof typeof ROLES;

const tool = (name: string): AdapterTool => ({ name, description: `The ${name} tool. ${"It does exactly what its name says. ".repeat(6)}`, parameters: Type.Object({ target: Type.Optional(Type.String()) }), execute: async () => "ok" });

interface Run { readonly hits: CacheHit[]; readonly order: Agent[] }
interface Backend {
  readonly name: string;
  readonly profile: () => CacheProfile;
  readonly wire: "anthropic-messages" | "openai-completions";
  readonly server: () => Transport;
  /** Shared across agents on this backend, so the second agent's first request can reuse the first agent's head. */
  readonly sharesAcrossAgents: boolean;
  /** Characters per token the simulator counts in. */
  readonly charsPerToken: number;
  readonly slot?: (agent: Agent) => number;
}
const BACKENDS: Backend[] = [
  { name: "llama.cpp", profile: () => profileFor({ kind: "llama-cpp", model: "m", options: { slots: 2 } }), wire: "openai-completions", server: () => new LlamaSim(2), sharesAcrossAgents: false, charsPerToken: 4, slot: (a) => (a === "reviewer" ? 0 : 1) },
  { name: "vLLM", profile: () => profileFor({ kind: "vllm", model: "m", options: { promptDetails: true } }), wire: "openai-completions", server: () => new VllmSim(), sharesAcrossAgents: true, charsPerToken: 4 },
  { name: "Radiance", profile: () => profileFor({ kind: "radiance", model: "m" }), wire: "openai-completions", server: () => new VllmSim({ shape: "timings" }), sharesAcrossAgents: true, charsPerToken: 4 },
  { name: "Strata", profile: () => profileFor({ kind: "strata", model: "m" }), wire: "openai-completions", server: () => new VllmSim({ shape: "timings" }), sharesAcrossAgents: true, charsPerToken: 4 },
  { name: "OpenAI", profile: () => profileFor({ kind: "openai", model: "gpt-x", options: { promptCacheKey: true } }), wire: "openai-completions", server: () => new VllmSim(), sharesAcrossAgents: true, charsPerToken: 4 },
  { name: "Claude", profile: () => profileFor({ kind: "claude", model: "claude-opus-5-5" }), wire: "anthropic-messages", server: () => new ClaudeSim({ minTokens: 100 }), sharesAcrossAgents: true, charsPerToken: 3 },
];

const adapters: PiAdapter[] = [];
const harnesses: Harness[] = [];
afterEach(async () => { for (const a of adapters.splice(0)) await a.close(); for (const h of harnesses.splice(0)) await h.close(context); });

function scripted(api: Backend["wire"], provider: string, modelId: string) {
  const models = createModels();
  const faux = fauxProvider({ api, provider, models: [{ id: modelId }] });
  models.setProvider(faux.provider);
  const bodies: { context: unknown; options: unknown; model: unknown }[] = [];
  return { models, ref: { provider, modelId }, bodies, reply: (text: string) => faux.setResponses([(c, o, _s, m) => { bodies.push({ context: c, options: o, model: m }); return fauxAssistantMessage(text); }]) };
}

/** What pi-ai builds for the provider from a request the scripted provider received (the same function the Pi adapter's own tests use). */
async function bodyOf(seen: { context: unknown; options: unknown; model: unknown }, api: Backend["wire"]): Promise<WireRequest> {
  const { streamSimple } = api === "anthropic-messages" ? await import("@earendil-works/pi-ai/api/anthropic-messages") : await import("@earendil-works/pi-ai/api/openai-completions");
  const options = { ...(seen.options as object), signal: undefined, apiKey: "k" } as { onPayload?: (p: unknown, m: unknown) => unknown };
  const shaped = options.onPayload;
  let captured: WireRequest | undefined;
  options.onPayload = async (payload, model) => { captured = JSON.parse(JSON.stringify((await shaped?.(payload, model)) ?? payload)) as WireRequest; throw new Error("captured"); };
  for await (const event of (streamSimple as unknown as (m: unknown, c: unknown, o: unknown) => AsyncIterable<unknown>)(seen.model, seen.context, options)) void event;
  if (captured === undefined) throw new Error("no request was built");
  return captured;
}

async function run(backend: Backend, layout: "nimblenewt" | "legacy"): Promise<Run> {
  const profile = backend.profile();
  const server = backend.server();
  const scope = deriveKey(SECRET, "scope", "proj-aster");
  const hits: CacheHit[] = [];
  const order: Agent[] = [];
  const modelId = backend.wire === "anthropic-messages" ? "claude-opus-5-5" : "m";
  const provider = backend.wire === "anthropic-messages" ? "anthropic" : "local";
  const agents = new Map<Agent, { submit(text: string, n: number): Promise<void>; bodies: { context: unknown; options: unknown; model: unknown }[] }>();
  for (const agent of ["reviewer", "tester"] as const) {
    const world = scripted(backend.wire, provider, modelId);
    // NimbleNewt: one key for the whole project; legacy: Pi's own per-conversation key (modelled as one key per agent).
    const ctx: CacheContext = { scopeKey: scope, shareKey: layout === "nimblenewt" ? deriveKey(SECRET, "share", "proj-aster") : deriveKey(SECRET, "share", "session", agent), retention: "long", ...(backend.slot === undefined ? {} : { slot: backend.slot(agent) }) };
    const policy = piCachePolicy(profile, ctx, { splitSystem: layout === "nimblenewt" });
    if (layout === "nimblenewt") {
      const adapter = await PiAdapter.open({
        storage: new MemoryStorage(), models: world.models, model: world.ref,
        tools: TOOL_ORDER[agent].map(tool), promptLayout: { preamble: PREAMBLE, project: PROJECT, agent: ROLES[agent] }, cache: { policy: () => policy },
      });
      adapters.push(adapter);
      agents.set(agent, { bodies: world.bodies, submit: async (text, n) => { world.reply(`answer ${n}`); await (await adapter.root().submit({ kind: "input", requestId: requestId(`${agent}-${n}`), content: `${volatileContext(`status: step ${n}`)}\n${text}` })).result(); } });
    } else {
      const registry = createRegistry();
      let tick = 0;
      registry.install(defineExtension({
        name: "legacy",
        tools: TOOL_ORDER[agent].map((name) => defineTool({ name, description: tool(name).description, parameters: tool(name).parameters, execute: async () => ({ output: [{ type: "text" as const, text: "ok" }] }) })),
        sections: [{ key: "role", render: () => ROLES[agent] }, { key: "preamble", render: () => PREAMBLE }, { key: "project", render: () => PROJECT }, { key: "status", render: () => `step ${tick}` }],
      }));
      const harness = await Harness.open(new MemoryStorage(), { models: shapeModels(world.models, { policy: () => policy }), registry }, context);
      harnesses.push(harness);
      const root = await harness.root(context, { agent: { model: world.ref } });
      agents.set(agent, { bodies: world.bodies, submit: async (text, n) => { tick = n; world.reply(`answer ${n}`); const s = await root.submit({ type: "input", content: text, requestId: `${agent}-${n}` }, context); await s.wait(context); } });
    }
  }
  for (let round = 1; round <= 3; round++) {
    for (const agent of ["reviewer", "tester"] as const) {
      const a = agents.get(agent)!;
      await a.submit(`please continue with the work, round ${round}`, round);
      const body = await bodyOf(a.bodies.at(-1)!, backend.wire);
      const response = await server.send({ method: "POST", path: "/v1/chat/completions", headers: {}, body });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      const hit = profile.read(response.body);
      assert.equal(hit.known, true, `${backend.name}: the response carries the backend's own hit fields (${hit.source})`);
      hits.push(hit); order.push(agent);
    }
  }
  return { hits, order };
}

const computed = (r: Run): number => r.hits.reduce((n, h) => n + h.computedTokens, 0);

for (const backend of BACKENDS) {
  test(`${backend.name}: after every context switch the agent's own history and, where the backend shares, the project's head are reused; the naive layout reuses less`, async () => {
    const ours = await run(backend, "nimblenewt");
    if (backend.slot !== undefined) {
      // A slotted server needs C06's slot partitioning around the HTTP call, which Pi makes itself: through Pi's own calls it runs with reuse off (see piCachePolicy) until the dispatcher exists.
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
    const headChars = PREAMBLE.length + PROJECT.length;
    if (backend.sharesAcrossAgents) assert.ok(ours.hits[1]!.cachedTokens >= (headChars / backend.charsPerToken) * 0.8, `${backend.name}: the tester's first request cached ${ours.hits[1]!.cachedTokens} tokens, expected the shared head of about ${Math.round(headChars / backend.charsPerToken)}`);
    else assert.ok(ours.hits[1]!.cachedTokens <= 16, `${backend.name}: a backend that keeps a slot per agent shares nothing across agents`);
    assert.ok(computed(ours) < computed(legacy), `${backend.name}: computed ${computed(ours)} tokens with the NimbleNewt layout against ${computed(legacy)} with the naive one`);
    // Record the figures for G10: tokens computed over the six requests, and the share served from cache.
    const cachedShare = (r: Run): number => Math.round((100 * r.hits.reduce((n, h) => n + h.cachedTokens, 0)) / r.hits.reduce((n, h) => n + h.promptTokens, 0));
    process.stdout.write(`# C06b ${backend.name}: computed ${computed(ours)} vs ${computed(legacy)} tokens (naive); served from cache ${cachedShare(ours)}% vs ${cachedShare(legacy)}%\n`);
  });
}
