import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { CommandRunner } from "../domain/runner.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld } from "../dispatch/testing/world.js";
import type { Principal } from "../security/principals.js";
import { AssignmentService } from "../domain/assignments.js";
import { BlockerService } from "../domain/blockers.js";
import { WaitService } from "../domain/waits.js";
import { ContractService } from "../planning/contracts.js";
import { StatusService } from "../status/index.js";
import { WorkspaceOpService, type WorkspaceCall, type WorkspaceOutcome } from "../workspace-ops/index.js";
import { IntegratorLeaseOps, IntegratorLeaseService, LANDING_QUEUE_LIMITS, LandingQueueOps, LandingQueueService, frontOf, type QueueApproval } from "./index.js";

after(stopServer);
// Card P10, tenth slice: the bounds that end a stuck first place are visible to the owner (status view `landing_queue` and `landing.queue.list`): since when a reserved place has had no approved submission, when the
// controller ends it by itself (only when a landing is refused behind it), and a first place held longer than the director's bound. The rig is the eighth slice's.

const MIN = 60_000;
const oid = (n: number): string => n.toString(16).padStart(40, "0");
const sbm = (n: number): string => { const a = "abcdefghijklmnopqrstuvwxyz234567"; let s = ""; for (let i = 0, v = n; i < 20; i++, v = Math.floor(v / 32)) s += a[v % 32]; return `sbm-${s}`; };
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match !== undefined) assert.match(error.message, match); return true; });
};
type Told = { commandId: string; taskId: string; branch: string; why: "front" | "round" | "returns" | "unassigned" | "released"; text: string };

