// Own-hardware diagnostic (card wsb-variants, 2026-11-22), run by the same workflow step right after scripts/wsb-job-context.mjs: the job's `wsb list` ends after about 30 s with
// a gRPC timeout to localhost:80, while the same command answers from the owner's elevated PowerShell window (also with stdin from NUL and its output in a file). The job's
// process is in a Windows job object, so this tries `wsb list` once in each of six other ways and records how each ended, to compare them. It decides nothing.
//   1. nodeDetached       node spawn with detached (libuv leaves it out of its kill-on-close job; new process group, no console) and windowsHide false;
//   2. cmdNulFile         cmd.exe /c wsb list, stdin from NUL, output and errors to temporary files;
//   3. powershellCommand  powershell.exe -NoProfile -Command wsb list;
//   4. newConsole         cmd.exe /c start "" /wait <a temporary .cmd file>: wsb runs in a new console of its own (stdin from NUL, output to temporary files);
//   5. scheduledTask      a one-shot scheduled task as this user (interactive, run level Limited, the minimum: the VERDICT-BEARING variant, the level the product's launcher uses), started by the Task Scheduler service and so outside this job's process
//                         tree and job objects (it also writes wsb's own exit code to a file, so that "no output" is told from a silent failure), then removed (by the helper, and checked and removed again here; a missed removal is also deleted by Task Scheduler itself
//                         ten minutes later: the task's only trigger lies in the past and expires then). It runs after the plain variants because its clean-up needs time of its own.
//   6. scheduledTaskHighest  the same task registered at run level Highest, kept FOR COMPARISON ONLY (on the owner's PC a Highest task failed after about 31 s where a Limited one
//                         answered in 1.3 s; no cause is claimed). Same exit-code-file verdict, same clean-up; the product does not use it.
// Every variant is tried once with a hard limit of 45 s (at the limit its process tree is stopped with taskkill /T /F); all are tried, whatever the earlier ones gave, and the
// whole run stays under 460 s (a variant that no longer fits is not started and says so). For each: exit code, elapsed ms, whether output and error text appeared, fixed
// markers, and the first error line through the shared credential scanner. Fixed words only, each line through the scanner again; the workflow also pipes it through
// scripts/redact-log.mjs. It always exits 0. Off Windows it says so and tries nothing.
//   node scripts/wsb-launch-variants.mjs
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { safeMessage } from "./safe-error.mjs";
import { describeRun, WSB_LIST_TIMEOUT_MS } from "./wsb-job-context.mjs";

export const PREFIX = "wsb launch variants: ";
/** Each variant's own limit (the same as the job-context script's single `wsb list`). */
export const VARIANT_TIMEOUT_MS = WSB_LIST_TIMEOUT_MS;
/**
 * The whole run. Worst case, the four plain variants take 4 x (45 s + 15 s stop) and each of the two task variants 45 s plus its reserve (64 s), 458 s in all; so every variant
 * can be tried even when each one runs to its limit. The workflow step's limit (15 minutes) covers the context script's 240 s, this, and a minute for starting node.
 */
export const TOTAL_LIMIT_MS = 460_000;
/** At a variant's limit: taskkill's own limit, then a short wait for the pipes to close before the result is given anyway; STOP_MS is the most both can take. */
export const KILL_MS = 10_000;
export const CLOSE_GRACE_MS = 5_000;
export const STOP_MS = KILL_MS + CLOSE_GRACE_MS;
/** A variant with less than this left is not started (a shorter try says little about a failure that takes about 30 s). */
export const MIN_VARIANT_MS = 15_000;
/** The scheduled-task helper's time besides the `wsb` run: registering, starting, stopping and removing the task. */
export const TASK_OVERHEAD_MS = 25_000;
/** Each schtasks call of the check afterwards (query, delete, query). */
export const TASK_CHECK_MS = 8_000;
/** The time the scheduled task needs besides its `wsb` run: the helper's overhead, its stop, and the three checks. */
export const TASK_RESERVE_MS = TASK_OVERHEAD_MS + STOP_MS + 3 * TASK_CHECK_MS;
/** Output read back from a temporary file or a pipe: at most this many bytes. */
const OUTPUT_CAP = 64 * 1024;

