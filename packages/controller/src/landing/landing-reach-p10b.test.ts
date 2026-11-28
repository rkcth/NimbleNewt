import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { CommandRunner } from "../domain/runner.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld, workGrants } from "../dispatch/testing/world.js";
import type { Grant, Principal } from "../security/principals.js";
import type { JsonObject } from "../storage/types.js";
import { WorkspaceOpService, type WorkspaceCall, type WorkspacePort } from "../workspace-ops/index.js";
import {
  IntegratorCapacity, IntegratorLeaseOps, IntegratorLeaseService, IntegratorPool, IntegratorWake, LANDING_TASK_KIND, LandingQueueService, WAKE_KIND, activeAgentIds, frontOf,
} from "./index.js";
import { reachServes, takeKeyOf } from "./landing-reach.js";

after(stopServer);

// Card P10b, second clause ("credentials and context are fresh per project; no data crosses between projects"). A woken integrator's attempt runs on its A10b task credential, cut to its landing task and that task's
// project. That credential now reaches exactly the integrator lease of the one branch its landing task lands, in that project, and the landing made under it: never another project, another branch, another agent's lease,
// another workspace operation or the pool's other projects. Each wake is its own landing task, so each take has its own credential, and a take's command IDs never replay another take's answers.
const MIN = 60_000;
const BASE = "b".repeat(40);
const tree = (n: number): string => n.toString(16).padStart(40, "0");
const sbm = (n: number): string => `sbm-${"abcdefghijklmnopqrstuvwxyz234567"[n % 32]!.repeat(20)}`;
const integrates = (projects: string[]): Grant[] => projects.flatMap((project) => [{ action: "integration.lease", project }, { action: "workspace.manage", project }, { action: "task.read", project }]);
const refuses = async (code: string, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (e: unknown) => { assert.ok(e instanceof DomainError, String(e)); assert.equal(e.code, code, e.message); if (match !== undefined) assert.match(e.message, match); return true; });
};

