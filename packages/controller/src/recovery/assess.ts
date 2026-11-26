import type { ReadManifest } from "./manifest.js";
import type { RecoverySource, Watermark } from "./source.js";

/** What can be asked of the artifact store on the node being checked: the same shape as `FileBlobStore.verify`. */
export interface BlobCheck {
  verify(digest: string, expectedSize?: number): Promise<"ok" | "missing" | "corrupt" | "size_mismatch">;
}

export type Problem =
  | { readonly kind: "blob_missing" | "blob_corrupt" | "blob_size_mismatch"; readonly digest: string }
  | { readonly kind: "workflow_missing"; readonly record: string }
  | { readonly kind: "workflow_behind"; readonly record: string; readonly have: number; readonly want: number }
  | { readonly kind: "audit_behind" | "delivery_behind" | "epoch_behind"; readonly have: number; readonly want: number };

/** What a node lacks compared with the manifest: the same list is a blocker for a promotion and a loss report for a restore from a backup. */
export interface Comparison {
  readonly problems: readonly Problem[];
  /** The counts a loss window is told in. `lostAuditEntries` is how many audit entries the manifest had that the node does not. */
  readonly lost: { readonly auditEntries: number; readonly deliveries: number; readonly records: number; readonly staleRecords: number; readonly blobs: number };
  readonly checked: { readonly records: number; readonly blobs: number };
  readonly watermark: Watermark;
  /** Problems beyond the first `LIST_LIMIT` are counted in `lost` but not listed. */
  readonly truncated: boolean;
}

const LIST_LIMIT = 100;

/**
 * Compares the node's state and artifact files with the manifest. Reads only. Every blob of the manifest is checked against the node's own artifact store (existence, size and, because
 * `FileBlobStore.verify` hashes the bytes, content); every record of the manifest must be on the node at the same or a newer revision; the sequence counters and epoch must not be behind.
 */
export async function compareToManifest(manifest: ReadManifest, node: RecoverySource, blobs: BlobCheck | undefined): Promise<Comparison> {
  const problems: Problem[] = [];
  let truncated = false;
  const add = (p: Problem): void => { if (problems.length < LIST_LIMIT) problems.push(p); else truncated = true; };
  const want = manifest.manifest.watermark;
  const have = await node.watermark();
  if (have.epoch < want.epoch) add({ kind: "epoch_behind", have: have.epoch, want: want.epoch });
  if (have.auditSeq < want.auditSeq) add({ kind: "audit_behind", have: have.auditSeq, want: want.auditSeq });
  if (have.deliverySeq < want.deliverySeq) add({ kind: "delivery_behind", have: have.deliverySeq, want: want.deliverySeq });

  // records: what the node has, by name, against what the manifest wants
  const wanted = manifest.aggregateRefs();
  const onNode = new Map<string, number>();
  for await (const r of node.aggregates()) onNode.set(`${r.kind}/${r.id}`, r.revision);
  let missing = 0; let stale = 0;
  for (const r of wanted) {
    const name = `${r.kind}/${r.id}`;
    const revision = onNode.get(name);
    if (revision === undefined) { missing++; add({ kind: "workflow_missing", record: name }); } else if (revision < r.revision) { stale++; add({ kind: "workflow_behind", record: name, have: revision, want: r.revision }); }
  }

  const wantedBlobs = manifest.blobRefs();
  let blobsLost = 0;
  for (const b of wantedBlobs) {
    const result = blobs === undefined ? "missing" : await blobs.verify(b.digest, b.size);
    if (result !== "ok") { blobsLost++; add({ kind: result === "missing" ? "blob_missing" : result === "corrupt" ? "blob_corrupt" : "blob_size_mismatch", digest: b.digest }); }
  }
  return {
    problems, truncated, watermark: have, checked: { records: wanted.length, blobs: wantedBlobs.length },
    lost: { auditEntries: Math.max(0, want.auditSeq - have.auditSeq), deliveries: Math.max(0, want.deliverySeq - have.deliverySeq), records: missing, staleRecords: stale, blobs: blobsLost },
  };
}

export const describeProblem = (p: Problem): string => {
  switch (p.kind) {
    case "blob_missing": return `artifact file ${p.digest.slice(0, 12)}... is not on this node`;
    case "blob_corrupt": return `artifact file ${p.digest.slice(0, 12)}... is on this node but its content does not match its name`;
    case "blob_size_mismatch": return `artifact file ${p.digest.slice(0, 12)}... has a different size than the manifest records`;
    case "workflow_missing": return `record ${p.record} is in the manifest but not on this node`;
    case "workflow_behind": return `record ${p.record} is at revision ${p.have} here but the manifest has ${p.want}`;
    case "audit_behind": return `the audit log stops at ${p.have}; the manifest has ${p.want}`;
    case "delivery_behind": return `the delivery counter is ${p.have}; the manifest has ${p.want}`;
    case "epoch_behind": return `the epoch is ${p.have}; the manifest has ${p.want}`;
  }
};
