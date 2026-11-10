import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld, workGrants, type DispatchWorld } from "./testing/world.js";
import type { TurnEndKind, WorkerTurnResult } from "./ports.js";
import { STOPPED_EARLY_KIND } from "./model.js";

after(stopServer);

// Card W03: a natural stop is not success. A completed turn that did not end normally (no work.end, a reply cut off, nothing visible, a step announced and not taken, or a kind nobody said) ends the run `stopped-early`; the
// attempt goes on from the turn's checkpoint in the same conversation on the same host, at most twice per task, and then the task carries an `agent_stopped_early` blocker with what the agent last said, its plan and its diff.

const stopper = (endKind: TurnEndKind | undefined, text = "I will now run the tests.") => {
  let n = 0;
  return async (): Promise<WorkerTurnResult> => ({ status: "completed", text: text === "" ? (++n, "") : `${text} (turn ${++n})`, ...(endKind === undefined ? {} : { endKind, visibleChars: text.length }), checkpoint: { turn: n } });
};

async function runOnce(w: DispatchWorld): Promise<void> {
  await w.heartbeatHost();
  await w.dispatcher.tick();
  await w.dispatcher.idle();
}

const blockerOf = async (w: DispatchWorld, taskId: string) => w.blockers.openFor("agent_stopped_early", { kind: "task", id: taskId });

for (const backend of backends) {
  test(`${backend.name}: an agent that stops without work.end is never succeeded, goes on twice from its checkpoint on the same host and conversation, then the task gets a blocker with its last text, plan and diff`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      const ann = await w.agent("ann", workGrants(w.project, []));
      w.worker.script = stopper("no-work-end", "Next I will update the parser.‮ and \"quote\"");
      const progressAsked: string[] = [];
      w.worker.progress = async (attemptId, scope) => { progressAsked.push(`${attemptId}:${scope.taskId}`); return { plan: { done: ["read the code"], open: ["fix the parser", "run the tests"] }, diffStat: "2 files changed, 10 insertions(+), 1 deletion(-); 1 commit ahead of the base" }; };
      const { taskId, attemptId } = await w.task("parser", ann);

      await runOnce(w);
      let d = (await w.dispatcher.get(w.owner, attemptId!))!;
      assert.notEqual(d.outcome?.status, "succeeded");
      assert.equal(d.state, "waiting", "the attempt goes on: the same attempt, waiting for its place again");
      assert.equal(d.pinnedHost, "host:w1", "pinned to the host that holds its conversation");
      assert.deepEqual(d.resumeFrom, { turn: 1 }, "from the turn's own checkpoint");
      assert.match(d.resumeNote ?? "", /work\.end/);
      assert.equal(d.turnRound, 1);
      assert.deepEqual(d.stoppedEarly?.map((r) => [r.endKind, r.readmitted]), [["no-work-end", true]]);
      assert.equal(d.turnEnd?.endKind, "no-work-end");

      await runOnce(w);
      d = (await w.dispatcher.get(w.owner, attemptId!))!;
      assert.equal(d.state, "waiting");
      assert.equal(d.turnRound, 2);
      assert.deepEqual(d.resumeFrom, { turn: 2 }, "the second run's checkpoint: the conversation went on");

      await runOnce(w);
      d = (await w.dispatcher.get(w.owner, attemptId!))!;
      assert.equal(d.state, "finished");
      assert.equal(d.outcome?.status, "stopped-early");
      assert.deepEqual(d.stoppedEarly?.map((r) => r.readmitted), [true, true, false]);

      // Three runs of the one attempt, on the one host, each a new request in the same conversation, the later ones from the checkpoint before them.
      assert.deepEqual(w.worker.starts.map((o) => o.attemptId), [attemptId, attemptId, attemptId]);
      assert.deepEqual(w.worker.starts.map((o) => o.requestId), [`cmd:adm:${attemptId}`, `cmd:adm:${attemptId}:se1`, `cmd:adm:${attemptId}:se2`]);
      assert.deepEqual(w.worker.starts.map((o) => o.resumeFrom), [undefined, { turn: 1 }, { turn: 2 }]);
      assert.equal((await w.assignments.getAttempt(attemptId!))?.state, "abandoned", "the assignment never records it succeeded");

      const blocker = await blockerOf(w, taskId);
      assert.ok(blocker, "the task carries an agent_stopped_early blocker");
      assert.equal(blocker.resolver, "owner");
      assert.match(blocker.summary, /3 time\(s\)/);
      assert.match(blocker.summary, /Last visible text \(quoted\): "Next I will update the parser\.\\u202e and \\"quote\\" \(turn 3\)"/, "the last text, quoted once, its controls escaped");
      assert.match(blocker.summary, /1 of 3 step\(s\) checked; not checked: "fix the parser", "run the tests"/);
      assert.match(blocker.summary, /2 files changed, 10 insertions\(\+\), 1 deletion\(-\); 1 commit ahead of the base/);
      assert.ok(blocker.summary.length <= 1000);
      assert.deepEqual(progressAsked, [`${attemptId}:${taskId}`]);

      // Nothing starts again by itself.
      await runOnce(w);
      assert.equal(w.worker.starts.length, 3);
    } finally { await store.close(); }
  });
}

