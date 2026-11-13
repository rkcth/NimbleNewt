import { createHash } from "node:crypto";
import { assignmentIdOf } from "../domain/assignment-model.js";
import { incidentSlotId } from "../projects/incidents.js";
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
import { RetainedMaterial, isReplayReason } from "./references.js";
import { RETENTION_FIELDS, type RetentionSettingsService, type RetentionValues } from "./settings.js";
import type { ThinkingStorePort } from "./thinking-stores.js";
import { DISPATCH_KIND } from "../dispatch/model.js";

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
/** What one class of scope (project or agent) holds against its quota (card K06d). */
export interface QuotaClassUsage { readonly quota: number; readonly scopes: number; readonly totalBytes: number; readonly top: readonly { readonly id: string; readonly used: number }[] }
export type QuotaUsage = { readonly project?: QuotaClassUsage; readonly agent?: QuotaClassUsage };
const RUNS_LISTED = 5;
export interface IncidentPort {
  archive(by: Principal, options: { olderThanDays?: number; limit?: number; projectId?: string; ids?: readonly string[] }): Promise<number>;
  purge(by: Principal, options: { olderThanDays: number; limit?: number; projectId?: string; ids?: readonly string[] }): Promise<number>;
  /** Which incidents a run would archive and remove now (the preview and its digest cover them); `more` says there are more due than one run takes. Absent: they are left out of the preview and the digest. */
  due?(by: Principal, options: { archiveDays?: number; purgeDays?: number; projectId?: string }): Promise<{ archive: string[]; purge: string[]; more?: boolean }>;
}
export interface CatalogRetentionPort {
  retentionCandidates(by: Principal, keep: number, limit: number): Promise<{ items: { name: string; version: string; versionId: string; revision: number; ageDays: number }[]; partial: boolean }>;
  revokedExecutables(by: Principal, olderThanDays: number, limit: number): Promise<{ items: { name: string; version: string; versionId: string; recordId: string; ageDays: number; digest: string; revision: number }[]; partial: boolean }>;
  dropVersion(by: Principal, drop: { name: string; version: string; revision: number; keep: number }, holds?: (versionId: string) => Promise<readonly string[] | undefined>): Promise<{ dropped: boolean; held?: readonly string[] }>;
}

/** How many held records (and, apart, held versions) a report lists; past it the held ones are still held but not listed. */
const RETAINED_LISTED = 200;

/** The one-line account of a run that the owner reads (chat and API): a preview says what would happen and how to confirm it, a real run says what happened. Dropped versions and blanked texts are counted apart from expired records (derived summaries, model replies, route records). */
export function describeRun(r: RunReport): string {
  // Held records and held tool versions both count as kept; each list stops at RETAINED_LISTED, so a full list means there may be more.
  const heldVersions = r.catalogVersions?.retained.length ?? 0;
  const kept = `${r.retained.length + heldVersions}${r.retained.length >= RETAINED_LISTED || heldVersions >= RETAINED_LISTED ? " or more" : ""}`;
  if (r.dryRun) return `Retention preview: ${r.candidates.length} expired record(s) (derived summaries, model replies, route records) would be removed, ${kept} kept because something still needs them (a resumable task, a replay or an agent's environment)${r.catalogVersions === undefined ? "" : `, ${r.catalogVersions.candidates.length} old tool version(s) would be dropped`}${r.revokedBytes === undefined ? "" : `, ${r.revokedBytes.candidates.length} revoked tool text(s) would be blanked`}${r.incidents?.wouldArchive === undefined ? "" : `, ${r.incidents.wouldArchive} resolved incident(s) would be archived, ${r.incidents.wouldPurge ?? 0} archived incident(s) would be removed${r.incidents.more === true ? " (there are more due than one run takes: at most 200 of each kind per project)" : ""}`}${r.backups?.wouldDelete === undefined ? "" : `, ${r.backups.wouldDelete.length} backup(s) outside the counts would be deleted`}. To run exactly this for real, ask for it to be run (digest ${r.digest}).`;
  // `removed` counts everything taken away, so the dropped versions and blanked texts are taken out of the expired records.
  const derived = r.removed - (r.catalogVersions?.removed ?? 0) - (r.revokedBytes?.blanked ?? 0);
  return `Retention ran: ${derived} expired record(s) removed${r.backups?.deleted === undefined ? "" : `, ${r.backups.deleted.length} backup(s) were deleted`}${r.catalogVersions === undefined ? "" : `, ${r.catalogVersions.removed} old tool version(s) dropped`}${r.revokedBytes === undefined ? "" : `, ${r.revokedBytes.blanked} revoked tool text(s) blanked`}${r.incidents?.archived === undefined || (r.incidents.archiveDays === null && r.incidents.purgeDays === null) ? "" : `, ${r.incidents.archived} resolved incident(s) archived, ${r.incidents.purged ?? 0} archived incident(s) removed`}; ${kept} kept because something still needs them (a resumable task, a replay or an agent's environment).`;
}

export interface RetentionDeps {
  /** The tool catalogue, for the old-versions and revoked-text rules (card T02c). Absent: neither does anything. */
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
  /** The conversation stores that keep the model's own copy of its thinking (card K06c): the rule that removes stored thinking `thinkingDays` after a task is done also cleans them. Absent: only the controller's copy is removed (the Pi stores are named as not reached). */
  readonly thinkingStores?: ThinkingStorePort;
  /** A test seam: called before each batch of removals. */
  readonly beforeBatch?: (batch: number) => Promise<void>;
  /** A test seam: runs after the citations of a revoked executable record were read and before it is blanked (what a task does in that gap must keep the record). */
  readonly beforeBlank?: (recordId: string) => Promise<void>;
}

/** A chat turn with the owner's words gone (card K06b): the ID, the message it answered, its state and its times stay, so a message sent again is answered as the done turn it was; the words, the plan and the answers do not. */
function transcriptStub(body: Record<string, unknown>, at: string, days: number): JsonObject {
  const keep: Record<string, unknown> = {};
  for (const k of ["ownerId", "messageId", "quotedCount", "projectId", "status", "resumes", "resumedBy", "createdAt", "completedAt"]) if (body[k] !== undefined) keep[k] = body[k];
  return { ...keep, text: "", plan: [], outcomes: [], retention: { removedAt: at, rule: "transcript-days", days } } as unknown as JsonObject;
}

/** What the chat context shows for a turn whose words retention removed. */
const TRANSCRIPT_REMOVED = "(the words of this turn were removed by retention)";

/** The values of a pass that does only the thinking rules: every optional rule off, no flag on. */
function onlyThinking(values: RetentionValues): RetentionValues {
  const out: Record<string, unknown> = { ...values };
  for (const [name, spec] of Object.entries(RETENTION_FIELDS)) {
    if (name === "thinkingDays" || name === "thinkingAuto") continue;
    if (spec.nullable) out[name] = null; else if (spec.kind === "flag") out[name] = false;
  }
  return out as unknown as RetentionValues;
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
  /** Everything a real run took away: derived records, dropped catalogue versions and blanked revoked texts (the last two are also counted in `catalogVersions.removed` and `revokedBytes.blanked`). */
  readonly removed: number;
  /** Candidates a resumable task or replay still needs: kept, and shown as retained with why. */
  readonly retained: { kind: string; id: string; reasons: string[] }[];
  readonly partial: boolean;
  /** Present on a preview: pass it back as `confirm` to run exactly what was shown. */
  readonly digest?: string;
  readonly backups?: { kept: number; wouldDelete?: string[]; deleted?: string[]; counts: { daily: number; weekly: number; preRestoreKept?: number | null; preRestoreMaxAgeDays?: number | null } };
  readonly incidents?: { archiveDays: number | null; purgeDays: number | null; archived?: number; purged?: number; wouldArchive?: number; wouldPurge?: number; more?: boolean };
  /** The old-versions rule for the tool catalogue (off unless `catalogVersionsKept` is set; in the automatic pass also `catalogAutoDrop`): what it would drop (or dropped), and the versions kept because something still needs them (with the reasons). */
  readonly catalogVersions?: { keep: number; candidates: { name: string; version: string; ageDays: number }[]; retained: { name: string; version: string; reasons: string[] }[]; removed: number; partial: boolean };
  /** Executable text of revoked versions (off unless `revokedBytesBlank` is on and `revokedBytesDays` is set): what it would blank (or blanked). The record, digest and revocation stay. */
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
  /** Records a replay cites that the owner released in this request (`releaseReplay`): the replay steps now point at a removed record. */
  readonly replayReleased?: { kind: string; id: string; reasons: string[] }[];
  /** More members than one request handles: ask again (the same command) to finish. */
  readonly remaining?: number;
}

