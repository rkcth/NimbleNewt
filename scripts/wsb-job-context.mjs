// Own-hardware diagnostic (card wsb-console, 2026-11-21): what the Windows Sandbox job's own process looks like, recorded before its first `wsb` call. Every `wsb` call made by
// the job's node process ends after about 30 s with a gRPC timeout to localhost:80 and "Cancelled", while the same call made by node from the owner's administrator PowerShell
// window answers (also with windowsHide, detached and piped output). This records the facts that could differ between the two, and decides nothing:
//   - the account kind and whether it is the console user, and the token's integrity level and Administrators membership (`whoami /user` and `whoami /groups`, read by SID);
//   - this process's session id and the console's session id, and whether the console session is locked;
//   - whether this process has a console (a helper leaves its own console and tries to attach to this process's), and whether std streams are terminals;
//   - whether this process is in a job object, and the job's limit and UI-restriction flags (read by the helper, which is in the same job unless it broke away);
//   - the parent chain as fixed labels (a Windows service's process marked), and whether the runner's own service is among them;
//   - the window station and desktop names (the helper's, inherited from this process);
//   - the NAMES of the environment variables (never their values);
//   - one `wsb list` with a short limit: outcome, duration, and fixed markers of its error output.
//   node scripts/wsb-job-context.mjs
// Output: lines starting "wsb job context: ", fixed words, numbers and names checked against a strict pattern, each line passed through the shared credential scanner
// (scripts/safe-error.mjs); the workflow also pipes it through scripts/redact-log.mjs. It always exits 0: a record, never a gate. Off Windows it says so. Needs `npm run build`.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { safeMessage } from "./safe-error.mjs";

export const PREFIX = "wsb job context: ";
/** The `wsb list` limit: the failure seen so far ends after about 30 s, so 45 s shows how it ends without waiting for the tests' 120 s. */
export const WSB_LIST_TIMEOUT_MS = 45_000;
export const PROBE_TIMEOUT_MS = 60_000;
export const WHOAMI_TIMEOUT_MS = 20_000;

/** Mandatory label SIDs (locale independent; the label's name in `whoami` output is translated). */
const INTEGRITY = new Map([["S-1-16-0", "untrusted"], ["S-1-16-4096", "low"], ["S-1-16-8192", "medium"], ["S-1-16-8448", "medium plus"], ["S-1-16-12288", "high"], ["S-1-16-16384", "system"], ["S-1-16-20480", "protected"]]);
const ADMINISTRATORS = "S-1-5-32-544";

/** One CSV line as `whoami /fo csv` writes it (every field quoted, quotes doubled). */
export function csvFields(line) {
  const out = [];
  const re = /"((?:[^"]|"")*)"|([^,]*)/y;
  let i = 0;
  while (i <= line.length) {
    re.lastIndex = i;
    const m = re.exec(line);
    if (m === null) break;
    out.push(m[1] !== undefined ? m[1].replace(/""/g, '"') : m[2]);
    i = re.lastIndex;
    if (line[i] !== ",") break;
    i++;
  }
  return out;
}

/** `whoami /groups /fo csv /nh`: the integrity level (by the label's SID) and how the Administrators group is held (enabled, deny only, absent). */
export function parseGroups(text) {
  let integrity = "unknown";
  let admin = "absent";
  let rows = 0;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const f = csvFields(line.trim());
    if (f.length < 4) continue;
    rows++;
    const sid = f[2].trim().toUpperCase();
    if (INTEGRITY.has(sid)) integrity = INTEGRITY.get(sid);
    if (sid === ADMINISTRATORS) {
      const attrs = f[3].toLowerCase();
      admin = attrs.includes("deny only") ? "deny only" : attrs.includes("enabled group") ? "enabled" : "present (attributes not read)";
    }
  }
  return rows === 0 ? { integrity: "unknown", admin: "unknown" } : { integrity, admin };
}

/** `whoami /user /fo csv /nh`: the kind of account by its SID (the name and SID are never printed). */
export function parseUser(text) {
  const line = String(text ?? "").split(/\r?\n/).find((l) => l.trim() !== "");
  if (line === undefined) return "unknown";
  const sid = (csvFields(line.trim())[1] ?? "").trim().toUpperCase();
  if (sid === "S-1-5-18") return "local system";
  if (sid === "S-1-5-19") return "local service";
  if (sid === "S-1-5-20") return "network service";
  if (/^S-1-5-21-\d+-\d+-\d+-\d+$/.test(sid)) return "a local or domain account";
  if (/^S-1-12-1-/.test(sid)) return "an Azure AD account";
  if (/^S-1-5-80-/.test(sid)) return "a virtual service account";
  return /^S-1-/.test(sid) ? "another kind of account" : "unknown";
}

