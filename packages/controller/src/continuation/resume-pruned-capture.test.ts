import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
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

  suite("a resume already recorded (the controller stopped right after the record) whose capture is pruned before the check is carried on: the check ends done from that record, never starts over or records a second resume", async ({ storage, svc, owner, task, epoch }) => {
    const a = await svc.capture(owner, { commandId: cid("c"), taskId: task, ...input(1) });
    await svc.capture(owner, { commandId: cid("c"), taskId: task, ...input(2) });
    let stop = true;
    const racing = new Proxy(svc, { get: (target, prop) => {
      const v = Reflect.get(target, prop) as unknown;
      if (prop === "resume") return async (...args: unknown[]) => {
        const r = await (target.resume as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        if (stop) { stop = false; throw new Error("controller stopped after the record"); }
        return r;
      };
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    } }) as ContinuationService;
    const checks = ResumeCheckService.withEpoch(storage, epoch, { continuations: racing, dependencies: { check: async () => [] }, blockers: { getBlocker: async () => undefined, openBlocker: async () => ({ id: "blk-1" }) } as never, ports }, options);
    const own = await checks.start(owner, { commandId: cid("s"), taskId: task, model, after: "continue", checkpointDigest: dg(1) });
    await assert.rejects(checks.commit(owner, { commandId: cid("k"), checkId: own.id }), /controller stopped/);
    assert.equal((await checks.forTask(owner, task))?.phase, "executing");
    assert.equal((await storage.listAggregates("continuation-resume", { limit: 10 })).length, 1, "the resume was recorded");
    await fill(svc, owner, task, 100);
    assert.equal(await storage.getAggregate({ kind: "continuation", id: a.id }), undefined, "the capture the resume was recorded against was pruned");
    const after = await checks.advance(owner, { checkId: own.id });
    assert.equal(after.phase, "done", JSON.stringify(after.history));
    assert.equal(after.round, own.round, "not started over");
    assert.ok(after.history.at(-1)?.note.includes(a.id), JSON.stringify(after.history));
    assert.equal((await storage.listAggregates("continuation-resume", { limit: 10 })).length, 1, "still one resume");
    assert.equal((await checks.advance(owner, { checkId: own.id })).phase, "done", "repeatable");
  });

  suite("a check started over while a second advance of it recorded its resume just before the prune: the next commit's command_conflict ends it done from that record, with no second record", async ({ storage, svc, owner, task, epoch }) => {
    const a = await svc.capture(owner, { commandId: cid("c"), taskId: task, ...input(1) });
    await svc.capture(owner, { commandId: cid("c"), taskId: task, ...input(2) });
    let first = true;
    const racing = new Proxy(svc, { get: (target, prop) => {
      const v = Reflect.get(target, prop) as unknown;
      if (prop === "resume") return async (...args: unknown[]) => {
        if (first) { first = false; await fill(svc, owner, task, 100); }
        return (target.resume as (...a: unknown[]) => Promise<unknown>).apply(target, args);
      };
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    } }) as ContinuationService;
    const checks = ResumeCheckService.withEpoch(storage, epoch, { continuations: racing, dependencies: { check: async () => [] }, blockers: { getBlocker: async () => undefined, openBlocker: async () => ({ id: "blk-1" }) } as never, ports }, options);
    const own = await checks.start(owner, { commandId: cid("s"), taskId: task, model, after: "continue", checkpointDigest: dg(1) });
    const restarted = await checks.commit(owner, { commandId: cid("k"), checkId: own.id });
    assert.equal(restarted.phase, "ready");
    assert.equal(await storage.getAggregate({ kind: "continuation", id: a.id }), undefined);
    // The other advance's record, under this check's own resume command ID, against a capture other than the one the restarted check now follows.
    const kept = (await storage.getAggregate({ kind: "continuation-head", id: task }))!.body as { recent: { id: string }[] };
    const other = kept.recent.map((e) => e.id).find((x) => x !== restarted.continuationId)!;
    const resumer = { id: "service:resume-check", kind: "service", name: "resume-check", grants: [] } as unknown as Parameters<ContinuationService["resume"]>[0];
    await svc.resume(resumer, { commandId: `${own.id}-resume`, taskId: task, continuationId: other, model, after: "continue" });
    const after = await checks.commit(owner, { commandId: cid("k"), checkId: own.id });
    assert.equal(after.phase, "done", JSON.stringify(after.history));
    assert.ok(after.history.at(-1)?.note.includes(other), JSON.stringify(after.history));
    assert.equal((await storage.listAggregates("continuation-resume", { limit: 10 })).length, 1, "one resume");
  });

  suite("a not_found from the resume while the check's capture still exists is a real error: thrown, the check stays executing in its round, nothing recorded", async ({ storage, svc, owner, task, epoch }) => {
    const a = await svc.capture(owner, { commandId: cid("c"), taskId: task, ...input(1) });
    await svc.capture(owner, { commandId: cid("c"), taskId: task, ...input(2) });
    const failing = new Proxy(svc, { get: (target, prop) => {
      const v = Reflect.get(target, prop) as unknown;
      if (prop === "resume") return async () => { throw new DomainError("not_found", "no continuation was captured for that task"); };
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    } }) as ContinuationService;
    const checks = ResumeCheckService.withEpoch(storage, epoch, { continuations: failing, dependencies: { check: async () => [] }, blockers: { getBlocker: async () => undefined, openBlocker: async () => ({ id: "blk-1" }) } as never, ports }, options);
    const own = await checks.start(owner, { commandId: cid("s"), taskId: task, model, after: "continue", checkpointDigest: dg(1) });
    await assert.rejects(checks.commit(owner, { commandId: cid("k"), checkId: own.id }), (e: Error & { code?: string }) => e.code === "not_found");
    assert.notEqual(await storage.getAggregate({ kind: "continuation", id: a.id }), undefined);
    const now = await checks.forTask(owner, task);
    assert.equal(now?.phase, "executing");
    assert.equal(now?.round, own.round, "not started over");
    assert.equal((await storage.listAggregates("continuation-resume", { limit: 10 })).length, 0);
  });

  suite("a capture pruned before every commit: the check starts over at most its rounds and then blocks as churn; nothing is recorded and it never loops", async ({ storage, svc, owner, task, epoch }) => {
    await svc.capture(owner, { commandId: cid("c"), taskId: task, ...input(1) });
    await svc.capture(owner, { commandId: cid("c"), taskId: task, ...input(2) });
    let calls = 0; let next = 1000;
    // Each fill adds CONTINUATION_KEEP + 1 newer captures, so the one the check follows (the latest when it started over) is no longer the latest and is pruned before every resume.
    const racing = new Proxy(svc, { get: (target, prop) => {
      const v = Reflect.get(target, prop) as unknown;
      if (prop === "resume") return async (...args: unknown[]) => {
        calls++;
        await fill(svc, owner, task, next); next += 1000;
        return (target.resume as (...a: unknown[]) => Promise<unknown>).apply(target, args);
      };
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    } }) as ContinuationService;
    const checks = ResumeCheckService.withEpoch(storage, epoch, { continuations: racing, dependencies: { check: async () => [] }, blockers: { getBlocker: async () => undefined, openBlocker: async () => ({ id: "blk-1" }) } as never, ports }, options);
    const own = await checks.start(owner, { commandId: cid("s"), taskId: task, model, after: "continue", checkpointDigest: dg(1) });
    let last = own;
    for (let i = 0; i < own.maxRounds + 2 && last.phase === "ready"; i++) last = await checks.commit(owner, { commandId: cid("k"), checkId: own.id });
    assert.equal(last.phase, "blocked", JSON.stringify(last.history));
    assert.equal(last.blocked?.type, "resume_churn");
    assert.ok(calls <= own.maxRounds, `resume tried ${calls} times`);
    assert.equal((await storage.listAggregates("continuation-resume", { limit: 10 })).length, 0, "nothing recorded");
  });
}
