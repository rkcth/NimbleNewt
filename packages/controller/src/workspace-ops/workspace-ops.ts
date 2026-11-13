import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, taskId as checkTaskId, text, type TaskBody } from "../domain/model.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import type { QuiesceCoordinator } from "../dispatch/quiesce.js";
import { QuiesceRefused } from "../dispatch/quiesce.js";
import { allowsExactly, inTaskScope } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { Aggregate, AggregateRef, Change, JsonObject } from "../storage/types.js";

/**
 * Integration, checkout refresh and quarantine of an agent's work as controller operations (cards H12l and H12d), and the author's own refresh (`reapply`, card H12p: the agent asks for it itself through `work.refresh`, with no quiesce, and the record counts the refresh rounds of the task). The file work lives on the host that holds the checkout (the worker's workspace code), so the controller asks
 * the host through a `WorkspacePort`; this service is what makes that safe and answerable: the caller needs `workspace.manage` on the task's project (the owner always has it; a task credential never does), the request is
 * recorded before anything runs, and the host is asked only while every live attempt of the task is quiet (`QuiesceCoordinator.around`: new calls refused, calls in flight settled, a checkpoint taken). If an attempt cannot be made
 * quiet the operation does not run and the answer says which blocker. One operation runs per task at a time (a second is `unavailable` until the first ends). The attempts this operation may freeze are written into its record before it starts, and each freeze carries the request's ID, so a
 * controller that crashed can release exactly those (`recover`, or the next request for the task). A repeat of a command returns the recorded answer; a request that was recorded but whose outcome was never written is answered `uncertain` and is not run
 * again, because the host may have done it; if the original call then finishes it replaces `uncertain` with what really happened.
 */
export const WORKSPACE_OPERATIONS = ["integration", "landing", "refresh", "reapply", "release", "quarantine"] as const;
export type WorkspaceOperation = (typeof WORKSPACE_OPERATIONS)[number];
export type WorkspaceState = "started" | "done" | "refused" | "failed" | "uncertain";

export const WORKSPACE_LIMITS = { reason: 500, summary: 1000, detailBytes: 4000 } as const;

const RECORD = "workspace-request";
/** One record per task: the request that is open on it, if any (so a leftover is found without reading every request ever made). */
const OPEN = "workspace-open";
/** One record per task: how many refresh rounds the author has made (card H12p), counted in the same write that records the finished request. */
const ROUNDS = "workspace-rounds";
const WORKSPACE_ID = /^wsr-[a-z2-7]{20}$/;
/** A freeze set for this request says so in its reason (the quiesce writes the tag); recovery lifts only that one. */
const frozenFor = (reason: string, requestId: string): boolean => /^(integration|landing|refresh|reapply|release|quarantine): the agent's work is being changed \(/.test(reason) && reason.endsWith(`(${requestId})`);

/** What the host is asked, with the attempts that were made quiet for it. */
export interface WorkspaceCall {
  readonly requestId: string;
  readonly operation: WorkspaceOperation;
  readonly taskId: string;
  readonly projectId: string;
  readonly reason: string;
  readonly quietAttempts: readonly string[];
  /** The agent the task is assigned to (the request is recorded against it, and what is carried into the shared workspace is attributed to it). Absent when nobody is assigned. */
  readonly assignee?: string;
  /**
   * The owner's landing policy as the controller read it for this landing (card H12a). Set only by the remote host's port, which reads it fresh from the same reader a local host uses and carries it in the request to a
   * host that cannot read the controller's settings. A local host reads the policy itself and ignores this.
   */
  readonly landing?: CarriedLanding;
}
/** The owner's landing figures that travel to a remote host: the owner-set values only (branch, whether the commit permit is required, extra protected paths, whether the built-in protected list applies). */
export interface CarriedLanding {
  readonly branch?: string;
  readonly requirePermit?: boolean;
  readonly protectedPaths?: readonly string[];
  readonly protectDefaults?: boolean;
}
export type WorkspaceOutcome = { readonly ok: true; readonly summary: string; readonly detail?: JsonObject } | { readonly ok: false; readonly reason: string };
/** The host side of the operations. A host that cannot do one answers `ok: false` with why (a typed refusal, not a fault). */
export interface WorkspacePort { run(call: WorkspaceCall): Promise<WorkspaceOutcome> }

