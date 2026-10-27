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
import type { Aggregate, AggregateRef, JsonObject } from "../storage/types.js";

/**
 * Integration, checkout refresh and quarantine of an agent's work as controller operations (cards H12l and H12d). The file work lives on the host that holds the checkout (the worker's workspace code), so the controller asks
 * the host through a `WorkspacePort`; this service is what makes that safe and answerable: the caller needs `workspace.manage` on the task's project (the owner always has it; a task credential never does), the request is
 * recorded before anything runs, and the host is asked only while every live attempt of the task is quiet (`QuiesceCoordinator.around`: new calls refused, calls in flight settled, a checkpoint taken). If an attempt cannot be made
 * quiet the operation does not run and the answer says which blocker. One operation runs per task at a time (a second is `unavailable` until the first ends). The attempts this operation froze are written into its record, so a
 * controller that crashed while the host worked can release them (`recover`). A repeat of a command returns the recorded answer; a request that was recorded but whose outcome was never written is answered `uncertain` and is not run
 * again, because the host may have done it; if the original call then finishes it replaces `uncertain` with what really happened.
 */
export const WORKSPACE_OPERATIONS = ["integration", "refresh", "quarantine"] as const;
export type WorkspaceOperation = (typeof WORKSPACE_OPERATIONS)[number];
export type WorkspaceState = "started" | "done" | "refused" | "failed" | "uncertain";

export const WORKSPACE_LIMITS = { reason: 500, summary: 1000, detailBytes: 4000 } as const;

const RECORD = "workspace-request";
const WORKSPACE_ID = /^wsr-[a-z2-7]{20}$/;
/** The reason the quiesce gives the freeze it sets; recovery lifts only a freeze that says this. */
const FROZEN_BY = /^(integration|refresh|quarantine): the agent's work is being changed$/;

/** What the host is asked, with the attempts that were made quiet for it. */
export interface WorkspaceCall {
  readonly requestId: string;
  readonly operation: WorkspaceOperation;
  readonly taskId: string;
  readonly projectId: string;
  readonly reason: string;
  readonly quietAttempts: readonly string[];
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
  /** The attempts that were quiet while the host worked. */
  readonly quietAttempts?: readonly string[];
  /** The attempts this operation froze and has not released yet (kept so a crash cannot leave them frozen). */
  readonly held?: readonly string[];
  /** The blocker opened when an attempt could not be made quiet. */
  readonly blocker?: string;
}
export interface WorkspaceAnswer extends WorkspaceRecordBody { readonly id: string; readonly replayed: boolean }

export interface WorkspaceDeps {
  readonly quiesce: Pick<QuiesceCoordinator, "around">;
  /** The host's side for the task's checkout (the host that runs its live attempt, else the one its checkout is pinned to); `undefined` when no host that can do this holds it. */
  readonly portOf: (taskId: string) => Promise<WorkspacePort | undefined>;
  /** What an attempt's freeze says (`undefined`: not frozen), and lifting it. For `recover` and the release after a repeat only. */
  readonly attempts?: { frozenReason(attemptId: string): Promise<string | undefined>; release(attemptId: string): Promise<void> };
}

