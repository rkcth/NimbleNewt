import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { SandboxError } from "../sandbox/errors.js";
import { quarantine } from "../sandbox/quarantine.js";
import { WorkspaceBridge } from "./bridge.js";
import { WorkspaceError } from "./errors.js";
import type { GitBridge } from "./git.js";

/**
 * The workspace side of a worker host (card H12m): the host that holds an agent's checkout answers the controller's three operations on it, integration, refresh and quarantine, against the real checkout with real git. The controller package
 * is not imported (the worker depends on no other package of the product), so the request and the answer are restated here and the controller's `WorkspaceCall` and `WorkspaceOutcome` fit them structurally.
 *
 * What it promises, and how:
 * - the shared repository is read, never written, except by an integration, which goes file by file through the expected-version bridge (A04): a file that moved since the base is kept for review, not overwritten;
 * - a refresh never goes over work: a checkout with a changed or new file, or with commits not yet integrated, is refused and left as it was;
 * - a quarantine moves the checkout (A03) to the owner-only quarantine root; the agent's git directory stays where it is, outside every sandbox;
 * - a host that cannot do an operation says so (`ok: false` with a reason), and so does a call for a task whose checkout is not on this host;
 * - one request ID is carried out once: a journal written before the work (`started`) and after it (`done`) answers a repeat from the record (same answer), and a repeat of a request that began but never finished is refused as
 *   uncertain, never run again (the work may be half done; running it again could duplicate a kept change); the journal is kept outside the checkout and every sandbox;
 * - operations on one checkout run one at a time.
 * Nothing here freezes the agent: the controller does that (the quiesce) before it asks.
 */
export type HostOperation = "integration" | "landing" | "refresh" | "release" | "quarantine";
export interface HostWorkspaceCall {
  readonly requestId: string;
  readonly operation: HostOperation;
  readonly taskId: string;
  readonly projectId: string;
  readonly reason: string;
  readonly quietAttempts?: readonly string[];
  /** When the controller stops waiting for the answer (an ISO time): it frees the agent then, so the host must not start the work after it. */
  readonly expiresAt?: string;
  /** The agent the task is assigned to, when the controller says (named as the author of what is carried into the shared workspace). */
  readonly assignee?: string;
}
export type HostJson = null | boolean | number | string | readonly HostJson[] | { readonly [key: string]: HostJson };
export type HostWorkspaceOutcome = { readonly ok: true; readonly summary: string; readonly detail?: { readonly [key: string]: HostJson } } | { readonly ok: false; readonly reason: string };

/** Where a task's checkout lives on this host. Every path is absolute and chosen by the host's own configuration, never by the request. */
export interface CheckoutLocation {
  /** The shared workspace (a repository with its working tree). */
  readonly shared: string;
  readonly checkout: string;
  /** The agent's separate git directory. */
  readonly gitDir: string;
  /** Where the bridge keeps its locks and the changes kept for review (outside the shared tree and every sandbox). */
  readonly bridgeState: string;
  /** The owner-only quarantine root. */
  readonly quarantineRoot: string;
}

export interface WorkspaceHostOptions {
  readonly git: GitBridge;
  /** The checkout of the task on this host, or `undefined` when this host does not hold it. */
  readonly locate: (call: { readonly taskId: string; readonly projectId: string }) => Promise<CheckoutLocation | undefined> | CheckoutLocation | undefined;
  /** A directory only the controller's side can write: one record per request. */
  readonly journal: string;
  readonly clock?: () => string;
  /**
   * Whether none of these attempts is running on this host right now. Asked just before the work starts (after any wait behind another request): a request is never carried out under a running agent. If given and it
   * answers false or throws, the request is refused and left unstarted. A host that has attempts must give it.
   */
  readonly attemptsQuiet?: (attemptIds: readonly string[], call: { readonly taskId: string; readonly projectId: string }) => Promise<boolean> | boolean;
}

const REQUEST = /^wsr-[a-z2-7]{20}$/;
const IDENT = /^[A-Za-z0-9._:-]{1,120}$/;
const OPERATIONS: readonly string[] = ["integration", "landing", "refresh", "release", "quarantine"];
export const HOST_LIMITS = { summary: 600, keptListed: 20 } as const;

interface JournalRecord { readonly operation: string; readonly taskId?: string; readonly state: "started" | "done"; readonly at: string; readonly finishedAt?: string; readonly outcome?: HostWorkspaceOutcome }

const no = (reason: string): HostWorkspaceOutcome => ({ ok: false, reason });
const cut = (text: string): string => text.replace(/\s+/g, " ").slice(0, HOST_LIMITS.summary);

export class WorkspaceHost {
  readonly #options: WorkspaceHostOptions;
  readonly #tails = new Map<string, Promise<unknown>>();
  constructor(options: WorkspaceHostOptions) {
    if (!isAbsolute(options.journal)) throw new Error("the journal folder must be an absolute path");
    this.#options = options;
  }

