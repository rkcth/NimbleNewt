import { createHash } from "node:crypto";
import { isAgentId, parseName, type Layer } from "@nimblenewt/registry";
import type { CatalogService } from "../catalog/index.js";
import type { Principal } from "../security/principals.js";
import { canonicalJson } from "../storage/json.js";

/**
 * Typed commands (card T09): `/nimblenewt.<name>`, `/toolbox.<name>`, `/a_<id>.<name>` and the two optional aliases `/agent.<name>` (for the agent selected in the context) and `/custom.<name>` (for an alias the owner
 * defined in an explicit scope). Resolution happens before anything is queued and gives the canonical name and the exact version; what is queued is that target, never the shortcut, so switching the agent in a screen
 * cannot change what waiting work means. A typed command, a button in the UI and a model's tool call (by its wire name) end in the same target. Names are not a security boundary: whoever executes the target checks
 * who may run it.
 */

export const COMMAND_ALIASES = ["agent", "custom"] as const;
const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_TYPED = 256;

export interface Invocation {
  /** `nimblenewt`, `toolbox`, `a_<id>`, or an alias word. */
  readonly namespace: string;
  readonly name: string;
  /** Everything after the command word, unchanged. */
  readonly rest: string;
}

/** Splits `/<namespace>.<name> rest`. Anything outside the lower-case ASCII grammar (case, encoding, Unicode look-alikes, a missing dot) is not a command; nothing is normalised. */
export function parseInvocation(text: unknown): Invocation | undefined {
  if (typeof text !== "string" || text.length < 4 || text.length > MAX_TYPED * 64 || !text.startsWith("/")) return undefined;
  const space = text.search(/\s/);
  const word = space < 0 ? text.slice(1) : text.slice(1, space);
  if (word.length > MAX_TYPED) return undefined;
  const dot = word.indexOf(".");
  if (dot < 1) return undefined;
  const namespace = word.slice(0, dot), name = word.slice(dot + 1);
  if (name.length === 0 || name.length > 28 || !NAME.test(name)) return undefined;
  const known = namespace === "nimblenewt" || namespace === "toolbox" || (COMMAND_ALIASES as readonly string[]).includes(namespace) || (namespace.startsWith("a_") && isAgentId(namespace.slice(2)));
  if (!known) return undefined;
  return { namespace, name, rest: space < 0 ? "" : text.slice(space).trim() };
}

/** What a command resolves to: the identity of the operation, the schema it takes, who owns it, which exact implementation, and the label to show, all separate. */
export interface Target {
  /** The stable operation identity: the canonical name. It never changes when a label, an alias or an agent's friendly name does. */
  readonly operationId: string;
  readonly layer: Layer;
  /** The implementation revision the work will run: the exact version and its digest. */
  readonly version: string;
  readonly digest: string;
  /** A digest of the input schema this version takes, so queued input is checked against the schema it was written for. */
  readonly schemaDigest: string;
  /** The agent's immutable ID, `toolbox`, or `controller`. */
  readonly ownerId: string;
  /** For people only: it never decides what runs. */
  readonly displayName: string;
}

export type Resolution =
  | { readonly status: "resolved"; readonly typed: string; readonly target: Target; readonly rest: string }
  /** An alias that fits more than one command: nothing is picked; `asks` says what to supply. */
  | { readonly status: "ambiguous"; readonly typed: string; readonly candidates: readonly string[]; readonly asks: string }
  /** An alias that needs a context it was not given (the selected agent, or the scope). */
  | { readonly status: "needs_context"; readonly typed: string; readonly needs: "agent" | "scope"; readonly candidates: readonly string[]; readonly asks: string }
  | { readonly status: "unknown"; readonly typed: string; readonly reason: string }
  | { readonly status: "refused"; readonly typed: string; readonly reason: string };

export interface CommandContext {
  /** The agent the screen or the conversation is explicitly bound to (its immutable ID, not a friendly name). */
  readonly agent?: string;
  /** The explicit scope `/custom.` names are looked up in (for example `project:proj-…`). */
  readonly scope?: string;
  /** A particular version; otherwise the latest live one. */
  readonly version?: string;
}

/** What resolution reads. The catalog gives it, already limited to what the caller may see. */
export interface CommandSource {
  names(by: Principal): Promise<readonly { readonly name: string; readonly layer: Layer; readonly latest: string }[]>;
  version(by: Principal, name: string, version?: string): Promise<{ readonly name: string; readonly layer: Layer; readonly version: string; readonly digest: string; readonly schemaDigest: string; readonly revoked: boolean } | undefined>;
}

export const catalogSource = (catalog: Pick<CatalogService, "list" | "get">): CommandSource => ({
  names: async (by) => (await catalog.list(by)).map((e) => ({ name: e.name, layer: e.layer, latest: e.latest })),
  version: async (by, name, version) => {
    const found = await catalog.get(by, name, version);
    if (found === undefined) return undefined;
    const b = found;
    return { name: b.name, layer: b.layer, version: b.version, digest: b.digest, schemaDigest: createHash("sha256").update(canonicalJson(b.manifest.input)).digest("hex").slice(0, 32), revoked: found.revoked !== undefined };
  },
});

export type AliasLookup = (scope: string, alias: string) => Promise<string | undefined>;

