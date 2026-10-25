import assert from "node:assert/strict";
import { test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { CacheEndpoints } from "../inference-cache/index.js";
import type { Principal } from "../security/principals.js";
import { CachePolicies } from "./cache.js";

const principal = { id: "service:dispatcher", kind: "service", name: "dispatcher", grants: [] } as Principal;
const SECRET = "installation-secret-0123456789";
const A = "proj-aaaaaaaaaaaaaaaaaaaa", B = "proj-bbbbbbbbbbbbbbbbbbbb", C = "proj-cccccccccccccccccccc";
const body = { model: "m", messages: [{ role: "user", content: "hi" }] };
const longer = { model: "m", messages: [{ role: "system", content: "doc" }, { role: "user", content: "q1" }, { role: "assistant", content: "a1" }, { role: "user", content: "q2" }] };

const make = (extra: Partial<ConstructorParameters<typeof CachePolicies>[0]> = {}) => new CachePolicies({
  secret: SECRET, state: new CacheEndpoints(), principal,
  endpoints: {
    "llama/local": { url: "http://127.0.0.1:8080", config: { kind: "llama-cpp", model: "local", route: "llama/local", options: { slots: 2 } } },
    "vllm/big": { url: "http://127.0.0.1:8000", config: { kind: "vllm", model: "big", route: "vllm/big" } },
    "strata/one": { url: "http://127.0.0.1:9000", config: { kind: "strata", model: "one", route: "strata/one", options: { pinPrefix: true } } },
    "openai/gpt": { url: "https://api.openai.example", config: { kind: "openai", model: "gpt", route: "openai/gpt" } },
  },
  ...extra,
});

test("the policy is chosen from the route's configured endpoint; keys are derived under the installation secret and never carry a project or task ID", async () => {
  const policies = make();
  const a = await policies.forAttempt({ projectId: A, route: "vllm/big" });
  const b = await policies.forAttempt({ projectId: B, route: "vllm/big" });
  assert.match(a.policy.key!, /^nn-/);
  assert.notEqual(a.policy.key, b.policy.key, "projects never share a cache key");
  const sent = JSON.stringify(a.policy.payload(structuredClone(body)));
  assert.ok(!sent.includes(A) && !sent.includes("proj-"), "the provider sees only derived text");
  assert.notEqual(JSON.stringify(a.policy.payload(structuredClone(body))), JSON.stringify(b.policy.payload(structuredClone(body))), "vLLM salts differ per project");
  // A route with no endpoint configured is a generic backend: nothing is sent.
  const generic = await policies.forAttempt({ projectId: A, route: "other/model" });
  assert.equal(generic.policy.key, undefined);
  assert.deepEqual(generic.policy.payload(structuredClone(body)), body);
  assert.throws(() => make({ secret: "short" }), (e: unknown) => e instanceof DomainError && e.code === "invalid_command");
});

test("slots on a shared server are partitioned by project: a project never takes another project's slot, and Pi's calls go through the adapter's state (no degraded mode)", async () => {
  const policies = make();
  const first = await policies.forAttempt({ projectId: A, route: "llama/local" });
  const second = await policies.forAttempt({ projectId: B, route: "llama/local" });
  const third = await policies.forAttempt({ projectId: C, route: "llama/local" });
  assert.deepEqual([first.slot, second.slot], [0, 1]);
  assert.equal(third.slot, undefined);
  assert.match(third.refused ?? "", /another project/);
  assert.equal((await policies.forAttempt({ projectId: A, route: "llama/local" })).slot, 0, "a project keeps the slot it had");
  assert.equal(first.routed, true);
  assert.equal(first.policy.degraded, undefined);
  assert.equal(typeof first.policy.fetch, "function");
  assert.deepEqual(first.policy.payload(structuredClone(body)), body, "the body is left to the adapter, which prepares it");
});

test("without the adapter's state (none given, or the registry cannot track another endpoint) a slotted server runs with reuse off and the policy says so", async () => {
  const none = await make({ state: undefined as never }).forAttempt({ projectId: A, route: "llama/local" });
  assert.equal(none.routed, false);
  assert.match(none.policy.degraded ?? "", /state is not available/);
  assert.equal((none.policy.payload(structuredClone(body)) as Record<string, unknown>)["cache_prompt"], false);
  assert.equal(none.slot, undefined);
  const full = new CacheEndpoints();
  for (let i = 0; i < CacheEndpoints.MAX; i++) full.state(`http://filler-${i}.example`);
  const crowded = await make({ state: full }).forAttempt({ projectId: A, route: "llama/local" });
  assert.equal(crowded.routed, false);
  assert.match(crowded.policy.degraded ?? "", /state is not available/);
  assert.equal((crowded.policy.payload(structuredClone(body)) as Record<string, unknown>)["cache_prompt"], false);
});

test("a pin is sent only when the project holds an active pin marker for the route", async () => {
  const resolved: string[] = [];
  const markers = { resolve: async (_by: Principal, q: { markerId: string; projectId: string; route: string }) => { resolved.push(`${q.projectId}/${q.markerId}/${q.route}`); return q.markerId === "cmk-live" ? { state: "active" as const, marker: {} as never, expectedCachedTokens: 10 } : { state: "unavailable" as const, reason: "missing" as const }; } };
  const policies = make({ markers });
  const pinned = (await policies.forAttempt({ projectId: A, route: "strata/one" }, { pinMarker: "cmk-live", pinMessages: 2 })).policy.payload(structuredClone(longer)) as Record<string, unknown>;
  const unpinned = (await policies.forAttempt({ projectId: A, route: "strata/one" }, { pinMarker: "cmk-gone", pinMessages: 2 })).policy.payload(structuredClone(longer)) as Record<string, unknown>;
  const none = (await policies.forAttempt({ projectId: A, route: "strata/one" }, { pinMessages: 2 })).policy.payload(structuredClone(longer)) as Record<string, unknown>;
  assert.deepEqual(pinned["strata_prefix"], { messages: 2 });
  assert.equal(unpinned["strata_prefix"], undefined);
  assert.equal(none["strata_prefix"], undefined);
  assert.deepEqual(resolved, [`${A}/cmk-live/strata/one`, `${A}/cmk-gone/strata/one`]);
});

test("a project that requires isolation gets no cache key on a backend that cannot keep projects apart, and keeps its salt where it can", async () => {
  const policies = make({ isolationRequired: (p) => p === A });
  const isolated = await policies.forAttempt({ projectId: A, route: "openai/gpt" });
  const shared = await policies.forAttempt({ projectId: B, route: "openai/gpt" });
  assert.equal(isolated.policy.key, undefined);
  assert.equal(isolated.policy.retention, "none");
  assert.match(isolated.policy.degraded ?? "", /isolation/);
  assert.notEqual(shared.policy.key, undefined);
  assert.notEqual((await policies.forAttempt({ projectId: A, route: "vllm/big" })).policy.key, undefined, "vLLM's salt isolates, so its cache stays on");
});

test("one server is one endpoint state whatever path its URL carries, so its slot holders and turns are shared", () => {
  const endpoints = new CacheEndpoints();
  assert.equal(endpoints.state("http://127.0.0.1:8080"), endpoints.state("http://127.0.0.1:8080/v1"));
  assert.equal(endpoints.state("http://HOST:8080/"), endpoints.state("http://host:8080/v1/"));
  assert.notEqual(endpoints.state("http://host:8080"), endpoints.state("http://host:8081"));
});
