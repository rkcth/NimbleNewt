import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ContextEnforcementService, DeskService, HistoryService, RetrievalService, StartSizeService, type StartSizeSample } from "../context/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { RemoteWorkerHost } from "../remote/host.js";
import type { RemoteWorkerService } from "../remote/service.js";
import type { JsonObject } from "../storage/types.js";
import type { WorkOrder } from "./ports.js";
import { controllerGuards, estimatedFirstCall, startSizeSample, usableWindow } from "./runtime-guards.js";
import { buildWorld } from "./testing/world.js";

after(stopServer);

/**
 * Card C07i: every first call the controller's guards judge, on the local host and before a remote host is offered the order, is given to the starting-size watch with its size, its route's limit and what it is made of; a
 * route of unknown window is recorded with its size and no limit. The watch never changes the decision, and the remote host is not given the controller's measure of the order.
 */
for (const backend of backends) {
  test(`${backend.name}: the guards give the watch every first call, local and remote, admitted, refused and of unknown window, and the watch never changes a decision`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      const { storage, epoch, options } = w;
      const desks = DeskService.withEpoch(storage, epoch, options);
      const histories = HistoryService.withEpoch(storage, epoch, options);
      const retrieval = RetrievalService.withEpoch(storage, epoch, desks, histories, options);
      const context = ContextEnforcementService.withEpoch(storage, epoch, { blockers: w.blockers, retrieval }, options);
      const watch = StartSizeService.withEpoch(storage, epoch, options);
      const ann = await w.agent("ann");
      // 40000 tokens on `local/big` (a startup limit of 10000); nobody states a window for `unknown/model`.
      const hostWindow = (order: WorkOrder): number | undefined => (order.route === "local/big" ? 40_000 : undefined);
      const samples: StartSizeSample[] = [];
      const bind = (worker: "local" | "remote", failing = false) => controllerGuards({
        context, pause: w.pauses, messages: {} as never, system: w.dispatcherPrincipal,
        agent: async () => w.dispatcherPrincipal, assignee: async () => w.dispatcherPrincipal,
        window: hostWindow, routeWindow: async () => undefined,
        startSize: { worker, record: async (s) => { samples.push(s); if (failing) throw new Error("the watch is down"); await watch.record(w.dispatcherPrincipal, s); } },
      }).context!;
      const local = bind("local");
      const { taskId } = await w.task("grows", ann);
      const order = (i: number, extra: Partial<WorkOrder> = {}): WorkOrder => ({ attemptId: `att-${i}`, taskId, projectId: w.project, agentId: "agent:ann", generation: 1, harness: "pi", route: "local/big", credential: "", recipe: { revision: "r1", reach: [] }, content: "c", requestId: `req-${i}`, ...extra });
      const call = (tokens: number) => ({ systemPromptChars: 3000, toolSchemaChars: 3000, startupTokens: tokens, replyReserveTokens: 0, likelyToolOutputTokens: 0 });
      const parts = { task: 300, rules: 600, handoff: 900, view: 0, refs: [`hof-${"b".repeat(20)}`] };

      // Four hand-offs, each starting larger: the third rise is the alert, and the parts are named from the order.
      for (const [i, tokens] of [1000, 2000, 3000, 4000].entries()) assert.equal((await local.admit(order(i, { startParts: parts, resumeNote: `cut, whole text at sha256:${"c".repeat(64)}`, resumeFrom: { nn: { contextTokens: tokens - 500 } } as JsonObject }), call(tokens), 1)).admit, true);
      let read = (await watch.read(w.owner, { taskId }))!;
      assert.deepEqual(read.points.map((p) => [p.worker, p.tokens, p.limitTokens, p.admitted, p.handoff]), [["local", 3000, 10_000, true, 0], ["local", 4000, 10_000, true, 1], ["local", 5000, 10_000, true, 2], ["local", 6000, 10_000, true, 3]]);
      assert.equal(read.alerts.trend?.state, "open");
      assert.deepEqual(read.alerts.trend!.tokens, [3000, 4000, 5000, 6000]);
      // System prompt and tools 6000 characters at 3 a token; the stored conversation is the checkpoint's own figure; the hand-off paragraph 900 characters.
      const last = read.points[3]!;
      assert.deepEqual({ fixed: last.parts.fixed, conversation: last.parts.conversation, handoff: last.parts.handoff, rules: last.parts.rules, task: last.parts.task }, { fixed: 2000, conversation: 3500, handoff: 300, rules: 200, task: 100 });
      assert.deepEqual(last.refs, [`hof-${"b".repeat(20)}`, `sha256:${"c".repeat(64)}`]);
      assert.equal(read.alerts.trend!.contributors[0]!.part, "conversation", "the part that grew is named first");

      // A refused call (over the limit) is recorded as refused, with its share past 100 percent; the decision is the context service's.
      const refused = await local.admit(order(4), call(20_000), 1);
      assert.equal(refused.admit, false);
      read = (await watch.read(w.owner, { taskId }))!;
      assert.deepEqual([read.points[4]!.admitted, read.points[4]!.share], [false, 220]);
      assert.equal(read.alerts.share?.state, "open");

      // A route of unknown window: refused as before (C07n), and recorded with its size and no limit or share.
      const blind = await local.admit(order(5, { route: "unknown/model" }), call(700), 1);
      assert.equal(blind.admit, false);
      read = (await watch.read(w.owner, { taskId }))!;
      const unknown = read.points[5]!;
      assert.deepEqual([unknown.tokens, unknown.window, unknown.limitTokens, unknown.share, unknown.admitted], [2700, undefined, undefined, undefined, false]);

      // A watch that fails changes nothing: the call is admitted as it would have been.
      const { taskId: other } = await w.task("other", ann);
      assert.equal((await bind("local", true).admit({ ...order(0), taskId: other }, call(100), 1)).admit, true);

      // Remote: judged before the offer, recorded as the remote host's, and the host is not given the controller's measure of the order.
      const placed: WorkOrder[] = [];
      const remote = { place: async (_by: unknown, c: { order: WorkOrder }) => { placed.push(c.order); return { placement: 1, state: "offered" }; } } as unknown as RemoteWorkerService;
      const guards = bind("remote");
      const host = new RemoteWorkerHost("host:r1", remote, w.dispatcherPrincipal, {
        resources: { cpus: 1, memoryMb: 1024 }, requirements: () => ({ data: "cloud-allowed", harness: "pi" }),
        context: { guards, firstCall: estimatedFirstCall(context, async (o) => usableWindow(hostWindow(o))) },
      });
      const { taskId: far, attemptId } = await w.task("far", ann);
      await host.start({ ...order(0), taskId: far, attemptId: attemptId!, content: "x".repeat(3000), startParts: { task: 3000, rules: 0, handoff: 0, view: 0 } });
      assert.equal(placed.length, 1);
      assert.equal("startParts" in placed[0]!, false, "the remote host was given the controller's measure of the order");
      const { taskId: farBlind, attemptId: blindAttempt } = await w.task("far-blind", ann);
      const blindRun = await (await host.start({ ...order(0), taskId: farBlind, attemptId: blindAttempt!, route: "unknown/model", content: "y".repeat(3000) })).run({} as never);
      assert.equal(blindRun.status, "failed");
      const remotePoints = [...(await watch.read(w.owner, { taskId: far }))!.points, ...(await watch.read(w.owner, { taskId: farBlind }))!.points];
      assert.deepEqual(remotePoints.map((p) => [p.worker, p.tokens, p.limitTokens, p.admitted]), [["remote", 3000, 10_000, true], ["remote", 1000, undefined, false]], "the text, plus the route's fixed part the local calls measured; a route of no window has no fixed part to count");
      assert.equal(samples.filter((s) => s.worker === "remote").length, 2);
    } finally { await store.close(); }
  });
}

test("a startup limit of 0 (a window too small to have one) is no limit to the watch: the call is still recorded, with no share, not refused by the watch's own check", () => {
  const order = { attemptId: "att-1", taskId: "task-1", projectId: "p", agentId: "agent:a", generation: 1, route: "local/tiny", credential: "", recipe: { revision: "r1", reach: [] }, content: "c", requestId: "r" } as unknown as WorkOrder;
  const call = { systemPromptChars: 0, toolSchemaChars: 0, startupTokens: 5, replyReserveTokens: 0, likelyToolOutputTokens: 0 };
  const s = startSizeSample({ budget: () => ({ charsPerToken: 3 }) as never }, {}, order, call, "local", "1", { window: 2, tokens: 5, limit: 0, admitted: false });
  assert.equal("limitTokens" in s, false);
  assert.equal(s.window, 2);
});
