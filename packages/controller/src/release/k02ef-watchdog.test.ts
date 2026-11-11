import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_STARTUP_WINDOW_SECONDS, LAUNCHER_FILE, LAUNCHER_LIMITS, Launcher, LauncherStateError, renameReplacing, type LauncherNotice } from "./index.js";
import { Clock, makeRelease, pointerSwitcher } from "./start-fixture.js";

/**
 * The startup watchdog (card K02e) and the launcher's notices (card K02f), on the launcher alone: no database, no controller, fake releases on disk. Whatever the launcher decides is also written for the owner in the
 * same file, because it can run when the database cannot.
 */
async function world(body: (w: { root: string; clock: Clock; launcher: Launcher; sw: ReturnType<typeof pointerSwitcher>; announce: (tag: string) => Promise<{ id: string; digest: string }>; state: () => any; run: (r: { id: string; digest: string }) => Promise<any> }) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "nn-k02e-"));
  try {
    const clock = new Clock();
    const sw = pointerSwitcher(root);
    const launcher = new Launcher({ root, switcher: sw, now: clock.now, monotonic: clock.mono, workers: { min: 1, max: 1 } });
    const protocol = { min: 1, max: 1 };
    const announce = async (tag: string) => { const r = makeRelease(root, tag); await launcher.expect({ ...r, protocol }); return r; };
    /** The controller's side of an activation: announce, move the pointer, and let the launcher decide. */
    const run = async (r: { id: string; digest: string }) => { await sw.write(r.id); return launcher.prepare(); };
    await body({ root, clock, launcher, sw, announce, state: () => JSON.parse(readFileSync(join(root, LAUNCHER_FILE), "utf8")), run });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const notices = (s: any): LauncherNotice[] => s.notices ?? [];

test("a start still unconfirmed after the startup window is judged failed, set aside, told to the owner, and the next decision falls back; inside the window nothing happens (K02e)", async () => {
  await world(async (w) => {
    const good = await w.announce("good");
    assert.equal((await w.run(good)).action, "run");
    assert.equal(await w.launcher.confirm(good.id), true);
    const bad = await w.announce("bad");
    assert.equal((await w.run(bad)).action, "run");
    assert.equal((await w.launcher.watchdog()).action, "waiting", "just started");
    w.clock.advance(DEFAULT_STARTUP_WINDOW_SECONDS - 1);
    const waiting = await w.launcher.watchdog();
    assert.equal(waiting.action, "waiting");
    assert.equal((waiting as { remainingMs: number }).remainingMs, 1000);
    w.clock.advance(1);
    const judged = await w.launcher.watchdog();
    assert.deepEqual({ ...judged }, { action: "failed", releaseId: bad.id, reason: `not confirmed within the ${DEFAULT_STARTUP_WINDOW_SECONDS}-second startup window`, fallback: true });
    assert.deepEqual(w.state().failed.map((f: any) => f.id), [bad.id]);
    assert.equal(w.state().known.id, good.id, "the last known good is untouched");
    assert.equal((await w.launcher.watchdog()).action, "none", "judged once");
    assert.equal(notices(w.state()).length, 1);
    // The decision after the watchdog falls back, keeping the watchdog's reason, and adds the fall-back notice.
    const next = await w.launcher.prepare();
    assert.equal(next.action, "run");
    assert.equal((next as { releaseId: string }).releaseId, good.id);
    assert.match((next as { fellBack?: { reason: string } }).fellBack!.reason, /failed to start before/);
    const s = w.state();
    assert.equal(s.failed.length, 1, "no second entry");
    assert.match(s.failed[0].reason, /startup window/, "the watchdog's own reason is kept");
    assert.deepEqual(notices(s).map((n) => `${n.kind}:${n.release}:${n.fallback}`), [`fell_back:${bad.id}:true`], "the failed start nobody was told yet is folded into the fall-back");
    assert.match(notices(s).find((n) => n.kind === "fell_back")!.reason, /startup window/);
    // The release that failed is never run again.
    assert.equal((await w.run(bad)).action, "run", "the pointer was moved by hand to the failed release: it falls back again");
    assert.equal(notices(w.state()).length, 1, "the same release, the same notice: nothing new");
  });
});

test("the owner's startup window decides when a start is late; it is validated; it is read from the launcher's own file (K02e)", async () => {
  await world(async (w) => {
    await assert.rejects(() => w.launcher.setWindow(5), LauncherStateError);
    await assert.rejects(() => w.launcher.setWindow(86_401), LauncherStateError);
    await assert.rejects(() => w.launcher.setWindow(30.5), LauncherStateError);
    await w.launcher.setWindow(30);
    assert.equal(w.state().window, 30);
    const good = await w.announce("good"); await w.run(good); await w.launcher.confirm(good.id);
    const first = await w.announce("one");
    await w.run(first);
    w.clock.advance(29);
    assert.equal((await w.launcher.watchdog()).action, "waiting");
    w.clock.advance(1);
    assert.equal((await w.launcher.watchdog()).action, "failed", "30 seconds is the window");
    await w.launcher.setWindow(null);
    assert.equal(w.state().window, undefined, "null puts the default back");
    // A damaged window or notice never decides what runs: it is the default, or dropped, and the launch goes on (blocking would leave nothing running to repair it). The rest of the record stays strict.
    const s = w.state();
    for (const window of [3, 86_401, 30.5, "300", null, -1]) {
      writeFileSync(join(w.root, LAUNCHER_FILE), JSON.stringify({ ...s, window }));
      assert.equal((await w.launcher.read()).window, undefined, String(window));
      assert.equal((await w.launcher.prepare()).action, "run", `window ${String(window)}: the launch goes on`);
    }
    const kept = { kind: "failed_start", release: first.id, fallback: true, reason: "r", at: w.clock.now() };
    writeFileSync(join(w.root, LAUNCHER_FILE), JSON.stringify({ ...w.state(), notices: [{ kind: "nope" }, null, { ...kept, closedBy: "someone" }, kept] }));
    assert.deepEqual((await w.launcher.read()).notices, [kept], "only the notices that read are kept");
    assert.equal((await w.launcher.prepare()).action, "run");
    writeFileSync(join(w.root, LAUNCHER_FILE), JSON.stringify({ ...w.state(), notices: "lots" }));
    assert.equal((await w.launcher.read()).notices, undefined);
    writeFileSync(join(w.root, LAUNCHER_FILE), JSON.stringify({ ...w.state(), notices: Array.from({ length: 40 }, () => kept) }));
    assert.equal((await w.launcher.read()).notices!.length, LAUNCHER_LIMITS.notices, "too many: the newest are kept");
    // A damaged release entry is still a damaged record: the launcher will not guess what to run.
    writeFileSync(join(w.root, LAUNCHER_FILE), JSON.stringify({ ...w.state(), known: { id: "x" } }));
    assert.equal((await w.launcher.prepare()).action, "blocked");
    assert.match((await w.launcher.watchdog() as { reason: string }).reason, /not a launcher record/);
  });
});

test("the last known good is never quarantined by the watchdog: a late start of it is recorded and told once, and it still runs (K02e)", async () => {
  await world(async (w) => {
    const good = await w.announce("good");
    await w.run(good);
    await w.launcher.confirm(good.id);
    // A state a hand edit or an older launcher could leave: the last known good with an open, unconfirmed start.
    const s = w.state(); delete s.attempt.confirmedAt; writeFileSync(join(w.root, LAUNCHER_FILE), JSON.stringify(s));
    w.clock.advance(DEFAULT_STARTUP_WINDOW_SECONDS + 1);
    const r = await w.launcher.watchdog();
    assert.equal(r.action, "late");
    assert.deepEqual(w.state().failed, [], "not quarantined");
    assert.equal(w.state().known.id, good.id);
    assert.deepEqual(notices(w.state()).map((n) => [n.kind, n.fallback]), [["failed_start", false]], "told, as a failed start with nothing to fall back to");
    assert.equal((await w.launcher.watchdog()).action, "none", "judged once");
    const again = await w.launcher.prepare();
    assert.equal(again.action, "run");
    assert.equal((again as { releaseId: string }).releaseId, good.id, "it still runs");
  });
});

test("a slow start with nothing to fall back to is not set aside: it is late (told as Urgent, left running) and its confirmation still makes it good and closes the notice; if it ends unconfirmed the launcher blocks with one notice (K02e/K02f)", async () => {
  await world(async (w) => {
    // The first release ever (a long first migration, say): quarantining it would leave the installation blocked for good.
    const only = await w.announce("only");
    await w.run(only);
    w.clock.advance(DEFAULT_STARTUP_WINDOW_SECONDS);
    const r = await w.launcher.watchdog();
    assert.equal(r.action, "late", JSON.stringify(r));
    assert.match((r as { reason: string }).reason, /no last known good/);
    assert.deepEqual(w.state().failed, [], "not quarantined");
    assert.deepEqual(notices(w.state()).map((n) => [n.kind, n.release, n.fallback]), [["failed_start", only.id, false]]);
    assert.equal((await w.launcher.watchdog()).action, "none", "judged once");
    // It comes up after all: it is the last known good, and the Urgent notice about it is over.
    assert.equal(await w.launcher.confirm(only.id), true);
    assert.equal(w.state().known.id, only.id);
    assert.deepEqual(notices(w.state()).map((n) => n.closedBy), ["confirmed"]);

    // A release whose start ends without a confirmation and with nothing to fall back to: blocked, one notice however often the launcher is started.
    const next = await w.announce("next"); await w.run(next);
    rmSync(join(w.root, "releases", only.id, "nn.js"));
    w.clock.advance(DEFAULT_STARTUP_WINDOW_SECONDS);
    const r2 = await w.launcher.watchdog();
    assert.equal(r2.action, "late", "the last known good no longer verifies, so there is nowhere to fall back to");
    assert.match((r2 as { reason: string }).reason, /no longer verifies/);
    assert.deepEqual(w.state().failed, []);
    const d = await w.launcher.prepare();
    assert.equal(d.action, "blocked");
    const open = notices(w.state()).filter((n) => n.closedAt === undefined);
    assert.deepEqual(open.map((n) => [n.kind, n.release, n.fallback]), [["failed_start", next.id, false]]);
    await w.launcher.prepare(); await w.launcher.prepare();
    assert.equal(notices(w.state()).filter((n) => n.closedAt === undefined).length, 1, "one notice, however often the launcher is started again");
  });
});

test("a clock set forward while a release starts does not fail it under watch(); time on the monotonic clock does (K02e)", async () => {
  await world(async (w) => {
    const good = await w.announce("good"); await w.run(good); await w.launcher.confirm(good.id);
    const slow = await w.announce("slow"); await w.run(slow);
    const watching = w.launcher.watch({ pollMs: 5 });
    await new Promise((r) => setTimeout(r, 20));
    // The device syncs its clock: two days forward, while the release is still starting.
    w.clock.jump(2 * 86_400);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(w.state().failed, [], "a jump of the wall clock is not time waited");
    w.clock.advance(DEFAULT_STARTUP_WINDOW_SECONDS - 1);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(w.state().failed, []);
    w.clock.advance(1);
    const r = await watching;
    assert.equal(r.action, "failed");
    assert.deepEqual(w.state().failed.map((f: any) => f.id), [slow.id]);
    // Set back instead: the window is not stretched.
    const third = await w.announce("third"); await w.run(third);
    const watching2 = w.launcher.watch({ pollMs: 5 });
    await new Promise((r) => setTimeout(r, 20));
    w.clock.jump(-86_400);
    w.clock.advance(DEFAULT_STARTUP_WINDOW_SECONDS);
    assert.equal((await watching2).action, "failed");
  });
});

test("a confirmation that arrives after the watchdog set the start aside does not take it out of quarantine; the controller does not record it as good (K02e)", async () => {
  await world(async (w) => {
    const good = await w.announce("good"); await w.run(good); await w.launcher.confirm(good.id);
    const bad = await w.announce("bad"); await w.run(bad);
    w.clock.advance(DEFAULT_STARTUP_WINDOW_SECONDS);
    assert.equal((await w.launcher.watchdog()).action, "failed");
    // The hung controller comes up before the launcher has stopped it.
    assert.equal(await w.launcher.confirm(bad.id), false);
    assert.equal(w.state().known.id, good.id, "the last known good is unchanged");
    assert.deepEqual(w.state().failed.map((f: any) => f.id), [bad.id]);
    const d = await w.launcher.prepare();
    assert.equal((d as { releaseId: string }).releaseId, good.id, "the launcher falls back as decided");
    // The owner may still vouch for it (owner's decision).
    await w.launcher.vouch(bad);
    assert.deepEqual(w.state().failed, []);
  });
});

test("the launcher and the controller are two processes writing one file: a change made between another's read and write is not lost (K02e)", async () => {
  await world(async (w) => {
    const good = await w.announce("good"); await w.run(good); await w.launcher.confirm(good.id);
    const slow = await w.announce("slow"); await w.run(slow);
    w.clock.advance(DEFAULT_STARTUP_WINDOW_SECONDS);
    // The controller's process confirms just as the launcher's watchdog has read the record and is deciding: it lands between the watchdog's read and its write.
    const file = join(w.root, LAUNCHER_FILE);
    let arm = true;
    const sneaky = new Launcher({ root: w.root, switcher: w.sw, workers: { min: 1, max: 1 }, monotonic: w.clock.mono, now: () => {
      if (arm) { arm = false; const s = JSON.parse(readFileSync(file, "utf8")); writeFileSync(file, JSON.stringify({ ...s, attempt: { ...s.attempt, confirmedAt: w.clock.now() }, known: { id: s.attempt.id, digest: s.attempt.digest, confirmedAt: w.clock.now(), protocol: s.attempt.protocol } })); }
      return w.clock.now();
    } });
    const r = await sneaky.watchdog();
    assert.equal(r.action, "none", "the watchdog read again and found the start confirmed");
    assert.equal(w.state().known.id, slow.id, "the confirmation was not overwritten");
    assert.deepEqual(w.state().failed, [], "and the release was not quarantined");

    // The other way: the watchdog's verdict lands between the controller's read of the record and its write (here an announcement, which reads the pointer in between).
    const late = await w.announce("late"); await w.run(late);
    w.clock.advance(DEFAULT_STARTUP_WINDOW_SECONDS);
    const before = readFileSync(file, "utf8");
    assert.equal((await new Launcher({ root: w.root, switcher: w.sw, workers: { min: 1, max: 1 }, now: w.clock.now }).watchdog()).action, "failed");
    const verdict = readFileSync(file, "utf8");
    writeFileSync(file, before);
    let once = true;
    const controllerSide = new Launcher({ root: w.root, now: w.clock.now, switcher: { read: async () => { if (once) { once = false; writeFileSync(file, verdict); } return w.sw.read(); }, write: (id) => w.sw.write(id), clear: () => w.sw.clear() } });
    const next = makeRelease(w.root, "next");
    await controllerSide.expect({ ...next, protocol: { min: 1, max: 1 } });
    assert.equal(once, false, "the verdict did land in between");
    assert.deepEqual(w.state().failed.map((f: any) => f.id), [late.id], "the quarantine written in between was kept");
    assert.equal(w.state().expected.id, next.id, "and the announcement was made");
    assert.equal(notices(w.state()).filter((n) => n.release === late.id).length, 1, "and the watchdog's notice was kept");
  });
});

test("watch() polls until the start is judged, and stops at once when asked (K02e)", async () => {
  await world(async (w) => {
    await w.launcher.setWindow(10);
    const r1 = await w.announce("one");
    await w.run(r1);
    const waiting = w.launcher.watch({ pollMs: 5 });
    setTimeout(() => w.clock.advance(11), 30);
    const done = await waiting;
    assert.equal(done.action, "late", "no last known good yet: late, left running");
    // Nothing open any more: the answer comes at once.
    assert.equal((await w.launcher.watch({ pollMs: 5 })).action, "none");
    // A confirmed start ends the watch with nothing judged.
    const good = await w.announce("good"); await w.run(good); await w.launcher.confirm(good.id);
    assert.equal((await w.launcher.watch({ pollMs: 5 })).action, "none");
    // An abort stops a watch that is still waiting.
    const third = await w.announce("third"); await w.run(third);
    const ac = new AbortController();
    const p = w.launcher.watch({ pollMs: 5000, signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    assert.deepEqual(await p, { action: "none", reason: "stopped" });
  });
});

test("notices are handed over once, a failed send stays pending for the next try, a repeat is deduped, and an acknowledged or confirmed one is closed and settled (K02f)", async () => {
  await world(async (w) => {
    const good = await w.announce("good"); await w.run(good); await w.launcher.confirm(good.id);
    const bad = await w.announce("bad"); await w.run(bad);
    w.clock.advance(DEFAULT_STARTUP_WINDOW_SECONDS);
    await w.launcher.watchdog();
    const calls: string[] = [];
    let up = false;
    const sink = { raise: async (n: LauncherNotice) => { if (!up) throw new Error("the database is down"); calls.push(`raise:${n.kind}`); }, settle: async (n: LauncherNotice) => { calls.push(`settle:${n.kind}`); } };
    assert.deepEqual(await w.launcher.deliver(sink), { raised: 0, settled: 0, failed: 1 });
    assert.deepEqual(notices(w.state()).map((n) => n.sentAt), [undefined], "nothing was lost: it waits");
    up = true;
    assert.deepEqual(await w.launcher.deliver(sink), { raised: 1, settled: 0, failed: 0 });
    assert.deepEqual(await w.launcher.deliver(sink), { raised: 0, settled: 0, failed: 0 }, "told once");
    // The fall-back that follows is news: the failed start was already told, so it is told too.
    await w.launcher.prepare();
    assert.deepEqual(await w.launcher.deliver(sink), { raised: 1, settled: 0, failed: 0 });
    assert.deepEqual(calls, ["raise:failed_start", "raise:fell_back"]);
    // The owner acknowledges: closed, then settled in the sink once.
    assert.equal(await w.launcher.closeNotices(() => true, "acknowledged"), 2);
    assert.equal(await w.launcher.closeNotices(() => true, "acknowledged"), 0, "already closed");
    assert.deepEqual(await w.launcher.deliver(sink), { raised: 0, settled: 2, failed: 0 });
    assert.deepEqual(await w.launcher.deliver(sink), { raised: 0, settled: 0, failed: 0 });
    // The owner acknowledged while a controller ran; a fall-back that happens again afterwards (the pointer moved to the failed release once more) is a new event, and it is told.
    assert.equal(((await w.run(bad)) as { releaseId: string }).releaseId, good.id);
    assert.deepEqual(notices(w.state()).map((n) => [n.kind, n.closedBy ?? "open"]), [["failed_start", "acknowledged"], ["fell_back", "open"]]);
    assert.deepEqual(await w.launcher.deliver(sink), { raised: 1, settled: 0, failed: 0 });
    await w.run(bad);
    assert.equal(notices(w.state()).length, 2, "while it is open, a repeat adds nothing");
  });
});

test("a later start that confirms closes the earlier notices; one that was never told is not told afterwards; a failure of a release that was confirmed since is a new notice (K02f)", async () => {
  await world(async (w) => {
    const good = await w.announce("good"); await w.run(good); await w.launcher.confirm(good.id);
    const bad = await w.announce("bad"); await w.run(bad);
    w.clock.advance(DEFAULT_STARTUP_WINDOW_SECONDS);
    await w.launcher.watchdog();
    const told: string[] = [];
    const sink = { raise: async (n: LauncherNotice) => { told.push(`raise:${n.kind}`); }, settle: async (n: LauncherNotice) => { told.push(`settle:${n.kind}`); } };
    // The fall-back start of the last known good does not count as a confirmation (it was already good).
    assert.equal(await w.launcher.confirm(good.id), false);
    assert.ok(notices(w.state()).every((n) => n.closedAt === undefined));
    await w.launcher.deliver(sink);
    await w.launcher.prepare();
    await w.launcher.deliver(sink);
    // The next release starts and reports healthy: the problem is over.
    const next = await w.announce("next"); await w.run(next);
    assert.equal(await w.launcher.confirm(next.id), true);
    assert.ok(notices(w.state()).every((n) => n.closedBy === "confirmed"));
    assert.deepEqual(await w.launcher.deliver(sink), { raised: 0, settled: 2, failed: 0 });
    // A notice that was never sent is closed by the confirmation without being told at all.
    const bad2 = await w.announce("bad2"); await w.run(bad2);
    w.clock.advance(DEFAULT_STARTUP_WINDOW_SECONDS); await w.launcher.watchdog(); await w.launcher.prepare();
    const calls = told.length;
    const next2 = await w.announce("next2"); await w.run(next2); await w.launcher.confirm(next2.id);
    assert.deepEqual(await w.launcher.deliver(sink), { raised: 0, settled: 0, failed: 0 });
    assert.equal(told.length, calls, "nothing stale is told");
  });
});

test("the notice list is bounded: finished notices make room first, then told ones, then the oldest; never the new one (K02f)", async () => {
  await world(async (w) => {
    const good = await w.announce("good"); await w.run(good); await w.launcher.confirm(good.id);
    for (let i = 0; i < LAUNCHER_LIMITS.notices + 6; i++) {
      const bad = await w.announce(`bad${i}`); await w.run(bad);
      w.clock.advance(DEFAULT_STARTUP_WINDOW_SECONDS); await w.launcher.watchdog();
      assert.ok(notices(w.state()).length <= LAUNCHER_LIMITS.notices);
    }
    assert.equal(notices(w.state()).length, LAUNCHER_LIMITS.notices);
    assert.equal(w.state().failed.length, LAUNCHER_LIMITS.notices + 6);
    // Full of open notices: one never told (its send keeps failing) and the rest told. A new one makes room by dropping a told one (it is in the owner's inbox), never the untold one, never itself.
    const oldest = notices(w.state())[0]!.release;
    await w.launcher.deliver({ raise: async (n) => { if (n.release === oldest) throw new Error("down"); }, settle: async () => undefined });
    const secondOldest = notices(w.state())[1]!.release;
    const last = await w.announce("last"); await w.run(last);
    w.clock.advance(DEFAULT_STARTUP_WINDOW_SECONDS); await w.launcher.watchdog();
    const after = notices(w.state());
    assert.equal(after.length, LAUNCHER_LIMITS.notices);
    assert.ok(after.some((n) => n.release === oldest), "the notice nobody was told yet is kept");
    assert.ok(!after.some((n) => n.release === secondOldest), "the oldest told one made room");
    assert.equal(after.at(-1)!.release, last.id, "the newest is kept");
    assert.deepEqual(readdirSync(w.root).filter((f) => f.includes("tmp")), [], "no temporary file is left behind");
  });
});

test("on Windows a write of the launcher's file outlasts a reader that has it open (the rename is retried on EPERM, EACCES, EBUSY); elsewhere, and for any other error, a failed rename fails at once (CI platform repair)", async () => {
  const busy = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });
  const script = (codes: string[]) => { const calls: string[] = []; const waits: number[] = []; return { calls, waits, rename: async (from: string, to: string) => { calls.push(`${from}>${to}`); const c = codes.shift(); if (c !== undefined) throw busy(c); }, pause: async (ms: number) => { waits.push(ms); } }; };
  // Windows: a reader holding the file for a moment costs a few retries, not the write.
  const w = script(["EPERM", "EACCES", "EBUSY"]);
  await renameReplacing("t", "f", { platform: "win32", rename: w.rename, pause: w.pause });
  assert.equal(w.calls.length, 4);
  assert.deepEqual(w.waits, [10, 20, 30]);
  // Bounded: a file that stays held fails after ten tries (about half a second), with the last error.
  const held = script(Array(20).fill("EPERM"));
  await assert.rejects(renameReplacing("t", "f", { platform: "win32", rename: held.rename, pause: held.pause }), (e: NodeJS.ErrnoException) => e.code === "EPERM");
  assert.equal(held.calls.length, 10);
  assert.equal(held.waits.reduce((a, b) => a + b, 0), 450);
  // Any other error is not a reader's hold: it fails at once, on Windows too.
  const gone = script(["ENOENT"]);
  await assert.rejects(renameReplacing("t", "f", { platform: "win32", rename: gone.rename, pause: gone.pause }), (e: NodeJS.ErrnoException) => e.code === "ENOENT");
  assert.equal(gone.calls.length, 1);
  // Elsewhere a rename never fails because a reader has the file open: no retry at all.
  for (const platform of ["linux", "darwin"] as const) {
    const p = script(["EPERM"]);
    await assert.rejects(renameReplacing("t", "f", { platform, rename: p.rename, pause: p.pause }), (e: NodeJS.ErrnoException) => e.code === "EPERM");
    assert.equal(p.calls.length, 1, platform);
    assert.deepEqual(p.waits, []);
  }
  // The real rename on this host, through the launcher's own writes.
  const root = mkdtempSync(join(tmpdir(), "nn-k02-rename-"));
  try {
    await renameReplacing(join(root, "missing"), join(root, "x")).then(() => assert.fail("a missing file cannot be renamed"), (e: NodeJS.ErrnoException) => assert.equal(e.code, "ENOENT"));
    writeFileSync(join(root, "a"), "new");
    writeFileSync(join(root, "b"), "old");
    await renameReplacing(join(root, "a"), join(root, "b"));
    assert.equal(readFileSync(join(root, "b"), "utf8"), "new");
    assert.deepEqual(readdirSync(root), ["b"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
