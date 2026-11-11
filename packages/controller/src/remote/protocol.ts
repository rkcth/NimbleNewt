import { DomainError } from "../domain/errors.js";
import type { JsonObject } from "../storage/types.js";
import type { RecipeSummary, WorkerTurnResult } from "../dispatch/ports.js";

/**
 * The controller-worker protocol (card H02). Every message is plain JSON over an authenticated HTTP request; the dispatch contract of card H12 (`WorkOrder`, `ToolCallRequest`, `ToolResult`,
 * the split `begin`/`report` form, `WorkerTurnResult`) crosses it unchanged. The protocol has an integer version. Each side states the range it speaks when the worker connects and the highest
 * version both speak is used for the whole session; no common version is a visible refusal (recorded on the host's session record, shown to the owner, and answered with HTTP 426 naming what the
 * controller speaks), never a silent downgrade or a guess.
 */

/** What this build speaks. A new version is added to the range only when both the controller and the worker code for it; `min` rises when an old version is dropped. */
export const WORKER_PROTOCOL = { min: 1, max: 1 } as const;
export interface VersionRange { readonly min: number; readonly max: number }

export const PROTOCOL_HEADER = "x-newt-protocol";
export const SESSION_HEADER = "x-newt-session";
export const DIGEST_HEADER = "x-newt-digest";

export function checkRange(value: unknown, field: string): VersionRange {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new DomainError("invalid_command", `${field}: must be an object with min and max`, { field });
  const r = value as Record<string, unknown>;
  for (const key of Object.keys(r)) if (key !== "min" && key !== "max") throw new DomainError("invalid_command", `${field}.${key}: is not a field of a version range`, { field });
  const ok = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= 1_000_000;
  if (!ok(r["min"]) || !ok(r["max"]) || r["min"] > r["max"]) throw new DomainError("invalid_command", `${field}: min and max must be whole numbers from 1, with min at most max`, { field });
  return { min: r["min"], max: r["max"] };
}

/** The version a session will use: the highest both sides speak, or why there is none. */
export function negotiateProtocol(controller: VersionRange, worker: VersionRange): { readonly ok: true; readonly version: number } | { readonly ok: false; readonly reason: string } {
  const version = Math.min(controller.max, worker.max);
  if (version >= controller.min && version >= worker.min) return { ok: true, version };
  return { ok: false, reason: worker.max < controller.min
    ? `the worker speaks protocol ${rangeText(worker)} and the controller needs ${rangeText(controller)}: the worker is too old; upgrade it`
    : `the worker needs protocol ${rangeText(worker)} and the controller speaks ${rangeText(controller)}: the controller is too old for this worker; use an older worker or upgrade the controller` };
}
const rangeText = (r: VersionRange): string => (r.min === r.max ? String(r.min) : `${r.min} to ${r.max}`);

/** A worker whose protocol the controller cannot speak. Carries what the controller speaks so the refusal says what to do. */
export class ProtocolMismatch extends DomainError {
  constructor(message: string, readonly supported: VersionRange) { super("invalid_command", message, { field: "protocol" }); this.name = "ProtocolMismatch"; }
}

/** What the controller says (and a worker recognises) when an attempt waits for the owner's decision: waiting is not a failure and not the end of the attempt (card H09b). */
export const WAITING_FOR_OWNER = "it is waiting for the owner";

export const REMOTE_LIMITS = {
  /** The largest JSON body, in bytes. */
  bodyBytes: 1024 * 1024,
  /** The largest body of an artifact publication (files are sent base64-encoded), and so the most file bytes about three quarters of it. */
  publishBytes: 8 * 1024 * 1024,
  /** The largest single file a fetch returns. A larger file is refused (visibly); chunked transfer is a later addition. */
  fileBytes: 16 * 1024 * 1024,
  /** The largest checkpoint a worker may store, in bytes of canonical JSON. */
  checkpointBytes: 1024 * 1024,
  /** Control messages kept for a placement, checkpoints stored per attempt, artifacts a placement may publish or be given. */
  control: 20,
  checkpoints: 200,
  artifacts: 50,
  history: 20,
  /** Orders a host may be offered at once (also the most the controller keeps in memory per host). */
  offers: 32,
  /** Attempts a reconnecting worker may list in one recovery handshake (card H09b). */
  held: 64,
  /** The longest an offers poll may be held open by the controller, in milliseconds (card H07). */
  pollMs: 25_000,
  text: 2000,
  /** Workspace requests (card H12m) waiting for one host at once, and the largest detail an answer may carry, in bytes of JSON. */
  workspaceAsks: 4,
  workspaceDetailBytes: 4000,
  /** The largest body of a tool bridge request (card L05e): the bridge's own argument limit is 64 KB of canonical JSON, and the task credential and the wrapper are small. */
  toolBytes: 160 * 1024,
  /** The longest task credential a bridge request may carry, in characters (the controller authenticates it; a longer one cannot be one). */
  toolTokenChars: 512,
  /**
   * The model's thinking a remote host reports (card U09c): blocks per message and characters per block are the worker channel's own bounds (`THINKING_REPORT`, the same figures a local process is held to); the body is bounded
   * so the largest message (50 blocks of 8000 characters, escaped) fits, and an attempt may send `thinkingMessages` messages (the figure a local process is held to) and have `thinkingInFlight` of them in the controller at once.
   */
  thinkingBlocks: 50,
  thinkingChars: 8000,
  thinkingBytes: 640 * 1024,
  thinkingMessages: 2000,
  thinkingInFlight: 2,
} as const;

