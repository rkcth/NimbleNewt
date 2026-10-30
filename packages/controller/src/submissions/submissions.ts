import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import type { AssignmentService } from "../domain/assignments.js";
import { derivedId } from "../domain/ids.js";
import { artifactId as checkArtifactId, commandId as checkCommandId, taskId as checkTaskId, text, type TaskBody } from "../domain/model.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { allows, inTaskScope } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";

export const SUBMISSION_KINDS = ["code", "review", "qa", "document", "signoff"] as const;
export type SubmissionKind = (typeof SUBMISSION_KINDS)[number];

/**
 * Which role may submit which kind (card Q01b). PROVISIONAL (owner question): the integrator submits no kind here because it writes no content (card P10) and its landing is not a submission;
 * a one-agent project submits in several roles because one agent may hold several roles (the rule is on the role the agent submits in, not on who the agent is). A review of one's own work is NOT self-served there: review is disabled (refused) when only one agent exists.
 */
export const KIND_ROLES: Readonly<Record<SubmissionKind, readonly string[]>> = {
  code: ["author"], review: ["reviewer"], qa: ["qa"], document: ["docs"], signoff: ["director"],
};

export type CheckResult = "pass" | "fail" | "not_run";
export interface Evidence {
  readonly check: string;
  readonly result: CheckResult;
  /** The exact tree (code, review, qa) or artifact digest (document) the check ran on. */
  readonly boundTo: string;
}

export interface SubmissionBody {
  readonly taskId: string;
  readonly projectId: string;
  readonly kind: SubmissionKind;
  readonly role: string;
  readonly submittedBy: string;
  readonly submittedAt: string;
  /** Always false for a non-code kind: only a code submission names a commit tree, and none of them makes a commit. */
  readonly makesCommit: boolean;
  readonly base?: string;
  readonly tree?: string;
  readonly patchId?: string;
  readonly refreshRound?: number;
  /** The submission a review, qa report or sign-off is about. */
  readonly subject?: string;
  readonly verdict?: "approve" | "changes" | "reject";
  readonly decision?: "approve" | "decline";
  readonly report?: string;
  readonly artifactDigest?: string;
  readonly artifactId?: string;
  readonly evidence: readonly Evidence[];
  /** Only on a code submission, when the controller can judge it: whether a review is required of it. `required: false` always carries its reason, so a skipped review is on the record. */
  readonly review?: { readonly required: boolean; readonly reason?: typeof REVIEW_DISABLED_SINGLE_AGENT };
}

/** The recorded reason a review is not required: the project has no agent besides the worker that could review. */
export const REVIEW_DISABLED_SINGLE_AGENT = "review_disabled_single_agent" as const;

/** The roles a principal holds in one project, and for one task of it: roles are not global (an agent that is director in project X is not director in Y). */
export type RolesOf = (principalId: string, scope: { readonly projectId: string; readonly taskId: string }, by: Principal) => Promise<readonly string[]>;

/** The task's current attempt, when it has one: who owns it (a principal ID) and its state. Only an active attempt, or one that has just succeeded (the attempt is ending with this submission), may submit code. */
export type AttemptOf = (taskId: string) => Promise<{ readonly ownerId: string; readonly state: string } | undefined>;

/** The attempt port over the assignment service: the task's active attempt, owned by the agent principal `agent:<id>`-style owner ID the assignment names. */
export const attemptOfAssignments = (assignments: AssignmentService): AttemptOf => async (taskId) => {
  const asg = await assignments.getAssignment(taskId);
  if (asg === undefined || asg.activeAttemptId === undefined) return undefined;
  const attempt = await assignments.getAttempt(asg.activeAttemptId);
  return attempt === undefined ? undefined : { ownerId: attempt.owner.id, state: attempt.state };
};

export interface SubmissionOptions extends RunnerOptions {
  /** When given, a code submission must come from the owner of the task's current attempt. */
  readonly attemptOf?: AttemptOf;
  /**
   * Who in the project could review work by `workerId`: the project's agents that may review, never the worker itself (see `AgentService.reviewersAvailableIn`). When it names no one the project has
   * fewer than two agents able to review, review is DISABLED for it and a code submission records `review_disabled_single_agent` instead of requiring a review. Without it the requirement is not judged.
   * There is no option to let an agent review its own work: that is always refused (owner decision, final).
   */
  readonly reviewersAvailableIn?: (projectId: string, workerId: string) => Promise<readonly string[]>;
  /**
   * The submissions this principal has been asked to review in this task (the review request names the submission), by ID. OWNER DECISION: a reviewer reads ONLY those, never the role's other submissions.
   * Absent: nobody is assigned. The port is asked again on every read, and the principal must still hold the reviewer role in the project.
   */
  readonly reviewAssignments?: (principalId: string, taskId: string) => Promise<readonly string[]>;
  /** Scan limits for `list`, injectable so a test can shrink them (as `logScan` does for meetings). Defaults: 200 rows a page, 10 pages a call. */
  readonly listScan?: { readonly pageSize: number; readonly reads: number };
}

