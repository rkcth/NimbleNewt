import assert from "node:assert/strict";
import { test } from "node:test";
import { MINIMUM_SERVER_VERSION_NUM, lowerServerFloorForVerification, serverVersionProblem } from "./storage.js"; // the floor seam is deliberately not part of the public index

test("PostgreSQL 17 and above are accepted, older majors are refused with the supported minimum named", () => {
  assert.equal(MINIMUM_SERVER_VERSION_NUM, 170000);
  for (const [num, version] of [[170000, "17.0"], [170010, "17.10"], [180004, "18.4"], [190000, "19.0"]] as const) assert.equal(serverVersionProblem(num, version), undefined, version);
  for (const [num, version] of [[160014, "16.14"], [150018, "15.18"], [140023, "14.23"], [130000, "13.0"], [0, "?"]] as const) {
    assert.match(serverVersionProblem(num, version) ?? "", new RegExp(`PostgreSQL ${version.replace(/[.?]/g, "\\$&")} is older than the minimum .* supports \\(17\\)`), version);
  }
});

test("the floor can be lowered for verification only down to PostgreSQL 14 and never above the supported minimum", () => {
  for (const bad of [0, 139999, 170001, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) assert.throws(() => lowerServerFloorForVerification(bad), RangeError, String(bad));
  assert.equal(serverVersionProblem(150000, "15.0", 140000), undefined, "an explicit lower floor is honoured by the check");
  assert.ok(serverVersionProblem(130000, "13.0", 140000));
});
