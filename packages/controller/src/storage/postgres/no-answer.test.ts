import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { isStorageError } from "../index.js";
import { MIGRATIONS, PostgresNoAnswer, PostgresStorage, discardPostgresTransferCopy, dropPostgresSchema, postgresDatabaseBytes, postgresRestorePort, postgresSchemaExists, stagedSchemaOf } from "./index.js";
import { REPLY_MARGIN_MS, SHORT_CONNECT_MS, SHORT_STATEMENT_MS, answeredOrCut } from "./connection.js";
import { PROBE_EVERY_MS, PROBE_MISSES } from "./storage.js";
import { FaultProxy } from "./testing/proxy.js";
import { startTestServer, withClient, type TestServer } from "./testing/server.js";

// Follow-up of card 19: the transfer and restore helpers (admin.ts, restore-swap.ts) and the schema upgrade phase had no client-side limit, so a server that stopped
// answering (a paused host, a silent network) made an owner's transfer or restore step wait for ever. Every bound here is a bound on silence, never on how long a live
// step takes. The server is a disposable embedded one; `testing/proxy.ts` plays the paused server (freeze) and the silent connection (silent).

let serverPromise: Promise<TestServer> | undefined;
const server = (): Promise<TestServer> => (serverPromise ??= startTestServer());
after(async () => { if (serverPromise !== undefined) await (await serverPromise).stop(); });

let counter = 0;
const schemaName = (): string => `na_${process.pid}_${counter++}_${Math.random().toString(36).slice(2, 6)}`;
const REPLY_MS = SHORT_STATEMENT_MS + REPLY_MARGIN_MS;
/** Slack for a loaded machine on top of each bound; a bound that doubled would still fail it. */
const SLACK_MS = 15_000;

async function viaProxy(): Promise<{ url: string; direct: string; proxy: FaultProxy } | undefined> {
  const s = await server();
  if (s.kind !== "embedded") return undefined; // the proxy needs a local server it can stand in front of
  const real = new URL(s.url());
  const proxy = await FaultProxy.start({ host: "127.0.0.1", port: Number(real.port) });
  const through = new URL(real); through.port = String(proxy.port);
  return { url: through.toString(), direct: s.url(), proxy };
}

/** `call` settles (either way) within `boundMs`; returns its error, or undefined if it succeeded, and how long it took. */
async function settles(what: string, call: Promise<unknown>, boundMs: number): Promise<{ error: unknown; ms: number }> {
  const t0 = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    call.then(() => ({ error: undefined }), (error: unknown) => ({ error })),
    new Promise<"waiting">((resolve) => { timer = setTimeout(() => resolve("waiting"), boundMs); }),
  ]);
  clearTimeout(timer);
  assert.notEqual(outcome, "waiting", `${what}: still waiting after ${Date.now() - t0} ms (the bound is ${boundMs} ms)`);
  return { ...(outcome as { error: unknown }), ms: Date.now() - t0 };
}

const noAnswer = (error: unknown, changes: "none" | "unknown"): boolean => error instanceof PostgresNoAnswer && error.changes === changes && /did not answer .* it may be paused, overloaded or unreachable/.test(error.message);
const sockets = (): number => process.getActiveResourcesInfo().filter((r) => r === "TCPSocketWrap").length;
const exists = (url: string, schema: string): Promise<boolean> => withClient(url, async (c) => (await c.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [schema])).rows.length > 0);

