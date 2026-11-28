import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { onlyKnown } from "../domain/model.js";
import { allowsExactly, inTaskScope } from "../security/access.js";
import type { NoActor, Principal } from "../security/principals.js";
import { IntegratorLeaseService, LEASE_LIMITS, type IntegratorLease } from "./integrator-lease.js";
import { frontOf, type LandingQueue, type LandingQueueService } from "./landing-queue.js";
import type { IntegratorLeaseOps } from "./lease-ops.js";
import { reachOf, reachServes, type LandingReachOf } from "./landing-reach.js";

/**
 * Integrators shared across projects as a pool (card P10b, first slice: "free integrators take the next project with queued work").
 *
 * An integrator agent is free while it holds no live integrator lease of any project it may still land on. A free integrator asks the pool for work; the pool looks at every landing queue that holds approved work, of the
 * projects where the caller has the exact right `integration.lease` (a grant for every project counts for every project; a project where it has no right is not looked at and not counted in the answer), and takes the
 * landing branch's lease for the caller on the queue whose first place has waited longest (ties by project and branch ID). The lease is taken through `IntegratorLeaseOps.acquire`, so every rule of P10 applies as it does
 * when the agent asks for one lease itself: only the landing branch the owner's policy names, one holder per branch, a retired holder's hold ended first. The hold is worked under the queue's first task (a task of that
 * project, as P10 requires); the landing itself is still `workspace.request` with the lease, judged as before.
 *
 * A branch whose lease another active integrator holds live is passed over; so is a queue whose first place is a reservation waiting for its task's work (nothing can land there now). When nothing is taken the answer says
 * why, in counts the caller is allowed to know. An integrator that already holds a lease is answered that hold (`holding`) and given nothing more: one project at a time, so a repeat of the same request answers what it took.
 *
 * Bounded: the queues are read by `LandingQueueService.queuesWithEntries` (50 pages of 200), the caller's holds by `IntegratorLeaseService.heldBy` (likewise), at most `POOL_LIMITS.policyReads` landing policies are read
 * and at most `POOL_LIMITS.tries` leases are tried per request. An incomplete read of the caller's own holds is refused (`unavailable`); an incomplete read of the queues is said (`partial`).
 */
export const POOL_LIMITS = { policyReads: 100, tries: 10 } as const;

export interface IntegratorPoolOptions {
  /** The landing branch the owner's policy names for the project (the same function the lease door uses). */
  readonly landingBranch: (call: { taskId: string; projectId: string }) => Promise<string | undefined>;
  /** Whether an agent ID names an active agent: a live hold of an agent that is not active is not passed over (the lease door ends it when the caller takes the branch). Absent (unit rigs): every holder counts as active. */
  readonly activeAgent?: (agentId: string) => Promise<boolean>;
  /**
   * Card P10b (second clause): what a landing task's own credential reaches (`IntegratorWake.landingReach`). With it, a woken integrator's attempt may ask the pool on its task credential: it is answered about, and
   * takes, only the one branch of its landing task's project (its holds elsewhere and other projects' queues are not looked at or counted). Absent: every task credential is refused, as before.
   */
  readonly landingReach?: LandingReachOf;
}

export type PoolAnswer =
  | { readonly outcome: "taken"; readonly projectId: string; readonly branch: string; readonly taskId: string; readonly submissionId: string; readonly waitingSince: string; readonly lease: IntegratorLease }
  | { readonly outcome: "holding"; readonly projectId: string; readonly branch: string; readonly lease: IntegratorLease; readonly holding: number; readonly reason: string }
  | { readonly outcome: "none"; readonly reason: string; readonly heldByOthers: number; readonly awaitingWork: number; readonly unreadable: number; readonly partial: boolean };

/** Whether an integrator principal serves a project in the pool: its own credential (no task scope) with the exact right `integration.lease` there (a grant for every project counts). One rule for the pool and the capacity view. */
export const servesProject = (by: Principal, projectId: string): boolean => by.taskScope === undefined && inTaskScope(by, projectId) && allowsExactly(by, "integration.lease", projectId);

