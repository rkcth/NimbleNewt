import { DomainError } from "../domain/errors.js";
import { onlyKnown, taskId as checkTaskId, text } from "../domain/model.js";
import { allowsExactly, inTaskScope } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { IntegratorLeaseService, type IntegratorLease } from "./integrator-lease.js";

/**
 * Who may take, keep, give back and see an integrator lease, and what a landing must show before it writes (card P10). The lease service itself takes no caller; this is the authorised door to it.
 *
 * The right is `integration.lease` on the project (exact: a wildcard grant is not enough, as for `workspace.manage`); the owner always has it and a task credential never does. The holder is always an agent: an agent holds
 * the lease as itself (its own agent ID, taken from who it authenticated as, never from what it says), and only the owner may take one for a named agent. Renewing is the holder's alone. Giving it back is the holder's, or the
 * owner's (who may end it without knowing the fence). A task that is not in the project cannot hold the project's lease.
 */
const holderOf = (by: Principal): string | undefined => (by.kind === "agent" && by.id.startsWith("agent:") && by.id.length > "agent:".length ? by.id.slice("agent:".length) : undefined);
const refused = (what: string): DomainError => new DomainError("not_found", `${what} does not exist or is not yours to manage`);

export interface IntegratorLeaseOpsOptions {
  /** Whether an agent ID names an active agent (P10 review): the owner can only name one of those as the holder. Absent (unit rigs), any name is taken. */
  readonly activeAgent?: (agentId: string) => Promise<boolean>;
}

export class IntegratorLeaseOps {
  readonly #leases: IntegratorLeaseService;
  readonly #options: IntegratorLeaseOpsOptions;
  constructor(leases: IntegratorLeaseService, options: IntegratorLeaseOpsOptions = {}) { this.#leases = leases; this.#options = options; }

  #allowed(by: Principal, projectId: string): boolean {
    return by.taskScope === undefined && inTaskScope(by, projectId) && allowsExactly(by, "integration.lease", projectId);
  }

  async #ofTask(by: Principal, rawTask: string): Promise<{ taskId: string; projectId: string }> {
    const taskId = checkTaskId(rawTask);
    const projectId = await this.#leases.projectOfTask(taskId);
    if (projectId === undefined || !this.#allowed(by, projectId)) throw refused(`task ${taskId}`);
    return { taskId, projectId };
  }

  /** The lease named by ID, or by project and branch, with the project it belongs to checked against the caller's right. */
  async #named(by: Principal, q: { leaseId?: unknown; projectId?: unknown; branch?: unknown }): Promise<IntegratorLease> {
    const leaseId = typeof q.leaseId === "string" ? q.leaseId : typeof q.projectId === "string" && typeof q.branch === "string" ? IntegratorLeaseService.leaseIdOf(q.projectId, q.branch) : undefined;
    if (leaseId === undefined) throw new DomainError("invalid_command", "name the lease by leaseId, or by projectId and branch", { field: "leaseId" });
    const found = await this.#leases.get(leaseId);
    if (found === undefined || !this.#allowed(by, found.projectId)) throw refused("that lease");
    return found;
  }

