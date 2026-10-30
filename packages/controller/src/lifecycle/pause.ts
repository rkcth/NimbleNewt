import { DomainError } from "../domain/errors.js";
import { assignmentIdOf, type AssignmentBody } from "../domain/assignment-model.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, taskId as checkTaskId, text, type TaskBody, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import type { WaitService } from "../domain/waits.js";
import type { AgentBody, TeamBody } from "../agents/agents.js";
import type { Availability } from "../conversations/index.js";
import { allows, inTaskScope } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { AggregateRef, Change, JsonObject } from "../storage/types.js";

/** Where a lifecycle request applies. `installation` has the one ID `installation`. Organisational descendants are not included implicitly: a team gate reaches the agents whose team chain passes through it because that is how gates are *read*, but nothing is written to the descendants. */
export type PauseScopeKind = "task" | "agent" | "team" | "installation";
export interface PauseScope { readonly kind: PauseScopeKind; readonly id: string }

/** What was asked for (lifecycle intent). Only Pause exists here; Suspend, Suspend and Release, Stop and Force Stop are L02 and L03 and will add modes. */
export type LifecycleIntent = "active" | "pause";
/** What was seen (observed execution), kept apart from the intent: a requested mode is not an observed guarantee. */
export type ObservedState = "idle" | "running" | "pausing" | "paused" | "preparing-to-suspend" | "suspended" | "stopping" | "stopped" | "recovery-required" | "unreachable";
export const OBSERVED_STATES: readonly ObservedState[] = ["idle", "running", "pausing", "paused", "preparing-to-suspend", "suspended", "stopping", "stopped", "recovery-required", "unreachable"];
/** How the foreground stood when `paused` was claimed. `uncooperative` (a tool that will not stop) can never support `paused`. */
export type Boundary = "finished" | "cancelled_recorded" | "uncooperative";
export const BOUNDARIES: readonly Boundary[] = ["finished", "cancelled_recorded", "uncooperative"];
/** Whether permitted background work may still record results while paused. */
export type BackgroundPolicy = "permit" | "deny";

export interface Observation {
  readonly state: ObservedState;
  readonly at: string;
  readonly by: string;
  readonly boundary?: Boundary;
  readonly evidence?: string;
}

/** One gate per scope (kind `pause-gate`, ID derived from the scope). It is created active, lazily, the first time anything is checked against the scope, and never deleted, so every check can be guarded by its revision. */
export interface PauseGateBody {
  readonly scope: PauseScope;
  /** Task scope only. */
  readonly projectId?: string;
  readonly intent: LifecycleIntent;
  /** The owner's recorded, authorized condition for lifting this pause (card L06b): the time after which the controller lifts it. It belongs to the pause it was set for; a resume or a new pause drops it. */
  readonly resumeAt?: { readonly at: string; readonly setBy: string; readonly setAt: string };
  /** Present while paused. */
  readonly mode?: "pause";
  /** Who paused it. Kept until the gate is resumed; resuming never silently changes it to someone else. */
  readonly owner?: string;
  readonly pausedAt?: string;
  readonly reason?: string;
  readonly requestId?: string;
  readonly background: BackgroundPolicy;
  readonly observed?: Observation;
  /** Requests so far (pauses and resumes); the next request is this plus 1. */
  readonly requests: number;
}

/** What each request records (kind `pause-request`, immutable): actor, scope, mode, operation ID and the policy revision in force. */
export interface PauseRequestBody {
  readonly gateId: string;
  readonly seq: number;
  readonly scope: PauseScope;
  readonly action: "pause" | "resume";
  readonly mode: "pause";
  readonly actor: string;
  /** The caller's own command ID. */
  readonly operationId: string;
  readonly policyRevision: { readonly installation: number; readonly project?: number };
  readonly reason: string;
  readonly background?: BackgroundPolicy;
  readonly at: string;
}

export type BackgroundOutcome = "succeeded" | "failed" | "cancelled";
export interface BackgroundResultBody {
  readonly taskId: string;
  readonly projectId: string;
  readonly jobRef: string;
  readonly outcome: BackgroundOutcome;
  readonly summary: string;
  readonly recordedBy: string;
  readonly at: string;
  /** The gates that were in force when it was recorded: the result is recorded, and none of them is lifted. */
  readonly pausedBy: readonly PauseScope[];
  readonly answeredWaitId?: string;
}

/**
 * A bounded permission for one meeting task of an agent that is itself paused (agent, team or installation gate): the owner invited the agent by hand, so the agent may attend this one meeting while all its other work stays paused
 * (kind `pause-exemption`, one per task, ID derived from the task). It exists only for the meeting task named, only while `active` and before `expiresAt` (a lease; time from the injected clock), and only while that task is assigned to the agent.
 * It lifts no gate and the task's own gate still applies. Written by the meeting attendance service (M04); nothing else reads it.
 */
export interface PauseExemptionBody {
  readonly taskId: string;
  /** The agent ID (`agt-...`) the meeting task is assigned to. */
  readonly agentId: string;
  readonly occurrenceId: string;
  readonly grantedBy: string;
  readonly grantedAt: string;
  readonly expiresAt: string;
  readonly state: "active" | "ended";
  readonly endedAt?: string;
  /** The agent, team and installation-free pause gates the permission covers: the ones that held the agent when the owner's invitation was granted, each with the request that paused it. A gate paused again or newly, and any installation pause, still blocks the meeting task. */
  readonly covers: readonly { readonly kind: "agent" | "team"; readonly id: string; readonly requestId: string }[];
}
export const PAUSE_EXEMPTION_KIND = "pause-exemption";
export const exemptionIdOf = (taskId: string): string => `pxm-${checkTaskId(taskId).slice(5)}`;

export type ReplaceTrigger = "idle_replacement" | "urgent_deadline" | "elapsed_time";
const REPLACE_TRIGGERS: readonly ReplaceTrigger[] = ["idle_replacement", "urgent_deadline", "elapsed_time"];

/** What generation, effect starters and the reconciler consult. */
export interface PauseGuard {
  /** The gates (nearest first) that are paused for the task, and the changes that make the caller's commit fail if any applicable gate moves meanwhile (absent gates are created active). */
  guard(taskId: string): Promise<{ readonly blockedBy: readonly PauseScope[]; readonly changes: readonly Change[] }>;
}
/** The read-only question the reconciler asks. */
export interface PauseLookup { isPaused(taskId: string): Promise<boolean> }

