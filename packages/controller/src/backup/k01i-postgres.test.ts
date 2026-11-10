import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ManualTimer } from "../dispatch/testing/timer.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "../api/index.js";
import { asideSchemaOf, postgresRestorePort, stagedSchemaOf, type PostgresRestorePort } from "../storage/postgres/index.js";
import { startTestServer, type TestServer } from "../storage/postgres/testing/server.js";
import { JOURNAL_FILE, PENDING_FILE, applyPendingRestore } from "./staged-restore.js";

// Card K01i: the owner's restore from inside the running controller on PostgreSQL. The backup is restored into a new schema of the same (disposable, embedded test) database; the next start swaps it in with one
// transaction, after the conversation folders, in the same journal.

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

let server: Promise<TestServer> | undefined;
const pg = (): Promise<TestServer> => (server ??= startTestServer());
after(async () => { if (server !== undefined) await (await server).stop(); });

let n = 0;
async function rig() {
  const url = (await pg()).url();
  const schema = `k01i_${process.pid}_${++n}`;
  const d = mkdtempSync(join(tmpdir(), "nn-k01i-"));
  const live = join(d, "pi"); mkdirSync(join(live, "att-1"), { recursive: true });
  writeFileSync(join(live, "att-1", "history.jsonl"), '{"id":1}\n');
  const open = () => startController({ storage: { kind: "postgres", url, schema }, dataDirectory: join(d, "data"), argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer: new ManualTimer(), intervalMs: 1000 },
    backup: { directory: join(d, "backups"), piState: { list: async () => [{ id: "att-1", dir: join(live, "att-1") }] }, restore: { piFinal: (id: string) => join(live, id) } } } as never);
  mkdirSync(join(d, "data"));
  return { url, schema, d, live, open, port: postgresRestorePort(url) };
}

type Controller = Awaited<ReturnType<typeof startController>>;
const call = async (c: Controller, token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
const projectNames = async (c: Controller, token: string): Promise<string> => JSON.stringify((await call(c, token, "project.list", {})).result);

/** Owner, a project in the backup, a project after it, a conversation line after it; the restore is prepared and the controller closed. */
async function prepared(r: Awaited<ReturnType<typeof rig>>): Promise<{ token: string; stamp: string; name: string }> {
  const c = await r.open();
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    await call(c, boot.token, "project.create", { name: "Garden" }, "p1");
    const made = await call(c, boot.token, "backup.now", {}, "b1");
    assert.ok(made.ok, JSON.stringify(made));
    const name = made.result.item.name as string;
    await call(c, boot.token, "project.create", { name: "Late" }, "p2");
    writeFileSync(join(r.live, "att-1", "history.jsonl"), '{"id":1}\n{"id":2}\n');
    const preview = await call(c, boot.token, "backup.restore.preview", { name });
    assert.ok(preview.ok, JSON.stringify(preview));
    assert.match(preview.result.item.steps.join(" "), /new schema of the same PostgreSQL database/);
    const applied = await call(c, boot.token, "backup.restore.apply", { name, confirm: preview.result.item.token }, "r1");
    assert.ok(applied.ok, JSON.stringify(applied));
    assert.equal(applied.result.item.restartRequired, true);
    assert.equal((await call(c, boot.token, "project.create", { name: "Blocked" }, "p3")).error.code, "unavailable");
    const status = await call(c, boot.token, "backup.restore.status", {});
    const pending = status.result.item.pending;
    assert.equal(pending.database, "postgres");
    assert.ok(!JSON.stringify(status).includes("nn-test-password"), "the address (with its password) is never shown");
    assert.equal(await r.port.exists(stagedSchemaOf(r.schema, pending.stamp)), true);
    return { token: boot.token, stamp: pending.stamp, name };
  } finally { await c.close(); }
}

