import type { AuditRecord, ControllerStorage, JsonObject } from "../storage/types.js";

/*
 * Card Y02: "the checkpoint reports owner decisions per day, counted from the audit log (commands whose actor is the owner, per day), and any stall that reached unrelated work".
 * This is the producer of those two figures. It is pure over audit records (the storage's `listAudit` rows, or the same rows read back from an export), so the checkpoint can run it over
 * a real installation's audit log without a running controller, and a test can run it over the audit a real controller wrote on every backend.
 *
 * Owner decisions: every distinct operation whose actor is an owner principal (`owner:<name>`), per UTC day. Internal helpers that act with an owner-like identity for bookkeeping
 * (`owner:meeting-record`) are not the owner deciding and are left out.
 * Stalls: the stall detector's concerns (`stall.concern` audit records, subject `stall-concern`): a stall is open from the first `suspected` or `confirmed` state until `cleared` or
 * `dismissed`. A stall "reached unrelated work" when, while it was open, a stall was opened on ANOTHER task. The project of each task comes from its `task.create` record when the log has it.
 * This is a correlation, not a proof of cause: it is an upper bound on the stalls that spread, and the report says so.
 */

export const OWNER_LOAD_SCHEMA = "nimblenewt.y02-owner-load/1";
export const OWNER_LOAD_LIMITS = { maxDays: 90, maxRecords: 2_000_000, maxStallsListed: 200, maxUnrelatedListed: 20 } as const;
/** Owner-like identities used by the controller itself; their records are not decisions the owner made. */
export const NOT_OWNER_DECISIONS: readonly string[] = ["owner:meeting-record"];

export interface OwnerLoadRecord {
  readonly seq: number;
  readonly operationId: string;
  readonly actor: string;
  readonly at: string;
  readonly type: string;
  readonly subject?: { readonly kind: string; readonly id: string };
  readonly detail: JsonObject;
}

export interface StallSpan {
  readonly concernId: string;
  readonly taskId: string;
  readonly projectId: string | null;
  readonly kind: string;
  readonly openedAt: string;
  /** Absent while the stall is still open at the end of the log. */
  readonly endedAt?: string;
  readonly endState?: string;
  readonly openMinutes: number;
  /** Stalls opened on other tasks while this one was open. `sameProject` is null when a project is not known from the log. */
  readonly reached: readonly { readonly taskId: string; readonly projectId: string | null; readonly sameProject: boolean | null; readonly openedAt: string }[];
}

export interface OwnerLoadReport {
  readonly schema: typeof OWNER_LOAD_SCHEMA;
  /** The window, whole UTC days ending with the day of `now`. */
  readonly from: string;
  readonly to: string;
  readonly days: number;
  readonly recordsRead: number;
  readonly perDay: readonly { readonly day: string; readonly ownerDecisions: number }[];
  readonly ownerDecisions: number;
  readonly maxOwnerDecisionsPerDay: number;
  readonly averageOwnerDecisionsPerDay: number;
  readonly stalls: readonly StallSpan[];
  readonly stallCount: number;
  readonly stallsReachingUnrelatedWork: number;
  readonly notes: readonly string[];
}

