import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { Principal } from "../security/principals.js";
import type { ControllerStorage } from "../storage/index.js";
import { BackupConfigService, BackupService, BackupSystem, FolderDriver, HttpDriver, chooseKept, createBackup, describeRules, generationReport, listBackups, offsiteLocationProblem, parseKeyring, staysUpToDays, type BackupInfo, type BackupRetention, type TargetDriver } from "./index.js";
import { runBackupCli } from "./cli.js";
import { startFakeTarget, type FakeTarget } from "./testing/target-server.js";

after(stopServer);

// Card K01c: the configurable backup system: targets (another folder or disk, an off-machine store reached over a loopback fake), the age limit, per-target retention, purge, test restore, key generations and the notices.

const T0 = Date.UTC(2026, 9, 1, 3, 0, 0);
const DAYMS = 86_400_000;
const owner = { kind: "owner", id: "owner:rob", grants: [] } as unknown as Principal;
const agent = { kind: "agent", id: "agent:zed", grants: [] } as unknown as Principal;
const scoped = { kind: "owner", id: "owner:rob", grants: [], taskScope: { taskId: "t" } } as unknown as Principal;

interface Emitted { commandId: string; ref: { kind: string; id: string }; label: string; detail: string; interrupt?: boolean; level?: string }
function fakeNotifications() {
  const open = new Map<string, Set<string>>();
  const emitted: Emitted[] = [];
  return {
    emitted, open,
    port: {
      emitFromController: async (c: Emitted) => { emitted.push(c); const s = open.get(c.ref.kind) ?? new Set<string>(); s.add(c.ref.id); open.set(c.ref.kind, s); return { itemId: "i", coalesced: false, immediate: false }; },
      settleFromController: async (c: { ref: { kind: string; id: string } }) => { const had = open.get(c.ref.kind)?.delete(c.ref.id) ?? false; return { closed: had }; },
      openRefIds: async (kind: string) => [...(open.get(kind) ?? [])],
    } as never,
    isOpen: (kind: string, id?: string): boolean => (id === undefined ? (open.get(kind)?.size ?? 0) > 0 : open.get(kind)?.has(id) === true),
  };
}