test("a restore on PostgreSQL is staged in a new schema and swapped in at the next start, with the conversation folders; the old schema is kept aside (card K01i)", async () => {
  const r = await rig();
  try {
    const { token, stamp } = await prepared(r);
    // Nothing of the live data changed before the restart.
    assert.equal(readFileSync(join(r.live, "att-1", "history.jsonl"), "utf8"), '{"id":1}\n{"id":2}\n');
    const c = await r.open();
    try {
      const names = await projectNames(c, token);
      assert.ok(names.includes("Garden")); assert.equal(names.includes("Late"), false);
      assert.equal(readFileSync(join(r.live, "att-1", "history.jsonl"), "utf8"), '{"id":1}\n');
      assert.equal(await r.port.exists(stagedSchemaOf(r.schema, stamp)), false);
      assert.equal(await r.port.exists(asideSchemaOf(r.schema, stamp)), true, "the schema as it was is kept, renamed aside");
      assert.ok(existsSync(join(r.live, `att-1.before-restore-${stamp}`)));
      assert.equal(existsSync(join(r.d, "data", PENDING_FILE)), false);
      assert.equal(existsSync(join(r.d, "data", JOURNAL_FILE)), false);
      // The controller works on the restored schema.
      assert.equal((await call(c, token, "project.create", { name: "After" }, "p9")).ok, true);
    } finally { await c.close(); }
  } finally { rmSync(r.d, { recursive: true, force: true }); }
});

test("the swap waits for no other controller: a start while one is connected to the database is refused and the restore stays recorded and is applied once it has gone; a marker for another schema is refused (card K01i)", async () => {
  const r = await rig();
  try {
    const { token, stamp } = await prepared(r);
    // Another controller connected to the database (another installation's schema in the same database counts too: provisional).
    const other = await startController({ storage: { kind: "postgres", url: r.url, schema: `${r.schema}_other` }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [] } as never);
    try {
      await assert.rejects(applyPendingRestore(join(r.d, "data"), { postgres: { url: r.url, schema: r.schema } }, () => undefined, { piFinal: (id) => join(r.live, id), controllersGoneMs: 300 }), /another controller is connected/);
    } finally { await other.close(); }
    assert.equal(existsSync(join(r.d, "data", PENDING_FILE)), true);
    assert.equal(await r.port.exists(stagedSchemaOf(r.schema, stamp)), true);
    assert.equal(readFileSync(join(r.live, "att-1", "history.jsonl"), "utf8"), '{"id":1}\n{"id":2}\n', "nothing was moved");
    // The marker belongs to this schema: a start of another schema with the same data directory refuses it.
    await assert.rejects(applyPendingRestore(join(r.d, "data"), { postgres: { url: r.url, schema: `${r.schema}_x` } }, () => undefined, { piFinal: (id) => join(r.live, id) }), /not for this database/);
    // Once the other controller has gone, the next start applies it.
    const c = await r.open();
    try {
      const names = await projectNames(c, token);
      assert.ok(names.includes("Garden")); assert.equal(names.includes("Late"), false);
    } finally { await c.close(); }
  } finally { rmSync(r.d, { recursive: true, force: true }); }
});

test("cancel withdraws a PostgreSQL restore: the staged schema is dropped, the barrier comes down, the live schema is untouched (card K01i)", async () => {
  const r = await rig();
  try {
    const c = await r.open();
    try {
      const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
      await call(c, boot.token, "project.create", { name: "Garden" }, "p1");
      const name = (await call(c, boot.token, "backup.now", {}, "b1")).result.item.name as string;
      const preview = await call(c, boot.token, "backup.restore.preview", { name });
      assert.ok((await call(c, boot.token, "backup.restore.apply", { name, confirm: preview.result.item.token }, "r1")).ok);
      const stamp = (await call(c, boot.token, "backup.restore.status", {})).result.item.pending.stamp as string;
      assert.equal(await r.port.exists(stagedSchemaOf(r.schema, stamp)), true);
      const cancelled = await call(c, boot.token, "backup.restore.cancel", {}, "r2");
      assert.equal(cancelled.result.cancelled, true, JSON.stringify(cancelled));
      assert.equal(cancelled.result.leftovers, undefined);
      assert.equal(await r.port.exists(stagedSchemaOf(r.schema, stamp)), false);
      assert.equal((await call(c, boot.token, "project.create", { name: "After cancel" }, "p2")).ok, true);
    } finally { await c.close(); }
  } finally { rmSync(r.d, { recursive: true, force: true }); }
});

