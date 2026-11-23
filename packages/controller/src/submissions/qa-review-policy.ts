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
import type { QaEvidenceBody, QaEvidenceService } from "./qa-evidence.js";

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
  /** When each trigger was last switched on: work before it is not reviewed backwards (a new policy does not start by reviewing the backlog). */
  readonly since: { readonly submission?: string; readonly periodic?: string; readonly incident?: string };
  readonly updatedBy: string;
  readonly updatedAt: string;
}

export const QA_REVIEW_LIMITS = { taskIds: 50, requiredChecks: 20, checkName: 200, minPeriodMinutes: 15, maxPeriodMinutes: 43_200, sources: 5, policies: 200, openPerProject: 100, perSweep: 25, tasksPerIncident: 25, incidents: 10, incidentPages: 10, page: 20 } as const;

const KIND = "qa-review-policy";
const REQUEST = "qa-review-request";
const INDEX = "qa-review-index";
const SERVICE = "service:qa-review";
const hex = (...parts: string[]): string => createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24);
const bad = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const json = (v: object): JsonObject => JSON.parse(JSON.stringify(v)) as JsonObject;
/** What a project without a policy is: nothing reviews by itself, nothing is added, independent review does not gate completion. */
export const NO_POLICY = (projectId: string): Omit<QaReviewPolicyBody, "updatedBy" | "updatedAt"> => ({ projectId, scope: { workClasses: [], taskIds: [] }, triggers: { onSubmission: false, periodicMinutes: null, onIncident: false }, requiredChecks: [], gatesCompletion: false, independentSources: 1, since: {} });

/** A review (or QA re-check) the scheduler owes: one independent look at one code submission, assigned to an agent that did not work on it. */
export interface QaReviewRequestBody {
  readonly projectId: string;
  readonly taskId: string;
  readonly submissionId: string;
  readonly tree: string;
  /** `submission`: a new code submission; `periodic`: the interval ran out; `incident`: an incident was opened in the project. */
  readonly trigger: "submission" | "periodic" | "incident";
  /** The submission, the period (`p<n>`) or the incident that started it. */
  readonly cause: string;
  /** Absent while no eligible agent exists (the owner is told once; each sweep looks again). */
  readonly assignee?: string;
  readonly state: "open" | "done" | "superseded";
  readonly createdAt: string;
  readonly assignedAt?: string;
  /** When the assignee, or the owner when nobody is eligible, was told (the sweep retries until it is). */
  readonly noticeAt?: string;
  readonly ownerNoticeAt?: string;
  readonly settledAt?: string;
  /** The independent QA evidence that settled it, or the newer code submission that replaced it. */
  readonly settledBy?: string;
}
interface IndexBody { readonly open: readonly string[] }

