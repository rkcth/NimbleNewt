import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { PARTIAL_SUFFIX, parseBackupName, type BackupManifest } from "./format.js";
import { readManifest } from "./verify.js";

/**
 * `at` is the time retention uses: the one in the backup's folder name (to the second). It is the one time that can be checked without a secret, so the manifest's `createdAt` is trusted only where it agrees with the name
 * (and the manifest's name and kind with the folder's): `trusted` says so. A manifest that disagrees was changed (an encrypted backup's changed manifest also fails its MAC at verify, but retention cannot check a MAC without the secret).
 */
export interface BackupInfo { readonly path: string; readonly manifest: BackupManifest; readonly at: string; readonly trusted: boolean }

const secondOf = (iso: unknown): string | undefined => { if (typeof iso !== "string") return undefined; const t = Date.parse(iso); return Number.isNaN(t) ? undefined : `${new Date(t).toISOString().slice(0, 19)}.000Z`; };

/** The info of one backup from its name and manifest (any target): the same trust rule as a folder on this machine. `mtime` stands in for the time of a name that is not a backup's. */
export function infoOf(path: string, name: string, manifest: BackupManifest, mtime?: string): BackupInfo {
  const named = parseBackupName(name);
  const trusted = named !== undefined && manifest.name === name && manifest.kind === named.kind && secondOf(manifest.createdAt) === named.at;
  return { path, manifest, at: named?.at ?? mtime ?? "0000-00-00T00:00:00.000Z", trusted };
}