const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const json = (value: object): JsonObject => value as unknown as JsonObject;
const clean = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
/** Text from a host or a fault, bounded and with anything credential-shaped removed. */
const safe = (value: unknown, max: number): string => redactText(typeof value === "string" ? value : String((value as Error)?.message ?? value)).slice(0, max);
/** A host's detail, kept only when it is plain JSON of a bounded size with nothing credential-shaped in it. */
const boundedDetail = (value: unknown): JsonObject | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const encoded = JSON.stringify(value);
    return encoded.length <= WORKSPACE_LIMITS.detailBytes && redactText(encoded) === encoded ? JSON.parse(encoded) as JsonObject : undefined;
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
  async request(by: Principal, command: NoActor & { operation: WorkspaceOperation; taskId: string; reason: string }): Promise<WorkspaceAnswer> {
    onlyKnown(command, ["commandId", "operation", "taskId", "reason"]);
    const operation = (WORKSPACE_OPERATIONS as readonly string[]).includes(command.operation) ? command.operation : invalid("operation", `must be one of ${WORKSPACE_OPERATIONS.join(", ")}`);
    const taskId = checkTaskId(command.taskId);
    const reason = text(command.reason, "reason", { min: 1, max: WORKSPACE_LIMITS.reason, multiline: false });
    if (redactText(reason) !== reason) invalid("reason", "looks like a credential or key; those are not recorded");
    const projectId = await this.#authorize(by, taskId);
    const scoped = scopedCommandId(by.id, command.commandId);
    const id = derivedId("wsr", scoped);

    // A repeat finds the record: a finished one is returned as it was; one still running here is `uncertain` for the repeat (the first call goes on and writes the real outcome); one from before a restart is `uncertain`.
    const existing = await this.#get(id);
    if (existing !== undefined) {
      if (existing.body.state !== "started") return { ...existing.body, id, replayed: true };
      const body: WorkspaceRecordBody = { ...existing.body, state: "uncertain", finishedAt: this.#runner.now(), summary: "it is not known whether the host did this (the first call has not finished, or the controller restarted); check the checkout before asking again" };
      let marked = body;
      try { await this.#write(by.id, `${scoped}:finish:uncertain`, "workspace.finish", id, { creates: false, payload: { state: "uncertain" }, body: () => body, expectedRevision: existing.revision }); } catch (error) {
        if (!(error instanceof DomainError && error.code === "stale_revision")) throw error;
        marked = (await this.#get(id))?.body ?? body;
      }
      // The freeze is the first call's while it runs; from before a restart it is nobody's, and is lifted.
      if (this.#busy.get(existing.body.taskId) !== id && marked.state === "uncertain") await this.#release(existing.body.held ?? []);
      return { ...marked, id, replayed: true };
    }
    // One operation per task: two would race on the same checkout and one's release would lift the other's freeze.
    if (this.#busy.has(taskId)) throw new DomainError("unavailable", `task ${taskId} already has a workspace operation running; ask again when it ends`);
    this.#busy.set(taskId, id);
    try {
      const make: WorkspaceRecordBody = { operation, taskId, projectId, requestedBy: by.id, reason, state: "started", at: this.#runner.now() };
      await this.#write(by.id, scoped, "workspace.request", id, { creates: true, payload: { operation, taskId, reason }, body: () => make });
      const started = (await this.#get(id))!;
      const outcome = await this.#run(id, scoped, by, started);
      return await this.#settle(by.id, scoped, id, outcome);
    } finally { this.#busy.delete(taskId); }
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
   * After a restart: requests that were `started` when the controller stopped are `uncertain` (the host may have acted), and the attempts they froze are released if they still carry that freeze. For the controller's own loop;
   * not an API operation. Returns the requests it resolved.
   */
  async recover(by: Principal): Promise<string[]> {
    if (!((by.kind === "owner" || by.kind === "service" || by.kind === "host") && by.taskScope === undefined)) throw new DomainError("forbidden", `${by.id} may not recover workspace requests`);
    const resolved: string[] = [];
    for (let after: string | undefined;;) {
      const page = await this.#runner.list(RECORD, { ...(after === undefined ? {} : { afterId: after }), limit: 100 });
      for (const a of page) {
        after = a.id;
        const body = a.body as unknown as WorkspaceRecordBody;
        if (body.state !== "started" || this.#busy.get(body.taskId) === a.id) continue;
        const next: WorkspaceRecordBody = { ...body, state: "uncertain", finishedAt: this.#runner.now(), summary: "the controller restarted while the host worked; check the checkout before asking again" };
        try { await this.#write("controller", `${a.id}:recovered`, "workspace.finish", a.id, { creates: false, payload: { state: "uncertain" }, body: () => next, expectedRevision: a.revision }); } catch (error) {
          if (error instanceof DomainError && error.code === "stale_revision") continue;
          throw error;
        }
        await this.#release(body.held ?? []);
        resolved.push(a.id);
      }
      if (page.length < 100) return resolved;
    }
  }

  async #release(attempts: readonly string[]): Promise<void> {
    const control = this.#deps.attempts;
    if (control === undefined) return;
    for (const attemptId of attempts) {
      try {
        const why = await control.frozenReason(attemptId);
        if (why !== undefined && FROZEN_BY.test(why)) await control.release(attemptId);
      } catch (error) { if (!(error instanceof DomainError && error.code === "not_found")) throw error; }
    }
  }

  async #run(id: string, scoped: string, by: Principal, started: { readonly body: WorkspaceRecordBody; readonly revision: number }): Promise<WorkspaceRecordBody> {
    const body = started.body;
    const done = (state: WorkspaceState, more: Partial<WorkspaceRecordBody>): WorkspaceRecordBody => { const { held: _held, ...rest } = body; void _held; return clean({ ...rest, state, finishedAt: this.#runner.now(), ...more }); };
    let port: WorkspacePort | undefined;
    try { port = await this.#deps.portOf(body.taskId); } catch (error) { return done("failed", { summary: `no host could be found: ${safe(error, WORKSPACE_LIMITS.summary)}` }); }
    if (port === undefined) return done("refused", { summary: "no host that can do this holds the checkout of that task, so nothing was done" });
    let quietAttempts: readonly string[] = [];
    try {
      const outcome = await this.#deps.quiesce.around({ taskId: body.taskId }, body.operation, async (quiet) => {
        quietAttempts = quiet.attempts.map((a) => a.attemptId);
        // Written before the host is asked, so a crash while it works leaves the freeze findable.
        if (quietAttempts.length > 0) await this.#write(by.id, `${scoped}:held`, "workspace.hold", id, { creates: false, payload: { held: [...quietAttempts] }, body: () => ({ ...body, held: quietAttempts, quietAttempts }), expectedRevision: started.revision });
        return port!.run({ requestId: id, operation: body.operation, taskId: body.taskId, projectId: body.projectId, reason: body.reason, quietAttempts });
      });
      if (outcome !== null && typeof outcome === "object" && outcome.ok === true) {
        const detail = boundedDetail(outcome.detail);
        return done("done", { summary: safe(outcome.summary, WORKSPACE_LIMITS.summary), ...(detail === undefined ? {} : { detail }), quietAttempts });
      }
      return done("refused", { summary: `the host did not do it: ${safe((outcome as { reason?: unknown } | undefined)?.reason ?? "no reason given", WORKSPACE_LIMITS.summary)}`, quietAttempts });
    } catch (error) {
      if (error instanceof QuiesceRefused) return done("refused", { summary: safe(error.message, WORKSPACE_LIMITS.summary), ...(error.blockerId === undefined ? {} : { blocker: error.blockerId }) });
      // The host was asked and failed, or the answer was lost: it may have changed the checkout, so this is not a clean failure.
      return done("failed", { summary: safe(error, WORKSPACE_LIMITS.summary), ...(quietAttempts.length === 0 ? {} : { quietAttempts }) });
    }
  }

  /** Writes the outcome. A repeat that arrived while the host worked marked the record `uncertain`; the real outcome replaces that. */
  async #settle(actor: string, scoped: string, id: string, outcome: WorkspaceRecordBody): Promise<WorkspaceAnswer> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = (await this.#get(id))!;
      try {
        await this.#write(actor, `${scoped}:finish:${outcome.state}`, "workspace.finish", id, { creates: false, payload: { state: outcome.state }, body: () => outcome, expectedRevision: current.revision });
        return { ...outcome, id, replayed: false };
      } catch (error) {
        if (!(error instanceof DomainError && error.code === "stale_revision")) throw error;
      }
    }
    throw new DomainError("unavailable", "the outcome of the workspace operation could not be recorded; the request says uncertain");
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

  async #write(actor: string, commandId: string, type: string, id: string, w: { creates: boolean; payload: JsonObject; body: () => WorkspaceRecordBody; expectedRevision?: number }) {
    const ref: AggregateRef = { kind: RECORD, id };
    return this.#runner.command(type, { commandId, actor }, async () => ({
      payload: w.payload,
      build: async () => ({
        ref, creates: w.creates,
        changes: [w.creates ? { type: "create" as const, ref, body: json(w.body()) } : { type: "update" as const, ref, expectedRevision: w.expectedRevision!, body: json(w.body()) }],
        detail: { operation: w.body().operation, taskId: w.body().taskId },
      }),
    }));
  }
}
