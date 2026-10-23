import { DomainError } from "../domain/errors.js";
import type { HostFacts } from "../catalog/index.js";
import type { Capabilities, HostService } from "../hosts/index.js";
import type { Principal } from "../security/principals.js";
import type { JsonObject } from "../storage/types.js";
import type { RecipeSummary, ToolCallRequest, ToolExecutor, ToolGateway, ToolResult, WorkerHandle, WorkerHost, WorkOrder, WorkerTurnResult } from "./ports.js";

/** An isolation session for one attempt (card A03's launcher, behind a port): the host opens one with the recipe the dispatcher stated and closes it when the attempt ends or the recipe changes. */
export interface SandboxSession { readonly revision: string; close(): Promise<void> }
export interface SandboxPort {
  /** Opens the sandbox for a recipe. It refuses (throws) when this host has no confinement: nothing ever runs unconfined as a fallback. */
  open(recipe: RecipeSummary, order: WorkOrder): Promise<SandboxSession>;
}

/** What the attempt's conversation runtime (the harness: the Pi adapter) does for the worker. */
export interface AttemptRuntime {
  /** Runs the turn. Every tool the model calls must be made through `call`. */
  run(content: string, requestId: string): Promise<WorkerTurnResult>;
  checkpoint(): Promise<JsonObject>;
  tell?(text: string): Promise<void>;
  /** Puts the owner's current decisions in front of the agent (after a call was refused because they changed). */
  refreshContext?(): Promise<void>;
  close(): Promise<void>;
}
export type BoundCall = (request: ToolCallRequest, executor: ToolExecutor) => Promise<ToolResult>;
export interface RuntimeFactory {
  /** Opens the runtime for an attempt. `from` is a checkpoint to continue from (a restart, a resumed attempt); `call` is the one way a tool reaches the world. */
  open(order: WorkOrder, call: BoundCall, from: JsonObject | undefined): Promise<AttemptRuntime>;
}

export interface LocalWorkerOptions {
  readonly hostId: string;
  readonly resources: { readonly cpus: number; readonly memoryMb: number };
  readonly version: string;
  readonly sandbox: SandboxPort;
  readonly runtimes: RuntimeFactory;
  /** What this host states about itself when it registers: its own facts, never a caller's. */
  readonly capabilities: () => Capabilities;
  /** Beats the attempt's lease while a turn runs, from a scheduler the composer injects (a timer in production, a test's own tick). Returns a function that stops it. Without it the runtime calls `gateway.heartbeat` itself. */
  readonly schedule?: (beat: () => Promise<void>) => () => void;
}

/**
 * The local worker runtime (card H12): this machine's worker host. It registers with the controller from its own facts and beats, opens one sandbox and one conversation runtime per attempt through the
 * ports, runs the turn with every tool call going through the gateway the dispatcher bound to the attempt, keeps the attempt's lease beating while the turn runs, and restarts the sandbox from a
 * checkpoint when the dispatcher changes the recipe. It implements the dispatch contract (`WorkerHost`) a remote worker (H02) implements too.
 */
export class LocalWorker implements WorkerHost {
  readonly hostId: string;
  readonly resources: { readonly cpus: number; readonly memoryMb: number };
  readonly #options: LocalWorkerOptions;
  #sequence = 0;
  #beat = 0;

  constructor(options: LocalWorkerOptions) {
    this.hostId = options.hostId;
    this.resources = options.resources;
    this.#options = options;
  }

  /** Announces this host's capabilities (from its own facts) under its own credential, and beats once. */
  async register(hosts: Pick<HostService, "announce" | "heartbeat">, self: Principal): Promise<void> {
    if (self.id !== this.hostId || self.kind !== "host") throw new DomainError("forbidden", `${self.id} is not ${this.hostId}; a worker registers as itself`);
    await hosts.announce(self, { commandId: `register:${this.hostId}:${++this.#sequence}`, capabilities: this.#options.capabilities() });
    await this.beat(hosts, self);
  }

  /** One heartbeat of the host (the controller stamps it with its own time). */
  async beat(hosts: Pick<HostService, "heartbeat">, self: Principal): Promise<void> {
    await hosts.heartbeat(self, { commandId: `beat:${this.hostId}:${this.#beat + 1}`, sequence: ++this.#beat });
  }

  async start(order: WorkOrder): Promise<WorkerHandle> {
    let sandbox = await this.#options.sandbox.open(order.recipe, order);
    let gateway: ToolGateway | undefined;
    let runtime: AttemptRuntime | undefined;
    const call: BoundCall = async (request, executor) => {
      if (gateway === undefined) throw new DomainError("fenced", "the turn has not started; a tool call needs the attempt's gateway");
      const result = await gateway.call(request, executor);
      // The owner's decisions changed: the new ones are put before the agent, then calls are allowed again (this call stays refused; the agent makes it again under a new call ID).
      if (result.state === "refused" && /decision revision changed/.test(result.reason)) {
        // Acknowledged only once the agent has been given the new context; a runtime that cannot do it leaves the calls refused.
        if (runtime?.refreshContext !== undefined) { try { await runtime.refreshContext(); await gateway.acknowledgeDecisions(); } catch { /* the calls stay refused */ } }
      }
      return result;
    };
    try { runtime = await this.#options.runtimes.open(order, call, order.resumeFrom); } catch (error) { await sandbox.close().catch(() => undefined); throw error; }
    const options = this.#options;
    return {
      workerVersion: options.version,
      run: async (g) => {
        gateway = g;
        const stop = options.schedule?.(() => g.heartbeat().then(() => undefined, () => undefined));
        try {
          const content = order.resumeNote === undefined ? order.content : `${order.content}\n\n[${order.resumeNote}]`;
          return await runtime!.run(content, order.requestId);
        } finally { stop?.(); }
      },
      checkpoint: () => runtime!.checkpoint(),
      restart: async (recipe, from) => {
        await runtime!.close();
        await sandbox.close();
        sandbox = await options.sandbox.open(recipe, order);
        runtime = await options.runtimes.open({ ...order, recipe }, call, from);
      },
      tell: async (text) => { await runtime!.tell?.(text); },
      stop: async () => { await runtime!.close().catch(() => undefined); await sandbox.close().catch(() => undefined); },
    };
  }
}

/**
 * The facts the tool catalogue (T01) is given for this host, taken from what the host announced when it registered and from the capacity the owner declared for it: never from the caller that asks.
 * A tool entry written `name@version` counts as an interpreter or package the host has; others are ignored. A host that has not announced has no facts (`undefined`).
 */
export function catalogFacts(announced: Capabilities | undefined, capacity: { cpus: number; memoryMb: number } | undefined): HostFacts | undefined {
  if (announced === undefined || capacity === undefined) return undefined;
  if (!(announced.os === "linux" || announced.os === "darwin" || announced.os === "win32") || !(announced.arch === "x64" || announced.arch === "arm64")) return undefined;
  const interpreters: Record<string, string> = {};
  const packages: Record<string, string> = {};
  for (const tool of announced.tools) {
    const at = tool.indexOf("@");
    if (at <= 0) continue;
    (tool.startsWith("pkg:") ? packages : interpreters)[tool.startsWith("pkg:") ? tool.slice(4, at) : tool.slice(0, at)] = tool.slice(at + 1);
  }
  return { os: announced.os, arch: announced.arch, interpreters, packages, cpus: capacity.cpus, memoryMb: capacity.memoryMb };
}
