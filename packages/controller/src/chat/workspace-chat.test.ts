import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { ModelInterpreter } from "./model-interpreter.js";
import { CHAT_OPS, acceptedArgs } from "./index.js";
import { cid, openWorld } from "./testing/harness.js";

after(stopServer);
const cmd = (op: string, args: Record<string, unknown>, evidence: string) => ({ kind: "command", op, args, evidence, basis: "owner" });

// Card H12m: the owner asks for an integration, landing, refresh, quarantine or release of a task's checkout in their own words; it is shown first and carried out once, on the owner's word.
test("the interpreter is told about workspace requests, with the operation and the reason", async () => {
  assert.equal(CHAT_OPS["workspace.request"]?.mode, "propose", "changing a checkout is shown first in every profile");
  for (const k of ["operation", "taskId", "taskTitle", "reason"]) assert.ok(acceptedArgs("workspace.request")!.includes(k), k);
  let system = "";
  const m = new ModelInterpreter({ complete: async (_route, r) => { system = r.system; return "[]"; } }, () => ["a/primary"]);
  await m.interpret({ text: "hello", quoted: [], focus: {}, proposals: [] } as never);
  assert.match(system, /workspace\.request\([^)]*operation[^)]*\) - Change a task's checkout/);
  assert.match(system, /quarantine moves it aside for the owner and stops its attempt/);
});

for (const backend of backends) {
  test(`${backend.name}: the owner quarantines a task's checkout by chat: shown first, applied once on the owner's word with the owner's reason; a reason the owner never gave and an agent are refused (card H12m)`, async () => {
    const asked: { operation: string; taskId: string; reason: string }[] = [];
    const stub = { request: async (_by: unknown, c: { operation: string; taskId: string; reason: string }) => { asked.push({ operation: c.operation, taskId: c.taskId, reason: c.reason }); return { id: "wsr-aaaaaaaaaaaaaaaaaaaa", state: "done", operation: c.operation, taskId: c.taskId, summary: "moved aside", replayed: false }; }, get: async () => undefined };
    const script: Record<string, unknown> = {};
    const w = await openWorld(backend, script, undefined, { workspaceOps: stub as never });
    try {
      const chat = w.chat();
      const p = await w.project("Garden");
      const t = await w.task(p, "weed");
      const text = "put the weed checkout aside, it touched odd files";
      script[text] = [cmd("workspace.request", { operation: "quarantine", taskId: t, reason: "it touched odd files" }, text)];
      const r = await chat.submit(w.ownerToken, { messageId: cid("m"), text });
      assert.equal(r.outcomes[0]!.status, "proposed", JSON.stringify(r.outcomes[0]));
      // What the owner confirms names the operation, the task and the reason (the line is cut at its limit, so the verb must leave room for them).
      assert.match(String(r.outcomes[0]!.preview), /operation=quarantine, taskId="weed", reason=it touched odd files/, JSON.stringify(r.outcomes[0]!.preview));
      assert.deepEqual(asked, [], "nothing is asked of the host until the owner confirms");
      const applied = await chat.applyProposal(w.ownerToken, { commandId: cid("a"), proposalId: r.outcomes[0]!.proposalId! });
      assert.equal(applied.applied, true, JSON.stringify(applied));
      assert.deepEqual(asked, [{ operation: "quarantine", taskId: t, reason: "it touched odd files" }]);
      assert.equal((await chat.applyProposal(w.ownerToken, { commandId: cid("a"), proposalId: r.outcomes[0]!.proposalId! })).replayed, true);
      assert.equal(asked.length, 1, "carried out once");

      // A reason the owner never gave is not recorded on their behalf.
      const other = "refresh the weed checkout please";
      script[other] = [cmd("workspace.request", { operation: "refresh", taskId: t, reason: "the owner approved a full reset" }, other)];
      const refused = await chat.submit(w.ownerToken, { messageId: cid("m"), text: other });
      assert.equal(refused.outcomes[0]!.status, "refused", JSON.stringify(refused.outcomes[0]));
      assert.match(String(refused.outcomes[0]!.message), /reason/);
      assert.equal(asked.length, 1);

      const ann = await w.agent("ann", [{ action: "*", project: "*" }]);
      await assert.rejects(chat.submit(ann.token, { messageId: cid("n"), text }), (e: unknown) => (e as { code?: string }).code === "forbidden");
    } finally { await w.close(); }
  });
}
