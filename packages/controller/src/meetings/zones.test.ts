import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays, knownZone, dueSlots, instantOf, isLocalDate, nextSlot, offsetAt, wallClock, weekdayOf, type SlotRule } from "./zones.js";

const iso = (ms: number): string => new Date(ms).toISOString();
const MIN = 60_000;

test("zone names: known IANA names are accepted as given, anything else is refused", () => {
  assert.equal(knownZone("Europe/Berlin"), "Europe/Berlin");
  assert.equal(knownZone("Asia/Kolkata"), "Asia/Kolkata", "an alias is kept as written");
  for (const bad of ["Mars/Phobos", "+02:00", "", "Europe/Berlin\n", 7, undefined, "../etc"]) assert.equal(knownZone(bad), undefined, String(bad));
});

test("calendar helpers: dates, weekdays and day arithmetic across month, year and leap boundaries", () => {
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(addDays("2027-02-28", 1), "2027-03-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-01-01", -1), "2025-12-31");
  assert.equal(weekdayOf("2026-10-22"), 4, "a Thursday");
  assert.equal(isLocalDate("2026-02-30"), false);
  assert.equal(isLocalDate("2026-2-3"), false);
  assert.equal(isLocalDate("2026-10-22"), true);
});

test("Europe/Berlin: the same wall-clock time moves by the daylight-saving change, in both directions", () => {
  // CET is UTC+1 until 2026-03-29 02:00, CEST is UTC+2 until 2026-10-25 03:00.
  assert.equal(iso(instantOf("2026-03-28", "09:00", "Europe/Berlin")), "2026-03-28T08:00:00.000Z");
  assert.equal(iso(instantOf("2026-03-29", "09:00", "Europe/Berlin")), "2026-03-29T07:00:00.000Z");
  assert.equal(iso(instantOf("2026-10-24", "09:00", "Europe/Berlin")), "2026-10-24T07:00:00.000Z");
  assert.equal(iso(instantOf("2026-10-25", "09:00", "Europe/Berlin")), "2026-10-25T08:00:00.000Z");
  // The days around the change are 23 and 25 hours long, so "every 24 hours" would be wrong.
  assert.equal((instantOf("2026-03-29", "09:00", "Europe/Berlin") - instantOf("2026-03-28", "09:00", "Europe/Berlin")) / (60 * MIN), 23);
  assert.equal((instantOf("2026-10-26", "09:00", "Europe/Berlin") - instantOf("2026-10-25", "09:00", "Europe/Berlin")) / (60 * MIN), 24);
  assert.equal((instantOf("2026-10-25", "09:00", "Europe/Berlin") - instantOf("2026-10-24", "09:00", "Europe/Berlin")) / (60 * MIN), 25);
});

test("a wall-clock time inside the spring-forward gap happens just after the gap; one repeated in the fall-back hour happens at its first pass", () => {
  // 02:30 on 2026-03-29 does not exist in Berlin (02:00 jumps to 03:00): it is 03:30 CEST = 01:30Z.
  assert.equal(iso(instantOf("2026-03-29", "02:30", "Europe/Berlin")), "2026-03-29T01:30:00.000Z");
  assert.equal(wallClock(instantOf("2026-03-29", "02:30", "Europe/Berlin"), "Europe/Berlin").hour, 3);
  // 02:30 on 2026-10-25 happens twice (00:30Z in CEST and 01:30Z in CET): the first.
  assert.equal(iso(instantOf("2026-10-25", "02:30", "Europe/Berlin")), "2026-10-25T00:30:00.000Z");
  // New York: the gap is 02:00 to 03:00 on 2026-03-08 and the repeated hour is 01:00 to 02:00 on 2026-11-01.
  assert.equal(iso(instantOf("2026-03-08", "02:30", "America/New_York")), "2026-03-08T07:30:00.000Z");
  assert.equal(iso(instantOf("2026-11-01", "01:30", "America/New_York")), "2026-11-01T05:30:00.000Z");
  assert.equal(iso(instantOf("2026-11-01", "09:00", "America/New_York")), "2026-11-01T14:00:00.000Z");
  assert.equal(iso(instantOf("2026-10-31", "09:00", "America/New_York")), "2026-10-31T13:00:00.000Z");
});

test("zones with unusual rules: a half-hour daylight change (Lord Howe), a half-hour offset without one (Kolkata), a southern-hemisphere change (Auckland), and UTC", () => {
  // Lord Howe is UTC+11 in summer and +10:30 in winter; DST ends 2026-04-05.
  assert.equal(iso(instantOf("2026-04-04", "09:00", "Australia/Lord_Howe")), "2026-04-03T22:00:00.000Z");
  assert.equal(iso(instantOf("2026-04-06", "09:00", "Australia/Lord_Howe")), "2026-04-05T22:30:00.000Z");
  assert.equal(iso(instantOf("2026-04-04", "09:00", "Asia/Kolkata")), "2026-04-04T03:30:00.000Z");
  assert.equal(iso(instantOf("2026-10-04", "09:00", "Asia/Kolkata")), "2026-10-04T03:30:00.000Z");
  // Auckland starts DST on 2026-09-27 at 02:00 (UTC+12 to +13).
  assert.equal(iso(instantOf("2026-09-26", "09:00", "Pacific/Auckland")), "2026-09-25T21:00:00.000Z");
  assert.equal(iso(instantOf("2026-09-28", "09:00", "Pacific/Auckland")), "2026-09-27T20:00:00.000Z");
  assert.equal(iso(instantOf("2026-09-28", "09:00", "UTC")), "2026-09-28T09:00:00.000Z");
});