for (const backend of backends) {
  test(`${backend.name}: every kind that is not normal, an unknown one included, stops early; a normal end and the agent's own work.end done are unchanged`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      const ann = await w.agent("ann", workGrants(w.project, []));
      for (const endKind of ["length", "empty-visible-text", "no-work-end", "announced-step-without-tool-call"] as const) {
        w.worker.script = stopper(endKind);
        const { attemptId } = await w.task(`kind ${endKind}`, ann);
        await runOnce(w);
        const d = (await w.dispatcher.get(w.owner, attemptId!))!;
        assert.equal(d.state, "waiting", endKind);
        assert.equal(d.stoppedEarly?.[0]?.endKind, endKind);
        await w.dispatcher.stop(w.owner, attemptId!, { reason: "looked at" });
      }
      // ASSUMPTION (W03): an older or remote worker that says nothing about how the turn ended is not taken at its word: unknown is not normal.
      w.worker.endsNormally = false;
      w.worker.script = async () => ({ status: "completed", text: "all done", checkpoint: { c: 1 } });
      const older = await w.task("older worker", ann);
      await runOnce(w);
      const o = (await w.dispatcher.get(w.owner, older.attemptId!))!;
      assert.equal(o.state, "waiting");
      assert.equal(o.stoppedEarly?.[0]?.endKind, "unknown");
      await w.dispatcher.stop(w.owner, older.attemptId!, { reason: "looked at" });

      // A normal end succeeds as before, with nothing readmitted.
      w.worker.endsNormally = true;
      w.worker.script = async () => ({ status: "completed", text: "done", endKind: "normal", visibleChars: 4 });
      const normal = await w.task("normal", ann);
      await runOnce(w);
      const n = (await w.dispatcher.get(w.owner, normal.attemptId!))!;
      assert.equal(n.outcome?.status, "succeeded");
      assert.equal(n.stoppedEarly, undefined);

      // The agent's work.end done, completed by the end hook when the turn ends (the turn itself said nothing of it): the attempt ends as the agent said, succeeded, whatever the kind.
      const dispatcher = w.dispatcher;
      dispatcher.onEnd(async (id) => { await dispatcher.finishWith(w.owner, id, { result: "done", note: "finished" }); return { handled: true }; });
      w.worker.script = stopper("no-work-end");
      const ended = await w.task("ended by the agent", ann);
      await runOnce(w);
      const e = (await w.dispatcher.get(w.owner, ended.attemptId!))!;
      assert.equal(e.state, "finished");
      assert.equal(e.outcome?.status, "succeeded");
      assert.equal(e.stoppedEarly, undefined);
      // The agent's own blocked ending carried by the end: it said how its work ended, so it is not a stop before the work was done.
      dispatcher.onEnd(async () => ({ outcome: "abandoned", summary: "the agent had asked to end it: blocked" }));
      const blocked = await w.task("blocked by the agent", ann);
      await runOnce(w);
      const bl = (await w.dispatcher.get(w.owner, blocked.attemptId!))!;
      assert.equal(bl.outcome?.status, "abandoned");
      assert.equal(bl.stoppedEarly, undefined);
      dispatcher.onEnd(undefined);
    } finally { await store.close(); }
  });
}