test("on a frozen server every transfer and restore helper fails within its bound as 'did not answer', changes nothing and leaves nothing open", async () => {
  const rig = await viaProxy();
  if (rig === undefined) return;
  const schema = schemaName();
  const stamp = "20261111T120000Z";
  const staged = stagedSchemaOf(schema, stamp);
  try {
    await (await PostgresStorage.open({ connectionString: rig.direct, schema })).close(); // a transfer's fresh copy: its state row is the open's own
    const before = sockets();
    rig.proxy.freeze();
    const port = postgresRestorePort(rig.url);
    const steps: [string, Promise<unknown>][] = [
      ["size", postgresDatabaseBytes(rig.url)],
      ["discard", discardPostgresTransferCopy(rig.url, schema, "transfer-pending:x")],
      ["schema exists", postgresSchemaExists(rig.url, schema)],
      ["port.exists", port.exists(schema)],
      ["port.controllersConnected", port.controllersConnected(schema)],
      ["port.swap", port.swap({ live: schema, staged, aside: `${schema}_br_${stamp.toLowerCase()}` })],
      ["port.dropStaged", port.dropStaged(schema, staged)],
      ["port.keptSchemas", port.keptSchemas!(schema)],
      ["port.swapRefusal", port.swapRefusal!(schema)],
      ["port.swapMade", port.swapMade!({ live: schema, staged, aside: `${schema}_br_${stamp.toLowerCase()}` })],
    ];
    for (const [what, call] of steps) {
      const { error } = await settles(what, call, SHORT_CONNECT_MS + SLACK_MS);
      assert.ok(noAnswer(error, "none"), `${what}: ${String(error)}`);
      assert.match((error as Error).message, /Nothing was changed; try again when the server answers/, what);
    }
    await rig.proxy.stop(); // the frozen relay's own sockets (it keeps them open, like a paused server) go; none of the helpers' may be left
    await sleep(200);
    assert.ok(sockets() <= before, `${sockets() - before} connection(s) left open`);
    assert.equal(await exists(rig.direct, schema), true, "the destination schema is untouched");
  } finally { await rig.proxy.stop(); await dropPostgresSchema(rig.direct, schema); }
});

