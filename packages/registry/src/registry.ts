// The protected registry facade (card F07): who may register which tool or extension name, immutable versioned artifacts,
// revocation, and pinned selection that a paused attempt restores or is blocked by.
//
// Three capabilities come out of `createRegistry`, and each is a frozen object of closures (no `this`, no shared prototype to
// reach another capability through):
//   - `trusted`   the controller's: allocates agent ids, publishes into any namespace, seals the protected namespace, revokes.
//   - `forAgent`  one agent's: may publish only into its own `a_<id>` namespace. Reserved and other agents' names are refused.
//   - `read`      read-only: resolves names, pins and restores selections, verifies the reserved set.
// Hand a personal environment only `forAgent(id)` and `read`. Code that shares a process with the registry could still tamper with
// the process itself; this is a facade that makes honest mistakes and unauthorised registration impossible, not an isolation
// boundary. Services must still authorise every execution (runtime-compatibility-and-namespaces.md).
//
// Revoking the latest version makes the previous live version the default for anything that resolves afresh; an attempt that
// pinned the revoked version is blocked instead (see `restore`).
//
// Rules: a name is never replaced (no last-installed-wins); a published (name, version) is immutable, and republishing the same
// bytes is a no-op while different bytes are refused; versions only increase; revocation is permanent; a pin is restored exactly
// or reported as blocked, never silently replaced by another version.
import { createHash } from "node:crypto";
import { canonicalFromWire, isAgentId, parseName, wireName, type Layer } from "./names.js";

export type RegistryErrorCode =
  | "invalid_name" | "invalid_version" | "invalid_digest" | "invalid_input"
  | "reserved_namespace" | "foreign_namespace" | "unknown_agent" | "retired_agent" | "agent_exists"
  | "version_exists" | "not_increasing" | "sealed" | "unknown_entry" | "unknown_version" | "no_version" | "revoked";

export class RegistryError extends Error {
  readonly code: RegistryErrorCode;
  constructor(code: RegistryErrorCode, message: string) {
    super(message);
    this.name = "RegistryError";
    this.code = code;
  }
}

/** Shown in errors in place of input that is untrusted, long or not text. */
const shown = (value: unknown): string => (typeof value === "string" ? JSON.stringify(value.length > 48 ? `${value.slice(0, 48)}…` : value) : `a ${typeof value} value`);

const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const DIGEST = /^[0-9a-f]{64}$/;
const compareVersions = (a: string, b: string): number => {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] as number) < (y[i] as number) ? -1 : 1;
  return 0;
};

/** A published artifact version: its content digest is what makes it immutable and what a pin must still match. */
export interface Artifact {
  readonly version: string;
  readonly digest: string;
}
export interface Selection {
  readonly canonical: string;
  readonly wireName: string;
  readonly layer: Layer;
  readonly version: string;
  readonly digest: string;
}
export interface Pin {
  readonly canonical: string;
  readonly version: string;
  readonly digest: string;
}
export interface PinSet {
  readonly schema: 1;
  readonly pins: readonly Pin[];
  /**
   * SHA-256 over the pins. It detects an accidental change or an inconsistent set; it is not a signature. Whoever can write the stored
   * pin set can recompute it, and so can select another registered, non-revoked version (never other content: a restored selection
   * always carries the registered digest). Keep stored pin sets writable by the controller only.
   */
  readonly digest: string;
}
export type BlockCode = "invalid_pin_set" | "missing" | "revoked" | "digest_mismatch";
export type RestoreResult =
  | { readonly status: "restored"; readonly selections: readonly Selection[] }
  | { readonly status: "blocked"; readonly reasons: readonly { readonly code: BlockCode; readonly canonical: string; readonly version: string; readonly detail: string }[] };
export interface ReservedProblem {
  readonly code: "missing" | "unexpected" | "digest_mismatch" | "revoked";
  readonly canonical: string;
  readonly detail: string;
}

/** The registry's history, replayed through the same rules to rebuild it, so a stored snapshot cannot say what a call could not. */
export type Operation =
  | { readonly op: "allocate"; readonly agentId: string }
  | { readonly op: "retire"; readonly agentId: string }
  | { readonly op: "publish"; readonly canonical: string; readonly version: string; readonly digest: string }
  | { readonly op: "revoke"; readonly canonical: string; readonly version: string; readonly reason: string }
  | { readonly op: "seal" };

