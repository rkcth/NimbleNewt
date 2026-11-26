import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { assignmentIdOf } from "../domain/assignment-model.js";
import { projectId as checkProjectId, taskId as checkTaskId, type TaskBody } from "../domain/model.js";
import { CommandRunner, type Built, type RunnerOptions } from "../domain/runner.js";
import { text } from "../domain/model.js";
import { CHECKS, type Check } from "../policy/integration-policy.js";
import type { IncidentBody } from "../projects/incidents.js";
import { allows } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { Change, ControllerStorage, JsonObject } from "../storage/types.js";
import type { NewestCode, QaEvidenceBody, QaEvidenceService } from "./qa-evidence.js";

/**
 * The review policy of a project (card Q02): which tasks need independent QA, when a review starts by itself, which checks it must cover beyond the task contract's, whether passing independent review gates
 * completion (a landing then needs the `qa` and `review` checks for those tasks), and how many independent original sources each check needs. One record per project, set only by the owner.
 */
export interface QaReviewPolicyBody {
  readonly projectId: string;
  /** Which tasks the policy covers: tasks of these work classes (empty: every class) and, when given, only these tasks (empty: every task). A task must match both. */
  readonly scope: { readonly workClasses: readonly ("P" | "PC")[]; readonly taskIds: readonly string[] };
  /** When a review starts: on each new code submission, every `periodicMinutes` minutes, and when an incident is opened in the project. */
  readonly triggers: { readonly onSubmission: boolean; readonly periodicMinutes: number | null; readonly onIncident: boolean };
  /** Check names the QA gate requires in addition to the task contract's. */
  readonly requiredChecks: readonly string[];
  /** Whether a landing of a task in scope also needs the `qa` and `review` checks, whatever the project's landing settings require. */
  readonly gatesCompletion: boolean;
  /** How many independent original sources (a copy and its original are one; one recorder is one) each required check needs a pass from. */
  readonly independentSources: number;
  /**
   * How reviewers' verdicts on tasks in scope cite what they judged against (card Q02, `citationRuleOf`): `true`: every verdict names the task contract version (`criteriaRevision`), an approval every decision the task
   * relies on, a rejection the unmet owner requirement. `false`, when the owner chose it (`citationsSetAt`): citing is optional, a rejection need not name the unmet requirement. Otherwise (no policy, the field absent,
   * or a `false` stored before 2026-11-26, when it was only the default): the default, a rejection must name the unmet requirement, and every verdict records the criteria version it was judged against.
   */
  readonly requireVerdictCitations?: boolean;
  /** When the owner last set `requireVerdictCitations` (card Q02); absent: never chosen. */
  readonly citationsSetAt?: string;
  /** Read only (`get`): the citation rule in force for tasks in scope, as `citationRuleOf` reads the two fields above. */
  readonly citations?: CitationRule;
  /** When each trigger was last switched on: work before it is not reviewed backwards (a new policy does not start by reviewing the backlog). */
  readonly since: { readonly submission?: string; readonly periodic?: string; readonly incident?: string; readonly gate?: string };
  readonly updatedBy: string;
  readonly updatedAt: string;
}

export const QA_REVIEW_LIMITS = { taskIds: 50, requiredChecks: 20, checkName: 200, minPeriodMinutes: 15, maxPeriodMinutes: 43_200, sources: 5, policies: 200, projects: 500, episodes: 20, looksPerRound: 200, openPerProject: 100, perSweep: 25, tasksPerIncident: 25, incidents: 10, incidentPages: 100, incidentPageSize: 500, page: 20, sweepEveryMs: 60_000 } as const;

const KIND = "qa-review-policy";
const REQUEST = "qa-review-request";
const INDEX = "qa-review-index";
const SERVICE = "service:qa-review";
const hex = (...parts: string[]): string => createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24);
const bad = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const json = (v: object): JsonObject => JSON.parse(JSON.stringify(v)) as JsonObject;
/** What a project without a policy is: nothing reviews by itself, nothing is added, independent review does not gate completion. */
export const NO_POLICY = (projectId: string): Omit<QaReviewPolicyBody, "updatedBy" | "updatedAt"> => ({ projectId, scope: { workClasses: [], taskIds: [] }, triggers: { onSubmission: false, periodicMinutes: null, onIncident: false }, requiredChecks: [], gatesCompletion: false, independentSources: 1, since: {} });

/**
 * How verdicts cite (card Q02): `explicit` (every verdict names the criteria version it judged against), `rejections` (the default: a rejection names the unmet owner requirement; the criteria version in force is recorded
 * for any verdict that names none), `optional` (the owner made it optional: a rejection need not name the unmet requirement).
 */
export type CitationRule = "explicit" | "rejections" | "optional";
/** The rule a policy sets (for the tasks in its scope). A `false` the owner never chose (stored before 2026-11-26, when it was the default) is the default. Pure. */
export const citationRuleOf = (p: Pick<QaReviewPolicyBody, "requireVerdictCitations" | "citationsSetAt"> | undefined): CitationRule => (p?.requireVerdictCitations === true ? "explicit" : p?.requireVerdictCitations === false && p.citationsSetAt !== undefined ? "optional" : "rejections");

/** A review (or QA re-check) the scheduler owes: one independent look at one code submission, assigned to an agent that did not work on it. */
export interface QaReviewRequestBody {
  readonly projectId: string;
  readonly taskId: string;
  readonly submissionId: string;
  readonly tree: string;
  /**
   * `submission`: a new code submission; `periodic`: the interval ran out; `incident`: an incident was opened in the project; `gate`: independent review gates completion and the task's newest code has no
   * independent evidence from someone who did not work on it (card Q02 review: without it the landing is refused, so the review is asked for and the owner told when nobody can do it).
   * `reapproval` (card Q02, "invalidation schedules revalidation"): the code's approval no longer counts (a decision it relied on, its criteria or a recorded dependency changed since); asked of every project, policy or not.
   */
  readonly trigger: "submission" | "periodic" | "incident" | "gate" | "reapproval";
  /** The submission (for `submission`; for `gate` the submission and when gating was switched on), the period (`p<n>`), the incident that started it, or the approval that stopped counting (`reapproval`: its review ID and a digest of why, so each time it stops counting is asked once). */
  readonly cause: string;
  /** `reapproval` only: the review (or the code accepted without one) that stopped counting, why, in plain words, and who gave it. */
  readonly approval?: string;
  readonly reason?: string;
  readonly approvedBy?: string;
  /** Absent while no eligible agent exists (the owner is told once; each sweep looks again). */
  readonly assignee?: string;
  readonly state: "open" | "done" | "superseded";
  readonly createdAt: string;
  readonly assignedAt?: string;
  /** When the request last lost its assignee (nobody eligible): the owner is told again for each such stretch, not only the first. */
  readonly waitingSince?: string;
  /** When the assignee, or the owner when nobody is eligible, was told (the sweep retries until it is). */
  readonly noticeAt?: string;
  readonly ownerNoticeAt?: string;
  readonly settledAt?: string;
  /** The independent QA evidence that settled it (for `reapproval`: the newer review, or `restored` when the approval counts again), the newer code submission that replaced it, or `cancelled` when its task was cancelled. */
  readonly settledBy?: string;
}
interface IndexBody { readonly open: readonly string[] }

