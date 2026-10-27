import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, taskId as checkTaskId, text, type TaskBody } from "../domain/model.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import type { QuiesceCoordinator } from "../dispatch/quiesce.js";
import { QuiesceRefused } from "../dispatch/quiesce.js";
import { allows, inTaskScope } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { Aggregate, AggregateRef, JsonObject } from "../storage/types.js";

/**
 * Integration, checkout refresh and quarantine of an agent's work as controller operations (cards H12l and H12d). The file work lives on the host that holds the checkout (the worker's workspace code), so the controller asks
 * the host through a `WorkspacePort`; this service is what makes that safe and answerable: the caller needs `workspace.manage` on the task's project (the owner always has it; a task credential never does), the request is
 * recorded before anything runs, and the host is asked only while every live attempt of the task is quiet (`QuiesceCoordinator.around`: new calls refused, calls in flight settled, a checkpoint taken). If an attempt cannot be made
 * quiet the operation does not run and the answer says which blocker. A repeat of a command returns the recorded answer; a request that was recorded but whose outcome was never written (a crash while the host worked) is
 * answered `uncertain` and is not run again, because the host may have done it.
 */
export const WORKSPACE_OPERATIONS = ["integration", "refresh", "quarantine"] as const;
export type WorkspaceOperation = (typeof WORKSPACE_OPERATIONS)[number];
export type WorkspaceState = "started" | "done" | "refused" | "failed" | "uncertain";

export const WORKSPACE_LIMITS = { reason: 500, summary: 1000 } as const;

const RECORD = "workspace-request";
const WORKSPACE_ID = /^wsr-[a-z2-7]{20}$/;

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
  /** The blocker opened when an attempt could not be made quiet. */
  readonly blocker?: string;
}
export interface WorkspaceAnswer extends WorkspaceRecordBody { readonly id: string; readonly replayed: boolean }

export interface WorkspaceDeps {
  readonly quiesce: Pick<QuiesceCoordinator, "around">;
  /** The host's side for the task's checkout (the host that runs its live attempt, else the one its checkout is pinned to); `undefined` when no host holds it. */
  readonly portOf: (taskId: string) => Promise<WorkspacePort | undefined>;
}

const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const json = (value: object): JsonObject => value as unknown as JsonObject;
const clean = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
const short = (value: unknown, max: number): string => String((value as Error)?.message ?? value).slice(0, max);

