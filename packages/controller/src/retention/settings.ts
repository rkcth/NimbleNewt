import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";

const REF = { kind: "retention-settings", id: "main" } as const;

/**
 * The retention policy (card K06). Everything that deletes anything is OFF until the owner sets it (owner decision: keep everything by default; deletion is always an owner action and is itself recorded),
 * and every limit is optional. The values below are the installation defaults; a stored value overrides them, and the owner changes any of them by chatting (`retention.settings.set`).
 */
export interface RetentionValues {
  /** Derived summaries (summary records, meeting summaries, stand-up briefs) older than this many days are removed by the runner. `null`: never. */
  readonly derivedDays: number | null;
  /** Recorded model replies (generation runs: their text and tool arguments may hold personal or confidential data) that ended, failed or were interrupted are removed this many days after their last change. `null`: keep them (default). A run still streaming, or holding a call that could still be admitted, is never removed. */
  readonly generationRunDays: number | null;
  /** Route-change records (the text cut from a task's startup context when it moved to a smaller route, and the decisions) are removed this many days after their last change (card C07f). `null`: kept (the default). */
  readonly contextRouteDays: number | null;
  /** Responsibility checks that came due (card P04) and were finished (a check was recorded on the responsibility after their slot, or the responsibility is retired or gone) are removed this many days after their slot. A check still owed is never removed. `null`: kept (default). Card K06d. */
  readonly checkRecordDays: number | null;
  /** Stall concerns (card H11) that are over are removed this many days after their last change: cleared, confirmed, or dismissed with the dismissal run out, and only once they can never be written again (their task is done, cancelled or gone, or was assigned again since: the stall scan names a concern by task, generation and kind). A suspected concern, a dismissal still in force (one with no end is in force for good) and a concern with a recovery step half made are never removed. `null`: kept (default). Card K06d. */
  readonly concernDays: number | null;
  /** Progress evidence (`stall-evidence`, card H) of a task that is done, cancelled or gone is removed this many days after the later of its last report and the task's last change. Evidence of a task that can still run is never removed, nor is that of a task with a suspected concern or a recovery step half made. `null`: kept (default). Card K06e. */
  readonly stallEvidenceDays: number | null;
  /** Measured model speeds per route and host (`stall-speed`, card V01b) not updated for this many days are removed; no task or concern refers to them (the stall scan falls back to the declared or default speed and measures again). One a request in flight still names is kept. `null`: kept (default). Card K06e. */
  readonly stallSpeedDays: number | null;
  /** The operational history (`responsibility-event` entries) and the incident slot (`responsibility-incident-slot`) of a retired responsibility are removed this many days after it was retired (a retired responsibility is final: nothing can be recorded or reported on it again). The responsibility, its log (count and last check), its incidents and the check records stay; a slot whose incident is still open stays. `null`: kept (default). Card K06e. */
  readonly responsibilityHistoryDays: number | null;
  /** The whole text of a note that was cut to fit (`ctx-note-archive`, card C07p) of a task that is done, cancelled or gone is removed this many days after it was written. A task that can still run keeps its archives (its notes name them), and the note's own marker stays: after the removal it reads as an archive that is no longer kept. `null`: kept (default). Card K06c (context archives). */
  readonly noteArchiveDays: number | null;
  /** The dispatcher runs the retention runner by itself each tick. Off: it runs only when the owner asks. */
  readonly autoRun: boolean;
  /** Stored model thinking is deleted this many days after the task is done (owner decision 2026-10-22: 14). The controller removes what it kept of the thinking the workers reported (card U09b, retention rule thinking-days); removing the conversation store's own copy needs adapter support (card K06c). */
  readonly thinkingDays: number;
  /** Backup counts the nightly run keeps (the K01 rule: 7 daily, 4 weekly). The newest backup and every pre-upgrade snapshot are always kept. */
  readonly backupDaily: number;
  readonly backupWeekly: number;
  /** How many of the snapshots taken before a restore (kind pre-restore) are kept, newest first. `null`: keep them all (the default). */
  readonly preRestoreKept: number | null;
  /** Snapshots taken before a restore older than this many days are removed by the nightly run (the newest backup is always kept). `null`: no age limit (the default). They never take the place of a scheduled daily or weekly backup. */
  readonly preRestoreMaxAgeDays: number | null;
  /** How many minutes another start waits for the data directory lock's refresh before calling it stale when it cannot look for the holder's process (another host name, e.g. a container). `null`: never by age. Takes effect on the holder's next refresh. */
  readonly dataLockStaleMinutes: number | null;
  /** A restore is refused (ask for a new preview) when more than this many recorded changes were made between the preview and the apply. `null`: not checked. 0: any growth refuses. Counted in audit rows, not operations. Provisional default 200. */
  readonly restoreChangeMargin: number | null;
  /** How many minutes the owner's approval of a restore (the token of its preview) stays good. `null`: it does not expire. */
  readonly restoreConfirmMinutes: number | null;
  /** Resolved incidents are soft-archived after this many days, and removed this many days after being archived. `null`: never. */
  readonly incidentArchiveDays: number | null;
  readonly incidentPurgeDays: number | null;
  /** Catalogue tool versions: keep only the newest this many published versions of each tool (always kept: the versions `protectedVersions` keeps, that is the latest, the highest live and the newest unrevoked; revoked versions; and any a resumable task ran, has a call pinned to or lists as a dependency, or that is in an active or pinned environment's skill library); older ones are dropped by the runner (by hand always; by the automatic pass only when `catalogAutoDrop` is on). `null`: keep every version (card T02c). */
  readonly catalogVersionsKept: number | null;
  /** Whether the automatic pass (`autoRun`) may also drop catalogue versions under `catalogVersionsKept` (default off: dropping a version is a larger act than expiring a summary, so while this is off only a run by hand drops them). */
  readonly catalogAutoDrop: boolean;
  /** A revoked version keeps its record (name, version, digest, manifest, why and when it was revoked) for good; its executable text is blanked this many days after the revocation, unless a version that is not revoked also uses the same text (as executable or instructions), or a resumable task, checkpoint or dependency record cites it. `null`: keep it. */
  readonly revokedBytesDays: number | null;
  /** The switch for that blanking (default off): `revokedBytesDays` applies only when this is true. Blanking edits a desk record, so it is something the owner turns on. */
  readonly revokedBytesBlank: boolean;
  /** Optional storage quotas in bytes of records written (desk records, notes, summaries, artifacts): per project and per agent. `null`: no quota. */
  readonly quotaProjectBytes: number | null;
  readonly quotaAgentBytes: number | null;
  /** Visible warning at this percent of a quota. */
  readonly quotaWarnPercent: number;
  /** Disk kept back for shutdown, checkpoint and recovery records, in bytes (a file in the data directory that a critical write may take when the disk is full). 0: none. */
  readonly reserveBytes: number;
}

