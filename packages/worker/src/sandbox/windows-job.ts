import { win32 } from "node:path";
import { randomUUID } from "node:crypto";
import type { NormalizedRecipe } from "./recipe.js";
import { GUEST_PATHS, aclSteps, launchScript, overlapsWin, sharesFor, verifyClient, verifySession, wsbConfigXml, type AclStep, type Share, type WindowsSettings } from "./windows-plan.js";
import type { WindowsHost } from "./windows-host.js";

/** The job file the backend writes (in the supervisor's control directory) and the runner process reads. */
export interface WindowsJob {
  readonly version: 1;
  readonly settings: WindowsSettings;
  readonly recipe: NormalizedRecipe;
  readonly command: readonly string[];
}

export const EXIT_BUSY = 75;
export const EXIT_REFUSED = 70;
export const EXIT_FAILED = 71;

const WSB_TIMEOUT_MS = 120_000;
const EXEC_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const GUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

/** The directory of one launch, named by the launch's own id: two launches of the same recipe and command never share a directory (a refused-as-busy launch must not be able to touch the one that is running). */
export function jobDirFor(settings: WindowsSettings, runId: string | undefined): string {
  const id = runId !== undefined && /^[A-Za-z0-9-]{8,64}$/.test(runId) ? runId : randomUUID();
  return `${settings.controlDir}\\jobs\\${id}`;
}
export const jobFile = (jobDir: string): string => `${jobDir}\\job.json`;
const guestDirOf = (jobDir: string): string => `${jobDir}\\guest`;
const statusFile = (jobDir: string): string => `${jobDir}\\status.json`;
const aclFile = (jobDir: string): string => `${jobDir}\\acl.json`;
export const lockFile = (settings: WindowsSettings): string => `${settings.controlDir}\\sandbox.lock`;

export interface JobOutcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const refused = (reason: string): JobOutcome => ({ exitCode: EXIT_REFUSED, stdout: "", stderr: `refused: ${reason}\n` });

function icacls(host: WindowsHost): string {
  return `${host.env("SystemRoot") ?? "C:\\Windows"}\\System32\\icacls.exe`;
}

/** The checks that every job repeats at the moment it starts (the health check may be old): the client, the session, and that no shared folder reaches the supervisor's files. */
export async function admit(host: WindowsHost, settings: WindowsSettings, shares: readonly Share[], supervisorPaths: readonly string[]) {
  const client = await verifyClient(host, settings);
  if (!client.ok) return client;
  const session = await verifySession(host, settings);
  if (!session.ok) return session;
  for (const s of shares) {
    // The job's own read-only guest folder is inside the control directory by design; it holds nothing but the generated launch script.
    const guarded = s.why === "job" ? supervisorPaths : [settings.controlDir, ...supervisorPaths];
    for (const p of guarded) if (overlapsWin(s.host, p)) return { ok: false as const, reason: `the shared folder ${s.host} overlaps the supervisor's own files (${p})` };
  }
  return client;
}

interface AclRecord { readonly path: string; readonly parent: string; readonly file: string }
const writeAtomic = (host: WindowsHost, path: string, text: string): void => { host.writeText(`${path}.tmp`, text); host.rename(`${path}.tmp`, path); };

/**
 * Saves each folder's whole access list first (icacls /save into the job directory), records it, and only then changes it. The only way back is /restore of that saved list, so an entry
 * the account already had (explicit, inherited or a deny), or a longer account name ending the same way, is never mistaken for ours.
 */
async function applyAcls(host: WindowsHost, jobDir: string, steps: readonly AclStep[]): Promise<string | undefined> {
  const records: AclRecord[] = [];
  const exe = icacls(host);
  for (const [i, step] of steps.entries()) {
    const file = `${jobDir}\\acl-${i}.txt`;
    const saved = await host.run(exe, [step.path, "/save", file], { timeoutMs: 30_000 });
    if (saved.code !== 0) return `the access list of ${step.path} could not be saved (icacls exit ${String(saved.code)}), so it was not changed`;
    // Written (atomically) before the change, so a crash in the middle still leaves the way back.
    records.push({ path: step.path, parent: win32.dirname(step.path), file });
    writeAtomic(host, aclFile(jobDir), JSON.stringify(records));
    const done = await host.run(exe, step.apply, { timeoutMs: 60_000 });
    if (done.code !== 0) return `the access list of ${step.path} could not be changed (icacls exit ${String(done.code)}): ${done.stderr.trim().slice(0, 200)}`;
  }
  return undefined;
}

