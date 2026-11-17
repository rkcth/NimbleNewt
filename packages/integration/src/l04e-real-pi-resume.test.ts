import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { rig, sandbox } from "./w03-rig-support.js";

// Card L04e, end to end with a REAL Pi worker process (bubblewrap, offline, a scripted model): one turn of the real process leaves a checkpoint that the process itself read back from its store (`nn.durable`); the dispatcher
// captures it as the task's continuation, complete; the attempt's next run is held by the checked resume against THAT capture, with the task's recorded files observed again in the checkout the worker works in (not unknown);
// the owner approves the changed one; and the real process continues the same conversation from the checkpoint. Skipped without bubblewrap unless NIMBLENEWT_REQUIRE_SANDBOX=1 (set in CI).
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

test("a real Pi worker's turn is captured as a complete continuation with its own read-back check, the next run is checked against that capture with the task's files observed in the worker's checkout, and the same conversation continues after approval (card L04e)", async (t) => {
  const launcher = await sandbox(t);
  if (launcher === undefined) return;
  // First run: the turn and its three nudges stop without work.end (W03/W04); the resumed run ends the work.
  const stop = [{ text: "First I read the parser." }, { text: "Still reading." }, { text: "Still reading." }, { text: "Still reading." }];
  const x = await rig(launcher, [...stop, { call: { name: "nimblenewt__work-end", args: { report: "Done as the task asked.", result: "done", note: "parser fixed" } } }, { text: "Ended: the parser is fixed." }], {
    start: { resumeCheckout: async ({ taskId, projectId }) => ws().locate({ taskId, projectId })?.checkout },
  });
  const ws = (): typeof x.ws => x.ws;
  const call = async (op: string, args: Record<string, unknown>, commandId?: string) => (await x.c.api.handle(x.ownerToken, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
  try {
    await x.run();
    let d = await x.get();
    assert.equal(d.state, "waiting", JSON.stringify(d.outcome));
    assert.ok(d.resumeFrom !== undefined, "it goes on from the turn's checkpoint");
    const pi = (d.resumeFrom as { pi?: { digest?: string } }).pi;
    assert.match(String(pi?.digest), /^v1:sha256:[0-9a-f]{64}$/, "the real process's checkpoint names its digest");
    const nn = (d.resumeFrom as { nn?: { durable?: { verified?: boolean } } }).nn;
    assert.deepEqual(nn?.durable, { verified: true }, "the real process read its checkpoint back from its store and said so");

    // The continuation the dispatcher captured from it: complete, and for exactly this checkpoint.
    const latest = (await call("continuation.latest", { taskId: x.taskId })).result.item;
    assert.ok(latest !== undefined, "the turn was captured");
    assert.equal(latest.checkpoint.digest, pi!.digest);
    assert.equal(latest.status, "complete");

    // What the agent relied on, read in the checkout the worker works in; then the work moved on: one file changed, one did not.
    const where = x.ws.locate({ taskId: x.taskId, projectId: x.project })!;
    writeFileSync(join(where.checkout, "src", "kept.ts"), "export const kept = 1;\n");
    const recorded = await call("resume.dependencies.record", { taskId: x.taskId, dependencies: [
      { kind: "file", key: "src/a.ts", hash: sha("export const a = 1;\n") },
      { kind: "file", key: "src/kept.ts", hash: sha("export const kept = 1;\n") },
    ] }, "dep1");
    assert.deepEqual(recorded.result, { recorded: 2 }, JSON.stringify(recorded));
    writeFileSync(join(where.checkout, "src", "a.ts"), "export const a = 2;\n");

    // The next run is held: the check names the capture of this very checkpoint, and says what changed, not "unknown".
    await x.run();
    d = await x.get();
    assert.equal(d.state, "waiting", "held for the owner's decision, not started");
    const check = (await call("resume.for-task", { taskId: x.taskId })).result.item;
    assert.equal(check.continuationId, latest.id, "the check follows the capture the real process's checkpoint produced");
    assert.equal(check.phase, "ready");
    assert.deepEqual(check.delta.changed.map((c: { key: string; status: string }) => [c.key, c.status]), [["src/a.ts", "changed"]]);
    assert.equal(check.delta.unchanged, 1, "the file that did not change is unchanged, observed in the worker's checkout");
    assert.equal(JSON.stringify(check).includes("export const"), false, "no file content is in the check");
    assert.equal(x.answer.seen.length, 4, "no model call was made while the check was held");

    assert.equal((await call("resume.approve", { taskId: x.taskId }, "ok")).result.item.phase, "done");
    await x.run();
    d = await x.get();
    assert.equal(d.state, "finished");
    assert.equal(d.outcome?.status, "succeeded", JSON.stringify(d.outcome));
    // The same conversation: the real process restored its history from the checkpoint, so its first request after the resume holds the first turn's reply.
    assert.equal(x.answer.seen.length, 6);
    assert.match(x.answer.seen[4]!, /First I read the parser\./);
    assert.match(x.answer.seen[4]!, /This attempt goes on from where it stopped/);
    const records = await x.c.storage.listAggregates("continuation-resume", { limit: 10 });
    assert.equal(records.length, 1, "one resume recorded");
    assert.equal((records[0]!.body as { continuationId?: string }).continuationId, latest.id);
  } finally { await x.close(); }
});
