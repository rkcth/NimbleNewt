import assert from "node:assert/strict";
import { test } from "node:test";
import { foreignValue, platformsNamed, RELEASE_ID_KEYS, saysPlatform } from "./commands.js";

/**
 * The checks behind the release commands that are not about wording (card X09b part 2 review, redone): a release or host ID needs whole-word matching, or a name that merely starts with it lets it
 * through, and a platform counts only when the owner's own words name it. Accepting a flaky pass is NOT a wording question any more: the chat proposes the approval showing the earlier failures the
 * gate lists, and the owner's confirmation of that shown proposal is the acceptance (see `release-owner-words.test.ts`). Landing on main with no human step is not a wording question either
 * (`landing-words.test.ts`). Nothing here scans the owner's sentence for an acceptance, and no message asks them to say a particular word.
 */

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

test("a platform the owner ruled out names nothing, and so does the ordinary word that happens to spell one (card X09b part 2 review 3, item D3)", () => {
  // Ruled out: the words the owner denies with are the opposite of authorizing.
  assert.equal(saysPlatform("let host:rig run release tests on linux x64, not the mac", "os", "darwin"), false, "\"not the mac\" rules mac out");
  assert.equal(saysPlatform("let host:rig run release tests on linux, not x64", "arch", "x64"), false, "\"not x64\" rules the chip out");
  assert.equal(saysPlatform("authorize host:rig for release tests on linux; no mac, no arm64", "os", "darwin"), false, "\"no mac\" rules mac out");
  assert.equal(saysPlatform("authorize host:rig for release tests on linux x64; it isn't windows", "os", "win32"), false, "\"isn't windows\" rules windows out");
  assert.equal(saysPlatform("authorize host:rig for release tests on linux x64, never windows", "os", "win32"), false, "\"never windows\" rules windows out");
  assert.equal(saysPlatform("authorize host:rig for release tests on windows, not linux", "os", "win32"), true, "the platform the owner did say still counts beside the one they denied");
  assert.equal(saysPlatform("let host:rig run release tests on linux x64, not the mac", "os", "linux"), true, "and the os of a denial-free phrase is still named");

  // An ordinary word: an address is written down on a sticker, and it is not a macOS.
  const sticker = "let host:box run release tests on linux x64, its MAC address is on the sticker";
  assert.equal(saysPlatform(sticker, "os", "darwin"), false, "a MAC address is not macOS");
  assert.equal(saysPlatform(sticker, "os", "linux"), true, "the os of the same message is still the owner's own");
  assert.equal(saysPlatform(sticker, "arch", "x64"), true, "and so is its chip");
  assert.equal(saysPlatform("authorize host:rig for release tests on my mac", "os", "darwin"), true, "\"my mac\" with no address after it still means macOS");
  // Named once and denied once in the same message: it counts where the owner said it, and the denial only reaches as far as its own clause.
  assert.equal(saysPlatform("not the mac; authorize host:rig for release tests on my mac", "os", "darwin"), true, "denied in one clause, named in the next");
  assert.equal(saysPlatform("linux, not windows; the mac mini is the one", "os", "darwin"), true, "a denial in an earlier clause does not reach into this one");
});

test("an ID the owner wrote with markdown, a colon or trailing punctuation is still their own whole word, and a longer or joined name still is not", () => {
  // What owners actually type around an ID: markdown bold and backticks, a label and colon before it, a quote, a bracket, a comma or a full stop after it (card X09b part 2 review 2, item 6).
  for (const text of ["approve **rcn-1a2b** now", "approve `rcn-1a2b` now", "candidate:rcn-1a2b", "approve rcn-1a2b: it is the one", "approve rcn-1a2b_ please", 'approve "rcn-1a2b" now', "(rcn-1a2b) is the one", "approve rcn-1a2b."]) {
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

test("the platforms the owner's words name, so a message naming two of a kind can be asked about instead of guessed (card X09b part 2 review 3, item D3)", () => {
  assert.deepEqual(platformsNamed("let host:rig run release tests on linux x64", "os"), ["linux"], "one os named");
  assert.deepEqual(platformsNamed("let host:rig run release tests on linux x64", "arch"), ["x64"], "one chip named");
  assert.deepEqual(platformsNamed("let host:box run release tests on linux x64, its MAC address is on the sticker", "os"), ["linux"], "the address on the sticker names no second os");
  assert.deepEqual(platformsNamed("let host:rig run release tests on linux x64, not the mac", "os"), ["linux"], "the os the owner denied is not named");
  // Two of a kind: the chat cannot tell which one the machine is authorized for, so it must ask rather than take the interpreter's.
  assert.deepEqual(platformsNamed("let host:rig run release tests on linux arm64; the old one was x64", "arch").sort(), ["arm64", "x64"], "both chips the message mentions");
  assert.deepEqual(platformsNamed("authorize host:rig for release tests, on mac or linux", "os").sort(), ["darwin", "linux"], "an owner torn between two systems");
  // The order the choices are listed in is stable whatever order the owner wrote them in.
  assert.deepEqual(platformsNamed("windows, not linux", "os"), ["win32"], "the denial leaves one");
});
