import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { after, test } from "node:test";
import { BlockerService } from "../domain/blockers.js";
import { WaitService } from "../domain/waits.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { OPERATIONS } from "../api/operations.js";
import { QuotaMeter, RetentionService, RetentionSettingsService } from "../retention/index.js";
import { StatusService, STATUS_KINDS } from "../status/index.js";
import { CHAT_LIMITS } from "./interpreter.js";
import { ModelInterpreter } from "./model-interpreter.js";
import { replyOf } from "./chat.js";
import { cid, openWorld, options } from "./testing/harness.js";

// Card K06e: the owner asks in free words how much room the logs and messages take and what retention removed of them; the answer stays within the 30 lines the chat shows, and the interpreter prompt says so.

after(stopServer);

const ask = (text: string) => ({ kind: "status", request: { kind: "retention" }, evidence: text, basis: "owner" });
const DAY = 86_400_000;
const NOW = Date.parse(options.clock());
const SECRET = "words-between-agents-that-must-not-be-repeated";

test("the interpreter prompt describes the bulk-log view and the new setting from the one status-kind table and the one operation table (card K06e)", async () => {
  let system = "";
  const m = new ModelInterpreter({ complete: async (_route, r) => { system = r.system; return "[]"; } }, () => ["a/primary"]);
  await m.interpret({ text: "how much room do the message logs use", quoted: [], focus: {}, proposals: [] });
  const kind = STATUS_KINDS["retention"]!;
  assert.ok(system.includes(`retention(${kind.keys.join(", ")}) - ${kind.about}`), "listed from the one table");
  for (const word of ["how much room the logs and messages use", "messages sent to the owner, messages between agents, recorded model replies", "how many of its records the last runs removed"]) assert.ok(kind.about.includes(word), word);
  const set = OPERATIONS.find((o) => o.name === "retention.settings.set")!;
  assert.ok(set.summary.includes("`agentMessageDays`"), "the setting is described");
  assert.ok(system.includes("agentMessageDays"), "the prompt carries it");
  assert.ok(OPERATIONS.find((o) => o.name === "status.ask")!.summary.includes("the room each bulk log"), "the status.ask summary says the same");
});