export const ORDER = ["nodeDetached", "cmdNulFile", "powershellCommand", "newConsole", "scheduledTask", "scheduledTaskHighest"];
/** The variants that register a scheduled task, with the run level each uses; the first is the verdict-bearing one. */
export const TASK_LEVELS = { scheduledTask: "Limited", scheduledTaskHighest: "Highest" };
const WHAT = {
  nodeDetached: "node spawn detached, windowsHide false",
  cmdNulFile: "cmd.exe /c, stdin NUL, output to files",
  powershellCommand: "powershell.exe -NoProfile -Command",
  newConsole: "cmd.exe /c start /wait, a new console",
  scheduledTask: "a one-shot scheduled task, run level Limited, verdict-bearing, removed afterwards",
  scheduledTaskHighest: "a one-shot scheduled task, run level Highest, for comparison only, removed afterwards",
};

/** cmd.exe's command for variant 2; the file names come from the environment so the command is fixed text (cmd expands them, inside quotes). */
export const CMD_NUL_FILE = '/d /v:off /s /c "wsb list <NUL >"%NN_WSB_OUT%" 2>"%NN_WSB_ERR%""';
/** Variant 4: cmd.exe starts the batch file in a new console and waits; `start /wait` gives the batch's exit code back. */
export const CMD_NEW_CONSOLE = '/d /v:off /s /c "start "" /wait "%NN_WSB_BATCH%""';
/** The batch file variant 4 runs in its new console. */
export const NEW_CONSOLE_BATCH = '@wsb list <NUL >"%NN_WSB_OUT%" 2>"%NN_WSB_ERR%"\r\n@exit %ERRORLEVEL%\r\n';

