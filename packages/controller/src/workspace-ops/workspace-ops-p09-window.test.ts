import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { ProjectService } from "../domain/service.js";
import { LandingGate, LandingQueueOps, LandingQueueService, type LandingChecksRecord } from "../landing/index.js";
import { IntegrationPolicyService, type Check } from "../policy/integration-policy.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { SubmissionService, landingDirectorGate } from "../submissions/index.js";
import type { DefectsGateView, DocsGateView, QaGateView } from "../landing/landing-gate.js";
import { WorkspaceOpService, type WorkspacePort, type WorkspaceDeps } from "./index.js";

after(stopServer);

// Card P09 (read-once windows): the review, QA, documents, director and defects checks are read while the checks are judged, and again as the very last step before the host is asked to land (`LandingGate.recheck`). A change
// that lands between the two reads (here: right after the gate answered, before the lease and the queue are shown again and the host is asked) refuses the landing, names the check that changed, keeps the queue place and
// leaves nothing committed. The review and the director sign-off are real submission records on all four backends; the QA, documents and defects views are controlled here (their readers are tested with their own services).
// A change that lands after the host was asked is not stopped (the host's write is not transactional with the controller's records): one test states that limit.
const options = { clock: () => "2026-11-22T10:00:00.000Z", pause: async () => undefined };
const BASE = "b".repeat(40), HEAD = "c".repeat(40), TREE = "e".repeat(40), PATCH = "a".repeat(40);
const ALL: readonly Check[] = ["review", "qa", "docs", "director", "defects"];
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;

