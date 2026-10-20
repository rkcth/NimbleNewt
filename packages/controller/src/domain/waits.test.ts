import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  AssignmentService, BlockerService, DomainError, EffectService, InboxService, Reconciler, WaitService, taskEventId,
  type DomainErrorCode, type Owner,
} from "./index.js";
import { ProjectService } from "./service.js";
import { backends, stopServer, type World } from "./testing/backends.js";

after(stopServer);

const T0 = Date.parse("2026-10-20T10:00:00.000Z");
const me = "rob";
const ann: Owner = { kind: "agent", id: "ann" };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const iso = (ms: number): string => new Date(ms).toISOString();

const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof DomainError, `expected a DomainError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    check?.(error);
    return true;
  });
};

for (const backend of backends) {
  interface Ctx { projects: ProjectService; assign: AssignmentService; waits: WaitService; blockers: BlockerService; world: World; epoch: number; clock: { now: number }; reconciler(): Reconciler }
  const suite = (name: string, body: (ctx: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      const clock = { now: T0 };
      const options = { clock: () => iso(clock.now), pause: async () => undefined };
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const epoch = projects.epoch;
        const assign = AssignmentService.withEpoch(world.storage, epoch, projects, options);
        const waits = WaitService.withEpoch(world.storage, epoch, assign, options);
        const blockers = BlockerService.withEpoch(world.storage, epoch, options);
        const reconciler = () => new Reconciler(world.storage, epoch, {
          projects, inbox: InboxService.withEpoch(world.storage, epoch, assign, options), effects: EffectService.withEpoch(world.storage, epoch, assign, { ...options, holder: "waits-test" }),
          blockers, waits, bridges: {}, destinations: [],
        }, options);
        await body({ projects, assign, waits, blockers, world, epoch, clock, reconciler });
      } finally { await world.close(); }
    });
  const readyTask = async (projects: ProjectService, title = "x"): Promise<string> => {
    const p = await projects.createProject({ commandId: cid("p"), actor: me, name: "Garden" });
    const t = await projects.createTask({ commandId: cid("t"), actor: me, projectId: p.id, title });
    await projects.transitionTask({ commandId: cid("r"), actor: me, taskId: t.id, expectedRevision: 1, to: "ready" });
    return t.id;
  };
  const timed = (taskId: string, clock: { now: number }, onDeadline: "resume" | "cancel" | "escalate", extra: Record<string, unknown> = {}) => ({
    commandId: cid("w"), actor: me, taskId, reason: "approval" as const, resolver: "owner", summary: "may I delete the old beds?", nextAction: "delete the beds and continue",
    deadline: iso(clock.now + 60_000), onDeadline, ...extra,
  });

  suite("a wait must say what happens next: a deadline with its outcome, or an explicit indefinite hold with its owner", async ({ projects, waits, clock }) => {
    const taskId = await readyTask(projects);
    const base = timed(taskId, clock, "resume");
    const { deadline: _d, onDeadline: _o, ...noTiming } = base;
    await refuses("invalid_command", () => waits.openWait(noTiming), (e) => assert.match(e.message, /deadline with what happens at it/));
    await refuses("invalid_command", () => waits.openWait({ ...base, indefinite: { owner: "rob" } }));
    await refuses("invalid_command", () => waits.openWait({ ...base, onDeadline: undefined as never }));
    await refuses("invalid_command", () => waits.openWait({ ...base, deadline: "tomorrow" }));
    await refuses("invalid_command", () => waits.openWait({ ...noTiming, indefinite: { owner: "" } }));
    await refuses("invalid_command", () => waits.openWait({ ...base, nextAction: "" }));
    await refuses("invalid_command", () => waits.openWait({ ...base, reason: "whim" as never }));
    await refuses("invalid_command", () => waits.openWait({ ...base, resolver: "" }));
    await refuses("invalid_command", () => waits.openWait({ ...base, colour: "red" } as never));
    assert.equal((await projects.getTask(taskId))!.state, "ready", "nothing was blocked by a refused wait");
  });

  suite("opening a wait blocks the task, schedules the deadline and announces it, all in one transaction; a task has one wait at a time", async ({ projects, waits, world, clock }) => {
    const taskId = await readyTask(projects);
    const r = await waits.openWait(timed(taskId, clock, "resume"));
    const wait = (await waits.getWait(r.id))!;
    assert.deepEqual([wait.state, wait.reason, wait.resolver, wait.onDeadline, wait.nextAction], ["open", "approval", "owner", "resume", "delete the beds and continue"]);
    assert.equal((await projects.getTask(taskId))!.state, "blocked");
    const timer = await world.storage.getTimer(`wt:${r.id}`);
    assert.deepEqual([timer?.state, timer?.dueAt], ["pending", iso(clock.now + 60_000)]);
    assert.equal((await world.storage.getDelivery(taskEventId(taskId, 3)))?.payload["state"], "blocked");
    assert.equal((await waits.openFor(taskId))?.id, r.id);
    await refuses("invalid_command", () => waits.openWait(timed(taskId, clock, "cancel")), (e) => assert.match(e.message, /not blocked|only a ready or in-progress|already waiting/));
    await refuses("not_found", () => waits.openWait({ ...timed(taskId, clock, "resume"), taskId: "task-aaaaaaaaaaaaaaaaaaaa" }));
  });

  suite("an indefinite wait has no deadline, names its owner, and stays open", async ({ projects, waits, world, clock, reconciler }) => {
    const taskId = await readyTask(projects);
    const { deadline: _d, onDeadline: _o, ...rest } = timed(taskId, clock, "resume");
    const r = await waits.openWait({ ...rest, indefinite: { owner: "rob" } });
    const wait = (await waits.getWait(r.id))!;
    assert.deepEqual([wait.indefinite, wait.deadline, wait.onDeadline], [{ owner: "rob" }, undefined, undefined]);
    assert.equal(await world.storage.getTimer(`wt:${r.id}`), undefined);
    clock.now += 365 * 24 * 3600_000;
    const report = await reconciler().runPass();
    assert.deepEqual([report.waitsTimedOut, report.unexplainedBlocks], [0, 0], "an indefinite wait is explained: it names its owner");
    assert.equal((await waits.getWait(r.id))!.state, "open");
  });

  suite("the named resolver answers: the task is released, the deadline is cancelled and a second answer is refused", async ({ projects, waits, world, clock }) => {
    const taskId = await readyTask(projects);
    const r = await waits.openWait(timed(taskId, clock, "cancel"));
    await refuses("invalid_command", () => waits.answerWait({ commandId: cid("a"), actor: "mallory", waitId: r.id, expectedRevision: 1, resolverId: "mallory", answer: "yes" }), (e) => assert.match(e.message, /for owner, not mallory/));
    const answered = await waits.answerWait({ commandId: cid("a"), actor: "rob", waitId: r.id, expectedRevision: 1, resolverId: "owner", answer: "yes, delete them" });
    assert.equal(answered.revision, 2);
    const wait = (await waits.getWait(r.id))!;
    assert.deepEqual([wait.state, wait.answer, wait.answeredBy, wait.outcome], ["answered", "yes, delete them", "rob", "resumed"]);
    assert.equal((await projects.getTask(taskId))!.state, "ready");
    assert.equal((await world.storage.getTimer(`wt:${r.id}`))?.state, "cancelled");
    assert.equal(await waits.openFor(taskId), undefined);
    await refuses("wait_closed", () => waits.answerWait({ commandId: cid("a2"), actor: "rob", waitId: r.id, expectedRevision: 2, resolverId: "owner", answer: "again" }));
    // The task may wait again.
    clock.now += 1000;
    await waits.openWait(timed(taskId, clock, "resume"));
    assert.equal((await projects.getTask(taskId))!.state, "blocked");
  });

  suite("a passed deadline is settled with its stated outcome: resume, cancel, or escalate to a visible blocker", async ({ projects, waits, blockers, clock, reconciler }) => {
    const resume = await readyTask(projects, "resume");
    const cancel = await readyTask(projects, "cancel");
    const escalate = await readyTask(projects, "escalate");
    const ids = {
      resume: (await waits.openWait(timed(resume, clock, "resume"))).id,
      cancel: (await waits.openWait(timed(cancel, clock, "cancel"))).id,
      escalate: (await waits.openWait(timed(escalate, clock, "escalate", { resolver: "rob" }))).id,
    };
    assert.deepEqual(await waits.settleDue(), { timedOut: 0, resumed: 0, cancelled: 0, escalated: 0, alreadyClosed: 0 }, "nothing is due yet");
    clock.now += 61_000;
    const report = await reconciler().runPass();
    assert.equal(report.waitsTimedOut, 3);
    assert.deepEqual([(await projects.getTask(resume))!.state, (await projects.getTask(cancel))!.state, (await projects.getTask(escalate))!.state], ["ready", "cancelled", "blocked"]);
    assert.deepEqual([(await waits.getWait(ids.resume))!.outcome, (await waits.getWait(ids.cancel))!.outcome, (await waits.getWait(ids.escalate))!.outcome], ["timed_out_resumed", "timed_out_cancelled", "timed_out_escalated"]);
    // The escalated wait is a visible blocker naming who it waits for; passes do not open it again.
    const blocker = (await blockers.openFor("wait_overdue", { kind: "task", id: escalate }))!;
    assert.deepEqual([blocker.resolver, blocker.state], ["rob", "open"]);
    assert.match(blocker.summary, /deadline .* passed/);
    assert.match(blocker.summary, /delete the beds and continue/);
    assert.equal(report.blockersOpened, 1);
    const again = await reconciler().runPass();
    assert.deepEqual([again.waitsTimedOut, again.blockersOpened, again.unexplainedBlocks], [0, 0, 0]);
    // A late answer to a wait that timed out is refused and changes nothing.
    for (const id of [ids.resume, ids.cancel, ids.escalate]) await refuses("wait_closed", () => waits.answerWait({ commandId: cid("late"), actor: "rob", waitId: id, expectedRevision: 2, resolverId: id === ids.escalate ? "rob" : "owner", answer: "too late" }));
    assert.deepEqual([(await projects.getTask(resume))!.state, (await projects.getTask(cancel))!.state, (await projects.getTask(escalate))!.state], ["ready", "cancelled", "blocked"]);
  });

  suite("a late answer cannot revive a cancelled operation", async ({ projects, waits, clock, reconciler }) => {
    // 1. The wait is cancelled together with its task.
    const a = await readyTask(projects, "a");
    const wa = await waits.openWait(timed(a, clock, "resume"));
    await waits.cancelWait({ commandId: cid("c"), actor: "rob", waitId: wa.id, expectedRevision: 1, reason: "plans changed", task: "cancel" });
    assert.deepEqual([(await waits.getWait(wa.id))!.state, (await projects.getTask(a))!.state], ["cancelled", "cancelled"]);
    await refuses("wait_closed", () => waits.answerWait({ commandId: cid("late"), actor: "rob", waitId: wa.id, expectedRevision: 2, resolverId: "owner", answer: "yes after all" }));
    assert.equal((await projects.getTask(a))!.state, "cancelled", "still cancelled");
    // 2. The task is cancelled directly while its wait is open; the answer is refused and the next pass closes the wait.
    const b = await readyTask(projects, "b");
    const wb = await waits.openWait(timed(b, clock, "resume"));
    await projects.transitionTask({ commandId: cid("cancel"), actor: "rob", taskId: b, expectedRevision: 3, to: "cancelled" });
    await refuses("wait_closed", () => waits.answerWait({ commandId: cid("late2"), actor: "rob", waitId: wb.id, expectedRevision: 1, resolverId: "owner", answer: "yes" }), (e) => assert.match(e.message, /not waiting/));
    assert.equal((await projects.getTask(b))!.state, "cancelled");
    const report = await reconciler().runPass();
    assert.equal(report.waitsOrphaned, 1);
    assert.equal((await waits.getWait(wb.id))!.state, "cancelled");
    assert.equal((await projects.getTask(b))!.state, "cancelled");
    // 3. A wait cancelled with the task resumed puts the task back.
    const c = await readyTask(projects, "c");
    const wc = await waits.openWait(timed(c, clock, "resume"));
    await waits.cancelWait({ commandId: cid("c2"), actor: "rob", waitId: wc.id, expectedRevision: 1, reason: "no longer needed", task: "resume" });
    assert.equal((await projects.getTask(c))!.state, "ready");
  });

  suite("a wait whose task was released some other way is closed by the next pass, and the task can wait again", async ({ projects, waits, clock, reconciler }) => {
    const taskId = await readyTask(projects);
    const w = await waits.openWait(timed(taskId, clock, "resume"));
    const indefiniteTask = await readyTask(projects, "indefinite");
    const { deadline: _d, onDeadline: _o, ...rest } = timed(indefiniteTask, clock, "resume");
    const w2 = await waits.openWait({ ...rest, indefinite: { owner: "rob" } });
    // The controller's own path releases both tasks without answering.
    await projects.transitionTask({ commandId: cid("free"), actor: me, taskId, expectedRevision: 3, to: "ready" });
    await projects.transitionTask({ commandId: cid("free2"), actor: me, taskId: indefiniteTask, expectedRevision: 3, to: "in_progress" });
    await refuses("wait_closed", () => waits.answerWait({ commandId: cid("a"), actor: "rob", waitId: w.id, expectedRevision: 1, resolverId: "owner", answer: "yes" }));
    const report = await reconciler().runPass();
    assert.equal(report.waitsOrphaned, 2);
    assert.deepEqual([(await waits.getWait(w.id))!.state, (await waits.getWait(w2.id))!.state], ["cancelled", "cancelled"]);
    assert.deepEqual([(await projects.getTask(taskId))!.state, (await projects.getTask(indefiniteTask))!.state], ["ready", "in_progress"], "the tasks were left as the controller put them");
    assert.equal((await waits.openWait(timed(taskId, clock, "cancel"))).revision, 1, "the task can wait again");
    assert.equal((await reconciler().runPass()).waitsOrphaned, 0);
  });

  suite("a task left blocked by an escalated deadline gets one overdue blocker and is never also flagged as unexplained, whatever order the scans run in", async ({ projects, waits, blockers, clock, reconciler }) => {
    const taskId = await readyTask(projects);
    await waits.openWait(timed(taskId, clock, "escalate", { resolver: "rob" }));
    clock.now += 61_000;
    await waits.settleDue(); // the deadline passed, but the wait scan has not run
    const report = await reconciler().runPass();
    assert.equal(report.unexplainedBlocks, 0);
    assert.ok(await blockers.openFor("wait_overdue", { kind: "task", id: taskId }));
    assert.equal(await blockers.openFor("unexplained_block", { kind: "task", id: taskId }), undefined);
  });

  suite("an answer and a deadline racing yield exactly one outcome", async ({ projects, waits, clock }) => {
    for (let i = 0; i < 6; i++) {
      const taskId = await readyTask(projects, `race ${i}`);
      const w = await waits.openWait(timed(taskId, clock, "cancel"));
      clock.now += 61_000;
      const [answer, due] = await Promise.allSettled([
        waits.answerWait({ commandId: cid("a"), actor: "rob", waitId: w.id, expectedRevision: 1, resolverId: "owner", answer: "yes" }),
        waits.settleDue(),
      ]);
      void due;
      const wait = (await waits.getWait(w.id))!;
      const task = (await projects.getTask(taskId))!;
      if (answer.status === "fulfilled") {
        assert.deepEqual([wait.state, task.state], ["answered", "ready"], "the answer won");
      } else {
        assert.ok(answer.reason instanceof DomainError && ["stale_revision", "wait_closed"].includes(answer.reason.code), String(answer.reason));
        assert.deepEqual([wait.state, task.state], ["timed_out", "cancelled"], "the deadline won");
      }
      await waits.settleDue(); // the other side, if it has not run, changes nothing
      assert.deepEqual([(await waits.getWait(w.id))!.state, (await projects.getTask(taskId))!.state], [wait.state, task.state]);
    }
  });

  suite("no blocked task is left without an explanation: a wait, a hold or a flagged blocker", async ({ projects, waits, blockers, clock, reconciler }) => {
    const waiting = await readyTask(projects, "waiting");
    await waits.openWait(timed(waiting, clock, "resume"));
    const held = await readyTask(projects, "held");
    await projects.transitionTask({ commandId: cid("b"), actor: me, taskId: held, expectedRevision: 2, to: "blocked" });
    await blockers.openBlocker({ commandId: cid("hold"), actor: me, type: "manual_hold", subject: { kind: "task", id: held }, summary: "waiting for the supplier", resolver: "rob" });
    const unexplained = await readyTask(projects, "mystery");
    await projects.transitionTask({ commandId: cid("b2"), actor: me, taskId: unexplained, expectedRevision: 2, to: "blocked" });
    const report = await reconciler().runPass();
    assert.equal(report.unexplainedBlocks, 1, "only the task nothing explains is flagged");
    const flag = (await blockers.openFor("unexplained_block", { kind: "task", id: unexplained }))!;
    assert.match(flag.summary, /no wait .* and no blocker/);
    assert.equal(await blockers.openFor("unexplained_block", { kind: "task", id: waiting }), undefined);
    assert.equal(await blockers.openFor("unexplained_block", { kind: "task", id: held }), undefined);
    assert.equal((await reconciler().runPass()).unexplainedBlocks, 0, "flagged once");
    // Giving it a wait explains it; resolving the flag is a person's act.
    await projects.transitionTask({ commandId: cid("r"), actor: me, taskId: unexplained, expectedRevision: 3, to: "ready" });
    await blockers.resolveBlocker({ commandId: cid("res"), actor: "rob", blockerId: flag.id, expectedRevision: flag.revision, resolution: "released" });
    assert.equal((await reconciler().runPass()).unexplainedBlocks, 0);
  });

  suite("a deposed controller cannot open, answer or settle waits", async ({ projects, waits, world, clock }) => {
    const taskId = await readyTask(projects);
    const w = await waits.openWait(timed(taskId, clock, "resume"));
    const other = await readyTask(projects, "other");
    await world.storage.acquireEpoch({ holder: "c2", at: iso(clock.now) });
    await refuses("stale_epoch", () => waits.answerWait({ commandId: cid("a"), actor: "rob", waitId: w.id, expectedRevision: 1, resolverId: "owner", answer: "yes" }));
    await refuses("stale_epoch", () => waits.openWait(timed(other, clock, "resume")));
    clock.now += 61_000;
    await refuses("stale_epoch", () => waits.settleDue());
  });
}