const DAY_MS = 86_400_000;
const dayOf = (iso: string): string => new Date(Date.parse(iso)).toISOString().slice(0, 10);
const OPEN_STATES = new Set(["suspected", "confirmed"]);
const END_STATES = new Set(["cleared", "dismissed"]);
const text = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** The report over `records` (any order; they are sorted by `seq`) for the `days` whole UTC days that end on the day of `now`. Pure. */
export function ownerLoadReport(records: Iterable<OwnerLoadRecord>, options: { readonly now: string; readonly days?: number; readonly truncated?: boolean }): OwnerLoadReport {
  const days = options.days ?? 7;
  if (!Number.isSafeInteger(days) || days < 1 || days > OWNER_LOAD_LIMITS.maxDays) throw new RangeError(`days must be a whole number from 1 to ${OWNER_LOAD_LIMITS.maxDays}`);
  const nowMs = Date.parse(options.now);
  if (!Number.isFinite(nowMs)) throw new RangeError("now must be a valid time");
  const lastDay = dayOf(options.now);
  const firstDay = new Date(Date.parse(`${lastDay}T00:00:00.000Z`) - (days - 1) * DAY_MS).toISOString().slice(0, 10);
  const startMs = Date.parse(`${firstDay}T00:00:00.000Z`);
  const endMs = Date.parse(`${lastDay}T00:00:00.000Z`) + DAY_MS;

  const sorted = [...records].sort((a, b) => a.seq - b.seq);
  const perDay = new Map<string, Set<string>>();
  for (let i = 0; i < days; i++) perDay.set(new Date(startMs + i * DAY_MS).toISOString().slice(0, 10), new Set());
  const projectOf = new Map<string, string>();
  interface Open { concernId: string; taskId: string; kind: string; openedAt: string }
  const open = new Map<string, Open>();
  const spans: (Omit<StallSpan, "reached" | "openMinutes" | "projectId"> & { openedMs: number; endedMs: number })[] = [];
  let skipped = 0;

  for (const r of sorted) {
    const atMs = Date.parse(r.at);
    if (!Number.isFinite(atMs)) { skipped++; continue; }
    if (r.type === "task.create" && r.subject?.kind === "task") { const p = text(r.detail["projectId"]); if (p !== undefined) projectOf.set(r.subject.id, p); }
    if (r.actor.startsWith("owner:") && !NOT_OWNER_DECISIONS.includes(r.actor) && atMs >= startMs && atMs < endMs) perDay.get(dayOf(r.at))?.add(r.operationId);
    if (r.type === "stall.concern" && r.subject?.kind === "stall-concern") {
      const state = text(r.detail["state"]);
      const taskId = text(r.detail["taskId"]);
      if (state === undefined || taskId === undefined) { skipped++; continue; }
      const id = r.subject.id;
      const current = open.get(id);
      if (OPEN_STATES.has(state) && current === undefined) open.set(id, { concernId: id, taskId, kind: text(r.detail["kind"]) ?? "unknown", openedAt: r.at });
      else if (END_STATES.has(state) && current !== undefined) {
        open.delete(id);
        spans.push({ ...current, endedAt: r.at, endState: state, openedMs: Date.parse(current.openedAt), endedMs: atMs });
      }
    }
  }
  for (const o of open.values()) spans.push({ ...o, openedMs: Date.parse(o.openedAt), endedMs: nowMs });

  // Only stalls that were open at some time inside the window are reported.
  const inWindow = spans.filter((s) => s.openedMs < endMs && s.endedMs >= startMs).sort((a, b) => a.openedMs - b.openedMs || (a.concernId < b.concernId ? -1 : 1));
  const stalls: StallSpan[] = inWindow.map((s) => {
    const projectId = projectOf.get(s.taskId) ?? null;
    const reached = spans
      .filter((o) => o.taskId !== s.taskId && o.openedMs >= s.openedMs && o.openedMs <= s.endedMs && o.concernId !== s.concernId)
      .sort((a, b) => a.openedMs - b.openedMs)
      .map((o) => { const p = projectOf.get(o.taskId) ?? null; return { taskId: o.taskId, projectId: p, sameProject: p === null || projectId === null ? null : p === projectId, openedAt: o.openedAt }; });
    return {
      concernId: s.concernId, taskId: s.taskId, projectId, kind: s.kind, openedAt: s.openedAt, ...(s.endedAt === undefined ? {} : { endedAt: s.endedAt, endState: s.endState! }),
      openMinutes: Math.max(0, Math.round((s.endedMs - s.openedMs) / 60_000)), reached: reached.slice(0, OWNER_LOAD_LIMITS.maxUnrelatedListed),
    };
  });
  const rows = [...perDay].map(([day, ops]) => ({ day, ownerDecisions: ops.size }));
  const total = rows.reduce((a, r) => a + r.ownerDecisions, 0);
  const notes = [
    "owner decisions are distinct operations whose actor is an owner principal, per UTC day",
    "a stall reached unrelated work when a stall was opened on another task while it was open: a correlation, not a proof of cause",
  ];
  if (skipped > 0) notes.push(`${skipped} audit records were malformed and not counted`);
  if (options.truncated === true) notes.push(`the audit log was cut at ${OWNER_LOAD_LIMITS.maxRecords} records; the figures cover only what was read`);
  if (stalls.length > OWNER_LOAD_LIMITS.maxStallsListed) notes.push(`${stalls.length - OWNER_LOAD_LIMITS.maxStallsListed} more stalls are counted but not listed`);
  return {
    schema: OWNER_LOAD_SCHEMA, from: firstDay, to: lastDay, days, recordsRead: sorted.length, perDay: rows, ownerDecisions: total,
    maxOwnerDecisionsPerDay: rows.reduce((a, r) => Math.max(a, r.ownerDecisions), 0), averageOwnerDecisionsPerDay: Math.round((total / days) * 100) / 100,
    stalls: stalls.slice(0, OWNER_LOAD_LIMITS.maxStallsListed), stallCount: stalls.length, stallsReachingUnrelatedWork: stalls.filter((s) => s.reached.length > 0).length, notes,
  };
}

