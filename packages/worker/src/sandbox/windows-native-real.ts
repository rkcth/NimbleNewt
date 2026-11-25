import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { win32 } from "node:path";
import type { NativeHost } from "./windows-native-job.js";
import type { ProcessResult } from "./windows-host.js";

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
 * A path that exists but whose real path cannot be found counts as a link (fails closed). The probes are injectable so the Windows rule is tested on every OS.
 */
export function isLinkOrJunctionWith(path: string, platform: NodeJS.Platform, isSymlink: (p: string) => boolean, realPath: (p: string) => string, exists: (p: string) => boolean): boolean {
  if (!exists(path)) return false;
  try {
    if (isSymlink(path)) return true;
    const real = realPath(path);
    return platform === "win32" ? win32.normalize(real).toLowerCase() !== win32.normalize(path).toLowerCase() : real !== path;
  } catch { return true; }
}

const POWERSHELL = (env: (n: string) => string | undefined): string => `${env("SystemRoot") ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

export function runProgram(file: string, args: readonly string[], options: { readonly cwd?: string; readonly timeoutMs: number }): Promise<ProcessResult> {
  return new Promise((resolve) => {
    execFile(file, [...args], { ...(options.cwd === undefined ? {} : { cwd: options.cwd }), timeout: options.timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const e = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
      resolve({ code: e === null ? 0 : typeof e.code === "number" ? e.code : null, stdout: String(stdout), stderr: String(stderr) || (e === null ? "" : e.message), timedOut: e?.killed === true });
    });
  });
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
    processes: async () => {
      if (process.platform !== "win32") return undefined;
      const r = await runProgram(POWERSHELL(env), ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToString('o') }"], { timeoutMs: 20_000 });
      return r.code === 0 ? parseProcessLines(r.stdout) : undefined;
    },
  };
}
