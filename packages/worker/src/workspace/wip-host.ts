import { WorkspaceError } from "./errors.js";
import type { CheckoutLocation, HostJson } from "./host.js";
import type { GitBridge } from "./git.js";
import { redactEnv } from "./wip-credential.js";

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
  /** The NAME of the secret the owner chose for this remote (never its value). The host resolves it from its own secret store at the moment of the push. */
  readonly credential?: string;
}
/** What the controller asks for a restore (the owner asked in chat or the API). */
export interface HostWipRestoreCall {
  readonly projectId: string;
  readonly taskId: string;
  readonly remote: string;
  readonly ref: string;
  /** The commit the controller last confirmed as a backup: the branch must be exactly this one, or nothing is restored. */
  readonly expectCommit: string;
  readonly credential?: string;
}
export type HostWipRestoreOutcome =
  | { readonly ok: true; readonly summary: string; readonly detail: { readonly [key: string]: HostJson } }
  | { readonly ok: false; readonly reason: string };
/** Where a restore may write: an empty checkout folder and a git directory that does not exist yet, chosen by the host's own layout (never by the request). */
export interface HostRestoreTarget {
  readonly checkout: string;
  readonly gitDir: string;
  /** A repository that holds the commit the work was based on (the project's shared workspace). */
  readonly baseFrom?: string;
  /** Says where the restored workspace is (plain words for the owner) and makes it final (for example, puts it in the task's own place). Called only after a successful restore. */
  readonly finish: () => Promise<string>;
  /** Removes whatever was made when the restore did not succeed. */
  readonly abandon: () => Promise<void>;
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
  /**
   * The environment ONE push or restore may need (a token header built from the secret the owner named, the address of an ssh agent). Asked per call with the remote and the secret NAME the owner chose; the host resolves
   * the value from its own secret store. Nothing else of the process's environment reaches git, and the values are redacted from every message this host returns. A throw fails the call with its (redacted) message.
   */
  readonly pushEnv?: (call: { readonly projectId: string; readonly taskId: string; readonly remote: string; readonly credential?: string }) => NodeJS.ProcessEnv | Promise<NodeJS.ProcessEnv>;
  /** Where a restore of a task goes on this host. Without it this host does not restore. */
  readonly restoreTarget?: (call: { readonly projectId: string; readonly taskId: string }) => Promise<HostRestoreTarget | { readonly problem: string }> | HostRestoreTarget | { readonly problem: string };
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

  async #env(call: { projectId: string; taskId: string; remote: string; credential?: string }): Promise<NodeJS.ProcessEnv | undefined> {
    return this.#options.pushEnv === undefined ? undefined : this.#options.pushEnv({ projectId: call.projectId, taskId: call.taskId, remote: call.remote, ...(call.credential === undefined ? {} : { credential: call.credential }) });
  }

  async #run(call: HostWipBackupCall, where: CheckoutLocation): Promise<HostWipBackupOutcome> {
    let env: NodeJS.ProcessEnv | undefined;
    try { env = await this.#env(call); } catch (error) { return { ok: false, reason: `the push credential could not be prepared: ${cut(error)}` }; }
    try {
      const r = await this.#options.git.backupWip({ gitDir: where.gitDir, checkout: where.checkout, remote: call.remote, ref: call.ref, taskId: call.taskId, projectId: call.projectId, developer: call.developer, executor: call.executor, scan: this.#options.scan, ...(env === undefined ? {} : { env }) });
      return { ok: true, summary: `${r.unchanged ? "Nothing new since the last backup; confirmed" : "Backed up"} ${r.files} file(s)${r.blocked.length > 0 ? `, ${r.blocked.length} left out` : ""}.`, detail: { commitId: r.commitId, tree: r.tree, base: r.base, unchanged: r.unchanged, files: r.files, ignored: r.ignored, blocked: r.blocked.slice(0, 50).map((b) => ({ path: b.path.slice(0, 200), reason: b.reason.slice(0, 200) })) } };
    } catch (error) {
      const reason = error instanceof WorkspaceError ? error.message : "the backup could not be made";
      return { ok: false, reason: env === undefined ? reason : redactEnv(reason, env) };
    }
  }

  /**
   * Puts a task's last confirmed backup back as a workspace (card P02b). The target is chosen by this host's own layout (`restoreTarget`), the branch must be exactly the commit the controller confirmed, and the restore
   * refuses a branch that is not an unreviewed work-in-progress commit. Whatever was made is removed when it fails.
   */
  async restore(call: HostWipRestoreCall): Promise<HostWipRestoreOutcome> {
    if (this.#options.restoreTarget === undefined) return { ok: false, reason: "this host does not restore work-in-progress backups" };
    let target: HostRestoreTarget | { problem: string };
    try { target = await this.#options.restoreTarget({ projectId: call.projectId, taskId: call.taskId }); } catch { return { ok: false, reason: "this host could not say where a restore would go" }; }
    if ("problem" in target) return { ok: false, reason: target.problem };
    let env: NodeJS.ProcessEnv | undefined;
    try { env = await this.#env(call); } catch (error) { await target.abandon().catch(() => undefined); return { ok: false, reason: `the credential could not be prepared: ${cut(error)}` }; }
    try {
      const r = await this.#options.git.restoreWip({ remote: call.remote, ref: call.ref, gitDir: target.gitDir, checkout: target.checkout, expect: call.expectCommit, ...(target.baseFrom === undefined ? {} : { baseFrom: target.baseFrom }), ...(env === undefined ? {} : { env }) });
      const where = await target.finish();
      return { ok: true, summary: `Restored ${r.files} file(s) of the backup ${r.commitId.slice(0, 12)} ${where}.`, detail: { commitId: r.commitId, base: r.base, baseFound: r.baseFound, files: r.files, where } };
    } catch (error) {
      await target.abandon().catch(() => undefined);
      const reason = error instanceof WorkspaceError ? error.message : "the restore could not be made";
      return { ok: false, reason: env === undefined ? reason : redactEnv(reason, env) };
    }
  }
}

const cut = (error: unknown): string => String((error as Error)?.message ?? error).replace(/\s+/g, " ").slice(0, 160);
