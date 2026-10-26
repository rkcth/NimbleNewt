import { DomainError } from "../domain/errors.js";
import type { JsonObject } from "../storage/types.js";

/**
 * The records of the dispatcher (card H12). A dispatch record is the controller's claim on one attempt: who runs it, on which host, under which route, harness, policy, decision and environment
 * revisions, with a lease that the worker's heartbeats extend. A tool operation is the durable record of one tool call.
 */

export const DISPATCH_KIND = "dispatch";
export const operationKind = (attemptId: string): string => `tool-op-${attemptId}`;

/** `parked`: every call the agent still has to make waits for an approval, the turn ended, and the attempt gave its place back; it goes on (from the checkpoint, in a new run of the same attempt) when a decision comes. */
export type DispatchState = "waiting" | "running" | "parked" | "finished";

/** What the attempt ran under, recorded when it was admitted so a later change is visible as a change (card H12: "the attempt records harness, model route, policy, decision and environment revisions, worker version and expiry"). */
export interface DispatchRevisions {
  /** The routing table's revision the route was chosen under (R01), and the difficulty profiles' (R03). Absent when the route came from a resolver that has none. */
  readonly routing?: number;
  readonly profiles?: number;
  /** The approval policy in force: the installation's revision and the project's. */
  readonly policy: { readonly installation: number; readonly project?: number };
  /** The owner-decision context's version (C08) for the task. */
  readonly decisions: number;
  /** The agent's environment revision pinned for the attempt (A08). Absent when the agent has no environment. */
  readonly environment?: number;
  /** The task contract's version. */
  readonly contract: number;
}

export interface Frozen { readonly reason: string; readonly at: string }

export interface DispatchBody {
  readonly attemptId: string;
  readonly taskId: string;
  readonly projectId: string;
  /** The agent principal (`agent:<id>`). */
  readonly agentId: string;
  readonly generation: number;
  readonly state: DispatchState;
  /** Absent for a task that needs no recovery and whose profile names none. */
  readonly harness?: string;
  /** The model route (`provider/model`) chosen by the route resolver, and the role and routing profile it was chosen for (kept to judge the route again at each call). */
  readonly route: string;
  readonly role: string;
  readonly request: { readonly contextTokens: number; readonly needs: readonly string[]; readonly data: "local-only" | "cloud-allowed"; readonly paidAuthorized: boolean };
  readonly revisions: DispatchRevisions;
  readonly hostId: string;
  /** The attempt may start only on this host (card H02: it was relocated there, or parked on the host that owns its native store). Cleared when it starts. */
  readonly pinnedHost?: string;
  /** The H03 request that holds the attempt's place (absent while the attempt holds none, and before the first request), and how many requests were made for it. */
  readonly requestId?: string;
  readonly requests?: number;
  readonly claimedAt: string;
  /** After this time the attempt is over whatever the worker says (the attempt's own expiry). */
  readonly expiresAt: string;
  readonly startedAt?: string;
  readonly workerVersion?: string;
  readonly credentialId?: string;
  /** The worker's lease: it must be extended by a heartbeat before `until`, or the attempt is taken as lost. */
  readonly lease?: { readonly holder: string; readonly until: string };
  readonly heartbeats: number;
  readonly lastHeartbeatAt?: string;
  readonly frozen?: Frozen;
  /** For a parked or resuming attempt: the conversation checkpoint to continue from, and what to tell the agent when it does. */
  readonly resumeFrom?: JsonObject;
  readonly resumeNote?: string;
  /** Operations a resume has been made for (bounded): a decision resumes the attempt once. */
  readonly resumedFor?: readonly string[];
  /** Calls started and not yet settled (at most `DISPATCH_LIMITS.inFlight`), and calls waiting for an approval (at most `DISPATCH_LIMITS.parked`). */
  /** The budget reservation held for the attempt (card R05b), and what it has used so far; settled to the use when the attempt ends, held as uncertain when the worker was lost. */
  readonly reservationId?: string;
  readonly used?: { readonly costMicros: number; readonly computeMs: number };
  /** What the attempt meant to hold, written before the reservation is asked for, so a repeat after a crash asks for exactly the same amounts. */
  readonly reserving?: { readonly costMicros?: number; readonly computeMs?: number };
  /** The usage reports already added to `used` (the last 200, by key and a digest of the report): a resent report adds nothing, a different one under the same key is refused. */
  readonly usedKeys?: readonly { readonly key: string; readonly digest: string }[];
  readonly inFlight: readonly string[];
  readonly parked: readonly string[];
  /** Calls recorded for the attempt, all states. */
  readonly calls: number;
  /** The conversation checkpoint reference taken when the attempt ended or was reconfigured. */
  readonly recipeRevision?: string;
  /** Set when a turn's usage figures could not be charged to accounting: why (redacted). */
  readonly usageError?: string;
  readonly outcome?: { readonly status: "succeeded" | "failed" | "abandoned"; readonly summary: string; readonly at: string };
}