// The scheduled-task helper. Fixed text; it reads NN_TASK (a name made here), NN_WSB_OUT, NN_WSB_ERR, NN_LIMIT_MS and SystemRoot, and writes its answer (numbers and
// booleans) only to the file in NN_OUT. The task runs cmd.exe like variant 2. Its trigger started a minute ago (a Once trigger in the past does not run by itself) and expires
// in ten minutes, after which Task Scheduler deletes the task (DeleteExpiredTaskAfter PT0S): a safety net if neither removal below runs.
export const taskScript = (level) => String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$r = [ordered]@{ registered = $false; started = $false; finished = $false; result = $null; elapsedMs = $null; stopped = $false; removed = $false; error = $null }
$name = $env:NN_TASK
$limit = [int64]$env:NN_LIMIT_MS
$mask = [int64]4294967295
try {
  # The task runs a batch file that writes wsb's own exit code to a file (NN_WSB_CODE), so that "answered with no output" can be told from "did not run": an empty list is the right
  # answer when no sandbox is running, and only an exit code of 0 in that file says it was one. The batch file's lines are expanded one at a time, so %ERRORLEVEL% is wsb's.
  $nl = [Environment]::NewLine
  $bat = $env:NN_WSB_BATCH
  [System.IO.File]::WriteAllText($bat, '@wsb list <NUL >"' + $env:NN_WSB_OUT + '" 2>"' + $env:NN_WSB_ERR + '"' + $nl + '@>"' + $env:NN_WSB_CODE + '" echo %ERRORLEVEL%' + $nl + '@exit %ERRORLEVEL%' + $nl)
  $arg = '/d /v:off /s /c ""' + $bat + '""'
  $action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\cmd.exe') -Argument $arg
  $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel ${level}
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(-1)
  $trigger.EndBoundary = (Get-Date).AddMinutes(10).ToString('s')
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  $settings.DeleteExpiredTaskAfter = 'PT0S'
  Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Trigger $trigger -Settings $settings | Out-Null
  $r.registered = $true
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  Start-ScheduledTask -TaskName $name
  $r.started = $true
  # 267011 (0x41303): not run yet; 267009 (0x41301): running. Anything else, once the task is no longer running, is cmd's exit code, which is wsb's.
  while ($sw.ElapsedMilliseconds -lt $limit) {
    $code = ([int64](Get-ScheduledTaskInfo -TaskName $name).LastTaskResult) -band $mask
    if ($code -ne 267011 -and $code -ne 267009 -and (Get-ScheduledTask -TaskName $name).State -ne 'Running') { $r.finished = $true; $r.result = $code; break }
    Start-Sleep -Milliseconds 200
  }
  $r.elapsedMs = $sw.ElapsedMilliseconds
  if (-not $r.finished) { $r.stopped = $true; Stop-ScheduledTask -TaskName $name }
} catch {
  $r.error = ([int64]$_.Exception.HResult) -band $mask
} finally {
  if ($r.registered) { try { Unregister-ScheduledTask -TaskName $name -Confirm:$false; $r.removed = $true } catch { } }
  [System.IO.File]::WriteAllText($env:NN_OUT, (ConvertTo-Json -Compress -InputObject $r))
}
`;
/** The helper for the verdict-bearing variant (run level Limited) and the one kept for comparison (Highest); they differ in that one word only. */
export const TASK_SCRIPT = taskScript(TASK_LEVELS.scheduledTask);
export const TASK_SCRIPT_HIGHEST = taskScript(TASK_LEVELS.scheduledTaskHighest);

const hex = (v) => (Number.isInteger(v) && v >= 0 && v <= 0xffffffff ? `0x${v.toString(16).padStart(8, "0")}` : "unknown");
const word = (v) => (v === true ? "yes" : v === false ? "no" : "unknown");

/**
 * The real launcher: one program with a hard limit. At the limit its tree is stopped (taskkill /T /F, while the program is still alive so the id is still its own), then the
 * program and its pipes; if that brings no end within STOP_MS in all the result is given anyway. Result: { status, signal, error, stdout, stderr, durationMs } as `describeRun` reads it.
 */
export function realLaunch({ file, args, env = {}, detached = false, windowsHide = true, verbatim = false, timeoutMs }) {
  return new Promise((done) => {
    const started = performance.now();
    let out = "";
    let err = "";
    let finished = false;
    let timedOut = false;
    let last;
    const finish = (r) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (last !== undefined) clearTimeout(last);
      done({ stdout: out, stderr: err, signal: null, ...r, ...(timedOut ? { status: null, error: { code: "ETIMEDOUT" } } : {}), durationMs: performance.now() - started });
    };
    let child;
    try {
      child = spawn(file, args, { env: { ...process.env, ...env }, detached, windowsHide, windowsVerbatimArguments: verbatim, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      done({ status: null, signal: null, error: { code: typeof e?.code === "string" ? e.code : "other" }, stdout: "", stderr: "", durationMs: performance.now() - started });
      return;
    }
    child.stdout.on("data", (d) => { if (out.length < OUTPUT_CAP) out += String(d); });
    child.stderr.on("data", (d) => { if (err.length < OUTPUT_CAP) err += String(d); });
    child.on("error", (e) => finish({ status: null, error: { code: typeof e?.code === "string" ? e.code : "other" } }));
    child.on("close", (status, signal) => finish({ status, signal }));
    const timer = setTimeout(() => {
      timedOut = true;
      const live = child.pid !== undefined && child.exitCode === null && child.signalCode === null;
      const stopTree = live && process.platform === "win32"
        ? new Promise((r) => {
          const sys = process.env["SystemRoot"] ?? "C:\\Windows";
          try { const k = spawn(`${sys}\\System32\\taskkill.exe`, ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); const t = setTimeout(r, KILL_MS); k.on("error", r); k.on("close", () => { clearTimeout(t); r(); }); } catch { r(); }
        })
        : Promise.resolve();
      void stopTree.then(() => {
        try { child.kill(); } catch { /* already gone */ }
        child.stdout.destroy();
        child.stderr.destroy();
        if (!finished) last = setTimeout(() => finish({}), CLOSE_GRACE_MS);
      });
    }, timeoutMs);
  });
}

/** The exit code the scheduled task's batch file wrote (a whole number), or undefined when the file is missing or not a plain number: then the run is not counted as answered. */
export function readCodeFile(path) {
  let text = "";
  try { text = readFileSync(path, "utf8").replace(/^\uFEFF/, "").trim(); } catch { return undefined; }
  return /^\d{1,10}$/.test(text) && Number(text) <= 0xffffffff ? Number(text) : undefined;
}

const readCapped = (path) => { try { return readFileSync(path, "utf8").slice(0, OUTPUT_CAP); } catch { return ""; } };

/** One variant's line: the outcome as the job-context script words it, whether output and error text appeared, the markers and the cleaned first error line. */
export function variantLine(position, name, r, timeoutMs, extra = "") {
  const d = describeRun(r, timeoutMs);
  const outText = String(r?.stdout ?? "").trim() !== "";
  const errText = String(r?.stderr ?? "").trim() !== "";
  return `${position}. ${name} (${WHAT[name]}; limit ${timeoutMs} ms): ${d.outcome} after ${d.ms} ms; output text ${word(outText)} (lines ${d.lines}); error text ${word(errText)}; markers: ${d.markers}; first error line: ${d.message}${extra}`;
}

/**
 * What a scheduled-task run proves, in fixed words. Only an exit code of 0 read from the file the task's own batch wrote is a success (an empty list is then the correct answer
 * when no sandbox is running); an exit code that differs from the task's own result is said; a finished task with no code file is a silent failure, not an answer.
 */
export function taskVerdict(r) {
  if (r.noCodeFile === true) return "verdict: NOT an answer (the task ended but wrote no exit code)";
  if (r.status === null || r.status === undefined) return "verdict: no answer (did not end in time or could not be read)";
  const same = r.taskResult === undefined || r.taskResult === r.status ? "" : `; the task's own result ${hex(r.taskResult)} differs`;
  const out = String(r.stdout ?? "").trim() !== "";
  return r.status === 0
    ? `verdict: SUCCESS, exit code 0 read from the code file (${out ? "a list was printed" : "the list is empty, which is the right answer when no sandbox is running"})${same}`
    : `verdict: FAILED, exit code ${hex(r.status)} read from the code file${same}`;
}

