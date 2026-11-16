import assert from "node:assert/strict";
import { after, test } from "node:test";
import { CONTINUATION_KEEP, ContinuationService, ResumeCheckService, controllerResumePorts, type ContinuationInput } from "../continuation/index.js";
import { DependencyService } from "../dependencies/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld, workGrants } from "./testing/world.js";

after(stopServer);

// Card L04d (follow-ups, tests only): the dispatcher's commit of a resume check whose capture is pruned while the check is in progress (more than CONTINUATION_KEEP newer captures).
const dg = (n: number): string => `v1:sha256:${n.toString(16).padStart(64, "0")}`;
const PI = (n: number): Record<string, unknown> => ({ pi: { conversationId: 1, at: n, digest: dg(n), runtime: { name: "pi", version: "1" }, format: 1 } });
let counter = 0;
const cid = (label: string): string => `${label}-${counter++}`;
const input = (n: number): ContinuationInput => ({
  identity: "conv-1", agent: "agent:ann", boundary: { kind: "turn-complete" },
  checkpoint: { conversationId: 1, at: n, digest: dg(n), runtime: { name: "pi", version: "1" }, format: 1 },
  durable: { verified: true },
  continuation: { artifacts: [], decisions: [], pendingEffects: [], budget: { spent: 0, remaining: 0, unit: "x" }, nextStep: "carry on" },
  manifest: { summaryLineage: [], sourceRanges: [], compression: { state: "none", compactions: 0 }, branches: [], messageCursor: n, routingRevision: 0, environmentRevision: 0, adapter: { name: "pi", version: "1" } },
  nonCheckpointableTools: [], scratchRecords: [], credentialRefs: [],
});

for (const backend of backends) {
  test(`${backend.name}: a resume check whose capture is pruned before the resume is recorded answers not_found, starts the check over, and the dispatcher commits it on the next tick so the attempt starts`, async () => {
    const store = await backend.open();
    try {
      const c = await buildWorld(store.storage);
      const options = { clock: c.options.clock! };
      const continuations = ContinuationService.withEpoch(store.storage, c.epoch, options);
      const dependencies = DependencyService.withEpoch(store.storage, c.epoch, options);
      let prune = true;
      const attempts: string[] = [];
      const racing = new Proxy(continuations, { get: (target, prop) => {
        const v = Reflect.get(target, prop) as unknown;
        if (prop === "resume") return async (...args: unknown[]) => {
          attempts.push("resume");
          if (prune) { prune = false; for (let i = 0; i < CONTINUATION_KEEP + 1; i++) await continuations.capture(c.owner, { commandId: cid("c"), taskId: taskIdOf, ...input(100 + i) }); }
          return (target.resume as (...a: unknown[]) => unknown).apply(target, args);
        };
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      } }) as ContinuationService;
      const real = ResumeCheckService.withEpoch(store.storage, c.epoch, { continuations: racing, dependencies, blockers: c.blockers, ports: controllerResumePorts(store.storage, { observe: async () => ({}), review: async () => ({}) }) }, options);
      const ann = await c.agent("ann", workGrants(c.project, []));
      const { taskId, attemptId } = await c.task("long job", ann);
      const taskIdOf = taskId;
      // Two captures; the attempt's own checkpoint is the older one, so the check follows it and it is not the latest complete capture.
      const first = await continuations.capture(c.owner, { commandId: cid("c"), taskId, ...input(1) });
      await continuations.capture(c.owner, { commandId: cid("c"), taskId, ...input(2) });
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      c.worker.script = async ({ worker }) => { worker.checkpoint = async () => PI(1) as never; await gate; return { status: "completed", text: "late" }; };
      const firstRun = c.restart();
      assert.deepEqual((await firstRun.tick()).started, [attemptId]);
      await firstRun.shutdown();
      release();
      await firstRun.idle();
      assert.ok((await firstRun.get(c.owner, attemptId!))!.resumeFrom !== undefined);
      c.worker.script = async () => ({ status: "completed", text: "done" });
      const starts = c.worker.starts.length;

      const d = c.restart({ resumes: real });
      const held = await d.tick();
      assert.deepEqual(held.started, [], "the attempt does not start on a commit that did not finish");
      assert.match(held.skipped.map((s) => s.reason).join("; "), /resume check .* is ready after the commit; it is looked at again on the next tick/, JSON.stringify(held.skipped));
      assert.equal(await store.storage.getAggregate({ kind: "continuation", id: first.id }), undefined, "the capture the check followed was pruned");
      assert.equal((await store.storage.listAggregates("continuation-resume", { limit: 10 })).length, 0, "no resume was recorded against a missing capture");
      assert.equal(c.worker.starts.length, starts);
      assert.equal(attempts.length, 1, "the resume was tried once");
      // The next tick commits the check again, now against the capture that exists, and the attempt starts.
      const again = await d.tick();
      await d.idle();
      assert.deepEqual(again.started, [attemptId], JSON.stringify(again.skipped));
      assert.equal((await real.forTask(c.dispatcherPrincipal, taskId))?.phase, "done");
      assert.equal((await store.storage.listAggregates("continuation-resume", { limit: 10 })).length, 1);
      assert.equal(c.worker.starts.length, starts + 1);
    } finally { await store.close(); }
  });
}