for (const backend of backends) {
  test(`${backend.name}: a controller restart between readmits keeps the count, and a host that cannot tell is said so`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      const ann = await w.agent("ann", workGrants(w.project, []));
      w.worker.script = stopper("empty-visible-text", "");
      const { taskId, attemptId } = await w.task("restarted", ann);
      await runOnce(w);
      assert.equal((await w.dispatcher.get(w.owner, attemptId!))!.turnRound, 1);
      const counted = await w.storage.getAggregate({ kind: STOPPED_EARLY_KIND, id: taskId });
      assert.equal((counted?.body as { readmits?: number } | undefined)?.readmits, 1, "the count is in storage");

      // A new controller process over the same storage.
      w.dispatcher = w.restart();
      await runOnce(w);
      assert.equal((await w.dispatcher.get(w.owner, attemptId!))!.turnRound, 2);
      w.dispatcher = w.restart();
      w.worker.progress = async () => { throw new Error("the checkout is gone"); };
      await runOnce(w);
      const d = (await w.dispatcher.get(w.owner, attemptId!))!;
      assert.equal(d.outcome?.status, "stopped-early", "the third stop after two restarts ends it: the count was kept");
      assert.equal(w.worker.starts.length, 3);
      const blocker = await blockerOf(w, taskId);
      assert.match(blocker!.summary, /Last visible text \(quoted\): none/);
      assert.match(blocker!.summary, /Plan: not known \(the host could not tell: the checkout is gone\)/);
    } finally { await store.close(); }
  });
}

for (const backend of backends) {
  test(`${backend.name}: an owner's stop and an emergency stop win over a readmit`, async () => {
    for (const emergency of [false, true]) {
      const store = await backend.open();
      try {
        const w = await buildWorld(store.storage);
        const ann = await w.agent(`ann${emergency ? "e" : "o"}`, workGrants(w.project, []));
        // The turn's end waits in the end hook while the stop comes: the stop joins that end, and the run that stopped early is not readmitted.
        let release!: () => void;
        const held = new Promise<void>((ok) => { release = ok; });
        let inHook!: () => void;
        const hooked = new Promise<void>((ok) => { inHook = ok; });
        w.dispatcher.onEnd(async () => { inHook(); await held; return undefined; });
        w.worker.script = stopper("no-work-end");
        const { taskId, attemptId } = await w.task(`stopped ${emergency}`, ann);
        await w.heartbeatHost();
        await w.dispatcher.tick();
        await hooked;
        const stopping = w.dispatcher.stop(w.owner, attemptId!, { reason: "the owner stopped it", emergency });
        await new Promise((ok) => setTimeout(ok, 20));
        release();
        await stopping;
        await w.dispatcher.idle();
        const d = (await w.dispatcher.get(w.owner, attemptId!))!;
        assert.equal(d.state, "finished", `emergency=${emergency}`);
        assert.equal(d.outcome?.status, "abandoned");
        assert.equal(d.turnRound, undefined, "never readmitted");
        await runOnce(w);
        assert.equal(w.worker.starts.length, 1, "nothing starts again");
        assert.equal(await blockerOf(w, taskId), undefined);

        // A stop that comes after the readmit was written ends the waiting attempt.
        w.dispatcher.onEnd(undefined);
        const second = await w.task(`stopped later ${emergency}`, ann);
        await runOnce(w);
        assert.equal((await w.dispatcher.get(w.owner, second.attemptId!))!.state, "waiting");
        await w.dispatcher.stop(w.owner, second.attemptId!, { reason: "the owner stopped it", emergency });
        await runOnce(w);
        const s = (await w.dispatcher.get(w.owner, second.attemptId!))!;
        assert.equal(s.state, "finished");
        assert.equal(s.outcome?.status, "abandoned");
        assert.equal(w.worker.starts.length, 2);
      } finally { await store.close(); }
    }
  });
}
