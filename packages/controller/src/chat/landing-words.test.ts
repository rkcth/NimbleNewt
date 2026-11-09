import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { cid, openWorld } from "./testing/harness.js";

after(stopServer);

type Reply = { ok: boolean; result?: any; error?: { code: string; message?: string } };

/**
 * Landing finished work on main with no human step is only set when the owner's own message says so (card P08b), and the negation that says it must not be read is the one the owner's phone types: the
 * shared word check normalises ’ ‘ ʼ before it looks for "don't", "won't", "can't" and "isn't" (third review, D1). Everything here runs on the real ChatService over the same storage the chat turns on.
 */
for (const backend of backends) {
  test(`${backend.name}: "don’t send it straight to main" is refused in chat exactly like "don't send it straight to main" (card P08b, third review D1)`, async () => {
    const script: Record<string, unknown[]> = {};
    const w = await openWorld(backend, script);
    try {
      const chat = w.chat({});
      const turn = async (id: string, text: string, intents: unknown[]) => { script[text] = intents; return (await chat.submit(w.ownerToken, { messageId: id, text })).outcomes; };
      const project = await w.project("widgets");
      const call = (op: string, args: Record<string, unknown>): Promise<Reply> => w.api.handle(w.ownerToken, { v: 1, op, commandId: cid("x"), args } as never) as never;

      // The owner says the opposite of the order the interpreter sent, with the apostrophe a phone types.
      const denied: ReadonlyArray<readonly [string, string]> = [["a1", "don’t send it straight to main"], ["a2", "don't send it straight to main"], ["a3", "we won’t land finished work on main automatically"], ["a4", "it isn’t automatic to main"]];
      for (const [id, text] of denied) {
        const shown = await turn(id, text, [{ kind: "command", op: "integration.set", args: { project, landing: "main-automatic" }, evidence: text, basis: "owner" }]);
        assert.equal(shown[0]!.status, "refused", `"${text}" sets nothing: ${JSON.stringify(shown[0])}`);
        assert.equal(shown[0]!.code, "unsupported_value", JSON.stringify(shown[0]));
        assert.match(shown[0]!.message!, /no human step/i, `"${text}" is refused by the words check: ${JSON.stringify(shown[0])}`);
      }

      // Where the owner's own words do say it, the words check is not what stops the order.
      const said = "land finished work on main automatically";
      const shown = await turn("a5", said, [{ kind: "command", op: "integration.set", args: { project, landing: "main-automatic" }, evidence: said, basis: "owner" }]);
      const message = `${shown[0]!.status} ${shown[0]!.message ?? ""}`;
      assert.doesNotMatch(message, /is only set when your own message says so/, `the owner's own order passes the words check: ${message}`);
    } finally { await w.close(); }
  });
}
