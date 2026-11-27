import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import type { AssignmentService } from "../domain/assignments.js";
import { assignmentIdOf } from "../domain/assignment-model.js";
import { derivedId } from "../domain/ids.js";
import { artifactId as checkArtifactId, commandId as checkCommandId, projectId as checkProjectId, taskId as checkTaskId, text, type TaskBody } from "../domain/model.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { allows, inTaskScope } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { Change, ControllerStorage, JsonObject } from "../storage/types.js";
import { readApprovalReliance, readReviewCite, relianceBasis, shapeReviewCite } from "./review-citation.js";
import { dependencyChangesNow, dependencyChangeText, readDependencyBasis } from "./dependency-basis.js";
import { approvalOutdated, type ApprovalBasis } from "./approval-standing.js";
import { CONTRIBUTOR_APPROVAL_TEXT, CONTRIBUTOR_SIGNOFF_TEXT, CONTRIBUTORS, contributorChange, principalOf, taskContributors } from "./contributors.js";

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
  /** A review only, and only when it cites (card Q02, sixth slice): the task contract version it judged against, the owner decisions it names (and the version of each when it was recorded) and, for a rejection, the owner requirement it found unmet. Absent on every earlier review. */
  readonly criteriaRevision?: number;
  readonly decisions?: readonly string[];
  readonly decisionVersions?: Readonly<Record<string, number>>;
  readonly unmet?: string;
  /**
   * An approval only (card Q02, stale approvals): the contract version, the relied-on decisions and the recorded dependencies it was judged against, read by the controller when it was recorded; absent on earlier
   * approvals. Also on code recorded with `review_disabled_single_agent` (card Q02): what that code was accepted against, so the same changes take it back.
   */
  readonly judgedAgainst?: ApprovalBasis;
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
  /** Set when the review it answers with is an earlier submission's of the same task and the same patch ID (card Q02): the submission the verdict was given on. */
  readonly carriedFrom?: string;
  /** What the newest review of it says, when it has one (card P09 tells a review that asked for changes apart from one that has not been given). */
  readonly newest?: "approve" | "changes" | "reject";
  /** What the newest review cites (the criteria version, the decisions and, for a rejection, the unmet requirement), when it cites anything (card Q02, sixth slice). */
  readonly cited?: ReviewCited;
  readonly approvedBy?: string;
  /** The review submission that approved it, when a reviewer did. */
  readonly reviewId?: string;
  /** Why it is not approved. */
  readonly reason?: string;
  /**
   * Set when its newest review is an approval that no longer counts (card Q02): a decision the task relies on, or the task contract's criteria, changed after it was given (`approvalOutdated`). `because` says what changed and
   * when, in plain words; a new review judged against the current decisions and criteria restores the approval.
   */
  readonly outdated?: { readonly reviewId: string; readonly approvedBy: string; readonly approvedAt: string; readonly because: string };
  /** The check evidence the author recorded on the submission (Q01b), each bound to its tree; present only when there is some (P09 fifth slice compares it with the landing gate's own results). */
  readonly evidence?: readonly Evidence[];
  /** What the newest director sign-off of it says (card P09 sixth slice, the `director` required check); present only when a director has signed off on it (either way). */
  readonly director?: { readonly newest: "approve" | "decline"; readonly by: string; readonly signoffId: string };
  /**
   * Card Q04: set, instead of `director`, when the newest director sign-off is an approval by an agent that contributed code to the task (read now, `contributors.ts`): it does not count, and `reason` says so in plain words.
   */
  readonly directorNotCounted?: { readonly by: string; readonly signoffId: string; readonly reason: string };
}
/** The reviews recorded about one submission, oldest first (record kind `submission-verdicts`, keyed by the subject's ID). */
interface VerdictsBody { readonly reviews: readonly { readonly id: string; readonly verdict: "approve" | "changes" | "reject"; readonly by: string; readonly at: string; readonly cited?: ReviewCited; readonly basis?: ApprovalBasis }[] }
/** What a review cited, as kept with the subject's verdict list and answered by `approvalOf` (card Q02, sixth slice). */
export interface ReviewCited { readonly criteriaRevision: number; readonly decisions: readonly { readonly id: string; readonly version: number }[]; readonly unmet?: string }
const VERDICTS = "submission-verdicts";
/** The code submissions of one task that name one patch ID, oldest first (card Q02: what carries over to a later submission of an unchanged patch). */
interface LineageBody { readonly taskId: string; readonly patchId: string; readonly ids: readonly string[] }
const LINEAGE = "patch-lineage";
const MAX_LINEAGE = 20;
const PATCH = /^[0-9a-f]{40,64}$/;
const lineageId = (taskId: string, patchId: string): string => createHash("sha256").update(`${taskId}\0${patchId}`).digest("hex").slice(0, 32);
/** The director sign-offs recorded about one submission, oldest first (record kind `submission-signoffs`, keyed by the subject's ID; written in the same write as the sign-off, like the reviews). */
interface SignoffsBody { readonly signoffs: readonly { readonly id: string; readonly decision: "approve" | "decline"; readonly by: string; readonly at: string }[] }
const SIGNOFFS = "submission-signoffs";
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
 * The code submissions of each project (card Q01b sixth slice; record kind `code-submission-index`, keyed by the project ID): the newest code of each task by each submitting agent, written in the SAME write as the
 * code submission it indexes (revision-checked: a write that met another code submission of the project is built again, as for document changes). `complete` says every code submission of the project is covered:
 * an index first written for a project that already has code is seeded by one bounded scan of the table (`complete` only when that scan reached the end), and `complete` turns false when more than `CODE_INDEX_KEPT`
 * entries would be kept (the oldest drop off). Only IDs, tasks, authors and times are kept; every read takes the submission itself. An absent or unreadable index is never trusted: the waiting view then scans.
 */
