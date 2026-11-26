import { DomainError } from "../domain/errors.js";
import { onlyKnown } from "../domain/model.js";
import type { ConfigurationService } from "../configuration/index.js";
import { sandboxFor, type SandboxFacts } from "../environment/sandbox.js";
import type { Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { ProviderEndpointBody } from "../setup/index.js";
import { compatibility, type AgentWorkInput, type CompatView, type HostRuntimeInput, type PendingMigrationInput } from "./compat.js";

/** The bounds of the administration reads: nothing here returns an unbounded list. */
export const ADMIN_LIMITS = { settings: 300, providers: 50, models: 60, secrets: 100, hosts: 100, value: 1500 } as const;

const SECRET_NAME = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

/** What the administration reads need of the rest of the controller. Every dependency is a plain function so the views hold no service of their own and cannot write anything. */
export interface AdminDeps {
  readonly configuration: Pick<ConfigurationService, "settings" | "effective">;
  /** The routing table now: providers (enabled, paid, location) and routes (the model and its window). */
  readonly routing: () => Promise<{ readonly providers: Readonly<Record<string, { readonly enabled: boolean; readonly paid: boolean; readonly location: string }>>; readonly routes: Readonly<Record<string, { readonly contextTokens: number }>>; readonly revision?: number } | undefined>;
  /** Each provider's model-server address and the NAME of its secret (never a value). */
  readonly endpoints: () => Promise<readonly ProviderEndpointBody[]>;
  /** The secret store the owner writes to, when the host gave one. Only presence is ever asked of it: its values are not readable through anything here. */
  readonly secrets?: { readonly kind?: string; readonly has: (name: string) => Promise<boolean>; /** Names the installation itself depends on (its own credential): they are not offered for writing. */ readonly reserved?: readonly string[] };
  /** The hosts that have announced themselves, each with the operating system it reported. */
  readonly hosts: (by: Principal) => Promise<readonly { readonly hostId: string; readonly os?: string; readonly freshness: string; readonly identity: string }[]>;
  /** The operating system of this computer when the controller runs a worker host on it; absent when it does not. */
  readonly localOs?: string;
  /** What the compatibility and migration status reads (card U08): the Node.js version running, what each host's worker last announced, where agents work, and the database migrations. Each is a plain read; absent: the status is unavailable. */
  readonly compat?: {
    readonly nodeVersion: string;
    readonly hostRuntimes: (by: Principal) => Promise<readonly HostRuntimeInput[]>;
    readonly agentWork: (by: Principal) => Promise<readonly AgentWorkInput[]>;
    readonly migration: (by: Principal) => Promise<{ readonly schemaVersion: number; readonly latestKnown: number; readonly migrations: readonly PendingMigrationInput[] }>;
  };
}

export type SettingState = "default" | "set" | "inherited" | "locked";
export interface SettingItem {
  readonly key: string;
  readonly description: string;
  readonly kind: "default" | "restriction";
  readonly effect: string;
  readonly installationOnly: boolean;
  /** The value in force; absent when nothing sets it (`state` is `default` then, or the setting has no built-in value). */
  readonly value?: unknown;
  readonly valueClipped?: boolean;
  readonly state: SettingState;
  readonly source: { readonly layer: string; readonly id: string };
  readonly lockedBy?: { readonly layer: string; readonly id: string };
  /** Whether the owner can change it from the installation layer (always, for the owner). A value locked or only narrowed by a layer above is explained in `note`. */
  readonly editable: boolean;
  readonly note?: string;
}

/** The secret store's own name rule (no `__`, as the stores and configuration check it), so a name the store would refuse is refused before it, in words about the name. */
const STORE_NAME = /^(?!.*__)[A-Za-z][A-Za-z0-9._-]{0,63}$/;

/**
 * The start of every name an owner's credential is kept under in the secret store (the launcher's `OWNER_SECRET`): this installation's, the plain default name, and those of other installations that share the
 * same store under the same account. None of them is ever written from the web page, whichever installation the page belongs to (letter case ignored, as the launcher's own check ignores it).
 */
export const OWNER_SECRET_PREFIX = "nimblenewt-owner-token";

/**
 * The write behind the Secrets form of the web page (card U08), kept here so its checks are one tested function: only the owner's own credential (never an agent, a task credential, a client or a service), never
 * a name the installation itself depends on (`reserved`: its own credential, the database address, the transfer targets', the backup signing key; and any owner credential's name, `OWNER_SECRET_PREFIX`), never a name that itself looks like a key (it would be shown and
 * recorded). The value goes to the store and nowhere else; what comes back is the name and whether an earlier value was replaced.
 */
export function secretWriter(authenticate: (token: string) => Promise<Principal>, store: { resolve(name: string): Promise<string | undefined>; set(name: string, value: string): Promise<void> }, reserved: readonly string[]): (token: string, name: string, value: string) => Promise<{ readonly name: string; readonly replaced: boolean }> {
  const held = new Set(reserved.map((r) => r.toLowerCase()));
  return async (token, name, value) => {
    const who = await authenticate(token);
    if (who.kind !== "owner" || who.taskScope !== undefined) throw new DomainError("forbidden", "only the owner may write a secret");
    if (typeof name !== "string" || !STORE_NAME.test(name)) throw new DomainError("invalid_command", "that is not a secret name (a letter, then letters, digits, '.', '_' or '-', at most 64, no '__')", { field: "name" });
    if (redactText(name) !== name) throw new DomainError("invalid_command", "that name looks like a key; give the secret a name and put the key in the value field", { field: "name" });
    if (held.has(name.toLowerCase()) || name.toLowerCase().startsWith(OWNER_SECRET_PREFIX)) throw new DomainError("forbidden", `${name} is a name the installation itself depends on and is not written from the web page`);
    const replaced = (await store.resolve(name).catch(() => undefined)) !== undefined;
    await store.set(name, value);
    return { name, replaced };
  };
}

const isWild = (key: string): boolean => key.split(".").includes("*");
const matches = (def: string, key: string): boolean => { const d = def.split("."), k = key.split("."); return d.length === k.length && d.every((x, i) => x === "*" || x === k[i]); };

/**
 * The owner's reads for the settings and administration pages (card U08). Read only and owner only: the same configuration, routing and host records the chat and the API change, shown with where each value comes
 * from. A secret has no value here: only whether its name is set.
 */
export class AdminViewService {
  readonly #d: AdminDeps;
  constructor(deps: AdminDeps) { this.#d = deps; }

  #owner(by: Principal, what: string): void { if (by.kind !== "owner" || by.taskScope !== undefined) throw new DomainError("forbidden", `${by.id} may not ${what}; only the owner does`); }

  /** Every setting the system knows, with the value in force, whether it is the default, set at this level, inherited from a layer above, or locked, and the layer it comes from. */
  async settings(by: Principal, args: { prefix?: unknown; agentId?: unknown; projectId?: unknown } = {}): Promise<{ readonly items: readonly SettingItem[]; readonly truncated: boolean; readonly problems: readonly string[]; readonly scope: { readonly layer: string; readonly id: string } }> {
    this.#owner(by, "read the settings");
    onlyKnown(args, ["prefix", "agentId", "projectId"]);
    const prefix = args.prefix === undefined ? "" : typeof args.prefix === "string" && /^[A-Za-z0-9._*-]{0,60}$/.test(args.prefix) ? args.prefix : ((): never => { throw new DomainError("invalid_command", "prefix: must be at most 60 letters, digits, dots, dashes or underscores", { field: "prefix" }); })();
    const scope: { agentId?: string; projectId?: string } = {};
    if (args.agentId !== undefined) { if (typeof args.agentId !== "string") throw new DomainError("invalid_command", "agentId: must be an agent ID", { field: "agentId" }); scope.agentId = args.agentId; }
    if (args.projectId !== undefined) { if (typeof args.projectId !== "string") throw new DomainError("invalid_command", "projectId: must be a project ID", { field: "projectId" }); scope.projectId = args.projectId; }
    const eff = await this.#d.configuration.effective(by, scope);
    if (eff === undefined) throw new DomainError("not_found", "no such agent or project");
    const own = scope.agentId !== undefined ? "agent" : scope.projectId !== undefined ? "project" : "installation";
    const defs = this.#d.configuration.settings();
    const keys = new Set<string>(defs.filter((d) => !isWild(d.key)).map((d) => d.key));
    for (const k of Object.keys(eff.values)) keys.add(k);
    const items: SettingItem[] = [];
    for (const key of [...keys].sort()) {
      if (!key.startsWith(prefix)) continue;
      const def = defs.find((d) => d.key === key) ?? defs.find((d) => matches(d.key, key));
      if (def === undefined) continue;
      const r = eff.values[key];
      const state: SettingState = r === undefined ? "default" : r.lockedBy !== undefined ? "locked" : r.source.layer === "default" ? "default" : r.source.layer === own ? "set" : "inherited";
      const text = r === undefined ? undefined : JSON.stringify(r.value);
      const clipped = text !== undefined && text.length > ADMIN_LIMITS.value;
      // A value is configuration, never a secret (configuration refers to secrets by name), but whatever text the redactor recognises as a key is shown redacted, whole or clipped, string or not.
      const shown = r === undefined ? undefined : clipped ? redactText(text!.slice(0, ADMIN_LIMITS.value)) : typeof r.value === "string" ? redactText(r.value) : redactText(text!) !== text ? redactText(text!) : r.value;
      const note = r?.lockedBy !== undefined ? `Locked by the ${r.lockedBy.layer} layer: layers below it cannot change it.` : r !== undefined && r.ignored.length > 0 ? `Not counted: ${r.ignored.slice(0, 2).map((i) => `${i.layer} (${i.reason})`).join("; ")}.` : def.installationOnly === true ? "Only the whole installation can set this; no narrower layer can override it." : def.kind === "restriction" ? "A restriction: a narrower layer can only tighten it, never widen it." : undefined;
      items.push({ key, description: def.description, kind: def.kind, effect: def.effect, installationOnly: def.installationOnly === true, ...(shown === undefined ? {} : { value: shown }), ...(clipped ? { valueClipped: true } : {}), state, source: r === undefined ? { layer: "default", id: "default" } : r.source, ...(r?.lockedBy === undefined ? {} : { lockedBy: r.lockedBy }), editable: own === "installation", ...(note === undefined ? {} : { note }) });
      if (items.length > ADMIN_LIMITS.settings) break;
    }
    const truncated = items.length > ADMIN_LIMITS.settings;
    return { items: truncated ? items.slice(0, ADMIN_LIMITS.settings) : items, truncated, problems: eff.problems.map((p) => redactText(p).slice(0, 300)), scope: { layer: own, id: own === "installation" ? "installation" : (scope.agentId ?? scope.projectId)! } };
  }

  async #secretState(name: string | undefined): Promise<"none needed" | "set" | "not set" | "unreadable" | "no store"> {
    if (name === undefined) return "none needed";
    if (this.#d.secrets === undefined) return "no store";
    try { return (await this.#d.secrets.has(name)) ? "set" : "not set"; } catch { return "unreadable"; }
  }

  /** Each model provider: where it runs, whether it costs money, whether it is on, its model server's address, the NAME of its secret and whether that secret is set, and its models. */
  async providers(by: Principal): Promise<{ readonly revision?: number; readonly items: readonly { readonly name: string; readonly location: string; readonly enabled: boolean; readonly paid: boolean; readonly endpoint?: string; readonly kind?: string; readonly credentialName?: string; readonly secret: string; readonly models: readonly { readonly route: string; readonly contextTokens: number }[]; readonly modelsMore?: number }[]; readonly truncated: boolean; readonly secretsWritable: boolean }> {
    this.#owner(by, "read the model providers");
    const table = await this.#d.routing();
    const ends = new Map((await this.#d.endpoints()).map((e) => [e.provider, e]));
    const names = [...new Set([...Object.keys(table?.providers ?? {}), ...ends.keys()])].sort();
    const items = [];
    for (const name of names.slice(0, ADMIN_LIMITS.providers)) {
      const p = table?.providers[name];
      const e = ends.get(name);
      const routes = Object.entries(table?.routes ?? {}).filter(([r]) => r.startsWith(`${name}/`)).sort(([a], [b]) => (a < b ? -1 : 1));
      items.push({
        name, location: p?.location ?? "unknown", enabled: p?.enabled ?? false, paid: p?.paid ?? false,
        ...(e === undefined ? {} : { endpoint: redactText(e.endpoint) }), ...(e?.kind === undefined ? {} : { kind: e.kind }), ...(e?.credentialName === undefined ? {} : { credentialName: e.credentialName }),
        secret: await this.#secretState(e?.credentialName),
        models: routes.slice(0, ADMIN_LIMITS.models).map(([route, r]) => ({ route, contextTokens: r.contextTokens })),
        ...(routes.length > ADMIN_LIMITS.models ? { modelsMore: routes.length - ADMIN_LIMITS.models } : {}),
      });
    }
    return { ...(table?.revision === undefined ? {} : { revision: table.revision }), items, truncated: names.length > ADMIN_LIMITS.providers, secretsWritable: this.#d.secrets !== undefined };
  }

  /** The names of the secrets the installation refers to, and for each only whether it is set and what uses it. A value is never read out, and the form that writes one is the web page's, not the chat's. */
  async secrets(by: Principal): Promise<{ readonly writable: boolean; readonly store?: string; readonly items: readonly { readonly name: string; readonly state: string; readonly usedBy: readonly string[] }[]; readonly truncated: boolean }> {
    this.#owner(by, "read the secret names");
    const users = new Map<string, string[]>();
    for (const e of await this.#d.endpoints()) if (e.credentialName !== undefined) users.set(e.credentialName, [...(users.get(e.credentialName) ?? []), `provider ${e.provider}`]);
    const names = [...users.keys()].filter((n) => SECRET_NAME.test(n)).sort();
    const items = [];
    for (const name of names.slice(0, ADMIN_LIMITS.secrets)) items.push({ name, state: await this.#secretState(name), usedBy: users.get(name)!.slice(0, 10) });
    return { writable: this.#d.secrets !== undefined, ...(this.#d.secrets?.kind === undefined ? {} : { store: this.#d.secrets.kind }), items, truncated: names.length > ADMIN_LIMITS.secrets };
  }

  /** The sandbox each host uses to confine agents, and a warning where its boundary is weaker than the strongest one (macOS Seatbelt and the Windows AppContainer launcher are process-level; decision G01). */
  async sandbox(by: Principal): Promise<{ readonly local?: SandboxFacts; readonly hosts: readonly (SandboxFacts & { readonly hostId: string; readonly freshness: string; readonly identity: string })[]; readonly warn: boolean; readonly truncated: boolean }> {
    this.#owner(by, "read the sandbox of the hosts");
    const hosts = await this.#d.hosts(by);
    const rows = hosts.slice(0, ADMIN_LIMITS.hosts).map((h) => ({ hostId: h.hostId, freshness: h.freshness, identity: h.identity, ...sandboxFor(h.os) }));
    const local = this.#d.localOs === undefined ? undefined : sandboxFor(this.#d.localOs);
    return { ...(local === undefined ? {} : { local }), hosts: rows, warn: (local?.warn ?? false) || rows.some((r) => r.warn), truncated: hosts.length > ADMIN_LIMITS.hosts };
  }

  /**
   * Whether the runtimes in use are ones this version supports (Node.js, the worker protocol of each host) and what waits in the database, with the agents and operations each finding touches. A source that cannot be read
   * is named in `problems` and leaves its part out; the rest still shows.
   */
  async compatibility(by: Principal): Promise<CompatView & { readonly problems: readonly string[] }> {
    this.#owner(by, "read the compatibility status");
    const c = this.#d.compat;
    if (c === undefined) throw new DomainError("unavailable", "this controller does not read its compatibility status");
    const problems: string[] = [];
    const read = async <T>(what: string, run: () => Promise<T>, fallback: T): Promise<T> => { try { return await run(); } catch (e) { problems.push(`${what}: ${redactText(String((e as Error)?.message ?? e)).slice(0, 200)}`); return fallback; } };
    const hosts = await read("the hosts", () => c.hostRuntimes(by), []);
    const work = await read("the agents' work", () => c.agentWork(by), []);
    const migration = await read("the migrations", () => c.migration(by), undefined);
    return { ...compatibility({ node: c.nodeVersion, hosts, work, ...(migration === undefined ? {} : { migration }) }), problems };
  }
}