/** An environment variable name printed as it is: letters, digits and the punctuation Windows names use (`ProgramFiles(x86)`). Anything else is only counted. */
const SAFE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_.()-]{0,63}$/;
/** The environment variable names (never values), sorted and without case duplicates, a few per line so one withheld line does not hide the rest. */
export function envNameLines(names, perLine = 12) {
  const seen = new Map();
  let other = 0;
  for (const n of names) {
    if (!SAFE_ENV_NAME.test(n)) { other++; continue; }
    const k = n.toUpperCase();
    if (!seen.has(k)) seen.set(k, n);
  }
  const sorted = [...seen.values()].sort((a, b) => a.toUpperCase().localeCompare(b.toUpperCase()));
  const lines = [`environment: ${sorted.length} variable names${other > 0 ? `, ${other} other names not shown` : ""} (names only, never values)`];
  for (let i = 0; i < sorted.length; i += perLine) lines.push(`environment names: ${sorted.slice(i, i + perLine).join(" ")}`);
  return lines;
}

/** Process names shown in the parent chain; every other process is "other". Each label is letters only (an account named `runner` or `node` must not redact it away). */
const CHAIN = new Map([
  ["node.exe", "nodeExe"], ["bash.exe", "bashExe"], ["sh.exe", "shExe"], ["cmd.exe", "cmdExe"], ["powershell.exe", "powershellExe"], ["pwsh.exe", "pwshExe"],
  ["runner.worker.exe", "RunnerWorkerExe"], ["runner.listener.exe", "RunnerListenerExe"], ["runnerservice.exe", "RunnerServiceExe"], ["services.exe", "servicesExe"],
  ["svchost.exe", "svchostExe"], ["explorer.exe", "explorerExe"], ["conhost.exe", "conhostExe"], ["openconsole.exe", "OpenConsoleExe"], ["windowsterminal.exe", "WindowsTerminalExe"],
  ["wininit.exe", "wininitExe"], ["winlogon.exe", "winlogonExe"], ["userinit.exe", "userinitExe"],
]);
export const chainLabel = (name) => (typeof name === "string" ? CHAIN.get(name.toLowerCase()) : undefined) ?? "other";

const WINDOW_OBJECT_NAME = /^[A-Za-z0-9_$-]{1,64}$/;
const word = (v) => (v === true ? "yes" : v === false ? "no" : "unknown");
const num = (v) => (Number.isInteger(v) && v >= 0 && v <= 0xffffffff ? String(v) : "unknown");
const hex = (v) => (Number.isInteger(v) && v >= 0 && v <= 0xffffffff ? `0x${v.toString(16).padStart(8, "0")}` : "unknown");

/** The helper's answer (JSON from PROBE_SCRIPT) as fixed words; anything not in the expected form is "unknown". */
export function probeLines(raw) {
  const o = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const attach = o.attachError === 0 ? "yes" : o.attachError === 6 ? "no" : Number.isInteger(o.attachError) ? `unknown (error ${num(o.attachError)})` : "unknown";
  // Windows PowerShell 5.1's ConvertTo-Json can write an array as {"value": [...], "Count": n}; both forms are read.
  const list = Array.isArray(o.chain) ? o.chain : o.chain !== null && typeof o.chain === "object" && Array.isArray(o.chain.value) ? o.chain.value : [];
  const chain = list.slice(0, 16).map((p) => `${chainLabel(p?.name)}${p?.service === true ? "(service)" : ""}`);
  // RunnerService.exe is the runner installed as a Windows service. A "(service)" mark alone does not say that: a task started by Task Scheduler (a way to run the runner
  // interactively at logon) has the Schedule service's svchost as its parent.
  const underRunnerService = list.length > 0 ? list.some((p) => chainLabel(p?.name) === "RunnerServiceExe") : undefined;
  const station = typeof o.windowStation === "string" && WINDOW_OBJECT_NAME.test(o.windowStation) ? o.windowStation : o.windowStation === undefined || o.windowStation === null ? "unknown" : "other";
  const desktop = typeof o.desktop === "string" && WINDOW_OBJECT_NAME.test(o.desktop) ? o.desktop : o.desktop === undefined || o.desktop === null ? "unknown" : "other";
  const job = o.inJob === true
    ? `yes, limit flags ${hex(o.jobLimitFlags)}, UI restrictions ${hex(o.jobUiRestrictions)} (read by the helper in the same job)`
    : o.inJob === false ? "no" : "unknown";
  return [
    `session: this process ${num(o.processSession)}, console session ${consoleSessionWord(o.consoleSession)}`,
    `console: this process has a console ${attach}; the helper (started by this process with windowsHide) got a console window ${word(o.helperConsoleWindow)}`,
    `job object: this process in a job ${job}`,
    `parents (this process first): ${chain.length > 0 ? chain.join(" < ") : "unknown"}; the runner's Windows service (RunnerServiceExe) among them ${word(underRunnerService)}`,
    `window station ${station}, desktop ${desktop} (the helper's, inherited from this process)`,
  ];
}

