import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SqliteStorage } from "../storage/index.js";
import { BackupService, MaintenanceBarrier, StagedRestore, acquireDataLock, acquireDataLocks, applyPendingRestore, chooseKept, createBackup, type BackupInfo, type BackupKind, type PiStateSource } from "./index.js";
import { applyAndCrashAfter } from "./k01h-crash.js";
import { lockIsLive, sameBoot, LOCK_FILE } from "./data-lock.js";
import { runBackupCli } from "./cli.js";
import { copyPiState } from "./pi-state.js";

// Re-review fixes of card K01h (the second round): each test is written to fail without its fix.
const AT = "2026-10-31T10:00:00.000Z";
const POSIX = process.platform !== "win32";
const tmp = (): string => mkdtempSync(join(tmpdir(), "nn-k01hr2-"));
const LINE = '{"id":1,"kind":"pi.user","text":"hello"}\n';
const EMPTY = { outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] };

async function rig(opts: { linkedPi?: boolean } = {}) {
  const d = tmp();
  const data = join(d, "data"); mkdirSync(data);
  const live = join(d, "live"); mkdirSync(live);
  const real = join(d, "real"); mkdirSync(real);
  // The conversation folder: a plain folder, or a LINK to a folder elsewhere.
  const place = opts.linkedPi === true ? join(real, "att-1") : join(live, "att-1");
  mkdirSync(place, { recursive: true });
  writeFileSync(join(place, "history.jsonl"), LINE);
  if (opts.linkedPi === true) symlinkSync(place, join(live, "att-1"), "dir");
  const source: PiStateSource = { list: async () => [{ id: "att-1", dir: place }] };
  const sqlite = join(data, "c.sqlite");
  const storage = await SqliteStorage.open({ path: sqlite });
  const { epoch } = await storage.acquireEpoch({ holder: "c1", at: AT });
  const op = async (id: string, title: string, audits = 1): Promise<void> => {
    await storage.applyOperation({ operationId: id, epoch, actor: "owner:rob", correlationId: `co-${id}`, at: AT, changes: [{ type: "create", ref: { kind: "task", id: `task-${id}` }, body: { title } }], audit: Array.from({ length: audits }, () => ({ type: "task.created", detail: {} })), ...EMPTY } as never);
  };
  await op("op-1", "before");
  let bt = Date.parse(AT);
  const backups = new BackupService(storage, { root: join(d, "b"), version: "t", now: () => new Date(bt += 1000), piState: source });
  const made = await backups.backUpNow("manual");
  await op("op-2", "late");
  writeFileSync(join(place, "history.jsonl"), `${LINE}{"id":9,"text":"after"}\n`);
  const barrier = new MaintenanceBarrier();
  barrier.add({ name: "backups", hold: async () => backups.hold() });
  const piFinal = (id: string): string => join(live, id);
  let clock = new Date("2026-10-31T11:00:00.000Z");
  const restore = (extra: Partial<ConstructorParameters<typeof StagedRestore>[0]> = {}): StagedRestore => new StagedRestore({ backups, root: join(d, "b"), barrier, sqlitePath: sqlite, dataDirectory: data, storage, piFinal, now: () => clock, ...extra });
  return { d, data, live, real, place, sqlite, storage, backups, made, restore, piFinal, op, tick: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
}
const dbTitle = async (path: string, id: string): Promise<unknown> => { const s = await SqliteStorage.open({ path }); try { return (await s.getAggregate({ kind: "task", id }))?.body["title"]; } finally { await s.close(); } };
const stagedLeft = (...dirs: string[]): string[] => dirs.flatMap((d) => readdirSync(d).filter((n) => n.includes(".nn-staged-")));

test("a staged conversation folder that is missing at the first start refuses the swap: nothing is moved, the database is not swapped alone, the failure is recorded (finding 1)", async () => {
  const r = await rig({ linkedPi: true });
  try {
    const sr = r.restore();
    const plan = await sr.preview(r.made.manifest.name);
    const done = await sr.apply(plan.name, plan.token);
    await r.storage.close();
    // The staged copy sits beside the REAL folder (the link was followed before anything was written), not beside the link.
    assert.equal(done.pending.pi[0]!.target, readlinkReal(join(r.live, "att-1")));
    assert.equal(existsSync(done.pending.pi[0]!.staged), true);
    assert.deepEqual(stagedLeft(r.live), []);
    rmSync(done.pending.pi[0]!.staged, { recursive: true });
    const out: string[] = [];
    assert.equal(await applyPendingRestore(r.data, r.sqlite, (l) => out.push(l), { piFinal: r.piFinal }), undefined);
    assert.match(out.join("\n"), /missing/);
    assert.doesNotMatch(out.join("\n"), /was applied/);
    assert.equal(await dbTitle(r.sqlite, "task-op-2"), "late", "the database was not swapped");
    assert.equal(readFileSync(join(r.live, "att-1", "history.jsonl"), "utf8").includes("after"), true);
    assert.equal(existsSync(join(r.data, "restore-journal.json")), false);
    const status = await r.restore().status();
    assert.match(status.pending?.failed?.reason ?? "", /missing/);
    assert.equal((await r.restore().cancel()).cancelled, true);
  } finally { rmSync(r.d, { recursive: true, force: true }); }
});
const readlinkReal = (p: string): string => nodeRealpath(p);
import { realpathSync } from "node:fs";
// The native realpath, as production returns it (os.tmpdir() may be an 8.3 short path on Windows).
const nodeRealpath = (p: string): string => realpathSync.native(p);

test("a crash mid-swap with a symlinked conversation folder (now dangling) is resumed from the journal; a journal without its marker is refused, never ignored (finding 2)", { skip: !POSIX && "needs symlinks" }, async () => {
  const r = await rig({ linkedPi: true });
  try {
    const sr = r.restore();
    const plan = await sr.preview(r.made.manifest.name);
    await sr.apply(plan.name, plan.token);
    await r.storage.close();
    // The process dies right after the real folder went aside: the link dangles (canon follows a dangling link, so the marker still matches; that the journal is read FIRST is tested in k01h-review3).
    assert.equal(applyAndCrashAfter(r.data, r.sqlite, r.live, 1), 3);
    assert.equal(existsSync(join(r.live, "att-1")), false, "the link dangles");
    assert.equal(existsSync(join(r.data, "restore-journal.json")), true);
    // A journal whose marker is gone is refused (and the journal is kept).
    const marker = readFileSync(join(r.data, "pending-restore.json"), "utf8");
    renameSync(join(r.data, "pending-restore.json"), join(r.data, "pending.bak"));
    await assert.rejects(applyPendingRestore(r.data, r.sqlite, undefined, { piFinal: r.piFinal }), /journal/);
    assert.equal(existsSync(join(r.data, "restore-journal.json")), true);
    writeFileSync(join(r.data, "pending-restore.json"), marker);
    // The start resumes from the journal and finishes the swap.
    assert.equal(await applyPendingRestore(r.data, r.sqlite, undefined, { piFinal: r.piFinal }), r.made.manifest.name);
    assert.equal(readFileSync(join(r.live, "att-1", "history.jsonl"), "utf8"), LINE);
    assert.equal(await dbTitle(r.sqlite, "task-op-2"), undefined);
    assert.equal(existsSync(join(r.data, "restore-journal.json")), false);
    assert.equal(existsSync(join(r.data, "pending-restore.json")), false);
  } finally { rmSync(r.d, { recursive: true, force: true }); }
});

test("a crash right after the last rename (before the journal knows it) finds every move made and finishes the swap (finding 1; the journal-done branch itself is tested in k01h-review3)", async () => {
  const r = await rig();
  try {
    const sr = r.restore();
    const plan = await sr.preview(r.made.manifest.name);
    await sr.apply(plan.name, plan.token);
    await r.storage.close();
    // 2 folder moves + 1 database move (live db aside; the staged db has no sidecars) + 1 more: crash after the very last rename.
    const moves = 4;
    assert.equal(applyAndCrashAfter(r.data, r.sqlite, r.live, moves), 3);
    assert.equal(await dbTitle(r.sqlite, "task-op-2"), undefined, "the swap was made");
    // The next start finishes the clean-up (journal marked done), and says the restore was applied.
    const out: string[] = [];
    assert.equal(await applyPendingRestore(r.data, r.sqlite, (l) => out.push(l), { piFinal: r.piFinal }), r.made.manifest.name);
    assert.match(out.join("\n"), /was applied/);
    assert.equal(existsSync(join(r.data, "pending-restore.json")), false);
    assert.equal(existsSync(join(r.data, "restore-journal.json")), false);
  } finally { rmSync(r.d, { recursive: true, force: true }); }
});

test("the failed marker is written before the journal is removed: a failure while recording it leaves the journal, and the next start records it (finding 6)", async () => {
  const r = await rig();
  try {
    const sr = r.restore();
    const plan = await sr.preview(r.made.manifest.name);
    await sr.apply(plan.name, plan.token);
    await r.storage.close();
    let n = 0;
    const failing = async (from: string, to: string): Promise<void> => { n += 1; if (n === 3) throw Object.assign(new Error("x"), { code: "EXDEV" }); renameSync(from, to); };
    let clock = 0;
    const now = (): Date => { clock += 1; if (clock === 1) throw new Error("clock failed"); return new Date(AT); };
    const lock = await acquireDataLock(r.data);
    try { await assert.rejects(applyPendingRestore(r.data, r.sqlite, undefined, { piFinal: r.piFinal, rename: failing, now, lock }), /clock failed/); } finally { await lock.release(); }
    assert.equal(existsSync(join(r.data, "restore-journal.json")), true, "the journal is still there");
    assert.equal(JSON.parse(readFileSync(join(r.data, "pending-restore.json"), "utf8")).failed, undefined);
    assert.equal(await applyPendingRestore(r.data, r.sqlite, undefined, { piFinal: r.piFinal }), undefined);
    assert.equal(JSON.parse(readFileSync(join(r.data, "pending-restore.json"), "utf8")).failed.rolledBack, true);
    assert.equal(existsSync(join(r.data, "restore-journal.json")), false);
    assert.equal(await dbTitle(r.sqlite, "task-op-2"), "late");
    assert.equal(existsSync(join(r.data, "pending-restore.json.tmp")), false);
  } finally { rmSync(r.d, { recursive: true, force: true }); }
});

test("a restore that fails part-way leaves no staged conversation folder behind; the busy flag does not stick after an early failure (findings 5, 7)", async () => {
  const r = await rig();
  try {
    // The deletions list is read once for the artifact rule and then again when the rows are restored (after the conversation files were written): the second read fails.
    const list: unknown[] = [];
    let reads = 0;
    Object.defineProperty(list, Symbol.iterator, { value: () => { reads += 1; throw new Error("deletions unreadable"); } });
    const sr = r.restore({ deletions: async () => list as never });
    const plan = await sr.preview(r.made.manifest.name);
    await assert.rejects(sr.apply(plan.name, plan.token));
    assert.ok(reads > 0, "the failure came after the conversation files were written");
    assert.deepEqual(stagedLeft(r.live), []);
    assert.deepEqual(stagedLeft(r.data), []);
    assert.equal(existsSync(join(r.data, "pending-restore.json")), false);
    // An early failure (an unusable data directory) does not leave the flag set.
    const bad = r.restore({ dataDirectory: "bad\0dir" });
    const p2 = await bad.preview(r.made.manifest.name);
    await assert.rejects(bad.apply(p2.name, p2.token));
    await assert.rejects(bad.apply(p2.name, p2.token), (e: Error) => !/already being prepared/.test(e.message));
  } finally { await r.storage.close().catch(() => undefined); rmSync(r.d, { recursive: true, force: true }); }
});

test("an empty, torn or linked key file is replaced when nothing depends on it, and refused clearly when a restore does (finding 8)", async () => {
  const r = await rig();
  try {
    writeFileSync(join(r.data, ".nn-restore.key"), ""); // torn by a crash between create and write
    const sr = r.restore();
    const plan = await sr.preview(r.made.manifest.name);
    const done = await sr.apply(plan.name, plan.token);
    assert.match(readFileSync(join(r.data, ".nn-restore.key"), "utf8"), /^[0-9a-f]{64}\s*$/);
    assert.equal(lstatSync(join(r.data, ".nn-restore.key")).isFile(), true);
    if (POSIX) assert.equal(statSync(join(r.data, ".nn-restore.key")).mode & 0o077, 0);
    await r.storage.close();
    // With a marker recorded, a damaged key is not replaced: the start says what is wrong instead of reading through it.
    writeFileSync(join(r.data, ".nn-restore.key"), "");
    await assert.rejects(applyPendingRestore(r.data, r.sqlite, undefined, { piFinal: r.piFinal }), /not authentic/);
    assert.equal(readFileSync(join(r.data, ".nn-restore.key"), "utf8"), "");
    void done;
  } finally { rmSync(r.d, { recursive: true, force: true }); }
});

test("a key file that is a link is not followed (finding 8)", { skip: !POSIX && "needs symlinks" }, async () => {
  const r = await rig();
  try {
    const elsewhere = join(r.d, "other.key");
    writeFileSync(elsewhere, `${"ab".repeat(32)}\n`);
    symlinkSync(elsewhere, join(r.data, ".nn-restore.key"));
    const sr = r.restore();
    const plan = await sr.preview(r.made.manifest.name);
    await sr.apply(plan.name, plan.token);
    assert.equal(lstatSync(join(r.data, ".nn-restore.key")).isSymbolicLink(), false);
    assert.equal(readFileSync(elsewhere, "utf8"), `${"ab".repeat(32)}\n`, "the file the link pointed at is untouched");
  } finally { await r.storage.close().catch(() => undefined); rmSync(r.d, { recursive: true, force: true }); }
});

test("the approval's time limit is the CURRENT setting applied to when the preview was made; a token from a no-expiry period does not live on (finding 9)", async () => {
  const r = await rig();
  try {
    let minutes: number | null = null;
    const sr = r.restore({ confirmMinutes: async () => minutes });
    const plan = await sr.preview(r.made.manifest.name);
    assert.equal(plan.expiresAt, undefined);
    minutes = 30;
    r.tick(31 * 60_000);
    await assert.rejects(sr.apply(plan.name, plan.token), /expired/);
    // Changed back to no expiry: the same token is good again (the setting in force now decides).
    minutes = null;
    await sr.apply(plan.name, plan.token);
  } finally { await r.storage.close().catch(() => undefined); rmSync(r.d, { recursive: true, force: true }); }
});

test("a restore asks for a new preview when the changes it would discard grew by more than the owner's margin since the preview (finding 9)", async () => {
  const r = await rig();
  try {
    const sr = r.restore({ changeMargin: async () => 2 });
    const plan = await sr.preview(r.made.manifest.name);
    assert.equal(plan.changesSinceBackup, 1);
    await r.op("op-3", "more", 3); // 3 more recorded changes: over the margin of 2
    await assert.rejects(sr.apply(plan.name, plan.token), /new preview/);
    assert.equal(existsSync(join(r.data, "pending-restore.json")), false);
    // Within the margin, or with the check off, it goes through.
    const again = await sr.preview(r.made.manifest.name);
    await r.op("op-4", "one more", 2);
    const off = r.restore({ changeMargin: async () => null });
    const p3 = await off.preview(r.made.manifest.name);
    await r.op("op-5", "many", 30);
    await off.apply(p3.name, p3.token);
    void again;
  } finally { await r.storage.close().catch(() => undefined); rmSync(r.d, { recursive: true, force: true }); }
});

test("a pre-restore snapshot takes no daily or weekly slot, can age out by the owner's setting, and does not stretch how long untrusted backups stay (finding 11)", () => {
  const info = (iso: string, kind: BackupKind, trusted = true): BackupInfo => ({ path: `/b/${iso}-${kind}`, manifest: { createdAt: iso, kind } as never, at: iso, trusted });
  const scheduled = info("2026-10-30T02:00:00.000Z", "scheduled");
  const pre = info("2026-10-30T09:00:00.000Z", "pre-restore"); // the same day, later: used to win the day's slot
  const newest = info("2026-10-31T02:00:00.000Z", "scheduled");
  const kept = chooseKept([scheduled, pre, newest], { daily: 2, weekly: 0, preRestoreKept: 0 }, new Date("2026-10-31T12:00:00.000Z"));
  assert.equal(kept.has(scheduled.path), true, "the scheduled backup of that day keeps its slot");
  // Age limit.
  const old = info("2026-08-01T09:00:00.000Z", "pre-restore");
  const now = new Date("2026-10-31T12:00:00.000Z");
  assert.equal(chooseKept([newest, old], { daily: 1, weekly: 0 }, now).has(old.path), true, "default: kept");
  assert.equal(chooseKept([newest, old], { daily: 1, weekly: 0, preRestoreMaxAgeDays: null }, now).has(old.path), true);
  assert.equal(chooseKept([newest, old], { daily: 1, weekly: 0, preRestoreMaxAgeDays: 30 }, now).has(old.path), false, "older than the limit: expires");
  assert.equal(chooseKept([newest, pre, old], { daily: 1, weekly: 0, preRestoreMaxAgeDays: 30 }, now).has(pre.path), true, "within the limit: kept");
  // An untrusted backup is judged against the scheduled backups only: an old pre-restore snapshot kept for ever does not keep it for ever.
  const odd = info("2026-09-01T00:00:00.000Z", "manual", false);
  assert.equal(chooseKept([newest, old, odd], { daily: 1, weekly: 0 }, now).has(odd.path), false);
});

test("the lock: a different boot, a reused pid or an old unrefreshed lock of another host name is stale; a live same-host process and a fresh foreign lock are held (finding 4)", () => {
  const me = { pid: 100, hostname: () => "h1", bootId: () => "boot-A", startOf: (p: number) => (p === 200 ? "s1" : undefined), alive: (p: number) => p === 200, now: () => new Date("2026-10-31T12:00:00.000Z"), staleMinutes: 10 };
  const nowMs = Date.parse("2026-10-31T12:00:00.000Z");
  const holder = { pid: 200, host: "h1", nonce: "n", boot: "boot-A", start: "s1" };
  assert.equal(lockIsLive(holder, nowMs, me), true, "same host, process there, same start");
  assert.equal(lockIsLive({ ...holder, boot: "boot-B" }, nowMs, me), false, "a different boot");
  assert.equal(lockIsLive({ ...holder, start: "s0" }, nowMs, me), false, "the pid was reused by another process");
  assert.equal(lockIsLive({ ...holder, pid: 201 }, nowMs, me), false, "the process is gone");
  // Another host name: the pid is not looked for (it may mean anything here); the lock's age decides.
  const foreign = { ...holder, host: "container-9", pid: 201 };
  assert.equal(lockIsLive(foreign, nowMs - 5 * 60_000, me), true, "refreshed 5 minutes ago");
  assert.equal(lockIsLive(foreign, nowMs - 11 * 60_000, me), false, "not refreshed for 11 minutes");
  assert.equal(lockIsLive({ ...foreign, pid: 200 }, nowMs - 11 * 60_000, me), false, "even if a process of that number exists here");
  assert.equal(lockIsLive({ ...foreign, staleMinutes: null }, nowMs - 9999 * 60_000, me), true, "never by age when the owner said so");
  assert.equal(lockIsLive({ ...foreign, staleMinutes: 1 }, nowMs - 2 * 60_000, me), false, "the holder's own setting");
  assert.equal(sameBoot("t:1000", "t:1100"), true);
  assert.equal(sameBoot("t:1000", "t:5000"), false);
  assert.equal(sameBoot("t:1000", "abc"), undefined);
});

test("a stale lock is taken over by exactly one of two starts that find it at once; the winner owns the file; the holder refreshes it (findings 3, 4)", async () => {
  const d = tmp();
  try {
    for (let round = 0; round < 15; round++) {
      const dir = join(d, `r${round}`); mkdirSync(dir);
      writeFileSync(join(dir, LOCK_FILE), `${JSON.stringify({ pid: 999_999, host: hostname(), nonce: "dead", at: AT })}\n`);
      const env = { alive: () => false };
      const results = await Promise.allSettled([acquireDataLock(dir, env), acquireDataLock(dir, env), acquireDataLock(dir, env)]);
      const won = results.filter((x) => x.status === "fulfilled");
      assert.equal(won.length, 1, `round ${round}: exactly one start owns the lock`);
      const nonce = (JSON.parse(readFileSync(join(dir, LOCK_FILE), "utf8")) as { nonce: string }).nonce;
      assert.notEqual(nonce, "dead");
      await (won[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof acquireDataLock>>>).value.release();
      assert.equal(existsSync(join(dir, LOCK_FILE)), false);
    }
    // The holder refreshes the file while it holds it.
    const dir = join(d, "beat"); mkdirSync(dir);
    const lock = await acquireDataLock(dir, { heartbeatMs: 20 });
    utimesSync(join(dir, LOCK_FILE), new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(Date.now() - statSync(join(dir, LOCK_FILE)).mtimeMs < 60_000, "refreshed");
    // The owner's setting reaches the lock record.
    await lock.setStaleMinutes(null);
    assert.equal((JSON.parse(readFileSync(join(dir, LOCK_FILE), "utf8")) as { staleMinutes: unknown }).staleMinutes, null);
    await lock.release();
    // Locks on two folders: when the second is held, the first is let go.
    const a = join(d, "a"), b = join(d, "b"); mkdirSync(a); mkdirSync(b);
    const hold = await acquireDataLock(b);
    await assert.rejects(acquireDataLocks([a, b]), /another controller/);
    assert.equal(existsSync(join(a, LOCK_FILE)), false);
    await hold.release();
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("the offline restore command takes the folders' lock: a controller holding the folder refuses it, and the lock is let go afterwards (finding 12)", async () => {

  const root = tmp(); const target = tmp();
  try {
    const s = await SqliteStorage.open({ path: join(root, "src.sqlite") });
    const { epoch } = await s.acquireEpoch({ holder: "c1", at: AT });
    await s.applyOperation({ operationId: "op-1", epoch, actor: "owner:rob", correlationId: "co-1", at: AT, changes: [{ type: "create", ref: { kind: "task", id: "task-a" }, body: { title: "x" } }], audit: [], ...EMPTY } as never);
    const { path } = await createBackup(s, { root: join(root, "b"), kind: "manual", version: "t", now: () => new Date(AT) });
    await s.close();
    const out: string[] = [];
    const run = async (...argv: string[]): Promise<number> => { out.length = 0; return runBackupCli(argv, (l) => { out.push(l); }); };
    const held = await acquireDataLock(target);
    assert.equal(await run("restore", path, "--sqlite", join(target, "new.sqlite")), 1);
    assert.match(out.join("\n"), /another controller/);
    assert.equal(existsSync(join(target, "new.sqlite")), false, "nothing was written");
    await held.release();
    assert.equal(await run("restore", path, "--sqlite", join(target, "new.sqlite")), 0, out.join("\n"));
    assert.equal(existsSync(join(target, LOCK_FILE)), false, "the lock was let go");
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true }); }
});

test("a folder inside a conversation store swapped for a link between the listing and the open is not followed out of the store (finding 10)", { skip: !POSIX && "needs symlinks" }, async () => {
  const d = tmp();
  try {
    const store = join(d, "store"); mkdirSync(join(store, "sub"), { recursive: true });
    writeFileSync(join(store, "sub", "h.jsonl"), LINE);
    writeFileSync(join(store, "ok.jsonl"), LINE);
    const outside = join(d, "outside"); mkdirSync(outside);
    writeFileSync(join(outside, "h.jsonl"), '{"secret":"outside the store"}\n');
    const staging = join(d, "stage"); mkdirSync(staging);
    const src: PiStateSource = { list: async () => [{ id: "att-1", dir: store }] };
    const swap = async (path: string): Promise<void> => { if (path.endsWith(join("sub", "h.jsonl"))) { rmSync(join(store, "sub"), { recursive: true }); symlinkSync(outside, join(store, "sub"), "dir"); } };
    const done = await copyPiState(src, staging, undefined, { beforeOpen: swap });
    assert.equal(done.files, 1, "only the plain file is in the backup");
    assert.ok((done.problemCount ?? 0) >= 1);
    const stored = readdirSync(join(staging, "pi-state")).map((n) => readFileSync(join(staging, "pi-state", n), "utf8")).join("");
    assert.equal(stored.includes("outside the store"), false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
