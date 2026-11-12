import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ContextRouteSettingsService } from "../context/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { OPERATIONS } from "../api/operations.js";
import { CHAT_OPS, acceptedArgs } from "./index.js";
import { ModelInterpreter } from "./model-interpreter.js";
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
    // Card C07 wording check: the owner who is asked whether to turn the anchor off or on is told that the summary after a cut is a plain extract written without a model.
    assert.match(CHAT_OPS["context.route.change"]!.verb, /plain extract of the start and the end of what was cut, written without a model/);
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

/**
 * Card W13 in chat: the owner turns the agents' memory tool task.recall off and on and sets how many times an attempt may use it, in free words. The chat command is shown first; the interpreter prompt (made from the one operation
 * table) names the tool, and the operation's own text describes the switch and the figure.
 */
test("the interpreter prompt tells the model about task.recall and its two settings from the one operation table (W13)", async () => {
  let system = "";
  const m = new ModelInterpreter({ complete: async (_route, r) => { system = r.system; return "[]"; } }, () => ["a/primary"]);
  await m.interpret({ text: "hello", quoted: [], focus: {}, proposals: [] });
  assert.equal(CHAT_OPS["context.route.change"]?.mode, "propose", "shown first");
  assert.match(system, /task\.recall/);
  assert.match(system, /how many times an attempt may use it/);
  const op = OPERATIONS.find((o) => o.name === "context.route.change")!;
  for (const word of ["`recall`", "`recallCalls`", "1 to 100"]) assert.ok(op.summary.includes(word), word);
  assert.ok(String(op.args["enable?"]).includes("recall") && String(op.args["set?"]).includes("recallCalls"));
});

for (const backend of backends) {
  test(`${backend.name}: the owner turns the agents' memory tool off and sets its calls in free words; shown first, applied only on yes; a figure out of bounds is not applied (W13)`, async () => {
    let settings: ContextRouteSettingsService | undefined;
    const script: Record<string, unknown> = {};
    const w = await openWorld(backend, script, undefined, (storage, epoch) => { settings = ContextRouteSettingsService.withEpoch(storage, epoch, options); return { contextRouteSettings: settings }; });
    try {
      const a = await w.project("A");
      const chat = w.chat();
      await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: a });
      assert.deepEqual([(await settings!.effective()).recall, (await settings!.effective()).recallCalls], [true, 20]);
      const yes = "yes, do it";
      const off = "do not let the agents read their own task records back after their memory is cut";
      script[off] = [cmd("context.route.change", { disable: ["recall"] }, off)];
      const shown = (await chat.submit(w.ownerToken, { messageId: "r-1", text: off })).outcomes[0]!;
      assert.equal(shown.status, "proposed", JSON.stringify(shown));
      assert.equal((await settings!.effective()).recall, true, "shown first: nothing changed yet");
      assert.match(JSON.stringify(shown), /recall/);
      script[yes] = [{ kind: "apply_proposal", proposalId: shown.proposalId, evidence: yes, basis: "owner" }];
      assert.equal((await chat.submit(w.ownerToken, { messageId: "r-2", text: yes })).outcomes[0]!.status, "applied");
      assert.equal((await settings!.effective()).recall, false);

      const cap = "let the agents read their records back again, but at most 5 times in an attempt";
      script[cap] = [cmd("context.route.change", { enable: ["recall"], set: { recallCalls: 5 } }, cap)];
      const proposed = (await chat.submit(w.ownerToken, { messageId: "r-3", text: cap })).outcomes[0]!;
      assert.equal(proposed.status, "proposed", JSON.stringify(proposed));
      script[yes] = [{ kind: "apply_proposal", proposalId: proposed.proposalId, evidence: yes, basis: "owner" }];
      assert.equal((await chat.submit(w.ownerToken, { messageId: "r-4", text: yes })).outcomes[0]!.status, "applied");
      assert.deepEqual([(await settings!.effective()).recall, (await settings!.effective()).recallCalls], [true, 5]);

      const bad = "let them read their records back 500 times";
      script[bad] = [cmd("context.route.change", { set: { recallCalls: 500 } }, bad)];
      const refused = (await chat.submit(w.ownerToken, { messageId: "r-5", text: bad })).outcomes[0]!;
      if (refused.status === "proposed") {
        script[yes] = [{ kind: "apply_proposal", proposalId: refused.proposalId, evidence: yes, basis: "owner" }];
        assert.notEqual((await chat.submit(w.ownerToken, { messageId: "r-6", text: yes })).outcomes[0]!.status, "applied");
      } else assert.notEqual(refused.status, "applied");
      assert.equal((await settings!.effective()).recallCalls, 5);
    } finally { await w.close(); }
  });
}