/** Fixed markers looked for in `wsb`'s output (its words are not copied, apart from the cleaned first line below). */
const MARKERS = [["grpc", /grpc/i], ["localhost:80", /localhost:80\b/i], ["deadline", /deadline/i], ["cancelled", /cancel/i], ["access denied", /access is denied|0x80070005|E_ACCESSDENIED/i], ["timed out", /timed? ?out/i]];

/** One `wsb list` call's outcome as fixed words, the markers seen, and its error output's first line cleaned and cut. */
export function wsbListLine(r, timeoutMs = WSB_LIST_TIMEOUT_MS) {
  const ms = Number.isFinite(r?.durationMs) ? Math.round(r.durationMs) : -1;
  const code = r?.error?.code;
  let outcome;
  if (code === "ENOENT") outcome = "not found on PATH";
  else if (code === "ETIMEDOUT" || (r?.status === null && r?.signal !== null && r?.signal !== undefined && ms >= timeoutMs - 50)) outcome = `no answer within ${timeoutMs} ms (stopped)`;
  else if (r?.error !== undefined && r?.error !== null) outcome = "could not run";
  else if (r?.status === 0) outcome = "answered (exit 0)";
  else if (Number.isInteger(r?.status)) outcome = `failed (exit ${hex(r.status)})`;
  else outcome = r?.signal ? "stopped by a signal" : "unknown";
  const out = String(r?.stdout ?? "");
  const err = String(r?.stderr ?? "");
  const lines = out.split(/\r?\n/).filter((l) => l.trim() !== "").length;
  const markers = MARKERS.filter(([, re]) => re.test(`${out}\n${err}`)).map(([m]) => m);
  const first = err.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "") ?? "";
  // Control characters out, then the credential scanner (which also cuts); the workflow redacts personal names after this.
  const message = first === "" ? "none" : safeMessage(first.replace(/[\u0000-\u001f\u007f]/g, " "), 160);
  return `wsb list (once, limit ${timeoutMs} ms): ${outcome} after ${ms < 0 ? "unknown" : ms} ms; output lines ${lines}; markers: ${markers.length > 0 ? markers.join(", ") : "none"}; first error line: ${message}`;
}

/** Every line for the log: the fixed prefix, and the credential scanner once more over the whole line (a line it changes is printed as changed). */
export function render(lines) {
  return lines.map((l) => `${PREFIX}${safeMessage(l, 1000)}`);
}