export interface PauseOptions extends RunnerOptions {
  /** Test seam: runs between reading the gates for a background result and committing it. */
  readonly testHooks?: { readonly afterBackgroundRead?: () => Promise<void> };
  /** Reports suspended and stopped agents (L02, L03 will supply it) for `availability`; consulted only when no pause applies. Default: available. */
  readonly otherAvailability?: (principalId: string) => Promise<Availability>;
}

export const PAUSE_LIMITS = { reason: 500, evidence: 500, summary: 1000, jobRef: 120, chain: 64 } as const;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const plain = (value: unknown, field: string, max: number): string => {
  const out = text(value, field, { min: 1, max, multiline: true });
  if (redactText(out) !== out) invalid(field, "looks like a credential or key; those are not recorded");
  return out;
};
const SCOPE_KINDS: readonly PauseScopeKind[] = ["task", "agent", "team", "installation"];
const AGENT_ID = /^agt-[a-z2-7]{20}$/;
const TEAM_ID = /^team-[a-z2-7]{20}$/;
const gateIdOf = (scope: PauseScope): string => derivedId("pgt", `${scope.kind}\0${scope.id}`);
const requestIdOf = (gateId: string, seq: number): string => derivedId("prq", `${gateId}\0${seq}`);
const sameScope = (a: PauseScope, b: PauseScope): boolean => a.kind === b.kind && a.id === b.id;
const clean = (body: object): JsonObject => Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) as unknown as JsonObject;
const pad = (n: number): string => String(n).padStart(10, "0");

function checkScope(value: unknown): PauseScope {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid("scope", "must be an object with kind and id");
  onlyKnown(value as object, ["kind", "id"]);
  const s = value as { kind?: unknown; id?: unknown };
  if (typeof s.kind !== "string" || !(SCOPE_KINDS as readonly string[]).includes(s.kind)) return invalid("scope.kind", `must be one of ${SCOPE_KINDS.join(", ")}`);
  const kind = s.kind as PauseScopeKind;
  if (kind === "task") return { kind, id: checkTaskId(s.id) };
  if (kind === "agent") return typeof s.id === "string" && AGENT_ID.test(s.id) ? { kind, id: s.id } : invalid("scope.id", "is not an agent ID");
  if (kind === "team") return typeof s.id === "string" && TEAM_ID.test(s.id) ? { kind, id: s.id } : invalid("scope.id", "is not a team ID");
  return s.id === "installation" ? { kind, id: "installation" } : invalid("scope.id", "the installation scope has the ID installation");
}

export interface PauseRequest extends NoActor { readonly scope: PauseScope; readonly reason: string; readonly background?: BackgroundPolicy }
export interface ResumeRequest extends NoActor { readonly scope: PauseScope; readonly reason: string }
export interface ResumeConditionRequest extends NoActor { readonly scope: PauseScope; /** UTC time (ISO 8601) after which the controller lifts this pause. */ readonly at: string }
export interface ObserveRequest extends NoActor { readonly scope: PauseScope; readonly state: ObservedState; readonly boundary?: Boundary; readonly evidence?: string }
export interface BackgroundRequest extends NoActor {
  readonly taskId: string;
  readonly jobRef: string;
  readonly outcome: BackgroundOutcome;
  readonly summary: string;
  /** The typed wait (S08) this result answers, if any. The caller must be the wait's named resolver (or the owner): a result does not let anyone answer a wait meant for someone else. Nothing about the pause changes. */
  readonly answerWait?: { readonly waitId: string; readonly expectedRevision: number; readonly answer: string };
}
export interface GateStatus { readonly scope: PauseScope; readonly gate: View<PauseGateBody> }
export interface PauseStatus {
  readonly taskId: string;
  readonly paused: boolean;
  /** Paused gates that apply to the task, nearest first. */
  readonly gates: readonly GateStatus[];
}

/**
 * Durable Pause gates and permitted background settlement (card L01). The gate is separate from the task, its assignment and the model-response control of L05:
 *
 * - **Intent and observation are two things.** A request sets the gate's intent (`pause`); what the executor has actually reached (pausing, paused, stopping, recovery-required, unreachable ...)
 *   is reported with `observe` and stored beside it. A pause starts as `pausing`; `paused` is claimed only with a safe-boundary statement, and an uncooperative tool cannot support it.
 *   Elapsed time promotes nothing.
 * - **Scopes.** Gates exist per task, agent, team (and its parent teams) and installation. A task is blocked if any gate on its chain is paused: its own, its assignee's, the assignee's team chain, the installation's.
 *   Resuming one gate lifts that gate only and reports what still holds. A task-level pause blocks that task and nothing else, so a response or meeting task of the same agent is not blocked by it; an agent-level pause blocks every task of the agent.
 * - **No automatic return, except one the owner recorded.** Only `resume` lifts a gate, or `liftDue` when the owner recorded a time for it (`setResumeCondition`, card L06b). Time alone, a meeting ending, an incoming message or an applied configuration touch nothing.
 * - **Enforcement in the commit.** Callers get `guard(taskId)`: the blocking gates plus revision checks of every gate on the chain (absent gates are created active in the same commit), so a pause racing an admission is strictly before or after it.
 * - **Background results.** `recordBackground` records a finished background job for a task whether or not it is paused (unless the pause said `background: deny`), optionally answers the typed wait it resolves, and lifts no gate.
 */
export class PauseService implements PauseGuard, PauseLookup {
  readonly #runner: CommandRunner;
  readonly #waits: WaitService | undefined;
  readonly #other: PauseOptions["otherAvailability"];
  readonly #hooks: PauseOptions["testHooks"];

  private constructor(runner: CommandRunner, deps: { waits?: WaitService }, options: PauseOptions) {
    this.#runner = runner;
    this.#waits = deps.waits;
    this.#other = options.otherAvailability;
    this.#hooks = options.testHooks;
  }

  static withEpoch(storage: ConstructorParameters<typeof CommandRunner>[0], epoch: number, deps: { waits?: WaitService } = {}, options: PauseOptions = {}): PauseService {
    return new PauseService(new CommandRunner(storage, epoch, options), deps, options);
  }

