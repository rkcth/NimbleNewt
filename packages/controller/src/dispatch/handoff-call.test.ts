import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ContextEnforcementService, DeskService, HistoryService, RetrievalService } from "../context/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld, workGrants } from "./testing/world.js";

/**
 * Card C07m: what the next agent is given when it is handed a task. Its first call carries the task's own text, the rules and the route view — and now, in bounded lines, the hand-off the task came to it with,
 * the hand-off note the attempt before it left, and the blockers that hold the task up, each named by the record and the operation its agent reads it with. Nothing is copied out of the package (that is what
 * grows from hop to hop), and nothing the controller knows of the hand-off is kept from the agent that inherits it.
 */
after(stopServer);

const HANDOFF = "hnd-bbbbbbbbbbbbbbbbbbbb";
const BLOCKER = "the fixture server is down until the owner restarts it";

for (const backend of backends) {
  test(`${backend.name}: the first call of the agent a task was handed to names the hand-off, the previous attempt's hand-off note and the open blockers; a call with none of that says nothing`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      const options = { clock: w.clock.now, pause: async () => undefined };
      const histories = HistoryService.withEpoch(store.storage, w.epoch, options);
      const desks = DeskService.withEpoch(store.storage, w.epoch, options);
      const retrieval = RetrievalService.withEpoch(store.storage, w.epoch, desks, histories, options);
      const context = ContextEnforcementService.withEpoch(store.storage, w.epoch, { blockers: w.blockers, retrieval }, options);
      // The controller's hand-off records, as `api/dispatch-compose.ts` hands them: the task came to bob by one hand-off, from ann.
      const handedIn = async () => ({ id: HANDOFF, phase: "transferred" as const, to: { kind: "agent", id: "bob" } });
      const d = w.restart({ context, handedIn });

      const ann = await w.agent("ann", workGrants(w.project));
      const bob = await w.agent("bob", workGrants(w.project));
      const { taskId, attemptId: firstAttempt } = await w.task("Ship the importer", ann);
      await d.tick();
      await d.idle();
      const firstOrder = w.worker.starts.at(-1)!;
      assert.equal(firstOrder.agentId, "agent:ann");
      // Ann's own first call: no hand-off to her, no earlier attempt, nothing holding the task up — so it carries no hand-off paragraph at all.
      assert.doesNotMatch(firstOrder.content, /What the controller hands you/, `ann's call says something it was not handed: ${firstOrder.content}`);

      // The task moves to bob, and something holds it up before bob's attempt starts.
      await w.blockers.openBlocker({ commandId: "c07m-blk", actor: w.owner.id, type: "wait_overdue", subject: { kind: "task", id: taskId }, summary: BLOCKER, resolver: "owner" });
      const asg = (await w.assignments.getAssignment(taskId))!;
      await w.assignments.transferTask({ commandId: "c07m-as", actor: w.owner.id, taskId, expectedRevision: asg.revision, to: { kind: "agent", id: bob.aid }, reason: "ann is on leave" });
      const next = (await w.assignments.getAssignment(taskId))!;
      const secondAttempt = (await w.assignments.admitAttempt({ commandId: "c07m-ad", actor: "inbox", taskId, expectedRevision: next.revision, generation: next.generation, owner: { kind: "agent", id: bob.aid }, harness: "pi" })).id;
      await d.tick();
      await d.idle();

      const order = w.worker.starts.at(-1)!;
      assert.equal(order.attemptId, secondAttempt, "bob's attempt started");
      assert.equal(order.agentId, "agent:bob");
      const content = order.content;
      // The hand-off the task came with, and the operation its package is read with.
      assert.match(content, new RegExp(`Handed to you by hand-off ${HANDOFF}`));
      assert.match(content, /handoff\.get/);
      // The hand-off note the attempt before this one left, named by its own ID and the attempt it belongs to.
      const note = /hand-off note (hof-[a-z2-7]{20}), written by the controller when that attempt ended/.exec(content);
      assert.ok(note !== null, `the controller's hand-off note of the ended attempt is not named:\n${content}`);
      assert.ok(content.includes(firstAttempt!) && content.includes("context.handoff.read"), "the note says whose it is and how it is read");
      assert.notEqual(note![1], secondAttempt, "a note is never named as its own attempt's");
      // The task's open blocker, with the words it was opened in and who can clear it.
      const blocker = await w.blockers.openFor("wait_overdue", { kind: "task", id: taskId });
      assert.ok(blocker !== undefined);
      assert.ok(content.includes(blocker.id), "the open blocker is not named by its ID");
      assert.ok(content.includes(`"${BLOCKER}"`), "the open blocker is not named by its words");
      assert.doesNotMatch(content, /status\.ask/, "the agent is not pointed at an operation its task credential is refused");
      // And it is the controller's paragraph, not something an agent could pass off as one: the task's own text and rules come first.
      assert.match(content, /^Ship the importer\n\nRules that bind you in this project/);
      assert.ok(content.indexOf("What the controller hands you") > content.indexOf("Rules that bind you"), "what the agent was handed is said after the rules that bind it");
    } finally { await store.close(); }
  });

  test(`${backend.name}: a hand-off made to another agent is not named to this one, and a note of this very attempt is not given as the previous one`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      const options = { clock: w.clock.now, pause: async () => undefined };
      const histories = HistoryService.withEpoch(store.storage, w.epoch, options);
      const desks = DeskService.withEpoch(store.storage, w.epoch, options);
      const retrieval = RetrievalService.withEpoch(store.storage, w.epoch, desks, histories, options);
      const context = ContextEnforcementService.withEpoch(store.storage, w.epoch, { blockers: w.blockers, retrieval }, options);
      // The hand-off went to someone else (the assignment moved on since), and the task's latest note is of this very attempt.
      const d = w.restart({
        context,
        handedIn: async () => ({ id: HANDOFF, phase: "transferred" as const, to: { kind: "agent", id: "someone-else" } }),
      });
      const ann = await w.agent("ann", workGrants(w.project));
      const { taskId, attemptId } = await w.task("Ship the importer", ann);
      // A note for this attempt is on record before it starts (an earlier life of the same attempt, or a writer that got there first).
      await context.recordHandoff(w.owner, { taskId, attemptId: attemptId!, text: "what this attempt left" });
      await d.tick();
      await d.idle();
      const content = w.worker.starts.at(-1)!.content;
      assert.doesNotMatch(content, new RegExp(HANDOFF), "a package this agent may not read is not named to them");
      assert.doesNotMatch(content, /hand-off note|handoff note/, `this attempt's own note is given to it as a hand-off from before:\n${content}`);
    } finally { await store.close(); }
  });

  test(`${backend.name}: a read of what the attempt was handed that fails never keeps it from starting, leaves out only its own line, and is reported (C07m review)`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      const errors: string[] = [];
      const boom = (what: string) => async (): Promise<never> => { throw new Error(`${what} unreadable`); };
      // The hand-off records, the note and one blocker type fail; another blocker type still reads.
      const blockers = { openBlocker: w.blockers.openBlocker.bind(w.blockers), openFor: async (type: Parameters<typeof w.blockers.openFor>[0], subject: Parameters<typeof w.blockers.openFor>[1]) => (type === "manual_hold" ? await boom("manual_hold")() : await w.blockers.openFor(type, subject)) };
      const context = { ensureHandoff: async () => ({ id: "hof-x", source: "controller" as const, text: "" }), reportOverflow: async () => undefined as never, resetOverflow: async () => undefined as never, latestHandoffFor: boom("note") };
      const d = w.restart({ context: context as never, blockers: blockers as never, handedIn: boom("hand-off") }, { onError: (e) => { errors.push(String((e as Error).message)); } });
      const ann = await w.agent("ann", workGrants(w.project));
      const { taskId, attemptId } = await w.task("Ship the importer", ann);
      await w.blockers.openBlocker({ commandId: "c07m-fail-blk", actor: w.owner.id, type: "wait_overdue", subject: { kind: "task", id: taskId }, summary: BLOCKER, resolver: "owner" });
      await d.tick();
      await d.idle();
      const order = w.worker.starts.at(-1);
      assert.equal(order?.attemptId, attemptId, "the attempt started although three reads failed");
      assert.ok(order!.content.includes(`"${BLOCKER}"`), "the blocker that could be read is still named");
      assert.doesNotMatch(order!.content, /Handed to you by|hand-off note/);
      for (const what of ["hand-off unreadable", "note unreadable", "manual_hold unreadable"]) assert.ok(errors.includes(what), `a failed read is not reported: ${what} (${JSON.stringify(errors)})`);
    } finally { await store.close(); }
  });
}
