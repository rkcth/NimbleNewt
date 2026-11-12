import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { ProjectService } from "../domain/service.js";
import { buildWorld } from "../dispatch/testing/world.js";
import type { Principal } from "../security/principals.js";
import { WorkspaceOpService, type WorkspaceCall, type WorkspacePort } from "../workspace-ops/index.js";
import { IntegratorLeaseOps, IntegratorLeaseService } from "./index.js";

after(stopServer);

// Card P10 (first slice): the authorised door to the integrator lease, holder and project checks, a restored or restarted store, the controller's clock, and a landing that shows the lease before it writes.
const MIN = 60_000;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); return true; });
};

/** A quiesce that quiets nothing; `before` runs once the operation has begun and before the host is asked. */
const stub = (before?: () => void): never => ({ around: async (_s: unknown, _o: unknown, run: (q: { attempts: never[] }) => Promise<unknown>) => { before?.(); return run({ attempts: [] }); } }) as never;

for (const backend of backends) {
  const rig = async () => {
    const store = await backend.open();
    const w = await buildWorld(store.storage);
    const clock = { clock: w.clock.now, pause: async () => undefined };
    const leases = IntegratorLeaseService.withEpoch(w.storage, w.epoch, clock);
    const ops = new IntegratorLeaseOps(leases);
    const person = async (name: string, grants: { action: string; project: string }[]): Promise<Principal> => {
      await w.principals.enroll(w.owner, { commandId: `en-${name}`, kind: "agent", name, grants });
      return w.principals.authenticate((await w.principals.issueCredential(w.owner, `agent:${name}`)).token);
    };
    const task = async (title: string, project = w.project): Promise<string> => {
      const t = (await w.projects.createTask({ commandId: `task-${title}`, actor: w.owner.id, projectId: project, title })).id;
      return t;
    };
    return { store, w, leases, ops, person, task, close: () => store.close() };
  };

  test(`${backend.name}: the lease is taken, renewed, listed and given back through its authorised door; rights, holder and project are each checked (card P10)`, async () => {
    const r = await rig();
    try {
      const ann = await r.person("ann", [{ action: "integration.lease", project: r.w.project }]);
      const bob = await r.person("bob", [{ action: "integration.lease", project: r.w.project }]);
      const wild = await r.person("wild", [{ action: "*", project: "*" }]);
      const nobody = await r.person("nobody", [{ action: "task.read", project: r.w.project }]);
      const t1 = await r.task("one");
      const got = await r.ops.acquire(ann, { commandId: "a1", taskId: t1, branch: "main", ttlMs: 10 * MIN });
      assert.deepEqual([got.holder, got.fence, got.live, got.projectId], ["ann", 1, true, r.w.project], "an agent holds the lease as itself");
      // Rights: no grant, only a wildcard grant, and a task credential-like scope are all refused as if the task did not exist.
      await refuses("not_found", () => r.ops.acquire(nobody, { commandId: "n1", taskId: t1, branch: "dev", ttlMs: 10 * MIN }));
      await refuses("not_found", () => r.ops.acquire(wild, { commandId: "w1", taskId: t1, branch: "dev", ttlMs: 10 * MIN }));
      await refuses("not_found", () => r.ops.list(nobody, { projectId: r.w.project }));
      // An agent cannot hold it as someone else; only the owner names a holder, and must.
      await refuses("forbidden", () => r.ops.acquire(bob, { commandId: "b0", taskId: t1, branch: "dev", ttlMs: 10 * MIN, holder: "ann" }));
      await refuses("invalid_command", () => r.ops.acquire(r.w.owner, { commandId: "o0", taskId: t1, branch: "dev", ttlMs: 10 * MIN }));
      assert.equal((await r.ops.acquire(r.w.owner, { commandId: "o1", taskId: t1, branch: "dev", ttlMs: 10 * MIN, holder: "carol" })).holder, "carol");
      // A rival is refused while the hold is live; only the holder renews; a stranger's release is refused and touches nothing.
      await refuses("unavailable", () => r.ops.acquire(bob, { commandId: "b1", taskId: t1, branch: "main", ttlMs: 10 * MIN }));
      await refuses("fenced", () => r.ops.renew(bob, { commandId: "b2", leaseId: got.leaseId, fence: 1 }));
      await refuses("fenced", () => r.ops.release(bob, { commandId: "b3", leaseId: got.leaseId, fence: 1 }));
      await refuses("invalid_command", () => r.ops.release(ann, { commandId: "a9", leaseId: got.leaseId }));
      assert.equal(await r.leases.valid(got.leaseId, 1, "ann"), true);
      r.w.clock.advance(6 * MIN);
      const renewed = await r.ops.renew(ann, { commandId: "a2", leaseId: got.leaseId, fence: 1 });
      assert.equal(Date.parse(renewed.expiresAt) - Date.parse(got.expiresAt), 6 * MIN, "renewing moves the expiry on the controller's clock");
      // The list shows both branches; the owner ends dev by project and branch without a fence.
      assert.deepEqual((await r.ops.list(ann, { projectId: r.w.project })).map((l) => [l.branch, l.holder, l.live]).sort(), [["dev", "carol", true], ["main", "ann", true]]);
      const ended = await r.ops.release(r.w.owner, { commandId: "o2", projectId: r.w.project, branch: "dev" });
      assert.equal(ended.state, "released");
      // The holder's own release, with its fence; a repeat of the same command answers the same.
      assert.equal((await r.ops.release(ann, { commandId: "a3", leaseId: got.leaseId, fence: 1 })).state, "released");
      assert.equal((await r.ops.release(ann, { commandId: "a3", leaseId: got.leaseId, fence: 1 })).state, "released");
      assert.equal(await r.leases.valid(got.leaseId, 1, "ann"), false);
    } finally { await r.close(); }
  });

  test(`${backend.name}: a task of another project cannot hold this project's lease, and a task that does not exist cannot hold any (card P10)`, async () => {
    const r = await rig();
    try {
      const other = (await r.w.projects.createProject({ commandId: "p2", actor: r.w.owner.id, name: "Other" })).id;
      const foreign = await r.task("foreign", other);
      const own = await r.task("own");
      // Straight at the service (no caller): the project of the lease is the project named, and the task must be in it.
      await refuses("forbidden", () => r.leases.acquire({ commandId: "x1", projectId: r.w.project, branch: "main", holder: "ann", taskId: foreign, ttlMs: 10 * MIN }));
      await refuses("not_found", () => r.leases.acquire({ commandId: "x2", projectId: r.w.project, branch: "main", holder: "ann", taskId: "task-aaaaaaaaaaaaaaaaaaaa", ttlMs: 10 * MIN }));
      const held = await r.leases.acquire({ commandId: "x3", projectId: r.w.project, branch: "main", holder: "ann", taskId: own, ttlMs: 10 * MIN });
      assert.equal(held.fence, 1);
      // A hand-over cannot move the hold under a task of another project either.
      await refuses("forbidden", () => r.leases.handOver({ commandId: "x3h", leaseId: held.leaseId, fence: 1, to: "bob", taskId: foreign }));
      assert.equal(await r.leases.valid(held.leaseId, 1, "ann"), true, "the refused hand-over changed nothing");
      // Through the door: a grant in one project says nothing about the other.
      const ann = await r.person("ann", [{ action: "integration.lease", project: r.w.project }]);
      await refuses("not_found", () => r.ops.acquire(ann, { commandId: "x4", taskId: foreign, branch: "main", ttlMs: 10 * MIN }));
    } finally { await r.close(); }
  });

  test(`${backend.name}: valid() needs the holder and the fence; a lease from another controller epoch (a restart, or a store restored from a backup) is not live, and a fence handed out before is never taken for a current one (card P10)`, async () => {
    const r = await rig();
    try {
      const t = await r.task("one");
      const first = await r.leases.acquire({ commandId: "e1", projectId: r.w.project, branch: "main", holder: "ann", taskId: t, ttlMs: 10 * MIN });
      assert.equal(await r.leases.valid(first.leaseId, 1, "ann"), true);
      assert.equal(await r.leases.valid(first.leaseId, 1, "bob"), false, "someone else's name with the right fence");
      assert.equal(await r.leases.valid(first.leaseId, 2, "ann"), false, "the right holder with the wrong fence");
      assert.equal(await r.leases.valid(first.leaseId, 1, "ann", "task-aaaaaaaaaaaaaaaaaaaa"), false, "another task");
      // The controller starts again (or a restore puts the store back and the controller starts): a new epoch. The earlier hold is not live, so it frees the branch and nothing renews it.
      const restarted = await ProjectService.open(r.w.storage, { holder: "c2", clock: r.w.clock.now, pause: async () => undefined });
      assert.ok(restarted.epoch > r.w.epoch);
      const later = IntegratorLeaseService.withEpoch(r.w.storage, restarted.epoch, { clock: r.w.clock.now, pause: async () => undefined });
      assert.equal(await later.valid(first.leaseId, 1, "ann"), false);
      assert.equal((await later.get(first.leaseId))!.live, false);
      await refuses("fenced", () => later.renew({ commandId: "e2", leaseId: first.leaseId, fence: 1, holder: "ann" }));
      // Another integrator takes the branch with the next fence; the earlier holder's number is no good, and the new holder's number is not good for the earlier holder.
      const next = await later.acquire({ commandId: "e3", projectId: r.w.project, branch: "main", holder: "bob", taskId: t, ttlMs: 10 * MIN });
      assert.deepEqual([next.fence, next.holder], [2, "bob"]);
      assert.equal(await later.valid(first.leaseId, 1, "ann"), false);
      assert.equal(await later.valid(first.leaseId, 2, "ann"), false, "a fence reused after a restore still needs its own holder");
      assert.equal(await later.valid(first.leaseId, 2, "bob"), true);
      // And the old controller's view (the stale epoch) cannot see the new hold as live either.
      assert.equal(await r.leases.valid(first.leaseId, 2, "bob"), false);
    } finally { await r.close(); }
  });

  test(`${backend.name}: a lease expires on the controller's clock, not the machine's, and a lost integrator's branch is taken by the next (card P10)`, async () => {
    const r = await rig();
    try {
      const t = await r.task("one");
      const held = await r.leases.acquire({ commandId: "c1", projectId: r.w.project, branch: "main", holder: "ann", taskId: t, ttlMs: 10 * MIN });
      assert.equal(held.acquiredAt, r.w.clock.now(), "the stamp is the injected clock, not Date.now");
      r.w.clock.advance(10 * MIN - 1);
      assert.equal(await r.leases.valid(held.leaseId, 1, "ann"), true);
      r.w.clock.advance(1);
      assert.equal(await r.leases.valid(held.leaseId, 1, "ann"), false, "expired exactly at expiresAt");
    } finally { await r.close(); }
  });

  // A landing shows the lease before anything is recorded or asked of the host, and once more right before the host is asked.
  test(`${backend.name}: a landing is made only under the caller's live lease on the landing branch of the task's project; a stale, foreign, wrong-branch or missing lease is refused and the host is never asked (card P10)`, async () => {
    const r = await rig();
    try {
      let branch: string | undefined = "main";
      let asked = 0;
      let onAsk: (() => Promise<void>) | undefined;
      const port: WorkspacePort = { run: async (_call: WorkspaceCall) => { asked++; if (onAsk) await onAsk(); return { ok: true, summary: "landed", detail: { landed: true } }; } };
      const svc = WorkspaceOpService.withEpoch(r.w.storage, r.w.epoch, {
        quiesce: stub(),
        portOf: async () => port,
        landingLease: async (by, call) => { await r.ops.checkLanding(by, { ...call, branch }); },
      }, { clock: r.w.clock.now });
      const grants = [{ action: "workspace.manage", project: r.w.project }, { action: "integration.lease", project: r.w.project }];
      const ann = await r.person("ann", grants);
      const bob = await r.person("bob", grants);
      const t = await r.task("work");
      const lease = await r.ops.acquire(ann, { commandId: "l0", taskId: t, branch: "main", ttlMs: 10 * MIN });
      const land = (by: Principal, id: string, extra: { leaseId?: string; fence?: number } = {}) => svc.request(by, { commandId: id, operation: "landing", taskId: t, reason: "land it", ...extra });

      await refuses("invalid_command", () => land(ann, "m1"));
      await refuses("invalid_command", () => land(ann, "m2", { leaseId: lease.leaseId }));
      await refuses("fenced", () => land(ann, "m3", { leaseId: lease.leaseId, fence: 2 }));
      await refuses("fenced", () => land(bob, "m4", { leaseId: lease.leaseId, fence: 1 }));
      branch = "release";
      await refuses("forbidden", () => land(ann, "m5", { leaseId: lease.leaseId, fence: 1 }));
      branch = undefined;
      await refuses("forbidden", () => land(ann, "m5b", { leaseId: lease.leaseId, fence: 1 }));
      branch = "main";
      // A lease of another project is not this task's.
      const other = (await r.w.projects.createProject({ commandId: "p2", actor: r.w.owner.id, name: "Other" })).id;
      const ot = await r.task("theirs", other);
      const foreign = await r.leases.acquire({ commandId: "f1", projectId: other, branch: "main", holder: "ann", taskId: ot, ttlMs: 10 * MIN });
      await refuses("forbidden", () => land(ann, "m6", { leaseId: foreign.leaseId, fence: 1 }));
      // Only a landing is made under a lease.
      await refuses("invalid_command", () => svc.request(ann, { commandId: "m7", operation: "refresh", taskId: t, reason: "x", leaseId: lease.leaseId, fence: 1 }));
      assert.equal(asked, 0, "the host was never asked");

      const done = await land(ann, "ok1", { leaseId: lease.leaseId, fence: 1 });
      assert.deepEqual([done.state, done.lease], ["done", { leaseId: lease.leaseId, fence: 1 }]);
      assert.equal(asked, 1);
      // The owner acts for the holder but still needs the fence.
      await refuses("fenced", () => land(r.w.owner, "ok2", { leaseId: lease.leaseId, fence: 7 }));
      assert.equal((await land(r.w.owner, "ok3", { leaseId: lease.leaseId, fence: 1 })).state, "done");

      // The lease runs out while the host is being asked for the quiesce: the second showing refuses and the host is not asked.
      asked = 0;
      const quiet = WorkspaceOpService.withEpoch(r.w.storage, r.w.epoch, {
        quiesce: stub(() => r.w.clock.advance(11 * MIN)),
        portOf: async () => port,
        landingLease: async (by, call) => { await r.ops.checkLanding(by, { ...call, branch }); },
      }, { clock: r.w.clock.now });
      const late = await r.ops.renew(ann, { commandId: "l2", leaseId: lease.leaseId, fence: 1 });
      const answer = await quiet.request(ann, { commandId: "late", operation: "landing", taskId: t, reason: "land it", leaseId: late.leaseId, fence: late.fence });
      assert.equal(answer.state, "refused");
      assert.match(answer.summary ?? "", /no longer holds/);
      assert.equal(asked, 0);
    } finally { await r.close(); }
  });
}
