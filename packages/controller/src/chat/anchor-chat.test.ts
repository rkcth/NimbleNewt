import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ContextRouteSettingsService } from "../context/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { CHAT_OPS, acceptedArgs } from "./index.js";
import { cid, openWorld, options } from "./testing/harness.js";

after(stopServer);
const cmd = (op: string, args: Record<string, unknown>, evidence: string) => ({ kind: "command", op, args, evidence, basis: "owner" });

/**
 * Card W12 in chat: the owner switches the goal anchor off and on and sets its size cap in free words. No set phrase is needed: the interpreter maps the owner's words to `context.route.change`, whose chat entry names the
 * anchor in its verb and whose arguments are listed for the interpreter. The change is shown first (mode `propose`) and applied only when the owner says yes.
 */
for (const backend of backends) {
  test(`${backend.name}: the owner turns the goal anchor off and sets its cap in free words; the change is shown first and applied only on yes; a cap out of bounds is refused (W12)`, async () => {
    assert.equal(CHAT_OPS["context.route.change"]?.mode, "propose", "shown first");
    assert.match(CHAT_OPS["context.route.change"]!.verb, /goal anchor/);
    for (const k of ["enable", "disable", "set", "unset", "expectedRevision"]) assert.ok(acceptedArgs("context.route.change")!.includes(k), k);
    let settings: ContextRouteSettingsService | undefined;
    const script: Record<string, unknown> = {};
    const w = await openWorld(backend, script, undefined, (storage, epoch) => { settings = ContextRouteSettingsService.withEpoch(storage, epoch, options); return { contextRouteSettings: settings }; });
    try {
      const a = await w.project("A");
      const chat = w.chat();
      await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: a });
      assert.equal((await settings!.effective()).anchor, true);

      const off = "stop reminding the agents of their goal every time their memory is cut";
      script[off] = [cmd("context.route.change", { disable: ["anchor"] }, off)];
      const shown = (await chat.submit(w.ownerToken, { messageId: "m-1", text: off })).outcomes[0]!;
      assert.equal(shown.status, "proposed", JSON.stringify(shown));
      assert.equal((await settings!.effective()).anchor, true, "shown first: nothing changed yet");
      assert.match(JSON.stringify(shown), /anchor/);
      const yes = "yes, do it";
      script[yes] = [{ kind: "apply_proposal", proposalId: shown.proposalId, evidence: yes, basis: "owner" }];
      const done = (await chat.submit(w.ownerToken, { messageId: "m-2", text: yes })).outcomes[0]!;
      assert.equal(done.status, "applied", JSON.stringify(done));
      assert.equal((await settings!.effective()).anchor, false);

      const cap = "turn the goal reminder back on, and let it use at most 1500 characters";
      script[cap] = [cmd("context.route.change", { enable: ["anchor"], set: { anchorChars: 1500 } }, cap)];
      const proposed = (await chat.submit(w.ownerToken, { messageId: "m-3", text: cap })).outcomes[0]!;
      assert.equal(proposed.status, "proposed", JSON.stringify(proposed));
      script[yes] = [{ kind: "apply_proposal", proposalId: proposed.proposalId, evidence: yes, basis: "owner" }];
      assert.equal((await chat.submit(w.ownerToken, { messageId: "m-4", text: yes })).outcomes[0]!.status, "applied");
      assert.deepEqual([(await settings!.effective()).anchor, (await settings!.effective()).anchorChars], [true, 1500]);

      const bad = "let the reminder use 50 characters";
      script[bad] = [cmd("context.route.change", { set: { anchorChars: 50 } }, bad)];
      const refused = (await chat.submit(w.ownerToken, { messageId: "m-5", text: bad })).outcomes[0]!;
      if (refused.status === "proposed") {
        script[yes] = [{ kind: "apply_proposal", proposalId: refused.proposalId, evidence: yes, basis: "owner" }];
        assert.notEqual((await chat.submit(w.ownerToken, { messageId: "m-6", text: yes })).outcomes[0]!.status, "applied");
      } else assert.notEqual(refused.status, "applied");
      assert.equal((await settings!.effective()).anchorChars, 1500);
    } finally { await w.close(); }
  });
}
