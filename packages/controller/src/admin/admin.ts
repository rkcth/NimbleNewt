import { DomainError } from "../domain/errors.js";
import { onlyKnown } from "../domain/model.js";
import type { ConfigurationService } from "../configuration/index.js";
import { sandboxFor, type SandboxFacts } from "../environment/sandbox.js";
import type { Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { ProviderEndpointBody } from "../setup/index.js";

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
      const shown = r === undefined ? undefined : clipped ? text!.slice(0, ADMIN_LIMITS.value) : typeof r.value === "string" ? redactText(r.value) : r.value;
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

  /** The sandbox each host uses to confine agents, and a warning where its boundary is weaker than the strongest one (macOS Seatbelt is process-level; decision G01). */
  async sandbox(by: Principal): Promise<{ readonly local?: SandboxFacts; readonly hosts: readonly (SandboxFacts & { readonly hostId: string; readonly freshness: string; readonly identity: string })[]; readonly warn: boolean; readonly truncated: boolean }> {
    this.#owner(by, "read the sandbox of the hosts");
    const hosts = await this.#d.hosts(by);
    const rows = hosts.slice(0, ADMIN_LIMITS.hosts).map((h) => ({ hostId: h.hostId, freshness: h.freshness, identity: h.identity, ...sandboxFor(h.os) }));
    const local = this.#d.localOs === undefined ? undefined : sandboxFor(this.#d.localOs);
    return { ...(local === undefined ? {} : { local }), hosts: rows, warn: (local?.warn ?? false) || rows.some((r) => r.warn), truncated: hosts.length > ADMIN_LIMITS.hosts };
  }
}
