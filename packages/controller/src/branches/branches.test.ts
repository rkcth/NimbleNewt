import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DeskService, HistoryService, RetrievalService, type SourceRef } from "../context/index.js";
import { ContinuationService, type ContinuationInput } from "../continuation/index.js";
import { AssignmentService } from "../domain/assignments.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { WaitService } from "../domain/waits.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { InquiryService } from "../inquiries/index.js";
import { PrincipalService, type Grant, type Principal } from "../security/index.js";
import { ContextBranchService } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-10-22T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};

for (const backend of backends) {
  interface Ctx {
    owner: Principal; a: string; b: string; task: string; urgent: string; child: string; branches: ContextBranchService; reopen(): ContextBranchService;
    histories: HistoryService; desks: DeskService; assignments: AssignmentService; projects: ProjectService; continuations: ContinuationService; inquiries: InquiryService;
    ann: Principal; ben: Principal; eve: Principal; cat: Principal; agent(name: string, grants: Grant[]): Promise<Principal>;
  }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const agent = async (nm: string, grants: Grant[]) => {
          await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants });
          return principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
        };
        const a = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "A" })).id;
        const b = (await projects.createProject({ commandId: cid("pb"), actor: "owner:rob", name: "B" })).id;
        const mk = async (title: string, project = a) => (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: project, title })).id;
        const task = await mk("the task");
        const urgent = await mk("urgent task");
        const child = await mk("child task");
        await projects.transitionTask({ commandId: cid("tr"), actor: "owner:rob", taskId: task, expectedRevision: 1, to: "ready" });
        const assignments = AssignmentService.withEpoch(world.storage, projects.epoch, projects, options);
        await assignments.assignTask({ commandId: cid("as"), actor: "owner:rob", taskId: task, owner: { kind: "agent", id: "ann" } });
        const histories = HistoryService.withEpoch(world.storage, projects.epoch, options);
        const desks = DeskService.withEpoch(world.storage, projects.epoch, options);
        const retrieval = RetrievalService.withEpoch(world.storage, projects.epoch, desks, histories, options);
        const waits = WaitService.withEpoch(world.storage, projects.epoch, assignments, options);
        const inquiries = InquiryService.withEpoch(world.storage, projects.epoch, { histories, retrieval, waits, assignments }, options);
        const continuations = ContinuationService.withEpoch(world.storage, projects.epoch, options);
        const make = () => ContextBranchService.withEpoch(world.storage, projects.epoch, { histories, retrieval }, options);
        const rights = (p: string): Grant[] => [{ action: "history.*", project: p }, { action: "desk.write", project: p }, { action: "desk.read", project: p }];
        const ann = await agent("ann", [...rights(a), { action: "attempt.work", project: a }]);
        const ben = await agent("ben", [...rights(a), { action: "attempt.work", project: a }]);
        const eve = await agent("eve", [...rights(b), { action: "attempt.work", project: b }]);
        // cat works on the child task only and cannot read the task's history.
        const cat = await agent("cat", [{ action: "attempt.work", project: a }, { action: "desk.read", project: a }, { action: "history.append", project: a }]);
        await body({ owner, a, b, task, urgent, child, branches: make(), reopen: make, histories, desks, assignments, projects, continuations, inquiries, ann, ben, eve, cat, agent });
      } finally { await world.close(); }
    });
  const say = (histories: HistoryService, p: Principal, task: string, text: string) => histories.append(p, HistoryService.taskScopeId(task), { commandId: cid("say"), text, taskId: task });
  const open = (svc: ContextBranchService, p: Principal, taskId: string, extra: Record<string, unknown> = {}) => svc.open(p, { commandId: cid("open"), taskId, purpose: "how is it going?", ...extra } as never);
  const texts = (r: { entries: readonly { text: string }[] } | undefined): string[] => (r?.entries ?? []).map((e) => e.text);
  const collect = async (svc: ContextBranchService, p: Principal, id: string) => {
    const v = (await svc.view(p, id))!;
    return JSON.stringify({ parent: texts(await svc.history(p, id, { part: "parent", limit: 200 })), branch: texts(await svc.history(p, id, { part: "branch", limit: 200 })), updates: v.updates.map((u) => [u.revision, u.text]), counts: v.counts });
  };

  suite("a status question gets the permitted current context and leaves the parent exactly as it was", async ({ branches, histories, desks, assignments, task, ann, ben, owner, a }) => {
    await say(histories, ann, task, "chose PostgreSQL");
    await say(histories, ann, task, "migration half done");
    const note = await desks.write(ann, { commandId: cid("w"), projectId: a, kind: "note", title: "N", body: "shared note", visibility: "shared", status: "accepted" });
    const parentBefore = JSON.stringify([await histories.read(owner, HistoryService.taskScopeId(task), { limit: 50, taskId: task }), await assignments.getAssignment(task), await desks.read(owner, note.id)]);
    const opened = await open(branches, ann, task);
    assert.equal(opened.throughSeq, 2);
    // The status question and its answer are the branch's own entries.
    await branches.append(ann, { commandId: cid("q"), branchId: opened.id, text: "status?" });
    await branches.append(ann, { commandId: cid("r"), branchId: opened.id, text: "half done" });
    assert.deepEqual(texts(await branches.history(ann, opened.id, { part: "parent", limit: 50 })), ["chose PostgreSQL", "migration half done"]);
    assert.deepEqual(texts(await branches.history(ann, opened.id, { part: "branch", limit: 50 })), ["status?", "half done"]);
    const parentAfter = JSON.stringify([await histories.read(owner, HistoryService.taskScopeId(task), { limit: 50, taskId: task }), await assignments.getAssignment(task), await desks.read(owner, note.id)]);
    assert.equal(parentAfter, parentBefore, "the parent's history, assignment and records are exactly as they were");
    // Permitted current context: a viewer who cannot read the task's history sees none of it; others cannot see the branch at all.
    assert.equal(await branches.view(ben, opened.id), undefined);
    assert.equal(await branches.history(ben, opened.id, { part: "parent", limit: 5 }), undefined);
    assert.ok(await branches.view(owner, opened.id));
    const noHistory = (await branches.history(owner, opened.id, { part: "parent", limit: 5 }))!;
    assert.equal(noHistory.entries.length, 2, "the owner reads all of it");
    // (a) An owner who may work on the task but no longer reads histories sees an empty page, not an error and not entries.
    const lowered: Principal = { ...ann, grants: ann.grants.filter((g) => g.action === "attempt.work") };
    assert.ok(await branches.view(lowered, opened.id));
    assert.deepEqual(await branches.history(lowered, opened.id, { part: "parent", limit: 5 }), { part: "parent", entries: [] });
    assert.deepEqual(await branches.history(lowered, opened.id, { part: "branch", limit: 5 }), { part: "branch", entries: [] });
    // (b) An applied update that the owner can no longer read shows as unavailable, without text (the record was written by ben; ann reads it only through desk.read).
    const theirs = await desks.write(ben, { commandId: cid("w"), projectId: a, kind: "note", title: "Theirs", body: "ben's shared note", visibility: "shared", status: "accepted" });
    await branches.applyUpdates(ann, { commandId: cid("u"), branchId: opened.id, expectedRevision: (await branches.view(ann, opened.id))!.branch.revision, updates: [{ kind: "desk-record", id: theirs.id }] });
    assert.equal((await branches.view(ann, opened.id))!.updates[0]!.text, "ben's shared note");
    const noDesk: Principal = { ...ann, grants: ann.grants.filter((g) => g.action === "attempt.work") };
    const gone = (await branches.view(noDesk, opened.id))!.updates[0]!;
    assert.deepEqual([gone.state, gone.text], ["unavailable", undefined]);
    // A revoked right to work on the task ends the viewing as well.
    const revoked: Principal = { ...ann, grants: ann.grants.filter((g) => g.action !== "attempt.work") };
    assert.equal(await branches.view(revoked, opened.id), undefined);
    assert.equal((await branches.pendingReturns(revoked)).items.length, 0);
  });

  suite("open: refusals, continuation and inquiry links, restart, repeat", async ({ branches, reopen, continuations, inquiries, histories, task, urgent, a, b, owner, ann, ben, eve }) => {
    const id = cid("o");
    const first = await branches.open(ann, { commandId: id, taskId: task, purpose: "assess" });
    const again = await branches.open(ann, { commandId: id, taskId: task, purpose: "assess" });
    assert.deepEqual([again.id, again.replayed], [first.id, true]);
    await refuses("command_conflict", () => branches.open(ann, { commandId: id, taskId: task, purpose: "something else" }));
    assert.equal((await reopen().view(ann, first.id))!.branch.purpose, "assess", "a restarted service finds it");
    await refuses("forbidden", () => open(branches, eve, task));
    await refuses("invalid_command", () => open(branches, ann, task, { purpose: "token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH" }));
    await refuses("invalid_command", () => open(branches, ann, task, { returnTo: { taskId: "task-aaaaaaaaaaaaaaaaaaaa" } }));
    await refuses("invalid_command", () => open(branches, ann, task, { surprise: 1 }));
    await refuses("invalid_command", () => open(branches, ann, task, { continuationId: "cnt-aaaaaaaaaaaaaaaaaaaa" }), (e) => assert.equal(e.field, "continuationId"));
    const cap = await continuations.capture(owner, {
      commandId: cid("cap"), taskId: task, identity: "conv-1", agent: "agent:ann", boundary: { kind: "turn-complete" },
      checkpoint: { conversationId: 3, at: 7, digest: "v1:sha256:" + "a".repeat(64), runtime: { name: "pi", version: "1.3.0" }, format: 1 }, durable: { verified: true },
      continuation: { artifacts: [], decisions: [], pendingEffects: [], budget: { spent: 1, remaining: 9, unit: "k" }, nextStep: "continue" },
      manifest: { summaryLineage: [], sourceRanges: [], compression: { state: "none", compactions: 0 }, branches: [], messageCursor: 1, routingRevision: 1, environmentRevision: 1, adapter: { name: "pi", version: "1" } },
      nonCheckpointableTools: [], scratchRecords: [], credentialRefs: [],
    } satisfies ContinuationInput & { commandId: string; taskId: string });
    const withCap = await open(branches, ann, task, { continuationId: cap.id });
    assert.equal((await branches.view(ann, withCap.id))!.branch.parent.identity, "conv-1");
    await refuses("invalid_command", () => open(branches, ann, urgent, { continuationId: cap.id }), (e) => assert.equal(e.field, "continuationId"));
    const q = await inquiries.ask(ann, { commandId: cid("ask"), taskId: task, to: "agent:ben", question: "How far along?" });
    assert.equal((await branches.view(ann, (await open(branches, ann, task, { inquiryId: q.id })).id))!.branch.inquiryId, q.id);
    await refuses("invalid_command", () => open(branches, ben, urgent, { inquiryId: q.id }), (e) => assert.equal(e.field, "inquiryId"));
    void a; void b;
  });

  suite("selected updates are applied once, revisioned, and the rest of the parent's later history stays out", async ({ branches, histories, desks, task, ann, ben, eve, owner, a, b }) => {
    await say(histories, ann, task, "before the branch");
    const opened = await open(branches, ann, task);
    await say(histories, ann, task, "after the branch: new decision");
    await say(histories, ann, task, "after the branch: unrelated chatter");
    assert.deepEqual(texts(await branches.history(ann, opened.id, { part: "parent", limit: 50 })), ["before the branch"], "later parent entries are not in the branch");
    const rec = await desks.write(ann, { commandId: cid("w"), projectId: a, kind: "note", title: "Plan", body: "version one", visibility: "shared", status: "accepted" });
    const decision: SourceRef = { kind: "history-entry", scopeId: HistoryService.taskScopeId(task), seq: 2 };
    const note: SourceRef = { kind: "desk-record", id: rec.id };
    let rev = (await branches.view(ann, opened.id))!.branch.revision;
    const cmd = cid("upd");
    const rev0 = rev;
    const one = await branches.applyUpdates(ann, { commandId: cmd, branchId: opened.id, expectedRevision: rev, updates: [decision, note] });
    assert.equal(one.replayed, false);
    const v1 = (await branches.view(ann, opened.id))!;
    assert.deepEqual([v1.branch.updateRevision, v1.updates.map((u) => [u.revision, u.state, u.text])], [1, [[1, "current", "after the branch: new decision"], [1, "current", "version one"]]]);
    // The same command again is the recorded result; nothing is applied twice.
    const replay = await branches.applyUpdates(ann, { commandId: cmd, branchId: opened.id, expectedRevision: rev, updates: [decision, note] });
    assert.deepEqual([replay.replayed, replay.revision], [true, one.revision]);
    assert.equal((await branches.view(ann, opened.id))!.updates.length, 2);
    // A new command for the same content applies nothing new and is refused; the unchosen entry never appears.
    rev = v1.branch.revision;
    await refuses("invalid_command", () => branches.applyUpdates(ann, { commandId: cid("upd"), branchId: opened.id, expectedRevision: rev, updates: [decision] }), (e) => assert.equal(e.field, "updates"));
    assert.ok(!JSON.stringify((await branches.view(ann, opened.id))!.updates).includes("chatter"));
    // A stale revision is refused.
    await refuses("stale_revision", () => branches.applyUpdates(ann, { commandId: cid("upd"), branchId: opened.id, expectedRevision: rev - 1 || 99, updates: [decision] }));
    // A changed original may be applied again, as a new revision; the earlier application stays on record and the viewer sees the original has changed.
    await desks.write(ann, { commandId: cid("w"), projectId: a, kind: "note", title: "Plan", body: "version two", visibility: "shared", status: "accepted", supersedes: rec.id });
    assert.equal((await branches.view(ann, opened.id))!.updates[1]!.state, "changed");
    // Retrying the first command after the original changed is still the recorded result, not a conflict.
    assert.equal((await branches.applyUpdates(ann, { commandId: cmd, branchId: opened.id, expectedRevision: rev0, updates: [decision, note] })).replayed, true);
    await branches.applyUpdates(ann, { commandId: cid("upd"), branchId: opened.id, expectedRevision: rev, updates: [note] });
    const v2 = (await branches.view(ann, opened.id))!;
    assert.deepEqual([v2.branch.updateRevision, v2.branch.applied.map((u) => u.revision)], [2, [1, 1, 2]]);
    // Already part of the branch, unreadable, in another project, and malformed selections are refused.
    const frozen: SourceRef = { kind: "history-entry", scopeId: HistoryService.taskScopeId(task), seq: 1 };
    await refuses("invalid_command", () => branches.applyUpdates(ann, { commandId: cid("upd"), branchId: opened.id, expectedRevision: v2.branch.revision, updates: [frozen] }), (e) => assert.match(e.field ?? "", /updates\[0\]/));
    await refuses("invalid_command", () => branches.applyUpdates(ann, { commandId: cid("upd"), branchId: opened.id, expectedRevision: v2.branch.revision, updates: [{ kind: "desk-record", id: "dsk-aaaaaaaaaaaaaaaaaaaa" }] }));
    const other = await desks.write(eve, { commandId: cid("w"), projectId: b, kind: "note", title: "x", body: "project B", visibility: "shared", status: "accepted" });
    await refuses("invalid_command", () => branches.applyUpdates(ann, { commandId: cid("upd"), branchId: opened.id, expectedRevision: v2.branch.revision, updates: [{ kind: "desk-record", id: other.id }] }));
    await refuses("invalid_command", () => branches.applyUpdates(ann, { commandId: cid("upd"), branchId: opened.id, expectedRevision: v2.branch.revision, updates: [] }));
    await refuses("forbidden", () => branches.applyUpdates(ben, { commandId: cid("upd"), branchId: opened.id, expectedRevision: v2.branch.revision, updates: [note] }));
    void owner;
  });

  suite("two applications at once cannot both take effect on one revision", async ({ branches, desks, task, ann, a }) => {
    const opened = await open(branches, ann, task);
    const r1 = await desks.write(ann, { commandId: cid("w"), projectId: a, kind: "note", title: "1", body: "one", visibility: "shared", status: "accepted" });
    const r2 = await desks.write(ann, { commandId: cid("w"), projectId: a, kind: "note", title: "2", body: "two", visibility: "shared", status: "accepted" });
    const rev = (await branches.view(ann, opened.id))!.branch.revision;
    const results = await Promise.allSettled([
      branches.applyUpdates(ann, { commandId: cid("u"), branchId: opened.id, expectedRevision: rev, updates: [{ kind: "desk-record", id: r1.id }] }),
      branches.applyUpdates(ann, { commandId: cid("u"), branchId: opened.id, expectedRevision: rev, updates: [{ kind: "desk-record", id: r2.id }] }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.equal((lost.reason as DomainError).code, "stale_revision");
    assert.equal((await branches.view(ann, opened.id))!.branch.updateRevision, 1);
  });

  suite("suspend, switch and restore keep exactly the available history, across a restart and a newer task", async ({ branches, reopen, histories, desks, task, urgent, ann, a }) => {
    await say(histories, ann, task, "parent one");
    const first = await open(branches, ann, task);
    const rec = await desks.write(ann, { commandId: cid("w"), projectId: a, kind: "note", title: "P", body: "selected", visibility: "shared", status: "accepted" });
    await branches.append(ann, { commandId: cid("b"), branchId: first.id, text: "branch one" });
    let rev = (await branches.view(ann, first.id))!.branch.revision;
    await branches.applyUpdates(ann, { commandId: cid("u"), branchId: first.id, expectedRevision: rev, updates: [{ kind: "desk-record", id: rec.id }] });
    const before = await collect(branches, ann, first.id);
    rev = (await branches.view(ann, first.id))!.branch.revision;
    const second = await open(branches, ann, urgent, { purpose: "urgent detour" });
    await refuses("invalid_command", () => branches.switch(ann, { commandId: cid("sw"), suspend: { branchId: first.id, expectedRevision: rev, reason: "urgent task arrived" }, restore: { branchId: second.id, expectedRevision: 1 } }));
    assert.equal((await branches.view(ann, first.id))!.branch.state, "active", "the refused switch suspended nothing");
    // Suspend the first alone, then work elsewhere: the parent grows, the record is revised, the other branch is used.
    await branches.suspend(ann, { commandId: cid("s"), branchId: first.id, expectedRevision: rev, reason: "urgent task arrived" });
    const suspended = (await branches.view(ann, first.id))!;
    assert.equal(suspended.branch.state, "suspended");
    await refuses("invalid_command", () => branches.append(ann, { commandId: cid("b"), branchId: first.id, text: "not now" }));
    await refuses("invalid_command", () => branches.applyUpdates(ann, { commandId: cid("u"), branchId: first.id, expectedRevision: suspended.branch.revision, updates: [{ kind: "desk-record", id: rec.id }] }));
    await say(histories, ann, task, "parent two, written while suspended");
    await desks.write(ann, { commandId: cid("w"), projectId: a, kind: "note", title: "P2", body: "selected, revised", visibility: "shared", status: "accepted", supersedes: rec.id });
    await branches.append(ann, { commandId: cid("b"), branchId: second.id, text: "urgent work" });
    // Switch back from the urgent branch to the first in one step (the restart does not matter).
    const svc = reopen();
    const secondRev = (await svc.view(ann, second.id))!.branch.revision;
    await refuses("stale_revision", () => svc.switch(ann, { commandId: cid("sw"), suspend: { branchId: second.id, expectedRevision: secondRev + 5, reason: "done" }, restore: { branchId: first.id, expectedRevision: suspended.branch.revision } }));
    assert.equal((await svc.view(ann, first.id))!.branch.state, "suspended", "a refused switch changes neither branch");
    assert.equal((await svc.view(ann, second.id))!.branch.state, "active");
    const sw = cid("sw");
    await svc.switch(ann, { commandId: sw, suspend: { branchId: second.id, expectedRevision: secondRev, reason: "back to the first" }, restore: { branchId: first.id, expectedRevision: suspended.branch.revision } });
    await svc.switch(ann, { commandId: sw, suspend: { branchId: second.id, expectedRevision: secondRev, reason: "back to the first" }, restore: { branchId: first.id, expectedRevision: suspended.branch.revision } });
    const restored = (await svc.view(ann, first.id))!;
    assert.deepEqual([restored.branch.state, restored.branch.restored?.exact, restored.branch.restored?.extraEntries, (await svc.view(ann, second.id))!.branch.state], ["active", true, 0, "suspended"]);
    assert.equal(await collect(svc, ann, first.id), before, "exactly the history that was available before");
    await refuses("invalid_command", () => svc.restore(ann, { commandId: cid("rs"), branchId: first.id, expectedRevision: restored.branch.revision }), (e) => assert.equal(e.field, "branchId"));
    await refuses("invalid_command", async () => svc.suspend(ann, { commandId: cid("s"), branchId: second.id, expectedRevision: (await svc.view(ann, second.id))!.branch.revision, reason: "again" }));
    // Something written to the branch's history by another writer while suspended is reported, not hidden.
    const r2 = (await svc.view(ann, second.id))!.branch.revision;
    await svc.restore(ann, { commandId: cid("rs"), branchId: second.id, expectedRevision: r2 });
    assert.equal((await svc.view(ann, second.id))!.branch.restored?.exact, true);
  });

  suite("a writer's entry during suspension is reported on restore", async ({ branches, histories, task, ann, ben, owner }) => {
    const first = await open(branches, ann, task);
    const v = (await branches.view(ann, first.id))!;
    await branches.suspend(ann, { commandId: cid("s"), branchId: first.id, expectedRevision: v.branch.revision, reason: "pause" });
    await histories.append(owner, v.branch.scopeId, { commandId: cid("x"), text: "owner wrote meanwhile" });
    const s = (await branches.view(ann, first.id))!;
    await branches.restore(ann, { commandId: cid("rs"), branchId: first.id, expectedRevision: s.branch.revision });
    const r = (await branches.view(ann, first.id))!.branch.restored!;
    assert.deepEqual([r.exact, r.extraEntries], [false, 1]);
    void ben;
  });

  suite("the return destination persists through a newer urgent task until it is resumed or explicitly changed", async ({ branches, reopen, task, urgent, child, ann, ben, owner }) => {
    const first = await open(branches, ann, task, { returnTo: { taskId: task, note: "back to the export work" } });
    const v0 = (await branches.view(ann, first.id))!.branch;
    assert.deepEqual([v0.returnTo, v0.returnRevision], [{ taskId: task, note: "back to the export work" }, 0]);
    // Default destination is the task it began from.
    const dflt = await open(branches, ann, child);
    assert.deepEqual((await branches.view(ann, dflt.id))!.branch.returnTo, { taskId: child });
    // An urgent task arrives: the agent suspends and opens another branch for it; the saved destination is untouched and still owed.
    await branches.suspend(ann, { commandId: cid("s"), branchId: first.id, expectedRevision: v0.revision, reason: "urgent" });
    const urgentBranch = await open(branches, ann, urgent, { returnTo: { taskId: urgent } });
    const svc = reopen();
    const pending = (await svc.pendingReturns(ann)).items;
    assert.deepEqual(pending.map((p) => p.returnTo.taskId).sort(), [task, child, urgent].sort());
    assert.deepEqual((await svc.view(ann, first.id))!.branch.returnTo, { taskId: task, note: "back to the export work" });
    assert.equal((await svc.pendingReturns(ben)).items.length, 0, "others' branches are not listed");
    assert.equal((await svc.pendingReturns(owner)).items.length, 3);
    // Explicit change, revisioned; a stale change and an unrelated task are refused.
    const sRev = (await svc.view(ann, first.id))!.branch.revision;
    await refuses("stale_revision", () => svc.redirect(ann, { commandId: cid("rd"), branchId: first.id, expectedRevision: sRev - 1, returnTo: { taskId: urgent } }));
    await refuses("invalid_command", () => svc.redirect(ann, { commandId: cid("rd"), branchId: first.id, expectedRevision: sRev, returnTo: { taskId: "task-aaaaaaaaaaaaaaaaaaaa" } }));
    await refuses("forbidden", () => svc.redirect(ben, { commandId: cid("rd"), branchId: first.id, expectedRevision: sRev, returnTo: { taskId: urgent } }));
    await svc.redirect(ann, { commandId: cid("rd"), branchId: first.id, expectedRevision: sRev, returnTo: { taskId: urgent, note: "finish the urgent one first" } });
    const changed = (await svc.view(ann, first.id))!.branch;
    assert.deepEqual([changed.returnTo.taskId, changed.returnRevision, changed.returnChangedBy], [urgent, 1, "agent:ann"]);
    // Resuming consumes the destination: the branch leaves the pending list, the destination is kept as where it went.
    const res = await svc.resume(ann, { commandId: cid("rsm"), branchId: first.id, expectedRevision: changed.revision });
    assert.equal(res.returnedTo.taskId, urgent);
    const done = (await svc.view(ann, first.id))!.branch;
    assert.deepEqual([done.state, done.returnedTo?.taskId, done.suspended], ["returned", urgent, undefined]);
    assert.equal((await svc.pendingReturns(ann)).items.length, 2);
    await refuses("invalid_command", () => svc.resume(ann, { commandId: cid("rsm"), branchId: first.id, expectedRevision: done.revision }));
    await refuses("invalid_command", () => svc.redirect(ann, { commandId: cid("rd"), branchId: first.id, expectedRevision: done.revision, returnTo: { taskId: task } }));
    void urgentBranch;
  });

  suite("a delegated child task receives only the selected references, not a fork of the parent context", async ({ branches, histories, desks, task, child, urgent, ann, ben, cat, owner, a, b, eve }) => {
    await say(histories, ann, task, "private plan: step one");
    await say(histories, ann, task, "private plan: step two");
    const opened = await open(branches, ann, task);
    await branches.append(ann, { commandId: cid("b"), branchId: opened.id, text: "branch-only thought" });
    const rec = await desks.write(ann, { commandId: cid("w"), projectId: a, kind: "note", title: "Brief", body: "what the child needs", visibility: "shared", status: "accepted" });
    const entry: SourceRef = { kind: "history-entry", scopeId: HistoryService.taskScopeId(task), seq: 2 };
    const d = await branches.delegate(ann, { commandId: cid("dl"), branchId: opened.id, childTaskId: child, refs: [{ kind: "desk-record", id: rec.id }, entry] });
    assert.equal((await branches.delegate(ann, { commandId: cid("dl2"), branchId: opened.id, childTaskId: child, refs: [{ kind: "desk-record", id: rec.id }] })).replayed, false);
    // The child's worker resolves each link with its own rights: the shared note, but not the history it cannot read.
    const seen = await branches.delegatedContext(cat, child);
    assert.deepEqual(seen.filter((s) => s.delegationId === d.id).map((s) => [s.source.kind, s.state, s.text]), [["desk-record", "current", "what the child needs"], ["history-entry", "unavailable", undefined]]);
    // Nothing else of the parent or the branch is reachable through the child: no branch, no parent entries (only the entry that was selected, and only if readable).
    assert.equal(await branches.view(cat, opened.id), undefined);
    assert.equal(await branches.history(cat, opened.id, { part: "branch", limit: 5 }), undefined);
    assert.ok(!JSON.stringify(seen).includes("step one") && !JSON.stringify(seen).includes("branch-only"));
    const asAnn = await branches.delegatedContext(ann, child);
    assert.equal(asAnn.filter((s) => s.delegationId === d.id).map((s) => s.text).includes("private plan: step two"), true, "a reader who may read the selected entry sees that entry");
    assert.ok(!JSON.stringify(asAnn).includes("step one"), "the unselected entry is not handed over");
    assert.equal((await histories.read(owner, HistoryService.taskScopeId(child), { limit: 10, taskId: child })).entries.length, 0, "the child's own history starts empty: no fork");
    // A link that changed since selection shows as changed; one the child cannot read stays unavailable.
    await desks.write(ann, { commandId: cid("w"), projectId: a, kind: "note", title: "Brief", body: "revised brief", visibility: "shared", status: "accepted", supersedes: rec.id });
    assert.equal((await branches.delegatedContext(cat, child)).find((s) => s.source.kind === "desk-record")!.state, "changed");
    // Retrying a delegation after its original changed is the recorded result; two at once both land in the child's index.
    const dlCmd = cid("dl3");
    const first3 = await branches.delegate(ann, { commandId: dlCmd, branchId: opened.id, childTaskId: urgent, refs: [entry] });
    assert.deepEqual((await branches.delegate(ann, { commandId: dlCmd, branchId: opened.id, childTaskId: urgent, refs: [entry] })).id, first3.id);
    const both = await Promise.all([branches.delegate(ann, { commandId: cid("dp"), branchId: opened.id, childTaskId: child, refs: [entry] }), branches.delegate(ann, { commandId: cid("dp"), branchId: opened.id, childTaskId: child, refs: [entry] })]);
    const ids = new Set((await branches.delegatedContext(ann, child)).map((s) => s.delegationId));
    assert.ok(both.every((r) => ids.has(r.id)), "both delegations are listed for the child");
    // Who may see what the child was handed: those who may work on the child task; not other tasks' workers or other projects.
    assert.deepEqual(await branches.delegatedContext(eve, child), []);
    // Refusals.
    await refuses("invalid_command", () => branches.delegate(ann, { commandId: cid("dl"), branchId: opened.id, childTaskId: task, refs: [entry] }), (e) => assert.equal(e.field, "childTaskId"));
    await refuses("invalid_command", () => branches.delegate(ann, { commandId: cid("dl"), branchId: opened.id, childTaskId: child, refs: [] }), (e) => assert.equal(e.field, "refs"));
    await refuses("invalid_command", () => branches.delegate(ann, { commandId: cid("dl"), branchId: opened.id, childTaskId: child, refs: [{ kind: "history-entry", scopeId: HistoryService.taskScopeId(task), seq: 99 }] }));
    await refuses("forbidden", () => branches.delegate(ben, { commandId: cid("dl"), branchId: opened.id, childTaskId: child, refs: [entry] }));
    const other = await desks.write(eve, { commandId: cid("w"), projectId: b, kind: "note", title: "x", body: "B", visibility: "shared", status: "accepted" });
    await refuses("invalid_command", () => branches.delegate(ann, { commandId: cid("dl"), branchId: opened.id, childTaskId: child, refs: [{ kind: "desk-record", id: other.id }] }));
    void urgent;
  });

  suite("a returned branch cannot delegate, and the owner may act on any branch", async ({ branches, desks, a, task, child, ann, owner }) => {
    const rec = await desks.write(ann, { commandId: cid("w"), projectId: a, kind: "note", title: "R", body: "readable", visibility: "shared", status: "accepted" });
    const opened = await open(branches, ann, task);
    const v = (await branches.view(ann, opened.id))!;
    await branches.resume(owner, { commandId: cid("r"), branchId: opened.id, expectedRevision: v.branch.revision });
    await refuses("invalid_command", () => branches.delegate(ann, { commandId: cid("dl"), branchId: opened.id, childTaskId: child, refs: [{ kind: "desk-record", id: rec.id }] }), (e) => assert.match(e.message, /returned/));
    await refuses("invalid_command", () => branches.append(ann, { commandId: cid("b"), branchId: opened.id, text: "late" }));
  });
}