/**
 * Retention, quotas, archive, export and deletion (card K06). Nothing here deletes unless the owner asked or set a rule: each rule acts only when its own value is set, a user-requested deletion is an owner command, and what a resumable task
 * or a replay needs is refused as retained. Every removal is a guarded delete with an audit record (and a storage tombstone), so it is recorded and a stale holder cannot write over it.
 */
export class RetentionService {
  readonly #runner: CommandRunner;
  readonly #deps: RetentionDeps;
  #lastThinking: number | undefined;
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
    const { quotas, partial, usage } = await this.#quotaLevels(values);
    for (const q of quotas) warnings.push(`${q.scope} ${q.id} is at ${q.percent}% of its storage quota`);
    const reserve = this.#deps.reserve;
    if (reserve !== undefined && reserve.released) warnings.push("the reserve for shutdown and recovery records is in use: only those records are written until room is made");
    else if (reserve !== undefined && reserve.short) warnings.push("the disk has too little room to set the reserve aside");
    if (space !== undefined && space.totalBytes > 0 && space.freeBytes * 10 < space.totalBytes) warnings.push(`the data disk has ${Math.floor((space.freeBytes * 100) / space.totalBytes)}% free`);
    const deletions = (await this.#recent("retention-deletion", 20)).map((a) => ({ id: a.id, ...(a.body as object) }));
    // The last runs of the rules (card K06d): when, by whom, how many records and backups each removed. Counts and IDs only.
    const runs = (await this.#recent("retention-run", RUNS_LISTED)).map((a) => { const b = a.body as { at?: unknown; by?: unknown; auto?: unknown; removedCount?: unknown; backupsDeleted?: unknown; incidentsArchived?: unknown; incidentsPurged?: unknown }; return { id: a.id, at: typeof b.at === "string" ? b.at : a.createdAt, by: typeof b.by === "string" ? b.by : "", auto: b.auto === true, removed: typeof b.removedCount === "number" ? b.removedCount : 0, backupsDeleted: Array.isArray(b.backupsDeleted) ? b.backupsDeleted.length : 0, incidentsArchived: typeof b.incidentsArchived === "number" ? b.incidentsArchived : 0, incidentsPurged: typeof b.incidentsPurged === "number" ? b.incidentsPurged : 0 }; });
    const backupList = this.#deps.backups === undefined ? undefined : await this.#deps.backups.list();
    // The newest backup by its time (ties by name), whether it can be trusted, and how many cannot.
    const newest = backupList === undefined ? undefined : [...backupList].sort((a, b) => (a.at === b.at ? (a.manifest.name < b.manifest.name ? 1 : -1) : a.at < b.at ? 1 : -1))[0];
    // How many of the records that only grow are stored (bounded count), so the owner sees what the checkRecordDays and concernDays rules would work on.
    const growth: Record<string, number | string> = {};
    for (const kind of ["responsibility-check", "stall-concern", "responsibility-incident", "stall-evidence", "stall-speed", "responsibility-event", "responsibility-incident-slot", "ctx-note-archive", "thinking-record", "thinking-purge"]) { let n = 0; const complete = await scan(this.#runner, kind, () => { n += 1; }); growth[kind] = complete ? n : `${n}+`; }
    // Stored model thinking (card K06c, shown by card K06d): the setting, whether the dispatcher removes it by itself, how many task copies are kept and removed and how many conversation stores were cleaned. Counts only, never a word of the thinking.
    let kept = 0; let removed = 0; let tasksCleaned = 0; let storesCleaned = 0; let storesWithout = 0; let blocksRemoved = 0;
    const tc = await scan(this.#runner, "thinking-record", (a) => { if ((a.body as { removedAt?: unknown }).removedAt === undefined) kept += 1; else removed += 1; });
    const pc = await scan(this.#runner, "thinking-purge", (a) => {
      const b = a.body as { attempts?: unknown; blocks?: unknown }; tasksCleaned += 1;
      if (typeof b.attempts === "object" && b.attempts !== null) for (const v of Object.values(b.attempts as Record<string, unknown>)) { if (v === "purged") storesCleaned += 1; else if (v === "none") storesWithout += 1; }
      if (typeof b.blocks === "number" && Number.isFinite(b.blocks) && b.blocks > 0) blocksRemoved += Math.floor(b.blocks);
    });
    const thinking = { days: values.thinkingDays, auto: values.thinkingAuto, storesReached: this.#deps.thinkingStores !== undefined, copiesKept: kept, copiesRemoved: removed, tasksCleaned, storesCleaned, storesWithout, blocksRemoved, ...(tc && pc ? {} : { partial: true }) };
    return {
      values: values as unknown as JsonObject,
      thinking: thinking as unknown as JsonObject,
      growth: growth as unknown as JsonObject,
      disk: { ...(space === undefined ? {} : { freeBytes: space.freeBytes, totalBytes: space.totalBytes }), reserve: { wantedBytes: reserve?.wanted ?? 0, inUse: reserve?.released ?? false, short: reserve?.short ?? false, ...(reserve?.releasedAt === undefined ? {} : { usedAt: reserve.releasedAt }) } },
      quotas: quotas as unknown as JsonObject[], quotaUsagePartial: partial, warnings,
      quotaLimits: { projectBytes: values.quotaProjectBytes, agentBytes: values.quotaAgentBytes, warnPercent: values.quotaWarnPercent },
      quotaUsage: usage as unknown as JsonObject,
      backups: backupList === undefined ? { configured: false } : { configured: true, count: backupList.length, untrusted: backupList.filter((b) => !b.trusted).length, ...(newest === undefined ? {} : { latest: { name: newest.manifest.name, at: newest.at, trusted: newest.trusted } }), counts: { daily: values.backupDaily, weekly: values.backupWeekly } },
      deletions: deletions as unknown as JsonObject[],
      runs: runs as unknown as JsonObject[],
    } as unknown as JsonObject;
  }

  /** The scopes at or over the warning level of a quota that is set. Nothing is counted while no quota is set. */
  async #quotaLevels(values: RetentionValues): Promise<{ quotas: { scope: string; id: string; used: number; quota: number; percent: number; level: "warn" | "full" }[]; partial: boolean; usage: QuotaUsage }> {
    const quotas: { scope: string; id: string; used: number; quota: number; percent: number; level: "warn" | "full" }[] = [];
    if (this.#deps.meter === undefined || (values.quotaProjectBytes === null && values.quotaAgentBytes === null)) return { quotas, partial: false, usage: {} };
    const usage = await this.#deps.meter.usage();
    const add = (scope: string, map: ReadonlyMap<string, number>, quota: number | null): void => {
      if (quota === null) return;
      for (const [id, used] of map) {
        const percent = Math.floor((used * 100) / quota);
        if (percent >= values.quotaWarnPercent) quotas.push({ scope, id, used, quota, percent, level: percent >= 100 ? "full" : "warn" });
      }
    };
    add("project", usage.byProject, values.quotaProjectBytes); add("agent", usage.byAgent, values.quotaAgentBytes);
    // What each class holds against its quota (bounded: the count, the total and the three biggest), so the owner sees the room left and not only the scopes near the limit.
    const summary = (map: ReadonlyMap<string, number>, quota: number | null): QuotaClassUsage | undefined => {
      if (quota === null) return undefined;
      let total = 0; for (const n of map.values()) total += n;
      const top = [...map].sort((a, b) => (b[1] === a[1] ? (a[0] < b[0] ? -1 : 1) : b[1] - a[1])).slice(0, 3).map(([id, used]) => ({ id, used }));
      return { quota, scopes: map.size, totalBytes: total, top };
    };
    const project = summary(usage.byProject, values.quotaProjectBytes); const agent = summary(usage.byAgent, values.quotaAgentBytes);
    return { quotas, partial: usage.partial, usage: { ...(project === undefined ? {} : { project }), ...(agent === undefined ? {} : { agent }) } };
  }

  async #recent(kind: string, n: number): Promise<Aggregate[]> {
    const all: Aggregate[] = [];
    await scan(this.#runner, kind, (a) => all.push(a), SCAN_LIMIT);
    // Newest first by the time of the record (not by the order of the IDs, which is a hash); ties by ID.
    return all.sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1)).slice(0, n);
  }

  /** Whether the record is held, and why: by a resumable task or a replay (its records, checkpoints, dependency records, and the tool versions it ran, pinned a call to or lists as a dependency, and the versions in the skill library of an agent's active environment or of an environment revision such a task's attempt is pinned to; the full list is in `RetainedMaterial`). */
  async check(by: Principal, ref: { kind: string; id: string }): Promise<{ kind: string; id: string; retained: boolean; reasons: string[] }> {
    if (!isOwner(by)) throw new DomainError("forbidden", `${by.id} may not ask what is retained`);
    if (typeof ref.kind !== "string" || typeof ref.id !== "string") invalid("ref", "needs a kind and an id");
    const material = await RetainedMaterial.build(this.#runner.storage, { routeArchive: ref.kind === "ctx-route-archive" });
    const reasons = material.why(ref.kind, ref.id) ?? [];
    return { kind: ref.kind, id: ref.id, retained: reasons.length > 0, reasons };
  }

  // ---- the runner -----------------------------------------------------------------------------------------------------------

  /**
   * The retention runner. Preview (the default) lists what each rule would remove (derived data, model replies, route records, backups, old catalogue versions, revoked executable text), and gives a digest; running it needs that digest back (`confirm`), so what is removed is what was shown.
   * Each rule acts only when its own value is set (the revoked-text rule also needs `revokedBytesBlank`). The preview also counts the resolved incidents to archive and the archived ones to remove (`incidents.wouldArchive` and `wouldPurge`) when their windows are set; the digest covers their IDs and a confirmed run acts on those (each is checked again when handled; one that no longer qualifies is skipped, so `incidents.archived` or `purged` can be lower than the preview's counts). Incident archive and purge follow their own ages when set. A resumable task's or a replay's material is skipped and shown as retained (a revoked executable text that something cites when the run reads it is left out of `revokedBytes`; one that becomes cited during the run stays listed there but is not blanked, so `blanked` is lower; neither is listed as retained).
   */
  async run(by: Principal, options: { dryRun?: boolean; confirm?: string; limit?: number; commandId?: string } = {}): Promise<RunReport> {
    if (!isOwner(by)) throw new DomainError("forbidden", `${by.id} may not run retention by hand`);
    return this.#run(by, options, false);
  }

  /** The dispatcher's pass: does the same as an owner's confirmed run, only when `autoRun` is set, except that it drops catalogue versions only when `catalogAutoDrop` is also on. */
  async sweep(by: Principal): Promise<RunReport | undefined> {
    if (!isDispatcher(by)) throw new DomainError("forbidden", `${by.id} is not the dispatcher`);
    const values = await this.#deps.settings.effective();
    await this.#warn(values);
    if (!values.autoRun) {
      // Owner decision 2026-10-22 (14 days) and card K06c: stored model thinking goes at its time without the owner turning the general automatic run on, while `thinkingAuto` (the owner's switch, on by default) stands. Nothing else is touched.
      if (!values.thinkingAuto) return undefined;
      const now = (this.#deps.now ?? Date.now)();
      if (this.#lastThinking !== undefined && now - this.#lastThinking < (this.#deps.autoEveryMs ?? 3_600_000)) return undefined;
      this.#lastThinking = now;
      // Nothing due: nothing is written (no run record every hour for an empty pass).
      if ((await this.#run(by, { dryRun: true, thinkingOnly: true }, true)).candidates.length === 0) return undefined;
      return this.#run(by, { dryRun: false, thinkingOnly: true }, true);
    }
    // A run reads the whole store, so it is not made every tick.
    const clock = (this.#deps.now ?? Date.now)();
    if (this.#lastAuto !== undefined && clock - this.#lastAuto < (this.#deps.autoEveryMs ?? 3_600_000)) return undefined;
    this.#lastAuto = clock;
    return this.#run(by, { dryRun: false }, true);
  }

  async #run(by: Principal, options: { dryRun?: boolean; confirm?: string; limit?: number; commandId?: string; thinkingOnly?: boolean }, auto: boolean): Promise<RunReport> {
    const dryRun = options.dryRun ?? true;
    const limit = options.limit ?? RUN_LIMIT.default;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > RUN_LIMIT.max) invalid("limit", `must be a whole number from 1 to ${RUN_LIMIT.max}`);
    const stored = await this.#deps.settings.effective();
    // The thinking-only pass: every other rule is off for it, the backups are not pruned, nothing else is looked at.
    const values: RetentionValues = options.thinkingOnly === true ? onlyThinking(stored) : stored;
    const now = Date.parse(this.#runner.now());
    const candidates: Candidate[] = []; const retained: RunReport["retained"] = [];
    const piAttempts = new Map<string, string[]>();
    let partial = false;
    if (values.derivedDays !== null) {
      const cutoff = now - values.derivedDays * DAY;
      const material = await RetainedMaterial.build(this.#runner.storage);
      for (const kind of DERIVED_KINDS) {
        const complete = await scan(this.#runner, kind, (a) => {
          if (Date.parse(a.updatedAt) >= cutoff) return;
          const why = material.why(kind, a.id);
          const projectId = (a.body as { projectId?: unknown }).projectId;
          if (why !== undefined) { if (retained.length < RETAINED_LISTED) retained.push({ kind, id: a.id, reasons: why }); return; }
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
          if (why !== undefined) { if (retained.length < RETAINED_LISTED) retained.push({ kind, id: a.id, reasons: why }); return; }
          const projectId = (a.body as { projectId?: unknown }).projectId;
          candidates.push({ kind, id: a.id, revision: a.revision, projectId: typeof projectId === "string" ? projectId : undefined, ageDays: Math.floor((now - Date.parse(a.updatedAt)) / DAY) });
        });
        if (!complete) partial = true;
      }
      if (candidates.length > limit) { candidates.length = limit; partial = true; }
    }
    if (values.checkRecordDays !== null) {
      // Responsibility checks (card P04) that were finished: a check is owed only while its slot is after the responsibility's last recorded check, so a record at or before it (or of a retired or missing responsibility) is history. Card K06d.
      const cutoff = now - values.checkRecordDays * DAY;
      const old: Aggregate[] = [];
      const complete = await scan(this.#runner, "responsibility-check", (a) => { const slot = Date.parse((a.body as { slotStart?: string }).slotStart ?? ""); if (Number.isFinite(slot) && slot < cutoff) old.push(a); });
      if (!complete) partial = true;
      for (const a of old) {
        if (candidates.length >= limit) { partial = true; break; }
        const b = a.body as { responsibilityId?: unknown; projectId?: unknown; slotStart: string };
        const resp = typeof b.responsibilityId === "string" ? await this.#runner.get("responsibility", b.responsibilityId) : undefined;
        const log = typeof b.responsibilityId === "string" ? (await this.#runner.get("responsibility-log", b.responsibilityId))?.body as { lastCheckAt?: string } | undefined : undefined;
        const live = resp !== undefined && (resp.body as { state?: unknown }).state !== "retired";
        const done = !live || (log?.lastCheckAt !== undefined && Date.parse(log.lastCheckAt) >= Date.parse(b.slotStart));
        if (!done) continue;
        candidates.push({ kind: "responsibility-check", id: a.id, revision: a.revision, projectId: typeof b.projectId === "string" ? b.projectId : undefined, ageDays: Math.floor((now - Date.parse(b.slotStart)) / DAY) });
      }
    }
    if (values.concernDays !== null) {
      // Stall concerns (card H11) that are over. The owner's decision stays in the audit; the working record goes. Card K06d.
      const cutoff = now - values.concernDays * DAY;
      const old: Aggregate[] = [];
      const complete = await scan(this.#runner, "stall-concern", (a) => { const c = a.body as { lastChangedAt?: string; state?: string }; if (c.state !== "suspected" && Date.parse(c.lastChangedAt ?? "") < cutoff) old.push(a); });
      if (!complete) partial = true;
      for (const a of old) {
        if (candidates.length >= limit) { partial = true; break; }
        const c = a.body as { state: string; taskId?: string; projectId?: unknown; lastChangedAt: string; dismissedUntil?: string; generation?: unknown; recoveryPending?: unknown };
        if (c.state !== "cleared" && c.state !== "dismissed" && c.state !== "confirmed") continue;
        // A dismissal is in force until its end (one with no end is in force for good, as the stall scan reads it); a recovery step half made is finished on this record.
        if (c.state === "dismissed" && !(c.dismissedUntil !== undefined && Date.parse(c.dismissedUntil) < now)) continue;
        if (c.recoveryPending !== undefined) continue;
        // The stall scan names a concern by (task, generation, kind) and opens it with a command ID made from that name alone, so a concern removed while its task can still
        // stall under the same generation could never be opened again (the scan's create would be answered as the old command). Only a concern that can never be written
        // again goes: its task is done, cancelled or gone (final), or the task was assigned again since (the generation only grows). Both stay true, so no race with the confirm.
        const task = typeof c.taskId === "string" ? (await this.#runner.get("task", c.taskId))?.body as { state?: string } | undefined : undefined;
        let over = task === undefined || task.state === "done" || task.state === "cancelled";
        if (!over && typeof c.taskId === "string" && typeof c.generation === "number") {
          const generation = ((await this.#runner.get("assignment", assignmentIdOf(c.taskId)))?.body as { generation?: unknown } | undefined)?.generation;
          over = typeof generation === "number" && generation > c.generation;
        }
        if (!over) continue;
        candidates.push({ kind: "stall-concern", id: a.id, revision: a.revision, projectId: typeof c.projectId === "string" ? c.projectId : undefined, ageDays: Math.floor((now - Date.parse(c.lastChangedAt)) / DAY) });
      }
    }
    if (values.stallEvidenceDays !== null || values.stallSpeedDays !== null) {
      // Card K06e. What the stall scan keeps about progress. Evidence is per task (one record, ID = task), and a done, cancelled or gone task is final, so nothing writes it again;
      // a measured speed is per route and host and the writer reads before it creates, so a removed one is simply measured again (a record created again under the same ID continues the removed revision, so the removal command of the earlier one is never mistaken for it).
      const evidence: Aggregate[] = [];
      const evidenceComplete = await scan(this.#runner, "stall-evidence", (a) => { evidence.push(a); });
      if (!evidenceComplete) partial = true;
      if (values.stallEvidenceDays !== null) {
        const cutoff = now - values.stallEvidenceDays * DAY;
        const old = evidence.filter((a) => Date.parse((a.body as { lastReportAt?: string }).lastReportAt ?? "") < cutoff);
        // A task with a suspected concern or a recovery step half made is still being worked on.
        const live = new Set<string>(); let concernsComplete = true;
        if (old.length > 0) concernsComplete = await scan(this.#runner, "stall-concern", (a) => { const c = a.body as { taskId?: unknown; state?: string; recoveryPending?: unknown }; if (typeof c.taskId === "string" && (c.state === "suspected" || c.recoveryPending !== undefined)) live.add(c.taskId); });
        if (!concernsComplete) partial = true;
        else for (const a of old) {
          if (candidates.length >= limit) { partial = true; break; }
          const b = a.body as { taskId?: unknown; projectId?: unknown; lastReportAt: string };
          const taskId = typeof b.taskId === "string" ? b.taskId : a.id;
          const task = await this.#runner.get("task", taskId);
          const state = (task?.body as { state?: string } | undefined)?.state;
          if (task !== undefined && state !== "done" && state !== "cancelled") continue;
          if (live.has(taskId)) continue;
          const last = Math.max(Date.parse(b.lastReportAt), task === undefined ? 0 : Date.parse(task.updatedAt));
          if (!(last < cutoff)) continue;
          candidates.push({ kind: "stall-evidence", id: a.id, revision: a.revision, projectId: typeof b.projectId === "string" ? b.projectId : undefined, ageDays: Math.floor((now - last) / DAY) });
        }
      }
      // A request in flight in a progress record the scan did not reach could name any route, so no speed is removed on a partial view (K06e review).
      if (values.stallSpeedDays !== null && evidenceComplete) {
        const cutoff = now - values.stallSpeedDays * DAY;
        // A request in flight names its route: its speed is kept.
        const inFlight = new Set<string>();
        for (const a of evidence) { const r = (a.body as { request?: { route?: unknown } }).request?.route; if (typeof r === "string") inFlight.add(r); }
        const old: Aggregate[] = [];
        if (!(await scan(this.#runner, "stall-speed", (a) => { if (Date.parse((a.body as { updatedAt?: string }).updatedAt ?? "") < cutoff) old.push(a); }))) partial = true;
        for (const a of old) {
          if (candidates.length >= limit) { partial = true; break; }
          const b = a.body as { route?: unknown; updatedAt: string };
          if (typeof b.route === "string" && inFlight.has(b.route)) continue;
          candidates.push({ kind: "stall-speed", id: a.id, revision: a.revision, projectId: undefined, ageDays: Math.floor((now - Date.parse(b.updatedAt)) / DAY) });
        }
      }
    }
    if (values.responsibilityHistoryDays !== null) {
      // Card K06e. A retired responsibility is final (nothing can be recorded or reported on it), so its history entries (the log keeps the count, so no sequence number is used twice) and
      // its incident slots (the incident IDs are made from the slot's generation, which is only counted up by a report) can never be written again. The responsibility, its log, its incidents and its check records stay.
      const cutoff = now - values.responsibilityHistoryDays * DAY;
      const retiredOld: Aggregate[] = [];
      if (!(await scan(this.#runner, "responsibility", (a) => { if ((a.body as { state?: string }).state === "retired" && Date.parse(a.updatedAt) < cutoff) retiredOld.push(a); }))) partial = true;
      const retiredIds = new Map(retiredOld.map((a) => [a.id, a] as const));
      full: for (const r of retiredOld) {
        const n = ((await this.#runner.get("responsibility-log", r.id))?.body as { n?: unknown } | undefined)?.n;
        const project = (r.body as { projectId?: unknown }).projectId;
        for (let seq = 1; typeof n === "number" && seq <= n; seq++) {
          const ev = await this.#runner.get("responsibility-event", `${r.id}.${seq}`);
          if (ev === undefined) continue;
          if (candidates.length >= limit) { partial = true; break full; }
          candidates.push({ kind: "responsibility-event", id: ev.id, revision: ev.revision, projectId: typeof project === "string" ? project : undefined, ageDays: Math.floor((now - Date.parse(r.updatedAt)) / DAY) });
        }
      }
      if (retiredIds.size > 0 && !partial) {
        // Which responsibility a slot belongs to: its own record (written since this card), else an incident of that responsibility and signature (a slot whose incidents were all purged before is not tied to anyone and stays).
        const owner = new Map<string, string>(); const openIncident = new Set<string>();
        if (!(await scan(this.#runner, "responsibility-incident", (a) => { const b = a.body as { responsibilityId?: unknown; signature?: unknown; state?: string }; if (typeof b.responsibilityId === "string" && typeof b.signature === "string") { const slot = incidentSlotId(b.responsibilityId, b.signature); owner.set(slot, b.responsibilityId); if (b.state === "open") openIncident.add(slot); } }))) partial = true;
        const slots: Aggregate[] = [];
        if (!(await scan(this.#runner, "responsibility-incident-slot", (a) => { slots.push(a); }))) partial = true;
        for (const a of slots) {
          const rid = (a.body as { responsibilityId?: unknown }).responsibilityId;
          const resp = retiredIds.get(typeof rid === "string" ? rid : owner.get(a.id) ?? "");
          if (resp === undefined || openIncident.has(a.id)) continue;
          const openId = (a.body as { openId?: unknown }).openId;
          if (typeof openId === "string" && (await this.#runner.get("responsibility-incident", openId)) !== undefined && ((await this.#runner.get("responsibility-incident", openId))!.body as { state?: string }).state === "open") continue;
          if (candidates.length >= limit) { partial = true; break; }
          const project = (resp.body as { projectId?: unknown }).projectId;
          candidates.push({ kind: "responsibility-incident-slot", id: a.id, revision: a.revision, projectId: typeof project === "string" ? project : undefined, ageDays: Math.floor((now - Date.parse(resp.updatedAt)) / DAY) });
        }
      }
    }
    const keepVersions = values.catalogVersionsKept;
    let versions: { items: { name: string; version: string; versionId: string; revision: number; ageDays: number }[]; partial: boolean } | undefined;
    const versionsRetained: { name: string; version: string; reasons: string[] }[] = [];
    if (keepVersions !== null && this.#deps.catalog !== undefined && (!auto || values.catalogAutoDrop)) {
      const found = await this.#deps.catalog.retentionCandidates(by, keepVersions, limit);
      const material = await RetainedMaterial.build(this.#runner.storage);
      const free = found.items.filter((v) => { const why = material.why("catalog-version", v.versionId); if (why !== undefined) { if (versionsRetained.length < RETAINED_LISTED) versionsRetained.push({ name: v.name, version: v.version, reasons: why }); return false; } return true; });
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
    const backupsPort = options.thinkingOnly === true ? undefined : this.#deps.backups;
    const wouldDelete = backupsPort === undefined ? undefined : await backupsPort.preview(counts);
    // The incidents a run would archive and remove (card T02c: what the owner confirms includes them): counted in the preview and part of the digest, so a run refuses when they changed.
    if (values.noteArchiveDays !== null) {
      // Card K06c (context archives). The whole text of a note that was cut (C07p), one record per task and digest. A task that is done or cancelled is final (`TRANSITIONS`), and one that does not exist cannot come back, so nothing needs the text for work;
      // a task that can still run keeps it (its notes name it). The writer of an archive makes it again under the same ID after a removal, with a command ID that is new then (see `archiveNote`), so a late write of the same note is not lost.
      const cutoff = now - values.noteArchiveDays * DAY;
      const tasks = new Map<string, boolean>();
      // Only what the rule needs is kept from the scan: an archive holds up to `archiveChars` of text, and up to SCAN_LIMIT of them are read, so keeping the records themselves could hold gigabytes for one run.
      const old: { id: string; revision: number; updatedAt: string; taskId: unknown; projectId: unknown }[] = [];
      if (!(await scan(this.#runner, "ctx-note-archive", (a) => { if (Date.parse(a.updatedAt) < cutoff) { const b = a.body as { taskId?: unknown; projectId?: unknown }; old.push({ id: a.id, revision: a.revision, updatedAt: a.updatedAt, taskId: b.taskId, projectId: b.projectId }); } }))) partial = true;
      for (const a of old) {
        if (candidates.length >= limit) { partial = true; break; }
        if (typeof a.taskId !== "string") continue;
        let final = tasks.get(a.taskId);
        // A read that fails throws (the run stops); only a task that is really not there counts as gone.
        if (final === undefined) { const state = (await this.#runner.get("task", a.taskId))?.body as { state?: string } | undefined; final = state === undefined || state.state === "done" || state.state === "cancelled"; tasks.set(a.taskId, final); }
        if (!final) continue;
        candidates.push({ kind: "ctx-note-archive", id: a.id, revision: a.revision, projectId: typeof a.projectId === "string" ? a.projectId : undefined, ageDays: Math.floor((now - Date.parse(a.updatedAt)) / DAY) });
      }
    }
    {
      // Card U09b / K06c: the thinking the controller kept for a task (`thinking-record`) is removed `thinkingDays` after the task is finished (owner decision 2026-10-22: 14). Done and cancelled are final, and a task that does not exist cannot
      // come back; a task that can still run keeps its thinking. The age is the later of the record's last change and the task's last change (a finished task's last change is at or after its end, so a record is never removed early).
      // The record is not deleted: it is replaced by a small marker (`removedAt`, counts, no text) so the replay can say retention removed it and nothing more is collected for the task.
      const cutoff = now - values.thinkingDays * DAY;
      const tasks = new Map<string, number | null>();
      const old: { id: string; revision: number; updatedAt: string; taskId: unknown; projectId: unknown }[] = [];
      if (!(await scan(this.#runner, "thinking-record", (a) => { const b = a.body as { taskId?: unknown; projectId?: unknown; removedAt?: unknown }; if (b.removedAt === undefined && Date.parse(a.updatedAt) < cutoff) old.push({ id: a.id, revision: a.revision, updatedAt: a.updatedAt, taskId: b.taskId, projectId: b.projectId }); }))) partial = true;
      for (const a of old) {
        if (candidates.length >= limit) { partial = true; break; }
        if (typeof a.taskId !== "string") continue;
        let ended = tasks.get(a.taskId);
        if (ended === undefined) { const t = await this.#runner.get("task", a.taskId); const state = (t?.body as { state?: string } | undefined)?.state; ended = t === undefined ? 0 : state === "done" || state === "cancelled" ? Date.parse(t.updatedAt) : null; tasks.set(a.taskId, ended); }
        if (ended === null || ended >= cutoff) continue;
        candidates.push({ kind: "thinking-record", id: a.id, revision: a.revision, projectId: typeof a.projectId === "string" ? a.projectId : undefined, ageDays: Math.floor((now - Math.max(ended, Date.parse(a.updatedAt))) / DAY) });
      }
    }
    if (this.#deps.thinkingStores !== undefined) {
      // Card K06c. The model keeps its own copy of its thinking in the conversation store of each attempt (it replays it to itself when it resumes). A task that is done or cancelled never resumes (final), so once the same days have passed the stores of its attempts
      // lose it too. What was done is a `thinking-purge` record per task: attempts that are cleaned (or have no store) are not asked again; one that could not be reached stays pending and the task is a candidate again on the next run.
      const cutoff = now - values.thinkingDays * DAY;
      const attemptsOf = new Map<string, Set<string>>();
      const finalTasks: Aggregate[] = [];
      if (!(await scan(this.#runner, "task", (a) => { const b = a.body as { state?: string }; if ((b.state === "done" || b.state === "cancelled") && Date.parse(a.updatedAt) < cutoff) finalTasks.push(a); }))) partial = true;
      if (finalTasks.length > 0) {
        const wanted = new Set(finalTasks.map((t) => t.id));
        // An attempt whose record still says it runs (a cancel that has not reached its process yet, a host that has not reported the end) may still be writing its store: it is left for a later run (review fix).
        if (!(await scan(this.#runner, DISPATCH_KIND, (a) => { const b = a.body as { taskId?: unknown; attemptId?: unknown; state?: unknown }; if (typeof b.taskId === "string" && wanted.has(b.taskId) && typeof b.attemptId === "string" && b.state !== "running") { const set = attemptsOf.get(b.taskId) ?? new Set<string>(); set.add(b.attemptId); attemptsOf.set(b.taskId, set); } }))) partial = true;
      }
      for (const t of finalTasks) {
        if (candidates.length >= limit) { partial = true; break; }
        const record = await this.#runner.get("thinking-purge", t.id);
        const done = (record?.body as { attempts?: Record<string, unknown> } | undefined)?.attempts ?? {};
        const todo = [...(attemptsOf.get(t.id) ?? [])].filter((id) => done[id] !== "purged" && done[id] !== "none");
        if (todo.length === 0) continue;
        piAttempts.set(t.id, todo);
        candidates.push({ kind: "pi-thinking", id: t.id, revision: record?.revision ?? 0, projectId: typeof (t.body as { projectId?: unknown }).projectId === "string" ? (t.body as { projectId: string }).projectId : undefined, ageDays: Math.floor((now - Date.parse(t.updatedAt)) / DAY) });
      }
    }
    if (values.scratchArchiveDays !== null || values.scratchPurgeDays !== null) {
      // Card K06b, tier "scratch output": an agent's private scratch (desk records that only it reads) written for a task that is done or cancelled. Archived first when `scratchArchiveDays` is set (the text moves into an archive and
      // `retention.restore` puts it back exactly), removed for good `scratchPurgeDays` later (the same removal as a user-requested deletion: what was made from it goes with it). A record a resumable task needs, or a replay cites, is not touched.
      const finalTask = new Map<string, boolean>();
      const isFinal = async (taskId: string): Promise<boolean> => { let f = finalTask.get(taskId); if (f === undefined) { const st = ((await this.#runner.get("task", taskId))?.body as { state?: string } | undefined)?.state; f = st === "done" || st === "cancelled"; finalTask.set(taskId, f); } return f; };
      const material = await RetainedMaterial.build(this.#runner.storage);
      const archiveCut = values.scratchArchiveDays === null ? undefined : now - values.scratchArchiveDays * DAY;
      const purgeCut = values.scratchPurgeDays === null ? undefined : now - values.scratchPurgeDays * DAY;
      const scratch: Aggregate[] = [];
      if (!(await scan(this.#runner, "desk-record", (a) => { const b = a.body as { visibility?: unknown; taskId?: unknown; deleted?: unknown }; if (b.visibility === "private" && typeof b.taskId === "string" && b.deleted === undefined) scratch.push(a); }))) partial = true;
      for (const a of scratch) {
        if (candidates.length >= limit) { partial = true; break; }
        const b = a.body as { taskId: string; projectId?: unknown; archived?: { at?: unknown; archiveId?: unknown } };
        const projectId = typeof b.projectId === "string" ? b.projectId : undefined;
        let action: "scratch-archive" | "scratch-purge" | undefined;
        if (b.archived !== undefined) {
          const at = Date.parse(String((await this.#runner.get("retention-archive", archiveIdOf(a.id)))?.body?.["at"] ?? b.archived.at ?? ""));
          if (purgeCut !== undefined && Number.isFinite(at) && at < purgeCut) action = "scratch-purge";
        } else if (archiveCut !== undefined && Date.parse(a.updatedAt) < archiveCut) action = "scratch-archive";
        else if (archiveCut === undefined && purgeCut !== undefined && Date.parse(a.updatedAt) < purgeCut) action = "scratch-purge";
        if (action === undefined || !(await isFinal(b.taskId))) continue;
        const why = material.why("desk-record", a.id)?.filter((w) => !w.includes(`written for task ${b.taskId}`) && (action === "scratch-purge" || !isReplayReason(w)));
        if (why !== undefined && why.length > 0) { if (retained.length < RETAINED_LISTED) retained.push({ kind: "desk-record", id: a.id, reasons: why }); continue; }
        candidates.push({ kind: action, id: a.id, revision: a.revision, projectId, ageDays: Math.floor((now - Date.parse(a.updatedAt)) / DAY) });
      }
    }
    if (values.transcriptDays !== null) {
      // Card K06b, tier "old transcripts": the owner's words in chat turns. A turn that a decision, an agenda item, an open proposal or a held command still names stays.
      const cutoff = now - values.transcriptDays * DAY;
      const old: Aggregate[] = [];
      if (!(await scan(this.#runner, "chat-turn", (a) => { const b = a.body as { status?: string; completedAt?: string; held?: unknown[]; followUps?: unknown[]; retention?: unknown; resumedBy?: unknown; resumes?: unknown }; if (b.status === "done" && b.retention === undefined && Date.parse(b.completedAt ?? "") < cutoff && (b.held === undefined || b.held.length === 0 || b.resumedBy !== undefined) && (b.followUps === undefined || b.followUps.length === 0)) old.push(a); }))) partial = true;
      if (old.length > 0) {
        const material = await RetainedMaterial.build(this.#runner.storage, { transcripts: true });
        for (const a of old) {
          if (candidates.length >= limit) { partial = true; break; }
          const why = material.why("chat-turn", a.id);
          if (why !== undefined) { if (retained.length < RETAINED_LISTED) retained.push({ kind: "chat-turn", id: a.id, reasons: why }); continue; }
          const b = a.body as { projectId?: unknown; completedAt: string };
          candidates.push({ kind: "chat-turn", id: a.id, revision: a.revision, projectId: typeof b.projectId === "string" ? b.projectId : undefined, ageDays: Math.floor((now - Date.parse(b.completedAt)) / DAY) });
        }
      }
    }
    let incidentsDue: { archive: string[]; purge: string[]; more: boolean } | undefined;
    if (this.#deps.incidents?.due !== undefined && this.#deps.projects !== undefined && (values.incidentArchiveDays !== null || values.incidentPurgeDays !== null)) {
      incidentsDue = { archive: [], purge: [], more: false };
      for (const projectId of await this.#deps.projects()) {
        const one = await this.#deps.incidents.due(by, { ...(values.incidentArchiveDays === null ? {} : { archiveDays: values.incidentArchiveDays }), ...(values.incidentPurgeDays === null ? {} : { purgeDays: values.incidentPurgeDays }), projectId });
        incidentsDue.archive.push(...one.archive); incidentsDue.purge.push(...one.purge);
        if (one.more === true) { incidentsDue.more = true; partial = true; }
      }
    }
    const digest = digestOf({ c: candidates.map((c) => `${c.kind}/${c.id}@${c.revision}`), b: wouldDelete ?? [], i: [values.incidentArchiveDays, values.incidentPurgeDays, incidentsDue === undefined ? null : [incidentsDue.archive, incidentsDue.purge]], v: versions === undefined ? null : [keepVersions, ...versions.items.map((v) => `${v.versionId}@${v.revision}`)], x: revoked === undefined ? null : [values.revokedBytesDays, ...revoked.items.map((r) => r.recordId)] });
    const base: RunReport = {
      dryRun, enabled: values.derivedDays !== null || values.generationRunDays !== null || values.contextRouteDays !== null || values.checkRecordDays !== null || values.concernDays !== null || values.stallEvidenceDays !== null || values.stallSpeedDays !== null || values.responsibilityHistoryDays !== null || values.noteArchiveDays !== null || values.scratchArchiveDays !== null || values.scratchPurgeDays !== null || values.transcriptDays !== null, derivedDays: values.derivedDays, candidates, removed: 0, retained, partial,
      ...(backupsPort === undefined ? {} : { backups: { kept: (await backupsPort.list()).length - (wouldDelete?.length ?? 0), ...(dryRun ? { wouldDelete: wouldDelete ?? [] } : {}), counts } }),
      ...(this.#deps.incidents === undefined ? {} : { incidents: { archiveDays: values.incidentArchiveDays, purgeDays: values.incidentPurgeDays, ...(incidentsDue === undefined || !dryRun ? {} : { wouldArchive: incidentsDue.archive.length, wouldPurge: incidentsDue.purge.length, ...(incidentsDue.more ? { more: true } : {}) }) } }),
      ...(revoked === undefined ? {} : { revokedBytes: { days: values.revokedBytesDays!, candidates: revoked.items.map((r) => ({ name: r.name, version: r.version, ageDays: r.ageDays })), blanked: 0, partial: revoked.partial } }),
      ...(versions === undefined ? {} : { catalogVersions: { keep: keepVersions!, candidates: versions.items.map((v) => ({ name: v.name, version: v.version, ageDays: v.ageDays })), retained: versionsRetained, removed: 0, partial: versions.partial } }),
    };
    if (dryRun) return { ...base, digest };
    if (!auto && options.confirm !== digest) throw new DomainError("invalid_command", "confirm: what retention would remove has changed since the preview (or confirm was not given); preview again and pass its digest", { field: "confirm" });

    const removedIds: string[] = [];
    // A hold can appear while the run is going (a task resumes, a checkpoint cites a summary): the holds are read again before every batch, and a candidate held now is kept and shown as retained.
    for (let i = 0; i < candidates.length; i += REMOVE_BATCH) {
      await this.#deps.beforeBatch?.(i / REMOVE_BATCH);
      const batch = candidates.slice(i, i + REMOVE_BATCH);
      const material = await RetainedMaterial.build(this.#runner.storage, { routeArchive: batch.some((c) => c.kind === "ctx-route-archive"), transcripts: batch.some((c) => c.kind === "chat-turn") });
      for (const c of batch) {
        // The tiers of card K06b act on desk records under their own names; an archive is not stopped by a replay's citation (it keeps the original), a removal is.
        const heldAs = c.kind === "scratch-archive" || c.kind === "scratch-purge" ? "desk-record" : c.kind;
        const why = c.kind === "pi-thinking" ? undefined : material.why(heldAs, c.id)?.filter((w) => !(c.kind === "scratch-archive" && isReplayReason(w)) && !((c.kind === "scratch-archive" || c.kind === "scratch-purge") && w.includes("written for task")));
        if (why !== undefined && why.length > 0) { if (retained.length < RETAINED_LISTED) retained.push({ kind: c.kind, id: c.id, reasons: why }); continue; }
        if (c.kind === "pi-thinking" || c.kind === "scratch-archive" || c.kind === "scratch-purge") {
          const tier = c.kind === "pi-thinking" ? await this.#purgeStores(by, c, piAttempts.get(c.id) ?? [], values.thinkingDays) : c.kind === "scratch-archive" ? await this.#tierArchive(by, c) : await this.#tierPurge(by, c, values.scratchPurgeDays!);
          if (tier) removedIds.push(`${c.kind}/${c.id}`);
          continue;
        }
        const done = await this.#removeOne(by, c, c.kind === "chat-turn" ? values.transcriptDays! : c.kind === "generation-run" ? values.generationRunDays! : c.kind === "ctx-route-archive" || c.kind === "ctx-admission" ? values.contextRouteDays! : c.kind === "responsibility-check" ? values.checkRecordDays! : c.kind === "stall-concern" ? values.concernDays! : c.kind === "stall-evidence" ? values.stallEvidenceDays! : c.kind === "stall-speed" ? values.stallSpeedDays! : c.kind === "responsibility-event" || c.kind === "responsibility-incident-slot" ? values.responsibilityHistoryDays! : c.kind === "ctx-note-archive" ? values.noteArchiveDays! : c.kind === "thinking-record" ? values.thinkingDays : values.derivedDays!);
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
          if (why !== undefined) { if (versionsRetained.length < RETAINED_LISTED) versionsRetained.push({ name: v.name, version: v.version, reasons: why }); continue; }
          // The holds are read once more inside the drop, after the version is claimed and nothing new can start on it (a call or a task can take a version between the batch's read and here).
          const dropped = await this.#deps.catalog.dropVersion(by, { name: v.name, version: v.version, revision: v.revision, keep: keepVersions }, async (versionId) => (await RetainedMaterial.build(this.#runner.storage)).why("catalog-version", versionId));
          if (dropped.held !== undefined && versionsRetained.length < RETAINED_LISTED) versionsRetained.push({ name: v.name, version: v.version, reasons: [...dropped.held] });
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
      if (!auto && incidentsDue !== undefined) {
        // The owner's confirmed run acts on exactly the incidents the preview named (each still has to qualify when it is handled), not on whatever qualifies by now.
        const chunks = <T,>(all: readonly T[]): T[][] => { const out: T[][] = []; for (let i = 0; i < all.length; i += 200) out.push(all.slice(i, i + 200)); return out; };
        if (values.incidentArchiveDays !== null) for (const ids of chunks(incidentsDue.archive)) archived += await this.#deps.incidents.archive(by, { olderThanDays: values.incidentArchiveDays, limit: ids.length, ids });
        if (values.incidentPurgeDays !== null) for (const ids of chunks(incidentsDue.purge)) purged += await this.#deps.incidents.purge(by, { olderThanDays: values.incidentPurgeDays, limit: ids.length, ids });
      } else {
        for (const projectId of await this.#deps.projects()) {
          if (values.incidentArchiveDays !== null) archived += await this.#deps.incidents.archive(by, { olderThanDays: values.incidentArchiveDays, projectId });
          if (values.incidentPurgeDays !== null) purged += await this.#deps.incidents.purge(by, { olderThanDays: values.incidentPurgeDays, projectId });
        }
      }
    }
    // The automatic thinking-only pass that removed nothing (every candidate still pending: a host that does not answer, a running attempt) leaves no run record, so a store that cannot be reached does not add one every hour (review fix).
    if (auto && options.thinkingOnly === true && removedIds.length === 0) return { ...base, dryRun: false, removed: 0 };
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

  /** Blanks the executable text of one revoked version's record (title and body gone, a marker left), guarded by the revision read now; the deletion ledger is written after the guarded command has gone through (so a record that was left alone never has an entry), so a restore of an older backup blanks it again. */
  async #blankExecutable(by: Principal, r: { name: string; version: string; versionId: string; recordId: string; digest: string; revision: number }): Promise<boolean> {
    const found = await this.#runner.get("desk-record", r.recordId);
    if (found === undefined) return false;
    const body = found.body as Record<string, unknown>;
    if (body["deleted"] !== undefined) return false;
    // Only the content that was revoked: a record edited since the registration (new text or a new revision) is somebody's live work and stays.
    if (typeof body["body"] !== "string" || createHash("sha256").update(body["body"]).digest("hex") !== r.digest || found.revision !== r.revision) return false;
    // Something may cite it since the preview.
    if ((await RetainedMaterial.build(this.#runner.storage)).why("desk-record", r.recordId) !== undefined) return false;
    await this.#deps.beforeBlank?.(r.recordId);
    const at = this.#runner.now();
    const deletionId = cmdId("rtb", r.versionId, r.recordId);
    try {
      await this.#runner.command("retention.revoked-bytes", { commandId: cmdId("rtb", r.versionId, found.revision), actor: by.id }, async () => ({
        payload: { versionId: r.versionId, recordId: r.recordId, revision: found.revision },
        build: async (): Promise<Built> => {
          const fresh = await this.#runner.get("desk-record", r.recordId);
          if (fresh === undefined || fresh.revision !== found.revision) throw new DomainError("stale_revision", "changed since the preview");
          // Writing a dependency manifest that cites the record does not change the record's revision, so the citations are read again here, as the last thing before the guarded write: a task that took the record after the first read keeps it.
          if ((await RetainedMaterial.build(this.#runner.storage)).why("desk-record", r.recordId) !== undefined) throw new DomainError("stale_revision", "something cites it since the preview");
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
          // Thinking is replaced by its marker, not deleted: the marker is how the replay knows retention removed it, and it stops anything more being kept for the task.
          const fb = fresh.body as { projectId?: unknown; taskId?: unknown; agent?: unknown; next?: unknown; blocks?: unknown; dropped?: unknown };
          const changes: Change[] = [c.kind === "chat-turn"
            ? { type: "update", ref, expectedRevision: fresh.revision, body: transcriptStub(fresh.body as Record<string, unknown>, this.#runner.now(), days) }
            : c.kind === "thinking-record"
            ? { type: "update", ref, expectedRevision: fresh.revision, body: { projectId: fb.projectId, taskId: fb.taskId, agent: fb.agent, next: fb.next, blocks: [], dropped: Number(fb.dropped ?? 0) + (Array.isArray(fb.blocks) ? fb.blocks.length : 0), marks: [], removedAt: this.#runner.now(), updatedAt: this.#runner.now() } as unknown as JsonObject }
            : { type: "delete", ref, expectedRevision: fresh.revision }];
          if (arc !== undefined) changes.push({ type: "delete", ref: { kind: "retention-archive", id: arc.id }, expectedRevision: arc.revision });
          // The chat's conversation context keeps a line of each recent turn (the start of the owner's words and the answer) per project: that copy goes with the turn's words, in the same command (review fix).
          if (c.kind === "chat-turn") { const ctx = await this.#contextWithout(fresh.body as { ownerId?: unknown }, c.id); if (ctx !== undefined) changes.push(ctx); }
          return { ref, creates: false, changes, ...(arc === undefined ? {} : { audit: [{ type: "retention.expire.archive", subject: { kind: "retention-archive", id: arc.id }, detail: { with: c.id } }] }), detail: { rule: c.kind === "generation-run" ? "generation-run-days" : c.kind === "ctx-route-archive" || c.kind === "ctx-admission" ? "context-route-days" : c.kind === "responsibility-check" ? "check-record-days" : c.kind === "stall-concern" ? "concern-days" : c.kind === "stall-evidence" ? "stall-evidence-days" : c.kind === "stall-speed" ? "stall-speed-days" : c.kind === "responsibility-event" || c.kind === "responsibility-incident-slot" ? "responsibility-history-days" : c.kind === "ctx-note-archive" ? "note-archive-days" : c.kind === "thinking-record" ? "thinking-days" : c.kind === "chat-turn" ? "transcript-days" : "derived-days", days, ageDays: c.ageDays, ...(c.projectId === undefined ? {} : { projectId: c.projectId }) } };
        },
      }));
      return !r.replayed;
    } catch (error) {
      if (error instanceof DomainError && (error.code === "stale_revision" || error.code === "not_found")) return false;
      throw error;
    }
  }

  /** The chat context of the turn's owner with the lines of that turn replaced by a removal note (`undefined` when it holds none). */
  async #contextWithout(turn: { ownerId?: unknown }, turnId: string): Promise<Change | undefined> {
    if (typeof turn.ownerId !== "string") return undefined;
    const ref = { kind: "chat-context", id: `ctx:${turn.ownerId}` };
    const cur = await this.#runner.get(ref.kind, ref.id);
    const body = cur?.body as { projects?: Record<string, { turns?: { turnId?: unknown; summary?: unknown }[] }> } | undefined;
    if (cur === undefined || body?.projects === undefined || typeof body.projects !== "object") return undefined;
    let changed = false;
    const projects: Record<string, unknown> = {};
    for (const [pid, p] of Object.entries(body.projects)) {
      const turns = Array.isArray(p?.turns) ? p.turns.map((t) => { if (t?.turnId !== turnId || t.summary === TRANSCRIPT_REMOVED) return t; changed = true; return { ...t, summary: TRANSCRIPT_REMOVED }; }) : p?.turns;
      projects[pid] = p === null || typeof p !== "object" ? p : { ...p, ...(turns === undefined ? {} : { turns }) };
    }
    return changed ? { type: "update", ref, expectedRevision: cur.revision, body: { ...(cur.body as object), projects } as unknown as JsonObject } : undefined;
  }

  /** Card K06c: removes the model's stored thinking from the conversation stores of a finished task's attempts, and records which were cleaned. Returns whether anything was cleaned now. */
  async #purgeStores(by: Principal, c: Candidate, todo: readonly string[], days: number): Promise<boolean> {
    const port = this.#deps.thinkingStores;
    if (port === undefined || todo.length === 0) return false;
    // The task is final (done or cancelled) and the record is as previewed; anything else is left for the next run.
    const task = await this.#runner.get("task", c.id);
    const state = (task?.body as { state?: string } | undefined)?.state;
    if (task === undefined || (state !== "done" && state !== "cancelled")) return false;
    const before = await this.#runner.get("thinking-purge", c.id);
    if ((before?.revision ?? 0) !== c.revision) return false;
    const answer = await port.purge(todo);
    const settled = todo.filter((id) => answer.status[id] === "purged" || answer.status[id] === "none").sort();
    const purged = settled.filter((id) => answer.status[id] === "purged");
    if (settled.length === 0) return false;
    await this.#runner.command("retention.expire", { commandId: cmdId("rtx", "pi-thinking", c.id, c.revision, ...settled), actor: by.id }, async () => ({
      payload: { kind: "thinking-purge", id: c.id, revision: c.revision, attempts: settled },
      build: async (): Promise<Built> => {
        const ref = { kind: "thinking-purge", id: c.id };
        const cur = await this.#runner.get(ref.kind, ref.id);
        if ((cur?.revision ?? 0) !== c.revision) throw new DomainError("stale_revision", "changed since the preview");
        const old = (cur?.body as { attempts?: Record<string, string>; blocks?: number } | undefined);
        const attempts: Record<string, string> = { ...(old?.attempts ?? {}) };
        for (const id of settled) attempts[id] = answer.status[id]!;
        const body = { taskId: c.id, projectId: c.projectId ?? "", attempts, blocks: (old?.blocks ?? 0) + answer.blocks, updatedAt: this.#runner.now() } as unknown as JsonObject;
        return { ref, creates: cur === undefined, changes: [cur === undefined ? { type: "create", ref, body } : { type: "update", ref, expectedRevision: cur.revision, body }], detail: { rule: "thinking-store-days", days, ageDays: c.ageDays, ...(c.projectId === undefined ? {} : { projectId: c.projectId }), attempts: settled.length, purged: purged.length, blocks: answer.blocks } };
      },
    })).catch((error: unknown) => { if (error instanceof DomainError && error.code === "stale_revision") return undefined; throw error; });
    return purged.length > 0;
  }

  /** Card K06b, scratch tier: archives one private record of a finished task (restorable by `retention.restore`), if it is still as previewed. */
  async #tierArchive(by: Principal, c: Candidate): Promise<boolean> {
    const rec = await this.#runner.get("desk-record", c.id);
    if (rec === undefined || rec.revision !== c.revision) return false;
    const b = rec.body as { taskId?: unknown; archived?: unknown; deleted?: unknown };
    if (typeof b.taskId !== "string" || b.archived !== undefined || b.deleted !== undefined) return false;
    const r = await this.#archive(by, { commandId: cmdId("rts", "archive", c.id, c.revision), taskId: b.taskId, reason: "retention rule: scratchArchiveDays" }, new Set([c.id]));
    return r.archived.includes(c.id);
  }

  /** Card K06b, scratch tier: removes one private record of a finished task for good with what was made from it (a replay's or a resumable task's hold stops it), if it is still as previewed. */
  async #tierPurge(by: Principal, c: Candidate, days: number): Promise<boolean> {
    const rec = await this.#runner.get("desk-record", c.id);
    if (rec === undefined || rec.revision !== c.revision || (rec.body as { deleted?: unknown }).deleted !== undefined) return false;
    const r = await this.#delete(by, { commandId: cmdId("rts", "purge", c.id, c.revision), recordId: c.id, reason: `retention rule: scratchPurgeDays (${days})` });
    return r.status === "deleted";
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
  async delete(owner: Principal, command: { commandId: string; recordId: string; reason: string; dryRun?: boolean; releaseReplay?: boolean }): Promise<DeletionReport> {
    if (!isOwner(owner)) throw new DomainError("forbidden", `${owner.id} may not delete records`);
    return this.#delete(owner, command);
  }

  /** The removal of a desk record and what stands on it, for the owner's command and for the scratch tier of the runner (which acts on the owner's setting and is recorded the same way). */
  async #delete(owner: Principal, command: { commandId: string; recordId: string; reason: string; dryRun?: boolean; releaseReplay?: boolean }): Promise<DeletionReport> {
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
    // A replay that cites the record holds it like a resumable task does; the owner can release exactly that hold by saying so (`releaseReplay`), and the deletion record then names the replay steps that now point at a removed record.
    const replayCited: { kind: string; id: string; reasons: string[] }[] = [];
    const heldNow = async (): Promise<{ kind: string; id: string; reasons: string[] }[]> => {
      const material = await RetainedMaterial.build(this.#runner.storage);
      const held: { kind: string; id: string; reasons: string[] }[] = [];
      replayCited.length = 0;
      const judge = (kind: string, id: string): void => {
        const why = material.why(kind, id);
        if (why === undefined) return;
        if (command.releaseReplay === true && material.complete) {
          const replay = why.filter(isReplayReason); const rest = why.filter((w) => !isReplayReason(w));
          if (replay.length > 0) replayCited.push({ kind, id, reasons: replay });
          if (rest.length > 0) held.push({ kind, id, reasons: rest });
          return;
        }
        held.push({ kind, id, reasons: why });
      };
      for (const a of members) judge("desk-record", a.id);
      for (const x of found.summaries) judge("summary-record", x.id);
      for (const c of found.compactions) judge("ctx-compaction", c.id);
      if (!found.complete) held.push({ kind: "desk-record", id: command.recordId, reasons: ["too many records to find everything made from it safely; nothing was deleted"] });
      return held;
    };
    const held = await heldNow();
    const recordBody = (status: string, extra: JsonObject = {}): JsonObject => ({ ...(replayCited.length > 0 ? { replayReleased: replayCited.slice(0, 50) as unknown as JsonObject[] } : {}), recordId: command.recordId, projectId: (root.body as { projectId?: string }).projectId ?? "", requestedBy: owner.id, reason: command.reason, at: this.#runner.now(), status, derived: derived as unknown as JsonObject, backups: backups as unknown as JsonObject, ...extra });
    if (command.dryRun === true) return { status: held.length > 0 ? "retained" : "preview", recordId: command.recordId, ...(held.length > 0 ? { retained: held } : {}), ...(replayCited.length > 0 ? { replayReleased: [...replayCited] } : {}), derived, backups };

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
        const nowHeld = batch.flatMap((w) => { const why = material.why(w.kind, w.id)?.filter((r) => command.releaseReplay !== true || !material.complete || !isReplayReason(r)); return why === undefined || why.length === 0 ? [] : [{ kind: w.kind, id: w.id, reasons: why }]; });
        if (nowHeld.length > 0) return retain(nowHeld);
      }
      for (const w of batch) await step(w.name, w.kind, w.id, w.build);
    }
    if (todo > handled) return { status: "partial", recordId: command.recordId, derived, backups, deletionId, remaining: todo - handled };
    await this.#upsertDeletion(owner.id, `${base}.done.${attempt}`, deletionId, recordBody("deleted", { attempt, plan: null as unknown as JsonObject }));
    return { status: "deleted", recordId: command.recordId, derived, backups, deletionId, ...(replayCited.length > 0 ? { replayReleased: [...replayCited] } : {}) };
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
    return this.#archive(owner, command);
  }

  /** The archive of a task's records, for the owner's command and for the scratch tier of the runner (`only` names the records that tier chose; the rest of the task is left as it is). */
  async #archive(owner: Principal, command: { commandId: string; taskId: string; reason?: string }, only?: ReadonlySet<string>): Promise<{ taskId: string; archived: string[]; retained: { kind: string; id: string; reasons: string[] }[]; skipped: string[] }> {
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
    if (only !== undefined) records.splice(0, records.length, ...records.filter((r) => only.has(r.id)));
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
      const outside = why?.filter((w) => !w.includes(`written for task ${command.taskId}`) && !isReplayReason(w));
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
      const why = material.why("summary-record", sum.id)?.filter((w) => !isReplayReason(w));
      if (!material.complete || (why !== undefined && why.length > 0)) { retained.push({ kind: "summary-record", id: sum.id, reasons: why ?? [] }); continue; }
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
export const EXPORT_KINDS = ["project", "task", "desk-record", "summary-record", "artifact", "retention-archive", "responsibility-check", "stall-concern", "responsibility-incident"] as const;
const archiveIdOf = (recordId: string): string => `arc-${recordId}`;
