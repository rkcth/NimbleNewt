import assert from "node:assert/strict";
import { test } from "node:test";
import { saysAcknowledgeFlaky } from "./commands.js";

/**
 * The owner's own words behind a flaky approval and behind a release ID (card X09b part 2 review). `acknowledgeFlaky` is a boolean, so `foreignValue` cannot see it: it needs its own word check, and a
 * release or host ID needs whole-word matching, or a name that merely starts with it lets it through.
 */

test("saying you accept a flaky pass is the owner's word: the word flaky, or accepting the failures; anything else is not", () => {
  assert.equal(saysAcknowledgeFlaky("approve the release candidate rcn-64c39134f5136c6cfe8ea2b4 with acknowledgeFlaky: I have read the gate and accept the earlier failures"), true, "the wording the chat test uses");
  assert.equal(saysAcknowledgeFlaky("the gate shows a flaky platform, approve it"), true, "the word flaky alone");
  assert.equal(saysAcknowledgeFlaky("I know it failed first. Approve it."), true, "accepting the failure in other words");
  assert.equal(saysAcknowledgeFlaky("approve the release candidate rcn-64c39134f5136c6cfe8ea2b4"), false, "a plain approval says nothing about failures");
  assert.equal(saysAcknowledgeFlaky("did the linux platform fail before it passed?"), false, "a question accepts nothing");
  assert.equal(saysAcknowledgeFlaky("I do not accept the earlier failures, do not approve it"), false, "a negated sentence is not an acceptance");
  assert.equal(saysAcknowledgeFlaky(""), false, "no words say nothing");
});
