import type { Migration } from "../storage/migrations.js";

/**
 * The rules of card K03 that need no storage and no clock of their own: what counts as the rollback period, when old code may run on a newer (additive) schema, and when a destructive migration may be allowed.
 * Everything here is pure, so the same text decides in the controller, the launcher's file and the tests.
 *
 * Vocabulary. A *schema version* is the number of the last applied migration. An *upgrade* is a start that raised it (recorded with the time and whether every migration it ran was additive). A *tested pair* is a release
 * and a schema version it really started healthy on (recorded when its start is confirmed). The *rollback period* runs from the first upgrade past a pair's schema; inside it, and only while every migration since is
 * additive, the release of that pair can be run again on the newer data, because additive migrations leave everything it reads in place. After it, or after a destructive migration, going back needs a restore.
 */
export const DEFAULT_ROLLBACK_PERIOD_DAYS = 14;
export const ROLLBACK_PERIOD_BOUNDS = { min: 1, max: 365 } as const;
export const POLICY_LIMITS = { upgrades: 20, pairs: 50 } as const;

export interface UpgradeRecord { readonly from: number; readonly to: number; readonly at: string; /** Every migration the upgrade ran was additive. */ readonly additiveOnly: boolean; readonly by?: string }
export interface TestedPair { readonly release: string; readonly schema: number; readonly at: string }

export interface RollbackVerdict {
  readonly ok: boolean;
  /** Plain reasons, one per failed condition (or the one sentence that says why it is allowed). */
  readonly reasons: readonly string[];
  /** The pair the decision rests on, when there is one. */
  readonly pair?: TestedPair;
  /** When the rollback period for this pair ends (ISO), when it started. */
  readonly until?: string;
}

const DAY_MS = 86_400_000;

/** The kind of migration `version` is in this build's list (additive when the build does not know it: the planner refuses unknown ones before this matters). */
export const kindOf = (migrations: readonly Migration[], version: number): "additive" | "destructive" => (migrations[version - 1]?.kind === "destructive" ? "destructive" : "additive");

/** Whether every migration in (from, to] is additive. */
export const additiveBetween = (migrations: readonly Migration[], from: number, to: number): boolean => {
  for (let v = from + 1; v <= to; v++) if (kindOf(migrations, v) === "destructive") return false;
  return true;
};

/** The upgrades that took the data past `schema`, oldest first. */
const pastSchema = (upgrades: readonly UpgradeRecord[], schema: number): UpgradeRecord[] => upgrades.filter((u) => u.to > schema).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

/**
 * May `release` be run again on a database at `dbSchema`? Three conditions, all of which must hold:
 * 1. a tested pair exists: the release really started healthy on some schema `s` at or below the database's (the highest such pair counts);
 * 2. every migration since `s` is additive (the migration list of this build says which);
 * 3. the rollback period is open: it started at the first upgrade past `s` and lasts `periodDays`.
 * A release on the very data it was tested on (`s` equals the database's schema) is always allowed.
 * Pure. `now` is an ISO time.
 */
export function judgeRollback(input: { readonly release: string; readonly dbSchema: number; readonly pairs: readonly TestedPair[]; readonly upgrades: readonly UpgradeRecord[]; readonly migrations: readonly Migration[]; readonly periodDays: number; readonly now: string }): RollbackVerdict {
  const mine = input.pairs.filter((p) => p.release === input.release && p.schema <= input.dbSchema).sort((a, b) => b.schema - a.schema || Date.parse(b.at) - Date.parse(a.at));
  const pair = mine[0];
  if (pair === undefined) {
    const above = input.pairs.some((p) => p.release === input.release);
    return { ok: false, reasons: [above ? `release ${input.release} was only ever started on newer data than the database now holds; that pair was not tested` : `release ${input.release} has never started healthy on this installation, so no tested pair (this release on this data) exists`] };
  }
  if (pair.schema === input.dbSchema) return { ok: true, reasons: [`release ${input.release} started healthy on this very schema (${pair.schema}); that pair was tested`], pair };
  const reasons: string[] = [];
  if (!additiveBetween(input.migrations, pair.schema, input.dbSchema)) {
    const bad: number[] = [];
    for (let v = pair.schema + 1; v <= input.dbSchema; v++) if (kindOf(input.migrations, v) === "destructive") bad.push(v);
    reasons.push(`migration ${bad.join(", ")} reshaped the data destructively since release ${input.release} last ran on it (schema ${pair.schema}), so that release could no longer read it; the way back is a restore of the snapshot taken before the upgrade`);
  }
  const first = pastSchema(input.upgrades, pair.schema)[0];
  let until: string | undefined;
  if (first === undefined) reasons.push(`no upgrade past schema ${pair.schema} is on record, so the rollback period cannot be shown to be open`);
  else {
    until = new Date(Date.parse(first.at) + input.periodDays * DAY_MS).toISOString();
    if (Date.parse(input.now) > Date.parse(until)) reasons.push(`the ${input.periodDays}-day rollback period that began at the upgrade on ${first.at} ended on ${until}; going back now needs a restore or a new tested pair`);
  }
  if (reasons.length > 0) return { ok: false, reasons, pair, ...(until === undefined ? {} : { until }) };
  return { ok: true, reasons: [`release ${input.release} was tested on schema ${pair.schema}; every migration since is additive, so it still reads the data, and the rollback period runs until ${until}`], pair, until: until! };
}

/**
 * Whether destructive migrations up to `through` may be allowed (K03 "destructive migrations deferred"): `through` must name a destructive migration of this build that is not applied yet; and the rollback period of
 * the latest upgrade must be over (the old release must have been given its chance to come back first). Returns the reasons it is refused (empty: allowed).
 */
export function contractRefusals(input: { readonly through: number; readonly applied: number; readonly migrations: readonly Migration[]; readonly upgrades: readonly UpgradeRecord[]; readonly periodDays: number; readonly now: string }): string[] {
  const out: string[] = [];
  if (!Number.isSafeInteger(input.through) || input.through < 1 || input.through > input.migrations.length) return [`there is no migration ${String(input.through)} in this version (it knows 1 to ${input.migrations.length})`];
  if (input.through <= input.applied) out.push(`migration ${input.through} is already applied`);
  const waiting = input.migrations.filter((m) => m.version > input.applied && m.version <= input.through && m.kind === "destructive");
  if (waiting.length === 0 && input.through > input.applied) out.push(`migrations up to ${input.through} include no destructive one waiting; nothing needs approving`);
  const latest = [...input.upgrades].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  if (latest !== undefined) {
    const until = Date.parse(latest.at) + input.periodDays * DAY_MS;
    if (Date.parse(input.now) <= until) out.push(`the rollback period after the upgrade on ${latest.at} is still open until ${new Date(until).toISOString()}; the previous release must be able to come back until then (shorten the period first if you want it closed earlier)`);
  }
  return out;
}

/** The migrations of this build as the status shows them. */
export function journalView(migrations: readonly Migration[], applied: number, allowedThrough: number): { version: number; name: string; kind: "additive" | "destructive"; state: "applied" | "pending" | "deferred" }[] {
  const waiting = new Set<number>();
  let blocked = false;
  for (const m of migrations) {
    if (m.version <= applied) continue;
    if (m.kind === "destructive" && m.version > allowedThrough) blocked = true;
    if (blocked) waiting.add(m.version);
  }
  return migrations.map((m) => ({ version: m.version, name: m.name, kind: m.kind === "destructive" ? "destructive" as const : "additive" as const, state: m.version <= applied ? "applied" as const : waiting.has(m.version) ? "deferred" as const : "pending" as const }));
}
