import assert from "node:assert/strict";
import { after, test } from "node:test";
import { openWorld, cid, options } from "../chat/testing/harness.js";
import { ContinuationService, type ContinuationInput } from "../continuation/index.js";
import { BlockerService } from "../domain/blockers.js";
import { COMPACTION_KEEP, compactionKeep } from "../decisions/index.js";
import { DomainError } from "../domain/errors.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { ContextEnforcementService, ENFORCEMENT_LIMITS, LINEAGE_KEEP, lineageDigest, type SourceRef } from "./index.js";

after(stopServer);

/**
 * Card C07q: a task compacted 250 times, with the real decision, retrieval, enforcement and continuation services on every storage backend. The lineage each compaction keeps is bounded, the older part is
 * kept by a count, a digest and a reference that reads it back, every owner decision pinned along the way is still there whole after the last compaction, and a continuation captured after it is accepted.
 */
const COMPACTIONS = 250;
const DIGEST = `v1:sha256:${"a".repeat(64)}`;

for (const backend of backends) {
  test(`${backend.name}: 250 compactions keep a bounded lineage, every pinned owner decision, and a capture after them is accepted`, async () => {
    const w = await openWorld(backend);
    try {
      const st = w.world.storage, epoch = w.projects.epoch;
      const blockers = BlockerService.withEpoch(st, epoch, options);
      const enf = ContextEnforcementService.withEpoch(st, epoch, { blockers, retrieval: w.retrieval }, options);
      const continuations = ContinuationService.withEpoch(st, epoch, options);
      const a = await w.project("A");
      const t = await w.task(a, "a long-running task");
      await w.principals.enroll(w.owner, { commandId: cid("h"), kind: "host", name: "h1", grants: [] });
      const host = await w.principals.authenticate((await w.principals.issueCredential(w.owner, "host:h1")).token);
      const ann = (await w.agent("ann", [{ action: "attempt.work", project: a }, { action: "desk.write", project: a }, { action: "desk.read", project: a }, { action: "history.read", project: a }])).principal;
      // The owner's decisions, recorded in their own words (direct channel), one topic each: as many as a compaction keeps.
      const wordings: string[] = []; const pinned: SourceRef[] = [];
      for (let i = 0; i < ENFORCEMENT_LIMITS.pinned; i++) {
        const wording = `Decision ${i}: keep module ${i} on the reviewed branch and never merge it without a second review, whatever the deadline says.`;
        const r = await w.decisions.record(w.owner, { commandId: cid("dec"), projectId: a, category: "decision", topic: `topic-${i}`, statement: `Module ${i} stays reviewed`, wording, source: { channel: "direct" }, basedOn: 0 } as never) as { recorded: boolean; id: string };
        assert.equal(r.recorded, true);
        wordings.push(wording); pinned.push({ kind: "owner-decision", id: r.id });
      }
      const src: SourceRef = { kind: "desk-record", id: (await w.desks.write(ann, { commandId: cid("w"), projectId: a, kind: "note", title: "notes", body: "what was talked about", visibility: "shared", status: "accepted" })).id };
      await enf.registerCompressor(w.owner, { taskId: t, compressorId: "pi-before-compact" });
      const material = "The agents went over the modules, their branches and their reviews at length. ".repeat(40);

      const ids: string[] = []; const summaries: string[] = [];
      let latest: string | undefined;
      for (let n = 1; n <= COMPACTIONS; n++) {
        // The decisions are pinned over the first twelve compactions, one at each; every later compaction carries them on.
        const out = await enf.compact(w.owner, { taskId: t, attemptId: `att-${Math.ceil(n / 25)}`, key: `k${n}`, compressorId: "pi-before-compact", title: `summary ${n}`, material, sources: [src], ...(n <= pinned.length ? { pinned: [pinned[n - 1]!] } : {}), ...(latest === undefined ? {} : { parent: latest }) }, [{ route: "local", summarise: async () => `Summary ${n}: the modules stand as reviewed.` }]);
        assert.equal(out.kind, "summary", `compaction ${n}`);
        if (out.kind !== "summary") return;
        // Bounded at every step: never more than LINEAGE_KEEP listed, and the listed plus the folded are exactly the compactions before this one.
        assert.ok(out.lineage.length <= LINEAGE_KEEP, `compaction ${n} lists ${out.lineage.length}`);
        assert.equal(out.lineage.length + (out.earlier?.count ?? 0), n - 1, `compaction ${n} accounts for every earlier one`);
        assert.deepEqual(out.lineage, ids.slice(-LINEAGE_KEEP), `compaction ${n} lists the newest earlier ones in order`);
        ids.push(out.id); summaries.push(out.summaryId); latest = out.id;
      }

      // The older part is kept by reference: walked back from the latest compaction's `earlier`, it is every folded compaction, newest first, and its digest is the one recorded.
      const head = (await enf.latestCompaction(w.owner, t))!;
      assert.deepEqual([head.id, head.generation, head.lineage.length, head.earlier?.count], [latest, COMPACTIONS, LINEAGE_KEEP, COMPACTIONS - 1 - LINEAGE_KEEP]);
      const walked: string[] = [];
      let from: string | undefined;
      for (;;) {
        const page = (await enf.earlierLineage(w.owner, { taskId: t, ...(from === undefined ? {} : { from }), limit: 60 }))!;
        walked.push(...page.ids);
        if (page.next === undefined) break;
        from = page.next;
      }
      const older = [...walked].reverse();
      assert.deepEqual(older, ids.slice(0, COMPACTIONS - 1 - LINEAGE_KEEP), "the folded part reads back whole, in order");
      assert.equal(head.earlier!.digest, lineageDigest(older), "and matches the recorded digest");
      assert.equal(head.earlier!.through, older[older.length - 1]);
      assert.equal(await enf.earlierLineage((await w.agent("zed", [])).principal, { taskId: t }), undefined, "someone who may not work on the task reads nothing");

      // Every pinned owner decision is still kept after the 250th compaction, its wording whole, and the last summary names each one.
      const kept = await enf.keptDecisions(w.owner, t);
      assert.deepEqual(kept.map((k) => k.source), pinned);
      for (const [i, k] of kept.entries()) { assert.equal(k.state, "available"); assert.ok(k.text?.includes(wordings[i]!), `decision ${i} is kept whole`); }
      const last = (await enf.readSummary(w.owner, latest!)) as { text?: string } | undefined;
      const lastText = JSON.stringify(last ?? {});
      for (const p of pinned as { id: string }[]) assert.ok(lastText.includes(p.id), `the 250th summary names ${p.id}`);

      // A capture after 250 compactions is accepted: the whole lineage of summaries is folded to its newest 200 and a reference to the rest.
      const input = (summaryLineage: string[], extra: Partial<ContinuationInput["manifest"]> = {}): ContinuationInput => ({
        identity: "conv-ann-1", agent: "agent:ann", boundary: { kind: "turn-complete" }, checkpoint: { format: 2, conversationId: 7, at: 41, digest: DIGEST, runtime: { name: "pi-durable", version: "1.3.0" } }, durable: { verified: true },
        continuation: { artifacts: [], decisions: [], pendingEffects: [], budget: { spent: 1, remaining: 1, unit: "k-tokens" }, nextStep: "go on" },
        manifest: { summaryLineage, sourceRanges: [], compression: { state: "compacted", compactions: COMPACTIONS }, branches: [], messageCursor: 41, routingRevision: 1, environmentRevision: 1, adapter: { name: "pi-durable", version: "1.3.0" }, ...extra },
        nonCheckpointableTools: [], scratchRecords: [], credentialRefs: [] });
      const whole = await continuations.capture(host, { commandId: cid("cap"), taskId: t, ...input(summaries) });
      assert.equal(whole.status, "complete");
      const stored = (await continuations.latest(host, t))!;
      assert.deepEqual(stored.manifest.summaryLineage, summaries.slice(-200));
      assert.deepEqual(stored.manifest.summaryLineageEarlier, { count: COMPACTIONS - 200, digest: lineageDigest(summaries.slice(0, COMPACTIONS - 200)), through: summaries[COMPACTIONS - 201] });
      // The controller's own bounded form (its newest compactions and the reference to the rest) is accepted as it is.
      const bounded = await continuations.capture(host, { commandId: cid("cap"), taskId: t, ...input([...head.lineage, head.id], { summaryLineageEarlier: head.earlier! }) });
      assert.equal(bounded.status, "complete");
      const second = (await continuations.latest(host, t))!;
      assert.deepEqual([second.manifest.summaryLineage.length, second.manifest.summaryLineageEarlier], [LINEAGE_KEEP + 1, head.earlier]);
      // Folding continues a reference the host passed: the digest goes on from it, the count adds up.
      const longer = Array.from({ length: 205 }, (_, i) => ids[i]!);
      await continuations.capture(host, { commandId: cid("cap"), taskId: t, ...input(longer, { summaryLineageEarlier: { count: 3, digest: lineageDigest(["cmp-aaaaaaaaaaaaaaaaaaaa", "cmp-bbbbbbbbbbbbbbbbbbbb", "cmp-cccccccccccccccccccc"]), through: "cmp-cccccccccccccccccccc" } }) });
      const third = (await continuations.latest(host, t))!;
      assert.deepEqual(third.manifest.summaryLineageEarlier, { count: 8, digest: lineageDigest(["cmp-aaaaaaaaaaaaaaaaaaaa", "cmp-bbbbbbbbbbbbbbbbbbbb", "cmp-cccccccccccccccccccc", ...longer.slice(0, 5)]), through: longer[4] });
      // Still bounded on input: a list past 10,000 or a malformed reference is refused, never stored.
      await assert.rejects(continuations.capture(host, { commandId: cid("cap"), taskId: t, ...input(Array.from({ length: 10_001 }, () => ids[0]!)) }), (e: unknown) => e instanceof DomainError && e.code === "invalid_command" && e.field === "manifest.summaryLineage");
      await assert.rejects(continuations.capture(host, { commandId: cid("cap"), taskId: t, ...input(ids.slice(0, 3), { summaryLineageEarlier: { count: 1, digest: "sha256:nope", through: ids[0]! } }) }), (e: unknown) => e instanceof DomainError && e.code === "invalid_command" && e.field === "manifest.summaryLineageEarlier.digest");

      // The process's own compaction (the one that runs in production) is given the same owner decisions: twelve lines, each its ID and the wording quoted and cut; more than twelve are counted, not dropped silently.
      const given = compactionKeep((await w.decisions.controllerContext({ projectId: a, taskId: t }))!)!;
      assert.deepEqual(given.lines.map((l) => l.slice(0, l.indexOf(":"))).sort(), (pinned as { id: string }[]).map((p) => p.id).sort());
      for (const l of given.lines) assert.ok(l.length <= 24 + 2 + 2 + COMPACTION_KEEP.chars + 40 && /^dec-[a-z2-7]{20}: "/.test(l), l);
      for (let i = 0; i < 2; i++) await w.decisions.record(w.owner, { commandId: cid("dec"), projectId: a, category: "decision", topic: `extra-${i}`, statement: "More", wording: `Extra decision ${i}`, source: { channel: "direct" }, basedOn: 0 } as never);
      const more = compactionKeep((await w.decisions.controllerContext({ projectId: a, taskId: t }))!)!;
      assert.equal(more.lines.length, COMPACTION_KEEP.items);
      assert.match(more.note, /2 more are not listed.*decision\.context/);
    } finally { await w.close(); }
  });
}
