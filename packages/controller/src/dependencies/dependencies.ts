import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, projectId as checkProjectId, taskId as checkTaskId, type TaskBody } from "../domain/model.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { canRead, type DeskRecordBody } from "../context/desks.js";
import { allows, inTaskScope } from "../security/access.js";
import { redactText } from "../security/redact.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";

/** What a piece of work depended on (card C03). */
export const DEPENDENCY_KINDS = ["file", "directory", "search", "record", "decision", "tool-version", "environment", "external", "mcp-resource", "negative"] as const;
export type DependencyKind = (typeof DEPENDENCY_KINDS)[number];

export interface DependencyEntry {
  /** Derived from the kind and the key: recording the same dependency again replaces its observation. */
  readonly id: string;
  readonly kind: DependencyKind;
  /** The resource's identity: a workspace path, a record ID, a catalog version ID, an agent ID, a URI, a query's name. */
  readonly key: string;
  /** What was seen: a content hash or an ETag, when the kind has one. */
  readonly hash?: string;
  readonly etag?: string;
  readonly observedAt: string;
  /** A search's scope and query, and the position in the event stream it was made at. */
  readonly scope?: { readonly projectId?: string; readonly query: string };
  readonly cursor?: number;
  /** A directory's members, so that a new one can be told from a changed one. */
  readonly members?: readonly string[];
  /** An external resource: how its freshness can be checked later. `none` means it cannot, and a later check says so instead of guessing. */
  readonly freshness?: "conditional-read" | "authoritative-query" | "none";
  /** True when the hash was the recorder's word and could not be verified because the recorder may not read what it names; a check by someone who can read it measures against that word. */
  readonly unverified?: boolean;
  /** An MCP resource read: which server, and the protocol revision it spoke. */
  readonly server?: string;
  readonly protocol?: string;
  /** A search of the task's own project that the controller makes again itself (card L04d): the principal that made it, set by the controller when it was recorded, never by the caller. */
  readonly reader?: string;
}

/**
 * How the controller makes a recorded search again (card L04d). A `search` dependency names a word search of the controller's own desk records and histories, so no worker can say better than the
 * controller whether it still finds the same: with this port the controller answers it, for searches of the task's own project.
 */
export interface SearchJudge {
  /** The principal with this ID as it stands now (current grants), or nothing when it is gone or not active. */
  reader(principalId: string): Promise<Principal | undefined>;
  /** The digest of what the search finds for `reader` now (`RetrievalService.searchDigest`). */
  digest(reader: Principal, projectId: string, query: string): Promise<string>;
  /** The project's event stream: the next position to be written, and the lowest one still kept. */
  position(projectId: string): Promise<{ readonly next: number; readonly floor: number }>;
}

export interface ManifestBody { readonly taskId: string; readonly projectId: string; readonly entries: readonly DependencyEntry[] }

export type DependencyStatus = "unchanged" | "changed" | "deleted" | "new-members" | "unknown" | "cursor-expired" | "freshness-uncertain";
export interface Observation {
  readonly exists?: boolean;
  readonly hash?: string;
  readonly etag?: string;
  readonly members?: readonly string[];
  /** The oldest position in the event stream that can still be read; a search made before it can no longer be checked from events. */
  readonly cursorFloor?: number;
  /** Why it could not be read now (card L04g: an external or MCP resource the owner has not allowed to be read, or one that did not answer). Said in the check's detail; the status stays `unknown`. */
  readonly unread?: string;
}
export interface DependencyCheck { readonly id: string; readonly kind: DependencyKind; readonly key: string; readonly status: DependencyStatus; readonly detail: string }

export const DEPENDENCY_LIMITS = { entries: 500, key: 300, members: 200, member: 200, observations: 500, /** Searches one check makes again (card L04d); the rest of a manifest's searches stay unknown. */ searches: 10, /** The longest text kept beside an entry for the resume reviewer (card L04g), in characters. */ text: 64 * 1024 } as const;
const TEXT_KIND = "dependency-text";
/** The text the controller read when it recorded an entry (card L04g): redacted, bounded, and only for the hash it was read with. */
interface DependencyText { readonly taskId: string; readonly entryId: string; readonly hash: string; readonly text: string; readonly at: string }
const HASH = /^(?:sha256:)?[0-9a-f]{64}$/;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const sha = (v: string): string => createHash("sha256").update(v).digest("hex");
/** A reader's reason, as the check's detail carries it: one line, redacted, at most 200 characters. */
const clipReason = (v: string): string => redactText(v.replace(/[\u0000-\u001f\u007f]/g, " ")).slice(0, 200);

