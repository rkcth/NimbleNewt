import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { onlyKnown, text, type View } from "../domain/model.js";
import { CommandRunner, view, type Built, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";
import { PROJECT_WORK_LIMITS as L, hidden, invalid, may, noCredential, scanAll } from "./common.js";
import type { IncidentService } from "./incidents.js";
import { CLAIM, type ClaimBody } from "./resources.js";
import type { ResponsibilityBody, ResponsibilityService } from "./responsibilities.js";

/** A rival's attempt that found the resource leased: kept on the lease so the owner and the holder can see who waited and why (newest last, the last 10; `blockedCount` counts all). */
export interface LeaseBlock { readonly by: string; readonly at: string; readonly purpose: string; readonly holder: string; readonly key: string }

/** How a maintenance ended: the validation result, and for a failed one the recorded response. */
export interface LeaseRelease {
  readonly by: string;
  readonly at: string;
  readonly forced: boolean;
  /** The holding this release ended. */
  readonly generation: number;
  readonly validation?: "passed" | "failed";
  /** For a failed validation: `rollback` (the responsibility permits the action `rollback`) or `escalate` (an incident was opened and escalated now). */
  readonly response?: "rollback" | "escalate";
  readonly evidence: string;
  /** The release command (a hash), so a repeat of it finds its own holding's outcome even after the lease moved on. */
  readonly key?: string;
}

/**
 * The maintenance lease on one managed resource (kind `maintenance-lease`, one record per resource, card P04). Only one agent at a time may change a resource a responsibility manages; a second agent's
 * attempt is not an error that vanishes: it is recorded on the lease as a block, visible to everyone who can read the project.
 */
export interface LeaseBody {
  readonly resourceId: string;
  readonly projectId: string;
  readonly responsibilityId: string;
  readonly state: "held" | "free";
  /** Counts each new holding (a renewal by the holder keeps it), so a release and the effects that follow it belong to one holding. */
  readonly generation: number;
  readonly holderId?: string;
  readonly purpose?: string;
  readonly acquiredAt?: string;
  readonly expiresAt?: string;
  readonly renewals: number;
  /** Set when this holding began by taking over a lease whose time had run out without a release. */
  readonly tookOverFrom?: { readonly holder: string; readonly expiredAt: string };
  readonly blockedCount: number;
  readonly blocked: readonly LeaseBlock[];
  /** The command that last granted or renewed the lease (a hash), so a caller can tell a grant from a block after the fact. */
  readonly grantKey?: string;
  readonly lastRelease?: LeaseRelease;
}

export interface LeaseView extends LeaseBody {
  readonly id: string;
  readonly revision: number;
  /** `held`, `expired` (held past its time, nobody released it: the next agent may take over) or `free`. */
  readonly status: "held" | "expired" | "free";
}

export const LEASE_DEFAULT_MINUTES = 60;
export const LEASE_MAX_MINUTES = 1440;
const LEASE = "maintenance-lease";
const hash = (...parts: string[]): string => createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24);
const leaseIdOf = (resourceId: string): string => `mlease-${hash(resourceId)}`;
const BLOCKS_KEPT = 10;
/** Agents racing for the same lease meet a changed record; the loser runs again against the new state (granted, renewed or blocked visibly) instead of seeing an error. */
const CONTENDED_ATTEMPTS = 8;
const LEASE_CHANGED = "the lease changed meanwhile; try again";
const contended = (error: unknown): boolean => error instanceof DomainError && error.code === "stale_revision" && error.message === LEASE_CHANGED;
async function retryContended<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await run(); } catch (error) { if (!contended(error) || attempt >= CONTENDED_ATTEMPTS) throw error; }
  }
}

export interface AcquireResult { readonly status: "granted" | "blocked"; readonly lease: LeaseView }
export interface ReleaseResult { readonly lease: LeaseView; readonly response?: "rollback" | "escalate"; readonly incidentId?: string }

