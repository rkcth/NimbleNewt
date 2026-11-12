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

export class IntegratorLeaseOps {
  readonly #leases: IntegratorLeaseService;
  constructor(leases: IntegratorLeaseService) { this.#leases = leases; }

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
   * (an agent; the owner acts for whoever holds it), on exactly the branch the landing goes to, and of the task's own project. `fenced` for a hold that changed, expired or is someone else's; `forbidden` for another project or branch.
   */
  async checkLanding(by: Principal, call: { taskId: string; projectId: string; branch: string | undefined; leaseId: unknown; fence: unknown }): Promise<void> {
    if (typeof call.leaseId !== "string" || typeof call.fence !== "number" || !Number.isInteger(call.fence)) throw new DomainError("invalid_command", "a landing is made under the project's integrator lease: give leaseId and fence", { field: "leaseId" });
    const found = await this.#leases.get(call.leaseId);
    if (found === undefined) throw new DomainError("fenced", `no lease ${call.leaseId}`);
    if (found.projectId !== call.projectId) throw new DomainError("forbidden", `lease ${call.leaseId} is not a lease of this task's project`);
    if (call.branch === undefined) throw new DomainError("forbidden", "the project has no landing branch, so no lease covers a landing");
    if (found.branch !== call.branch) throw new DomainError("forbidden", `lease ${call.leaseId} is for branch ${found.branch}, not the landing branch ${call.branch}`);
    const holder = by.kind === "owner" ? found.holder : holderOf(by);
    if (holder === undefined || !(await this.#leases.valid(call.leaseId, call.fence, holder))) throw new DomainError("fenced", `lease ${call.leaseId} is not held with fence ${call.fence} by the caller (it expired, was released, or changed hands)`);
  }
}
