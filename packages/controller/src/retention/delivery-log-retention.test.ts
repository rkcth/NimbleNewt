import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ProjectService } from "../domain/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { NotificationService } from "../notifications/index.js";
import { PrincipalService, type Principal } from "../security/index.js";
import type { ControllerStorage } from "../storage/types.js";
import { RETENTION_DEFAULTS, RETENTION_FIELDS, RetentionService } from "./index.js";

after(stopServer);

const DAY = 86_400_000;
const off = { ...RETENTION_DEFAULTS, reserveBytes: 0, thinkingAuto: false };

// Card K06b, tier "bulk logs": the record of each delivered message to the owner (it holds the full text) is removed after deliveryLogDays; waiting and failed ones, the notices and the audit stay.
for (const backend of backends) {
  test(`${backend.name}: delivered message records older than deliveryLogDays are previewed, then removed with an audit entry that carries no text; waiting and failed ones, young ones and the notice itself stay; off by default (card K06b)`, async () => {
    const world = await backend.open();
    try {
      const storage: ControllerStorage = world.storage;
      const real = Date.now();
      const options = { clock: () => new Date(real).toISOString(), pause: async () => undefined };
      const projects = await ProjectService.open(storage, { holder: "c1", ...options });
      const epoch = projects.epoch;
      const principals = PrincipalService.withEpoch(storage, epoch, options);
      const owner: Principal = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const sent: string[] = [];
      const notes = NotificationService.withEpoch(storage, epoch, { ...options, channels: { pager: { send: async (m) => { sent.push(m.text); } } } });
      await notes.configure(owner, { commandId: "cfg-1", channel: "external", channelName: "pager" });
      const SECRET = "the full text of the message to the owner";
      // Two real notices sent through a working channel: each delivery record ends as delivered.
      const a = await notes.emitFromController({ commandId: "n-old", kind: "maintenance", level: "needs-you", interrupt: true, ref: { kind: "task", id: "task-a" }, detail: SECRET });
      const b = await notes.emitFromController({ commandId: "n-new", kind: "maintenance", level: "needs-you", interrupt: true, ref: { kind: "task", id: "task-b" }, detail: `${SECRET} two` });
      await notes.runDue();
      assert.equal(sent.length, 2, "both were sent");
      const deliveries = await storage.listAggregates("notification-delivery", { limit: 100 });
      assert.equal(deliveries.length, 2);
      const put = async (id: string, body: object, daysAgo: number): Promise<void> => {
        await storage.applyOperation({ operationId: `put-${id}`, epoch, actor: "test", correlationId: "put", at: new Date(real - daysAgo * DAY).toISOString(), changes: [{ type: "create", ref: { kind: "notification-delivery", id }, body: body as never }], audit: [{ type: "test.put", subject: { kind: "notification-delivery", id }, detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
      };
      const base = { subject: { kind: "item", id: a.itemId }, channel: "mail", text: SECRET, attempts: 1 };
      await put("ndl-waiting", { ...base, state: "pending", nextAttemptAt: new Date(real).toISOString() }, 90);
      await put("ndl-failed", { ...base, state: "failed", lastError: "no route" }, 90);
      await put("ndl-oldok", { ...base, state: "delivered" }, 90);
      const svc = (v: object, ahead = 0) => RetentionService.withEpoch(storage, epoch, { settings: { effective: async () => ({ ...off, ...v }) }, now: () => real + ahead * DAY } as never, { clock: () => new Date(real + ahead * DAY).toISOString(), pause: async () => undefined });
      const has = async (id: string): Promise<boolean> => (await storage.getAggregate({ kind: "notification-delivery", id })) !== undefined;

      assert.equal(RETENTION_DEFAULTS.deliveryLogDays, null);
      assert.deepEqual([RETENTION_FIELDS.deliveryLogDays.kind, (RETENTION_FIELDS.deliveryLogDays as { min: number }).min, (RETENTION_FIELDS.deliveryLogDays as { max: number }).max], ["days", 7, 3650]);
      assert.equal((await svc({}, 120).run(owner, {})).candidates.length, 0, "off by default");

      // 40 days on: the two real deliveries are 40 days old (kept at 60), the put ones are 130 days old.
      const preview = await svc({ deliveryLogDays: 60 }, 40).run(owner, {});
      assert.deepEqual(preview.candidates.map((c) => `${c.kind}/${c.id}`), ["notification-delivery/ndl-oldok"], "only the old delivered one");
      assert.equal(preview.enabled, true);
      assert.equal(await has("ndl-oldok"), true, "a preview removes nothing");
      await assert.rejects(svc({ deliveryLogDays: 60 }, 40).run(owner, { dryRun: false }), /confirm/i);
      const ran = await svc({ deliveryLogDays: 60 }, 40).run(owner, { dryRun: false, confirm: preview.digest! });
      assert.equal(ran.removed, 1);
      assert.equal(await has("ndl-oldok"), false);
      for (const id of ["ndl-waiting", "ndl-failed", ...deliveries.map((d) => d.id)]) assert.equal(await has(id), true, `${id} stays`);
      assert.ok(await storage.getAggregate({ kind: "notification-item", id: a.itemId }), "the notice stays");
      assert.ok(await storage.getAggregate({ kind: "notification-item", id: b.itemId }), "the other notice stays");

      // Much later the two real, delivered ones are old too; the waiting and failed ones are still never touched.
      const late = await svc({ deliveryLogDays: 60 }, 200).run(owner, {});
      assert.deepEqual(late.candidates.map((c) => c.id).sort(), deliveries.map((d) => d.id).sort());
      await svc({ deliveryLogDays: 60 }, 200).run(owner, { dryRun: false, confirm: late.digest! });
      assert.equal((await storage.listAggregates("notification-delivery", { limit: 100 })).map((d) => d.id).sort().join(), "ndl-failed,ndl-waiting");
      assert.equal((await notes.inbox(owner)).items.length, 2, "the inbox still lists both notices");

      const audit = (await storage.listAudit({ afterSeq: 0, limit: 1000 })).filter((e) => e.type === "retention.expire");
      assert.equal(audit.length, 3);
      for (const e of audit) { assert.equal((e.detail as { rule: string }).rule, "delivery-log-days"); assert.ok(!JSON.stringify(e).includes(SECRET), "the audit names IDs, never the text"); }
      assert.equal((await svc({ deliveryLogDays: 60 }, 200).run(owner, {})).candidates.length, 0, "nothing more to do");
    } finally { await world.close(); }
  });
}
