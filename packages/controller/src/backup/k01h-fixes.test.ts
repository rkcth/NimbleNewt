import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileBlobStore } from "../artifacts/index.js";
import { DomainError } from "../domain/errors.js";
import type { LedgerEntry } from "../retention/ledger.js";
import { MemoryStorage, SqliteStorage } from "../storage/index.js";
import { BackupService, MaintenanceBarrier, ProofRefused, StagedRestore, acquireDataLock, applyPendingRestore, canon, chooseKept, createBackup, createKeyring, restoreBackup, unlockWithPasscode, validRel, type BackupInfo, type BackupKind, type PiStateSource } from "./index.js";
import { copyPiState } from "./pi-state.js";

const AT = "2026-10-31T10:00:00.000Z";
const FAST = { N: 2 ** 16, r: 8, p: 1 } as const;
const POSIX = process.platform !== "win32";
const ROOT = POSIX && process.getuid?.() === 0;
const tmp = (): string => mkdtempSync(join(tmpdir(), "nn-k01hx-"));
const LINE = '{"id":1,"kind":"pi.user","text":"hello"}\n';

async function populate(storage: MemoryStorage | SqliteStorage, title = "t", extraChanges: unknown[] = []): Promise<void> {
  const { epoch } = await storage.acquireEpoch({ holder: "c1", at: AT });
  await storage.applyOperation({ operationId: "op-1", epoch, actor: "owner:rob", correlationId: "co-1", at: AT, changes: [{ type: "create", ref: { kind: "task", id: "task-a" }, body: { title } }, ...extraChanges] as never, audit: [{ type: "task.created", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
}
const stores = (dir: string): PiStateSource => { mkdirSync(join(dir, "att-1"), { recursive: true }); writeFileSync(join(dir, "att-1", "history.jsonl"), LINE); return { list: async () => [{ id: "att-1", dir: join(dir, "att-1") }] }; };

async function rig(opts: { relative?: boolean } = {}) {
  const d = tmp();
  const base = opts.relative === true ? "." : d;
  if (opts.relative === true) process.chdir(d);
  const dataRel = opts.relative === true ? "data" : join(d, "data");
  mkdirSync(dataRel);
  const live = join(d, "live");
  const sqlite = join(dataRel, "c.sqlite");
  const storage = await SqliteStorage.open({ path: sqlite });
  await populate(storage, "before");
  let bt = Date.parse(AT);
  const backups = new BackupService(storage, { root: join(d, "b"), version: "t", now: () => new Date(bt += 1000), piState: stores(live) });
  const made = await backups.backUpNow("manual");
  const { epoch } = { epoch: await storage.currentEpoch() };
  await storage.applyOperation({ operationId: "op-2", epoch, actor: "owner:rob", correlationId: "co-2", at: AT, changes: [{ type: "create", ref: { kind: "task", id: "task-late" }, body: { title: "late" } }], audit: [{ type: "task.created", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
  writeFileSync(join(live, "att-1", "history.jsonl"), `${LINE}{"id":9,"text":"after"}\n`);
  const barrier = new MaintenanceBarrier();
  barrier.add({ name: "backups", hold: async () => backups.hold() });
  const piFinal = (id: string): string => join(live, id);
  let clock = new Date("2026-10-31T11:00:00.000Z");
  const restore = (extra: Partial<ConstructorParameters<typeof StagedRestore>[0]> = {}) => new StagedRestore({ backups, root: join(d, "b"), barrier, sqlitePath: sqlite, dataDirectory: dataRel, storage, piFinal, now: () => clock, ...extra });
  return { d, base, dataRel, live, sqlite, backups, made, barrier, restore, piFinal, storage, tick: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
}
const rm_ = (d: string): void => { try { process.chdir(tmpdir()); } catch { /* */ } rmSync(d, { recursive: true, force: true }); };
const dbTitle = async (path: string, id: string): Promise<unknown> => { const s = await SqliteStorage.open({ path }); try { return (await s.getAggregate({ kind: "task", id }))?.body["title"]; } finally { await s.close(); } };

test("a RELATIVE data directory does not brick the start: the marker is written and checked in one absolute form (finding 1)", async () => {
  const r = await rig({ relative: true });
  try {
    const sr = r.restore();
    const plan = await sr.preview(r.made.manifest.name);
    await sr.apply(plan.name, plan.token);
    await r.storage.close();
    const marker = JSON.parse(readFileSync(join(r.dataRel, "pending-restore.json"), "utf8"));
    assert.ok(marker.stagedDb.startsWith("/") || /^[A-Za-z]:/.test(marker.stagedDb), "absolute in the marker");
    assert.equal(await applyPendingRestore("data", "data/c.sqlite", undefined, { piFinal: r.piFinal }), r.made.manifest.name);
    assert.equal(await dbTitle("data/c.sqlite", "task-late"), undefined);
    assert.equal(readFileSync(join(r.live, "att-1", "history.jsonl"), "utf8"), LINE);
  } finally { rm_(r.d); }
});

async function prepared() {
  const r = await rig();
  const sr = r.restore();
  const plan = await sr.preview(r.made.manifest.name);
  await sr.apply(plan.name, plan.token);
  await r.storage.close();
  return { r, sr };
}
const failing = (code: string, when: (n: number, from: string) => boolean) => { let n = 0; const { renameSync } = require_fs(); return async (from: string, to: string) => { n += 1; if (when(n, from)) throw Object.assign(new Error("injected"), { code }); renameSync(from, to); }; };
// eslint-disable-next-line @typescript-eslint/no-require-imports
function require_fs(): typeof import("node:fs") { return nodeFs; }
import * as nodeFs from "node:fs";

test("a rename that fails mid-swap (cross-device, in use) rolls the moves already made back: the live data is whole, the failure is recorded, status shows it and cancel clears it (finding 1)", async () => {
  const { r, sr } = await prepared();
  try {
    const out: string[] = [];
    // The 3rd move (the live database going aside) fails: the conversation folder moves before it are undone.
    const done = await applyPendingRestore(r.dataRel, r.sqlite, (l) => out.push(l), { piFinal: r.piFinal, rename: failing("EXDEV", (n) => n === 3) });
    assert.equal(done, undefined);
    assert.match(out.join("\n"), /could not be applied.*put back/s);
    assert.equal(readFileSync(join(r.live, "att-1", "history.jsonl"), "utf8").includes("after"), true, "the live conversation folder is back");
    assert.equal(await dbTitle(r.sqlite, "task-late"), "late", "the live database is untouched");
    assert.equal(existsSync(join(r.dataRel, "restore-journal.json")), false);
    const marker = JSON.parse(readFileSync(join(r.dataRel, "pending-restore.json"), "utf8"));
    assert.equal(marker.failed.rolledBack, true);
    // A later start does not retry by itself, and the status (a fresh object, as after the restart) reads the marker.
    assert.equal(await applyPendingRestore(r.dataRel, r.sqlite, undefined, { piFinal: r.piFinal }), undefined);
    assert.equal(readFileSync(join(r.live, "att-1", "history.jsonl"), "utf8").includes("after"), true);
    const fresh = r.restore();
    const st = await fresh.status();
    assert.equal(st.pending?.failed?.rolledBack, true);
    // Prepare again is refused until the failed one is cancelled; cancel works on the recorded failure and removes the staged copies.
    await assert.rejects(fresh.apply(r.made.manifest.name, "x"), /cancel it first/);
    assert.equal((await fresh.cancel()).cancelled, true);
    assert.equal(existsSync(join(r.dataRel, "pending-restore.json")), false);
    assert.equal(readdirSync(r.live).some((n) => n.includes(".nn-staged-")) || readdirSync(r.dataRel).some((n) => n.includes(".nn-staged-")), false);
    void sr;
  } finally { rm_(r.d); }
});

test("a file another program holds (EBUSY) is tried again and the swap goes through; if the rollback itself cannot finish the next start continues it (finding 1)", async () => {
  const { r } = await prepared();
  try {
    let once = true;
    const busy = async (from: string, to: string) => { if (once) { once = false; throw Object.assign(new Error("busy"), { code: "EBUSY" }); } nodeFs.renameSync(from, to); };
    assert.equal(await applyPendingRestore(r.dataRel, r.sqlite, undefined, { piFinal: r.piFinal, rename: busy, retryDelayMs: 1 }), r.made.manifest.name);
    assert.equal(await dbTitle(r.sqlite, "task-late"), undefined);
  } finally { rm_(r.d); }
  const second = await prepared();
  try {
    const { r } = second;
    // Move 4 fails, and moving move 2 back fails too: half-swapped, said loudly, journal kept.
    let n = 0;
    const bad = async (from: string, to: string) => { n += 1; if (n === 4 || n === 5) throw Object.assign(new Error("x"), { code: "EXDEV" }); nodeFs.renameSync(from, to); };
    await assert.rejects(applyPendingRestore(r.dataRel, r.sqlite, undefined, { piFinal: r.piFinal, rename: bad }), /half-swapped/);
    assert.equal(existsSync(join(r.dataRel, "restore-journal.json")), true);
    // The next start (the cause gone) finishes the rollback and starts on the live data.
    assert.equal(await applyPendingRestore(r.dataRel, r.sqlite, undefined, { piFinal: r.piFinal }), undefined);
    assert.equal(existsSync(join(r.dataRel, "restore-journal.json")), false);
    assert.equal(await dbTitle(r.sqlite, "task-late"), "late");
    assert.equal(readFileSync(join(r.live, "att-1", "history.jsonl"), "utf8").includes("after"), true);
  } finally { rm_(second.r.d); }
});

test("at apply time the restored data must be on the device it goes to: a different device refuses and stages nothing (finding 1)", async () => {
  const r = await rig();
  try {
    const sr = r.restore({ deviceOf: async (p) => (p.includes(".nn-staged-") ? 1 : 2) });
    const plan = await sr.preview(r.made.manifest.name);
    await assert.rejects(sr.apply(plan.name, plan.token), /different devices/);
    assert.equal(r.barrier.held, false);
    assert.equal(existsSync(join(r.dataRel, "pending-restore.json")), false);
    assert.equal(existsSync(`${r.sqlite}.nn-staged-20261031T110000Z`), false);
    assert.equal(readdirSync(r.live).some((n) => n.includes(".nn-staged-")), false);
  } finally { rm_(r.d); }
});

test("the marker is authenticated and its targets are only places this installation keeps conversation stores (finding 2)", async () => {
  const { r } = await prepared();
  try {
    const path = join(r.dataRel, "pending-restore.json");
    const good = readFileSync(path, "utf8");
    const m = JSON.parse(good);
    const forged = (patch: object) => writeFileSync(path, JSON.stringify({ ...m, ...patch }));
    // Retargeting a conversation folder keeps the old MAC and is refused; so is a changed name, and a marker with no MAC.
    forged({ pi: [{ ...m.pi[0], target: join(r.d, "victim"), staged: join(r.d, "victim.nn-staged-x") }] });
    await assert.rejects(applyPendingRestore(r.dataRel, r.sqlite, undefined, { piFinal: r.piFinal }), /not authentic/);
    forged({ name: "backup-20261031T100000Z-manual; rm -rf" });
    await assert.rejects(applyPendingRestore(r.dataRel, r.sqlite, undefined, { piFinal: r.piFinal }), /not authentic/);
    const { mac: _mac, ...noMac } = m; writeFileSync(path, JSON.stringify(noMac));
    await assert.rejects(applyPendingRestore(r.dataRel, r.sqlite, undefined, { piFinal: r.piFinal }), /not authentic/);
    // A marker the controller itself wrote, applied by an installation that keeps that store elsewhere, is refused too.
    writeFileSync(path, good);
    await assert.rejects(applyPendingRestore(r.dataRel, r.sqlite, undefined, { piFinal: (id) => join(r.d, "elsewhere", id) }), /not where this installation keeps/);
    assert.equal(await dbTitle(r.sqlite, "task-late"), "late", "nothing moved");
    assert.equal(existsSync(join(r.dataRel, "restore-journal.json")), false);
    // With the key gone nothing can be authenticated.
    rmSync(join(r.dataRel, ".nn-restore.key"));
    await assert.rejects(applyPendingRestore(r.dataRel, r.sqlite, undefined, { piFinal: r.piFinal }), /not authentic/);
    const st = await r.restore().status();
    assert.match(st.markerProblem ?? "", /not authentic/);
  } finally { rm_(r.d); }
});

test("a store folder that is a link is not followed; a link, a hard link, a fifo and a link-named entry are reported, not copied (finding 3)", { skip: !POSIX && "links and fifos need POSIX" }, async () => {
  const d = tmp();
  try {
    const secret = join(d, "outside-secret"); writeFileSync(secret, "TOP-SECRET-OUTSIDE");
    mkdirSync(join(d, "real")); writeFileSync(join(d, "real", "history.jsonl"), LINE);
    symlinkSync(join(d, "real"), join(d, "linked-root"));
    mkdirSync(join(d, "att-2")); writeFileSync(join(d, "att-2", "ok.json"), "{}");
    symlinkSync(secret, join(d, "att-2", "link.json"));
    linkSync(secret, join(d, "att-2", "hard.json"));
    (await import("node:child_process")).execFileSync("mkfifo", [join(d, "att-2", "pipe")]);
    const source: PiStateSource = { list: async () => [{ id: "att-1", dir: join(d, "linked-root") }, { id: "att-2", dir: join(d, "att-2") }] };
    const store = new MemoryStorage(); await populate(store);
    const { path, manifest } = await createBackup(store, { root: join(d, "b"), kind: "manual", version: "t", now: () => new Date(AT), piState: source });
    assert.equal(manifest.piState?.files, 1, "only the plain file");
    const all = readdirSync(path, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => readFileSync(join(e.parentPath, e.name), "utf8")).join("");
    assert.equal(all.includes("TOP-SECRET-OUTSIDE"), false);
    assert.equal(all.includes(LINE.slice(0, 20)), false, "the linked store root was not followed");
    const text = (manifest.piState?.problems ?? []).join("\n");
    assert.match(text, /att-1: the store folder is a link/);
    assert.match(text, /link\.json is a link/); assert.match(text, /hard\.json has more than one hard link/); assert.match(text, /pipe is not a plain file/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a store folder that cannot be read is reported as a problem, not recorded as an empty store (finding 4)", { skip: (!POSIX || ROOT) && "needs POSIX modes and a non-root user" }, async () => {
  const d = tmp();
  try {
    const src = stores(join(d, "live")); mkdirSync(join(d, "live", "att-1", "sealed")); writeFileSync(join(d, "live", "att-1", "sealed", "x.jsonl"), LINE); chmodSync(join(d, "live", "att-1", "sealed"), 0o000);
    const store = new MemoryStorage(); await populate(store);
    const { manifest } = await createBackup(store, { root: join(d, "b"), kind: "manual", version: "t", now: () => new Date(AT), piState: src });
    chmodSync(join(d, "live", "att-1", "sealed"), 0o700);
    assert.equal(manifest.piState?.files, 1);
    assert.match((manifest.piState?.problems ?? []).join(), /sealed cannot be read/);
    assert.equal(manifest.piState?.problemCount, 1);
    // A missing store root is a problem too.
    const { manifest: m2 } = await createBackup(store, { root: join(d, "b2"), kind: "manual", version: "t", now: () => new Date(AT), piState: { list: async () => [{ id: "att-9", dir: join(d, "gone") }] } });
    assert.match((m2.piState?.problems ?? []).join(), /att-9: the store folder cannot be read/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a file that shrinks or is replaced while it is copied is tried again; if it keeps changing it is reported inconsistent and not recorded as a shorter copy (finding 4)", async () => {
  const d = tmp();
  try {
    const src = stores(join(d, "live"));
    const file = join(d, "live", "att-1", "history.jsonl");
    writeFileSync(file, LINE.repeat(50));
    const big = LINE.repeat(50).length;
    // Always shrinking during the copy: inconsistent, not in the index.
    const s1 = tmp();
    await (await import("node:fs/promises")).mkdir(join(s1, "x"));
    const always = await copyPiState(src, s1, undefined, { afterCopy: async (p) => { truncateSync(p, nodeFs.statSync(p).size - 50); } });
    assert.equal(always.files, 0);
    assert.match((always.problems ?? []).join(), /inconsistent/);
    assert.match((always.problems ?? []).join(), /became shorter/);
    // Shrinking only on the first attempt: the retry copies the file whole at its new size, and the index says what was copied.
    writeFileSync(file, LINE.repeat(50));
    const s2 = tmp(); await (await import("node:fs/promises")).mkdir(join(s2, "x"));
    const once = await copyPiState(src, s2, undefined, { afterCopy: async (p, attempt) => { if (attempt === 0) truncateSync(p, LINE.length * 10 + 5); } });
    assert.equal(once.files, 1); assert.equal(once.problems, undefined);
    assert.equal(once.bytes, LINE.length * 10, "copied up to the last complete line of the file as it then was");
    assert.ok(once.bytes < big);
    rmSync(s1, { recursive: true, force: true }); rmSync(s2, { recursive: true, force: true });
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("the approval token covers the whole backup, expires, is used once and is checked again at apply (findings 5, 6)", async () => {
  const r = await rig();
  try {
    const sr = r.restore({ confirmMinutes: async () => 5 });
    const plan = await sr.preview(r.made.manifest.name);
    assert.ok(plan.expiresAt);
    // Any change in the manifest (here the artifact/conversation part) changes what the token was bound to.
    const mpath = join(r.d, "b", r.made.manifest.name, "manifest.json");
    const original = readFileSync(mpath, "utf8");
    const m = JSON.parse(original); m.piState.stores = 99; writeFileSync(mpath, JSON.stringify(m));
    await assert.rejects(sr.apply(plan.name, plan.token), /out of date/);
    writeFileSync(mpath, original);
    // Expired.
    r.tick(6 * 60_000);
    await assert.rejects(sr.apply(plan.name, plan.token), /expired/);
    // Fresh token works once; the same token again is refused.
    const fresh = await sr.preview(r.made.manifest.name);
    assert.notEqual(fresh.token, plan.token);
    const done = await sr.apply(fresh.name, fresh.token);
    assert.equal(typeof done.changesDiscarded, "number");
    assert.ok((done.changesDiscarded ?? 0) >= 1, "the owner is told how much work is lost");
    assert.ok((fresh.changesSinceBackup ?? 0) >= 1);
    assert.match(fresh.warnings.join(" "), /discarded/);
    await sr.cancel();
    await assert.rejects(sr.apply(fresh.name, fresh.token), /already used/);
    // A token cannot be taken from another process's preview.
    const other = r.restore();
    await assert.rejects(other.apply(fresh.name, "0.0000000000000000.00000000000000000000000000000000"), /out of date/);
    // No expiry when the owner turned it off.
    const forever = r.restore({ confirmMinutes: async () => null });
    const p3 = await forever.preview(r.made.manifest.name);
    assert.equal(p3.expiresAt, undefined);
    r.tick(10 * 24 * 3_600_000);
    await forever.apply(p3.name, p3.token); await forever.cancel();
  } finally { rm_(r.d); }
});

test("a restore does not bring a deleted artifact's files back, also when it is cancelled (finding 7)", async () => {
  const d = tmp();
  try {
    const blobs = await FileBlobStore.open({ directory: join(d, "blobs") });
    const kept = await blobs.put(Buffer.from("kept bytes"));
    const gone = await blobs.put(Buffer.from("deleted bytes"));
    const shared = await blobs.put(Buffer.from("shared bytes"));
    const store = new MemoryStorage();
    await populate(store, "t", [
      { type: "create", ref: { kind: "artifact", id: "art-kept" }, body: { name: "k", entries: [{ path: "a", digest: kept.digest, size: kept.size }, { path: "s", digest: shared.digest, size: shared.size }], manifestDigest: "x", totalBytes: 1, createdBy: "o" } },
      { type: "create", ref: { kind: "artifact", id: "art-gone" }, body: { name: "g", entries: [{ path: "a", digest: gone.digest, size: gone.size }, { path: "s", digest: shared.digest, size: shared.size }], manifestDigest: "y", totalBytes: 1, createdBy: "o" } },
    ]);
    const { path } = await createBackup(store, { root: join(d, "b"), kind: "manual", version: "t", now: () => new Date(AT), blobs });
    for (const digest of [kept.digest, gone.digest, shared.digest]) await blobs.remove(digest);
    const ledger: LedgerEntry[] = [{ deletionId: "del-1", at: AT, by: "owner:rob", reason: "asked", desk: [], compactions: [], removed: [{ kind: "artifact", id: "art-gone" }] }];
    const target = new MemoryStorage();
    const done = await restoreBackup(path, target, { blobs, deletions: ledger });
    assert.equal(done.blobsSkippedDeleted, 1);
    assert.equal(await blobs.has(gone.digest), false, "the deleted artifact's bytes stay deleted");
    assert.equal(await blobs.has(kept.digest), true);
    assert.equal(await blobs.has(shared.digest), true, "bytes another live artifact still holds come back");
    assert.equal(await target.getAggregate({ kind: "artifact", id: "art-gone" }), undefined);
    // And through the staged restore: delete -> restore -> cancel leaves them deleted.
    await blobs.remove(kept.digest); await blobs.remove(shared.digest);
    const data = join(d, "data"); mkdirSync(data);
    const live = await SqliteStorage.open({ path: join(data, "c.sqlite") }); await populate(live);
    const backups = new BackupService(live, { root: join(d, "b"), version: "t", now: () => new Date("2026-10-31T10:30:00.000Z") });
    const barrier = new MaintenanceBarrier();
    // The live store needs the same schema as the backup (it was made from the memory store).
    const sr = new StagedRestore({ backups, root: join(d, "b"), barrier, sqlitePath: join(data, "c.sqlite"), dataDirectory: data, storage: live, blobs, deletions: async () => ledger, now: () => new Date("2026-10-31T12:00:00.000Z") });
    const plan = await sr.preview(basenameOf(path));
    const applied = await sr.apply(plan.name, plan.token);
    assert.equal(applied.result.blobsSkippedDeleted, 1);
    await sr.cancel();
    assert.equal(await blobs.has(gone.digest), false);
    await live.close();
  } finally { rmSync(d, { recursive: true, force: true }); }
});
const basenameOf = (p: string): string => p.split(/[\\/]/).pop()!;

test("the status says whether Pi state is in backups; a backup without it is labelled not included, and the plan says what that means (finding 8)", async () => {
  const d = tmp();
  try {
    const store = new MemoryStorage(); await populate(store);
    const plain = new BackupService(store, { root: join(d, "b"), version: "t", now: () => new Date(AT) });
    const made = await plain.backUpNow("manual");
    assert.equal((await plain.status()).piStateIncluded, false);
    assert.equal(made.manifest.piState, undefined);
    const withPi = new BackupService(store, { root: join(d, "b2"), version: "t", now: () => new Date(AT), piState: stores(join(d, "live")) });
    assert.equal((await withPi.status()).piStateIncluded, true);
  } finally { rmSync(d, { recursive: true, force: true }); }
  const r = await rig();
  try {
    const noPi = await createBackup(await (async () => { const s = new MemoryStorage(); await populate(s); return s; })(), { root: join(r.d, "b"), kind: "manual", version: "t", now: () => new Date("2026-10-30T10:00:00.000Z") });
    const plan = await r.restore({ piStateConfigured: false }).preview(noPi.manifest.name).catch((e) => e);
    // The schema versions agree (both current), the wording is the point.
    assert.equal(plan.piStateIncluded, false);
    const text = plan.warnings.join(" ");
    assert.match(text, /Pi state is NOT included/); assert.match(text, /AHEAD of the restored records/); assert.match(text, /do not include the agents' conversation state at all/);
  } finally { rm_(r.d); }
});

test("starting a restore swap takes the data directory's lock: an overlapping start is refused, a stale lock is taken over (finding 9)", async () => {
  const { r } = await prepared();
  try {
    const held = await acquireDataLock(await canon(r.dataRel));
    await assert.rejects(applyPendingRestore(r.dataRel, r.sqlite, undefined, { piFinal: r.piFinal }), (e: unknown) => e instanceof DomainError && /another controller holds/.test(e.message));
    assert.equal(existsSync(join(r.dataRel, "restore-journal.json")), false, "nothing was swapped");
    assert.equal(await dbTitle(r.sqlite, "task-late"), "late");
    await assert.rejects(acquireDataLock(r.dataRel), /another controller/);
    await held.release();
    // A lock whose process is gone is stale.
    writeFileSync(join(r.dataRel, ".nn-data.lock"), JSON.stringify({ pid: 2 ** 22 + 12345, host: (await import("node:os")).hostname(), nonce: "dead", at: AT }));
    assert.equal(await applyPendingRestore(r.dataRel, r.sqlite, undefined, { piFinal: r.piFinal }), r.made.manifest.name);
    assert.equal(existsSync(join(r.dataRel, ".nn-data.lock")), false, "the swap's own lock is let go");
  } finally { rm_(r.d); }
});

test("snapshots before a restore are their own kind; all are kept unless the owner sets a count, and they never count as the nightly backup (finding 10)", async () => {
  const info = (iso: string, kind: BackupKind): BackupInfo => ({ path: `/b/${iso}-${kind}`, manifest: { createdAt: iso, kind } as never, at: iso, trusted: true });
  const all = [info("2026-10-30T10:00:00.000Z", "pre-restore"), info("2026-10-29T10:00:00.000Z", "pre-restore"), info("2026-10-28T10:00:00.000Z", "pre-restore"), info("2026-10-31T10:00:00.000Z", "manual")];
  assert.equal([...chooseKept(all, { daily: 1, weekly: 0 })].filter((p) => p.includes("pre-restore")).length, 3, "default: keep all");
  assert.equal([...chooseKept(all, { daily: 1, weekly: 0, preRestoreKept: null })].filter((p) => p.includes("pre-restore")).length, 3);
  const two = [...chooseKept(all, { daily: 1, weekly: 0, preRestoreKept: 2 })].filter((p) => p.includes("pre-restore")).sort();
  assert.deepEqual(two, ["/b/2026-10-29T10:00:00.000Z-pre-restore", "/b/2026-10-30T10:00:00.000Z-pre-restore"]);
  const d = tmp();
  try {
    const store = new MemoryStorage(); await populate(store);
    const svc = new BackupService(store, { root: join(d, "b"), version: "t", now: () => new Date(AT) });
    const copy = await svc.safetyCopy();
    assert.equal(copy.manifest.kind, "pre-restore"); assert.match(copy.path, /-pre-restore$/);
    assert.equal((await svc.lastGood()).at, undefined, "not a good nightly backup");
    assert.equal(validRel("a/b"), true);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("an unlock refused for a reason is a typed error with that reason; the preview refuses a backup of another schema; the status reads the marker after a restart (finding 11)", async () => {
  const r = await rig();
  try {
    const { keyring } = await createKeyring({ passcode: "correct horse battery staple 42", scrypt: FAST });
    const encStore = new MemoryStorage(); await populate(encStore);
    // An encrypted backup in the same folder as the others.
    const enc = await createBackup(encStore, { root: join(r.d, "b"), kind: "manual", version: "t", now: () => new Date("2026-10-30T09:00:00.000Z"), encryption: keyring });
    const sr = r.restore({ unlock: async () => { throw new ProofRefused("rate_limited", "too many tries; wait a minute"); } });
    const plan = await sr.preview(enc.manifest.name);
    await assert.rejects(sr.apply(plan.name, plan.token), (e: unknown) => e instanceof DomainError && e.code === "invalid_command" && /too many tries/.test(e.message));
    assert.equal(r.barrier.held, false);
    // Schema mismatch.
    const other = { ...r.storage, currentEpoch: () => r.storage.currentEpoch(), snapshot: async () => ({ schemaVersion: 999, close: async () => undefined }) } as never;
    await assert.rejects(r.restore({ storage: other }).preview(r.made.manifest.name), (e: unknown) => e instanceof DomainError && /schema version/.test(e.message));
    // The status of a fresh object reads the marker (after a restart).
    const real = r.restore();
    const p = await real.preview(r.made.manifest.name); await real.apply(p.name, p.token);
    assert.equal((await r.restore().status()).pending?.name, r.made.manifest.name);
    assert.equal(unlockWithPasscode.length >= 0, true);
  } finally { rm_(r.d); }
});

test("cancel brings the barrier down even when the marker cannot be removed, and says so (finding 12)", { skip: (!POSIX || ROOT) && "needs POSIX modes and a non-root user" }, async () => {
  const r = await rig();
  try {
    const sr = r.restore();
    const p = await sr.preview(r.made.manifest.name); await sr.apply(p.name, p.token);
    assert.equal(r.barrier.held, true);
    chmodSync(r.dataRel, 0o500);
    try { await assert.rejects(sr.cancel(), /could not be withdrawn/); } finally { chmodSync(r.dataRel, 0o700); }
    assert.equal(r.barrier.held, false, "the barrier is down although the removal failed");
    assert.equal(existsSync(join(r.dataRel, "pending-restore.json")), true);
    // Trying again works and reports the marker gone.
    assert.equal((await sr.cancel()).cancelled, true);
    assert.equal(existsSync(join(r.dataRel, "pending-restore.json")), false);
  } finally { rm_(r.d); }
});

test("paths Windows cannot keep are refused on every platform: device names, trailing dots and spaces (finding 13)", () => {
  for (const bad of ["con", "CON.txt", "a/nul", "a/Aux.json", "com1", "LPT9.log", "a/b.", "a/b ", "a./b", "a/ b ", "x/prn.jsonl", "a/b\u0001"]) assert.equal(validRel(bad), false, bad);
  for (const good of ["console.json", "a/auxiliary", "com10", "comma/x", "history.jsonl", "a/b c.json", "dot.in.name"]) assert.equal(validRel(good), true, good);
});

test("an encrypted backup restores from inside the controller with an unlock function on every platform, no secret file needed (finding 13)", async () => {
  const d = tmp();
  try {
    const data = join(d, "data"); mkdirSync(data);
    const sqlite = join(data, "c.sqlite");
    const { keyring } = await createKeyring({ passcode: "correct horse battery staple 42", scrypt: FAST });
    const storage = await SqliteStorage.open({ path: sqlite }); await populate(storage, "sealed");
    const live = join(d, "live");
    const backups = new BackupService(storage, { root: join(d, "b"), version: "t", now: () => new Date(AT), encryption: keyring, piState: stores(live) });
    const made = await backups.backUpNow("manual");
    const sr = new StagedRestore({ backups, root: join(d, "b"), barrier: new MaintenanceBarrier(), sqlitePath: sqlite, dataDirectory: data, storage, piFinal: (id) => join(live, id), unlock: async () => unlockWithPasscode(keyring, "correct horse battery staple 42"), now: () => new Date("2026-10-31T11:00:00.000Z") });
    const plan = await sr.preview(made.manifest.name);
    assert.equal(plan.encrypted, true);
    const done = await sr.apply(plan.name, plan.token);
    assert.equal(done.result.piFilesRestored, 1);
    assert.equal(JSON.stringify(done).includes("correct horse"), false);
    await storage.close();
    assert.equal(await applyPendingRestore(data, sqlite, undefined, { piFinal: (id) => join(live, id) }), made.manifest.name);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