for (const backend of backends) {
  const scenario = (name: string, many: boolean) => test(`${backend.name}: ${name}`, async () => {
    const script: Record<string, unknown> = {};
    let built: { retention: RetentionService; settings: RetentionSettingsService; status: StatusService } | undefined;
    const w = await openWorld(backend, script, undefined, (storage, epoch, { assignments, waits, contracts }) => {
      const settings = RetentionSettingsService.withEpoch(storage, epoch, options);
      const retention = RetentionService.withEpoch(storage, epoch, { settings, meter: new QuotaMeter(storage), dataDirectory: tmpdir() }, options);
      const status = StatusService.withEpoch(storage, epoch, { assignments, waits: waits ?? WaitService.withEpoch(storage, epoch, assignments, options), blockers: BlockerService.withEpoch(storage, epoch, options), contracts, retention: { status: (by) => retention.status(by), check: (by, ref) => retention.check(by, ref), settings: async (by) => { const g = await settings.get(by); return { revision: g.revision, settings: { ...g.settings }, effective: { ...g.effective } }; } } }, options);
      built = { retention, settings, status };
      return { status, retention };
    });
    try {
      const { retention, settings, status } = built!;
      const storage = w.world.storage; const epoch = w.projects.epoch;
      const put = async (kind: string, id: string, body: object, daysAgo: number): Promise<void> => {
        await storage.applyOperation({ operationId: `put-${kind}-${id}`, epoch, actor: "test", correlationId: "put", at: new Date(NOW - daysAgo * DAY).toISOString(), changes: [{ type: "create", ref: { kind, id }, body: body as never }], audit: [{ type: "test.put", subject: { kind, id }, detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
      };
      const msg = { taskId: "task-a", projectId: "proj-a", sender: "agent:x", to: "agent:y", kind: "notice", purpose: "p", text: SECRET, class: "advice", effectiveClass: "advice", state: "answered" };
      for (let i = 0; i < 4; i++) await put("agent-message", `amg-old-${i}`, msg, 100);
      await put("agent-message", "amg-young", msg, 3);
      for (let i = 0; i < 2; i++) await put("notification-delivery", `ndl-old-${i}`, { subject: { kind: "item", id: "x" }, channel: "mail", text: SECRET, attempts: 1, state: "delivered" }, 100);
      await put("generation-run", "gen-old", { state: "complete", projectId: "proj-a", text: SECRET }, 100);
      const questions = ["how much room do the message logs use?", "what did retention remove of the messages", "how big are my logs"];
      for (const text of questions) script[text] = [ask(text)];
      const lines = async (text: string) => { const r = await w.chat({ status }).submit(w.ownerToken, { messageId: cid("m"), text }); const o = r.outcomes[0]!; assert.equal(o.status, "answered", JSON.stringify(o)); return { o, said: o.lines!.map((l) => l.text).join("\n"), reply: replyOf(r.outcomes).join("\n") }; };

      // Before any rule is set: the room is told, and the answer says the kind is kept.
      const first = await lines(questions[0]!);
      assert.match(first.said, /^Bulk logs, one after the other: .*messages between agents: 5 record\(s\), [\d.]+ (bytes|KiB), kept \(no retention is set\), 0 removed by the last 0 retention run\(s\)/m);
      assert.match(first.said, /messages sent to you: 2 record\(s\), /);
      assert.match(first.said, /recorded model replies: 1 record\(s\), /);

      await settings.set(w.owner, { commandId: cid("s"), agentMessageDays: 60, deliveryLogDays: 30, generationRunDays: 90 });
      const preview = await retention.run(w.owner, { dryRun: true });
      assert.equal(preview.candidates.length, 7);
      await retention.run(w.owner, { dryRun: false, confirm: preview.digest!, commandId: cid("r") });
      const after = await lines(questions[1]!);
      assert.match(after.said, /messages between agents: 1 record\(s\), [\d.]+ (bytes|KiB), removed 60 days after their last change, 4 removed by the last 1 retention run\(s\)/);
      assert.match(after.said, /messages sent to you: 0 record\(s\), 0 bytes, removed 30 days after their last change, 2 removed by the last 1 retention run\(s\)/);
      assert.match(after.said, /recorded model replies: 0 record\(s\), 0 bytes, removed 90 days after their last change, 1 removed by the last 1 retention run\(s\)/);
      assert.match(after.said, /^Retention run \S+ \(by you\), .*: 7 record\(s\) removed/m);
      assert.ok(after.o.lines!.every((l) => l.cites.length > 0), "every line cites a record");
      assert.ok(after.o.lines!.length <= CHAT_LIMITS.statusLines);
      assert.doesNotMatch(after.reply, new RegExp(SECRET), "no stored word is repeated");

      if (many) {
        // A large installation: many scopes near their quota, many deletions, many runs; the answer still fits what the chat shows, the longer lists are shortened with a count, and the bulk-log lines are all there.
        const writers = await Promise.all(["a", "b", "c"].map((c) => w.agent(`${c}-writer`, [{ action: "*", project: "*" }])));
        const records: { id: string }[] = [];
        for (let i = 0; i < 14; i++) { const p = await w.project(`Project ${i}`); for (let k = 0; k < 3; k++) records.push(await w.desks.write(writers[(i + k) % 3]!.principal, { commandId: cid("w"), projectId: p, kind: "note", title: `n ${i}-${k}`, body: `body ${"y".repeat(900)}`, visibility: "shared" } as never)); }
        await settings.set(w.owner, { commandId: cid("s"), quotaProjectBytes: 4096, quotaAgentBytes: 16384, quotaWarnPercent: 60, backupDaily: 30, backupWeekly: 12, transcriptDays: 365, incidentArchiveDays: 60 });
        for (let i = 0; i < 8; i++) assert.equal((await retention.delete(w.owner, { commandId: cid("d"), recordId: records[i]!.id, reason: `reason ${i}` })).status, "deleted");
        for (let i = 0; i < 6; i++) { const pv = await retention.run(w.owner, { dryRun: true }); await retention.run(w.owner, { dryRun: false, confirm: pv.digest!, commandId: cid("r") }); }
        const big = await lines("how big are my logs");
        assert.ok(big.o.lines!.length <= CHAT_LIMITS.statusLines);
        assert.equal(big.o.moreLines, undefined, `nothing cut:\n${big.said}`);
        for (const label of ["messages sent to you", "messages between agents", "recorded model replies"]) assert.match(big.said, new RegExp(`${label}: `));
        assert.match(big.said, /^\d+ older deletion\(s\) are not listed\.$/m);
        assert.match(big.said, /^\d+ more scope\(s\) are near their quota and not listed\.$/m);
      }
    } finally { await w.close(); }
  });
  scenario("the owner asks how much room the logs and messages use and what retention removed of them; the figures come from the real records and the real runs, every line cites a record, no stored word is repeated (card K06e)", false);
  scenario("with a large installation the answer stays within the lines the chat shows, the bulk-log lines kept and the longer lists shortened with a count (card K06e)", true);
}

// Review (K06e): runs recorded before the per-kind counts. One whose ID list is whole is counted from the list; one that removed more than it lists does not say what it removed of each kind, and the line says so rather than "0 removed".
for (const backend of backends) {
  test(`${backend.name}: a run recorded before the per-kind counts is not told as 0 removed of a bulk log when it does not say (card K06e review)`, async () => {
    const script: Record<string, unknown> = {};
    let built: { status: StatusService } | undefined;
    let cannedBulk: object[] | undefined;
    const w = await openWorld(backend, script, undefined, (storage, epoch, { assignments, waits, contracts }) => {
      const settings = RetentionSettingsService.withEpoch(storage, epoch, options);
      const retention = RetentionService.withEpoch(storage, epoch, { settings, meter: new QuotaMeter(storage), dataDirectory: tmpdir() }, options);
      const status = StatusService.withEpoch(storage, epoch, { assignments, waits: waits ?? WaitService.withEpoch(storage, epoch, assignments, options), blockers: BlockerService.withEpoch(storage, epoch, options), contracts, retention: { status: async (by) => { const st = await retention.status(by); return cannedBulk === undefined ? st : { ...st, bulkLogs: cannedBulk as never }; }, check: (by, ref) => retention.check(by, ref), settings: async (by) => { const g = await settings.get(by); return { revision: g.revision, settings: { ...g.settings }, effective: { ...g.effective } }; } } }, options);
      built = { status };
      return { status, retention };
    });
    try {
      const { status } = built!;
      const storage = w.world.storage; const epoch = w.projects.epoch;
      const run = async (id: string, body: object, daysAgo: number): Promise<void> => {
        const at = new Date(NOW - daysAgo * DAY).toISOString();
        await storage.applyOperation({ operationId: `put-${id}`, epoch, actor: "test", correlationId: "put", at, changes: [{ type: "create", ref: { kind: "retention-run", id }, body: { at, by: w.owner.id, auto: false, ...body } as never }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
      };
      const lines = async (text: string) => { script[text] = [ask(text)]; const r = await w.chat({ status }).submit(w.ownerToken, { messageId: cid("m"), text }); const o = r.outcomes[0]!; assert.equal(o.status, "answered", JSON.stringify(o)); return o.lines!.map((l) => l.text).join("\n"); };
      // Only a run that removed 250 and lists 200: what it removed of each kind is not recorded, and the line says so.
      await run("rrn-cut", { removed: Array.from({ length: 200 }, (_, i) => `notification-delivery/ndl-x${i}`), removedCount: 250 }, 4);
      const cut = await lines("how much room do the logs use");
      assert.match(cut, /messages sent to you: 0 record\(s\), 0 bytes, kept \(no retention is set\), how many of them the last 1 retention run\(s\) removed is not recorded/);
      assert.doesNotMatch(cut, /\d+ removed by the last/, "no figure is given over a run that does not say");
      // A newer run whose list is whole: it is counted from its IDs, and the line says the other did not record it.
      await run("rrn-whole", { removed: ["notification-delivery/ndl-1", "notification-delivery/ndl-2"], removedCount: 2 }, 3);
      const mixed = await lines("how much room do the message logs take now");
      assert.match(mixed, /messages sent to you: [^/]*, 2 removed by the last 1 retention run\(s\); 1 other run\(s\) did not record it by kind/);
      assert.doesNotMatch(mixed, /removed by the last 2 retention run\(s\)/, "no figure is given over a run that does not say");
      // A count cut short is told as a floor, never as the whole.
      cannedBulk = [{ kind: "agent-message", label: "messages between agents", setting: "agentMessageDays", days: 60, records: 50000, bytes: 4096, partial: true }];
      const floor = await lines("how much room do agent messages take");
      assert.match(floor, /messages between agents: 50000\+ record\(s\), 4\.0 KiB \(counting was cut short, so these figures are low\), removed 60 days after their last change/);
    } finally { await w.close(); }
  });
}