// The helper. One Windows PowerShell with one C# class; everything it reports about consoles happens inside one call (no PowerShell output while consoles change), and the
// answer goes to the file in NN_OUT, not to the standard output. NN_PID is this node process.
export const PROBE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class NNJobCtx {
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ProcessIdToSessionId(uint pid, out uint session);
  [DllImport("kernel32.dll")] static extern uint WTSGetActiveConsoleSessionId();
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr proc, IntPtr job, out bool result);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int cls, IntPtr info, uint len, IntPtr ret);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr GetThreadDesktop(uint tid);
  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr h, int index, StringBuilder info, uint len, out uint needed);
  static string Name(IntPtr h) { if (h == IntPtr.Zero) return null; var sb = new StringBuilder(256); uint n; return GetUserObjectInformation(h, 2, sb, 512, out n) ? sb.ToString() : null; }
  public static long[] Numbers(uint pid) {
    long helperWindow = GetConsoleWindow() != IntPtr.Zero ? 1 : 0;
    FreeConsole();
    long attachError = AttachConsole(pid) ? 0 : Marshal.GetLastWin32Error();
    if (attachError == 0) FreeConsole();
    uint ps; long processSession = ProcessIdToSessionId(pid, out ps) ? (long)ps : -1L;
    long consoleSession = WTSGetActiveConsoleSessionId();
    long inJob = -1;
    IntPtr h = OpenProcess(0x1000, false, pid);
    if (h != IntPtr.Zero) { bool r; if (IsProcessInJob(h, IntPtr.Zero, out r)) inJob = r ? 1 : 0; CloseHandle(h); }
    long limits = -1, ui = -1;
    int size = IntPtr.Size == 8 ? 64 : 48;
    IntPtr buf = Marshal.AllocHGlobal(size);
    try {
      if (QueryInformationJobObject(IntPtr.Zero, 2, buf, (uint)size, IntPtr.Zero)) limits = (uint)Marshal.ReadInt32(buf, 16);
      if (QueryInformationJobObject(IntPtr.Zero, 4, buf, 4, IntPtr.Zero)) ui = (uint)Marshal.ReadInt32(buf, 0);
    } finally { Marshal.FreeHGlobal(buf); }
    return new long[] { helperWindow, attachError, processSession, consoleSession, inJob, limits, ui };
  }
  public static string Station() { return Name(GetProcessWindowStation()); }
  public static string Desktop() { return Name(GetThreadDesktop(GetCurrentThreadId())); }
}
'@
$nodePid = [uint32]$env:NN_PID
$n = [NNJobCtx]::Numbers($nodePid)
# The parent chain and services; if either cannot be read the chain is left out (unknown), the other facts are still written.
try {
$procs = @{}
foreach ($p in (Get-CimInstance Win32_Process)) { $procs[[uint32]$p.ProcessId] = $p }
$services = @{}
foreach ($s in (Get-CimInstance Win32_Service -Filter 'ProcessId <> 0')) { $services[[uint32]$s.ProcessId] = $true }
$chain = @()
$cur = $nodePid
$seen = @{}
while ($procs.ContainsKey($cur) -and -not $seen.ContainsKey($cur) -and $chain.Count -lt 16) {
  $seen[$cur] = $true
  $x = $procs[$cur]
  $chain += [ordered]@{ name = [string]$x.Name; service = $services.ContainsKey($cur) }
  $parent = [uint32]$x.ParentProcessId
  # A parent id reused by a newer process is not this process's parent.
  if ($procs.ContainsKey($parent) -and $procs[$parent].CreationDate -gt $x.CreationDate) { break }
  $cur = $parent
}
} catch { $chain = $null }
function Opt([long]$v) { if ($v -lt 0) { $null } else { $v } }
function Flag([long]$v) { if ($v -lt 0) { $null } else { $v -eq 1 } }
$o = [ordered]@{
  helperConsoleWindow = ($n[0] -eq 1); attachError = $n[1]; processSession = (Opt $n[2]); consoleSession = (Opt $n[3]); inJob = (Flag $n[4])
  jobLimitFlags = (Opt $n[5]); jobUiRestrictions = (Opt $n[6]); windowStation = [NNJobCtx]::Station(); desktop = [NNJobCtx]::Desktop(); chain = $chain
}
[System.IO.File]::WriteAllText($env:NN_OUT, (ConvertTo-Json -Compress -Depth 4 -InputObject $o))
`;

/** The whole run's limit, below the step's 5 minutes: what was recorded by then is printed, with a line saying the rest was not. */
export const OVERALL_LIMIT_MS = 240_000;
/** How long the console-user probe (started first, in parallel) may still take once the helper is done, before `wsb list` runs without it. */
export const SESSION_WAIT_MS = 30_000;

/** The suffix the backend's bounded runner appends to the error output of a program it stopped (windows-real.ts `runBounded`); not `wsb`'s own words, so not a marker. */
const STOPPED_SUFFIX = /timed out after \d+ s and was stopped$/;
/** A result of the backend's bounded runner (code, stdout, stderr, timedOut) in the form `wsbListLine` reads. */
export function fromBounded(r, durationMs) {
  const stderr = String(r?.stderr ?? "");
  const timedOut = r?.timedOut === true;
  const error = timedOut ? { code: "ETIMEDOUT" } : r?.code === null && /\bENOENT\b/.test(stderr) ? { code: "ENOENT" } : r?.code === null ? { code: "other" } : undefined;
  return { status: r?.code ?? null, signal: null, error, stdout: r?.stdout, stderr: timedOut ? stderr.replace(STOPPED_SUFFIX, "") : stderr, durationMs };
}

/** The console session id as words: 0xFFFFFFFF is what Windows gives while no session is attached to the console. */
const consoleSessionWord = (v) => (v === 0xffffffff ? "none attached" : num(v));

/** The backend's real Windows host (the built worker package). */
async function realHost() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  return (await import(pathToFileURL(join(root, "packages", "worker", "dist", "index.js")).href)).windowsRealHost();
}

/** The Windows facts, pushed to `lines` as each is read (the overall limit prints what is there). `state.console` holds the console-user line until it is pushed. */
export async function windowsLines(lines, state, loadHost = realHost) {
  const sys = process.env["SystemRoot"] ?? "C:\\Windows";
  // The backend's own bounded runner: at its limit the program's whole tree is stopped (taskkill /T /F) and its pipes closed, so a descendant holding them cannot keep this waiting.
  let host;
  try {
    host = await loadHost();
  } catch {
    lines.push("not recorded: the worker build could not be loaded (run npm run build first)");
    return;
  }
  const run = (file, args, timeoutMs, env) => host.run(file, args, { timeoutMs, ...(env === undefined ? {} : { env }) });

  // Who: the console-user facts come from the backend's own session probe, started now beside the rest and awaited (for a short while) before `wsb list`.
  state.console = "console user: not read within the limit";
  const session = host.session().then(
    (s) => { state.console = `console user: is the console user ${word(s.processIsConsoleUser)}; in the console session ${word(s.processInConsoleSession)}; someone signed in at the console ${word(typeof s.consoleUser === "string")}; console locked ${word(s.locked)}`; },
    () => { state.console = "console user: not readable"; },
  );
  const [user, groups] = await Promise.all([
    run(`${sys}\\System32\\whoami.exe`, ["/user", "/fo", "csv", "/nh"], WHOAMI_TIMEOUT_MS),
    run(`${sys}\\System32\\whoami.exe`, ["/groups", "/fo", "csv", "/nh"], WHOAMI_TIMEOUT_MS),
  ]);
  const g = parseGroups(groups.stdout);
  lines.push(`account: ${parseUser(user.stdout)}`);
  lines.push(`integrity level ${g.integrity} (whoami /groups label); Administrators ${g.admin}`);

  // The helper: session, console, job, parents, window station and desktop.
  const dir = mkdtempSync(join(tmpdir(), "nn-jobctx-"));
  try {
    const out = join(dir, "probe.json");
    const started = Date.now();
    const r = await run(`${sys}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", PROBE_SCRIPT], PROBE_TIMEOUT_MS, { NN_PID: String(process.pid), NN_OUT: out });
    let raw = null;
    try { raw = JSON.parse(readFileSync(out, "utf8").replace(/^\uFEFF/, "")); } catch { /* no answer: every fact unknown */ }
    lines.push(...probeLines(raw));
    if (raw === null) lines.push(`helper: no answer (exit ${r.code === null ? "none" : hex(r.code)}${r.timedOut ? ", stopped after the limit" : ""}, ${Date.now() - started} ms)`);
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* left */ } }

  let wait;
  await Promise.race([session, new Promise((r) => { wait = setTimeout(r, SESSION_WAIT_MS); })]);
  clearTimeout(wait);
  lines.push(state.console);
  state.console = undefined;

  // One `wsb list`, as the owner ran it by hand (node, `wsb` from PATH, windowsHide, piped output), with this job's environment.
  const started = performance.now();
  const w = await run("wsb", ["list"], WSB_LIST_TIMEOUT_MS);
  lines.push(wsbListLine(fromBounded(w, performance.now() - started)));
}

