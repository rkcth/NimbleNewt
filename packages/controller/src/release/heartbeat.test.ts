import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { DEFAULT_HEARTBEAT_STALE_MS, HEARTBEAT_ENV, HEARTBEAT_MAX_BYTES, HEARTBEAT_RECORD_BYTES, sweepHeartbeats, HeartbeatError, HeartbeatMonitor, HeartbeatWriter, Launcher, effectiveInterval, startNoticeText, effectiveStaleAfter, parseHeartbeat, planLiveness, readHeartbeat, type HeartbeatRead } from "./index.js";
import { Clock, makeRelease, pointerSwitcher } from "./start-fixture.js";

/** The controller liveness heartbeat (card K02 follow-up): the writer, the monitor and the supervisor hook, with fake clocks and a real child that hangs. No database, no network. */
const TOKEN = "tok-abcdef123456";
const beat = (seq: number, intervalMs = 5000, token = TOKEN): HeartbeatRead => ({ kind: "beat", record: { v: 1, seq, token, intervalMs } });
const posix = process.platform !== "win32";
function dir(): string { const d = mkdtempSync(join(tmpdir(), "nn-hb-")); chmodSync(d, 0o700); return d; }
/** A monitor whose file contents and clock the test sets. */
function rig(opts: { staleAfterMs?: number; firstBeatMs?: number } = {}) {
  const s = { now: 0, read: beat(1) as HeartbeatRead };
  const m = new HeartbeatMonitor({ file: "/x/hb.json", token: TOKEN, monotonic: () => s.now, read: async () => s.read, ...opts });
  return { s, m, at: async (ms: number, r?: HeartbeatRead) => { s.now = ms; if (r !== undefined) s.read = r; return m.check(); } };
}

test("bounds: the interval is clamped to 1 to 60 s, the stale limit to 30 s to 1 h, defaults safe", () => {
  assert.equal(effectiveInterval(), 5000);
  assert.equal(effectiveInterval(1), 1000);
  assert.equal(effectiveInterval(10 ** 9), 60_000);
  assert.equal(effectiveInterval(Number.NaN), 5000);
  assert.equal(effectiveStaleAfter(), DEFAULT_HEARTBEAT_STALE_MS);
  assert.equal(effectiveStaleAfter(1), 30_000, "a slow machine cannot be configured into false restarts");
  assert.equal(effectiveStaleAfter(10 ** 12), 3_600_000);
});

test("the record is parsed strictly: extra keys, wrong types, bad token, zero counter and nonsense are all refused", () => {
  assert.deepEqual(parseHeartbeat(JSON.stringify({ v: 1, seq: 3, token: TOKEN, intervalMs: 5000 })), { v: 1, seq: 3, token: TOKEN, intervalMs: 5000 });
  for (const bad of ["", "{", "[]", "null", "7", JSON.stringify({ v: 1, seq: 0, token: TOKEN, intervalMs: 5000 }), JSON.stringify({ v: 2, seq: 1, token: TOKEN, intervalMs: 5000 }), JSON.stringify({ v: 1, seq: 1.5, token: TOKEN, intervalMs: 5000 }),
    JSON.stringify({ v: 1, seq: 1, token: "a b", intervalMs: 5000 }), JSON.stringify({ v: 1, seq: 1, token: TOKEN, intervalMs: 5 }), JSON.stringify({ v: 1, seq: 1, token: TOKEN, intervalMs: 5000, extra: "x" }), JSON.stringify({ v: 1, seq: "1", token: TOKEN, intervalMs: 5000 })]) {
    assert.equal(parseHeartbeat(bad), undefined, bad);
  }
});

test("a heartbeat that keeps moving is alive; one that stops is hung only once the quiet time reaches the limit, counted from the last move", async () => {
  const r = rig({ staleAfterMs: 30_000 });
  assert.equal((await r.at(0)).state, "alive");
  assert.equal((await r.at(10_000, beat(2))).state, "alive");
  // stops at 10 s
  assert.equal((await r.at(20_000)).state, "alive");
  assert.equal((await r.at(30_000)).state, "alive");
  assert.equal((await r.at(39_999)).state, "alive", "29.999 s of quiet");
  const v = await r.at(40_000);
  assert.deepEqual(v, { state: "hung", quietMs: 30_000, thresholdMs: 30_000, lastSeq: 2 });
});

