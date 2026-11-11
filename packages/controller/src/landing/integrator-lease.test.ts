import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { IntegratorLeaseService, describeLeases, integratorLeaseHandover } from "./index.js";

after(stopServer);

// Card L03j: the integrator lease of a landing branch (the first part of P10's fenced, expiring lease).
const MIN = 60_000;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); return true; });
};

for (const backend of backends) {
  const rig = async () => {
    const world = await backend.open();
    let now = Date.parse("2026-11-11T10:00:00.000Z");
    const clock = { clock: () => new Date(now).toISOString(), pause: async () => undefined };
    const projects = await ProjectService.open(world.storage, { holder: "c1", ...clock });
    const owner = "owner:rob";
    const project = (await projects.createProject({ commandId: "p", actor: owner, name: "A" })).id;
    const t1 = (await projects.createTask({ commandId: "t1", actor: owner, projectId: project, title: "one" })).id;
    const t2 = (await projects.createTask({ commandId: "t2", actor: owner, projectId: project, title: "two" })).id;
    const leases = IntegratorLeaseService.withEpoch(world.storage, projects.epoch, clock);
    return { world, leases, project, t1, t2, tick: (ms: number) => { now += ms; } };
  };

  test(`${backend.name}: one integrator per branch; a race has one winner; a lost integrator frees the lease after it expires and the next holder gets a new fence (card L03j)`, async () => {
    const r = await rig();
    try {
      const [x, y] = await Promise.allSettled([
        r.leases.acquire({ commandId: "a1", projectId: r.project, branch: "integration", holder: "agt-a", taskId: r.t1, ttlMs: 10 * MIN }),
        r.leases.acquire({ commandId: "b1", projectId: r.project, branch: "integration", holder: "agt-b", taskId: r.t2, ttlMs: 10 * MIN }),
      ]);
      const won = [x, y].filter((p) => p.status === "fulfilled");
      const lost = [x, y].filter((p) => p.status === "rejected") as PromiseRejectedResult[];
      assert.equal(won.length, 1, "never two integrators on one branch");
      assert.ok(lost[0]!.reason instanceof DomainError && lost[0]!.reason.code === "unavailable", String(lost[0]?.reason));
      const held = (won[0] as PromiseFulfilledResult<Awaited<ReturnType<IntegratorLeaseService["acquire"]>>>).value;
      assert.equal(held.fence, 1);
      const other = held.holder === "agt-a" ? { holder: "agt-b", taskId: r.t2 } : { holder: "agt-a", taskId: r.t1 };
      await refuses("unavailable", () => r.leases.acquire({ commandId: "c1", projectId: r.project, branch: "integration", ...other, ttlMs: 10 * MIN }));
      // Another branch is another lease.
      assert.equal((await r.leases.acquire({ commandId: "d1", projectId: r.project, branch: "release/1.0", holder: other.holder, taskId: other.taskId, ttlMs: 10 * MIN })).fence, 1);
      // The holder stops renewing: once expired, the next integrator takes it with fence 2, and the lost one's fence no longer works.
      r.tick(11 * MIN);
      assert.equal(await r.leases.valid(held.leaseId, 1), false);
      const next = await r.leases.acquire({ commandId: "c2", projectId: r.project, branch: "integration", ...other, ttlMs: 10 * MIN });
      assert.deepEqual([next.leaseId, next.fence, next.holder], [held.leaseId, 2, other.holder]);
      await refuses("fenced", () => r.leases.renew({ commandId: "rn1", leaseId: held.leaseId, fence: 1, holder: held.holder }));
      await refuses("fenced", () => r.leases.release({ commandId: "rl1", leaseId: held.leaseId, fence: 1 }));
      assert.equal(await r.leases.valid(held.leaseId, 2), true, "the old holder's release did not touch the new hold");
      // Bad input.
      await refuses("invalid_command", () => r.leases.acquire({ commandId: "e1", projectId: r.project, branch: "../x", holder: "agt-a", taskId: r.t1, ttlMs: 10 * MIN }));
      await refuses("invalid_command", () => r.leases.acquire({ commandId: "e2", projectId: r.project, branch: "main", holder: "agt-a", taskId: r.t1, ttlMs: 5 }));
    } finally { await r.world.close(); }
  });

  test(`${backend.name}: renew, release and hand-over act on exactly one fence: a repeat answers what it did, another command for the same fence is refused, an expired hold is not handed to anyone (card L03j)`, async () => {
    const r = await rig();
    try {
      const l = await r.leases.acquire({ commandId: "a1", projectId: r.project, branch: "main", holder: "agt-a", taskId: r.t1, ttlMs: 10 * MIN });
      r.tick(8 * MIN);
      const renewed = await r.leases.renew({ commandId: "rn", leaseId: l.leaseId, fence: 1, holder: "agt-a" });
      assert.equal(Date.parse(renewed.expiresAt), Date.parse("2026-11-11T10:18:00.000Z"));
      await refuses("fenced", () => r.leases.renew({ commandId: "rn2", leaseId: l.leaseId, fence: 1, holder: "agt-b" }));
      assert.deepEqual((await r.leases.forTask(r.t1)).map((x) => x.fence), [1]);
      // Handed over: new holder and task, fence 2; the old fence is dead at once.
      const moved = await r.leases.handOver({ commandId: "ho", leaseId: l.leaseId, fence: 1, to: "agt-b", taskId: r.t2, note: "moved" });
      assert.deepEqual([moved.holder, moved.taskId, moved.fence], ["agt-b", r.t2, 2]);
      assert.deepEqual(await r.leases.forTask(r.t1), [], "the old task holds it no more");
      assert.deepEqual((await r.leases.forTask(r.t2)).map((x) => x.holder), ["agt-b"]);
      assert.equal((await r.leases.handOver({ commandId: "ho", leaseId: l.leaseId, fence: 1, to: "agt-b", taskId: r.t2, note: "moved" })).fence, 2, "a repeat of the same command answers what it did and moves nothing more");
      await refuses("fenced", () => r.leases.handOver({ commandId: "ho2", leaseId: l.leaseId, fence: 1, to: "agt-c", taskId: r.t2 }));
      // Released once; a second release under another command is refused, the first command's repeat is not.
      await r.leases.release({ commandId: "rl", leaseId: l.leaseId, fence: 2, note: "done" });
      assert.equal((await r.leases.release({ commandId: "rl", leaseId: l.leaseId, fence: 2, note: "done" })).state, "released");
      await refuses("fenced", () => r.leases.release({ commandId: "rl2", leaseId: l.leaseId, fence: 2 }));
      assert.deepEqual(await r.leases.forTask(r.t2), []);
      // An expired hold is free: it is not handed to anyone.
      const again = await r.leases.acquire({ commandId: "a2", projectId: r.project, branch: "main", holder: "agt-a", taskId: r.t1, ttlMs: MIN });
      assert.equal(again.fence, 3);
      r.tick(2 * MIN);
      await refuses("fenced", () => r.leases.handOver({ commandId: "ho3", leaseId: l.leaseId, fence: 3, to: "agt-b", taskId: r.t2 }));
      // Through the hand-off's port: a fenced answer is a skip, not a fault.
      const port = integratorLeaseHandover(r.leases);
      assert.deepEqual(await port.held({ taskId: r.t1, from: { kind: "agent", id: "agt-a" } }), [], "an expired hold is not listed as the sender's");
      assert.equal((await port.release({ commandId: "p1", leaseId: l.leaseId, fence: 2, note: "x" })).outcome, "skipped");
      assert.equal((await port.moveTo({ commandId: "p2", leaseId: l.leaseId, fence: 3, to: { kind: "agent", id: "agt-b" }, taskId: r.t2, note: "x" })).outcome, "skipped");
      assert.equal((await port.moveTo({ commandId: "p3", leaseId: l.leaseId, fence: 3, to: { kind: "owner", id: "rob" }, taskId: r.t2, note: "x" })).outcome, "skipped");
      assert.equal(describeLeases({ entries: [{ branch: "main", outcome: "released" }, { branch: "dev", outcome: "skipped" }] }), " Integrator leases: released main; no longer the sender's, left as they are dev.");
    } finally { await r.world.close(); }
  });
}