export class WorkspaceOpService {
  readonly #runner: CommandRunner;
  readonly #deps: WorkspaceDeps;
  private constructor(runner: CommandRunner, deps: WorkspaceDeps) { this.#runner = runner; this.#deps = deps; }
  static withEpoch(storage: ConstructorParameters<typeof CommandRunner>[0], epoch: number, deps: WorkspaceDeps, options: RunnerOptions = {}): WorkspaceOpService {
    return new WorkspaceOpService(new CommandRunner(storage, epoch, options), deps);
  }

  /**
   * Asks for the operation on a task's checkout. Always answers with the recorded outcome (`done`, `refused`, `failed` or `uncertain`); it throws only for a caller who may not ask or a request that is malformed.
   * `refused` covers a task with no host, an attempt that could not be made quiet (`blocker` names the blocker) and a host that said no.
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
    const make = (state: WorkspaceState): WorkspaceRecordBody => ({ operation, taskId, projectId, requestedBy: by.id, reason, state, at: this.#runner.now() });

    // Record the request before anything runs. A repeat finds it: a finished one is returned as it was, an unfinished one means the host may have acted.
    const created = await this.#write(by.id, scoped, "workspace.request", id, { creates: true, payload: { operation, taskId, reason }, body: () => make("started") });
    if (created.replayed) {
      const found = await this.#get(id);
      if (found === undefined) throw new DomainError("unavailable", "the request was recorded but cannot be read back");
      if (found.body.state !== "started") return { ...found.body, id, replayed: true };
      const body: WorkspaceRecordBody = { ...found.body, state: "uncertain", finishedAt: this.#runner.now(), summary: "a controller restart or a lost answer left it unknown whether the host did this; check the checkout before asking again" };
      await this.#finish(by.id, scoped, id, found, body);
      return { ...body, id, replayed: true };
    }

    const started = (await this.#get(id))!;
    const outcome = await this.#run(id, started.body, by);
    try { await this.#finish(by.id, scoped, id, started, outcome); } catch (error) {
      // The same command arrived while the host worked and was answered `uncertain`: that record stands, and this caller is told what it says.
      if (!(error instanceof DomainError && error.code === "stale_revision")) throw error;
      const stored = await this.#get(id);
      if (stored !== undefined) return { ...stored.body, id, replayed: true };
      throw error;
    }
    return { ...outcome, id, replayed: false };
  }

  /** One recorded request. Readable by the caller who could have asked for it. */
  async get(by: Principal, requestId: string): Promise<WorkspaceAnswer | undefined> {
    if (typeof requestId !== "string" || !WORKSPACE_ID.test(requestId)) return undefined;
    const found = await this.#get(requestId);
    if (found === undefined) return undefined;
    try { await this.#authorize(by, found.body.taskId); } catch { return undefined; }
    return { ...found.body, id: requestId, replayed: false };
  }

  async #run(id: string, started: WorkspaceRecordBody, by: Principal): Promise<WorkspaceRecordBody> {
    const done = (state: WorkspaceState, more: Partial<WorkspaceRecordBody>): WorkspaceRecordBody => clean({ ...started, state, finishedAt: this.#runner.now(), ...more });
    let port: WorkspacePort | undefined;
    try { port = await this.#deps.portOf(started.taskId); } catch (error) { return done("failed", { summary: `no host could be found: ${short(error, WORKSPACE_LIMITS.summary)}` }); }
    if (port === undefined) return done("refused", { summary: "no host holds the checkout of that task, so nothing was done" });
    let quietAttempts: readonly string[] = [];
    try {
      const outcome = await this.#deps.quiesce.around({ taskId: started.taskId }, started.operation, async (quiet) => {
        quietAttempts = quiet.attempts.map((a) => a.attemptId);
        return port!.run({ requestId: id, operation: started.operation, taskId: started.taskId, projectId: started.projectId, reason: started.reason, quietAttempts });
      });
      return outcome.ok
        ? done("done", { summary: outcome.summary.slice(0, WORKSPACE_LIMITS.summary), ...(outcome.detail === undefined ? {} : { detail: outcome.detail }), quietAttempts })
        : done("refused", { summary: `the host did not do it: ${outcome.reason.slice(0, WORKSPACE_LIMITS.summary)}`, quietAttempts });
    } catch (error) {
      if (error instanceof QuiesceRefused) return done("refused", { summary: error.message.slice(0, WORKSPACE_LIMITS.summary), ...(error.blockerId === undefined ? {} : { blocker: error.blockerId }) });
      // The host was asked and failed, or the answer was lost: it may have changed the checkout, so this is not a clean failure.
      return done("failed", { summary: short(error, WORKSPACE_LIMITS.summary), ...(quietAttempts.length === 0 ? {} : { quietAttempts }) });
    }
  }

  async #authorize(by: Principal, taskId: string): Promise<string> {
    const found = await this.#runner.get("task", taskId);
    const projectId = (found?.body as unknown as TaskBody | undefined)?.projectId;
    const refused = (): DomainError => new DomainError("not_found", `task ${taskId} does not exist or is not yours to manage`);
    if (projectId === undefined || by.taskScope !== undefined || !inTaskScope(by, projectId) || !allows(by, "workspace.manage", projectId, { resource: { kind: "task", id: taskId } })) throw refused();
    return projectId;
  }

  async #get(id: string): Promise<{ readonly body: WorkspaceRecordBody; readonly revision: number } | undefined> {
    const found: Aggregate | undefined = await this.#runner.get(RECORD, id);
    return found === undefined ? undefined : { body: found.body as unknown as WorkspaceRecordBody, revision: found.revision };
  }

  async #finish(actor: string, scoped: string, id: string, before: { readonly revision: number }, body: WorkspaceRecordBody): Promise<void> {
    await this.#write(actor, `${scoped}:finish:${body.state}`, "workspace.finish", id, { creates: false, payload: { state: body.state }, body: () => body, expectedRevision: before.revision });
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
