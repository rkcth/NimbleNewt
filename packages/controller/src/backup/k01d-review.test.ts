import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { Principal } from "../security/index.js";
import { MemoryStorage, type ControllerStorage } from "../storage/index.js";
import { BackupScopeSettingService, BackupService, createBackup, createKeyring, planLeaveOut, restoreBackup, unlockWithPasscode, verifyBackup, type BackupScopeValues } from "./index.js";
import { runBackupCli } from "./cli.js";

after(stopServer);

// Card K01d, review: what the first tests did not reach. Page boundaries in the writer (a whole page left out), an encrypted backup under a scope, the cases the transcript and scratch tiers must
// never take (a held command, a follow-up, an agenda item or open proposal raised by the words, archived or deleted scratch), the command line's report, and an owner token limited to one task.
const NOW = new Date("2026-11-15T12:00:00.000Z");
const DAY = 86_400_000;
const ago = (days: number): string => new Date(NOW.getTime() - days * DAY).toISOString();
const tmp = (): string => mkdtempSync(join(tmpdir(), "nn-k01dr-"));
const ALL: BackupScopeValues = { scratchDays: 30, transcriptDays: 30, logDays: 30 };
const PASS = "correct horse battery staple 42";
const FAST = { N: 2 ** 16, r: 8, p: 1 } as const;

