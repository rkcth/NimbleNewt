import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, statfsSync, writeFileSync, lstatSync, realpathSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { promisify } from "node:util";
import type { Problem } from "./check.js";
import { NETWORK_FILESYSTEMS, SUPPORTED_ENVIRONMENT } from "./supported.js";

const run = promisify(execFile);

/** What was found under one directory. `type` is the file system's own name, lower case (`ext4`, `apfs`, `ntfs`, `nfs4`, ...). */
export interface FilesystemFacts {
  readonly type: string;
  /** The file system is on another machine (or behind a user-space driver that may be). Never supported for the data directory. */
  readonly network: boolean;
  /** Where the answer came from, for the message (a mount point, a drive). */
  readonly where?: string;
  /** Names that differ only in case are the same file. Found by trying, when the directory exists; the workspace bridge folds names itself, so this is information, not a refusal. */
  readonly caseInsensitive?: boolean;
  /** Names that differ only in Unicode form (composed or decomposed) are the same file. */
  readonly normalizing?: boolean;
}

/** Finds the file system under a path. Injectable, so tests can simulate each file system. A rejection means it could not be found. */
export type FilesystemDetector = (path: string) => Promise<FilesystemFacts>;

export interface FilesystemTarget { readonly role: "data directory" | "workspace"; readonly path: string }

export const isNetworkType = (type: string): boolean => NETWORK_FILESYSTEMS.some((pattern) => pattern.test(type));

/** The nearest directory at or above `path` that exists (a data directory that does not exist yet lives on its parent's file system). */
export function nearestExisting(path: string): string {
  let current = resolve(path);
  for (;;) {
    try { statSync(current); return realpathSync(current); } catch { /* go up */ }
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

const unescapeMount = (s: string): string => s.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
const within = (path: string, mount: string): boolean => mount === "/" || path === mount || path.startsWith(mount.endsWith("/") ? mount : `${mount}/`);

/** The file system type of the longest mount point holding `path`, from the text of `/proc/self/mountinfo`. Pure, for tests. */
export function parseMountInfo(text: string, path: string): { type: string; mount: string } | undefined {
  let best: { type: string; mount: string } | undefined;
  for (const line of text.split("\n")) {
    const sep = line.indexOf(" - ");
    if (sep < 0) continue;
    const before = line.slice(0, sep).split(" ");
    const mount = before[4] === undefined ? undefined : unescapeMount(before[4]);
    const type = line.slice(sep + 3).split(" ")[0];
    if (mount === undefined || type === undefined || type === "" || !within(path, mount)) continue;
    // Later lines win a tie: the newest mount covers the older one.
    if (best === undefined || mount.length >= best.mount.length) best = { type: type.toLowerCase(), mount };
  }
  return best;
}

/** The same from `mount` output on macOS (`/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled)`). A mount without the `local` flag is a network mount. */
export function parseMacMounts(text: string, path: string): { type: string; mount: string; local: boolean } | undefined {
  let best: { type: string; mount: string; local: boolean } | undefined;
  for (const line of text.split("\n")) {
    const m = /^.+? on (.+) \(([^)]*)\)\s*$/.exec(line);
    if (m === null) continue;
    const mount = m[1]!, flags = m[2]!.split(",").map((f) => f.trim().toLowerCase());
    if (!within(path, mount) || flags[0] === undefined || flags[0] === "") continue;
    if (best === undefined || mount.length >= best.mount.length) best = { type: flags[0], mount, local: flags.includes("local") };
  }
  return best;
}

/** Linux `statfs` magic numbers, used only when the mount table cannot be read. `0xef53` is ext2, ext3 and ext4 alike, so it is reported as `ext` and never matches the list. */
const MAGIC: ReadonlyMap<number, string> = new Map([
  [0x58465342, "xfs"], [0x9123683e, "btrfs"], [0xef53, "ext"], [0x6969, "nfs"], [0x517b, "smb"], [0xff534d42, "cifs"], [0xfe534d42, "smb2"], [0x5346414f, "afs"], [0x00c36400, "ceph"], [0x01021997, "9p"],
  [0x0bd00bd0, "lustre"], [0x47504653, "gpfs"], [0x65735546, "fuse"], [0x01021994, "tmpfs"], [0x794c7630, "overlay"],
]);

function linuxFacts(path: string): { type: string; where: string } {
  try {
    const found = parseMountInfo(readFileSync("/proc/self/mountinfo", "utf8"), path);
    if (found !== undefined) return { type: found.type, where: found.mount };
  } catch { /* no mount table: ask the kernel */ }
  const magic = statfsSync(path).type >>> 0;
  return { type: MAGIC.get(magic) ?? `unknown (statfs type 0x${magic.toString(16)})`, where: path };
}

async function macFacts(path: string): Promise<{ type: string; where: string; network: boolean }> {
  const out = await run("/sbin/mount", [], { timeout: 10_000, encoding: "utf8" });
  const found = parseMacMounts(out.stdout, path);
  if (found === undefined) throw new Error("the mount table does not cover this path");
  return { type: found.type, where: found.mount, network: !found.local };
}

const WIN_SCRIPT = "$d = New-Object System.IO.DriveInfo($env:NN_FS_ROOT); [Console]::Out.Write($d.DriveFormat + '|' + $d.DriveType)";
async function windowsFacts(path: string): Promise<{ type: string; where: string; network: boolean }> {
  if (/^\\\\(?!\?\\)[^\\]/.test(path) || /^\/\/(?!\?\/)[^/]/.test(path)) return { type: "unc", where: path, network: true };
  const root = parse(path).root;
  const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WIN_SCRIPT], { timeout: 20_000, encoding: "utf8", windowsHide: true, env: { ...process.env, NN_FS_ROOT: root } });
  const [format, kind] = out.stdout.trim().split("|");
  if (format === undefined || format === "" || kind === undefined) throw new Error(`the drive ${root} did not report a file system`);
  return { type: format.toLowerCase(), where: root, network: kind === "Network" };
}

