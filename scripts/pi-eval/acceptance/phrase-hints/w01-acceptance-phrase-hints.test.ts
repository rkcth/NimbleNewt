import assert from "node:assert/strict";
import { test } from "node:test";
import { CHAT_OPS, describe, grantDateInWords } from "./commands.js";

// W01 acceptance for phrase-hints: grantDateInWords reads the day from the owner's words; the grant.create line says
// its end, its start and its scope before the names, each date escaped once; host.move-work is a proposal.

/** [moment the interpreter gave, the owner's words]: the owner's words name the moment's day. */
const NAMED: readonly (readonly [string, string])[] = [
  ...[
    "let the scanner approve things in Garden until 2026-11-30",
    "let the scanner approve things until the end of November 30, 2026",
    "let the scanner approve things until 30 November",
    "let the scanner approve things until Nov 30 2026",
    "let the scanner approve things until the 30th of November",
    "let the scanner approve things until November 30th, 2026",
    "let the scanner approve things until 11/30/2026",
    "let the scanner approve things until 30/11/2026",
    "let the scanner approve things until 2026-11-30T23:59",
    "until 2026-11-30T23:59:59.000Z, let the scanner approve things",
    "LET THE SCANNER APPROVE THINGS UNTIL 30 NOVEMBER 2026",
  ].map((said) => ["2026-11-30T23:59:59.000Z", said] as const),
  ["2026-12-01T00:00:00.000Z", "from 2026-12-01 the scanner may approve things"],
  ["2026-12-01T00:00:00.000Z", "starting December 1, the scanner may approve things"],
  // The owner's calendar day in the moment's own offset, and the UTC day.
  ["2026-11-30T23:59-08:00", "let the scanner approve things until Nov 30"],
  ["2026-11-30T00:00+09:00", "from 30 November the scanner may approve things"],
  ["2026-11-30T23:59:59-05:00", "until 2026-11-30, let the scanner approve things"],
  ["2026-11-30T23:59-08:00", "until December 1st"],
  ["2026-11-30T00:00:00.000Z", "until 2026-11-30"],
  ["2026-11-30T00:00:00.000Z", "let it run until 30 Nov 26"],
];
/** [value, the owner's words]: no day of the value is named, or the value is not a moment. */
const NOT_NAMED: readonly (readonly [unknown, string])[] = [
  ...[
    "let the scanner approve things until the end of the month",
    "let the scanner approve things until the audit is done",
    "let the scanner approve things for a few more days",
    "let the scanner approve things until November",
    "let the scanner approve things until Friday",
    "let the scanner approve things until 2026-11-3",
    "let the scanner approve things until 2026-12-02",
  ].map((said) => ["2026-11-30T23:59:59.000Z", said] as const),
  ["2027-11-30T00:00:00.000Z", "let it run until November 30 2026"],
  ["2026-12-30T00:00:00.000Z", "let it run until 30 November 2026"],
  ["2026-11-30T23:59-08:00", "until November 29"],
  ...["next friday", "", "   ", "2026-13-45", null, 1_764_499_200_000, undefined].map((value) => [value, "let it run until 2026-11-30"] as const),
];

test("a right's day is accepted from ordinary sentences that name it, and the moment itself comes back in UTC", () => {
  for (const [value, said] of NAMED) assert.equal(grantDateInWords(value, said), new Date(value).toISOString(), `${value} / ${said}`);
});

test("a day the owner did not name is not a date, whatever the model put in the argument", () => {
  for (const [value, said] of NOT_NAMED) assert.equal(grantDateInWords(value, said), undefined, `${String(value)} / ${said}`);
});

test("a right's line says when it ends, when it starts and where it reaches, before the names", () => {
  const both = describe("grant.create", { grantee: "agent:ann", action: "approve.class.commit", project: "proj-x", expiresAt: "2026-12-20T00:00:00.000Z", notBefore: "2026-12-01T00:00:00.000Z" }, {});
  assert.ok(both.startsWith("Grant right (ends 2026-12-20T00:00:00.000Z; starts 2026-12-01T00:00:00.000Z; only in proj-x)"), both);
  const begins = describe("grant.create", { grantee: "agent:ann", action: "approve.class.commit", project: "*", notBefore: "2026-12-01T00:00:00.000Z" }, {});
  assert.ok(begins.startsWith("Grant right (no end: it never runs out and stays until you revoke it; starts 2026-12-01T00:00:00.000Z; everywhere: it covers every project, including ones made later)"), begins);
  const long = "a".repeat(80);
  const basis = `owner chat: ${"let it run ".repeat(40)}`;
  const cut = describe("grant.create", { grantee: `agent:${long}`, action: `approve.${long}`, project: "proj-x", basis, notBefore: "2026-12-01T00:00:00.000Z", expiresAt: "2026-12-20T00:00:00.000Z" }, { "proj-x": "Garden" });
  assert.ok(cut.startsWith('Grant right (ends 2026-12-20T00:00:00.000Z; starts 2026-12-01T00:00:00.000Z; only in "Garden")'), cut);
});

test("a right's days are escaped once on the line, so a value can never start a second line", () => {
  const line = describe("grant.create", { grantee: "agent:ann", action: "approve.class.commit", project: "proj-x", notBefore: "2026-12-01\u0007T00:00:00.000Z", expiresAt: "2026-12-20\u001b[31m\u2028T00:00:00.000Z" }, {});
  assert.doesNotMatch(line, /[\u2028\u2029\u001b\u0007\n\r]/, "no separator or control survives");
  assert.match(line, /ends 2026-12-20\\u\{1b\}\[31m T00:00:00\.000Z/, line);
  assert.match(line, /starts 2026-12-01\\u\{7\}T00:00:00\.000Z/, line);
  assert.doesNotMatch(line, /\\\\u\{|\\u\{\\u/, "nothing is escaped twice");
});

test("moving the work off a host is a proposal in the chat's table", () => {
  assert.equal(CHAT_OPS["host.move-work"]?.mode, "propose");
});
