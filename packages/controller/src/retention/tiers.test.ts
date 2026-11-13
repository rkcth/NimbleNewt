import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ProjectService } from "../domain/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import type { ControllerStorage } from "../storage/types.js";
import { RETENTION_DEFAULTS, RETENTION_FIELDS, RetentionService } from "./index.js";

after(stopServer);

const DAY = 86_400_000;
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const rid = (c: string): string => `dsk-${c.repeat(20)}`;
const off = { ...RETENTION_DEFAULTS, reserveBytes: 0, thinkingAuto: false };

// Card K06b: the two last tiers of the retention table. Private scratch of a finished task is archived, then removed; old chat turns lose the owner's words. Both are off unless the owner sets a window.
for (const backend of backends) {
  test(`${backend.name}: scratch output of a finished task is archived after scratchArchiveDays, restorable, then removed after scratchPurgeDays with what stands on it; a running task's, a shared record, a held record are left; off by default (card K06b)`, async () => {
    const world = await backend.open();
    try {
      const storage: ControllerStorage = world.storage;
      const real = Date.now();
      const options = { clock: () => new Date(real - 60 * DAY).toISOString(), pause: async () => undefined };
      const projects = await ProjectService.open(storage, { holder: "c1", ...options });
      const epoch = projects.epoch;
      const principals = PrincipalService.withEpoch(storage, epoch, options);
      const owner: Principal = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "A" })).id;
      const mk = async (title: string, finish: boolean): Promise<string> => {
        const id = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title })).id;
        for (const step of finish ? ["ready", "in_progress", "done"] : ["ready"]) await projects.transitionTask({ commandId: cid("mv"), actor: owner.id, taskId: id, expectedRevision: (await projects.getTask(id))!.revision, to: step as never });
        return id;
      };
      const done = await mk("finished", true), live = await mk("running", false);
      const put = async (kind: string, id: string, body: object, daysAgo = 60): Promise<void> => {
        await storage.applyOperation({ operationId: cid("put"), epoch, actor: "test", correlationId: "put", at: new Date(real - daysAgo * DAY).toISOString(), changes: [{ type: "create", ref: { kind, id }, body: body as never }], audit: [{ type: "test.put", subject: { kind, id }, detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
      };
      const desk = (taskId: string, visibility: string, title: string) => ({ projectId: project, taskId, owner: "agent:ann", kind: "note", title, body: `The private working text of ${title}, long enough to quote it back.`, visibility, status: "accepted" });
      const scratch = rid("a"), shared = rid("b"), running = rid("c"), cited = rid("d");
      await put("desk-record", scratch, desk(done, "private", "scratch of the finished task"));
      await put("desk-record", shared, desk(done, "shared", "shared by the finished task"));
      await put("desk-record", running, desk(live, "private", "scratch of a running task"));
      await put("desk-record", cited, desk(done, "private", "scratch a step cites"));
      await put("activity-step", "act-1", { taskId: done, projectId: project, seq: 1, kind: "tool-call", summary: "s", actor: "agent:ann", at: new Date(real - 59 * DAY).toISOString(), manifest: { missing: false, refs: [{ kind: "desk-record", id: cited }] }, payload: { state: "none" } });

      const svc = (v: object) => RetentionService.withEpoch(storage, epoch, { settings: { effective: async () => ({ ...off, ...v }) }, now: () => real } as never, { clock: () => new Date(real).toISOString(), pause: async () => undefined });
      const title = async (id: string): Promise<string> => ((await storage.getAggregate({ kind: "desk-record", id }))!.body as { title: string }).title;
      assert.equal(RETENTION_DEFAULTS.scratchArchiveDays, null); assert.equal(RETENTION_DEFAULTS.scratchPurgeDays, null); assert.equal(RETENTION_DEFAULTS.transcriptDays, null);
      assert.equal((await svc({}).run(owner, {})).candidates.length, 0, "off by default");

      // Archive: the finished task's private record, not the shared one, not the running task's; a replay hold does not stop an archive (it is put back as it was).
      const preview = await svc({ scratchArchiveDays: 30 }).run(owner, {});
      assert.deepEqual(preview.candidates.map((c) => [c.kind, c.id]).sort(), [["scratch-archive", cited], ["scratch-archive", scratch]].sort());
      await assert.rejects(svc({ scratchArchiveDays: 30 }).run(owner, { dryRun: false }), /confirm/i);
      const ran = await svc({ scratchArchiveDays: 30 }).run(owner, { dryRun: false, confirm: preview.digest! });
      assert.equal(ran.removed, 2);
      assert.equal(await title(scratch), "(archived)");
      assert.equal(await title(shared), "shared by the finished task");
      assert.equal(await title(running), "scratch of a running task");
      assert.equal((await svc({ scratchArchiveDays: 30 }).run(owner, {})).candidates.length, 0, "archived once");
      const restored = await svc({}).restore(owner, { commandId: cid("r"), taskId: done });
      assert.ok(restored.restored.includes(scratch));
      assert.equal(await title(scratch), "scratch of the finished task", "restore puts back the original");

      // Purge: after the archive is old enough. The record a step cites is held against removal (the replay still points at it) and shown so.
      const at = (days: number, v: object) => RetentionService.withEpoch(storage, epoch, { settings: { effective: async () => ({ ...off, ...v }) }, now: () => real + days * DAY } as never, { clock: () => new Date(real + days * DAY).toISOString(), pause: async () => undefined });
      const again = await at(40, { scratchArchiveDays: 30 }).run(owner, {});
      await at(40, { scratchArchiveDays: 30 }).run(owner, { dryRun: false, confirm: again.digest! });
      assert.equal(await title(scratch), "(archived)");
      const later = (v: object) => at(80, v);
      const pv = await later({ scratchArchiveDays: 30, scratchPurgeDays: 30 }).run(owner, {});
      assert.deepEqual(pv.candidates.map((c) => [c.kind, c.id]), [["scratch-purge", scratch]]);
      assert.ok(pv.retained.some((r) => r.id === cited), "the cited record is shown as retained, not removed");
      const pr = await later({ scratchArchiveDays: 30, scratchPurgeDays: 30 }).run(owner, { dryRun: false, confirm: pv.digest! });
      assert.equal(pr.removed, 1);
      assert.equal(await title(scratch), "", "the text is gone");
      assert.equal(await title(shared), "shared by the finished task");
      const deletions = (await storage.listAudit({ afterSeq: 0, limit: 1000 })).filter((a) => a.type === "retention.delete" || a.type === "retention.expire");
      assert.ok(deletions.length >= 1, "recorded");
      assert.deepEqual([RETENTION_FIELDS.scratchArchiveDays, RETENTION_FIELDS.scratchPurgeDays, RETENTION_FIELDS.transcriptDays].map((f) => [f.kind, f.min, f.max, f.nullable]), [["days", 7, 3650, true], ["days", 30, 3650, true], ["days", 30, 3650, true]], "windows are bounded and optional");
    } finally { await world.close(); }
  });

  test(`${backend.name}: an old finished chat turn loses the owner's words and its answers but stays as a stub; a turn a decision, an agenda item or an open proposal rests on, a turn still held and a young turn are kept; the same message sent again is still answered as done (card K06b)`, async () => {
    const world = await backend.open();
    try {
      const storage: ControllerStorage = world.storage;
      const real = Date.now();
      const options = { clock: () => new Date(real).toISOString(), pause: async () => undefined };
      const projects = await ProjectService.open(storage, { holder: "c1", ...options });
      const epoch = projects.epoch;
      const principals = PrincipalService.withEpoch(storage, epoch, options);
      const owner: Principal = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "A" })).id;
      const put = async (kind: string, id: string, body: object, daysAgo: number): Promise<void> => {
        await storage.applyOperation({ operationId: cid("put"), epoch, actor: "test", correlationId: "put", at: new Date(real - daysAgo * DAY).toISOString(), changes: [{ type: "create", ref: { kind, id }, body: body as never }], audit: [{ type: "test.put", subject: { kind, id }, detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
      };
      const turn = (id: string, days: number, extra: object = {}) => put("chat-turn", id, { ownerId: owner.id, messageId: `msg-${id}`, projectId: project, status: "done", text: `the words of ${id}`, plan: [{ op: "x" }], outcomes: [{ ok: true }], createdAt: new Date(real - days * DAY).toISOString(), completedAt: new Date(real - days * DAY).toISOString(), ...extra }, days);
      for (const id of ["ct-old", "ct-young", "ct-decided", "ct-agenda", "ct-proposal", "ct-held"]) await turn(id, id === "ct-young" ? 3 : 90, id === "ct-held" ? { held: [{ op: "y" }] } : {});
      await put("decision", "dec-1", { projectId: project, source: { turnId: "ct-decided" } }, 90);
      await put("agenda-item", "agi-1", { projectId: project, source: { kind: "chat-turn", id: "ct-agenda" } }, 90);
      await put("chat-proposal", "prop-1", { status: "open", turnId: "ct-proposal" }, 90);
      // The chat's conversation context keeps the start of each recent turn's words per project (review: that copy must go with the turn's words).
      await put("chat-context", `ctx:${owner.id}`, { focusProjectId: project, projects: { [project]: { touchedAt: new Date(real - 3 * DAY).toISOString(), turns: [{ turnId: "ct-old", at: new Date(real - 90 * DAY).toISOString(), summary: "the words of ct-old -> done" }, { turnId: "ct-young", at: new Date(real - 3 * DAY).toISOString(), summary: "the words of ct-young -> done" }] } } }, 3);
      const svc = (v: object) => RetentionService.withEpoch(storage, epoch, { settings: { effective: async () => ({ ...off, ...v }) }, now: () => real } as never, options);
      assert.equal((await svc({}).run(owner, {})).candidates.length, 0, "off by default");
      const preview = await svc({ transcriptDays: 60 }).run(owner, {});
      assert.deepEqual(preview.candidates.map((c) => c.id), ["ct-old"]);
      assert.deepEqual(preview.retained.map((r) => r.id).sort(), ["ct-agenda", "ct-decided", "ct-proposal"]);
      const ran = await svc({ transcriptDays: 60 }).run(owner, { dryRun: false, confirm: preview.digest! });
      assert.equal(ran.removed, 1);
      const stub = (await storage.getAggregate({ kind: "chat-turn", id: "ct-old" }))!.body as Record<string, any>;
      assert.equal(stub["text"], ""); assert.deepEqual(stub["plan"], []); assert.deepEqual(stub["outcomes"], []);
      assert.equal(stub["messageId"], "msg-ct-old"); assert.equal(stub["status"], "done");
      assert.equal(stub["retention"].rule, "transcript-days");
      const ctx = JSON.stringify((await storage.getAggregate({ kind: "chat-context", id: `ctx:${owner.id}` }))!.body);
      assert.ok(!ctx.includes("the words of ct-old") && ctx.includes("removed by retention"), "the context's copy of the words is gone too");
      assert.ok(ctx.includes("the words of ct-young"), "a young turn's line stays");
      for (const id of ["ct-young", "ct-decided", "ct-agenda", "ct-proposal", "ct-held"]) assert.equal(((await storage.getAggregate({ kind: "chat-turn", id }))!.body as { text: string }).text, `the words of ${id}`, id);
      assert.equal((await svc({ transcriptDays: 60 }).run(owner, {})).candidates.length, 0, "a stub is not a candidate again");
      // Audit and decisions are never touched by this tier.
      assert.ok(await storage.getAggregate({ kind: "decision", id: "dec-1" }));
      const audit = (await storage.listAudit({ afterSeq: 0, limit: 1000 })).filter((a) => a.type === "retention.expire");
      assert.equal(audit.length, 1);
      assert.equal((audit[0]!.detail as { rule: string }).rule, "transcript-days");
      assert.ok(!JSON.stringify(audit[0]).includes("the words of"), "the audit carries no text");
    } finally { await world.close(); }
  });
}
