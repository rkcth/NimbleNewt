import { randomUUID } from "node:crypto";
import { win32 } from "node:path";
import type { SpawnPlan } from "./backend.js";
import type { AfterSignOutEvidence } from "./containment.js";
import { AFTER_SIGNOUT_SCHEMA } from "./containment-windows-native-evidence.js";
import type { NormalizedRecipe } from "./recipe.js";
import { jobFile, launcherSid, readRecord, sweepLeftoversLocked, writerAlive, type NativeHost, type NativeJob, type RunRecord } from "./windows-native-job.js";
import { MAX_CONCURRENT_RUNS_LIMIT, grantArgs, isRunProfileName, parseLauncherLine, type LauncherLine, type NativeGrant, type NativeSettings } from "./windows-native-plan.js";
import { windowsNativeBackend } from "./windows-native.js";

/*
 * Card A03b: the sign-out / restart check on the owner's PC, in two phases with ONE human step between them (sign out of Windows and back in, or restart).
 *
 *   Phase 1, `startHold` (run-g05.ps1 -Hold -> containment-evidence.mjs hold): one confined idle task through the native backend's own plan and runner, exactly the path every run takes (job file,
 *   runner, launcher, per-run profile, grants, Job Object), with the launcher's time limit set to the hold's minutes, so a hold the owner forgets ends by itself. The runner is started detached, so it
 *   outlives the script; the script waits until the confined program itself has written its marker, then records the state (run id, job folder, profile name and SID, grants, the run's processes with
 *   their start times) under `<control>\hold\state.json` and returns.
 *
 *   The human step: Windows ends every process of the owner's session at sign-out (and everything at a restart). The runner never gets to its own clean-up or record.
 *
 *   Phase 2, `afterSignIn` (run-g05.ps1 -AfterSignIn -> containment-evidence.mjs after-sign-in): reads the state, checks that no process of the held run is still running (number AND start time; a
 *   process list that cannot be read counts as running), notes whether the held profile was still there, runs the backend's own leftover sweep (the same one every run and the health check run first),
 *   then reads back by the held profile's SID every path the run was granted (the launcher's `check`), counts the `NimbleNewtRun-*` profiles left, and reads the held run's record: the sweep writes
 *   one marked `interrupted` for a run that left none (windows-native-job.ts). The result is the report's optional `nativeWindows.afterSignOut` block (containment.ts), written to
 *   `<control>\hold\after-sign-out.json`; the ten cases then run as usual and `run --after-sign-out` puts it in the report.
 *
 * Not checked directly: the held run's window objects (a private desktop on WinSta0, or a private window station). They are kernel objects whose only handles the launcher and its program held; with
 * those processes ended and a new logon session, nothing can hold them. Listing the desktops of a window station needs a P/Invoke this check does not make.
 */

export const HOLD_SCHEMA = "nimblenewt.g05-hold/1";
/** The hold's default and largest length: the launcher's time limit for the idle task. */
export const DEFAULT_HOLD_MINUTES = 30;
export const MAX_HOLD_MINUTES = 30;
const MAX_PROCESSES = 16;
const MAX_STATE_BYTES = 256 * 1024;
const RUN_ID = /^hold-[0-9a-f-]{36}$/;
const SID = /^S-1-15-2(?:-\d{1,10}){7}$/;
const PROFILE_FOLDER = /^nimblenewtrun-[0-9a-f]{16}$/i;
const CHECK_MS = 120_000;

/** The idle program the container runs: it writes its marker into its own (granted) work folder, then waits. The launcher's time limit ends it; its own exit, 5 minutes later, is a last bound. */
export const HOLD_SCRIPT = [
  'import { writeFileSync } from "node:fs";',
  "const [work, limit] = process.argv.slice(2);",
  'writeFileSync(work + "\\\\held.txt", "held " + process.pid);',
  "setInterval(() => {}, 60000);",
  "setTimeout(() => process.exit(0), Number(limit) + 300000);",
  "",
].join("\n");

/** Where the hold keeps its files: the state of phase 1 and the result of phase 2, in the supervisor's own control folder (never granted to the container, never zipped). */
export const holdFiles = (controlDir: string): { dir: string; state: string; checked: string; result: string } => {
  const dir = `${controlDir}\\hold`;
  return { dir, state: `${dir}\\state.json`, checked: `${dir}\\state-checked.json`, result: `${dir}\\after-sign-out.json` };
};

