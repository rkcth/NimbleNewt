import { LIVE_LOCK_CLASS, liveLockKey } from "../restore-swap.js";
import { withClient } from "./server.js";

/** Tests only (card K01i): ends every session holding the live lock of `schema`, as a lost connection would. */
export async function terminateLiveLockHolders(url: string, schema: string): Promise<number> {
  return withClient(url, async (c) => (await c.query("SELECT pg_terminate_backend(pid) AS t FROM pg_locks WHERE locktype = 'advisory' AND classid = $1::int4::oid AND objid = hashtext($2)::oid AND objsubid = 2", [LIVE_LOCK_CLASS, liveLockKey(schema)])).rows.length);
}

/** Tests only (third review of card K01i): the sessions holding (granted) or waiting for (not granted) the live lock of `schema` in `mode`. */
export async function liveLockCount(url: string, schema: string, mode: "ShareLock" | "ExclusiveLock", granted: boolean): Promise<number> {
  return withClient(url, async (c) => Number((await c.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND classid = $1::int4::oid AND objid = hashtext($2)::oid AND objsubid = 2 AND mode = $3 AND granted = $4",
    [LIVE_LOCK_CLASS, liveLockKey(schema), mode, granted])).rows[0].n));
}

/** Tests only: ends the sessions that hold the live lock of `schema` shared (the storages that have it open), leaving any session queued for it. */
export async function terminateSharedLiveLockHolders(url: string, schema: string): Promise<number> {
  return withClient(url, async (c) => (await c.query("SELECT pg_terminate_backend(pid) AS t FROM pg_locks WHERE locktype = 'advisory' AND classid = $1::int4::oid AND objid = hashtext($2)::oid AND objsubid = 2 AND mode = 'ShareLock' AND granted", [LIVE_LOCK_CLASS, liveLockKey(schema)])).rows.length);
}
