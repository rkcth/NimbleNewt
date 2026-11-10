import assert from "node:assert/strict";
import { test } from "node:test";
import { JOB_WAKE_RULE } from "@nimblenewt/controller";
import { COMPLETION_JOB_RULE, COMPLETION_RULES, JOB_WAKE_RULE_TEXT } from "@nimblenewt/pi-adapter";

// Card W06. The pi-adapter may not import the controller (package boundaries), so the job rule of card W11 is written twice: the controller's JOB_WAKE_RULE (the job-start reply) and the adapter's copy in the completion rules.
test("W06: the completion rules carry W11's job rule word for word, the same sentence as the job-start reply", () => {
  assert.equal(JOB_WAKE_RULE_TEXT, JOB_WAKE_RULE, "the two copies of the job rule are equal");
  assert.ok(COMPLETION_JOB_RULE.endsWith(JOB_WAKE_RULE));
  assert.ok(COMPLETION_RULES.includes(JOB_WAKE_RULE));
});
