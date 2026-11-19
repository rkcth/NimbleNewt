import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import type { AssignmentService } from "../domain/assignments.js";
import { derivedId } from "../domain/ids.js";
import { artifactId as checkArtifactId, commandId as checkCommandId, projectId as checkProjectId, taskId as checkTaskId, text, type TaskBody } from "../domain/model.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { allows, inTaskScope } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { Change, ControllerStorage, JsonObject } from "../storage/types.js";

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
  /**
   * Code only, when the controller knows the task's attempts: the attempt this code was submitted from (card Q01b, "a submission record per attempt"). A task can have several attempts over time
   * (a retry, a resume after a failure); this names which one made the tree. Records from before this field, or from a service built without the attempt port, have none.
   */
  readonly attemptId?: string;
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

/** Whether a code submission is approved (card H12o, `SubmissionService.approvalOf`): the approved base and tree, and who approved it (a reviewer's principal, or `review_disabled_single_agent`). */
export interface SubmissionApproval {
  readonly submissionId: string;
  readonly taskId: string;
  readonly projectId: string;
  readonly base: string;
  readonly tree: string;
  /** The patch ID the submission names (card P09: a reviewer's approval carries over to a landing only while the patch ID is unchanged). */
  readonly patchId?: string;
  readonly submittedBy: string;
  /** When the submission was recorded. */
  readonly submittedAt: string;
  readonly approved: boolean;
  /** What the newest review of it says, when it has one (card P09 tells a review that asked for changes apart from one that has not been given). */
  readonly newest?: "approve" | "changes" | "reject";
  readonly approvedBy?: string;
  /** The review submission that approved it, when a reviewer did. */
  readonly reviewId?: string;
  /** Why it is not approved. */
  readonly reason?: string;
}
/** The reviews recorded about one submission, oldest first (record kind `submission-verdicts`, keyed by the subject's ID). */
interface VerdictsBody { readonly reviews: readonly { readonly id: string; readonly verdict: "approve" | "changes" | "reject"; readonly by: string; readonly at: string }[] }
const VERDICTS = "submission-verdicts";
const MAX_VERDICTS = 50;
/**
 * The newest document submissions of each project (card Q03b; record kind `document-submission-index`, keyed by the project ID), newest last. Submissions sit in one table in hash order of their IDs,
 * so "the newest document changes of a project" cannot be read from it without scanning everything; this index is written in the same write as each document submission, and keeps the newest
 * `DOC_INDEX_KEPT` (older ones drop off the front: the docs agent submits the change again). Only the IDs and tasks are kept; every read takes the record itself and applies the read rule of `get`.
 */
interface DocIndexBody { readonly items: readonly { readonly id: string; readonly taskId: string }[] }
const DOC_INDEX = "document-submission-index";
export const DOC_INDEX_KEPT = 100;
/**
 * A review's write met another review of the same subject written at the same moment (card H12o review): both changed the subject's verdict list. Not a refusal: the command is built again from the
 * list as it now is (`rebuildOnVerdictRace`), a few times, and only then answered `unavailable` (send it again).
 */
class VerdictRace extends DomainError {}
const VERDICT_RACE_TRIES = 5;
/** The service's runner, whose `command` builds a command again when its write lost a `VerdictRace`; everything else is the runner's own. */
function rebuildOnVerdictRace(runner: CommandRunner): CommandRunner {
  const command: CommandRunner["command"] = async (type, meta, prepare) => {
    for (let tries = 1; ; tries++) {
      try { return await runner.command(type, meta, prepare); } catch (error) { if (!(error instanceof VerdictRace) || tries >= VERDICT_RACE_TRIES) throw error; }
    }
  };
  return new Proxy(runner, { get: (target, key) => { if (key === "command") return command; const value: unknown = Reflect.get(target, key, target); return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value; } });
}

/** The recorded reason a review is not required: the project has no agent besides the worker that could review. */
export const REVIEW_DISABLED_SINGLE_AGENT = "review_disabled_single_agent" as const;

