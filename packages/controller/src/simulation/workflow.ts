import { DomainError } from "../domain/errors.js";
import { EffectRejected, type EffectBridge, type EffectRequest } from "../domain/effects.js";
import { onlyKnown } from "../domain/model.js";
import { ProjectService } from "../domain/service.js";
import { FallbackService, RoutingService, type Step } from "../routing/index.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { MemoryStorage } from "../storage/memory.js";
import { canonicalJson } from "../storage/json.js";
import type { JsonObject } from "../storage/types.js";
import type { ServiceAction } from "../service-ops/target.js";

/**
 * A workflow run inside a simulation scope (card P07, the run part). The owner gives a short script: agents that each read a resource of the scope's stand-in, ask a model
 * for what to do and then do one tool call on the stand-in, and events between them that a real run meets: a provider that fails (the R02 fallback picks the next route) and
 * another writer that changes a resource while an agent works on it (a competing edit). Everything here is a stand-in: the agents are names (no credential, grant or attempt of a
 * real agent is used), the model providers are scripted stand-ins that answer in-process (no network, no real model, no spend), and the tools are the scope's own stand-in of the
 * services. The fallback is the real R02 `FallbackService`, run on its own in-memory store that holds only the scope's stand-in routes: what it decides is the real rule, and
 * nothing it records reaches the task's real spend, retry budget or routing state.
 */
export const RUN_LIMITS = { steps: 30, agentSteps: 20, providers: 4, times: 4, runsPerScope: 50, grantsPerScope: 50, replaysPerScope: 200, agent: 64, scriptChars: 64 * 1024 } as const;
export const PROVIDER_FAILURES = ["outage", "rate-limit", "credit", "auth"] as const;
export type ProviderFailure = (typeof PROVIDER_FAILURES)[number];
/** The stand-in routes a run uses when the owner names none, in fallback order. */
export const DEFAULT_PROVIDERS: readonly string[] = ["sim-primary/model", "sim-backup/model"];
/** What a stand-in provider answers when a failure is injected: worded as a real provider would, so the R02 classifier sorts it as that kind (checked by a test). */
export const PROVIDER_FAILURE_ANSWER: Readonly<Record<ProviderFailure, { readonly message: string; readonly status: number }>> = {
  outage: { message: "overloaded_error (simulated provider)", status: 529 },
  "rate-limit": { message: "Rate limit reached (simulated provider)", status: 429 },
  credit: { message: "Your credit balance is too low (simulated provider)", status: 402 },
  auth: { message: "Invalid API key (simulated provider)", status: 401 },
};

export type RunStep =
  | { readonly kind: "agent"; readonly agent: string; readonly service: string; readonly resource: string; readonly action: ServiceAction }
  | { readonly kind: "provider-failure"; readonly route: string; readonly failure: ProviderFailure; readonly times: number }
  | { readonly kind: "competing-edit"; readonly service: string; readonly resource: string; readonly fields: JsonObject };

const NAME = /^[a-z][a-z0-9._-]{0,63}$/;
/** Review: the fields an agent or the other writer sets are bounded like a scope's states (`SIMULATION_SCOPE_LIMITS.stateBytes`), so a script always fits its run record. */
const FIELDS_CHARS = 8 * 1024;
const boundedFields = (v: JsonObject, field: string): void => { if (canonicalJson(v).length > FIELDS_CHARS) invalid(field, `must be at most ${FIELDS_CHARS} characters`); };
const ROUTE = /^[a-z][a-z0-9-]{0,39}\/[a-z0-9][a-z0-9._-]{0,63}$/;
const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };

function checkAction(raw: unknown, field: string): ServiceAction {
  if (!isObject(raw)) return invalid(field, "must be an object like { type, params }");
  onlyKnown(raw, ["type", "params"]);
  if (typeof raw["type"] !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(raw["type"])) invalid(`${field}.type`, "must be 1 to 40 lower-case letters, digits or hyphens");
  if (raw["params"] !== undefined && !isObject(raw["params"])) invalid(`${field}.params`, "must be an object");
  if (raw["params"] !== undefined) boundedFields(raw["params"] as JsonObject, `${field}.params`);
  return { type: raw["type"] as string, ...(raw["params"] === undefined ? {} : { params: raw["params"] as JsonObject }) };
}

