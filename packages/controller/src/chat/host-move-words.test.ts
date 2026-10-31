import assert from "node:assert/strict";
import { test } from "node:test";
import { ordersHostMove } from "./policy-edit.js";

test("the owner's words order a host move only with an imperative move verb that governs the host and no negation", () => {
  for (const yes of ["move the work off host:r1", "Please move all the work off host:r1.", "take the work away from host:r1", "Relocate everything from host:r1", "move the work off the host:r1 now"]) assert.equal(ordersHostMove(yes, "host:r1"), true, yes);
  for (const no of [
    "Take a look at host:r1", "Don't move the work off host:r1", "never take the work off host:r1", "I do not want you to move the work off host:r1",
    "should we move the work off host:r1?", "maybe move the work off host:r1", "host:r1 is slow", "move the work off host:r10", "move the work off host:r2", "I'd like a look at the work on host:r1",
  ]) assert.equal(ordersHostMove(no, "host:r1"), false, no);
});
