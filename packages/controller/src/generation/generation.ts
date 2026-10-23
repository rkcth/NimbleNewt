import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { fence as checkFence, type Fence } from "../domain/assignment-model.js";
import type { AssignmentService } from "../domain/assignments.js";
import type { EffectBody, EffectBridge, EffectOutcome, EffectService } from "../domain/effects.js";
import { onlyKnown, taskId as checkTaskId, text, type TaskBody, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import { mergeChanges } from "../domain/changes.js";
import type { PauseGuard } from "../lifecycle/pause.js";
import { allows, inTaskScope } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { DecisionGuard } from "../decisions/records.js";
import { canonicalJson, sha256 } from "../storage/json.js";
import type { Aggregate, AggregateRef, Change, EffectEntry, JsonObject } from "../storage/types.js";

/** `finish_and_hold`: let the response being generated end, then admit nothing from it until released. `cancel`: cut the generation now and drop what it has produced that was not yet admitted. Both hold the task. */
export type HoldMode = "finish_and_hold" | "cancel";
export interface Hold { readonly mode: HoldMode; readonly by: string; readonly reason: string; readonly at: string }

/** The one record per task that every effect admission and every new generation is checked against. */
export interface GateBody {
  readonly taskId: string;
  readonly projectId: string;
  /** The context revision generations are bound to. A correction raises it, so an older generation can never be current again. */
  readonly contextRevision: number;
  /** Generations begun so far; the next one is this plus one. */
  readonly runs: number;
  /** The latest generation (the only one that may still produce anything that counts). */
  readonly current?: number;
  readonly hold?: Hold;
  readonly corrections: number;
}

export type RunState = "streaming" | "finished" | "held" | "interrupted";
/** `partial`: arguments still arriving. `complete`: arguments final, valid and not yet admitted. `held`: complete, but its generation finished under a hold. `admitted`: an effect intent was recorded (S05). `dropped`: never executable (incomplete or malformed). `withdrawn`: complete, but its generation was interrupted before it was admitted (or the effect had not started). */
export type CallState = "partial" | "complete" | "held" | "admitted" | "dropped" | "withdrawn";

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: string;
  readonly state: CallState;
  readonly reason?: string;
  readonly argsDigest?: string;
  readonly effectId?: string;
  /** What the effect ledger said when last reconciled. `afterInterruption`: the generation was interrupted or the task held when this was recorded, so it is shown as late, never as the current outcome. */
  readonly effect?: { readonly status: string; readonly at: string; readonly afterInterruption: boolean };
}

export interface Interruption { readonly kind: "cancelled" | "corrected" | "superseded"; readonly by: string; readonly reason: string; readonly at: string; readonly atChunk: number }

/** Something that arrived for a generation after it was interrupted. Never applied; kept as a digest and (for text) a short redacted preview. */
export interface LateResult {
  readonly kind: "text" | "tool_call" | "completion";
  readonly seq?: number;
  readonly bytes: number;
  readonly digest: string;
  readonly preview?: string;
  readonly toolCallId?: string;
  readonly at: string;
}

export interface RunBody {
  readonly taskId: string;
  readonly projectId: string;
  /** The principal that streams this generation (the only one besides the installation owner that may add to it). */
  readonly owner: string;
  readonly number: number;
  /** The context revision this generation was bound to when it began. */
  readonly contextRevision: number;
  readonly fence?: Fence;
  readonly state: RunState;
  readonly text: string;
  /** Chunks applied so far; the next must be numbered one more. */
  readonly chunks: number;
  readonly toolCalls: readonly ToolCall[];
  readonly interrupted?: Interruption;
  readonly late: readonly LateResult[];
  /** All late results, including those beyond the list's bound. */
  readonly lateCount: number;
  readonly startedAt: string;
  readonly finishedAt?: string;
}

export interface BeginRun extends NoActor { readonly taskId: string; readonly contextRevision: number; readonly fence?: Fence }
export interface RecordChunk extends NoActor {
  readonly runId: string;
  readonly seq: number;
  readonly text?: string;
  readonly toolCall?: { readonly id: string; readonly name?: string; readonly argumentsDelta?: string; readonly done?: boolean };
}

export type RefusalReason = "held" | "paused" | "decision" | "interrupted" | "stale" | "streaming" | "incomplete" | "admitted";
/** A refusal that says why in a form a program can act on (the command itself was well formed). */
export class GenerationRefused extends DomainError {
  constructor(readonly reason: RefusalReason, message: string) {
    super("invalid_command", message, { field: "generation" });
    this.name = "GenerationRefused";
  }
}

export interface RunView { readonly run: View<RunBody>; /** True while this is still the task's current generation at the current context revision and it has not been interrupted (a hold does not change it). */ readonly current: boolean }
export interface GateView { readonly gate: View<GateBody> }

export const GENERATION_LIMITS = { text: 64 * 1024, delta: 8 * 1024, args: 16 * 1024, toolCalls: 32, late: 50, preview: 200, reason: 500, callId: 80, kind: 40, target: 500 } as const;
const RUN_ID = /^grun-[a-z2-7]{20}-\d{10}$/;
const CALL_ID = /^[A-Za-z0-9_.:-]{1,80}$/;
const KIND = /^[a-z][a-z0-9-]{0,39}$/;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const plain = (value: unknown, field: string, max: number): string => {
  const out = text(value, field, { min: 1, max, multiline: true });
  if (redactText(out) !== out) invalid(field, "looks like a credential or key; those are not recorded");
  return out;
};
const whole = (value: unknown, field: string, min = 1): number => (typeof value === "number" && Number.isSafeInteger(value) && value >= min ? value : invalid(field, `must be a whole number from ${min}`));
const gateIdOf = (taskId: string): string => `ggate-${taskId.slice(5)}`;
const runIdOf = (taskId: string, n: number): string => `grun-${taskId.slice(5)}-${String(n).padStart(10, "0")}`;
const digestOf = (value: string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const clean = (body: object): JsonObject => Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) as unknown as JsonObject;

