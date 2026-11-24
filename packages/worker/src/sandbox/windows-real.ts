import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { launchWsb, parseMode, runViaScheduledTask, DIR_VARIABLE, MODE_VARIABLE } from "./windows-task-launch.js";
import { recordDirProblem } from "./windows-records.js";
import { SANDBOX_PACKAGES, parseIcaclsWritable, shortStatusMessage } from "./windows-plan.js";
import type { ProcessResult, WindowsAccessEntry, WindowsAutologon, WindowsHost, WindowsListContext, WindowsLockTask, WindowsPackageInfo, WindowsSession, WindowsSignature } from "./windows-host.js";

/**
 * The real Windows implementation of `WindowsHost` (card A03b). Only meaningful on Windows; it is exercised by the real tests (NIMBLENEWT_REAL_WINDOWS_SANDBOX=1), not by the unit tests.
 * PowerShell is used for what has no plain program (the package list, signatures, the console session, the registry's auto-login flags, the scheduled task). Data goes to it in environment
 * variables, never spliced into the script text. Nothing here writes the registry, creates an account, or reads or prints a password: the auto-login check yields booleans only.
 */
// The Sandbox server processes (id and start time only), for diagnosing a `wsb` call that does not answer. A start time that cannot be read is reported as null. The process is
// kept in $p before the try: inside a catch block $_ is the error, not the process.
const SERVER_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$list = @(Get-Process -Name WindowsSandboxServer | ForEach-Object { $p = $_; $s = $null; try { $s = $p.StartTime.ToUniversalTime().ToString('o') } catch {}; [pscustomobject]@{ pid = $p.Id; started = $s } })
ConvertTo-Json -InputObject $list -Compress
`;
// The context of a `wsb list` that did not answer (diagnostics only). For the process in NN_PID (the node process asking) and each WindowsSandboxServer process: token elevation
// (1, 0, or -1 when the token cannot be read) and the integrity level's RID (-1 when unknown), and the session id; the console session id; and the image names of NN_PID and its
// parents, this process first, at most 8. A "parent" started after its child is not followed (its id was reused). Names are sent as found; windows-list.ts keeps only a fixed list.
const LIST_CONTEXT_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class NNTok {
  [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("advapi32.dll", SetLastError=true)] public static extern bool OpenProcessToken(IntPtr p, uint access, out IntPtr t);
  [DllImport("advapi32.dll", SetLastError=true)] public static extern bool GetTokenInformation(IntPtr t, int cls, IntPtr buf, int len, out int ret);
  [DllImport("advapi32.dll")] public static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
  [DllImport("advapi32.dll")] public static extern IntPtr GetSidSubAuthority(IntPtr sid, uint i);
  // PROCESS_QUERY_LIMITED_INFORMATION, TOKEN_QUERY; TokenElevation 20, TokenIntegrityLevel 25 (a TOKEN_MANDATORY_LABEL: the label SID's pointer first).
  public static int[] Info(int pid) {
    int[] r = new int[] { -1, -1 };
    IntPtr p = OpenProcess(0x1000, false, pid); if (p == IntPtr.Zero) return r;
    try {
      IntPtr t; if (!OpenProcessToken(p, 8, out t)) return r;
      try {
        IntPtr b = Marshal.AllocHGlobal(256);
        try {
          int n;
          if (GetTokenInformation(t, 20, b, 4, out n)) r[0] = Marshal.ReadInt32(b) != 0 ? 1 : 0;
          if (GetTokenInformation(t, 25, b, 256, out n)) { IntPtr sid = Marshal.ReadIntPtr(b); int c = Marshal.ReadByte(GetSidSubAuthorityCount(sid)); if (c > 0) r[1] = Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(c - 1))); }
        } finally { Marshal.FreeHGlobal(b); }
      } finally { CloseHandle(t); }
    } finally { CloseHandle(p); }
    return r;
  }
}
'@
# If the type could not be added, every token value stays -1 and the console session unknown, so the rest is still reported (indexing a missing result would end the script).
function Get-NNInfo([int]$id) { $r = $null; try { $r = [NNTok]::Info($id) } catch {}; if ($null -eq $r -or $r.Count -ne 2) { $r = @(-1, -1) }; return ,$r }
$me = [int]$env:NN_PID
$self = Get-NNInfo $me
$selfSession = $null; try { $selfSession = [int](Get-Process -Id $me).SessionId } catch {}
$console = $null; try { $console = [int64][NNTok]::WTSGetActiveConsoleSessionId() } catch {}
$servers = @(Get-Process -Name WindowsSandboxServer | Select-Object -First 8 | ForEach-Object { $p = $_; $i = Get-NNInfo $p.Id; @{ sessionId = [int]$p.SessionId; elevated = $i[0]; integrity = $i[1] } })
$all = @{}; foreach ($q in @(Get-CimInstance -ClassName Win32_Process)) { $all[[int]$q.ProcessId] = $q }
$chain = @(); $cur = $all[$me]
while ($cur -and $chain.Count -lt 8) {
  $chain += "$($cur.Name)"
  $up = $all[[int]$cur.ParentProcessId]
  if (-not $up -or [int]$up.ProcessId -eq [int]$cur.ProcessId -or $up.CreationDate -gt $cur.CreationDate) { break }
  $cur = $up
}
ConvertTo-Json -Compress -Depth 4 -InputObject @{ elevated = $self[0]; integrity = $self[1]; processSessionId = $selfSession; consoleSessionId = $console; servers = $servers; chain = $chain }
`;
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
# This PowerShell is a child of the process asking, so it runs in that process's session and with its account: whether that is the console session and the console user
# (reported to explain an E_ACCESSDENIED start, own-hardware run 44501483353). The account is compared by SID when the console user's name resolves to one; the name is sent only for that comparison.
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$procSession = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
$sameSid = $null
if ($user) { try { $acct = if ($domain) { New-Object System.Security.Principal.NTAccount($domain, $user) } else { New-Object System.Security.Principal.NTAccount($user) }; $sameSid = ($acct.Translate([System.Security.Principal.SecurityIdentifier]).Value -eq $me.User.Value) } catch { } }
@{ sessionId = [int]$sid; user = $user; domain = $domain; flags = $flags; processSessionId = [int]$procSession; processUser = $me.Name; sameSid = $sameSid } | ConvertTo-Json -Compress
`;
const AUTOLOGON_SCRIPT = `
$k = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon'
$plain = ($null -ne $k.DefaultPassword) -and ("$($k.DefaultPassword)" -ne '')
@{ enabled = ($k.AutoAdminLogon -eq '1'); user = $k.DefaultUserName; domain = $k.DefaultDomainName; plain = $plain } | ConvertTo-Json -Compress
`;
// Each allowed package name is looked up exactly (the names hold no wildcard characters); the newest of what is found is reported, and verifyClient checks it against SANDBOX_PACKAGES.
const PACKAGE_SCRIPT = `
$found = @(foreach ($n in ($env:NN_NAMES -split ';')) { if ($n) { Get-AppxPackage -AllUsers -Name $n } })
$p = $found | Sort-Object { [version]$_.Version } -Descending | Select-Object -First 1
$flag = { param($o, $n) if ($o.PSObject.Properties[$n] -and ($o.$n -is [bool])) { $o.$n } else { $null } }
if ($null -eq $p) { 'null' } else { @{ name = $p.Name; publisherId = $p.PublisherId; familyName = $p.PackageFamilyName; version = $p.Version.ToString(); installLocation = $p.InstallLocation; signatureKind = "$($p.SignatureKind)"; status = "$($p.Status)"; nonRemovable = (& $flag $p 'NonRemovable'); isFramework = (& $flag $p 'IsFramework') } | ConvertTo-Json -Compress }
`;
// SignatureType exists from Windows PowerShell 5.1 on; where it does not, it is reported as absent.
const SIGNATURE_SCRIPT = `
$s = Get-AuthenticodeSignature -LiteralPath $env:NN_PATH
$type = if ($s.PSObject.Properties['SignatureType']) { "$($s.SignatureType)" } else { $null }
@{ valid = ($s.Status -eq 'Valid'); status = "$($s.Status)"; statusMessage = "$($s.StatusMessage)"; signatureType = $type; subject = if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { $null } } | ConvertTo-Json -Compress
`;
// The owner by SID, so the answer is the same in every language. Get-Acl reads the owner, group and access list (not the audit list), which needs the same read-control
// right icacls needs for the access list.
const OWNER_SCRIPT = `
$a = Get-Acl -LiteralPath $env:NN_PATH
$o = $a.GetOwner([System.Security.Principal.SecurityIdentifier])
@{ owner = if ($null -eq $o) { $null } else { $o.Value } } | ConvertTo-Json -Compress
`;
// The access list by SID (the same in every language), explicit and inherited entries, for the findings. The count is sent next to the list so that a list PowerShell turned
// into a single object, or cut short, is noticed. Rights are the raw access mask (generic rights included), flags their numeric values; nothing is translated here.
// 'Stop' makes a path that cannot be read end the script with an error (exit 1): without it Get-Acl only reports the error, the rest runs on nothing and prints an empty list
// with a count of 0, which would read as "nobody else can change it".
const ACCESS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$a = Get-Acl -LiteralPath $env:NN_PATH
$rules = @($a.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
$out = @(foreach ($r in $rules) { @{ sid = $r.IdentityReference.Value; rights = [int64]$r.FileSystemRights.value__; type = "$($r.AccessControlType)"; inherited = [bool]$r.IsInherited; inheritance = [int]$r.InheritanceFlags.value__; propagation = [int]$r.PropagationFlags.value__ } })
ConvertTo-Json -Compress -Depth 4 -InputObject @{ count = $rules.Count; entries = $out }
`;
const TASK_SCRIPT = `
$t = Get-ScheduledTask -TaskName $env:NN_TASK -ErrorAction SilentlyContinue
if ($null -eq $t) { '{"present":false}' } else { @{ present = $true; enabled = [bool]$t.Settings.Enabled -and ($t.State -ne 'Disabled'); executable = $t.Actions[0].Execute } | ConvertTo-Json -Compress }
`;

