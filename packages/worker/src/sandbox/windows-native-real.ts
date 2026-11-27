import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, rmdirSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { NativeHost, ProcessResult } from "./windows-native-job.js";
import type { ChannelFile, ChannelFs } from "./windows-native-channel.js";

/** Parses `Get-CimInstance Win32_Process` lines ("pid parent ISO-start"); a line that does not fit is skipped. */
export function parseProcessLines(text: string): { pid: number; parent: number; started: string }[] {
  const out: { pid: number; parent: number; started: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (m !== null) out.push({ pid: Number(m[1]), parent: Number(m[2]), started: m[3]! });
  }
  return out;
}

/**
 * Whether a path is, or passes through, a link or junction. The real path must read the same as the path given (on Windows after normalising and ignoring case, so a short name such as RUNNER~1 or a junction higher up counts as a link: the seal must land on the folder named).
 * A path that exists but whose real path cannot be found counts as a link (fails closed). The link probe (lstat, which does not follow a link) is asked first, so a dangling link or junction
 * (whose target is gone, so an existence check that follows links says "missing") still counts as a link; only when that probe itself fails does a missing path count as no link.
 * The probes are injectable so the Windows rule is tested on every OS.
 */
export function isLinkOrJunctionWith(path: string, platform: NodeJS.Platform, isSymlink: (p: string) => boolean, realPath: (p: string) => string, exists: (p: string) => boolean): boolean {
  let symlink: boolean;
  try { symlink = isSymlink(path); } catch { return exists(path); }
  if (symlink) return true;
  try {
    const real = realPath(path);
    return platform === "win32" ? win32.normalize(real).toLowerCase() !== win32.normalize(path).toLowerCase() : real !== path;
  } catch { return true; }
}

