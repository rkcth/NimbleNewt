import { createHash } from "node:crypto";
import type { AdapterRequest, UnansweredReason } from "@nimblenewt/contracts";

type FingerprintedRequest = Extract<AdapterRequest, { kind: "input" | "update" }>;

const KNOWN_REASONS: ReadonlySet<string> = new Set(["aborted", "model_error", "no_model", "stale", "reset", "faulted"]);

/** Maps a Pi Durable submission reason to the contract's closed set; anything else is `other` (detail keeps the original). */
export function mapReason(reason: string): UnansweredReason {
  return KNOWN_REASONS.has(reason) ? (reason as UnansweredReason) : "other";
}

/**
 * Identity of an input or update request's payload for request-ID reuse detection. Versioned so the covered fields can
 * grow; every field that changes what the request does belongs here.
 */
export function fingerprintOf(request: FingerprintedRequest): string {
  const payload = request.kind === "update"
    ? JSON.stringify(["update", request.content, request.whenBusy ?? null, request.source?.conversationId ?? null, request.source?.entryId ?? null, request.run ?? true])
    : JSON.stringify([request.content, request.whenBusy ?? null]);
  return `v1:sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

const versionOf = (fingerprint: string): string => /^(v\d+):/.exec(fingerprint)?.[1] ?? "legacy";

/**
 * Whether a stored fingerprint allows a new payload. A missing fingerprint, or one from another version or an unknown
 * format, cannot be compared and is treated as legacy: it matches.
 */
export function fingerprintsMatch(stored: string | undefined, current: string): boolean {
  if (stored === undefined) return true;
  if (versionOf(stored) !== versionOf(current)) return true;
  return stored === current;
}
