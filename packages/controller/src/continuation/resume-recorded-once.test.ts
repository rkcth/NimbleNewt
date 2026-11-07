import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { ContinuationService, ResumeCheckService, type ResumePorts } from "./index.js";

after(stopServer);
const options = { clock: () => "2026-10-28T10:00:00.000Z", pause: async () => undefined };
const DIGEST = `v1:sha256:${"a".repeat(64)}`;
const capture = {
  identity: "conv-1", agent: "agent:ann", boundary: { kind: "turn-complete" as const }, checkpoint: { format: 2, conversationId: 7, at: 41, digest: DIGEST, runtime: { name: "pi-durable", version: "1.3.0" } }, durable: { verified: true },
  continuation: { artifacts: [], decisions: [], pendingEffects: [], budget: { spent: 1, remaining: 9, unit: "k-tokens" }, nextStep: "run the tests" },
  manifest: { summaryLineage: [], sourceRanges: [{ source: "history", from: 1, to: 41 }], compression: { state: "none" as const, compactions: 0 }, branches: [], messageCursor: 41, routingRevision: 1, environmentRevision: 1, adapter: { name: "pi-durable", version: "1.3.0" } },
  nonCheckpointableTools: [], scratchRecords: [], credentialRefs: [],
};

// Card L04c: a crash during execution records one resume, whoever carries the check on afterwards (the owner's approval, then the dispatcher's start-up sweep).
for (const backend of backends) {
  test(`${backend.name}: the owner approves, the controller fails after the resume is recorded, the dispatcher's sweep finishes the check: one resume record`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: "p", actor: owner.id, name: "A" })).id;
      const task = (await projects.createTask({ commandId: "t", actor: owner.id, projectId: project, title: "one" })).id;
      const real = ContinuationService.withEpoch(world.storage, projects.epoch, options);
      await real.capture(owner, { commandId: "c1", taskId: task, ...capture });
      let crash = true;
      const continuations = {
        latest: real.latest.bind(real),
        resume: async (by: Principal, c: Parameters<ContinuationService["resume"]>[1]) => { const r = await real.resume(by, c); if (crash) { crash = false; throw new Error("crash after the resume was recorded"); } return r; },
      };
      const dependencies = { check: async () => [{ id: "dep-1", kind: "file" as const, key: "/a", status: "changed" as never, detail: "now changed" }] as never };
      const bl = { getBlocker: async () => undefined as never, openBlocker: async () => ({ id: "blk-1" }) as never };
      const ports: ResumePorts = { observe: async () => ({}), missingContext: async () => [], uncertainEffects: async () => [], review: async ({ changes }) => Object.fromEntries(changes.map((x) => [x.id, { relevant: true, rationale: "matters" }])) };
      const svc = ResumeCheckService.withEpoch(world.storage, projects.epoch, { continuations, dependencies, blockers: bl, ports }, options);
      const dispatcher = { id: "service:dispatcher", kind: "service", name: "dispatcher", grants: [] } as unknown as Principal;
      const s = await svc.start(dispatcher, { commandId: "k", taskId: task, model: { provider: "local", id: "m1" }, after: "restart" });
      assert.equal(s.phase, "ready");
      await assert.rejects(svc.approve(owner, { commandId: "a", taskId: task }), /crash/);
      const swept = await svc.sweep(dispatcher);
      assert.deepEqual(swept.failed, []);
      assert.equal((await svc.get(owner, s.id))!.phase, "done");
      const records = await world.storage.listAggregates("continuation-resume", { limit: 100 });
      assert.equal(records.length, 1, "one continuation resume recorded, not one per principal that carried the check on");
    } finally { await world.close(); }
  });
}
