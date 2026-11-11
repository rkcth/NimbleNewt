import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { IntegratorLeaseService, LEASE_LIMITS, integratorLeaseHandover } from "./index.js";

after(stopServer);

// Card L03j review: the per-task index of leases and races between holds of one task.
const MIN = 60_000;

for (const backend of backends) {
  const rig = async () => {
    const world = await backend.open();
    let now = Date.parse("2026-11-11T10:00:00.000Z");
    const clock = { clock: () => new Date(now).toISOString(), pause: async () => undefined };
    const projects = await ProjectService.open(world.storage, { holder: "c1", ...clock });
    const owner = "owner:rob";
    const project = (await projects.createProject({ commandId: "p", actor: owner, name: "A" })).id;
    const t1 = (await projects.createTask({ commandId: "t1", actor: owner, projectId: project, title: "one" })).id;
    const leases = IntegratorLeaseService.withEpoch(world.storage, projects.epoch, clock);
    return { world, leases, project, t1, tick: (ms: number) => { now += ms; } };
  };

  test(`${backend.name}: one task taking two different branches at the same moment gets both (a race on the task's index is not a refusal) (card L03j review)`, async () => {
    const r = await rig();
    try {
      for (let round = 0; round < 2; round++) {
        const results = await Promise.allSettled([0, 1, 2].map((i) => r.leases.acquire({ commandId: `a${round}-${i}`, projectId: r.project, branch: `b${round}-${i}`, holder: "agt-a", taskId: r.t1, ttlMs: 10 * MIN })));
        for (const x of results) assert.equal(x.status, "fulfilled", x.status === "rejected" ? String((x as PromiseRejectedResult).reason) : "");
      }
      assert.equal((await r.leases.forTask(r.t1)).length, 6, "every hold is listed for the task");
    } finally { await r.world.close(); }
  });

  test(`${backend.name}: a hand-off's release that races the holder's renew still releases (a lost race is not a final "fenced" skip that leaves the hold with the sender) (card L03j review)`, async () => {
    const r = await rig();
    try {
      const port = integratorLeaseHandover(r.leases);
      for (let i = 0; i < 6; i++) {
        const l = await r.leases.acquire({ commandId: `a${i}`, projectId: r.project, branch: "integration", holder: "agt-a", taskId: r.t1, ttlMs: 10 * MIN });
        const [, released] = await Promise.allSettled([
          r.leases.renew({ commandId: `rn${i}`, leaseId: l.leaseId, fence: l.fence, holder: "agt-a" }),
          port.release({ commandId: `rl${i}`, leaseId: l.leaseId, fence: l.fence, note: "hand-off" }),
        ]);
        assert.equal(released.status, "fulfilled", String((released as PromiseRejectedResult).reason));
        assert.deepEqual((released as PromiseFulfilledResult<unknown>).value, { outcome: "released" });
        assert.equal((await r.leases.get(l.leaseId))!.state, "released");
      }
    } finally { await r.world.close(); }
  });

  test(`${backend.name}: a lease handed over to another task no longer counts against the task it left (card L03j review)`, async () => {
    const r = await rig();
    try {
      const t2 = "task-zzzzzzzzzzzzzzzzzzzz";
      const ids: string[] = [];
      for (let i = 0; i < LEASE_LIMITS.perTask; i++) ids.push((await r.leases.acquire({ commandId: `l${i}`, projectId: r.project, branch: `b-${i}`, holder: "agt-a", taskId: r.t1, ttlMs: 10 * MIN })).leaseId);
      await r.leases.handOver({ commandId: "ho", leaseId: ids[0]!, fence: 1, to: "agt-b", taskId: t2 });
      const extra = await r.leases.acquire({ commandId: "extra", projectId: r.project, branch: "extra", holder: "agt-a", taskId: r.t1, ttlMs: 10 * MIN });
      assert.deepEqual((await r.leases.forTask(r.t1)).map((l) => l.leaseId).sort(), [...ids.slice(1), extra.leaseId].sort());
      assert.deepEqual((await r.leases.forTask(t2)).map((l) => l.leaseId), [ids[0]]);
    } finally { await r.world.close(); }
  });

  test(`${backend.name}: the task's index never drops a live lease: old ones that ended make room, and a task already holding the most live leases is refused a new one (card L03j review)`, async () => {
    const r = await rig();
    try {
      const first = await r.leases.acquire({ commandId: "old", projectId: r.project, branch: "old", holder: "agt-a", taskId: r.t1, ttlMs: 10 * MIN });
      await r.leases.release({ commandId: "old-rl", leaseId: first.leaseId, fence: 1 });
      const live: string[] = [];
      for (let i = 0; i < LEASE_LIMITS.perTask; i++) live.push((await r.leases.acquire({ commandId: `l${i}`, projectId: r.project, branch: `live-${i}`, holder: "agt-a", taskId: r.t1, ttlMs: 10 * MIN })).leaseId);
      assert.deepEqual((await r.leases.forTask(r.t1)).map((l) => l.leaseId).sort(), [...live].sort(), "the released one made room; every live one is listed");
      await assert.rejects(r.leases.acquire({ commandId: "one-more", projectId: r.project, branch: "one-more", holder: "agt-a", taskId: r.t1, ttlMs: 10 * MIN }), (e: unknown) => e instanceof DomainError && e.code === "unavailable" && /at most/.test(e.message));
      assert.equal((await r.leases.get(IntegratorLeaseService.leaseIdOf(r.project, "one-more"))), undefined, "a refused acquire leaves no lease nobody can find");
      assert.deepEqual((await r.leases.forTask(r.t1)).map((l) => l.leaseId).sort(), [...live].sort(), "nothing live was pruned");
      // Once one expires there is room again.
      r.tick(11 * MIN);
      const again = await r.leases.acquire({ commandId: "after", projectId: r.project, branch: "one-more", holder: "agt-a", taskId: r.t1, ttlMs: 10 * MIN });
      assert.deepEqual((await r.leases.forTask(r.t1)).map((l) => l.leaseId), [again.leaseId]);
    } finally { await r.world.close(); }
  });
}