export interface GenerationServiceOptions extends RunnerOptions {
  /** Test seam: runs between reading the gate for an effect start and committing the claim, to stage a pause landing in that window. */
  readonly testHooks?: { readonly afterGuardRead?: () => Promise<void>; /** Between reading the pause gates and committing, in `begin` and `admitEffect`. */ readonly afterPauseRead?: () => Promise<void>; /** Between reading the owner's decisions (card C08) and committing, in `begin`, `admitEffect` and `execute`. */ readonly afterDecisionRead?: () => Promise<void> };
}

/**
 * Generation interruption and late-result handling (card L05). A *generation* here is one model response being streamed for a task (not an assignment generation, S02).
 *
 * - **Revision-bound.** Every generation begins bound to the task's context revision and is numbered; only the latest generation at the current revision can still produce anything that counts.
 *   `correct` raises the revision and interrupts the running generation; beginning another one supersedes the previous. Whatever arrives later for an interrupted generation is **late**: it is recorded
 *   (digest, size, short preview) and shown as late, and is never applied, so a late response cannot override a correction.
 * - **Partial tool calls never execute.** A tool call has arguments that stream in; only a call whose stream said it was done, with arguments that are a JSON object, is `complete`. A generation
 *   that ends or is cut with a call unfinished drops it for good. Effects start only from admitted complete calls.
 * - **Controls.** `interrupt` is finish-and-hold (the response in progress ends, nothing it holds is admitted) or cancel (cut now, withdraw what was not admitted). Both set a hold on the task in
 *   the same commit, so admissions and starts of effects admitted and started through this service are refused from that moment on (other starters must wire `guardFor`); `release` lifts it. A held generation's calls need an explicit `admitEffect` after the release (readmission).
 * - **Atomic admission.** `admitEffect` checks the gate, the generation and the call and writes the effect intent (S05) in one commit guarded by the gate and the generation, so a pause, a
 *   correction or a cancel racing an admission orders strictly before or after it.
 * - **Effects after an interruption.** An admitted effect that has not started is withdrawn (ledger `failed`) by a cancel, correction or supersession, and `execute` refuses to start one while the task is
 *   held. One that already started is never cut: it settles in the ledger, and `reconcile` records that outcome on the call marked as after the interruption.
 */
export class GenerationService {
  readonly #runner: CommandRunner;
  readonly #assignments: AssignmentService | undefined;
  readonly #effects: EffectService | undefined;
  readonly #pauses: PauseGuard | undefined;
  readonly #decisions: DecisionGuard | undefined;
  readonly #hooks: GenerationServiceOptions["testHooks"];

  private constructor(runner: CommandRunner, deps: { assignments?: AssignmentService; effects?: EffectService; pauses?: PauseGuard; decisions?: DecisionGuard }, options: GenerationServiceOptions) {
    this.#runner = runner;
    this.#assignments = deps.assignments;
    this.#effects = deps.effects;
    this.#pauses = deps.pauses;
    this.#decisions = deps.decisions;
    this.#hooks = options.testHooks;
  }

  static withEpoch(storage: ConstructorParameters<typeof CommandRunner>[0], epoch: number, deps: { assignments?: AssignmentService; effects?: EffectService; pauses?: PauseGuard; decisions?: DecisionGuard } = {}, options: GenerationServiceOptions = {}): GenerationService {
    return new GenerationService(new CommandRunner(storage, epoch, options), deps, options);
  }

  static runIdOf(taskId: string, n: number): string { return runIdOf(checkTaskId(taskId), whole(n, "number")); }

