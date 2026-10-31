import assert from "node:assert/strict";
import { test } from "node:test";
import { describe } from "./commands.js";

test("a grant.create preview shows the real end time, or permanent only when there is none", () => {
  const given = describe("grant.create", { grantee: "service:dispatcher", action: "recovery.stall-scan", project: "*", expiresAt: "2026-12-01T00:00:00.000Z" }, {});
  assert.match(given, /\(ends 2026-12-01T00:00:00\.000Z\)/);
  assert.doesNotMatch(given, /permanent/);
  assert.match(describe("grant.create", { grantee: "service:dispatcher", action: "recovery.stall-scan", project: "*" }, {}), /\(permanent: no end time\)/);
});
