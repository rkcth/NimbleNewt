import assert from "node:assert/strict";
import { test } from "node:test";
import { grantDateInWords } from "./commands.js";

/**
 * The day a right starts or ends is the owner's or nobody's (card U03e). What is checked is the *day*, not a form of words: any sentence that names the day works, in any order and spelling, and the
 * moment the proposal line shows is what the owner confirms. A phrase that names no day the controller can check gives no date, so the day would be the model's and the right is not drawn up.
 */
test("a right's day is accepted from ordinary sentences that name it", () => {
  const end = "2026-11-30T23:59:59.000Z";
  for (const said of [
    "let the scanner approve things in Garden until 2026-11-30",
    "let the scanner approve things in Garden until the end of November 30, 2026",
    "let the scanner approve things until 30 November",
    "let the scanner approve things until Nov 30 2026",
    "let the scanner approve things until the 30th of November",
    "let the scanner approve things until November 30th, 2026",
    "let the scanner approve things until 11/30/2026",
    "let the scanner approve things until 30/11/2026",
    "let the scanner approve things until 2026-11-30T23:59",
    "until 2026-11-30T23:59:59.000Z, let the scanner approve things",
    "LET THE SCANNER APPROVE THINGS UNTIL 30 NOVEMBER 2026",
  ]) assert.equal(grantDateInWords(end, said), end, said);
});

test("a start day is read the same way as an end day", () => {
  const start = "2026-12-01T00:00:00.000Z";
  assert.equal(grantDateInWords(start, "from 2026-12-01 the scanner may approve things"), start);
  assert.equal(grantDateInWords(start, "starting December 1, the scanner may approve things"), start);
});

test("a day the owner did not name is not a date, whatever the model put in the argument", () => {
  const end = "2026-11-30T23:59:59.000Z";
  for (const said of [
    "let the scanner approve things until the end of the month",
    "let the scanner approve things until the audit is done",
    "let the scanner approve things for a few more days",
    "let the scanner approve things until November",
    "let the scanner approve things until Friday",
    "the scanner may be busy for 2026-11-30-days worth of work",
    "grant grt-2026-11-30-x may approve things until then",
    "let the scanner approve things until 2026-11-3",
    "let the scanner approve things until 1-30-2026",
  ]) assert.equal(grantDateInWords(end, said), undefined, said);
});

test("a year the owner wrote has to be the year on the moment, and a written month has to be the month on it", () => {
  assert.equal(grantDateInWords("2027-11-30T00:00:00.000Z", "let it run until November 30 2026"), undefined, "the owner's year is 2026, the moment says 2027");
  assert.equal(grantDateInWords("2026-12-30T00:00:00.000Z", "let it run until 30 November 2026"), undefined, "the owner's month is November, the moment says December");
  assert.equal(grantDateInWords("2026-11-30T00:00:00.000Z", "let it run until 30 Nov 26"), "2026-11-30T00:00:00.000Z", "a two-digit year the owner wrote counts as their own spelling");
});

test("something that is not a moment at all is refused, not guessed at", () => {
  for (const value of ["next friday", "", "   ", "2026-13-45", "0", null, 1_764_499_200_000, undefined]) {
    assert.equal(grantDateInWords(value, "let it run until 2026-11-30"), undefined, JSON.stringify(value));
  }
});
