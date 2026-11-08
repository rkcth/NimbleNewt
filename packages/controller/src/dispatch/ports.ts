import type { WorkspacePort } from "../workspace-ops/workspace-ops.js";
import type { EffectBridge } from "../domain/effects.js";
import type { JsonObject } from "../storage/types.js";

/**
 * The dispatch contract (card H12). The dispatcher hands a worker host one `WorkOrder` and gets back a `WorkerHandle`; every tool call the worker makes goes through the `ToolGateway` it is given.
 * A local worker (this machine's sandbox and Pi) and a remote worker (H02) implement the same two interfaces: the order, the call request and the call result are plain JSON, so they can cross a
 * wire, and the only thing that cannot cross it is the executor of a local call, which the remote worker keeps on its side and reports through `report`.
 */

/** What the sandbox recipe is, as the dispatcher states it. The worker host turns it into a real recipe (A03); the revision is what the audit names. */
export interface RecipeSummary {
  /** The digest of the recipe the host will launch (A03: the digest of its normalised form). */
  readonly revision: string;
  /** The tools and servers the sandbox lets the agent reach. Changing it is a change of recipe. */
  readonly reach: readonly string[];
  /** What the sandbox may use (cpus, memoryMb, diskMb, processes). Present: these replace the host's default limits for this launch, narrower or wider. Changing them is a change of recipe. */
  readonly limits?: { readonly cpus?: number; readonly memoryMb?: number; readonly diskMb?: number; readonly processes?: number };
}

/** The limits the owner set for an agent's worker (card H12k); each is a whole number inside the bounds of `LOCAL_WORKER_LIMIT_BOUNDS`. */
export interface ContractLimits { readonly cpus?: number; readonly memoryMb?: number; readonly diskMb?: number; readonly processes?: number; readonly wallTimeMs?: number }

/**
 * The dispatch contract of one attempt as it travels to a worker (card H12a): the task contract's ceiling and budget, the owner's limits and best-effort setting as they stood at the launch, and what the worker must itself
 * enforce. The digest binds it to the order (attempt, generation, route, recipe, expiry), so a worker confirms exactly what it was given and the controller can tell. Plain JSON.
 */
export interface DispatchContract {
  /** The wire format of this object; a worker that does not speak it refuses the order. */
  readonly format: number;
  /** The version of the task's contract this was read from. */
  readonly taskContractVersion: number;
  /** The task contract's permission ceiling (`tool.<name>`, `class.<class>`); the controller judges every call against it, the worker only shows it to the agent. */
  readonly permissions: readonly string[];
  readonly budget?: { readonly maxMinutes?: number; readonly maxAttempts?: number; readonly maxCost?: number; readonly held?: { readonly costMicros?: number; readonly computeMs?: number } };
  /** The owner's limits for this launch (absent: none were set). A worker that cannot hold them in full refuses, unless `bestEffort`. */
  readonly limits?: ContractLimits;
  readonly bestEffort: boolean;
  /** What the worker must enforce itself (`limits`, `wall-time`); a worker that does not know a name in it refuses the order. */
  readonly requires: readonly string[];
  /** SHA-256 over the contract and the order's identity, recipe and expiry (`contractDigest`). */
  readonly digest: string;
}

export interface WorkOrder {
  readonly attemptId: string;
  readonly taskId: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly generation: number;
  readonly harness?: string;
  /** The model route the harness must use (`provider/model`). */
  readonly route: string;
  /** The task credential: shown here once, kept by nobody else. The worker uses it for the controller's state API; the controller does not need it for calls through the gateway. */
  readonly credential: string;
  readonly recipe: RecipeSummary;
  /** The text of the task and the request ID of the turn: the same attempt always names the same request, so a restart finds the original. */
  readonly content: string;
  readonly requestId: string;
  /** The attempt is over at this time whatever the worker does. Absent: no time limit was set. */
  readonly expiresAt?: string;
  /** The attempt's lease as a duration in ms (card H08b): how long the controller holds it without a heartbeat. A worker counts it on its own monotonic clock, never against the controller's `until`. */
  readonly leaseMs?: number;
  /** Set when the attempt resumes earlier work: the conversation checkpoint to continue from. */
  readonly resumeFrom?: JsonObject;
  /** Set when the attempt resumes after calls waited for an approval: what to tell the agent (which calls were approved, denied or ran out). */
  readonly resumeNote?: string;
  /** The dispatch contract (card H12a). A remote worker confirms it before its first tool call; a local host applies the same figures through its own builder. */
  readonly contract?: DispatchContract;
}

