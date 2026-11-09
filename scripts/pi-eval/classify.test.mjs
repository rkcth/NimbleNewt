// Tests for the bench's ending classifier, on logs trimmed from real Pi runs (fixtures/) and on hand-made events.
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { classify, endKindOf, planProgress, summarizeLogFile, summarizeLogText, testCounts } from "./lib/classify.mjs";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const load = (name) => summarizeLogFile(join(fixtures, name));
const failed = { ran: true, passed: false };
const passed = { ran: true, passed: true };

test("c07p: a run that ended on a thinking-only reply mid-work is stopped early, not empty and not finished", async () => {
  const s = await load("c07p-stopped-early.jsonl");
  assert.equal(s.agentEnd, true);
  assert.equal(s.last.stopReason, "stop");
  assert.equal(s.last.visibleChars, 0);
  assert.ok(s.toolCalls > 0, "it had been working");
  const r = classify({ summary: s, hidden: failed, changed: true });
  assert.equal(r.outcome, "stopped-early", r.reason);
  assert.equal(r.endKind, "thinking-only");
});

test("x09b-fix3: a reply cut at the output limit is a length stop", async () => {
  const s = await load("x09b-fix3-length.jsonl");
  assert.equal(s.last.stopReason, "length");
  assert.equal(classify({ summary: s, hidden: failed, changed: false }).outcome, "length");
});

test("capacity-view-pi: 'No response requested' with no work done is empty", async () => {
  const s = await load("capacity-view-empty.jsonl");
  assert.equal(s.toolCalls, 0);
  const r = classify({ summary: s, hidden: failed, changed: false });
  assert.equal(r.outcome, "empty", r.reason);
});

test("flaky-confirm: a report that says done is a verified finish only when the hidden tests pass, and a false done when they fail", async () => {
  const s = await load("flaky-confirm-report.jsonl");
  assert.equal(endKindOf(s), "report");
  assert.equal(classify({ summary: s, hidden: passed, changed: true }).outcome, "verified-finish");
  const r = classify({ summary: s, hidden: failed, changed: true });
  assert.equal(r.outcome, "wrong", r.reason);
  assert.equal(r.claimsDone, true);
});

test("a run's tokens, turns and tool calls are summed from the log", async () => {
  const s = await load("flaky-confirm-report.jsonl");
  assert.ok(s.tokens.input > 0 && s.tokens.output > 0);
  assert.equal(s.turns, 3);
  assert.ok(s.sessionId);
});

const ev = (...events) => events.map((e) => JSON.stringify(e)).join("\n");
const msg = (content, stopReason) => ({ type: "message_end", message: { role: "assistant", content, stopReason, usage: { input: 1, output: 1 } } });
const tool = { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } };
const head = [{ type: "session", id: "s1" }, { type: "agent_start" }];
const tail = [{ type: "agent_end", messages: [] }, { type: "agent_settled", aborted: false }];

test("hidden tests that pass on an unchanged worktree are a broken task, never a finish", () => {
  const s = summarizeLogText(ev(...head, tool, msg([{ type: "text", text: "Done." }], "stop"), ...tail));
  const r = classify({ summary: s, hidden: passed, changed: false });
  assert.equal(r.outcome, "error");
  assert.match(r.reason, /not calibrated/);
});

test("a timeout wins over everything, even passing hidden tests", () => {
  const s = summarizeLogText(ev(...head, tool));
  assert.equal(classify({ summary: s, hidden: passed, changed: true, timedOut: true }).outcome, "timeout");
});

test("errors: no session at all, a reply that ended in error, and a process that died mid-run", () => {
  assert.equal(classify({ summary: summarizeLogText(""), hidden: failed, changed: false, exitCode: 1 }).outcome, "error");
  assert.equal(classify({ summary: summarizeLogText("not json at all\n"), hidden: failed, changed: false, exitCode: 0 }).outcome, "error");
  const e = summarizeLogText(ev(...head, msg([], "error"), ...tail));
  assert.equal(classify({ summary: e, hidden: failed, changed: false }).outcome, "error");
  const died = summarizeLogText(ev(...head, tool, msg([{ type: "text", text: "Let me run the tests." }], "toolUse")));
  assert.equal(classify({ summary: died, hidden: failed, changed: true, exitCode: 137 }).outcome, "error");
});

test("a log that just stops (exit 0, no agent_end) is stopped early, not finished", () => {
  const s = summarizeLogText(ev(...head, tool, msg([{ type: "text", text: "Now I'll edit it." }], "toolUse")));
  assert.equal(classify({ summary: s, hidden: failed, changed: true, exitCode: 0 }).outcome, "stopped-early");
});

