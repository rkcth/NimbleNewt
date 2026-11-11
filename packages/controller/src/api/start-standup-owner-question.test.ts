import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CommandRunner } from "../domain/runner.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { NotificationService } from "../notifications/index.js";
import { startController, type StartOptions } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("a stand-up runs end to end in the running controller: a topic settled with a question for the owner is announced once, answered by the owner only and shown on the next agenda, across a restart (card M03h)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-standup-q-"));
  const options = (): StartOptions => ({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], dispatch: { timer: new ManualTimer(), intervalMs: 1000 } } as StartOptions);
  let c = await startController(options());
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (c2: typeof c, token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c2.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await call(c, boot.token, "project.create", { name: "Garden" }, "p1")).result.id as string;
    const agent = (await c.services.agents.create(rob, { commandId: "ag-a", friendlyName: "A" })).id;
    await c.services.principals.enroll(rob, { commandId: "e-host", kind: "host", name: "h1", grants: [{ action: "meeting.manage", project }, { action: "meeting.read", project }] });
    const host = (await c.services.principals.issueCredential(rob, "host:h1")).token;
    const turnRef = { kind: "chat-turn", id: "turn-1" };
    await new CommandRunner(c.storage, c.epoch, {}).command("test.turn", { commandId: "mk", actor: "system" }, async () => ({ payload: {}, build: async () => ({ ref: turnRef, creates: true, changes: [{ type: "create", ref: turnRef, body: { ownerId: "owner:rob", messageId: "m1", text: "Should we drop the old API?", quotedCount: 0, status: "done", plan: [], createdAt: "2026-10-30T00:00:00.000Z", projectId: project } as never }], detail: { projectId: project } }) }));
    const turnNotes = async (cc: typeof c) => ((await cc.storage.getAggregate({ kind: "chat-turn", id: "turn-1" }))!.body as unknown as { followUps?: { key: string; text: string }[] }).followUps ?? [];
    const inboxQuestions = async (cc: typeof c) => (await NotificationService.withEpoch(cc.storage, cc.epoch).inbox(rob)).items.filter((i) => i.ref.kind === "owner-question");

    // A topic raised from the owner's chat turn is settled with a question for the owner.
    const made = await call(c, boot.token, "agenda.capture", { projectId: project, topic: "Drop the old API?", question: "Should we drop the old API?", urgency: "normal", intent: "discussion", sourceTurnId: "turn-1" }, "ag1");
    assert.ok(made.ok, JSON.stringify(made));
    const itemId = made.result.id as string;
    const bad = await call(c, boot.token, "agenda.settle", { itemId, expectedRevision: made.result.revision, to: "queued", ownerQuestion: "Which date?" }, "bad1");
    assert.equal(bad.ok, false, "a queued item has no outcome yet, so it asks nothing");
    const credential = await call(c, boot.token, "agenda.settle", { itemId, expectedRevision: made.result.revision, to: "resolved", ownerQuestion: "Use key sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD" }, "bad2");
    assert.equal(credential.ok, false, "a question that looks like a credential is not recorded");
    const settled = await call(c, boot.token, "agenda.settle", { itemId, expectedRevision: made.result.revision, to: "resolved", outcomeNote: "Drop it after the next release.", ownerQuestion: "Which release should be the last to carry the old API?" }, "set1");
    assert.ok(settled.ok, JSON.stringify(settled));
    assert.ok((await call(c, boot.token, "agenda.settle", { itemId, expectedRevision: made.result.revision, to: "resolved", outcomeNote: "Drop it after the next release.", ownerQuestion: "Which release should be the last to carry the old API?" }, "set1")).ok, "the same command again is a replay");

    // Nothing is announced until the delivery runs; the question is already on record and readable by the owner and by a reader of the project's meetings.
    const before = await call(c, boot.token, "standup.owner-questions", { projectId: project });
    assert.equal(before.result.item.open.length, 1, JSON.stringify(before));
    const q = before.result.item.open[0] as { id: string; revision: number; question: string; topic: string; source: { kind: string; id: string } };
    assert.equal(q.topic, "Drop the old API?");
    assert.deepEqual(q.source, { kind: "chat-turn", id: "turn-1" });
    assert.equal((await call(c, host, "standup.owner-questions", { projectId: project })).result.item.open.length, 1);
    assert.equal((await inboxQuestions(c)).length, 0);

    const first = await call(c, boot.token, "standup.deliver", { projectId: project }, "d1");
    assert.ok(first.ok, JSON.stringify(first));
    assert.deepEqual(first.result.delivered, [itemId]);
    assert.deepEqual(first.result.questions, { told: [q.id], waiting: [] });
    const notes = await turnNotes(c);
    assert.equal(notes.length, 2, "the outcome and the question are both on the turn");
    assert.ok(notes.some((n) => /Which release should be the last/.test(n.text)));
    const inbox = await inboxQuestions(c);
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0]!.level, "needs-you");
    assert.match(inbox[0]!.detail ?? "", /Which release should be the last to carry the old API\?/);
    const again = await call(c, boot.token, "standup.deliver", { projectId: project }, "d2");
    assert.equal(again.result.questions, undefined, "a question is announced once");
    assert.equal((await turnNotes(c)).length, 2);
    assert.equal((await inboxQuestions(c)).length, 1);

    // The chat's status answer lists it.
    const status = await call(c, boot.token, "status.ask", { request: { kind: "standup_questions", projectId: project } });
    assert.ok(status.ok, JSON.stringify(status));
    assert.match(JSON.stringify(status.result), /Waiting for your answer.*Which release should be the last/);

    // Announcing marked the question told, so the revision to quote is the one read now.
    q.revision = (await call(c, boot.token, "standup.owner-questions", { projectId: project })).result.item.open[0].revision as number;
    // Only the owner answers, on the revision they read; the answer closes the notification and moves the question to the answered list.
    const hostTry = await call(c, host, "standup.answer-question", { questionId: q.id, expectedRevision: q.revision, answer: "2.0" }, "a-host");
    assert.equal(hostTry.ok, false);
    const stale = await call(c, boot.token, "standup.answer-question", { questionId: q.id, expectedRevision: q.revision + 5, answer: "2.0" }, "a-stale");
    assert.equal(stale.ok, false);
    const answered = await call(c, boot.token, "standup.answer-question", { questionId: q.id, expectedRevision: q.revision, answer: "Release 2.0 is the last one." }, "a1");
    assert.ok(answered.ok, JSON.stringify(answered));
    assert.ok((await call(c, boot.token, "standup.answer-question", { questionId: q.id, expectedRevision: q.revision, answer: "Release 2.0 is the last one." }, "a1")).ok, "a replay");
    assert.equal((await call(c, boot.token, "standup.answer-question", { questionId: q.id, expectedRevision: q.revision + 1, answer: "another" }, "a2")).ok, false, "a question is answered once");
    const after = (await call(c, boot.token, "standup.owner-questions", { projectId: project })).result.item;
    assert.equal(after.open.length, 0);
    assert.equal(after.answered.length, 1);
    assert.equal(after.answered[0].answer, "Release 2.0 is the last one.");
    assert.equal((await inboxQuestions(c)).length, 0, "the notification is closed with the answer");

    // The next stand-up's agenda shows the question and the owner's answer (to those who may read the project's records), and the briefs are readable through the status answer of the running controller.
    const occ = (await call(c, boot.token, "meeting.call-urgent", { projectId: project, title: "Sync", reason: "check", roster: [`agent:${agent}`] }, "u1")).result.id as string;
    assert.ok((await call(c, boot.token, "standup.prepare", { occurrenceId: occ }, "pp1")).ok);
    const agenda = (await call(c, boot.token, "standup.agenda", { occurrenceId: occ })).result.item as { ownerQuestions?: { open: unknown[]; answered: { text: string; cites: { kind: string }[] }[] } };
    assert.equal(agenda.ownerQuestions?.open.length, 0);
    assert.match(agenda.ownerQuestions!.answered[0]!.text, /The owner answered: "Release 2\.0 is the last one\."/);
    assert.equal(agenda.ownerQuestions!.answered[0]!.cites[0]!.kind, "owner-question");
    const briefs = await call(c, boot.token, "status.ask", { request: { kind: "standup_briefs", occurrenceId: occ } });
    assert.ok(briefs.ok, JSON.stringify(briefs));
    assert.match(JSON.stringify(briefs.result), /brief/);

    // A topic with no conversation behind it still reaches the owner, through the notification alone.
    const plain = await call(c, boot.token, "agenda.capture", { projectId: project, topic: "Nightly backups", urgency: "normal", intent: "discussion" }, "ag2");
    assert.ok((await call(c, boot.token, "agenda.settle", { itemId: plain.result.id, expectedRevision: plain.result.revision, to: "deferred", reason: "needs a decision", nextStep: "ask the owner", ownerQuestion: "Keep seven nightly backups or thirty?" }, "set2")).ok);
    const second = await call(c, boot.token, "standup.deliver", { projectId: project }, "d3");
    assert.equal(second.result.questions.told.length, 1, JSON.stringify(second));
    assert.equal((await inboxQuestions(c)).length, 1);
    await c.close();

    // A restart keeps the question, its announcement and the answer; nothing is told again.
    c = await startController(options());
    const restored = (await call(c, boot.token, "standup.owner-questions", { projectId: project })).result.item;
    assert.equal(restored.open.length, 1);
    assert.equal(restored.answered.length, 1);
    assert.equal((await call(c, boot.token, "standup.deliver", { projectId: project }, "d4")).result.questions, undefined);
    assert.equal((await inboxQuestions(c)).length, 1);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
