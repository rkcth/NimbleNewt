import { DomainError } from "../domain/errors.js";

/** Where a provider's models run. Data sent to a `cloud` provider leaves the installation. */
export type Location = "local" | "cloud";

export interface ProviderEntry {
  readonly enabled: boolean;
  /** Using it costs money. A paid route is chosen only when the request says spending is authorized. */
  readonly paid: boolean;
  readonly location: Location;
}

/** One `provider/model` the installation can send work to, and what that model can do. */
export interface RouteEntry {
  /** The most context (tokens) a request to this route can carry. */
  readonly contextTokens: number;
  /** What it supports, such as `tools`, `vision`, `reasoning`. A request needing something it lacks skips it. */
  readonly capabilities: readonly string[];
  /** How fast the route reads a prompt and writes a reply, in tokens a second, when the owner knows (card V01c). Stall detection uses the reading speed until it has measured the route. */
  readonly readTokensPerSecond?: number;
  readonly writeTokensPerSecond?: number;
  /**
   * The most tokens one reply of this route may hold (card W07): the relay puts it in every model call it sends for the route, in the field the endpoint's kind uses. Absent: the call keeps what the agent's runtime asked for (today's behaviour).
   * A reply cut off at this limit is continued in the same turn (W04) with a nudge to stop deliberating and act.
   */
  readonly maxTokens?: number;
  /** The most tokens one reply of this route may spend reasoning (card W07): a cap, so a call that does not reason is not made to, and one that asks for more is given this much. Absent: no cap is sent. Less than `maxTokens` when both are set. */
  readonly reasoningTokens?: number;
}

/** A route's length and reasoning budget (card W07), as the relay applies it to one call. */
export type RouteBudget = Pick<RouteEntry, "maxTokens" | "reasoningTokens">;

export interface Exclusion {
  readonly target: { readonly kind: "provider" | "route"; readonly name: string };
  readonly reason: string;
  readonly excludedBy: string;
  readonly at: string;
}

/** The whole routing policy (one durable record, so one revision says exactly what was in force). */
export interface RoutingTable {
  readonly providers: Readonly<Record<string, ProviderEntry>>;
  readonly routes: Readonly<Record<string, RouteEntry>>;
  /** A profile (such as a difficulty level) is an ordered list of routes, first choice first. */
  readonly profiles: Readonly<Record<string, readonly string[]>>;
  /** Which profile a role uses, so roles are routed differently without each task naming a profile. */
  readonly roles: Readonly<Record<string, string>>;
  readonly exclusions: readonly Exclusion[];
}

export interface RouteRequest {
  readonly role: string;
  /** Overrides the role's profile. */
  readonly profile?: string;
  /** The context the call needs to carry, in tokens. */
  readonly contextTokens: number;
  /** Capabilities the call needs. */
  readonly needs: readonly string[];
  /** The task's data-sharing authorization: `cloud-allowed` only when the owner's existing authorization lets this task's data leave the installation. */
  readonly data: "local-only" | "cloud-allowed";
  /** Spending authorized for this call. Nothing paid is chosen otherwise. */
  readonly paidAuthorized: boolean;
  /** A route the task asks for. It is tried first, but it passes the same rules as every other route. */
  readonly prefer?: string;
}

export interface Candidate {
  readonly route: string;
  readonly eligible: boolean;
  /** Why it was skipped (empty when eligible). */
  readonly reasons: readonly string[];
}

export interface Selection {
  /** The first eligible route, or none: nothing is invented when no configured route is eligible. */
  readonly chosen?: string;
  readonly profile: string;
  readonly candidates: readonly Candidate[];
}

export const ROUTING_LIMITS = { providers: 50, routes: 200, profiles: 20, perProfile: 20, roles: 50, exclusions: 100, name: 64, capability: 40, capabilities: 20, contextTokens: 10_000_000, reason: 500, maxTokens: 1_000_000, reasoningTokens: 1_000_000 } as const;

const NAME = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const ROUTE = /^[A-Za-z][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
const CAPABILITY = /^[a-z][a-z0-9-]{0,39}$/;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const own = <T>(map: Readonly<Record<string, T>>, key: string): T | undefined => (Object.hasOwn(map, key) ? map[key] : undefined);

const record = (value: unknown, field: string, max: number): [string, unknown][] => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid(field, "must be an object");
  const entries = Object.entries(value);
  if (entries.length > max) invalid(field, `must have at most ${max} entries`);
  return entries;
};
function bool(value: unknown, field: string): boolean {
  return typeof value === "boolean" ? value : invalid(field, "must be true or false");
}
function exact(value: unknown, field: string, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid(field, "must be an object");
  for (const key of Object.keys(value)) if (!keys.includes(key)) invalid(`${field}.${key}`, "is not a field here");
  return value as Record<string, unknown>;
}
const routeName = (value: unknown, field: string): string => (typeof value === "string" && ROUTE.test(value) ? value : invalid(field, "must be provider/model"));
const plainName = (value: unknown, field: string): string => (typeof value === "string" && NAME.test(value) ? value : invalid(field, "must start with a letter and use letters, digits, '.', '_' or '-' (at most 64 characters)"));