export interface HoldState {
  readonly schema: typeof HOLD_SCHEMA;
  readonly runId: string;
  readonly jobDir: string;
  readonly profileName: string;
  /** The held profile's SID as the launcher recorded it before it made the profile; absent when phase 1 never saw that record. */
  readonly sid?: string;
  readonly settings: NativeSettings;
  readonly grants: readonly NativeGrant[];
  /** The task's own folders (work, home, scratch, tools), all under this one folder; phase 2's caller removes it after the sweep. */
  readonly root: string;
  readonly startedAt: string;
  /** When the launcher's time limit ends the idle task at the latest. */
  readonly until: string;
  readonly minutes: number;
  /** The confined program itself wrote its marker: it ran in the container. */
  readonly childSeen: boolean;
  /** The runner (first, when it was found) and the processes under it at the time of the marker, each with its start time (a process number alone can be reused after a restart). */
  readonly processes: readonly { readonly pid: number; readonly started: string }[];
}

export interface HoldOptions {
  readonly host: NativeHost;
  readonly launcher: string;
  readonly controlDir: string;
  readonly nodeExecutable: string;
  readonly runnerScript?: string;
  /** An empty folder of the hold's own (its real, long name), outside the control folder and the bundle: the task's folders are made inside it. */
  readonly root: string;
  readonly minutes?: number;
  /** Starts the runner of `plan` DETACHED (it must outlive this process) and gives its process number, or undefined when it could not be started. */
  readonly spawnRunner: (plan: SpawnPlan) => number | undefined;
  readonly sleep?: (ms: number) => Promise<void>;
  /** How long to wait for the confined program's marker (default 90 s). */
  readonly waitMs?: number;
  readonly now?: () => Date;
  /** Tests only: the backend's volume check (default true). */
  readonly requireNtfs?: boolean;
}

/** `started`: whether the runner was started (only then may the hold's folders be in use; otherwise the caller removes them). */
export type HoldResult = { readonly state: HoldState; readonly problems: readonly string[] } | { readonly error: string; readonly started: boolean };

/** A process of the state still running: the same number with the same start time; `undefined` when the list cannot be read. */
async function stillRunning(host: NativeHost, procs: readonly { pid: number; started: string }[]): Promise<boolean | undefined> {
  let list: Awaited<ReturnType<NativeHost["processes"]>>;
  try { list = await host.processes(); } catch { list = undefined; }
  if (list === undefined) return undefined;
  return procs.some((p) => list.some((x) => x.pid === p.pid && x.started === p.started));
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const sameWin = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The state file read as data: exactly the shape phase 1 writes, for this control folder and launcher; otherwise why not. */
export function parseHoldState(raw: string, controlDir: string, launcher: string): { state: HoldState } | { error: string } {
  if (Buffer.byteLength(raw, "utf8") > MAX_STATE_BYTES) return { error: "the hold's state file is too large" };
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return { error: "the hold's state file is not JSON" }; }
  if (!isObject(v) || v["schema"] !== HOLD_SCHEMA) return { error: `the hold's state file is not a ${HOLD_SCHEMA}` };
  const runId = v["runId"], jobDir = v["jobDir"], name = v["profileName"], sid = v["sid"], s = v["settings"], grants = v["grants"], procs = v["processes"];
  if (typeof runId !== "string" || !RUN_ID.test(runId)) return { error: "the hold's run id is not one phase 1 makes" };
  if (typeof jobDir !== "string" || !sameWin(jobDir, `${controlDir}\\jobs\\${runId}`)) return { error: "the hold's job folder is not this control folder's folder for its run" };
  if (typeof name !== "string" || !isRunProfileName(name)) return { error: "the hold's profile name is not a per-run name" };
  if (sid !== undefined && (typeof sid !== "string" || !SID.test(sid))) return { error: "the hold's profile SID is not an AppContainer SID" };
  if (!isObject(s) || typeof s["launcher"] !== "string" || !sameWin(s["launcher"], launcher) || typeof s["controlDir"] !== "string" || !sameWin(s["controlDir"], controlDir)
    || (s["container"] !== "lpac" && s["container"] !== "appcontainer") || !Number.isSafeInteger(s["maxConcurrentRuns"]) || (s["maxConcurrentRuns"] as number) < 1 || (s["maxConcurrentRuns"] as number) > MAX_CONCURRENT_RUNS_LIMIT) {
    return { error: "the hold's settings are not this bundle's launcher and control folder" };
  }
  if (!Array.isArray(grants) || grants.length === 0 || grants.length > 64 || !grants.every((g) => isObject(g) && typeof g["path"] === "string" && typeof g["mode"] === "string")) return { error: "the hold's grant list is not readable" };
  if (!Array.isArray(procs) || procs.length > MAX_PROCESSES || !procs.every((p) => isObject(p) && Number.isSafeInteger(p["pid"]) && (p["pid"] as number) > 0 && typeof p["started"] === "string" && (p["started"] as string).length <= 64)) return { error: "the hold's process list is not readable" };
  if (typeof v["root"] !== "string" || typeof v["startedAt"] !== "string" || typeof v["until"] !== "string" || typeof v["childSeen"] !== "boolean" || !Number.isSafeInteger(v["minutes"])) return { error: "the hold's state file is incomplete" };
  return { state: v as unknown as HoldState };
}

