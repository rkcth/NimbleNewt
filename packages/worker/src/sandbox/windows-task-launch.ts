import type { ProcessResult } from "./windows-host.js";

/**
 * How every `wsb` command is launched on Windows (card wsb-repair, 2026-11-24).
 *
 * Why: in the own-hardware job (run 45097817234) `wsb list` ended after about 30 s with a gRPC timeout to localhost:80 in every launch that stays under the job's own process
 * (node detached, cmd with files, powershell -Command, a new console), yet answered from the owner's own PowerShell window, and a one-shot scheduled task running in the signed-in
 * session answered in one second. So the command is run by such a task: Task Scheduler starts it, as the same user in the interactive session, outside the job's process tree.
 *
 * How: a private folder (made fresh for the call, checked to be changeable by nobody but this account) receives `in.json` (program, arguments, folder, limit). A fixed PowerShell
 * helper registers and starts a task that runs this program's own `windows-task-child.js` with the folder as its only argument; the child runs the command with an argument list
 * (no shell, so no quoting) and writes `started.txt` first, then `out.txt` and `err.txt`, and `code.txt` last: the exit code, as an unsigned number. The helper waits for
 * `code.txt` (or the end or the limit of the task), always removes the task, and answers in one JSON file. The folder is removed afterwards, whatever happened.
 *
 * Fallback to the direct call is allowed only when the command provably did not start: the helper could not register or start the task, or the task never began within a short
 * grace time, or the helper itself could not run, and in every such case `started.txt` is absent. Once the child has begun, the command is never run a second time here: not
 * retried, not replaced by a direct call. (`wsb list` may be called again by its caller, which asks for nothing that changes; start, exec and stop never are.)
 */

export const MODES = ["auto", "direct", "task"] as const;
export type LaunchMode = (typeof MODES)[number];
/** The environment variable that selects the strategy: `auto` (the default: the task, the direct call when nothing was started), `direct` (never the task) or `task` (never the direct call). */
export const MODE_VARIABLE = "NIMBLENEWT_WSB_LAUNCH";
/** The folder the private call folders are made in (default: the account's local application data folder). */
export const DIR_VARIABLE = "NIMBLENEWT_WSB_TASK_DIR";
/** How long the task may take to begin before it is stopped and the command counted as never started. */
export const START_GRACE_MS = 20_000;
/**
 * How much longer than the command's own limit the helper waits for `code.txt` before it stops the task. The child stops the command's whole process tree itself at the limit
 * (taskkill /T) and writes the partial output; stopping the task only ends the child (Task Scheduler does not end the programs it started), so the child must get there first, also
 * when it began as late as the start grace allows (its limit counts from its own start).
 */
export const CHILD_MARGIN_MS = START_GRACE_MS + 10_000;
/** The helper's own time besides the command: registering and starting the task, the margin above, stopping and removing the task. */
export const HELPER_OVERHEAD_MS = 75_000;
/** The longest limit a request may carry (the child refuses longer ones): above the longest `wsb` command the backend runs (exec, 24 hours). */
export const MAX_REQUEST_MS = 48 * 60 * 60 * 1000;
/** Each schtasks call of the check afterwards. */
export const CHECK_MS = 8_000;
const READ_CAP = 16 * 1024 * 1024;

/** The folder the private call folders are made in: NIMBLENEWT_WSB_TASK_DIR, else `%LOCALAPPDATA%\\NimbleNewt\\wsb-task`, else none. No shared folder of a job may reach it (windows-job.ts admit). */
export const wsbTaskBase = (env: (name: string) => string | undefined): string | undefined => {
  const set = env(DIR_VARIABLE);
  if (set !== undefined && set !== "") return set;
  const local = env("LOCALAPPDATA");
  return local === undefined || local === "" ? undefined : `${local}\\NimbleNewt\\wsb-task`;
};

export const parseMode = (value: string | undefined): LaunchMode => (value !== undefined && (MODES as readonly string[]).includes(value.trim().toLowerCase()) ? (value.trim().toLowerCase() as LaunchMode) : "auto");