  /** Begins a generation bound to the task's current context revision. Refused while the task is held or if the revision is not the current one. A running or finished generation of the task is superseded (another principal's only by the installation owner, assignment.manage or a valid fence). */
  async begin(principal: Principal, command: BeginRun): Promise<{ id: string; number: number; replayed: boolean }> {
    onlyKnown(command, ["commandId", "taskId", "contextRevision", "fence"]);
    const taskId = checkTaskId(command.taskId);
    const bound = whole(command.contextRevision, "contextRevision");
    const fence = command.fence === undefined ? undefined : checkFence(command.fence);
    if (fence !== undefined && this.#assignments === undefined) invalid("fence", "cannot be checked: this service has no assignment service");
    const task = await this.#task(principal, "attempt.work", taskId);
    const scoped = scopedCommandId(principal.id, command.commandId);
    return this.#retrying(async () => {
      const result = await this.#runner.command("generation.begin", { commandId: scoped, actor: principal.id }, async () => ({
        payload: { taskId, contextRevision: bound, ...(fence === undefined ? {} : { fence: fence as unknown as JsonObject }) },
        build: async () => {
          const gate = await this.#gate(taskId, task.projectId);
          if (gate.body.hold !== undefined) throw new GenerationRefused("held", `task ${taskId} is held (${gate.body.hold.mode}: ${gate.body.hold.reason}); no generation begins until it is released`);
          if (bound !== gate.body.contextRevision) throw new GenerationRefused("stale", `context revision ${bound} is not the current one (${gate.body.contextRevision})`);
          const paused = [...(await this.#pauseChanges(taskId)), ...(await this.#decisionChanges(taskId, "start"))];
          const guard = fence === undefined ? undefined : await this.#assignments!.guardFor(fence).check(taskId);
          const at = this.#runner.now();
          const changes: Change[] = [];
          const settle: { effectId: string; outcome: "failed"; evidence: JsonObject }[] = [];
          if (gate.body.current !== undefined) {
            const previous = await this.#runner.get("generation-run", runIdOf(taskId, gate.body.current));
            if (previous !== undefined && (previous.body as unknown as RunBody).state !== "interrupted") {
              // Cutting another principal's generation (which withdraws its calls and effects) takes authority: the installation owner, assignment.manage, or a valid fence.
              const mine = (previous.body as unknown as RunBody).owner === principal.id;
              if (!mine && principal.kind !== "owner" && fence === undefined && !allows(principal, "assignment.manage", task.projectId, { resource: { kind: "task", id: taskId } })) throw new DomainError("forbidden", `${(previous.body as unknown as RunBody).owner} has a generation running on task ${taskId}; ${principal.id} may not supersede it`);
              const cut = await this.#cut(previous, { kind: "superseded", by: principal.id, reason: `generation ${gate.body.runs + 1} began`, at }, at);
              changes.push(...cut.changes);
              settle.push(...cut.settle);
            }
          }
          const number = gate.body.runs + 1;
          const id = runIdOf(taskId, number);
          const ref: AggregateRef = { kind: "generation-run", id };
          const run: RunBody = {
            taskId, projectId: task.projectId, owner: principal.id, number, contextRevision: bound, ...(fence === undefined ? {} : { fence }),
            state: "streaming", text: "", chunks: 0, toolCalls: [], late: [], lateCount: 0, startedAt: at,
          };
          changes.push(this.#write(gate.ref, gate.revision, { ...gate.body, runs: number, current: number }), { type: "create", ref, body: clean(run) }, ...paused, ...(guard?.changes ?? []));
          return { ref, creates: true, changes: mergeChanges(changes), detail: { taskId, number, contextRevision: bound }, ...(settle.length === 0 ? {} : { settle }) };
        },
      }));
      return { id: result.id, number: Number(result.id.slice(-10)), replayed: result.replayed };
    });
  }

  /**
   * Adds one chunk of the stream: text, or a piece of a tool call's arguments (`done` ends the call). Chunks are numbered from 1 with no gaps. If the generation was interrupted the chunk is not applied: it is
   * recorded as late and the answer says so (`applied: false`).
   */
  async record(principal: Principal, command: RecordChunk): Promise<{ applied: boolean; late: boolean; replayed: boolean }> {
    onlyKnown(command, ["commandId", "runId", "seq", "text", "toolCall"]);
    const seq = whole(command.seq, "seq");
    if ((command.text === undefined) === (command.toolCall === undefined)) invalid("text", "give exactly one of text and toolCall");
    let delta: { id: string; name?: string; argumentsDelta: string; done: boolean } | undefined;
    if (command.text !== undefined) {
      if (typeof command.text !== "string" || command.text.length === 0 || command.text.length > GENERATION_LIMITS.delta) invalid("text", `must be 1 to ${GENERATION_LIMITS.delta} characters`);
    } else {
      const t = command.toolCall as unknown;
      if (t === null || typeof t !== "object" || Array.isArray(t)) invalid("toolCall", "must be an object");
      onlyKnown(t as object, ["id", "name", "argumentsDelta", "done"]);
      const c = t as { id?: unknown; name?: unknown; argumentsDelta?: string; done?: unknown };
      if (typeof c.id !== "string" || !CALL_ID.test(c.id)) invalid("toolCall.id", "must be 1 to 80 letters, digits or . _ : -");
      if (c.name !== undefined && (typeof c.name !== "string" || !CALL_ID.test(c.name))) invalid("toolCall.name", "must be 1 to 80 letters, digits or . _ : -");
      if (c.argumentsDelta !== undefined && (typeof c.argumentsDelta !== "string" || c.argumentsDelta.length > GENERATION_LIMITS.delta)) invalid("toolCall.argumentsDelta", `must be a string of at most ${GENERATION_LIMITS.delta} characters`);
      if (c.done !== undefined && typeof c.done !== "boolean") invalid("toolCall.done", "must be true or false");
      if ((c.argumentsDelta === undefined || c.argumentsDelta.length === 0) && c.done !== true && c.name === undefined) invalid("toolCall", "carries nothing");
      delta = { id: c.id as string, ...(c.name === undefined ? {} : { name: c.name as string }), argumentsDelta: c.argumentsDelta ?? "", done: c.done === true };
    }
    const found = await this.#mine(principal, command.runId, "attempt.work");
    const scoped = scopedCommandId(principal.id, command.commandId);
    return this.#retrying(async () => {
      let outcome: { applied: boolean; late: boolean } = { applied: false, late: false };
      const result = await this.#runner.command("generation.record", { commandId: scoped, actor: principal.id }, async () => ({
        payload: { runId: found.id, seq, ...(command.text === undefined ? {} : { text: command.text }), ...(delta === undefined ? {} : { toolCall: delta as unknown as JsonObject }) },
        build: async () => {
          const current = await this.#load(found.id);
          const run = current.body;
          const at = this.#runner.now();
          const ref: AggregateRef = { kind: "generation-run", id: found.id };
          if (run.state === "interrupted") {
            // Late: recorded, never applied.
            const raw = command.text ?? `${delta!.id}:${delta!.name ?? ""}:${delta!.argumentsDelta}:${delta!.done}`;
            const entry: LateResult = {
              kind: command.text === undefined ? "tool_call" : "text", seq, bytes: raw.length, digest: digestOf(raw),
              ...(command.text === undefined ? { toolCallId: delta!.id } : { preview: redactText(command.text).slice(0, GENERATION_LIMITS.preview) }), at,
            };
            outcome = { applied: false, late: true };
            return { ref, creates: false, changes: [this.#write(ref, current.revision, this.#withLate(run, entry))], detail: { late: true, seq } };
          }
          if (run.state !== "streaming") throw new GenerationRefused(run.state === "held" ? "held" : "stale", `generation ${found.id} is ${run.state}; it takes no more chunks`);
          if (seq !== run.chunks + 1) invalid("seq", `the next chunk is ${run.chunks + 1}, not ${seq}`);
          let next: RunBody;
          if (command.text !== undefined) {
            const joined = run.text + command.text;
            if (joined.length > GENERATION_LIMITS.text) invalid("text", `a generation holds at most ${GENERATION_LIMITS.text} characters of text`);
            if (redactText(command.text) !== command.text || redactText(joined.slice(-2048)) !== joined.slice(-2048)) invalid("text", "looks like a credential or key; those are not recorded");
            next = { ...run, text: joined, chunks: seq };
          } else {
            next = { ...run, toolCalls: this.#extend(run.toolCalls, delta!), chunks: seq };
          }
          outcome = { applied: true, late: false };
          return { ref, creates: false, changes: [this.#write(ref, current.revision, next)], detail: { seq } };
        },
      }));
      // A replay reports what the first application did.
      if (result.replayed) return { ...(await this.#replayedChunk(found.id, seq)), replayed: true };
      return { ...outcome, replayed: false };
    });
  }

  /** Ends the stream. Tool calls still being streamed are dropped for good. Under a finish-and-hold the generation becomes `held`. If it was interrupted, the completion is recorded as late and nothing changes. */
  async complete(principal: Principal, command: NoActor & { runId: string }): Promise<{ state: RunState; late: boolean; replayed: boolean }> {
    onlyKnown(command, ["commandId", "runId"]);
    const found = await this.#mine(principal, command.runId, "attempt.work");
    const scoped = scopedCommandId(principal.id, command.commandId);
    return this.#retrying(async () => {
      const result = await this.#runner.command("generation.complete", { commandId: scoped, actor: principal.id }, async () => ({
        payload: { runId: found.id },
        build: async () => {
          const current = await this.#load(found.id);
          const run = current.body;
          const ref: AggregateRef = { kind: "generation-run", id: found.id };
          const at = this.#runner.now();
          if (run.state === "interrupted") {
            return { ref, creates: false, changes: [this.#write(ref, current.revision, this.#withLate(run, { kind: "completion", bytes: 0, digest: digestOf(""), at }))], detail: { late: true } };
          }
          if (run.state !== "streaming") throw new GenerationRefused(run.state === "held" ? "held" : "stale", `generation ${found.id} is already ${run.state}`);
          const gate = await this.#gate(run.taskId, run.projectId);
          const held = gate.body.hold !== undefined;
          const toolCalls = run.toolCalls.map((c): ToolCall => (c.state === "partial" ? { ...c, state: "dropped", reason: "the stream ended before its arguments were complete" } : held && c.state === "complete" ? { ...c, state: "held" } : c));
          const next: RunBody = { ...run, state: held ? "held" : "finished", toolCalls, finishedAt: at };
          return { ref, creates: false, changes: [this.#write(ref, current.revision, next), { type: "check", ref: gate.ref, expectedRevision: gate.revision }], detail: { state: next.state } };
        },
      }));
      const stored = (await this.#runner.get("generation-run", found.id))!.body as unknown as RunBody;
      void result;
      const lateNow = stored.state === "interrupted";
      return { state: stored.state, late: lateNow, replayed: result.replayed };
    });
  }

  /**
   * Pause, immediately: sets the hold on the task and, in the same commit, acts on the current generation. `cancel` cuts it (unadmitted calls withdrawn or dropped, effects that have not started withdrawn).
   * `finish_and_hold` leaves a streaming generation to end (it then becomes `held`) and holds a finished one. While held, `begin`, `admitEffect` and `execute` are refused. Asking for the mode already in force is refused;
   * a cancel may follow a finish-and-hold.
   */
  async interrupt(principal: Principal, command: NoActor & { taskId: string; mode: HoldMode; reason: string }): Promise<{ runId?: string; cut: boolean; replayed: boolean }> {
    onlyKnown(command, ["commandId", "taskId", "mode", "reason"]);
    const taskId = checkTaskId(command.taskId);
    if (command.mode !== "finish_and_hold" && command.mode !== "cancel") invalid("mode", "must be finish_and_hold or cancel");
    const mode = command.mode;
    const reason = plain(command.reason, "reason", GENERATION_LIMITS.reason);
    const task = await this.#task(principal, "assignment.manage", taskId);
    const scoped = scopedCommandId(principal.id, command.commandId);
    let cutNow = false;
    let runId: string | undefined;
    return this.#retrying(async () => {
      const result = await this.#runner.command("generation.interrupt", { commandId: scoped, actor: principal.id }, async () => ({
        payload: { taskId, mode, reason },
        build: async () => {
          const gate = await this.#gate(taskId, task.projectId);
          if (gate.body.hold?.mode === mode || gate.body.hold?.mode === "cancel") throw new DomainError("invalid_command", `task ${taskId} is already held (${gate.body.hold.mode})`, { field: "mode" });
          const at = this.#runner.now();
          const hold: Hold = { mode, by: principal.id, reason, at };
          const changes: Change[] = [this.#write(gate.ref, gate.revision, { ...gate.body, hold })];
          const settle: { effectId: string; outcome: "failed"; evidence: JsonObject }[] = [];
          cutNow = false;
          runId = gate.body.current === undefined ? undefined : runIdOf(taskId, gate.body.current);
          const run = runId === undefined ? undefined : await this.#runner.get("generation-run", runId);
          if (run !== undefined) {
            const body = run.body as unknown as RunBody;
            if (mode === "cancel" && body.state !== "interrupted") {
              const cut = await this.#cut(run, { kind: "cancelled", by: principal.id, reason, at }, at);
              changes.push(...cut.changes);
              settle.push(...cut.settle);
              cutNow = true;
            } else if (mode === "finish_and_hold" && body.state === "finished") {
              const ref: AggregateRef = { kind: "generation-run", id: run.id };
              changes.push(this.#write(ref, run.revision, { ...body, state: "held", toolCalls: body.toolCalls.map((c): ToolCall => (c.state === "complete" ? { ...c, state: "held" } : c)) }));
            }
          }
          return { ref: gate.ref, creates: false, changes, detail: { taskId, mode, ...(runId === undefined ? {} : { runId }) }, ...(settle.length === 0 ? {} : { settle }) };
        },
      }));
      // A replay did not build, so it reports the task's current generation as it stands now.
      if (result.replayed) {
        const g = (await this.#runner.get("generation-gate", gateIdOf(taskId)))?.body as unknown as GateBody | undefined;
        runId = g?.current === undefined ? undefined : runIdOf(taskId, g.current);
        cutNow = await this.#wasCut(runId);
      }
      return { ...(runId === undefined ? {} : { runId }), cut: cutNow, replayed: result.replayed };
    });
  }

  /** Lifts the hold. A held generation's calls stay held: each needs `admitEffect` (the controller's readmission), which is still refused if the generation has since been superseded or the context corrected. */
  async release(principal: Principal, command: NoActor & { taskId: string; reason: string }): Promise<{ replayed: boolean }> {
    onlyKnown(command, ["commandId", "taskId", "reason"]);
    const taskId = checkTaskId(command.taskId);
    const reason = plain(command.reason, "reason", GENERATION_LIMITS.reason);
    const task = await this.#task(principal, "assignment.manage", taskId);
    const scoped = scopedCommandId(principal.id, command.commandId);
    return this.#retrying(async () => {
      const result = await this.#runner.command("generation.release", { commandId: scoped, actor: principal.id }, async () => ({
        payload: { taskId, reason },
        build: async () => {
          const gate = await this.#gate(taskId, task.projectId);
          if (gate.body.hold === undefined) throw new DomainError("invalid_command", `task ${taskId} is not held`, { field: "taskId" });
          const { hold: _hold, ...rest } = gate.body;
          return { ref: gate.ref, creates: false, changes: [this.#write(gate.ref, gate.revision, rest as GateBody)], detail: { taskId, released: gate.body.hold.mode, reason } };
        },
      }));
      return { replayed: result.replayed };
    });
  }

  /**
   * A correction: raises the task's context revision (the caller names the revision it saw, so two corrections cannot both apply to one) and interrupts the current generation, if any. Anything that arrives
   * for it afterwards is late. It does not hold the task: the next generation begins at the new revision.
   */
  async correct(principal: Principal, command: NoActor & { taskId: string; expectedContextRevision: number; reason: string }): Promise<{ contextRevision: number; replayed: boolean }> {
    onlyKnown(command, ["commandId", "taskId", "expectedContextRevision", "reason"]);
    const taskId = checkTaskId(command.taskId);
    const expected = whole(command.expectedContextRevision, "expectedContextRevision");
    const reason = plain(command.reason, "reason", GENERATION_LIMITS.reason);
    const task = await this.#task(principal, "assignment.manage", taskId);
    const scoped = scopedCommandId(principal.id, command.commandId);
    return this.#retrying(async () => {
      const result = await this.#runner.command("generation.correct", { commandId: scoped, actor: principal.id }, async () => ({
        payload: { taskId, expectedContextRevision: expected, reason },
        build: async () => {
          const gate = await this.#gate(taskId, task.projectId);
          if (gate.body.contextRevision !== expected) throw new DomainError("stale_revision", `task ${taskId} is at context revision ${gate.body.contextRevision}, not ${expected}`, { currentRevision: gate.body.contextRevision, field: "expectedContextRevision" });
          const at = this.#runner.now();
          const changes: Change[] = [this.#write(gate.ref, gate.revision, { ...gate.body, contextRevision: expected + 1, corrections: gate.body.corrections + 1 })];
          const settle: { effectId: string; outcome: "failed"; evidence: JsonObject }[] = [];
          if (gate.body.current !== undefined) {
            const run = await this.#runner.get("generation-run", runIdOf(taskId, gate.body.current));
            if (run !== undefined && (run.body as unknown as RunBody).state !== "interrupted") {
              const cut = await this.#cut(run, { kind: "corrected", by: principal.id, reason, at }, at);
              changes.push(...cut.changes);
              settle.push(...cut.settle);
            }
          }
          return { ref: gate.ref, creates: false, changes, detail: { taskId, contextRevision: expected + 1 }, ...(settle.length === 0 ? {} : { settle }) };
        },
      }));
      void result;
      return { contextRevision: expected + 1, replayed: result.replayed };
    });
  }

  /**
   * Admits a finished generation's complete tool call as an effect (S05): the intent is recorded in the same commit that checks the hold, the generation (current, at the current revision, not interrupted) and the call.
   * `kind` and `target` say what the effect is (the tool mapping is T-card territory); the input is the call's arguments. A call that is partial, dropped or withdrawn, or a generation that is streaming, is refused.
   */
  async admitEffect(principal: Principal, command: NoActor & { runId: string; toolCallId: string; kind: string; target: string }): Promise<{ effectId: string; replayed: boolean }> {
    onlyKnown(command, ["commandId", "runId", "toolCallId", "kind", "target"]);
    if (typeof command.toolCallId !== "string" || !CALL_ID.test(command.toolCallId)) invalid("toolCallId", "is not a tool call ID");
    const kind = typeof command.kind === "string" && KIND.test(command.kind) ? command.kind : invalid("kind", "must be 1 to 40 lower-case letters, digits or hyphens, starting with a letter");
    const target = text(command.target, "target", { min: 1, max: GENERATION_LIMITS.target });
    const found = await this.#mine(principal, command.runId, "attempt.work");
    const run0 = found.body as unknown as RunBody;
    if (principal.kind !== "owner" && !allows(principal, "effect.perform", run0.projectId, { resource: { kind: "task", id: run0.taskId } })) throw new DomainError("forbidden", `${principal.id} may not perform effects on that task`);
    const scoped = scopedCommandId(principal.id, command.commandId);
    const effectId = derivedId("eff", scoped);
    return this.#retrying(async () => {
      const result = await this.#runner.command("generation.admit", { commandId: scoped, actor: principal.id }, async () => ({
        payload: { runId: found.id, toolCallId: command.toolCallId, kind, target },
        build: async () => {
          const current = await this.#load(found.id);
          const run = current.body;
          const gate = await this.#gate(run.taskId, run.projectId);
          const call = run.toolCalls.find((c) => c.id === command.toolCallId);
          if (call === undefined) invalid("toolCallId", "is not a tool call of this generation");
          const refusal = this.#blocked(gate.body, run);
          if (refusal !== undefined) throw refusal;
          const paused = [...(await this.#pauseChanges(run.taskId)), ...(await this.#decisionChanges(run.taskId, "effect"))];
          if (call!.state === "admitted") throw new GenerationRefused("admitted", `tool call ${call!.id} is already admitted`);
          if (call!.state === "withdrawn") throw new GenerationRefused("interrupted", `tool call ${call!.id} was withdrawn`);
          if (call!.state !== "complete" && call!.state !== "held") throw new GenerationRefused("incomplete", `tool call ${call!.id} is ${call!.state}: only a complete call becomes an effect`);
          if (run.state === "streaming") throw new GenerationRefused("streaming", `generation ${found.id} is still streaming`);
          const input = JSON.parse(call!.args) as JsonObject;
          const guard = run.fence === undefined ? undefined : await this.#assignments!.guardFor(run.fence).check(run.taskId);
          const inputDigest = sha256(canonicalJson(input));
          const ref: AggregateRef = { kind: "generation-run", id: found.id };
          const effectRef: AggregateRef = { kind: "effect", id: effectId };
          const effect: EffectBody = { kind, target, input, inputDigest, key: effectId, createdBy: principal.id, taskId: run.taskId, ...(run.fence === undefined ? {} : { fence: run.fence }), started: false };
          const entry: EffectEntry = { effectId, ...(run.fence === undefined ? {} : { attemptId: run.fence.attemptId }), target, inputDigest, reconciliationHandle: effectId };
          const next: RunBody = { ...run, toolCalls: run.toolCalls.map((c) => (c.id === call!.id ? { ...c, state: "admitted", effectId } : c)) };
          return {
            ref, creates: false,
            changes: mergeChanges([this.#write(ref, current.revision, next), { type: "check", ref: gate.ref, expectedRevision: gate.revision }, { type: "create", ref: effectRef, body: effect as unknown as JsonObject }, ...paused, ...(guard?.changes ?? [])]),
            detail: { runId: found.id, toolCallId: call!.id, effectId, kind, target, inputDigest }, effects: [entry],
          };
        },
      }));
      return { effectId, replayed: result.replayed };
    });
  }

  /**
   * The hold check as a `beforeStart` hook for `EffectService.run`. Anything that starts an effect of this task outside `execute` (the slice pipeline, a future dispatcher) must pass it, or a pause
   * does not stop that effect: only effects admitted and started through this service are gated otherwise. An effect that already started is not consulted (it is only reconciled).
   */
  guardFor(taskId: string): () => Promise<readonly Change[]> {
    const id = checkTaskId(taskId);
    return async () => {
      const gate = await this.#runner.get("generation-gate", gateIdOf(id));
      const hold = (gate?.body as unknown as GateBody | undefined)?.hold;
      if (hold !== undefined) throw new GenerationRefused("held", `task ${id} is held (${hold.mode}: ${hold.reason}); no new effect starts until it is released`);
      const paused = [...(await this.#pauseChanges(id)), ...(await this.#decisionChanges(id, "effect"))];
      return gate === undefined ? paused : mergeChanges([{ type: "check", ref: { kind: "generation-gate", id: gateIdOf(id) }, expectedRevision: gate.revision }, ...paused]);
    };
  }

  /**
   * Starts (or, after doubt, recovers) the effect of an admitted call through the ledger. An effect that has not started is refused while the task is held or the generation was interrupted or is no longer current,
   * and the check commits with the claim, so a pause landing meanwhile either comes first (refused) or finds the effect started. An effect that has started is only ever reconciled by the ledger, as S05 says.
   */
  async execute(principal: Principal, command: { runId: string; toolCallId: string }, bridge: EffectBridge): Promise<EffectOutcome> {
    onlyKnown(command, ["runId", "toolCallId"]);
    const effects = this.#effects ?? invalid("effects", "this service has no effect service");
    const found = await this.#mine(principal, command.runId, "attempt.work");
    const run = found.body as unknown as RunBody;
    if (principal.kind !== "owner" && !allows(principal, "effect.perform", run.projectId, { resource: { kind: "task", id: run.taskId } })) throw new DomainError("forbidden", `${principal.id} may not perform effects on that task`);
    const call = run.toolCalls.find((c) => c.id === command.toolCallId);
    if (call === undefined || call.effectId === undefined) invalid("toolCallId", "is not an admitted tool call of this generation");
    if (call!.state === "withdrawn") {
      const ledger = await effects.get(call!.effectId!);
      if (ledger !== undefined && ledger.status !== "intended") return { effectId: call!.effectId!, status: ledger.status, ...(ledger.evidence === undefined ? {} : { evidence: ledger.evidence }) };
      throw new GenerationRefused("interrupted", `tool call ${call!.id} was withdrawn`);
    }
    return effects.run(call!.effectId!, bridge, {
      beforeStart: async () => {
        const gate = await this.#gate(run.taskId, run.projectId);
        const current = await this.#load(found.id);
        const refusal = this.#blocked(gate.body, current.body);
        if (refusal !== undefined) throw refusal;
        const paused = [...(await this.#pauseChanges(run.taskId)), ...(await this.#decisionChanges(run.taskId, "effect"))];
        await this.#hooks?.afterGuardRead?.();
        return mergeChanges([{ type: "check", ref: gate.ref, expectedRevision: gate.revision }, { type: "check", ref: { kind: "generation-run", id: found.id }, expectedRevision: current.revision }, ...paused]);
      },
    });
  }

  /** Records on each admitted call what the effect ledger now says. An outcome recorded for an interrupted generation (or a held task) is marked `afterInterruption`: it is the ledger's truth, shown as late, not the generation's current result. */
  async reconcile(principal: Principal, command: NoActor & { runId: string }): Promise<{ revision: number; replayed: boolean }> {
    onlyKnown(command, ["commandId", "runId"]);
    if (this.#effects === undefined) invalid("effects", "this service has no effect service");
    const found = await this.#mine(principal, command.runId, "attempt.work");
    const scoped = scopedCommandId(principal.id, command.commandId);
    return this.#retrying(async () => {
      const r = await this.#runner.command("generation.reconcile", { commandId: scoped, actor: principal.id }, async () => ({
        payload: { runId: found.id },
        build: async () => {
          const current = await this.#load(found.id);
          const run = current.body;
          const gate = await this.#gate(run.taskId, run.projectId);
          const after = run.state === "interrupted" || gate.body.hold !== undefined;
          const at = this.#runner.now();
          const calls: ToolCall[] = [];
          for (const c of run.toolCalls) {
            if (c.effectId === undefined) { calls.push(c); continue; }
            const ledger = await this.#effects!.get(c.effectId);
            if (ledger === undefined || ledger.status === "intended" || c.effect?.status === ledger.status) { calls.push(c); continue; }
            calls.push({ ...c, effect: { status: ledger.status, at, afterInterruption: after } });
          }
          const ref: AggregateRef = { kind: "generation-run", id: found.id };
          return { ref, creates: false, changes: [this.#write(ref, current.revision, { ...run, toolCalls: calls })], detail: { runId: found.id } };
        },
      }));
      return { revision: r.revision, replayed: r.replayed };
    });
  }

  /** The generation as this viewer may see it (its streamer, the installation owner, or a reader of the task's assignment); anyone else gets `undefined`, as for a missing generation. */
  async view(viewer: Principal, runId: string): Promise<RunView | undefined> {
    const found = typeof runId === "string" && RUN_ID.test(runId) ? await this.#runner.get("generation-run", runId) : undefined;
    if (found === undefined) return undefined;
    const run = found.body as unknown as RunBody;
    if (!this.#mayRead(viewer, run)) return undefined;
    const gate = (await this.#runner.get("generation-gate", gateIdOf(run.taskId)))?.body as unknown as GateBody | undefined;
    return { run: view<RunBody>(found), current: gate !== undefined && run.state !== "interrupted" && gate.current === run.number && gate.contextRevision === run.contextRevision };
  }

  /** The task's gate: context revision, current generation and any hold. A task nothing has happened to has none. */
  async gate(viewer: Principal, taskId: string): Promise<GateView | undefined> {
    const id = checkTaskId(taskId);
    const found = await this.#runner.get("generation-gate", gateIdOf(id));
    if (found === undefined) return undefined;
    const g = found.body as unknown as GateBody;
    if (!this.#mayRead(viewer, { projectId: g.projectId, taskId: g.taskId, owner: "" })) return undefined;
    return { gate: view<GateBody>(found) };
  }

  // ---- internals -------------------------------------------------------------------------------------------------------------

  #mayRead(viewer: Principal, run: { projectId: string; taskId: string; owner: string }): boolean {
    if (viewer.kind === "owner") return true;
    if (!inTaskScope(viewer, run.projectId)) return false;
    const resource = { resource: { kind: "task", id: run.taskId } } as const;
    return viewer.id === run.owner ? allows(viewer, "attempt.work", run.projectId, resource) : allows(viewer, "assignment.read", run.projectId, resource);
  }

  /** Refuses (reason `paused`) if any pause gate (L01) on the task's chain is paused; otherwise the revision checks of those gates, to commit with the caller's change. Without a pause service there is nothing to check. */
  async #pauseChanges(taskId: string): Promise<readonly Change[]> {
    if (this.#pauses === undefined) return [];
    const g = await this.#pauses.guard(taskId);
    await this.#hooks?.afterPauseRead?.();
    if (g.blockedBy.length > 0) throw new GenerationRefused("paused", `task ${taskId} is paused (${g.blockedBy.map((s) => `${s.kind} ${s.id}`).join(", ")}); no new work starts until it is resumed`);
    return g.changes;
  }

  /** Refuses (reason `decision`) while an owner gate or a decision the task's work relied on stands in the way (card C08); otherwise the revision checks to commit with the caller's change. */
  async #decisionChanges(taskId: string, purpose: "start" | "effect"): Promise<readonly Change[]> {
    if (this.#decisions === undefined) return [];
    const g = await this.#decisions.guard(taskId, purpose);
    await this.#hooks?.afterDecisionRead?.();
    if (g.blockedBy.length > 0) throw new GenerationRefused("decision", `task ${taskId} may not continue: ${g.blockedBy.join("; ")}`);
    return g.changes;
  }

  /** The reason an effect may not be admitted or started from this generation now, if there is one. */
  #blocked(gate: GateBody, run: RunBody): GenerationRefused | undefined {
    if (run.state === "interrupted") return new GenerationRefused("interrupted", `generation ${run.number} was interrupted (${run.interrupted?.kind ?? "interrupted"}); nothing from it is applied`);
    if (gate.hold !== undefined) return new GenerationRefused("held", `task ${run.taskId} is held (${gate.hold.mode}: ${gate.hold.reason}); no new effect starts until it is released`);
    if (gate.current !== run.number || gate.contextRevision !== run.contextRevision) return new GenerationRefused("stale", `generation ${run.number} is not the current one at context revision ${gate.contextRevision}`);
    return undefined;
  }

  async #task(principal: Principal, action: string, taskId: string): Promise<TaskBody> {
    const task = (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined;
    // A task the caller may not act on reads exactly like one that does not exist.
    if (task === undefined || !allows(principal, action, task.projectId, { resource: { kind: "task", id: taskId } }) || !inTaskScope(principal, task.projectId)) throw new DomainError("forbidden", `${principal.id} may not do that on that task`);
    if (task.state === "done" || task.state === "cancelled") throw new DomainError("invalid_command", `task ${taskId} is ${task.state}`, { field: "taskId" });
    return task;
  }

  async #mine(principal: Principal, runId: unknown, action: string): Promise<Aggregate> {
    const found = typeof runId === "string" && RUN_ID.test(runId) ? await this.#runner.get("generation-run", runId) : undefined;
    const run = found?.body as unknown as RunBody | undefined;
    const ok = run !== undefined && (principal.kind === "owner" || (principal.id === run.owner && inTaskScope(principal, run.projectId) && allows(principal, action, run.projectId, { resource: { kind: "task", id: run.taskId } })));
    if (found === undefined || !ok) throw new DomainError("forbidden", `${principal.id} may not use that generation`);
    return found;
  }

  async #load(id: string): Promise<{ revision: number; body: RunBody }> {
    const found = await this.#runner.get("generation-run", id);
    if (found === undefined) throw new DomainError("not_found", `generation ${id} does not exist`);
    return { revision: found.revision, body: found.body as unknown as RunBody };
  }

  /** The task's gate, or the one it would start with (revision 0: written as a create). */
  async #gate(taskId: string, projectId: string): Promise<{ ref: AggregateRef; revision: number; body: GateBody }> {
    const ref: AggregateRef = { kind: "generation-gate", id: gateIdOf(taskId) };
    const found = await this.#runner.get(ref.kind, ref.id);
    return found === undefined ? { ref, revision: 0, body: { taskId, projectId, contextRevision: 1, runs: 0, corrections: 0 } } : { ref, revision: found.revision, body: found.body as unknown as GateBody };
  }

  #write(ref: AggregateRef, revision: number, body: RunBody | GateBody): Change {
    return revision === 0 ? { type: "create", ref, body: clean(body) } : { type: "update", ref, expectedRevision: revision, body: clean(body) };
  }

  #withLate(run: RunBody, entry: LateResult): RunBody {
    return { ...run, late: run.late.length < GENERATION_LIMITS.late ? [...run.late, entry] : run.late, lateCount: run.lateCount + 1 };
  }

  /** The tool call after one more piece of its stream. */
  #extend(calls: readonly ToolCall[], d: { id: string; name?: string; argumentsDelta: string; done: boolean }): ToolCall[] {
    const at = calls.findIndex((c) => c.id === d.id);
    let call: ToolCall;
    if (at < 0) {
      if (d.name === undefined) invalid("toolCall.name", "is required with the first piece of a call");
      if (calls.length >= GENERATION_LIMITS.toolCalls) throw new DomainError("unavailable", `a generation holds at most ${GENERATION_LIMITS.toolCalls} tool calls`);
      call = { id: d.id, name: d.name as string, args: "", state: "partial" };
    } else {
      call = calls[at]!;
      if (call.state !== "partial") invalid("toolCall.id", `call ${d.id} is already ${call.state}; its arguments are final`);
      if (d.name !== undefined && d.name !== call.name) invalid("toolCall.name", "differs from the name the call began with");
    }
    const args = call.args + d.argumentsDelta;
    if (args.length > GENERATION_LIMITS.args) invalid("toolCall.argumentsDelta", `a call's arguments are at most ${GENERATION_LIMITS.args} characters`);
    if (redactText(args) !== args) invalid("toolCall.argumentsDelta", "looks like a credential or key; those are not recorded");
    call = { ...call, args };
    if (d.done) {
      let parsed: unknown;
      try { parsed = JSON.parse(args); } catch { parsed = undefined; }
      call = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? { ...call, state: "complete", argsDigest: sha256(canonicalJson(parsed as JsonObject)) }
        : { ...call, state: "dropped", reason: "the arguments are not a JSON object" };
    }
    return at < 0 ? [...calls, call] : calls.map((c, i) => (i === at ? call : c));
  }

  /**
   * Interrupts a generation: its state, its calls (partial and malformed dropped, complete and held withdrawn) and the effects of admitted calls that have not started (withdrawn: ledger `failed`). An effect that
   * started is left alone. Each such effect is guarded by its revision, so a claim racing the cut either comes first (the effect started: left alone) or loses.
   */
  async #cut(run: Aggregate, interruption: Omit<Interruption, "atChunk">, at: string): Promise<{ changes: Change[]; settle: { effectId: string; outcome: "failed"; evidence: JsonObject }[] }> {
    const body = run.body as unknown as RunBody;
    const changes: Change[] = [];
    const settle: { effectId: string; outcome: "failed"; evidence: JsonObject }[] = [];
    const toolCalls: ToolCall[] = [];
    for (const c of body.toolCalls) {
      if (c.state === "partial") toolCalls.push({ ...c, state: "dropped", reason: "interrupted while its arguments were still arriving" });
      else if (c.state === "complete" || c.state === "held") toolCalls.push({ ...c, state: "withdrawn", reason: `generation ${interruption.kind} before it was admitted` });
      else if (c.state === "admitted" && c.effectId !== undefined) {
        const effect = await this.#runner.get("effect", c.effectId);
        const e = effect?.body as unknown as EffectBody | undefined;
        if (effect !== undefined && e !== undefined && !e.started && e.claim === undefined) {
          changes.push({ type: "check", ref: { kind: "effect", id: c.effectId }, expectedRevision: effect.revision });
          settle.push({ effectId: c.effectId, outcome: "failed", evidence: { reason: `withdrawn: generation ${interruption.kind} before the effect started`, runId: run.id } });
          toolCalls.push({ ...c, state: "withdrawn", reason: `generation ${interruption.kind} before the effect started`, effect: { status: "failed", at, afterInterruption: true } });
        } else toolCalls.push(c);
      } else toolCalls.push(c);
    }
    const ref: AggregateRef = { kind: "generation-run", id: run.id };
    const next: RunBody = { ...body, state: "interrupted", toolCalls, interrupted: { ...interruption, atChunk: body.chunks }, finishedAt: body.finishedAt ?? at };
    return { changes: [this.#write(ref, run.revision, next), ...changes], settle };
  }

  async #replayedChunk(runId: string, seq: number): Promise<{ applied: boolean; late: boolean }> {
    const run = (await this.#runner.get("generation-run", runId))?.body as unknown as RunBody;
    const late = run.late.some((l) => l.seq === seq) ;
    return { applied: !late && seq <= run.chunks, late };
  }

  async #wasCut(runId: string | undefined): Promise<boolean> {
    if (runId === undefined) return false;
    const run = (await this.#runner.get("generation-run", runId))?.body as unknown as RunBody | undefined;
    return run?.interrupted?.kind === "cancelled";
  }

  /** Concurrent writers to one generation or gate meet a revision check; the loser reads again and decides again (a command applies once whatever happens). */
  async #retrying<T>(run: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try { return await run(); } catch (error) {
        // A refusal that names a field is the command's own (a wrong expected revision), not contention: it is not retried.
        if (!(error instanceof DomainError) || (error.code !== "stale_revision" && error.code !== "command_conflict") || error.field !== undefined || attempt >= 8) throw error;
      }
    }
  }
}