test("wall clock and offset read back what instantOf produced, across a local date line (a time that is the next day in UTC)", () => {
  const ms = instantOf("2026-06-01", "23:30", "America/Los_Angeles");
  assert.equal(iso(ms), "2026-06-02T06:30:00.000Z");
  assert.deepEqual(wallClock(ms, "America/Los_Angeles"), { date: "2026-06-01", hour: 23, minute: 30, weekday: 1 });
  assert.equal(offsetAt(ms, "America/Los_Angeles"), -7 * 60 * MIN);
  assert.equal(wallClock(Date.parse("2026-12-31T23:30:00Z"), "Asia/Tokyo").date, "2027-01-01");
});

const rule = (over: Partial<SlotRule> = {}): SlotRule => ({ recurrence: { kind: "daily" }, time: "09:00", zone: "Europe/Berlin", ...over });

test("due slots: only slots after the cursor whose preparation window has opened, oldest first, one per local date", () => {
  const after = Date.parse("2026-03-26T12:00:00Z");
  const now = Date.parse("2026-03-30T06:00:00Z"); // Monday 08:00 CEST
  const found = dueSlots(rule(), after, now, 0, 400);
  assert.deepEqual(found.slots.map((s) => [s.key, iso(s.at)]), [
    ["2026-03-27", "2026-03-27T08:00:00.000Z"], ["2026-03-28", "2026-03-28T08:00:00.000Z"], ["2026-03-29", "2026-03-29T07:00:00.000Z"],
  ]);
  assert.equal(found.truncated, false);
  // With a preparation lead of 90 minutes, Monday's 07:00Z slot is already due at 06:00Z.
  assert.equal(dueSlots(rule(), after, now, 90 * MIN, 400).slots.length, 4);
  // A slot exactly at the cursor was handled already.
  assert.equal(dueSlots(rule(), Date.parse("2026-03-27T08:00:00Z"), Date.parse("2026-03-27T08:00:00Z"), 0, 400).slots.length, 0);
});

test("the fall-back night makes one slot, not two, and a daily schedule at the repeated hour keeps its date count", () => {
  const r = rule({ time: "02:30" });
  const found = dueSlots(r, Date.parse("2026-10-24T12:00:00Z"), Date.parse("2026-10-25T12:00:00Z"), 0, 400);
  assert.deepEqual(found.slots.map((s) => [s.key, iso(s.at)]), [["2026-10-25", "2026-10-25T00:30:00.000Z"]]);
});

test("weekly and once recurrences, start and end dates", () => {
  const monWed = rule({ recurrence: { kind: "weekly", days: [1, 3] } });
  const found = dueSlots(monWed, Date.parse("2026-10-18T00:00:00Z"), Date.parse("2026-10-29T00:00:00Z"), 0, 400);
  assert.deepEqual(found.slots.map((s) => s.key), ["2026-10-19", "2026-10-21", "2026-10-26", "2026-10-28"]);
  const once = rule({ recurrence: { kind: "once", date: "2026-11-02" } });
  assert.deepEqual(dueSlots(once, Date.parse("2026-10-01T00:00:00Z"), Date.parse("2026-12-01T00:00:00Z"), 0, 400).slots.map((s) => s.key), ["2026-11-02"]);
  assert.equal(nextSlot(once, Date.parse("2026-11-03T00:00:00Z"), 400), undefined, "a finished one-off has no next slot");
  const bounded = rule({ startDate: "2026-11-02", endDate: "2026-11-03" });
  assert.deepEqual(dueSlots(bounded, Date.parse("2026-10-01T00:00:00Z"), Date.parse("2026-12-01T00:00:00Z"), 0, 400).slots.map((s) => s.key), ["2026-11-02", "2026-11-03"]);
  assert.equal(nextSlot(bounded, Date.parse("2026-11-03T20:00:00Z"), 400), undefined);
  assert.equal(iso(nextSlot(bounded, Date.parse("2026-10-01T00:00:00Z"), 400)!.at), "2026-11-02T08:00:00.000Z");
});

test("a very long downtime is reported as truncated, not silently shortened", () => {
  const found = dueSlots(rule(), Date.parse("2020-01-01T00:00:00Z"), Date.parse("2026-10-22T00:00:00Z"), 0, 400);
  assert.equal(found.truncated, true);
  assert.ok(found.slots.length >= 399 && found.slots.length <= 402, String(found.slots.length));
  assert.equal(found.slots[found.slots.length - 1]!.key, "2026-10-21", "the latest slot that has started");
});

test("a first slot far beyond the look-ahead is still found, by starting at the start or one-off date", () => {
  const after = Date.parse("2026-10-23T00:00:00Z");
  assert.equal(iso(nextSlot(rule({ recurrence: { kind: "once", date: "2028-01-05" } }), after, 400)!.at), "2028-01-05T08:00:00.000Z");
  assert.equal(iso(nextSlot(rule({ startDate: "2027-12-31" }), after, 400)!.at), "2027-12-31T08:00:00.000Z");
  assert.equal(iso(nextSlot(rule({ startDate: "2030-06-03", recurrence: { kind: "weekly", days: [2] } }), after, 400)!.at), "2030-06-04T07:00:00.000Z");
});