export interface QaReviewPorts {
  /** The agents that could review work by `workerId` in the project (`AgentService.reviewersAvailableIn`). Never the worker itself; the scheduler also leaves out everyone else who worked on the task. */
  readonly reviewers: (projectId: string, workerId: string) => Promise<readonly string[]>;
  /** Tells the assignee (a principal ID) or the owner (`owner`) about a request. Best effort and repeated until it succeeds; `commandId` is stable for one request and recipient. A contributor is never told. */
  readonly notice?: (n: { readonly commandId: string; readonly to: string; readonly projectId: string; readonly taskId: string; readonly requestId: string; readonly text: string }) => Promise<void>;
  /**
   * Card Q02: whether a code submission's approval stands (`SubmissionService.approvalOf`). With it, each round asks for a re-review of the newest code of every unfinished task of every active project whose approval no
   * longer counts (`outdated`), once per such approval, and settles that request when a newer review is recorded or the approval counts again. Absent: no re-review is asked for.
   */
  readonly approvalOf?: (submissionId: string) => Promise<{ readonly approved: boolean; readonly reviewId?: string; readonly outdated?: { readonly reviewId: string; readonly approvedBy: string; readonly because: string } } | undefined>;
  /** Card Q02: looks at a task's QA evidence against its recorded dependencies (`QaEvidenceService.dependenciesChanged`), for the newest code of each unfinished task each round. Best effort; absent: not looked at here. */
  readonly dependenciesChanged?: (taskId: string) => Promise<unknown>;
  /** How many tasks one round looks at for the two ports above (default `QA_REVIEW_LIMITS.looksPerRound`; tests set fewer). */
  readonly looksPerRound?: number;
}

export interface QaReviewSweepResult { readonly projects: number; readonly created: number; readonly assigned: number; readonly settled: number; readonly superseded: number; readonly unassigned: number; readonly errors: number }

/** The project's required landing checks with the ones its review policy adds for the task, in the order the checks are listed everywhere (a repeat is dropped). Pure. */
export const withPolicyChecks = (base: readonly Check[], extra: readonly Check[]): readonly Check[] => (extra.length === 0 ? base : CHECKS.filter((c) => base.includes(c) || extra.includes(c)));

const principalOf = (id: string): string => (id.startsWith("agent:") ? id : `agent:${id}`);

/** Whether a task is in the policy's scope. Pure. */
export function inPolicyScope(policy: Pick<QaReviewPolicyBody, "scope">, taskId: string, workClass: "P" | "PC"): boolean {
  return (policy.scope.workClasses.length === 0 || policy.scope.workClasses.includes(workClass)) && (policy.scope.taskIds.length === 0 || policy.scope.taskIds.includes(taskId));
}

/** The set command as stored: every field optional (a field left out stays as it was), validated. */
export function checkPolicyChange(command: Record<string, unknown>): {
  workClasses?: ("P" | "PC")[]; taskIds?: string[]; onSubmission?: boolean; periodicMinutes?: number | null; onIncident?: boolean; requiredChecks?: string[]; gatesCompletion?: boolean; independentSources?: number; requireVerdictCitations?: boolean;
} {
  const out: ReturnType<typeof checkPolicyChange> = {};
  const list = (v: unknown, field: string, max: number): unknown[] => (Array.isArray(v) && v.length <= max ? v : bad(field, `must be a list of at most ${max}`));
  if (command["workClasses"] !== undefined) {
    const v = list(command["workClasses"], "workClasses", 2);
    if (v.some((x) => x !== "P" && x !== "PC") || new Set(v).size !== v.length) bad("workClasses", "must be P and/or PC (an empty list means every class)");
    out.workClasses = [...v as ("P" | "PC")[]].sort();
  }
  if (command["taskIds"] !== undefined) {
    const v = list(command["taskIds"], "taskIds", QA_REVIEW_LIMITS.taskIds).map((x) => checkTaskId(x));
    out.taskIds = [...new Set(v)].sort();
  }
  for (const k of ["onSubmission", "onIncident", "gatesCompletion", "requireVerdictCitations"] as const) if (command[k] !== undefined) { if (typeof command[k] !== "boolean") bad(k, "must be true or false"); (out as Record<string, unknown>)[k] = command[k]; }
  if (command["periodicMinutes"] !== undefined) {
    const m = command["periodicMinutes"];
    if (m !== null && (typeof m !== "number" || !Number.isSafeInteger(m) || m < QA_REVIEW_LIMITS.minPeriodMinutes || m > QA_REVIEW_LIMITS.maxPeriodMinutes)) bad("periodicMinutes", `must be a whole number of minutes from ${QA_REVIEW_LIMITS.minPeriodMinutes} to ${QA_REVIEW_LIMITS.maxPeriodMinutes}, or null to stop the periodic review`);
    out.periodicMinutes = m as number | null;
  }
  if (command["requiredChecks"] !== undefined) {
    const v = list(command["requiredChecks"], "requiredChecks", QA_REVIEW_LIMITS.requiredChecks).map((x, i) => text(x, `requiredChecks[${i}]`, { min: 1, max: QA_REVIEW_LIMITS.checkName, multiline: true }));
    for (const n of v) if (redactText(n) !== n) bad("requiredChecks", "a check name must not hold anything that looks like a credential");
    out.requiredChecks = [...new Set(v)];
  }
  if (command["independentSources"] !== undefined) {
    const n = command["independentSources"];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1 || n > QA_REVIEW_LIMITS.sources) bad("independentSources", `must be a whole number from 1 to ${QA_REVIEW_LIMITS.sources}`);
    out.independentSources = n as number;
  }
  return out;
}

/**
 * The review policy and the scheduler that carries it out (card Q02).
 *
 * - **Record.** `set` (owner only) and `get`. A project with none has nothing switched on.
 * - **Scheduler.** `sweep` (the dispatcher's regular round) creates a review request for each code submission that a trigger names and gives it to an agent that holds the reviewer role in the project and did not work on the
 *   task (never the submitters of its code, never the agent that holds the task now). It writes the request, its index and one notice to the assignee, and nothing else: it never pauses, stops, messages or takes
 *   work from the agents working on the task, and a running attempt of a contributor is not looked at beyond reading who holds the task.
 * - **Settling.** A request is done when independent QA evidence is recorded on its submission after it was made by someone who did not work on the task, and superseded when the task's code moved on to a newer
 *   submission or the task was cancelled.
 */
