import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, revision as checkRevision, taskId as checkTaskId, text, type TaskBody, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import { allows, toolAction } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import { effectiveOf } from "../security/grants.js";
import type { NoActor, Principal, PrincipalBody } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import { canonicalJson, sha256 } from "../storage/json.js";
import type { AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";

export type ReviewState = "pending" | "approved" | "denied" | "withdrawn" | "used";

/** The exact operation a review is about. A different one is a different operation, however similar. */
export interface Operation {
  /** The tool or command, as a tool name (`tool.<name>` is the action it needs). */
  readonly name: string;
  readonly args: JsonObject;
  /** The script or program text, when the operation runs one. */
  readonly script?: string;
  readonly target: { readonly kind: string; readonly id: string };
}

/** What a verdict is bound to, kept in parts so a change can be named. */
export interface Binding {
  readonly requester: string;
  readonly taskId: string;
  readonly projectId: string;
  readonly name: string;
  readonly argsDigest: string;
  readonly scriptDigest: string | null;
  readonly target: { readonly kind: string; readonly id: string };
  /** A digest of the grants and restrictions that bear on this action for the requester at the time. */
  readonly policyDigest: string;
}

export interface ReviewBody {
  readonly binding: Binding;
  /** What the reviewer is shown and approves: the operation itself. */
  readonly operation: Operation;
  readonly note?: string;
  readonly state: ReviewState;
  readonly requestedAt: string;
  readonly decidedBy?: string;
  readonly decidedAt?: string;
  readonly reason?: string;
  readonly expiresAt?: string;
  readonly usedAt?: string;
  readonly usedByCommand?: string;
  readonly withdrawnBy?: string;
}

export interface RequestReview extends NoActor {
  readonly taskId: string;
  readonly operation: Operation;
  readonly note?: string;
}

export interface Decide extends NoActor {
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly verdict: "approve" | "deny";
  readonly reason: string;
  /** UTC time the approval ends. Default: 30 minutes after the decision; at most 24 hours. */
  readonly expiresAt?: string;
}

export type AdmitResult = { readonly admitted: true; readonly requestId: string; readonly replayed: boolean };

export const REVIEW_LIMITS = { args: 8 * 1024, script: 16 * 1024, note: 1000, reason: 1000, name: 80, targetId: 200, defaultMinutes: 30, maxHours: 24 } as const;
const REVIEW_ID = /^rev-[a-z2-7]{20}$/;
const NAME = /^[a-z][a-z0-9._-]{0,79}$/;
const KIND = /^[a-z][a-z0-9-]{0,39}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };

function checkOperation(value: unknown, field = "operation"): Operation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid(field, "must be an object");
  const e = value as Record<string, unknown>;
  for (const key of Object.keys(e)) if (!["name", "args", "script", "target"].includes(key)) invalid(`${field}.${key}`, "is not an operation field");
  const name = typeof e["name"] === "string" && NAME.test(e["name"]) ? e["name"] : invalid(`${field}.name`, "must be a tool name in lower case");
  if (e["args"] === null || typeof e["args"] !== "object" || Array.isArray(e["args"])) invalid(`${field}.args`, "must be an object");
  const args = e["args"] as JsonObject;
  let encoded: string;
  try { encoded = canonicalJson(args); } catch { return invalid(`${field}.args`, "must be plain JSON (no cycles, undefined, special numbers or excessive depth)"); }
  if (encoded.length > REVIEW_LIMITS.args) invalid(`${field}.args`, `must be at most ${REVIEW_LIMITS.args} characters when written out`);
  if (redactText(encoded) !== encoded) invalid(`${field}.args`, "looks like it holds a credential or key; those are not recorded in a review");
  const script = e["script"] === undefined ? undefined : text(e["script"], `${field}.script`, { min: 1, max: REVIEW_LIMITS.script, multiline: true });
  if (script !== undefined && redactText(script) !== script) invalid(`${field}.script`, "looks like it holds a credential or key; those are not recorded in a review");
  const t = e["target"];
  if (t === null || typeof t !== "object" || Array.isArray(t)) return invalid(`${field}.target`, "must be an object with kind and id");
  for (const key of Object.keys(t)) if (key !== "kind" && key !== "id") invalid(`${field}.target.${key}`, "is not a target field");
  const target = {
    kind: typeof (t as Record<string, unknown>)["kind"] === "string" && KIND.test((t as { kind: string }).kind) ? (t as { kind: string }).kind : invalid(`${field}.target.kind`, "must be lower-case words joined by hyphens"),
    id: text((t as Record<string, unknown>)["id"], `${field}.target.id`, { min: 1, max: REVIEW_LIMITS.targetId }),
  };
  return { name, args, ...(script === undefined ? {} : { script }), target };
}

