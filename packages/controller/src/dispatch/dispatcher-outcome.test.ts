import assert from "node:assert/strict";
import { test } from "node:test";
import { toolOutcome } from "./dispatcher.js";

// Card U09b: what each tool state means for a replay. The answer is known for a success, a failure and a cancel (the step's words say which); a call still running is dispatched; one that was asked for and not carried
// out (refused, waiting for approval) is only proposed; an unknown result is never shown as confirmed.
test("every state of a tool call has the outcome a replay can honestly show", () => {
  const table: Record<string, string> = { confirmed: "confirmed", failed: "confirmed", cancelled: "confirmed", uncertain: "uncertain", "in-progress": "dispatched", "awaiting-approval": "proposed", refused: "proposed" };
  for (const [state, outcome] of Object.entries(table)) assert.equal(toolOutcome(state), outcome, state);
  assert.equal(toolOutcome("something-new"), "proposed", "a state nobody has classified is not shown as confirmed");
});
