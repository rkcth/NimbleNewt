import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ContextEnforcementService, DeskService, HistoryService, RetrievalService } from "../context/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld, workGrants } from "./testing/world.js";

// W01 acceptance for card C07m: the dispatcher's first call names what the attempt was handed (the `handedIn` dependency and
// `context.latestHandoffFor`, as the CONTRACT names them), on every backend.
after(stopServer);

const HANDOFF = "hnd-bbbbbbbbbbbbbbbbbbbb";
const BLOCKER = "the fixture server is down until the owner restarts it";
const FRAME = "\n\n[What the controller hands you";
const RULES = "Rules that bind you in this project";

for (const backend of backends) {
  const contextOf = (store: { storage: Parameters<typeof HistoryService.withEpoch>[0] }, w: Awaited<ReturnType<typeof buildWorld>>) => {
    const options = { clock: w.clock.now, pause: async () => undefined };
    const histories = HistoryService.withEpoch(store.storage, w.epoch, options);
    const desks = DeskService.withEpoch(store.storage, w.epoch, options);
    const retrieval = RetrievalService.withEpoch(store.storage, w.epoch, desks, histories, options);
    return ContextEnforcementService.withEpoch(store.storage, w.epoch, { blockers: w.blockers, retrieval }, options);
  };

  test(`${backend.name}: the first call of the agent a task was handed to names the hand-off, the previous attempt's note and the open blockers; a call with none of that has no paragraph`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      const context = contextOf(store, w);
      const handedIn = async () => ({ id: HANDOFF, phase: "transferred" as const, to: { kind: "agent", id: "bob" } });
      const d = w.restart({ context, handedIn });

      const ann = await w.agent("ann", workGrants(w.project));
      const bob = await w.agent("bob", workGrants(w.project));
      const { taskId, attemptId: firstAttempt } = await w.task("Ship the importer", ann);
      await d.tick();
      await d.idle();
      const firstOrder = w.worker.starts.at(-1)!;
      assert.equal(firstOrder.agentId, "agent:ann");
      assert.ok(!firstOrder.content.includes(FRAME), `ann's first call carries a hand-off paragraph: ${firstOrder.content}`);
      assert.ok(!firstOrder.content.includes(HANDOFF), "a hand-off to someone else is not named");

      await w.blockers.openBlocker({ commandId: "c07m-blk", actor: w.owner.id, type: "wait_overdue", subject: { kind: "task", id: taskId }, summary: BLOCKER, resolver: "owner" });
      const asg = (await w.assignments.getAssignment(taskId))!;
      await w.assignments.transferTask({ commandId: "c07m-as", actor: w.owner.id, taskId, expectedRevision: asg.revision, to: { kind: "agent", id: bob.aid }, reason: "ann is on leave" });
      const next = (await w.assignments.getAssignment(taskId))!;
      const secondAttempt = (await w.assignments.admitAttempt({ commandId: "c07m-ad", actor: "inbox", taskId, expectedRevision: next.revision, generation: next.generation, owner: { kind: "agent", id: bob.aid }, harness: "pi" })).id;
      await d.tick();
      await d.idle();

      const order = w.worker.starts.at(-1)!;
      assert.equal(order.attemptId, secondAttempt, "bob's attempt started");
      const content = order.content;
      const at = content.indexOf(FRAME);
      assert.ok(at > 0, `the call carries the hand-off paragraph: ${content}`);
      assert.ok(content.startsWith("Ship the importer") && content.includes(RULES), "the task's text and the rules come first");
      assert.ok(at > content.indexOf(RULES), "the paragraph follows the rules");
      const brief = content.slice(at);
      assert.ok(brief.includes(HANDOFF) && brief.includes("handoff.get"), "the hand-off is named with the operation that reads it");
      const note = /hof-[a-z2-7]{20}/.exec(brief);
      assert.ok(note !== null, `the previous attempt's note is not named:\n${brief}`);
      assert.ok(brief.includes(firstAttempt!) && brief.includes("context.handoff.read"), "the note names its attempt and the operation that reads it");
      const named = await context.readHandoff(w.owner, note![0]);
      assert.equal(named?.attemptId, firstAttempt, "the note named is the one the previous attempt left");
      const blocker = await w.blockers.openFor("wait_overdue", { kind: "task", id: taskId });
      assert.ok(blocker !== undefined && brief.includes(blocker.id), "the open blocker is named by its ID");
      assert.ok(brief.includes(`"${BLOCKER}"`), "the open blocker is quoted in its own words");
      assert.ok(brief.includes("wait_overdue"), "the blocker's type is given");
      assert.doesNotMatch(brief, /status\.ask/);
    } finally { await store.close(); }
  });

  test(`${backend.name}: a hand-off made to another agent is not named, and a note of this very attempt is not given as the previous one`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      const context = contextOf(store, w);
      const d = w.restart({ context, handedIn: async () => ({ id: HANDOFF, phase: "transferred" as const, to: { kind: "agent", id: "someone-else" } }) });
      const ann = await w.agent("ann", workGrants(w.project));
      const { taskId, attemptId } = await w.task("Ship the importer", ann);
      const own = await context.recordHandoff(w.owner, { taskId, attemptId: attemptId!, text: "what this attempt left" });
      await d.tick();
      await d.idle();
      const content = w.worker.starts.at(-1)!.content;
      assert.equal(w.worker.starts.at(-1)!.attemptId, attemptId);
      assert.ok(!content.includes(HANDOFF), "a package this agent was not handed is not named");
      assert.ok(!content.includes(own.id) && !content.includes("context.handoff.read"), `this attempt's own note is given as a hand-off from before:\n${content}`);
    } finally { await store.close(); }
  });

  test(`${backend.name}: a hand-off that has not moved the task is not named`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      const d = w.restart({ context: contextOf(store, w), handedIn: async () => ({ id: HANDOFF, phase: "ready" as const, to: { kind: "agent", id: "ann" } }) });
      const ann = await w.agent("ann", workGrants(w.project));
      await w.task("Ship the importer", ann);
      await d.tick();
      await d.idle();
      assert.ok(!w.worker.starts.at(-1)!.content.includes(HANDOFF), "a hand-off still being prepared is not named");
    } finally { await store.close(); }
  });

  test(`${backend.name}: a read that fails never keeps the attempt from starting, leaves out only its own part, and is reported`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      const errors: string[] = [];
      const boom = (what: string) => async (): Promise<never> => { throw new Error(`${what} unreadable`); };
      const real = contextOf(store, w);
      const context = { ensureHandoff: real.ensureHandoff.bind(real), reportOverflow: real.reportOverflow.bind(real), resetOverflow: real.resetOverflow.bind(real), latestHandoffFor: boom("note") };
      const d = w.restart({ context: context as never, handedIn: boom("hand-off") }, { onError: (e) => { errors.push(String((e as Error)?.message ?? e)); } });
      const ann = await w.agent("ann", workGrants(w.project));
      const { taskId, attemptId } = await w.task("Ship the importer", ann);
      await w.blockers.openBlocker({ commandId: "c07m-fail-blk", actor: w.owner.id, type: "wait_overdue", subject: { kind: "task", id: taskId }, summary: BLOCKER, resolver: "owner" });
      await d.tick();
      await d.idle();
      const order = w.worker.starts.at(-1);
      assert.equal(order?.attemptId, attemptId, "the attempt started although two reads failed");
      assert.ok(order!.content.includes(`"${BLOCKER}"`), "the blocker that could be read is still named");
      assert.ok(!order!.content.includes(HANDOFF) && !/hof-[a-z2-7]{20}/.test(order!.content), "nothing is guessed for the reads that failed");
      for (const what of ["hand-off unreadable", "note unreadable"]) assert.ok(errors.includes(what), `a failed read is not reported: ${what} (${JSON.stringify(errors)})`);
    } finally { await store.close(); }
  });
}
