import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { CommandRunner } from "../domain/runner.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { relianceIdOf } from "../decisions/records.js";
import { PrincipalService, type Principal } from "../security/index.js";
import type { JsonObject } from "../storage/types.js";
import { QaEvidenceService } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-11-18T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match) assert.match(error.message, match); return true; });
};
const tree = "e".repeat(64);

for (const backend of backends) {
  test(`${backend.name}: QA evidence is bound to tree, criteria and decisions; a changed dependency invalidates it and schedules a re-check (card Q02)`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
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
      const runner = new CommandRunner(world.storage, projects.epoch, options);
      const plant = async (kind: string, id: string, body: object, update = false): Promise<void> => {
        const found = await runner.get(kind, id);
        await runner.command("test.plant", { commandId: cid("plant"), actor: owner.id }, async () => ({ payload: { kind, id, update }, build: async () => ({ ref: { kind, id }, creates: found === undefined, changes: [found === undefined ? { type: "create" as const, ref: { kind, id }, body: body as JsonObject } : { type: "update" as const, ref: { kind, id }, expectedRevision: found.revision, body: body as JsonObject }], detail: {} }) }));
      };
      const notices: string[] = [];
      const svc = QaEvidenceService.withEpoch(world.storage, projects.epoch, { rolesOf: async (id) => roles.get(id) ?? [], notify: async (x) => { notices.push(x.recheckId); } }, options);
      const ann = await agent("ann", ["author"]);
      const qa = await agent("qa", ["qa"]);
      const sub = derivedId("sbm", cid("sub"));
      await plant("submission", sub, { taskId: task, projectId: project, kind: "code", role: "author", submittedBy: ann.id, submittedAt: "2026-11-18T09:00:00.000Z", makesCommit: true, base: "a".repeat(40), tree, patchId: "c".repeat(40), evidence: [] });
      const contract = (v: number, criteria: string[], priority = 5) => ({ taskId: task, projectId: project, version: v, changedBy: owner.id, acceptanceCriteria: criteria, priority, budget: {}, workClass: "P", requiredEvidence: [], checks: [{ name: "unit", run: ["true"] }], permissions: [], recovery: "native-continuation" });
      await plant("task-contract", task, contract(1, ["works"]));
      await plant("task-contract-version", `${task}.1`, { ...contract(1, ["works"]), changedAt: "2026-11-18T08:00:00.000Z" });
      const dec = derivedId("dec", cid("dec"));
      const decision = (state: string) => ({ projectId: project, category: "decision", topic: "db", statement: "s", wording: "w", source: { channel: "direct" }, origin: { principalId: owner.id }, version: 1, state, supersedes: [], recordedAt: "2026-11-18T08:00:00.000Z", contextVersion: 1 });
      await plant("decision", dec, decision("active"));
      await plant("decision-reliance", relianceIdOf(task), { taskId: task, projectId: project, links: [{ id: "l1", subject: { kind: "task", id: task }, decisionId: dec, version: 1, topic: "db", state: "current", linkedBy: owner.id, linkedAt: "2026-11-18T08:00:00.000Z" }], revalidations: 0, followUps: [] });

      const ev = { submissionId: sub, criteriaRevision: 1, decisions: [dec], environment: "linux", observedAt: "2026-11-18T09:30:00.000Z", checks: [{ name: "unit", result: "passed" }] };
      assert.equal((await svc.gate(qa, sub)).verdict, "failed", "no evidence fails");
      await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "eve", grants: [] });
      const eve = await principals.authenticate((await principals.issueCredential(owner, "agent:eve")).token);
      roles.set(eve.id, ["qa"]);
      await refuses("not_found", () => svc.record(eve, { commandId: cid("r"), ...ev }), /task/);
      await refuses("stale_revision", () => svc.record(qa, { commandId: cid("r"), ...ev, criteriaRevision: 2 }));
      const self = await svc.record(ann, { commandId: cid("r"), ...ev });
      assert.equal(self.source, "self");
      assert.equal((await svc.gate(owner, sub)).verdict, "failed", "a self-check never counts");
      const rec = await svc.record(qa, { commandId: "q-one", ...ev, checks: [{ name: "unit", result: "blocked" }, { name: "lint", result: "not-run" }] });
      assert.deepEqual((await svc.gate(owner, sub)).counts, { passed: 0, failed: 0, blocked: 1, notRun: 0, missing: 0 }, "only the required checks are judged; blocked is kept apart");
      const ok = await svc.record(qa, { commandId: "q-two", ...ev });
      assert.equal((await svc.gate(owner, sub)).verdict, "passed");
      void rec;

      // A new priority: nothing stale. New acceptance criteria: stale, invalidated, re-check scheduled and told.
      await plant("task-contract", task, contract(2, ["works"], 9), true);
      await plant("task-contract-version", `${task}.2`, { ...contract(2, ["works"], 9), changedAt: "2026-11-18T09:40:00.000Z" });
      assert.deepEqual((await svc.check(owner, { commandId: cid("k"), taskId: task })).invalidated, []);
      await plant("task-contract", task, contract(3, ["works", "is fast"], 9), true);
      await plant("task-contract-version", `${task}.3`, { ...contract(3, ["works", "is fast"], 9), changedAt: "2026-11-18T09:50:00.000Z" });
      const k = await svc.check(qa, { commandId: cid("k"), taskId: task });
      assert.equal(k.invalidated.length, 3, "every current record of the task that no longer holds, the self-check too");
      assert.deepEqual(notices, k.rechecks);
      assert.equal((await svc.gate(owner, sub)).verdict, "failed");
      const listed = await svc.list(owner, task);
      assert.ok(listed.items.every((i) => i.state === "invalidated"));
      assert.equal(listed.rechecks.filter((r) => r.state === "pending").length, 3);
      const again = await svc.record(qa, { commandId: cid("r"), ...ev, criteriaRevision: 3 });
      assert.deepEqual([again.settled.length, again.open], [3, []], "independent evidence on the submission naming every still-required check settles its re-checks (lint is no longer required)");
      assert.equal((await svc.gate(owner, sub)).verdict, "passed");

      // The decision is superseded: the gate fails and the evidence goes stale.
      await plant("decision", dec, decision("superseded"), true);
      const g = await svc.gate(owner, sub);
      assert.deepEqual([g.verdict, g.stale.some((s) => s.id === again.id && s.reasons[0]!.kind === "decision_superseded")], ["failed", true]);
      await refuses("invalid_command", () => svc.record(qa, { commandId: cid("r"), ...ev, criteriaRevision: 3 }), /superseded|is superseded/);
      assert.equal((await svc.check(owner, { commandId: cid("k"), taskId: task })).invalidated[0], again.id);
      void ok;

      // A task whose contract names no checks: every check named in current independent evidence is judged, so a newer record that leaves a check out does not hide its earlier failure.
      const task2 = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "T2" })).id;
      const sub2 = derivedId("sbm", cid("sub"));
      await plant("submission", sub2, { taskId: task2, projectId: project, kind: "code", role: "author", submittedBy: ann.id, submittedAt: "2026-11-18T09:00:00.000Z", makesCommit: true, base: "a".repeat(40), tree, patchId: "c".repeat(40), evidence: [] });
      const ev2 = { submissionId: sub2, criteriaRevision: 0, environment: "linux", observedAt: "2026-11-18T09:30:00.000Z" };
      const selfOld = await svc.record(ann, { commandId: cid("r"), ...ev2, checks: [{ name: "smoke", result: "passed" }] });
      const both = await svc.record(qa, { commandId: cid("r"), ...ev2, checks: [{ name: "smoke", result: "failed" }, { name: "unit", result: "passed" }] });
      await svc.record(qa, { commandId: cid("r"), ...ev2, checks: [{ name: "unit", result: "passed" }] });
      const g2 = await svc.gate(owner, sub2);
      assert.deepEqual([g2.verdict, g2.reasons, g2.counts.failed, g2.checks.find((c) => c.name === "smoke")?.evidenceId], ["failed", ["check_failed"], 1, both.id], "an earlier failure is not hidden by a newer record that omits the check");
      await svc.record(qa, { commandId: cid("r"), ...ev2, checks: [{ name: "smoke", result: "passed" }] });
      assert.equal((await svc.gate(owner, sub2)).verdict, "passed", "a newer record naming the check decides it");

      // The author's new self-check settles only the re-check of its own self-check; done re-checks stay listed.
      const c2 = { taskId: task2, projectId: project, version: 1, changedBy: owner.id, acceptanceCriteria: ["works"], priority: 5, budget: {}, workClass: "P", requiredEvidence: [], checks: [], permissions: [], recovery: "native-continuation" };
      await plant("task-contract", task2, c2);
      await plant("task-contract-version", `${task2}.1`, { ...c2, changedAt: "2026-11-18T09:40:00.000Z" });
      const k3 = await svc.check(owner, { commandId: cid("k"), taskId: task2 });
      assert.equal(k3.invalidated.length, 4);
      const selfRecheck = derivedId("qrc", selfOld.id);
      const reSelf = await svc.record(ann, { commandId: cid("r"), ...ev2, criteriaRevision: 1, checks: [{ name: "smoke", result: "passed" }] });
      assert.deepEqual(reSelf.settled, [selfRecheck], "the author settles only its own self-check's re-check");
      assert.equal((await svc.gate(owner, sub2)).verdict, "failed", "a self-check still never counts");
      // A re-check must name again what the invalidated record named: smoke alone settles only the record that named smoke alone, and the gate still asks for unit.
      const reQa = await svc.record(qa, { commandId: cid("r"), ...ev2, criteriaRevision: 1, checks: [{ name: "smoke", result: "passed" }] });
      assert.deepEqual([reQa.settled.length, reQa.open.map((o) => o.missing)], [1, [["unit"], ["unit"]]], "a narrower re-check leaves the others open, naming what is missing");
      const narrow = await svc.gate(owner, sub2);
      assert.deepEqual([narrow.verdict, narrow.reasons, narrow.checks.find((c) => c.name === "unit")?.result, narrow.pendingRechecks.length], ["failed", ["check_missing"], "missing", 2], "with no required checks, the gate asks for the checks the invalidated records covered");
      const reUnit = await svc.record(qa, { commandId: cid("r"), ...ev2, criteriaRevision: 1, checks: [{ name: "unit", result: "passed" }] });
      assert.deepEqual([reUnit.settled.length, reUnit.open], [2, []], "with the earlier current record, together they name both checks again");
      const l2 = await svc.list(owner, task2);
      assert.deepEqual([l2.rechecks.length, l2.rechecks.every((r) => r.state === "done")], [4, true], "done re-checks stay listed");

      // A decision the task comes to rely on after the evidence was recorded: the evidence no longer holds, and the check invalidates it naming the decision.
      assert.equal((await svc.gate(owner, sub2)).verdict, "passed");
      const dec2 = derivedId("dec", cid("dec"));
      await plant("decision", dec2, { ...decision("active"), topic: "ui" });
      await plant("decision-reliance", relianceIdOf(task2), { taskId: task2, projectId: project, links: [{ id: "l2", subject: { kind: "task", id: task2 }, decisionId: dec2, version: 1, topic: "ui", state: "current", linkedBy: owner.id, linkedAt: "2026-11-18T09:45:00.000Z" }], revalidations: 0, followUps: [] });
      const g3 = await svc.gate(owner, sub2);
      assert.deepEqual([g3.verdict, g3.reasons, g3.stale.find((s) => s.id === reQa.id)?.reasons, g3.counts.missing], ["failed", ["stale_evidence", "check_missing"], [{ kind: "decision_not_cited", decisionId: dec2 }], 2], "evidence that did not cite a decision the task now relies on does not count");
      const k4 = await svc.check(owner, { commandId: cid("k"), taskId: task2 });
      assert.deepEqual(k4.invalidated, [reSelf.id, reQa.id, reUnit.id], "the self-check too");
      assert.deepEqual((await svc.get(owner, derivedId("qrc", reQa.id)))?.["reasons"], [{ kind: "decision_not_cited", decisionId: dec2 }]);
      await refuses("invalid_command", () => svc.record(qa, { commandId: cid("r"), ...ev2, criteriaRevision: 1, checks: [{ name: "smoke", result: "passed" }] }), /relies on decision/);
      // Only decisions of the task or its project are cited.
      const elsewhere = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "Q" })).id;
      const decFar = derivedId("dec", cid("dec"));
      await plant("decision", decFar, { ...decision("active"), projectId: elsewhere });
      await refuses("invalid_command", () => svc.record(qa, { commandId: cid("r"), ...ev2, criteriaRevision: 1, decisions: [dec2, decFar], checks: [{ name: "smoke", result: "passed" }] }), /not a decision of this task or its project/);
      const decOtherTask = derivedId("dec", cid("dec"));
      await plant("decision", decOtherTask, { ...decision("active"), taskId: task });
      await refuses("invalid_command", () => svc.record(qa, { commandId: cid("r"), ...ev2, criteriaRevision: 1, decisions: [dec2, decOtherTask], checks: [{ name: "smoke", result: "passed" }] }), /not a decision of this task or its project/);
      assert.equal((await svc.record(qa, { commandId: cid("r"), ...ev2, criteriaRevision: 1, decisions: [dec2], checks: [{ name: "smoke", result: "passed" }] })).source, "independent");
      assert.deepEqual((await svc.gate(owner, sub2)).reasons, ["check_missing"], "unit is still owed to the pending re-check");
      await svc.record(qa, { commandId: cid("r"), ...ev2, criteriaRevision: 1, decisions: [dec2], checks: [{ name: "unit", result: "passed" }] });
      assert.equal((await svc.gate(owner, sub2)).verdict, "passed");

      // A submission of a task the caller may not read is not found, whatever its kind; a reader learns it is not a code submission.
      const review = derivedId("sbm", cid("sub"));
      await plant("submission", review, { taskId: task2, projectId: project, kind: "review", role: "reviewer", submittedBy: qa.id, submittedAt: "2026-11-18T09:00:00.000Z", makesCommit: false, subject: sub2, verdict: "approve", evidence: [] });
      await refuses("not_found", () => svc.gate(eve, review));
      await refuses("not_found", () => svc.record(eve, { commandId: cid("r"), ...ev2, submissionId: review, checks: [{ name: "smoke", result: "passed" }] }));
      await refuses("invalid_command", () => svc.gate(owner, review), /code submission/);
    } finally { await world.close(); }
  });

  test(`${backend.name}: a newer tree settles the re-checks of older code; a check that loses a race answers with what the winner invalidated (card Q02 follow-ups)`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
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
      const runner = new CommandRunner(world.storage, projects.epoch, options);
      const plant = async (kind: string, id: string, body: object): Promise<void> => {
        const found = await runner.get(kind, id);
        await runner.command("test.plant", { commandId: cid("plant"), actor: owner.id }, async () => ({ payload: { kind, id }, build: async () => ({ ref: { kind, id }, creates: found === undefined, changes: [found === undefined ? { type: "create" as const, ref: { kind, id }, body: body as JsonObject } : { type: "update" as const, ref: { kind, id }, expectedRevision: found.revision, body: body as JsonObject }], detail: {} }) }));
      };
      // A storage that, once armed, lets a second check run to its end just before the first one reads its own record (the build sees nothing stale) or commits (its write loses the race).
      let armed: { at: "read" | "commit"; run: () => Promise<unknown> } | undefined;
      const fire = async (): Promise<void> => { const a = armed; armed = undefined; if (a !== undefined) await a.run(); };
      const racing = new Proxy(world.storage, { get(target, prop) {
        const v = Reflect.get(target, prop, target) as unknown;
        if (prop === "getOperation") return async (...args: unknown[]) => { if (armed?.at === "read") await fire(); return (v as (...a: unknown[]) => unknown).apply(target, args); };
        if (prop === "applyOperation") return async (input: { audit: { type: string }[] }) => { if (armed?.at === "commit" && input.audit[0]?.type === "qa.evidence.check") await fire(); return (v as (i: unknown) => unknown).call(target, input); };
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      } });
      const notices: string[] = [];
      const ports = { rolesOf: async (id: string) => roles.get(id) ?? [], notify: async (x: { recheckId: string }) => { notices.push(x.recheckId); } };
      const svc = QaEvidenceService.withEpoch(world.storage, projects.epoch, ports, options);
      const loser = QaEvidenceService.withEpoch(racing, projects.epoch, ports, options);
      const ann = await agent("ann", ["author"]);
      const qa = await agent("qa", ["qa"]);
      const code = async (at: string, t: string): Promise<string> => {
        const id = derivedId("sbm", cid("sub"));
        await plant("submission", id, { taskId: task, projectId: project, kind: "code", role: "author", submittedBy: ann.id, submittedAt: at, makesCommit: true, base: "a".repeat(40), tree: t, patchId: "c".repeat(40), evidence: [] });
        return id;
      };
      const contract = (v: number, criteria: string[], checks: string[]) => ({ taskId: task, projectId: project, version: v, changedBy: owner.id, acceptanceCriteria: criteria, priority: 5, budget: {}, workClass: "P", requiredEvidence: [], checks: checks.map((name) => ({ name, run: ["true"] })), permissions: [], recovery: "native-continuation" });
      const setContract = async (v: number, criteria: string[], checks: string[] = []): Promise<void> => { await plant("task-contract", task, contract(v, criteria, checks)); await plant("task-contract-version", `${task}.${v}`, { ...contract(v, criteria, checks), changedAt: "2026-11-18T08:00:00.000Z" }); };
      const ev = (submissionId: string, v: number) => ({ submissionId, criteriaRevision: v, environment: "linux", observedAt: "2026-11-18T09:30:00.000Z", checks: [{ name: "smoke", result: "passed" }] });

      // Two checks of the same task at the same moment, the winner committing first: the loser answers with what the winner invalidated, and the owner is told once.
      await setContract(1, ["works"]);
      const old = await code("2026-11-18T09:00:00.000Z", "e".repeat(64));
      const first = await svc.record(qa, { commandId: cid("r"), ...ev(old, 1) });
      const self = await svc.record(ann, { commandId: cid("r"), ...ev(old, 1) });
      await setContract(2, ["works", "is fast"]);
      let won: Awaited<ReturnType<QaEvidenceService["check"]>> | undefined;
      armed = { at: "commit", run: async () => { won = await svc.check(owner, { commandId: cid("k"), taskId: task }); } };
      const lost = await loser.check(qa, { commandId: cid("k"), taskId: task });
      assert.deepEqual(won?.invalidated, [first.id, self.id]);
      assert.deepEqual([lost.invalidated, lost.rechecks, lost.concurrent, lost.replayed], [won!.invalidated, won!.rechecks, true, false], "the check that lost at commit answers from the winner's result");
      assert.deepEqual(notices, won!.rechecks, "the owner is told once, by the winner");
      const rechecks = won!.rechecks;

      // The same with the winner done before the loser's write is built.
      const second = await svc.record(qa, { commandId: cid("r"), ...ev(old, 2), checks: [{ name: "perf", result: "passed" }] });
      assert.deepEqual([second.settled, second.open.length], [[], 2], "perf alone names neither re-check's smoke again");
      await setContract(3, ["works", "is fast", "is small"]);
      armed = { at: "read", run: async () => { won = await svc.check(owner, { commandId: cid("k"), taskId: task }); } };
      const lost2 = await loser.check(qa, { commandId: cid("k"), taskId: task });
      assert.deepEqual([won?.invalidated, lost2.invalidated, lost2.concurrent], [[second.id], [second.id], true], "the check that found nothing left to write answers from the winner's result");
      assert.equal((await svc.check(qa, { commandId: cid("k"), taskId: task })).invalidated.length, 0, "a later check finds nothing");

      // The author submits a newer tree: every pending re-check of the older code is settled by it (the new tree has no evidence, so its gate fails).
      const pendingOld = (await svc.list(owner, task)).rechecks.filter((r) => r.state === "pending").map((r) => r.id).sort();
      assert.deepEqual(pendingOld, [...rechecks, derivedId("qrc", second.id)].sort());
      const newer = await code("2026-11-18T09:20:00.000Z", "f".repeat(64));
      assert.deepEqual((await svc.submitted(old)).settled, [], "the older submission settles nothing");
      const sup = await svc.submitted(newer);
      assert.deepEqual([...sup.settled].sort(), pendingOld);
      const done = await svc.get(owner, pendingOld[0]!);
      assert.deepEqual([done?.["state"], done?.["supersededBy"], done?.["doneBy"]], ["done", newer, undefined]);
      assert.deepEqual((await svc.submitted(newer)).settled, [], "repeatable: nothing is left");
      const ng = await svc.gate(owner, newer);
      assert.deepEqual([ng.verdict, ng.reasons, ng.pendingRechecks], ["failed", ["no_evidence"], []], "the newer tree is judged on its own evidence");

      // A missed call is caught by the next evidence on a newer tree; a re-check on the newer tree is not settled by older code.
      const onNewer = await svc.record(qa, { commandId: cid("r"), ...ev(newer, 3) });
      await setContract(4, ["works"]);
      const k = await svc.check(owner, { commandId: cid("k"), taskId: task });
      assert.deepEqual(k.invalidated, [onNewer.id]);
      assert.deepEqual((await svc.submitted(old)).settled, [], "older code does not settle a newer tree's re-check");
      const newest = await code("2026-11-18T09:40:00.000Z", "d".repeat(64));
      const caught = await svc.record(qa, { commandId: cid("r"), ...ev(newest, 4) });
      assert.deepEqual(caught.settled, k.rechecks, "evidence on a newer tree settles the older tree's re-check when the submission's own call was missed");
      assert.equal((await svc.get(owner, k.rechecks[0]!))?.["supersededBy"], newest);
      assert.equal((await svc.gate(owner, newest)).verdict, "passed");

      // A check left out of a re-check because the contract no longer required it is not owed again later, once that re-check is done.
      await setContract(5, ["works", "v5"], ["smoke"]);
      await svc.check(owner, { commandId: cid("k"), taskId: task });
      const wide = await svc.record(qa, { commandId: cid("r"), ...ev(newest, 5), checks: [{ name: "smoke", result: "passed" }, { name: "lint", result: "passed" }] });
      await setContract(6, ["works", "v6"], ["smoke"]);
      await svc.check(owner, { commandId: cid("k"), taskId: task });
      const narrowOk = await svc.record(qa, { commandId: cid("r"), ...ev(newest, 6) });
      assert.deepEqual([narrowOk.settled, narrowOk.open], [[derivedId("qrc", wide.id)], []], "lint is not required, so smoke alone settles it");
      await setContract(7, ["works", "v7"]);
      await svc.check(owner, { commandId: cid("k"), taskId: task });
      assert.equal((await svc.record(qa, { commandId: cid("r"), ...ev(newest, 7) })).settled.length, 1);
      const g7 = await svc.gate(owner, newest);
      assert.deepEqual([g7.verdict, g7.checks.map((c) => c.name)], ["passed", ["smoke"]], "only checks of evidence still awaiting its re-check are owed");
    } finally { await world.close(); }
  });
}