  /** Carries out one request. A refusal is a value; a throw means the work may have been done in part (the controller records that as uncertain). */
  async run(call: HostWorkspaceCall): Promise<HostWorkspaceOutcome> {
    if (call === null || typeof call !== "object") return no("the request is not an object");
    const { requestId, operation, taskId, projectId, reason } = call;
    if (typeof requestId !== "string" || !REQUEST.test(requestId)) return no("the request ID is not one this host accepts");
    if (typeof operation !== "string" || !OPERATIONS.includes(operation)) return no(`the operation ${JSON.stringify(String(operation).slice(0, 30))} is not one this host knows`);
    if (typeof taskId !== "string" || !IDENT.test(taskId) || typeof projectId !== "string" || !IDENT.test(projectId)) return no("the task or project name is malformed");
    if (typeof reason !== "string" || reason.length < 1 || reason.length > 500) return no("the reason is missing or too long");
    if (call.assignee !== undefined && (typeof call.assignee !== "string" || !IDENT.test(call.assignee))) return no("the assignee name is malformed");
    if (operation === "release") return no("this host does not commit reviewed work through this request: the commit needs the commit permit of the review gate (A06, H12o), which a workspace request does not carry");
    const where = await this.#options.locate({ taskId, projectId });
    if (where === undefined) return no("the checkout of that task is not on this host");
    for (const p of [where.shared, where.checkout, where.gitDir, where.bridgeState, where.quarantineRoot]) if (typeof p !== "string" || !isAbsolute(p)) return no("this host's location for the checkout is not an absolute path (a host fault)");
    // One operation at a time per checkout, and a request ID carried out once.
    return this.#serial(where.checkout, async () => {
      // Checked at the moment the work would start, after any wait behind another request: the controller may have given up and freed the agent by then.
      const stale = await this.#notNow(call);
      return stale !== undefined ? no(stale) : this.#once(call, operation as HostOperation, where);
    });
  }

  /** Why the request must not start now (its deadline passed, or an attempt it names is running), or `undefined`. Nothing is written to the journal for a request refused here, so it is not counted as begun. */
  async #notNow(call: HostWorkspaceCall): Promise<string | undefined> {
    if (call.expiresAt !== undefined) {
      const deadline = Date.parse(call.expiresAt);
      if (!Number.isFinite(deadline)) return "the request's deadline is not a time";
      if (Date.now() >= deadline) return "the controller stopped waiting for this request before it could start; it was not carried out";
    }
    if (this.#options.attemptsQuiet !== undefined) {
      let quiet = false;
      try { quiet = (await this.#options.attemptsQuiet(call.quietAttempts ?? [], { taskId: call.taskId, projectId: call.projectId })) === true; } catch { quiet = false; }
      if (!quiet) return "an attempt of the task is running on this host; the request was not carried out";
    }
    return undefined;
  }

  async #serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const run = previous.then(work, work);
    const tail = run.catch(() => undefined);
    this.#tails.set(key, tail);
    try { return await run; } finally { if (this.#tails.get(key) === tail) this.#tails.delete(key); }
  }

  async #once(call: HostWorkspaceCall, operation: HostOperation, where: CheckoutLocation): Promise<HostWorkspaceOutcome> {
    const dir = this.#options.journal;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${call.requestId}.json`);
    const earlier = await this.#read(file);
    if (earlier !== undefined) {
      if (earlier.operation !== operation || earlier.taskId !== call.taskId) return no("that request ID was used for another operation or task here");
      if (earlier.state === "done" && earlier.outcome !== undefined) return earlier.outcome;
      return no("an earlier run of this request began and did not finish, so the checkout may be half changed; it is not run again; look at the checkout and ask with a new request");
    }
    const at = (this.#options.clock ?? (() => new Date().toISOString()))();
    // The marker is created exclusively: of two callers with one request ID only one goes on.
    try { await writeFile(file, `${JSON.stringify({ operation, taskId: call.taskId, state: "started", at } satisfies JournalRecord)}\n`, { flag: "wx", mode: 0o600 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return no("this request is already being carried out here");
      throw error;
    }
    // A throw leaves the record `started`: the work may be half done, so a repeat is refused as uncertain and the controller records the request as failed.
    const outcome = await this.#do(call, operation, where);
    const record: JournalRecord = { operation, taskId: call.taskId, state: "done", at, finishedAt: (this.#options.clock ?? (() => new Date().toISOString()))(), outcome };
    const temporary = `${file}.${createHash("sha256").update(String(Math.random())).digest("hex").slice(0, 8)}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
    return outcome;
  }

  async #read(file: string): Promise<JournalRecord | undefined> {
    let text: string;
    try { text = await readFile(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    try { const parsed = JSON.parse(text) as JournalRecord; return parsed !== null && typeof parsed === "object" ? parsed : { operation: "?", state: "started", at: "" }; } catch { return { operation: "?", state: "started", at: "" }; }
  }

  async #do(call: HostWorkspaceCall, operation: HostOperation, where: CheckoutLocation): Promise<HostWorkspaceOutcome> {
    const git = this.#options.git;
    // The checkout and its git directory must be there: a task whose checkout was quarantined or never made is answered, not guessed at.
    for (const [what, path] of [["checkout", where.checkout], ["git directory", where.gitDir]] as const) {
      try { await realpath(path); } catch { return no(`the ${what} of that task is not on this host (it was removed, quarantined or never made)`); }
    }
    if (operation === "refresh") {
      // Never over work: a changed or new file, or commits not yet integrated, refuse the refresh whatever the base is (the same check the move itself makes).
      const state = await git.status({ gitDir: where.gitDir, checkout: where.checkout });
      if (state.dirty) return no(`the checkout holds ${state.entries.length} changed or new file(s); it was left as it was (its work must be committed, or the checkout quarantined, before a refresh)`);
      const before = await git.baseOf(where.gitDir);
      let target: string;
      try { target = await git.head(where.shared); } catch (error) { return no(`the shared workspace's head could not be read: ${(error as Error).message}`); }
      if (before === target) {
        return { ok: true, summary: `the checkout is already at ${target.slice(0, 12)}`, detail: { changed: false, base: target } };
      }
      try { await git.refresh({ shared: where.shared, commit: target, gitDir: where.gitDir, checkout: where.checkout }); } catch (error) {
        if (error instanceof WorkspaceError && error.code === "stale") return no(cut(error.message));
        throw error;
      }
      return { ok: true, summary: `the checkout moved from ${before.slice(0, 12)} to ${target.slice(0, 12)}`, detail: { changed: true, before, base: target } };
    }
    if (operation === "integration" || operation === "landing") {
      // A landing (card H12q) is an integration that is only done on the current head of the landing branch: the checkout's base must be that head. A moved head is the author's to refresh first (the re-apply and the queue are P10's).
      if (operation === "landing") {
        const base = await git.baseOf(where.gitDir);
        let head: string;
        try { head = await git.head(where.shared); } catch (error) { return no(`the landing branch's head could not be read: ${(error as Error).message}`); }
        if (base !== head) return no(`the checkout is based on ${base.slice(0, 12)} but the landing branch is at ${head.slice(0, 12)}; nothing was landed (the author refreshes onto the head first)`);
        // Only committed work lands: a file written after the review (or while the agent was being made quiet) is not part of what was reviewed.
        const state = await git.status({ gitDir: where.gitDir, checkout: where.checkout });
        if (state.dirty) return no(`the checkout holds ${state.entries.length} changed or new file(s) that are not committed; nothing was landed (only committed work lands)`);
      }
      const bridge = new WorkspaceBridge({ shared: where.shared, state: where.bridgeState, ...(this.#options.clock === undefined ? {} : { clock: this.#options.clock }) });
      const author = call.assignee ?? `workspace:${call.requestId}`;
      // What would be carried is checked before anything is written: a change that touches Git's data, a link or too many files is refused whole.
      let planned;
      try { planned = await git.changes({ gitDir: where.gitDir, checkout: where.checkout }); } catch (error) {
        if (error instanceof WorkspaceError && error.code !== "unavailable") return no(cut(error.message));
        throw error;
      }
      if (planned.length === 0) return { ok: true, summary: `the checkout holds no change from its base; nothing to ${operation === "landing" ? "land" : "integrate"}`, detail: { written: 0, kept: 0, skipped: 0, changed: false, ...(operation === "landing" ? { landed: false } : {}) } };
      const results = await git.integrate({ gitDir: where.gitDir, checkout: where.checkout, bridge, author, reason: call.reason });
      const written = results.filter((r) => r.result.status === "written").length;
      const kept = results.flatMap((r) => (r.result.status === "rejected" ? [{ path: r.path.slice(0, 200), pendingId: r.result.pendingId }] : []));
      const skipped = results.filter((r) => r.result.status === "skipped").length;
      let marked = false;
      if (kept.length === 0) { try { marked = (await git.markIntegrated({ gitDir: where.gitDir, checkout: where.checkout, bridge })).moved; } catch { marked = false; } }
      const summary = kept.length === 0 ? `${written} file(s) carried into the shared workspace${skipped === 0 ? "" : `, ${skipped} skipped`}` : `${written} file(s) carried, ${kept.length} kept for review because the shared file had moved since the base${skipped === 0 ? "" : `, ${skipped} skipped`}`;
      return { ok: true, summary, detail: { written, kept: kept.length, keptFiles: kept.slice(0, HOST_LIMITS.keptListed), skipped, markedIntegrated: marked, changed: written > 0, ...(operation === "landing" ? { landed: kept.length === 0 && marked } : {}) } };
    }
    // quarantine
    try {
      const record = await quarantine({ root: where.quarantineRoot, path: where.checkout, reason: call.reason, by: call.assignee ?? `workspace:${call.requestId}`, ...(this.#options.clock === undefined ? {} : { clock: this.#options.clock }) });
      return { ok: true, summary: `the checkout was moved to the quarantine (${record.files} file(s)); the agent's git directory was left where it is`, detail: { quarantineId: record.id, files: record.files, directories: record.directories, symlinks: record.symlinks, bytes: record.bytes, copied: record.copied, changed: true, removed: true } };
    } catch (error) {
      if (error instanceof SandboxError && error.code === "invalid_recipe") return no(cut(error.message));
      throw error;
    }
  }
}
