import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { StatusService } from "../status/index.js";
import { buildWorld, workGrants, type DispatchWorld } from "./testing/world.js";
import type { WorkerTurnResult } from "./ports.js";
import { TASK_ATTEMPTS_KIND } from "./model.js";

after(stopServer);

// Card W08 on every storage backend: the dispatcher names each attempt it claims in the task's attempt record and records how far the plan got when each turn ended; the owner's `attempt_endings` view, read from those records,
// shows each attempt's end kind in plain words, its nudges, its plan progress and the agent_stopped_early blocker with the agent's last text. Who may not read the task's assignment gets nothing.

async function runOnce(w: DispatchWorld): Promise<void> {
  await w.heartbeatHost();
  await w.dispatcher.tick();
  await w.dispatcher.idle();
}

for (const backend of backends) {
  test(`${backend.name}: each attempt's ending, nudges, plan progress and blocker are recorded and shown to the owner, newest first; another agent cannot read them (card W08)`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      const ann = await w.agent("ann", workGrants(w.project, []));
      const kinds = ["length", "announced-step-without-tool-call", "no-work-end"] as const;
      let n = 0;
      w.worker.script = async (): Promise<WorkerTurnResult> => { const k = kinds[n++ % 3]!; return { status: "completed", text: `Next I will fix the parser (turn ${n}).`, endKind: k, visibleChars: 30, nudges: 2, checkpoint: { turn: n } }; };
      let checked = 0;
      w.worker.progress = async () => ({ plan: { done: ["read the code", "write a test"].slice(0, Math.min(2, ++checked - 1)), open: ["fix the parser", "run the tests"] }, diffStat: "1 file changed, 3 insertions(+)" });
      const { taskId, attemptId } = await w.task("Fix the parser", ann);
      for (let i = 0; i < 3; i++) await runOnce(w);
      const d = (await w.dispatcher.get(w.owner, attemptId!))!;
      assert.equal(d.outcome?.status, "stopped-early");
      // The dispatcher's records: the attempt named in its task's record at its claim, and each run with how far the plan got.
      const index = (await store.storage.getAggregate({ kind: TASK_ATTEMPTS_KIND, id: taskId }))?.body as { attempts?: string[] } | undefined;
      assert.deepEqual(index?.attempts, [attemptId]);
      assert.deepEqual(d.stoppedEarly?.map((r) => r.plan), [{ done: 0, total: 2 }, { done: 1, total: 3 }, { done: 2, total: 4 }]);

      const status = StatusService.withEpoch(w.storage, w.epoch, { assignments: w.assignments, waits: w.waits, blockers: w.blockers, contracts: w.contracts }, { clock: w.clock.now });
      const view = await status.ask(w.owner, { kind: "attempt_endings", taskId });
      assert.ok(view);
      const lines = view.lines.map((l) => l.text);
      assert.equal(lines[0], "1 attempt(s) of Fix the parser on record, newest first.");
      assert.match(lines[1]!, new RegExp(`^Attempt 1 \\(${attemptId}\\), agent ann on route [^ ]+ as [^:]+: started [^;]+; it ended stopped early: the agent kept stopping before it said its work was done at `));
      assert.match(lines[2]!, /Its last turn: it ended with prose and no work\.end \(30 visible characters\)/);
      assert.match(lines[2]!, /Nudges to go on: 6 \(2 in its last turn\)\./);
      assert.match(lines[2]!, /Plan: 2 of 4 step\(s\) checked\./);
      assert.match(lines[2]!, /3 time\(s\) \(the model ran out of length; it announced a step but made no call; it ended with prose and no work\.end\)/);
      assert.match(lines[2]!, /It left a blocker, agent_stopped_early/);
      const blocker = lines.find((l) => l.startsWith("Open blocker agent_stopped_early since "));
      assert.ok(blocker, lines.join("\n"));
      assert.match(blocker, /Last visible text \(quoted\): "Next I will fix the parser \(turn 3\)\."/, "the agent's last text, quoted once");
      assert.match(blocker, /Plan: 2 of 4 step\(s\) checked/);
      assert.ok(view.lines.every((l) => l.cites.length > 0), "every line cites its records");

      // A second attempt of the same task (the owner assigned it again): the newest is shown first and numbered after the first.
      const a = (await w.assignments.getAssignment(taskId))!;
      const again = await w.assignments.admitAttempt({ commandId: "ad-again", actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: ann.aid }, harness: "pi" });
      w.worker.script = async (): Promise<WorkerTurnResult> => ({ status: "completed", text: "Ended.", endKind: "normal", visibleChars: 6, checkpoint: { turn: 99 } });
      await runOnce(w);
      const later = (await status.ask(w.owner, { kind: "attempt_endings", taskId }))!.lines.map((l) => l.text);
      assert.equal(later[0], "2 attempt(s) of Fix the parser on record, newest first.");
      assert.match(later[1]!, new RegExp(`^Attempt 2 \\(${again.id}\\)`));
      assert.match(later[2]!, /Its last turn: it ended normally/);
      assert.match(later[2]!, /Plan: 2 of 4 step\(s\) checked\./, "a turn that ended normally records how far the plan got too");
      assert.match(later[3]!, new RegExp(`^Attempt 1 \\(${attemptId}\\)`));

      // Read as the work report is: an agent that may read the task but not who works on it gets nothing.
      await w.agent("bob", [{ action: "task.read", project: w.project }]);
      const bob = await w.principals.authenticate((await w.principals.issueCredential(w.owner, "agent:bob")).token);
      assert.equal(await status.ask(bob, { kind: "attempt_endings", taskId }), undefined);
      // The assigned agent may.
      const annP = await w.principals.authenticate((await w.principals.issueCredential(w.owner, "agent:ann")).token);
      assert.ok(await status.ask(annP, { kind: "attempt_endings", taskId }));
      // A task with no attempt says so.
      const idle = (await w.task("Plant seeds", ann, { admit: false })).taskId;
      assert.deepEqual((await status.ask(w.owner, { kind: "attempt_endings", taskId: idle }))!.lines.map((l) => l.text), ["No attempt of Plant seeds is on record yet."]);
      assert.equal(await status.ask(w.owner, { kind: "attempt_endings", taskId: "task-zzzzzzzzzzzzzzzzzzzz" }), undefined);
    } finally { await store.close(); }
  });
}