/**
 * Per-resource maintenance leases (card P04): "a second agent's update to the same resource blocks visibly on the lease", and "failed validation triggers authorized rollback or escalation, both recorded".
 *
 * - **One holder per resource.** `acquire` grants the lease when it is free or has run out, renews it for the holder who asks again, and otherwise records a block and tells the caller who holds it and until when.
 * - **Time-bound.** A lease ends at `expiresAt` (default 60 minutes, at most 24 hours); a holder that vanished does not keep the resource: the next `acquire` takes it over and records from whom.
 * - **Only a managed resource.** The resource must be held by an active responsibility's claim. A paused responsibility starts no new maintenance, and its existing lease and incidents stay as they are.
 * - **Release with a validation.** The holder releases with the result of validating the change. A failed one needs a response: `rollback` is allowed only when the responsibility's `permittedActions` names `rollback`
 *   (otherwise it is refused: escalate); `escalate` opens an incident on the responsibility and escalates it at once to its escalation target (or the owner). Either way an `intervention` is written into the responsibility's history.
 *   The owner may force-release a lease (for example a holder that is gone) with a reason; that too is recorded.
 * - **Authority.** The owner, the answerable agent of the responsibility, or a holder of `responsibility.write` in the project. A rival with that right is blocked visibly; anyone else is refused.
 */
export class MaintenanceLeaseService {
  readonly #runner: CommandRunner;
  readonly #duties: Pick<ResponsibilityService, "get" | "list" | "record">;
  readonly #incidents: Pick<IncidentService, "report" | "escalateNow">;

  private constructor(runner: CommandRunner, duties: Pick<ResponsibilityService, "get" | "list" | "record">, incidents: Pick<IncidentService, "report" | "escalateNow">) { this.#runner = runner; this.#duties = duties; this.#incidents = incidents; }

  static withEpoch(storage: ControllerStorage, epoch: number, duties: Pick<ResponsibilityService, "get" | "list" | "record">, incidents: Pick<IncidentService, "report" | "escalateNow">, options: RunnerOptions = {}): MaintenanceLeaseService {
    return new MaintenanceLeaseService(new CommandRunner(storage, epoch, options), duties, incidents);
  }

  /** Takes, renews or is blocked from the lease on a managed resource. A block is a normal answer (`status: "blocked"`), recorded on the lease. */
  async acquire(by: Principal, command: NoActor & { resourceId: string; purpose: string; minutes?: number }): Promise<AcquireResult> {
    const key = hash(scopedCommandId(by.id, command.commandId));
    await retryContended(() => this.#runner.command("responsibility.lease.acquire", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => {
      onlyKnown(command, ["commandId", "resourceId", "purpose", "minutes"]);
      const resourceId = text(command.resourceId, "resourceId", { min: 1, max: 100 });
      const purpose = noCredential(text(command.purpose, "purpose", { min: 1, max: L.summary, multiline: true }), "purpose");
      const minutes = command.minutes === undefined ? LEASE_DEFAULT_MINUTES : Number.isInteger(command.minutes) && command.minutes >= 1 && command.minutes <= LEASE_MAX_MINUTES ? command.minutes : invalid("minutes", `must be a whole number from 1 to ${LEASE_MAX_MINUTES}`);
      return {
        payload: { resourceId, purpose, minutes },
        build: async (): Promise<Built> => {
          const { claim, duty } = await this.#managed(by, resourceId, "lease that resource");
          if (duty.state !== "active") invalid("resourceId", `responsibility ${claim.responsibilityId} is ${duty.state}: it starts no new maintenance`);
          const now = this.#runner.now();
          const ref: AggregateRef = { kind: LEASE, id: leaseIdOf(resourceId) };
          const found = await this.#runner.get(LEASE, ref.id);
          const before = found?.body as unknown as LeaseBody | undefined;
          const live = before !== undefined && before.state === "held" && before.expiresAt !== undefined && Date.parse(before.expiresAt) > Date.parse(now);
          const expires = new Date(Date.parse(now) + minutes * 60_000).toISOString();
          let next: LeaseBody;
          if (before !== undefined && live && before.holderId !== by.id) {
            const block: LeaseBlock = { by: by.id, at: now, purpose, holder: before.holderId!, key };
            next = { ...before, blockedCount: before.blockedCount + 1, blocked: [...before.blocked, block].slice(-BLOCKS_KEPT) };
          } else if (before !== undefined && live) {
            next = { ...before, purpose, expiresAt: expires, renewals: before.renewals + 1, grantKey: key };
          } else {
            const lapsed = before !== undefined && before.state === "held" && before.holderId !== undefined && before.holderId !== by.id ? { holder: before.holderId, expiredAt: before.expiresAt ?? now } : undefined;
            next = {
              resourceId, projectId: claim.projectId, responsibilityId: claim.responsibilityId, state: "held", generation: (before?.generation ?? 0) + 1, holderId: by.id, purpose, acquiredAt: now, expiresAt: expires, renewals: 0,
              ...(lapsed === undefined ? {} : { tookOverFrom: lapsed }), blockedCount: before?.blockedCount ?? 0, blocked: before?.blocked ?? [], grantKey: key,
              ...(before?.lastRelease === undefined ? {} : { lastRelease: before.lastRelease }),
            };
          }
          const changes: Change[] = [found === undefined ? { type: "create", ref, body: next as unknown as JsonObject } : { type: "update", ref, expectedRevision: found.revision, body: next as unknown as JsonObject }];
          return { ref, creates: found === undefined, changes, detail: { resourceId, responsibilityId: claim.responsibilityId, blocked: next.grantKey !== key }, contention: async () => new DomainError("stale_revision", LEASE_CHANGED) };
        },
      };
    }));
    const lease = (await this.#read(command.resourceId))!;
    return { status: lease.grantKey === key ? "granted" : "blocked", lease };
  }

