import type { Principal } from "../security/principals.js";
import type { ControllerStorage } from "../storage/types.js";
import { IntegratorLeaseService, type IntegratorLease } from "./integrator-lease.js";
import { servesProject } from "./integrator-pool.js";

/**
 * Who can land a project's landing queue now (card P10b, fourth clause: "when no capacity is left, work waits with a visible reason"), for the owner's `landing_queue` status view. Read-only: it takes nothing, wakes
 * nobody and changes no record.
 *
 * The pool's integrators are the active agents with the exact right `integration.lease` on the project (a grant for every project counts), judged by the same rule as `IntegratorPool.next` (`servesProject`). One of them
 * is busy while it holds a live integrator lease of any project it serves (one project at a time), and free otherwise. The answer is:
 * - `held`: an active agent holds the branch's live lease (whoever it is; the pool passes such a branch over too), with until when, and whether it may still land under it (`lands`: it still serves the project; a
 *   holder whose right was taken away cannot land, so the queue waits until the hold is released or runs out);
 * - `woken`: nobody active holds it and the controller woke an integrator for it (`IntegratorWake`) whose landing task has not ended;
 * - `free`: nobody active holds it and at least one integrator that serves the project is free (not holding a lease of a project it serves, not woken for a landing), so the controller wakes one at its next round
 *   or the pool gives it this queue when it asks (oldest waiting queue first);
 * - `busy`: every integrator that serves the project holds a lease already, so no capacity is left;
 * - `nobody`: no active agent serves the project, so no capacity exists;
 * - `unknown`: the leases could not all be read, so nobody is said to be free or busy (fail closed).
 *
 * Bounded: the agent records are read in pages of 200, at most `CAPACITY_LIMITS.principalPages` pages, and at most `CAPACITY_LIMITS.agents` active agents are judged; the leases by `IntegratorLeaseService.liveLeases`
 * (50 pages of 200). A walk of the agent records that stops early is said (`partial`: there may be more integrators than counted); `nobody` and `busy` are then said only of the agents read.
 *
 * Cost: judging an agent (`PrincipalService.current`) reads every grant and restriction record, so only the agents that can have the right at all are judged: those whose own record or a grant record (any state; the
 * judgement decides whether it holds now) names the action `integration.lease` (`integratorCandidateIds`). A view then costs one walk of the agent records, one of the grant records and one judgement per such agent.
 */
export const CAPACITY_LIMITS = { principalPages: 10, agents: 500, grantPages: 50 } as const;

export type CapacityAnswer =
  | { readonly state: "held"; readonly holder: string; readonly expiresAt: string; readonly lands: boolean }
  /** Card P10b (wake): nobody active holds the branch, and the controller woke an integrator for it (a landing task assigned to it that has not ended). */
  | { readonly state: "woken"; readonly agentId: string; readonly taskId: string; readonly at: string }
  /** `wakesSpent`: the controller already woke an integrator this many times for the work now first in the queue and wakes nobody more for it (`INTEGRATOR_WAKE_LIMITS.perFront`). */
  | { readonly state: "free"; readonly free: number; readonly busy: number; readonly partial: boolean; readonly wakesSpent?: number }
  | { readonly state: "busy"; readonly busy: number; readonly partial: boolean }
  | { readonly state: "nobody"; readonly partial: boolean }
  | { readonly state: "unknown"; readonly reason: string };

export interface IntegratorCapacityOptions {
  /** The active agents' principal IDs (`agent:...`), bounded, with whether the walk stopped early. */
  readonly agents: () => Promise<{ readonly ids: readonly string[]; readonly partial: boolean }>;
  /** The principal as it stands now (grants as of now), or nothing when it is not an active principal: `PrincipalService.current`. */
  readonly principal: (principalId: string) => Promise<Principal | undefined>;
  /**
   * Card P10b (wake): the integrators the controller woke whose landing task has not ended (each is busy: one project at a time), and the queues whose first work it woke an integrator for as often as it does. Absent: no
   * wakes are kept. A list that could not all be read makes the answer `unknown` (nobody is said to be free).
   */
  readonly wakes?: () => Promise<WakesNow>;
}

