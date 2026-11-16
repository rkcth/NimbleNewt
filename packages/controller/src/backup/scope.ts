import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { RetainedMaterial, REFERENCE_SCAN_LIMIT, planSubjectIds } from "../retention/references.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { canonicalJson, type ControllerStorage, type SnapshotRow, type StorageSnapshot } from "../storage/index.js";
import type { Aggregate, JsonObject } from "../storage/types.js";
import type { BackupScopeLine, BackupScopeRecord } from "./format.js";

/**
 * Backup scope tiers (card K01d). An OPTIONAL, owner-set way to leave bulk records out of the backups the controller makes (a manual or scheduled one; the safety copies before an upgrade or a restore are always whole),
 * by kind and age: private scratch of tasks that are done or cancelled, the owner's words in old chat turns, and the record of delivered messages to the owner. Everything is OFF until the owner sets a number of days.
 * This is separate from the live system's retention (K06): nothing is deleted from the running store, only left out of the copy.
 *
 * What is never left out, whatever the setting: the audit log, the owner's decisions, every table other than `aggregates` (operations, deliveries, effects, timers, state), and every record that a task that can still
 * resume, or the replay of any task, refers to (the same check the live retention rules use: `RetainedMaterial`). Private records that a catalogued tool or skill reads its text from are kept too. The one kind of record that is left as an empty shell and not removed is a chat turn, because a message
 * sent again after a restore must still be answered as the turn it was.
 */
export interface BackupScopeValues {
  /** Private scratch (desk records only their agent reads) of a task that is done or cancelled, last changed more than this many days ago. `null`: kept. */
  readonly scratchDays: number | null;
  /** Chat turns completed more than this many days ago: their words, plan and answers are left out (the turn stays as a shell). `null`: kept. */
  readonly transcriptDays: number | null;
  /** Records of messages to the owner that were delivered more than this many days ago. `null`: kept. */
  readonly logDays: number | null;
}

export const BACKUP_SCOPE_OFF: BackupScopeValues = { scratchDays: null, transcriptDays: null, logDays: null };
export const SCOPE_MIN_DAYS = 7;
export const SCOPE_MAX_DAYS = 3650;
export const SCOPE_FIELDS = ["scratchDays", "transcriptDays", "logDays"] as const;
export const scopeIsOn = (v: BackupScopeValues): boolean => v.scratchDays !== null || v.transcriptDays !== null || v.logDays !== null;

/** Kinds this feature may ever touch. Anything else (the audit, decisions, every other record) is outside it by construction; this list is also what a test pins. */
export const LEAVE_OUT_KINDS = ["desk-record", "chat-turn", "notification-delivery"] as const;

const DAY = 86_400_000;
const key = (kind: string, id: string): string => `${kind}\u0000${id}`;

/** What the writer does with one row of the `aggregates` table. */
export interface LeaveOutPlan {
  /** `keep`: written as it is. `omit`: not written. `stub`: written with the words gone. */
  decide(row: SnapshotRow): "keep" | "omit" | "stub";
  /** The shell of a chat turn whose words are left out. */
  stubText(row: SnapshotRow): string;
  /** What was left out, worked out from the plan (the writer goes over the same snapshot, so the counts are the ones it writes). */
  record(): BackupScopeRecord;
}

/** Reads the rows of one kind of the snapshot's `aggregates` table in key order (kinds and IDs compare in binary order on every backend, so a kind is one run of rows). */
function snapshotLister(snapshot: StorageSnapshot): Pick<ControllerStorage, "listAggregates"> {
  return {
    async listAggregates(kind: string, page: { afterId?: string; limit: number }): Promise<Aggregate[]> {
      const rows = await snapshot.read("aggregates", { after: { kind, id: page.afterId ?? "" }, limit: page.limit });
      const out: Aggregate[] = [];
      for (const r of rows) {
        if (r["kind"] !== kind) break;
        let body: unknown;
        try { body = JSON.parse(String(r["body"])); } catch { body = {}; }
        out.push({ kind, id: String(r["id"]), revision: Number(r["revision"]), body: (body !== null && typeof body === "object" ? body : {}) as JsonObject, createdAt: String(r["created_at"]), updatedAt: String(r["updated_at"]) });
      }
      return out;
    },
  } as Pick<ControllerStorage, "listAggregates">;
}