test("a schema swap that fails is undone with the folder moves before it, and the failure is recorded; a swap committed just before a failure is undone too (card K01i)", async () => {
  const r = await rig();
  try {
    const { token, stamp } = await prepared(r);
    const real = r.port;
    // 1. The swap transaction fails: the conversation folders already moved come back.
    const failing: PostgresRestorePort = { ...real, swap: async () => { throw Object.assign(new Error("lock timeout"), { code: "55P03" }); } };
    const out: string[] = [];
    assert.equal(await applyPendingRestore(join(r.d, "data"), { postgres: { url: r.url, schema: r.schema, port: failing } }, (l) => out.push(l), { piFinal: (id) => join(r.live, id) }), undefined);
    assert.match(out.join("\n"), /could not be applied \(55P03/);
    assert.equal(readFileSync(join(r.live, "att-1", "history.jsonl"), "utf8"), '{"id":1}\n{"id":2}\n');
    assert.equal(existsSync(join(r.live, `att-1.before-restore-${stamp}`)), false);
    assert.equal(await real.exists(stagedSchemaOf(r.schema, stamp)), true);
    const marker = JSON.parse(readFileSync(join(r.d, "data", PENDING_FILE), "utf8"));
    assert.equal(marker.failed.rolledBack, true);
    // A start with the failed marker runs on the data it had.
    const c = await r.open();
    try { assert.ok((await projectNames(c, token)).includes("Late")); } finally { await c.close(); }
  } finally { rmSync(r.d, { recursive: true, force: true }); }

  const r2 = await rig();
  try {
    const { stamp } = await prepared(r2);
    // 2. The swap commits and then the connection fails before the journal records it: the rollback finds it made and undoes it.
    const committedThenLost: PostgresRestorePort = { ...r2.port, swap: async (s) => { await r2.port.swap(s); throw Object.assign(new Error("connection lost"), { code: "ECONNRESET" }); } };
    assert.equal(await applyPendingRestore(join(r2.d, "data"), { postgres: { url: r2.url, schema: r2.schema, port: committedThenLost } }, () => undefined, { piFinal: (id) => join(r2.live, id) }), undefined);
    assert.equal(await r2.port.exists(stagedSchemaOf(r2.schema, stamp)), true, "the staged schema has its own name again");
    assert.equal(await r2.port.exists(asideSchemaOf(r2.schema, stamp)), false);
    assert.equal(readFileSync(join(r2.live, "att-1", "history.jsonl"), "utf8"), '{"id":1}\n{"id":2}\n');
  } finally { rmSync(r2.d, { recursive: true, force: true }); }
});

test("a rollback that stops after the schema swap committed is continued by the next start, which puts the schema and the folders back (card K01i)", async () => {
  const r = await rig();
  try {
    const { token, stamp } = await prepared(r);
    // The swap commits, the run fails, and its rollback cannot undo the swap (the connection is gone): the start throws, the journal is left in "back" mode.
    const dies: PostgresRestorePort = { ...r.port, swap: async (s) => { await r.port.swap(s); throw new Error("process ended"); }, unswap: async () => { throw new Error("process ended"); } };
    await assert.rejects(applyPendingRestore(join(r.d, "data"), { postgres: { url: r.url, schema: r.schema, port: dies } }, () => undefined, { piFinal: (id) => join(r.live, id) }), /could not be undone/);
    assert.equal(existsSync(join(r.d, "data", JOURNAL_FILE)), true);
    // The next start rolls the journal back from where it stopped (the journal is in "back" mode): everything is as it was, and the failure recorded.
    const c = await r.open();
    try { assert.ok((await projectNames(c, token)).includes("Late")); } finally { await c.close(); }
    assert.equal(await r.port.exists(stagedSchemaOf(r.schema, stamp)), true);
    assert.equal(JSON.parse(readFileSync(join(r.d, "data", PENDING_FILE), "utf8")).failed.rolledBack, true);
  } finally { rmSync(r.d, { recursive: true, force: true }); }
});