/**
 * Exact-operation review admission (card A05). A review is about one operation: this tool, with these arguments, this script, this target, under the grants and restrictions that bear on it. The
 * reviewer's approval is bound to a digest of exactly that, kept in parts. Before the operation runs, `admit` works the digest out again from what is about to run and from the executor's current
 * grants and restrictions; if anything differs, or the approval has expired, been withdrawn or been used, the operation is not admitted and the answer names what changed.
 *
 * An approval **only waives the review**. It adds no capability: the executor must already hold the grant for the action on the target (a verdict cannot be a way to gain one), the reviewer
 * must hold the right to review in the project but is not asked to hold the capability itself, and the reviewer cannot be the requester. An approval admits one execution.
 */
export class ReviewService {
  readonly #runner: CommandRunner;

  private constructor(runner: CommandRunner) {
    this.#runner = runner;
  }

  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): ReviewService {
    return new ReviewService(new CommandRunner(storage, epoch, options));
  }

  /** The requester asks for a review of an exact operation. Needs `review.request` in the task's project, and the right to work on the task. */
  async request(requester: Principal, command: RequestReview): Promise<{ id: string; replayed: boolean }> {
    onlyKnown(command, ["commandId", "taskId", "operation", "note"]);
    const taskId = checkTaskId(command.taskId);
    const operation = checkOperation(command.operation);
    const note = command.note === undefined ? undefined : text(command.note, "note", { min: 1, max: REVIEW_LIMITS.note, multiline: true });
    if (note !== undefined && redactText(note) !== note) invalid("note", "looks like a credential or key; those are not recorded in a review");
    const task = await this.#runner.get("task", taskId);
    const projectId = (task?.body as unknown as TaskBody | undefined)?.projectId;
    const fresh = await this.#fresh(requester.id);
    const resource = { kind: "task", id: taskId };
    // A task the requester may not work on reads exactly like one that does not exist.
    if (projectId === undefined || fresh === undefined || !allows(fresh, "review.request", projectId, { resource }) || !allows(fresh, "attempt.work", projectId, { resource })) throw new DomainError("forbidden", `${requester.id} may not ask for a review about that task`);
    const binding = this.#binding(fresh, taskId, projectId, operation);
    const id = derivedId("rev", scopedCommandId(requester.id, command.commandId));
    const r = await this.#runner.command("review.request", { commandId: scopedCommandId(requester.id, command.commandId), actor: requester.id }, async () => ({
      payload: { taskId, operation: operation as unknown as JsonObject, ...(note === undefined ? {} : { note }), binding: binding as unknown as JsonObject },
      build: async () => {
        const ref: AggregateRef = { kind: "review", id };
        const body: ReviewBody = { binding, operation, ...(note === undefined ? {} : { note }), state: "pending", requestedAt: this.#runner.now() };
        return { ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }], detail: { taskId, name: operation.name, argsDigest: binding.argsDigest } };
      },
    }));
    return { id: r.id, replayed: r.replayed };
  }

  /** A reviewer approves or denies exactly what the request shows. */
  async decide(reviewer: Principal, command: Decide): Promise<void> {
    onlyKnown(command, ["commandId", "requestId", "expectedRevision", "verdict", "reason", "expiresAt"]);
    const id = this.#id(command.requestId);
    const expected = checkRevision(command.expectedRevision);
    const verdict = command.verdict === "approve" || command.verdict === "deny" ? command.verdict : invalid("verdict", "must be approve or deny");
    const reason = text(command.reason, "reason", { min: 1, max: REVIEW_LIMITS.reason, multiline: true });
    if (redactText(reason) !== reason) invalid("reason", "looks like a credential or key; those are not recorded in a review");
    if (command.expiresAt !== undefined && !(typeof command.expiresAt === "string" && TIMESTAMP.test(command.expiresAt))) invalid("expiresAt", "must be a UTC timestamp such as 2026-10-21T12:00:00.000Z");
    const fresh = await this.#fresh(reviewer.id);
    await this.#runner.command("review.decide", { commandId: scopedCommandId(reviewer.id, command.commandId), actor: reviewer.id }, async () => ({
      payload: { requestId: id, expectedRevision: expected, verdict, reason, ...(command.expiresAt === undefined ? {} : { expiresAt: command.expiresAt }) },
      build: async () => {
        const current = await this.#runner.get("review", id);
        const body = current?.body as unknown as ReviewBody | undefined;
        // Not there, or not a review this principal may decide: one refusal. Deciding needs the review right in the project, and the reviewer cannot be the requester.
        if (current === undefined || body === undefined || fresh === undefined || !allows(fresh, "review.decide", body.binding.projectId) || reviewer.id === body.binding.requester) throw new DomainError("forbidden", `${reviewer.id} may not decide that review`);
        if (current.revision !== expected) throw new DomainError("stale_revision", `review ${id} is at revision ${current.revision}, not ${expected}`, { currentRevision: current.revision });
        if (body.state !== "pending") throw new DomainError("invalid_command", `review ${id} is ${body.state}; only a pending review can be decided`, { field: "requestId" });
        const now = this.#runner.now();
        const longest = new Date(Date.parse(now) + REVIEW_LIMITS.maxHours * 3_600_000).toISOString();
        const expiresAt = command.expiresAt ?? new Date(Date.parse(now) + REVIEW_LIMITS.defaultMinutes * 60_000).toISOString();
        if (verdict === "approve" && (expiresAt <= now || expiresAt > longest)) throw new DomainError("invalid_command", `expiresAt: must be after now and within ${REVIEW_LIMITS.maxHours} hours`, { field: "expiresAt" });
        const next: ReviewBody = { ...body, state: verdict === "approve" ? "approved" : "denied", decidedBy: reviewer.id, decidedAt: now, reason, ...(verdict === "approve" ? { expiresAt } : {}) };
        const ref: AggregateRef = { kind: "review", id };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: next as unknown as JsonObject }], detail: { verdict, requester: body.binding.requester, argsDigest: body.binding.argsDigest } };
      },
    }));
  }

  /** The reviewer who approved, the requester or the owner takes an approval (or a pending request) back before it is used. */
  async withdraw(principal: Principal, command: NoActor & { requestId: string; expectedRevision: number; reason: string }): Promise<void> {
    onlyKnown(command, ["commandId", "requestId", "expectedRevision", "reason"]);
    const id = this.#id(command.requestId);
    const expected = checkRevision(command.expectedRevision);
    const reason = text(command.reason, "reason", { min: 1, max: REVIEW_LIMITS.reason, multiline: true });
    await this.#runner.command("review.withdraw", { commandId: scopedCommandId(principal.id, command.commandId), actor: principal.id }, async () => ({
      payload: { requestId: id, expectedRevision: expected, reason },
      build: async () => {
        const current = await this.#runner.get("review", id);
        const body = current?.body as unknown as ReviewBody | undefined;
        if (current === undefined || body === undefined || !(principal.kind === "owner" || principal.id === body.decidedBy || principal.id === body.binding.requester)) throw new DomainError("forbidden", `${principal.id} may not withdraw that review`);
        if (current.revision !== expected) throw new DomainError("stale_revision", `review ${id} is at revision ${current.revision}, not ${expected}`, { currentRevision: current.revision });
        if (body.state !== "pending" && body.state !== "approved") throw new DomainError("invalid_command", `review ${id} is ${body.state}; it cannot be withdrawn`, { field: "requestId" });
        const next: ReviewBody = { ...body, state: "withdrawn", withdrawnBy: principal.id, reason };
        const ref: AggregateRef = { kind: "review", id };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: next as unknown as JsonObject }], detail: { by: principal.id } };
      },
    }));
  }

  /**
   * Called just before the operation runs, with the operation as it is about to run. Admits it only if the approval is still current and the operation is, in every part, the one that was
   * reviewed: same requester, task, tool, arguments, script, target and the same grants and restrictions bearing on it; and the executor still holds the grant for the action (an approval adds
   * none). On success the approval is used up. A refusal names every part that differs.
   */
  async admit(executor: Principal, command: NoActor & { requestId: string; operation: Operation }): Promise<AdmitResult> {
    onlyKnown(command, ["commandId", "requestId", "operation"]);
    const id = this.#id(command.requestId);
    const operation = checkOperation(command.operation);
    const r = await this.#runner.command("review.admit", { commandId: scopedCommandId(executor.id, command.commandId), actor: executor.id }, async () => ({
      payload: { requestId: id, operation: operation as unknown as JsonObject },
      build: async () => {
        const current = await this.#runner.get("review", id);
        const body = current?.body as unknown as ReviewBody | undefined;
        if (current === undefined || body === undefined || body.binding.requester !== executor.id) throw new DomainError("forbidden", `${executor.id} has no such review`);
        const fresh = await this.#fresh(executor.id);
        if (fresh === undefined) throw new DomainError("unauthenticated", "the credential was not accepted");
        if (body.state !== "approved") throw new DomainError("review_invalid", `review ${id} is ${body.state}, not approved`, { field: "requestId" });
        const now = this.#runner.now();
        if (body.expiresAt === undefined || body.expiresAt <= now) throw new DomainError("review_invalid", `the approval expired at ${body.expiresAt ?? "(no time)"}`, { field: "requestId" });
        const actual = this.#binding(fresh, body.binding.taskId, body.binding.projectId, operation);
        const changed: string[] = [];
        if (actual.name !== body.binding.name) changed.push("the tool");
        if (actual.argsDigest !== body.binding.argsDigest) changed.push("the arguments");
        if (actual.scriptDigest !== body.binding.scriptDigest) changed.push("the script");
        if (actual.target.kind !== body.binding.target.kind || actual.target.id !== body.binding.target.id) changed.push("the target");
        if (actual.policyDigest !== body.binding.policyDigest) changed.push("the grants or restrictions that bear on it");
        if (changed.length > 0) throw new DomainError("review_invalid", `this is not the reviewed operation: ${changed.join(", ")} changed`, { field: "operation" });
        // The approval adds no capability: the executor must itself be allowed to do this, on this target, now.
        if (!allows(fresh, toolAction(operation.name), body.binding.projectId, { resource: operation.target }) && !allows(fresh, toolAction(operation.name), body.binding.projectId, { resource: { kind: "task", id: body.binding.taskId } })) {
          throw new DomainError("forbidden", `${executor.id} no longer holds the grant for ${toolAction(operation.name)}; an approval does not give one`);
        }
        const ref: AggregateRef = { kind: "review", id };
        const next: ReviewBody = { ...body, state: "used", usedAt: now, usedByCommand: command.commandId };
        const change: Change = { type: "update", ref, expectedRevision: current.revision, body: next as unknown as JsonObject };
        return { ref, creates: false, changes: [change], detail: { name: operation.name, argsDigest: actual.argsDigest }, contention: async () => new DomainError("review_invalid", `review ${id} was used or changed at the same moment`, { field: "requestId" }) };
      },
    }));
    return { admitted: true, requestId: r.id, replayed: r.replayed };
  }

  /** A review, as seen by the requester, the reviewer who decided it, or the owner (anyone else gets `undefined`). */
  async get(principal: Principal, requestId: string): Promise<View<ReviewBody> | undefined> {
    const found = typeof requestId === "string" && REVIEW_ID.test(requestId) ? await this.#runner.get("review", requestId) : undefined;
    if (found === undefined) return undefined;
    const body = found.body as unknown as ReviewBody;
    const fresh = await this.#fresh(principal.id);
    const mayReview = fresh !== undefined && allows(fresh, "review.decide", body.binding.projectId);
    if (principal.kind !== "owner" && principal.id !== body.binding.requester && principal.id !== body.decidedBy && !mayReview) return undefined;
    return view<ReviewBody>(found);
  }

  // ---- internals -------------------------------------------------------------------------------------------------------------

  #id(value: unknown): string {
    return typeof value === "string" && REVIEW_ID.test(value) ? value : invalid("requestId", "is not a review ID");
  }

  /** The principal as stored now, with its grant records and restrictions loaded now (never a snapshot the caller holds). `undefined` if it is not an active principal. */
  async #fresh(principalId: string): Promise<Principal | undefined> {
    const found = await this.#runner.get("principal", principalId);
    const body = found?.body as unknown as PrincipalBody | undefined;
    if (found === undefined || body === undefined || body.state !== "active") return undefined;
    return effectiveOf(this.#runner, { id: found.id, kind: body.kind, name: body.name, grants: body.grants }, this.#runner.now());
  }

  #binding(principal: Principal, taskId: string, projectId: string, operation: Operation): Binding {
    const action = toolAction(operation.name);
    const matching = principal.grants.filter((g) => g.action === "*" || g.action === action || (g.action.endsWith(".*") && action.startsWith(g.action.slice(0, -1)))).filter((g) => g.project === "*" || g.project === projectId);
    const bearing = (principal.restrictions ?? []).filter((r) => r.action === "*" || r.action === action || (r.action.endsWith(".*") && action.startsWith(r.action.slice(0, -1)))).filter((r) => r.project === "*" || r.project === projectId);
    const policyDigest = sha256(canonicalJson({
      grants: matching.map((g) => ({ action: g.action, project: g.project, resource: g.resource ?? null, grantId: g.grantId ?? null, expiresAt: g.expiresAt ?? null })).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))),
      restrictions: bearing.map((r) => ({ action: r.action, project: r.project, resource: r.resource ?? null, restrictionId: r.restrictionId ?? null })).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))),
    } as unknown as JsonObject));
    return {
      requester: principal.id, taskId, projectId, name: operation.name,
      argsDigest: sha256(canonicalJson(operation.args)),
      scriptDigest: operation.script === undefined ? null : sha256(operation.script),
      target: operation.target, policyDigest,
    };
  }
}