export type NewDependency = Omit<DependencyEntry, "id" | "observedAt">;

/** The ID an entry of this kind and key gets in a manifest (a search's also from its project): recording the same again replaces it. */
export const dependencyEntryId = (kind: string, key: string, projectId?: string): string => derivedId("dpm", `${kind}|${projectId ?? ""}|${key}`);

/**
 * Dependency manifests (card C03): what a task read, wrote, searched and relied on, with enough to tell later whether it still holds. A file, a directory (and which names it held), a search (its scope and
 * the position in the event stream it was made at), a shared record or decision, a tool version, an environment revision, an external resource or an MCP resource read (server, URI, hash or ETag, when), and
 * a negative lookup ("there was no such record"). `check` says for each entry whether it is unchanged, changed, deleted, has new directory members, or cannot be told: records, tool versions, environments
 * and negative lookups of records are judged from the controller's own state; the rest need a current observation from the worker, and without one the answer is `unknown`, never "unchanged". A search
 * older than the oldest readable event is `cursor-expired`, and an external resource that was recorded without a way to check it is `freshness-uncertain`.
 */
export class DependencyService {
  readonly #runner: CommandRunner;
  readonly #searches: SearchJudge | undefined;

  private constructor(runner: CommandRunner, searches: SearchJudge | undefined) { this.#runner = runner; this.#searches = searches; }

  /** `searches`: the controller makes recorded searches of a task's own project again itself (card L04d); without it a search is judged only from a worker's observation, as before. */
  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions & { searches?: SearchJudge } = {}): DependencyService {
    const { searches, ...runner } = options;
    return new DependencyService(new CommandRunner(storage, epoch, runner), searches);
  }

