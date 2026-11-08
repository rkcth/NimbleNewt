import assert from "node:assert/strict";
import { test } from "node:test";
import { LeaseWatchdog, systemClock } from "@nimblenewt/contracts";
import { processClock } from "./clock.js";

test("H08b: on Linux the watchdog reads the never-stepped boot clock; elsewhere, or when it cannot be read, the wall clock as before", () => {
  assert.equal(processClock("darwin", () => 100), systemClock);
  assert.equal(processClock("win32", () => 100), systemClock);
  assert.equal(processClock("linux", () => { throw new Error("no /proc"); }), systemClock);
  assert.equal(processClock("linux", () => Number.NaN), systemClock);
  let up = 100;
  const k = processClock("linux", () => up);
  assert.equal(typeof k.boot, "function");
  assert.equal(k.boot!(), 100_000);
  up = 101.5;
  assert.equal(k.boot!(), 101_500);
  // A reading that fails later is no time asleep: the last reading moved on by the monotonic clock.
  up = Number.NaN;
  const later = k.boot!();
  assert.ok(later >= 101_500 && later < 101_500 + 1000, String(later));
});

test("H08b: the real clock of this machine does not make a running watchdog lose its lease", async (t) => {
  if (process.platform !== "linux") return t.skip("the boot clock is used on Linux only");
  let stopped = false;
  const dog = new LeaseWatchdog({ clock: processClock(), maxLeaseMs: 60_000, graceMs: 1000, onStop: () => { stopped = true; }, onTerminate: () => undefined }, 60_000);
  for (let i = 0; i < 5; i++) { await new Promise((r) => setTimeout(r, 30)); await dog.tick(); }
  assert.equal(stopped, false);
  assert.ok(dog.remainingMs() > 59_000, String(dog.remainingMs()));
});
