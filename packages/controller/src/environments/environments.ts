import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, revision as checkRevision, text } from "../domain/model.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { allows } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import { canonicalJson } from "../storage/json.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";

/** What an agent's environment is made of (card A08). Everything here is a name, a version or a digest: no secret and no path an agent could choose. */
export interface EnvironmentManifest {
  /** The common, maintained base every environment starts from. */
  readonly base: { readonly name: string; readonly version: string; readonly digest: string };
  /** The agent's own package area. */
  readonly packages: readonly { readonly name: string; readonly version: string; readonly digest: string }[];
  /** Catalog versions (T01) installed in the agent's skill library. */
  readonly skills: readonly string[];
  /** The capabilities the owner approved for this environment (action names). */
  readonly capabilities: readonly string[];
  /** The configuration revision in force at each layer when the environment was made. */
  readonly configuration: Readonly<Record<string, number>>;
  readonly limits: { readonly cpus: number; readonly memoryMb: number; readonly diskMb: number; readonly processes: number };
  /** Controller-owned extensions loaded at worker start, with the digest each must have. They must match the system versions in the catalog. */
  readonly protectedExtensions: readonly { readonly name: string; readonly digest: string }[];
}

export interface RevisionBody {
  readonly agentId: string;
  readonly revision: number;
  readonly manifest: EnvironmentManifest;
  /** A digest over the manifest: the identity of this revision. */
  readonly digest: string;
  readonly reason: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly rollbackOf?: number;
}
export interface EnvironmentBody { readonly agentId: string; readonly latest: number; readonly active?: number }
export interface PinBody { readonly attemptId: string; readonly agentId: string; readonly kind: "attempt" | "checkpoint"; readonly revision: number; readonly digest: string; readonly at: string }

/** What the host can give, and what the controller keeps back for itself. */
export interface HostCapacity { readonly cpus: number; readonly memoryMb: number; readonly diskMb: number; readonly processes: number; readonly reserveFraction?: number }

