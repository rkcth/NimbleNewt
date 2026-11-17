import assert from "node:assert/strict";
import { test } from "node:test";
import type { RemoteWorkspaceAnswer, WorkspaceAsk } from "./protocol.js";
import { WorkspaceResponder } from "./responder.js";

// Card L04e review: what a host says back when its look at a task's files fails. The error's text may name a path on the host's disk; it stays in the host's own log and the controller hears only that the look failed.
test("a look that throws on the host is refused without the error's text, which goes to the host's own log; a look that answers sends hashes only", async () => {
  const sent: { id: string; answer: RemoteWorkspaceAnswer }[] = [];
  const logged: unknown[] = [];
  let fail = true;
  const responder = new WorkspaceResponder({
    client: { answerWorkspace: async (id: string, answer: RemoteWorkspaceAnswer) => { sent.push({ id, answer }); } }, busy: () => [], port: { run: async () => ({ ok: false, reason: "no" }) } as never,
    onError: (e) => logged.push(e),
    observe: async () => { if (fail) throw new Error("EACCES: permission denied, open '/home/host-user/work/checkout/src/a.ts'"); return { "dpm-1": { exists: true, hash: "a".repeat(64) }, "dpm-2": { exists: false } }; },
  });
  const ask = (n: number): WorkspaceAsk => ({ requestId: `wsr-${String(n).repeat(20)}`, operation: "observe", taskId: "task-1", projectId: "proj-1", reason: "look", quietAttempts: [], observe: { entries: [{ id: "dpm-1", kind: "file", key: "src/a.ts" }, { id: "dpm-2", kind: "file", key: "src/b.ts" }] } });
  responder.handle([ask(2)]);
  await responder.idle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.answer.ok, false);
  assert.equal(JSON.stringify(sent[0]!.answer).includes("/home/host-user"), false, "no host path in the answer");
  assert.equal(JSON.stringify(sent[0]!.answer).includes("EACCES"), false);
  assert.match(String(logged[0]), /host-user/, "the host's own log has the detail");
  fail = false;
  responder.handle([ask(3)]);
  await responder.idle();
  assert.deepEqual(sent[1]!.answer, { ok: true, summary: "looked", detail: { observed: { "dpm-1": { exists: true, hash: "a".repeat(64) }, "dpm-2": { exists: false } } } });
});
