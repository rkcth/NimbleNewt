/**
 * Native PostgreSQL streaming replication, as the controller sees it (card K04). Everything here is an ordinary SQL statement on an ordinary connection (`pg_stat_replication`,
 * `pg_last_wal_replay_lsn`, `pg_promote`): the replication itself is PostgreSQL's own WAL streaming, set up by the database operator, and nothing in NimbleNewt speaks the
 * replication protocol or ships WAL. It lives here because only the storage folders may touch the database driver.
 *
 * Database failover is not controller promotion. Promoting a standby makes a database writable; it says nothing about which controller may use it. The epoch, the fencing of the
 * old controller and the recovery login are card K05's; `promoteStandby` changes none of them.
 */

import type pg from "pg";
import { withShortConnection } from "./connection.js";
import { StorageError } from "../errors.js";

const SCHEMA_NAME = /^[a-z][a-z0-9_]{0,40}$/;
const STEP = { writes: false, applicationName: "nimblenewt-recovery" } as const;
const STEP_WRITE = { writes: true, applicationName: "nimblenewt-recovery" } as const;

/** A write-ahead-log position as a number (`0/16B3748` is two 32-bit halves in hex), so two positions can be compared and subtracted. */
export function lsnToBigInt(lsn: string): bigint {
  const match = /^([0-9A-Fa-f]{1,8})\/([0-9A-Fa-f]{1,8})$/.exec(lsn);
  if (match === null) throw new RangeError(`not a write-ahead-log position: ${JSON.stringify(lsn.slice(0, 40))}`);
  return (BigInt(`0x${match[1]!}`) << 32n) | BigInt(`0x${match[2]!}`);
}

/** What a server says about itself. `positionLsn` is the position written so far on a primary and the position replayed so far on a standby. */
export interface NodeFacts {
  readonly inRecovery: boolean;
  /** False only on a node that accepts writes: a primary, or a promoted standby. */
  readonly writable: boolean;
  readonly systemIdentifier: string;
  readonly positionLsn: string;
  /** A standby: the newest position its WAL receiver has written to disk (it may be ahead of what is replayed). */
  readonly receivedLsn?: string;
  /** A standby: the commit time of the last transaction it replayed. */
  readonly lastReplayAt?: string;
  readonly synchronousStandbyNames: string;
  readonly synchronousCommit: string;
}

export async function probeNode(url: string): Promise<NodeFacts> {
  return withShortConnection(url, { name: "reading the node's replication role", ...STEP }, async (c) => {
    const row = (await c.query(
      `SELECT pg_is_in_recovery() AS in_recovery, current_setting('transaction_read_only') AS read_only,
              (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,
              CASE WHEN pg_is_in_recovery() THEN pg_last_wal_replay_lsn()::text ELSE pg_current_wal_lsn()::text END AS position_lsn,
              CASE WHEN pg_is_in_recovery() THEN pg_last_wal_receive_lsn()::text END AS received_lsn,
              CASE WHEN pg_is_in_recovery() THEN to_char(pg_last_xact_replay_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS last_replay_at,
              current_setting('synchronous_standby_names') AS sync_names, current_setting('synchronous_commit') AS sync_commit`)).rows[0] as Record<string, string | null>;
    const inRecovery = row.in_recovery as unknown as boolean;
    return {
      inRecovery, writable: !inRecovery && row.read_only === "off", systemIdentifier: row.system_identifier!, positionLsn: row.position_lsn!,
      ...(row.received_lsn === null || row.received_lsn === undefined ? {} : { receivedLsn: row.received_lsn }),
      ...(row.last_replay_at === null || row.last_replay_at === undefined ? {} : { lastReplayAt: row.last_replay_at }),
      synchronousStandbyNames: row.sync_names!, synchronousCommit: row.sync_commit!,
    };
  });
}

export type SyncState = "async" | "potential" | "sync" | "quorum";

/** One standby as the primary sees it. */
export interface StandbyLink {
  readonly applicationName: string;
  readonly state: string;
  readonly syncState: SyncState;
  readonly sentLsn: string;
  readonly flushLsn: string;
  readonly replayLsn: string;
  /** How long the standby took to flush, then replay, the most recent WAL (the primary measures it from a sample); undefined before any sample. */
  readonly flushLagMs?: number;
  readonly replayLagMs?: number;
}

