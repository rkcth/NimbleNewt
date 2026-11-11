import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { proposalReason } from "./commands.js";
import { openWorld } from "./testing/harness.js";

after(stopServer);

for (const backend of backends) {
  test(`${backend.name}: the revoke question and preview count all running calls, not only the listed ones, and say finish cannot be changed to cancel or pause later (card T02b fix)`, async () => {
    const script: Record<string, unknown> = {};
    const w = await openWorld(backend, script);
    try {
      const items = Array.from({ length: 50 }, (_, i) => ({ attemptId: `att-${i}`, callId: `call-${i}`, taskId: "tsk-1", agentId: "agt-1" }));
      const api = { handle: async (token: string, raw: unknown) => ((raw as { op?: string }).op === "catalog.running" ? { ok: true, result: { items, total: 120 } } : w.api.handle(token, raw as never)) };
      const text = "revoke a_x.slow 1.0.0 because it is bad";
      script[text] = [{ kind: "command", op: "catalog.revoke", args: { name: "a_x.slow", version: "1.0.0", reason: "it is bad" }, evidence: text, basis: "owner" }];
      const chat = w.chat({ api: api as never });
      const asked = await chat.submit(w.ownerToken, { messageId: "m1", text });
      const question = String(asked.outcomes[0]!.message ?? (asked.outcomes[0] as { question?: string }).question);
      assert.match(question, /120 running calls/);
      const said = "revoke a_x.slow 1.0.0 because it is bad, let the running calls finish";
      script[said] = [{ kind: "command", op: "catalog.revoke", args: { name: "a_x.slow", version: "1.0.0", reason: "it is bad", runningCalls: "finish" }, evidence: said, basis: "owner" }];
      const proposed = await chat.submit(w.ownerToken, { messageId: "m2", text: said });
      const preview = (proposed.outcomes[0]!.preview ?? []).join("\n");
      assert.match(preview, /120 running calls/);
      assert.match(preview, /cannot be changed to cancel or pause later/);
      assert.match(preview, /including calls that start before you accept/);
    } finally { await w.close(); }
  });
}

for (const backend of backends) {
  test(`${backend.name}: T02d close-out review: when calls in other controller processes could not be checked and none runs here, the owner is still asked, and is not told that no call is running`, async () => {
    const script: Record<string, unknown> = {};
    const w = await openWorld(backend, script);
    try {
      const api = { handle: async (token: string, raw: unknown) => ((raw as { op?: string }).op === "catalog.running" ? { ok: true, result: { items: [], total: 0, elsewhereUnknown: true } } : w.api.handle(token, raw as never)) };
      const text = "revoke a_x.slow 1.0.0 because it is bad";
      script[text] = [{ kind: "command", op: "catalog.revoke", args: { name: "a_x.slow", version: "1.0.0", reason: "it is bad" }, evidence: text, basis: "owner" }];
      const chat = w.chat({ api: api as never });
      const asked = await chat.submit(w.ownerToken, { messageId: "m1", text });
      const outcome = asked.outcomes[0] as { status?: string; question?: string; options?: readonly string[] };
      assert.equal(outcome.status, "asked", "the owner is asked, so a choice is recorded for calls that may run elsewhere");
      assert.match(String(outcome.question), /No call is running in this controller process, but calls running in another controller process on this store could not be checked/);
      assert.match(String(outcome.question), /If any run there, should they finish, be cancelled/);
      assert.deepEqual((outcome.options ?? []).map((o) => o.split(":")[0]), ["finish", "cancel", "pause"]);
      assert.doesNotMatch(String(outcome.question), /No call is running now/);
      // Said in the owner's own words, the choice is taken and the preview still says the other processes were not checked.
      const said = "revoke a_x.slow 1.0.0 because it is bad, cancel the running calls";
      script[said] = [{ kind: "command", op: "catalog.revoke", args: { name: "a_x.slow", version: "1.0.0", reason: "it is bad", runningCalls: "cancel" }, evidence: said, basis: "owner" }];
      const proposed = await chat.submit(w.ownerToken, { messageId: "m2", text: said });
      const preview = (proposed.outcomes[0]!.preview ?? []).join("\n");
      assert.match(preview, /could not be checked just now/);
      assert.doesNotMatch(preview, /No call is running now/);
    } finally { await w.close(); }
  });
}

test("why a retention command is shown first says what it does: a preview deletes nothing, a real run deletes, settings decide what may be deleted (card T02c review)", () => {
  const ctx = { profile: "balanced", said: true, quoted: false };
  assert.match(String(proposalReason("retention.run", {}, false, ctx)), /only previews .* deletes nothing/);
  assert.match(String(proposalReason("retention.run", { dryRun: false }, false, ctx)), /real retention run deletes what the rules expire/);
  assert.match(String(proposalReason("retention.settings.set", { derivedDays: 30 }, false, ctx)), /decide what may be deleted/);
  assert.match(String(proposalReason("retention.delete", { recordId: "x" }, false, ctx)), /deleting, archiving or restoring/);
  for (const op of ["retention.run", "retention.settings.set", "retention.delete"]) assert.doesNotMatch(String(proposalReason(op, {}, false, ctx)), /role's capabilities/);
});

test("why a tool-catalogue change is shown first says what it is: a revoke, with the calls it would reach, or the standing policy for running calls (card T02c review)", () => {
  const ctx = { profile: "balanced", said: true, quoted: false };
  assert.match(String(proposalReason("catalog.revoke", { name: "a_x.slow", version: "1.0.0", reason: "bad" }, false, ctx)), /withdrawing a tool version is shown first, with the calls it would reach/);
  const policy = String(proposalReason("catalog.policy.change", { runningCalls: "pause" }, false, ctx));
  assert.equal(policy, "what happens to running tool calls when a version is revoked is shown first");
  assert.doesNotMatch(policy, /withdrawing/);
});
