import assert from "node:assert/strict";
import { test } from "node:test";
import { NOT_RUN_CAUSES, notRunCause } from "./not-run-cause.js";

// W09 fixes, items 1 and 5: a questioning that did not run names its cause, read from the controller's own words.

test("each way the second agent cannot be asked has its own named cause; anything else is error", () => {
  const cases: [string | undefined, string][] = [
    ["no second agent is set up on this controller", "not-set-up"],
    ["the second agent could not be asked: no reviewer route is set, so no second agent questioned the report (the owner names one in chat, ...)", "no-route"],
    ["the second agent could not be asked: the second agent has no model route", "no-route"],
    ["the second agent could not be asked: the reviewer route local/x cannot be used: it is not in the routing table", "route-not-usable"],
    ["the second agent could not be asked: the reviewer route local/x could not be checked against the routing table: boom", "route-not-usable"],
    ["the second agent could not be asked: no route answered the second agent's questions (budget: the daily cap on the controller's own model calls (240 tokens) is reached)", "cap"],
    ["the second agent could not be asked: no route answered the second agent's questions (blocked: the route is cooling)", "route-blocked"],
    ["the second agent could not be asked: no route answered the second agent's questions (unknown: no reviewer slot came free within 45000 ms)", "busy"],
    ["the second agent could not be asked: no route answered the second agent's questions (timeout: route r/m did not answer within 120000 ms)", "timeout"],
    ["the second agent could not be asked: no route answered the second agent's questions (outage: timed out)", "timeout"],
    ["the second agent could not be asked: no route answered the second agent's questions (reply-cut: the reply was cut at the 32768-token reply limit before it held any text (the route's ceiling))", "reply-cut"],
    ["the second agent could not be asked: no route answered the second agent's questions (unknown: the reply held no text)", "no-text"],
    ["the second agent could not be asked: no route answered the second agent's questions (credit: insufficient_quota)", "provider-refused"],
    ["the second agent could not be asked: no route answered the second agent's questions (auth: unauthorized)", "provider-refused"],
    ["the second agent could not be asked: no route answered the second agent's questions (rate-limit: slow down)", "rate-limit"],
    ["the second agent could not be asked: no route answered the second agent's questions (outage: bad gateway)", "provider-unavailable"],
    ["the second agent could not be asked: no route answered the second agent's questions (invalid-request: bad field)", "request-refused"],
    ["the second agent could not be asked: no route answered the second agent's questions (context-overflow: too long)", "request-refused"],
    ["the second agent could not be asked: something new", "error"],
    [undefined, "error"],
    ["", "error"],
  ];
  for (const [why, cause] of cases) assert.equal(notRunCause(why), cause, String(why));
  for (const [, cause] of cases) assert.ok((NOT_RUN_CAUSES as readonly string[]).includes(cause));
  // Every named cause is reachable from some text.
  assert.deepEqual([...new Set(cases.map(([, c]) => c))].sort(), [...NOT_RUN_CAUSES].sort());
});
