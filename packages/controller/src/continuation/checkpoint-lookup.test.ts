import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService } from "../security/index.js";
import type { JsonObject } from "../storage/types.js";
import { CONTINUATION_KEEP, ContinuationService, continuationRecorder, ResumeCheckService, type ContinuationInput, type ResumePorts } from "./index.js";

after(stopServer);

// Card L04d (follow-ups): a capture is found by its checkpoint, an earlier incomplete capture fixes the identity, old captures are pruned, and a resume check follows the checkpoint the attempt restores.
const options = { clock: () => "2026-11-15T09:00:00.000Z", pause: async () => undefined };
const dg = (n: number): string => `v1:sha256:${n.toString(16).padStart(64, "0")}`;
let counter = 0;
const cid = (label: string): string => `${label}-${counter++}`;
const input = (n: number, verified: boolean, identity = "conv-1"): ContinuationInput => ({
  identity, agent: "agent:ann", boundary: { kind: "turn-complete" },
  checkpoint: { conversationId: 1, at: n, digest: dg(n), runtime: { name: "pi", version: "1" }, format: 1 },
  durable: verified ? { verified: true } : { verified: false, error: "did not read back" },
  continuation: { artifacts: [], decisions: [], pendingEffects: [], budget: { spent: 0, remaining: 0, unit: "x" }, nextStep: "carry on" },
  manifest: { summaryLineage: [], sourceRanges: [], compression: { state: "none", compactions: 0 }, branches: [], messageCursor: n, routingRevision: 0, environmentRevision: 0, adapter: { name: "pi", version: "1" } },
  nonCheckpointableTools: [], scratchRecords: [], credentialRefs: [],
});
const hostCheckpoint = (n: number, verified: boolean): JsonObject => ({ pi: { format: 1, conversationId: 1, at: n, digest: dg(n), runtime: { name: "pi", version: "1" } }, nn: { durable: verified ? { verified: true } : { verified: false, error: "did not read back" } } } as unknown as JsonObject);

