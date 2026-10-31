import { DomainError } from "../domain/errors.js";
import type { AgreedLimitsReader } from "../api/agreed-limits-settings.js";
import { personalNamespace } from "../catalog/catalog.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, revision as checkRevision, text, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";
import { ACTIONS, allows, covers, mayHold } from "./access.js";
import { scopedCommandId } from "./credentials.js";
import type { NoActor, Principal, Restriction } from "./principals.js";
import { redactText } from "./redact.js";

/** Where a grant came from. `direct`: the owner's decision for something specific. `standing`: a lasting delegation. `derived`: a step reasonably necessary under another grant, never wider than it. */
export type GrantSource = "direct" | "standing" | "derived";

/** The thing a narrow grant is about, such as `{ kind: "task", id }`. A grant without one covers every resource in its project. */
export interface ResourceRef {
  readonly kind: string;
  readonly id: string;
}

/**
 * What a grant is conditional on (card A07). A grant with no terms covers its action everywhere in its project. Terms narrow it: the environments it applies to, the most it may spend, the
 * hours it applies in, the audiences it may send to or publish for, whether the grantee may hand a part of it on, and free-text conditions the owner stated (kept for explanation; a person
 * or an agent reviewer judges them, the engine does not).
 */
export interface GrantTerms {
  readonly environments?: readonly string[];
  readonly spendLimit?: number;
  /** Hours of the day, UTC, in which the grant applies, and optionally the days of the week (0 is Sunday). */
  readonly window?: { readonly start: string; readonly end: string; readonly days?: readonly number[] };
  readonly audiences?: readonly string[];
  /** The protected branches this approval may waive, by exact name (card A07f). Without it an approval never waives a change to a protected branch. */
  readonly branches?: readonly string[];
  readonly delegation?: boolean;
  readonly conditions?: readonly string[];
}

export interface GrantRecordBody {
  /** The principal that holds the authority. */
  readonly grantee: string;
  readonly action: string;
  /** A project ID, or `*` for every project (and for actions that belong to none). */
  readonly project: string;
  readonly resource?: ResourceRef;
  readonly source: GrantSource;
  /** Who decided it: the owner, or for a derived grant the principal on whose behalf it was derived. */
  readonly decidedBy: string;
  /** The wording or decision it records, kept as given so the grant can be explained later. */
  readonly basis: string;
  /** A derived grant names the grant it rests on; it is valid only while that one is. */
  readonly parentId?: string;
  readonly notBefore?: string;
  readonly expiresAt?: string;
  readonly terms?: GrantTerms;
  /** For a derived grant: how the grant at the root of its chain came about (`direct` or `standing`), so what a standing grant may not do a derived copy may not either. */
  readonly rootSource?: "direct" | "standing";
  readonly state: "active" | "revoked";
  readonly revokedBy?: string;
  readonly revokedReason?: string;
  /** When the owner revoked it (grants revoked before card A07d have none). */
  readonly revokedAt?: string;
}

const ENVIRONMENT = /^[a-z][a-z0-9-]{0,39}$/;
const HHMM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
/** Checks the terms of a grant; absent fields are left out. */
export function checkTerms(value: unknown): GrantTerms | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid("terms", "must be an object");
  const e = value as Record<string, unknown>;
  for (const key of Object.keys(e)) if (!["environments", "spendLimit", "window", "audiences", "branches", "delegation", "conditions"].includes(key)) invalid(`terms.${key}`, "is not a grant term");
  const list = (v: unknown, field: string, one: (x: unknown, f: string) => string, max: number): string[] => {
    if (!Array.isArray(v) || v.length > max) return invalid(field, `must be a list of at most ${max} entries`);
    return [...new Set(v.map((x, i) => one(x, `${field}[${i}]`)))].sort();
  };
  const out: { -readonly [K in keyof GrantTerms]: GrantTerms[K] } = {};
  if (e["environments"] !== undefined) out.environments = list(e["environments"], "terms.environments", (x, f) => (typeof x === "string" && ENVIRONMENT.test(x) ? x : invalid(f, "must be an environment name such as development")), 10);
  if (e["spendLimit"] !== undefined) {
    const v = e["spendLimit"];
    out.spendLimit = typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e9 ? v : invalid("terms.spendLimit", "must be a number from 0 to 1000000000");
  }
  if (e["window"] !== undefined) {
    const w = e["window"] as Record<string, unknown>;
    if (w === null || typeof w !== "object" || Array.isArray(w)) invalid("terms.window", "must be an object with start and end");
    for (const key of Object.keys(w)) if (!["start", "end", "days"].includes(key)) invalid(`terms.window.${key}`, "is not a window field");
    const start = typeof w["start"] === "string" && HHMM.test(w["start"]) ? w["start"] : invalid("terms.window.start", "must be a time such as 09:00 (UTC)");
    const end = typeof w["end"] === "string" && HHMM.test(w["end"]) ? w["end"] : invalid("terms.window.end", "must be a time such as 17:30 (UTC)");
    const days = w["days"] === undefined ? undefined : (Array.isArray(w["days"]) && w["days"].length <= 7 && w["days"].every((d) => Number.isInteger(d) && d >= 0 && d <= 6) ? [...new Set(w["days"] as number[])].sort() : invalid("terms.window.days", "must be days of the week, 0 (Sunday) to 6"));
    out.window = { start, end, ...(days === undefined ? {} : { days }) };
  }
  if (e["audiences"] !== undefined) out.audiences = list(e["audiences"], "terms.audiences", (x, f) => (typeof x === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,99}$/.test(x) ? x : invalid(f, "must be an account or audience name")), 50);
  if (e["branches"] !== undefined) out.branches = list(e["branches"], "terms.branches", (x, f) => (typeof x === "string" && /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/.test(x) && !x.includes("..") ? x : invalid(f, "must be one branch name, without wildcards")), 20);
  if (e["delegation"] !== undefined) out.delegation = typeof e["delegation"] === "boolean" ? e["delegation"] : invalid("terms.delegation", "must be true or false");
  if (e["conditions"] !== undefined) out.conditions = list(e["conditions"], "terms.conditions", (x, f) => plain(x, f, 300), 20);
  return Object.keys(out).length === 0 ? undefined : out;
}

