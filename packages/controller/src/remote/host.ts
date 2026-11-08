import { DomainError } from "../domain/errors.js";
import type { JsonObject } from "../storage/types.js";
import type { Principal } from "../security/index.js";
import { sealContract } from "./contract.js";
import type { ContractLimits, HostLocalWork, HostProbe, RecipeSummary, ToolGateway, WorkOrder, WorkerHandle, WorkerHost, WorkerTurnResult } from "../dispatch/ports.js";
import type { WorkspacePort } from "../workspace-ops/workspace-ops.js";
import type { RemoteWorkerService, Requirements } from "./service.js";

export interface RemoteWorkerHostOptions {
  /** What one attempt asks of the host, for admission. */
  readonly resources: { readonly cpus: number; readonly memoryMb: number };
  /** What the attempt needs of the host (platform, isolation, workspaces and where its data may go). The operator's policy, never a default: a host that cannot say refuses the placement. */
  readonly requirements: (order: WorkOrder) => Requirements;
  /** The artifacts the worker fetches before it starts. */
  readonly inputs?: (order: WorkOrder) => readonly string[];
  /** How long to wait for the worker to send the checkpoint it was asked for. Default 5 seconds (a shutdown waits this long for each remote attempt). */
  readonly checkpointWaitMs?: number;
  /** Wait between looks for the checkpoint, in milliseconds. Default 100. */
  readonly pollMs?: number;
  /** How long a workspace request (integration, landing, refresh, quarantine) waits for the host's answer, in ms. Default 300 000 (five minutes); a host that is slower leaves the request recorded as failed, with the operation possibly done there. */
  readonly workspaceWaitMs?: number;
  /**
   * The owner's limits and best-effort setting (card H12k), read at every start and carried to the worker in the dispatch contract (card H12a). A read that fails refuses the start: nothing is sent
   * unlimited. Absent: the order goes with the task contract only (the composed controller always gives it).
   */
  readonly ownerPolicy?: { readonly limits: () => Promise<ContractLimits | undefined>; readonly bestEffort: () => Promise<boolean> };
}

/**
 * The dispatcher's view of a remote worker (card H02): `start` places the attempt on the host through `RemoteWorkerService` (the host fetches the order over its authenticated channel),
 * and the handle waits for the result the worker sends, asks it for checkpoints, tells it and stops it by control messages. It holds no worker connection of its own: everything the worker
 * does arrives through the transport, fenced by the placement number.
 */
export class RemoteWorkerHost implements WorkerHost {
  readonly resources: { readonly cpus: number; readonly memoryMb: number };
  readonly ownerPolicy: boolean;
  /** The same request the local host answers, carried over the authenticated transport to the host (card H12m): the answer has the same typed outcomes. */
  readonly workspace: WorkspacePort;
  constructor(readonly hostId: string, private readonly remote: RemoteWorkerService, private readonly by: Principal, private readonly options: RemoteWorkerHostOptions) {
    this.resources = options.resources;
    this.ownerPolicy = options.ownerPolicy !== undefined;
    // A host whose port threw (the work may be half done) says so with `failed`: that is thrown here, as a local host's throw is, so the workspace service records `failed`, not a clean refusal.
    this.workspace = { run: async (call) => {
      const answer = await this.remote.askWorkspace(this.by, this.hostId, call, { waitMs: this.options.workspaceWaitMs ?? 300_000 });
      if (answer.ok === false && answer.failed === true) throw new DomainError("unavailable", answer.reason);
      return answer.ok ? answer : { ok: false, reason: answer.reason };
    } };
  }

  /**
   * What this host holds for Stop (card L02d). The controller cannot see a remote worker's processes, and no worker report of them exists yet, so a live remote placement of an asked attempt reads as one unknown item: a Stop that
   * ends the attempt (the placement is then over) is clean, and a look while it is still live says that nothing is known about what the worker runs. Bounded to 500 attempts.
   */
  async localWork(attemptIds: readonly string[]): Promise<HostLocalWork> {
    const processes: { attemptId: string; ref: string; kind: "process"; state: "unknown" }[] = [];
    for (const attemptId of attemptIds.slice(0, 500)) {
      const placement = await this.remote.placement(this.by, attemptId);
      if (placement === undefined || placement.hostId !== this.hostId || !["offered", "accepted", "relocating"].includes(placement.state)) continue;
      processes.push({ attemptId, ref: `remote:${attemptId}`, kind: "process", state: "unknown" });
    }
    return { processes, costs: [], known: attemptIds.slice(0, 500) };
  }

