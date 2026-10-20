import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";
import type { AssignmentService } from "./assignments.js";
import type { BlockerService } from "./blockers.js";
import { DomainError } from "./errors.js";
import { canonicalJson, sha256 } from "../storage/json.js";
import { derivedId, operationIdOf } from "./ids.js";
import type { InboxService } from "./inbox.js";
import { onlyKnown, text as checkText, type View } from "./model.js";
import { CommandRunner, view, type CommandMeta, type CommandResult, type RunnerOptions } from "./runner.js";
import type { ProjectService } from "./service.js";

/**
 * What the controller needs from a conversation with a model (card S09). It is deliberately structural: the controller does not depend on
 * Pi or on the contracts package, so any runtime that can do this fits; the Pi adapter does, through a thin wrapper in the integration tests.
 * `submit` must be idempotent by `requestId`: submitting a request that was already submitted returns the original and never runs it twice.
 */
export interface ConversationSubmitter {
  submit(request: { readonly requestId: string; readonly content: string }): Promise<{ result(): Promise<BridgeResult> }>;
  /** The result of a request the runtime already holds as settled; `undefined` if it has none. Never runs anything. */
  lookup?(requestId: string): Promise<BridgeResult | undefined>;
  /** What the runtime found unfinished when it opened: it holds all new work (`held`) until a decision is made, and says which requests were in flight. Absent: nothing is ever held. */
  interrupted?(): Promise<{ readonly held: boolean; readonly requestIds: readonly string[]; /** Unfinished work that cannot be tied to a request ID (it is never resumed by the bridge). Absent: none. */ readonly unattributed?: number }>;
  /** The reviewed recovery step after a restart: resume the interrupted work, abandon nothing; the runtime records it in its own audit. */
  recover?(reason: string): Promise<void>;
  /** An opaque record of the conversation's state, to keep with the workspace artifacts as one recovery point. */
  checkpoint?(): Promise<JsonObject>;
}

export interface BridgeResult {
  readonly status: string;
  readonly text?: string;
}

export interface BridgeRun {
  /** The request ID used: the controller's own operation ID of the admission, so the same admission always names the same request. */
  readonly requestId: string;
  readonly attemptId: string;
  readonly status: string;
  readonly text: string;
  readonly checkpoint: JsonObject | undefined;
}

export interface BridgeDependencies {
  readonly inbox: InboxService;
  readonly projects: ProjectService;
  readonly assign: AssignmentService;
  /** When given, interrupted work that is not this attempt's own is reported as a blocker for the owner instead of being resumed. */
  readonly blockers?: BlockerService;
}

export interface BridgeOptions {
  /** Called at the points where a process could die with some effects done and others not (the test harness kills there). */
  readonly boundary?: (label: string) => void;
}

/**
 * The controller's inbox bridge (card S09): for a message the inbox has admitted, submits the attempt's work to the conversation once. The
 * request ID is the controller's own operation ID of the admission (`cmd:adm:<messageId>`), so a restart, a duplicate delivery or a second
 * caller names the same request and the runtime returns the original instead of running the model again. If the runtime restarted with
 * interrupted work held, the bridge asks it to resume (the reviewed recovery step) before submitting.
 */
export class ConversationBridge {
  readonly #inbox: InboxService;
  readonly #projects: ProjectService;
  readonly #assign: AssignmentService;
  readonly #blockers: BlockerService | undefined;
  readonly #conversation: ConversationSubmitter;
  readonly #options: BridgeOptions;

  constructor(deps: BridgeDependencies, conversation: ConversationSubmitter, options: BridgeOptions = {}) {
    this.#inbox = deps.inbox;
    this.#projects = deps.projects;
    this.#assign = deps.assign;
    this.#blockers = deps.blockers;
    this.#conversation = conversation;
    this.#options = options;
  }