/** The scheduled-task helper's answer as a run result; anything not in the expected form leaves the outcome unknown. */
export function taskResult(raw, files) {
  const o = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const ms = Number.isInteger(o.elapsedMs) && o.elapsedMs >= 0 ? o.elapsedMs : undefined;
  const base = { signal: null, stdout: files.stdout, stderr: files.stderr, durationMs: ms };
  if (o.registered !== true) return { notRun: `the task could not be registered (error ${hex(o.error)})` };
  if (o.started !== true) return { notRun: `the task was registered but could not be started (error ${hex(o.error)})` };
  // The exit code file is the authority; the task's own result is only compared with it. A finished task with no code file says so instead of passing as an answer.
  if (o.finished === true && files.code === undefined) return { ...base, status: null, error: { code: "other" }, noCodeFile: true };
  if (o.finished === true && Number.isInteger(files.code)) return { ...base, status: files.code, taskResult: Number.isInteger(o.result) ? o.result : undefined };
  if (o.stopped === true) return { ...base, status: null, error: { code: "ETIMEDOUT" } };
  return { ...base, status: null, error: { code: "other" } };
}

/**
 * Every variant in ORDER, once each. `deps.launch` runs one program (the real launcher by default; tests pass a fake); `deps.now` is the clock for the overall limit;
 * `deps.taskName` makes the scheduled task's name. Returns the lines (without the prefix).
 */