/** Names that differ only in case, or only in Unicode form, are the same file here? Found by creating one file in a fresh directory inside `dir` and asking for it by another spelling. */
export function probeNaming(dir: string): { caseInsensitive: boolean; normalizing: boolean } | undefined {
  let probe: string | undefined;
  try {
    probe = mkdtempSync(join(dir, ".nn-fs-probe-"));
    writeFileSync(join(probe, "Aa-é"), "");
    const exists = (name: string): boolean => { try { lstatSync(join(probe!, name)); return true; } catch { return false; } };
    return { caseInsensitive: exists("aA-é"), normalizing: exists("Aa-é") };
  } catch { return undefined; } finally { if (probe !== undefined) rmSync(probe, { recursive: true, force: true }); }
}

/** The real detector: asks this machine (mount table or statfs on Linux, the mount table on macOS, the drive on Windows), by probing and never by the name of a distribution. */
export const detectFilesystem: FilesystemDetector = async (path) => {
  const at = nearestExisting(path);
  const exists = existsSync(resolve(path));
  let found: { type: string; where: string; network?: boolean };
  switch (process.platform) {
    case "linux": found = linuxFacts(at); break;
    case "darwin": found = await macFacts(at); break;
    case "win32": found = await windowsFacts(at); break;
    default: throw new Error(`no way to find the file system on ${process.platform}`);
  }
  const naming = exists ? probeNaming(at) : undefined;
  return { type: found.type, network: found.network === true || isNetworkType(found.type), where: found.where, ...(naming === undefined ? {} : naming) };
};

const supportedNames = (platform: NodeJS.Platform): readonly string[] => SUPPORTED_ENVIRONMENT.filesystems.find((f) => f.platform === platform)?.names ?? [];
const listText = (): string => SUPPORTED_ENVIRONMENT.filesystems.map((f) => `${f.platform === "darwin" ? "macOS" : f.platform === "win32" ? "Windows" : "Linux"}: ${f.names.map((n) => (n === "apfs" ? "APFS" : n === "ntfs" ? "NTFS" : n)).join(", ")}`).join("; ") + "; network file systems are not supported for the data directory or workspaces";
const FS_TEST = "run `node scripts/qa.mjs --runs=5` from a checkout of this version with the data directory and workspaces on that file system";

/** Whether a found file system is on the list for this operating system. */
export function filesystemSupported(platform: NodeJS.Platform, facts: FilesystemFacts): boolean {
  return !facts.network && supportedNames(platform).includes(facts.type);
}

export interface FilesystemReport { readonly role: FilesystemTarget["role"]; readonly path: string; readonly facts?: FilesystemFacts; readonly supported: boolean; readonly problem?: Problem }

/**
 * Checks the file system under the data directory and each workspace root against the supported list. Everything not on the list is a problem (an unsupported type, a network file
 * system, or one that could not be found), covered by the F04h override. Nothing is created: only the nearest existing directory is looked at (the naming probe writes and removes one
 * file inside a directory that already exists, and is skipped otherwise).
 */
export async function checkFilesystems(targets: readonly FilesystemTarget[], options: { platform?: NodeJS.Platform; detect?: FilesystemDetector } = {}): Promise<FilesystemReport[]> {
  const platform = options.platform ?? process.platform;
  const detect = options.detect ?? detectFilesystem;
  const reports: FilesystemReport[] = [];
  for (const target of targets) {
    const item = `filesystem (${target.role})`;
    let facts: FilesystemFacts;
    try { facts = await detect(target.path); } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      reports.push({ role: target.role, path: target.path, supported: false, problem: { item, found: `unknown for ${target.path} (${reason.slice(0, 200)})`, supported: listText(), howToTest: FS_TEST } });
      continue;
    }
    if (filesystemSupported(platform, facts)) { reports.push({ role: target.role, path: target.path, facts, supported: true }); continue; }
    const kind = facts.network ? "a network file system" : "a file system that is not on the list";
    reports.push({ role: target.role, path: target.path, facts, supported: false, problem: { item, found: `${facts.type}${facts.where === undefined ? "" : ` (at ${facts.where})`} under ${target.path}, ${kind}`, supported: listText(), howToTest: FS_TEST } });
  }
  return reports;
}
