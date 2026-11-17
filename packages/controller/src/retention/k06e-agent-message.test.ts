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

// Review (K06e): messages name each other by ID. A message that a kept message names stays (a reply still waiting keeps the request it answers, a chain keeps every link back, a kept request keeps its escalation),
// also when the run's cap leaves some behind; a scan of messages cut short removes none; a run recorded before the per-kind counts is told as not recorded unless its ID list is whole.
for (const backend of backends) {
  test(`${backend.name}: a message that a kept message names by ID stays, through a whole chain and under the run's cap; nothing kept is left naming a removed message (card K06e review)`, async () => {
    const world = await backend.open();
    try {
      const storage: ControllerStorage = world.storage;
      const real = Date.now();
      const options = { clock: () => new Date(real).toISOString(), pause: async () => undefined };
      const projects = await ProjectService.open(storage, { holder: "c1", ...options });
      const epoch = projects.epoch;
      const principals = PrincipalService.withEpoch(storage, epoch, options);
      const owner: Principal = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const put = async (id: string, body: object): Promise<void> => {
        await storage.applyOperation({ operationId: `put-${id}`, epoch, actor: "test", correlationId: "put", at: new Date(real - 90 * DAY).toISOString(), changes: [{ type: "create", ref: { kind: "agent-message", id }, body: { taskId: "task-a", projectId: "proj-a", sender: "agent:x", to: "agent:y", kind: "notice", purpose: "p", text: SECRET, class: "advice", effectiveClass: "advice", ...body } as never }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
      };
      // A request answered long ago whose reply is still waiting to be read: the request stays.
      await put("amg-req", { state: "answered", kind: "request", replyId: "amg-rep" });
      await put("amg-rep", { state: "accepted", kind: "reply", replyTo: "amg-req" });
      // Both sides dealt with: both go.
      await put("amg-req2", { state: "answered", kind: "request", replyId: "amg-rep2" });
      await put("amg-rep2", { state: "handled", kind: "reply", replyTo: "amg-req2" });
      // A chain whose last reply is still delivered (not dealt with): every link back stays.
      await put("amg-c1", { state: "answered", replyId: "amg-c2" });
      await put("amg-c2", { state: "answered", kind: "reply", replyTo: "amg-c1", replyId: "amg-c3" });
      await put("amg-c3", { state: "delivered", kind: "reply", replyTo: "amg-c2" });
      // A request with a deadline (kept) names its escalation, which was handled: the escalation stays.
      await put("amg-par", { state: "handled", kind: "request", deadline: new Date(real - 95 * DAY).toISOString(), escalateTo: "owner:rob", escalationId: "amg-esc" });
      await put("amg-esc", { state: "handled", kind: "escalation", sender: "controller", replyTo: "amg-par" });
      // A message on its own.
      await put("amg-alone", { state: "handled" });
      const svc = RetentionService.withEpoch(storage, epoch, { settings: { effective: async () => ({ ...off, agentMessageDays: 60 }) } } as never, options);

      // The run's cap (2) takes amg-alone and amg-req2 in ID order and leaves amg-rep2 behind; amg-rep2 names amg-req2, so amg-req2 stays this time too.
      const capped = await svc.run(owner, { limit: 2 });
      assert.deepEqual(capped.candidates.map((c) => c.id), ["amg-alone"]);
      assert.equal(capped.partial, true);

      const preview = await svc.run(owner, {});
      assert.deepEqual(preview.candidates.map((c) => c.id).sort(), ["amg-alone", "amg-rep2", "amg-req2"]);
      const why = Object.fromEntries(preview.retained.map((r) => [r.id, r.reasons.join(" | ")]));
      assert.match(why["amg-req"]!, /the message amg-rep, which is kept, names it/);
      assert.match(why["amg-c2"]!, /amg-c3/);
      assert.match(why["amg-c1"]!, /amg-c2/);
      assert.match(why["amg-esc"]!, /amg-par/);
      await svc.run(owner, { dryRun: false, confirm: preview.digest! });
      // Nothing kept names a message that is gone.
      const left = await storage.listAggregates("agent-message", { limit: 500 });
      const ids = new Set(left.map((a) => a.id));
      assert.deepEqual([...ids].sort(), ["amg-c1", "amg-c2", "amg-c3", "amg-esc", "amg-par", "amg-rep", "amg-req"]);
      for (const a of left) for (const f of ["replyTo", "replyId", "escalationId"]) { const v = (a.body as Record<string, unknown>)[f]; if (typeof v === "string") assert.ok(ids.has(v), `${a.id}.${f} names ${v}, which is kept`); }
    } finally { await world.close(); }
  });
}

test("no message is removed when the scan of messages was cut short: a message not read could name one found (card K06e review)", async () => {
  const world = await backends[0]!.open();
  try {
    const base: ControllerStorage = world.storage;
    const real = Date.now();
    const options = { clock: () => new Date(real).toISOString(), pause: async () => undefined };
    const projects = await ProjectService.open(base, { holder: "c1", ...options });
    const principals = PrincipalService.withEpoch(base, projects.epoch, options);
    const owner: Principal = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
    const old = new Date(real - 90 * DAY).toISOString();
    // A store with more messages than one run reads: every one old and handled, none naming another.
    const many = new Proxy(base, {
      get(target, prop, receiver) {
        if (prop === "listAggregates") return async (kind: string, page: { afterId?: string; limit: number }) => {
          if (kind !== "agent-message") return target.listAggregates(kind, page as never);
          const start = page.afterId === undefined ? 0 : Number(page.afterId.slice(4)) + 1;
          return Array.from({ length: page.limit }, (_, i) => ({ kind, id: `amg-${String(start + i).padStart(8, "0")}`, revision: 1, body: { state: "handled", projectId: "proj-a" }, createdAt: old, updatedAt: old }));
        };
        const v = Reflect.get(target, prop, receiver) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const svc = (s: ControllerStorage) => RetentionService.withEpoch(s, projects.epoch, { settings: { effective: async () => ({ ...off, agentMessageDays: 60 }) } } as never, options);
    const report = await svc(many).run(owner, {});
    assert.equal(report.partial, true);
    assert.deepEqual(report.candidates.filter((c) => c.kind === "agent-message"), [], "nothing is removed on a partial view");
  } finally { await world.close(); }
});

for (const backend of backends) {
  test(`${backend.name}: a run recorded before the per-kind counts says what it removed of each kind only when its ID list is whole (card K06e review)`, async () => {
    const world = await backend.open();
    try {
      const storage: ControllerStorage = world.storage;
      const real = Date.now();
      const options = { clock: () => new Date(real).toISOString(), pause: async () => undefined };
      const projects = await ProjectService.open(storage, { holder: "c1", ...options });
      const epoch = projects.epoch;
      const principals = PrincipalService.withEpoch(storage, epoch, options);
      const owner: Principal = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const run = async (id: string, body: object, daysAgo: number): Promise<void> => {
        await storage.applyOperation({ operationId: `put-${id}`, epoch, actor: "test", correlationId: "put", at: new Date(real - daysAgo * DAY).toISOString(), changes: [{ type: "create", ref: { kind: "retention-run", id }, body: { at: new Date(real - daysAgo * DAY).toISOString(), by: owner.id, auto: false, ...body } as never }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
      };
      await run("rrn-whole", { removed: ["notification-delivery/ndl-1", "notification-delivery/ndl-2", "generation-run/gen-1"], removedCount: 3 }, 3);
      await run("rrn-cut", { removed: Array.from({ length: 200 }, (_, i) => `notification-delivery/ndl-x${i}`), removedCount: 250 }, 2);
      await run("rrn-none", { removed: [], removedCount: 0 }, 1);
      await run("rrn-damaged", { removed: [], removedCount: 0, removedByKind: { "agent-message": "many" } }, 4);
      const svc = RetentionService.withEpoch(storage, epoch, { settings: { effective: async () => ({ ...off }) } } as never, options);
      const st = await svc.status(owner) as unknown as { runs: { id: string; byKind?: Record<string, number> }[] };
      const of = Object.fromEntries(st.runs.map((r) => [r.id, r.byKind]));
      assert.deepEqual(of["rrn-whole"], { "notification-delivery": 2, "generation-run": 1 });
      assert.equal(of["rrn-cut"], undefined, "250 removed, 200 listed: not known by kind");
      assert.deepEqual(of["rrn-none"], {});
      assert.equal(of["rrn-damaged"], undefined, "a damaged count is not shown as a figure");
    } finally { await world.close(); }
  });
}

for (const backend of backends) {
  test(`${backend.name}: a message changed by another actor after the preview is not removed: the old digest is refused, and a change landing between the run's read and its delete leaves the record (card K06e review)`, async () => {
    const world = await backend.open();
    try {
      const storage: ControllerStorage = world.storage;
      const real = Date.now();
      const options = { clock: () => new Date(real).toISOString(), pause: async () => undefined };
      const projects = await ProjectService.open(storage, { holder: "c1", ...options });
      const epoch = projects.epoch;
      const principals = PrincipalService.withEpoch(storage, epoch, options);
      const owner: Principal = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const body = (extra: object) => ({ taskId: "task-a", projectId: "proj-a", sender: "agent:x", to: "agent:y", kind: "request", purpose: "p", text: SECRET, class: "advice", effectiveClass: "advice", state: "handled", ...extra });
      const apply = async (s: ControllerStorage, opId: string, change: object, at: string): Promise<void> => {
        await s.applyOperation({ operationId: opId, epoch, actor: "agent:y", correlationId: opId, at, changes: [change], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
      };
      const old = new Date(real - 90 * DAY).toISOString();
      for (const id of ["amg-a", "amg-b"]) await apply(storage, `put-${id}`, { type: "create", ref: { kind: "agent-message", id }, body: body({}) }, old);
      const svc = (s: ControllerStorage) => RetentionService.withEpoch(s, epoch, { settings: { effective: async () => ({ ...off, agentMessageDays: 60 }) } } as never, options);
      const preview = await svc(storage).run(owner, {});
      assert.deepEqual(preview.candidates.map((c) => c.id), ["amg-a", "amg-b"]);
      // Actor two: the recipient answers amg-a after the preview (an old revision of it was previewed).
      const a = (await storage.getAggregate({ kind: "agent-message", id: "amg-a" }))!;
      await apply(storage, "answer-a", { type: "update", ref: { kind: "agent-message", id: "amg-a" }, expectedRevision: a.revision, body: body({ state: "answered", replyId: "amg-r" }) }, old);
      await assert.rejects(svc(storage).run(owner, { dryRun: false, confirm: preview.digest! }), /confirm/, "a digest made before the change is refused after it");
      // Actor two again, this time between the run's list of candidates (confirmed by the digest) and its guarded delete of amg-b.
      const fresh = await svc(storage).run(owner, {});
      assert.ok(fresh.candidates.some((c) => c.id === "amg-b"));
      let raced = false;
      const racing = new Proxy(storage, {
        get(target, prop, receiver) {
          if (prop === "applyOperation") return async (op: { changes: { type: string; ref: { id: string } }[] }) => {
            // It lands while the run removes amg-a, after the run read its candidates and before it reads amg-b again.
            if (!raced && op.changes.some((c) => c.type === "delete" && c.ref.id === "amg-a")) {
              raced = true;
              const b = (await target.getAggregate({ kind: "agent-message", id: "amg-b" }))!;
              await apply(target, "edit-b", { type: "update", ref: { kind: "agent-message", id: "amg-b" }, expectedRevision: b.revision, body: body({ state: "handled", text: "changed meanwhile" }) }, new Date(real).toISOString());
            }
            return target.applyOperation(op as never);
          };
          const v = Reflect.get(target, prop, receiver) as unknown;
          return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(target) : v;
        },
      });
      const ran = await svc(racing).run(owner, { dryRun: false, confirm: fresh.digest! });
      assert.equal(raced, true, "the other actor's change landed during the run");
      assert.ok((await storage.getAggregate({ kind: "agent-message", id: "amg-b" })) !== undefined, "the changed message stays");
      assert.equal(((await storage.getAggregate({ kind: "agent-message", id: "amg-b" }))!.body as { text: string }).text, "changed meanwhile");
      assert.equal(ran.removed, 1, "amg-a, answered long ago, is removed; amg-b is skipped");
      assert.equal((await storage.listAudit({ afterSeq: 0, limit: 1000 })).filter((e) => e.type === "retention.expire" && e.subject?.id === "amg-b").length, 0, "no removal is recorded for it");
    } finally { await world.close(); }
  });
}
