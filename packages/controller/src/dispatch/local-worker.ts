import { DomainError } from "../domain/errors.js";
import type { HostFacts } from "../catalog/index.js";
import type { FirstCall } from "../context/dispatch.js";
import type { Capabilities, HostService } from "../hosts/index.js";
import type { Principal } from "../security/principals.js";
import type { JsonObject } from "../storage/types.js";
import type { RecipeSummary, ToolCallRequest, ToolExecutor, ToolGateway, ToolResult, TurnUsage, WorkerHandle, WorkerHost, WorkOrder, WorkerTurnResult } from "./ports.js";

/** An isolation session for one attempt (card A03's launcher, behind a port): the host opens one with the recipe the dispatcher stated and closes it when the attempt ends or the recipe changes. */
export interface SandboxSession { readonly revision: string; close(): Promise<void> }
export interface SandboxPort {
  /** Opens the sandbox for a recipe. It refuses (throws) when this host has no confinement: nothing ever runs unconfined as a fallback. */
  open(recipe: RecipeSummary, order: WorkOrder): Promise<SandboxSession>;
}

/** What the attempt's conversation runtime (the harness: the Pi adapter) does for the worker. */
export interface AttemptRuntime {
  /** What the first call for `content` will carry, for the admission check (C07b). A runtime that cannot tell is not checked. */
  firstCall?(content: string): FirstCall | undefined;
  /** Makes the conversation smaller (a summary of its older part). Used once when the first call is refused for size. */
  compact?(): Promise<void>;
  /** Runs the turn. Every tool the model calls must be made through `call`. */
  run(content: string, requestId: string): Promise<WorkerTurnResult>;
  checkpoint(): Promise<JsonObject>;
  tell?(text: string): Promise<void>;
  /** Puts the owner's current decisions in front of the agent (after a call was refused because they changed). */
  refreshContext?(): Promise<void>;
  /** Model calls started and not yet finished (a streaming answer is one). A paused attempt is not claimed paused, and advice is not delivered, while one is open. Absent: none is known. */
  activeModelCalls?(): number;
  close(): Promise<void>;
}
/** Two reports of one turn (the part cut short by a restart and the rest) as one: the same turn number, the cache figures added when they are about the same route. */
function mergeUsage(a: TurnUsage | undefined, b: TurnUsage | undefined): TurnUsage | undefined {
  if (a === undefined || b === undefined) return b ?? a;
  const sameRoute = a.cache !== undefined && b.cache !== undefined && a.cache.backend === b.cache.backend && a.cache.route === b.cache.route;
  const cache = sameRoute ? { ...b.cache!, cachedTokens: a.cache!.cachedTokens + b.cache!.cachedTokens, computedTokens: a.cache!.computedTokens + b.cache!.computedTokens, writtenTokens: a.cache!.writtenTokens + b.cache!.writtenTokens } : (b.cache ?? a.cache);
  const sum = (x: number | undefined, y: number | undefined): number | undefined => (x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0));
  const costMicros = sum(a.costMicros, b.costMicros), computeMs = sum(a.computeMs, b.computeMs);
  return { ...(b.turnSeq === undefined ? (a.turnSeq === undefined ? {} : { turnSeq: a.turnSeq }) : { turnSeq: b.turnSeq }), ...(costMicros === undefined ? {} : { costMicros }), ...(computeMs === undefined ? {} : { computeMs }), ...(cache === undefined ? {} : { cache }) };
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
  /** Whether the host's runtime applies the owner's limits, best-effort setting and launch record (the worker package's `localWorkerParts(...).ownerPolicy`). */
  readonly ownerPolicy?: boolean;
  readonly sandbox: SandboxPort;
  readonly runtimes: RuntimeFactory;
  /** What this host states about itself when it registers: its own facts, never a caller's. */
  readonly capabilities: () => Capabilities;
  /** Beats the attempt's lease while a turn runs, from a scheduler the composer injects (a timer in production, a test's own tick). Returns a function that stops it. Without it the runtime calls `gateway.heartbeat` itself. */
  readonly schedule?: (beat: () => Promise<void>) => () => void;
  /** What the runtime asks the controller's services while it runs (card H12f). Absent: none of it happens. */
  readonly guards?: RuntimeGuards;
  /** Told when a guard fails (the attempt goes on; a guard never silently stops working). */
  readonly onGuardError?: (attemptId: string, what: string, error: unknown) => void;
}

