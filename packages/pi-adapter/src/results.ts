import { createHash } from "node:crypto";
import type { AdapterRequest, UnansweredReason } from "@nimblenewt/contracts";

const KNOWN_REASONS: ReadonlySet<string> = new Set(["aborted", "model_error", "no_model", "stale", "reset", "faulted"]);

/** Maps a Pi Durable submission reason to the contract's closed set; anything else is `other` (detail keeps the original). */
export function mapReason(reason: string): UnansweredReason {
  return KNOWN_REASONS.has(reason) ? (reason as UnansweredReason) : "other";
}

/**
 * Identity of an input request's payload for request-ID reuse detection. Versioned so the covered fields can grow;
 * every field that changes what the request does (content, busy policy, later: branch and entry options) belongs here.
 */
export function fingerprintOf(request: Extract<AdapterRequest, { kind: "input" }>): string {
  const payload = JSON.stringify([request.content, request.whenBusy ?? null]);
  return `v1:sha256:${createHash("sha256").update(payload).digest("hex")}`;
}
