import assert from "node:assert/strict";
import { after, test } from "node:test";
import { StartSizeService } from "../context/index.js";
import { BlockerService } from "../domain/blockers.js";
import { WaitService } from "../domain/waits.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { Principal } from "../security/principals.js";
import { StatusService } from "../status/index.js";
import { CHAT_OPS, acceptedArgs } from "./index.js";
import { cid, openWorld, options } from "./testing/harness.js";

after(stopServer);
const cmd = (op: string, args: Record<string, unknown>, evidence: string) => ({ kind: "command", op, args, evidence, basis: "owner" });
const ask = (request: Record<string, unknown>, evidence: string) => ({ kind: "status", request, evidence, basis: "owner" });
/** The dispatcher's guards, as the watch is told by them. */
const host = { kind: "host", id: "host:w1", grants: [] } as unknown as Principal;

/**
 * Card C07i in chat: the owner asks in free words how a task's starting size is moving and is answered from the watch's record (the trend, the open alert and its contributors, the thresholds); the task's own status carries the
 * warning; and the owner changes the thresholds in free words. No set phrase is needed: the interpreter maps the owner's words to the `start_size` view and the `context.start-size.change` command.
 */
for (const backend of backends) {
  test(`${backend.name}: the owner reads a task's starting-size trend and its warning by chat, and changes the watch's thresholds in free words (card C07i)`, async () => {
    assert.equal(CHAT_OPS["context.start-size.change"]?.mode, "apply", "a threshold is a reversible setting");
    for (const k of ["set", "unset", "expectedRevision"]) assert.ok(acceptedArgs("context.start-size.change")!.includes(k), k);
    let watch: StartSizeService | undefined;
    const script: Record<string, unknown> = {};
    const w = await openWorld(backend, script, undefined, { startSizes: { read: (...a: Parameters<StartSizeService["read"]>) => watch!.read(...a), getSettings: (...a: Parameters<StartSizeService["getSettings"]>) => watch!.getSettings(...a), changeSettings: (...a: Parameters<StartSizeService["changeSettings"]>) => watch!.changeSettings(...a) } } as never);
    try {
      const epoch = w.projects.epoch;
      watch = StartSizeService.withEpoch(w.world.storage, epoch, options);
      const status = StatusService.withEpoch(w.world.storage, epoch, { assignments: w.assignments, waits: WaitService.withEpoch(w.world.storage, epoch, w.assignments, options), blockers: BlockerService.withEpoch(w.world.storage, epoch, options), contracts: w.contracts, startSizes: watch }, options);
      const a = await w.project("A");
      const t = await w.task(a, "Build importer");
      for (const [i, tokens] of [3000, 4000, 5000, 6000].entries()) await watch.record(host, { taskId: t, attemptId: `att-${i}`, key: "1", route: "localp/small", worker: i === 3 ? "remote" : "local", tokens, window: 40_000, limitTokens: 10_000, admitted: true, parts: { conversation: tokens - 2000, fixed: 2000 }, refs: ["hof-bbbbbbbbbbbbbbbbbbbb"] });
      const chat = w.chat({ status });
      await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: a });

      const said = "is the Build importer task getting slower to start each time it is handed on?";
      script[said] = [ask({ kind: "start_size", taskTitle: "Build importer" }, said)];
      const r = (await chat.submit(w.ownerToken, { messageId: "m-1", text: said })).outcomes[0]!;
      assert.equal(r.status, "answered", JSON.stringify(r));
      const lines = r.lines!.map((l) => l.text);
      assert.match(lines[0]!, /^4 attempts recorded, hand-offs 0 to 3\.$/);
      assert.match(lines[4]!, /^Hand-off 3 \(attempt att-3, remote worker, route localp\/small\): 6000 tokens, 60 percent of the route's startup limit of 10000 tokens\.$/);
      const alert = lines.find((l) => l.startsWith("Alert open"))!;
      assert.match(alert, /rose over 3 hand-offs in a row \(3000 -> 4000 -> 5000 -> 6000 tokens, up to hand-off 3\); largest contributors: stored conversation 4000 \(\+3000\)/);
      assert.match(alert, /Nothing was cut for it/);
      assert.match(alert, /hof-bbbbbbbbbbbbbbbbbbbb \(context\.handoff\.read\)/, "the alert links the archived originals");
      assert.match(lines.at(-1)!, /rises over 3 hand-offs in a row .* warns once at 80 percent/);

      // The task's own status carries the warning.
      script["how is Build importer doing"] = [ask({ kind: "task", taskId: t }, "how is Build importer doing")];
      const task = (await chat.submit(w.ownerToken, { messageId: "m-2", text: "how is Build importer doing" })).outcomes[0]!;
      assert.ok(task.lines!.some((l) => /^Warning: its starting size rose over 3 hand-offs/.test(l.text)), JSON.stringify(task.lines));

      // Free words change the thresholds; the change is applied and used from the next call.
      const change = "warn me when a first call gets to 70 percent of its limit, and only alert after 4 rising hand-offs";
      script[change] = [cmd("context.start-size.change", { set: { warnPercent: 70, risingHandoffs: 4 } }, change)];
      const done = (await chat.submit(w.ownerToken, { messageId: "m-3", text: change })).outcomes[0]!;
      assert.equal(done.status, "applied", JSON.stringify(done));
      assert.deepEqual(await watch.effective(), { risingHandoffs: 4, warnPercent: 70, minRisePercent: 1 });
      // A figure out of bounds is refused, not stored.
      const bad = "warn me at 120 percent";
      script[bad] = [cmd("context.start-size.change", { set: { warnPercent: 120 } }, bad)];
      const refused = (await chat.submit(w.ownerToken, { messageId: "m-4", text: bad })).outcomes[0]!;
      assert.notEqual(refused.status, "applied");
      assert.equal((await watch.effective()).warnPercent, 70);
    } finally { await w.close(); }
  });
}
