import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { attemptSandbox } from "../sandbox/attempt.js";
import type { SandboxLauncher } from "../sandbox/launcher.js";
import type { ResourceLimits } from "../sandbox/limits.js";
import type { ReadOnlyMount } from "../sandbox/recipe.js";
import type { GitBridge } from "./git.js";
import type { CheckoutLocation } from "./host.js";

/**
 * The host side of the landing gate (card P09): the change a landing of the task's checkout would carry and the project's required test commands run on exactly the tree that landing would make. A landing is made only while
 * the checkout's base is the landing branch's head, so the tree of the checkout's head commit IS the integrated tree. Each check gets a fresh copy of that tree (`GitBridge.exportTree`, never the checkout itself, so a check
 * cannot change what is landed and leaves nothing in the checkout), an empty home and scratch of its own, no network and no git directory, in the sandbox (`SandboxLauncher`); the copy is removed afterwards. A check that
 * cannot be started, a launch the sandbox refuses or a copy that cannot be made is `not-run` with the reason, which the controller counts as failed. When the call's `signal` is aborted (the controller gave up waiting), the
 * running check's processes are killed and no further check starts, so nothing keeps running on a copy after the landing was refused.
 */
export interface LandingCheckCall {
  readonly taskId: string;
  readonly projectId: string;
  /** The commands to run (the task contract's checks), one after another. */
  readonly checks: readonly { readonly name: string; readonly run: readonly string[]; readonly timeoutMs: number }[];
  /** Each stream of a check is cut at this many bytes. */
  readonly maxOutputBytes: number;
  /** The reviewed code submission's base commit and tree: their stable patch ID is computed here from this checkout's own objects (`reviewedPatchId`), so the controller does not rely on the patch ID the submitter named. */
  readonly reviewed?: { readonly base: string; readonly tree: string };
  /** Aborted when the controller stops waiting for the answer: the running check's whole process tree is killed (`SandboxRun.kill`) and no further check is started; each is then `not-run`. */
  readonly signal?: AbortSignal;
}
export interface LandingCheckRun { readonly name: string; readonly state: "passed" | "failed" | "not-run"; readonly exitCode?: number | null; readonly signal?: string | null; readonly timedOut?: boolean; readonly output?: string; readonly reason?: string; readonly ms?: number }
export interface LandingCheckReport {
  /** False: this host holds no checkout for the task (nothing was run). */
  readonly checkout: boolean;
  /** The committed change a landing would carry: base, head commit, the head's tree (the integrated tree) and its patch ID (absent when the head is the base). Absent when it could not be read. */
  readonly change?: { readonly base: string; readonly head: string; readonly tree: string; readonly patchId?: string };
  /** Why the change could not be read. */
  readonly problem?: string;
  /** One per check asked for, in order; each ran on `change.tree`. */
  readonly checks: readonly LandingCheckRun[];
  /** When `reviewed` was asked: the stable patch ID of its base..tree, or why it could not be computed. */
  readonly reviewedPatchId?: string;
  readonly reviewedProblem?: string;
}
export interface LandingChecksOptions {
  readonly git: GitBridge;
  /** Where the task's checkout is on this host (`LocalWorkspaces.locate`). */
  readonly locate: (call: { readonly taskId: string; readonly projectId: string }) => CheckoutLocation | undefined | Promise<CheckoutLocation | undefined>;
  readonly launcher: Pick<SandboxLauncher, "launch">;
  /** Read-only inputs every check sees (a language runtime such as Node.js, as `/opt/node`). Nothing else of the host is mounted. */
  readonly readOnly?: readonly ReadOnlyMount[];
  /** The checks' environment besides HOME, PATH and TMPDIR. Nothing is inherited from the host. */
  readonly env?: Readonly<Record<string, string>>;
  /** The owner's limits for a check, read at each run; a throw makes the check `not-run`. The wall time, when smaller than the check's own, ends it. */
  readonly limits?: () => ResourceLimits | undefined | Promise<ResourceLimits | undefined>;
  /** Whether the owner allowed best effort, read at each run: a limit this host cannot enforce in full then does not refuse the run. Default (absent): refused. A throw makes the check `not-run`. */
  readonly bestEffort?: () => boolean | Promise<boolean>;
  /** An absolute folder for the copies (default the system's temporary folder). */
  readonly base?: string;
}

/** How much of a check's output is handed back (its end). */
export const LANDING_CHECK_OUTPUT_CHARS = 2000;
const MAX_RUN_MS = 24 * 60 * 60 * 1000;
const tail = (text: string): string => (text.length <= LANDING_CHECK_OUTPUT_CHARS ? text : text.slice(-LANDING_CHECK_OUTPUT_CHARS));
/** Read through a call so a check made earlier does not narrow it: the signal can be aborted at any await. */
const stopped = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;
const STOPPED = "the controller stopped waiting for the landing checks, so this check was stopped";
const reason = (error: unknown): string => String((error as Error)?.message ?? error).replace(/\s+/g, " ").slice(0, 300);