export interface WorkerTurnResult {
  readonly status: "completed" | "failed" | "cancelled";
  readonly text?: string;
  readonly error?: string;
  /** The conversation checkpoint at the end of the turn (opaque to the controller). */
  readonly checkpoint?: JsonObject;
  /** Model usage of the turn, for budget accounting. */
  readonly usage?: TurnUsage;
}

export interface TurnUsage {
  /** The worker's own sequence number of the turn this report is for. When present it is the idempotency key: a report sent again (a retry) is charged once. */
  readonly turnSeq?: number;
  readonly costMicros?: number; readonly computeMs?: number; readonly cache?: { readonly backend: string; readonly route: string; readonly cachedTokens: number; readonly computedTokens: number; readonly writtenTokens: number } }

export interface WorkerHandle {
  /** The version of the worker software that runs the attempt (recorded on the attempt). */
  readonly workerVersion: string;
  /**
   * A name for this turn's result that is the same in every controller process (a remote placement: `result:<attempt>:<placement>`), so figures the turn reports are charged once even when a new primary takes the attempt
   * over and takes the same stored result after the old one had charged it (card H09b). Absent: the turn's figures are keyed per process (a local worker's turn cannot be taken over).
   */
  readonly resultKey?: string;
  /** Runs the turn. Every tool call goes through `gateway`. Resolves with the turn's result; rejects only when the worker itself broke. */
  run(gateway: ToolGateway): Promise<WorkerTurnResult>;
  /** Takes a conversation checkpoint at a safe boundary (after the in-flight calls have settled). */
  checkpoint(): Promise<JsonObject>;
  /** Restarts the sandbox with another recipe, continuing the conversation from `from` (a checkpoint taken by `checkpoint`). The conversation context survives. */
  restart(recipe: RecipeSummary, from: JsonObject): Promise<void>;
  /** Tells the agent something (a recipe was widened, an approval arrived). Optional. */
  tell?(text: string): Promise<void>;
  /** Ends the worker: kills the sandbox and everything in it. Safe to repeat. */
  stop(): Promise<void>;
}

/** What the dispatcher knows of an attempt before its order exists: enough for a host to say whether it would take it (card H07e). */
export interface HostProbe { readonly attemptId: string; readonly taskId: string; readonly projectId: string; readonly agentId: string; readonly generation: number; readonly harness?: string; readonly route: string; readonly expiresAt?: string }

export interface HostLocalWork {
  readonly processes: readonly { readonly attemptId?: string; readonly ref: string; readonly kind: "process" | "child"; readonly state: "running" | "uncooperative" | "unknown" }[];
  readonly costs?: readonly { readonly attemptId: string; readonly costMicros?: number; readonly computeMs?: number }[];
  /** The attempts this host has a record of. An asked attempt that is live in the dispatcher's records but not named here is one the host has forgotten (a restart): the stop reads that as unknown, not as nothing running. Absent: the host answers for every attempt asked. */
  readonly known?: readonly string[];
}

export interface WorkerHost {
  /** The host principal (`host:<name>`) this worker runs on: its place is asked of admission under this name. */
  readonly hostId: string;
  /** What one attempt asks of the host, for admission (H03). */
  readonly resources: { readonly cpus: number; readonly memoryMb: number };
  /** True when this host applies the owner's limits, best-effort setting and launch record (the host builder connected `currentLimits`, `bestEffortAllowed` and `recordLaunch`). A local host that does not say so is refused at start (card H12k). */
  readonly ownerPolicy?: boolean;
  start(order: WorkOrder): Promise<WorkerHandle>;
  /** Ends whatever this host still holds for an attempt that ended while this process had no handle for it (the controller restarted since the worker was placed). Without it a placement that outlived its controller would hold the agent's store for ever. Nothing held: nothing happens. */
  release?(attemptId: string, reason: string, signal?: AbortSignal): Promise<void>;
  /**
   * A new primary takes over an attempt another controller started on this host (card H09b): a handle on the run the host still holds (one that has already sent its result answers with it at once), or `undefined` when
   * the host holds no live run of it any more (ended, moved, or only offered: an offer dies with the controller that made it). A host that does not have it (a local host: its runs die with their controller) is never asked.
   */
  adopt?(attemptId: string): Promise<WorkerHandle | undefined>;
  /**
   * Why this host would refuse the attempt (policy, capabilities, connection), asked before a place is requested so that the dispatcher can pass over a host that would refuse and pick the next one. Empty: it would take it. A host
   * that does not say leaves it out and is judged only when the worker starts (card H07e).
   */
  refuses?(probe: HostProbe): Promise<{ readonly reasons: readonly string[]; /** False when every reason is a passing condition (not connected, not heard from lately): the attempt just waits and the owner is not told. */ readonly lasting: boolean }>;
  /**
   * What this host still holds for these attempts, for Stop (card L02d): the local processes and child work they started (running, asked to stop and not stopped, or of unknown state), and what the cleanup after the stop has
   * cost so far, as a running total per attempt (the controller charges only what it has not charged yet). A host that cannot say leaves it out, and nothing is claimed about what is not known. It answers only for attempts it knows and
   * throws when it cannot look (the stop then shows one unknown item instead of a clean stop).
   */
  localWork?(attemptIds: readonly string[]): Promise<HostLocalWork>;
  /** The host's side of integration, landing, checkout refresh and quarantine for the checkouts it holds (cards H12l, H12m). A host with none leaves it out and those requests are refused for it. */
  readonly workspace?: WorkspacePort;
}

