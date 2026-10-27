import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AgentService } from "../agents/index.js";
import { DeskService, HistoryService, RetrievalService } from "../context/index.js";
import type { Availability } from "../conversations/index.js";
import { AssignmentService } from "../domain/assignments.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { WaitService } from "../domain/waits.js";
import { InquiryService } from "../inquiries/index.js";
import { PauseService } from "../lifecycle/index.js";
import { MeetingService } from "../meetings/index.js";
import { NotificationService } from "../notifications/index.js";
import { GrantService, PrincipalService, type Grant, type Principal } from "../security/index.js";
import { AgentMessageService, MESSAGE_LIMITS, type SendAgentMessage } from "./index.js";

after(stopServer);

// The only clock anything here reads. Tests move it; nothing sleeps.
let now = Date.parse("2026-10-22T10:00:00.000Z");
const iso = (ms = 0): string => new Date(now + ms).toISOString();
const MIN = 60_000;
const options = { clock: () => new Date(now).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};

for (const backend of backends) {
  interface Who { p: Principal; pid: string; aid: string }
  interface Ctx {
    owner: Principal; a: string; b: string; ownerId: string;
    ann: Who; ben: Who; cat: Who; boss: Who; urg: Who; eve: Who;
    tAnn: string; tBen: string; tOther: string;
    msgs: AgentMessageService; reopen(over?: Partial<ConstructorParameters<typeof Object>[0]>): AgentMessageService;
    pauses: PauseService; other: Map<string, Availability>; waits: WaitService; projects: ProjectService; assignments: AssignmentService; meetings: MeetingService; notifications: NotificationService; inquiries: InquiryService;
    host: Principal; principals: PrincipalService; grants: GrantService; agentsSvc: AgentService;
    agent(name: string, grants?: Grant[], extra?: { supervisorId?: string; teamId?: string }): Promise<Who>;
    task(title: string, assignTo?: string, project?: string): Promise<string>;
    depWait(taskId: string, resolver: string): Promise<{ id: string; revision: number }>;
    send(who: Who, extra: Partial<SendAgentMessage> & { to: string; taskId: string }): ReturnType<AgentMessageService["send"]>;
    storage: Parameters<typeof PauseService.withEpoch>[0]; epoch: number;
  }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      now = Date.parse("2026-10-22T10:00:00.000Z");
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const epoch = projects.epoch;
        const principals = PrincipalService.withEpoch(world.storage, epoch, options);
        const agents = AgentService.withEpoch(world.storage, epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const a = (await projects.createProject({ commandId: cid("pa"), actor: owner.id, name: "Alpha" })).id;
        const b = (await projects.createProject({ commandId: cid("pb"), actor: owner.id, name: "Beta" })).id;
        const base = (p: string): Grant[] => [{ action: "message.send", project: p }, { action: "task.read", project: p }, { action: "attempt.work", project: p }, { action: "history.*", project: p }, { action: "desk.write", project: p }, { action: "desk.read", project: p }];
        const agent = async (nm: string, grants: Grant[] = base(a), extra: { supervisorId?: string; teamId?: string } = {}): Promise<Who> => {
          const aid = (await agents.create(owner, { commandId: cid("ag"), friendlyName: nm, ...extra })).id;
          const pid = `agent:${aid}`;
          const f = await world.storage.getAggregate({ kind: "principal", id: pid });
          await principals.setGrants(owner, { commandId: cid("sg"), principalId: pid, expectedRevision: f!.revision, grants });
          return { p: await principals.authenticate((await principals.issueCredential(owner, pid)).token), pid, aid };
        };
        const boss = await agent("boss", [...base(a), { action: "agent.manage", project: "*" }]);
        const ann = await agent("ann"), ben = await agent("ben", base(a), { supervisorId: boss.aid }), cat = await agent("cat");
        const urg = await agent("urg", [...base(a), { action: "message.urgent", project: a }]);
        const eve = await agent("eve", base(b));
        const host = await principals.authenticate((await (async () => { await principals.enroll(owner, { commandId: cid("e"), kind: "host", name: "h1", grants: [] }); return principals.issueCredential(owner, "host:h1"); })()).token);
        const grants = GrantService.withEpoch(world.storage, epoch, options);
        const other = new Map<string, Availability>();
        const assignments = AssignmentService.withEpoch(world.storage, epoch, projects, options);
        const waits = WaitService.withEpoch(world.storage, epoch, assignments, options);
        const pauses = PauseService.withEpoch(world.storage, epoch, { waits }, { ...options, otherAvailability: async (id) => other.get(id) ?? "available" });
        const histories = HistoryService.withEpoch(world.storage, epoch, options);
        const desks = DeskService.withEpoch(world.storage, epoch, options);
        const retrieval = RetrievalService.withEpoch(world.storage, epoch, desks, histories, options);
        const inquiries = InquiryService.withEpoch(world.storage, epoch, { histories, retrieval, waits, assignments }, options);
        const notifications = NotificationService.withEpoch(world.storage, epoch, options);
        const meetings = MeetingService.withEpoch(world.storage, epoch, { inquiries }, { availability: pauses.availability, invitations: { async invite() { /* not needed */ } }, ...options });
        const make = (over: object = {}) => AgentMessageService.withEpoch(world.storage, epoch, { availability: pauses.availability, taskPaused: (t) => pauses.isPaused(t), guard: (t) => pauses.guard(t), waits, assignments, meetings, inquiries, notifications, ...options, ...over });
        const task = async (title: string, assignTo?: string, project = a): Promise<string> => {
          const id = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title })).id;
          await projects.transitionTask({ commandId: cid("r"), actor: owner.id, taskId: id, expectedRevision: 1, to: "ready" });
          if (assignTo !== undefined) await assignments.assignTask({ commandId: cid("as"), actor: owner.id, taskId: id, owner: { kind: "agent", id: assignTo } });
          return id;
        };
        const depWait = async (taskId: string, resolver: string) => {
          const w = await waits.openWait({ commandId: cid("w"), actor: owner.id, taskId, reason: "dependency", resolver, summary: "needs the schema from ben", nextAction: "continue with the schema", indefinite: { owner: owner.id } });
          return { id: w.id, revision: w.revision };
        };
        const tAnn = await task("Ann's task", ann.aid), tBen = await task("Ben's task", ben.aid), tOther = await task("Beta task", eve.aid, b);
        const msgs = make();
        const send = (who: Who, extra: Partial<SendAgentMessage> & { to: string; taskId: string }) => msgs.send(who.p, { commandId: cid("m"), class: "advice", purpose: "design note", text: "The schema uses UUID keys.", ...extra });
        await body({
          owner, a, b, ownerId: owner.id, ann, ben, cat, boss, urg, eve, tAnn, tBen, tOther, msgs, reopen: (over) => make(over), pauses, other, waits, projects, assignments, meetings, notifications, inquiries, host, principals, grants, agentsSvc: agents, agent, task, depWait, send,
          storage: world.storage, epoch,
        });
      } finally { await world.close(); }
    });

  suite("the envelope carries task, sender, purpose, urgency, correlation; states are accepted, delivered, handled, answered and survive a restart", async (c) => {
    const sent = await c.send(c.ben, { to: c.ann.pid, taskId: c.tAnn, expectsReply: true, purpose: "which keys?" });
    const m = (await c.msgs.get(c.ben.p, sent.id))!;
    assert.deepEqual([m.taskId, m.sender, m.to, m.purpose, m.urgency, m.correlationId, m.state, m.kind, m.depth], [c.tAnn, c.ben.pid, c.ann.pid, "which keys?", "normal", sent.id, "accepted", "request", 0]);
    assert.equal(m.trust, "untrusted-content");
    // Repeating the command is the same message; a changed repeat is refused.
    const again = await c.msgs.send(c.ben.p, { commandId: "fixed-1", class: "advice", purpose: "p", text: "t", to: c.ann.pid, taskId: c.tAnn });
    assert.equal((await c.msgs.send(c.ben.p, { commandId: "fixed-1", class: "advice", purpose: "p", text: "t", to: c.ann.pid, taskId: c.tAnn })).id, again.id);
    await refuses("command_conflict", () => c.msgs.send(c.ben.p, { commandId: "fixed-1", class: "advice", purpose: "p", text: "different", to: c.ann.pid, taskId: c.tAnn }));
    // Not readable by the recipient's peers; delivered only when the recipient confirms.
    assert.equal(await c.msgs.get(c.cat.p, sent.id), undefined);
    const read = await c.msgs.readable(c.ann.p, { boundary: "safe-boundary" });
    assert.deepEqual(read.items.map((i) => i.id).sort(), [sent.id, again.id].sort());
    assert.equal((await c.msgs.get(c.ann.p, sent.id))!.state, "accepted", "reading changes nothing");
    const ack = await c.msgs.acknowledge(c.ann.p, { commandId: "ack-1", boundary: "safe-boundary", messageIds: [sent.id] });
    assert.deepEqual(ack.delivered, [sent.id]);
    assert.deepEqual((await c.msgs.acknowledge(c.ann.p, { commandId: "ack-1", boundary: "safe-boundary", messageIds: [sent.id] })).delivered, [sent.id], "a repeat reports the same");
    assert.equal((await c.msgs.get(c.ben.p, sent.id))!.state, "delivered");
    await c.msgs.markHandled(c.ann.p, { commandId: cid("h"), messageId: sent.id });
    assert.equal((await c.msgs.get(c.ann.p, sent.id))!.state, "handled");
    await refuses("invalid_command", () => c.msgs.markHandled(c.ann.p, { commandId: cid("h"), messageId: again.id }), (e) => assert.match(e.message, /after it was delivered/));
    await refuses("forbidden", () => c.msgs.markHandled(c.ben.p, { commandId: cid("h"), messageId: sent.id }));
    // The answer: a reply to the sender on the same task and correlation; the request becomes answered.
    await refuses("forbidden", () => c.msgs.send(c.cat.p, { commandId: cid("r"), class: "advice", purpose: "x", text: "y", replyTo: again.id }));
    const reply = await c.msgs.send(c.ann.p, { commandId: cid("r"), class: "advice", purpose: "answer", text: "Yes, UUID keys.", replyTo: sent.id });
    const r = (await c.msgs.get(c.ben.p, reply.id))!;
    assert.deepEqual([r.kind, r.to, r.taskId, r.correlationId, r.depth, r.replyTo], ["reply", c.ben.pid, c.tAnn, sent.id, 1, sent.id]);
    const parent = (await c.msgs.get(c.ben.p, sent.id))!;
    assert.deepEqual([parent.state, parent.replyId], ["answered", reply.id]);
    await refuses("invalid_command", () => c.msgs.send(c.ann.p, { commandId: cid("r"), class: "advice", purpose: "x", text: "y", replyTo: again.id }), (e) => assert.match(e.message, /after it was delivered/));
    // A restart: a new service instance over the same store sees the same states and the same queue.
    const reopened = c.reopen();
    assert.equal((await reopened.get(c.ann.p, sent.id))!.state, "answered");
    assert.deepEqual((await reopened.inbox(c.ann.p, c.ann.pid))!.items.map((i) => i.id), [again.id]);
    assert.deepEqual((await reopened.inbox(c.ben.p, c.ben.pid))!.items.map((i) => i.id), [reply.id]);
  });

  suite("informational messages batch to the next check-in or stand-up; advice is read at the next safe boundary", async (c) => {
    const info = await c.send(c.ben, { to: c.ann.pid, taskId: c.tAnn, class: "informational", purpose: "FYI", text: "Build is green." });
    const advice = await c.send(c.ben, { to: c.ann.pid, taskId: c.tAnn, class: "advice" });
    assert.equal((await c.msgs.get(c.ben.p, info.id))!.urgency, "low");
    // At a safe boundary only the advice is read, and the informational message cannot be pulled out by ID either.
    assert.deepEqual((await c.msgs.readable(c.ann.p, { boundary: "safe-boundary" })).items.map((i) => i.id), [advice.id]);
    const early = await c.msgs.acknowledge(c.ann.p, { commandId: cid("a"), boundary: "safe-boundary", messageIds: [info.id, advice.id] });
    assert.deepEqual(early.delivered, [advice.id]);
    assert.match(early.refused[0]!.reason, /informational message is not delivered at a safe-boundary/);
    assert.equal((await c.msgs.get(c.ann.p, info.id))!.state, "accepted");
    // The check-in delivers the batch.
    assert.deepEqual((await c.msgs.readable(c.ann.p, { boundary: "check-in" })).items.map((i) => i.id), [info.id]);
    assert.deepEqual((await c.msgs.acknowledge(c.ann.p, { commandId: cid("a"), boundary: "check-in", messageIds: [info.id] })).delivered, [info.id]);
    // A stand-up: only for a participant of a live meeting occurrence.
    const info2 = await c.send(c.ben, { to: c.ann.pid, taskId: c.tAnn, class: "informational" });
    const mgr = await c.agent("mgr", [{ action: "meeting.manage", project: c.a }]);
    const occ = (await c.meetings.callUrgent(mgr.p, { commandId: cid("mt"), projectId: c.a, title: "Stand-up", reason: "daily sync", roster: [c.ann.pid, c.cat.pid] })).id;
    await refuses("forbidden", () => c.msgs.readable(c.ben.p, { boundary: "stand-up", occurrenceId: occ }));
    await refuses("invalid_command", () => c.msgs.readable(c.ann.p, { boundary: "stand-up" }));
    await refuses("invalid_command", () => c.msgs.readable(c.ann.p, { boundary: "check-in", occurrenceId: occ }));
    assert.deepEqual((await c.msgs.readable(c.ann.p, { boundary: "stand-up", occurrenceId: occ })).items.map((i) => i.id), [info2.id]);
    assert.deepEqual((await c.msgs.acknowledge(c.ann.p, { commandId: cid("a"), boundary: "stand-up", occurrenceId: occ, messageIds: [info2.id] })).delivered, [info2.id]);
    assert.equal((await c.msgs.get(c.ann.p, info2.id))!.via, "stand-up");
  });

  suite("focus periods hold advice until they end; a check-in still delivers; only the agent, the owner or a manager sets one, for at most four hours", async (c) => {
    const adv = await c.send(c.ben, { to: c.ann.pid, taskId: c.tAnn });
    await c.msgs.setFocus(c.ann.p, { commandId: cid("f"), agent: c.ann.pid, until: iso(60 * MIN), reason: "deep refactor" });
    const held = await c.msgs.readable(c.ann.p, { boundary: "safe-boundary" });
    assert.deepEqual([held.items.length, held.withheld, held.withheldReason], [0, 1, "focus"]);
    assert.equal((await c.msgs.acknowledge(c.ann.p, { commandId: cid("a"), boundary: "safe-boundary", messageIds: [adv.id] })).refused.length, 1);
    assert.equal((await c.msgs.inbox(c.ann.p, c.ann.pid))!.focus!.until, iso(60 * MIN));
    assert.deepEqual((await c.msgs.readable(c.ann.p, { boundary: "check-in" })).items.map((i) => i.id), [adv.id]);
    now += 61 * MIN;
    assert.deepEqual((await c.msgs.readable(c.ann.p, { boundary: "safe-boundary" })).items.map((i) => i.id), [adv.id], "the focus period is over");
    await refuses("forbidden", () => c.msgs.setFocus(c.ben.p, { commandId: cid("f"), agent: c.ann.pid, until: iso(10 * MIN) }));
    await refuses("invalid_command", () => c.msgs.setFocus(c.ann.p, { commandId: cid("f"), agent: c.ann.pid, until: iso(241 * MIN) }));
    await refuses("invalid_command", () => c.msgs.setFocus(c.ann.p, { commandId: cid("f"), agent: c.ann.pid, until: iso(-MIN) }));
    await c.msgs.setFocus(c.boss.p, { commandId: cid("f"), agent: c.ann.pid, until: iso(30 * MIN) });
    await c.msgs.setFocus(c.owner, { commandId: cid("f"), agent: c.ann.pid, until: null });
    assert.equal((await c.msgs.inbox(c.ann.p, c.ann.pid))!.focus, undefined);
    // A focus period does not block a wake: see the blocking-dependency test.
  });

  suite("a blocking dependency wakes only an eligible waiting task", async (c) => {
    const wait = await c.depWait(c.tAnn, c.ben.pid);
    assert.equal((await c.projects.getTask(c.tAnn))!.state, "blocked");
    // Another sender cannot wake it, a message about a different task cannot, and neither can a task with no dependency wait: all become advice.
    const wrongSender = await c.send(c.cat, { to: c.ann.pid, taskId: c.tAnn, class: "blocking-dependency" });
    assert.deepEqual([wrongSender.woke, wrongSender.effectiveClass, wrongSender.downgraded], [false, "advice", "no_eligible_wait"]);
    assert.equal((await c.waits.getWait(wait.id))!.state, "open");
    const noWait = await c.send(c.ann, { to: c.ben.pid, taskId: c.tBen, class: "blocking-dependency" });
    assert.equal(noWait.downgraded, "no_eligible_wait");
    // A wait of another reason, even naming the sender, is not a dependency wait.
    const tInput = await c.task("input", c.ann.aid);
    await c.waits.openWait({ commandId: cid("w"), actor: c.owner.id, taskId: tInput, reason: "input", resolver: c.ben.pid, summary: "needs input", nextAction: "go", indefinite: { owner: c.owner.id } });
    assert.equal((await c.send(c.ben, { to: c.ann.pid, taskId: tInput, class: "blocking-dependency" })).downgraded, "no_eligible_wait");
    // A wait on a task that is not assigned to the addressee is not eligible either.
    assert.equal((await c.send(c.ben, { to: c.cat.pid, taskId: c.tAnn, class: "blocking-dependency" })).downgraded, "no_eligible_wait");
    // The named resolver wakes it, even during a focus period; the scheduler sees a ready task and assigns priority.
    await c.msgs.setFocus(c.ann.p, { commandId: cid("f"), agent: c.ann.pid, until: iso(60 * MIN) });
    const woke = await c.send(c.ben, { to: c.ann.pid, taskId: c.tAnn, class: "blocking-dependency", purpose: "schema ready", text: "The schema is in the repo." });
    assert.deepEqual([woke.woke, woke.effectiveClass, woke.downgraded], [true, "blocking-dependency", undefined]);
    const w = (await c.waits.getWait(wait.id))!;
    assert.deepEqual([w.state, w.answeredBy], ["answered", c.ben.pid]);
    assert.equal((await c.projects.getTask(c.tAnn))!.state, "ready");
    const m = (await c.msgs.get(c.ann.p, woke.id))!;
    assert.deepEqual([m.state, m.via, m.urgency], ["delivered", "wake", "high"]);
    assert.equal((await c.msgs.inbox(c.ann.p, c.ann.pid))!.items.some((i) => i.id === woke.id), false);
    // Sending the same command again is the same result, not a second wake.
    assert.equal((await c.msgs.send(c.ben.p, { commandId: "wake-cmd", class: "blocking-dependency", purpose: "again", text: "again", to: c.ann.pid, taskId: c.tAnn })).effectiveClass, "advice", "the wait is closed now");
  });

  suite("a blocking dependency never wakes through a pause, a suspension or a stop: it stays queued and the wait stays open until the lifecycle says available", async (c) => {
    const wait = await c.depWait(c.tAnn, c.ben.pid);
    const gateBefore = await c.pauses.gate(c.owner, { kind: "agent", id: c.ann.aid });
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "agent", id: c.ann.aid }, reason: "owner hold" });
    const gate = await c.pauses.gate(c.owner, { kind: "agent", id: c.ann.aid });
    void gateBefore;
    const sent = await c.send(c.ben, { to: c.ann.pid, taskId: c.tAnn, class: "blocking-dependency" });
    assert.deepEqual([sent.woke, sent.reach, sent.effectiveClass], [false, "queued", "blocking-dependency"]);
    assert.equal((await c.waits.getWait(wait.id))!.state, "open");
    assert.equal((await c.projects.getTask(c.tAnn))!.state, "blocked");
    assert.equal((await c.msgs.get(c.ben.p, sent.id))!.state, "accepted");
    assert.equal((await c.pauses.gate(c.owner, { kind: "agent", id: c.ann.aid }))!.revision, gate!.revision, "the message did not touch the pause gate");
    // The release pass does nothing while paused, in any form.
    assert.deepEqual((await c.msgs.release(c.host, { recipient: c.ann.pid })).stillQueued, [sent.id]);
    await refuses("forbidden", () => c.msgs.release(c.ben.p, { recipient: c.ann.pid }));
    // A stop leaves it queued too (reported unavailable); a suspension likewise.
    c.other.set(c.ann.pid, "stopped");
    assert.equal((await c.msgs.get(c.ann.p, sent.id))!.reachNow, "queued", "still the pause");
    await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: { kind: "agent", id: c.ann.aid }, reason: "ok" });
    assert.equal((await c.msgs.get(c.ann.p, sent.id))!.reachNow, "unavailable");
    assert.deepEqual((await c.msgs.release(c.host, { recipient: c.ann.pid })).stillQueued, [sent.id]);
    c.other.set(c.ann.pid, "suspended");
    assert.deepEqual((await c.msgs.release(c.host, { recipient: c.ann.pid })).stillQueued, [sent.id]);
    assert.equal((await c.waits.getWait(wait.id))!.state, "open");
    // A task-level pause holds it as well.
    c.other.delete(c.ann.pid);
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "task", id: c.tAnn }, reason: "task hold" });
    assert.deepEqual((await c.msgs.release(c.host, { recipient: c.ann.pid })).stillQueued, [sent.id]);
    await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: { kind: "task", id: c.tAnn }, reason: "ok" });
    // Available again: now it wakes.
    assert.deepEqual((await c.msgs.release(c.host, { recipient: c.ann.pid })).woken, [sent.id]);
    assert.equal((await c.waits.getWait(wait.id))!.state, "answered");
    assert.equal((await c.projects.getTask(c.tAnn))!.state, "ready");
    assert.deepEqual((await c.msgs.release(c.host, { recipient: c.ann.pid })).woken, [], "nothing twice");
  });

  suite("a wake that died after the wait was answered is finished on the repeat; a sender whose authority is gone no longer wakes anything", async (c) => {
    const wait = await c.depWait(c.tAnn, c.ben.pid);
    let dies = true;
    const flaky = new Proxy(c.waits, { get: (t, k) => {
      const v = (t as never)[k] as unknown;
      if (k !== "answerWait") return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      return async (...args: unknown[]) => { const r = await (t.answerWait as (...a: unknown[]) => Promise<unknown>)(...args); if (dies) { dies = false; throw new Error("process died"); } return r; };
    } });
    const svc = c.reopen({ waits: flaky });
    const command = { commandId: "wake-crash", class: "blocking-dependency" as const, purpose: "schema ready", text: "In the repo.", to: c.ann.pid, taskId: c.tAnn };
    await assert.rejects(() => svc.send(c.ben.p, command), /process died/);
    assert.equal((await c.waits.getWait(wait.id))!.state, "answered", "the wait step happened");
    const repeated = await svc.send(c.ben.p, command);
    assert.deepEqual([repeated.replayed, repeated.woke, repeated.effectiveClass], [true, true, "blocking-dependency"]);
    assert.equal((await svc.get(c.ann.p, repeated.id))!.state, "delivered");
    // Authority revoked between accepting and waking: the wake is refused and the message is only advice.
    const t2 = await c.task("second", c.ann.aid);
    const wait2 = await c.depWait(t2, c.ben.pid);
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "agent", id: c.ann.aid }, reason: "hold" });
    const queued = await c.send(c.ben, { to: c.ann.pid, taskId: t2, class: "blocking-dependency" });
    const f = await c.storage.getAggregate({ kind: "principal", id: c.ben.pid });
    await c.principals.setGrants(c.owner, { commandId: cid("sg"), principalId: c.ben.pid, expectedRevision: f!.revision, grants: [] });
    await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: { kind: "agent", id: c.ann.aid }, reason: "ok" });
    assert.deepEqual((await c.msgs.release(c.host, { recipient: c.ann.pid })).downgraded, [queued.id]);
    assert.equal((await c.waits.getWait(wait2.id))!.state, "open");
    assert.equal((await c.msgs.get(c.ann.p, queued.id))!.downgraded, "sender_authority_lost");
  });

  suite("urgent control needs the sender's own authority (a parent role or manager grant is not enough), is bounded by the interruption allowance, and never interrupts a paused agent", async (c) => {
    // Rank is not authority: ben's supervisor holds agent.manage everywhere and still cannot make a message urgent.
    await refuses("forbidden", () => c.send(c.boss, { to: c.ben.pid, taskId: c.tBen, class: "urgent-control" }), (e) => assert.match(e.message, /message\.urgent/));
    await refuses("forbidden", () => c.send(c.cat, { to: c.ben.pid, taskId: c.tBen, class: "urgent-control" }));
    // The parent's ordinary message is advice, at the normal urgency.
    const plain = await c.send(c.boss, { to: c.ben.pid, taskId: c.tBen, class: "advice" });
    assert.equal((await c.msgs.get(c.boss.p, plain.id))!.urgency, "normal");
    assert.deepEqual((await c.msgs.readable(c.ben.p, { boundary: "interrupt" })).items, []);
    // With the grant the request is an interruption, delivered only through the interrupt boundary.
    const base0 = now;
    const u1 = await c.send(c.urg, { to: c.ben.pid, taskId: c.tBen, class: "urgent-control", purpose: "stop the migration", text: "Stop before step 3." });
    assert.deepEqual([u1.effectiveClass, u1.reach], ["urgent-control", "ready"]);
    assert.equal((await c.msgs.get(c.ben.p, u1.id))!.urgency, "urgent");
    assert.deepEqual((await c.msgs.readable(c.ben.p, { boundary: "safe-boundary" })).items.map((i) => i.id), [plain.id]);
    assert.deepEqual((await c.msgs.readable(c.ben.p, { boundary: "interrupt" })).items.map((i) => i.id), [u1.id]);
    // The recipient cannot pull an urgent request through a check-in, nor advice through the interrupt boundary.
    assert.equal((await c.msgs.acknowledge(c.ben.p, { commandId: cid("a"), boundary: "check-in", messageIds: [u1.id] })).refused.length, 1);
    assert.equal((await c.msgs.acknowledge(c.ben.p, { commandId: cid("a"), boundary: "interrupt", messageIds: [plain.id] })).refused.length, 1);
    assert.deepEqual((await c.msgs.acknowledge(c.ben.p, { commandId: cid("a"), boundary: "interrupt", messageIds: [u1.id] })).delivered, [u1.id]);
    // The allowance is a rolling hour: interruptions at minutes 0 (u1), 58 and 59 use it up; at 61 the first has aged out, at 62 and 63 the window holds three.
    const urgentAt = async (minutes: number) => { now = base0 + minutes * MIN; return c.send(c.urg, { to: c.ben.pid, taskId: c.tBen, class: "urgent-control" }); };
    assert.equal((await urgentAt(58)).effectiveClass, "urgent-control");
    assert.equal((await urgentAt(59)).effectiveClass, "urgent-control");
    assert.equal((await urgentAt(61)).effectiveClass, "urgent-control", "the one from minute 0 is more than an hour old");
    const fourth = await urgentAt(62);
    assert.deepEqual([fourth.effectiveClass, fourth.downgraded], ["advice", "interruption_allowance"]);
    assert.equal((await urgentAt(63)).downgraded, "interruption_allowance");
    assert.equal((await c.msgs.inbox(c.ben.p, c.ben.pid))!.interruptionsUsed, 3);
    const ownerUrgent = await c.send({ p: c.owner, pid: c.owner.id, aid: "" }, { to: c.ben.pid, taskId: c.tBen, class: "urgent-control" });
    assert.equal(ownerUrgent.effectiveClass, "urgent-control", "the owner is not limited by the allowance");
    assert.equal((await urgentAt(119)).effectiveClass, "urgent-control", "minute 58 has aged out");
    // A paused agent is not interrupted: the request is accepted, reported queued, withheld and delivered to no one.
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "agent", id: c.cat.aid }, reason: "hold" });
    const tCat = await c.task("cat's", c.cat.aid);
    const gate = (await c.pauses.gate(c.owner, { kind: "agent", id: c.cat.aid }))!;
    const toPaused = await c.send(c.urg, { to: c.cat.pid, taskId: tCat, class: "urgent-control" });
    assert.deepEqual([toPaused.reach, toPaused.effectiveClass], ["queued", "urgent-control"]);
    const withheld = await c.msgs.readable(c.cat.p, { boundary: "interrupt" });
    assert.deepEqual([withheld.items.length, withheld.withheld, withheld.withheldReason], [0, 1, "paused"]);
    assert.equal((await c.msgs.acknowledge(c.cat.p, { commandId: cid("a"), boundary: "interrupt", messageIds: [toPaused.id] })).refused.length, 1);
    assert.equal((await c.pauses.gate(c.owner, { kind: "agent", id: c.cat.aid }))!.revision, gate.revision, "the pause gate is untouched");
    // Reading informational and advice is still possible while paused, without resuming anything.
    await c.send(c.urg, { to: c.cat.pid, taskId: tCat, class: "informational" });
    assert.equal((await c.msgs.readable(c.cat.p, { boundary: "check-in" })).items.length, 1);
    assert.equal((await c.pauses.gate(c.owner, { kind: "agent", id: c.cat.aid }))!.revision, gate.revision);
    // The owner is never interrupted or woken by an agent.
    await refuses("invalid_command", () => c.send(c.urg, { to: c.ownerId, taskId: c.tBen, class: "urgent-control" }), (e) => assert.match(e.message, /owner is not interrupted/));
    await refuses("invalid_command", () => c.send(c.ben, { to: c.ownerId, taskId: c.tBen, class: "blocking-dependency" }));
  });

  suite("repeated updates coalesce into one waiting message", async (c) => {
    const first = await c.send(c.ben, { to: c.ann.pid, taskId: c.tAnn, class: "informational", coalesceKey: "build-status", text: "build 1 running" });
    const second = await c.send(c.ben, { to: c.ann.pid, taskId: c.tAnn, class: "informational", coalesceKey: "build-status", text: "build 2 running" });
    const third = await c.msgs.send(c.ben.p, { commandId: "coalesce-3", class: "informational", purpose: "design note", coalesceKey: "build-status", text: "build 3 green", to: c.ann.pid, taskId: c.tAnn });
    assert.deepEqual([second.id, third.id, second.coalesced, third.coalesced, first.coalesced], [first.id, first.id, true, true, false]);
    const m = (await c.msgs.get(c.ann.p, first.id))!;
    assert.deepEqual([m.text, m.count], ["build 3 green", 3]);
    assert.equal((await c.msgs.inbox(c.ann.p, c.ann.pid))!.items.length, 1);
    assert.equal((await c.msgs.send(c.ben.p, { commandId: "coalesce-3", class: "informational", purpose: "design note", coalesceKey: "build-status", text: "build 3 green", to: c.ann.pid, taskId: c.tAnn })).replayed, true);
    assert.equal((await c.msgs.get(c.ann.p, first.id))!.count, 3, "a repeat of an update does not count twice");
    // Another key, another sender, another task and another class stay apart.
    await c.send(c.ben, { to: c.ann.pid, taskId: c.tAnn, class: "informational", coalesceKey: "lint" });
    await c.send(c.cat, { to: c.ann.pid, taskId: c.tAnn, class: "informational", coalesceKey: "build-status" });
    await c.send(c.ben, { to: c.ann.pid, taskId: c.tAnn, class: "advice", coalesceKey: "build-status" });
    assert.equal((await c.msgs.inbox(c.ann.p, c.ann.pid))!.items.length, 4);
    // Once delivered, the next update is a new message. Keys are refused where coalescing would hide something.
    await c.msgs.acknowledge(c.ann.p, { commandId: cid("a"), boundary: "check-in", messageIds: [first.id] });
    const next = await c.send(c.ben, { to: c.ann.pid, taskId: c.tAnn, class: "informational", coalesceKey: "build-status" });
    assert.notEqual(next.id, first.id);
    await refuses("invalid_command", () => c.send(c.ben, { to: c.ann.pid, taskId: c.tAnn, class: "urgent-control", coalesceKey: "k" }));
    await refuses("invalid_command", () => c.send(c.ben, { to: c.ann.pid, taskId: c.tAnn, coalesceKey: "k", deadline: iso(MIN), escalateTo: c.boss.pid }));
  });

  suite("per-sender rate, per-recipient rate, per-sender queue and recipient queue limits are enforced", async (c) => {
    // One recipient gets at most 10 messages a minute from one sender.
    for (let i = 0; i < MESSAGE_LIMITS.perRecipientPerMinute; i++) await c.send(c.ben, { to: c.ann.pid, taskId: c.tAnn, class: "informational", text: `u${i}` });
    await refuses("unavailable", () => c.send(c.ben, { to: c.ann.pid, taskId: c.tAnn, class: "informational" }), (e) => assert.match(e.message, /to agent:.* this minute/));
    // A sender's queue at one recipient is 20: after the minute passes, ten more fit and the 21st is refused until some are read.
    now += 61 * MIN;
    for (let i = 0; i < MESSAGE_LIMITS.perSenderQueue - MESSAGE_LIMITS.perRecipientPerMinute; i++) await c.send(c.ben, { to: c.ann.pid, taskId: c.tAnn, class: "informational", text: `v${i}` });
    now += 61 * MIN;
    await refuses("unavailable", () => c.send(c.ben, { to: c.ann.pid, taskId: c.tAnn, class: "informational" }), (e) => assert.match(e.message, /already has 20 messages waiting/));
    const some = (await c.msgs.readable(c.ann.p, { boundary: "check-in", limit: 5 })).items.map((i) => i.id);
    await c.msgs.acknowledge(c.ann.p, { commandId: cid("a"), boundary: "check-in", messageIds: some });
    await c.send(c.ben, { to: c.ann.pid, taskId: c.tAnn, class: "informational" });
    // A sender's total is 30 a minute across recipients.
    now += 61 * MIN;
    const cats = [c.cat, c.eve, await c.agent("dee"), await c.agent("fay")];
    let sentCount = 0;
    for (const r of [c.cat, await c.agent("gus"), await c.agent("hal")]) for (let i = 0; i < MESSAGE_LIMITS.perRecipientPerMinute; i++, sentCount++) await c.send(c.boss, { to: r.pid, taskId: c.tAnn, class: "informational" });
    assert.equal(sentCount, MESSAGE_LIMITS.perMinute);
    await refuses("unavailable", () => c.send(c.boss, { to: cats[2]!.pid, taskId: c.tAnn, class: "informational" }), (e) => assert.match(e.message, /30 messages this minute/));
    now += 61 * MIN;
    await c.send(c.boss, { to: cats[2]!.pid, taskId: c.tAnn, class: "informational" });
    // A recipient's queue is 100 in all: five senders at 20 fill it, the sixth is refused whoever it is.
    const target = await c.agent("target");
    const senders = [c.ben, c.cat, c.boss, c.urg, await c.agent("sam")];
    for (const s of senders) {
      for (let wave = 0; wave < 2; wave++) {
        now += 61 * MIN;
        for (let i = 0; i < 10; i++) await c.send(s, { to: target.pid, taskId: c.tAnn, class: "informational" });
      }
    }
    assert.equal((await c.msgs.inbox(c.owner, target.pid))!.items.length, MESSAGE_LIMITS.queue);
    now += 61 * MIN;
    const last = await c.agent("zoe");
    await refuses("unavailable", () => c.send(last, { to: target.pid, taskId: c.tAnn, class: "informational" }), (e) => assert.match(e.message, /already has 100 messages waiting/));
    // Peers fill the queue (100); authorized interruptions fill the urgent reserve (3 an hour, so seven hours: 20 places); escalations fill theirs (20).
    for (let hour = 0; hour < 7; hour++) {
      now += 61 * MIN;
      for (let k = 0; k < 3; k++) { try { await c.send(c.urg, { to: target.pid, taskId: c.tAnn, class: "urgent-control" }); } catch (e) { assert.ok(e instanceof DomainError && e.code === "unavailable"); } }
    }
    assert.equal((await c.msgs.inbox(c.owner, target.pid))!.items.length, MESSAGE_LIMITS.queue + MESSAGE_LIMITS.urgentReserve, "the urgent reserve is full and no more interruptions fit");
    now += 61 * MIN;
    await refuses("unavailable", () => c.send(c.urg, { to: target.pid, taskId: c.tAnn, class: "urgent-control" }));
    for (let batch = 0; batch < 2; batch++) {
      now += 61 * MIN;
      for (let k = 0; k < 10; k++) await c.send(c.ann, { to: c.cat.pid, taskId: c.tAnn, deadline: iso(600 * MIN), escalateTo: target.pid, purpose: `r${batch}-${k}` });
    }
    now += 601 * MIN;
    assert.equal((await c.msgs.settleDue(c.host)).escalated.length, MESSAGE_LIMITS.escalationReserve);
    assert.equal((await c.msgs.inbox(c.owner, target.pid))!.items.length, MESSAGE_LIMITS.queue + MESSAGE_LIMITS.urgentReserve + MESSAGE_LIMITS.escalationReserve, "all three reserves are full");
    // The owner still gets through, up to the owner's own 20 places; a peer does not (an authorized interruption included).
    const ownerWho = { p: c.owner, pid: c.owner.id, aid: "" };
    await refuses("unavailable", () => c.send(c.urg, { to: target.pid, taskId: c.tAnn, class: "urgent-control" }));
    await refuses("forbidden", () => c.send(c.boss, { to: target.pid, taskId: c.tAnn, class: "urgent-control" }));
    await refuses("unavailable", () => c.send(c.boss, { to: target.pid, taskId: c.tAnn, class: "advice" }));
    assert.equal((await c.send(ownerWho, { to: target.pid, taskId: c.tAnn, class: "urgent-control", purpose: "stop", text: "Stop now." })).effectiveClass, "urgent-control");
    for (let i = 1; i < MESSAGE_LIMITS.ownerReserve; i++) await c.send(ownerWho, { to: target.pid, taskId: c.tAnn, class: "advice", text: `o${i}` });
    assert.equal((await c.msgs.inbox(c.owner, target.pid))!.items.length, 160, "the hard bound");
    await refuses("unavailable", () => c.send(ownerWho, { to: target.pid, taskId: c.tAnn, class: "advice" }));
    // The owner is not rate limited: more than ten to one recipient in a minute, more than thirty in all.
    now += 61 * MIN;
    for (let i = 0; i < 12; i++) await c.send(ownerWho, { to: c.ann.pid, taskId: c.tAnn, class: "informational", text: `o${i}` });
    for (let i = 0; i < 31; i++) await c.send(ownerWho, { to: i % 2 === 0 ? c.cat.pid : c.ben.pid, taskId: c.tAnn, class: "informational", text: `p${i}` });
  });

  suite("the open-deadline cap has a reserve only the owner can use", async (c) => {
    const small = c.reopen({ deadlineCap: 3, ownerDeadlineReserve: 2 });
    const ask = (svc: AgentMessageService, who: Who, to: string, escalateTo: string) => svc.send(who.p, { commandId: cid("m"), class: "advice", purpose: "p", text: "t", to, taskId: c.tAnn, deadline: iso(600 * MIN), escalateTo });
    for (const who of [c.ben, c.cat, c.urg]) await ask(small, who, c.ann.pid, c.boss.pid);
    await refuses("unavailable", () => ask(small, c.ann, c.cat.pid, c.boss.pid), (e) => assert.match(e.message, /3 requests waiting/));
    const ownerWho = { p: c.owner } as Who;
    await ask(small, ownerWho, c.ann.pid, c.boss.pid);
    await ask(small, ownerWho, c.ann.pid, c.boss.pid);
    await refuses("unavailable", () => ask(small, ownerWho, c.ann.pid, c.boss.pid));
  });

  suite("reply loops are bounded: a chain of replies stops at the depth limit", async (c) => {
    let current = await c.send(c.ben, { to: c.ann.pid, taskId: c.tAnn, expectsReply: true });
    let replier = c.ann;
    let depth = 0;
    for (;;) {
      await c.msgs.acknowledge(replier.p, { commandId: cid("a"), boundary: "safe-boundary", messageIds: [current.id] });
      now += 2 * MIN;
      if (depth >= MESSAGE_LIMITS.depth) break;
      current = await c.msgs.send(replier.p, { commandId: cid("r"), class: "advice", purpose: "re", text: `reply ${depth + 1}`, replyTo: current.id, expectsReply: true });
      depth++;
      replier = replier === c.ann ? c.ben : c.ann;
    }
    assert.equal(depth, MESSAGE_LIMITS.depth);
    assert.equal((await c.msgs.get(c.ann.p, current.id))!.depth, MESSAGE_LIMITS.depth);
    await refuses("unavailable", () => c.msgs.send(replier.p, { commandId: cid("r"), class: "advice", purpose: "re", text: "one more", replyTo: current.id }), (e) => assert.match(e.message, /reply chain is 8 messages long/));
  });

  suite("a message to a paused, suspended or stopped agent is kept and reported queued or unavailable; it wakes and resumes nothing; a failing lifecycle hook fails closed", async (c) => {
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "agent", id: c.ann.aid }, reason: "hold" });
    const gate = (await c.pauses.gate(c.owner, { kind: "agent", id: c.ann.aid }))!;
    const toPaused = await c.send(c.ben, { to: c.ann.pid, taskId: c.tAnn, class: "advice" });
    assert.equal(toPaused.reach, "queued");
    c.other.set(c.cat.pid, "suspended");
    assert.equal((await c.send(c.ben, { to: c.cat.pid, taskId: c.tAnn })).reach, "queued");
    c.other.set(c.cat.pid, "stopped");
    assert.equal((await c.send(c.ben, { to: c.cat.pid, taskId: c.tAnn })).reach, "unavailable");
    assert.equal((await c.msgs.inbox(c.cat.p, c.cat.pid))!.items.length, 2, "both are kept");
    assert.equal((await c.pauses.gate(c.owner, { kind: "agent", id: c.ann.aid }))!.revision, gate.revision, "the gate did not move");
    assert.equal((await c.pauses.availability(c.ann.pid)), "paused", "and the agent is still paused");
    // The paused agent can read what was queued (a message is not an instruction to work).
    assert.equal((await c.msgs.readable(c.ann.p, { boundary: "safe-boundary" })).items.length, 1);
    // A hook that throws counts as unavailable.
    const failing = c.reopen({ availability: async () => { throw new Error("lifecycle store down"); } });
    assert.equal((await failing.send(c.ben.p, { commandId: cid("m"), class: "advice", purpose: "x", text: "y", to: c.eve.pid === "" ? c.ann.pid : c.ann.pid, taskId: c.tAnn })).reach, "queued");
    // An inquiry to a paused agent: pending, reported queued, nothing woken.
    const inquiry = await c.inquiries.ask(c.ben.p, { commandId: cid("q"), taskId: c.tBen, to: c.ann.pid, question: "Which keys do we use?" });
    assert.deepEqual(await c.msgs.inquiryReach(c.ben.p, inquiry.id), { state: "open", reach: "queued" });
    assert.equal((await c.inquiries.pendingFor(c.ann.p)).items.length, 1);
    assert.equal((await c.pauses.gate(c.owner, { kind: "agent", id: c.ann.aid }))!.revision, gate.revision);
    await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: { kind: "agent", id: c.ann.aid }, reason: "ok" });
    assert.equal((await c.msgs.inquiryReach(c.ben.p, inquiry.id))!.reach, "ready");
    assert.equal(await c.msgs.inquiryReach(c.cat.p, inquiry.id), undefined, "a stranger sees nothing");
  });

  suite("a question to the owner appears with its task context, and the owner's answer resolves the linked wait", async (c) => {
    const w = await c.waits.openWait({ commandId: cid("w"), actor: c.ann.pid, taskId: c.tAnn, reason: "inquiry", resolver: c.ownerId, summary: "waiting for the owner's choice of database", nextAction: "build on the chosen database", deadline: iso(24 * 60 * MIN), onDeadline: "escalate" });
    const asked = await c.msgs.askOwner(c.ann.p, { commandId: "ask-owner-1", taskId: c.tAnn, question: "Postgres or SQLite for the first release?", waitId: w.id });
    assert.equal((await c.msgs.askOwner(c.ann.p, { commandId: "ask-owner-1", taskId: c.tAnn, question: "Postgres or SQLite for the first release?", waitId: w.id })).replayed, true);
    const list = await c.msgs.ownerQuestions(c.owner);
    assert.equal(list.items.length, 1);
    const q = list.items[0]!;
    assert.deepEqual([q.inquiryId, q.asker, q.task.id, q.task.title, q.task.state, q.task.projectName, q.wait?.id, q.wait?.summary, q.wait?.deadline], [asked.inquiryId, c.ann.pid, c.tAnn, "Ann's task", "blocked", "Alpha", w.id, "waiting for the owner's choice of database", iso(24 * 60 * MIN)]);
    // The owner's notifications carry it too.
    assert.equal((await c.notifications.inbox(c.owner)).items.filter((i) => i.kind === "owner-question").length, 1);
    await refuses("forbidden", () => c.msgs.ownerQuestions(c.ann.p));
    await refuses("forbidden", () => c.msgs.answerOwner(c.ann.p, { commandId: cid("ao"), inquiryId: asked.inquiryId, answer: "Postgres." }));
    // Someone who does not work on the task cannot put a question about it to the owner.
    await refuses("forbidden", () => c.msgs.askOwner(c.eve.p, { commandId: cid("ask"), taskId: c.tAnn, question: "Why?" }));
    await c.msgs.answerOwner(c.owner, { commandId: "owner-answer-1", inquiryId: asked.inquiryId, answer: "Postgres." });
    assert.equal((await c.waits.getWait(w.id))!.state, "answered");
    assert.equal((await c.waits.getWait(w.id))!.answeredBy, c.ownerId);
    assert.equal((await c.projects.getTask(c.tAnn))!.state, "ready");
    assert.equal((await c.msgs.ownerQuestions(c.owner)).items.length, 0);
    assert.equal((await c.notifications.inbox(c.owner)).items.filter((i) => i.kind === "owner-question").length, 0, "the notification is closed with the answer");
    assert.equal((await c.inquiries.view(c.ann.p, asked.inquiryId))!.inquiry.answer, "Postgres.");
    assert.equal((await c.msgs.answerOwner(c.owner, { commandId: "owner-answer-1", inquiryId: asked.inquiryId, answer: "Postgres." })).replayed, true);
  });

  suite("a request without a reply reaches its escalation path at its deadline, once, across a restart; an answered request does not", async (c) => {
    await refuses("invalid_command", () => c.send(c.ben, { to: c.ann.pid, taskId: c.tAnn, deadline: iso(60 * MIN) }), (e) => assert.match(e.message, /escalateTo/));
    await refuses("invalid_command", () => c.send(c.ben, { to: c.ann.pid, taskId: c.tAnn, deadline: iso(-MIN), escalateTo: c.boss.pid }));
    await refuses("forbidden", () => c.send(c.ben, { to: c.ann.pid, taskId: c.tAnn, deadline: iso(60 * MIN), escalateTo: c.eve.pid }), (e) => assert.match(e.message, /escalation path/));
    const open = await c.send(c.ben, { to: c.ann.pid, taskId: c.tAnn, expectsReply: true, deadline: iso(60 * MIN), escalateTo: c.boss.pid, purpose: "need the key decision" });
    const answered = await c.send(c.ben, { to: c.ann.pid, taskId: c.tAnn, deadline: iso(60 * MIN), escalateTo: c.boss.pid, purpose: "another question" });
    assert.equal((await c.msgs.get(c.ben.p, open.id))!.kind, "request");
    await c.msgs.acknowledge(c.ann.p, { commandId: cid("a"), boundary: "safe-boundary", messageIds: [answered.id] });
    await c.msgs.send(c.ann.p, { commandId: cid("r"), class: "advice", purpose: "answer", text: "Done.", replyTo: answered.id });
    assert.deepEqual(await c.msgs.settleDue(c.host), { escalated: [], blocked: [], cleared: 0 }, "before the deadline nothing happens");
    await refuses("forbidden", () => c.msgs.settleDue(c.ben.p));
    now += 61 * MIN;
    const restarted = c.reopen();
    const first = await restarted.settleDue(c.host);
    assert.deepEqual([first.escalated, first.cleared], [[open.id], 0], "the answered request was taken off the list when it was answered");
    const parent = (await c.msgs.get(c.ben.p, open.id))!;
    assert.ok(parent.escalatedAt !== undefined && parent.escalationId !== undefined);
    const esc = (await c.msgs.get(c.boss.p, parent.escalationId!))!;
    assert.deepEqual([esc.sender, esc.to, esc.kind, esc.effectiveClass, esc.urgency, esc.correlationId, esc.taskId], ["controller", c.boss.pid, "escalation", "advice", "normal", open.id, c.tAnn]);
    assert.match(esc.text, /no reply by/);
    assert.deepEqual((await c.msgs.readable(c.boss.p, { boundary: "safe-boundary" })).items.map((i) => i.id), [parent.escalationId]);
    assert.deepEqual(await restarted.settleDue(c.owner), { escalated: [], blocked: [], cleared: 0 }, "a repeat does nothing twice");
    assert.equal((await c.msgs.inbox(c.boss.p, c.boss.pid))!.items.length, 1);
    await c.msgs.acknowledge(c.boss.p, { commandId: cid("a"), boundary: "safe-boundary", messageIds: [parent.escalationId!] });
    await refuses("invalid_command", () => c.msgs.send(c.boss.p, { commandId: cid("r"), class: "advice", purpose: "x", text: "y", replyTo: parent.escalationId! }), (e) => assert.match(e.message, /escalation notice/));
    // Supervisor tier first: ben reports to boss, so he names boss (or someone above), not the owner or a peer; ann has no supervisor and may name the owner.
    await refuses("invalid_command", () => c.send(c.ben, { to: c.ann.pid, taskId: c.tAnn, deadline: iso(600 * MIN), escalateTo: c.ownerId }), (e) => assert.match(e.message, /name your supervisor/));
    await refuses("invalid_command", () => c.send(c.ben, { to: c.ann.pid, taskId: c.tAnn, deadline: iso(600 * MIN), escalateTo: c.cat.pid }));
    await c.send(c.ann, { to: c.cat.pid, taskId: c.tAnn, deadline: iso(600 * MIN), escalateTo: c.ownerId });
    // Per-sender open deadlines are bounded.
    for (let i = 0; i < MESSAGE_LIMITS.openDeadlinesPerSender; i++) {
      if (i % 5 === 0) now += 61 * MIN;
      await c.send(c.ben, { to: i % 2 === 0 ? c.ann.pid : c.cat.pid, taskId: c.tAnn, deadline: iso(600 * MIN), escalateTo: c.boss.pid });
    }
    await refuses("unavailable", () => c.send(c.ben, { to: c.ann.pid, taskId: c.tAnn, deadline: iso(600 * MIN), escalateTo: c.boss.pid }), (e) => assert.match(e.message, /20 requests with deadlines open/));
  });

  suite("authorization: no actor field, missing and unreadable look alike, no reply for a stranger, no message about a task without the grant", async (c) => {
    const base = { to: c.ann.pid, taskId: c.tAnn, class: "advice" as const, purpose: "p", text: "t" };
    await refuses("invalid_command", () => c.msgs.send(c.ben.p, { commandId: cid("m"), ...base, sender: "agent:x" } as never));
    await refuses("invalid_command", () => c.msgs.send(c.ben.p, { commandId: cid("m"), ...base, actor: "agent:x" } as never));
    // Project B's agent cannot message about project A, and cannot tell that the task exists.
    await refuses("forbidden", () => c.msgs.send(c.eve.p, { commandId: cid("m"), ...base }));
    await refuses("forbidden", () => c.msgs.send(c.ben.p, { commandId: cid("m"), ...base, taskId: "task-aaaaaaaaaaaaaaaaaaaa" }));
    // The recipient must be reachable for that task: project B's agent is not.
    await refuses("forbidden", () => c.msgs.send(c.ben.p, { commandId: cid("m"), ...base, to: c.eve.pid }));
    await refuses("forbidden", () => c.msgs.send(c.ben.p, { commandId: cid("m"), ...base, to: "agent:agt-aaaaaaaaaaaaaaaaaaaa" }));
    await refuses("invalid_command", () => c.msgs.send(c.ben.p, { commandId: cid("m"), ...base, to: c.ben.pid }));
    // Without the grant, no sending.
    const quiet = await c.agent("quiet", [{ action: "task.read", project: c.a }]);
    await refuses("forbidden", () => c.msgs.send(quiet.p, { commandId: cid("m"), ...base }));
    // A task credential reaches its task only.
    const scoped: Principal = { ...c.ben.p, taskScope: { taskId: c.tBen, projectId: c.a } };
    await refuses("forbidden", () => c.msgs.send(scoped, { commandId: cid("m"), ...base }));
    // Reads: strangers see nothing; the owner sees everything; another agent's inbox is not readable.
    const sent = await c.msgs.send(c.ben.p, { commandId: cid("m"), ...base });
    assert.equal(await c.msgs.get(c.cat.p, sent.id), undefined);
    assert.equal(await c.msgs.get(c.eve.p, sent.id), undefined);
    assert.ok(await c.msgs.get(c.owner, sent.id));
    assert.equal(await c.msgs.get(c.ann.p, "not-an-id"), undefined);
    assert.equal(await c.msgs.inbox(c.ben.p, c.ann.pid), undefined);
    assert.ok(await c.msgs.inbox(c.owner, c.ann.pid));
    assert.deepEqual((await c.msgs.acknowledge(c.cat.p, { commandId: cid("a"), boundary: "safe-boundary", messageIds: [sent.id] })).refused.map((r) => r.reason), ["not found"]);
    await refuses("forbidden", () => c.msgs.send(c.cat.p, { commandId: cid("r"), class: "advice", purpose: "x", text: "y", replyTo: sent.id }));
    await refuses("invalid_command", () => c.msgs.send(c.ann.p, { commandId: cid("r"), class: "advice", purpose: "x", text: "y", replyTo: sent.id, taskId: c.tBen }));
    // Credential-shaped text is refused; unknown classes and fields are refused.
    await refuses("invalid_command", () => c.msgs.send(c.ben.p, { commandId: cid("m"), ...base, text: "key AKIAABCDEFGHIJKLMNOP and ghp_abcdefghijklmnopqrstuvwxyz0123456789" }));
    await refuses("invalid_command", () => c.msgs.send(c.ben.p, { commandId: cid("m"), ...base, class: "shout" as never }));
    await refuses("forbidden", () => c.msgs.release(c.ben.p, { recipient: c.ann.pid }));
    await refuses("forbidden", () => c.msgs.settleDue(c.ben.p));
  });

  suite("concurrent senders each get one message; concurrent identical commands make one", async (c) => {
    const senders = [c.ben, c.cat, c.boss, c.urg, await c.agent("p1"), await c.agent("p2")];
    const results = await Promise.all(senders.map((s) => c.send(s, { to: c.ann.pid, taskId: c.tAnn, class: "informational" })));
    assert.equal(new Set(results.map((r) => r.id)).size, senders.length);
    assert.equal((await c.msgs.inbox(c.ann.p, c.ann.pid))!.items.length, senders.length);
    const same = { commandId: "same-command", class: "advice" as const, purpose: "p", text: "t", to: c.cat.pid, taskId: c.tAnn };
    const twins = await Promise.all([c.msgs.send(c.ben.p, same), c.reopen().send(c.ben.p, same), c.msgs.send(c.ben.p, same)]);
    assert.equal(new Set(twins.map((r) => r.id)).size, 1);
    assert.equal((await c.msgs.inbox(c.cat.p, c.cat.pid))!.items.length, 1);
    // A send racing a read-and-acknowledge loses nothing.
    const all = (await c.msgs.readable(c.ann.p, { boundary: "check-in" })).items.map((i) => i.id);
    const [late] = await Promise.all([c.send(c.cat, { to: c.ann.pid, taskId: c.tAnn, class: "informational" }), c.msgs.acknowledge(c.ann.p, { commandId: cid("a"), boundary: "check-in", messageIds: all })]);
    const left = (await c.msgs.inbox(c.ann.p, c.ann.pid))!.items.map((i) => i.id);
    assert.deepEqual(left, [late.id]);
  });

  suite("grant expiry follows the injected clock, for the sender at wake time and for the recipient's reach", async (c) => {
    const grantTo = (who: Who, action: string, expiresAt: string) => c.grants.grant(c.owner, { commandId: cid("g"), grantee: who.pid, action, project: c.a, source: "direct", basis: "test", expiresAt });
    const sender = await c.agent("temp", []);
    await grantTo(sender, "message.send", iso(30 * MIN));
    const wait1 = await c.depWait(c.tAnn, sender.pid);
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "agent", id: c.ann.aid }, reason: "hold" });
    const first = await c.send(sender, { to: c.ann.pid, taskId: c.tAnn, class: "blocking-dependency" });
    assert.equal(first.woke, false);
    now += 5 * MIN;
    await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: { kind: "agent", id: c.ann.aid }, reason: "ok" });
    assert.deepEqual((await c.msgs.release(c.host, { recipient: c.ann.pid })).woken, [first.id], "the grant has not expired on the controller's clock");
    assert.equal((await c.waits.getWait(wait1.id))!.state, "answered");
    // Another wait, a message held by a pause, and the grant expires before the pause is lifted.
    const t2 = await c.task("second", c.ann.aid);
    const wait2 = await c.depWait(t2, sender.pid);
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "agent", id: c.ann.aid }, reason: "hold" });
    const second = await c.send(sender, { to: c.ann.pid, taskId: t2, class: "blocking-dependency" });
    now += 30 * MIN;
    await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: { kind: "agent", id: c.ann.aid }, reason: "ok" });
    assert.deepEqual((await c.msgs.release(c.host, { recipient: c.ann.pid })).downgraded, [second.id]);
    assert.equal((await c.waits.getWait(wait2.id))!.state, "open");
    // A recipient whose access to the task expires stops being reachable.
    const temp = await c.agent("temp2", []);
    await grantTo(temp, "task.read", iso(20 * MIN));
    await c.send(c.ben, { to: temp.pid, taskId: c.tBen, class: "informational" });
    now += 21 * MIN;
    await refuses("forbidden", () => c.send(c.ben, { to: temp.pid, taskId: c.tBen, class: "informational" }), (e) => assert.match(e.message, /cannot message/));
  });

  suite("a pause that commits between the wake's checks and its commit stops the wake: the gates commit with the answer", async (c) => {
    const wait = await c.depWait(c.tAnn, c.ben.pid);
    let raced = 0;
    const svc = c.reopen({ guard: async (taskId: string) => {
      const g = await c.pauses.guard(taskId);
      if (raced++ === 0) await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "agent", id: c.ann.aid }, reason: "the owner pauses right now" });
      return g;
    } });
    const sent = await svc.send(c.ben.p, { commandId: cid("m"), class: "blocking-dependency", purpose: "schema ready", text: "In the repo.", to: c.ann.pid, taskId: c.tAnn });
    assert.equal(sent.woke, false);
    assert.equal((await c.waits.getWait(wait.id))!.state, "open");
    assert.equal((await c.projects.getTask(c.tAnn))!.state, "blocked");
    assert.equal((await c.msgs.get(c.ann.p, sent.id))!.state, "accepted");
    // The same race on a task-level pause.
    const t2 = await c.task("second", c.ann.aid);
    const wait2 = await c.depWait(t2, c.ben.pid);
    await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: { kind: "agent", id: c.ann.aid }, reason: "ok" });
    let again = 0;
    const svc2 = c.reopen({ guard: async (taskId: string) => {
      const g = await c.pauses.guard(taskId);
      if (again++ === 0) await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "task", id: t2 }, reason: "task hold" });
      return g;
    } });
    const second = await svc2.send(c.ben.p, { commandId: cid("m"), class: "blocking-dependency", purpose: "ready", text: "Go.", to: c.ann.pid, taskId: t2 });
    assert.equal(second.woke, false);
    assert.equal((await c.waits.getWait(wait2.id))!.state, "open");
  });

  suite("a team-level or installation-level pause holds a wake too", async (c) => {
    const team = (await c.agentsSvc.createTeam(c.owner, { commandId: cid("tm"), name: "platform" })).id;
    const member = await c.agent("member", undefined, { teamId: team });
    const tm = await c.task("team task", member.aid);
    const waitTeam = await c.depWait(tm, c.ben.pid);
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "team", id: team }, reason: "team hold" });
    const held = await c.send(c.ben, { to: member.pid, taskId: tm, class: "blocking-dependency" });
    assert.deepEqual([held.woke, held.reach], [false, "queued"]);
    assert.equal((await c.waits.getWait(waitTeam.id))!.state, "open");
    assert.deepEqual((await c.msgs.release(c.host, { recipient: member.pid })).stillQueued, [held.id]);
    await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: { kind: "team", id: team }, reason: "ok" });
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "installation", id: "installation" }, reason: "everything stops" });
    assert.deepEqual((await c.msgs.release(c.host, { recipient: member.pid })).stillQueued, [held.id]);
    assert.equal((await c.waits.getWait(waitTeam.id))!.state, "open");
    await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: { kind: "installation", id: "installation" }, reason: "ok" });
    assert.deepEqual((await c.msgs.release(c.host, { recipient: member.pid })).woken, [held.id]);
  });

  suite("the wake answer is never cut and names its message, so a repeat cannot take another message's answer for its own", async (c) => {
    const wait = await c.depWait(c.tAnn, c.ben.pid);
    const long = "lorem ipsum ".repeat(333);
    await refuses("invalid_command", () => c.send(c.ben, { to: c.ann.pid, taskId: c.tAnn, class: "blocking-dependency", purpose: "x".repeat(10), text: long }), (e) => assert.match(e.message, /must fit in/));
    // The same long text as advice is fine.
    await c.send(c.ben, { to: c.ann.pid, taskId: c.tAnn, class: "advice", purpose: "x", text: long });
    // Two identical blocking messages queued behind a pause: the first wakes, the second must not be reported as a wake.
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "agent", id: c.ann.aid }, reason: "hold" });
    const one = await c.send(c.ben, { to: c.ann.pid, taskId: c.tAnn, class: "blocking-dependency", purpose: "ready", text: "Same words." });
    const two = await c.send(c.ben, { to: c.ann.pid, taskId: c.tAnn, class: "blocking-dependency", purpose: "ready", text: "Same words." });
    await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: { kind: "agent", id: c.ann.aid }, reason: "ok" });
    const report = await c.msgs.release(c.host, { recipient: c.ann.pid });
    assert.deepEqual([report.woken, report.downgraded], [[one.id], [two.id]]);
    assert.equal((await c.waits.getWait(wait.id))!.answer, `[${one.id}] ready: Same words.`);
    assert.equal((await c.msgs.get(c.ann.p, two.id))!.downgraded, "no_eligible_wait");
  });

  suite("an escalation is stored with the target's real reach, and goes to the owner when the named path can no longer take it", async (c) => {
    // The path is paused: the escalation is kept and reported queued.
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "agent", id: c.boss.aid }, reason: "hold" });
    const r1 = await c.send(c.ben, { to: c.ann.pid, taskId: c.tAnn, deadline: iso(60 * MIN), escalateTo: c.boss.pid, purpose: "first" });
    // The path is disabled after the request was made.
    const tgt = await c.agent("tgt");
    const r2 = await c.send(c.ann, { to: c.cat.pid, taskId: c.tAnn, deadline: iso(60 * MIN), escalateTo: tgt.pid, purpose: "second" });
    const f = await c.storage.getAggregate({ kind: "principal", id: tgt.pid });
    await c.principals.disable(c.owner, { commandId: cid("dis"), principalId: tgt.pid, expectedRevision: f!.revision });
    now += 61 * MIN;
    const done = await c.msgs.settleDue(c.host);
    assert.deepEqual([...done.escalated].sort(), [r1.id, r2.id].sort());
    const e1 = (await c.msgs.get(c.owner, (await c.msgs.get(c.owner, r1.id))!.escalationId!))!;
    assert.deepEqual([e1.to, e1.reach], [c.boss.pid, "queued"]);
    const e2 = (await c.msgs.get(c.owner, (await c.msgs.get(c.owner, r2.id))!.escalationId!))!;
    assert.equal(e2.to, c.ownerId);
    assert.match(e2.text, /can no longer take it/);
    assert.equal(e2.reach, "ready");
  });

  suite("a notice from the controller (R05e) is filed once as advice, never wakes anyone, keeps while the recipient is paused, and is refused for a full inbox or a recipient who cannot see the task", async (c) => {
    const note = (id: string, to = c.ann.pid, taskId = c.tAnn, admit?: "budget.manage") => c.msgs.noticeFromController({ commandId: id, taskId, to, purpose: "budget request", text: `Request ${id} is addressed to you.`, ...(admit === undefined ? {} : { admit }) });
    const first = await note("n-1");
    assert.equal(first.replayed, false);
    assert.equal((await note("n-1")).replayed, true, "the same command files it once");
    const m = (await c.msgs.get(c.ann.p, first.id))!;
    assert.deepEqual([m.sender, m.to, m.kind, m.class, m.effectiveClass, m.state, m.reach, m.taskId], ["controller", c.ann.pid, "notice", "advice", "advice", "accepted", "ready", c.tAnn]);
    assert.equal((await c.msgs.inbox(c.ann.p, c.ann.pid))!.items.length, 1);
    assert.deepEqual((await c.msgs.readable(c.ann.p, { boundary: "safe-boundary" })).items.map((i) => i.id), [first.id]);
    assert.equal((await c.msgs.readable(c.ann.p, { boundary: "interrupt" })).items.length, 0, "advice is never an interruption");
    // Somebody who cannot read the task is not told about it, and an unknown field is refused.
    await refuses("forbidden", () => note("n-2", c.eve.pid));
    await refuses("invalid_command", () => c.msgs.noticeFromController({ commandId: "n-3", taskId: c.tAnn, to: c.ann.pid, purpose: "p", text: "t", class: "urgent-control" } as never));
    // A holder who may decide budget requests but cannot read the task is told; and the controller cannot fill an inbox with notices.
    const decider = await c.agent("decider", [{ action: "budget.manage", project: c.a }]);
    await refuses("forbidden", () => note("n-5x", decider.pid), (e) => assert.match(e.message, /cannot be told/));
    assert.equal((await note("n-5", decider.pid, c.tAnn, "budget.manage")).replayed, false);
    for (let i = 1; i < MESSAGE_LIMITS.perSenderQueue; i++) await note(`cap-${i}`, decider.pid, c.tAnn, "budget.manage");
    await refuses("unavailable", () => note("cap-over", decider.pid, c.tAnn, "budget.manage"), (e) => assert.match(e.message, /crowd out/));
    // A paused recipient keeps the notice queued and nothing resumes it.
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "agent", id: c.cat.aid }, reason: "hold" });
    const held = await note("n-4", c.cat.pid);
    assert.deepEqual([(await c.msgs.get(c.cat.p, held.id))!.reach, (await c.msgs.get(c.cat.p, held.id))!.state], ["queued", "accepted"]);
    // A full per-sender share is `unavailable` and nothing is stored, so the same command succeeds once there is room.
    for (let i = 0; i < MESSAGE_LIMITS.perSenderQueue; i++) await note(`fill-${i}`, c.ben.pid);
    await refuses("unavailable", () => note("late", c.ben.pid));
    const read = await c.msgs.readable(c.ben.p, { boundary: "safe-boundary" });
    await c.msgs.acknowledge(c.ben.p, { commandId: cid("ack"), boundary: "safe-boundary", messageIds: read.items.slice(0, 3).map((i) => i.id) });
    assert.equal((await note("late", c.ben.pid)).replayed, false, "retried after room was made, it is filed");
  });
}
