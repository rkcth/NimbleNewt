/**
 * Client-side limits for every connection NimbleNewt opens to PostgreSQL (card 19, and its follow-up for the transfer and restore helpers).
 * The server bounds the statements it runs (`statement_timeout`, `lock_timeout`); nothing on the server can bound a server that has stopped
 * answering (a paused or hung host, a silent network path). These limits do, without a total time cap: every bound here is "no answer for this
 * long", so a step that takes hours but keeps answering (a big copy is many statements; a long schema upgrade statement is watched for life)
 * is never cut. It lives here because only the storage folders may touch the database driver.
 */

import type pg from "pg";
import { isConnectionLoss, isNoReply } from "./errors.js";

/**
 * How much longer than the server's own statement timeout the client waits for any answer before it gives up on the connection (card 19).
 * Without it a call on an already open connection waits until the operating system gives up on the socket (many minutes on a dead network,
 * for ever on a paused server), and closing waits with it.
 */
export const REPLY_MARGIN_MS = 10_000;

/**
 * How long a closing connection may take to say goodbye before its socket is cut (card 19 review). A graceful end waits for the server to close its side,
 * which a paused or hung server never does. Cutting the socket ends the session the same way for the server: its open transaction, if any, is rolled
 * back and its locks released when it next runs.
 */
export const CLOSE_GRACE_MS = 5_000;

/** TCP keepalive's first probe after this much silence: a host that vanished (no reset ever comes) is found by the operating system instead of never. */
export const KEEPALIVE_IDLE_MS = 10_000;

/** The short connections of the transfer and restore helpers: how long a new connection may take to be ready, and the server's limit on each statement. */
export const SHORT_CONNECT_MS = 10_000;
export const SHORT_STATEMENT_MS = 30_000;

type Socket = { destroyed: boolean; destroy(): void; once(event: "close", listener: () => void): unknown };
export const socketOf = (client: pg.ClientBase): Socket | undefined => (client as unknown as { connection?: { stream?: Socket } }).connection?.stream;

/** Waits up to `ms` for `done`, then calls `cut` and waits for `done` again (it settles once the socket is gone). */
export async function within(done: Promise<unknown>, ms: number, cut: () => void): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const late = await Promise.race([done.then(() => false, () => false), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), ms); })]);
  clearTimeout(timer);
  if (late) { cut(); await done.catch(() => undefined); }
}

/** Ends a connection of our own; one whose server does not answer the goodbye within `CLOSE_GRACE_MS` is cut. */
export async function endConnection(client: pg.Client): Promise<void> {
  await within(client.end().catch(() => undefined), CLOSE_GRACE_MS, () => socketOf(client)?.destroy());
}

/**
 * A step of a transfer or restore that the database server did not answer in time. `changes` says what the owner may assume: `none` (a read, or
 * nothing was sent yet), or `unknown` (a change was sent and may have been made; each of these steps is all or nothing, and the code that repeats
 * it checks what is there first). The connection was dropped; nothing waits on it.
 */
export class PostgresNoAnswer extends Error {
  readonly code = "ENOANSWER";
  /** The first sentence alone (what happened), for messages that say themselves what was done about it. */
  readonly what: string;
  constructor(readonly step: string, readonly changes: "none" | "unknown", readonly waitedMs: number, options?: { cause?: unknown }) {
    const what = `the PostgreSQL server did not answer (${step}) within ${Math.round(waitedMs / 1000)} s: it may be paused, overloaded or unreachable`;
    super(`${what}. ${changes === "none"
      ? "Nothing was changed; try again when the server answers."
      : "Whether this step was made is not known (it is made entirely or not at all); try again when the server answers: the retry checks what is there first."}`, options);
    this.name = "PostgresNoAnswer";
    this.what = what;
  }
}

/** The driver's own messages for a new connection that was not ready in time. */
const CONNECT_TIMEOUT = /timeout expired|connection timeout/i;

