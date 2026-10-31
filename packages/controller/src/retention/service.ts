import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { CommandRunner, type Built, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { Principal } from "../security/principals.js";
import { redact, redactText } from "../security/redact.js";
import { canonicalJson, sha256 } from "../storage/json.js";
import type { Aggregate, Change, ControllerStorage, JsonObject } from "../storage/types.js";
import { diskSpace, QuotaMeter, type ReserveFile } from "./guard.js";
import { stubDeskBody, type DeletionLedger } from "./ledger.js";
import { RetainedMaterial } from "./references.js";
import type { RetentionSettingsService, RetentionValues } from "./settings.js";

const DAY = 86_400_000;
const RUN_LIMIT = { default: 200, max: 1000 } as const;
const SCAN_LIMIT = 50_000;
/** The most operations one deletion request performs; past it the answer is `partial` with `remaining`, and the same command continues. */
const DELETE_MEMBERS = 400;
/** Holds are looked at again before each batch of this many removals. */
const BATCH = 25;
/** The runner reads the holds again before each batch of this many removals. */
const REMOVE_BATCH = 25;
interface Plan { desk: string[]; summaries: string[]; compactions: string[]; archives: string[]; others: { kind: string; id: string }[] }
interface Found { desk: Aggregate[]; summaries: Aggregate[]; compactions: Aggregate[]; archives: Aggregate[]; others: { kind: string; id: string }[]; complete: boolean }
const RECORD_ID = /^dsk-[a-z2-7]{20}$/;
const TASK_ID = /^task-[a-z2-7]{20}$/;
const PROJECT_ID = /^proj-[a-z2-7]{20}$/;

/** The derived stores the runner expires, and what each one is derived from. A new store of summaries, indexes or cached replies adds itself here, so retention, export and deletion see it (card K06). */
export const DERIVED_KINDS = ["summary-record", "meeting-summary", "standup-brief"] as const;
/** Honest statement of what does not exist, written into every deletion record so a later store is noticed. */
const NOT_STORED = { indexes: "none exist: search reads the live records with the reader's rights each time", cachedReplies: "none are stored: the inference cache holds prompt markers, not replies" } as const;

/** The backup folder as retention sees it (BackupService provides it). */
export interface BackupPort {
  list(): Promise<readonly { readonly path: string; readonly at: string; readonly trusted: boolean; readonly manifest: { readonly name: string; readonly kind: string } }[]>;
  /** What the rule would delete (`preview`) or deletes now, under the given counts. */
  preview(retention: { daily: number; weekly: number; preRestoreKept?: number | null; preRestoreMaxAgeDays?: number | null }): Promise<string[]>;
  prune(retention: { daily: number; weekly: number; preRestoreKept?: number | null; preRestoreMaxAgeDays?: number | null }): Promise<string[]>;
}
export interface IncidentPort {
  archive(by: Principal, options: { olderThanDays?: number; limit?: number; projectId?: string }): Promise<number>;
  purge(by: Principal, options: { olderThanDays: number; limit?: number; projectId?: string }): Promise<number>;
}
export interface CatalogRetentionPort {
  retentionCandidates(by: Principal, keep: number, limit: number): Promise<{ items: { name: string; version: string; versionId: string; revision: number; ageDays: number }[]; partial: boolean }>;
  revokedExecutables(by: Principal, olderThanDays: number, limit: number): Promise<{ items: { name: string; version: string; versionId: string; recordId: string; ageDays: number; digest: string; revision: number }[]; partial: boolean }>;
  dropVersion(by: Principal, drop: { name: string; version: string; revision: number; keep: number }, holds?: (versionId: string) => Promise<readonly string[] | undefined>): Promise<{ dropped: boolean; held?: readonly string[] }>;
}

export interface RetentionDeps {
  /** The tool catalogue, for the old-versions rule (card T02c). Absent: that rule does nothing. */
  readonly catalog?: CatalogRetentionPort;
  readonly settings: Pick<RetentionSettingsService, "effective">;
  readonly backups?: BackupPort;
  readonly incidents?: IncidentPort;
  readonly projects?: () => Promise<readonly string[]>;
  /** Tells the owner (a controller-set notice). The command ID makes it once per period. */
  readonly notify?: (notice: { commandId: string; text: string; ref: { kind: string; id: string } }) => Promise<void>;
  readonly reserve?: ReserveFile;
  readonly meter?: QuotaMeter;
  readonly dataDirectory?: string;
  /** The least time between two automatic runs of the runner (default one hour: a run reads the whole store). */
  readonly autoEveryMs?: number;
  readonly now?: () => number;
  /** Where user-requested deletions are recorded outside the database, so a restore of an older backup re-applies them. */
  readonly ledger?: DeletionLedger;
  /** A test seam: called before each batch of removals. */
  readonly beforeBatch?: (batch: number) => Promise<void>;
}

const isOwner = (by: Principal): boolean => by.kind === "owner";
const isDispatcher = (by: Principal): boolean => by.kind === "owner" || by.kind === "service" || by.kind === "host";
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const digestOf = (v: unknown): string => sha256(canonicalJson(v as never));
const cmdId = (prefix: string, ...parts: (string | number)[]): string => `${prefix}-${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 40)}`;

async function scan(runner: CommandRunner, kind: string, each: (a: Aggregate) => void, limit = SCAN_LIMIT): Promise<boolean> {
  let after: string | undefined; let seen = 0;
  for (;;) {
    const page = await runner.list(kind, { ...(after === undefined ? {} : { afterId: after }), limit: 500 });
    for (const a of page) each(a);
    seen += page.length;
    if (page.length < 500) return true;
    if (seen >= limit) return false;
    after = page[page.length - 1]!.id;
  }
}

export interface Candidate { readonly kind: string; readonly id: string; readonly revision: number; readonly projectId: string | undefined; readonly ageDays: number }
export interface RunReport {
  readonly dryRun: boolean;
  readonly enabled: boolean;
  readonly derivedDays: number | null;
  /** What the derived-data rule would remove (or removed), with its project and age. */
  readonly candidates: Candidate[];
  readonly removed: number;
  /** Candidates a resumable task or replay still needs: kept, and shown as retained with why. */
  readonly retained: { kind: string; id: string; reasons: string[] }[];
  readonly partial: boolean;
  /** Present on a preview: pass it back as `confirm` to run exactly what was shown. */
  readonly digest?: string;
  readonly backups?: { kept: number; wouldDelete?: string[]; deleted?: string[]; counts: { daily: number; weekly: number; preRestoreKept?: number | null; preRestoreMaxAgeDays?: number | null } };
  readonly incidents?: { archiveDays: number | null; purgeDays: number | null; archived?: number; purged?: number };
  /** The old-versions rule for the tool catalogue (off unless `catalogVersionsKept` is set): what it would drop (or dropped), and the versions kept because a resumable task used them. */
  readonly catalogVersions?: { keep: number; candidates: { name: string; version: string; ageDays: number }[]; retained: { name: string; version: string; reasons: string[] }[]; removed: number; partial: boolean };
  /** Executable text of revoked versions (off when `revokedBytesDays` is null): what it would blank (or blanked). The record, digest and revocation stay. */
  readonly revokedBytes?: { days: number; candidates: { name: string; version: string; ageDays: number }[]; blanked: number; partial: boolean };
  readonly runId?: string;
}

export interface DeletionReport {
  readonly status: "deleted" | "retained" | "preview" | "partial";
  readonly recordId: string;
  readonly retained?: { kind: string; id: string; reasons: string[] }[];
  readonly derived: { copies: string[]; summaries: string[]; compactions: string[]; archives: string[]; others: string[]; indexes: string; cachedReplies: string };
  readonly backups: { handling: string; holding: number; staysUpToDays: number | null; note: string };
  readonly deletionId?: string;
  /** More members than one request handles: ask again (the same command) to finish. */
  readonly remaining?: number;
}

/**
 * Retention, quotas, archive, export and deletion (card K06). Nothing here deletes unless the owner asked or set a rule: the runner does nothing while `derivedDays` is unset, a user-requested deletion is an owner command, and what a resumable task
 * or a replay needs is refused as retained. Every removal is a guarded delete with an audit record (and a storage tombstone), so it is recorded and a stale holder cannot write over it.
 */
export class RetentionService {
  readonly #runner: CommandRunner;
  readonly #deps: RetentionDeps;
  #lastAuto: number | undefined;
  private constructor(runner: CommandRunner, deps: RetentionDeps) { this.#runner = runner; this.#deps = deps; }
  static withEpoch(storage: ControllerStorage, epoch: number, deps: RetentionDeps, options: RunnerOptions = {}): RetentionService { return new RetentionService(new CommandRunner(storage, epoch, options), deps); }

  // ---- status ---------------------------------------------------------------------------------------------------------------

  /** The owner's view: the values in force, the disk and the reserve, quota use with warnings, backups and the last deletions. */
  async status(by: Principal): Promise<JsonObject> {
    if (!isOwner(by)) throw new DomainError("forbidden", `${by.id} may not read the retention status`);
    return this.#status();
  }

  async #status(): Promise<JsonObject> {
    const values = await this.#deps.settings.effective();
    const space = this.#deps.dataDirectory === undefined ? undefined : await diskSpace(this.#deps.dataDirectory);
    const warnings: string[] = [];
    const { quotas, partial } = await this.#quotaLevels(values);
    for (const q of quotas) warnings.push(`${q.scope} ${q.id} is at ${q.percent}% of its storage quota`);
    const reserve = this.#deps.reserve;
    if (reserve !== undefined && reserve.released) warnings.push("the reserve for shutdown and recovery records is in use: only those records are written until room is made");
    else if (reserve !== undefined && reserve.short) warnings.push("the disk has too little room to set the reserve aside");
    if (space !== undefined && space.totalBytes > 0 && space.freeBytes * 10 < space.totalBytes) warnings.push(`the data disk has ${Math.floor((space.freeBytes * 100) / space.totalBytes)}% free`);
    const deletions = (await this.#recent("retention-deletion", 20)).map((a) => ({ id: a.id, ...(a.body as object) }));
    return {
      values: values as unknown as JsonObject,
      disk: { ...(space === undefined ? {} : { freeBytes: space.freeBytes, totalBytes: space.totalBytes }), reserve: { wantedBytes: reserve?.wanted ?? 0, inUse: reserve?.released ?? false, short: reserve?.short ?? false, ...(reserve?.releasedAt === undefined ? {} : { usedAt: reserve.releasedAt }) } },
      quotas: quotas as unknown as JsonObject[], quotaUsagePartial: partial, warnings,
      backups: this.#deps.backups === undefined ? { configured: false } : { configured: true, count: (await this.#deps.backups.list()).length, counts: { daily: values.backupDaily, weekly: values.backupWeekly } },
      deletions: deletions as unknown as JsonObject[],
    } as unknown as JsonObject;
  }

  /** The scopes at or over the warning level of a quota that is set. Nothing is counted while no quota is set. */
  async #quotaLevels(values: RetentionValues): Promise<{ quotas: { scope: string; id: string; used: number; quota: number; percent: number; level: "warn" | "full" }[]; partial: boolean }> {
    const quotas: { scope: string; id: string; used: number; quota: number; percent: number; level: "warn" | "full" }[] = [];
    if (this.#deps.meter === undefined || (values.quotaProjectBytes === null && values.quotaAgentBytes === null)) return { quotas, partial: false };
    const usage = await this.#deps.meter.usage();
    const add = (scope: string, map: ReadonlyMap<string, number>, quota: number | null): void => {
      if (quota === null) return;
      for (const [id, used] of map) {
        const percent = Math.floor((used * 100) / quota);
        if (percent >= values.quotaWarnPercent) quotas.push({ scope, id, used, quota, percent, level: percent >= 100 ? "full" : "warn" });
      }
    };
    add("project", usage.byProject, values.quotaProjectBytes); add("agent", usage.byAgent, values.quotaAgentBytes);
    return { quotas, partial: usage.partial };
  }

  async #recent(kind: string, n: number): Promise<Aggregate[]> {
    const all: Aggregate[] = [];
    await scan(this.#runner, kind, (a) => all.push(a), SCAN_LIMIT);
    // Newest first by the time of the record (not by the order of the IDs, which is a hash); ties by ID.
    return all.sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1)).slice(0, n);
  }

  /** Whether the record is held by a resumable task or a replay, and why. */
  async check(by: Principal, ref: { kind: string; id: string }): Promise<{ kind: string; id: string; retained: boolean; reasons: string[] }> {
    if (!isOwner(by)) throw new DomainError("forbidden", `${by.id} may not ask what is retained`);
    if (typeof ref.kind !== "string" || typeof ref.id !== "string") invalid("ref", "needs a kind and an id");
    const material = await RetainedMaterial.build(this.#runner.storage, { routeArchive: ref.kind === "ctx-route-archive" });
    const reasons = material.why(ref.kind, ref.id) ?? [];
    return { kind: ref.kind, id: ref.id, retained: reasons.length > 0, reasons };
  }

  // ---- the runner -----------------------------------------------------------------------------------------------------------

  /**
   * The retention runner. Preview (the default) lists what the rule would remove from derived data and backups, and gives a digest; running it needs that digest back (`confirm`), so what is removed is what was shown.
   * Nothing is removed while `derivedDays` is unset. Incident archive and purge follow their own ages when set. A resumable task's or a replay's material is skipped and shown as retained.
   */
  async run(by: Principal, options: { dryRun?: boolean; confirm?: string; limit?: number; commandId?: string } = {}): Promise<RunReport> {
    if (!isOwner(by)) throw new DomainError("forbidden", `${by.id} may not run retention by hand`);
    return this.#run(by, options, false);
  }

  /** The dispatcher's pass: does the same as an owner's confirmed run, only when `autoRun` is set. */
  async sweep(by: Principal): Promise<RunReport | undefined> {
    if (!isDispatcher(by)) throw new DomainError("forbidden", `${by.id} is not the dispatcher`);
    const values = await this.#deps.settings.effective();
    await this.#warn(values);
    if (!values.autoRun) return undefined;
    // A run reads the whole store, so it is not made every tick.
    const clock = (this.#deps.now ?? Date.now)();
    if (this.#lastAuto !== undefined && clock - this.#lastAuto < (this.#deps.autoEveryMs ?? 3_600_000)) return undefined;
    this.#lastAuto = clock;
    return this.#run(by, { dryRun: false }, true);
  }

  async #run(by: Principal, options: { dryRun?: boolean; confirm?: string; limit?: number; commandId?: string }, auto: boolean): Promise<RunReport> {
    const dryRun = options.dryRun ?? true;
    const limit = options.limit ?? RUN_LIMIT.default;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > RUN_LIMIT.max) invalid("limit", `must be a whole number from 1 to ${RUN_LIMIT.max}`);
    const values = await this.#deps.settings.effective();
    const now = Date.parse(this.#runner.now());
    const candidates: Candidate[] = []; const retained: RunReport["retained"] = [];
    let partial = false;
    if (values.derivedDays !== null) {
      const cutoff = now - values.derivedDays * DAY;
      const material = await RetainedMaterial.build(this.#runner.storage);
      for (const kind of DERIVED_KINDS) {
        const complete = await scan(this.#runner, kind, (a) => {
          if (Date.parse(a.updatedAt) >= cutoff) return;
          const why = material.why(kind, a.id);
          const projectId = (a.body as { projectId?: unknown }).projectId;
          if (why !== undefined) { if (retained.length < 200) retained.push({ kind, id: a.id, reasons: why }); return; }
          candidates.push({ kind, id: a.id, revision: a.revision, projectId: typeof projectId === "string" ? projectId : undefined, ageDays: Math.floor((now - Date.parse(a.updatedAt)) / DAY) });
        });
        if (!complete) partial = true;
      }
      candidates.sort((a, b) => (a.kind === b.kind ? (a.id < b.id ? -1 : 1) : a.kind < b.kind ? -1 : 1));
      if (candidates.length > limit) { candidates.length = limit; partial = true; }
    }
    if (values.generationRunDays !== null) {
      // Recorded model replies (K06 retention of card L05b): only runs that are over, and that hold no call that could still be admitted.
      const cutoff = now - values.generationRunDays * DAY;
      const complete = await scan(this.#runner, "generation-run", (a) => {
        if (Date.parse(a.updatedAt) >= cutoff) return;
        const run = a.body as { state?: unknown; toolCalls?: { state?: unknown }[]; projectId?: unknown };
        if (run.state === "streaming" || run.state === "held" || (run.toolCalls ?? []).some((c) => c.state === "complete" || c.state === "held" || c.state === "admitted")) return;
        candidates.push({ kind: "generation-run", id: a.id, revision: a.revision, projectId: typeof run.projectId === "string" ? run.projectId : undefined, ageDays: Math.floor((now - Date.parse(a.updatedAt)) / DAY) });
      });
      if (!complete) partial = true;
      if (candidates.length > limit) { candidates.length = limit; partial = true; }
    }
    if (values.contextRouteDays !== null) {
      // Route-change records of the context (card C07f): the archive of cut text and the decisions of a route move (not a first-call admission, which calibration reads).
      const cutoff = now - values.contextRouteDays * DAY;
      // The archive of a task that is not done or cancelled is still cited by the prompts built for it, so it is held (like the other material a resumable task needs).
      const material = await RetainedMaterial.build(this.#runner.storage, { routeArchive: true });
      for (const kind of ["ctx-route-archive", "ctx-admission"]) {
        const complete = await scan(this.#runner, kind, (a) => {
          if (Date.parse(a.updatedAt) >= cutoff) return;
          if (kind === "ctx-admission" && (a.body as { type?: unknown }).type !== "route-change") return;
          const why = material.why(kind, a.id);
          if (why !== undefined) { if (retained.length < 200) retained.push({ kind, id: a.id, reasons: why }); return; }
          const projectId = (a.body as { projectId?: unknown }).projectId;
          candidates.push({ kind, id: a.id, revision: a.revision, projectId: typeof projectId === "string" ? projectId : undefined, ageDays: Math.floor((now - Date.parse(a.updatedAt)) / DAY) });
        });
        if (!complete) partial = true;
      }
      if (candidates.length > limit) { candidates.length = limit; partial = true; }
    }
    const keepVersions = values.catalogVersionsKept;
    let versions: { items: { name: string; version: string; versionId: string; revision: number; ageDays: number }[]; partial: boolean } | undefined;
    const versionsRetained: { name: string; version: string; reasons: string[] }[] = [];
    if (keepVersions !== null && this.#deps.catalog !== undefined && (!auto || values.catalogAutoDrop)) {
      const found = await this.#deps.catalog.retentionCandidates(by, keepVersions, limit);
      const material = await RetainedMaterial.build(this.#runner.storage);
      const free = found.items.filter((v) => { const why = material.why("catalog-version", v.versionId); if (why !== undefined) { if (versionsRetained.length < 200) versionsRetained.push({ name: v.name, version: v.version, reasons: why }); return false; } return true; });
      versions = { items: free, partial: found.partial };
      if (found.partial) partial = true;
    }
    let revoked: { items: { name: string; version: string; versionId: string; recordId: string; ageDays: number; digest: string; revision: number }[]; partial: boolean } | undefined;
    if (values.revokedBytesDays !== null && values.revokedBytesBlank && this.#deps.catalog !== undefined) {
      const found = await this.#deps.catalog.revokedExecutables(by, values.revokedBytesDays, limit);
      // A record something still cites (a resumable task's context or checkpoint, a dependency manifest) is not blanked.
      const material = await RetainedMaterial.build(this.#runner.storage);
      revoked = { items: found.items.filter((r) => material.why("desk-record", r.recordId) === undefined), partial: found.partial };
      if (revoked.partial) partial = true;
    }
    const counts = { daily: values.backupDaily, weekly: values.backupWeekly, preRestoreKept: values.preRestoreKept, preRestoreMaxAgeDays: values.preRestoreMaxAgeDays };
    const backupsPort = this.#deps.backups;
    const wouldDelete = backupsPort === undefined ? undefined : await backupsPort.preview(counts);
    const digest = digestOf({ c: candidates.map((c) => `${c.kind}/${c.id}@${c.revision}`), b: wouldDelete ?? [], i: [values.incidentArchiveDays, values.incidentPurgeDays], v: versions === undefined ? null : [keepVersions, ...versions.items.map((v) => `${v.versionId}@${v.revision}`)], x: revoked === undefined ? null : [values.revokedBytesDays, ...revoked.items.map((r) => r.recordId)] });
    const base: RunReport = {
      dryRun, enabled: values.derivedDays !== null || values.generationRunDays !== null || values.contextRouteDays !== null, derivedDays: values.derivedDays, candidates, removed: 0, retained, partial,
      ...(backupsPort === undefined ? {} : { backups: { kept: (await backupsPort.list()).length - (wouldDelete?.length ?? 0), ...(dryRun ? { wouldDelete: wouldDelete ?? [] } : {}), counts } }),
      ...(this.#deps.incidents === undefined ? {} : { incidents: { archiveDays: values.incidentArchiveDays, purgeDays: values.incidentPurgeDays } }),
      ...(revoked === undefined ? {} : { revokedBytes: { days: values.revokedBytesDays!, candidates: revoked.items.map((r) => ({ name: r.name, version: r.version, ageDays: r.ageDays })), blanked: 0, partial: revoked.partial } }),
      ...(versions === undefined ? {} : { catalogVersions: { keep: keepVersions!, candidates: versions.items.map((v) => ({ name: v.name, version: v.version, ageDays: v.ageDays })), retained: versionsRetained, removed: 0, partial: versions.partial } }),
    };
    if (dryRun) return { ...base, digest };
    if (!auto && options.confirm !== digest) throw new DomainError("invalid_command", "confirm: what retention would remove has changed since the preview (or confirm was not given); preview again and pass its digest", { field: "confirm" });

    const removedIds: string[] = [];
    // A hold can appear while the run is going (a task resumes, a checkpoint cites a summary): the holds are read again before every batch, and a candidate held now is kept and shown as retained.
    for (let i = 0; i < candidates.length; i += REMOVE_BATCH) {
      await this.#deps.beforeBatch?.(i / REMOVE_BATCH);
      const material = await RetainedMaterial.build(this.#runner.storage, { routeArchive: candidates.slice(i, i + REMOVE_BATCH).some((c) => c.kind === "ctx-route-archive") });
      for (const c of candidates.slice(i, i + REMOVE_BATCH)) {
        const why = material.why(c.kind, c.id);
        if (why !== undefined) { if (retained.length < 200) retained.push({ kind: c.kind, id: c.id, reasons: why }); continue; }
        const done = await this.#removeOne(by, c, c.kind === "generation-run" ? values.generationRunDays! : c.kind === "ctx-route-archive" || c.kind === "ctx-admission" ? values.contextRouteDays! : values.derivedDays!);
        if (done) removedIds.push(`${c.kind}/${c.id}`);
      }
    }
    let versionsRemoved = 0;
    if (versions !== undefined && keepVersions !== null && this.#deps.catalog !== undefined) {
      for (let i = 0; i < versions.items.length; i += REMOVE_BATCH) {
        await this.#deps.beforeBatch?.(i / REMOVE_BATCH);
        // A task can resume, or use a version, while the run goes: the holds are read again before each batch.
        const material = await RetainedMaterial.build(this.#runner.storage);
        for (const v of versions.items.slice(i, i + REMOVE_BATCH)) {
          const why = material.why("catalog-version", v.versionId);
          if (why !== undefined) { if (versionsRetained.length < 200) versionsRetained.push({ name: v.name, version: v.version, reasons: why }); continue; }
          // The holds are read once more inside the drop, after the version is claimed and nothing new can start on it (a call or a task can take a version between the batch's read and here).
          const dropped = await this.#deps.catalog.dropVersion(by, { name: v.name, version: v.version, revision: v.revision, keep: keepVersions }, async (versionId) => (await RetainedMaterial.build(this.#runner.storage)).why("catalog-version", versionId));
          if (dropped.held !== undefined && versionsRetained.length < 200) versionsRetained.push({ name: v.name, version: v.version, reasons: [...dropped.held] });
          if (dropped.dropped) { versionsRemoved += 1; removedIds.push(`catalog-version/${v.versionId}`); }
        }
      }
    }
    let blanked = 0;
    if (revoked !== undefined) for (const r of revoked.items) if (await this.#blankExecutable(by, r)) { blanked += 1; removedIds.push(`desk-record/${r.recordId}`); }
    let deleted: string[] | undefined;
    if (backupsPort !== undefined) deleted = await backupsPort.prune(counts);
    let archived: number | undefined; let purged: number | undefined;
    if (this.#deps.incidents !== undefined && this.#deps.projects !== undefined) {
      archived = 0; purged = 0;
      for (const projectId of await this.#deps.projects()) {
        if (values.incidentArchiveDays !== null) archived += await this.#deps.incidents.archive(by, { olderThanDays: values.incidentArchiveDays, projectId });
        if (values.incidentPurgeDays !== null) purged += await this.#deps.incidents.purge(by, { olderThanDays: values.incidentPurgeDays, projectId });
      }
    }
    // The record of the run: what was removed (IDs only, never content), kept in the same shape the owner reads.
    const runId = derivedId("rtr", options.commandId !== undefined ? scopedCommandId(by.id, options.commandId) : `${by.id}\0run\0${now}\0${digest}`);
    const stamp = this.#runner.now();
    await this.#runner.command("retention.run", { commandId: `rtr-${runId}`, actor: by.id }, async () => ({
      payload: { digest },
      build: async (): Promise<Built> => {
        const ref = { kind: "retention-run", id: runId };
        const body = { at: stamp, by: by.id, auto, derivedDays: values.derivedDays, removed: removedIds.slice(0, 200), removedCount: removedIds.length, retained: retained.length, backupsDeleted: deleted ?? [], incidentsArchived: archived ?? 0, incidentsPurged: purged ?? 0 } as unknown as JsonObject;
        return { ref, creates: true, changes: [{ type: "create", ref, body }], detail: { removed: removedIds.length, backupsDeleted: deleted?.length ?? 0 } };
      },
    }));
    return {
      ...base, dryRun: false, removed: removedIds.length, runId,
      ...(versions === undefined ? {} : { catalogVersions: { ...base.catalogVersions!, retained: versionsRetained, removed: versionsRemoved } }),
      ...(revoked === undefined ? {} : { revokedBytes: { ...base.revokedBytes!, blanked } }),
      ...(backupsPort === undefined ? {} : { backups: { kept: (await backupsPort.list()).length, deleted: deleted ?? [], counts } }),
      ...(this.#deps.incidents === undefined ? {} : { incidents: { archiveDays: values.incidentArchiveDays, purgeDays: values.incidentPurgeDays, ...(archived === undefined ? {} : { archived }), ...(purged === undefined ? {} : { purged }) } }),
    };
  }

  /** Blanks the executable text of one revoked version's record (title and body gone, a marker left), guarded by the revision read now; the deletion ledger is written first so a restore of an older backup blanks it again. */
  async #blankExecutable(by: Principal, r: { name: string; version: string; versionId: string; recordId: string; digest: string; revision: number }): Promise<boolean> {
    const found = await this.#runner.get("desk-record", r.recordId);
    if (found === undefined) return false;
    const body = found.body as Record<string, unknown>;
    if (body["deleted"] !== undefined) return false;
    // Only the content that was revoked: a record edited since the registration (new text or a new revision) is somebody's live work and stays.
    if (typeof body["body"] !== "string" || createHash("sha256").update(body["body"]).digest("hex") !== r.digest || found.revision !== r.revision) return false;
    // Something may cite it since the preview.
    if ((await RetainedMaterial.build(this.#runner.storage)).why("desk-record", r.recordId) !== undefined) return false;
    const at = this.#runner.now();
    const deletionId = cmdId("rtb", r.versionId, r.recordId);
    try {
      await this.#runner.command("retention.revoked-bytes", { commandId: cmdId("rtb", r.versionId, found.revision), actor: by.id }, async () => ({
        payload: { versionId: r.versionId, recordId: r.recordId, revision: found.revision },
        build: async (): Promise<Built> => {
          const fresh = await this.#runner.get("desk-record", r.recordId);
          if (fresh === undefined || fresh.revision !== found.revision) throw new DomainError("stale_revision", "changed since the preview");
          const ref = { kind: "desk-record", id: r.recordId };
          const stub = stubDeskBody(body, { at, by: by.id, reason: `executable of revoked ${r.name} ${r.version}`.slice(0, 200), contentDigest: digestOf({ title: body["title"] ?? "", body: body["body"] ?? "" }) });
          return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: fresh.revision, body: stub as JsonObject }], detail: { rule: "revoked-bytes-days", name: r.name, version: r.version } };
        },
      }));
      // The ledger outside the database is written once the guarded command has gone through, so a record that was left alone never has an entry that a restore of an older backup would apply to it.
      await this.#deps.ledger?.append({ deletionId, at, by: by.id, reason: `executable of revoked ${r.name} ${r.version}`.slice(0, 200), desk: [r.recordId], compactions: [], removed: [] });
      return true;
    } catch (error) {
      if (error instanceof DomainError && (error.code === "stale_revision" || error.code === "not_found")) return false;
      throw error;
    }
  }

  /** One guarded removal, recorded. A record that changed or is gone since the preview is skipped. */
  async #removeOne(by: Principal, c: Candidate, days: number): Promise<boolean> {
    try {
      const r = await this.#runner.command("retention.expire", { commandId: cmdId("rtx", c.kind, c.id, c.revision), actor: by.id }, async () => ({
        payload: { kind: c.kind, id: c.id, revision: c.revision },
        build: async (): Promise<Built> => {
          const fresh = await this.#runner.get(c.kind, c.id);
          if (fresh === undefined || fresh.revision !== c.revision) throw new DomainError("stale_revision", "changed since the preview");
          const ref = { kind: c.kind, id: c.id };
          // The archive of an archived stub goes with it: its original text must not outlive the stub.
          const arc = await this.#runner.get("retention-archive", archiveIdOf(c.id));
          const changes: Change[] = [{ type: "delete", ref, expectedRevision: fresh.revision }];
          if (arc !== undefined) changes.push({ type: "delete", ref: { kind: "retention-archive", id: arc.id }, expectedRevision: arc.revision });
          return { ref, creates: false, changes, ...(arc === undefined ? {} : { audit: [{ type: "retention.expire.archive", subject: { kind: "retention-archive", id: arc.id }, detail: { with: c.id } }] }), detail: { rule: c.kind === "generation-run" ? "generation-run-days" : c.kind === "ctx-route-archive" || c.kind === "ctx-admission" ? "context-route-days" : "derived-days", days, ageDays: c.ageDays, ...(c.projectId === undefined ? {} : { projectId: c.projectId }) } };
        },
      }));
      return !r.replayed;
    } catch (error) {
      if (error instanceof DomainError && (error.code === "stale_revision" || error.code === "not_found")) return false;
      throw error;
    }
  }

  // ---- warnings ---------------------------------------------------------------------------------------------------------------

  /** One visible notice per scope and level per week (and for the reserve in use). Quota use that cannot be counted is not guessed. */
  async #warn(values: RetentionValues): Promise<void> {
    const notify = this.#deps.notify;
    if (notify === undefined) return;
    const week = Math.floor(Date.parse(this.#runner.now()) / (7 * DAY));
    const { quotas } = await this.#quotaLevels(values).catch(() => ({ quotas: [] as { scope: string; id: string; used: number; quota: number; percent: number; level: "warn" | "full" }[] }));
    // The text is the same for a given ID (the figures are in the status), so a retried notice is the one already sent; a clash is not an error of the sweep.
    const tell = async (n: Parameters<NonNullable<RetentionDeps["notify"]>>[0]): Promise<void> => { try { await notify(n); } catch (error) { if (!(error instanceof DomainError && error.code === "command_conflict")) throw error; } };
    for (const q of quotas) {
      await tell({ commandId: cmdId("rtw", "quota", q.scope, q.id, q.level, week), text: `Storage quota: ${q.scope} ${q.id} has reached ${q.level === "full" ? "its quota; new records from it are refused until you raise the quota or delete something" : `${values.quotaWarnPercent}% of its quota`}. See retention.status.`, ref: q.scope === "project" ? { kind: "project", id: q.id } : { kind: "quota", id: `a-${createHash("sha256").update(q.id).digest("hex").slice(0, 20)}` } });
    }
    if (this.#deps.reserve?.released === true) await tell({ commandId: cmdId("rtw", "reserve", week), text: "The data disk is nearly full and the reserve for shutdown and recovery records is in use. Only those records are written until room is made.", ref: { kind: "installation", id: "main" } });
  }

  // ---- user-requested deletion ----------------------------------------------------------------------------------------------

  /**
   * The owner deletes a desk record and what was made from it: the copies other agents made of it, the summaries that cite it (removed), the compactions that cite it and every later compaction built on them (their summary text blanked
   * and marked, and their summary records removed), meeting summaries and stand-up briefs that quote it, and any archive of it. The text goes; a digest, who, why and when stay. A record a resumable task or a replay needs is NOT
   * deleted: the request is recorded as retained, with the reasons, and nothing changes. Existing backups are not altered: they hold the text until they expire, the answer says for how long, and a restore re-applies the deletion
   * ledger kept next to the backups. Indexes and cached replies: none exist (said in the record).
   *
   * The work is resumable: the first thing written is a deletion record "in progress" holding the plan and an attempt number; the step command IDs derive from the command ID and that attempt, so asking again with the same
   * command ID continues where a crash or a bounded request stopped, and the final record (status deleted) is an upsert by the deletion ID. A request is bounded (`DELETE_MEMBERS` operations): when more remain the answer is
   * `partial` with `remaining`, and asking again continues. Holds are looked at again before every batch of removals.
   */
  async delete(owner: Principal, command: { commandId: string; recordId: string; reason: string; dryRun?: boolean }): Promise<DeletionReport> {
    if (!isOwner(owner)) throw new DomainError("forbidden", `${owner.id} may not delete records`);
    if (typeof command.recordId !== "string" || !RECORD_ID.test(command.recordId)) invalid("recordId", "is not a desk record ID (only desk records can be deleted; history and decisions are append-only and are kept)");
    if (typeof command.reason !== "string" || command.reason.trim() === "" || command.reason.length > 300) invalid("reason", "must be 1 to 300 characters");
    if (redactText(command.reason) !== command.reason) invalid("reason", "looks like a credential or key");
    const base = scopedCommandId(owner.id, command.commandId);
    const deletionId = derivedId("rtd", base);
    const root = await this.#runner.get("desk-record", command.recordId);
    if (root === undefined) throw new DomainError("not_found", "no such desk record");
    const values = await this.#deps.settings.effective();
    const backups = await this.#backupHandling(root.createdAt, values);
    const prior = await this.#runner.get("retention-deletion", deletionId);
    const priorBody = prior?.body as { status?: string; attempt?: number; plan?: Plan; derived?: DeletionReport["derived"] } | undefined;
    if (priorBody?.status === "deleted" && priorBody.derived !== undefined && command.dryRun !== true) return { status: "deleted", recordId: command.recordId, derived: priorBody.derived, backups, deletionId };

    const found = await this.#gather(root, command.recordId, priorBody?.status === "in-progress" ? priorBody.plan : undefined);
    const members = found.desk;
    const derived = { copies: found.desk.filter((a) => a.id !== command.recordId).map((c) => c.id), summaries: found.summaries.map((x) => x.id), compactions: found.compactions.map((c) => c.id), archives: found.archives.map((a) => a.id), others: found.others.map((o) => `${o.kind}/${o.id}`), ...NOT_STORED };
    const heldNow = async (): Promise<{ kind: string; id: string; reasons: string[] }[]> => {
      const material = await RetainedMaterial.build(this.#runner.storage);
      const held: { kind: string; id: string; reasons: string[] }[] = [];
      for (const a of members) { const why = material.why("desk-record", a.id); if (why !== undefined) held.push({ kind: "desk-record", id: a.id, reasons: why }); }
      for (const x of found.summaries) { const why = material.why("summary-record", x.id); if (why !== undefined) held.push({ kind: "summary-record", id: x.id, reasons: why }); }
      for (const c of found.compactions) { const why = material.why("ctx-compaction", c.id); if (why !== undefined) held.push({ kind: "ctx-compaction", id: c.id, reasons: why }); }
      if (!found.complete) held.push({ kind: "desk-record", id: command.recordId, reasons: ["too many records to find everything made from it safely; nothing was deleted"] });
      return held;
    };
    const held = await heldNow();
    const recordBody = (status: string, extra: JsonObject = {}): JsonObject => ({ recordId: command.recordId, projectId: (root.body as { projectId?: string }).projectId ?? "", requestedBy: owner.id, reason: command.reason, at: this.#runner.now(), status, derived: derived as unknown as JsonObject, backups: backups as unknown as JsonObject, ...extra });
    if (command.dryRun === true) return { status: held.length > 0 ? "retained" : "preview", recordId: command.recordId, ...(held.length > 0 ? { retained: held } : {}), derived, backups };

    const attempt = priorBody?.status === "in-progress" ? (priorBody.attempt ?? 1) : (priorBody?.attempt ?? 0) + 1;
    const retain = async (list: typeof held): Promise<DeletionReport> => {
      await this.#upsertDeletion(owner.id, `${base}.retained.${attempt}`, deletionId, recordBody("retained", { attempt, retained: list as unknown as JsonObject[] }));
      return { status: "retained", recordId: command.recordId, retained: list, derived, backups, deletionId };
    };
    if (held.length > 0) return retain(held);

    // The plan and the attempt are on the record before any content changes: a crash leaves a trace that a second call continues from.
    const plan: Plan = { desk: members.map((a) => a.id), summaries: found.summaries.map((x) => x.id), compactions: found.compactions.map((c) => c.id), archives: found.archives.map((a) => a.id), others: found.others.map((o) => ({ kind: o.kind, id: o.id })) };
    if (priorBody?.status !== "in-progress") await this.#upsertDeletion(owner.id, `${base}.begin.${attempt}`, deletionId, recordBody("in-progress", { attempt, plan: plan as unknown as JsonObject }));
    // The ledger outside the database is written before the first removal, so a restore of an older backup applies this deletion too.
    await this.#deps.ledger?.append({ deletionId, at: this.#runner.now(), by: owner.id, reason: command.reason, desk: plan.desk, compactions: plan.compactions, removed: [...plan.summaries.map((id) => ({ kind: "summary-record", id })), ...plan.archives.map((id) => ({ kind: "retention-archive", id })), ...plan.others] });

    const at = this.#runner.now();
    const stub = (a: Aggregate): JsonObject => {
      const b = a.body as Record<string, unknown>;
      const original = found.archives.find((x) => x.id === archiveIdOf(a.id))?.body as { original?: { title?: unknown; body?: unknown } } | undefined;
      const text = original?.original ?? b;
      return stubDeskBody(b, { at, by: owner.id, reason: command.reason, contentDigest: digestOf({ title: text["title"] ?? "", body: text["body"] ?? "" }) }) as JsonObject;
    };
    const step = async (name: string, kind: string, id: string, build: (fresh: Aggregate) => Change[]): Promise<void> => {
      await this.#runner.command(`retention.delete.${name}`, { commandId: cmdId("rtd", base, attempt, kind, id), actor: owner.id }, async () => ({
        payload: { kind, id, deletion: deletionId },
        build: async (): Promise<Built> => {
          const fresh = await this.#runner.get(kind, id);
          // Already handled by an earlier try of this command: nothing more to do; the record of the step is what the first try left.
          if (fresh === undefined) throw new DomainError("not_found", "already removed");
          return { ref: { kind, id }, creates: false, changes: build(fresh), detail: { deletion: deletionId, recordId: command.recordId } };
        },
      })).catch((error: unknown) => { if (error instanceof DomainError && error.code === "not_found") return; throw error; });
    };
    const work: { name: string; kind: string; id: string; build: (f: Aggregate) => Change[] }[] = [];
    for (const a of members) {
      if ((a.body as { deleted?: unknown }).deleted !== undefined) continue;
      // Someone else's deletion of the same record may have got here first: its digest of the original is kept, not overwritten with one of the blank.
      work.push({ name: "record", kind: "desk-record", id: a.id, build: (f) => [(f.body as { deleted?: unknown }).deleted !== undefined ? { type: "check", ref: { kind: "desk-record", id: a.id }, expectedRevision: f.revision } : { type: "update", ref: { kind: "desk-record", id: a.id }, expectedRevision: f.revision, body: stub(f) }] });
    }
    for (const arc of found.archives) work.push({ name: "archive", kind: "retention-archive", id: arc.id, build: (f) => [{ type: "delete", ref: { kind: "retention-archive", id: arc.id }, expectedRevision: f.revision }] });
    for (const x of found.summaries) work.push({ name: "summary", kind: "summary-record", id: x.id, build: (f) => [{ type: "delete", ref: { kind: "summary-record", id: x.id }, expectedRevision: f.revision }] });
    for (const o of found.others) work.push({ name: "derived", kind: o.kind, id: o.id, build: (f) => [{ type: "delete", ref: { kind: o.kind, id: o.id }, expectedRevision: f.revision }] });
    for (const c of found.compactions) {
      if ((c.body as { sourceDeleted?: unknown }).sourceDeleted === true && (c.body as { summary?: unknown }).summary === "") continue;
      work.push({ name: "compaction", kind: "ctx-compaction", id: c.id, build: (f) => [{ type: "update", ref: { kind: "ctx-compaction", id: c.id }, expectedRevision: f.revision, body: { ...(f.body as Record<string, unknown>), summary: "", digest: "", sourceDeleted: true } as JsonObject }] });
    }
    const todo = work.length;
    const handled = Math.min(todo, DELETE_MEMBERS);
    for (let i = 0; i < handled; i += BATCH) {
      const batch = work.slice(i, Math.min(i + BATCH, handled));
      // A hold that appeared since the last batch (a task resumed, a checkpoint cited the record) stops the removals here; what was removed stays removed and is on the record.
      await this.#deps.beforeBatch?.(i / BATCH);
      if (i > 0) {
        const material = await RetainedMaterial.build(this.#runner.storage, { routeArchive: batch.some((w) => w.kind === "ctx-route-archive") });
        const nowHeld = batch.flatMap((w) => { const why = material.why(w.kind, w.id); return why === undefined ? [] : [{ kind: w.kind, id: w.id, reasons: why }]; });
        if (nowHeld.length > 0) return retain(nowHeld);
      }
      for (const w of batch) await step(w.name, w.kind, w.id, w.build);
    }
    if (todo > handled) return { status: "partial", recordId: command.recordId, derived, backups, deletionId, remaining: todo - handled };
    await this.#upsertDeletion(owner.id, `${base}.done.${attempt}`, deletionId, recordBody("deleted", { attempt, plan: null as unknown as JsonObject }));
    return { status: "deleted", recordId: command.recordId, derived, backups, deletionId };
  }

  /** Writes the deletion record, creating it or replacing the earlier state of the same deletion: the one record per deletion ID, whatever its earlier attempts said. */
  async #upsertDeletion(actor: string, commandId: string, deletionId: string, body: JsonObject): Promise<void> {
    await this.#runner.command("retention.delete", { commandId, actor }, async () => ({
      payload: { deletion: deletionId, status: String(body["status"]), attempt: Number(body["attempt"] ?? 0) },
      build: async (): Promise<Built> => {
        const ref = { kind: "retention-deletion", id: deletionId };
        const cur = await this.#runner.get(ref.kind, ref.id);
        return { ref, creates: cur === undefined, changes: [cur === undefined ? { type: "create", ref, body } : { type: "update", ref, expectedRevision: cur.revision, body }], detail: { recordId: String(body["recordId"]), status: String(body["status"]) } };
      },
    }));
  }

  /**
   * Everything that stands on the record, followed to the end: copies (and copies of copies), newer versions that quote it, summaries that cite any of them, compactions that cite them and every compaction built on those (by `parent`
   * or `lineage`, transitively and bounded), the summary records those compactions published, meeting summaries and stand-up briefs that quote the text, and the archives of all of it. A `plan` of an earlier try is added, so a
   * resumed deletion still knows what it set out to remove after parts of it are gone.
   */
  async #gather(root: Aggregate, recordId: string, plan: Plan | undefined): Promise<Found> {
    const copyOf = new Set<string>([recordId]);
    const desk = new Map<string, Aggregate>([[recordId, root]]);
    let complete = true;
    const rb = root.body as { title?: unknown; body?: unknown; supersedes?: unknown };
    const needle = ((): string | undefined => { const clean = (v: unknown): string => (typeof v === "string" ? v : "").replace(/\s+/g, " ").trim(); const text = clean(rb.body).length >= 24 ? clean(rb.body) : `${clean(rb.title)} ${clean(rb.body)}`.trim(); return text.length < 24 ? undefined : text.slice(0, 120); })();
    const quotes = (b: unknown): boolean => needle !== undefined && JSON.stringify(b).replace(/\\n|\s+/g, " ").includes(JSON.stringify(needle).slice(1, -1).replace(/\s+/g, " "));
    // Copies of copies share the same root: gather until no new one appears (bounded by the scan). A record that supersedes this one (or that it supersedes) is included only where it quotes the text.
    for (let round = 0; round < 4; round++) {
      let added = false;
      complete = (await scan(this.#runner, "desk-record", (a) => {
        if (copyOf.has(a.id)) return;
        const b = a.body as { copiedFrom?: string; supersedes?: string; origin?: { recordId?: string } };
        const copied = (b.copiedFrom !== undefined && copyOf.has(b.copiedFrom)) || b.origin?.recordId === recordId;
        const chain = ((b.supersedes !== undefined && copyOf.has(b.supersedes)) || (typeof rb.supersedes === "string" && a.id === rb.supersedes)) && quotes(a.body);
        if (copied || chain) { copyOf.add(a.id); desk.set(a.id, a); added = true; }
      })) && complete;
      if (!added) break;
    }
    for (const id of plan?.desk ?? []) if (!desk.has(id)) { const a = await this.#runner.get("desk-record", id); if (a !== undefined) { desk.set(id, a); copyOf.add(id); } }
    const summaries = new Map<string, Aggregate>(); const compactions = new Map<string, Aggregate>(); const others = new Map<string, { kind: string; id: string }>();
    complete = (await scan(this.#runner, "summary-record", (a) => { const b = a.body as { sources?: { source?: { kind?: string; id?: string } }[] }; if ((b.sources ?? []).some((x) => x.source?.kind === "desk-record" && x.source.id !== undefined && copyOf.has(x.source.id))) summaries.set(a.id, a); })) && complete;
    // Compactions that cite the record, then every later compaction built on one of them (`parent`, or `lineage`): their summary text was written from the text. Bounded rounds.
    const all: Aggregate[] = [];
    complete = (await scan(this.#runner, "ctx-compaction", (a) => { all.push(a); })) && complete;
    for (const a of all) { const b = a.body as { sources?: { kind?: string; id?: string }[]; pinned?: { kind?: string; id?: string }[] }; if ([...(b.sources ?? []), ...(b.pinned ?? [])].some((x) => x.kind === "desk-record" && x.id !== undefined && copyOf.has(x.id))) compactions.set(a.id, a); }
    for (const id of plan?.compactions ?? []) { const a = all.find((x) => x.id === id); if (a !== undefined) compactions.set(id, a); }
    for (let round = 0; round < 64; round++) {
      let added = false;
      for (const a of all) {
        if (compactions.has(a.id)) continue;
        const b = a.body as { parent?: string; lineage?: string[] };
        if ((b.parent !== undefined && compactions.has(b.parent)) || (b.lineage ?? []).some((id) => compactions.has(id))) { compactions.set(a.id, a); added = true; }
      }
      if (!added) break;
      if (round === 63) complete = false;
    }
    // The summary records those compactions published (they carry the same text), and what cites a removed summary.
    for (const c of compactions.values()) { const sid = (c.body as { summaryId?: string }).summaryId; if (typeof sid === "string") { const sum = await this.#runner.get("summary-record", sid); if (sum !== undefined) summaries.set(sid, sum); } }
    for (const id of plan?.summaries ?? []) { const sum = await this.#runner.get("summary-record", id); if (sum !== undefined) summaries.set(id, sum); }
    // Meeting summaries and stand-up briefs that quote the text are derived from it as well.
    for (const kind of ["meeting-summary", "standup-brief"]) {
      complete = (await scan(this.#runner, kind, (a) => { if (quotes(a.body)) others.set(`${kind}/${a.id}`, { kind, id: a.id }); })) && complete;
    }
    for (const o of plan?.others ?? []) if ((await this.#runner.get(o.kind, o.id)) !== undefined) others.set(`${o.kind}/${o.id}`, o);
    const archives: Aggregate[] = [];
    for (const id of [...copyOf, ...summaries.keys(), ...[...others.values()].map((o) => o.id)]) { const arc = await this.#runner.get("retention-archive", archiveIdOf(id)); if (arc !== undefined) archives.push(arc); }
    for (const id of plan?.archives ?? []) if (!archives.some((x) => x.id === id)) { const arc = await this.#runner.get("retention-archive", id); if (arc !== undefined) archives.push(arc); }
    return { desk: [...desk.values()], summaries: [...summaries.values()], compactions: [...compactions.values()], archives, others: [...others.values()], complete };
  }

  /** How the backups are handled for a deletion: left alone, and for how long they hold the text. */
  async #backupHandling(since: string, values: RetentionValues): Promise<{ handling: string; holding: number; staysUpToDays: number | null; note: string }> {
    const port = this.#deps.backups;
    if (port === undefined) return { handling: "no backups are configured", holding: 0, staysUpToDays: null, note: "No backup folder is configured, so there is no backup copy to expire." };
    const holding = (await port.list()).filter((b) => b.at >= since.slice(0, 19)).length;
    const staysUpToDays = Math.max(values.backupDaily, values.backupWeekly * 7 + 6);
    return { handling: "left to expire", holding, staysUpToDays, note: `Existing backups are not altered. ${holding} of them hold the text and drop it as they fall outside the backup rule (${values.backupDaily} daily, ${values.backupWeekly} weekly), at the latest in ${staysUpToDays} days; a pre-upgrade snapshot is kept until its rollback period ends. A backup made now no longer contains it.` };
  }

  // ---- archive and restore --------------------------------------------------------------------------------------------------

  /**
   * Archives a finished task's desk records: the text of each moves into an archive record and the desk record keeps a stub. Owner only; the task must be done or cancelled, and a record a resumable task or a replay still needs
   * is not archived (reported as retained). Restore puts the original back exactly.
   */
  async archive(owner: Principal, command: { commandId: string; taskId: string; reason?: string }): Promise<{ taskId: string; archived: string[]; retained: { kind: string; id: string; reasons: string[] }[]; skipped: string[] }> {
    if (!isOwner(owner)) throw new DomainError("forbidden", `${owner.id} may not archive work`);
    if (typeof command.taskId !== "string" || !TASK_ID.test(command.taskId)) invalid("taskId", "is not a task ID");
    if (command.reason !== undefined && (typeof command.reason !== "string" || command.reason.length > 300 || redactText(command.reason) !== command.reason)) invalid("reason", "must be at most 300 characters and no credential");
    const task = await this.#runner.get("task", command.taskId);
    if (task === undefined) throw new DomainError("not_found", "no such task");
    const state = (task.body as { state?: string }).state;
    if (state !== "done" && state !== "cancelled") throw new DomainError("invalid_command", `taskId: only a done or cancelled task is archived (this one is ${state ?? "unknown"})`, { field: "taskId" });
    const base = scopedCommandId(owner.id, command.commandId);
    const records: Aggregate[] = [];
    const complete = await scan(this.#runner, "desk-record", (a) => { if ((a.body as { taskId?: string }).taskId === command.taskId) records.push(a); });
    if (!complete) throw new DomainError("unavailable", "too many desk records to archive a task safely");
    const material = await RetainedMaterial.build(this.#runner.storage);
    const retained: { kind: string; id: string; reasons: string[] }[] = []; const archived: string[] = []; const skipped: string[] = [];
    const at = this.#runner.now();
    const one = async (kind: "desk-record" | "summary-record", rec: Aggregate, stubOf: (b: Record<string, unknown>, archiveId: string) => JsonObject): Promise<void> => {
      const archiveId = archiveIdOf(rec.id);
      const result = await this.#runner.command("retention.archive", { commandId: cmdId("rta", base, rec.id), actor: owner.id }, async () => ({
        payload: { recordId: rec.id, taskId: command.taskId },
        build: async (): Promise<Built> => {
          const fresh = await this.#runner.get(kind, rec.id);
          if (fresh === undefined) throw new DomainError("not_found", "no such record");
          const fb = fresh.body as Record<string, unknown>;
          if (fb["archived"] !== undefined || fb["deleted"] !== undefined) throw new DomainError("stale_revision", "already archived or deleted");
          const ref = { kind: "retention-archive", id: archiveId };
          const arch = { recordId: rec.id, recordKind: kind, taskId: command.taskId, projectId: String(fb["projectId"] ?? ""), original: fresh.body, originalRevision: fresh.revision, stubRevision: fresh.revision + 1, at, by: owner.id, ...(command.reason === undefined ? {} : { reason: command.reason }) } as unknown as JsonObject;
          return { ref, creates: true, changes: [{ type: "create", ref, body: arch }, { type: "update", ref: { kind, id: rec.id }, expectedRevision: fresh.revision, body: stubOf(fb, archiveId) }], detail: { recordId: rec.id, recordKind: kind, taskId: command.taskId } };
        },
      })).catch((error: unknown) => { if (error instanceof DomainError && (error.code === "stale_revision" || error.code === "not_found" || error.code === "command_conflict")) return undefined; throw error; });
      if (result !== undefined) archived.push(rec.id); else skipped.push(rec.id);
    };
    const done = new Set<string>();
    for (const rec of records.sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const b = rec.body as { deleted?: unknown; archived?: unknown };
      if (b.deleted !== undefined || b.archived !== undefined) { skipped.push(rec.id); continue; }
      const why = material.why("desk-record", rec.id);
      // The task's own records count as held only because the task can resume; a finished task's are free, unless another resumable task cites them.
      const outside = why?.filter((w) => !w.includes(`written for task ${command.taskId}`));
      if (!material.complete || (outside !== undefined && outside.length > 0)) { retained.push({ kind: "desk-record", id: rec.id, reasons: outside ?? why ?? [] }); continue; }
      await one("desk-record", rec, (fb, archiveId) => ({ ...fb, title: "(archived)", body: "", archived: { at, by: owner.id, archiveId } }) as JsonObject);
      done.add(rec.id);
    }
    // What was made from an archived source goes with it (summaries keep their project and sources; the text returns on restore).
    const derived: Aggregate[] = [];
    if (done.size > 0 && !(await scan(this.#runner, "summary-record", (a) => { const sb = a.body as { sources?: { source?: { kind?: string; id?: string } }[] }; if ((sb.sources ?? []).some((x) => x.source?.kind === "desk-record" && x.source.id !== undefined && done.has(x.source.id))) derived.push(a); }))) throw new DomainError("unavailable", "too many summaries to archive a task safely");
    for (const sum of derived.sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const sb = sum.body as { deleted?: unknown; archived?: unknown };
      if (sb.deleted !== undefined || sb.archived !== undefined) { skipped.push(sum.id); continue; }
      const why = material.why("summary-record", sum.id);
      if (!material.complete || why !== undefined) { retained.push({ kind: "summary-record", id: sum.id, reasons: why ?? [] }); continue; }
      await one("summary-record", sum, (fb, archiveId) => ({ ...fb, title: "(archived)", text: "", archived: { at, by: owner.id, archiveId } }) as JsonObject);
    }
    return { taskId: command.taskId, archived, retained, skipped };
  }

  /** Puts a task's archived records back exactly as they were. A record changed since it was archived (or deleted at the owner's request) is left alone and listed. */
  async restore(owner: Principal, command: { commandId: string; taskId: string }): Promise<{ taskId: string; restored: string[]; conflicts: string[]; conflictDetails: { recordId: string; reason: string }[] }> {
    if (!isOwner(owner)) throw new DomainError("forbidden", `${owner.id} may not restore archived work`);
    if (typeof command.taskId !== "string" || !TASK_ID.test(command.taskId)) invalid("taskId", "is not a task ID");
    const base = scopedCommandId(owner.id, command.commandId);
    const found: Aggregate[] = [];
    if (!(await scan(this.#runner, "retention-archive", (a) => { if ((a.body as { taskId?: string }).taskId === command.taskId) found.push(a); }))) throw new DomainError("unavailable", "too many archives to restore a task safely");
    const restored: string[] = []; const conflicts: string[] = []; const conflictDetails: { recordId: string; reason: string }[] = [];
    const conflict = (recordId: string, reason: string): void => { conflicts.push(recordId); conflictDetails.push({ recordId, reason }); };
    for (const arc of found.sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const body = arc.body as unknown as { recordId: string; recordKind?: "desk-record" | "summary-record"; original: JsonObject; stubRevision: number };
      const kind = body.recordKind ?? "desk-record";
      const cur = await this.#runner.get(kind, body.recordId);
      const marker = (cur?.body as { archived?: { archiveId?: string } } | undefined)?.archived;
      if (cur === undefined) { conflict(body.recordId, "the record is gone"); continue; }
      if ((cur.body as { deleted?: unknown }).deleted !== undefined) { conflict(body.recordId, "deleted at the owner's request: the text is not restored"); continue; }
      if (cur.revision !== body.stubRevision || marker?.archiveId !== arc.id) { conflict(body.recordId, "changed since it was archived"); continue; }
      const r = await this.#runner.command("retention.restore", { commandId: cmdId("rta", "restore", base, arc.id), actor: owner.id }, async () => ({
        payload: { archiveId: arc.id, taskId: command.taskId },
        build: async (): Promise<Built> => {
          const fresh = await this.#runner.get(kind, body.recordId);
          const freshArc = await this.#runner.get("retention-archive", arc.id);
          if (fresh === undefined || freshArc === undefined || fresh.revision !== body.stubRevision) throw new DomainError("stale_revision", "changed since it was archived");
          const ref = { kind, id: body.recordId };
          return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: fresh.revision, body: body.original }, { type: "delete", ref: { kind: "retention-archive", id: arc.id }, expectedRevision: freshArc.revision }], detail: { recordId: body.recordId, taskId: command.taskId }, audit: [{ type: "retention.restore.archive", subject: { kind: "retention-archive", id: arc.id }, detail: { recordId: body.recordId, taskId: command.taskId } }] };
        },
      })).catch((error: unknown) => { if (error instanceof DomainError && (error.code === "stale_revision" || error.code === "not_found")) return undefined; throw error; });
      if (r !== undefined) restored.push(body.recordId); else conflict(body.recordId, "changed while it was being restored");
    }
    return { taskId: command.taskId, restored, conflicts, conflictDetails };
  }

  // ---- export ---------------------------------------------------------------------------------------------------------------

  /**
   * An export of a project's records for the owner: projects, tasks, desk records, summaries, artifacts' metadata and archived originals, in pages. Secrets are left out: every field named like a secret is replaced and every string
   * shaped like a key or token is masked (`redactions` counts them), and kinds that hold credentials (principals, task credentials, grants, backup keys) are not in the list at all. A page is bounded; `next` continues.
   */
  async export(by: Principal, options: { projectId: string; after?: string; limit?: number }): Promise<{ projectId: string; items: { kind: string; id: string; revision: number; body: JsonObject }[]; redactions: number; next?: string; partial?: true }> {
    if (!isOwner(by)) throw new DomainError("forbidden", `${by.id} may not export`);
    if (typeof options.projectId !== "string" || !PROJECT_ID.test(options.projectId)) invalid("projectId", "is not a project ID");
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) invalid("limit", "must be a whole number from 1 to 200");
    const kinds = EXPORT_KINDS;
    let [k, afterId] = ((): [number, string | undefined] => {
      if (options.after === undefined) return [0, undefined];
      const m = /^(\d+):(.*)$/.exec(options.after);
      if (m === null || Number(m[1]) >= kinds.length) return invalid("after", "is not a cursor from this export");
      return [Number(m[1]), m[2] === "" ? undefined : m[2]];
    })();
    const items: { kind: string; id: string; revision: number; body: JsonObject }[] = [];
    // An artifact may name its task and not its project: the project is then the task's.
    const projectTasks = new Set<string>();
    await scan(this.#runner, "task", (t) => { if ((t.body as { projectId?: unknown }).projectId === options.projectId) projectTasks.add(t.id); });
    let redactions = 0; let bytes = 0; let examined = 0;
    const MAX_BYTES = 512 * 1024; const MAX_EXAMINE = 5_000;
    for (; k < kinds.length; k++, afterId = undefined) {
      const kind = kinds[k]!;
      for (;;) {
        const page = await this.#runner.list(kind, { ...(afterId === undefined ? {} : { afterId }), limit: 200 });
        for (const a of page) {
          const prior = afterId;
          afterId = a.id; examined++;
          const b = a.body as Record<string, unknown>;
          const mine = kind === "project" ? a.id === options.projectId : b["projectId"] === options.projectId || (b["projectId"] === undefined && typeof b["taskId"] === "string" && projectTasks.has(b["taskId"]));
          if (mine) {
            const clean = redact(a.body);
            if (canonicalJson(clean as never) !== canonicalJson(a.body as never)) redactions++;
            const size = Buffer.byteLength(canonicalJson(clean as never));
            if (items.length > 0 && (items.length >= limit || bytes + size > MAX_BYTES)) return { projectId: options.projectId, items, redactions, next: `${k}:${prior ?? ""}`, partial: true };
            items.push({ kind, id: a.id, revision: a.revision, body: clean as JsonObject }); bytes += size;
          }
          if (examined >= MAX_EXAMINE) return { projectId: options.projectId, items, redactions, next: `${k}:${a.id}`, partial: true };
        }
        if (page.length < 200) break;
      }
    }
    return { projectId: options.projectId, items, redactions };
  }
}

/** The kinds in an export, in order. Secret-bearing kinds are absent by design. */
export const EXPORT_KINDS = ["project", "task", "desk-record", "summary-record", "artifact", "retention-archive"] as const;
const archiveIdOf = (recordId: string): string => `arc-${recordId}`;