/** Checks the owner's script: 1 to 30 steps, at most 20 agent steps, providers 1 to 4 distinct stand-in routes. A competing edit must be followed by an agent step (it happens while that agent works). */
export function checkScript(raw: { steps: unknown; providers?: unknown }): { steps: RunStep[]; providers: string[] } {
  const providers = raw.providers === undefined ? [...DEFAULT_PROVIDERS] : raw.providers;
  if (!Array.isArray(providers) || providers.length === 0 || providers.length > RUN_LIMITS.providers) return invalid("providers", `must list 1 to ${RUN_LIMITS.providers} stand-in routes like sim-primary/model, in fallback order`);
  for (const [i, r] of providers.entries()) if (typeof r !== "string" || !ROUTE.test(r)) invalid(`providers[${i}]`, "must be a route name like sim-primary/model");
  if (new Set(providers).size !== providers.length) invalid("providers", "names a route twice");
  if (!Array.isArray(raw.steps) || raw.steps.length === 0 || raw.steps.length > RUN_LIMITS.steps) return invalid("steps", `must be a list of 1 to ${RUN_LIMITS.steps} steps`);
  const steps: RunStep[] = [];
  for (const [i, s] of (raw.steps as unknown[]).entries()) {
    const f = `steps[${i}]`;
    if (!isObject(s)) return invalid(f, "must be an object: an agent step { agent, service, resource, action } or an event { event, ... }");
    if (s["event"] === undefined) {
      onlyKnown(s, ["agent", "service", "resource", "action", "fields"]);
      if (typeof s["agent"] !== "string" || !NAME.test(s["agent"])) invalid(`${f}.agent`, "must be an agent's name in the simulation (lower-case letters, digits, . _ -)");
      if (typeof s["service"] !== "string" || !NAME.test(s["service"])) invalid(`${f}.service`, "must be a service name of the scope");
      if (typeof s["resource"] !== "string" || !NAME.test(s["resource"])) invalid(`${f}.resource`, "must be a resource name of the scope");
      if ((s["action"] === undefined) === (s["fields"] === undefined)) invalid(f, "gives either action { type, params } or fields (a set of those fields), not both or neither");
      if (s["fields"] !== undefined && !isObject(s["fields"])) invalid(`${f}.fields`, "must be an object of fields");
      if (s["fields"] !== undefined) boundedFields(s["fields"] as JsonObject, `${f}.fields`);
      const action = s["action"] !== undefined ? checkAction(s["action"], `${f}.action`) : { type: "set", params: { fields: s["fields"] as JsonObject } };
      steps.push({ kind: "agent", agent: s["agent"] as string, service: s["service"] as string, resource: s["resource"] as string, action });
    } else if (s["event"] === "provider-failure") {
      onlyKnown(s, ["event", "route", "failure", "times"]);
      const route = s["route"] ?? providers[0];
      if (typeof route !== "string" || !providers.includes(route)) invalid(`${f}.route`, "must be one of the run's stand-in routes");
      const failure = s["failure"] ?? "outage";
      if (!(PROVIDER_FAILURES as readonly unknown[]).includes(failure)) invalid(`${f}.failure`, `must be one of ${PROVIDER_FAILURES.join(", ")} (default outage)`);
      const times = s["times"] ?? 1;
      if (typeof times !== "number" || !Number.isSafeInteger(times) || times < 1 || times > RUN_LIMITS.times) invalid(`${f}.times`, `must be 1 to ${RUN_LIMITS.times}`);
      steps.push({ kind: "provider-failure", route: route as string, failure: failure as ProviderFailure, times: times as number });
    } else if (s["event"] === "competing-edit") {
      onlyKnown(s, ["event", "service", "resource", "fields"]);
      if (typeof s["service"] !== "string" || !NAME.test(s["service"])) invalid(`${f}.service`, "must be a service name of the scope");
      if (typeof s["resource"] !== "string" || !NAME.test(s["resource"])) invalid(`${f}.resource`, "must be a resource name of the scope");
      if (!isObject(s["fields"]) || Object.keys(s["fields"]).length === 0) invalid(`${f}.fields`, "must be the fields the other writer sets");
      boundedFields(s["fields"] as JsonObject, `${f}.fields`);
      steps.push({ kind: "competing-edit", service: s["service"] as string, resource: s["resource"] as string, fields: s["fields"] as JsonObject });
    } else invalid(`${f}.event`, "must be provider-failure or competing-edit");
  }
  if (steps.filter((s) => s.kind === "agent").length === 0 || steps.filter((s) => s.kind === "agent").length > RUN_LIMITS.agentSteps) invalid("steps", `must hold 1 to ${RUN_LIMITS.agentSteps} agent steps`);
  if (canonicalJson(steps as unknown as JsonObject).length > RUN_LIMITS.scriptChars) invalid("steps", `must be at most ${RUN_LIMITS.scriptChars} characters in all, so the run's record keeps the script and every step's result`);
  for (const [i, s] of steps.entries()) {
    if (s.kind !== "competing-edit") continue;
    const next = steps.slice(i + 1).find((n) => n.kind !== "provider-failure");
    if (next?.kind !== "agent") invalid(`steps[${i}]`, "a competing edit happens while the next agent works, so an agent step must follow it");
  }
  return { steps, providers: providers as string[] };
}

