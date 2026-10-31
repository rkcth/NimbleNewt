import { canonicalJson, sha256 } from "./json.js";
import type { AggregateRef, JsonObject } from "./types.js";

/**
 * The record a removal leaves behind (card K06b follow-up): an aggregate of the reserved kind `tombstone` whose body is `{ kind, id, revision }`, the revision the removed aggregate had.
 * A later `create` of the same ref starts at that revision plus one, so a holder of the old revision is still refused with `revision_conflict` instead of finding a new record at revision 1.
 * It is an ordinary aggregate row, so snapshots, backups and restores carry it with the rest. Only the storage writes it; an operation naming the kind is refused.
 */
export const TOMBSTONE_KIND = "tombstone";

/** The tombstone's id for a ref: a digest, because kind plus id may be longer than an id may be. */
export const tombstoneId = (ref: AggregateRef): string => `t-${sha256(`${ref.kind}/${ref.id}`)}`;

export const tombstoneBody = (ref: AggregateRef, revision: number): string => canonicalJson({ kind: ref.kind, id: ref.id, revision } as JsonObject);

/** The revision recorded in a stored tombstone body. */
export const tombstoneRevision = (body: string): number => Number((JSON.parse(body) as { revision: number }).revision);