/** The primary's own position and every standby connected to it. */
export async function readStandbyLinks(primaryUrl: string): Promise<{ readonly currentLsn: string; readonly links: readonly StandbyLink[] }> {
  return withShortConnection(primaryUrl, { name: "reading the standbys of the primary", ...STEP }, async (c) => {
    const current = (await c.query("SELECT pg_current_wal_lsn()::text AS lsn")).rows[0]!.lsn as string;
    const rows = (await c.query(
      `SELECT application_name, state, sync_state, sent_lsn::text AS sent_lsn, COALESCE(flush_lsn, '0/0')::text AS flush_lsn, COALESCE(replay_lsn, '0/0')::text AS replay_lsn,
              EXTRACT(EPOCH FROM flush_lag) * 1000 AS flush_lag_ms, EXTRACT(EPOCH FROM replay_lag) * 1000 AS replay_lag_ms
         FROM pg_stat_replication ORDER BY application_name`)).rows as Record<string, string | null>[];
    return {
      currentLsn: current,
      links: rows.map((r) => ({
        applicationName: r.application_name!, state: r.state!, syncState: r.sync_state as SyncState, sentLsn: r.sent_lsn!, flushLsn: r.flush_lsn!, replayLsn: r.replay_lsn!,
        ...(r.flush_lag_ms === null ? {} : { flushLagMs: Number(r.flush_lag_ms) }), ...(r.replay_lag_ms === null ? {} : { replayLagMs: Number(r.replay_lag_ms) }),
      })),
    };
  });
}

/**
 * How far behind a standby is, measured from the primary. The two byte counts are the loss window if the primary were lost now: `unflushedBytes` has not reached the standby's disk
 * (gone with the primary), `unreplayedBytes` is on the standby's disk but not yet visible (kept; a promotion replays it first).
 */
export interface ReplicationLag {
  readonly applicationName: string;
  readonly syncState: SyncState;
  readonly state: string;
  readonly unflushedBytes: number;
  readonly unreplayedBytes: number;
  readonly flushLagMs?: number;
  readonly replayLagMs?: number;
}

export async function measureLag(primaryUrl: string, standbyName: string): Promise<ReplicationLag | undefined> {
  const { currentLsn, links } = await readStandbyLinks(primaryUrl);
  const link = links.find((l) => l.applicationName === standbyName);
  if (link === undefined) return undefined;
  const now = lsnToBigInt(currentLsn);
  const behind = (position: string): number => { const d = now - lsnToBigInt(position); return Number(d < 0n ? 0n : d); };
  return {
    applicationName: link.applicationName, syncState: link.syncState, state: link.state, unflushedBytes: behind(link.flushLsn), unreplayedBytes: behind(link.replayLsn),
    ...(link.flushLagMs === undefined ? {} : { flushLagMs: link.flushLagMs }), ...(link.replayLagMs === undefined ? {} : { replayLagMs: link.replayLagMs }),
  };
}

/** The server settings that make commits wait for a standby, as text for the database operator (nothing is changed): the controller never edits the server's replication settings. */
export function synchronousSettingsText(standbyNames: readonly string[]): string {
  if (standbyNames.length === 0) return "synchronous_standby_names = ''\n";
  for (const name of standbyNames) if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name)) throw new RangeError(`standby name ${JSON.stringify(name.slice(0, 40))}: letters, digits and underscores only`);
  return `synchronous_standby_names = 'FIRST 1 (${standbyNames.join(", ")})'\nsynchronous_commit = on\n`;
}

/** The result of asking a standby to become writable. */
export interface DatabasePromotion {
  readonly promoted: true;
  readonly positionLsn: string;
}

/**
 * Asks a standby to become the writable database (`pg_promote`) and waits until it is. Nothing here decides whether that is safe: `recovery/promotion.ts` does, and is the way in.
 * A node that is not a standby is refused untouched. This does not change the controller's epoch or holder.
 */