/** Puts every saved access list back. What cannot be restored stays recorded; the problem is returned, never swallowed. */
async function revertAcls(host: WindowsHost, jobDir: string): Promise<string | undefined> {
  const text = host.readText(aclFile(jobDir));
  if (text === undefined) return undefined;
  let records: AclRecord[];
  try { records = JSON.parse(text) as AclRecord[]; if (!Array.isArray(records)) throw new Error("not a list"); } catch { return `the record of access-list changes (${aclFile(jobDir)}) cannot be read; the saved lists are kept for the owner`; }
  const remaining: AclRecord[] = [];
  for (const r of [...records].reverse()) {
    const done = await host.run(icacls(host), [r.parent, "/restore", r.file], { timeoutMs: 60_000 }).catch(() => undefined);
    if (done === undefined || done.code !== 0) remaining.push(r);
  }
  if (remaining.length > 0) { writeAtomic(host, aclFile(jobDir), JSON.stringify(remaining.reverse())); return `the access list of ${remaining.map((r) => r.path).join(", ")} could not be restored; it is saved in ${jobDir}`; }
  host.remove(aclFile(jobDir));
  return undefined;
}

export type ReleaseResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** The lock's holder, when another job is alive and holds it. */
function liveOtherHolder(host: WindowsHost, settings: WindowsSettings, jobDir: string): boolean {
  const text = host.readText(lockFile(settings));
  if (text === undefined) return false;
  try {
    const holder = JSON.parse(text) as { pid?: number; jobDir?: string };
    return holder.jobDir !== jobDir && holder.pid !== undefined && holder.pid !== host.pid && host.pidAlive(holder.pid);
  } catch { return false; }
}

/**
 * Ends whatever a job left: the sandbox it started, its access-list changes, its lock and its directory. Safe to call more than once and after a crash or a hard kill.
 * It acts only for its own job: while another job holds the lock it touches nothing of that job's. If anything cannot be undone, the job directory (with the saved access lists) and
 * the lock are kept and the reason is returned, so nothing is forgotten and nothing else starts on top of it.
 */
export async function releaseJob(host: WindowsHost, settings: WindowsSettings, jobDir: string): Promise<ReleaseResult> {
  if (liveOtherHolder(host, settings, jobDir)) {
    // This launch never held the lock, so it never started anything; its directory holds only its job file.
    if (host.exists(statusFile(jobDir)) || host.exists(aclFile(jobDir))) return { ok: false, reason: `${jobDir} holds changes of a job that is not the one running; kept for the next health check` };
    host.remove(jobDir);
    return { ok: true };
  }
  const problems: string[] = [];
  const status = host.readText(statusFile(jobDir));
  if (status !== undefined) {
    let id: string | undefined;
    try { id = (JSON.parse(status) as { id?: string }).id; } catch { id = undefined; }
    const client = await verifyClient(host, settings);
    if (id === undefined || !GUID.test(id)) problems.push(`the sandbox record in ${jobDir} cannot be read`);
    else if (!client.ok) problems.push(`the sandbox ${id} could not be stopped because the client could not be verified (${client.reason})`);
    else {
      const stopped = await host.run(client.value.wsb, ["stop", "--id", id], { cwd: client.value.cwd, timeoutMs: WSB_TIMEOUT_MS }).catch(() => undefined);
      if (stopped === undefined || stopped.code !== 0) {
        // A stop of a sandbox that is already gone fails too: only one that is still listed is a problem.
        const listed = await host.run(client.value.wsb, ["list", "--raw"], { cwd: client.value.cwd, timeoutMs: WSB_TIMEOUT_MS }).catch(() => undefined);
        if (listed === undefined || listed.code !== 0 || listed.stdout.toLowerCase().includes(id.toLowerCase())) problems.push(`the sandbox ${id} could not be stopped`);
      }
    }
    if (problems.length === 0) host.remove(statusFile(jobDir));
  }
  const aclProblem = await revertAcls(host, jobDir);
  if (aclProblem !== undefined) problems.push(aclProblem);
  if (problems.length > 0) return { ok: false, reason: problems.join("; ") };
  const lock = host.readText(lockFile(settings));
  if (lock !== undefined) { try { if ((JSON.parse(lock) as { jobDir?: string }).jobDir === jobDir) host.remove(lockFile(settings)); } catch { /* not ours */ } }
  host.remove(jobDir);
  return { ok: true };
}

