import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { ProjectService } from "../domain/service.js";
import { AssignmentService } from "../domain/assignments.js";
import { BlockerService } from "../domain/blockers.js";
import { WaitService } from "../domain/waits.js";
import { ContractService } from "../planning/contracts.js";
import { LandingGate, type LandingChecksRecord } from "../landing/index.js";
import { IntegrationPolicyService, type Check } from "../policy/integration-policy.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { SubmissionService } from "../submissions/index.js";
import { StatusService } from "../status/index.js";
import { WorkspaceOpService, type WorkspacePort, type WorkspaceDeps } from "./index.js";

after(stopServer);

// Card P09 (owner view of the checks): the `landing_checks` status kind answers "why did that landing go ahead or not" from the landing requests' own records (what each required check said, the tree and patch it was judged
// on, and what the final re-read changed). The gate, the workspace service and the status service are real on all four backends; the host and the QA, documents and defects readers are controlled here.
const options = { clock: () => "2026-11-23T10:00:00.000Z", pause: async () => undefined };
const BASE = "b".repeat(40), HEAD = "c".repeat(40), TREE = "e".repeat(40), PATCH = "a".repeat(40);
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;

for (const backend of backends) {
  const rig = async (required: readonly Check[], title = "Login") => {
    const store = await backend.open();
    const projects = await ProjectService.open(store.storage, { holder: "c1", ...options });
    const principals = PrincipalService.withEpoch(store.storage, projects.epoch, options);
    const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
    const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "Orchard" })).id;
    const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title })).id;
    const roles = new Map<string, string[]>();
    const agent = async (nm: string, held: string[]): Promise<Principal> => {
      await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: [{ action: "task.read", project }] });
      const p = await principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
      roles.set(p.id, held);
      return p;
    };
    const ann = await agent("ann", ["author"]);
    const rev = await agent("rev", ["reviewer"]);
    const svc = SubmissionService.withEpoch(store.storage, projects.epoch, async (id) => roles.get(id) ?? [], options);
    const sub = (await svc.record(ann, { commandId: cid("code"), taskId: task, kind: "code", role: "author", base: BASE, tree: TREE, patchId: PATCH })).id;
    const review = (verdict: "approve" | "changes") => svc.record(rev, { commandId: cid("rv"), taskId: task, kind: "review", role: "reviewer", subject: sub, verdict });
    await review("approve");
    const integration = IntegrationPolicyService.withEpoch(store.storage, projects.epoch, options);
    await integration.set(owner, { commandId: cid("req"), projectId: project, requiredChecks: [...required] });
    const views = { defects: 0, commandName: "unit" };
    const gate = new LandingGate({
      requiredChecks: async (p) => (await integration.effective(p)).requiredChecks,
      tests: async () => ({ version: 3, checks: [{ name: views.commandName, run: ["npm", "test"] }] }),
      approvalOf: (id) => svc.approvalOf(id),
      defectsGate: async () => ({ taskId: task, checked: views.defects, unresolved: views.defects, items: Array.from({ length: views.defects }, (_, i) => ({ id: `dfc-${i}`, severity: "major", state: "open", finding: "x", deliverableTitle: "y" })) }),
      now: options.clock,
    });
    const host = { during: undefined as undefined | (() => Promise<void>), none: false, fail: false };
    const port: WorkspacePort = {
      run: async () => ({ ok: true, summary: "landed", detail: { landed: true, changed: true, written: 1 } }),
      landingChecks: async (call) => ({ checkout: true, change: { base: BASE, head: HEAD, tree: TREE, patchId: PATCH }, ...(call.reviewed === undefined ? {} : { reviewedPatchId: PATCH }), checks: call.checks.map((c) => host.fail ? { name: c.name, state: "failed" as const, exitCode: 1, output: "FAIL in /home/rob/secret-place/src/a.ts with sk-live-0123456789abcdef0123456789abcdef" } : { name: c.name, state: "passed" as const, exitCode: 0, output: "all good" }) }),
    };
    const control = { afterGate: undefined as undefined | (() => Promise<void>), fault: false, noRecheck: false };
    const deps = (): WorkspaceDeps => ({
      quiesce: { around: async (_scope, _op, run, after) => { const out = await run({ attempts: [{ attemptId: "att-1" }] } as never); await after?.("att-1"); return out; } },
      portOf: async () => (host.none ? undefined : port),
      assignee: async () => "agent:bob",
      attempts: { live: async () => [], frozenReason: async () => undefined, release: async () => undefined, tell: async () => true },
      approvalOf: (id) => svc.approvalOf(id),
      landingGate: async (call) => { const r = await gate.evaluate(call); if (control.afterGate !== undefined) { const f = control.afterGate; control.afterGate = undefined; await f(); } return r; },
      landingRecheck: async (record: LandingChecksRecord) => { if (control.fault) throw new Error("record store down"); return gate.recheck(record); },
      tellAuthor: async () => undefined,
    });
    const service = WorkspaceOpService.withEpoch(store.storage, projects.epoch, deps(), options);
    const assignments = AssignmentService.withEpoch(store.storage, projects.epoch, projects, options);
    const base = { assignments, waits: WaitService.withEpoch(store.storage, projects.epoch, assignments, options), blockers: BlockerService.withEpoch(store.storage, projects.epoch, options), contracts: ContractService.withEpoch(store.storage, projects.epoch, options) };
    const status = StatusService.withEpoch(store.storage, projects.epoch, { ...base, landingChecks: { landings: (scope, after, limit) => service.landings(scope, after, limit) } }, options);
    const bare = StatusService.withEpoch(store.storage, projects.epoch, base, options);
    const land = (commandId: string) => service.request(owner, { commandId, operation: "landing", taskId: task, reason: "ready", submissionId: sub });
    const ask = async (by: Principal, request: Record<string, unknown>) => (await status.ask(by, { kind: "landing_checks", ...request } as never))?.lines.map((l) => l.text).join("\n");
    return { store, owner, ann, project, projects, integration, task, sub, review, views, host, control, land, ask, status, bare, service };
  };

  test(`${backend.name}: the view shows each check's result, the tree and patch judged and a final re-read that found nothing changed, citing the request record (card P09)`, async () => {
    const r = await rig(["tests", "review", "defects"]);
    try {
      const out = await r.land("v1");
      assert.equal(out.state, "done", out.summary);
      assert.equal(out.rechecked?.outcome, "unchanged");
      const shown = (await r.status.ask(r.owner, { kind: "landing_checks", taskId: r.task }))!;
      const text = shown.lines.map((l) => l.text).join("\n");
      assert.match(text, /task Login: 1 landing attempt\(s\) on record/);
      assert.match(text, new RegExp(`request ${out.id} made .* was carried out by the host; it judged submission ${r.sub}`));
      assert.match(text, /Required then: tests, review, defects\. Judged on integrated tree eeeeeeeeeeee \(base bbbbbbbbbbbb, patch aaaaaaaaaaaa, test commands from contract version 3\)\. Overall: every required check passed/);
      assert.match(text, /tests passed: all 1 test command\(s\) passed on the integrated tree Commands: unit passed \(exit 0\)\./);
      assert.match(text, /review passed/);
      assert.match(text, /defects passed/);
      assert.match(text, /found every check still passing: it changed and refused nothing/);
      assert.ok(shown.lines.slice(1).every((l) => l.cites.some((c) => c.kind === "workspace-request" && c.id === out.id)), "every line cites its request record");
      assert.ok(!text.includes("all good"), "test output is not shown");
      // The project's view lists the same attempt, naming its task.
      const project = (await r.ask(r.owner, { projectId: r.project }))!;
      assert.match(project, /project Orchard: 1 landing attempt\(s\)/);
      assert.match(project, new RegExp(`\\(task ${r.task}\\)`));
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: a final re-read that changed a check, one that found a newly required check, and one that could not read are each told, with why (card P09)`, async () => {
    const r = await rig(["review", "defects"]);
    try {
      r.control.afterGate = async () => { r.views.defects = 2; };
      const a = await r.land("v2a");
      assert.equal(a.state, "refused");
      assert.deepEqual(a.rechecked, { outcome: "changed", checks: ["defects"] });
      r.views.defects = 0;
      r.control.afterGate = async () => { await r.integration.set(r.owner, { commandId: cid("req"), projectId: r.project, requiredChecks: ["review", "defects", "qa"] }); };
      const b = await r.land("v2b");
      assert.equal(b.state, "refused");
      assert.deepEqual(b.rechecked, { outcome: "added", checks: ["qa"] });
      await r.integration.set(r.owner, { commandId: cid("req"), projectId: r.project, requiredChecks: ["review", "defects"] });
      r.control.fault = true;
      const c = await r.land("v2c");
      assert.equal(c.state, "refused");
      assert.deepEqual(c.rechecked, { outcome: "unreadable" });
      const text = (await r.ask(r.owner, { taskId: r.task }))!;
      assert.match(text, /3 landing attempt\(s\) on record, newest first; showing 1 to 3/);
      // Newest first: the unreadable one, then the added one, then the changed one.
      const at = (re: RegExp): number => text.search(re);
      assert.ok(at(/could not be made, so the landing was refused/) < at(/began to require check\(s\) \(qa\)/) && at(/began to require check\(s\) \(qa\)/) < at(/found check\(s\) \(defects\) no longer passing/), text);
      assert.match(text, /defects failed: .*2 of 2 defect\(s\)/);
      assert.match(text, /Overall: not every required check passed/);
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: a landing refused before any check says no check was judged; with no landing at all the view says so; a failed test run shows its command and exit code but no output, host path or secret (card P09)`, async () => {
    const r = await rig(["tests"]);
    try {
      assert.match((await r.ask(r.owner, { taskId: r.task }))!, /No landing attempt is on record for task Login/);
      r.host.none = true;
      const none = await r.land("v3a");
      assert.equal(none.state, "refused");
      assert.equal(none.rechecked, undefined);
      assert.match((await r.ask(r.owner, { taskId: r.task }))!, /was refused, so nothing was landed.*\nNo check was judged for this attempt/s);
      r.host.none = false;
      r.host.fail = true;
      r.views.commandName = "run /home/rob/secret-place/bin/check sk-live-0123456789abcdef0123456789abcdef";
      const failed = await r.land("v3b");
      assert.equal(failed.state, "refused");
      assert.equal(failed.rechecked, undefined, "the gate refused, the re-read was not reached");
      const text = (await r.ask(r.owner, { taskId: r.task }))!;
      assert.match(text, /tests failed/);
      assert.match(text, /\(exit 1\)/);
      assert.match(text, /was not made for this attempt/);
      for (const leak of ["/home/rob", "secret-place", "sk-live-0123456789", "FAIL in"]) assert.ok(!text.includes(leak), `"${leak}" is not shown`);
      assert.match(text, /\[a path\]/);
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: the view is paged five attempts at a time by count, newest first, and refuses a bad request (card P09)`, async () => {
    const r = await rig(["review"]);
    try {
      const ids: string[] = [];
      for (let i = 0; i < 7; i++) ids.push((await r.land(`v4-${i}`)).id);
      const first = (await r.ask(r.owner, { taskId: r.task }))!;
      assert.match(first, /7 landing attempt\(s\) on record, newest first; showing 1 to 5/);
      assert.match(first, /Older attempts follow: ask again with after 5/);
      assert.ok(first.includes(ids[6]!) && !first.includes(ids[1]!) && !first.includes(ids[0]!));
      const second = (await r.ask(r.owner, { taskId: r.task, after: 5 }))!;
      assert.match(second, /showing 6 to 7/);
      assert.ok(second.includes(ids[1]!) && second.includes(ids[0]!) && !second.includes(ids[6]!));
      assert.ok(!/Older attempts follow/.test(second));
      assert.match((await r.ask(r.owner, { taskId: r.task, after: 40 }))!, /none after number 40/);
      await assert.rejects(r.ask(r.owner, { taskId: r.task, after: -1 }), /whole number/);
      await assert.rejects(r.ask(r.owner, { taskId: r.task, after: "x" }), /whole number/);
      await assert.rejects(r.ask(r.owner, { taskId: r.task, projectId: r.project }), /not both/);
      await assert.rejects(r.ask(r.owner, {}), /name a task/);
      await assert.rejects(r.ask(r.owner, { taskId: r.task, name: "x" }), /name/);
      assert.equal(await r.ask(r.owner, { taskId: "task-aaaaaaaaaaaaaaaaaaaa" }), undefined);
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: only the owner reads it; an agent, and a controller that keeps no landings, get nothing or say so (card P09)`, async () => {
    const r = await rig(["review"]);
    try {
      await r.land("v5");
      assert.equal(await r.ask(r.ann, { taskId: r.task }), undefined);
      assert.equal(await r.ask(r.ann, { projectId: r.project }), undefined);
      assert.match((await r.bare.ask(r.owner, { kind: "landing_checks", taskId: r.task } as never))!.lines[0]!.text, /Landing attempts are not kept on this controller/);
    } finally { await r.store.close(); }
  });
}
