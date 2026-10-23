import { DomainError } from "../domain/errors.js";
import type { RoutingTable } from "./policy.js";

/** The roles that call a model and so must have a fallback list; the coordinator and the safety supervisor are named in the card. Others in the routing table are checked too. */
export const MODEL_USING_ROLES = ["coordinator", "safety-supervisor"] as const;

/**
 * Where a route really goes (card R04). A route is `provider/model`; the same model can be reached under several names (aliases) and many routes share one endpoint, one
 * account or one local service, so an exclusion or a drain at those levels, and a fallback list that must not lead back to the service it is escaping, need this map.
 * An unmapped route is its own provider's endpoint and account.
 */
export interface Topology {
  /** Where each canonical route goes. */
  readonly targets: Readonly<Record<string, RouteTarget>>;
  /** Alias route -> canonical route (one step, never a chain). */
  readonly aliases: Readonly<Record<string, string>>;
  /** Local services that may be switched off (such as an inference engine), whether or not any route currently uses them. */
  readonly services: readonly string[];
}
export interface RouteTarget { readonly endpoint: string; readonly account: string; readonly service?: string }
export interface ListRules {
  /** Roles that must have a valid list (default: the coordinator and the safety supervisor); every role in the routing table must have one too. */
  readonly requiredRoles?: readonly string[];
  /** Roles the owner accepted with a single entry or with all entries on one endpoint (no backup survives losing it). */
  readonly acknowledgedWeak?: readonly string[];
}
export interface ListProblem { readonly role: string; readonly problem: string }

export const TOPOLOGY_LIMITS = { aliases: 100, targets: 200, services: 20, name: 64 } as const;
const NAME = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const own = <T>(map: Readonly<Record<string, T>>, key: string): T | undefined => (Object.hasOwn(map, key) ? map[key] : undefined);
const plain = (v: unknown, field: string): string => (typeof v === "string" && NAME.test(v) ? v : invalid(field, "must start with a letter and use letters, digits, '.', '_' or '-' (at most 64 characters)"));
const shape = (v: unknown, field: string, keys: readonly string[]): Record<string, unknown> => {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return invalid(field, "must be an object");
  for (const k of Object.keys(v)) if (!keys.includes(k)) invalid(`${field}.${k}`, "is not a field here");
  return v as Record<string, unknown>;
};

export const TOPOLOGY_REF = { kind: "route-topology", id: "topology" } as const;
export const EMPTY_TOPOLOGY: Topology = { targets: {}, aliases: {}, services: [] };

/** Checks a proposed topology against the routing table it describes and returns a normalised copy, or refuses with the first problem. */
export function checkTopology(value: unknown, table: Pick<RoutingTable, "routes" | "providers">): Topology {
  const top = shape(value, "topology", ["targets", "aliases", "services"]);
  const rawServices = top["services"] ?? [];
  if (!Array.isArray(rawServices) || rawServices.length > TOPOLOGY_LIMITS.services) return invalid("topology.services", `must be a list of at most ${TOPOLOGY_LIMITS.services} names`);
  const services = rawServices.map((s, i) => plain(s, `topology.services[${i}]`));
  if (new Set(services).size !== services.length) invalid("topology.services", "lists a service twice");
  const aliasesIn = top["aliases"] ?? {};
  if (aliasesIn === null || typeof aliasesIn !== "object" || Array.isArray(aliasesIn) || Object.keys(aliasesIn).length > TOPOLOGY_LIMITS.aliases) return invalid("topology.aliases", `must be an object of at most ${TOPOLOGY_LIMITS.aliases} entries`);
  const aliases: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [alias, canon] of Object.entries(aliasesIn as Record<string, unknown>)) {
    if (!Object.hasOwn(table.routes, alias)) invalid(`topology.aliases.${alias}`, "is not a route in the routing table");
    if (typeof canon !== "string" || !Object.hasOwn(table.routes, canon)) invalid(`topology.aliases.${alias}`, "must name a route in the routing table");
    aliases[alias] = canon as string;
  }
  for (const [alias, canon] of Object.entries(aliases)) {
    if (alias === canon) invalid(`topology.aliases.${alias}`, "is an alias of itself");
    if (Object.hasOwn(aliases, canon)) invalid(`topology.aliases.${alias}`, `points at ${canon}, which is itself an alias; aliases are one step (this would be a chain or a cycle)`);
  }
  const targetsIn = top["targets"] ?? {};
  if (targetsIn === null || typeof targetsIn !== "object" || Array.isArray(targetsIn) || Object.keys(targetsIn).length > TOPOLOGY_LIMITS.targets) return invalid("topology.targets", `must be an object of at most ${TOPOLOGY_LIMITS.targets} entries`);
  const targets: Record<string, RouteTarget> = Object.create(null) as Record<string, RouteTarget>;
  for (const [route, raw] of Object.entries(targetsIn as Record<string, unknown>)) {
    if (!Object.hasOwn(table.routes, route)) invalid(`topology.targets.${route}`, "is not a route in the routing table");
    if (Object.hasOwn(aliases, route)) invalid(`topology.targets.${route}`, "is an alias; give the target of the route it names");
    const e = shape(raw, `topology.targets.${route}`, ["endpoint", "account", "service"]);
    const service = e["service"] === undefined ? undefined : plain(e["service"], `topology.targets.${route}.service`);
    if (service !== undefined && !services.includes(service)) invalid(`topology.targets.${route}.service`, `${service} is not in topology.services`);
    const provider = route.slice(0, route.indexOf("/"));
    if (service !== undefined && table.providers[provider]?.location !== "local") invalid(`topology.targets.${route}.service`, "only a route of a local provider runs on a local service");
    targets[route] = { endpoint: plain(e["endpoint"], `topology.targets.${route}.endpoint`), account: plain(e["account"], `topology.targets.${route}.account`), ...(service === undefined ? {} : { service }) };
  }
  return { targets, aliases, services };
}