// ---- tool calls -----------------------------------------------------------------------------------------------------------

export interface ToolCallRequest {
  /** The worker's own ID for the call, unique within the attempt: asking again with it is the same call. */
  readonly callId: string;
  readonly tool: { readonly name: string; readonly version: string; readonly kind?: "builtin" | "mcp" | "catalog"; readonly server?: string };
  readonly args: JsonObject;
  /** The payload must not appear in any summary (a secret-bearing tool). */
  readonly restricted?: boolean;
  /** For a review: the script the call runs, and the target it acts on. */
  readonly script?: string;
  readonly target?: { readonly kind: string; readonly id: string };
  /** What the call would spend, and whether it cannot be undone and which audience it reaches: the policy decides on these (the controller never takes the agent's word for the spend already made). */
  readonly estimatedSpend?: number;
  readonly irreversible?: boolean;
  readonly branchProtected?: boolean;
  readonly audience?: string;
  readonly environment?: "development" | "testing" | "staging" | "customer-live";
}

/** How a call is carried out. A local executor runs inside the worker's sandbox; an effect goes out through the S05 ledger and its bridge, which the controller runs. */
export type ToolExecutor =
  | { readonly kind: "local"; run(signal: AbortSignal): Promise<{ readonly text: string; readonly cpuMs?: number; readonly memoryMb?: number }> }
  | { readonly kind: "effect"; readonly effectKind: string; readonly target: string; readonly input: JsonObject; readonly bridge: EffectBridge };

export type ToolResult =
  | { readonly state: "confirmed"; readonly operationId: string; readonly text: string }
  | { readonly state: "failed" | "cancelled" | "uncertain" | "refused"; readonly operationId: string; readonly reason: string }
  | { readonly state: "awaiting-approval"; readonly operationId: string; readonly reviewId: string; readonly reason: string }
  /** The call's outcome is not known yet (its target could not be reached); asking again with the same call ID tries again safely. */
  | { readonly state: "in-progress"; readonly operationId: string; readonly reason: string };

/** The gateway one attempt's worker calls. Bound to the attempt: it cannot be used for another. */
export interface ToolGateway {
  readonly attemptId: string;
  call(request: ToolCallRequest, executor: ToolExecutor): Promise<ToolResult>;
  /** The split form for a worker that cannot hand its executor over (a remote one): `begin` decides and records, the worker runs the call, `report` records how it ended. A call that needs the ledger cannot be split: use `call`. */
  begin(request: ToolCallRequest): Promise<{ readonly operationId: string; readonly run: true } | { readonly operationId: string; readonly run: false; readonly result: ToolResult }>;
  report(operationId: string, outcome: { readonly state: "confirmed" | "failed" | "cancelled" | "uncertain"; readonly text?: string; readonly error?: string; readonly cpuMs?: number; readonly memoryMb?: number }): Promise<ToolResult>;
  /** The model usage of a turn, so spending is recorded by the controller's accounting and not reported by the agent. */
  usage(usage: TurnUsage, requestKey?: string): Promise<void>;
  /** The worker is alive: extends the attempt's lease. Refused (`fenced`) once the attempt is no longer the task's current one. */
  heartbeat(): Promise<{ readonly until: string; readonly leaseMs?: number }>;
  /** The worker has put the owner's current decisions in front of the agent: calls refused for a changed decision revision are allowed again. */
  acknowledgeDecisions(): Promise<void>;
}
