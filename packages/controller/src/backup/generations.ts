import { readFile, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { MAX_JSON_BYTES, parseKeyring } from "./crypto.js";
import { ENCRYPTION_MARKER, MANIFEST_FILE, PARTIAL_SUFFIX } from "./format.js";

/**
 * Old key generations (card K01b). Rotating the backup key (a passcode removed or replaced) keeps the old keyring beside the new one as `<keyring>.generation-N`. Each backup embeds the key record it was made under, so
 * the archive is a convenience copy: it may be removed once no backup is left under that key, and not before. This reads the backups folder and the archives and says, for each old generation, how many backups still
 * use it. A backup folder whose manifest cannot be read is counted as "unknown": while any exists nothing is called removable, because a deletion of key material is never based on a guess.
 */
export interface GenerationUse { readonly generation: number; readonly keyId: string; readonly file: string; readonly backups: number; readonly removable: boolean }
export interface GenerationReport { readonly generations: readonly GenerationUse[]; /** Backup folders whose manifest could not be read: while there are any, no generation is removable. */ readonly unreadable: number; /** Set when the folder given cannot be confirmed as the backups folder (it cannot be listed, or it has never held an encrypted backup: no `encryption-set-up` marker): nothing is then removable, because an empty or mistyped folder would make every archive look unused. */ readonly folderUnconfirmed?: string }

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
  let folderUnconfirmed: string | undefined;
  let names: string[];
  try { names = await readdir(backupsFolder); } catch { names = []; folderUnconfirmed = "the backups folder cannot be listed"; }
  if (folderUnconfirmed === undefined && !names.includes(ENCRYPTION_MARKER)) folderUnconfirmed = "that folder has never held an encrypted backup (no encryption-set-up marker in it), so it may not be the backups folder";
  for (const name of names) {
    if (!name.startsWith("backup-") || name.endsWith(PARTIAL_SUFFIX)) continue;
    try {
      const path = join(backupsFolder, name, MANIFEST_FILE);
      if ((await stat(path)).size > MAX_JSON_BYTES * 4) throw new Error("size");
      const m = JSON.parse(await readFile(path, "utf8")) as { encryption?: { keyId?: unknown } };
      const id = m.encryption?.keyId;
      if (typeof id === "string") uses.set(id, (uses.get(id) ?? 0) + 1);
    } catch { unreadable += 1; }
  }
  return { generations: archives.sort((a, b) => a.generation - b.generation).map((a) => ({ ...a, backups: uses.get(a.keyId) ?? 0, removable: unreadable === 0 && folderUnconfirmed === undefined && (uses.get(a.keyId) ?? 0) === 0 })), unreadable, ...(folderUnconfirmed === undefined ? {} : { folderUnconfirmed }) };
}

/** Removes the archived keyrings no backup uses any more (nothing else: never the current keyring, never one still in use) and returns what it removed and why the rest stayed. */
export async function pruneGenerations(keyringFile: string, backupsFolder: string): Promise<{ removed: readonly GenerationUse[]; kept: readonly GenerationUse[]; unreadable: number; folderUnconfirmed?: string }> {
  const report = await generationReport(keyringFile, backupsFolder);
  const removed: GenerationUse[] = []; const kept: GenerationUse[] = [];
  for (const g of report.generations) {
    if (g.removable) { await rm(g.file, { force: true }); removed.push(g); } else kept.push(g);
  }
  return { removed, kept, unreadable: report.unreadable, ...(report.folderUnconfirmed === undefined ? {} : { folderUnconfirmed: report.folderUnconfirmed }) };
}

export const removedText = (g: GenerationUse): string => `Key generation ${g.generation} (key ${g.keyId}) has no backup left in this backups folder: its archived keyring was removed. The recovery file and passcodes made for it open only backups made under that key: if you keep no copy of such a backup anywhere else (another disk, off-site), you may destroy that recovery file; if you do, keep it with those copies.`;
