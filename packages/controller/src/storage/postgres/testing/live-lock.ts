import { LIVE_LOCK_CLASS, liveLockKey } from "../restore-swap.js";
import { withClient } from "./server.js";

/** Tests only (card K01i): ends every session holding the live lock of `schema`, as a lost connection would. */
export async function terminateLiveLockHolders(url: string, schema: string): Promise<number> {
  return withClient(url, async (c) => (await c.query("SELECT pg_terminate_backend(pid) AS t FROM pg_locks WHERE locktype = 'advisory' AND classid = $1::int4::oid AND objid = hashtext($2)::oid AND objsubid = 2", [LIVE_LOCK_CLASS, liveLockKey(schema)])).rows.length);
}
