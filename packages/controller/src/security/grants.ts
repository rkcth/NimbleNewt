import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, revision as checkRevision, text, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";
import { allows, covers } from "./access.js";
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
  readonly state: "active" | "revoked";
  readonly revokedBy?: string;
  readonly revokedReason?: string;
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
const PRINCIPAL = /^(?:owner|agent|host):[a-z0-9][a-z0-9-]{0,39}$/;
const GRANT_ID = /^grt-[a-z2-7]{20}$/;
const RESTRICTION_ID = /^rst-[a-z2-7]{20}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
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
function checkTime(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" && TIMESTAMP.test(value) ? value : invalid(field, "must be a UTC timestamp such as 2026-10-21T12:00:00.000Z");
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

  private constructor(runner: CommandRunner) {
    this.#runner = runner;
  }

  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): GrantService {
    return new GrantService(new CommandRunner(storage, epoch, options));
  }

  /** The owner grants authority. */
  async grant(owner: Principal, command: GrantInput): Promise<{ id: string; revision: number; replayed: boolean }> {
    requireOwner(owner);
    return this.#runner.command("grant.create", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => {
      onlyKnown(command, ["commandId", "grantee", "action", "project", "resource", "source", "basis", "notBefore", "expiresAt"]);
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
        payload: { grantee, action, project, ...(resource === undefined ? {} : { resource: resource as unknown as JsonObject }), source, basis, ...(notBefore === undefined ? {} : { notBefore }), ...(expiresAt === undefined ? {} : { expiresAt }) },
        build: async () => {
          if ((await this.#runner.get("principal", grantee)) === undefined) throw new DomainError("not_found", `principal ${grantee} does not exist`);
          const ref: AggregateRef = { kind: "grant-record", id: derivedId("grt", scopedCommandId(owner.id, command.commandId)) };
          const body: GrantRecordBody = { grantee, action, project, ...(resource === undefined ? {} : { resource }), source, decidedBy: owner.id, basis, ...(notBefore === undefined ? {} : { notBefore }), ...(expiresAt === undefined ? {} : { expiresAt }), state: "active" };
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
          const until = expiresAt ?? parent.expiresAt;
          const candidate = { action, project, ...(resource === undefined ? {} : { resource }), ...(parent.notBefore === undefined ? {} : { notBefore: parent.notBefore }), ...(until === undefined ? {} : { expiresAt: until }) };
          if (!within(candidate, parent)) throw new DomainError("forbidden", "a derived grant cannot be wider than the grant it rests on (action, project, resource or time)");
          const ref: AggregateRef = { kind: "grant-record", id: derivedId("grt", scopedCommandId(principal.id, command.commandId)) };
          const body: GrantRecordBody = {
            grantee: parent.grantee, action, project, ...(resource === undefined ? {} : { resource }), source: "derived", decidedBy: principal.id, basis, parentId,
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
          const next: GrantRecordBody = { ...body, state: "revoked", revokedBy: owner.id, revokedReason: reason };
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

/** Takes the snapshot described at `GrantService.effective`. Shared with authentication so that no authenticated principal is ever without its restrictions. */
export async function effectiveOf(runner: CommandRunner, principal: Principal, now: string): Promise<Principal> {
  if (principal.kind === "owner") return { ...principal, asOf: now };
  const grants = [...principal.grants];
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
  return { ...principal, grants, restrictions, asOf: now };
}

function requireOwner(principal: Principal): void {
  if (principal.kind !== "owner") throw new DomainError("forbidden", `${principal.id} is not the owner; only the owner decides what others may do`);
}
