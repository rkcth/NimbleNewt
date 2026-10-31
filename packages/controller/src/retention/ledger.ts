import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SnapshotRow } from "../storage/snapshot.js";

/**
 * The record of user-requested deletions that lives OUTSIDE the database (card K06): a backup made before a deletion holds the deleted text, and the deletion records in the database are not in that backup. The ledger holds
 * only IDs, who, why and when (never content), one line per deletion, and a restore re-applies it, so restoring an old backup does not bring a deleted record's text back.
 */
export interface LedgerEntry {
  readonly deletionId: string;
  readonly at: string;
  readonly by: string;
  readonly reason: string;
  /** Desk records whose text is blanked (the record and its copies). */
  readonly desk: readonly string[];
  /** Compactions whose summary text is blanked. */
  readonly compactions: readonly string[];
  /** Records removed outright (summaries, archives, meeting summaries, briefs). */
  readonly removed: readonly { readonly kind: string; readonly id: string }[];
}

/** The ledger sits next to the backup folders (in the backup root), outside the database. */
export const LEDGER_FILE = "retention-deletions.ledger";

export class DeletionLedger {
  readonly path: string;
  constructor(path: string) { this.path = path; }

  /** Appends the entry once (a repeat of the same deletion ID adds nothing new). */
  async append(entry: LedgerEntry): Promise<void> {
    if ((await this.read()).some((e) => e.deletionId === entry.deletionId && e.desk.length >= entry.desk.length && e.removed.length >= entry.removed.length)) return;
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  async read(): Promise<LedgerEntry[]> {
    let raw: string;
    try { raw = await readFile(this.path, "utf8"); } catch { return []; }
    const out: LedgerEntry[] = [];
    for (const line of raw.split("\n")) { if (line === "") continue; try { out.push(JSON.parse(line) as LedgerEntry); } catch { /* a torn last line is ignored: the deletion is applied again when it is asked for again */ } }
    return out;
  }
}

/** A desk record's body after deletion: no title or text, private, with the marker. */
export function stubDeskBody(body: Record<string, unknown>, mark: { at: string; by: string; reason: string; contentDigest: string }): Record<string, unknown> {
  const rest = Object.fromEntries(Object.entries(body).filter(([k]) => k !== "archived"));
  return { ...rest, title: "", body: "", visibility: "private", deleted: mark };
}

/** What a restore does to the rows of `aggregates` so that recorded deletions stay deleted. `undefined` drops the row. */
export function ledgerFilter(entries: readonly LedgerEntry[]): { apply(row: SnapshotRow): SnapshotRow | undefined; readonly touched: () => number } {
  const desk = new Map<string, LedgerEntry>(); const compactions = new Set<string>(); const removed = new Set<string>();
  for (const e of entries) {
    for (const id of e.desk) desk.set(id, e);
    for (const id of e.compactions) compactions.add(id);
    for (const r of e.removed) removed.add(`${r.kind}:${r.id}`);
  }
  let touched = 0;
  return {
    touched: () => touched,
    apply(row) {
      const kind = String(row["kind"]); const id = String(row["id"]);
      if (removed.has(`${kind}:${id}`)) { touched++; return undefined; }
      if (kind === "desk-record" && desk.has(id)) {
        const body = JSON.parse(String(row["body"])) as Record<string, unknown>;
        if (body["deleted"] !== undefined) return row;
        const e = desk.get(id)!; touched++;
        return { ...row, body: JSON.stringify(stubDeskBody(body, { at: e.at, by: e.by, reason: e.reason, contentDigest: "unknown: re-applied from the deletion ledger on restore" })) };
      }
      if (kind === "ctx-compaction" && compactions.has(id)) {
        const body = JSON.parse(String(row["body"])) as Record<string, unknown>;
        touched++;
        return { ...row, body: JSON.stringify({ ...body, summary: "", digest: "", sourceDeleted: true }) };
      }
      return row;
    },
  };
}
