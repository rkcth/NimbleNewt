import type { Aggregate, SnapshotRow, StorageSnapshot } from "../storage/index.js";
import { CONTROLLER_AUTHORITY, PROMOTION_FENCE_PREFIX, parseAuthority, parseFenceHolder, type ControllerAuthority } from "./controller.js";

/**
 * Card K05, second slice: a backup restore does not change who may control the store.
 *
 * A backup made before a controller promotion holds no promotion record (`controller-authority/primary`) and the replaced controller's epoch and holder. Restored as it is, a returning old
 * controller could start on it (nothing names a successor) and take the store from the controller that restored it. So the restore carries the controller authority of the side that is newer by
 * epoch into the restored store: the epoch, the holder and the promotion record, all three from the same side, with the backup's records and counters otherwise as they were.
 *
 * - The running (live) store is newer or the same epoch (the usual case: the backup was made by this store earlier): the restored store gets the live epoch, the live holder (a promotion's fence
 *   too) and the live promotion record. When the live store has no record, the restored one has none either, even if the backup had one: the store the controller runs on decides, so a restore
 *   never adds or removes a promotion. The restored epoch is then the larger of the two.
 * - The backup is newer by epoch (a fresh installation restoring an older installation's backup, or a live store that was itself an older copy): the backup's epoch, holder and record are kept.
 *   When the running store holds a promotion (a record, or a promotion's fence), the backup must hold the same promotion or a later one; otherwise the restore is refused.
 *
 * Refused (nothing is written into the running store; the caller discards the partly restored copy) when the record of the side that decides cannot be read, or names a promotion later than
 * that side's epoch; when the live record cannot be read at all (whichever side decides); and when a holder or epoch is not in the form a store writes. The fenced epoch of a promotion record is
 * not changed: it names the controller that promotion replaced, whatever the store's epoch now is.
 */
export interface AuthoritySide {
  readonly epoch: number;
  readonly holder: string | null;
  /** The `controller-authority/primary` row of the `aggregates` table as a snapshot holds it, if any. */
  readonly authority?: SnapshotRow;
}

export interface CarriedAuthority {
  readonly from: "live" | "backup";
  readonly epoch: number;
  readonly holder: string | null;
  /** The record the restored store gets (null: none). */
  readonly authority: SnapshotRow | null;
  /** The record parsed, for the plan's words (undefined: none). */
  readonly record?: ControllerAuthority;
}

export class AuthorityCarryRefused extends Error {
  constructor(reason: string) { super(`the backup was not restored: ${reason}; nothing was changed in the running database`); this.name = "AuthorityCarryRefused"; }
}

const HOLDER_MAX = 500;

/** Whether `row` is the promotion record's row. */
export function isAuthorityRow(row: SnapshotRow | undefined): boolean {
  return row !== undefined && row["kind"] === CONTROLLER_AUTHORITY.kind && row["id"] === CONTROLLER_AUTHORITY.id;
}

/** The row's record, or "unreadable" (a body that is not JSON, a record not in the form the promotion writes, a revision that is not a whole number). */
export function authorityOfRow(row: SnapshotRow | undefined): ControllerAuthority | "unreadable" | undefined {
  if (row === undefined) return undefined;
  if (!isAuthorityRow(row) || typeof row["body"] !== "string" || !Number.isSafeInteger(row["revision"]) || (row["revision"] as number) < 1) return "unreadable";
  let body: unknown;
  try { body = JSON.parse(row["body"]); } catch { return "unreadable"; }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return "unreadable";
  return parseAuthority({ ...CONTROLLER_AUTHORITY, revision: row["revision"] as number, body, createdAt: String(row["created_at"]), updatedAt: String(row["updated_at"]) } as Aggregate);
}

function checkSide(side: AuthoritySide, which: string): void {
  if (!Number.isSafeInteger(side.epoch) || side.epoch < 0) throw new AuthorityCarryRefused(`the ${which} epoch cannot be read`);
  if (side.holder !== null && (typeof side.holder !== "string" || side.holder.length > HOLDER_MAX)) throw new AuthorityCarryRefused(`the ${which} holder cannot be read`);
  if (side.holder !== null && side.holder.startsWith(PROMOTION_FENCE_PREFIX) && parseFenceHolder(side.holder) === undefined) throw new AuthorityCarryRefused(`the ${which} store is held by a promotion fence that cannot be read`);
}

