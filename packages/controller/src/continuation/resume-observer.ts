import { OBSERVE_LIMITS, checkoutDependencyObserver, locallyPlaced, type DependencyObserverOptions, type ProbeFileSystem, type ProbeLocation } from "../dependencies/observe.js";
import type { ManifestBody, Observation } from "../dependencies/dependencies.js";
import { observeOnHost, type ObserveAsker } from "../remote/observe.js";
import type { Principal } from "../security/principals.js";

/** What the resume check's dependency observer needs from the controller (card L04e). */
export interface ResumeObserverDeps {
  /** The task's recorded dependencies (what the check reads and judges). */
  manifest(taskId: string): Promise<ManifestBody | undefined>;
  /** The host the task was last placed on (the host that holds its checkout), if any. */
  placedHostOf(taskId: string): Promise<string | undefined>;
  /** The remote hosts of this installation: a task placed on one is looked at by that host, never read from this machine's disk. */
  remoteHostIds: ReadonlySet<string>;
  /** The folder the task's repository is bound at on this machine and the paths the project may use there. */
  binding(taskId: string): Promise<{ readonly root: string; readonly paths: readonly string[] } | undefined>;
  /** Where this machine's worker keeps the task's checkout (the folder an agent really worked in), or nothing. Tried before `binding`. */
  workerCheckout?(task: { readonly taskId: string; readonly projectId: string }): string | undefined | Promise<string | undefined>;
  /** The service that asks a remote host, and the principal that asks (the dispatcher). Absent: no remote host is asked. */
  remote?(): { readonly remote: ObserveAsker; readonly by: Principal } | undefined;
  /** Bounds of the local probe and of a remote host's look (the entry count). */
  limits?: Pick<DependencyObserverOptions, "maxEntries" | "maxBytes" | "maxTotalBytes" | "timeoutMs">;
  fs?: ProbeFileSystem;
  /** How long a remote host may take to answer one request, in ms (default `OBSERVE_ON_HOST.waitMs`). */
  remoteWaitMs?: number;
  /** Told of anything that left a dependency unobserved; for the log, never the owner's text. */
  onFault?(detail: string): void;
}

/**
 * The resume check's dependency observer (card L04e), answering for the task wherever its files are:
 * - a task last placed on a remote host: that host looks at the task's recorded files and directories on its own disk (`observeOnHost`, the `observe` workspace request), under the project's paths; nothing is read from this machine. A host that
 *   does not answer, refuses, or answers wrongly leaves them unobserved (unknown);
 * - a task placed on this machine (or in an installation with no remote hosts): the folder this machine's worker keeps the task's checkout in (`workerCheckout`), else the folder its repository is bound at, read by `checkoutDependencyObserver`;
 * - a task never placed, in an installation with remote hosts: nothing (it may be about to go to a remote host), so unknown.
 * It never throws.
 */
export function resumeObserver(deps: ResumeObserverDeps): (taskId: string) => Promise<Readonly<Record<string, Observation>>> {
  const local = checkoutDependencyObserver({
    manifest: (taskId) => deps.manifest(taskId),
    locate: locallyPlaced(deps.remoteHostIds, deps.placedHostOf, async (taskId, projectId): Promise<ProbeLocation | undefined> => {
      const bound = await deps.binding(taskId);
      const worker = deps.workerCheckout === undefined ? undefined : await deps.workerCheckout({ taskId, projectId });
      return worker === undefined ? bound : { root: worker, paths: bound?.paths ?? [] };
    }),
    ...(deps.limits ?? {}),
    ...(deps.fs === undefined ? {} : { fs: deps.fs }),
    ...(deps.onFault === undefined ? {} : { onFault: deps.onFault }),
  });
  const fault = (detail: string): void => { try { deps.onFault?.(detail); } catch { /* a failing log tells nothing */ } };
  const remote = async (taskId: string): Promise<Readonly<Record<string, Observation>> | undefined> => {
    if (deps.remoteHostIds.size === 0) return undefined;
    const placed = await deps.placedHostOf(taskId);
    if (placed === undefined || !deps.remoteHostIds.has(placed)) return undefined;
    const asker = deps.remote?.();
    if (asker === undefined) return {};
    const manifest = await deps.manifest(taskId);
    const entries = (manifest?.entries ?? []).filter((e) => e.kind === "file" || e.kind === "directory").sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, deps.limits?.maxEntries ?? OBSERVE_LIMITS.entries).map((e) => ({ id: e.id, kind: e.kind as "file" | "directory", key: e.key }));
    if (manifest === undefined || entries.length === 0) return {};
    const paths = (await deps.binding(taskId))?.paths;
    return await observeOnHost(asker, placed, { taskId, projectId: manifest.projectId }, entries, paths, { onFault: fault, ...(deps.remoteWaitMs === undefined ? {} : { waitMs: deps.remoteWaitMs }) });
  };
  return async (taskId) => {
    try { const there = await remote(taskId); if (there !== undefined) return there; } catch (error) { fault(`the look at ${taskId}'s files on its host failed: ${error instanceof Error ? error.message : String(error)}`); return {}; }
    return await local(taskId);
  };
}
