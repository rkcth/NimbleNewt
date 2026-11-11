import assert from "node:assert/strict";
import { test } from "node:test";
import { MIN_WORKABLE_CONTEXT_TOKENS } from "@nimblenewt/controller";
import { MIN_WORKABLE_WINDOW, compactionThresholds } from "@nimblenewt/pi-adapter";

test("the setup step and the worker refuse the same smallest window (card CMP)", () => {
  assert.equal(MIN_WORKABLE_CONTEXT_TOKENS, MIN_WORKABLE_WINDOW);
  assert.doesNotThrow(() => compactionThresholds(MIN_WORKABLE_CONTEXT_TOKENS));
  assert.throws(() => compactionThresholds(MIN_WORKABLE_CONTEXT_TOKENS - 1));
});
