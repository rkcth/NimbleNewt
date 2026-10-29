import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { PARTIAL_SUFFIX, type BackupManifest } from "./format.js";
import { readManifest } from "./verify.js";

export interface BackupInfo { readonly path: string; readonly manifest: BackupManifest }

/** The complete backups in a folder, newest first. A folder without a finished manifest (a backup that was interrupted, or something else) is not one and is not listed. */
export async function listBackups(root: string): Promise<BackupInfo[]> {
  let names: string[];
  try { names = await readdir(root); } catch { return []; }
  const out: BackupInfo[] = [];
  for (const name of names) {
    if (name.endsWith(PARTIAL_SUFFIX) || !name.startsWith("backup-")) continue;
    const path = join(root, name);
    const read = await readManifest(path);
    if (read.manifest !== undefined) out.push({ path, manifest: read.manifest });
  }
  return out.sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt));
}

export const DEFAULT_RETENTION = { daily: 7, weekly: 4 } as const;

const day = (iso: string): string => iso.slice(0, 10);
/** The Monday (UTC) that starts the week the instant is in. */
const week = (iso: string): string => { const d = new Date(`${day(iso)}T00:00:00.000Z`); const back = (d.getUTCDay() + 6) % 7; return new Date(d.getTime() - back * 86_400_000).toISOString().slice(0, 10); };

/** Which of the backups to keep: the newest of each of the last `daily` days that have one, the newest of each of the last `weekly` weeks that have one, the newest backup of all, and every pre-upgrade snapshot (a later release decides when those may go). */
export function chooseKept(backups: readonly BackupInfo[], retention: { daily: number; weekly: number } = DEFAULT_RETENTION): Set<string> {
  const newestFirst = [...backups].sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt));
  const kept = new Set<string>();
  const first = newestFirst[0];
  if (first !== undefined) kept.add(first.path);
  for (const b of newestFirst) if (b.manifest.kind === "pre-upgrade") kept.add(b.path);
  const keepBy = (key: (iso: string) => string, count: number): void => {
    const seen = new Set<string>();
    for (const b of newestFirst) {
      const k = key(b.manifest.createdAt);
      if (seen.has(k)) continue;
      if (seen.size >= count) break;
      seen.add(k);
      kept.add(b.path);
    }
  };
  keepBy(day, retention.daily);
  keepBy(week, retention.weekly);
  return kept;
}

/** Deletes the backups outside every rule, and the `.partial` folders of backups that were interrupted (older than `partialAgeMs`, so one being written now is left alone). Returns what was removed. */
export async function pruneBackups(root: string, options: { now?: () => Date; retention?: { daily: number; weekly: number }; partialAgeMs?: number } = {}): Promise<{ deleted: string[]; partialsRemoved: string[]; kept: string[] }> {
  const now = (options.now ?? (() => new Date()))().getTime();
  const backups = await listBackups(root);
  const kept = chooseKept(backups, options.retention);
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
