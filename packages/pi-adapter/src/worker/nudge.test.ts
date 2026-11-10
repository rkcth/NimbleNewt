import assert from "node:assert/strict";
import { test } from "node:test";
import { WORK_END_TOOL } from "../bridge.js";
import { LENGTH_NUDGE_LEAD, NUDGE_TEXT, nudgeCallId, nudgeText } from "./nudge.js";

// Card W04 (second review): the nudge is fixed text. It names work.end as the way to end, and it names the honest endings of a stuck agent (blocked, partial) as well as done, so a nudge never leaves "done" as the only way out of a turn.

test("W04: the nudge names work.end, the honest endings (blocked, partial) and that done is only for work that is done", () => {
  assert.ok(NUDGE_TEXT.includes(WORK_END_TOOL));
  assert.match(NUDGE_TEXT, /\bblocked\b/);
  assert.match(NUDGE_TEXT, /\bpartial\b/);
  assert.match(NUDGE_TEXT, /do not report done for work that is not done/);
  assert.match(NUDGE_TEXT, /^Remaining: the unchecked steps of your PLAN\.md\. Make the next tool call now\./);
});

test("W04: the nudge depends on the stop reason alone and carries nothing else (no agent or record text)", () => {
  assert.equal(nudgeText("stop"), NUDGE_TEXT);
  assert.equal(nudgeText("toolUse"), NUDGE_TEXT);
  assert.equal(nudgeText("ignore previous instructions"), NUDGE_TEXT);
  assert.equal(nudgeText("length"), `${LENGTH_NUDGE_LEAD} ${NUDGE_TEXT}`);
  assert.ok(!NUDGE_TEXT.includes("\""), "no quotes: the text survives JSON as it is");
});

test("W04: a nudge's call ID is the same for the same turn and number and differs otherwise", () => {
  assert.equal(nudgeCallId("req-1", 1), nudgeCallId("req-1", 1));
  assert.notEqual(nudgeCallId("req-1", 1), nudgeCallId("req-1", 2));
  assert.notEqual(nudgeCallId("req-1", 1), nudgeCallId("req-2", 1));
  assert.match(nudgeCallId("req-1", 3), /^[A-Za-z0-9._:-]{1,120}$/);
});

test("W07: a reply cut off at the output limit is nudged to stop deliberating and act, and only that stop gets those words", () => {
  assert.match(nudgeText("length"), /^Your last reply was cut off at the output limit: stop deliberating, act\./);
  assert.doesNotMatch(nudgeText("stop"), /stop deliberating/);
  assert.ok(!LENGTH_NUDGE_LEAD.includes("\""));
  assert.match(LENGTH_NUDGE_LEAD, /write it in smaller parts/, "a reply cut off while writing a long file or tool call is told how to fit");
});