export const ENV_LIMITS = { packages: 200, skills: 100, capabilities: 100, protectedExtensions: 20, configLayers: 10, revisions: 500, reason: 500 } as const;
const NAME = /^[a-z][a-z0-9._-]{0,79}$/;
const VERSION = /^[0-9A-Za-z.+-]{1,40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ACTION = /^(?:\*|[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*(?:\.\*)?)$/;
const CAV = /^cav-[a-z2-7]{20}$/;
const AGENT = /^agent:[a-z0-9][a-z0-9-]{0,39}$/;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const sha = (v: string): string => createHash("sha256").update(v).digest("hex");

/** Checks and normalises a manifest, naming the field of every problem. */
export function checkEnvironmentManifest(value: unknown, capacity?: HostCapacity): EnvironmentManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid("manifest", "must be an object");
  const m = value as Record<string, unknown>;
  onlyKnown(m, ["base", "packages", "skills", "capabilities", "configuration", "limits", "protectedExtensions"]);
  const ref = (v: unknown, field: string, digestRequired: boolean): { name: string; version: string; digest: string } => {
    const x = v as { name?: unknown; version?: unknown; digest?: unknown };
    if (typeof v !== "object" || v === null || typeof x.name !== "string" || !NAME.test(x.name) || typeof x.version !== "string" || !VERSION.test(x.version) || typeof x.digest !== "string" || (digestRequired && !DIGEST.test(x.digest))) return invalid(field, "needs a name, an exact version and a sha256 digest");
    return { name: x.name, version: x.version, digest: x.digest };
  };
  const list = (v: unknown, field: string, max: number): unknown[] => (Array.isArray(v) && v.length <= max ? v : invalid(field, `must be a list of at most ${max}`));
  const base = ref(m["base"], "manifest.base", true);
  const packages = list(m["packages"] ?? [], "manifest.packages", ENV_LIMITS.packages).map((p, i) => ref(p, `manifest.packages[${i}]`, true));
  if (new Set(packages.map((p) => p.name)).size !== packages.length) invalid("manifest.packages", "lists a package twice");
  const skills = list(m["skills"] ?? [], "manifest.skills", ENV_LIMITS.skills).map((s, i) => (typeof s === "string" && CAV.test(s) ? s : invalid(`manifest.skills[${i}]`, "must be a catalog version ID")));
  const capabilities = list(m["capabilities"] ?? [], "manifest.capabilities", ENV_LIMITS.capabilities).map((a, i) => (typeof a === "string" && ACTION.test(a) ? a : invalid(`manifest.capabilities[${i}]`, "must be an action name")));
  const configuration: Record<string, number> = {};
  const cfg = (m["configuration"] ?? {}) as Record<string, unknown>;
  if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg) || Object.keys(cfg).length > ENV_LIMITS.configLayers) invalid("manifest.configuration", "must map layers to revisions");
  for (const [k, v] of Object.entries(cfg)) configuration[NAME.test(k) ? k : invalid("manifest.configuration", `${k} is not a layer name`)] = typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : invalid(`manifest.configuration.${k}`, "must be a revision number");
  const l = m["limits"] as Record<string, unknown> | undefined;
  if (typeof l !== "object" || l === null) return invalid("manifest.limits", "needs cpus, memoryMb, diskMb and processes");
  const whole = (key: string, max: number): number => (typeof l[key] === "number" && Number.isSafeInteger(l[key]) && (l[key] as number) >= 1 && (l[key] as number) <= max ? (l[key] as number) : invalid(`manifest.limits.${key}`, `must be a whole number from 1 to ${max}`));
  const limits = { cpus: whole("cpus", 4096), memoryMb: whole("memoryMb", 100_000_000), diskMb: whole("diskMb", 1_000_000_000), processes: whole("processes", 1_000_000) };
  if (capacity !== undefined) {
    // An agent never gets all of the host: a share is held back for the controller.
    const keep = 1 - (capacity.reserveFraction ?? 0.1);
    for (const key of ["cpus", "memoryMb", "diskMb", "processes"] as const) if (limits[key] > Math.max(1, Math.floor(capacity[key] * keep))) invalid(`manifest.limits.${key}`, `is more than ${Math.round(keep * 100)}% of the host's ${capacity[key]}; the rest is kept for the controller`);
  }
  const ext = list(m["protectedExtensions"] ?? [], "manifest.protectedExtensions", ENV_LIMITS.protectedExtensions).map((e, i) => {
    const x = e as { name?: unknown; digest?: unknown };
    return typeof e === "object" && e !== null && typeof x.name === "string" && /^nimblenewt\.[a-z][a-z0-9-]{0,27}$/.test(x.name) && typeof x.digest === "string" && DIGEST.test(x.digest) ? { name: x.name, digest: x.digest } : invalid(`manifest.protectedExtensions[${i}]`, "needs a system name (nimblenewt.<name>) and a sha256 digest");
  });
  return {
    base, packages: [...packages].sort((a, b) => (a.name < b.name ? -1 : 1)), skills: [...new Set(skills)].sort(), capabilities: [...new Set(capabilities)].sort(), configuration,
    limits, protectedExtensions: [...ext].sort((a, b) => (a.name < b.name ? -1 : 1)),
  };
}

const checkRevisionOrZero = (v: unknown): number => (v === 0 ? 0 : checkRevision(v as number));
const AGENT_FIELDS = ["packages", "skills"] as const;
const eq = (a: unknown, b: unknown): boolean => canonicalJson(a as JsonObject) === canonicalJson(b as JsonObject);

/**
 * Per-agent environments (card A08): a common maintained base plus each agent's own package area, skill library, configuration references and limits, as numbered immutable revisions of a manifest.
 * A change makes a new revision for that agent only and never touches another agent's. A revision becomes active only after its protected extensions are checked against the system versions in the
 * catalog and against what the worker found on disk, and an activation that fails changes nothing. Every attempt and checkpoint pins the revision it ran with and resumes on exactly that one, even
 * after the agent's environment has moved on; a rollback makes a new revision from an old manifest. An agent may change only its own packages and skills; the base, capabilities, limits, configuration
 * references and protected extensions are the owner's.
 */