export async function promoteStandby(url: string, waitSeconds = 60): Promise<DatabasePromotion> {
  if (!Number.isInteger(waitSeconds) || waitSeconds < 1 || waitSeconds > 600) throw new RangeError("waitSeconds: 1 to 600");
  return withShortConnection(url, { name: "promoting the standby", ...STEP_WRITE }, async (c) => {
    if ((await c.query("SELECT pg_is_in_recovery() AS r")).rows[0]!.r !== true) throw new StorageError("invalid_input", "this PostgreSQL node is not a standby; nothing was changed", { path: "url" });
    const done = (await c.query("SELECT pg_promote(true, $1) AS ok", [waitSeconds])).rows[0]!.ok === true;
    if (!done) throw new StorageError("retryable", `the standby did not become writable within ${waitSeconds} s; check the node (it may still be replaying) before trying again`);
    return { promoted: true as const, positionLsn: (await c.query("SELECT pg_current_wal_lsn()::text AS lsn")).rows[0]!.lsn as string };
  });
}

/**
 * The first of `urls`, in order, that is a writable primary (not in recovery, not read-only), with what was found at each: where the controller reconnects after a failover, so it
 * never writes through a standby by accident and never takes a node that does not answer. A node that does not answer is `unreachable`, never skipped silently.
 */
export async function findWritablePrimary(urls: readonly string[]): Promise<{ readonly url?: string; readonly found: readonly { readonly index: number; readonly role: "writable" | "standby" | "read_only" | "unreachable"; readonly reason?: string }[] }> {
  const found: { index: number; role: "writable" | "standby" | "read_only" | "unreachable"; reason?: string }[] = [];
  for (let index = 0; index < urls.length; index++) {
    try {
      const facts = await probeNode(urls[index]!);
      const role = facts.inRecovery ? "standby" : facts.writable ? "writable" : "read_only";
      found.push({ index, role });
      if (role === "writable") return { url: urls[index]!, found };
    } catch (error) {
      found.push({ index, role: "unreachable", reason: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
    }
  }
  return { found };
}

/** What a node's controller schema holds, read without writing anything (a standby is read-only, so `PostgresStorage.open`, which may create a schema, is not used on it). */
export interface ControllerStateReader {
  watermark(): Promise<{ readonly epoch: number; readonly auditSeq: number; readonly deliverySeq: number }>;
  aggregates(): AsyncIterable<{ readonly kind: string; readonly id: string; readonly revision: number; readonly body?: string }>;
}

/** Reads the controller's tables of `schema` on a node (a standby, or a promoted one) for the recovery check. Each page is its own short read. */
export function readControllerState(url: string, schema: string, options: { readonly withBodies?: boolean; readonly pageSize?: number } = {}): ControllerStateReader {
  if (!SCHEMA_NAME.test(schema)) throw new StorageError("invalid_input", "schema: lower-case letters, digits and underscores", { path: "schema" });
  const pageSize = options.pageSize ?? 500;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 10_000) throw new StorageError("invalid_input", "pageSize: a whole number from 1 to 10000", { path: "pageSize" });
  const q = `"${schema}"`;
  return {
    watermark: () => withShortConnection(url, { name: "reading the controller's watermark", ...STEP }, async (c: pg.Client) => {
      const row = (await c.query(`SELECT s.epoch::text AS epoch, c.audit_seq::text AS audit_seq, c.delivery_seq::text AS delivery_seq FROM ${q}.state s, ${q}.counters c`)).rows[0] as Record<string, string> | undefined;
      if (row === undefined) throw new StorageError("not_found", `schema ${schema} has no controller state on this node`);
      return { epoch: Number(row.epoch), auditSeq: Number(row.audit_seq), deliverySeq: Number(row.delivery_seq) };
    }),
    aggregates: async function* () {
      let after: [string, string] | undefined;
      for (;;) {
        const rows = await withShortConnection(url, { name: "reading the controller's records", ...STEP }, async (c: pg.Client) =>
          (await c.query(
            `SELECT kind, id, revision::text AS revision${options.withBodies === true ? ", body" : ""} FROM ${q}.aggregates
              WHERE ($1::text IS NULL OR (kind COLLATE "C", id COLLATE "C") > ($1::text, $2::text)) ORDER BY kind COLLATE "C", id COLLATE "C" LIMIT ${pageSize}`, [after?.[0] ?? null, after?.[1] ?? null])).rows as Record<string, string>[]);
        for (const r of rows) yield { kind: r.kind!, id: r.id!, revision: Number(r.revision), ...(options.withBodies === true ? { body: r.body! } : {}) };
        if (rows.length < pageSize) return;
        const last = rows[rows.length - 1]!;
        after = [last.kind!, last.id!];
      }
    },
  };
}