/**
 * The stand-in model provider as an effect bridge (simulated: the ledger lets it run only effects of a scope). An attempt asked with an injected failure is refused with the
 * provider's words (nothing answered, nothing spent); any other attempt answers a fixed scripted reply with zero usage. It reaches nothing outside the process.
 */
export function providerBridge(): EffectBridge {
  const answer = (req: EffectRequest): JsonObject => ({ route: String(req.input["route"]), agent: String(req.input["agent"]), reply: "scripted stand-in answer: do the step's tool call", usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 }, provider: "stand-in" });
  return {
    idempotent: true,
    simulated: true,
    async execute(req) {
      const failure = req.input["failure"];
      if (typeof failure === "string" && Object.hasOwn(PROVIDER_FAILURE_ANSWER, failure)) {
        const said = PROVIDER_FAILURE_ANSWER[failure as ProviderFailure];
        throw new EffectRejected(said.message, { route: String(req.input["route"]), failure, status: said.status, injected: true });
      }
      return answer(req);
    },
    async reconcile(req) { return typeof req.input["failure"] === "string" ? { state: "not_applied" } : { state: "applied", evidence: answer(req) }; },
  };
}

/**
 * The real R02 fallback over its own in-memory store holding only the run's stand-in routes (all local, unpaid). One call per agent step, decided by `FallbackService` exactly as
 * for real work; it shares nothing with the controller's store, so a simulated failure is never counted against the task. The clock is fixed, so the same script decides the same way
 * on every run (a rerun after a crash makes the same choices).
 */
export class ScratchRouter {
  private constructor(private readonly fb: FallbackService, private readonly owner: Principal, private readonly taskId: string) {}

  static async open(providers: readonly string[], at: string): Promise<ScratchRouter> {
    const clock = () => at;
    const storage = new MemoryStorage();
    const projects = await ProjectService.open(storage, { holder: "simulation", clock, pause: async () => undefined });
    const principals = PrincipalService.withEpoch(storage, projects.epoch, { clock });
    const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "simulation" })).token);
    const routing = RoutingService.withEpoch(storage, projects.epoch, { clock });
    const table = {
      providers: Object.fromEntries(providers.map((r) => [r.slice(0, r.indexOf("/")), { enabled: true, paid: false, location: "local" }])),
      routes: Object.fromEntries(providers.map((r) => [r, { contextTokens: 100_000, capabilities: [] }])),
      profiles: { simulated: [...providers] },
      roles: { agent: "simulated" },
    };
    await routing.setTable(owner, { commandId: "simulated-table", expectedRevision: 0, table });
    const fb = FallbackService.withEpoch(storage, projects.epoch, routing, { clock });
    const project = (await projects.createProject({ commandId: "simulated-project", actor: owner.id, name: "simulation" })).id;
    const taskId = (await projects.createTask({ commandId: "simulated-task", actor: owner.id, projectId: project, title: "simulation" })).id;
    return new ScratchRouter(fb, owner, taskId);
  }

  begin(key: string): Promise<Step> { return this.fb.begin(this.owner, { commandId: `${key}:begin`, taskId: this.taskId, request: { role: "agent", contextTokens: 1000, needs: [], data: "local-only", paidAuthorized: false } }); }
  failed(key: string, callId: string, attempt: number, failure: ProviderFailure): Promise<Step> {
    return this.fb.failed(this.owner, { commandId: `${key}:failed:${attempt}`, callId, attempt, failure: { ...PROVIDER_FAILURE_ANSWER[failure] } });
  }
  async succeeded(key: string, callId: string, attempt: number): Promise<void> { await this.fb.succeeded(this.owner, { commandId: `${key}:ok:${attempt}`, callId, attempt, usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 } }); }
}

/** Whether a `set` of an agent overlaps the fields another writer changed (then retrying would write over that change; the owner decides instead). A restart never does. */
export function overlaps(action: ServiceAction, fields: JsonObject): boolean {
  if (action.type !== "set") return false;
  const mine = action.params?.["fields"];
  return isObject(mine) && Object.keys(mine).some((k) => Object.hasOwn(fields, k));
}
