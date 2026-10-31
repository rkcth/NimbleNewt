import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AssignmentService } from "../domain/assignments.js";
import { BlockerService } from "../domain/blockers.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { WaitService } from "../domain/waits.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { DeskService, HistoryService, RetrievalService } from "../context/index.js";
import { InquiryService } from "../inquiries/index.js";
import { ReviewService } from "../review/index.js";
import { PrincipalService, type Grant, type Principal } from "../security/index.js";
import { DEFAULT_ESCALATIONS_PER_HOUR, NOTIFICATION_LIMITS, NotificationService, type ChannelAdapter, type NotificationKind } from "./index.js";

after(stopServer);

let now = Date.parse("2026-10-22T08:00:00.000Z");
const set = (iso: string): void => { now = Date.parse(iso); };
const minutes = (m: number): void => { now += m * 60_000; };
const options = { clock: () => new Date(now).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); return true; });
};
const context = { toolVersion: "1.0", authoritySource: "task grant", expectedEffects: ["does the thing"] };

for (const backend of backends) {
  interface Ctx {
    svc: NotificationService; owner: Principal; ann: Principal; evil: Principal; ctl: Principal; wide: Principal; a: string; b: string; ta: string;
    sent: { text: string; links: unknown }[]; failing: { on: boolean }; responded: { commandId: string; id: string; answer: string }[];
    readsFailFor(id: string): NotificationService; review(): Promise<string>; resolveBlocker(id: string): Promise<void>; blocker(type?: "manual_hold" | "wait_overdue" | "unexplained_block"): Promise<string>; question(): Promise<string>;
    report(who: Principal, kind: NotificationKind, refKind: string, id: string, extra?: Record<string, unknown>): ReturnType<NotificationService["emit"]>;
    /** Another service over the same storage with other wiring (channels, time zone, timeouts). */
    other(o: { channels?: Record<string, ChannelAdapter>; timeZone?: () => Promise<string | undefined>; sendTimeoutMs?: number; runBudgetMs?: number }): NotificationService;
    /** Replaces a stored record's body (damage, for the tests of one bad record among good ones). */
    damage(kind: string, id: string, body: Record<string, unknown>): Promise<void>;
  }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      set("2026-10-22T08:00:00.000Z");
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const a = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "A" })).id;
        const b = (await projects.createProject({ commandId: cid("pb"), actor: "owner:rob", name: "B" })).id;
        const ta = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: a, title: "T" })).id;
        const agent = async (nm: string, grants: Grant[]) => { await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants }); return principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token); };
        const ann = await agent("ann", [{ action: "notification.emit", project: a }, { action: "review.request", project: a }, { action: "attempt.work", project: a }, { action: "history.append", project: a }, { action: "history.read", project: a }]);
        const evil = await agent("evil", [{ action: "notification.emit", project: b }]);
        const ctl = owner; // stands for the controller's own internal reports
        const wide = await agent("wide", [{ action: "*", project: a }, { action: "*", project: "*" }]);
        const sent: { text: string; links: unknown }[] = []; const failing = { on: false }; const responded: { commandId: string; id: string; answer: string }[] = [];
        const channel: ChannelAdapter = { send: async (m) => { if (failing.on) throw new Error("webhook down: token=abcd1234efgh5678ijkl"); sent.push({ text: m.text, links: m.links }); } };
        const reviews = ReviewService.withEpoch(world.storage, projects.epoch, options);
        await reviews.setPolicy(owner, { commandId: cid("rp"), projectId: a, policy: { mandatoryHuman: ["git-commit"] } });
        const blockers = BlockerService.withEpoch(world.storage, projects.epoch, options);
        const assignments = AssignmentService.withEpoch(world.storage, projects.epoch, projects, options);
        const desks = DeskService.withEpoch(world.storage, projects.epoch, options);
        const histories = HistoryService.withEpoch(world.storage, projects.epoch, options);
        const inquiries = InquiryService.withEpoch(world.storage, projects.epoch, { histories, retrieval: RetrievalService.withEpoch(world.storage, projects.epoch, desks, histories, options), waits: WaitService.withEpoch(world.storage, projects.epoch, assignments, options), assignments }, options);
        const svc = NotificationService.withEpoch(world.storage, projects.epoch, {
          ...options, channels: { pager: channel },
          responders: { "review-request": async (_o, item, answer, commandId) => { if (answer === "deny") throw new Error("the review is already decided"); responded.push({ commandId, id: item.ref.id, answer }); } },
        });
        await body({
          readsFailFor: (id) => NotificationService.withEpoch(new Proxy(world.storage, { get: (t, k) => { const v = Reflect.get(t, k, t); if (k !== "getAggregate") return typeof v === "function" ? v.bind(t) : v; return async (ref: { kind: string; id: string }) => { if (ref.id === id) throw new Error("storage hiccup"); return t.getAggregate(ref); }; } }), projects.epoch, options),
          svc, owner, ann, evil, ctl, wide, a, b, ta, sent, failing, responded,
          other: (o) => NotificationService.withEpoch(world.storage, projects.epoch, { ...options, ...o }),
          damage: async (kind, id, body) => { const ref = { kind, id }; const rec = (await world.storage.getAggregate(ref))!; await world.storage.applyOperation({ operationId: cid("dmg"), epoch: projects.epoch, actor: "owner:rob", correlationId: "dmg", at: new Date(now).toISOString(), changes: [{ type: "update", ref, expectedRevision: rec.revision, body }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never); },
          review: async () => (await reviews.request(ann, { commandId: cid("rq"), taskId: ta, operation: { name: "git-commit", args: { n: n++ }, target: { kind: "repository", id: "main" } }, context })).id,
          blocker: async (type = "manual_hold") => (await blockers.openBlocker({ commandId: cid("bl"), actor: "owner:rob", type, subject: { kind: "task", id: ta }, summary: "stuck", resolver: "owner:rob" })).id,
          resolveBlocker: async (id) => { const b = (await blockers.getBlocker(id))!; await blockers.resolveBlocker({ commandId: cid("rs"), actor: "owner:rob", blockerId: id, expectedRevision: b.revision, resolution: "fixed" }); },
          question: async () => (await inquiries.ask(ann, { commandId: cid("q"), taskId: ta, to: "owner:rob", question: "which one?" })).id,
          report: (who, kind, refKind, id, extra = {}) => who === ctl ? svc.emitFromController({ commandId: cid("n"), kind, ref: { kind: refKind, id }, ...extra } as never) : svc.emit(who, { commandId: cid("n"), kind, ref: { kind: refKind, id }, ...extra } as never),
        });
      } finally { await world.close(); }
    });

  suite("only a safety stop and a blocked critical path go at once; the rest waits for the digest, answered in one pass against the revision the owner saw", async (c) => {
    const stop = await c.report(c.ctl, "safety-stop", "host", "host-1");
    const loud = await c.report(c.ctl, "blocker", "blocker", await c.blocker("manual_hold"), { critical: true });
    const quiet = await c.report(c.ann, "blocker", "blocker", await c.blocker("wait_overdue"));
    const reviewId = await c.review();
    const review = await c.report(c.ann, "review-request", "review", reviewId);
    const question = await c.report(c.ann, "owner-question", "inquiry", await c.question());
    assert.deepEqual([stop.immediate, loud.immediate, quiet.immediate, review.immediate, question.immediate], [true, true, false, false, false]);
    assert.deepEqual((await c.svc.inbox(c.owner)).items.map((i) => i.state).sort(), ["queued", "queued", "queued", "sent", "sent"]);
    assert.deepEqual(await c.svc.runDue(), { digestIds: [], delivered: 0, failed: 0, retrying: 0 }, "nothing is collected before the owner's digest time");
    minutes(60);
    const ran = await c.svc.runDue();
    assert.equal(ran.digestIds.length, 1);
    assert.deepEqual((await c.svc.runDue()).digestIds, [], "one digest per digest time");
    const inbox = await c.svc.inbox(c.owner);
    const digest = inbox.digests[0]!;
    assert.equal(digest.itemIds.length, 3);
    const rev = (id: string) => inbox.items.find((i) => i.id === id)!.revision;
    // The answers an item offers come from its kind, not from the reporter.
    assert.deepEqual(inbox.items.find((i) => i.id === review.itemId)!.answers, ["allow", "deny"]);
    assert.deepEqual(inbox.items.find((i) => i.id === question.itemId)!.answers, []);
    const done = cid("ad");
    const result = await c.svc.answerDigest(c.owner, { commandId: done, digestId: digest.id, answers: { [review.itemId]: { answer: "allow", revision: rev(review.itemId) }, [question.itemId]: { answer: "maybe", revision: rev(question.itemId) }, [quiet.itemId]: { answer: "ok", revision: rev(quiet.itemId) }, [stop.itemId]: { answer: "ok", revision: 1 } } });
    assert.deepEqual([result.answered.sort(), result.refused.map((r) => r.itemId).sort()], [[quiet.itemId, review.itemId].sort(), [question.itemId, stop.itemId].sort()]);
    assert.equal(c.responded.length, 1);
    assert.deepEqual([c.responded[0]!.id, c.responded[0]!.answer, c.responded[0]!.commandId.startsWith("owner:rob:")], [reviewId, "allow", true]);
    // A repeat of the same command changes nothing and runs the responder no more.
    const again = await c.svc.answerDigest(c.owner, { commandId: done, digestId: digest.id, answers: { [review.itemId]: { answer: "allow", revision: rev(review.itemId) } } });
    assert.deepEqual(again.answered, [review.itemId]);
    assert.equal(c.responded.length, 1);
    // A stale view is refused: the item changed since the owner read it.
    await refuses("stale_revision", () => c.svc.answerItem(c.owner, { commandId: cid("ai"), itemId: question.itemId, answer: "ok", revision: rev(question.itemId) + 5 }));
    // A responder that refuses leaves the item open.
    const second = await c.report(c.ann, "review-request", "review", await c.review());
    const fresh = (await c.svc.inbox(c.owner)).items.find((i) => i.id === second.itemId)!;
    const refused = await c.svc.answerItem(c.owner, { commandId: cid("ai"), itemId: second.itemId, answer: "deny", revision: fresh.revision }).catch((e) => e);
    assert.ok(refused instanceof Error && /already decided/.test(refused.message));
    assert.ok((await c.svc.inbox(c.owner)).items.some((i) => i.id === second.itemId));
    // An item sent at once is answered directly, and the digest closes when its items are done.
    await c.svc.answerItem(c.owner, { commandId: cid("ai"), itemId: stop.itemId, answer: "ok", revision: (await c.svc.inbox(c.owner)).items.find((i) => i.id === stop.itemId)!.revision });
    await c.svc.answerItem(c.owner, { commandId: cid("ai"), itemId: question.itemId, answer: "ok", revision: (await c.svc.inbox(c.owner)).items.find((i) => i.id === question.itemId)!.revision });
    assert.equal((await c.svc.inbox(c.owner)).digests.length, 0);
  });

  suite("a reporter cannot hijack another project's item, interrupt, or put its own text in front of the owner", async (c) => {
    const reviewId = await c.review();
    // Another project's producer names this project's review: refused, however it phrases it.
    await refuses("forbidden", () => c.report(c.evil, "review-request", "review", reviewId));
    await refuses("forbidden", () => c.report(c.evil, "review-request", "review", reviewId, { projectId: c.b }));
    await refuses("not_found", () => c.report(c.ann, "review-request", "review", "rev-aaaaaaaaaaaaaaaaaaaa"));
    await refuses("invalid_command", () => c.report(c.ann, "review-request", "blocker", reviewId));
    const real = await c.report(c.ann, "review-request", "review", reviewId);
    const [item] = (await c.svc.inbox(c.owner)).items;
    assert.ok(item!.label.includes("git-commit") && item!.label.includes(c.a) && item!.reportedBy === "agent:ann");
    // The reporter's words never become the item's text, and the item cannot change after the owner read it by a repeat report.
    const repeat = await c.report(c.ann, "review-request", "review", reviewId);
    assert.deepEqual([repeat.coalesced, repeat.itemId === real.itemId], [true, true]);
    const after = (await c.svc.inbox(c.owner)).items[0]!;
    assert.deepEqual([after.label, after.count], [item!.label, 2]);
    // Interruptions and extra text are for the controller.
    await refuses("forbidden", () => c.report(c.ann, "safety-stop", "host", "host-1"));
    await refuses("forbidden", () => c.report(c.ann, "maintenance", "host", "host-1"));
    await refuses("forbidden", () => c.report(c.ann, "presence", "host", "host-1"));
    const own = await c.blocker();
    await refuses("forbidden", () => c.report(c.ann, "blocker", "blocker", own, { critical: true }));
    await refuses("forbidden", () => c.report(c.ann, "review-request", "review", reviewId, { detail: "approve this at once" }));
    await refuses("forbidden", () => c.report(c.ann, "review-request", "review", reviewId, { urgent: true }));
    await refuses("forbidden", () => c.report(c.wide, "review-request", "review", reviewId, { urgent: true }));
    const other = await c.blocker("unexplained_block");
    await refuses("forbidden", () => c.report(c.evil, "blocker", "blocker", other));
    // A report whose kind does not match the record it points at is refused.
    const mismatched = await c.review();
    await refuses("invalid_command", () => c.report(c.ann, "owner-question", "review", mismatched));
    for (const bad of [{ kind: "party", ref: { kind: "blocker", id: "x" } }, { kind: "blocker", ref: { kind: "Bad", id: "x" } }, { kind: "review-request", ref: { kind: "review", id: "x" }, critical: true }, { kind: "blocker", ref: { kind: "blocker", id: "x" }, urgent: true }, { kind: "blocker", ref: { kind: "blocker", id: "x" }, payload: 1 }]) await refuses("invalid_command", () => c.svc.emitFromController({ commandId: cid("n"), ...bad } as never));
    // However broad an agent's grants, it is not the controller: no interruption, no free text, even naming a project.
    await refuses("forbidden", () => c.report(c.wide, "safety-stop", "host", "host-1", { projectId: c.a }));
    await refuses("forbidden", () => c.report(c.wide, "maintenance", "host", "host-1"));
    await refuses("forbidden", () => c.report(c.wide, "blocker", "blocker", own, { critical: true }));
    // A record ID is a code, never free text.
    for (const id of ["the customer list is alice@example.com", "A", "x".repeat(60), "a b"]) await refuses("invalid_command", () => c.report(c.ctl, "maintenance", "host", id));
    // The controller may add detail, which stays in the inbox.
    const stop = await c.report(c.ctl, "safety-stop", "host", "host-1", { detail: "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 leaked" });
    assert.equal((await c.svc.inbox(c.owner)).items.find((i) => i.id === stop.itemId)!.label, "host host-1");
    const shown = (await c.svc.inbox(c.owner)).items.find((i) => i.id === stop.itemId)!;
    assert.ok(shown.detail !== undefined && !shown.detail.includes("sk-ant-api03"));
    for (const who of [c.ann, c.evil]) { await refuses("forbidden", () => c.svc.inbox(who)); await refuses("forbidden", () => c.svc.report(who)); await refuses("forbidden", () => c.svc.settings(who)); await refuses("forbidden", () => c.svc.configure(who, { commandId: cid("cf"), digestTimes: ["08:00"] })); }
  });

  suite("an item whose record was settled elsewhere is closed by the sweep and leaves the digest; one still waiting is untouched; one unreadable record does not stop the others", async (c) => {
    const resolved = await c.blocker("manual_hold"); const still = await c.blocker("wait_overdue"); const flaky = await c.blocker("unexplained_block");
    const a = await c.report(c.ann, "blocker", "blocker", resolved);
    const b = await c.report(c.ann, "blocker", "blocker", still);
    const f = await c.report(c.ann, "blocker", "blocker", flaky);
    await c.resolveBlocker(resolved); await c.resolveBlocker(flaky)
    const raw = async (id: string) => (await c.svc.inbox(c.owner)).items.find((i) => i.id === id);
    // The record of the first of the flaky pair cannot be read this tick: the error is raised after the others were closed.
    await assert.rejects(c.readsFailFor(flaky).runDue(), /storage hiccup/);
    assert.equal(await raw(a.itemId), undefined, "closed despite the failure on another");
    assert.equal((await raw(f.itemId))?.state, "queued", "the unreadable one is left for the next tick");
    assert.equal((await raw(b.itemId))?.state, "queued", "a record still waiting is untouched");
    await c.svc.runDue();
    assert.equal(await raw(f.itemId), undefined, "closed on the next tick");
    minutes(60);
    const ran = await c.svc.runDue();
    const inbox = await c.svc.inbox(c.owner);
    assert.equal(ran.digestIds.length, 1);
    assert.deepEqual(inbox.digests[0]!.itemIds, [b.itemId], "the digest carries only what still waits");
    await refuses("invalid_command", () => c.svc.answerItem(c.owner, { commandId: cid("an"), itemId: a.itemId, answer: "ok", revision: 1 }));
  });

  suite("a digest whose items were all settled elsewhere is closed by the sweep, and a settled item's waiting external message is dropped", async (c) => {
    const b1 = await c.blocker("manual_hold"); const b2 = await c.blocker("wait_overdue");
    const i1 = await c.report(c.ann, "blocker", "blocker", b1); const i2 = await c.report(c.ann, "blocker", "blocker", b2);
    minutes(60);
    const ran = await c.svc.runDue();
    assert.equal(ran.digestIds.length, 1);
    assert.equal((await c.svc.inbox(c.owner)).digests.length, 1);
    await c.resolveBlocker(b1); await c.resolveBlocker(b2);
    await c.svc.runDue();
    const inbox = await c.svc.inbox(c.owner);
    assert.deepEqual([inbox.items.some((i) => i.id === i1.itemId || i.id === i2.itemId), inbox.digests.length], [false, 0], "the digest of settled items does not stay open");
    // An escalation message waiting to be retried is dropped when its item is settled.
    set("2026-10-23T08:00:00.000Z");
    await c.svc.configure(c.owner, { commandId: cid("cf"), channel: "external", channelName: "pager", digestTimes: ["23:00"] });
    const b3 = await c.blocker("unexplained_block");
    await c.report(c.ann, "blocker", "blocker", b3);
    c.failing.on = true;
    set("2026-10-24T09:00:00.000Z");
    assert.equal((await c.svc.runDue()).retrying, 1, "the raised item's message is waiting for a retry");
    assert.equal((await c.svc.report(c.owner)).pending.length, 1);
    await c.resolveBlocker(b3);
    c.failing.on = false;
    minutes(10);
    assert.deepEqual(await c.svc.runDue(), { digestIds: [], delivered: 0, failed: 0, retrying: 0 });
    assert.equal((await c.svc.report(c.owner)).pending.length, 0, "no message is left pending");
    assert.deepEqual(c.sent, [], "nothing about the settled item was sent");
  });

  suite("an item that waits on the owner is raised to Urgent by the controller after the owner's threshold, told once, outside quiet hours, and nothing else is (card U11b)", async (c) => {
    set("2026-10-22T08:00:00.000Z");
    const waiting = await c.report(c.ann, "blocker", "blocker", await c.blocker("wait_overdue"));
    // Reported with the first one, then resolved in its own flow: it is old enough to be raised, and is not.
    const settledBlocker = await c.blocker("manual_hold");
    const settled = await c.report(c.ann, "blocker", "blocker", settledBlocker);
    await c.resolveBlocker(settledBlocker);
    const note = await c.report(c.ctl, "maintenance", "host", "host-3", { level: "notice" });
    const hours = (n: number) => set(new Date(Date.parse("2026-10-22T08:00:00.000Z") + n * 3_600_000).toISOString());
    const item = async (id: string) => (await c.svc.inbox(c.owner)).items.find((i) => i.id === id)!;
    await c.svc.runDue(); // the sweep runs once when the items are new: waits are counted from the first run with escalation on
    hours(23);
    await c.svc.runDue();
    assert.equal((await item(waiting.itemId)).urgent, false, "23 hours: not yet");
    hours(25);
    await c.svc.runDue();
    assert.equal((await c.svc.inbox(c.owner)).items.some((i) => i.id === settled.itemId), false, "a settled record is not raised, and its item is closed");
    const raised = await item(waiting.itemId);
    assert.deepEqual([raised.urgent, raised.state, raised.escalatedAt], [true, "sent", new Date(now).toISOString()]);
    assert.equal((await item(note.itemId)).urgent, false, "an item that only informs is never raised");
    hours(30);
    await c.svc.runDue();
    assert.equal((await item(waiting.itemId)).escalatedAt, raised.escalatedAt, "told once: a later tick does not raise it again");
    // The owner sets the threshold; quiet hours hold the telling until they end; an answered item is left alone.
    set("2026-10-23T08:00:00.000Z");
    await c.svc.configure(c.owner, { commandId: cid("cf"), expectedRevision: (await c.svc.settings(c.owner)).revision, escalateAfterHours: 2, urgentInterruptsQuietHours: false, quietHours: { start: "22:00", end: "10:00" } });
    const second = await c.report(c.ann, "review-request", "review", await c.review());
    set("2026-10-23T11:00:00.000Z");
    await c.svc.runDue();
    assert.equal((await item(second.itemId)).urgent, true, "a shorter threshold applies");
    const third = await c.report(c.ann, "owner-question", "inquiry", await c.question());
    set("2026-10-23T23:30:00.000Z");
    await c.svc.runDue();
    assert.equal((await item(third.itemId)).urgent, false, "inside quiet hours it is not raised");
    set("2026-10-24T10:00:00.000Z");
    const answered = await item(second.itemId);
    await c.svc.answerItem(c.owner, { commandId: cid("an"), itemId: second.itemId, answer: "allow", revision: answered.revision });
    await c.svc.runDue();
    assert.equal((await item(third.itemId)).urgent, true, "raised when quiet hours end");
    const rev = (await c.svc.settings(c.owner)).revision;
    await refuses("invalid_command", () => c.svc.configure(c.owner, { commandId: cid("cf"), expectedRevision: rev, escalateAfterHours: 0 }));
    await refuses("forbidden", () => c.svc.configure(c.ann, { commandId: cid("cf"), escalateAfterHours: 1 }));
    // null turns escalation off: nothing is raised however long it waits; only the owner; a number turns it on again.
    await refuses("forbidden", () => c.svc.configure(c.ann, { commandId: cid("cf-off"), escalateAfterHours: null }));
    await c.svc.configure(c.owner, { commandId: cid("cf-off"), expectedRevision: rev, escalateAfterHours: null, quietHours: null });
    assert.equal((await c.svc.settings(c.owner)).escalateAfterHours, null);
    const fourth = await c.report(c.ann, "owner-question", "inquiry", await c.question());
    set("2026-11-24T10:00:00.000Z");
    await c.svc.runDue();
    assert.equal((await item(fourth.itemId)).urgent, false, "escalation is off");
    await c.svc.configure(c.owner, { commandId: cid("cf-on"), expectedRevision: (await c.svc.settings(c.owner)).revision, escalateAfterHours: 5 });
    await c.svc.runDue();
    assert.equal((await item(fourth.itemId)).urgent, false, "switching it on again starts the clock afresh, so the old backlog is not raised at once");
    set("2026-11-24T16:00:00.000Z");
    await c.svc.runDue();
    assert.equal((await item(fourth.itemId)).urgent, true, "on again: raised once it has waited the threshold since then");
  });

  suite("quiet hours hold the digest and an urgent review until they end; a safety stop is never held; a settings change counts from the next notification", async (c) => {
    await c.svc.configure(c.owner, { commandId: cid("cf"), quietHours: { start: "22:00", end: "10:00" }, digestTimes: ["09:00", "18:00"] });
    set("2026-10-22T08:30:00.000Z");
    const early = await c.report(c.ann, "blocker", "blocker", await c.blocker());
    set("2026-10-22T09:30:00.000Z");
    const urgent = await c.report(c.ctl, "review-request", "review", await c.review(), { urgent: true });
    const stop = await c.report(c.ctl, "safety-stop", "host", "host-9");
    assert.deepEqual([urgent.immediate, stop.immediate], [false, true]);
    assert.deepEqual((await c.svc.runDue()).digestIds, [], "no digest inside quiet hours");
    set("2026-10-22T10:00:00.000Z");
    const ran = await c.svc.runDue();
    assert.equal(ran.digestIds.length, 1, "the missed 09:00 digest goes out when quiet hours end");
    const inbox = await c.svc.inbox(c.owner);
    assert.deepEqual(inbox.digests[0]!.itemIds, [early.itemId], "only what was waiting at 09:00");
    assert.equal(inbox.items.find((i) => i.id === urgent.itemId)!.state, "sent", "the urgent review waited out the quiet hours and was sent when they ended");
    // Outside quiet hours an urgent review goes at once; a settings change counts from the next one.
    set("2026-10-22T14:00:00.000Z");
    assert.equal((await c.report(c.ctl, "review-request", "review", await c.review(), { urgent: true })).immediate, true);
    const settings = await c.svc.settings(c.owner);
    await c.svc.configure(c.owner, { commandId: cid("cf"), expectedRevision: settings.revision, quietHours: null });
    set("2026-10-22T23:00:00.000Z");
    assert.equal((await c.report(c.ctl, "review-request", "review", await c.review(), { urgent: true })).immediate, true);
    await refuses("stale_revision", () => c.svc.configure(c.owner, { commandId: cid("cf"), expectedRevision: settings.revision, digestTimes: ["08:00"] }));
    const current = (await c.svc.settings(c.owner)).revision;
    for (const bad of [{ digestTimes: [] }, { digestTimes: ["25:00"] }, { quietHours: { start: "22:00", end: "22:00" } }, { channel: "external" as const }, { channel: "smoke" as never }]) await refuses("invalid_command", () => c.svc.configure(c.owner, { commandId: cid("cf"), expectedRevision: current, ...bad } as never));
  });

  suite("the same event while open is one item with a count, per project; once answered a new occurrence starts and the earlier answer stays on record; a large backlog becomes several digests", async (c) => {
    const reviewId = await c.review();
    const first = await c.report(c.ann, "review-request", "review", reviewId);
    const second = await c.report(c.ann, "review-request", "review", reviewId);
    assert.deepEqual([first.coalesced, second.coalesced, second.itemId === first.itemId], [false, true, true]);
    assert.equal((await c.svc.inbox(c.owner)).items[0]!.count, 2);
    const view = (await c.svc.inbox(c.owner)).items[0]!;
    await c.svc.answerItem(c.owner, { commandId: cid("ai"), itemId: first.itemId, answer: "allow", revision: view.revision });
    assert.equal((await c.svc.inbox(c.owner)).items.length, 0);
    const third = await c.report(c.ann, "review-request", "review", reviewId);
    assert.deepEqual([third.coalesced, third.itemId === first.itemId], [false, false], "a new occurrence, not an overwrite");
    // The first answer is still on record.
    await c.svc.answerItem(c.owner, { commandId: cid("ai"), itemId: first.itemId, answer: "allow", revision: view.revision });
    // An item that keeps being reported can still be answered from the view the owner had.
    const live = await c.report(c.ann, "owner-question", "inquiry", await c.question());
    const seen = (await c.svc.inbox(c.owner)).items.find((i) => i.id === live.itemId)!;
    for (let i = 0; i < 3; i++) await c.report(c.ann, "owner-question", "inquiry", seen.ref.id);
    assert.ok((await c.svc.inbox(c.owner)).items.find((i) => i.id === live.itemId)!.revision > seen.revision);
    await refuses("stale_revision", () => c.svc.answerItem(c.owner, { commandId: cid("ai"), itemId: live.itemId, answer: "ok", revision: 999 }));
    await c.svc.answerItem(c.owner, { commandId: cid("ai"), itemId: live.itemId, answer: "ok", revision: seen.revision });
    // A replayed report is the same report.
    const id = cid("n");
    const x = await c.svc.emitFromController({ commandId: id, kind: "maintenance", level: "notice", ref: { kind: "host", id: "h-1" } });
    const y = await c.svc.emitFromController({ commandId: id, kind: "maintenance", level: "notice", ref: { kind: "host", id: "h-1" } });
    assert.equal(x.itemId, y.itemId);
    for (let i = 0; i < 55; i++) await c.report(c.ann, "review-request", "review", await c.review());
    minutes(60);
    const ran = await c.svc.runDue();
    assert.equal(ran.digestIds.length, 2, "56 reviews: fifty to a digest");
    const inbox = await c.svc.inbox(c.owner);
    assert.deepEqual(inbox.digests.map((d) => d.itemIds.length).sort((p, q) => p - q), [6, 50]);
  });

  suite("a Notice is never pushed: it stays in the inbox, is counted in the digest message without its text, and the levels are told apart (card U11b)", async (c) => {
    await c.svc.configure(c.owner, { commandId: cid("cf"), channel: "external", channelName: "pager", digestTimes: ["09:00", "20:00"] });
    const note = await c.report(c.ctl, "maintenance", "host", "host-secret-1", { detail: "private note", level: "notice" });
    const present = await c.report(c.ctl, "presence", "host", "host-2");
    const asks = await c.report(c.ann, "owner-question", "inquiry", await c.question());
    const stop = await c.report(c.ctl, "safety-stop", "host", "host-9");
    assert.deepEqual([note.immediate, present.immediate], [false, false]);
    const level = async (id: string) => (await c.svc.inbox(c.owner)).items.find((i) => i.id === id)!.level;
    assert.deepEqual([await level(note.itemId), await level(present.itemId), await level(asks.itemId), await level(stop.itemId)], ["notice", "notice", "needs-you", "urgent"]);
    await c.svc.runDue();
    assert.deepEqual(c.sent.map((s) => s.text.split(":")[0]), ["safety-stop"], "only the stop went at once");
    minutes(60);
    const ran = await c.svc.runDue();
    assert.equal(ran.digestIds.length, 1);
    assert.equal(ran.delivered, 1);
    const digestText = c.sent[1]!.text;
    assert.match(digestText, /^1 item for you:/);
    assert.match(digestText, /2 notices in your inbox, no action needed\.$/);
    assert.ok(!/maintenance|presence|host-secret|private note/.test(digestText), "no Notice text leaves the installation");
    const inbox = await c.svc.inbox(c.owner);
    assert.equal(inbox.digests[0]!.itemIds.length, 1, "the digest lists only what needs a decision");
    const counted = inbox.items.find((i) => i.id === note.itemId)!;
    assert.deepEqual([counted.state, counted.countedAt, counted.digestId], ["sent", new Date(now).toISOString(), undefined], "counted once and still in the inbox");
    // A later digest time with only Notices waiting counts them quietly: no digest, no message.
    const more = await c.report(c.ctl, "maintenance", "host", "host-3", { level: "notice" });
    set("2026-10-22T20:30:00.000Z");
    const next = await c.svc.runDue();
    assert.deepEqual([next.digestIds, next.delivered, c.sent.length], [[], 0, 2], "a Notice alone is never pushed");
    const after = (await c.svc.inbox(c.owner)).items.find((i) => i.id === more.itemId)!;
    assert.equal(after.state, "sent");
    assert.equal(after.countedAt, new Date(now).toISOString());
    assert.equal((await c.svc.report(c.owner)).pending.length, 0);
    // The owner closes a Notice with "ok".
    await c.svc.answerItem(c.owner, { commandId: cid("ai"), itemId: more.itemId, answer: "ok", revision: after.revision });
    assert.equal((await c.svc.inbox(c.owner)).items.some((i) => i.id === more.itemId), false);
  });

  suite("the controller names the level: a maintenance item that needs a decision is told and escalated, a pure notice is only counted; an agent cannot set a level (card U11b)", async (c) => {
    await c.svc.configure(c.owner, { commandId: cid("cf"), channel: "external", channelName: "pager", digestTimes: ["09:00"] });
    const budget = await c.report(c.ctl, "maintenance", "budget-request", "bgt-1", { level: "needs-you", detail: "asked for more budget. Decide it with budget.decide." });
    const unnamed = await c.report(c.ctl, "maintenance", "host", "host-unnamed");
    const info = await c.report(c.ctl, "maintenance", "host", "host-info", { level: "notice" });
    const level = async (id: string) => (await c.svc.inbox(c.owner)).items.find((i) => i.id === id)!.level;
    assert.deepEqual([await level(budget.itemId), await level(unnamed.itemId), await level(info.itemId)], ["needs-you", "needs-you", "notice"], "no level means Needs you, never Notice");
    await refuses("forbidden", () => c.report(c.ann, "owner-question", "inquiry", "q-1", { level: "notice" }));
    await refuses("invalid_command", () => c.report(c.ctl, "maintenance", "host", "host-bad", { level: "loud" }));
    minutes(60);
    await c.svc.runDue();
    const digest = c.sent.map((s) => s.text).find((t) => /items? for you/.test(t))!;
    assert.match(digest, /maintenance: budget-request bgt-1/);
    assert.match(digest, /1 notice in your inbox, no action needed\.$/);
    assert.ok(!/host-info/.test(digest), "the pure notice is only counted");
    // Unanswered for a day: a maintenance item has no owner-wait semantics, so it is NOT raised on its own (its producer closes it when the condition is gone) ...
    set("2026-10-23T10:00:00.000Z");
    await c.svc.runDue();
    const quietly = (await c.svc.inbox(c.owner)).items;
    assert.deepEqual([quietly.find((i) => i.id === budget.itemId)!.level, quietly.find((i) => i.id === unnamed.itemId)!.level], ["needs-you", "needs-you"], "not escalated unless the owner set the level");
    // ... unless the owner says maintenance items matter: then they are raised to Urgent and told.
    await c.svc.configure(c.owner, { commandId: cid("cf"), expectedRevision: (await c.svc.settings(c.owner)).revision, levelByKind: { maintenance: "needs-you" } });
    await c.svc.runDue();
    const items = (await c.svc.inbox(c.owner)).items;
    assert.deepEqual([items.find((i) => i.id === budget.itemId)!.level, items.find((i) => i.id === unnamed.itemId)!.level, items.find((i) => i.id === info.itemId)!.level], ["urgent", "urgent", "urgent"], "the owner's setting applies to every maintenance item");
    assert.equal(c.sent.filter((s) => s.text.startsWith("URGENT") && s.text.includes("budget-request")).length, 1);
  });

  suite("the first run on a backlog does not flood the owner: waits count from the first sweep with escalation on, and at most the hourly number of Urgent messages go out, the rest in ONE message (card U11b review)", async (c) => {
    await c.svc.configure(c.owner, { commandId: cid("cf"), channel: "external", channelName: "pager" });
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) { ids.push((await c.report(c.ann, "owner-question", "inquiry", await c.question())).itemId); ids.push((await c.report(c.ann, "review-request", "review", await c.review())).itemId); }
    // Three days later the controller is upgraded and the sweep runs for the first time: every item is older than 24 hours, and none is raised.
    set("2026-10-25T08:00:00.000Z");
    await c.svc.runDue();
    assert.equal((await c.svc.inbox(c.owner)).items.filter((i) => i.urgent).length, 0, "nothing is raised for waiting that happened before the sweep existed");
    assert.deepEqual(c.sent.filter((m) => m.text.startsWith("URGENT")), []);
    // A day later all 14 qualify at once: ten messages at most, the rest in one.
    set("2026-10-26T09:00:00.000Z");
    for (let k = 0; k < 4; k++) await c.svc.runDue(); // five sends a run
    const told = c.sent.filter((m) => m.text.startsWith("URGENT"));
    assert.equal(told.length, DEFAULT_ESCALATIONS_PER_HOUR, JSON.stringify(told.map((m) => m.text)));
    assert.equal(told.filter((m) => /5 more items escalated/.test(m.text)).length, 1, "the rest are one message");
    assert.equal((await c.svc.inbox(c.owner)).items.filter((i) => i.urgent).length, 14, "every item is Urgent in the inbox");
    // The allowance is spent for the hour; a later item waits for the next hour, then goes.
    const late = (await c.report(c.ann, "review-request", "review", await c.review())).itemId;
    set("2026-10-27T10:00:00.000Z");
    for (let k = 0; k < 2; k++) await c.svc.runDue();
    assert.equal(c.sent.filter((m) => m.text.startsWith("URGENT")).length, DEFAULT_ESCALATIONS_PER_HOUR + 1, "a new hour has room again");
    assert.equal((await c.svc.inbox(c.owner)).items.find((i) => i.id === late)!.urgent, true);
    // The figure is the owner's.
    await refuses("invalid_command", async () => c.svc.configure(c.owner, { commandId: cid("cf"), expectedRevision: (await c.svc.settings(c.owner)).revision, escalationsPerHour: 0 }));
    await c.svc.configure(c.owner, { commandId: cid("cf"), expectedRevision: (await c.svc.settings(c.owner)).revision, escalationsPerHour: 2, sweepEverySeconds: 30, sendTimeoutSeconds: 5, urgentInterruptsQuietHours: false });
    const st = await c.svc.settings(c.owner);
    assert.deepEqual([st.escalationsPerHour, st.sweepEverySeconds, st.sendTimeoutSeconds, st.urgentInterruptsQuietHours], [2, 30, 5, false]);
  });

  suite("a hung channel adapter costs one timeout, never the run: sends are bounded in time and number and no adapter is called inside a storage transaction (card U11b review)", async (c) => {
    await c.svc.configure(c.owner, { commandId: cid("cf"), channel: "external", channelName: "pager" });
    for (let i = 0; i < 8; i++) await c.report(c.ctl, "safety-stop", "host", `host-${i}`);
    let calls = 0; let aborted = 0;
    const hanging = c.other({ channels: { pager: { send: (m) => { calls++; m.signal?.addEventListener("abort", () => { aborted++; }); return new Promise<void>(() => undefined); } } }, sendTimeoutMs: 40 });
    const t0 = Date.now();
    const ran = await hanging.runDue();
    assert.ok(Date.now() - t0 < 5_000, `the run returned in ${Date.now() - t0} ms`);
    assert.equal(calls, NOTIFICATION_LIMITS.deliveriesPerRun, "at most five sends are tried in a run");
    assert.deepEqual([ran.retrying, ran.delivered, ran.failed], [NOTIFICATION_LIMITS.deliveriesPerRun, 0, 0]);
    assert.equal(aborted, NOTIFICATION_LIMITS.deliveriesPerRun, "each hung send was told to stop");
    // The run's own time budget: once it is used, no further send is started.
    calls = 0;
    minutes(2);
    const tight = c.other({ channels: { pager: { send: () => { calls++; return new Promise<void>(() => undefined); } } }, sendTimeoutMs: 60, runBudgetMs: 100 });
    await tight.runDue();
    assert.ok(calls >= 1 && calls < NOTIFICATION_LIMITS.deliveriesPerRun, `the budget stopped the run after ${calls} sends`);
    // A send that is in flight sees no transaction: reading and writing the store from inside the adapter works (it would deadlock or conflict inside one).
    let inside: unknown;
    minutes(10);
    const probing = c.other({ channels: { pager: { send: async () => { inside = (await c.svc.inbox(c.owner)).items.length; } } } });
    await probing.runDue();
    assert.ok(typeof inside === "number", "the adapter ran with the store free");
  });

  suite("one damaged item does not hold back the escalations behind it; the first failure is raised after the others were tried (card U11b review)", async (c) => {
    const b1 = await c.blocker("manual_hold"), b2 = await c.blocker("wait_overdue");
    const first = await c.report(c.ann, "blocker", "blocker", b1);
    minutes(1);
    const second = await c.report(c.ann, "blocker", "blocker", b2);
    await c.svc.runDue();
    set("2026-10-23T10:00:00.000Z");
    // The record the first item points at is damaged: describing it throws.
    await c.damage("blocker", b1, { state: "open" });
    await assert.rejects(() => c.svc.runDue(), (e: unknown) => e instanceof Error);
    const items = (await c.svc.inbox(c.owner)).items;
    assert.equal(items.find((i) => i.id === second.itemId)!.urgent, true, "the item behind the damaged one was raised");
    assert.equal(items.find((i) => i.id === first.itemId)!.urgent, false);
    // Closing what was settled elsewhere is likewise per item.
    await c.svc.runDue().catch(() => undefined);
  });

  suite("the sweep is throttled and cheap between full sweeps: a damaged record is not read again before the next one is due (card U11b review)", async (c) => {
    const b1 = await c.blocker("manual_hold");
    await c.report(c.ann, "blocker", "blocker", b1);
    await c.svc.runDue({ throttled: true });
    await c.damage("blocker", b1, { state: "open" });
    minutes(30 / 60);
    await c.svc.runDue({ throttled: true }); // within the 60 seconds: no full sweep, so the damaged record is not touched and nothing throws
    minutes(2);
    await assert.rejects(() => c.svc.runDue({ throttled: true }), (e: unknown) => e instanceof Error, "the next full sweep reads it again");
  });

  suite("a delivery given up on tells the owner once; a channel nobody registered is refused when set (card U11b review)", async (c) => {
    await c.svc.configure(c.owner, { commandId: cid("cf"), channel: "external", channelName: "pager" });
    c.failing.on = true;
    await c.report(c.ctl, "safety-stop", "host", "host-a");
    await c.svc.runDue();
    for (const wait of [1, 5, 30, 120]) { minutes(wait); await c.svc.runDue(); }
    const notice = async () => (await c.svc.inbox(c.owner)).items.filter((i) => i.kind === "maintenance" && i.ref.kind === "notification-delivery");
    assert.equal((await notice()).length, 1, "the owner is told in the inbox that a message could not be delivered");
    assert.equal((await notice())[0]!.level, "needs-you");
    // A second failure while that notice is open coalesces into it.
    await c.report(c.ctl, "safety-stop", "host", "host-b");
    await c.svc.runDue();
    for (const wait of [1, 5, 30, 120]) { minutes(wait); await c.svc.runDue(); }
    const after = await notice();
    assert.deepEqual([after.length, after[0]!.count], [1, 2]);
  });

  suite("a maintenance item is closed by the service that reported it, never escalated on its own, and the owner can ask for it to matter (card U11b review)", async (c) => {
    const rep = await c.report(c.ctl, "maintenance", "host", "host-7");
    await c.svc.runDue();
    set("2026-10-30T08:00:00.000Z");
    await c.svc.runDue();
    assert.equal((await c.svc.inbox(c.owner)).items.find((i) => i.id === rep.itemId)!.urgent, false, "waiting alone does not make a maintenance item Urgent");
    assert.deepEqual(await c.svc.settleFromController({ commandId: cid("st"), kind: "maintenance", ref: { kind: "host", id: "host-7" } }), { closed: true });
    assert.equal((await c.svc.inbox(c.owner)).items.some((i) => i.id === rep.itemId), false, "the condition is gone: the item leaves the inbox");
    assert.deepEqual(await c.svc.settleFromController({ commandId: cid("st"), kind: "maintenance", ref: { kind: "host", id: "host-7" } }), { closed: false });
    const again = await c.report(c.ctl, "maintenance", "host", "host-7");
    assert.notEqual(again.itemId, rep.itemId, "a later occurrence is a new item");
  });

  suite("quiet hours are read in the owner's time zone (UTC when none is set) (card U11b review)", async (c) => {
    await c.svc.configure(c.owner, { commandId: cid("cf"), quietHours: { start: "22:00", end: "07:00" } });
    const tokyo = c.other({ timeZone: async () => "Asia/Tokyo" });
    const nowhere = c.other({ timeZone: async () => "Not/AZone" });
    set("2026-10-22T14:00:00.000Z"); // 14:00 UTC, 23:00 in Tokyo
    assert.equal((await tokyo.emitFromController({ commandId: cid("n"), kind: "review-request", ref: { kind: "review", id: await c.review() }, urgent: true })).immediate, false, "23:00 in Tokyo is quiet");
    assert.equal((await c.report(c.ctl, "review-request", "review", await c.review(), { urgent: true })).immediate, true, "with no time zone it is 14:00 UTC, not quiet");
    assert.equal((await nowhere.emitFromController({ commandId: cid("n"), kind: "review-request", ref: { kind: "review", id: await c.review() }, urgent: true })).immediate, true, "an unknown zone falls back to UTC");
  });

  suite("a retry of an Urgent message goes out in quiet hours by default and waits for their end when the owner switched that off; other messages always wait (card U11b review)", async (c) => {
    await c.svc.configure(c.owner, { commandId: cid("cf"), channel: "external", channelName: "pager", quietHours: { start: "22:00", end: "10:00" } });
    set("2026-10-22T21:58:00.000Z");
    c.failing.on = true;
    await c.report(c.ctl, "safety-stop", "host", "host-q");
    assert.equal((await c.svc.runDue()).retrying, 1);
    c.failing.on = false;
    set("2026-10-22T22:05:00.000Z");
    assert.equal((await c.svc.runDue()).delivered, 1, "an Urgent retry is sent inside quiet hours by default");
    await c.svc.configure(c.owner, { commandId: cid("cf"), expectedRevision: (await c.svc.settings(c.owner)).revision, urgentInterruptsQuietHours: false });
    set("2026-10-22T23:00:00.000Z");
    c.failing.on = true;
    await c.report(c.ctl, "safety-stop", "host", "host-r");
    assert.equal((await c.svc.runDue()).retrying, 0, "switched off: held until quiet hours end (nothing is tried)");
    c.failing.on = false;
    set("2026-10-23T10:00:00.000Z");
    assert.equal((await c.svc.runDue()).delivered, 1, "sent when they end");
  });

  suite("digestsPerRun * digestItems covers openItems, so a digest pass can carry every open item", async () => {
    assert.ok(NOTIFICATION_LIMITS.digestsPerRun * NOTIFICATION_LIMITS.digestItems >= NOTIFICATION_LIMITS.openItems);
  });

  suite("the owner sets the level per kind: moved to notice and back, agents cannot, a safety stop stays Urgent (card U11b)", async (c) => {
    const ask = await c.report(c.ctl, "maintenance", "budget-request", "bgt-5");
    const level = async () => (await c.svc.inbox(c.owner)).items.find((i) => i.id === ask.itemId)!.level;
    assert.equal(await level(), "needs-you");
    const rev = async () => (await c.svc.settings(c.owner)).revision;
    await c.svc.configure(c.owner, { commandId: cid("cf"), expectedRevision: await rev(), levelByKind: { maintenance: "notice" } });
    assert.equal(await level(), "notice", "the owner's choice overrides the default");
    assert.equal((await c.svc.settings(c.owner)).levelByKind?.maintenance, "notice");
    await c.svc.configure(c.owner, { commandId: cid("cf"), expectedRevision: await rev(), levelByKind: { maintenance: "needs-you" } });
    assert.equal(await level(), "needs-you");
    await c.svc.configure(c.owner, { commandId: cid("cf"), expectedRevision: await rev(), levelByKind: { maintenance: "notice" } });
    await c.svc.configure(c.owner, { commandId: cid("cf"), expectedRevision: await rev(), levelByKind: { maintenance: null } });
    assert.deepEqual([await level(), (await c.svc.settings(c.owner)).levelByKind], ["needs-you", undefined]);
    for (const who of [c.ann, c.wide]) await refuses("forbidden", () => c.svc.configure(who, { commandId: cid("cf"), expectedRevision: 0, levelByKind: { maintenance: "notice" } }));
    await refuses("invalid_command", async () => c.svc.configure(c.owner, { commandId: cid("cf"), expectedRevision: await rev(), levelByKind: { safety_stop: "notice" } as never }));
    await refuses("invalid_command", async () => c.svc.configure(c.owner, { commandId: cid("cf"), expectedRevision: await rev(), levelByKind: { "safety-stop": "notice" } }));
    const stop = await c.report(c.ctl, "safety-stop", "host", "host-77");
    assert.equal((await c.svc.inbox(c.owner)).items.find((i) => i.id === stop.itemId)!.level, "urgent");
  });

  suite("Notices counted quietly are reported later, and a digest tells the true number of Notices it marked (card U11b)", async (c) => {
    await c.svc.configure(c.owner, { commandId: cid("cf"), channel: "external", channelName: "pager", digestTimes: ["09:00"] });
    const told = () => c.sent.map((s) => s.text).filter((t) => /in your inbox, no action needed/.test(t));
    for (let i = 0; i < 3; i++) await c.report(c.ctl, "presence", "host", `quiet-${i}`);
    minutes(90);
    assert.deepEqual([(await c.svc.runDue()).digestIds, c.sent.length], [[], 0], "counted quietly: nothing is sent");
    for (let i = 0; i < 120; i++) await c.report(c.ctl, "presence", "host", `loud-${i}`);
    await c.report(c.ctl, "maintenance", "budget-request", "bgt-9", { level: "needs-you" });
    set("2026-10-23T09:10:00.000Z");
    await c.svc.runDue();
    assert.match(told().at(-1)!, /123 notices in your inbox, no action needed\.$/, "the 120 marked in the pass plus the 3 counted quietly before");
    const items = (await c.svc.inbox(c.owner)).items.filter((i) => i.kind === "presence");
    assert.equal(items.filter((i) => i.mentionedAt !== undefined).length, 123);
    // Told once: a later pass with a new Notice does not tell the old ones again.
    await c.report(c.ctl, "presence", "host", "later-1");
    await c.report(c.ctl, "maintenance", "budget-request", "bgt-10", { level: "needs-you" });
    set("2026-10-24T09:05:00.000Z");
    await c.svc.runDue();
    assert.match(told().at(-1)!, /1 notice in your inbox, no action needed\.$/);
  });

  suite("Notices are closed after their retention and never block what needs the owner (card U11b)", async (c) => {
    for (let i = 0; i < 1100; i++) await c.report(c.ctl, "presence", "host", `flood-${i}`);
    const open = (await c.svc.inbox(c.owner)).items;
    assert.equal(open.filter((i) => i.state !== "settled").length, NOTIFICATION_LIMITS.openNotices, "the oldest Notices were closed to keep the cap");
    const blocker = await c.report(c.ann, "blocker", "blocker", await c.blocker("manual_hold"));
    assert.equal(blocker.coalesced, false, "a blocker is still taken in");
    const review = await c.report(c.ann, "review-request", "review", await c.review());
    assert.ok(review.itemId);
    assert.equal((await c.svc.inbox(c.owner)).items.filter((i) => i.level === "needs-you").length, 2);
    // Retention: settable, default 7 days.
    await refuses("invalid_command", () => c.svc.configure(c.owner, { commandId: cid("cf"), noticeRetentionDays: 0 }));
    set("2026-10-29T07:00:00.000Z");
    await c.svc.runDue();
    assert.equal((await c.svc.inbox(c.owner)).items.filter((i) => i.level === "notice").length, NOTIFICATION_LIMITS.openNotices, "6 days: kept");
    set("2026-10-29T09:00:00.000Z");
    await c.svc.runDue();
    assert.equal((await c.svc.inbox(c.owner)).items.filter((i) => i.level === "notice").length, 0, "past 7 days: closed");
    assert.equal((await c.svc.inbox(c.owner)).items.filter((i) => i.level !== "notice").length, 2, "what needs the owner stays (raised to Urgent by now)");
    await c.svc.configure(c.owner, { commandId: cid("cf"), noticeRetentionDays: 1 });
    assert.equal((await c.svc.settings(c.owner)).noticeRetentionDays, 1);
  });

  suite("nothing leaves the installation unless an external channel is configured, and then only the controller-built label; failures are visible and bounded", async (c) => {
    await c.report(c.ctl, "safety-stop", "host", "host-1", { detail: "private detail" });
    assert.deepEqual([c.sent.length, (await c.svc.report(c.owner)).pending.length], [0, 0], "inbox only by default");
    await c.svc.configure(c.owner, { commandId: cid("cf"), channel: "external", channelName: "pager" });
    c.failing.on = true;
    await c.report(c.ctl, "safety-stop", "host", "host-2", { detail: "customer data 4111-1111-1111-1111" });
    assert.deepEqual(await c.svc.runDue(), { digestIds: [], delivered: 0, failed: 0, retrying: 1 });
    let report = await c.svc.report(c.owner);
    assert.equal(report.pending.length, 1);
    assert.ok(!JSON.stringify(report).includes("abcd1234efgh5678ijkl") && !JSON.stringify(report).includes("4111"), "no secret or detail in the report or the stored text");
    assert.deepEqual(await c.svc.runDue(), { digestIds: [], delivered: 0, failed: 0, retrying: 0 }, "not retried before its time");
    for (const wait of [1, 5, 30]) { minutes(wait); assert.equal((await c.svc.runDue()).retrying, 1); }
    minutes(120);
    assert.deepEqual(await c.svc.runDue(), { digestIds: [], delivered: 0, failed: 1, retrying: 0 });
    report = await c.svc.report(c.owner);
    assert.deepEqual([report.pending.length, report.failed.length, report.failed[0]!.attempts], [0, 1, 5]);
    assert.match(report.failed[0]!.lastError!, /webhook down/);
    c.failing.on = false;
    const ok = await c.report(c.ctl, "safety-stop", "host", "host-3", { detail: "do not send this" });
    assert.deepEqual(await c.svc.runDue(), { digestIds: [], delivered: 1, failed: 0, retrying: 0 });
    assert.deepEqual(c.sent.map((s) => s.links), [[{ kind: "notification-item", id: ok.itemId }]]);
    assert.ok(c.sent.every((s) => !s.text.includes("do not send") && s.text.startsWith("safety-stop: host ")));
    // A pending delivery whose channel was switched off settles as failed instead of waiting for ever; a channel with no adapter fails visibly.
    await c.report(c.ctl, "safety-stop", "host", "host-4");
    await c.svc.configure(c.owner, { commandId: cid("cf"), expectedRevision: (await c.svc.settings(c.owner)).revision, channel: "inbox" });
    assert.deepEqual(await c.svc.runDue(), { digestIds: [], delivered: 0, failed: 1, retrying: 0 });
    // A channel nobody registered is refused when the owner sets it (otherwise every message to it would fail in silence).
    await refuses("invalid_command", async () => c.svc.configure(c.owner, { commandId: cid("cf"), expectedRevision: (await c.svc.settings(c.owner)).revision, channel: "external", channelName: "ghost" }).catch((e) => { assert.match(String(e.message), /no channel adapter named ghost/); throw e; }));
  });
}
