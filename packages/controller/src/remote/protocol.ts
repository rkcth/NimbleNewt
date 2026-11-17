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
export const WORKER_PROTOCOL = { min: 1, max: 2 } as const;
/**
 * Card T02d (remote script execution): protocol version 2 adds the run order (`run`), the single abort (`abort`) and the revocation (`revoke`) control messages and the two routes that carry a script's order to the host and its outcome back
 * (`run-fetch`, `run-done`). A session that negotiated 1 (an older worker or controller) never receives or answers them, and the controller runs no catalogue script for an attempt on such a host.
 */
export const SCRIPT_PROTOCOL = 2;
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
  /** A worker's report of the processes it holds for an attempt (card L02e): at most this many entries, a reference of at most `processRef` characters each, in a body of at most `processBytes` bytes. */
  processes: 50,
  /** The most cleanup compute (ms) a worker's report may count for one placement: a day. A larger figure is refused, not cut (card L02e). */
  cleanupMs: 24 * 3600 * 1000,
  processRef: 120,
  processBytes: 16 * 1024,
  /**
   * The model's thinking a remote host reports (card U09c): blocks per message and characters per block are the worker channel's own bounds (`THINKING_REPORT`, the same figures a local process is held to); the body is bounded
   * so the largest message (50 blocks of 8000 characters, escaped) fits, and an attempt may send `thinkingMessages` messages (the figure a local process is held to) and have `thinkingInFlight` of them in the controller at once.
   */
  thinkingBlocks: 50,
  thinkingChars: 8000,
  thinkingBytes: 640 * 1024,
  thinkingMessages: 2000,
  thinkingInFlight: 2,
  /** Pi state in transit (card K01i): the most file bytes in one message (the body is the base64 of them), and the most a whole transfer may hold, in bytes and in files. */
  piChunkBytes: 512 * 1024,
  piTransferBytes: 4 * 1024 * 1024 * 1024,
  piTransferFiles: 200_001,
  /**
   * Catalogue scripts on a remote host (card T02d, protocol 2). A host runs at most `scriptRuns` orders of one attempt at once; the order a host fetches carries the script source (at most `scriptSourceBytes`) and the model's arguments on standard
   * input (at most `scriptStdinBytes`, the bridge's own argument limit); what it sends back is at most `scriptOutputBytes` of standard output (the bridge's own output limit) in a body of at most `scriptBytes` (escaping can multiply the text),
   * and an error text of at most `scriptErrorChars`. A run the host does not confirm as stopped after an abort is waited for no longer than the run's own time limit plus `scriptGraceMs`.
   */
  scriptRuns: 4,
  scriptSourceBytes: 256 * 1024,
  scriptStdinBytes: 64 * 1024,
  scriptOutputBytes: 64 * 1024,
  scriptBytes: 512 * 1024,
  scriptErrorChars: 500,
  scriptGraceMs: 30_000,
  /** Run orders kept by the controller for an attempt that was ended or moved (their final states, for a late, repeated report), bounded overall. */
  scriptRemembered: 256,
} as const;

/** The ID of a script run ordered of a remote host (card T02d): the controller makes it from the attempt, the call and the placement, so asking again for the same call under the same placement is the same run. */
export const RUN_ID = /^run-[0-9a-f]{24}$/;

/** The ID of a transfer of conversation stores between a host and the controller (card K01i). */
export const PI_TRANSFER_ID = /^pst-[a-z2-7]{20}$/;
/** A file of a transfer: the index or one stored file (the names a backup's own Pi state section uses). */
export const PI_TRANSFER_FILE = /^(index\.jsonl|f-[0-9]{1,9})$/;

// ---- wire shapes -----------------------------------------------------------------------------------------------------------------