for (const backend of backends) {
  const rig = async () => {
    const store = await backend.open();
    const w = await buildWorld(store.storage);
    const options = { clock: w.clock.now, pause: async () => undefined };
    const activeAgent = async (id: string) => { const p = await w.principals.get(`agent:${id}`); return p !== undefined && p.kind === "agent" && p.state === "active"; };
    const landingBranch = async (): Promise<string> => "main";
    let wakeRef: IntegratorWake | undefined;
    const landingReach = (by: Principal) => wakeRef!.landingReach(by);
    const leases = IntegratorLeaseService.withEpoch(w.storage, w.epoch, options);
    const leaseOps = new IntegratorLeaseOps(leases, { landingBranch, activeAgent, landingReach });
    const queue = LandingQueueService.withEpoch(w.storage, w.epoch, options);
    const pool = new IntegratorPool(leases, leaseOps, queue, { landingBranch, activeAgent, landingReach });
    const capacity = new IntegratorCapacity(leases, { agents: () => activeAgentIds(w.storage), principal: (id) => w.principals.current(id), wakes: () => wakeRef!.now(), assignmentOf: (t) => w.assignments.getAssignment(t) });
    const wake = IntegratorWake.withEpoch(w.storage, w.epoch, { queue, leases, capacity, projects: w.projects, assignments: w.assignments, landingBranch, activeAgent }, options);
    wakeRef = wake;
    // The host: every landing it is asked for lands (the lease and the queue were checked before it is asked).
    const hostCalls: WorkspaceCall[] = [];
    const port = { run: async (call: WorkspaceCall) => { hostCalls.push(call); return { ok: true, summary: "landed", detail: { landed: true, changed: true, written: 1 } }; } } as unknown as WorkspacePort;
    const workspace = WorkspaceOpService.withEpoch(w.storage, w.epoch, {
      landingReach,
      quiesce: { around: async (_scope, _op, run) => run({ attempts: [] } as never) },
      portOf: async () => port,
      landingLease: (by, call) => leaseOps.checkLanding(by, { ...call, branch: "main" }),
      attempts: { live: async () => [], frozenReason: async () => undefined, release: async () => undefined, tell: async () => true },
      // The queue's own judgement, cut down: only the first place's task lands.
      landingQueue: {
        check: async (_by, call) => {
          const head = frontOf(await queue.get(call.projectId, "main"));
          if (head?.entry === undefined || head.taskId !== call.taskId) throw new DomainError("invalid_transition", `task ${call.taskId} is not first in the landing queue`);
          return { submissionId: head.entry.submissionId, base: head.entry.base, tree: head.entry.tree, branch: "main" };
        },
        landedChanges: async () => [],
      },
    }, options);
    const project = async (name: string): Promise<string> => (await w.projects.createProject({ commandId: `p-${name}`, actor: w.owner.id, name })).id;
    const person = async (name: string, grants: Grant[]): Promise<Principal> => {
      await w.principals.enroll(w.owner, { commandId: `en-${name}`, kind: "agent", name, grants });
      return w.principals.authenticate((await w.principals.issueCredential(w.owner, `agent:${name}`)).token);
    };
    let n = 0;
    const queued = async (projectId: string): Promise<string> => {
      n++;
      const taskId = (await w.projects.createTask({ commandId: `t-${n}`, actor: w.owner.id, projectId, title: `work-${n}` })).id;
      await queue.enqueue({ commandId: `q-${n}`, actor: "controller", projectId, branch: "main", submissionId: sbm(n), taskId, base: BASE, tree: tree(n), author: "agent:writer" });
      w.clock.advance(MIN);
      return taskId;
    };
    // A task credential as A10b issues it, presented as the agent would present it.
    const credential = async (taskId: string, agent: string): Promise<{ token: string; id: string; as: Principal }> => {
      n++;
      const issued = await w.credentials.issue(w.owner, { commandId: `tc-${n}`, taskId, agentId: `agent:${agent}` });
      return { token: issued.token, id: issued.id, as: await w.credentials.authenticate(issued.token) };
    };
    const raw = async (kind: string, id: string, body: unknown) => {
      n++;
      const runner = new CommandRunner(w.storage, w.epoch, options);
      const now = await runner.get(kind, id);
      await runner.command("test.raw", { commandId: `raw-${n}`, actor: "test" }, async () => ({ payload: { n }, build: async () => ({ ref: { kind, id }, creates: now === undefined, changes: [now === undefined ? { type: "create" as const, ref: { kind, id }, body: body as JsonObject } : { type: "update" as const, ref: { kind, id }, expectedRevision: now.revision, body: body as JsonObject }], detail: {} }) }));
    };
    const end = async (taskId: string) => { n++; const t = (await w.projects.getTask(taskId))!; await w.projects.transitionTask({ commandId: `end-${n}`, actor: w.owner.id, taskId, expectedRevision: t.revision, to: "cancelled" }); };
    const land = (by: Principal, commandId: string, taskId: string, lease: { leaseId: string; fence: number }) => workspace.request(by, { commandId, operation: "landing", taskId, reason: "the woken integrator lands the first place", leaseId: lease.leaseId, fence: lease.fence });
    return { store, w, options, leases, leaseOps, queue, pool, capacity, wake, workspace, hostCalls, project, person, queued, credential, raw, end, land, close: () => store.close() };
  };

  test(`${backend.name}: a landing task's credential reaches exactly its own project's lease, pool answer and landing, and nothing of another project, branch or agent (card P10b)`, async () => {
    const r = await rig();
    try {
      const [a, b] = [await r.project("Apple"), await r.project("Birch")];
      const frontA = await r.queued(a);
      const frontB = await r.queued(b);
      const ivy = await r.person("ivy", integrates([a, b]));
      const max = await r.person("max", integrates([b]));
      const round = await r.wake.round();
      assert.deepEqual(round.woken.map((x) => [x.projectId, x.agentId]), [[a, "ivy"], [b, "max"]], JSON.stringify(round));
      const taskA = round.woken[0]!.taskId, taskB = round.woken[1]!.taskId;
      const cA = await r.credential(taskA, "ivy");
      assert.deepEqual(cA.as.taskScope?.projectId, a);
      assert.deepEqual(await r.wake.landingReach(cA.as), { taskId: taskA, projectId: a, branch: "main", agentId: "ivy" });

      // A hold of ivy's on another branch of Apple (made through the lease service itself, which applies no landing policy): the landing credential neither lists it nor is answered "holding" with it.
      const oldBranch = await r.leases.acquire({ commandId: "old-1", projectId: a, branch: "old", holder: "ivy", taskId: frontA, ttlMs: 30 * MIN });
      assert.equal(oldBranch.live, true);
      // The pool, on the landing credential: judged on its one branch only. With Apple's lease held by someone else, nothing is taken, and Birch (free, older work there or not, and served by ivy's own credential) is
      // neither taken nor counted.
      const forMax = await r.leaseOps.acquire(r.w.owner, { commandId: "own-1", taskId: frontA, branch: "main", ttlMs: 30 * MIN, holder: "max" });
      const none = await r.pool.next(cA.as, { commandId: "pn-1", ttlMs: 30 * MIN });
      assert.deepEqual(none.outcome === "none" ? [none.heldByOthers, none.awaitingWork, none.unreadable, none.partial] : none, [1, 0, 0, false], JSON.stringify(none));
      await r.leaseOps.release(r.w.owner, { commandId: "own-2", leaseId: forMax.leaseId });
      const took = await r.pool.next(cA.as, { commandId: "pn-2", ttlMs: 30 * MIN });
      assert.ok(took.outcome === "taken" && took.projectId === a && took.branch === "main" && took.lease.holder === "ivy", JSON.stringify(took));
      const lease = took.outcome === "taken" ? took.lease : undefined;
      // A repeat answers its own hold; the hold is ivy's, of Apple.
      const again = await r.pool.next(cA.as, { commandId: "pn-3", ttlMs: 30 * MIN });
      assert.ok(again.outcome === "holding" && again.projectId === a, JSON.stringify(again));

      // The lease door: its own branch's lease, renewed, listed; nothing of Birch, of another branch, or of another agent's hold.
      const renewed = await r.leaseOps.renew(cA.as, { commandId: "rn-1", leaseId: lease!.leaseId, fence: lease!.fence });
      assert.equal(renewed.holder, "ivy");
      assert.deepEqual((await r.leaseOps.list(cA.as, { projectId: a })).map((l) => [l.projectId, l.branch]), [[a, "main"]]);
      assert.deepEqual((await r.leaseOps.list(ivy, { projectId: a })).map((l) => l.branch).sort(), ["main", "old"], "ivy's own credential sees both");
      await refuses("not_found", () => r.leaseOps.renew(cA.as, { commandId: "x-0", leaseId: oldBranch.leaseId, fence: oldBranch.fence }));
      await refuses("not_found", () => r.leaseOps.list(cA.as, { projectId: b }));
      await refuses("not_found", () => r.leaseOps.acquire(cA.as, { commandId: "x-1", taskId: frontB, branch: "main", ttlMs: 30 * MIN }));
      await refuses("not_found", () => r.leaseOps.acquire(cA.as, { commandId: "x-2", taskId: frontA, branch: "release", ttlMs: 30 * MIN }));
      await refuses("not_found", () => r.leaseOps.acquire(cA.as, { commandId: "x-3", taskId: frontA, branch: 7 as never, ttlMs: 30 * MIN }));
      const maxLease = await r.leaseOps.acquire(max, { commandId: "m-1", taskId: frontB, branch: "main", ttlMs: 30 * MIN });
      await refuses("not_found", () => r.leaseOps.renew(cA.as, { commandId: "x-4", leaseId: maxLease.leaseId, fence: maxLease.fence }));
      await refuses("not_found", () => r.leaseOps.release(cA.as, { commandId: "x-5", leaseId: maxLease.leaseId, fence: maxLease.fence }));
      await refuses("not_found", () => r.leaseOps.release(cA.as, { commandId: "x-6", projectId: b, branch: "main", fence: maxLease.fence }));

      // The landing: of Apple's first place, under its own lease, reaches the host. No other operation, no other project's task, no other agent's lease.
      const landed = await r.land(cA.as, "land-1", frontA, renewed);
      assert.equal(landed.state, "done", JSON.stringify(landed));
      assert.deepEqual(r.hostCalls.map((c) => [c.taskId, c.operation]), [[frontA, "landing"]]);
      for (const operation of ["refresh", "release", "integration", "quarantine"] as const) await refuses("not_found", () => r.workspace.request(cA.as, { commandId: `op-${operation}`, operation, taskId: frontA, reason: "not a landing" }));
      await refuses("not_found", () => r.land(cA.as, "land-2", frontB, maxLease));
      await refuses("fenced", () => r.land(cA.as, "land-3", frontA, { leaseId: maxLease.leaseId, fence: maxLease.fence }));
      assert.equal(r.hostCalls.length, 1, "nothing else reached the host");
      // The request it made reads back to it; Birch's own landing credential cannot read it.
      const cB = await r.credential(taskB, "max");
      assert.equal((await r.workspace.get(cA.as, landed.id))?.taskId, frontA);
      assert.equal(await r.workspace.get(cB.as, landed.id), undefined);

      // The rights stay the agent's: without the exact workspace.manage, no landing; without integration.lease, no lease either (the task credential carries the agent's grants as they are now).
      const ivyRecord = (await r.w.principals.get("agent:ivy"))!;
      await r.w.principals.setGrants(r.w.owner, { commandId: "less-1", principalId: "agent:ivy", expectedRevision: ivyRecord.revision, grants: integrates([a, b]).filter((g) => !(g.action === "workspace.manage" && g.project === a)) });
      const less = await r.w.credentials.authenticate(cA.token);
      await refuses("not_found", () => r.land(less, "land-4", frontA, renewed));
      await r.w.principals.setGrants(r.w.owner, { commandId: "less-2", principalId: "agent:ivy", expectedRevision: ivyRecord.revision + 1, grants: [{ action: "workspace.manage", project: a }, { action: "workspace.manage", project: "*" }, { action: "integration.lease", project: b }, { action: "*", project: a }] });
      // A wildcard grant (even `*` on Apple) is not the exact right: the reach still serves nothing.
      const none2 = await r.w.credentials.authenticate(cA.token);
      await refuses("not_found", () => r.leaseOps.list(none2, { projectId: a }));
      // The pool: the landing task still has its reach, but with the right gone it serves nothing, so nothing is looked at, taken or counted.
      const nothing = await r.pool.next(none2, { commandId: "pn-4", ttlMs: 30 * MIN });
      assert.deepEqual(nothing.outcome === "none" ? [nothing.heldByOthers, nothing.awaitingWork, nothing.unreadable, nothing.partial, nothing.reason] : nothing, [0, 0, 0, false, "no project you integrate has approved work waiting to land"]);
      void ivy;
    } finally { await r.close(); }
  });

  test(`${backend.name}: only a landing task's own credential, of the woken integrator, while its wake is current, has a reach; anything else is refused as before (card P10b)`, async () => {
    const r = await rig();
    try {
      const [a, b] = [await r.project("Apple"), await r.project("Birch")];
      const frontA = await r.queued(a);
      await r.person("ivy", integrates([a, b]));
      await r.person("zed", integrates([a]));
      const round = await r.wake.round();
      const taskA = round.woken[0]!.taskId;
      const lease = (as: Principal, id: string) => r.leaseOps.acquire(as, { commandId: id, taskId: frontA, branch: "main", ttlMs: 30 * MIN });
      // An ordinary task credential of the same integrator: no reach, refused everywhere, as before.
      const plain = await r.credential(frontA, "ivy");
      assert.equal(await r.wake.landingReach(plain.as), undefined);
      await refuses("not_found", () => lease(plain.as, "p-1"));
      await refuses("forbidden", () => r.pool.next(plain.as, { commandId: "p-2", ttlMs: 30 * MIN }), /task credential/);
      await refuses("not_found", () => r.workspace.request(plain.as, { commandId: "p-3", operation: "landing", taskId: frontA, reason: "x" }));
      // The landing task's credential of another agent (one the owner issued for zed): not the woken integrator, no reach.
      const zed = await r.credential(taskA, "zed");
      assert.equal(await r.wake.landingReach(zed.as), undefined);
      await refuses("not_found", () => lease(zed.as, "z-1"));
      // An own credential (no task scope) has no reach; the owner neither.
      assert.equal(await r.wake.landingReach(await r.w.principals.authenticate((await r.w.principals.issueCredential(r.w.owner, "agent:ivy")).token)), undefined);
      assert.equal(await r.wake.landingReach(r.w.owner), undefined);

      const ivy = await r.credential(taskA, "ivy");
      assert.ok((await r.wake.landingReach(ivy.as)) !== undefined);
      // A wake record that names another task (a later wake replaced it): the old take reaches nothing, though its task is open.
      const wakeId = IntegratorWake.wakeIdOf(a, "main");
      const current = (await r.w.storage.getAggregate({ kind: WAKE_KIND, id: wakeId }))!.body as Record<string, unknown>;
      await r.raw(WAKE_KIND, wakeId, { ...current, taskId: frontA });
      assert.equal(await r.wake.landingReach(ivy.as), undefined);
      await refuses("not_found", () => lease(ivy.as, "w-1"));
      await r.raw(WAKE_KIND, wakeId, { ...current, agentId: "zed" });
      assert.equal(await r.wake.landingReach(ivy.as), undefined);
      await r.raw(WAKE_KIND, wakeId, { ...current, state: "closed" });
      assert.equal(await r.wake.landingReach(ivy.as), undefined, "a damaged wake record is no reach");
      await r.raw(WAKE_KIND, wakeId, current);
      assert.ok((await r.wake.landingReach(ivy.as)) !== undefined);
      // A damaged landing record: fail closed (no reach; the lease door refuses as for any task credential).
      const link = (await r.w.storage.getAggregate({ kind: LANDING_TASK_KIND, id: taskA }))!.body as Record<string, unknown>;
      await r.raw(LANDING_TASK_KIND, taskA, { ...link, frontTaskId: "../x" });
      await refuses("integrity", () => r.wake.landingReach(ivy.as));
      await refuses("not_found", () => lease(ivy.as, "d-1"));
      await refuses("forbidden", () => r.pool.next(ivy.as, { commandId: "d-2", ttlMs: 30 * MIN }));
      // A record naming another project than the credential's.
      await r.raw(LANDING_TASK_KIND, taskA, { ...link, projectId: b, wakeId: IntegratorWake.wakeIdOf(b, "main") });
      assert.equal(await r.wake.landingReach(ivy.as), undefined);
      await r.raw(LANDING_TASK_KIND, taskA, link);
      assert.ok((await r.wake.landingReach(ivy.as)) !== undefined);
      // A principal that only says it has the task scope (not from authentication) is judged by its grants as every principal is: an object with no snapshot time is refused by the access check.
      await refuses("not_found", () => lease({ id: "agent:ivy", kind: "agent", name: "ivy", grants: [{ action: "integration.lease", project: a }], taskScope: { taskId: taskA, projectId: a } }, "f-1"));
      // The task released: no landing task of ivy's now, so no reach.
      const asg = (await r.w.assignments.getAssignment(taskA))!;
      await r.w.assignments.releaseTask({ commandId: "rel-1", actor: r.w.owner.id, taskId: taskA, expectedRevision: asg.revision, reason: "the owner's choice" });
      assert.equal(await r.wake.landingReach(ivy.as), undefined);
      await refuses("not_found", () => lease(ivy.as, "r-1"));

    } finally { await r.close(); }
  });

  test(`${backend.name}: a principal presented before its task ended reaches nothing after; the reach rule on its own; a wake whose integrator holds the lease is not ended; an attempt admitted in the moment before the end keeps its task (card P10b)`, async () => {
    const r = await rig();
    try {
      const a = await r.project("Apple");
      const frontA = await r.queued(a);
      await r.person("ivy", integrates([a]));
      const one = await r.wake.round();
      const tA = one.woken[0]!.taskId;
      const c = await r.credential(tA, "ivy");
      // The woken integrator itself holds the branch while its work is still queued: its own landing, never "taken", and the task is not ended.
      const l = await r.leaseOps.acquire(c.as, { commandId: "own", taskId: frontA, branch: "main", ttlMs: 30 * MIN });
      const two = await r.wake.round();
      assert.deepEqual([two.ended, (await r.w.projects.getTask(tA))?.state], [undefined, "ready"], JSON.stringify(two));
      // The reach rule itself: a reach that is not this credential's (another task, another agent, another project or branch) serves nothing.
      const reach = (await r.wake.landingReach(c.as))!;
      assert.equal(reachServes(c.as, reach, a, "main"), true);
      assert.equal(reachServes(c.as, { ...reach, taskId: frontA }, a, "main"), false);
      assert.equal(reachServes(c.as, { ...reach, agentId: "zed" }, a, "main"), false);
      assert.equal(reachServes(c.as, reach, a, "old"), false);
      assert.equal(reachServes(c.as, undefined, a), false);
      assert.equal(reachServes({ ...c.as, taskScope: undefined } as unknown as Principal, reach, a), false, "an own credential has no reach");
      // The task ended (the owner cancelled it): the principal presented before still has its task scope, but reaches nothing now.
      await r.leaseOps.release(c.as, { commandId: "back", leaseId: l.leaseId, fence: l.fence });
      await r.end(tA);
      assert.equal(await r.wake.landingReach(c.as), undefined);
      await refuses("not_found", () => r.leaseOps.acquire(c.as, { commandId: "after", taskId: frontA, branch: "main", ttlMs: 30 * MIN }));

      // An attempt admitted between the round's look and its write: the write's assignment check refuses it, so the task is not ended under it.
      const three = await r.wake.round();
      const t2 = three.woken[0]!.taskId;
      await r.queue.remove({ commandId: "out", actor: "controller", projectId: a, branch: "main", taskId: frontA, reason: "taken out" });
      let admitted: string | undefined, reads = 0;
      const projects = {
        ...r.w.projects,
        createTask: r.w.projects.createTask.bind(r.w.projects), transitionTask: r.w.projects.transitionTask.bind(r.w.projects),
        getTask: async (id: string) => {
          // The first read is the round's list of open wakes; the second is the end's own look, after its look at the assignment.
          if (id === t2 && ++reads === 2) {
            const asg = (await r.w.assignments.getAssignment(t2))!;
            admitted = (await r.w.assignments.admitAttempt({ commandId: "race", actor: "inbox", taskId: t2, expectedRevision: asg.revision, generation: asg.generation, owner: { kind: "agent", id: "ivy" }, harness: "pi" })).id;
          }
          return r.w.projects.getTask(id);
        },
      };
      const racing = IntegratorWake.withEpoch(r.w.storage, r.w.epoch, { queue: r.queue, leases: r.leases, capacity: r.capacity, projects: projects as never, assignments: r.w.assignments, landingBranch: async () => "main", activeAgent: async () => true }, r.options);
      const four = await racing.round();
      assert.ok(admitted !== undefined);
      assert.deepEqual([four.ended, four.unreadable, (await r.w.projects.getTask(t2))?.state], [undefined, 1, "ready"], JSON.stringify(four));
    } finally { await r.close(); }
  });

  test(`${backend.name}: a fresh landing task and credential per project and per take; no credential, lease or recorded answer crosses between them (card P10b)`, async () => {
    const r = await rig();
    try {
      const [a, b] = [await r.project("Apple"), await r.project("Birch")];
      const frontA = await r.queued(a);
      const frontB = await r.queued(b);
      await r.person("ivy", integrates([a, b]));
      // Take 1: Apple (its work waited longest); Birch has no other integrator, so it waits (ivy is busy: one project at a time).
      const one = await r.wake.round();
      assert.deepEqual([one.woken.map((x) => x.projectId), one.noneFree], [[a], 1]);
      const t1 = one.woken[0]!.taskId;
      const c1 = await r.credential(t1, "ivy");
      const l1 = await r.leaseOps.acquire(c1.as, { commandId: "take", taskId: frontA, branch: "main", ttlMs: 30 * MIN });
      assert.deepEqual([l1.projectId, l1.holder], [a, "ivy"]);
      await r.land(c1.as, "land", frontA, l1);
      await r.leaseOps.release(c1.as, { commandId: "give-back", leaseId: l1.leaseId, fence: l1.fence });
      // Apple's work landed (out of its queue): the next round ends the landing task by itself, and the round after wakes ivy for Birch.
      await r.queue.remove({ commandId: "landed-a", actor: "controller", projectId: a, branch: "main", taskId: frontA, reason: "landed" });
      const two = await r.wake.round();
      assert.deepEqual(two.ended, [{ projectId: a, branch: "main", taskId: t1, why: "landed" }], JSON.stringify(two));
      assert.equal((await r.w.projects.getTask(t1))?.state, "cancelled");
      const three = await r.wake.round();
      assert.deepEqual(three.woken.map((x) => x.projectId), [b], JSON.stringify(three));
      const t2 = three.woken[0]!.taskId;
      assert.notEqual(t2, t1);
      // Take 2 has its own task and credential: the first is refused outright now (its task ended), and the second is another record with another secret.
      await refuses("unauthenticated", () => r.w.credentials.authenticate(c1.token));
      const c2 = await r.credential(t2, "ivy");
      assert.notEqual(c2.id, c1.id);
      assert.deepEqual(c2.as.taskScope?.projectId, b);
      assert.notEqual(takeKeyOf(c1.as), takeKeyOf(c2.as));
      // The same command IDs in take 2 are new commands of take 2, never a replay of take 1's answers: "take" gives Birch's lease, "land" lands Birch's work.
      const l2 = await r.leaseOps.acquire(c2.as, { commandId: "take", taskId: frontB, branch: "main", ttlMs: 30 * MIN });
      assert.deepEqual([l2.projectId, l2.leaseId === l1.leaseId], [b, false]);
      const landed2 = await r.land(c2.as, "land", frontB, l2);
      assert.deepEqual([landed2.taskId, landed2.replayed], [frontB, false]);
      assert.deepEqual(r.hostCalls.map((c) => c.taskId), [frontA, frontB]);
      // Nothing of Apple through take 2: not its leases, not its landing request, not a lease of Apple's branch.
      await refuses("not_found", () => r.leaseOps.list(c2.as, { projectId: a }));
      await refuses("not_found", () => r.leaseOps.acquire(c2.as, { commandId: "take-a", taskId: frontA, branch: "main", ttlMs: 30 * MIN }));
      const firstRequest = (await r.w.storage.listAggregates("workspace-request", { limit: 10 })).map((x) => ({ id: x.id, taskId: (x.body as { taskId: string }).taskId })).find((x) => x.taskId === frontA)!;
      assert.equal(await r.workspace.get(c2.as, firstRequest.id), undefined);

      // A later take in the same project is a new task and credential again (Birch's work landed; new work there; take 2 ends; take 3 wakes).
      await r.leaseOps.release(c2.as, { commandId: "give-back", leaseId: l2.leaseId, fence: l2.fence });
      await r.queue.remove({ commandId: "landed-b", actor: "controller", projectId: b, branch: "main", taskId: frontB, reason: "landed" });
      const frontB2 = await r.queued(b);
      const four = await r.wake.round();
      assert.deepEqual(four.ended?.map((x) => x.taskId), [t2]);
      const five = await r.wake.round();
      const t3 = five.woken[0]!.taskId;
      assert.ok(t3 !== t2 && t3 !== t1, JSON.stringify(five));
      await refuses("unauthenticated", () => r.w.credentials.authenticate(c2.token));
      const c3 = await r.credential(t3, "ivy");
      const l3 = await r.leaseOps.acquire(c3.as, { commandId: "take", taskId: frontB2, branch: "main", ttlMs: 30 * MIN });
      assert.ok(l3.fence > l2.fence, "a new hold of the branch, not take 2's answer");
    } finally { await r.close(); }
  });

  test(`${backend.name}: a wake ends by itself when its work is no longer queued or another integrator took the branch, never under an attempt (card P10b)`, async () => {
    const r = await rig();
    try {
      const [a, b] = [await r.project("Apple"), await r.project("Birch")];
      const frontA = await r.queued(a);
      const frontB = await r.queued(b);
      await r.person("ivy", integrates([a]));
      await r.person("max", integrates([b]));
      const zoe = await r.person("zoe", integrates([b]));
      const one = await r.wake.round();
      const [tA, tB] = [one.woken[0]!.taskId, one.woken[1]!.taskId];
      // Birch: zoe (not the woken integrator) takes the branch with her own credential. Apple: its work leaves the queue, but ivy's attempt is admitted: nothing ends under it.
      await r.leaseOps.acquire(zoe, { commandId: "zoe-1", taskId: frontB, branch: "main", ttlMs: 30 * MIN });
      await r.queue.remove({ commandId: "out-a", actor: "controller", projectId: a, branch: "main", taskId: frontA, reason: "taken out" });
      const asg = (await r.w.assignments.getAssignment(tA))!;
      const attempt = (await r.w.assignments.admitAttempt({ commandId: "adm-a", actor: "inbox", taskId: tA, expectedRevision: asg.revision, generation: asg.generation, owner: { kind: "agent", id: "ivy" }, harness: "pi" })).id;
      const two = await r.wake.round();
      assert.deepEqual(two.ended, [{ projectId: b, branch: "main", taskId: tB, why: "taken" }], JSON.stringify(two));
      assert.deepEqual([(await r.w.projects.getTask(tA))?.state, (await r.w.projects.getTask(tB))?.state], ["ready", "cancelled"]);
      // A repeat round does not end Birch's again or touch Apple's while its attempt is active.
      const three = await r.wake.round();
      assert.equal(three.ended, undefined, JSON.stringify(three));
      // The attempt ends as usual; then the next round ends Apple's task.
      const now = (await r.w.assignments.getAssignment(tA))!;
      await r.w.assignments.finishAttempt({ commandId: "fin-a", actor: "inbox", taskId: tA, expectedRevision: now.revision, fence: { generation: now.generation, attemptId: attempt }, outcome: "succeeded" });
      const four = await r.wake.round();
      assert.deepEqual(four.ended?.map((x) => [x.taskId, x.why]), [[tA, "landed"]], JSON.stringify(four));
      // A partial read of the queues never takes a missing queue as landed.
      const frontA2 = await r.queued(a);
      const five = await r.wake.round();
      const tA2 = five.woken.find((x) => x.projectId === a)!.taskId;
      const partial = IntegratorWake.withEpoch(r.w.storage, r.w.epoch, { queue: { queuesWithEntries: async () => ({ queues: [], partial: true }) }, leases: r.leases, capacity: r.capacity, projects: r.w.projects, assignments: r.w.assignments, landingBranch: async () => "main", activeAgent: async () => true }, r.options);
      const six = await partial.round();
      assert.equal(six.ended, undefined);
      assert.equal((await r.w.projects.getTask(tA2))?.state, "ready");
      void frontA2;
    } finally { await r.close(); }
  });

  test(`${backend.name}: an ended wake whose work landed gives back the woken integrator's idle hold, never another's or a changed one; a landing on a task credential needs both landing gates (card P10b)`, async () => {
    const r = await rig();
    try {
      const [a, b] = [await r.project("Apple"), await r.project("Birch")];
      const frontA = await r.queued(a);
      const frontB = await r.queued(b);
      await r.person("ivy", integrates([a]));
      await r.person("max", integrates([b]));
      const zoe = await r.person("zoe", integrates([b]));
      const one = await r.wake.round();
      const [tA, tB] = [one.woken.find((x) => x.projectId === a)!.taskId, one.woken.find((x) => x.projectId === b)!.taskId];
      // Apple: ivy takes the branch on its landing credential, lands, and keeps the hold; its work then leaves the queue. Birch: max holds the branch, then its work leaves the queue, then the hold changes hands
      // (max gives it back and zoe takes it) after the round read the leases: that hold is not max's to give back any more.
      const cA = await r.credential(tA, "ivy");
      const lA = await r.leaseOps.acquire(cA.as, { commandId: "take", taskId: frontA, branch: "main", ttlMs: 30 * MIN });
      await r.queue.remove({ commandId: "landed-a", actor: "controller", projectId: a, branch: "main", taskId: frontA, reason: "landed" });
      const cB = await r.credential(tB, "max");
      const lB = await r.leaseOps.acquire(cB.as, { commandId: "take", taskId: frontB, branch: "main", ttlMs: 30 * MIN });
      await r.queue.remove({ commandId: "landed-b", actor: "controller", projectId: b, branch: "main", taskId: frontB, reason: "landed" });
      let swapped = false;
      const leases = {
        liveLeases: async () => {
          const seen = await r.leases.liveLeases();
          if (!swapped) { swapped = true; await r.leaseOps.release(cB.as, { commandId: "give-back", leaseId: lB.leaseId, fence: lB.fence }); await r.leaseOps.acquire(zoe, { commandId: "zoe", taskId: frontB, branch: "main", ttlMs: 30 * MIN }); }
          return seen;
        },
        projectOfTask: (t: string) => r.leases.projectOfTask(t),
        release: (c: Parameters<typeof r.leases.release>[0]) => r.leases.release(c),
      };
      const ending = IntegratorWake.withEpoch(r.w.storage, r.w.epoch, { queue: r.queue, leases, capacity: r.capacity, projects: r.w.projects, assignments: r.w.assignments, landingBranch: async () => "main", activeAgent: async () => true }, r.options);
      const two = await ending.round();
      const byTask = new Map((two.ended ?? []).map((e) => [e.taskId, e]));
      assert.deepEqual([byTask.get(tA)?.why, byTask.get(tA)?.lease, byTask.get(tB)?.why, byTask.get(tB)?.lease], ["landed", "released", "landed", undefined], JSON.stringify(two));
      const [nowA, nowB] = [await r.leases.get(lA.leaseId), await r.leases.get(lB.leaseId)];
      assert.deepEqual([nowA?.live, nowB?.live, nowB?.holder], [false, true, "zoe"], "ivy's idle hold is given back; zoe's new hold is untouched");
      // A hold of another active integrator (taken) is never given back by the end.
      assert.equal((await r.leases.get(lB.leaseId))?.fence, lB.fence + 1);

      // A workspace service with no lease gate (or no queue gate) refuses a landing task's credential outright, as for any task credential.
      const frontA2 = await r.queued(a);
      const three = await r.wake.round();
      const tA2 = three.woken.find((x) => x.projectId === a)!.taskId;
      const cA2 = await r.credential(tA2, "ivy");
      assert.ok((await r.wake.landingReach(cA2.as)) !== undefined);
      const port = { run: async () => ({ ok: true, summary: "landed", detail: { landed: true } }) } as unknown as WorkspacePort;
      const base = { landingReach: (by: Principal) => r.wake.landingReach(by), quiesce: { around: async (_s: unknown, _o: unknown, run: (x: never) => Promise<unknown>) => run({ attempts: [] } as never) }, portOf: async () => port, attempts: { live: async () => [], frozenReason: async () => undefined, release: async () => undefined, tell: async () => true } } as never;
      const noLease = WorkspaceOpService.withEpoch(r.w.storage, r.w.epoch, { ...(base as object), landingQueue: { check: async () => undefined, landedChanges: async () => [] } } as never, r.options);
      const noQueue = WorkspaceOpService.withEpoch(r.w.storage, r.w.epoch, { ...(base as object), landingLease: async () => undefined } as never, r.options);
      for (const svc of [noLease, noQueue]) await refuses("not_found", () => svc.request(cA2.as, { commandId: "ungated", operation: "landing", taskId: frontA2, reason: "no gate" }));
    } finally { await r.close(); }
  });

  test(`${backend.name}: the owner's woken answer says who the landing task is with now; costs after the fact go to the queued work's task (card P10b)`, async () => {
    const r = await rig();
    try {
      const a = await r.project("Apple");
      const frontA = await r.queued(a);
      await r.person("ivy", integrates([a]));
      await r.person("zed", integrates([a]));
      const one = await r.wake.round();
      const tA = one.woken[0]!.taskId;
      const answer = async () => { const x = await r.capacity.of(a, "main", frontA); return x.state === "woken" ? [x.agentId, x.with, x.other] : [x.state]; };
      assert.deepEqual(await answer(), ["ivy", "integrator", undefined]);
      // Transferred to zed: zed's ordinary work, named.
      let asg = (await r.w.assignments.getAssignment(tA))!;
      await r.w.assignments.transferTask({ commandId: "tr-1", actor: r.w.owner.id, taskId: tA, expectedRevision: asg.revision, to: { kind: "agent", id: "zed" }, reason: "the owner's choice" });
      assert.deepEqual(await answer(), ["ivy", "other", "zed"]);
      // Released: assigned to nobody.
      asg = (await r.w.assignments.getAssignment(tA))!;
      await r.w.assignments.releaseTask({ commandId: "rel-1", actor: r.w.owner.id, taskId: tA, expectedRevision: asg.revision, reason: "the owner's choice" });
      assert.deepEqual(await answer(), ["ivy", "released", undefined]);
      // A refused read says nothing; any other failure is thrown.
      const refusing = new IntegratorCapacity(r.leases, { agents: () => activeAgentIds(r.w.storage), principal: (id) => r.w.principals.current(id), wakes: () => r.wake.now(), assignmentOf: async () => { throw new DomainError("unavailable", "no"); } });
      const quiet = await refusing.of(a, "main", frontA);
      assert.deepEqual(quiet.state === "woken" ? [quiet.with, quiet.other] : quiet, [undefined, undefined]);
      const failing = new IntegratorCapacity(r.leases, { agents: () => activeAgentIds(r.w.storage), principal: (id) => r.w.principals.current(id), wakes: () => r.wake.now(), assignmentOf: async () => { throw new TypeError("broken"); } });
      await assert.rejects(() => failing.of(a, "main", frontA), TypeError);
      const none = new IntegratorCapacity(r.leases, { agents: () => activeAgentIds(r.w.storage), principal: (id) => r.w.principals.current(id), wakes: () => r.wake.now(), assignmentOf: async () => undefined });
      const un = await none.of(a, "main", frontA);
      assert.equal(un.state === "woken" ? un.with : un.state, "unassigned");

      // After-the-fact costs: a landing task's are the queued work's (while it is the woken integrator's landing); any other task's are its own; a damaged landing record charges the task itself.
      const two = await r.wake.round();
      void two;
      assert.equal(await r.wake.chargeTaskOf(frontA), frontA);
      const b = await r.project("Birch");
      const frontB = await r.queued(b);
      await r.person("max", integrates([b]));
      const woke = await r.wake.round();
      const tB = woke.woken.find((x) => x.projectId === b)!.taskId;
      assert.equal(await r.wake.chargeTaskOf(tB), frontB);
      const link = (await r.w.storage.getAggregate({ kind: LANDING_TASK_KIND, id: tB }))!.body as Record<string, unknown>;
      await r.raw(LANDING_TASK_KIND, tB, { ...link, wakeId: "iwk-0" });
      assert.equal(await r.wake.chargeTaskOf(tB), tB);
    } finally { await r.close(); }
  });

  test(`${backend.name}: through the dispatcher, each take's attempt gets its own credential and starts afresh, and that credential takes only its own project's lease (card P10b)`, async () => {
    const r = await rig();
    try {
      const w = r.w;
      const a = w.project;
      const b = await r.project("Birch");
      const frontA = await r.queued(a);
      const frontB = await r.queued(b);
      await w.agent("ivy", [...workGrants(a), ...workGrants(b), ...integrates([a, b])]);
      const seen: { taskId: string; projectId: string; attemptId: string; credential: string; resumeFrom: unknown; content: string; own: string; other: string }[] = [];
      w.worker.script = async ({ order }) => {
        const as = await w.credentials.authenticate(order.credential);
        const mine = order.projectId === a ? frontA : frontB, theirs = order.projectId === a ? frontB : frontA;
        const own = await r.leaseOps.acquire(as, { commandId: "take", taskId: mine, branch: "main", ttlMs: 30 * MIN }).then((l) => `${l.projectId}:${l.holder}`, (e: Error) => `refused:${e.message}`);
        const other = await r.leaseOps.acquire(as, { commandId: "take-other", taskId: theirs, branch: "main", ttlMs: 30 * MIN }).then((l) => `${l.projectId}:${l.holder}`, (e: Error) => `refused:${(e as DomainError).code}`);
        await r.leaseOps.release(as, { commandId: "give-back", projectId: order.projectId, branch: "main", fence: (await r.leases.get(IntegratorLeaseService.leaseIdOf(order.projectId, "main")))!.fence }).catch(() => undefined);
        seen.push({ taskId: order.taskId, projectId: order.projectId, attemptId: order.attemptId, credential: order.credential, resumeFrom: order.resumeFrom, content: order.content, own, other });
        return { status: "completed", text: "landed" };
      };
      w.dispatcher = w.restart({ landingOf: (t) => r.wake.landingOf(t) });
      const run = async (taskId: string, n: number) => {
        const asg = (await w.assignments.getAssignment(taskId))!;
        const attempt = (await w.assignments.admitAttempt({ commandId: `adm-${n}`, actor: "inbox", taskId, expectedRevision: asg.revision, generation: asg.generation, owner: { kind: "agent", id: "ivy" }, harness: "pi" })).id;
        await w.heartbeatHost();
        const tick = await w.dispatcher.tick();
        assert.ok(tick.started.includes(attempt), JSON.stringify(tick));
        await w.dispatcher.idle();
        return attempt;
      };
      const one = await r.wake.round();
      const t1 = one.woken[0]!.taskId;
      assert.equal(one.woken[0]!.projectId, a);
      const att1 = await run(t1, 1);
      await r.queue.remove({ commandId: "landed-a", actor: "controller", projectId: a, branch: "main", taskId: frontA, reason: "landed" });
      await r.wake.round();
      const two = await r.wake.round();
      const t2 = two.woken[0]!.taskId;
      assert.equal(two.woken[0]!.projectId, b, JSON.stringify(two));
      const att2 = await run(t2, 2);
      assert.equal(seen.length, 2, JSON.stringify(seen));
      const [s1, s2] = [seen[0]!, seen[1]!];
      assert.deepEqual([s1.taskId, s1.projectId, s1.attemptId, s2.taskId, s2.projectId, s2.attemptId], [t1, a, att1, t2, b, att2]);
      // Each take: its own credential (another record, another secret), started afresh (nothing resumed), its text naming nothing of the other take.
      assert.notEqual(s1.credential.split(".")[0], s2.credential.split(".")[0]);
      assert.deepEqual([s1.resumeFrom, s2.resumeFrom], [undefined, undefined]);
      assert.ok(!s2.content.includes(t1) && !s2.content.includes(frontA), "the second take's text names nothing of the first");
      // Each took its own project's lease and nothing of the other's.
      assert.deepEqual([s1.own, s1.other, s2.own, s2.other], [`${a}:ivy`, "refused:not_found", `${b}:ivy`, "refused:not_found"]);
      // The first take's credential is no use any more (its attempt and task are over).
      await refuses("unauthenticated", () => w.credentials.authenticate(s1.credential));
    } finally { await r.close(); }
  });
  test(`${backend.name}: a wake left unassigned whose work then leaves the queue is ended, so its integrator is not counted busy for ever (card P10b, second review)`, async () => {
    const r = await rig();
    try {
      const [a, b] = [await r.project("Apple"), await r.project("Birch")];
      const frontA = await r.queued(a);
      await r.person("ivy", integrates([a, b]));
      // The round stops after the wake's records and before its assignment (a refused assignment): the wake is open, its task assigned to nobody.
      let failing = true;
      const flaky = IntegratorWake.withEpoch(r.w.storage, r.w.epoch, { queue: r.queue, leases: r.leases, capacity: r.capacity, projects: r.w.projects, assignments: { getAssignment: (t) => r.w.assignments.getAssignment(t), assignTask: async (c) => { if (failing) { failing = false; throw new DomainError("unavailable", "store fault"); } return r.w.assignments.assignTask(c); } }, landingBranch: async () => "main", activeAgent: async () => true }, r.options);
      const one = await flaky.round();
      assert.deepEqual([one.woken.length, one.unreadable], [0, 1], JSON.stringify(one));
      const open = (await r.wake.now()).open;
      assert.equal(open.length, 1);
      const tA = open[0]!.taskId;
      assert.equal(await r.w.assignments.getAssignment(tA), undefined);
      // Before the next round, the work leaves the queue (the owner landed it or took it out): no queue is left to finish the wake from.
      await r.queue.remove({ commandId: "out-a", actor: "controller", projectId: a, branch: "main", taskId: frontA, reason: "taken out" });
      const two = await r.wake.round();
      assert.deepEqual(two.ended?.map((x) => [x.taskId, x.why]), [[tA, "landed"]], JSON.stringify(two));
      assert.equal((await r.w.projects.getTask(tA))?.state, "cancelled");
      assert.equal(await r.w.assignments.getAssignment(tA), undefined, "nothing was assigned to the ended task");
      // ivy is free again: Birch's work wakes it.
      await r.queued(b);
      const three = await r.wake.round();
      assert.deepEqual(three.woken.map((x) => [x.projectId, x.agentId]), [[b, "ivy"]], JSON.stringify(three));
    } finally { await r.close(); }
  });

  test(`${backend.name}: an unassigned wake assigned in the moment before its end keeps its task; a live hold of an integrator that is not active is not "taken" (card P10b, second review)`, async () => {
    const r = await rig();
    try {
      const a = await r.project("Apple");
      const frontA = await r.queued(a);
      await r.person("ivy", integrates([a]));
      const zoe = await r.person("zoe", integrates([a]));
      let failing = true;
      const deps = { queue: r.queue, leases: r.leases, capacity: r.capacity, projects: r.w.projects, landingBranch: async () => "main", activeAgent: async () => true };
      const flaky = IntegratorWake.withEpoch(r.w.storage, r.w.epoch, { ...deps, assignments: { getAssignment: (t) => r.w.assignments.getAssignment(t), assignTask: async (c) => { if (failing) { failing = false; throw new DomainError("unavailable", "store fault"); } return r.w.assignments.assignTask(c); } } }, r.options);
      const one = await flaky.round();
      assert.equal(one.woken.length, 0, JSON.stringify(one));
      const tA = (await r.wake.now()).open[0]!.taskId;
      await r.queue.remove({ commandId: "out-a", actor: "controller", projectId: a, branch: "main", taskId: frontA, reason: "taken out" });
      // The end's look sees no assignment; the owner assigns the task before the end's write: the write is refused and the task stays the assignee's.
      let reads = 0;
      const projects = {
        ...r.w.projects, createTask: r.w.projects.createTask.bind(r.w.projects), transitionTask: r.w.projects.transitionTask.bind(r.w.projects),
        getTask: async (id: string) => {
          if (id === tA && ++reads === 2) await r.w.assignments.assignTask({ commandId: "own-asg", actor: r.w.owner.id, taskId: tA, owner: { kind: "agent", id: "ivy" }, reason: "the owner's choice" });
          return r.w.projects.getTask(id);
        },
      };
      const racing = IntegratorWake.withEpoch(r.w.storage, r.w.epoch, { ...deps, projects: projects as never, assignments: r.w.assignments }, r.options);
      const two = await racing.round();
      assert.deepEqual([two.ended, two.unreadable, (await r.w.projects.getTask(tA))?.state], [undefined, 1, "ready"], JSON.stringify(two));
      assert.equal((await r.w.assignments.getAssignment(tA))?.owner?.id, "ivy");

      // New work; zoe holds the branch but is not active (as the controller sees her): that hold does not make the wake "taken".
      await r.end(tA);
      await r.queued(a);
      const three = await r.wake.round();
      const t2 = three.woken[0]!.taskId;
      await r.leaseOps.acquire(zoe, { commandId: "zoe", taskId: frontA, branch: "main", ttlMs: 30 * MIN });
      const notActive = IntegratorWake.withEpoch(r.w.storage, r.w.epoch, { ...deps, assignments: r.w.assignments, activeAgent: async (id: string) => id !== "zoe" }, r.options);
      const four = await notActive.round();
      assert.deepEqual([four.ended, (await r.w.projects.getTask(t2))?.state], [undefined, "ready"], JSON.stringify(four));
      const five = await r.wake.round();
      assert.deepEqual(five.ended?.map((x) => [x.taskId, x.why]), [[t2, "taken"]], JSON.stringify(five));
    } finally { await r.close(); }
  });
}