/** A standing prohibition that beats any grant (card A02): for one principal or for everyone but the owner. */
export interface RestrictionBody {
  /** A principal ID, or `*` for every principal other than the owner. */
  readonly subject: string;
  readonly action: string;
  readonly project: string;
  readonly resource?: ResourceRef;
  readonly reason: string;
  readonly decidedBy: string;
  readonly expiresAt?: string;
  readonly state: "active" | "lifted";
  readonly liftedBy?: string;
  readonly liftedReason?: string;
}

export interface GrantInput extends NoActor {
  readonly grantee: string;
  readonly action: string;
  readonly project: string;
  readonly resource?: ResourceRef;
  readonly source: "direct" | "standing";
  readonly basis: string;
  readonly notBefore?: string;
  readonly expiresAt?: string;
  readonly terms?: GrantTerms;
}

export interface DeriveInput extends NoActor {
  readonly parentId: string;
  readonly action: string;
  readonly project: string;
  readonly resource?: ResourceRef;
  readonly basis: string;
  readonly expiresAt?: string;
}

export interface RestrictInput extends NoActor {
  readonly subject: string;
  readonly action: string;
  readonly project: string;
  readonly resource?: ResourceRef;
  readonly reason: string;
  readonly expiresAt?: string;
}

export const GRANT_LIMITS = { basis: 1000, reason: 1000, action: 60 } as const;
const ACTION = /^(?:\*|[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*(?:\.\*)?)$/;
const PROJECT = /^(?:\*|proj-[a-z2-7]{20})$/;
const PRINCIPAL = /^(?:owner|agent|host|client|service):[a-z0-9][a-z0-9-]{0,39}$/;
const GRANT_ID = /^grt-[a-z2-7]{20}$/;
const RESTRICTION_ID = /^rst-[a-z2-7]{20}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** The only actions a meeting decision may grant; everything else needs the owner. task.update and task.transition are left out: a project-wide grant of them would let the grantee move or edit any task past the review and owner gates a meeting's own change must pass. */
export const AGREED_GRANTABLE_ACTIONS: readonly string[] = [
  "task.read", "task.create", "assignment.read", "attempt.work", "artifact.publish", "artifact.read", "desk.write", "desk.read", "history.append", "history.read",
  "review.request", "wait.manage", "blocker.manage", "conversation.send", "conversation.receive", "message.send", "job.read", "meeting.agenda", "meeting.read", "resource.read", "budget.read", "responsibility.read", "notes.chair.read",
];
/** Granted by a decision only for exactly one task (a `resource` of kind task): the grant then covers that task and no other. A project-wide request for these stays refused. */
export const AGREED_GRANTABLE_ON_ONE_TASK: readonly string[] = ["task.update", "task.transition"];
const KIND = /^[a-z][a-z0-9-]{0,39}$/;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };

function checkAction(value: unknown, field = "action"): string {
  return typeof value === "string" && value.length <= GRANT_LIMITS.action && ACTION.test(value) ? value : invalid(field, "must be an action name such as task.create, a prefix such as task.*, or *");
}
function checkProject(value: unknown, field = "project"): string {
  return typeof value === "string" && PROJECT.test(value) ? value : invalid(field, "must be a project ID or *");
}
function checkResource(value: unknown, field = "resource"): ResourceRef | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid(field, "must be an object with kind and id");
  const entry = value as Record<string, unknown>;
  for (const key of Object.keys(entry)) if (key !== "kind" && key !== "id") invalid(`${field}.${key}`, "is not a resource field");
  const kind = typeof entry["kind"] === "string" && KIND.test(entry["kind"]) ? entry["kind"] : invalid(`${field}.kind`, "must be lower-case words joined by hyphens");
  const id = typeof entry["id"] === "string" && entry["id"].length >= 1 && entry["id"].length <= 200 ? entry["id"] : invalid(`${field}.id`, "must be 1 to 200 characters");
  return { kind, id };
}
/** A timestamp that names a real instant (`9999-99-99T00:00:00.000Z` and `2026-11-15T25:00:00.000Z` match the shape but are not). */
function realTime(value: string): boolean {
  return !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}
function checkTime(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" && TIMESTAMP.test(value) && realTime(value) ? value : invalid(field, "must be a UTC timestamp such as 2026-10-21T12:00:00.000Z");
}
function plain(value: unknown, field: string, max: number): string {
  const out = text(value, field, { min: 1, max, multiline: true });
  if (redactText(out) !== out) invalid(field, "looks like a credential or key; those are not recorded in a grant");
  return out;
}
const sameResource = (a: ResourceRef | undefined, b: ResourceRef | undefined): boolean => (a === undefined ? b === undefined : b !== undefined && a.kind === b.kind && a.id === b.id);

/** Whether a grant's scope is inside another's: its action, project and resource are covered, and its time window is no wider. */
export function within(inner: { action: string; project: string; resource?: ResourceRef; notBefore?: string; expiresAt?: string }, outer: { action: string; project: string; resource?: ResourceRef; notBefore?: string; expiresAt?: string }): boolean {
  if (!covers(outer.action, inner.action)) return false;
  if (outer.project !== "*" && inner.project !== outer.project) return false;
  if (outer.resource !== undefined && !sameResource(inner.resource, outer.resource)) return false;
  if (outer.expiresAt !== undefined && (inner.expiresAt === undefined || inner.expiresAt > outer.expiresAt)) return false;
  if (outer.notBefore !== undefined && (inner.notBefore === undefined || inner.notBefore < outer.notBefore)) return false;
  return true;
}

/**
 * Revisioned grants and restrictions (card A02). The owner records what a principal may do as grants (direct for something specific, standing for a lasting delegation) with the
 * wording they came from, an optional window and a revision; a step that is reasonably necessary under a grant is covered by a **derived** grant that rests on it and can never be wider
 * (action, project, resource or time), so it needs no new decision and falls with its parent. Revoking is immediate for the next snapshot. A **restriction** forbids an action for a
 * principal (or everyone but the owner) and always beats a grant. Nothing here changes what the installation owner may do.
 */
export class GrantService {
  readonly #runner: CommandRunner;

  readonly #limits: AgreedLimitsReader | undefined;

