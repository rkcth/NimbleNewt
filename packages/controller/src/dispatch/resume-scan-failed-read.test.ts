import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { ContractService } from "../planning/contracts.js";
import type { ControllerStorage } from "../storage/types.js";
import { buildWorld, workGrants } from "./testing/world.js";

after(stopServer);

// Card L04d (follow-ups, tests only): the per-tick scan of dependency records. A read that failed is not kept in the scan, so it fails the one task that asked and not every later task of the tick.
const failing = (storage: ControllerStorage, fails: { left: number }): ControllerStorage => new Proxy(storage, { get: (target, prop) => {
  const v = Reflect.get(target, prop) as unknown;
  if (prop === "listAggregates") return async (kind: string, ...rest: unknown[]) => {
    if (kind === "task-dep" && fails.left > 0) { fails.left--; throw new Error("the disk hiccuped"); }
    return (target.listAggregates as (...a: unknown[]) => unknown).call(target, kind, ...rest);
  };
  return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
} });

for (const backend of backends) {
  const suite = (name: string, body: (c: Awaited<ReturnType<typeof buildWorld>>, store: Awaited<ReturnType<typeof backend.open>>) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const store = await backend.open();
      try { await body(await buildWorld(store.storage), store); } finally { await store.close(); }
    });

  suite("a failed read of the dependency records is not kept in the scan: the next ask reads again and succeeds", async (c, store) => {
    const ann = await c.agent("ann", workGrants(c.project, []));
    const a = await c.task("needs", ann);
    const b = await c.task("base", ann);
    await c.contracts.addDependency(c.owner, { commandId: "dep-1", taskId: a.taskId, prerequisiteId: b.taskId });
    const fails = { left: 1 };
    const flaky = ContractService.withEpoch(failing(store.storage, fails), c.epoch, { clock: c.options.clock! });
    const scan = new Map<string, unknown>();
    await assert.rejects(flaky.prerequisitesOf(a.taskId, scan), (e: Error & { code?: string }) => e.code === "unavailable");
    assert.equal(scan.size, 0, "the failed read was dropped from the scan");
    assert.deepEqual((await flaky.prerequisitesOf(a.taskId, scan))?.dependsOn.map((x) => x.taskId), [b.taskId], "the next ask reads again");
    assert.equal(scan.size, 1);
  });

  suite("in one tick a failed read holds back only the task that asked; the next task of the tick reads the records again", async (c, store) => {
    const ann = await c.agent("ann", workGrants(c.project, []));
    const one = await c.task("one", ann);
    const two = await c.task("two", ann);
    const base = await c.task("base", ann, { admit: false });
    for (const t of [one, two]) await c.contracts.addDependency(c.owner, { commandId: `dep-${t.taskId}`, taskId: t.taskId, prerequisiteId: base.taskId });
    const fails = { left: 1 };
    const flaky = ContractService.withEpoch(failing(store.storage, fails), c.epoch, { clock: c.options.clock! });
    const d = c.restart({ prerequisites: async (taskId, scan) => {
      const got = await flaky.prerequisitesOf(taskId, scan);
      return got === undefined ? [] : got.dependsOn.filter((x) => x.state !== "done").map((x) => `${x.taskId} (${x.state})`);
    } });
    c.worker.script = async () => ({ status: "completed", text: "done" });
    const t = await d.tick();
    await d.idle();
    assert.deepEqual(t.started, []);
    assert.equal(fails.left, 0, "the read was made and failed once");
    const reasons = t.skipped.filter((s) => s.check === "dependency").map((s) => s.reason);
    assert.equal(reasons.length, 2, JSON.stringify(t.skipped));
    assert.equal(reasons.filter((r) => /dependencies could not be read/.test(r)).length, 1, `exactly one task met the failed read: ${JSON.stringify(reasons)}`);
    assert.equal(reasons.filter((r) => /waiting for .* to be complete/.test(r)).length, 1, `the other read the records again and saw the unfinished prerequisite: ${JSON.stringify(reasons)}`);
  });
}
