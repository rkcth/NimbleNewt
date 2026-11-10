import assert from "node:assert/strict";
import { after, test } from "node:test";
import { foldLineage, lineageDigest } from "../context/lineage.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService } from "../security/index.js";
import type { JsonObject } from "../storage/types.js";
import { ContinuationService, continuationRecorder, type CheckpointTaken } from "./index.js";

// Card L04d: a worker host's checkpoint becomes the task's continuation. These drive the real ContinuationService on every backend.
after(stopServer);

const options = { clock: () => "2026-11-10T09:00:00.000Z", pause: async () => undefined };
const digest = (c: string): string => `v1:sha256:${c.repeat(64)}`;
/** A checkpoint of the shape the local and remote Pi hosts hand the dispatcher (`{ pi, nn }`). */
const hostCheckpoint = (at: number, durable?: unknown, d = digest("a")): JsonObject => ({
  pi: { format: 2, conversationId: 3, at, digest: d, runtime: { name: "pi-durable", version: "1.3.0" }, historyFormat: "pi-durable:1", contractsVersion: 1 },
  nn: { turnSeq: 1, ...(durable === undefined ? {} : { durable }) },
} as unknown as JsonObject);
const cmpId = (i: number): string => `cmp-${i.toString(2).padStart(20, "0").replace(/0/g, "a").replace(/1/g, "b")}`;

