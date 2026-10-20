import { createHash } from "node:crypto";
import type { Checkpoint, CheckpointRejection, CheckpointV1 } from "@nimblenewt/contracts";

export const CHECKPOINT_DIGEST_PREFIX = "v1:sha256:";
/** The checkpoint layout this adapter writes. */
export const CHECKPOINT_FORMAT = 2;
export const RUNTIME_NAME = "pi-durable";
/** The persisted history layout this adapter understands: Pi Durable storage record format 1, document version 1. */
export const HISTORY_FORMAT = "pi-durable:1";
export const SUPPORTED_HISTORY_FORMATS: readonly string[] = [HISTORY_FORMAT];

/** The parts of a history entry that decide what the model sees and what the transcript says. */
export interface DigestEntry {
  readonly id: number;
  readonly kind: string;
  readonly model?: unknown;
  readonly data?: unknown;
  readonly head?: unknown;
  readonly edits?: unknown;
}

/** JSON with object keys sorted, so equal values always serialize to equal text. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/**
 * Digest of a history prefix, in entry order. Covers each entry's id, kind, model messages, data, head marker and context
 * edits; deliberately not which conversation or task wrote it, so a fork's inherited prefix digests like its source.
 */
export function digestHistory(entries: readonly DigestEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of [...entries].sort((a, b) => a.id - b.id)) {
    hash.update(canonicalJson({ id: entry.id, kind: entry.kind, model: entry.model, data: entry.data, head: entry.head, edits: entry.edits }));
    hash.update("\n");
  }
  return `${CHECKPOINT_DIGEST_PREFIX}${hash.digest("hex")}`;
}

export type CheckpointUpgrade =
  | { readonly ok: true; readonly checkpoint: Checkpoint; /** True if the input was an older format. */ readonly migrated: boolean }
  | { readonly ok: false; readonly reason: CheckpointRejection; readonly detail: string };

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

/**
 * Turns a stored checkpoint of any format this adapter knows into the current format. Pure: the input is never modified and
 * nothing else is touched, so a rejected or failed upgrade leaves the stored original exactly as it was. Formats from the
 * future, and malformed records, are refused with a reason instead of being guessed at.
 *
 * Format 1 -> 2: the runtime version string becomes `{ name: "pi-durable", version }` and the history layout is recorded.
 * Format 1 was only ever written for Pi Durable 1.3.0 history (`pi-durable:1`), which is what the upgrade states.
 */
export function upgradeCheckpoint(raw: unknown): CheckpointUpgrade {
  if (!isObject(raw)) return { ok: false, reason: "unsupported_format", detail: "a checkpoint must be an object" };
  const common = isCount(raw.conversationId) && isCount(raw.at) && typeof raw.digest === "string" && isCount(raw.contractsVersion);
  if (raw.format === 1) {
    if (!common || typeof raw.runtimeVersion !== "string") return { ok: false, reason: "unsupported_format", detail: "malformed format-1 checkpoint" };
    const v1 = raw as unknown as CheckpointV1;
    return {
      ok: true,
      migrated: true,
      checkpoint: {
        format: 2, conversationId: v1.conversationId, at: v1.at, digest: v1.digest,
        runtime: { name: RUNTIME_NAME, version: v1.runtimeVersion }, historyFormat: HISTORY_FORMAT, contractsVersion: v1.contractsVersion,
      },
    };
  }
  if (raw.format === CHECKPOINT_FORMAT) {
    const runtime = raw.runtime;
    if (!common || !isObject(runtime) || typeof runtime.name !== "string" || typeof runtime.version !== "string" || typeof raw.historyFormat !== "string") {
      return { ok: false, reason: "unsupported_format", detail: "malformed format-2 checkpoint" };
    }
    const v2 = raw as unknown as Checkpoint;
    return { ok: true, migrated: false, checkpoint: { ...v2, runtime: { name: runtime.name, version: runtime.version } } };
  }
  return { ok: false, reason: "unsupported_format", detail: `checkpoint format ${JSON.stringify(raw.format)} is not understood (this adapter reads formats 1 and ${CHECKPOINT_FORMAT})` };
}