/** Reads every record of one kind, a page at a time. Returns false when the bound was reached (what was not read must not be assumed to be anything). */
async function eachOf(lister: Pick<ControllerStorage, "listAggregates">, kind: string, each: (a: Aggregate) => void, limit = REFERENCE_SCAN_LIMIT): Promise<boolean> {
  let after: string | undefined; let seen = 0;
  for (;;) {
    const page = await lister.listAggregates(kind, { ...(after === undefined ? {} : { afterId: after }), limit: 500 });
    for (const a of page) each(a);
    seen += page.length;
    if (page.length < 500) return true;
    if (seen >= limit) return false;
    after = page[page.length - 1]!.id;
  }
}

/** A chat turn with the owner's words gone: the same shell the live transcript rule leaves (the ID, the message it answered, its state and times), marked as left out of this backup. */
function turnShell(body: Record<string, unknown>, at: string, days: number): JsonObject {
  const keep: Record<string, unknown> = {};
  for (const k of ["ownerId", "messageId", "quotedCount", "projectId", "status", "resumes", "resumedBy", "createdAt", "completedAt"]) if (body[k] !== undefined) keep[k] = body[k];
  return { ...keep, text: "", plan: [], outcomes: [], retention: { removedAt: at, rule: "backup-scope", days } } as unknown as JsonObject;
}

const sentence = (v: BackupScopeValues): string => {
  const parts: string[] = [];
  if (v.scratchDays !== null) parts.push(`private scratch of finished tasks not changed for ${v.scratchDays} days`);
  if (v.transcriptDays !== null) parts.push(`the words of chat turns completed more than ${v.transcriptDays} days ago`);
  if (v.logDays !== null) parts.push(`records of messages to you delivered more than ${v.logDays} days ago`);
  return parts.join("; ");
};

/**
 * Works out, over one snapshot, which records the backup leaves out (card K01d). The owner's rules decide candidates; a record that a resumable task or a replay refers to is kept anyway, and when that check cannot be
 * finished (more records than the bound) nothing is left out. `now` is the time of the backup.
 */