/** The roles a principal holds in one project, and for one task of it: roles are not global (an agent that is director in project X is not director in Y). */
export type RolesOf = (principalId: string, scope: { readonly projectId: string; readonly taskId: string }, by: Principal) => Promise<readonly string[]>;

/** The task's current attempt, when it has one: who owns it (a principal ID) and its state. Only an active attempt, or one that has just succeeded (the attempt is ending with this submission), may submit code. */
export type AttemptOf = (taskId: string) => Promise<{ readonly ownerId: string; readonly state: string; readonly attemptId?: string } | undefined>;

/** The attempt port over the assignment service: the task's active attempt, owned by the agent principal `agent:<id>`-style owner ID the assignment names. */
export const attemptOfAssignments = (assignments: AssignmentService): AttemptOf => async (taskId) => {
  const asg = await assignments.getAssignment(taskId);
  if (asg === undefined || asg.activeAttemptId === undefined) return undefined;
  const attempt = await assignments.getAttempt(asg.activeAttemptId);
  return attempt === undefined ? undefined : { ownerId: attempt.owner.id, state: attempt.state, attemptId: asg.activeAttemptId };
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
  /** How many of a project's newest document submissions its index keeps (card Q03b), injectable so a test can shrink it. Default `DOC_INDEX_KEPT`. */
  readonly docIndexKept?: number;
  /**
   * How many refresh rounds the task's author has made, as the controller counted them (card H12p, `WorkspaceOpService.refreshRounds`). When given, a code submission carries THAT number: the agent cannot state its own,
   * and a `refreshRound` it passes that differs is refused. Absent: the number given (default 0) is recorded, as before.
   */
  readonly refreshRounds?: (taskId: string) => Promise<number>;
  /** Told once a submission is recorded (card U09b), so the task's activity shows it and its replay can link to the diff or the review comment. Best effort and repeatable (keyed by the submission); a failure changes nothing. */
  readonly onRecorded?: (event: { readonly submissionId: string; readonly taskId: string; readonly kind: SubmissionKind; readonly role: string; readonly submittedBy: string; readonly verdict?: string; readonly decision?: string }) => Promise<void>;
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
 * the landing queue (P08..P10) and acceptance (Q01) read these records. A code submission names the attempt it came from when the attempt port is given.
 */
export class SubmissionService {
  readonly #runner: CommandRunner;
  readonly #roles: RolesOf;
  readonly #attemptOf: AttemptOf | undefined;
  readonly #reviewers: SubmissionOptions["reviewersAvailableIn"];
  readonly #assigned: SubmissionOptions["reviewAssignments"];
  readonly #onRecorded: SubmissionOptions["onRecorded"];
  readonly #rounds: SubmissionOptions["refreshRounds"];
  readonly #scan: { readonly pageSize: number; readonly reads: number };
  readonly #docKept: number;
  /** Per instance, never stored: a cursor from before a restart or from another instance does not open. */
  readonly #cursorKey = randomBytes(32);
  private constructor(runner: CommandRunner, roles: RolesOf, options: SubmissionOptions) {
    this.#runner = rebuildOnVerdictRace(runner); this.#roles = roles; this.#attemptOf = options.attemptOf; this.#reviewers = options.reviewersAvailableIn; this.#assigned = options.reviewAssignments; this.#onRecorded = options.onRecorded; this.#rounds = options.refreshRounds;
    this.#scan = { pageSize: options.listScan?.pageSize ?? LIST_PAGE, reads: options.listScan?.reads ?? LIST_READS };
    this.#docKept = options.docIndexKept ?? DOC_INDEX_KEPT;
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

  /**
   * `from` is for the controller's own callers only (the work.end ending, card H12n), never an agent argument: the attempt whose work is being submitted. The task's current attempt must then be
   * exactly that attempt, so an ending of an attempt that is no longer current (it ended and a newer attempt of the same agent took over) is refused instead of being recorded under the newer attempt.
   */
  async record(by: Principal, command: NoActor & RecordSubmission, from?: { readonly attemptId: string }): Promise<{ id: string; revision: number; replayed: boolean }> {
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
    const evidence = this.#evidence(command.evidence);
    const subject = command.subject === undefined ? undefined : await this.#subject(command.subject, taskId);
    let fields = this.#fields(by, kind, command, subject);
    const id = derivedId("sbm", scopedCommandId(by.id, commandId));
    // A repeat of this agent's own recorded code submission is compared with what the controller observed when it was first made (its refresh round and whether review was required),
    // not with today's count: a repeat after the attempt ended may come after a later refresh or a change of reviewers, and must still answer with the first record (card Q01b second review).
    // The ID is derived from this agent's own command ID, so only its own record is found here.
    const earlier = kind === "code" ? (await this.#runner.get("submission", id))?.body as unknown as SubmissionBody | undefined : undefined;
    const then = earlier !== undefined && earlier.submittedBy === by.id && earlier.taskId === taskId && earlier.kind === "code" ? earlier : undefined;
    // The refresh round is the controller's count, never the agent's word (card H12p review).
    if (kind === "code" && this.#rounds !== undefined) {
      const counted = then?.refreshRound ?? await this.#rounds(taskId);
      if (command.refreshRound !== undefined && command.refreshRound !== counted) bad("refreshRound", `is counted by the controller (${counted} for this task so far); leave it out`);
      fields = { ...fields, refreshRound: counted };
    }
    // Evidence belongs to one exact tree or artifact version; evidence for another is refused, not ignored.
    const bound = fields.tree ?? fields.artifactDigest;
    for (const e of evidence) if (e.boundTo !== bound) throw new DomainError("invalid_command", `evidence: ${e.check} is bound to ${e.boundTo}, not to the submitted ${fields.artifactDigest === undefined ? "tree" : "artifact"} ${String(bound)}`, { field: "evidence" });

    const review: SubmissionBody["review"] | undefined = kind !== "code" || this.#reviewers === undefined ? undefined : then?.review !== undefined ? then.review
      : (await this.#reviewers(task.projectId, by.id)).filter((r) => r !== by.id).length === 0 ? { required: false, reason: REVIEW_DISABLED_SINGLE_AGENT } : { required: true };
    const asked: SubmissionBody = { taskId, projectId: task.projectId, kind, role, submittedBy: by.id, submittedAt: this.#runner.now(), makesCommit: false, ...fields, evidence, ...(review === undefined ? {} : { review }) };
    let body: SubmissionBody = asked;
    const result = await this.#runner.command("submission.record", { commandId: scopedCommandId(by.id, commandId), actor: by.id }, async () => ({
      // Like the time, the attempt is what the controller observed, not what the agent asked: it is not in the compared payload (as before this field existed), so a replay keeps the first record
      // and its attempt, and records from before the field still replay.
      payload: { ...(asked as unknown as JsonObject), submittedAt: null },
      build: async () => {
        // The attempt is checked here, after the runner has looked for a repeat: a repeat of a recorded submission returns that record even when the attempt has ended since (the agent
        // retrying a lost answer after its attempt finished); a new code submission still needs the agent that owns the task's current attempt.
        if (kind === "code" && this.#attemptOf !== undefined) {
          const attempt = await this.#attemptOf(taskId);
          if (attempt === undefined || attempt.ownerId !== by.id || (attempt.state !== "active" && attempt.state !== "succeeded")) throw new DomainError("forbidden", "a code submission must come from the agent that owns the task's current attempt");
          if (from !== undefined && attempt.attemptId !== from.attemptId) throw new DomainError("forbidden", "the attempt this work came from is no longer the task's current attempt");
          if (attempt.attemptId !== undefined) body = { ...asked, attemptId: attempt.attemptId };
        }
        const ref = { kind: "submission", id };
        return { ref, creates: true, changes: [{ type: "create" as const, ref, body: body as unknown as JsonObject }, ...(await this.#verdictChange(id, body)), ...(await this.#docIndexChange(id, body))], detail: { taskId, kind, role }, contention: () => this.#contention(id, body) };
      },
    }));
    if (this.#onRecorded !== undefined) { try { await this.#onRecorded({ submissionId: result.id, taskId, kind, role, submittedBy: by.id, ...(body.verdict === undefined ? {} : { verdict: body.verdict }), ...(body.decision === undefined ? {} : { decision: body.decision }) }); } catch { /* the record of a step never changes what happened */ } }
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

  /** Why a submission's write lost to another write (the runner asks): its command ID was used by something else, unless the submission is not there and it is a review whose verdict list moved. */
  async #contention(id: string, body: SubmissionBody): Promise<DomainError> {
    if ((await this.#runner.get("submission", id)) === undefined && body.kind === "review") return new VerdictRace("unavailable", `another review of submission ${String(body.subject)} was recorded at the same moment; send this one again`);
    // Two document changes of one project at the same moment both add to the project's index (card Q03b): the one that lost is built again from the index as it now is.
    if ((await this.#runner.get("submission", id)) === undefined && body.kind === "document") return new VerdictRace("unavailable", `another document change of this project was recorded at the same moment; send this one again`);
    return new DomainError("command_conflict", `submission ${id} already exists, so this command ID was used by something else`);
  }

  /**
   * The verdicts on a submission, kept with it (card H12o): each review recorded about a code submission is added to the subject's verdict list in the same write as the review itself, so whether it is approved is read
   * from one record, never by scanning every submission. At most `MAX_VERDICTS` reviews of one submission are kept; one more is refused (the work should be submitted again by then).
   */
  async #verdictChange(id: string, body: SubmissionBody): Promise<Change[]> {
    if (body.kind !== "review" || body.subject === undefined || body.verdict === undefined) return [];
    const ref = { kind: VERDICTS, id: body.subject };
    const current = await this.#runner.get(VERDICTS, body.subject);
    const list = ((current?.body as unknown as VerdictsBody | undefined)?.reviews ?? []);
    if (list.some((r) => r.id === id)) return [];
    if (list.length >= MAX_VERDICTS) throw new DomainError("unavailable", `submission ${body.subject} already has ${MAX_VERDICTS} reviews; submit the work again for a new review`);
    const next: VerdictsBody = { reviews: [...list, { id, verdict: body.verdict, by: body.submittedBy, at: body.submittedAt }] };
    return [current === undefined ? { type: "create", ref, body: next as unknown as JsonObject } : { type: "update", ref, expectedRevision: current.revision, body: next as unknown as JsonObject }];
  }

  /** A document submission is added to its project's index in the same write (card Q03b); the oldest entries beyond `DOC_INDEX_KEPT` drop off. */
  async #docIndexChange(id: string, body: SubmissionBody): Promise<Change[]> {
    if (body.kind !== "document") return [];
    const ref = { kind: DOC_INDEX, id: body.projectId };
    const current = await this.#runner.get(DOC_INDEX, body.projectId);
    const list = ((current?.body as unknown as DocIndexBody | undefined)?.items ?? []);
    if (list.some((x) => x.id === id)) return [];
    const next: DocIndexBody = { items: [...list, { id, taskId: body.taskId }].slice(-this.#docKept) };
    return [current === undefined ? { type: "create", ref, body: next as unknown as JsonObject } : { type: "update", ref, expectedRevision: current.revision, body: next as unknown as JsonObject }];
  }

  /**
   * The newest document submissions of a project (card Q03b), newest first, from the project's index (the newest `DOC_INDEX_KEPT` only). Each is filtered exactly as `get` is: the owner sees all; an
   * agent sees one only when it may read its task (and with a task credential only that task) and made it or was asked to review it. A project the caller may not read at all is `not_found`.
   * `since` keeps those recorded no earlier than that time (the record's creation time, the one `doc.obligation.verify` compares with a flag). Paged: `next` is an opaque cursor bound to the caller and
   * the project. Work is bounded by the index's size.
   */
  async documents(by: Principal, projectIdValue: string, query: { since?: string; afterId?: string; limit: number }): Promise<{ items: (Item & { createdAt: string })[]; next?: string }> {
    const projectId = checkProjectId(projectIdValue);
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 50) bad("limit", "must be a whole number from 1 to 50");
    if (query.since !== undefined && (typeof query.since !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(query.since))) bad("since", "must be a time like 2026-11-19T10:00:00.000Z");
    const scope = `project:${projectId}`;
    const after = query.afterId === undefined ? undefined : this.#unseal(by, scope, query.afterId);
    if ((await this.#runner.get("project", projectId)) === undefined) throw new DomainError("not_found", "no such project");
    if (by.kind !== "owner" && (by.kind !== "agent" || (by.taskScope !== undefined && !inTaskScope(by, projectId)) || !allows(by, "task.read", projectId))) throw new DomainError("not_found", "no such project");
    const index = [...(((await this.#runner.get(DOC_INDEX, projectId))?.body as unknown as DocIndexBody | undefined)?.items ?? [])].reverse();
    let start = 0;
    if (after !== undefined) { const at = index.findIndex((x) => x.id === after); start = at < 0 ? index.length : at + 1; }
    const items: (Item & { createdAt: string })[] = [];
    const tasks = new Map<string, { task: TaskBody | undefined; assigned: ReadonlySet<string> }>();
    for (let k = start; k < index.length; k++) {
      const entry = index[k]!;
      const found = await this.#runner.get("submission", entry.id);
      const body = found?.body as unknown as SubmissionBody | undefined;
      if (found === undefined || body === undefined || body.kind !== "document" || body.projectId !== projectId) continue;
      if (query.since !== undefined && found.createdAt < query.since) continue;
      if (by.kind !== "owner") {
        let seen = tasks.get(body.taskId);
        if (seen === undefined) { const task = await this.#readableTask(by, body.taskId); seen = { task, assigned: task === undefined ? new Set() : await this.#assignedTo(by, task, body.taskId) }; tasks.set(body.taskId, seen); }
        if (seen.task === undefined || (body.submittedBy !== by.id && !seen.assigned.has(entry.id))) continue;
      }
      items.push({ ...body, ...(body.report === undefined ? {} : { report: redactText(body.report) }), id: found.id, revision: found.revision, createdAt: found.createdAt });
      if (items.length >= query.limit) return { items, ...(k + 1 < index.length ? { next: this.#seal(by, scope, entry.id) } : {}) };
    }
    return { items };
  }

  /**
   * Whether a code submission is approved, for the controller's own callers (card H12o: the commit of an approved submission). It takes no caller and is not an API operation: whoever asks has been checked already (the
   * workspace request needs `workspace.manage`). Approved means the NEWEST review of it says `approve` (a later `changes` or `reject` takes an approval back; a review of one's own work was refused when it was recorded),
   * or the submission recorded that no review is required because no other agent of the project could review (`review_disabled_single_agent`). `undefined` when there is no such code submission.
   */
  async approvalOf(submissionId: string): Promise<SubmissionApproval | undefined> {
    if (typeof submissionId !== "string" || !/^sbm-[a-z2-7]{20}$/.test(submissionId)) return undefined;
    const found = (await this.#runner.get("submission", submissionId))?.body as unknown as SubmissionBody | undefined;
    if (found === undefined || found.kind !== "code" || found.base === undefined || found.tree === undefined) return undefined;
    const reviews = ((await this.#runner.get(VERDICTS, submissionId))?.body as unknown as VerdictsBody | undefined)?.reviews ?? [];
    const newest = reviews[reviews.length - 1];
    const base = { submissionId, taskId: found.taskId, projectId: found.projectId, base: found.base, tree: found.tree, ...(found.patchId === undefined ? {} : { patchId: found.patchId }), submittedBy: found.submittedBy, submittedAt: found.submittedAt };
    if (newest !== undefined) return newest.verdict === "approve" ? { ...base, approved: true, approvedBy: newest.by, reviewId: newest.id, newest: "approve" } : { ...base, approved: false, newest: newest.verdict, reason: `its newest review (${newest.id}) says ${newest.verdict}` };
    if (found.review?.required === false && found.review.reason === REVIEW_DISABLED_SINGLE_AGENT) return { ...base, approved: true, approvedBy: REVIEW_DISABLED_SINGLE_AGENT };
    return { ...base, approved: false, reason: "no reviewer has approved it yet" };
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