test("a statement the server never answers ends the step at once at its bound: a discard drops nothing, a swap is made entirely or not at all", async () => {
  const rig = await viaProxy();
  if (rig === undefined) return;
  const live = schemaName();
  const stamp = "20261111T120100Z";
  const s = { live, staged: stagedSchemaOf(live, stamp), aside: `${live}_br_${stamp.toLowerCase()}` };
  const copy = schemaName();
  try {
    // 1. Discard: the DROP inside the transaction is never answered. The step ends at its reply bound, not twice that (the queued ROLLBACK does not wait again).
    await (await PostgresStorage.open({ connectionString: rig.direct, schema: copy })).close();
    rig.proxy.inject({ match: /DROP TABLE/, when: "silent" });
    const discard = await settles("discard", discardPostgresTransferCopy(rig.url, copy, "transfer-pending:x"), REPLY_MS + SLACK_MS);
    assert.ok(noAnswer(discard.error, "unknown"), String(discard.error));
    assert.ok(discard.ms >= REPLY_MS - 1000, `not cut before the server's own limit and the margin (${discard.ms} ms)`);
    assert.match((discard.error as Error).message, /not known \(it is made entirely or not at all\); try again when the server answers/);
    await sleep(500); // the server notices the dropped connection and rolls the transaction back
    assert.equal(await withClient(rig.direct, async (c) => (await c.query("SELECT to_regclass($1)::text AS t", [`${copy}.state`])).rows[0]?.t), `${copy}.state`, "nothing was dropped");
    await discardPostgresTransferCopy(rig.direct, copy, "transfer-pending:x"); // the retry the message asks for
    assert.equal(await exists(rig.direct, copy), false);

    // 2. Swap: the server runs the COMMIT and its answer never comes. The swap was made, entirely.
    await withClient(rig.direct, async (c) => { await c.query(`CREATE SCHEMA ${s.live}`); await c.query(`CREATE SCHEMA ${s.staged}`); });
    rig.proxy.inject({ match: /^Q[\s\S]{4}COMMIT\0/, when: "silent" });
    const swap = await settles("swap, COMMIT unanswered", postgresRestorePort(rig.url).swap(s), REPLY_MS + SLACK_MS);
    assert.ok(noAnswer(swap.error, "unknown"), String(swap.error));
    assert.deepEqual([await exists(rig.direct, s.live), await exists(rig.direct, s.staged), await exists(rig.direct, s.aside)], [true, false, true], "swapped entirely");
    await postgresRestorePort(rig.direct).unswap(s);

    // 3. Swap: the second rename is never answered (before the COMMIT). Nothing was swapped.
    rig.proxy.inject({ match: /ALTER SCHEMA nnrs_/, when: "silent" });
    const half = await settles("swap, a rename unanswered", postgresRestorePort(rig.url).swap(s), REPLY_MS + SLACK_MS);
    assert.ok(noAnswer(half.error, "unknown"), String(half.error));
    await sleep(500);
    assert.deepEqual([await exists(rig.direct, s.live), await exists(rig.direct, s.staged), await exists(rig.direct, s.aside)], [true, true, false], "not swapped at all");
  } finally {
    await rig.proxy.stop();
    for (const name of [copy, s.live, s.staged, s.aside]) await withClient(rig.direct, async (c) => { await c.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`); });
  }
});

test("a swap whose COMMIT never reaches the server (the network went silent first) does not leave its transaction holding the swap's lock: the server ends it", async () => {
  const rig = await viaProxy();
  if (rig === undefined) return;
  const live = schemaName();
  const stamp = "20261111T120200Z";
  const s = { live, staged: stagedSchemaOf(live, stamp), aside: `${live}_br_${stamp.toLowerCase()}` };
  try {
    await withClient(rig.direct, async (c) => { await c.query(`CREATE SCHEMA ${s.live}`); await c.query(`CREATE SCHEMA ${s.staged}`); });
    rig.proxy.inject({ match: /^Q[\s\S]{4}COMMIT\0/, when: "hold" });
    const swap = await settles("swap, COMMIT never arrives", postgresRestorePort(rig.url).swap(s), REPLY_MS + SLACK_MS);
    assert.ok(noAnswer(swap.error, "unknown"), String(swap.error));
    // The server still has the transaction (renames made, lock held) and never heard the client go. It must end it itself, within the same bound.
    const port = postgresRestorePort(rig.direct);
    const t0 = Date.now();
    let made: unknown;
    for (;;) {
      made = await port.swapMade!(s).catch((error: unknown) => error);
      if (typeof made === "boolean" || Date.now() - t0 > REPLY_MS + SLACK_MS) break;
      await sleep(1000);
    }
    assert.equal(made, false, `the abandoned swap still held its lock ${Date.now() - t0} ms later: ${String(made)}`);
    assert.deepEqual([await exists(rig.direct, s.live), await exists(rig.direct, s.staged), await exists(rig.direct, s.aside)], [true, true, false], "not swapped at all");
  } finally {
    await rig.proxy.stop();
    for (const name of [s.live, s.staged, s.aside]) await withClient(rig.direct, async (c) => { await c.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`); });
  }
});