  static gateIdOf(scope: PauseScope): string { return gateIdOf(checkScope(scope)); }
  static requestIdOf(gateId: string, seq: number): string { return requestIdOf(gateId, seq); }

  // ---- requests ---------------------------------------------------------------------------------------------------------------

  /**
   * Pauses the scope: ordinary foreground ingress closes from this commit on (everything that consults `guard` refuses). The gate keeps who paused it, and the request records actor, scope, mode, operation ID and policy revision.
   * Pausing does not touch the assignment, the task or what the executor is doing; `observe` reports that. Asking again while paused is refused.
   */
  async pause(principal: Principal, command: PauseRequest): Promise<{ gateId: string; requestId: string; replayed: boolean }> {
    onlyKnown(command, ["commandId", "scope", "reason", "background"]);
    const scope = checkScope(command.scope);
    const reason = plain(command.reason, "reason", PAUSE_LIMITS.reason);
    if (command.background !== undefined && command.background !== "permit" && command.background !== "deny") invalid("background", "must be permit or deny");
    const background: BackgroundPolicy = command.background ?? "permit";
    const target = await this.#authorize(principal, scope, "control", true);
    return this.#request(principal, command.commandId, "pause", scope, reason, background, target.projectId);
  }

  /**
   * Lifts this scope's gate and no other: the answer lists the gates that still hold the scope's tasks (a task paused in its own right stays paused when its agent is resumed, and the reverse). Resuming changes only the gate; it does not restart anything.
   */
  async resume(principal: Principal, command: ResumeRequest): Promise<{ gateId: string; requestId: string; stillPausedBy: readonly PauseScope[]; replayed: boolean }> {
    onlyKnown(command, ["commandId", "scope", "reason"]);
    const scope = checkScope(command.scope);
    const reason = plain(command.reason, "reason", PAUSE_LIMITS.reason);
    const target = await this.#authorize(principal, scope, "control", false);
    const done = await this.#request(principal, command.commandId, "resume", scope, reason, undefined, target.projectId);
    const stillPausedBy: PauseScope[] = [];
    for (const parent of (await this.#chain(scope)).slice(1)) if (await this.#paused(parent)) stillPausedBy.push(parent);
    return { ...done, stillPausedBy };
  }

  /**
   * Records, ahead of time, the condition on which a pause is lifted without anyone being asked again (card L06b). Only the owner can; it names one scope and one time, and the gate must be paused now.
   * It belongs to this pause: resuming or pausing again drops it. Setting it again replaces it. Nothing lifts a pause that has no recorded condition.
   */
  async setResumeCondition(principal: Principal, command: ResumeConditionRequest): Promise<{ gateId: string; replayed: boolean }> {
    onlyKnown(command, ["commandId", "scope", "at"]);
    if (principal.kind !== "owner") throw new DomainError("forbidden", `${principal.id} is not the owner; only the owner records a condition that lifts a pause`);
    const scope = checkScope(command.scope);
    const parsed = typeof command.at === "string" ? Date.parse(command.at) : Number.NaN;
    if (!Number.isFinite(parsed) || !/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$/.test(command.at)) invalid("at", "must be a time with its zone, in UTC such as 2026-11-01T08:00:00Z");
    const at = new Date(parsed).toISOString();
    await this.#authorize(principal, scope, "control", false);
    const gateId = gateIdOf(scope);
    const scoped = scopedCommandId(principal.id, command.commandId);
    const result = await this.#retrying(() => this.#runner.command("pause.condition", { commandId: scoped, actor: principal.id }, async () => ({
      payload: { scope: scope as unknown as JsonObject, at },
      build: async () => {
        const ref: AggregateRef = { kind: "pause-gate", id: gateId };
        const found = await this.#runner.get(ref.kind, ref.id);
        const gate = found === undefined ? undefined : (found.body as unknown as PauseGateBody);
        if (found === undefined || gate === undefined || gate.intent !== "pause") throw new DomainError("invalid_command", `${scope.kind} ${scope.id} is not paused; a condition is recorded for a pause that is in force`, { field: "scope" });
        const next: PauseGateBody = { ...gate, resumeAt: { at, setBy: principal.id, setAt: this.#runner.now() } };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: clean(next) }], detail: { scope: scope as unknown as JsonObject, resumeAt: at } };
      },
    })));
    return { gateId, replayed: result.replayed };
  }

