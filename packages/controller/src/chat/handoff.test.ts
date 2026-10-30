import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { Outcome } from "./index.js";
import { cid, openWorld } from "./testing/harness.js";

after(stopServer);

const cmd = (op: string, args: Record<string, unknown>, evidence: string) => ({ kind: "command", op, args, evidence, basis: "owner" });

for (const backend of backends) {
  test(`${backend.name}: the owner prepares, completes and cancels a hand-off in chat by task title and agent name; the hand-off is found as the one going on for the task (card L03f)`, async () => {
    const script: Record<string, unknown> = {};
    const calls: { method: string; args: Record<string, unknown> }[] = [];
    let going: string | undefined;
    const stub = {
      prepare: async (_p: unknown, c: Record<string, unknown>) => { calls.push({ method: "prepare", args: c }); going = "hnd-1"; return { id: "hnd-1", phase: "ready", revision: 1 }; },
      complete: async (_p: unknown, c: Record<string, unknown>) => { calls.push({ method: "complete", args: c }); going = undefined; return { id: c["handoffId"], phase: "transferred", revision: 2 }; },
      cancel: async (_p: unknown, c: Record<string, unknown>) => { calls.push({ method: "cancel", args: c }); going = undefined; return { id: c["handoffId"], phase: "cancelled", revision: 2 }; },
      takeover: async () => { throw new Error("not reached"); },
      choose: async () => { throw new Error("not reached"); },
      advance: async () => { throw new Error("not reached"); },
      sweep: async () => ({ advanced: [], failed: [] }),
      get: async () => undefined,
      forTask: async () => (going === undefined ? undefined : { id: going, revision: 1, body: {} }),
    };
    const w = await openWorld(backend, script, undefined, { handoffs: stub as never });
    try {
      const a = await w.project("A");
      const ann = await w.agents.create(w.owner, { commandId: cid("ag"), friendlyName: "Ann" });
      await w.task(a, "Build the login");
      const chat = w.chat();
      await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: a });
      w.profile.value = "autonomous";
      const say = async (text: string): Promise<Outcome> => { const o = (await chat.submit(w.ownerToken, { messageId: cid("m"), text })).outcomes; assert.equal(o.length, 1); return o[0]!; };
      script["Hand the Build the login task to Ann."] = [cmd("handoff.prepare", { taskTitle: "Build the login", toAgentName: "Ann", reason: "Ann knows the code" }, "Hand the Build the login task to Ann")];
      assert.equal((await say("Hand the Build the login task to Ann.")).status, "refused", "a reason that is not in the owner's message is not done");
      script["Hand the Build the login task to Ann, she knows the code."] = [cmd("handoff.prepare", { taskTitle: "Build the login", toAgentName: "Ann", reason: "she knows the code" }, "Hand the Build the login task to Ann")];
      const prepared = await say("Hand the Build the login task to Ann, she knows the code.");
      assert.deepEqual([prepared.status, prepared.op], ["applied", "handoff.prepare"]);
      assert.deepEqual(calls[0]!.args["to"], { kind: "agent", id: ann.id });
      assert.equal(calls[0]!.args["reason"], "she knows the code");
      script["Finish the Build the login hand-off."] = [cmd("handoff.complete", { taskTitle: "Build the login" }, "Finish the Build the login hand-off")];
      const done = await say("Finish the Build the login hand-off.");
      assert.deepEqual([done.status, done.op], ["applied", "handoff.complete"]);
      assert.equal(calls[1]!.args["handoffId"], "hnd-1");
      // Nothing is going now: refused, nothing guessed.
      script["Cancel the Build the login hand-off."] = [cmd("handoff.cancel", { taskTitle: "Build the login" }, "Cancel the Build the login hand-off")];
      assert.equal((await say("Cancel the Build the login hand-off.")).status, "refused");
      script["Hand Build the login to Zed, she knows the code."] = [cmd("handoff.prepare", { taskTitle: "Build the login", toAgentName: "Zed", reason: "she knows the code" }, "Hand Build the login to Zed")];
      assert.equal((await say("Hand Build the login to Zed, she knows the code.")).status, "refused");
      assert.equal(calls.length, 2);
    } finally { await w.close(); }
  });
}

for (const backend of backends) {
  test(`${backend.name}: a return time or accepting gaps is always shown first, and completing or cancelling needs the owner's words for the move (card L03f)`, async () => {
    const script: Record<string, unknown> = {};
    const calls: string[] = [];
    const stub = {
      prepare: async () => { calls.push("prepare"); return { id: "hnd-1", phase: "ready", revision: 1 }; },
      complete: async () => { calls.push("complete"); return { id: "hnd-1", phase: "transferred", revision: 2 }; },
      cancel: async () => { calls.push("cancel"); return { id: "hnd-1", phase: "cancelled", revision: 2 }; },
      takeover: async () => { throw new Error("no"); }, choose: async () => { throw new Error("no"); }, advance: async () => { throw new Error("no"); },
      sweep: async () => ({ advanced: [], failed: [] }), get: async () => undefined,
      forTask: async () => ({ id: "hnd-1", revision: 1, body: {} }),
    };
    const w = await openWorld(backend, script, undefined, { handoffs: stub as never });
    try {
      const a = await w.project("A");
      await w.task(a, "Build the login");
      await w.agents.create(w.owner, { commandId: cid("ag"), friendlyName: "Ann" });
      const chat = w.chat();
      await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: a });
      w.profile.value = "autonomous";
      const say = async (text: string): Promise<Outcome> => { const o = (await chat.submit(w.ownerToken, { messageId: cid("m"), text })).outcomes; assert.equal(o.length, 1); return o[0]!; };
      script["Hand Build the login to Ann."] = [cmd("handoff.prepare", { taskTitle: "Build the login", toAgentName: "Ann", returnAt: "2026-11-02T00:00:00.000Z" }, "Hand Build the login to Ann")];
      assert.equal((await say("Hand Build the login to Ann.")).status, "proposed", "a return time the owner never said is not applied");
      script["Complete the Build the login hand-off, gaps and all."] = [cmd("handoff.complete", { taskTitle: "Build the login", acceptGaps: true }, "Complete the Build the login hand-off")];
      assert.equal((await say("Complete the Build the login hand-off, gaps and all.")).status, "proposed", "accepting gaps is shown first");
      script["What about the Build the login hand-off."] = [cmd("handoff.complete", { taskTitle: "Build the login" }, "What about the Build the login hand-off")];
      assert.equal((await say("What about the Build the login hand-off.")).status, "proposed", "no word for the move: shown first");
      script["Cancel the Build the login hand-off."] = [cmd("handoff.cancel", { taskTitle: "Build the login" }, "Cancel the Build the login hand-off")];
      assert.equal((await say("Cancel the Build the login hand-off.")).status, "applied");
      assert.deepEqual(calls, ["cancel"]);
    } finally { await w.close(); }
  });
}
