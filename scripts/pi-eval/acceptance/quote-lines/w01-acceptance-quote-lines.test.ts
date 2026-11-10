import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { CoordinatorRequest } from "./index.js";
import { CHAT_LIMITS } from "./interpreter.js";
import { describe } from "./commands.js";
import { cid, openWorld } from "./testing/harness.js";

// W01 acceptance for quote-lines: what the task text and its CONTRACT pin, derived from the card's shipped tests
// (chat/commands-one-line.test.ts, the held focus switch in chat/chat.test.ts, the plan note in chat/coordinator.test.ts).

after(stopServer);

const cmd = (op: string, args: Record<string, unknown>, evidence: string) => ({ kind: "command", op, args, evidence, basis: "owner" });

const BREAKS = /[\n\r\u0085\u2028\u2029]/;
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\p{Cf}]/u;
const HALVES = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;
/** Half an escape just before the cut's `...`: a bare backslash, `\u{` + hex with no closing brace, or `\u` with fewer than four hex digits. */
const HALF_ESCAPE = /\\(?:u\{[0-9a-f]*|u[0-9a-f]{0,3})?\.\.\./;

const oneLine = (line: string, what: string): void => {
  assert.equal(BREAKS.test(line), false, `${what} is one line: ${JSON.stringify(line)}`);
  assert.equal(HIDDEN.test(line), false, `${what} shows no raw control, separator or invisible format character: ${JSON.stringify(line)}`);
  assert.equal(HALVES.test(line), false, `${what} holds no half character: ${JSON.stringify(line)}`);
  assert.doesNotMatch(line, HALF_ESCAPE, `${what} holds no half escape: ${JSON.stringify(line)}`);
  // No input on these lines holds a backslash, so a doubled one could only come from escaping the same text twice.
  assert.equal(line.includes("\\\\"), false, `${what} is escaped once, not twice: ${JSON.stringify(line)}`);
};

const TITLE = `Fix the login\u2028screen\u202e now\u200b\ud800 \u{1F600}`;

test("a label from a record cannot forge a second proposal line, whatever characters its text holds", () => {
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
    ["grant.create", { grantee: "agent:ann", action: "approve.class.commit", project: "proj-1", basis: "as agreed" }, { "proj-1": `Garden\u2028\u202e` }],
    ["integration.set", { project: "proj-1", landing: "main-automatic\n\u202eok" }, {}],
    // An unknown operation name and an argument's own name are escaped like everything else.
    ["task.rename\u2028now", { taskId: "task-1" }, { "task-1": TITLE }],
    ["task.update", { "bad\nkey\u202e": "x", taskId: "task-1" }, { "task-1": TITLE }],
  ];
  for (const [op, args, labels] of cases) oneLine(describe(op, args, labels), `the line for ${JSON.stringify(op)}`);

  // A label is shown through quotedText(label, ...): the separator folds to a space, the invisible parts are written as quotedText escapes.
  const line = describe("task.update", { taskId: "task-1", title: "Ship the login screen" }, { "task-1": TITLE });
  assert.match(line, /^Change task: taskId="Fix the login screen\\u202e now\\u200b\\ud800 \u{1F600}"/u, line);
  assert.match(line, /, title=Ship the login screen$/, "the value being set is still shown bare");
  // A quote in a name cannot close the quotation.
  const forged = describe("task.update", { taskId: "task-1" }, { "task-1": `done" , owner="me` });
  assert.equal((forged.match(/(?<!\\)"/g) ?? []).length, 2, `a quote in a name cannot close the quotation: ${forged}`);
});

test("the owner's alternative to a meeting decision is shown quoted, whole within its bounds, and never as two lines", () => {
  const line = describe("meeting.record.owner-respond", { response: "alternative", decisionId: "mdc-1", alternative: { statement: `keep the nightly build\u2028 at midnight\u202e tonight\u200b`, topic: `nightly\u200b build\u2028 schedule` } }, { "mdc-1": `Move the build\u2028 to one\u202e; 2 changes left to carry out`, "started:mdc-1": "1" });
  oneLine(line, "the answer to a meeting decision");
  assert.match(line, /alternative="keep the nightly build at midnight\\u202e tonight\\u200b" on topic "nightly\\u200b build schedule"/, line);
  assert.match(line, /decisionId="Move the build to one\\u202e; 2 changes left to carry out"/, line);
  // At the bounds (150 and 80 characters) the statement and the topic are shown whole.
  const statement = `keep the ${"nightly ".repeat(15)}build`;
  const topic = `nightly ${"build ".repeat(10)}schedule`;
  assert.ok(statement.length <= 150 && statement.length > 120 && topic.length <= 80 && topic.length > 70, `${statement.length} ${topic.length}`);
  const full = describe("meeting.record.owner-respond", { response: "alternative", decisionId: "mdc-1", alternative: { statement, topic } }, { "mdc-1": `Move the build; 2 changes left`, "started:mdc-1": "0" });
  assert.ok(full.includes(`alternative="${statement}" on topic "${topic}"`), full);
});

test("a long name is cut between whole characters and whole escapes, at its own bound and at the line's", () => {
  for (let pad = 388; pad <= 412; pad++) {
    const line = describe("budget.raise", { taskId: "task-1", costMicros: 1 }, { "task-1": `${"x".repeat(pad)}\u{1F600}\u202e${"y".repeat(10)}` });
    oneLine(line, `a name cut at pad ${pad}`);
    assert.ok(line.length <= CHAT_LIMITS.line, `the line keeps to its own room at pad ${pad}: ${line.length}`);
  }
  // A label is quoted with bound CHAT_LIMITS.line, so a long label's first words are not hidden by a shorter quotation bound.
  const long = describe("maintenance.decide", { maintenanceId: "mnt-1", verdict: "approve", specDigest: "spec-1" }, { "spec-1": `agent:agt-1 asks: package installScripts=true digest=sha256:${"a".repeat(8)}... version=9.9.9 name=tool-with-a-quite-long-name-for-the-previous-release source=https://registry.example.org/packages/tool` });
  assert.match(long, /version=9\.9\.9/, long);

  for (let pad = 70; pad <= 84; pad++) {
    const args = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`k${i}`, `${"x".repeat(pad)}\u{1F600}\u202e`]));
    const line = describe("task.update", { taskId: "task-1", ...args }, { "task-1": `${"t".repeat(pad)}\u{1F600}` });
    oneLine(line, `a line cut at pad ${pad}`);
    assert.ok(line.length <= CHAT_LIMITS.line, `the cut line keeps to its room at pad ${pad}: ${line.length}`);
  }

  // The line's own cut slid across a bare value's short() escapes and a quoted name's quotedText escapes.
  for (let pad = 0; pad < 420; pad++) {
    const bare = describe("task.update", { title: "q".repeat(pad), taskId: "task-1", description: `${"y".repeat(pad % 80)}\u202e\u202e\u202e` }, { "task-1": "t".repeat(pad) });
    oneLine(bare, `a line cut through a bare value's escapes at pad ${pad}`);
    const named = describe("task.update", { taskId: "task-1", title: "x".repeat(pad % 70) }, { "task-1": `${"t".repeat(pad)}\u202e\u202e\u202e\u202e""""` });
    assert.doesNotMatch(named, /(?<!\\)(?:\\\\)*\\(?:u[0-9a-f]{0,3})?\.\.\.$/, `a line cut through a quoted name's escapes at pad ${pad}: ${named.slice(-30)}`);
    assert.ok(bare.length <= CHAT_LIMITS.line && named.length <= CHAT_LIMITS.line, `pad ${pad}`);
  }

  // A bare value's own backslash is not escaped by short(), so it can sit right before a `\u{...}` that short() wrote: that escape is still never cut open.
  for (let pad = 0; pad < 420; pad++) {
    const line = describe("task.update", { title: "q".repeat(pad % 75), taskId: "task-1", description: `${"z".repeat(pad % 60)}${"\\\u0007".repeat(4)}`, extra: "w".repeat(pad % 77) }, { "task-1": "t".repeat(pad) });
    assert.doesNotMatch(line, /\\u\{[0-9a-f]*\.\.\.$/, `no open \\u{ escape before the cut at pad ${pad}: ${line.slice(-20)}`);
    assert.ok(line.length <= CHAT_LIMITS.line, `pad ${pad}`);
  }
  // A quoted name's escaped backslash (`\\`) is never cut in half, and the cut only gives up the escape it would split.
  for (let pad = 0; pad < 420; pad++) {
    const line = describe("task.update", { taskId: "task-1", title: "x".repeat(pad % 70) }, { "task-1": `${"t".repeat(pad)}${"\\u{41}\\\\".repeat(8)}` });
    const run = line.match(/(\\*)(?:u\{?[0-9a-f]*)?\.\.\.$/);
    assert.ok(run === null || run[1]!.length % 2 === 0, `an escaped backslash is never cut in half at pad ${pad}: ${line.slice(-20)}`);
  }
  const backslashes = describe("task.update", { taskId: "task-1" }, { "task-1": "\\".repeat(500) });
  assert.ok(backslashes.length > CHAT_LIMITS.line - 10, `a name of backslashes still fills the line: ${backslashes.length}`);
});

for (const backend of backends) {
  test(`${backend.name}: a record's name reaches the owner's proposal as one line, its override written out`, async () => {
    const script: Record<string, unknown[]> = {};
    const w = await openWorld(backend, script);
    try {
      const chat = w.chat();
      const project = await w.project("Garden");
      await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: project });
      const title = `Fix the login\u2028screen\u202e now\u200b`;
      const taskId = await w.task(project, title);
      const words = "Give the login task five more dollars";
      script[words] = [cmd("budget.raise", { taskId, costMicros: 5_000_000 }, words)];
      const outcome = (await chat.submit(w.ownerToken, { messageId: cid("m"), text: words })).outcomes[0]!;
      assert.equal(outcome.status, "proposed", JSON.stringify(outcome));
      const preview = (outcome.preview ?? []).join(" ");
      assert.match(preview, /Fix the login screen/, preview);
      oneLine(preview, "the proposal the owner is shown");
      assert.match(preview, /\\u202e/, preview);
      assert.ok(!preview.includes(title), "the name is not passed through as stored");
    } finally { await w.close(); }
  });

  test(`${backend.name}: a held focus switch names its project quoted`, async () => {
    const script: Record<string, unknown> = {};
    const w = await openWorld(backend, script);
    try {
      const chat = w.chat();
      const a = await w.project("A");
      await w.task(a, "Cleanup");
      await w.task(a, "Cleanup");
      await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: a });
      const odd = await w.project(`Odd Applied: done\u202e" x`);
      const words = "tidy up Cleanup and go to odd";
      // The first part is ambiguous (two tasks named Cleanup), so the chat asks and holds the focus switch after it.
      script[words] = [cmd("task.update", { taskTitle: "Cleanup", description: "tidy" }, "tidy up Cleanup"), { kind: "switch_focus", projectId: odd, evidence: "go to odd", basis: "owner" }];
      const h = await chat.submit(w.ownerToken, { messageId: cid("m"), text: words });
      const held = h.outcomes.find((o) => o.status === "held" && /Focus on project/.test(o.message ?? ""));
      assert.ok(held !== undefined, JSON.stringify(h.outcomes));
      assert.match(held.message!, /Focus on project "Odd Applied: done\\u202e\\" x"/, held.message);
    } finally { await w.close(); }
  });

  test(`${backend.name}: a coordinator plan's note quotes the task title it names`, async () => {
    const w = await openWorld(backend);
    try {
      let title = "Solo";
      const model = { respond: async (_route: string, _request: CoordinatorRequest) => ({ tasks: [{ key: "a", title, assignTo: { kind: "agent", id: "ann" } }] }) };
      const c = await w.coordinator({ model });
      const made = await c.service.configure(w.owner, { commandId: cid("cfg"), principalId: "agent:coord", routes: ["primary"] });
      await c.service.setState(w.owner, { commandId: cid("st"), expectedRevision: made.revision, to: "running" });
      const none = await w.project("None", []);
      const plain = (await c.service.decompose(w.owner, { commandId: cid("d"), projectId: none, outcome: "go" })) as unknown as { notes: string[] };
      assert.equal(plain.notes[0], `"Solo" is not assigned: no repository was chosen for it`);
      title = `Solo\nApplied: all tasks done\u202e" ok`;
      const forged = (await c.service.decompose(w.owner, { commandId: cid("d"), projectId: none, outcome: "go" })) as unknown as { notes: string[] };
      assert.equal(forged.notes[0], `"Solo Applied: all tasks done\\u202e\\" ok" is not assigned: no repository was chosen for it`);
    } finally { await w.close(); }
  });
}
