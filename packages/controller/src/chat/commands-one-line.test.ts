import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { CHAT_LIMITS } from "./interpreter.js";
import { describe } from "./commands.js";
import { cid, openWorld } from "./testing/harness.js";

after(stopServer);

const cmd = (op: string, args: Record<string, unknown>, evidence: string) => [{ kind: "command", op, args, evidence, basis: "owner" }];

/**
 * What one proposal line may hold (card U03, cards U05/U09 for the same rule in status answers). The owner reads this one line before they confirm a command, so nothing a record or the interpreter
 * wrote may put a second line under it, hide characters in it, or reorder it: line breaks and separators are gone or written as escapes, C0/C1 controls and invisible format characters (bidirectional
 * overrides, zero-width characters) are written as escapes, a lone surrogate is written as an escape, and a cut never leaves half a character or half an escape behind.
 */
const BREAKS = /[\n\r\u0085\u2028\u2029]/;
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\p{Cf}]/u;
const HALVES = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;
/** Half an escape left behind by a cut: a bare backslash, `\u{...}` with no closing brace, or `\u` with fewer than its four digits, just where the `...` of a cut follows. */
const HALF_ESCAPE = /\\(?:u\{[0-9a-f]*|u[0-9a-f]{0,3})?\.\.\./;

/** One honest line, whatever it was built from. */
const oneLine = (line: string, what: string): void => {
  assert.equal(BREAKS.test(line), false, `${what} is one line: ${JSON.stringify(line)}`);
  assert.equal(HIDDEN.test(line), false, `${what} shows no raw control, separator or invisible format character: ${JSON.stringify(line)}`);
  assert.equal(HALVES.test(line), false, `${what} holds no half character: ${JSON.stringify(line)}`);
  assert.doesNotMatch(line, HALF_ESCAPE, `${what} holds no half escape: ${JSON.stringify(line)}`);
  // Nothing on these lines carried a backslash to begin with, so a doubled one could only come from escaping the same text twice.
  assert.equal(line.includes("\\\\"), false, `${what} is escaped once, not twice: ${JSON.stringify(line)}`);
};

/** A title of the kind an agent writes into a record, with everything in it that could disguise the line it is shown on. */
const TITLE = `Fix the login\u2028screen\u202e now\u200b\ud800 \u{1F600}`;

test("a label from a record cannot forge a second proposal line, whatever characters its text holds", () => {
  // Several operations, each naming its target by a record whose name an agent wrote.
  const cases: readonly [string, Record<string, unknown>, Record<string, string>][] = [
    ["task.update", { taskId: "task-1", title: "Ship the login screen" }, { "task-1": TITLE }],
    ["task.transition", { taskId: "task-1", to: "done" }, { "task-1": TITLE }],
    ["budget.raise", { taskId: "task-1", costMicros: 5_000_000 }, { "task-1": TITLE }],
    ["agent.update", { agentId: "agent-1", friendlyName: "Ann" }, { "agent-1": `Ann\u2029 the\u200b builder\u202e` }],
    ["standup.prepare", { occurrenceId: "occ-1" }, { "occ-1": `${TITLE.slice(0, 40)} (2026-11-09T09:00:00.000Z)` }],
    ["standup.add-statement", { briefId: "brief-1", statement: "the demo is at four" }, { "brief-1": `${TITLE.slice(0, 30)}'s brief` }],
    ["project.update", { projectId: "proj-1", name: `New name\u2028for it\u202e` }, { "proj-1": `Garden\u200b \u202e` }],
    ["workspace.request", { taskId: "task-1", operation: "landing", reason: `land it\u2028 now\u202e` }, { "task-1": TITLE }],
    ["grant.create", { grantee: "agent:ann", action: "approve.class.commit", project: "proj-1", basis: `as agreed\u2028\u202e`, expiresAt: `2026-12-01T00:00:00.000Z\u001b[31m` }, {}],
    ["integration.set", { project: "proj-1", landing: "main-automatic\n\u202eok" }, {}],
    // An operation the chat's own table does not know, and an argument name, are whoever called this saying a name: escaped like everything else.
    ["task.rename\u2028now", { taskId: "task-1" }, { "task-1": TITLE }],
    ["task.update", { "bad\nkey\u202e": "x", taskId: "task-1" }, { "task-1": TITLE }],
  ];
  for (const [op, args, labels] of cases) oneLine(describe(op, args, labels), `the line for ${JSON.stringify(op)}`);

  // What the owner reads is still the name they know: the words of it, with the invisible parts written out and a line separator become a space (the same fold every shown text in this product makes).
  const line = describe("task.update", { taskId: "task-1", title: "Ship the login screen" }, { "task-1": TITLE });
  assert.match(line, /^Change task: taskId="Fix the login screen\\u202e now\\u200b\\ud800 \u{1F600}"/u, line);
  assert.match(line, /, title=Ship the login screen$/, "and the value being set, unquoted as it always was");
  // A name shown between quotes cannot close them and write a field of the owner's eye's own: only the quotation's own two quotes are unescaped.
  const forged = describe("task.update", { taskId: "task-1" }, { "task-1": `done" , owner="me` });
  assert.equal((forged.match(/(?<!\\)"/g) ?? []).length, 2, `a quote in a name cannot close the quotation: ${forged}`);
});

test("the owner's alternative to a meeting decision is shown whole, quoted, and never as two lines", () => {
  const line = describe("meeting.record.owner-respond", { response: "alternative", decisionId: "mdc-1", alternative: { statement: `keep the nightly build\u2028 at midnight\u202e tonight\u200b`, topic: `nightly\u200b build\u2028 schedule` } }, { "mdc-1": `Move the build\u2028 to one\u202e; 2 changes left to carry out`, "started:mdc-1": "1" });
  oneLine(line, "the answer to a meeting decision");
  assert.match(line, /alternative="keep the nightly build at midnight\\u202e tonight\\u200b" on topic "nightly\\u200b build schedule"/, line);
  // The decision it answers is still named, and the count of what already started is a number, not the label's text.
  assert.match(line, /decisionId="Move the build to one\\u202e; 2 changes left to carry out"/, line);
  assert.ok(line.length <= 700, `the line the alternative needs room for: ${line.length}`);
  // An alternative at the length the chat accepts (150 and 80 characters) is shown whole, not cut by the quotation's own bound.
  const statement = `keep the ${"nightly ".repeat(15)}build`;
  const topic = `nightly ${"build ".repeat(10)}schedule`;
  assert.ok(statement.length <= 150 && statement.length > 120 && topic.length <= 80 && topic.length > 70, `${statement.length} ${topic.length}`);
  const full = describe("meeting.record.owner-respond", { response: "alternative", decisionId: "mdc-1", alternative: { statement, topic } }, { "mdc-1": `Move the build; 2 changes left`, "started:mdc-1": "0" });
  assert.ok(full.includes(`alternative="${statement}" on topic "${topic}"`), full);
  assert.ok(!full.endsWith("..."), full);
});

test("a long name is cut between whole characters and whole escapes, at its own bound and at the line's", () => {
  // The bound of one quoted name (the line's own room): an emoji (two UTF-16 units) and an escaped override at every place around it.
  for (let pad = 388; pad <= 412; pad++) {
    const line = describe("budget.raise", { taskId: "task-1", costMicros: 1 }, { "task-1": `${"x".repeat(pad)}\u{1F600}\u202e${"y".repeat(10)}` });
    oneLine(line, `a name cut at pad ${pad}`);
    assert.ok(line.length <= CHAT_LIMITS.line, `the line keeps to its own room at pad ${pad}: ${line.length}`);
  }
  // A label the chat built out of several fields (a maintenance request's) keeps its first words: the quotation does not hide them behind its own bound.
  const long = describe("maintenance.decide", { maintenanceId: "mnt-1", verdict: "approve", specDigest: "spec-1" }, { "spec-1": `agent:agt-1 asks: package installScripts=true digest=sha256:${"a".repeat(8)}... version=9.9.9 name=tool-with-a-quite-long-name-for-the-previous-release source=https://registry.example.org/packages/tool` });
  assert.match(long, /asks: package installScripts=true/, long);
  assert.match(long, /version=9\.9\.9/, long);
  oneLine(long, "a label built from several fields");

  // The whole line's bound, with a name on it: the emoji moves through where the line is cut.
  for (let pad = 70; pad <= 84; pad++) {
    const args = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`k${i}`, `${"x".repeat(pad)}\u{1F600}\u202e`]));
    const line = describe("task.update", { taskId: "task-1", ...args }, { "task-1": `${"t".repeat(pad)}\u{1F600}` });
    oneLine(line, `a line cut at pad ${pad}`);
    assert.ok(line.length <= CHAT_LIMITS.line, `the cut line keeps to its room at pad ${pad}: ${line.length}`);
  }

  // The line's own cut lands on every place inside an escape: a bare value's `\u{202e}` run and a quoted name's `‮` and `\"` run, slid one character at a time across the line's bound.
  for (let pad = 0; pad < 420; pad++) {
    const bare = describe("task.update", { title: "q".repeat(pad), taskId: "task-1", description: `${"y".repeat(pad % 80)}‮‮‮` }, { "task-1": "t".repeat(pad) });
    oneLine(bare, `a line cut through a bare value's escapes at pad ${pad}`);
    const named = describe("task.update", { taskId: "task-1", title: "x".repeat(pad % 70) }, { "task-1": `${"t".repeat(pad)}‮‮‮‮""""` });
    assert.doesNotMatch(named, /(?<!\\)(?:\\\\)*\\(?:u[0-9a-f]{0,3})?\.\.\.$/, `a line cut through a quoted name's escapes at pad ${pad}: ${named.slice(-30)}`);
    assert.ok(bare.length <= CHAT_LIMITS.line && named.length <= CHAT_LIMITS.line, `pad ${pad}`);
  }

  // A bare value keeps its own backslashes as they are, so one just before an escape `short` wrote reads, left to right, as an escaped backslash: the escape after it is still never cut in half.
  for (let pad = 0; pad < 420; pad++) {
    const line = describe("task.update", { title: "q".repeat(pad % 75), taskId: "task-1", description: `${"z".repeat(pad % 60)}${"\\\u0007".repeat(4)}`, extra: "w".repeat(pad % 77) }, { "task-1": "t".repeat(pad) });
    assert.doesNotMatch(line, /\\u\{[0-9a-f]*\.\.\.$/, `a bare backslash cannot hide the escape after it from the cut at pad ${pad}: ${line.slice(-20)}`);
    assert.ok(line.length <= CHAT_LIMITS.line, `pad ${pad}`);
  }
  // A quoted name's own `\\` followed by text that reads like an escape is cut whole, and a run of backslashes is not given up wholesale.
  for (let pad = 0; pad < 420; pad++) {
    const line = describe("task.update", { taskId: "task-1", title: "x".repeat(pad % 70) }, { "task-1": `${"t".repeat(pad)}${"\\u{41}\\\\".repeat(8)}` });
    const run = line.match(/(\\*)(?:u\{?[0-9a-f]*)?\.\.\.$/);
    assert.ok(run === null || run[1]!.length % 2 === 0, `a quoted name's escaped backslash is never cut in half at pad ${pad}: ${line.slice(-20)}`);
  }
  const backslashes = describe("task.update", { taskId: "task-1" }, { "task-1": "\\".repeat(500) });
  assert.ok(backslashes.length > CHAT_LIMITS.line - 10, `a name of backslashes still fills the line: ${backslashes.length}`);
});

for (const backend of backends) {
  test(`${backend.name}: the name a record holds, invisible characters and all, reaches the owner's proposal as one line`, async () => {
    const script: Record<string, unknown[]> = {};
    const w = await openWorld(backend, script);
    try {
      const chat = w.chat();
      const project = await w.project("Garden");
      await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: project });
      // The record checks let a name hold these (only C0 controls, DEL and lone surrogates are refused); a newline is what the line must survive anyway.
      const title = `Fix the login\u2028screen\u202e now\u200b`;
      const taskId = await w.task(project, title);
      const words = "Give the login task five more dollars";
      script[words] = cmd("budget.raise", { taskId, costMicros: 5_000_000 }, words);
      const outcome = (await chat.submit(w.ownerToken, { messageId: cid("m"), text: words })).outcomes[0]!;
      assert.equal(outcome.status, "proposed", JSON.stringify(outcome));
      const preview = (outcome.preview ?? []).join(" ");
      assert.match(preview, /Fix the login screen/, `the task is named by the name it has: ${preview}`);
      oneLine(preview, "the proposal the owner is shown");
      assert.match(preview, /\\u202e/, "the override that would reorder the line is written out, so the owner sees it is there");
      assert.ok(!preview.includes(title), "and it is not passed through as it was stored");
    } finally { await w.close(); }
  });
}
