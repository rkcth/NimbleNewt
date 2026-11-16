import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { after, test } from "node:test";
import { BlockerService } from "../domain/blockers.js";
import { WaitService } from "../domain/waits.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { QuotaMeter, RetentionService, RetentionSettingsService, unguarded } from "../retention/index.js";
import { StatusService } from "../status/index.js";
import { CHAT_LIMITS } from "./interpreter.js";
import { replyOf } from "./chat.js";
import { cid, openWorld, options } from "./testing/harness.js";

// Card K06d, second review: the owner's questions through the real chat path with a large installation (many projects with long names, agents with the longest names,
// quotas near their limits in both classes, 50 backups, many deletions and runs). The four things the card names must be inside the 30 lines the chat shows, nothing
// may be cut without the owner being told, and no project name, stored word or typed reason may show. Then a damaged setting is told in chat words and repaired from chat.

after(stopServer);

const ask = (text: string) => ({ kind: "status", request: { kind: "retention" }, evidence: text, basis: "owner" });
const HOUR = 3_600_000;

for (const backend of backends) {
  test(`${backend.name}: K06d with a large installation: room, quotas near their limit, backups kept and recent deletions all fit what the chat shows, nothing is lost silently`, async () => {
    const script: Record<string, unknown> = {};
    const t0 = Date.parse("2026-09-01T03:00:00.000Z");
    // 50 backups, twice a day, a few untrusted, with long names; listed in no particular order.
    const kept = Array.from({ length: 50 }, (_, i) => ({ path: `/b/${i}`, at: new Date(t0 + i * 12 * HOUR).toISOString(), trusted: i % 7 !== 3, manifest: { name: `nimblenewt-backup-${new Date(t0 + i * 12 * HOUR).toISOString().replace(/[:.]/g, "-")}-${i % 2 === 0 ? "nightly" : "midday"}`, kind: "nightly" } }))
      .sort((a, b) => (a.path.length * 7 + Number(a.path.slice(3))) % 11 - (b.path.length * 7 + Number(b.path.slice(3))) % 11);
    let built: { retention: RetentionService; settings: RetentionSettingsService; status: StatusService } | undefined;
    const w = await openWorld(backend, script, undefined, (storage, epoch, { assignments, waits, contracts }) => {
      const settings = RetentionSettingsService.withEpoch(storage, epoch, options);
      const retention = RetentionService.withEpoch(storage, epoch, { settings, meter: new QuotaMeter(storage), dataDirectory: tmpdir(), backups: { list: async () => kept, preview: async () => [], prune: async () => [] } }, options);
      const status = StatusService.withEpoch(storage, epoch, { assignments, waits: waits ?? WaitService.withEpoch(storage, epoch, assignments, options), blockers: BlockerService.withEpoch(storage, epoch, options), contracts, retention: { status: (by) => retention.status(by), check: (by, ref) => retention.check(by, ref), settings: async (by) => { const g = await settings.get(by); return { revision: g.revision, settings: { ...g.settings }, effective: { ...g.effective } }; } } }, options);
      built = { retention, settings, status };
      return { status, retention };
    });
    try {
      const { retention, settings, status } = built!;
      const chat = w.chat({ status });
      const writers = await Promise.all(["a", "b", "c"].map((c) => w.agent(`${c}${"-long-agent-name".repeat(3)}`.slice(0, 40), [{ action: "*", project: "*" }])));
      assert.ok(writers.every((x) => x.principal.id.length === 46));
      const projects: string[] = [];
      for (let i = 0; i < 14; i++) projects.push(await w.project(`Private Orchard Project Name ${i}`));
      const records: { id: string }[] = [];
      for (const [i, p] of projects.entries()) {
        for (let k = 0; k < 3; k++) records.push(await w.desks.write(writers[(i + k) % 3]!.principal, { commandId: cid("w"), projectId: p, kind: "note", title: `note ${i}-${k}`, body: `stored-words-${i}-${k} ${"y".repeat(900 + i * 20)}`, visibility: "shared" } as never));
      }
      for (let i = 0; i < 8; i++) records.push(await w.desks.write(writers[i % 3]!.principal, { commandId: cid("w"), projectId: projects[i]!, kind: "note", title: `doomed ${i}`, body: `stored-words-doomed-${i}`, visibility: "shared" } as never));
      // Quotas near their limit: each project holds about 3 KiB of a 4 KiB quota; each agent about 14 KiB of 16 KiB. The owner also set several other values.
      await settings.set(w.owner, { commandId: cid("s"), quotaProjectBytes: 4096, quotaAgentBytes: 16384, quotaWarnPercent: 60, derivedDays: 400, generationRunDays: 90, backupDaily: 30, backupWeekly: 12, transcriptDays: 365, incidentArchiveDays: 60 });
      // Eight deletions by request with typed reasons, and six confirmed runs.
      for (let i = 0; i < 8; i++) {
        const del = await retention.delete(w.owner, { commandId: cid("d"), recordId: records[42 + i]!.id, reason: `typed-reason-${i} the customer asked` });
        assert.equal(del.status, "deleted", JSON.stringify(del));
      }
      for (let i = 0; i < 6; i++) {
        const preview = await retention.run(w.owner, { dryRun: true });
        await retention.run(w.owner, { dryRun: false, confirm: preview.digest!, commandId: cid("r") });
      }

      const questions = ["how much room is left?", "which of my quotas are close to their limit", "which backups do we keep", "what has retention deleted lately"];
      for (const text of questions) script[text] = [ask(text)];
      const r = await chat.submit(w.ownerToken, { messageId: cid("m"), text: questions[0]! });
      const o = r.outcomes[0]!;
      assert.equal(o.status, "answered", JSON.stringify(o));
      const lines = o.lines!;
      const said = lines.map((l) => l.text).join("\n");
      assert.ok(lines.length <= CHAT_LIMITS.statusLines);
      assert.ok(lines.every((l) => l.cites.length > 0), "every line cites a record");
      // 1. Room left.
      assert.match(said, /The data disk has .* free of .*% free\)\./);
      // 2. Quotas near their limit, both classes, the ones not listed counted.
      assert.match(said, /^Project proj-\S+ is at \d+% of its storage quota/m);
      assert.match(said, /^Agent agent:[a-c]-long-agent-name\S* is at \d+% of its storage quota/m);
      assert.match(said, /^\d+ more scope\(s\) are near their quota and not listed\.$/m);
      // 3. Backups kept: the count, the latest and the others by name.
      assert.match(said, /^50 backups are kept \(7 cannot be trusted\)/m);
      assert.match(said, /^The latest backup is nimblenewt-backup-2026-09-25T15-00-00-000Z-midday, made 2026-09-25T15:00:00\.000Z/m);
      assert.match(said, /^Also kept, newest first: nimblenewt-backup-2026-09-25T03-00-00-000Z-nightly, .*; and \d+ older\.$/m);
      // 4. Recent deletions and runs, the older ones counted.
      assert.equal(lines.filter((l) => l.text.startsWith("Deletion ")).length, 5);
      assert.match(said, /^3 older deletion\(s\) are not listed\.$/m);
      assert.ok(lines.some((l) => l.text.startsWith("Retention run ")));
      // Nothing cut silently: either it all fits, or the owner is told how many lines were not shown.
      const reply = replyOf(r.outcomes).join("\n");
      if (o.moreLines !== undefined) assert.match(reply, new RegExp(`${o.moreLines} more lines? not shown`));
      // The values the owner set are in the answer too (they are not reachable another way in chat).
      assert.equal(o.moreLines, undefined, `nothing cut; the answer had ${lines.length + (o.moreLines ?? 0)} lines:\n${said}`);
      assert.match(said, /^Set by you: /m); assert.match(said, /quotaProjectBytes: 4096/);
      // No project name, stored word or typed reason.
      assert.doesNotMatch(reply, /Private Orchard|stored-words|typed-reason|customer asked/);
      // The other three questions get the same answer.
      for (const text of questions.slice(1)) {
        const again = (await chat.submit(w.ownerToken, { messageId: cid("m"), text })).outcomes[0]!;
        assert.equal(again.status, "answered");
        assert.equal(again.lines!.length, lines.length);
      }

      // A damaged setting: the owner is told in chat words what to do (no API operation name), and setting a value from chat repairs it.
      const raw = unguarded(w.world.storage); const realGet = raw.getAggregate.bind(raw);
      let damaged = true;
      raw.getAggregate = async (ref) => { const a = await realGet(ref); return damaged && ref.kind === "retention-settings" && a !== undefined ? { ...a, body: { values: { derivedDays: "soon" } } } as never : a; };
      script["is there room left"] = [ask("is there room left")];
      const bad = (await chat.submit(w.ownerToken, { messageId: cid("m"), text: "is there room left" })).outcomes[0]!;
      assert.equal(bad.status, "answered", JSON.stringify(bad));
      const badText = bad.lines!.map((l) => l.text).join("\n");
      assert.match(badText, /damaged/);
      assert.doesNotMatch(badText, /retention\.settings\.set|\(\w+\.\w+/, "chat words, not an API name");
      assert.match(badText, /Setting any retention value writes it again/);
      await settings.set(w.owner, { commandId: cid("s"), backupDaily: 14 });
      damaged = false;
      const fixed = (await chat.submit(w.ownerToken, { messageId: cid("m"), text: "is there room left" })).outcomes[0]!;
      assert.match(fixed.lines!.map((l) => l.text).join("\n"), /The data disk has /);
    } finally { await w.close(); }
  });
}
