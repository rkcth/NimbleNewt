import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld } from "../dispatch/testing/world.js";
import type { Principal } from "../security/principals.js";
import { IntegratorLeaseOps, IntegratorLeaseService, type IntegratorLease } from "./index.js";

after(stopServer);

// Card P10 (second slice): a lease is taken only on the landing branch; a retired holder cannot land and does not keep the branch; the owner's forced release is told to the activity hook.
const MIN = 60_000;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); return true; });
};

for (const backend of backends) {
  const rig = async (landing: string | undefined = "main") => {
    const store = await backend.open();
    const w = await buildWorld(store.storage);
    const leases = IntegratorLeaseService.withEpoch(w.storage, w.epoch, { clock: w.clock.now, pause: async () => undefined });
    const retired = new Set<string>();
    const told: { holder: string; why: string; fence: number }[] = [];
    let branch: string | undefined = landing, unreadable = false;
    const ops = new IntegratorLeaseOps(leases, {
      activeAgent: async (id) => !retired.has(id),
      landingBranch: async () => { if (unreadable) throw new Error("settings down"); return branch; },
      onForcedRelease: async (_by: Principal, l: IntegratorLease, why) => { told.push({ holder: l.holder, why, fence: l.fence }); },
    });
    const person = async (name: string): Promise<Principal> => {
      await w.principals.enroll(w.owner, { commandId: `en-${name}`, kind: "agent", name, grants: [{ action: "integration.lease", project: w.project }] });
      return w.principals.authenticate((await w.principals.issueCredential(w.owner, `agent:${name}`)).token);
    };
    const task = async (title: string): Promise<string> => (await w.projects.createTask({ commandId: `task-${title}`, actor: w.owner.id, projectId: w.project, title })).id;
    return { store, w, leases, ops, person, task, retired, told, setBranch: (b: string | undefined) => { branch = b; }, unreadable: () => { unreadable = true; }, close: () => store.close() };
  };

  test(`${backend.name}: a lease is taken only on the project's landing branch (card P10, second slice)`, async () => {
    const r = await rig();
    try {
      const ann = await r.person("ann");
      const t = await r.task("one");
      await refuses("forbidden", () => r.ops.acquire(ann, { commandId: "s1", taskId: t, branch: "squat", ttlMs: 10 * MIN }));
      await refuses("forbidden", () => r.ops.acquire(r.w.owner, { commandId: "s2", taskId: t, branch: "Main", ttlMs: 10 * MIN, holder: "ann" }));
      assert.deepEqual(await r.ops.list(ann, { projectId: r.w.project }), [], "a refused branch leaves no record");
      assert.equal((await r.ops.acquire(ann, { commandId: "s3", taskId: t, branch: "main", ttlMs: 10 * MIN })).branch, "main");
      // The branch the owner names is read at each ask: moved, the old name is refused and the new one can be taken.
      r.setBranch("release");
      await refuses("forbidden", () => r.ops.acquire(ann, { commandId: "s4", taskId: t, branch: "dev", ttlMs: 10 * MIN }));
      assert.equal((await r.ops.acquire(ann, { commandId: "s5", taskId: t, branch: "release", ttlMs: 10 * MIN })).branch, "release");
      r.setBranch(undefined);
      await refuses("forbidden", () => r.ops.acquire(ann, { commandId: "s6", taskId: t, branch: "main", ttlMs: 10 * MIN }));
      r.unreadable();
      await refuses("unavailable", () => r.ops.acquire(ann, { commandId: "s7", taskId: t, branch: "main", ttlMs: 10 * MIN }));
    } finally { await r.close(); }
  });

  test(`${backend.name}: a retired holder cannot land and does not keep the branch; a forced release is told (card P10, second slice)`, async () => {
    const r = await rig();
    try {
      const ann = await r.person("ann"), bob = await r.person("bob");
      const t = await r.task("one");
      const call = (by: Principal, lease: { leaseId: string; fence: number }) => r.ops.checkLanding(by, { taskId: t, projectId: r.w.project, branch: "main", leaseId: lease.leaseId, fence: lease.fence });
      const first = await r.ops.acquire(ann, { commandId: "a1", taskId: t, branch: "main", ttlMs: 10 * MIN });
      assert.deepEqual(await call(ann, first), { leaseId: first.leaseId, fence: 1 });
      // A live active holder keeps the branch against a rival.
      await refuses("unavailable", () => r.ops.acquire(bob, { commandId: "b0", taskId: t, branch: "main", ttlMs: 10 * MIN }));
      assert.deepEqual(r.told, []);
      // Retired: its landing is refused (by itself or through the owner), and the next agent takes the branch at once, with a new fence.
      r.retired.add("ann");
      await refuses("fenced", () => call(ann, first));
      await refuses("fenced", () => call(r.w.owner, first));
      await refuses("fenced", () => r.ops.checkLanding(r.w.owner, { taskId: t, projectId: r.w.project, branch: "main", leaseId: undefined, fence: undefined }));
      const second = await r.ops.acquire(bob, { commandId: "b1", taskId: t, branch: "main", ttlMs: 10 * MIN });
      assert.deepEqual([second.holder, second.fence], ["bob", 2]);
      assert.deepEqual(r.told, [{ holder: "ann", why: "retired", fence: 1 }]);
      await refuses("fenced", () => call(ann, first));
      // The owner taking a live hold away is told as a forced release; the holder letting go is not; an already released lease is not told again.
      await r.ops.release(r.w.owner, { commandId: "o1", projectId: r.w.project, branch: "main", note: "stuck" });
      assert.deepEqual(r.told.at(-1), { holder: "bob", why: "owner", fence: 2 });
      await r.ops.release(r.w.owner, { commandId: "o2", projectId: r.w.project, branch: "main" });
      assert.equal(r.told.length, 2);
      const third = await r.ops.acquire(bob, { commandId: "b2", taskId: t, branch: "main", ttlMs: 10 * MIN });
      await r.ops.release(bob, { commandId: "b3", leaseId: third.leaseId, fence: third.fence });
      assert.equal(r.told.length, 2, "a holder giving its own lease back is not a forced release");
      // The activity hook failing never undoes the release.
      const failing = new IntegratorLeaseOps(r.leases, { onForcedRelease: async () => { throw new Error("no activity"); } });
      const fourth = await r.ops.acquire(bob, { commandId: "b4", taskId: t, branch: "main", ttlMs: 10 * MIN });
      assert.equal((await failing.release(r.w.owner, { commandId: "o3", leaseId: fourth.leaseId })).state, "released");
    } finally { await r.close(); }
  });
}
