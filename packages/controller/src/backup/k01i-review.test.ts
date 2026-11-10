import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ManualTimer } from "../dispatch/testing/timer.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "../api/index.js";
import { SqliteStorage } from "../storage/index.js";
import { PostgresStorage, postgresRestorePort, stagedSchemaOf, type PostgresRestorePort } from "../storage/postgres/index.js";
import { withControllerApplication } from "../storage/postgres/storage.js";
import { startTestServer, withClient, type TestServer } from "../storage/postgres/testing/server.js";
import { BackupService, MaintenanceBarrier, StagedRestore } from "./index.js";
import { PENDING_FILE, applyPendingRestore } from "./staged-restore.js";

// Review of card K01i: each test fails without its fix. PostgreSQL tests use the disposable embedded test server.

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const AT = "2026-10-31T10:00:00.000Z";
const EMPTY = { outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] };

let server: Promise<TestServer> | undefined;
const pg = (): Promise<TestServer> => (server ??= startTestServer());
after(async () => { if (server !== undefined) await (await server).stop(); });

type Controller = Awaited<ReturnType<typeof startController>>;
const call = async (c: Controller, token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;

let n = 0;
async function rig(url?: string) {
  const base = url ?? (await pg()).url();
  const schema = `k01ir_${process.pid}_${++n}`;
  const d = mkdtempSync(join(tmpdir(), "nn-k01ir-"));
  mkdirSync(join(d, "data"));
  const open = (u = base) => startController({ storage: { kind: "postgres", url: u, schema }, dataDirectory: join(d, "data"), argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer: new ManualTimer(), intervalMs: 1000 },
    backup: { directory: join(d, "backups") } } as never);
  return { url: base, schema, d, open };
}

async function stage(c: Controller): Promise<{ token: string; name: string; applied: any }> {
  const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
  await call(c, boot.token, "project.create", { name: "Garden" }, "p1");
  const name = (await call(c, boot.token, "backup.now", {}, "b1")).result.item.name as string;
  const preview = await call(c, boot.token, "backup.restore.preview", { name });
  const applied = await call(c, boot.token, "backup.restore.apply", { name, confirm: preview.result.item.token }, "r1");
  return { token: boot.token, name, applied };
}

test("a controller whose address names its own application_name still counts as connected: the swap is not made under it (finding 1)", async () => {
  const r = await rig();
  try {
    const c = await r.open();
    let stamp: string;
    try {
      const { token, applied } = await stage(c);
      assert.ok(applied.ok, JSON.stringify(applied));
      stamp = (await call(c, token, "backup.restore.status", {})).result.item.pending.stamp;
    } finally { await c.close(); }
    // A running controller of the live schema whose address sets application_name (the driver lets the address override the pool's own setting).
    const named = new URL(r.url); named.searchParams.set("application_name", "my-own-name");
    assert.equal(new URL(withControllerApplication(named.toString())).searchParams.has("application_name"), false);
    const running = await PostgresStorage.open({ connectionString: named.toString(), schema: r.schema });
    try {
      await running.currentEpoch();
      await assert.rejects(applyPendingRestore(join(r.d, "data"), { postgres: { url: r.url, schema: r.schema } }, () => undefined, { controllersGoneMs: 300 }), /another controller is connected/);
    } finally { await running.close(); }
    assert.equal(existsSync(join(r.d, "data", PENDING_FILE)), true, "the restore stays recorded");
    assert.equal(await postgresRestorePort(r.url).exists(stagedSchemaOf(r.schema, stamp)), true, "nothing was swapped");
  } finally { rmSync(r.d, { recursive: true, force: true }); }
});

