import { dirname, isAbsolute } from "node:path";
import { canon } from "../backup/canon.js";
import type { StatsFs } from "node:fs";
import type { ControllerStorage } from "../storage/types.js";
import { sqliteFingerprint, type TransferTarget } from "./transfer.js";

/**
 * Transfer targets built from the host's configuration (card F04l, first slice: SQLite only). The entries may come from untrusted JSON, so every field is checked before a target exists;
 * a PostgreSQL entry is refused until that half lands. The name is what chat and the plan show; the path is where the new database file goes.
 */

/** One SQLite destination in the configuration. */
export interface SqliteTargetEntry {
  /** What the owner and chat call this destination: 1 to 64 characters of [a-z0-9-], unique in the list. */
  readonly name: string;
  readonly kind: "sqlite";
  /** The database file, absolute (a relative path would name a different file per working directory). */
  readonly path: string;
}

/** What building targets needs from outside: opening a store at a path, and reading a file system's room. */
export interface SqliteTargetDeps {
  openStorage(path: string): Promise<ControllerStorage>;
  statfs(path: string): Promise<StatsFs>;
}

/** A target name is shown and compared: short, plain, one spelling. */
const NAME = /^[a-z0-9-]{1,64}$/;
/** A host configures a handful of destinations; the list is untrusted input, so it gets a bound. */
export const TARGET_ENTRIES_MAX = 16;
/** Longest path accepted; longer is refused before the file system sees it. */
export const TARGET_PATH_MAX = 4096;
/** Absolute on this machine: on Windows a drive or UNC root (a path rooted on the current drive names a different file per working directory). */
const absolute = (p: string): boolean => isAbsolute(p) && p.length <= TARGET_PATH_MAX && !p.includes("\0") && (process.platform !== "win32" || /^(?:[a-zA-Z]:[\\/]|\\\\)/.test(p));

/**
 * The SQLite transfer targets the configuration names. Every refusal is an Error naming the entry's index and the problem; one bad entry returns no targets.
 * The fingerprint is taken at build time (links resolved), so a second spelling of the same existing path is refused. A file that does not exist yet keeps the spelling of its missing part, so on a case-insensitive file system two spellings of a new file can still pass; the transfer service refuses a destination that already holds data.
 */
export async function sqliteTargetsFromConfig(entries: readonly unknown[], deps: SqliteTargetDeps): Promise<TransferTarget[]> {
  if (!Array.isArray(entries)) throw new Error("transfer targets: must be a list of { name, kind, path } entries");
  if (entries.length > TARGET_ENTRIES_MAX) throw new Error(`transfer targets: at most ${TARGET_ENTRIES_MAX} entries (got ${entries.length})`);
  const refuse = (i: number, problem: string): never => { throw new Error(`transfer targets[${i}]: ${problem}`); };
  const names = new Set<string>();
  const places = new Map<string, number>();
  const out: TransferTarget[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) refuse(i, "must be an object { name, kind, path }");
    const o = entry as Record<string, unknown>;
    for (const key of Object.keys(o)) if (!["name", "kind", "path"].includes(key)) refuse(i, `${key.slice(0, 30).replace(/[^\x20-\x7e]/g, "?")}: is not a field of a target entry`);
    if (o["kind"] !== "sqlite") refuse(i, 'kind: must be "sqlite" (a PostgreSQL target is not built from configuration yet)');
    const name = typeof o["name"] === "string" && NAME.test(o["name"]) ? o["name"] : refuse(i, "name: must be 1 to 64 characters of [a-z0-9-]");
    const path = typeof o["path"] === "string" && absolute(o["path"]) ? o["path"] : refuse(i, "path: must be an absolute path");
    if (names.has(name)) refuse(i, `name: ${name} is used by another entry`);
    names.add(name);
    let fingerprint: string;
    try { fingerprint = await sqliteFingerprint(path); } catch { refuse(i, "path: cannot be resolved on this machine"); throw new Error("unreachable"); }
    const earlier = places.get(fingerprint);
    if (earlier !== undefined) refuse(i, `path: is the same place as entry ${earlier}`);
    places.set(fingerprint, i);
    out.push({
      name, kind: "sqlite", fingerprint, open: () => deps.openStorage(path),
      // The room of the file system the file will be on: the folder may not exist yet, so probe the nearest existing directory at or above the path's folder.
      freeBytes: async () => {
        let probe: string;
        try { probe = await canon(dirname(path)); } catch { return undefined; }
        for (;;) {
          try { const s = await deps.statfs(probe); return Number(s.bavail) * Number(s.bsize); } catch (error) {
            const parent = dirname(probe);
            if (parent === probe || (error as NodeJS.ErrnoException | null)?.code !== "ENOENT") return undefined;
            probe = parent;
          }
        }
      },
    });
  }
  return out;
}
