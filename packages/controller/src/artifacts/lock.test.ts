import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { ReadWriteLock } from "./lock.js";

test("shared holders overlap, an exclusive holder is alone, and a waiting exclusive request is not starved by later shared ones", async () => {
  const lock = new ReadWriteLock();
  const log: string[] = [];
  let active = 0;
  let peak = 0;
  const reader = (name: string, ms: number) => lock.shared(async () => { active += 1; peak = Math.max(peak, active); log.push(`${name}+`); await sleep(ms); log.push(`${name}-`); active -= 1; });
  const writer = (name: string) => lock.exclusive(async () => { assert.equal(active, 0, "no reader is active while a writer holds the lock"); active += 1; log.push(`${name}+`); await sleep(5); log.push(`${name}-`); active -= 1; });
  const r1 = reader("r1", 30);
  const r2 = reader("r2", 30);
  await sleep(5);
  const w = writer("w");
  const r3 = reader("r3", 5); // arrives after the writer: waits behind it
  await Promise.all([r1, r2, w, r3]);
  assert.equal(peak, 2);
  assert.ok(log.indexOf("w+") > log.indexOf("r1-") && log.indexOf("w+") > log.indexOf("r2-"));
  assert.ok(log.indexOf("r3+") > log.indexOf("w-"), "a later reader did not jump the queue");
});

test("a failing holder releases the lock", async () => {
  const lock = new ReadWriteLock();
  await assert.rejects(lock.exclusive(async () => { throw new Error("boom"); }), /boom/);
  await assert.rejects(lock.shared(async () => { throw new Error("boom"); }), /boom/);
  assert.equal(await lock.exclusive(async () => "ok"), "ok");
});