test("a role that does not own the live schema is refused when the restore is prepared, plainly, not at the restart (finding 2)", async () => {
  const base = (await pg()).url();
  const role = `k01ir_role_${process.pid}`;
  const r0 = await rig(base);
  // The schema is made by the administrator (the test server's superuser) and the controller's role is given every right on it but not its ownership.
  await withClient(base, async (c) => {
    await c.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await c.query(`CREATE ROLE ${role} LOGIN PASSWORD 'role-pass'`);
    await c.query(`GRANT CREATE ON DATABASE ${new URL(base).pathname.slice(1)} TO ${role}`);
    await c.query(`CREATE SCHEMA ${r0.schema}`);
    await c.query(`GRANT ALL ON SCHEMA ${r0.schema} TO ${role}`);
  });
  const asRole = new URL(base); asRole.username = role; asRole.password = "role-pass";
  const port = postgresRestorePort(asRole.toString());
  assert.match((await port.swapRefusal!(r0.schema))!, /does not own the schema/);
  try {
    const c = await r0.open(asRole.toString());
    try {
      const { applied } = await stage(c);
      assert.equal(applied.ok, false, JSON.stringify(applied));
      assert.equal(applied.error.code, "unavailable");
      assert.match(applied.error.message, /does not own the schema/);
      assert.ok(!applied.error.message.includes("role-pass") && !applied.error.message.includes("127.0.0.1"), "neither the password nor the server is named");
      assert.equal(existsSync(join(r0.d, "data", PENDING_FILE)), false);
    } finally { await c.close(); }
    // Owning it, the same role may.
    await withClient(base, async (c) => { await c.query(`ALTER SCHEMA ${r0.schema} OWNER TO ${role}`); });
    assert.equal(await port.swapRefusal!(r0.schema), undefined);
  } finally {
    await withClient(base, async (c) => { await c.query(`DROP SCHEMA IF EXISTS ${r0.schema} CASCADE`); await c.query(`REVOKE ALL ON DATABASE ${new URL(base).pathname.slice(1)} FROM ${role}`); await c.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined); }).catch(() => undefined);
    rmSync(r0.d, { recursive: true, force: true });
  }
});

test("a swap refused at the start for lack of rights is recorded in plain words (finding 2)", async () => {
  const r = await rig();
  try {
    const c = await r.open();
    try { assert.ok((await stage(c)).applied.ok); } finally { await c.close(); }
    const real = postgresRestorePort(r.url);
    const denied: PostgresRestorePort = { ...real, swap: async () => { throw Object.assign(new Error("must be owner of schema x"), { code: "42501" }); } };
    const out: string[] = [];
    assert.equal(await applyPendingRestore(join(r.d, "data"), { postgres: { url: r.url, schema: r.schema, port: denied } }, (l) => out.push(l)), undefined);
    assert.match(out.join("\n"), /may not rename the schema/);
  } finally { rmSync(r.d, { recursive: true, force: true }); }
});