export async function planLeaveOut(snapshot: StorageSnapshot, values: BackupScopeValues, now: Date): Promise<LeaveOutPlan> {
  const lister = snapshotLister(snapshot);
  const at = now.toISOString();
  const omit = new Set<string>();
  const stub = new Map<string, number>();
  const lines = new Map<string, { tier: BackupScopeLine["tier"]; kind: string; days: number; left: number; stubbed: number; heldBack: number }>();
  const line = (tier: BackupScopeLine["tier"], kind: string, days: number) => { let l = lines.get(kind); if (l === undefined) { l = { tier, kind, days, left: 0, stubbed: 0, heldBack: 0 }; lines.set(kind, l); } return l; };
  let complete = true;
  const material = await RetainedMaterial.build(lister, { replay: true, transcripts: values.transcriptDays !== null });
  if (!material.complete) complete = false;

  if (complete && values.scratchDays !== null) {
    const cut = now.getTime() - values.scratchDays * DAY;
    const final = new Set<string>();
    let ok = await eachOf(lister, "task", (a) => { const s = (a.body as { state?: unknown }).state; if (s === "done" || s === "cancelled") final.add(a.id); });
    // An agent may register a tool or skill from its own accepted private records. The catalog version is always in the backup and reads its instructions and code back from those records (by ID and digest),
    // so they are kept whatever their age, revoked versions included (a revoked text is blanked by live retention, not by the backup).
    const catalogSources = new Set<string>();
    ok = (await eachOf(lister, "catalog-version", (a) => {
      const b = a.body as { instructional?: { recordId?: unknown }; executable?: { recordId?: unknown } };
      for (const s of [b.instructional, b.executable]) if (typeof s?.recordId === "string") catalogSources.add(s.recordId);
    }, Number.POSITIVE_INFINITY)) && ok;
    // A decision link may name a finished task's private plan as its subject. The link is always in the backup, so the plan it names is kept too (otherwise a restore gives a link that points at nothing).
    ok = (await eachOf(lister, "decision-reliance", (a) => {
      for (const id of planSubjectIds(a.body)) catalogSources.add(id);
    }, Number.POSITIVE_INFINITY)) && ok;
    const l = line("scratch", "desk-record", values.scratchDays);
    const found: Aggregate[] = [];
    ok = (await eachOf(lister, "desk-record", (a) => {
      const b = a.body as { visibility?: unknown; taskId?: unknown; deleted?: unknown; archived?: unknown };
      if (b.visibility === "private" && typeof b.taskId === "string" && b.deleted === undefined && b.archived === undefined && final.has(b.taskId) && Date.parse(a.updatedAt) < cut) found.push(a);
    })) && ok;
    if (!ok) complete = false;
    else for (const a of found) { if (catalogSources.has(a.id) || material.why("desk-record", a.id) !== undefined) l.heldBack += 1; else { omit.add(key("desk-record", a.id)); l.left += 1; } }
  }
  if (complete && values.transcriptDays !== null) {
    const cut = now.getTime() - values.transcriptDays * DAY;
    const l = line("transcripts", "chat-turn", values.transcriptDays);
    const found: Aggregate[] = [];
    const ok = await eachOf(lister, "chat-turn", (a) => {
      const b = a.body as { status?: string; completedAt?: string; held?: unknown[]; followUps?: unknown[]; retention?: unknown; resumedBy?: unknown };
      // The same turns the live rule would take: finished, not already an empty shell, no held command and no follow-up still waiting.
      if (b.status === "done" && b.retention === undefined && Date.parse(b.completedAt ?? "") < cut && (b.held === undefined || b.held.length === 0 || b.resumedBy !== undefined) && (b.followUps === undefined || b.followUps.length === 0)) found.push(a);
    });
    if (!ok) complete = false;
    else for (const a of found) { if (material.why("chat-turn", a.id) !== undefined) l.heldBack += 1; else { stub.set(key("chat-turn", a.id), values.transcriptDays); l.left += 1; l.stubbed += 1; } }
  }
  if (complete && values.logDays !== null) {
    const cut = now.getTime() - values.logDays * DAY;
    const l = line("logs", "notification-delivery", values.logDays);
    const found: Aggregate[] = [];
    const ok = await eachOf(lister, "notification-delivery", (a) => { if ((a.body as { state?: unknown }).state === "delivered" && Date.parse(a.updatedAt) < cut) found.push(a); });
    if (!ok) complete = false;
    else for (const a of found) { if (material.why("notification-delivery", a.id) !== undefined) l.heldBack += 1; else { omit.add(key("notification-delivery", a.id)); l.left += 1; } }
  }
  if (!complete) { omit.clear(); stub.clear(); lines.clear(); }
  return {
    decide(row: SnapshotRow): "keep" | "omit" | "stub" {
      const k = key(String(row["kind"]), String(row["id"]));
      return omit.has(k) ? "omit" : stub.has(k) ? "stub" : "keep";
    },
    stubText(row: SnapshotRow): string {
      const days = stub.get(key(String(row["kind"]), String(row["id"])))!;
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(String(row["body"])) as Record<string, unknown>; } catch { /* an unreadable body becomes an empty shell */ }
      return canonicalJson(turnShell(body, at, days) as never);
    },
    record(): BackupScopeRecord {
      const leftOut = [...lines.values()].map((l): BackupScopeLine => ({ tier: l.tier, kind: l.kind, olderThanDays: l.days, left: l.left, stubbed: l.stubbed, heldBack: l.heldBack }));
      const total = leftOut.reduce((n, l) => n + l.left, 0);
      const held = leftOut.reduce((n, l) => n + l.heldBack, 0);
      const text = !complete
        ? `This backup was made under your backup scope (${sentence(values)}), but the check of which records a task that can still resume or a replay refers to could not be finished (this includes the check of which records a catalogued tool or a decision link relies on), so nothing was left out: it holds everything.`
        : `This backup is NOT a full copy. Under your backup scope it leaves out ${sentence(values)}: ${total} record${total === 1 ? "" : "s"} in all${leftOut.filter((l) => l.left > 0).map((l) => ` (${l.left} ${l.kind}${l.stubbed > 0 ? `, kept as empty shells` : ""})`).join("")}${held > 0 ? `; ${held} that matched were kept because a task that can still resume, a replay or a catalogued tool refers to them` : ""}. The audit log, your decisions and everything else are in it whole. What was left out is not brought back by a restore.`;
      return { rules: { scratchDays: values.scratchDays, transcriptDays: values.transcriptDays, logDays: values.logDays }, leftOut, referenceCheckComplete: complete, text };
    },
  };
}

