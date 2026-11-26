import type { ControllerStorage } from "../storage/index.js";
import { SNAPSHOT_PAGE_MAX, type SnapshotRow } from "../storage/index.js";

/** The counters that say how far a store has got: what the recovery manifest records and what a standby is compared with. */
export interface Watermark {
  readonly epoch: number;
  readonly auditSeq: number;
  readonly deliverySeq: number;
}

/** One controller record, as far as recovery needs it: which one, and which revision. `body` is present only when a caller asked for it (the manifest reads artifact bodies for their blobs). */
export interface RecordRef {
  readonly kind: string;
  readonly id: string;
  readonly revision: number;
  readonly body?: string;
}

/**
 * Read access to the controller's state on one node, whatever holds it: a store opened by the controller, a restored copy, or a PostgreSQL standby (read through
 * `storage/postgres/readControllerState`, which has the same shape). Nothing here writes.
 */
export interface RecoverySource {
  watermark(): Promise<Watermark>;
  /** Every record in code-point order of (kind, id). */
  aggregates(): AsyncIterable<RecordRef>;
}

/** A source over an open store's consistent snapshot (every backend). The snapshot is taken when the source is first read and closed when `close` is called. */
export function snapshotSource(storage: ControllerStorage): RecoverySource & { close(): Promise<void> } {
  let open: ReturnType<ControllerStorage["snapshot"]> | undefined;
  const snapshot = () => (open ??= storage.snapshot());
  return {
    watermark: async () => {
      const [row] = await (await snapshot()).read("state", { limit: 1 });
      if (row === undefined) throw new Error("the store returned no state row");
      return { epoch: Number(row.epoch), auditSeq: Number(row.audit_seq), deliverySeq: Number(row.delivery_seq) };
    },
    aggregates: async function* () {
      const snap = await snapshot();
      let after: SnapshotRow | undefined;
      for (;;) {
        const rows = await snap.read("aggregates", { ...(after === undefined ? {} : { after }), limit: SNAPSHOT_PAGE_MAX });
        for (const r of rows) yield { kind: r.kind as string, id: r.id as string, revision: Number(r.revision), body: r.body as string };
        if (rows.length < SNAPSHOT_PAGE_MAX) return;
        after = rows[rows.length - 1]!;
      }
    },
    close: async () => { if (open !== undefined) await (await open).close(); open = undefined; },
  };
}
