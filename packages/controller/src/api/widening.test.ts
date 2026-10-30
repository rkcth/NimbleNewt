import assert from "node:assert/strict";
import { test } from "node:test";
import { wideningDecision } from "./widening.js";

test("widening: spend follows the cell, explicit or from the profile", () => {
  assert.equal(wideningDecision({ mode: "allow", explicit: false }, "spend"), "allow");
  assert.equal(wideningDecision({ mode: "allow", explicit: true }, "spend"), "allow");
  assert.equal(wideningDecision({ mode: "owner", explicit: false }, "spend"), "ask");
  assert.equal(wideningDecision({ mode: "owner", explicit: true }, "spend"), "ask");
  assert.equal(wideningDecision({ mode: "agent-review", explicit: false }, "spend"), "ask");
  assert.equal(wideningDecision({ mode: "agent-review", explicit: true }, "spend"), "ask");
});

test("widening: access-change is allowed only where the owner set the cell to allow", () => {
  assert.equal(wideningDecision({ mode: "allow", explicit: false }, "access-change"), "ask");
  assert.equal(wideningDecision({ mode: "allow", explicit: true }, "access-change"), "allow");
  assert.equal(wideningDecision({ mode: "owner", explicit: true }, "access-change"), "ask");
  assert.equal(wideningDecision({ mode: "owner", explicit: false }, "access-change"), "ask");
  assert.equal(wideningDecision({ mode: "agent-review", explicit: true }, "access-change"), "ask");
  assert.equal(wideningDecision({ mode: "agent-review", explicit: false }, "access-change"), "ask");
});
