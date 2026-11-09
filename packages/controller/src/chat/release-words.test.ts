import assert from "node:assert/strict";
import { test } from "node:test";
import { foreignValue, platformsNamed, RELEASE_ID_KEYS, saysAcknowledgeFlaky, saysMainAutomatic, saysPlatform } from "./commands.js";

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

test("a curly apostrophe is still a negation: phones type ’, and it must not turn a refusal into an acceptance (third review, D1)", () => {
  const cand = "rcn-64c39134f5136c6cfe8ea2b4";
  // The straight apostrophe already refused all of these; the curly one (and the modifier letter apostrophe) must refuse them too.
  const no = [
    `approve ${cand}, I don’t accept the earlier failures`,
    `approve ${cand}, I won’t accept a flaky pass`,
    `approve ${cand}, we can’t accept the failures`,
    `approve ${cand}, it isn’t flaky`,
    `approve ${cand}, that wasn’t my acceptance of the failures`,
    `approve ${cand}, I donʼt accept the failures`,
    `approve ${cand}, I don‘t accept the failures`,
  ];
  for (const words of no) {
    assert.equal(saysAcknowledgeFlaky(words, cand), false, `"${words}" accepts nothing`);
    assert.equal(saysAcknowledgeFlaky(words.replace(/[’ʼ‘]/g, "'"), cand), false, "the same sentence typed with a straight apostrophe accepts nothing");
  }

  // The same shared negation rule guards landing on main with no human step.
  const noMain = [
    "don’t send it straight to main",
    "won’t go to main automatically",
    "we can’t land it straight to main",
    "it isn’t automatic to main",
    "donʼt push it straight to main",
  ];
  for (const words of noMain) {
    assert.equal(saysMainAutomatic(words), false, `"${words}" does not order main-automatic`);
    assert.equal(saysMainAutomatic(words.replace(/[’ʼ‘]/g, "'")), false, "the same sentence typed with a straight apostrophe orders nothing");
  }

  // Normalising the apostrophe must not invent an order or an acceptance that was never said.
  assert.equal(saysMainAutomatic("land finished work on main automatically"), true, "a plain order still lands on main");
  assert.equal(saysMainAutomatic("don’t send it straight to main. From now on land finished work on main automatically"), true, "the denial is one sentence, the order another");
  assert.equal(saysMainAutomatic("don’t send it straight to main; it is not automatic to main"), false, "normalising the apostrophe invents no order");
  assert.equal(saysAcknowledgeFlaky(`approve ${cand}, I’m fine with the earlier failures`, cand), true, "a curly apostrophe in I’m still carries the acceptance");
});

