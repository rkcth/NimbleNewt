import { DomainError } from "../domain/errors.js";
import { onlyKnown, text } from "../domain/model.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { ROUTING_LIMITS, checkTable } from "../routing/index.js";
import { EMPTY_TOPOLOGY, TOPOLOGY_REF, assertLists, checkTopology, type ListRules, type Topology } from "../routing/lists.js";
import type { RoutingBody } from "../routing/index.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";

const ROUTING: AggregateRef = { kind: "routing-table", id: "routing" };
/** The record kind that holds where a provider's model server is and the NAME of the credential it needs (never a value). */
export const PROVIDER_ENDPOINT_KIND = "provider-endpoint";
/** The profile the guided setup builds and the roles it points at it. Roles already in the table keep what they have. */
export const SETUP_PROFILE = "default";
export const SETUP_ROLES = ["coordinator", "safety-supervisor", "author"] as const;

const NAME = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
const SECRET_NAME = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };

/** The smallest window a route can work in (the worker refuses a smaller one; kept equal to `MIN_WORKABLE_WINDOW` in pi-adapter, which an integration test checks, card CMP). */
export const MIN_WORKABLE_CONTEXT_TOKENS = 8192;

export interface ProviderEndpointBody { readonly provider: string; readonly endpoint: string; /** The name of the secret in the secret store; the value is never kept here. */ readonly credentialName?: string; readonly kind?: string; readonly setBy: string }

export interface ProviderSpec {
  readonly name: string;
  readonly location: "local" | "cloud";
  readonly paid?: boolean;
  readonly enabled?: boolean;
  /** The model server's base address, such as `http://127.0.0.1:8002/v1`. */
  readonly endpoint: string;
  /** The NAME of the secret that holds its key, when it needs one. A value that looks like a key is refused. */
  readonly credentialName?: string;
  readonly models: readonly string[];
  /** The model's context window in tokens; every route needs a known window. */
  readonly contextTokens: number;
}

export interface AddProviders extends NoActor { readonly providers: unknown; readonly expectedRevision?: unknown }