export interface WorkspaceRecordBody {
  readonly operation: WorkspaceOperation;
  readonly taskId: string;
  readonly projectId: string;
  readonly requestedBy: string;
  readonly reason: string;
  readonly state: WorkspaceState;
  readonly at: string;
  readonly finishedAt?: string;
  readonly summary?: string;
  readonly detail?: JsonObject;
  /** The agent the task was assigned to when the request was made (the request is recorded against it); absent when nobody was. */
  readonly assignee?: string;
  /** The attempts that were quiet while the host worked. */
  readonly quietAttempts?: readonly string[];
  /** The attempts that were told their checkout changed (refresh, integration), and those that were stopped because their checkout was quarantined. */
  readonly told?: readonly string[];
  readonly stopped?: readonly string[];
  /** The attempts this operation froze and has not released yet (kept so a crash cannot leave them frozen). */
  readonly held?: readonly string[];
  /** The blocker opened when an attempt could not be made quiet. */
  readonly blocker?: string;
  /** For a `reapply` that moved the checkout onto a newer head (card H12p): the number of this refresh round for the task (the first is 1). Not set for any other request, nor for a refresh that found the checkout at the head already. */
  readonly round?: number;
  /** The integrator lease a landing was made under (card P10), for the record. */
  readonly lease?: { readonly leaseId: string; readonly fence: number };
}
export interface WorkspaceAnswer extends WorkspaceRecordBody { readonly id: string; readonly replayed: boolean }

export interface WorkspaceDeps {
  readonly quiesce: Pick<QuiesceCoordinator, "around">;
  /** The host's side for the task's checkout (the host that runs its live attempt, else the one its checkout is pinned to); `undefined` when no host that can do this holds it. */
  readonly portOf: (taskId: string) => Promise<WorkspacePort | undefined>;
  /** The live attempts of a task, what an attempt's freeze says (`undefined`: not frozen), and lifting it. For recovery. `tell` puts a text before a running agent (returns whether it reached a worker) and `stop` ends an attempt (card H12m). */
  readonly attempts?: { live(taskId: string): Promise<string[]>; frozenReason(attemptId: string): Promise<string | undefined>; release(attemptId: string): Promise<void>; tell?(attemptId: string, text: string): Promise<boolean>; stop?(attemptId: string, reason: string): Promise<void> };
  /** Tells the owner (a needs-you notice, once per request): landed files wait uncommitted in the shared tree, or a landing was refused because the tree is not clean. */
  readonly notify?: (notice: { commandId: string; taskId: string; text: string }) => Promise<void>;
  /** An attempt as the dispatcher knows it (card H12p): its task, its agent, whether it is live and whether it was stopped. Needed for `reapply` (the author's own refresh); without it that operation is unavailable. */
  readonly attemptOf?: (attemptId: string) => Promise<{ readonly taskId: string; readonly agentId: string; readonly live: boolean; readonly stopped?: boolean } | undefined>;
  /** Whether the task is paused (card H12p review): the author's own refresh rewrites files, so it is refused while the task is paused, here as well as at the tool bridge (a client that calls the API directly is refused too). */
  readonly paused?: (taskId: string) => Promise<boolean>;
  /** The agent the task is assigned to, if anyone is. */
  readonly assignee?: (taskId: string) => Promise<string | undefined>;
  /**
   * The integrator lease check of a landing (card P10). When given, a `landing` is made only under the project's lease: `request` must name `leaseId` and `fence`, and this is asked when the request is made and again right
   * before the host is asked (a long quiesce may outlast the lease); it throws when the lease is not the caller's live hold on the landing branch. When absent (no lease service composed), landings are not gated here.
   */
  readonly landingLease?: (by: Principal, call: { taskId: string; projectId: string; leaseId: unknown; fence: unknown }) => Promise<{ readonly leaseId: string; readonly fence: number } | void>;
}

const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const json = (value: object): JsonObject => value as unknown as JsonObject;
const clean = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
/** Text from a host or a fault, bounded and with anything credential-shaped removed. */
const safe = (value: unknown, max: number): string => redactText(typeof value === "string" ? value : String((value as Error)?.message ?? value)).slice(0, max);
/** A refresh's conflict list as the host sent it, with each path that looks like a credential withheld by itself (the whole detail would otherwise be dropped by `boundedDetail`, and the agent would lose the list of what to fix). */
const cleanReapplyDetail = (value: unknown): unknown => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const d = value as { conflicts?: unknown };
  if (!Array.isArray(d.conflicts)) return value;
  return { ...d, conflicts: d.conflicts.map((c) => (c !== null && typeof c === "object" && typeof (c as { path?: unknown }).path === "string" && redactText((c as { path: string }).path) !== (c as { path: string }).path ? { ...(c as object), path: "(a name that looks like a key; look in the checkout)" } : c)) };
};
/** A host's detail, kept only when it is plain JSON of a bounded size with nothing credential-shaped in it. */
const boundedDetail = (value: unknown): JsonObject | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const encoded = JSON.stringify(value);
    return Buffer.byteLength(encoded, "utf8") <= WORKSPACE_LIMITS.detailBytes && redactText(encoded) === encoded ? JSON.parse(encoded) as JsonObject : undefined;
  } catch { return undefined; }
};

