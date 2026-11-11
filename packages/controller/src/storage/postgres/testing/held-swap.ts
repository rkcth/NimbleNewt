import { PostgresNoAnswer } from "../connection.js";
import type { PostgresRestorePort, SchemaSwap } from "../restore-swap.js";

/**
 * A restore port whose swap is made as the real one is (migration lock, both renames) and then left to the server: its server process is paused (SIGSTOP) before
 * it reads the COMMIT, the COMMIT is sent into its socket and the client drops the connection, failing the swap as unanswered. The server still holds the
 * transaction; `thaw()` lets the process run again, and it reads the COMMIT and makes the swap. A disposable local test server only: the process is signalled.
 */
export function heldSwapPort(url: string, real: PostgresRestorePort): { port: PostgresRestorePort; thaw(): void } {
  let paused: number | undefined;
  const thaw = (): void => { if (paused !== undefined) { try { process.kill(paused, "SIGCONT"); } catch { /* gone */ } paused = undefined; } };
  const port: PostgresRestorePort = {
    ...real,
    swap: async (sw: SchemaSwap) => {
      const { default: driver } = await import("pg");
      const client = new driver.Client({ connectionString: url, application_name: "nimblenewt-restore" });
      client.on("error", () => undefined);
      await client.connect();
      await client.query("BEGIN");
      if ((await client.query("SELECT pg_try_advisory_xact_lock(7306457, hashtext($1)) AS got", [`nimblenewt:${sw.live}`])).rows[0]?.got !== true) throw new Error("the migration lock is held");
      await client.query(`ALTER SCHEMA ${sw.live} RENAME TO ${sw.aside}`);
      await client.query(`ALTER SCHEMA ${sw.staged} RENAME TO ${sw.live}`);
      paused = Number((await client.query("SELECT pg_backend_pid() AS p")).rows[0]?.p);
      process.kill(paused, "SIGSTOP");
      void client.query("COMMIT").catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 300));
      (client as unknown as { connection: { stream: { destroy(): void } } }).connection.stream.destroy();
      throw new PostgresNoAnswer(`swapping the restored schema ${sw.staged} in as ${sw.live}`, "unknown", 40_000);
    },
  };
  return { port, thaw };
}