  /**
   * What to record for a search this caller makes of a project now (card L04d): a `search` dependency with the query as its key (cut to the key bound), the project's event position and the digest of what
   * the search finds for the caller, ready for `record`. Anyone who may search the project may ask; what they may not read is not in the digest. `unavailable` without the search port.
   */
  async searchDependency(by: Principal, query: { projectId: string; query: string; key?: string }): Promise<NewDependency> {
    onlyKnown(query, ["projectId", "query", "key"]);
    if (this.#searches === undefined) throw new DomainError("unavailable", "this controller does not make recorded searches again");
    const projectId = checkProjectId(query.projectId);
    // Only someone who could rely on a search there asks: the answer carries the project's event position, which is not for a caller outside the project (nor for a task credential of another project).
    if (!(await this.#maySearchFor(by, projectId))) throw new DomainError("forbidden", `${by.id} may not record a search of that project`);
    if (typeof query.query !== "string") invalid("query", "must be text");
    const key = query.key ?? query.query.replace(/[\0\r\n]+/g, " ").slice(0, DEPENDENCY_LIMITS.key);
    if (typeof key !== "string" || key.length < 1 || key.length > DEPENDENCY_LIMITS.key || /[\0\r\n]/.test(key)) invalid("key", `must be 1 to ${DEPENDENCY_LIMITS.key} characters on one line`);
    // The position first: a search made after it is at least as new as the position says, so a check never thinks it older than it is.
    const at = await this.#searches.position(projectId);
    const hash = await this.#searches.digest(by, projectId, query.query);
    return { kind: "search", key, scope: { projectId, query: query.query }, cursor: at.next, hash };
  }

  /**
   * Records dependencies of a task (the agent working it, or the owner). The same dependency again replaces its observation.
   * `texts` (card L04g; the controller's own callers only, never a request's words): for an entry, by its index in `dependencies`, the text the controller itself read when it took that entry's hash (already redacted and bounded,
   * `DEPENDENCY_LIMITS.text` at most). It is kept beside the entry so that a later resume can show its reviewer what changed. A text for an entry with no hash, or a longer one, is not kept.
   */
  async record(by: Principal, command: NoActor & { taskId: string; dependencies: readonly NewDependency[] }, texts: readonly (string | undefined)[] = []): Promise<{ recorded: number }> {
    onlyKnown(command, ["commandId", "taskId", "dependencies"]);
    const taskId = checkTaskId(command.taskId);
    const task = (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined;
    if (task === undefined || !allows(by, "attempt.work", task.projectId, { resource: { kind: "task", id: taskId } })) throw new DomainError("forbidden", `${by.id} may not record dependencies for that task`);
    if (!Array.isArray(command.dependencies) || command.dependencies.length < 1 || command.dependencies.length > DEPENDENCY_LIMITS.entries) invalid("dependencies", `must list 1 to ${DEPENDENCY_LIMITS.entries}`);
    const now = this.#runner.now();
    const fresh = command.dependencies.map((d, i) => this.#entry(d, `dependencies[${i}]`, now));
    // What the controller can judge itself is recorded only as it really is, and only by someone who may read it: a guessed hash is never stored.
    for (const [i, e] of fresh.entries()) if (!(await this.#verifyAtRecording(by, e, `dependencies[${i}]`))) (fresh[i] as { unverified?: boolean }).unverified = true;
    for (const [i, e] of fresh.entries()) if (e.kind === "search" && this.#judgesSearch(e, task.projectId)) fresh[i] = await this.#verifySearch(by, e, task.projectId, `dependencies[${i}]`);
    const ref: AggregateRef = { kind: "dependency-manifest", id: derivedId("dpm", taskId) };
    const r = await this.#runner.command("dependencies.record", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { taskId, entries: fresh.map((e) => e.id).join(",") },
      build: async () => {
        const found = await this.#runner.get(ref.kind, ref.id);
        const old = (found?.body as unknown as ManifestBody | undefined)?.entries ?? [];
        const byId = new Map(old.map((e) => [e.id, e]));
        for (const e of fresh) byId.set(e.id, e);
        if (byId.size > DEPENDENCY_LIMITS.entries) throw new DomainError("unavailable", `a task's manifest holds at most ${DEPENDENCY_LIMITS.entries} dependencies`);
        const body: ManifestBody = { taskId, projectId: task.projectId, entries: [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1)) };
        // The texts the controller read for these entries (card L04g), one record per task and entry: a newer reading replaces the older one.
        const kept: Change[] = [];
        for (const [i, e] of fresh.entries()) {
          const text = texts[i];
          if (typeof text !== "string" || text.length > DEPENDENCY_LIMITS.text || e.hash === undefined) continue;
          const tref: AggregateRef = { kind: TEXT_KIND, id: derivedId("dpt", `${taskId}|${e.id}`) };
          const was = await this.#runner.get(tref.kind, tref.id);
          const tbody: DependencyText = { taskId, entryId: e.id, hash: e.hash.replace(/^sha256:/, ""), text, at: now };
          kept.push(was === undefined ? { type: "create", ref: tref, body: tbody as unknown as JsonObject } : { type: "update", ref: tref, expectedRevision: was.revision, body: tbody as unknown as JsonObject });
        }
        return { ref, creates: found === undefined, changes: [found === undefined ? { type: "create", ref, body: body as unknown as JsonObject } : { type: "update", ref, expectedRevision: found.revision, body: body as unknown as JsonObject }, ...kept], detail: { taskId, recorded: fresh.length, ...(kept.length === 0 ? {} : { texts: kept.length }) }, contention: async () => new DomainError("stale_revision", "the manifest changed at the same moment; record again") };
      },
    }));
    void r;
    return { recorded: fresh.length };
  }

  /** Card L04g: the task's project when this caller may record its dependencies (the same right `record` checks), else nothing; asked before anything is looked at for a note. */
  async mayRecord(by: Principal, taskId: string): Promise<string | undefined> {
    const task = (await this.#runner.get("task", checkTaskId(taskId)))?.body as unknown as TaskBody | undefined;
    return task !== undefined && allows(by, "attempt.work", task.projectId, { resource: { kind: "task", id: taskId } }) ? task.projectId : undefined;
  }

  /**
   * Card L04g: the hash a `record` or `decision` dependency on this desk record is recorded with now (the sha-256 of its content), for a caller who may read it; `undefined` when there is no such record or the caller may not read it.
   */
  async recordHash(by: Principal, recordId: string): Promise<string | undefined> {
    if (typeof recordId !== "string" || recordId.length < 1 || recordId.length > DEPENDENCY_LIMITS.key) return undefined;
    const r = (await this.#runner.get("desk-record", recordId))?.body as unknown as DeskRecordBody | undefined;
    return r === undefined || !canRead(by, r) ? undefined : sha(r.body);
  }

  /**
   * The text the controller read for a recorded entry when it was recorded (card L04g), for the controller's own use (the resume reviewer's view of what changed): only while it is the text of the hash the entry holds now. Nothing
   * when none was kept or the entry was recorded again since.
   */
  async textOf(taskId: string, entry: Pick<DependencyEntry, "id" | "hash">): Promise<string | undefined> {
    if (entry.hash === undefined) return undefined;
    const found = (await this.#runner.get(TEXT_KIND, derivedId("dpt", `${checkTaskId(taskId)}|${entry.id}`)))?.body as unknown as DependencyText | undefined;
    return found !== undefined && found.entryId === entry.id && found.hash === entry.hash.replace(/^sha256:/, "") && typeof found.text === "string" ? found.text : undefined;
  }

  /** The manifest of a task, for those who may work on it, read the project's histories, or the owner. */
  async get(by: Principal, taskId: string): Promise<ManifestBody | undefined> {
    const task = (await this.#runner.get("task", checkTaskId(taskId)))?.body as unknown as TaskBody | undefined;
    if (task === undefined || !(by.kind === "owner" || by.kind === "host" || by.kind === "service" || allows(by, "attempt.work", task.projectId, { resource: { kind: "task", id: taskId } }) || allows(by, "history.read", task.projectId))) return undefined;
    return (await this.#runner.get("dependency-manifest", derivedId("dpm", taskId)))?.body as unknown as ManifestBody | undefined;
  }

  /** Whether each dependency still holds. `observations` maps an entry ID to what the worker sees now. */
  async check(by: Principal, taskId: string, observations: Readonly<Record<string, Observation>> = {}): Promise<DependencyCheck[]> {
    const manifest = await this.get(by, taskId);
    if (manifest === undefined) throw new DomainError("not_found", "no dependency manifest for that task, or none you may read");
    if (typeof observations !== "object" || observations === null || Object.keys(observations).length > DEPENDENCY_LIMITS.observations) invalid("observations", `must map entry IDs to observations (at most ${DEPENDENCY_LIMITS.observations})`);
    const out: DependencyCheck[] = [];
    const searched = await this.#searchAgain(manifest);
    for (const e of manifest.entries) {
      const own = searched.get(e.id);
      const [status, detail] = !(await this.#mayRead(by, e)) ? ((["unknown", "what this refers to is not something you may read"]) as [DependencyStatus, string]) : own !== undefined ? (Array.isArray(own) ? own : await this.#judge(e, own)) : await this.#judge(e, observations[e.id]);
      out.push({ id: e.id, kind: e.kind, key: e.key, status, detail });
    }
    return out;
  }

  // ---- searches the controller makes again (card L04d) ------------------------------------------------------------------------

  /** Whether this caller may ask what to record for a search of the project: the owner (inside a task credential's project), or one who may work a task there or read its desk records or histories. */
  async #maySearchFor(by: Principal, projectId: string): Promise<boolean> {
    if (!inTaskScope(by, projectId)) return false;
    if (by.kind === "owner") return true;
    // A project that does not exist is refused like one the caller has no right in, even for a grant over every project (second review): the answer would otherwise tell which IDs exist.
    if ((await this.#runner.get("project", projectId)) === undefined) return false;
    const own = by.taskScope === undefined ? {} : { resource: { kind: "task", id: by.taskScope.taskId } };
    if (allows(by, "attempt.work", projectId, own) || allows(by, "desk.read", projectId) || allows(by, "history.read", projectId)) return true;
    // A right to work one named task counts as well, only when that task is in this project: a one-task grant whose project is `*` says nothing about other projects (second review).
    for (const g of by.grants) {
      if (g.resource?.kind !== "task" || !allows(by, "attempt.work", projectId, { resource: g.resource })) continue;
      const task = (await this.#runner.get("task", g.resource.id).catch(() => undefined))?.body as unknown as TaskBody | undefined;
      if (task?.projectId === projectId) return true;
    }
    return false;
  }

  /** Whether the controller itself judges this search: it has the port, and the search is of the task's own project. A search of another project stays the worker's to observe. */
  #judgesSearch(e: DependencyEntry, projectId: string): boolean {
    return this.#searches !== undefined && e.kind === "search" && (e.scope?.projectId === undefined || e.scope.projectId === projectId);
  }

  /** A recorded search is made again now with the recorder's rights: the hash must be what it finds, and the position one the stream has reached. The entry then names its reader. */
  async #verifySearch(by: Principal, e: DependencyEntry, projectId: string, field: string): Promise<DependencyEntry> {
    const port = this.#searches!;
    const at = await port.position(projectId);
    if (e.cursor! > at.next) invalid(`${field}.cursor`, `is past the project's event position (${at.next})`);
    const now = await port.digest(by, projectId, e.scope!.query);
    if (now.replace(/^sha256:/, "") !== e.hash!.replace(/^sha256:/, "")) invalid(field, "the hash is not what this search finds now; a dependency is recorded as it was read (resume.dependencies.search gives it)");
    return { ...e, reader: by.id };
  }

  /**
   * The searches of a manifest the controller makes again, each with the rights its recorder has now, at most `DEPENDENCY_LIMITS.searches` of them (the same search by the same reader once). An entry maps to
   * the observation to judge, or straight to a verdict when it could not be made again. It never throws: a failure is `unknown`.
   */
  async #searchAgain(manifest: ManifestBody): Promise<Map<string, Observation | [DependencyStatus, string]>> {
    const out = new Map<string, Observation | [DependencyStatus, string]>();
    const port = this.#searches;
    if (port === undefined) return out;
    const mine = manifest.entries.filter((e) => this.#judgesSearch(e, manifest.projectId));
    if (mine.length === 0) return out;
    let floor: number | undefined;
    try { floor = (await port.position(manifest.projectId)).floor; } catch { floor = undefined; }
    const made = new Map<string, Promise<string | undefined>>();
    let n = 0;
    for (const e of mine) {
      if (e.reader === undefined) { out.set(e.id, ["unknown", "the search was recorded before the controller made searches again, so it was not repeated"]); continue; }
      if (floor === undefined) { out.set(e.id, ["unknown", "the project's event position could not be read, so the search was not repeated"]); continue; }
      const same = `${e.reader}\n${e.scope!.query}`;
      if (!made.has(same)) {
        if (n >= DEPENDENCY_LIMITS.searches) { out.set(e.id, ["unknown", `more than ${DEPENDENCY_LIMITS.searches} searches were recorded; this one was not repeated`]); continue; }
        n++;
        made.set(same, (async () => { const reader = await port.reader(e.reader!); return reader === undefined ? undefined : await port.digest(reader, manifest.projectId, e.scope!.query); })().catch(() => undefined));
      }
      const hash = await made.get(same)!;
      out.set(e.id, hash === undefined ? ["unknown", "the search could not be made again with the rights of whoever made it"] : { hash, cursorFloor: floor });
    }
    return out;
  }

  // ---- internals ------------------------------------------------------------------------------------------------------------

  /** Whether the reader may read what an entry points at (for the kinds the controller judges itself); the worker-observed kinds point at the reader's own task resources. */
  async #mayRead(by: Principal, e: DependencyEntry): Promise<boolean> {
    if (by.kind === "owner") return true;
    switch (e.kind) {
      case "record": case "decision": {
        const r = (await this.#runner.get("desk-record", e.key))?.body as unknown as DeskRecordBody | undefined;
        return r === undefined ? true : canRead(by, r);
      }
      case "tool-version": return this.#mayReadVersion(by, e.key);
      case "environment": return by.id === e.key;
      case "negative": {
        const i = e.key.indexOf(":");
        if (i > 0 && e.key.slice(0, i) === "desk-record") { const r = (await this.#runner.get("desk-record", e.key.slice(i + 1)))?.body as unknown as DeskRecordBody | undefined; return r === undefined ? true : canRead(by, r); }
        if (i > 0 && e.key.slice(0, i) === "catalog-entry") { const r = (await this.#runner.get("catalog-entry", e.key.slice(i + 1)))?.body as unknown as { layer: string; owner?: string } | undefined; return r === undefined ? true : r.layer === "agent" ? r.owner === by.id : allows(by, "catalog.read", undefined); }
        return true;
      }
      default: return true;
    }
  }

  async #mayReadVersion(by: Principal, versionId: string): Promise<boolean> {
    const v = (await this.#runner.get("catalog-version", versionId))?.body as unknown as { name: string } | undefined;
    if (v === undefined) return true;
    const entry = (await this.#runner.get("catalog-entry", derivedId("cat", v.name)))?.body as unknown as { layer: string; owner?: string } | undefined;
    return entry === undefined ? true : entry.layer === "agent" ? entry.owner === by.id : allows(by, "catalog.read", undefined);
  }

  /** Whether the entry was verified against what it names (false when the recorder may not read it and the hash is only its word). */
  async #verifyAtRecording(by: Principal, e: DependencyEntry, field: string): Promise<boolean> {
    const bare = (h: string | undefined): string | undefined => h?.replace(/^sha256:/, "");
    const refuse = (why: string): never => invalid(field, why);
    if (e.kind === "record" || e.kind === "decision") {
      const r = (await this.#runner.get("desk-record", e.key))?.body as unknown as DeskRecordBody | undefined;
      if (r === undefined) return true; // gone already: recorded as seen, it will read as deleted
      if (!canRead(by, r)) return false; // nothing is learned from refusing; it can never be checked by this reader either (`check` says so)
      if (bare(e.hash) !== sha(r.body)) refuse("the hash is not the record's content as it is now; a dependency is recorded as it was read");
    } else if (e.kind === "tool-version") {
      if (!(await this.#mayReadVersion(by, e.key))) return false;
      const v = (await this.#runner.get("catalog-version", e.key))?.body as unknown as { digest: string } | undefined;
      if (v !== undefined && bare(e.hash) !== v.digest) refuse("the hash is not the version's digest");
    } else if (e.kind === "environment") {
      if (by.kind !== "owner" && by.id !== e.key) return false;
      const env = (await this.#runner.get("environment", derivedId("env", e.key)))?.body as unknown as { active?: number } | undefined;
      const rev = env?.active === undefined ? undefined : (await this.#runner.get("environment-revision", derivedId("evr", `${e.key}|${env.active}`)))?.body as unknown as { digest: string } | undefined;
      if (rev !== undefined && bare(e.hash) !== bare(rev.digest)) refuse("the hash is not the active environment revision's digest");
    } else if (e.kind === "negative") {
      const i = e.key.indexOf(":");
      if (i > 0 && (e.key.slice(0, i) === "desk-record" || e.key.slice(0, i) === "catalog-entry") && (await this.#mayRead(by, e))) {
        const exists = (await this.#runner.get(e.key.slice(0, i), e.key.slice(i + 1))) !== undefined;
        if (exists) refuse("that exists, so it is not a negative lookup");
      } else if (i > 0 && (e.key.slice(0, i) === "desk-record" || e.key.slice(0, i) === "catalog-entry")) return false;
    }
    return true;
  }

  #entry(d: NewDependency, field: string, now: string): DependencyEntry {
    if (typeof d !== "object" || d === null) return invalid(field, "must be an object");
    onlyKnown(d as Record<string, unknown>, ["kind", "key", "hash", "etag", "scope", "cursor", "members", "freshness", "server", "protocol"]);
    if (!DEPENDENCY_KINDS.includes(d.kind)) invalid(`${field}.kind`, `must be one of ${DEPENDENCY_KINDS.join(", ")}`);
    if (typeof d.key !== "string" || d.key.length < 1 || d.key.length > DEPENDENCY_LIMITS.key || /[\0\r\n]/.test(d.key)) invalid(`${field}.key`, `must be 1 to ${DEPENDENCY_LIMITS.key} characters on one line`);
    if (d.hash !== undefined && (typeof d.hash !== "string" || !HASH.test(d.hash))) invalid(`${field}.hash`, "must be a sha256 digest");
    if (d.etag !== undefined && (typeof d.etag !== "string" || d.etag.length < 1 || d.etag.length > 200)) invalid(`${field}.etag`, "must be 1 to 200 characters");
    const need = (cond: boolean, what: string): void => { if (!cond) invalid(field, `a ${d.kind} dependency needs ${what}`); };
    switch (d.kind) {
      case "file": case "record": case "decision": case "tool-version": case "environment": need(d.hash !== undefined, "a hash of what was seen"); break;
      case "directory": need(Array.isArray(d.members), "the member names it held"); break;
      case "search": need(d.scope !== undefined && typeof d.scope.query === "string" && d.scope.query.length > 0 && typeof d.cursor === "number" && Number.isSafeInteger(d.cursor) && d.cursor >= 0 && d.hash !== undefined, "its scope and query, the event position it was made at and a hash of its results"); break;
      case "external": need(d.freshness !== undefined && (d.hash !== undefined || d.etag !== undefined), "how its freshness can be checked, and a hash or ETag"); break;
      case "mcp-resource": need(typeof d.server === "string" && d.server.length > 0 && typeof d.protocol === "string" && (d.hash !== undefined || d.etag !== undefined) && d.freshness !== undefined, "the server, protocol revision, hash or ETag and how its freshness can be checked"); break;
      case "negative": break;
    }
    if (d.members !== undefined && (!Array.isArray(d.members) || d.members.length > DEPENDENCY_LIMITS.members || d.members.some((m) => typeof m !== "string" || m.length < 1 || m.length > DEPENDENCY_LIMITS.member))) invalid(`${field}.members`, `must be at most ${DEPENDENCY_LIMITS.members} names`);
    if (d.freshness !== undefined && !["conditional-read", "authoritative-query", "none"].includes(d.freshness)) invalid(`${field}.freshness`, "must be conditional-read, authoritative-query or none");
    return {
      id: dependencyEntryId(d.kind, d.key, d.scope?.projectId), kind: d.kind, key: d.key, observedAt: now,
      ...(d.hash === undefined ? {} : { hash: d.hash }), ...(d.etag === undefined ? {} : { etag: d.etag }), ...(d.scope === undefined ? {} : { scope: d.scope }), ...(d.cursor === undefined ? {} : { cursor: d.cursor }),
      ...(d.members === undefined ? {} : { members: [...d.members].sort() }), ...(d.freshness === undefined ? {} : { freshness: d.freshness }), ...(d.server === undefined ? {} : { server: d.server }), ...(d.protocol === undefined ? {} : { protocol: d.protocol }),
    };
  }

  async #judge(e: DependencyEntry, o: Observation | undefined): Promise<[DependencyStatus, string]> {
    const weak = (t: string): string => t.replace(/^W\//, "");
    const same = (hash?: string, etag?: string): boolean => (e.etag !== undefined && etag !== undefined ? weak(e.etag) === weak(etag) : e.hash !== undefined && hash !== undefined && e.hash.replace(/^sha256:/, "") === hash.replace(/^sha256:/, ""));
    switch (e.kind) {
      case "record": case "decision": {
        const found = await this.#runner.get("desk-record", e.key);
        if (found === undefined) return ["deleted", "the record no longer exists"];
        const record = found.body as unknown as { body: string; status: string };
        return sha(record.body) === e.hash!.replace(/^sha256:/, "") && record.status !== "superseded" ? ["unchanged", "the record is as it was seen"] : ["changed", record.status === "superseded" ? "the record was superseded" : "the record's content differs"];
      }
      case "tool-version": {
        const version = await this.#runner.get("catalog-version", e.key);
        if (version === undefined) return ["deleted", "the version is not in the catalog"];
        const body = version.body as unknown as { digest: string; name: string; version: string };
        const entry = (await this.#runner.get("catalog-entry", derivedId("cat", body.name)))?.body as unknown as { revoked: readonly string[] } | undefined;
        if (entry?.revoked.includes(body.version) === true) return ["changed", "the version was revoked"];
        return body.digest === e.hash!.replace(/^sha256:/, "") ? ["unchanged", "the version is as it was seen"] : ["changed", "the version's digest differs"];
      }
      case "environment": {
        const env = (await this.#runner.get("environment", derivedId("env", e.key)))?.body as unknown as { active?: number } | undefined;
        if (env?.active === undefined) return ["deleted", "the agent has no active environment revision"];
        const rev = (await this.#runner.get("environment-revision", derivedId("evr", `${e.key}|${env.active}`)))?.body as unknown as { digest: string };
        return rev.digest.replace(/^sha256:/, "") === e.hash!.replace(/^sha256:/, "") ? ["unchanged", "the active environment revision is the one seen"] : ["changed", `the active environment moved to revision ${env.active}`];
      }
      case "negative": {
        const [kind, id] = e.key.includes(":") ? [e.key.slice(0, e.key.indexOf(":")), e.key.slice(e.key.indexOf(":") + 1)] : ["", e.key];
        if (kind === "desk-record" || kind === "catalog-entry") return (await this.#runner.get(kind, id)) === undefined ? ["unchanged", "there is still no such record"] : ["changed", "a record that was absent now exists"];
        if (o?.exists === undefined) return ["unknown", "whether it exists now was not observed"];
        return o.exists ? ["changed", "something that was absent now exists"] : ["unchanged", "it is still absent"];
      }
      case "search": {
        if (o === undefined) return ["unknown", "the search was not repeated"];
        if (o.cursorFloor === undefined) return ["unknown", "the oldest readable event position was not given, so whether this search's position is still covered cannot be told"];
        if (e.cursor! < o.cursorFloor) return ["cursor-expired", `the search was made at event ${e.cursor}, and events before ${o.cursorFloor} can no longer be read`];
        if (o.hash === undefined) return ["unknown", "no result hash was observed"];
        return same(o.hash) ? ["unchanged", "the same results"] : ["changed", "the results differ"];
      }
      case "directory": {
        if (o === undefined) return ["unknown", "the directory was not listed again"];
        // A probe that looked and found nothing says so; a listing that came back without members is still no listing at all.
        if (o.exists === false) return ["deleted", "the directory is gone"];
        if (o.members === undefined) return ["unknown", "the directory was not listed again"];
        const added = o.members.filter((m) => !e.members!.includes(m));
        const removed = e.members!.filter((m) => !o.members!.includes(m));
        const list = (xs: string[]): string => `${xs.slice(0, 5).join(", ")}${xs.length > 5 ? "…" : ""}`;
        if (added.length > 0) return ["new-members", `new: ${list(added)}${removed.length > 0 ? `; gone: ${list(removed)}` : ""}`];
        return removed.length > 0 ? ["changed", `gone: ${list(removed)}`] : ["unchanged", "the same members"];
      }
      case "file": {
        if (o === undefined) return ["unknown", "the file was not read again"];
        if (o.exists === false) return ["deleted", "the file is gone"];
        if (o.hash === undefined) return ["unknown", "no hash was observed"];
        return same(o.hash) ? ["unchanged", "the same content"] : ["changed", "the content differs"];
      }
      case "external": case "mcp-resource": {
        if (e.freshness === "none") return ["freshness-uncertain", "this resource was recorded without a conditional read or an authoritative query, so whether it changed cannot be told"];
        if (o === undefined) return ["unknown", "it was not read again"];
        // Card L04g: the reader says why it did not read (not allowed, no grant, no answer); the reason is shown, the status stays unknown.
        if (o.exists === undefined && o.hash === undefined && o.etag === undefined) return ["unknown", typeof o.unread === "string" && o.unread.length > 0 ? `it was not read again: ${clipReason(o.unread)}` : "it was not read again"];
        if (o.exists === false) return ["deleted", "the resource is gone"];
        if (o.hash === undefined && o.etag === undefined) return ["unknown", "no hash or ETag was observed"];
        return same(o.hash, o.etag) ? ["unchanged", "the same hash or ETag"] : ["changed", "the hash or ETag differs"];
      }
    }
  }
}
