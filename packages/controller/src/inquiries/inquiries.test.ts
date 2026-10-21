import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DeskService, HistoryService, RetrievalService } from "../context/index.js";
import { AssignmentService } from "../domain/assignments.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { WaitService } from "../domain/waits.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Grant, type Principal } from "../security/index.js";
import { INQUIRY_LIMITS, InquiryService } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-10-21T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};

for (const backend of backends) {
  interface Ctx {
    owner: Principal; a: string; task: string; inquiries: InquiryService; reopen(h?: HistoryService): InquiryService; histories: HistoryService; desks: DeskService; assignments: AssignmentService; waits: WaitService; projects: ProjectService;
    ann: Principal; ben: Principal; eve: Principal; agent(name: string, grants: Grant[]): Promise<Principal>;
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
        const task = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: a, title: "the task" })).id;
        await projects.transitionTask({ commandId: cid("tr"), actor: "owner:rob", taskId: task, expectedRevision: 1, to: "ready" });
        const assignments = AssignmentService.withEpoch(world.storage, projects.epoch, projects, options);
        await assignments.assignTask({ commandId: cid("as"), actor: "owner:rob", taskId: task, owner: { kind: "agent", id: "ann" } });
        const histories = HistoryService.withEpoch(world.storage, projects.epoch, options);
        const desks = DeskService.withEpoch(world.storage, projects.epoch, options);
        const retrieval = RetrievalService.withEpoch(world.storage, projects.epoch, desks, histories, options);
        const waits = WaitService.withEpoch(world.storage, projects.epoch, assignments, options);
        const make = (h: HistoryService = histories) => InquiryService.withEpoch(world.storage, projects.epoch, { histories: h, retrieval, waits, assignments }, options);
        const rights = (p: string): Grant[] => [{ action: "history.*", project: p }, { action: "desk.write", project: p }, { action: "desk.read", project: p }];
        const ann = await agent("ann", [...rights(a), { action: "attempt.work", project: a }]);
        const ben = await agent("ben", rights(a));
        const eve = await agent("eve", rights(b));
        await body({ owner, a, task, inquiries: make(), reopen: make, histories, desks, assignments, waits, projects, ann, ben, eve, agent });
      } finally { await world.close(); }
    });
  const q = (extra: Record<string, unknown> = {}) => ({ commandId: cid("ask"), taskId: "", to: "agent:ben", question: "Which database did we pick, and why?", ...extra });

  suite("ask, answer and close: one correlation, a side chat that stays out of the task's history, and no change of ownership", async ({ inquiries, histories, assignments, task, ann, ben, owner, a }) => {
    const before = JSON.stringify(await assignments.getAssignment(task));
    const asked = await inquiries.ask(ann, { ...q(), taskId: task } as never);
    const v = (await inquiries.view(ann, asked.id))!;
    assert.deepEqual([v.inquiry.state, v.inquiry.correlationId, v.inquiry.asker, v.inquiry.to, v.generationUnchanged], ["open", asked.id, "agent:ann", "agent:ben", true]);
    assert.equal((await inquiries.pendingFor(ben)).items[0]!.id, asked.id);
    assert.equal((await inquiries.pendingFor(ann)).items.length, 0, "it is waiting for ben, not ann");
    const answered = await inquiries.answer(ben, { commandId: cid("ans"), inquiryId: asked.id, answer: "PostgreSQL, because of the crash-recovery tests." });
    assert.equal(answered.id, asked.id);
    assert.equal((await inquiries.view(ann, asked.id))!.inquiry.answer, "PostgreSQL, because of the crash-recovery tests.");
    assert.equal((await inquiries.pendingFor(ben)).items.length, 0);
    const chat = await histories.read(ann, v.inquiry.scopeId, { limit: 10 });
    assert.deepEqual(chat.entries.map((e) => [e.author, e.text.slice(0, 20)]), [["agent:ann", "Which database did w"], ["agent:ben", "PostgreSQL, because "]]);
    assert.equal((await histories.read(owner, HistoryService.taskScopeId(task), { limit: 10, taskId: task })).entries.length, 0, "the side chat did not enter the task's history");
    const rev = (await inquiries.view(ann, asked.id))!.inquiry.revision;
    await inquiries.close(ann, { commandId: cid("cl"), inquiryId: asked.id, expectedRevision: rev });
    assert.equal((await inquiries.view(ben, asked.id))!.inquiry.state, "closed");
    assert.equal(JSON.stringify(await assignments.getAssignment(task)), before, "the assignment is exactly as it was: no transfer, no new generation");
    void a;
  });

  suite("the main attempt waits on the inquiry: answering it answers the wait, and a repeated answer finishes what is missing without doing anything twice", async ({ inquiries, histories, waits, assignments, projects, task, ann, ben }) => {
    const wait = await waits.openWait({ commandId: cid("w"), actor: "agent:ann", taskId: task, reason: "inquiry", resolver: "agent:ben", summary: "waiting for ben's answer", nextAction: "continue with the answer", indefinite: { owner: "agent:ann" } });
    assert.equal((await projects.getTask(task))!.state, "blocked");
    const asked = await inquiries.ask(ann, { ...q(), taskId: task, waitId: wait.id } as never);
    const before = JSON.stringify(await assignments.getAssignment(task));
    const command = { commandId: "answer-once", inquiryId: asked.id, answer: "Use PostgreSQL." };
    assert.equal((await inquiries.answer(ben, command)).replayed, false);
    assert.equal((await waits.getWait(wait.id))!.state, "answered");
    assert.equal((await projects.getTask(task))!.state, "ready", "the main attempt can go on");
    assert.equal((await inquiries.answer(ben, command)).replayed, true, "repeating the call is recognised");
    const chat = await histories.read(ann, (await inquiries.view(ann, asked.id))!.inquiry.scopeId, { limit: 10 });
    assert.equal(chat.entries.length, 2, "the question and the answer, once each");
    assert.equal(JSON.stringify(await assignments.getAssignment(task)), before, "ownership never moved");
    await refuses("invalid_command", () => inquiries.ask(ann, { ...q(), taskId: task, waitId: wait.id } as never), (e) => assert.match(e.message, /open inquiry wait/));
  });

  suite("a crash after the answer was recorded is finished by a retry, even with a new command ID, and the waiting task is released", async ({ inquiries, reopen, histories, waits, projects, task, ann, ben }) => {
    const wait = await waits.openWait({ commandId: cid("w"), actor: "agent:ann", taskId: task, reason: "inquiry", resolver: "agent:ben", summary: "waiting", nextAction: "continue", indefinite: { owner: "agent:ann" } });
    const asked = await inquiries.ask(ann, { ...q(), taskId: task, waitId: wait.id } as never);
    // A history service that dies on the answer's chat entry, once: the record step has already happened.
    let dies = true;
    const flaky = new Proxy(histories, { get: (target, key) => {
      const value = (target as never)[key] as unknown;
      if (key !== "append") return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      return async (...args: unknown[]) => { if (dies && String((args[2] as { commandId: string }).commandId).endsWith("-a")) { dies = false; throw new Error("process died"); } return (target.append as (...a: unknown[]) => unknown)(...args); };
    } });
    await assert.rejects(() => reopen(flaky).answer(ben, { commandId: "first-try", inquiryId: asked.id, answer: "Use PostgreSQL." }), /process died/);
    assert.equal((await inquiries.view(ben, asked.id))!.inquiry.state, "answered", "the record step had happened");
    assert.equal((await waits.getWait(wait.id))!.state, "open", "and the task is still blocked");
    assert.equal((await projects.getTask(task))!.state, "blocked");
    // The restarted worker does not know the old command ID.
    await inquiries.answer(ben, { commandId: "second-try", inquiryId: asked.id, answer: "Use PostgreSQL." });
    assert.equal((await waits.getWait(wait.id))!.state, "answered");
    assert.equal((await projects.getTask(task))!.state, "ready");
    const chat = await histories.read(ann, (await inquiries.view(ann, asked.id))!.inquiry.scopeId, { limit: 10 });
    assert.equal(chat.entries.length, 2, "the question and the answer, once each");
    // A different answer is not taken as a repeat.
    await refuses("invalid_command", () => inquiries.answer(ben, { commandId: cid("third"), inquiryId: asked.id, answer: "Actually MySQL." }), (e) => assert.match(e.message, /answered/));
  });

  suite("if the asker closes the inquiry before a crashed answer was finished, the retry still releases the wait", async ({ inquiries, reopen, histories, waits, projects, task, ann, ben }) => {
    const wait = await waits.openWait({ commandId: cid("w"), actor: "agent:ann", taskId: task, reason: "inquiry", resolver: "agent:ben", summary: "waiting", nextAction: "continue", indefinite: { owner: "agent:ann" } });
    const asked = await inquiries.ask(ann, { ...q(), taskId: task, waitId: wait.id } as never);
    let dies = true;
    const flaky = new Proxy(histories, { get: (target, key) => {
      const value = (target as never)[key] as unknown;
      if (key !== "append") return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      return async (...args: unknown[]) => { if (dies && String((args[2] as { commandId: string }).commandId).endsWith("-a")) { dies = false; throw new Error("process died"); } return (target.append as (...a: unknown[]) => unknown)(...args); };
    } });
    await assert.rejects(() => reopen(flaky).answer(ben, { commandId: "first-try", inquiryId: asked.id, answer: "Use PostgreSQL." }), /process died/);
    const rev = (await inquiries.view(ann, asked.id))!.inquiry.revision;
    await inquiries.close(ann, { commandId: cid("cl"), inquiryId: asked.id, expectedRevision: rev });
    await inquiries.answer(ben, { commandId: "second-try", inquiryId: asked.id, answer: "Use PostgreSQL." });
    assert.equal((await waits.getWait(wait.id))!.state, "answered");
    assert.equal((await projects.getTask(task))!.state, "ready");
    assert.equal((await inquiries.view(ann, asked.id))!.inquiry.state, "closed");
  });

  suite("two asks at the same moment cannot both take the last of the ten places", async ({ inquiries, ann, ben, task }) => {
    for (let i = 0; i < INQUIRY_LIMITS.openPerTask - 1; i++) await inquiries.ask(ann, { ...q(), taskId: task } as never);
    const results = await Promise.allSettled([inquiries.ask(ann, { ...q(), taskId: task } as never), inquiries.ask(ann, { ...q(), taskId: task } as never), inquiries.ask(ann, { ...q(), taskId: task } as never)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, JSON.stringify(results.map((r) => r.status)));
    for (const r of results) if (r.status === "rejected") assert.ok(r.reason instanceof DomainError && r.reason.code === "unavailable", String(r.reason));
    assert.equal((await inquiries.pendingFor(ben, { limit: 100 })).items.length, INQUIRY_LIMITS.openPerTask, "exactly ten are open, no more");
  });

  suite("answering or withdrawing frees a place under the limit", async ({ inquiries, ann, ben, task }) => {
    const ids: string[] = [];
    for (let i = 0; i < INQUIRY_LIMITS.openPerTask; i++) ids.push((await inquiries.ask(ann, { ...q(), taskId: task } as never)).id);
    await refuses("unavailable", () => inquiries.ask(ann, { ...q(), taskId: task } as never));
    await inquiries.answer(ben, { commandId: cid("a"), inquiryId: ids[0]!, answer: "yes" });
    await inquiries.ask(ann, { ...q(), taskId: task } as never);
    await refuses("unavailable", () => inquiries.ask(ann, { ...q(), taskId: task } as never));
    await inquiries.cancel(ann, { commandId: cid("c"), inquiryId: ids[1]!, expectedRevision: 1, reason: "not needed" });
    await inquiries.ask(ann, { ...q(), taskId: task } as never);
  });

  suite("a restart keeps the correlation: a new service on the same storage finds the question and takes the answer", async ({ inquiries, reopen, ann, ben, task }) => {
    const asked = await inquiries.ask(ann, { ...q(), taskId: task } as never);
    const restarted = reopen();
    assert.equal((await restarted.pendingFor(ben)).items[0]!.correlationId, asked.id, "the question is there, under the same correlation");
    await restarted.answer(ben, { commandId: cid("ans"), inquiryId: asked.id, answer: "after the restart" });
    const seen = (await reopen().view(ann, asked.id))!;
    assert.deepEqual([seen.inquiry.state, seen.inquiry.answer, seen.inquiry.correlationId], ["answered", "after the restart", asked.id]);
    // Asking again with the same command ID is the same inquiry, not a second one.
    const again = await restarted.ask(ann, { ...q({ commandId: "ask-fixed" }), taskId: task } as never);
    assert.equal((await restarted.ask(ann, { ...q({ commandId: "ask-fixed" }), taskId: task } as never)).id, again.id);
  });

  suite("context is shown to each viewer only as far as that viewer may read it", async ({ inquiries, desks, ann, ben, a, task }) => {
    const shared = await desks.write(ann, { commandId: cid("w"), projectId: a, kind: "note", title: "Shared note", body: "Public to the project.", visibility: "shared", status: "accepted" });
    const scratch = await desks.write(ann, { commandId: cid("w"), projectId: a, kind: "note", title: "Scratch", body: "ann's private working numbers", visibility: "private" });
    const asked = await inquiries.ask(ann, { ...q(), taskId: task, contextRefs: [{ kind: "desk-record", id: shared.id }, { kind: "desk-record", id: scratch.id }] } as never);
    const forAnn = (await inquiries.view(ann, asked.id))!;
    assert.deepEqual(forAnn.context.map((c) => c.state), ["available", "available"]);
    const forBen = (await inquiries.view(ben, asked.id))!;
    assert.deepEqual(forBen.context.map((c) => c.state), ["available", "unavailable"]);
    assert.ok(!JSON.stringify(forBen).includes("private working numbers"), "the unreadable item's text is absent");
    // The asker cannot attach what the asker cannot read.
    const hers = await desks.write(ben, { commandId: cid("w"), projectId: a, kind: "note", title: "Ben's scratch", body: "ben only", visibility: "private" });
    await refuses("invalid_command", () => inquiries.ask(ann, { ...q(), taskId: task, contextRefs: [{ kind: "desk-record", id: hers.id }] } as never), (e) => assert.match(e.message, /readable by the asker/));
  });

  suite("only the people involved see an inquiry; only the addressee answers; only the asker closes; missing and forbidden read alike", async ({ inquiries, ann, ben, eve, owner, task, agent, a }) => {
    const asked = await inquiries.ask(ann, { ...q(), taskId: task } as never);
    assert.equal(await inquiries.view(eve, asked.id), undefined);
    assert.equal(await inquiries.view(eve, "inq-aaaaaaaaaaaaaaaaaaaa"), undefined);
    assert.ok(await inquiries.view(owner, asked.id));
    const cam = await agent("cam", [{ action: "history.*", project: a }]);
    const attempt = (who: Principal, id: string) => inquiries.answer(who, { commandId: cid("ans"), inquiryId: id, answer: "x" }).then(() => "ok", (e: DomainError) => `${e.code}: ${e.message.replace(who.id, "WHO")}`);
    const results = await Promise.all([attempt(cam, asked.id), attempt(cam, "inq-aaaaaaaaaaaaaaaaaaaa"), attempt(ann, asked.id)]);
    assert.equal(results[0], results[1], "a bystander learns nothing about whether it exists");
    assert.match(results[2]!, /^forbidden/, "the asker cannot answer its own question");
    await inquiries.answer(ben, { commandId: cid("ans"), inquiryId: asked.id, answer: "done" });
    const rev = (await inquiries.view(ann, asked.id))!.inquiry.revision;
    await refuses("forbidden", () => inquiries.close(ben, { commandId: cid("cl"), inquiryId: asked.id, expectedRevision: rev }));
    await refuses("forbidden", () => inquiries.close(owner, { commandId: cid("cl"), inquiryId: asked.id, expectedRevision: rev }));
    await refuses("stale_revision", () => inquiries.close(ann, { commandId: cid("cl"), inquiryId: asked.id, expectedRevision: rev + 5 }));
    await inquiries.close(ann, { commandId: cid("cl"), inquiryId: asked.id, expectedRevision: rev });
    await refuses("invalid_command", () => inquiries.answer(ben, { commandId: cid("ans"), inquiryId: asked.id, answer: "late" }), (e) => assert.match(e.message, /closed/));
  });

  suite("asking needs the right to work on the task; the addressee must be able to read the project's histories", async ({ inquiries, ann, ben, eve, task }) => {
    const missing = await inquiries.ask(ben, { ...q(), taskId: "task-aaaaaaaaaaaaaaaaaaaa" } as never).then(() => "ok", (e: DomainError) => `${e.code}`);
    const noRight = await inquiries.ask(ben, { ...q(), taskId: task } as never).then(() => "ok", (e: DomainError) => `${e.code}`);
    assert.deepEqual([missing, noRight], ["forbidden", "forbidden"], "no right to work on the task reads like no such task");
    await refuses("invalid_command", () => inquiries.ask(ann, { ...q({ to: "agent:eve" }), taskId: task } as never), (e) => assert.match(e.message, /may not read the histories/));
    await refuses("invalid_command", () => inquiries.ask(ann, { ...q({ to: "agent:ann" }), taskId: task } as never), (e) => assert.match(e.message, /cannot be the asker/));
    await refuses("invalid_command", () => inquiries.ask(ann, { ...q({ question: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789" }), taskId: task } as never), (e) => assert.match(e.message, /credential/));
    await refuses("invalid_command", () => inquiries.ask(ann, { ...q(), taskId: task, contextRefs: Array.from({ length: 11 }, () => ({ kind: "desk-record", id: "dsk-aaaaaaaaaaaaaaaaaaaa" })) } as never));
    await refuses("invalid_command", () => inquiries.ask(ann, { ...q({ surprise: 1 }), taskId: task } as never));
    void eve;
  });

  suite("an open inquiry can be withdrawn by the asker or the owner, and then cannot be answered", async ({ inquiries, ann, ben, owner, task }) => {
    const a1 = await inquiries.ask(ann, { ...q(), taskId: task } as never);
    const rev = (await inquiries.view(ann, a1.id))!.inquiry.revision;
    await refuses("forbidden", () => inquiries.cancel(ben, { commandId: cid("c"), inquiryId: a1.id, expectedRevision: rev, reason: "nope" }));
    await inquiries.cancel(ann, { commandId: cid("c"), inquiryId: a1.id, expectedRevision: rev, reason: "found it myself" });
    const view = (await inquiries.view(ben, a1.id))!.inquiry;
    assert.deepEqual([view.state, view.cancelledBy, view.cancelReason], ["cancelled", "agent:ann", "found it myself"]);
    await refuses("invalid_command", () => inquiries.answer(ben, { commandId: cid("ans"), inquiryId: a1.id, answer: "too late" }), (e) => assert.match(e.message, /cancelled/));
    const a2 = await inquiries.ask(ann, { ...q(), taskId: task } as never);
    await inquiries.cancel(owner, { commandId: cid("c"), inquiryId: a2.id, expectedRevision: (await inquiries.view(owner, a2.id))!.inquiry.revision, reason: "owner stopped it" });
    assert.equal((await inquiries.view(ann, a2.id))!.inquiry.cancelledBy, "owner:rob");
    await refuses("invalid_command", () => inquiries.cancel(ann, { commandId: cid("c"), inquiryId: a2.id, expectedRevision: 2, reason: "again" }));
  });

  suite("the number of open inquiries per task is bounded, and a refusal leaves no chat behind", async ({ inquiries, histories, owner, ann, task, a }) => {
    for (let i = 0; i < INQUIRY_LIMITS.openPerTask; i++) await inquiries.ask(ann, { ...q(), taskId: task } as never);
    const scopes = (await histories.listScopes(owner, { projectId: a, limit: 100 })).items.length;
    await refuses("unavailable", () => inquiries.ask(ann, { ...q(), taskId: task } as never), (e) => assert.match(e.message, /already has 10 open/));
    assert.equal((await histories.listScopes(owner, { projectId: a, limit: 100 })).items.length, scopes);
  });

  suite("the asker's attempt is shown as no longer current once the task has moved on", async ({ inquiries, assignments, ann, task }) => {
    const asked = await inquiries.ask(ann, { ...q(), taskId: task } as never);
    assert.equal((await inquiries.view(ann, asked.id))!.generationUnchanged, true);
    const current = (await assignments.getAssignment(task))!;
    await assignments.transferTask({ commandId: cid("tf"), actor: "owner:rob", taskId: task, expectedRevision: current.revision, to: { kind: "agent", id: "cam" } });
    const v = (await inquiries.view(ann, asked.id))!;
    assert.equal(v.generationUnchanged, false, "the question is kept, and its reader can see the asking attempt is no longer the owner");
    assert.equal(v.inquiry.state, "open");
  });
}
