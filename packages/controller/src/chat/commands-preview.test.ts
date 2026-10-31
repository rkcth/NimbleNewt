import assert from "node:assert/strict";
import { test } from "node:test";
import { describe } from "./commands.js";

test("a grant.create preview shows the real end time, or permanent only when there is none", () => {
  const given = describe("grant.create", { grantee: "service:dispatcher", action: "recovery.stall-scan", project: "*", expiresAt: "2026-12-01T00:00:00.000Z" }, {});
  assert.match(given, /\(ends 2026-12-01T00:00:00\.000Z\)/);
  assert.doesNotMatch(given, /permanent/);
  assert.match(describe("grant.create", { grantee: "service:dispatcher", action: "recovery.stall-scan", project: "*" }, {}), /\(permanent: no end time\)/);
});

test("the end of a grant is said before the long basis, so a truncated line still shows it", () => {
  const basis = `chat, edit pedit-x: "${"let her commit ".repeat(40)}" Length: no end`;
  const wide = Object.fromEntries(["terms", "reason", "note", "source", "extra"].map((k) => [k, "x".repeat(300)]));
  const line = describe("grant.create", { grantee: "agent:ann", action: "approve.class.commit", project: "proj-x", basis, ...wide }, {});
  assert.match(line, /\(permanent: no end time\)/);
  const ends = describe("grant.create", { grantee: "agent:ann", action: "approve.class.commit", project: "proj-x", basis, ...wide, expiresAt: "2026-12-01T00:00:00.000Z" }, {});
  assert.match(ends, /\(ends 2026-12-01T00:00:00\.000Z\)/);
});
