import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type, fauxAssistantMessage, fauxProvider, createModels } from "@earendil-works/pi-ai";
import { Harness, MemoryStorage, createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { requestId } from "@nimblenewt/contracts";
import { deriveKey, piCachePolicy, type CacheContext, type CacheHit, type CacheProfile, type HttpResponse, type Transport, type WireRequest } from "@nimblenewt/controller";
import { PiAdapter, shapeModels, volatileContext, type AdapterTool } from "@nimblenewt/pi-adapter";

// Card C06b's measured conversation, shared by its simulator test (c06b-cache-stability.test.ts) and G10's run against a real server (g10-radiance-bench.ts): two agents of one project take turns (a context switch on every
// request). The same conversation is run once with the NimbleNewt layout and cache policy and once with the layout a caller gets from Pi Durable 1.3.0 by assembling sections and tools naively (role first, a clock in the system
// prompt, tools in each agent's own order, Pi's per-conversation session ID as the cache key). Each request is the exact body pi-ai builds for the provider; the hit is read with that backend's own profile (C06).

const SECRET = "installation-secret-0123";
/** The texts of the conversation. `scale` repeats the preamble and the project context more often (G10 uses a larger head than the simulators need, to pass a real server's reuse granularity). */
export function texts(scale = 1): { readonly PREAMBLE: string; readonly PROJECT: string; readonly ROLES: Readonly<Record<Agent, string>> } {
  return {
    PREAMBLE: `You work inside NimbleNewt on behalf of the owner. ${"Be exact, show your sources, and say when you do not know. ".repeat(30 * scale)}`,
    PROJECT: `Project Aster is a ledger service written in TypeScript. ${"Money is stored as integer cents and never as floating point. ".repeat(30 * scale)}`,
    ROLES: { reviewer: `You review pull requests. ${"Read the diff before commenting. ".repeat(8)}`, tester: `You write tests. ${"Prefer small deterministic cases. ".repeat(8)}` },
  };
}
// The same four tools for both agents (what an agent may do with them is policy, not declaration), each agent declaring them in its own order.
const TOOL_ORDER = { reviewer: ["read_file", "search", "comment", "run_tests"], tester: ["search", "run_tests", "read_file", "comment"] } as const;
export type Agent = "reviewer" | "tester";

const tool = (name: string, nonce?: string): AdapterTool => ({ name, description: `${nonce === undefined ? "" : `${nonce} `}The ${name} tool. ${"It does exactly what its name says. ".repeat(6)}`, parameters: Type.Object({ target: Type.Optional(Type.String()) }), execute: async () => "ok" });

export interface Run { readonly hits: CacheHit[]; readonly order: Agent[]; readonly responses: HttpResponse[] }
export interface Backend {
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
export interface RunOptions {
  /** The model ID put in an OpenAI-style body (a real server needs its own; the simulators accept anything). */
  readonly modelId?: string;
  readonly scale?: number;
  /** The salt of the project's derived keys: a real server keeps what an earlier run left, so G10 uses a fresh one per run. */
  readonly project?: string;
  /** Put in front of every text (tool descriptions, preamble, project context, roles): G10 makes each run start cold on a real server whose cache holds earlier runs, whatever the template renders first. */
  readonly nonce?: string;
}

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

/** Runs the six requests (three rounds, both agents) and closes what it opened. */
export async function run(backend: Backend, layout: "nimblenewt" | "legacy", options: RunOptions = {}): Promise<Run> {
  const base = texts(options.scale);
  const mark = (t: string): string => (options.nonce === undefined ? t : `${options.nonce} ${t}`);
  const PREAMBLE = mark(base.PREAMBLE), PROJECT = mark(base.PROJECT);
  const ROLES: Record<Agent, string> = { reviewer: mark(base.ROLES.reviewer), tester: mark(base.ROLES.tester) };
  const projectName = options.project ?? "proj-aster";
  const profile = backend.profile();
  const server = backend.server();
  const scope = deriveKey(SECRET, "scope", projectName);
  const hits: CacheHit[] = [];
  const order: Agent[] = [];
  const responses: HttpResponse[] = [];
  const modelId = backend.wire === "anthropic-messages" ? "claude-opus-5-5" : (options.modelId ?? "m");
  const provider = backend.wire === "anthropic-messages" ? "anthropic" : "local";
  const agents = new Map<Agent, { submit(text: string, n: number): Promise<void>; bodies: { context: unknown; options: unknown; model: unknown }[] }>();
  const adapters: PiAdapter[] = [];
  const harnesses: Harness[] = [];
  try {
    for (const agent of ["reviewer", "tester"] as const) {
      const world = scripted(backend.wire, provider, modelId);
      // NimbleNewt: one key for the whole project; legacy: Pi's own per-conversation key (modelled as one key per agent).
      const ctx: CacheContext = { scopeKey: scope, shareKey: layout === "nimblenewt" ? deriveKey(SECRET, "share", projectName) : deriveKey(SECRET, "share", "session", agent), retention: "long", ...(backend.slot === undefined ? {} : { slot: backend.slot(agent) }) };
      const policy = piCachePolicy(profile, ctx, { splitSystem: layout === "nimblenewt" });
      if (layout === "nimblenewt") {
        const adapter = await PiAdapter.open({
          storage: new MemoryStorage(), models: world.models, model: world.ref,
          tools: TOOL_ORDER[agent].map((name) => tool(name, options.nonce)), promptLayout: { completionRules: true, preamble: PREAMBLE, project: PROJECT, agent: ROLES[agent] }, cache: { policy: () => policy },
        });
        adapters.push(adapter);
        agents.set(agent, { bodies: world.bodies, submit: async (text, n) => { world.reply(`answer ${n}`); await (await adapter.root().submit({ kind: "input", requestId: requestId(`${agent}-${n}`), content: `${volatileContext(`status: step ${n}`)}\n${text}` })).result(); } });
      } else {
        const registry = createRegistry();
        let tick = 0;
        registry.install(defineExtension({
          name: "legacy",
          tools: TOOL_ORDER[agent].map((name) => defineTool({ name, description: tool(name, options.nonce).description, parameters: tool(name).parameters, execute: async () => ({ output: [{ type: "text" as const, text: "ok" }] }) })),
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
        hits.push(hit); order.push(agent); responses.push(response);
      }
    }
  } finally {
    for (const a of adapters) await a.close();
    for (const h of harnesses) await h.close(context);
  }
  return { hits, order, responses };
}

export const computed = (r: Run): number => r.hits.reduce((n, h) => n + h.computedTokens, 0);
export const cachedShare = (r: Run): number => Math.round((100 * r.hits.reduce((n, h) => n + h.cachedTokens, 0)) / r.hits.reduce((n, h) => n + h.promptTokens, 0));
