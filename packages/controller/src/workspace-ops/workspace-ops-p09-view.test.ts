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
import { StorageError } from "../storage/index.js";
import type { ControllerStorage } from "../storage/types.js";

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
    const host = { during: undefined as undefined | (() => Promise<void>), none: false, fail: false, block: undefined as undefined | Promise<void>, entered: undefined as undefined | (() => void) };
    const port: WorkspacePort = {
      run: async () => { host.entered?.(); if (host.block !== undefined) await host.block; return { ok: true, summary: "landed", detail: { landed: true, changed: true, written: 1 } }; },
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
    // A second task of the same project with its own approved submission (two landings of one project at once).
    const another = async (title: string) => {
      const t = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title })).id;
      const s2 = (await svc.record(ann, { commandId: cid("code"), taskId: t, kind: "code", role: "author", base: BASE, tree: TREE, patchId: PATCH })).id;
      await svc.record(rev, { commandId: cid("rv"), taskId: t, kind: "review", role: "reviewer", subject: s2, verdict: "approve" });
      return { task: t, land: (commandId: string) => service.request(owner, { commandId, operation: "landing", taskId: t, reason: "ready", submissionId: s2 }) };
    };
    return { store, owner, ann, project, projects, integration, task, sub, review, views, host, control, land, ask, status, bare, service, deps, base, another };
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
      assert.match(text, /No final re-read of the records right before the host was asked is recorded for this attempt: the checks above had already refused it/);
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

  test(`${backend.name}: a landing left running by a controller that stopped is listed as of unknown result with no check result recorded, and once its real outcome arrives it is listed once (card P09 review)`, async () => {
    const r = await rig(["review"]);
    try {
      let release!: () => void;
      r.host.block = new Promise<void>((res) => { release = res; });
      const entered = new Promise<void>((res) => { r.host.entered = res; });
      const pending = r.land("v6");
      await entered;
      // Another controller on the same records finds the request left running and records it as uncertain.
      const other = WorkspaceOpService.withEpoch(r.store.storage, r.projects.epoch, r.deps(), options);
      const resolved = await other.recover(r.owner);
      assert.equal(resolved.length, 1);
      const text = (await r.ask(r.owner, { taskId: r.task }))!;
      assert.match(text, /1 landing attempt\(s\) on record/);
      assert.match(text, new RegExp(`request ${resolved[0]} made .* ended with an unknown result`));
      assert.match(text, /No check result is recorded for this attempt/);
      assert.ok(!/the project required none/.test(text), text);
      r.host.block = undefined;
      release();
      await pending;
      const after = (await r.ask(r.owner, { projectId: r.project }))!;
      assert.match(after, /project Orchard: 1 landing attempt\(s\) on record/);
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: two landings of one project that finish at the same moment are both recorded and both listed in the project's view (card P09 review)`, async () => {
    const r = await rig(["review"]);
    try {
      const b = await r.another("Signup");
      let release!: () => void;
      r.host.block = new Promise<void>((res) => { release = res; });
      let inside = 0;
      const both = new Promise<void>((res) => { r.host.entered = () => { if (++inside === 2) res(); }; });
      const one = r.land("v7a"), two = b.land("v7b");
      await both;
      release();
      const [x, y] = await Promise.all([one, two]);
      assert.equal(x.state, "done", x.summary);
      assert.equal(y.state, "done", y.summary);
      const text = (await r.ask(r.owner, { projectId: r.project }))!;
      assert.match(text, /project Orchard: 2 landing attempt\(s\) on record/);
      assert.ok(text.includes(x.id) && text.includes(y.id), text);
      assert.match((await r.ask(r.owner, { taskId: b.task }))!, new RegExp(`1 landing attempt\\(s\\) on record[^\\n]*\\n[^\\n]*request ${y.id}`));
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: the task's index keeps the newest 20 and the project's the newest 40, and the view says older ones are not listed (card P09 review)`, async () => {
    const r = await rig(["review"]);
    try {
      const ids: string[] = [];
      for (let i = 0; i < 41; i++) ids.push((await r.land(`v8-${i}`)).id);
      const task = (await r.ask(r.owner, { taskId: r.task }))!;
      assert.match(task, /20 landing attempt\(s\) on record \(only the newest 20 are kept for this view, so any older attempt is not listed\), newest first; showing 1 to 5/);
      assert.ok(task.includes(ids[40]!));
      const lastTask = (await r.ask(r.owner, { taskId: r.task, after: 15 }))!;
      assert.match(lastTask, /showing 16 to 20/);
      assert.ok(lastTask.includes(ids[21]!) && !lastTask.includes(ids[20]!), lastTask);
      assert.ok(!/Older attempts follow/.test(lastTask));
      const project = (await r.ask(r.owner, { projectId: r.project, after: 35 }))!;
      assert.match(project, /40 landing attempt\(s\) on record \(only the newest 40 are kept/);
      assert.match(project, /showing 36 to 40/);
      assert.ok(project.includes(ids[1]!) && !project.includes(ids[0]!), project);
      assert.match(project, /Attempt 40 /);
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: host paths in a test command are hidden in every form (file URL, Windows drive, network, relative above the checkout, mixed separators) while a web address stays (card P09 review)`, async () => {
    const r = await rig(["tests"]);
    try {
      r.host.fail = true;
      // One landing per form, each in a short command name, so the shown name's 60-character cut cannot hide a path that was not replaced.
      const forms: [string, string][] = [["run file:///home/rob/a/b", "/home/rob"], ["run C:\\Users\\rob\\x", "Users"], ["run \\\\srv\\share\\y", "srv\\share"], ["run \\\\?\\C:\\x", "C:"], ["run ../../etc/z", "etc/z"], ["run /home/rob\\q/w", "q/w"], ["run path:/srv/ai/x", "srv/ai"]];
      for (const [k, [name, leak]] of forms.entries()) {
        r.views.commandName = name;
        await r.land(`v9-${k}`);
        const text = (await r.ask(r.owner, { taskId: r.task }))!;
        const newest = text.split("\n").find((l) => l.startsWith("tests failed"))!;
        assert.ok(!newest.includes(leak), `"${leak}" is not shown: ${newest}`);
        assert.match(newest, /Commands: run (?:path:)?\[a path\] failed \(exit 1\)/, newest);
      }
      r.views.commandName = "see https://example.com/doc/page";
      await r.land("v9-url");
      assert.match((await r.ask(r.owner, { taskId: r.task }))!, /Commands: see https:\/\/example\.com\/doc\/page failed/);
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: index entries whose record cannot be read are counted and left out without shifting the numbering or the next page (card P09 review)`, async () => {
    const r = await rig(["review"]);
    try {
      const real = [(await r.land("v10a")), (await r.land("v10b"))];
      const view = StatusService.withEpoch(r.store.storage, r.projects.epoch, { ...r.base, landingChecks: { landings: async (scope, after, limit) => {
        const got = await r.service.landings(scope, 0, 20);
        // The stand-in index: one real attempt, one entry whose record is gone, the other real attempt, then two more gone; a page reports what the service would.
        const index = [got.items[0]!, undefined, got.items[1]!, undefined, undefined, undefined];
        const range = index.slice(after, after + limit);
        const items = range.flatMap((a, i) => a === undefined ? [] : [{ ...a, position: after + i + 1 }]);
        return { items, total: index.length, next: after + range.length, unreadable: range.length - items.length, cap: 20, full: false };
      } } }, options);
      const text = (await view.ask(r.owner, { kind: "landing_checks", taskId: r.task } as never))!.lines.map((l) => l.text).join("\n");
      assert.match(text, /6 landing attempt\(s\) on record, newest first; showing 1 to 5/);
      assert.match(text, /3 of these could not be read as a landing of this task/);
      assert.match(text, new RegExp(`Attempt 1: request ${real[1]!.id}`));
      assert.match(text, new RegExp(`Attempt 3: request ${real[0]!.id}`));
      assert.match(text, /Older attempts follow: ask again with after 5/);
      const tail = (await view.ask(r.owner, { kind: "landing_checks", taskId: r.task, after: 5 } as never))!.lines.map((l) => l.text).join("\n");
      assert.match(tail, /showing 6 to 6/);
      assert.match(tail, /1 of these could not be read/);
    } finally { await r.store.close(); }
  });
  test(`${backend.name}: a landing is recorded even when the project's landing index is changed by others on every try, and an index entry that could only be written on its own still reaches the view (card P09 second review)`, async () => {
    const r = await rig(["review"]);
    try {
      // The project's index is one record shared by every landing of the project: here each write that touches it is refused as changed meanwhile, `refusals` times, as a busy project's other landings would.
      let refusals = Infinity, refused = 0;
      const touches = (input: { changes: readonly { ref: { kind: string } }[] }) => input.changes.some((c) => c.ref.kind === "workspace-landings-project");
      const busy = new Proxy(r.store.storage, { get: (target, prop, recv) => {
        if (prop === "applyOperation") return async (input: Parameters<ControllerStorage["applyOperation"]>[0]) => { if (touches(input) && refused < refusals) { refused++; throw new StorageError("revision_conflict", "the landing index changed meanwhile"); } return target.applyOperation(input); };
        const v = Reflect.get(target, prop, recv) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      } }) as ControllerStorage;
      const service = WorkspaceOpService.withEpoch(busy, r.projects.epoch, r.deps(), options);
      const land = (commandId: string) => service.request(r.owner, { commandId, operation: "landing", taskId: r.task, reason: "ready", submissionId: r.sub });
      const first = await land("v11a");
      assert.equal(first.state, "done", first.summary);
      assert.ok(refused >= 12, `the index was refused ${refused} times`);
      // The outcome is recorded (a repeat answers it); the view, whose index could never be written, lists nothing rather than something false.
      const again = await land("v11a");
      assert.equal(again.state, "done");
      assert.equal(again.id, first.id);
      assert.match((await r.ask(r.owner, { taskId: r.task }))!, /No landing attempt is on record/);
      // Refused only for the tries that carry the index with the outcome: the outcome is written without it, then the index on its own.
      refused = 0; refusals = 12;
      const second = await land("v11b");
      assert.equal(second.state, "done", second.summary);
      assert.equal(refused, 12);
      const text = (await r.ask(r.owner, { projectId: r.project }))!;
      assert.match(text, /1 landing attempt\(s\) on record/);
      assert.ok(text.includes(second.id), text);
      assert.match((await r.ask(r.owner, { taskId: r.task }))!, new RegExp(`Attempt 1: request ${second.id}`));
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: host paths written URL-encoded, with look-alike slashes or led by a home or environment name are hidden, and a credential in a command is cut (card P09 second review)`, async () => {
    const r = await rig(["tests"]);
    try {
      r.host.fail = true;
      const forms: [string, string][] = [["run %2Fhome%2Fr9b%2Fx", "r9b"], ["run %5Csrv%5Cr9b%5Cy", "r9b"], ["run \u2215home\u2215r9b\u2215x", "r9b"], ["run \uff0fhome\uff0fr9b", "r9b"], ["run ~r9b/notes", "r9b"], ["run ~/secret", "secret"], ["run $HOME/.cfg/r9b", "r9b"], ["run ${HOME}/r9b", "r9b"], ["run %USERPROFILE%\\r9b", "r9b"], ["run \"C:\\Users\\r9b\\x\"", "r9b"]];
      for (const [k, [name, leak]] of forms.entries()) {
        r.views.commandName = name;
        await r.land(`v12-${k}`);
        const newest = (await r.ask(r.owner, { taskId: r.task }))!.split("\n").find((l) => l.startsWith("tests failed"))!;
        assert.ok(!newest.includes(leak), `"${leak}" is not shown: ${newest}`);
        assert.match(newest, /\[a path\]/, newest);
      }
      const secret = ["API", "KEY=", "abcd1234", "efgh5678", "ijkl"].join("");
      r.views.commandName = `${secret} npm test`;
      await r.land("v12-key");
      const newest = (await r.ask(r.owner, { taskId: r.task }))!.split("\n").find((l) => l.startsWith("tests failed"))!;
      assert.ok(!newest.includes("abcd1234"), newest);
      assert.match(newest, /\[redacted\] npm test failed/, newest);
      // The record is already cut when the gate writes it; the view cuts again whatever a record holds (one written before that rule, or by another writer): a stand-in record holds the raw text here.
      const got = (await r.service.landings({ taskId: r.task }, 0, 1)).items[0]!;
      const raw = { ...got, summary: `refused near %2Fhome%2Fr9b with ${secret}`, checks: { ...got.checks!, results: got.checks!.results.map((e) => ({ ...e, summary: `see ${secret}`, runs: [{ name: `${secret} /home/r9b/t`, state: "failed" as const, exitCode: 1 }] })) } };
      const view = StatusService.withEpoch(r.store.storage, r.projects.epoch, { ...r.base, landingChecks: { landings: async () => ({ items: [{ ...raw, position: 1 }], total: 1, next: 1, unreadable: 0, cap: 20, full: false }) } }, options);
      const shownText = (await view.ask(r.owner, { kind: "landing_checks", taskId: r.task } as never))!.lines.map((l) => l.text).join("\n");
      assert.ok(!shownText.includes("abcd1234") && !shownText.includes("r9b"), shownText);
      assert.match(shownText, /Commands: \[redacted\] \[a path\] failed \(exit 1\)/, shownText);
    } finally { await r.store.close(); }
  });
}