/** Checks a proposed table completely and returns a normalised copy, or refuses with the first problem. Exclusions are managed separately and are not part of a proposal. */
export function checkTable(value: unknown): Omit<RoutingTable, "exclusions"> {
  const top = exact(value, "table", ["providers", "routes", "profiles", "roles"]);
  const providers: Record<string, ProviderEntry> = Object.create(null) as Record<string, ProviderEntry>;
  for (const [name, raw] of record(top["providers"], "table.providers", ROUTING_LIMITS.providers)) {
    plainName(name, `table.providers.${name}`);
    const e = exact(raw, `table.providers.${name}`, ["enabled", "paid", "location"]);
    const location = e["location"] === "local" || e["location"] === "cloud" ? e["location"] : invalid(`table.providers.${name}.location`, "must be local or cloud");
    if (Object.keys(providers).some((other) => other.toLowerCase() === name.toLowerCase())) invalid(`table.providers.${name}`, "differs only by case from another provider");
    providers[name] = { enabled: bool(e["enabled"], `table.providers.${name}.enabled`), paid: bool(e["paid"], `table.providers.${name}.paid`), location };
  }
  const routes: Record<string, RouteEntry> = Object.create(null) as Record<string, RouteEntry>;
  for (const [name, raw] of record(top["routes"], "table.routes", ROUTING_LIMITS.routes)) {
    routeName(name, `table.routes.${name}`);
    const provider = name.slice(0, name.indexOf("/"));
    if (own(providers, provider) === undefined) invalid(`table.routes.${name}`, `names unknown provider ${provider}`);
    const e = exact(raw, `table.routes.${name}`, ["contextTokens", "capabilities", "readTokensPerSecond", "writeTokensPerSecond", "maxTokens", "reasoningTokens"]);
    const ct = e["contextTokens"];
    if (typeof ct !== "number" || !Number.isSafeInteger(ct) || ct < 1 || ct > ROUTING_LIMITS.contextTokens) invalid(`table.routes.${name}.contextTokens`, `must be a whole number from 1 to ${ROUTING_LIMITS.contextTokens}`);
    const caps = e["capabilities"];
    if (!Array.isArray(caps) || caps.length > ROUTING_LIMITS.capabilities) return invalid(`table.routes.${name}.capabilities`, `must be a list of at most ${ROUTING_LIMITS.capabilities}`);
    const list = caps.map((c, i) => (typeof c === "string" && CAPABILITY.test(c) ? c : invalid(`table.routes.${name}.capabilities[${i}]`, "must be lower-case words joined by hyphens")));
    if (new Set(list).size !== list.length) invalid(`table.routes.${name}.capabilities`, "lists a capability twice");
    if (Object.keys(routes).some((other) => other.toLowerCase() === name.toLowerCase())) invalid(`table.routes.${name}`, "differs only by case from another route");
    const speed = (field: "readTokensPerSecond" | "writeTokensPerSecond"): { [K in typeof field]?: number } => {
      const v = e[field];
      if (v === undefined) return {};
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 1_000_000) return invalid(`table.routes.${name}.${field}`, "must be a number of tokens a second above 0 and at most 1000000");
      return { [field]: v };
    };
    routes[name] = { contextTokens: ct as number, capabilities: list, ...speed("readTokensPerSecond"), ...speed("writeTokensPerSecond"), ...checkBudget(e, `table.routes.${name}`, ct as number) };
  }
  const profiles: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  for (const [name, raw] of record(top["profiles"], "table.profiles", ROUTING_LIMITS.profiles)) {
    plainName(name, `table.profiles.${name}`);
    if (!Array.isArray(raw) || raw.length > ROUTING_LIMITS.perProfile) return invalid(`table.profiles.${name}`, `must be a list of at most ${ROUTING_LIMITS.perProfile} routes`);
    const list = raw.map((r, i) => {
      const route = routeName(r, `table.profiles.${name}[${i}]`);
      if (own(routes, route) === undefined) invalid(`table.profiles.${name}[${i}]`, `route ${route} is not in table.routes`);
      return route;
    });
    if (new Set(list).size !== list.length) invalid(`table.profiles.${name}`, "lists the same route twice");
    profiles[name] = list;
  }
  const roles: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, raw] of record(top["roles"], "table.roles", ROUTING_LIMITS.roles)) {
    plainName(name, `table.roles.${name}`);
    const profile = plainName(raw, `table.roles.${name}`);
    if (own(profiles as Record<string, readonly string[]>, profile) === undefined) invalid(`table.roles.${name}`, `profile ${profile} is not in table.profiles`);
    roles[name] = profile;
  }
  return { providers, routes, profiles, roles };
}

/**
 * A route's length and reasoning budget (card W07): whole numbers of tokens above 0, at most `ROUTING_LIMITS.maxTokens` / `.reasoningTokens`; a reply limit no larger than the route's context, and a reasoning cap below the reply limit when
 * both are set (reasoning and the answer share the reply's tokens on the OpenAI-compatible servers, and Anthropic's Messages API requires the reasoning budget to be below `max_tokens`). Absent fields stay absent.
 */