async function seed(storage: ControllerStorage): Promise<void> {
  const { epoch } = await storage.acquireEpoch({ holder: "c1", at: ago(200) });
  let n = 0;
  const put = async (kind: string, id: string, body: object, daysAgo: number): Promise<void> => {
    await storage.applyOperation({ operationId: `seed-${++n}`, epoch, actor: "owner:rob", correlationId: `co-${n}`, at: ago(daysAgo), changes: [{ type: "create", ref: { kind, id }, body: body as never }], audit: [{ type: `${kind}.created`, subject: { kind, id }, detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
  };
  await put("task", "t-done", { state: "done", projectId: "p-1" }, 150);
  const scratch = { visibility: "private", title: "scratch", body: "private scratch words 7731", taskId: "t-done", projectId: "p-1" };
  // Enough left-out scratch that, with a small page size, whole pages of the aggregates table are left out.
  for (let i = 0; i < 7; i += 1) await put("desk-record", `s-gone-${i}`, scratch, 100);
  await put("desk-record", "s-archived", { ...scratch, body: "", archived: { at: ago(90), archiveId: "a-1" } }, 100);
  await put("desk-record", "s-deleted", { ...scratch, body: "", deleted: { at: ago(90) } }, 100);
  const turn = (id: string, extra: object = {}) => ({ ownerId: "owner:rob", messageId: `m-${id}`, status: "done", text: `words of ${id} 9917`, plan: [{ op: "x" }], outcomes: [{ ok: true }], createdAt: ago(100), completedAt: ago(100), projectId: "p-1", ...extra });
  await put("chat-turn", "ct-gone", turn("ct-gone"), 100);
  await put("chat-turn", "ct-held", turn("ct-held", { held: [{ op: "y" }] }), 100);
  await put("chat-turn", "ct-held-resumed", turn("ct-held-resumed", { held: [{ op: "y" }], resumedBy: "ct-gone" }), 100);
  await put("chat-turn", "ct-followup", turn("ct-followup", { followUps: [{ id: "f" }] }), 100);
  await put("chat-turn", "ct-agenda", turn("ct-agenda"), 100);
  await put("chat-turn", "ct-proposal", turn("ct-proposal"), 100);
  await put("chat-turn", "ct-closed-proposal", turn("ct-closed-proposal"), 100);
  await put("agenda-item", "ag-1", { source: { kind: "chat-turn", id: "ct-agenda" } }, 100);
  await put("chat-proposal", "cp-open", { status: "open", turnId: "ct-proposal" }, 100);
  await put("chat-proposal", "cp-closed", { status: "applied", turnId: "ct-closed-proposal" }, 100);
  await put("notification-delivery", "nd-old", { state: "delivered", text: "message 4410", subject: { kind: "item", id: "i" }, channel: "mail", attempts: 1 }, 100);
  await put("notification-delivery", "nd-failed", { state: "failed", text: "message 4411", subject: { kind: "item", id: "i" }, channel: "mail", attempts: 3 }, 100);
}

const rowsOf = (path: string): { kind: string; id: string; body: string }[] => readFileSync(join(path, "aggregates.jsonl"), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as { kind: string; id: string; body: string });

for (const backend of backends) {
  test(`${backend.name}: the tiers never take a held or followed-up turn, words an agenda item or open proposal rests on, or archived and deleted scratch; page boundaries change nothing (card K01d review)`, async () => {
    const world = await backend.open(); const root = tmp();
    try {
      await seed(world.storage);
      const big = await createBackup(world.storage, { root, kind: "manual", version: "t", now: () => NOW, leaveOut: ALL });
      const small = await createBackup(world.storage, { root, kind: "manual", version: "t", now: () => new Date(NOW.getTime() + 1000), leaveOut: ALL, pageSize: 2 });
      for (const b of [big, small]) assert.equal((await verifyBackup(b.path)).ok, true);
      const key = (r: { kind: string; id: string; body: string }): string => `${r.kind}/${r.id}`;
      const bigRows = rowsOf(big.path); const smallRows = rowsOf(small.path);
      assert.deepEqual(smallRows.map(key), bigRows.map(key), "a page size of 2 (whole pages left out) writes the same rows");
      assert.equal(small.manifest.files.find((f) => f.table === "aggregates")!.rows, smallRows.length);
      const ids = (kind: string): string[] => bigRows.filter((r) => r.kind === kind).map((r) => r.id).sort();
      assert.deepEqual(ids("desk-record"), ["s-archived", "s-deleted"], "archived and deleted scratch are not the scope's to take");
      assert.deepEqual(ids("notification-delivery"), ["nd-failed"], "a failed delivery the owner may need stays");
      const text = (id: string): unknown => (JSON.parse(bigRows.find((r) => r.kind === "chat-turn" && r.id === id)!.body) as { text?: unknown }).text;
      assert.equal(text("ct-gone"), "");
      assert.equal(text("ct-closed-proposal"), "", "a proposal that is no longer open holds nothing");
      for (const id of ["ct-held", "ct-followup", "ct-agenda", "ct-proposal"]) assert.equal(text(id), `words of ${id} 9917`, `${id} keeps its words`);
      assert.equal(text("ct-held-resumed"), "", "a held command already resumed holds nothing");
      const lines = Object.fromEntries(big.manifest.contentScope!.leftOut.map((l) => [l.kind, [l.left, l.stubbed, l.heldBack]]));
      assert.deepEqual(lines, { "desk-record": [7, 0, 0], "chat-turn": [3, 3, 2], "notification-delivery": [1, 0, 0] }, "the agenda and proposal turns are counted as held back");
      assert.ok(!readFileSync(join(big.path, "aggregates.jsonl"), "utf8").includes("private scratch words 7731"));
      // A restore of the page-size-2 backup gives the same records.
      const target = await backend.open();
      try {
        const done = await restoreBackup(small.path, target.storage, { pageSize: 3 });
        assert.equal(done.leftOutByScope?.leftOut.reduce((s, l) => s + l.left, 0), 11);
        assert.equal((await target.storage.listAggregates("desk-record", { limit: 50 })).length, 2);
      } finally { await target.close(); }
    } finally { await world.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  });
}

test("an encrypted backup under a scope: nothing left out is readable, the statement is under the MAC, and it restores with the passcode (card K01d review)", async () => {
  const d = tmp();
  try {
    const { keyring } = await createKeyring({ passcode: PASS, scrypt: FAST });
    const store = new MemoryStorage(); await seed(store);
    const { path, manifest } = await createBackup(store, { root: join(d, "b"), kind: "manual", version: "t", now: () => NOW, encryption: keyring, leaveOut: ALL, pageSize: 2 });
    assert.ok(manifest.mac); assert.ok(manifest.contentScope);
    const all = Buffer.concat(readdirSync(path, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => readFileSync(join(e.parentPath, e.name))));
    assert.equal(all.includes("private scratch words 7731"), false);
    const unlock = await unlockWithPasscode(keyring, PASS);
    assert.equal((await verifyBackup(path, { unlock })).ok, true);
    const target = new MemoryStorage();
    const done = await restoreBackup(path, target, { unlock });
    assert.equal(done.leftOutByScope?.text, manifest.contentScope.text);
    assert.equal((await target.getAggregate({ kind: "chat-turn", id: "ct-gone" }))?.body["text"], "");
    assert.equal((await target.getAggregate({ kind: "desk-record", id: "s-gone-0" })), undefined);
    // Removing the statement from the manifest (to pass it off as a full copy) is refused.
    const m = JSON.parse(readFileSync(join(path, "manifest.json"), "utf8")); delete m.contentScope; writeFileSync(join(path, "manifest.json"), JSON.stringify(m));
    assert.equal((await verifyBackup(path, { unlock })).ok, false);
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("the command line's restore says the backup is not a full copy; a whole one does not (card K01d review)", async () => {
  const d = tmp();
  try {
    const store = new MemoryStorage(); await seed(store);
    const scoped = await createBackup(store, { root: join(d, "b"), kind: "manual", version: "t", now: () => NOW, leaveOut: ALL });
    const out: string[] = [];
    assert.equal(await runBackupCli(["restore", scoped.path, "--sqlite", join(d, "r1.sqlite")], (l) => { out.push(l); }), 0, out.join("\n"));
    assert.ok(out.some((l) => /^NOT A FULL COPY: 11 records were left out/.test(l)), out.join("\n"));
    const whole = await createBackup(store, { root: join(d, "b"), kind: "manual", version: "t", now: () => new Date(NOW.getTime() + 1000) });
    const out2: string[] = [];
    assert.equal(await runBackupCli(["restore", whole.path, "--sqlite", join(d, "r2.sqlite")], (l) => { out2.push(l); }), 0, out2.join("\n"));
    assert.ok(!out2.some((l) => /NOT A FULL COPY/.test(l)));
    const listed: string[] = [];
    assert.equal(await runBackupCli(["list", join(d, "b")], (l) => { listed.push(l); }), 0);
    assert.ok(listed.some((l) => l.startsWith(scoped.manifest.name) && /NOT A FULL COPY/.test(l)), listed.join("\n"));
    assert.ok(listed.some((l) => l.startsWith(whole.manifest.name) && !/NOT A FULL COPY/.test(l)), listed.join("\n"));
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("only manual and scheduled backups follow the scope: a backup of any other kind asked of the service is whole (card K01d review)", async () => {
  const d = tmp();
  try {
    const store = new MemoryStorage(); await seed(store);
    const service = new BackupService(store, { root: join(d, "b"), version: "t", now: () => NOW, scopeSource: async () => ALL });
    const pre = await service.backUpNow("pre-upgrade");
    assert.equal(pre.manifest.contentScope, undefined);
    assert.ok(readFileSync(join(pre.path, "aggregates.jsonl"), "utf8").includes("private scratch words 7731"));
    const sched = await new BackupService(store, { root: join(d, "b"), version: "t", now: () => new Date(NOW.getTime() + DAY), scopeSource: async () => ALL }).backUpNow("scheduled");
    assert.ok(sched.manifest.contentScope !== undefined, "a scheduled backup follows it");
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("an owner token limited to one task may neither read nor change the backup scope (card K01d review)", async () => {
  const store = new MemoryStorage();
  const { epoch } = await store.acquireEpoch({ holder: "c0", at: ago(1) });
  const settings = BackupScopeSettingService.withEpoch(store, epoch, { clock: () => NOW.toISOString() });
  const scoped = { id: "owner:rob", kind: "owner", name: "rob", grants: [], taskScope: { projectId: "p-1", taskId: "t-1" } } as unknown as Principal;
  await assert.rejects(settings.set(scoped, { commandId: "c-1", scratchDays: 30 }), /may not change/);
  await assert.rejects(settings.get(scoped), /may not read/);
  const viewer = { id: "viewer:v", kind: "viewer", name: "v", grants: [] } as unknown as Principal;
  await assert.rejects(settings.set(viewer, { commandId: "c-2", scratchDays: 30 }), /may not change/);
  assert.equal((await store.getAggregate({ kind: "backup-scope-setting", id: "main" })), undefined);
});

test("an unknown field and a bad expectedRevision are refused before anything is written (card K01d review)", async () => {
  const store = new MemoryStorage();
  const { epoch } = await store.acquireEpoch({ holder: "c0", at: ago(1) });
  const settings = BackupScopeSettingService.withEpoch(store, epoch, { clock: () => NOW.toISOString() });
  const owner = { id: "owner:rob", kind: "owner", name: "rob", grants: [] } as unknown as Principal;
  await assert.rejects(settings.set(owner, { commandId: "c-1", scratchDays: 30, everything: true } as never), /everything: is not a field/);
  await assert.rejects(settings.set(owner, { commandId: "c-2", scratchDays: 30, expectedRevision: -1 }), /expectedRevision/);
  assert.equal((await store.getAggregate({ kind: "backup-scope-setting", id: "main" })), undefined);
  // A stored value out of range (a damaged record) reads as that tier off, never as a smaller window.
  await store.applyOperation({ operationId: "bad-1", epoch, actor: "owner:rob", correlationId: "x", at: ago(1), changes: [{ type: "create", ref: { kind: "backup-scope-setting", id: "main" }, body: { scratchDays: 2, transcriptDays: "30", logDays: 30, changedAt: ago(1), changedBy: "owner:rob" } as never }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
  assert.deepEqual(await settings.effective(), { scratchDays: null, transcriptDays: null, logDays: 30 });
  // And a plan with every tier off on an empty store leaves nothing out.
  const snap = await store.snapshot();
  try { assert.deepEqual((await planLeaveOut(snap, { scratchDays: null, transcriptDays: null, logDays: 30 }, NOW)).record().leftOut.map((l) => [l.kind, l.left]), [["notification-delivery", 0]]); } finally { await snap.close(); }
});