// ---- the owner's setting -----------------------------------------------------------------------------------------------------------------------------------------------------------------------

const REF = { kind: "backup-scope-setting", id: "main" } as const;

export interface BackupScopeSettingBody extends BackupScopeValues { readonly changedAt: string; readonly changedBy: string }
export interface BackupScopeChange { readonly before: BackupScopeValues; readonly after: BackupScopeValues; /** More is left out than before. */ readonly wider: boolean }

/** The plain-words account of a setting. */
export function describeScope(v: BackupScopeValues): string {
  if (!scopeIsOn(v)) return "Backup scope is OFF: every backup holds everything the store holds (the default).";
  return `Backups now leave out ${sentence(v)}. The audit log, your decisions and anything a task that can still resume or a replay refers to are always kept, and the safety copies taken before an upgrade or a restore are always whole. Nothing is deleted from the running system, and each backup says what it left out. Backups already made are not changed.`;
}

/**
 * The owner's backup scope (card K01d). Owner only, revision-checked, recorded in the audit log under the owner's name and announced (the hooks tell the owner's inbox), so a change made with the owner's token is seen.
 * A day count is a whole number from 7 to 3650, or `null` to turn that tier off; a field left out is not changed.
 */
export class BackupScopeSettingService {
  readonly #runner: CommandRunner;
  readonly #hooks: ((change: BackupScopeChange, by: string) => Promise<void>)[] = [];
  private constructor(runner: CommandRunner) { this.#runner = runner; }
  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): BackupScopeSettingService { return new BackupScopeSettingService(new CommandRunner(storage, epoch, options)); }

  onChanged(hook: (change: BackupScopeChange, by: string) => Promise<void>): void { this.#hooks.push(hook); }
  text(v: BackupScopeValues): string { return describeScope(v); }

  async #current(): Promise<{ revision: number; body: BackupScopeSettingBody } | undefined> {
    const found = await this.#runner.get(REF.kind, REF.id);
    return found === undefined ? undefined : { revision: found.revision, body: found.body as unknown as BackupScopeSettingBody };
  }