export async function runVariants(deps = {}) {
  const launch = deps.launch ?? realLaunch;
  const now = deps.now ?? (() => performance.now());
  const sys = deps.systemRoot ?? process.env["SystemRoot"] ?? "C:\\Windows";
  const taskName = deps.taskName ?? (() => `NimbleNewtWsbProbe-${randomBytes(6).toString("hex")}`);
  const start = now();
  const left = () => TOTAL_LIMIT_MS - (now() - start);
  const lines = [`order tried: ${ORDER.map((n, i) => `${i + 1} ${n}`).join(", ")} (each once, limit ${VARIANT_TIMEOUT_MS} ms, all ${TOTAL_LIMIT_MS} ms)`];
  const dir = mkdtempSync(join(deps.tmp ?? tmpdir(), "nn-wsbvar-"));
  try {
    for (const [i, name] of ORDER.entries()) {
      const position = i + 1;
      const reserve = name in TASK_LEVELS ? TASK_RESERVE_MS : STOP_MS;
      const limit = Math.min(VARIANT_TIMEOUT_MS, Math.floor(left() - reserve));
      if (limit < MIN_VARIANT_MS) { lines.push(`${position}. ${name} (${WHAT[name]}): not started, too little of the overall limit left`); continue; }
      const files = { NN_WSB_OUT: join(dir, `${name}.out.txt`), NN_WSB_ERR: join(dir, `${name}.err.txt`) };
      const codeFile = join(dir, `${name}.code.txt`);
      const fromFiles = () => ({ stdout: readCapped(files.NN_WSB_OUT), stderr: readCapped(files.NN_WSB_ERR), code: readCodeFile(codeFile) });
      try {
        if (name === "nodeDetached") {
          lines.push(variantLine(position, name, await launch({ file: "wsb", args: ["list"], detached: true, windowsHide: false, timeoutMs: limit }), limit));
        } else if (name === "cmdNulFile") {
          const r = await launch({ file: `${sys}\\System32\\cmd.exe`, args: [CMD_NUL_FILE], verbatim: true, env: files, timeoutMs: limit });
          lines.push(variantLine(position, name, { ...r, ...fromFiles() }, limit));
        } else if (name === "powershellCommand") {
          lines.push(variantLine(position, name, await launch({ file: `${sys}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, args: ["-NoProfile", "-Command", "wsb list"], timeoutMs: limit }), limit));
        } else if (name === "newConsole") {
          const batch = join(dir, "new-console.cmd");
          writeFileSync(batch, NEW_CONSOLE_BATCH);
          const r = await launch({ file: `${sys}\\System32\\cmd.exe`, args: [CMD_NEW_CONSOLE], verbatim: true, windowsHide: false, env: { ...files, NN_WSB_BATCH: batch }, timeoutMs: limit });
          lines.push(variantLine(position, name, { ...r, ...fromFiles() }, limit));
        } else {
          lines.push(await scheduledTask(position, name, launch, sys, taskName(), dir, { ...files, NN_WSB_CODE: codeFile, NN_WSB_BATCH: join(dir, `${name}.task.cmd`) }, fromFiles, limit));
        }
      } catch {
        lines.push(`${position}. ${name} (${WHAT[name]}): could not be tried (an unexpected error, not shown)`);
      }
    }
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* left */ } }
  lines.push(`all variants: ${Math.round(now() - start)} ms`);
  return lines;
}

async function scheduledTask(position, label, launch, sys, name, dir, files, fromFiles, limit) {
  if (!/^NimbleNewtWsbProbe-[0-9a-f]{12}$/.test(name)) return `${position}. ${label} (${WHAT[label]}): not started, an unexpected task name`;
  // Each task variant has its own answer file: a helper that writes nothing (stopped at its limit, or powershell not started) must not be read as the earlier variant's answer.
  const answer = join(dir, `${label}.task.json`);
  const ps = `${sys}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const helper = await launch({ file: ps, args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", label === "scheduledTaskHighest" ? TASK_SCRIPT_HIGHEST : TASK_SCRIPT], env: { ...files, NN_TASK: name, NN_LIMIT_MS: String(limit), NN_OUT: answer }, timeoutMs: limit + TASK_OVERHEAD_MS });
  let raw = null;
  try { raw = JSON.parse(readCapped(answer).replace(/^\uFEFF/, "")); } catch { /* no answer */ }
  // Whatever the helper said, the task must be gone: query it, delete it if it is there, and query again. schtasks' exit code only (its words are translated).
  const schtasks = `${sys}\\System32\\schtasks.exe`;
  const exists = async () => { const q = await launch({ file: schtasks, args: ["/Query", "/TN", name], timeoutMs: TASK_CHECK_MS }); return q.status === 0 ? true : Number.isInteger(q.status) ? false : undefined; };
  let present = await exists();
  if (present !== false) { await launch({ file: schtasks, args: ["/Delete", "/TN", name, "/F"], timeoutMs: TASK_CHECK_MS }); present = await exists(); }
  const left = `; task left behind ${present === false ? "no" : present === true ? "yes (Task Scheduler deletes it when its trigger expires in ten minutes)" : "unknown"}`;
  if (raw === null) return `${position}. ${label} (${WHAT[label]}): no answer from the helper (exit ${Number.isInteger(helper?.status) ? hex(helper.status) : "none"}${helper?.error?.code === "ETIMEDOUT" ? ", stopped after its limit" : ""})${left}`;
  const r = taskResult(raw, fromFiles());
  if (r.notRun !== undefined) return `${position}. ${label} (${WHAT[label]}): not run: ${r.notRun}${left}`;
  return variantLine(position, label, r, limit, `; ${taskVerdict(r)}${left}`);
}

export const render = (lines) => lines.map((l) => `${PREFIX}${safeMessage(l, 1000)}`);

async function main() {
  const lines = process.platform !== "win32" ? ["not Windows; nothing tried"] : await runVariants().catch(() => ["stopped early: an unexpected error (not shown)"]);
  process.stdout.write(render(lines).map((l) => `${l}\n`).join(""), () => process.exit(0));
}

const same = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
if (process.argv[1] !== undefined && same(resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
  try { await main(); } catch { process.stdout.write(`${PREFIX}stopped early: an unexpected error (not shown)\n`, () => process.exit(0)); }
}
