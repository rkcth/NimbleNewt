import assert from "node:assert/strict";
import { test } from "node:test";
import { describe } from "./commands.js";

test("a grant.create preview shows the real end time, or that it has no end only when there is none", () => {
  const given = describe("grant.create", { grantee: "service:dispatcher", action: "recovery.stall-scan", project: "*", expiresAt: "2026-12-01T00:00:00.000Z" }, {});
  assert.match(given, /\(ends 2026-12-01T00:00:00\.000Z; everywhere: it covers every project/);
  assert.doesNotMatch(given, /permanent/);
  const open = describe("grant.create", { grantee: "service:dispatcher", action: "recovery.stall-scan", project: "*" }, {});
  assert.match(open, /\(no end: it never runs out and stays until you revoke it; everywhere: it covers every project, including ones made later\)/, "both consequences are said in plain words");
  assert.match(describe("grant.create", { grantee: "service:dispatcher", action: "recovery.stall-scan", project: "proj-x" }, {}), /\(no end: it never runs out and stays until you revoke it; only in proj-x\)/, "one project: the end and that one project");
});

test("a right's scope is said before the names and the basis, so a truncated line still shows which project it reaches", () => {
  const long = "a".repeat(80);
  const line = describe("grant.create", { basis: `owner chat: ${"let it run ".repeat(30)}`, grantee: `agent:${long}`, action: `approve.${long}`, project: "proj-x" }, { "proj-x": `Garden ${"b".repeat(200)}` });
  assert.ok(line.endsWith("..."), "the line is cut");
  assert.match(line, /^Grant right \(no end: it never runs out and stays until you revoke it; only in "Garden b+\.\.\."\)/, line);
  assert.match(describe("grant.create", { basis: "x".repeat(200), grantee: `agent:${long}`, action: `approve.${long}`, project: "*" }, {}), /^Grant right \(no end[^)]*; everywhere: it covers every project/);
});

test("the end of a grant is said before the long basis, so a truncated line still shows it", () => {
  const basis = `chat, edit pedit-x: "${"let her commit ".repeat(40)}" Length: no end`;
  const wide = Object.fromEntries(["terms", "reason", "note", "source", "extra"].map((k) => [k, "x".repeat(300)]));
  const line = describe("grant.create", { grantee: "agent:ann", action: "approve.class.commit", project: "proj-x", basis, ...wide }, {});
  assert.match(line, /\(no end: it never runs out/);
  const ends = describe("grant.create", { grantee: "agent:ann", action: "approve.class.commit", project: "proj-x", basis, ...wide, expiresAt: "2026-12-01T00:00:00.000Z" }, {});
  assert.match(ends, /\(ends 2026-12-01T00:00:00\.000Z; only in proj-x\)/);
});
