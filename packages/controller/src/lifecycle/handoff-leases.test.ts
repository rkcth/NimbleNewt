import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AgentService } from "../agents/index.js";
import { AssignmentService } from "../domain/assignments.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { IntegratorLeaseService, integratorLeaseHandover } from "../landing/index.js";
import { GrantService, PrincipalService, type Grant, type Principal } from "../security/index.js";
import { HandoffService, PauseService, StopService, type HandoffSources, type InventoryItem, type LeaseHandover, type StopPorts } from "./index.js";

after(stopServer);

// Card L03j: a hand-off accounts for the sender's integrator lease. Each step can be cut by a crash (an injected fault) and is finished by the next pass or the sweep: no hold leaked, none released twice, none taken from
// someone else, none moved without the owner.
const MIN = 60_000;
let now = Date.parse("2026-11-11T10:00:00.000Z");
const options = { clock: () => new Date(now).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); return true; });
};

class Runtime implements StopPorts {
  async release(): Promise<void> { /* nothing held */ }
  async inventory(): Promise<InventoryItem[]> { return []; }
  async cleanup() { return { remaining: [] }; }
  async checkpoint() { return { checkpointId: "cp-1", durable: true, artifactsDurable: true }; }
  async terminate() { return { ended: true, unresolved: [] }; }
  unsupported(): string | undefined { return undefined; }
}
const sources: HandoffSources = { collect: async () => ({ sections: { brief: "Land the importer.", acceptanceCriteria: "Lands.", unfinishedWork: "Landing.", nextAction: "Land it." } }) };

/** Faults: each counter makes the next call of that step die (before or after the real write) that many times. */
interface Faults { heldBefore: number; transfer: number; releaseAfter: number; moveAfter: number; releaseBefore: number }

