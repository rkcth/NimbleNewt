import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WindowsHost } from "./windows-host.js";

/*
 * Which test folders under %ProgramData% belong to the evidence runs. Any local account can create a folder there whose name matches the runs' pattern, so the name alone says nothing
 * about who made it. Each run therefore writes a small record when it creates its folder, in the runner-owned work area (`<RUNNER_TEMP>\nn-wsb-records`, or the folder named by
 * NIMBLENEWT_WSB_RECORDS): the folder's path, a random token and the job id. The same token is written to a marker file inside the folder. The cleanup acts only on a folder that a record
 * names and whose marker holds the record's token; a matching name with no record, or a record whose token differs, is reported by name only and left alone.
 */

export const MARKER_NAME = ".nn-wsb-token";
const FOLDER_NAME = /^nn-wsb-(?:real|host)-[A-Za-z0-9]{6}$/;

export interface EvidenceRecord {
  readonly path: string;
  readonly token: string;
  readonly jobId: string;
}

/** The folder the records are kept in, from an environment lookup; undefined when the machine names no work area. */
export function recordDirFrom(get: (name: string) => string | undefined): string | undefined {
  const own = get("NIMBLENEWT_WSB_RECORDS");
  if (own !== undefined && own !== "") return own;
  const work = get("RUNNER_TEMP") ?? get("TEMP");
  return work === undefined || work === "" ? undefined : `${work}\\nn-wsb-records`;
}

/**
 * Creates a fresh evidence folder (`<ProgramData>\<prefix>XXXXXX`), writes its marker and its record, and returns the real path. The record is written before the folder is used,
 * so a run that is stopped hard still leaves both behind.
 */
export function createRecordedFolder(prefix: "nn-wsb-real-" | "nn-wsb-host-", env: NodeJS.ProcessEnv = process.env): string {
  const base = realpathSync.native(mkdtempSync(join(env["ProgramData"] ?? tmpdir(), prefix)));
  const token = randomBytes(16).toString("hex");
  writeFileSync(join(base, MARKER_NAME), token);
  const dir = recordDirFrom((n) => env[n]) ?? join(tmpdir(), "nn-wsb-records");
  mkdirSync(dir, { recursive: true });
  const record: EvidenceRecord = { path: base, token, jobId: env["GITHUB_RUN_ID"] ?? "local" };
  writeFileSync(join(dir, `${base.split(/[\\/]/).pop()!}.json`), JSON.stringify(record));
  return base;
}

export interface EvidenceFolders {
  /** Recorded folders whose marker matched: safe to act on. */
  readonly folders: readonly string[];
  /** Folders under ProgramData with the pattern's name that no record vouches for (name only). */
  readonly unrecorded: readonly string[];
  /** Records that were not trusted (token differs, unreadable, or a path that is not a pattern folder directly under ProgramData): the folder is left alone. Names only. */
  readonly distrusted: readonly string[];
  /** Records whose folder no longer exists; they are dropped. */
  readonly dropped: number;
}

/** Reads the records and decides which pattern folders are acted on. Fail closed: anything that cannot be read or does not match is kept and reported. */
export function scanEvidenceFolders(host: WindowsHost): EvidenceFolders {
  const data = host.env("ProgramData");
  const folders: string[] = [];
  const distrusted: string[] = [];
  const vouched = new Set<string>();
  let dropped = 0;
  if (data === undefined || data === "") return { folders, unrecorded: [], distrusted, dropped };
  const recDir = recordDirFrom((n) => host.env(n));
  for (const file of recDir === undefined ? [] : host.listDir(recDir)) {
    if (!/\.json$/i.test(file)) continue;
    const recPath = `${recDir}\\${file}`;
    let rec: Partial<EvidenceRecord> = {};
    try { rec = JSON.parse(host.readText(recPath) ?? "") as Partial<EvidenceRecord>; } catch { /* distrusted below */ }
    const name = typeof rec.path === "string" ? rec.path.slice(rec.path.lastIndexOf("\\") + 1) : "";
    if (typeof rec.path !== "string" || typeof rec.token !== "string" || rec.token.length < 16 || !FOLDER_NAME.test(name) || rec.path.toLowerCase() !== `${data}\\${name}`.toLowerCase()) {
      distrusted.push(`record ${file.slice(0, 40)}`); continue;
    }
    vouched.add(name.toLowerCase());
    if (!host.exists(rec.path)) { host.remove(recPath); dropped++; continue; }
    if (host.isLinkOrJunction(rec.path) || host.readText(`${rec.path}\\${MARKER_NAME}`)?.trim() !== rec.token) { distrusted.push(name); continue; }
    folders.push(rec.path);
  }
  const unrecorded = host.listDir(data).filter((n) => FOLDER_NAME.test(n) && !vouched.has(n.toLowerCase()));
  return { folders, unrecorded, distrusted, dropped };
}

/** Removes the records of folders that are gone (after a cleanup that removed them). */
export function dropFinishedRecords(host: WindowsHost): number {
  const recDir = recordDirFrom((n) => host.env(n));
  const data = host.env("ProgramData") ?? "";
  let n = 0;
  for (const file of recDir === undefined ? [] : host.listDir(recDir)) {
    if (!/\.json$/i.test(file)) continue;
    try {
      const rec = JSON.parse(host.readText(`${recDir}\\${file}`) ?? "") as Partial<EvidenceRecord>;
      const name = typeof rec.path === "string" ? rec.path.slice(rec.path.lastIndexOf("\\") + 1) : "";
      if (typeof rec.path === "string" && FOLDER_NAME.test(name) && rec.path.toLowerCase() === `${data}\\${name}`.toLowerCase() && !host.exists(rec.path)) { host.remove(`${recDir}\\${file}`); n++; }
    } catch { /* kept */ }
  }
  return n;
}
