import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { Outcome } from "./index.js";
import { cid, openWorld } from "./testing/harness.js";

after(stopServer);

const cmd = (op: string, args: Record<string, unknown>, evidence: string) => ({ kind: "command", op, args, evidence, basis: "owner" });

for (const backend of backends) {
  test(`${backend.name}: the owner limits a task's model use in chat by its title; the change is always shown first, with its numbers, and nothing is set until the owner agrees (card V02)`, async () => {
    const script: Record<string, unknown> = {};
    const set: Record<string, unknown>[] = [];
    const stub = { setBudget: async (_p: unknown, c: Record<string, unknown>) => { set.push(c); }, budget: async () => undefined, spend: async () => ({ costMicros: 0, tokens: 0, calls: 0, failures: 0 }) };
    const w = await openWorld(backend, script, undefined, { modelBudget: stub as never });
    try {
      const a = await w.project("A");
      const build = await w.task(a, "Build the login");
      const chat = w.chat();
      await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: a });
      w.profile.value = "autonomous";
      const say = async (text: string): Promise<Outcome> => { const o = (await chat.submit(w.ownerToken, { messageId: cid("m"), text })).outcomes; assert.equal(o.length, 1); return o[0]!; };
      script["Allow at most 5 failed attempts on Build the login."] = [cmd("model-budget.set", { taskTitle: "Build the login", maxFailedAttempts: 5 }, "Allow at most 5 failed attempts on Build the login")];
      const proposed = await say("Allow at most 5 failed attempts on Build the login.");
      assert.equal(proposed.status, "proposed", "shown first even in the autonomous profile");
      assert.equal(set.length, 0);
      script["Allow at most 5 failed attempts on Build the login now."] = [cmd("model-budget.set", { taskTitle: "Build the login", maxFailedAttempts: 50 }, "Allow at most 5 failed attempts on Build the login")];
      const wrong = await say("Allow at most 5 failed attempts on Build the login now.");
      assert.equal(wrong.status, "proposed");
      assert.match(JSON.stringify(wrong), /maxFailedAttempts=50/, "the owner reads the number before anything is done");
      assert.equal(set.length, 0);
      void build;
    } finally { await w.close(); }
  });
}
