import { WorkspaceError } from "./errors.js";
import type { CheckoutLocation, HostJson } from "./host.js";
import type { GitBridge } from "./git.js";

/**
 * The host side of the optional work-in-progress backup (card P02b). The controller (which owns the setting, the owner's standing approval and the schedule) asks; this host, which holds the checkout, makes the commit
 * from a temporary index in the checkout's own git directory and pushes it with `GitBridge.backupWip`. It does not decide whether a backup may be made: it is only asked by a controller that has checked the owner's
 * approval, and it still refuses any branch outside `refs/heads/nn-wip/`, never forces, and runs `scan` over every file first (a host with no scan cannot be built: no scan, no push).
 * The worker imports nothing of the controller, so the request and the answer are restated here and the controller's `WipBackupCall` and `WipBackupOutcome` fit them structurally.
 */
export interface HostWipBackupCall {
  readonly projectId: string;
  readonly taskId: string;
  /** The folder or address the owner named. */
  readonly remote: string;
  /** The full branch, `refs/heads/nn-wip/<project>/<task>`. */
  readonly ref: string;
  readonly developer: string;
  readonly executor: string;
}
export type HostWipBackupOutcome =
  | { readonly ok: true; readonly summary: string; readonly detail: { readonly [key: string]: HostJson } }
  | { readonly ok: false; readonly reason: string };

export interface WipBackupHostOptions {
  readonly git: GitBridge;
  /** The checkout of the task on this host, or `undefined` when this host does not hold it. */
  readonly locate: (call: { readonly taskId: string; readonly projectId: string }) => Promise<CheckoutLocation | undefined> | CheckoutLocation | undefined;
  /** Says why a file may not leave the machine (a credential shape, a secret value in use), or nothing when it may. Required. */
  readonly scan: (file: { path: string; bytes: Buffer }) => string | undefined | Promise<string | undefined>;
  /** Environment a push may need (for example the address of a credential agent). Nothing else of the process's environment reaches git. */
  readonly pushEnv?: () => NodeJS.ProcessEnv;
}

export class WipBackupHost {
  readonly #options: WipBackupHostOptions;
  readonly #tails = new Map<string, Promise<unknown>>();

  constructor(options: WipBackupHostOptions) {
    if (typeof options.scan !== "function") throw new Error("a work-in-progress backup host needs a scan of the files it sends");
    this.#options = options;
  }

  async backup(call: HostWipBackupCall): Promise<HostWipBackupOutcome> {
    let where: CheckoutLocation | undefined;
    try { where = await this.#options.locate({ taskId: call.taskId, projectId: call.projectId }); } catch { return { ok: false, reason: "this host could not say where the task's checkout is" }; }
    if (where === undefined) return { ok: false, reason: "this host does not hold the task's checkout" };
    // One backup of a checkout at a time (a second ask waits for the first).
    const run = (this.#tails.get(where.gitDir) ?? Promise.resolve()).catch(() => undefined).then(() => this.#run(call, where!));
    this.#tails.set(where.gitDir, run);
    try { return await run; } finally { if (this.#tails.get(where.gitDir) === run) this.#tails.delete(where.gitDir); }
  }

  async #run(call: HostWipBackupCall, where: CheckoutLocation): Promise<HostWipBackupOutcome> {
    try {
      const r = await this.#options.git.backupWip({ gitDir: where.gitDir, checkout: where.checkout, remote: call.remote, ref: call.ref, taskId: call.taskId, projectId: call.projectId, developer: call.developer, executor: call.executor, scan: this.#options.scan, ...(this.#options.pushEnv === undefined ? {} : { env: this.#options.pushEnv() }) });
      return { ok: true, summary: `${r.unchanged ? "Nothing new since the last backup; confirmed" : "Backed up"} ${r.files} file(s)${r.blocked.length > 0 ? `, ${r.blocked.length} left out` : ""}.`, detail: { commitId: r.commitId, tree: r.tree, base: r.base, unchanged: r.unchanged, files: r.files, ignored: r.ignored, blocked: r.blocked.slice(0, 50).map((b) => ({ path: b.path.slice(0, 200), reason: b.reason.slice(0, 200) })) } };
    } catch (error) {
      return { ok: false, reason: error instanceof WorkspaceError ? error.message : "the backup could not be made" };
    }
  }
}
