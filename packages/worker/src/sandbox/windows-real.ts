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

export function windowsRealHost(): WindowsHost {
  const sysRoot = (): string => process.env["SystemRoot"] ?? "C:\\Windows";
  const run = (file: string, args: readonly string[], options: { cwd?: string; timeoutMs: number; env?: Record<string, string> }): Promise<ProcessResult> =>
    new Promise((resolve) => {
      execFile(file, [...args], { ...(options.cwd === undefined ? {} : { cwd: options.cwd }), timeout: options.timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...options.env } }, (error, stdout, stderr) => {
        const e = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        resolve({ code: e === null ? 0 : typeof e.code === "number" ? e.code : null, stdout: String(stdout), stderr: e !== null && typeof e.code !== "number" && String(stderr) === "" ? e.message : String(stderr), timedOut: e?.killed === true });
      });
    });
  const powershell = async <T>(script: string, vars: Record<string, string> = {}): Promise<T> => {
    const out = await run(`${sysRoot()}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { timeoutMs: 60_000, env: vars });
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
