import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld } from "../dispatch/testing/world.js";
import type { Principal } from "../security/principals.js";
import { WorkspaceOpService, type RestackOutcome, type WorkspaceCall, type WorkspaceOutcome } from "../workspace-ops/index.js";
import { IntegratorLeaseOps, IntegratorLeaseService, LandingQueueOps, LandingQueueService, type QueueApproval } from "./index.js";

after(stopServer);

// Card P10, the fourth slice: a stale first place is re-applied mechanically by the integrator's host when its files are disjoint from what landed since its base (and lands as exactly the approved change);
// overlapping work goes back to the agent that holds the task, out of the queue, and counts as a repair cycle against the Q04 limit (`review.repairCycles`); at the limit, or when nobody active holds the task,
// the director and the owner are told.
const oid = (n: number): string => n.toString(16).padStart(40, "0");
const sbm = (n: number): string => { const a = "abcdefghijklmnopqrstuvwxyz234567"; let s = ""; for (let i = 0, v = n; i < 20; i++, v = Math.floor(v / 32)) s += a[v % 32]; return `sbm-${s}`; };
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match !== undefined) assert.match(error.message, match); return true; });
};

for (const backend of backends) {
  const rig = async (o: { limit?: number; assignee?: string | undefined; active?: (agentId: string) => boolean; dropProof?: boolean; restack?: false } = {}) => {
    const store = await backend.open();
    const w = await buildWorld(store.storage);
    const options = { clock: w.clock.now, pause: async () => undefined };
    const approvals = new Map<string, QueueApproval & { files: string[] }>();
    const escalated: { commandId: string; taskId: string; why: string; text: string }[] = [];
    const told: { commandId: string; taskId: string; to: string; text: string }[] = [];
    const ops = new LandingQueueOps(LandingQueueService.withEpoch(w.storage, w.epoch, options), {
      approvalOf: async (id) => approvals.get(id),
      landingBranch: async () => "main",
      projectOfTask: async (t) => ((await w.storage.getAggregate({ kind: "task", id: t }))?.body as { projectId?: string } | undefined)?.projectId,
      repairCycles: async () => o.limit ?? 3,
      escalate: async (n) => { escalated.push({ commandId: n.commandId, taskId: n.taskId, why: n.why, text: n.text }); },
      tell: async (n) => { told.push({ ...n }); },
      ...(o.active === undefined ? {} : { activeAgent: async (id: string) => o.active!(id) }),
    });
    const leaseOps = new IntegratorLeaseOps(IntegratorLeaseService.withEpoch(w.storage, w.epoch, options), { landingBranch: async () => "main" });
    const person = async (name: string, grants = [{ action: "integration.lease", project: w.project }, { action: "workspace.manage", project: w.project }]): Promise<Principal> => {
      await w.principals.enroll(w.owner, { commandId: `en-${name}`, kind: "agent", name, grants });
      return w.principals.authenticate((await w.principals.issueCredential(w.owner, `agent:${name}`)).token);
    };
    const task = async (title: string): Promise<string> => (await w.projects.createTask({ commandId: `task-${title}`, actor: w.owner.id, projectId: w.project, title })).id;
    let nextSbm = 1;
    /** An approved code submission of task `t` on `base` that changes `files`. */
    const submit = (t: string, base: string, files: string[], author = "agent:ann"): string => { const id = sbm(nextSbm++); approvals.set(id, { taskId: t, projectId: w.project, base, tree: oid(100_000 + nextSbm), submittedBy: author, approved: true, files }); return id; };
    // The landing branch as the host sees it: each commit and the files it changed. A landing lands only on its base; a re-apply moves a submission onto the head when no file of it changed since its base.
    const commits: { id: string; files: string[] }[] = [{ id: oid(1), files: [] }];
    const head = (): string => commits[commits.length - 1]!.id;
    const filesOf = (id: string): string[] => [...approvals.values()].find((a) => a.tree === id)?.files ?? [];
    const reapplied = new Map<string, { base: string; tree: string; from: { base: string; tree: string } }>();
    const calls: { what: "restack" | "land"; call: unknown }[] = [];
    const host = async (call: WorkspaceCall): Promise<WorkspaceOutcome> => {
      calls.push({ what: "land", call });
      const s = call.submission!;
      if (s.base !== head()) return { ok: false, reason: `submission ${s.id} was approved on ${s.base.slice(0, 12)} but the landing branch is at ${head().slice(0, 12)}` };
      let files: string[];
      if (call.reappliedFrom !== undefined) {
        // The host's own proof: the re-applied base and tree are the ones it made from exactly the approved change.
        const made = reapplied.get(s.id);
        if (made === undefined || made.base !== s.base || made.tree !== s.tree || made.from.base !== call.reappliedFrom.base || made.from.tree !== call.reappliedFrom.tree) return { ok: false, reason: "not exactly the approved change; nothing was landed" };
        files = filesOf(call.reappliedFrom.tree);
      } else files = filesOf(s.tree);
      commits.push({ id: oid(commits.length + 1), files });
      return { ok: true, summary: "landed", detail: { landed: true, changed: true, written: files.length, submission: s.id, base: s.base, tree: s.tree, ...(call.reappliedFrom === undefined || o.dropProof === true ? {} : { reappliedFrom: { base: call.reappliedFrom.base, tree: call.reappliedFrom.tree } }) } };
    };
    const restack = async (call: { requestId: string; taskId: string; projectId: string; quietAttempts: readonly string[]; submission: { id: string; base: string; tree: string } }): Promise<RestackOutcome> => {
      calls.push({ what: "restack", call });
      const s = call.submission;
      if (s.base === head()) return { ok: true, state: "current" };
      const at = commits.findIndex((c) => c.id === s.base);
      if (at < 0) return { ok: false, reason: "the base is not on the landing branch" };
      const since = new Set(commits.slice(at + 1).flatMap((c) => c.files));
      const overlap = filesOf(s.tree).filter((f) => since.has(f));
      if (overlap.length > 0) return { ok: true, state: "overlap", paths: overlap, head: head() };
      const made = { base: head(), tree: oid(500_000 + reapplied.size), from: { base: s.base, tree: s.tree } };
      reapplied.set(s.id, made);
      return { ok: true, state: "reapplied", base: made.base, tree: made.tree, previous: s.base, recovered: false, taken: since.size };
    };
    const svc = WorkspaceOpService.withEpoch(w.storage, w.epoch, {
      quiesce: { around: async (_scope, _op, run) => run({ attempts: [] } as never) },
      portOf: async () => (o.restack === false ? { run: host } : { run: host, restack }),
      assignee: async () => ("assignee" in o ? o.assignee : "agent:ann"),
      landingLease: (by, call) => leaseOps.checkLanding(by, { ...call, branch: "main" }),
      landingQueue: { check: (by, call) => ops.checkLanding(by, call), landedChanges: (p, b, s) => ops.landedChanges(p, b, s), returned: (call) => ops.returned(call) },
    }, options);
    let landings = 0;
    const lander = async (by: Principal, holderTask: string) => {
      const lease = await leaseOps.acquire(by, { commandId: "lease", taskId: holderTask, branch: "main", ttlMs: 20 * 60 * 60_000 });
      return (taskId: string, commandId = `land-${++landings}`) => svc.request(by, { commandId, operation: "landing", taskId, reason: "land it", leaseId: lease.leaseId, fence: lease.fence } as never);
    };
    const list = () => ops.list(w.owner, { projectId: w.project });
    return { store, w, ops, person, task, submit, escalated, told, lander, list, calls, head, close: () => store.close(), queued: async () => (await list()).items.map((e) => e.taskId) };
  };

  test(`${backend.name}: a stale first place whose files are disjoint from what landed is re-applied onto the head and lands as exactly the approved change (card P10)`, async () => {
    const r = await rig();
    try {
      const ivy = await r.person("ivy");
      const [t1, t2] = [await r.task("one"), await r.task("two")];
      const base = r.head();
      const [s1, s2] = [r.submit(t1, base, ["src/a.ts"]), r.submit(t2, base, ["src/b.ts", "docs/c.md"])];
      await r.ops.queueApproved(s1, "rv1");
      await r.ops.queueApproved(s2, "rv2");
      const land = await r.lander(ivy, t1);
      const first = await land(t1);
      assert.equal(first.state, "done", first.summary);
      assert.equal(first.reapplied, undefined, "on its own base nothing is re-applied");
      assert.deepEqual(r.calls.map((c) => c.what), ["restack", "land"]);
      // Task two was approved on the old head: its files did not change there, so the integrator's host re-applies it onto the head, and the landing carries the re-applied base and tree, proven against the approved ones.
      const second = await land(t2);
      assert.equal(second.state, "done", second.summary);
      assert.deepEqual(r.calls.slice(2).map((c) => c.what), ["restack", "land"]);
      const landedCall = r.calls[3]!.call as WorkspaceCall;
      assert.equal(landedCall.submission!.base, second.reapplied!.base);
      assert.equal(landedCall.submission!.tree, second.reapplied!.tree);
      assert.deepEqual(landedCall.reappliedFrom, { base, tree: second.queued!.tree });
      assert.notEqual(second.reapplied!.base, base);
      assert.deepEqual([second.queued?.submissionId, second.queued?.base], [s2, base], "the record keeps what was approved and what landed");
      assert.deepEqual(await r.queued(), [], "the landing took the entry out of the queue");
      assert.equal(r.told.length + r.escalated.length, 0);
      // A repeat answers the recorded landing; nothing is asked again.
      const repeat = await land(t2, "land-2");
      assert.equal(repeat.replayed, true);
      assert.equal(r.calls.length, 4);
    } finally { await r.close(); }
  });

  test(`${backend.name}: a host that does not confirm the proof of a re-applied landing keeps the entry; a host without re-apply refuses a stale landing as before (card P10)`, async () => {
    for (const variant of [{ dropProof: true }, { restack: false as const }]) {
      const r = await rig(variant);
      try {
        const ivy = await r.person("ivy");
        const [t1, t2] = [await r.task("one"), await r.task("two")];
        const base = r.head();
        const [s1, s2] = [r.submit(t1, base, ["src/a.ts"]), r.submit(t2, base, ["src/b.ts"])];
        await r.ops.queueApproved(s1, "rv1");
        await r.ops.queueApproved(s2, "rv2");
        const land = await r.lander(ivy, t1);
        assert.equal((await land(t1)).state, "done");
        const second = await land(t2);
        if ("dropProof" in variant) {
          assert.equal(second.state, "done");
          assert.match(second.summary ?? "", /did not confirm that exactly submission .* landed, so it stays in the landing queue/);
        } else {
          assert.equal(second.state, "refused");
          assert.match(second.summary ?? "", /was approved on .* but the landing branch is at/);
          assert.equal(second.returned, undefined);
        }
        assert.deepEqual(await r.queued(), [t2], "the entry stays");
      } finally { await r.close(); }
    }
  });

  test(`${backend.name}: overlapping work goes back to the task's holder, out of the queue and not queued again; a refreshed submission lands; the returns end with the landing (card P10)`, async () => {
    const r = await rig();
    try {
      const ivy = await r.person("ivy"), ann = await r.person("ann", []);
      const [t1, t2, t3] = [await r.task("one"), await r.task("two"), await r.task("three")];
      const base = r.head();
      const [s1, s2, s3] = [r.submit(t1, base, ["src/a.ts"]), r.submit(t2, base, ["src/a.ts", "src/b.ts"]), r.submit(t3, base, ["docs/c.md"])];
      for (const [s, c] of [[s1, "rv1"], [s2, "rv2"], [s3, "rv3"]] as const) await r.ops.queueApproved(s, c);
      const land = await r.lander(ivy, t1);
      assert.equal((await land(t1)).state, "done");
      const back = await land(t2);
      assert.equal(back.state, "refused");
      assert.match(back.summary ?? "", new RegExp(`submission ${s2} changes file\\(s\\) that also changed on the landing branch since it was approved \\("src/a.ts"\\).*goes back to its author`));
      assert.deepEqual(back.returned, { paths: ["src/a.ts"], to: "agent:ann", cycles: 1, limit: 3, escalated: false });
      assert.equal(r.calls.filter((c) => c.what === "land").length, 1, "the host was not asked to land the overlapping work");
      assert.equal(r.told.length, 1);
      assert.equal(r.told[0]!.to, "agent:ann");
      assert.match(r.told[0]!.text, /changes file\(s\) that also changed there after it was approved \("src\/a.ts"\).*returned to you.*work\.refresh.*conflict return 1 of 3/);
      assert.deepEqual(r.escalated, []);
      // The returned work is out of the queue and not queued again, by the controller or by hand; the next task is first and lands.
      assert.deepEqual(await r.queued(), [t3]);
      assert.equal(await r.ops.queueApproved(s2, "rv2-again"), false);
      await refuses("invalid_transition", () => r.ops.add(ann, { commandId: "add-again", submissionId: s2 }), /was returned to its author because it changes files that landed/);
      const listed = await r.list();
      assert.deepEqual(listed.returns.map((x) => [x.taskId, x.count, x.last.submissionId, x.last.paths]), [[t2, 1, s2, ["src/a.ts"]]]);
      assert.equal((await land(t3)).state, "done");
      // The author refreshes and is approved again on the head: it is queued and lands; the returns of the task end with the landing.
      const s2b = r.submit(t2, r.head(), ["src/a.ts", "src/b.ts"]);
      await r.ops.queueApproved(s2b, "rv2b");
      assert.deepEqual(await r.queued(), [t2]);
      assert.equal((await land(t2)).state, "done");
      assert.deepEqual((await r.list()).returns, []);
      // A return of a submission that is no longer queued does nothing and counts nothing.
      assert.equal(await r.ops.returned({ requestId: "wsr-aaaaaaaaaaaaaaaaaaaa", taskId: t2, projectId: r.w.project, branch: "main", submissionId: s2b, paths: ["x"], assignee: "agent:ann" }), undefined);
    } finally { await r.close(); }
  });

  test(`${backend.name}: returns count as repair cycles; at the limit the director and owner are told, each return from then on; a repeat counts once (card P10 with Q04)`, async () => {
    const r = await rig({ limit: 2 });
    try {
      const ivy = await r.person("ivy");
      const [t1, t2] = [await r.task("one"), await r.task("two")];
      const land = await r.lander(ivy, t1);
      const counts: { cycles?: number; escalated?: boolean }[] = [];
      for (let round = 1; round <= 3; round++) {
        // Each round: other work lands on the file, then task two's work, approved on the head before that, overlaps.
        const before = r.head();
        const other = r.submit(t1, before, ["src/a.ts"]);
        const mine = r.submit(t2, before, ["src/a.ts"]);
        await r.ops.queueApproved(other, `o${round}`);
        await r.ops.queueApproved(mine, `m${round}`);
        assert.equal((await land(t1)).state, "done");
        const back = await land(t2);
        assert.equal(back.state, "refused");
        counts.push({ ...(back.returned?.cycles === undefined ? {} : { cycles: back.returned.cycles }), ...(back.returned?.escalated === undefined ? {} : { escalated: back.returned.escalated }) });
      }
      assert.deepEqual(counts, [{ cycles: 1, escalated: false }, { cycles: 2, escalated: true }, { cycles: 3, escalated: true }]);
      assert.deepEqual(r.escalated.map((e) => [e.taskId, e.why, e.commandId]), [[t2, "returns", `lq-returns:${t2}:2`], [t2, "returns", `lq-returns:${t2}:3`]]);
      assert.match(r.escalated[0]!.text, /returned to its author 2 time\(s\) \(the limit is 2, review\.repairCycles\).*landing\.queue\.remove/);
      assert.equal(r.told.length, 3, "the holder is told each time");
      // A repeat of the same return (the same request) counts once.
      const s = r.submit(t2, r.head(), ["src/z.ts"]);
      await r.ops.queueApproved(s, "z");
      const once = await r.ops.returned({ requestId: "wsr-bbbbbbbbbbbbbbbbbbbb", taskId: t2, projectId: r.w.project, branch: "main", submissionId: s, paths: ["src/z.ts"], assignee: "agent:ann" });
      const twice = await r.ops.returned({ requestId: "wsr-bbbbbbbbbbbbbbbbbbbb", taskId: t2, projectId: r.w.project, branch: "main", submissionId: s, paths: ["src/z.ts"], assignee: "agent:ann" });
      assert.deepEqual([once?.cycles, twice?.cycles], [4, 4]);
      assert.equal((await r.list()).returns.find((x) => x.taskId === t2)?.count, 4);
    } finally { await r.close(); }
  });

  test(`${backend.name}: returned work of a task nobody holds, or whose holder is no longer active (a retired author), is told to the director and owner instead (card P10)`, async () => {
    for (const variant of [{ assignee: undefined }, { assignee: "agent:old", active: (id: string) => id !== "old" }]) {
      const r = await rig(variant);
      try {
        const ivy = await r.person("ivy");
        const [t1, t2] = [await r.task("one"), await r.task("two")];
        const base = r.head();
        await r.ops.queueApproved(r.submit(t1, base, ["src/a.ts"]), "rv1");
        await r.ops.queueApproved(r.submit(t2, base, ["src/a.ts"], "agent:old"), "rv2");
        const land = await r.lander(ivy, t1);
        assert.equal((await land(t1)).state, "done");
        const back = await land(t2);
        assert.equal(back.state, "refused");
        assert.deepEqual(back.returned, { paths: ["src/a.ts"], cycles: 1, limit: 3, escalated: true });
        assert.deepEqual(r.told, [], "nobody inactive is told");
        assert.deepEqual(r.escalated.map((e) => [e.taskId, e.why]), [[t2, "unassigned"]]);
        assert.match(r.escalated[0]!.text, /no active agent holds the task to refresh it\. Assign the task, or take it out with landing\.queue\.remove/);
        assert.deepEqual(await r.queued(), []);
      } finally { await r.close(); }
    }
  });
}