export const canonical = (topology: Topology, route: string): string => own(topology.aliases, route) ?? route;
export const providerOf = (route: string): string => route.slice(0, route.indexOf("/"));
/** Where a route goes after alias resolution; an unmapped route is its provider's own endpoint and account. */
export function targetOf(topology: Topology, route: string): RouteTarget & { readonly canonical: string; readonly provider: string } {
  const canon = canonical(topology, route);
  const provider = providerOf(canon);
  return { ...(own(topology.targets, canon) ?? { endpoint: provider, account: provider }), canonical: canon, provider };
}

/**
 * Judges every model-using role's fallback list. A list needs: a role in the routing table with a profile; routes (never another list, so a fallback has no list of its own to
 * follow and cycles cannot exist); no two entries that are the same route under different aliases; at least two entries on two distinct endpoints (and two distinct accounts unless every entry is a local engine), unless the owner acknowledged
 * the weakness for that role. Aliases are resolved first, so a backup that is an alias of the primary's route does not count as a backup.
 */
export function checkLists(table: RoutingTable | Omit<RoutingTable, "exclusions">, topology: Topology, rules: ListRules = {}): ListProblem[] {
  const required = rules.requiredRoles ?? MODEL_USING_ROLES;
  const problems: ListProblem[] = [];
  const roles = [...new Set([...required, ...Object.keys(table.roles)])];
  for (const role of roles) {
    const profile = own(table.roles, role);
    if (profile === undefined) { problems.push({ role, problem: "has no fallback list: the routing table gives it no profile" }); continue; }
    const list = own(table.profiles, profile) ?? [];
    if (list.length === 0) { problems.push({ role, problem: `profile ${profile} is empty` }); continue; }
    const resolved = list.map((r) => canonical(topology, r));
    const dup = resolved.find((r, i) => resolved.indexOf(r) !== i);
    if (dup !== undefined) { problems.push({ role, problem: `profile ${profile} reaches ${dup} twice (an alias leads back to a route already in the list)` }); continue; }
    if (rules.acknowledgedWeak?.includes(role) === true) continue;
    if (resolved.length < 2) { problems.push({ role, problem: `profile ${profile} has no backup entry` }); continue; }
    const targets = resolved.map((r) => targetOf(topology, r));
    if (new Set(targets.map((t) => t.endpoint)).size < 2) { problems.push({ role, problem: `every entry of profile ${profile} is on one endpoint, so losing it loses the whole list` }); continue; }
    // One account behind every entry fails together (a credit or authentication block is account-wide); a local engine's nominal account may be shared, so all-local lists are exempt.
    const allLocal = resolved.every((r) => table.providers[providerOf(r)]?.location === "local");
    if (!allLocal && new Set(targets.map((t) => t.account)).size < 2) problems.push({ role, problem: `every entry of profile ${profile} is on one account, so one credit or authentication block loses the whole list` });
  }
  return problems;
}

/** Refuses a table or topology whose lists have problems. */
export function assertLists(table: RoutingTable | Omit<RoutingTable, "exclusions">, topology: Topology, rules: ListRules | undefined): void {
  if (rules === undefined) return;
  const problems = checkLists(table, topology, rules);
  if (problems.length > 0) throw new DomainError("invalid_command", `fallback lists: ${problems.map((p) => `${p.role} ${p.problem}`).join("; ")}`, { field: "table" });
}