export const RETENTION_DEFAULTS: RetentionValues = {
  derivedDays: null, generationRunDays: null, contextRouteDays: null, checkRecordDays: null, concernDays: null, stallEvidenceDays: null, stallSpeedDays: null, responsibilityHistoryDays: null, noteArchiveDays: null, autoRun: false, thinkingDays: 14, backupDaily: 7, backupWeekly: 4, preRestoreKept: null, preRestoreMaxAgeDays: null, dataLockStaleMinutes: 10, restoreChangeMargin: 200, restoreConfirmMinutes: 30, incidentArchiveDays: null, incidentPurgeDays: null, catalogVersionsKept: null, catalogAutoDrop: false, revokedBytesDays: 90, revokedBytesBlank: false,
  quotaProjectBytes: null, quotaAgentBytes: null, quotaWarnPercent: 80, reserveBytes: 16 * 1024 * 1024,
};

type Kind = "days" | "flag" | "bytes" | "percent" | "count";
interface Spec { readonly kind: Kind; readonly min: number; readonly max: number; readonly nullable: boolean }
export const RETENTION_FIELDS: Readonly<Record<keyof RetentionValues, Spec>> = {
  derivedDays: { kind: "days", min: 7, max: 3650, nullable: true },
  generationRunDays: { kind: "days", min: 1, max: 3650, nullable: true },
  contextRouteDays: { kind: "days", min: 1, max: 3650, nullable: true },
  checkRecordDays: { kind: "days", min: 7, max: 3650, nullable: true },
  concernDays: { kind: "days", min: 7, max: 3650, nullable: true },
  stallEvidenceDays: { kind: "days", min: 7, max: 3650, nullable: true },
  stallSpeedDays: { kind: "days", min: 7, max: 3650, nullable: true },
  responsibilityHistoryDays: { kind: "days", min: 7, max: 3650, nullable: true },
  noteArchiveDays: { kind: "days", min: 7, max: 3650, nullable: true },
  autoRun: { kind: "flag", min: 0, max: 1, nullable: false },
  thinkingDays: { kind: "days", min: 1, max: 365, nullable: false },
  backupDaily: { kind: "count", min: 1, max: 365, nullable: false },
  backupWeekly: { kind: "count", min: 0, max: 520, nullable: false },
  preRestoreKept: { kind: "count", min: 1, max: 1000, nullable: true },
  preRestoreMaxAgeDays: { kind: "days", min: 1, max: 3650, nullable: true },
  dataLockStaleMinutes: { kind: "count", min: 1, max: 10080, nullable: true },
  restoreChangeMargin: { kind: "count", min: 0, max: 1_000_000, nullable: true },
  restoreConfirmMinutes: { kind: "count", min: 1, max: 10080, nullable: true },
  incidentArchiveDays: { kind: "days", min: 7, max: 3650, nullable: true },
  incidentPurgeDays: { kind: "days", min: 30, max: 3650, nullable: true },
  catalogVersionsKept: { kind: "count", min: 1, max: 500, nullable: true },
  catalogAutoDrop: { kind: "flag", min: 0, max: 1, nullable: false },
  revokedBytesDays: { kind: "days", min: 7, max: 3650, nullable: true },
  revokedBytesBlank: { kind: "flag", min: 0, max: 1, nullable: false },
  quotaProjectBytes: { kind: "bytes", min: 1024, max: 2 ** 50, nullable: true },
  quotaAgentBytes: { kind: "bytes", min: 1024, max: 2 ** 50, nullable: true },
  quotaWarnPercent: { kind: "percent", min: 50, max: 99, nullable: false },
  reserveBytes: { kind: "bytes", min: 0, max: 1024 * 1024 * 1024, nullable: false },
};
const NAMES = Object.keys(RETENTION_FIELDS) as (keyof RetentionValues)[];

