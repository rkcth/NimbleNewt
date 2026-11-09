import { sha256 } from "../storage/json.js";

/**
 * A bounded summary lineage (card C07q). A task that runs long is compacted again and again, and a list of every earlier summary's ID would grow without end (and a continuation capture refuses a list past
 * its limit). So a lineage keeps its newest IDs in order and folds the older ones into `earlier`: how many there were, a digest of all of them in order, and the newest of them (`through`), from which the
 * rest are read back by reference (each compaction names its parent, so walking from `through` gives every older ID, newest first). The digest is a chain, `sha256(previous + "\0" + id)` over the IDs
 * oldest first, so folding more IDs continues it and never needs the ones folded before.
 */
export interface LineageEarlier {
  /** How many older IDs were folded (at least 1). */
  readonly count: number;
  /** `sha256:` and the chained digest of every folded ID, oldest first. */
  readonly digest: string;
  /** The newest of the folded IDs; its own record leads to the older ones. */
  readonly through: string;
}

/** The newest compactions a compaction record keeps by ID; the rest are kept by reference. */
export const LINEAGE_KEEP = 50;
export const LINEAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;

/** The chained digest of `ids` (oldest first), continued from `from` (the digest of what was folded before, or nothing). */
export function lineageDigest(ids: readonly string[], from?: string): string {
  let d = from === undefined ? "" : from.slice("sha256:".length);
  for (const id of ids) d = sha256(`${d}\0${id}`);
  return `sha256:${d}`;
}

/** Keeps the newest `keep` IDs of `lineage` (oldest first) and folds the rest into `earlier`. Nothing to fold returns the input as it is. */
export function foldLineage(lineage: readonly string[], earlier: LineageEarlier | undefined, keep: number = LINEAGE_KEEP): { lineage: string[]; earlier?: LineageEarlier } {
  if (!Number.isSafeInteger(keep) || keep < 1) throw new RangeError("keep must be a whole number from 1");
  if (lineage.length <= keep) return { lineage: [...lineage], ...(earlier === undefined ? {} : { earlier }) };
  const folded = lineage.slice(0, lineage.length - keep);
  return {
    lineage: lineage.slice(lineage.length - keep),
    earlier: { count: (earlier?.count ?? 0) + folded.length, digest: lineageDigest(folded, earlier?.digest), through: folded[folded.length - 1]! },
  };
}