/** A message the controller has for the running agent, already judged eligible for the boundary by the message service (U12). */
export interface DeliverableMessage { readonly id: string; readonly text: string }
export type MessageBoundaryName = "interrupt" | "safe-boundary";

/**
 * The controller's services as the local worker sees them (card H12f), as plain functions the composer binds to the services under the right principal, so the worker holds none of them:
 * context enforcement (C07b: the first call is admitted or refused; a stored conversation over the resume share is not resumed), pause observation (L01: a paused attempt is reported
 * `pausing` while a call is in flight and `paused` only once its calls have settled) and the message boundaries (U12: an interrupt, and advice at a safe boundary).
 */
export interface RuntimeGuards {
  readonly context?: {
    /** `retry`: the runtime will make the call smaller and ask again as the next round, so a refusal now opens no blocker (the refusal of that round does). */
    admit(order: WorkOrder, call: FirstCall, round: number, retry?: boolean): Promise<{ readonly admit: boolean; readonly reasons: readonly string[] }>;
    /** The first call went out and the provider reported its input size (card C07b): recorded against the admission, which calibrates the estimate for the route. */
    confirm?(order: WorkOrder, usage: { readonly reportedInputTokens: number; readonly promptChars: number }): Promise<void>;
    resume(order: WorkOrder, storedTokens: number): Promise<{ readonly resume: boolean; readonly reason: string }>;
    /** The size of the conversation a checkpoint holds, in tokens, when it says. */
    storedTokens?(from: JsonObject): number | undefined;
  };
  readonly pause?: {
    isPaused(order: WorkOrder): Promise<boolean>;
    observe(order: WorkOrder, state: "pausing" | "paused", boundary?: "finished"): Promise<void>;
  };
  readonly messages?: {
    readable(order: WorkOrder, boundary: MessageBoundaryName): Promise<readonly DeliverableMessage[]>;
    /** Confirms the messages were put before the agent. Returns the IDs the service did not mark delivered (it refused them; they stay queued). */
    acknowledge(order: WorkOrder, boundary: MessageBoundaryName, ids: readonly string[]): Promise<readonly string[]>;
  };
}

/**
 * The local worker runtime (card H12): this machine's worker host. It registers with the controller from its own facts and beats, opens one sandbox and one conversation runtime per attempt through the
 * ports, runs the turn with every tool call going through the gateway the dispatcher bound to the attempt, keeps the attempt's lease beating while the turn runs, and restarts the sandbox from a
 * checkpoint when the dispatcher changes the recipe. It implements the dispatch contract (`WorkerHost`) a remote worker (H02) implements too.
 */
export class LocalWorker implements WorkerHost {
  readonly hostId: string;
  readonly resources: { readonly cpus: number; readonly memoryMb: number };
  readonly ownerPolicy: boolean;
  readonly #options: LocalWorkerOptions;
  #sequence = 0;
  #beat = 0;

