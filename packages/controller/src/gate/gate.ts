import { createHash } from "node:crypto";
import { canonicalJson } from "../storage/json.js";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, projectId as checkProjectId, taskId as checkTaskId, text, type TaskBody, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import { allows } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { GrantService } from "../security/grants.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { ReviewBody, ReviewService } from "../review/index.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";

/** One staged change as the reviewer is shown it. */
export interface StagedFile { readonly path: string; readonly op: "write" | "delete" }

/** Who did what, kept with every commit (card A06). */
export interface Attribution {
  /** The agent whose work it is: the commit's author, taken from authentication, never from the request. */
  readonly author: string;
  /** Who directed the work: the principal that created the task. */
  readonly developer: string;
  /** Who ran the commit: the principal that asked for the permit. */
  readonly executor: string;
  /** Who reviewed the exact tree: the deciding principal, or the external reviewer the owner recorded. */
  readonly reviewer: string;
  readonly reviewedVia: "review" | "external";
  /** Why the author could do this work at all: the grant(s) that applied. */
  readonly grantSource: string;
  readonly authorizedAt: string;
  /** The permit is good until then; asking again after it needs a new review. */
  readonly permitUntil: string;
}

export interface Integration { readonly branch: string; readonly commitId: string; readonly by: string; readonly at: string }

export interface CommitRequestBody {
  readonly requester: string;
  readonly taskId: string;
  readonly projectId: string;
  /** The commit the staged tree is based on and the tree itself (Git object IDs). A change to either is a different request. */
  readonly base: string;
  readonly tree: string;
  readonly message: string;
  readonly messageDigest: string;
  readonly files: readonly StagedFile[];
  /** Files an ignore rule hides from the staged tree: shown to the reviewer so that nothing is unseen. */
  readonly ignored: readonly string[];
  readonly reviewId: string;
  readonly state: "requested" | "authorized" | "committed";
  readonly requestedAt: string;
  readonly external?: { readonly system: string; readonly reference: string; readonly reviewer: string; readonly acceptedBy: string; readonly at: string };
  readonly attribution?: Attribution;
  readonly commitId?: string;
  readonly committedBy?: string;
  readonly integrations: readonly Integration[];
}

/** What the worker needs to make the commit: every identity comes from here, none from the agent. */
export interface CommitPermit {
  readonly requestId: string;
  /** A digest of the list of staged files the reviewer saw; the worker refuses a commit whose real diff from the base is not that list. */
  readonly filesDigest: string;
  readonly base: string;
  readonly tree: string;
  readonly message: string;
  readonly author: { readonly name: string; readonly email: string };
  readonly committer: { readonly name: string; readonly email: string };
  readonly trailers: readonly string[];
}

export interface GatePolicyBody { readonly humanOnly: boolean }

export const GATE_LIMITS = { message: 2000, files: 500, path: 400, ignored: 100, integrations: 50, scan: 2000 } as const;
const GIT_ID = /^[0-9a-f]{40}$/;
const REQUEST_ID = /^cgr-[a-z2-7]{20}$/;
const RESERVED_TRAILER = /^(?:reviewed-by|reviewed-via|approved-by|acked-by|tested-by|co-developed-by|co-authored-by|signed-off-by|author|developer|executor|grant-source|nimblenewt-[a-z-]+)\s*:/im;
/** A line that looks like a trailer but is written with letters from another alphabet, to pass for one that is not. */
const LOOKALIKE_TRAILER = /^[^\s:]{2,40}\s*:\s/mu;
const PERMIT_MINUTES = 30;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const COMMITTER = { name: "NimbleNewt", email: "controller@nimblenewt.invalid" } as const;
const agentIdentity = (principalId: string): { name: string; email: string } => { const name = principalId.replace(/^[a-z]+:/, ""); return { name, email: `${name}@agents.nimblenewt.invalid` }; };

/**
 * The human pre-commit gate (card A06). An agent asks to commit a staged tree: the request names the commit it is based on and the tree itself (Git object IDs), the message and the files, and
 * becomes a review of exactly that, so the reviewer approves a tree and a base, not an intention. Authorizing the commit presents the tree and base as they are now: if either changed, the approval
 * does not cover it (the review service refuses and names what changed) and a new request is needed. By default only the owner's approval counts (the gate is human); a project can allow its review
 * policy to decide. An approval the owner records from an external review (a reference and who verified it) is accepted for the same tree. The permit that comes back carries every identity of the
 * commit, taken from authentication and the records: the agent cannot choose its author, its reviewer or its trailers. The commit, and every later integration of it, are recorded against the request.
 */