export interface TrustedRegistrar {
  allocateAgent(agentId: string): void;
  /** The id and its `a_<id>` prefix are never allocated again. */
  retireAgent(agentId: string): void;
  publish(canonical: string, artifact: Artifact): "added" | "unchanged";
  /** After this, nothing new can be published under `nimblenewt.` (revocation still works). */
  sealProtected(): void;
  revoke(canonical: string, version: string, reason: string): void;
  snapshot(): readonly Operation[];
}
export interface AgentRegistrar {
  readonly agentId: string;
  publish(canonical: string, artifact: Artifact): "added" | "unchanged";
}
export interface RegistryView {
  has(canonical: string): boolean;
  /** The highest version that is not revoked, or exactly `version` when one is asked for. */
  resolve(canonical: string, version?: string): Selection;
  /** What a model's tool call named on the wire, or null when it is not a registered name. */
  fromWire(wire: string): string | null;
  list(): readonly Selection[];
  pin(canonicals: readonly string[]): PinSet;
  restore(pinSet: unknown): RestoreResult;
  /** Compare the protected namespace with the digests the controller expects. Empty means intact. */
  verifyReserved(expected: Readonly<Record<string, string>>): readonly ReservedProblem[];
}
export interface Registry {
  readonly trusted: TrustedRegistrar;
  forAgent(agentId: string): AgentRegistrar;
  readonly read: RegistryView;
}