type RawPackage = { name?: unknown; publisherId?: unknown; familyName?: unknown; version?: unknown; installLocation?: unknown; signatureKind?: unknown; status?: unknown; nonRemovable?: unknown; isFramework?: unknown };
type RawSignature = { valid?: unknown; subject?: unknown; status?: unknown; statusMessage?: unknown; signatureType?: unknown };
const text = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

export interface RawSession { readonly sessionId?: unknown; readonly user?: unknown; readonly domain?: unknown; readonly flags?: unknown; readonly processSessionId?: unknown; readonly processUser?: unknown; readonly sameSid?: unknown }

/**
 * The session probe's answer as the host interface reports it. Nobody signed in is `{}`. The two facts about this process are reported only when the probe determined them: in the
 * console session when both session ids are numbers; the console user by SID when the probe could compare SIDs, otherwise only by the exact full name (case aside). Anything else is
 * absent, which the session check refuses.
 */
export function sessionFromProbe(raw: RawSession): WindowsSession {
  const user = text(raw.user);
  if (user === undefined) return {};
  const domain = text(raw.domain);
  const consoleUser = domain === undefined ? user : `${domain}\\${user}`;
  const id = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);
  const consoleId = id(raw.sessionId), processId = id(raw.processSessionId);
  const processUser = text(raw.processUser);
  const isUser = typeof raw.sameSid === "boolean" ? raw.sameSid : processUser === undefined ? undefined : processUser.toLowerCase() === consoleUser.toLowerCase();
  return {
    consoleUser,
    // WTS_SESSIONSTATE_LOCK is 0, WTS_SESSIONSTATE_UNLOCK is 1; anything else is not trusted.
    ...(raw.flags === 0 ? { locked: true } : raw.flags === 1 ? { locked: false } : {}),
    ...(consoleId === undefined || processId === undefined ? {} : { processInConsoleSession: consoleId === processId }),
    ...(isUser === undefined ? {} : { processIsConsoleUser: isUser }),
  };
}