const SCOPE = /^[a-z0-9][a-z0-9:_.-]{0,63}$/;
export const isScope = (value: unknown): value is string => typeof value === "string" && SCOPE.test(value);

export class CommandResolver {
  readonly #source: CommandSource;
  readonly #aliases: AliasLookup;

  constructor(source: CommandSource, aliases: AliasLookup = async () => undefined) { this.#source = source; this.#aliases = aliases; }

  /** Resolves what was typed. Never throws for bad input: a refusal says why. */
  async resolve(by: Principal, typed: string, context: CommandContext = {}): Promise<Resolution> {
    const shown = typeof typed === "string" ? typed.slice(0, 80) : "";
    const inv = parseInvocation(typed);
    if (inv === undefined) return { status: "refused", typed: shown, reason: "not a command: use /<namespace>.<name> in lower-case letters, digits and single hyphens" };
    if (inv.namespace === "agent") return this.#agentAlias(by, shown, inv, context);
    if (inv.namespace === "custom") return this.#customAlias(by, shown, inv, context);
    return this.#canonical(by, shown, `${inv.namespace}.${inv.name}`, inv.rest, context.version);
  }

  /** A model's tool call by the name the provider saw (`<namespace>__<name>`) resolves to the same target as the typed command. */
  async resolveWire(by: Principal, wire: string, context: CommandContext = {}): Promise<Resolution> {
    const at = typeof wire === "string" ? wire.indexOf("__") : -1;
    const canonical = at < 1 ? undefined : parseName(`${wire.slice(0, at)}.${wire.slice(at + 2)}`)?.canonical;
    if (canonical === undefined) return { status: "refused", typed: String(wire).slice(0, 80), reason: "not a name this system gave a model" };
    return this.#canonical(by, String(wire).slice(0, 80), canonical, "", context.version);
  }

  /** A UI action names the canonical operation it performs; it takes the same path as the typed command. */
  async resolveAction(by: Principal, canonical: string, context: CommandContext = {}): Promise<Resolution> {
    const parsed = parseName(canonical);
    if (parsed === null) return { status: "refused", typed: String(canonical).slice(0, 80), reason: "not a canonical command name" };
    return this.#canonical(by, parsed.canonical, parsed.canonical, "", context.version);
  }

  async #canonical(by: Principal, typed: string, canonical: string, rest: string, version: string | undefined): Promise<Resolution> {
    const parsed = parseName(canonical);
    if (parsed === null) return { status: "refused", typed, reason: "not a canonical command name" };
    const found = await this.#source.version(by, parsed.canonical, version);
    if (found === undefined || found.revoked) return { status: "unknown", typed, reason: `no command ${parsed.canonical} that you can use` };
    // The namespace decides the layer. Something filed under a protected or shared name by anyone else is never run as one.
    if (found.layer !== parsed.layer) return { status: "refused", typed, reason: `${parsed.canonical} is not registered in its own namespace` };
    const ownerId = parsed.layer === "agent" ? parsed.agentId! : parsed.layer === "toolbox" ? "toolbox" : "controller";
    return { status: "resolved", typed, rest, target: { operationId: parsed.canonical, layer: parsed.layer, version: found.version, digest: found.digest, schemaDigest: found.schemaDigest, ownerId, displayName: parsed.name } };
  }

  async #agentAlias(by: Principal, typed: string, inv: Invocation, context: CommandContext): Promise<Resolution> {
    if (context.agent !== undefined) {
      if (!isAgentId(context.agent)) return { status: "refused", typed, reason: "the selected agent must be given by its immutable ID" };
      return this.#canonical(by, typed, `a_${context.agent}.${inv.name}`, inv.rest, context.version);
    }
    // No agent is selected: nothing is picked, even when only one agent has the command, because the shortcut would then mean whoever happens to be the only one today.
    const candidates = (await this.#source.names(by)).filter((e) => e.layer === "agent" && e.name.endsWith(`.${inv.name}`)).map((e) => e.name).sort();
    if (candidates.length === 0) return { status: "unknown", typed, reason: `no agent has a command ${inv.name} that you can use` };
    const asks = "select the agent, or give the full /a_<id>." + inv.name;
    return candidates.length === 1 ? { status: "needs_context", typed, needs: "agent", candidates, asks } : { status: "ambiguous", typed, candidates, asks };
  }

  async #customAlias(by: Principal, typed: string, inv: Invocation, context: CommandContext): Promise<Resolution> {
    if (context.scope === undefined) return { status: "needs_context", typed, needs: "scope", candidates: [], asks: "give the scope the custom command belongs to" };
    if (!isScope(context.scope)) return { status: "refused", typed, reason: "the scope is not valid" };
    const canonical = await this.#aliases(context.scope, inv.name);
    if (canonical === undefined) return { status: "unknown", typed, reason: `no custom command ${inv.name} in that scope` };
    const resolved = await this.#canonical(by, typed, canonical, inv.rest, context.version);
    // A target the caller cannot see answers like an alias that does not exist, so it reveals neither the alias nor whose command it names.
    return resolved.status === "unknown" ? { status: "unknown", typed, reason: `no custom command ${inv.name} in that scope` } : resolved;
  }
}
