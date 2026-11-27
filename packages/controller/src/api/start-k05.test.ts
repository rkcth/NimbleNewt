import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileBlobStore } from "../artifacts/index.js";
import { ScriptedInterpreter } from "../chat/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { promoteController } from "../recovery/index.js";
import { SqliteStorage } from "../storage/index.js";
import { readSqliteEpoch } from "../storage/sqlite/index.js";
import { KEY_FILE, PENDING_FILE, applyPendingRestore } from "../backup/staged-restore.js";
import { canonicalJson } from "../storage/json.js";
import { sqliteTarget } from "../transfer/index.js";
import { startController } from "./index.js";

// Card K05, first slice, through the composed controller: two controllers on one SQLite file. The running one is fenced by a promotion made on another handle: its dispatcher stops at its next
// round, its writes are refused, a restart of it is refused, and only the successor the promotion named starts; the owner reads what happened by chat (no new interpreter text).
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("a promotion fences the running controller before naming the successor; the old one stops dispatching and cannot start again, the successor can (card K05)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-k05s-"));
  const dbPath = join(d, "c.sqlite"), manifests = join(d, "recovery");
  const say: Record<string, unknown[]> = {};
  const base = { storage: { kind: "sqlite", path: dbPath }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [],
    chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) }, recovery: { manifestDirectory: manifests, everyMs: 60_000, now: () => new Date("2026-11-27T12:00:00.000Z") } };
  const a = await startController({ ...base, dispatch: { timer: new ManualTimer(), manual: true } } as never);
  let b: Awaited<ReturnType<typeof startController>> | undefined;
  try {
    const boot = await a.services.principals.bootstrapOwner({ name: "rob" });
    assert.equal((await a.api.handle(boot.token, { v: 1, op: "project.create", commandId: "p1", args: { name: "Orchard" } } as never) as { ok?: boolean }).ok, true);
    await a.dispatch!.driver.runOnce();
    assert.equal(a.dispatch!.driver.status().state, "idle", "the dispatcher ran a round as the primary");

    // the promotion, from another handle on the same file
    const other = await SqliteStorage.open({ path: dbPath });
    try {
      const r = await promoteController({ storage: other, manifestDirectory: manifests, blobs: await FileBlobStore.open({ directory: join(d, "blobs-b") }), successor: "controller-b", promotionId: "k05s", now: () => new Date("2026-11-27T12:05:00.000Z") });
      assert.equal(r.fencedHolder, "controller");
    } finally { await other.close(); }

    // the old controller: its next round meets the fence and it stops for good; its writes are refused
    assert.equal(await a.dispatch!.driver.runOnce(), undefined);
    assert.equal(a.dispatch!.driver.status().state, "fenced");
    assert.equal(await a.dispatch!.driver.runOnce(), undefined, "a fenced dispatcher does not run again");
    const late = JSON.stringify(await a.api.handle(boot.token, { v: 1, op: "project.create", commandId: "p2", args: { name: "Late" } } as never));
    assert.match(late, /stale_epoch|no longer the primary/, late);
    await a.close();

    // a returning old controller is refused at start, and so is any other name
    await assert.rejects(startController({ ...base } as never), /NimbleNewt will not start: the controller promotion k05s named controller-b .*this controller starts as controller/);
    await assert.rejects(startController({ ...base, holder: "controller-c" } as never), /may not use this store/);

    // the successor starts, writes, and the owner reads the promotion by chat
    b = await startController({ ...base, holder: "controller-b" } as never);
    assert.equal((await b.api.handle(boot.token, { v: 1, op: "project.create", commandId: "p3", args: { name: "After" } } as never) as { ok?: boolean }).ok, true);
    const text = "was the old controller fenced?";
    say[text] = [{ kind: "status", request: { kind: "database_transfer" }, evidence: text, basis: "owner" }];
    const answer = JSON.stringify((await b.chat!.submit(boot.token, { messageId: "q1", text })).outcomes);
    assert.match(answer, /Controller promotion k05s .* fenced the controller of epoch \d+ \(controller\) at epoch \d+ and then named controller-b/, answer);
    assert.doesNotMatch(answer, new RegExp(d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "no path in the answer");
    const owner = await b.services.principals.authenticate(boot.token);
    await b.services.principals.enroll(owner, { commandId: "e-zed", kind: "agent", name: "zed", grants: [] });
    const zed = (await b.services.principals.issueCredential(owner, "agent:zed")).token;
    const asAgent = JSON.stringify(await b.api.handle(zed, { v: 1, op: "status.ask", args: { request: { kind: "database_transfer" } } } as never));
    assert.doesNotMatch(asAgent, /Controller promotion|controller-b/, asAgent);
    await b.close(); b = undefined;
    // the successor restarts as itself
    b = await startController({ ...base, holder: "controller-b" } as never);
  } finally { await a.close().catch(() => undefined); await b?.close().catch(() => undefined); rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test("without a promotion every start is as before, and the owner's view says nothing of one (card K05)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-k05t-"));
  try {
    const say: Record<string, unknown[]> = {};
    const opts = { storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) } };
    const c1 = await startController({ ...opts, holder: "one" } as never);
    await c1.close();
    const c2 = await startController({ ...opts, holder: "two" } as never);
    try {
      const boot = await c2.services.principals.bootstrapOwner({ name: "rob" });
      const text = "was any controller fenced?";
      say[text] = [{ kind: "status", request: { kind: "database_transfer" }, evidence: text, basis: "owner" }];
      assert.doesNotMatch(JSON.stringify((await c2.chat!.submit(boot.token, { messageId: "m1", text })).outcomes), /Controller promotion/);
    } finally { await c2.close(); }
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test("a controller fenced by a promotion can neither move its database nor restore a backup onto it, either of which would take the store back (K05 review)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-k05w-"));
  const dbPath = join(d, "c.sqlite"), manifests = join(d, "recovery"), moved = join(d, "moved", "m.sqlite");
  const a = await startController({ storage: { kind: "sqlite", path: dbPath }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer: new ManualTimer(), manual: true },
    recovery: { manifestDirectory: manifests, everyMs: 60_000, now: () => new Date("2026-11-27T12:00:00.000Z") }, backup: { directory: join(d, "backups") },
    transfer: { stateDirectory: join(d, "state"), targets: [await sqliteTarget({ name: "moved", path: moved, open: () => SqliteStorage.open({ path: moved }) })] } } as never);
  try {
    const boot = await a.services.principals.bootstrapOwner({ name: "rob" });
    const call = async (op: string, args: Record<string, unknown>, commandId?: string) => (await a.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    assert.equal((await call("project.create", { name: "Orchard" }, "p1")).ok, true);
    await a.dispatch!.driver.runOnce();
    const name = (await call("backup.now", {}, "b1")).result.item.name as string;
    const before = await call("database.transfer.preview", { target: "moved" });
    assert.equal(before.result.item.ok, true, JSON.stringify(before));
    assert.equal(typeof (await call("backup.restore.preview", { name })).result.item.token, "string", "before the fence the restore preview is as before");
    const other = await SqliteStorage.open({ path: dbPath });
    try { await promoteController({ storage: other, manifestDirectory: manifests, blobs: await FileBlobStore.open({ directory: join(d, "blobs-b") }), successor: "controller-b", promotionId: "k05w", now: () => new Date("2026-11-27T12:05:00.000Z") }); } finally { await other.close(); }
    const holder = async (): Promise<unknown> => { const s = await SqliteStorage.open({ path: dbPath }); try { const snap = await s.snapshot(); try { return (await snap.read("state", { limit: 1 }))[0]?.["holder"]; } finally { await snap.close(); } } finally { await s.close(); } };
    const fence = await holder();
    const move = await call("database.transfer.apply", { target: "moved", confirm: (await call("database.transfer.preview", { target: "moved" })).result.item.token }, "t1");
    assert.match(JSON.stringify(move), /no longer holds the database .*cannot move it/, JSON.stringify(move));
    assert.match(JSON.stringify(await call("backup.restore.preview", { name })), /no longer holds the database .*cannot restore a backup/);
    assert.equal(await holder(), fence, "the promotion's holder still holds the store");
  } finally { await a.close().catch(() => undefined); rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test("a restore the old controller staged BEFORE the fence is not swapped in at its restart: the fence and the promotion stay, and the successor starts on the data it had (K05 second review)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-k05r-"));
  const dbPath = join(d, "c.sqlite"), manifests = join(d, "recovery");
  const lines: string[] = [];
  const base = { storage: { kind: "sqlite", path: dbPath }, argv: [], env: {}, print: (l: string) => { lines.push(l); }, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer: new ManualTimer(), manual: true },
    recovery: { manifestDirectory: manifests, everyMs: 60_000, now: () => new Date("2026-11-27T12:00:00.000Z") }, backup: { directory: join(d, "backups") } };
  const a = await startController(base as never);
  let b: Awaited<ReturnType<typeof startController>> | undefined;
  try {
    const boot = await a.services.principals.bootstrapOwner({ name: "rob" });
    const call = async (c: typeof a, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    assert.equal((await call(a, "project.create", { name: "Garden" }, "p1")).ok, true);
    await a.dispatch!.driver.runOnce();
    const name = (await call(a, "backup.now", {}, "b1")).result.item.name as string;
    assert.equal((await call(a, "project.create", { name: "Late" }, "p2")).ok, true);
    const preview = await call(a, "backup.restore.preview", { name });
    const applied = await call(a, "backup.restore.apply", { name, confirm: preview.result.item.token }, "r1");
    assert.ok(applied.ok, JSON.stringify(applied));
    await a.close();
    // K05 re-check: the recorded epoch is covered by the marker's HMAC and checked for shape
    const markerPath = join(d, PENDING_FILE), original = readFileSync(markerPath, "utf8");
    const key = Buffer.from(readFileSync(join(d, KEY_FILE), "utf8").trim(), "hex");
    const { mac, ...rest } = JSON.parse(original) as Record<string, unknown>;
    const sign = (body: Record<string, unknown>): string => createHmac("sha256", key).update(canonicalJson(body as never)).digest("hex");
    assert.equal(sign(rest), mac, "the test signs as the controller does");
    assert.equal(typeof rest["epoch"], "number", "the marker records the epoch it was prepared at");
    try {
      writeFileSync(markerPath, JSON.stringify({ ...rest, epoch: (rest["epoch"] as number) + 1, mac }));
      await assert.rejects(applyPendingRestore(d, dbPath), /not authentic/, "an epoch changed without the key");
      for (const bad of [-1, 1.5, "1", null]) {
        const body = { ...rest, epoch: bad };
        writeFileSync(markerPath, JSON.stringify({ ...body, mac: sign(body) }));
        await assert.rejects(applyPendingRestore(d, dbPath), /not valid \(shape\)/, JSON.stringify(bad));
      }
    } finally { writeFileSync(markerPath, original); }
    // the promotion, after the restore was staged and the old controller stopped
    const other = await SqliteStorage.open({ path: dbPath });
    try { await promoteController({ storage: other, manifestDirectory: manifests, blobs: await FileBlobStore.open({ directory: join(d, "blobs-b") }), successor: "controller-b", promotionId: "k05r", now: () => new Date("2026-11-27T12:05:00.000Z") }); } finally { await other.close(); }
    const state = async (): Promise<Record<string, unknown> | undefined> => { const s = await SqliteStorage.open({ path: dbPath }); try { const snap = await s.snapshot(); try { return (await snap.read("state", { limit: 1 }))[0]; } finally { await snap.close(); } } finally { await s.close(); } };
    const fenced = await state();
    // K05 re-check: another program holding the database locked past the epoch read's timeout refuses the start; nothing is moved and the restore is not recorded as failed (it was not decided)
    const pendingBefore = readFileSync(join(d, PENDING_FILE), "utf8");
    const holderDb = new DatabaseSync(dbPath);
    try {
      holderDb.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE");
      await assert.rejects(startController(base as never), /in use by another program/);
    } finally { holderDb.exec("ROLLBACK"); holderDb.close(); }
    assert.equal(readFileSync(join(d, PENDING_FILE), "utf8"), pendingBefore, "the marker is as it was");
    assert.deepEqual(await state(), fenced, "nothing was moved while the database was held");
    // the old controller's restart: the restore is not swapped in and the start check refuses it
    await assert.rejects(startController(base as never), /the controller promotion k05r named controller-b/);
    assert.ok(lines.some((l) => /The restore of .* was not applied: the database was taken by another controller or a controller promotion/.test(l)), lines.join("\n"));
    assert.deepEqual(await state(), fenced, "the store is the promotion's, untouched");
    // the successor (same data directory here) starts on the data it had: the project made after the backup is there, and the failed restore is not tried again
    lines.length = 0;
    b = await startController({ ...base, holder: "controller-b" } as never);
    const projects = JSON.stringify((await call(b, "project.list", {})).result);
    assert.ok(projects.includes("Late"), projects);
    assert.ok(lines.some((l) => /was tried and could not be applied/.test(l)), lines.join("\n"));
    assert.equal((await call(b, "backup.restore.cancel", {}, "rc")).result.cancelled, true);
  } finally { await a.close().catch(() => undefined); await b?.close().catch(() => undefined); rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test("the live SQLite epoch is read without leaving anything behind: a real controller file gives its epoch and keeps its bytes, no -wal or -shm; a file that is not a controller database gives undefined; a held database refuses (K05 re-check)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-k05e-"));
  try {
    const p = join(d, "c.sqlite");
    const s = await SqliteStorage.open({ path: p });
    let epoch: number;
    try { await s.acquireEpoch({ holder: "ctl-a", at: "2026-11-27T12:00:00.000Z", expectedEpoch: await s.currentEpoch() }); epoch = await s.currentEpoch(); } finally { await s.close(); }
    const sha = (): string => createHash("sha256").update(readFileSync(p)).digest("hex");
    const before = sha();
    assert.equal(readSqliteEpoch(p), epoch);
    assert.ok(epoch > 0);
    assert.equal(existsSync(`${p}-wal`), false, "no -wal left");
    assert.equal(existsSync(`${p}-shm`), false, "no -shm left");
    assert.equal(sha(), before, "the file's bytes are unchanged");
    const junk = join(d, "junk.sqlite");
    writeFileSync(junk, "not a database at all, just some bytes that are long enough to be read".repeat(20));
    assert.equal(readSqliteEpoch(junk), undefined, "not a database");
    const other = join(d, "other.sqlite");
    const o = new DatabaseSync(other); o.exec("CREATE TABLE t (x)"); o.close();
    assert.equal(readSqliteEpoch(other), undefined, "a database without the state table");
    const h = new DatabaseSync(p);
    try {
      h.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE");
      assert.throws(() => readSqliteEpoch(p), /in use by another program/);
    } finally { h.exec("ROLLBACK"); h.close(); }
    assert.equal(readSqliteEpoch(p), epoch, "readable again once let go");
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test("a restore whose live SQLite database is damaged or gone is still applied (nothing can be read about who holds it; a restore is what it is for), and a missing file is not created by the epoch read (K05 re-check)", async () => {
  for (const damage of ["junk", "missing"] as const) {
    const d = mkdtempSync(join(tmpdir(), "nn-k05d-"));
    const dbPath = join(d, "c.sqlite");
    const base = { storage: { kind: "sqlite", path: dbPath }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer: new ManualTimer(), manual: true },
      recovery: { manifestDirectory: join(d, "recovery"), everyMs: 60_000, now: () => new Date("2026-11-27T12:00:00.000Z") }, backup: { directory: join(d, "backups") } };
    const a = await startController(base as never);
    try {
      const boot = await a.services.principals.bootstrapOwner({ name: "rob" });
      const call = async (op: string, args: Record<string, unknown>, commandId?: string) => (await a.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
      await a.dispatch!.driver.runOnce();
      const name = (await call("backup.now", {}, "b1")).result.item.name as string;
      const preview = await call("backup.restore.preview", { name });
      assert.ok((await call("backup.restore.apply", { name, confirm: preview.result.item.token }, "r1")).ok);
      await a.close();
      assert.equal(typeof JSON.parse(readFileSync(join(d, PENDING_FILE), "utf8")).epoch, "number");
      for (const x of ["", "-wal", "-shm"]) rmSync(`${dbPath}${x}`, { force: true });
      if (damage === "junk") writeFileSync(dbPath, "damaged ".repeat(600));
      assert.equal(await applyPendingRestore(d, dbPath), name, damage);
      assert.equal(existsSync(join(d, PENDING_FILE)), false, damage);
      const aside = readdirSync(d).filter((f) => f.startsWith("c.sqlite.before-restore-"));
      assert.deepEqual(aside.length > 0, damage === "junk", `${damage}: ${aside.join(",")}`);
    } finally { await a.close().catch(() => undefined); rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
  }
});