  /**
   * The controller's tick: lifts every pause whose recorded condition has come, and only that scope, with the reason naming the condition. A gate with no recorded condition is never touched, and a repeat of the tick
   * (or a restart) lifts nothing twice. The caller is the dispatcher (owner, host or service). Answers the scopes it lifted.
   */
  /**
   * A Stop, a Suspend or a hand-off takes the pause over: the time the owner recorded for an ordinary pause no longer applies to it, so it is dropped (card L06b). The caller is the one controlling the scope.
   * Safe to repeat; a gate with no recorded condition is not touched.
   */
  async dropResumeCondition(principal: Principal, scope: PauseScope): Promise<void> {
    const checked = checkScope(scope);
    await this.#authorize(principal, checked, "control", false);
    const gateId = gateIdOf(checked);
    await this.#retrying(async () => {
      const ref: AggregateRef = { kind: "pause-gate", id: gateId };
      const found = await this.#runner.get(ref.kind, ref.id);
      if (found === undefined || (found.body as unknown as PauseGateBody).resumeAt === undefined) return;
      const { resumeAt: _dropped, ...rest } = found.body as unknown as PauseGateBody; void _dropped;
      await this.#runner.command("pause.condition-drop", { commandId: `drop-cond-${gateId}-${found.revision}`, actor: principal.id }, async () => ({
        payload: { scope: checked as unknown as JsonObject },
        build: async () => ({ ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: clean(rest) }], detail: { scope: checked as unknown as JsonObject, resumeAt: null } }),
      }));
    });
  }

  async liftDue(by: Principal): Promise<PauseScope[]> {
    if (!(by.kind === "owner" || by.kind === "host" || by.kind === "service")) throw new DomainError("forbidden", `${by.id} is not the dispatcher; recorded conditions are carried out by the controller`);
    const lifted: PauseScope[] = [];
    let failure: unknown;
    const now = Date.parse(this.#runner.now());
    let after: string | undefined;
    for (;;) {
      const page = await this.#runner.list("pause-gate", { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const a of page) {
        after = a.id;
        const gate = a.body as unknown as PauseGateBody;
        if (gate.intent !== "pause" || gate.resumeAt === undefined || Date.parse(gate.resumeAt.at) > now) continue;
        // A pause that has gone on to be suspended or stopped is not an ordinary pause any more.
        if (gate.observed !== undefined && ["preparing-to-suspend", "suspended", "stopping", "stopped", "recovery-required"].includes(gate.observed.state)) continue;
        try {
          await this.#request(by, `cond-${gate.requestId ?? a.id}`, "resume", gate.scope, `the owner's recorded condition (set by ${gate.resumeAt.setBy} at ${gate.resumeAt.setAt}): not before ${gate.resumeAt.at}`, undefined, gate.projectId, { requestId: gate.requestId, at: gate.resumeAt.at, now });
          lifted.push(gate.scope);
        } catch (error) {
          // A gate resumed, paused again or given another time since it was read is no longer this condition's to lift. One gate that cannot be lifted does not hold up the others.
          if (error instanceof DomainError && error.code === "invalid_command") continue;
          failure ??= error;
        }
      }
      if (page.length < 200) { if (failure !== undefined) throw failure; return lifted; }
    }
  }

  async #request(principal: Principal, commandId: unknown, action: "pause" | "resume", scope: PauseScope, reason: string, background: BackgroundPolicy | undefined, projectId: string | undefined, onlyIf?: { requestId: string | undefined; at: string; now: number }) {
    const scoped = scopedCommandId(principal.id, commandId);
    const gateId = gateIdOf(scope);
    const result = await this.#retrying(() => this.#runner.command(`pause.${action}`, { commandId: scoped, actor: principal.id }, async () => ({
      payload: { scope: scope as unknown as JsonObject, reason, ...(background === undefined ? {} : { background }) },
      build: async () => {
        const ref: AggregateRef = { kind: "pause-gate", id: gateId };
        const found = await this.#runner.get(ref.kind, ref.id);
        const gate = found === undefined ? this.#fresh(scope, projectId) : (found.body as unknown as PauseGateBody);
        if (action === "pause" && gate.intent === "pause") throw new DomainError("invalid_command", `${scope.kind} ${scope.id} is already paused`, { field: "scope" });
        if (action === "resume" && gate.intent !== "pause") throw new DomainError("invalid_command", `${scope.kind} ${scope.id} is not paused`, { field: "scope" });
        // A lift by recorded condition applies only to the very pause and time it was read with.
        if (onlyIf !== undefined && (gate.requestId !== onlyIf.requestId || gate.resumeAt?.at !== onlyIf.at || Date.parse(onlyIf.at) > onlyIf.now)) throw new DomainError("invalid_command", `${scope.kind} ${scope.id} no longer has that condition`, { field: "scope" });
        const at = this.#runner.now();
        const seq = gate.requests + 1;
        const requestId = requestIdOf(gateId, seq);
        const policy = await this.#policyRevision(projectId);
        const request: PauseRequestBody = { gateId, seq, scope, action, mode: "pause", actor: principal.id, operationId: String(commandId), policyRevision: policy, reason, ...(background === undefined ? {} : { background }), at };
        const base = { scope: gate.scope, ...(gate.projectId === undefined ? {} : { projectId: gate.projectId }), background: gate.background, requests: seq, requestId };
        const next: PauseGateBody = action === "pause"
          ? { ...base, background: background!, intent: "pause", mode: "pause", owner: principal.id, pausedAt: at, reason, observed: { state: "pausing", at, by: principal.id, evidence: "requested: ordinary foreground ingress is closed; the safe boundary has not been reported" } }
          : { ...base, intent: "active" };
        const requestRef: AggregateRef = { kind: "pause-request", id: requestId };
        return {
          ref: requestRef, creates: true,
          changes: [{ type: "create", ref: requestRef, body: clean(request) }, found === undefined ? { type: "create", ref, body: clean(next) } : { type: "update", ref, expectedRevision: found.revision, body: clean(next) }],
          detail: { scope: scope as unknown as JsonObject, action, mode: "pause", seq, operationId: String(commandId), policyRevision: policy as unknown as JsonObject },
        };
      },
    })));
    return { gateId, requestId: result.id, replayed: result.replayed };
  }

  /**
   * Records what the executor actually reached for a paused scope. `paused` needs a safe-boundary statement (`finished`, or `cancelled_recorded` when the step was cut and its effect status recorded) and is refused for an
   * `uncooperative` tool, and for a task whose latest generation is still streaming; the honest state then is `pausing` (or `recovery-required` / `unreachable`). Time alone never moves the state on.
   * The caller is whoever may control the scope, the owner, or (for an agent or its task) the agent's own runtime.
   */
  async observe(principal: Principal, command: ObserveRequest): Promise<{ state: ObservedState; replayed: boolean }> {
    onlyKnown(command, ["commandId", "scope", "state", "boundary", "evidence"]);
    const scope = checkScope(command.scope);
    if (typeof command.state !== "string" || !(OBSERVED_STATES as readonly string[]).includes(command.state)) invalid("state", `must be one of ${OBSERVED_STATES.join(", ")}`);
    if (command.boundary !== undefined && !(BOUNDARIES as readonly string[]).includes(command.boundary)) invalid("boundary", `must be one of ${BOUNDARIES.join(", ")}`);
    const evidence = command.evidence === undefined ? undefined : plain(command.evidence, "evidence", PAUSE_LIMITS.evidence);
    const state = command.state;
    if (state === "paused") {
      if (command.boundary === undefined) invalid("boundary", "paused is claimed only with a safe-boundary statement (finished or cancelled_recorded)");
      if (command.boundary === "uncooperative") invalid("boundary", "an uncooperative foreground tool supports pausing or recovery-required, not paused");
    }
    await this.#authorize(principal, scope, "observe", false);
    const scoped = scopedCommandId(principal.id, command.commandId);
    const result = await this.#retrying(() => this.#runner.command("pause.observe", { commandId: scoped, actor: principal.id }, async () => ({
      payload: { scope: scope as unknown as JsonObject, state, ...(command.boundary === undefined ? {} : { boundary: command.boundary }), ...(evidence === undefined ? {} : { evidence }) },
      build: async () => {
        const ref: AggregateRef = { kind: "pause-gate", id: gateIdOf(scope) };
        const found = await this.#runner.get(ref.kind, ref.id);
        const gate = found?.body as unknown as PauseGateBody | undefined;
        if (found === undefined || gate === undefined || gate.intent !== "pause") throw new DomainError("invalid_command", `${scope.kind} ${scope.id} is not paused; there is nothing to observe`, { field: "scope" });
        if (state === "paused" && scope.kind === "task" && (await this.#streaming(scope.id))) throw new DomainError("invalid_command", `task ${scope.id} still has a generation streaming; it is pausing, not paused`, { field: "state" });
        const observed: Observation = { state, at: this.#runner.now(), by: principal.id, ...(command.boundary === undefined ? {} : { boundary: command.boundary }), ...(evidence === undefined ? {} : { evidence }) };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: clean({ ...gate, observed }) }], detail: { scope: scope as unknown as JsonObject, state, ...(command.boundary === undefined ? {} : { boundary: command.boundary }) } };
      },
    })));
    return { state, replayed: result.replayed };
  }

  /** Whether the task's latest generation (L05) is still streaming. Read straight from its records so this package does not depend on that one. */
  async #streaming(taskId: string): Promise<boolean> {
    const gate = (await this.#runner.get("generation-gate", `ggate-${taskId.slice(5)}`))?.body as unknown as { current?: number } | undefined;
    if (gate?.current === undefined) return false;
    const run = (await this.#runner.get("generation-run", `grun-${taskId.slice(5)}-${pad(gate.current)}`))?.body as unknown as { state?: string } | undefined;
    return run?.state === "streaming";
  }

  // ---- background settlement ---------------------------------------------------------------------------------------------------

  /**
   * Records the result of a permitted background job for a task, paused or not, and optionally answers the typed wait it resolves (S08). It never lifts a gate: the task may become ready while still paused, and stays
   * unstartable until its gates are resumed. Refused if a paused gate on the task's chain said `background: deny`. Allowed to the owner, a holder of `assignment.manage`, or the assigned agent. Answering a wait needs more: the caller must be the wait's resolver (or the owner).
   */
  async recordBackground(principal: Principal, command: BackgroundRequest): Promise<{ id: string; pausedBy: readonly PauseScope[]; answeredWaitId?: string; replayed: boolean }> {
    return this.#recordBackground(principal, command, false);
  }

  /**
   * The same record for a job the job service has already authorized the caller to record (the right `job.write` on that task): the caller needs no `assignment.manage` and need not be the assignee, so a worker's
   * finish is never lost for want of a right it should not hold. It cannot answer a wait. Only the job service calls it (card T07).
   */
  async recordFinishedJob(principal: Principal, command: Omit<BackgroundRequest, "answerWait">): Promise<{ id: string; pausedBy: readonly PauseScope[]; replayed: boolean }> {
    if ((command as BackgroundRequest).answerWait !== undefined) invalid("answerWait", "a finished job does not answer a wait");
    // The trusted path checks itself: the reference must be a background job of this task that has ended.
    const job = (await this.#runner.get("job", command.jobRef))?.body as unknown as { taskId?: string; background?: boolean; state?: string } | undefined;
    if (job === undefined || job.taskId !== command.taskId || job.background !== true || !["completed", "failed", "cancelled"].includes(job.state ?? "")) throw new DomainError("forbidden", "that is not a finished background job of this task");
    const { answeredWaitId: _a, ...done } = await this.#recordBackground(principal, command, true);
    return done;
  }

  async #recordBackground(principal: Principal, command: BackgroundRequest, trusted: boolean): Promise<{ id: string; pausedBy: readonly PauseScope[]; answeredWaitId?: string; replayed: boolean }> {
    onlyKnown(command, ["commandId", "taskId", "jobRef", "outcome", "summary", "answerWait"]);
    const taskId = checkTaskId(command.taskId);
    const jobRef = plain(command.jobRef, "jobRef", PAUSE_LIMITS.jobRef);
    if (command.outcome !== "succeeded" && command.outcome !== "failed" && command.outcome !== "cancelled") invalid("outcome", "must be succeeded, failed or cancelled");
    const summary = plain(command.summary, "summary", PAUSE_LIMITS.summary);
    let answer: { waitId: string; expectedRevision: number; resolverId: string; answer: string } | undefined;
    let given: { waitId: string; expectedRevision: number; answer: string } | undefined;
    if (command.answerWait !== undefined) {
      const a = command.answerWait as unknown;
      if (a === null || typeof a !== "object" || Array.isArray(a)) invalid("answerWait", "must be an object");
      onlyKnown(a as object, ["waitId", "expectedRevision", "answer"]);
      const w = a as { waitId?: unknown; expectedRevision?: unknown; answer?: unknown };
      if (typeof w.waitId !== "string" || typeof w.expectedRevision !== "number") invalid("answerWait", "needs waitId, expectedRevision and answer");
      given = { waitId: w.waitId as string, expectedRevision: w.expectedRevision as number, answer: plain(w.answer, "answerWait.answer", PAUSE_LIMITS.summary) };
      if (this.#waits === undefined) invalid("answerWait", "cannot be answered: this service has no wait service");
    }
    const task = trusted ? await this.#taskBody(taskId) : await this.#backgroundTask(principal, taskId);
    if (given !== undefined) {
      const wait = await this.#waits!.getWait(given.waitId);
      if (wait === undefined || wait.taskId !== taskId) return invalid("answerWait.waitId", "is not a wait of this task");
      // Only the wait's named resolver answers it (the owner may, on its behalf); holding the right to record a result is not that.
      if (principal.kind !== "owner" && principal.id !== wait.resolver) throw new DomainError("forbidden", `${principal.id} is not the resolver of that wait`);
      answer = { ...given, resolverId: wait.resolver };
    }
    const scoped = scopedCommandId(principal.id, command.commandId);
    const id = derivedId("pbg", scoped);
    let pausedBy: PauseScope[] = [];
    const result = await this.#retrying(() => this.#runner.command("pause.background", { commandId: scoped, actor: principal.id }, async () => ({
      payload: { taskId, jobRef, outcome: command.outcome, summary, ...(answer === undefined ? {} : { answerWait: answer.waitId }) },
      build: async () => {
        const g = await this.#gates(taskId);
        await this.#hooks?.afterBackgroundRead?.();
        pausedBy = [];
        for (const e of g.entries) {
          if (e.body.intent !== "pause") continue;
          if (e.body.background === "deny") throw new DomainError("invalid_command", `${e.scope.kind} ${e.scope.id} is paused with background work denied; no result is recorded until it is resumed`, { field: "taskId" });
          pausedBy.push(e.scope);
        }
        // Every gate on the chain (absent ones created active) and the chain itself are checked in the commit, so a pause that denies background work lands strictly before or after.
        const changes = g.changes;
        const body: BackgroundResultBody = { taskId, projectId: task.projectId, jobRef, outcome: command.outcome, summary, recordedBy: principal.id, at: this.#runner.now(), pausedBy, ...(answer === undefined ? {} : { answeredWaitId: answer.waitId }) };
        const ref: AggregateRef = { kind: "pause-background", id };
        return { ref, creates: true, changes: [{ type: "create", ref, body: clean(body) }, ...changes], detail: { taskId, jobRef, outcome: command.outcome, pausedBy: pausedBy as unknown as JsonObject[] } };
      },
    })));
    if (result.replayed) pausedBy = [...(((await this.#runner.get("pause-background", id))?.body as unknown as BackgroundResultBody | undefined)?.pausedBy ?? [])];
    if (answer !== undefined) {
      // A separate, idempotent command derived from the record: a crash between the two is repaired by repeating this call.
      await this.#waits!.answerWait({ commandId: `bg-answer:${id}`, actor: principal.id, waitId: answer.waitId, expectedRevision: answer.expectedRevision, resolverId: answer.resolverId, answer: answer.answer });
    }
    return { id, pausedBy, ...(answer === undefined ? {} : { answeredWaitId: answer.waitId }), replayed: result.replayed };
  }

  async background(viewer: Principal, id: string): Promise<View<BackgroundResultBody> | undefined> {
    const found = typeof id === "string" && /^pbg-[a-z2-7]{20}$/.test(id) ? await this.#runner.get("pause-background", id) : undefined;
    if (found === undefined) return undefined;
    const body = found.body as unknown as BackgroundResultBody;
    return (await this.#mayReadTask(viewer, body.taskId)) ? view<BackgroundResultBody>(found) : undefined;
  }

  // ---- enforcement --------------------------------------------------------------------------------------------------------------

  async guard(taskId: string): Promise<{ readonly blockedBy: readonly PauseScope[]; readonly changes: readonly Change[] }> {
    const g = await this.#gates(checkTaskId(taskId));
    return { blockedBy: g.entries.filter((e) => e.body.intent === "pause").map((e) => e.scope), changes: g.changes };
  }

  /** Whether a paused gate on the task's chain said `background: deny`: no background job is admitted for it and none records a result (card T07). */
  async backgroundDenied(taskId: string): Promise<boolean> {
    return (await this.#gates(checkTaskId(taskId))).entries.some((e) => e.body.intent === "pause" && e.body.background === "deny");
  }

  /** Every gate on the task's chain (absent ones as they would be created, active), with the changes that lock the chain and the gates for the caller's commit. */
  async #gates(id: string): Promise<{ entries: { scope: PauseScope; body: PauseGateBody }[]; changes: Change[] }> {
    const task = (await this.#runner.get("task", id))?.body as unknown as TaskBody | undefined;
    const changes: Change[] = [];
    const entries: { scope: PauseScope; body: PauseGateBody }[] = [];
    for (const scope of await this.#applicable(id, changes)) {
      const ref: AggregateRef = { kind: "pause-gate", id: gateIdOf(scope) };
      const found = await this.#runner.get(ref.kind, ref.id);
      if (found === undefined) {
        const body = this.#fresh(scope, scope.kind === "task" ? task?.projectId : undefined);
        changes.push({ type: "create", ref, body: clean(body) });
        entries.push({ scope, body });
        continue;
      }
      changes.push({ type: "check", ref, expectedRevision: found.revision });
      entries.push({ scope, body: found.body as unknown as PauseGateBody });
    }
    return { entries, changes };
  }

  /** The `beforeStart` hook for `EffectService.run`: refuses to start an effect of a paused task, and the gates it read commit with the claim. */
  guardFor(taskId: string): () => Promise<readonly Change[]> {
    const id = checkTaskId(taskId);
    return async () => {
      const g = await this.guard(id);
      if (g.blockedBy.length > 0) throw new PauseRefused(id, g.blockedBy);
      return g.changes;
    };
  }

  /** The pause gates (agent, then its teams, then the installation) that hold an agent now, with who paused each and when, for the attendance service's decision about a direct invitation. */
  async agentHolds(agentId: string): Promise<readonly { scope: PauseScope; requestId: string; pausedAt: string }[]> {
    if (typeof agentId !== "string" || !AGENT_ID.test(agentId)) invalid("agentId", "is not an agent ID");
    const out: { scope: PauseScope; requestId: string; pausedAt: string }[] = [];
    for (const scope of await this.#chain({ kind: "agent", id: agentId })) {
      const gate = ((await this.#runner.get("pause-gate", gateIdOf(scope)))?.body as unknown as PauseGateBody | undefined);
      if (gate !== undefined && gate.intent === "pause" && gate.requestId !== undefined) out.push({ scope, requestId: gate.requestId, pausedAt: gate.pausedAt ?? "" });
    }
    return out;
  }

  async isPaused(taskId: string): Promise<boolean> {
    const id = checkTaskId(taskId);
    for (const scope of await this.#applicable(id)) if (await this.#paused(scope)) return true;
    return false;
  }

  /**
   * The conversation availability hook (T05): `paused` when the agent's own gate, its team chain's or the installation's is paused, so its messages are queued; otherwise whatever `otherAvailability` says (suspended and stopped, from L02/L03), else `available`.
   * A task-level pause does not make the agent unavailable: it can still answer. Nothing in the conversation service writes a gate, so a message arriving never lifts a pause.
   */
  availability = async (principalId: string): Promise<Availability> => {
    const m = /^agent:(agt-[a-z2-7]{20})$/.exec(typeof principalId === "string" ? principalId : "");
    if (m !== null) for (const scope of await this.#chain({ kind: "agent", id: m[1]! })) if (await this.#paused(scope)) return "paused";
    return this.#other === undefined ? "available" : this.#other(principalId);
  };

  /**
   * A paused agent keeps its tasks: an idle replacement, an urgent deadline or elapsed time are not reasons to take a paused task away. Anything that would reassign work on one of those grounds calls this first and is refused while any gate on the task's chain is paused.
   * Only an explicit release or an authorized emergency recovery (L03) can move paused work, and they are decided by their own authority, not here.
   */
  async assertRetained(taskId: string, trigger: ReplaceTrigger): Promise<void> {
    if (!(REPLACE_TRIGGERS as readonly string[]).includes(trigger)) invalid("trigger", `must be one of ${REPLACE_TRIGGERS.join(", ")}`);
    const g = await this.guard(taskId);
    if (g.blockedBy.length > 0) throw new DomainError("invalid_command", `task ${taskId} is paused (${g.blockedBy.map((s) => `${s.kind} ${s.id}`).join(", ")}); its assignment is kept despite ${trigger.replaceAll("_", " ")}`, { field: "trigger" });
  }

  // ---- reads --------------------------------------------------------------------------------------------------------------------

  async gate(viewer: Principal, scope: PauseScope): Promise<View<PauseGateBody> | undefined> {
    const s = checkScope(scope);
    if (!(await this.#may(viewer, s, "read"))) return undefined;
    const found = await this.#runner.get("pause-gate", gateIdOf(s));
    return found === undefined ? undefined : view<PauseGateBody>(found);
  }

  /** The paused gates that apply to a task, nearest first. A task the caller may not read reads like a missing one. */
  async status(viewer: Principal, taskId: string): Promise<PauseStatus | undefined> {
    const id = checkTaskId(taskId);
    if (!(await this.#mayReadTask(viewer, id))) return undefined;
    const gates: GateStatus[] = [];
    for (const scope of await this.#applicable(id)) {
      const found = await this.#runner.get("pause-gate", gateIdOf(scope));
      if (found !== undefined && (found.body as unknown as PauseGateBody).intent === "pause") gates.push({ scope, gate: view<PauseGateBody>(found) });
    }
    return { taskId: id, paused: gates.length > 0, gates };
  }

  /** The requests made of a scope, oldest first, from request number `afterSeq` + 1. */
  async requests(viewer: Principal, scope: PauseScope, page: { afterSeq?: number; limit?: number } = {}): Promise<View<PauseRequestBody>[]> {
    const s = checkScope(scope);
    if (!(await this.#may(viewer, s, "read"))) return [];
    const gateId = gateIdOf(s);
    const gate = (await this.#runner.get("pause-gate", gateId))?.body as unknown as PauseGateBody | undefined;
    const out: View<PauseRequestBody>[] = [];
    const limit = Math.min(Math.max(page.limit ?? 50, 1), 200);
    for (let seq = (page.afterSeq ?? 0) + 1; gate !== undefined && seq <= gate.requests && out.length < limit; seq++) {
      const found = await this.#runner.get("pause-request", requestIdOf(gateId, seq));
      if (found !== undefined) out.push(view<PauseRequestBody>(found));
    }
    return out;
  }

  // ---- internals ----------------------------------------------------------------------------------------------------------------

  #fresh(scope: PauseScope, projectId: string | undefined): PauseGateBody {
    return { scope, ...(projectId === undefined ? {} : { projectId }), intent: "active", background: "permit", requests: 0 };
  }

  async #paused(scope: PauseScope): Promise<boolean> {
    return ((await this.#runner.get("pause-gate", gateIdOf(scope)))?.body as unknown as PauseGateBody | undefined)?.intent === "pause";
  }

  /**
   * The scope and every scope above it, nearest first, ending with the installation. A task's agent is its assignee; teams follow the parent chain (cycles and over-long chains stop the walk).
   * With `locks`, a revision check of every record the walk relied on (the assignment, the agent, each team) is added, so a reassignment or a move between teams racing the caller's commit makes it fail and be decided again.
   */
  async #chain(scope: PauseScope, locks?: Change[]): Promise<PauseScope[]> {
    const installation: PauseScope = { kind: "installation", id: "installation" };
    const read = async (kind: string, id: string) => {
      const found = await this.#runner.get(kind, id);
      if (found !== undefined) locks?.push({ type: "check", ref: { kind, id }, expectedRevision: found.revision });
      return found?.body;
    };
    if (scope.kind === "installation") return [scope];
    if (scope.kind === "task") {
      const asg = (await read("assignment", assignmentIdOf(scope.id))) as unknown as AssignmentBody | undefined;
      // A meeting task the owner allowed to attend while its agent is paused is governed by its own gate only (the record is locked with the chain, so ending the permission races safely).
      const exemption = (await read(PAUSE_EXEMPTION_KIND, exemptionIdOf(scope.id))) as unknown as PauseExemptionBody | undefined;
      if (exemption !== undefined && exemption.state === "active" && Date.parse(this.#runner.now()) < Date.parse(exemption.expiresAt) && asg?.state === "assigned" && asg.owner?.kind === "agent" && asg.owner.id === exemption.agentId) {
        const rest: PauseScope[] = [scope];
        for (const s of await this.#chain({ kind: "agent", id: exemption.agentId }, locks)) {
          const found = s.kind === "installation" ? undefined : await this.#runner.get("pause-gate", gateIdOf(s));
          const gate = found?.body as unknown as PauseGateBody | undefined;
          const covered = gate !== undefined && gate.intent === "pause" && exemption.covers.some((c) => c.kind === s.kind && c.id === s.id && c.requestId === gate.requestId);
          // A gate left out is locked here (a pause landing meanwhile fails the caller's commit); a gate kept is locked by the caller with the rest of the chain.
          if (covered) locks?.push({ type: "check", ref: { kind: "pause-gate", id: found!.id }, expectedRevision: found!.revision }); else rest.push(s);
        }
        return rest;
      }
      return [scope, ...(asg?.state === "assigned" && asg.owner?.kind === "agent" ? await this.#chain({ kind: "agent", id: asg.owner.id }, locks) : [installation])];
    }
    const parent = scope.kind === "agent"
      ? ((await read("agent", scope.id)) as unknown as AgentBody | undefined)?.teamId
      : ((await read("team", scope.id)) as unknown as TeamBody | undefined)?.parentTeamId;
    const out: PauseScope[] = [scope];
    for (let at = parent; at !== undefined && out.length <= PAUSE_LIMITS.chain && !out.some((s) => s.id === at);) {
      out.push({ kind: "team", id: at });
      at = ((await read("team", at)) as unknown as TeamBody | undefined)?.parentTeamId;
    }
    return [...out, installation];
  }

  #applicable(taskId: string, locks?: Change[]): Promise<PauseScope[]> { return this.#chain({ kind: "task", id: taskId }, locks); }

  async #policyRevision(projectId: string | undefined): Promise<{ installation: number; project?: number }> {
    const inst = await this.#runner.get("approval-policy", "installation");
    const proj = projectId === undefined ? undefined : await this.#runner.get("approval-policy", projectId);
    return { installation: inst?.revision ?? 0, ...(proj === undefined ? {} : { project: proj.revision }) };
  }

  async #taskBody(taskId: string): Promise<TaskBody> {
    const found = (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined;
    if (found === undefined) throw new DomainError("not_found", `task ${taskId} does not exist`);
    return found;
  }

  async #backgroundTask(principal: Principal, taskId: string): Promise<TaskBody> {
    const found = (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined;
    const resource = { resource: { kind: "task", id: taskId } } as const;
    let ok = found !== undefined && inTaskScope(principal, found.projectId) && allows(principal, "assignment.manage", found.projectId, resource);
    if (!ok && found !== undefined) ok = await this.#isAssignee(principal, taskId);
    // A task the caller may not act on reads exactly like one that does not exist.
    if (found === undefined || !ok) throw new DomainError("forbidden", `${principal.id} may not do that on that task`);
    return found;
  }

  async #isAssignee(principal: Principal, taskId: string): Promise<boolean> {
    if (principal.taskScope !== undefined) return false;
    const asg = (await this.#runner.get("assignment", assignmentIdOf(taskId)))?.body as unknown as AssignmentBody | undefined;
    return asg?.state === "assigned" && asg.owner?.kind === "agent" && principal.id === `agent:${asg.owner.id}`;
  }

  async #mayReadTask(viewer: Principal, taskId: string): Promise<boolean> {
    const task = (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined;
    if (task === undefined) return false;
    return (await this.#may(viewer, { kind: "task", id: taskId }, "read"));
  }

  async #may(p: Principal, scope: PauseScope, level: "control" | "read" | "observe"): Promise<boolean> {
    if (p.kind === "owner") return true;
    if (scope.kind === "task") {
      const task = (await this.#runner.get("task", scope.id))?.body as unknown as TaskBody | undefined;
      if (task === undefined || !inTaskScope(p, task.projectId)) return false;
      const resource = { resource: { kind: "task", id: scope.id } } as const;
      if (allows(p, "assignment.manage", task.projectId, resource)) return true;
      if (level === "read" && allows(p, "assignment.read", task.projectId, resource)) return true;
      return level !== "control" && (await this.#isAssignee(p, scope.id));
    }
    // The installation gate stops everything: only the owner controls or reports on it; managers of agents may read it.
    if (scope.kind !== "installation" && allows(p, "agent.manage", undefined)) return true;
    if (level === "read" && scope.kind === "installation" && allows(p, "agent.manage", undefined)) return true;
    if (level === "read" && allows(p, "agent.read", undefined)) return true;
    return level !== "control" && scope.kind === "agent" && p.taskScope === undefined && p.id === `agent:${scope.id}`;
  }

  /** Whether the principal may control the scope (pause, suspend, stop it), and that the scope exists: the same check Pause uses (card L02). */
  async authorizeControl(principal: Principal, scope: PauseScope): Promise<{ projectId?: string }> {
    return this.#authorize(principal, checkScope(scope), "control", false);
  }

  /** Checks authority first (an unauthorized caller learns nothing about the target), then that the target exists. */
  async #authorize(principal: Principal, scope: PauseScope, level: "control" | "observe", mustBeActive: boolean): Promise<{ projectId?: string }> {
    if (!(await this.#may(principal, scope, level))) throw new DomainError("forbidden", `${principal.id} may not ${level === "control" ? "pause or resume" : "report on"} that ${scope.kind}`);
    if (scope.kind === "task") {
      const task = (await this.#runner.get("task", scope.id))?.body as unknown as TaskBody | undefined;
      if (task === undefined) throw new DomainError("not_found", `task ${scope.id} does not exist`);
      if (mustBeActive && (task.state === "done" || task.state === "cancelled")) throw new DomainError("invalid_command", `task ${scope.id} is ${task.state}`, { field: "scope" });
      return { projectId: task.projectId };
    }
    if (scope.kind === "agent" && (await this.#runner.get("agent", scope.id)) === undefined) throw new DomainError("not_found", `agent ${scope.id} does not exist`);
    if (scope.kind === "team" && (await this.#runner.get("team", scope.id)) === undefined) throw new DomainError("not_found", `team ${scope.id} does not exist`);
    return {};
  }

  /** Concurrent writers to one gate meet a revision check; the loser reads again and decides again (a command applies once whatever happens). */
  async #retrying<T>(run: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try { return await run(); } catch (error) {
        if (!(error instanceof DomainError) || (error.code !== "stale_revision" && error.code !== "command_conflict") || error.field !== undefined || attempt >= 8) throw error;
      }
    }
  }
}

/** The reason an effect start was refused because of a pause. A `DomainError` (`invalid_command`) with the field `pause`. */
export class PauseRefused extends DomainError {
  constructor(readonly taskId: string, readonly blockedBy: readonly PauseScope[]) {
    super("invalid_command", `task ${taskId} is paused (${blockedBy.map((s) => `${s.kind} ${s.id}`).join(", ")}); no new work starts until it is resumed`, { field: "pause" });
    this.name = "PauseRefused";
  }
}