interface Entry {
  readonly layer: Layer;
  readonly versions: Map<string, string>; // version -> digest, in increasing order
  latest: string;
  readonly revoked: Set<string>;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const pinDigest = (pins: readonly Pin[]): string => sha256(JSON.stringify(pins.map((p) => [p.canonical, p.version, p.digest])));

export function createRegistry(history: readonly Operation[] = []): Registry {
  const entries = new Map<string, Entry>();
  const wires = new Map<string, string>();
  const agents = new Set<string>();
  const retired = new Set<string>();
  const log: Operation[] = [];
  let protectedSealed = false;

  const nameOf = (canonical: unknown) => {
    const parsed = parseName(canonical);
    if (parsed === null) throw new RegistryError("invalid_name", `${shown(canonical)} is not a canonical name (lower-case \`<namespace>.<name>\`)`);
    return parsed;
  };
  const checkArtifact = (artifact: unknown): Artifact => {
    if (artifact === null || typeof artifact !== "object") throw new RegistryError("invalid_input", "an artifact is an object with a version and a digest");
    const { version, digest } = artifact as { version?: unknown; digest?: unknown };
    if (typeof version !== "string" || !VERSION.test(version)) throw new RegistryError("invalid_version", `${shown(version)} is not a version of the form major.minor.patch`);
    if (typeof digest !== "string" || !DIGEST.test(digest)) throw new RegistryError("invalid_digest", "a digest is 64 lower-case hexadecimal characters (SHA-256)");
    return { version, digest };
  };
  const selection = (canonical: string, entry: Entry, version: string): Selection =>
    Object.freeze({ canonical, wireName: wireName(canonical), layer: entry.layer, version, digest: entry.versions.get(version) as string });

  /** The one place a version is added; every capability and the history replay go through it. */
  const add = (canonical: string, artifact: Artifact): "added" | "unchanged" => {
    const parsed = nameOf(canonical);
    const existing = entries.get(canonical);
    if (existing?.versions.get(artifact.version) !== undefined) {
      if (existing.versions.get(artifact.version) === artifact.digest) return "unchanged";
      throw new RegistryError("version_exists", `${canonical} ${artifact.version} is already published with different content; versions are immutable, publish a new one`);
    }
    if (parsed.layer === "protected" && protectedSealed) throw new RegistryError("sealed", `the protected namespace is sealed; ${canonical} cannot be added`);
    if (parsed.layer === "agent") {
      if (retired.has(parsed.agentId as string)) throw new RegistryError("retired_agent", `agent ${parsed.agentId} is retired`);
      if (!agents.has(parsed.agentId as string)) throw new RegistryError("unknown_agent", `agent ${parsed.agentId} has no allocated namespace`);
    }
    if (existing !== undefined && compareVersions(artifact.version, existing.latest) < 0) {
      throw new RegistryError("not_increasing", `${canonical} ${artifact.version} is lower than its latest version ${existing.latest}; versions only increase`);
    }
    // An injective wire mapping makes a collision impossible for valid names; the check keeps that true if the scheme ever changes.
    const wire = wireName(canonical);
    const holder = wires.get(wire);
    if (holder !== undefined && holder !== canonical) throw new RegistryError("invalid_name", `${canonical} collides with ${holder} on the wire`);
    wires.set(wire, canonical);
    if (existing === undefined) entries.set(canonical, { layer: parsed.layer, versions: new Map([[artifact.version, artifact.digest]]), latest: artifact.version, revoked: new Set() });
    else {
      existing.versions.set(artifact.version, artifact.digest);
      existing.latest = artifact.version;
    }
    log.push(Object.freeze({ op: "publish", canonical, version: artifact.version, digest: artifact.digest }));
    return "added";
  };

  const trusted: TrustedRegistrar = Object.freeze({
    allocateAgent(agentId: string): void {
      if (!isAgentId(agentId)) throw new RegistryError("invalid_input", `${shown(agentId)} is not an agent id (6 to 32 lower-case letters or digits)`);
      if (retired.has(agentId)) throw new RegistryError("retired_agent", `agent ${agentId} is retired; ids are never reused`);
      if (agents.has(agentId)) throw new RegistryError("agent_exists", `agent ${agentId} already has its namespace`);
      agents.add(agentId);
      log.push(Object.freeze({ op: "allocate", agentId }));
    },
    retireAgent(agentId: string): void {
      if (!isAgentId(agentId) || !agents.has(agentId)) throw new RegistryError("unknown_agent", `agent ${shown(agentId)} has no allocated namespace`);
      agents.delete(agentId);
      retired.add(agentId);
      log.push(Object.freeze({ op: "retire", agentId }));
    },
    publish: (canonical: string, artifact: Artifact) => add(canonical, checkArtifact(artifact)),
    sealProtected(): void {
      if (!protectedSealed) log.push(Object.freeze({ op: "seal" }));
      protectedSealed = true;
    },
    revoke(canonical: string, version: string, reason: string): void {
      nameOf(canonical);
      const entry = entries.get(canonical);
      if (entry === undefined) throw new RegistryError("unknown_entry", `${canonical} is not registered`);
      if (typeof version !== "string" || !entry.versions.has(version)) throw new RegistryError("unknown_version", `${canonical} has no version ${shown(version)}`);
      if (typeof reason !== "string" || reason.length === 0 || reason.length > 200) throw new RegistryError("invalid_input", "a revocation needs a reason of 1 to 200 characters");
      if (entry.revoked.has(version)) return;
      entry.revoked.add(version);
      log.push(Object.freeze({ op: "revoke", canonical, version, reason }));
    },
    snapshot: () => Object.freeze([...log]),
  });

  const find = (canonical: string): Entry => {
    nameOf(canonical);
    const entry = entries.get(canonical);
    if (entry === undefined) throw new RegistryError("unknown_entry", `${canonical} is not registered`);
    return entry;
  };
  const resolve = (canonical: string, version?: string): Selection => {
    const entry = find(canonical);
    if (version !== undefined) {
      if (typeof version !== "string" || !entry.versions.has(version)) throw new RegistryError("unknown_version", `${canonical} has no version ${shown(version)}`);
      if (entry.revoked.has(version)) throw new RegistryError("revoked", `${canonical} ${version} is revoked`);
      return selection(canonical, entry, version);
    }
    const live = [...entry.versions.keys()].filter((v) => !entry.revoked.has(v));
    const best = live[live.length - 1]; // insertion order is increasing order
    if (best === undefined) throw new RegistryError("no_version", `every version of ${canonical} is revoked`);
    return selection(canonical, entry, best);
  };

  const read: RegistryView = Object.freeze({
    has: (canonical: string) => typeof canonical === "string" && entries.has(canonical),
    resolve,
    fromWire(wire: string): string | null {
      const canonical = canonicalFromWire(wire);
      return canonical !== null && entries.has(canonical) ? canonical : null;
    },
    list: () => Object.freeze([...entries.keys()].sort().flatMap((canonical) => {
      try { return [resolve(canonical)]; } catch { return []; } // a name whose every version is revoked is not offered
    })),
    pin(canonicals: readonly string[]): PinSet {
      if (!Array.isArray(canonicals) || canonicals.length > 1000) throw new RegistryError("invalid_input", "pin takes a list of at most 1000 canonical names");
      const pins = [...new Set(canonicals)].sort().map((canonical) => {
        const s = resolve(canonical);
        return Object.freeze({ canonical: s.canonical, version: s.version, digest: s.digest });
      });
      return Object.freeze({ schema: 1 as const, pins: Object.freeze(pins), digest: pinDigest(pins) });
    },
    restore(pinSet: unknown): RestoreResult {
      const invalid = (detail: string): RestoreResult => Object.freeze({ status: "blocked" as const, reasons: Object.freeze([Object.freeze({ code: "invalid_pin_set" as const, canonical: "", version: "", detail })]) });
      if (pinSet === null || typeof pinSet !== "object") return invalid("the pin set is not an object");
      const { schema, pins, digest } = pinSet as { schema?: unknown; pins?: unknown; digest?: unknown };
      if (schema !== 1) return invalid("unsupported pin set schema");
      if (!Array.isArray(pins) || pins.length > 1000) return invalid("the pins are not a list of at most 1000");
      const clean: Pin[] = [];
      for (const raw of pins) {
        const p = raw as { canonical?: unknown; version?: unknown; digest?: unknown } | null;
        if (p === null || typeof p !== "object" || parseName(p.canonical) === null || typeof p.version !== "string" || !VERSION.test(p.version) || typeof p.digest !== "string" || !DIGEST.test(p.digest)) return invalid("a pin is malformed");
        clean.push({ canonical: p.canonical as string, version: p.version, digest: p.digest });
      }
      if (typeof digest !== "string" || digest !== pinDigest(clean)) return invalid("the pin set is inconsistent (changed after it was written, by accident or otherwise)");
      const reasons: { code: BlockCode; canonical: string; version: string; detail: string }[] = [];
      const selections: Selection[] = [];
      for (const pin of clean) {
        const entry = entries.get(pin.canonical);
        const recorded = entry?.versions.get(pin.version);
        if (entry === undefined || recorded === undefined) reasons.push({ code: "missing", canonical: pin.canonical, version: pin.version, detail: "the pinned version is not available" });
        else if (recorded !== pin.digest) reasons.push({ code: "digest_mismatch", canonical: pin.canonical, version: pin.version, detail: "the registered content differs from what was pinned" });
        else if (entry.revoked.has(pin.version)) reasons.push({ code: "revoked", canonical: pin.canonical, version: pin.version, detail: "the pinned version was revoked" });
        else selections.push(selection(pin.canonical, entry, pin.version));
      }
      return reasons.length > 0
        ? Object.freeze({ status: "blocked" as const, reasons: Object.freeze(reasons.map((r) => Object.freeze(r))) })
        : Object.freeze({ status: "restored" as const, selections: Object.freeze(selections) });
    },
    verifyReserved(expected: Readonly<Record<string, string>>): readonly ReservedProblem[] {
      const problems: ReservedProblem[] = [];
      const wanted = new Map(Object.entries(expected));
      for (const [canonical, digest] of wanted) {
        if (parseName(canonical)?.layer !== "protected") { problems.push({ canonical, code: "unexpected", detail: "not a protected name" }); continue; }
        const entry = entries.get(canonical);
        if (entry === undefined) { problems.push({ canonical, code: "missing", detail: "not registered" }); continue; }
        if (entry.versions.get(entry.latest) !== digest) problems.push({ canonical, code: "digest_mismatch", detail: `latest version ${entry.latest} differs from the expected content` });
        else if (entry.revoked.has(entry.latest)) problems.push({ canonical, code: "revoked", detail: `${entry.latest} is revoked` });
      }
      for (const [canonical, entry] of entries) if (entry.layer === "protected" && !wanted.has(canonical)) problems.push({ canonical, code: "unexpected", detail: "registered but not expected" });
      return Object.freeze(problems.sort((a, b) => a.canonical.localeCompare(b.canonical)).map((p) => Object.freeze(p)));
    },
  });

  const forAgent = (agentId: string): AgentRegistrar => {
    if (!isAgentId(agentId)) throw new RegistryError("invalid_input", `${shown(agentId)} is not an agent id`);
    if (retired.has(agentId)) throw new RegistryError("retired_agent", `agent ${agentId} is retired`);
    if (!agents.has(agentId)) throw new RegistryError("unknown_agent", `agent ${agentId} has no allocated namespace`);
    return Object.freeze({
      agentId,
      publish(canonical: string, artifact: Artifact): "added" | "unchanged" {
        const parsed = nameOf(canonical);
        if (parsed.layer !== "agent") throw new RegistryError("reserved_namespace", `${parsed.namespace} is reserved; a personal extension cannot register ${canonical}`);
        if (parsed.agentId !== agentId) throw new RegistryError("foreign_namespace", `${canonical} belongs to another agent`);
        if (retired.has(agentId)) throw new RegistryError("retired_agent", `agent ${agentId} is retired`);
        return add(canonical, checkArtifact(artifact));
      },
    });
  };

  // Rebuild from a history through the same rules; a history that breaks them throws and nothing is returned.
  const registry: Registry = Object.freeze({ trusted, forAgent, read });
  for (const operation of history) {
    const o = operation as Operation;
    if (o?.op === "allocate") trusted.allocateAgent(o.agentId);
    else if (o?.op === "retire") trusted.retireAgent(o.agentId);
    else if (o?.op === "publish") trusted.publish(o.canonical, { version: o.version, digest: o.digest });
    else if (o?.op === "revoke") trusted.revoke(o.canonical, o.version, o.reason);
    else if (o?.op === "seal") trusted.sealProtected();
    else throw new RegistryError("invalid_input", "the history contains an unknown operation");
  }
  return registry;
}
