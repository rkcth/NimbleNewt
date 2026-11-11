import assert from "node:assert/strict";
import { test } from "node:test";
import { GenerationService } from "@nimblenewt/controller";
import { rig, sandbox } from "./w03-rig-support.js";

// Card G09, the part the fixture could not show (g09-evidence.md "What this proof does not show", first point): the cut in the middle of a tool call and the late complete call, with the real worker process (bubblewrap, Pi Durable) behind the
// controller's relay (L05b), not a stand-in chunk. The effect observed is the real end of the attempt (`work.end`): a stale call that got through would end the task with the stale report. Skipped without bubblewrap unless
// NIMBLENEWT_REQUIRE_SANDBOX=1 (set in CI). The model is scripted (no real model was used).
const gate = (): { promise: Promise<void>; open: () => void } => { let open!: () => void; const promise = new Promise<void>((r) => { open = r; }); return { promise, open }; };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean | Promise<boolean>, why: string, ms = 60_000): Promise<void> => { const end = Date.now() + ms; while (!(await ok())) { if (Date.now() > end) assert.fail(why); await sleep(50); } };
const GOOD = { call: { name: "nimblenewt__work-end", args: { report: "Done as the task asked.", result: "done", note: "beans planted" } } } as const;

test("a stream cut in the middle of a work.end call: the partial call never ends the task, it is never admitted, and the next generation sees the correction and not the stale words (card G09)", async (t) => {
  const launcher = await sandbox(t);
  if (launcher === undefined) return;
  const cut = gate();
  const x = await rig(launcher, [{ partial: { name: "nimblenewt__work-end", head: '{"report":"STALE-REPORT-9 plant tomatoes', tail: '","result":"done","note":"STALE-NOTE"}', hold: cut.promise } }, GOOD, { text: "Ended: beans planted." }]);
  try {
    const generation = GenerationService.withEpoch(x.c.storage, x.c.epoch);
    const view = async (n: number) => (await generation.view(x.owner, GenerationService.runIdOf(x.taskId, n)))?.run;
    const running = x.run();
    await until(async () => (await view(1))?.toolCalls.some((c) => c.name === "nimblenewt__work-end" && c.state === "partial") === true, "the partial call was never recorded");
    assert.equal((await view(1))!.toolCalls.length, 1);
    await generation.correct(x.owner, { commandId: "fix", taskId: x.taskId, expectedContextRevision: 1, reason: "use beans, not tomatoes" });
    cut.open();
    await running;
    const first = (await view(1))!;
    assert.equal(first.state, "interrupted");
    assert.equal(first.interrupted?.kind, "corrected");
    assert.ok(first.toolCalls.every((c) => c.state !== "admitted" && c.state !== "complete" && c.effectId === undefined), JSON.stringify(first.toolCalls));
    assert.equal(first.toolCalls[0]?.state, "dropped", JSON.stringify(first.toolCalls));
    assert.ok(!first.toolCalls.some((c) => c.args.includes("STALE-NOTE")), "the tail that arrived after the correction was not applied");
    // The tail did reach the relay after the correction (so the test is not passing because nothing came): it is recorded as a late piece of the same call.
    assert.ok(first.late.some((l) => l.kind === "tool_call" && l.toolCallId === first.toolCalls[0]?.id), JSON.stringify(first.late));
    // The task ended with the second generation's call, bound to the new revision, and nothing of the stale call reached the model or the record.
    const d = await x.get();
    assert.equal(d.state, "finished");
    assert.equal(d.outcome?.status, "succeeded", d.outcome?.summary);
    assert.equal((await view(2))?.contextRevision, 2);
    assert.equal(x.answer.seen.length >= 2, true);
    const later = x.answer.seen.slice(1).join("\n");
    assert.match(later, /use beans, not tomatoes/, "the next request carries the correction");
    assert.equal(/STALE-REPORT-9|STALE-NOTE/.test(later), false, "the cut call is in nothing the model was shown later");
    assert.equal(JSON.stringify(d).includes("STALE"), false, "nothing of the stale call is in the attempt's record");
  } finally { cut.open(); await x.close(); }
});

test("a complete work.end call that arrives after the owner's correction is held back: the task is not ended by it, and the late call is visible only as a digest (card G09)", async (t) => {
  const launcher = await sandbox(t);
  if (launcher === undefined) return;
  const late = gate();
  const x = await rig(launcher, [{ hold: late.promise, call: { name: "nimblenewt__work-end", args: { report: "STALE-DONE-7 tomatoes planted", result: "done", note: "tomatoes" } } }, GOOD, { text: "Ended: beans planted." }]);
  try {
    const generation = GenerationService.withEpoch(x.c.storage, x.c.epoch);
    const view = async (n: number) => (await generation.view(x.owner, GenerationService.runIdOf(x.taskId, n)))?.run;
    const running = x.run();
    await until(async () => (await view(1))?.state === "streaming", "the first generation never began");
    await generation.correct(x.owner, { commandId: "fix", taskId: x.taskId, expectedContextRevision: 1, reason: "use beans, not tomatoes" });
    late.open();
    await running;
    const first = (await view(1))!;
    assert.equal(first.state, "interrupted");
    // The complete call itself arrived and is recorded as late (a failed stream's end is always a late `completion`, so that alone would not show the call came).
    assert.ok(first.late.some((l) => l.kind === "tool_call" && l.toolCallId !== undefined), JSON.stringify(first.late));
    assert.deepEqual(first.toolCalls, [], "the late call is not recorded as a call of the generation");
    const d = await x.get();
    assert.equal(d.outcome?.status, "succeeded", d.outcome?.summary);
    assert.equal(JSON.stringify(d).includes("STALE-DONE-7"), false, "the stale report did not end the task");
    assert.equal(x.answer.seen.slice(1).join("\n").includes("STALE-DONE-7"), false, "the held call is not in anything the model was later shown");
    assert.equal((await view(2))?.contextRevision, 2);
  } finally { late.open(); await x.close(); }
});
