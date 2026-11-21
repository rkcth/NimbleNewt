import assert from "node:assert/strict";
import { test } from "node:test";
import { leadInWords, sizeInWords, windowLengthInWords } from "./commands.js";

/**
 * Card K07 follow-up: the numbers a maintenance window is set with in chat are the owner's own. A length is found said outright, as hours and minutes together, or as an end time after the start
 * the proposal shows; a preparation lead and a free-space figure only when the owner said them. A number the model added is not found, so the chat asks instead of proposing it.
 */

test("a window's length counts when the owner said it, in any of the usual ways", () => {
  assert.equal(windowLengthInWords(90, "03:00", "install the update the day after tomorrow at 3am London time for 90 minutes"), true);
  assert.equal(windowLengthInWords(60, "02:00", "put the update on tonight at 2 for an hour"), true);
  assert.equal(windowLengthInWords(90, "02:00", "install it tonight at 2 for an hour and a half"), true);
  assert.equal(windowLengthInWords(150, "02:00", "install it tonight at 2, 2 hours and 30 minutes should do"), true);
  assert.equal(windowLengthInWords(90, "02:00", "install it tonight at 2, give it 1h30m"), true);
  assert.equal(windowLengthInWords(120, "02:00", "install the update tonight from 2 to 4am"), true);
  assert.equal(windowLengthInWords(90, "03:00", "install the update on Saturday, 3am until 4:30"), true);
  assert.equal(windowLengthInWords(60, "02:00", "install it tonight between 2 and 3"), true);
  assert.equal(windowLengthInWords(120, "02:00", "install it tonight 2-4am London time"), true);
  assert.equal(windowLengthInWords(120, "22:00", "install it from 10pm till midnight"), true, "an end past midnight wraps round the clock");
  assert.equal(windowLengthInWords(60, "11:00", "install it at 11 until noon"), true);
  assert.equal(windowLengthInWords(120, "14:00", "install it at 2pm until 4"), true, "an end time without am or pm is read both ways");
});

test("a window's length the owner did not say is not found", () => {
  assert.equal(windowLengthInWords(60, "02:00", "install the update tonight at 2"), false, "no length at all");
  assert.equal(windowLengthInWords(90, "02:00", "put the update on tonight at 2 for an hour"), false, "a different length");
  assert.equal(windowLengthInWords(120, "02:00", "install the update tonight from 2 to 3am"), false, "a different end time");
  assert.equal(windowLengthInWords(120, "02:00", "install it from 2am to 4pm"), false, "4pm is not two hours after 2am: an end time the owner marked am or pm is read only that way");
  assert.equal(windowLengthInWords(60, "02:00", "install rcn-0123456789abcdef0123 on 2026-11-03 at 2"), false, "digits inside an ID or an ISO day are not a length or an end time (11-03 is not 'until 3')");
  assert.equal(windowLengthInWords(60, "02:00", "install rcn-0123456789abcdef0123 on 2026-11-03 at 2 until 3"), true, "the same message with the end time said");
  assert.equal(windowLengthInWords(60, undefined, "install it tonight until 3"), false, "an end time needs the start it is measured from");
  assert.equal(windowLengthInWords(0, "02:00", "install it tonight for 0 minutes"), false, "no length is zero");
});

test("a preparation lead counts only when the owner said it, none included", () => {
  assert.equal(leadInWords(30, "install it tonight at 2 for an hour and start preparing 30 minutes before"), true);
  assert.equal(leadInWords(120, "start preparing two hours ahead"), true);
  assert.equal(leadInWords(0, "install it at 2 with no lead time"), true);
  assert.equal(leadInWords(0, "prepare 0 minutes before"), true);
  assert.equal(leadInWords(30, "install it tonight at 2 for an hour"), false, "a lead the owner never said");
  assert.equal(leadInWords(0, "install it tonight at 2 for an hour"), false, "nor none");
});

test("a free-space figure counts only when the owner said it, in powers of ten or of 1024", () => {
  assert.equal(sizeInWords(5 * 1024 ** 3, "make sure 5 GB is free"), true);
  assert.equal(sizeInWords(5e9, "make sure 5 GB is free"), true);
  assert.equal(sizeInWords(2 * 1024 ** 3, "keep two gigabytes free"), true);
  assert.equal(sizeInWords(500 * 1024 ** 2, "needs 500 MiB free"), true);
  assert.equal(sizeInWords(1.5e12, "needs 1.5 TB free"), true);
  assert.equal(sizeInWords(0, "keep 0 bytes free"), true);
  assert.equal(sizeInWords(1_073_741_824, "keep 1,073,741,824 bytes free"), true);
  assert.equal(sizeInWords(500e6, "needs 500 MiB free"), false, "MiB is only 1024s");
  assert.equal(sizeInWords(10 * 1024 ** 3, "make sure 5 GB is free"), false, "a different size");
  assert.equal(sizeInWords(1024 ** 3, "install it tonight at 2 for an hour"), false, "no size at all");
});
