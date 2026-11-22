import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { commandId as checkCommandId, projectId as checkProjectId, taskId as checkTaskId, text, type TaskBody } from "../domain/model.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { relianceIdOf, type OwnerDecisionBody, type RelianceBody } from "../decisions/records.js";
import { allows, inTaskScope } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { Change, ControllerStorage, JsonObject } from "../storage/types.js";
import { CONTRACT_WORK_FIELDS } from "./acceptance.js";
import type { RolesOf, SubmissionBody } from "./submissions.js";

/** The four results a QA check can have (card Q02). They are kept apart: only `passed` passes; `failed`, `blocked` (could not be run: an environment or a dependency was missing) and `not-run` each fail the gate and are counted separately. */
export const QA_RESULTS = ["passed", "failed", "blocked", "not-run"] as const;
export type QaResult = (typeof QA_RESULTS)[number];

export interface QaCheck { readonly name: string; readonly result: QaResult; readonly detail?: string }
export interface QaDecisionRef { readonly id: string; readonly version: number; readonly topic: string }

/** Why a QA evidence record no longer holds: what it was bound to has changed since it was recorded. */
export type QaStaleReason =
  | { readonly kind: "criteria_changed"; readonly from: number; readonly to: number; readonly fields: readonly string[] }
  | { readonly kind: "criteria_unknown"; readonly from: number; readonly to: number }
  | { readonly kind: "decision_superseded"; readonly decisionId: string; readonly state: string }
  | { readonly kind: "decision_not_cited"; readonly decisionId: string };

export interface QaEvidenceBody {
  readonly taskId: string;
  readonly projectId: string;
  /** The code submission checked, and the tree it names: the exact version the checks ran on. */
  readonly submissionId: string;
  readonly tree: string;
  /** `self` when the author of the submission recorded it (a self-check: kept, never counted by the gate); `independent` for the owner or a qa or reviewer agent that did not submit the work. */
  readonly source: "self" | "independent";
  /** The task contract version (acceptance criteria, required evidence, checks) in force when it was recorded. */
  readonly criteriaRevision: number;
  /** The owner decisions it was judged against, each with the version it had. */
  readonly decisions: readonly QaDecisionRef[];
  readonly environment: string;
  /** When the checks ran (given by the recorder, not after the record) and when the controller recorded them. */
  readonly observedAt: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
  readonly checks: readonly QaCheck[];
  readonly state: "current" | "invalidated";
  readonly invalidatedAt?: string;
  readonly invalidatedBy?: string;
  readonly reasons?: readonly QaStaleReason[];
  /** The re-check scheduled when it was invalidated. */
  readonly recheckId?: string;
}

export interface QaRecheckBody {
  readonly taskId: string;
  readonly projectId: string;
  readonly evidenceId: string;
  readonly submissionId: string;
  readonly tree: string;
  readonly reasons: readonly QaStaleReason[];
  /** Who recorded the evidence that went stale: the agent expected to check again (the owner or any other qa or reviewer agent may do it instead). */
  readonly assignee: string;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly state: "pending" | "done";
  /**
   * The evidence for the same submission that settled it (independent evidence, or the author's new self-check for a re-check of a self-check), once it, with the other evidence of that source on the
   * submission that still holds, names again every check the invalidated record named (only those still required, when the contract names checks).
   */
  readonly doneBy?: string;
  readonly doneAt?: string;
  /** Settled because the author submitted a newer tree of the task: the newer code submission. The old tree is no longer the work, and the newer one is judged on its own evidence. */
  readonly supersededBy?: string;
}

interface IndexBody { readonly ids: readonly string[]; readonly rechecks: readonly string[] }

export interface QaGateCheck { readonly name: string; readonly result: QaResult | "missing"; readonly evidenceId?: string }
export interface QaGate {
  readonly taskId: string;
  readonly submissionId: string;
  readonly tree: string;
  readonly verdict: "passed" | "failed";
  /** Why it failed, in short codes: `no_evidence`, `stale_evidence`, `decision_superseded`, `check_failed`, `check_blocked`, `check_not_run`, `check_missing`. */
  readonly reasons: readonly string[];
  /** The task contract version and the owner decisions this verdict stands on. */
  readonly criteriaRevision: number;
  readonly decisions: readonly QaDecisionRef[];
  readonly required: readonly string[];
  readonly checks: readonly QaGateCheck[];
  readonly counts: { readonly passed: number; readonly failed: number; readonly blocked: number; readonly notRun: number; readonly missing: number };
  /** Independent evidence for this submission that no longer holds, with why. */
  readonly stale: readonly { readonly id: string; readonly reasons: readonly QaStaleReason[] }[];
  readonly pendingRechecks: readonly string[];
}

/** One task's newest code submission and where it stands with QA (the project QA view). */
export interface QaProjectItem {
  readonly taskId: string;
  readonly title: string;
  readonly submissionId: string;
  readonly tree: string;
  readonly submittedAt: string;
  readonly state: "passes" | "waiting" | "stale" | "failing";
  readonly reasons: readonly string[];
  readonly counts: QaGate["counts"];
  readonly pendingRechecks: readonly string[];
}
export interface QaProjectView {
  readonly projectId: string;
  readonly counts: { readonly passes: number; readonly waiting: number; readonly stale: number; readonly failing: number };
  readonly items: readonly QaProjectItem[];
  readonly truncated: boolean;
  readonly scanLimited: boolean;
}

/** A re-check of the submission that new evidence did not settle: the checks the invalidated record named that no evidence of that source on the submission names again yet. */
export interface QaOpenRecheck { readonly id: string; readonly missing: readonly string[] }

/** What the QA evidence service needs from the rest of the controller. */
export interface QaEvidencePorts {
  readonly rolesOf: RolesOf;
  /** Tells the owner that evidence was invalidated and a re-check scheduled. Best effort: a failure never undoes the invalidation. */
  readonly notify?: (notice: { readonly commandId: string; readonly taskId: string; readonly projectId: string; readonly recheckId: string; readonly text: string }) => Promise<void>;
  /**
   * Called after evidence is recorded, also for a repeat of the same command (so work a crash cut short after the record is done on the repeat), never for a refused one (card Q03: the documents of the task are
   * checked against the new evidence). Best effort: a failure never undoes the record and is not the recorder's error; the port reports its own failures.
   */
  readonly recorded?: (e: { readonly evidenceId: string; readonly taskId: string; readonly projectId: string; readonly submissionId: string; readonly source: "self" | "independent" }) => Promise<void>;
  /** Called after `check` invalidated evidence (not for a repeat, which invalidated nothing new), with each record invalidated. Best effort, like `recorded`. */
  readonly invalidated?: (e: { readonly taskId: string; readonly projectId: string; readonly evidence: readonly { readonly evidenceId: string; readonly submissionId: string }[] }) => Promise<void>;
}