export function checkBudget(e: Readonly<Record<string, unknown>>, field: string, contextTokens: number): RouteBudget {
  const whole = (key: "maxTokens" | "reasoningTokens", max: number): number | undefined => {
    const v = e[key];
    if (v === undefined) return undefined;
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1 || v > max) return invalid(`${field}.${key}`, `must be a whole number of tokens from 1 to ${max}`);
    return v;
  };
  const maxTokens = whole("maxTokens", Math.min(ROUTING_LIMITS.maxTokens, contextTokens));
  const reasoningTokens = whole("reasoningTokens", ROUTING_LIMITS.reasoningTokens);
  if (maxTokens !== undefined && reasoningTokens !== undefined && reasoningTokens >= maxTokens) invalid(`${field}.reasoningTokens`, `must be less than maxTokens (${maxTokens}): the reasoning is part of the reply`);
  return { ...(maxTokens === undefined ? {} : { maxTokens }), ...(reasoningTokens === undefined ? {} : { reasoningTokens }) };
}

/** Checks a request completely. */
export function checkRequest(value: unknown): RouteRequest {
  const e = exact(value, "request", ["role", "profile", "contextTokens", "needs", "data", "paidAuthorized", "prefer"]);
  const ct = e["contextTokens"];
  if (typeof ct !== "number" || !Number.isSafeInteger(ct) || ct < 0 || ct > ROUTING_LIMITS.contextTokens) invalid("request.contextTokens", "must be a whole number of tokens");
  if (!Array.isArray(e["needs"]) || e["needs"].length > ROUTING_LIMITS.capabilities) return invalid("request.needs", "must be a list of capabilities");
  const needs = e["needs"].map((c, i) => (typeof c === "string" && CAPABILITY.test(c) ? c : invalid(`request.needs[${i}]`, "must be a capability name")));
  const data = e["data"] === "local-only" || e["data"] === "cloud-allowed" ? e["data"] : invalid("request.data", "must be local-only or cloud-allowed");
  return {
    role: plainName(e["role"], "request.role"), contextTokens: ct as number, needs, data, paidAuthorized: bool(e["paidAuthorized"], "request.paidAuthorized"),
    ...(e["profile"] === undefined ? {} : { profile: plainName(e["profile"], "request.profile") }),
    ...(e["prefer"] === undefined ? {} : { prefer: routeName(e["prefer"], "request.prefer") }),
  };
}

/**
 * Chooses a route (card R01). Candidates are the preferred route (if the task names one) then the profile's routes in order; each is judged by the same rules, and the
 * answer says why every skipped route was skipped. A disabled or excluded provider, an excluded route, too little context, a missing capability, a cloud route for data
 * that may not leave the installation, and a paid route without spending authorization are all skipped. Nothing is invented: with no eligible route there is no choice.
 */
export function selectRoute(table: RoutingTable, request: RouteRequest): Selection {
  const profile = request.profile ?? own(table.roles, request.role);
  if (profile === undefined) throw new DomainError("not_found", `no profile is configured for role ${request.role}`);
  const list = own(table.profiles, profile);
  if (list === undefined) throw new DomainError("not_found", `profile ${profile} is not configured`);
  const order = request.prefer === undefined ? [...list] : [request.prefer, ...list.filter((r) => r !== request.prefer)];
  const excludedProviders = new Map(table.exclusions.filter((x) => x.target.kind === "provider").map((x) => [x.target.name, x.reason]));
  const excludedRoutes = new Map(table.exclusions.filter((x) => x.target.kind === "route").map((x) => [x.target.name, x.reason]));
  const candidates: Candidate[] = order.map((route) => {
    const reasons: string[] = [];
    const entry = own(table.routes, route);
    const providerName = route.slice(0, route.indexOf("/"));
    const provider = own(table.providers, providerName);
    if (entry === undefined || provider === undefined) return { route, eligible: false, reasons: ["not a configured route"] };
    if (!provider.enabled) reasons.push(`provider ${providerName} is disabled`);
    if (excludedProviders.has(providerName)) reasons.push(`provider ${providerName} is excluded: ${excludedProviders.get(providerName)}`);
    if (excludedRoutes.has(route)) reasons.push(`route is excluded: ${excludedRoutes.get(route)}`);
    if (request.contextTokens > entry.contextTokens) reasons.push(`needs ${request.contextTokens} tokens of context but supports ${entry.contextTokens}`);
    const missing = request.needs.filter((n) => !entry.capabilities.includes(n));
    if (missing.length > 0) reasons.push(`lacks ${missing.join(", ")}`);
    if (provider.location === "cloud" && request.data !== "cloud-allowed") reasons.push("runs in the cloud and this task's data may not leave the installation");
    if (provider.paid && !request.paidAuthorized) reasons.push("is paid and spending is not authorized");
    return { route, eligible: reasons.length === 0, reasons };
  });
  const chosen = candidates.find((c) => c.eligible)?.route;
  return { ...(chosen === undefined ? {} : { chosen }), profile, candidates };
}
