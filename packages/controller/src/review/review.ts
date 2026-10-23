import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, projectId as checkProjectId, revision as checkRevision, taskId as checkTaskId, text, type TaskBody, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import type { Availability } from "../conversations/conversations.js";
import { DEFAULT_HOST_STALE_AFTER_MS, hostFreshness, type HostBody } from "../hosts/hosts.js";
import { allows, inTaskScope, toolAction } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import { effectiveOf } from "../security/grants.js";
import type { NoActor, Principal, PrincipalBody } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import { canonicalJson, sha256 } from "../storage/json.js";
import type { Aggregate, AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";
import { addEvent, checkContext, checkPolicy, DEFAULT_POLICY, mergeContext, minutesLater, missingEssentials, ROUTING_LIMITS, type ReviewContext, type ReviewPolicyBody, type ReviewRouteBody, type ReviewerStatus, type StoredContext } from "./routing.js";
import type { WaitEdge } from "../planning/wait-graph.js";
import type { DecisionGuard } from "../decisions/records.js";

/** A review is in owner mode once it is reserved for the owner, escalated or sent to the owner; it never goes back to an agent reviewer (card H12h). */
function ownerMode(body: ReviewBody, route: ReviewRouteBody): boolean {
  return body.state === "owner-decision" || route.mandatoryHuman || route.state === "escalated";
}

/**
 * `pending`: waiting for a verdict. `needs-context`: the reviewer asked for more and the requester has to supply it. `owner-decision`: only the owner may decide. `approved`: allowed, once, until it
 * expires. `used`, `denied` and `withdrawn` are final.
 */
export type ReviewState = "pending" | "needs-context" | "owner-decision" | "approved" | "denied" | "withdrawn" | "used";

/** The four verdicts (card H05): allow; deny; ask for more context; or say that only the owner can decide. */
export type Verdict = "allow" | "deny" | "request-context" | "requires-owner-decision";
const VERDICTS: readonly string[] = ["allow", "deny", "request-context", "requires-owner-decision"];

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
  /** What the reviewer is shown besides the operation (card H05); credentials in it are replaced. */
  readonly context?: StoredContext;
  /** When the reviewer asked for more context: what is wanted. */
  readonly contextRequest?: string;
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
  readonly context?: ReviewContext;
  /** Only the owner may review this request (the dispatcher sets it for an exact-operation call). It can only make a review stricter, so the requester may set it; it never loosens the project's policy. */
  readonly ownerOnly?: boolean;
}

export interface Decide extends NoActor {
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly verdict: Verdict;
  readonly reason: string;
  /** What the review cost (tokens, money or time in any one unit the owner chooses), kept for the figures about reviewing. */
  readonly cost?: number;
  /** UTC time the approval ends. Default: 30 minutes after the decision; at most 24 hours. */
  readonly expiresAt?: string;
}

export interface ReviewOptions extends RunnerOptions {
  /**
   * Whether an agent is held (paused, suspended or stopped, card L01; `PauseService.availability` is this function). A held reviewer is skipped when a reviewer is chosen, is never in the wake list and does not
   * decide while held; a review already assigned to it keeps its place until its deadline. Default: every agent is available.
   */
  readonly availability?: (principalId: string) => Promise<Availability>;
  /** The host principal (`host:...`) a reviewer's worker runs on, if known (nothing records this link before card H03, so it is supplied). Without it a reviewer's host is never judged. */
  readonly reviewerHost?: (principalId: string) => Promise<string | undefined>;
  /** How long a host counts as fresh (default: the one constant `HostService` uses). */
  readonly hostStaleAfterMs?: number;
  /**
   * The owner's decisions (card C08). An allow, and the admission of an approval, are refused while the task relies on a decision that is no longer authoritative or an owner gate forbids effects: the team's earlier
   * agreement cannot carry obsolete work through review. Without it nothing is checked.
   */
  readonly decisions?: DecisionGuard;
}