export type OperationState = "awaiting-approval" | "in-progress" | "confirmed" | "failed" | "cancelled" | "uncertain" | "refused";
export const TERMINAL: ReadonlySet<OperationState> = new Set(["confirmed", "failed", "cancelled", "uncertain", "refused"]);

export interface ToolIdentity {
  readonly name: string;
  /** The exact version of the tool (its catalogue version, or the worker's own build for a built-in one). */
  readonly version: string;
  /** `catalog`: a tool from the T01 catalogue, called through the protected bridge (T06). */
  readonly kind: "builtin" | "mcp" | "catalog";
  /** For an MCP tool: the server, with the protocol and catalogue revision the call was pinned to (T03). */
  readonly server?: { readonly id: string; readonly protocolRevision?: string; readonly catalogRevision?: number; /** The T03 call record this operation is. */ readonly callId?: string };
}

export interface ToolOperationBody {
  readonly attemptId: string;
  readonly callId: string;
  readonly taskId: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly generation: number;
  readonly tool: ToolIdentity;
  /** What was asked, without the payload: a digest of the arguments, their size, and a redacted short summary (nothing at all for a restricted tool). */
  readonly invocation: { readonly argsDigest: string; readonly bytes: number; readonly summary: string; readonly restricted: boolean };
  /** Whether the call only looks (the catalogue puts its tool in the `inspect` class). Judged by the controller, never by the worker's say-so. */
  readonly readOnly: boolean;
  /** The controller-approved manifest of the tool version says a restart may run the call again from the start (card T06). Set by the controller from the catalogue, never by the worker. */
  readonly replaySafe?: boolean;
  readonly state: OperationState;
  readonly startedAt: string;
  readonly endedAt?: string;
  /** Why it was refused, or what went wrong, in words (redacted, short). */
  readonly diagnostics: readonly string[];
  /** What the call used: the time it took by the controller's clock, and the bytes of output; plus what the executor measured. */
  readonly usage?: { readonly durationMs: number; readonly outputBytes: number; readonly cpuMs?: number; readonly memoryMb?: number };
  /** The decision the policy gave, kept so a reader can see why it ran or waited. */
  readonly decision?: { readonly mode: string; readonly via: string; readonly reasons: readonly string[] };
  readonly effectId?: string;
  readonly reviewId?: string;
  /** When the policy sent the call to the owner (not to an agent reviewer), only the owner's approval counts for it. */
  readonly ownerOnly?: boolean;
  /** A short redacted summary of what came back. */
  readonly resultSummary?: string;
  /** The revisions the call was judged under. */
  readonly judgedAt: { readonly policy: { readonly installation: number; readonly project?: number }; readonly decisions: number };
}

export const DISPATCH_LIMITS = { inFlight: 32, parked: 20, summary: 300, diagnostic: 300, diagnostics: 10, name: 80, version: 80, callId: 120, leaseMs: 60_000, attemptMs: 4 * 60 * 60_000, maxAttempts: 3, scanPage: 100, resultSummary: 300 } as const;
export const DISPATCHER_ACTOR = "dispatcher";

const TOOL_NAME = /^[a-z][a-z0-9-]{0,39}(?:\.[a-z0-9-]{1,39})?$/;
const CALL_ID = /^[A-Za-z0-9._:-]{1,120}$/;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };

export const checkToolName = (value: unknown, field = "tool.name"): string => (typeof value === "string" && TOOL_NAME.test(value) ? value : invalid(field, "must be a tool name: lower-case words joined by hyphens (so that tool.<name> is an action)"));
export const checkCallId = (value: unknown): string => (typeof value === "string" && CALL_ID.test(value) ? value : invalid("callId", "must be 1 to 120 letters, digits or . _ : -"));

/** A bounded, JSON-safe copy of a value for a record: strings are cut, depth and width are bounded. */
export function boundedJson(value: unknown, depth = 0): JsonObject[string] {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value as never;
  if (typeof value === "string") return value.length > 200 ? `${value.slice(0, 200)}...` : value;
  if (depth >= 3) return "[...]";
  if (Array.isArray(value)) return value.slice(0, 10).map((v) => boundedJson(v, depth + 1)) as never;
  if (typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 10).map(([k, v]) => [k, boundedJson(v, depth + 1)])) as never;
  return null;
}