/** Runs one job: admission, per-job ACLs, a fresh sandbox with only the listed folders, the command inside it, and teardown. Only one Windows Sandbox can exist at a time, so a second job is refused as busy. */
async function execute(host: WindowsHost, job: WindowsJob, supervisorPaths: readonly string[], jobDir: string, state: { owned: boolean }): Promise<JobOutcome> {
  const { settings, recipe, command } = job;
  const shares = sharesFor(recipe, guestDirOf(jobDir));
  try {
    const lock = JSON.stringify({ pid: host.pid, jobDir });
    host.mkdirp(settings.controlDir);
    if (!host.createExclusive(lockFile(settings), lock)) {
      const seen = host.readText(lockFile(settings));
      let holder: { pid?: number } = {};
      try { holder = JSON.parse(seen ?? "{}") as { pid?: number }; } catch { /* corrupt lock: treated as stale */ }
      const busy = (why: string): JobOutcome => ({ exitCode: EXIT_BUSY, stdout: "", stderr: `busy: ${why}\n` });
      if (holder.pid !== undefined && holder.pid !== host.pid && host.pidAlive(holder.pid)) return busy("another Windows Sandbox job is running (only one sandbox can exist at a time)");
      // A stale lock is moved aside by a rename (only one process can win it) and judged by what was moved, then the lock is taken again exclusively.
      const aside = `${lockFile(settings)}.stale-${randomUUID()}`;
      try { host.rename(lockFile(settings), aside); } catch { return busy("the sandbox lock changed while it was being examined"); }
      const moved = host.readText(aside);
      host.remove(aside);
      if (moved !== seen) { host.createExclusive(lockFile(settings), moved ?? ""); return busy("the sandbox lock changed while it was being examined"); }
      if (!host.createExclusive(lockFile(settings), lock)) return busy("the sandbox lock could not be taken");
    }
    state.owned = true;
    const admitted = await admit(host, settings, shares, supervisorPaths);
    if (!admitted.ok) return refused(admitted.reason);
    const client = admitted.value;

    host.mkdirp(guestDirOf(jobDir));
    host.writeText(`${guestDirOf(jobDir)}\\launch.cmd`, launchScript(recipe, command));
    const aclProblem = await applyAcls(host, jobDir, aclSteps(settings.shareIdentity, shares));
    if (aclProblem !== undefined) return refused(aclProblem);

    const started = await host.run(client.wsb, ["start", "--config", wsbConfigXml(shares)], { cwd: client.cwd, timeoutMs: WSB_TIMEOUT_MS });
    const id = GUID.exec(started.stdout)?.[0];
    if (id !== undefined) host.writeText(statusFile(jobDir), JSON.stringify({ id }));
    if (started.code !== 0 || id === undefined) {
      const text = `${started.stdout}\n${started.stderr}`;
      const why = /0x8000401A/i.test(text) ? "Windows Sandbox could not start because no user session is available (0x8000401A, the server's configured identity)" : `wsb start failed (exit ${String(started.code)}): ${text.trim().slice(0, 300)}`;
      return { exitCode: EXIT_FAILED, stdout: "", stderr: `failed: ${why}\n` };
    }
    // The session conditions are checked again between start and exec: the start takes long enough for a lock to be undone.
    const again = await verifySession(host, settings);
    if (!again.ok) return refused(again.reason);

    const exec = await host.run(client.wsb, ["exec", "--id", id, "-c", `C:\\Windows\\System32\\cmd.exe /d /c ${GUEST_PATHS.job}\\launch.cmd`, "-d", GUEST_PATHS.work, "-r", "System"], { cwd: client.cwd, timeoutMs: EXEC_TIMEOUT_MS });
    if (exec.timedOut) return { exitCode: EXIT_FAILED, stdout: exec.stdout, stderr: `${exec.stderr}failed: the command did not return\n` };
    return { exitCode: exec.code ?? EXIT_FAILED, stdout: exec.stdout, stderr: exec.stderr };
  } catch (error) {
    return { exitCode: EXIT_FAILED, stdout: "", stderr: `failed: ${(error as Error).message}\n` };
  }
}

/** Runs one job and then releases it. A job that was refused as busy releases nothing. If the release cannot undo everything, the outcome says so and the job directory and lock stay. */
export async function runWindowsJob(host: WindowsHost, job: WindowsJob, supervisorPaths: readonly string[], jobDir: string): Promise<JobOutcome> {
  const state = { owned: false };
  const out = await execute(host, job, supervisorPaths, jobDir, state);
  if (!state.owned) return out;
  const released = await releaseJob(host, job.settings, jobDir).catch((error: Error) => ({ ok: false as const, reason: error.message }));
  if (released.ok) return out;
  return { ...out, exitCode: out.exitCode === 0 ? EXIT_FAILED : out.exitCode, stderr: `${out.stderr}release failed: ${released.reason}\n` };
}

/** The directory the runner and everything it needs lives in; kept for callers that want to name it. */
export const supervisorDirOf = (runnerScript: string): string => win32.dirname(runnerScript);
