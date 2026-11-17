import assert from "node:assert/strict";
import { after } from "node:test";
import { ContinuationService, ResumeCheckService, continuationRecorder, type ResumePorts } from "../continuation/index.js";
import type { DispatcherDeps } from "../dispatch/dispatcher.js";
import { DependencyService } from "../dependencies/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { JsonObject } from "../storage/types.js";
import { workGrants } from "../dispatch/testing/world.js";
import { RemoteWorkerHost } from "./host.js";
import { FULL_ABILITIES, remoteSuite } from "./testing/suite.js";

after(stopServer);

// Card L04e: a remote host's turn ends with the checkpoint it sent with its result, and the dispatcher captures it as the task's continuation with the worker's own read-back check (`nn.durable`) in it, as it does for a local host.
// Before this, a remote turn's result carried no checkpoint, so no turn of a remote attempt was ever captured. Over the real worker transport, on every storage backend.
const dg = (n: number): string => `v1:sha256:${n.toString(16).padStart(64, "0")}`;
const piCheckpoint = (at: number, durable?: { verified: boolean; error?: string }): JsonObject => ({
  pi: { format: 2, conversationId: 1, at, digest: dg(at), runtime: { name: "pi-durable", version: "1.3.0" }, historyFormat: "pi-durable:1", contractsVersion: 1 },
  nn: { turnSeq: at, ...(durable === undefined ? {} : { durable }) },
} as unknown as JsonObject);
let counter = 0;
const cid = (label: string): string => `${label}-${counter++}`;
const ports: ResumePorts = { observe: async () => ({}), missingContext: async () => [], uncertainEffects: async () => [], review: async () => ({}) };

for (const backend of backends) {
  const hook: { run?: (info: Parameters<NonNullable<DispatcherDeps["checkpoints"]>>[0]) => Promise<unknown> } = {};
  const suite = remoteSuite(backend);
  const options = { checkpoints: async (info: Parameters<NonNullable<DispatcherDeps["checkpoints"]>>[0]) => hook.run?.(info) };

  suite("a remote turn's checkpoint, with the worker's passed read-back check, is captured as a complete continuation, and a resume check follows it; a failed or missing check is captured incomplete and never resumed from; a result with no checkpoint captures nothing (card L04e)", async (c) => {
    const continuations = ContinuationService.withEpoch(c.storage, c.epoch, c.options);
    const errors: unknown[] = [];
    hook.run = continuationRecorder({ continuations, principal: c.owner, onError: (e) => errors.push(e) });
    const r1 = await c.host("r1", { dispatcher: false });
    // The dispatcher is given the product's remote host (not the test double), so the turn's result reaches it as it does in production.
    const product = new RemoteWorkerHost(r1.id, c.remote, c.dispatcherPrincipal, { resources: { cpus: 1, memoryMb: 1024 }, requirements: () => ({ data: "cloud-allowed", harness: "pi" }) });
    const dispatcher = c.restart({ workers: [product], storeOwner: (agentId, attemptId) => c.remote.storeOwner(c.dispatcherPrincipal, agentId, attemptId), checkpoints: async (info) => hook.run?.(info) });
    const agent = await c.agent("ann", workGrants(c.project, ["read-file", "write-file"]));
    const turn = async (title: string, checkpoint: JsonObject | undefined, before?: (attempt: { putCheckpoint(n: number, c: JsonObject): Promise<unknown> }) => Promise<void>) => {
      const { taskId, attemptId } = await c.task(title, agent);
      const report = await dispatcher.tick();
      assert.ok(report.started.includes(attemptId!), JSON.stringify(report.skipped));
      const offer = (await r1.client.offers()).find((x) => x.order.attemptId === attemptId)!;
      const attempt = r1.client.attempt(attemptId!, offer.placement);
      await attempt.accept();
      assert.deepEqual(await attempt.honorContract(offer.order, FULL_ABILITIES, c.clock.now()), { ok: true });
      await before?.(attempt as never);
      await attempt.complete({ status: "completed", text: "done", endKind: "normal", ...(checkpoint === undefined ? {} : { checkpoint }) } as never);
      await dispatcher.idle();
      return { taskId, attemptId: attemptId! };
    };
    // A checkpoint whose read-back passed: complete, and it is the continuation a resume uses.
    const ok = await turn("one", piCheckpoint(1, { verified: true }));
    const latest = await continuations.latest(c.owner, ok.taskId);
    assert.ok(latest, `the turn was captured: ${JSON.stringify(errors.map(String))}`);
    assert.equal(latest!.checkpoint.digest, dg(1));
    assert.equal(latest!.status, "complete", "the worker's own read-back check came with the checkpoint and passed");
    const checks = ResumeCheckService.withEpoch(c.storage, c.epoch, { continuations, dependencies: DependencyService.withEpoch(c.storage, c.epoch, c.options), blockers: c.blockers, ports }, c.options);
    const resume = await checks.start(c.owner, { commandId: cid("s"), taskId: ok.taskId, model: { provider: "local", id: "m1" }, after: "restart", checkpointDigest: dg(1) });
    assert.equal(resume.continuationId, latest!.id, "the resume check follows the remote turn's own capture");
    // A read-back that failed: kept, but incomplete: never the one a resume follows.
    const bad = await turn("two", piCheckpoint(2, { verified: false, error: "the checkpoint did not read back" }));
    assert.equal(await continuations.latest(c.owner, bad.taskId), undefined, "no complete continuation for a checkpoint that did not read back");
    assert.deepEqual((await continuations.history(c.owner, bad.taskId)).items.map((h) => h.status), ["incomplete"]);
    // A worker that said nothing about a read-back did not check: incomplete as well.
    const silent = await turn("three", piCheckpoint(3));
    assert.equal(await continuations.latest(c.owner, silent.taskId), undefined);
    assert.deepEqual((await continuations.history(c.owner, silent.taskId)).items.map((h) => h.status), ["incomplete"]);
    // A result with no checkpoint after the worker sent one earlier (a control checkpoint) is not captured as this turn's: an older checkpoint is never taken for it.
    const none = await turn("four", undefined, async (attempt) => { await attempt.putCheckpoint(1, piCheckpoint(4, { verified: true })); });
    assert.equal(await continuations.latest(c.owner, none.taskId), undefined, "no checkpoint came with the result, so nothing was captured for the turn");
    assert.equal((await continuations.history(c.owner, none.taskId)).items.length, 0);
  }, options);
}
