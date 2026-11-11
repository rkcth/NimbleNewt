import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_STARTUP_WINDOW_SECONDS, LAUNCHER_FILE, LAUNCHER_LIMITS, Launcher, LauncherStateError, type LauncherNotice } from "./index.js";
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
    const launcher = new Launcher({ root, switcher: sw, now: clock.now, workers: { min: 1, max: 1 } });
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
    const first = await w.announce("one");
    await w.run(first);
    w.clock.advance(29);
    assert.equal((await w.launcher.watchdog()).action, "waiting");
    w.clock.advance(1);
    assert.equal((await w.launcher.watchdog()).action, "failed", "30 seconds is the window");
    await w.launcher.setWindow(null);
    assert.equal(w.state().window, undefined, "null puts the default back");
    // A damaged window in the file is a damaged launcher record: the launcher will not guess.
    const s = w.state(); writeFileSync(join(w.root, LAUNCHER_FILE), JSON.stringify({ ...s, window: 3 }));
    assert.equal((await w.launcher.prepare()).action, "blocked");
    assert.match((await w.launcher.watchdog() as { reason: string }).reason, /not a launcher record/);
    writeFileSync(join(w.root, LAUNCHER_FILE), JSON.stringify({ ...s, notices: [{ kind: "nope" }] }));
    assert.equal((await w.launcher.prepare()).action, "blocked");
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

test("a start the watchdog finds failed with no last known good leaves nothing to fall back to: the launcher blocks, and the notice says nothing else is known to work (K02e/K02f)", async () => {
  await world(async (w) => {
    const only = await w.announce("only");
    await w.run(only);
    w.clock.advance(DEFAULT_STARTUP_WINDOW_SECONDS);
    const r = await w.launcher.watchdog();
    assert.equal(r.action, "failed");
    assert.equal((r as { fallback: boolean }).fallback, false);
    const d = await w.launcher.prepare();
    assert.equal(d.action, "blocked");
    assert.deepEqual(notices(w.state()).map((n) => [n.kind, n.release, n.fallback]), [["failed_start", only.id, false]], "one notice, however often the launcher is started again");
    await w.launcher.prepare(); await w.launcher.prepare();
    assert.equal(notices(w.state()).length, 1);
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
    assert.equal(done.action, "failed");
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
    // An acknowledged notice still stops the same finding from being told again at the next launch.
    await w.run(bad);
    assert.equal(notices(w.state()).length, 2);
    assert.ok(notices(w.state()).every((n) => n.closedBy === "acknowledged"));
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

test("the notice list is bounded: finished notices make room first, then the oldest (K02f)", async () => {
  await world(async (w) => {
    const good = await w.announce("good"); await w.run(good); await w.launcher.confirm(good.id);
    for (let i = 0; i < LAUNCHER_LIMITS.notices + 6; i++) {
      const bad = await w.announce(`bad${i}`); await w.run(bad);
      w.clock.advance(DEFAULT_STARTUP_WINDOW_SECONDS); await w.launcher.watchdog();
      assert.ok(notices(w.state()).length <= LAUNCHER_LIMITS.notices);
    }
    assert.equal(notices(w.state()).length, LAUNCHER_LIMITS.notices);
    assert.equal(w.state().failed.length, LAUNCHER_LIMITS.notices + 6);
    assert.deepEqual(readdirSync(w.root).filter((f) => f.includes("tmp")), [], "no temporary file is left behind");
  });
});