async function seed(storage: ControllerStorage): Promise<number> {
  const { epoch } = await storage.acquireEpoch({ holder: "c1", at: new Date(T0).toISOString() });
  await storage.applyOperation({ operationId: "op-1", epoch, actor: "owner:rob", correlationId: "co-1", at: new Date(T0).toISOString(), changes: [{ type: "create", ref: { kind: "task", id: "task-a" }, body: { title: "t" } }], audit: [{ type: "task.created", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
  return epoch;
}

interface Rig {
  d: string; root: string; clock: { t: number }; epoch: number; storage: ControllerStorage; config: BackupConfigService; service: BackupService; system: BackupSystem; notes: ReturnType<typeof fakeNotifications>;
  retention: { value: BackupRetention }; day(n: number): void; backup(n: number): Promise<string>; names(dir: string): string[];
}
async function rig(storage: ControllerStorage, options: { retention?: BackupRetention; resolveSecret?: (n: string) => Promise<string | undefined>; driverFor?: (t: never) => TargetDriver | undefined; keyringFile?: string } = {}): Promise<Rig> {
  const d = mkdtempSync(join(tmpdir(), "nn-k01c-"));
  const root = join(d, "backups");
  const epoch = await seed(storage);
  const clock = { t: T0 };
  const config = BackupConfigService.withEpoch(storage, epoch, { clock: () => new Date(clock.t).toISOString() });
  const notes = fakeNotifications();
  const retention = { value: options.retention ?? { daily: 7, weekly: 4, maxAgeDays: 35 } };
  let system!: BackupSystem;
  const service = new BackupService(storage, {
    root, version: "t", now: () => new Date(clock.t), retentionSource: async () => retention.value,
    scheduleSource: async () => { const c = await config.effective(); return { everyMs: c.everyHours * 3_600_000, hourUtc: c.hourUtc }; },
    verifiedSource: () => system.verifiedNames(), afterBackup: (made) => system.afterBackup(made),
  });
  system = new BackupSystem({ service, config, root, notifications: notes.port, retention: async () => retention.value, now: () => new Date(clock.t), ...(options.resolveSecret === undefined ? {} : { resolveSecret: options.resolveSecret }), ...(options.driverFor === undefined ? {} : { driverFor: options.driverFor as never }), ...(options.keyringFile === undefined ? {} : { keyringFile: options.keyringFile }), scratchDirectory: d });
  return {
    d, root, clock, epoch, storage, config, service, system, notes, retention,
    day: (n) => { clock.t = T0 + n * DAYMS; },
    backup: async (n) => { clock.t = T0 + n * DAYMS; const made = await service.backUpNow("scheduled"); await service.finish(); return made.manifest.name; },
    names: (dir) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith("backup-") && !n.endsWith(".partial")).sort() : []),
  };
}
const cleanup = (r: Rig): void => rmSync(r.d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

// ---- the rules (no storage) ----------------------------------------------------------------------------------------------------------

const info = (at: string, kind: "scheduled" | "manual" | "pre-upgrade" | "pre-restore" = "scheduled"): BackupInfo => {
  const name = `backup-${at.replace(/[-:]/g, "").slice(0, 15)}Z-${kind}`;
  return { path: name, at: `${at.slice(0, 19)}.000Z`, trusted: true, manifest: { name, kind, createdAt: `${at.slice(0, 19)}.000Z` } as never };
};

test("the age limit deletes a backup the counts would keep, but never the newest, the newest verified complete one, a pre-upgrade snapshot or a pre-restore snapshot (card K01c)", () => {
  const now = new Date(Date.UTC(2026, 10, 14, 12));
  const days = (n: number): string => new Date(now.getTime() - n * DAYMS).toISOString();
  const all = [0, 1, 2, 10, 20, 30, 40, 50].map((n) => info(days(n)));
  const upgrade = info(days(60), "pre-upgrade"); const restore = info(days(70), "pre-restore");
  const counted = chooseKept([...all, upgrade, restore], { daily: 7, weekly: 52 }, now);
  assert.ok(all.every((b) => counted.has(b.path)), "counts alone keep all of them");
  const aged = chooseKept([...all, upgrade, restore], { daily: 7, weekly: 52, maxAgeDays: 35 }, now);
  assert.deepEqual(all.filter((b) => !aged.has(b.path)).map((b) => b.path), [all[6]!.path, all[7]!.path], "40 and 50 days old go; 30 stays");
  assert.ok(aged.has(upgrade.path) && aged.has(restore.path), "snapshots with rules of their own stay");
  // Nothing new for longer than the limit: every backup is older than 35 days, the newest good one stays.
  const stale = [50, 60, 70].map((n) => info(days(n)));
  assert.deepEqual([...chooseKept(stale, { daily: 7, weekly: 4, maxAgeDays: 35 }, now)], [stale[0]!.path]);
  // The newest verified complete one stays too, even when a newer unverified one exists.
  const protectedName = stale[1]!.path;
  const kept = chooseKept([info(days(40)), ...stale], { daily: 7, weekly: 4, maxAgeDays: 35, protect: new Set([protectedName]) }, now);
  assert.ok(kept.has(protectedName) && kept.has(stale[0]!.path === protectedName ? "" : info(days(40)).path), "the newest and the protected one stay");
  assert.equal(kept.has(stale[2]!.path), false);
  // No limit: the counts decide, as in the first release.
  assert.equal(chooseKept(stale, { daily: 7, weekly: 4 }, now).size, 3);
});

test("the counts and the age limit are said back to the owner, and which one decides (card K01c)", () => {
  assert.equal(describeRules({ daily: 7, weekly: 4, maxAgeDays: 35 }).overrides, "counts");
  assert.equal(describeRules({ daily: 7, weekly: 4, maxAgeDays: 34 }).overrides, "same");
  const age = describeRules({ daily: 7, weekly: 8, maxAgeDays: 30 });
  assert.equal(age.overrides, "age");
  assert.match(age.text, /age limit \(30 days\) is shorter/);
  assert.equal(describeRules({ daily: 7, weekly: 4, maxAgeDays: null }).overrides, "none");
  assert.equal(staysUpToDays({ daily: 7, weekly: 4, maxAgeDays: 20 }), 20);
  assert.equal(staysUpToDays({ daily: 7, weekly: 4, maxAgeDays: null }), 34);
});

test("an off-machine address is checked: https, or plain http for this machine only, no password or query in it (card K01c)", () => {
  assert.equal(offsiteLocationProblem("https://backup.example.com/store"), undefined);
  assert.equal(offsiteLocationProblem("http://127.0.0.1:8080/"), undefined);
  assert.match(offsiteLocationProblem("http://backup.example.com/")!, /plain http/);
  assert.match(offsiteLocationProblem("https://rob:hunter2@backup.example.com/")!, /user name or password/);
  assert.match(offsiteLocationProblem("https://backup.example.com/?token=abc")!, /query/);
  assert.match(offsiteLocationProblem("ftp://x/")!, /only https/);
  assert.match(offsiteLocationProblem("not an address")!, /not an address/);
});

// ---- the drivers ---------------------------------------------------------------------------------------------------------------------

test("the off-machine driver: a copy is listed only once committed, an unreachable or wrongly credentialled target is an error and not an empty list, a deletion is exact (card K01c)", async () => {
  const fake = await startFakeTarget("secret-token");
  const d = mkdtempSync(join(tmpdir(), "nn-k01c-drv-"));
  try {
    const { MemoryStorage } = await import("../storage/index.js");
    const s = new MemoryStorage(); await s.acquireEpoch({ holder: "c", at: new Date(T0).toISOString() });
    const made = await createBackup(s, { root: join(d, "b"), kind: "manual", version: "t", now: () => new Date(T0) });
    const driver = new HttpDriver(fake.url, { token: async () => "secret-token" });
    assert.equal((await driver.test()).ok, true);
    await driver.put(made.path, made.manifest.name);
    assert.deepEqual((await driver.list()).map((b) => b.manifest.name), [made.manifest.name]);
    assert.equal((await driver.list())[0]!.trusted, true);
    // The same name again is the same backup: nothing is uploaded twice.
    const before = fake.requests.length;
    await driver.put(made.path, made.manifest.name);
    assert.equal(fake.requests.slice(before).filter((r) => r.startsWith("PUT")).length, 0);
    // What comes back is the backup, byte for byte.
    await driver.fetch(made.manifest.name, join(d, "back"));
    assert.equal(readFileSync(join(d, "back", "manifest.json"), "utf8"), readFileSync(join(made.path, "manifest.json"), "utf8"));
    // A copy that never committed is not listed.
    fake.failPuts = true;
    const made2 = await createBackup(s, { root: join(d, "b"), kind: "manual", version: "t", now: () => new Date(T0 + 5000) });
    await assert.rejects(driver.put(made2.path, made2.manifest.name));
    fake.failPuts = false;
    assert.deepEqual((await driver.list()).map((b) => b.manifest.name), [made.manifest.name]);
    // A wrong credential, and a target that is down, are errors.
    const wrong = new HttpDriver(fake.url, { token: async () => "nope" });
    assert.equal((await wrong.test()).ok, false);
    assert.match((await wrong.test()).detail, /refused the credential/);
    await assert.rejects(wrong.list(), /refused the credential/);
    fake.down = true;
    await assert.rejects(driver.list(), /could not be reached/);
    assert.equal((await driver.test()).ok, false);
    fake.down = false;
    // Deleting: true once, false when it is already gone; only a backup's name is accepted.
    assert.equal(await driver.remove(made.manifest.name), true);
    assert.equal(await driver.remove(made.manifest.name), false);
    await assert.rejects(driver.remove("../etc"), /not the name of a backup/);
    assert.throws(() => new HttpDriver("http://example.com/"), /plain http/);
  } finally { await fake.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("the folder driver copies completely or not at all, warns when the folder is on the main disk and refuses the main folder itself (card K01c)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-k01c-fold-"));
  try {
    const { MemoryStorage } = await import("../storage/index.js");
    const s = new MemoryStorage(); await s.acquireEpoch({ holder: "c", at: new Date(T0).toISOString() });
    const made = await createBackup(s, { root: join(d, "main"), kind: "manual", version: "t", now: () => new Date(T0) });
    const driver = new FolderDriver(join(d, "other"), { primaryRoot: join(d, "main") });
    const t = await driver.test();
    assert.equal(t.ok, true);
    assert.match(t.warning ?? "", /same disk/);
    await driver.put(made.path, made.manifest.name);
    await driver.put(made.path, made.manifest.name); // again: left as it is
    assert.deepEqual(readdirSync(join(d, "other")), [made.manifest.name]);
    assert.deepEqual((await driver.list()).map((b) => b.manifest.name), [made.manifest.name]);
    assert.equal(await driver.remove(made.manifest.name), true);
    assert.equal(await driver.remove(made.manifest.name), false);
    assert.equal((await new FolderDriver(join(d, "main"), { primaryRoot: join(d, "main") }).test()).ok, false);
    assert.equal((await new FolderDriver(join(d, "main", "inside"), { primaryRoot: join(d, "main") }).test()).ok, false);
    writeFileSync(join(d, "afile"), "x");
    assert.equal((await new FolderDriver(join(d, "afile", "sub")).test()).ok, false);
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

// ---- the configuration, on every storage backend -----------------------------------------------------------------------------------------

for (const backend of backends) {
  test(`${backend.name}: the schedule and the targets are owner-only, validated, revision-checked, replay-safe and recorded; targets are added after a test and removed without deleting copies (card K01c)`, async () => {
    const world = await backend.open();
    const r = await rig(world.storage);
    try {
      const told: string[] = [];
      r.config.onChanged(async (c) => { told.push(`${c.what}`); });
      assert.deepEqual(await r.config.effective().then((c) => [c.everyHours, c.hourUtc, c.verifyEveryDays, c.targets.length]), [24, null, 7, 0], "defaults: daily, any hour, a weekly test restore, no target");
      for (const who of [agent, scoped]) {
        await assert.rejects(r.config.setSchedule(who, { commandId: "x1", everyHours: 6 }), /may not change the backup schedule/);
        await assert.rejects(r.system.addTarget(who, { commandId: "x2", name: "A", kind: "folder", location: join(r.d, "a") }), /may not add a backup target/);
        await assert.rejects(r.system.purge(who, { commandId: "x3", names: ["backup-20261001T030000Z-manual"] }), /may not purge/);
        await assert.rejects(r.system.verifyNow(who), /may not run a test restore/);
        await assert.rejects(r.config.get(who), /may not read/);
      }
      for (const bad of [{}, { everyHours: 0 }, { everyHours: 1.5 }, { everyHours: 1000 }, { hourUtc: 24 }, { verifyEveryDays: 0 }, { everyHours: 6, hourUtc: 3 }, { extra: 1 }]) await assert.rejects(r.config.setSchedule(owner, { commandId: "bad", ...bad } as never), /invalid|must be|give|field|day or more/i, JSON.stringify(bad));
      const set = await r.config.setSchedule(owner, { commandId: "s1", everyHours: 12, verifyEveryDays: 3 });
      assert.equal(set.changed, true);
      assert.match(set.text, /every 12 hours.*every 3 days/s);
      assert.equal((await r.config.setSchedule(owner, { commandId: "s1", everyHours: 12, verifyEveryDays: 3 })).changed, false, "the same command again changes and announces nothing");
      await assert.rejects(r.config.setSchedule(owner, { commandId: "s2", everyHours: 12 }), /already/);
      await assert.rejects(r.config.setSchedule(owner, { commandId: "s3", everyHours: 6, expectedRevision: 9 }), /revision/);
      assert.equal((await r.config.setSchedule(owner, { commandId: "s4", everyHours: 24, hourUtc: 2 })).changed, true);
      assert.match((await r.config.setSchedule(owner, { commandId: "s5", verifyEveryDays: null })).text, /No backup is test-restored automatically/);
      assert.equal(told.length, 3, "three real changes were announced; the repeat and the refusals were not");
      // Targets: bad ones are refused, none is added when the test fails.
      const bads: Record<string, unknown>[] = [{ name: "", kind: "folder", location: join(r.d, "a") }, { name: "A", kind: "tape", location: "x" }, { name: "A", kind: "folder", location: "relative/path" }, { name: "A", kind: "offsite", location: "http://example.com/" }, { name: "A", kind: "offsite", location: "https://u:p@example.com/" }, { name: "A", kind: "folder", location: join(r.d, "a"), credential: "x" }, { name: "A", kind: "offsite", location: "https://example.com/", credential: "bad credential with spaces" }, { name: "A", kind: "folder", location: join(r.d, "a"), keepDays: 0 }];
      for (const [i, bad] of bads.entries()) await assert.rejects(r.system.addTarget(owner, { commandId: `bad${i}`, ...bad }), /name|kind|location|credential|keepDays|http|address/i, JSON.stringify(bad));
      writeFileSync(join(r.d, "afile"), "x");
      await assert.rejects(r.system.addTarget(owner, { commandId: "t0", name: "Broken", kind: "folder", location: join(r.d, "afile", "sub") }), /did not pass its test, so it was not added/);
      assert.equal((await r.config.effective()).targets.length, 0);
      const added = await r.system.addTarget(owner, { commandId: "t1", name: "Other disk", kind: "disk", location: join(r.d, "disk"), keepDays: 10 });
      assert.equal(added.target.kind, "disk");
      assert.match(added.text, /same disk/, "a folder on the same disk is warned about");
      await assert.rejects(r.system.addTarget(owner, { commandId: "t2", name: "other DISK", kind: "folder", location: join(r.d, "disk2") }), /exists already/);
      await assert.rejects(r.system.addTarget(owner, { commandId: "t3", name: "Else", kind: "folder", location: join(r.d, "disk") }), /exists already/);
      const again = await r.system.addTarget(owner, { commandId: "t1", name: "Other disk", kind: "disk", location: join(r.d, "disk"), keepDays: 10 });
      assert.equal(again.target.id, added.target.id, "the same command is the same target");
      assert.equal((await r.config.effective()).targets.length, 1);
      assert.equal((await r.system.testTarget(owner, "other disk")).ok, true);
      await assert.rejects(r.system.testTarget(owner, "nope"), /no such backup target/);
      // Removal keeps the copies where they are.
      await r.backup(0);
      await r.system.idle();
      assert.equal(r.names(join(r.d, "disk")).length, 1);
      const gone = await r.config.removeTarget(owner, { commandId: "rm1", id: added.target.id });
      assert.match(gone.text, /not deleted/);
      assert.equal(r.names(join(r.d, "disk")).length, 1);
      assert.equal((await r.config.effective()).targets.length, 0);
      await assert.rejects(r.config.removeTarget(owner, { commandId: "rm2", id: added.target.id }), /no such backup target/);
      // Recorded: every change names the owner in the audit log.
      const audit = await world.storage.listAudit({ afterSeq: 0, limit: 1000 });
      for (const type of ["backup.config.schedule", "backup.target.add", "backup.target.remove"]) assert.ok(audit.some((a) => a.type === type && a.actor === "owner:rob"), `${type} is in the audit log under the owner`);
      assert.equal(audit.some((a) => JSON.stringify(a.detail).includes("secret")), false);
    } finally { await r.system.idle(); cleanup(r); await world.close(); }
  });

  test(`${backend.name}: every backup goes to every target, each target keeps it for its own time, an unreachable target does not stop the others and is caught up later with the owner told (card K01c)`, async () => {
    const world = await backend.open();
    const fake = await startFakeTarget("tok");
    const r = await rig(world.storage, { resolveSecret: async (n) => (n === "offsite-key" ? fake.token : undefined) });
    try {
      await r.system.addTarget(owner, { commandId: "t1", name: "Disk", kind: "disk", location: join(r.d, "disk"), keepDays: 3 });
      await r.system.addTarget(owner, { commandId: "t2", name: "Cloud", kind: "offsite", location: fake.url, credential: "offsite-key" });
      for (let n = 0; n < 10; n++) await r.backup(n);
      await r.system.idle();
      const main = r.names(r.root);
      assert.equal(main.length, 7, "the main folder keeps the last seven days (the weekly copies are among them)");
      assert.equal(fake.store.size, 7, "the off-machine target holds every backup (it follows the installation's rules)");
      const disk = r.names(join(r.d, "disk"));
      assert.ok(disk.length >= 3 && disk.length <= 4, `the disk keeps backups for 3 days only: ${disk.length}`);
      assert.ok(disk.includes(main[6]!) && !disk.includes(main[0]!));
      const status = await r.system.status() as { targets: { name: string; staysUpToDays: number; reachable: boolean; count: number }[] };
      assert.deepEqual(status.targets.map((t) => [t.name, t.staysUpToDays, t.reachable]), [["Disk", 3, true], ["Cloud", 34, true]], "how long a backup stays is said by target");
      // The off-machine target goes down: the next backup still succeeds locally and on the disk, the failure is told, nothing is deleted anywhere.
      fake.down = true;
      const eleven = await r.backup(10);
      await r.system.idle();
      assert.ok(r.names(r.root).includes(eleven) && r.names(join(r.d, "disk")).includes(eleven));
      assert.equal(r.notes.isOpen("backup-target"), true, "the owner is told the target is failing");
      assert.match(r.notes.emitted.find((e) => e.ref.kind === "backup-target")!.label, /Cloud is failing/);
      // It comes back: the next look copies what it missed and the notice closes.
      fake.down = false;
      await r.system.sweep();
      assert.ok(fake.store.has(eleven), "caught up");
      assert.equal(r.notes.isOpen("backup-target"), false);
    } finally { await r.system.idle(); await fake.close(); cleanup(r); await world.close(); }
  });

  test(`${backend.name}: a purge is owner only, recorded, asks before it deletes the last good backup, covers every target, reports each result and retries an unreachable target (card K01c)`, async () => {
    const world = await backend.open();
    const fake = await startFakeTarget("tok");
    const r = await rig(world.storage, { resolveSecret: async () => fake.token });
    try {
      await r.system.addTarget(owner, { commandId: "t1", name: "Disk", kind: "disk", location: join(r.d, "disk") });
      await r.system.addTarget(owner, { commandId: "t2", name: "Cloud", kind: "offsite", location: fake.url, credential: "offsite-key" });
      const [a, b, c] = [await r.backup(0), await r.backup(1), await r.backup(2)];
      await r.system.idle();
      await assert.rejects(r.system.purge(owner, { commandId: "p0", names: ["../escape"] }), /not the name of a backup/);
      await assert.rejects(r.system.purge(owner, { commandId: "p0", names: [] }), /1 to 50/);
      await assert.rejects(r.system.purge(owner, { commandId: "p0", names: ["backup-20200101T000000Z-manual"] }), /on any target/);
      const preview = await r.system.purge(owner, { commandId: "p0", names: [a], dryRun: true });
      assert.equal(preview.status, "preview");
      assert.equal(r.names(r.root).length, 3, "a preview deletes nothing");
      // The cloud is down: the purge is done where it can be and listed as not yet done there.
      fake.down = true;
      const first = await r.system.purge(owner, { commandId: "p1", names: [a] });
      assert.equal(first.status, "pending");
      assert.deepEqual([first.results!["primary"]![a], first.results![Object.keys(first.results!).find((k) => k.startsWith("t-") && first.results![k]![a] === "removed")!]![a]], ["removed", "removed"]);
      assert.ok(Object.values(first.results!).some((per) => per[a] === "pending"), "the unreachable target is listed as not yet purged");
      assert.match(first.text, /NOT yet purged/);
      assert.equal(r.names(r.root).includes(a), false);
      assert.equal(r.names(join(r.d, "disk")).includes(a), false);
      assert.ok(fake.store.has(a), "still there: it could not be reached");
      assert.equal(r.notes.isOpen("backup-purge"), true, "and the owner is told");
      // The same command again is the same purge: nothing is done twice.
      const replay = await r.system.purge(owner, { commandId: "p1", names: [a] });
      assert.equal(replay.purgeId, first.purgeId);
      // It comes back: the retry removes it and the notice closes.
      fake.down = false;
      await r.system.sweep();
      assert.equal(fake.store.has(a), false);
      assert.equal(r.notes.isOpen("backup-purge"), false);
      assert.deepEqual((await r.system.status() as { pendingPurges: unknown[] }).pendingPurges, []);
      // It was not copied back from anywhere.
      await r.system.sweep();
      assert.equal(fake.store.has(a), false);
      assert.equal(r.names(r.root).includes(a), false);
      // The last good backup: asked about first, then deleted only with the owner's yes. Targets that already lost theirs say so.
      await r.system.purge(owner, { commandId: "p2", names: [b] });
      const warn = await r.system.purge(owner, { commandId: "p3", names: [c] });
      assert.equal(warn.status, "needs-confirmation");
      assert.match(warn.warning!, /last good backup/);
      assert.equal(r.names(r.root).includes(c), true);
      const yes = await r.system.purge(owner, { commandId: "p3", names: [c], confirm: true });
      assert.equal(yes.status, "purged");
      assert.deepEqual([r.names(r.root).length, r.names(join(r.d, "disk")).length, fake.store.size], [0, 0, 0]);
      const audit = await world.storage.listAudit({ afterSeq: 0, limit: 1000 });
      assert.equal(audit.filter((x) => x.type === "backup.purge" && x.actor === "owner:rob").length, 3, "every purge is recorded under the owner");
    } finally { await r.system.idle(); await fake.close(); cleanup(r); await world.close(); }
  });

  test(`${backend.name}: no new backup for longer than the limit leaves the last good one in place and tells the owner; a failed or missed backup is told and cleared when the next works (card K01c)`, async () => {
    const world = await backend.open();
    const r = await rig(world.storage, { retention: { daily: 7, weekly: 4, maxAgeDays: 35 } });
    try {
      const first = await r.backup(0);
      await r.backup(1);
      // Backups start failing (the backups folder cannot take a new one), for 60 days.
      const broken = new BackupService(Object.create(world.storage, { snapshot: { value: async () => { throw new Error("the disk is full"); } } }), { root: r.root, version: "t", now: () => new Date(r.clock.t), retentionSource: async () => r.retention.value, verifiedSource: () => r.system.verifiedNames(), afterBackup: (m) => r.system.afterBackup(m) });
      const failing = new BackupSystem({ service: broken, config: r.config, root: r.root, notifications: r.notes.port, retention: async () => r.retention.value, now: () => new Date(r.clock.t) });
      r.clock.t = T0 + 2 * DAYMS + 3_600_000;
      assert.equal(await broken.runScheduled(), false);
      await failing.sweep();
      assert.equal(r.notes.isOpen("backup-run", "failed"), true, "a failed backup is told");
      assert.match(r.notes.emitted.find((e) => e.ref.id === "failed")!.detail, /disk is full/);
      r.clock.t = T0 + 60 * DAYMS;
      await broken.prune();
      await failing.sweep();
      assert.ok(r.names(r.root).includes((await listBackups(r.root))[0]!.manifest.name), "the newest good backup is still there");
      assert.equal(r.names(r.root).length, 1, "the older one is past the limit and gone; the newest stays");
      assert.equal(r.names(r.root).includes(first), false);
      assert.equal(r.notes.isOpen("backup-stale", "age"), true, "the owner is told the newest good backup is older than the limit");
      const stale = r.notes.emitted.find((e) => e.ref.kind === "backup-stale")!;
      assert.equal(stale.interrupt, true, "it is Urgent");
      assert.match(stale.detail, /last good one is 59 days old.*limit of 35/);
      // A good backup makes it right again.
      await r.backup(60);
      await r.system.sweep();
      assert.equal(r.notes.isOpen("backup-stale"), false);
      assert.equal(r.notes.isOpen("backup-run"), false);
      // A missed backup: nothing failed, but nothing was made for much longer than the schedule.
      r.clock.t = T0 + 63 * DAYMS;
      await r.system.sweep();
      assert.equal(r.notes.isOpen("backup-run", "missed"), true);
    } finally { await r.system.idle(); cleanup(r); await world.close(); }
  });

  test(`${backend.name}: a test restore proves a copy can be used, a damaged copy fails it and the owner is told urgently (card K01c)`, async () => {
    const world = await backend.open();
    const r = await rig(world.storage);
    try {
      await r.system.addTarget(owner, { commandId: "t1", name: "Disk", kind: "disk", location: join(r.d, "disk") });
      const name = await r.backup(0);
      await r.system.idle();
      const ok = await r.system.verifyNow(owner);
      assert.deepEqual([ok.ok, ok.method], [true, "restore"]);
      assert.match(ok.detail, /scratch store and thrown away/);
      assert.deepEqual(readdirSync(r.d).filter((n) => n.startsWith("nn-backup-verify-")), [], "the scratch copy is gone");
      assert.equal((await r.system.verifyNow(owner, { target: "Disk" })).ok, true);
      await assert.rejects(r.system.verifyNow(owner, { name: "backup-20200101T000000Z-manual" }), /holds no backup named/);
      // Damage the copy on the disk: the test fails and says so.
      const file = readdirSync(join(r.d, "disk", name)).find((n) => n.endsWith(".jsonl"))!;
      writeFileSync(join(r.d, "disk", name, file), `${readFileSync(join(r.d, "disk", name, file), "utf8")}{"garbage":true}\n`);
      const bad = await r.system.verifyNow(owner, { target: "Disk" });
      assert.equal(bad.ok, false);
      assert.match(bad.detail, /does not check out|restore/);
      assert.equal(r.notes.isOpen("backup-verify", "restore"), true);
      assert.equal(r.notes.emitted.find((e) => e.ref.kind === "backup-verify")!.interrupt, true);
      // The main copy is fine and the next test of it closes the notice.
      await r.system.verifyNow(owner);
      assert.equal(r.notes.isOpen("backup-verify"), false);
      // The periodic one runs from the sweep when it is due, and not before.
      const before = (await r.config.state()).lastTestRestore!.at;
      r.clock.t += 2 * DAYMS; await r.system.sweep();
      assert.equal((await r.config.state()).lastTestRestore!.at, before, "not due after two days (every seven)");
      r.clock.t += 6 * DAYMS; await r.system.sweep();
      assert.notEqual((await r.config.state()).lastTestRestore!.at, before, "due after eight days");
    } finally { await r.system.idle(); cleanup(r); await world.close(); }
  });

  test(`${backend.name}: the schedule the owner set is the one the nightly run follows, including a fixed hour with a catch-up (card K01c)`, async () => {
    const world = await backend.open();
    const r = await rig(world.storage);
    try {
      assert.equal(await r.service.runScheduled(), true, "nothing yet: one is made");
      await r.service.finish();
      r.clock.t += 7 * 3_600_000;
      assert.equal(await r.service.runScheduled(), false, "daily: not due after seven hours");
      await r.config.setSchedule(owner, { commandId: "s1", everyHours: 6 });
      assert.equal(await r.service.runScheduled(), true, "every six hours: due now");
      await r.service.finish();
      // A fixed hour: at 02:00 UTC, once half a period has passed.
      await r.config.setSchedule(owner, { commandId: "s2", everyHours: 24, hourUtc: 2 });
      r.clock.t = Date.UTC(2026, 9, 2, 1, 0, 0);
      assert.equal(await r.service.runScheduled(), false, "01:00 is not the hour");
      r.clock.t = Date.UTC(2026, 9, 2, 2, 5, 0);
      assert.equal(await r.service.runScheduled(), true, "02:05 is");
      await r.service.finish();
      r.clock.t = Date.UTC(2026, 9, 3, 2, 30, 0);
      assert.equal(await r.service.runScheduled(), true, "and the next day");
      await r.service.finish();
      // The machine was off at that hour: the catch-up comes more than three hours late.
      r.clock.t = Date.UTC(2026, 9, 4, 4, 0, 0);
      assert.equal(await r.service.runScheduled(), false, "04:00 is only one and a half hours past the hour");
      r.clock.t = Date.UTC(2026, 9, 4, 7, 0, 0);
      assert.equal(await r.service.runScheduled(), true, "07:00: the missed 02:00 run is made up");
      await r.service.finish();
    } finally { await r.system.idle(); cleanup(r); await world.close(); }
  });
}

// ---- key generations -------------------------------------------------------------------------------------------------------------------

test("an old key generation is deleted only when no backup on ANY target uses it, never while a target cannot be read, and the owner is told its recovery file opens nothing (card K01c)", async () => {
  const world = await backends[0]!.open();
  const fake = await startFakeTarget("tok");
  const d0 = mkdtempSync(join(tmpdir(), "nn-k01c-key-"));
  try {
    const w = (name: string, text: string): string => { const p = join(d0, name); writeFileSync(p, text, { mode: 0o600 }); return p; };
    const out: string[] = []; const say = (l: string): void => { out.push(l); };
    const ring = join(d0, "keyring.json");
    assert.equal(await runBackupCli(["encryption-setup", ring, "--passcode-file", w("p1", "correct horse battery staple"), "--recovery-out", join(d0, "rec1.json")], say), 0, out.join("\n"));
    const gen1 = parseKeyring(JSON.parse(readFileSync(ring, "utf8")));
    const r = await rig(world.storage, { resolveSecret: async () => fake.token, keyringFile: ring });
    try {
      await r.system.addTarget(owner, { commandId: "t1", name: "Cloud", kind: "offsite", location: fake.url, credential: "k" });
      // A backup under generation 1 is made in the main folder (the marker that makes it the backups folder) and copied to the cloud.
      const old = await createBackup(world.storage, { root: r.root, kind: "manual", version: "t", now: () => new Date(T0), encryption: gen1 });
      await new HttpDriver(fake.url, { token: async () => "tok" }).put(old.path, old.manifest.name);
      assert.equal(await runBackupCli(["encryption-rotate", ring, "--passcode-file", w("p1b", "correct horse battery staple"), "--new-passcode-file", w("p2", "a different long passcode 2"), "--recovery-out", join(d0, "rec2.json")], say), 0, out.join("\n"));
      const gen2 = parseKeyring(JSON.parse(readFileSync(ring, "utf8")));
      await createBackup(world.storage, { root: r.root, kind: "manual", version: "t", now: () => new Date(T0 + DAYMS), encryption: gen2 });
      rmSync(old.path, { recursive: true });
      // The main folder has no backup under generation 1 any more, but the cloud still does: the archive stays.
      assert.deepEqual((await generationReport(ring, r.root)).generations.map((g) => g.removable), [true], "the main folder alone would say it can go");
      await r.system.sweep();
      assert.ok(existsSync(`${ring}.generation-1`), "a copy on another target still needs the key");
      // The cloud cannot be read: still nothing is removed.
      fake.down = true;
      r.clock.t += 10 * 60_000; await r.system.sweep();
      assert.ok(existsSync(`${ring}.generation-1`), "a target that cannot be read is never taken as empty");
      fake.down = false;
      // Purge the last backup under generation 1: now the key goes, and the owner is told.
      await r.system.purge(owner, { commandId: "p1", names: [old.manifest.name] });
      assert.equal(existsSync(`${ring}.generation-1`), false);
      assert.ok(existsSync(ring), "the live keyring stays");
      const told = r.notes.emitted.find((e) => e.ref.kind === "backup-keys")!;
      assert.match(told.detail, /open nothing any more/);
      assert.match(told.detail, /key generation 1/);
    } finally { await r.system.idle(); cleanup(r); }
  } finally { await fake.close(); rmSync(d0, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); await world.close(); }
});
