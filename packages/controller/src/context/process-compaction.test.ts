import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import { openWorld, cid, options } from "../chat/testing/harness.js";
import { BlockerService } from "../domain/blockers.js";
import { DomainError } from "../domain/errors.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { ContextEnforcementService, LINEAGE_KEEP, lineageDigest, type SourceRef } from "./index.js";
import { PROCESS_SUMMARY_KIND } from "./enforcement.js";

after(stopServer);

/**
 * Card C07q (the process's own compactions): the task's process compacts its own conversation and tells the controller how much and the digest of its summary. Each such compaction takes its place in the
 * task's chain, so the lineage is real and bounded, the owner's pinned decisions are carried on, and a controller compaction can follow one. Real services on every storage backend.
 */
const digestOf = (n: number): string => createHash("sha256").update(`summary ${n}`).digest("hex");

for (const backend of backends) {
  test(`${backend.name}: the process's own compactions join the task's chain, bounded, with the pinned decisions carried on`, async () => {
    const w = await openWorld(backend);
    try {
      const st = w.world.storage, epoch = w.projects.epoch;
      const blockers = BlockerService.withEpoch(st, epoch, options);
      const enf = ContextEnforcementService.withEpoch(st, epoch, { blockers, retrieval: w.retrieval }, options);
      const a = await w.project("A");
      const t = await w.task(a, "a long task");
      const ann = (await w.agent("ann", [{ action: "attempt.work", project: a }, { action: "desk.write", project: a }, { action: "desk.read", project: a }])).principal;
      const dec = await w.decisions.record(w.owner, { commandId: cid("dec"), projectId: a, category: "decision", topic: "review", statement: "Always reviewed", wording: "Never merge without a second review.", source: { channel: "direct" }, basedOn: 0 } as never) as { recorded: boolean; id: string };
      assert.equal(dec.recorded, true);
      const pinned: SourceRef = { kind: "owner-decision", id: dec.id };
      const src: SourceRef = { kind: "desk-record", id: (await w.desks.write(ann, { commandId: cid("w"), projectId: a, kind: "note", title: "notes", body: "talk", visibility: "shared", status: "accepted" })).id };

      // A first compaction by the controller pins the decision; the process's compactions follow it.
      await enf.registerCompressor(w.owner, { taskId: t, compressorId: "pi-before-compact" });
      const first = await enf.compact(w.owner, { taskId: t, attemptId: "att-1", key: "k1", compressorId: "pi-before-compact", title: "first", material: "Talk about modules. ".repeat(60), sources: [src], pinned: [pinned] }, []);
      assert.equal(first.kind, "summary");
      if (first.kind !== "summary") return;
      const ids = [first.id];
      for (let n = 1; n <= 60; n++) {
        const out = await enf.recordProcessCompaction(w.owner, { taskId: t, attemptId: "att-1", key: `pc${n}`, messageCount: 10 + n, summaryChars: 900 + n, digest: digestOf(n) });
        assert.equal(out.replayed, false);
        assert.equal(out.generation, n + 1, `process compaction ${n} is generation ${n + 1}`);
        assert.ok(out.lineage.length <= LINEAGE_KEEP);
        assert.equal(out.lineage.length + (out.earlier?.count ?? 0), n, "the listed and folded compactions account for every earlier one");
        assert.deepEqual(out.lineage, ids.slice(-LINEAGE_KEEP));
        ids.push(out.id);
      }
      const head = (await enf.latestCompaction(w.owner, t))!;
      assert.deepEqual([head.id, head.generation, head.lineage.length, head.earlier?.count], [ids[60], 61, LINEAGE_KEEP, 60 - LINEAGE_KEEP]);
      // The folded part reads back and matches its digest.
      const page = (await enf.earlierLineage(w.owner, { taskId: t, limit: 100 }))!;
      const older = [...page.ids].reverse();
      assert.deepEqual(older, ids.slice(0, 60 - LINEAGE_KEEP));
      assert.equal(head.earlier!.digest, lineageDigest(older));

      // The pinned decision is carried through every process compaction; its wording is whole.
      const kept = await enf.keptDecisions(w.owner, t);
      assert.deepEqual(kept.map((k) => [k.source, k.state]), [[pinned, "available"]]);
      assert.ok(kept[0]!.text?.includes("Never merge without a second review."));

      // The record says what the controller knows and nothing more: the note, not the text; no retrieval summary exists for it.
      const rec = (await enf.getCompaction(w.owner, ids[60]!))!;
      assert.deepEqual(rec.process, { messageCount: 70, summaryChars: 960, digest: digestOf(60) });
      assert.equal(rec.summaryId, undefined);
      assert.equal(await enf.readSummary(w.owner, ids[60]!), undefined);
      // The owner is told plainly that this is a plain extract, not a model's summary (a process only reports a compaction it made with the extractive hook): the record says degraded, its title and its stored note say extractive.
      assert.equal(rec.degraded, true);
      assert.match(rec.title, /\(70 messages, extractive\)$/);
      const stored = (await st.getAggregate({ kind: "ctx-compaction", id: ids[60]! }))!.body as unknown as { summary: string };
      assert.ok(stored.summary.startsWith(PROCESS_SUMMARY_KIND), stored.summary);
      assert.match(stored.summary, /made without a model.*details from the middle may be missing/);

      // The same key is the same compaction: answered from the record, nothing added.
      const again = await enf.recordProcessCompaction(w.owner, { taskId: t, attemptId: "att-1", key: "pc60", messageCount: 70, summaryChars: 960, digest: digestOf(60) });
      assert.deepEqual([again.id, again.replayed, again.generation], [ids[60], true, 61]);
      assert.equal((await enf.latestCompaction(w.owner, t))!.id, ids[60]);

      // A controller compaction continues the chain after the process's.
      const next = await enf.compact(w.owner, { taskId: t, attemptId: "att-2", key: "k2", compressorId: "pi-before-compact", title: "second", material: "More talk about modules. ".repeat(60), sources: [src], parent: ids[60]! }, []);
      assert.equal(next.kind, "summary");
      if (next.kind === "summary") assert.equal(next.generation, 62);

      // Refused: a bad digest, a negative count, an unknown field, a key that names the controller's own compaction, a task nobody may work on.
      const bad = async (command: Record<string, unknown>, who = w.owner): Promise<unknown> => { try { await enf.recordProcessCompaction(who, { taskId: t, attemptId: "att-1", key: "bad", messageCount: 1, summaryChars: 1, digest: digestOf(1), ...command } as never); return "accepted"; } catch (error) { return error instanceof DomainError ? error.code : error; } };
      assert.equal(await bad({ digest: "xyz" }), "invalid_command");
      assert.equal(await bad({ messageCount: -1 }), "invalid_command");
      assert.equal(await bad({ summaryChars: 1.5 }), "invalid_command");
      assert.equal(await bad({ extra: 1 }), "invalid_command");
      assert.equal(await bad({ key: "k1" }), "invalid_command");
      assert.equal(await bad({}, ann), "forbidden");
    } finally { await w.close(); }
  });

  test(`${backend.name}: two process compactions reported at once both join the chain, or the later is closed as superseded`, async () => {
    const w = await openWorld(backend);
    try {
      const st = w.world.storage, epoch = w.projects.epoch;
      const blockers = BlockerService.withEpoch(st, epoch, options);
      const enf = ContextEnforcementService.withEpoch(st, epoch, { blockers, retrieval: w.retrieval }, options);
      const a = await w.project("A");
      const t = await w.task(a, "a long task");
      const results = await Promise.all([1, 2, 3].map((n) => enf.recordProcessCompaction(w.owner, { taskId: t, attemptId: `att-${n}`, key: `pc${n}`, messageCount: n, summaryChars: n, digest: digestOf(n) })));
      const joined = results.filter((r) => r.superseded !== true);
      assert.ok(joined.length >= 1);
      // The chain is a line: the generations that joined are distinct and run from 1, and the latest is the highest.
      const gens = joined.map((r) => r.generation).sort((x, y) => x - y);
      assert.deepEqual(gens, gens.map((_, i) => i + 1));
      assert.equal((await enf.latestCompaction(w.owner, t))!.generation, joined.length);
    } finally { await w.close(); }
  });
  test(`${backend.name}: a compaction that finishes between the read of the chain's head and the write is met by a retry against the new head (C07q review)`, async () => {
    const w = await openWorld(backend);
    try {
      const st = w.world.storage, epoch = w.projects.epoch;
      const blockers = BlockerService.withEpoch(st, epoch, options);
      const plain = ContextEnforcementService.withEpoch(st, epoch, { blockers, retrieval: w.retrieval }, options);
      const a = await w.project("A");
      const t = await w.task(a, "a long task");
      // The storage the racing service reads: the first read of the chain's head is answered as it was, and only then does another compaction of the task finish.
      let armed = false, raced: string | undefined;
      const racing = new Proxy(st, { get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (prop !== "getAggregate") return typeof value === "function" ? (value as (...x: unknown[]) => unknown).bind(target) : value;
        return async (ref: { kind: string; id: string }) => {
          const found = await (value as (r: unknown) => Promise<unknown>).call(target, ref);
          if (armed && ref.kind === "ctx-chain") { armed = false; raced = (await plain.recordProcessCompaction(w.owner, { taskId: t, attemptId: "att-1", key: "other", messageCount: 1, summaryChars: 1, digest: digestOf(1) })).id; }
          return found;
        };
      } });
      const enf = ContextEnforcementService.withEpoch(racing, epoch, { blockers, retrieval: w.retrieval }, options);
      armed = true;
      const out = await enf.recordProcessCompaction(w.owner, { taskId: t, attemptId: "att-1", key: "mine", messageCount: 2, summaryChars: 2, digest: digestOf(2) });
      assert.ok(raced !== undefined, "the other compaction finished in between");
      assert.deepEqual([out.superseded, out.generation, out.lineage], [undefined, 2, [raced]], "it continues the compaction that finished first");
      assert.equal((await plain.latestCompaction(w.owner, t))!.id, out.id);
    } finally { await w.close(); }
  });
}