/**
 * The fixed PowerShell helper. It reads NN_TASK (the task's name, made by the caller), NN_NODE, NN_CHILD, NN_DIR, NN_LIMIT_MS, NN_MARGIN_MS, NN_START_MS and NN_OUT, and writes only numbers and
 * booleans to the file in NN_OUT. The trigger lies a minute in the past and ends ten minutes after the command's own limit, after which Task Scheduler deletes the task itself (a safety
 * net if neither removal runs; never before the command could still be running). A failed look at the task while waiting is not an end: only `code.txt`, the task's own end, the
 * grace time or the limit end the wait, so a passing Task Scheduler hiccup does not leave a long command (exec: hours) running unwatched.
 */
export const HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$r = [ordered]@{ registered = $false; started = $false; began = $false; finished = $false; ended = $false; stopped = $false; removed = $false; elapsedMs = $null; error = $null }
$name = $env:NN_TASK
$limit = [int64]$env:NN_LIMIT_MS
$grace = [int64]$env:NN_START_MS
$wait = $limit + [int64]$env:NN_MARGIN_MS
$mask = [int64]4294967295
try {
  $arg = '"' + $env:NN_CHILD + '" "' + $env:NN_DIR + '"'
  $action = New-ScheduledTaskAction -Execute $env:NN_NODE -Argument $arg
  $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Highest
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(-1)
  $trigger.EndBoundary = (Get-Date).AddMilliseconds($limit + 600000).ToString('s')
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::FromMilliseconds($limit + 60000)) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  $settings.DeleteExpiredTaskAfter = 'PT0S'
  Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Trigger $trigger -Settings $settings | Out-Null
  $r.registered = $true
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  Start-ScheduledTask -TaskName $name
  $r.started = $true
  $began = Join-Path $env:NN_DIR 'started.txt'
  $done = Join-Path $env:NN_DIR 'code.txt'
  while ($true) {
    if (Test-Path -LiteralPath $done) { $r.finished = $true; break }
    if (Test-Path -LiteralPath $began) { $r.began = $true }
    if (-not $r.began -and $sw.ElapsedMilliseconds -ge $grace) { break }
    if ($sw.ElapsedMilliseconds -ge $wait) { break }
    $over = $false
    try {
      $code = ([int64](Get-ScheduledTaskInfo -TaskName $name).LastTaskResult) -band $mask
      $over = $code -ne 267011 -and $code -ne 267009 -and (Get-ScheduledTask -TaskName $name).State -ne 'Running'
    } catch { }
    if ($over) { $r.ended = $true; break }
    if ($r.began) { Start-Sleep -Milliseconds 1000 } else { Start-Sleep -Milliseconds 200 }
  }
  $r.elapsedMs = $sw.ElapsedMilliseconds
  if (-not $r.finished -and -not $r.ended) { $r.stopped = $true; Stop-ScheduledTask -TaskName $name }
} catch {
  $r.error = ([int64]$_.Exception.HResult) -band $mask
} finally {
  if ($r.registered) { try { Unregister-ScheduledTask -TaskName $name -Confirm:$false; $r.removed = $true } catch { } }
  [System.IO.File]::WriteAllText($env:NN_OUT, (ConvertTo-Json -Compress -InputObject $r))
}
`;

/** The facts the launch needs, so everything runs on any OS with fakes. */
export interface TaskLaunchDeps {
  readonly sysRoot: string;
  readonly nodePath: string;
  /** The full path of `windows-task-child.js`. */
  readonly childScript: string;
  /** Where private call folders are made. */
  readonly baseDir: string;
  /** A fresh hex string of the given length (tests pass a fixed one). */
  readonly randomHex: (length: number) => string;
  /** Makes the call folder (and its parents); the folder itself must not exist yet (the real one fails then). */
  readonly mkdirp: (path: string) => void;
  readonly exists: (path: string) => boolean;
  readonly readText: (path: string) => string | undefined;
  readonly writeText: (path: string, text: string) => void;
  readonly remove: (path: string) => void;
  /** Renames a file; throws when it cannot (for example when the source is gone). Used to withdraw an unclaimed request. */
  readonly rename: (from: string, to: string) => void;
  /** Why the folder cannot be believed private (a link, or another account can change it), or undefined. */
  readonly privateProblem: (dir: string) => Promise<string | undefined>;
  /** Runs one program with a hard limit (the host's bounded launcher). */
  readonly run: (file: string, args: readonly string[], options: { readonly timeoutMs: number; readonly env?: Record<string, string> }) => Promise<ProcessResult>;
}

export interface TaskRequest {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs: number;
}

/** `done`: the command ran (or may have) and this is what is known; `unavailable`: it did not start at all, so a direct call is safe, and why not. */
export type TaskOutcome = { readonly kind: "done"; readonly result: ProcessResult } | { readonly kind: "unavailable"; readonly why: string };

const hex = (v: unknown): string => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xffffffff ? `0x${v.toString(16).padStart(8, "0")}` : "an unknown error");
const sec = (ms: number): string => String(Math.max(1, Math.round(ms / 1000)));
const VIA = "through a one-shot scheduled task in the signed-in session";
const PLAIN = /^[^"%\r\n\0]+$/;

/** Reads a helper answer or the child's files in the expected form only; anything else is "not there". */
const parseAnswer = (text: string | undefined): Record<string, unknown> | undefined => {
  if (text === undefined) return undefined;
  try { const v: unknown = JSON.parse(text.replace(/^﻿/, "")); return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined; } catch { return undefined; }
};

/**
 * Runs one command through a one-shot scheduled task. Never throws. Each call makes its own folder and task and removes both before it returns. No retry.
 */
export async function runViaScheduledTask(deps: TaskLaunchDeps, req: TaskRequest): Promise<TaskOutcome> {
  const id = deps.randomHex(12);
  if (!/^[0-9a-f]{12}$/.test(id)) return { kind: "unavailable", why: "an unexpected call name" };
  const name = `NimbleNewtWsb-${id}`;
  const dir = `${deps.baseDir}\\call-${id}`;
  if (![deps.nodePath, deps.childScript, dir].every((p) => PLAIN.test(p))) return { kind: "unavailable", why: "a program or folder name the task could not take safely" };
  const limit = Math.max(1000, Math.floor(req.timeoutMs));
  if (limit > MAX_REQUEST_MS) return { kind: "unavailable", why: "a limit longer than the scheduled-task launch takes" };
  let made = false;
  try {
    if (deps.exists(dir)) return { kind: "unavailable", why: "the private folder for the call already existed" };
    try { deps.mkdirp(dir); made = true; } catch { return { kind: "unavailable", why: "the private folder for the call could not be made" }; }
    // The base folder too (made with the call folder if it was missing): an account that may delete or rename entries in it could swap the call folder for one of its own.
    const baseProblem = await deps.privateProblem(deps.baseDir).catch(() => "its access list could not be read");
    if (baseProblem !== undefined) return { kind: "unavailable", why: `the folder for the private call folders was not believed private (${baseProblem})` };
    const problem = await deps.privateProblem(dir).catch(() => "its access list could not be read");
    if (problem !== undefined) return { kind: "unavailable", why: `the private folder for the call was not believed private (${problem})` };
    try { deps.writeText(`${dir}\\in.json`, JSON.stringify({ file: req.file, args: req.args, ...(req.cwd === undefined ? {} : { cwd: req.cwd }), timeoutMs: limit })); } catch { return { kind: "unavailable", why: "the request could not be written" }; }
    const answerFile = `${dir}\\task.json`;
    const ps = `${deps.sysRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    const helper = await deps.run(ps, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", HELPER_SCRIPT], {
      timeoutMs: limit + HELPER_OVERHEAD_MS,
      env: { NN_TASK: name, NN_NODE: deps.nodePath, NN_CHILD: deps.childScript, NN_DIR: dir, NN_LIMIT_MS: String(limit), NN_MARGIN_MS: String(CHILD_MARGIN_MS), NN_START_MS: String(START_GRACE_MS), NN_OUT: answerFile },
    }).catch((): ProcessResult => ({ code: null, stdout: "", stderr: "", timedOut: false }));
    const answer = parseAnswer(deps.readText(answerFile));
    // The task must be gone whatever the helper said (query, delete if there, query again; the exit codes only, schtasks' words are translated).
    const task = `${deps.sysRoot}\\System32\\schtasks.exe`;
    const present = async (): Promise<boolean | undefined> => { const q = await deps.run(task, ["/Query", "/TN", name], { timeoutMs: CHECK_MS }).catch(() => undefined); return q === undefined || q.timedOut || q.code === null ? undefined : q.code === 0; };
    const leftover = await present();
    if (leftover !== false) {
      // Still registered (or not known): its run, if any, is ended first (deleting a task does not end its running program), then the task is deleted.
      await deps.run(task, ["/End", "/TN", name], { timeoutMs: CHECK_MS }).catch(() => undefined);
      await deps.run(task, ["/Delete", "/TN", name, "/F"], { timeoutMs: CHECK_MS }).catch(() => undefined);
    }
    const began = deps.exists(`${dir}\\started.txt`);
    const ran = began || answer?.began === true || deps.exists(`${dir}\\code.txt`);
    // The proof that it never began: the request is withdrawn (renamed away) before the child claimed it. Only one of the two renames can succeed, so a child that begins later
    // runs nothing, and a request the child already claimed (even one that has not yet written started.txt) is never counted as "not started".
    let withdrawn = false;
    if (!ran) { try { deps.rename(`${dir}\\in.json`, `${dir}\\withdrawn.json`); withdrawn = true; } catch { withdrawn = false; } }
    if (!ran && !withdrawn) return { kind: "done", result: { code: null, stdout: "", stderr: "the Windows Sandbox command was handed to the scheduled-task launch, which began it late or could not be checked; it cannot be said whether the command ran", timedOut: false, via: VIA } };
    if (!ran) {
      // The command never began, so a direct call cannot double it. Only when the helper itself ended in a way that proves it is not still working.
      if (answer === undefined && helper.timedOut) return { kind: "unavailable", why: `the scheduled-task helper did not report within ${sec(limit + HELPER_OVERHEAD_MS)} s and was stopped before the command began` };
      if (answer === undefined) return { kind: "unavailable", why: "the scheduled-task helper could not run" };
      if (answer.registered !== true) return { kind: "unavailable", why: `the task could not be registered (error ${hex(answer.error)})` };
      if (answer.started !== true) return { kind: "unavailable", why: `the task was registered but could not be started (error ${hex(answer.error)})` };
      if (answer.ended === true) return { kind: "unavailable", why: "the task ended before the command began" };
      return { kind: "unavailable", why: `the task did not begin within ${sec(START_GRACE_MS)} s (is anyone signed in on this machine?)` };
    }
    const codeText = deps.readText(`${dir}\\code.txt`)?.trim();
    const out = (deps.readText(`${dir}\\out.txt`) ?? "").slice(0, READ_CAP);
    const err = (deps.readText(`${dir}\\err.txt`) ?? "").slice(0, READ_CAP);
    const code = codeText !== undefined && /^\d{1,10}$/.test(codeText) && Number(codeText) <= 0xffffffff ? Number(codeText) : undefined;
    if (code !== undefined) return { kind: "done", result: { code, stdout: out, stderr: err, timedOut: false, via: VIA } };
    const limited = answer?.stopped === true || /timed out after \d+ s and was stopped/.test(err);
    const note = limited
      ? `the Windows Sandbox command was run ${VIA} but did not end within ${sec(limit)} s and was stopped`
      : `the Windows Sandbox command was run ${VIA} but the task ended without reporting an exit code`;
    return { kind: "done", result: { code: null, stdout: out, stderr: `${err}${err === "" || err.endsWith("\n") ? "" : "\n"}${note}`, timedOut: limited, via: VIA } };
  } catch {
    return { kind: "done", result: { code: null, stdout: "", stderr: "the scheduled-task launch of the Windows Sandbox command stopped on an unexpected error; it cannot be said whether the command ran", timedOut: false, via: VIA } };
  } finally {
    if (made) { try { deps.remove(dir); } catch { /* left in the private folder; the next call makes its own */ } }
  }
}

/**
 * The strategy: which launch a command gets and what the owner sees when the task cannot be used. `direct` is the host's plain call (the one tests inject).
 * - `direct` mode: never the task.
 * - `task` mode: only the task; unavailable becomes a plain failure (nothing ran).
 * - `auto` (default): the task first; the direct call only when the task provably did not start, with that reason recorded in the result's `via`.
 */
export async function launchWsb(mode: LaunchMode, task: () => Promise<TaskOutcome>, direct: () => Promise<ProcessResult>): Promise<ProcessResult> {
  if (mode === "direct") return direct();
  const t = await task();
  if (t.kind === "done") return t.result;
  if (mode === "task") return { code: null, stdout: "", stderr: `the Windows Sandbox command was not run: the scheduled-task launch is not available (${t.why}) and the direct call is switched off`, timedOut: false, via: "scheduled task not available" };
  const r = await direct();
  return { ...r, via: `scheduled task not available (${t.why}); direct call used` };
}
