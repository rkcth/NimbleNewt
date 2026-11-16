import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ProjectService } from "../domain/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import type { ControllerStorage } from "../storage/types.js";
import { RETENTION_DEFAULTS, RETENTION_FIELDS, RetentionService } from "./index.js";

after(stopServer);

const DAY = 86_400_000;
const off = { ...RETENTION_DEFAULTS, reserveBytes: 0, thinkingAuto: false };
const SECRET = "the full text one agent sent another";

// Card K06e, tier "bulk logs": the text of a message between agents that its recipient dealt with is removed after agentMessageDays. A message still waiting, a request whose deadline has no reply,
// one the deadline list names and one a task's replay cites stay. The run says how many of each kind it removed and the status tells the room each bulk log takes.
for (const backend of backends) {
  test(`${backend.name}: handled and answered agent messages older than agentMessageDays are previewed then removed (audit without text); waiting, deadline, listed and replay-cited ones and young ones stay; off by default (card K06e)`, async () => {
    const world = await backend.open();
    try {
      const storage: ControllerStorage = world.storage;
      const real = Date.now();
      const options = { clock: () => new Date(real).toISOString(), pause: async () => undefined };
      const projects = await ProjectService.open(storage, { holder: "c1", ...options });
      const epoch = projects.epoch;
      const principals = PrincipalService.withEpoch(storage, epoch, options);
      const owner: Principal = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const put = async (kind: string, id: string, body: object, daysAgo: number): Promise<void> => {
        await storage.applyOperation({ operationId: `put-${kind}-${id}`, epoch, actor: "test", correlationId: "put", at: new Date(real - daysAgo * DAY).toISOString(), changes: [{ type: "create", ref: { kind, id }, body: body as never }], audit: [{ type: "test.put", subject: { kind, id }, detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
      };
      const base = { taskId: "task-a", projectId: "proj-a", sender: "agent:x", to: "agent:y", kind: "notice", purpose: "p", text: SECRET, class: "advice", effectiveClass: "advice", urgency: "normal", correlationId: "c", depth: 0, reach: "ready", count: 1, sentAt: new Date(real).toISOString(), lastAt: new Date(real).toISOString() };
      await put("agent-message", "amg-waiting", { ...base, state: "accepted" }, 90);
      await put("agent-message", "amg-delivered", { ...base, state: "delivered" }, 90);
      await put("agent-message", "amg-handled", { ...base, state: "handled" }, 90);
      await put("agent-message", "amg-answered", { ...base, state: "answered" }, 90);
      await put("agent-message", "amg-handled-deadline", { ...base, state: "handled", deadline: new Date(real - 80 * DAY).toISOString(), escalateTo: "owner:rob" }, 90);
      await put("agent-message", "amg-answered-listed", { ...base, state: "answered" }, 90);
      await put("agent-message", "amg-answered-replay", { ...base, state: "answered" }, 90);
      // Either side of the window: at day 40 these are 61 and 59 days old against a window of 60.
      await put("agent-message", "amg-edge-over", { ...base, state: "handled" }, 21);
      await put("agent-message", "amg-edge-under", { ...base, state: "handled" }, 19);
      await put("agent-deadlines", "all", { open: [{ id: "amg-answered-listed", sender: "agent:x" }] }, 90);
      // A task's replay names one message in its manifest.
      await put("activity-step", "act-1", { taskId: "task-a", seq: 1, manifest: { refs: [{ kind: "agent-message", id: "amg-answered-replay" }] } }, 90);

      const svc = (v: object, ahead = 0) => RetentionService.withEpoch(storage, epoch, { settings: { effective: async () => ({ ...off, ...v }) }, now: () => real + ahead * DAY } as never, { clock: () => new Date(real + ahead * DAY).toISOString(), pause: async () => undefined });
      const has = async (id: string): Promise<boolean> => (await storage.getAggregate({ kind: "agent-message", id })) !== undefined;

      assert.equal(RETENTION_DEFAULTS.agentMessageDays, null);
      assert.deepEqual([RETENTION_FIELDS.agentMessageDays.kind, (RETENTION_FIELDS.agentMessageDays as { min: number }).min, (RETENTION_FIELDS.agentMessageDays as { max: number }).max], ["days", 7, 3650]);
      assert.equal((await svc({}, 120).run(owner, {})).candidates.length, 0, "off by default");

      const preview = await svc({ agentMessageDays: 60 }, 40).run(owner, {});
      assert.deepEqual(preview.candidates.map((c) => c.id).sort(), ["amg-answered", "amg-edge-over", "amg-handled"], "only handled or answered, with no deadline in the way, none listed or cited, older than the window");
      assert.equal(preview.enabled, true);
      const heldWhy = Object.fromEntries(preview.retained.map((r) => [r.id, r.reasons.join(" | ")]));
      assert.match(heldWhy["amg-answered-replay"]!, /replay of task task-a/);
      assert.match(heldWhy["amg-answered-listed"]!, /list of requests waiting for a reply/);
      assert.equal(await has("amg-answered"), true, "a preview removes nothing");
      await assert.rejects(svc({ agentMessageDays: 60 }, 40).run(owner, { dryRun: false }), /confirm/i);
      const ran = await svc({ agentMessageDays: 60 }, 40).run(owner, { dryRun: false, confirm: preview.digest! });
      assert.equal(ran.removed, 3);
      for (const id of ["amg-answered", "amg-handled", "amg-edge-over"]) assert.equal(await has(id), false, `${id} is removed`);
      for (const id of ["amg-waiting", "amg-delivered", "amg-handled-deadline", "amg-answered-listed", "amg-answered-replay", "amg-edge-under"]) assert.equal(await has(id), true, `${id} stays`);

      const audit = (await storage.listAudit({ afterSeq: 0, limit: 1000 })).filter((e) => e.type === "retention.expire");
      assert.equal(audit.length, 3);
      for (const e of audit) { assert.equal((e.detail as { rule: string }).rule, "agent-message-days"); assert.ok(!JSON.stringify(e).includes(SECRET), "the audit names IDs, never the text"); }
      // The run record counts what it removed by kind, and the status tells it next to the room the kind still takes.
      const st = await svc({ agentMessageDays: 60 }, 40).status(owner) as unknown as { runs: { byKind: Record<string, number> }[]; bulkLogs: { kind: string; records: number; bytes: number; days: number | null; partial: boolean }[]; growth: Record<string, number> };
      assert.deepEqual(st.runs[0]!.byKind, { "agent-message": 3 });
      const mine = st.bulkLogs.find((b) => b.kind === "agent-message")!;
      assert.equal(mine.records, 6);
      assert.equal(mine.days, 60);
      assert.ok(mine.bytes >= 6 * SECRET.length, "the figure is the size of the stored records");
      assert.equal(mine.partial, false);
      assert.equal(st.growth["agent-message"], 6);
      assert.deepEqual(st.bulkLogs.map((b) => b.kind), ["notification-delivery", "agent-message", "generation-run"]);

      // The reply that settled the deadline list is gone; the held ones stay held even much later, for the replay and the list.
      const late = await svc({ agentMessageDays: 60 }, 200).run(owner, {});
      assert.deepEqual(late.candidates.map((c) => c.id), ["amg-edge-under"]);
      assert.equal((await svc({ agentMessageDays: 60 }, 200).run(owner, {})).retained.length, 2);
    } finally { await world.close(); }
  });
}