interface CodeIndexBody {
  readonly complete: boolean; readonly entries: readonly { readonly taskId: string; readonly id: string; readonly at: string; readonly by: string }[];
  /**
   * Card Q04: `true` when the index was first written by the code submission that was the project's first code at all (its seed scan reached the end of the table and found none), so every code submission of the
   * project was written together with its task's contributor record (`contributors.ts`): a task without that record has no code, and its first code submission needs no seed scan. Kept by every later write; never
   * set on an index that existed before, or was seeded with older code.
   */
  readonly contributorsRecorded?: true;
}
const CODE_INDEX = "code-submission-index";
export const CODE_INDEX_KEPT = 500;
/** A stored code index as the service reads it: `undefined` when absent or not readable as an index (then it is not trusted). */
function codeIndexOf(found: { readonly body: unknown; readonly revision: number } | undefined): { body: CodeIndexBody; revision: number } | undefined {
  const b = found?.body as Partial<CodeIndexBody> | undefined;
  if (found === undefined || b === undefined || b === null || typeof b.complete !== "boolean" || !Array.isArray(b.entries)) return undefined;
  if (!b.entries.every((e) => e !== null && typeof e === "object" && typeof e.taskId === "string" && typeof e.id === "string" && typeof e.at === "string" && typeof e.by === "string")) return undefined;
  return { body: b as CodeIndexBody, revision: found.revision };
}
/**
 * A review's write met another review of the same subject written at the same moment (card H12o review): both changed the subject's verdict list. Not a refusal: the command is built again from the
 * list as it now is (`rebuildOnVerdictRace`), a few times, and only then answered `unavailable` (send it again).
 */
class VerdictRace extends DomainError {}
const VERDICT_RACE_TRIES = 5;
/**
 * A document change whose write met another document change of the same project (card Q03b second review): both added to the project's index. Document changes of DIFFERENT tasks did not meet before
 * the index existed, so a burst of them (a release flags many documents at once) must not fail: each lost write is built again after a short random wait, many more times than a review race
 * (20 at once all succeed), and only then answered `unavailable`.
 */
class DocIndexRace extends VerdictRace {}
const DOC_INDEX_RACE_TRIES = 40;
const docIndexRaceWait = (tries: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, Math.random() * Math.min(2 ** tries, 50)); });
/** The service's runner, whose `command` builds a command again when its write lost a `VerdictRace`; everything else is the runner's own. */
function rebuildOnVerdictRace(runner: CommandRunner): CommandRunner {
  const command: CommandRunner["command"] = async (type, meta, prepare) => {
    for (let tries = 1; ; tries++) {
      try { return await runner.command(type, meta, prepare); } catch (error) {
        if (!(error instanceof VerdictRace) || tries >= (error instanceof DocIndexRace ? DOC_INDEX_RACE_TRIES : VERDICT_RACE_TRIES)) throw error;
        if (error instanceof DocIndexRace) await docIndexRaceWait(tries);
      }
    }
  };
  return new Proxy(runner, { get: (target, key) => { if (key === "command") return command; const value: unknown = Reflect.get(target, key, target); return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value; } });
}

/** The recorded reason a review is not required: the project has no agent besides the worker that could review. */
export const REVIEW_DISABLED_SINGLE_AGENT = "review_disabled_single_agent" as const;

/** The roles a principal holds in one project, and for one task of it: roles are not global (an agent that is director in project X is not director in Y). */
export type RolesOf = (principalId: string, scope: { readonly projectId: string; readonly taskId: string }, by: Principal) => Promise<readonly string[]>;

/** The task's current attempt, when it has one: who owns it (a principal ID) and its state. Only an active attempt, or one that has just succeeded (the attempt is ending with this submission), may submit code. */
export type AttemptOf = (taskId: string) => Promise<{ readonly ownerId: string; readonly state: string; readonly attemptId?: string; readonly guards?: readonly AttemptGuard[] } | undefined>;
/** A record the attempt check read, at the revision it read it (card Q01b): the submission commits only if each is still at that revision, so an attempt that ends or moves between the read and the write is not recorded under. */
export interface AttemptGuard { readonly kind: string; readonly id: string; readonly revision: number }

/** The attempt port over the assignment service: the task's active attempt, owned by the agent principal `agent:<id>`-style owner ID the assignment names. */
export const attemptOfAssignments = (assignments: AssignmentService): AttemptOf => async (taskId) => {
  const asg = await assignments.getAssignment(taskId);
  if (asg === undefined || asg.activeAttemptId === undefined) return undefined;
  const attempt = await assignments.getAttempt(asg.activeAttemptId);
  return attempt === undefined ? undefined : { ownerId: attempt.owner.id, state: attempt.state, attemptId: asg.activeAttemptId, guards: [{ kind: "assignment", id: assignmentIdOf(taskId), revision: asg.revision }, { kind: "attempt", id: asg.activeAttemptId, revision: attempt.revision }] };
};

/** The port the controller uses (`start.ts`): as `attemptOfAssignments`, with the owner named as a principal. The dispatcher names an attempt's owner by its bare agent ID, the principals by
 * `agent:<id>`: the same identity either way. Everything else, the guards included, is passed on unchanged. */
export const attemptOfAgents = (assignments: AssignmentService): AttemptOf => {
  const of = attemptOfAssignments(assignments);
  return async (taskId) => { const a = await of(taskId); return a === undefined ? undefined : { ...a, ownerId: a.ownerId.startsWith("agent:") ? a.ownerId : `agent:${a.ownerId}` }; };
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
  /** How many tasks one project-wide waiting view reads (card Q01b fifth slice), injectable so a test can shrink it. Default `WAITING_TASKS`. */
  readonly waitingTasks?: number;
  /** How many submission rows one project-wide waiting view scans (card Q01b fifth slice review), injectable so a test can shrink it. Default `WAITING_SCAN`. */
  readonly waitingScan?: { readonly pageSize: number; readonly reads: number };
  /** How many (task, agent) entries one project's code index keeps (card Q01b sixth slice), injectable so a test can shrink it. Default `CODE_INDEX_KEPT`; 0 writes no index at all (what data written before the index existed looks like). */
  readonly codeIndexKept?: number;
  /**
   * How many refresh rounds the task's author has made, as the controller counted them (card H12p, `WorkspaceOpService.refreshRounds`). When given, a code submission carries THAT number: the agent cannot state its own,
   * and a `refreshRound` it passes that differs is refused. Absent: the number given (default 0) is recorded, as before.
   */
  readonly refreshRounds?: (taskId: string) => Promise<number>;
  /**
   * How a review of this task cites (card Q02, `QaReviewService.citationRule`): `explicit` (every verdict names `criteriaRevision`), `rejections` (the controller's default: a rejection names its unmet owner requirement),
   * `optional`. Absent: `optional` (a service built without the controller's policy, as unit tests are). Every verdict records the criteria version it was judged against whatever the rule.
   */
  readonly citationRule?: (projectId: string, taskId: string) => Promise<"explicit" | "rejections" | "optional">;
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
  readonly criteriaRevision?: number;
  readonly decisions?: readonly string[];
  readonly unmet?: string;
  readonly decision?: string;
  readonly report?: string;
  readonly artifactDigest?: string;
  readonly artifactId?: string;
  readonly evidence?: readonly Evidence[];
}

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ID = /^(?:sbm|art)-[a-z2-7]{20}$/;
const FIELDS = ["commandId", "taskId", "kind", "role", "base", "tree", "patchId", "refreshRound", "subject", "verdict", "criteriaRevision", "decisions", "unmet", "decision", "report", "artifactDigest", "artifactId", "evidence"] as const;
/** What each kind may carry besides taskId, kind and role (and evidence). A field outside the list is refused, so a non-code kind cannot carry a base, a tree or a patch. */
const ALLOWED: Readonly<Record<SubmissionKind, readonly string[]>> = {
  code: ["base", "tree", "patchId", "refreshRound"],
  review: ["subject", "verdict", "criteriaRevision", "decisions", "unmet"],
  qa: ["subject", "report"],
  document: ["artifactDigest", "artifactId", "report"],
  signoff: ["subject", "decision"],
};
const LIST_PAGE = 200;
const LIST_READS = 10;
type Item = SubmissionBody & { id: string; revision: number };

