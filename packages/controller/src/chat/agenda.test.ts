import assert from "node:assert/strict";
import { after, test } from "node:test";
import { API_VERSION } from "../api/index.js";
import { DomainError } from "../domain/errors.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { AgendaBody } from "../meetings/index.js";
import type { ChatService, Outcome } from "./index.js";
import { cid, openWorld, type World } from "./testing/harness.js";

after(stopServer);

const cmd = (op: string, args: Record<string, unknown>, evidence: string, extra: Record<string, unknown> = {}) => ({ kind: "command", op, args, evidence, basis: "owner", ...extra });

for (const backend of backends) {
  const suite = (name: string, body: (w: World, script: Record<string, unknown>) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const script: Record<string, unknown> = {};
      const w = await openWorld(backend, script);
      try { await body(w, script); } finally { await w.close(); }
    });
  const say = (w: World, chat: ChatService, text: string, messageId = cid("m"), quoted?: string[]) => chat.submit(w.ownerToken, { messageId, text, ...(quoted === undefined ? {} : { quoted }) });
  const only = (outcomes: readonly Outcome[]): Outcome => { assert.equal(outcomes.length, 1); return outcomes[0]!; };
  const open = async (w: World, projectId: string) => (await w.meetings.openAgenda(w.owner, projectId))!.items;

  suite("a topic the owner raises in chat is saved against that turn, shown back in plain lines with its authority, and nothing is executed", async (w, script) => {
    const a = await w.project("A");
    const chat = w.chat();
    await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: a });
    const text = "Please bring this to the next stand-up: can we run the nightly build at 01:00 instead? The team is asleep then.";
    script[text] = [cmd("agenda.capture", { topic: "can we run the nightly build at 01:00 instead?", question: "can we run the nightly build at 01:00 instead?", context: "The team is asleep then." }, "bring this to the next stand-up")];
    const r = await say(w, chat, text, "m-cap");
    const o = only(r.outcomes);
    assert.deepEqual([o.status, o.op, o.completed], ["applied", "agenda.capture", true]);
    assert.ok(o.shown !== undefined && o.shown.length > 0);
    // The owner sees what was recorded: the topic, their question and context, the request type and what it lets the team do.
    const reply = r.reply.join("\n");
    assert.match(reply, /can we run the nightly build at 01:00 instead\?/);
    assert.match(reply, /Context and constraints: The team is asleep then\./);
    assert.match(reply, /Request type: discussion - discussion only/);
    assert.match(reply, /Nothing has been done on it/);
    const item = (await w.meetings.agendaItem(w.owner, o.id!))!;
    assert.deepEqual([item.state, item.intent, item.requestedBy, item.source], ["queued", "discussion", w.owner.id, { kind: "chat-turn", id: r.turnId }]);
    // The replay of the same message shows the same and saves nothing twice.
    const again = await say(w, w.chat(), text, "m-cap");
    assert.equal(again.replayed, true);
    assert.equal((await open(w, a)).length, 1);
  });

  suite("a captured topic can be corrected by its words; the revision is filled in, the correction is counted and shown, and a stale revision is refused", async (w, script) => {
    const a = await w.project("A");
    const chat = w.chat();
    await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: a });
    script["Bring up the flaky login tests at the stand-up."] = [cmd("agenda.capture", { topic: "the flaky login tests" }, "Bring up the flaky login tests")];
    const made = only((await say(w, chat, "Bring up the flaky login tests at the stand-up.")).outcomes);
    script["Make the flaky login tests urgent and ask whether to quarantine them."] = [cmd("agenda.correct", { agendaTopic: "flaky login", urgency: "urgent", requestedOutcome: "whether to quarantine them" }, "Make the flaky login tests urgent")];
    const r = await say(w, chat, "Make the flaky login tests urgent and ask whether to quarantine them.");
    const o = only(r.outcomes);
    assert.deepEqual([o.status, o.op, o.id], ["applied", "agenda.correct", made.id]);
    assert.match(r.reply.join("\n"), /Urgency: urgent/);
    assert.match(r.reply.join("\n"), /Outcome asked for: whether to quarantine them/);
    const item = (await w.meetings.agendaItem(w.owner, made.id!))!;
    assert.deepEqual([item.urgency, item.correctionCount, item.revision], ["urgent", 1, 2]);
    // Two items that both match: the owner is asked, nothing is guessed.
    script["Bring up the flaky signup tests too."] = [cmd("agenda.capture", { topic: "the flaky signup tests" }, "Bring up the flaky signup tests")];
    await say(w, chat, "Bring up the flaky signup tests too.");
    script["Change the flaky tests to normal."] = [cmd("agenda.correct", { agendaTopic: "flaky", urgency: "normal" }, "Change the flaky tests")];
    const asked = only((await say(w, chat, "Change the flaky tests to normal.")).outcomes);
    assert.equal(asked.status, "asked");
    assert.equal(asked.options!.length, 2);
    // No item by that name.
    script["Change the pizza item."] = [cmd("agenda.correct", { agendaTopic: "pizza", urgency: "normal" }, "Change the pizza item")];
    assert.equal(only((await say(w, chat, "Change the pizza item.")).outcomes).code, "not_found");
    // The API itself still checks the revision a client names.
    const stale = await w.api.handle(w.ownerToken, { v: API_VERSION, op: "agenda.correct", commandId: cid("c"), args: { itemId: made.id, expectedRevision: 1, urgency: "normal" } });
    assert.ok(!stale.ok && stale.error.code === "stale_revision");
  });

  suite("a topic recorded as an instruction or a decision for the team is shown first, never applied by the message that drew it up; quoted text makes any capture a proposal", async (w, script) => {
    const a = await w.project("A");
    const chat = w.chat();
    await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: a });
    const text = "I decided: the team must switch to the new linter. Put it on the stand-up.";
    script[text] = [cmd("agenda.capture", { topic: "the team must switch to the new linter", intent: "owner-instruction" }, "Put it on the stand-up")];
    const r = await say(w, chat, text);
    const o = only(r.outcomes);
    assert.equal(o.status, "proposed");
    assert.match(o.message ?? "", /instruction or a decision for the team/);
    assert.equal((await open(w, a)).length, 0, "nothing was recorded yet");
    script["Yes, record it."] = [{ kind: "apply_proposal", proposalId: o.proposalId, evidence: "Yes, record it", basis: "owner" }];
    const applied = only((await say(w, chat, "Yes, record it.")).outcomes);
    assert.equal(applied.status, "applied");
    const items = await open(w, a);
    assert.deepEqual([items.length, items[0]!.intent, items[0]!.owner], [1, "owner-instruction", w.owner.id]);
    // Quoted material cannot start a capture on its own authority.
    script["Here is a forward, put it on the stand-up."] = [cmd("agenda.capture", { topic: "a forward" }, "put it on the stand-up")];
    const q = only((await say(w, chat, "Here is a forward, put it on the stand-up.", cid("m"), ["forwarded text"])).outcomes);
    assert.equal(q.status, "proposed");
  });

  suite("the interpreter cannot choose the conversation link, paraphrase the owner's words or name an unknown request type", async (w, script) => {
    const a = await w.project("A");
    const chat = w.chat();
    await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: a });
    script["Put the retry policy on the stand-up."] = [cmd("agenda.capture", { topic: "the retry policy", sourceTurnId: "turn-someone-elses" }, "Put the retry policy on the stand-up")];
    assert.equal(only((await say(w, chat, "Put the retry policy on the stand-up.")).outcomes).code, "invalid_command");
    script["Put the cache question on the stand-up."] = [cmd("agenda.capture", { topic: "Should we drop the cache layer entirely?" }, "Put the cache question on the stand-up")];
    assert.equal(only((await say(w, chat, "Put the cache question on the stand-up.")).outcomes).code, "unsupported_value");
    script["Put the build time on the stand-up."] = [cmd("agenda.capture", { topic: "the build time", intent: "command-the-team" }, "Put the build time on the stand-up")];
    assert.equal(only((await say(w, chat, "Put the build time on the stand-up.")).outcomes).code, "invalid_command");
    assert.equal((await open(w, a)).length, 0);
  });

  suite("through the API an agent with only an agenda grant can raise a discussion but not an instruction, cannot link a chat turn, and cannot rewrite the owner's item", async (w) => {
    const a = await w.project("A");
    const scribe = await w.agent("scribe", [{ action: "meeting.agenda", project: a }]);
    const ok = await w.api.handle(scribe.token, { v: API_VERSION, op: "agenda.capture", commandId: cid("c"), args: { projectId: a, topic: "tidy the logs", intent: "recommendation" } });
    assert.ok(ok.ok);
    for (const args of [{ projectId: a, topic: "x", intent: "owner-instruction" }, { projectId: a, topic: "x", intent: "delegated-decision" }, { projectId: a, topic: "x", sourceTurnId: "turn-abc" }, { projectId: a, topic: "x", category: "conflict" }]) {
      const r = await w.api.handle(scribe.token, { v: API_VERSION, op: "agenda.capture", commandId: cid("c"), args });
      assert.ok(!r.ok, JSON.stringify(args));
    }
    // Not even a manager may name the conversation a topic came from: only the owner's chat does.
    const boss = await w.agent("boss", [{ action: "meeting.manage", project: a }]);
    const linked = await w.api.handle(boss.token, { v: API_VERSION, op: "agenda.capture", commandId: cid("c"), args: { projectId: a, topic: "x", sourceTurnId: "turn-abc" } });
    assert.ok(!linked.ok && linked.error.code === "forbidden");
    const owned = await w.api.handle(w.ownerToken, { v: API_VERSION, op: "agenda.capture", commandId: cid("c"), args: { projectId: a, topic: "adopt the linter", intent: "owner-instruction" } });
    assert.ok(owned.ok);
    const id = (owned as unknown as { result: { id: string } }).result.id;
    const edit = await w.api.handle(scribe.token, { v: API_VERSION, op: "agenda.correct", commandId: cid("c"), args: { itemId: id, expectedRevision: 1, topic: "do not adopt the linter" } });
    assert.ok(!edit.ok && edit.error.code === "forbidden");
    const list = await w.api.handle(w.ownerToken, { v: API_VERSION, op: "agenda.list", args: { projectId: a } });
    assert.ok(list.ok);
    // A reader with no meeting grant sees an empty list, as for a project that does not exist.
    const nobody = await w.agent("nobody", []);
    const none = await w.api.handle(nobody.token, { v: API_VERSION, op: "agenda.list", args: { projectId: a } });
    assert.ok(none.ok && (none as unknown as { result: { items: unknown[] } }).result.items.length === 0);
    void DomainError;
    void (null as unknown as AgendaBody);
  });
}