/** What the wakes say now (see `IntegratorCapacityOptions.wakes`). */
export interface WakesNow {
  readonly open: readonly { readonly projectId: string; readonly branch: string; readonly agentId: string; readonly taskId: string; readonly at: string }[];
  readonly spent: readonly { readonly projectId: string; readonly branch: string; readonly frontTaskId: string; readonly wakes: number }[];
  readonly partial: boolean;
}

/**
 * The active agents' IDs from the principal records, at most `pages` pages of 200 and `limit` agents; `partial` when either bound stopped the walk. With `keep`, only the agents it keeps are counted toward `limit`
 * and returned.
 */
export async function activeAgentIds(storage: Pick<ControllerStorage, "listAggregates">, pages: number = CAPACITY_LIMITS.principalPages, limit: number = CAPACITY_LIMITS.agents, keep?: (id: string, body: unknown) => boolean): Promise<{ ids: string[]; partial: boolean }> {
  const ids: string[] = [];
  let after: string | undefined;
  for (let page = 0; page < pages; page++) {
    const batch = await storage.listAggregates("principal", { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
    for (const a of batch) {
      if (!a.id.startsWith("agent:") || (a.body as unknown as { state?: unknown }).state !== "active") continue;
      if (keep !== undefined && !keep(a.id, a.body)) continue;
      if (ids.length >= limit) return { ids, partial: true };
      ids.push(a.id);
    }
    if (batch.length < 200) return { ids, partial: false };
    after = batch[batch.length - 1]!.id;
  }
  return { ids, partial: true };
}

const LEASE_RIGHT = "integration.lease";
const names = (grants: unknown): boolean => Array.isArray(grants) && grants.some((g) => (g as { action?: unknown } | null)?.action === LEASE_RIGHT);

/**
 * The active agents that can have the right `integration.lease` at all: their own record names it, or a grant record (whatever its state) does. A superset of the integrators, so judging only these counts the same
 * as judging every agent; the grant records are read in pages of 500, at most `grantPages`, and when that walk stops early no agent is left out for want of a grant record (every active agent is judged).
 */
export async function integratorCandidateIds(storage: Pick<ControllerStorage, "listAggregates">, grantPages: number = CAPACITY_LIMITS.grantPages): Promise<{ ids: string[]; partial: boolean }> {
  const granted = new Set<string>();
  let complete = false;
  let after: string | undefined;
  for (let page = 0; page < grantPages; page++) {
    const batch = await storage.listAggregates("grant-record", { ...(after === undefined ? {} : { afterId: after }), limit: 500 });
    for (const r of batch) { const b = r.body as unknown as { grantee?: unknown; action?: unknown }; if (b.action === LEASE_RIGHT && typeof b.grantee === "string") granted.add(b.grantee); }
    if (batch.length < 500) { complete = true; break; }
    after = batch[batch.length - 1]!.id;
  }
  return activeAgentIds(storage, CAPACITY_LIMITS.principalPages, CAPACITY_LIMITS.agents, complete ? (id, body) => granted.has(id) || names((body as { grants?: unknown } | null)?.grants) : undefined);
}

const bare = (principalId: string): string | undefined => (principalId.startsWith("agent:") && principalId.length > "agent:".length ? principalId.slice("agent:".length) : undefined);

export class IntegratorCapacity {
  readonly #leases: Pick<IntegratorLeaseService, "get" | "liveLeases">;
  readonly #options: IntegratorCapacityOptions;
  constructor(leases: Pick<IntegratorLeaseService, "get" | "liveLeases">, options: IntegratorCapacityOptions) {
    this.#leases = leases; this.#options = options;
  }

  /**
   * Who can land `branch` of `projectId` now (see the class). `frontTaskId`, the task first in the queue, says whether the controller has used up its wakes for that work. The caller decides who may see it (the status
   * view: the owner only, since it counts holds on other projects).
   */
  async of(projectId: string, branch: string, frontTaskId?: string): Promise<CapacityAnswer> {
    const { leases, partial: leasesPartial } = await this.#leases.liveLeases();
    if (leasesPartial) return { state: "unknown", reason: "the integrator leases could not all be read" };
    const wakes = await this.#wakes();
    if (wakes === undefined) return { state: "unknown", reason: "the integrators the controller woke could not all be read" };
    const own = leases.find((l) => l.projectId === projectId && l.branch === branch);
    if (own !== undefined) {
      const holder = await this.#options.principal(`agent:${own.holder}`);
      // A live hold of an agent that is no longer active is ended when the next integrator takes the branch (the lease door), so it is not capacity in use.
      if (holder !== undefined && holder.kind === "agent") return { state: "held", holder: own.holder, expiresAt: own.expiresAt, lands: holder.id === `agent:${own.holder}` && servesProject(holder, projectId) };
    }
    const woken = wakes.open.find((w) => w.projectId === projectId && w.branch === branch);
    if (woken !== undefined) return { state: "woken", agentId: woken.agentId, taskId: woken.taskId, at: woken.at };
    const judged = await this.#judge(projectId, leases, wakes);
    const free = judged.free.length, busy = judged.busy;
    const spent = frontTaskId === undefined ? undefined : wakes.spent.find((x) => x.projectId === projectId && x.branch === branch && x.frontTaskId === frontTaskId);
    if (free > 0) return { state: "free", free, busy, partial: judged.partial, ...(spent === undefined ? {} : { wakesSpent: spent.wakes }) };
    if (busy > 0) return { state: "busy", busy, partial: judged.partial };
    return { state: "nobody", partial: judged.partial };
  }

  /**
   * The integrators of a project now, by the pool's rule (card P10b, wake): the free ones' agent IDs (bare, in ID order) and how many are busy, a busy one holding a live lease of a project it serves or being woken
   * for a landing that has not ended. `alsoBusy` names agents the caller has just woken. Undefined when the leases or the wakes could not all be read (nobody is said to be free).
   */
  async integrators(projectId: string, alsoBusy: ReadonlySet<string> = new Set(), seen?: { readonly leases: readonly IntegratorLease[]; readonly wakes: WakesNow }): Promise<{ readonly free: readonly string[]; readonly busy: number; readonly partial: boolean } | undefined> {
    // `seen`: the leases and wakes the caller read completely in this same round (the wake round judges every project against one picture, rather than reading every lease and wake again per project).
    if (seen !== undefined) return seen.wakes.partial ? undefined : this.#judge(projectId, seen.leases, seen.wakes, alsoBusy);
    const { leases, partial } = await this.#leases.liveLeases();
    if (partial) return undefined;
    const wakes = await this.#wakes();
    if (wakes === undefined) return undefined;
    return this.#judge(projectId, leases, wakes, alsoBusy);
  }

  async #wakes(): Promise<WakesNow | undefined> {
    if (this.#options.wakes === undefined) return { open: [], spent: [], partial: false };
    const w = await this.#options.wakes();
    return w.partial ? undefined : w;
  }

  async #judge(projectId: string, leases: readonly IntegratorLease[], wakes: WakesNow, alsoBusy: ReadonlySet<string> = new Set()): Promise<{ free: string[]; busy: number; partial: boolean }> {
    const byHolder = new Map<string, IntegratorLease[]>();
    for (const l of leases) { const list = byHolder.get(l.holder); if (list === undefined) byHolder.set(l.holder, [l]); else list.push(l); }
    const woken = new Set(wakes.open.map((w) => w.agentId));
    const agents = await this.#options.agents();
    const free: string[] = [];
    let busy = 0;
    for (const id of agents.ids) {
      const name = bare(id);
      if (name === undefined) continue;
      const p = await this.#options.principal(id);
      if (p === undefined || p.kind !== "agent" || p.id !== id || !servesProject(p, projectId)) continue;
      // Busy as the pool judges it: a live hold on a project it still serves (a hold where its right was taken away does not count); or woken for a landing that has not ended.
      if ((byHolder.get(name) ?? []).some((l) => servesProject(p, l.projectId)) || woken.has(name) || alsoBusy.has(name)) busy++; else free.push(name);
    }
    free.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return { free, busy, partial: agents.partial };
  }
}
