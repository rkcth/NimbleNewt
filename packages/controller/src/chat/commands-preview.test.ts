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
  assert.match(line, /^Grant right \(no end: it never runs out and stays until you revoke it; only in "Garden b+[^"]*"\)/, line);
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

test("a right that starts later says the day it begins on, before the names, along with its end", () => {
  const both = describe("grant.create", { grantee: "agent:ann", action: "approve.class.commit", project: "proj-x", expiresAt: "2026-12-20T00:00:00.000Z", notBefore: "2026-12-01T00:00:00.000Z" }, {});
  assert.ok(both.startsWith("Grant right (ends 2026-12-20T00:00:00.000Z; starts 2026-12-01T00:00:00.000Z; only in proj-x)"), both);
  const begins = describe("grant.create", { grantee: "agent:ann", action: "approve.class.commit", project: "*", notBefore: "2026-12-01T00:00:00.000Z" }, {});
  assert.ok(begins.startsWith("Grant right (no end: it never runs out and stays until you revoke it; starts 2026-12-01T00:00:00.000Z; everywhere: it covers every project, including ones made later)"), begins);
  const long = "a".repeat(80);
  const basis = `owner chat: ${"let it run ".repeat(40)}`;
  const cut = describe("grant.create", { grantee: `agent:${long}`, action: `approve.${long}`, project: "proj-x", basis, notBefore: "2026-12-01T00:00:00.000Z", expiresAt: "2026-12-20T00:00:00.000Z" }, { "proj-x": `Garden ${"b".repeat(200)}` });
  assert.ok(cut.endsWith("..."), `the line is cut: ${cut}`);
  assert.ok(cut.startsWith('Grant right (ends 2026-12-20T00:00:00.000Z; starts 2026-12-01T00:00:00.000Z; only in "Garden '), `both days are said before any name, so a cut line still shows them: ${cut}`);
  assert.ok(!cut.slice(0, cut.indexOf(": grantee")).includes("approve.class.commit"), "the names come after the parenthetical");
});

test("a right's days are escaped once on the line, so a value can never start a second line", () => {
  const line = describe("grant.create", { grantee: "agent:ann", action: "approve.class.commit", project: "proj-x", notBefore: "2026-12-01\u0007T00:00:00.000Z", expiresAt: "2026-12-20\u001b[31m\u2028T00:00:00.000Z" }, {});
  assert.doesNotMatch(line, /[\u2028\u2029\u001b\u0007\n\r]/, "no separator or control survives");
  assert.match(line, /ends 2026-12-20\\u\{1b\}\[31m T00:00:00\.000Z/, `a control becomes its escape and a line separator a space: ${line}`);
  assert.match(line, /starts 2026-12-01\\u\{7\}T00:00:00\.000Z/, line);
  assert.doesNotMatch(line, /\\\\u\{|\\u\{\\u/, "nothing is escaped twice");
});