/** A record a gate verdict was read from, at the revision read: a write that binds the verdict checks each is still there (card Q03: `doc.obligation.verify`). */
export interface QaGateRead { readonly kind: string; readonly id: string; readonly revision: number }

const SBM = /^sbm-[a-z2-7]{20}$/;
const QAE = /^qae-[a-z2-7]{20}$/;
const DEC = /^dec-[a-z2-7]{20}$/;
const TREE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** Roles whose holders check other agents' work independently. Holding the role is not enough: the agent must also be able to read the task. */
const CHECKERS = ["qa", "reviewer"] as const;
/** The notification store keeps at most this much detail text. */
const NOTICE_CHARS = 200;
/** The QA service as the actor of a check it starts itself (`contractChanged`). It holds no grants and is never a caller of any operation. */
const QA_SERVICE = { id: "service:qa-evidence", kind: "service", name: "qa-evidence", grants: [] } as unknown as Principal;
export const QA_LIMITS = { perTask: 200, checks: 50, checkName: 200, detail: 2000, environment: 500, decisions: 20, skewMs: 5 * 60 * 1000, projectTasks: 200, projectScanReads: 20 } as const;

const bad = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const hidden = (what: string): never => { throw new DomainError("not_found", `no such ${what}`); };
const json = (v: object): JsonObject => JSON.parse(JSON.stringify(v)) as JsonObject;
const work = (c: Record<string, unknown> | undefined): Record<string, unknown> => ({ acceptanceCriteria: [], requiredEvidence: [], checks: [], ...(c ?? {}) });

/**
 * QA evidence bound to the exact version checked (card Q02, first slice). A record names one code submission (and so its tree), the task contract version and the owner decisions it was judged
 * against, the environment, when the checks ran, and each check with one of four results kept apart: passed, failed, blocked and not-run.
 *
 * - **Who.** The owner, or an agent holding the qa or reviewer role in the project that may read the task (the role alone opens nothing). The agent that submitted the code may record a self-check;
 *   it is kept and shown, never counted by the gate.
 * - **Bound to what it was judged on.** The contract version named must be the one in force, every decision named must be active and apply to the task, and every decision the task relies on
 *   (`decision.link`) must be named; a task relying on a superseded decision cannot be checked until it is revalidated (card C08).
 * - **Gate.** `gate` passes only when every required check (the contract's check names and required evidence items; with none, every check named in any current independent record, or in independent
 *   evidence that no longer holds and is not yet re-checked) has a `passed` result in current independent evidence for that submission. Missing evidence fails, and so does evidence whose criteria or
 *   decisions changed since.
 * - **Invalidation.** `check` compares every current record of a task with what it was bound to; one whose acceptance criteria, required evidence or checks changed, or whose decisions were
 *   superseded, or that misses a decision the task now relies on, is invalidated (kept, with the reasons) and a re-check is scheduled for it, and the owner is told. New independent evidence
 *   for the same submission that names its checks again settles the re-check; so does a newer code submission of the task (`submitted`). A check that loses a race with another answers with
 *   what the other invalidated.
 */
export class QaEvidenceService {
  readonly #runner: CommandRunner;
  readonly #ports: QaEvidencePorts;
  private constructor(runner: CommandRunner, ports: QaEvidencePorts) { this.#runner = runner; this.#ports = ports; }

  static withEpoch(storage: ControllerStorage, epoch: number, ports: QaEvidencePorts, options: RunnerOptions = {}): QaEvidenceService {
    return new QaEvidenceService(new CommandRunner(storage, epoch, options), ports);
  }

  // ---- reading the records it is bound to -------------------------------------------------------------------------------------

  async #task(taskId: string): Promise<TaskBody | undefined> { return (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined; }

  /** Whether the principal may read the task: the owner, or an agent with the task read right (and inside its task scope). */
  #reads(by: Principal, task: TaskBody, taskId: string): boolean {
    if (by.kind === "owner") return true;
    if (by.kind !== "agent") return false;
    if (by.taskScope !== undefined && (!inTaskScope(by, task.projectId) || by.taskScope.taskId !== taskId)) return false;
    return allows(by, "task.read", task.projectId, { resource: { kind: "task", id: taskId } });
  }

  async #readable(by: Principal, taskIdValue: unknown): Promise<{ taskId: string; task: TaskBody }> {
    const taskId = checkTaskId(taskIdValue);
    const task = await this.#task(taskId);
    if (task === undefined || !this.#reads(by, task, taskId)) return hidden("task");
    return { taskId, task: task! };
  }

  /** The code submission and its task, read with the task's read right first: a submission of a task the caller may not read is not found, whatever its kind. */
  async #submission(by: Principal, id: unknown, field = "submissionId"): Promise<{ sub: SubmissionBody & { tree: string }; taskId: string; task: TaskBody }> {
    if (typeof id !== "string" || !SBM.test(id)) bad(field, "is not a submission ID");
    const s = (await this.#runner.get("submission", id as string))?.body as unknown as SubmissionBody | undefined;
    if (s === undefined) return hidden("submission");
    const { taskId, task } = await this.#readable(by, s!.taskId);
    if (s!.kind !== "code" || s!.tree === undefined || !TREE.test(s!.tree)) bad(field, "QA evidence is recorded on a code submission, which names the tree checked");
    return { sub: s as SubmissionBody & { tree: string }, taskId, task };
  }

