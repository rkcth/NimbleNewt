import assert from "node:assert/strict";
import { after, test } from "node:test";
import { BlockerService } from "../domain/blockers.js";
import { DomainError } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { NotificationService, UrgentWatch, workSource, WORK_LIMITS, type ChannelAdapter, type WorkSource } from "./index.js";

// Card U11d: a decision that holds up a project with nothing else to do is raised to Urgent (and put back when work resumes), and the plain 09:00 digest gives way to a scheduled stand-up.

after(stopServer);

let now = Date.parse("2026-11-11T12:00:00.000Z");
const iso = (): string => new Date(now).toISOString();
const MIN = 60_000;
const HOUR = 3_600_000;
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const SECRET_TITLE = "Rotate the payroll signing key";

interface Item { id: string; level: string; state: string; urgent: boolean; immediate: boolean; label: string; detail?: string; ref: { kind: string; id: string }; held?: string }

for (const backend of backends) {
  const suite = (name: string, body: (c: {
    svc: NotificationService; owner: Principal; sent: { text: string }[]; work: { idle: Map<string, boolean | undefined>; reads: number };
    watch: UrgentWatch; restart(): UrgentWatch; flush(): Promise<unknown>; set(change: Record<string, unknown>): Promise<void>;
    projectA: string; projectB: string; held(projectId?: string, type?: "manual_hold" | "wait_overdue"): Promise<{ blockerId: string; taskId: string }>; report(blockerId: string): Promise<string>;
    open(): Promise<Item[]>; stopped(): Promise<Item[]>; standup: { scheduled: boolean | "throws" | ReadonlySet<string>; asked: number }; digestSvc(): NotificationService; resolve(blockerId: string): Promise<void>;
  }) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      now = Date.parse("2026-11-11T12:00:00.000Z");
      const world = await backend.open();
      try {
        const options = { clock: iso, pause: async () => undefined };
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = (await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token))!;
        const sent: { text: string }[] = [];
        const channel: ChannelAdapter = { send: async (m) => { sent.push({ text: m.text }); } };
        const standup: { scheduled: boolean | "throws" | ReadonlySet<string>; asked: number } = { scheduled: false, asked: 0 };
        const make = (): NotificationService => NotificationService.withEpoch(world.storage, projects.epoch, { ...options, channels: { pager: channel }, standupProjects: async () => { standup.asked++; if (standup.scheduled === "throws") throw new Error("stand-ups are not running"); return standup.scheduled === true ? new Set([projectA, projectB]) : standup.scheduled === false ? new Set<string>() : standup.scheduled; } });
        const svc = make();
        const blockers = BlockerService.withEpoch(world.storage, projects.epoch, options);
        const projectA = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "A" })).id;
        const projectB = (await projects.createProject({ commandId: cid("pb"), actor: "owner:rob", name: "B" })).id;
        const work = { idle: new Map<string, boolean | undefined>(), reads: 0 };
        const source: WorkSource = { idle: async (p) => { work.reads++; return work.idle.get(p); } };
        const build = (): UrgentWatch => new UrgentWatch({ notifications: svc, work: source, clock: iso });
        const set = async (change: Record<string, unknown>): Promise<void> => { await svc.configure(owner, { commandId: cid("cfg"), expectedRevision: (await svc.settings(owner)).revision, ...change } as never); };
        await set({ channel: "external", channelName: "pager" });
        const held = async (projectId = projectA, type: "manual_hold" | "wait_overdue" = "manual_hold"): Promise<{ blockerId: string; taskId: string }> => {
          const taskId = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId, title: SECRET_TITLE })).id;
          const blockerId = (await blockers.openBlocker({ commandId: cid("bl"), actor: "owner:rob", type, subject: { kind: "task", id: taskId }, summary: SECRET_TITLE, resolver: "owner:rob" })).id;
          return { blockerId, taskId };
        };
        const open = async (): Promise<Item[]> => (await svc.inbox(owner)).items.filter((i) => i.state !== "answered" && i.state !== "settled") as never;
        await body({
          svc, owner, sent, work, watch: build(), restart: build, flush: () => svc.runDue(), set, projectA, projectB, held, standup, digestSvc: make,
          report: async (blockerId) => (await svc.emitFromController({ commandId: cid("ntf"), kind: "blocker", ref: { kind: "blocker", id: blockerId } })).itemId,
          open, stopped: async () => (await open()).filter((i) => i.detail?.includes("nothing else to do") === true),
          resolve: async (blockerId) => { const b = (await blockers.getBlocker(blockerId))!; await blockers.resolveBlocker({ commandId: cid("rs"), actor: "owner:rob", blockerId, expectedRevision: b.revision, resolution: "fixed" }); },
        });
      } finally { await world.close(); }
    });

  suite("a waiting decision in a project with nothing else to do becomes Urgent after the owner's minutes, told once, and goes back to Needs you when work resumes (card U11d)", async (c) => {
    const { blockerId } = await c.held();
    await c.report(blockerId);
    c.work.idle.set(c.projectA, true);
    await c.watch.sweep(c.owner);
    assert.equal((await c.stopped()).length, 0, "just seen idle: nothing yet");
    now += 29 * MIN; await c.watch.sweep(c.owner);
    assert.equal((await c.stopped()).length, 0, "29 minutes is inside the default 30");
    now += 2 * MIN; const swept = await c.watch.sweep(c.owner);
    assert.equal(swept.raised.length, 1);
    const [item] = await c.stopped();
    assert.equal(item!.level, "urgent");
    assert.equal(item!.immediate, true);
    assert.ok(item!.detail!.includes(c.projectA), "the inbox says which project");
    await c.flush();
    assert.equal(c.sent.length, 1);
    assert.match(c.sent[0]!.text, new RegExp(`URGENT, work is stopped: nothing else to do in project ${c.projectA} while blocker: manual_hold blocker on task task-[a-z2-7]+ \\(${blockerId}\\)`));
    // Only IDs and labels leave: no task title, no blocker summary, no free text.
    assert.ok(!c.sent.map((m) => m.text).join("|").includes(SECRET_TITLE));
    // Told once: later sweeps, a restart and more time change nothing.
    now += 5 * MIN; await c.watch.sweep(c.owner); await c.restart().sweep(c.owner);
    await c.flush();
    assert.equal(c.sent.length, 1);
    assert.equal((await c.stopped()).length, 1);
    // Work resumed: the same item is back at Needs you, still open, and nothing is sent.
    c.work.idle.set(c.projectA, false);
    const back = await c.watch.sweep(c.owner);
    assert.equal(back.cleared.length, 1);
    const after = (await c.open()).find((i) => i.ref.id === blockerId)!;
    assert.equal(after.level, "needs-you");
    assert.equal(after.urgent, false);
    assert.equal(after.immediate, false);
    assert.equal(after.detail, undefined);
    await c.flush();
    assert.equal(c.sent.length, 1, "putting it back is silent");
    // Idle again: the clock starts over (from the sweep that saw it idle), and the same item is raised again, never as a second item.
    c.work.idle.set(c.projectA, true);
    await c.watch.sweep(c.owner);
    now += 31 * MIN; await c.watch.sweep(c.owner);
    assert.equal((await c.stopped()).length, 1);
    assert.equal((await c.open()).filter((i) => i.ref.id === blockerId).length, 1, "one item for the one decision");
    await c.flush();
    assert.equal(c.sent.length, 2, "a new stop is told again (outside the gap)");
  });

  suite("work in the project, an unknown answer, another project's idleness and an answered decision raise nothing (card U11d)", async (c) => {
    const a = await c.held(c.projectA); const b = await c.held(c.projectB);
    await c.report(a.blockerId); await c.report(b.blockerId);
    c.work.idle.set(c.projectA, false); c.work.idle.set(c.projectB, undefined);
    await c.watch.sweep(c.owner);
    now += 90 * MIN; await c.watch.sweep(c.owner);
    assert.equal((await c.stopped()).length, 0, "A has work, B is not known");
    now += 31 * MIN; await c.watch.sweep(c.owner);
    assert.equal((await c.stopped()).length, 0, "not knowing is never read as idle, however long it lasts");
    // B turns out idle: the wait counts from the sweep that saw it, not from the item's age.
    c.work.idle.set(c.projectB, true);
    await c.watch.sweep(c.owner);
    assert.equal((await c.stopped()).length, 0, "an old item in a project that has just run dry is not paged at once");
    now += 31 * MIN; await c.watch.sweep(c.owner);
    const items = await c.stopped();
    assert.equal(items.length, 1);
    assert.equal(items[0]!.ref.id, b.blockerId, "only the idle project's decision");
    // A decision the owner answered (closed) is not touched, and a source that fails decides nothing.
    c.work.idle.set(c.projectA, true);
    await c.watch.sweep(c.owner);
    await c.resolve(a.blockerId);
    await c.flush();
    now += 40 * MIN; await c.watch.sweep(c.owner);
    assert.equal((await c.stopped()).filter((i) => i.ref.id === a.blockerId).length, 0, "a resolved blocker is closed, not raised");
    const failing = new UrgentWatch({ notifications: c.svc, work: { idle: async () => { throw new Error("boom"); } }, clock: iso });
    await failing.sweep(c.owner);
  });

  suite("the minutes are the owner's: a number moves them, null turns the trigger off and puts what it raised back (card U11d)", async (c) => {
    const { blockerId } = await c.held();
    await c.report(blockerId);
    c.work.idle.set(c.projectA, true);
    await c.set({ stoppedWorkAfterMinutes: 5 });
    await c.watch.sweep(c.owner);
    now += 6 * MIN; await c.watch.sweep(c.owner);
    assert.equal((await c.stopped()).length, 1, "5 minutes now");
    await c.set({ stoppedWorkAfterMinutes: null });
    await c.watch.sweep(c.owner);
    const item = (await c.open()).find((i) => i.ref.id === blockerId)!;
    assert.equal(item.level, "needs-you", "off: back to Needs you");
    const b = await c.held(); await c.report(b.blockerId);
    now += 600 * MIN; await c.watch.sweep(c.owner);
    assert.equal((await c.stopped()).length, 0, "off: nothing is raised however long it waits");
    await assert.rejects(() => c.set({ stoppedWorkAfterMinutes: 0 }), (e) => e instanceof DomainError && e.code === "invalid_command");
    await assert.rejects(() => c.set({ stoppedWorkAfterMinutes: 20_000 }), (e) => e instanceof DomainError && e.code === "invalid_command");
    await assert.rejects(() => c.set({ stoppedWorkAfterMinutes: 10_081 }), (e) => e instanceof DomainError && e.code === "invalid_command");
    await assert.rejects(() => c.set({ stoppedWorkAfterMinutes: 2.5 }), (e) => e instanceof DomainError && e.code === "invalid_command");
    await assert.rejects(() => c.set({ stoppedWorkAfterMinutes: "5" }), (e) => e instanceof DomainError && e.code === "invalid_command");
    await assert.rejects(() => c.svc.configure({ ...c.owner, kind: "agent" } as never, { commandId: cid("x"), stoppedWorkAfterMinutes: 5 } as never), (e) => e instanceof DomainError && e.code === "forbidden");
    assert.equal((await c.svc.settings(c.owner) as { stoppedWorkAfterMinutes?: number | null }).stoppedWorkAfterMinutes, null);
  });

  suite("a burst of stopped decisions cannot flood: the hourly Urgent limit and the gap hold the messages, the rest stay Urgent in the inbox (card U11d)", async (c) => {
    await c.set({ escalationsPerHour: 3 });
    c.work.idle.set(c.projectA, true);
    for (let i = 0; i < 12; i++) await c.report((await c.held(c.projectA, i % 2 === 0 ? "manual_hold" : "wait_overdue")).blockerId);
    await c.watch.sweep(c.owner);
    now += 31 * MIN; await c.watch.sweep(c.owner);
    for (let i = 0; i < 4; i++) await c.flush();
    const stopped = await c.stopped();
    assert.equal(stopped.length, 12, "every one is raised in the inbox");
    assert.ok(c.sent.length <= 4, `3 messages and at most one summary, not ${c.sent.length}: ${JSON.stringify(c.sent)}`);
    assert.ok(c.sent.filter((m) => m.text.startsWith("URGENT, work is stopped")).length <= 3);
    assert.ok(!c.sent.map((m) => m.text).join("|").includes(SECRET_TITLE));
    const sentBefore = c.sent.length;
    now += 5 * MIN; await c.watch.sweep(c.owner); await c.flush();
    assert.equal(c.sent.length, sentBefore, "nothing more is told on later sweeps");
  });

  suite("quiet hours: the stopped-work message is sent through them unless the owner chose otherwise, then it waits for their end (card U11d)", async (c) => {
    await c.set({ quietHours: { start: "00:00", end: "23:59" } });
    const { blockerId } = await c.held();
    await c.report(blockerId);
    c.work.idle.set(c.projectA, true);
    await c.watch.sweep(c.owner);
    now += 31 * MIN; await c.watch.sweep(c.owner); await c.flush(); await c.flush();
    assert.equal(c.sent.length, 1, "sent although the whole day is quiet");
    const b = await c.held(); await c.report(b.blockerId);
    await c.set({ urgentInterruptsQuietHours: false });
    await c.watch.sweep(c.owner);
    now += 31 * MIN; await c.watch.sweep(c.owner); await c.flush(); await c.flush();
    assert.equal((await c.stopped()).length, 2, "raised in the inbox");
    assert.equal(c.sent.length, 1, "but not sent while it is quiet");
  });

  suite("the plain 09:00 digest is sent only when no stand-up is scheduled; times the owner named always send (card U11d)", async (c) => {
    now = Date.parse("2026-11-11T08:00:00.000Z");
    await c.set({ escalateAfterHours: null }); // a day-old item would otherwise be escalated, not queued for the digest
    const first = await c.held(); await c.report(first.blockerId);
    // The owner has not named digest times and a stand-up is scheduled: 09:00 passes without a digest, and the item stays in the Needs-you view.
    c.standup.scheduled = true;
    now = Date.parse("2026-11-11T09:01:00.000Z");
    assert.deepEqual((await c.flush() as { digestIds: string[] }).digestIds, []);
    assert.equal((await c.open()).length, 1);
    assert.equal(c.standup.asked, 1);
    await c.flush(); now += 10 * MIN; await c.flush();
    assert.equal(c.standup.asked, 1, "asked once per digest time, not on every run");
    // The next day, the stand-up has ended: the digest comes at 09:00 again and carries what was waiting.
    c.standup.scheduled = false;
    now = Date.parse("2026-11-12T09:01:00.000Z");
    assert.equal(((await c.flush()) as { digestIds: string[] }).digestIds.length, 1);
    // A source that fails counts as no stand-up: the owner is told.
    c.standup.scheduled = "throws";
    const second = await c.held(); await c.report(second.blockerId);
    now = Date.parse("2026-11-13T09:01:00.000Z");
    assert.equal(((await c.flush()) as { digestIds: string[] }).digestIds.length, 1);
    // Digest times the owner named are the owner's choice, stand-up or not (even the same 09:00).
    c.standup.scheduled = true;
    await c.set({ digestTimes: ["09:00"] });
    const third = await c.held(); await c.report(third.blockerId);
    now = Date.parse("2026-11-14T09:01:00.000Z");
    assert.equal(((await c.flush()) as { digestIds: string[] }).digestIds.length, 1);
  });

  suite("the plain digest gives way only to stand-ups that carry its decisions: an item of a project without one, or of no project, is still told at 09:00 (card U11d review)", async (c) => {
    now = Date.parse("2026-11-11T08:00:00.000Z");
    await c.set({ escalateAfterHours: null });
    // A stand-up in project B does not carry project A's decision: the digest is sent.
    c.standup.scheduled = new Set([c.projectB]);
    const a = await c.held(c.projectA); await c.report(a.blockerId);
    now = Date.parse("2026-11-11T09:01:00.000Z");
    assert.equal(((await c.flush()) as { digestIds: string[] }).digestIds.length, 1, "project A has no stand-up");
    // A maintenance item of the installation (no project) is on no stand-up's agenda, and the 24-hour escalation does not cover it: the digest is sent.
    c.standup.scheduled = new Set([c.projectA, c.projectB]);
    await c.svc.emitFromController({ commandId: cid("mnt"), kind: "maintenance", ref: { kind: "responsibility", id: "r1" } });
    now = Date.parse("2026-11-12T09:01:00.000Z");
    assert.equal(((await c.flush()) as { digestIds: string[] }).digestIds.length, 1, "an item of no project is told");
    // Everything queued is on a stand-up's agenda: the digest gives way.
    const b = await c.held(c.projectB); await c.report(b.blockerId);
    now = Date.parse("2026-11-13T09:01:00.000Z");
    assert.deepEqual(((await c.flush()) as { digestIds: string[] }).digestIds, [], "project B's stand-up carries it");
    // An empty answer (no stand-up anywhere) never skips.
    c.standup.scheduled = new Set();
    now = Date.parse("2026-11-14T09:01:00.000Z");
    assert.equal(((await c.flush()) as { digestIds: string[] }).digestIds.length, 1);
  });

  suite("stopped work is one event per project: many decisions of one idle project send ONE message per gap and leave the hour's Urgent allowance to other triggers (card U11d review)", async (c) => {
    c.work.idle.set(c.projectA, true); c.work.idle.set(c.projectB, true);
    for (let i = 0; i < 8; i++) await c.report((await c.held(c.projectA)).blockerId);
    await c.report((await c.held(c.projectB)).blockerId);
    await c.watch.sweep(c.owner);
    now += 31 * MIN; await c.watch.sweep(c.owner);
    for (let i = 0; i < 3; i++) await c.flush();
    assert.equal((await c.stopped()).length, 9, "every one is Urgent in the inbox");
    const told = c.sent.filter((m) => m.text.startsWith("URGENT, work is stopped"));
    assert.equal(told.length, 2, `one per project, not one per decision: ${JSON.stringify(c.sent)}`);
    assert.ok(told.some((m) => m.text.includes(c.projectA)) && told.some((m) => m.text.includes(c.projectB)));
    assert.equal(c.sent.length, 2, "nothing was held for the hour's limit, so no summary either");
    // Another decision of project A raised inside the owner's gap for the project is still not sent on its own.
    await c.set({ urgentMinGapMinutes: 120 });
    await c.report((await c.held(c.projectA)).blockerId);
    now += 31 * MIN; await c.watch.sweep(c.owner); await c.flush();
    assert.equal(c.sent.filter((m) => m.text.startsWith("URGENT, work is stopped")).length, 2, "inside the gap for project A");
  });

  suite("after quiet hours the deferred stopped-work messages of one project are released as one (card U11d review)", async (c) => {
    now = Date.parse("2026-11-11T12:00:00.000Z");
    await c.set({ quietHours: { start: "11:00", end: "13:00" }, urgentInterruptsQuietHours: false });
    c.work.idle.set(c.projectA, true);
    for (let i = 0; i < 4; i++) await c.report((await c.held(c.projectA)).blockerId);
    await c.watch.sweep(c.owner);
    now += 31 * MIN; await c.watch.sweep(c.owner); await c.flush();
    assert.equal((await c.stopped()).length, 4);
    assert.equal(c.sent.length, 0, "quiet");
    now = Date.parse("2026-11-11T13:05:00.000Z");
    for (let i = 0; i < 3; i++) await c.flush();
    assert.equal(c.sent.length, 1, `one message for the project after quiet hours: ${JSON.stringify(c.sent)}`);
  });

  suite("the service raises an item once, never an item that is Urgent for another reason, and puts back only what the watch raised (card U11d)", async (c) => {
    const a = await c.held(); const itemA = await c.report(a.blockerId);
    assert.equal(await c.svc.lowerStopped(itemA), false, "not raised by the watch: nothing to put back");
    assert.equal(await c.svc.raiseStopped(itemA, { minutes: 40, limit: 30 }), true);
    assert.equal(await c.svc.raiseStopped(itemA, { minutes: 41, limit: 30 }), false, "once per episode");
    await c.flush(); await c.flush();
    assert.equal(c.sent.length, 1);
    // Urgent for another reason (a critical blocker, an escalation after a day): left as it is, also by lowerStopped.
    const b = await c.held(c.projectA, "wait_overdue");
    const itemB = (await c.svc.emitFromController({ commandId: cid("crit"), kind: "blocker", ref: { kind: "blocker", id: b.blockerId }, critical: true })).itemId;
    assert.equal(await c.svc.raiseStopped(itemB, { minutes: 40, limit: 30 }), false, "already Urgent");
    assert.equal(await c.svc.lowerStopped(itemB), false, "not the watch's to put back");
    assert.equal((await c.open()).find((i) => i.id === itemB)!.level, "urgent");
    const d = await c.held(); const itemD = await c.report(d.blockerId);
    await c.set({ escalateAfterHours: 1 });
    await c.svc.runDue(); now += 61 * MIN; await c.svc.runDue();
    assert.equal((await c.open()).find((i) => i.id === itemD)!.level, "urgent", "escalated after waiting");
    assert.equal(await c.svc.lowerStopped(itemD), false);
    assert.equal((await c.open()).find((i) => i.id === itemD)!.level, "urgent", "an escalation is not undone when work resumes");
    // A closed decision is not raised.
    const e = await c.held(); const itemE = await c.report(e.blockerId);
    await c.resolve(e.blockerId); await c.svc.runDue();
    assert.equal(await c.svc.raiseStopped(itemE, { minutes: 40, limit: 30 }), false);
    // The candidates the watch is offered are only what waits on the owner and is still Needs you, plus what the watch raised.
    const page = await c.svc.waitingOnOwner({ limit: 100 });
    assert.deepEqual(page.items.map((i) => i.id).sort(), [itemA].sort(), JSON.stringify(page.items));
    assert.equal(page.items[0]!.stopped, true);
  });

  suite("a restart of the controller forgets nothing: an item raised stays raised and goes back when work resumes (card U11d)", async (c) => {
    const { blockerId } = await c.held();
    await c.report(blockerId);
    c.work.idle.set(c.projectA, true);
    await c.watch.sweep(c.owner);
    now += 31 * MIN; await c.watch.sweep(c.owner);
    await c.flush();
    assert.equal(c.sent.length, 1);
    const again = c.restart();
    await again.sweep(c.owner);
    now += 2 * MIN; await again.sweep(c.owner); await c.flush();
    assert.equal(c.sent.length, 1, "not raised twice");
    c.work.idle.set(c.projectA, false);
    await again.sweep(c.owner);
    assert.equal((await c.open()).find((i) => i.ref.id === blockerId)!.level, "needs-you");
  });

  test(`${backend.name}: the work view says a project has nothing else to do when no ready or running task is free of an open blocker (card U11d)`, async () => {
    now = Date.parse("2026-11-11T12:00:00.000Z");
    const world = await backend.open();
    try {
      const options = { clock: iso, pause: async () => undefined };
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const blockers = BlockerService.withEpoch(world.storage, projects.epoch, options);
      const a = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "A" })).id;
      const b = (await projects.createProject({ commandId: cid("pb"), actor: "owner:rob", name: "B" })).id;
      const task = async (project: string, to: "ready" | "in_progress" | "done" | "cancelled" | "proposed"): Promise<string> => {
        const t = await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: project, title: "T" });
        let revision = t.revision;
        const path: Record<string, string[]> = { proposed: [], ready: ["ready"], in_progress: ["ready", "in_progress"], done: ["ready", "in_progress", "done"], cancelled: ["cancelled"] };
        for (const step of path[to]!) revision = (await projects.transitionTask({ commandId: cid("m"), actor: "owner:rob", taskId: t.id, expectedRevision: revision, to: step as never })).revision;
        return t.id;
      };
      const hold = (taskId: string): Promise<{ id: string }> => blockers.openBlocker({ commandId: cid("bl"), actor: "owner:rob", type: "manual_hold", subject: { kind: "task", id: taskId }, summary: "hold", resolver: "owner:rob" });
      const view = workSource({ tasks: projects, blockers });
      assert.equal(await view.idle(a), true, "no tasks: nothing to do");
      await task(a, "proposed"); await task(a, "done"); await task(a, "cancelled");
      assert.equal(await view.idle(a), true, "proposed, finished and cancelled tasks cannot go on");
      const ready = await task(a, "ready");
      assert.equal(await view.idle(a), false, "a ready task can go on");
      const held = await hold(ready);
      assert.equal(await view.idle(a), true, "held by an open blocker");
      const running = await task(a, "in_progress");
      assert.equal(await view.idle(a), false, "a running task free of blockers");
      assert.equal(await view.idle(b), true, "another project's tasks do not count");
      await hold(running);
      assert.equal(await view.idle(a), true);
      const bl = (await blockers.getBlocker(held.id))!;
      await blockers.resolveBlocker({ commandId: cid("rs"), actor: "owner:rob", blockerId: held.id, expectedRevision: bl.revision, resolution: "ok" });
      assert.equal(await view.idle(a), false, "a resolved blocker no longer holds the task");
      // A read that fails, or too much to read, is not known: it never says idle.
      assert.equal(await workSource({ tasks: { listTasks: async () => { throw new Error("down"); } }, blockers }).idle(a), undefined);
      const endless = { listTasks: async (q: { afterId?: string }) => ({ items: [], next: `${q.afterId ?? "t"}x` }) };
      assert.equal(await workSource({ tasks: endless as never, blockers }).idle(a), undefined, "a project too big to read");
      assert.ok(WORK_LIMITS.tasks >= WORK_LIMITS.taskPage);
    } finally { await world.close(); }
  });
}