/** One task's newest code submission in the project-wide waiting view (`SubmissionService.waiting`). */
export interface WaitingItem {
  readonly taskId: string; readonly title: string; readonly submissionId: string; readonly submittedBy: string; readonly submittedAt: string; readonly tree: string;
  readonly state: "needs_review" | "changes_asked" | "signoff_declined" | "needs_signoff" | "ready";
  readonly approvedBy?: string;
}
export interface WaitingView {
  readonly projectId: string;
  /** True when the caller is an agent: only the code it submitted itself is read. */
  readonly ownOnly: boolean;
  readonly counts: { readonly needs_review: number; readonly changes_asked: number; readonly signoff_declined: number; readonly needs_signoff: number; readonly ready: number };
  readonly items: readonly WaitingItem[];
  readonly truncated: boolean;
  readonly scanLimited: boolean;
  /** Where the code list came from: `index` (the project's complete code index, no scan) or `scan` (no usable complete index: the table was scanned, bounded). */
  readonly source: "index" | "scan";
}
/** The most tasks one waiting view reads (newest code first). */
export const WAITING_TASKS = 200;
/**
 * The most submission rows one waiting view scans: as many as the project's QA view (`QA_LIMITS.projectScanReads` reads of 500), more than a task's `list` scans, because the submissions of every project share one table in hash order
 * of IDs (there is no index by project or task), so a project with little code is only seen in full when the whole table fits this bound.
 */