for (const backend of backends) {
  const suite = (name: string, body: (c: { storage: Awaited<ReturnType<typeof backend.open>>["storage"]; svc: ContinuationService; owner: Awaited<ReturnType<PrincipalService["authenticate"]>>; stranger: Awaited<ReturnType<PrincipalService["authenticate"]>>; task: string; project: string; epoch: number; second: () => Promise<string> }) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "zed", grants: [] });
        const stranger = await principals.authenticate((await principals.issueCredential(owner, "agent:zed")).token);
        const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "A" })).id;
        const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "one" })).id;
        const second = async (): Promise<string> => (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "two" })).id;
        await body({ storage: world.storage, svc: ContinuationService.withEpoch(world.storage, projects.epoch, options), owner, stranger, task, project, epoch: projects.epoch, second });
      } finally { await world.close(); }
    });

  suite("a capture is found by its checkpoint: complete ones only, the newest of a repeated digest, none for a reader without the right", async ({ svc, owner, stranger, task }) => {
    const a = await svc.capture(owner, { commandId: cid("c"), taskId: task, ...input(10, true) });
    await svc.capture(owner, { commandId: cid("c"), taskId: task, ...input(11, false) });
    const c = await svc.capture(owner, { commandId: cid("c"), taskId: task, ...input(12, true) });
    assert.equal((await svc.forCheckpoint(owner, task, dg(10)))?.id, a.id, "an earlier complete capture is found by its checkpoint");
    assert.equal((await svc.forCheckpoint(owner, task, dg(12)))?.id, c.id);
    assert.equal(await svc.forCheckpoint(owner, task, dg(11)), undefined, "an incomplete capture is never offered");
    assert.equal(await svc.forCheckpoint(owner, task, dg(99)), undefined, "an unknown checkpoint finds nothing");
    assert.equal(await svc.forCheckpoint(stranger, task, dg(10)), undefined, "a reader without the right sees nothing");
    // The same checkpoint captured again later: the newest one answers.
    const again = await svc.capture(owner, { commandId: cid("c"), taskId: task, ...input(10, true) });
    assert.equal((await svc.forCheckpoint(owner, task, dg(10)))?.id, again.id);
  });

  suite("a head written before the list of recent captures existed is found by scanning its records", async ({ storage, svc, owner, task, epoch }) => {
    const a = await svc.capture(owner, { commandId: cid("c"), taskId: task, ...input(20, true) });
    // Make the head look as an older controller wrote it: no list of recent captures.
    const head = (await storage.getAggregate({ kind: "continuation-head", id: task }))!;
    assert.ok(Array.isArray((head.body as { recent?: unknown }).recent));
    const { recent: _r, recentFrom: _f, ...old } = head.body as Record<string, unknown>;
    void _r; void _f;
    await storage.applyOperation({ operationId: cid("legacy"), epoch, actor: "owner:rob", correlationId: "legacy", at: "2026-11-15T09:00:00.000Z", changes: [{ type: "update", ref: { kind: "continuation-head", id: task }, expectedRevision: head.revision, body: old as JsonObject }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
    assert.equal((await svc.forCheckpoint(owner, task, dg(20)))?.id, a.id, "found by the scan");
    const b = await svc.capture(owner, { commandId: cid("c"), taskId: task, ...input(21, true) });
    assert.equal((await svc.forCheckpoint(owner, task, dg(20)))?.id, a.id, "an old capture is still found after the head starts its list");
    assert.equal((await svc.forCheckpoint(owner, task, dg(21)))?.id, b.id);
  });

  suite("an earlier incomplete capture fixes the identity, and the host recorder keeps it", async ({ svc, owner, task }) => {
    const first = await svc.capture(owner, { commandId: cid("c"), taskId: task, ...input(30, false, "conv-owner") });
    assert.equal(first.status, "incomplete");
    assert.equal(await svc.latest(owner, task), undefined, "no complete capture carries the identity yet");
    assert.equal(await svc.identityOf(owner, task), "conv-owner");
    const errors: unknown[] = [];
    const record = continuationRecorder({ continuations: svc, principal: owner, sources: { previous: (id) => svc.latest(owner, id) }, onError: (e) => errors.push(e) });
    const out = await record({ attemptId: "att-aaaaaaaaaaaaaaaaaaaa", taskId: task, agentId: "agent:ann", reason: "the turn completed", boundary: "turn-complete", checkpoint: hostCheckpoint(31, true) });
    assert.ok("captured" in out && out.captured.status === "complete", JSON.stringify(out));
    assert.equal((await svc.latest(owner, task))?.identity, "conv-owner", "the recorder used the identity the incomplete capture fixed");
    assert.deepEqual(errors, []);
    assert.equal(await svc.identityOf(owner, `task-${"a".repeat(20)}`), undefined);
  });

  suite(`records beyond ${CONTINUATION_KEEP} per task are deleted with the capture that makes them too many, never the latest complete one, and another task's are untouched`, async ({ storage, svc, owner, task, second }) => {
    const other = await second();
    const otherCap = await svc.capture(owner, { commandId: cid("c"), taskId: other, ...input(1, true, "conv-2") });
    const first = await svc.capture(owner, { commandId: cid("c"), taskId: task, ...input(1000, true) });
    // A resume recorded against the capture that will be pruned later.
    const resumeCommand = { commandId: cid("r"), taskId: task, model: { provider: "local", id: "m1" }, after: "continue" as const };
    assert.equal((await svc.resume(owner, resumeCommand)).continuation.id, first.id);
    const mid = await svc.capture(owner, { commandId: cid("c"), taskId: task, ...input(1001, false) });
    // Many incomplete captures after the one complete capture: it must survive them all.
    for (let i = 0; i < CONTINUATION_KEEP + 5; i++) await svc.capture(owner, { commandId: cid("c"), taskId: task, ...input(2000 + i, false) });
    assert.ok(await storage.getAggregate({ kind: "continuation", id: first.id }), "the latest complete capture is kept however many follow it");
    assert.equal(await storage.getAggregate({ kind: "continuation", id: mid.id }), undefined, "an old incomplete capture was pruned");
    assert.equal((await svc.latest(owner, task))?.id, first.id);
    assert.equal((await svc.forCheckpoint(owner, task, dg(1000)))?.id, first.id);
    const all = await svc.history(owner, task, { limit: 100 });
    assert.equal(all.items.length, CONTINUATION_KEEP, `a task keeps at most ${CONTINUATION_KEEP} records`);
    assert.ok(all.items.some((i) => i.id === first.id));
    assert.equal(Math.max(...all.items.map((i) => i.seq)), CONTINUATION_KEEP + 7, "the newest capture is kept");
    // When a newer complete capture takes over, the old complete one becomes prunable.
    const newer = await svc.capture(owner, { commandId: cid("c"), taskId: task, ...input(3000, true) });
    assert.equal(await storage.getAggregate({ kind: "continuation", id: first.id }), undefined, "the capture that lost its place as latest complete was pruned next");
    assert.equal((await svc.latest(owner, task))?.id, newer.id);
    assert.ok(await storage.getAggregate({ kind: "continuation", id: otherCap.id }), "another task's capture is untouched");
    // Every deleted record has its own audit entry naming it, its task and the keep limit; nothing of another task is named.
    // 57 captures of the task went to 50 (seven pruned), then the newer complete one took the old complete one's place (one more).
    const pruned = (await storage.listAudit({ afterSeq: 0, limit: 1000 })).filter((r) => r.type === "continuation.pruned");
    assert.equal(pruned.length, 8, JSON.stringify(pruned.map((r) => r.detail)));
    assert.ok(pruned.some((r) => r.subject?.id === mid.id) && pruned.some((r) => r.subject?.id === first.id));
    assert.ok(pruned.every((r) => r.subject?.kind === "continuation" && r.detail["taskId"] === task && r.detail["keep"] === CONTINUATION_KEEP && r.subject.id !== otherCap.id));
    // The same resume command again, its capture now pruned: answered as not found, not as a failure on a missing record.
    await assert.rejects(svc.resume(owner, resumeCommand), (e: Error & { code?: string }) => e.code === "not_found" && /pruned/.test(e.message));
  });

  suite("a resume check follows the capture of the checkpoint the attempt restores, and the latest when that checkpoint has no complete capture", async ({ storage, svc, owner, stranger, task, epoch }) => {
    const a = await svc.capture(owner, { commandId: cid("c"), taskId: task, ...input(40, true) });
    const b = await svc.capture(owner, { commandId: cid("c"), taskId: task, ...input(41, true) });
    const ports: ResumePorts = { observe: async () => ({}), missingContext: async () => [], uncertainEffects: async () => [], review: async () => ({}) };
    const checks = ResumeCheckService.withEpoch(storage, epoch, {
      continuations: svc,
      dependencies: { check: async () => [] },
      blockers: { getBlocker: async () => undefined, openBlocker: async () => ({ id: "blk-1" }) } as never,
      ports,
    }, options);
    const model = { provider: "local", id: "m1" };
    // Without a named checkpoint: the latest, as before.
    const plain = await checks.start(owner, { commandId: cid("s"), taskId: task, model, after: "continue" });
    assert.equal(plain.continuationId, b.id);
    await checks.cancel(owner, { checkId: plain.id });
    // Naming the earlier checkpoint: that capture.
    const own = await checks.start(owner, { commandId: cid("s"), taskId: task, model, after: "continue", checkpointDigest: dg(40) });
    assert.equal(own.continuationId, a.id, "the check follows the checkpoint the attempt restores");
    assert.equal(own.phase, "ready");
    // A newer capture between the review and the commit does not make a check of an older checkpoint stale: it still names the one it was made against.
    const late = await svc.capture(owner, { commandId: cid("c"), taskId: task, ...input(42, true) });
    assert.ok(late.id !== a.id);
    // Committing resumes from that capture, not the latest.
    const done = await checks.commit(owner, { commandId: cid("k"), checkId: own.id });
    assert.equal(done.phase, "done", JSON.stringify(done.history));
    assert.ok(done.history.some((h) => h.note === `resumed from ${a.id}`), "the resume was recorded against the checkpoint's own capture");
    assert.equal((await checks.capturedCheckpoint(owner, task, dg(40)))?.digest, dg(40));
    assert.equal(await checks.capturedCheckpoint(owner, task, dg(99)), undefined);
    await assert.rejects(checks.capturedCheckpoint(stranger, task, dg(40)), (e: Error & { code?: string }) => e.code === "forbidden" || e.code === "not_found", "a caller without the right learns nothing");
    // By contrast, a check that names no checkpoint follows the latest, so a newer capture after its review does make it stale.
    const follows = await checks.start(owner, { commandId: cid("s"), taskId: task, model, after: "continue" });
    assert.equal(follows.continuationId, late.id);
    await svc.capture(owner, { commandId: cid("c"), taskId: task, ...input(43, true) });
    const stale = await checks.commit(owner, { commandId: cid("k"), checkId: follows.id });
    assert.notEqual(stale.phase, "done", "a check of the latest is not committed once a newer capture exists");
    await checks.cancel(owner, { checkId: stale.id }).catch(() => undefined);
    const unknown = await checks.start(owner, { commandId: cid("s"), taskId: task, model, after: "continue", checkpointDigest: dg(77) });
    assert.equal(unknown.continuationId, (await svc.latest(owner, task))?.id, "a checkpoint with no complete capture falls back to the latest");
  });
}
