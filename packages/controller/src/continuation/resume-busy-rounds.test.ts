import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService } from "../security/index.js";
import { CONTINUATION_KEEP, ContinuationService, ResumeCheckService, type ContinuationInput, type ResumePorts } from "./index.js";

after(stopServer);

// T8b: two narrow items of the resume check: overlapping start-overs may not take a check past its round limit, and six lost races on one write are said as a busy check.
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

  suite("two advances starting one check over at once: the second judges the round limit again on what the first wrote and blocks as churn instead of taking the check past its rounds", async ({ storage, svc, owner, task, epoch }) => {
    await svc.capture(owner, { commandId: cid("c"), taskId: task, ...input(1) });
    await svc.capture(owner, { commandId: cid("c"), taskId: task, ...input(2) });
    // A newer capture after the review makes a commit start the check over. The first commit reads the check, and just then a second commit of the same check runs through its start over and review.
    let state = 0; let nested: Promise<unknown> | undefined; let checks!: ResumeCheckService; let checkId = "";
    const racing = new Proxy(svc, { get: (target, prop) => {
      const v = Reflect.get(target, prop) as unknown;
      if ((prop === "latest" || prop === "forCheckpoint") && typeof v === "function") return async (...args: unknown[]) => { const r = await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args); if (state === 1) state = 2; return r; };
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    } }) as ContinuationService;
    const late = new Proxy(storage, { get: (target, prop) => {
      const v = Reflect.get(target, prop) as unknown;
      if (prop === "getAggregate") return async (ref: { kind: string; id: string }) => {
        const r = await (target.getAggregate as (r: unknown) => Promise<unknown>).call(target, ref);
        if (state === 2 && ref.kind === "resume-check") { state = 3; nested = checks.commit(owner, { commandId: cid("k"), checkId }); await nested; }
        return r;
      };
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    } }) as typeof storage;
    checks = ResumeCheckService.withEpoch(late, epoch, { continuations: racing, dependencies: { check: async () => [] }, blockers: { getBlocker: async () => undefined, openBlocker: async () => ({ id: "blk-1" }) } as never, ports }, { ...options, maxRounds: 2 });
    const own = await checks.start(owner, { commandId: cid("s"), taskId: task, model, after: "continue" });
    checkId = own.id;
    assert.equal(own.phase, "ready");
    assert.equal(own.round, 0);
    await svc.capture(owner, { commandId: cid("c"), taskId: task, ...input(3) });
    state = 1;
    // A forTask-style arming: the first commit's start over is the one that reads the check after its look at the inputs.
    const after = await checks.commit(owner, { commandId: cid("k"), checkId: own.id });
    assert.equal(state, 3, "the second advance ran inside the first one's window");
    assert.equal(after.phase, "blocked", JSON.stringify(after.history));
    assert.equal(after.blocked?.type, "resume_churn");
    assert.ok(after.round <= after.maxRounds - 1, `the check went to round ${after.round} of ${after.maxRounds}`);
    assert.equal((await storage.listAggregates("continuation-resume", { limit: 10 })).length, 0, "nothing recorded");
  });

  suite("six lost races on one write of the check are said as a busy check (unavailable), nothing is written and the check is as it was", async ({ storage, svc, owner, task, epoch }) => {
    await svc.capture(owner, { commandId: cid("c"), taskId: task, ...input(1) });
    await svc.capture(owner, { commandId: cid("c"), taskId: task, ...input(2) });
    let armed = false; let reads = 0; let writes = 0;
    // Every read of the check shows a revision that is one behind, as if another writer changed it after each read.
    const behind = new Proxy(storage, { get: (target, prop) => {
      const v = Reflect.get(target, prop) as unknown;
      if (prop === "applyOperation") return async (op: { audit: readonly { type: string }[] }) => {
        if (armed && op.audit[0]?.type === "resume.advance") writes++;
        return (target.applyOperation as (o: unknown) => Promise<unknown>).call(target, op);
      };
      if (prop === "getAggregate") return async (ref: { kind: string; id: string }) => {
        const r = await (target.getAggregate as (r: unknown) => Promise<{ revision: number } | undefined>).call(target, ref);
        if (armed && r !== undefined && ref.kind === "resume-check") { reads++; return { ...r, revision: r.revision - 1 }; }
        return r;
      };
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    } }) as typeof storage;
    const checks = ResumeCheckService.withEpoch(behind, epoch, { continuations: svc, dependencies: { check: async () => [] }, blockers: { getBlocker: async () => undefined, openBlocker: async () => ({ id: "blk-1" }) } as never, ports }, options);
    const own = await checks.start(owner, { commandId: cid("s"), taskId: task, model, after: "continue", checkpointDigest: dg(1) });
    assert.equal(own.phase, "ready");
    const was = (await storage.getAggregate({ kind: "resume-check", id: own.id }))!;
    assert.ok(was.revision > 1);
    armed = true;
    await assert.rejects(checks.commit(owner, { commandId: cid("k"), checkId: own.id }), (e: Error & { code?: string }) => e.code === "unavailable" && /6 tries/.test(e.message) && !/stale/.test(e.message));
    armed = false;
    assert.ok(reads >= 6, `the check was read ${reads} times`);
    assert.equal(writes, 6, "the write was tried six times, then given up");
    const now = (await storage.getAggregate({ kind: "resume-check", id: own.id }))!;
    assert.equal(now.revision, was.revision, "nothing was written");
    assert.equal((await storage.listAggregates("continuation-resume", { limit: 10 })).length, 0);
    assert.equal((await checks.commit(owner, { commandId: cid("k"), checkId: own.id })).phase, "done", "the same call made again goes through");
  });

  suite("a start over that loses the round to other advances on each of 6 tries is said as a busy check (unavailable), nothing is written and the same call made again goes through", async ({ storage, svc, owner, task, epoch }) => {
    await svc.capture(owner, { commandId: cid("c"), taskId: task, ...input(1) });
    await svc.capture(owner, { commandId: cid("c"), taskId: task, ...input(2) });
    // Armed once the commit has looked at the inputs: from then on every second read of the check shows it one round further on, as if another advance started it over between the start over's read
    // and its write each time.
    let state = 0; let reads = 0; let writes = 0;
    const racing = new Proxy(svc, { get: (target, prop) => {
      const v = Reflect.get(target, prop) as unknown;
      if ((prop === "latest" || prop === "forCheckpoint") && typeof v === "function") return async (...args: unknown[]) => { const r = await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args); if (state === 1) state = 2; return r; };
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    } }) as ContinuationService;
    const moving = new Proxy(storage, { get: (target, prop) => {
      const v = Reflect.get(target, prop) as unknown;
      if (prop === "applyOperation") return async (op: { audit: readonly { type: string }[] }) => {
        if (state === 2 && op.audit[0]?.type === "resume.advance") writes++;
        return (target.applyOperation as (o: unknown) => Promise<unknown>).call(target, op);
      };
      if (prop === "getAggregate") return async (ref: { kind: string; id: string }) => {
        const r = await (target.getAggregate as (r: unknown) => Promise<{ body: { round: number } } | undefined>).call(target, ref);
        if (state === 2 && r !== undefined && ref.kind === "resume-check") { reads++; if (reads % 2 === 0) return { ...r, body: { ...r.body, round: r.body.round + 1 } }; }
        return r;
      };
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    } }) as typeof storage;
    const checks = ResumeCheckService.withEpoch(moving, epoch, { continuations: racing, dependencies: { check: async () => [] }, blockers: { getBlocker: async () => undefined, openBlocker: async () => ({ id: "blk-1" }) } as never, ports }, { ...options, maxRounds: 10 });
    const own = await checks.start(owner, { commandId: cid("s"), taskId: task, model, after: "continue" });
    assert.equal(own.phase, "ready");
    const was = (await storage.getAggregate({ kind: "resume-check", id: own.id }))!;
    await svc.capture(owner, { commandId: cid("c"), taskId: task, ...input(3) });
    state = 1;
    await assert.rejects(checks.commit(owner, { commandId: cid("k"), checkId: own.id }), (e: Error & { code?: string }) => e.code === "unavailable" && /started over by other advances on each of 6 tries/.test(e.message) && /same request can be made again/.test(e.message));
    assert.equal(state, 2, "armed while the check was started over");
    assert.equal(reads, 12, "read and judged again six times, then given up");
    assert.equal(writes, 0, "no write was tried on a round that moved");
    state = 0;
    const now = (await storage.getAggregate({ kind: "resume-check", id: own.id }))!;
    assert.equal(now.revision, was.revision, "nothing was written");
    const again = await checks.commit(owner, { commandId: cid("k"), checkId: own.id });
    assert.equal(again.round, 1, "the same call made again starts it over once");
    assert.equal(again.phase, "ready");
  });

  suite("a check another advance has blocked meanwhile is not started over, and no churn blocker is opened for it", async ({ storage, svc, owner, task, epoch }) => {
    await svc.capture(owner, { commandId: cid("c"), taskId: task, ...input(1) });
    await svc.capture(owner, { commandId: cid("c"), taskId: task, ...input(2) });
    // The first commit looks at the inputs; just then a second commit of the same check starts it over, and that round blocks on an earlier effect of unknown outcome (a block with no blocker).
    let state = 0; let checks!: ResumeCheckService; let checkId = ""; let uncertain = false; const opened: string[] = [];
    const racing = new Proxy(svc, { get: (target, prop) => {
      const v = Reflect.get(target, prop) as unknown;
      if ((prop === "latest" || prop === "forCheckpoint") && typeof v === "function") return async (...args: unknown[]) => { const r = await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args); if (state === 1) state = 2; return r; };
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    } }) as ContinuationService;
    const late = new Proxy(storage, { get: (target, prop) => {
      const v = Reflect.get(target, prop) as unknown;
      if (prop === "getAggregate") return async (ref: { kind: string; id: string }) => {
        const r = await (target.getAggregate as (r: unknown) => Promise<unknown>).call(target, ref);
        // The start over's read comes after the second advance: it sees the check blocked.
        if (state === 2 && ref.kind === "resume-check") { state = 3; uncertain = true; await checks.commit(owner, { commandId: cid("k"), checkId }); return (target.getAggregate as (r: unknown) => Promise<unknown>).call(target, ref); }
        return r;
      };
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    } }) as typeof storage;
    const effects: ResumePorts = { ...ports, uncertainEffects: async () => (uncertain ? ["eff-1"] : []) };
    checks = ResumeCheckService.withEpoch(late, epoch, { continuations: racing, dependencies: { check: async () => [] }, blockers: { getBlocker: async () => undefined, openBlocker: async (c: { type: string }) => { opened.push(c.type); return { id: "blk-1" }; } } as never, ports: effects }, { ...options, maxRounds: 2 });
    const own = await checks.start(owner, { commandId: cid("s"), taskId: task, model, after: "continue" });
    checkId = own.id;
    assert.equal(own.phase, "ready");
    await svc.capture(owner, { commandId: cid("c"), taskId: task, ...input(3) });
    state = 1;
    const after = await checks.commit(owner, { commandId: cid("k"), checkId: own.id });
    assert.equal(state, 3, "the second advance ran inside the first one's window");
    assert.equal(after.phase, "blocked", JSON.stringify(after.history));
    assert.equal(after.blocked?.type, "effects_uncertain");
    assert.equal(after.round, 1, "started over once, by the second advance");
    assert.deepEqual(opened, [], "no churn blocker was opened for a check that does not name it");
  });
}
