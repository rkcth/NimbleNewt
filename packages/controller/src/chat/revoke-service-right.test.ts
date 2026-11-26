import assert from "node:assert/strict";
import { test } from "node:test";
import { STATUS_KINDS } from "../status/index.js";
import { ownerSaysMove, proposalReason } from "./commands.js";
import { promptAbout } from "./model-interpreter.js";

// Card P03b review: taking back a right on one service resource applies at once only when the owner's own sentence orders it. The verb must stand outside the names of the right (a resource called
// stop-list or an agent called Block does not order it by being named), and a sentence that says not to, or asks, does not count: it is shown first.

const targets = ["grt-abc", "billing/stop-list", "billing", "stop-list", "Block"];
const says = (text: string): boolean => ownerSaysMove("grant.revoke", { grantId: "grt-abc" }, text, targets);

test("taking back a right on one service resource counts only as an order in the owner's own words (card P03b review)", () => {
  for (const text of ["Take back grt-abc.", "Revoke grt-abc: Block should no longer change billing/stop-list.", "Under grt-abc, Block may not edit any more.", "Restrict grt-abc now."]) assert.equal(says(text), true, text);
  for (const text of [
    "Should I take back grt-abc?",
    "Tell me about grt-abc on billing/stop-list.",
    "What does grt-abc let Block do.",
    "Don't take back grt-abc.",
    "Do not revoke grt-abc yet.",
    "Never mind, I won't revoke grt-abc.",
    "Not yet: revoke grt-abc tomorrow.",
    "Hold off on removing grt-abc, then revoke it later.",
  ]) assert.equal(says(text), false, text);
  // What it decides: a service right taken back in the owner's words applies at once; any other wording shows it first.
  const reason = (said: boolean) => proposalReason("grant.revoke", { grantId: "grt-abc" }, false, { profile: "derived", quoted: false, said, serviceRight: true });
  assert.equal(reason(says("Take back grt-abc.")), undefined);
  assert.match(String(reason(says("Don't take back grt-abc."))), /shown first/);
  assert.match(String(proposalReason("grant.revoke", { grantId: "grt-abc" }, false, { profile: "derived", quoted: false, said: true })), /a right is shown first/, "a right that is not on one service resource is shown first");
  assert.match(String(proposalReason("grant.revoke", { grantId: "grt-abc" }, false, { profile: "derived", quoted: true, said: true, serviceRight: true })), /quoted text/, "quoted material shows it first");
});

test("the status kinds are described to the model without their card references and without losing anything else (card P03b review)", () => {
  assert.equal(promptAbout("what failed (card Q04) and why (card P03b)"), "what failed and why");
  assert.equal(promptAbout("how work lands (card P09/P10): where"), "how work lands: where");
  assert.equal(promptAbout("cards (and why)"), "cards (and why)");
  for (const [kind, k] of Object.entries(STATUS_KINDS)) {
    const told = promptAbout(k.about);
    assert.ok(told.length > 0 && !/\(card /.test(told), kind);
    // Only the references go: put back, word for word, the rest is the description as written.
    assert.equal(told.split(/\s+/).join(" "), k.about.replace(/\s*\(card [A-Z][0-9A-Za-z]*(?:\/[A-Z][0-9A-Za-z]*)*\)/g, "").split(/\s+/).join(" "), kind);
  }
});
