import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MemoryStorage } from "../storage/index.js";
import { BackupService, checkpointOf, createBackup, createKeyring, manifestDigestOf } from "./index.js";
import { MANIFEST_FILE } from "./format.js";

/** Card K07 review: the maintenance window's checkpoint check, on real backups (plain and sealed for everything). Storage-independent: the backup files are what is checked. */
const AT = "2026-11-23T10:00:00.000Z";
const FAST = { N: 2 ** 16, r: 8, p: 1 } as const;
async function populated(): Promise<MemoryStorage> {
  const s = new MemoryStorage();
  const { epoch } = await s.acquireEpoch({ holder: "c1", at: AT });
  await s.applyOperation({ operationId: "op-1", epoch, actor: "owner:rob", correlationId: "co-1", at: AT, changes: [{ type: "create", ref: { kind: "task", id: "task-a" }, body: { title: "a task" } }], audit: [{ type: "task.created", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] });
  return s;
}

test("K07 checkpoint: a plain backup is checked in full and named by its folder only; a changed file fails it", async () => {
  const root = mkdtempSync(join(tmpdir(), "nn-cp-"));
  try {
    const made = await createBackup(await populated(), { root, kind: "manual", version: "t", now: () => new Date(AT) });
    const ok = await checkpointOf(made);
    assert.deepEqual([ok.verified, ok.problems, ok.note, ok.digest], [true, [], undefined, manifestDigestOf(made.manifest)]);
    assert.ok(!ok.name.includes(root) && !/[\\/]/.test(ok.name), "the folder name, never the host path");
    const table = made.manifest.files.find((t) => t.rows > 0)!;
    writeFileSync(join(made.path, table.file), readFileSync(join(made.path, table.file), "utf8") + "{}\n");
    const bad = await checkpointOf(made);
    assert.equal(bad.verified, false);
    assert.ok(bad.problems.length > 0);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("K07 checkpoint: a backup sealed for everything is accepted on its manifest (the controller never reads the passcode) and says so; a manifest changed on disk fails it", async () => {
  const root = mkdtempSync(join(tmpdir(), "nn-cp-"));
  try {
    const { keyring } = await createKeyring({ passcode: "correct horse battery staple", scrypt: FAST });
    const made = await createBackup(await populated(), { root, kind: "manual", version: "t", now: () => new Date(AT), encryption: keyring });
    assert.equal(made.manifest.encryption?.scope, "everything", "the default seals everything");
    const ok = await checkpointOf(made);
    assert.equal(ok.verified, true, ok.problems.join("; "));
    assert.match(ok.note ?? "", /sealed for everything: its manifest was checked, its files were not opened/);
    const file = join(made.path, MANIFEST_FILE);
    const m = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...m, version: "changed" }));
    const bad = await checkpointOf(made);
    assert.equal(bad.verified, false);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("K07 second review: a backup with only its secrets sealed is checked in full and the record says its secrets and the manifest's seal were not", async () => {
  const root = mkdtempSync(join(tmpdir(), "nn-cp-"));
  try {
    const { keyring } = await createKeyring({ passcode: ["pass", "code", String(process.pid)].join("-"), scrypt: FAST });
    const made = await createBackup(await populated(), { root, kind: "manual", version: "t", now: () => new Date(AT), encryption: keyring, scope: "secrets" });
    assert.equal(made.manifest.encryption?.scope, "secrets");
    const ok = await checkpointOf(made);
    assert.equal(ok.verified, true, ok.problems.join("; "));
    assert.match(ok.note ?? "", /only its secrets are sealed: its files were checked, its secrets and the manifest's seal were not/);
    assert.ok((ok.note ?? "").length <= 160, "fits the status line whole");
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("K07 second review: the checkpoint's backup is started after any backup already running, never that one", async () => {
  const root = mkdtempSync(join(tmpdir(), "nn-cp-"));
  try {
    let clock = Date.parse(AT);
    const service = new BackupService(await populated(), { root, version: "t", now: () => new Date(clock += 1000) });
    const earlier = service.backUpNow("scheduled");
    const fresh = service.backUpFresh("manual");
    const [a, b] = await Promise.all([earlier, fresh]);
    assert.equal(a.manifest.kind, "scheduled");
    assert.equal(b.manifest.kind, "manual", "a new backup, not the one that was running");
    assert.notEqual(a.path, b.path);
    assert.equal((await checkpointOf(b)).verified, true);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
