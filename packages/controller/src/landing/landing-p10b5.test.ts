import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { CommandRunner } from "../domain/runner.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld } from "../dispatch/testing/world.js";
import type { Grant, Principal } from "../security/principals.js";
import type { JsonObject } from "../storage/types.js";
import { WorkspaceOpService, type WorkspaceCall, type WorkspacePort } from "../workspace-ops/index.js";
import {
  IntegratorCapacity, IntegratorLeaseOps, IntegratorLeaseService, IntegratorPool, IntegratorWake, LANDING_TASK_KIND, LandingQueueService, WAKE_KIND, activeAgentIds, frontOf,
} from "./index.js";
import { assignmentIdOf } from "../domain/assignment-model.js";
import { CHARGE_PIN_KIND } from "./integrator-wake.js";

after(stopServer);

// Card P10b, fifth slice (the fourth slice's follow-ups). A woken integrator that finishes its landing task while it still holds the branch no longer keeps the branch counted as held until the hold runs out: its
// task's text tells it to release first, and the wake's round gives back the hold once the task is done, but only a hold provably that take's (taken on the landing task's own credential and not renewed on another
// or handed over since, not renewed after the round read it). A charge of a landing task names the same budget task on every try of its command, so a pending charge settles after a release or a transfer.
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
    // The landing task finished by its integrator (ready -> in_progress -> done), as an attempt would.
    const finish = async (taskId: string) => {
      for (const to of ["in_progress", "done"] as const) { n++; const t = (await w.projects.getTask(taskId))!; await w.projects.transitionTask({ commandId: `fin-${n}`, actor: w.owner.id, taskId, expectedRevision: t.revision, to }); }
    };
    const leaseOf = (projectId: string) => leases.get(IntegratorLeaseService.leaseIdOf(projectId, "main"));
    const wakeWith = (leaseDeps: Partial<Parameters<typeof IntegratorWake.withEpoch>[2]["leases"]>, more: Partial<Parameters<typeof IntegratorWake.withEpoch>[2]> = {}) =>
      IntegratorWake.withEpoch(w.storage, w.epoch, { queue, leases: { liveLeases: (p?: number) => leases.liveLeases(p), projectOfTask: (t: string) => leases.projectOfTask(t), release: (c: Parameters<typeof leases.release>[0]) => leases.release(c), ...leaseDeps }, capacity, projects: w.projects, assignments: w.assignments, landingBranch, activeAgent, ...more }, options);
    return { store, w, options, leases, leaseOps, queue, pool, capacity, wake, workspace, hostCalls, project, person, queued, credential, raw, end, land, finish, leaseOf, wakeWith, close: () => store.close() };
  };

  test(`${backend.name}: a hold taken on a landing task's credential carries its mark; a renew on that credential keeps it, one on the agent's own credential, a hand-over or an own take does not (card P10b)`, async () => {
    const r = await rig();
    try {
      const a = await r.project("Apple");
      const frontA = await r.queued(a);
      const ivy = await r.person("ivy", integrates([a]));
      await r.person("max", integrates([a]));
      const tA = (await r.wake.round()).woken[0]!.taskId;
      const cA = await r.credential(tA, "ivy");
      const took = await r.leaseOps.acquire(cA.as, { commandId: "take", taskId: frontA, branch: "main", ttlMs: 30 * MIN });
      assert.equal(took.landingTask, tA);
      r.w.clock.advance(MIN);
      assert.equal((await r.leaseOps.renew(cA.as, { commandId: "keep", leaseId: took.leaseId, fence: took.fence })).landingTask, tA, "renewed on the same landing credential: still that take");
      r.w.clock.advance(MIN);
      const own = await r.leaseOps.renew(ivy, { commandId: "keep-own", leaseId: took.leaseId, fence: took.fence });
      assert.deepEqual([own.landingTask, own.fence, own.live], [undefined, took.fence, true], "renewed on ivy's own credential: ivy's own hold from now on");
      // The mark never comes back on a later renew of the landing credential.
      r.w.clock.advance(MIN);
      assert.equal((await r.leaseOps.renew(cA.as, { commandId: "keep-2", leaseId: took.leaseId, fence: took.fence })).landingTask, undefined);
      await r.leaseOps.release(cA.as, { commandId: "give", leaseId: took.leaseId, fence: took.fence });
      // An own take, and the owner's take for a named agent, carry no mark; a hand-over drops one.
      const mine = await r.leaseOps.acquire(ivy, { commandId: "own-take", taskId: frontA, branch: "main", ttlMs: 30 * MIN });
      assert.equal(mine.landingTask, undefined);
      await r.leaseOps.release(ivy, { commandId: "own-give", leaseId: mine.leaseId, fence: mine.fence });
      const forMax = await r.leaseOps.acquire(r.w.owner, { commandId: "owner-take", taskId: frontA, branch: "main", ttlMs: 30 * MIN, holder: "max" });
      assert.equal(forMax.landingTask, undefined);
      await r.leaseOps.release(r.w.owner, { commandId: "owner-give", leaseId: forMax.leaseId });
      const again = await r.leaseOps.acquire(cA.as, { commandId: "take-2", taskId: frontA, branch: "main", ttlMs: 30 * MIN });
      assert.equal(again.landingTask, tA);
      const moved = await r.leases.handOver({ commandId: "hand", leaseId: again.leaseId, fence: again.fence, to: "max", taskId: frontA });
      assert.deepEqual([moved.holder, moved.landingTask], ["max", undefined]);
      // A mark that is not a task ID is refused outright.
      await refuses("invalid_command", () => r.leases.acquire({ commandId: "bad", projectId: a, branch: "other", holder: "ivy", taskId: frontA, ttlMs: MIN, landingTask: "../x" }));
    } finally { await r.close(); }
  });

  test(`${backend.name}: a landing task finished while its integrator still holds the branch: the round gives the hold back and the branch's work is woken for again; the task's text says to release first (card P10b)`, async () => {
    const r = await rig();
    try {
      const a = await r.project("Apple");
      const frontA = await r.queued(a);
      await r.person("ivy", integrates([a]));
      const tA = (await r.wake.round()).woken[0]!.taskId;
      assert.match((await r.w.projects.getTask(tA))!.description, /release the lease first and then finish this task/);
      const cA = await r.credential(tA, "ivy");
      const held = await r.leaseOps.acquire(cA.as, { commandId: "take", taskId: frontA, branch: "main", ttlMs: 30 * MIN });
      // The round while the task is open: nothing given back, the branch is the woken integrator's.
      const open = await r.wake.round();
      assert.deepEqual([open.freed, (await r.leaseOf(a))?.live], [undefined, true], JSON.stringify(open));
      // ivy finishes the task without releasing: its credential reaches nothing now, and the hold would keep the branch held for up to a day.
      await r.finish(tA);
      assert.equal(await r.wake.landingReach(cA.as), undefined);
      r.w.clock.advance(MIN);
      const freeing = await r.wake.round();
      assert.deepEqual(freeing.freed, [{ projectId: a, branch: "main", taskId: tA, agentId: "ivy" }], JSON.stringify(freeing));
      const after = (await r.leaseOf(a))!;
      assert.deepEqual([after.live, after.state, after.fence], [false, "released", held.fence]);
      // The work is still first in the queue (nothing landed): the next round wakes an integrator for it again.
      const next = await r.wake.round();
      assert.deepEqual(next.woken.map((x) => [x.projectId, x.agentId]), [[a, "ivy"]], JSON.stringify(next));
      assert.notEqual(next.woken[0]!.taskId, tA);
      // A repeat of the give-back is nothing: the hold is released already.
      const again = await r.wake.round();
      assert.equal(again.freed, undefined);
    } finally { await r.close(); }
  });

  test(`${backend.name}: a done landing task's hold is left alone unless provably that take's idle hold (card P10b)`, async () => {
    const r = await rig();
    try {
      const names = ["Apple", "Birch", "Cedar", "Dogwood", "Elm", "Fir"];
      const agents = ["ann", "bob", "cy", "dee", "eve", "fay"];
      const ps: string[] = [], fronts: string[] = [], own: Principal[] = [];
      for (const name of names) ps.push(await r.project(name));
      for (const p of ps) fronts.push(await r.queued(p));
      for (let i = 0; i < ps.length; i++) own.push(await r.person(agents[i]!, integrates([ps[i]!])));
      // Five wakes per round at most: two rounds wake all six.
      const woken = [...(await r.wake.round()).woken, ...(await r.wake.round()).woken];
      const task = (i: number): string => woken.find((x) => x.projectId === ps[i])!.taskId;
      assert.equal(new Set(woken.map((x) => x.projectId)).size, 6, JSON.stringify(woken));
      const taken: { leaseId: string; fence: number }[] = [];
      for (let i = 0; i < ps.length; i++) {
        const c = (await r.credential(task(i), agents[i]!)).as;
        taken.push(await r.leaseOps.acquire(c, { commandId: "take", taskId: fronts[i]!, branch: "main", ttlMs: 30 * MIN }));
        if (i === 1) await r.leaseOps.release(c, { commandId: "give", leaseId: taken[i]!.leaseId, fence: taken[i]!.fence });
      }
      r.w.clock.advance(MIN);
      // Apple: renewed on ann's own credential before the task is done: ann's own hold from then on.
      await r.leaseOps.renew(own[0]!, { commandId: "own-renew", leaseId: taken[0]!.leaseId, fence: taken[0]!.fence });
      await r.finish(task(0));
      // Birch: released by bob on the landing credential, the task done, then the branch taken again on bob's own credential.
      await r.finish(task(1));
      await r.leaseOps.acquire(own[1]!, { commandId: "own-take", taskId: fronts[1]!, branch: "main", ttlMs: 30 * MIN });
      // Cedar: the task cancelled by the owner, not done.
      await r.end(task(2));
      // Dogwood: done, but an attempt is still on the task.
      await r.finish(task(3));
      const asg = (await r.w.storage.getAggregate({ kind: "assignment", id: assignmentIdOf(task(3)) }))!;
      await r.raw("assignment", assignmentIdOf(task(3)), { ...(asg.body as object), activeAttemptId: "att-still-running" });
      // Elm: done, but the landing record names another agent (it reads, but it is not eve's take).
      await r.finish(task(4));
      const link4 = (await r.w.storage.getAggregate({ kind: LANDING_TASK_KIND, id: task(4) }))!.body as Record<string, unknown>;
      await r.raw(LANDING_TASK_KIND, task(4), { ...link4, agentId: "zed" });
      // Fir: done, but its landing record is damaged: counted unreadable.
      await r.finish(task(5));
      const link5 = (await r.w.storage.getAggregate({ kind: LANDING_TASK_KIND, id: task(5) }))!.body as Record<string, unknown>;
      await r.raw(LANDING_TASK_KIND, task(5), { ...link5, wakeId: "iwk-0" });
      r.w.clock.advance(MIN);
      const round = await r.wake.round();
      assert.equal(round.freed, undefined, JSON.stringify(round));
      assert.ok(round.unreadable >= 1, JSON.stringify(round));
      const states: unknown[] = [];
      for (const p of ps) { const l = (await r.leaseOf(p))!; states.push([l.state, l.holder]); }
      assert.deepEqual(states, agents.map((x) => ["held", x]), JSON.stringify(states));
      // With the attempt gone, Dogwood's hold is given back at the next round; the others stay as they are.
      await r.raw("assignment", assignmentIdOf(task(3)), asg.body);
      const later = await r.wake.round();
      assert.deepEqual(later.freed?.map((x) => x.projectId), [ps[3]], JSON.stringify(later));
    } finally { await r.close(); }
  });

  test(`${backend.name}: a hold renewed after the round read it is never given back; when the give-back wins the race, the integrator's worst case is a fenced refusal and it takes the branch again (card P10b)`, async () => {
    const r = await rig();
    try {
      const [a, b] = [await r.project("Apple"), await r.project("Birch")];
      const [frontA, frontB] = [await r.queued(a), await r.queued(b)];
      const ivy = await r.person("ivy", integrates([a]));
      await r.person("max", integrates([b]));
      const one = await r.wake.round();
      const [tA, tB] = [one.woken.find((x) => x.projectId === a)!.taskId, one.woken.find((x) => x.projectId === b)!.taskId];
      const cA = (await r.credential(tA, "ivy")).as, cB = (await r.credential(tB, "max")).as;
      const lA = await r.leaseOps.acquire(cA, { commandId: "take", taskId: frontA, branch: "main", ttlMs: 30 * MIN });
      const lB = await r.leaseOps.acquire(cB, { commandId: "take", taskId: frontB, branch: "main", ttlMs: 30 * MIN });
      // Apple, the landed end: the work lands, and ivy renews its hold on its landing credential right after the round read the leases. Birch, the done give-back: max finishes its task, and its hold is renewed
      // (still marked, through the lease service itself) right after the round read the leases.
      await r.queue.remove({ commandId: "landed-a", actor: "controller", projectId: a, branch: "main", taskId: frontA, reason: "landed" });
      await r.finish(tB);
      r.w.clock.advance(MIN);
      let renewed = false;
      const racing = r.wakeWith({
        liveLeases: async () => {
          const seen = await r.leases.liveLeases();
          if (!renewed) {
            renewed = true;
            r.w.clock.advance(MIN);
            await r.leaseOps.renew(cA, { commandId: "renew-a", leaseId: lA.leaseId, fence: lA.fence });
            await r.leases.renew({ commandId: "renew-b", leaseId: lB.leaseId, fence: lB.fence, holder: "max", landingTask: tB });
          }
          return seen;
        },
      });
      const two = await racing.round();
      assert.deepEqual([two.ended?.map((x) => [x.taskId, x.why, x.lease]), two.freed], [[[tA, "landed", undefined]], undefined], JSON.stringify(two));
      const [nowA, nowB] = [(await r.leaseOf(a))!, (await r.leaseOf(b))!];
      assert.deepEqual([nowA.live, nowA.fence, nowB.live, nowB.fence], [true, lA.fence, true, lB.fence], "both renewed holds are left as they are");
      // The next round reads the renewed hold: Birch's is still that done task's idle hold and is given back; Apple's landing task is ended already and its hold stays to run out (or to be released by ivy).
      const three = await r.wake.round();
      assert.deepEqual(three.freed?.map((x) => x.taskId), [tB], JSON.stringify(three));
      // The worst case for an integrator whose hold is given back as it renews: its renew is refused `fenced`, nothing else, and the free branch is taken again on its own credential with the next fence.
      await refuses("fenced", () => r.leases.renew({ commandId: "late", leaseId: lB.leaseId, fence: lB.fence, holder: "max" }));
      const maxOwn = await r.w.principals.authenticate((await r.w.principals.issueCredential(r.w.owner, "agent:max")).token);
      const back = await r.leaseOps.acquire(maxOwn, { commandId: "again", taskId: frontB, branch: "main", ttlMs: 30 * MIN });
      assert.deepEqual([back.live, back.fence, back.landingTask], [true, lB.fence + 1, undefined]);
      // The landed end's give-back now passes over a hold ivy took on its own credential: ivy releases Apple, a new wake comes, ivy takes the branch on its own credential and the work lands.
      await r.leaseOps.release(ivy, { commandId: "ivy-give", leaseId: lA.leaseId, fence: lA.fence });
      const frontA2 = await r.queued(a);
      const four = await r.wake.round();
      const tA2 = four.woken.find((x) => x.projectId === a)!.taskId;
      const ownA = await r.leaseOps.acquire(ivy, { commandId: "ivy-own", taskId: frontA2, branch: "main", ttlMs: 30 * MIN });
      await r.queue.remove({ commandId: "landed-a2", actor: "controller", projectId: a, branch: "main", taskId: frontA2, reason: "landed" });
      const five = await r.wake.round();
      assert.deepEqual(five.ended?.map((x) => [x.taskId, x.why, x.lease]), [[tA2, "landed", undefined]], JSON.stringify(five));
      assert.equal((await r.leases.get(ownA.leaseId))?.live, true, "ivy's own hold is ivy's business");
      // A release naming an expiry that is not the hold's is refused `fenced` (the lease service's own rule), and one naming it releases.
      await refuses("fenced", () => r.leases.release({ commandId: "rel-x", leaseId: ownA.leaseId, fence: ownA.fence, expiresAt: "2000-01-01T00:00:00.000Z" }), /renewed after it was read/);
      assert.equal((await r.leases.release({ commandId: "rel-y", leaseId: ownA.leaseId, fence: ownA.fence, expiresAt: ownA.expiresAt })).state, "released");
    } finally { await r.close(); }
  });

  test(`${backend.name}: a landing task's charge names the same budget task on every try of its command, so a retry after a release or transfer settles once (card P10b)`, async () => {
    const r = await rig();
    try {
      const a = await r.project("Apple");
      const frontA = await r.queued(a);
      await r.person("ivy", integrates([a]));
      await r.person("zed", integrates([a]));
      const tA = (await r.wake.round()).woken[0]!.taskId;
      const by = r.w.dispatcherPrincipal;
      const charge = (commandId: string, taskId: string) => r.w.budgets.charge(by, { commandId, activity: "stop-cleanup", taskId, computeMs: 1000 });
      // The first try: the landing task is ivy's, so the queued work's task is charged.
      const first = await r.wake.chargeTaskFor("stopcl-1", tA);
      assert.equal(first, frontA);
      await charge("stopcl-1", first);
      // Then the landing task is released: chargeTaskOf now answers the landing task itself, but the same command still names the queued work's task, and its retry is the same charge (booked once).
      const asg = (await r.w.assignments.getAssignment(tA))!;
      await r.w.assignments.releaseTask({ commandId: "rel-1", actor: r.w.owner.id, taskId: tA, expectedRevision: asg.revision, reason: "the owner's choice" });
      assert.equal(await r.wake.chargeTaskOf(tA), tA);
      assert.equal(await r.wake.chargeTaskFor("stopcl-1", tA), frontA);
      assert.equal((await charge("stopcl-1", await r.wake.chargeTaskFor("stopcl-1", tA))).replayed, true);
      // Unpinned, the retry would name another task under the same command ID, which the budget refuses (the charge would never settle).
      await assert.rejects(() => charge("stopcl-1", tA), (e: unknown) => e instanceof DomainError);
      // A new command after the release is charged where chargeTaskOf says now, and fixed there too, even if the task is given back to the integrator.
      assert.equal(await r.wake.chargeTaskFor("stopcl-2", tA), tA);
      await r.w.assignments.assignTask({ commandId: "again", actor: r.w.owner.id, taskId: tA, expectedRevision: (await r.w.assignments.getAssignment(tA))!.revision, owner: { kind: "agent", id: "ivy" }, reason: "back to ivy" });
      assert.equal(await r.wake.chargeTaskOf(tA), frontA);
      assert.equal(await r.wake.chargeTaskFor("stopcl-2", tA), tA);
      assert.equal(await r.wake.chargeTaskFor("stopcl-3", tA), frontA);
      const usage = await r.w.budgets.usage(r.w.owner, { projectId: a });
      assert.deepEqual([usage.byTask[frontA]?.computeMs, usage.byTask[tA]?.computeMs], [1000, undefined], JSON.stringify(usage.byTask));
      // Any other task is charged to itself and no pin is written for it.
      const pinsBefore = (await r.w.storage.listAggregates(CHARGE_PIN_KIND, { limit: 200 })).length;
      assert.equal(await r.wake.chargeTaskFor("stopcl-4", frontA), frontA);
      assert.equal((await r.w.storage.listAggregates(CHARGE_PIN_KIND, { limit: 200 })).length, pinsBefore);
      assert.equal(pinsBefore, 3);
      // A damaged pin is never read as some task: the charge fails (and is tried again as any failed charge is).
      const pins = await r.w.storage.listAggregates(CHARGE_PIN_KIND, { limit: 200 });
      const p0 = pins[0]!;
      await r.raw(CHARGE_PIN_KIND, p0.id, { ...(p0.body as object), budgetTaskId: "../x" });
      const pinned = p0.body as { commandId: string };
      await refuses("integrity", () => r.wake.chargeTaskFor(pinned.commandId, tA));
      // A command ID that is not text, empty or over long is refused.
      for (const bad of ["", "x".repeat(201), 7 as unknown as string]) await refuses("invalid_command", () => r.wake.chargeTaskFor(bad, tA));
      // Two first tries at once write one pin and agree.
      const [x, y] = await Promise.all([r.wake.chargeTaskFor("stopcl-5", tA), r.wake.chargeTaskFor("stopcl-5", tA)]);
      assert.deepEqual([x, y], [frontA, frontA]);
      // A transfer between tries: the same.
      const z = await r.wake.chargeTaskFor("stopcl-6", tA);
      const asg2 = (await r.w.assignments.getAssignment(tA))!;
      await r.w.assignments.transferTask({ commandId: "tr-1", actor: r.w.owner.id, taskId: tA, expectedRevision: asg2.revision, to: { kind: "agent", id: "zed" }, reason: "the owner's choice" });
      assert.deepEqual([z, await r.wake.chargeTaskOf(tA), await r.wake.chargeTaskFor("stopcl-6", tA)], [frontA, tA, frontA]);
    } finally { await r.close(); }
  });
}