  constructor(options: LocalWorkerOptions) {
    this.hostId = options.hostId;
    this.resources = options.resources;
    this.ownerPolicy = options.ownerPolicy === true;
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
    const options = this.#options;
    const guards = options.guards;
    const report = (what: string, error: unknown): void => { try { options.onGuardError?.(order.attemptId, what, error); } catch { /* the report must not stop the attempt */ } };
    // A stored conversation over the resume share is not continued: the attempt starts fresh, and the agent is told why (C07b).
    let from = order.resumeFrom;
    let note = order.resumeNote;
    if (from !== undefined && guards?.context?.storedTokens !== undefined) {
      try {
        const stored = guards.context.storedTokens(from);
        if (stored !== undefined) {
          const decision = await guards.context.resume(order, stored);
          if (!decision.resume) { from = undefined; note = note === undefined ? decision.reason : `${note}\n${decision.reason}`; }
        }
      } catch (error) {
        // The size of the stored conversation could not be judged: it is not continued (a fresh start from the continuation record is the safe side).
        report("resume decision", error);
        from = undefined;
        note = note === undefined ? "the stored conversation could not be checked against the context budget; starting fresh" : `${note}\nthe stored conversation could not be checked against the context budget; starting fresh`;
      }
    }
    const content = note === undefined ? order.content : `${order.content}\n\n[${note}]`;
    let sandbox = await options.sandbox.open(order.recipe, order);
    let gateway: ToolGateway | undefined;
    let runtime: AttemptRuntime | undefined;
    let inFlight = 0;
    let generation = 0;
    let restarting: Promise<void> | undefined;
    let restartFailed = false;
    const call: BoundCall = async (request, executor) => {
      if (gateway === undefined) throw new DomainError("fenced", "the turn has not started; a tool call needs the attempt's gateway");
      inFlight++;
      let result: ToolResult;
      try { result = await gateway.call(request, executor); } finally { inFlight--; }
      // The owner's decisions changed: the new ones are put before the agent, then calls are allowed again (this call stays refused; the agent makes it again under a new call ID).
      if (result.state === "refused" && /decision revision changed/.test(result.reason)) {
        // Acknowledged only once the agent has been given the new context; a runtime that cannot do it leaves the calls refused.
        if (runtime?.refreshContext !== undefined) { try { await runtime.refreshContext(); await gateway.acknowledgeDecisions(); } catch { /* the calls stay refused */ } }
      }
      return result;
    };
    try { runtime = await options.runtimes.open(order, call, from); } catch (error) { await sandbox.close().catch(() => undefined); throw error; }

    // The first call is admitted or refused before anything is sent (C07b). A refused one is made smaller once, if the runtime can, and asked again.
    let round = 0;
    const admitFirst = async (rt: AttemptRuntime, text: string): Promise<string | undefined> => {
      if (guards?.context === undefined || rt.firstCall === undefined) return undefined;
      let refusal: string | undefined;
      try {
        for (let pass = 1; pass <= 2; pass++) {
          const first = rt.firstCall(text);
          if (first === undefined) return undefined;
          const compactable = pass === 1 && rt.compact !== undefined;
          const decision = await guards.context.admit(order, first, ++round, compactable);
          if (decision.admit) return undefined;
          refusal = decision.reasons.join("; ") || "the first call is over the context budget";
          if (!compactable) break;
          // A compaction that fails is not the end of the road: the second round asks about the unchanged call, is refused, and opens the blocker.
          try { await rt.compact!(); } catch (error) { report("compaction", error); }
        }
      } catch (error) { refusal = `the context check failed: ${String((error as Error)?.message ?? error).slice(0, 300)}`; report("context admission", error); }
      return refusal;
    };
    const refusal = await admitFirst(runtime, content);
    if (refusal !== undefined) {
      await runtime.close().catch(() => undefined);
      await sandbox.close().catch(() => undefined);
      return {
        workerVersion: options.version,
        run: async () => ({ status: "failed", error: `the first call was not sent: ${refusal}` }),
        checkpoint: async () => from ?? {},
        restart: async () => { throw new DomainError("fenced", "the attempt was refused at start"); },
        stop: async () => undefined,
      };
    }

    // While the turn runs, on each beat: the pause gates are observed and messages for the agent are delivered (L01, U12). One pass at a time: a slow service must not make two passes read the same batch.
    let reported: "pausing" | "paused" | undefined;
    const told = new Set<string>();
    let pass: Promise<void> = Promise.resolve();
    const watch = (deliver: boolean): Promise<void> => {
      pass = pass.then(() => observeAndDeliver(deliver), () => observeAndDeliver(deliver));
      return pass;
    };
    // Tool calls through the gateway and model calls the runtime has open both count: either one is work still in flight.
    const busy = (): number => inFlight + (runtime?.activeModelCalls?.() ?? 0);
    const observeAndDeliver = async (deliver: boolean): Promise<void> => {
      if (guards === undefined || runtime === undefined) return;
      let paused = false;
      if (guards.pause !== undefined) {
        try {
          paused = await guards.pause.isPaused(order);
          if (paused) {
            // Paused is claimed only when no call is in flight; until then the honest state is pausing.
            const state = busy() === 0 ? "paused" : "pausing";
            if (state !== reported) { await guards.pause.observe(order, state, state === "paused" ? "finished" : undefined); reported = state; }
          } else reported = undefined;
        } catch (error) { report("pause observation", error); }
      }
      // Nothing is delivered to a paused attempt, or after the turn: a message told then would be marked delivered and never acted on. An interrupt reaches a running attempt at once, advice only when no call is in flight.
      if (!deliver || paused || guards.messages === undefined || runtime.tell === undefined) return;
      for (const boundary of (busy() === 0 ? ["interrupt", "safe-boundary"] : ["interrupt"]) as MessageBoundaryName[]) {
        try {
          const items = await guards.messages.readable(order, boundary);
          if (items.length === 0) continue;
          // What was already told (an acknowledgement that failed or was refused) is not told again; only the acknowledgement is tried again.
          const fresh = items.filter((m) => !told.has(m.id));
          if (fresh.length > 0) { await runtime.tell(fresh.map((m) => m.text).join("\n\n")); for (const m of fresh) told.add(m.id); }
          const refused = await guards.messages.acknowledge(order, boundary, items.map((m) => m.id));
          for (const m of items) if (!refused.includes(m.id)) told.delete(m.id);
          if (refused.length > 0) report(`message delivery (${boundary})`, new Error(`the message service did not mark ${refused.length} message(s) delivered`));
        } catch (error) { report(`message delivery (${boundary})`, error); }
      }
    };

    return {
      workerVersion: options.version,
      run: async (g) => {
        gateway = g;
        const stop = options.schedule?.(async () => { await g.heartbeat().then(() => undefined, () => undefined); await watch(true); });
        try {
          let carried: TurnUsage | undefined;
          for (;;) {
            const at = generation;
            const result = await runtime!.run(content, order.requestId);
            // A recipe change ends the process the turn was running in on purpose (card H12b): the restart is waited for, and a turn cut short by it goes on in the new process under the same request ID, from the conversation the checkpoint kept.
            if (restarting !== undefined) await restarting.catch(() => undefined);
            if (generation === at || restartFailed || result.status === "completed") { const usage = mergeUsage(carried, result.usage); return carried === undefined || usage === undefined ? result : { ...result, usage }; }
            carried = mergeUsage(carried, result.usage);
          }
        } finally {
          stop?.();
          // A turn that ended while the attempt is paused is reported as paused (its calls have settled); nothing is delivered after the turn.
          await watch(false);
        }
      },
      checkpoint: () => runtime!.checkpoint(),
      restart: async (recipe, resumeFrom) => {
        generation++;
        const done = (async () => {
          await runtime!.close();
          await sandbox.close();
          sandbox = await options.sandbox.open(recipe, order);
          // The conversation continues from a checkpoint just taken from the same attempt; the new process has told nothing yet.
          reported = undefined;
          runtime = await options.runtimes.open({ ...order, recipe }, call, resumeFrom);
          // The new process takes the whole stored conversation into its next call: it is admitted again (and compacted once if it must be), and a refusal leaves the attempt frozen (the dispatcher keeps it so).
          const again = await admitFirst(runtime, "");
          if (again !== undefined) throw new DomainError("unavailable", `the restarted sandbox's first call was not sent: ${again}`);
        })();
        restarting = done;
        try { await done; restartFailed = false; } catch (error) { restartFailed = true; throw error; } finally { if (restarting === done) restarting = undefined; }
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