  /** Controller side: what the backup writer uses. No record, or a value that is not a day count in range, leaves that tier OFF for the reading only if the record is whole; a record that cannot be read at all leaves everything IN (never less than the owner asked to keep). */
  async effective(): Promise<BackupScopeValues> {
    const c = await this.#current();
    if (c === undefined) return BACKUP_SCOPE_OFF;
    const day = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= SCOPE_MIN_DAYS && v <= SCOPE_MAX_DAYS ? v : null);
    return { scratchDays: day(c.body.scratchDays), transcriptDays: day(c.body.transcriptDays), logDays: day(c.body.logDays) };
  }

  async get(by: Principal): Promise<BackupScopeValues & { revision: number; changedAt?: string; changedBy?: string; text: string }> {
    if (by.kind !== "owner" || by.taskScope !== undefined) throw new DomainError("forbidden", `${by.id} may not read the backup scope`);
    const c = await this.#current();
    const v = await this.effective();
    return { ...v, revision: c?.revision ?? 0, ...(c === undefined ? {} : { changedAt: c.body.changedAt, changedBy: c.body.changedBy }), text: describeScope(v) };
  }

  async set(owner: Principal, command: NoActor & { scratchDays?: unknown; transcriptDays?: unknown; logDays?: unknown; expectedRevision?: number }): Promise<BackupScopeValues & { revision: number; changed: boolean; wider: boolean; text: string }> {
    if (owner.kind !== "owner" || owner.taskScope !== undefined) throw new DomainError("forbidden", `${owner.id} may not change the backup scope`);
    const unknown = Object.keys(command).filter((k) => !["commandId", ...SCOPE_FIELDS, "expectedRevision"].includes(k));
    if (unknown.length > 0) throw new DomainError("invalid_command", `${unknown[0]}: is not a field of this command`, { field: unknown[0]! });
    if (SCOPE_FIELDS.every((f) => command[f] === undefined)) throw new DomainError("invalid_command", "give scratchDays, transcriptDays or logDays (a number of days from 7 to 3650, or null to turn that one off)");
    for (const f of SCOPE_FIELDS) { const v = command[f]; if (v !== undefined && v !== null && !(typeof v === "number" && Number.isSafeInteger(v) && v >= SCOPE_MIN_DAYS && v <= SCOPE_MAX_DAYS)) throw new DomainError("invalid_command", `${f}: must be a whole number of days from ${SCOPE_MIN_DAYS} to ${SCOPE_MAX_DAYS}, or null for off`, { field: f }); }
    if (command.expectedRevision !== undefined && (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0)) throw new DomainError("invalid_command", "expectedRevision: must be a whole number", { field: "expectedRevision" });
    let change: BackupScopeChange | undefined;
    const result = await this.#runner.command("backup.scope.set", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { scratchDays: command.scratchDays === undefined ? "keep" : (command.scratchDays as number | null), transcriptDays: command.transcriptDays === undefined ? "keep" : (command.transcriptDays as number | null), logDays: command.logDays === undefined ? "keep" : (command.logDays as number | null), expectedRevision: command.expectedRevision ?? null },
      build: async () => {
        const current = await this.#current();
        if (command.expectedRevision !== undefined && (current?.revision ?? 0) !== command.expectedRevision) throw new DomainError("stale_revision", `the backup scope is at revision ${current?.revision ?? 0}, not ${command.expectedRevision}`, { currentRevision: current?.revision ?? 0 });
        const before = await this.effective();
        const pick = (f: (typeof SCOPE_FIELDS)[number]): number | null => (command[f] === undefined ? before[f] : (command[f] as number | null));
        const after: BackupScopeValues = { scratchDays: pick("scratchDays"), transcriptDays: pick("transcriptDays"), logDays: pick("logDays") };
        if (SCOPE_FIELDS.every((f) => after[f] === before[f])) throw new DomainError("invalid_command", "that is how the backup scope is set already");
        // Wider: a tier switched on, or a day count lowered.
        const wider = SCOPE_FIELDS.some((f) => after[f] !== null && (before[f] === null || after[f]! < before[f]!));
        change = { before, after, wider };
        const body: BackupScopeSettingBody = { ...after, changedAt: this.#runner.now(), changedBy: owner.id };
        return { ref: REF, creates: current === undefined, changes: [current === undefined ? { type: "create" as const, ref: REF, body: body as unknown as JsonObject } : { type: "update" as const, ref: REF, expectedRevision: current.revision, body: body as unknown as JsonObject }], detail: { before: before as unknown as JsonObject, after: after as unknown as JsonObject, wider } };
      },
    }));
    const now = await this.effective();
    // A replay of an earlier command has no change of its own and announces nothing again.
    if (change !== undefined) for (const hook of this.#hooks) await hook(change, owner.id).catch(() => undefined);
    return { ...now, revision: result.revision, changed: change !== undefined, wider: change?.wider ?? false, text: describeScope(now) };
  }
}
