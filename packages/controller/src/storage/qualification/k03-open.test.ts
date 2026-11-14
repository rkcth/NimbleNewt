import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Principal } from "../../security/principals.js";
import { registry, type RegistryName } from "./migration-registry.js";
import type { BeforeUpgrade } from "../snapshot.js";
import { SqliteStorage } from "../sqlite/index.js";
import { PostgresStorage } from "../postgres/index.js";
import { startTestServer, withClient, type TestServer } from "../postgres/testing/server.js";
import type { ControllerStorage } from "../types.js";
import { GATE_FILE, MigrationGuardService, openApprovedContract } from "../../migration/guard.js";

/**
 * Card K03, the start's two-step open with real databases: the database is opened with every destructive migration deferred, and opened again allowing one only when the gate file agrees with the approval
 * the owner recorded in that database. A gate file nobody approved (for example one an agent wrote) leaves the destructive migration waiting, across any number of starts.
 */
let serverPromise: Promise<TestServer> | undefined;
const server = (): Promise<TestServer> => (serverPromise ??= startTestServer());
after(async () => { if (serverPromise !== undefined) await (await serverPromise).stop(); });

type Opener = (migrations: RegistryName, options?: { contractThrough?: number; beforeUpgrade?: BeforeUpgrade }) => Promise<ControllerStorage>;
interface Rig { readonly name: string; setup(): Promise<{ open: Opener; hasNote: () => Promise<boolean>; close: () => Promise<void> }> }

const sqliteRig: Rig = {
  name: "SQLite",
  async setup() {
    const dir = mkdtempSync(join(tmpdir(), "nn-k03o-"));
    const path = join(dir, "c.sqlite");
    const open: Opener = (m, o) => SqliteStorage.open({ path, migrations: registry("sqlite", m), ...(o?.contractThrough === undefined ? {} : { contractThrough: o.contractThrough }), ...(o?.beforeUpgrade === undefined ? {} : { beforeUpgrade: o.beforeUpgrade }) });
    const { DatabaseSync } = await import("node:sqlite");
    const hasNote = async (): Promise<boolean> => { const raw = new DatabaseSync(path); try { return (raw.prepare("SELECT sql FROM sqlite_schema WHERE name = 'aggregates'").get()!.sql as string).includes("note"); } finally { raw.close(); } };
    return { open, hasNote, close: async () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) };
  },
};
let counter = 0;
const postgresRig: Rig = {
  name: "PostgreSQL",
  async setup() {
    const s = await server();
    const schema = `k03o_${process.pid}_${counter++}`;
    const open: Opener = (m, o) => PostgresStorage.open({ connectionString: s.url(), schema, maxConnections: 2, migrations: registry("postgres", m), ...(o?.contractThrough === undefined ? {} : { contractThrough: o.contractThrough }), ...(o?.beforeUpgrade === undefined ? {} : { beforeUpgrade: o.beforeUpgrade }) });
    const hasNote = (): Promise<boolean> => withClient(s.url(), async (c) => (await c.query("SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'aggregates' AND column_name = 'note'", [schema])).rows.length === 1);
    return { open, hasNote, close: async () => { await withClient(s.url(), async (c) => { await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }); } };
  },
};

const OWNER = { id: "owner:rob", kind: "owner", name: "rob", grants: [] } as unknown as Principal;
const versionOf = async (s: ControllerStorage): Promise<number> => { const snap = await s.snapshot(); try { return snap.schemaVersion; } finally { await snap.close(); } };

for (const rig of [sqliteRig, postgresRig]) {
  test(`${rig.name}: the start runs a destructive migration only when the gate file agrees with the owner's approval in the database (K03)`, async () => {
    const r = await rig.setup();
    const dir = mkdtempSync(join(tmpdir(), "nn-k03g-"));
    const gateFile = join(dir, GATE_FILE);
    const printed: string[] = [];
    const hooks: { from: number; to: number }[] = [];
    const beforeUpgrade: BeforeUpgrade = async (n) => { hooks.push({ from: n.from, to: n.to }); await (await n.snapshot()).close(); };
    const reopened: number[] = [];
    const start = async (): Promise<ControllerStorage> => openApprovedContract({ storage: await r.open("v12345", { beforeUpgrade }), gateFile, migrations: registry("sqlite", "v12345"), print: (l) => printed.push(l), reopen: (contractThrough) => { reopened.push(contractThrough); return r.open("v12345", { contractThrough, beforeUpgrade }); } });
    try {
      await (await r.open("v123")).close();
      // a gate file nobody approved: the destructive v4 (and v5 behind it) wait, start after start
      writeFileSync(gateFile, JSON.stringify({ v: 1, through: 4, approvedBy: OWNER.id, approvedAt: "2026-11-01T00:00:00.000Z" }));
      for (let i = 0; i < 2; i++) {
        const s = await start();
        try { assert.equal(await versionOf(s), 3); } finally { await s.close(); }
      }
      assert.equal(await r.hasNote(), true, "nothing was dropped");
      assert.equal(printed.length, 2); assert.match(printed[0]!, /does not match the approval recorded by the owner/);
      assert.ok(!printed.join().includes(dir), "the note names no host path");
      assert.deepEqual(hooks, [], "no snapshot for a start that only finds deferred work");
      // the owner approves (the guard writes the record and the file); the next start runs v4 and v5, after a snapshot
      {
        const s = await r.open("v12345");
        try {
          const { epoch } = await s.acquireEpoch({ holder: "k03", at: "2026-11-20T00:00:00.000Z" });
          const g = MigrationGuardService.withEpoch(s, epoch, { migrations: registry("sqlite", "v12345"), schemaVersion: () => versionOf(s), gateFile, snapshots: true, now: () => "2026-11-20T00:00:00.000Z" });
          await g.approveContract(OWNER, { commandId: "approve", through: 4 });
        } finally { await s.close(); }
      }
      const approved = readFileSync(gateFile, "utf8");
      // an edited copy (a higher number) is still refused
      writeFileSync(gateFile, approved.replace('"through":4', '"through":5'));
      { const s = await start(); try { assert.equal(await versionOf(s), 3); } finally { await s.close(); } }
      writeFileSync(gateFile, approved);
      const s = await start();
      try { assert.equal(await versionOf(s), 5); } finally { await s.close(); }
      assert.equal(await r.hasNote(), false, "the destructive migration ran");
      assert.deepEqual(hooks, [{ from: 3, to: 5 }], "one snapshot, before the destructive step");
      assert.deepEqual(reopened, [4], "opened again once, allowing exactly the approved number");
      // the applied approval is not acted on again
      const later = await start();
      try { assert.equal(await versionOf(later), 5); } finally { await later.close(); }
      assert.deepEqual(reopened, [4]);
    } finally { await r.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}