for (const backend of backends) {
  const rig = async (o: { cap?: number | (() => Promise<number>); holdMs?: number; releaseMs?: number; gate?: (call: WorkspaceCall) => Promise<void> } = {}) => {
    const store = await backend.open();
    const w = await buildWorld(store.storage);
    const options = { clock: w.clock.now, pause: async () => undefined };
    const approvals = new Map<string, QueueApproval>();
    const told: Told[] = [];
    const directors = new Set<string>();
    const cap = o.cap;
    /** While positive, an escalation fails (the owner could not be told) after it was asked; each failure counts down. */
    const failing = { escalations: 0 };
    const holders = new Map<string, { kind: string; id: string }>();
    const retired = new Set<string>();
    const tells: { taskId: string; to: string; text: string; purpose?: string }[] = [];
    const queue = LandingQueueService.withEpoch(w.storage, w.epoch, options);
    const ops = new LandingQueueOps(queue, {
      approvalOf: async (id) => approvals.get(id),
      landingBranch: async () => "main",
      projectOfTask: async (t) => ((await w.storage.getAggregate({ kind: "task", id: t }))?.body as { projectId?: string } | undefined)?.projectId,
      refreshCap: typeof cap === "function" ? cap : async () => cap ?? 3,
      isDirector: async (by) => directors.has(by.id),
      escalate: async (n) => { if (failing.escalations > 0) { failing.escalations--; throw new Error("the owner could not be told"); } told.push({ commandId: n.commandId, taskId: n.taskId, branch: n.branch, why: n.why, text: n.text }); },
      ...(o.holdMs === undefined ? {} : { holdMs: o.holdMs }),
      ...(o.releaseMs === undefined ? {} : { releaseMs: o.releaseMs }),
      holderOf: async (t) => holders.get(t),
      activeAgent: async (id) => !retired.has(id),
      tell: async (n) => { tells.push({ taskId: n.taskId, to: n.to, text: n.text, ...(n.purpose === undefined ? {} : { purpose: n.purpose }) }); },
    });
    const leaseOps = new IntegratorLeaseOps(IntegratorLeaseService.withEpoch(w.storage, w.epoch, options), { landingBranch: async () => "main" });
    const person = async (name: string, grants = [{ action: "integration.lease", project: w.project }, { action: "workspace.manage", project: w.project }]): Promise<Principal> => {
      await w.principals.enroll(w.owner, { commandId: `en-${name}`, kind: "agent", name, grants });
      return w.principals.authenticate((await w.principals.issueCredential(w.owner, `agent:${name}`)).token);
    };
    const task = async (title: string): Promise<string> => (await w.projects.createTask({ commandId: `task-${title}`, actor: w.owner.id, projectId: w.project, title })).id;
    let nextSbm = 1;
    /** A code submission of task `t` on `base`, approved or not, as `SubmissionService.approvalOf` answers it. */
    const submit = (t: string, base: string, approved = true, author = "agent:ann"): string => { const id = sbm(nextSbm++); approvals.set(id, { taskId: t, projectId: w.project, base, tree: oid(100_000 + nextSbm), submittedBy: author, approved, ...(approved ? {} : { reason: "its newest review says changes" }) }); return id; };
    const takeBack = (id: string): void => { approvals.set(id, { ...approvals.get(id)!, approved: false, reason: "its newest review says changes" }); };
    // The landing branch's head as the host sees it: a landing lands only on its approved base.
    let head = oid(1), commits = 1;
    const calls: WorkspaceCall[] = [];
    const host = async (call: WorkspaceCall): Promise<WorkspaceOutcome> => {
      calls.push(call);
      await o.gate?.(call);
      const s = call.submission!;
      if (s.base !== head) return { ok: false, reason: `submission ${s.id} was approved on ${s.base.slice(0, 12)} but the landing branch is at ${head.slice(0, 12)}` };
      head = oid(++commits);
      return { ok: true, summary: "landed", detail: { landed: true, changed: true, written: 1, submission: s.id, base: s.base, tree: s.tree } };
    };
    const svc = WorkspaceOpService.withEpoch(w.storage, w.epoch, {
      quiesce: { around: async (_scope, _op, run) => run({ attempts: [] } as never) },
      portOf: async () => ({ run: host }),
      landingLease: (by, call) => leaseOps.checkLanding(by, { ...call, branch: "main" }),
      landingQueue: { check: (by, call) => ops.checkLanding(by, call), landedChanges: (p, b, s) => ops.landedChanges(p, b, s) },
    }, options);
    let landings = 0;
    let last: { leaseId: string; fence: number } | undefined;
    const lander = async (by: Principal, holderTask: string) => {
      // A lease is asked for again at each landing (the clock moves by many hours, and a lease lasts at most a day).
      return async (taskId: string) => {
        if (last !== undefined) await leaseOps.release(by, { commandId: `unlease-${++landings}`, leaseId: last.leaseId, fence: last.fence }).catch(() => undefined);
        const lease = last = await leaseOps.acquire(by, { commandId: `lease-${++landings}`, taskId: holderTask, branch: "main", ttlMs: 20 * 60 * MIN });
        return svc.request(by, { commandId: `land-${landings}`, operation: "landing", taskId, reason: "land it", leaseId: lease.leaseId, fence: lease.fence } as never);
      };
    };
    const list = () => ops.list(w.owner, { projectId: w.project });
    return {
      store, w, ops, queue, holders, retired, tells, person, task, submit, takeBack, told, failing, directors, lander, list, calls,
      head: () => head,
      queued: async () => (await list()).items.map((e) => [e.position, e.taskId]),
      close: () => store.close(),
    };
  };

  const HOUR = 60 * MIN;
  /** Two tasks: t1 reserved at the cap and then withdrawn (a reserved place with no approved entry, first), t2 queued approved behind it. */
  const reservedAway = async (r: Awaited<ReturnType<typeof rig>>) => {
    const [t1, t2] = [await r.task("one"), await r.task("two")];
    const s1 = r.submit(t1, r.head());
    await r.ops.queueApproved(s1, "rv1");
    await r.ops.queueApproved(r.submit(t2, r.head()), "rv2");
    assert.equal(await r.ops.afterRound({ taskId: t1, projectId: r.w.project, round: 2 }), "reserved");
    r.takeBack(s1);
    assert.equal(await r.ops.withdrawUnapproved(s1, "rv3"), true);
    return { t1, t2, s1 };
  };

  const view = async (r: Awaited<ReturnType<typeof rig>>, by: Principal): Promise<string[] | undefined> => {
    const o = { clock: r.w.clock.now, pause: async () => undefined };
    const assignments = AssignmentService.withEpoch(r.w.storage, r.w.epoch, r.w.projects, o);
    const status = StatusService.withEpoch(r.w.storage, r.w.epoch, { assignments, waits: WaitService.withEpoch(r.w.storage, r.w.epoch, assignments, o), blockers: BlockerService.withEpoch(r.w.storage, r.w.epoch, o), contracts: ContractService.withEpoch(r.w.storage, r.w.epoch, o), landingQueue: { list: (b, q) => r.ops.list(b, q) } }, { clock: r.w.clock.now, pause: async () => undefined });
    const out = await status.landingQueueLines(by, r.w.project);
    return out?.lines.map((l) => l.text);
  };
  const stuck = (lines: string[] | undefined): string[] => (lines ?? []).filter((l) => /no approved submission since|not counted yet|longer than the/.test(l));

  test(`${backend.name}: the owner is shown since when a reserved place is idle and when it ends, then that it is past the bound, and it is gone once released (card P10, tenth slice)`, async () => {
    const r = await rig({ cap: 2, releaseMs: 12 * HOUR });
    try {
      const ivy = await r.person("ivy");
      const { t1, t2 } = await reservedAway(r);
      const idle = (await r.list()).front!.idleSince!;
      const list = await r.list();
      assert.deepEqual([list.front!.releaseMs, list.front!.holdMs], [12 * HOUR, 4 * HOUR]);
      const early = stuck(await view(r, r.w.owner));
      assert.equal(early.length, 1, early.join("|"));
      assert.match(early[0]!, new RegExp(`Task ${t1}'s reserved place has had no approved submission since ${idle.replace(/[.]/g, "\\.")}; once that has lasted 12 h \\(at ${new Date(Date.parse(idle) + 12 * HOUR).toISOString().replace(/[.]/g, "\\.")}\\)`));
      assert.match(early[0]!, /checked when a landing is refused behind it \(not on a clock\)/);
      r.w.clock.advance(12 * HOUR);
      const late = stuck(await view(r, r.w.owner));
      assert.equal(late.length, 1);
      assert.match(late[0]!, /longer than the 12 h bound: the next landing refused behind it ends the reservation by itself/);
      // Nothing ended it on a clock: the view only reads.
      assert.deepEqual((await r.list()).reservations.map((x) => x.taskId), [t1]);
      const out = await (await r.lander(ivy, t2))(t2);
      assert.equal(out.state, "done", out.summary);
      assert.deepEqual(stuck(await view(r, r.w.owner)), [], "released: no stuck line");
    } finally { await r.close(); }
  });

  test(`${backend.name}: the bound shown is the configured one, in minutes when it is not whole hours (card P10, tenth slice)`, async () => {
    const r = await rig({ cap: 2, releaseMs: 90 * MIN });
    try {
      await reservedAway(r);
      const lines = stuck(await view(r, r.w.owner));
      assert.equal(lines.length, 1);
      assert.match(lines[0]!, /once that has lasted 90 min /);
    } finally { await r.close(); }
  });

  test(`${backend.name}: a record without the idle time says it is not counted yet and makes no claim about when it ends (card P10, tenth slice)`, async () => {
    const r = await rig({ cap: 2, releaseMs: 12 * HOUR });
    try {
      const { t1 } = await reservedAway(r);
      const queueId = LandingQueueService.queueIdOf(r.w.project, "main");
      const runner = new CommandRunner(r.w.storage, r.w.epoch, { clock: r.w.clock.now, pause: async () => undefined });
      await runner.command("test.legacy-queue", { commandId: "legacy-queue", actor: "service:test" }, async () => ({
        payload: {},
        build: async () => {
          const current = (await runner.get("landing-queue", queueId))!;
          const body = current.body as unknown as { front: { idleSince?: string } };
          const { idleSince: _dropped, ...front } = body.front;
          const ref = { kind: "landing-queue", id: queueId };
          return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: JSON.parse(JSON.stringify({ ...body, front })) }], detail: {} };
        },
      }));
      const lines = stuck(await view(r, r.w.owner));
      assert.equal(lines.length, 1);
      assert.match(lines[0]!, new RegExp(`Task ${t1}'s reserved place is first and has no approved submission; the time it has been idle is not counted yet`));
      assert.doesNotMatch(lines[0]!, /\bat 20\d\d-/);
    } finally { await r.close(); }
  });

  test(`${backend.name}: an approved first place held past the director's bound is said, until the director is told; a place under the bound or a reserved waiting one is not said that way (card P10, tenth slice)`, async () => {
    const r = await rig({ cap: 2, holdMs: 4 * HOUR, releaseMs: 100 * HOUR });
    try {
      const ivy = await r.person("ivy");
      const [t1, t2] = [await r.task("one"), await r.task("two")];
      await r.ops.queueApproved(r.submit(t1, r.head()), "q1");
      await r.ops.queueApproved(r.submit(t2, r.head()), "q2");
      assert.deepEqual(stuck(await view(r, r.w.owner)), [], "fresh");
      r.w.clock.advance(4 * HOUR - MIN);
      assert.deepEqual(stuck(await view(r, r.w.owner)), [], "under the bound");
      r.w.clock.advance(MIN);
      const said = stuck(await view(r, r.w.owner));
      assert.equal(said.length, 1);
      assert.match(said[0]!, new RegExp(`Task ${t1} has been first since .*longer than the 4 h bound, and has not landed; the director is told when a landing is refused behind it \\(nothing tells on a clock\\)`));
      // A landing refused behind it tells the director; the plain "told" line replaces the warning.
      await refuses("invalid_transition", async () => (await r.lander(ivy, t2))(t2), /lands first/);
      assert.equal(r.told.filter((t) => t.why === "front").length, 1);
      assert.deepEqual(stuck(await view(r, r.w.owner)), []);
      assert.ok((await view(r, r.w.owner))!.some((l) => /the director was told that it holds the branch/.test(l)));
    } finally { await r.close(); }
  });

  test(`${backend.name}: a reader without the owner's or an integrator's right is shown nothing of the bounds (card P10, tenth slice)`, async () => {
    const r = await rig({ cap: 2 });
    try {
      await reservedAway(r);
      const nobody = await r.person("nobody", []);
      assert.equal(await view(r, nobody), undefined);
      const integrator = await r.person("ivy");
      assert.equal(stuck(await view(r, integrator)).length, 1);
    } finally { await r.close(); }
  });
}