export type ControlMessage =
  | { readonly kind: "tell"; readonly text: string }
  | { readonly kind: "restart"; readonly recipe: RecipeSummary; readonly checkpoint: JsonObject }
  | { readonly kind: "checkpoint" }
  | { readonly kind: "stop"; readonly emergency: boolean }
  /** Force Stop (card L02e): kill whatever the sandbox of this attempt still holds, now. A worker that does not know the message ignores it. */
  | { readonly kind: "kill" }
  /** A fresh look (card L02e): report the processes the sandbox holds now, whether or not they changed. A worker that does not know the message ignores it (and never says it can look). */
  | { readonly kind: "look" }
  /**
   * Card T02d (protocol 2): the controller orders a catalogue script run on this host. The message carries only the run's ID and the digest of the order, never the source or the arguments: the host fetches the order (`run-fetch`), checks it
   * against this digest, runs it in its own sandbox and reports the outcome (`run-done`). A worker that does not know the message ignores it (the controller sends it only to a session that negotiated protocol 2).
   */
  | { readonly kind: "run"; readonly runId: string; readonly digest: string }
  /** Card T02d: stop one run (the call that ordered it ended: its own signal aborted). The host stops the run in its sandbox and reports `aborted` when the process is really gone. */
  | { readonly kind: "abort"; readonly runId: string }
  /**
   * Card T02d: a version of the catalogue was revoked while its scripts may run on this host, with the choice the owner recorded on the revocation (`finish`: let a running call end; `cancel` and `pause`: stop every running call of the version
   * and start none; the task of a `pause` is paused by the controller). It names no tool body, only the name, the version and the choice.
   */
  | { readonly kind: "revoke"; readonly name: string; readonly version: string; readonly choice: "finish" | "cancel" | "pause" };
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
  readonly operation: "integration" | "landing" | "refresh" | "reapply" | "release" | "quarantine" | "verify" | "pi-state-send" | "pi-state-restore" | "pi-thinking-purge" | "observe";
  readonly taskId: string;
  readonly projectId: string;
  readonly reason: string;
  readonly quietAttempts: readonly string[];
  readonly assignee?: string;
  /** A landing only (card H12a): the owner's landing policy as the controller read it, bounded and checked. A host holds it against its own configuration and can only be made stricter by it. */
  readonly landing?: import("../workspace-ops/workspace-ops.js").CarriedLanding;
  /** `verify` only (card H12a): the check of an attempt's done (card W05) asked of the host that holds the attempt. */
  readonly verify?: { readonly attemptId: string; readonly checks: readonly { readonly name: string; readonly run: readonly string[]; readonly timeoutMs: number }[]; readonly evidence: readonly string[]; readonly maxOutputBytes: number };
  /** `pi-state-send` and `pi-state-restore` only (card K01i): the transfer the host's conversation stores travel in. `send`: the host copies its stores and uploads them under this ID; `restore`: the host fetches the stores the controller holds under this ID and puts each one back in its place. */
  readonly piState?: { readonly transferId: string };
  /** `pi-thinking-purge` only (card K06c): the attempts whose conversation stores on the host are to lose their stored model thinking (the retention rule's act, 14 days after the task is done). The host removes it from the stores it keeps for these attempts (never one with a call in flight) and answers which it cleaned and which it keeps none of. */
  readonly thinkingPurge?: { readonly attemptIds: readonly string[] };
  /**
   * `observe` only (card L04e): the files and directories a task recorded as relied on, for the host to look at again in the task's checkout on its own disk before a resumed attempt starts. The host answers, for each it could read, what it is now
   * (`detail.observed[id]`: `exists`, and `hash` of a file's bytes or the sorted `members` of a directory); one it could not read or may not read (outside the checkout, beyond the project's `paths`, too large) is left out, which the controller reads as unknown. No
   * content and no path ride the answer.
   */
  readonly observe?: { readonly entries: readonly { readonly id: string; readonly kind: "file" | "directory"; readonly key: string }[]; readonly paths?: readonly string[] };
  /** When the controller stops waiting (an ISO time). It frees the agent then, so a host must not start the work after it. */
  readonly expiresAt?: string;
}
/** What the host answers: the same typed outcomes a local host gives (done, or a refusal with its reason). */
/** `failed`: the host's port threw, so the work may be half done (the controller records it as failed, as it does a local host's throw), not a refusal that changed nothing. */
export type RemoteWorkspaceAnswer = { readonly ok: true; readonly summary: string; readonly detail?: JsonObject } | { readonly ok: false; readonly reason: string; readonly failed?: true };