export interface QaReviewPorts {
  /** The agents that could review work by `workerId` in the project (`AgentService.reviewersAvailableIn`). Never the worker itself; the scheduler also leaves out everyone else who worked on the task. */
  readonly reviewers: (projectId: string, workerId: string) => Promise<readonly string[]>;
  /** Tells the assignee (a principal ID) or the owner (`owner`) about a request. Best effort and repeated until it succeeds; `commandId` is stable for one request and recipient. A contributor is never told. */
  readonly notice?: (n: { readonly commandId: string; readonly to: string; readonly projectId: string; readonly taskId: string; readonly requestId: string; readonly text: string }) => Promise<void>;
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
  workClasses?: ("P" | "PC")[]; taskIds?: string[]; onSubmission?: boolean; periodicMinutes?: number | null; onIncident?: boolean; requiredChecks?: string[]; gatesCompletion?: boolean; independentSources?: number;
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
  for (const k of ["onSubmission", "onIncident", "gatesCompletion"] as const) if (command[k] !== undefined) { if (typeof command[k] !== "boolean") bad(k, "must be true or false"); (out as Record<string, unknown>)[k] = command[k]; }
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
 * - **Settling.** A request is done when independent QA evidence is recorded on its submission after it was made, and superseded when the task's code moved on to a newer submission.
 */
export class QaReviewService {
  readonly #runner: CommandRunner;
  readonly #qa: Pick<QaEvidenceService, "newestCode">;
  readonly #ports: QaReviewPorts;
  private constructor(runner: CommandRunner, qa: Pick<QaEvidenceService, "newestCode">, ports: QaReviewPorts) { this.#runner = runner; this.#qa = qa; this.#ports = ports; }

  static withEpoch(storage: ControllerStorage, epoch: number, qa: Pick<QaEvidenceService, "newestCode">, ports: QaReviewPorts, options: RunnerOptions = {}): QaReviewService {
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

  /** The project's review policy, or what a project with none has. The owner, or an agent that may read the project's tasks. */
  async get(by: Principal, projectIdValue: string): Promise<{ readonly revision: number; readonly item: QaReviewPolicyBody | (Omit<QaReviewPolicyBody, "updatedBy" | "updatedAt"> & { updatedBy?: undefined; updatedAt?: undefined }); readonly isDefault: boolean }> {
    const projectId = checkProjectId(projectIdValue);
    if ((await this.#runner.get("project", projectId)) === undefined || !this.#mayRead(by, projectId)) throw new DomainError("not_found", "no such project");
    const found = await this.#runner.get(KIND, projectId);
    return found === undefined ? { revision: 0, item: NO_POLICY(projectId), isDefault: true } : { revision: found.revision, item: found.body as unknown as QaReviewPolicyBody, isDefault: false };
  }

  /** The owner sets the project's review policy; fields left out stay as they were. Switching a trigger on records when, so work before it is not reviewed backwards. */
  async set(owner: Principal, command: NoActor & Record<string, unknown> & { projectId: string }): Promise<{ revision: number; replayed: boolean }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not change a project's review policy`);
    for (const k of Object.keys(command)) if (!["commandId", "projectId", "workClasses", "taskIds", "onSubmission", "periodicMinutes", "onIncident", "requiredChecks", "gatesCompletion", "independentSources"].includes(k)) bad(k, "is not a field of this command");
    const projectId = checkProjectId(command.projectId);
    const change = checkPolicyChange(command);
    if (Object.keys(change).length === 0) bad("onSubmission", "name what to change: workClasses, taskIds, onSubmission, periodicMinutes, onIncident, requiredChecks, gatesCompletion or independentSources");
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
        const since: { submission?: string; periodic?: string; incident?: string } = {};
        if (triggers.onSubmission) since.submission = before.triggers.onSubmission && before.since.submission !== undefined ? before.since.submission : now;
        if (triggers.periodicMinutes !== null) since.periodic = before.triggers.periodicMinutes === triggers.periodicMinutes && before.since.periodic !== undefined ? before.since.periodic : now;
        if (triggers.onIncident) since.incident = before.triggers.onIncident && before.since.incident !== undefined ? before.since.incident : now;
        const next: QaReviewPolicyBody = {
          projectId, scope: { workClasses: change.workClasses ?? before.scope.workClasses, taskIds: change.taskIds ?? before.scope.taskIds }, triggers,
          requiredChecks: change.requiredChecks ?? before.requiredChecks, gatesCompletion: change.gatesCompletion ?? before.gatesCompletion, independentSources: change.independentSources ?? before.independentSources, since, updatedBy: owner.id, updatedAt: now,
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
      if (by.kind !== "owner" && b.assignee !== by.id) continue;
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
  async sweep(): Promise<QaReviewSweepResult> {
    const total = { projects: 0, created: 0, assigned: 0, settled: 0, superseded: 0, unassigned: 0, errors: 0 };
    let after: string | undefined;
    for (let read = 0; read < 100; read++) {
      const chunk = await this.#runner.list(KIND, { ...(after === undefined ? {} : { afterId: after }), limit: 100 });
      for (const row of chunk) {
        after = row.id;
        if (total.projects >= QA_REVIEW_LIMITS.policies) break;
        total.projects++;
        try {
          const r = await this.#project(row.body as unknown as QaReviewPolicyBody);
          total.created += r.created; total.assigned += r.assigned; total.settled += r.settled; total.superseded += r.superseded; total.unassigned += r.unassigned;
        } catch { total.errors++; }
      }
      if (chunk.length < 100 || total.projects >= QA_REVIEW_LIMITS.policies) break;
    }
    return total;
  }

  async #project(policy: QaReviewPolicyBody): Promise<{ created: number; assigned: number; settled: number; superseded: number; unassigned: number }> {
    const out = { created: 0, assigned: 0, settled: 0, superseded: 0, unassigned: 0 };
    const projectId = policy.projectId;
    const index = await this.#index(projectId);
    const t = policy.triggers;
    if (index.open.length === 0 && !t.onSubmission && t.periodicMinutes === null && !t.onIncident) return out;
    const scan = await this.#qa.newestCode(projectId);
    const newest = new Map(scan.tasks.map((x) => [x.taskId, x] as const));
    const now = this.#runner.now();
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
      const done = await this.#independentEvidence(r);
      if (done !== undefined) { await this.#settle(r, "done", done); open.delete(r.id); out.settled++; continue; }
      const info = newest.get(r.taskId);
      if (info === undefined) continue;
      let current = r;
      if (r.assignee === undefined || !(await this.#stillEligible(r, info))) {
        const pick = await this.#pick(projectId, r.taskId, info, load);
        // An assignee that cannot review any more (it holds the task now, or left the reviewers) is replaced by the next eligible one, or leaves the request waiting with the owner told.
        if (pick !== r.assignee) { current = await this.#assign(r, pick, now); if (pick !== undefined) { load.set(pick, (load.get(pick) ?? 0) + 1); out.assigned++; } open.set(r.id, current); }
      }
      if (current.assignee === undefined) { out.unassigned++; await this.#tell(current, "owner"); } else await this.#tell(current, current.assignee);
    }
    // 2. Create what the triggers name.
    if (!t.onSubmission && t.periodicMinutes === null && !t.onIncident) return out;
    const wanted: { taskId: string; trigger: QaReviewRequestBody["trigger"]; cause: string }[] = [];
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
      for (const incident of await this.#openIncidents(projectId, policy.since.incident)) for (const x of eligible.slice(0, QA_REVIEW_LIMITS.tasksPerIncident)) wanted.push({ taskId: x.taskId, trigger: "incident", cause: incident });
    }
    const owed = new Set([...open.values()].map((r) => r.submissionId));
    let made = 0;
    for (const w of wanted) {
      if (made >= QA_REVIEW_LIMITS.perSweep || open.size >= QA_REVIEW_LIMITS.openPerProject) break;
      const info = newest.get(w.taskId)!;
      // A submission that already has an open review is not asked for twice, whichever trigger came second.
      if (owed.has(info.submissionId)) continue;
      const id = `qrr-${hex(projectId, w.taskId, info.submissionId, w.trigger, w.cause)}`;
      if ((await this.#runner.get(REQUEST, id)) !== undefined) continue;
      const assignee = await this.#pick(projectId, w.taskId, info, load);
      const body: QaReviewRequestBody = { projectId, taskId: w.taskId, submissionId: info.submissionId, tree: info.tree, trigger: w.trigger, cause: w.cause, ...(assignee === undefined ? {} : { assignee, assignedAt: now }), state: "open", createdAt: now };
      if (!(await this.#create(id, body))) continue;
      made++; out.created++; owed.add(info.submissionId);
      if (assignee !== undefined) { load.set(assignee, (load.get(assignee) ?? 0) + 1); await this.#tell({ ...body, id }, assignee); } else { out.unassigned++; await this.#tell({ ...body, id }, "owner"); }
      open.set(id, { ...body, id, revision: 0 });
    }
    return out;
  }

  /** The open incidents of the project that started after `since`, newest first, at most `QA_REVIEW_LIMITS.incidents`. */
  async #openIncidents(projectId: string, since: string): Promise<string[]> {
    const found: { id: string; at: string }[] = [];
    let after: string | undefined;
    for (let page = 0; page < QA_REVIEW_LIMITS.incidentPages; page++) {
      const chunk = await this.#runner.list("responsibility-incident", { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const row of chunk) {
        after = row.id;
        const b = row.body as unknown as IncidentBody;
        if (b.projectId === projectId && b.state === "open" && b.firstAt >= since) found.push({ id: row.id, at: b.firstAt });
      }
      if (chunk.length < 200) break;
    }
    return found.sort((a, b) => (a.at > b.at ? -1 : a.at < b.at ? 1 : a.id < b.id ? -1 : 1)).slice(0, QA_REVIEW_LIMITS.incidents).map((x) => x.id);
  }

  /** Eligible reviewers for a task, least loaded first: never the submitters of its code, never the agent that holds it now. */
  async #pick(projectId: string, taskId: string, info: { submittedBy: string; contributors: readonly string[] }, load: ReadonlyMap<string, number>): Promise<string | undefined> {
    const assignment = (await this.#runner.get("assignment", assignmentIdOf(taskId)))?.body as { owner?: { id?: string } } | undefined;
    const excluded = new Set([...info.contributors, info.submittedBy, ...(assignment?.owner?.id === undefined ? [] : [principalOf(assignment.owner.id)])].map(principalOf));
    const pool = (await this.#ports.reviewers(projectId, info.submittedBy)).filter((r) => !excluded.has(principalOf(r)));
    pool.sort((a, b) => (load.get(a) ?? 0) - (load.get(b) ?? 0) || (a < b ? -1 : a > b ? 1 : 0));
    return pool[0];
  }

  async #stillEligible(r: QaReviewRequestBody, info: { submittedBy: string; contributors: readonly string[] }): Promise<boolean> {
    if (r.assignee === undefined) return false;
    const pool = await this.#ports.reviewers(r.projectId, info.submittedBy);
    const assignment = (await this.#runner.get("assignment", assignmentIdOf(r.taskId)))?.body as { owner?: { id?: string } } | undefined;
    const excluded = new Set([...info.contributors, ...(assignment?.owner?.id === undefined ? [] : [assignment.owner.id])].map(principalOf));
    return pool.includes(r.assignee) && !excluded.has(principalOf(r.assignee));
  }

  /** Independent QA evidence recorded on the request's submission after the request was made: its ID. */
  async #independentEvidence(r: QaReviewRequestBody): Promise<string | undefined> {
    const ids = ((await this.#runner.get("qa-evidence-index", r.taskId))?.body as unknown as { ids?: string[] } | undefined)?.ids ?? [];
    for (const id of [...ids].reverse().slice(0, 100)) {
      const e = (await this.#runner.get("qa-evidence", id))?.body as unknown as QaEvidenceBody | undefined;
      if (e !== undefined && e.submissionId === r.submissionId && e.source === "independent" && e.recordedAt >= r.createdAt) return id;
    }
    return undefined;
  }

  async #create(id: string, body: QaReviewRequestBody): Promise<boolean> {
    try {
      await this.#runner.command("qa.review.request", { commandId: `qrr:${id}`, actor: SERVICE }, async () => ({
        payload: { id },
        build: async (): Promise<Built> => {
          const index = await this.#index(body.projectId);
          const ref = { kind: REQUEST, id };
          const next = json({ open: [...index.open.filter((x) => x !== id), id] });
          const changes: Change[] = [{ type: "create", ref, body: json(body) }, index.revision === undefined ? { type: "create", ref: { kind: INDEX, id: body.projectId }, body: next } : { type: "update", ref: { kind: INDEX, id: body.projectId }, expectedRevision: index.revision, body: next }];
          return { ref, creates: true, changes, detail: { projectId: body.projectId, taskId: body.taskId, trigger: body.trigger } };
        },
      }));
      return true;
    } catch (error) {
      // Another controller made it first, or the index moved: the next round looks again.
      if (error instanceof DomainError && (error.code === "command_conflict" || error.code === "stale_revision")) return false;
      throw error;
    }
  }

  async #assign(r: QaReviewRequestBody & { id: string; revision: number }, assignee: string | undefined, now: string): Promise<QaReviewRequestBody & { id: string; revision: number }> {
    const { noticeAt: _n, ownerNoticeAt: _o, assignee: _a, assignedAt: _t, ...kept } = r;
    const next = { ...kept, ...(assignee === undefined ? {} : { assignee, assignedAt: now }) };
    const result = await this.#runner.command("qa.review.assign", { commandId: `qrr-assign:${r.id}:${assignee ?? "none"}:${now}`, actor: SERVICE }, async () => ({
      payload: { id: r.id, assignee: assignee ?? null },
      build: async (): Promise<Built> => {
        const found = await this.#runner.get(REQUEST, r.id);
        if (found === undefined) throw new DomainError("not_found", "no such request");
        const cur = found.body as unknown as QaReviewRequestBody;
        if (cur.state !== "open") throw new DomainError("stale_revision", "the request was settled meanwhile");
        const { noticeAt: _a1, ownerNoticeAt: _b1, assignee: _c1, assignedAt: _d1, ...base } = cur;
        const ref = { kind: REQUEST, id: r.id };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: json({ ...base, ...(assignee === undefined ? {} : { assignee, assignedAt: now }) }) }], detail: { id: r.id } };
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
    const words = to === "owner"
      ? `Nobody can review task ${r.taskId}'s code ${r.submissionId} independently (${r.trigger} review): the agents that could have worked on it. Add a reviewer agent to the project or review it yourself.`
      : `You are asked to review task ${r.taskId}'s code ${r.submissionId} independently (${r.trigger} review of tree ${r.tree.slice(0, 12)}): record QA evidence on it (qa.evidence.record).`;
    try {
      await this.#ports.notice({ commandId: `qrr-note:${r.id}:${to}`, to, projectId: r.projectId, taskId: r.taskId, requestId: r.id, text: words.slice(0, 600) });
      await this.#runner.command("qa.review.noticed", { commandId: `qrr-noticed:${r.id}:${to}`, actor: SERVICE }, async () => ({
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