test("a pause shorter than the limit (a long garbage collection, a slow machine) does not restart; the beat then resumes", async () => {
  const r = rig({ staleAfterMs: 60_000 });
  await r.at(0);
  for (const t of [10_000, 20_000, 29_000]) assert.equal((await r.at(t)).state, "alive", `quiet at ${t}`);
  assert.equal((await r.at(30_000, beat(2))).state, "alive");
  assert.equal((await r.at(40_000)).state, "alive");
});

test("the writer's own interval raises the limit: 60 s beats are not judged by a 30 s limit", async () => {
  const r = rig({ staleAfterMs: 30_000 });
  await r.at(0, beat(1, 60_000));
  assert.equal(r.m.thresholdMs(), 360_000);
  for (let t = 10_000; t < 360_000; t += 10_000) assert.equal((await r.at(t)).state, "alive", `at ${t}`);
  assert.equal((await r.at(360_000)).state, "hung");
});

test("a clock that jumps, forward or back, and a checker that was paused never produce a hang; counting starts again", async () => {
  const r = rig({ staleAfterMs: 30_000 });
  await r.at(0);
  await r.at(10_000);
  // the monotonic clock jumps forward by an hour (a suspended machine on a platform whose monotonic clock counts sleep)
  const jumped = await r.at(3_610_000);
  assert.equal(jumped.state, "unknown");
  assert.equal((await r.at(3_620_000)).state, "alive", "10 s after the jump: counting from the jump");
  // and backwards
  assert.equal((await r.at(100)).state, "unknown");
  assert.equal((await r.at(10_100)).state, "alive");
  // a stall is still found afterwards: 10 s steps up to 30 s of quiet
  assert.equal((await r.at(20_100)).state, "alive");
  assert.equal((await r.at(29_000)).state, "alive");
  assert.equal((await r.at(30_100)).state, "hung");
});

test("a file that is missing, unreadable or garbled is unknown, never hung, and the time it was unreadable is not counted", async () => {
  const r = rig({ staleAfterMs: 30_000 });
  await r.at(0);
  assert.equal((await r.at(5_000, { kind: "missing" })).state, "unknown");
  for (let t = 10_000; t <= 100_000; t += 10_000) assert.equal((await r.at(t, { kind: "unusable", why: "garbled" })).state, "unknown", `at ${t}`);
  // readable again with the same counter: not hung at once, counted from here
  assert.equal((await r.at(105_000, beat(1))).state, "unknown");
  assert.equal((await r.at(120_000)).state, "alive");
  assert.equal((await r.at(135_000)).state, "hung");
});

test("a file of another start, or a counter that went backwards, is unknown", async () => {
  const r = rig({ staleAfterMs: 30_000 });
  await r.at(0, beat(5));
  assert.equal((await r.at(10_000, beat(6, 5000, "other-token-12345"))).state, "unknown");
  assert.equal((await r.at(20_000, beat(2))).state, "unknown");
  assert.equal((await r.at(30_000, beat(7))).state, "alive");
  // A value read backwards (a torn read showing a counter far ahead, then the true value) becomes the new baseline: a hang below the old value is still found.
  const t = rig({ staleAfterMs: 30_000 });
  await t.at(0, beat(1));
  assert.equal((await t.at(5_000, beat(999))).state, "alive");
  assert.equal((await t.at(10_000, beat(3))).state, "unknown");
  assert.equal((await t.at(15_000, beat(4))).state, "alive");
  for (let ms = 20_000; ms < 45_000; ms += 5_000) assert.equal((await t.at(ms)).state, "alive", `at ${ms}`);
  assert.equal((await t.at(45_000)).state, "hung", "stood still at 4 from 15 s");
});