function fieldOk(name: keyof RetentionValues, value: unknown): boolean {
  const spec = RETENTION_FIELDS[name];
  if (value === null) return spec.nullable;
  if (spec.kind === "flag") return typeof value === "boolean";
  return typeof value === "number" && Number.isSafeInteger(value) && value >= spec.min && value <= spec.max;
}
const describe = (name: keyof RetentionValues): string => { const s = RETENTION_FIELDS[name]; return s.kind === "flag" ? "true or false" : `a whole number from ${s.min} to ${s.max}${s.nullable ? ", or null for none" : ""}`; };

export interface RetentionChange { readonly field: keyof RetentionValues; readonly old: number | boolean | null; readonly new: number | boolean | null }

/**
 * The retention settings: owner only, race-safe (`expectedRevision`), replay-safe (command ID). An unset value falls back to the installation default (`defaults`, itself the built-in default unless the installation profile
 * gave others). A damaged stored record is an error (`unavailable`), never a silent default, so a deletion rule never changes meaning by itself. The answer to a change names each old and new value (the owner is told back).
 */
export class RetentionSettingsService {
  readonly #runner: CommandRunner;
  readonly #defaults: RetentionValues;
  readonly #onChange: ((effective: RetentionValues) => Promise<void>) | undefined;
  private constructor(runner: CommandRunner, defaults: RetentionValues, onChange: ((effective: RetentionValues) => Promise<void>) | undefined) { this.#runner = runner; this.#defaults = defaults; this.#onChange = onChange; }

  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions & { defaults?: Partial<RetentionValues>; onChange?: (effective: RetentionValues) => Promise<void> } = {}): RetentionSettingsService {
    const defaults = { ...RETENTION_DEFAULTS, ...(options.defaults ?? {}) };
    for (const n of NAMES) if (!fieldOk(n, defaults[n])) throw new RangeError(`retention default ${n}: must be ${describe(n)}`);
    return new RetentionSettingsService(new CommandRunner(storage, epoch, options), defaults, options.onChange);
  }