export class EnvironmentService {
  readonly #runner: CommandRunner;
  readonly #reserved: (name: string) => Promise<string | undefined>;
  readonly #capacity: HostCapacity | undefined;
  readonly #skillUsable: (by: Principal, versionId: string) => Promise<boolean>;

  private constructor(runner: CommandRunner, reserved: (name: string) => Promise<string | undefined>, capacity: HostCapacity | undefined, skillUsable: (by: Principal, versionId: string) => Promise<boolean>) { this.#runner = runner; this.#reserved = reserved; this.#capacity = capacity; this.#skillUsable = skillUsable; }

  /**
   * `reservedDigest` returns `sha256:<hex>` of the executable of the latest live system version of a protected name in the catalog (`CatalogService.systemDigest`), or undefined; `skillUsable` says
   * whether a catalog version exists, is not revoked and may be used by a principal (`CatalogService.usableVersion`).
   */
  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions & { reservedDigest: (name: string) => Promise<string | undefined>; skillUsable: (by: Principal, versionId: string) => Promise<boolean>; capacity?: HostCapacity }): EnvironmentService {
    if (options.capacity?.reserveFraction !== undefined && !(options.capacity.reserveFraction >= 0 && options.capacity.reserveFraction < 1)) throw new RangeError("reserveFraction must be at least 0 and below 1");
    return new EnvironmentService(new CommandRunner(storage, epoch, options), options.reservedDigest, options.capacity, options.skillUsable);
  }