test("no beat ever seen is unsupported (an older last known good has no writer) unless the supervisor says one is expected", async () => {
  const a = rig({ staleAfterMs: 30_000 });
  a.m.begin();
  for (const t of [0, 60_000, 600_000]) assert.equal((await a.at(t, { kind: "missing" })).state, "unsupported");
  const b = rig({ staleAfterMs: 30_000, firstBeatMs: 90_000 });
  b.m.begin();
  for (let t = 0; t < 90_000; t += 5_000) assert.equal((await b.at(t, { kind: "missing" })).state, "unsupported", `at ${t}`);
  const v = await b.at(90_000);
  assert.equal(v.state, "hung");
  // the same pause rule as for a stalled counter: a checker paused (or a clock jump) past half the limit starts the wait again, it is not counted as waiting
  const p = rig({ staleAfterMs: 30_000, firstBeatMs: 90_000 });
  p.m.begin();
  assert.equal((await p.at(0, { kind: "missing" })).state, "unsupported");
  assert.equal((await p.at(10_000)).state, "unsupported");
  assert.equal((await p.at(200_000)).state, "unsupported", "a 190 s pause is not 200 s of waiting");
  assert.equal((await p.at(210_000)).state, "unsupported");
  for (let t = 220_000; t < 290_000; t += 10_000) assert.equal((await p.at(t)).state, "unsupported", `at ${t}`);
  assert.equal((await p.at(290_000)).state, "hung", "90 s counted from the pause");
  const q = rig({ staleAfterMs: 30_000, firstBeatMs: 90_000 });
  q.s.now = 500_000; q.m.begin();
  assert.equal((await q.at(500_000, { kind: "missing" })).state, "unsupported");
  assert.equal((await q.at(400_000)).state, "unsupported", "a clock that went back");
  for (let t = 410_000; t < 490_000; t += 10_000) assert.equal((await q.at(t)).state, "unsupported", `at ${t}`);
  const c = rig({ staleAfterMs: 30_000, firstBeatMs: 90_000 });
  c.m.begin();
  assert.equal((await c.at(80_000, beat(1))).state, "alive", "a first beat in time");
});

test("the writer writes a private, small record without any path, time or secret, bumps it, and stops cleanly", async () => {
  const d = dir();
  try {
    const file = join(d, "hb.json");
    const w = await HeartbeatWriter.start({ file, token: TOKEN, intervalMs: 1 });
    assert.equal(w.intervalMs, 1000, "the rate is bounded");
    let first: HeartbeatRead = { kind: "missing" };
    for (let i = 0; i < 100 && first.kind !== "beat"; i++) { await new Promise((r) => setTimeout(r, 20)); first = await readHeartbeat(file); }
    assert.equal(first.kind, "beat");
    const text = readFileSync(file, "utf8");
    assert.ok(text.length < HEARTBEAT_MAX_BYTES);
    assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ["intervalMs", "seq", "token", "v"]);
    assert.ok(!text.includes(d) && !text.includes(process.env.HOME ?? "\u0000"), "no path");
    if (posix) assert.equal(statSync(file).mode & 0o777, 0o600);
    const before = (first as { record: { seq: number } }).record.seq;
    await new Promise((r) => setTimeout(r, 1250));
    const after = await readHeartbeat(file);
    assert.ok(after.kind === "beat" && after.record.seq > before, "the counter moves with the timer");
    await w.stop();
    const stopped = w.ticks;
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(w.ticks, stopped, "no ticks after stop");
    assert.deepEqual(readdirNames(d), ["hb.json"], "no temporary file left");
  } finally { rmSync(d, { recursive: true, force: true }); }
});
const readdirNames = (d: string): string[] => readdirSync(d).sort();

