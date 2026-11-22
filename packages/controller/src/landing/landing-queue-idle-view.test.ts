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
  const stuck = (lines: string[] | undefined): string[] => (lines ?? []).filter((l) => /no approved submission since|not counted yet|cannot be counted from|longer than the/.test(l));

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
      assert.match(early[0]!, /checked only when a landing of a submission queued behind it is asked for \(the place is ended first and that landing is then judged on the queue without it\), not on a clock; approved work coming back first stops the count/);
      r.w.clock.advance(12 * HOUR - MIN);
      assert.match(stuck(await view(r, r.w.owner)).join("|"), /; once that has lasted 12 h \(at /, "a minute under the bound");
      r.w.clock.advance(MIN);
      const late = stuck(await view(r, r.w.owner));
      assert.equal(late.length, 1);
      assert.match(late[0]!, /longer than the 12 h bound: the next landing asked for a submission queued behind it ends the reservation first and is then judged on the queue without it \(it goes ahead when its submission is then first; nothing ends it on a clock; taking the task out with landing\.queue\.remove lets others land at once\)/);
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
      assert.match(lines[0]!, /the count starts at the next change to this queue/);
      assert.doesNotMatch(lines[0]!, /\bat 20\d\d-/);
      // Any write of the queue starts the count (here a third task's approved work is queued): the end time is then shown, from that write.
      r.w.clock.advance(HOUR);
      const started = r.w.clock.now();
      await r.ops.queueApproved(r.submit(await r.task("three"), r.head()), "rv4");
      assert.equal((await r.list()).front!.idleSince, started);
      const after = stuck(await view(r, r.w.owner));
      assert.equal(after.length, 1, after.join("|"));
      assert.match(after[0]!, new RegExp(`since ${started.replace(/[.]/g, "\\.")}; once that has lasted 12 h \\(at ${new Date(Date.parse(started) + 12 * HOUR).toISOString().replace(/[.]/g, "\\.")}\\)`));
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
      assert.match(said[0]!, new RegExp(`Task ${t1} has been first since .*longer than the 4 h bound, and has not landed; when a landing is refused behind it the director is told and the owner gets a notice \\(one that needs the owner when no director can be told\\); nothing tells on a clock\\. Land it, or take it out`));
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
  /** Writes the stored queue record's `front` (a record from another version, or a damaged one). */
  const setFront = async (r: Awaited<ReturnType<typeof rig>>, change: (front: Record<string, unknown>) => Record<string, unknown>, id: string): Promise<void> => {
    const queueId = LandingQueueService.queueIdOf(r.w.project, "main");
    const runner = new CommandRunner(r.w.storage, r.w.epoch, { clock: r.w.clock.now, pause: async () => undefined });
    await runner.command("test.front", { commandId: id, actor: "service:test" }, async () => ({
      payload: {},
      build: async () => {
        const current = (await runner.get("landing-queue", queueId))!;
        const body = current.body as unknown as { front: Record<string, unknown> };
        const ref = { kind: "landing-queue", id: queueId };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: JSON.parse(JSON.stringify({ ...body, front: change(body.front) })) }], detail: {} };
      },
    }));
  };

  test(`${backend.name}: approved work coming back stops the idle count, and it starts again from when that work went (card P10, tenth slice)`, async () => {
    const r = await rig({ cap: 2, releaseMs: 12 * HOUR });
    try {
      const { t1 } = await reservedAway(r);
      r.w.clock.advance(11 * HOUR);
      const back = r.submit(t1, r.head());
      await r.ops.queueApproved(back, "rv-back");
      const first = stuck(await view(r, r.w.owner));
      assert.deepEqual(first.filter((l) => /reserved place/.test(l)), [], "approved work is first: no idle line");
      assert.match(first.join("|"), /has been first since .*longer than the 4 h bound/, "it has been first 11 h: the director's bound is said instead");
      r.w.clock.advance(2 * HOUR);
      r.takeBack(back);
      assert.equal(await r.ops.withdrawUnapproved(back, "rv-away"), true);
      const again = r.w.clock.now();
      const lines = stuck(await view(r, r.w.owner));
      assert.equal(lines.length, 1, lines.join("|"));
      // 13 hours after the first withdrawal, but the count restarted: not past the bound, the end is 12 h from the second withdrawal.
      assert.match(lines[0]!, new RegExp(`since ${again.replace(/[.]/g, "\\.")}; once that has lasted 12 h \\(at ${new Date(Date.parse(again) + 12 * HOUR).toISOString().replace(/[.]/g, "\\.")}\\)`));
    } finally { await r.close(); }
  });

  test(`${backend.name}: a malformed or out-of-range stored time is said as not counted, never as NaN or an invalid date (card P10, tenth slice)`, async () => {
    const r = await rig({ cap: 2, holdMs: 4 * HOUR, releaseMs: 12 * HOUR });
    try {
      await reservedAway(r);
      for (const [i, bad] of ["not a time", "+275760-09-13T00:00:00.000Z", "2026-13-45T99:99:99Z"].entries()) {
        await setFront(r, (front) => ({ ...front, idleSince: bad }), `bad-idle-${i}`);
        const all = (await view(r, r.w.owner))!;
        const lines = stuck(all);
        assert.equal(lines.length, 1, `${bad}: ${lines.join("|")}`);
        assert.match(lines[0]!, /its recorded idle time cannot be counted from, so the controller does not end the reservation by itself\. Taking the task out with landing\.queue\.remove lets others land\./, bad);
        assert.doesNotMatch(lines[0]!, /not counted yet|count starts/, bad);
        for (const l of all) assert.doesNotMatch(l, /NaN|Invalid Date|undefined|275760/, bad);
      }
    } finally { await r.close(); }
    const h = await rig({ cap: 2, holdMs: 4 * HOUR });
    try {
      const [t1, t2] = [await h.task("one"), await h.task("two")];
      await h.ops.queueApproved(h.submit(t1, h.head()), "q1");
      await h.ops.queueApproved(h.submit(t2, h.head()), "q2");
      h.w.clock.advance(5 * HOUR);
      assert.equal(stuck(await view(h, h.w.owner)).length, 1, "past the hold bound");
      for (const [i, bad] of ["not a time", "-271821-04-19T00:00:00.000Z"].entries()) {
        await setFront(h, (front) => ({ ...front, since: bad }), `bad-since-${i}`);
        const all = (await view(h, h.w.owner))!;
        assert.deepEqual(stuck(all), [], bad);
        for (const l of all) assert.doesNotMatch(l, /NaN|Invalid Date/, bad);
      }
    } finally { await h.close(); }
  });
  test(`${backend.name}: past the bound, a landing of a submission that is not next ends the place but is still refused behind the next one (card P10, tenth slice review)`, async () => {
    const r = await rig({ cap: 2, releaseMs: 12 * HOUR });
    try {
      const ivy = await r.person("ivy");
      const { t1, t2 } = await reservedAway(r);
      const t3 = await r.task("three");
      await r.ops.queueApproved(r.submit(t3, r.head()), "q3");
      r.w.clock.advance(12 * HOUR);
      assert.match(stuck(await view(r, r.w.owner)).join("|"), /is then judged on the queue without it \(it goes ahead when its submission is then first;/);
      await refuses("invalid_transition", async () => (await r.lander(ivy, t3))(t3), new RegExp(`task ${t2}.*lands first`));
      assert.deepEqual((await r.list()).reservations.map((x) => x.taskId), [], `the place of ${t1} was ended by that landing`);
      assert.deepEqual(await r.queued(), [[1, t2], [2, t3]]);
      assert.equal(r.calls.length, 0, "nothing reached the host");
      assert.deepEqual(stuck(await view(r, r.w.owner)), []);
    } finally { await r.close(); }
  });

  test(`${backend.name}: an unreadable stored idle time stays through later writes and nothing ends the place by itself, as the view says (card P10, tenth slice review)`, async () => {
    const r = await rig({ cap: 2, releaseMs: 12 * HOUR });
    try {
      const ivy = await r.person("ivy");
      const { t1, t2 } = await reservedAway(r);
      await setFront(r, (front) => ({ ...front, idleSince: "not a time" }), "bad-idle-kept");
      // A later write of the queue keeps it (`settled` keeps the same first place's idle time), so the view does not promise a count.
      await r.ops.queueApproved(r.submit(await r.task("three"), r.head()), "q3");
      assert.equal((await r.list()).front!.idleSince, "not a time");
      r.w.clock.advance(24 * HOUR);
      await refuses("invalid_transition", async () => (await r.lander(ivy, t2))(t2), /holds the first place/);
      assert.deepEqual((await r.list()).reservations.map((x) => x.taskId), [t1], "not ended");
      const lines = stuck(await view(r, r.w.owner));
      assert.equal(lines.length, 1, lines.join("|"));
      assert.match(lines[0]!, /cannot be counted from, so the controller does not end the reservation by itself/);
    } finally { await r.close(); }
  });

  test(`${backend.name}: a task credential of the owner or of an integrator is shown nothing of the queue (card P10, tenth slice review)`, async () => {
    const r = await rig({ cap: 2 });
    try {
      const { t1 } = await reservedAway(r);
      const integrator = await r.person("ivy");
      const scope = { taskId: t1, projectId: r.w.project };
      assert.equal(await view(r, { ...r.w.owner, taskScope: scope } as Principal), undefined);
      assert.equal(await view(r, { ...integrator, taskScope: scope } as Principal), undefined);
      await refuses("not_found", () => r.ops.list({ ...integrator, taskScope: scope } as Principal, { projectId: r.w.project }));
    } finally { await r.close(); }
  });

  test(`${backend.name}: a bound under a minute is shown in seconds, never as 0 min (card P10, tenth slice review)`, async () => {
    const r = await rig({ cap: 2, releaseMs: 30_000 });
    try {
      await reservedAway(r);
      const lines = stuck(await view(r, r.w.owner));
      assert.equal(lines.length, 1);
      assert.match(lines[0]!, /once that has lasted 30 s /);
    } finally { await r.close(); }
  });
}