test("an owner's stop that comes while the host is asked for the plan after a turn still records how that turn ended (card W08)", async () => {
  const store = await backends[0]!.open();
  try {
    const w = await buildWorld(store.storage);
    const ann = await w.agent("ann", workGrants(w.project, []));
    w.worker.script = async (): Promise<WorkerTurnResult> => ({ status: "completed", text: "Next I will fix it.", endKind: "no-work-end", visibleChars: 19, nudges: 1, checkpoint: { turn: 1 } });
    let asked!: () => void;
    const askedP = new Promise<void>((r) => { asked = r; });
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    w.worker.progress = async () => { asked(); await held; return { plan: { done: ["a"], open: ["b"] } }; };
    const { attemptId } = await w.task("Fix the parser", ann);
    await w.heartbeatHost();
    await w.dispatcher.tick();
    await askedP;
    const stopping = w.dispatcher.stop(w.owner, attemptId!, { emergency: true, reason: "owner stop" });
    await stopping.catch(() => undefined);
    release();
    await w.dispatcher.idle();
    const d = (await w.dispatcher.get(w.owner, attemptId!))!;
    assert.equal(d.state, "finished");
    assert.equal(d.turnEnd?.endKind, "no-work-end", "the turn that ended before the stop is on the record");
  } finally { await store.close(); }
});

test("a turn whose attempt was moved to another host while the host was asked for the plan changes nothing: the moved attempt is not ended by the old turn's result (card W08, second review)", async () => {
  const store = await backends[0]!.open();
  try {
    const w = await buildWorld(store.storage);
    const ann = await w.agent("ann", workGrants(w.project, []));
    w.worker.script = async (): Promise<WorkerTurnResult> => ({ status: "completed", text: "Done.", endKind: "normal", visibleChars: 5, checkpoint: { turn: 1 } });
    let asked!: () => void;
    const askedP = new Promise<void>((r) => { asked = r; });
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    w.worker.progress = async () => { asked(); await held; return { plan: { done: ["a"], open: [] } }; };
    const { attemptId } = await w.task("Fix the parser", ann);
    await w.heartbeatHost();
    await w.dispatcher.tick();
    await askedP;
    await w.dispatcher.relocate(w.owner, attemptId!, { hostId: "host:elsewhere", checkpoint: { turn: 1 }, note: "moved while the plan was asked" });
    release();
    // The moved attempt's old turn is no longer in the live list, so idle() does not wait for it: give its result time to come back.
    for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 25)); await w.dispatcher.idle(); }
    const d = (await w.dispatcher.get(w.owner, attemptId!))!;
    assert.equal(d.state, "waiting", "the moved attempt waits for its new host; the old turn's result did not end it");
    assert.equal(d.pinnedHost, "host:elsewhere");
    assert.equal(d.outcome, undefined);
  } finally { await store.close(); }
});
