import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { win32 } from "node:path";
import { parseIcaclsWritable } from "./windows-plan.js";
import type { ProcessResult, WindowsAutologon, WindowsHost, WindowsLockTask, WindowsPackageInfo, WindowsSession } from "./windows-host.js";

/**
 * The real Windows implementation of `WindowsHost` (card A03b). Only meaningful on Windows; it is exercised by the real tests (NIMBLENEWT_REAL_WINDOWS_SANDBOX=1), not by the unit tests.
 * PowerShell is used for what has no plain program (the package list, signatures, the console session, the registry's auto-login flags, the scheduled task). Data goes to it in environment
 * variables, never spliced into the script text. Nothing here writes the registry, creates an account, or reads or prints a password: the auto-login check yields booleans only.
 */
const SESSION_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class NNWts {
  [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
  [DllImport("wtsapi32.dll", SetLastError=true)] public static extern bool WTSQuerySessionInformationW(IntPtr h, uint sid, int cls, out IntPtr buf, out uint len);
  [DllImport("wtsapi32.dll")] public static extern void WTSFreeMemory(IntPtr p);
}
'@
function Query([uint32]$sid, [int]$cls) { $p = [IntPtr]::Zero; $n = [uint32]0; if (-not [NNWts]::WTSQuerySessionInformationW([IntPtr]::Zero, $sid, $cls, [ref]$p, [ref]$n)) { return $null }; return @{ p = $p; n = $n } }
$sid = [NNWts]::WTSGetActiveConsoleSessionId()
if ($sid -eq [uint32]::MaxValue) { '{"sessionId":null,"user":null,"flags":null}'; exit 0 }
$user = ''; $domain = ''; $flags = $null
$q = Query $sid 5; if ($q) { $user = [Runtime.InteropServices.Marshal]::PtrToStringUni($q.p); [NNWts]::WTSFreeMemory($q.p) }
$q = Query $sid 7; if ($q) { $domain = [Runtime.InteropServices.Marshal]::PtrToStringUni($q.p); [NNWts]::WTSFreeMemory($q.p) }
$q = Query $sid 25; if ($q) { $flags = [Runtime.InteropServices.Marshal]::ReadInt32($q.p, 16); [NNWts]::WTSFreeMemory($q.p) }
# Another session's user name can be refused to an ordinary account; the console user is also known to WMI without special rights.
if (-not $user) { try { $cu = (Get-CimInstance -ClassName Win32_ComputerSystem).UserName; if ($cu) { $parts = $cu -split '\\\\', 2; if ($parts.Count -eq 2) { $domain = $parts[0]; $user = $parts[1] } else { $user = $cu } } } catch { } }
@{ sessionId = [int]$sid; user = $user; domain = $domain; flags = $flags } | ConvertTo-Json -Compress
`;
const AUTOLOGON_SCRIPT = `
$k = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon'
$plain = ($null -ne $k.DefaultPassword) -and ("$($k.DefaultPassword)" -ne '')
@{ enabled = ($k.AutoAdminLogon -eq '1'); user = $k.DefaultUserName; domain = $k.DefaultDomainName; plain = $plain } | ConvertTo-Json -Compress
`;
const PACKAGE_SCRIPT = `
$p = Get-AppxPackage -AllUsers -Name $env:NN_NAME | Sort-Object { [version]$_.Version } -Descending | Select-Object -First 1
if ($null -eq $p) { 'null' } else { @{ name = $p.Name; publisherId = $p.PublisherId; version = $p.Version.ToString(); installLocation = $p.InstallLocation } | ConvertTo-Json -Compress }
`;
const SIGNATURE_SCRIPT = `
$s = Get-AuthenticodeSignature -LiteralPath $env:NN_PATH
@{ valid = ($s.Status -eq 'Valid'); subject = if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { $null } } | ConvertTo-Json -Compress
`;
const TASK_SCRIPT = `
$t = Get-ScheduledTask -TaskName $env:NN_TASK -ErrorAction SilentlyContinue
if ($null -eq $t) { '{"present":false}' } else { @{ present = $true; enabled = [bool]$t.Settings.Enabled -and ($t.State -ne 'Disabled'); executable = $t.Actions[0].Execute } | ConvertTo-Json -Compress }
`;

/** One PowerShell probe's time limit. Each probe starts a fresh powershell.exe, which on a busy machine, or in the bare environment the launcher gives its runner process, can be slow. */
export const PROBE_TIMEOUT_MS = 60_000;

/**
 * Runs a program with a hard time limit. At the limit the whole process tree is stopped first (`stopTree`: on Windows `taskkill /T /F`, which needs the parent still alive to find its
 * descendants), then the program itself, and its pipes are closed, so a descendant that inherited them can neither keep running nor hold the result back. If even that brings no end
 * within a few seconds, the result is given anyway. A timed-out result has code null, timedOut true and says so in stderr.
 */
export function runBounded(file: string, args: readonly string[], options: { readonly cwd?: string; readonly timeoutMs: number; readonly env?: NodeJS.ProcessEnv }, stopTree: (pid: number) => Promise<void>): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let timedOut = false;
    let done = false;
    let last: NodeJS.Timeout | undefined;
    const said = (): string => `timed out after ${String(Math.round(options.timeoutMs / 1000))} s and was stopped`;
    const finish = (r: ProcessResult): void => { if (done) return; done = true; clearTimeout(timer); if (last !== undefined) clearTimeout(last); resolve(r); };
    const child = execFile(file, [...args], { ...(options.cwd === undefined ? {} : { cwd: options.cwd }), windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...(options.env === undefined ? {} : { env: options.env }) }, (error, stdout, stderr) => {
      if (timedOut) { finish({ code: null, stdout: String(stdout), stderr: `${String(stderr)}${said()}`, timedOut: true }); return; }
      const e = error as NodeJS.ErrnoException | null;
      finish({ code: e === null ? 0 : typeof e.code === "number" ? e.code : null, stdout: String(stdout), stderr: e !== null && typeof e.code !== "number" && String(stderr) === "" ? e.message : String(stderr), timedOut: false });
    });
    const timer = setTimeout(() => {
      timedOut = true;
      const pid = child.pid;
      void (pid === undefined ? Promise.resolve() : stopTree(pid).catch(() => undefined)).finally(() => {
        try { child.kill(); } catch { /* already gone */ }
        child.stdout?.destroy();
        child.stderr?.destroy();
        last = setTimeout(() => { finish({ code: null, stdout: "", stderr: said(), timedOut: true }); }, 5_000);
      });
    }, options.timeoutMs);
  });
}

/** A read-only probe is tried a second time only when the first try ran out of time; a probe that answered with a failure is not retried, so a refusal stays a refusal. */
export async function retryOnceOnTimeout(attempt: () => Promise<ProcessResult>): Promise<ProcessResult> {
  const first = await attempt();
  return first.timedOut ? attempt() : first;
}

export function windowsRealHost(): WindowsHost {
  const sysRoot = (): string => process.env["SystemRoot"] ?? "C:\\Windows";
  // taskkill walks the tree from the parent, so it runs while the parent is still alive; the parent is our own unreaped child, so its process id cannot have been reused yet.
  const stopTree = (pid: number): Promise<void> => new Promise((resolve) => {
    execFile(`${sysRoot()}\\System32\\taskkill.exe`, ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 15_000 }, () => { resolve(); });
  });
  const run = (file: string, args: readonly string[], options: { cwd?: string; timeoutMs: number; env?: Record<string, string> }): Promise<ProcessResult> =>
    runBounded(file, args, { ...(options.cwd === undefined ? {} : { cwd: options.cwd }), timeoutMs: options.timeoutMs, env: { ...process.env, ...options.env } }, stopTree);
  const powershell = async <T>(script: string, vars: Record<string, string> = {}): Promise<T> => {
    const out = await retryOnceOnTimeout(() => run(`${sysRoot()}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { timeoutMs: PROBE_TIMEOUT_MS, env: vars }));
    if (out.timedOut) throw new Error(`PowerShell timed out twice (${String(PROBE_TIMEOUT_MS / 1000)} s each) and was stopped with everything it started`);
    if (out.code !== 0) throw new Error(`PowerShell failed (exit ${String(out.code)}): ${out.stderr.trim().slice(0, 300)}`);
    return JSON.parse(out.stdout.trim()) as T;
  };
  return {
    platform: process.platform,
    env: (name) => process.env[name],
    pid: process.pid,
    pidAlive: (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } },
    exists: (p) => existsSync(p),
    isLinkOrJunction: (p) => {
      if (!existsSync(p)) return false;
      // Fails closed: a path whose real path cannot be found, or differs from it (a junction higher up, a short name), counts as a link.
      try { return lstatSync(p).isSymbolicLink() || win32.normalize(realpathSync.native(p)).toLowerCase() !== win32.normalize(p).toLowerCase(); } catch { return true; }
    },
    rename: (a, b) => { renameSync(a, b); },
    listDir: (p) => { try { return readdirSync(p); } catch { return []; } },
    mkdirp: (p) => { mkdirSync(p, { recursive: true }); },
    readText: (p) => { try { return readFileSync(p, "utf8"); } catch { return undefined; } },
    writeText: (p, text) => { writeFileSync(p, text); },
    createExclusive: (p, text) => { try { writeFileSync(p, text, { flag: "wx" }); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") return false; throw e; } },
    remove: (p) => { rmSync(p, { recursive: true, force: true }); },
    async findPackage(): Promise<WindowsPackageInfo | undefined> {
      const p = await powershell<WindowsPackageInfo | null>(PACKAGE_SCRIPT, { NN_NAME: "MicrosoftWindows.WindowsSandbox" });
      return p === null ? undefined : p;
    },
    async signature(path) {
      const s = await powershell<{ valid: boolean; subject: string | null }>(SIGNATURE_SCRIPT, { NN_PATH: path });
      return { valid: s.valid, ...(s.subject === null ? {} : { subject: s.subject }) };
    },
    async session(): Promise<WindowsSession> {
      const s = await powershell<{ sessionId: number | null; user: string | null; domain?: string; flags: number | null }>(SESSION_SCRIPT);
      if (s.user === null || s.user === "") return {};
      // WTS_SESSIONSTATE_LOCK is 0, WTS_SESSIONSTATE_UNLOCK is 1; anything else is not trusted.
      return { consoleUser: s.domain === undefined || s.domain === "" ? s.user : `${s.domain}\\${s.user}`, ...(s.flags === 0 ? { locked: true } : s.flags === 1 ? { locked: false } : {}) };
    },
    async autologon(): Promise<WindowsAutologon> {
      const a = await powershell<{ enabled: boolean; user: string | null; domain: string | null; plain: boolean }>(AUTOLOGON_SCRIPT);
      return { enabled: a.enabled, ...(a.user === null || a.user === "" ? {} : { user: a.domain === null || a.domain === "" ? a.user : `${a.domain}\\${a.user}` }), plaintextPasswordStored: a.plain };
    },
    async lockTask(name): Promise<WindowsLockTask> {
      const t = await powershell<{ present: boolean; enabled?: boolean; executable?: string }>(TASK_SCRIPT, { NN_TASK: name });
      return { present: t.present, enabled: t.enabled === true, ...(t.executable === undefined ? {} : { executable: t.executable }) };
    },
    async writableBy(path) {
      const out = await run(`${sysRoot()}\\System32\\icacls.exe`, [path], { timeoutMs: 30_000 });
      if (out.code !== 0) throw new Error(`icacls ${path} failed: ${out.stderr.trim().slice(0, 200)}`);
      return parseIcaclsWritable(out.stdout, path);
    },
    run: (file, args, options) => run(file, args, options),
  };
}