export interface RecordSubmission {
  readonly taskId: string;
  readonly kind: SubmissionKind;
  readonly role: string;
  readonly base?: string;
  readonly tree?: string;
  readonly patchId?: string;
  readonly refreshRound?: number;
  readonly subject?: string;
  readonly verdict?: string;
  readonly decision?: string;
  readonly report?: string;
  readonly artifactDigest?: string;
  readonly artifactId?: string;
  readonly evidence?: readonly Evidence[];
}

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ID = /^(?:sbm|art)-[a-z2-7]{20}$/;
const FIELDS = ["commandId", "taskId", "kind", "role", "base", "tree", "patchId", "refreshRound", "subject", "verdict", "decision", "report", "artifactDigest", "artifactId", "evidence"] as const;
/** What each kind may carry besides taskId, kind and role (and evidence). A field outside the list is refused, so a non-code kind cannot carry a base, a tree or a patch. */
const ALLOWED: Readonly<Record<SubmissionKind, readonly string[]>> = {
  code: ["base", "tree", "patchId", "refreshRound"],
  review: ["subject", "verdict"],
  qa: ["subject", "report"],
  document: ["artifactDigest", "artifactId", "report"],
  signoff: ["subject", "decision"],
};
const LIST_PAGE = 200;
const LIST_READS = 10;
type Item = SubmissionBody & { id: string; revision: number };
const MAX_EVIDENCE = 50;
const MAX_REPORT = 8000;

const bad = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };

/**
 * One record per submission attempt (card Q01b): its kind, the role it was made in, and the check evidence bound to the exact tree or artifact version. Nothing here lands, reviews or accepts anything:
 * the landing queue (P08..P10) and acceptance (Q01) read these records. Not done here: the state API operations, and the refresh-round numbering across attempts.
 */
export class SubmissionService {
  readonly #runner: CommandRunner;
  readonly #roles: RolesOf;
  readonly #attemptOf: AttemptOf | undefined;
  readonly #reviewers: SubmissionOptions["reviewersAvailableIn"];
  readonly #assigned: SubmissionOptions["reviewAssignments"];
  readonly #scan: { readonly pageSize: number; readonly reads: number };
  /** Per instance, never stored: a cursor from before a restart or from another instance does not open. */
  readonly #cursorKey = randomBytes(32);
  private constructor(runner: CommandRunner, roles: RolesOf, options: SubmissionOptions) {
    this.#runner = runner; this.#roles = roles; this.#attemptOf = options.attemptOf; this.#reviewers = options.reviewersAvailableIn; this.#assigned = options.reviewAssignments;
    this.#scan = { pageSize: options.listScan?.pageSize ?? LIST_PAGE, reads: options.listScan?.reads ?? LIST_READS };
  }