/**
 * Phase 1. Refuses while an earlier hold of this control folder may still be running. Writes the state file whenever the runner was started (also when the marker never came: phase 2 then reports
 * `held: false` and still sweeps). Never leaves the idle task without a time limit: the launcher ends it after `minutes`.
 */
export async function startHold(o: HoldOptions): Promise<HoldResult> {
  const { host } = o;
  const minutes = o.minutes ?? DEFAULT_HOLD_MINUTES;
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > MAX_HOLD_MINUTES) return { error: `the hold's minutes: a whole number from 1 to ${MAX_HOLD_MINUTES}`, started: false };
  const files = holdFiles(o.controlDir);
  const earlier = host.readText(files.state, MAX_STATE_BYTES);
  if (earlier !== undefined) {
    const parsed = parseHoldState(earlier, o.controlDir, o.launcher);
    if ("error" in parsed) return { error: `an earlier hold's state file is there and cannot be read (${parsed.error}); run -AfterSignIn for it, or delete ${files.state} once nothing of it runs`, started: false };
    const running = await stillRunning(host, parsed.state.processes);
    if (running !== false) return { error: running === undefined ? "an earlier hold is recorded and the process list cannot be read to tell whether it still runs" : "an earlier hold is still running: sign out and back in, then run -AfterSignIn", started: false };
  }
  const now = o.now ?? (() => new Date());
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const limitMs = minutes * 60_000;
  const backend = windowsNativeBackend({ host, launcher: o.launcher, controlDir: o.controlDir, nodeExecutable: o.nodeExecutable, maxRunMs: limitMs, ...(o.runnerScript === undefined ? {} : { runnerScript: o.runnerScript }), ...(o.requireNtfs === undefined ? {} : { requireNtfs: o.requireNtfs }) });
  const d = { work: `${o.root}\\work`, home: `${o.root}\\home`, scratch: `${o.root}\\scratch`, tools: `${o.root}\\tools` };
  const nodeDir = win32.dirname(o.nodeExecutable);
  let plan: SpawnPlan;
  try {
    for (const p of Object.values(d)) host.mkdirp(p);
    host.writeText(`${d.tools}\\hold.mjs`, HOLD_SCRIPT);
    // Built as the health probe builds its recipe: the task's three folders, the hold's program read-only, node read-only. No network, no input, no protected name.
    const recipe: NormalizedRecipe = {
      mode: "sandboxed", workdir: d.work, home: d.home, scratch: d.scratch, network: "none", env: {}, protectedSubpaths: [], unprotectedSubpaths: [], revision: "g05-hold",
      readOnly: [{ host: d.tools, guest: "/inputs/hold" }, { host: nodeDir, guest: "/opt/node" }],
    };
    plan = backend.plan(recipe, [`/opt/node/${win32.basename(o.nodeExecutable)}`, `${d.tools}\\hold.mjs`, d.work, String(limitMs)], `hold-${randomUUID()}`);
  } catch (error) { return { error: `the hold could not be planned: ${(error as Error).message}`, started: false }; }
  const jobDir = plan.env["NIMBLENEWT_NATIVE_JOB"];
  if (jobDir === undefined) return { error: "the backend's plan names no job folder", started: false };
  let job: NativeJob;
  try { job = JSON.parse(host.readText(jobFile(jobDir)) ?? "") as NativeJob; } catch { return { error: "the hold's job file cannot be read back", started: false }; }
  const startedAt = now();
  const pid = o.spawnRunner(plan);
  if (pid === undefined) return { error: "the hold's runner could not be started", started: false };
  const problems: string[] = [];
  const marker = `${d.work}\\held.txt`;
  const deadline = startedAt.getTime() + (o.waitMs ?? 90_000);
  let childSeen = false;
  while (now().getTime() <= deadline) {
    if (host.exists(marker)) { childSeen = true; break; }
    if (readRecord(host, job.settings, job.runId) !== undefined) { problems.push("the held run ended before its program was seen running (its record is in control\\records)"); break; }
    await sleep(500);
  }
  if (!childSeen && problems.length === 0) problems.push("the confined program did not write its marker in time; the launcher still ends it by its time limit");
  const sid = launcherSid(host, job.settings, job.profile.name);
  if (childSeen && sid === undefined) problems.push("the launcher's record of the held profile (its SID) was not found");
  // The runner and everything under it, each with its start time.
  let procs: { pid: number; started: string }[] = [];
  let list: Awaited<ReturnType<NativeHost["processes"]>>;
  try { list = await host.processes(); } catch { list = undefined; }
  if (list === undefined) problems.push("the process list could not be read, so the held run's processes are not recorded");
  else {
    const queue = [pid];
    while (queue.length > 0 && procs.length < MAX_PROCESSES) {
      const at = queue.shift()!;
      const self = list.find((x) => x.pid === at);
      if (self !== undefined) procs.push({ pid: self.pid, started: self.started });
      for (const c of list) if (c.parent === at && c.pid !== at) queue.push(c.pid);
    }
    if (!procs.some((p) => p.pid === pid)) problems.push("the held run's runner is not running any more");
  }
  const state: HoldState = {
    schema: HOLD_SCHEMA, runId: job.runId, jobDir, profileName: job.profile.name, ...(sid === undefined ? {} : { sid }), settings: job.settings, grants: job.grants, root: o.root,
    startedAt: startedAt.toISOString(), until: new Date(startedAt.getTime() + limitMs).toISOString(), minutes, childSeen: childSeen && sid !== undefined && procs[0]?.pid === pid, processes: procs,
  };
  try { host.mkdirp(files.dir); host.remove(files.result); host.writeText(files.state, JSON.stringify(state)); } catch (error) { return { error: `the hold's state file could not be written: ${(error as Error).message}`, started: true }; }
  return { state, problems };
}