/** The package probe's answer as the host interface reports it. A field that is missing or not text is reported empty (required ones) or absent (optional ones), so the checks refuse it. */
export function packageFromProbe(raw: RawPackage | null): WindowsPackageInfo | undefined {
  if (raw === null) return undefined;
  const signatureKind = text(raw.signatureKind), status = text(raw.status);
  return {
    name: text(raw.name) ?? "", publisherId: text(raw.publisherId) ?? "", familyName: text(raw.familyName) ?? "", version: text(raw.version) ?? "", installLocation: text(raw.installLocation) ?? "",
    ...(signatureKind === undefined ? {} : { signatureKind }), ...(status === undefined ? {} : { status }),
    ...(typeof raw.nonRemovable === "boolean" ? { nonRemovable: raw.nonRemovable } : {}), ...(typeof raw.isFramework === "boolean" ? { isFramework: raw.isFramework } : {}),
  };
}

/**
 * The access-list probe's answer, read strictly: an object with a whole-number `count` and `entries`, a list of exactly that many entries (one entry alone may come as an object,
 * which is how PowerShell can write a list of one), each with a SID of the usual form, an access mask that fits in 32 bits, the type exactly `Allow` or `Deny`, `inherited` true
 * or false and the inheritance and propagation flags as numbers from 0 to 3. Anything else throws, so a list that is not in this exact form is never recorded as an answer.
 */
