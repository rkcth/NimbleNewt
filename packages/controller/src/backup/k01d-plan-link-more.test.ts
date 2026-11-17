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
import { createBackup } from "./index.js";
import { planLeaveOut } from "./scope.js";
import type { StorageSnapshot } from "../storage/index.js";

after(stopServer);

// Card K06b follow-up (T5b), backup side: the scoped backup reads the decision links page by page with no cap, a link naming an empty or a missing plan keeps that plan and breaks nothing, and a malformed link record
// does not stop the backup.
const options = { clock: () => "2026-10-22T12:00:00.000Z", pause: async () => undefined };
const LATER = new Date("2027-01-15T12:00:00.000Z");
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const ops = { audit: [{ type: "test.plant", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] };

for (const backend of backends) {
  test(`${backend.name}: a scoped backup keeps a plan named by a link on a late page of link records, an empty plan a link names, and survives malformed link records (card K06b follow-up T5b)`, async () => {
    const world = await backend.open();
    const root = mkdtempSync(join(tmpdir(), "nn-t5b-"));
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
      const far = await write("plan", "plan named on a late page 7701");
      const empty = await write("plan", "to be emptied 7702");
      const free = await write("plan", "an unlinked plan 7703");
      const decided = await decisions.record(owner, { commandId: cid("dec"), projectId: a, category: "decision", topic: "database", statement: "Use PostgreSQL", wording: "We will use PostgreSQL", source: { channel: "direct" }, basedOn: 0 } as never);
      const decisionId = (decided as { id: string }).id;
      const planted = (id: string) => ({ id: `lnk-${id}`, subject: { kind: "plan", id }, decisionId, version: 1, topic: "database", state: "current", linkedBy: ann.id, linkedAt: options.clock() });
      const empt = (await world.storage.getAggregate({ kind: "desk-record", id: empty }))!;
      const task = (await world.storage.getAggregate({ kind: "task", id: ta }))!;
      const filler = Array.from({ length: 1200 }, (_, i) => ({ type: "create" as const, ref: { kind: "decision-reliance", id: `drl-a-${String(i).padStart(5, "0")}` }, body: { links: [] } as never }));
      const changes = [
        { type: "update" as const, ref: { kind: "task", id: ta }, expectedRevision: task.revision, body: { ...task.body, state: "cancelled" } },
        { type: "update" as const, ref: { kind: "desk-record", id: empty }, expectedRevision: empt.revision, body: { ...empt.body, body: "" } },
        { type: "create" as const, ref: { kind: "decision-reliance", id: "drl-bad-1" }, body: { links: [null, 7, {}, { subject: null }, { subject: { kind: "plan", id: "" } }] } },
        { type: "create" as const, ref: { kind: "decision-reliance", id: "drl-bad-2" }, body: { links: "not a list" } },
        { type: "create" as const, ref: { kind: "decision-reliance", id: "drl-empty" }, body: { links: [planted(empty), planted("no-such-plan")] } },
        { type: "create" as const, ref: { kind: "decision-reliance", id: "drl-zzz-last" }, body: { links: [planted(far)] } },
        ...filler,
      ];
      for (let i = 0; i < changes.length; i += 100) await world.storage.applyOperation({ operationId: cid("op"), epoch: projects.epoch, actor: "owner:rob", correlationId: cid("co"), at: options.clock(), changes: changes.slice(i, i + 100), ...ops } as never);

      const made = await createBackup(world.storage, { root, kind: "manual", version: "t", now: () => LATER, leaveOut: { scratchDays: 30, transcriptDays: null, logDays: null } });
      const text = readFileSync(join(made.path, "aggregates.jsonl"), "utf8");
      assert.ok(text.includes("plan named on a late page 7701"), "a plan a late link names is kept");
      const emptyRow = text.split("\n").filter((l) => l.includes(`"${empty}"`)).map((l) => JSON.parse(l) as { body: string });
      assert.equal(emptyRow.length, 1, "the empty plan a link names is kept");
      assert.equal((JSON.parse(emptyRow[0]!.body) as { body: string }).body, "", "and kept as it is, still empty");
      assert.ok(!text.includes("an unlinked plan 7703"), "an unlinked plan is left out");
      assert.equal(made.manifest.contentScope!.referenceCheckComplete, true);
      const line = made.manifest.contentScope!.leftOut.find((l) => l.kind === "desk-record")!;
      assert.deepEqual([line.left, line.heldBack], [1, 2]);
      assert.match(made.manifest.contentScope!.text, /2 that matched were kept because .*a decision link refers to them/, "the owner is told a decision link is one of the reasons a record was kept");
      assert.ok(free.length > 0);

      // A snapshot whose rows of link records do not move past the cursor (always the first page): the read ends, the check is unfinished, and nothing is left out.
      const real = await world.storage.snapshot();
      try {
        const stuck: StorageSnapshot = {
          schemaVersion: real.schemaVersion,
          read: async (table, page) => real.read(table, table === "aggregates" && page.after?.["kind"] === "decision-reliance" && page.after["id"] !== "" ? { after: { kind: "decision-reliance", id: "" }, limit: page.limit } : page),
          close: async () => undefined,
        };
        const blind = await planLeaveOut(stuck, { scratchDays: 30, transcriptDays: null, logDays: null }, LATER);
        const record = blind.record();
        assert.equal(record.referenceCheckComplete, false);
        assert.match(record.text, /decision link.*nothing was left out/);
        assert.equal(blind.decide({ kind: "desk-record", id: free } as never), "keep", "the unlinked plan is kept when the check did not finish");
        const seen = await planLeaveOut(real, { scratchDays: 30, transcriptDays: null, logDays: null }, LATER);
        assert.equal(seen.decide({ kind: "desk-record", id: free } as never), "omit", "and left out when it finished");
      } finally { await real.close(); }
    } finally { await world.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  });
}
