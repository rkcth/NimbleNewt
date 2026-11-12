import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { DispatcherDeps, RouteChoice } from "./dispatcher.js";
import { routeCostWords } from "./route-cost.js";
import { buildWorld, workGrants } from "./testing/world.js";

after(stopServer);

// Card G09 follow-up: when a task's attempt runs on another model route than the task last ran on, the owner reads in the task's activity what that costs: paid or free, what the route it left was, and what the task has spent.
const choice = (route: string): RouteChoice => ({ route, harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "local-only", paidAuthorized: false } });
const TABLE = {
  providers: { local: { enabled: true, paid: false, location: "local" }, cloudp: { enabled: true, paid: true, location: "cloud" } },
  routes: { "local/small": { contextTokens: 100_000, capabilities: ["tools"] }, "cloudp/big": { contextTokens: 100_000, capabilities: ["tools"] } },
  profiles: { main: ["local/small", "cloudp/big"] }, roles: { worker: "main" },
};
const figures = (limit: number, spent: number, uncertain = 0) => ({ currency: "USD", limit: { costMicros: limit }, spent: { costMicros: spent }, uncertain: { costMicros: uncertain } });

test("the cost words: paid or free, what was left, what is spent, and unknown said as unknown", () => {
  const table = TABLE as never;
  assert.equal(routeCostWords({ table, from: "local/small", to: "cloudp/big", budget: figures(5_000_000, 1_250_000) }),
    "Cost: route cloudp/big is paid, so every call it makes is charged to this task's budget (the route it left was free: this change starts a charge). So far the task has spent 1.25 USD of its 5.0 USD limit.");
  assert.equal(routeCostWords({ table, from: "cloudp/big", to: "local/small", budget: figures(5_000_000, 1_250_000) }),
    "Cost: route local/small is free, so its calls add nothing to this task's budget (the route it left was paid: this change stops the charge).");
  assert.match(routeCostWords({ table, from: "cloudp/big", to: "cloudp/big", budget: figures(5_000_000, 0, 500_000) }), /left was paid too\)\. So far the task has spent 0.5 USD of its 5.0 USD limit \(0.5 USD of it not yet settled\)\.$/);
  assert.match(routeCostWords({ table, from: "local/small", to: "cloudp/big", budget: figures(0, 2_000_000) }), /it has no money limit\.$/);
  assert.match(routeCostWords({ table, from: "local/small", to: "cloudp/big", budget: undefined }), /has no budget record, so its spending so far is not shown\.$/);
  // A route the table does not know is not called free.
  assert.equal(routeCostWords({ table, from: "local/small", to: "mystery/x", budget: figures(1, 0) }), "Cost: route mystery/x is not in the routing table, so whether it is paid is not known. So far the task has spent 0.0 USD of its 0.000001 USD limit.");
  assert.match(routeCostWords({ table: undefined, from: undefined, to: "local/small", budget: undefined }), /not in the routing table/);
  // A provider named like an object property is not found by inheritance.
  assert.match(routeCostWords({ table, from: undefined, to: "constructor/x", budget: undefined }), /not in the routing table/);
});

for (const backend of backends) {
  test(`${backend.name}: a move to another route is told with its cost, once per attempt and move; the same route says nothing (card G09 follow-up)`, async () => {
    const store = await backend.open();
    try {
      let current = "local/small";
      const w = await buildWorld(store.storage, { route: async () => choice(current) });
      await w.routing.setTable(w.owner, { commandId: "rt-cost", expectedRevision: (await w.routing.get())?.revision ?? 0, table: TABLE } as never);
      const told: { taskId: string; summary: string }[] = [];
      const activity: NonNullable<DispatcherDeps["activity"]> = async (s) => { told.push({ taskId: s.taskId, summary: s.summary }); };
      const dispatcher = w.restart({ activity });
      const ann = await w.agent("ann", workGrants(w.project, []));
      const made = await w.task("Prune roses", ann);
      const next = async (): Promise<string> => {
        const a = (await w.assignments.getAssignment(made.taskId))!;
        return (await w.assignments.admitAttempt({ commandId: `again-${Math.random().toString(36).slice(2)}`, actor: "inbox", taskId: made.taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: "ann" }, harness: "pi" })).id;
      };
      const run = async (): Promise<void> => { await w.heartbeatHost(); await dispatcher.tick(); await dispatcher.idle(); };
      const costs = (): string[] => told.filter((t) => /moved from route/.test(t.summary)).map((t) => t.summary);
      await run();
      assert.deepEqual(costs(), [], "the first attempt has no earlier route");
      await next(); await run();
      assert.deepEqual(costs(), [], "the same route says nothing");
      // To a paid route, the task having no budget record.
      current = "cloudp/big";
      const second = await next(); await run();
      assert.equal(costs().length, 1, JSON.stringify(told));
      assert.equal(costs()[0], `Attempt ${second} moved from route local/small to route cloudp/big. Cost: route cloudp/big is paid, so every call it makes is charged to this task's budget (the route it left was free: this change starts a charge). The task has no budget record, so its spending so far is not shown.`);
      // Back to the free one: the charge stops.
      current = "local/small";
      const third = await next(); await run();
      assert.equal(costs()[1], `Attempt ${third} moved from route cloudp/big to route local/small. Cost: route local/small is free, so its calls add nothing to this task's budget (the route it left was paid: this change stops the charge).`);
      // With a budget, the figures are read from the accounting.
      await w.budgets.open(w.owner, { commandId: "bud-cost", taskId: made.taskId, currency: "USD", costMicros: 5_000_000 });
      current = "cloudp/big";
      const fourth = await next(); await run();
      assert.equal(costs()[2], `Attempt ${fourth} moved from route local/small to route cloudp/big. Cost: route cloudp/big is paid, so every call it makes is charged to this task's budget (the route it left was free: this change starts a charge). So far the task has spent 0.0 USD of its 5.0 USD limit.`);
      // Staying on the route says nothing more; every step is once.
      await next(); await run();
      assert.equal(costs().length, 3);
      // A route the table does not know is not called free.
      current = "mystery/x";
      await next(); await run();
      assert.match(costs()[3]!, /Cost: route mystery\/x is not in the routing table, so whether it is paid is not known\./);
    } finally { await store.close(); }
  });
}