/** The complete backups in a folder, newest first. A folder without a finished manifest (a backup that was interrupted, or something else) is not one and is not listed. */
export async function listBackups(root: string): Promise<BackupInfo[]> {
  let names: string[];
  try { names = await readdir(root); } catch { return []; }
  const out: BackupInfo[] = [];
  for (const name of names) {
    if (name.endsWith(PARTIAL_SUFFIX) || !name.startsWith("backup-")) continue;
    const path = join(root, name);
    const read = await readManifest(path);
    if (read.manifest === undefined) continue;
    const named = parseBackupName(name);
    // A folder whose name is not a backup's has no time retention can rely on: it is listed, never deleted, and counts for nothing.
    const trusted = named !== undefined && read.manifest.name === name && read.manifest.kind === named.kind && secondOf(read.manifest.createdAt) === named.at;
    // Without a name time that can be relied on, the folder's own modification time stands in, so such a folder ages out like any other instead of staying for ever (a deleted record's text could sit in it).
    const mtime = named === undefined ? await stat(path).then((s) => s.mtime.toISOString(), () => undefined) : undefined;
    out.push({ path, manifest: read.manifest, at: named?.at ?? mtime ?? "0000-00-00T00:00:00.000Z", trusted });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/** `preRestoreKept`: keep the newest this many snapshots taken before a restore (card K01h); absent or null: keep them all. `preRestoreMaxAgeDays`: those older than this are not kept (absent or null: no age limit). */
export interface Retention {
  readonly daily: number; readonly weekly: number; readonly preRestoreKept?: number | null; readonly preRestoreMaxAgeDays?: number | null;
  /** Card K01c: a backup older than this many days is deleted even when a count would keep it (absent or null: no age limit). Never deleted by age: the newest good backup, a name in `protect`, a pre-upgrade snapshot, a snapshot taken before a restore (those have their own rules). */
  readonly maxAgeDays?: number | null;
  /** Card K01c: the names (folder names; `path` or `manifest.name`) of backups the age limit must not delete: the newest one verified complete. */
  readonly protect?: ReadonlySet<string>;
}
export const DEFAULT_RETENTION: Retention = { daily: 7, weekly: 4 };

const day = (iso: string): string => iso.slice(0, 10);
/** The Monday (UTC) that starts the week the instant is in. */
const week = (iso: string): string => { const d = new Date(`${day(iso)}T00:00:00.000Z`); const back = (d.getUTCDay() + 6) % 7; return new Date(d.getTime() - back * 86_400_000).toISOString().slice(0, 10); };

/** Which of the backups to keep: the newest of each of the last `daily` days that have one, the newest of each of the last `weekly` weeks that have one, the newest backup of all, the newest manual or scheduled one (card K01c: a newer snapshot never takes its place), and every pre-upgrade snapshot (a later release decides when those may go). */
export function chooseKept(backups: readonly BackupInfo[], retention: Retention = DEFAULT_RETENTION, now: Date = new Date()): Set<string> {
  const newestFirst = backups.filter((b) => b.trusted).sort((a, b) => b.at.localeCompare(a.at));
  // Snapshots taken before a restore are counted apart: they fill no daily or weekly slot (a scheduled backup of the same day is still kept) and do not stretch the time untrusted backups are kept for.
  const scheduled = newestFirst.filter((b) => b.manifest.kind !== "pre-restore");
  const kept = new Set<string>();
  // A backup whose manifest does not agree with its name is never deleted here and never takes the place of a trusted one in a rule.
  // An untrusted backup is kept while it is no older than the oldest backup the rules keep (so it expires with the others); with no trusted backup at all, everything is kept.
  const first = newestFirst[0];
  if (first !== undefined) kept.add(first.path);
  for (const b of newestFirst) if (b.manifest.kind === "pre-upgrade") kept.add(b.path);
  // A snapshot taken before a restore is the only way back from it: all are kept unless the owner set a count, then the newest that many.
  const oldest = retention.preRestoreMaxAgeDays === undefined || retention.preRestoreMaxAgeDays === null ? undefined : new Date(now.getTime() - retention.preRestoreMaxAgeDays * 86_400_000).toISOString();
  let preRestore = 0;
  for (const b of newestFirst) {
    if (b.manifest.kind !== "pre-restore") continue;
    if (retention.preRestoreKept !== undefined && retention.preRestoreKept !== null && ++preRestore > retention.preRestoreKept) continue;
    if (oldest !== undefined && b.at < oldest && b.path !== first?.path) continue;
    kept.add(b.path);
  }
  const preRestoreOnly = new Set(newestFirst.filter((b) => b.manifest.kind === "pre-restore").map((b) => b.path));
  const keepBy = (key: (iso: string) => string, count: number): void => {
    const seen = new Set<string>();
    for (const b of scheduled) {
      const k = key(b.at);
      if (seen.has(k)) continue;
      if (seen.size >= count) break;
      seen.add(k);
      kept.add(b.path);
    }
  };
  keepBy(day, retention.daily);
  keepBy(week, retention.weekly);
  // The age limit (card K01c): a backup that is older, goes even when a count would keep it; the newest good one, the newest verified complete one and the snapshots with rules of their own stay.
  // The newest good backup (a manual or scheduled one) is never deleted by any rule: a newer snapshot taken before an upgrade or a restore does not take its place.
  const newestGood = newestFirst.find((b) => b.manifest.kind !== "pre-upgrade" && b.manifest.kind !== "pre-restore");
  if (newestGood !== undefined) kept.add(newestGood.path);
  if (retention.maxAgeDays !== undefined && retention.maxAgeDays !== null) {
    const limit = new Date(now.getTime() - retention.maxAgeDays * 86_400_000).toISOString();
    for (const b of newestFirst) {
      if (!kept.has(b.path) || b.at >= limit || b.path === first?.path || b.path === newestGood?.path || b.manifest.kind === "pre-upgrade" || b.manifest.kind === "pre-restore") continue;
      if (retention.protect?.has(b.path) === true || retention.protect?.has(b.manifest.name) === true) continue;
      kept.delete(b.path);
    }
  }
  const oldestKept = newestFirst.filter((b) => kept.has(b.path) && !preRestoreOnly.has(b.path)).map((b) => b.at).sort()[0];
  for (const b of backups) if (!b.trusted && (oldestKept === undefined || b.at >= oldestKept)) kept.add(b.path);
  return kept;
}

/** How long a backup made today can stay under these rules, in days: the longer of the daily and weekly counts, cut short by the age limit when there is one (it is the answer a deletion confirmation gives, card K01c). */
export function staysUpToDays(r: Pick<Retention, "daily" | "weekly" | "maxAgeDays">): number {
  const byCounts = Math.max(r.daily, r.weekly * 7 + 6);
  return r.maxAgeDays === undefined || r.maxAgeDays === null ? byCounts : Math.min(byCounts, r.maxAgeDays);
}

/**
 * The counts and the age limit side by side, in plain words, for the owner (card K01c). `overrides` says which one decides: `age` when the age limit is shorter than the counts would keep a backup (the counts' extra
 * copies are deleted early), `counts` when the counts let a backup go before the limit (the limit then matters only when backups stop), `none` without a limit.
 */
export function describeRules(r: Pick<Retention, "daily" | "weekly" | "maxAgeDays">): { readonly overrides: "none" | "age" | "counts" | "same"; readonly byCountsDays: number; readonly text: string } {
  const byCounts = Math.max(r.daily, r.weekly * 7 + 6);
  const base = `A backup is deleted once it falls outside the newest ${r.daily} daily and ${r.weekly} weekly copies${r.maxAgeDays === undefined || r.maxAgeDays === null ? "" : ` or is older than ${r.maxAgeDays} days`}. The newest backup, the newest one verified complete and every pre-upgrade snapshot are never deleted by age.`;
  if (r.maxAgeDays === undefined || r.maxAgeDays === null) return { overrides: "none", byCountsDays: byCounts, text: `${base} There is no age limit, so the counts alone decide (about ${byCounts} days).` };
  if (r.maxAgeDays < byCounts) return { overrides: "age", byCountsDays: byCounts, text: `${base} The age limit (${r.maxAgeDays} days) is shorter than the counts alone would keep a backup (about ${byCounts} days), so the age limit decides: copies between ${r.maxAgeDays} and ${byCounts} days old are deleted although a count would keep them.` };
  if (r.maxAgeDays > byCounts) return { overrides: "counts", byCountsDays: byCounts, text: `${base} The counts let a backup go after about ${byCounts} days, sooner than the age limit (${r.maxAgeDays} days), so the counts decide; the age limit only matters when no new backups are made (then old copies still go once they are past it, but the newest good one stays).` };
  return { overrides: "same", byCountsDays: byCounts, text: `${base} The counts and the age limit agree (about ${byCounts} days).` };
}

/** Deletes the backups outside every rule, and the `.partial` folders of backups that were interrupted (older than `partialAgeMs`, so one being written now is left alone). Returns what was removed. */
export async function pruneBackups(root: string, options: { now?: () => Date; retention?: Retention; partialAgeMs?: number } = {}): Promise<{ deleted: string[]; partialsRemoved: string[]; kept: string[] }> {
  const now = (options.now ?? (() => new Date()))().getTime();
  const backups = await listBackups(root);
  const kept = chooseKept(backups, options.retention, new Date(now));
  const deleted: string[] = [];
  for (const b of backups) if (!kept.has(b.path)) { await rm(b.path, { recursive: true, force: true }); deleted.push(b.path); }
  const partialsRemoved: string[] = [];
  let names: string[] = [];
  try { names = await readdir(root); } catch { /* no folder yet */ }
  for (const name of names) {
    if (!name.endsWith(PARTIAL_SUFFIX)) continue;
    const path = join(root, name);
    const info = await stat(path).catch(() => undefined);
    if (info !== undefined && now - info.mtimeMs > (options.partialAgeMs ?? 3_600_000)) { await rm(path, { recursive: true, force: true }); partialsRemoved.push(path); }
  }
  return { deleted, partialsRemoved, kept: [...kept] };
}