  /** AES-256-GCM like the status cursors; the sealed text names the caller and the task, so a cursor cannot be used by another caller or for another task. */
  #seal(by: Principal, taskId: string, position: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#cursorKey, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify([by.id, taskId, position]), "utf8"), cipher.final()]);
    return `~${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url")}`;
  }

  #unseal(by: Principal, taskId: string, cursor: unknown): string {
    const refuse = (): never => bad("after", "is not a cursor from an earlier page of this listing");
    if (typeof cursor !== "string" || cursor.length > 200 || !cursor.startsWith("~")) return refuse();
    try {
      const raw = Buffer.from(cursor.slice(1), "base64url");
      if (raw.length < 29) return refuse();
      const decipher = createDecipheriv("aes-256-gcm", this.#cursorKey, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      const parsed = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8")) as unknown;
      if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[0] !== by.id || parsed[1] !== taskId || typeof parsed[2] !== "string" || !ID.test(parsed[2])) return refuse();
      return parsed[2];
    } catch { return refuse(); }
  }

  /** The task, when this caller may read it: the owner always; an agent needs task.read and, with a task credential, that very task. */
  async #readableTask(by: Principal, taskId: string): Promise<TaskBody | undefined> {
    const task = (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined;
    if (task === undefined) return undefined;
    if (by.kind === "owner") return task;
    if (by.kind !== "agent") return undefined;
    if ((by.taskScope !== undefined && (!inTaskScope(by, task.projectId) || by.taskScope.taskId !== taskId)) || !allows(by, "task.read", task.projectId, { resource: { kind: "task", id: taskId } })) return undefined;
    return task;
  }

  /** The submissions of this task the principal was asked to review, when it still holds the reviewer role. */
  async #assignedTo(by: Principal, task: TaskBody, taskId: string): Promise<ReadonlySet<string>> {
    if (by.kind !== "agent" || this.#assigned === undefined) return new Set();
    const ids = await this.#assigned(by.id, taskId);
    if (ids.length === 0 || !(await this.#roles(by.id, { projectId: task.projectId, taskId }, by)).includes("reviewer")) return new Set();
    return new Set(ids);
  }

  static withEpoch(storage: ControllerStorage, epoch: number, roles: RolesOf, options: SubmissionOptions = {}): SubmissionService {
    return new SubmissionService(new CommandRunner(storage, epoch, options), roles, options);
  }

  async record(by: Principal, command: NoActor & RecordSubmission): Promise<{ id: string; revision: number; replayed: boolean }> {
    if (by.kind !== "agent") throw new DomainError("forbidden", `${by.id} is not an agent, so it has no role to submit in`);
    if (command === null || typeof command !== "object") throw new DomainError("invalid_command", "a command is an object");
    const unknown = Object.keys(command).filter((k) => !(FIELDS as readonly string[]).includes(k));
    if (unknown.length > 0) bad(unknown[0]!, "is not a field of this command");
    const commandId = checkCommandId(command.commandId);
    const kind = command.kind;
    if (!SUBMISSION_KINDS.includes(kind)) bad("kind", `must be one of ${SUBMISSION_KINDS.join(", ")}`);
    const taskId = checkTaskId(command.taskId);
    const role = command.role;
    if (typeof role !== "string" || role === "") bad("role", "name the role you submit in");
    text(role, "role", { min: 1, max: 40 });
    // A non-code kind makes no commit: it may not carry what only a code submission has.
    for (const key of Object.keys(command)) {
      if (["commandId", "taskId", "kind", "role", "evidence"].includes(key) || (command as unknown as Record<string, unknown>)[key] === undefined) continue;
      if (!ALLOWED[kind].includes(key)) bad(key, kind === "code" ? `a code submission does not carry ${key}` : `a ${kind} submission makes no commit and carries no ${key}`);
    }
    if (!KIND_ROLES[kind].includes(role)) throw new DomainError("forbidden", `the role ${role} may not submit a ${kind} submission (only ${KIND_ROLES[kind].join(", ")})`);
    const task = (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined;
    const hidden = (): never => { throw new DomainError("not_found", "no such task"); };
    if (task === undefined) return hidden();
    if ((by.taskScope !== undefined && (!inTaskScope(by, task.projectId) || by.taskScope.taskId !== taskId)) || !allows(by, "task.read", task.projectId, { resource: { kind: "task", id: taskId } })) return hidden();

    if (!(await this.#roles(by.id, { projectId: task.projectId, taskId }, by)).includes(role)) throw new DomainError("forbidden", `${by.id} does not hold the role ${role} in this project`);
    if (kind === "code" && this.#attemptOf !== undefined) {
      const attempt = await this.#attemptOf(taskId);
      if (attempt === undefined || attempt.ownerId !== by.id || (attempt.state !== "active" && attempt.state !== "succeeded")) throw new DomainError("forbidden", "a code submission must come from the agent that owns the task's current attempt");
    }

    const evidence = this.#evidence(command.evidence);
    const subject = command.subject === undefined ? undefined : await this.#subject(command.subject, taskId);
    const fields = this.#fields(by, kind, command, subject);
    // Evidence belongs to one exact tree or artifact version; evidence for another is refused, not ignored.
    const bound = fields.tree ?? fields.artifactDigest;
    for (const e of evidence) if (e.boundTo !== bound) throw new DomainError("invalid_command", `evidence: ${e.check} is bound to ${e.boundTo}, not to the submitted ${fields.artifactDigest === undefined ? "tree" : "artifact"} ${String(bound)}`, { field: "evidence" });

    const id = derivedId("sbm", scopedCommandId(by.id, commandId));
    const review: SubmissionBody["review"] | undefined = kind !== "code" || this.#reviewers === undefined ? undefined
      : (await this.#reviewers(task.projectId, by.id)).filter((r) => r !== by.id).length === 0 ? { required: false, reason: REVIEW_DISABLED_SINGLE_AGENT } : { required: true };
    const body: SubmissionBody = { taskId, projectId: task.projectId, kind, role, submittedBy: by.id, submittedAt: this.#runner.now(), makesCommit: false, ...fields, evidence, ...(review === undefined ? {} : { review }) };
    const result = await this.#runner.command("submission.record", { commandId: scopedCommandId(by.id, commandId), actor: by.id }, async () => ({
      payload: { ...(body as unknown as JsonObject), submittedAt: null },
      build: async () => {
        const ref = { kind: "submission", id };
        return { ref, creates: true, changes: [{ type: "create" as const, ref, body: body as unknown as JsonObject }], detail: { taskId, kind, role } };
      },
    }));
    return { id: result.id, revision: result.revision, replayed: result.replayed };
  }

  /**
   * One submission. The owner reads any. An agent reads it only when it may read the submission's task (task.read in the project, and with a task credential only that task) AND either made it
   * or has been asked to review it (OWNER DECISION: a reviewer reads only the submission(s) its review request names, never the role's others). Anyone else gets `undefined` (not found).
   */
  async get(by: Principal, id: string): Promise<Item | undefined> {
    if (typeof id !== "string" || id.length > 40 || !ID.test(id)) bad("id", "is not a submission ID");
    const found = await this.#runner.get("submission", id);
    if (found === undefined) return undefined;
    const body = found.body as unknown as SubmissionBody;
    if (by.kind !== "owner") {
      const task = await this.#readableTask(by, body.taskId);
      if (task === undefined) return undefined;
      if (body.submittedBy !== by.id && !(await this.#assignedTo(by, task, body.taskId)).has(id)) return undefined;
    }
    return { ...body, ...(body.report === undefined ? {} : { report: redactText(body.report) }), id: found.id, revision: found.revision };
  }

  /**
   * The submissions of one task, filtered exactly as `get` is: the owner sees all; an agent that may read the task sees the ones it made and the ones it was asked to review. A task the caller cannot read is `not_found`.
   * NOT A FEED: records sit in a global table in hash order of their IDs, so a new record can land before a cursor you already hold and a listing is not a stable snapshot; page through it to collect, do not poll it for news.
   * Work is bounded (pageSize rows a read, `reads` reads a call); `scanLimited` says the scan stopped before the end. `next` is an opaque sealed cursor bound to the caller and the task; any other `after` is `invalid_command`.
   */
  async list(by: Principal, taskIdValue: string, query: { kind?: string; afterId?: string; limit: number }): Promise<{ items: Item[]; next?: string; scanLimited?: boolean }> {
    const taskId = checkTaskId(taskIdValue);
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100) bad("limit", "must be a whole number from 1 to 100");
    if (query.kind !== undefined && !SUBMISSION_KINDS.includes(query.kind as SubmissionKind)) bad("kind", `must be one of ${SUBMISSION_KINDS.join(", ")}`);
    let after = query.afterId === undefined ? undefined : this.#unseal(by, taskId, query.afterId);
    const task = await this.#readableTask(by, taskId);
    if (task === undefined) throw new DomainError("not_found", "no such task");
    const assigned = by.kind === "owner" ? new Set<string>() : await this.#assignedTo(by, task, taskId);
    const items: Item[] = [];
    const { pageSize, reads } = this.#scan;
    for (let read = 0; read < reads; read++) {
      const chunk = await this.#runner.list("submission", { ...(after === undefined ? {} : { afterId: after }), limit: pageSize });
      for (const row of chunk) {
        after = row.id;
        const body = row.body as unknown as SubmissionBody;
        if (body.taskId !== taskId || (query.kind !== undefined && body.kind !== query.kind)) continue;
        if (by.kind !== "owner" && body.submittedBy !== by.id && !assigned.has(row.id)) continue;
        items.push({ ...body, ...(body.report === undefined ? {} : { report: redactText(body.report) }), id: row.id, revision: row.revision });
        if (items.length >= query.limit) return { items, next: this.#seal(by, taskId, row.id) };
      }
      if (chunk.length < pageSize) return { items };
    }
    return { items, ...(after === undefined ? {} : { next: this.#seal(by, taskId, after) }), scanLimited: true };
  }

  async #subject(id: unknown, taskId: string): Promise<SubmissionBody & { id: string }> {
    if (typeof id !== "string" || !/^sbm-[a-z2-7]{20}$/.test(id)) return bad("subject", "is not a submission ID");
    const found = await this.#runner.get("submission", id);
    const body = found?.body as unknown as SubmissionBody | undefined;
    if (body === undefined || body.taskId !== taskId) throw new DomainError("invalid_command", "subject: no such submission for this task", { field: "subject" });
    return { ...body, id };
  }

  /** A reviewer or QA agent may not judge work its own principal submitted (card Q01b); there is no override. */
  #notOwn(by: Principal, subject: SubmissionBody): void {
    if (subject.submittedBy === by.id) throw new DomainError("forbidden", "a review or qa report cannot be given on the reviewer's own submission");
  }

  #evidence(raw: unknown): Evidence[] {
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || raw.length > MAX_EVIDENCE) return bad("evidence", `must be a list of at most ${MAX_EVIDENCE} checks`);
    return raw.map((e: unknown) => {
      const o = e as Record<string, unknown> | null;
      if (o === null || typeof o !== "object" || typeof o.check !== "string") return bad("evidence", "each item names its check");
      text(o.check, "evidence.check", { min: 1, max: 120 });
      if (!["pass", "fail", "not_run"].includes(o.result as string)) return bad("evidence", `${o.check}: result must be pass, fail or not_run`);
      if (typeof o.boundTo !== "string" || !(OID.test(o.boundTo) || DIGEST.test(o.boundTo))) return bad("evidence", `${o.check}: boundTo must be a tree or an artifact digest`);
      return { check: o.check, result: o.result as CheckResult, boundTo: o.boundTo };
    });
  }

  #fields(by: Principal, kind: SubmissionKind, c: RecordSubmission, subject: (SubmissionBody & { id: string }) | undefined): Partial<SubmissionBody> {
    const need = (name: string, ok: boolean, why: string): void => { if (!ok) bad(name, why); };
    if (kind === "code") {
      need("base", typeof c.base === "string" && c.base.length <= 64 && OID.test(c.base), "name the base commit it was made on");
      need("tree", typeof c.tree === "string" && c.tree.length <= 64 && OID.test(c.tree), "name the tree submitted");
      need("patchId", typeof c.patchId === "string" && c.patchId.length <= 64 && /^[0-9a-f]{40,64}$/.test(c.patchId), "name the patch-id");
      need("refreshRound", c.refreshRound === undefined || (Number.isSafeInteger(c.refreshRound) && c.refreshRound >= 0 && c.refreshRound <= 1000), "must be a whole number from 0");
      return { base: c.base!, tree: c.tree!, patchId: c.patchId!, refreshRound: c.refreshRound ?? 0 };
    }
    if (kind === "document") {
      need("artifactDigest", typeof c.artifactDigest === "string" && c.artifactDigest.length <= 80 && DIGEST.test(c.artifactDigest), "name the document artifact's digest");
      if (c.artifactId !== undefined) checkArtifactId(c.artifactId);
      need("report", c.report === undefined || (typeof c.report === "string" && c.report.length <= MAX_REPORT), `at most ${MAX_REPORT} characters`);
      return { artifactDigest: c.artifactDigest!, ...(c.artifactId === undefined ? {} : { artifactId: c.artifactId }), ...(c.report === undefined ? {} : { report: redactText(c.report) }) };
    }
    need("subject", subject !== undefined, "name the submission it is about");
    const s = subject!;
    need("subject", s.kind === "code" || s.kind === "document", "a review, qa report or sign-off is about a code or document submission");
    const bound = { subject: s.id, ...(s.tree === undefined ? {} : { tree: s.tree, patchId: s.patchId! }), ...(s.artifactDigest === undefined ? {} : { artifactDigest: s.artifactDigest }) };
    if (kind === "review") {
      need("verdict", ["approve", "changes", "reject"].includes(c.verdict as string), "must be approve, changes or reject");
      this.#notOwn(by, s);
      return { ...bound, verdict: c.verdict as "approve" | "changes" | "reject" };
    }
    if (kind === "qa") {
      need("report", typeof c.report === "string" && c.report !== "" && c.report.length <= MAX_REPORT, `a report of at most ${MAX_REPORT} characters`);
      this.#notOwn(by, s);
      return { ...bound, report: redactText(c.report!) };
    }
    need("decision", ["approve", "decline"].includes(c.decision as string), "must be approve or decline");
    // A sign-off is the project's check on the work, so the director cannot give it on work they submitted themselves.
    if (s.submittedBy === by.id) throw new DomainError("forbidden", "a director sign-off cannot be given on the director's own work");
    return { ...bound, decision: c.decision as "approve" | "decline" };
  }
}