/** Every audit record of a store, a page at a time, up to the limit. `truncated` says the limit was reached. */
export async function readAuditLog(storage: Pick<ControllerStorage, "listAudit">, maxRecords: number = OWNER_LOAD_LIMITS.maxRecords): Promise<{ records: AuditRecord[]; truncated: boolean }> {
  const records: AuditRecord[] = [];
  let after = 0;
  for (;;) {
    const page = await storage.listAudit({ afterSeq: after, limit: 1000 });
    for (const r of page) { if (records.length >= maxRecords) return { records, truncated: true }; records.push(r); }
    if (page.length < 1000) return { records, truncated: false };
    after = page[page.length - 1]!.seq;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Reads an exported audit log: one JSON object per line, either an audit record as `listAudit` returns it (`seq`, `operationId`, `actor`, `at`, `type`, `subject`, `detail`) or a row of
 * the `audit` table of a storage snapshot (`seq`, `operation_id`, `actor`, `at`, `type`, `subject_kind`, `subject_id`, `detail` as JSON text). Blank lines are ignored. A malformed line
 * is an error naming its line number: figures from a log that was only partly understood are not reported.
 */
export function parseAuditLines(raw: string, maxRecords: number = OWNER_LOAD_LIMITS.maxRecords): { records: OwnerLoadRecord[] } | { error: string } {
  const records: OwnerLoadRecord[] = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    if (records.length >= maxRecords) return { error: `more than ${maxRecords} audit records` };
    let v: unknown;
    try { v = JSON.parse(line); } catch { return { error: `line ${i + 1}: not JSON` }; }
    if (!isObject(v)) return { error: `line ${i + 1}: not an object` };
    const snapshot = "operation_id" in v;
    let detail: unknown = v["detail"];
    if (snapshot && typeof detail === "string") { try { detail = JSON.parse(detail); } catch { return { error: `line ${i + 1}: detail is not JSON` }; } }
    const subjectKind = snapshot ? v["subject_kind"] : isObject(v["subject"]) ? v["subject"]["kind"] : undefined;
    const subjectId = snapshot ? v["subject_id"] : isObject(v["subject"]) ? v["subject"]["id"] : undefined;
    const operationId = snapshot ? v["operation_id"] : v["operationId"];
    const seq = v["seq"];
    if (!Number.isSafeInteger(seq) || typeof operationId !== "string" || typeof v["actor"] !== "string" || typeof v["at"] !== "string" || !Number.isFinite(Date.parse(v["at"])) || typeof v["type"] !== "string" || !isObject(detail)) {
      return { error: `line ${i + 1}: an audit record needs seq, operation id, actor, at, type and detail` };
    }
    const subject = typeof subjectKind === "string" && typeof subjectId === "string" ? { kind: subjectKind, id: subjectId } : undefined;
    records.push({ seq: seq as number, operationId, actor: v["actor"], at: v["at"], type: v["type"], ...(subject === undefined ? {} : { subject }), detail: detail as JsonObject });
  }
  return { records };
}
