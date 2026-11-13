import assert from "node:assert/strict";
import { test } from "node:test";
import { runTerminalChat } from "./terminal-chat.js";

// Card U14d: the terminal chat says what the next open required setup step is, once per step, never while something waits for the owner's yes, and says nothing when the setup view cannot be read.
type Item = { id: string; guide: { question: string; recommended: string } };
const items: Item[] = ["project", "host", "agent"].map((id) => ({ id, guide: { question: `QUESTION-${id}?`, recommended: `SUGGEST-${id}` } }));

function world(sequence: (string | undefined | "broken")[], statuses: string[][]) {
  let readCount = 0;
  let turn = 0;
  const controller = {
    api: { handle: async () => {
      const next = sequence[Math.min(readCount++, sequence.length - 1)];
      if (next === "broken") throw new Error("the view is down");
      return { ok: true, result: { item: { ready: next === undefined, ...(next === undefined ? {} : { next }), items } } };
    } },
    chat: { submit: async () => ({ reply: ["ok."], outcomes: (statuses[turn++] ?? []).map((status) => ({ status })) }) },
  };
  return controller as never;
}
async function* lines(...items: string[]): AsyncGenerator<string> { for (const i of items) yield i; }
const run = async (controller: never, ...input: string[]): Promise<string> => { const out: string[] = []; await runTerminalChat({ controller, ownerToken: "t", input: lines(...input), write: (t) => out.push(t) }); return out.join(""); };

test("the next open step is said once when it changes, with the suggested answer", async () => {
  // Reads: at start (project open), after message 1 (host open), after message 2 (host still open), after message 3 (agent open).
  const said = await run(world(["project", "host", "host", "agent"], [["applied"], ["applied"], ["applied"]]), "one", "two", "three");
  assert.equal(said.match(/Next step in the setup/g)?.length, 2, said);
  assert.match(said, /QUESTION-host\?\nSuggested: SUGGEST-host/);
  assert.match(said, /QUESTION-agent\?\nSuggested: SUGGEST-agent/);
  assert.ok(said.indexOf("QUESTION-host") < said.indexOf("QUESTION-agent"));
});

test("nothing is pushed while a proposal or a question waits for the owner, and it is said when the answer is given", async () => {
  const said = await run(world(["project", "host", "host"], [["proposed"], ["applied"]]), "make a project", "yes");
  assert.equal(said.match(/Next step in the setup/g)?.length, 1, said);
  assert.ok(said.indexOf("QUESTION-host") > said.indexOf("ok."), "said after the answer, once");
  const asked = await run(world(["project", "host"], [["asked"]]), "something");
  assert.doesNotMatch(asked, /Next step/);
});

test("the last required step done is told once; an unreadable view says nothing and does not stop the chat", async () => {
  const done = await run(world(["agent", undefined, undefined], [["applied"], ["applied"]]), "add the agent", "and again");
  assert.equal(done.match(/last required step/g)?.length, 1, done);
  assert.doesNotMatch(done, /Next step in the setup/);
  const broken = await run(world(["project", "broken", "broken"], [["applied"], ["applied"]]), "a", "b");
  assert.doesNotMatch(broken, /Next step|last required/);
  assert.equal(broken.match(/ok\./g)?.length, 2, "both messages were answered");
  const blind = await run(world(["broken"], [["applied"]]), "a");
  assert.doesNotMatch(blind, /Next step|last required/);
});