for (const backend of backends) {
  test(`${backend.name}: a host's checkpoint at a turn boundary is captured complete when it read back, incomplete when it did not, and one checkpoint is one capture`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      await principals.enroll(owner, { commandId: "e-d", kind: "service", name: "dispatcher", grants: [] });
      const dispatcher = await principals.authenticate((await principals.issueCredential(owner, "service:dispatcher")).token);
      const p = (await projects.createProject({ commandId: "p", actor: "owner:rob", name: "A" })).id;
      const taskId = (await projects.createTask({ commandId: "t", actor: "owner:rob", projectId: p, title: "weed" })).id;
      const svc = ContinuationService.withEpoch(world.storage, projects.epoch, options);
      const errors: unknown[] = [];
      const record = continuationRecorder({ continuations: svc, principal: dispatcher, sources: { previous: (id) => svc.latest(dispatcher, id) }, onError: (e) => errors.push(e) });
      const taken = (checkpoint: JsonObject, boundary: CheckpointTaken["boundary"] = "turn-complete"): CheckpointTaken => ({ attemptId: "att-aaaaaaaaaaaaaaaaaaaa", taskId, agentId: "agent:ann", reason: "the turn completed", boundary, checkpoint });

      // A process that did not say it read the checkpoint back: kept, but never resumed from.
      const unchecked = await record(taken(hostCheckpoint(10)));
      assert.ok("captured" in unchecked && unchecked.captured.status === "incomplete", JSON.stringify(unchecked));
      assert.equal(await svc.latest(owner, taskId), undefined, "an unverified capture is not the latest complete one");
      const failed = await record(taken(hostCheckpoint(11, { verified: false, error: "the checkpoint did not read back: history_changed" })));
      assert.ok("captured" in failed && failed.captured.status === "incomplete");
      const stored = (await world.storage.getAggregate({ kind: "continuation", id: failed.captured.id }))!.body as { problem?: string };
      assert.equal(stored.problem, "the checkpoint did not read back: history_changed", "the host's reason is on record");

      const ok = await record(taken(hostCheckpoint(12, { verified: true })));
      assert.ok("captured" in ok && ok.captured.status === "complete", JSON.stringify(ok));
      const latest = (await svc.latest(owner, taskId))!;
      assert.deepEqual([latest.id, latest.identity, latest.agent, latest.boundary.kind, latest.checkpoint.at, latest.checkpoint.conversationId, latest.capturedBy], [ok.captured.id, `task:${taskId}`, "agent:ann", "turn-complete", 12, 3, "service:dispatcher"]);
      assert.deepEqual(latest.manifest.adapter, { name: "pi-durable", version: "1.3.0" });
      assert.equal(latest.manifest.messageCursor, 12);
      assert.match(latest.continuation.nextStep, /^Carry on with the task from the checkpoint taken when the turn completed\.$/);
      // The same checkpoint at the same boundary again is the same capture.
      const again = await record(taken(hostCheckpoint(12, { verified: true })));
      assert.ok("captured" in again && again.captured.replayed && again.captured.id === ok.captured.id, JSON.stringify(again));
      // The same checkpoint at a shutdown is a capture of its own, with the same identity.
      const shut = await record(taken(hostCheckpoint(12, { verified: true }), "shutdown"));
      assert.ok("captured" in shut && shut.captured.id !== ok.captured.id && shut.captured.status === "complete");
      assert.equal((await svc.latest(owner, taskId))!.boundary.kind, "shutdown");

      // Nothing an adapter can name: a checkpoint taken in the middle of a turn, one of another shape, an agent the capture cannot name. Skipped, nothing written, nothing reported.
      const before = (await world.storage.listAggregates("continuation", { limit: 100 })).length;
      assert.deepEqual(await record(taken({ nn: { turnSeq: 1, midTurn: true } } as unknown as JsonObject)), { skipped: "the checkpoint was taken in the middle of a turn" });
      assert.ok("skipped" in await record(taken({ n: 1, attempt: "x" } as unknown as JsonObject)));
      assert.ok("skipped" in await record(taken(hostCheckpoint(13, { verified: true }, "sha256:nope"))));
      assert.ok("skipped" in await record({ ...taken(hostCheckpoint(14, { verified: true })), agentId: "host:w1" }));
      assert.equal((await world.storage.listAggregates("continuation", { limit: 100 })).length, before);
      assert.deepEqual(errors, []);
    } finally { await world.close(); }
  });

  test(`${backend.name}: a capture names the task's compaction lineage, folded as C07q folds it, with the budget from accounting and what the last continuation named carried on`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      await principals.enroll(owner, { commandId: "e-d", kind: "service", name: "dispatcher", grants: [] });
      const dispatcher = await principals.authenticate((await principals.issueCredential(owner, "service:dispatcher")).token);
      const p = (await projects.createProject({ commandId: "p", actor: "owner:rob", name: "A" })).id;
      const taskId = (await projects.createTask({ commandId: "t", actor: "owner:rob", projectId: p, title: "weed" })).id;
      const svc = ContinuationService.withEpoch(world.storage, projects.epoch, options);
      // A continuation an owner captured before: its identity is the task's conversation, and it named an artifact and a decision.
      const art = "art-aaaaaaaaaaaaaaaaaaaa", dsk = "dsk-aaaaaaaaaaaaaaaaaaaa";
      await svc.capture(owner, {
        commandId: "own", taskId, identity: "conv-1", agent: "agent:ann", boundary: { kind: "manual" }, checkpoint: { conversationId: 3, at: 5, digest: digest("b"), runtime: { name: "pi-durable", version: "1.3.0" }, format: 2 }, durable: { verified: true },
        continuation: { artifacts: [art], decisions: [dsk], pendingEffects: [], budget: { spent: 1, remaining: 2, unit: "k" }, nextStep: "go on" },
        manifest: { summaryLineage: [], sourceRanges: [], compression: { state: "none", compactions: 0 }, branches: [], messageCursor: 5, routingRevision: 1, environmentRevision: 1, adapter: { name: "pi-durable", version: "1.3.0" } },
        nonCheckpointableTools: [], scratchRecords: [], credentialRefs: [],
      });
      // The task's latest compaction as the controller keeps it after 260 compactions: 50 listed (the rest folded), and its own ID.
      const all = Array.from({ length: 260 }, (_, i) => cmpId(i));
      const kept = foldLineage(all.slice(0, 259), undefined);
      const latestCompaction = { id: all[259]!, lineage: kept.lineage, ...(kept.earlier === undefined ? {} : { earlier: kept.earlier }) };
      const record = continuationRecorder({
        continuations: svc, principal: dispatcher,
        sources: { compaction: async () => latestCompaction, budget: async () => ({ spent: 1200.4, remaining: 8800, unit: "USD micros" }), previous: (id) => svc.latest(dispatcher, id) },
      });
      const r = await record({ attemptId: "att-aaaaaaaaaaaaaaaaaaaa", taskId, agentId: "agent:ann", reason: "the controller shut down", boundary: "shutdown", checkpoint: hostCheckpoint(40, { verified: true }) });
      assert.ok("captured" in r && r.captured.status === "complete", JSON.stringify(r));
      const c = (await svc.latest(owner, taskId))!;
      assert.equal(c.identity, "conv-1", "the task's conversation keeps the identity it has");
      assert.deepEqual([c.continuation.artifacts, c.continuation.decisions], [[art], [dsk]], "what the last continuation named is carried on");
      assert.deepEqual(c.continuation.budget, { spent: 1200, remaining: 8800, unit: "USD micros" });
      assert.deepEqual(c.manifest.compression, { state: "compacted", compactions: 260 });
      // The capture keeps its newest 200 listed and folds the rest, continuing the compaction record's own fold: the count and the chained digest are those of all 260 in order.
      assert.equal(c.manifest.summaryLineage.length, 51);
      assert.deepEqual(c.manifest.summaryLineage, [...kept.lineage, all[259]]);
      assert.equal(c.manifest.summaryLineageEarlier?.count, 209);
      assert.equal(c.manifest.summaryLineageEarlier?.digest, lineageDigest(all.slice(0, 209)));
      assert.equal(c.manifest.summaryLineageEarlier?.through, all[208]);
    } finally { await world.close(); }
  });
}
