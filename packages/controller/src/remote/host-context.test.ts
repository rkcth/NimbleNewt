import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ContextEnforcementService, DeskService, HistoryService, RetrievalService } from "../context/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { WorkOrder } from "../dispatch/ports.js";
import { controllerGuards, estimatedFirstCall, usableWindow } from "../dispatch/runtime-guards.js";
import { buildWorld } from "../dispatch/testing/world.js";
import type { JsonObject } from "../storage/types.js";
import { RemoteWorkerHost } from "./host.js";
import type { RemoteWorkerService } from "./service.js";

after(stopServer);

/**
 * Card C07o: a remote host's first call and stored conversation are judged by the controller before the order is offered, with the local worker's guards and records (C07b, C07n). The remote service here only records
 * what it was asked to place: what matters is whether the host would have been offered the order at all, and with which conversation.
 */
for (const backend of backends) {
  test(`${backend.name}: before a remote host is offered an order, an oversized first call is refused with a blocker and an admission record, a fitting one is offered, a stored conversation is judged, and a route of no window is refused`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      const { storage, epoch, options } = w;
      const desks = DeskService.withEpoch(storage, epoch, options);
      const histories = HistoryService.withEpoch(storage, epoch, options);
      const retrieval = RetrievalService.withEpoch(storage, epoch, desks, histories, options);
      const context = ContextEnforcementService.withEpoch(storage, epoch, { blockers: w.blockers, retrieval }, options);
      const ann = await w.agent("ann");
      // The operator's window for the host: 4096 tokens (a first call of at most 1024 tokens, a stored conversation of at most the resume share) on `localp/small`; nobody states one for `unknown/model`.
      const hostWindow = (order: WorkOrder): number | undefined => (order.route === "localp/small" ? 4096 : undefined);
      const guards = controllerGuards({
        context, pause: w.pauses, messages: {} as never, system: w.dispatcherPrincipal,
        agent: async () => w.dispatcherPrincipal, assignee: async () => w.dispatcherPrincipal,
        window: hostWindow, routeWindow: async () => undefined,
      }).context!;
      const placed: WorkOrder[] = [];
      const remote = { place: async (_by: unknown, c: { order: WorkOrder }) => { placed.push(c.order); return { placement: 1, state: "offered" }; } } as unknown as RemoteWorkerService;
      const reported: string[] = [];
      const host = new RemoteWorkerHost("host:r1", remote, w.dispatcherPrincipal, {
        resources: { cpus: 1, memoryMb: 1024 }, requirements: () => ({ data: "cloud-allowed", harness: "pi" }),
        context: { guards, firstCall: estimatedFirstCall(context, async (o) => usableWindow(hostWindow(o))) },
        onGuardError: (_a, what, e) => { reported.push(`${what}: ${(e as Error).message}`); },
      });
      let n = 0;
      const orderFor = async (content: string, extra: Partial<WorkOrder> = {}): Promise<WorkOrder> => {
        const { taskId, attemptId } = await w.task(`t${n++}`, ann);
        return { attemptId: attemptId!, taskId, projectId: w.project, agentId: "agent:ann", generation: 1, harness: "pi", route: "localp/small", credential: "", recipe: { revision: "r1", reach: [] }, content, requestId: `req-${n}`, ...extra };
      };
      const admissions = async (taskId: string) => (await storage.listAggregates("ctx-admission", { limit: 50 })).map((a) => a.body as unknown as { taskId: string; admit: boolean; type: string }).filter((b) => b.taskId === taskId);

      // A first call of a million tokens: nothing is offered, the refusal is recorded like the local worker's, and the owner has a context_overflow blocker on the task.
      const big = await orderFor("x".repeat(3_000_000));
      const refused = await host.start(big);
      const result = await refused.run({} as never);
      assert.equal(result.status, "failed");
      assert.match(result.error ?? "", /^the first call was not sent: .*startup limit of 1024/, result.error);
      assert.equal(placed.length, 0, "an oversized first call was offered to the remote host");
      assert.deepEqual((await admissions(big.taskId)).map((a) => [a.type, a.admit]), [["first-call", false]]);
      assert.ok(await w.blockers.openFor("context_overflow", { kind: "task", id: big.taskId }), "no context_overflow blocker for the refused first call");

      // A first call that fits is offered as it is, and its admission is on record.
      const small = await orderFor("Order the seeds for spring.");
      await host.start(small);
      assert.equal(placed.length, 1);
      assert.equal(placed[0]!.content, small.content);
      assert.deepEqual((await admissions(small.taskId)).map((a) => [a.type, a.admit]), [["first-call", true]]);
      assert.equal(await w.blockers.openFor("context_overflow", { kind: "task", id: small.taskId }), undefined);

      // A stored conversation that fits the resume share is carried, and counts in the first call.
      const fits = await orderFor("Go on.", { resumeFrom: { turn: 3, nn: { contextTokens: 200 } } as JsonObject });
      await host.start(fits);
      assert.deepEqual(placed.at(-1)!.resumeFrom, { turn: 3, nn: { contextTokens: 200 } });
      assert.equal(placed.at(-1)!.resumeNote, undefined);
      // One over the resume share is not carried: the host is offered a fresh start, and the agent is told why.
      const over = await orderFor("Go on.", { resumeFrom: { turn: 9, nn: { contextTokens: 100_000 } } as JsonObject, resumeNote: "two calls were approved" });
      await host.start(over);
      assert.equal(placed.at(-1)!.attemptId, over.attemptId);
      assert.equal(placed.at(-1)!.resumeFrom, undefined, "a stored conversation over the resume share was carried to the remote host");
      assert.match(placed.at(-1)!.resumeNote ?? "", /^two calls were approved\nthe stored conversation is 100000 tokens, over \d+ .*starting fresh/);
      // One whose size nobody says is not carried either, and the host's report says so.
      const unsized = await orderFor("Go on.", { resumeFrom: { turn: 2 } as JsonObject });
      await host.start(unsized);
      assert.equal(placed.at(-1)!.resumeFrom, undefined);
      assert.match(placed.at(-1)!.resumeNote ?? "", /size of the stored conversation is not known/);
      assert.ok(reported.some((r) => /resume decision: the checkpoint does not say/.test(r)), JSON.stringify(reported));
      // A stored conversation that fits on its own but makes the first call too large is refused with the first call.
      const crowded = await orderFor("y".repeat(1500), { resumeFrom: { turn: 4, nn: { contextTokens: 900 } } as JsonObject });
      const crowdedRun = await (await host.start(crowded)).run({} as never);
      assert.equal(crowdedRun.status, "failed");
      assert.notEqual(placed.at(-1)!.attemptId, crowded.attemptId);

      // A route nobody gives a window for: refused before the offer, the blocker names the route, nothing was measured.
      const blind = await orderFor("Order the seeds.", { route: "unknown/model", resumeFrom: { turn: 1, nn: { contextTokens: 10 } } as JsonObject });
      const blindRun = await (await host.start(blind)).run({} as never);
      assert.equal(blindRun.status, "failed");
      assert.match(blindRun.error ?? "", /unknown\/model.*no context window.*set its window/s, blindRun.error);
      assert.notEqual(placed.at(-1)!.attemptId, blind.attemptId);
      assert.deepEqual(await admissions(blind.taskId), [], "a call of no known window was judged against one");
      const blocker = await w.blockers.openFor("context_overflow", { kind: "task", id: blind.taskId });
      assert.ok(blocker);
      assert.equal(placed.length, 4, "only the fitting orders were offered");
    } finally { await store.close(); }
  });
}
