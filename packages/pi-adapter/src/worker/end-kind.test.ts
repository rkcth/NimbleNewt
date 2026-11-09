import assert from "node:assert/strict";
import { test } from "node:test";
import { WORK_END_TOOL } from "../bridge.js";
import { calledWorkEnd, classifyTurnEnd } from "./end-kind.js";

// Card W02: how a completed turn ended, read from its last reply.
const endKind = (stopReason: string | undefined, visibleText: string, toolCalls: Parameters<typeof classifyTurnEnd>[0]["toolCalls"] = []) => classifyTurnEnd({ stopReason, visibleText, toolCalls }).endKind;
const ended = [{ name: WORK_END_TOOL, status: "ok", output: "{\"item\":{\"state\":\"requested\"}}" }];

test("each of the five end kinds, from the last reply's stop reason and visible text and whether the turn called work.end", () => {
  assert.equal(endKind("length", "The report so far: step 1 is done and step 2", ended), "length", "a reply cut off at the limit is length, whatever came before it");
  assert.equal(endKind("stop", "Done: the work is committed.", ended), "normal");
  assert.equal(endKind("stop", "", ended), "normal", "a turn that ended with work.end ended as meant even with nothing visible after the call");
  assert.equal(endKind("stop", ""), "empty-visible-text");
  assert.equal(endKind("stop", "  \n\t "), "empty-visible-text", "white space is not visible text");
  assert.equal(endKind("toolUse", ""), "empty-visible-text");
  assert.equal(endKind("stop", "I fixed the parser.\n\nNow let me run the tests:"), "announced-step-without-tool-call");
  assert.equal(endKind("stop", "Next, I'll update the README"), "announced-step-without-tool-call");
  assert.equal(endKind("stop", "The tests pass and the change is committed."), "no-work-end");
  assert.equal(endKind("stop", "Let me know if you want anything else."), "no-work-end", "a sign-off is not an announced step");
  assert.equal(endKind(undefined, "All done."), "no-work-end", "a stop reason that cannot be read is classified from the text");
});

test("only a work.end the controller accepted counts: a refused one, another tool, or one Pi could not run is not an ending", () => {
  assert.equal(calledWorkEnd(ended), true);
  assert.equal(calledWorkEnd([{ name: WORK_END_TOOL, status: "ok", output: "refused (paused): the task is paused" }]), false);
  assert.equal(calledWorkEnd([{ name: WORK_END_TOOL, status: "error", output: "boom" }]), false);
  assert.equal(calledWorkEnd([{ name: WORK_END_TOOL, status: "unknown_tool" }]), false);
  assert.equal(calledWorkEnd([{ name: "nimblenewt__desk-read", status: "ok", output: "{}" }]), false);
  assert.equal(endKind("stop", "Finished.", [{ name: WORK_END_TOOL, status: "ok", output: "refused (unavailable): x" }]), "no-work-end");
});

test("the visible length is the trimmed length of the last reply's text", () => {
  assert.equal(classifyTurnEnd({ stopReason: "stop", visibleText: "  hello \n", toolCalls: [] }).visibleChars, 5);
  assert.equal(classifyTurnEnd({ stopReason: "length", visibleText: "", toolCalls: [] }).visibleChars, 0);
});