/** How the held run's record reads: only `interrupted` (the sweep's) and `failed` (a runner that outlived its launcher wrote it) count as stopped by the sign-out. */
export function heldRunOutcome(record: RunRecord | undefined): "interrupted" | "failed" | "timed-out" | "succeeded" | "none" {
  if (record === undefined) return "none";
  if (record.interrupted === true && record.failure?.kind === "interrupted") return "interrupted";
  if (record.timedOut) return "timed-out";
  if (record.failure !== undefined) return "failed";
  return "succeeded";
}

export interface AfterSignInOptions {
  readonly host: NativeHost;
  readonly launcher: string;
  readonly controlDir: string;
  /** `%LOCALAPPDATA%\Packages`. */
  readonly packagesDir: string;
  /** Whether the logon session changed since the hold (run-g05.ps1 compares `whoami /logonid`); `null`: not known. */
  readonly newLogon: boolean | null;
}

export type AfterSignInResult =
  | { readonly afterSignOut: AfterSignOutEvidence; readonly running: boolean; readonly outcome: ReturnType<typeof heldRunOutcome>; readonly root: string; readonly notes: readonly string[] }
  | { readonly error: string };

/**
 * Phase 2. Writes `<control>\hold\after-sign-out.json` (`{ schema, afterSignOut }`) in every case it can judge. While a held process still runs it sweeps nothing and keeps the state (the owner has not
 * signed out yet). After a sweep the state file becomes `state-checked.json`, so the same hold is judged once.
 */
