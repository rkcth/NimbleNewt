import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { after, test } from "node:test";
import { BlockerService } from "../domain/blockers.js";
import { WaitService } from "../domain/waits.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { QuotaMeter, RetentionService, RetentionSettingsService } from "../retention/index.js";
import { TaskCredentialService } from "../security/index.js";
import { StatusService } from "../status/index.js";
import { cid, openWorld, options } from "./testing/harness.js";

// Card K06d, review: the owner's free-word questions reach the real retention service through the chat (a scripted interpreter stands in for the model),
// on every storage backend; the agent, a viewer and a task credential get nothing, from the chat or from status.ask.

after(stopServer);

const ask = (text: string) => ({ kind: "status", request: { kind: "retention" }, evidence: text, basis: "owner" });
const DAY = 86_400_000;

for (const backend of backends) {
  test(`${backend.name}: K06d through the chat: room, quotas near their limit, the backups kept by name and what retention deleted lately, for the owner only`, async () => {
    const script: Record<string, unknown> = {};
    const t0 = Date.parse("2026-11-01T00:00:00.000Z");
    // Twelve backups, one a day; one cannot be trusted. Listed oldest first, as a store might.
    const kept = Array.from({ length: 12 }, (_, i) => ({ path: `/b/${i}`, at: new Date(t0 + i * DAY).toISOString(), trusted: i !== 10, manifest: { name: `nn-2026-11-${String(i + 1).padStart(2, "0")}`, kind: "nightly" } }));
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
      const project = await w.project("Garden");
      const task = await w.task(project, "Weed the beds");
      const ann = await w.agent("ann", [{ action: "*", project: "*" }]);
      // Stored text over a project quota's warning level, a deletion by request and a confirmed run.
      for (let i = 0; i < 3; i++) await w.desks.write(ann.principal, { commandId: cid("w"), projectId: project, kind: "note", title: `n${i}`, body: "x".repeat(400), visibility: "shared" } as never);
      const doomed = await w.desks.write(ann.principal, { commandId: cid("w"), projectId: project, kind: "note", title: "gone", body: "secret-words-in-the-record", visibility: "shared" } as never);
      await settings.set(w.owner, { commandId: cid("s"), quotaProjectBytes: 2000, quotaWarnPercent: 50 });
      const del = await retention.delete(w.owner, { commandId: cid("d"), recordId: doomed.id, reason: "typed-reason-words" });
      assert.equal(del.status, "deleted", JSON.stringify(del));
      const preview = await retention.run(w.owner, { dryRun: true });
      await retention.run(w.owner, { dryRun: false, confirm: preview.digest!, commandId: cid("r") });

      // The owner asks in free words; each question is answered from the one view, every line citing a record, nothing written.
      const audit = async () => (await w.world.storage.listAudit({ afterSeq: 0, limit: 1000 })).filter((x) => !x.type.startsWith("chat.")).length;
      const before = await audit();
      const questions = ["how much room is left?", "which of my quotas are close to their limit", "which backups do we keep", "what has retention deleted lately"];
      for (const text of questions) script[text] = [ask(text)];
      for (const text of questions) {
        const r = await chat.submit(w.ownerToken, { messageId: cid("m"), text });
        const o = r.outcomes[0]!;
        assert.equal(o.status, "answered", JSON.stringify(o));
        assert.ok(o.lines!.length > 0 && o.lines!.every((l) => l.cites.length > 0), "every line cites a record");
        const said = o.lines!.map((l) => l.text).join("\n");
        // Room.
        assert.match(said, /The data disk has .* free of .*% free\)\./);
        // Quotas near their limit, by project ID.
        assert.ok(said.includes(`Project ${project} is at `) && /% of its storage quota/.test(said), said);
        // Backups kept: the latest, then the others newest first by name, the untrusted one marked, the rest counted; each named one cited.
        assert.match(said, /12 backups are kept \(1 cannot be trusted\)/);
        assert.match(said, /The latest backup is nn-2026-11-12, made 2026-11-12T00:00:00\.000Z\./);
        const also = o.lines!.find((l) => l.text.startsWith("Also kept, newest first: "));
        assert.ok(also !== undefined, said);
        const listed = [...also.text.matchAll(/nn-2026-11-\d\d/g)].map((m) => m[0]);
        assert.ok(listed.length >= 5, also.text);
        assert.deepEqual(listed, Array.from({ length: listed.length }, (_, i) => `nn-2026-11-${String(11 - i).padStart(2, "0")}`), "newest first, after the latest");
        assert.ok(also.text.includes("nn-2026-11-11, made 2026-11-11T00:00:00.000Z (it cannot be trusted)"), also.text);
        assert.ok(also.text.endsWith(`; and ${12 - 1 - listed.length} older.`), also.text);
        assert.deepEqual(also.cites.map((c) => c.id), listed);
        // All of it inside what the chat shows (its first 30 lines), with the values after it.
        assert.equal(o.moreLines, undefined, `nothing cut: ${o.lines!.length} lines`);
        assert.match(said, /Retention values in force[\s\S]*Set by you: quotaProjectBytes: 2000; quotaWarnPercent: 50\./);
        // What retention deleted lately: the deletion by record ID and the run with its counts.
        assert.ok(said.includes(`of record ${doomed.id}: deleted`), said);
        assert.match(said, /Retention run .* \(by you\), .*record\(s\) removed/);
        // IDs and counts only: no stored words and no typed reason.
        assert.doesNotMatch(said, /secret-words|typed-reason/);
      }
      assert.equal(await audit(), before, "asking wrote nothing");

      // Nobody else gets anything: not from the chat, not from status.ask.
      const zed = await w.agent("zed", []);
      await w.principals.enroll(w.owner, { commandId: cid("e"), kind: "client", name: "viewer", grants: [] } as never);
      const viewer = (await w.principals.issueCredential(w.owner, "client:viewer")).token;
      const credentials = TaskCredentialService.withEpoch(w.world.storage, w.projects.epoch, options);
      const scoped = (await credentials.issue(w.owner, { commandId: cid("tc"), taskId: task, agentId: "agent:ann" })).token;
      for (const [who, token] of [["agent granted everything", ann.token], ["agent with no grants", zed.token], ["viewer", viewer], ["task credential", scoped]] as const) {
        script[`room for ${who}`] = [ask(`room for ${who}`)];
        const viaChat = await chat.submit(token, { messageId: cid("m"), text: `room for ${who}` }).then((r) => JSON.stringify(r), (e: Error & { code?: string }) => `refused ${e.code ?? "?"}`);
        assert.match(viaChat, /^refused (forbidden|unauthorized|unauthenticated)$/, `${who}: ${viaChat}`);
        const viaApi = JSON.stringify(await w.api.handle(token, { v: 1, op: "status.ask", args: { request: { kind: "retention" } } } as never));
        assert.doesNotMatch(viaApi, /data disk|quota|Backup kept|nn-2026|Deletion|Retention run|Retention values/i, `${who}: ${viaApi}`);
        const direct = JSON.stringify(await w.api.handle(token, { v: 1, op: "retention.status", args: {} } as never));
        assert.doesNotMatch(direct, /nn-2026|freeBytes|deletions/, `${who}: ${direct}`);
      }
      // An owner principal narrowed to one task is not the owner for this view either.
      const narrowed = { ...w.owner, taskScope: { taskId: task, projectId: project } } as never;
      assert.equal(await status.ask(narrowed, { kind: "retention" }), undefined);
    } finally { await w.close(); }
  });
}