export const WAITING_SCAN = { pageSize: 500, reads: 20 } as const;
/** How many tasks' records the waiting view reads at once. */
const WAITING_AT_ONCE = 8;
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
  readonly #waitingTasks: number;
  readonly #waitingScan: { readonly pageSize: number; readonly reads: number };
  readonly #codeKept: number;
  readonly #citationRule: SubmissionOptions["citationRule"];
  /** Per instance, never stored: a cursor from before a restart or from another instance does not open. */
  readonly #cursorKey = randomBytes(32);
  private constructor(runner: CommandRunner, roles: RolesOf, options: SubmissionOptions) {
    this.#runner = rebuildOnVerdictRace(runner); this.#roles = roles; this.#attemptOf = options.attemptOf; this.#reviewers = options.reviewersAvailableIn; this.#assigned = options.reviewAssignments; this.#onRecorded = options.onRecorded; this.#rounds = options.refreshRounds;
    this.#scan = { pageSize: options.listScan?.pageSize ?? LIST_PAGE, reads: options.listScan?.reads ?? LIST_READS };
    this.#docKept = options.docIndexKept ?? DOC_INDEX_KEPT;
    this.#waitingTasks = options.waitingTasks ?? WAITING_TASKS;
    this.#waitingScan = options.waitingScan ?? WAITING_SCAN;
    this.#codeKept = options.codeIndexKept ?? CODE_INDEX_KEPT;
    this.#citationRule = options.citationRule;
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
    // The ending's step keys (`workend:<attempt>:<step>`) are the controller's: the ending takes a submission recorded under its key as the one it staged (card H12n second slice), so an agent may not make one under it.
    if (from === undefined && commandId.startsWith("workend:")) bad("commandId", "starting with workend: is kept for the controller's ending of an attempt; use another command ID");
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
    let guards: readonly AttemptGuard[] = [];
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
          guards = attempt.guards ?? [];
        }
        // A review that cites is read against the task as it is now, and every approval against the decisions the task relies on (a replay above never gets here, so it keeps what the first record read).
        let citeChecks: Change[] = [];
        const addChecks = (more: readonly Change[]): void => { for (const c of more) if (!citeChecks.some((k) => k.ref.kind === c.ref.kind && k.ref.id === c.ref.id)) citeChecks.push(c); };
        // Card Q02: code accepted without a review (no other agent could review it) keeps what it was accepted against, as an approval does, so a later correction, criteria change or changed dependency takes it back.
        if (kind === "code" && body.review?.required === false) {
          if (then?.judgedAgainst !== undefined) body = { ...body, judgedAgainst: then.judgedAgainst };
          else {
            const contract = await this.#runner.get("task-contract", taskId);
            const relied = await relianceBasis(this.#runner, taskId);
            const deps = await readDependencyBasis(this.#runner, taskId);
            addChecks([...(contract === undefined ? [] : [{ type: "check" as const, ref: { kind: "task-contract", id: taskId }, expectedRevision: contract.revision }]), ...relied.changes, ...deps.changes]);
            body = { ...body, judgedAgainst: { criteriaRevision: (contract?.body as unknown as { version?: number } | undefined)?.version ?? 0, decisions: relied.relied, dependencies: deps.snapshot } };
          }
        }
        // Card Q02: how this verdict cites. A project whose review policy asks every verdict to cite refuses one that names no criteria version; by default a rejection names the owner requirement it found unmet.
        const rule = kind === "review" && this.#citationRule !== undefined ? await this.#citationRule(task.projectId, taskId) : "optional";
        if (kind === "review" && asked.criteriaRevision === undefined && rule === "explicit") bad("criteriaRevision", "this project's review policy requires a verdict to cite what it was judged against: add criteriaRevision (the task contract version you read its acceptance criteria at; 0 when the task has none), name in decisions every owner decision the task relies on when you approve, and add unmet (the owner requirement that is not met) when you reject");
        if (kind === "review" && asked.verdict === "reject" && asked.unmet === undefined && rule !== "optional") bad("unmet", "a rejection names the owner requirement that is not met: add unmet (the acceptance criterion or owner decision, in your words); the task contract version in force is recorded with it unless you name one in criteriaRevision. The owner can make this optional for a project");
        // A rejection that names its unmet requirement and no version is judged against the criteria in force: that version is cited for it (read here, after the runner looked for a repeat, so a repeat keeps the first).
        if (kind === "review" && asked.criteriaRevision === undefined && asked.unmet !== undefined) {
          const version = ((await this.#runner.get("task-contract", taskId))?.body as unknown as { version?: number } | undefined)?.version ?? 0;
          const read = await readReviewCite(this.#runner, { projectId: task.projectId, taskId }, { criteriaRevision: version, decisions: [] });
          citeChecks = [...read.changes];
          body = { ...body, criteriaRevision: version, decisions: [], decisionVersions: read.versions };
        }
        // Card Q02: a request for changes, or a rejection, that cites nothing still records the criteria version and the decisions it was judged against (an approval keeps them in `judgedAgainst` below).
        if (kind === "review" && asked.verdict !== "approve" && body.criteriaRevision === undefined) {
          const contract = await this.#runner.get("task-contract", taskId);
          const relied = await relianceBasis(this.#runner, taskId);
          addChecks([...(contract === undefined ? [] : [{ type: "check" as const, ref: { kind: "task-contract", id: taskId }, expectedRevision: contract.revision }]), ...relied.changes]);
          body = { ...body, judgedAgainst: { criteriaRevision: (contract?.body as unknown as { version?: number } | undefined)?.version ?? 0, decisions: relied.relied } };
        }
        if (kind === "review" && asked.criteriaRevision !== undefined) {
          const read = await readReviewCite(this.#runner, { projectId: task.projectId, taskId }, { criteriaRevision: asked.criteriaRevision, decisions: asked.decisions ?? [] });
          citeChecks = [...read.changes];
          body = { ...body, decisionVersions: read.versions };
        }
        // Card Q04: an agent that contributed code to the task (any version of it) cannot approve it, as the author of the version cannot. Checked here, after the runner looked for a repeat, so a
        // repeat of an approval recorded before still answers with that record. The task's contributor record is checked by the write, so a code submission of the reviewer at the same moment builds this again.
        // The same holds for a director's sign-off approving code (the director's own landing approval): a decline only holds the work back and is still taken.
        let contributorCheck: Change[] = [];
        if (((kind === "review" && asked.verdict === "approve") || (kind === "signoff" && asked.decision === "approve")) && subject?.kind === "code") {
          if ((await taskContributors(this.#runner, task.projectId, taskId, [subject.submittedBy])).has(principalOf(by.id))) throw new DomainError("forbidden", kind === "signoff" ? CONTRIBUTOR_SIGNOFF_TEXT : CONTRIBUTOR_APPROVAL_TEXT);
          const record = await this.#runner.get(CONTRIBUTORS, taskId);
          if (record !== undefined) contributorCheck = [{ type: "check", ref: { kind: CONTRIBUTORS, id: taskId }, expectedRevision: record.revision }];
        }
        if (kind === "review" && asked.verdict === "approve") {
          const named = asked.criteriaRevision === undefined ? undefined : asked.decisions ?? [];
          const relied = await readApprovalReliance(this.#runner, taskId, named);
          const more: Change[] = [...relied.changes];
          // Card Q02 (stale approvals): the approval keeps what it was judged against, so a later correction of a relied-on decision or a change of the criteria takes it back when it is read (`approvalOutdated`).
          // The contract version is checked by the write too, so a contract change racing the approval lands strictly before (and is recorded) or after it (and takes it back).
          let criteriaRevision = asked.criteriaRevision;
          if (criteriaRevision === undefined) {
            const contract = await this.#runner.get("task-contract", taskId);
            criteriaRevision = (contract?.body as unknown as { version?: number } | undefined)?.version ?? 0;
            if (contract !== undefined) more.push({ type: "check", ref: { kind: "task-contract", id: taskId }, expectedRevision: contract.revision });
          }
          // Card Q02: and the task's recorded dependencies; one already seen changed refuses the approval, as a superseded decision does.
          const changedNow = await dependencyChangesNow(this.#runner, taskId, 1);
          if (changedNow.length > 0) bad("verdict", `${dependencyChangeText(changedNow[0]!)}: an approval waits until the task's agent has looked at the work against it again (and records it again); a request for changes or a rejection can be recorded now`);
          const deps = await readDependencyBasis(this.#runner, taskId);
          addChecks([...more, ...deps.changes]);
          body = { ...body, judgedAgainst: { criteriaRevision, decisions: relied.relied, dependencies: deps.snapshot } };
        }
        const ref = { kind: "submission", id };
        return { ref, creates: true, changes: [{ type: "create" as const, ref, body: body as unknown as JsonObject }, ...citeChecks, ...(await this.#verdictChange(id, body)), ...(await this.#lineageChange(id, body)), ...(await this.#signoffChange(id, body)), ...(await this.#docIndexChange(id, body)), ...(await this.#codeIndexChange(id, body)), ...(await this.#contributorChange(body)), ...contributorCheck, ...guards.map((g) => ({ type: "check" as const, ref: { kind: g.kind, id: g.id }, expectedRevision: g.revision }))], detail: { taskId, kind, role }, contention: async () => (await this.#guarded(guards)) ?? await this.#contention(id, body) };
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

  /** When a record the attempt check read has changed since (the attempt ended, or the task moved to another agent, between the read and the write), the refusal; otherwise nothing. */
  async #guarded(guards: readonly AttemptGuard[]): Promise<DomainError | undefined> {
    for (const g of guards) if ((await this.#runner.get(g.kind, g.id))?.revision !== g.revision) return new DomainError("forbidden", "the task's attempt changed while this submission was being recorded, so it was not recorded; check the task and send it again if it is still yours");
    return undefined;
  }

  /**
   * A director sign-off is kept in its subject's own list (the landing's `director` check reads it by the subject, never by scanning the table). The newest `MAX_VERDICTS` are kept and older ones drop off the
   * front: only the newest decides, so a sign-off is never refused for the list's size (a decline after many approvals must still take an approval back).
   */
  async #signoffChange(id: string, body: SubmissionBody): Promise<Change[]> {
    if (body.kind !== "signoff" || body.subject === undefined || body.decision === undefined) return [];
    const ref = { kind: SIGNOFFS, id: body.subject };
    const current = await this.#runner.get(SIGNOFFS, body.subject);
    const list = ((current?.body as unknown as SignoffsBody | undefined)?.signoffs ?? []);
    if (list.some((r) => r.id === id)) return [];
    const next: SignoffsBody = { signoffs: [...list, { id, decision: body.decision, by: body.submittedBy, at: body.submittedAt }].slice(-MAX_VERDICTS) };
    return [current === undefined ? { type: "create", ref, body: next as unknown as JsonObject } : { type: "update", ref, expectedRevision: current.revision, body: next as unknown as JsonObject }];
  }
  /** Why a submission's write lost to another write (the runner asks): its command ID was used by something else, unless the submission is not there and it is a review or sign-off whose list moved. */
  async #contention(id: string, body: SubmissionBody): Promise<DomainError> {
    if ((await this.#runner.get("submission", id)) === undefined && (body.kind === "review" || body.kind === "signoff")) return new VerdictRace("unavailable", `another ${body.kind === "signoff" ? "sign-off" : "review"} of submission ${String(body.subject)} was recorded at the same moment; send this one again`);
    // Two document changes of one project at the same moment both add to the project's index (card Q03b): the one that lost is built again from the index as it now is.
    if ((await this.#runner.get("submission", id)) === undefined && body.kind === "document") return new DocIndexRace("unavailable", `another document change of this project was recorded at the same moment; send this one again`);
    if ((await this.#runner.get("submission", id)) === undefined && body.kind === "code") return new DocIndexRace("unavailable", `another code submission of this project was recorded at the same moment; send this one again`);
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
    const cited: ReviewCited | undefined = body.criteriaRevision === undefined ? undefined : { criteriaRevision: body.criteriaRevision, decisions: (body.decisions ?? []).map((d) => ({ id: d, version: body.decisionVersions?.[d] ?? 0 })), ...(body.unmet === undefined ? {} : { unmet: body.unmet }) };
    const next: VerdictsBody = { reviews: [...list, { id, verdict: body.verdict, by: body.submittedBy, at: body.submittedAt, ...(cited === undefined ? {} : { cited }), ...(body.judgedAgainst === undefined ? {} : { basis: body.judgedAgainst }) }] };
    return [current === undefined ? { type: "create", ref, body: next as unknown as JsonObject } : { type: "update", ref, expectedRevision: current.revision, body: next as unknown as JsonObject }];
  }

  /**
   * Code with one patch ID (card Q02, "a verdict carries over only by unchanged patch-id"): each code submission is added, in the same write, to the list of its task's submissions with the same patch ID,
   * so a later submission of the same patch (a rebase onto a new base) can be recognised, and a changed patch never can. Only IDs are kept (at most `MAX_LINEAGE`, the oldest drop off); data written before this
   * has no list, so nothing carries over from it (fail closed).
   */
  async #lineageChange(id: string, body: SubmissionBody): Promise<Change[]> {
    if (body.kind !== "code" || body.patchId === undefined || !PATCH.test(body.patchId)) return [];
    const lineage = lineageId(body.taskId, body.patchId);
    const current = await this.#runner.get(LINEAGE, lineage);
    const ids = ((current?.body as unknown as LineageBody | undefined)?.ids ?? []);
    if (ids.includes(id)) return [];
    const next: LineageBody = { taskId: body.taskId, patchId: body.patchId, ids: [...ids, id].slice(-MAX_LINEAGE) };
    const ref = { kind: LINEAGE, id: lineage };
    return [current === undefined ? { type: "create", ref, body: next as unknown as JsonObject } : { type: "update", ref, expectedRevision: current.revision, body: next as unknown as JsonObject }];
  }

  /**
   * The earlier code submissions of the same task whose patch ID is the same as this one's (a rebase keeps the patch ID; any change to the patch changes it), newest first. The controller's own question (the QA gate
   * and `approvalOf`); takes no caller. A submission without a patch ID, or none recorded in the lineage, has none.
   */
  async carriedFrom(submissionId: string): Promise<readonly string[]> {
    return (await this.carriedSources(submissionId)).map((s) => s.submissionId);
  }

  /**
   * `carriedFrom` with each earlier submission's base and tree (card Q02 review): the landing gate has the host compute the real patch ID of each, since a submission's `patchId` is only its submitter's word.
   * Only entries listed BEFORE this submission in the lineage count (the order the writes were made in, so two submissions recorded in the same millisecond never inherit from each other); a submission no longer in
   * the lineage (dropped as the oldest) has none.
   */
  async carriedSources(submissionId: string): Promise<readonly { readonly submissionId: string; readonly base: string; readonly tree: string; readonly submittedBy: string }[]> {
    if (typeof submissionId !== "string" || !/^sbm-[a-z2-7]{20}$/.test(submissionId)) return [];
    const found = (await this.#runner.get("submission", submissionId))?.body as unknown as SubmissionBody | undefined;
    if (found === undefined || found.kind !== "code" || found.patchId === undefined || !PATCH.test(found.patchId)) return [];
    const ids = ((await this.#runner.get(LINEAGE, lineageId(found.taskId, found.patchId)))?.body as unknown as LineageBody | undefined)?.ids ?? [];
    const at = ids.indexOf(submissionId);
    if (at <= 0) return [];
    const out: { submissionId: string; base: string; tree: string; submittedBy: string }[] = [];
    for (const other of ids.slice(0, at).reverse()) {
      if (other === submissionId) continue;
      const b = (await this.#runner.get("submission", other))?.body as unknown as SubmissionBody | undefined;
      // Each one is read again: the same task, a code submission and the same patch ID, recorded before this one (a submission never inherits from a later one).
      if (b === undefined || b.kind !== "code" || b.taskId !== found.taskId || b.patchId !== found.patchId || b.submittedAt > found.submittedAt || b.base === undefined || b.tree === undefined) continue;
      out.push({ submissionId: other, base: b.base, tree: b.tree, submittedBy: b.submittedBy });
    }
    return out;
  }

  /**
   * A code submission adds its submitter to its task's contributor record in the same write (card Q04, `contributors.ts`). A task with code from before the record existed is seeded first: from the project's code index
   * when it covers every code submission of the project, otherwise from one bounded scan of the submission table (the same bound as the code index's own seed), complete only when that scan reached the end. A project
   * whose code index was written from its first code on (`contributorsRecorded`) needs neither: a task with no record has no earlier code (so a project past `CODE_INDEX_KEPT` entries does not scan for every new task).
   */
  async #contributorChange(body: SubmissionBody): Promise<Change[]> {
    if (body.kind !== "code" || body.tree === undefined) return [];
    return contributorChange(this.#runner, body.taskId, body.submittedBy, async () => {
      const index = await this.#readCodeIndex(body.projectId);
      // Every code submission of this project wrote its task's record (see `CodeIndexBody.contributorsRecorded`): a task without one has no earlier code, so nothing is scanned.
      if (index?.body.contributorsRecorded === true) return { ids: [], complete: true };
      if (index?.body.complete === true) return { ids: index.body.entries.filter((e) => e.taskId === body.taskId).map((e) => e.by), complete: true };
      const ids = new Set(index?.body.entries.filter((e) => e.taskId === body.taskId).map((e) => e.by) ?? []);
      let after: string | undefined;
      const { pageSize, reads } = this.#waitingScan;
      for (let read = 0; read < reads; read++) {
        const chunk = await this.#runner.list("submission", { ...(after === undefined ? {} : { afterId: after }), limit: pageSize });
        for (const row of chunk) {
          after = row.id;
          const b = row.body as unknown as SubmissionBody;
          if (b.taskId === body.taskId && b.kind === "code" && b.tree !== undefined) ids.add(b.submittedBy);
        }
        if (chunk.length < pageSize) return { ids: [...ids], complete: true };
      }
      return { ids: [...ids], complete: false };
    });
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

  /** The code index of a project as stored: `undefined` when absent or not readable as an index (then it is not trusted). */
  async #readCodeIndex(projectId: string): Promise<{ body: CodeIndexBody; revision: number } | undefined> {
    return codeIndexOf(await this.#runner.get(CODE_INDEX, projectId));
  }

  /** A code submission is added to its project's index in the same write (card Q01b sixth slice); the first one of a project with older code seeds the index from one bounded scan. */
  async #codeIndexChange(id: string, body: SubmissionBody): Promise<Change[]> {
    if (body.kind !== "code" || body.tree === undefined || body.base === undefined || this.#codeKept <= 0) return [];
    const ref = { kind: CODE_INDEX, id: body.projectId };
    // One read: the revision checked by the write is the revision of the entries the write was built from.
    const found = await this.#runner.get(CODE_INDEX, body.projectId);
    const had = codeIndexOf(found);
    // An index that exists but cannot be read is left alone (a write could not be revision-checked against what it does not understand); the view scans for such a project.
    if (found !== undefined && had === undefined) return [];
    let entries: { taskId: string; id: string; at: string; by: string }[] = [...(had?.body.entries ?? [])];
    let complete = had?.body.complete ?? false;
    let contributorsRecorded = had?.body.contributorsRecorded === true;
    if (had === undefined) {
      const seen = new Map<string, { taskId: string; id: string; at: string; by: string }>();
      let after: string | undefined;
      let reachedEnd = false;
      const { pageSize, reads } = this.#waitingScan;
      for (let read = 0; read < reads && !reachedEnd; read++) {
        const chunk = await this.#runner.list("submission", { ...(after === undefined ? {} : { afterId: after }), limit: pageSize });
        for (const row of chunk) {
          after = row.id;
          const b = row.body as unknown as SubmissionBody;
          if (b.projectId !== body.projectId || b.kind !== "code" || b.tree === undefined || b.base === undefined) continue;
          const key = `${b.taskId}\n${b.submittedBy}`, old = seen.get(key);
          if (old === undefined || b.submittedAt > old.at || (b.submittedAt === old.at && row.id > old.id)) seen.set(key, { taskId: b.taskId, id: row.id, at: b.submittedAt, by: b.submittedBy });
        }
        if (chunk.length < pageSize) reachedEnd = true;
      }
      entries = [...seen.values()];
      complete = reachedEnd;
      contributorsRecorded = reachedEnd && entries.length === 0;
    }
    if (entries.some((e) => e.id === id)) return [];
    // One entry per task and agent, the newest: of two at the same instant the greater ID, as the view reads it.
    const mine = entries.find((e) => e.taskId === body.taskId && e.by === body.submittedBy);
    if (mine === undefined || body.submittedAt > mine.at || (body.submittedAt === mine.at && id > mine.id)) {
      entries = entries.filter((e) => e !== mine);
      entries.push({ taskId: body.taskId, id, at: body.submittedAt, by: body.submittedBy });
    }
    entries.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : x.id < y.id ? -1 : 1));
    if (entries.length > this.#codeKept) { entries = entries.slice(-this.#codeKept); complete = false; }
    const next: CodeIndexBody = { complete, entries, ...(contributorsRecorded ? { contributorsRecorded: true as const } : {}) };
    return [found === undefined ? { type: "create", ref, body: next as unknown as JsonObject } : { type: "update", ref, expectedRevision: found.revision, body: next as unknown as JsonObject }];
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
    if (after !== undefined) {
      // The cursor's entry dropped off the index (newer document changes pushed it out): a clear refusal, not an empty page that reads as "no more".
      const at = index.findIndex((x) => x.id === after);
      if (at < 0) bad("after", `the listing moved on: the document change this cursor follows is no longer among the project's newest ${this.#docKept}; list again without after`);
      start = at + 1;
    }
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
      // One more readable item past the page: only then is `next` offered (entries the caller may not read, or older than `since`, do not make a next page).
      if (items.length >= query.limit) return { items, next: this.#seal(by, scope, items[items.length - 1]!.id) };
      items.push({ ...body, ...(body.report === undefined ? {} : { report: redactText(body.report) }), id: found.id, revision: found.revision, createdAt: found.createdAt });
    }
    return { items };
  }

  /**
   * The code waiting across a project (card Q01b fifth slice): for each task of the project that is not done or cancelled, its newest code submission and where review and the director's sign-off stand on it. Read only; it writes nothing.
   * Who sees what: the owner sees every task; an agent with `task.read` in the project (never a task credential, which is scoped to one task) sees only the code it submitted itself, because the review and sign-off state
   * of someone else's code is not its to read (the same rule as the task's `submissions` view). A caller that may not read the project gets `not_found`. Bounded by `WAITING_SCAN` rows: the table holds every project's submissions in hash
   * order of IDs, not time order, so `scanLimited` says it stopped before the end and the counts then cover only what was read; at most `WAITING_TASKS` tasks are read, newest code first (`truncated` when more were left),
   * `WAITING_AT_ONCE` of them at a time.
   * States, in this order: `needs_review` (no review yet), `changes_asked` (the newest review asks for changes or rejects: waits for its author), `signoff_declined` (reviewed and approved, the director declined), `needs_signoff`
   * (approved, no director sign-off yet; whether it is needed to land is the project's `director` landing check), `ready` (approved and signed off). Fails closed: a task that cannot be read is not listed or counted.
   */
  async waiting(by: Principal, projectIdValue: string): Promise<WaitingView> {
    const projectId = checkProjectId(projectIdValue);
    const proj = await this.#runner.get("project", projectId);
    const mayRead = by.kind === "owner" || (by.kind === "agent" && by.taskScope === undefined && allows(by, "task.read", projectId));
    if (proj === undefined || !mayRead) throw new DomainError("not_found", "no such project");
    const ownOnly = by.kind !== "owner";
    const newest = new Map<string, { id: string; at: string }>();
    const note = (taskId: string, id: string, at: string): void => { const had = newest.get(taskId); if (had === undefined || at > had.at || (at === had.at && id > had.id)) newest.set(taskId, { id, at }); };
    // The project's code index, when it exists, is readable and covers every code submission, answers without a scan; otherwise (absent, unreadable, or incomplete) the table is scanned as before, and an incomplete
    // index adds its entries to what the scan found.
    const index = await this.#readCodeIndex(projectId);
    let scanLimited = false;
    if (index !== undefined) for (const e of index.body.entries) if (!ownOnly || e.by === by.id) note(e.taskId, e.id, e.at);
    if (index === undefined || !index.body.complete) {
      let after: string | undefined;
      scanLimited = true;
      const { pageSize, reads } = this.#waitingScan;
      for (let read = 0; read < reads; read++) {
        const chunk = await this.#runner.list("submission", { ...(after === undefined ? {} : { afterId: after }), limit: pageSize });
        for (const row of chunk) {
          after = row.id;
          const b = row.body as unknown as SubmissionBody;
          if (b.projectId !== projectId || b.kind !== "code" || b.tree === undefined || b.base === undefined) continue;
          if (ownOnly && b.submittedBy !== by.id) continue;
          note(b.taskId, row.id, b.submittedAt);
        }
        if (chunk.length < pageSize) { scanLimited = false; break; }
      }
    }
    const candidates = [...newest].sort((x, y) => (x[1].at > y[1].at ? -1 : x[1].at < y[1].at ? 1 : x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
    const looked = candidates.slice(0, this.#waitingTasks);
    const one = async ([taskId, sub]: [string, { id: string; at: string }]): Promise<WaitingItem | undefined> => {
      const task = await this.#readableTask(by, taskId);
      if (task === undefined || task.projectId !== projectId || task.state === "done" || task.state === "cancelled") return undefined;
      const a = await this.approvalOf(sub.id);
      // An index entry is only a pointer: the submission itself must be this project's code of this task, made at the time the entry says (the time chose it as the task's newest), and, for an agent, its own (as the scan reads them).
      if (a === undefined || a.projectId !== projectId || a.taskId !== taskId || a.submittedAt !== sub.at || (ownOnly && a.submittedBy !== by.id)) return undefined;
      const state: WaitingItem["state"] = !a.approved ? (a.newest === undefined || a.outdated !== undefined ? "needs_review" : "changes_asked") : a.director?.newest === "decline" ? "signoff_declined" : a.director?.newest === "approve" ? "ready" : "needs_signoff";
      return { taskId, title: task.title, submissionId: sub.id, submittedBy: a.submittedBy, submittedAt: a.submittedAt, tree: a.tree, state, ...(a.approved && a.approvedBy !== undefined ? { approvedBy: a.approvedBy } : {}) };
    };
    const items: WaitingItem[] = [];
    for (let k = 0; k < looked.length; k += WAITING_AT_ONCE) for (const i of await Promise.all(looked.slice(k, k + WAITING_AT_ONCE).map(one))) if (i !== undefined) items.push(i);
    const truncated = looked.length < candidates.length;
    const counts = { needs_review: 0, changes_asked: 0, signoff_declined: 0, needs_signoff: 0, ready: 0 };
    for (const i of items) counts[i.state]++;
    const order = { needs_review: 0, changes_asked: 1, signoff_declined: 2, needs_signoff: 3, ready: 4 } as const;
    items.sort((x, y) => order[x.state] - order[y.state] || (x.submittedAt < y.submittedAt ? -1 : x.submittedAt > y.submittedAt ? 1 : x.taskId < y.taskId ? -1 : 1));
    return { projectId, ownOnly, counts, items, truncated, scanLimited, source: index?.body.complete === true ? "index" : "scan" };
  }

  /**
   * Whether a code submission is approved, for the controller's own callers (card H12o: the commit of an approved submission). It takes no caller and is not an API operation: whoever asks has been checked already (the
   * workspace request needs `workspace.manage`). Approved means the NEWEST review of it says `approve` (a later `changes` or `reject` takes an approval back; a review of one's own work was refused when it was recorded),
   * or the submission recorded that no review is required because no other agent of the project could review (`review_disabled_single_agent`). `undefined` when there is no such code submission.
   * Card Q02: an approval stops counting when a decision the task relies on, or the task contract's criteria text, changed after it was given (`approvalOutdated`, read here so every reader of approvals sees it);
   * the answer is then not approved, with `outdated` and a plain reason, until a new review approves it again.
   */
  async approvalOf(submissionId: string): Promise<SubmissionApproval | undefined> {
    if (typeof submissionId !== "string" || !/^sbm-[a-z2-7]{20}$/.test(submissionId)) return undefined;
    const found = (await this.#runner.get("submission", submissionId))?.body as unknown as SubmissionBody | undefined;
    if (found === undefined || found.kind !== "code" || found.base === undefined || found.tree === undefined) return undefined;
    let reviews = ((await this.#runner.get(VERDICTS, submissionId))?.body as unknown as VerdictsBody | undefined)?.reviews ?? [];
    // Card Q02 (amended 2026-10-28): with no review of its own, the newest verdict on an earlier submission of the same task and the SAME patch ID carries over (a rebase keeps the patch ID); a changed patch never does.
    // The verdict that carries is the NEWEST one given on any earlier submission of the same patch (card Q02 review): a later rejection of the same patch on an older submission is not hidden by an earlier approval
    // on a nearer one. An approval given by this submission's own submitter is not an approval of this submission (the author cannot approve its own work, whoever wrote the earlier copy).
    let carriedFrom: string | undefined;
    let ownCarried = false;
    if (reviews.length === 0) {
      let best: { at: string; list: VerdictsBody["reviews"]; from: string } | undefined;
      for (const other of await this.carriedFrom(submissionId)) {
        const list = ((await this.#runner.get(VERDICTS, other))?.body as unknown as VerdictsBody | undefined)?.reviews ?? [];
        const last = list[list.length - 1];
        if (last !== undefined && (best === undefined || last.at > best.at)) best = { at: last.at, list, from: other };
      }
      if (best !== undefined) { reviews = best.list; carriedFrom = best.from; ownCarried = best.list[best.list.length - 1]!.by === found.submittedBy; }
    }
    const newest = reviews[reviews.length - 1];
    const signoffs = ((await this.#runner.get(SIGNOFFS, submissionId))?.body as unknown as SignoffsBody | undefined)?.signoffs ?? [];
    const lastSignoff = signoffs[signoffs.length - 1];
    // Card Q04: the task's contributors, read now and at most once (only when an approval or an approving sign-off has to be judged).
    let known: ReadonlySet<string> | undefined;
    const contributes = async (who: string): Promise<boolean> => (known ??= await taskContributors(this.#runner, found.projectId, found.taskId, [found.submittedBy])).has(principalOf(who));
    const signoffNotCounted = lastSignoff !== undefined && lastSignoff.decision === "approve" && await contributes(lastSignoff.by);
    const base = { submissionId, ...(carriedFrom === undefined ? {} : { carriedFrom }), taskId: found.taskId, projectId: found.projectId, base: found.base, tree: found.tree, ...(found.patchId === undefined ? {} : { patchId: found.patchId }), submittedBy: found.submittedBy, submittedAt: found.submittedAt, ...(Array.isArray(found.evidence) && found.evidence.length > 0 ? { evidence: found.evidence } : {}), ...(lastSignoff === undefined ? {} : signoffNotCounted ? { directorNotCounted: { by: lastSignoff.by, signoffId: lastSignoff.id, reason: `the sign-off by ${lastSignoff.by} does not count: ${CONTRIBUTOR_SIGNOFF_TEXT}` } } : { director: { newest: lastSignoff.decision, by: lastSignoff.by, signoffId: lastSignoff.id } }) };
    if (newest !== undefined && ownCarried && newest.verdict === "approve") return { ...base, approved: false, reason: `the approval that would carry over from ${carriedFrom} was given by this submission's own submitter; another reviewer has to approve it` };
    // Card Q04: an approval by an agent that contributed code to the task (any version) does not count, read now from the task's current contributors (so an approval recorded before this rule, or
    // by an agent that contributed after it approved, does not count either). It reads as waiting for review: another reviewer has to approve it.
    if (newest !== undefined && newest.verdict === "approve" && await contributes(newest.by)) {
      return { ...base, approved: false, reason: `the approval by ${newest.by} does not count: ${CONTRIBUTOR_APPROVAL_TEXT}` };
    }
    // Card Q02: an approval given before a decision the task relies on, or the task's criteria, changed no longer counts (read here, so every reader of approvals sees it); a new review restores it.
    if (newest !== undefined && newest.verdict === "approve") {
      const because = await approvalOutdated(this.#runner, found.taskId, newest);
      if (because !== undefined) return { ...base, approved: false, newest: "approve", ...(newest.cited === undefined ? {} : { cited: newest.cited }), outdated: { reviewId: newest.id, approvedBy: newest.by, approvedAt: newest.at, because }, reason: `the approval by ${newest.by} at ${newest.at} no longer counts: ${because}; a reviewer has to review it again against the current decisions and criteria` };
    }
    if (newest !== undefined) return newest.verdict === "approve" ? { ...base, approved: true, approvedBy: newest.by, reviewId: newest.id, newest: "approve", ...(newest.cited === undefined ? {} : { cited: newest.cited }) } : { ...base, approved: false, newest: newest.verdict, ...(newest.cited === undefined ? {} : { cited: newest.cited }), reason: `its newest review (${newest.id}) says ${newest.verdict}` };
    if (found.review?.required === false && found.review.reason === REVIEW_DISABLED_SINGLE_AGENT) {
      // Card Q02: code accepted without a review is held to the same rule as an approval: a decision it relied on, the criteria or a recorded dependency changed since takes it back (code recorded before this
      // kept its basis is judged by its time).
      const because = await approvalOutdated(this.#runner, found.taskId, { at: found.submittedAt, ...(found.judgedAgainst === undefined ? {} : { basis: found.judgedAgainst }) });
      if (because !== undefined) return { ...base, approved: false, outdated: { reviewId: submissionId, approvedBy: REVIEW_DISABLED_SINGLE_AGENT, approvedAt: found.submittedAt, because }, reason: `it was accepted without a review at ${found.submittedAt} (no other agent of the project could review it), but that no longer counts: ${because}; it has to be submitted again (or reviewed by an agent added to the project) against the current decisions and criteria` };
      return { ...base, approved: true, approvedBy: REVIEW_DISABLED_SINGLE_AGENT };
    }
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
      const cite = shapeReviewCite(c, c.verdict);
      return { ...bound, verdict: c.verdict as "approve" | "changes" | "reject", ...(cite === undefined ? {} : "unmetOnly" in cite ? { unmet: cite.unmetOnly } : { criteriaRevision: cite.criteriaRevision, decisions: cite.decisions, ...(cite.unmet === undefined ? {} : { unmet: cite.unmet }) }) };
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

/**
 * The director sign-off of a code submission as the landing gate reads it (card P09 sixth slice, the `director` required check): the newest sign-off of a director other than the submitter (the service refuses a sign-off
 * on the signer's own work and by anyone not holding the director role) on that very submission. One function, used by `start.ts` and by the tests, so the controller's composition is the one tested.
 */
export interface DirectorSignoffView { readonly submissionId: string; readonly taskId: string; readonly tree: string; readonly signoff?: { readonly newest: "approve" | "decline"; readonly by: string; readonly signoffId: string }; /** Card Q04: why the newest sign-off does not count (an approval by a contributor of the task). */ readonly notCounted?: string }
export function landingDirectorGate(service: SubmissionService): (submissionId: string) => Promise<DirectorSignoffView | undefined> {
  return async (submissionId) => {
    const a = await service.approvalOf(submissionId);
    return a === undefined ? undefined : { submissionId: a.submissionId, taskId: a.taskId, tree: a.tree, ...(a.director === undefined ? {} : { signoff: a.director }), ...(a.directorNotCounted === undefined ? {} : { notCounted: a.directorNotCounted.reason }) };
  };
}