const POWERSHELL = (env: (n: string) => string | undefined): string => `${env("SystemRoot") ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

export function runProgram(file: string, args: readonly string[], options: { readonly cwd?: string; readonly timeoutMs: number; readonly signal?: AbortSignal }): Promise<ProcessResult> {
  return new Promise((resolve) => {
    execFile(file, [...args], { ...(options.cwd === undefined ? {} : { cwd: options.cwd }), ...(options.signal === undefined ? {} : { signal: options.signal }), timeout: options.timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const e = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
      resolve({ code: e === null ? 0 : typeof e.code === "number" ? e.code : null, stdout: String(stdout), stderr: String(stderr) || (e === null ? "" : e.message), timedOut: e?.killed === true });
    });
  });
}

/** What `stillNamed` compares (node's BigInt stats: a file number above 2^53 is compared exactly, never rounded). */
export interface ChannelStat { isFile(): boolean; isSymbolicLink(): boolean; readonly nlink: bigint; readonly ino: bigint; readonly dev: bigint }

/** Why a file just made for the channel cannot be used, or undefined: it must be a plain file with one name and a file number (a file system that gives 0 could not tell it from another file). */
export function channelFileRefusal(first: ChannelStat): string | undefined {
  if (!first.isFile() || first.nlink !== 1n) return "the channel file is not a plain file with one name";
  if (first.ino === 0n) return "the file system gives the channel file no identity to check";
  return undefined;
}

/** The name (looked at without following a link) still leads to the file first made: a plain file, one name, the same number on the same volume. */
export function sameChannelFile(first: ChannelStat, named: ChannelStat): boolean {
  return named.isFile() && !named.isSymbolicLink() && named.nlink === 1n && first.ino !== 0n && named.ino === first.ino && named.dev === first.dev;
}

/**
 * The channel's files with node's own calls. A file is made with `wx+` (it must not exist; the handle is the file this call made, so a name the container later swaps for a link or another file is never
 * followed), checked to be a plain file with one name, and read and written by position through that handle. `stillNamed` compares the name now with the file the handle holds.
 */
export const nodeChannelFs: ChannelFs = {
  create(path: string): ChannelFile | undefined {
    let fd: number;
    try { fd = openSync(path, "wx+"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") return undefined; throw e; }
    const first = fstatSync(fd, { bigint: true });
    const refused = channelFileRefusal(first);
    if (refused !== undefined) { closeSync(fd); throw new Error(refused); }
    let written = 0;
    return {
      size: () => Number(fstatSync(fd).size),
      read: (offset, max) => { const buffer = Buffer.alloc(max); const n = readSync(fd, buffer, 0, max, offset); return buffer.subarray(0, n); },
      append: (data) => { let done = 0; while (done < data.length) done += writeSync(fd, data, done, data.length - done, written + done); written += data.length; },
      stillNamed: () => {
        try {
          return sameChannelFile(first, lstatSync(path, { bigint: true }));
        } catch { return false; }
      },
      close: () => { try { closeSync(fd); } catch { /* closed */ } },
    };
  },
  removeFolder: (dir, files) => removeChannelFolderWith(dir, files, {
    lstat: (p) => { try { const s = lstatSync(p); return s.isSymbolicLink() ? "link" : s.isDirectory() ? "dir" : "file"; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; } },
    unlink: (p) => { unlinkSync(p); },
    rmdir: (p) => { rmdirSync(p); },
    throughLink: (p) => isLinkOrJunctionWith(p, process.platform, (q) => lstatSync(q).isSymbolicLink(), (q) => realpathSync.native(q), (q) => existsSync(q)),
  }),
};

/** The calls `removeChannelFolderWith` makes; `lstat` never follows a link (on Windows node reports a junction as a link) and is undefined for a name that does not exist. */
export interface FolderOps {
  lstat(path: string): "link" | "dir" | "file" | undefined;
  unlink(path: string): void;
  rmdir(path: string): void;
  /** The path is, or passes through, a link or junction (isLinkOrJunctionWith). */
  throughLink(path: string): boolean;
}

/**
 * The channel folder's removal without following anything (see ChannelFs.removeFolder). Only calls that act on one name are used (unlink, and rmdir, which removes a directory link itself on Windows and an
 * empty folder elsewhere): none of them can remove what a link leads to. The rules are tested on every OS with stand-in calls.
 */
export function removeChannelFolderWith(dir: string, files: readonly string[], ops: FolderOps): boolean {
  const dirname = (p: string): string => (p.includes("\\") ? win32.dirname(p) : posix.dirname(p));
  const parent = dirname(dir);
  // A folder reached through a link higher up is not ours to touch: left alone, and reported as left.
  if (parent !== dir && ops.throughLink(parent)) return ops.lstat(dir) === undefined;
  const removeName = (p: string): void => {
    // A link to a folder: unlink may refuse it on Windows (a directory entry); rmdir then removes the link itself, never its target.
    try { ops.unlink(p); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; ops.rmdir(p); }
  };
  const kind = ops.lstat(dir);
  if (kind === undefined) return true;
  try {
    if (kind !== "dir" || ops.throughLink(dir)) { if (kind === "dir") return false; removeName(dir); return ops.lstat(dir) === undefined; }
    for (const f of files) {
      if (dirname(f) !== dir) continue;
      const k = ops.lstat(f);
      if (k === "file" || k === "link") removeName(f);
    }
    ops.rmdir(dir);
  } catch { /* left: reported below */ }
  return ops.lstat(dir) === undefined;
}

/** The real host: node's own file calls, the launcher and PowerShell (for the volume's file system and the process list). Meaningful on Windows; the file calls work anywhere. */
export function nativeRealHost(): NativeHost {
  const env = (n: string): string | undefined => process.env[n];
  return {
    platform: process.platform,
    pid: process.pid,
    env,
    pidAlive: (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } },
    exists: (p) => existsSync(p),
    isDirectory: (p) => { try { return lstatSync(p).isDirectory(); } catch { return false; } },
    isLinkOrJunction: (p) => isLinkOrJunctionWith(p, process.platform, (q) => lstatSync(q).isSymbolicLink(), (q) => realpathSync.native(q), (q) => existsSync(q)),
    mkdirp: (p) => { mkdirSync(p, { recursive: true }); },
    readText: (p, maxBytes = 1024 * 1024) => {
      let fd: number;
      try { fd = openSync(p, "r"); } catch { return undefined; }
      try {
        const buffer = Buffer.alloc(maxBytes);
        let total = 0;
        for (;;) { const n = readSync(fd, buffer, total, maxBytes - total, null); if (n === 0) break; total += n; if (total === maxBytes) break; }
        return buffer.subarray(0, total).toString("utf8");
      } finally { closeSync(fd); }
    },
    writeText: (p, text) => { writeFileSync(p, text); },
    // Whole or not at all: the text goes to a private temporary name first and is then linked to the name (a link fails if the name exists), so a reader never sees a lock half written.
    createExclusive: (p, text) => {
      const temp = `${p}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(temp, text, { flag: "wx" });
      try { linkSync(temp, p); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") return false; throw e; } finally { rmSync(temp, { force: true }); }
    },
    listDir: (p) => { try { return readdirSync(p); } catch { return []; } },
    remove: (p) => { rmSync(p, { recursive: true, force: true }); },
    fileSystemOf: async (p) => {
      const drive = /^([A-Za-z]):\\/.exec(p)?.[1];
      if (drive === undefined || process.platform !== "win32") return undefined;
      const r = await runProgram(POWERSHELL(env), ["-NoProfile", "-NonInteractive", "-Command", `[System.IO.DriveInfo]::new('${drive}').DriveFormat`], { timeoutMs: 20_000 });
      const name = r.stdout.trim();
      return r.code === 0 && /^[A-Za-z0-9]+$/.test(name) ? name : undefined;
    },
    run: runProgram,
    channelFs: nodeChannelFs,
    processes: async () => {
      if (process.platform !== "win32") return undefined;
      const r = await runProgram(POWERSHELL(env), ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToString('o') }"], { timeoutMs: 20_000 });
      return r.code === 0 ? parseProcessLines(r.stdout) : undefined;
    },
  };
}
