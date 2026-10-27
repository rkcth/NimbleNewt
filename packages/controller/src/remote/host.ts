import type { JsonObject } from "../storage/types.js";
import type { Principal } from "../security/index.js";
import type { RecipeSummary, ToolGateway, WorkOrder, WorkerHandle, WorkerHost, WorkerTurnResult } from "../dispatch/ports.js";
import type { RemoteWorkerService, Requirements } from "./service.js";

export interface RemoteWorkerHostOptions {
  /** What one attempt asks of the host, for admission. */
  readonly resources: { readonly cpus: number; readonly memoryMb: number };
  /** What the attempt needs of the host (platform, isolation, workspaces and where its data may go). The operator's policy, never a default: a host that cannot say refuses the placement. */
  readonly requirements: (order: WorkOrder) => Requirements;
  /** The artifacts the worker fetches before it starts. */
  readonly inputs?: (order: WorkOrder) => readonly string[];
  /** How long to wait for the worker to send the checkpoint it was asked for. Default 30 seconds. */
  readonly checkpointWaitMs?: number;
  /** Wait between looks for the checkpoint, in milliseconds. Default 100. */
  readonly pollMs?: number;
}

/**
 * The dispatcher's view of a remote worker (card H02): `start` places the attempt on the host through `RemoteWorkerService` (the host fetches the order over its authenticated channel),
 * and the handle waits for the result the worker sends, asks it for checkpoints, tells it and stops it by control messages. It holds no worker connection of its own: everything the worker
 * does arrives through the transport, fenced by the placement number.
 */
export class RemoteWorkerHost implements WorkerHost {
  readonly resources: { readonly cpus: number; readonly memoryMb: number };
  constructor(readonly hostId: string, private readonly remote: RemoteWorkerService, private readonly by: Principal, private readonly options: RemoteWorkerHostOptions) { this.resources = options.resources; }

  async start(order: WorkOrder): Promise<WorkerHandle> {
    const placed = await this.remote.place(this.by, { hostId: this.hostId, order, requirements: this.options.requirements(order), inputs: this.options.inputs?.(order) ?? [] });
    return new RemoteWorkerHandle(this.remote, this.by, order.attemptId, placed.placement, this.options);
  }
}

class RemoteWorkerHandle implements WorkerHandle {
  readonly workerVersion = "remote";
  constructor(private readonly remote: RemoteWorkerService, private readonly by: Principal, readonly attemptId: string, readonly placement: number, private readonly options: RemoteWorkerHostOptions) {}
  run(_gateway: ToolGateway): Promise<WorkerTurnResult> { void _gateway; return this.remote.waitForResult(this.by, this.attemptId, this.placement) as Promise<WorkerTurnResult>; }
  async checkpoint(): Promise<JsonObject> {
    const before = (await this.remote.latestCheckpoint(this.by, this.attemptId))?.sequence ?? 0;
    await this.remote.control(this.by, this.attemptId, { kind: "checkpoint" });
    const until = Date.now() + (this.options.checkpointWaitMs ?? 30_000);
    for (;;) {
      const latest = await this.remote.latestCheckpoint(this.by, this.attemptId);
      if (latest !== undefined && latest.sequence > before) return latest.checkpoint;
      if (Date.now() >= until) throw new Error("the worker did not send a checkpoint in time");
      await new Promise((resolve) => setTimeout(resolve, this.options.pollMs ?? 100));
    }
  }
  async restart(recipe: RecipeSummary, from: JsonObject): Promise<void> { await this.remote.control(this.by, this.attemptId, { kind: "restart", recipe, checkpoint: from }); }
  async tell(text: string): Promise<void> { await this.remote.control(this.by, this.attemptId, { kind: "tell", text }); }
  async stop(): Promise<void> { await this.remote.end(this.by, this.attemptId, "the dispatcher stopped the worker", this.placement); }
}