/** Why a reviewer cannot be woken or chosen now, for the wake list. */
export type Unavailable = Availability | "host-lost";

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
  readonly #availability: (principalId: string) => Promise<Availability>;
  readonly #reviewerHost: ((principalId: string) => Promise<string | undefined>) | undefined;
  readonly #hostStaleAfterMs: number;
  readonly #decisions: DecisionGuard | undefined;

  private constructor(runner: CommandRunner, options: ReviewOptions) {
    this.#runner = runner;
    this.#availability = options.availability ?? (async () => "available");
    this.#reviewerHost = options.reviewerHost;
    this.#decisions = options.decisions;
    this.#hostStaleAfterMs = options.hostStaleAfterMs ?? DEFAULT_HOST_STALE_AFTER_MS;
    if (!Number.isSafeInteger(this.#hostStaleAfterMs) || this.#hostStaleAfterMs < 1000) throw new DomainError("invalid_command", "hostStaleAfterMs: must be a whole number of at least 1000", { field: "hostStaleAfterMs" });
  }

  static withEpoch(storage: ControllerStorage, epoch: number, options: ReviewOptions = {}): ReviewService {
    return new ReviewService(new CommandRunner(storage, epoch, options), options);
  }

  /**
   * The requester asks for a review of an exact operation. Needs `review.request` in the task's project, and the right to work on the task. The request is routed at once (card H05): a
   * reviewer is chosen under the project's policy, or the request waits for one, or (for a tool the policy reserves for people) goes to the owner. A request for an operation that an
   * unexpired, unused approval already covers exactly is cleared against that approval instead of asking again, and the clearing is recorded; an agent's approval never clears a tool that
   * only the owner may review.
   */
  async request(requester: Principal, command: RequestReview): Promise<{ id: string; replayed: boolean; cleared: boolean }> {
    onlyKnown(command, ["commandId", "taskId", "operation", "note", "context", "ownerOnly"]);
    if (command.ownerOnly !== undefined && typeof command.ownerOnly !== "boolean") invalid("ownerOnly", "must be true or false");
    const ownerOnly = command.ownerOnly === true;
    const taskId = checkTaskId(command.taskId);
    const operation = checkOperation(command.operation);
    const note = command.note === undefined ? undefined : text(command.note, "note", { min: 1, max: REVIEW_LIMITS.note, multiline: true });
    if (note !== undefined && redactText(note) !== note) invalid("note", "looks like a credential or key; those are not recorded in a review");
    const context = checkContext(command.context, operation.script);
    const task = await this.#runner.get("task", taskId);
    const projectId = (task?.body as unknown as TaskBody | undefined)?.projectId;
    const fresh = await this.#fresh(requester.id, requester.taskScope);
    const resource = { kind: "task", id: taskId };
    // A task the requester may not work on reads exactly like one that does not exist.
    if (projectId === undefined || fresh === undefined || !allows(fresh, "review.request", projectId, { resource }) || !allows(fresh, "attempt.work", projectId, { resource })) throw new DomainError("forbidden", `${requester.id} may not ask for a review about that task`);
    const binding = this.#binding(fresh, taskId, projectId, operation);
    const scoped = scopedCommandId(requester.id, command.commandId);
    const id = derivedId("rev", scoped);
    const r = await this.#runner.command("review.request", { commandId: scoped, actor: requester.id }, async () => ({
      payload: { taskId, operation: operation as unknown as JsonObject, ...(note === undefined ? {} : { note }), binding: binding as unknown as JsonObject, context: context as unknown as JsonObject, ...(ownerOnly ? { ownerOnly } : {}) },
      build: async () => {
        const now = this.#runner.now();
        const policy = await this.#policy(projectId);
        const mandatory = ownerOnly || policy.body.mandatoryHuman.includes(operation.name);
        const guard: Change[] = policy.revision === 0 ? [] : [{ type: "check", ref: { kind: "review-policy", id: projectId }, expectedRevision: policy.revision }];
        const earlier = await this.#coveringApproval(projectId, binding, mandatory, now);
        if (earlier !== undefined) {
          const routeRef: AggregateRef = { kind: "review-route", id: earlier.review.id };
          const route = earlier.route.body as unknown as ReviewRouteBody;
          const next: ReviewRouteBody = { ...route, events: addEvent(route.events, now, "cleared", `a repeat request by ${requester.id} was cleared against this approval by ${(earlier.review.body as unknown as ReviewBody).decidedBy ?? "?"}`) };
          return {
            ref: routeRef, creates: false,
            changes: [{ type: "check", ref: { kind: "review", id: earlier.review.id }, expectedRevision: earlier.review.revision }, ...guard, { type: "update", ref: routeRef, expectedRevision: earlier.route.revision, body: next as unknown as JsonObject }],
            detail: { clearedAgainst: earlier.review.id, decidedBy: (earlier.review.body as unknown as ReviewBody).decidedBy ?? null, argsDigest: binding.argsDigest },
          };
        }
        const contributors = [requester.id];
        const chosen = mandatory ? { excluded: [] as { id: string; reason: string }[] } : await this.#choose(projectId, policy.body, requester.id, contributors, []);
        const deadline = minutesLater(now, policy.body.deadlineMinutes);
        const state: ReviewRouteBody["state"] = mandatory ? "escalated" : chosen.assigned !== undefined ? "assigned" : "waiting";
        const route: ReviewRouteBody = {
          projectId, taskId, requester: requester.id, state, ...(chosen.assigned === undefined ? {} : { assigned: chosen.assigned, assignedVia: chosen.via!, assignedAt: now }), tried: [], contributors, deadline, mandatoryHuman: mandatory,
          events: addEvent([], now, mandatory ? "owner-only" : state === "assigned" ? "assigned" : "waiting", mandatory ? ownerOnly ? `${operation.name} was requested as owner-only` : `${operation.name} is reserved for the owner by the project's policy` : state === "assigned" ? `${chosen.assigned} (${chosen.via})` : `no eligible reviewer: ${chosen.excluded.map((e) => `${e.id} ${e.reason}`).join("; ").slice(0, 200) || "none designated or holding the review right"}`),
          requestedAt: now,
        };
        const ref: AggregateRef = { kind: "review", id };
        const body: ReviewBody = { binding, operation, ...(note === undefined ? {} : { note }), context, state: mandatory ? "owner-decision" : "pending", requestedAt: now };
        return {
          ref, creates: true,
          changes: [...guard, { type: "create", ref, body: body as unknown as JsonObject }, { type: "create", ref: { kind: "review-route", id }, body: route as unknown as JsonObject }, { type: "create", ref: { kind: `review-task-${taskId}`, id }, body: {} }],
          detail: { taskId, name: operation.name, argsDigest: binding.argsDigest, route: state, ...(chosen.assigned === undefined ? {} : { assigned: chosen.assigned }) },
        };
      },
    }));
    return { id: r.id, replayed: r.replayed, cleared: r.id !== id };
  }

  /**
   * A reviewer gives one of four verdicts. Only the reviewer the review is assigned to (or the owner) may decide a pending review, never its requester or a contributor to the work, and
   * only the owner may decide one that is reserved for the owner or sent to the owner. `allow` needs the essential context (tool version, authority source, expected effects); without it
   * the verdict is refused, and the reviewer can ask for it with `request-context`.
   */
  async decide(reviewer: Principal, command: Decide): Promise<void> {
    onlyKnown(command, ["commandId", "requestId", "expectedRevision", "verdict", "reason", "expiresAt", "cost"]);
    const id = this.#id(command.requestId);
    const expected = checkRevision(command.expectedRevision);
    const verdict = typeof command.verdict === "string" && VERDICTS.includes(command.verdict) ? command.verdict as Verdict : invalid("verdict", "must be allow, deny, request-context or requires-owner-decision");
    const reason = text(command.reason, "reason", { min: 1, max: REVIEW_LIMITS.reason, multiline: true });
    if (redactText(reason) !== reason) invalid("reason", "looks like a credential or key; those are not recorded in a review");
    if (command.expiresAt !== undefined && !(typeof command.expiresAt === "string" && TIMESTAMP.test(command.expiresAt))) invalid("expiresAt", "must be a UTC timestamp such as 2026-10-21T12:00:00.000Z");
    const cost = command.cost === undefined ? undefined : (typeof command.cost === "number" && Number.isFinite(command.cost) && command.cost >= 0 && command.cost <= ROUTING_LIMITS.cost ? command.cost : invalid("cost", `must be a number from 0 to ${ROUTING_LIMITS.cost}`));
    const fresh = await this.#fresh(reviewer.id, reviewer.taskScope);
    await this.#runner.command("review.decide", { commandId: scopedCommandId(reviewer.id, command.commandId), actor: reviewer.id }, async () => ({
      payload: { requestId: id, expectedRevision: expected, verdict, reason, ...(command.expiresAt === undefined ? {} : { expiresAt: command.expiresAt }), ...(cost === undefined ? {} : { cost }) },
      build: async () => {
        const current = await this.#runner.get("review", id);
        const body = current?.body as unknown as ReviewBody | undefined;
        const routeAggregate = await this.#runner.get("review-route", id);
        const route = routeAggregate?.body as unknown as ReviewRouteBody | undefined;
        // Not there, or not a review this principal may decide: one refusal. Deciding needs the review right in the project, and the reviewer cannot be the requester or a contributor.
        const isOwner = reviewer.kind === "owner";
        if (current === undefined || body === undefined || route === undefined || routeAggregate === undefined || fresh === undefined || !allows(fresh, "review.decide", body.binding.projectId) || reviewer.id === body.binding.requester || route.contributors.includes(reviewer.id)) {
          throw new DomainError("forbidden", `${reviewer.id} may not decide that review`);
        }
        // A review in owner mode (reserved for the owner, escalated or sent to the owner) stays the owner's whatever state it is in later and whoever it was once assigned to (card H12h).
        if (!isOwner && (ownerMode(body, route) || route.assigned !== reviewer.id)) throw new DomainError("forbidden", `${reviewer.id} may not decide that review: ${ownerMode(body, route) ? "only the owner can" : "it is not assigned to them"}`);
        // A tool the owner has reserved since the request was made is the owner's to review: the gate is read now, not when the request was routed.
        const reservedNow = (await this.#policy(body.binding.projectId)).body.mandatoryHuman.includes(body.operation.name);
        if (!isOwner && reservedNow) throw new DomainError("forbidden", `${reviewer.id} may not decide that review: ${body.operation.name} is now reserved for the owner`);
        // A held reviewer does not decide: it is not woken to review, and the review keeps its place (and its deadline) until the reviewer is resumed or the review moves on.
        const held = isOwner ? undefined : await this.#held(reviewer.id);
        if (held !== undefined) throw new DomainError("invalid_command", `${reviewer.id} is ${held} and does not decide while held; the review waits for it, or moves on at its deadline`, { field: "reviewer" });
        if (current.revision !== expected) throw new DomainError("stale_revision", `review ${id} is at revision ${current.revision}, not ${expected}`, { currentRevision: current.revision });
        if (body.state !== "pending" && body.state !== "owner-decision") throw new DomainError("invalid_command", `review ${id} is ${body.state}; only a pending review can be decided${body.state === "needs-context" ? " (the requester has to supply the context asked for)" : ""}`, { field: "requestId" });
        if (isOwner && verdict === "requires-owner-decision") throw new DomainError("invalid_command", "the owner is the one who decides; give allow or deny", { field: "verdict" });
        const now = this.#runner.now();
        const ref: AggregateRef = { kind: "review", id };
        const routeRef: AggregateRef = { kind: "review-route", id };
        let next: ReviewBody;
        let nextRoute: ReviewRouteBody;
        const owned = verdict === "allow" ? await this.#decisionChanges(body.binding.taskId, "an approval") : [];
        if (verdict === "allow") {
          const missing = missingEssentials(body.context);
          if (missing.length > 0) throw new DomainError("invalid_command", `essential context is missing (${missing.join(", ")}); an allow needs it. Ask for it with request-context`, { field: "context" });
          const longest = new Date(Date.parse(now) + REVIEW_LIMITS.maxHours * 3_600_000).toISOString();
          const expiresAt = command.expiresAt ?? new Date(Date.parse(now) + REVIEW_LIMITS.defaultMinutes * 60_000).toISOString();
          if (expiresAt <= now || expiresAt > longest) throw new DomainError("invalid_command", `expiresAt: must be after now and within ${REVIEW_LIMITS.maxHours} hours`, { field: "expiresAt" });
          next = { ...body, state: "approved", decidedBy: reviewer.id, decidedAt: now, reason, expiresAt };
        } else if (verdict === "deny") {
          next = { ...body, state: "denied", decidedBy: reviewer.id, decidedAt: now, reason };
        } else if (verdict === "request-context") {
          next = { ...body, state: "needs-context", contextRequest: reason };
        } else {
          next = { ...body, state: "owner-decision" };
        }
        const final = verdict === "allow" || verdict === "deny";
        const assignedAt = route.assignedAt ?? route.requestedAt;
        nextRoute = {
          ...route,
          ...(final ? { decidedAt: now, verdict, queueMs: Math.max(0, Date.parse(assignedAt) - Date.parse(route.requestedAt)), latencyMs: Math.max(0, Date.parse(now) - Date.parse(assignedAt)), ...(cost === undefined ? {} : { cost }) } : {}),
          ...(verdict === "requires-owner-decision" ? { state: "escalated" as const, deadline: minutesLater(now, (await this.#policy(body.binding.projectId)).body.deadlineMinutes) } : {}),
          events: addEvent(route.events, now, verdict, `${reviewer.id}: ${reason}`),
        };
        const policyNow = await this.#policy(body.binding.projectId);
        return {
          ref, creates: false,
          changes: [
            { type: "update", ref, expectedRevision: current.revision, body: next as unknown as JsonObject },
            { type: "update", ref: routeRef, expectedRevision: routeAggregate.revision, body: nextRoute as unknown as JsonObject },
            ...(policyNow.revision === 0 ? [] : [{ type: "check" as const, ref: { kind: "review-policy", id: body.binding.projectId }, expectedRevision: policyNow.revision }]),
            ...owned,
          ],
          detail: { verdict, requester: body.binding.requester, argsDigest: body.binding.argsDigest },
        };
      },
    }));
  }

  /** The reviewer who approved, the requester or the owner takes an approval (or an open request) back before it is used. */
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
        if (current === undefined || body === undefined || !(principal.kind === "owner" || (inTaskScope(principal, body.binding.projectId) && (principal.id === body.decidedBy || principal.id === body.binding.requester)))) throw new DomainError("forbidden", `${principal.id} may not withdraw that review`);
        if (current.revision !== expected) throw new DomainError("stale_revision", `review ${id} is at revision ${current.revision}, not ${expected}`, { currentRevision: current.revision });
        if (!["pending", "approved", "needs-context", "owner-decision"].includes(body.state)) throw new DomainError("invalid_command", `review ${id} is ${body.state}; it cannot be withdrawn`, { field: "requestId" });
        const next: ReviewBody = { ...body, state: "withdrawn", withdrawnBy: principal.id, reason };
        const ref: AggregateRef = { kind: "review", id };
        const changes: Change[] = [{ type: "update", ref, expectedRevision: current.revision, body: next as unknown as JsonObject }];
        const routeAggregate = await this.#runner.get("review-route", id);
        if (routeAggregate !== undefined) {
          const route = routeAggregate.body as unknown as ReviewRouteBody;
          changes.push({ type: "update", ref: { kind: "review-route", id }, expectedRevision: routeAggregate.revision, body: { ...route, withdrawn: true, events: addEvent(route.events, this.#runner.now(), "withdrawn", `${principal.id}: ${reason}`) } as unknown as JsonObject });
        }
        return { ref, creates: false, changes, detail: { by: principal.id } };
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
        const fresh = await this.#fresh(executor.id, executor.taskScope);
        if (fresh === undefined) throw new DomainError("unauthenticated", "the credential was not accepted");
        if (body.state !== "approved") throw new DomainError("review_invalid", `review ${id} is ${body.state}, not approved`, { field: "requestId" });
        const policy = await this.#policy(body.binding.projectId);
        if (policy.body.mandatoryHuman.includes(body.operation.name) && !(body.decidedBy ?? "").startsWith("owner:")) throw new DomainError("review_invalid", `${body.operation.name} is now reserved for the owner; an approval by ${body.decidedBy ?? "an agent"} no longer admits it`, { field: "requestId" });
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
        const policyGuard: Change[] = policy.revision === 0 ? [] : [{ type: "check", ref: { kind: "review-policy", id: body.binding.projectId }, expectedRevision: policy.revision }];
        const owned = await this.#decisionChanges(body.binding.taskId, "this approval");
        return { ref, creates: false, changes: [change, ...policyGuard, ...owned], detail: { name: operation.name, argsDigest: actual.argsDigest }, contention: async () => new DomainError("review_invalid", `review ${id} was used or changed at the same moment`, { field: "requestId" }) };
      },
    }));
    return { admitted: true, requestId: r.id, replayed: r.replayed };
  }

  /** The IDs of the reviews made for one task, in ID order (an index written with each review, so reading it never scans other tasks' reviews). */
  async reviewIdsForTask(taskId: string, limit = 500): Promise<string[]> {
    const out: string[] = [];
    for (let after: string | undefined; ;) {
      const page = await this.#runner.list(`review-task-${checkTaskId(taskId)}`, { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const a of page) { after = a.id; out.push(a.id); if (out.length >= limit) return out; }
      if (page.length < 200) return out;
    }
  }

  /** A review, as seen by the requester, the reviewer who decided it, or the owner (anyone else gets `undefined`). */
  async get(principal: Principal, requestId: string): Promise<View<ReviewBody> | undefined> {
    const found = typeof requestId === "string" && REVIEW_ID.test(requestId) ? await this.#runner.get("review", requestId) : undefined;
    if (found === undefined) return undefined;
    const body = found.body as unknown as ReviewBody;
    const fresh = await this.#fresh(principal.id, principal.taskScope);
    const mayReview = fresh !== undefined && allows(fresh, "review.decide", body.binding.projectId);
    if (principal.kind !== "owner" && principal.id !== body.binding.requester && principal.id !== body.decidedBy && !mayReview) return undefined;
    // A review in owner mode is not shown to an agent reviewer: it is not sent to one (card H12h). The requester and whoever decided it still see it.
    if (principal.kind !== "owner" && principal.id !== body.binding.requester && principal.id !== body.decidedBy) {
      const route = (await this.#runner.get("review-route", requestId))?.body as unknown as ReviewRouteBody | undefined;
      if (route === undefined || ownerMode(body, route) || (await this.#policy(body.binding.projectId)).body.mandatoryHuman.includes(body.operation.name)) return undefined;
    }
    return view<ReviewBody>(found);
  }

  // ---- policy, context, contributors and escalation (card H05) --------------------------------------------------------------

  /** Sets who may review in a project. Needs `review.policy.write` there. Without `expectedRevision` it creates the policy; with it, it replaces it. A change applies to requests made afterwards. */
  async setPolicy(by: Principal, command: NoActor & { projectId: string; policy: unknown; expectedRevision?: number }): Promise<void> {
    onlyKnown(command, ["commandId", "projectId", "policy", "expectedRevision"]);
    const projectId = checkProjectId(command.projectId);
    const policy = checkPolicy(command.policy);
    const fresh = await this.#fresh(by.id, by.taskScope);
    const expected = command.expectedRevision === undefined ? undefined : checkRevision(command.expectedRevision);
    await this.#runner.command("review.policy.set", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { projectId, policy: policy as unknown as JsonObject, expectedRevision: expected ?? null },
      build: async () => {
        if (fresh === undefined || !allows(fresh, "review.policy.write", projectId)) throw new DomainError("forbidden", `${by.id} may not set the review policy of ${projectId}`);
        if ((await this.#runner.get("project", projectId)) === undefined) throw new DomainError("not_found", `project ${projectId} does not exist`);
        for (const reviewer of [...policy.reviewers, ...policy.fallbackReviewers]) {
          const found = await this.#runner.get("principal", reviewer);
          const b = found?.body as unknown as PrincipalBody | undefined;
          if (b === undefined || b.kind !== "agent" || b.state !== "active") invalid("policy", `${reviewer} is not an active agent`);
        }
        const ref: AggregateRef = { kind: "review-policy", id: projectId };
        if (expected === undefined) return { ref, creates: true, changes: [{ type: "create", ref, body: policy as unknown as JsonObject }], detail: { projectId }, contention: async () => new DomainError("stale_revision", `the review policy of ${projectId} already exists; give expectedRevision to replace it`) };
        const current = await this.#runner.existing("review-policy", projectId, expected);
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: policy as unknown as JsonObject }], detail: { projectId } };
      },
    }));
  }

  /** The project's review policy (the defaults, at revision 0, when none was set). Readable by anyone who may request, decide or set policy there. */
  async getPolicy(principal: Principal, projectId: string): Promise<{ policy: ReviewPolicyBody; revision: number } | undefined> {
    const id = checkProjectId(projectId);
    const fresh = await this.#fresh(principal.id, principal.taskScope);
    if (fresh === undefined || !(allows(fresh, "review.policy.write", id) || allows(fresh, "review.decide", id) || allows(fresh, "review.request", id))) return undefined;
    const p = await this.#policy(id);
    return { policy: p.body, revision: p.revision };
  }

  /** The requester (or the owner) answers a reviewer's request for more context; the review goes back to the same reviewer with a fresh deadline. */
  async supplyContext(principal: Principal, command: NoActor & { requestId: string; expectedRevision: number; context: ReviewContext }): Promise<void> {
    onlyKnown(command, ["commandId", "requestId", "expectedRevision", "context"]);
    const id = this.#id(command.requestId);
    const expected = checkRevision(command.expectedRevision);
    await this.#runner.command("review.context", { commandId: scopedCommandId(principal.id, command.commandId), actor: principal.id }, async () => {
      const current0 = await this.#runner.get("review", id);
      const script = (current0?.body as unknown as ReviewBody | undefined)?.operation.script;
      const context = checkContext(command.context, script);
      return {
        payload: { requestId: id, expectedRevision: expected, context: context as unknown as JsonObject },
        build: async () => {
          const current = await this.#runner.get("review", id);
          const body = current?.body as unknown as ReviewBody | undefined;
          const routeAggregate = await this.#runner.get("review-route", id);
          if (current === undefined || body === undefined || routeAggregate === undefined || !(principal.kind === "owner" || (inTaskScope(principal, body.binding.projectId) && principal.id === body.binding.requester))) throw new DomainError("forbidden", `${principal.id} may not supply context for that review`);
          if (current.revision !== expected) throw new DomainError("stale_revision", `review ${id} is at revision ${current.revision}, not ${expected}`, { currentRevision: current.revision });
          if (body.state !== "needs-context") throw new DomainError("invalid_command", `review ${id} is ${body.state}; context can be supplied only when the reviewer has asked for it`, { field: "requestId" });
          const now = this.#runner.now();
          const route = routeAggregate.body as unknown as ReviewRouteBody;
          const { contextRequest: _asked, ...rest } = body;
          const policyNow = await this.#policy(body.binding.projectId);
          // The answer goes back to the owner when the review is in owner mode (or the tool has been reserved since), never to an agent.
          const reserved = policyNow.body.mandatoryHuman.includes(body.operation.name);
          const next: ReviewBody = { ...rest, context: mergeContext(body.context, context), state: reserved || ownerMode(body, route) ? "owner-decision" : "pending" };
          const nextRoute: ReviewRouteBody = { ...route, deadline: minutesLater(now, policyNow.body.deadlineMinutes), events: addEvent(route.events, now, "context", `${principal.id} supplied context`) };
          return {
            ref: { kind: "review", id }, creates: false,
            changes: [
              { type: "update", ref: { kind: "review", id }, expectedRevision: current.revision, body: next as unknown as JsonObject },
              { type: "update", ref: { kind: "review-route", id }, expectedRevision: routeAggregate.revision, body: nextRoute as unknown as JsonObject },
            ],
            detail: { by: principal.id },
          };
        },
      };
    });
  }

  /**
   * The caller records that it has committed to the version under review, so it is a contributor and can never approve it. If it was the assigned reviewer, the review moves to someone else
   * (or waits); if it had already approved it, the approval is withdrawn. A principal can only record itself, and only if it may work on the task (the owner may record anyone's by naming them).
   */
  async addContributor(principal: Principal, command: NoActor & { requestId: string; contributor?: string }): Promise<void> {
    onlyKnown(command, ["commandId", "requestId", "contributor"]);
    const id = this.#id(command.requestId);
    const who = command.contributor === undefined ? principal.id : text(command.contributor, "contributor", { min: 1, max: 120 });
    if (who !== principal.id && principal.kind !== "owner") throw new DomainError("forbidden", `${principal.id} may only record itself as a contributor`);
    await this.#runner.command("review.contributor", { commandId: scopedCommandId(principal.id, command.commandId), actor: principal.id }, async () => ({
      payload: { requestId: id, contributor: who },
      build: async () => {
        const current = await this.#runner.get("review", id);
        const body = current?.body as unknown as ReviewBody | undefined;
        const routeAggregate = await this.#runner.get("review-route", id);
        const fresh = await this.#fresh(principal.id, principal.taskScope);
        if (current === undefined || body === undefined || routeAggregate === undefined || fresh === undefined) throw new DomainError("forbidden", `${principal.id} may not record a contributor on that review`);
        const resource = { kind: "task", id: body.binding.taskId };
        if (principal.kind !== "owner" && !allows(fresh, "attempt.work", body.binding.projectId, { resource })) throw new DomainError("forbidden", `${principal.id} may not record a contributor on that review`);
        const route = routeAggregate.body as unknown as ReviewRouteBody;
        const now = this.#runner.now();
        const contributors = route.contributors.includes(who) ? route.contributors : [...route.contributors, who];
        let nextRoute: ReviewRouteBody = { ...route, contributors, events: addEvent(route.events, now, "contributor", who) };
        let next = body;
        const open = body.state === "pending" || body.state === "needs-context";
        if (open && route.assigned === who && !ownerMode(body, route)) {
          const policy = await this.#policy(body.binding.projectId);
          const tried = [...new Set([...route.tried, who])];
          const chosen = await this.#choose(body.binding.projectId, policy.body, route.requester, contributors, tried);
          const { assigned: _gone, assignedVia: _via, assignedAt: _at, reviewerStatus: _status, ...kept } = nextRoute;
          nextRoute = chosen.assigned === undefined
            ? { ...kept, tried, state: "waiting", deadline: minutesLater(now, policy.body.deadlineMinutes), events: addEvent(nextRoute.events, now, "waiting", `${who} became a contributor and no one else is eligible`) }
            : { ...kept, tried, state: "assigned", assigned: chosen.assigned, assignedVia: chosen.via!, assignedAt: now, deadline: minutesLater(now, policy.body.deadlineMinutes), events: addEvent(nextRoute.events, now, "reassigned", `${who} became a contributor; now ${chosen.assigned}`) };
        }
        if (body.state === "approved" && body.decidedBy === who) {
          next = { ...body, state: "withdrawn", withdrawnBy: who, reason: "the approver became a contributor to the version under review" };
          nextRoute = { ...nextRoute, withdrawn: true, events: addEvent(nextRoute.events, now, "withdrawn", `approval by ${who} withdrawn: they became a contributor`) };
        }
        const ref: AggregateRef = { kind: "review", id };
        return {
          ref, creates: false,
          changes: [
            { type: "update", ref, expectedRevision: current.revision, body: next as unknown as JsonObject },
            { type: "update", ref: { kind: "review-route", id }, expectedRevision: routeAggregate.revision, body: nextRoute as unknown as JsonObject },
          ],
          detail: { contributor: who, state: next.state },
        };
      },
    }));
  }

  /**
   * Moves reviews along (needs `review.policy.write` in the project). A waiting review takes a reviewer as soon as one is eligible. A review whose reviewer missed the deadline goes to another
   * eligible reviewer (the authorized fallbacks included), and when there is none it goes to the owner. A review waiting for context is not touched: only the gated change waits.
   * Nothing is ever approved by waiting. A scheduler calls this; each call handles at most 50 reviews and says if more remain.
   */
  async sweep(by: Principal, command: NoActor & { projectId: string }): Promise<{ reassigned: string[]; escalated: string[]; assigned: string[]; more: boolean }> {
    onlyKnown(command, ["commandId", "projectId"]);
    const projectId = checkProjectId(command.projectId);
    const fresh = await this.#fresh(by.id, by.taskScope);
    if (fresh === undefined || !allows(fresh, "review.policy.write", projectId)) throw new DomainError("forbidden", `${by.id} may not move reviews along in ${projectId}`);
    if ((await this.#runner.get("project", projectId)) === undefined) throw new DomainError("not_found", `project ${projectId} does not exist`);
    // Nothing to move is not a command: it changes nothing, so there is nothing to record.
    const looked = await this.#sweepPlan(projectId);
    if (looked.changes.length === 0) return { reassigned: [], escalated: [], assigned: [], more: false };
    let done = looked;
    await this.#runner.command("review.sweep", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { projectId },
      build: async () => {
        done = await this.#sweepPlan(projectId);
        if (done.changes.length === 0) throw new DomainError("stale_revision", `the reviews of ${projectId} moved meanwhile; ask again`);
        const first = done.changes.find((c) => c.type === "update")!;
        return { ref: first.ref, creates: false, changes: done.changes, detail: { projectId, moved: done.reassigned.length + done.escalated.length + done.assigned.length, noted: done.noted.length } };
      },
    }));
    return { reassigned: done.reassigned, escalated: done.escalated, assigned: done.assigned, more: done.more };
  }

  async #sweepPlan(projectId: string): Promise<{ changes: Change[]; reassigned: string[]; escalated: string[]; assigned: string[]; noted: string[]; more: boolean }> {
    const out = { changes: [] as Change[], reassigned: [] as string[], escalated: [] as string[], assigned: [] as string[], noted: [] as string[], more: false };
    const policy = await this.#policy(projectId);
    const now = this.#runner.now();
    let handled = 0;
    for (const routeAggregate of await this.#routesOf(projectId)) {
      const route = routeAggregate.body as unknown as ReviewRouteBody;
      if (route.verdict !== undefined || route.withdrawn === true || route.state === "escalated") continue;
      const review = await this.#runner.get("review", routeAggregate.id);
      const body = review?.body as unknown as ReviewBody | undefined;
      if (review === undefined || body === undefined || body.state !== "pending") continue;
      const late = route.deadline <= now;
      if (policy.body.mandatoryHuman.includes(body.operation.name)) {
        // Reserved for the owner since it was routed: it goes to the owner now, not at the deadline.
        if (handled >= 49) { out.more = true; break; }
        handled += 1;
        out.escalated.push(routeAggregate.id);
        const { assigned: _g, assignedVia: _w, assignedAt: _x, reviewerStatus: _y, ...rest } = route;
        out.changes.push({ type: "update", ref: { kind: "review-route", id: routeAggregate.id }, expectedRevision: routeAggregate.revision, body: { ...rest, state: "escalated", mandatoryHuman: true, events: addEvent(route.events, now, "owner-only", `${body.operation.name} is now reserved for the owner`) } as unknown as JsonObject });
        out.changes.push({ type: "update", ref: { kind: "review", id: review.id }, expectedRevision: review.revision, body: { ...body, state: "owner-decision" } as unknown as JsonObject });
        continue;
      }
      // What the assigned reviewer is doing: held, on a lost host, on a quiet one, or simply slow (nothing to report).
      const status = route.state === "assigned" && route.assigned !== undefined ? await this.#standing(route.assigned) : undefined;
      // A lost host (a revoked identity, a fact) moves the review at once; a held reviewer keeps it until the deadline, and a quiet host or a slow reviewer likewise.
      const early = status === "host-lost";
      const noted = (): void => {
        if (status === route.reviewerStatus) return;
        if (handled >= 49) { out.more = true; return; }
        handled += 1;
        const { reviewerStatus: _old, ...rest } = route;
        const text = status === "held" ? `${route.assigned} is held; the review keeps its place until ${route.deadline}` : status === "host-lost" ? `the host of ${route.assigned} is lost (identity revoked) and no one else is eligible yet` : status === "host-silent" ? `the host of ${route.assigned} has gone quiet; that cannot tell a lost host from a partition or a slow reviewer, so the deadline stands` : `${route.assigned} is no longer held`;
        out.changes.push({ type: "update", ref: { kind: "review-route", id: routeAggregate.id }, expectedRevision: routeAggregate.revision, body: { ...rest, ...(status === undefined ? {} : { reviewerStatus: status }), events: addEvent(route.events, now, status === undefined ? "resumed" : status, text) } as unknown as JsonObject });
        out.changes.push({ type: "check", ref: { kind: "review", id: review.id }, expectedRevision: review.revision });
        out.noted.push(routeAggregate.id);
      };
      if (route.state === "assigned" && !late && !early) { noted(); continue; }
      if (handled >= 49) { out.more = true; break; }
      let nextRoute: ReviewRouteBody;
      let nextBody = body;
      const tried = route.state === "assigned" && route.assigned !== undefined ? [...new Set([...route.tried, route.assigned])] : route.tried;
      const chosen = await this.#choose(projectId, policy.body, route.requester, route.contributors, tried);
      const { assigned: _a, assignedVia: _v, assignedAt: _t, reviewerStatus: _s, ...kept } = route;
      if (chosen.assigned !== undefined) {
        const why = route.state !== "assigned" ? "" : early && !late ? `; the host of ${route.assigned} is lost` : status === "held" ? `; ${route.assigned} was held and did not decide by the deadline` : `; ${route.assigned} did not decide in time`;
        nextRoute = { ...kept, tried, state: "assigned", assigned: chosen.assigned, assignedVia: chosen.via!, assignedAt: now, deadline: minutesLater(now, policy.body.deadlineMinutes), events: addEvent(route.events, now, route.state === "assigned" ? "reassigned" : "assigned", `${chosen.assigned} (${chosen.via})${why}`) };
        (route.state === "assigned" ? out.reassigned : out.assigned).push(routeAggregate.id);
      } else if (late) {
        nextRoute = { ...kept, tried, state: "escalated", deadline: minutesLater(now, policy.body.deadlineMinutes), events: addEvent(route.events, now, "escalated", "no eligible reviewer decided in time; the owner decides") };
        nextBody = { ...body, state: "owner-decision" };
        out.escalated.push(routeAggregate.id);
      } else { noted(); continue; }
      handled += 1;
      out.changes.push({ type: "update", ref: { kind: "review-route", id: routeAggregate.id }, expectedRevision: routeAggregate.revision, body: nextRoute as unknown as JsonObject });
      out.changes.push(nextBody !== body
        ? { type: "update", ref: { kind: "review", id: review.id }, expectedRevision: review.revision, body: nextBody as unknown as JsonObject }
        : { type: "check", ref: { kind: "review", id: review.id }, expectedRevision: review.revision });
    }
    if (out.changes.length > 0 && policy.revision !== 0) out.changes.push({ type: "check", ref: { kind: "review-policy", id: projectId }, expectedRevision: policy.revision });
    return out;
  }

  /**
   * Records how a verdict turned out, for the figures kept about reviewing: a denial that blocked something good is a false block; an allowance that let a hazard through is a missed hazard.
   * Needs `review.policy.write` in the project.
   */
  async recordOutcome(by: Principal, command: NoActor & { requestId: string; falseBlock?: boolean; missedHazard?: boolean }): Promise<void> {
    onlyKnown(command, ["commandId", "requestId", "falseBlock", "missedHazard"]);
    const id = this.#id(command.requestId);
    if (command.falseBlock !== undefined && typeof command.falseBlock !== "boolean") invalid("falseBlock", "must be true or false");
    if (command.missedHazard !== undefined && typeof command.missedHazard !== "boolean") invalid("missedHazard", "must be true or false");
    if (command.falseBlock === undefined && command.missedHazard === undefined) invalid("falseBlock", "give falseBlock or missedHazard");
    const fresh = await this.#fresh(by.id, by.taskScope);
    await this.#runner.command("review.outcome", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { requestId: id, falseBlock: command.falseBlock ?? null, missedHazard: command.missedHazard ?? null },
      build: async () => {
        const routeAggregate = await this.#runner.get("review-route", id);
        const route = routeAggregate?.body as unknown as ReviewRouteBody | undefined;
        if (routeAggregate === undefined || route === undefined || fresh === undefined || !allows(fresh, "review.policy.write", route.projectId)) throw new DomainError("forbidden", `${by.id} may not record the outcome of that review`);
        if (command.falseBlock === true && route.verdict !== "deny") throw new DomainError("invalid_command", "only a denied review can be a false block", { field: "falseBlock" });
        if (command.missedHazard === true && route.verdict !== "allow") throw new DomainError("invalid_command", "only an allowed review can be a missed hazard", { field: "missedHazard" });
        const next: ReviewRouteBody = { ...route, ...(command.falseBlock === undefined ? {} : { falseBlock: command.falseBlock }), ...(command.missedHazard === undefined ? {} : { missedHazard: command.missedHazard }), events: addEvent(route.events, this.#runner.now(), "outcome", `${by.id}`) };
        const ref: AggregateRef = { kind: "review-route", id };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: routeAggregate.revision, body: next as unknown as JsonObject }], detail: { by: by.id } };
      },
    }));
  }

  /** The figures kept about reviewing in a project: counts by verdict, queue delay, latency, cost, false blocks and missed hazards. Needs `review.policy.write` there. */
  async metrics(by: Principal, projectId: string): Promise<{ reviews: number; decided: number; open: number; escalated: number; allowed: number; denied: number; falseBlocks: number; missedHazards: number; averageQueueMs: number | null; averageLatencyMs: number | null; totalCost: number }> {
    const id = checkProjectId(projectId);
    const fresh = await this.#fresh(by.id, by.taskScope);
    if (fresh === undefined || !allows(fresh, "review.policy.write", id)) throw new DomainError("forbidden", `${by.id} may not read the review figures of ${id}`);
    const routes = (await this.#routesOf(id)).map((r) => r.body as unknown as ReviewRouteBody);
    const decided = routes.filter((r) => r.verdict !== undefined);
    const mean = (xs: number[]): number | null => (xs.length === 0 ? null : Math.round(xs.reduce((a, b) => a + b, 0) / xs.length));
    return {
      reviews: routes.length, decided: decided.length, open: routes.filter((r) => r.verdict === undefined && r.withdrawn !== true).length,
      escalated: routes.filter((r) => r.events.some((e) => e.event === "escalated" || e.event === "owner-only" || e.event === "requires-owner-decision")).length,
      allowed: decided.filter((r) => r.verdict === "allow").length, denied: decided.filter((r) => r.verdict === "deny").length,
      falseBlocks: routes.filter((r) => r.falseBlock === true).length, missedHazards: routes.filter((r) => r.missedHazard === true).length,
      averageQueueMs: mean(decided.map((r) => r.queueMs ?? 0)), averageLatencyMs: mean(decided.map((r) => r.latencyMs ?? 0)), totalCost: decided.reduce((a, r) => a + (r.cost ?? 0), 0),
    };
  }

  /** Where a review stands in routing, for the requester, the reviewer it is assigned to or decided it, or the owner (anyone else gets `undefined`). */
  async getRoute(principal: Principal, requestId: string): Promise<View<ReviewRouteBody> | undefined> {
    const review = await this.get(principal, requestId);
    if (review === undefined) return undefined;
    const found = await this.#runner.get("review-route", requestId);
    return found === undefined ? undefined : view<ReviewRouteBody>(found);
  }

  /**
   * The wait-for edges the open reviews of a project add (supplied to the wait graph, card S10): a task waiting for a review waits on the unfinished tasks of the reviewer the review is
   * assigned to, because the reviewer is busy with them. A review waiting for context, or sent to the owner, adds none.
   */
  async waitEdges(projectId: string, tasks: ReadonlyMap<string, { readonly state: string; readonly owner?: string }>): Promise<WaitEdge[]> {
    const edges: WaitEdge[] = [];
    const reserved = (await this.#policy(checkProjectId(projectId))).body.mandatoryHuman;
    for (const routeAggregate of await this.#routesOf(projectId)) {
      const route = routeAggregate.body as unknown as ReviewRouteBody;
      if (route.state !== "assigned" || route.assigned === undefined || route.verdict !== undefined || route.withdrawn === true) continue;
      const review = await this.#runner.get("review", routeAggregate.id);
      const pending = review?.body as unknown as ReviewBody | undefined;
      if (pending?.state !== "pending" || ownerMode(pending, route) || reserved.includes(pending.operation.name)) continue;
      for (const [id, t] of tasks) if (t.owner === route.assigned && t.state !== "done" && t.state !== "cancelled" && id !== route.taskId) edges.push({ fromTask: route.taskId, toTask: id, via: "review", detail: `review ${routeAggregate.id}: ${route.requester} waits for ${route.assigned}` });
    }
    return edges;
  }

  /**
   * Which reviewers a dispatcher may wake to review (needs `review.policy.write` in the project). A pending review assigned to a reviewer that is available is in `wake`; one whose reviewer is held (paused,
   * suspended or stopped) or whose host is lost is in `held` with the reason, and nobody is woken for it: the review keeps its place until the reviewer is resumed or the review moves on at its deadline.
   * At most 200 entries are returned in all; `more` says if there are others.
   */
  async wakeList(by: Principal, projectId: string): Promise<{ wake: { requestId: string; reviewer: string }[]; held: { requestId: string; reviewer: string; why: Unavailable }[]; more: boolean }> {
    const id = checkProjectId(projectId);
    const fresh = await this.#fresh(by.id, by.taskScope);
    if (fresh === undefined || !allows(fresh, "review.policy.write", id)) throw new DomainError("forbidden", `${by.id} may not list the reviews to wake in ${id}`);
    const reserved = (await this.#policy(id)).body.mandatoryHuman;
    const out = { wake: [] as { requestId: string; reviewer: string }[], held: [] as { requestId: string; reviewer: string; why: Unavailable }[], more: false };
    for (const routeAggregate of await this.#routesOf(id)) {
      const route = routeAggregate.body as unknown as ReviewRouteBody;
      if (route.state !== "assigned" || route.assigned === undefined || route.verdict !== undefined || route.withdrawn === true) continue;
      const pending = (await this.#runner.get("review", routeAggregate.id))?.body as unknown as ReviewBody | undefined;
      if (pending?.state !== "pending") continue;
      // No one is woken for a review in owner mode, nor for one whose tool has been reserved for the owner since it was routed (card H12h).
      if (ownerMode(pending, route) || reserved.includes(pending.operation.name)) continue;
      if (out.wake.length + out.held.length >= 200) { out.more = true; break; }
      const why = await this.#unavailable(route.assigned);
      if (why === undefined) out.wake.push({ requestId: routeAggregate.id, reviewer: route.assigned });
      else out.held.push({ requestId: routeAggregate.id, reviewer: route.assigned, why });
    }
    return out;
  }

  // ---- internals -------------------------------------------------------------------------------------------------------------

  /** The revision checks of the owner's decisions to commit with an approval; refuses (`review_invalid`) when the task's work no longer rests on the owner's current decisions. */
  async #decisionChanges(taskId: string, what: string): Promise<readonly Change[]> {
    if (this.#decisions === undefined) return [];
    const g = await this.#decisions.guard(taskId, "effect");
    if (g.blockedBy.length > 0) throw new DomainError("review_invalid", `${what} cannot stand: ${g.blockedBy.join("; ")}`, { field: "requestId" });
    return g.changes;
  }

  /** The project's policy, or the defaults at revision 0. */
  async #policy(projectId: string): Promise<{ body: ReviewPolicyBody; revision: number }> {
    const found = await this.#runner.get("review-policy", projectId);
    return found === undefined ? { body: DEFAULT_POLICY, revision: 0 } : { body: found.body as unknown as ReviewPolicyBody, revision: found.revision };
  }

  /** The routes of one project, failing closed when there are too many to look at safely. */
  async #routesOf(projectId: string): Promise<Aggregate[]> {
    const out: Aggregate[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await this.#runner.list("review-route", { ...(after === undefined ? {} : { afterId: after }), limit: 500 });
      for (const r of page) {
        if ((r.body as unknown as ReviewRouteBody).projectId !== projectId) continue;
        out.push(r);
        if (out.length > ROUTING_LIMITS.scan) throw new DomainError("unavailable", `there are more than ${ROUTING_LIMITS.scan} reviews in the project, too many to look at safely`);
      }
      if (page.length < 500) return out;
      after = page.at(-1)!.id;
    }
  }

  /** An approved, unexpired, unused review of exactly this binding, if the approval may stand in for a new request. */
  async #coveringApproval(projectId: string, binding: Binding, mandatory: boolean, now: string): Promise<{ review: Aggregate; route: Aggregate } | undefined> {
    const wanted = canonicalJson(binding as unknown as JsonObject);
    for (const route of await this.#routesOf(projectId)) {
      const r = route.body as unknown as ReviewRouteBody;
      if (r.verdict !== "allow" || r.withdrawn === true || r.requester !== binding.requester) continue;
      const review = await this.#runner.get("review", route.id);
      const b = review?.body as unknown as ReviewBody | undefined;
      if (review === undefined || b === undefined || b.state !== "approved" || b.expiresAt === undefined || b.expiresAt <= now) continue;
      if (canonicalJson(b.binding as unknown as JsonObject) !== wanted) continue;
      // A tool reserved for the owner is never cleared by an agent's approval.
      if (mandatory && !(b.decidedBy ?? "").startsWith("owner:")) continue;
      return { review, route };
    }
    return undefined;
  }

  /**
   * Picks the reviewer: designated reviewers first (or, when none are designated, every active agent holding the review right), the least loaded first, never the requester, a contributor
   * (unless the policy only prefers independence and no one else is eligible) or one already tried; then the authorized fallbacks the same way.
   */
  async #choose(projectId: string, policy: ReviewPolicyBody, requester: string, contributors: readonly string[], tried: readonly string[]): Promise<{ assigned?: string; via?: "designated" | "pool" | "fallback"; excluded: { id: string; reason: string }[] }> {
    const excluded: { id: string; reason: string }[] = [];
    const load = new Map<string, number>();
    for (const route of await this.#routesOf(projectId)) {
      const r = route.body as unknown as ReviewRouteBody;
      if (r.state === "assigned" && r.assigned !== undefined && r.verdict === undefined && r.withdrawn !== true) load.set(r.assigned, (load.get(r.assigned) ?? 0) + 1);
    }
    const pool = async (ids: readonly string[], relax: boolean): Promise<string[]> => {
      const ok: string[] = [];
      for (const id of ids) {
        if (id === requester) { excluded.push({ id, reason: "is the requester" }); continue; }
        if (tried.includes(id)) { excluded.push({ id, reason: "was already tried" }); continue; }
        if (!relax && contributors.includes(id)) { excluded.push({ id, reason: "contributed to the work" }); continue; }
        const fresh = await this.#fresh(id);
        if (fresh === undefined || fresh.kind !== "agent") { excluded.push({ id, reason: "is not an active agent" }); continue; }
        if (!allows(fresh, "review.decide", projectId)) { excluded.push({ id, reason: "holds no review right here" }); continue; }
        // A held reviewer is never chosen (and so never woken), and neither is one whose host is lost.
        const unavailable = await this.#unavailable(id);
        if (unavailable !== undefined) { excluded.push({ id, reason: unavailable === "host-lost" ? "its host is lost" : `is ${unavailable}` }); continue; }
        ok.push(id);
      }
      return ok.sort((a, b) => (load.get(a) ?? 0) - (load.get(b) ?? 0) || (a < b ? -1 : 1));
    };
    const designated = policy.reviewers.length > 0 ? [...policy.reviewers] : await this.#allAgents();
    const via = policy.reviewers.length > 0 ? "designated" as const : "pool" as const;
    for (const relax of policy.independence === "preferred" ? [false, true] : [false]) {
      const first = (await pool(designated, relax))[0];
      if (first !== undefined) return { assigned: first, via, excluded };
    }
    for (const relax of policy.independence === "preferred" ? [false, true] : [false]) {
      const first = (await pool(policy.fallbackReviewers, relax))[0];
      if (first !== undefined) return { assigned: first, via: "fallback", excluded };
    }
    return { excluded };
  }

  /** `paused`, `suspended` or `stopped` when the reviewer is held (card L01), else `undefined`. */
  async #held(id: string): Promise<Exclude<Availability, "available"> | undefined> {
    const a = await this.#availability(id);
    return a === "available" ? undefined : a;
  }

  /** The state of the host a reviewer runs on, as far as it can be told. Only a revoked host identity is `lost`: an independent fact. A host that stopped heartbeating is `silent`, which a partition or a slow worker looks like too. */
  async #hostOf(id: string): Promise<"reachable" | "silent" | "lost" | "unknown"> {
    const hostId = await this.#reviewerHost?.(id);
    if (hostId === undefined) return "unknown";
    const principal = (await this.#runner.get("principal", hostId))?.body as unknown as PrincipalBody | undefined;
    if (principal === undefined || principal.kind !== "host") return "unknown";
    if (principal.state !== "active") return "lost";
    const record = (await this.#runner.get("host-record", hostId))?.body as unknown as HostBody | undefined;
    const fresh = hostFreshness(record?.lastSeenAt, this.#runner.now(), this.#hostStaleAfterMs);
    return fresh === "fresh" ? "reachable" : fresh === "stale" ? "silent" : "unknown";
  }

  /** What a sweep reports about an assigned reviewer; held takes precedence over the host. */
  async #standing(id: string): Promise<ReviewerStatus | undefined> {
    if ((await this.#held(id)) !== undefined) return "held";
    const host = await this.#hostOf(id);
    return host === "lost" ? "host-lost" : host === "silent" ? "host-silent" : undefined;
  }

  /** Why the reviewer cannot be chosen or woken now. */
  async #unavailable(id: string): Promise<Unavailable | undefined> {
    return (await this.#held(id)) ?? ((await this.#hostOf(id)) === "lost" ? "host-lost" : undefined);
  }

  async #allAgents(): Promise<string[]> {
    const out: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await this.#runner.list("principal", { ...(after === undefined ? {} : { afterId: after }), limit: 500 });
      for (const p of page) {
        const b = p.body as unknown as PrincipalBody;
        if (b.kind === "agent" && b.state === "active") out.push(p.id);
        if (out.length > ROUTING_LIMITS.scan) throw new DomainError("unavailable", `there are more than ${ROUTING_LIMITS.scan} agents, too many to look through for a reviewer`);
      }
      if (page.length < 500) return out;
      after = page.at(-1)!.id;
    }
  }

  #id(value: unknown): string {
    return typeof value === "string" && REVIEW_ID.test(value) ? value : invalid("requestId", "is not a review ID");
  }

  /** The principal as stored now, with its grant records and restrictions loaded now (never a snapshot the caller holds). `undefined` if it is not an active principal. */
  /** `scope` is passed when the principal is the caller, so a task credential stays inside its task when its grants are looked up again. */
  async #fresh(principalId: string, scope?: Principal["taskScope"]): Promise<Principal | undefined> {
    const found = await this.#runner.get("principal", principalId);
    const body = found?.body as unknown as PrincipalBody | undefined;
    if (found === undefined || body === undefined || body.state !== "active") return undefined;
    return effectiveOf(this.#runner, { id: found.id, kind: body.kind, name: body.name, grants: body.grants, ...(scope === undefined ? {} : { taskScope: scope }) }, this.#runner.now());
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
