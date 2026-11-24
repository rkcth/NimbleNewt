import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WindowsHost } from "./windows-host.js";
import { sameAccount } from "./windows-plan.js";

/*
 * Which test folders under %ProgramData% belong to the evidence runs. Any local account can create a folder there whose name matches the runs' pattern, so the name alone says nothing
 * about who made it. Each run therefore writes a small record when it creates its folder: the folder's path, a random token and the job id, in the runner account's own records folder
 * (`%LOCALAPPDATA%\NimbleNewt\wsb-records`, or the folder named by NIMBLENEWT_WSB_RECORDS). The same token is written to a marker file inside the folder.
 *
 * Not the runner's temporary folder: the runner empties RUNNER_TEMP at the start and end of every job, so a record kept there would be gone exactly when it is needed (a run whose
 * own cleanup step did not run), and the runner's work folder can inherit write access for every signed-in account from the drive root. The account's local application data
 * folder lives in its profile, which only that account, SYSTEM and Administrators can change; the cleanup checks that before it believes any record.
 *
 * The cleanup acts only on a folder that a record names, whose marker holds the record's token and whose owner is the record file's owner (both are made by the same process, so a
 * folder another account made, or made again after the run removed its own, is not believed even with the token, which the marker leaves readable). Everything else with the
 * pattern's name is reported by name only and left alone.
 */

export const MARKER_NAME = ".nn-wsb-token";
const FOLDER_NAME = /^nn-wsb-(?:real|host)-[A-Za-z0-9]{6}$/;

export interface EvidenceRecord {
  readonly path: string;
  readonly token: string;
  readonly jobId: string;
}

/** The folder the records are kept in, from an environment lookup; undefined when the machine names none (then nothing is recorded and nothing is trusted). */
export function recordDirFrom(get: (name: string) => string | undefined): string | undefined {
  const own = get("NIMBLENEWT_WSB_RECORDS");
  if (own !== undefined && own !== "") return own;
  const local = get("LOCALAPPDATA");
  return local === undefined || local === "" ? undefined : `${local}\\NimbleNewt\\wsb-records`;
}

/**
 * Creates a fresh evidence folder (`<ProgramData>\<prefix>XXXXXX`), writes its marker and its record, and returns the real path. The record is written before the folder is used,
 * so a run that is stopped hard still leaves both behind. Throws (before making the folder) when there is no records folder; the marker and the record are created new, never
 * written over a file that is already there.
 */
export function createRecordedFolder(prefix: "nn-wsb-real-" | "nn-wsb-host-", env: NodeJS.ProcessEnv = process.env): string {
  const dir = recordDirFrom((n) => env[n]);
  if (dir === undefined) throw new Error("no records folder for the evidence runs' folders: set LOCALAPPDATA or NIMBLENEWT_WSB_RECORDS");
  mkdirSync(dir, { recursive: true });
  const base = realpathSync.native(mkdtempSync(join(env["ProgramData"] ?? tmpdir(), prefix)));
  const token = randomBytes(16).toString("hex");
  writeFileSync(join(base, MARKER_NAME), token, { flag: "wx" });
  const record: EvidenceRecord = { path: base, token, jobId: env["GITHUB_RUN_ID"] ?? "local" };
  writeFileSync(join(dir, `${base.split(/[\\/]/).pop()!}.json`), JSON.stringify(record), { flag: "wx" });
  return base;
}

export interface EvidenceFolders {
  /** Recorded folders whose marker and owner matched: safe to act on. */
  readonly folders: readonly string[];
  /** Each of those folders' owner (SID), by lower-cased path: what the cleanup expects every control and job entry inside it to be owned by. */
  readonly owners: ReadonlyMap<string, string>;
  /** Folders under ProgramData with the pattern's name that no record vouches for (name only). */
  readonly unrecorded: readonly string[];
  /**
   * Records or folders that were not trusted (token or owner differs, unreadable, a path that is not a pattern folder directly under ProgramData, or a records folder that another
   * account can change): left alone. Names and fixed texts only.
   */
  readonly distrusted: readonly string[];
  /** Records whose folder no longer exists; they are dropped. */
  readonly dropped: number;
  /**
   * Why no record was believed at all (no records folder named, or one another account can change, or whose access list cannot be read), as a fixed text without names; undefined
   * when the records were read. Also counted in `distrusted`. When set, the cleanup can act on nothing, so the caller reports it on its own (the account names icacls prints may
   * simply differ from USERDOMAIN\USERNAME, which a run on that machine shows here first).
   */
  readonly recordsProblem?: string;
}

const ownerOf = async (host: WindowsHost, path: string): Promise<string | undefined> => { try { return await host.ownerSid(path); } catch { return undefined; } };

/** The runner's own built-in group: the installer of the GitHub Actions runner makes a local group `GITHUB_ActionsRunner_<suffix>` and gives it access to the runner's folders. */
const RUNNER_GROUP = /^GITHUB_ActionsRunner_[A-Za-z0-9]{1,32}$/;
const WELL_KNOWN = /^(?:(?:NT AUTHORITY|BUILTIN|NT SERVICE)\\[A-Za-z .]{1,40}|Everyone|CREATOR OWNER)$/i;

