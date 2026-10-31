import { existsSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { WorkspaceError } from "./errors.js";
import type { GitBridge } from "./git.js";
import { WorkspaceHost, type CheckoutLocation, type HostWorkspaceCall, type HostWorkspaceOutcome } from "./host.js";

/**
 * The production workspace port of a local worker host (card H12q): one folder layout for the checkouts on this machine, shared by the host that makes an attempt's workspace (`ensure`) and the host that answers the
 * controller's integration, landing, refresh and quarantine for it (`port`), so they cannot disagree about where a task's checkout is. Where things live is this machine's own configuration; a request names a task and a project and
 * nothing else (both checked as plain names), so no part of a request reaches a path.
 *
 *   <root>/<project>/<task>/checkout   the agent's checkout (the only part the sandbox mounts)
 *   <root>/<project>/<task>/task.git   the agent's separate git directory (never mounted)
 *   <root>/<project>/<task>/state      the bridge's locks and the changes kept for review
 *   <root>/quarantine                  the owner-only quarantine
 *   <root>/journal                     one record per request ID
 *
 * `busy` is asked just before any work starts: the attempts of the request that have a call in flight on this host. A request is never carried out under one (the controller's quiesce has settled them; this is the host checking it).
 */
export interface LocalWorkspacesOptions {
  /** An absolute folder this host owns for checkouts. */
  readonly root: string;
  /** The shared repository (the landing branch's working tree) of a project, or `undefined` when this host holds none for it. */
  readonly shared: (projectId: string) => string | undefined;
  readonly git: GitBridge;
  /** The attempts that have a call or model call in flight on this host right now (`LocalWorker.busyAttempts`). */
  readonly busy: () => readonly string[];
  readonly clock?: () => string;
}

const NAME = /^[A-Za-z0-9._:-]{1,120}$/;
const plain = (value: string): boolean => NAME.test(value) && value !== "." && value !== ".." && !value.includes("..");

export class LocalWorkspaces {
  readonly #options: LocalWorkspacesOptions;
  readonly host: WorkspaceHost;
  /** What a `LocalWorker` takes as its `workspace` option (and what a remote worker's responder runs). */
  readonly port: { run(call: HostWorkspaceCall): Promise<HostWorkspaceOutcome> };

  constructor(options: LocalWorkspacesOptions) {
    if (typeof options.root !== "string" || !isAbsolute(options.root) || normalize(options.root) !== options.root) throw new WorkspaceError("invalid_path", "the workspace root must be an absolute, normalised path");
    this.#options = options;
    this.host = new WorkspaceHost({
      git: options.git,
      journal: join(options.root, "journal"),
      locate: (call) => this.locate(call),
      // Fails closed: a host that cannot say which attempts are busy does not carry the request out (the host treats a throw as not quiet).
      attemptsQuiet: (attemptIds) => { const busy = new Set(options.busy()); return !attemptIds.some((id) => busy.has(id)); },
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
    this.port = { run: (call) => this.host.run(call) };
  }

  /** Where the task's checkout is, or `undefined` when this host holds none for it (no shared repository for the project, a malformed name, or nothing made yet). */
  locate(call: { readonly taskId: string; readonly projectId: string }): CheckoutLocation | undefined {
    if (!plain(call.taskId) || !plain(call.projectId)) return undefined;
    const shared = this.#options.shared(call.projectId);
    if (shared === undefined) return undefined;
    const dir = join(this.#options.root, call.projectId, call.taskId);
    if (!existsSync(dir)) return undefined;
    return { shared, checkout: join(dir, "checkout"), gitDir: join(dir, "task.git"), bridgeState: join(dir, "state"), quarantineRoot: join(this.#options.root, "quarantine") };
  }

  /**
   * The checkout for an attempt's workspace: made from the shared repository's head the first time, found again afterwards (a second attempt of the same task works in the same checkout). A checkout that was quarantined is not
   * made again here: the task's folder is still there and its git directory is kept, so this refuses rather than start the agent on an empty folder.
   */
  async ensure(call: { readonly taskId: string; readonly projectId: string }): Promise<{ readonly checkout: string; readonly gitDir: string }> {
    if (!plain(call.taskId) || !plain(call.projectId)) throw new WorkspaceError("invalid_path", "the task or project name is not a plain name");
    const shared = this.#options.shared(call.projectId);
    if (shared === undefined) throw new WorkspaceError("unavailable", "this host holds no shared repository for that project");
    const dir = join(this.#options.root, call.projectId, call.taskId);
    const where = { checkout: join(dir, "checkout"), gitDir: join(dir, "task.git") };
    if (existsSync(where.gitDir)) {
      if (!existsSync(where.checkout)) throw new WorkspaceError("unavailable", "the task's checkout was removed or quarantined; it is not made again over the kept git directory");
      return where;
    }
    await this.#options.git.createCheckout({ shared, commit: await this.#options.git.head(shared), ...where });
    return where;
  }
}