export class WorkspaceOpService {
  readonly #runner: CommandRunner;
  readonly #deps: WorkspaceDeps;
  /** Tasks with an operation running in this process, and the request behind each. One controller holds the epoch, so this is the lock. */
  readonly #busy = new Map<string, string>();
  private constructor(runner: CommandRunner, deps: WorkspaceDeps) { this.#runner = runner; this.#deps = deps; }
  static withEpoch(storage: ConstructorParameters<typeof CommandRunner>[0], epoch: number, deps: WorkspaceDeps, options: RunnerOptions = {}): WorkspaceOpService {
    return new WorkspaceOpService(new CommandRunner(storage, epoch, options), deps);
  }

  /**
   * Asks for the operation on a task's checkout. Answers with the recorded outcome (`done`, `refused`, `failed` or `uncertain`); it throws for a caller who may not ask, a malformed request, or a task that already has an
   * operation running (`unavailable`: ask again when it ends).
   */
  async request(by: Principal, command: NoActor & { operation: WorkspaceOperation; taskId: string; reason: string; leaseId?: string; fence?: number }): Promise<WorkspaceAnswer> {
    onlyKnown(command, ["commandId", "operation", "taskId", "reason", "leaseId", "fence"]);
    const operation = (WORKSPACE_OPERATIONS as readonly string[]).includes(command.operation) ? command.operation : invalid("operation", `must be one of ${WORKSPACE_OPERATIONS.join(", ")}`);
    if (operation === "reapply") invalid("operation", "reapply is the author's own refresh: the agent asks for it itself with work.refresh, while it works (to move a clean checkout to the shared head, ask for refresh)");
    const taskId = checkTaskId(command.taskId);
    const reason = text(command.reason, "reason", { min: 1, max: WORKSPACE_LIMITS.reason, multiline: false });
    if (redactText(reason) !== reason) invalid("reason", "looks like a credential or key; those are not recorded");
    const projectId = await this.#authorize(by, taskId);
    const scoped = scopedCommandId(by.id, command.commandId);
    const id = derivedId("wsr", scoped);

    const replay = await this.#replayOf(by, id, scoped, taskId);
    if (replay !== undefined) return replay;
    // A landing is made only under the project's integrator lease (card P10): checked before anything is recorded or frozen, and again right before the host is asked.
    // The check may answer the lease it used (the owner may leave it out); the second showing checks that same hold, never a lease taken in between.
    let leased: { leaseId: unknown; fence: unknown } | undefined = operation === "landing" && this.#deps.landingLease !== undefined ? { leaseId: command.leaseId, fence: command.fence } : undefined;
    if (leased !== undefined) { const shown = await this.#deps.landingLease!(by, { taskId, projectId, ...leased }); if (shown !== undefined) leased = { leaseId: shown.leaseId, fence: shown.fence }; }
    else if (command.leaseId !== undefined || command.fence !== undefined) invalid("leaseId", "only a landing is made under an integrator lease");
    // One operation per task: two would race on the same checkout and one's release would lift the other's freeze.
    if (this.#busy.has(taskId)) throw new DomainError("unavailable", `task ${taskId} already has a workspace operation running; ask again when it ends`);
    this.#busy.set(taskId, id);
    try {
      // What an earlier controller left open on this task is resolved first, so its freeze cannot be taken for ours.
      await this.#resolveOpen(taskId);
      const intended = (await this.#deps.attempts?.live(taskId)) ?? [];
      let assignee: string | undefined;
      try { assignee = await this.#deps.assignee?.(taskId); } catch { assignee = undefined; }
      const make: WorkspaceRecordBody = { operation, taskId, projectId, requestedBy: by.id, reason, state: "started", at: this.#runner.now(), ...(assignee === undefined ? {} : { assignee }), ...(intended.length === 0 ? {} : { held: intended }), ...(leased === undefined ? {} : { lease: { leaseId: leased.leaseId as string, fence: leased.fence as number } }) };
      await this.#write(by.id, scoped, "workspace.request", id, { creates: true, payload: { operation, taskId, reason, ...(leased === undefined ? {} : { leaseId: leased.leaseId as string, fence: leased.fence as number }) }, body: () => make, also: () => this.#openChange(taskId, id) });
      const started = (await this.#get(id))!;
      const pinned = leased;
      const outcome = await this.#run(id, started.body, pinned === undefined ? undefined : async () => { await this.#deps.landingLease!(by, { taskId, projectId, ...pinned }); });
      return await this.#settle(by.id, scoped, id, outcome);
    } finally { this.#busy.delete(taskId); }
  }

  /**
   * A repeat finds the record: a finished one is returned as it was. One still running here is `uncertain` for the repeat (the first call goes on, keeps its freeze and writes the real outcome). One left by a stopped controller
   * is resolved: its freeze lifted, then it is `uncertain`.
   */
  async #replayOf(by: Principal, id: string, scoped: string, taskId: string): Promise<WorkspaceAnswer | undefined> {
    const existing = await this.#get(id);
    if (existing === undefined) return undefined;
    if (existing.body.state !== "started") return { ...existing.body, id, replayed: true };
    if (this.#busy.get(taskId) === id) {
      const marked = await this.#markUncertain(by.id, id, existing, "it is not known whether the host did this (the first call has not finished); check the checkout before asking again", `${scoped}:finish:uncertain`, false);
      return { ...marked, id, replayed: true };
    }
    await this.#resolveLeft(id, existing, `${scoped}:finish:uncertain`);
    return { ...(await this.#get(id))!.body, id, replayed: true };
  }

  /**
   * The author's own refresh (card H12p, the agent's `work.refresh`): the host re-applies the agent's work three-way onto the shared workspace's current head. Only the agent of a live attempt asks (a task credential only for its own
   * task); the owner's `request` refuses this operation. There is NO quiesce: the caller is the attempt itself, in the middle of its own tool call, so nothing is frozen and nothing is told afterwards (the answer is the telling). The attempt
   * must not be frozen (an ending or another workspace operation has it), and one operation runs per task at a time: a refresh while another operation is open is `unavailable`, never queued. The request is recorded before the host is asked, a
   * repeat of the call returns the recorded answer, and a call that was recorded but never finished is `uncertain` and not run again. The answer names what was kept, taken and merged and lists each conflict (never resolved here). A refresh that
   * moved the checkout to a newer head is one refresh ROUND of the task, counted in the same write that records the outcome and read by `refreshRounds` (the submission carries it); a refresh at the head already, a refusal, a failure and an
   * `uncertain` one are not counted.
   */
  async reapply(by: Principal, command: NoActor & { attemptId: string }): Promise<WorkspaceAnswer> {
    onlyKnown(command, ["commandId", "attemptId"]);
    if (by.kind !== "agent") throw new DomainError("forbidden", `${by.id} may not refresh an attempt's checkout: only the author's agent does`);
    const attemptId = text(command.attemptId, "attemptId", { min: 1, max: 200 });
    const lookup = this.#deps.attemptOf;
    if (lookup === undefined) throw new DomainError("unavailable", "the attempts are not known to this controller, so a refresh cannot be made now");
    const attempt = await lookup(attemptId);
    // The ID is the caller's text: it is shown back only with anything credential-shaped removed.
    const shown = redactText(attemptId).slice(0, 80);
    if (attempt === undefined || attempt.agentId !== by.id || (by.taskScope !== undefined && by.taskScope.taskId !== attempt.taskId)) throw new DomainError("not_found", `attempt ${shown} does not exist or is not yours`);
    if (!attempt.live || attempt.stopped === true) throw new DomainError("invalid_transition", `attempt ${shown} is no longer running`);
    const taskId = checkTaskId(attempt.taskId);
    const task = (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined;
    if (task === undefined) throw new DomainError("not_found", `task ${taskId} does not exist`);
    const scoped = scopedCommandId(by.id, command.commandId);
    const id = derivedId("wsr", scoped);
    const replay = await this.#replayOf(by, id, scoped, taskId);
    if (replay !== undefined) return replay;
    if ((await this.#deps.paused?.(taskId)) === true) throw new DomainError("unavailable", `task ${taskId} is paused; your checkout is not refreshed until it is resumed`);
    const why = await this.#deps.attempts?.frozenReason(attemptId);
    if (why !== undefined) throw new DomainError("unavailable", `your attempt is held right now (${redactText(why).slice(0, 120)}); a refresh is not made while it is`);
    if (this.#busy.has(taskId)) throw new DomainError("unavailable", `task ${taskId} already has a workspace operation running; ask again when it ends`);
    this.#busy.set(taskId, id);
    try {
      await this.#resolveOpen(taskId);
      if ((await this.openFor(taskId)) !== undefined) throw new DomainError("unavailable", `task ${taskId} has a workspace operation open; ask again when it ends`);
      let assignee: string | undefined;
      try { assignee = await this.#deps.assignee?.(taskId); } catch { assignee = undefined; }
      const make: WorkspaceRecordBody = { operation: "reapply", taskId, projectId: task.projectId, requestedBy: by.id, reason: `the author of attempt ${attemptId} refreshes its checkout onto the landing branch's head`, state: "started", at: this.#runner.now(), ...(assignee === undefined ? {} : { assignee }) };
      await this.#write(by.id, scoped, "workspace.request", id, { creates: true, payload: { operation: "reapply", taskId, attemptId }, body: () => make, also: () => this.#openChange(taskId, id) });
      const started = (await this.#get(id))!;
      const outcome = await this.#run(id, started.body);
      return await this.#settle(by.id, scoped, id, outcome);
    } finally { this.#busy.delete(taskId); }
  }

  /** How many refresh rounds the task's author has made so far (card H12p). It takes no caller, so it is not an API operation: the code that builds the services passes it to the submission. */
  async refreshRounds(taskId: string): Promise<number> {
    const n = ((await this.#runner.get(ROUNDS, checkTaskId(taskId)))?.body as unknown as { rounds?: unknown } | undefined)?.rounds;
    return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : 0;
  }

  /** Whether an operation is running or left open on the task's checkout: the dispatcher does not start an attempt of such a task until it ends (card H12m). */
  async isBusy(taskId: string): Promise<boolean> {
    return this.#busy.has(taskId) || (await this.openFor(taskId)) !== undefined;
  }

  /**
   * The operation open on a task's checkout right now, if any, for code that builds the services (the hand-off package names it as a hold): who asked, what, since when. It takes no caller, so it is not an API
   * operation. A request that finished, or one left open by a stopped controller and not yet resolved, is told as the index has it (the latter reads as `started`; recovery settles it).
   */
  async openFor(taskId: string): Promise<{ readonly requestId: string; readonly operation: WorkspaceOperation; readonly requestedBy: string; readonly at: string } | undefined> {
    const open = ((await this.#runner.get(OPEN, checkTaskId(taskId)))?.body as unknown as { requestId?: string } | undefined)?.requestId;
    if (open === undefined) return undefined;
    const rec = await this.#get(open);
    if (rec === undefined || (rec.body.state !== "started" && rec.body.state !== "uncertain")) return undefined;
    return { requestId: open, operation: rec.body.operation, requestedBy: rec.body.requestedBy, at: rec.body.at };
  }

  /**
   * A request that ended but whose freeze could not be lifted (card L03j): the attempts it still holds frozen until the recovery loop lifts them. Only the request itself may lift them (each freeze names it), so a hand-off
   * names this hold and never lifts it. Like `openFor`, it takes no caller.
   */
  async heldFor(taskId: string): Promise<{ readonly requestId: string; readonly operation: WorkspaceOperation; readonly requestedBy: string; readonly held: readonly string[]; readonly finishedAt?: string } | undefined> {
    const open = ((await this.#runner.get(OPEN, checkTaskId(taskId)))?.body as unknown as { requestId?: string } | undefined)?.requestId;
    if (open === undefined) return undefined;
    const rec = await this.#get(open);
    if (rec === undefined || rec.body.state === "started" || rec.body.state === "uncertain" || (rec.body.held ?? []).length === 0) return undefined;
    return { requestId: open, operation: rec.body.operation, requestedBy: rec.body.requestedBy, held: rec.body.held!, ...(rec.body.finishedAt === undefined ? {} : { finishedAt: rec.body.finishedAt }) };
  }

  /** One recorded request. Readable by the caller who could have asked for it. */
  async get(by: Principal, requestId: string): Promise<WorkspaceAnswer | undefined> {
    if (typeof requestId !== "string" || !WORKSPACE_ID.test(requestId)) return undefined;
    const found = await this.#get(requestId);
    if (found === undefined) return undefined;
    try { await this.#authorize(by, found.body.taskId); } catch { return undefined; }
    return { ...found.body, id: requestId, replayed: false };
  }

  /**
   * After a restart: requests that were open when the controller stopped are `uncertain` (the host may have acted) and the attempts they froze are released. Only the open index is read, and a task with an operation running in
   * this process is left to that operation. For the controller's own loop; not an API operation. Returns the requests it resolved.
   */
  async recover(by: Principal): Promise<string[]> {
    if (!((by.kind === "owner" || by.kind === "service" || by.kind === "host") && by.taskScope === undefined)) throw new DomainError("forbidden", `${by.id} may not recover workspace requests`);
    const resolved: string[] = [];
    let failed: unknown;
    for (let after: string | undefined;;) {
      const page = await this.#runner.list(OPEN, { ...(after === undefined ? {} : { afterId: after }), limit: 100 });
      for (const a of page) {
        after = a.id;
        const open = (a.body as unknown as { requestId?: string }).requestId;
        if (open === undefined) continue;
        try { if (await this.#resolveOpen(a.id)) resolved.push(open); } catch (error) { failed ??= error; }
      }
      if (page.length < 100) { if (failed !== undefined) throw failed; return resolved; }
    }
  }

  /** Resolves the request left open on a task by a controller that stopped, if there is one. */
  async #resolveOpen(taskId: string): Promise<boolean> {
    const open = ((await this.#runner.get(OPEN, taskId))?.body as unknown as { requestId?: string } | undefined)?.requestId;
    if (open === undefined) return false;
    const rec = await this.#get(open);
    if (rec === undefined || this.#busy.get(taskId) === open) return false;
    if (rec.body.state === "started") { await this.#resolveLeft(open, rec, `${open}:recovered`); return true; }
    // A repeat marked it `uncertain` while its first call was running here and that process stopped: the freeze is still its, and the index still names it.
    await this.#release(await this.#toRelease(rec.body), open);
    const ref: AggregateRef = { kind: OPEN, id: taskId };
    await this.#runner.command("workspace.close", { commandId: `${open}:closed`, actor: "controller" }, async () => ({
      payload: { requestId: open },
      build: async () => ({ ref, creates: false, changes: await this.#openChange(taskId, null, open), detail: { taskId } , contention: async () => new DomainError("stale_revision", "the workspace request changed at the same moment") }),
    })).catch((error: unknown) => { if (!(error instanceof DomainError && error.code === "stale_revision")) throw error; });
    return true;
  }

  /** The request was left running by a controller that stopped: its freeze is lifted first (if that fails it stays open and is tried again), then it is recorded as `uncertain`. */
  async #resolveLeft(id: string, rec: { readonly body: WorkspaceRecordBody; readonly revision: number }, commandId: string): Promise<void> {
    await this.#release(await this.#toRelease(rec.body), id);
    await this.#markUncertain("controller", id, rec, "the controller stopped while the host worked; check the checkout before asking again", commandId);
  }

  async #markUncertain(actor: string, id: string, rec: { readonly body: WorkspaceRecordBody; readonly revision: number }, summary: string, commandId: string, clearOpen = true): Promise<WorkspaceRecordBody> {
    const body: WorkspaceRecordBody = { ...rec.body, state: "uncertain", finishedAt: this.#runner.now(), summary };
    try {
      await this.#write(actor, commandId, "workspace.finish", id, { creates: false, payload: { state: "uncertain" }, body: () => body, expectedRevision: rec.revision, also: () => clearOpen ? this.#openChange(rec.body.taskId, null, id) : Promise.resolve([]) });
      return body;
    } catch (error) {
      if (!(error instanceof DomainError && error.code === "stale_revision")) throw error;
      return (await this.#get(id))?.body ?? body;
    }
  }

  /** The attempts a left request may have frozen: those it recorded, and any that started after (the tag keeps this from lifting anything that is not its own). */
  async #toRelease(body: WorkspaceRecordBody): Promise<string[]> {
    const live = (await this.#deps.attempts?.live(body.taskId)) ?? [];
    return [...new Set([...(body.held ?? []), ...live])];
  }

  async #release(attempts: readonly string[], requestId: string): Promise<void> {
    const control = this.#deps.attempts;
    if (control === undefined) return;
    for (const attemptId of attempts) {
      try {
        const why = await control.frozenReason(attemptId);
        if (why !== undefined && frozenFor(why, requestId)) await control.release(attemptId);
      } catch (error) { if (!(error instanceof DomainError && error.code === "not_found")) throw error; }
    }
  }

  async #run(id: string, body: WorkspaceRecordBody, stillLeased?: () => Promise<void>): Promise<WorkspaceRecordBody> {
    const status = { unreleased: [] as string[] };
    const done = (state: WorkspaceState, more: Partial<WorkspaceRecordBody>): WorkspaceRecordBody => {
      const { held: _held, ...rest } = body; void _held;
      // A freeze that could not be lifted stays in the record (and the open index), so recovery lifts it later and it is never left unseen.
      return clean({ ...rest, state, finishedAt: this.#runner.now(), ...(status.unreleased.length === 0 ? {} : { held: [...new Set(status.unreleased)] }), ...more });
    };
    let port: WorkspacePort | undefined;
    try { port = await this.#deps.portOf(body.taskId); } catch (error) { return done("failed", { summary: `no host could be found: ${safe(error, WORKSPACE_LIMITS.summary)}` }); }
    if (port === undefined) return done("refused", { summary: "no host that can do this holds the checkout of that task, so nothing was done" });
    // The author's own refresh (card H12p) is asked for by the attempt itself, in the middle of its own call: nothing is made quiet or frozen, and nothing is told afterwards (the answer is the telling).
    if (body.operation === "reapply") {
      try {
        const answer = await port.run({ requestId: id, operation: "reapply", taskId: body.taskId, projectId: body.projectId, reason: body.reason, quietAttempts: [], ...(body.assignee === undefined ? {} : { assignee: body.assignee }) });
        if (answer !== null && typeof answer === "object" && answer.ok === true) {
          const detail = boundedDetail(cleanReapplyDetail(answer.detail));
          return done("done", { summary: safe(answer.summary, WORKSPACE_LIMITS.summary), ...(detail === undefined ? {} : { detail }) });
        }
        return done("refused", { summary: `the host did not do it: ${safe((answer as { reason?: unknown } | undefined)?.reason ?? "no reason given", WORKSPACE_LIMITS.summary)}` });
      } catch (error) {
        // The host was asked and failed, or the answer was lost: it may have changed the checkout, so this is not a clean failure.
        return done("failed", { summary: safe(error, WORKSPACE_LIMITS.summary) });
      }
    }
    let quietAttempts: readonly string[] = [];
    const stopped: string[] = [];
    const told: string[] = [];
    let changed = false;
    let notLanded: string | undefined;
    try {
      const outcome = await this.#deps.quiesce.around({ taskId: body.taskId }, body.operation, async (quiet) => {
        quietAttempts = quiet.attempts.map((a) => a.attemptId);
        // The quiesce may have taken a while: the lease is shown once more right before the host writes anything, and a lease that is no longer the caller's live hold means nothing is asked of the host.
        if (stillLeased !== undefined) {
          try { await stillLeased(); } catch (error) { return { ok: false as const, reason: `the integrator lease no longer holds, so nothing was landed: ${safe(error, 300)}` }; }
        }
        const answer = await port!.run({ requestId: id, operation: body.operation, taskId: body.taskId, projectId: body.projectId, reason: body.reason, quietAttempts, ...(body.assignee === undefined ? {} : { assignee: body.assignee }) });
        if (answer !== null && typeof answer === "object" && answer.ok === true) {
          const found = (answer.detail ?? {}) as { changed?: unknown; landed?: unknown; written?: unknown; kept?: unknown; keptFiles?: unknown; partial?: unknown };
          changed = found.changed !== false;
          // A landing that did not land is not told as landed: the agent hears exactly what was written and what was kept (done can mean not landed).
          if (body.operation === "landing" && found.landed !== true) {
            const names = Array.isArray(found.keptFiles) ? found.keptFiles.flatMap((k) => (k !== null && typeof k === "object" && typeof (k as { path?: unknown }).path === "string" ? [(k as { path: string }).path] : [])).slice(0, 5) : [];
            const written = typeof found.written === "number" ? found.written : 0, kept = typeof found.kept === "number" ? found.kept : 0;
            if (written > 0 || kept > 0) notLanded = `was NOT landed: ${written} file(s) were written to the shared workspace and ${kept} were kept for the owner's review${names.length === 0 ? "" : ` (${names.join(", ")})`}${found.partial === true ? "; the shared workspace changed during the landing or could not be fully restored after a failure, so the owner checks it" : "; a landing is all or nothing, so the rest needs the owner's decision or a new landing"}`;
            changed = false;
          }
          // A quarantined checkout is gone from under the agent: while it is still quiet its attempt is stopped (it would only fail on a missing folder), and the task is left as it is.
          if (body.operation === "quarantine" && this.#deps.attempts?.stop !== undefined) {
            for (const attemptId of quietAttempts) {
              try { await this.#deps.attempts.stop(attemptId, `its checkout was quarantined (${id}); the work is kept for the owner`); stopped.push(attemptId); } catch { /* it ended meanwhile, or stays frozen and fails on the missing checkout; the record says which were stopped */ }
            }
          }
        }
        return answer;
      }, async (attemptId) => {
        if (notLanded !== undefined && this.#deps.attempts?.tell !== undefined) { if (await this.#deps.attempts.tell(attemptId, `[workspace] Your checkout ${notLanded} (request ${id}).`)) told.push(attemptId); return; }
        if (!changed || body.operation === "quarantine" || this.#deps.attempts?.tell === undefined) return;
        const what = body.operation === "refresh" ? "was refreshed to the shared workspace's current head: files in it may differ from what you read earlier, so read them again before you rely on them" : body.operation === "landing" ? "was landed on the landing branch (the landed files wait, uncommitted, to be committed by the integrator or owner)" : "was integrated into the shared workspace";
        if (await this.#deps.attempts.tell(attemptId, `[workspace] Your checkout ${what} (request ${id}).`)) told.push(attemptId);
      }, id, status);
      // A landing leaves its files uncommitted in the shared tree, and refuses while an earlier one's files wait there: somebody has to commit or clear them, so the owner is told (the integrator is whoever holds that role; the notice goes to the owner's inbox).
      if (body.operation === "landing" && this.#deps.notify !== undefined) {
        const waiting = outcome !== null && typeof outcome === "object" && outcome.ok === true && (outcome.detail as { waitingToCommit?: unknown } | undefined)?.waitingToCommit === true;
        const dirty = outcome !== null && typeof outcome === "object" && outcome.ok === false && /uncommitted file\(s\)/.test(String((outcome as { reason?: unknown }).reason ?? ""));
        const mixed = outcome !== null && typeof outcome === "object" && outcome.ok === true && Array.isArray((outcome.detail as { notRestored?: unknown } | undefined)?.notRestored) && ((outcome.detail as { notRestored: unknown[] }).notRestored.length > 0);
        if (waiting || dirty || mixed) {
          const text = mixed ? `Task ${body.taskId}: a landing failed part-way and some files in the shared workspace could not be put back (${String(((outcome as unknown as { detail: { notRestored: unknown[] } }).detail.notRestored).slice(0, 5))}). The shared workspace needs your attention before another landing.` : waiting ? `Task ${body.taskId}: its work was landed in the shared workspace and waits there, uncommitted. Commit or clear those files so the next landing can go ahead.` : `Task ${body.taskId}: a landing was refused because the shared workspace holds uncommitted files (an earlier landing's, or other work). Commit or clear them, then ask again.`;
          try { await this.#deps.notify({ commandId: `wsn-${id}`, taskId: body.taskId, text: text.slice(0, 400) }); } catch { /* the outcome is recorded either way; the notice is retried by a repeat of the request only */ }
        }
      }
      const more: Partial<WorkspaceRecordBody> = { quietAttempts, ...(told.length === 0 ? {} : { told }), ...(stopped.length === 0 ? {} : { stopped }) };
      if (outcome !== null && typeof outcome === "object" && outcome.ok === true) {
        const detail = boundedDetail(outcome.detail);
        return done("done", { summary: safe(outcome.summary, WORKSPACE_LIMITS.summary), ...(detail === undefined ? {} : { detail }), ...more });
      }
      return done("refused", { summary: `the host did not do it: ${safe((outcome as { reason?: unknown } | undefined)?.reason ?? "no reason given", WORKSPACE_LIMITS.summary)}`, quietAttempts });
    } catch (error) {
      if (error instanceof QuiesceRefused) return done("refused", { summary: safe(error.message, WORKSPACE_LIMITS.summary), ...(error.blockerId === undefined ? {} : { blocker: error.blockerId }) });
      // The host was asked and failed, or the answer was lost: it may have changed the checkout, so this is not a clean failure.
      return done("failed", { summary: safe(error, WORKSPACE_LIMITS.summary), ...(quietAttempts.length === 0 ? {} : { quietAttempts }), ...(stopped.length === 0 ? {} : { stopped }) });
    }
  }

  /** Writes the outcome. A repeat that arrived while the host worked marked the record `uncertain`; the real outcome replaces that. */
  async #settle(actor: string, scoped: string, id: string, outcome: WorkspaceRecordBody): Promise<WorkspaceAnswer> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = (await this.#get(id))!;
      // A refresh that moved the checkout onto a newer head is one round of the task; the count and the record are written together, so one is never without the other.
      const counts = outcome.operation === "reapply" && outcome.state === "done" && (outcome.detail as { changed?: unknown } | undefined)?.changed === true;
      const counter = counts ? await this.#runner.get(ROUNDS, outcome.taskId) : undefined;
      const round = counts ? ((counter?.body as unknown as { rounds?: number } | undefined)?.rounds ?? 0) + 1 : undefined;
      const final: WorkspaceRecordBody = round === undefined ? outcome : { ...outcome, round };
      try {
        await this.#write(actor, `${scoped}:finish:${outcome.state}`, "workspace.finish", id, { creates: false, payload: { state: outcome.state }, body: () => final, expectedRevision: current.revision, also: async () => [...(round === undefined ? [] : this.#roundChange(final.taskId, round, counter?.revision)), ...(final.held !== undefined && final.held.length > 0 ? [] : await this.#openChange(final.taskId, null, id))] });
        return { ...final, id, replayed: false };
      } catch (error) {
        if (!(error instanceof DomainError && error.code === "stale_revision")) throw error;
      }
    }
    throw new DomainError("unavailable", "the outcome of the workspace operation could not be recorded; the request says uncertain");
  }

  /** The write of a task's refresh-round count: created at the first round, then updated against the revision that was read. */
  #roundChange(taskId: string, rounds: number, revision: number | undefined): Change[] {
    const ref: AggregateRef = { kind: ROUNDS, id: taskId };
    return [revision === undefined ? { type: "create", ref, body: json({ rounds }) } : { type: "update", ref, expectedRevision: revision, body: json({ rounds }) }];
  }

  /** The open index of a task: set to `requestId`, or cleared (only when it still names `from`). */
  async #openChange(taskId: string, requestId: string | null, from?: string): Promise<Change[]> {
    const ref: AggregateRef = { kind: OPEN, id: taskId };
    const current = await this.#runner.get(OPEN, taskId);
    if (requestId === null) {
      if (current === undefined || (current.body as unknown as { requestId?: string }).requestId !== from) return [];
      return [{ type: "update", ref, expectedRevision: current.revision, body: json({}) }];
    }
    return [current === undefined ? { type: "create", ref, body: json({ requestId }) } : { type: "update", ref, expectedRevision: current.revision, body: json({ requestId }) }];
  }

  async #authorize(by: Principal, taskId: string): Promise<string> {
    const found = await this.#runner.get("task", taskId);
    const projectId = (found?.body as unknown as TaskBody | undefined)?.projectId;
    const refused = (): DomainError => new DomainError("not_found", `task ${taskId} does not exist or is not yours to manage`);
    // Exact: a wildcard grant is not enough to change another's checkout.
    if (projectId === undefined || by.taskScope !== undefined || !inTaskScope(by, projectId) || !allowsExactly(by, "workspace.manage", projectId, { resource: { kind: "task", id: taskId } })) throw refused();
    return projectId;
  }

  async #get(id: string): Promise<{ readonly body: WorkspaceRecordBody; readonly revision: number } | undefined> {
    const found: Aggregate | undefined = await this.#runner.get(RECORD, id);
    return found === undefined ? undefined : { body: found.body as unknown as WorkspaceRecordBody, revision: found.revision };
  }

  async #write(actor: string, commandId: string, type: string, id: string, w: { creates: boolean; payload: JsonObject; body: () => WorkspaceRecordBody; expectedRevision?: number; also?: () => Promise<Change[]> }) {
    const ref: AggregateRef = { kind: RECORD, id };
    return this.#runner.command(type, { commandId, actor }, async () => ({
      payload: w.payload,
      build: async () => ({
        ref, creates: w.creates,
        changes: [w.creates ? { type: "create" as const, ref, body: json(w.body()) } : { type: "update" as const, ref, expectedRevision: w.expectedRevision!, body: json(w.body()) }, ...(w.also === undefined ? [] : await w.also())],
        detail: { operation: w.body().operation, taskId: w.body().taskId },
        contention: async () => new DomainError("stale_revision", "the workspace request changed at the same moment"),
      }),
    }));
  }
}
