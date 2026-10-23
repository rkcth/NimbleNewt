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
  text: 2000,
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
