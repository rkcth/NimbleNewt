import assert from "node:assert/strict";
import { test } from "node:test";
import { foreignValue, RELEASE_ID_KEYS, saysAcknowledgeFlaky } from "./commands.js";

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

test("a release ID or a host ID only counts when the owner said it as a whole word, not as the start of a longer name", () => {
  const own = "authorize host:rig2 for release tests on linux x64";
  assert.equal(foreignValue({ hostId: "host:rig" }, own, "", RELEASE_ID_KEYS), "hostId", "host:rig2 does not say host:rig");
  assert.equal(foreignValue({ hostId: "host:rig2" }, own, "", RELEASE_ID_KEYS), undefined, "the host the owner named is theirs");
  assert.equal(foreignValue({ hostId: "host:rig" }, "let host:rig run release tests on linux x64", "", RELEASE_ID_KEYS), undefined, "a host named in a sentence counts");
  assert.equal(foreignValue({ hostId: "host:rig" }, "move the work off host:rig. today", "", RELEASE_ID_KEYS), undefined, "a full stop after an ID is still a whole word");
  assert.equal(foreignValue({ attemptId: "rat-1a2b" }, "stop the release test that is running now", "", RELEASE_ID_KEYS), "attemptId", "an attempt the owner never named is foreign");
  assert.equal(foreignValue({ candidateId: "rcn-1a2b" }, "approve rcn-1a2b, please", "", RELEASE_ID_KEYS), undefined, "an ID the owner named with punctuation after it counts");
  assert.equal(foreignValue({ candidateId: "rcn-1a2b" }, "approve rcn-1a2b3 instead", "", RELEASE_ID_KEYS), "candidateId", "a longer candidate ID is another candidate");
  // A long text (a reason, a summary) is still checked as it was: it is the owner's sentence, not an ID.
  assert.equal(foreignValue({ reason: "the machine is needed elsewhere" }, "interrupt it, the machine is needed elsewhere", "", RELEASE_ID_KEYS), undefined);
  assert.equal(foreignValue({ reason: "somewhere else" }, "interrupt it, the machine is needed elsewhere", "", RELEASE_ID_KEYS), "reason");
});