export function accessFromProbe(raw: unknown, path: string): WindowsAccessEntry[] {
  const fail = (why: string): never => { throw new Error(`the access list of ${path} was not reported in the expected form: ${why}`); };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return fail("not an object");
  const { count, entries } = raw as { count?: unknown; entries?: unknown };
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) return fail("no entry count");
  const list: unknown[] = Array.isArray(entries) ? entries : count === 1 && entries !== null && typeof entries === "object" ? [entries] : count === 0 && (entries === null || entries === undefined) ? [] : fail("the entries are not a list");
  if (list.length !== count) return fail(`${String(list.length)} entries for a count of ${String(count)}`);
  return list.map((item, i) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return fail(`entry ${String(i)} is not an object`);
    const e = item as { sid?: unknown; rights?: unknown; type?: unknown; inherited?: unknown; inheritance?: unknown; propagation?: unknown };
    if (typeof e.sid !== "string" || !/^S-1-\d+(?:-\d+)+$/.test(e.sid)) return fail(`entry ${String(i)} has no SID`);
    if (typeof e.rights !== "number" || !Number.isInteger(e.rights) || e.rights < -0x80000000 || e.rights > 0xffffffff) return fail(`entry ${String(i)} has no access mask`);
    if (e.type !== "Allow" && e.type !== "Deny") return fail(`entry ${String(i)} is neither Allow nor Deny`);
    if (typeof e.inherited !== "boolean") return fail(`entry ${String(i)} does not say whether it is inherited`);
    const flag = (v: unknown, name: string): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 3 ? v : fail(`entry ${String(i)} has no ${name} flags`));
    const inheritance = flag(e.inheritance, "inheritance"), propagation = flag(e.propagation, "propagation");
    // InheritanceFlags: ContainerInherit 1, ObjectInherit 2. PropagationFlags: NoPropagateInherit 1, InheritOnly 2.
    return { sid: e.sid, allow: e.type === "Allow", rights: e.rights >>> 0, inherited: e.inherited, objectInherit: (inheritance & 2) !== 0, containerInherit: (inheritance & 1) !== 0, noPropagate: (propagation & 1) !== 0, inheritOnly: (propagation & 2) !== 0 };
  });
}

/** The signature probe's answer: valid only when the probe said so and the status is exactly Valid; Windows' message is shortened and the file's path in it replaced. */
export function signatureFromProbe(raw: RawSignature, path: string): WindowsSignature {
  const subject = text(raw.subject), status = text(raw.status), message = text(raw.statusMessage), signatureType = text(raw.signatureType);
  return {
    valid: raw.valid === true && status === "Valid",
    ...(subject === undefined ? {} : { subject }), ...(status === undefined ? {} : { status }),
    ...(message === undefined ? {} : { statusMessage: shortStatusMessage(message, path) }), ...(signatureType === undefined ? {} : { signatureType }),
  };
}

