import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkOrder } from "../dispatch/ports.js";
import { LaunchLimitError } from "../environments/index.js";
import type { Principal } from "../security/index.js";
import { RemoteWorkerHost } from "./host.js";
import { checkContract, sealContract } from "./contract.js";
import type { RemoteWorkerService } from "./service.js";

// Card A08d: the limits the dispatcher worked out for the launch (the agent's environment cut by the installation's) reach a remote worker in the sealed contract, with the owner's limits and best-effort setting as they stand now:
// the smaller of each figure, so neither side's tighter figure is lost and the digest still matches.

const base = (): WorkOrder => ({ attemptId: "att-aaaaaaaaaaaaaaaaaaaa", taskId: "task-aaaaaaaaaaaaaaaaaaaa", projectId: "proj-aaaaaaaaaaaaaaaaaaaa", agentId: "agent:ann", generation: 1, route: "cloud/small", credential: "", recipe: { revision: "r1", reach: [] }, content: "x", requestId: "req-1" });
const host = (owner: { limits?: Record<string, number>; bestEffort?: boolean } | undefined) => {
  const placed: WorkOrder[] = [];
  const remote = { place: async (_by: unknown, c: { order: WorkOrder }) => { placed.push(c.order); return { placement: 1, state: "offered" }; } } as unknown as RemoteWorkerService;
  const h = new RemoteWorkerHost("host:r1", remote, {} as Principal, { resources: { cpus: 1, memoryMb: 1024 }, requirements: () => ({ data: "cloud-allowed", harness: "pi" }), ...(owner === undefined ? {} : { ownerPolicy: { limits: async () => owner.limits as never, bestEffort: async () => owner.bestEffort === true } }) });
  return { h, placed };
};
const sealed = (limits?: Record<string, number>): WorkOrder => sealContract(base(), { taskContractVersion: 1, permissions: [], bestEffort: false, ...(limits === undefined ? {} : { limits }) });

test("the order's contract carries the smaller of the dispatcher's figure and the owner's, per figure, sealed again with a matching digest", async () => {
  const { h, placed } = host({ limits: { cpus: 4, memoryMb: 256, wallTimeMs: 60_000 }, bestEffort: true });
  await h.start(sealed({ cpus: 2, memoryMb: 1024, diskMb: 500 }));
  const c = placed[0]!.contract!;
  assert.deepEqual(c.limits, { cpus: 2, memoryMb: 256, diskMb: 500, wallTimeMs: 60_000 });
  assert.equal(c.bestEffort, true);
  assert.deepEqual(c.requires.slice().sort(), ["limits", "wall-time"]);
  assert.doesNotThrow(() => checkContract(placed[0]!), "the digest matches the order it came with");
});

test("an owner with no limits leaves the dispatcher's figures; no owner policy leaves the order as it came; the owner's alone is carried as before", async () => {
  const none = host({});
  await none.h.start(sealed({ processes: 10 }));
  assert.deepEqual(none.placed[0]!.contract!.limits, { processes: 10 });
  const bare = host(undefined);
  const given = sealed({ processes: 10 });
  await bare.h.start(given);
  assert.deepEqual(bare.placed[0]!.contract, given.contract);
  const only = host({ limits: { memoryMb: 128 } });
  await only.h.start(sealed());
  assert.deepEqual(only.placed[0]!.contract!.limits, { memoryMb: 128 });
});

test("a figure that is not valid, on either side, offers nothing", async () => {
  const bad = host({ limits: { cpus: 1 } });
  const order = sealed({ cpus: 2 });
  const forged = { ...order, contract: { ...order.contract!, limits: { cpus: Number.NaN } } } as WorkOrder;
  await assert.rejects(() => bad.h.start(forged), LaunchLimitError);
  const owner = host({ limits: { memoryMb: 0 } });
  await assert.rejects(() => owner.h.start(sealed({ cpus: 2 })), LaunchLimitError);
  assert.equal(bad.placed.length + owner.placed.length, 0);
});