const holderOf = (by: Principal): string | undefined => (by.kind === "agent" && by.id.startsWith("agent:") && by.id.length > "agent:".length ? by.id.slice("agent:".length) : undefined);
const sinceMs = (at: string | undefined): number => { const t = typeof at === "string" ? Date.parse(at) : NaN; return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY; };
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export class IntegratorPool {
  readonly #leases: Pick<IntegratorLeaseService, "heldBy" | "get" | "projectOfTask">;
  readonly #leaseOps: Pick<IntegratorLeaseOps, "acquire">;
  readonly #queue: Pick<LandingQueueService, "queuesWithEntries">;
  readonly #options: IntegratorPoolOptions;
  constructor(leases: Pick<IntegratorLeaseService, "heldBy" | "get" | "projectOfTask">, leaseOps: Pick<IntegratorLeaseOps, "acquire">, queue: Pick<LandingQueueService, "queuesWithEntries">, options: IntegratorPoolOptions) {
    this.#leases = leases; this.#leaseOps = leaseOps; this.#queue = queue; this.#options = options;
  }

  #serves(by: Principal, projectId: string): boolean {
    return servesProject(by, projectId);
  }

  #holding(l: IntegratorLease, count = 1): PoolAnswer {
    return { outcome: "holding", projectId: l.projectId, branch: l.branch, lease: l, holding: count, reason: `you hold the integrator lease of branch ${l.branch} until ${l.expiresAt}; release it when its queue is done, then ask the pool again` };
  }

  /** Takes the next project with queued work for the calling integrator (see the class). */
  async next(by: Principal, command: NoActor & { ttlMs: number }): Promise<PoolAnswer> {
    onlyKnown(command, ["commandId", "ttlMs"]);
    const holder = holderOf(by);
    if (holder === undefined) throw new DomainError("forbidden", "only an integrator agent takes work from the pool; the owner takes a lease for a named agent with integrator.lease.acquire");
    const reach = await reachOf(this.#options.landingReach, by);
    if (by.taskScope !== undefined && reach === undefined) throw new DomainError("forbidden", "a task credential reaches one task's project only; ask the pool with the agent's own credential");
    // What the caller is judged on: its own credential, every project it serves; a landing task's credential, its one branch (no other project's holds or queues are read into the answer).
    const serves = (projectId: string, branch: string): boolean => (by.taskScope === undefined ? this.#serves(by, projectId) : reachServes(by, reach, projectId, branch));
    if (typeof command.commandId !== "string" || command.commandId.length === 0 || command.commandId.length > 120) throw new DomainError("invalid_command", "commandId: must be 1 to 120 characters", { field: "commandId" });
    const ttl = command.ttlMs;
    if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < LEASE_LIMITS.ttlMinMs || ttl > LEASE_LIMITS.ttlMaxMs) throw new DomainError("invalid_command", `ttlMs: must be a whole number of milliseconds from ${LEASE_LIMITS.ttlMinMs} to ${LEASE_LIMITS.ttlMaxMs}`, { field: "ttlMs" });

    // Free? A hold on a project the caller can no longer land on does not count (its landing is refused anyway, and it runs out by itself).
    const held = await this.#leases.heldBy(holder);
    if (held.partial) throw new DomainError("unavailable", "the integrator leases could not all be read, so it is not known whether you already hold one; nothing was taken");
    const own = held.leases.filter((l) => serves(l.projectId, l.branch));
    if (own.length > 0) return this.#holding(own[0]!, own.length);

    const { queues, partial: queuesPartial } = await this.#queue.queuesWithEntries();
    let awaitingWork = 0, heldByOthers = 0, unreadable = 0;
    const candidates: { q: LandingQueue; taskId: string; submissionId: string; since: string }[] = [];
    for (const q of queues) {
      if (!serves(q.projectId, q.branch)) continue;
      const first = frontOf(q);
      if (first === undefined) continue;
      if (first.entry === undefined) { awaitingWork++; continue; }
      // Since when the first place has been first (the queue's own mark); a record without it: when its entry was queued.
      const since = q.front !== undefined && q.front.taskId === first.taskId ? q.front.since : first.entry.queuedAt;
      candidates.push({ q, taskId: first.taskId, submissionId: first.entry.submissionId, since });
    }
    candidates.sort((a, b) => sinceMs(a.since) - sinceMs(b.since) || cmp(a.q.projectId, b.q.projectId) || cmp(a.q.branch, b.q.branch));

    let reads = 0, tries = 0, stopped = false;
    for (const c of candidates) {
      if (reads >= POOL_LIMITS.policyReads || tries >= POOL_LIMITS.tries) { stopped = true; break; }
      reads++;
      let landing: string | undefined;
      try { landing = await this.#options.landingBranch({ taskId: c.taskId, projectId: c.q.projectId }); } catch { unreadable++; continue; }
      // The queue of a branch that is no longer the landing branch is the owner's to settle (P10 polish); the pool takes only landing branches.
      if (landing !== c.q.branch) continue;
      // The lease door takes the lease of the task's own project: a queue record that names another project for its first task is not trusted (the answer would name one project and the hold be another's).
      if ((await this.#leases.projectOfTask(c.taskId)) !== c.q.projectId) { unreadable++; continue; }
      const leaseId = IntegratorLeaseService.leaseIdOf(c.q.projectId, c.q.branch);
      const current = await this.#leases.get(leaseId);
      // The caller's own live hold here (another request of the same agent took it since the free check above): that is its hold, answered as such, and nothing more is taken.
      if (current !== undefined && current.live && current.holder === holder) return this.#holding(current);
      if (current !== undefined && current.live && (this.#options.activeAgent === undefined || (await this.#options.activeAgent(current.holder)))) { heldByOthers++; continue; }
      tries++;
      // One command per request and branch, so a repeat of the request for the same branch is the same command.
      const commandId = `pool:${createHash("sha256").update(`${command.commandId}\0${c.q.projectId}\0${c.q.branch}`).digest("hex").slice(0, 40)}`;
      let lease: IntegratorLease;
      try {
        lease = await this.#leaseOps.acquire(by, { commandId, taskId: c.taskId, branch: c.q.branch, ttlMs: ttl });
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        if (error.code === "unavailable") {
          // Lost the branch at the same moment: to another request of the caller's own (answered as its hold), or to another integrator.
          const now = await this.#leases.get(leaseId);
          if (now !== undefined && now.live && now.holder === holder) return this.#holding(now);
          heldByOthers++; continue;
        }
        // The pool's own checks passed but the door refused (the landing branch, the task or the right changed during the request): not judged now, and counted, so the answer never says that no work waits.
        if (error.code === "forbidden" || error.code === "not_found") { unreadable++; continue; }
        throw error;
      }
      // A replayed command answers the lease as it is now: only a live hold of the caller's own is work taken.
      if (!lease.live || lease.holder !== holder || lease.projectId !== c.q.projectId || lease.branch !== c.q.branch) { heldByOthers++; continue; }
      return { outcome: "taken", projectId: c.q.projectId, branch: c.q.branch, taskId: c.taskId, submissionId: c.submissionId, waitingSince: c.since, lease };
    }

    const partial = queuesPartial || stopped;
    const parts: string[] = [];
    if (heldByOthers > 0) parts.push(`${heldByOthers} branch${heldByOthers === 1 ? " is" : "es are"} held by another integrator`);
    if (awaitingWork > 0) parts.push(`${awaitingWork} reserved first place${awaitingWork === 1 ? " waits" : "s wait"} for its task's approved work`);
    if (unreadable > 0) parts.push(`${unreadable} queue${unreadable === 1 ? "" : "s"} could not be judged (the landing settings could not be read, or the record does not match its task)`);
    if (partial) parts.push("not every queue was looked at in this request; ask again");
    const reason = parts.length === 0 ? "no project you integrate has approved work waiting to land" : `nothing was taken: ${parts.join("; ")}`;
    return { outcome: "none", reason, heldByOthers, awaitingWork, unreadable, partial };
  }
}