/** The owner probe's answer: a SID in its usual form (`S-1-` and numbers), or an error; anything else is never passed on as an owner. */
export function ownerFromProbe(raw: { owner?: unknown } | null, path: string): string {
  const owner = raw === null ? undefined : raw.owner;
  if (typeof owner !== "string" || !/^S-1-\d+(?:-\d+)+$/.test(owner)) throw new Error(`the owner of ${path} was not reported as a SID`);
  return owner;
}

/** One PowerShell probe's time limit. Each probe starts a fresh powershell.exe, which on a busy machine, or in the bare environment the launcher gives its runner process, can be slow. */
export const PROBE_TIMEOUT_MS = 60_000;
/** The Sandbox server process probe (diagnostics around `wsb list`): one try, no retry. */
export const SERVER_PROBE_TIMEOUT_MS = 30_000;
/** The list-context probe (diagnostics after a failed `wsb list`): one try, no retry; it compiles a small type, so it gets a little more than the server probe. */
export const CONTEXT_PROBE_TIMEOUT_MS = 45_000;
/** The only variables the diagnostic `wsb list` through cmd.exe gets. */
export const MINIMAL_ENV_NAMES: readonly string[] = ["SystemRoot", "windir", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP", "PATH"];

/** The minimal environment: those names with this process's values where set (process.env on Windows finds a name in any case), nothing else. */
export function minimalEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of MINIMAL_ENV_NAMES) { const v = source[n]; if (v !== undefined && v !== "") out[n] = v; }
  return out;
}

/**
 * The command line for `cmd.exe /d /v:off /s /c "<"program" args>"`, passed verbatim. Only a program path and arguments without quotes, percent signs, line breaks or NUL are taken: with
 * /s cmd strips the outer quotes and runs the rest, where a quoted path keeps & | < > ^ literal, but % would still expand (! does not: delayed expansion is off). Anything else throws.
 */
export function cmdLine(file: string, args: readonly string[]): string {
  for (const part of [file, ...args]) if (/["%\r\n\0]/.test(part)) throw new Error("a program path or argument that cmd.exe could change");
  for (const a of args) if (!/^[A-Za-z0-9-]+$/.test(a)) throw new Error("an argument that is not a plain word");
  return `/d /v:off /s /c ""${file}" ${args.join(" ")}"`;
}

/**
 * Runs a program with a hard time limit. At the limit the whole process tree is stopped first (`stopTree`: on Windows `taskkill /T /F`, which needs the parent still alive to find its
 * descendants), then the program itself, and its pipes are closed, so a descendant that inherited them can neither keep running nor hold the result back. If even that brings no end
 * within a few seconds, the result is given anyway. A timed-out result has code null, timedOut true and says so in stderr.
 */
export function runBounded(file: string, args: readonly string[], options: { readonly cwd?: string; readonly timeoutMs: number; readonly env?: NodeJS.ProcessEnv; readonly verbatim?: boolean }, stopTree: (pid: number) => Promise<void>): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let timedOut = false;
    let done = false;
    let last: NodeJS.Timeout | undefined;
    const said = (): string => `timed out after ${String(Math.round(options.timeoutMs / 1000))} s and was stopped`;
    const finish = (r: ProcessResult): void => { if (done) return; done = true; clearTimeout(timer); if (last !== undefined) clearTimeout(last); resolve(r); };
    const child = execFile(file, [...args], { ...(options.cwd === undefined ? {} : { cwd: options.cwd }), windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...(options.env === undefined ? {} : { env: options.env }), ...(options.verbatim === true ? { windowsVerbatimArguments: true } : {}) }, (error, stdout, stderr) => {
      if (timedOut) { finish({ code: null, stdout: String(stdout), stderr: `${String(stderr)}${said()}`, timedOut: true }); return; }
      const e = error as NodeJS.ErrnoException | null;
      finish({ code: e === null ? 0 : typeof e.code === "number" ? e.code : null, stdout: String(stdout), stderr: e !== null && typeof e.code !== "number" && String(stderr) === "" ? e.message : String(stderr), timedOut: false });
    });
    const timer = setTimeout(() => {
      timedOut = true;
      const pid = child.pid;
      // The tree is stopped only while the program has not ended: once node has seen its end it lets go of the process, and Windows may then give the same id to another
      // program, which a tree stop by id would end with everything under it. A program that ended while a descendant still holds its pipes is past that point; closing the
      // pipes below still brings the result back (that descendant keeps running: with its parent gone, taskkill /T could not find it anyway).
      const live = pid !== undefined && child.exitCode === null && child.signalCode === null;
      void (live ? Promise.resolve().then(() => stopTree(pid)).catch(() => undefined) : Promise.resolve()).finally(() => {
        try { child.kill(); } catch { /* already gone */ }
        child.stdout?.destroy();
        child.stderr?.destroy();
        if (!done) last = setTimeout(() => { finish({ code: null, stdout: "", stderr: said(), timedOut: true }); }, 5_000);
      });
    }, options.timeoutMs);
  });
}

