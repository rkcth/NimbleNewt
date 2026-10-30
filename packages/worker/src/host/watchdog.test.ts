import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { LeaseLost, LeaseWatchdog, killContained, type LossReason, type WatchdogClock } from "./watchdog.js";

/** A clock the test moves: `sleep` advances wall time only (the machine was off), `advance` both. */
function clock() {
  const c = { m: 1000, w: 1_700_000_000_000 };
  const k: WatchdogClock & { advance(ms: number): void; sleep(ms: number): void } = { mono: () => c.m, wall: () => c.w, advance: (ms) => { c.m += ms; c.w += ms; }, sleep: (ms) => { c.w += ms; } };
  return k;
}
function make(k: ReturnType<typeof clock>, extra: Record<string, unknown> = {}) {
  const log: string[] = [];
  const dog = new LeaseWatchdog({ clock: k, maxLeaseMs: 30_000, graceMs: 5000, onStop: (r: LossReason) => { log.push(`stop:${r}`); }, onTerminate: (r: LossReason) => { log.push(`terminate:${r}`); }, ...extra }, 20_000);
  return { dog, log };
}

test("silent loss: productive work stops when the lease ends, and a renewal before then pushes it out", async () => {
  const k = clock(); const { dog, log } = make(k);
  k.advance(15_000);
  const sent = dog.sending();
  dog.renewed(sent, 20_000);
  k.advance(15_000); await dog.tick();
  assert.equal(dog.productive, true, "renewed at 15s for 20s: good until 35s");
  k.advance(5_000); await dog.tick();
  assert.deepEqual([dog.productive, dog.reason, log], [false, "silent", ["stop:silent"]]);
  await assert.rejects(dog.assertProductive(), (e: unknown) => e instanceof LeaseLost && e.reason === "silent");
});

test("a reply that comes late, or an old one replayed, never makes the lease longer than it was meant to be", async () => {
  const k = clock(); const { dog } = make(k);
  const sent = dog.sending();
  k.advance(19_000);
  dog.renewed(sent, 20_000); // answered 19 s after it was sent: good for 1 s more, not 20
  assert.equal(dog.remainingMs(), 1000);
  const old = sent - 50_000;
  dog.renewed(old, 20_000);
  assert.equal(dog.remainingMs(), 1000, "an older send does not extend it");
  dog.renewed(dog.sending(), 999_999);
  assert.equal(dog.remainingMs(), 30_000, "a longer lease than the cap is cut to the cap");
});

test("explicit loss stops at once and a later renewal does not revive it", async () => {
  const k = clock(); const { dog, log } = make(k);
  await dog.lost();
  dog.renewed(dog.sending(), 20_000);
  assert.deepEqual([dog.productive, dog.remainingMs(), log], [false, 0, ["stop:explicit"]]);
  await dog.lost();
  assert.deepEqual(log, ["stop:explicit"], "stopped once");
});

test("sleep and wake: wall time ahead of monotonic time fails closed without waiting for a renewal; supervisor death does too", async () => {
  const k = clock(); const a = make(k);
  k.advance(1000); await a.dog.tick();
  k.sleep(60_000); // the lid was shut for a minute; the lease would not look expired on the monotonic clock
  await a.dog.tick();
  assert.deepEqual([a.dog.reason, a.log], ["wake", ["stop:wake"]]);
  const b = make(k, { supervisorMs: 3000 });
  k.advance(2000); b.dog.pulse(); k.advance(2000); await b.dog.tick();
  assert.equal(b.dog.productive, true, "pulsed 2 s ago");
  k.advance(1500); await b.dog.tick();
  assert.deepEqual([b.dog.reason, b.log], ["supervisor", ["stop:supervisor"]]);
});

test("after the stop the process is ended once the grace runs out, unless the worker said it was quiet", async () => {
  const k = clock(); const a = make(k);
  await a.dog.lost();
  k.advance(4000); await a.dog.tick();
  assert.deepEqual(a.log, ["stop:explicit"], "still inside the grace");
  k.advance(1500); await a.dog.tick(); await a.dog.tick();
  assert.deepEqual(a.log, ["stop:explicit", "terminate:explicit"], "ended once");
  const b = make(k);
  await b.dog.lost(); b.dog.quiet();
  k.advance(60_000); await b.dog.tick();
  assert.deepEqual(b.log, ["stop:explicit"], "a clean wind-down needs no termination");
});

test("contained termination ends the process and what it started, TERM then KILL, and refuses pids that are not its to end", { skip: process.platform === "win32" ? "process groups are POSIX; the Windows launcher is A03b" : false }, async () => {
  // A child that is its own group leader, starts a grandchild, and ignores TERM.
  const child = spawn(process.execPath, ["-e", `process.on("SIGTERM", () => {}); require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); setInterval(() => {}, 1000); process.stdout.write("ready");`], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const pid = child.pid!;
  // wait until the child has installed its handler (a fixed sleep raced with start-up under load)
  await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
  await new Promise((r) => setTimeout(r, 100));
  const signals: string[] = [];
  const gone = await killContained(pid, { termMs: 300, signal: (p, s) => { signals.push(s); try { process.kill(-p, s); } catch { /* gone */ } } });
  assert.equal(gone, true);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"], "TERM was ignored, so KILL followed");
  await assert.rejects(killContained(process.pid), RangeError);
  await assert.rejects(killContained(1), RangeError);
});

test("a short sleep, too small to count as a wake, still uses up that much of the lease", async () => {
  const k = clock(); const { dog } = make(k);
  await dog.tick();
  const before = dog.remainingMs();
  k.sleep(3000); // the monotonic clock did not run for 3 s
  await dog.tick();
  assert.equal(dog.remainingMs(), before - 3000, "the lease shrank by the sleep");
  assert.equal(dog.productive, true);
});

test("a process that is not its own group leader is refused, not reported gone", { skip: process.platform === "win32" ? "process groups are POSIX; the Windows launcher is A03b" : false }, async () => {
  const child = spawn("sleep", ["30"], { stdio: "ignore" }); // same group as ours
  try {
    await assert.rejects(killContained(child.pid!), /not its own group leader/);
    assert.equal(child.exitCode, null, "left alone");
  } finally { child.kill("SIGKILL"); }
});
