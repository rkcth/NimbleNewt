import assert from "node:assert/strict";
import { test } from "node:test";
import { toolOutcome } from "./dispatcher.js";

// Card U09b: what each tool state means for a replay. Only a success is confirmed; a call that came back without taking effect (failed, cancelled, refused) is failed; a call still running is dispatched; one waiting
// for approval is proposed; an unknown result, and a state nobody has classified, is uncertain. Nothing but a success is ever shown as confirmed.
test("every state of a tool call has the outcome a replay can honestly show", () => {
  const table: Record<string, string> = { confirmed: "confirmed", failed: "failed", cancelled: "failed", refused: "failed", uncertain: "uncertain", "in-progress": "dispatched", "awaiting-approval": "proposed" };
  for (const [state, outcome] of Object.entries(table)) assert.equal(toolOutcome(state), outcome, state);
  assert.equal(toolOutcome("something-new"), "uncertain", "a state nobody has classified is not shown as confirmed, nor as merely waiting");
  assert.equal(toolOutcome(""), "uncertain");
});
