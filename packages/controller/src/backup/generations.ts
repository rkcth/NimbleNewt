import { readFile, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { MAX_JSON_BYTES, parseKeyring } from "./crypto.js";
import { MANIFEST_FILE, PARTIAL_SUFFIX } from "./format.js";

/**
 * Old key generations (card K01b). Rotating the backup key (a passcode removed or replaced) keeps the old keyring beside the new one as `<keyring>.generation-N`. Each backup embeds the key record it was made under, so
 * the archive is a convenience copy: it may be removed once no backup is left under that key, and not before. This reads the backups folder and the archives and says, for each old generation, how many backups still
 * use it. A backup folder whose manifest cannot be read is counted as "unknown": while any exists nothing is called removable, because a deletion of key material is never based on a guess.
 */
export interface GenerationUse { readonly generation: number; readonly keyId: string; readonly file: string; readonly backups: number; readonly removable: boolean }
export interface GenerationReport { readonly generations: readonly GenerationUse[]; /** Backup folders whose manifest could not be read: while there are any, no generation is removable. */ readonly unreadable: number }

const ARCHIVE = /\.generation-([0-9]{1,6})$/;

export async function generationReport(keyringFile: string, backupsFolder: string): Promise<GenerationReport> {
  const dir = dirname(resolve(keyringFile)); const base = basename(keyringFile);
  const archives: { generation: number; keyId: string; file: string }[] = [];
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const m = ARCHIVE.exec(name);
    if (m === null || name.slice(0, name.length - m[0].length) !== base) continue;
    try {
      const path = join(dir, name);
      const st = await stat(path);
      if (!st.isFile() || st.size > MAX_JSON_BYTES) continue;
      archives.push({ generation: Number(m[1]), keyId: parseKeyring(JSON.parse(await readFile(path, "utf8"))).keyId, file: path });
    } catch { /* an archive that cannot be read is not listed and is never removed */ }
  }
  const uses = new Map<string, number>();
  let unreadable = 0;
  for (const name of await readdir(backupsFolder).catch(() => [] as string[])) {
    if (!name.startsWith("backup-") || name.endsWith(PARTIAL_SUFFIX)) continue;
    try {
      const path = join(backupsFolder, name, MANIFEST_FILE);
      if ((await stat(path)).size > MAX_JSON_BYTES * 4) throw new Error("size");
      const m = JSON.parse(await readFile(path, "utf8")) as { encryption?: { keyId?: unknown } };
      const id = m.encryption?.keyId;
      if (typeof id === "string") uses.set(id, (uses.get(id) ?? 0) + 1);
    } catch { unreadable += 1; }
  }
  return { generations: archives.sort((a, b) => a.generation - b.generation).map((a) => ({ ...a, backups: uses.get(a.keyId) ?? 0, removable: unreadable === 0 && (uses.get(a.keyId) ?? 0) === 0 })), unreadable };
}

/** Removes the archived keyrings no backup uses any more (nothing else: never the current keyring, never one still in use) and returns what it removed and why the rest stayed. */
export async function pruneGenerations(keyringFile: string, backupsFolder: string): Promise<{ removed: readonly GenerationUse[]; kept: readonly GenerationUse[]; unreadable: number }> {
  const report = await generationReport(keyringFile, backupsFolder);
  const removed: GenerationUse[] = []; const kept: GenerationUse[] = [];
  for (const g of report.generations) {
    if (g.removable) { await rm(g.file, { force: true }); removed.push(g); } else kept.push(g);
  }
  return { removed, kept, unreadable: report.unreadable };
}

export const removedText = (g: GenerationUse): string => `Key generation ${g.generation} (key ${g.keyId}) has no backup left: its archived keyring was removed, and the recovery file made for it no longer opens anything (you may destroy it).`;