/** Decides what the restored store gets (see the module comment). Pure: it reads nothing and writes nothing. */
export function carryControllerAuthority(live: AuthoritySide, backup: AuthoritySide): CarriedAuthority {
  checkSide(live, "running database's");
  checkSide(backup, "backup's");
  const liveRecord = authorityOfRow(live.authority);
  if (liveRecord === "unreadable") throw new AuthorityCarryRefused("the record of a controller promotion in the running database cannot be read, so who may use the restored store is not known");
  const side = live.epoch >= backup.epoch ? live : backup;
  const from = side === live ? "live" : "backup";
  const record = from === "live" ? liveRecord : authorityOfRow(backup.authority);
  if (record === "unreadable") throw new AuthorityCarryRefused("the backup's record of a controller promotion cannot be read, and the backup is newer than the running database, so who may use the restored store is not known");
  if (record !== undefined && record.fenceEpoch > side.epoch) throw new AuthorityCarryRefused(`the ${from === "live" ? "running database's" : "backup's"} record of a controller promotion names epoch ${record.fenceEpoch}, later than its store's epoch ${side.epoch}`);
  // A newer backup never drops a promotion the running store holds (first review of the second slice): without this, a backup made at a later epoch on another copy of the store (an old controller
  // that went on running on its own copy and restarted there) and holding no record, or an earlier one, would let the controller that promotion fenced start on the restored store again.
  if (from === "backup") {
    // Both count (second review): a record of one promotion and the fence of a later one that stopped before its record was written (the store stays fenced by its holder) are both held, so the
    // backup must cover the later fence too, or the controller that fence replaced (the earlier promotion's successor) could start on the restored store.
    const liveFence = parseFenceHolder(live.holder);
    const held = [...(liveRecord === undefined ? [] : [{ promotionId: liveRecord.promotionId, fenceEpoch: liveRecord.fenceEpoch }]), ...(liveFence === undefined ? [] : [{ promotionId: liveFence.promotionId, fenceEpoch: live.epoch }])];
    const missing = held.find((h) => record === undefined || record.fenceEpoch < h.fenceEpoch || (record.fenceEpoch === h.fenceEpoch && record.promotionId !== h.promotionId));
    if (missing !== undefined) {
      throw new AuthorityCarryRefused(`the backup was made at a later epoch than the running database (${side.epoch}, the running database is at ${live.epoch}) but does not hold the controller promotion ${missing.promotionId} the running database holds, or a later one, so restoring it could let the controller that promotion replaced start again. Restore a backup made on this database since that promotion instead; to use this backup's data anyway, restore it with a new installation (a new, empty data folder), where it is restored as it is`);
    }
  }
  // A fence carried without its own record (a promotion stopped before it wrote one) keeps every start out until the promotion is run again, as it does on the running store.
  return { from, epoch: side.epoch, holder: side.holder, authority: from === "live" ? (live.authority ?? null) : (backup.authority ?? null), ...(record === undefined ? {} : { record }) };
}

const SEEK = { pageSize: 50, pages: 20 } as const;

/**
 * The live side, read from one snapshot of the running store (the state row and the promotion record, so the two belong to the same moment). The record is found by walking the rows of its kind
 * in key order from the start of the kind: only a promotion writes that kind, with the one id, so this is one read of one row. Bounded: a walk that would read more than 1,000 rows of the kind is
 * refused rather than taken to mean there is no record.
 */
export async function authoritySideOf(snapshot: Pick<StorageSnapshot, "read">): Promise<AuthoritySide> {
  const [state] = await snapshot.read("state", { limit: 1 });
  const side = { epoch: state === undefined ? 0 : Number(state["epoch"]), holder: (state?.["holder"] ?? null) as string | null };
  let after: SnapshotRow = { kind: CONTROLLER_AUTHORITY.kind, id: "" };
  for (let page = 0; page < SEEK.pages; page++) {
    const rows = await snapshot.read("aggregates", { after, limit: SEEK.pageSize });
    for (const row of rows) {
      if (row["kind"] !== CONTROLLER_AUTHORITY.kind) return side;
      if (row["id"] === CONTROLLER_AUTHORITY.id) return { ...side, authority: row };
    }
    if (rows.length < SEEK.pageSize) return side;
    after = rows[rows.length - 1]!;
  }
  throw new AuthorityCarryRefused(`the running database holds more than ${SEEK.pageSize * SEEK.pages} records of the controller authority kind, so its promotion record cannot be found`);
}