/**
 * What a remote worker reports of the processes it started for an attempt and has not cleaned up (card L02e), the same entries a local sandbox reports to Stop. `seq` rises with every report of a placement (a repeat or an older one changes nothing);
 * `final` says the worker has stopped the attempt's sandbox and looked: what it lists then (normally nothing) is what is left. A report names no path of the controller and carries no credential: a reference is redacted and cut.
 */
export interface ProcessReport {
  readonly seq: number;
  readonly final: boolean;
  /** The worker answers the `look` and `kill` control messages: the controller may ask it for a fresh look before it reads a live report (a worker that does not say so is read as it always was). */
  readonly canLook?: true;
  /** What winding the attempt's sandbox down has cost in compute so far, in ms, as a running total (the controller charges only what it has not charged yet). */
  readonly computeMs?: number;
  readonly processes: readonly { readonly ref: string; readonly kind: "process" | "child"; readonly state: "running" | "uncooperative" | "unknown" }[];
}

/** A tool bridge request as the worker's tool extension made it (card L05e): the same shape the controller's `ToolExecutionService.handle` takes, restated here because the worker side imports nothing of the controller. */
export interface ToolBridgeRequest { readonly op: string; readonly callId: string; readonly args?: JsonObject }
/** The controller's answer to it: a result, or a refusal with a code (a refusal is an answer, not a failed request). */
export type ToolBridgeAnswer = { readonly ok: true; readonly result: JsonObject } | { readonly ok: false; readonly code: string; readonly message: string };

/** One block of the model's thinking a remote host's process reported (card U09c): the worker channel's `ThinkingReport`, restated because the worker side imports nothing of the controller. The text is untrusted; the controller cleans and bounds it. */
export interface ThinkingWire { readonly entryId: number; readonly block: number; readonly provider: string; readonly model: string; readonly text: string; readonly opaque: boolean }
/** The controller's answer to a thinking message: how many blocks it kept (`reason` says why none: the owner's switch is off, the record was removed, the blocks were already kept, the attempt is no longer the task's current one, or the attempt sent more than it may). Never the text. */
export interface ThinkingAnswer { readonly kept: number; readonly reason?: "off" | "removed" | "nothing-new" | "stale" | "limit" | "unavailable" }

/**
 * A script order as the host fetches it (card T02d): the controller's `ScriptLaunch`, restated because the worker side imports nothing of the controller. `env` is always empty and the order holds no task credential and no secret: the host
 * runs the script with an empty environment, whatever it is told.
 */
export interface RunOrderWire {
  readonly runId: string;
  readonly program: string;
  readonly argv: readonly string[];
  readonly stdin: string;
  readonly source: string;
  readonly tool: { readonly name: string; readonly version: string; readonly digest: string };
  readonly interpreterVersion: string;
  readonly maxOutputBytes: number;
  readonly limits: { readonly cpus: number; readonly memoryMb: number; readonly seconds: number };
  readonly env: Readonly<Record<string, string>>;
}
/** What a host reports of a run (card T02d). `aborted` is the acknowledgement of an abort or a revocation: the host's process is gone. `failed` is a run that ended without a result (or an order the host could not take). */
export type RunOutcomeWire =
  | { readonly state: "done"; readonly text: string; readonly cpuMs?: number; readonly memoryMb?: number }
  | { readonly state: "failed"; readonly error: string }
  | { readonly state: "aborted"; readonly choice?: "cancel" | "pause" };
/** The controller's answer to a run outcome: whether it was taken (`false`: the run was already settled or is not known; the host drops it). */
export interface RunAck { readonly kept: boolean }