  get defaults(): RetentionValues { return this.#defaults; }

  async get(by: Principal): Promise<{ revision: number; settings: Partial<RetentionValues>; defaults: RetentionValues; effective: RetentionValues }> {
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not read the retention settings`);
    const found = await this.#runner.get(REF.kind, REF.id);
    const effective = await this.effective();
    return { revision: found?.revision ?? 0, settings: found === undefined ? {} : this.#parse(found.body) ?? {}, defaults: this.#defaults, effective };
  }

  /** What applies now. A damaged record throws. */
  async effective(): Promise<RetentionValues> {
    const found = await this.#runner.get(REF.kind, REF.id);
    if (found === undefined) return this.#defaults;
    const stored = this.#parse(found.body);
    if (stored === undefined) throw new DomainError("unavailable", "the stored retention setting is damaged; set it again (retention.settings.set)", { field: "settings" });
    return { ...this.#defaults, ...stored };
  }

  /** Only the fields given change; `null` on an optional field clears it, `"default"` returns it to the installation default. */
  async set(owner: Principal, command: NoActor & Partial<Record<keyof RetentionValues, unknown>> & { expectedRevision?: number }): Promise<{ revision: number; changed: RetentionChange[]; summary: string }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not change the retention settings`);
    const allowed = new Set<string>(["commandId", "expectedRevision", ...NAMES]);
    const unknown = Object.keys(command).filter((k) => !allowed.has(k));
    if (unknown.length > 0) throw new DomainError("invalid_command", `${unknown[0]}: is not a field of this command`, { field: unknown[0]! });
    const given = NAMES.filter((n) => command[n] !== undefined);
    if (given.length === 0) throw new DomainError("invalid_command", `give at least one of ${NAMES.join(", ")}`, { field: NAMES[0]! });
    for (const n of given) { const v = command[n]; if (v !== "default" && !fieldOk(n, v)) throw new DomainError("invalid_command", `${n}: must be ${describe(n)}, or "default"`, { field: n }); }
    if (command.expectedRevision !== undefined && (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0)) throw new DomainError("invalid_command", "expectedRevision: must be a whole number", { field: "expectedRevision" });
    let changed: RetentionChange[] = [];
    let applied: RetentionValues | undefined;
    const result = await this.#runner.command("retention.settings.set", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { values: Object.fromEntries(given.map((n) => [n, command[n] as never])) as JsonObject, expectedRevision: command.expectedRevision ?? null },
      build: async () => {
        const current = await this.#runner.get(REF.kind, REF.id);
        if (command.expectedRevision !== undefined && (current?.revision ?? 0) !== command.expectedRevision) throw new DomainError("stale_revision", `the retention settings are at revision ${current?.revision ?? 0}, not ${command.expectedRevision}`, { currentRevision: current?.revision ?? 0 });
        const stored = current === undefined ? {} : this.#parse(current.body) ?? {};
        const before = { ...this.#defaults, ...stored } as RetentionValues;
        const next: Record<string, number | boolean | null> = { ...stored };
        for (const n of given) { const v = command[n]; if (v === "default") delete next[n]; else next[n] = v as number | boolean | null; }
        const after = { ...this.#defaults, ...next } as RetentionValues;
        applied = after;
        changed = NAMES.filter((n) => before[n] !== after[n]).map((n) => ({ field: n, old: before[n], new: after[n] }));
        const body = { values: next, updatedBy: owner.id, updatedAt: this.#runner.now() } as unknown as JsonObject;
        const change = current === undefined ? { type: "create" as const, ref: REF, body } : { type: "update" as const, ref: REF, expectedRevision: current.revision, body };
        return { ref: REF, creates: current === undefined, changes: [change], detail: { changed: changed as unknown as JsonObject[] } };
      },
    }));
    if (result.replayed) {
      // A replay reports the change it recorded, from the audit entry of its own record.
      const seq = (await this.#runner.storage.getOperation(`cmd:${scopedCommandId(owner.id, command.commandId)}`))?.result.auditSeqs[0];
      const audit = seq === undefined ? undefined : (await this.#runner.storage.listAudit({ afterSeq: seq - 1, limit: 1 }))[0];
      changed = (audit?.detail["changed"] as unknown as RetentionChange[] | undefined) ?? [];
    }
    if (this.#onChange !== undefined) { const now = applied ?? await this.effective().catch(() => undefined); if (now !== undefined) await this.#onChange(now); }
    const fmt = (v: unknown): string => (v === null ? "none" : String(v));
    const summary = changed.length === 0 ? "No retention value changed." : `Retention changed: ${changed.map((c) => `${c.field} ${fmt(c.old)} -> ${fmt(c.new)}`).join("; ")}.`;
    return { revision: result.revision, changed, summary };
  }

  #parse(body: unknown): Partial<RetentionValues> | undefined {
    if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
    const values = (body as Record<string, unknown>)["values"];
    if (values === null || typeof values !== "object" || Array.isArray(values)) return undefined;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values as Record<string, unknown>)) {
      if (!(NAMES as string[]).includes(k) || !fieldOk(k as keyof RetentionValues, v)) return undefined;
      out[k] = v;
    }
    return out as Partial<RetentionValues>;
  }
}