async function main() {
  const terminal = `terminals: stdin ${word(process.stdin.isTTY === true)}, stdout ${word(process.stdout.isTTY === true)}, stderr ${word(process.stderr.isTTY === true)}`;
  const lines = [];
  const state = {};
  let printed = false;
  // Printed once: at the end, or at the overall limit with what was recorded by then. Exits 0 after the output is written.
  const finish = (extra) => {
    if (printed) return;
    printed = true;
    const all = [...lines, ...extra, ...envNameLines(Object.keys(process.env))];
    process.stdout.write(render(all).map((l) => `${l}\n`).join(""), () => process.exit(0));
  };
  if (process.platform !== "win32") {
    lines.push(`not Windows; ${terminal}`);
  } else {
    lines.push(terminal);
    setTimeout(() => {
      finish([...(state.console === undefined ? [] : [state.console]), `stopped at the overall limit of ${OVERALL_LIMIT_MS} ms: the facts after this line were not recorded`]);
    }, OVERALL_LIMIT_MS);
    try { await windowsLines(lines, state); } catch { lines.push("stopped early: an unexpected error (not shown)"); }
  }
  finish([]);
}

const same = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
if (process.argv[1] !== undefined && same(resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
  try { await main(); } catch { process.stdout.write(`${PREFIX}stopped early: an unexpected error (not shown)\n`, () => process.exit(0)); }
}