test("an apply that fails after the restore was staged withdraws it and makes no automatic restart (finding 3)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-k01ir-sq-"));
  try {
    const data = join(d, "data"); mkdirSync(data);
    const live = join(d, "live"); mkdirSync(join(live, "att-1"), { recursive: true }); writeFileSync(join(live, "att-1", "h.jsonl"), "{}\n");
    const sqlite = join(data, "c.sqlite");
    const storage = await SqliteStorage.open({ path: sqlite });
    try {
      const { epoch } = await storage.acquireEpoch({ holder: "c1", at: AT });
      await storage.applyOperation({ operationId: "op-1", epoch, actor: "owner:rob", correlationId: "co-1", at: AT, changes: [{ type: "create", ref: { kind: "task", id: "task-1" }, body: { title: "t" } }], audit: [{ type: "task.created", detail: {} }], ...EMPTY } as never);
      let bt = Date.parse(AT);
      const backups = new BackupService(storage, { root: join(d, "b"), version: "t", now: () => new Date(bt += 1000), piState: { list: async () => [{ id: "att-1", dir: join(live, "att-1") }] } });
      const made = await backups.backUpNow("manual");
      const barrier = new MaintenanceBarrier();
      barrier.add({ name: "backups", hold: async () => backups.hold() });
      let snapshots = 0;
      // The plan's schema probe fails the second time it is asked (the one after the restore was staged).
      const flaky = { currentEpoch: () => storage.currentEpoch(), listAudit: (q: never) => storage.listAudit(q), snapshot: async () => { snapshots += 1; if (snapshots === 2) throw new Error("the disk went away"); return storage.snapshot(); } };
      let restarted = 0;
      const sr = new StagedRestore({ backups, root: join(d, "b"), barrier, sqlitePath: sqlite, dataDirectory: data, storage: flaky as never, piFinal: (id) => join(live, id), restart: { automatic: () => { restarted += 1; }, delayMs: 20 } });
      const plan = await sr.preview(made.manifest.name);
      await assert.rejects(sr.apply(plan.name, plan.token), /disk went away/);
      assert.equal(existsSync(join(data, PENDING_FILE)), false, "the restore was withdrawn");
      assert.equal(barrier.state().held, false);
      await new Promise((res) => setTimeout(res, 150));
      assert.equal(restarted, 0, "no restart for a restore that was withdrawn");
    } finally { await storage.close(); }
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a cancel drops only a staged schema of THIS installation: the live schema, the kept one, another installation's staged schema and odd names are refused and left alone", async () => {
  const url = (await pg()).url();
  const live = `k01ir_drop_${process.pid}`;
  const other = `${live}_b`;
  const stamp = "20261031T110000Z";
  const port = postgresRestorePort(url);
  const kept = `${live}_br_${stamp.toLowerCase()}`;
  const mine = stagedSchemaOf(live, stamp);
  const theirs = stagedSchemaOf(other, stamp);
  await withClient(url, async (c) => { for (const s of [live, kept, mine, theirs]) await c.query(`CREATE SCHEMA IF NOT EXISTS ${s}`); });
  try {
    for (const name of [live, kept, theirs, `${mine}x`, `${mine}; DROP SCHEMA ${live}`, `"${mine}"`, mine.toUpperCase(), "public"]) {
      await assert.rejects(port.dropStaged(live, name), /only a staged restore schema of this installation/, name);
    }
    for (const s of [live, kept, theirs, mine]) assert.equal(await port.exists(s), true, s);
    await port.dropStaged(live, mine);
    assert.equal(await port.exists(mine), false);
    await port.dropStaged(live, mine); // gone already is a success
    for (const s of [live, kept, theirs]) assert.equal(await port.exists(s), true, s);
  } finally { await withClient(url, async (c) => { for (const s of [live, kept, mine, theirs]) await c.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`); }); }
});

test("the swap's own transaction checks again: a controller that connected after the start's wait, or an open holding the migration lock, makes it refuse and everything is put back", async () => {
  const r = await rig();
  try {
    const c = await r.open();
    let stamp: string;
    try { const { token, applied } = await stage(c); assert.ok(applied.ok); stamp = (await call(c, token, "backup.restore.status", {})).result.item.pending.stamp; } finally { await c.close(); }
    const real = postgresRestorePort(r.url);
    // The start's wait saw nobody; the controller connects between that wait and the swap.
    const lateComer: PostgresRestorePort = { ...real, controllersConnected: async () => 0 };
    const running = await PostgresStorage.open({ connectionString: r.url, schema: r.schema });
    const out: string[] = [];
    try {
      await running.currentEpoch();
      assert.equal(await applyPendingRestore(join(r.d, "data"), { postgres: { url: r.url, schema: r.schema, port: lateComer } }, (l) => out.push(l)), undefined);
    } finally { await running.close(); }
    assert.match(out.join("\n"), /the schema was not swapped: \d+ connection\(s\) of a running controller/);
    assert.equal(await real.exists(stagedSchemaOf(r.schema, stamp)), true, "not swapped");
    // The migration lock of the live schema held by an open in progress: refused too.
    await assert.rejects(withClient(r.url, async (holder) => {
      assert.equal((await holder.query("SELECT pg_try_advisory_lock(7306457, hashtext($1)) AS got", [`nimblenewt:${r.schema}`])).rows[0].got, true);
      await real.swap({ live: r.schema, staged: stagedSchemaOf(r.schema, stamp), aside: `${r.schema}_br_${stamp.toLowerCase()}` });
    }), /migration lock is held/);
    assert.equal(await real.exists(stagedSchemaOf(r.schema, stamp)), true, "not swapped");
  } finally { rmSync(r.d, { recursive: true, force: true }); }
});
