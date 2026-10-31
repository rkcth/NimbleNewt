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
export interface Retention { readonly daily: number; readonly weekly: number; readonly preRestoreKept?: number | null; readonly preRestoreMaxAgeDays?: number | null }
export const DEFAULT_RETENTION: Retention = { daily: 7, weekly: 4 };

const day = (iso: string): string => iso.slice(0, 10);
/** The Monday (UTC) that starts the week the instant is in. */
const week = (iso: string): string => { const d = new Date(`${day(iso)}T00:00:00.000Z`); const back = (d.getUTCDay() + 6) % 7; return new Date(d.getTime() - back * 86_400_000).toISOString().slice(0, 10); };

/** Which of the backups to keep: the newest of each of the last `daily` days that have one, the newest of each of the last `weekly` weeks that have one, the newest backup of all, and every pre-upgrade snapshot (a later release decides when those may go). */
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
  const oldestKept = newestFirst.filter((b) => kept.has(b.path) && !preRestoreOnly.has(b.path)).map((b) => b.at).sort()[0];
  for (const b of backups) if (!b.trusted && (oldestKept === undefined || b.at >= oldestKept)) kept.add(b.path);
  return kept;
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