for (const backend of backends) {
  const rig = async (required: readonly Check[] = ALL) => {
    const store = await backend.open();
    const projects = await ProjectService.open(store.storage, { holder: "c1", ...options });
    const principals = PrincipalService.withEpoch(store.storage, projects.epoch, options);
    const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
    const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P" })).id;
    const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "T" })).id;
    const roles = new Map<string, string[]>();
    const agent = async (nm: string, held: string[]): Promise<Principal> => {
      await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: [{ action: "task.read", project }] });
      const p = await principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
      roles.set(p.id, held);
      return p;
    };
    const ann = await agent("ann", ["author"]);
    const rev = await agent("rev", ["reviewer"]);
    const dee = await agent("dee", ["director"]);
    const svc = SubmissionService.withEpoch(store.storage, projects.epoch, async (id) => roles.get(id) ?? [], options);
    const sub = (await svc.record(ann, { commandId: cid("code"), taskId: task, kind: "code", role: "author", base: BASE, tree: TREE, patchId: PATCH })).id;
    const review = (verdict: "approve" | "changes") => svc.record(rev, { commandId: cid("rv"), taskId: task, kind: "review", role: "reviewer", subject: sub, verdict });
    const signoff = (decision: "approve" | "decline") => svc.record(dee, { commandId: cid("so"), taskId: task, kind: "signoff", role: "director", subject: sub, decision });
    await review("approve");
    await signoff("approve");
    const integration = IntegrationPolicyService.withEpoch(store.storage, projects.epoch, options);
    await integration.set(owner, { commandId: cid("req"), projectId: project, requiredChecks: [...required] });
    // The controlled views.
    const views = { qa: "passed" as "passed" | "failed", pending: [] as { obligationId: string; title: string; reason: string }[], defects: 0, defectsFail: false };
    const reads = { approvals: 0, qa: 0, docs: 0, defects: 0, director: 0 };
    const gate = new LandingGate({
      requiredChecks: async (p) => (await integration.effective(p)).requiredChecks,
      tests: async () => ({ version: 1, checks: [{ name: "unit", run: ["npm", "test"] }] }),
      approvalOf: async (id) => { reads.approvals++; return svc.approvalOf(id); },
      qaGate: async (id): Promise<QaGateView> => { reads.qa++; return { taskId: task, submissionId: id, tree: TREE, verdict: views.qa, reasons: views.qa === "passed" ? [] : ["check_failed"] }; },
      docsGate: async (_t, id): Promise<DocsGateView> => { reads.docs++; return { taskId: task, submissionId: id, tree: TREE, checked: 1, pending: views.pending }; },
      directorGate: async (id) => { reads.director++; return landingDirectorGate(svc)(id); },
      defectsGate: async (): Promise<DefectsGateView> => {
        reads.defects++;
        if (views.defectsFail) throw new Error("defect store down");
        return { taskId: task, checked: views.defects, unresolved: views.defects, items: Array.from({ length: views.defects }, (_, i) => ({ id: `dfc-${i}`, severity: "major", state: "open", finding: "x", deliverableTitle: "y" })) };
      },
      now: options.clock,
    });
    const host = { during: undefined as undefined | (() => Promise<void>) };
    const calls: { checks: number; runs: unknown[] } = { checks: 0, runs: [] };
    const port: WorkspacePort = {
      run: async (call) => { calls.runs.push(call); if (host.during !== undefined) await host.during(); return { ok: true, summary: "landed", detail: { landed: true, changed: true, written: 1 } }; },
      landingChecks: async (call) => { calls.checks++; return { checkout: true, change: { base: BASE, head: HEAD, tree: TREE, patchId: PATCH }, ...(call.reviewed === undefined ? {} : { reviewedPatchId: PATCH }), checks: call.checks.map((c) => ({ name: c.name, state: "passed" as const, exitCode: 0 })) }; },
    };
    const told: { text: string }[] = [];
    // `afterGate` is the change that lands between the gate's reads and the host: it runs right after the gate answered.
    const control = { afterGate: undefined as undefined | (() => Promise<void>), recheck: true, rechecked: 0, fault: false };
    let gateSeen: LandingChecksRecord | undefined;
    const deps = (): WorkspaceDeps => ({
      quiesce: { around: async (_scope, _op, run, after) => { const out = await run({ attempts: [{ attemptId: "att-1" }] } as never); await after?.("att-1"); return out; } },
      portOf: async () => port,
      assignee: async () => "agent:bob",
      attempts: { live: async () => [], frozenReason: async () => undefined, release: async () => undefined, tell: async () => true },
      approvalOf: (id) => svc.approvalOf(id),
      landingGate: async (call) => { const r = await gate.evaluate(call); gateSeen = r; if (control.afterGate !== undefined) { const f = control.afterGate; control.afterGate = undefined; await f(); } return r; },
      ...(control.recheck ? { landingRecheck: async (record: LandingChecksRecord) => { control.rechecked++; if (control.fault) throw new Error("record store down"); return gate.recheck(record); } } : {}),
      tellAuthor: async (x) => { told.push(x); },
    });
    const service = WorkspaceOpService.withEpoch(store.storage, projects.epoch, deps(), options);
    const land = (commandId: string) => service.request(owner, { commandId, operation: "landing", taskId: task, reason: "ready", submissionId: sub });
    return { store, owner, project, integration, task, sub, review, signoff, views, reads, host, calls, told, control, land, gateSeen: () => gateSeen };
  };

  test(`${backend.name}: nothing changed between the reads: the landing goes ahead as before, the host ran the checks once and the records were read again (card P09)`, async () => {
    const r = await rig();
    try {
      const out = await r.land("w0");
      assert.equal(out.state, "done", out.summary);
      assert.deepEqual([out.checks!.passed, out.checks!.results.map((x) => x.result)], [true, ["pass", "pass", "pass", "pass", "pass"]]);
      assert.equal(r.calls.runs.length, 1);
      assert.equal(r.calls.checks, 1, "the tests are not run again: the second reading is from the records");
      assert.equal(r.control.rechecked, 1);
      assert.equal(r.told.length, 0);
    } finally { await r.store.close(); }
  });

  const windows: { label: string; change: (r: Awaited<ReturnType<typeof rig>>) => Promise<void>; check: string; result: "failed" | "not run"; text: RegExp }[] = [
    { label: "a review that asks for changes", change: async (r) => { await r.review("changes"); }, check: "review", result: "failed", text: /is not approved/ },
    { label: "a defect reported against the task", change: async (r) => { r.views.defects = 1; }, check: "defects", result: "failed", text: /1 of 1 defect\(s\) of this task are not finished/ },
    { label: "a document flagged as out of date", change: async (r) => { r.views.pending = [{ obligationId: "doc-1", title: "User guide", reason: "flagged" }]; }, check: "docs", result: "failed", text: /User guide \(flagged\)/ },
    { label: "a director sign-off taken back", change: async (r) => { await r.signoff("decline"); }, check: "director", result: "failed", text: /declines it/ },
    { label: "QA evidence that no longer passes", change: async (r) => { r.views.qa = "failed"; }, check: "qa", result: "failed", text: /did not pass: check_failed/ },
  ];
  for (const w of windows) {
    test(`${backend.name}: ${w.label} just before the landing stops it before the host is asked and says which check changed (card P09)`, async () => {
      const r = await rig();
      try {
        r.control.afterGate = () => w.change(r);
        const out = await r.land("w1");
        assert.equal(out.state, "refused", out.summary);
        assert.equal(r.calls.runs.length, 0, "the host was never asked to write");
        assert.match(out.summary!, /a required check that had passed changed before the landing was made/);
        assert.match(out.summary!, new RegExp(`${w.check} ${w.result}`));
        assert.match(out.summary!, /so nothing was landed/);
        // The record keeps what the checks now say, and the author is told exactly that.
        assert.equal(out.checks!.passed, false);
        assert.equal(out.checks!.results.find((x) => x.check === w.check)!.result, "fail");
        assert.match(out.checks!.results.find((x) => x.check === w.check)!.summary, w.text);
        assert.deepEqual(out.checks!.results.filter((x) => x.check !== w.check).map((x) => x.result), ["pass", "pass", "pass", "pass"], "the other checks keep what they said");
        assert.equal(r.gateSeen()!.passed, true, "the gate itself had passed when it answered");
        assert.equal(r.told.length, 1);
        assert.match(r.told[0]!.text, new RegExp(`${w.check}: failed`));
        // Asked again once it is right again (the change undone), the landing goes ahead: the refusal left nothing behind.
        if (w.check === "review") await r.review("approve");
        if (w.check === "defects") r.views.defects = 0;
        if (w.check === "docs") r.views.pending = [];
        if (w.check === "director") await r.signoff("approve");
        if (w.check === "qa") r.views.qa = "passed";
        const again = await r.land("w2");
        assert.equal(again.state, "done", again.summary);
        assert.equal(r.calls.runs.length, 1);
      } finally { await r.store.close(); }
    });
  }

  test(`${backend.name}: the records that cannot be read again fail closed, and a landing that requires only tests reads no record again (card P09)`, async () => {
    const r = await rig(["defects"]);
    try {
      r.control.afterGate = async () => { r.views.defectsFail = true; };
      const out = await r.land("w3");
      assert.equal(out.state, "refused", out.summary);
      // The gate reads a failing record as "not run", so the reading that fails is a changed check, refused like the others.
      assert.match(out.summary!, /defects not run: the defects of the task could not be read: defect store down/);
      assert.equal(r.calls.runs.length, 0);
      assert.equal(out.checks!.passed, false);
    } finally { await r.store.close(); }
    // A second reading that itself throws (nothing could be judged again) refuses too, and the gate's own answer stays on the record.
    const f = await rig();
    try {
      f.control.fault = true;
      const out = await f.land("w3b");
      assert.equal(out.state, "refused", out.summary);
      assert.match(out.summary!, /could not be read again right before the landing, so nothing was landed: record store down/);
      assert.equal(f.calls.runs.length, 0);
      assert.equal(out.checks!.passed, true, "the gate's own answer is kept as it was");
      assert.equal(f.told.length, 0);
    } finally { await f.store.close(); }
    const t = await rig(["tests"]);
    try {
      let at = 0;
      t.control.afterGate = async () => { at = t.reads.approvals + t.reads.defects + t.reads.qa + t.reads.docs + t.reads.director; };
      await t.land("w4");
      assert.equal(t.reads.approvals + t.reads.defects + t.reads.qa + t.reads.docs + t.reads.director, at, "nothing was read again");
      assert.equal(t.control.rechecked, 1);
    } finally { await t.store.close(); }
  });

  test(`${backend.name}: a check the project requires since the checks were judged stops the landing before the host is asked, tells nobody, and a check no longer required changes nothing (card P09)`, async () => {
    const r = await rig(["review"]);
    try {
      // The policy is read before the host runs the tests (minutes); a check required since then was never judged for this landing.
      r.control.afterGate = async () => { await r.integration.set(r.owner, { commandId: cid("req"), projectId: r.project, requiredChecks: ["review", "defects"] }); };
      const out = await r.land("w7");
      assert.equal(out.state, "refused", out.summary);
      assert.match(out.summary!, /the project's required checks changed while this landing was judged \(it now also requires defects, which was not judged for it\), so nothing was landed/);
      assert.equal(r.calls.runs.length, 0, "the host was never asked to write");
      assert.equal(r.reads.defects, 0, "nothing else was read: the added check is judged by the next landing");
      assert.deepEqual([out.checks!.passed, out.checks!.required], [true, ["review"]], "the gate's own answer is kept as it was");
      assert.equal(r.told.length, 0, "the author cannot change the policy, so nobody is told");
      assert.equal(out.toldAuthor, undefined);
      // Asked again, the landing is judged under the checks now required (here the defects are clear) and goes ahead.
      const again = await r.land("w8");
      assert.equal(again.state, "done", again.summary);
      assert.deepEqual(again.checks!.required, ["review", "defects"]);
      // A check dropped since the judgement does not refuse: the landing met the stricter set.
      r.control.afterGate = async () => { await r.integration.set(r.owner, { commandId: cid("req"), projectId: r.project, requiredChecks: ["review"] }); };
      const fewer = await r.land("w9");
      assert.equal(fewer.state, "done", fewer.summary);
      assert.equal(r.calls.runs.length, 2);
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: a change after the host was asked cannot stop the landing already under way; the next landing sees it (card P09: the limit that remains)`, async () => {
    const r = await rig();
    try {
      r.host.during = async () => { r.views.defects = 1; await r.review("changes"); };
      const out = await r.land("w5");
      assert.equal(out.state, "done", out.summary);
      assert.equal(r.calls.runs.length, 1);
      const next = await r.land("w6");
      assert.equal(next.state, "refused", "the change is seen by the next landing");
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: a refusal in the new window keeps the task's place in the landing queue (cards P09 and P10)`, async () => {
    const store = await backend.open();
    try {
      const projects = await ProjectService.open(store.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(store.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P" })).id;
      const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "T" })).id;
      const S1 = "sbm-aaaaaaaaaaaaaaaaaaaa";
      const approvals = new Map([[S1, { taskId: task, projectId: project, base: BASE, tree: TREE, patchId: PATCH, approved: true, approvedBy: "agent:rev", newest: "approve" as const, submittedBy: "agent:ann", submittedAt: "2026-11-22T09:00:00.000Z" }]]);
      const integration = IntegrationPolicyService.withEpoch(store.storage, projects.epoch, options);
      await integration.set(owner, { commandId: cid("req"), projectId: project, requiredChecks: ["review", "defects"] });
      const queueOps = new LandingQueueOps(LandingQueueService.withEpoch(store.storage, projects.epoch, options), { approvalOf: async (id) => approvals.get(id), landingBranch: async () => "main", projectOfTask: async () => project });
      await queueOps.add(owner, { commandId: cid("q"), submissionId: S1 });
      let defects = 0;
      const gate = new LandingGate({ requiredChecks: async () => ["review", "defects"], tests: async () => undefined, approvalOf: async (id) => approvals.get(id), defectsGate: async () => ({ taskId: task, checked: defects, unresolved: defects, items: defects === 0 ? [] : [{ id: "dfc-1", severity: "major", state: "open", finding: "x", deliverableTitle: "y" }] }), now: options.clock });
      const runs: unknown[] = [];
      let afterGate: (() => void) | undefined;
      const port: WorkspacePort = { run: async (call) => { runs.push(call); return { ok: true, summary: "landed", detail: { landed: true, changed: true, written: 1, ...(call.submission === undefined ? {} : { submission: call.submission.id, base: call.submission.base, tree: call.submission.tree }) } }; }, landingChecks: async (call) => ({ checkout: true, change: { base: BASE, head: HEAD, tree: TREE, patchId: PATCH }, ...(call.reviewed === undefined ? {} : { reviewedPatchId: PATCH }), checks: [] }) };
      const service = WorkspaceOpService.withEpoch(store.storage, projects.epoch, {
        quiesce: { around: async (_s, _o, run, after) => { const out = await run({ attempts: [{ attemptId: "att-1" }] } as never); await after?.("att-1"); return out; } },
        portOf: async () => port,
        landingLease: async () => ({ leaseId: "lse-1", fence: 1 }),
        assignee: async () => "agent:bob",
        attempts: { live: async () => [], frozenReason: async () => undefined, release: async () => undefined, tell: async () => true },
        approvalOf: async (id) => approvals.get(id),
        landingQueue: { check: (by, call) => queueOps.checkLanding(by, call), landedChanges: (p, b, s) => queueOps.landedChanges(p, b, s) },
        landingGate: async (call) => { const r = await gate.evaluate(call); afterGate?.(); afterGate = undefined; return r; },
        landingRecheck: (record) => gate.recheck(record),
      }, options);
      const queued = async () => (await queueOps.list(owner, { projectId: project })).items.map((e) => [e.submissionId, e.taskId]);
      afterGate = () => { defects = 1; };
      const out = await service.request(owner, { commandId: "ql1", operation: "landing", taskId: task, reason: "ready" });
      assert.equal(out.state, "refused", out.summary);
      assert.match(out.summary!, /defects failed/);
      assert.match(out.summary!, /submission sbm-a{20} stays in the landing queue/);
      assert.equal(runs.length, 0);
      assert.deepEqual(await queued(), [[S1, task]], "the entry kept its place");
      defects = 0;
      const ok = await service.request(owner, { commandId: "ql2", operation: "landing", taskId: task, reason: "ready" });
      assert.equal(ok.state, "done", ok.summary);
      assert.deepEqual(await queued(), [], "the landing that went through took it out");
    } finally { await store.close(); }
  });
}

test("a record the gate did not answer cannot be read again (it throws, so the landing is refused), and one with nothing to read is passed through (card P09)", async () => {
  const gate = new LandingGate({ requiredChecks: async () => ["review"], tests: async () => undefined, approvalOf: async () => undefined, now: options.clock });
  const made: LandingChecksRecord = { required: ["review"], passed: true, results: [{ check: "review", result: "pass", summary: "approved" }], at: options.clock() };
  await assert.rejects(gate.recheck(made), /not judged by this gate/);
  const none: LandingChecksRecord = { required: ["tests"], passed: true, results: [{ check: "tests", result: "pass", summary: "ok" }], at: options.clock() };
  assert.deepEqual(await gate.recheck(none), { changed: [], record: none });
});
