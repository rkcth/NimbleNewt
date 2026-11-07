import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { RETENTION_FIELDS } from "../retention/index.js";
import { CHAT_OPS, acceptedArgs } from "./index.js";
import { cid, openWorld } from "./testing/harness.js";

after(stopServer);
const cmd = (op: string, args: Record<string, unknown>, evidence: string) => ({ kind: "command", op, args, evidence, basis: "owner" });

for (const backend of backends) {
  test(`${backend.name}: the owner changes any retention value by chat: shown first, the revision is read for them, applied once, confirmed back with the old and new value; an agent cannot (card K06)`, async () => {
    for (const op of ["retention.settings.set", "retention.run", "retention.delete", "retention.archive", "retention.restore"]) assert.equal(CHAT_OPS[op]?.mode, "propose", `${op} is shown first`);
    // Every retention value, taken from the settings definition so a new one cannot be forgotten, can be named in chat (and is therefore in the arguments the model is told).
    for (const k of [...Object.keys(RETENTION_FIELDS), "expectedRevision"]) assert.ok(acceptedArgs("retention.settings.set")!.includes(k), k);
    assert.equal(CHAT_OPS["retention.settings.get"], undefined, "reading is a query, not a chat command");
    let revision = 4; let derivedDays: number | null = null;
    const calls: Record<string, unknown>[] = [];
    const stub = {
      get: async () => ({ revision, settings: {}, defaults: {}, effective: { derivedDays } }),
      set: async (_p: unknown, c: Record<string, unknown>) => { calls.push(c); assert.equal(c["expectedRevision"], revision, "the chat read the revision"); const old = derivedDays; derivedDays = c["derivedDays"] as number | null; revision++; return { revision, changed: [{ field: "derivedDays", old, new: derivedDays }], summary: `Retention changed: derivedDays ${old ?? "none"} -> ${derivedDays ?? "none"}.` }; },
    };
    const script: Record<string, unknown> = {};
    const w = await openWorld(backend, script, undefined, { retentionSettings: stub as never });
    try {
      const chat = w.chat();
      script["keep derived summaries 90 days"] = [cmd("retention.settings.set", { derivedDays: 90 }, "keep derived summaries 90 days")];
      const r = await chat.submit(w.ownerToken, { messageId: cid("m"), text: "keep derived summaries 90 days" });
      assert.equal(r.outcomes[0]!.status, "proposed");
      assert.equal(calls.length, 0, "nothing is changed until the owner says so");
      const applied = await chat.applyProposal(w.ownerToken, { commandId: cid("a"), proposalId: r.outcomes[0]!.proposalId! });
      assert.equal(applied.applied, true);
      assert.deepEqual(calls.map((c) => c["derivedDays"]), [90]);
      assert.match(JSON.stringify(applied.results[0]), /derivedDays none -> 90/, "confirmed back with the old and new value");
      const again = await chat.applyProposal(w.ownerToken, { commandId: cid("a"), proposalId: r.outcomes[0]!.proposalId! });
      assert.equal(again.replayed, true); assert.equal(calls.length, 1, "applied once");
      const ann = await w.agent("ann", [{ action: "*", project: "*" }]);
      await assert.rejects(chat.submit(ann.token, { messageId: cid("n"), text: "keep derived summaries 90 days" }), (e: unknown) => (e as { code?: string }).code === "forbidden");
    } finally { await w.close(); }
  });
}