export async function afterSignIn(o: AfterSignInOptions): Promise<AfterSignInResult> {
  const { host } = o;
  const files = holdFiles(o.controlDir);
  const raw = host.readText(files.state, MAX_STATE_BYTES);
  if (raw === undefined) return { error: "no hold is recorded in this folder (run -Hold first)" };
  const parsed = parseHoldState(raw, o.controlDir, o.launcher);
  if ("error" in parsed) return { error: parsed.error };
  const st = parsed.state;
  const settings = st.settings;
  const notes: string[] = [];
  const write = (a: AfterSignOutEvidence): void => { host.writeText(files.result, JSON.stringify({ schema: AFTER_SIGNOUT_SCHEMA, afterSignOut: a })); };
  // 1. Nothing of the held run may still run: its own processes (number and start time), and the backend's own rule for the runner and what it started.
  const exact = await stillRunning(host, st.processes);
  // The backend's rule takes the runner's own start time as the time of the run (as its status file does), so a later process with the same number is not the runner.
  const runner = st.processes[0];
  const byStatus = runner === undefined ? false : await writerAlive(host, runner.pid, runner.started, st.runId);
  const running = exact !== false || byStatus;
  if (exact === undefined) notes.push("the process list could not be read, so the held run counts as still running");
  const profileFolder = `${o.packagesDir}\\${st.profileName.toLowerCase()}`;
  const profileLeftBeforeSweep = host.exists(profileFolder);
  if (running) {
    const a: AfterSignOutEvidence = { held: st.childSeen, newLogon: o.newLogon, taskRunningAfter: true, profileLeftBeforeSweep, sweepProblems: null, leftoverAfterSweep: null, grantsAfter: "not-measured", interruptedRecorded: false };
    write(a);
    return { afterSignOut: a, running: true, outcome: heldRunOutcome(readRecord(host, settings, st.runId)), root: st.root, notes };
  }
  // 2. The backend's own leftover sweep, as every run and the health check do first.
  let sweepProblems: number | null;
  try {
    const swept = await sweepLeftoversLocked(host, settings);
    sweepProblems = swept.problems.length + swept.live.length;
    for (const p of swept.problems) notes.push(`sweep: ${p}`);
    for (const l of swept.live) notes.push(`sweep: still in use: ${l}`);
  } catch (error) { sweepProblems = null; notes.push(`the sweep could not run: ${(error as Error).message}`); }
  // 3. The launcher's own read-back of every path the held run was granted, by the held profile's SID (no revoke here: what a sweep left must show).
  let grantsAfter: AfterSignOutEvidence["grantsAfter"] = "not-measured";
  if (st.sid === undefined) notes.push("the held profile's SID was not recorded, so its grants cannot be read back");
  else {
    let answer: LauncherLine | undefined;
    try { answer = parseLauncherLine((await host.run(settings.launcher, ["check", "--name", st.profileName, "--sid", st.sid, ...grantArgs(st.grants)], { timeoutMs: CHECK_MS })).stdout); } catch { answer = undefined; }
    const line = answer;
    if (line === undefined || !line.ok) notes.push(`the launcher's check gave no usable answer${line?.error === undefined ? "" : ` (${line.error.slice(0, 200)})`}`);
    else {
      const left = st.grants.filter((g) => { const r = line.grants.find((x) => sameWin(x.path, g.path)); return r === undefined || r.entriesLeft !== 0; });
      grantsAfter = left.length === 0 ? "clean" : "left";
      if (left.length > 0) notes.push(`an entry for the held container is still on ${left.length} granted path(s)`);
    }
  }
  // 4. Profiles left, and how the held run is recorded.
  let leftoverAfterSweep: number | null;
  try { leftoverAfterSweep = host.listDir(o.packagesDir).filter((n) => PROFILE_FOLDER.test(n)).length; } catch { leftoverAfterSweep = null; }
  const outcome = heldRunOutcome(readRecord(host, settings, st.runId));
  if (outcome !== "interrupted" && outcome !== "failed") notes.push(`the held run's record says: ${outcome}`);
  const a: AfterSignOutEvidence = {
    held: st.childSeen, newLogon: o.newLogon, taskRunningAfter: false, profileLeftBeforeSweep, sweepProblems, leftoverAfterSweep, grantsAfter, interruptedRecorded: outcome === "interrupted" || outcome === "failed",
  };
  write(a);
  try { host.writeText(files.checked, raw); host.remove(files.state); } catch { notes.push("the state file could not be retired; the next -AfterSignIn judges the same hold again"); }
  return { afterSignOut: a, running: false, outcome, root: st.root, notes };
}
