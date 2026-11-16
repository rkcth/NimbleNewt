import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DeskService } from "../context/index.js";
import { DecisionService } from "../decisions/index.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService } from "../security/index.js";
import { createBackup, restoreBackup } from "./index.js";

after(stopServer);

// Card K06b follow-up (T5), backup side: a decision link may name a finished task's private plan as its subject. The link is in every backup, so a scoped backup keeps that plan (and still leaves out an unlinked plan
// and ordinary scratch), and the restored link points at a record with its text.
const options = { clock: () => "2026-10-22T12:00:00.000Z", pause: async () => undefined };
const LATER = new Date("2027-01-15T12:00:00.000Z");
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;

for (const backend of backends) {
  test(`${backend.name}: a plan that a decision link names is kept by a scoped backup, an unlinked plan and plain scratch are left out, and the restored link points at the plan's text (card K06b follow-up T5)`, async () => {
    const world = await backend.open();
    const root = mkdtempSync(join(tmpdir(), "nn-t5-"));
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const a = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "A" })).id;
      const ta = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: a, title: "T" })).id;
      await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "ann", grants: [{ action: "desk.write", project: a }, { action: "desk.read", project: a }, { action: "attempt.work", project: a }] });
      const ann = await principals.authenticate((await principals.issueCredential(owner, "agent:ann")).token);
      const desks = DeskService.withEpoch(world.storage, projects.epoch, options);
      const decisions = DecisionService.withEpoch(world.storage, projects.epoch, {}, options);
      const write = async (kind: string, body: string): Promise<string> => (await desks.write(ann, { commandId: cid("w"), projectId: a, taskId: ta, kind, title: "work", body, visibility: "private", status: "accepted" } as never)).id;
      const linked = await write("plan", "the linked plan 8801");
      const free = await write("plan", "an unlinked plan 8802");
      const note = await write("note", "plain scratch 8803");
      const decided = await decisions.record(owner, { commandId: cid("dec"), projectId: a, category: "decision", topic: "database", statement: "Use PostgreSQL", wording: "We will use PostgreSQL", source: { channel: "direct" }, basedOn: 0 } as never);
      assert.equal(decided.recorded, true);
      await decisions.link(ann, { commandId: cid("lk"), taskId: ta, subject: { kind: "plan", id: linked }, decisions: [(decided as { id: string }).id] } as never);
      const task = (await world.storage.getAggregate({ kind: "task", id: ta }))!;
      await world.storage.applyOperation({ operationId: cid("op"), epoch: projects.epoch, actor: "owner:rob", correlationId: cid("co"), at: options.clock(), changes: [{ type: "update", ref: { kind: "task", id: ta }, expectedRevision: task.revision, body: { ...task.body, state: "cancelled" } }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);

      const made = await createBackup(world.storage, { root, kind: "manual", version: "t", now: () => LATER, leaveOut: { scratchDays: 30, transcriptDays: null, logDays: null } });
      const text = readFileSync(join(made.path, "aggregates.jsonl"), "utf8");
      assert.ok(text.includes("the linked plan 8801"), "the plan a link names is kept");
      assert.ok(!text.includes("an unlinked plan 8802") && !text.includes("plain scratch 8803"), "an unlinked plan and ordinary scratch are left out");
      const line = made.manifest.contentScope!.leftOut.find((l) => l.kind === "desk-record")!;
      assert.deepEqual([line.left, line.heldBack], [2, 1]);

      const target = await backend.open();
      try {
        await restoreBackup(made.path, target.storage);
        assert.equal(await target.storage.getAggregate({ kind: "desk-record", id: free }), undefined);
        assert.equal(await target.storage.getAggregate({ kind: "desk-record", id: note }), undefined);
        assert.equal(((await target.storage.getAggregate({ kind: "desk-record", id: linked }))!.body as { body: string }).body, "the linked plan 8801");
      } finally { await target.close(); }
    } finally { await world.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  });
}
