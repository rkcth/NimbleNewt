import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService } from "../security/index.js";
import { CONTINUATION_KEEP, ContinuationService, ResumeCheckService, type ContinuationInput, type ResumePorts } from "./index.js";

after(stopServer);

// Card L04d (follow-ups, tests only): a resume check whose capture is pruned while the check is in progress (more than CONTINUATION_KEEP newer captures during one check).
// The capture a check follows is its checkpoint's own, which is not the latest complete one, so it can be pruned; the latest complete one never is.
const options = { clock: () => "2026-11-15T09:00:00.000Z", pause: async () => undefined };
const dg = (n: number): string => `v1:sha256:${n.toString(16).padStart(64, "0")}`;
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
  const suite = (name: string, body: (c: { storage: Awaited<ReturnType<typeof backend.open>>["storage"]; svc: ContinuationService; owner: Awaited<ReturnType<PrincipalService["authenticate"]>>; task: string; epoch: number }) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "A" })).id;
        const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "one" })).id;
        await body({ storage: world.storage, svc: ContinuationService.withEpoch(world.storage, projects.epoch, options), owner, task, epoch: projects.epoch });
      } finally { await world.close(); }
    });

  const ports: ResumePorts = { observe: async () => ({}), missingContext: async () => [], uncertainEffects: async () => [], review: async () => ({}) };
  const model = { provider: "local", id: "m1" };
  const fill = async (svc: ContinuationService, owner: Parameters<ContinuationService["capture"]>[0], task: string, from: number): Promise<void> => {
    for (let i = 0; i < CONTINUATION_KEEP + 1; i++) await svc.capture(owner, { commandId: cid("c"), taskId: task, ...input(from + i) });
  };

  suite("a capture pruned between the review and the commit makes the check start over against the latest capture; nothing is resumed from a missing record", async ({ storage, svc, owner, task, epoch }) => {
    const a = await svc.capture(owner, { commandId: cid("c"), taskId: task, ...input(1) });
    await svc.capture(owner, { commandId: cid("c"), taskId: task, ...input(2) });
    const checks = ResumeCheckService.withEpoch(storage, epoch, { continuations: svc, dependencies: { check: async () => [] }, blockers: { getBlocker: async () => undefined, openBlocker: async () => ({ id: "blk-1" }) } as never, ports }, options);
    const own = await checks.start(owner, { commandId: cid("s"), taskId: task, model, after: "continue", checkpointDigest: dg(1) });
    assert.equal(own.phase, "ready");
    assert.equal(own.continuationId, a.id);
    await fill(svc, owner, task, 100);
    assert.equal(await storage.getAggregate({ kind: "continuation", id: a.id }), undefined, "the capture the check follows was pruned");
    const after = await checks.commit(owner, { commandId: cid("k"), checkId: own.id });
    assert.notEqual(after.phase, "done", "not committed against a capture that is gone");
    assert.equal((await storage.listAggregates("continuation-resume", { limit: 10 })).length, 0, "no resume was recorded");
    const latest = await svc.latest(owner, task);
    assert.equal(after.continuationId, latest?.id, "the restarted check follows the latest complete capture");
  });

  suite("a capture pruned after the commit was made, before the resume is recorded: the resume answers not_found and records nothing, and the check starts over against the latest capture instead of staying stuck", async ({ storage, svc, owner, task, epoch }) => {
    const a = await svc.capture(owner, { commandId: cid("c"), taskId: task, ...input(1) });
    await svc.capture(owner, { commandId: cid("c"), taskId: task, ...input(2) });
    let prune = true;
    const answers: string[] = [];
    const racing = new Proxy(svc, { get: (target, prop) => {
      const v = Reflect.get(target, prop) as unknown;
      if (prop === "resume") return async (...args: unknown[]) => {
        if (prune) { prune = false; await fill(svc, owner, task, 100); }
        try { return await (target.resume as (...a: unknown[]) => Promise<unknown>).apply(target, args); } catch (e) { answers.push((e as { code?: string }).code ?? "error"); throw e; }
      };
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    } }) as ContinuationService;
    const checks = ResumeCheckService.withEpoch(storage, epoch, { continuations: racing, dependencies: { check: async () => [] }, blockers: { getBlocker: async () => undefined, openBlocker: async () => ({ id: "blk-1" }) } as never, ports }, options);
    const own = await checks.start(owner, { commandId: cid("s"), taskId: task, model, after: "continue", checkpointDigest: dg(1) });
    assert.equal(own.continuationId, a.id);
    const after = await checks.commit(owner, { commandId: cid("k"), checkId: own.id });
    assert.deepEqual(answers, ["not_found"], "the resume itself answered not_found, once");
    assert.equal(await storage.getAggregate({ kind: "continuation", id: a.id }), undefined);
    assert.equal((await storage.listAggregates("continuation-resume", { limit: 10 })).length, 0, "no resume was recorded against a missing capture");
    assert.equal(after.phase, "ready", "started over and reviewed again, ready to be committed");
    assert.equal(after.continuationId, (await svc.latest(owner, task))?.id);
    assert.ok(after.history.some((h) => /pruned/.test(h.note)), JSON.stringify(after.history));
    const done = await checks.commit(owner, { commandId: cid("k"), checkId: own.id });
    assert.equal(done.phase, "done");
    assert.equal((await storage.listAggregates("continuation-resume", { limit: 10 })).length, 1, "one resume, against the capture that exists");
  });
}