for (const backend of backends) {
  interface Ctx { owner: Principal; mgr: Principal; task: string; task2: string; a: { kind: string; id: string }; b: { kind: string; id: string }; c: { kind: string; id: string }; project: string; handoffs: HandoffService; leases: IntegratorLeaseService; faults: Faults; assignments: AssignmentService; told: { leases?: unknown }[] }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      now = Date.parse("2026-11-11T10:00:00.000Z");
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const epoch = projects.epoch;
        const principals = PrincipalService.withEpoch(world.storage, epoch, options);
        GrantService.withEpoch(world.storage, epoch, options);
        const agents = AgentService.withEpoch(world.storage, epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const plain = async (nm: string, g: Grant[]) => { await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: g }); return principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token); };
        const project = (await projects.createProject({ commandId: cid("pa"), actor: owner.id, name: "A" })).id;
        const mkAgent = async (nm: string) => ({ kind: "agent", id: (await agents.create(owner, { commandId: cid("ag"), friendlyName: nm })).id });
        const a = await mkAgent("A"), b = await mkAgent("B"), c = await mkAgent("C");
        const real = AssignmentService.withEpoch(world.storage, epoch, projects, options);
        const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "land" })).id;
        await projects.transitionTask({ commandId: cid("r"), actor: owner.id, taskId: task, expectedRevision: 1, to: "ready" });
        await real.assignTask({ commandId: cid("as"), actor: owner.id, taskId: task, owner: a });
        const mgr = await plain("mgr", [{ action: "assignment.manage", project }, { action: "assignment.read", project }]);
        const faults: Faults = { heldBefore: 0, transfer: 0, releaseAfter: 0, moveAfter: 0, releaseBefore: 0 };
        const assignments = { getAssignment: (t: string) => real.getAssignment(t), transferTask: async (cmd: Parameters<AssignmentService["transferTask"]>[0]) => { if (faults.transfer > 0) { faults.transfer--; throw new Error("process died before the transfer"); } return real.transferTask(cmd); } } as unknown as AssignmentService;
        const leases = IntegratorLeaseService.withEpoch(world.storage, epoch, options);
        const port = integratorLeaseHandover(leases);
        const faulty: LeaseHandover = {
          held: async (r) => { if (faults.heldBefore > 0) { faults.heldBefore--; throw new Error("process died before the plan"); } return port.held(r); },
          release: async (r) => { if (faults.releaseBefore > 0) { faults.releaseBefore--; throw new Error("process died before the release"); } const out = await port.release(r); if (faults.releaseAfter > 0) { faults.releaseAfter--; throw new Error("process died after the release, before it was recorded"); } return out; },
          moveTo: async (r) => { const out = await port.moveTo(r); if (faults.moveAfter > 0) { faults.moveAfter--; throw new Error("process died after the move, before it was recorded"); } return out; },
        };
        const pauses = PauseService.withEpoch(world.storage, epoch, {}, options);
        const stops = StopService.withEpoch(world.storage, epoch, pauses, new Runtime(), options);
        const told: { leases?: unknown }[] = [];
        const handoffs = HandoffService.withEpoch(world.storage, epoch, { pauses, stops, assignments, sources, leases: faulty, asker: async (id) => (id === mgr.id ? mgr : id === owner.id ? owner : undefined), onTransferred: async (_by, e) => { told.push(e); } }, options);
        const task2 = (await projects.createTask({ commandId: cid("t2"), actor: owner.id, projectId: project, title: "other" })).id;
        await body({ owner, mgr, task, task2, a, b, c, project, handoffs, leases, faults, assignments: real, told });
      } finally { await world.close(); }
    });
  const take = (c: Ctx, holder: string, ttlMs = 30 * MIN) => c.leases.acquire({ commandId: cid("lz"), projectId: c.project, branch: "integration", holder, taskId: c.task, ttlMs });
  const ownerOf = async (c: Ctx) => { const x = await c.assignments.getAssignment(c.task); return `${x?.owner?.id}@${x?.generation}`; };

  suite("stopping and resuming the sender keeps its lease; moving the task releases it exactly once, also when the process dies before the plan, before the transfer, or between the release and its record (card L03j)", async (c) => {
    const l = await take(c, c.a.id);
    // Stop and resume: a hand-off that is cancelled leaves the lease with the sender.
    const h0 = await c.handoffs.prepare(c.mgr, { commandId: cid("h"), taskId: c.task, to: c.b, reason: "leave" });
    assert.equal(h0.phase, "ready");
    await c.handoffs.cancel(c.mgr, { handoffId: h0.id });
    assert.equal(await c.leases.valid(l.leaseId, 1, l.holder), true, "a cancelled hand-off does not release the lease");
    // Crash before the plan is written: nothing moved, the lease is the sender's; the sweep finishes.
    const h1 = await c.handoffs.prepare(c.mgr, { commandId: cid("h"), taskId: c.task, to: c.b, reason: "leave" });
    c.faults.heldBefore = 1;
    await assert.rejects(c.handoffs.complete(c.mgr, { commandId: cid("c"), handoffId: h1.id }), /before the plan/);
    let rec = (await c.handoffs.get(c.owner, h1.id))!;
    assert.deepEqual([rec.phase, rec.leasePlan, await ownerOf(c), await c.leases.valid(l.leaseId, 1, l.holder)], ["transferring", undefined, `${c.a.id}@1`, true]);
    // Crash after the plan, before the transfer: the plan names fence 1; still nothing moved.
    c.faults.transfer = 1;
    await assert.rejects(c.handoffs.advance(c.mgr, { handoffId: h1.id }), /before the transfer/);
    rec = (await c.handoffs.get(c.owner, h1.id))!;
    assert.deepEqual(rec.leasePlan?.entries, [{ leaseId: l.leaseId, branch: "integration", fence: 1, action: "release" }]);
    assert.deepEqual([await ownerOf(c), await c.leases.valid(l.leaseId, 1, l.holder)], [`${c.a.id}@1`, true], "the lease stays until the task really moves");
    // Crash after the release was written but before the hand-off recorded it.
    c.faults.releaseAfter = 1;
    await assert.rejects(c.handoffs.advance(c.mgr, { handoffId: h1.id }), /after the release/);
    const releasedRev = (await c.leases.get(l.leaseId))!;
    assert.deepEqual([releasedRev.state, await ownerOf(c)], ["released", `${c.b.id}@2`]);
    rec = (await c.handoffs.get(c.owner, h1.id))!;
    assert.deepEqual([rec.phase, rec.leasesSettled], ["transferring", undefined]);
    // The sweep finishes it: the repeat of the release answers "released" (not skipped) and writes nothing to the lease again.
    const swept = await c.handoffs.sweep(c.owner);
    assert.deepEqual(swept, { advanced: [h1.id], failed: [] });
    rec = (await c.handoffs.get(c.owner, h1.id))!;
    assert.equal(rec.phase, "transferred");
    assert.deepEqual(rec.leasesSettled?.entries, [{ leaseId: l.leaseId, branch: "integration", outcome: "released" }]);
    assert.equal((await c.leases.get(l.leaseId))!.revision, releasedRev.revision, "released exactly once");
    assert.deepEqual(c.told.map((t) => t.leases !== undefined), [true], "the activity record is told what happened to the lease");
    // Nothing to do on the next hand-off: the recipient holds no lease, and the sweep finds nothing.
    assert.deepEqual(await c.handoffs.sweep(c.owner), { advanced: [], failed: [] });
    const back = await c.handoffs.prepare(c.mgr, { commandId: cid("h"), taskId: c.task, to: c.a, reason: "back" });
    const done = await c.handoffs.complete(c.mgr, { commandId: cid("c"), handoffId: back.id });
    assert.deepEqual([done.phase, done.leasePlan?.entries, done.leasesSettled?.entries], ["transferred", [], []]);
  });

  suite("a lease that expired during the hand-off and was taken by another integrator is skipped, never released or moved; a crash before the release repeats it cleanly (card L03j)", async (c) => {
    const l = await take(c, c.a.id, 5 * MIN);
    const h = await c.handoffs.prepare(c.mgr, { commandId: cid("h"), taskId: c.task, to: c.b, reason: "leave" });
    c.faults.transfer = 1;
    await assert.rejects(c.handoffs.complete(c.mgr, { commandId: cid("c"), handoffId: h.id }), /before the transfer/);
    // The sender's hold lapses and another integrator (C, on another task) takes the branch with fence 2.
    now += 6 * MIN;
    const other = await c.leases.acquire({ commandId: cid("lz"), projectId: c.project, branch: "integration", holder: c.c.id, taskId: c.task2, ttlMs: 30 * MIN });
    assert.equal(other.fence, 2);
    c.faults.releaseBefore = 1;
    await assert.rejects(c.handoffs.advance(c.mgr, { handoffId: h.id }), /before the release/);
    const before = (await c.leases.get(l.leaseId))!;
    const done = await c.handoffs.advance(c.mgr, { handoffId: h.id });
    assert.equal(done.phase, "transferred");
    assert.equal(done.leasesSettled?.entries[0]?.outcome, "skipped");
    assert.match(done.leasesSettled?.entries[0]?.reason ?? "", /not held with fence 1/);
    const after = (await c.leases.get(l.leaseId))!;
    assert.deepEqual([after.holder, after.fence, after.state, after.revision], [c.c.id, 2, "held", before.revision], "the new holder's lease is untouched");
  });

  suite("only the owner moves the lease to the recipient (new fence, the sender's dies at once); a crash between the move and its record is repeated without a second move; the choice cannot change on a repeat (card L03j)", async (c) => {
    const l = await take(c, c.a.id);
    const h = await c.handoffs.prepare(c.mgr, { commandId: cid("h"), taskId: c.task, to: c.b, reason: "leave" });
    await refuses("forbidden", () => c.handoffs.complete(c.mgr, { commandId: cid("c"), handoffId: h.id, moveIntegratorLease: true }));
    await refuses("invalid_command", () => c.handoffs.complete(c.owner, { commandId: cid("c"), handoffId: h.id, moveIntegratorLease: "yes" }));
    assert.deepEqual([(await c.handoffs.get(c.owner, h.id))!.phase, await c.leases.valid(l.leaseId, 1, l.holder)], ["ready", true], "a refusal moves nothing");
    c.faults.moveAfter = 1;
    await assert.rejects(c.handoffs.complete(c.owner, { commandId: cid("c"), handoffId: h.id, moveIntegratorLease: true }), /after the move/);
    await refuses("invalid_command", () => c.handoffs.complete(c.owner, { commandId: cid("c"), handoffId: h.id, moveIntegratorLease: false }));
    const done = await c.handoffs.complete(c.owner, { commandId: cid("c"), handoffId: h.id, moveIntegratorLease: true });
    assert.equal(done.phase, "transferred");
    assert.deepEqual(done.leasesSettled?.entries, [{ leaseId: l.leaseId, branch: "integration", outcome: "moved", fence: 2 }]);
    const now2 = (await c.leases.get(l.leaseId))!;
    assert.deepEqual([now2.holder, now2.fence, now2.taskId], [c.b.id, 2, c.task], "moved once: fence 2, not 3");
    await refuses("fenced", () => c.leases.renew({ commandId: cid("rn"), leaseId: l.leaseId, fence: 1, holder: c.a.id }));
    assert.equal(done.leaseMove?.by, c.owner.id);
  });

  suite("a lease another agent holds for the same task (an integrator working its landing) is neither listed as the sender's nor released or moved by the hand-off (card L03j review)", async (c) => {
    const mine = await take(c, c.a.id);
    const theirs = await c.leases.acquire({ commandId: cid("lz"), projectId: c.project, branch: "release/2", holder: c.c.id, taskId: c.task, ttlMs: 30 * MIN });
    const h = await c.handoffs.prepare(c.mgr, { commandId: cid("h"), taskId: c.task, to: c.b, reason: "leave" });
    const done = await c.handoffs.complete(c.owner, { commandId: cid("c"), handoffId: h.id, moveIntegratorLease: true });
    assert.deepEqual(done.leasePlan?.entries.map((e) => e.leaseId), [mine.leaseId], "only the sender's hold is planned");
    const after = (await c.leases.get(theirs.leaseId))!;
    assert.deepEqual([after.holder, after.fence, after.state, after.revision], [c.c.id, 1, "held", theirs.revision], "the other integrator's lease is untouched");
  });

  suite("two completions at the same moment, the owner moving the lease and a manager not: the one whose choice lost is refused, never answered as if its choice were done (card L03j review)", async (c) => {
    let from = c.a, to = c.b;
    for (let round = 0; round < 4; round++) {
      const l = await take(c, from.id);
      const h = await c.handoffs.prepare(c.mgr, { commandId: cid("h"), taskId: c.task, to, reason: "leave" });
      const calls = [() => c.handoffs.complete(c.owner, { commandId: cid("c"), handoffId: h.id, moveIntegratorLease: true }), () => c.handoffs.complete(c.mgr, { commandId: cid("c"), handoffId: h.id, moveIntegratorLease: false })];
      const [own, man] = await Promise.allSettled(round % 2 === 0 ? [calls[0]!(), calls[1]!()] : [calls[0]!(), calls[1]!()].reverse()).then((x) => (round % 2 === 0 ? x : x.reverse()));
      const rec = (await c.handoffs.get(c.owner, h.id))!;
      assert.equal(rec.phase, "transferred");
      const moved = rec.leaseMove !== undefined;
      assert.equal((await c.leases.get(l.leaseId))!.state === "released", !moved);
      // The call whose choice was recorded succeeds; the other is refused (invalid_command), never a success that hides its choice was not taken.
      assert.equal(own!.status, moved ? "fulfilled" : "rejected", `owner: ${String((own as PromiseRejectedResult).reason ?? "")}`);
      assert.equal(man!.status, moved ? "rejected" : "fulfilled", `manager: ${String((man as PromiseRejectedResult).reason ?? "")}`);
      const lost = (moved ? man : own) as PromiseRejectedResult;
      assert.ok(lost.reason instanceof DomainError && lost.reason.code === "invalid_command", String(lost.reason));
      if (moved) { const now2 = (await c.leases.get(l.leaseId))!; await c.leases.release({ commandId: cid("rl"), leaseId: l.leaseId, fence: now2.fence }); }
      [from, to] = [to, from];
    }
  });

  suite("a forced takeover releases the sender's lease; a temporary reassignment cannot move it (card L03j)", async (c) => {
    const l = await take(c, c.a.id);
    const t = await c.handoffs.takeover(c.owner, { commandId: cid("tk"), taskId: c.task, to: c.b, reason: "A is unreachable" });
    assert.equal(t.phase, "transferred");
    assert.deepEqual(t.leasesSettled?.entries.map((e) => e.outcome), ["released"]);
    assert.equal((await c.leases.get(l.leaseId))!.state, "released");
    // B now holds a lease of its own; a temporary reassignment back to A may not move it.
    const l2 = await take(c, c.b.id);
    const cover = await c.handoffs.prepare(c.mgr, { commandId: cid("h"), taskId: c.task, to: c.a, reason: "cover", returnAt: new Date(now + 60 * MIN).toISOString() });
    await refuses("invalid_command", () => c.handoffs.complete(c.owner, { commandId: cid("c"), handoffId: cover.id, moveIntegratorLease: true }));
    const covered = await c.handoffs.complete(c.owner, { commandId: cid("c"), handoffId: cover.id });
    assert.deepEqual([covered.phase, covered.leasesSettled?.entries.map((e) => e.outcome)], ["transferred", ["released"]], "a cover releases the lease, it is not handed back with the task");
    assert.equal((await c.leases.get(l2.leaseId))!.state, "released");
  });
}