/** Whether a text is an address a model server could have: http or https, a host, no credentials in it. */
function checkEndpoint(value: unknown, field: string): string {
  const raw = text(value, field, { min: 1, max: 300 });
  let url: URL;
  try { url = new URL(raw); } catch { return invalid(field, "must be an address such as http://127.0.0.1:8000/v1"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") return invalid(field, "must start with http:// or https://");
  // `?` or `#` with nothing after it still leaves search and hash empty, so the raw text is checked too; a key in the path (some servers take one there) is caught by the redactor.
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || /[?#@]/.test(raw) || redactText(raw) !== raw) return invalid(field, "must not carry a user name, password, query or key; a key belongs in the secret store, named by credentialName");
  return raw.replace(/\/+$/, "");
}

function checkSpec(raw: unknown, i: number): ProviderSpec {
  const at = `providers[${i}]`;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return invalid(at, "must be an object");
  const e = raw as Record<string, unknown>;
  for (const k of Object.keys(e)) if (!["name", "location", "paid", "enabled", "endpoint", "credentialName", "models", "contextTokens"].includes(k)) invalid(`${at}.${k}`, "is not a provider field");
  const name = typeof e["name"] === "string" && NAME.test(e["name"]) ? e["name"] : invalid(`${at}.name`, "must start with a letter and use letters, digits, '.', '_' or '-'");
  const location = e["location"] === "local" || e["location"] === "cloud" ? e["location"] : invalid(`${at}.location`, "must be local or cloud");
  for (const k of ["paid", "enabled"]) if (e[k] !== undefined && typeof e[k] !== "boolean") invalid(`${at}.${k}`, "must be true or false");
  const endpoint = checkEndpoint(e["endpoint"], `${at}.endpoint`);
  let credentialName: string | undefined;
  if (e["credentialName"] !== undefined) {
    const c = text(e["credentialName"], `${at}.credentialName`, { min: 1, max: 64 });
    // A key pasted where its name belongs would be recorded in the clear: refuse anything that is not a plain secret name, or that the redactor recognises as a key.
    if (!SECRET_NAME.test(c) || redactText(c) !== c) invalid(`${at}.credentialName`, "must be the NAME of a secret in the secret store (letters, digits, '.', '_' or '-'); never the key itself");
    credentialName = c;
  }
  if (!Array.isArray(e["models"]) || e["models"].length < 1 || e["models"].length > 20) return invalid(`${at}.models`, "must list 1 to 20 model names");
  const models = e["models"].map((m, j) => (typeof m === "string" && MODEL.test(m) ? m : invalid(`${at}.models[${j}]`, "must be a model name")));
  if (new Set(models).size !== models.length) invalid(`${at}.models`, "lists a model twice");
  const ct = e["contextTokens"];
  if (typeof ct !== "number" || !Number.isSafeInteger(ct) || ct < 1 || ct > ROUTING_LIMITS.contextTokens) invalid(`${at}.contextTokens`, "must be the model's context window as a whole number of tokens");
  if ((ct as number) < MIN_WORKABLE_CONTEXT_TOKENS) invalid(`${at}.contextTokens`, `${String(ct)} tokens is too small for the team to work in (at least ${String(MIN_WORKABLE_CONTEXT_TOKENS)} are needed); give the model's real context window, or choose a model with a larger one`);
  return { name, location, endpoint, ...(credentialName === undefined ? {} : { credentialName }), ...(e["paid"] === undefined ? {} : { paid: e["paid"] as boolean }), ...(e["enabled"] === undefined ? {} : { enabled: e["enabled"] as boolean }), models, contextTokens: ct as number };
}

/**
 * Guided-setup editing of the routing table (card U14): adds or replaces whole providers, each with its model server's address, the NAME of its credential and its models, and
 * rebuilds the `default` profile (free and local routes first, then the paid ones, each in the order given) that the coordinator, the safety supervisor and the author use unless the
 * table already gives a role something else. The table, the profile and the endpoint records are written in one command, or nothing is. The fallback-list rule (at least two routes on two
 * different servers) applies as it always does; its refusal is told in plain words and names what to add. The owner only: a provider decides where the team's data may go.
 */
export class SetupProviderService {
  readonly #runner: CommandRunner;
  readonly #rules: ListRules | undefined;
  private constructor(runner: CommandRunner, rules: ListRules | undefined) { this.#runner = runner; this.#rules = rules; }

  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}, rules?: ListRules): SetupProviderService { return new SetupProviderService(new CommandRunner(storage, epoch, options), rules); }

  async add(owner: Principal, command: AddProviders): Promise<{ revision: number; replayed: boolean; providers: readonly string[]; routes: readonly string[] }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not edit the model providers; only the owner does`);
    let summary: { providers: string[]; routes: string[] } = { providers: [], routes: [] };
    const r = await this.#runner.command("setup.providers.add", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => {
      onlyKnown(command, ["commandId", "providers", "expectedRevision"]);
      if (!Array.isArray(command.providers) || command.providers.length < 1 || command.providers.length > 10) return invalid("providers", "must list 1 to 10 providers");
      const specs = command.providers.map(checkSpec);
      if (new Set(specs.map((s) => s.name.toLowerCase())).size !== specs.length) invalid("providers", "names a provider twice");
      return {
        payload: { providers: specs as unknown as JsonObject[] },
        build: async () => {
          const current = await this.#runner.get(ROUTING.kind, ROUTING.id);
          const before = current?.body as unknown as RoutingBody | undefined;
          const stale = command.expectedRevision;
          if (stale !== undefined && stale !== (current?.revision ?? 0)) throw new DomainError("stale_revision", `routing is at revision ${current?.revision ?? 0}, not ${String(stale)}`, { currentRevision: current?.revision ?? 0 });
          const replaced = new Set(specs.map((s) => s.name));
          const providers: Record<string, unknown> = {};
          const routes: Record<string, unknown> = {};
          // What stays: every provider and route the owner did not name again (including the budgets already set on a route).
          for (const [n, p] of Object.entries(before?.providers ?? {})) if (!replaced.has(n)) providers[n] = p;
          for (const [n, e] of Object.entries(before?.routes ?? {})) if (!replaced.has(n.slice(0, n.indexOf("/")))) routes[n] = e;
          const added: string[] = [];
          for (const s of specs) {
            providers[s.name] = { enabled: s.enabled ?? true, paid: s.paid ?? false, location: s.location };
            for (const m of s.models) { routes[`${s.name}/${m}`] = { contextTokens: s.contextTokens, capabilities: ["tools"] }; added.push(`${s.name}/${m}`); }
          }
          // The default profile: free before paid, local before cloud, then the order they were given; a route the table already lists in it keeps its place ahead of the new ones.
          const rank = (route: string): number => { const p = providers[route.slice(0, route.indexOf("/"))] as { paid: boolean; location: string }; return (p.paid ? 2 : 0) + (p.location === "cloud" ? 1 : 0); };
          const kept = (before?.profiles[SETUP_PROFILE] ?? []).filter((r) => Object.hasOwn(routes, r));
          const order = [...kept, ...added.filter((r) => !kept.includes(r))].map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map((x) => x.r);
          const profiles = { ...Object.fromEntries(Object.entries(before?.profiles ?? {}).map(([n, l]) => [n, n === SETUP_PROFILE ? l : l.filter((r) => Object.hasOwn(routes, r))])), [SETUP_PROFILE]: order };
          const roles: Record<string, string> = { ...(before?.roles ?? {}) };
          for (const role of SETUP_ROLES) if (roles[role] === undefined) roles[role] = SETUP_PROFILE;
          const table = checkTable({ providers, routes, profiles, roles });
          const stored = (await this.#runner.get(TOPOLOGY_REF.kind, TOPOLOGY_REF.id))?.body as unknown as Topology | undefined;
          const topology = stored === undefined ? EMPTY_TOPOLOGY : checkTopology({ targets: stored.targets, aliases: stored.aliases, services: stored.services }, table);
          // For the fallback rule a route the topology does not map runs on its provider's recorded model server (host and port), so two provider names for one server are not two servers;
          // each provider stays its own account, as an unmapped route is. Only the check sees this; the stored topology is not changed.
          const serverOf = new Map<string, string>(specs.map((s) => [s.name, new URL(s.endpoint).host.toLowerCase()]));
          for (const n of Object.keys(providers)) {
            if (serverOf.has(n)) continue;
            const rec = (await this.#runner.get(PROVIDER_ENDPOINT_KIND, n))?.body as unknown as ProviderEndpointBody | undefined;
            try { if (rec !== undefined) serverOf.set(n, new URL(rec.endpoint).host.toLowerCase()); } catch { /* an unreadable record leaves the provider its own server */ }
          }
          const targets: Record<string, { endpoint: string; account: string }> = Object.create(null) as Record<string, { endpoint: string; account: string }>;
          for (const route of Object.keys(routes)) { const p = route.slice(0, route.indexOf("/")); const server = serverOf.get(p); if (server !== undefined && !Object.hasOwn(topology.targets, route)) targets[route] = { endpoint: `server:${server}`, account: p }; }
          const judged: Topology = { ...topology, targets: Object.assign(targets, topology.targets) };
          try { assertLists(table, judged, this.#rules ?? {}); } catch (error) {
            if (error instanceof DomainError && error.code === "invalid_command" && /fallback lists/.test(error.message)) throw new DomainError("invalid_command", `the team needs a backup so that losing one model server does not stop it: give at least two routes on two different servers (for example your local model and one free or cheap cloud route) in one step. (${error.message})`, { field: "providers" });
            throw error;
          }
          const body: RoutingBody = { ...table, exclusions: before?.exclusions ?? [], updatedBy: owner.id };
          const changes: Change[] = [current === undefined ? { type: "create", ref: ROUTING, body: body as unknown as JsonObject } : { type: "update", ref: ROUTING, expectedRevision: current.revision, body: body as unknown as JsonObject }];
          for (const s of specs) {
            const ref: AggregateRef = { kind: PROVIDER_ENDPOINT_KIND, id: s.name };
            const existing = await this.#runner.get(ref.kind, ref.id);
            const rec: ProviderEndpointBody = { provider: s.name, endpoint: s.endpoint, ...(s.credentialName === undefined ? {} : { credentialName: s.credentialName }), setBy: owner.id };
            changes.push(existing === undefined ? { type: "create", ref, body: rec as unknown as JsonObject } : { type: "update", ref, expectedRevision: existing.revision, body: rec as unknown as JsonObject });
          }
          summary = { providers: specs.map((s) => s.name), routes: added };
          return { ref: ROUTING, creates: current === undefined, changes, detail: { providers: specs.length, routes: added.length } };
        },
      };
    });
    return { revision: r.revision, replayed: r.replayed, providers: summary.providers, routes: summary.routes };
  }

  /** Every provider's model server address and credential name, for the host that builds the model clients. */
  async endpoints(): Promise<readonly ProviderEndpointBody[]> {
    const out: ProviderEndpointBody[] = [];
    let afterId: string | undefined;
    for (let i = 0; i < 5; i++) {
      const page = await this.#runner.list(PROVIDER_ENDPOINT_KIND, { ...(afterId === undefined ? {} : { afterId }), limit: 200 });
      for (const a of page) { afterId = a.id; out.push(a.body as unknown as ProviderEndpointBody); }
      if (page.length < 200) break;
    }
    return out;
  }
}
