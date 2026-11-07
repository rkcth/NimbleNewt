import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { CHAT_OPS, acceptedArgs } from "./index.js";
import { cid, openWorld } from "./testing/harness.js";

after(stopServer);
const cmd = (op: string, args: Record<string, unknown>, evidence: string) => ({ kind: "command", op, args, evidence, basis: "owner" });

// Card L04c: the owner lets a held task go on by saying so in chat, with no fixed phrase and no check ID.
for (const backend of backends) {
  test(`${backend.name}: the owner approves a held resume by chat: shown first, applied once on the owner's word, refused for an agent`, async () => {
    assert.equal(CHAT_OPS["resume.approve"]?.mode, "propose", "accepting changes that matter is shown first");
    assert.ok(acceptedArgs("resume.approve")!.includes("taskId") && acceptedArgs("resume.approve")!.includes("taskTitle"), "the owner names a task (by title if need be)");
    assert.ok(!acceptedArgs("resume.approve")!.includes("checkId"), "never a check ID");
    const approved: string[] = [];
    const stub = { approve: async (_by: unknown, c: { taskId: string }) => { approved.push(c.taskId); return { id: "rck-1", phase: "done" }; } };
    const script: Record<string, unknown> = {};
    const w = await openWorld(backend, script, undefined, { resumes: stub as never });
    try {
      const chat = w.chat();
      const p = await w.project("Garden");
      const t = await w.task(p, "weed");
      const text = "yes, go ahead with weed even though the files changed";
      script[text] = [cmd("resume.approve", { taskId: t }, text)];
      const r = await chat.submit(w.ownerToken, { messageId: cid("m"), text });
      assert.equal(r.outcomes[0]!.status, "proposed");
      assert.deepEqual(approved, [], "nothing is approved until the owner confirms the proposal");
      const applied = await chat.applyProposal(w.ownerToken, { commandId: cid("a"), proposalId: r.outcomes[0]!.proposalId! });
      assert.equal(applied.applied, true);
      assert.deepEqual(approved, [t]);
      assert.equal((await chat.applyProposal(w.ownerToken, { commandId: cid("a"), proposalId: r.outcomes[0]!.proposalId! })).replayed, true);
      assert.deepEqual(approved, [t], "applied once");
      const ann = await w.agent("ann", [{ action: "*", project: "*" }]);
      await assert.rejects(chat.submit(ann.token, { messageId: cid("n"), text }), (e: unknown) => (e as { code?: string }).code === "forbidden");
    } finally { await w.close(); }
  });

  test(`${backend.name}: the owner declines a held resume by chat: shown first, named by task, applied once on the owner's word, refused for an agent`, async () => {
    assert.equal(CHAT_OPS["resume.decline"]?.mode, "propose", "declining releases the task, so it is shown first");
    assert.match(CHAT_OPS["resume.decline"]!.verb, /released/, "the interpreter is told what declining does");
    assert.ok(acceptedArgs("resume.decline")!.includes("taskId") && acceptedArgs("resume.decline")!.includes("taskTitle"));
    assert.ok(!acceptedArgs("resume.decline")!.includes("checkId"), "never a check ID");
    const declined: string[] = [];
    const stub = { decline: async (_by: unknown, c: { taskId: string }) => { declined.push(c.taskId); return { id: "rck-1", phase: "cancelled" }; } };
    const script: Record<string, unknown> = {};
    const w = await openWorld(backend, script, undefined, { resumes: stub as never });
    try {
      const chat = w.chat();
      const p = await w.project("Garden");
      const t = await w.task(p, "weed");
      const text = "no, don't let weed carry on with those changed files";
      script[text] = [cmd("resume.decline", { taskId: t }, text)];
      const r = await chat.submit(w.ownerToken, { messageId: cid("m"), text });
      assert.equal(r.outcomes[0]!.status, "proposed");
      assert.deepEqual(declined, [], "nothing is declined until the owner confirms the proposal");
      const applied = await chat.applyProposal(w.ownerToken, { commandId: cid("a"), proposalId: r.outcomes[0]!.proposalId! });
      assert.equal(applied.applied, true);
      assert.deepEqual(declined, [t]);
      assert.equal((await chat.applyProposal(w.ownerToken, { commandId: cid("a"), proposalId: r.outcomes[0]!.proposalId! })).replayed, true);
      assert.deepEqual(declined, [t], "applied once");
      const ann = await w.agent("ann", [{ action: "*", project: "*" }]);
      await assert.rejects(chat.submit(ann.token, { messageId: cid("n"), text }), (e: unknown) => (e as { code?: string }).code === "forbidden");
    } finally { await w.close(); }
  });
}
