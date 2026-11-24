import assert from "node:assert/strict";
import { test } from "node:test";
import { allows, allowsExactly, requireAction } from "./access.js";
import type { Principal } from "./index.js";

// An access check judges a grant's expiry at the time the principal's rights were loaded (its `asOf`, read from the controller's clock),
// never at the machine's clock: a rig or a replay that runs on its own clock gets the same answer whenever the test is run.
// Both dates below lie long before any real run of this test, so the machine's clock is always after the expiry.
const AS_OF = "2026-01-10T12:00:00.000Z";
const EXPIRES = "2026-02-01T00:00:00.000Z";
const AFTER_EXPIRY = "2026-02-02T00:00:00.000Z";
const agent = (asOf: string | undefined): Principal => ({
  id: "agent:a", kind: "agent", name: "a", asOf, restrictions: [],
  grants: [{ action: "task.read", project: "p1", source: "direct", expiresAt: EXPIRES }],
} as unknown as Principal);

test("a grant that ends after the principal's own as-of time holds, whatever the machine's clock says", () => {
  assert.equal(allows(agent(AS_OF), "task.read", "p1"), true);
  assert.equal(allowsExactly(agent(AS_OF), "task.read", "p1"), true);
  assert.doesNotThrow(() => requireAction(agent(AS_OF), "task.read", "p1"));
});

test("a grant that has ended as of the principal's time does not hold, and an explicit time still wins", () => {
  assert.equal(allows(agent(AFTER_EXPIRY), "task.read", "p1"), false);
  assert.equal(allowsExactly(agent(AFTER_EXPIRY), "task.read", "p1"), false);
  assert.equal(allows(agent(AS_OF), "task.read", "p1", { now: AFTER_EXPIRY }), false);
  assert.equal(allows(agent(AFTER_EXPIRY), "task.read", "p1", { now: AS_OF }), true);
});

test("a principal whose rights were never loaded is refused rather than trusted", () => {
  assert.equal(allows(agent(undefined), "task.read", "p1"), false);
});