/**
 * Names the way the evidence shows them, without anyone's own name: a well-known system account or the runner's group by name, every other account as `account 1`, `account 2`...
 * Each with its rights as icacls printed them, when they are known. `rights` is parallel to `names` when given.
 */
export function redactedWriters(names: readonly string[], me: string | undefined): string {
  let n = 0;
  return names.map((w) => {
    const bare = w.split("\\").pop() ?? w;
    if (me !== undefined && sameAccount(w, me)) return "the account running the cleanup";
    if (RUNNER_GROUP.test(bare)) return `${bare} (the runner's group)`;
    if (WELL_KNOWN.test(w)) return w;
    n++;
    return `account ${String(n)}`;
  }).join(", ");
}

/**
 * Whether a writer is the runner's own built-in group and no one else's way in. Assumption (recorded in the notes): the name pattern alone is not believed. The group must belong to
 * THIS machine (`MACHINE\\GITHUB_ActionsRunner_...`, the machine being the one the cleanup runs on) and its members, read from Windows, must all be the account running the cleanup (or it
 * has none): a group that also holds another account would still be a way in for that account. A group whose members cannot be read is not recognised.
 */
async function isRunnerGroup(host: WindowsHost, writer: string, me: string | undefined): Promise<boolean> {
  const at = writer.lastIndexOf("\\");
  const bare = at < 0 ? writer : writer.slice(at + 1);
  if (!RUNNER_GROUP.test(bare) || host.localGroupMembers === undefined) return false;
  const machine = host.env("COMPUTERNAME");
  if (at < 0 || machine === undefined || machine === "" || writer.slice(0, at).toLowerCase() !== machine.toLowerCase()) return false;
  let members: readonly string[] | undefined;
  try { members = await host.localGroupMembers(bare); } catch { members = undefined; }
  return members !== undefined && members.every((m) => me !== undefined && sameAccount(m, me));
}

/**
 * Why a folder whose contents the cleanup would act on (the records folder, the G05 base) cannot be believed, or undefined when no account but this one (besides SYSTEM,
 * Administrators, TrustedInstaller and the runner's own group, see `isRunnerGroup`) can change it. Fixed texts. `notes` receives the evidence in redacted form (who could change the
 * folder, and what was decided about the runner's group), so a refusal can be understood from the log.
 */
export async function recordDirProblem(host: WindowsHost, recDir: string, label = "the records folder", notes?: string[]): Promise<string | undefined> {
  if (host.isLinkOrJunction(recDir)) return `${label} is or passes through a link or junction`;
  const user = host.env("USERNAME");
  const domain = host.env("USERDOMAIN");
  const me = user === undefined || user === "" ? undefined : domain === undefined || domain === "" ? user : `${domain}\\${user}`;
  let writers: readonly string[];
  try { writers = await host.writableBy(recDir); } catch { return `the access list of ${label} could not be read`; }
  const others: string[] = [];
  for (const w of writers) {
    if (me !== undefined && sameAccount(w, me)) continue;
    if (await isRunnerGroup(host, w, me)) { notes?.push(`${w.split("\\").pop() ?? w} is the runner's own group of this machine whose members are only the account running the cleanup: not counted as another account`); continue; }
    others.push(w);
  }
  notes?.push(`accounts that can change ${label}: ${writers.length === 0 ? "none besides SYSTEM, Administrators and TrustedInstaller" : redactedWriters(writers, me)}`);
  if (others.length > 0) return `${label} can be changed by an account other than the one running the cleanup`;
  return undefined;
}

/** Reads the records and decides which pattern folders are acted on. Fail closed: anything that cannot be read or does not match is kept and reported. */
export async function scanEvidenceFolders(host: WindowsHost): Promise<EvidenceFolders> {
  const data = host.env("ProgramData");
  const folders: string[] = [];
  const owners = new Map<string, string>();
  const distrusted: string[] = [];
  const vouched = new Set<string>();
  let dropped = 0;
  if (data === undefined || data === "") return { folders, owners, unrecorded: [], distrusted, dropped };
  const recDir = recordDirFrom((n) => host.env(n));
  const problem = recDir === undefined ? "no records folder (LOCALAPPDATA and NIMBLENEWT_WSB_RECORDS are unset)" : host.exists(recDir) ? await recordDirProblem(host, recDir) : undefined;
  if (problem !== undefined) distrusted.push(problem);
  for (const file of recDir === undefined || problem !== undefined ? [] : host.listDir(recDir)) {
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
    const owner = await ownerOf(host, rec.path);
    if (owner === undefined || owner !== await ownerOf(host, recPath)) { distrusted.push(name); continue; }
    folders.push(rec.path);
    owners.set(rec.path.toLowerCase(), owner);
  }
  const unrecorded = host.listDir(data).filter((n) => FOLDER_NAME.test(n) && !vouched.has(n.toLowerCase()));
  return { folders, owners, unrecorded, distrusted, dropped, ...(problem === undefined ? {} : { recordsProblem: problem }) };
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
