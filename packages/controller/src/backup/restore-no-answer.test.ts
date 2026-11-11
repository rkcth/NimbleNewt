import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { ManualTimer } from "../dispatch/testing/timer.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "../api/index.js";
import { asideSchemaOf, postgresRestorePort, stagedSchemaOf } from "../storage/postgres/index.js";
import { heldSwapPort } from "../storage/postgres/testing/held-swap.js";
import { FaultProxy } from "../storage/postgres/testing/proxy.js";
import { startTestServer, withClient, type TestServer } from "../storage/postgres/testing/server.js";
import { JOURNAL_FILE, PENDING_FILE, applyPendingRestore } from "./staged-restore.js";

// Follow-up of card 19: the start that swaps a staged restore in on PostgreSQL, when the database server stops answering in the middle of the swap. The swap is one
// transaction; its COMMIT is run by the server and the answer never comes, then the server freezes. The start must end (not wait for ever), say so in plain words,
// and leave the database recoverable: never half swapped, and the next start, with the server answering, puts back what was moved. Disposable embedded server only.

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

let server: Promise<TestServer> | undefined;
const pg = (): Promise<TestServer> => (server ??= startTestServer());
after(async () => { if (server !== undefined) await (await server).stop(); });

type Controller = Awaited<ReturnType<typeof startController>>;
const call = async (c: Controller, token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;

test("a restore swap whose COMMIT is never answered, on a server that then freezes, ends the start with a plain error; the next start puts everything back", async () => {
  const s = await pg();
  if (s.kind !== "embedded") return;
  const url = s.url();
  const schema = `k01na_${process.pid}`;
  const d = mkdtempSync(join(tmpdir(), "nn-k01na-"));
  mkdirSync(join(d, "data"));
  const open = () => startController({ storage: { kind: "postgres", url, schema }, dataDirectory: join(d, "data"), argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer: new ManualTimer(), intervalMs: 1000 },
    backup: { directory: join(d, "backups") } } as never);
  const real = new URL(url);
  const proxy = await FaultProxy.start({ host: "127.0.0.1", port: Number(real.port) });
  const through = new URL(real); through.port = String(proxy.port);
  let stamp = "";
  try {
    const c = await open();
    let token: string;
    try {
      const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
      token = boot.token;
      await call(c, token, "project.create", { name: "Garden" }, "p1");
      const name = (await call(c, token, "backup.now", {}, "b1")).result.item.name as string;
      await call(c, token, "project.create", { name: "Late" }, "p2");
      const preview = await call(c, token, "backup.restore.preview", { name });
      assert.ok((await call(c, token, "backup.restore.apply", { name, confirm: preview.result.item.token }, "r1")).ok);
      stamp = (await call(c, token, "backup.restore.status", {})).result.item.pending.stamp as string;
    } finally { await c.close(); }
    const staged = stagedSchemaOf(schema, stamp);
    const aside = asideSchemaOf(schema, stamp);
    const where = async () => { const port = postgresRestorePort(url); return [await port.exists(schema), await port.exists(staged), await port.exists(aside)]; };

    // The swap's COMMIT reaches the server and is run; its answer is never delivered, and from then on the server answers nothing at all.
    proxy.inject({ match: /^Q[\s\S]{4}COMMIT\0/, when: "silent" });
    const out: string[] = [];
    const t0 = Date.now();
    const start = applyPendingRestore(join(d, "data"), { postgres: { url, schema, port: postgresRestorePort(through.toString()) } }, (l) => out.push(l)).then(() => undefined, (e: unknown) => e);
    while (proxy.fired === 0) await sleep(20);
    proxy.freeze();
    let timer: NodeJS.Timeout | undefined;
    // The unanswered COMMIT (statement limit + margin), then the rollback's check on a new connection (connect limit), with slack for a loaded machine.
    const failed = await Promise.race([start, new Promise<string>((resolve) => { timer = setTimeout(() => resolve("still waiting"), 30_000 + 10_000 + 10_000 + 20_000); })]);
    clearTimeout(timer);
    assert.notEqual(failed, "still waiting", `the start still waited after ${Date.now() - t0} ms`);
    assert.ok(failed instanceof Error, String(failed));
    assert.match(failed.message, /the restore could not be undone yet: the PostgreSQL server did not answer .* paused, overloaded or unreachable\. Nothing more was changed; .*Start again when the database server answers/);
    assert.ok(failed.message.length < 600, "a message an owner can read");
    // Never half swapped: the server made the swap entirely (it ran the COMMIT). The journal says what is left to put back.
    assert.deepEqual(await where(), [true, false, true], "the swap was made entirely");
    assert.equal(existsSync(join(d, "data", JOURNAL_FILE)), true, "the journal records what to put back");

    // The next start, with the server answering, puts back what was moved; the controller starts on the data it had.
    const again: string[] = [];
    assert.equal(await applyPendingRestore(join(d, "data"), { postgres: { url, schema, port: postgresRestorePort(url) } }, (l) => again.push(l)), undefined);
    assert.match(again.join("\n"), /put back/);
    assert.deepEqual(await where(), [true, true, false], "the live schema is the one it was before the restore");
    assert.equal(existsSync(join(d, "data", JOURNAL_FILE)), false);
    assert.equal(existsSync(join(d, "data", PENDING_FILE)), true, "the restore stays recorded as failed, for the owner to cancel");
    const c2 = await open();
    try { assert.ok(JSON.stringify((await call(c2, token, "project.list", {})).result).includes("Late"), "the data as it was before the restore"); } finally { await c2.close(); }
  } finally {
    await proxy.stop();
    await withClient(url, async (c) => { for (const name of [schema, stagedSchemaOf(schema, stamp || "20000101T000000Z"), asideSchemaOf(schema, stamp || "20000101T000000Z")]) await c.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`); }).catch(() => undefined);
    rmSync(d, { recursive: true, force: true });
  }
});

test("a swap the server still holds open (its COMMIT unread by a frozen backend) is never taken as not made: the start stops, and after the server runs it the next start puts it back", async () => {
  const s = await pg();
  if (s.kind !== "embedded") return; // the backend process is paused with a signal: a local, disposable server only
  const url = s.url();
  const schema = `k01nb_${process.pid}`;
  const d = mkdtempSync(join(tmpdir(), "nn-k01nb-"));
  mkdirSync(join(d, "data"));
  const open = () => startController({ storage: { kind: "postgres", url, schema }, dataDirectory: join(d, "data"), argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer: new ManualTimer(), intervalMs: 1000 },
    backup: { directory: join(d, "backups") } } as never);
  let stamp = "";
  let thaw = (): void => undefined;
  try {
    const c = await open();
    let token: string;
    try {
      token = (await c.services.principals.bootstrapOwner({ name: "rob" })).token;
      await call(c, token, "project.create", { name: "Garden" }, "p1");
      const name = (await call(c, token, "backup.now", {}, "b1")).result.item.name as string;
      await call(c, token, "project.create", { name: "Late" }, "p2");
      const preview = await call(c, token, "backup.restore.preview", { name });
      assert.ok((await call(c, token, "backup.restore.apply", { name, confirm: preview.result.item.token }, "r1")).ok);
      stamp = (await call(c, token, "backup.restore.status", {})).result.item.pending.stamp as string;
    } finally { await c.close(); }
    const staged = stagedSchemaOf(schema, stamp);
    const aside = asideSchemaOf(schema, stamp);
    const real = postgresRestorePort(url);
    const where = async () => [await real.exists(schema), await real.exists(staged), await real.exists(aside)];

    // The swap's transaction is made as the real one is (migration lock, both renames); then its server process is paused before it reads the COMMIT,
    // and the client gives up on the answer and drops the connection. The server still holds the transaction: when the process runs again it reads the COMMIT.
    const held = heldSwapPort(url, real);
    thaw = held.thaw;
    const late = held.port;
    const first = await applyPendingRestore(join(d, "data"), { postgres: { url, schema, port: late } }).then((v) => ({ v }), (e: unknown) => ({ e }));
    // While the server holds the swap, nobody can tell whether it is made: the start must stop with the journal kept, never conclude "nothing to put back".
    assert.ok("e" in first, `the start concluded while the server still held the swap: ${JSON.stringify(first)}`);
    assert.match(String((first.e as Error).message), /the restore could not be undone yet: .*Start again/);
    assert.equal(existsSync(join(d, "data", JOURNAL_FILE)), true, "the journal records what to put back");
    thaw();
    for (let i = 0; i < 100 && (await where())[1]; i++) await sleep(100); // the paused process runs and commits the swap it held
    assert.deepEqual(await where(), [true, false, true], "the server made the swap once it ran again");

    const again: string[] = [];
    assert.equal(await applyPendingRestore(join(d, "data"), { postgres: { url, schema, port: real } }, (l) => again.push(l)), undefined);
    assert.match(again.join("\n"), /put back/);
    assert.deepEqual(await where(), [true, true, false], "the live schema is the one it was before the restore");
    const c2 = await open();
    try { assert.ok(JSON.stringify((await call(c2, token, "project.list", {})).result).includes("Late"), "the data as it was before the restore"); } finally { await c2.close(); }
  } finally {
    thaw();
    await withClient(url, async (c) => { for (const name of [schema, stagedSchemaOf(schema, stamp || "20000101T000000Z"), asideSchemaOf(schema, stamp || "20000101T000000Z")]) await c.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`); }).catch(() => undefined);
    rmSync(d, { recursive: true, force: true });
  }
});
