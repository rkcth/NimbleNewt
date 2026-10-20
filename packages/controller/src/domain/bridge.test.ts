import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ArtifactService, FileBlobStore } from "../artifacts/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AssignmentService, BlockerService, ConversationBridge, DomainError, InboxService, RecoveryPoints, assignmentEventId, derivedId, operationIdOf,
  type BridgeResult, type ConversationSubmitter, type DomainErrorCode, type Owner,
} from "./index.js";
import { ProjectService } from "./service.js";
import { backends, stopServer, type World } from "./testing/backends.js";

after(stopServer);

const T = "2026-10-20T10:00:00.000Z";
const options = { clock: () => T, pause: async () => undefined };
const me = "rob";
const ann: Owner = { kind: "agent", id: "ann" };
const bob: Owner = { kind: "agent", id: "bob" };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;

const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};

/** A conversation that remembers settled requests (idempotent by request ID) and counts how often it was asked to run one. */
function conversation(extra: Partial<ConversationSubmitter> = {}) {
  const settled = new Map<string, BridgeResult>();
  const calls: { requestId: string; content: string }[] = [];
  let recovered = 0;
  const port: ConversationSubmitter = {
    submit: async (request) => {
      calls.push(request);
      if (!settled.has(request.requestId)) settled.set(request.requestId, { status: "completed", text: "done: " + request.content.split("\n")[0] });
      return { result: async () => settled.get(request.requestId)! };
    },
    lookup: async (id) => settled.get(id),
    recover: async () => { recovered += 1; },
    checkpoint: async () => ({ at: calls.length }),
    ...extra,
  };
  return { port, calls, settled, recovered: () => recovered };
}