/**
 * Runs `work` on a new short connection with client-side limits: the connection must be ready within `SHORT_CONNECT_MS`, each statement is limited by the
 * server to `SHORT_STATEMENT_MS` and must be answered within that plus `REPLY_MARGIN_MS` (so a statement the server is still running is never cut: the
 * server always answers first, with its own timeout), keepalive is on, and the goodbye is bounded by `CLOSE_GRACE_MS`. A statement that is not answered
 * in time drops the connection at once (a ROLLBACK queued after it fails at once instead of waiting a second time) and the step fails as
 * `PostgresNoAnswer`. There is no limit on the whole step: only on silence.
 */
export async function withShortConnection<T>(connectionString: string, step: { name: string; writes: boolean; applicationName?: string }, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const { default: driver } = await import("pg");
  const replyMs = SHORT_STATEMENT_MS + REPLY_MARGIN_MS;
  const client = new driver.Client({
    connectionString, connectionTimeoutMillis: SHORT_CONNECT_MS, statement_timeout: SHORT_STATEMENT_MS, query_timeout: replyMs,
    keepAlive: true, keepAliveInitialDelayMillis: KEEPALIVE_IDLE_MS, ...(step.applicationName === undefined ? {} : { application_name: step.applicationName }),
  });
  client.on("error", () => undefined); // a dropped connection is reported by the statement that was waiting on it
  try { await client.connect(); } catch (error) {
    socketOf(client)?.destroy();
    if (error instanceof Error && CONNECT_TIMEOUT.test(error.message)) throw new PostgresNoAnswer(`opening a connection for ${step.name}`, "none", SHORT_CONNECT_MS, { cause: error });
    throw error;
  }
  let silent = false;
  let sent = false; // a statement that may change something reached the server (anything but a read or the transaction's own BEGIN)
  const raw = client.query.bind(client) as (...args: unknown[]) => Promise<pg.QueryResult>;
  (client as unknown as { query: (...args: unknown[]) => Promise<pg.QueryResult> }).query = (...args: unknown[]) => {
    const text = typeof args[0] === "string" ? args[0] : String((args[0] as { text?: unknown } | undefined)?.text ?? "");
    if (!/^\s*(SELECT|BEGIN|ROLLBACK|COMMIT)\b/i.test(text)) sent = true; // a COMMIT changes something only if a change was sent before it
    return raw(...args).catch((error: unknown) => {
      if (isNoReply(error)) { silent = true; socketOf(client)?.destroy(); }
      throw error;
    });
  };
  try {
    return await work(client);
  } catch (error) {
    if (silent || isNoReply(error)) throw new PostgresNoAnswer(step.name, step.writes && sent ? "unknown" : "none", replyMs, { cause: error });
    throw error;
  } finally {
    if (silent) socketOf(client)?.destroy(); else await endConnection(client);
  }
}

/**
 * Waits for `pending`, a statement that may legitimately run for hours (the schema upgrade phase has no statement timeout), and cuts its connection only
 * when the server has stopped answering. Once the statement has been running for `quietMs` with no answer, `probe` is asked every `everyMs` (on a
 * separate short connection) whether the statement's server session is still there: `true` keeps waiting, `false` (the server answered and the session
 * is gone) or `misses` probes in a row that got no answer at all cut it. The time a statement takes is never itself a reason to cut it.
 * Resolves or rejects like `pending`; after a cut it rejects with the driver's connection error, and `cut` reports why.
 */
export async function answeredOrCut<T>(pending: Promise<T>, o: { quietMs: number; everyMs: number; misses: number; probe: () => Promise<boolean>; cut: (why: "gone" | "silent") => void }): Promise<T> {
  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  const watch = (async () => {
    const pause = (ms: number) => new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); });
    await pause(o.quietMs);
    let missed = 0;
    while (!settled) {
      const answer = await o.probe().then((there) => (there ? "alive" : "gone"), (error: unknown) => (answeredWithError(error) ? "alive" : "silent"));
      if (settled) return;
      if (answer === "alive") missed = 0;
      else if (answer === "gone" || ++missed >= o.misses) { o.cut(answer); return; }
      await pause(o.everyMs);
    }
  })();
  try { return await pending; } finally { settled = true; clearTimeout(timer); void watch; }
}

/** The probe reached a server that answered with an error of its own (too many connections, a permission): it is alive, so the statement is not cut. */
function answeredWithError(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && /^[A-Z0-9]{5}$/.test(code) && !isConnectionLoss(error);
}
