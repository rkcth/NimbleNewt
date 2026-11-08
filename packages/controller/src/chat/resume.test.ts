import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ContinuationService, ResumeCheckService, controllerResumePorts } from "../continuation/index.js";
import { DependencyService } from "../dependencies/index.js";
import { BlockerService } from "../domain/blockers.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { Outcome } from "./index.js";
import { cid, openWorld, options } from "./testing/harness.js";

after(stopServer);

const cmd = (op: string, args: Record<string, unknown>, evidence: string) => ({ kind: "command", op, args, evidence, basis: "owner" });
const capture = (decisions: string[]) => ({
  identity: "conv-1", agent: "agent:ann", boundary: { kind: "turn-complete" as const }, checkpoint: { format: 2, conversationId: 7, at: 41, digest: `v1:sha256:${"a".repeat(64)}`, runtime: { name: "pi-durable", version: "1.3.0" } }, durable: { verified: true },
  continuation: { artifacts: [], decisions, pendingEffects: [], budget: { spent: 1, remaining: 9, unit: "k-tokens" }, nextStep: "run the tests" },
  manifest: { summaryLineage: [], sourceRanges: [{ source: "history", from: 1, to: 41 }], compression: { state: "none" as const, compactions: 0 }, branches: [], messageCursor: 41, routingRevision: 1, environmentRevision: 1, adapter: { name: "pi-durable", version: "1.3.0" } },
  nonCheckpointableTools: [], scratchRecords: [], credentialRefs: [],
});

for (const backend of backends) {
  test(`${backend.name}: the owner starts a task's resume check over, or cancels it, in chat by the task's title; the check is found as the task's current one, and nothing is guessed when it has none (card L04c)`, async () => {
    const script: Record<string, unknown> = {};
    // The API is built before the storage is known to this test: the real service is put behind it once the world is open.
    let real: ResumeCheckService | undefined;
    const late = new Proxy({}, { get: (_t, name: string) => (...a: unknown[]) => (real as unknown as Record<string, (...x: unknown[]) => unknown>)[name]!.apply(real, a) });
    const w = await openWorld(backend, script, undefined, { resumes: late as never });
    try {
      const continuations = ContinuationService.withEpoch(w.world.storage, w.projects.epoch, options);
      real = ResumeCheckService.withEpoch(w.world.storage, w.projects.epoch, { continuations, dependencies: DependencyService.withEpoch(w.world.storage, w.projects.epoch, options), blockers: BlockerService.withEpoch(w.world.storage, w.projects.epoch, options), ports: controllerResumePorts(w.world.storage) }, options);
      const a = await w.project("A");
      const login = await w.task(a, "Build the login");
      const docs = await w.task(a, "Write the docs");
      const chat = w.chat();
      await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: a });
      w.profile.value = "autonomous";
      const say = async (text: string): Promise<Outcome> => { const o = (await chat.submit(w.ownerToken, { messageId: cid("m"), text })).outcomes; assert.equal(o.length, 1); return o[0]!; };
      // No check yet: refused, nothing guessed.
      script["Start the Build the login resume check over."] = [cmd("resume.retry", { taskTitle: "Build the login" }, "Start the Build the login resume check over")];
      assert.equal((await say("Start the Build the login resume check over.")).status, "refused");
      // A check blocked on missing context.
      await continuations.capture(w.owner, { commandId: "cap", taskId: login, ...capture(["dsk-aaaaaaaaaaaaaaaaaaaa"]) });
      const blocked = await real.start(w.owner, { commandId: "rs", taskId: login, model: { provider: "local", id: "m1" }, after: "restart" });
      assert.equal(blocked.phase, "blocked");
      const retried = await say("Start the Build the login resume check over.");
      assert.deepEqual([retried.status, retried.op], ["applied", "resume.retry"], JSON.stringify(retried));
      const after1 = (await real.get(w.owner, blocked.id))!;
      assert.equal(after1.blocks, 2, "it was started over (and blocked again: the decision is still gone)");
      assert.ok(after1.history.some((h) => /retried/.test(h.note)));
      // Another task of the project has no check: refused, the login check is untouched.
      script["Cancel the Write the docs resume check."] = [cmd("resume.cancel", { taskTitle: "Write the docs" }, "Cancel the Write the docs resume check")];
      assert.equal((await say("Cancel the Write the docs resume check.")).status, "refused");
      assert.equal((await real.get(w.owner, blocked.id))!.phase, "blocked");
      script["Cancel the Build the login resume check."] = [cmd("resume.cancel", { taskTitle: "Build the login" }, "Cancel the Build the login resume check")];
      const cancelled = await say("Cancel the Build the login resume check.");
      assert.deepEqual([cancelled.status, cancelled.op], ["applied", "resume.cancel"], JSON.stringify(cancelled));
      assert.equal((await real.get(w.owner, blocked.id))!.phase, "cancelled");
      // The task named is the task acted on: a check ID the interpreter adds that is not the named task's current check is refused, and neither check moves.
      await continuations.capture(w.owner, { commandId: "cap-d", taskId: docs, ...capture(["dsk-bbbbbbbbbbbbbbbbbbbb"]) });
      const docsCheck = await real.start(w.owner, { commandId: "rs-d", taskId: docs, model: { provider: "local", id: "m1" }, after: "restart" });
      const loginAgain = await real.start(w.owner, { commandId: "rs-2", taskId: login, model: { provider: "local", id: "m1" }, after: "restart" });
      // Even when the owner's own words carry the other task's check ID.
      const crossedText = `Cancel the Write the docs resume check ${loginAgain.id}.`;
      script[crossedText] = [cmd("resume.cancel", { taskTitle: "Write the docs", checkId: loginAgain.id }, crossedText.slice(0, -1))];
      const crossed = await say(crossedText);
      assert.deepEqual([crossed.status, (crossed as { message?: string }).message], ["refused", "that resume check is not the named task's current one; name the task only"], JSON.stringify(crossed));
      assert.equal((await real.get(w.owner, loginAgain.id))!.phase, loginAgain.phase);
      assert.equal((await real.get(w.owner, docsCheck.id))!.phase, docsCheck.phase);
    } finally { await w.close(); }
  });
}