  async #contract(taskId: string): Promise<{ version: number; body: Record<string, unknown> | undefined; revision?: number }> {
    const found = await this.#runner.get("task-contract", taskId);
    const body = found?.body as unknown as (Record<string, unknown> & { version?: number }) | undefined;
    return { version: body?.version ?? 0, body, ...(found === undefined ? {} : { revision: found.revision }) };
  }

  /** The names the gate requires: the contract's check names and its required evidence items, in that order, without repeats. */
  #required(contract: Record<string, unknown> | undefined): string[] {
    const names: string[] = [];
    for (const c of (contract?.["checks"] as { name?: unknown }[] | undefined) ?? []) if (typeof c?.name === "string" && !names.includes(c.name)) names.push(c.name);
    for (const e of (contract?.["requiredEvidence"] as unknown[] | undefined) ?? []) if (typeof e === "string" && !names.includes(e)) names.push(e);
    return names;
  }

  async #reliance(taskId: string, reads?: QaGateRead[]): Promise<RelianceBody | undefined> {
    const found = await this.#runner.get("decision-reliance", relianceIdOf(taskId));
    if (found !== undefined) reads?.push({ kind: "decision-reliance", id: relianceIdOf(taskId), revision: found.revision });
    return found?.body as unknown as RelianceBody | undefined;
  }

  /** What changed since the record was made: its criteria (only the fields that say what the work must be) and its decisions. Empty: it still holds. */
  async #staleness(e: QaEvidenceBody, now: { version: number; body: Record<string, unknown> | undefined }, reliance: RelianceBody | undefined, reads?: QaGateRead[]): Promise<QaStaleReason[]> {
    const reasons: QaStaleReason[] = [];
    if (e.criteriaRevision !== now.version) {
      const then = e.criteriaRevision === 0 ? {} : ((await this.#runner.get("task-contract-version", `${e.taskId}.${e.criteriaRevision}`))?.body as unknown as Record<string, unknown> | undefined);
      if (then === undefined || e.criteriaRevision > now.version) reasons.push({ kind: "criteria_unknown", from: e.criteriaRevision, to: now.version });
      else {
        const a = work(then), b = work(now.body);
        const fields = CONTRACT_WORK_FIELDS.filter((f) => JSON.stringify(a[f] ?? null) !== JSON.stringify(b[f] ?? null));
        if (fields.length > 0) reasons.push({ kind: "criteria_changed", from: e.criteriaRevision, to: now.version, fields });
      }
    }
    for (const d of e.decisions) {
      const record = await this.#runner.get("decision", d.id);
      if (record !== undefined) reads?.push({ kind: "decision", id: d.id, revision: record.revision });
      const found = record?.body as unknown as OwnerDecisionBody | undefined;
      if (found === undefined || found.state !== "active" || found.version !== d.version) reasons.push({ kind: "decision_superseded", decisionId: d.id, state: found?.state ?? "missing" });
    }
    for (const l of reliance?.links ?? []) {
      if (e.decisions.some((d) => d.id === l.decisionId)) continue;
      if (reasons.some((r) => r.kind !== "criteria_changed" && r.kind !== "criteria_unknown" && r.decisionId === l.decisionId)) continue;
      reasons.push(l.state === "current" ? { kind: "decision_not_cited", decisionId: l.decisionId } : { kind: "decision_superseded", decisionId: l.decisionId, state: "superseded" });
    }
    return reasons;
  }

  async #index(taskId: string): Promise<{ revision?: number; body: IndexBody }> {
    const found = await this.#runner.get("qa-evidence-index", taskId);
    return { ...(found === undefined ? {} : { revision: found.revision }), body: (found?.body as unknown as IndexBody | undefined) ?? { ids: [], rechecks: [] } };
  }

  // ---- recording -------------------------------------------------------------------------------------------------------------

  /**
   * Records QA evidence on one code submission. `criteriaRevision` must be the task contract version in force (a stale one is `stale_revision` with the current version); `decisions` names the
   * owner decisions the work was judged against and must include every decision the task relies on.
   */
  async record(by: Principal, command: NoActor & { submissionId: string; criteriaRevision: number; decisions?: readonly string[]; environment: string; observedAt: string; checks: readonly { name: string; result: string; detail?: string }[] }): Promise<{ id: string; revision: number; replayed: boolean; source: "self" | "independent"; settled: readonly string[]; open: readonly QaOpenRecheck[] }> {
    if (command === null || typeof command !== "object") throw new DomainError("invalid_command", "a command is an object");
    for (const k of Object.keys(command)) if (!["commandId", "submissionId", "criteriaRevision", "decisions", "environment", "observedAt", "checks"].includes(k)) bad(k, "is not a field of this command");
    const commandId = checkCommandId(command.commandId);
    if (typeof command.submissionId !== "string" || !SBM.test(command.submissionId)) bad("submissionId", "is not a submission ID");
    if (!Number.isSafeInteger(command.criteriaRevision) || command.criteriaRevision < 0) bad("criteriaRevision", "must be the task contract version you checked against (0 when it has none)");
    const decisions = command.decisions === undefined ? [] : command.decisions;
    if (!Array.isArray(decisions) || decisions.length > QA_LIMITS.decisions || decisions.some((d) => typeof d !== "string" || !DEC.test(d)) || new Set(decisions).size !== decisions.length) bad("decisions", `must be a list of at most ${QA_LIMITS.decisions} different decision IDs`);
    const environment = text(command.environment, "environment", { min: 1, max: QA_LIMITS.environment, multiline: true });
    const observedAt = text(command.observedAt, "observedAt", { min: 20, max: 30 });
    const ms = Date.parse(observedAt);
    if (!Number.isFinite(ms) || new Date(ms).toISOString() !== observedAt) bad("observedAt", "must be a UTC time like 2026-11-18T12:00:00.000Z");
    if (!Array.isArray(command.checks) || command.checks.length < 1 || command.checks.length > QA_LIMITS.checks) bad("checks", `must list 1 to ${QA_LIMITS.checks} checks`);
    const names = new Set<string>();
    const checks: QaCheck[] = command.checks.map((raw, i) => {
      const o = raw as unknown as Record<string, unknown> | null;
      if (o === null || typeof o !== "object" || Array.isArray(o)) return bad(`checks[${i}]`, "must be an object");
      for (const k of Object.keys(o)) if (!["name", "result", "detail"].includes(k)) bad(`checks[${i}].${k}`, "is not a field of a check");
      const name = text(o["name"], `checks[${i}].name`, { min: 1, max: QA_LIMITS.checkName, multiline: true });
      if (names.has(name)) bad(`checks[${i}].name`, `${JSON.stringify(name)} is listed twice`);
      names.add(name);
      if (!(QA_RESULTS as readonly unknown[]).includes(o["result"])) bad(`checks[${i}].result`, `must be one of ${QA_RESULTS.join(", ")}`);
      const detail = o["detail"] === undefined ? undefined : text(o["detail"], `checks[${i}].detail`, { min: 1, max: QA_LIMITS.detail, multiline: true });
      return { name, result: o["result"] as QaResult, ...(detail === undefined ? {} : { detail: redactText(detail) }) };
    });
    if (by.kind !== "owner" && by.kind !== "agent") throw new DomainError("forbidden", `${by.id} may not record QA evidence`);
    let outcome: { source: "self" | "independent"; settled: string[]; open: QaOpenRecheck[] } = { source: "independent", settled: [], open: [] };
    const scoped = scopedCommandId(by.id, commandId);
    const id = derivedId("qae", scoped);
    const result = await this.#runner.command("qa.evidence.record", { commandId: scoped, actor: by.id }, async () => ({
      payload: { submissionId: command.submissionId, criteriaRevision: command.criteriaRevision, decisions: [...decisions as string[]], environment, observedAt, checks: json(checks) as unknown as JsonObject },
      build: async () => {
        const { sub, taskId, task } = await this.#submission(by, command.submissionId);
        if (task.state === "cancelled") throw new DomainError("invalid_command", "the task is cancelled");
        if (ms > Date.parse(this.#runner.now()) + QA_LIMITS.skewMs) bad("observedAt", "is in the future");
        const self = by.id === sub.submittedBy;
        if (by.kind === "agent" && !self) {
          const roles = await this.#ports.rolesOf(by.id, { projectId: task.projectId, taskId }, by);
          if (!CHECKERS.some((r) => roles.includes(r))) throw new DomainError("forbidden", `${by.id} holds neither the qa nor the reviewer role in this project`);
        }
        const contract = await this.#contract(taskId);
        if (contract.version !== command.criteriaRevision) throw new DomainError("stale_revision", `the task contract is at version ${contract.version}, not ${command.criteriaRevision}: read its acceptance criteria and check against them`, { currentRevision: contract.version });
        const changes: Change[] = [];
        const cited: QaDecisionRef[] = [];
        for (const d of decisions as string[]) {
          const found = await this.#runner.get("decision", d);
          const body = found?.body as unknown as OwnerDecisionBody | undefined;
          if (found === undefined || body === undefined || body.projectId !== task.projectId || (body.taskId !== undefined && body.taskId !== taskId)) bad("decisions", `${d} is not a decision of this task or its project`);
          if (body!.state !== "active") bad("decisions", `${d} is ${body!.state}${body!.supersededBy === undefined ? "" : ` (the current one is ${body!.supersededBy})`}: evidence is judged against the decisions in force`);
          cited.push({ id: d, version: body!.version, topic: body!.topic });
          changes.push({ type: "check", ref: { kind: "decision", id: d }, expectedRevision: found!.revision });
        }
        const reliance = await this.#reliance(taskId);
        for (const l of reliance?.links ?? []) {
          if (l.state !== "current") bad("decisions", `the task relies on decision ${l.decisionId}, which was superseded: the work is revalidated against the current decision (decision.revalidate) before it is checked`);
          if (!cited.some((c) => c.id === l.decisionId)) bad("decisions", `the task relies on decision ${l.decisionId}: name it`);
        }
        const index = await this.#index(taskId);
        if (index.body.ids.length >= QA_LIMITS.perTask) throw new DomainError("unavailable", `a task holds at most ${QA_LIMITS.perTask} QA evidence records`);
        const now = this.#runner.now();
        const source = self ? "self" : "independent";
        const body: QaEvidenceBody = { taskId, projectId: task.projectId, submissionId: command.submissionId, tree: sub.tree, source, criteriaRevision: contract.version, decisions: cited, environment: redactText(environment), observedAt, recordedBy: by.id, recordedAt: now, checks, state: "current" };
        // What this record and the other evidence of the same source on the submission that still holds name: a re-check is settled only when they name again every check the invalidated
        // record named (those still required, when the contract names checks), so a narrower re-check does not pass on fewer checks than were looked at before.
        const required = this.#required(contract.body);
        const covered = new Set(checks.map((c) => c.name));
        for (const other of index.body.ids) {
          const e = (await this.#runner.get("qa-evidence", other))?.body as unknown as QaEvidenceBody | undefined;
          if (e === undefined || e.state !== "current" || e.submissionId !== command.submissionId || e.source !== source || (source === "self" && e.recordedBy !== by.id)) continue;
          if ((await this.#staleness(e, contract, reliance)).length === 0) for (const c of e.checks) covered.add(c.name);
        }
        const settled: string[] = [];
        const open: QaOpenRecheck[] = [];
        const rechecks: string[] = [];
        for (const r of index.body.rechecks) {
          const found = await this.#runner.get("qa-recheck", r);
          const rb = found?.body as unknown as QaRecheckBody | undefined;
          if (found === undefined || rb === undefined) continue;
          // Done re-checks stay listed (at most one per evidence record, so the index stays bounded).
          rechecks.push(r);
          if (rb.state !== "pending") continue;
          if (rb.submissionId !== command.submissionId) {
            // A re-check on an older code submission of the task is settled by the newer tree (card Q02 follow-up): the old tree is no longer the work. Normally the submission itself settles it
            // (`submitted`, best effort after the submission is recorded); this catches one that was missed.
            const older = (await this.#runner.get("submission", rb.submissionId))?.body as unknown as SubmissionBody | undefined;
            if (older !== undefined && older.submittedAt < sub.submittedAt) {
              settled.push(r);
              changes.push({ type: "update", ref: { kind: "qa-recheck", id: r }, expectedRevision: found.revision, body: json({ ...rb, state: "done", doneAt: now, supersededBy: command.submissionId }) });
            }
            continue;
          }
          // Independent evidence may settle every pending re-check of the submission; the author's new self-check only the re-check of its own earlier self-check.
          if (source !== "independent" && rb.assignee !== by.id) continue;
          const before = (await this.#runner.get("qa-evidence", rb.evidenceId))?.body as unknown as QaEvidenceBody | undefined;
          const missing = (before?.checks ?? []).map((c) => c.name).filter((name) => (required.length === 0 || required.includes(name)) && !covered.has(name));
          if (missing.length > 0) { open.push({ id: r, missing }); continue; }
          settled.push(r);
          changes.push({ type: "update", ref: { kind: "qa-recheck", id: r }, expectedRevision: found.revision, body: json({ ...rb, state: "done", doneBy: id, doneAt: now }) });
        }
        if (contract.revision !== undefined) changes.push({ type: "check", ref: { kind: "task-contract", id: taskId }, expectedRevision: contract.revision });
        const nextIndex = json({ ids: [...index.body.ids, id], rechecks });
        changes.push(index.revision === undefined ? { type: "create", ref: { kind: "qa-evidence-index", id: taskId }, body: nextIndex } : { type: "update", ref: { kind: "qa-evidence-index", id: taskId }, expectedRevision: index.revision, body: nextIndex });
        outcome = { source, settled, open };
        return {
          ref: { kind: "qa-evidence", id }, creates: true, changes: [{ type: "create", ref: { kind: "qa-evidence", id }, body: json(body) }, ...changes], detail: { taskId, submissionId: command.submissionId, source, settled },
          // A lost race on the index, a re-check or a cited record is another write of this task's QA records at the same moment, not a reused command ID.
          contention: async () => ((await this.#runner.get("qa-evidence", id)) === undefined ? new DomainError("unavailable", "another QA write of this task was made at the same moment; send this one again") : new DomainError("command_conflict", `qa-evidence ${id} already exists, so this command ID was used by something else`)),
        };
      },
    }));
    if (result.replayed) {
      const e = (await this.#runner.get("qa-evidence", result.id))?.body as unknown as QaEvidenceBody | undefined;
      outcome = { source: e?.source ?? "independent", settled: [], open: [] };
    }
    if (this.#ports.recorded !== undefined) {
      const e = (await this.#runner.get("qa-evidence", result.id))?.body as unknown as QaEvidenceBody | undefined;
      if (e !== undefined) await this.#ports.recorded({ evidenceId: result.id, taskId: e.taskId, projectId: e.projectId, submissionId: e.submissionId, source: e.source }).catch(() => undefined);
    }
    return { id: result.id, revision: result.revision, replayed: result.replayed, source: outcome.source, settled: outcome.settled, open: outcome.open };
  }

  // ---- invalidation and re-checks ----------------------------------------------------------------------------------------------

  /**
   * Looks at every current QA record of a task against what it was bound to. A record whose criteria or decisions changed is invalidated (kept, with the reasons) and a re-check is scheduled for
   * it, assigned to whoever recorded it; the owner is told. Anyone who may read the task may ask; what changed decides, not who asks. Nothing stale: nothing is written.
   */
  async check(by: Principal, command: NoActor & { taskId: string }): Promise<{ taskId: string; invalidated: readonly string[]; rechecks: readonly string[]; replayed: boolean; concurrent?: true }> {
    if (command === null || typeof command !== "object") throw new DomainError("invalid_command", "a command is an object");
    for (const k of Object.keys(command)) if (!["commandId", "taskId"].includes(k)) bad(k, "is not a field of this command");
    const commandId = checkCommandId(command.commandId);
    const { taskId } = await this.#readable(by, command.taskId);
    return this.#checkTask(by, commandId, taskId);
  }

  /**
   * Card Q02 (fourth slice): told by the controller, best effort, after a task's contract is changed through `contract.set`. The task's QA evidence is looked at at once, as `check` would, by the
   * QA service itself (no caller's rights are involved: what changed decides, not who changed it), so a changed acceptance criterion, check or required evidence item invalidates the evidence and
   * schedules its re-check without anyone having to ask. The command ID names the contract version and the state of the task's evidence index, so each change is looked at once, a repeat of
   * the same notice writes nothing, and a record added after a check is looked at by the next one. Nothing stale: nothing is written.
   */
  async contractChanged(taskIdValue: string): Promise<{ taskId: string; invalidated: readonly string[]; rechecks: readonly string[] }> {
    const taskId = checkTaskId(taskIdValue);
    if (await this.#task(taskId) === undefined) return { taskId, invalidated: [], rechecks: [] };
    const contract = await this.#contract(taskId);
    const index = await this.#index(taskId);
    if (index.body.ids.length === 0) return { taskId, invalidated: [], rechecks: [] };
    const r = await this.#checkTask(QA_SERVICE, `qa-auto-${contract.version}-${index.revision ?? 0}-${taskId}`, taskId);
    return { taskId, invalidated: r.invalidated, rechecks: r.rechecks };
  }

  /**
   * Card Q02 (fifth slice): told by the decision service, best effort, when an owner decision that a task relies on was superseded, disputed or resolved (the propagation pass reaches the task). The task's QA
   * evidence is looked at at once, as `check` would, by the QA service itself, so evidence judged against a decision that no longer stands is invalidated and its re-check scheduled without anyone asking. Same
   * rules as `contractChanged` (a task with no evidence is not read further; nothing stale writes nothing; each state of the evidence index is looked at once), under its own command ID prefix.
   */
  async decisionChanged(taskIdValue: string): Promise<{ taskId: string; invalidated: readonly string[]; rechecks: readonly string[] }> {
    const taskId = checkTaskId(taskIdValue);
    if (await this.#task(taskId) === undefined) return { taskId, invalidated: [], rechecks: [] };
    const contract = await this.#contract(taskId);
    const index = await this.#index(taskId);
    if (index.body.ids.length === 0) return { taskId, invalidated: [], rechecks: [] };
    const r = await this.#checkTask(QA_SERVICE, `qa-dec-${contract.version}-${index.revision ?? 0}-${taskId}`, taskId);
    return { taskId, invalidated: r.invalidated, rechecks: r.rechecks };
  }

  async #checkTask(by: Principal, commandId: string, taskId: string): Promise<{ taskId: string; invalidated: readonly string[]; rechecks: readonly string[]; replayed: boolean; concurrent?: true }> {
    let made: { invalidated: string[]; rechecks: { id: string; projectId: string; text: string }[]; evidence: { evidenceId: string; submissionId: string; projectId: string }[] } = { invalidated: [], rechecks: [], evidence: [] };
    const stale = async (): Promise<{ id: string; revision: number; body: QaEvidenceBody; reasons: QaStaleReason[] }[]> => {
      const index = await this.#index(taskId);
      const contract = await this.#contract(taskId);
      const reliance = await this.#reliance(taskId);
      const out: { id: string; revision: number; body: QaEvidenceBody; reasons: QaStaleReason[] }[] = [];
      for (const id of index.body.ids) {
        const found = await this.#runner.get("qa-evidence", id);
        const e = found?.body as unknown as QaEvidenceBody | undefined;
        if (found === undefined || e === undefined || e.state !== "current") continue;
        const reasons = await this.#staleness(e, contract, reliance);
        if (reasons.length > 0) out.push({ id, revision: found.revision, body: e, reasons });
      }
      return out;
    };
    const seen = await stale();
    if (seen.length === 0) return { taskId, invalidated: [], rechecks: [], replayed: false };
    const scoped = scopedCommandId(by.id, commandId);
    // Another check of the same task at the same moment can do the work first: this one then answers with what that one invalidated (of what this one found stale), not "ask again".
    // Something else that went stale meanwhile is looked at again, a few times at most.
    const lostRace = async (): Promise<{ taskId: string; invalidated: string[]; rechecks: string[]; replayed: false; concurrent: true } | undefined> => {
      if ((await stale()).length > 0) return undefined;
      const invalidated: string[] = [];
      const rechecks: string[] = [];
      for (const f of seen) {
        const now = (await this.#runner.get("qa-evidence", f.id))?.body as unknown as QaEvidenceBody | undefined;
        if (now?.state !== "invalidated") continue;
        invalidated.push(f.id);
        if (now.recheckId !== undefined) rechecks.push(now.recheckId);
      }
      return { taskId, invalidated, rechecks, replayed: false, concurrent: true };
    };
    let result: Awaited<ReturnType<CommandRunner["command"]>> | undefined;
    for (let round = 0; result === undefined; round++) {
      try { result = await this.#runCheck(by, scoped, taskId, stale, (m) => { made = m; }); } catch (error) {
        if (!(error instanceof DomainError) || error.code !== "stale_revision" || round >= 2) throw error;
        const answer = await lostRace();
        if (answer !== undefined) return answer;
      }
    }
    if (result.replayed) return { taskId, invalidated: [], rechecks: [], replayed: true };
    if (this.#ports.notify !== undefined) {
      for (const r of made.rechecks) await this.#ports.notify({ commandId: `qa-recheck:${r.id}`, taskId, projectId: r.projectId, recheckId: r.id, text: r.text }).catch(() => undefined);
    }
    if (this.#ports.invalidated !== undefined && made.evidence.length > 0) await this.#ports.invalidated({ taskId, projectId: made.evidence[0]!.projectId, evidence: made.evidence.map((e) => ({ evidenceId: e.evidenceId, submissionId: e.submissionId })) }).catch(() => undefined);
    return { taskId, invalidated: made.invalidated, rechecks: made.rechecks.map((r) => r.id), replayed: false };
  }

  /** One attempt at the write of `check`: invalidates what is stale now and schedules its re-checks. */
  async #runCheck(by: Principal, scoped: string, taskId: string, stale: () => Promise<{ id: string; revision: number; body: QaEvidenceBody; reasons: QaStaleReason[] }[]>, report: (made: { invalidated: string[]; rechecks: { id: string; projectId: string; text: string }[]; evidence: { evidenceId: string; submissionId: string; projectId: string }[] }) => void): Promise<Awaited<ReturnType<CommandRunner["command"]>>> {
    let made: { invalidated: string[]; rechecks: { id: string; projectId: string; text: string }[]; evidence: { evidenceId: string; submissionId: string; projectId: string }[] } = { invalidated: [], rechecks: [], evidence: [] };
    return this.#runner.command("qa.evidence.check", { commandId: scoped, actor: by.id }, async () => ({
      payload: { taskId },
      build: async () => {
        const found = await stale();
        if (found.length === 0) throw new DomainError("stale_revision", "the evidence changed meanwhile; ask again");
        const index = await this.#index(taskId);
        const now = this.#runner.now();
        const changes: Change[] = [];
        const rechecks = [...index.body.rechecks];
        made = { invalidated: [], rechecks: [], evidence: [] };
        for (const f of found) {
          const recheckId = derivedId("qrc", f.id);
          const exists = await this.#runner.get("qa-recheck", recheckId);
          changes.push({ type: "update", ref: { kind: "qa-evidence", id: f.id }, expectedRevision: f.revision, body: json({ ...f.body, state: "invalidated", invalidatedAt: now, invalidatedBy: by.id, reasons: f.reasons, recheckId }) });
          if (exists === undefined) {
            const r: QaRecheckBody = { taskId, projectId: f.body.projectId, evidenceId: f.id, submissionId: f.body.submissionId, tree: f.body.tree, reasons: f.reasons, assignee: f.body.recordedBy, requestedBy: by.id, requestedAt: now, state: "pending" };
            changes.push({ type: "create", ref: { kind: "qa-recheck", id: recheckId }, body: json(r) });
            rechecks.push(recheckId);
          }
          made.invalidated.push(f.id);
          made.evidence.push({ evidenceId: f.id, submissionId: f.body.submissionId, projectId: f.body.projectId });
          made.rechecks.push({ id: recheckId, projectId: f.body.projectId, text: `QA evidence ${f.id} of task ${taskId} no longer holds (${[...new Set(f.reasons.map((r) => r.kind.replace(/_/g, " ")))].join(", ")}): re-check for ${f.body.recordedBy}`.slice(0, NOTICE_CHARS) });
        }
        if (index.revision === undefined) throw new DomainError("integrity", `the QA evidence index of ${taskId} is missing`);
        changes.push({ type: "update", ref: { kind: "qa-evidence-index", id: taskId }, expectedRevision: index.revision, body: json({ ids: index.body.ids, rechecks }) });
        report(made);
        return { ref: { kind: "qa-evidence-index", id: taskId }, creates: false, changes, detail: { taskId, invalidated: made.invalidated } };
      },
    }));
  }

  /**
   * Told once a code submission is recorded (card Q02 follow-up; the controller calls it, best effort, after the submission is written): the pending re-checks of the task on code submitted
   * before it are settled, since that tree is no longer the work and the newer tree is judged on its own evidence (it has none yet, so its gate fails until it is checked). Repeatable; a
   * missed call is caught by the next QA evidence recorded on a newer submission of the task.
   */
  async submitted(submissionId: string): Promise<{ settled: readonly string[] }> {
    if (typeof submissionId !== "string" || !SBM.test(submissionId)) bad("submissionId", "is not a submission ID");
    const looks = async (): Promise<{ sub: SubmissionBody; index: { revision?: number; body: IndexBody }; due: { id: string; revision: number; body: QaRecheckBody }[] } | undefined> => {
      const sub = (await this.#runner.get("submission", submissionId))?.body as unknown as SubmissionBody | undefined;
      if (sub === undefined || sub.kind !== "code") return undefined;
      const index = await this.#index(sub.taskId);
      const due: { id: string; revision: number; body: QaRecheckBody }[] = [];
      for (const r of index.body.rechecks) {
        const found = await this.#runner.get("qa-recheck", r);
        const rb = found?.body as unknown as QaRecheckBody | undefined;
        if (found === undefined || rb === undefined || rb.state !== "pending" || rb.submissionId === submissionId) continue;
        const older = (await this.#runner.get("submission", rb.submissionId))?.body as unknown as SubmissionBody | undefined;
        if (older !== undefined && older.submittedAt < sub.submittedAt) due.push({ id: r, revision: found.revision, body: rb });
      }
      return { sub, index, due };
    };
    const first = await looks();
    if (first === undefined || first.due.length === 0) return { settled: [] };
    let settled: string[] = [];
    const result = await this.#runner.command("qa.recheck.supersede", { commandId: `qa-sup:${submissionId}`, actor: "controller" }, async () => ({
      payload: { submissionId },
      build: async () => {
        const seen = await looks();
        if (seen === undefined || seen.due.length === 0) throw new DomainError("stale_revision", "the re-checks were settled meanwhile");
        const now = this.#runner.now();
        settled = seen.due.map((d) => d.id);
        return {
          ref: { kind: "qa-recheck", id: seen.due[0]!.id }, creates: false, detail: { taskId: seen.sub.taskId, submissionId, settled },
          changes: seen.due.map((d) => ({ type: "update" as const, ref: { kind: "qa-recheck", id: d.id }, expectedRevision: d.revision, body: json({ ...d.body, state: "done", doneAt: now, supersededBy: submissionId }) })),
        };
      },
    }));
    return { settled: result.replayed ? [] : settled };
  }

  // ---- reading ---------------------------------------------------------------------------------------------------------------

  /** The QA evidence of a task (newest first) with, for each current record, whether it still holds now, and the re-checks. The task's read right. */
  async list(by: Principal, taskIdValue: string): Promise<{ taskId: string; criteriaRevision: number; items: (QaEvidenceBody & { id: string; revision: number; staleNow: readonly QaStaleReason[] })[]; rechecks: (QaRecheckBody & { id: string })[] }> {
    const { taskId } = await this.#readable(by, taskIdValue);
    const index = await this.#index(taskId);
    const contract = await this.#contract(taskId);
    const reliance = await this.#reliance(taskId);
    const items: (QaEvidenceBody & { id: string; revision: number; staleNow: readonly QaStaleReason[] })[] = [];
    for (const id of [...index.body.ids].reverse()) {
      const found = await this.#runner.get("qa-evidence", id);
      const e = found?.body as unknown as QaEvidenceBody | undefined;
      if (found === undefined || e === undefined) continue;
      items.push({ ...e, id, revision: found.revision, staleNow: e.state === "current" ? await this.#staleness(e, contract, reliance) : [] });
    }
    const rechecks: (QaRecheckBody & { id: string })[] = [];
    for (const r of index.body.rechecks) {
      const b = (await this.#runner.get("qa-recheck", r))?.body as unknown as QaRecheckBody | undefined;
      if (b !== undefined) rechecks.push({ ...b, id: r });
    }
    return { taskId, criteriaRevision: contract.version, items, rechecks };
  }

  /** One QA evidence record, or a re-check (`qrc-` ID). Hidden as not found where the caller may not read the task. */
  async get(by: Principal, id: string): Promise<JsonObject | undefined> {
    if (typeof id !== "string" || !(QAE.test(id) || /^qrc-[a-z2-7]{20}$/.test(id))) bad("id", "is not a QA evidence or re-check ID");
    const found = await this.#runner.get(id.startsWith("qae-") ? "qa-evidence" : "qa-recheck", id);
    const b = found?.body as unknown as { taskId: string } | undefined;
    if (found === undefined || b === undefined) return undefined;
    const task = await this.#task(b.taskId);
    if (task === undefined || !this.#reads(by, task, b.taskId)) return undefined;
    return json({ ...b, id, revision: found.revision });
  }

  /**
   * The project's QA picture (card Q02, project QA view): for each task of the project the caller may read, its NEWEST code submission (by `submittedAt`, then ID) and where it stands with QA.
   * `passes`: the gate passes. `waiting`: no independent evidence at all, current or stale (the work waits for QA; a self-check does not count; the checks the contract requires then also read as missing). `stale`: evidence existed but no longer holds, or a re-check is pending.
   * `failing`: current evidence has failed, blocked, not-run or missing checks, or relies on a superseded decision. Older submissions of a task are not shown (the newest is the work). Read only; a task
   * the caller may not read is not listed or counted. The owner, or an agent with the project's task read right; a task credential (scoped to one task) is refused: it has the `qa` view of its own task.
   * Bounded: scans at most `reads` pages of `pageSize` submissions (`scanLimited` when more exist; the table is in hash order of IDs, not time order), and reads the gate of at most `tasks` tasks, those with the
   * newest code submissions first, looking at no more than twice that many tasks (`truncated` when more were left); counts and order cover the tasks read.
   */
  async project(by: Principal, projectIdValue: string, limits: { readonly tasks: number; readonly pageSize: number; readonly reads: number } = { tasks: QA_LIMITS.projectTasks, pageSize: 500, reads: QA_LIMITS.projectScanReads }): Promise<QaProjectView> {
    const projectId = checkProjectId(projectIdValue);
    const proj = await this.#runner.get("project", projectId);
    const mayRead = by.kind === "owner" || (by.kind === "agent" && by.taskScope === undefined && allows(by, "task.read", projectId));
    if (proj === undefined || !mayRead) return hidden("project");
    const newest = new Map<string, { id: string; at: string }>();
    let after: string | undefined;
    let scanLimited = true;
    for (let read = 0; read < limits.reads; read++) {
      const chunk = await this.#runner.list("submission", { ...(after === undefined ? {} : { afterId: after }), limit: limits.pageSize });
      for (const row of chunk) {
        after = row.id;
        const b = row.body as unknown as SubmissionBody;
        if (b.projectId !== projectId || b.kind !== "code" || b.tree === undefined || !TREE.test(b.tree)) continue;
        const had = newest.get(b.taskId);
        if (had === undefined || b.submittedAt > had.at || (b.submittedAt === had.at && row.id > had.id)) newest.set(b.taskId, { id: row.id, at: b.submittedAt });
      }
      if (chunk.length < limits.pageSize) { scanLimited = false; break; }
    }
    // The tasks with the newest code first, so a bounded read covers the work most recently submitted.
    const candidates = [...newest].sort((x, y) => (x[1].at > y[1].at ? -1 : x[1].at < y[1].at ? 1 : x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
    const items: QaProjectItem[] = [];
    let looked = 0;
    for (const [taskId, sub] of candidates) {
      if (items.length >= limits.tasks || looked >= limits.tasks * 2) break;
      looked++;
      const task = await this.#task(taskId);
      if (task === undefined || task.projectId !== projectId || !this.#reads(by, task, taskId)) continue;
      const g = await this.gate(by, sub.id);
      const state: QaProjectItem["state"] = g.verdict === "passed" ? "passes" : g.reasons.includes("no_evidence") ? "waiting" : g.reasons.includes("stale_evidence") || g.pendingRechecks.length > 0 ? "stale" : "failing";
      items.push({ taskId, title: task.title, submissionId: sub.id, tree: g.tree, submittedAt: sub.at, state, reasons: g.reasons, counts: g.counts, pendingRechecks: g.pendingRechecks });
    }
    const truncated = looked < candidates.length;
    const counts = { passes: 0, waiting: 0, stale: 0, failing: 0 };
    for (const i of items) counts[i.state]++;
    const order = { waiting: 0, stale: 1, failing: 2, passes: 3 } as const;
    items.sort((x, y) => order[x.state] - order[y.state] || (x.taskId < y.taskId ? -1 : 1));
    return { projectId, counts, items, truncated, scanLimited };
  }

  /**
   * Whether the independent QA evidence for one code submission passes, read only. Only current evidence that still holds counts: a self-check never does. Every required check needs a `passed`
   * result in the newest such record that names it; failed, blocked, not-run and missing are each counted and each fail. With no required checks, every check named in any such record is judged so,
   * and so is every check named by independent evidence that no longer holds and whose re-check is not done (it is `missing` until a re-check names it again); no record at all fails. A task relying on a superseded decision fails whatever the evidence says.
   */
  async gate(by: Principal, submissionIdValue: string): Promise<QaGate> { return (await this.gateBound(by, submissionIdValue)).gate; }

  /**
   * The gate with the records its verdict was read from (card Q03): the task's evidence index, the contract and the decision reliance when they exist, and each independent record of the submission with
   * the decisions it cites, and each re-check of the submission. A write that checks each at the revision read cannot be made on a verdict that changed meanwhile (new or invalidated evidence, a settled
   * re-check, a changed contract, a superseded decision).
   * Not bound: a contract or a reliance that does not exist yet (the storage has no guard for absence) and the contract versions (never rewritten).
   */
  async gateBound(by: Principal, submissionIdValue: string): Promise<{ gate: QaGate; reads: readonly QaGateRead[] }> {
    const { sub, taskId } = await this.#submission(by, submissionIdValue);
    const submissionId = submissionIdValue;
    const reads: QaGateRead[] = [];
    const contract = await this.#contract(taskId);
    if (contract.revision !== undefined) reads.push({ kind: "task-contract", id: taskId, revision: contract.revision });
    const reliance = await this.#reliance(taskId, reads);
    const index = await this.#index(taskId);
    if (index.revision !== undefined) reads.push({ kind: "qa-evidence-index", id: taskId, revision: index.revision });
    const usable: (QaEvidenceBody & { id: string })[] = [];
    const stale: { id: string; reasons: QaStaleReason[] }[] = [];
    for (const id of index.body.ids) {
      const found = await this.#runner.get("qa-evidence", id);
      const e = found?.body as unknown as QaEvidenceBody | undefined;
      if (found === undefined || e === undefined || e.submissionId !== submissionId || e.source !== "independent") continue;
      reads.push({ kind: "qa-evidence", id, revision: found.revision });
      if (e.state !== "current") { stale.push({ id, reasons: [...(e.reasons ?? [])] }); continue; }
      const reasons = await this.#staleness(e, contract, reliance, reads);
      if (reasons.length > 0) stale.push({ id, reasons }); else usable.push({ ...e, id });
    }
    const pending: string[] = [];
    // Check names of independent evidence on this submission that no longer holds and whose re-check is not done by evidence (pending, or settled only by a newer tree): with no required
    // checks, they must be named again (card Q02 follow-up), so newer evidence on other checks alone does not pass.
    const carried: string[] = [];
    const awaiting = new Set<string>();
    for (const r of index.body.rechecks) {
      const foundRecheck = await this.#runner.get("qa-recheck", r);
      const b = foundRecheck?.body as unknown as QaRecheckBody | undefined;
      if (foundRecheck === undefined || b === undefined || b.submissionId !== submissionId) continue;
      reads.push({ kind: "qa-recheck", id: r, revision: foundRecheck.revision });
      if (b.state === "pending") { pending.push(r); awaiting.add(b.evidenceId); }
      // Settled by a newer tree, not by evidence naming its checks again: this tree's checks are still owed here, so its gate does not pass on narrower evidence once the newer tree came in.
      else if (b.doneBy === undefined) awaiting.add(b.evidenceId);
    }
    for (const s of stale) {
      const e = (await this.#runner.get("qa-evidence", s.id))?.body as unknown as QaEvidenceBody | undefined;
      if (e !== undefined && (e.state === "current" || awaiting.has(s.id))) carried.push(...e.checks.map((c) => c.name));
    }
    const reasons = new Set<string>();
    if ((reliance?.links ?? []).some((l) => l.state !== "current")) reasons.add("decision_superseded");
    const newestFirst = [...usable].reverse();
    const required = this.#required(contract.body);
    // With no required checks, every check named in any current independent record is judged (by the newest record naming it): a later record that leaves a check out does not hide an
    // earlier failure of it.
    const names = required.length > 0 ? required : [...new Set([...newestFirst.flatMap((e) => e.checks.map((c) => c.name)), ...carried])];
    const checks: QaGateCheck[] = names.map((name) => {
      for (const e of newestFirst) { const c = e.checks.find((x) => x.name === name); if (c !== undefined) return { name, result: c.result, evidenceId: e.id }; }
      return { name, result: "missing" as const };
    });
    const count = (r: QaGateCheck["result"]): number => checks.filter((c) => c.result === r).length;
    const counts = { passed: count("passed"), failed: count("failed"), blocked: count("blocked"), notRun: count("not-run"), missing: count("missing") };
    if (usable.length === 0) reasons.add(stale.length > 0 ? "stale_evidence" : "no_evidence");
    if (counts.failed > 0) reasons.add("check_failed");
    if (counts.blocked > 0) reasons.add("check_blocked");
    if (counts.notRun > 0) reasons.add("check_not_run");
    if (counts.missing > 0) reasons.add("check_missing");
    const decisions: QaDecisionRef[] = (reliance?.links ?? []).filter((l) => l.state === "current").map((l) => ({ id: l.decisionId, version: l.version, topic: l.topic }));
    const seen = new Set<string>();
    const bound = reads.filter((r) => { const k = `${r.kind}\u0000${r.id}`; if (seen.has(k)) return false; seen.add(k); return true; });
    return { gate: { taskId, submissionId, tree: sub.tree, verdict: reasons.size === 0 && checks.length > 0 ? "passed" : "failed", reasons: [...reasons], criteriaRevision: contract.version, decisions, required, checks, counts, stale, pendingRechecks: pending }, reads: bound };
  }
}

/**
 * The QA gate as the landing gate reads it (card P09, the `qa` required check): read as the controller at the owner's level, so every task's gate can be read; the landing gate itself checks the task, the submission and
 * the tree. One function, used by `start.ts` and by the tests, so the controller's composition is the one tested.
 */
export function landingQaGate(service: QaEvidenceService): (submissionId: string) => Promise<QaGate> {
  const reader = { id: "service:landing-gate", kind: "owner", name: "landing-gate", grants: [] } as unknown as Principal;
  return async (submissionId) => service.gate(reader, submissionId);
}

/** A stale reason in plain words (the owner reads it). */
export function reasonText(r: QaStaleReason): string {
  switch (r.kind) {
    case "criteria_changed": return `the task contract's ${r.fields.join(", ")} changed (version ${r.from} to ${r.to})`;
    case "criteria_unknown": return `the task contract version ${r.from} it was checked against cannot be read (now ${r.to})`;
    case "decision_superseded": return `owner decision ${r.decisionId} is ${r.state}`;
    case "decision_not_cited": return `the task now relies on owner decision ${r.decisionId}, which it was not checked against`;
  }
}

/**
 * The hook the decision service calls for each task a decision change reaches (card Q02, fifth slice). `api/start.ts` and the tests build it from this one function, so what runs in the controller is what is tested.
 * The QA service is read when the hook runs (the decision service is made before it). A failure is swallowed: a QA fault never fails or holds back a decision; `qa.evidence.check` and the gate still catch it.
 */
export function decisionChangeHook(qa: () => Pick<QaEvidenceService, "decisionChanged"> | undefined): (taskId: string) => Promise<void> {
  return async (taskId) => { try { await qa()?.decisionChanged(taskId); } catch { /* best effort */ } };
}
