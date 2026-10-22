import { createHash } from "node:crypto";
import { parseName, type Layer } from "@nimblenewt/registry";
import type { DeskService } from "../context/desks.js";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, projectId as checkProjectId, taskId as checkTaskId, text, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import { allows } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import { canonicalJson } from "../storage/json.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";

/** What a catalogued artifact is: a skill is instructions; a tool also has an executable. */
export type ArtifactKind = "skill" | "tool";
export const OPERATING_SYSTEMS = ["linux", "darwin", "win32"] as const;
export const ARCHITECTURES = ["x64", "arm64"] as const;

/** What a version declares about itself (card T01). */
export interface Manifest {
  readonly purpose: string;
  readonly input: JsonObject;
  readonly output: JsonObject;
  /** The program or file to start, relative to the artifact; absent for a skill that only carries instructions. */
  readonly entryPoint?: string;
  readonly interpreter?: { readonly name: string; readonly version: string };
  readonly os: readonly (typeof OPERATING_SYSTEMS)[number][];
  readonly arch: readonly (typeof ARCHITECTURES)[number][];
  readonly dependencies: readonly { readonly name: string; readonly version: string }[];
  /** Actions the artifact asks for. Asking grants nothing: a run still needs the grants (this is what the owner reads). */
  readonly requestedAccess: readonly string[];
  readonly limits: { readonly cpus: number; readonly memoryMb: number; readonly seconds: number };
  readonly cancellation: "cooperative" | "kill-only";
  readonly recovery: "restart" | "resume" | "none";
}

export interface SourceRef { readonly recordId: string; readonly revision: number; readonly digest: string; /** Whose original work it is (the desk owner). */ readonly author: string }

/** One immutable version of a catalogued artifact. Nothing here is ever rewritten; revocation is a separate record. */
export interface VersionBody {
  readonly name: string;
  readonly layer: Layer;
  readonly kind: ArtifactKind;
  readonly version: string;
  readonly manifest: Manifest;
  readonly instructional: SourceRef;
  readonly executable?: SourceRef;
  /** A digest over everything above: the identity of this version. */
  readonly digest: string;
  readonly registeredBy: string;
  readonly registeredAt: string;
}
export interface EntryBody { readonly name: string; readonly layer: Layer; readonly kind: ArtifactKind; readonly owner?: string; readonly latest: string; /** Every published version, in publication order. */ readonly versions: readonly string[]; /** The versions revoked. Revoking changes the entry, so a run in flight notices. */ readonly revoked: readonly string[] }
export interface RevocationBody { readonly revokedBy: string; readonly reason: string; readonly at: string }
export interface UsageBody {
  readonly versionId: string;
  readonly name: string;
  readonly version: string;
  readonly digest: string;
  readonly usedBy: string;
  readonly taskId: string;
  readonly projectId: string;
  readonly at: string;
}

/** What a host can run, as the worker reports it. */
export interface HostFacts {
  readonly os: (typeof OPERATING_SYSTEMS)[number];
  readonly arch: (typeof ARCHITECTURES)[number];
  readonly interpreters: Readonly<Record<string, string>>;
  readonly packages: Readonly<Record<string, string>>;
  readonly cpus: number;
  readonly memoryMb: number;
}
export interface HostCheck { readonly ok: boolean; readonly reasons: readonly string[] }

export const CATALOG_LIMITS = { purpose: 500, schemaBytes: 8192, entryPoint: 200, dependencies: 50, access: 50, scan: 5000, page: 200, versions: 500 } as const;
const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const ACCESS = /^(?:\*|[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*(?:\.\*)?)$/;
const PLAIN_NAME = /^[a-z][a-z0-9._-]{0,63}$/;
const ENTRY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const compare = (a: string, b: string): number => { const x = a.split(".").map(Number); const y = b.split(".").map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] as number) < (y[i] as number) ? -1 : 1; return 0; };
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");

