import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { openWorld } from "./testing/harness.js";

after(stopServer);

for (const backend of backends) {
  test(`${backend.name}: the revoke question and preview count all running calls, not only the listed ones, and say finish cannot be changed to cancel later (card T02b fix)`, async () => {
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
      assert.match(preview, /cannot be changed to cancel later/);
      assert.match(preview, /including calls that start before you accept/);
    } finally { await w.close(); }
  });
}
