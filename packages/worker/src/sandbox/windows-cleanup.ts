import { listSandboxes } from "./windows-list.js";
import type { WindowsHost } from "./windows-host.js";
import { releaseJob } from "./windows-job.js";
import { verifyClient, type WindowsSettings } from "./windows-plan.js";

/*
 * After an evidence run on the owner's Windows machine (own-hardware.yml): what a run that was stopped hard (a step or job timeout, a cancelled run) left behind. A normal run releases
 * its own jobs; a killed one cannot, and the folders it used are per-run, so the next run's health check would never see them. This looks only in the folders those runs use
 * (`%ProgramData%\nn-wsb-real-*` and `nn-wsb-host-*` of the real tests, and the G05 suite's base under the runner's temporary folder), and releases each job left there through the
 * backend's own `releaseJob`: the sandbox the job recorded is stopped, the saved access lists are restored, the lock and the job folder go. A control folder whose lock a live process
 * holds is not touched at all, nor one that is or passes through a link or junction. A test's base folder is removed only when nothing is left in its jobs folder. Nothing else on the
 * machine is looked at.
 */

/** The control folders the evidence runs use, as found on this machine. */
export function evidenceControlDirs(host: WindowsHost): string[] {
  const out: string[] = [];
  const data = host.env("ProgramData");
  if (data !== undefined && data !== "") {
    for (const name of host.listDir(data)) {
      if (!/^nn-wsb-(?:real|host)-[A-Za-z0-9]{6}$/.test(name)) continue;
      for (const c of host.listDir(`${data}\\${name}`)) if (/^control(?:-acl)?$/i.test(c)) out.push(`${data}\\${name}\\${c}`);
    }
  }
  const g05 = host.env("NIMBLENEWT_G05_WSB_BASE") ?? (host.env("RUNNER_TEMP") === undefined ? undefined : `${host.env("RUNNER_TEMP")!}\\nn-g05-wsb`);
  if (g05 !== undefined && host.exists(`${g05}\\control`)) out.push(`${g05}\\control`);
  return out;
}

export interface LeftoverResult {
  /** Jobs whose sandbox, access lists, lock and folder were released. */
  readonly released: number;
  /** Jobs that could not be released (their record is kept for the owner, and the reason says why). */
  readonly kept: readonly string[];
  /** Test base folders removed because nothing was left in them. */
  readonly removedBases: number;
}

/** Releases every job left in the given control folders. `owner` and `shareIdentity` are only needed to verify the Windows Sandbox client before a stop. */
export async function releaseLeftovers(host: WindowsHost, controlDirs: readonly string[], identity: { readonly owner: string; readonly shareIdentity: string }): Promise<LeftoverResult> {
  let released = 0;
  const kept: string[] = [];
  /** Per test base folder: whether everything in all of its control folders was released and no live process holds a lock there. */
  const bases = new Map<string, boolean>();
  for (const controlDir of controlDirs) {
    const settings = settingsFor(controlDir, identity);
    const base = controlDir.slice(0, controlDir.lastIndexOf("\\"));
    // A folder whose lock a live process holds is in use (a run going on now): nothing in it is touched, not even the job that holds the lock.
    if (lockHeld(host, controlDir)) { kept.push(`${controlDir} is in use by a running process`); if (TEST_BASE.test(base)) bases.set(base, false); continue; }
    // A folder reached through a link or junction (its own name, its base or its jobs folder) may lead outside the evidence runs' folders: nothing in it is touched.
    if (host.isLinkOrJunction(controlDir) || host.isLinkOrJunction(`${controlDir}\\jobs`)) { kept.push(`${controlDir} is or passes through a link or junction; not touched`); if (TEST_BASE.test(base)) bases.set(base, false); continue; }
    let left = 0;
    for (const job of host.listDir(`${controlDir}\\jobs`)) {
      const jobDir = `${controlDir}\\jobs\\${job}`;
      if (host.isLinkOrJunction(jobDir)) { kept.push(`${jobDir} is a link or junction; not touched`); left++; continue; }
      const result = await releaseJob(host, settings, jobDir).catch((error: unknown) => ({ ok: false as const, reason: (error as Error).message }));
      if (result.ok) released++; else { kept.push(result.reason); left++; }
    }
    if (TEST_BASE.test(base)) bases.set(base, (bases.get(base) ?? true) && left === 0);
  }
  // A test's own base folder (under ProgramData) goes only when every control folder in it is clear; the G05 base is under the runner's temporary folder, which the runner empties.
  let removedBases = 0;
  for (const [base, clear] of bases) {
    const others = host.listDir(base).filter((c) => /^control/i.test(c) && !controlDirs.some((d) => d.toLowerCase() === `${base}\\${c}`.toLowerCase()));
    if (clear && others.length === 0) { host.remove(base); removedBases++; }
  }
  return { released, kept, removedBases };
}

const TEST_BASE = /\\nn-wsb-(?:real|host)-[A-Za-z0-9]{6}$/;

function lockHeld(host: WindowsHost, controlDir: string): boolean {
  const text = host.readText(`${controlDir}\\sandbox.lock`);
  if (text === undefined) return false;
  try { const pid = (JSON.parse(text) as { pid?: unknown }).pid; return typeof pid === "number" && pid !== host.pid && host.pidAlive(pid); } catch { return false; }
}

const settingsFor = (controlDir: string, identity: { readonly owner: string; readonly shareIdentity: string }): WindowsSettings => ({ controlDir, owner: identity.owner, shareIdentity: identity.shareIdentity, minVersion: "0.0", mode: "owner-session", lockTask: "NimbleNewt-LockOnLogon" });

/** Whether any Windows Sandbox is running now (`unknown` when the verified client could not list them). Read only: nothing is stopped. */
export async function sandboxRunning(host: WindowsHost, identity: { readonly owner: string; readonly shareIdentity: string }): Promise<"none" | "running" | "unknown"> {
  const client = await verifyClient(host, settingsFor("", identity)).catch(() => undefined);
  if (client === undefined || !client.ok) return "unknown";
  const listed = await listSandboxes(host, client.value);
  if (!listed.ok) return "unknown";
  return /[0-9a-f]{8}-[0-9a-f]{4}-/i.test(listed.stdout) ? "running" : "none";
}
