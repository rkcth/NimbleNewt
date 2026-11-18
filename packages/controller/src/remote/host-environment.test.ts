import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkOrder } from "../dispatch/ports.js";
import { RemoteWorkerHost } from "./host.js";
import type { RemoteWorkerService } from "./service.js";

/** Card A09 sixth slice: a remote host has no environment runtime, so the revision an attempt is pinned to stays on the controller's side (as the starting-size parts do) and is not offered to the host. */
test("an order offered to a remote host does not carry the environment revision pin", async () => {
  const placed: WorkOrder[] = [];
  const remote = { place: async (_by: unknown, c: { order: WorkOrder }) => { placed.push(c.order); return { placement: 1, state: "offered" }; } } as unknown as RemoteWorkerService;
  const host = new RemoteWorkerHost("host:r1", remote, {} as never, { resources: { cpus: 1, memoryMb: 1024 }, requirements: () => ({ data: "cloud-allowed", harness: "pi" }) } as never);
  const order: WorkOrder = { attemptId: "att-aaaaaaaaaaaaaaaaaaaa", taskId: "tsk-aaaaaaaaaaaaaaaaaaaa", projectId: "prj-aaaaaaaaaaaaaaaaaaaa", agentId: "agent:ann", generation: 1, harness: "pi", route: "localp/small", credential: "", recipe: { revision: "r1", reach: [] }, content: "do it", requestId: "req-1", environmentRevision: 3 };
  await host.start(order);
  assert.equal(placed.length, 1);
  assert.equal("environmentRevision" in placed[0]!, false);
  assert.equal(placed[0]!.agentId, "agent:ann");
});

/** Card G09 (remote path): the selected updates go with the offer, as given; an order without any is offered without the field. */
test("an order offered to a remote host carries its selected updates as given, and an order without updates is offered without the field", async () => {
  const placed: WorkOrder[] = [];
  const remote = { place: async (_by: unknown, c: { order: WorkOrder }) => { placed.push(c.order); return { placement: 1, state: "offered" }; } } as unknown as RemoteWorkerService;
  const host = new RemoteWorkerHost("host:r1", remote, {} as never, { resources: { cpus: 1, memoryMb: 1024 }, requirements: () => ({ data: "cloud-allowed", harness: "pi" }) } as never);
  const base: WorkOrder = { attemptId: "att-aaaaaaaaaaaaaaaaaaaa", taskId: "tsk-aaaaaaaaaaaaaaaaaaaa", projectId: "prj-aaaaaaaaaaaaaaaaaaaa", agentId: "agent:ann", generation: 1, harness: "pi", route: "localp/small", credential: "", recipe: { revision: "r1", reach: [] }, content: "do it", requestId: "req-1" };
  const updates = [{ requestId: "upd:cbr-1:2", text: "Owner correction: use plan B.", origin: "side line cbr-1, desk record dsk-2, update 2" }];
  await host.start({ ...base, contextUpdates: updates });
  await host.start(base);
  assert.deepEqual(placed[0]!.contextUpdates, updates);
  assert.equal("contextUpdates" in placed[1]!, false);
});
