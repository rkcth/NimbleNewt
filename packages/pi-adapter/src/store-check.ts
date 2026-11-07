import { CONTRACTS_VERSION, type Checkpoint, type CheckpointV1 } from "@nimblenewt/contracts";
import { HISTORY_FORMAT } from "./checkpoints.js";

/** What the check needs of the adapter: whether a checkpoint still describes a stored conversation. */
export interface CheckpointVerifier {
  verifyCheckpoint(stored: Checkpoint | CheckpointV1): Promise<{ readonly valid: boolean }>;
}

/** A recovery point as the controller records it: the checkpoint is the JSON text of the record. */
export interface StoredCheckpointRef { readonly id: string; readonly attemptId: string; readonly checkpoint: string }

/**
 * Which recovery points' checkpoints do NOT hold against the conversation stores (card F04l): the text is not a checkpoint, the conversation or entry
 * is not in the store, the entry is not a completed-turn boundary, or the history up to it is not what was checkpointed. Each point is judged on its
 * own, in order; a check that cannot be made (the store cannot be read) throws, so the caller never reads "nothing missing" from a failed look. Nothing is
 * written or restored. The result is the points' IDs, so a controller can refuse a database transfer that would carry a point nobody can resume from.
 */
export async function missingCheckpoints(adapter: CheckpointVerifier, points: readonly StoredCheckpointRef[]): Promise<string[]> {
  const missing: string[] = [];
  for (const point of points) {
    let parsed: unknown;
    try { parsed = JSON.parse(point.checkpoint); } catch { missing.push(point.id); continue; }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) { missing.push(point.id); continue; }
    // The controller keeps the part of a format-2 checkpoint that names the history (conversation, entry, digest, runtime); the history layout and the informational contracts version are not stored.
    // The layout is the one this adapter writes for that runtime (the runtime name and version are still compared by the verification), and the contracts version does not decide validity.
    const record = parsed as Record<string, unknown>;
    const full = record["format"] === 2 ? { ...record, historyFormat: record["historyFormat"] ?? HISTORY_FORMAT, contractsVersion: record["contractsVersion"] ?? CONTRACTS_VERSION } : record;
    const verdict = await adapter.verifyCheckpoint(full as unknown as Checkpoint);
    if (!verdict.valid) missing.push(point.id);
  }
  return missing;
}
