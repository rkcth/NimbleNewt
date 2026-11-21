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

test("first review: more of the usual ways of saying a length are read", () => {
  for (const [minutes, start, words] of [
    [150, "02:00", "let's do 2am, two and a half hours"],
    [75, "02:00", "at 2am for an hour and a quarter"],
    [45, "02:00", "at 2am for three quarters of an hour"],
    [720, "00:00", "starting at midnight for twelve hours"],
    [90, "03:00", "3am until 4.30"],
    [180, "01:00", "from one to four am"],
    [120, "23:00", "tonight at 11pm, should be done by 1am"],
    [30, "02:30", "at half past 2 until 3"],
    [90, "23:30", "tonight 11:30pm\u20131am"],
    [240, "22:00", "10 PM to 2 AM"],
    [60, "00:00", "from midnight to 1am"],
    [90, "03:00", "on 21/11/2026 at 3 for 90 minutes"],
    [60, "02:00", "install v2.1.3 on Nov 22 at 2 for an hour"],
  ] as const) assert.equal(windowLengthInWords(minutes, start, words), true, `${minutes} from ${start}: ${words}`);
});

test("first review: numbers that are not the window's length are not read as one", () => {
  for (const [minutes, start, words, why] of [
    [720, "02:00", "install it tonight at 2 for 2 hours, rollback to 2 if it fails", "'to 2' without am, pm or minutes is not an end time"],
    [660, "03:00", "upgrade to 2.1 tonight at 3 for an hour", "a version is not an end time"],
    [720, "02:00", "at 2am, it may take up to 2 hours", "'to 2 hours' is a length, not an end time"],
    [60, "02:00", "install it on 11-03 at 2", "a day written 11-03 is not the range 11 to 3"],
    [1140, "02:00", "install it on 11-21 at 2", "nor 11-21"],
    [240, "11:00", "install it on 11-03 at 11", "nor 11-03 when the start is 11 (a dash range's end has no leading zero)"],
    [780, "15:00", "Nov 3 at 2 until 4", "the day after a month is not the start"],
    [1440, "03:00", "install it the next day at 3am", "the next day is when, not how long"],
    [1440, "03:00", "install it in a day at 3am", "nor in a day"],
    [120, "02:00", "install it in 2 hours", "nor in 2 hours"],
    [30, "02:00", "at 2, start preparing 30 minutes before", "a preparation lead is not the length"],
    [300, "02:00", "at 2, give it 1,5 hours", "a decimal comma is not two numbers"],
    [120, "02:00", "install it tonight until 4", "an end time with no start written: the start would be the model's"],
    [720, "16:00", "install it tonight until 4", "the end time is not its own start"],
    [30, "00:00", "at 0 until 24:30", "24:30 is not a time of day"],
    [120, "02:00", "at 2 until 16am", "16am is not a time of day (not 4am)"],
    [60, "02:00", "install it at 2 until \u0663", "only ASCII digits are read"],
    [60, "02:00", "at 2 for \uff16\uff10 minutes", "nor full-width ones"],
    [60, "02:00", "at 2 for 60000000000000000000 minutes", "a huge number is not a small one"],
  ] as const) assert.equal(windowLengthInWords(minutes, start, words), false, `${why}: ${words}`);
});

