// Canonical names and the provider-safe wire names derived from them (docs/nimblenewt/runtime-compatibility-and-namespaces.md).
//
// A canonical name is `<namespace>.<name>`. The namespace says who owns it: `nimblenewt` (protected, registered by the trusted
// controller), `toolbox` (shared, published through a scoped permission) or `a_<id>` (one agent, by its immutable
// computer-assigned id). The grammar is lower-case ASCII only and input is rejected, never normalised, so two spellings can
// never be one name. Names are not a security boundary; the registry facade and the services that execute a tool enforce who may
// register and call what.

export const PROTECTED_NAMESPACE = "nimblenewt";
export const TOOLBOX_NAMESPACE = "toolbox";
/** Prefixes that no personal registrar can ever claim, besides every other agent's own `a_<id>`. */
export const RESERVED_NAMESPACES: readonly string[] = Object.freeze([PROTECTED_NAMESPACE, TOOLBOX_NAMESPACE]);

const AGENT_ID = /^[a-z0-9]{6,32}$/;
const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 28;
/** Most model providers accept `[A-Za-z0-9_-]` up to 64 characters; the longest valid name (a_ + 32 + __ + 28) fits exactly. */
export const MAX_WIRE_LENGTH = 64;

export type Layer = "protected" | "toolbox" | "agent";

export interface ParsedName {
  readonly canonical: string;
  readonly namespace: string;
  readonly name: string;
  readonly layer: Layer;
  /** The owning agent's id for the `agent` layer, otherwise null. */
  readonly agentId: string | null;
}

export const isAgentId = (value: unknown): value is string => typeof value === "string" && AGENT_ID.test(value);
export const agentNamespace = (agentId: string): string => `a_${agentId}`;

/** Splits a canonical name, or returns null when it is not exactly in the grammar. Never throws, whatever the input. */
export function parseName(value: unknown): ParsedName | null {
  if (typeof value !== "string" || value.length > 128) return null;
  const dot = value.indexOf(".");
  if (dot < 1) return null;
  const namespace = value.slice(0, dot);
  const name = value.slice(dot + 1);
  if (name.length === 0 || name.length > MAX_NAME_LENGTH || !NAME.test(name)) return null;
  if (namespace === PROTECTED_NAMESPACE) return { canonical: value, namespace, name, layer: "protected", agentId: null };
  if (namespace === TOOLBOX_NAMESPACE) return { canonical: value, namespace, name, layer: "toolbox", agentId: null };
  if (namespace.startsWith("a_") && AGENT_ID.test(namespace.slice(2))) return { canonical: value, namespace, name, layer: "agent", agentId: namespace.slice(2) };
  return null;
}

/**
 * The name sent to a model provider: `<namespace>__<name>`. Names contain no underscore and namespaces contain at most one, so the
 * first `__` is the only separator and the mapping cannot merge two canonical names (nothing is replaced or dropped).
 */
export function wireName(canonical: string): string {
  const parsed = parseName(canonical);
  if (parsed === null) throw new RangeError("not a canonical name");
  return `${parsed.namespace}__${parsed.name}`;
}

/** The canonical name of a wire name, or null if it is not one this scheme produces. */
export function canonicalFromWire(wire: unknown): string | null {
  if (typeof wire !== "string") return null;
  const at = wire.indexOf("__");
  if (at < 1) return null;
  const parsed = parseName(`${wire.slice(0, at)}.${wire.slice(at + 2)}`);
  return parsed !== null && wireName(parsed.canonical) === wire ? parsed.canonical : null;
}