for (const backend of backends) {
  const suite = (name: string, body: (ctx: { projects: ProjectService; assign: AssignmentService; inbox: InboxService; blockers: BlockerService; world: World; epoch: number }) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const assign = AssignmentService.withEpoch(world.storage, projects.epoch, projects, options);
        await body({ projects, assign, inbox: InboxService.withEpoch(world.storage, projects.epoch, assign, options), blockers: BlockerService.withEpoch(world.storage, projects.epoch, options), world, epoch: projects.epoch });
      } finally { await world.close(); }
    });
  /** A task assigned to ann with her attempt admitted through the inbox. */
  const admitted = async (ctx: { projects: ProjectService; assign: AssignmentService; inbox: InboxService; world: World }, title = "Order seeds") => {
    const p = await ctx.projects.createProject({ commandId: cid("p"), actor: me, name: "G" });
    const t = await ctx.projects.createTask({ commandId: cid("t"), actor: me, projectId: p.id, title, description: "from the supplier" });
    await ctx.projects.transitionTask({ commandId: cid("r"), actor: me, taskId: t.id, expectedRevision: 1, to: "ready" });
    await ctx.assign.assignTask({ commandId: cid("a"), actor: me, taskId: t.id, owner: ann });
    const d = (await ctx.world.storage.getDelivery(assignmentEventId(t.id, 1)))!;
    const m = await ctx.inbox.receive({ source: "worker-1", deliveryId: d.deliveryId, payload: d.payload });
    const adm = await ctx.inbox.admitAssignment({ commandId: cid("adm"), actor: "w", messageId: m.id });
    return { taskId: t.id, messageId: m.id, attemptId: adm.attemptId!, projectId: p.id };
  };

  suite("the bridge submits an admitted attempt's work once, under the admission's operation ID, and a repeat returns the original", async (ctx) => {
    const { taskId, messageId, attemptId } = await admitted(ctx);
    const c = conversation();
    const bridge = new ConversationBridge(ctx, c.port);
    const first = await bridge.run(messageId);
    assert.deepEqual([first.requestId, first.attemptId, first.status, first.text, first.checkpoint], [operationIdOf(`adm:${messageId}`), attemptId, "completed", "done: Order seeds", { at: 1 }]);
    assert.equal(c.calls[0]!.content, "Order seeds\n\nfrom the supplier");
    const again = await bridge.run(messageId);
    assert.equal(again.requestId, first.requestId);
    assert.equal(new Set(c.calls.map((x) => x.requestId)).size, 1, "one request, however often it is asked for");
    void taskId;
    await refuses("not_found", () => bridge.run("inb-aaaaaaaaaaaaaaaaaaaa"));
  });

  suite("a message that is not admitted yet is refused before anything is submitted", async (ctx) => {
    const p = await ctx.projects.createProject({ commandId: cid("p"), actor: me, name: "G" });
    const t = await ctx.projects.createTask({ commandId: cid("t"), actor: me, projectId: p.id, title: "x" });
    await ctx.assign.assignTask({ commandId: cid("a"), actor: me, taskId: t.id, owner: ann });
    const d = (await ctx.world.storage.getDelivery(assignmentEventId(t.id, 1)))!;
    const m = await ctx.inbox.receive({ source: "worker-1", deliveryId: d.deliveryId, payload: d.payload });
    const c = conversation();
    await refuses("invalid_command", () => new ConversationBridge(ctx, c.port).run(m.id), (e) => assert.match(e.message, /admit it first/));
    assert.equal(c.calls.length, 0);
  });

  suite("work of an attempt that is no longer the current one is not submitted, unless the runtime already finished it", async (ctx) => {
    const { taskId, messageId } = await admitted(ctx);
    // Ownership moves to bob: ann's attempt is superseded.
    await ctx.assign.transferTask({ commandId: cid("tr"), actor: me, taskId, expectedRevision: 2, to: bob });
    const fresh = conversation();
    await refuses("fenced", () => new ConversationBridge(ctx, fresh.port).run(messageId), (e) => assert.match(e.message, /superseded/));
    assert.equal(fresh.calls.length, 0, "the model was not asked to run work nobody owns");
    // If the runtime had already finished that request before ownership moved, the original is returned and nothing runs.
    const done = conversation();
    done.settled.set(operationIdOf(`adm:${messageId}`), { status: "completed", text: "finished earlier" });
    const replay = await new ConversationBridge(ctx, done.port).run(messageId);
    assert.deepEqual([replay.text, done.calls.length], ["finished earlier", 0]);
  });

  suite("interrupted work that is all this request's own is resumed; anything else leaves the runtime held and opens a blocker", async (ctx) => {
    const { messageId, attemptId } = await admitted(ctx);
    const own = operationIdOf(`adm:${messageId}`);
    const mine = conversation({ interrupted: async () => ({ held: true, requestIds: [own] }) });
    await new ConversationBridge(ctx, mine.port).run(messageId);
    assert.equal(mine.recovered(), 1, "resumed");
    assert.equal(mine.calls.length, 1);

    const second = await admitted(ctx, "Other task");
    const theirs = conversation({ interrupted: async () => ({ held: true, requestIds: ["cmd:adm:somebody-else", operationIdOf(`adm:${second.messageId}`)] }) });
    await refuses("unavailable", () => new ConversationBridge({ ...ctx, blockers: ctx.blockers }, theirs.port).run(second.messageId), (e) => assert.match(e.message, /not demonstrably this attempt's/));
    assert.deepEqual([theirs.recovered(), theirs.calls.length], [0, 0], "nothing was resumed or submitted");
    const blocker = (await ctx.blockers.openFor("runtime_hold", { kind: "attempt", id: second.attemptId }))!;
    assert.match(blocker.summary, /cmd:adm:somebody-else/);
    assert.equal(blocker.resolver, "owner");
    void attemptId;
    // A runtime that is not held is not touched.
    const calm = conversation({ interrupted: async () => ({ held: false, requestIds: [] }) });
    await new ConversationBridge(ctx, calm.port).run(messageId);
    assert.equal(calm.recovered(), 0);
  });

  suite("a held runtime whose unfinished work cannot be shown to be this request's is never resumed", async (ctx) => {
    const { messageId, attemptId } = await admitted(ctx);
    for (const [label, state] of [["no request named", { held: true, requestIds: [] as string[] }], ["unattributable work", { held: true, requestIds: [operationIdOf(`adm:${messageId}`)], unattributed: 2 }], ["only someone else's request", { held: true, requestIds: ["cmd:adm:other"] }]] as const) {
      const c = conversation({ interrupted: async () => state });
      await refuses("unavailable", () => new ConversationBridge(ctx, c.port).run(messageId), (e) => assert.match(e.message, /not demonstrably this attempt's/));
      assert.deepEqual([c.recovered(), c.calls.length], [0, 0], label);
    }
    assert.ok(await ctx.blockers.openFor("runtime_hold", { kind: "attempt", id: attemptId }), "a blocker names it");
  });

  suite("a conversation that does not complete the request is reported, not recorded", async (ctx) => {
    const { messageId } = await admitted(ctx);
    const failing = conversation({ submit: async () => ({ result: async () => ({ status: "aborted" }) }) });
    await refuses("unavailable", () => new ConversationBridge(ctx, failing.port).run(messageId), (e) => assert.match(e.message, /aborted/));
  });

  suite("recovery points: validated, checked against what exists, one per attempt, found by attempt", async (ctx) => {
    const { taskId, attemptId, projectId, messageId } = await admitted(ctx);
    const dir = mkdtempSync(join(tmpdir(), "nn rp-"));
    try {
      const blobs = await FileBlobStore.open({ directory: join(dir, "blobs") });
      const artifacts = ArtifactService.withEpoch(ctx.world.storage, ctx.epoch, blobs, options);
      const art = await artifacts.publish({ commandId: cid("art"), actor: "w", name: "out", projectId, taskId, files: [{ path: "a.txt", content: Buffer.from("x") }] });
      const points = new RecoveryPoints(ctx.world.storage, ctx.epoch, options);
      const good = { commandId: "rp-1", actor: "w", attemptId, taskId, requestIds: [operationIdOf(`adm:${messageId}`)], artifactId: art.id, checkpoint: { at: 1 }, resultText: "done" };
      const first = await points.record(good);
      assert.deepEqual(await points.record(good), { ...first, replayed: true });
      const found = (await points.forAttempt(attemptId))!;
      assert.deepEqual([found.artifactId, found.requestIds, found.resultText, found.checkpoint], [art.id, good.requestIds, "done", { at: 1 }]);
      assert.equal(await points.forAttempt(derivedId("att", "nobody")), undefined);
      await refuses("invalid_command", () => points.record({ ...good, commandId: "rp-2", resultText: "other" }), (e) => assert.match(e.message, /already has a recovery point/));
      const fresh = await admitted(ctx, "another");
      const bad = (extra: Record<string, unknown>) => points.record({ ...good, commandId: cid("bad"), attemptId: fresh.attemptId, taskId: fresh.taskId, ...extra } as never);
      await refuses("invalid_command", () => bad({ attemptId: "nope" }));
      await refuses("invalid_command", () => bad({ taskId: "nope" }));
      await refuses("invalid_command", () => bad({ artifactId: "nope" }));
      await refuses("invalid_command", () => bad({ requestIds: [] }));
      await refuses("invalid_command", () => bad({ requestIds: [""] }));
      await refuses("invalid_command", () => bad({ checkpoint: { big: "x".repeat(200_000) } }));
      await refuses("not_found", () => bad({ artifactId: derivedId("art", "missing") }));
      await refuses("not_found", () => bad({ taskId }), (e) => assert.match(e.message, /of task/));
    } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  });
}
