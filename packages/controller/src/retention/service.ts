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
import { RetainedMaterial } from "./references.js";
import type { RetentionSettingsService, RetentionValues } from "./settings.js";

const DAY = 86_400_000;
const RUN_LIMIT = { default: 200, max: 1000 } as const;
const SCAN_LIMIT = 50_000;
const DELETE_MEMBERS = 400;
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
  preview(retention: { daily: number; weekly: number }): Promise<string[]>;
  prune(retention: { daily: number; weekly: number }): Promise<string[]>;
}
export interface IncidentPort {
  archive(by: Principal, options: { olderThanDays?: number; limit?: number; projectId?: string }): Promise<number>;
  purge(by: Principal, options: { olderThanDays: number; limit?: number; projectId?: string }): Promise<number>;
}
export interface RetentionDeps {
  readonly settings: Pick<RetentionSettingsService, "effective">;
  readonly backups?: BackupPort;
  readonly incidents?: IncidentPort;
  readonly projects?: () => Promise<readonly string[]>;
  /** Tells the owner (a controller-set notice). The command ID makes it once per period. */
  readonly notify?: (notice: { commandId: string; text: string; ref: { kind: string; id: string } }) => Promise<void>;
  readonly reserve?: ReserveFile;
  readonly meter?: QuotaMeter;
  readonly dataDirectory?: string;
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
  readonly backups?: { kept: number; wouldDelete?: string[]; deleted?: string[]; counts: { daily: number; weekly: number } };
  readonly incidents?: { archiveDays: number | null; purgeDays: number | null; archived?: number; purged?: number };
  readonly runId?: string;
}

export interface DeletionReport {
  readonly status: "deleted" | "retained" | "preview" | "partial";
  readonly recordId: string;
  readonly retained?: { kind: string; id: string; reasons: string[] }[];
  readonly derived: { copies: string[]; summaries: string[]; compactions: string[]; archives: string[]; indexes: string; cachedReplies: string };
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
    const quotas: { scope: string; id: string; used: number; quota: number; percent: number; level: "ok" | "warn" | "full" }[] = [];
    let partial = false;
    if (this.#deps.meter !== undefined && (values.quotaProjectBytes !== null || values.quotaAgentBytes !== null)) {
      const usage = await this.#deps.meter.usage();
      partial = usage.partial;
      const add = (scope: string, map: ReadonlyMap<string, number>, quota: number | null): void => {
        if (quota === null) return;
        for (const [id, used] of map) {
          const percent = Math.floor((used * 100) / quota);
          const level = percent >= 100 ? "full" : percent >= values.quotaWarnPercent ? "warn" : "ok";
          if (level !== "ok") { quotas.push({ scope, id, used, quota, percent, level }); warnings.push(`${scope} ${id} is at ${percent}% of its storage quota`); }
        }
      };
      add("project", usage.byProject, values.quotaProjectBytes); add("agent", usage.byAgent, values.quotaAgentBytes);
    }
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

