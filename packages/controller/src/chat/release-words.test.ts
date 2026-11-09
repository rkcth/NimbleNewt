import assert from "node:assert/strict";
import { test } from "node:test";
import { foreignValue, RELEASE_ID_KEYS, saysAcknowledgeFlaky, saysPlatform } from "./commands.js";

/**
 * The owner's own words behind a flaky approval and behind a release ID (card X09b part 2 review). `acknowledgeFlaky` is a boolean, so `foreignValue` cannot see it: it needs its own word check, and a
 * release or host ID needs whole-word matching, or a name that merely starts with it lets it through.
 */

test("saying you accept a flaky pass is the owner's own acceptance of the failures: naming flaky, knowing about it or asking about it is not", () => {
  const cand = "rcn-64c39134f5136c6cfe8ea2b4";
  const yes = [
    `approve the release candidate ${cand} with acknowledgeFlaky: I have read the gate and accept the earlier failures`,
    `approve ${cand}: I have read the gate and accept the earlier failures`,
    `approve ${cand}, I am fine with the flaky pass`,
    `approve ${cand}, it is ok with me that it failed first`,
    `approve ${cand}, go ahead despite the failures`,
    `the gate shows a flaky platform and I accept it, approve ${cand}`,
    `${cand} failed before it passed and I accept that`,
  ];
  for (const words of yes) assert.equal(saysAcknowledgeFlaky(words, cand), true, `"${words}" accepts the earlier failures`);

  // Every one of these was accepted before (card X09b part 2 review 2, item 1): none of them accepts anything.
  const no = [
    `approve ${cand}`,
    `approve ${cand}, the flaky test fixtures are fine`,
    `approve ${cand}. Was another candidate flaky?`,
    `approve ${cand} unless it is flaky`,
    `approve ${cand} if nothing failed`,
    `approve ${cand}, it isn't flaky`,
    `approve ${cand}, it wasn't flaky`,
    `approve ${cand}, the tests didn't fail`,
    `approve ${cand}, nothing is flaky`,
    `approve ${cand}, I do not accept the earlier failures`,
    `approve ${cand}, I won't accept a flaky pass`,
    `approve ${cand}, the gate shows a flaky platform`,
    `approve ${cand}, I know it failed first`,
    `is ${cand} the flaky one? I want to approve it`,
    `approve ${cand}. Was rcn-bbbbbbbbbbbbbbbbbbbbbbbb flaky? I accept the failures`,
    `the gate is flaky. Approve rcn-bbbbbbbbbbbbbbbbbbbbbbbb, I accept the failures`,
    "",
  ];
  for (const words of no) assert.equal(saysAcknowledgeFlaky(words, cand), false, `"${words}" accepts nothing`);

  // The question about another candidate and the acceptance about this one, in the right order, is about this one.
  assert.equal(saysAcknowledgeFlaky(`was rcn-bbbbbbbbbbbbbbbbbbbbbbbb flaky? approve ${cand}, I accept its earlier failures`, cand), true, "the acceptance names the candidate being approved");
  // With no candidate to bind to, the acceptance still has to be an acceptance.
  assert.equal(saysAcknowledgeFlaky("I accept the earlier failures, approve it"), true, "an acceptance with no candidate named is still an acceptance");
  assert.equal(saysAcknowledgeFlaky("the gate looks flaky, approve it"), false, "naming flaky is not accepting it");
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

test("the owner's natural spelling of a platform names it: linux-x64, my mac, windows, x86_64, aarch64", () => {
  assert.equal(saysPlatform("let host:rig run release tests on linux x64", "os", "linux"), true, "the plain word");
  assert.equal(saysPlatform("let host:rig run release tests on linux-x64", "os", "linux"), true, "a hyphen between the platform and the chip");
  assert.equal(saysPlatform("let host:rig run release tests on linux/x64", "arch", "x64"), true, "a slash between them");
  assert.equal(saysPlatform("let host:rig run release tests on linux-x64", "arch", "x64"), true, "the chip of linux-x64");
  for (const words of ["authorize host:rig for release tests on my mac", "authorize host:rig for release tests on macOS", "authorize host:rig for release tests on darwin"]) {
    assert.equal(saysPlatform(words, "os", "darwin"), true, `"${words}" says darwin`);
  }
  for (const words of ["authorize host:rig for release tests on windows", "authorize host:rig for release tests on win32"]) {
    assert.equal(saysPlatform(words, "os", "win32"), true, `"${words}" says win32`);
  }
  for (const words of ["on x86_64", "on amd64", "on x64"]) assert.equal(saysPlatform(words, "arch", "x64"), true, `"${words}" says x64`);
  for (const words of ["on arm64", "on aarch64"]) assert.equal(saysPlatform(words, "arch", "arm64"), true, `"${words}" says arm64`);

  // A platform the owner did not name is still foreign, whatever the spelling tried.
  assert.equal(saysPlatform("let host:rig run release tests on linux x64", "os", "darwin"), false, "linux is not mac");
  assert.equal(saysPlatform("let host:rig run release tests on linux x64", "os", "win32"), false, "linux is not windows");
  assert.equal(saysPlatform("let host:rig run release tests on linux x64", "arch", "arm64"), false, "x64 is not arm64");
  assert.equal(saysPlatform("let host:rig run release tests on linux arm64", "arch", "x64"), false, "arm64 is not x64, though both end in 64");
  assert.equal(saysPlatform("authorize host:machine-room for release tests", "os", "linux"), false, "a machine room is not linux");
  assert.equal(saysPlatform("", "os", "linux"), false, "no words name nothing");
});

test("an ID the owner wrote with markdown, a colon or trailing punctuation is still their own whole word, and a longer or joined name still is not", () => {
  // What owners actually type around an ID: markdown bold and backticks, a label and colon before it, a quote, a bracket, a comma or a full stop after it (card X09b part 2 review 2, item 6).
  for (const text of ["approve **rcn-1a2b** now", "approve `rcn-1a2b` now", "candidate:rcn-1a2b", "approve rcn-1a2b: it is the one", "approve rcn-1a2b_ please", 'approve "rcn-1a2b" now', "approve rcn-1a2b, then tell me", "(rcn-1a2b) is the one", "approve rcn-1a2b."]) {
    assert.equal(foreignValue({ candidateId: "rcn-1a2b" }, text, "", RELEASE_ID_KEYS), undefined, `"${text}" names the candidate`);
  }
  // A name that carries on past the ID is another name: a letter, a digit, or a dash, underscore, dot or colon with more of the name after it.
  for (const text of ["approve rcn-1a2bc now", "approve rcn-1a2b_old now", "approve rcn-1a2b-x now", "approve xrcn-1a2b now", "approve rcn-1a2b.x now", "approve rcn-1a2b:3 now"]) {
    assert.equal(foreignValue({ candidateId: "rcn-1a2b" }, text, "", RELEASE_ID_KEYS), "candidateId", `"${text}" names another ID`);
  }
  assert.equal(foreignValue({ hostId: "host:rig" }, "authorize **host:rig** for release tests", "", RELEASE_ID_KEYS), undefined, "a bold host name is the owner's own");
  assert.equal(foreignValue({ hostId: "host:rig" }, "authorize host:rig2 for release tests", "", RELEASE_ID_KEYS), "hostId", "host:rig2 is another machine");
  assert.equal(foreignValue({ hostId: "host:rig" }, "authorize host:rig_2 for release tests", "", RELEASE_ID_KEYS), "hostId", "an underscore with more after it joins the name");
  assert.equal(foreignValue({ attemptId: "rat-1a2b" }, "stop rat-1a2b: it is stuck", "", RELEASE_ID_KEYS), undefined, "a colon after an attempt ID is punctuation");
});