  private constructor(runner: CommandRunner, limits?: AgreedLimitsReader) {
    this.#runner = runner;
    this.#limits = limits;
  }

  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions & { agreedLimits?: AgreedLimitsReader } = {}): GrantService {
    return new GrantService(new CommandRunner(storage, epoch, options), options.agreedLimits);
  }

  /** The owner grants authority. */
  async grant(owner: Principal, command: GrantInput): Promise<{ id: string; revision: number; replayed: boolean }> {
    requireOwner(owner);
    return this.#grant(owner, command);
  }

  /**
   * Carries out a grant that was agreed elsewhere (a meeting decision, card M02e), as the controller's own service identity: the owner agreed to it, or the approval policy let rights through because the owner set that
   * cell by hand (a specific setting; owner decision 2026-10-30). It is one direct grant of the one action to the one agent in the one project the decision named, with an end time, and nothing wider: no standing grant,
   * no all-projects grant. The decision and who allowed it are kept in the grant's basis.
   */
  async grantAgreed(by: Principal, command: Omit<GrantInput, "source" | "notBefore" | "terms"> & { decisionId: string; agreedBy: string }): Promise<{ id: string; revision: number; replayed: boolean }> {
    if (by.kind !== "service" && by.kind !== "owner") throw new DomainError("forbidden", `${by.id} is not the controller; an agreed grant is carried out by the controller`);
    const given = command as unknown as Record<string, unknown>;
    for (const key of Object.keys(given)) if (!["commandId", "grantee", "action", "project", "resource", "basis", "expiresAt", "decisionId", "agreedBy"].includes(key)) invalid(key, "is not a field of an agreed grant");
    if (typeof command.decisionId !== "string" || command.decisionId.length < 1 || command.decisionId.length > 120) invalid("decisionId", "must name the decision");
    if (typeof command.agreedBy !== "string" || !/^(owner:[a-z0-9-]{1,60}|policy:[a-z0-9.-]{1,60})$/.test(command.agreedBy)) invalid("agreedBy", "must be the owner or the policy that let it through");
    if (command.project === "*") invalid("project", "an agreed grant is for one project, not all of them");
    const expires = checkTime(command.expiresAt, "expiresAt");
    if (expires === undefined) invalid("expiresAt", "an agreed grant ends: give the time it expires");
    // Only one exact, named action: never `*`, a prefix like `task.*`, or an approval grant (waiving a question stays the owner's, as in `derive`). A decision may not hand out the power to carry out more decisions.
    const action = command.action;
    if (typeof action !== "string") invalid("action", "must be an action name");
    const resource = checkResource(command.resource);
    if (resource !== undefined && resource.kind !== "task") invalid("resource", "an agreed grant may be narrowed to one task and nothing else");
    if (resource !== undefined && typeof command.commandId === "string") {
      // The named task must be a task of the grant's project: a grant for one project naming another project's task would be inert, but the service should not depend on the applier to say so.
      const task = await this.#runner.get("task", resource.id).catch(() => undefined);
      if (task === undefined || (task.body as { projectId?: unknown }).projectId !== command.project) invalid("resource", "must be a task of the grant's project");
    }
    if (AGREED_GRANTABLE_ON_ONE_TASK.includes(action)) {
      if (resource === undefined) invalid("action", `${action} can be granted by a decision only for one task: name the task as the resource`);
    } else if (resource !== undefined && !AGREED_GRANTABLE_ACTIONS.includes(action)) invalid("action", `${action} cannot be granted by a decision`);
    if (!AGREED_GRANTABLE_ACTIONS.includes(action) && !AGREED_GRANTABLE_ON_ONE_TASK.includes(action)) invalid("action", `${action} cannot be granted by a decision: it needs the owner (a decision may grant only ordinary working actions)`);
    // A replay of a grant that was already made returns that result first: the time and standing checks below depend on the clock and could fail it after a crash.
    let made = false;
    if (typeof command.commandId === "string") {
      try { made = (await this.#runner.get("grant-record", derivedId("grt", scopedCommandId(by.id, command.commandId)))) !== undefined; } catch { made = false; }
    }
    if (made) {
      const { decisionId, agreedBy, ...rest } = command;
      const basis = `meeting decision ${decisionId}, allowed by ${agreedBy}: ${String(rest.basis ?? "").slice(0, Math.max(0, GRANT_LIMITS.basis - decisionId.length - agreedBy.length - 40))}`;
      return this.#grant(by, { ...rest, basis, source: "direct" } as GrantInput);
    }
    const now = this.#runner.now();
    if (Number.isNaN(Date.parse(expires!)) || Number.isNaN(Date.parse(now))) invalid("expiresAt", "is not a real time");
    if (expires! <= now) invalid("expiresAt", "is already past");
    // No limit on how long an agreed grant lasts unless the owner set one (owner decision 2026-10-30). A setting that cannot be read refuses the grant.
    const maxDays = (this.#limits === undefined ? {} : await this.#limits()).grantMaxDays;
    if (maxDays !== undefined && Date.parse(expires!) > Date.parse(now) + maxDays * 24 * 3600 * 1000) invalid("expiresAt", `an agreed grant lasts at most ${maxDays} days, the limit the owner set`);
    const grantee = command.grantee;
    if (typeof grantee !== "string" || !grantee.startsWith("agent:")) invalid("grantee", "an agreed grant is for an agent (not a host, service, client or the owner)");
    const who = await this.#runner.get("principal", grantee);
    if (who === undefined || (who.body as { kind?: string; state?: string }).kind !== "agent" || (who.body as { state?: string }).state !== "active") invalid("grantee", "must be an existing, active agent");
    const { decisionId, agreedBy, ...rest } = command;
    const basis = `meeting decision ${decisionId}, allowed by ${agreedBy}: ${String(rest.basis ?? "").slice(0, Math.max(0, GRANT_LIMITS.basis - decisionId.length - agreedBy.length - 40))}`;
    return this.#grant(by, { ...rest, basis, source: "direct" } as GrantInput);
  }

  async #grant(owner: Principal, command: GrantInput): Promise<{ id: string; revision: number; replayed: boolean }> {
    return this.#runner.command("grant.create", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => {
      onlyKnown(command, ["commandId", "grantee", "action", "project", "resource", "source", "basis", "notBefore", "expiresAt", "terms"]);
      const terms = checkTerms(command.terms);
      const grantee = typeof command.grantee === "string" && PRINCIPAL.test(command.grantee) && !command.grantee.startsWith("owner:") ? command.grantee : invalid("grantee", "must be an agent or host ID (the owner needs no grant)");
      const action = checkAction(command.action);
      const project = checkProject(command.project);
      const resource = checkResource(command.resource);
      const source = command.source === "direct" || command.source === "standing" ? command.source : invalid("source", "must be direct or standing (derived grants come from derive)");
      const basis = plain(command.basis, "basis", GRANT_LIMITS.basis);
      const notBefore = checkTime(command.notBefore, "notBefore");
      const expiresAt = checkTime(command.expiresAt, "expiresAt");
      if (notBefore !== undefined && expiresAt !== undefined && expiresAt <= notBefore) invalid("expiresAt", "must be after notBefore");
      return {
        payload: { grantee, action, project, ...(resource === undefined ? {} : { resource: resource as unknown as JsonObject }), source, basis, ...(notBefore === undefined ? {} : { notBefore }), ...(expiresAt === undefined ? {} : { expiresAt }), ...(terms === undefined ? {} : { terms: terms as unknown as JsonObject }) },
        build: async () => {
          if ((await this.#runner.get("principal", grantee)) === undefined) throw new DomainError("not_found", `principal ${grantee} does not exist`);
          if (!mayHold(grantee.slice(0, grantee.indexOf(":")), action)) throw new DomainError("invalid_command", `action: ${grantee.startsWith("service:") ? "a service may hold only recovery actions" : "a client may hold only conversation actions"}, not ${action}`, { field: "action" });
          const ref: AggregateRef = { kind: "grant-record", id: derivedId("grt", scopedCommandId(owner.id, command.commandId)) };
          const body: GrantRecordBody = { grantee, action, project, ...(resource === undefined ? {} : { resource }), source, decidedBy: owner.id, basis, ...(notBefore === undefined ? {} : { notBefore }), ...(expiresAt === undefined ? {} : { expiresAt }), ...(terms === undefined ? {} : { terms }), state: "active" };
          return { ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }], detail: { grantee, action, project, source } };
        },
      };
    }).then((r) => ({ id: r.id, revision: r.revision, replayed: r.replayed }));
  }

  /**
   * Covers a reasonably necessary step under a grant the principal holds, without a new decision. The new grant is for the same grantee, rests on `parentId` and must be inside it
   * (narrower or equal in action, project, resource and time); it is refused otherwise. It is valid only while its parent is. Made by the grantee or the owner.
   */
  async derive(principal: Principal, command: DeriveInput): Promise<{ id: string; revision: number; replayed: boolean }> {
    return this.#runner.command("grant.derive", { commandId: scopedCommandId(principal.id, command.commandId), actor: principal.id }, async () => {
      onlyKnown(command, ["commandId", "parentId", "action", "project", "resource", "basis", "expiresAt"]);
      const parentId = typeof command.parentId === "string" && GRANT_ID.test(command.parentId) ? command.parentId : invalid("parentId", "is not a grant ID");
      const action = checkAction(command.action);
      const project = checkProject(command.project);
      const resource = checkResource(command.resource);
      const basis = plain(command.basis, "basis", GRANT_LIMITS.basis);
      const expiresAt = checkTime(command.expiresAt, "expiresAt");
      return {
        payload: { parentId, action, project, ...(resource === undefined ? {} : { resource: resource as unknown as JsonObject }), basis, ...(expiresAt === undefined ? {} : { expiresAt }) },
        build: async () => {
          const found = await this.#runner.get("grant-record", parentId);
          const parent = found?.body as unknown as GrantRecordBody | undefined;
          // Not yours, not there and not active all read the same.
          if (found === undefined || parent === undefined || parent.state !== "active" || (principal.kind !== "owner" && parent.grantee !== principal.id)) throw new DomainError("forbidden", `${principal.id} holds no such grant`);
          let depth = 1;
          for (let p: GrantRecordBody | undefined = parent; p?.source === "derived" && depth <= MAX_DEPTH; depth++) p = p.parentId === undefined ? undefined : ((await this.#runner.get("grant-record", p.parentId))?.body as unknown as GrantRecordBody | undefined);
          if (depth > MAX_DEPTH) throw new DomainError("forbidden", `derivation is limited to ${MAX_DEPTH} levels`);
          if (principal.taskScope !== undefined && project !== principal.taskScope.projectId) throw new DomainError("forbidden", "a task credential derives grants for its own task's project only");
          // Waiving a question is the owner's decision: an agent does not derive an approval grant, and a derived grant keeps every term of its parent.
          if (action.startsWith("approve.") && principal.kind !== "owner") throw new DomainError("forbidden", "an approval grant is derived only by the owner");
          const until = expiresAt ?? parent.expiresAt;
          const candidate = { action, project, ...(resource === undefined ? {} : { resource }), ...(parent.notBefore === undefined ? {} : { notBefore: parent.notBefore }), ...(until === undefined ? {} : { expiresAt: until }) };
          if (!within(candidate, parent)) throw new DomainError("forbidden", "a derived grant cannot be wider than the grant it rests on (action, project, resource or time)");
          const ref: AggregateRef = { kind: "grant-record", id: derivedId("grt", scopedCommandId(principal.id, command.commandId)) };
          const body: GrantRecordBody = {
            grantee: parent.grantee, action, project, ...(resource === undefined ? {} : { resource }), source: "derived", decidedBy: principal.id, basis, parentId,
            ...(parent.terms === undefined ? {} : { terms: parent.terms }), rootSource: parent.source === "derived" ? (parent.rootSource ?? "direct") : parent.source,
            ...(parent.notBefore === undefined ? {} : { notBefore: parent.notBefore }), ...(until === undefined ? {} : { expiresAt: until }), state: "active",
          };
          return {
            ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }, { type: "check", ref: { kind: "grant-record", id: parentId }, expectedRevision: found.revision }],
            detail: { grantee: parent.grantee, action, project, parentId },
            contention: async () => new DomainError("stale_revision", `grant ${parentId} changed meanwhile; derive again`),
          };
        },
      };
    }).then((r) => ({ id: r.id, revision: r.revision, replayed: r.replayed }));
  }

  /** The owner revokes a grant. Anything derived from it stops counting with it. Takes effect for the next snapshot of the grantee. */
  async revoke(owner: Principal, command: NoActor & { grantId: string; expectedRevision: number; reason: string }): Promise<void> {
    requireOwner(owner);
    await this.#runner.command("grant.revoke", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => {
      onlyKnown(command, ["commandId", "grantId", "expectedRevision", "reason"]);
      const id = typeof command.grantId === "string" && GRANT_ID.test(command.grantId) ? command.grantId : invalid("grantId", "is not a grant ID");
      const expected = checkRevision(command.expectedRevision);
      const reason = plain(command.reason, "reason", GRANT_LIMITS.reason);
      return {
        payload: { grantId: id, expectedRevision: expected, reason },
        build: async () => {
          const current = await this.#runner.existing("grant-record", id, expected);
          const body = current.body as unknown as GrantRecordBody;
          if (body.state === "revoked") throw new DomainError("invalid_command", `grant ${id} is already revoked`, { field: "grantId" });
          const ref: AggregateRef = { kind: "grant-record", id };
          const next: GrantRecordBody = { ...body, state: "revoked", revokedBy: owner.id, revokedReason: reason, revokedAt: this.#runner.now() };
          return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: next as unknown as JsonObject }], detail: { grantee: body.grantee, action: body.action } };
        },
      };
    });
  }

  /** The owner forbids an action for a principal (or `*`: everyone but the owner). A restriction beats any grant while it is active. */
  async restrict(owner: Principal, command: RestrictInput): Promise<{ id: string; revision: number; replayed: boolean }> {
    requireOwner(owner);
    return this.#runner.command("restriction.create", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => {
      onlyKnown(command, ["commandId", "subject", "action", "project", "resource", "reason", "expiresAt"]);
      const subject = command.subject === "*" ? "*" : typeof command.subject === "string" && PRINCIPAL.test(command.subject) && !command.subject.startsWith("owner:") ? command.subject : invalid("subject", "must be an agent or host ID, or * for everyone but the owner");
      const action = checkAction(command.action);
      const project = checkProject(command.project);
      const resource = checkResource(command.resource);
      const reason = plain(command.reason, "reason", GRANT_LIMITS.reason);
      const expiresAt = checkTime(command.expiresAt, "expiresAt");
      return {
        payload: { subject, action, project, ...(resource === undefined ? {} : { resource: resource as unknown as JsonObject }), reason, ...(expiresAt === undefined ? {} : { expiresAt }) },
        build: async () => {
          const ref: AggregateRef = { kind: "restriction-record", id: derivedId("rst", scopedCommandId(owner.id, command.commandId)) };
          const body: RestrictionBody = { subject, action, project, ...(resource === undefined ? {} : { resource }), reason, decidedBy: owner.id, ...(expiresAt === undefined ? {} : { expiresAt }), state: "active" };
          return { ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }], detail: { subject, action, project } };
        },
      };
    }).then((r) => ({ id: r.id, revision: r.revision, replayed: r.replayed }));
  }

  async lift(owner: Principal, command: NoActor & { restrictionId: string; expectedRevision: number; reason: string }): Promise<void> {
    requireOwner(owner);
    await this.#runner.command("restriction.lift", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => {
      onlyKnown(command, ["commandId", "restrictionId", "expectedRevision", "reason"]);
      const id = typeof command.restrictionId === "string" && RESTRICTION_ID.test(command.restrictionId) ? command.restrictionId : invalid("restrictionId", "is not a restriction ID");
      const expected = checkRevision(command.expectedRevision);
      const reason = plain(command.reason, "reason", GRANT_LIMITS.reason);
      return {
        payload: { restrictionId: id, expectedRevision: expected, reason },
        build: async () => {
          const current = await this.#runner.existing("restriction-record", id, expected);
          const body = current.body as unknown as RestrictionBody;
          if (body.state === "lifted") throw new DomainError("invalid_command", `restriction ${id} is already lifted`, { field: "restrictionId" });
          const ref: AggregateRef = { kind: "restriction-record", id };
          const next: RestrictionBody = { ...body, state: "lifted", liftedBy: owner.id, liftedReason: reason };
          return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: next as unknown as JsonObject }], detail: { subject: body.subject } };
        },
      };
    });
  }

  /** The grant records, a page at a time, for the owner (optionally only those of one grantee). */
  async list(owner: Principal, query: { grantee?: string; afterId?: string; limit?: number } = {}): Promise<{ items: View<GrantRecordBody>[]; next?: string; scanLimited?: boolean }> {
    requireOwner(owner);
    const limit = query.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) invalid("limit", "must be a whole number from 1 to 200");
    const items: View<GrantRecordBody>[] = [];
    let last: string | undefined = query.afterId; let more = false;
    scan: for (let rounds = 0; rounds < 20; rounds++) {
      const records = await this.#runner.list("grant-record", { ...(last === undefined ? {} : { afterId: last }), limit: 200 });
      for (const r of records) {
        const v = view<GrantRecordBody>(r);
        if (query.grantee !== undefined && v.grantee !== query.grantee) { last = r.id; continue; }
        if (items.length === limit) { more = true; break scan; }
        items.push(v); last = r.id;
      }
      if (records.length < 200) return { items };
      if (rounds === 19) more = true;
    }
    // Something may remain after the last record looked at: the next page starts there, so no grant is skipped however far a filter has to look.
    return { items, ...(more && last !== undefined ? { next: last } : {}), ...(more && items.length < limit ? { scanLimited: true } : {}) };
  }

  async getGrant(id: string): Promise<View<GrantRecordBody> | undefined> {
    const found = await this.#runner.get("grant-record", typeof id === "string" && GRANT_ID.test(id) ? id : invalid("grantId", "is not a grant ID"));
    return found === undefined ? undefined : view<GrantRecordBody>(found);
  }

  async getRestriction(id: string): Promise<View<RestrictionBody> | undefined> {
    const found = await this.#runner.get("restriction-record", typeof id === "string" && RESTRICTION_ID.test(id) ? id : invalid("restrictionId", "is not a restriction ID"));
    return found === undefined ? undefined : view<RestrictionBody>(found);
  }

  /**
   * The principal as of `now`: its own grants (from enrollment) plus every active grant record that holds at `now` (inside its window, and for a derived grant, resting on an active parent that
   * still covers it), and the restrictions that apply to it. `PrincipalService.authenticate` already returns this; call it again to pick up a revocation, restriction or expiry that happened since.
   */
  effective(principal: Principal, now: string): Promise<Principal> {
    return effectiveOf(this.#runner, principal, now);
  }

  /** The grant records a principal holds at `now`, with their terms (for the approval policy). */
  held(principalId: string, now: string): Promise<{ id: string; body: GrantRecordBody }[]> {
    return heldRecords(this.#runner, principalId, now);
  }

  /** Why an action is or is not allowed for a principal at `now`: the answer is `allows` itself; the grant or restriction named is the one that decides it. */
  async explain(principal: Principal, action: string, project: string | undefined, now: string, resource?: ResourceRef): Promise<{ allowed: boolean; because: string }> {
    const p = await this.effective(principal, now);
    if (p.kind === "owner") return { allowed: true, because: "the installation owner" };
    const check = { now, ...(resource === undefined ? {} : { resource }) };
    const allowed = allows(p, action, project, check);
    const blocked = (p.restrictions ?? []).find((r) => allows({ ...p, grants: [{ action: "*", project: "*" }], restrictions: [r] }, action, project, check) === false);
    if (blocked !== undefined) return { allowed: false, because: `restriction ${blocked.restrictionId ?? ""}: ${blocked.reason ?? ""}` };
    if (!allowed) return { allowed: false, because: "no grant covers it" };
    const used = p.grants.find((g) => allows({ ...p, grants: [g] }, action, project, check));
    return { allowed: true, because: used?.grantId === undefined ? "a grant given at enrollment" : `grant ${used.grantId}` };
  }
}

/** The depth of a derived grant's chain of parents (0 for a grant that is not derived); a missing parent counts as the limit. */
export const MAX_DEPTH = 8;

/** The grant records a principal holds at `now` (active, in time, and for a derived grant resting on a parent that holds and contains it). */
export async function heldRecords(runner: CommandRunner, principalId: string, now: string): Promise<{ id: string; body: GrantRecordBody }[]> {
  const byId = new Map<string, GrantRecordBody>();
  const mine: { id: string; body: GrantRecordBody }[] = [];
  for (let after: string | undefined; ;) {
    const page = await runner.list("grant-record", { ...(after === undefined ? {} : { afterId: after }), limit: 500 });
    for (const a of page) { const b = a.body as unknown as GrantRecordBody; byId.set(a.id, b); if (b.grantee === principalId) mine.push({ id: a.id, body: b }); after = a.id; }
    if (page.length < 500) break;
  }
  const holds = (body: GrantRecordBody, depth: number): boolean => {
    if (body.state !== "active" || (body.notBefore !== undefined && body.notBefore > now) || (body.expiresAt !== undefined && body.expiresAt <= now)) return false;
    if (body.source !== "derived") return true;
    const parent = body.parentId === undefined ? undefined : byId.get(body.parentId);
    return parent !== undefined && depth < MAX_DEPTH && holds(parent, depth + 1) && within(body, parent);
  };
  return mine.filter(({ body }) => holds(body, 0));
}

/** Takes the snapshot described at `GrantService.effective`. Shared with authentication so that no authenticated principal is ever without its restrictions. */
export async function effectiveOf(runner: CommandRunner, principal: Principal, now: string): Promise<Principal> {
  if (principal.kind === "owner") return { ...principal, asOf: now };
  const grants = [...principal.grants];
  // An agent may always run the tools it made itself: the grant for its own tool namespace is part of what an agent is (card T06b), in every project; the tool gate still judges each call in the project of its task. It is derived here, not stored, so an owner who replaces the agent's grants cannot take it away by mistake and agents enrolled earlier have it too.
  if (principal.kind === "agent") {
    const own = `tool.${personalNamespace(principal.id).replace(/^a_/, "a-")}.*`;
    if (!grants.some((g) => g.action === own && g.project === "*")) grants.push({ action: own, project: "*" });
  }
  const restrictions: Restriction[] = [];
  const byId = new Map<string, GrantRecordBody>();
  const mine: { id: string; body: GrantRecordBody }[] = [];
  for (let after: string | undefined; ;) {
    const page = await runner.list("grant-record", { ...(after === undefined ? {} : { afterId: after }), limit: 500 });
    for (const a of page) { const b = a.body as unknown as GrantRecordBody; byId.set(a.id, b); if (b.grantee === principal.id) mine.push({ id: a.id, body: b }); after = a.id; }
    if (page.length < 500) break;
  }
  const holds = (body: GrantRecordBody, depth: number): boolean => {
    if (body.state !== "active" || (body.notBefore !== undefined && body.notBefore > now) || (body.expiresAt !== undefined && body.expiresAt <= now)) return false;
    if (body.source !== "derived") return true;
    const parent = body.parentId === undefined ? undefined : byId.get(body.parentId);
    return parent !== undefined && depth < MAX_DEPTH && holds(parent, depth + 1) && within(body, parent);
  };
  for (const { id, body } of mine) if (holds(body, 0)) grants.push({ action: body.action, project: body.project, ...(body.resource === undefined ? {} : { resource: body.resource }), grantId: id, ...(body.expiresAt === undefined ? {} : { expiresAt: body.expiresAt }) });
  for (let after: string | undefined; ;) {
    const page = await runner.list("restriction-record", { ...(after === undefined ? {} : { afterId: after }), limit: 500 });
    for (const a of page) {
      after = a.id;
      const b = a.body as unknown as RestrictionBody;
      if (b.state !== "active" || (b.expiresAt !== undefined && b.expiresAt <= now) || (b.subject !== "*" && b.subject !== principal.id)) continue;
      restrictions.push({ action: b.action, project: b.project, ...(b.resource === undefined ? {} : { resource: b.resource }), restrictionId: a.id, reason: b.reason });
    }
    if (page.length < 500) break;
  }
  const scope = principal.taskScope;
  // A task credential keeps only the grants of its task's project, for that task or the whole project, and narrows a grant for every project to this one.
  const kept = scope === undefined ? grants : grants
    .filter((g) => (g.project === "*" || g.project === scope.projectId) && (g.resource === undefined || (g.resource.kind === "task" && g.resource.id === scope.taskId)))
    .map((g) => ({ ...g, project: scope.projectId }));
  return { ...principal, grants: kept, restrictions, asOf: now };
}

function requireOwner(principal: Principal): void {
  if (principal.kind !== "owner") throw new DomainError("forbidden", `${principal.id} is not the owner; only the owner decides what others may do`);
}
