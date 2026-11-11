import assert from "node:assert/strict";
import { after, test } from "node:test";
import { CriticalPathService } from "../critical/index.js";
import { BlockerService } from "../domain/blockers.js";
import { DomainError } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { ContractService } from "../planning/contracts.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { NotificationService, UrgentWatch, type ChannelAdapter } from "./index.js";

// Card U11d ("U11f"): a decision that waits for the owner and holds up the critical path the owner marked is raised to Urgent (once per project and episode, inside the hourly allowance), put back silently when
// it no longer does (with hysteresis), and listed first in the digest.

after(stopServer);

let now = Date.parse("2026-11-11T12:00:00.000Z");
const iso = (): string => new Date(now).toISOString();
const MIN = 60_000;
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const SECRET_TITLE = "Rotate the payroll signing key";

interface Item { id: string; level: string; state: string; urgent: boolean; immediate: boolean; label: string; detail?: string; ref: { kind: string; id: string }; held?: string; criticalAt?: string; stoppedAt?: string }

for (const backend of backends) {
  const suite = (name: string, body: (c: {
    svc: NotificationService; owner: Principal; sent: { text: string }[]; critical: CriticalPathService; watch: UrgentWatch; restart(): UrgentWatch;
    flush(): Promise<{ digestIds: string[] }>; set(change: Record<string, unknown>): Promise<void>; projectA: string; projectB: string; projectC: string;
    task(project?: string, title?: string): Promise<string>; block(taskId: string, type?: "manual_hold" | "wait_overdue"): Promise<string>; report(blockerId: string): Promise<string>;
    mark(kind: string, id: string, marked?: boolean): Promise<unknown>; dep(task: string, prerequisite: string): Promise<void>; finish(task: string): Promise<void>; resolve(blockerId: string): Promise<void>;
    open(): Promise<Item[]>; raised(): Promise<Item[]>; told(): { text: string }[]; failing: { on: boolean }; watchWith(extra: Partial<ConstructorParameters<typeof UrgentWatch>[0]>): UrgentWatch;
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
        const contracts = ContractService.withEpoch(world.storage, projects.epoch, options);
        const critical = CriticalPathService.withEpoch(world.storage, projects.epoch, { ...options, edges: (p) => contracts.activeEdges(p) });
        const failing = { on: false };
        const holdsUp = async () => { if (failing.on) throw new Error("the marks cannot be read"); return critical.holdsUp(); };
        const svc = NotificationService.withEpoch(world.storage, projects.epoch, { ...options, channels: { pager: channel }, holdsUp });
        const blockers = BlockerService.withEpoch(world.storage, projects.epoch, options);
        const projectA = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "A" })).id;
        const projectB = (await projects.createProject({ commandId: cid("pb"), actor: "owner:rob", name: "B" })).id;
        const projectC = (await projects.createProject({ commandId: cid("pc"), actor: "owner:rob", name: "C" })).id;
        const build = (): UrgentWatch => new UrgentWatch({ notifications: svc, critical: { holdsUp }, clock: iso });
        const set = async (change: Record<string, unknown>): Promise<void> => { await svc.configure(owner, { commandId: cid("cfg"), expectedRevision: (await svc.settings(owner)).revision, ...change } as never); };
        await set({ channel: "external", channelName: "pager" });
        const open = async (): Promise<Item[]> => (await svc.inbox(owner)).items.filter((i) => i.state !== "answered" && i.state !== "settled") as never;
        await body({
          svc, owner, sent, critical, watch: build(), restart: build, flush: () => svc.runDue() as never, set, projectA, projectB, projectC, failing,
          task: async (project = projectA, title = SECRET_TITLE) => (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: project, title })).id,
          block: async (taskId, type = "manual_hold") => (await blockers.openBlocker({ commandId: cid("bl"), actor: "owner:rob", type, subject: { kind: "task", id: taskId }, summary: SECRET_TITLE, resolver: "owner:rob" })).id,
          report: async (blockerId) => (await svc.emitFromController({ commandId: cid("ntf"), kind: "blocker", ref: { kind: "blocker", id: blockerId } })).itemId,
          mark: (kind, id, marked) => critical.mark(owner, { commandId: cid("mk"), kind, ...(kind === "project" ? { projectId: id } : { taskId: id }), ...(marked === undefined ? {} : { marked }) }),
          dep: async (t, p) => { await contracts.addDependency(owner, { commandId: cid("d"), taskId: t, prerequisiteId: p }); },
          finish: async (t) => { let rec = (await projects.getTask(t))!; for (const to of ["ready", "in_progress", "done"] as const) rec = (await projects.transitionTask({ commandId: cid("m"), actor: "owner:rob", taskId: t, expectedRevision: rec.revision, to })) as never; },
          resolve: async (blockerId) => { const b = (await blockers.getBlocker(blockerId))!; await blockers.resolveBlocker({ commandId: cid("rs"), actor: "owner:rob", blockerId, expectedRevision: b.revision, resolution: "fixed" }); },
          open, raised: async () => (await open()).filter((i) => i.criticalAt !== undefined), told: () => sent.filter((m) => /critical path is blocked/.test(m.text)),
          watchWith: (extra) => new UrgentWatch({ notifications: svc, clock: iso, ...extra }),
        });
      } finally { await world.close(); }
    });

  suite("a decision that holds up a marked task is raised to Urgent after the owner's minutes, told once with IDs only, and put back silently once it has stopped holding it up for the same minutes (hysteresis)", async (c) => {
    const task = await c.task(); const blockerId = await c.block(task); await c.report(blockerId);
    await c.watch.sweep(c.owner); now += 30 * MIN; await c.watch.sweep(c.owner);
    assert.equal((await c.raised()).length, 0, "nothing is marked: however long it waits, it is not critical");
    await c.mark("task", task);
    await c.watch.sweep(c.owner);
    assert.equal((await c.raised()).length, 0, "just seen holding it up");
    now += 4 * MIN; await c.watch.sweep(c.owner);
    assert.equal((await c.raised()).length, 0, "4 minutes is inside the default 5");
    now += 2 * MIN; const swept = await c.watch.sweep(c.owner);
    assert.equal(swept.raised.length, 1);
    const [item] = await c.raised();
    assert.equal(item!.level, "urgent"); assert.equal(item!.immediate, true);
    assert.ok(item!.detail!.includes(c.projectA), "the inbox says which project");
    await c.flush();
    assert.equal(c.told().length, 1);
    assert.match(c.told()[0]!.text, new RegExp(`^URGENT, the critical path is blocked in project ${c.projectA} by blocker: manual_hold blocker on task ${task} \\(${blockerId}\\)`));
    assert.ok(!c.sent.map((m) => m.text).join("|").includes(SECRET_TITLE), "no title or summary leaves");
    // Told once: later sweeps and a restart change nothing.
    now += 5 * MIN; await c.watch.sweep(c.owner); await c.restart().sweep(c.owner); await c.flush();
    assert.equal(c.told().length, 1); assert.equal((await c.raised()).length, 1);
    // The owner takes the mark off. Hysteresis: it stays Urgent until it has been clear for the minutes, and a flicker (marked again) resets the count.
    await c.mark("task", task, false);
    await c.watch.sweep(c.owner);
    now += 4 * MIN; await c.watch.sweep(c.owner);
    assert.equal((await c.raised()).length, 1, "clear for 4 minutes: still raised");
    await c.mark("task", task);
    now += 2 * MIN; await c.watch.sweep(c.owner);
    assert.equal((await c.raised()).length, 1, "marked again: stays");
    await c.mark("task", task, false);
    await c.watch.sweep(c.owner);
    now += 4 * MIN; await c.watch.sweep(c.owner);
    assert.equal((await c.raised()).length, 1, "the count started over");
    now += 2 * MIN; const back = await c.watch.sweep(c.owner);
    assert.equal(back.cleared.length, 1);
    const after = (await c.open()).find((i) => i.ref.id === blockerId)!;
    assert.equal(after.level, "needs-you"); assert.equal(after.urgent, false); assert.equal(after.immediate, false); assert.equal(after.detail, undefined); assert.equal(after.criticalAt, undefined);
    await c.flush();
    assert.equal(c.told().length, 1, "putting it back is silent");
    // Critical again: the same item is raised again, never a second item, and the message waits for the project's gap (30 minutes since the first).
    await c.mark("task", task);
    await c.watch.sweep(c.owner); now += 6 * MIN; await c.watch.sweep(c.owner); await c.flush();
    assert.equal((await c.raised()).length, 1);
    assert.equal((await c.open()).filter((i) => i.ref.id === blockerId).length, 1, "one item for the one decision");
    assert.equal(c.told().length, 1, "inside the project's gap it is Urgent in the inbox only");
  });

  suite("what is on the path: a marked task itself (not what it waits for), a goal's whole chain, a marked project; other tasks and other projects are not (the records decide)", async (c) => {
    const marked = await c.task(); const needed = await c.task(); const unrelated = await c.task();
    await c.dep(marked, needed);
    const goal = await c.task(c.projectB); const link = await c.task(c.projectB); const deep = await c.task(c.projectB);
    await c.dep(goal, link); await c.dep(link, deep);
    const inC = await c.task(c.projectC); const outsider = await c.task(c.projectA);
    const ids: Record<string, string> = {};
    for (const [k, t] of Object.entries({ marked, needed, unrelated, deep, inC, outsider })) { ids[k] = await c.report(await c.block(t)); }
    await c.mark("task", marked); await c.mark("goal", goal); await c.mark("project", c.projectC);
    await c.watch.sweep(c.owner); now += 6 * MIN; await c.watch.sweep(c.owner);
    const raised = new Set((await c.raised()).map((i) => i.id));
    assert.deepEqual([...raised].sort(), [ids["marked"]!, ids["deep"]!, ids["inC"]!].sort());
    assert.ok(!raised.has(ids["unrelated"]!) && !raised.has(ids["outsider"]!) && !raised.has(ids["needed"]!), "a prerequisite of a plain marked task is not covered");
  });

  suite("an agent cannot set or suppress it: titles, many decisions and blockers on unmarked tasks page nothing; many decisions on a marked task in one project page the owner once (bounds)", async (c) => {
    for (let i = 0; i < 25; i++) await c.report(await c.block(await c.task(c.projectA, "CRITICAL PATH goal urgent project")));
    await c.watch.sweep(c.owner); now += 60 * MIN; await c.watch.sweep(c.owner); await c.flush();
    assert.equal((await c.raised()).length, 0, "a title says nothing");
    assert.equal(c.told().length, 0);
    // The owner marks the project: 25 decisions of one project are raised in the inbox 20 at a time (bounded per sweep), and ONE message goes out for the project.
    await c.mark("project", c.projectA);
    await c.watch.sweep(c.owner); now += 6 * MIN;
    const first = await c.watch.sweep(c.owner);
    assert.equal(first.raised.length, 20, "20 raises a sweep");
    const second = await c.watch.sweep(c.owner);
    assert.equal(second.raised.length, 5);
    for (let i = 0; i < 3; i++) await c.flush();
    assert.equal((await c.raised()).length, 25);
    assert.equal(c.told().length, 1, `one page for the project, not one per decision: ${JSON.stringify(c.sent)}`);
    assert.equal(c.sent.length, 1, "no summary of held messages either");
  });

  suite("it is inside the hourly Urgent allowance shared with every other trigger and the per-project gap: three marked projects with an allowance of two send two and one summary (bounds)", async (c) => {
    await c.set({ escalationsPerHour: 2 });
    for (const p of [c.projectA, c.projectB, c.projectC]) { await c.mark("project", p); await c.report(await c.block(await c.task(p))); await c.report(await c.block(await c.task(p))); }
    await c.watch.sweep(c.owner); now += 6 * MIN; await c.watch.sweep(c.owner);
    for (let i = 0; i < 4; i++) await c.flush();
    assert.equal((await c.raised()).length, 6, "all are Urgent in the inbox");
    assert.equal(c.told().length, 2, `two messages, one per project, then the limit: ${JSON.stringify(c.sent)}`);
    assert.ok(c.sent.length <= 3, "at most one summary beside them");
    const before = c.sent.length;
    now += 5 * MIN; await c.watch.sweep(c.owner); await c.flush();
    assert.equal(c.sent.length, before, "later sweeps tell nothing more");
  });

  suite("the minutes are the owner's: a number moves them, null turns the trigger off and puts what it raised back; bad numbers and non-owners are refused (card U11d)", async (c) => {
    const t = await c.task(); await c.mark("task", t); const blockerId = await c.block(t); await c.report(blockerId);
    await c.set({ criticalBlockedAfterMinutes: 20 });
    await c.watch.sweep(c.owner); now += 19 * MIN; await c.watch.sweep(c.owner);
    assert.equal((await c.raised()).length, 0, "20 minutes now");
    now += 2 * MIN; await c.watch.sweep(c.owner);
    assert.equal((await c.raised()).length, 1);
    await c.set({ criticalBlockedAfterMinutes: null });
    await c.watch.sweep(c.owner);
    assert.equal((await c.open()).find((i) => i.ref.id === blockerId)!.level, "needs-you", "off: back to Needs you");
    const other = await c.task(c.projectB); await c.mark("task", other); await c.report(await c.block(other));
    now += 600 * MIN; await c.watch.sweep(c.owner);
    assert.equal((await c.raised()).length, 0, "off: nothing is raised");
    for (const bad of [0, 10_081, 2.5, "5", -1, true]) await assert.rejects(() => c.set({ criticalBlockedAfterMinutes: bad }), (e) => e instanceof DomainError && e.code === "invalid_command");
    await assert.rejects(() => c.svc.configure({ ...c.owner, kind: "agent" } as never, { commandId: cid("x"), criticalBlockedAfterMinutes: 5 } as never), (e) => e instanceof DomainError && e.code === "forbidden");
    assert.equal((await c.svc.settings(c.owner) as { criticalBlockedAfterMinutes?: number | null }).criticalBlockedAfterMinutes, null);
    await c.set({ criticalBlockedAfterMinutes: 1 });
    await c.watch.sweep(c.owner); now += 2 * MIN; await c.watch.sweep(c.owner);
    assert.ok((await c.raised()).length >= 1, "a number turns it on again");
  });

  suite("quiet hours: the message is sent through them unless the owner chose otherwise, then it waits for their end (card U11d)", async (c) => {
    await c.set({ quietHours: { start: "00:00", end: "23:59" } });
    const t = await c.task(); await c.mark("task", t); await c.report(await c.block(t));
    await c.watch.sweep(c.owner); now += 6 * MIN; await c.watch.sweep(c.owner); await c.flush(); await c.flush();
    assert.equal(c.told().length, 1, "sent although the whole day is quiet");
    const u = await c.task(c.projectB); await c.mark("task", u); await c.report(await c.block(u));
    await c.set({ urgentInterruptsQuietHours: false });
    await c.watch.sweep(c.owner); now += 6 * MIN; await c.watch.sweep(c.owner); await c.flush(); await c.flush();
    assert.equal((await c.raised()).length, 2, "raised in the inbox");
    assert.equal(c.told().length, 1, "but not sent while it is quiet");
    const waiting = (await c.raised()).find((i) => i.ref.id !== undefined && i.state === "queued");
    assert.ok(waiting !== undefined && waiting.immediate === false, "the second one is queued for the end of quiet hours, not marked as sent");
  });

  suite("a critical message that waited out quiet hours is released as ONE event per project, inside the gap: three decisions of one project send one message (bounds)", async (c) => {
    await c.set({ quietHours: { start: "12:00", end: "13:00" }, urgentInterruptsQuietHours: false });
    await c.mark("project", c.projectA);
    for (let i = 0; i < 3; i++) await c.report(await c.block(await c.task(c.projectA)));
    await c.watch.sweep(c.owner); now += 6 * MIN; await c.watch.sweep(c.owner); await c.flush();
    assert.equal((await c.raised()).length, 3);
    assert.equal(c.told().length, 0, "quiet: nothing is sent");
    now = Date.parse("2026-11-11T13:30:00.000Z");
    for (let i = 0; i < 3; i++) await c.flush();
    // The release after quiet hours sends the plain label (as it does for stopped work); it is one message for the project, not one per decision.
    assert.equal(c.sent.filter((m) => /^blocker: manual_hold blocker on task/.test(m.text)).length, 1, `one message for the project when quiet hours end: ${JSON.stringify(c.sent)}`);
  });

  suite("a decision that is answered, a task that is finished and a source that fails are left alone: nothing is raised, put back or lost", async (c) => {
    const a = await c.task(); const b = await c.task(c.projectB); await c.mark("task", a); await c.mark("task", b);
    const ba = await c.block(a); const bb = await c.block(b); await c.report(ba); await c.report(bb);
    await c.watch.sweep(c.owner);
    // A resolved blocker is closed by the producer and never raised.
    await c.resolve(ba); await c.flush();
    now += 6 * MIN; await c.watch.sweep(c.owner);
    assert.deepEqual((await c.raised()).map((i) => i.ref.id), [bb]);
    // The source fails: nothing is put back and nothing new is raised.
    c.failing.on = true;
    now += 20 * MIN;
    await c.restart().sweep(c.owner);
    assert.equal((await c.raised()).length, 1, "an unreadable path decides nothing");
    c.failing.on = false;
    // The task is finished: the decision about it no longer holds anything up, and goes back after the minutes.
    await c.finish(b);
    await c.watch.sweep(c.owner);
    now += 6 * MIN; const back = await c.watch.sweep(c.owner);
    assert.equal(back.cleared.length, 1);
    assert.equal((await c.raised()).length, 0);
  });

  suite("one trigger per decision: a decision the stopped-work watch raised is not raised again, and one this watch raised is not put back or touched by the stopped-work watch", async (c) => {
    const t = await c.task(); await c.mark("task", t); const blockerId = await c.block(t); const itemId = await c.report(blockerId);
    const idle = { value: true as boolean | undefined };
    const both = c.watchWith({ critical: { holdsUp: () => c.critical.holdsUp() }, work: { idle: async () => idle.value } });
    await both.sweep(c.owner); now += 31 * MIN; const swept = await both.sweep(c.owner);
    assert.equal(swept.raised.length, 1, "one raise, not two");
    const item = (await c.open()).find((i) => i.id === itemId)!;
    assert.ok(item.criticalAt !== undefined && item.stoppedAt === undefined, "the critical watch comes first");
    // Work resumes in the project: the stopped-work watch does not put back what the critical watch raised.
    idle.value = false;
    await both.sweep(c.owner);
    assert.ok((await c.open()).find((i) => i.id === itemId)!.criticalAt !== undefined);
    assert.equal(await c.svc.lowerStopped(itemId), false, "lowerStopped leaves a critical item alone");
    assert.equal(await c.svc.raiseStopped(itemId, { minutes: 1, limit: 1 }), false, "an item raised by the other trigger is not raised again");
    assert.equal(await c.svc.lowerCritical(itemId), true);
    assert.equal(await c.svc.lowerCritical(itemId), false, "and only once");
  });

  suite("the digest lists what holds up the critical path first, then the oldest, then the kind; with nothing marked the order is by age (the Needs-you digest order)", async (c) => {
    now = Date.parse("2026-11-11T08:00:00.000Z");
    await c.set({ escalateAfterHours: null });
    const plain = await c.task(c.projectA); const plain2 = await c.task(c.projectA); const crit = await c.task(c.projectB); const crit2 = await c.task(c.projectB);
    await c.report(await c.block(plain)); now += MIN;
    await c.report(await c.block(crit)); now += MIN;
    await c.report(await c.block(crit2)); now += MIN;
    await c.report(await c.block(plain2));
    now = Date.parse("2026-11-11T09:01:00.000Z");
    // Nothing marked yet: by age.
    const before = await c.svc.inbox(c.owner);
    assert.equal(before.items.length, 4);
    await c.mark("task", crit); await c.mark("task", crit2);
    const ran = await c.flush();
    assert.equal(ran.digestIds.length, 1);
    const text = c.sent.find((m) => /items for you/.test(m.text))!.text;
    const lines = text.split("\n").filter((l) => /^\d+\. /.test(l));
    assert.equal(lines.length, 4);
    assert.ok(lines[0]!.includes("[holds up the critical path]") && lines[1]!.includes("[holds up the critical path]"), text);
    assert.ok(lines[0]!.includes(crit) && lines[1]!.includes(crit2), "the critical ones, oldest first");
    assert.ok(!lines[2]!.includes("critical") && !lines[3]!.includes("critical"));
    assert.ok(lines[2]!.includes(plain) && lines[3]!.includes(plain2), "then the others, oldest first");
    assert.ok(!text.includes(SECRET_TITLE));
  });

  suite("the digest without marks keeps its order by age, and a failing source leaves that order", async (c) => {
    now = Date.parse("2026-11-11T08:00:00.000Z");
    await c.set({ escalateAfterHours: null });
    const t1 = await c.task(c.projectA); const t2 = await c.task(c.projectB);
    await c.report(await c.block(t1)); now += MIN; await c.report(await c.block(t2));
    await c.mark("task", t2);
    c.failing.on = true;
    now = Date.parse("2026-11-11T09:01:00.000Z");
    await c.flush();
    const lines = c.sent.find((m) => /items for you/.test(m.text))!.text.split("\n").filter((l) => /^\d+\. /.test(l));
    assert.ok(lines[0]!.includes(t1) && lines[1]!.includes(t2) && !lines.join("").includes("critical"), "the marks could not be read: by age");
  });
}