  /**
   * Gives the lease back. The holder says how validating the change went; the owner may force-release without a validation, with a reason. A failed validation needs `onFailure` (`rollback` or `escalate`), carried out
   * and recorded as described on the class. Repeating the same command repeats nothing.
   */
  async release(by: Principal, command: NoActor & { resourceId: string; validation?: "passed" | "failed"; evidence: string; onFailure?: "rollback" | "escalate" }): Promise<ReleaseResult> {
    onlyKnown(command, ["commandId", "resourceId", "validation", "evidence", "onFailure"]);
    const resourceId = text(command.resourceId, "resourceId", { min: 1, max: 100 });
    const evidence = noCredential(text(command.evidence, "evidence", { min: 1, max: L.summary, multiline: true }), "evidence");
    if (command.validation !== undefined && command.validation !== "passed" && command.validation !== "failed") invalid("validation", "must be passed or failed");
    if (command.onFailure !== undefined && command.onFailure !== "rollback" && command.onFailure !== "escalate") invalid("onFailure", "must be rollback or escalate");
    if (command.validation === "failed" && command.onFailure === undefined) invalid("onFailure", "a failed validation needs a response: rollback (if the responsibility permits it) or escalate");
    if (command.validation !== "failed" && command.onFailure !== undefined) invalid("onFailure", "a response is only for a failed validation");
    const forced = command.validation === undefined;
    const key = hash(scopedCommandId(by.id, command.commandId));
    await retryContended(() => this.#runner.command("responsibility.lease.release", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { resourceId, evidence, ...(command.validation === undefined ? {} : { validation: command.validation }), ...(command.onFailure === undefined ? {} : { onFailure: command.onFailure }) },
      build: async (): Promise<Built> => {
        const managed = await this.#managed(by, resourceId, "release that lease");
        const ref: AggregateRef = { kind: LEASE, id: leaseIdOf(resourceId) };
        const found = await this.#runner.get(LEASE, ref.id);
        const before = found?.body as unknown as LeaseBody | undefined;
        if (found === undefined || before === undefined || before.state !== "held") invalid("resourceId", "nobody holds a lease on that resource");
        const holder = before!.holderId;
        if (holder !== by.id && by.kind !== "owner") throw hidden(by, "release a lease another agent holds");
        if (holder !== by.id && !forced) invalid("validation", "only the holder can report how the maintenance validated; the owner releases another agent's lease with a reason only");
        if (command.onFailure === "rollback" && !managed.duty.permittedActions.includes("rollback")) invalid("onFailure", `responsibility ${managed.duty.id} does not permit the action rollback; escalate instead`);
        const last: LeaseRelease = { by: by.id, at: this.#runner.now(), forced, generation: before!.generation, evidence, ...(command.validation === undefined ? {} : { validation: command.validation }), ...(command.onFailure === undefined ? {} : { response: command.onFailure }), key };
        const { holderId: _h, purpose: _p, acquiredAt: _a, expiresAt: _e, tookOverFrom: _t, grantKey: _g, ...kept } = before!;
        void [_h, _p, _a, _e, _t, _g];
        const next: LeaseBody = { ...kept, state: "free", lastRelease: last };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found!.revision, body: next as unknown as JsonObject }], detail: { resourceId, validation: command.validation ?? "forced", ...(command.onFailure === undefined ? {} : { response: command.onFailure }) }, contention: async () => new DomainError("stale_revision", LEASE_CHANGED) };
      },
    })));
    // The records that follow are keyed by the release command itself, so a repeat (or a crash between them) completes the rest and writes nothing twice. They follow this command's own validation and response
    // (a repeat carries the same ones, or it is refused as a different command), never the lease's latest release: by the time of a repeat another agent may have taken and released the lease.
    const lease = (await this.#read(resourceId))!;
    const stamp = hash(lease.id, key);
    let incidentId: string | undefined;
    const response = command.onFailure;
    if (response === "escalate") {
      const reported = await this.#incidents.report(by, { commandId: `mlv-${stamp}`, responsibilityId: lease.responsibilityId, signature: `maintenance-validation:${resourceId}`, summary: `Validation failed after maintenance of ${resourceId}: ${evidence}`.slice(0, L.summary), outcome: "failed" });
      incidentId = reported.id;
      await this.#incidents.escalateNow(by, incidentId);
    }
    const what = forced ? `Lease on ${resourceId} released by force (${evidence})` : command.validation === "passed" ? `Maintenance of ${resourceId} validated: ${evidence}` : response === "rollback" ? `Validation failed on ${resourceId}; rolled back under the permitted action: ${evidence}` : `Validation failed on ${resourceId}; escalated (incident ${incidentId}): ${evidence}`;
    await this.#duties.record(by, { commandId: `mlo-${stamp}`, responsibilityId: lease.responsibilityId, kind: "intervention", summary: what.slice(0, L.summary), ...(forced ? {} : { outcome: command.validation === "passed" ? "ok" : "failed" } as const) });
    return { lease, ...(response === undefined ? {} : { response }), ...(incidentId === undefined ? {} : { incidentId }) };
  }

  /** The leases of a project, with their status now and the recent blocks. `undefined` for a project the caller may not read. Optionally one resource. */
  async list(by: Principal, projectId: string, filter: { resourceId?: string } = {}): Promise<LeaseView[] | undefined> {
    if ((await this.#duties.list(by, projectId)) === undefined) return undefined;
    const found = await scanAll(this.#runner, LEASE, 50_000, (a) => { const b = a.body as unknown as LeaseBody; return b.projectId === projectId && (filter.resourceId === undefined || b.resourceId === filter.resourceId); });
    return found.map((a) => this.#viewOf(a)).sort((a, b) => (a.resourceId < b.resourceId ? -1 : 1));
  }

  async #read(resourceId: string): Promise<LeaseView | undefined> {
    const a = await this.#runner.get(LEASE, leaseIdOf(resourceId));
    return a === undefined ? undefined : this.#viewOf(a);
  }

  #viewOf(a: import("../storage/types.js").Aggregate): LeaseView {
    const v = view<LeaseBody>(a) as unknown as LeaseView;
    const live = v.state === "held" && v.expiresAt !== undefined && Date.parse(v.expiresAt) > Date.parse(this.#runner.now());
    return { ...v, status: v.state === "free" ? "free" : live ? "held" : "expired" };
  }

  /** The claim and the responsibility behind a managed resource, for a caller allowed to act on it; a missing or unmanaged resource and a refused caller read alike. */
  async #managed(by: Principal, resourceId: string, what: string): Promise<{ claim: ClaimBody; duty: View<ResponsibilityBody> }> {
    const claim = (await this.#runner.get(CLAIM, resourceId))?.body as unknown as ClaimBody | undefined;
    const duty = claim === undefined || claim.state !== "held" ? undefined : await this.#duties.get(by, claim.responsibilityId);
    if (claim === undefined || duty === undefined || !(by.kind === "owner" || (duty.ownerId !== undefined && by.id === duty.ownerId) || may(by, "responsibility.write", duty.projectId))) throw hidden(by, what);
    return { claim, duty };
  }
}