  async run(messageId: string): Promise<BridgeRun> {
    const message = await this.#inbox.getMessage(messageId);
    if (message === undefined) throw new DomainError("not_found", `inbox message ${messageId} does not exist`);
    const attemptId = message.admission?.attemptId;
    if (message.state === "received" || attemptId === undefined) throw new DomainError("invalid_command", `inbox message ${messageId} has no admitted attempt; admit it first`, { field: "messageId" });
    const attempt = await this.#assign.getAttempt(attemptId);
    if (attempt === undefined) throw new DomainError("integrity", `inbox message ${messageId} names attempt ${attemptId}, which does not exist`);
    const task = await this.#projects.getTask(attempt.taskId);
    if (task === undefined) throw new DomainError("integrity", `attempt ${attemptId} belongs to task ${attempt.taskId}, which does not exist`);
    const requestId = operationIdOf(`adm:${messageId}`);
    const content = `${task.title}${task.description === "" ? "" : `\n\n${task.description}`}`;

    // Only an attempt that is still the current one may start model work. A replay of work the runtime already finished is answered from its record.
    const assignment = await this.#assign.getAssignment(attempt.taskId);
    const current = attempt.state === "active" && assignment?.state === "assigned" && assignment.generation === attempt.generation && assignment.activeAttemptId === attemptId;
    if (!current) {
      const original = await this.#conversation.lookup?.(requestId);
      if (original !== undefined && original.status === "completed" && original.text !== undefined) {
        const checkpoint = this.#conversation.checkpoint === undefined ? undefined : await this.#conversation.checkpoint();
        return { requestId, attemptId, status: original.status, text: original.text, checkpoint };
      }
      throw new DomainError("fenced", `attempt ${attemptId} is ${attempt.state}${assignment === undefined ? "" : ` and the task is at generation ${assignment.generation}`}; its work is not submitted`, { field: "messageId" });
    }

    // Interrupted work is resumed only when it is all this request's own. Anything else in flight (other attempts, other conversations, tool calls
    // that may not be safe to repeat) is a decision for a person: the runtime stays held and a blocker says so.
    const unfinished = this.#conversation.interrupted === undefined ? undefined : await this.#conversation.interrupted();
    if (unfinished?.held === true) {
      const others = unfinished.requestIds.filter((id) => id !== requestId);
      const unattributed = unfinished.unattributed ?? 0;
      // Resume only when the unfinished work is demonstrably this request's: at least one request is named and every one is ours, with nothing unattributable.
      if (others.length > 0 || unattributed > 0 || !unfinished.requestIds.includes(requestId)) {
        const why = others.length > 0 ? `${others.length} unfinished request(s) that are not attempt ${attemptId}'s (${others.slice(0, 5).join(", ")})` : unattributed > 0 ? `${unattributed} unit(s) of unfinished work that cannot be tied to any request` : `unfinished work but no request of attempt ${attemptId}'s among it`;
        await this.#blockers?.openBlocker({
          commandId: `runtime-hold:${sha256(`${requestId}\0${others.join("\0")}\0${unattributed}`).slice(0, 32)}`, actor: "bridge", type: "runtime_hold", subject: { kind: "attempt", id: attemptId }, resolver: "owner",
          summary: `The conversation runtime restarted holding ${why}. Review it and recover the runtime by hand; the controller will not resume work it cannot show it started for this attempt.`,
        });
        throw new DomainError("unavailable", `the runtime holds interrupted work that is not demonstrably this attempt's (${why}); a person must review it`, { field: "messageId" });
      }
      this.#options.boundary?.("bridge: before resuming interrupted work");
      await this.#conversation.recover?.(`controller restart: resuming the work of attempt ${attemptId}`);
    }
    this.#options.boundary?.("bridge: before submitting the request");
    const handle = await this.#conversation.submit({ requestId, content });
    this.#options.boundary?.("bridge: request submitted, result not yet read");
    const result = await handle.result();
    this.#options.boundary?.("bridge: result read, not yet recorded");
    if (result.status !== "completed" || result.text === undefined) throw new DomainError("unavailable", `the conversation ended request ${requestId} as ${result.status}; nothing was recorded`);
    const checkpoint = this.#conversation.checkpoint === undefined ? undefined : await this.#conversation.checkpoint();
    return { requestId, attemptId, status: result.status, text: result.text, checkpoint };
  }
}