/** A read-only probe is tried a second time only when the first try ran out of time; a probe that answered with a failure is not retried, so a refusal stays a refusal. */
export async function retryOnceOnTimeout(attempt: () => Promise<ProcessResult>): Promise<ProcessResult> {
  const first = await attempt();
  return first.timedOut ? attempt() : first;
}

// The members of one local group (names only). A group that cannot be read gives no answer, which callers read as "not recognised".
const GROUP_SCRIPT = `
$ErrorActionPreference = 'Stop'
$list = @(Get-LocalGroupMember -Group $env:NN_GROUP | ForEach-Object { [string]$_.Name })
ConvertTo-Json -InputObject $list -Compress
`;

export function windowsRealHost(): WindowsHost {
  const sysRoot = (): string => process.env["SystemRoot"] ?? "C:\\Windows";
  // taskkill walks the tree from the parent, so it runs while the parent is still alive; runBounded calls it only for a program whose end node has not yet seen, so the id is
  // still that program's (node still holds the process). A full path under the system root, arguments as a list, no shell and no PATH lookup.
  const stopTree = (pid: number): Promise<void> => new Promise((resolve) => {
    execFile(`${sysRoot()}\\System32\\taskkill.exe`, ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 15_000 }, () => { resolve(); });
  });
  const run = (file: string, args: readonly string[], options: { cwd?: string; timeoutMs: number; env?: Record<string, string> }): Promise<ProcessResult> =>
    runBounded(file, args, { ...(options.cwd === undefined ? {} : { cwd: options.cwd }), timeoutMs: options.timeoutMs, env: { ...process.env, ...options.env } }, stopTree);
  const powershell = async <T>(script: string, vars: Record<string, string> = {}, once?: { readonly timeoutMs: number }): Promise<T> => {
    const attempt = (): Promise<ProcessResult> => run(`${sysRoot()}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { timeoutMs: once?.timeoutMs ?? PROBE_TIMEOUT_MS, env: vars });
    const out = once === undefined ? await retryOnceOnTimeout(attempt) : await attempt();
    if (out.timedOut) throw new Error(once === undefined ? `PowerShell timed out twice (${String(PROBE_TIMEOUT_MS / 1000)} s each) and was stopped with everything it started` : `PowerShell timed out (${String(once.timeoutMs / 1000)} s) and was stopped with everything it started`);
    if (out.code !== 0) throw new Error(`PowerShell failed (exit ${String(out.code)}): ${out.stderr.trim().slice(0, 300)}`);
    return JSON.parse(out.stdout.trim()) as T;
  };
  const host: WindowsHost = {
    platform: process.platform,
    env: (name) => process.env[name],
    pid: process.pid,
    envNames: () => Object.keys(process.env),
    async serverProcesses() {
      // Recorded only (diagnostics), so one short try: it runs before and after every `wsb list` and must not add much to the list's own time bound.
      const raw = await powershell<{ pid?: unknown; started?: unknown }[] | { pid?: unknown; started?: unknown } | null>(SERVER_SCRIPT, {}, { timeoutMs: SERVER_PROBE_TIMEOUT_MS });
      const list = Array.isArray(raw) ? raw : raw === null ? [] : [raw];
      return list.filter((p) => typeof p.pid === "number").map((p) => ({ pid: p.pid as number, ...(typeof p.started === "string" ? { started: p.started } : {}) }));
    },
    async listContext(): Promise<WindowsListContext> {
      // Recorded only, after every `wsb list` call failed: one try.
      return powershell<WindowsListContext>(LIST_CONTEXT_SCRIPT, { NN_PID: String(process.pid) }, { timeoutMs: CONTEXT_PROBE_TIMEOUT_MS });
    },
    // A full path to cmd.exe under the system root, AutoRun ignored (/d), the environment replaced (not merged) by the minimal one.
    runMinimalEnv: (file, args, options) => runBounded(`${sysRoot()}\\System32\\cmd.exe`, [cmdLine(file, args)], { ...(options.cwd === undefined ? {} : { cwd: options.cwd }), timeoutMs: options.timeoutMs, env: minimalEnv(process.env), verbatim: true }, stopTree),
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
      return packageFromProbe(await powershell<RawPackage | null>(PACKAGE_SCRIPT, { NN_NAMES: SANDBOX_PACKAGES.map((p) => p.name).join(";") }));
    },
    async signature(path) {
      return signatureFromProbe(await powershell<RawSignature>(SIGNATURE_SCRIPT, { NN_PATH: path }), path);
    },
    async session(): Promise<WindowsSession> {
      return sessionFromProbe(await powershell<RawSession>(SESSION_SCRIPT));
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
    async accessEntries(path) {
      return accessFromProbe(await powershell<unknown>(ACCESS_SCRIPT, { NN_PATH: path }), path);
    },
    async ownerSid(path) {
      return ownerFromProbe(await powershell<{ owner?: unknown } | null>(OWNER_SCRIPT, { NN_PATH: path }), path);
    },
    run: (file, args, options) => run(file, args, options),
    async runWsb(file, args, options) {
      const direct = (): Promise<ProcessResult> => run(file, args, options);
      const mode = parseMode(process.env[MODE_VARIABLE]);
      if (mode === "direct" || process.platform !== "win32") return direct();
      const base = process.env[DIR_VARIABLE] ?? (process.env["LOCALAPPDATA"] === undefined || process.env["LOCALAPPDATA"] === "" ? undefined : `${process.env["LOCALAPPDATA"]}\\NimbleNewt\\wsb-task`);
      if (base === undefined) return launchWsb(mode, () => Promise.resolve({ kind: "unavailable" as const, why: "no private folder is configured (LOCALAPPDATA and NIMBLENEWT_WSB_TASK_DIR are unset)" }), direct);
      return launchWsb(mode, () => runViaScheduledTask({
        sysRoot: sysRoot(), nodePath: process.execPath, childScript: fileURLToPath(new URL("./windows-task-child.js", import.meta.url)), baseDir: base,
        randomHex: (n) => randomBytes(Math.ceil(n / 2)).toString("hex").slice(0, n),
        mkdirp: (p) => { mkdirSync(win32.dirname(p), { recursive: true }); mkdirSync(p); },
        exists: (p) => existsSync(p),
        readText: (p) => { try { return readFileSync(p, "utf8"); } catch { return undefined; } },
        writeText: (p, text) => { writeFileSync(p, text); },
        remove: (p) => { rmSync(p, { recursive: true, force: true }); },
        rename: (from, to) => { renameSync(from, to); },
        privateProblem: (d) => recordDirProblem(host, d, "the private folder"),
        run: (f, a, o) => run(f, a, o),
      }, { file, args, ...(options.cwd === undefined ? {} : { cwd: options.cwd }), timeoutMs: options.timeoutMs }), direct);
    },
    async localGroupMembers(group) {
      if (!/^[A-Za-z0-9_]{1,64}$/.test(group)) return undefined;
      try {
        const raw = await powershell<unknown>(GROUP_SCRIPT, { NN_GROUP: group }, { timeoutMs: SERVER_PROBE_TIMEOUT_MS });
        const list = Array.isArray(raw) ? raw : raw === null ? [] : [raw];
        return list.every((m) => typeof m === "string") ? (list as string[]) : undefined;
      } catch { return undefined; }
    },
  };
  return host;
}
