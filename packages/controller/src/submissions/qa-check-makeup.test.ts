import assert from "node:assert/strict";
import { after, test } from "node:test";
import { derivedId } from "../domain/ids.js";
import { CommandRunner } from "../domain/runner.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { scopedCommandId } from "../security/credentials.js";
import type { JsonObject } from "../storage/types.js";
import { NotificationService } from "../notifications/index.js";
import { QaEvidenceService } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-11-18T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const tree = "e".repeat(64);

for (const backend of backends) {
  test(`${backend.name}: a repeat of a QA check whose notices were lost sends them again, once per record, and only for the same caller and command (card Q03, eighth slice)`, async () => {
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
      // The controller's side: one notice per notice ID; a port that can be made to fail (the stop between the check's write and its notices).
      const delivered = new Map<string, string>();
      const sends: string[] = [];
      const hookCalls: string[][] = [];
      let down = true;
      const svc = QaEvidenceService.withEpoch(world.storage, projects.epoch, {
        rolesOf: async (id) => roles.get(id) ?? [],
        notify: async (x) => { sends.push(x.commandId); if (down) throw new Error("not delivered"); if (!delivered.has(x.commandId)) delivered.set(x.commandId, x.text); },
        invalidated: async (e) => { hookCalls.push(e.evidence.map((v) => v.evidenceId)); if (down) throw new Error("not run"); },
      }, options);
      const qa = await agent("qa", ["qa"]);
      const sub = derivedId("sbm", cid("sub"));
      await plant("submission", sub, { taskId: task, projectId: project, kind: "code", role: "author", submittedBy: qa.id, submittedAt: "2026-11-18T09:00:00.000Z", makesCommit: true, base: "a".repeat(40), tree, patchId: "c".repeat(40), evidence: [] });
      const contract = (v: number, criteria: string[]) => ({ taskId: task, projectId: project, version: v, changedBy: owner.id, acceptanceCriteria: criteria, priority: 5, budget: {}, workClass: "P", requiredEvidence: [], checks: [{ name: "unit", run: ["true"] }], permissions: [], recovery: "native-continuation" });
      await plant("task-contract", task, contract(1, ["works"]));
      await plant("task-contract-version", `${task}.1`, { ...contract(1, ["works"]), changedAt: "2026-11-18T08:00:00.000Z" });
      const ev = { submissionId: sub, criteriaRevision: 1, decisions: [], environment: "linux", observedAt: "2026-11-18T09:30:00.000Z", checks: [{ name: "unit", result: "passed" }] };
      const first = await svc.record(qa, { commandId: cid("r"), ...ev });
      const second = await svc.record(qa, { commandId: cid("r"), ...ev, environment: "macos" });
      const eve = await agent("eve", ["qa"]);

      // Nothing was invalidated yet: a check finds nothing and sends nothing.
      assert.deepEqual((await svc.check(qa, { commandId: cid("k"), taskId: task })).invalidated, []);
      assert.deepEqual([sends.length, hookCalls.length], [0, 0]);

      // The criteria change; the check writes, and every send after the write fails.
      await plant("task-contract", task, contract(2, ["works", "is fast"]), true);
      await plant("task-contract-version", `${task}.2`, { ...contract(2, ["works", "is fast"]), changedAt: "2026-11-18T09:50:00.000Z" });
      const id = cid("k");
      const k = await svc.check(qa, { commandId: id, taskId: task });
      assert.deepEqual([...k.invalidated].sort(), [first.id, second.id].sort());
      assert.equal(delivered.size, 0, "the notices were lost");
      assert.equal(sends.length, 2);
      const lost = hookCalls.length;

      // Another caller sending the same command ID, or a new command ID, owes nothing (nothing is stale, and this command wrote nothing).
      down = false;
      await svc.check(eve, { commandId: id, taskId: task });
      await svc.check(qa, { commandId: cid("k"), taskId: task });
      assert.deepEqual([delivered.size, hookCalls.length], [0, lost], "only the caller's own command makes up what it owed");

      // The same check sent again makes up the notices, with the text the first run would have sent, and runs the documentation hook for the records.
      const again = await svc.check(qa, { commandId: id, taskId: task });
      assert.deepEqual([again.replayed, again.invalidated, again.rechecks], [false, [], []], "the answer is unchanged: nothing is stale now, nothing new was written");
      assert.deepEqual([...delivered.keys()].sort(), k.rechecks.map((r) => `qa-recheck:${r}`).sort());
      for (const text of delivered.values()) assert.match(text, /^QA evidence qae-[0-9a-z]+ of task .* no longer holds \(.*\): re-check for agent:qa$/s);
      assert.deepEqual(hookCalls.at(-1)?.slice().sort(), [first.id, second.id].sort());

      // A further repeat sends the same IDs again; the controller keeps one notice each.
      await svc.check(qa, { commandId: id, taskId: task });
      assert.equal(delivered.size, 2);

      // A command ID the caller first used for another kind of command is not read as a check's entry, even when that entry's detail names the task and the records.
      const other = cid("k");
      await runner.command("test.other", { commandId: scopedCommandId(qa.id, other), actor: qa.id }, async () => ({ payload: {}, build: async () => ({ ref: { kind: "test-other", id: other }, creates: true, changes: [{ type: "create" as const, ref: { kind: "test-other", id: other }, body: {} }], detail: { taskId: task, invalidated: [first.id, second.id] } }) }));
      delivered.clear();
      const before = hookCalls.length;
      await svc.check(qa, { commandId: other, taskId: task });
      assert.deepEqual([delivered.size, hookCalls.length], [0, before], "only a qa.evidence.check entry is made up");

      // The same command sent again after other evidence went stale meanwhile is a replay of the write (it is not written twice) and still makes up what the first run owed (here the new independent evidence settled the re-checks, so only the hook).
      await svc.record(eve, { commandId: cid("r"), ...ev, criteriaRevision: 2, environment: "windows" });
      await plant("task-contract", task, contract(3, ["works", "is fast", "is small"]), true);
      await plant("task-contract-version", `${task}.3`, { ...contract(3, ["works", "is fast", "is small"]), changedAt: "2026-11-18T09:55:00.000Z" });
      delivered.clear();
      const replay = await svc.check(qa, { commandId: id, taskId: task });
      assert.deepEqual([replay.replayed, replay.invalidated], [true, []]);
      assert.deepEqual(hookCalls.at(-1)?.slice().sort(), [first.id, second.id].sort(), "the documentation hook runs again for the records the first run invalidated");
      assert.equal(delivered.size, 0, "the re-checks the new evidence settled are not announced");

      // A re-check that was settled meanwhile is not announced again; the hook still runs for the record.
      await svc.record(qa, { commandId: cid("r"), ...ev, criteriaRevision: 3 });
      const settled = (await svc.list(owner, task)).rechecks.filter((r) => r.state === "done").length;
      assert.equal(settled, 2);
      delivered.clear();
      const calls = hookCalls.length;
      await svc.check(qa, { commandId: id, taskId: task });
      assert.deepEqual([delivered.size, hookCalls.length], [0, calls + 1]);
    } finally { await world.close(); }
  });

  test(`${backend.name}: the automatic checks make up what a stop after their write lost (the next call has a new command ID), through the controller's notifications, which never bring back a notice the owner cleared (card Q03, eighth slice review)`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P" })).id;
      const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "T" })).id;
      const roles = new Map<string, string[]>();
      const agent = async (nm: string): Promise<Principal> => {
        await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: [{ action: "task.read", project }] });
        const p = await principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
        roles.set(p.id, ["qa"]);
        return p;
      };
      const runner = new CommandRunner(world.storage, projects.epoch, options);
      const plant = async (kind: string, id: string, body: object, update = false): Promise<void> => {
        const found = await runner.get(kind, id);
        await runner.command("test.plant", { commandId: cid("plant"), actor: owner.id }, async () => ({ payload: { kind, id, update }, build: async () => ({ ref: { kind, id }, creates: found === undefined, changes: [found === undefined ? { type: "create" as const, ref: { kind, id }, body: body as JsonObject } : { type: "update" as const, ref: { kind, id }, expectedRevision: found.revision, body: body as JsonObject }], detail: {} }) }));
      };
      // The owner's notices exactly as the controller sends them (api/start.ts); a port that can be made to fail stands for the stop after the write.
      const notifications = NotificationService.withEpoch(world.storage, projects.epoch, options);
      const hookCalls: string[][] = [];
      let down = true;
      const svc = QaEvidenceService.withEpoch(world.storage, projects.epoch, {
        rolesOf: async (id) => roles.get(id) ?? [],
        notify: async (x) => { if (down) throw new Error("not delivered"); await notifications.emitFromController({ commandId: x.commandId, kind: "maintenance", level: "notice", ref: { kind: "qa-recheck", id: x.recheckId }, detail: x.text, projectId: x.projectId }); },
        invalidated: async (e) => { if (down) throw new Error("not run"); hookCalls.push(e.evidence.map((v) => v.evidenceId)); },
      }, options);
      const items = async (recheckId: string): Promise<string[]> => (await world.storage.listAggregates("notification-item", { limit: 1000 }))
        .filter((a) => (a.body as { ref?: { id?: string } }).ref?.id === recheckId).map((a) => (a.body as { state: string }).state);
      const qa = await agent("qa");
      const sub = derivedId("sbm", cid("sub"));
      await plant("submission", sub, { taskId: task, projectId: project, kind: "code", role: "author", submittedBy: "agent:ann", submittedAt: "2026-11-18T09:00:00.000Z", makesCommit: true, base: "a".repeat(40), tree, patchId: "c".repeat(40), evidence: [] });
      const contract = (v: number, criteria: string[]) => ({ taskId: task, projectId: project, version: v, changedBy: owner.id, acceptanceCriteria: criteria, priority: 5, budget: {}, workClass: "P", requiredEvidence: [], checks: [{ name: "unit", run: ["true"] }], permissions: [], recovery: "native-continuation" });
      const setContract = async (v: number, criteria: string[]): Promise<void> => {
        await plant("task-contract", task, contract(v, criteria), v > 1);
        await plant("task-contract-version", `${task}.${v}`, { ...contract(v, criteria), changedAt: `2026-11-18T08:0${v}:00.000Z` });
      };
      await setContract(1, ["works"]);
      const ev = { submissionId: sub, criteriaRevision: 1, decisions: [], environment: "linux", observedAt: "2026-11-18T09:30:00.000Z", checks: [{ name: "unit", result: "passed" }] };
      const rec = await svc.record(qa, { commandId: cid("r"), ...ev });

      // A contract change: the automatic check writes, then everything after the write is lost.
      await setContract(2, ["works", "is fast"]);
      const lost = await svc.contractChanged(task);
      assert.deepEqual(lost.invalidated, [rec.id]);
      const recheck = lost.rechecks[0]!;
      assert.deepEqual([await items(recheck), hookCalls.length], [[], 0], "the follow-ups were lost");

      // The next automatic call (here the decision pass, then a replay of contract.set) has a new command ID, finds nothing stale, and makes up the follow-ups of the check that wrote the index.
      type Index = { ids: string[]; rechecks: string[]; auto?: { id: string; version: number; chunks: number } };
      const indexBody = async (): Promise<Index> => (await runner.get("qa-evidence-index", task))!.body as unknown as Index;
      const left = (await indexBody()).auto;
      assert.deepEqual(left?.chunks, 1);
      down = false;
      assert.deepEqual(await svc.decisionChanged(task), { taskId: task, invalidated: [], rechecks: [] });
      assert.deepEqual([await items(recheck), hookCalls], [["queued"], [[rec.id]]]);
      // Q02 batch fix, third review: a make-up in full removes the marker, so a later automatic call does not run it again.
      assert.equal((await indexBody()).auto, undefined, "the marker is removed once made up");
      assert.deepEqual(await svc.contractChanged(task), { taskId: task, invalidated: [], rechecks: [] });
      assert.deepEqual(await items(recheck), ["queued"], "one notice per re-check");
      assert.equal(hookCalls.length, 1, "no make-up once the marker is removed");

      // A stop between a make-up and the removal leaves the marker (put back here): the next make-up doubles nothing, and a notice the owner cleared (the re-check still pending) is not raised again.
      assert.deepEqual(await notifications.settleFromController({ commandId: cid("settle"), kind: "maintenance", ref: { kind: "qa-recheck", id: recheck }, projectId: project }), { closed: true });
      await plant("qa-evidence-index", task, { ...(await indexBody()), auto: left }, true);
      // A record added since carries the marker over (Q02 batch fix, second review).
      await svc.record(qa, { commandId: cid("r"), ...ev, criteriaRevision: 2, environment: "macos" });
      assert.deepEqual((await indexBody()).auto, left, "a new record keeps the marker");
      await svc.contractChanged(task);
      assert.deepEqual(await items(recheck), ["settled"], "a cleared notice is not raised again");
      assert.deepEqual(hookCalls, [[rec.id], [rec.id]], "a notice the store refuses does not stop the rest of the make-up (the documentation check still runs)");
      assert.equal((await indexBody()).auto, undefined);
      await svc.decisionChanged(task);
      assert.equal(hookCalls.length, 2);

      // The same for a check the decision pass started: lost after its write, made up by the next pass.
      await setContract(3, ["works", "is fast", "is small"]);
      down = true;
      const byDecision = await svc.decisionChanged(task);
      assert.equal(byDecision.invalidated.length, 1, "the record added since");
      down = false;
      await svc.decisionChanged(task);
      assert.deepEqual(hookCalls.at(-1)?.slice().sort(), [...byDecision.invalidated].sort());
      for (const r of byDecision.rechecks) assert.deepEqual(await items(r), ["queued"]);
    } finally { await world.close(); }
  });
}