export class CommitGateService {
  readonly #runner: CommandRunner;
  readonly #reviews: ReviewService;
  readonly #grants: GrantService;

  private constructor(runner: CommandRunner, reviews: ReviewService, grants: GrantService) { this.#runner = runner; this.#reviews = reviews; this.#grants = grants; }

  static withEpoch(storage: ControllerStorage, epoch: number, reviews: ReviewService, grants: GrantService, options: RunnerOptions = {}): CommitGateService {
    return new CommitGateService(new CommandRunner(storage, epoch, options), reviews, grants);
  }

  /** The owner decides whether only the owner's approval opens the gate in a project (default: yes). */
  async setPolicy(owner: Principal, command: NoActor & { projectId: string; humanOnly: boolean; expectedRevision?: number }): Promise<void> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} is not the owner; only the owner sets the commit gate`);
    onlyKnown(command, ["commandId", "projectId", "humanOnly", "expectedRevision"]);
    const projectId = checkProjectId(command.projectId);
    if (typeof command.humanOnly !== "boolean") invalid("humanOnly", "must be true or false");
    const current = await this.#runner.get("gate-policy", projectId);
    if ((command.expectedRevision ?? 0) !== (current?.revision ?? 0)) throw new DomainError("stale_revision", `the gate policy is at revision ${current?.revision ?? 0}, not ${command.expectedRevision ?? 0}`, ...(current === undefined ? [] : [{ currentRevision: current.revision }]));
    const ref: AggregateRef = { kind: "gate-policy", id: projectId };
    const body: GatePolicyBody = { humanOnly: command.humanOnly };
    await this.#runner.command("gate.policy", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { projectId, humanOnly: command.humanOnly, expectedRevision: current?.revision ?? 0 },
      build: async () => ({ ref, creates: current === undefined, changes: [current === undefined ? { type: "create", ref, body: body as unknown as JsonObject } : { type: "update", ref, expectedRevision: current.revision, body: body as unknown as JsonObject }], detail: { humanOnly: body.humanOnly } }),
    }));
  }

  /** Asks to commit a staged tree. The request is a review of exactly this base and tree. */
  async request(by: Principal, command: NoActor & { taskId: string; base: string; tree: string; message: string; files: readonly StagedFile[]; ignored?: readonly string[] }): Promise<{ id: string; reviewId: string; replayed: boolean }> {
    onlyKnown(command, ["commandId", "taskId", "base", "tree", "message", "files", "ignored"]);
    const taskId = checkTaskId(command.taskId);
    const task = (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined;
    if (task === undefined || !allows(by, "attempt.work", task.projectId, { resource: { kind: "task", id: taskId } })) throw new DomainError("forbidden", `${by.id} may not ask to commit for that task`);
    const { base, tree, message, files, ignored } = this.#checkStaged(command);
    const messageDigest = sha(message);
    const id = derivedId("cgr", scopedCommandId(by.id, command.commandId));
    const operation = this.#operation(task.projectId, base, tree, messageDigest, files);
    const review = await this.#reviews.request(by, {
      commandId: `gate-${id}`, taskId, operation, note: `${files.length} file(s) from ${base.slice(0, 12)} to tree ${tree.slice(0, 12)}${ignored.length > 0 ? `; the agent says ${ignored.length} ignored file(s) are left out` : ""}`,
      context: { toolVersion: "git-commit/1", authoritySource: "task assignment", expectedEffects: [`commit ${files.length} staged file(s) on base ${base.slice(0, 12)}`] },
    });
    const ref: AggregateRef = { kind: "commit-request", id };
    const body: CommitRequestBody = { requester: by.id, taskId, projectId: task.projectId, base, tree, message, messageDigest, files, ignored, reviewId: review.id, state: "requested", requestedAt: this.#runner.now(), integrations: [] };
    await this.#markContributor(by, taskId);
    const r = await this.#runner.command("gate.request", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { base, tree, messageDigest, files: files as unknown as JsonObject[] as never, taskId },
      build: async () => ({ ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }], detail: { taskId, base, tree } }),
    }));
    return { id: r.id, reviewId: review.id, replayed: r.replayed };
  }

  /** The owner records a review done elsewhere (a pull request, a person outside the system) as the approval of this very tree. */
  async acceptExternalReview(owner: Principal, command: NoActor & { requestId: string; system: string; reference: string; reviewer: string }): Promise<void> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} is not the owner; only the owner records an externally verified review`);
    onlyKnown(command, ["commandId", "requestId", "system", "reference", "reviewer"]);
    const id = this.#id(command.requestId);
    const system = redactText(text(command.system, "system", { min: 1, max: 60 }));
    const reference = redactText(text(command.reference, "reference", { min: 1, max: 300 }));
    const reviewer = redactText(text(command.reviewer, "reviewer", { min: 1, max: 120 }));
    await this.#update(owner, "gate.external", command.commandId, id, { system, reference, reviewer }, (body) => {
      if (body.state !== "requested") throw new DomainError("invalid_command", `request ${id} is ${body.state}`, { field: "requestId" });
      return { ...body, external: { system, reference, reviewer, acceptedBy: owner.id, at: this.#runner.now() } };
    });
  }

  /**
   * Asks for the permit to make the commit, presenting the base, tree and message as they are now. Only the requester. If the tree, the base or the message differ from what was reviewed, or the
   * approval is not the owner's where the gate is human, or has expired or been used, nothing is authorized and the reason is given.
   */
  async authorize(by: Principal, command: NoActor & { requestId: string; base: string; tree: string; message: string }): Promise<CommitPermit> {
    onlyKnown(command, ["commandId", "requestId", "base", "tree", "message"]);
    const id = this.#id(command.requestId);
    const found = await this.#runner.get("commit-request", id);
    const body = found?.body as unknown as CommitRequestBody | undefined;
    if (found === undefined || body === undefined || body.requester !== by.id) throw new DomainError("forbidden", `${by.id} has no such commit request`);
    if (!allows(by, "attempt.work", body.projectId, { resource: { kind: "task", id: body.taskId } })) throw new DomainError("forbidden", `${by.id} no longer holds the right to work on that task`);
    if (body.state === "committed") throw new DomainError("invalid_command", `request ${id} has already produced commit ${body.commitId}`, { field: "requestId" });
    const base = this.#gitId(command.base, "base"); const tree = this.#gitId(command.tree, "tree");
    const message = text(command.message, "message", { min: 1, max: GATE_LIMITS.message, multiline: true });
    // Staged content, base or message that is not what was reviewed is a different commit and needs its own review.
    const changed = [base !== body.base ? "the base commit" : "", tree !== body.tree ? "the staged tree" : "", sha(message) !== body.messageDigest ? "the message" : ""].filter(Boolean);
    if (changed.length > 0) throw new DomainError("review_invalid", `this is not the reviewed commit: ${changed.join(", ")} changed; ask again for a review of the current one`, { field: "requestId" });
    // Asking again for what was already authorized (a retry after a failure) gives the same permit and uses nothing up.
    if (body.state === "authorized" && body.attribution !== undefined) {
      if (body.attribution.permitUntil <= this.#runner.now()) throw new DomainError("review_invalid", `the permit for request ${id} ran out at ${body.attribution.permitUntil}; ask for a new review`, { field: "requestId" });
      return this.#permit(id, body, body.attribution, base, tree, message);
    }
    const policy = (await this.#runner.get("gate-policy", body.projectId))?.body as unknown as GatePolicyBody | undefined;
    const humanOnly = policy?.humanOnly ?? true;
    let reviewer: string; let via: Attribution["reviewedVia"];
    if (body.external !== undefined) { reviewer = body.external.reviewer; via = "external"; }
    else {
      const review = (await this.#runner.get("review", body.reviewId))?.body as unknown as ReviewBody | undefined;
      if (review === undefined || review.state !== "approved") throw new DomainError("review_invalid", `the review of this commit is ${review?.state ?? "missing"}, not approved`, { field: "requestId" });
      if (humanOnly && !(review.decidedBy ?? "").startsWith("owner:")) throw new DomainError("review_invalid", `this project's commit gate takes only the owner's approval, and ${review.decidedBy ?? "an agent"} decided`, { field: "requestId" });
      reviewer = review.decidedBy ?? "unknown"; via = "review";
      // Uses up the approval, and refuses if any part of the operation, the grants bearing on it or the time differs.
      await this.#reviews.admit(by, { commandId: `gate-admit-${id}`, requestId: body.reviewId, operation: this.#operation(body.projectId, base, tree, sha(message), body.files) });
    }
    const task = (await this.#runner.get("task", body.taskId))?.body as unknown as TaskBody | undefined;
    const grantSource = (await this.#grants.explain(by, "attempt.work", body.projectId, this.#runner.now(), { kind: "task", id: body.taskId })).because;
    const attribution: Attribution = { author: body.requester, developer: task?.createdBy ?? "unknown", executor: by.id, reviewer, reviewedVia: via, grantSource, authorizedAt: this.#runner.now(), permitUntil: new Date(Date.parse(this.#runner.now()) + PERMIT_MINUTES * 60_000).toISOString() };
    await this.#update(by, "gate.authorize", `${command.commandId}`, id, { attribution: attribution as unknown as JsonObject }, (b) => (b.state === "committed" ? (() => { throw new DomainError("invalid_command", "already committed", { field: "requestId" }); })() : { ...b, state: "authorized" as const, attribution }));
    return this.#permit(id, body, attribution, base, tree, message);
  }

  #permit(id: string, body: CommitRequestBody, attribution: Attribution, base: string, tree: string, message: string): CommitPermit {
    return {
      requestId: id, filesDigest: sha(canonicalJson(body.files as unknown as JsonObject[] as never)), base, tree, message, author: agentIdentity(body.requester), committer: { ...COMMITTER },
      trailers: [`Reviewed-by: ${attribution.reviewer}`, `Reviewed-via: ${attribution.reviewedVia}`, `Developer: ${attribution.developer}`, `Executor: ${attribution.executor}`, `Grant-source: ${attribution.grantSource.slice(0, 120)}`, `NimbleNewt-Request: ${id}`, `NimbleNewt-Task: ${body.taskId}`],
    };
  }

  /** Records the commit that was made from a permit: its ID must be a Git ID and its parent the reviewed base. By the requester or the owner. A principal other than the requester who is the reviewer becomes a contributor to the work. */
  async recordCommit(by: Principal, command: NoActor & { requestId: string; commitId: string; parent: string }): Promise<void> {
    onlyKnown(command, ["commandId", "requestId", "commitId", "parent"]);
    const id = this.#id(command.requestId);
    const commitId = this.#gitId(command.commitId, "commitId"); const parent = this.#gitId(command.parent, "parent");
    const found = await this.#runner.get("commit-request", id);
    const body = found?.body as unknown as CommitRequestBody | undefined;
    if (found === undefined || body === undefined || !(by.kind === "owner" || by.id === body.requester)) throw new DomainError("forbidden", `${by.id} may not record a commit for that request`);
    if (by.kind !== "owner" && !allows(by, "attempt.work", body.projectId, { resource: { kind: "task", id: body.taskId } })) throw new DomainError("forbidden", `${by.id} no longer holds the right to work on that task`);
    if (body.state !== "authorized") throw new DomainError("invalid_command", `request ${id} is ${body.state}; only an authorized request is committed`, { field: "requestId" });
    if (parent !== body.base) throw new DomainError("invalid_command", "the commit's parent is not the reviewed base", { field: "parent" });
    await this.#markContributor(by, body.taskId);
    await this.#update(by, "gate.commit", command.commandId, id, { commitId }, (b) => ({ ...b, state: "committed" as const, commitId, committedBy: by.id }));
  }

  /** Appends to the commit's integration history (a branch, a merge, a push). By the requester or the owner. */
  async recordIntegration(by: Principal, command: NoActor & { requestId: string; branch: string; commitId: string }): Promise<void> {
    onlyKnown(command, ["commandId", "requestId", "branch", "commitId"]);
    const id = this.#id(command.requestId);
    const branch = typeof command.branch === "string" && BRANCH.test(command.branch) ? command.branch : invalid("branch", "is not a branch name");
    const commitId = this.#gitId(command.commitId, "commitId");
    const found = await this.#runner.get("commit-request", id);
    const body = found?.body as unknown as CommitRequestBody | undefined;
    if (found === undefined || body === undefined || !(by.kind === "owner" || by.id === body.requester)) throw new DomainError("forbidden", `${by.id} may not record an integration for that request`);
    if (body.state !== "committed") throw new DomainError("invalid_command", `request ${id} has no commit yet`, { field: "requestId" });
    if (body.integrations.length >= GATE_LIMITS.integrations) throw new DomainError("unavailable", `request ${id} already has ${GATE_LIMITS.integrations} integration records`);
    await this.#update(by, "gate.integration", command.commandId, id, { branch, commitId }, (b) => ({ ...b, integrations: [...b.integrations, { branch, commitId, by: by.id, at: this.#runner.now() }] }));
  }

  /** A request, if the reader is its requester, the owner, or may read the project's histories. */
  async get(by: Principal, requestId: string): Promise<View<CommitRequestBody> | undefined> {
    const found = typeof requestId === "string" && REQUEST_ID.test(requestId) ? await this.#runner.get("commit-request", requestId) : undefined;
    if (found === undefined) return undefined;
    const body = found.body as unknown as CommitRequestBody;
    return by.kind === "owner" || by.id === body.requester || allows(by, "history.read", body.projectId) ? view<CommitRequestBody>(found) : undefined;
  }

  // ---- internals ------------------------------------------------------------------------------------------------------------

  /**
   * A principal that commits work on a task is a contributor to every open review of that task's work that it is the reviewer of, and can never approve it (H05). Recorded here, whenever a commit
   * is asked for or made, so no one has to remember to; an approval it already gave is withdrawn by the review service.
   */
  async #markContributor(by: Principal, taskId: string): Promise<void> {
    if (by.kind === "owner") return;
    // Only this task's reviews are read (an index written with each review), so the cost does not grow with the installation.
    for (const reviewId of await this.#reviews.reviewIdsForTask(taskId)) {
      const r = (await this.#runner.get("review", reviewId))?.body as unknown as ReviewBody | undefined;
      if (r === undefined || r.binding.requester === by.id || r.state === "denied" || r.state === "withdrawn") continue;
      const route = (await this.#runner.get("review-route", reviewId))?.body as unknown as { assigned?: string; contributors?: readonly string[] } | undefined;
      const involved = route?.assigned === by.id || r.decidedBy === by.id;
      if (involved && !(route?.contributors ?? []).includes(by.id)) await this.#reviews.addContributor(by, { commandId: `gate-contrib-${reviewId}-${by.id}`, requestId: reviewId });
    }
  }

  #id(value: unknown): string { return typeof value === "string" && REQUEST_ID.test(value) ? value : invalid("requestId", "is not a commit request ID"); }
  #gitId(value: unknown, field: string): string { return typeof value === "string" && GIT_ID.test(value) ? value : invalid(field, "must be a full 40-character Git object ID"); }

  #operation(projectId: string, base: string, tree: string, messageDigest: string, files: readonly StagedFile[]) {
    return { name: "git-commit", args: { base, tree, messageDigest, files: sha(canonicalJson(files as unknown as JsonObject[] as never)), fileCount: files.length }, target: { kind: "repository", id: projectId } };
  }

  #checkStaged(command: { base: string; tree: string; message: string; files: readonly StagedFile[]; ignored?: readonly string[] }): { base: string; tree: string; message: string; files: StagedFile[]; ignored: string[] } {
    const base = this.#gitId(command.base, "base"); const tree = this.#gitId(command.tree, "tree");
    const message = text(command.message, "message", { min: 1, max: GATE_LIMITS.message, multiline: true });
    // The trailers that record who did what are added by the controller; a message cannot carry look-alikes of them.
    if (message.split(/\r?\n/).some((line) => /[^\x00-\x7f]/.test(line.split(":")[0] ?? "") && LOOKALIKE_TRAILER.test(line))) invalid("message", "a line that looks like a trailer may use only ASCII letters in its name");
    if (RESERVED_TRAILER.test(message)) invalid("message", "may not contain a line that looks like one of the controller's trailers (Reviewed-by, Reviewed-via, Developer, Executor, Grant-source, Co-authored-by, Signed-off-by, NimbleNewt-…)");
    if (!Array.isArray(command.files) || command.files.length < 1 || command.files.length > GATE_LIMITS.files) invalid("files", `must list 1 to ${GATE_LIMITS.files} staged files`);
    const files = command.files.map((f, i) => {
      if (typeof f !== "object" || f === null || (f.op !== "write" && f.op !== "delete") || typeof f.path !== "string" || f.path.length < 1 || f.path.length > GATE_LIMITS.path || f.path.includes("\0") || f.path.startsWith("/") || f.path.split("/").includes("..")) return invalid(`files[${i}]`, "needs a relative path and op write or delete");
      return { path: f.path, op: f.op };
    }).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (new Set(files.map((f) => f.path)).size !== files.length) invalid("files", "lists a path twice");
    const ignored = command.ignored ?? [];
    if (!Array.isArray(ignored) || ignored.length > GATE_LIMITS.ignored || ignored.some((p) => typeof p !== "string" || p.length < 1 || p.length > GATE_LIMITS.path)) invalid("ignored", `must be a list of at most ${GATE_LIMITS.ignored} paths`);
    return { base, tree, message, files, ignored: [...ignored] };
  }

  async #update(by: Principal, type: string, commandId: string, id: string, payload: JsonObject, change: (body: CommitRequestBody) => CommitRequestBody): Promise<void> {
    const ref: AggregateRef = { kind: "commit-request", id };
    await this.#runner.command(type, { commandId: scopedCommandId(by.id, commandId), actor: by.id }, async () => ({
      payload: { requestId: id, ...payload },
      build: async () => {
        const current = await this.#runner.get("commit-request", id);
        if (current === undefined) throw new DomainError("not_found", `commit request ${id} does not exist`);
        const next = change(current.body as unknown as CommitRequestBody);
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: next as unknown as JsonObject }], detail: { requestId: id } };
      },
    }));
  }
}