// ---- wire shapes -----------------------------------------------------------------------------------------------------------------

export type ControlMessage =
  | { readonly kind: "tell"; readonly text: string }
  | { readonly kind: "restart"; readonly recipe: RecipeSummary; readonly checkpoint: JsonObject }
  | { readonly kind: "checkpoint" }
  | { readonly kind: "stop"; readonly emergency: boolean };
export type SequencedControl = ControlMessage & { readonly seq: number };

export interface SessionInfo {
  readonly sessionId: string;
  readonly sessionEpoch: number;
  /** The primary epoch of the controller that opened the session (card H09b): a worker that sees it change after a reconnect is talking to a new primary, and lists what it holds in the recovery handshake. Absent from an older controller. */
  readonly primaryEpoch?: number;
  readonly protocol: number;
  readonly controller: VersionRange;
}

export interface ArtifactListing {
  readonly id: string;
  readonly name: string;
  readonly role: "input" | "output" | "checkpoint";
  readonly manifestDigest: string;
  readonly files: readonly { readonly path: string; readonly size: number; readonly digest: string }[];
}

export interface Offer { readonly placement: number; readonly order: import("../dispatch/ports.js").WorkOrder }

/** The result a worker reports for a turn, as it is kept on the placement (the checkpoint goes to its own artifact). */
export type StoredResult = Omit<WorkerTurnResult, "checkpoint">;

/** A request for the host that holds a task's checkout (card H12m): integration, landing, refresh or quarantine, carried over the authenticated channel. The same fields as the controller's `WorkspaceCall`. */
export interface WorkspaceAsk {
  readonly requestId: string;
  readonly operation: "integration" | "landing" | "refresh" | "release" | "quarantine";
  readonly taskId: string;
  readonly projectId: string;
  readonly reason: string;
  readonly quietAttempts: readonly string[];
  readonly assignee?: string;
  /** When the controller stops waiting (an ISO time). It frees the agent then, so a host must not start the work after it. */
  readonly expiresAt?: string;
}
/** What the host answers: the same typed outcomes a local host gives (done, or a refusal with its reason). */
/** `failed`: the host's port threw, so the work may be half done (the controller records it as failed, as it does a local host's throw), not a refusal that changed nothing. */
export type RemoteWorkspaceAnswer = { readonly ok: true; readonly summary: string; readonly detail?: JsonObject } | { readonly ok: false; readonly reason: string; readonly failed?: true };

/** A tool bridge request as the worker's tool extension made it (card L05e): the same shape the controller's `ToolExecutionService.handle` takes, restated here because the worker side imports nothing of the controller. */
export interface ToolBridgeRequest { readonly op: string; readonly callId: string; readonly args?: JsonObject }
/** The controller's answer to it: a result, or a refusal with a code (a refusal is an answer, not a failed request). */
export type ToolBridgeAnswer = { readonly ok: true; readonly result: JsonObject } | { readonly ok: false; readonly code: string; readonly message: string };

/** One block of the model's thinking a remote host's process reported (card U09c): the worker channel's `ThinkingReport`, restated because the worker side imports nothing of the controller. The text is untrusted; the controller cleans and bounds it. */
export interface ThinkingWire { readonly entryId: number; readonly block: number; readonly provider: string; readonly model: string; readonly text: string; readonly opaque: boolean }
/** The controller's answer to a thinking message: how many blocks it kept (`reason` says why none: the owner's switch is off, the record was removed, the blocks were already kept, the attempt is no longer the task's current one, or the attempt sent more than it may). Never the text. */
export interface ThinkingAnswer { readonly kept: number; readonly reason?: "off" | "removed" | "nothing-new" | "stale" | "limit" | "unavailable" }