  /** Why this host would refuse the attempt (card H07e), judged by the same rules as the placement. The order is not built yet, so the requirements are asked of a preview of it that carries no credential. */
  async refuses(probe: HostProbe): Promise<{ readonly reasons: readonly string[]; readonly lasting: boolean }> {
    const preview: WorkOrder = { attemptId: probe.attemptId, taskId: probe.taskId, projectId: probe.projectId, agentId: probe.agentId, generation: probe.generation, ...(probe.harness === undefined ? {} : { harness: probe.harness }), route: probe.route, credential: "", recipe: { revision: "preview", reach: [] }, content: "", requestId: "", ...(probe.expiresAt === undefined ? {} : { expiresAt: probe.expiresAt }) };
    return this.remote.refusals(this.by, { hostId: this.hostId, attemptId: probe.attemptId, taskId: probe.taskId, projectId: probe.projectId, agentId: probe.agentId, requirements: this.options.requirements(preview) });
  }

  async release(attemptId: string, reason: string): Promise<void> { await this.remote.end(this.by, attemptId, reason); }

  /** The order with the owner's limits and best-effort setting in its contract, sealed again. */
  async #carry(order: WorkOrder): Promise<WorkOrder> {
    const policy = this.options.ownerPolicy;
    if (policy === undefined) return order;
    const limits = await policy.limits();
    const bestEffort = await policy.bestEffort();
    const c = order.contract;
    return sealContract(order, { taskContractVersion: c?.taskContractVersion ?? 0, permissions: c?.permissions ?? [], ...(c?.budget === undefined ? {} : { budget: c.budget }), ...(limits === undefined ? {} : { limits }), bestEffort });
  }

  async start(given: WorkOrder): Promise<WorkerHandle> {
    const order = await this.#carry(given);
    const placed = await this.remote.place(this.by, { hostId: this.hostId, order, requirements: this.options.requirements(order), inputs: this.options.inputs?.(order) ?? [] });
    return new RemoteWorkerHandle(this.remote, this.by, order.attemptId, placed.placement, this.options);
  }
}

export class RemoteWorkerHandle implements WorkerHandle {
  readonly workerVersion = "remote";
  constructor(private readonly remote: RemoteWorkerService, private readonly by: Principal, readonly attemptId: string, readonly placement: number, private readonly options: RemoteWorkerHostOptions) {}
  run(_gateway: ToolGateway): Promise<WorkerTurnResult> { void _gateway; return this.remote.waitForResult(this.by, this.attemptId, this.placement) as Promise<WorkerTurnResult>; }
  /** The handle acts only while its own placement holds the attempt: after a move, an old handle controls nothing. */
  async #current(): Promise<void> {
    const p = await this.remote.placement(this.by, this.attemptId);
    if (p === undefined || p.placement !== this.placement) throw new DomainError("fenced", `attempt ${this.attemptId} is no longer held under placement ${this.placement}`);
  }
  async checkpoint(): Promise<JsonObject> {
    await this.#current();
    const before = (await this.remote.placement(this.by, this.attemptId))?.checkpoint?.sequence ?? 0;
    await this.remote.control(this.by, this.attemptId, { kind: "checkpoint" }, this.placement);
    const until = Date.now() + (this.options.checkpointWaitMs ?? 5_000);
    for (;;) {
      const now = await this.remote.placement(this.by, this.attemptId);
      // The wait is for this placement's checkpoint: after a move the new host's checkpoint is not the answer to this handle's request.
      if (now === undefined || now.placement !== this.placement) throw new DomainError("fenced", `attempt ${this.attemptId} is no longer held under placement ${this.placement}`);
      const seen = now.checkpoint?.sequence ?? 0;
      if (seen > before) { const latest = await this.remote.latestCheckpoint(this.by, this.attemptId); if (latest !== undefined) return latest.checkpoint; }
      if (Date.now() >= until) throw new Error("the worker did not send a checkpoint in time");
      await new Promise((resolve) => setTimeout(resolve, this.options.pollMs ?? 100));
    }
  }
  async restart(recipe: RecipeSummary, from: JsonObject): Promise<void> { await this.#current(); await this.remote.control(this.by, this.attemptId, { kind: "restart", recipe, checkpoint: from }, this.placement); }
  async tell(text: string): Promise<void> { await this.#current(); await this.remote.control(this.by, this.attemptId, { kind: "tell", text }, this.placement); }
  async stop(): Promise<void> { await this.remote.end(this.by, this.attemptId, "the dispatcher stopped the worker", this.placement); }
}
