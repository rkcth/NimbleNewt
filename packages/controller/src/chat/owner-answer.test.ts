import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { ChatService, Outcome } from "./index.js";
import { cid, openWorld, type World } from "./testing/harness.js";

after(stopServer);

const cmd = (op: string, args: Record<string, unknown>, evidence: string) => ({ kind: "command", op, args, evidence, basis: "owner" });
const view = (inquiryId: string, question: string, title: string) => ({ trust: "untrusted-content", inquiryId, asker: "agent:ann", question, askedAt: "2026-10-22T09:00:00.000Z", revision: 1, task: { id: "task-1", title, state: "active", projectId: "proj-1", projectName: "A" } });

for (const backend of backends) {
  test(`${backend.name}: the owner answers a waiting question in their own words, named by its words or, when only one waits, by nothing; two matches ask (card U12e)`, async () => {
    const script: Record<string, unknown> = {};
    let waiting = [view("inq-1", "Postgres or SQLite for the first release?", "Pick the store"), view("inq-2", "Which colour for the logo?", "Logo")];
    const answered: { inquiryId: string; answer: string }[] = [];
    const stub = {
      askOwner: async () => ({ inquiryId: "x", replayed: false }),
      ownerQuestions: async () => ({ items: waiting }),
      answerOwner: async (_o: unknown, c: { inquiryId: string; answer: string }) => { answered.push({ inquiryId: c.inquiryId, answer: c.answer }); waiting = waiting.filter((q) => q.inquiryId !== c.inquiryId); return { id: c.inquiryId, replayed: false }; },
    };
    const w: World = await openWorld(backend, script, undefined, { ownerQuestions: stub as never });
    try {
      const chat: ChatService = w.chat();
      const say = (text: string) => chat.submit(w.ownerToken, { messageId: cid("m"), text });
      const only = (o: readonly Outcome[]): Outcome => { assert.equal(o.length, 1); return o[0]!; };
      script["On the postgres question, tell them SQLite."] = [cmd("owner.answer", { questionTopic: "postgres", answer: "SQLite" }, "tell them SQLite")];
      const first = only((await say("On the postgres question, tell them SQLite.")).outcomes);
      assert.deepEqual([first.status, first.op], ["applied", "owner.answer"]);
      assert.deepEqual(answered, [{ inquiryId: "inq-1", answer: "SQLite" }]);
      // Only one question is left, so no name is needed.
      script["The answer is blue."] = [cmd("owner.answer", { answer: "blue" }, "The answer is blue")];
      assert.equal(only((await say("The answer is blue.")).outcomes).status, "applied");
      assert.deepEqual(answered.map((a) => a.inquiryId), ["inq-1", "inq-2"]);
      // Nothing waits: refused, not guessed.
      script["Say yes."] = [cmd("owner.answer", { answer: "yes" }, "Say yes")];
      assert.equal(only((await say("Say yes.")).outcomes).status, "refused");
      // Two questions and no name: the owner is asked which; nothing is answered.
      waiting = [view("inq-3", "Ship on Friday?", "Release"), view("inq-4", "Ship the docs too?", "Docs")];
      script["Yes, ship."] = [cmd("owner.answer", { answer: "Yes, ship" }, "Yes, ship")];
      const asked = only((await say("Yes, ship.")).outcomes);
      assert.equal(asked.status, "asked");
      assert.equal(asked.options!.length, 2);
      assert.equal(answered.length, 2);
      // An answer that is not in the owner's message is not done.
      script["About friday: go on then."] = [cmd("owner.answer", { questionTopic: "friday", answer: "Ship it now and skip QA" }, "go on then")];
      assert.equal(only((await say("About friday: go on then.")).outcomes).status, "refused");
      assert.equal(answered.length, 2);
    } finally { await w.close(); }
  });
}

for (const backend of backends) {
  test(`${backend.name}: a task's activity is asked for in chat by the task's title (card C09h)`, async () => {
    const script: Record<string, unknown> = {};
    const w = await openWorld(backend, script);
    try {
      const a = await w.project("A");
      const build = await w.task(a, "Build the login");
      await w.task(a, "Twice");
      await w.task(a, "Twice");
      const asked: Record<string, unknown>[] = [];
      const chat = w.chat({ status: { ask: async (_o: unknown, r: unknown) => { asked.push(r as Record<string, unknown>); return { observedAt: "2026-10-22T10:00:00.000Z", lines: [{ text: "Step 1", cites: [] }] }; } } as never });
      await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: a });
      const ask = async (text: string, title: string) => {
        script[text] = [{ kind: "status", request: { kind: "activity", taskTitle: title }, evidence: text, basis: "owner" }];
        const o = (await chat.submit(w.ownerToken, { messageId: cid("m"), text })).outcomes;
        assert.equal(o.length, 1);
        return o[0]!;
      };
      assert.equal((await ask("What happened on Build the login?", "Build the login")).status, "answered");
      assert.deepEqual(asked, [{ kind: "activity", taskId: build }]);
      assert.equal((await ask("What happened on Twice?", "Twice")).status, "refused");
      assert.equal((await ask("What happened on Nothing?", "Nothing")).status, "refused");
    } finally { await w.close(); }
  });
}