  async #recent(kind: string, n: number): Promise<Aggregate[]> {
    const all: Aggregate[] = [];
    await scan(this.#runner, kind, (a) => all.push(a), 5_000);
    return all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, n);
  }

  /** Whether the record is held by a resumable task or a replay, and why. */
  async check(by: Principal, ref: { kind: string; id: string }): Promise<{ kind: string; id: string; retained: boolean; reasons: string[] }> {
    if (!isOwner(by)) throw new DomainError("forbidden", `${by.id} may not ask what is retained`);
    if (typeof ref.kind !== "string" || typeof ref.id !== "string") invalid("ref", "needs a kind and an id");
    const material = await RetainedMaterial.build(this.#runner.storage);
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
    const counts = { daily: values.backupDaily, weekly: values.backupWeekly };
    const backupsPort = this.#deps.backups;
    const wouldDelete = backupsPort === undefined ? undefined : await backupsPort.preview(counts);
    const digest = digestOf({ c: candidates.map((c) => `${c.kind}/${c.id}@${c.revision}`), b: wouldDelete ?? [], i: [values.incidentArchiveDays, values.incidentPurgeDays] });
    const base: RunReport = {
      dryRun, enabled: values.derivedDays !== null, derivedDays: values.derivedDays, candidates, removed: 0, retained, partial,
      ...(backupsPort === undefined ? {} : { backups: { kept: (await backupsPort.list()).length - (wouldDelete?.length ?? 0), ...(dryRun ? { wouldDelete: wouldDelete ?? [] } : {}), counts } }),
      ...(this.#deps.incidents === undefined ? {} : { incidents: { archiveDays: values.incidentArchiveDays, purgeDays: values.incidentPurgeDays } }),
    };
    if (dryRun) return { ...base, digest };
    if (!auto && options.confirm !== digest) throw new DomainError("invalid_command", "confirm: what retention would remove has changed since the preview (or confirm was not given); preview again and pass its digest", { field: "confirm" });

    const removedIds: string[] = [];
    for (const c of candidates) {
      const done = await this.#removeOne(by, c, values.derivedDays!);
      if (done) removedIds.push(`${c.kind}/${c.id}`);
    }
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
      ...(backupsPort === undefined ? {} : { backups: { kept: (await backupsPort.list()).length, deleted: deleted ?? [], counts } }),
      ...(this.#deps.incidents === undefined ? {} : { incidents: { archiveDays: values.incidentArchiveDays, purgeDays: values.incidentPurgeDays, ...(archived === undefined ? {} : { archived }), ...(purged === undefined ? {} : { purged }) } }),
    };
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
          return { ref, creates: false, changes: [{ type: "delete", ref, expectedRevision: fresh.revision }], detail: { rule: "derived-days", days, ageDays: c.ageDays, ...(c.projectId === undefined ? {} : { projectId: c.projectId }) } };
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
    const status = await this.#status().catch(() => undefined);
    if (status === undefined) return;
    for (const q of (status["quotas"] as unknown as { scope: string; id: string; percent: number; level: string; used: number; quota: number }[])) {
      await notify({ commandId: cmdId("rtw", "quota", q.scope, q.id, q.level, week), text: `Storage quota: ${q.scope} ${q.id} is at ${q.percent}% (${q.used} of ${q.quota} bytes)${q.level === "full" ? "; new records from it are refused until you raise the quota or delete something" : ""}.`, ref: { kind: q.scope === "project" ? "project" : "agent", id: q.id } });
    }
    const disk = status["disk"] as { reserve: { inUse: boolean } };
    if (disk.reserve.inUse) await notify({ commandId: cmdId("rtw", "reserve", week), text: "The data disk is nearly full and the reserve for shutdown and recovery records is in use. Only those records are written until room is made.", ref: { kind: "installation", id: "main" } });
  }

  // ---- user-requested deletion ----------------------------------------------------------------------------------------------

  /**
   * The owner deletes a desk record and what was made from it: the copies other agents made of it, the summaries that cite it (removed), the compactions that cite it (their summary text blanked and marked), and any archive of it. The text goes;
   * a digest, who, why and when stay. A record a resumable task or a replay needs is NOT deleted: the request is recorded as retained, with the reasons, and nothing changes. The record says how backups are handled: existing backups
   * are not altered; they hold the text until they expire under the backup rule, and the answer says for how long. Indexes and cached replies: none exist (said in the record).
   */
  async delete(owner: Principal, command: { commandId: string; recordId: string; reason: string; dryRun?: boolean }): Promise<DeletionReport> {
    if (!isOwner(owner)) throw new DomainError("forbidden", `${owner.id} may not delete records`);
    if (typeof command.recordId !== "string" || !RECORD_ID.test(command.recordId)) invalid("recordId", "is not a desk record ID (only desk records can be deleted; history and decisions are append-only and are kept)");
    if (typeof command.reason !== "string" || command.reason.trim() === "" || command.reason.length > 300) invalid("reason", "must be 1 to 300 characters");
    if (redactText(command.reason) !== command.reason) invalid("reason", "looks like a credential or key");
    const base = scopedCommandId(owner.id, command.commandId);
    const root = await this.#runner.get("desk-record", command.recordId);
    if (root === undefined) throw new DomainError("not_found", "no such desk record");
    const values = await this.#deps.settings.effective();

    // Everything that stands on the record.
    const members = new Map<string, Aggregate>();
    const summaries: Aggregate[] = []; const compactions: Aggregate[] = []; const archives: Aggregate[] = [];
    const copyOf = new Set<string>([command.recordId]);
    let complete = true;
    const copies: Aggregate[] = [];
    // Copies of copies share the same root: gather until no new one appears (bounded by the scan).
    for (let round = 0; round < 4; round++) {
      let added = false;
      complete = (await scan(this.#runner, "desk-record", (a) => {
        if (copyOf.has(a.id)) return;
        const b = a.body as { copiedFrom?: string; origin?: { recordId?: string } };
        if ((b.copiedFrom !== undefined && copyOf.has(b.copiedFrom)) || b.origin?.recordId === command.recordId) { copyOf.add(a.id); copies.push(a); added = true; }
      })) && complete;
      if (!added) break;
    }
    complete = (await scan(this.#runner, "summary-record", (a) => { const b = a.body as { sources?: { source?: { kind?: string; id?: string } }[] }; if ((b.sources ?? []).some((s) => s.source?.kind === "desk-record" && s.source.id !== undefined && copyOf.has(s.source.id))) summaries.push(a); })) && complete;
    complete = (await scan(this.#runner, "ctx-compaction", (a) => { const b = a.body as { sources?: { kind?: string; id?: string }[]; pinned?: { kind?: string; id?: string }[] }; if ([...(b.sources ?? []), ...(b.pinned ?? [])].some((s) => s.kind === "desk-record" && s.id !== undefined && copyOf.has(s.id))) compactions.push(a); })) && complete;
    for (const id of copyOf) { const arc = await this.#runner.get("retention-archive", archiveIdOf(id)); if (arc !== undefined) archives.push(arc); }
    members.set(command.recordId, root);
    for (const c of copies) members.set(c.id, c);

    const material = await RetainedMaterial.build(this.#runner.storage);
    const held: { kind: string; id: string; reasons: string[] }[] = [];
    for (const [id] of members) { const why = material.why("desk-record", id); if (why !== undefined) held.push({ kind: "desk-record", id, reasons: why }); }
    for (const s of summaries) { const why = material.why("summary-record", s.id); if (why !== undefined) held.push({ kind: "summary-record", id: s.id, reasons: why }); }
    for (const c of compactions) { const why = material.why("ctx-compaction", c.id); if (why !== undefined) held.push({ kind: "ctx-compaction", id: c.id, reasons: why }); }
    if (!complete) held.push({ kind: "desk-record", id: command.recordId, reasons: ["too many records to find everything made from it safely; nothing was deleted"] });

    const backups = await this.#backupHandling(root.createdAt, values);
    const derived = { copies: copies.map((c) => c.id), summaries: summaries.map((s) => s.id), compactions: compactions.map((c) => c.id), archives: archives.map((a) => a.id), ...NOT_STORED };
    const deletionId = derivedId("rtd", base);
    const recordBody = (status: string, extra: JsonObject = {}): JsonObject => ({ recordId: command.recordId, projectId: (root.body as { projectId?: string }).projectId ?? "", requestedBy: owner.id, reason: command.reason, at: this.#runner.now(), status, derived: derived as unknown as JsonObject, backups: backups as unknown as JsonObject, ...extra });

    if (command.dryRun === true) return { status: held.length > 0 ? "retained" : "preview", recordId: command.recordId, ...(held.length > 0 ? { retained: held } : {}), derived, backups };

    if (held.length > 0) {
      await this.#runner.command("retention.delete", { commandId: base, actor: owner.id }, async () => ({
        payload: { recordId: command.recordId, reason: command.reason, outcome: "retained" },
        build: async (): Promise<Built> => { const ref = { kind: "retention-deletion", id: deletionId }; return { ref, creates: true, changes: [{ type: "create", ref, body: recordBody("retained", { retained: held as unknown as JsonObject[] }) }], detail: { recordId: command.recordId, retained: held.length } }; },
      }));
      return { status: "retained", recordId: command.recordId, retained: held, derived, backups, deletionId };
    }

    // The work, one operation per record, each safe to repeat. The deletion record comes last, so its existence means everything before it was done.
    const total = members.size + summaries.length + compactions.length + archives.length;
    if (total > DELETE_MEMBERS) throw new DomainError("invalid_command", `recordId: ${total} records stand on that record, more than one request handles (${DELETE_MEMBERS})`, { field: "recordId" });
    const at = this.#runner.now();
    const stub = (a: Aggregate): JsonObject => {
      const b = a.body as Record<string, unknown>;
      const original = archives.find((x) => x.id === archiveIdOf(a.id))?.body as { original?: { title?: unknown; body?: unknown } } | undefined;
      const text = original?.original ?? b;
      const rest = Object.fromEntries(Object.entries(b).filter(([k]) => k !== "archived"));
      return { ...rest, title: "", body: "", visibility: "private", deleted: { at, by: owner.id, reason: command.reason, contentDigest: digestOf({ title: text["title"] ?? "", body: text["body"] ?? "" }) } } as JsonObject;
    };
    const step = async (name: string, kind: string, id: string, build: (fresh: Aggregate) => Change[]): Promise<void> => {
      await this.#runner.command(`retention.delete.${name}`, { commandId: cmdId("rtd", base, kind, id), actor: owner.id }, async () => ({
        payload: { kind, id, deletion: deletionId },
        build: async (): Promise<Built> => {
          const fresh = await this.#runner.get(kind, id);
          // Already handled by an earlier try of this command: nothing more to do; the record of the step is what the first try left.
          if (fresh === undefined) throw new DomainError("not_found", "already removed");
          return { ref: { kind, id }, creates: false, changes: build(fresh), detail: { deletion: deletionId, recordId: command.recordId } };
        },
      })).catch((error: unknown) => { if (error instanceof DomainError && error.code === "not_found") return; throw error; });
    };
    for (const [id, a] of members) {
      if ((a.body as { deleted?: unknown }).deleted !== undefined) continue;
      await step("record", "desk-record", id, (f) => [{ type: "update", ref: { kind: "desk-record", id }, expectedRevision: f.revision, body: stub(f) }]);
    }
    for (const arc of archives) await step("archive", "retention-archive", arc.id, (f) => [{ type: "delete", ref: { kind: "retention-archive", id: arc.id }, expectedRevision: f.revision }]);
    for (const s of summaries) await step("summary", "summary-record", s.id, (f) => [{ type: "delete", ref: { kind: "summary-record", id: s.id }, expectedRevision: f.revision }]);
    for (const c of compactions) await step("compaction", "ctx-compaction", c.id, (f) => [{ type: "update", ref: { kind: "ctx-compaction", id: c.id }, expectedRevision: f.revision, body: { ...(f.body as Record<string, unknown>), summary: "", digest: "", sourceDeleted: true } as JsonObject }]);
    await this.#runner.command("retention.delete", { commandId: base, actor: owner.id }, async () => ({
      payload: { recordId: command.recordId, reason: command.reason, outcome: "deleted" },
      build: async (): Promise<Built> => { const ref = { kind: "retention-deletion", id: deletionId }; return { ref, creates: true, changes: [{ type: "create", ref, body: recordBody("deleted") }], detail: { recordId: command.recordId, copies: copies.length, summaries: summaries.length, compactions: compactions.length } }; },
    }));
    return { status: "deleted", recordId: command.recordId, derived, backups, deletionId };
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
    for (const rec of records.sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const b = rec.body as { deleted?: unknown; archived?: unknown };
      if (b.deleted !== undefined || b.archived !== undefined) { skipped.push(rec.id); continue; }
      const why = material.why("desk-record", rec.id);
      // The task's own records count as held only because the task can resume; a finished task's are free, unless another resumable task cites them.
      const outside = why?.filter((w) => !w.includes(`written for task ${command.taskId}`));
      if (!material.complete || (outside !== undefined && outside.length > 0)) { retained.push({ kind: "desk-record", id: rec.id, reasons: outside ?? why ?? [] }); continue; }
      const archiveId = archiveIdOf(rec.id);
      const result = await this.#runner.command("retention.archive", { commandId: cmdId("rta", base, rec.id), actor: owner.id }, async () => ({
        payload: { recordId: rec.id, taskId: command.taskId },
        build: async (): Promise<Built> => {
          const fresh = await this.#runner.get("desk-record", rec.id);
          if (fresh === undefined) throw new DomainError("not_found", "no such record");
          const fb = fresh.body as Record<string, unknown>;
          if (fb["archived"] !== undefined || fb["deleted"] !== undefined) throw new DomainError("stale_revision", "already archived or deleted");
          const stubBody = { ...fb, title: "(archived)", body: "", archived: { at, by: owner.id, archiveId } } as JsonObject;
          const ref = { kind: "retention-archive", id: archiveId };
          const arch = { recordId: rec.id, taskId: command.taskId, projectId: String(fb["projectId"] ?? ""), original: fresh.body, originalRevision: fresh.revision, stubRevision: fresh.revision + 1, at, by: owner.id, ...(command.reason === undefined ? {} : { reason: command.reason }) } as unknown as JsonObject;
          return { ref, creates: true, changes: [{ type: "create", ref, body: arch }, { type: "update", ref: { kind: "desk-record", id: rec.id }, expectedRevision: fresh.revision, body: stubBody }], detail: { recordId: rec.id, taskId: command.taskId } };
        },
      })).catch((error: unknown) => { if (error instanceof DomainError && (error.code === "stale_revision" || error.code === "not_found" || error.code === "command_conflict")) return undefined; throw error; });
      if (result !== undefined) archived.push(rec.id); else skipped.push(rec.id);
    }
    return { taskId: command.taskId, archived, retained, skipped };
  }

  /** Puts a task's archived records back exactly as they were. A record changed since it was archived (or deleted at the owner's request) is left alone and listed. */
  async restore(owner: Principal, command: { commandId: string; taskId: string }): Promise<{ taskId: string; restored: string[]; conflicts: string[] }> {
    if (!isOwner(owner)) throw new DomainError("forbidden", `${owner.id} may not restore archived work`);
    if (typeof command.taskId !== "string" || !TASK_ID.test(command.taskId)) invalid("taskId", "is not a task ID");
    const base = scopedCommandId(owner.id, command.commandId);
    const found: Aggregate[] = [];
    if (!(await scan(this.#runner, "retention-archive", (a) => { if ((a.body as { taskId?: string }).taskId === command.taskId) found.push(a); }))) throw new DomainError("unavailable", "too many archives to restore a task safely");
    const restored: string[] = []; const conflicts: string[] = [];
    for (const arc of found.sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const body = arc.body as unknown as { recordId: string; original: JsonObject; stubRevision: number };
      const cur = await this.#runner.get("desk-record", body.recordId);
      const marker = (cur?.body as { archived?: { archiveId?: string } } | undefined)?.archived;
      if (cur === undefined || cur.revision !== body.stubRevision || marker?.archiveId !== arc.id) { conflicts.push(body.recordId); continue; }
      const r = await this.#runner.command("retention.restore", { commandId: cmdId("rta", "restore", base, arc.id), actor: owner.id }, async () => ({
        payload: { archiveId: arc.id, taskId: command.taskId },
        build: async (): Promise<Built> => {
          const fresh = await this.#runner.get("desk-record", body.recordId);
          const freshArc = await this.#runner.get("retention-archive", arc.id);
          if (fresh === undefined || freshArc === undefined || fresh.revision !== body.stubRevision) throw new DomainError("stale_revision", "changed since it was archived");
          const ref = { kind: "desk-record", id: body.recordId };
          return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: fresh.revision, body: body.original }, { type: "delete", ref: { kind: "retention-archive", id: arc.id }, expectedRevision: freshArc.revision }], detail: { recordId: body.recordId, taskId: command.taskId }, audit: [{ type: "retention.restore.archive", subject: { kind: "retention-archive", id: arc.id }, detail: { recordId: body.recordId, taskId: command.taskId } }] };
        },
      })).catch((error: unknown) => { if (error instanceof DomainError && (error.code === "stale_revision" || error.code === "not_found")) return undefined; throw error; });
      if (r !== undefined) restored.push(body.recordId); else conflicts.push(body.recordId);
    }
    return { taskId: command.taskId, restored, conflicts };
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
          const mine = kind === "project" ? a.id === options.projectId : b["projectId"] === options.projectId;
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
