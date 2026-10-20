import { createHash } from "node:crypto";

export const CHECKPOINT_DIGEST_PREFIX = "v1:sha256:";

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
