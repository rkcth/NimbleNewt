import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ConversationService } from "../conversations/index.js";
import { DeskService, HistoryService, InspectionService, RetrievalService } from "../context/index.js";
import { AssignmentService } from "../domain/assignments.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { WaitService } from "../domain/waits.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { InquiryService } from "../inquiries/index.js";
import { ReviewService } from "../review/index.js";
import { GrantService, PrincipalService, TaskCredentialService, type Grant, type Principal } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-10-21T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); return true; });
};

// Services that judge the caller by looking it up again by ID must keep the caller's task scope: otherwise a credential for a task of project A is as wide as the agent in project B (card A10b, review).
for (const backend of backends) {
  test(`${backend.name}: a task credential stays inside its project in every service that looks the caller up again or decides by who owns a record`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const grants = GrantService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const a = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "A" })).id;
      const b = (await projects.createProject({ commandId: cid("pb"), actor: "owner:rob", name: "B" })).id;
      const ta = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: a, title: "in A" })).id;
      const tb = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: b, title: "in B" })).id;
      const everything = (p: string): Grant[] => ["review.request", "review.decide", "attempt.work", "desk.write", "desk.read", "history.append", "history.read", "conversation.start", "conversation.send", "conversation.receive", "config.read", "task.read"].map((action) => ({ action, project: p }));
      for (const name of ["ann", "ben"]) await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name, grants: [...everything(a), ...everything(b)] });
      const plain = async (name: string) => principals.authenticate((await principals.issueCredential(owner, `agent:${name}`)).token);
      const tcs = TaskCredentialService.withEpoch(world.storage, projects.epoch, options);
      const pa = await tcs.authenticate((await tcs.issue(owner, { commandId: cid("i"), taskId: ta, agentId: "agent:ann" })).token);
      const ann = await plain("ann");
      const ben = await plain("ben");

      // Reviews: the credential for a task of A cannot ask for a review of work in B, but the agent's own credential can.
      const review = ReviewService.withEpoch(world.storage, projects.epoch, options);
      const ask = (who: Principal, taskId: string) => review.request(who, { commandId: cid("rq"), taskId, operation: { name: "git-commit", args: { n: n++ }, target: { kind: "repository", id: "main" } }, context: { toolVersion: "1", authoritySource: "x", expectedEffects: ["y"] } });
      await refuses("forbidden", () => ask(pa, tb));
      const own = await ask(ann, tb);
      await ask(pa, ta);
      await refuses("forbidden", () => review.withdraw(pa, { commandId: cid("w"), requestId: own.id, expectedRevision: 1, reason: "not mine to withdraw from here" }));
      await review.withdraw(ann, { commandId: cid("w"), requestId: own.id, expectedRevision: 1, reason: "fine" });

      // Conversations: it neither starts nor reads nor closes a thread in B.
      const conversations = ConversationService.withEpoch(world.storage, projects.epoch, options);
      await refuses("forbidden", () => conversations.start(pa, { commandId: cid("c"), projectId: b, subject: "hi", to: ["agent:ben"], text: "from the wrong project" }));
      const thread = await conversations.start(ann, { commandId: cid("c"), projectId: b, subject: "in B", to: ["agent:ben"], text: "hello" });
      assert.equal(await conversations.thread(pa, thread.threadId), undefined);
      const found = (await conversations.thread(ann, thread.threadId))!;
      await refuses("forbidden", () => conversations.close(pa, { commandId: cid("c"), threadId: thread.threadId, expectedRevision: found.revision }));
      await conversations.close(ann, { commandId: cid("c"), threadId: thread.threadId, expectedRevision: found.revision });

      // Inquiries: a question to the agent about a task in B is not listed to its credential for a task in A.
      const desks = DeskService.withEpoch(world.storage, projects.epoch, options);
      const histories = HistoryService.withEpoch(world.storage, projects.epoch, options);
      const assignments = AssignmentService.withEpoch(world.storage, projects.epoch, projects, options);
      const inquiries = InquiryService.withEpoch(world.storage, projects.epoch, { histories, retrieval: RetrievalService.withEpoch(world.storage, projects.epoch, desks, histories, options), waits: WaitService.withEpoch(world.storage, projects.epoch, assignments, options), assignments }, options);
      await inquiries.ask(ben, { commandId: cid("q"), taskId: tb, to: "agent:ann", question: "what do you think about B?" });
      assert.equal((await inquiries.pendingFor(ann, {})).items.length, 1);
      assert.deepEqual((await inquiries.pendingFor(pa, {})).items, []);

      // Inspections of the agent's scratch in B are not listed to its credential for A.
      const inspection = InspectionService.withEpoch(world.storage, projects.epoch, options);
      const scratch = await desks.write(ann, { commandId: cid("w"), projectId: b, kind: "note", title: "s", body: "private thinking", visibility: "private", status: "accepted" });
      await inspection.inspect(owner, { commandId: cid("ins"), recordId: scratch.id, reason: "checking in" });
      assert.equal((await inspection.inspections(ann)).items.length, 1);
      assert.deepEqual((await inspection.inspections(pa)).items, []);

      // Grants: it derives only inside its own task's project.
      const held = await grants.grant(owner, { commandId: cid("g"), grantee: "agent:ann", action: "task.read", project: b, source: "direct", basis: "x" });
      const wide = await grants.grant(owner, { commandId: cid("g"), grantee: "agent:ann", action: "task.read", project: "*", source: "direct", basis: "x" });
      await refuses("forbidden", () => grants.derive(pa, { commandId: cid("d"), parentId: held.id, action: "task.read", project: b, basis: "in B" }));
      await refuses("forbidden", () => grants.derive(pa, { commandId: cid("d"), parentId: wide.id, action: "task.read", project: "*", basis: "everywhere" }));
      await grants.derive(pa, { commandId: cid("d"), parentId: wide.id, action: "task.read", project: a, basis: "just here" });
      await grants.derive(ann, { commandId: cid("d"), parentId: held.id, action: "task.read", project: b, basis: "the agent itself may" });
    } finally { await world.close(); }
  });
}
