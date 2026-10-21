import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTRACTS_VERSION, requestId } from "./index.js";

test("requestId accepts a non-empty value unchanged", () => {
  assert.equal(requestId("operation-1"), "operation-1");
});

test("requestId rejects an empty value", () => {
  assert.throws(() => requestId(""), /must not be empty/);
});

test("the contracts version is a positive whole number, bumped only on a breaking change", () => {
  assert.ok(Number.isSafeInteger(CONTRACTS_VERSION) && CONTRACTS_VERSION >= 1);
});