/** A controller-owned recovery point (card S09): the conversation's checkpoint together with the workspace artifact manifest it belongs to and the request IDs that produced it. The runtime knows only the conversation half. */
export interface RecoveryPointBody {
  readonly attemptId: string;
  readonly taskId: string;
  readonly requestIds: readonly string[];
  readonly artifactId: string;
  readonly checkpoint?: JsonObject;
  readonly resultText: string;
}

export interface RecordRecoveryPoint extends CommandMeta {
  readonly attemptId: string;
  readonly taskId: string;
  readonly requestIds: readonly string[];
  readonly artifactId: string;
  readonly checkpoint?: JsonObject;
  readonly resultText: string;
}

const POINT_LIMITS = { checkpointChars: 128 * 1024, requestIds: 20, requestId: 200 } as const;
const ATTEMPT_ID = /^att-[a-z2-7]{20}$/;
const TASK_ID = /^task-[a-z2-7]{20}$/;
const ARTIFACT_ID = /^art-[a-z2-7]{20}$/;

export class RecoveryPoints {
  readonly #runner: CommandRunner;

  constructor(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}) {
    this.#runner = new CommandRunner(storage, epoch, options);
  }

  /** Records the point. There is one per attempt (its ID derives from the attempt): the same command again returns it, a different one is refused. */
  record(command: RecordRecoveryPoint): Promise<CommandResult> {
    return this.#runner.command("recovery-point.record", command, async () => {
      onlyKnown(command, ["commandId", "actor", "attemptId", "taskId", "requestIds", "artifactId", "checkpoint", "resultText"]);
      const resultText = checkText(command.resultText, "resultText", { min: 1, max: 8000, multiline: true });
      const bad = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
      if (typeof command.attemptId !== "string" || !ATTEMPT_ID.test(command.attemptId)) bad("attemptId", "is not an attempt ID");
      if (typeof command.taskId !== "string" || !TASK_ID.test(command.taskId)) bad("taskId", "is not a task ID");
      if (typeof command.artifactId !== "string" || !ARTIFACT_ID.test(command.artifactId)) bad("artifactId", "is not an artifact ID");
      if (!Array.isArray(command.requestIds) || command.requestIds.length === 0 || command.requestIds.length > POINT_LIMITS.requestIds) bad("requestIds", `must name 1 to ${POINT_LIMITS.requestIds} requests`);
      for (const [i, id] of command.requestIds.entries()) if (typeof id !== "string" || id.length === 0 || id.length > POINT_LIMITS.requestId) bad(`requestIds[${i}]`, "is not a request ID");
      if (command.checkpoint !== undefined && (command.checkpoint === null || typeof command.checkpoint !== "object" || Array.isArray(command.checkpoint) || canonicalJson(command.checkpoint).length > POINT_LIMITS.checkpointChars)) bad("checkpoint", `must be a JSON object of at most ${POINT_LIMITS.checkpointChars} characters`);
      const body: RecoveryPointBody = { attemptId: command.attemptId, taskId: command.taskId, requestIds: command.requestIds, artifactId: command.artifactId, ...(command.checkpoint === undefined ? {} : { checkpoint: command.checkpoint }), resultText };
      return {
        payload: body as unknown as JsonObject,
        build: async () => {
          const attempt = await this.#runner.get("attempt", command.attemptId);
          if (attempt === undefined || (attempt.body as { taskId?: string }).taskId !== command.taskId) throw new DomainError("not_found", `attempt ${command.attemptId} of task ${command.taskId} does not exist`, { field: "attemptId" });
          if ((await this.#runner.get("artifact", command.artifactId)) === undefined) throw new DomainError("not_found", `artifact ${command.artifactId} does not exist`, { field: "artifactId" });
          const ref: AggregateRef = { kind: "recovery-point", id: derivedId("rp", command.attemptId) };
          return {
            ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }], detail: { attemptId: command.attemptId, artifactId: command.artifactId },
            contention: async () => new DomainError("invalid_command", `attempt ${command.attemptId} already has a recovery point`, { field: "attemptId" }),
          };
        },
      };
    });
  }

  async forAttempt(attemptId: string): Promise<View<RecoveryPointBody> | undefined> {
    const found = await this.#runner.get("recovery-point", derivedId("rp", attemptId));
    return found === undefined ? undefined : view<RecoveryPointBody>(found);
  }
}