export class QaReviewService {
  readonly #runner: CommandRunner;
  readonly #qa: Pick<QaEvidenceService, "newestCodeIn">;
  readonly #ports: QaReviewPorts;
  /** When this controller's throttled round last ran (the dispatcher's call, every tick): at most once per `sweepEveryMs`. */
  #lastSweepAt: number | undefined;
  /** Card Q02 review: where the next round's look at stale approvals and changed dependencies starts, among the tasks the round found (it moves on by `looksPerRound` each round, so every task is looked at in turn). */
  #lookFrom = 0;
  private constructor(runner: CommandRunner, qa: Pick<QaEvidenceService, "newestCodeIn">, ports: QaReviewPorts) { this.#runner = runner; this.#qa = qa; this.#ports = ports; }

  static withEpoch(storage: ControllerStorage, epoch: number, qa: Pick<QaEvidenceService, "newestCodeIn">, ports: QaReviewPorts, options: RunnerOptions = {}): QaReviewService {
    return new QaReviewService(new CommandRunner(storage, epoch, options), qa, ports);
  }

  // ---- the policy -------------------------------------------------------------------------------------------------------------

  /** The controller's own question (the QA gate and the landing gate): the policy of a project, or `undefined` when it set none. */
  async policyOf(projectId: string): Promise<QaReviewPolicyBody | undefined> {
    return (await this.#runner.get(KIND, projectId))?.body as unknown as QaReviewPolicyBody | undefined;
  }

  /** What the policy adds for one task: its extra checks and source count, or `undefined` when none applies (no policy, or the task is outside its scope). */
  async gateTerms(projectId: string, taskId: string): Promise<{ readonly requiredChecks: readonly string[]; readonly independentSources: number } | undefined> {
    const p = await this.policyOf(projectId);
    if (p === undefined || !(await this.#covers(p, taskId))) return undefined;
    return p.requiredChecks.length === 0 && p.independentSources === 1 ? undefined : { requiredChecks: p.requiredChecks, independentSources: p.independentSources };
  }

  /** Whether a verdict on this task must name the criteria version itself (card Q02): the policy asks for it and the task is in its scope. */
  async requiresCitation(projectId: string, taskId: string): Promise<boolean> {
    return (await this.citationRule(projectId, taskId)) === "explicit";
  }

  /**
   * The citation rule for a verdict on this task (card Q02): the policy's (`citationRuleOf`) for a task in its scope, else the default (`rejections`). A policy that cannot be read throws, so the review is refused rather
   * than recorded under a looser rule.
   */
  async citationRule(projectId: string, taskId: string): Promise<CitationRule> {
    const p = await this.policyOf(projectId);
    return p === undefined || !(await this.#covers(p, taskId)) ? "rejections" : citationRuleOf(p);
  }

  /** The landing checks the policy adds for one task: `qa` and `review`, when it gates completion and the task is in scope. */
  async landingChecks(projectId: string, taskId: string | undefined): Promise<readonly Check[]> {
    const p = await this.policyOf(projectId);
    if (p === undefined || !p.gatesCompletion) return [];
    if (taskId !== undefined && !(await this.#covers(p, taskId))) return [];
    // Without a task (a question about the project alone) the scope cannot be judged: nothing is added there; the landing gate always asks with its task.
    return taskId === undefined ? [] : ["review", "qa"];
  }

  async #covers(p: QaReviewPolicyBody, taskId: string): Promise<boolean> {
    const contract = (await this.#runner.get("task-contract", taskId))?.body as { workClass?: unknown } | undefined;
    const cls = contract?.workClass === "PC" ? "PC" : "P";
    const task = (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined;
    return task !== undefined && task.projectId === p.projectId && inPolicyScope(p, taskId, cls);
  }

  #mayRead(by: Principal, projectId: string): boolean {
    return by.kind === "owner" || (by.kind === "agent" && by.taskScope === undefined && allows(by, "task.read", projectId));
  }

  #mayReadTask(by: Principal, projectId: string, taskId: string): boolean {
    return by.kind === "owner" || allows(by, "task.read", projectId, { resource: { kind: "task", id: taskId } });
  }

  /** The project's review policy, or what a project with none has. The owner, or an agent that may read the project's tasks. */
  async get(by: Principal, projectIdValue: string): Promise<{ readonly revision: number; readonly item: QaReviewPolicyBody | (Omit<QaReviewPolicyBody, "updatedBy" | "updatedAt"> & { updatedBy?: undefined; updatedAt?: undefined }); readonly isDefault: boolean }> {
    const projectId = checkProjectId(projectIdValue);
    if ((await this.#runner.get("project", projectId)) === undefined || !this.#mayRead(by, projectId)) throw new DomainError("not_found", "no such project");
    const found = await this.#runner.get(KIND, projectId);
    if (found === undefined) return { revision: 0, item: { ...NO_POLICY(projectId), citations: "rejections" }, isDefault: true };
    const stored = found.body as unknown as QaReviewPolicyBody;
    // The rule in force is shown with it (a `false` the owner never chose is the default).
    const item: QaReviewPolicyBody = { ...stored, citations: citationRuleOf(stored) };
    // A named task the reader may not read (a restriction on that task) is not shown: the scope lists only the tasks the reader can see.
    const taskIds = by.kind === "owner" ? item.scope.taskIds : item.scope.taskIds.filter((t) => this.#mayReadTask(by, projectId, t));
    return { revision: found.revision, item: taskIds.length === item.scope.taskIds.length ? item : { ...item, scope: { ...item.scope, taskIds } }, isDefault: false };
  }

  /** The owner sets the project's review policy; fields left out stay as they were. Switching a trigger on records when, so work before it is not reviewed backwards. */
  async set(owner: Principal, command: NoActor & Record<string, unknown> & { projectId: string }): Promise<{ revision: number; replayed: boolean }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not change a project's review policy`);
    for (const k of Object.keys(command)) if (!["commandId", "projectId", "workClasses", "taskIds", "onSubmission", "periodicMinutes", "onIncident", "requiredChecks", "gatesCompletion", "independentSources", "requireVerdictCitations"].includes(k)) bad(k, "is not a field of this command");
    const projectId = checkProjectId(command.projectId);
    const change = checkPolicyChange(command);
    if (Object.keys(change).length === 0) bad("onSubmission", "name what to change: workClasses, taskIds, onSubmission, periodicMinutes, onIncident, requiredChecks, gatesCompletion, independentSources or requireVerdictCitations");
    const result = await this.#runner.command("qa.review.policy.set", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { projectId, change: json(change) },
      build: async (): Promise<Built> => {
        if ((await this.#runner.get("project", projectId)) === undefined) throw new DomainError("not_found", `project ${projectId} does not exist`);
        for (const t of change.taskIds ?? []) {
          const task = (await this.#runner.get("task", t))?.body as unknown as TaskBody | undefined;
          if (task === undefined || task.projectId !== projectId) bad("taskIds", `${t} is not a task of this project`);
        }
        const current = await this.#runner.get(KIND, projectId);
        const before = (current?.body as unknown as QaReviewPolicyBody | undefined) ?? { ...NO_POLICY(projectId), updatedBy: "", updatedAt: "" };
        const now = this.#runner.now();
        const triggers = { onSubmission: change.onSubmission ?? before.triggers.onSubmission, periodicMinutes: change.periodicMinutes === undefined ? before.triggers.periodicMinutes : change.periodicMinutes, onIncident: change.onIncident ?? before.triggers.onIncident };
        // A trigger that was off and is now on starts counting from now; one that stays on keeps its start; a periodic review whose interval changed starts again.
        const since: { submission?: string; periodic?: string; incident?: string; gate?: string } = {};
        if (triggers.onSubmission) since.submission = before.triggers.onSubmission && before.since.submission !== undefined ? before.since.submission : now;
        if (triggers.periodicMinutes !== null) since.periodic = before.triggers.periodicMinutes === triggers.periodicMinutes && before.since.periodic !== undefined ? before.since.periodic : now;
        if (triggers.onIncident) since.incident = before.triggers.onIncident && before.since.incident !== undefined ? before.since.incident : now;
        // Gating switched on again asks again for the reviews it needs (the requests it closed when it was switched off keep their IDs).
        const gates = change.gatesCompletion ?? before.gatesCompletion;
        if (gates) since.gate = before.gatesCompletion && before.since.gate !== undefined ? before.since.gate : now;
        const next: QaReviewPolicyBody = {
          projectId, scope: { workClasses: change.workClasses ?? before.scope.workClasses, taskIds: change.taskIds ?? before.scope.taskIds }, triggers,
          requiredChecks: change.requiredChecks ?? before.requiredChecks, gatesCompletion: change.gatesCompletion ?? before.gatesCompletion, independentSources: change.independentSources ?? before.independentSources,
          // Card Q02: when the owner names it, the choice is recorded with its time (`citationsSetAt`); otherwise what was stored is kept as it was (an old `false` that was only the default stays the default).
          ...(change.requireVerdictCitations ?? before.requireVerdictCitations) === undefined ? {} : { requireVerdictCitations: (change.requireVerdictCitations ?? before.requireVerdictCitations)! },
          ...(change.requireVerdictCitations !== undefined ? { citationsSetAt: now } : before.citationsSetAt === undefined ? {} : { citationsSetAt: before.citationsSetAt }), since, updatedBy: owner.id, updatedAt: now,
        };
        const ref = { kind: KIND, id: projectId };
        const c: Change = current === undefined ? { type: "create", ref, body: json(next) } : { type: "update", ref, expectedRevision: current.revision, body: json(next) };
        return { ref, creates: current === undefined, changes: [c], detail: { projectId } };
      },
    }));
    return { revision: result.revision, replayed: result.replayed };
  }

  // ---- the requests -----------------------------------------------------------------------------------------------------------

  async #index(projectId: string): Promise<{ revision?: number; open: string[] }> {
    const found = await this.#runner.get(INDEX, projectId);
    return { ...(found === undefined ? {} : { revision: found.revision }), open: [...((found?.body as unknown as IndexBody | undefined)?.open ?? [])] };
  }

  /**
   * The project's open review requests, oldest first, `limit` at a time (`after` is how many were already shown). The owner sees all; an agent only the ones assigned to it (and needs the right to read the project's tasks).
   */
  async requests(by: Principal, projectIdValue: string, page: { readonly after?: number; readonly limit?: number } = {}): Promise<{ readonly projectId: string; readonly total: number; readonly items: readonly (QaReviewRequestBody & { id: string })[]; readonly next?: number }> {
    const projectId = checkProjectId(projectIdValue);
    if ((await this.#runner.get("project", projectId)) === undefined || !this.#mayRead(by, projectId)) throw new DomainError("not_found", "no such project");
    const after = page.after ?? 0, limit = page.limit ?? QA_REVIEW_LIMITS.page;
    if (!Number.isSafeInteger(after) || after < 0) bad("after", "must be a whole number");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) bad("limit", "must be 1 to 50");
    const all: (QaReviewRequestBody & { id: string })[] = [];
    for (const id of (await this.#index(projectId)).open) {
      const b = (await this.#runner.get(REQUEST, id))?.body as unknown as QaReviewRequestBody | undefined;
      if (b === undefined || b.state !== "open") continue;
      if (by.kind !== "owner" && (b.assignee !== by.id || !this.#mayReadTask(by, projectId, b.taskId))) continue;
      all.push({ ...b, id });
    }
    const items = all.slice(after, after + limit);
    return { projectId, total: all.length, items, ...(after + limit < all.length ? { next: after + limit } : {}) };
  }

  // ---- the scheduler ----------------------------------------------------------------------------------------------------------

  /**
   * One round of the scheduler over every project with a review policy: settles the requests that are done or replaced, takes up the ones still without an assignee, and creates the requests the triggers name.
   * Controller-internal (the dispatcher's loop and the owner's `qa.review.sweep`). A project that fails is counted and the others go on; the next round looks again. Idempotent: a request has a stable ID made from
   * its task, submission, trigger and cause, so two controllers or a repeated round make it once.
   */
  async sweep(options: { readonly throttled?: boolean } = {}): Promise<QaReviewSweepResult & { readonly skipped?: true }> {
    const total = { projects: 0, created: 0, assigned: 0, settled: 0, superseded: 0, unassigned: 0, errors: 0 };
    if (options.throttled === true) {
      // The dispatcher calls this every tick; a round reads the submissions (and incidents) of the whole installation, so it runs at most once a minute of the controller's clock (the shortest period is 15 minutes).
      // A clock set back below the last round does not stop the rounds for good: only a round less than the interval ago, measured forwards, is skipped.
      const at = Date.parse(this.#runner.now());
      if (Number.isFinite(at) && this.#lastSweepAt !== undefined && at >= this.#lastSweepAt && at - this.#lastSweepAt < QA_REVIEW_LIMITS.sweepEveryMs) return { ...total, skipped: true };
      this.#lastSweepAt = Number.isFinite(at) ? at : undefined;
    }
    const policies: QaReviewPolicyBody[] = [];
    let after: string | undefined;
    for (let read = 0; read < 100 && policies.length < QA_REVIEW_LIMITS.policies; read++) {
      const chunk = await this.#runner.list(KIND, { ...(after === undefined ? {} : { afterId: after }), limit: 100 });
      for (const row of chunk) { after = row.id; if (policies.length < QA_REVIEW_LIMITS.policies) policies.push(row.body as unknown as QaReviewPolicyBody); }
      if (chunk.length < 100) break;
    }
    // A policy with no trigger on and no open request has nothing to do; the others share one scan of the submissions and, when any has the incident trigger on, one of the incidents.
    const active: { policy: QaReviewPolicyBody; open: string[]; revision?: number }[] = [];
    // Card Q02: approvals that stopped counting and changed dependencies are looked at in every active project, with a policy or without one (a project without one has nothing else switched on).
    const everyProject = this.#ports.approvalOf !== undefined || this.#ports.dependenciesChanged !== undefined;
    for (const policy of policies) {
      total.projects++;
      try {
        const index = await this.#index(policy.projectId);
        const t = policy.triggers;
        if (everyProject || index.open.length > 0 || t.onSubmission || t.periodicMinutes !== null || t.onIncident || policy.gatesCompletion) active.push({ policy, ...index });
      } catch { total.errors++; }
    }
    if (everyProject) {
      const withPolicy = new Set(policies.map((p) => p.projectId));
      try {
        for (const projectId of await this.#activeProjects()) {
          if (withPolicy.has(projectId)) continue;
          total.projects++;
          active.push({ policy: { ...NO_POLICY(projectId), updatedBy: "", updatedAt: "" }, ...(await this.#index(projectId)) });
        }
      } catch { total.errors++; }
    }
    if (active.length === 0) return total;
    let scan: ReadonlyMap<string, NewestCode["tasks"]>;
    let incidents: ReadonlyMap<string, readonly { id: string; at: string }[]>;
    try {
      scan = (await this.#qa.newestCodeIn(new Set(active.map((a) => a.policy.projectId)))).byProject;
      incidents = await this.#openIncidents(new Set(active.filter((a) => a.policy.triggers.onIncident).map((a) => a.policy.projectId)));
    } catch { total.errors += active.length; return total; }
    // Card Q02 review: the look at stale approvals and changed dependencies reads each recorded dependency of each task, so one round looks at no more than `looksPerRound` tasks, the next ones after where the last
    // round stopped (wrapping round), and the rounds go through all of them in turn. The gate, the landing and the views judge them when read, whatever the round reached.
    const found = active.reduce((sum, a) => sum + (scan.get(a.policy.projectId)?.length ?? 0), 0);
    const from = found === 0 ? 0 : this.#lookFrom % found;
    const width = Math.min(this.#ports.looksPerRound ?? QA_REVIEW_LIMITS.looksPerRound, found);
    let ordinal = 0;
    const look = (): boolean => { const o = ordinal++; return ((o - from + found) % found) < width; };
    this.#lookFrom = found === 0 ? 0 : (from + width) % found;
    for (const a of active) {
      try {
        const r = await this.#project(a.policy, a, scan.get(a.policy.projectId) ?? [], incidents.get(a.policy.projectId) ?? [], look);
        total.created += r.created; total.assigned += r.assigned; total.settled += r.settled; total.superseded += r.superseded; total.unassigned += r.unassigned;
      } catch { total.errors++; }
    }
    return total;
  }

  /** The IDs of the active projects (card Q02: the re-review of stale approvals is asked in every one), bounded to `QA_REVIEW_LIMITS.projects`. */
  async #activeProjects(): Promise<string[]> {
    const out: string[] = [];
    let after: string | undefined;
    for (let read = 0; read < 100 && out.length < QA_REVIEW_LIMITS.projects; read++) {
      const chunk = await this.#runner.list("project", { ...(after === undefined ? {} : { afterId: after }), limit: 100 });
      for (const row of chunk) { after = row.id; if ((row.body as { state?: string }).state === "active" && out.length < QA_REVIEW_LIMITS.projects) out.push(row.id); }
      if (chunk.length < 100) break;
    }
    return out;
  }

  async #project(policy: QaReviewPolicyBody, index: { readonly open: readonly string[] }, tasks: NewestCode["tasks"], incidents: readonly { id: string; at: string }[], look: () => boolean = () => true): Promise<{ created: number; assigned: number; settled: number; superseded: number; unassigned: number }> {
    const out = { created: 0, assigned: 0, settled: 0, superseded: 0, unassigned: 0 };
    const projectId = policy.projectId;
    const t = policy.triggers;
    const scan = { tasks };
    const newest = new Map(scan.tasks.map((x) => [x.taskId, x] as const));
    const now = this.#runner.now();
    // An archived or deleted project is left alone: nothing is created, assigned or told (its open requests stay as they are and go on when the project is active again).
    if (((await this.#runner.get("project", projectId))?.body as { state?: string } | undefined)?.state !== "active") return out;
    // The reviewers of one worker are read once per round, not once per request (`reviewersAvailableIn` reads every agent).
    const pools = new Map<string, Promise<readonly string[]>>();
    const reviewers = (worker: string): Promise<readonly string[]> => { let p = pools.get(worker); if (p === undefined) { p = this.#ports.reviewers(projectId, worker); pools.set(worker, p); } return p; };
    // Load: how many open requests each agent already has, so the work is spread evenly.
    const load = new Map<string, number>();
    const open = new Map<string, QaReviewRequestBody & { id: string; revision: number }>();
    for (const id of index.open) {
      const found = await this.#runner.get(REQUEST, id);
      const b = found?.body as unknown as QaReviewRequestBody | undefined;
      if (found === undefined || b === undefined || b.state !== "open") { await this.#close(projectId, id, undefined); continue; }
      open.set(id, { ...b, id, revision: found.revision });
      if (b.assignee !== undefined) load.set(b.assignee, (load.get(b.assignee) ?? 0) + 1);
    }
    // 1. Settle, take up, and tell.
    for (const r of open.values()) {
      const latest = newest.get(r.taskId);
      const askedAt = ((await this.#runner.get("submission", r.submissionId))?.body as { submittedAt?: string } | undefined)?.submittedAt;
      if (latest !== undefined && latest.submissionId !== r.submissionId && askedAt !== undefined && latest.at > askedAt) {
        await this.#settle(r, "superseded", latest.submissionId); open.delete(r.id); out.superseded++; continue;
      }
      // A cancelled task needs no review any more: the request is closed as superseded by the cancellation (nothing is asked of anyone).
      if (((await this.#runner.get("task", r.taskId))?.body as unknown as TaskBody | undefined)?.state === "cancelled") { await this.#settle(r, "superseded", "cancelled"); open.delete(r.id); out.superseded++; continue; }
      const info = newest.get(r.taskId);
      // Card Q02: a re-review of an approval that stopped counting is done when a newer review is recorded, or when the approval counts again (a dispute settled by keeping the decision); the policy plays no part.
      if (r.trigger === "reapproval") {
        if (this.#ports.approvalOf === undefined) continue;
        const a = await this.#ports.approvalOf(r.submissionId);
        if (a === undefined) { await this.#settle(r, "superseded", "gone"); open.delete(r.id); out.superseded++; continue; }
        if (a.outdated?.reviewId !== r.approval) { await this.#settle(r, "done", a.approved ? (a.reviewId ?? "restored") : "reviewed"); open.delete(r.id); out.settled++; continue; }
      } else {
        const done = await this.#independentEvidence(r, info);
        if (done !== undefined) { await this.#settle(r, "done", done); open.delete(r.id); out.settled++; continue; }
        // The policy changed since the request was made (card Q02 review): a task no longer in scope, or a trigger switched off while independent review does not gate the task's completion, needs no review any more.
        // The request is closed as superseded by the policy; nothing is asked of anyone. One kept by gating stays open (the landing needs it).
        const covered = await this.#covers(policy, r.taskId);
        const triggerOn = r.trigger === "submission" ? t.onSubmission : r.trigger === "periodic" ? t.periodicMinutes !== null : r.trigger === "incident" ? t.onIncident : false;
        if (!covered || !(triggerOn || policy.gatesCompletion)) { await this.#settle(r, "superseded", "policy"); open.delete(r.id); out.superseded++; continue; }
      }
      if (info === undefined) continue;
      let current = r;
      if (r.assignee === undefined || !(await this.#stillEligible(r, info, reviewers))) {
        const pick = await this.#pick(r.taskId, info, load, reviewers, r.approvedBy);
        // An assignee that cannot review any more (it holds the task now, or left the reviewers) is replaced by the next eligible one, or leaves the request waiting with the owner told.
        if (pick !== r.assignee) { current = await this.#assign(r, pick, now); if (pick !== undefined) { load.set(pick, (load.get(pick) ?? 0) + 1); out.assigned++; } open.set(r.id, current); }
      }
      if (current.assignee === undefined) { out.unassigned++; await this.#tell(current, "owner"); } else await this.#tell(current, current.assignee);
    }
    // 2. Create what the triggers name.
    const wanted: { taskId: string; trigger: QaReviewRequestBody["trigger"]; cause: string; approval?: string; reason?: string; approvedBy?: string }[] = [];
    // Card Q02 ("invalidation schedules revalidation"): the newest code of each unfinished task whose approval stopped counting is asked to be reviewed again, once per such approval (the cause is its review ID), in
    // every project; and its QA evidence is looked at against the task's recorded dependencies (a re-check goes to whoever recorded evidence that no longer holds).
    const asked = new Set([...open.values()].map((r) => r.submissionId));
    for (const x of scan.tasks) {
      if (!look()) continue;
      const task = (await this.#runner.get("task", x.taskId))?.body as unknown as TaskBody | undefined;
      if (task === undefined || task.projectId !== projectId || task.state === "cancelled" || task.state === "done") continue;
      if (this.#ports.dependenciesChanged !== undefined) await this.#ports.dependenciesChanged(x.taskId).catch(() => undefined);
      // Code that already has an open request is not asked for twice (below), so its approval is not read here.
      if (this.#ports.approvalOf === undefined || asked.has(x.submissionId)) continue;
      const a = await this.#ports.approvalOf(x.submissionId).catch(() => undefined);
      if (a?.outdated !== undefined) wanted.push({ taskId: x.taskId, trigger: "reapproval", cause: `${a.outdated.reviewId}@${hex(a.outdated.because).slice(0, 12)}`, approval: a.outdated.reviewId, reason: redactText(a.outdated.because).slice(0, 300), approvedBy: a.outdated.approvedBy });
    }
    if (!t.onSubmission && t.periodicMinutes === null && !t.onIncident && !policy.gatesCompletion && wanted.length === 0) return out;
    const eligible: typeof scan.tasks[number][] = [];
    for (const x of scan.tasks) {
      const task = (await this.#runner.get("task", x.taskId))?.body as unknown as TaskBody | undefined;
      if (task === undefined || task.projectId !== projectId || task.state === "cancelled" || !(await this.#covers(policy, x.taskId))) continue;
      eligible.push(x);
      if (t.onSubmission && policy.since.submission !== undefined && x.at >= policy.since.submission) wanted.push({ taskId: x.taskId, trigger: "submission", cause: x.submissionId });
    }
    if (t.periodicMinutes !== null && policy.since.periodic !== undefined) {
      const bucket = Math.floor(Date.parse(now) / (t.periodicMinutes * 60_000));
      if (now >= policy.since.periodic) {
        for (const x of eligible) {
          const task = (await this.#runner.get("task", x.taskId))?.body as unknown as TaskBody | undefined;
          if (task?.state !== "done") wanted.push({ taskId: x.taskId, trigger: "periodic", cause: `p${bucket}` });
        }
      }
    }
    if (t.onIncident && policy.since.incident !== undefined) {
      const since = policy.since.incident;
      for (const incident of incidents.filter((x) => x.at >= since).slice(0, QA_REVIEW_LIMITS.incidents)) for (const x of eligible.slice(0, QA_REVIEW_LIMITS.tasksPerIncident)) wanted.push({ taskId: x.taskId, trigger: "incident", cause: incident.id });
    }
    // Independent review gates completion: the newest code of each unfinished task in scope needs it before it may land, so it is asked for unless someone who did not work on the task already recorded independent
    // evidence on it. This also reaches code made before the policy (a landing of it would be refused otherwise), and the owner is told when nobody can review it rather than finding the landing stuck.
    if (policy.gatesCompletion) {
      for (const x of eligible) {
        const task = (await this.#runner.get("task", x.taskId))?.body as unknown as TaskBody | undefined;
        if (task?.state !== "done") wanted.push({ taskId: x.taskId, trigger: "gate", cause: `${x.submissionId}@${policy.since.gate ?? ""}` });
      }
    }
    const owed = new Set([...open.values()].map((r) => r.submissionId));
    let made = 0;
    for (const w of wanted) {
      if (made >= QA_REVIEW_LIMITS.perSweep || open.size >= QA_REVIEW_LIMITS.openPerProject) break;
      const info = newest.get(w.taskId)!;
      // A submission that already has an open review is not asked for twice, whichever trigger came second.
      if (owed.has(info.submissionId)) continue;
      const id = w.trigger === "reapproval" ? await this.#episode(projectId, w.taskId, info.submissionId, w.cause) : `qrr-${hex(projectId, w.taskId, info.submissionId, w.trigger, w.cause)}`;
      if (id === undefined || (await this.#runner.get(REQUEST, id)) !== undefined) continue;
      if (w.trigger === "gate" && (await this.#independentEvidence({ projectId, taskId: w.taskId, submissionId: info.submissionId, createdAt: "" }, info)) !== undefined) continue;
      const assignee = await this.#pick(w.taskId, info, load, reviewers, w.approvedBy);
      const body: QaReviewRequestBody = { projectId, taskId: w.taskId, submissionId: info.submissionId, tree: info.tree, trigger: w.trigger, cause: w.cause, ...(w.approval === undefined ? {} : { approval: w.approval }), ...(w.reason === undefined ? {} : { reason: w.reason }), ...(w.approvedBy === undefined ? {} : { approvedBy: w.approvedBy }), ...(assignee === undefined ? {} : { assignee, assignedAt: now }), state: "open", createdAt: now };
      if (!(await this.#create(id, body))) continue;
      made++; out.created++; owed.add(info.submissionId);
      if (assignee !== undefined) { load.set(assignee, (load.get(assignee) ?? 0) + 1); await this.#tell({ ...body, id }, assignee); } else { out.unassigned++; await this.#tell({ ...body, id }, "owner"); }
      open.set(id, { ...body, id, revision: 0 });
    }
    return out;
  }

  /**
   * The open incidents of these projects, newest first, with one bounded scan of the incident records (they are kept, resolved ones too, until purged, and their IDs are hashes, so the scan reads as far as the incident
   * service's own list does rather than stopping at a page count that would leave newer incidents unseen on a large installation).
   */
  async #openIncidents(projectIds: ReadonlySet<string>): Promise<ReadonlyMap<string, readonly { id: string; at: string }[]>> {
    const found = new Map<string, { id: string; at: string }[]>();
    if (projectIds.size === 0) return found;
    let after: string | undefined;
    for (let page = 0; page < QA_REVIEW_LIMITS.incidentPages; page++) {
      const chunk = await this.#runner.list("responsibility-incident", { ...(after === undefined ? {} : { afterId: after }), limit: QA_REVIEW_LIMITS.incidentPageSize });
      for (const row of chunk) {
        after = row.id;
        const b = row.body as unknown as IncidentBody;
        if (projectIds.has(b.projectId) && b.state === "open") found.set(b.projectId, [...(found.get(b.projectId) ?? []), { id: row.id, at: b.firstAt }]);
      }
      if (chunk.length < QA_REVIEW_LIMITS.incidentPageSize) break;
    }
    for (const list of found.values()) list.sort((a, b) => (a.at > b.at ? -1 : a.at < b.at ? 1 : a.id < b.id ? -1 : 1));
    return found;
  }

  /**
   * The request ID for this stale episode of an approval (card Q02 review): the first of the IDs made from the cause and an episode number that is not taken, read in order; an episode whose request was settled because
   * the approval counted again (`settledBy` the approval itself, or `restored`) is over, so the approval that stops counting again for the same reason is asked again. Any other request already made (open, or
   * settled by a newer review or as superseded) is this episode: `undefined`, nothing more is asked. Derived only from stored requests, so a repeated round or a second controller arrives at the same ID and makes it once.
   * At most `QA_REVIEW_LIMITS.episodes` episodes per approval and reason are asked (an approval flapping without end is not asked without end).
   */
  async #episode(projectId: string, taskId: string, submissionId: string, cause: string): Promise<string | undefined> {
    for (let k = 0; k < QA_REVIEW_LIMITS.episodes; k++) {
      const id = `qrr-${hex(projectId, taskId, submissionId, "reapproval", k === 0 ? cause : `${cause}#${k}`)}`;
      const b = (await this.#runner.get(REQUEST, id))?.body as unknown as QaReviewRequestBody | undefined;
      if (b === undefined) return id;
      if (!(b.state === "done" && (b.settledBy === "restored" || (b.approval !== undefined && b.settledBy === b.approval)))) return undefined;
    }
    return undefined;
  }

  /** Eligible reviewers for a task, least loaded first (`prefer`, the reviewer whose approval stopped counting, first when still eligible): never the submitters of its code, never the agent that holds it now. */
  async #pick(taskId: string, info: { submittedBy: string; contributors: readonly string[] }, load: ReadonlyMap<string, number>, reviewers: (worker: string) => Promise<readonly string[]>, prefer?: string): Promise<string | undefined> {
    const assignment = (await this.#runner.get("assignment", assignmentIdOf(taskId)))?.body as { owner?: { id?: string } } | undefined;
    const excluded = new Set([...info.contributors, info.submittedBy, ...(assignment?.owner?.id === undefined ? [] : [principalOf(assignment.owner.id)])].map(principalOf));
    const pool = (await reviewers(info.submittedBy)).filter((r) => !excluded.has(principalOf(r)));
    pool.sort((a, b) => (load.get(a) ?? 0) - (load.get(b) ?? 0) || (a < b ? -1 : a > b ? 1 : 0));
    return prefer !== undefined && pool.includes(prefer) ? prefer : pool[0];
  }

  async #stillEligible(r: QaReviewRequestBody, info: { submittedBy: string; contributors: readonly string[] }, reviewers: (worker: string) => Promise<readonly string[]>): Promise<boolean> {
    if (r.assignee === undefined) return false;
    const pool = await reviewers(info.submittedBy);
    const assignment = (await this.#runner.get("assignment", assignmentIdOf(r.taskId)))?.body as { owner?: { id?: string } } | undefined;
    const excluded = new Set([...info.contributors, ...(assignment?.owner?.id === undefined ? [] : [assignment.owner.id])].map(principalOf));
    return pool.includes(r.assignee) && !excluded.has(principalOf(r.assignee));
  }

  /**
   * Independent QA evidence recorded on the request's submission after the request was made, by someone who did not work on the task (not a submitter of its code, not the agent that holds it now): its ID. Evidence
   * by another contributor counts for the QA gate as it always did, but it is not the independent review the policy asked for, so the request stays open for its reviewer.
   */
  async #independentEvidence(r: Pick<QaReviewRequestBody, "projectId" | "taskId" | "submissionId" | "createdAt">, info: { submittedBy: string; contributors: readonly string[] } | undefined): Promise<string | undefined> {
    const ids = ((await this.#runner.get("qa-evidence-index", r.taskId))?.body as unknown as { ids?: string[] } | undefined)?.ids ?? [];
    const assignment = (await this.#runner.get("assignment", assignmentIdOf(r.taskId)))?.body as { owner?: { id?: string } } | undefined;
    const submitter = ((await this.#runner.get("submission", r.submissionId))?.body as { submittedBy?: string } | undefined)?.submittedBy;
    const excluded = new Set([...(info?.contributors ?? []), ...(info === undefined ? [] : [info.submittedBy]), ...(submitter === undefined ? [] : [submitter]), ...(assignment?.owner?.id === undefined ? [] : [assignment.owner.id])].map(principalOf));
    for (const id of [...ids].reverse().slice(0, 100)) {
      const e = (await this.#runner.get("qa-evidence", id))?.body as unknown as QaEvidenceBody | undefined;
      if (e !== undefined && e.submissionId === r.submissionId && e.source === "independent" && e.recordedAt >= r.createdAt && !excluded.has(e.recordedBy)) return id;
    }
    return undefined;
  }

  async #create(id: string, body: QaReviewRequestBody): Promise<boolean> {
    try {
      const result = await this.#runner.command("qa.review.request", { commandId: `qrr:${id}`, actor: SERVICE }, async () => ({
        payload: { id },
        build: async (): Promise<Built> => {
          const index = await this.#index(body.projectId);
          const ref = { kind: REQUEST, id };
          const next = json({ open: [...index.open.filter((x) => x !== id), id] });
          const changes: Change[] = [{ type: "create", ref, body: json(body) }, index.revision === undefined ? { type: "create", ref: { kind: INDEX, id: body.projectId }, body: next } : { type: "update", ref: { kind: INDEX, id: body.projectId }, expectedRevision: index.revision, body: next }];
          return { ref, creates: true, changes, detail: { projectId: body.projectId, taskId: body.taskId, trigger: body.trigger } };
        },
      }));
      // A replay means another controller (or an earlier round) made it with its own pick of assignee: this round neither counts nor tells it; the next round reads the stored request.
      return !result.replayed;
    } catch (error) {
      // Another controller made it first, or the index moved: the next round looks again.
      if (error instanceof DomainError && (error.code === "command_conflict" || error.code === "stale_revision")) return false;
      throw error;
    }
  }

  async #assign(r: QaReviewRequestBody & { id: string; revision: number }, assignee: string | undefined, now: string): Promise<QaReviewRequestBody & { id: string; revision: number }> {
    const { noticeAt: _n, ownerNoticeAt: _o, assignee: _a, assignedAt: _t, waitingSince: _w, ...kept } = r;
    const next = { ...kept, ...(assignee === undefined ? { waitingSince: now } : { assignee, assignedAt: now }) };
    const result = await this.#runner.command("qa.review.assign", { commandId: `qrr-assign:${r.id}:${assignee ?? "none"}:${now}`, actor: SERVICE }, async () => ({
      payload: { id: r.id, assignee: assignee ?? null },
      build: async (): Promise<Built> => {
        const found = await this.#runner.get(REQUEST, r.id);
        if (found === undefined) throw new DomainError("not_found", "no such request");
        const cur = found.body as unknown as QaReviewRequestBody;
        if (cur.state !== "open") throw new DomainError("stale_revision", "the request was settled meanwhile");
        const { noticeAt: _a1, ownerNoticeAt: _b1, assignee: _c1, assignedAt: _d1, waitingSince: _e1, ...base } = cur;
        const ref = { kind: REQUEST, id: r.id };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: json({ ...base, ...(assignee === undefined ? { waitingSince: now } : { assignee, assignedAt: now }) }) }], detail: { id: r.id } };
      },
    }));
    return { ...next, revision: result.revision };
  }

  async #settle(r: QaReviewRequestBody & { id: string }, state: "done" | "superseded", by: string): Promise<void> {
    await this.#runner.command("qa.review.settle", { commandId: `qrr-settle:${r.id}:${state}`, actor: SERVICE }, async () => ({
      payload: { id: r.id, state, by },
      build: async (): Promise<Built> => {
        const found = await this.#runner.get(REQUEST, r.id);
        if (found === undefined) throw new DomainError("not_found", "no such request");
        const cur = found.body as unknown as QaReviewRequestBody;
        const ref = { kind: REQUEST, id: r.id };
        const index = await this.#index(cur.projectId);
        const changes: Change[] = [{ type: "update", ref, expectedRevision: found.revision, body: json({ ...cur, state, settledAt: this.#runner.now(), settledBy: by }) }];
        if (index.revision !== undefined) changes.push({ type: "update", ref: { kind: INDEX, id: cur.projectId }, expectedRevision: index.revision, body: json({ open: index.open.filter((x) => x !== r.id) }) });
        return { ref, creates: false, changes, detail: { id: r.id, state } };
      },
    }));
  }

  /** Takes a request out of the project's open list (its record is gone or already settled). */
  async #close(projectId: string, id: string, _by: string | undefined): Promise<void> {
    await this.#runner.command("qa.review.unlist", { commandId: `qrr-unlist:${id}`, actor: SERVICE }, async () => ({
      payload: { id },
      build: async (): Promise<Built> => {
        const index = await this.#index(projectId);
        if (index.revision === undefined || !index.open.includes(id)) throw new DomainError("stale_revision", "already off the list");
        const ref = { kind: INDEX, id: projectId };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: index.revision, body: json({ open: index.open.filter((x) => x !== id) }) }], detail: { id } };
      },
    })).catch(() => undefined);
  }

  /** Tells the assignee (or the owner, when nobody is eligible) once; repeated by each round until the notice went through. A contributor is never told. */
  async #tell(r: QaReviewRequestBody & { id: string }, to: string): Promise<void> {
    if (this.#ports.notice === undefined) return;
    const field = to === "owner" ? "ownerNoticeAt" : "noticeAt";
    if (r[field] !== undefined) return;
    const words = r.trigger === "reapproval"
      ? (to === "owner"
        ? `Task ${r.taskId}'s code ${r.submissionId} needs a review again: its approval no longer counts (${r.reason ?? "what it was judged against changed"}). No reviewer agent of the project that did not work on the task can do it: add a reviewer agent to the project, or have the work submitted again.`
        : `Please review task ${r.taskId}'s code ${r.submissionId} again: its approval${r.approvedBy === undefined || r.approvedBy === "review_disabled_single_agent" ? "" : ` by ${r.approvedBy}`} no longer counts (${r.reason ?? "what it was judged against changed"}). Record a review (submission.record kind review) judged against the current criteria and decisions; it cites criteriaRevision.`)
      : to === "owner"
      ? `Nobody can review task ${r.taskId}'s code ${r.submissionId} independently (${r.trigger} review): every reviewer agent of the project worked on the task or holds it now. Add a reviewer agent to the project or review it yourself.`
      : `You are asked to review task ${r.taskId}'s code ${r.submissionId} independently (${r.trigger} review of tree ${r.tree.slice(0, 12)}): record QA evidence on it (qa.evidence.record).`;
    // One notice per stretch of the assignment: an agent assigned again after someone else had it (or the owner after the request waited again) is told again; within one stretch the IDs are stable, so a retry is one notice.
    const stretch = to === "owner" ? (r.waitingSince ?? r.createdAt) : (r.assignedAt ?? r.createdAt);
    try {
      await this.#ports.notice({ commandId: `qrr-note:${r.id}:${to}:${stretch}`, to, projectId: r.projectId, taskId: r.taskId, requestId: r.id, text: words.slice(0, 600) });
      await this.#runner.command("qa.review.noticed", { commandId: `qrr-noticed:${r.id}:${to}:${stretch}`, actor: SERVICE }, async () => ({
        payload: { id: r.id, to },
        build: async (): Promise<Built> => {
          const found = await this.#runner.get(REQUEST, r.id);
          if (found === undefined) throw new DomainError("not_found", "no such request");
          const ref = { kind: REQUEST, id: r.id };
          return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: json({ ...(found.body as object), [field]: this.#runner.now() }) }], detail: { id: r.id } };
        },
      }));
    } catch { /* best effort: the next round tells again */ }
  }
}