test("second review: a bare hour range of things counted is not a time range, and an end said as 'ending at' or 'o'clock' is read", () => {
  for (const [minutes, start, words, why] of [
    [60, "02:00", "install at 2 to 3 hosts", "hosts are counted, not hours"],
    [60, "02:00", "install release 2-3 at 2", "a release number range is not a window"],
    [60, "02:00", "at 2, scale 2 to 3 workers", "nor a count of workers"],
    [120, "02:00", "at 2, scale from 2 to 4 workers", "nor after 'from'"],
    [60, "02:00", "at 2, the 2-3 nodes are fine", "nor nodes after 'the'"],
    [120, "02:00", "at 2, version 2 through 4 are broken", "nor versions"],
    [60, "02:00", "at 2, keep 2 to 3 copies", "nor copies"],
    [120, "02:00", "install on 2 hosts until 4", "the start is not written as a time"],
    [60, "02:00", "at 2, wait until 3 hosts are drained", "an end of a count is not an end time"],
    [60, "02:00", "install at 2, I said so 60 minutes ago", "a time ago is not a length"],
    [60, "02:00", "install at 2, check every 60 minutes", "a period is not a length"],
  ] as const) assert.equal(windowLengthInWords(minutes, start, words), false, `${why}: ${words}`);
  for (const [minutes, start, words] of [
    [120, "02:00", "install the update from 2 to 4 London time"],
    [120, "02:00", "from 2 to 4 in the morning"],
    [120, "02:00", "Saturday 2 to 4"],
    [120, "02:00", "2 to 4 works for me"],
    [60, "02:00", "between 2 and 3 would be great"],
    [120, "02:00", "tonight 2-4"],
    [60, "02:00", "window at 2 ending at 3"],
    [60, "02:00", "run it at 2, stop at 3"],
    [60, "02:00", "start at 2am, end at 3am"],
    [60, "02:00", "2am, wrap up by 3"],
    [60, "02:00", "let's say 2 until 3, ok?"],
    [120, "02:00", "2 o'clock to 4 o'clock"],
    [60, "02:00", "at 2 until 3 New York time"],
  ] as const) assert.equal(windowLengthInWords(minutes, start, words), true, `${minutes} from ${start}: ${words}`);
  assert.equal(leadInWords(5, "install at 2 for an hour, I asked 5 minutes ago"), false, "a time ago is not a lead");
  assert.equal(sizeInWords(1000, "install at 2 for an hour, 1k tasks are waiting"), false, "a thousand tasks is not a size");
  assert.equal(sizeInWords(2e12, "at 2 for an hour, step 2 t"), false, "nor a bare t");
});

test("re-check: a number word run into a unit is another word ('and' is not 'an d', 'am' not 'a m', 'ah' not 'a h')", () => {
  assert.equal(windowLengthInWords(1440, "02:00", "install at 2 and 3 on Sunday"), false, "'and' is not one day");
  assert.equal(windowLengthInWords(1440, "02:00", "between 2 and 3 releases are staged"), false, "nor here");
  assert.equal(windowLengthInWords(60, "02:00", "ah, install at 2, one sec"), false, "'ah' is not an hour");
  assert.equal(leadInWords(1440, "install at 2 for an hour and back up first"), false, "'and' is not a one-day lead");
  assert.equal(leadInWords(60, "ah ok, install at 2 for two hours"), false, "'ah' is not an hour's lead");
  assert.equal(sizeInWords(1, "at 2 for an hour, ab testing is off"), false, "'ab' is not a byte");
  // Still read: a number word apart from its unit, or joined by a hyphen; digits run into a unit.
  assert.equal(windowLengthInWords(1440, "02:00", "install at 2 for a day and check it"), true);
  assert.equal(windowLengthInWords(60, "02:00", "at 2 for a one-hour window and then stop"), true);
  assert.equal(windowLengthInWords(90, "02:00", "at 2 and keep it open 90m"), true);
  assert.equal(leadInWords(60, "at 2 for two hours and start preparing an hour before"), true);
  assert.equal(sizeInWords(1e9, "at 2 for an hour and keep a gigabyte free"), true);
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
  assert.equal(sizeInWords(5e9, "keep 2,5 GB free"), false, "a decimal comma is not two numbers");
  assert.equal(sizeInWords(5e9, "make sure 5,000 MB is free"), true, "a thousands comma is");
  assert.equal(sizeInWords(10 * 1024 ** 3, "make sure 5 GB is free"), false, "a different size");
  assert.equal(sizeInWords(1024 ** 3, "install it tonight at 2 for an hour"), false, "no size at all");
});