  /** Takes the lease of the task's project on `branch`. `holder` is for the owner only. */
  async acquire(by: Principal, command: NoActor & { taskId: string; branch: string; ttlMs: number; holder?: string }): Promise<IntegratorLease> {
    onlyKnown(command, ["commandId", "taskId", "branch", "ttlMs", "holder"]);
    const { taskId, projectId } = await this.#ofTask(by, command.taskId);
    let holder = holderOf(by);
    if (by.kind === "owner") {
      if (command.holder === undefined) throw new DomainError("invalid_command", "holder: the owner names the agent that will hold the lease", { field: "holder" });
      holder = text(command.holder, "holder", { min: 1, max: 100 });
      // The holder must be an active agent (P10 review): a lease named for nobody (a typo, `agent:` written in, a retired agent) would block the branch until it expires and no one could renew or land with it.
      if (this.#options.activeAgent !== undefined && !(await this.#options.activeAgent(holder))) throw new DomainError("invalid_command", `holder: ${holder} is not an active agent (name the agent by its ID, without "agent:")`, { field: "holder" });
    } else if (holder === undefined) {
      throw new DomainError("forbidden", `${by.id} is not an agent, so it cannot hold an integrator lease`);
    } else if (command.holder !== undefined && command.holder !== holder) {
      throw new DomainError("forbidden", "an agent holds the lease as itself; only the owner takes it for another agent");
    }
    return this.#leases.acquire({ commandId: scopedCommandId(by.id, command.commandId), projectId, branch: command.branch, holder, taskId, ttlMs: command.ttlMs });
  }

  /** Extends the hold. Only the holder, with its current fence. */
  async renew(by: Principal, command: NoActor & { leaseId: string; fence: number }): Promise<IntegratorLease> {
    onlyKnown(command, ["commandId", "leaseId", "fence"]);
    const found = await this.#named(by, command);
    const holder = holderOf(by);
    if (holder === undefined || holder !== found.holder) throw new DomainError("fenced", `lease ${found.leaseId} is not held by ${by.id}`);
    return this.#leases.renew({ commandId: scopedCommandId(by.id, command.commandId), leaseId: found.leaseId, fence: command.fence, holder });
  }

  /** Lets the lease go. The holder names its fence; the owner may name the lease by project and branch and omit the fence (it ends whoever holds it now). */
  async release(by: Principal, command: NoActor & { leaseId?: string; projectId?: string; branch?: string; fence?: number; note?: string }): Promise<IntegratorLease> {
    onlyKnown(command, ["commandId", "leaseId", "projectId", "branch", "fence", "note"]);
    const found = await this.#named(by, command);
    if (by.kind !== "owner" && (holderOf(by) === undefined || holderOf(by) !== found.holder)) throw new DomainError("fenced", `lease ${found.leaseId} is not held by ${by.id}`);
    if (command.fence === undefined && by.kind !== "owner") throw new DomainError("invalid_command", "fence: is required", { field: "fence" });
    if (found.state === "released") return found;
    return this.#leases.release({ commandId: scopedCommandId(by.id, command.commandId), leaseId: found.leaseId, fence: command.fence ?? found.fence, ...(command.note === undefined ? {} : { note: command.note }) });
  }

  /** The leases of a project, live or not (one per branch ever leased). */
  async list(by: Principal, query: { projectId: string; limit?: number }): Promise<IntegratorLease[]> {
    onlyKnown(query, ["projectId", "limit"]);
    if (typeof query.projectId !== "string" || !this.#allowed(by, query.projectId)) throw refused("that project");
    return this.#leases.forProject(query.projectId, query.limit);
  }

  /**
   * What a landing shows before it writes (the workspace service calls this twice: when the request is made and again right before the host is asked). The lease must be the live hold, with this fence, of the caller itself
   * (an agent that still has the right `integration.lease` on the project; the owner acts for whoever holds it), on exactly the branch the landing goes to, and of the task's own project. `fenced` for a hold that changed,
   * expired, is someone else's, does not exist or is another project's (one answer for those last two, so a landing never tells whether another project has a lease); `forbidden` for another branch or a right taken away.
   *
   * The owner may leave the lease out: the live lease of the landing branch is used (the owner acts for its holder; with no live holder nothing lands), and the lease used is answered so the second showing checks that same
   * hold (P10 review: without this the owner could not land through chat at all, since a lease ID is never the owner's own words).
   */
  async checkLanding(by: Principal, call: { taskId: string; projectId: string; branch: string | undefined; leaseId: unknown; fence: unknown }): Promise<{ leaseId: string; fence: number }> {
    let leaseId = call.leaseId, fence = call.fence;
    if (by.kind === "owner" && leaseId === undefined && fence === undefined) {
      if (call.branch === undefined) throw new DomainError("forbidden", "the project has no landing branch, so no lease covers a landing");
      const current = await this.#leases.get(IntegratorLeaseService.leaseIdOf(call.projectId, call.branch));
      if (current === undefined || !current.live) throw new DomainError("fenced", `no integrator holds the lease of branch ${call.branch} now, so nothing can land; take it for an agent first (integrator.lease.acquire)`);
      leaseId = current.leaseId; fence = current.fence;
    }
    if (typeof leaseId !== "string" || typeof fence !== "number" || !Number.isInteger(fence)) throw new DomainError("invalid_command", "a landing is made under the project's integrator lease: give leaseId and fence", { field: "leaseId" });
    const found = await this.#leases.get(leaseId);
    if (found === undefined || found.projectId !== call.projectId) throw new DomainError("fenced", `lease ${leaseId} is not a lease of this task's project`);
    if (call.branch === undefined) throw new DomainError("forbidden", "the project has no landing branch, so no lease covers a landing");
    if (found.branch !== call.branch) throw new DomainError("forbidden", `lease ${leaseId} is for branch ${found.branch}, not the landing branch ${call.branch}`);
    // An agent lands only while it still has the right (P10 review): taking the right away stops its landings at once, not when its hold runs out (up to a day later).
    if (by.kind !== "owner" && !this.#allowed(by, found.projectId)) throw new DomainError("forbidden", `${by.id} no longer has the right integration.lease on this project, so it cannot land under the lease`);
    const holder = by.kind === "owner" ? found.holder : holderOf(by);
    if (holder === undefined || !(await this.#leases.valid(leaseId, fence, holder))) throw new DomainError("fenced", `lease ${leaseId} is not held with fence ${fence} by the caller (it expired, was released, or changed hands)`);
    return { leaseId, fence };
  }
}