test("a helper step that waits longer than the margin but is answered is not cut (a discard waiting for a lock)", async () => {
  const rig = await viaProxy();
  if (rig === undefined) return;
  const copy = schemaName();
  try {
    await (await PostgresStorage.open({ connectionString: rig.direct, schema: copy })).close();
    const { default: pg } = await import("pg");
    const holder = new pg.Client({ connectionString: rig.direct });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT 1 FROM ${copy}.state FOR UPDATE`);
      const discard = discardPostgresTransferCopy(rig.url, copy, "transfer-pending:x");
      await sleep(REPLY_MARGIN_MS + 4000); // longer than the margin: a limit on the margin alone would cut it
      await holder.query("ROLLBACK");
      const { error } = await settles("discard after the lock wait", discard, SLACK_MS);
      assert.equal(error, undefined, String(error));
    } finally { await holder.end(); }
    assert.equal(await exists(rig.direct, copy), false, "the copy was removed");
  } finally { await rig.proxy.stop(); await dropPostgresSchema(rig.direct, copy); }
});

test("a discard whose drop waits past the server's statement limit for another session's lock says the schema is in use, not that it holds foreign objects", async () => {
  const s = await server();
  const copy = schemaName();
  try {
    await (await PostgresStorage.open({ connectionString: s.url(), schema: copy })).close();
    const { default: pg } = await import("pg");
    const holder = new pg.Client({ connectionString: s.url() });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT 1 FROM ${copy}.state`); // a reader's lock: the DROP waits for it until the server's own limit stops it
      const { error } = await settles("discard behind a reader", discardPostgresTransferCopy(s.url(), copy, "transfer-pending:x"), SHORT_STATEMENT_MS + SLACK_MS);
      assert.match(String((error as Error | undefined)?.message), /is in use by another session .* nothing was dropped; try again when it is free/);
      await holder.query("ROLLBACK");
    } finally { await holder.end(); }
    assert.equal(await exists(s.url(), copy), true, "nothing was dropped");
  } finally { await dropPostgresSchema(s.url(), copy); }
});

/** This version's migrations with `statement` added to the first one (a transactional migration: it commits with its journal entry, or not at all). */
const withStatement = (statement: string) => MIGRATIONS.map((m, i) => (i === 0 ? { ...m, statements: [...m.statements, statement] } : m));

test("a schema upgrade statement that runs far beyond the statement timeout is not cut while the server answers that its session is there", async () => {
  const rig = await viaProxy();
  if (rig === undefined) return;
  const schema = schemaName();
  const statementTimeoutMs = 1000;
  const runMs = statementTimeoutMs + REPLY_MARGIN_MS + 2 * PROBE_EVERY_MS + 2000; // past the usual reply deadline, with probes on the way
  try {
    rig.proxy.trace = [];
    const t0 = Date.now();
    const store = await PostgresStorage.open({ connectionString: rig.url, schema, statementTimeoutMs, connectTimeoutMs: 2000, migrations: withStatement(`SELECT pg_sleep(${runMs / 1000})`) });
    const took = Date.now() - t0;
    await store.close();
    assert.ok(took >= runMs, `the long statement ran to its end (${took} ms)`);
    const probes = rig.proxy.trace.filter((line) => line.includes("pg_stat_activity")).length;
    assert.ok(probes >= 2, `the session was checked while the statement ran (${probes} probes)`);
  } finally { await rig.proxy.stop(); await dropPostgresSchema(rig.direct, schema); }
});

test("through a pooler that hides the server's process number, a long schema upgrade statement is not cut as a session that is gone", async () => {
  const rig = await viaProxy();
  if (rig === undefined) return;
  const schema = schemaName();
  const statementTimeoutMs = 1000;
  const runMs = statementTimeoutMs + REPLY_MARGIN_MS + 2 * PROBE_EVERY_MS + 2000;
  try {
    rig.proxy.fakeBackendPids = true; // the driver's processID is not a server session's: only the server can say which session the upgrade runs on
    rig.proxy.trace = [];
    const store = await PostgresStorage.open({ connectionString: rig.url, schema, statementTimeoutMs, connectTimeoutMs: 2000, migrations: withStatement(`SELECT pg_sleep(${runMs / 1000})`) });
    await store.close();
    assert.ok(rig.proxy.trace.filter((line) => line.includes("pg_stat_activity")).length >= 2, "the session was checked while the statement ran");
  } finally { await rig.proxy.stop(); await dropPostgresSchema(rig.direct, schema); }
});