test("an acceptance is a verb, in the owner's own mouth, unconditioned and about the candidate being approved (third review, D2)", () => {
  const a = "rcn-1a2b3c4d5e6f7a8b9c0d1e2f";
  const b = "rcn-9f9f9f9f9f9f9f9f9f9f9f9f";

  // What an owner really says when they accept the earlier failures of the candidate they are approving.
  const yes = [
    `approve ${a}, I accept the earlier failures`,
    `approve ${a} anyway, I accept that linux failed first`,
    `approve ${a}. Yes accept the earlier failures`,
    `approve ${a}. I accept the failures that came first`,
    `approve ${a}: the acceptance suite failed on linux first and I accept that`,
    `approve ${a}, go ahead despite the failures`,
    `approve ${a}, acknowledge the flaky pass`,
    `${a} failed before it passed and I accept that`,
    `approve ${b} and ${a}, I accept the failures`,
  ];
  for (const words of yes) assert.equal(saysAcknowledgeFlaky(words, a), true, `"${words}" accepts the earlier failures of ${a}`);

  // None of these accepts the earlier failures of `a` (third review, D2), each for the reason its group says.
  const no: ReadonlyArray<readonly [string, string]> = [
    // A noun is not an acceptance: the owner has to accept something, not mention acceptance or an acknowledgement.
    [`approve ${a}; the acceptance suite failed on linux first`, "a noun"],
    [`approve ${a}; the acknowledgement of the failures sits in the waiver file`, "a noun"],
    // A condition is not an acceptance: the owner accepts nothing yet, something has to happen first.
    [`approve ${a} once QA has accepted the failures`, "once"],
    [`approve ${a} only after the failures are acknowledged`, "after"],
    [`approve ${a} before the failures are acknowledged`, "before"],
    [`approve ${a} until QA accepts the failures`, "until"],
    [`approve ${a}. Ask QA whether they accept its failures`, "whether"],
    [`approve ${a} when the team accepts the failures`, "when"],
    [`approve ${a}, once I have read the log I accept the failures`, "once, and the owner's own mouth"],
    [`approve ${a}; ask me whether I accept the failures`, "whether, and the owner's own mouth"],
    [`approve ${a}, I accept the failures if only linux failed`, "if, even after the acceptance"],
    [`approve ${a}, I accept the failures assuming only linux failed`, "assuming"],
    // An acceptance of another candidate is not an acceptance of this one.
    [`approve ${a} and ${b}; I accept the failures of ${b}`, "another candidate is nearer to the acceptance"],
    [`approve ${a} and ${b}. I accept the failures of ${b}`, "another candidate is nearer to the acceptance"],
    [`approve ${a} and ${b}, I accept the failures`, "the other candidate is the one nearest to the acceptance"],
    // A question is not an acceptance, with or without its final mark.
    [`approve ${a}, did you accept the failures`, "a question with no mark"],
    [`approve ${a}, do you accept the failures`, "a question with no mark"],
    [`approve ${a}, does QA accept the failures`, "a question with no mark"],
    [`approve ${a}, would you accept the failures`, "a question with no mark"],
    [`approve ${a}, should we accept the failures`, "a question with no mark"],
    [`approve ${a}, could you accept the failures`, "a question with no mark"],
    [`approve ${a}, can you accept the failures`, "a question with no mark"],
    [`approve ${a}, will you accept the failures`, "a question with no mark"],
    [`approve ${a}, the earlier failures were accepted?!`, "a question ending ?!"],
    [`approve ${a}\uff1fI accept the earlier failures`, "a question with a full-width mark"],
    // Somebody else's acceptance is not the owner's.
    [`approve ${a}, Bob accepted the failures`, "another person accepted them"],
    [`approve ${a}, QA has accepted the failures`, "another person accepted them"],
    [`approve ${a}, they accepted the failures`, "another person accepted them"],
    [`approve ${a}, the reviewer accepted the failures`, "another person accepted them"],
  ];
  for (const [words, why] of no) assert.equal(saysAcknowledgeFlaky(words, a), false, `"${words}" accepts nothing (${why})`);

  // The binding is to the candidate the acceptance sits nearest to: this one is nearer, so it is the owner's acceptance of this one.
  assert.equal(saysAcknowledgeFlaky(`approve ${b} and ${a}: I accept the failures of ${a}`, a), true, "the acceptance named for this candidate is for this candidate");
  // D2b: a sentence that carries the acceptance but names no candidate belongs to the candidate of the sentence before it.
  assert.equal(saysAcknowledgeFlaky(`approve ${a}. Accept the earlier failures`, a), true, "the acceptance after the candidate's name is about that candidate");
  assert.equal(saysAcknowledgeFlaky(`is ${a} the flaky one? Accept the earlier failures of ${b}`, a), false, "and still nothing when the earlier sentence was about something else");
  // With no candidate to bind to, the acceptance still has to be the owner's own unconditioned one.
  assert.equal(saysAcknowledgeFlaky("I accept the earlier failures"), true, "an acceptance with no candidate named is still an acceptance");
  assert.equal(saysAcknowledgeFlaky("Bob accepted the earlier failures"), false, "someone else's acceptance binds to nothing");
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