test("safety: the writer refuses a relative path, a bad token, a symlink target, a symlinked or group-writable directory; it never writes through a planted temporary link", async () => {
  const d = dir();
  try {
    await assert.rejects(HeartbeatWriter.start({ file: "hb.json", token: TOKEN }), HeartbeatError);
    await assert.rejects(HeartbeatWriter.start({ file: join(d, "hb.json"), token: "no" }), HeartbeatError);
    await assert.rejects(HeartbeatWriter.start({ file: join(d, "missing-dir", "hb.json"), token: TOKEN }), HeartbeatError);
    const victim = join(d, "victim.txt");
    writeFileSync(victim, "keep");
    symlinkSync(victim, join(d, "link.json"));
    await assert.rejects(HeartbeatWriter.start({ file: join(d, "link.json"), token: TOKEN }), /symbolic link/);
    assert.equal(readFileSync(victim, "utf8"), "keep");
    const real = join(d, "real");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, join(d, "dirlink"));
    await assert.rejects(HeartbeatWriter.start({ file: join(d, "dirlink", "hb.json"), token: TOKEN }), /plain directory/);
    if (posix) {
      const open = join(d, "open");
      mkdirSync(open);
      chmodSync(open, 0o777);
      await assert.rejects(HeartbeatWriter.start({ file: join(open, "hb.json"), token: TOKEN }), /group or others/);
      // a link planted where the temporary file goes is not followed; the write fails and is told once, the victim is untouched
      const said: string[] = [];
      symlinkSync(victim, join(real, `hb.json.${process.pid}.tmp`));
      const w = await HeartbeatWriter.start({ file: join(real, "hb.json"), token: TOKEN, onProblem: (l) => said.push(l) });
      await new Promise((r) => setTimeout(r, 100));
      await w.stop();
      assert.equal(readFileSync(victim, "utf8"), "keep");
      assert.equal(existsSync(join(real, "hb.json")), false);
      assert.equal(said.length, 1);
      assert.ok(!said[0]!.includes(d), "the message holds no path");
    }
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("safety: the reader refuses a symlink, a directory, an oversized file and garbage, and reports a missing file as missing", async () => {
  const d = dir();
  try {
    assert.deepEqual(await readHeartbeat(join(d, "none")), { kind: "missing" });
    const real = join(d, "real.json");
    writeFileSync(real, JSON.stringify({ v: 1, seq: 1, token: TOKEN, intervalMs: 5000 }));
    assert.equal((await readHeartbeat(real)).kind, "beat");
    symlinkSync(real, join(d, "l.json"));
    assert.equal((await readHeartbeat(join(d, "l.json"))).kind, "unusable");
    mkdirSync(join(d, "sub"));
    assert.equal((await readHeartbeat(join(d, "sub"))).kind, "unusable");
    writeFileSync(join(d, "big.json"), "x".repeat(HEARTBEAT_MAX_BYTES + 1));
    assert.equal((await readHeartbeat(join(d, "big.json"))).kind, "unusable");
    writeFileSync(join(d, "junk.json"), "\u0000\u0001{{");
    assert.equal((await readHeartbeat(join(d, "junk.json"))).kind, "unusable");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a real child that beats and then blocks its event loop is found hung; one that keeps running is not (fake monotonic clock, real file)", async () => {
  const d = dir();
  const here = fileURLToPath(new URL("./heartbeat.js", import.meta.url));
  const script = (block: boolean): string => `import(${JSON.stringify(`file://${here}`)}).then(async (m) => { await m.HeartbeatWriter.start({ file: process.env.${HEARTBEAT_ENV.file}, token: process.env.${HEARTBEAT_ENV.token}, intervalMs: 1000 }); ${block ? "setTimeout(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000), 1500);" : "setInterval(() => {}, 1000);"} });`;
  const kids: ReturnType<typeof spawn>[] = [];
  try {
    for (const block of [false, true]) {
      const live = await planLiveness({ dir: d, releaseId: "rcn-x" });
      assert.deepEqual(Object.keys(live.env).sort(), [HEARTBEAT_ENV.file, HEARTBEAT_ENV.intervalMs, HEARTBEAT_ENV.token].sort(), "nothing but the three settings");
      const kid = spawn(process.execPath, ["--input-type=module", "-e", script(block)], { env: { ...process.env, ...live.env }, stdio: "ignore" });
      kids.push(kid);
      let t = 0;
      const m = new HeartbeatMonitor({ file: live.env[HEARTBEAT_ENV.file]!, token: live.env[HEARTBEAT_ENV.token]!, staleAfterMs: 30_000, monotonic: () => t });
      m.begin();
      // wait for the first beat, and for the blocking child to be blocked
      for (let i = 0; i < 100 && (await m.check()).state === "unsupported"; i++) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 2600));
      t = 1; await m.check();
      const states: string[] = [];
      for (let i = 0; i < 4; i++) {
        t += 12_000;
        if (!block) await new Promise((r) => setTimeout(r, 1200));
        states.push((await m.check()).state);
      }
      if (block) assert.deepEqual(states, ["alive", "alive", "hung", "hung"], "12, 24 s quiet are fine; 36 s is hung");
      else assert.deepEqual(states, ["alive", "alive", "alive", "alive"]);
      kid.kill("SIGKILL");
      await live.cleanup();
      assert.equal(existsSync(live.env[HEARTBEAT_ENV.file]!), false);
    }
  } finally { for (const k of kids) k.kill("SIGKILL"); rmSync(d, { recursive: true, force: true }); }
});

test("planLiveness.watch counts only after the confirmation, returns the hang, and returns undefined when told to stop", async () => {
  const d = dir();
  try {
    let now = 0;
    let confirmed = false;
    let seq = 1;
    const live = await planLiveness({ dir: d, releaseId: "rcn-y", staleAfterMs: 30_000, monotonic: () => now, read: async () => beat(seq, 5000, live.env[HEARTBEAT_ENV.token]!) });
    const polls: number[] = [];
    const result = await live.watch({ confirmed: async () => confirmed, pollMs: 10_000, sleep: async (ms) => { now += ms; polls.push(now); if (now === 30_000) confirmed = true; if (now <= 60_000) seq++; } });
    // the counter moved until 60 s, was confirmed at 30 s (begin), then stood still
    assert.ok(result !== undefined);
    assert.equal(result.releaseId, "rcn-y");
    assert.equal(result.thresholdMs, 30_000);
    assert.match(result.reason, /no sign of life for 30 s \(limit 30 s\)/);
    assert.equal(polls.at(-1), 90_000, "the last beat was read at 60 s: 30 s of quiet, judged at 90 s");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("planLiveness.watch ends with undefined on abort and never judges before the confirmation", async () => {
  const d = dir();
  try {
    const ac = new AbortController();
    let now = 0;
    const live = await planLiveness({ dir: d, releaseId: "rcn-z", staleAfterMs: 30_000, monotonic: () => now, read: async () => beat(1, 5000, live.env[HEARTBEAT_ENV.token]!) });
    let n = 0;
    const result = await live.watch({ confirmed: async () => false, signal: ac.signal, pollMs: 10_000, sleep: async (ms) => { now += ms; if (++n === 50) ac.abort(); } });
    assert.equal(result, undefined);
    assert.equal(n, 50);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("planLiveness refuses an unsafe directory", async () => {
  const d = dir();
  try {
    const real = join(d, "real");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, join(d, "link"));
    await assert.rejects(planLiveness({ dir: join(d, "link"), releaseId: "r" }), HeartbeatError);
    if (posix) { const open = join(d, "open"); mkdirSync(open); chmodSync(open, 0o770); await assert.rejects(planLiveness({ dir: open, releaseId: "r" }), /group or others/); }
    const ok = await planLiveness({ dir: join(d, "fresh", "run"), releaseId: "r" });
    assert.ok(existsSync(join(d, "fresh", "run")));
    await ok.cleanup();
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("Launcher.noteHung tells the owner in the launcher file, never quarantines or demotes the last known good, and the same release keeps running (K02f)", async () => {
  const root = mkdtempSync(join(tmpdir(), "nn-hb-l-"));
  try {
    const clock = new Clock();
    const launcher = new Launcher({ root, switcher: pointerSwitcher(root), now: clock.now, monotonic: clock.mono, workers: { min: 1, max: 1 } });
    const r = makeRelease(root, "good");
    await launcher.expect({ ...r, protocol: { min: 1, max: 1 } });
    await pointerSwitcher(root).write(r.id);
    assert.equal((await launcher.prepare()).action, "run");
    assert.equal(await launcher.confirm(r.id), true);
    await launcher.noteHung(r.id, "no sign of life for 120 s (limit 120 s)");
    const s = await launcher.read();
    assert.equal(s.known?.id, r.id);
    assert.deepEqual(s.failed, [], "not quarantined");
    assert.deepEqual((s.notices ?? []).map((n) => [n.kind, n.release, n.fallback]), [["failed_start", r.id, true]]);
    assert.match(s.notices![0]!.reason, /stopped responding.*restarted/);
    // A restart of the same release goes ahead, and a second hang of an open notice adds nothing.
    assert.equal((await launcher.prepare()).action, "run");
    await launcher.noteHung(r.id, "again");
    assert.equal((await launcher.read()).notices!.length, 1);
    // The owner's text says what happened (restarted), never that the release was set aside.
    const hungNotice = (await launcher.read()).notices![0]!;
    assert.equal(hungNotice.cause, "hung");
    assert.match(startNoticeText(hungNotice, "needs-you").label, /stopped responding and the launcher restarted it/);
    assert.doesNotMatch(startNoticeText(hungNotice, "needs-you").label, /set aside/);
    // A run of hangs that ends in the crash-loop exit: the Urgent give-up notice is written beside the open hang notice, not swallowed by it.
    await launcher.noteCrashLoop(r.id, "20 times in a row within 60 s of starting or by hanging");
    const both = (await launcher.read()).notices!;
    assert.deepEqual(both.map((n) => [n.kind, n.cause ?? "-", n.fallback]), [["failed_start", "hung", true], ["failed_start", "-", false]]);
    assert.equal(startNoticeText(both[1]!, "needs-you").level, "urgent");
    const told: string[] = [];
    const out = await launcher.deliver({ raise: async (n) => { told.push(n.reason); }, settle: async () => undefined });
    assert.equal(out.raised, 2);
    assert.equal(told.length, 2);
    assert.deepEqual((await launcher.read()).notices!.map((n) => n.sentAt !== undefined), [true, true], "each marked sent under its own key");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a directory that takes no new file (a full disk) does not stop the beat: the record is overwritten in place; a file that is not the writer's is never overwritten", { skip: !posix || process.getuid?.() === 0 }, async () => {
  const d = dir();
  try {
    const file = join(d, "hb.json");
    const said: string[] = [];
    const w = await HeartbeatWriter.start({ file, token: TOKEN, intervalMs: 1000, onProblem: (l) => said.push(l) });
    try {
      let r = await readHeartbeat(file);
      for (let i = 0; i < 100 && r.kind !== "beat"; i++) { await new Promise((x) => setTimeout(x, 20)); r = await readHeartbeat(file); }
      assert.equal(r.kind, "beat");
      assert.equal(statSync(file).size, HEARTBEAT_RECORD_BYTES, "every record has the same size");
      // No new file can be created there now (as on a full disk): the temporary cannot be made, the rename never happens.
      chmodSync(d, 0o500);
      const before = (r as { record: { seq: number } }).record.seq;
      await new Promise((x) => setTimeout(x, 2300));
      const after = await readHeartbeat(file);
      assert.ok(after.kind === "beat" && after.record.seq >= before + 2, `the counter still moves (${before} -> ${after.kind === "beat" ? after.record.seq : after.kind})`);
      assert.deepEqual(said, [], "nothing to report: the beat goes on");
      assert.equal(statSync(file).size, HEARTBEAT_RECORD_BYTES);
    } finally { await w.stop(); chmodSync(d, 0o700); }
    // a hard link (two names) or a file of another size is not the writer's record: not overwritten, the failure is told once
    const said2: string[] = [];
    writeFileSync(join(d, "two.json"), "y".repeat(HEARTBEAT_RECORD_BYTES));
    const { linkSync } = await import("node:fs");
    linkSync(join(d, "two.json"), join(d, "two-again.json"));
    chmodSync(d, 0o500);
    try {
      const w3 = await HeartbeatWriter.start({ file: join(d, "two.json"), token: TOKEN, intervalMs: 1000, onProblem: (l) => said2.push(l) });
      await new Promise((x) => setTimeout(x, 100));
      await w3.stop();
    } finally { chmodSync(d, 0o700); }
    assert.equal(readFileSync(join(d, "two-again.json"), "utf8"), "y".repeat(HEARTBEAT_RECORD_BYTES), "a hard-linked file is not written through");
    assert.equal(said2.length, 1, "told once");
  } finally { chmodSync(d, 0o700); rmSync(d, { recursive: true, force: true }); }
});

test("cleanup removes the file and a temporary a killed writer left; sweepHeartbeats removes only the heartbeat names an earlier launcher left", async () => {
  const d = dir();
  try {
    const live = await planLiveness({ dir: d, releaseId: "rcn-c" });
    const file = live.env[HEARTBEAT_ENV.file]!;
    writeFileSync(file, "{}");
    writeFileSync(`${file}.4242.tmp`, "{}");
    writeFileSync(join(d, "keep.txt"), "mine");
    await live.cleanup();
    assert.deepEqual(readdirNames(d), ["keep.txt"]);
    writeFileSync(join(d, "heartbeat-0123456789ab.json"), "{}");
    writeFileSync(join(d, "heartbeat-0123456789ab.json.77.tmp"), "{}");
    writeFileSync(join(d, "heartbeat-notmine.json"), "{}");
    mkdirSync(join(d, "heartbeat-aaaaaaaaaaaa.json"));
    assert.equal(await sweepHeartbeats(d), 2);
    assert.deepEqual(readdirNames(d), ["heartbeat-aaaaaaaaaaaa.json", "heartbeat-notmine.json", "keep.txt"]);
    assert.equal(await sweepHeartbeats(join(d, "missing")), 0);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