/** The action a run needs: `tool.<canonical name>` with the namespace's underscore written as a hyphen (an action has no underscore). */
export const runAction = (canonical: string): string => `tool.${canonical.replace(/^a_/, "a-")}`;
/** The personal namespace of a principal: `a_` plus a fixed digest of its ID, so it can be neither chosen nor reused. */
export const personalNamespace = (principalId: string): string => `a_${sha(`agent-namespace\0${principalId}`).slice(0, 16)}`;

function checkSchema(value: unknown, field: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid(field, "must be a JSON object (a schema)");
  const json = canonicalJson(value as JsonObject);
  if (Buffer.byteLength(json, "utf8") > CATALOG_LIMITS.schemaBytes) invalid(field, `must be at most ${CATALOG_LIMITS.schemaBytes} bytes`);
  // A schema may refer only to itself: no reference or identifier that a validator could fetch from elsewhere.
  const walk = (node: unknown, depth: number): void => {
    if (depth > 32) invalid(field, "is nested too deeply");
    if (Array.isArray(node)) { for (const x of node) walk(x, depth + 1); return; }
    if (typeof node !== "object" || node === null) return;
    for (const [key, v] of Object.entries(node)) {
      if ((key === "$ref" || key === "$dynamicRef") && !(typeof v === "string" && v.startsWith("#"))) invalid(field, "may refer only to itself ($ref starting with #)");
      if (key === "$id" || (key === "$anchor" && typeof v !== "string")) invalid(field, `may not set ${key}`);
      if (key === "$schema" && !(typeof v === "string" && /^https:\/\/json-schema\.org\/[A-Za-z0-9/._#-]*$/.test(v))) invalid(field, "$schema may only name a json-schema.org dialect");
      walk(v, depth + 1);
    }
  };
  walk(value, 0);
  return value as JsonObject;
}

/** Checks and normalises a manifest; every problem names the field. */
export function checkManifest(value: unknown, kind: ArtifactKind): Manifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid("manifest", "must be an object");
  const m = value as Record<string, unknown>;
  onlyKnown(m, ["purpose", "input", "output", "entryPoint", "interpreter", "os", "arch", "dependencies", "requestedAccess", "limits", "cancellation", "recovery"]);
  const purpose = redactText(text(m["purpose"], "manifest.purpose", { min: 1, max: CATALOG_LIMITS.purpose }));
  const list = <T extends string>(field: string, allowed: readonly T[], raw: unknown): T[] => {
    if (!Array.isArray(raw) || raw.length < 1 || raw.some((x) => !allowed.includes(x as T))) invalid(`manifest.${field}`, `must list one or more of ${allowed.join(", ")}`);
    return [...new Set(raw as T[])].sort();
  };
  const os = list("os", OPERATING_SYSTEMS, m["os"]);
  const arch = list("arch", ARCHITECTURES, m["arch"]);
  const deps = m["dependencies"] ?? [];
  if (!Array.isArray(deps) || deps.length > CATALOG_LIMITS.dependencies) invalid("manifest.dependencies", `must be a list of at most ${CATALOG_LIMITS.dependencies}`);
  const dependencies = (deps as unknown[]).map((d, i) => {
    const x = d as { name?: unknown; version?: unknown };
    if (typeof d !== "object" || d === null || typeof x.name !== "string" || !PLAIN_NAME.test(x.name) || typeof x.version !== "string" || !/^[0-9A-Za-z.+-]{1,40}$/.test(x.version)) return invalid(`manifest.dependencies[${i}]`, "needs a name and an exact version");
    return { name: x.name, version: x.version };
  });
  const access = m["requestedAccess"] ?? [];
  if (!Array.isArray(access) || access.length > CATALOG_LIMITS.access || access.some((a) => typeof a !== "string" || !ACCESS.test(a))) invalid("manifest.requestedAccess", "must be a list of action names");
  const l = m["limits"] as { cpus?: unknown; memoryMb?: unknown; seconds?: unknown } | undefined;
  const whole = (v: unknown, field: string, max: number): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= max ? v : invalid(`manifest.limits.${field}`, `must be a whole number from 1 to ${max}`));
  if (typeof l !== "object" || l === null) invalid("manifest.limits", "needs cpus, memoryMb and seconds");
  const limits = { cpus: whole(l!.cpus, "cpus", 256), memoryMb: whole(l!.memoryMb, "memoryMb", 1_000_000), seconds: whole(l!.seconds, "seconds", 86_400) };
  if (m["cancellation"] !== "cooperative" && m["cancellation"] !== "kill-only") invalid("manifest.cancellation", "must be cooperative or kill-only");
  if (m["recovery"] !== "restart" && m["recovery"] !== "resume" && m["recovery"] !== "none") invalid("manifest.recovery", "must be restart, resume or none");
  const entryPoint = m["entryPoint"];
  const interpreter = m["interpreter"] as { name?: unknown; version?: unknown } | undefined;
  if (kind === "tool") {
    if (typeof entryPoint !== "string" || !ENTRY.test(entryPoint) || entryPoint.includes("..")) invalid("manifest.entryPoint", "a tool needs an entry point (a relative path)");
    if (interpreter !== undefined && (typeof interpreter !== "object" || interpreter === null || typeof interpreter.name !== "string" || !PLAIN_NAME.test(interpreter.name) || typeof interpreter.version !== "string" || !/^[0-9A-Za-z.+-]{1,40}$/.test(interpreter.version))) invalid("manifest.interpreter", "needs a name and an exact version");
  } else if (entryPoint !== undefined || interpreter !== undefined) invalid("manifest.entryPoint", "a skill carries instructions only and has no entry point or interpreter");
  return {
    purpose, input: checkSchema(m["input"], "manifest.input"), output: checkSchema(m["output"], "manifest.output"),
    ...(typeof entryPoint === "string" ? { entryPoint } : {}), ...(interpreter === undefined ? {} : { interpreter: { name: interpreter.name as string, version: interpreter.version as string } }),
    os, arch, dependencies, requestedAccess: [...new Set(access as string[])].sort(), limits, cancellation: m["cancellation"] as Manifest["cancellation"], recovery: m["recovery"] as Manifest["recovery"],
  };
}

/** Whether a host can run a manifest, and if not why, in words. Pure. */
export function checkHost(manifest: Manifest, host: HostFacts): HostCheck {
  const reasons: string[] = [];
  if (!manifest.os.includes(host.os)) reasons.push(`it supports ${manifest.os.join(", ")} and this host is ${host.os}`);
  if (!manifest.arch.includes(host.arch)) reasons.push(`it supports ${manifest.arch.join(", ")} and this host is ${host.arch}`);
  if (manifest.interpreter !== undefined && host.interpreters[manifest.interpreter.name] !== manifest.interpreter.version) reasons.push(`it needs ${manifest.interpreter.name} ${manifest.interpreter.version}, and this host has ${host.interpreters[manifest.interpreter.name] ?? "none"}`);
  for (const d of manifest.dependencies) if (host.packages[d.name] !== d.version) reasons.push(`it needs ${d.name} ${d.version}, and this host has ${host.packages[d.name] ?? "none"}`);
  if (host.cpus < manifest.limits.cpus) reasons.push(`it asks for ${manifest.limits.cpus} CPUs and this host has ${host.cpus}`);
  if (host.memoryMb < manifest.limits.memoryMb) reasons.push(`it asks for ${manifest.limits.memoryMb} MB of memory and this host has ${host.memoryMb}`);
  return { ok: reasons.length === 0, reasons };
}

export interface RegisterCommand extends NoActor {
  /** The canonical name (`<namespace>.<name>`). A personal registrant gives only the short name and gets its own namespace; the owner may name `toolbox.x` or `nimblenewt.x`. */
  readonly name: string;
  readonly kind: ArtifactKind;
  readonly version: string;
  readonly manifest: unknown;
  /** The registrant's own accepted desk record holding the instructions. */
  readonly instructionsRecordId: string;
  /** For a tool: the registrant's own accepted desk record holding the executable. */
  readonly executableRecordId?: string;
}

/**
 * The durable catalog of skills and tools (card T01), over the protected naming of F07: personal (`a_<id>`), shared (`toolbox`) and system (`nimblenewt`) artifacts, each version immutable and
 * identified by a digest over its manifest and its exact instructional and executable sources. A personal registration is accepted only from the registrant's own accepted original work (the desk
 * refuses another desk's content and copies of it); shared and system releases are the owner's and are separate versions, so a personal edit can never change a shared one. A skill carries
 * instructions only and cannot run anything; a run of a tool needs a grant naming it and the host to satisfy its manifest, and records who used which exact version, in which task and project.
 */
export class CatalogService {
  readonly #runner: CommandRunner;
  readonly #desks: DeskService;

  private constructor(runner: CommandRunner, desks: DeskService) { this.#runner = runner; this.#desks = desks; }

  static withEpoch(storage: ControllerStorage, epoch: number, desks: DeskService, options: RunnerOptions = {}): CatalogService {
    return new CatalogService(new CommandRunner(storage, epoch, options), desks);
  }

  /** Registers a version. A personal one by an agent from its own work; a shared or system one by the owner. */
  async register(by: Principal, command: RegisterCommand): Promise<{ versionId: string; name: string; digest: string }> {
    onlyKnown(command, ["commandId", "name", "kind", "version", "manifest", "instructionsRecordId", "executableRecordId"]);
    if (command.kind !== "skill" && command.kind !== "tool") invalid("kind", "must be skill or tool");
    if (typeof command.version !== "string" || !VERSION.test(command.version)) invalid("version", "must be major.minor.patch");
    if ((command.kind === "tool") !== (command.executableRecordId !== undefined)) invalid("executableRecordId", command.kind === "tool" ? "a tool needs its executable record" : "a skill has no executable record");
    let canonical: string;
    if (by.kind === "owner") {
      const parsed = parseName(command.name);
      if (parsed === null || parsed.layer === "agent") return invalid("name", "the owner registers shared (toolbox.<name>) or system (nimblenewt.<name>) names");
      canonical = parsed.canonical;
    } else {
      if (by.kind !== "agent") throw new DomainError("forbidden", `${by.id} may not register skills or tools`);
      if (!allows(by, "catalog.register", undefined)) throw new DomainError("forbidden", `${by.id} may not register skills or tools`);
      canonical = `${personalNamespace(by.id)}.${typeof command.name === "string" ? command.name : ""}`;
      if (parseName(canonical) === null) invalid("name", "must be lower-case letters, digits and single hyphens, at most 28 characters");
    }
    const parsed = parseName(canonical)!;
    const manifest = checkManifest(command.manifest, command.kind);
    // Only the registrant's own accepted original work is accepted: the desk refuses another desk's content and copies of it.
    const instructions = await this.#source(by, command.instructionsRecordId);
    const executable = command.executableRecordId === undefined ? undefined : await this.#source(by, command.executableRecordId);
    const version = command.version;
    const entryId = derivedId("cat", canonical);
    const versionId = derivedId("cav", `${canonical}|${version}`);
    const body: Omit<VersionBody, "digest"> = { name: canonical, layer: parsed.layer, kind: command.kind, version, manifest, instructional: instructions, ...(executable === undefined ? {} : { executable }), registeredBy: by.id, registeredAt: this.#runner.now() };
    const { registeredBy: _by, registeredAt: _at, ...identity } = body;
    void _by; void _at;
    const digest = sha(canonicalJson(identity as unknown as JsonObject));
    const full: VersionBody = { ...body, digest };
    await this.#runner.command("catalog.register", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { name: canonical, kind: command.kind, version, digest },
      build: async () => {
        const entry = await this.#runner.get("catalog-entry", entryId);
        const existing = await this.#runner.get("catalog-version", versionId);
        const prior = entry?.body as unknown as EntryBody | undefined;
        if (prior !== undefined && prior.layer === "agent" && prior.owner !== by.id) throw new DomainError("forbidden", "that name belongs to another agent");
        if (prior !== undefined && prior.kind !== command.kind) throw new DomainError("invalid_command", `${canonical} is a ${prior.kind}; a name keeps its kind`, { field: "kind" });
        const vref: AggregateRef = { kind: "catalog-version", id: versionId };
        const eref: AggregateRef = { kind: "catalog-entry", id: entryId };
        if (existing !== undefined) {
          // The same bytes again are a no-op; different bytes under a published version are refused.
          if ((existing.body as unknown as VersionBody).digest !== digest) throw new DomainError("command_conflict", `${canonical} ${version} is already published with different content; versions are immutable`);
          return { ref: vref, creates: false, changes: [{ type: "check", ref: vref, expectedRevision: existing.revision }], detail: { name: canonical, version, existing: true } };
        }
        if (prior !== undefined && compare(version, prior.latest) <= 0) throw new DomainError("invalid_command", `${canonical} is at ${prior.latest}; a new version must be higher`, { field: "version" });
        if ((prior?.versions.length ?? 0) >= CATALOG_LIMITS.versions) throw new DomainError("unavailable", `${canonical} already has ${CATALOG_LIMITS.versions} versions`);
        const nextEntry: EntryBody = { name: canonical, layer: parsed.layer, kind: command.kind, ...(parsed.layer === "agent" ? { owner: by.id } : {}), latest: version, versions: [...(prior?.versions ?? []), version], revoked: prior?.revoked ?? [] };
        return {
          ref: vref, creates: true,
          changes: [
            { type: "create", ref: vref, body: full as unknown as JsonObject },
            entry === undefined ? { type: "create", ref: eref, body: nextEntry as unknown as JsonObject } : { type: "update", ref: eref, expectedRevision: entry.revision, body: nextEntry as unknown as JsonObject },
          ],
          detail: { name: canonical, version, kind: command.kind, layer: parsed.layer },
          contention: async () => new DomainError("stale_revision", `${canonical} changed at the same moment; register again`),
        };
      },
    }));
    return { versionId, name: canonical, digest };
  }

  /** The owner withdraws a version for good. It is no longer chosen and a run of it is refused; nothing is deleted. */
  async revoke(owner: Principal, command: NoActor & { name: string; version: string; reason: string }): Promise<void> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} is not the owner; only the owner revokes a version`);
    onlyKnown(command, ["commandId", "name", "version", "reason"]);
    const parsed = parseName(command.name);
    if (parsed === null) invalid("name", "is not a canonical name");
    if (typeof command.version !== "string" || !VERSION.test(command.version)) invalid("version", "must be major.minor.patch");
    const reason = redactText(text(command.reason, "reason", { min: 1, max: 500 }));
    const versionId = derivedId("cav", `${command.name}|${command.version}`);
    const ref: AggregateRef = { kind: "catalog-revocation", id: versionId };
    const eref: AggregateRef = { kind: "catalog-entry", id: derivedId("cat", command.name) };
    await this.#runner.command("catalog.revoke", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { versionId, reason },
      build: async () => {
        const entry = await this.#runner.get(eref.kind, eref.id);
        const prior = entry?.body as unknown as EntryBody | undefined;
        if (entry === undefined || prior === undefined || !prior.versions.includes(command.version)) throw new DomainError("not_found", `${command.name} ${command.version} is not in the catalog`);
        if (prior.revoked.includes(command.version) || (await this.#runner.get(ref.kind, ref.id)) !== undefined) throw new DomainError("invalid_command", "that version is already revoked", { field: "version" });
        const body: RevocationBody = { revokedBy: owner.id, reason, at: this.#runner.now() };
        const next: EntryBody = { ...prior, revoked: [...prior.revoked, command.version] };
        return {
          ref, creates: true,
          changes: [{ type: "create", ref, body: body as unknown as JsonObject }, { type: "update", ref: eref, expectedRevision: entry.revision, body: next as unknown as JsonObject }],
          detail: { name: command.name, version: command.version }, contention: async () => new DomainError("stale_revision", "the catalog entry changed at the same moment; revoke again"),
        };
      },
    }));
  }

  /** One version (or the latest live one), if the reader may see it: system and shared artifacts to any authenticated principal with `catalog.read`, a personal one only to its owner and the installation owner. */
  async get(by: Principal, name: string, version?: string): Promise<(View<VersionBody> & { revoked?: RevocationBody }) | undefined> {
    const resolved = await this.#resolve(by, name, version);
    return resolved?.version;
  }

  /** The names the reader may see, with their latest live version. */
  async list(by: Principal): Promise<{ name: string; kind: ArtifactKind; layer: Layer; latest: string }[]> {
    const out: { name: string; kind: ArtifactKind; layer: Layer; latest: string }[] = [];
    for (let after: string | undefined; ;) {
      const page = await this.#runner.list("catalog-entry", { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const a of page) {
        after = a.id;
        const e = a.body as unknown as EntryBody;
        if (!this.#mayReadEntry(by, e)) continue;
        const live = await this.#latestLive(e.name);
        if (live !== undefined) out.push({ name: e.name, kind: e.kind, layer: e.layer, latest: live.body.version });
      }
      if (page.length < 200) return out;
    }
  }

  /**
   * Asks to run a tool in a task (the dispatcher's call, with the host's facts). A skill, a revoked version, a name the caller may not use, a missing grant and a host that cannot run it are each
   * refused or reported before anything starts; a run that may start is recorded (who, which exact version, task, project) and returns the version to run.
   */
  async authorizeRun(by: Principal, command: NoActor & { name: string; version?: string; taskId: string; projectId: string; host: HostFacts }): Promise<{ ready: true; versionId: string; version: string; digest: string } | { ready: false; reasons: readonly string[] }> {
    onlyKnown(command, ["commandId", "name", "version", "taskId", "projectId", "host"]);
    const projectId = checkProjectId(command.projectId);
    const taskId = checkTaskId(command.taskId);
    const task = (await this.#runner.get("task", taskId))?.body as unknown as { projectId?: string } | undefined;
    if (task?.projectId !== projectId) throw new DomainError("forbidden", `${by.id} may not run tools for that task`);
    const resolved = await this.#resolve(by, command.name, command.version);
    if (resolved === undefined) throw new DomainError("forbidden", `${by.id} may not use ${String(command.name).slice(0, 64)}`);
    const v = resolved.version;
    if (v.revoked !== undefined) throw new DomainError("forbidden", `${v.name} ${v.version} was revoked (${v.revoked.reason})`);
    if (v.kind === "skill" || v.executable === undefined) throw new DomainError("forbidden", `${v.name} is a skill: it carries instructions and cannot run anything`);
    if (!allows(by, runAction(v.name), projectId, { resource: { kind: "task", id: taskId } })) throw new DomainError("forbidden", `${by.id} holds no grant to run ${v.name} in this task`);
    const host = command.host;
    if (typeof host !== "object" || host === null || !OPERATING_SYSTEMS.includes(host.os) || !ARCHITECTURES.includes(host.arch)) invalid("host", "needs os, arch, interpreters, packages, cpus and memoryMb");
    const check = checkHost(v.manifest, host);
    if (!check.ok) return { ready: false, reasons: check.reasons };
    const useId = derivedId("use", scopedCommandId(by.id, command.commandId));
    const ref: AggregateRef = { kind: `catalog-usage-${projectId}`, id: useId };
    const usage: UsageBody = { versionId: v.id, name: v.name, version: v.version, digest: v.digest, usedBy: by.id, taskId, projectId, at: this.#runner.now() };
    await this.#runner.command("catalog.use", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { versionId: v.id, taskId, projectId },
      build: async () => {
        // The version must still be unrevoked at the moment of the record: revoking changes the entry, and the record is written only if the entry is still as it was read here.
        const eref: AggregateRef = { kind: "catalog-entry", id: derivedId("cat", v.name) };
        const entry = await this.#runner.get(eref.kind, eref.id);
        if (entry === undefined || (entry.body as unknown as EntryBody).revoked.includes(v.version)) throw new DomainError("forbidden", `${v.name} ${v.version} was revoked`);
        return { ref, creates: true, changes: [{ type: "create", ref, body: usage as unknown as JsonObject }, { type: "check", ref: eref, expectedRevision: entry.revision }], detail: { name: v.name, version: v.version, taskId, projectId }, contention: async () => new DomainError("stale_revision", "the catalog changed at the same moment; ask again") };
      },
    }));
    return { ready: true, versionId: v.id, version: v.version, digest: v.digest };
  }

  /** The recorded uses in one project (a reader with `history.read` there, or the owner), in record-ID order (not time order), a page at a time: pass `next` back as `after`. Each project's uses are kept apart, so reading one never scans another's. */
  async usage(by: Principal, query: { projectId: string; name?: string; limit?: number; after?: string }): Promise<{ items: UsageBody[]; next?: string }> {
    onlyKnown(query, ["projectId", "name", "limit", "after"]);
    const limit = query.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > CATALOG_LIMITS.page) invalid("limit", `must be 1 to ${CATALOG_LIMITS.page}`);
    const project = checkProjectId(query.projectId);
    if (by.kind !== "owner" && !allows(by, "history.read", project)) throw new DomainError("forbidden", `${by.id} may not read tool usage in ${project}`);
    const items: UsageBody[] = [];
    for (let after = query.after; ;) {
      const page = await this.#runner.list(`catalog-usage-${project}`, { ...(after === undefined ? {} : { afterId: after }), limit: 500 });
      for (const a of page) {
        after = a.id;
        const u = a.body as unknown as UsageBody;
        if (query.name !== undefined && u.name !== query.name) continue;
        items.push(u);
        if (items.length >= limit) return { items, next: a.id };
      }
      if (page.length < 500) return { items };
    }
  }

  /** The exact instructions or executable a version recorded, read back from the desk and checked against the recorded digest (a changed or missing source is reported, never run). */
  async content(by: Principal, name: string, version: string, part: "instructions" | "executable"): Promise<string> {
    const resolved = await this.#resolve(by, name, version);
    if (resolved === undefined) throw new DomainError("forbidden", `${by.id} may not read ${String(name).slice(0, 64)}`);
    const source = part === "instructions" ? resolved.version.instructional : resolved.version.executable;
    if (source === undefined) throw new DomainError("not_found", `${name} has no ${part}`);
    // Read as the registrant would: the desk's own rule about who may read a record applies to the registrant, and the catalog serves what was registered.
    const record = (await this.#runner.get("desk-record", source.recordId))?.body as unknown as { body: string } | undefined;
    if (record === undefined || sha(record.body) !== source.digest) throw new DomainError("invalid_command", `${name} ${version}: the recorded ${part} is missing or has changed since it was registered`);
    return record.body;
  }

  /** Whether a catalog version exists, is not revoked and may be used by this principal (its own personal entries; shared and system ones with `catalog.read`; the owner anything live). For environments. */
  async usableVersion(by: Principal, versionId: string): Promise<boolean> {
    if (typeof versionId !== "string" || !/^cav-[a-z2-7]{20}$/.test(versionId)) return false;
    const found = (await this.#runner.get("catalog-version", versionId))?.body as unknown as VersionBody | undefined;
    if (found === undefined) return false;
    const entry = (await this.#runner.get("catalog-entry", derivedId("cat", found.name)))?.body as unknown as EntryBody | undefined;
    return entry !== undefined && this.#mayReadEntry(by, entry) && !entry.revoked.includes(found.version);
  }

  /**
   * What a protected extension must be on disk: `sha256:` plus the digest of the executable source of the latest live system version of `nimblenewt.<name>`, or undefined. This is the value the
   * environment's manifest names and the worker reports for the file it loads (a digest of that file's bytes).
   */
  async systemDigest(name: string): Promise<string | undefined> {
    const parsed = parseName(name);
    if (parsed === null || parsed.layer !== "protected") return undefined;
    const live = await this.#latestLive(parsed.canonical);
    const digest = live?.body.executable?.digest;
    return digest === undefined ? undefined : `sha256:${digest}`;
  }

  // ---- internals ------------------------------------------------------------------------------------------------------------

  /**
   * The source of a version. An agent registers only its own accepted original work (the desk refuses another desk's content and copies of it). The owner, releasing a shared or system version,
   * takes an agent's accepted, shared (not private) original record, never a draft or a copy; the author stays recorded, and the release is a separate version with its own digest.
   */
  async #source(by: Principal, recordId: string): Promise<SourceRef> {
    if (by.kind !== "owner") {
      const found = await this.#desks.executableSource(by, recordId);
      return { recordId: found.id, revision: found.revision, digest: sha(found.body), author: by.id };
    }
    const found = typeof recordId === "string" && /^dsk-[a-z2-7]{20}$/.test(recordId) ? await this.#runner.get("desk-record", recordId) : undefined;
    const record = found?.body as unknown as { owner: string; status: string; visibility: string; body: string; origin?: unknown; copiedFrom?: unknown } | undefined;
    if (found === undefined || record === undefined) throw new DomainError("not_found", "no such record");
    if (record.visibility === "private") throw new DomainError("forbidden", "private scratch cannot be released; ask the agent to publish it to the desk first");
    if (record.status !== "accepted") throw new DomainError("invalid_command", "only an accepted record can be released", { field: "recordId" });
    if (record.origin !== undefined || record.copiedFrom !== undefined) throw new DomainError("forbidden", "a copy of another desk's content cannot be released as a skill or tool");
    return { recordId: found.id, revision: found.revision, digest: sha(record.body), author: record.owner };
  }

  #mayReadEntry(by: Principal, e: EntryBody): boolean {
    if (by.kind === "owner") return true;
    if (e.layer === "agent") return e.owner === by.id;
    return allows(by, "catalog.read", undefined);
  }

  /** The highest published version that is not revoked. */
  async #latestLive(name: string): Promise<{ id: string; body: VersionBody } | undefined> {
    const entry = (await this.#runner.get("catalog-entry", derivedId("cat", name)))?.body as unknown as EntryBody | undefined;
    if (entry === undefined) return undefined;
    const live = entry.versions.filter((v) => !entry.revoked.includes(v)).sort(compare).reverse();
    for (const v of live) {
      const id = derivedId("cav", `${name}|${v}`);
      const found = await this.#runner.get("catalog-version", id);
      if (found !== undefined) return { id, body: found.body as unknown as VersionBody };
    }
    return undefined;
  }

  async #resolve(by: Principal, name: string, version?: string): Promise<{ version: View<VersionBody> & { revoked?: RevocationBody } } | undefined> {
    const parsed = parseName(name);
    if (parsed === null) return undefined;
    const entry = (await this.#runner.get("catalog-entry", derivedId("cat", parsed.canonical)))?.body as unknown as EntryBody | undefined;
    if (entry === undefined || !this.#mayReadEntry(by, entry)) return undefined;
    let id: string;
    if (version === undefined) {
      const live = await this.#latestLive(parsed.canonical);
      if (live === undefined) return undefined;
      id = live.id;
    } else {
      if (!VERSION.test(version)) return undefined;
      id = derivedId("cav", `${parsed.canonical}|${version}`);
    }
    const found = await this.#runner.get("catalog-version", id);
    if (found === undefined) return undefined;
    const published = (found.body as unknown as VersionBody).version;
    const revoked = entry.revoked.includes(published) ? ((await this.#runner.get("catalog-revocation", id))?.body as unknown as RevocationBody | undefined) : undefined;
    return { version: { ...view<VersionBody>(found), ...(revoked === undefined ? {} : { revoked }) } };
  }
}
