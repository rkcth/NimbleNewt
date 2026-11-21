import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld } from "../dispatch/testing/world.js";
import { IntegratorLeaseOps, IntegratorLeaseService, LandingQueueOps, LandingQueueService, type QueueApproval } from "../landing/index.js";
import { scopedCommandId } from "../security/credentials.js";
import type { Principal } from "../security/principals.js";
import { WorkspaceOpService, type WorkspaceCall, type WorkspaceDeps } from "./index.js";

after(stopServer);

// Card P10 (sixth slice): an `integration` writes the checkout's unreviewed work into the shared tree the landing branch's work lands in. On a project with a landing branch it is made under that branch's integrator
// lease (as a landing is), only by the owner, and only while the branch's landing queue holds nothing; the lease and the queue are shown again right before the host is asked. A project with no landing branch
// integrates as before. The gate below is built the way `startController` builds it, from the real lease and queue services; a second set of services on the same store plays another controller.
const MIN = 60_000;
const BASE = "b".repeat(40);
const tree = (n: number): string => n.toString(16).padStart(40, "0");
const sbm = (n: number): string => `sbm-${"abcdefghijklmnopqrstuvwxyz234567"[n % 32]!.repeat(20)}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match !== undefined) assert.match(error.message, match); return true; });
};

for (const backend of backends) {
  const rig = async () => {
    const store = await backend.open();
    const w = await buildWorld(store.storage);
    const options = { clock: w.clock.now, pause: async () => undefined };
    const approvals = new Map<string, QueueApproval>();
    let branch: string | undefined = "main";
    let unreadable = false;
    const retired = new Set<string>();
    const landingBranch = async (): Promise<string | undefined> => { if (unreadable) throw new Error("settings damaged"); return branch; };
    /** One controller's services on the shared store: its own queue and lease services and doors, and the integration gate composed from them. */
    const services = () => {
      const queue = new LandingQueueOps(LandingQueueService.withEpoch(w.storage, w.epoch, options), {
        approvalOf: async (id) => approvals.get(id),
        landingBranch,
        projectOfTask: async (t) => ((await w.storage.getAggregate({ kind: "task", id: t }))?.body as { projectId?: string } | undefined)?.projectId,
      });
      const leaseOps = new IntegratorLeaseOps(IntegratorLeaseService.withEpoch(w.storage, w.epoch, options), { landingBranch, activeAgent: async (id) => !retired.has(id) });
      const integrationGate: NonNullable<WorkspaceDeps["integrationGate"]> = async (by, call) => {
        let b: string | undefined;
        try { b = await landingBranch(); } catch { throw new DomainError("unavailable", "the landing settings could not be read"); }
        if (b === undefined) return undefined;
        await queue.checkIntegration(by, { taskId: call.taskId, projectId: call.projectId, branch: b });
        const lease = await leaseOps.checkLanding(by, { ...call, branch: b });
        return { branch: b, ...lease };
      };
      return { queue, leaseOps, integrationGate };
    };
    const one = services(), two = services();
    const person = async (name: string, grants = [{ action: "integration.lease", project: w.project }, { action: "workspace.manage", project: w.project }]): Promise<Principal> => {
      await w.principals.enroll(w.owner, { commandId: `en-${name}`, kind: "agent", name, grants });
      return w.principals.authenticate((await w.principals.issueCredential(w.owner, `agent:${name}`)).token);
    };
    const task = async (title: string): Promise<string> => (await w.projects.createTask({ commandId: `task-${title}`, actor: w.owner.id, projectId: w.project, title })).id;
    const approve = (n: number, t: string): string => { approvals.set(sbm(n), { taskId: t, projectId: w.project, base: BASE, tree: tree(n), submittedBy: "agent:ann", approved: true }); return sbm(n); };
    const calls: WorkspaceCall[] = [];
    let beforeRun: () => Promise<void> = async () => undefined;
    const workspace = (s = one, gated = true) => WorkspaceOpService.withEpoch(w.storage, w.epoch, {
      quiesce: { around: async (_scope, _op, run) => { await beforeRun(); return run({ attempts: [] } as never); } },
      portOf: async () => ({ run: async (call) => { calls.push(call); return { ok: true, summary: "1 file(s) carried into the shared workspace", detail: { written: 1, kept: 0, skipped: 0, changed: true } }; } }),
      landingLease: (by, call) => s.leaseOps.checkLanding(by, { ...call, branch }),
      landingQueue: { check: (by, call) => s.queue.checkLanding(by, call), landedChanges: (p, b, x) => s.queue.landedChanges(p, b, x) },
      ...(gated ? { integrationGate: s.integrationGate } : {}),
    }, options);
    const recorded = async (by: Principal, commandId: string) => w.storage.getAggregate({ kind: "workspace-request", id: derivedId("wsr", scopedCommandId(by.id, commandId)) });
    const integrate = (by: Principal, commandId: string, extra: Record<string, unknown> = {}, svc = workspace()) => svc.request(by, { commandId, operation: "integration", taskId: extra["taskId"] as string, reason: "share the work", ...extra } as never);
    return {
      store, w, one, two, person, task, approve, calls, workspace, recorded, integrate, retired,
      setBranch: (b: string | undefined) => { branch = b; }, setUnreadable: (u: boolean) => { unreadable = u; }, setBeforeRun: (f: () => Promise<void>) => { beforeRun = f; },
      close: () => store.close(),
    };
  };

  test(`${backend.name}: an integration on a project with a landing branch needs the branch's live lease, is the owner's alone, and a project with no landing branch integrates as before (card P10, sixth slice)`, async () => {
    const r = await rig();
    try {
      const ivy = await r.person("ivy"), eve = await r.person("eve", [{ action: "workspace.manage", project: r.w.project }]);
      const t1 = await r.task("one");
      // No integrator holds the landing branch: the owner's integration is refused before anything is recorded or asked of a host.
      await refuses("fenced", () => r.integrate(r.w.owner, "o1", { taskId: t1 }), /no integrator holds the lease of branch main/);
      assert.equal(await r.recorded(r.w.owner, "o1"), undefined, "nothing recorded");
      assert.equal(r.calls.length, 0);
      const lease = await r.one.leaseOps.acquire(ivy, { commandId: "li", taskId: t1, branch: "main", ttlMs: 10 * MIN });
      // An agent: without a lease, with a wrong fence, and the holder itself (it lands only queued, approved work, so it shares nothing unreviewed). Each is told that only the owner integrates here, not asked for a lease.
      await refuses("invalid_transition", () => r.integrate(eve, "e1", { taskId: t1 }), /only the owner shares a task's unreviewed work/);
      await refuses("invalid_transition", () => r.integrate(ivy, "i0", { taskId: t1, leaseId: lease.leaseId, fence: lease.fence + 1 }), /only the owner shares/);
      await refuses("invalid_transition", () => r.integrate(ivy, "i1", { taskId: t1, leaseId: lease.leaseId, fence: lease.fence }), /only the owner shares a task's unreviewed work/);
      assert.equal(r.calls.length, 0, "no refused integration reached the host");
      // The owner, leaving the lease out: the live hold is used and recorded; a repeat answers the record without asking the host again.
      const done = await r.integrate(r.w.owner, "o2", { taskId: t1 });
      assert.equal(done.state, "done", JSON.stringify(done));
      assert.deepEqual(done.lease, { leaseId: lease.leaseId, fence: lease.fence });
      assert.deepEqual(r.calls.map((c) => [c.operation, c.taskId]), [["integration", t1]]);
      assert.equal((await r.integrate(r.w.owner, "o2", { taskId: t1 })).replayed, true);
      assert.equal(r.calls.length, 1);
      // The owner may also name the hold; a stale one is refused.
      assert.equal((await r.integrate(r.w.owner, "o3", { taskId: t1, leaseId: lease.leaseId, fence: lease.fence })).state, "done");
      await refuses("fenced", () => r.integrate(r.w.owner, "o4", { taskId: t1, leaseId: lease.leaseId, fence: lease.fence + 7 }));
      // The holder's lease released: nothing is integrated.
      await r.one.leaseOps.release(ivy, { commandId: "lr", leaseId: lease.leaseId, fence: lease.fence });
      await refuses("fenced", () => r.integrate(r.w.owner, "o5", { taskId: t1 }));
      // Settings that cannot be read: refused, nothing written.
      r.setUnreadable(true);
      await refuses("unavailable", () => r.integrate(r.w.owner, "o6", { taskId: t1 }));
      r.setUnreadable(false);
      // No landing branch: as before (no lease asked, none recorded); naming a lease there is refused.
      r.setBranch(undefined);
      const plain = await r.integrate(r.w.owner, "o7", { taskId: t1 });
      assert.equal(plain.state, "done");
      assert.equal(plain.lease, undefined);
      await refuses("invalid_command", () => r.integrate(r.w.owner, "o8", { taskId: t1, leaseId: lease.leaseId, fence: lease.fence }), /names no landing branch/);
      // Without the gate composed (the older unit rigs), a lease named on an integration is refused as before.
      await refuses("invalid_command", () => r.integrate(r.w.owner, "o9", { taskId: t1, leaseId: lease.leaseId, fence: lease.fence }, r.workspace(r.one, false)), /only a landing/);
      assert.equal(r.calls.length, 3);
    } finally { await r.close(); }
  });

  test(`${backend.name}: an integration waits for the landing queue: refused while any work is queued or a place is reserved, allowed once it is empty (card P10, sixth slice)`, async () => {
    const r = await rig();
    try {
      const ivy = await r.person("ivy");
      const [t1, t2] = [await r.task("one"), await r.task("two")];
      await r.one.leaseOps.acquire(ivy, { commandId: "li", taskId: t1, branch: "main", ttlMs: 10 * MIN });
      await r.one.queue.add(r.w.owner, { commandId: "q2", submissionId: r.approve(2, t2) });
      // Another task's approved work waits: the owner's integration of task one is refused before anything is recorded.
      await refuses("invalid_transition", () => r.integrate(r.w.owner, "o1", { taskId: t1 }), /landing queue of branch main is not empty \(1 waiting; task .* is first\)/);
      // The task's own queued work does not make room for its unreviewed work either.
      await refuses("invalid_transition", () => r.integrate(r.w.owner, "o2", { taskId: t2 }), /not empty/);
      assert.equal(await r.recorded(r.w.owner, "o1"), undefined);
      assert.equal(r.calls.length, 0);
      // Taken out: the queue is empty and the integration goes ahead.
      await r.one.queue.remove(r.w.owner, { commandId: "out2", taskId: t2, reason: "not now" });
      assert.equal((await r.integrate(r.w.owner, "o3", { taskId: t1 })).state, "done");
      // A reserved place with no entry (an author at the refresh-round cap) holds the branch for integrations too.
      assert.equal(await r.one.queue.afterRound({ taskId: t2, projectId: r.w.project, round: 3 }), "reserved");
      await refuses("invalid_transition", () => r.integrate(r.w.owner, "o4", { taskId: t1 }), /\(0 waiting, 1 reserved; task .* is first\)/);
      await r.one.queue.remove(r.w.owner, { commandId: "end2", taskId: t2, reason: "let it go" });
      assert.equal((await r.integrate(r.w.owner, "o5", { taskId: t1 })).state, "done");
      assert.equal(r.calls.length, 2);
    } finally { await r.close(); }
  });

  test(`${backend.name}: race: another controller queues work, moves the lease or sets the landing branch while the integration is made quiet; the second showing refuses it and the host is never asked (card P10, sixth slice)`, async () => {
    const r = await rig();
    try {
      const ivy = await r.person("ivy"), max = await r.person("max");
      const [t1, t2] = [await r.task("one"), await r.task("two")];
      const lease = await r.one.leaseOps.acquire(ivy, { commandId: "li", taskId: t1, branch: "main", ttlMs: 10 * MIN });
      // Controller one's integration passed its first showing and is being made quiet (held there, no timing assumed); controller two (its own services on the same store) queues task two's approved work meanwhile.
      let reached!: () => void, go!: () => void;
      const atQuiet = new Promise<void>((ok) => { reached = ok; }), released = new Promise<void>((ok) => { go = ok; });
      r.setBeforeRun(async () => { reached(); await released; });
      const running = r.integrate(r.w.owner, "o1", { taskId: t1 });
      await atQuiet;
      assert.ok(await r.recorded(r.w.owner, "o1"), "the integration was recorded as started: it passed its first showing");
      const queued = await r.two.queue.add(r.w.owner, { commandId: "q2", submissionId: r.approve(2, t2) }).finally(() => go());
      assert.equal(queued.position, 1);
      const first = await running;
      // The second showing, right before the host, sees the other controller's entry: nothing is written.
      assert.equal(first.state, "refused", JSON.stringify(first));
      assert.match(first.summary ?? "", /no longer allows this integration, so nothing was written.*not empty/);
      assert.equal(r.calls.length, 0);
      await r.two.queue.remove(r.w.owner, { commandId: "out2", taskId: t2, reason: "x" });
      // The lease released by the holder through controller two and taken by another integrator during the quiet: the pinned hold no longer holds.
      r.setBeforeRun(async () => { r.setBeforeRun(async () => undefined); await r.two.leaseOps.release(ivy, { commandId: "lr", leaseId: lease.leaseId, fence: lease.fence }); await r.two.leaseOps.acquire(max, { commandId: "lm", taskId: t1, branch: "main", ttlMs: 10 * MIN }); });
      const moved = await r.integrate(r.w.owner, "o2", { taskId: t1 });
      assert.equal(moved.state, "refused", JSON.stringify(moved));
      assert.match(moved.summary ?? "", /nothing was written/);
      assert.equal(r.calls.length, 0);
      // A project with no landing branch at the first showing that gets one during the quiet: the integration was not made under a lease, so it is refused.
      r.setBranch(undefined);
      r.setBeforeRun(async () => { r.setBeforeRun(async () => undefined); r.setBranch("main"); });
      const branchSet = await r.integrate(r.w.owner, "o3", { taskId: t1 });
      assert.equal(branchSet.state, "refused", JSON.stringify(branchSet));
      assert.match(branchSet.summary ?? "", /landing branch or its integrator lease changed/);
      assert.equal(r.calls.length, 0);
      // Nothing moved during the quiet: max's live hold is used and the host is asked once.
      const ok = await r.integrate(r.w.owner, "o4", { taskId: t1 });
      assert.equal(ok.state, "done", JSON.stringify(ok));
      assert.equal(ok.lease?.leaseId, lease.leaseId);
      assert.equal(r.calls.length, 1);
    } finally { await r.close(); }
  });

  test(`${backend.name}: an expired hold or a retired holder covers no integration, at the first showing or when it lapses while the task is made quiet (card P10, sixth-slice review)`, async () => {
    const r = await rig();
    try {
      const ivy = await r.person("ivy");
      const t1 = await r.task("one");
      const lease = await r.one.leaseOps.acquire(ivy, { commandId: "li", taskId: t1, branch: "main", ttlMs: 10 * MIN });
      // The hold runs out while the task is made quiet: the pinned hold no longer holds, nothing is written.
      r.setBeforeRun(async () => { r.setBeforeRun(async () => undefined); r.w.clock.advance(11 * MIN); });
      const lapsed = await r.integrate(r.w.owner, "o1", { taskId: t1 });
      assert.equal(lapsed.state, "refused", JSON.stringify(lapsed));
      assert.match(lapsed.summary ?? "", /no longer allows this integration, so nothing was written/);
      // Expired at the first showing: refused before anything is recorded, whether the owner names the hold or leaves it out.
      await refuses("fenced", () => r.integrate(r.w.owner, "o2", { taskId: t1 }));
      await refuses("fenced", () => r.integrate(r.w.owner, "o3", { taskId: t1, leaseId: lease.leaseId, fence: lease.fence }));
      assert.equal(await r.recorded(r.w.owner, "o2"), undefined);
      assert.equal(r.calls.length, 0);
      // A fresh hold, its holder retired while the task is made quiet: refused; retired at the first showing: refused before anything is recorded.
      const again = await r.one.leaseOps.acquire(ivy, { commandId: "li2", taskId: t1, branch: "main", ttlMs: 10 * MIN });
      r.setBeforeRun(async () => { r.setBeforeRun(async () => undefined); r.retired.add("ivy"); });
      const gone = await r.integrate(r.w.owner, "o4", { taskId: t1 });
      assert.equal(gone.state, "refused", JSON.stringify(gone));
      assert.match(gone.summary ?? "", /no longer an active agent/);
      await refuses("fenced", () => r.integrate(r.w.owner, "o5", { taskId: t1, leaseId: again.leaseId, fence: again.fence }), /no longer an active agent/);
      assert.equal(await r.recorded(r.w.owner, "o5"), undefined);
      // Back in service with a live hold: the integration goes ahead once.
      r.retired.delete("ivy");
      assert.equal((await r.integrate(r.w.owner, "o6", { taskId: t1 })).state, "done");
      assert.equal(r.calls.length, 1);
    } finally { await r.close(); }
  });
}