test("a schema upgrade on a server that stops answering, or whose session ends unheard, fails as retryable within its bound, and the next start completes it", async () => {
  const rig = await viaProxy();
  if (rig === undefined) return;
  const statementTimeoutMs = 1000;
  const connectTimeoutMs = 2000;
  const stopBackend = () => withClient(rig.direct, async (c) => { await c.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE 'SELECT pg_sleep(600)%' AND pid <> pg_backend_pid()"); });
  const schemas: string[] = [];
  try {
    // 1. Frozen: every connection, the probes' included, gets no answer.
    const frozen = schemaName(); schemas.push(frozen);
    const opening = PostgresStorage.open({ connectionString: rig.url, schema: frozen, statementTimeoutMs, connectTimeoutMs, migrations: withStatement("SELECT pg_sleep(600)") });
    while (!(rig.proxy.trace ??= []).some((l) => l.includes("pg_sleep(600)"))) await sleep(50);
    rig.proxy.freeze();
    const bound = statementTimeoutMs + REPLY_MARGIN_MS + PROBE_MISSES * (connectTimeoutMs + PROBE_EVERY_MS) + SLACK_MS;
    const { error } = await settles("open, frozen during the upgrade", opening, bound);
    assert.ok(isStorageError(error, "retryable") && /stopped answering during the schema upgrade .* start again when the server answers/.test((error as Error).message), String(error));
    await rig.proxy.stop();
    await stopBackend();
    // The upgrade's transaction never committed: an ordinary start upgrades the schema from where it was.
    await (await PostgresStorage.open({ connectionString: rig.direct, schema: frozen })).close();

    // 2. The server ends the session, and the connection never says so (a silent network): the server answers the probe that the session is gone.
    const rig2 = await viaProxy();
    assert.ok(rig2 !== undefined);
    try {
      const gone = schemaName(); schemas.push(gone);
      rig2.proxy.inject({ match: /pg_sleep\(600\)/, when: "silent" });
      const opening2 = PostgresStorage.open({ connectionString: rig2.url, schema: gone, statementTimeoutMs, connectTimeoutMs, migrations: withStatement("SELECT pg_sleep(600)") });
      while (rig2.proxy.fired === 0) await sleep(50);
      await sleep(500);
      await stopBackend();
      const second = await settles("open, its session ended unheard", opening2, statementTimeoutMs + REPLY_MARGIN_MS + PROBE_EVERY_MS + SLACK_MS);
      assert.ok(isStorageError(second.error, "retryable") && /ended the session of the schema upgrade/.test((second.error as Error).message), String(second.error));
    } finally { await rig2.proxy.stop(); }
  } finally {
    await rig.proxy.stop().catch(() => undefined);
    await stopBackend();
    for (const schema of schemas) await dropPostgresSchema(rig.direct, schema);
  }
});

test("the upgrade watch: a probe the server answers with an error keeps the statement, a missed probe is forgiven by the next answer, only that many misses in a row cut", async () => {
  const run = async (answers: (boolean | "error" | "silent")[], settleMs: number): Promise<{ cut: string | undefined; probes: number }> => {
    let cut: string | undefined;
    let probes = 0;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const done = answeredOrCut(pending, {
      quietMs: 10, everyMs: 10, misses: 3,
      probe: async () => {
        const a = answers[Math.min(probes++, answers.length - 1)];
        if (a === "error") throw Object.assign(new Error("sorry, too many clients already"), { code: "53300" });
        if (a === "silent") throw new Error("timeout expired");
        return a as boolean;
      },
      cut: (why) => { cut = why; finish(); },
    });
    const timer = setTimeout(finish, settleMs);
    await done;
    clearTimeout(timer);
    return { cut, probes };
  };
  assert.equal((await run(["error"], 400)).cut, undefined, "a server that answers with an error of its own is alive");
  assert.equal((await run(["silent", "silent", true, "silent", "silent", true], 400)).cut, undefined, "misses that are not in a row do not cut");
  assert.equal((await run([true, "silent", "silent", "silent"], 2000)).cut, "silent");
  assert.equal((await run([true, false], 2000)).cut, "gone");
  const quiet = await run([true], 0); // answered before the first probe is due
  assert.equal(quiet.probes, 0);
});