export function landingChecks(options: LandingChecksOptions): (call: LandingCheckCall) => Promise<LandingCheckReport> {
  if (options.base !== undefined && !isAbsolute(options.base)) throw new Error("the folder for landing check copies must be an absolute path");
  return async (call) => {
    const asked = Array.isArray(call.checks) ? call.checks : [];
    const notRun = (why: string): LandingCheckRun[] => asked.map((c) => ({ name: String(c?.name ?? ""), state: "not-run" as const, reason: why }));
    const where = await options.locate({ taskId: call.taskId, projectId: call.projectId });
    if (where === undefined) return { checkout: false, checks: notRun("this host holds no checkout for the task") };
    let change: LandingCheckReport["change"];
    try { change = await options.git.committedChange({ gitDir: where.gitDir }); } catch (error) { return { checkout: true, problem: reason(error), checks: notRun(`the checkout's committed change could not be read: ${reason(error)}`) }; }
    const ran: LandingCheckRun[] = [];
    let reviewed: { reviewedPatchId: string } | { reviewedProblem: string } | Record<string, never> = {};
    if (call.reviewed !== undefined) {
      try {
        const id = await options.git.patchId({ gitDir: where.gitDir, base: String(call.reviewed?.base), to: String(call.reviewed?.tree) });
        reviewed = id === undefined ? { reviewedProblem: "the reviewed base and tree hold no change" } : { reviewedPatchId: id };
      } catch (error) { reviewed = { reviewedProblem: `the reviewed change could not be read: ${reason(error)}` }; }
    }
    for (const check of asked) ran.push(stopped(call.signal) ? { name: String(check?.name ?? ""), state: "not-run", reason: STOPPED } : await runOne(options, where, change!.tree, check, call.maxOutputBytes, call.signal));
    return { checkout: true, change, checks: ran, ...reviewed };
  };
}

async function runOne(options: LandingChecksOptions, where: CheckoutLocation, tree: string, check: LandingCheckCall["checks"][number], maxOutputBytes: number, signal: AbortSignal | undefined): Promise<LandingCheckRun> {
  const name = String(check?.name ?? "");
  if (!Array.isArray(check?.run) || check.run.length === 0 || check.run.some((a) => typeof a !== "string" || a.includes("\0"))) return { name, state: "not-run", reason: "the check names no program" };
  let limits: ResourceLimits;
  let bestEffort: boolean;
  try { limits = (await options.limits?.()) ?? {}; bestEffort = (await options.bestEffort?.()) === true; } catch (error) { return { name, state: "not-run", reason: `the owner's limits could not be read: ${reason(error)}` }; }
  const { wallTimeMs, ...processLimits } = limits as ResourceLimits & { wallTimeMs?: number };
  const timeoutMs = Math.max(1, Math.min(MAX_RUN_MS, Number.isFinite(check.timeoutMs) ? check.timeoutMs : 1, wallTimeMs ?? MAX_RUN_MS));
  let directory: string;
  try {
    if (options.base !== undefined) await mkdir(options.base, { recursive: true, mode: 0o700 });
    directory = await realpath(await mkdtemp(join(options.base ?? tmpdir(), "nn-landing-check-")));
  } catch (error) { return { name, state: "not-run", reason: `no folder could be made for the check: ${reason(error)}` }; }
  try {
    const work = join(directory, "work"), home = join(directory, "home"), scratch = join(directory, "scratch");
    await mkdir(work); await mkdir(home); await mkdir(scratch);
    try { await options.git.exportTree({ gitDir: where.gitDir, tree, into: work }); } catch (error) { return { name, state: "not-run", reason: `the integrated tree could not be copied for the check: ${reason(error)}` }; }
    if (stopped(signal)) return { name, state: "not-run", reason: STOPPED };
    let run;
    try {
      // The task's git directory is named so the sandbox refuses any mount that reaches it; nothing of it is mounted.
      const { recipe } = attemptSandbox({ checkout: work, gitDir: where.gitDir, home, scratch, readOnly: [...(options.readOnly ?? [])], env: { ...(options.env ?? {}) } }, { protectedPaths: [] });
      run = await options.launcher.launch({ recipe, command: [...check.run], timeoutMs, maxOutputBytes: Math.max(1, Math.min(64 * 1024 * 1024, Math.floor(maxOutputBytes) || 1)), ...(Object.keys(processLimits).length === 0 ? {} : { limits: processLimits }), requireEnforced: !bestEffort });
    } catch (error) { return { name, state: "not-run", reason: `the sandbox refused the check: ${reason(error)}` }; }
    // The controller giving up kills the whole process tree of this check (the launcher kills its process group and any survivor it found).
    const stop = (): void => { try { run.kill(); } catch { /* already ended */ } };
    if (stopped(signal)) stop(); else signal?.addEventListener("abort", stop, { once: true });
    let result;
    try { result = await run.result; } finally { signal?.removeEventListener("abort", stop); }
    if (stopped(signal) && result.killed) return { name, state: "not-run", reason: STOPPED, ms: result.durationMs };
    const both = `${result.stdout}${result.stdout !== "" && result.stderr !== "" && !result.stdout.endsWith("\n") ? "\n" : ""}${result.stderr}`;
    const output = tail(both);
    const shown = { exitCode: result.exitCode, signal: result.signal, ms: result.durationMs, ...(output === "" ? {} : { output }) };
    if (result.releaseProblem !== undefined) return { name, state: "not-run", reason: `the sandbox could not be cleaned up after the check: ${reason(result.releaseProblem)}`, ...shown };
    if (result.exitCode === null && result.signal === null && !result.timedOut && !result.killed) return { name, state: "not-run", reason: `the check could not be started: ${reason(result.stderr.replace(/^could not start: /, ""))}`, ms: result.durationMs };
    if (result.timedOut) return { name, state: "failed", timedOut: true, ...shown };
    return { name, state: result.exitCode === 0 && !result.killed ? "passed" : "failed", ...shown };
  } finally { await rm(directory, { recursive: true, force: true }).catch(() => undefined); }
}