  /** Makes a new revision (not yet active) for one agent. The owner may change anything; the agent itself only its packages and skills. */
  async change(by: Principal, command: NoActor & { agentId: string; manifest: unknown; reason: string; expectedRevision?: number }): Promise<{ revision: number }> {
    onlyKnown(command, ["commandId", "agentId", "manifest", "reason", "expectedRevision"]);
    const agentId = typeof command.agentId === "string" && AGENT.test(command.agentId) ? command.agentId : invalid("agentId", "is not an agent principal");
    const own = by.id === agentId && allows(by, "environment.manage", undefined);
    if (by.kind !== "owner" && !own) throw new DomainError("forbidden", `${by.id} may not change ${agentId}'s environment`);
    const reason = redactText(text(command.reason, "reason", { min: 1, max: ENV_LIMITS.reason }));
    const manifest = checkEnvironmentManifest(command.manifest, this.#capacity);
    // Every skill in the library must exist, be unrevoked and be one the person making the change may use: an agent cannot list another agent's personal skill.
    for (const skill of manifest.skills) if (!(await this.#skillUsable(by, skill))) throw new DomainError("forbidden", `${skill} is not a catalog version you may put in this library (it does not exist, was revoked, or is not yours to use)`);
    const expected = command.expectedRevision ?? 0;
    return this.#store(by, command.commandId, agentId, expected, manifest, reason, undefined, async (prev) => {
      if (by.kind === "owner") return;
      if (prev === undefined) throw new DomainError("forbidden", "an agent changes an environment the owner has made, never creates one");
      for (const key of Object.keys(manifest) as (keyof EnvironmentManifest)[]) if (!(AGENT_FIELDS as readonly string[]).includes(key) && !eq(manifest[key], prev.manifest[key])) throw new DomainError("forbidden", `${by.id} may change only its packages and skills; ${key} is the owner's`);
    });
  }

  /** Makes a prior revision current again as a new revision (the history is kept) and activates it if its protected extensions still verify. Owner only. */
  async rollback(owner: Principal, command: NoActor & { agentId: string; toRevision: number; reason: string; observed: Readonly<Record<string, string>>; expectedRevision: number }): Promise<{ revision: number; activated: boolean; problem?: string }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} is not the owner; only the owner rolls an environment back`);
    onlyKnown(command, ["commandId", "agentId", "toRevision", "reason", "observed", "expectedRevision"]);
    const agentId = typeof command.agentId === "string" && AGENT.test(command.agentId) ? command.agentId : invalid("agentId", "is not an agent principal");
    const to = checkRevision(command.toRevision);
    const old = (await this.#runner.get("environment-revision", derivedId("evr", `${agentId}|${to}`)))?.body as unknown as RevisionBody | undefined;
    if (old === undefined) throw new DomainError("not_found", `${agentId} has no environment revision ${to}`);
    const reason = redactText(text(command.reason, "reason", { min: 1, max: ENV_LIMITS.reason }));
    // The caller names the revision it saw (as `change` does), so a repeat of the same command asks for the same new revision and finishes an activation that failed the first time.
    const made = await this.#store(owner, `${command.commandId}.rb`, agentId, checkRevisionOrZero(command.expectedRevision), old.manifest, `rollback to ${to}: ${reason}`, to);
    try {
      await this.activate(owner, { commandId: `${command.commandId}.act`, agentId, revision: made.revision, observed: command.observed });
      return { ...made, activated: true };
    } catch (error) {
      // The new revision exists and is not active; the previous one stays active.
      if (error instanceof DomainError && error.code === "integrity") return { ...made, activated: false, problem: error.message };
      throw error;
    }
  }

  /**
   * Makes a revision the agent's active one, if its protected extensions are right: each must be the digest the catalog holds for the system version of that name, and the digest the worker found on
   * disk (`observed`). Any mismatch or missing extension stops the activation, changes nothing, and says which. The previous revision stays active.
   */
  async activate(by: Principal, command: NoActor & { agentId: string; revision: number; observed: Readonly<Record<string, string>> }): Promise<void> {
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} is not the owner; only the owner activates an environment revision`);
    onlyKnown(command, ["commandId", "agentId", "revision", "observed"]);
    const agentId = typeof command.agentId === "string" && AGENT.test(command.agentId) ? command.agentId : invalid("agentId", "is not an agent principal");
    const n = checkRevision(command.revision);
    if (typeof command.observed !== "object" || command.observed === null || Array.isArray(command.observed)) invalid("observed", "maps each protected extension to the digest found on disk");
    const rev = (await this.#runner.get("environment-revision", derivedId("evr", `${agentId}|${n}`)))?.body as unknown as RevisionBody | undefined;
    if (rev === undefined) throw new DomainError("not_found", `${agentId} has no environment revision ${n}`);
    const problems: string[] = [];
    for (const e of rev.manifest.protectedExtensions) {
      const registered = await this.#reserved(e.name);
      if (registered === undefined) problems.push(`${e.name} is not a live system version in the catalog`);
      else if (registered !== e.digest) problems.push(`${e.name}: the manifest's digest is not the catalog's`);
      const found = command.observed[e.name];
      if (found === undefined) problems.push(`${e.name} was not found where the worker loads it`);
      else if (found !== e.digest) problems.push(`${e.name} on disk is not the one the manifest names`);
    }
    for (const skill of rev.manifest.skills) if (!(await this.#skillUsable(by, skill))) problems.push(`${skill} in the skill library is missing or was revoked`);
    for (const name of Object.keys(command.observed)) if (!rev.manifest.protectedExtensions.some((e) => e.name === name)) problems.push(`${name} is loaded but the manifest does not name it`);
    if (problems.length > 0) throw new DomainError("integrity", `revision ${n} was not activated: ${problems.join("; ")}`, { field: "observed" });
    const ref: AggregateRef = { kind: "environment", id: derivedId("env", agentId) };
    await this.#runner.command("environment.activate", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { agentId, revision: n },
      build: async () => {
        const current = await this.#runner.get(ref.kind, ref.id);
        if (current === undefined) throw new DomainError("not_found", `${agentId} has no environment`);
        const body = current.body as unknown as EnvironmentBody;
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: { ...body, active: n } as unknown as JsonObject }], detail: { agentId, revision: n } };
      },
    }));
  }

  /** Records the revision an attempt or a checkpoint runs with: the agent's active one now. Repeating it returns the same pin. */
  async pin(by: Principal, command: NoActor & { attemptId: string; agentId: string; kind: "attempt" | "checkpoint" }): Promise<PinBody> {
    onlyKnown(command, ["commandId", "attemptId", "agentId", "kind"]);
    const agentId = typeof command.agentId === "string" && AGENT.test(command.agentId) ? command.agentId : invalid("agentId", "is not an agent principal");
    if (typeof command.attemptId !== "string" || !/^att-[a-z2-7]{20}$/.test(command.attemptId)) invalid("attemptId", "is not an attempt ID");
    if (command.kind !== "attempt" && command.kind !== "checkpoint") invalid("kind", "must be attempt or checkpoint");
    if (!(by.kind === "owner" || by.id === agentId)) throw new DomainError("forbidden", `${by.id} may not pin ${agentId}'s environment`);
    // The attempt must be that agent's own: one agent cannot claim another's attempt by pinning it first.
    const attempt = (await this.#runner.get("attempt", command.attemptId))?.body as unknown as { owner?: { kind: string; id: string } } | undefined;
    if (attempt?.owner === undefined || `${attempt.owner.kind}:${attempt.owner.id}` !== agentId) throw new DomainError("forbidden", `${command.attemptId} is not an attempt of ${agentId}`);
    const id = derivedId("epn", `${command.attemptId}|${command.kind}`);
    const existing = (await this.#runner.get("environment-pin", id))?.body as unknown as PinBody | undefined;
    if (existing !== undefined) { if (existing.agentId !== agentId) throw new DomainError("command_conflict", "that attempt is pinned to another agent's environment"); return existing; }
    const env = (await this.#runner.get("environment", derivedId("env", agentId)))?.body as unknown as EnvironmentBody | undefined;
    if (env?.active === undefined) throw new DomainError("invalid_command", `${agentId} has no active environment revision`, { field: "agentId" });
    const rev = (await this.#runner.get("environment-revision", derivedId("evr", `${agentId}|${env.active}`)))?.body as unknown as RevisionBody;
    const pin: PinBody = { attemptId: command.attemptId, agentId, kind: command.kind, revision: env.active, digest: rev.digest, at: this.#runner.now() };
    const ref: AggregateRef = { kind: "environment-pin", id };
    await this.#runner.command("environment.pin", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { attemptId: command.attemptId, agentId, kind: command.kind },
      build: async () => ({ ref, creates: true, changes: [{ type: "create", ref, body: pin as unknown as JsonObject }, { type: "check", ref: { kind: "environment", id: derivedId("env", agentId) }, expectedRevision: (await this.#runner.get("environment", derivedId("env", agentId)))!.revision }], detail: { agentId, revision: env.active! } }),
    })).catch(async (error) => { const again = (await this.#runner.get("environment-pin", id))?.body as unknown as PinBody | undefined; if (again !== undefined) return undefined; throw error; });
    return ((await this.#runner.get("environment-pin", id))?.body as unknown as PinBody);
  }

  /** The exact revision an attempt or checkpoint ran with, whatever the agent's environment is now (by the agent itself or the owner). `revision` in the result is the environment's revision number. */
  async resume(by: Principal, attemptId: string, kind: "attempt" | "checkpoint" = "attempt"): Promise<RevisionBody & { pin: PinBody }> {
    const pin = typeof attemptId === "string" && /^att-[a-z2-7]{20}$/.test(attemptId) ? (await this.#runner.get("environment-pin", derivedId("epn", `${attemptId}|${kind}`)))?.body as unknown as PinBody | undefined : undefined;
    if (pin === undefined || !(by.kind === "owner" || by.id === pin.agentId)) throw new DomainError("forbidden", `${by.id} has no such pinned environment`);
    const rev = await this.#runner.get("environment-revision", derivedId("evr", `${pin.agentId}|${pin.revision}`));
    if (rev === undefined || (rev.body as unknown as RevisionBody).digest !== pin.digest) throw new DomainError("integrity", "the pinned environment revision is missing or has changed");
    return { ...(rev.body as unknown as RevisionBody), pin };
  }

  /** An agent's environment: its active revision (and the latest), for the agent itself or the owner. */
  async get(by: Principal, agentId: string, revision?: number): Promise<{ active?: RevisionBody; latest: number; revision?: RevisionBody } | undefined> {
    if (typeof agentId !== "string" || !AGENT.test(agentId) || !(by.kind === "owner" || by.id === agentId)) return undefined;
    const env = (await this.#runner.get("environment", derivedId("env", agentId)))?.body as unknown as EnvironmentBody | undefined;
    if (env === undefined) return undefined;
    const fetch = async (n: number) => { const r = await this.#runner.get("environment-revision", derivedId("evr", `${agentId}|${n}`)); return r === undefined ? undefined : (r.body as unknown as RevisionBody); };
    const active = env.active === undefined ? undefined : await fetch(env.active);
    const chosen = revision === undefined ? undefined : await fetch(revision);
    return { latest: env.latest, ...(active === undefined ? {} : { active }), ...(chosen === undefined ? {} : { revision: chosen }) };
  }

  /** The host-side home directory of an agent, only for that agent and the owner: another agent's home is denied. */
  authorizeHome(by: Principal, agentId: string): string {
    if (typeof agentId !== "string" || !AGENT.test(agentId) || !(by.kind === "owner" || by.id === agentId)) throw new DomainError("forbidden", `${by.id} may not use that home`);
    return `agent-${sha(`home\0${agentId}`).slice(0, 24)}`;
  }

  async #store(by: Principal, commandId: string, agentId: string, expectedLatest: number, manifest: EnvironmentManifest, reason: string, rollbackOf?: number, guard?: (prev: RevisionBody | undefined) => Promise<void>): Promise<{ revision: number }> {
    const n = expectedLatest + 1;
    const body: RevisionBody = { agentId, revision: n, manifest, digest: `sha256:${sha(canonicalJson(manifest as unknown as JsonObject))}`, reason, createdBy: by.id, createdAt: this.#runner.now(), ...(rollbackOf === undefined ? {} : { rollbackOf }) };
    const rref: AggregateRef = { kind: "environment-revision", id: derivedId("evr", `${agentId}|${n}`) };
    const eref: AggregateRef = { kind: "environment", id: derivedId("env", agentId) };
    await this.#runner.command("environment.change", { commandId: scopedCommandId(by.id, commandId), actor: by.id }, async () => ({
      payload: { agentId, revision: n, digest: body.digest, rollbackOf: rollbackOf ?? null },
      build: async () => {
        // Judged on one read inside the command, so a repeat is answered from the record.
        const found = await this.#runner.get(eref.kind, eref.id);
        const env = found?.body as unknown as EnvironmentBody | undefined;
        const latest = env?.latest ?? 0;
        if (latest !== expectedLatest) throw new DomainError("stale_revision", `${agentId}'s environment is at revision ${latest}, not ${expectedLatest}`, ...(env === undefined ? [] : [{ currentRevision: latest }]));
        if (latest >= ENV_LIMITS.revisions) throw new DomainError("unavailable", `${agentId} already has ${ENV_LIMITS.revisions} environment revisions`);
        if (guard !== undefined) await guard(latest === 0 ? undefined : (await this.#runner.get("environment-revision", derivedId("evr", `${agentId}|${latest}`)))?.body as unknown as RevisionBody | undefined);
        return {
          ref: rref, creates: true,
          changes: [{ type: "create", ref: rref, body: body as unknown as JsonObject }, found === undefined ? { type: "create", ref: eref, body: { agentId, latest: n } as unknown as JsonObject } : { type: "update", ref: eref, expectedRevision: found.revision, body: { ...env!, latest: n } as unknown as JsonObject }],
          detail: { agentId, revision: n }, contention: async () => new DomainError("stale_revision", `${agentId}'s environment changed at the same moment`),
        };
      },
    }));
    return { revision: n };
  }
}