test("an announced next step, and a done claim with unchecked plan steps, are stopped early", () => {
  const announced = summarizeLogText(ev(...head, tool, msg([{ type: "text", text: "I found the file. Next I'll add the tests:" }], "stop"), ...tail));
  const a = classify({ summary: announced, hidden: failed, changed: true });
  assert.equal(a.outcome, "stopped-early");
  assert.equal(a.endKind, "announced-step");
  const done = summarizeLogText(ev(...head, tool, msg([{ type: "text", text: "Done. Step 2 is complete." }], "stop"), ...tail));
  assert.equal(classify({ summary: done, hidden: failed, changed: true, plan: { checked: 2, unchecked: 3 } }).outcome, "stopped-early");
  assert.equal(classify({ summary: done, hidden: failed, changed: true, plan: { checked: 5, unchecked: 0 } }).outcome, "wrong");
});

test("an unknown stop reason is counted as unclassified, so the gate sees the gap", () => {
  const s = summarizeLogText(ev(...head, tool, msg([{ type: "text", text: "hm" }], "content_filter"), ...tail));
  assert.equal(classify({ summary: s, hidden: failed, changed: true }).outcome, "unclassified");
});

test("PLAN.md checkboxes and node --test counts are read", () => {
  assert.deepEqual(planProgress("# Plan\n- [x] one\n- [ ] two\n  * [X] three\n1. [ ] four\nnot - [ ] this\n"), { checked: 2, unchecked: 2 });
  assert.equal(planProgress(undefined), null);
  assert.deepEqual(testCounts("ok 1\n# tests 7\n# suites 0\n# pass 6\n# fail 1\n"), { tests: 7, pass: 6, fail: 1 });
  assert.deepEqual(testCounts("ℹ tests 3\nℹ pass 3\nℹ fail 0\n"), { tests: 3, pass: 3, fail: 0 });
  assert.deepEqual(testCounts("nothing"), { tests: null, pass: null, fail: null });
});

test("the W01 smoke run: a long report that opens with 'Done.' and lists tests last is a false done when a hidden test fails", async () => {
  const s = await load("quote-lines-smoke-false-done.jsonl");
  assert.equal(s.last.stopReason, "stop");
  assert.ok(s.last.visibleChars > 0);
  const r = classify({ summary: s, hidden: { ran: true, passed: false, tests: 154, pass: 153, fail: 1 }, changed: true });
  assert.equal(r.outcome, "wrong", r.reason);
  assert.equal(r.claimsDone, true);
});

test("an honest partial report is a stop, not a false done, though it uses done words", () => {
  for (const text of [
    "I implemented steps 1 to 3. I could not complete step 4: the coordinator test still fails.",
    "Summary of the work so far: the parser is done, but the remaining work is the preview text.",
    "The change is not yet complete; two tests are still failing.",
    "Step 3 completed. Steps 4 and 5 are incomplete.",
  ]) {
    const s = summarizeLogText(ev(...head, tool, msg([{ type: "text", text }], "stop"), ...tail));
    const r = classify({ summary: s, hidden: failed, changed: true });
    assert.equal(r.claimsDone, false, text);
    assert.equal(r.outcome, "stopped-early", text);
  }
});

test("a done report that signs off with 'Let me know ...' is still a done claim (a false done when the tests fail)", () => {
  const s = summarizeLogText(ev(...head, tool, msg([{ type: "text", text: "Done. I implemented the change and all tests pass.\nLet me know if you want any changes." }], "stop"), ...tail));
  assert.equal(endKindOf(s), "report");
  const r = classify({ summary: s, hidden: failed, changed: true });
  assert.equal(r.outcome, "wrong", r.reason);
});

test("a log line split by a stray line, a huge line and a half-written last line are counted, not fatal", () => {
  const big = { type: "tool_execution_start", toolCallId: "c2", toolName: "write", args: { path: "x", content: "y".repeat(5_000_000) } };
  const text = [ev(...head, tool, big), "warning: something on stderr", ev(msg([{ type: "text", text: "Done. All tests pass." }], "stop"), ...tail), '{"type":"message_end","message":{"ro'].join("\n");
  const s = summarizeLogText(text);
  assert.equal(s.parseErrors, 2);
  assert.equal(s.toolCalls, 2);
  assert.equal(s.agentEnd, true);
  assert.equal(classify({ summary: s, hidden: failed, changed: true }).outcome, "wrong");
});
