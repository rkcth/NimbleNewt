import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { MemoryStorage, type ControllerStorage, type StorageSnapshot } from "../storage/index.js";
import { BACKUP_SCOPE_OFF, BackupScopeSettingService, BackupService, LEAVE_OUT_KINDS, createBackup, planLeaveOut, restoreBackup, verifyBackup, type BackupScopeValues } from "./index.js";

after(stopServer);

// Card K01d: backup scope tiers. Off by default; the audit log and decisions are always in; anything a resumable task or a replay refers to is kept; a restore says what was left out; owner only and recorded.
const NOW = new Date("2026-11-15T12:00:00.000Z");
const DAY = 86_400_000;
const ago = (days: number): string => new Date(NOW.getTime() - days * DAY).toISOString();
const tmp = (): string => mkdtempSync(join(tmpdir(), "nn-k01d-"));
const ALL: BackupScopeValues = { scratchDays: 30, transcriptDays: 30, logDays: 30 };

/** One store with every case of every tier: finished and live tasks, scratch old and young, one cited by a replay, turns old, young and one a decision rests on, deliveries delivered, waiting and young, and a decision. */
async function seed(storage: ControllerStorage): Promise<number> {
  const { epoch } = await storage.acquireEpoch({ holder: "c1", at: ago(200) });
  let n = 0;
  const put = async (kind: string, id: string, body: object, daysAgo: number): Promise<void> => {
    await storage.applyOperation({ operationId: `seed-${++n}`, epoch, actor: "owner:rob", correlationId: `co-${n}`, at: ago(daysAgo), changes: [{ type: "create", ref: { kind, id }, body: body as never }], audit: [{ type: `${kind}.created`, subject: { kind, id }, detail: { text: "audit detail stays" } }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
  };
  await put("task", "t-done", { state: "done", projectId: "p-1" }, 150);
  await put("task", "t-cancelled", { state: "cancelled", projectId: "p-1" }, 150);
  await put("task", "t-live", { state: "running", projectId: "p-1" }, 150);
  const scratch = { visibility: "private", title: "scratch", body: "private scratch text" };
  await put("desk-record", "s-old-done", { ...scratch, taskId: "t-done", projectId: "p-1" }, 100);
  await put("desk-record", "s-old-cancelled", { ...scratch, taskId: "t-cancelled", projectId: "p-1" }, 100);
  await put("desk-record", "s-young-done", { ...scratch, taskId: "t-done", projectId: "p-1" }, 10);
  await put("desk-record", "s-old-live", { ...scratch, taskId: "t-live", projectId: "p-1" }, 100);
  await put("desk-record", "s-old-replayed", { ...scratch, taskId: "t-done", projectId: "p-1" }, 100);
  await put("desk-record", "s-old-shared", { ...scratch, visibility: "shared", taskId: "t-done", projectId: "p-1" }, 100);
  await put("activity-step", "as-1", { taskId: "t-done", seq: 1, manifest: { refs: [{ kind: "desk-record", id: "s-old-replayed" }] } }, 100);
  const turn = (text: string, completedAt: string) => ({ ownerId: "owner:rob", messageId: `m-${text}`, status: "done", text, plan: [{ op: "x" }], outcomes: [{ ok: true }], createdAt: completedAt, completedAt, projectId: "p-1" });
  await put("chat-turn", "ct-old", turn("old words", ago(100)), 100);
  await put("chat-turn", "ct-young", turn("young words", ago(5)), 5);
  await put("chat-turn", "ct-decided", turn("the words a decision rests on", ago(100)), 100);
  await put("chat-turn", "ct-running", (({ completedAt: _c, ...rest }) => ({ ...rest, status: "running" }))(turn("running words", ago(100))), 100);
  await put("decision", "d-1", { text: "the owner decided", source: { turnId: "ct-decided" } }, 100);
  const delivery = { subject: { kind: "item", id: "i-1" }, channel: "mail", text: "message text", attempts: 1 };
  await put("notification-delivery", "nd-old", { ...delivery, state: "delivered" }, 100);
  await put("notification-delivery", "nd-waiting", { ...delivery, state: "pending" }, 100);
  await put("notification-delivery", "nd-young", { ...delivery, state: "delivered" }, 5);
  return epoch;
}

const idsOf = (path: string, kind: string): string[] => readFileSync(join(path, "aggregates.jsonl"), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as { kind: string; id: string }).filter((r) => r.kind === kind).map((r) => r.id);
const rowOf = (path: string, kind: string, id: string): Record<string, unknown> => JSON.parse(String((JSON.parse(readFileSync(join(path, "aggregates.jsonl"), "utf8").split("\n").filter((l) => l !== "").find((l) => { const r = JSON.parse(l) as { kind: string; id: string }; return r.kind === kind && r.id === id; })!) as { body: string }).body)) as Record<string, unknown>;

for (const backend of backends) {
  test(`${backend.name}: off by default, a backup holds everything and says nothing about a scope (card K01d)`, async () => {
    const world = await backend.open(); const root = tmp();
    try {
      await seed(world.storage);
      const whole = await createBackup(world.storage, { root, kind: "manual", version: "t", now: () => NOW });
      assert.equal(whole.manifest.contentScope, undefined);
      const off = await createBackup(world.storage, { root, kind: "scheduled", version: "t", now: () => NOW, leaveOut: BACKUP_SCOPE_OFF });
      assert.equal(off.manifest.contentScope, undefined, "every tier off is the same as no scope");
      assert.deepEqual(off.manifest.files.map((f) => f.rows), whole.manifest.files.map((f) => f.rows));
      assert.equal(idsOf(whole.path, "desk-record").length, 6);
    } finally { await world.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test(`${backend.name}: the tiers leave out old scratch, old words and delivered message records; audit, decisions and what a resumable task or a replay refers to stay (card K01d)`, async () => {
    const world = await backend.open(); const root = tmp();
    try {
      await seed(world.storage);
      const whole = await createBackup(world.storage, { root, kind: "manual", version: "t", now: () => new Date(NOW.getTime() - 1000) });
      const { path, manifest } = await createBackup(world.storage, { root, kind: "manual", version: "t", now: () => NOW, leaveOut: ALL });
      assert.equal((await verifyBackup(path)).ok, true, "a scoped backup is a complete, verified backup");
      assert.deepEqual(idsOf(path, "desk-record").sort(), ["s-old-live", "s-old-replayed", "s-old-shared", "s-young-done"], "only the old private scratch of the two finished tasks is out");
      assert.deepEqual(idsOf(path, "notification-delivery").sort(), ["nd-waiting", "nd-young"]);
      assert.deepEqual(idsOf(path, "chat-turn").sort(), ["ct-decided", "ct-old", "ct-running", "ct-young"], "a turn stays as an empty shell");
      assert.equal(rowOf(path, "chat-turn", "ct-old")["text"], "", "the words are gone");
      assert.deepEqual(rowOf(path, "chat-turn", "ct-old")["plan"], []);
      assert.equal(rowOf(path, "chat-turn", "ct-old")["messageId"], "m-old words", "but the message it answered is kept");
      assert.equal(rowOf(path, "chat-turn", "ct-decided")["text"], "the words a decision rests on", "the decision's words are kept");
      assert.equal(rowOf(path, "chat-turn", "ct-young")["text"], "young words");
      assert.equal(rowOf(path, "chat-turn", "ct-running")["text"], "running words", "a turn that is not done is whole");
      assert.deepEqual(idsOf(path, "decision"), ["d-1"], "decisions are always in");
      assert.deepEqual(idsOf(path, "task").length, 3);
      const aud = (p: string): number => readFileSync(join(p, "audit.jsonl"), "utf8").split("\n").filter((l) => l !== "").length;
      assert.equal(aud(path), aud(whole.path), "the audit log is always whole");
      for (const t of ["operations", "deliveries", "effects", "timers", "state"]) assert.equal(manifest.files.find((f) => f.table === t)!.rows, whole.manifest.files.find((f) => f.table === t)!.rows, `${t} is whole`);

      const scope = manifest.contentScope!;
      assert.equal(scope.referenceCheckComplete, true);
      assert.deepEqual(scope.leftOut.map((l) => [l.kind, l.left, l.stubbed, l.heldBack]).sort(), [["chat-turn", 1, 1, 1], ["desk-record", 2, 0, 1], ["notification-delivery", 1, 0, 0]]);
      assert.match(scope.text, /NOT a full copy/);
      assert.ok(manifest.notes.includes(scope.text), "the manifest's notes carry the statement");
      assert.equal(manifest.files.find((f) => f.table === "aggregates")!.rows, whole.manifest.files.find((f) => f.table === "aggregates")!.rows - 3, "three records are not in the copy at all");
      // The live system is unaffected: nothing was deleted from the running store.
      assert.equal((await world.storage.listAggregates("desk-record", { limit: 100 })).length, 6);
      assert.equal((await world.storage.getAggregate({ kind: "chat-turn", id: "ct-old" }))?.body["text"], "old words");
      assert.equal((await world.storage.listAggregates("notification-delivery", { limit: 100 })).length, 3);
    } finally { await world.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test(`${backend.name}: each tier alone; a restore reports what the scope left out and does not bring it back (card K01d)`, async () => {
    const world = await backend.open(); const target = await backend.open(); const root = tmp();
    try {
      await seed(world.storage);
      const only = await createBackup(world.storage, { root, kind: "manual", version: "t", now: () => new Date(NOW.getTime() - 5000), leaveOut: { ...BACKUP_SCOPE_OFF, logDays: 30 } });
      assert.deepEqual(only.manifest.contentScope!.leftOut.map((l) => l.kind), ["notification-delivery"], "only the tier that is set");
      assert.deepEqual(idsOf(only.path, "desk-record").length, 6);
      const { path, manifest } = await createBackup(world.storage, { root, kind: "manual", version: "t", now: () => NOW, leaveOut: ALL });
      const restored = await restoreBackup(path, target.storage);
      assert.equal(restored.leftOutByScope?.text, manifest.contentScope!.text, "the restore report carries the statement");
      assert.ok(restored.notes!.includes(manifest.contentScope!.text));
      assert.equal(await target.storage.getAggregate({ kind: "desk-record", id: "s-old-done" }), undefined, "left out is not brought back");
      assert.equal(await target.storage.getAggregate({ kind: "notification-delivery", id: "nd-old" }), undefined);
      assert.equal((await target.storage.getAggregate({ kind: "chat-turn", id: "ct-old" }))?.body["text"], "", "the turn is the empty shell");
      assert.equal((await target.storage.getAggregate({ kind: "chat-turn", id: "ct-old" }))?.body["messageId"], "m-old words");
      assert.equal((await target.storage.getAggregate({ kind: "decision", id: "d-1" }))?.body["text"], "the owner decided");
      // A whole backup restores with no such statement.
      const whole = await createBackup(world.storage, { root, kind: "manual", version: "t", now: () => new Date(NOW.getTime() - 9000) });
      const second = await backend.open();
      try { assert.equal((await restoreBackup(whole.path, second.storage)).leftOutByScope, undefined); } finally { await second.close(); }
    } finally { await world.close(); await target.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test(`${backend.name}: the owner's setting is owner only, recorded in the audit log with who and the old and new values, announced, revision-checked and bounded (card K01d)`, async () => {
    const world = await backend.open();
    try {
      const storage = world.storage;
      const clock = () => NOW.toISOString();
      const probe = await storage.acquireEpoch({ holder: "c0", at: ago(1) });
      const principals = PrincipalService.withEpoch(storage, probe.epoch, { clock });
      const owner: Principal = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const agent = { id: "agent:a1", kind: "agent", name: "a1", grants: [{ permission: "*", scope: { kind: "installation" } }] } as unknown as Principal;
      const settings = BackupScopeSettingService.withEpoch(storage, probe.epoch, { clock });
      const told: string[] = [];
      settings.onChanged(async (c, by) => { told.push(`${by} ${c.wider ? "wider" : "narrower"}`); });
      assert.deepEqual(await settings.effective(), BACKUP_SCOPE_OFF, "off by default");
      assert.equal((await settings.get(owner)).revision, 0);
      await assert.rejects(settings.set(agent, { commandId: "c-a", scratchDays: 30 }), /may not change the backup scope/);
      await assert.rejects(settings.get(agent), /may not read/);
      assert.deepEqual(await settings.effective(), BACKUP_SCOPE_OFF, "refused: nothing changed");
      for (const bad of [{ scratchDays: 3 }, { logDays: 4000 }, { transcriptDays: 12.5 }, { logDays: "30" }, {}] as const) await assert.rejects(settings.set(owner, { commandId: `c-bad-${JSON.stringify(bad)}`, ...bad } as never), /invalid_command|days|give scratchDays/i);
      const first = await settings.set(owner, { commandId: "c-1", scratchDays: 60, logDays: 30 });
      assert.equal(first.changed, true); assert.equal(first.wider, true);
      assert.deepEqual([first.scratchDays, first.transcriptDays, first.logDays], [60, null, 30]);
      assert.match(first.text, /leave out private scratch of finished tasks not changed for 60 days/);
      const again = await settings.set(owner, { commandId: "c-1", scratchDays: 60, logDays: 30 });
      assert.equal(again.changed, false, "a repeat of the same command applies once and announces nothing");
      await assert.rejects(settings.set(owner, { commandId: "c-2", scratchDays: 60 }), /already/);
      await assert.rejects(settings.set(owner, { commandId: "c-3", scratchDays: 90, expectedRevision: 7 }), /revision/);
      const narrower = await settings.set(owner, { commandId: "c-4", scratchDays: 90, logDays: null, expectedRevision: first.revision });
      assert.equal(narrower.wider, false);
      assert.deepEqual([narrower.scratchDays, narrower.transcriptDays, narrower.logDays], [90, null, null], "a field left out is unchanged, null turns one off");
      assert.deepEqual(told, ["owner:rob wider".replace("owner:rob", owner.id), `${owner.id} narrower`]);
      const audit: { type: string; actor: string; detail: Record<string, unknown> }[] = [];
      for (let afterSeq = 0; ;) { const page = await storage.listAudit({ afterSeq, limit: 100 }); if (page.length === 0) break; for (const x of page) audit.push(x as never); afterSeq = page[page.length - 1]!.seq; }
      const recorded = audit.filter((a) => a.type === "backup.scope.set");
      assert.equal(recorded.length, 2, "each change is recorded once");
      assert.equal(recorded[0]!.actor, owner.id);
      assert.deepEqual((recorded[0]!.detail["before"] as object), BACKUP_SCOPE_OFF);
      assert.deepEqual((recorded[0]!.detail["after"] as object), { scratchDays: 60, transcriptDays: null, logDays: 30 });
    } finally { await world.close(); }
  });

  test(`${backend.name}: BackupService applies the setting to manual and scheduled backups only; safety copies are whole; a source that fails gives a whole backup (card K01d)`, async () => {
    const world = await backend.open(); const root = tmp();
    try {
      await seed(world.storage);
      let source: () => Promise<BackupScopeValues | undefined> = async () => ALL;
      const service = new BackupService(world.storage, { root, version: "t", now: () => NOW, scopeSource: () => source() });
      const manual = await service.backUpNow("manual");
      assert.ok(manual.manifest.contentScope !== undefined, "a manual backup follows the scope");
      assert.equal(idsOf(manual.path, "notification-delivery").length, 2);
      const safety = await service.safetyCopy();
      assert.equal(safety.manifest.contentScope, undefined, "the safety copy before a restore is whole");
      assert.equal(idsOf(safety.path, "notification-delivery").length, 3);
      source = async () => { throw new Error("the setting could not be read"); };
      const later = await new BackupService(world.storage, { root, version: "t", now: () => new Date(NOW.getTime() + 2 * DAY), scopeSource: () => source() }).backUpNow("scheduled");
      assert.equal(later.manifest.contentScope, undefined, "an unreadable setting never leaves anything out");
      assert.equal(idsOf(later.path, "notification-delivery").length, 3);
    } finally { await world.close(); rmSync(root, { recursive: true, force: true }); }
  });
}

test("the kinds this feature can touch are exactly three, and none is the audit or a decision (card K01d)", () => {
  assert.deepEqual([...LEAVE_OUT_KINDS], ["desk-record", "chat-turn", "notification-delivery"]);
});

test("when the check of what is still referred to cannot finish, nothing is left out, and the backup says so (card K01d)", async () => {
  const store = new MemoryStorage();
  await seed(store);
  // A snapshot that has endless replay steps: the reference scan reaches its bound before it can finish.
  const real = await store.snapshot();
  const endless: StorageSnapshot = {
    schemaVersion: real.schemaVersion,
    close: () => real.close(),
    read: async (table, page) => {
      const after = page.after;
      if (table === "aggregates" && after !== undefined && after["kind"] === "activity-step") {
        const start = after["id"] === "" ? 0 : Number(String(after["id"]).slice(2)) + 1;
        return Array.from({ length: page.limit }, (_, i) => ({ kind: "activity-step", id: `as${String(start + i).padStart(7, "0")}`, revision: 1, body: "{}", created_at: ago(1), updated_at: ago(1) }));
      }
      return real.read(table, page);
    },
  };
  const plan = await planLeaveOut(endless, ALL, NOW);
  assert.equal(plan.decide({ kind: "desk-record", id: "s-old-done" }), "keep");
  assert.equal(plan.decide({ kind: "notification-delivery", id: "nd-old" }), "keep");
  const record = plan.record();
  assert.equal(record.referenceCheckComplete, false);
  assert.deepEqual(record.leftOut, []);
  assert.match(record.text, /nothing was left out/);
  await real.close();
});

test("a tier whose own scan cannot finish also takes back what the tiers before it chose: nothing is left out (card K01d)", async () => {
  const store = new MemoryStorage();
  await seed(store);
  const real = await store.snapshot();
  const before = await planLeaveOut(real, ALL, NOW);
  assert.equal(before.decide({ kind: "desk-record", id: "s-old-done" }), "omit", "the scratch tier chose this one");
  // Endless delivery records: the last tier's own scan reaches its bound after the scratch tier had already chosen.
  const endless: StorageSnapshot = {
    schemaVersion: real.schemaVersion,
    close: () => real.close(),
    read: async (table, page) => {
      const after = page.after;
      if (table === "aggregates" && after !== undefined && after["kind"] === "notification-delivery") {
        const start = after["id"] === "" ? 0 : Number(String(after["id"]).slice(2)) + 1;
        return Array.from({ length: page.limit }, (_, i) => ({ kind: "notification-delivery", id: `nd${String(start + i).padStart(7, "0")}`, revision: 1, body: JSON.stringify({ state: "pending" }), created_at: ago(1), updated_at: ago(1) }));
      }
      return real.read(table, page);
    },
  };
  const plan = await planLeaveOut(endless, ALL, NOW);
  assert.equal(plan.decide({ kind: "desk-record", id: "s-old-done" }), "keep");
  assert.equal(plan.decide({ kind: "chat-turn", id: "ct-old" }), "keep");
  assert.equal(plan.record().referenceCheckComplete, false);
  await real.close();
});

